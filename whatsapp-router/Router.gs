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
//         EMAIL_WATCHER_TOKEN  — shared secret con el script bound a
//                                facturas@balanceclip.net
//         SIGNUP_ADMIN_PHONE   — número (sin +) del admin que recibe
//                                notificaciones de signup y puede usar
//                                el comando `activar` (default 50769812266)
//         LOG_SHEET_ID         — ID del Sheet de logs de conversaciones.
//                                Se autocrea al primer log; no setear a mano
//                                salvo que quieras apuntar a otro Sheet.
//         CONTACT_EMAIL/WEBSITE/WHATSAPP — opcionales (info marketing)
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

  // Admin API (JSONP): leer conversaciones del bot desde el sheet de logs.
  if (params.action && (params.action === 'getConversations' || params.action === 'getConversation')) {
    return _routerHandleAdminQuery(params);
  }

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
    // Endpoint interno: client GAS pidiendo enviar OTP de reset de
    // password vía WhatsApp al cliente.
    if (data && data.action === 'sendResetOtp') {
      return _routerHandleSendResetOtp(data);
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

  // Logging inbound — siempre primero para tener trazabilidad completa.
  _routerLogInbound(msg, from);

  var props   = PropertiesService.getScriptProperties();
  var token   = props.getProperty('META_WHATSAPP_TOKEN');
  var phoneId = props.getProperty('META_PHONE_ID') || (metadata.phone_number_id || '');
  var adminPhone = props.getProperty('SIGNUP_ADMIN_PHONE') || '50769812266';

  // ── 1. Interactivos del flujo de SIGNUP / ANÁLISIS PROSPECT
  //      (funcionan también para números todavía no en el mapa).
  if (msg.type === 'interactive') {
    var iaReplyTop = msg.interactive || {};
    var btnIdTop = (iaReplyTop.list_reply   && iaReplyTop.list_reply.id)   ||
                   (iaReplyTop.button_reply && iaReplyTop.button_reply.id) || '';
    if (btnIdTop.indexOf('signup:') === 0) {
      _routerHandleSignupReply(from, btnIdTop, token, phoneId);
      return;
    }
    if (btnIdTop === 'analisis:chat') {
      _routerEnviarAnalisisChatConfirm(from, token, phoneId);
      return;
    }
    if (btnIdTop === 'analisis:email') {
      _routerEnviarAnalisisEmailIntro(from, token, phoneId);
      return;
    }
  }

  // ── 2. Texto durante un setup en curso (signup o capture de email análisis).
  if (msg.type === 'text') {
    var analisisEmailState = _routerGetAnalisisEmailState(from);
    if (analisisEmailState && analisisEmailState.step === 'awaiting_email') {
      _routerHandleAnalisisEmailText(from, (msg.text && msg.text.body) || '', token, phoneId);
      return;
    }
    var signupState = _routerGetSignupState(from);
    if (signupState) {
      _routerHandleSignupText(from, (msg.text && msg.text.body) || '', token, phoneId);
      return;
    }
  }

  // ── 3. Comandos de admin (solo desde el número configurado).
  if (msg.type === 'text' && from === adminPhone) {
    var adminBody = (msg.text && msg.text.body) ? String(msg.text.body).trim() : '';
    if (/^activar\s+/i.test(adminBody)) {
      _routerHandleActivarCommand(from, adminBody, token, phoneId);
      return;
    }
  }

  // ── 4. Routing normal: cliente conocido o desconocido.
  var map = _routerGetClientsMap();
  var clientUrl = map[from];

  // ── Número desconocido: si manda un xlsx o ya está en sesión demo
  //    activa → route al GAS demo. Si no, welcome con botones.
  if (!clientUrl) {
    var demoUrl = props.getProperty('DEMO_CLIENT_URL');
    var isXlsxDoc = (msg.type === 'document') && _routerEsXlsxAttachment(msg);
    var hasDemoSession = _routerGetDemoSession(from);
    if (demoUrl && (isXlsxDoc || hasDemoSession)) {
      if (isXlsxDoc) _routerSetDemoSession(from);
      clientUrl = demoUrl;
      Logger.log('Visitor → DEMO GAS (xlsx=' + isXlsxDoc + ' session=' + !!hasDemoSession + ')');
    } else {
      Logger.log('Numero no reconocido: ' + _routerMaskPhone(from));
      _routerReplyDesconocido(from, token, phoneId);
      return;
    }
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

    // En estado awaiting_link_confirmation — esperamos LISTO/ya/confirmé
    // tras haber mandado el link de Gmail al usuario.
    if (setupState && setupState.step === 'awaiting_link_confirmation') {
      if (/^(listo|ya|confirme|confirmé|confirmado|done|ok|siguiente|next|paso\s*2|continuar)\b/.test(bodyText)) {
        _routerClearSetupState(from);
        _routerEnviarInstruccionesFiltroGmail(from, token, phoneId);
        return;
      }
      _routerSendText(from,
        '⏳ Esperando que toques el link de Gmail y veas la confirmación de Google.\n\n' +
        'Cuando esté listo, escríbeme *LISTO* y te paso el Paso 2.\n\n' +
        '(O escribe *cancelar* para salir.)',
        token, phoneId);
      return;
    }

    // En estado awaiting_email — esperamos que el usuario mande su email
    if (setupState && setupState.step === 'awaiting_email') {
      var emailParsed = _routerParseEmail(bodyText);
      if (!emailParsed) {
        _routerSendText(from,
          '⚠️ No reconozco eso como un email válido. Mándame tu dirección completa.\n' +
          'Ejemplo: tunombre@' + (setupState.provider === 'gmail' ? 'gmail.com' : 'outlook.com') + '\n\n' +
          'O escribe *cancelar* para salir.',
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

    // Trigger de signup demo (también accesible para clientes existentes
    // por si quieren registrar un negocio adicional).
    if (/^(demo|registrar|registrarme|signup|sign up|prueba|probar)$/.test(bodyText)) {
      _routerIniciarSignup(from, token, phoneId);
      return;
    }

    var triggers = ['hola','help','ayuda','menu','menú','instrucciones','info','start','inicio'];
    var pidióAyuda = triggers.indexOf(bodyText) !== -1;
    var primera   = !_routerYaSaludado(from);
    if (primera || pidióAyuda) {
      _routerEnviarBienvenida(from, token, phoneId);
      _routerMarcarSaludado(from);
      return;
    }
    // Texto no-trigger: en lugar de responder con "no entendí" desde el
    // router, dejamos caer al forward al client GAS. Esto habilita los
    // drill-downs por texto del módulo banco ("ver mayo", "excel") y
    // cualquier comando futuro del cliente. Si el client GAS tampoco
    // sabe qué hacer con el texto, manda su propio welcome de fallback.
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
    var rc   = resp.getResponseCode();
    var body = (resp.getContentText() || '').substring(0, 200);
    Logger.log('Client GAS responded ' + rc + ': ' + body);

    // Si el cliente GAS falla, avisarle al usuario en vez de quedar mudo.
    // 2xx con body JSON ok:true → OK (no avisamos, el cliente responde solo)
    // Cualquier otra cosa → fallback con info de debug para el admin.
    var clientGasOk = (rc >= 200 && rc < 300) && body.indexOf('"ok":true') !== -1;
    if (!clientGasOk) {
      var adminPhoneAlert = PropertiesService.getScriptProperties().getProperty('SIGNUP_ADMIN_PHONE') || '50769812266';
      _routerSendText(from,
        '⚠️ Recibí tu factura pero el procesador no respondió correctamente. Avísale al admin y vuelve a intentar en unos minutos.',
        token, phoneId);
      // Notificar al admin con detalles (si no es el admin el que mandó la factura)
      if (from !== adminPhoneAlert) {
        _routerSendText(adminPhoneAlert,
          '🚨 *Forward al cliente falló*\n\n' +
          '📱 Cliente: +' + from + '\n' +
          '🔗 URL: ' + clientUrl + '\n' +
          '📊 HTTP: ' + rc + '\n' +
          '📄 Body (200 chars): ' + body,
          token, phoneId);
      }
    }
  } catch (err) {
    Logger.log('Error forwarding to client: ' + err.message);
    _routerSendText(from,
      '⚠️ Recibí tu factura pero no pude contactar al procesador. Avísale al admin.',
      token, phoneId);
    var adminPhoneAlert2 = PropertiesService.getScriptProperties().getProperty('SIGNUP_ADMIN_PHONE') || '50769812266';
    if (from !== adminPhoneAlert2) {
      _routerSendText(adminPhoneAlert2,
        '🚨 *Forward al cliente falló (excepción)*\n\n' +
        '📱 Cliente: +' + from + '\n' +
        '🔗 URL: ' + clientUrl + '\n' +
        '❌ Error: ' + err.message,
        token, phoneId);
    }
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
    '🤖 *¡Hola! Soy el asistente de BalanceClip*\n\n' +
    'Tengo 2 funciones, usá la que necesites:\n\n' +
    '━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
    '📸 *Registrar facturas y gastos*\n\n' +
    'Mandame foto o PDF de tu factura/recibo. La IA detecta monto, fecha, proveedor, RUC y categoría DGI, y te respondo con 2 botones:\n' +
    '   ✅ *Aprobar* — acepta lo sugerido\n' +
    '   📝 *Cambiar categoría* — lista de opciones\n\n' +
    'Funciona con facturas fiscales, electrónicas, Yappy, transferencias y PDFs. Revisás todo en balanceclip.net\n\n' +
    '━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
    '📊 *Analizar estado de cuenta bancario*\n\n' +
    'Mandame el .xlsx de tu cuenta de Banco General. Te doy:\n' +
    '• Resumen de saldo, flujo y top categorías al instante\n' +
    '• Excel ejecutivo con diagnóstico, semáforo de salud y drill-downs por destinatario/merchant\n' +
    '• *Asesor IA*: preguntame _"¿cuánto gasté en comida?"_, _"¿en qué se va más mi plata?"_, etc.\n\n' +
    'Drill por texto: *ver comida*, *ver mayo*, *excel*.\n\n' +
    '━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
    '📋 *Comandos útiles*\n' +
    '• *ayuda* — ver estas instrucciones\n' +
    '• *configurar email* — reenvío automático de facturas desde tu Gmail/Outlook a *facturas@balanceclip.net*\n\n' +
    '¿Listo? Mandame una factura o un .xlsx 📤';
  _routerSendText(to, body, token, phoneId);
}

// ────────────────────────────────────────────────────────────────────
//  Ayuda breve (texto no reconocido de cliente ya saludado)
// ────────────────────────────────────────────────────────────────────
function _routerReplyAyudaBreve(to, token, phoneId) {
  if (!token || !phoneId) return;
  var body =
    '🤖 No entendí el mensaje. Lo que puedo hacer:\n\n' +
    '📸 Mándame una *foto o PDF de tu factura* y la registro.\n' +
    '📋 Escríbeme *ayuda* para ver las instrucciones completas.';
  _routerSendText(to, body, token, phoneId);
}

// ────────────────────────────────────────────────────────────────────
//  Wrapper de envío de texto plano (DRY para el router)
// ────────────────────────────────────────────────────────────────────
function _routerSendText(to, body, token, phoneId) {
  var status = 'err';
  try {
    var r = UrlFetchApp.fetch(META_GRAPH_BASE + '/' + phoneId + '/messages', {
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
    status = (r.getResponseCode() >= 200 && r.getResponseCode() < 300) ? 'ok' : ('http_' + r.getResponseCode());
  } catch(err) {
    Logger.log('_routerSendText ERROR: ' + err.message);
    status = 'error:' + err.message;
  }
  _routerLog('out', to, 'text', '', body, status);
}

function _routerGetClientsMap() {
  var json = PropertiesService.getScriptProperties().getProperty('CLIENTS_MAP_JSON') || '{}';
  try { return JSON.parse(json); }
  catch(err) { Logger.log('CLIENTS_MAP_JSON inválido: ' + err.message); return {}; }
}

// ────────────────────────────────────────────────────────────────────
//  Responder a número no registrado en el mapa
//  → ofrece signup demo (botón) + ver más info (botón)
// ────────────────────────────────────────────────────────────────────
function _routerReplyDesconocido(to, token, phoneId) {
  if (!token || !phoneId) {
    Logger.log('Faltan META_WHATSAPP_TOKEN o META_PHONE_ID — no puedo responder a número desconocido');
    return;
  }
  try {
    UrlFetchApp.fetch(META_GRAPH_BASE + '/' + phoneId + '/messages', {
      method:      'post',
      contentType: 'application/json',
      headers:     { 'Authorization': 'Bearer ' + token },
      payload:     JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text:
            '👋 ¡Hola! Soy *BalanceClip* — asistente fiscal automatizado para profesionales y negocios en Panamá. 🇵🇦\n\n' +
            'Llevo tus finanzas por WhatsApp, sin entrar a una app:\n\n' +
            '📸 *Registro tus facturas y gastos*\n' +
            'Mandame foto/PDF o reenviá emails → una IA los lee, categoriza según DGI y los deja listos para aprobar.\n\n' +
            '📊 *Analizo tu cuenta de Banco General*\n' +
            'Subís el .xlsx → te devuelvo análisis al instante, reporte PDF ejecutivo, Excel con matriz destinatario × mes y asesor IA.\n\n' +
            'Reportes ITBMS mensual e informe anual DGI listos para presentar.\n\n' +
            '¿Qué te interesa probar?\n\n' +
            '_Al usar el servicio aceptas nuestros términos y política de privacidad._\n' +
            'https://balanceclip.net/privacidad/'
          },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'signup:facturas', title: '📸 Registrar Gastos' } },
              { type: 'reply', reply: { id: 'signup:analisis', title: '📊 Analizar Cuenta' } },
            ],
          },
        },
      }),
      muteHttpExceptions: true,
    });
  } catch(err) { Logger.log('Reply desconocido ERROR: ' + err.message); }
}

