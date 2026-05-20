// ════════════════════════════════════════════════════════════════════
//  ContaFacil_WhatsApp.gs
//
//  Recepción de facturas vía WhatsApp Business Cloud API (Meta).
//
//  FLUJO
//  ─────
//    1. Cliente envía foto/PDF de factura al número WhatsApp de iris.
//    2. Meta hace POST al webhook (este Apps Script web app).
//    3. Descargamos la media autenticando con el token permanente.
//    4. La IA clasifica: ¿gasto recibido o ingreso emitido?
//    5. Si gasto → se crea pendiente en Acreedores_Pending (mismo flujo
//       que el email forwarding existente). El usuario aprueba desde la app.
//    6. Si ingreso → se crea registro pendiente en Ingresos.
//    7. Respondemos al cliente vía WhatsApp confirmando recepción.
//
//  SCRIPT PROPERTIES requeridas
//  ────────────────────────────
//    META_WHATSAPP_TOKEN  — token permanente (System User) que generaste
//                           en developers.facebook.com
//    META_PHONE_ID        — phone_number_id (1035238479681939 para iris)
//    META_VERIFY_TOKEN    — string que vos eligen, debe coincidir con la
//                           configurada en el Webhook de Meta
//
//  GRAPH API VERSION
//  ─────────────────
//    Usamos v19.0 (estable a 2026). Si Meta deprecia, subir aquí.
// ════════════════════════════════════════════════════════════════════

var META_GRAPH_VERSION = 'v19.0';
var META_GRAPH_BASE    = 'https://graph.facebook.com/' + META_GRAPH_VERSION;

// URL del frontend web para incluir en respuestas de WhatsApp.
// Se lee de Script Property FRONTEND_URL; fallback hardcoded a iris.
function _whatsappFrontendUrl() {
  return PropertiesService.getScriptProperties().getProperty('FRONTEND_URL')
      || 'https://balanceclip.net/iris-albelo-ho/';
}

// ────────────────────────────────────────────────────────────────────
//  doGet hook — verificación del webhook (Meta hace GET con hub.challenge)
//  Llamar desde doGet(e) ANTES de cualquier otro routing.
//  Retorna null si la request no es una verificación de WhatsApp.
// ────────────────────────────────────────────────────────────────────
function _whatsappHandleVerify(params) {
  var mode      = params['hub.mode']         || params.hub_mode;
  var token     = params['hub.verify_token'] || params.hub_verify_token;
  var challenge = params['hub.challenge']    || params.hub_challenge;
  if (mode !== 'subscribe' || !challenge) return null;
  var expected  = PropertiesService.getScriptProperties().getProperty('META_VERIFY_TOKEN') || '';
  if (token !== expected) {
    Logger.log('WhatsApp verify FAIL: token recibido=' + token + ' vs esperado=' + (expected ? '(set)' : '(MISSING)'));
    return ContentService.createTextOutput('Forbidden').setMimeType(ContentService.MimeType.TEXT);
  }
  Logger.log('WhatsApp verify OK — devolviendo challenge');
  return ContentService.createTextOutput(String(challenge)).setMimeType(ContentService.MimeType.TEXT);
}

// ────────────────────────────────────────────────────────────────────
//  doPost hook — recepción de mensajes
//  Llamar desde doPost(e) ANTES del routing por `action`.
//  Detecta el payload de Meta y procesa. Retorna null si no aplica.
// ────────────────────────────────────────────────────────────────────
function _whatsappHandleWebhook(data) {
  if (!data) return null;
  // Caso 1: webhook directo de Meta (single-tenant — sin router)
  if (data.object === 'whatsapp_business_account') {
    return _whatsappHandleWebhookMeta(data);
  }
  // Caso 2: forward del Router (multi-tenant)
  if (data.action === 'procesarWhatsAppForward' && data.msg) {
    return _whatsappHandleForward(data);
  }
  return null;
}

