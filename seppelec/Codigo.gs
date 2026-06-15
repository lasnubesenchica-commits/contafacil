/* ═══════════════════════════════════════════════════════════════
   SEPPELEC · Flujo CxC — Backend STANDALONE (Google Apps Script)

   Sistema independiente: NO forma parte de BalanceClip/ContaFacil, no
   usa clients.json ni el provisioner. Es su propio proyecto Apps Script
   ligado a su propia Hoja de cálculo.

   ── Instalación (una sola vez) ──────────────────────────────────
   1. Crea una Hoja de cálculo de Google nueva (será la base de datos).
   2. En esa hoja: Extensiones → Apps Script.
   3. Borra el contenido y pega TODO este archivo. Guarda.
   4. Implementar → Nueva implementación → Tipo: Aplicación web.
        - Ejecutar como:  Yo
        - Quién tiene acceso:  Cualquier persona
      Copia la URL /exec que te da.
   5. Pega esa URL en seppelec/index.html → const GAS_URL = '...'.

   La pestaña "Flujo_CXC" y la contraseña se crean solas.
   ═══════════════════════════════════════════════════════════════ */

var FLUJO_SHEET     = 'Flujo_CXC';
var LINEA_KEY       = 'FLUJO_LINEA';
var PW_KEY          = 'FLUJO_PW_HASH';
var DEFAULT_LINEA   = 70000;
var HEADER = ['orden_compra', 'factura', 'fecha_factura', 'monto',
              'estado', 'fecha_pago', 'abonado', 'actualizado'];

// ── Router ──────────────────────────────────────────────────────
function doGet(e) {
  var params   = (e && e.parameter) || {};
  var action   = params.action || '';
  var callback = params.callback || '';
  try {
    if (action === 'getFlujoCxc')  return _getFlujo(callback);
    if (action === 'getAuthState') return _jsonp({ success: true, hasPassword: _hasPw() }, callback);
    return _jsonp({ success: false, error: 'accion desconocida: ' + action }, callback);
  } catch (err) {
    return _jsonp({ success: false, error: String(err && err.message || err) }, callback);
  }
}

function doPost(e) {
  try {
    var data   = JSON.parse(e.postData.contents);
    var action = data.action || '';
    if (action === 'saveFlujoCxc')   return _saveFlujo(data);
    if (action === 'verifyPassword') return _json({ success: true, valid: _checkPw(data.password) });
    if (action === 'setPassword')    return _setPw(data);
    return _json({ success: false, error: 'accion desconocida: ' + action });
  } catch (err) {
    return _json({ success: false, error: String(err && err.message || err) });
  }
}

// ── Salidas ─────────────────────────────────────────────────────
function _jsonp(obj, callback) {
  var s = JSON.stringify(obj);
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + s + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.JSON);
}
function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Hoja ────────────────────────────────────────────────────────
function _sheet() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(FLUJO_SHEET);
  if (!sh) {
    sh = ss.insertSheet(FLUJO_SHEET);
    sh.getRange(1, 1, 1, HEADER.length).setValues([HEADER]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(2, 3, sh.getMaxRows() - 1, 1).setNumberFormat('@'); // fecha_factura como texto
    sh.getRange(2, 6, sh.getMaxRows() - 1, 1).setNumberFormat('@'); // fecha_pago como texto
  }
  return sh;
}
function _dateStr(v) {
  if (v instanceof Date) {
    return v.getFullYear() + '-' + ('0' + (v.getMonth() + 1)).slice(-2) + '-' + ('0' + v.getDate()).slice(-2);
  }
  return String(v == null ? '' : v).trim();
}
function _linea() {
  var n = parseFloat(PropertiesService.getScriptProperties().getProperty(LINEA_KEY));
  return isNaN(n) ? DEFAULT_LINEA : n;
}

// ── GET datos ───────────────────────────────────────────────────
function _getFlujo(callback) {
  var sh = _sheet();
  var rows = [];
  var last = sh.getLastRow();
  if (last > 1) {
    var vals = sh.getRange(2, 1, last - 1, HEADER.length).getValues();
    for (var i = 0; i < vals.length; i++) {
      var r = vals[i];
      if (String(r[0] || '') === '' && String(r[1] || '') === '' && !r[3] && String(r[2] || '') === '') continue;
      rows.push({
        po: String(r[0] || ''), inv: String(r[1] || ''), fInv: _dateStr(r[2]),
        monto: parseFloat(r[3]) || 0, estado: String(r[4] || 'orden'),
        fPago: _dateStr(r[5]), abonado: parseFloat(r[6]) || 0
      });
    }
  }
  return _jsonp({ success: true, rows: rows, linea: _linea() }, callback);
}

// ── POST guardar (reemplaza el documento completo) ──────────────
function _saveFlujo(data) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { return _json({ success: false, error: 'ocupado' }); }
  try {
    var rows = (data && data.rows) || [];
    if (data && data.linea != null && !isNaN(parseFloat(data.linea))) {
      PropertiesService.getScriptProperties().setProperty(LINEA_KEY, String(parseFloat(data.linea)));
    }
    var sh = _sheet();
    var last = sh.getLastRow();
    if (last > 1) sh.getRange(2, 1, last - 1, HEADER.length).clearContent();
    if (rows.length) {
      var now = new Date();
      var out = rows.map(function (r) {
        return [String(r.po || ''), String(r.inv || ''), _dateStr(r.fInv),
                parseFloat(r.monto) || 0, String(r.estado || 'orden'),
                _dateStr(r.fPago), parseFloat(r.abonado) || 0, now];
      });
      sh.getRange(2, 1, out.length, HEADER.length).setValues(out);
    }
    return _json({ success: true, saved: rows.length });
  } catch (err) {
    return _json({ success: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

// ── Contraseña de edición (los jefes ven sin ella) ──────────────
function _hash(pwd) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(pwd || ''), Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = (bytes[i] + 256) % 256;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}
function _hasPw() {
  return String(PropertiesService.getScriptProperties().getProperty(PW_KEY) || '') !== '';
}
function _checkPw(pwd) {
  var stored = String(PropertiesService.getScriptProperties().getProperty(PW_KEY) || '');
  return stored !== '' && _hash(pwd) === stored;
}
function _setPw(data) {
  var props   = PropertiesService.getScriptProperties();
  var current = String(props.getProperty(PW_KEY) || '');
  // Si ya hay contraseña, exige la actual para cambiarla.
  if (current !== '') {
    if (!data.currentPassword || _hash(data.currentPassword) !== current) {
      return _json({ success: false, error: 'Contraseña actual incorrecta' });
    }
  }
  if (!data.password) return _json({ success: false, error: 'Falta la nueva contraseña' });
  props.setProperty(PW_KEY, _hash(data.password));
  return _json({ success: true });
}