function _routerEnviarInfoMarketing(to, token, phoneId) {
  var props = PropertiesService.getScriptProperties();
  var email = props.getProperty('CONTACT_EMAIL')    || 'ventas@balanceclip.net';
  var web   = props.getProperty('CONTACT_WEBSITE')  || 'https://balanceclip.net';
  var waNum = props.getProperty('CONTACT_WHATSAPP') || '+507 6018-8276';
  var body =
    'ℹ️ *Más sobre BalanceClip*\n\n' +
    'Somos un asistente fiscal automatizado para profesionales y negocios en Panamá.\n\n' +
    '*Cómo te ayudamos*\n' +
    '• 📸 Envías facturas por WhatsApp — IA las lee y categoriza DGI\n' +
    '• 📧 Configuras tus emails de proveedores para reenviar facturas automáticamente\n' +
    '• 📊 Reportes ITBMS mensual e informe anual DGI listos para presentar\n' +
    '• 🔐 Panel web personal con tu data privada y segura\n\n' +
    '*Contacto comercial*\n' +
    '📧 ' + email + '\n' +
    '🌐 ' + web + '\n' +
    '💬 WhatsApp: ' + waNum + '\n\n' +
    'Si quieres *probar gratis 7 días*, escríbeme *demo* y arrancamos el registro. 🎁';
  _routerSendText(to, body, token, phoneId);
}

// Sub-card del welcome de prospecto: detalla el flujo de facturas + CTAs.
// Disparado por btn "📸 Registrar Gastos" (signup:facturas) en _routerReplyDesconocido.
function _routerEnviarInfoFacturas(to, token, phoneId) {
  if (!token || !phoneId) return;
  try {
    UrlFetchApp.fetch(META_GRAPH_BASE + '/' + phoneId + '/messages', {
      method:      'post',
      contentType: 'application/json',
      headers:     { 'Authorization': 'Bearer ' + token },
      payload:     JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text:
            '📸 *Registrar tus facturas y gastos*\n\n' +
            'Envíame foto, PDF o reenvía emails de tus facturas/recibos. Una IA:\n\n' +
            '• Extrae monto, fecha, proveedor y RUC\n' +
            '• Sugiere la categoría DGI apropiada\n' +
            '• Detecta ITBMS y si es deducible\n' +
            '• Te pide aprobar con 1 botón\n\n' +
            'Funciona con facturas fiscales, electrónicas, recibos Yappy, transferencias y PDFs.\n\n' +
            '🧾 *Reportes que obtienes*\n' +
            '• Declaración ITBMS mensual\n' +
            '• Informe anual DGI (Form 90)\n' +
            '• Panel web con todo tu histórico\n\n' +
            '¿Lo pruebas *gratis 7 días*?'
          },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'signup:start', title: '🎁 Probar 7 días' } },
              { type: 'reply', reply: { id: 'signup:info',  title: 'ℹ️ Más info' } },
            ],
          },
        },
      }),
      muteHttpExceptions: true,
    });
  } catch(err) { Logger.log('InfoFacturas ERROR: ' + err.message); }
}

// Sub-card del welcome de prospecto: detalla el flujo de análisis bancario,
// con instrucciones de cómo descargar el xlsx de Banco General.
// Disparado por btn "📊 Analizar Cuenta" (signup:analisis) en _routerReplyDesconocido.
// Muestra el cómo + 2 vías para entregar el xlsx (chat o email).
function _routerEnviarInfoAnalisis(to, token, phoneId) {
  if (!token || !phoneId) return;
  try {
    UrlFetchApp.fetch(META_GRAPH_BASE + '/' + phoneId + '/messages', {
      method:      'post',
      contentType: 'application/json',
      headers:     { 'Authorization': 'Bearer ' + token },
      payload:     JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text:
            '📊 *Analizar tu cuenta de Banco General*\n\n' +
            'Envíame el .xlsx de tu cuenta y te devuelvo en 30 segundos:\n\n' +
            '• Saldo, flujo, ahorro y top categorías\n' +
            '• *Reporte PDF ejecutivo* con semáforo de salud, donut chart de categorías y tendencia mensual\n' +
            '• Excel con matriz destinatario × mes (heatmap) y drill-down por categoría\n' +
            '• *Asesor IA*: pregúntame en lenguaje natural — _"¿cuánto gasté en comida?"_, _"¿en qué se va más mi dinero?"_\n\n' +
            '📥 *Cómo descargar tu xlsx*\n' +
            '1. Entra a Banca en Línea de Banco General desde tu laptop\n' +
            '2. Movimientos → Estado de cuenta\n' +
            '3. Elige el rango (recomendado: últimos 12 meses)\n' +
            '4. Exportar a Excel (.xlsx)\n\n' +
            '¿Cómo prefieres enviármelo?'
          },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'analisis:chat',  title: '💬 Por este chat' } },
              { type: 'reply', reply: { id: 'analisis:email', title: '📧 Por email' } },
            ],
          },
        },
      }),
      muteHttpExceptions: true,
    });
  } catch(err) { Logger.log('InfoAnalisis ERROR: ' + err.message); }
}

// Disparado por btn "💬 Por este chat" (analisis:chat).
// Sólo confirma que el bot queda a la espera del archivo.
function _routerEnviarAnalisisChatConfirm(to, token, phoneId) {
  _routerSendText(to,
    '✅ *Perfecto, te espero.*\n\n' +
    'Cuando tengas el .xlsx descargado, adjúntalo aquí (📎 → Documento) y lo analizo al instante.\n\n' +
    '_Tip: el análisis es totalmente privado. Tu archivo se procesa en memoria y no se guarda en servidores compartidos._',
    token, phoneId);
}

// Disparado por btn "📧 Por email" (analisis:email).
// Da instrucciones del alias y pide el email del usuario para mapear
// futuras llegadas a su número de WhatsApp.
function _routerEnviarAnalisisEmailIntro(to, token, phoneId) {
  // Guardar estado: esperamos que el visitante responda con su email.
  _routerSetAnalisisEmailState(to, { step: 'awaiting_email', ts: Date.now() });
  _routerSendText(to,
    '📧 *Enviar por email*\n\n' +
    'Reenvía el .xlsx (o adjúntalo a un email) a:\n\n' +
    '*analisis@balanceclip.net*\n\n' +
    '👉 *Escríbeme en este chat tu email para identificarlo.*\n' +
    'Ejemplo: `tunombre@gmail.com`\n\n' +
    '_Una vez identificado, cualquier xlsx que envíes desde ese email te llegará analizado a este WhatsApp en menos de 1 minuto._',
    token, phoneId);
}

// State machine simple para capturar el email del visitante. Vive en
// Script Properties con TTL de 30 min.
var _ANALISIS_EMAIL_TTL_MS = 30 * 60 * 1000;