// Procesa el payload original de Meta — usado en modo single-tenant
// (cuando el webhook de Meta apunta directo a este GAS sin router).
function _whatsappHandleWebhookMeta(data) {
  try {
    var entries = data.entry || [];
    for (var e = 0; e < entries.length; e++) {
      var changes = entries[e].changes || [];
      for (var c = 0; c < changes.length; c++) {
        var value = changes[c].value || {};
        var msgs  = value.messages || [];
        for (var m = 0; m < msgs.length; m++) {
          try { _whatsappProcesarMensaje(msgs[m], value.metadata || {}); }
          catch(err) { Logger.log('WhatsApp procesarMensaje ERROR: ' + err.message); }
        }
      }
    }
  } catch(err) {
    Logger.log('WhatsApp handleWebhook ERROR: ' + err.message);
  }
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

// Procesa un mensaje individual forwarded por el Router.
// El router ya validó que este mensaje pertenece a este cliente.
function _whatsappHandleForward(data) {
  try {
    _whatsappProcesarMensaje(data.msg || {}, data.metadata || {});
  } catch(err) {
    Logger.log('_whatsappHandleForward ERROR: ' + err.message);
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ────────────────────────────────────────────────────────────────────
//  Procesar un mensaje individual de WhatsApp
// ────────────────────────────────────────────────────────────────────
function _whatsappProcesarMensaje(msg, metadata) {
  var props     = PropertiesService.getScriptProperties();
  var token     = props.getProperty('META_WHATSAPP_TOKEN');
  var phoneId   = props.getProperty('META_PHONE_ID') || (metadata.phone_number_id || '');
  if (!token) { Logger.log('META_WHATSAPP_TOKEN no configurado'); return; }

  var from    = msg.from || '';
  var msgId   = msg.id   || '';
  var tipo    = msg.type || '';
  Logger.log('WhatsApp msg from=' + from + ' type=' + tipo + ' id=' + msgId);

  // ── Respuesta interactiva (botón o ítem de lista) ──
  // El usuario tapeó "✅ Aprobar" / "📝 Cambiar categoría" o eligió
  // una categoría del list message.
  if (tipo === 'interactive') {
    _whatsappOnInteractive(msg, from, token, phoneId);
    return;
  }

  // ── Mensaje de texto: responder con instrucciones simples ──
  if (tipo === 'text') {
    var body = (msg.text && msg.text.body) || '';
    _whatsappReply(from, '¡Hola! 👋 Soy el asistente fiscal de BalanceClip.\n\n' +
      'Mándame una foto o PDF de tu factura/recibo y la registro automáticamente. ' +
      'La IA detecta si es gasto o ingreso, le saca el monto, la categoría DGI y la deja pendiente ' +
      'para que la apruebes desde la app:\n' + _whatsappFrontendUrl(), token, phoneId);
    return;
  }

  // ── Media: image o document ──
  if (tipo !== 'image' && tipo !== 'document') {
    _whatsappReply(from, '⚠️ Tipo de mensaje no soportado (' + tipo + '). Mandá una foto o PDF.', token, phoneId);
    return;
  }

  var mediaObj = msg[tipo] || {};
  var mediaId  = mediaObj.id || '';
  var mime     = mediaObj.mime_type || (tipo === 'image' ? 'image/jpeg' : 'application/pdf');
  if (!mediaId) { Logger.log('Sin media_id en mensaje ' + msgId); return; }

  // ── Descargar la media ──
  var mediaBlob;
  try {
    mediaBlob = _whatsappDescargarMedia(mediaId, token);
  } catch(err) {
    Logger.log('Error descargando media: ' + err.message);
    _whatsappReply(from, '⚠️ No pude descargar el archivo. Intentá enviarlo de nuevo.', token, phoneId);
    return;
  }

  // ── Clasificar con IA + extraer campos ──
  var parsed;
  try {
    var b64 = Utilities.base64Encode(mediaBlob.getBytes());
    parsed = _whatsappClasificarYExtraer(b64, mime);
  } catch(err) {
    Logger.log('Error IA: ' + err.message);
    _whatsappReply(from, '⚠️ Error procesando el comprobante. ' + err.message, token, phoneId);
    return;
  }

  Logger.log('IA parsed: ' + JSON.stringify(parsed));

  // ── Guardar según tipo detectado ──
  var resumen;
  try {
    if (parsed.tipo_transaccion === 'ingreso') {
      resumen = _whatsappGuardarIngreso(parsed, mediaBlob, mime, from, msgId);
    } else {
      // Default a gasto si la IA no está segura
      resumen = _whatsappGuardarGasto(parsed, mediaBlob, mime, from, msgId);
    }
  } catch(err) {
    Logger.log('Error guardando: ' + err.message);
    _whatsappReply(from, '⚠️ Detecté los datos pero no pude guardar: ' + err.message, token, phoneId);
    return;
  }

  // ── Confirmar al usuario ──
  _whatsappReply(from, resumen, token, phoneId);
}

// ────────────────────────────────────────────────────────────────────
//  Descarga la media de Meta API
//    Paso 1: GET /<media_id> → { url, mime_type }
//    Paso 2: GET <url> con Bearer token → binary
// ────────────────────────────────────────────────────────────────────
function _whatsappDescargarMedia(mediaId, token) {
  var r1 = UrlFetchApp.fetch(META_GRAPH_BASE + '/' + mediaId, {
    method: 'get',
    headers: { 'Authorization': 'Bearer ' + token },
    muteHttpExceptions: true,
  });
  if (r1.getResponseCode() !== 200) {
    throw new Error('Meta media metadata ' + r1.getResponseCode() + ': ' + r1.getContentText().substring(0, 200));
  }
  var meta = JSON.parse(r1.getContentText());
  if (!meta.url) throw new Error('Meta media metadata sin url');
  var r2 = UrlFetchApp.fetch(meta.url, {
    method: 'get',
    headers: { 'Authorization': 'Bearer ' + token },
    muteHttpExceptions: true,
  });
  if (r2.getResponseCode() !== 200) {
    throw new Error('Meta media download ' + r2.getResponseCode());
  }
  return r2.getBlob();
}

// ────────────────────────────────────────────────────────────────────
//  Envía un mensaje de texto al usuario vía WhatsApp Cloud API
// ────────────────────────────────────────────────────────────────────
function _whatsappReply(to, text, token, phoneId) {
  if (!to || !text || !token || !phoneId) {
    Logger.log('_whatsappReply: faltan params');
    return;
  }
  try {
    UrlFetchApp.fetch(META_GRAPH_BASE + '/' + phoneId + '/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + token },
      payload: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        text: { body: String(text).substring(0, 4096) },
      }),
      muteHttpExceptions: true,
    });
  } catch(err) {
    Logger.log('_whatsappReply ERROR: ' + err.message);
  }
}

