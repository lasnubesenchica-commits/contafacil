// ════════════════════════════════════════════════════════════════════
//  BalanceClip Router — WhatsApp multi-tenant
//
//  Proyecto Apps Script independiente que recibe webhooks de Meta
//  (un solo número WhatsApp Business compartido entre todos los
//  clientes) y reenvía cada mensaje al GAS del cliente correspondiente
//  según el número del remitente.
//
//  Setup
//  ─────
//    1. Crear un Apps Script project nuevo, copiar este archivo entero.
//    2. Deploy → Web App → Execute as: Me — Who has access: Anyone.
//    3. Script Properties:
//         META_WHATSAPP_TOKEN  — token permanente Meta (mismo de Iris)
//         META_PHONE_ID        — phone_number_id (1035238479681939)
//         META_VERIFY_TOKEN    — string que coincide con el webhook Meta
//         CLIENTS_MAP_JSON     — JSON: { "<tel sin +>": "<deployment_url>" }
//         EMAIL_WATCHER_TOKEN  — shared secret que comparte con el script
//                                bound a facturas@balanceclip.net
//         CONTACT_EMAIL/WEBSITE/WHATSAPP — opcionales (mensaje a desconocidos)
//    4. Apuntar el Webhook Callback URL de Meta a este deployment URL.
//    5. Probar con routerTestConfig() desde el editor.
//
//  Endpoints expuestos en doPost
//  ─────────────────────────────
//    • Webhook Meta (object=whatsapp_business_account) — entrada normal
//    • { action: 'verifyEmailCode', token, email, code, autoConfirmed? }
//      — usado por email-watcher/Watcher.gs para entregarle al cliente
//      el código de confirmación de Gmail vía WhatsApp.
//
//  Formato CLIENTS_MAP_JSON
//  ────────────────────────
//    {
//      "50760188276": "https://script.google.com/macros/s/<irisDeploy>/exec",
//      "50769876543": "https://script.google.com/macros/s/<davidDeploy>/exec",
//      "50760123456": "https://script.google.com/macros/s/<gloriDeploy>/exec"
//    }
//
//  Key = número del remitente como lo entrega Meta (sin +, código país
//  incluido — Panamá = 507XXXXXXXX).
//  Value = deployment URL del GAS de ese cliente (el de clients.json).
//
//  El router NO procesa el mensaje — solo enruta. Cada GAS cliente
//  hace la descarga de media, la IA, el guardado y la respuesta al
//  usuario. El router es un proxy delgado para mantener aislamiento.
// ════════════════════════════════════════════════════════════════════

var META_GRAPH_VERSION = 'v19.0';
var META_GRAPH_BASE    = 'https://graph.facebook.com/' + META_GRAPH_VERSION;

// ────────────────────────────────────────────────────────────────────
//  doGet — verificación Meta (hub.challenge)
// ────────────────────────────────────────────────────────────────────
function doGet(e) {
  var params    = e ? (e.parameter || {}) : {};
  var mode      = params['hub.mode']         || params.hub_mode;
  var token     = params['hub.verify_token'] || params.hub_verify_token;
  var challenge = params['hub.challenge']    || params.hub_challenge;

  if (mode !== 'subscribe' || !challenge) {
    // Health check / acceso no-Meta
    return ContentService.createTextOutput('BalanceClip Router OK').setMimeType(ContentService.MimeType.TEXT);
  }
  var expected = PropertiesService.getScriptProperties().getProperty('META_VERIFY_TOKEN') || '';
  if (token !== expected) {
    Logger.log('Router verify FAIL — token recibido vs esperado no coincide');
    return ContentService.createTextOutput('Forbidden').setMimeType(ContentService.MimeType.TEXT);
  }
  Logger.log('Router verify OK — devolviendo challenge');
  return ContentService.createTextOutput(String(challenge)).setMimeType(ContentService.MimeType.TEXT);
}