function _routerGetAnalisisEmailState(from) {
  var raw = PropertiesService.getScriptProperties().getProperty('analisis_email_' + from);
  if (!raw) return null;
  try {
    var s = JSON.parse(raw);
    if (!s.ts || (Date.now() - s.ts) > _ANALISIS_EMAIL_TTL_MS) {
      _routerClearAnalisisEmailState(from);
      return null;
    }
    return s;
  } catch(e) { return null; }
}
function _routerSetAnalisisEmailState(from, state) {
  state.ts = Date.now();
  PropertiesService.getScriptProperties().setProperty('analisis_email_' + from, JSON.stringify(state));
}
function _routerClearAnalisisEmailState(from) {
  PropertiesService.getScriptProperties().deleteProperty('analisis_email_' + from);
}

// Procesa el texto del usuario mientras está en el flujo de email-setup.
// Valida formato, guarda el mapping email→phone, confirma.
function _routerHandleAnalisisEmailText(from, body, token, phoneId) {
  var email = String(body || '').trim().toLowerCase();
  var emailRe = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
  if (!emailRe.test(email)) {
    _routerSendText(from,
      '⚠️ Eso no parece un email válido. ¿Puedes escribirlo nuevamente?\n\n' +
      'Ejemplo: *tunombre@gmail.com*',
      token, phoneId);
    return;
  }
  // Guardar mapping global email→phone (mismo formato que el flow de
  // "configurar email" — el watcher de analisis@ usa esta clave).
  PropertiesService.getScriptProperties().setProperty('email_' + email, from);
  _routerClearAnalisisEmailState(from);
  _routerSendText(from,
    '✅ *Listo, identifiqué tu email:* ' + email + '\n\n' +
    'Envía tu xlsx a *analisis@balanceclip.net* desde esa cuenta y en menos de 1 minuto te llega el análisis aquí.\n\n' +
    '🔒 _Privacidad: una vez procesado, el email se borra permanentemente en máximo 1 hora. Tu archivo nunca se guarda en servidores._\n\n' +
    '_Si prefieres enviarlo ahora por chat, adjúntalo directamente (📎 → Documento)._',
    token, phoneId);
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

var _ROUTER_SETUP_TTL_MS    = 60 * 60 * 1000;          // 1h — provider/email
var _ROUTER_CONFIRM_TTL_MS  = 7  * 24 * 60 * 60 * 1000; // 7d — esperando "LISTO"

function _routerGetSetupState(from) {
  var raw = PropertiesService.getScriptProperties().getProperty('setup_' + from);
  if (!raw) return null;
  try {
    var s = JSON.parse(raw);
    var maxAge = (s.step === 'awaiting_link_confirmation') ? _ROUTER_CONFIRM_TTL_MS : _ROUTER_SETUP_TTL_MS;
    if (!s.ts || (Date.now() - s.ts) > maxAge) {
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
            '*facturas@balanceclip.net* — así no tienes que mandarlas ' +
            'manualmente por WhatsApp.\n\n' +
            '¿Qué proveedor de email usas?'
          },
          footer: { text: 'Escribe "cancelar" para salir' },
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
  var sel = btnId.replace('setup:', '');
  // Entrypoint disparado por el recordatorio post-factura del backend.
  if (sel === 'start') {
    _routerIniciarSetup(from, token, phoneId);
    return;
  }
  if (sel !== 'gmail' && sel !== 'outlook') return;
  _routerPedirEmail(from, sel, token, phoneId);
}

function _routerPedirEmail(from, provider, token, phoneId) {
  _routerSetSetupState(from, { step: 'awaiting_email', provider: provider });
  var ejemplo = provider === 'gmail' ? 'tunombre@gmail.com' : 'tunombre@outlook.com';
  var nombre  = provider === 'gmail' ? 'Gmail'             : 'Outlook';
  _routerSendText(from,
    '📧 Perfecto, *' + nombre + '*.\n\n' +
    '*Mándame tu dirección de email completa* (la cuenta de la que vas a reenviar las facturas).\n\n' +
    'Ejemplo: ' + ejemplo + '\n\n' +
    'Escribe *cancelar* si quieres salir.',
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
    '*📋 Paso 1 de 2 — Autorizar facturas@balanceclip.net en tu Gmail*\n' +
    '_(Hazlo desde la computadora — no funciona desde el celular)_\n\n' +
    '*1.* Abre mail.google.com con *' + email + '*\n' +
    '*2.* Engranaje ⚙️ (arriba a la derecha) → *Ver todos los ajustes*\n' +
    '*3.* Tab *"Reenvío y POP/IMAP"*\n' +
    '*4.* Botón *"Añadir una dirección de reenvío"*\n' +
    '*5.* Ingresa: facturas@balanceclip.net → *Siguiente* → *Continuar*\n\n' +
    '⏳ *Espera aquí* — Google nos manda un link de verificación a nuestro buzón. Apenas llegue (1-2 min) *te lo paso por WhatsApp*. Lo tocas desde tu teléfono y queda autorizado en 1 click.\n\n' +
    'Después te mando el *Paso 2*, que es lo que hace que las facturas de cada proveedor lleguen automáticamente.';
  _routerSendText(from, body, token, phoneId);
}

function _routerEnviarInstruccionesOutlook(from, email, token, phoneId) {
  // En Outlook personal no hay paso de verificación — vamos directo a
  // las reglas por proveedor.
  var body =
    '✅ Anotado: *' + email + '*\n\n' +
    '*📋 Configurar reenvío por proveedor en Outlook*\n\n' +
    'En Outlook no hay paso de verificación: vas directo a crear *una regla por cada proveedor* del que recibes facturas por email (ENSA, IDAAN, Tigo, Farmacias Arrocha, etc.). Lo haces *una vez por proveedor* y queda funcionando para siempre.\n\n' +
    '_(Hazlo desde la computadora)_\n\n' +
    '*1.* Abre outlook.live.com con *' + email + '*\n' +
    '*2.* Busca en tu inbox un email reciente del proveedor (ej: una factura de *Farmacias Arrocha*, que llega desde factura.electronica@arrocha.com)\n' +
    '*3.* *Click derecho* sobre el email → *Avanzado* → *Crear regla*\n' +
    '*4.* En la regla que se abre:\n' +
    '  • Condición *"De"* = el email del proveedor (Outlook lo precarga; en el ejemplo: factura.electronica@arrocha.com)\n' +
    '  • Acción *"Reenviar a"* → facturas@balanceclip.net\n' +
    '*5.* *Guardar*\n\n' +
    '🔁 *Repite estos pasos con cada proveedor* del que recibes facturas. A partir de ese momento todas las facturas futuras de ese proveedor se procesan automáticamente. 🎉\n\n' +
    '⚠️ *Atención si tu cuenta es de Outlook corporativo (Microsoft 365 del trabajo)*: el reenvío externo puede estar bloqueado por tu admin de IT. Síntomas: la regla se guarda pero las facturas no llegan a BalanceClip.\n\n' +
    'Si necesitas re-ver estas instrucciones más adelante: escríbeme *configurar email*.';
  _routerSendText(from, body, token, phoneId);
}

// ────────────────────────────────────────────────────────────────────
//  Paso 2 (solo Gmail) — se manda cuando el usuario nos confirma con
//  "LISTO" que clickeó el link de verificación.
// ────────────────────────────────────────────────────────────────────
function _routerEnviarInstruccionesFiltroGmail(from, token, phoneId) {
  var body =
    '🎯 *Paso 2 de 2 — Reenviar facturas por proveedor*\n\n' +
    'Ya tienes facturas@balanceclip.net habilitada en tu Gmail. Ahora hay que crear *un filtro por cada proveedor* del que recibes facturas por email (ENSA, IDAAN, Tigo, Farmacias Arrocha, etc.). Lo haces *una vez por proveedor* y queda funcionando para siempre.\n\n' +
    '*Cómo hacerlo (ejemplo con Farmacias Arrocha):*\n\n' +
    '*1.* En Gmail, abre un email reciente del proveedor (ej: una factura de *Farmacias Arrocha*)\n' +
    '*2.* Toca los *3 puntos* (⋮) arriba a la derecha del email\n' +
    '*3.* Elige *"Filtrar mensajes como este"*\n' +
    '*4.* Confirma el campo *"De:"* — debe tener el email del proveedor (en el ejemplo: factura.electronica@arrocha.com)\n' +
    '*5.* Toca *"Crear filtro"* (abajo a la derecha)\n' +
    '*6.* Marca ✅ *"Reenviarlo a:"* → elige *facturas@balanceclip.net* en el menú\n' +
    '*7.* (Opcional) Marca ✅ *"Marcar como leído"* para que no te llenen la bandeja\n' +
    '*8.* Toca *"Crear filtro"*\n\n' +
    '🔁 *Repite con cada proveedor* que te mande facturas por email. A partir de ese momento todas las facturas futuras de ese proveedor se procesan automáticamente. 🎉\n\n' +
    'Si necesitas re-ver estas instrucciones más adelante: escríbeme *configurar email*.';
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
  var link  = data.link || null;

  if (!email || !link) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'missing email/link' }))
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

  // Mandar el link al usuario y entrar en estado "esperando confirmación
  // manual". Cuando responda LISTO le mandamos el Paso 2 (filtros por
  // proveedor).
  var body =
    '📬 *Tu link de verificación de Gmail*\n\n' +
    'Toca este link *desde tu teléfono* para autorizar facturas@balanceclip.net en tu Gmail (*' + email + '*):\n\n' +
    link + '\n\n' +
    'Gmail te va a mostrar "Confirmation Success" o similar. Cuando lo veas, *escríbeme LISTO* aquí y te paso el Paso 2: cómo hacer que cada proveedor te mande las facturas automáticamente. 🚀';
  _routerSendText(phone, body, metaToken, phoneId);

  _routerSetSetupState(phone, { step: 'awaiting_link_confirmation', provider: 'gmail', email: email });

  Logger.log('verifyEmailCode: link enviado a ' + phone + ' (email=' + email + ')');
  return ContentService.createTextOutput(JSON.stringify({ ok: true, sent_to: phone }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ════════════════════════════════════════════════════════════════════
//  FLUJO DE SIGNUP (DEMO 7 DÍAS)
//  ────────────────────────────
//  Para números no en CLIENTS_MAP_JSON. El bot ofrece un demo gratuito
//  y recolecta los datos mínimos necesarios para que el admin haga el
//  deploy manual en deploy.html.
//
//  Estado por usuario: signup_<phone> = JSON
//    { step: 'awaiting_negocio' | 'awaiting_ruc' | 'awaiting_dv'
//          | 'awaiting_email_admin' | 'awaiting_forwarder'
//          | 'awaiting_confirm',
//      data: { negocio, ruc, dv?, adminEmail, forwarderEmail },
//      ts:   <ms> }
//
//  El DV NO se busca automáticamente — al cliente se le pasa el link
//  oficial del DGI (etax2.mef.gob.pa/etax2web/Ruc/ConsultarDV.aspx)
//  y lo consulta él mismo si no lo sabe.
//
//  Una vez completado:
//    - Limpia signup_<phone>
//    - Guarda persistente en signup_pending_<phone> (sin TTL)
//    - Notifica al admin (SIGNUP_ADMIN_PHONE) con la data y el comando
//      `activar <phone> <deploymentUrl>` listo para copiar.
//
//  El admin manda `activar <phone> <url>` desde su propio WhatsApp →
//  el router agrega la entrada al CLIENTS_MAP_JSON y le envía la
//  bienvenida al cliente.
// ════════════════════════════════════════════════════════════════════

var _ROUTER_SIGNUP_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function _routerGetSignupState(from) {
  var raw = PropertiesService.getScriptProperties().getProperty('signup_' + from);
  if (!raw) return null;
  try {
    var s = JSON.parse(raw);
    if (!s.ts || (Date.now() - s.ts) > _ROUTER_SIGNUP_TTL_MS) {
      _routerClearSignupState(from);
      return null;
    }
    return s;
  } catch(err) { _routerClearSignupState(from); return null; }
}
function _routerSetSignupState(from, state) {
  state.ts = Date.now();
  PropertiesService.getScriptProperties().setProperty('signup_' + from, JSON.stringify(state));
}
function _routerClearSignupState(from) {
  PropertiesService.getScriptProperties().deleteProperty('signup_' + from);
}

function _routerHandleSignupReply(from, btnId, token, phoneId) {
  var action = btnId.replace('signup:', '');
  if (action === 'facturas') {
    _routerEnviarInfoFacturas(from, token, phoneId);
    return;
  }
  if (action === 'analisis') {
    _routerEnviarInfoAnalisis(from, token, phoneId);
    return;
  }
  if (action === 'info') {
    _routerEnviarInfoMarketing(from, token, phoneId);
    return;
  }
  if (action === 'start') {
    _routerIniciarSignup(from, token, phoneId);
    return;
  }
  if (action === 'confirm_yes') {
    var st = _routerGetSignupState(from);
    if (!st || st.step !== 'awaiting_confirm') {
      _routerSendText(from, 'Tu registro expiró. Escríbeme *demo* para empezar de nuevo.', token, phoneId);
      return;
    }
    _routerFinalizarSignup(from, st.data, token, phoneId);
    return;
  }
  if (action === 'confirm_no') {
    _routerIniciarSignup(from, token, phoneId);
    return;
  }
}

function _routerIniciarSignup(from, token, phoneId) {
  _routerSetSignupState(from, { step: 'awaiting_negocio', data: {} });
  _routerSendText(from,
    '🎁 *Demo 7 días gratis*\n\n' +
    'Te hago *5 preguntas rápidas* y después un técnico te configura todo. Te aviso por aquí apenas esté listo — y desde ese momento puedes empezar a mandar facturas. 🚀\n\n' +
    '*Pregunta 1 de 5*\n' +
    '¿Cuál es la *razón social* o nombre legal de tu negocio?\n' +
    '_(Ej: Servicios ACME, S.A. — o tu nombre si eres persona natural)_\n\n' +
    '_Escribí *cancelar* en cualquier momento para salir._',
    token, phoneId);
}

function _routerHandleSignupText(from, text, token, phoneId) {
  var state = _routerGetSignupState(from);
  if (!state) return;
  var trimmed = String(text || '').trim();
  var lower = trimmed.toLowerCase();

  if (/^(cancelar|salir|cancel|exit)$/.test(lower)) {
    _routerClearSignupState(from);
    _routerSendText(from, '👍 Registro cancelado. Si quieres probar más adelante, escríbeme *demo*.', token, phoneId);
    return;
  }

  var data = state.data || {};

  // ── Q1: Negocio ──
  if (state.step === 'awaiting_negocio') {
    if (trimmed.length < 2) {
      _routerSendText(from, '⚠️ Ese nombre es muy corto. Escríbeme la razón social/nombre legal del negocio.', token, phoneId);
      return;
    }
    data.negocio = trimmed.substring(0, 200);
    _routerSetSignupState(from, { step: 'awaiting_ruc', data: data });
    _routerSendText(from,
      '✅ Anotado: *' + data.negocio + '*\n\n' +
      '*Pregunta 2 de 5*\n' +
      '¿Cuál es el *RUC* del negocio (sin el dígito verificador)?\n' +
      '_(Ej: 2470636-1-814806)_',
      token, phoneId);
    return;
  }

  // ── Q2: RUC (validación de formato) ──
  if (state.step === 'awaiting_ruc') {
    var rucClean = trimmed.replace(/\s+/g, '');
    if (!_routerValidarFormatoRuc(rucClean)) {
      _routerSendText(from,
        '⚠️ Eso no parece un RUC válido. Debe tener números y guiones.\n' +
        'Ej: *2470636-1-814806*  o  *8-NT-1-12345*\n\n' +
        'Mándalo de nuevo, o escribe *cancelar* para salir.',
        token, phoneId);
      return;
    }
    data.ruc = rucClean;
    _routerSetSignupState(from, { step: 'awaiting_dv', data: data });
    _routerSendText(from,
      '✅ RUC anotado: *' + rucClean + '*\n\n' +
      '*Pregunta 3 de 5*\n' +
      '¿Cuál es tu *Dígito Verificador (DV)*?\n' +
      '_(Son 1 o 2 dígitos, ej: 06 o 12)_\n\n' +
      '🔗 *Si no lo sabes, consultalo gratis aquí:*\n' +
      'https://etax2.mef.gob.pa/etax2web/Ruc/ConsultarDV.aspx\n\n' +
      'Si todavía no tienes DV, escribe *ninguno*.',
      token, phoneId);
    return;
  }

  // ── Q3: DV (con link al DGI) ──
  if (state.step === 'awaiting_dv') {
    if (/^(ninguno?|no|no s[eé]|sin dv|no tengo)$/i.test(lower)) {
      data.dv = '';
    } else {
      var dvClean = trimmed.replace(/\D/g, '');
      if (dvClean.length < 1 || dvClean.length > 2) {
        _routerSendText(from,
          '⚠️ El DV debe tener 1 o 2 dígitos (ej: 6, 06, 12).\n\n' +
          '🔗 Consultalo gratis aquí si no lo sabes:\n' +
          'https://etax2.mef.gob.pa/etax2web/Ruc/ConsultarDV.aspx\n\n' +
          'O escribe *ninguno* si todavía no lo tienes.',
          token, phoneId);
        return;
      }
      data.dv = dvClean.length === 1 ? '0' + dvClean : dvClean;
    }
    _routerSetSignupState(from, { step: 'awaiting_email_admin', data: data });
    _routerSendText(from,
      '✅ ' + (data.dv ? 'DV anotado: *' + data.dv + '*' : 'OK, sin DV por ahora.') + '\n\n' +
      '*Pregunta 4 de 5*\n' +
      '¿Cuál es tu *email* personal o del negocio?\n' +
      '_(Lo usamos para crear tu usuario del panel web y mandarte notificaciones)_\n' +
      'Ej: tunombre@gmail.com',
      token, phoneId);
    return;
  }

  // ── Q4: Email admin ──
  if (state.step === 'awaiting_email_admin') {
    var emailA = _routerParseEmail(trimmed);
    if (!emailA) {
      _routerSendText(from, '⚠️ No reconozco eso como un email válido. Mándame tu dirección, ej: tunombre@gmail.com', token, phoneId);
      return;
    }
    data.adminEmail = emailA;
    _routerSetSignupState(from, { step: 'awaiting_forwarder', data: data });
    _routerSendText(from,
      '✅ Email anotado: *' + emailA + '*\n\n' +
      '*Pregunta 5 de 5*\n' +
      '¿Desde qué *email recibes facturas de proveedores* (el que quieres que reenvíe automáticamente a BalanceClip)?\n\n' +
      '• Si es el mismo email que el anterior, escribe *mismo*\n' +
      '• Si todavía no usas email para recibir facturas, escribe *ninguno*',
      token, phoneId);
    return;
  }

  // ── Q5: Forwarder email ──
  if (state.step === 'awaiting_forwarder') {
    var fwdEmail;
    if (/^ninguno?$/i.test(lower))      fwdEmail = '';
    else if (/^mismo$/i.test(lower))    fwdEmail = data.adminEmail;
    else {
      var parsed = _routerParseEmail(trimmed);
      if (!parsed) {
        _routerSendText(from, '⚠️ No reconozco eso como un email. Mándalo de nuevo, o escribe *mismo* / *ninguno*.', token, phoneId);
        return;
      }
      fwdEmail = parsed;
    }
    data.forwarderEmail = fwdEmail;
    _routerSetSignupState(from, { step: 'awaiting_confirm', data: data });
    _routerEnviarResumenSignup(from, data, token, phoneId);
    return;
  }

  // ── Q5: Confirmación (texto, además del botón) ──
  if (state.step === 'awaiting_confirm') {
    if (/^(s[ií]|ok|confirmar|confirmo|todo ok)$/i.test(lower)) {
      _routerFinalizarSignup(from, data, token, phoneId);
      return;
    }
    if (/^(no|corregir|editar|cambiar)$/i.test(lower)) {
      _routerIniciarSignup(from, token, phoneId);
      return;
    }
    _routerEnviarResumenSignup(from, data, token, phoneId);
  }
}

function _routerEnviarResumenSignup(to, data, token, phoneId) {
  var rucCompleto = data.dv ? (data.ruc + ' DV ' + data.dv) : data.ruc;
  var bodyText =
    '📋 *Confirma tus datos:*\n\n' +
    '🏢 Negocio: *' + data.negocio + '*\n' +
    '🆔 RUC: *' + rucCompleto + '*\n' +
    '📧 Tu email: *' + data.adminEmail + '*\n' +
    '📨 Email facturas: *' + (data.forwarderEmail || '(ninguno)') + '*\n' +
    '📱 Tu WhatsApp: *+' + to + '*\n\n' +
    '¿Todo correcto?';
  try {
    UrlFetchApp.fetch(META_GRAPH_BASE + '/' + phoneId + '/messages', {
      method:      'post',
      contentType: 'application/json',
      headers:     { 'Authorization': 'Bearer ' + token },
      payload:     JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: bodyText },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'signup:confirm_yes', title: '✅ Sí, todo OK' } },
              { type: 'reply', reply: { id: 'signup:confirm_no',  title: '✏️ Corregir' } },
            ],
          },
        },
      }),
      muteHttpExceptions: true,
    });
  } catch(err) { Logger.log('_routerEnviarResumenSignup ERROR: ' + err.message); }
}

