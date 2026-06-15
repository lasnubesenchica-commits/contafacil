// ═══════════════════════════════════════════════════════════════
//  ContaFacil_FlujoCxC — Control de Cuentas por Cobrar y flujo de caja
//
//  Sirve de backend al dashboard "Flujo CXC". Almacena las órdenes de
//  compra / facturas del cliente en una pestaña `Flujo_CXC` de su propia
//  hoja (CONFIG.SHEET_ID) para que el control sea compartido (la usuaria
//  edita; sus jefes lo ven con el mismo enlace).
//
//  Modelo de cada fila (controlado por la usuaria, regla 5):
//    Orden → Facturado → Abonado → Pagado
//  El vencimiento se calcula en el frontend a 60 días de la fecha de
//  factura (reglas 1 y 2). El backend sólo persiste el estado crudo.
//
//  Endpoints:
//   - getFlujoCxc  (GET / JSONP)  → { success, rows:[...], linea }
//   - saveFlujoCxc (POST)         → { success, saved }
//       body: { action, rows:[{po,inv,fInv,monto,estado,fPago,abonado}], linea }
//
//  La "línea de crédito" se guarda en Script Properties (FLUJO_LINEA)
//  porque es un único escalar por instalación.
// ═══════════════════════════════════════════════════════════════

var FLUJO_SHEET        = 'Flujo_CXC';
var FLUJO_LINEA_KEY    = 'FLUJO_LINEA';
var FLUJO_DEFAULT_LINEA = 70000;
var FLUJO_HEADER = ['orden_compra', 'factura', 'fecha_factura', 'monto',
                    'estado', 'fecha_pago', 'abonado', 'actualizado'];

function _flujoJsonp(obj, callback) {
  var json = JSON.stringify(obj);
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function _flujoJson(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Obtiene (o crea) la pestaña Flujo_CXC en la hoja del cliente.
function _flujoSheet() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sh = ss.getSheetByName(FLUJO_SHEET);
  if (!sh) {
    sh = ss.insertSheet(FLUJO_SHEET);
    sh.getRange(1, 1, 1, FLUJO_HEADER.length).setValues([FLUJO_HEADER]).setFontWeight('bold');
    sh.setFrozenRows(1);
    // La columna fecha se guarda como texto yyyy-mm-dd para evitar
    // reinterpretaciones de zona horaria por parte de Sheets.
    sh.getRange(2, 3, sh.getMaxRows() - 1, 1).setNumberFormat('@');
    sh.getRange(2, 6, sh.getMaxRows() - 1, 1).setNumberFormat('@');
  }
  return sh;
}

function _flujoDateStr(v) {
  if (v instanceof Date) {
    var y = v.getFullYear();
    var m = ('0' + (v.getMonth() + 1)).slice(-2);
    var d = ('0' + v.getDate()).slice(-2);
    return y + '-' + m + '-' + d;
  }
  return String(v == null ? '' : v).trim();
}

function _flujoGetLinea() {
  var raw = PropertiesService.getScriptProperties().getProperty(FLUJO_LINEA_KEY);
  var n = parseFloat(raw);
  return isNaN(n) ? FLUJO_DEFAULT_LINEA : n;
}

// ── GET: devuelve todas las filas + la línea de crédito ──────────
function _handleGetFlujoCxc(params, callback) {
  try {
    var sh = _flujoSheet();
    var rows = [];
    var last = sh.getLastRow();
    if (last > 1) {
      var vals = sh.getRange(2, 1, last - 1, FLUJO_HEADER.length).getValues();
      for (var i = 0; i < vals.length; i++) {
        var r = vals[i];
        var empty = String(r[0] || '') === '' && String(r[1] || '') === '' &&
                    !r[3] && String(r[2] || '') === '';
        if (empty) continue;
        rows.push({
          po:      String(r[0] || ''),
          inv:     String(r[1] || ''),
          fInv:    _flujoDateStr(r[2]),
          monto:   parseFloat(r[3]) || 0,
          estado:  String(r[4] || 'orden'),
          fPago:   _flujoDateStr(r[5]),
          abonado: parseFloat(r[6]) || 0
        });
      }
    }
    return _flujoJsonp({ success: true, rows: rows, linea: _flujoGetLinea() }, callback);
  } catch (err) {
    return _flujoJsonp({ success: false, error: String(err && err.message || err) }, callback);
  }
}

// ── POST: reemplaza el documento completo (filas + línea) ───────
function _handleSaveFlujoCxc(data) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (e) {
    return _flujoJson({ success: false, error: 'Servidor ocupado, reintenta' });
  }
  try {
    var rows = (data && data.rows) || [];
    if (data && data.linea != null && !isNaN(parseFloat(data.linea))) {
      PropertiesService.getScriptProperties()
        .setProperty(FLUJO_LINEA_KEY, String(parseFloat(data.linea)));
    }
    var sh   = _flujoSheet();
    var last = sh.getLastRow();
    if (last > 1) {
      sh.getRange(2, 1, last - 1, FLUJO_HEADER.length).clearContent();
    }
    if (rows.length) {
      var now = new Date();
      var out = rows.map(function (r) {
        return [
          String(r.po || ''),
          String(r.inv || ''),
          _flujoDateStr(r.fInv),
          parseFloat(r.monto) || 0,
          String(r.estado || 'orden'),
          _flujoDateStr(r.fPago),
          parseFloat(r.abonado) || 0,
          now
        ];
      });
      sh.getRange(2, 1, out.length, FLUJO_HEADER.length).setValues(out);
    }
    return _flujoJson({ success: true, saved: rows.length });
  } catch (err) {
    return _flujoJson({ success: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}