// ────────────────────────────────────────────────────────────────────
//  doPost — recibe webhook Meta y enruta
// ────────────────────────────────────────────────────────────────────
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    // Webhook de Meta (mensajes entrantes de WhatsApp)
    if (data && data.object === 'whatsapp_business_account') {
      return _routerHandleWebhook(data);
    }
    // Endpoint interno: watcher de facturas@balanceclip.net reportando
    // un código de verificación de reenvío de Gmail.
    if (data && data.action === 'verifyEmailCode') {
      return _routerHandleVerifyCode(data);
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'not whatsapp webhook' }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    Logger.log('Router doPost ERROR: ' + err.message);
    // Siempre 200 para que Meta no reintente
    return ContentService.createTextOutput(JSON.stringify({ ok: true, _err: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function _routerHandleWebhook(data) {
  try {
    var entries = data.entry || [];
    for (var e = 0; e < entries.length; e++) {
      var changes = entries[e].changes || [];
      for (var c = 0; c < changes.length; c++) {
        var value = changes[c].value || {};
        var msgs  = value.messages || [];
        for (var m = 0; m < msgs.length; m++) {
          try { _routerForwardMensaje(msgs[m], value.metadata || {}); }
          catch(err) { Logger.log('Router forwardMensaje ERROR: ' + err.message); }
        }
      }
    }
  } catch(err) {
    Logger.log('Router handleWebhook ERROR: ' + err.message);
  }
  return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
}

// ────────────────────────────────────────────────────────────────────
//  Enrutar un mensaje al GAS cliente correspondiente
// ────────────────────────────────────────────────────────────────────
function _routerForwardMensaje(msg, metadata) {
  var from = msg.from || '';
  if (!from) { Logger.log('Mensaje sin from, ignorando'); return; }

  var props   = PropertiesService.getScriptProperties();
  var token   = props.getProperty('META_WHATSAPP_TOKEN');
  var phoneId = props.getProperty('META_PHONE_ID') || (metadata.phone_number_id || '');

  var map = _routerGetClientsMap();
  var clientUrl = map[from];

  // ── Número desconocido → mensaje de marketing/contacto ──
  if (!clientUrl) {
    Logger.log('Numero no reconocido: ' + from);
    _routerReplyDesconocido(from, token, phoneId);
    return;
  }

  // ── Interceptar respuestas interactivas del flujo de setup de email ──
  // (las del flujo de aprobar/cambiar categoría se forwardean al cliente GAS).
  if (msg.type === 'interactive') {
    var iaReply = msg.interactive || {};
    var btnId = (iaReply.list_reply   && iaReply.list_reply.id)   ||
                (iaReply.button_reply && iaReply.button_reply.id) || '';
    if (btnId.indexOf('setup:') === 0) {
      _routerHandleSetupReply(from, btnId, token, phoneId);
      return;
    }
  }

  // ── Mensaje de texto: el router responde directo (bienvenida/ayuda/setup) ──
  // No lo forwardeamos al cliente — el cliente GAS no procesa texto, solo
  // media e interactivos de facturas.
  if (msg.type === 'text') {
    var bodyText = (msg.text && msg.text.body) ? String(msg.text.body).toLowerCase().trim() : '';
    var setupState = _routerGetSetupState(from);

    // Escape hatch durante setup
    if (setupState && /^(cancelar|salir|exit|cancel)$/.test(bodyText)) {
      _routerClearSetupState(from);
      _routerSendText(from, '👍 Configuración cancelada.', token, phoneId);
      return;
    }

    // En estado awaiting_email — esperamos que el usuario mande su email
    if (setupState && setupState.step === 'awaiting_email') {
      var emailParsed = _routerParseEmail(bodyText);
      if (!emailParsed) {
        _routerSendText(from,
          '⚠️ No reconozco eso como un email válido. Mandame tu dirección completa.\n' +
          'Ejemplo: tunombre@' + (setupState.provider === 'gmail' ? 'gmail.com' : 'outlook.com') + '\n\n' +
          'O escribí *cancelar* para salir.',
          token, phoneId);
        return;
      }
      _routerCompletarSetup(from, emailParsed, setupState.provider, token, phoneId);
      return;
    }

    // En estado awaiting_provider — aceptamos texto "gmail" / "outlook"
    if (setupState && setupState.step === 'awaiting_provider') {
      if (bodyText.indexOf('gmail') !== -1)   { _routerPedirEmail(from, 'gmail',   token, phoneId); return; }
      if (bodyText.indexOf('outlook') !== -1 || bodyText.indexOf('hotmail') !== -1) {
        _routerPedirEmail(from, 'outlook', token, phoneId); return;
      }
      // si no responde gmail/outlook, mostrar la lista de nuevo abajo
    }

    // Triggers de setup de reenvío de email
    var setupTriggers = [
      'configurar email','configurar correo','configurar reenvio','configurar reenvío',
      'reenvio','reenvío','reenviar','forward','setup','email','correo','setup email'
    ];
    if (setupTriggers.indexOf(bodyText) !== -1) {
      _routerIniciarSetup(from, token, phoneId);
      return;
    }

    var triggers = ['hola','help','ayuda','menu','menú','instrucciones','info','start','inicio'];
    var pidióAyuda = triggers.indexOf(bodyText) !== -1;
    var primera   = !_routerYaSaludado(from);
    if (primera || pidióAyuda) {
      _routerEnviarBienvenida(from, token, phoneId);
      _routerMarcarSaludado(from);
    } else {
      _routerReplyAyudaBreve(from, token, phoneId);
    }
    return;
  }

  // ── Media (image/document) e interactivos → forward al cliente GAS ──
  // Si es la PRIMERA vez del cliente, mandamos la bienvenida primero,
  // y después el cliente GAS procesa el archivo y responde con sus botones.
  if (!_routerYaSaludado(from)) {
    _routerEnviarBienvenida(from, token, phoneId);
    _routerMarcarSaludado(from);
  }

  Logger.log('Forward from=' + from + ' → ' + clientUrl);

  var payload = {
    action:   'procesarWhatsAppForward',
    msg:      msg,
    metadata: metadata,
  };

  try {
    var resp = UrlFetchApp.fetch(clientUrl, {
      method:             'post',
      contentType:        'application/json',
      payload:            JSON.stringify(payload),
      muteHttpExceptions: true,
      followRedirects:    true,   // GAS web app responde con redirect
    });
    Logger.log('Client GAS responded ' + resp.getResponseCode() + ': ' + resp.getContentText().substring(0, 200));
  } catch (err) {
    Logger.log('Error forwarding to client: ' + err.message);
  }
}

// ────────────────────────────────────────────────────────────────────
//  Tracking de saludo — quién ya fue bienvenido
// ────────────────────────────────────────────────────────────────────
function _routerYaSaludado(from) {
  return PropertiesService.getScriptProperties().getProperty('welcomed_' + from) === '1';
}
function _routerMarcarSaludado(from) {
  PropertiesService.getScriptProperties().setProperty('welcomed_' + from, '1');
}

// ────────────────────────────────────────────────────────────────────
//  Mensaje detallado de bienvenida (clientes conocidos)
// ────────────────────────────────────────────────────────────────────
function _routerEnviarBienvenida(to, token, phoneId) {
  if (!token || !phoneId) { Logger.log('No puedo enviar bienvenida — faltan token/phoneId'); return; }
  var body =
    '🤖 *¡Hola! Soy el asistente fiscal de BalanceClip*\n\n' +
    'Te ayudo a registrar tus *gastos* sin que tengas que abrir la app.\n\n' +
    '📸 *Cómo funciona*\n' +
    '1. Mándame una foto o PDF de tu factura/recibo de gasto\n' +
    '2. Una IA lee el documento y extrae monto, fecha, proveedor y RUC\n' +
    '3. Sugiere la categoría DGI Panamá apropiada\n' +
    '4. Te respondo con 2 botones:\n' +
    '   ✅ *Aprobar* (acepta lo sugerido)\n' +
    '   📝 *Cambiar categoría* (lista de opciones)\n' +
    '5. El gasto queda registrado en tu sistema\n\n' +
    '✨ *Detecto automáticamente*\n' +
    '• Monto, ITBMS y total\n' +
    '• Proveedor y su RUC\n' +
    '• Si es deducible (RUC del negocio como receptor)\n' +
    '• Categoría DGI sugerida\n\n' +
    '💡 *Tips*\n' +
    '• Funciona con: facturas fiscales y electrónicas, recibos Yappy, transferencias, PDFs\n' +
    '• Para revisar, modificar o aprobar manualmente, abrí tu panel en balanceclip.net\n\n' +
    '📋 *Comandos*\n' +
    '• *ayuda* — ver estas instrucciones de nuevo\n' +
    '• *configurar email* — configurar reenvío automático de facturas desde tu Gmail/Outlook a *facturas@balanceclip.net* (así no tenés que mandar manualmente las que te llegan por email)\n\n' +
    '¿Listo? Mándame tu primera factura 📤';
  _routerSendText(to, body, token, phoneId);
}

// ────────────────────────────────────────────────────────────────────
//  Ayuda breve (texto no reconocido de cliente ya saludado)
// ────────────────────────────────────────────────────────────────────
function _routerReplyAyudaBreve(to, token, phoneId) {
  if (!token || !phoneId) return;
  var body =
    '🤖 No entendí el mensaje. Lo que puedo hacer:\n\n' +
    '📸 Mandame una *foto o PDF de tu factura* y la registro.\n' +
    '📋 Escribime *ayuda* para ver las instrucciones completas.';
  _routerSendText(to, body, token, phoneId);
}

// ────────────────────────────────────────────────────────────────────
//  Wrapper de envío de texto plano (DRY para el router)
// ────────────────────────────────────────────────────────────────────
function _routerSendText(to, body, token, phoneId) {
  try {
    UrlFetchApp.fetch(META_GRAPH_BASE + '/' + phoneId + '/messages', {
      method:      'post',
      contentType: 'application/json',
      headers:     { 'Authorization': 'Bearer ' + token },
      payload:     JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        text: { body: String(body || '').substring(0, 4096) },
      }),
      muteHttpExceptions: true,
    });
  } catch(err) { Logger.log('_routerSendText ERROR: ' + err.message); }
}

function _routerGetClientsMap() {
  var json = PropertiesService.getScriptProperties().getProperty('CLIENTS_MAP_JSON') || '{}';
  try { return JSON.parse(json); }
  catch(err) { Logger.log('CLIENTS_MAP_JSON inválido: ' + err.message); return {}; }
}

// ────────────────────────────────────────────────────────────────────
//  Responder a número no registrado en el mapa (marketing/contacto)
// ────────────────────────────────────────────────────────────────────
function _routerReplyDesconocido(to, token, phoneId) {
  if (!token || !phoneId) {
    Logger.log('Faltan META_WHATSAPP_TOKEN o META_PHONE_ID — no puedo responder a número desconocido');
    return;
  }
  var props   = PropertiesService.getScriptProperties();
  var email   = props.getProperty('CONTACT_EMAIL')    || 'ventas@balanceclip.net';
  var web     = props.getProperty('CONTACT_WEBSITE')  || 'https://balanceclip.net';
  var waNum   = props.getProperty('CONTACT_WHATSAPP') || '+507 6981-2266';
  var body =
    '👋 ¡Hola!\n\n' +
    'Tu número no está suscrito a *BalanceClip* — el asistente fiscal automatizado para profesionales y negocios en Panamá. 🇵🇦\n\n' +
    'Si querés conocer más sobre el servicio o suscribirte, contactanos:\n\n' +
    '📧 ' + email + '\n' +
    '🌐 ' + web + '\n' +
    '💬 WhatsApp: ' + waNum + '\n\n' +
    'Te ayudamos a digitalizar la captura de facturas, automatizar tu contabilidad y mantener tus reportes DGI listos. 🤖✨';
  _routerSendText(to, body, token, phoneId);
}

// ════════════════════════════════════════════════════════════════════
//  FLUJO DE CONFIGURACIÓN DE REENVÍO DE EMAIL
//  ──────────────────────────────────────────
//  Triggers: usuario escribe "configurar email" / "email" / etc.
//  Estado por usuario en Script Properties: setup_<phone> = JSON
//    { step: 'awaiting_provider' | 'awaiting_email', provider?, ts }
//  TTL: 60 min (se descarta automáticamente).
//
//  Cuando completa, guarda en Properties:
//    email_<email_lowercase> = <phone>
//  El watcher de facturas@ usa ese mapping para saber a quién mandarle
//  el código de verificación de Gmail.
// ════════════════════════════════════════════════════════════════════

var _ROUTER_SETUP_TTL_MS = 60 * 60 * 1000; // 1h

function _routerGetSetupState(from) {
  var raw = PropertiesService.getScriptProperties().getProperty('setup_' + from);
  if (!raw) return null;
  try {
    var s = JSON.parse(raw);
    if (!s.ts || (Date.now() - s.ts) > _ROUTER_SETUP_TTL_MS) {
      _routerClearSetupState(from);
      return null;
    }
    return s;
  } catch(err) { _routerClearSetupState(from); return null; }
}
function _routerSetSetupState(from, state) {
  state.ts = Date.now();
  PropertiesService.getScriptProperties().setProperty('setup_' + from, JSON.stringify(state));
}
function _routerClearSetupState(from) {
  PropertiesService.getScriptProperties().deleteProperty('setup_' + from);
}

function _routerParseEmail(text) {
  var m = String(text || '').match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i);
  return m ? m[0].toLowerCase() : null;
}