// ────────────────────────────────────────────────────────────────────
//  Clasifica (gasto vs ingreso) + extrae campos en un solo Claude call
// ────────────────────────────────────────────────────────────────────
function _whatsappClasificarYExtraer(b64, mime) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY no configurada');

  // Sanitizar MIME
  if (mime === 'application/octet-stream') mime = 'image/jpeg';
  var validImg = ['image/jpeg','image/png','image/webp','image/gif'];
  var contentBlock;
  if (mime === 'application/pdf') {
    contentBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
  } else {
    var imgMime = validImg.indexOf(mime) >= 0 ? mime : 'image/jpeg';
    contentBlock = { type: 'image', source: { type: 'base64', media_type: imgMime, data: b64 } };
  }

  var prompt =
    'Analiza este comprobante panameño. Determiná PRIMERO si es:\n' +
    '  - "gasto"   = pago HECHO por el usuario (factura recibida de proveedor, recibo de compra, voucher saliente)\n' +
    '  - "ingreso" = pago RECIBIDO por el usuario (factura emitida por él/ella, voucher Yappy entrante, transferencia recibida)\n\n' +
    'Pista clave: si en el documento el cliente del usuario (Iris Albelo Ho) aparece como RECEPTOR/CLIENTE/PAGADOR → es INGRESO.\n' +
    'Si aparece como EMISOR o no aparece → es GASTO.\n\n' +
    'Responde SOLO con JSON válido, sin markdown:\n' +
    '{\n' +
    '  "tipo_transaccion": "gasto" | "ingreso",\n' +
    '  "confianza":         0-100,\n' +
    '  "fecha":             "YYYY-MM-DD" o null,\n' +
    '  "num_factura":       "..." o null,\n' +
    '  "subtotal":          número,\n' +
    '  "itbms":             número,\n' +
    '  "total":             número,\n' +
    '  "tiene_itbms":       true|false,\n' +
    '  "descripcion":       "..." o null,\n' +
    '  "nombre_otro":       "nombre del proveedor (si gasto) o cliente pagador (si ingreso)",\n' +
    '  "ruc_otro":          "..." o null,\n' +
    '  "categoria_dgi":     "key DGI de la línea correspondiente (ver guía)"\n' +
    '}\n\n' +
    'Para "categoria_dgi" si tipo_transaccion=ingreso, usá las keys del Form 91:\n' +
    '  ventas_servicios (L14, default), honorarios_profesionales (L8), honorarios_comision (L7),\n' +
    '  alquiler_comercial (L10), alquiler_habitacional (L9), intereses_financieros (L11),\n' +
    '  salarios_con_retencion (L1), dietas (L5), fuente_extranjera (L18), otros_ingresos (L13).\n\n' +
    'Si tipo_transaccion=gasto, usá las keys del Anexo 94/Form 90:\n' +
    '  alquileres (L46), nomina (L42), combustible_transporte (L56), servicios_publicos (L75),\n' +
    '  telecomunicaciones (L71), gastos_oficina (L69), publicidad_mercadeo (L68),\n' +
    '  honorarios_profesionales (L60), seguros (L63-66), mantenimiento_reparacion (L67),\n' +
    '  compras_locales (L28 Costo), compras_importadas (L29 Costo), otros_deducibles (L77 default).\n\n' +
    'Montos como números. Sin inventar datos: si un campo no es visible, null o 0.';

  var payload = {
    model:      'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{ role: 'user', content: [ contentBlock, { type: 'text', text: prompt } ] }],
  };

  var r = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  if (r.getResponseCode() !== 200) {
    throw new Error('Claude error ' + r.getResponseCode() + ': ' + r.getContentText().substring(0, 200));
  }
  var resp = JSON.parse(r.getContentText());
  var text = '';
  var content = resp.content || [];
  for (var i = 0; i < content.length; i++) {
    if (content[i].type === 'text') { text = content[i].text; break; }
  }
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

