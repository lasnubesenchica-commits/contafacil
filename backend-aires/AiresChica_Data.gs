/**
 * Capa de datos — pestañas del Google Sheet y carga inicial.
 *
 * Pestañas:
 *   Propietarios : maestro de cuentas (una fila por cuenta; clave única)
 *   Pagos        : libro de pagos recibidos (ledger, una fila por pago)
 *   ConciliacionLog : historial de estados de cuenta bancarios importados
 *
 * `clave` = identificador único de cuenta (residencial + lote), p.ej. "H-22".
 * Los números de lote se repiten entre residenciales (y sub-bloques de
 * Los Laureles), por eso la clave lleva el prefijo del residencial.
 */

var SH = {
  PROP:  'Propietarios',
  PAGOS: 'Pagos',
  LOG:   'ConciliacionLog'
};

var COL_PROP  = ['clave','residencial','lote','loteNum','nombre','email','celular',
                 'lotes','cabanas','cuota','saldo2025','activo','notas'];
var COL_PAGOS = ['id','fecha','clave','lote','nombre','monto','referencia','origen',
                 'mesAplicado','notas','creado'];
var COL_LOG   = ['fecha','archivo','filas','nuevos','duplicados','montoNuevo','usuario'];

/* ─────────────── setup de pestañas ─────────────── */

function ensureSheets() {
  var ss = _ss();
  var created = [];
  [[SH.PROP, COL_PROP], [SH.PAGOS, COL_PAGOS], [SH.LOG, COL_LOG]].forEach(function (pair) {
    var name = pair[0], cols = pair[1];
    var sh = ss.getSheetByName(name);
    if (!sh) { sh = ss.insertSheet(name); created.push(name); }
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, cols.length).setValues([cols]);
      sh.getRange(1, 1, 1, cols.length).setFontWeight('bold')
        .setBackground('#0E8FB0').setFontColor('#ffffff');
      sh.setFrozenRows(1);
    }
  });
  ['Hoja 1', 'Hoja1', 'Sheet1'].forEach(function (n) {
    var s = ss.getSheetByName(n);
    if (s && ss.getSheets().length > 1 && s.getLastRow() <= 1) { try { ss.deleteSheet(s); } catch (e) {} }
  });
  return { created: created, sheets: ss.getSheets().map(function (s) { return s.getName(); }) };
}

function _sheetRows(name) {
  var ss = _ss();
  var sh = ss.getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  var values = sh.getDataRange().getValues();
  var header = values[0].map(function (h) { return String(h).trim(); });
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (row.join('') === '') continue;
    var obj = {};
    header.forEach(function (h, c) { obj[h] = row[c]; });
    out.push(obj);
  }
  return out;
}

/* ─────────────── getters ─────────────── */

function getPropietarios() {
  return _sheetRows(SH.PROP).map(function (p) {
    p.clave    = String(p.clave || '').trim();
    p.lote     = String(p.lote).trim();
    p.loteNum  = String(p.loteNum || p.lote).trim().toUpperCase().replace(/\s/g, '');
    p.lotes    = Number(p.lotes) || 1;
    p.cabanas  = Number(p.cabanas) || 0;
    p.cuota    = Number(p.cuota) || (p.lotes * CONFIG.CUOTA_BASE + p.cabanas * CONFIG.CABANA_FEE);
    p.saldo2025 = Number(p.saldo2025) || 0;
    p.activo   = !(String(p.activo).toLowerCase() === 'no' || p.activo === false);
    p.email    = String(p.email || '').trim();
    return p;
  }).filter(function (p) { return p.clave && p.activo; });
}

function getPagos() {
  return _sheetRows(SH.PAGOS).map(function (p) {
    p.clave = String(p.clave || '').trim();
    p.lote  = String(p.lote || '').trim();
    p.monto = Number(p.monto) || 0;
    p.fecha = p.fecha instanceof Date ? p.fecha : new Date(p.fecha);
    return p;
  });
}

function getPagosByClave(clave) {
  clave = String(clave).trim();
  return getPagos().filter(function (p) { return p.clave === clave; });
}

function _findProp(clave) {
  clave = String(clave).trim();
  var all = getPropietarios();
  for (var i = 0; i < all.length; i++) if (all[i].clave === clave) return all[i];
  return null;
}

/* ─────────────── escritura ─────────────── */

function appendPago(pago) {
  var ss = _ss();
  var sh = ss.getSheetByName(SH.PAGOS);
  if (!sh) { ensureSheets(); sh = ss.getSheetByName(SH.PAGOS); }
  var prop = pago.clave ? _findProp(pago.clave) : null;
  var id = pago.id || ('P' + new Date().getTime() + '-' + Math.floor(Math.random() * 1000));
  sh.appendRow([
    id,
    pago.fecha instanceof Date ? pago.fecha : new Date(pago.fecha || _today()),
    String(pago.clave || '').trim(),
    pago.lote || (prop ? prop.lote : ''),
    pago.nombre || (prop ? prop.nombre : ''),
    _round2(pago.monto),
    pago.referencia || '',
    pago.origen || 'manual',
    pago.mesAplicado || '',
    pago.notas || '',
    new Date()
  ]);
  return id;
}

function registrarPago(pago) {
  if (!pago || !pago.clave || !(Number(pago.monto) > 0)) {
    throw new Error('Pago inválido (falta clave de cuenta o monto).');
  }
  var id = appendPago(pago);
  var prop = _findProp(pago.clave);
  var resultado = { id: id, clave: pago.clave };
  if (pago.enviarCorreo && prop && prop.email) {
    try { resultado.correo = enviarEstadoCuenta(pago.clave); }
    catch (e) { resultado.correoError = String(e); }
  }
  return resultado;
}

/* ─────────────── carga inicial (seed) ─────────────── */

function seedInicial(force) {
  ensureSheets();
  var ss = _ss();
  var shP = ss.getSheetByName(SH.PROP);
  var shPagos = ss.getSheetByName(SH.PAGOS);

  if (shP.getLastRow() > 1 && !force) {
    return { skipped: true, motivo: 'Ya existen propietarios. Usa force:true para recargar.' };
  }
  if (force) {
    if (shP.getLastRow() > 1) shP.deleteRows(2, shP.getLastRow() - 1);
    if (shPagos.getLastRow() > 1) shPagos.deleteRows(2, shPagos.getLastRow() - 1);
  }

  var filasProp = AC_SEED.map(function (s) {
    return [s.clave, s.residencial, s.lote, s.loteNum, s.nombre, s.email, s.celular,
            s.lotes, s.cabanas, _round2(s.cuota), _round2(s.saldo2025), 'si', s.notas || ''];
  });
  shP.getRange(2, 1, filasProp.length, COL_PROP.length).setValues(filasProp);

  // Pagos: expande el histórico mensual 2026 (una fila por mes con monto>0)
  var filasPago = [], year = CONFIG.ANIO_ACTUAL;
  AC_SEED.forEach(function (s) {
    (s.pagos || []).forEach(function (monto, idx) {
      if (Number(monto) > 0) {
        filasPago.push(['SEED-' + s.clave + '-' + AC_MESES[idx], new Date(year, idx, 15),
          s.clave, s.lote, s.nombre, _round2(monto), '', 'carga-inicial',
          AC_MESES[idx] + ' ' + year, 'Histórico ' + AC_MESES[idx], new Date()]);
      }
    });
  });
  if (filasPago.length) {
    shPagos.getRange(2, 1, filasPago.length, COL_PAGOS.length).setValues(filasPago);
  }
  return { propietarios: filasProp.length, pagos: filasPago.length };
}