function _routerIniciarSetup(from, token, phoneId) {
  _routerSetSetupState(from, { step: 'awaiting_provider' });
  _routerSendListProveedores(from, token, phoneId);
}

function _routerSendListProveedores(to, token, phoneId) {
  try {
    UrlFetchApp.fetch(META_GRAPH_BASE + '/' + phoneId + '/messages', {
      method:      'post',
      contentType: 'application/json',
      headers:     { 'Authorization': 'Bearer ' + token },
      payload:     JSON.stringify({
        messaging_product: 'whatsapp',
        to:   to,
        type: 'interactive',
        interactive: {
          type: 'list',
          header: { type: 'text', text: '📧 Configurar reenvío' },
          body:   { text:
            'Te ayudo a configurar tu email para que reenvíe ' +
            'automáticamente las facturas que te lleguen a ' +
            '*facturas@balanceclip.net* — así no tenés que mandarlas ' +
            'manualmente por WhatsApp.\n\n' +
            '¿Qué proveedor de email usás?'
          },
          footer: { text: 'Escribí "cancelar" para salir' },
          action: {
            button:   'Elegir proveedor',
            sections: [{
              title: 'Proveedores',
              rows: [
                { id: 'setup:gmail',   title: 'Gmail',             description: 'Cuenta @gmail.com' },
                { id: 'setup:outlook', title: 'Outlook / Hotmail', description: '@outlook.com, @hotmail.com, @live.com' },
              ],
            }],
          },
        },
      }),
      muteHttpExceptions: true,
    });
  } catch(err) { Logger.log('_routerSendListProveedores ERROR: ' + err.message); }
}

