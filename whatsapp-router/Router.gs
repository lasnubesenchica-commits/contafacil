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
//    4. Apuntar el Webhook Callback URL de Meta a este deployment URL.
//    5. Probar con routerTestConfig() desde el editor.
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
    if (data && data.object === 'whatsapp_business_account') {
      return _routerHandleWebhook(data);
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

  var map = _routerGetClientsMap();
  var clientUrl = map[from];

  if (!clientUrl) {
    Logger.log('Numero no reconocido: ' + from);
    _routerReplyDesconocido(from, metadata);
    return;
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

function _routerGetClientsMap() {
  var json = PropertiesService.getScriptProperties().getProperty('CLIENTS_MAP_JSON') || '{}';
  try { return JSON.parse(json); }
  catch(err) { Logger.log('CLIENTS_MAP_JSON inválido: ' + err.message); return {}; }
}

// ────────────────────────────────────────────────────────────────────
//  Responder a número no registrado en el mapa
// ────────────────────────────────────────────────────────────────────
function _routerReplyDesconocido(to, metadata) {
  var props   = PropertiesService.getScriptProperties();
  var token   = props.getProperty('META_WHATSAPP_TOKEN');
  var phoneId = props.getProperty('META_PHONE_ID') || (metadata.phone_number_id || '');
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
        text: { body: '👋 ¡Hola! No reconozco tu número en BalanceClip. Si querés registrar facturas vía WhatsApp, contactá a tu administrador para que te dé acceso.' },
      }),
      muteHttpExceptions: true,
    });
  } catch(err) {
    Logger.log('Reply desconocido ERROR: ' + err.message);
  }
}

// ────────────────────────────────────────────────────────────────────
//  Diagnóstico — ejecutar desde el editor para validar config
// ────────────────────────────────────────────────────────────────────
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
