/**
 * Conciliación bancaria — lee el estado de cuenta de Banco General
 * (export "BGRExcelContReport") y detecta los pagos entrantes nuevos.
 *
 * El frontend convierte el .xlsx a una matriz de filas (SheetJS) y la envía
 * a `conciliarBanco`. Aquí:
 *   1. localizamos el encabezado (Fecha | Referencia | Transacción | Descripción | Débito | Crédito | Saldo)
 *   2. tomamos las filas con Crédito (pagos entrantes); los Débitos son gastos
 *   3. de la descripción extraemos "lote X", el nombre del pagador y el monto
 *   4. cotejamos contra Propietarios (por lote y por nombre)
 *   5. descartamos duplicados contra los Pagos ya registrados
 *   6. devolvemos una vista previa para revisar y confirmar
 */

function _normTxt(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

var _STOP = { 'DE': 1, 'DEL': 1, 'LA': 1, 'LAS': 1, 'LOS': 1, 'EL': 1, 'Y': 1, 'O': 1,
  'MANT': 1, 'MANTENIMIENTO': 1, 'CUOTA': 1, 'PAGO': 1, 'LOTE': 1, 'AREAS': 1, 'MOVIL': 1,
  'BANCA': 1, 'LINEA': 1, 'TRANSFERENCIA': 1, 'ACH': 1, 'XPRESS': 1, 'DEPOSITO': 1, 'CUENTA': 1,
  'AHORROS': 1, 'SIN': 1, 'LIBRETA': 1, 'CHICA': 1, 'ABRIL': 1, 'MAYO': 1, 'JUNIO': 1, 'JULIO': 1 };

function _tokens(s) {
  return _normTxt(s).split(' ').filter(function (t) { return t.length > 2 && !_STOP[t]; });
}

// firma para deduplicar un pago
function _sigPago(fechaISO, monto, lote) {
  return fechaISO + '|' + _round2(monto).toFixed(2) + '|' + String(lote || '').toUpperCase();
}

/**
 * @param {Array<Array>} rows  matriz cruda del xlsx
 * @param {string} filename
 */
function conciliarBanco(rows, filename) {
  if (!rows || !rows.length) throw new Error('No se recibieron filas del archivo.');

  // 1) localizar encabezado
  var hIdx = -1, col = {};
  for (var i = 0; i < Math.min(rows.length, 15); i++) {
    var r = (rows[i] || []).map(function (c) { return _normTxt(c); });
    if (r.indexOf('FECHA') !== -1 && (r.indexOf('CREDITO') !== -1 || r.indexOf('DEBITO') !== -1)) {
      hIdx = i;
      r.forEach(function (c, j) {
        if (c === 'FECHA') col.fecha = j;
        else if (c.indexOf('REFERENCIA') === 0) col.ref = j;
        else if (c.indexOf('TRANSACC') === 0) col.trx = j;
        else if (c.indexOf('DESCRIP') === 0) col.desc = j;
        else if (c === 'DEBITO') col.debito = j;
        else if (c === 'CREDITO') col.credito = j;
        else if (c.indexOf('SALDO') === 0) col.saldo = j;
      });
      break;
    }
  }
  if (hIdx === -1) throw new Error('No se reconoció el formato del estado de cuenta (falta encabezado Fecha/Crédito).');

  // propietarios + índice por número de lote (puede haber varios candidatos:
  // los números se repiten entre residenciales / sub-bloques)
  var props = getPropietarios();
  var byLoteNum = {};
  props.forEach(function (p) {
    String(p.lote).split(/[\/y]/i).forEach(function (tok) {
      var m = String(tok).match(/([0-9]+\s*[A-Za-z]?)/);
      if (!m) return;
      var k = m[1].replace(/\s/g, '').toUpperCase();
      (byLoteNum[k] = byLoteNum[k] || []).push(p);
    });
  });

  // firmas de pagos ya registrados (para deduplicar por clave+fecha+monto)
  var existentes = {};
  getPagos().forEach(function (p) {
    var f = Utilities.formatDate(new Date(p.fecha), CONFIG.TZ, 'yyyy-MM-dd');
    existentes[_sigPago(f, p.monto, p.clave)] = true;
  });

  var pagos = [], gastos = [], ignorados = [], duplicados = 0;

  for (var k = hIdx + 1; k < rows.length; k++) {
    var row = rows[k] || [];
    var desc = String(row[col.desc] || '').trim();
    var credito = _num(row[col.credito]);
    var debito = _num(row[col.debito]);
    var fecha = _parseFecha(row[col.fecha]);
    if (!fecha) continue;
    var fechaISO = Utilities.formatDate(fecha, CONFIG.TZ, 'yyyy-MM-dd');
    var ref = String(row[col.ref] || '').trim();

    if (debito > 0 && !(credito > 0)) {
      gastos.push({ fecha: fechaISO, descripcion: desc, monto: _round2(debito) });
      continue;
    }
    if (!(credito > 0)) continue;

    // créditos que NO son cuotas: interés, devoluciones, reversos
    if (/INTERES|DEVOLUC|REVERSO|ANULAC/i.test(_normTxt(desc))) {
      ignorados.push({ fecha: fechaISO, descripcion: desc, monto: _round2(credito), motivo: 'no es cuota' });
      continue;
    }

    // extraer lote (con posible prefijo de residencial: loteH22) y nombre
    var loteM = desc.match(/lote[s]?\s*([LQH])?\s*([0-9]+\s*[A-Za-z]?)/i);
    var pref = loteM && loteM[1] ? loteM[1].toUpperCase() : '';
    var loteNum = loteM ? loteM[2].replace(/\s/g, '').toUpperCase() : '';
    var esVarios = /varios\s+lotes?/i.test(desc);
    var pagador = _extraerPagador(desc);
    var resPref = { L: 'Los Laureles', Q: 'El Quira', H: 'El Higueron' }[pref] || '';

    // candidatos por número de lote (filtrados por residencial si vino prefijo)
    var cands = (byLoteNum[loteNum] || []).slice();
    if (resPref) cands = cands.filter(function (p) { return p.residencial === resPref; });

    var prop = null, metodo = '', confianza = 'sin-match', ambiguo = false;
    if (cands.length === 1) {
      prop = cands[0]; metodo = 'lote';
      confianza = (pagador && _scoreNombre(pagador, prop.nombre) > 0) ? 'alta' : 'media';
    } else if (cands.length > 1) {
      // desambiguar por nombre entre los candidatos
      var best = null, bestScore = 0;
      cands.forEach(function (p) { var s = _scoreNombre(pagador, p.nombre); if (s > bestScore) { bestScore = s; best = p; } });
      if (best && bestScore > 0) { prop = best; metodo = 'lote+nombre'; confianza = 'alta'; }
      else { ambiguo = true; metodo = 'lote-ambiguo'; }
    }
    if (!prop && !ambiguo) {
      var m = _matchPorNombre(pagador, props);
      if (m) { prop = m.prop; metodo = 'nombre'; confianza = m.score >= 2 ? 'alta' : 'media'; }
    }

    var clave = prop ? prop.clave : '';
    var sig = _sigPago(fechaISO, credito, clave || (loteNum + '?'));
    if (clave && existentes[sig]) { duplicados++; continue; }
    existentes[sig] = true; // evita duplicar dentro del mismo archivo

    pagos.push({
      seleccionado: !!prop && !esVarios,
      fecha: fechaISO,
      monto: _round2(credito),
      descripcion: desc,
      referencia: ref,
      loteDetectado: (pref ? pref : '') + loteNum,
      clave: clave,
      lote: prop ? prop.lote : loteNum,
      residencial: prop ? prop.residencial : resPref,
      nombre: prop ? prop.nombre : (pagador || ''),
      pagador: pagador,
      email: prop ? prop.email : '',
      candidatos: (!prop && cands.length > 1) ? cands.map(function (p) {
        return { clave: p.clave, lote: p.lote, residencial: p.residencial, nombre: p.nombre };
      }) : [],
      match: !!prop,
      metodo: metodo,
      confianza: prop ? confianza : 'sin-match',
      ambiguo: ambiguo,
      variosLotes: esVarios
    });
  }

  // registrar en log
  try {
    var sh = _ss().getSheetByName(SH.LOG);
    if (sh) sh.appendRow([new Date(), filename || '', rows.length - hIdx - 1,
      pagos.filter(function (p) { return p.match; }).length, duplicados,
      _round2(pagos.reduce(function (a, p) { return a + (p.match ? p.monto : 0); }, 0)),
      Session.getActiveUser().getEmail()]);
  } catch (e) {}

  pagos.sort(function (a, b) { return (a.match === b.match) ? 0 : (a.match ? -1 : 1); });
  return {
    filename: filename || '',
    totalFilas: rows.length - hIdx - 1,
    pagosDetectados: pagos.length,
    conMatch: pagos.filter(function (p) { return p.match; }).length,
    sinMatch: pagos.filter(function (p) { return !p.match; }).length,
    duplicados: duplicados,
    pagos: pagos,
    gastos: gastos,
    ignorados: ignorados,
    totalCreditos: _round2(pagos.reduce(function (a, p) { return a + p.monto; }, 0)),
    totalGastos: _round2(gastos.reduce(function (a, g) { return a + g.monto; }, 0))
  };
}

/** Confirma e inserta los pagos seleccionados; opcionalmente envía estados de cuenta. */
function consolidarPagos(pagosSel, enviarCorreos) {
  if (!pagosSel || !pagosSel.length) return { insertados: 0 };
  var insertados = 0, correos = [], clavesTocadas = {}, omitidos = [];
  pagosSel.forEach(function (p) {
    if (!p.clave || !(Number(p.monto) > 0)) { omitidos.push(p); return; }
    appendPago({
      fecha: new Date(p.fecha), clave: p.clave, lote: p.lote, nombre: p.nombre, monto: p.monto,
      referencia: p.referencia || '', origen: 'banco',
      notas: 'Conciliación: ' + (p.descripcion || '').slice(0, 120)
    });
    insertados++;
    clavesTocadas[p.clave] = true;
  });
  if (enviarCorreos) {
    Object.keys(clavesTocadas).forEach(function (clave) {
      try { correos.push(enviarEstadoCuenta(clave)); Utilities.sleep(400); }
      catch (e) { correos.push({ clave: clave, enviado: false, error: String(e) }); }
    });
  }
  return { insertados: insertados, claves: Object.keys(clavesTocadas), omitidos: omitidos.length, correos: correos };
}

/* ─────────────── helpers de parseo ─────────────── */

function _num(v) {
  if (v === '' || v == null) return 0;
  if (typeof v === 'number') return v;
  return Number(String(v).replace(/[^0-9.\-]/g, '')) || 0;
}

function _parseFecha(v) {
  if (v instanceof Date) return v;
  var s = String(v || '').trim();
  if (!s) return null;
  var m = s.match(/(\d{4})-(\d{2})-(\d{2})/);           // 2026-05-01
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/); // 01/05/2026
  if (m) { var y = +m[3]; if (y < 100) y += 2000; return new Date(y, +m[2] - 1, +m[1]); }
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// "BANCA MOVIL TRANSFERENCIA DE TATIANA CAROLINA HOWELL de AVILA mant lote 15" -> "TATIANA CAROLINA HOWELL de AVILA"
function _extraerPagador(desc) {
  var s = String(desc || '');
  var m = s.match(/TRANSFERENCIA\s+DE\s+(.+?)(?:\s+(?:mant|cuota|pago|para|abril|mayo|junio|julio|banca|lote|de mant|mensualidad)|$)/i);
  if (m) return m[1].trim();
  m = s.match(/ACH(?:\s*XPRESS)?\s*-\s*([A-Za-zÁÉÍÓÚÑ ]+?)(?:\s+(?:mant|lote|cuota)|$)/i);
  if (m) return m[1].trim();
  return '';
}

function _scoreNombre(pagador, nombreProp) {
  var a = _tokens(pagador), b = _tokens(nombreProp);
  if (!a.length || !b.length) return 0;
  var set = {}; b.forEach(function (t) { set[t] = 1; });
  var score = 0; a.forEach(function (t) { if (set[t]) score++; });
  return score;
}

function _matchPorNombre(pagador, props) {
  if (!pagador) return null;
  var best = null, bestScore = 0;
  props.forEach(function (p) {
    var s = _scoreNombre(pagador, p.nombre);
    if (s > bestScore) { bestScore = s; best = p; }
  });
  return bestScore >= 1 ? { prop: best, score: bestScore } : null;
}