function _routerHandleSetupReply(from, btnId, token, phoneId) {
  var provider = btnId.replace('setup:', '');
  if (provider !== 'gmail' && provider !== 'outlook') return;
  _routerPedirEmail(from, provider, token, phoneId);
}

function _routerPedirEmail(from, provider, token, phoneId) {
  _routerSetSetupState(from, { step: 'awaiting_email', provider: provider });
  var ejemplo = provider === 'gmail' ? 'tunombre@gmail.com' : 'tunombre@outlook.com';
  var nombre  = provider === 'gmail' ? 'Gmail'             : 'Outlook';
  _routerSendText(from,
    '📧 Perfecto, *' + nombre + '*.\n\n' +
    '*Mandame tu dirección de email completa* (la cuenta de la que vas a reenviar las facturas).\n\n' +
    'Ejemplo: ' + ejemplo + '\n\n' +
    'Escribí *cancelar* si querés salir.',
    token, phoneId);
}

function _routerCompletarSetup(from, email, provider, token, phoneId) {
  // Guardar mapping email→phone para que el watcher pueda devolver el código.
  PropertiesService.getScriptProperties().setProperty('email_' + email, from);
  _routerClearSetupState(from);

  if (provider === 'gmail') {
    _routerEnviarInstruccionesGmail(from, email, token, phoneId);
  } else {
    _routerEnviarInstruccionesOutlook(from, email, token, phoneId);
  }
}

