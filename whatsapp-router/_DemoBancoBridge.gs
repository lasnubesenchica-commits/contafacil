// ════════════════════════════════════════════════════════════════════
//  _DemoBancoBridge.gs
//  ──────────────────────────────────────────────────────────────────
//  Vive solo en el proyecto del ROUTER. Provee los helpers que
//  ContaFacil_Banco.gs (importado al router via deploy-gas) necesita
//  para correr en modo DEMO sin depender de los otros archivos del
//  backend (Code.js, ContaFacil_WhatsApp.gs, etc.).
//
//  Provee:
//    - CONFIG stub (con SHEET_ID vacío — el módulo banco en modo
//      DEMO nunca lo lee porque _bancoEsDemo() retorna true).
//    - _whatsappReply / _whatsappReplyLista — alias hacia las
//      funciones equivalentes del router.
//    - _whatsappDescargarMedia — copia exacta del backend para
//      bajar el blob del xlsx desde Meta CDN.
//
//  El router llama a _bancoProcesarMovimientos() directo cuando un
//  visitante (no en CLIENTS_MAP_JSON) sube xlsx — sin HTTP roundtrip.
// ════════════════════════════════════════════════════════════════════

// CONFIG stub para que ContaFacil_Banco.gs no tire ReferenceError.
// En modo DEMO nunca se accede a SHEET_ID (la persistencia se skippea).
var CONFIG = { SHEET_ID: '' };

// Alias: el bank module usa _whatsappReply, el router tiene _routerSendText.
// Mismo contrato (to, body, token, phoneId).
function _whatsappReply(to, text, token, phoneId) {
  _routerSendText(to, text, token, phoneId);
}

// Lista interactiva — port directo del backend (mismas reglas de Meta:
// max 10 secciones, max 10 rows, titles cap 24 chars, descripciones 72).
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
    if (r.getResponseCode() !== 200) {
      Logger.log('_whatsappReplyLista HTTP ' + r.getResponseCode() + ': ' + r.getContentText().substring(0, 200));
    }
    return r.getResponseCode() === 200;
  } catch(err) {
    Logger.log('_whatsappReplyLista ERROR: ' + err.message);
    return false;
  }
}

// Descarga el blob de un media (xlsx) desde Meta CDN.
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

// ════════════════════════════════════════════════════════════════════
//  DOCTOR — verifica permisos del router
//  ──────────────────────────────────────────────────────────────────
//  Ejecutar UNA VEZ desde el editor de Apps Script del router después
//  de cada deploy que agregue scopes nuevos. Toca todos los servicios
//  que el router usa para que Apps Script dispare el OAuth dialog
//  con TODOS los permisos a aprobar en una sola pasada.
//
//  Reporta OK/FAIL por servicio en el Log (View → Executions o Ctrl+Enter).
//  Si algo marca FAIL, el mensaje incluye el error exacto.
// ════════════════════════════════════════════════════════════════════

function _routerVerificarPermisos() {
  var results = [];
  var addOK   = function(s) { results.push('✓ ' + s); Logger.log('✓ ' + s); };
  var addFail = function(s, e) { var m = '✗ ' + s + ' — ' + (e && e.message ? e.message : e); results.push(m); Logger.log(m); };

  // 1. PropertiesService
  try { PropertiesService.getScriptProperties().getKeys(); addOK('PropertiesService'); }
  catch(e) { addFail('PropertiesService', e); }

  // 2. UrlFetchApp (ping a graph.facebook.com sin body, expect 4xx OK)
  try { UrlFetchApp.fetch('https://graph.facebook.com', { muteHttpExceptions: true }); addOK('UrlFetchApp (HTTP externo)'); }
  catch(e) { addFail('UrlFetchApp', e); }

  // 3. GmailApp — listar labels (no consume cuota material)
  try { GmailApp.getUserLabels().length; addOK('GmailApp (read inbox/labels)'); }
  catch(e) { addFail('GmailApp', e); }

  // 4. Advanced Gmail Service — needed for delete permanente
  try {
    if (typeof Gmail === 'undefined' || !Gmail || !Gmail.Users || !Gmail.Users.Labels) {
      throw new Error('Gmail advanced service NO habilitado (revisar appsscript.json dependencies)');
    }
    Gmail.Users.Labels.list('me');
    addOK('Gmail Advanced (delete permanente)');
  } catch(e) { addFail('Gmail Advanced', e); }

  // 5. ScriptApp — leer triggers existentes
  try { ScriptApp.getProjectTriggers().length; addOK('ScriptApp (triggers)'); }
  catch(e) { addFail('ScriptApp', e); }

  // 6. CacheService — set + get + remove
  try {
    var c = CacheService.getScriptCache();
    c.put('_doctor_ping', '1', 60);
    if (c.get('_doctor_ping') !== '1') throw new Error('get devolvió valor inesperado');
    c.remove('_doctor_ping');
    addOK('CacheService');
  } catch(e) { addFail('CacheService', e); }

  // 7. SpreadsheetApp + DriveApp (genera + trashes un sheet temp tipo el Excel export)
  try {
    var ss = SpreadsheetApp.create('_doctor_ping_' + Date.now());
    var id = ss.getId();
    DriveApp.getFileById(id).setTrashed(true);
    addOK('SpreadsheetApp + DriveApp (Excel export)');
  } catch(e) { addFail('SpreadsheetApp + DriveApp', e); }

  // 8. Properties IS_DEMO check (informativo, no es permiso)
  var isDemo = PropertiesService.getScriptProperties().getProperty('IS_DEMO');
  if (isDemo === 'true') addOK('IS_DEMO = true (modo demo activo para visitantes)');
  else addFail('IS_DEMO no configurado', new Error('Falta Script Property: IS_DEMO=true'));

  Logger.log('\n──────────── RESUMEN ────────────');
  results.forEach(function(r) { Logger.log(r); });
  return results;
}