function _routerFinalizarSignup(from, data, token, phoneId) {
  // Persistir como pending (sin TTL) para que el admin pueda consultarlo
  // si tarda en activar.
  var props = PropertiesService.getScriptProperties();
  props.setProperty('signup_pending_' + from, JSON.stringify({
    phone: from, ts: Date.now(), data: data,
  }));
  _routerClearSignupState(from);

  // Confirmar al cliente
  _routerSendText(from,
    '🎉 *¡Listo, recibimos tu solicitud!*\n\n' +
    'Un técnico de BalanceClip te va a configurar la cuenta en *la próxima hora*. *Te aviso por aquí apenas esté lista* y desde ese momento ya puedes empezar a mandar facturas. 📤\n\n' +
    'Gracias por probar BalanceClip 🙌',
    token, phoneId);

  // Notificar al admin
  var adminPhone = props.getProperty('SIGNUP_ADMIN_PHONE') || '50769812266';
  var rucCompleto = data.dv ? (data.ruc + ' DV ' + data.dv) : data.ruc;
  var adminMsg =
    '🆕 *Nuevo signup demo*\n\n' +
    '📱 Cliente: +' + from + '\n' +
    '🏢 Negocio: ' + data.negocio + '\n' +
    '🆔 RUC: ' + rucCompleto + '\n' +
    '📧 Admin email: ' + data.adminEmail + '\n' +
    '📨 Forwarder: ' + (data.forwarderEmail || '(ninguno)') + '\n\n' +
    '⚡ *Cuando termines el deploy:*\n' +
    '`activar ' + from + ' <deploymentUrl>`\n\n' +
    '_(copia la deployment URL desde deploy.html paso 4 y envía ese comando aquí mismo)_';
  _routerSendText(adminPhone, adminMsg, token, phoneId);
}