// ────────────────────────────────────────────────────────────────────
//  Guardar gasto pendiente — usa la infraestructura existente de
//  Acreedores (find/crear acreedor + crear pendiente)
// ────────────────────────────────────────────────────────────────────
function _whatsappGuardarGasto(parsed, blob, mime, from, msgId) {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);

  // 1. Encontrar o crear acreedor
  var nombreProv = parsed.nombre_otro || 'Proveedor sin identificar';
  var rucProv    = parsed.ruc_otro    || '';
  var catSug     = parsed.categoria_dgi || 'otros_deducibles';
  var acreedor   = _findOrAutoCreateAcreedor(nombreProv, rucProv, catSug);

  // 2. Guardar archivo en Drive
  var fileName = 'WA-' + msgId + '.' + (mime === 'application/pdf' ? 'pdf' : 'jpg');
  blob.setName(fileName);
  var cfg = _getConfig();
  var driveUrl = _guardarPdfAcreedor(blob.getBytes(), fileName, acreedor.nombre, cfg, mime);

  // 3. Crear pendiente
  var clave = 'whatsapp-' + msgId;
  var parsedForPend = {
    fecha:                parsed.fecha       || '',
    num_factura:          parsed.num_factura || '',
    subtotal:             parsed.subtotal    || 0,
    itbms:                parsed.itbms       || 0,
    total:                parsed.total       || 0,
    descripcion:          parsed.descripcion || nombreProv,
    confianza_categoria:  parsed.confianza   || 0,
    categoria_sugerida:   catSug,
    ruc_receptor:         '',
  };
  var pendId = _crearPendiente(ss, acreedor, parsedForPend, driveUrl, clave, msgId, fileName);

  // Mandar mensaje INTERACTIVO con 2 botones (Aprobar / Cambiar categoría).
  // El usuario decide desde el mismo WhatsApp sin abrir la app.
  // Si los botones fallan o el cliente WA no los soporta, queda el
  // pendiente en la hoja igual y el usuario puede aprobar desde web.
  var props   = PropertiesService.getScriptProperties();
  var token   = props.getProperty('META_WHATSAPP_TOKEN');
  var phoneId = props.getProperty('META_PHONE_ID');
  var bodyTxt = '✅ Gasto recibido\n\n' +
                '📦 ' + (acreedor.nombre || 'Sin proveedor') + '\n' +
                '💵 B/. ' + Number(parsed.total || 0).toFixed(2) +
                (parsed.itbms ? ' (ITBMS B/. ' + Number(parsed.itbms).toFixed(2) + ')' : '') + '\n' +
                '📋 Categoría sugerida: ' + _waCatLabel(catSug);
  _whatsappReplyBotones(from, bodyTxt, '#' + pendId, [
    { id: 'wa:apr:' + pendId, title: '✅ Aprobar' },
    { id: 'wa:cat:' + pendId, title: '📝 Cambiar categoría' },
  ], token, phoneId);

  return null;   // ya respondimos con interactive; el caller no envía nada más
}