function _routerEnviarInstruccionesGmail(from, email, token, phoneId) {
  var body =
    '✅ Anotado: *' + email + '*\n\n' +
    '*📋 Configuración de Gmail*\n' +
    '_(Hacelo desde la computadora — no funciona desde el celular)_\n\n' +
    '*1.* Abrí mail.google.com con tu cuenta *' + email + '*\n' +
    '*2.* Engranaje ⚙️ (arriba a la derecha) → *Ver todos los ajustes*\n' +
    '*3.* Tab *"Reenvío y POP/IMAP"*\n' +
    '*4.* Botón *"Añadir una dirección de reenvío"*\n' +
    '*5.* Ingresá: facturas@balanceclip.net → *Siguiente* → *Continuar*\n\n' +
    '🔢 *Código de verificación*\n' +
    'Google te va a pedir un código numérico. *Te lo mando acá automáticamente* en cuanto llegue a nuestro buzón (1-2 min). Esperá el código antes de cerrar la ventana de Gmail.\n\n' +
    '⚠️ *Después de verificar* (último paso, MUY importante):\n' +
    'Volvé a la misma sección y marcá:\n' +
    '✅ "Reenviar una copia del correo entrante a facturas@balanceclip.net"\n' +
    '✅ "Conservar la copia de Gmail en Recibidos"\n' +
    '✅ *Guardar cambios* abajo\n\n' +
    '💡 *Opcional — reenviar solo facturas*\n' +
    'Si no querés reenviar TODO tu correo, creá un filtro:\n' +
    '1. Configuración → *Filtros y direcciones bloqueadas* → *Crear filtro nuevo*\n' +
    '2. "Contiene las palabras": *factura OR invoice OR recibo OR comprobante*\n' +
    '3. *Crear filtro* → marcá *"Reenviarlo a"* facturas@balanceclip.net\n\n' +
    '⏳ Esperando el código de Google…';
  _routerSendText(from, body, token, phoneId);
}