// ────────────────────────────────────────────────────────────────────
//  Comando admin: activar <phone> <deploymentUrl>
//  Solo aceptamos si from === SIGNUP_ADMIN_PHONE (chequeado por el caller).
//  Agrega la entrada al CLIENTS_MAP_JSON y le manda welcome al cliente.
// ────────────────────────────────────────────────────────────────────
function _routerHandleActivarCommand(from, text, token, phoneId) {
  // Acepta la URL envuelta en <...> o [...] (WhatsApp/iOS auto-formatean
  // los links así). Los chars de la URL excluyen los wrappers.
  var m = String(text || '').match(/^activar\s+(\d{8,})\s+[<\[]?(https?:\/\/[^\s<>\]]+)[>\]]?\s*$/i);
  if (!m) {
    _routerSendText(from,
      '⚠️ Formato del comando:\n' +
      '`activar <phone_sin_+> <deployment_url>`\n\n' +
      'Ejemplo:\n' +
      '`activar 50769812266 https://script.google.com/macros/s/.../exec`',
      token, phoneId);
    return;
  }
  var newPhone = m[1];
  var url      = m[2];

  // Validación de longitud — el número debe incluir código de país.
  // Meta entrega el `from` con código de país (ej Panamá: 507XXXXXXXX),
  // así que si lo guardamos sin código nunca va a hacer match.
  if (newPhone.length < 10) {
    var suggested = newPhone.length === 8 ? ('507' + newPhone) : null;
    _routerSendText(from,
      '⚠️ *Número incompleto*\n\n' +
      'El número *' + newPhone + '* no incluye código de país. Meta entrega los mensajes con el código país adelante (Panamá = 507), así que el routing no va a funcionar.\n\n' +
      (suggested
        ? '👉 Prueba con:\n`activar ' + suggested + ' ' + url + '`'
        : 'Mándalo con el código de país adelante (sin el "+").'),
      token, phoneId);
    return;
  }

  // Actualizar CLIENTS_MAP_JSON (merge)
  var props   = PropertiesService.getScriptProperties();
  var mapJson = props.getProperty('CLIENTS_MAP_JSON') || '{}';
  var map;
  try { map = JSON.parse(mapJson); } catch(err) { map = {}; }
  var yaExistia = !!map[newPhone];
  map[newPhone] = url;
  props.setProperty('CLIENTS_MAP_JSON', JSON.stringify(map));

  // Limpiar el flag de "ya saludado" para que el welcome vaya completo
  props.deleteProperty('welcomed_' + newPhone);

  // Enviar welcome al cliente
  _routerEnviarBienvenida(newPhone, token, phoneId);
  _routerMarcarSaludado(newPhone);

  // Mover signup_pending → signup_activated
  var pendingKey = 'signup_pending_' + newPhone;
  var pending    = props.getProperty(pendingKey);
  if (pending) {
    try {
      var parsed = JSON.parse(pending);
      parsed.activated_at = Date.now();
      props.setProperty('signup_activated_' + newPhone, JSON.stringify(parsed));
      props.deleteProperty(pendingKey);
    } catch(err) { /* ignore */ }
  }

  // Confirmar al admin
  _routerSendText(from,
    '✅ *Cliente activado*\n\n' +
    '📱 +' + newPhone + (yaExistia ? ' _(actualizado en el map)_' : ' _(nuevo en el map)_') + '\n' +
    '🔗 ' + url + '\n\n' +
    'Le envié la bienvenida — ya puede empezar a mandar facturas.',
    token, phoneId);
}

// ────────────────────────────────────────────────────────────────────
//  Validación de formato de RUC panameño.
//  Acepta combinaciones razonables:
//   • 2470636-1-814806            (jurídica)
//   • 8-123-456                   (natural)
//   • 8-NT-1-12345                (NT/N.T. = naturalizado/extranjero)
//   • 155-12345-6                 (jurídica nueva)
// ────────────────────────────────────────────────────────────────────
function _routerValidarFormatoRuc(ruc) {
  var s = String(ruc || '').replace(/\s+/g, '').toUpperCase();
  if (s.length < 5 || s.length > 30) return false;
  // Debe tener al menos un guión y solo dígitos/guiones/letras NT/N.T./E/PE
  if (!/^[0-9NTPE.\-]+$/.test(s)) return false;
  if (s.replace(/[^0-9]/g, '').length < 4) return false;
  if (s.indexOf('-') < 0) return false;
  return true;
}

// ════════════════════════════════════════════════════════════════════
//  RECORDATORIO DE SIGNUPS PENDIENTES
//  ─────────────────────────────────
//  El bot le promete al cliente que la cuenta queda lista en ~1h.
//  Si el admin no activó después de 15 min, le mandamos un nudge
//  por WhatsApp para que no se le pase desapercibido el signup.
//
//  Instalación (una sola vez desde el editor del router):
//    > Run installSignupReminderTrigger()
//  Eso instala un trigger time-based que corre cada 5 minutos.
//
//  Idempotencia: una vez enviado el nudge, se marca el property
//  con reminded_at, así no se manda dos veces. Si el admin tarda
//  más, sigue recibiendo solo el primer reminder (no spam).
// ════════════════════════════════════════════════════════════════════

function checkPendingSignups() {
  var props = PropertiesService.getScriptProperties();
  var token   = props.getProperty('META_WHATSAPP_TOKEN');
  var phoneId = props.getProperty('META_PHONE_ID');
  var adminPhone = props.getProperty('SIGNUP_ADMIN_PHONE') || '50769812266';
  if (!token || !phoneId) {
    Logger.log('checkPendingSignups: faltan META credentials');
    return;
  }

  var REMIND_AFTER_MS = 15 * 60 * 1000; // 15 min
  var now = Date.now();
  var allKeys = props.getKeys();
  var pendingKeys = allKeys.filter(function(k) { return k.indexOf('signup_pending_') === 0; });

  pendingKeys.forEach(function(key) {
    var raw = props.getProperty(key);
    if (!raw) return;
    try {
      var data = JSON.parse(raw);
      if (!data || !data.ts) return;
      if (data.reminded_at) return;  // ya avisamos antes
      if ((now - data.ts) < REMIND_AFTER_MS) return;

      var phone = data.phone || key.replace('signup_pending_', '');
      var d = data.data || {};
      var minutos = Math.round((now - data.ts) / 60000);
      var msg =
        '⏰ *Recordatorio — signup pendiente*\n\n' +
        'Hace *' + minutos + ' min* este cliente se registró y todavía no lo activaste:\n\n' +
        '📱 +' + phone + '\n' +
        '🏢 ' + (d.negocio || '(sin nombre)') + '\n' +
        '🆔 ' + (d.ruc || '(sin RUC)') + (d.dv ? ' DV ' + d.dv : '') + '\n' +
        '📧 ' + (d.adminEmail || '(sin email)') + '\n\n' +
        '🎯 Comando listo:\n' +
        '`activar ' + phone + ' <deploymentUrl>`\n\n' +
        '_(Le prometimos al cliente que su cuenta está lista en ~1h.)_';
      _routerSendText(adminPhone, msg, token, phoneId);

      // Marcar como recordado y guardar
      data.reminded_at = now;
      props.setProperty(key, JSON.stringify(data));
      Logger.log('Reminder enviado para signup ' + phone + ' (esperando hace ' + minutos + ' min)');
    } catch(err) {
      Logger.log('checkPendingSignups error en key ' + key + ': ' + err.message);
    }
  });
}

function installSignupReminderTrigger() {
  // Borrar triggers viejos del mismo handler para evitar duplicados.
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'checkPendingSignups') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkPendingSignups').timeBased().everyMinutes(5).create();
  Logger.log('Trigger checkPendingSignups instalado (cada 5 min).');
}