// ────────────────────────────────────────────────────────────────────
//  Guardar ingreso pendiente — directo en la hoja Ingresos
// ────────────────────────────────────────────────────────────────────
function _whatsappGuardarIngreso(parsed, blob, mime, from, msgId) {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.SHEET_INGRESOS);
  if (!sheet) throw new Error('Hoja Ingresos no encontrada');

  // 1. Guardar archivo en Drive (carpeta vouchers del cliente)
  var fileName = 'WA-ING-' + msgId + '.' + (mime === 'application/pdf' ? 'pdf' : 'jpg');
  blob.setName(fileName);
  var cfg = _getConfig();
  var driveUrl = '';
  try {
    if (CONFIG.VOUCHER_FOLDER_ID) {
      var folder = DriveApp.getFolderById(CONFIG.VOUCHER_FOLDER_ID);
      var file   = folder.createFile(blob);
      driveUrl   = file.getUrl();
    }
  } catch(err) { Logger.log('Drive save ingreso ERROR: ' + err.message); }

  // 2. Generar id_trans
  var ahora    = new Date();
  var stamp    = Utilities.formatDate(ahora, 'America/Panama', 'yyyyMMddHHmmss');
  var idTrans  = 'ING-WA-' + stamp;
  var fechaIng = parsed.fecha || Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd');
  var mes      = parseInt(fechaIng.split('-')[1], 10) || 0;
  var anio     = parseInt(fechaIng.split('-')[0], 10) || 0;

  // 3. Construir fila
  var fila = new Array(INGRESOS_NCOLS);
  for (var i = 0; i < INGRESOS_NCOLS; i++) fila[i] = '';
  fila[COL_I.ID_TRANS - 1]      = idTrans;
  fila[COL_I.FECHA_REG - 1]     = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
  fila[COL_I.ESTADO - 1]        = 'pendiente';
  fila[COL_I.CONFIANZA_IA - 1]  = 'ia_whatsapp';
  fila[COL_I.FECHA_INGRESO - 1] = fechaIng;
  fila[COL_I.MES - 1]           = mes;
  fila[COL_I.ANIO_FISCAL - 1]   = anio;
  fila[COL_I.SUBTOTAL - 1]      = parseFloat(parsed.subtotal || '0') || 0;
  fila[COL_I.ITBMS - 1]         = parseFloat(parsed.itbms    || '0') || 0;
  fila[COL_I.TOTAL - 1]         = parseFloat(parsed.total    || '0') || 0;
  fila[COL_I.MONEDA - 1]        = 'USD';
  fila[COL_I.TIPO_INGRESO - 1]  = 'venta_producto';   // catch-all interno
  fila[COL_I.CATEGORIA - 1]     = parsed.categoria_dgi || 'ventas_servicios';
  fila[COL_I.NOMBRE_CLI - 1]    = parsed.nombre_otro   || 'Cliente sin identificar';
  fila[COL_I.RUC_CLI - 1]       = parsed.ruc_otro      || '';
  fila[COL_I.NUM_FACTURA - 1]   = parsed.num_factura   || '';
  fila[COL_I.TIPO_COMP - 1]     = 'whatsapp';
  fila[COL_I.DRIVE_URL - 1]     = driveUrl;
  fila[COL_I.DESCRIPCION - 1]   = parsed.descripcion   || '';
  fila[COL_I.NOTAS_INT - 1]     = 'WhatsApp from=' + from + ' msg=' + msgId + ' | IA conf=' + (parsed.confianza || 0) + '%';

  var newRow = sheet.getLastRow() + 1;
  sheet.getRange(newRow, 1, 1, INGRESOS_NCOLS).setValues([fila]);
  sheet.getRange(newRow, COL_I.SUBTOTAL, 1, 3).setNumberFormat('#,##0.00');
  sheet.getRange(newRow, 1, 1, INGRESOS_NCOLS).setBackground('#FFF9C4');

  return '✅ Ingreso recibido vía WhatsApp\n\n' +
         '👤 ' + (parsed.nombre_otro || 'Cliente sin identificar') + '\n' +
         '💵 B/. ' + Number(parsed.total || 0).toFixed(2) + (parsed.itbms ? ' (incluye ITBMS B/. ' + Number(parsed.itbms).toFixed(2) + ')' : '') + '\n' +
         '📋 Línea DGI: ' + (parsed.categoria_dgi || 'ventas_servicios') + '\n' +
         '⏳ Pendiente: ' + idTrans + '\n\n' +
         'Confírmalo desde la app: ' + _whatsappFrontendUrl() + '#registroIngresos';
}