function _routerEnviarInstruccionesOutlook(from, email, token, phoneId) {
  var body =
    '✅ Anotado: *' + email + '*\n\n' +
    '*📋 Configuración de Outlook* (regla de reenvío)\n' +
    '_(Hacelo desde la computadora)_\n\n' +
    '*1.* Abrí outlook.live.com con tu cuenta *' + email + '*\n' +
    '*2.* Engranaje ⚙️ (arriba a la derecha) → *Ver toda la configuración de Outlook*\n' +
    '*3.* *Correo* → *Reglas* → *+ Agregar nueva regla*\n' +
    '*4.* Nombre: BalanceClip facturas\n' +
    '*5.* En "Agregar una condición" → *Asunto incluye* → escribí: factura, invoice, recibo, comprobante (uno por uno)\n' +
    '*6.* En "Agregar una acción" → *Reenviar a* → facturas@balanceclip.net\n' +
    '*7.* *Guardar*\n\n' +
    '✅ ¡Listo! Outlook personal *no pide código de verificación*. A partir de ahora cualquier correo que reciban con esas palabras en el asunto se reenvía automáticamente.\n\n' +
    '⚠️ *Atención si es Outlook corporativo*\n' +
    'Si tu email es de *Microsoft 365 del trabajo*, el reenvío externo puede estar *bloqueado* por tu admin de IT. Síntomas: la regla se guarda pero no llega nada. Pedile a tu admin que habilite "External Forwarding" para tu cuenta, o usá una cuenta personal alternativa.';
  _routerSendText(from, body, token, phoneId);
}