// ════════════════════════════════════════════════════════════════════
//  LOGGING DE CONVERSACIONES
//  ─────────────────────────
//  Cada mensaje (inbound + outbound) se persiste en un Google Sheet
//  dedicado para que el admin pueda ver "qué conversaciones tuvo el
//  bot esta semana" sin depender de los logs efímeros de Apps Script
//  (que se borran a los 7 días).
//
//  Sheet: se crea automáticamente la primera vez que se intenta
//  loggear algo. El ID queda en la Script Property LOG_SHEET_ID.
//  El propietario del Sheet es la cuenta que owna el Apps Script
//  del router (típicamente el admin) — no se comparte con nadie por
//  defecto, así que la data del bot queda privada.
//
//  Schema (columnas):
//    A  timestamp   — Date
//    B  phone       — número del usuario (sin +)
//    C  dir         — 'in' | 'out'
//    D  tipo        — text | image | document | interactive | audio | ...
//    E  accion      — etiqueta libre (welcome, signup_q1, factura_forward,
//                     etc.) — opcional, vacía si no aplica
//    F  contenido   — body del mensaje truncado a 500 chars
//    G  status      — ok | err | http_XXX | error:msg
//
//  Costo: appendRow es ~1s por log. Con ~3 logs por interacción
//  (1 in + 2 out) → ~3s extra por mensaje. Aceptable.
//  Para volúmenes grandes (>10k/mes) conviene rotar a una pestaña
//  mensual — eso lo agregamos cuando haga falta.
// ════════════════════════════════════════════════════════════════════

function _routerLogEnsureSheet() {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty('LOG_SHEET_ID');
  var ss = null;
  if (sheetId) {
    try { ss = SpreadsheetApp.openById(sheetId); }
    catch(err) {
      Logger.log('LOG_SHEET_ID inválido (' + sheetId + '): ' + err.message + ' — creando nuevo');
      sheetId = null;
      ss = null;
    }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('BalanceClip Bot Logs');
    sheetId = ss.getId();
    props.setProperty('LOG_SHEET_ID', sheetId);
    var sheet = ss.getActiveSheet();
    sheet.setName('logs');
    sheet.getRange(1, 1, 1, 7).setValues([['timestamp','phone','dir','tipo','accion','contenido','status']]);
    sheet.getRange(1, 1, 1, 7).setFontWeight('bold').setBackground('#f3f4f6');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 160);
    sheet.setColumnWidth(2, 130);
    sheet.setColumnWidth(3, 50);
    sheet.setColumnWidth(4, 90);
    sheet.setColumnWidth(5, 130);
    sheet.setColumnWidth(6, 500);
    sheet.setColumnWidth(7, 100);
    Logger.log('Log sheet creado: ' + ss.getUrl());
  }
  return ss;
}

function _routerLog(dir, phone, tipo, accion, contenido, status) {
  try {
    var ss = _routerLogEnsureSheet();
    var sheet = ss.getSheetByName('logs') || ss.getSheets()[0];
    sheet.appendRow([
      new Date(),
      String(phone   || ''),
      String(dir     || ''),
      String(tipo    || ''),
      String(accion  || ''),
      String(contenido || '').substring(0, 500),
      String(status  || 'ok'),
    ]);
  } catch(err) {
    // No queremos que un fallo de logging rompa el handler de mensaje.
    Logger.log('_routerLog ERROR: ' + err.message);
  }
}

function _routerLogInbound(msg, from) {
  var tipo = msg.type || 'unknown';
  var contenido = '';
  var accion = '';
  if (tipo === 'text') {
    contenido = (msg.text && msg.text.body) || '';
  } else if (tipo === 'image') {
    contenido = '[image id=' + (msg.image && msg.image.id || '?') + ']';
  } else if (tipo === 'document') {
    var f = msg.document && msg.document.filename || '?';
    contenido = '[document filename="' + f + '"]';
  } else if (tipo === 'audio') {
    contenido = '[audio id=' + (msg.audio && msg.audio.id || '?') + ']';
  } else if (tipo === 'interactive') {
    var ia = msg.interactive || {};
    var bid    = (ia.list_reply && ia.list_reply.id)    || (ia.button_reply && ia.button_reply.id)    || '';
    var btitle = (ia.list_reply && ia.list_reply.title) || (ia.button_reply && ia.button_reply.title) || '';
    contenido = '[' + (ia.type || 'btn') + ' id="' + bid + '" title="' + btitle + '"]';
    accion = bid; // útil para filtrar por setup:start / wa:apr:* / signup:*
  } else {
    contenido = '[' + tipo + ']';
  }
  _routerLog('in', from, tipo, accion, contenido, 'recv');
}

// Helper para llamar desde el editor y abrir el Sheet de logs.
function routerOpenLogSheet() {
  var ss = _routerLogEnsureSheet();
  Logger.log('Sheet URL: ' + ss.getUrl());
  return ss.getUrl();
}

// ════════════════════════════════════════════════════════════════════
//  ADMIN API — visor read-only de conversaciones del bot
//  ─────────────────────────────────────────────────────
//  Sirve JSONP para que el admin panel (balanceclip.net/admin/) pueda
//  leer la data sin CORS. Auth: query param `adminToken` que matchea
//  el Script Property ADMIN_TOKEN del router.
//
//  Acciones:
//    ?action=getConversations         — lista de leads agrupada por phone
//    ?action=getConversation&phone=X  — thread completo de un phone
// ════════════════════════════════════════════════════════════════════

function _routerHandleAdminQuery(params) {
  var callback = params.callback || '';
  function _resp(obj) {
    var json = JSON.stringify(obj);
    var body = callback ? (callback + '(' + json + ')') : json;
    var mime = callback ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON;
    return ContentService.createTextOutput(body).setMimeType(mime);
  }
  var expected = PropertiesService.getScriptProperties().getProperty('ADMIN_TOKEN') || '';
  if (!expected) return _resp({ ok: false, error: 'ADMIN_TOKEN no configurado en el router' });
  if (String(params.adminToken || '') !== expected) return _resp({ ok: false, error: 'auth' });
  try {
    if (params.action === 'getConversations') return _resp(_routerAdminListConversations(params));
    if (params.action === 'getConversation')  return _resp(_routerAdminGetConversation(String(params.phone || '')));
    return _resp({ ok: false, error: 'unknown action' });
  } catch(err) {
    return _resp({ ok: false, error: err.message });
  }
}

function _routerAdminListConversations(params) {
  var ss    = _routerLogEnsureSheet();
  var sheet = ss.getSheetByName('logs') || ss.getSheets()[0];
  var last  = sheet.getLastRow();
  if (last < 2) return { ok: true, items: [], total: 0, totalMsgs: 0 };
  var values = sheet.getRange(2, 1, last - 1, 7).getValues();
  // Schema columnas: timestamp, phone, dir, tipo, accion, contenido, status
  var byPhone = {};
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var phone = String(row[1] || '').trim();
    if (!phone) continue;
    var ts = row[0] instanceof Date ? row[0].getTime() : new Date(row[0]).getTime();
    var dir       = String(row[2] || '');
    var tipo      = String(row[3] || '');
    var accion    = String(row[4] || '');
    var contenido = String(row[5] || '');
    var c = byPhone[phone];
    if (!c) {
      c = byPhone[phone] = {
        phone: phone, firstTime: ts, lastTime: 0,
        lastDir: '', lastMsg: '', lastTipo: '', lastAccion: '',
        msgCount: 0, inCount: 0, outCount: 0,
        // Status semántico para el chip del lead. Se infiere del lastAccion.
        signupStatus: '',
      };
    }
    c.msgCount++;
    if (dir === 'in')  c.inCount++;
    if (dir === 'out') c.outCount++;
    if (ts < c.firstTime) c.firstTime = ts;
    if (ts >= c.lastTime) {
      c.lastTime   = ts;
      c.lastDir    = dir;
      c.lastMsg    = contenido;
      c.lastTipo   = tipo;
      c.lastAccion = accion;
    }
  }
  var items = [];
  Object.keys(byPhone).forEach(function(k){
    var c = byPhone[k];
    // Inferir status del lead: el accion del router etiqueta la fase del signup
    var a = String(c.lastAccion || '').toLowerCase();
    if (a.indexOf('signup:done') === 0)        c.signupStatus = 'activo';
    else if (a.indexOf('signup:') === 0)       c.signupStatus = 'signup';
    else if (a.indexOf('setup:') === 0)        c.signupStatus = 'setup';
    else if (a.indexOf('wa:apr:') === 0)       c.signupStatus = 'aprobando';
    else if (c.outCount > 0 && c.inCount > 0)  c.signupStatus = 'activo';
    else if (c.inCount > 0 && c.outCount === 0) c.signupStatus = 'nuevo';
    items.push(c);
  });
  items.sort(function(a,b){ return b.lastTime - a.lastTime; });
  var q = String(params.q || '').trim().toLowerCase();
  if (q) {
    items = items.filter(function(c){
      return c.phone.indexOf(q) >= 0
        || (c.lastMsg && c.lastMsg.toLowerCase().indexOf(q) >= 0);
    });
  }
  var status = String(params.status || '').trim();
  if (status && status !== 'all') {
    items = items.filter(function(c){ return c.signupStatus === status; });
  }
  var totalMsgs = values.length;
  var limit  = parseInt(params.limit,  10) || 100;
  var offset = parseInt(params.offset, 10) || 0;
  var page = items.slice(offset, offset + limit);
  return { ok: true, items: page, total: items.length, totalMsgs: totalMsgs };
}

function _routerAdminGetConversation(phone) {
  if (!phone) return { ok: false, error: 'phone required' };
  var ss    = _routerLogEnsureSheet();
  var sheet = ss.getSheetByName('logs') || ss.getSheets()[0];
  var last  = sheet.getLastRow();
  if (last < 2) return { ok: true, phone: phone, items: [] };
  var values = sheet.getRange(2, 1, last - 1, 7).getValues();
  var items = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (String(row[1] || '').trim() !== phone) continue;
    var ts = row[0] instanceof Date ? row[0].getTime() : new Date(row[0]).getTime();
    items.push({
      time:      ts,
      dir:       String(row[2] || ''),
      tipo:      String(row[3] || ''),
      accion:    String(row[4] || ''),
      contenido: String(row[5] || ''),
      status:    String(row[6] || ''),
    });
  }
  items.sort(function(a,b){ return a.time - b.time; });
  return { ok: true, phone: phone, items: items };
}