// ────────────────────────────────────────────────────────────────────
//  Helper de prueba — usar desde el Apps Script editor para validar
//  conectividad con Meta antes del primer mensaje real.
// ────────────────────────────────────────────────────────────────────
function whatsappTestConfig() {
  var props = PropertiesService.getScriptProperties();
  var token   = props.getProperty('META_WHATSAPP_TOKEN');
  var phoneId = props.getProperty('META_PHONE_ID');
  var verify  = props.getProperty('META_VERIFY_TOKEN');
  Logger.log('META_WHATSAPP_TOKEN: ' + (token  ? '✅ set ('+token.substring(0,20)+'…)' : '❌ MISSING'));
  Logger.log('META_PHONE_ID:       ' + (phoneId? '✅ ' + phoneId : '❌ MISSING'));
  Logger.log('META_VERIFY_TOKEN:   ' + (verify ? '✅ set' : '❌ MISSING'));
  if (!token || !phoneId) return;
  // Verificar el phone number existe
  var r = UrlFetchApp.fetch(META_GRAPH_BASE + '/' + phoneId, {
    headers: { 'Authorization': 'Bearer ' + token },
    muteHttpExceptions: true,
  });
  Logger.log('GET phone ' + r.getResponseCode() + ': ' + r.getContentText().substring(0, 400));
}

// ════════════════════════════════════════════════════════════════════
//  INTERACCIÓN — botones + listas Meta Cloud API
//
//  Al recibir una factura, el bot responde con 2 botones:
//    [ ✅ Aprobar ]  [ 📝 Cambiar categoría ]
//
//  Si el usuario tapea "Cambiar", mostramos una lista interactiva con
//  las categorías DGI agrupadas. Al elegir una, actualizamos el
//  pendiente y lo aprobamos en una sola acción.
//
//  Formato de IDs de botones/listas
//  ────────────────────────────────
//    "wa:apr:<pendId>"           — aprobar tal cual
//    "wa:cat:<pendId>"           — abrir lista de categorías
//    "wa:set:<pendId>:<key>"     — setear categoría y aprobar
// ════════════════════════════════════════════════════════════════════

// Catálogo de categorías para el list message — Meta limita a 10 FILAS
// TOTALES (no por sección). Mostramos solo las 10 más usadas; para
// categorías menos comunes, el usuario abre el web app desde el link
// del fallback / hint.
var WA_CAT_SECTIONS = [
  { title: 'Operativos comunes', rows: [
    { key: 'otros_deducibles',         title: 'Otro gasto deducible',     desc: 'L77 · catch-all operativo' },
    { key: 'alquileres',               title: 'Alquileres',               desc: 'L46 · local, oficina' },
    { key: 'combustible_transporte',   title: 'Combustible/transporte',   desc: 'L56' },
    { key: 'gastos_oficina',           title: 'Oficina/suministros',      desc: 'L69' },
    { key: 'nomina',                   title: 'Nómina / Salarios',        desc: 'L42' },
  ]},
  { title: 'Servicios', rows: [
    { key: 'servicios_publicos',       title: 'Agua, luz',                desc: 'L75' },
    { key: 'telecomunicaciones',       title: 'Internet, teléfono',       desc: 'L71' },
    { key: 'honorarios_profesionales', title: 'Honorarios profesionales', desc: 'L60' },
  ]},
  { title: 'Compras / Costos', rows: [
    { key: 'compras_locales',          title: 'Compras locales',          desc: 'L28 · costo venta' },
    { key: 'compras_importadas',       title: 'Compras importadas',       desc: 'L29 · costo venta' },
  ]},
];

// Diccionario plano para etiquetar una key cuando se muestra al usuario
function _waCatLabel(key) {
  for (var s = 0; s < WA_CAT_SECTIONS.length; s++) {
    var rows = WA_CAT_SECTIONS[s].rows;
    for (var r = 0; r < rows.length; r++) {
      if (rows[r].key === key) return rows[r].title;
    }
  }
  return key;
}

