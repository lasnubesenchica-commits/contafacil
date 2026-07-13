/**
 * Aires de Chicá — Sistema de estados de cuenta y cobros de mantenimiento.
 * Router principal (doGet / doPost). Un proyecto Apps Script por comunidad.
 *
 * Lecturas  (JSONP, doGet):   ping, getDashboard, getEstadoCuenta, getPropietarios
 * Escrituras (fetch, doPost):  seedInicial, ensureSheets, registrarPago,
 *                              conciliarBanco, consolidarPagos, enviarEstado,
 *                              enviarRecordatorios
 *
 * Convención: UI en español, código/comentarios en inglés/español mezclado
 * (igual que el resto del stack BalanceClip).
 */

var CONFIG = {
  NEGOCIO:        'Aires de Chicá',
  RAZON_SOCIAL:   'Aires de Chica, S.A.',
  // Si se deja vacío y el script está ligado a un Sheet, usa el Sheet activo.
  SHEET_ID:       '1S-mea6zy87PwYFuwtbb4hqHX8LaK7sHW4zqX5kk2_4E',
  ADMIN_EMAIL:    'admin@airesdechica.org',
  REPLY_TO:       'admin@airesdechica.org',
  // Logo servido desde GitHub Pages (se puede sobreescribir con una URL propia).
  LOGO_URL:       'https://balanceclip.net/aires-de-chica/brand/logo.svg',
  LOGO_PNG_URL:   'https://balanceclip.net/aires-de-chica/brand/logo.png',

  // Datos de cobro
  BANCO:          'Banco General',
  CUENTA_TIPO:    'Cuenta de ahorros',
  CUENTA_NUM:     '04-02-98-706290-3',
  CUENTA_NOMBRE:  'Aires de Chica, S.A.',

  // Reglas de la cuota (confirmadas con el cliente)
  CUOTA_BASE:     45.00,   // B/. por lote / mes
  CABANA_FEE:     13.50,   // B/. por cabaña / mes
  MORA_PCT:       0.10,    // 10% mensual
  MORA_DESDE:     '2026-04', // primera cuota que genera mora (abril 2026)
  DUE_DAY:        0,       // 0 = vence fin de mes; la mora corre el mes siguiente
  ANIO_ACTUAL:    2026,
  MONEDA:         'B/.',
  TZ:             'America/Panama'
};

var AC_MESES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
var AC_MESES_LARGO = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio',
                      'Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

/* ─────────────────────────── Router ─────────────────────────── */

function doGet(e) {
  var p = (e && e.parameter) || {};
  var action = p.action || 'ping';
  var out;
  try {
    if (action === 'ping')           out = { ok: true, negocio: CONFIG.NEGOCIO, ts: new Date().toISOString() };
    else if (action === 'getDashboard')    out = { ok: true, data: buildDashboard(p.asOf || null) };
    else if (action === 'getPropietarios') out = { ok: true, data: getPropietarios() };
    else if (action === 'getEstadoCuenta') out = { ok: true, data: getEstadoCuentaByKey(p.clave) };
    else out = { ok: false, error: 'accion desconocida: ' + action };
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return _reply(out, p.callback);
}

function doPost(e) {
  var data = {};
  try { data = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (x) {}
  var action = data.action || '';
  var out;
  try {
    if (action === 'ensureSheets')          out = { ok: true, data: ensureSheets() };
    else if (action === 'seedInicial')      out = { ok: true, data: seedInicial(!!data.force) };
    else if (action === 'registrarPago')    out = { ok: true, data: registrarPago(data.pago) };
    else if (action === 'conciliarBanco')   out = { ok: true, data: conciliarBanco(data.rows, data.filename) };
    else if (action === 'consolidarPagos')  out = { ok: true, data: consolidarPagos(data.pagos, !!data.enviarCorreos) };
    else if (action === 'enviarEstado')     out = { ok: true, data: enviarEstadoCuenta(data.clave) };
    else if (action === 'enviarRecordatorios') out = { ok: true, data: enviarRecordatorios(data.tipo, data.claves || null) };
    else out = { ok: false, error: 'accion desconocida: ' + action };
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err), stack: String(err && err.stack || '') };
  }
  return _reply(out, null);
}

/* ─────────────────────────── Helpers ─────────────────────────── */

function _reply(obj, callback) {
  var json = JSON.stringify(obj);
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

function _ss() {
  if (CONFIG.SHEET_ID) return SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  throw new Error('No hay SHEET_ID configurado y el script no está ligado a un Sheet.');
}

function _money(n) {
  n = Number(n) || 0;
  return CONFIG.MONEDA + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function _today() { return new Date(); }