// ────────────────────────────────────────────────────────────────────
//  Endpoint: recibe del watcher de facturas@ un código de Gmail
//  Espera POST con: { action, token, email, code, autoConfirmed? }
//  Verifica el shared secret EMAIL_WATCHER_TOKEN.
// ────────────────────────────────────────────────────────────────────
function _routerHandleVerifyCode(data) {
  var props = PropertiesService.getScriptProperties();
  var expectedToken = props.getProperty('EMAIL_WATCHER_TOKEN') || '';
  if (!expectedToken || data.token !== expectedToken) {
    Logger.log('verifyEmailCode: token shared-secret inválido');
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'forbidden' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var email = String(data.email || '').toLowerCase().trim();
  var code  = String(data.code  || '').trim();
  var autoConfirmed = !!data.autoConfirmed;
  if (!email || !code) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'missing email/code' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var phone = props.getProperty('email_' + email);
  if (!phone) {
    Logger.log('verifyEmailCode: no hay mapping para ' + email + ' — el usuario nunca corrió "configurar email"');
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'unknown email' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var metaToken = props.getProperty('META_WHATSAPP_TOKEN');
  var phoneId   = props.getProperty('META_PHONE_ID');

  var body;
  if (autoConfirmed) {
    body =
      '✅ *¡Verificado automáticamente!*\n\n' +
      'Confirmé el reenvío de *' + email + '* sin que tengas que hacer nada.\n\n' +
      '*Paso final* (importante):\n' +
      'En Gmail → Configuración → *Reenvío y POP/IMAP*, marcá:\n' +
      '✅ "Reenviar una copia del correo entrante a facturas@balanceclip.net"\n' +
      '✅ Guardar cambios\n\n' +
      'A partir de ese momento las facturas que te lleguen por email se procesan automáticamente. 🎉';
  } else {
    body =
      '🔢 *Código de verificación de Gmail*\n\n' +
      '`' + code + '`\n\n' +
      '👉 Pegalo en Gmail → Configuración → *Reenvío y POP/IMAP* → casilla del código → *Verificar*.\n\n' +
      'Después acordate de marcar *"Reenviar una copia…"* y *Guardar cambios*.';
  }
  _routerSendText(phone, body, metaToken, phoneId);
  Logger.log('verifyEmailCode: enviado a ' + phone + ' (email=' + email + ', autoConfirmed=' + autoConfirmed + ')');

  return ContentService.createTextOutput(JSON.stringify({ ok: true, sent_to: phone }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ════════════════════════════════════════════════════════════════════
//  Diagnóstico — ejecutar desde el editor para validar config
// ════════════════════════════════════════════════════════════════════
function routerTestConfig() {
  var props   = PropertiesService.getScriptProperties();
  var token   = props.getProperty('META_WHATSAPP_TOKEN');
  var phoneId = props.getProperty('META_PHONE_ID');
  var verify  = props.getProperty('META_VERIFY_TOKEN');
  var mapJson = props.getProperty('CLIENTS_MAP_JSON') || '{}';

  Logger.log('META_WHATSAPP_TOKEN: ' + (token   ? '✅ set ('+token.substring(0,20)+'…)' : '❌ MISSING'));
  Logger.log('META_PHONE_ID:       ' + (phoneId ? '✅ ' + phoneId : '❌ MISSING'));
  Logger.log('META_VERIFY_TOKEN:   ' + (verify  ? '✅ set' : '❌ MISSING'));

  var map;
  try { map = JSON.parse(mapJson); }
  catch(err) { Logger.log('CLIENTS_MAP_JSON: ❌ JSON inválido: ' + err.message); return; }
  var keys = Object.keys(map);
  Logger.log('CLIENTS_MAP_JSON: ' + (keys.length ? '✅ ' + keys.length + ' cliente(s) mapeado(s)' : '⚠️ vacío'));
  for (var k = 0; k < keys.length; k++) {
    Logger.log('  ' + keys[k] + ' → ' + map[keys[k]]);
  }
}