// ════════════════════════════════════════════════════════════════════
//  Diagnóstico — ejecutar desde el editor para validar config
// ════════════════════════════════════════════════════════════════════
function routerTestConfig() {
  var props   = PropertiesService.getScriptProperties();
  var token   = props.getProperty('META_WHATSAPP_TOKEN');
  var phoneId = props.getProperty('META_PHONE_ID');
  var verify  = props.getProperty('META_VERIFY_TOKEN');
  var watcher = props.getProperty('EMAIL_WATCHER_TOKEN');
  var admin   = props.getProperty('SIGNUP_ADMIN_PHONE');
  var mapJson = props.getProperty('CLIENTS_MAP_JSON') || '{}';

  Logger.log('META_WHATSAPP_TOKEN: ' + (token   ? '✅ set ('+token.substring(0,20)+'…)' : '❌ MISSING'));
  Logger.log('META_PHONE_ID:       ' + (phoneId ? '✅ ' + phoneId : '❌ MISSING'));
  Logger.log('META_VERIFY_TOKEN:   ' + (verify  ? '✅ set' : '❌ MISSING'));
  Logger.log('EMAIL_WATCHER_TOKEN: ' + (watcher ? '✅ set ('+watcher.length+' chars)' : '⚠️ MISSING (sin esto el watcher no puede notificar codes)'));
  Logger.log('SIGNUP_ADMIN_PHONE:  ' + (admin   ? '✅ ' + admin : '⚠️ default 50769812266 (setear para producción)'));

  // Log sheet
  var logSheetId = props.getProperty('LOG_SHEET_ID');
  if (logSheetId) {
    try {
      var ss = SpreadsheetApp.openById(logSheetId);
      var sheet = ss.getSheetByName('logs') || ss.getSheets()[0];
      var rows = Math.max(0, sheet.getLastRow() - 1);
      Logger.log('LOG_SHEET_ID:        ✅ ' + ss.getUrl() + ' (' + rows + ' logs)');
    } catch(err) {
      Logger.log('LOG_SHEET_ID:        ⚠️ ID seteado pero no se pudo abrir: ' + err.message);
    }
  } else {
    Logger.log('LOG_SHEET_ID:        ⚠️ no creado — se crea automático al primer log entrante');
  }

  var map;
  try { map = JSON.parse(mapJson); }
  catch(err) { Logger.log('CLIENTS_MAP_JSON: ❌ JSON inválido: ' + err.message); return; }
  var keys = Object.keys(map);
  Logger.log('CLIENTS_MAP_JSON: ' + (keys.length ? '✅ ' + keys.length + ' cliente(s) mapeado(s)' : '⚠️ vacío'));
  for (var k = 0; k < keys.length; k++) {
    Logger.log('  ' + keys[k] + ' → ' + map[keys[k]]);
  }

  // Signups pendientes
  var allKeys = props.getKeys();
  var pendings = allKeys.filter(function(k) { return k.indexOf('signup_pending_') === 0; });
  if (pendings.length) {
    Logger.log('Signups pendientes de activar: ' + pendings.length);
    pendings.forEach(function(k) {
      var phone = k.replace('signup_pending_', '');
      try {
        var d = JSON.parse(props.getProperty(k));
        Logger.log('  +' + phone + ' — ' + (d.data.negocio || '?') + ' — ' + (d.data.adminEmail || '?'));
      } catch(err) { Logger.log('  +' + phone + ' (parse error)'); }
    });
  }
}

// ════════════════════════════════════════════════════════════════════
//  RESET DE PASSWORD VIA OTP — endpoint llamado por client GAS
//
//  El client GAS (ContaFacil_Auth → _handleSolicitarCodigoReset)
//  genera un OTP de 6 dígitos y nos lo manda. Nosotros lo entregamos
//  por WhatsApp al cliente.
//
//  Verifica el shared secret ROUTER_RESET_TOKEN para que solo los
//  client GAS confiables puedan disparar envíos de OTP.
// ════════════════════════════════════════════════════════════════════
function _routerHandleSendResetOtp(data) {
  var props    = PropertiesService.getScriptProperties();
  // Token viene de OTP_CONFIG si fue inyectado por deploy-gas.js (router
  // no entra en clients.json hoy, así que en práctica se usa Script Property).
  var expected = '';
  if (typeof OTP_CONFIG !== 'undefined' && OTP_CONFIG.ROUTER_RESET_TOKEN) {
    expected = OTP_CONFIG.ROUTER_RESET_TOKEN;
  } else {
    expected = props.getProperty('ROUTER_RESET_TOKEN') || '';
  }
  if (!expected || data.token !== expected) {
    Logger.log('sendResetOtp: token shared-secret inválido');
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'forbidden' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var phone = String(data.phone || '').replace(/\D/g, '').trim();
  var otp   = String(data.otp || '').trim();
  if (!phone || !/^\d{6}$/.test(otp)) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'missing phone/otp' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var metaToken = props.getProperty('META_WHATSAPP_TOKEN');
  var phoneId   = props.getProperty('META_PHONE_ID');

  // Insertar espacio en el OTP para que sea más legible (482 931).
  var otpDisplay = otp.slice(0, 3) + ' ' + otp.slice(3);
  var body =
    '🔐 *Código para restablecer contraseña*\n\n' +
    'Tu código: *' + otpDisplay + '*\n\n' +
    'Válido 5 minutos. Si no fuiste vos, ignorá este mensaje.';
  _routerSendText(phone, body, metaToken, phoneId);

  Logger.log('sendResetOtp: OTP enviado a ' + phone);
  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ════════════════════════════════════════════════════════════════════
//  WATCHER DE analisis@balanceclip.net — análisis bancario por email
//  ──────────────────────────────────────────────────────────────────
//  El catch-all de balanceclip.net entrega todo a un solo inbox. Este
//  watcher pesca los emails dirigidos al alias analisis@, extrae el
//  xlsx adjunto, resuelve sender → phone vía el mapping de Properties
//  y forwardea al client GAS correspondiente.
//
//  La idea es bajar la fricción del análisis bancario: descargar el
//  xlsx desde Banca en Línea de Banco General se hace típicamente
//  desde laptop, donde es más fácil mandar por email que por WhatsApp.
//
//  Trigger: time-based cada 1 min (instalar con
//  _installAnalisisBancoTrigger desde el editor).
// ════════════════════════════════════════════════════════════════════

var ANALISIS_ALIAS_EMAIL  = 'analisis@balanceclip.net';
var ANALISIS_LABEL_DONE   = 'analizado_cf_banco';

function procesarEmailsAnalisisBanco() {
  var props   = PropertiesService.getScriptProperties();
  var token   = props.getProperty('META_WHATSAPP_TOKEN');
  var phoneId = props.getProperty('META_PHONE_ID');
  var clientsMap = _routerGetClientsMap();

  // Query amplio + validación destino en código (mismo patrón que el
  // watcher de Acreedores). El catch-all puede entregar a cualquier
  // *@balanceclip.net, así que filtramos por análisis del To/headers.
  var query   = 'has:attachment -label:' + ANALISIS_LABEL_DONE + ' newer_than:7d';
  var threads = GmailApp.search(query, 0, 50);
  Logger.log('📧 Watcher analisis: ' + threads.length + ' threads candidatos');

  var doneLabel = _routerGetOrCreateLabel(ANALISIS_LABEL_DONE);
  var processed = 0, skipped = 0;

  for (var t = 0; t < threads.length; t++) {
    var thread   = threads[t];
    var messages = thread.getMessages();
    var hitInThread = false;

    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      try {
        // ¿El mensaje fue enviado a analisis@?
        if (!_routerEmailDestinoEsAlias(msg, ANALISIS_ALIAS_EMAIL)) {
          skipped++;
          continue;
        }
        // Sender → phone
        var senderEmail = _routerExtractSenderEmail(msg);
        if (!senderEmail) {
          Logger.log('  ⏭ Sin sender válido — skip');
          skipped++;
          continue;
        }
        var phone = props.getProperty('email_' + senderEmail.toLowerCase());
        if (!phone) {
          // Sanitiza PII en logs: muestra solo prefijo + dominio. La
          // privacy policy promete minimización de PII también en logs.
          Logger.log('  ⏭ Sender ' + _routerMaskEmail(senderEmail) + ' no tiene mapping email→phone');
          _routerNotifySenderSinRegistrar(senderEmail, msg);
          hitInThread = true;
          skipped++;
          continue;
        }
        // Phone → clientUrl. Si no es cliente registrado, fallback al
        // demo GAS (mismo flujo que WhatsApp xlsx para visitantes).
        var clientUrl = clientsMap[phone];
        if (!clientUrl) {
          var demoUrlEmail = props.getProperty('DEMO_CLIENT_URL');
          if (demoUrlEmail) {
            clientUrl = demoUrlEmail;
            _routerSetDemoSession(phone);  // marcar sesión por si después interactúa por WA
            Logger.log('  ↪ Phone ' + _routerMaskPhone(phone) + ' → DEMO GAS (no registrado)');
          } else {
            Logger.log('  ⏭ Phone ' + _routerMaskPhone(phone) + ' no tiene clientUrl y no hay DEMO_CLIENT_URL');
            skipped++;
            continue;
          }
        }
        // Primer xlsx del email
        var xlsxAtt = _routerPickXlsxAttachment(msg);
        if (!xlsxAtt) {
          Logger.log('  ⏭ Email de ' + _routerMaskEmail(senderEmail) + ' sin adjunto xlsx');
          if (token && phoneId) {
            _routerSendText(phone,
              '📧 Recibí un email tuyo en analisis@balanceclip.net pero no encontré un .xlsx adjunto. ' +
              'Asegurate de adjuntar el estado de cuenta exportado desde Banca en Línea.',
              token, phoneId);
          }
          hitInThread = true;
          skipped++;
          continue;
        }
        // Forward al client GAS
        var ok = _routerForwardBancoEmail(clientUrl, phone, xlsxAtt);
        if (ok) {
          processed++;
          hitInThread = true;
          Logger.log('  ✓ Forwarded a clientGAS para phone=' + _routerMaskPhone(phone));
        } else {
          Logger.log('  ✗ Forward falló para phone=' + phone);
        }
      } catch(err) {
        Logger.log('  ❌ Error procesando mensaje: ' + err.message);
      }
    }
    if (hitInThread) {
      try { thread.addLabel(doneLabel); } catch(e) { Logger.log('No pude poner label: ' + e.message); }
    }
  }

  Logger.log('📧 Watcher analisis: procesados=' + processed + ' skipped=' + skipped);
  return { processed: processed, skipped: skipped };
}

// Variante local de _emailDestinoEsAlias (no compartimos código con el
// client GAS porque el router es su propio Apps Script project).
function _routerEmailDestinoEsAlias(msg, alias) {
  if (!alias) return true;
  try {
    var raw = String(msg.getRawContent() || '').toLowerCase();
    return raw.substring(0, 12000).indexOf(String(alias).toLowerCase()) !== -1;
  } catch(e) {
    Logger.log('  ⚠️ No se pudo validar destino: ' + e.message);
    return false;
  }
}

// Extrae el sender email del header From: "Nombre <email@dom>" → email@dom.
function _routerExtractSenderEmail(msg) {
  try {
    var from = String(msg.getFrom() || '');
    var match = /<([^>]+)>/.exec(from);
    if (match) return match[1].trim().toLowerCase();
    // Caso sin ángulos: "email@dom"
    var bare = from.trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bare)) return bare;
    return null;
  } catch(e) { return null; }
}