// ────────────────────────────────────────────────────────────────────
//  Envía un mensaje interactivo con 2 o 3 botones de respuesta
// ────────────────────────────────────────────────────────────────────
function _whatsappReplyBotones(to, bodyText, footerText, buttons, token, phoneId) {
  if (!to || !buttons || !buttons.length || !token || !phoneId) {
    Logger.log('_whatsappReplyBotones: faltan params');
    return;
  }
  var btns = buttons.slice(0, 3).map(function(b) {
    return { type: 'reply', reply: { id: String(b.id).substring(0, 256), title: String(b.title).substring(0, 20) } };
  });
  var payload = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'interactive',
    interactive: {
      type:   'button',
      body:   { text: String(bodyText || '').substring(0, 1024) },
      action: { buttons: btns },
    },
  };
  if (footerText) payload.interactive.footer = { text: String(footerText).substring(0, 60) };
  try {
    var r = UrlFetchApp.fetch(META_GRAPH_BASE + '/' + phoneId + '/messages', {
      method:             'post',
      contentType:        'application/json',
      headers:            { 'Authorization': 'Bearer ' + token },
      payload:            JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    if (r.getResponseCode() !== 200) {
      Logger.log('Reply botones falló ' + r.getResponseCode() + ': ' + r.getContentText().substring(0, 200));
    }
  } catch(err) { Logger.log('_whatsappReplyBotones ERROR: ' + err.message); }
}

// ────────────────────────────────────────────────────────────────────
//  Envía un mensaje interactivo con lista seleccionable
//  sections: [{ title: 'Sección', rows: [{ id, title, description }] }]
// ────────────────────────────────────────────────────────────────────
function _whatsappReplyLista(to, bodyText, listButtonText, sections, token, phoneId) {
  if (!to || !sections || !sections.length || !token || !phoneId) {
    Logger.log('_whatsappReplyLista: faltan params');
    return false;
  }
  var sec = sections.slice(0, 10).map(function(s) {
    return {
      title: String(s.title || '').substring(0, 24),
      rows: (s.rows || []).slice(0, 10).map(function(row) {
        var o = {
          id:    String(row.id).substring(0, 200),
          title: String(row.title || '').substring(0, 24),
        };
        if (row.description) o.description = String(row.description).substring(0, 72);
        return o;
      }),
    };
  });
  var payload = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'interactive',
    interactive: {
      type:   'list',
      body:   { text: String(bodyText || '').substring(0, 1024) },
      action: { button: String(listButtonText || 'Elegir').substring(0, 20), sections: sec },
    },
  };
  try {
    var r = UrlFetchApp.fetch(META_GRAPH_BASE + '/' + phoneId + '/messages', {
      method:             'post',
      contentType:        'application/json',
      headers:            { 'Authorization': 'Bearer ' + token },
      payload:            JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    var code = r.getResponseCode();
    if (code !== 200) {
      Logger.log('Reply lista FAIL ' + code + ': ' + r.getContentText().substring(0, 600));
      Logger.log('Payload enviado: ' + JSON.stringify(payload).substring(0, 600));
      return false;
    }
    return true;
  } catch(err) {
    Logger.log('_whatsappReplyLista ERROR: ' + err.message);
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────
//  Despacha respuestas interactivas (botón o lista)
// ────────────────────────────────────────────────────────────────────
function _whatsappOnInteractive(msg, from, token, phoneId) {
  var inter = msg.interactive || {};
  var id    = '';
  if (inter.type === 'button_reply') {
    id = (inter.button_reply || {}).id || '';
  } else if (inter.type === 'list_reply') {
    id = (inter.list_reply || {}).id || '';
  } else {
    Logger.log('Tipo interactivo desconocido: ' + inter.type);
    return;
  }
  Logger.log('Interactive id=' + id + ' from=' + from);

  // Formato: "wa:<accion>:<pendId>[:<key>]"
  var parts = String(id || '').split(':');
  if (parts[0] !== 'wa') {
    Logger.log('ID no es de WhatsApp callback: ' + id);
    return;
  }
  var accion = parts[1];
  var pendId = parts[2];
  if (accion === 'apr')      _whatsappOnAprobar(pendId, from, token, phoneId);
  else if (accion === 'cat') _whatsappOnCambiarCat(pendId, from, token, phoneId);
  else if (accion === 'set') _whatsappOnSetCat(pendId, parts[3] || '', from, token, phoneId);
  else Logger.log('Acción desconocida: ' + accion);
}

// ────────────────────────────────────────────────────────────────────
//  Acción: Aprobar el pendiente (mismo handler que la web app)
// ────────────────────────────────────────────────────────────────────
function _whatsappOnAprobar(pendId, from, token, phoneId) {
  if (!pendId) { _whatsappReply(from, '⚠️ ID inválido.', token, phoneId); return; }
  try {
    var res = _handleAprobarAcreedor({ id: pendId });
    var json = JSON.parse(res.getContent());
    if (!json.success) {
      _whatsappReply(from, '⚠️ No pude aprobar ' + pendId + ': ' + (json.error || 'error desconocido'), token, phoneId);
      return;
    }
    _whatsappReply(from, '✅ Aprobado y registrado en Egresos.\n' + pendId + ' → ' + (json.egreso_id || ''), token, phoneId);
  } catch(err) {
    _whatsappReply(from, '⚠️ Error aprobando: ' + err.message, token, phoneId);
  }
}

// ────────────────────────────────────────────────────────────────────
//  Acción: Abrir la lista de categorías para que el usuario elija
// ────────────────────────────────────────────────────────────────────
function _whatsappOnCambiarCat(pendId, from, token, phoneId) {
  if (!pendId) { _whatsappReply(from, '⚠️ ID inválido.', token, phoneId); return; }
  // Construir secciones con IDs que incluyan el pendId
  var sections = WA_CAT_SECTIONS.map(function(s) {
    return {
      title: s.title,
      rows: s.rows.map(function(r) {
        return { id: 'wa:set:' + pendId + ':' + r.key, title: r.title, description: r.desc };
      }),
    };
  });
  var ok = _whatsappReplyLista(from,
    'Elegí la categoría DGI correcta para ' + pendId + '.\n' +
    '(¿No está la que buscás? Abrí la app desde: ' + _whatsappFrontendUrl() + '#registroGastos)',
    'Ver categorías',
    sections, token, phoneId);
  // Si Meta rechaza el list message (p.ej. límites no documentados),
  // mandar un fallback de texto para que el usuario sepa qué hacer.
  if (!ok) {
    _whatsappReply(from,
      '⚠️ No pude mostrar la lista de categorías en WhatsApp.\n\n' +
      'Cambiá la categoría desde la app:\n' + _whatsappFrontendUrl() + '#registroGastos',
      token, phoneId);
  }
}

// ────────────────────────────────────────────────────────────────────
//  Acción: Setear categoría elegida + auto-aprobar
// ────────────────────────────────────────────────────────────────────
function _whatsappOnSetCat(pendId, nuevaKey, from, token, phoneId) {
  if (!pendId || !nuevaKey) { _whatsappReply(from, '⚠️ Datos inválidos.', token, phoneId); return; }
  try {
    // 1. Actualizar la categoría del pendiente
    var upd = _handleActualizarPendienteAcr({ id: pendId, categoria: nuevaKey });
    var updJson;
    try { updJson = JSON.parse(upd.getContent()); } catch(e) { updJson = { success: false, error: 'parse' }; }
    if (!updJson.success) {
      _whatsappReply(from, '⚠️ No pude actualizar la categoría: ' + (updJson.error || ''), token, phoneId);
      return;
    }
    // 2. Aprobar automáticamente con la nueva categoría
    var apr = _handleAprobarAcreedor({ id: pendId });
    var aprJson = JSON.parse(apr.getContent());
    if (!aprJson.success) {
      _whatsappReply(from, '⚠️ Categoría cambiada pero no pude aprobar: ' + (aprJson.error || ''), token, phoneId);
      return;
    }
    _whatsappReply(from,
      '✅ Categoría actualizada a "' + _waCatLabel(nuevaKey) + '" y aprobado.\n' +
      pendId + ' → ' + (aprJson.egreso_id || ''),
      token, phoneId);
  } catch(err) {
    _whatsappReply(from, '⚠️ Error: ' + err.message, token, phoneId);
  }
}

// ════════════════════════════════════════════════════════════════════
//  Diagnóstico — ejecutar desde el Apps Script editor para debuggear
//  el envío del list message sin necesidad de mirar Executions.
//
//  Pasos:
//    1. Editá la línea TEST_FROM y TEST_PENDID abajo con tu celular
//       (formato 507XXXXXXXX) y un PENDR válido del sheet.
//    2. Guardá el archivo.
//    3. Dropdown del botón Run → seleccionar `whatsappTestLista`.
//    4. Run → Ctrl+Enter (o View → Logs) para ver los Logger.log.
//
//  Si Meta rechaza el list, vas a ver el código + cuerpo exacto del
//  error + el payload enviado en los logs.
// ════════════════════════════════════════════════════════════════════
function whatsappTestLista() {
  var TEST_FROM   = '507TUCELULAR';            // ← cambiá por tu número
  var TEST_PENDID = 'PENDR-202605-0058';       // ← cambiá por un PENDR real

  var props   = PropertiesService.getScriptProperties();
  var token   = props.getProperty('META_WHATSAPP_TOKEN');
  var phoneId = props.getProperty('META_PHONE_ID');
  if (!token || !phoneId) { Logger.log('❌ Faltan META_WHATSAPP_TOKEN o META_PHONE_ID'); return; }
  if (TEST_FROM === '507TUCELULAR') { Logger.log('⚠️ Editá TEST_FROM con tu celular real antes de correr'); return; }

  Logger.log('▶ Llamando _whatsappOnCambiarCat con pendId=' + TEST_PENDID + ' from=' + TEST_FROM);
  _whatsappOnCambiarCat(TEST_PENDID, TEST_FROM, token, phoneId);
  Logger.log('✅ Función terminó. Revisá los logs arriba para ver el resultado del envío.');
}