// Toma el primer adjunto que parezca xlsx (mime o extensión).
function _routerPickXlsxAttachment(msg) {
  try {
    var atts = msg.getAttachments() || [];
    for (var i = 0; i < atts.length; i++) {
      var a = atts[i];
      var name = String(a.getName() || '').toLowerCase();
      var mime = String(a.getContentType() || '').toLowerCase();
      if (mime.indexOf('spreadsheetml') >= 0 || mime.indexOf('ms-excel') >= 0 ||
          /\.(xlsx|xls)$/.test(name)) {
        return a;
      }
    }
  } catch(e) { Logger.log('PickXlsx ERROR: ' + e.message); }
  return null;
}

// Envía el xlsx (como base64) al client GAS. Reusa el patrón de forward
// existente (POST a clientUrl con action específico).
function _routerForwardBancoEmail(clientUrl, phone, attachment) {
  try {
    var blob = attachment.copyBlob();
    var bytes = blob.getBytes();
    var payload = {
      action:   'procesarBancoEmailForward',
      from:     phone,
      filename: blob.getName() || 'estado-de-cuenta.xlsx',
      mime:     blob.getContentType() || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      blob:     Utilities.base64Encode(bytes),
    };
    var resp = UrlFetchApp.fetch(clientUrl, {
      method:             'post',
      contentType:        'application/json',
      payload:            JSON.stringify(payload),
      muteHttpExceptions: true,
      followRedirects:    true,
    });
    var rc = resp.getResponseCode();
    var body = (resp.getContentText() || '').substring(0, 200);
    var ok = (rc >= 200 && rc < 300) && body.indexOf('"ok":true') !== -1;
    if (!ok) Logger.log('Forward banco email HTTP ' + rc + ' body=' + body);
    return ok;
  } catch(err) {
    Logger.log('_routerForwardBancoEmail ERROR: ' + err.message);
    return false;
  }
}

// Cuando un email llega de un sender sin mapping, le contestamos por email
// con instrucciones para registrar su email vía el bot.
function _routerNotifySenderSinRegistrar(senderEmail, msg) {
  try {
    var subject = 'Tu email no está registrado en BalanceClip';
    var body =
      'Hola,\n\n' +
      'Recibimos tu email en analisis@balanceclip.net, pero tu dirección ' +
      senderEmail + ' todavía no está asociada a una cuenta de BalanceClip.\n\n' +
      'Para activar el atajo email→análisis, escribime "configurar email" ' +
      'al bot de WhatsApp de BalanceClip y registrá tu email desde ahí. ' +
      'Una vez registrado, cualquier estado de cuenta que mandes a este ' +
      'alias va a llegar directo a tu WhatsApp con el análisis listo.\n\n' +
      '— BalanceClip';
    GmailApp.sendEmail(senderEmail, subject, body);
  } catch(e) {
    Logger.log('Reply sin registrar ERROR: ' + e.message);
  }
}

// Crea (o devuelve) un label Gmail. Wrapper defensivo.
function _routerGetOrCreateLabel(name) {
  try {
    var lbl = GmailApp.getUserLabelByName(name);
    return lbl || GmailApp.createLabel(name);
  } catch(e) {
    Logger.log('GetOrCreateLabel ERROR: ' + e.message);
    return null;
  }
}

// Instalar el trigger time-based cada 1 min. Ejecutar manualmente desde
// el editor de Apps Script una vez por deployment.
function _installAnalisisBancoTrigger() {
  // Limpiar triggers viejos
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'procesarEmailsAnalisisBanco') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('procesarEmailsAnalisisBanco')
    .timeBased()
    .everyMinutes(1)
    .create();
  Logger.log('✓ Trigger instalado: procesarEmailsAnalisisBanco cada 1 min');
}

// ════════════════════════════════════════════════════════════════════
//  LIMPIEZA DE EMAILS DE ANÁLISIS — privacy by minimization
//  ──────────────────────────────────────────────────────────────────
//  Borra PERMANENTEMENTE (bypassea papelera) los emails ya procesados
//  por el watcher de análisis bancario después de 1h. Cumple con el
//  principio de minimización de datos (Ley 81 Panamá).
//
//  También limpia los auto-replies salientes que enviamos a senders
//  no registrados (subject "Tu email no está registrado…").
//
//  Requiere Advanced Gmail Service habilitado en appsscript.json
//  (Gmail.Users.Messages.remove). El service usa scope
//  https://mail.google.com/ que también está en el manifest.
//
//  Trigger: time-based cada 15 min (instalar con
//  _installLimpiezaAnalisisTrigger desde el editor).
// ════════════════════════════════════════════════════════════════════

function limpiarEmailsAnalisisAntiguos() {
  var stats = { entrantes: 0, salientes: 0, errores: 0 };

  // 1. Emails entrantes ya procesados (label analizado_cf_banco) older 1h
  try {
    var threadsIn = GmailApp.search('label:' + ANALISIS_LABEL_DONE + ' older_than:1h', 0, 100);
    threadsIn.forEach(function(t) {
      try {
        var msgs = t.getMessages();
        msgs.forEach(function(m) {
          Gmail.Users.Messages.remove('me', m.getId());
        });
        stats.entrantes++;
      } catch(e) { stats.errores++; Logger.log('Err borrando thread in: ' + e.message); }
    });
  } catch(e) { Logger.log('Err search entrantes: ' + e.message); }

  // 2. Auto-replies que mandamos a senders no registrados (en Enviados)
  // Subject exacto del email que mandamos en _routerNotifySenderSinRegistrar
  try {
    var threadsOut = GmailApp.search(
      'from:me subject:"Tu email no está registrado en BalanceClip" older_than:1h',
      0, 100
    );
    threadsOut.forEach(function(t) {
      try {
        var msgs = t.getMessages();
        msgs.forEach(function(m) {
          Gmail.Users.Messages.remove('me', m.getId());
        });
        stats.salientes++;
      } catch(e) { stats.errores++; Logger.log('Err borrando thread out: ' + e.message); }
    });
  } catch(e) { Logger.log('Err search salientes: ' + e.message); }

  Logger.log('🧹 Limpieza: entrantes=' + stats.entrantes +
             ' salientes=' + stats.salientes + ' errores=' + stats.errores);
  return stats;
}

function _installLimpiezaAnalisisTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'limpiarEmailsAnalisisAntiguos') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('limpiarEmailsAnalisisAntiguos')
    .timeBased()
    .everyMinutes(15)
    .create();
  Logger.log('✓ Trigger instalado: limpiarEmailsAnalisisAntiguos cada 15 min');
}

// ──────────────────────────────────────────────────────────────────────
//  Helpers de sanitización de PII en logs
//  Reemplazá Logger.log de email/phone por estas masked versions.
// ──────────────────────────────────────────────────────────────────────

function _routerMaskEmail(e) {
  var s = String(e || '');
  var at = s.indexOf('@');
  if (at < 1) return '***';
  var local = s.substring(0, at);
  var domain = s.substring(at);
  var prefix = local.substring(0, Math.min(2, local.length));
  return prefix + '***' + domain;  // ej: "jo***@gmail.com"
}

// ──────────────────────────────────────────────────────────────────────
//  Modo DEMO para visitantes (no registrados en CLIENTS_MAP_JSON).
//  Cuando suben xlsx, ruteamos al GAS demo (Script Property DEMO_CLIENT_URL).
//  La sesión vive 1h: durante ese tiempo, cualquier mensaje del visitor
//  (drill, asesor IA, descargar PDF, etc.) sigue ruteándose al demo.
//  Después de 1h, sin actividad nueva, vuelve al welcome.
// ──────────────────────────────────────────────────────────────────────

var _DEMO_SESSION_TTL_MS = 60 * 60 * 1000;  // 1h, alineado con cache TTL del banco

function _routerGetDemoSession(from) {
  var raw = PropertiesService.getScriptProperties().getProperty('demo_sess_' + from);
  if (!raw) return null;
  try {
    var s = JSON.parse(raw);
    if (!s.ts || (Date.now() - s.ts) > _DEMO_SESSION_TTL_MS) {
      PropertiesService.getScriptProperties().deleteProperty('demo_sess_' + from);
      return null;
    }
    return s;
  } catch(e) { return null; }
}

function _routerSetDemoSession(from) {
  PropertiesService.getScriptProperties().setProperty(
    'demo_sess_' + from,
    JSON.stringify({ ts: Date.now() })
  );
}

// Detecta si un mensaje de tipo document es un xlsx/csv (mismos criterios
// que _bancoEsEstadoDeCuenta del backend).
function _routerEsXlsxAttachment(msg) {
  if (!msg || msg.type !== 'document') return false;
  var doc = msg.document || {};
  var filename = String(doc.filename || '').toLowerCase();
  var mime     = String(doc.mime_type || '').toLowerCase();
  if (mime.indexOf('spreadsheetml') >= 0) return true;
  if (mime.indexOf('ms-excel') >= 0)      return true;
  if (mime === 'text/csv')                return true;
  if (/\.(xlsx|xls|csv)$/.test(filename)) return true;
  return false;
}

function _routerMaskPhone(p) {
  var s = String(p || '');
  if (s.length < 6) return '***';
  // últimos 3 dígitos visibles, resto enmascarado: "507***123"
  return s.substring(0, 3) + '***' + s.substring(s.length - 3);
}
