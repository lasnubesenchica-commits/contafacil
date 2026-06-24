// ════════════════════════════════════════════════════════════════════
//  SALUD FINANCIERA — Regla 50/30/20 (Fase 4)
//  ──────────────────────────────────────────────────────────────────
//  Analiza la distribución de gastos personales del cliente contra
//  la regla 50/30/20 (Elizabeth Warren, validada por estudios de
//  hogares con alta tasa de ahorro):
//
//    • ≤50% en NECESIDADES (vivienda, servicios básicos, alimentación,
//      transporte, salud, seguros, escolaridad, manutención)
//    • ≤30% en DESEOS      (entretenimiento, ropa, viajes recreativos,
//      otros_gastos por defecto conservador)
//    • ≥20% en AHORRO      (residuo: ingreso - necesidades - deseos)
//
//  Solo evalúa registros con alcance=personal. Los gastos de negocio
//  se trackean por P&L tradicional, no entran al scorecard personal.
//
//  Requiere que el cliente configure su ingreso mensual (clave
//  ingreso_mensual en Config_Operaciones) — el flujo de menú lo
//  guía la primera vez.
// ════════════════════════════════════════════════════════════════════

// Mapeo categoría DGI → bucket 50/30/20
var SALUD_BUCKETS_NEC = [
  'gastos_alimentacion', 'gastos_medicos', 'gastos_escolares',
  'gastos_escolares_discapacitados', 'manutencion', 'pension_alimenticia',
  'servicios_basicos', 'alquileres', 'transporte', 'seguros',
  'intereses_hipotecarios',
];
var SALUD_BUCKETS_DES = [
  'fiestas_entretenimiento', 'viajes_recreativos', 'gastos_vestimenta',
  'otros_gastos',
];

var SALUD_BENCHMARK_NEC = 0.50;
var SALUD_BENCHMARK_DES = 0.30;
var SALUD_BENCHMARK_AHO = 0.20;

// ════════════════════════════════════════════════════════════════════
//  CONFIG — ingreso del cliente en Config_Operaciones
// ════════════════════════════════════════════════════════════════════

function _saludGetConfigIngreso() {
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName('Config_Operaciones');
    if (!sheet) return null;
    var data = sheet.getDataRange().getValues();
    var monto = null, tipo = null, fechaActualiz = null;
    for (var i = 0; i < data.length; i++) {
      var k = String(data[i][0] || '').trim();
      var v = data[i][1];
      if (k === 'ingreso_mensual')        monto = parseFloat(v) || null;
      if (k === 'ingreso_tipo')           tipo = String(v || '').trim();
      if (k === 'ingreso_actualizado_en') fechaActualiz = String(v || '');
    }
    if (!monto || monto <= 0) return null;
    return { monto: monto, tipo: tipo || 'fijo', actualizado: fechaActualiz };
  } catch(e) {
    Logger.log('_saludGetConfigIngreso error: ' + e.message);
    return null;
  }
}

function _saludSetConfigIngreso(monto, tipo) {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName('Config_Operaciones');
  if (!sheet) throw new Error('Hoja Config_Operaciones no existe en este cliente');
  var data = sheet.getDataRange().getValues();
  var existing = {};
  for (var i = 0; i < data.length; i++) {
    var k = String(data[i][0] || '').trim();
    if (k) existing[k] = i + 1;
  }
  var toWrite = {
    ingreso_mensual:        String(monto),
    ingreso_tipo:           tipo || 'fijo',
    ingreso_actualizado_en: Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm'),
  };
  Object.keys(toWrite).forEach(function(k) {
    if (existing[k]) sheet.getRange(existing[k], 2).setValue(toWrite[k]);
    else             sheet.appendRow([k, toWrite[k]]);
  });
}

// ════════════════════════════════════════════════════════════════════
//  PARSEO DE MONTO — acepta formatos panameños comunes
//  "3500", "3,500", "$3500", "3500.50", "B/. 3500", "Gano 4000 al mes"
// ════════════════════════════════════════════════════════════════════

function _saludParsearMonto(text) {
  var s = String(text || '').replace(/[\$,]/g, '').replace(/B\/\./gi, '');
  var m = s.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  var n = parseFloat(m[1]);
  if (!isFinite(n) || n <= 0) return null;
  return n;
}

// ════════════════════════════════════════════════════════════════════
//  COMPUTO MENSUAL
// ════════════════════════════════════════════════════════════════════

function _saludGetBucket(categoria) {
  if (SALUD_BUCKETS_NEC.indexOf(categoria) >= 0) return 'necesidades';
  if (SALUD_BUCKETS_DES.indexOf(categoria) >= 0) return 'deseos';
  // Categoría no mapeada (incluye categorías de negocio, donaciones,
  // honorarios, etc) → conservador: contar como deseo. El filtro
  // alcance=personal excluye la mayoría de estos antes de llegar aquí.
  return 'deseos';
}

function _saludComputarMensual(yearMonth) {
  // Default: mes pasado completo (más representativo que el mes parcial).
  if (!yearMonth) {
    var hoy = new Date();
    var mesPasado = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
    yearMonth = Utilities.formatDate(mesPasado, 'America/Panama', 'yyyy-MM');
  }
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) {
    return { ok: false, error: 'Mes inválido. Formato esperado: YYYY-MM (ej: 2026-05)' };
  }

  var cfg = _saludGetConfigIngreso();
  if (!cfg || !cfg.monto) {
    return { ok: false, error: 'Ingreso no configurado', necesita_configuracion: true };
  }

  // Cargar dataset usando el loader del AsesorGastos (filtra anulados).
  if (typeof _agLoadDataset !== 'function') {
    return { ok: false, error: 'Módulo AsesorGastos no disponible' };
  }
  var ds = _agLoadDataset();
  var fdDesde = yearMonth + '-01';
  var parts = yearMonth.split('-');
  var lastDay = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10), 0).getDate();
  var fdHasta = yearMonth + '-' + (lastDay < 10 ? '0' : '') + lastDay;

  var gastos = ds.egresos.filter(function(r) {
    if (r.fechaIso < fdDesde || r.fechaIso > fdHasta) return false;
    // Solo gastos personales del cliente. Los de negocio van a P&L.
    return r.alcance === 'personal';
  });

  var buckets = { necesidades: 0, deseos: 0 };
  var detallesPorCategoria = {};
  gastos.forEach(function(r) {
    var bucket = _saludGetBucket(r.categoria);
    buckets[bucket] += r.total;
    var cat = r.categoria || '(sin cat)';
    if (!detallesPorCategoria[cat]) detallesPorCategoria[cat] = { monto: 0, bucket: bucket };
    detallesPorCategoria[cat].monto += r.total;
  });

  var totalGastos = buckets.necesidades + buckets.deseos;
  var ahorro = cfg.monto - totalGastos;
  var pNec = cfg.monto > 0 ? buckets.necesidades / cfg.monto : 0;
  var pDes = cfg.monto > 0 ? buckets.deseos / cfg.monto : 0;
  var pAho = cfg.monto > 0 ? ahorro / cfg.monto : 0;

  // Top categorías dentro de cada bucket (para diagnóstico accionable).
  var topNec = Object.keys(detallesPorCategoria)
    .filter(function(c) { return detallesPorCategoria[c].bucket === 'necesidades'; })
    .map(function(c) { return { cat: c, monto: detallesPorCategoria[c].monto }; })
    .sort(function(a, b) { return b.monto - a.monto; }).slice(0, 3);
  var topDes = Object.keys(detallesPorCategoria)
    .filter(function(c) { return detallesPorCategoria[c].bucket === 'deseos'; })
    .map(function(c) { return { cat: c, monto: detallesPorCategoria[c].monto }; })
    .sort(function(a, b) { return b.monto - a.monto; }).slice(0, 3);

  return {
    ok:          true,
    mes:         yearMonth,
    ingreso:     +cfg.monto.toFixed(2),
    ingreso_tipo: cfg.tipo,
    necesidades: { monto: +buckets.necesidades.toFixed(2), pct: +pNec.toFixed(4), benchmark: SALUD_BENCHMARK_NEC, ok: pNec <= SALUD_BENCHMARK_NEC, top: topNec },
    deseos:      { monto: +buckets.deseos.toFixed(2),      pct: +pDes.toFixed(4), benchmark: SALUD_BENCHMARK_DES, ok: pDes <= SALUD_BENCHMARK_DES, top: topDes },
    ahorro:      { monto: +ahorro.toFixed(2),              pct: +pAho.toFixed(4), benchmark: SALUD_BENCHMARK_AHO, ok: pAho >= SALUD_BENCHMARK_AHO },
    total_gastos: +totalGastos.toFixed(2),
    n_movimientos: gastos.length,
  };
}

// ════════════════════════════════════════════════════════════════════
//  RENDER WHATSAPP — formato bonito para texto plano
// ════════════════════════════════════════════════════════════════════

function _saludRenderScorecard(s) {
  if (!s || !s.ok) {
    return '⚠️ No pude generar el reporte: ' + (s ? s.error : 'error desconocido');
  }

  var mesLabel = _saludMesLabel(s.mes);
  var lineas = [];
  lineas.push('💚 *Tu salud financiera — ' + mesLabel + '*');
  lineas.push('');
  lineas.push('Ingreso configurado: *$' + s.ingreso.toFixed(2) + '/mes*');
  lineas.push('Movimientos analizados: ' + s.n_movimientos);
  lineas.push('');
  lineas.push('━━━━━━━━━━━━━━━━━━━━━━━');
  lineas.push('');

  // Necesidades
  var iconNec = s.necesidades.ok ? '✅' : '⚠️';
  lineas.push(iconNec + ' *Necesidades*: $' + s.necesidades.monto.toFixed(2) +
              ' (' + Math.round(s.necesidades.pct * 100) + '%)');
  lineas.push('   _Recomendado: ≤50%_');
  if (s.necesidades.top && s.necesidades.top.length) {
    var topNecStr = s.necesidades.top.map(function(c) {
      return c.cat + ' $' + c.monto.toFixed(0);
    }).join(' · ');
    lineas.push('   Top: ' + topNecStr);
  }
  lineas.push('');

  // Deseos
  var iconDes = s.deseos.ok ? '✅' : '⚠️';
  lineas.push(iconDes + ' *Deseos*: $' + s.deseos.monto.toFixed(2) +
              ' (' + Math.round(s.deseos.pct * 100) + '%)');
  lineas.push('   _Recomendado: ≤30%_');
  if (s.deseos.top && s.deseos.top.length) {
    var topDesStr = s.deseos.top.map(function(c) {
      return c.cat + ' $' + c.monto.toFixed(0);
    }).join(' · ');
    lineas.push('   Top: ' + topDesStr);
  }
  lineas.push('');

  // Ahorro
  var iconAho = s.ahorro.ok ? '✅' : '⚠️';
  var ahoStr = s.ahorro.monto >= 0
    ? '$' + s.ahorro.monto.toFixed(2)
    : '-$' + Math.abs(s.ahorro.monto).toFixed(2);
  lineas.push(iconAho + ' *Ahorro/Inversión*: ' + ahoStr +
              ' (' + Math.round(s.ahorro.pct * 100) + '%)');
  lineas.push('   _Recomendado: ≥20%_');
  lineas.push('');

  lineas.push('━━━━━━━━━━━━━━━━━━━━━━━');
  lineas.push('');

  // Diagnóstico accionable
  var diagnosticos = [];
  if (!s.necesidades.ok) {
    var deltaNec = Math.round((s.necesidades.pct - SALUD_BENCHMARK_NEC) * 100);
    diagnosticos.push('• Necesidades están *' + deltaNec + ' puntos sobre el ideal*. La categoría más alta es ' + (s.necesidades.top[0] ? s.necesidades.top[0].cat : '(sin top)') + ' — revisar si hay margen.');
  }
  if (!s.deseos.ok) {
    var deltaDes = Math.round((s.deseos.pct - SALUD_BENCHMARK_DES) * 100);
    diagnosticos.push('• Deseos están *' + deltaDes + ' puntos sobre el ideal*. La más alta: ' + (s.deseos.top[0] ? s.deseos.top[0].cat : '(sin top)') + '. ¿Hay suscripciones o gastos recreativos reducibles?');
  }
  if (!s.ahorro.ok) {
    if (s.ahorro.monto < 0) {
      diagnosticos.push('• Estás *en déficit* este mes ($' + Math.abs(s.ahorro.monto).toFixed(2) + '). Tus gastos superan tu ingreso configurado — revisar si el ingreso está actualizado o reducir gastos.');
    } else {
      var deltaAho = Math.round((SALUD_BENCHMARK_AHO - s.ahorro.pct) * 100);
      diagnosticos.push('• Estás ahorrando solo ' + Math.round(s.ahorro.pct * 100) + '%, *' + deltaAho + ' puntos bajo el ideal*. Cada $100 menos de gasto = $100 más de ahorro.');
    }
  }

  if (diagnosticos.length === 0) {
    lineas.push('🎉 *Tu distribución está dentro del benchmark experto*. Felicitaciones.');
  } else {
    lineas.push('💡 *Diagnóstico*:');
    diagnosticos.forEach(function(d) { lineas.push(d); });
  }
  lineas.push('');
  lineas.push('━━━━━━━━━━━━━━━━━━━━━━━');
  lineas.push('');
  lineas.push('📚 *Sobre la regla 50/30/20*');
  lineas.push('Marco de planificación financiera personal popularizado por Elizabeth Warren en su libro _All Your Worth_ (2005). Divide tu ingreso neto en tres categorías:');
  lineas.push('');
  lineas.push('• *50% Necesidades* — gastos que no puedes evitar: vivienda, servicios básicos, alimentación, transporte, salud, seguros.');
  lineas.push('• *30% Deseos* — gastos discrecionales: entretenimiento, ropa, viajes recreativos, restaurantes.');
  lineas.push('• *20% Ahorro / Inversión* — fondo de emergencia, retiro, inversiones, pago acelerado de deudas.');
  lineas.push('');
  lineas.push('_Es una guía, no una regla rígida. Sirve para detectar desbalances y mantener un margen saludable de ahorro a largo plazo._');

  return lineas.join('\n');
}

function _saludMesLabel(yearMonth) {
  var meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  var parts = String(yearMonth || '').split('-');
  if (parts.length !== 2) return yearMonth || '?';
  var idx = parseInt(parts[1], 10) - 1;
  return (meses[idx] || parts[1]) + ' ' + parts[0];
}

// ════════════════════════════════════════════════════════════════════
//  HANDLERS — invocados desde el menú principal y desde el intent
// ════════════════════════════════════════════════════════════════════

// Llamado desde el dispatcher del menú cuando el cliente toca
// "Salud financiera". Si no hay ingreso configurado, setea intent
// y pide el monto. Si hay, genera el reporte.
function _saludMenuHandler(from, token, phoneId) {
  var cfg = _saludGetConfigIngreso();
  if (!cfg || !cfg.monto) {
    if (typeof _menuSetIntent === 'function') {
      _menuSetIntent(from, { kind: 'configurar_ingreso', step: 'esperar_monto' });
    }
    _whatsappReply(from,
      '💚 *Salud financiera (regla 50/30/20)*\n\n' +
      'Para evaluar tu distribución de gastos necesito conocer tu ingreso mensual neto.\n\n' +
      '*¿Cuánto ingresas mensualmente?*\n' +
      'Ejemplos válidos:\n' +
      '• `3500`\n' +
      '• `$3,500`\n' +
      '• `B/. 3500`\n' +
      '• `Gano 4000 al mes`\n\n' +
      'Esto se guarda en tu configuración y puedes actualizarlo cuando quieras.',
      token, phoneId
    );
    return;
  }
  // Genera reporte del mes pasado por defecto.
  try {
    var scorecard = _saludComputarMensual();
    var msg = _saludRenderScorecard(scorecard);
    _whatsappReply(from, msg, token, phoneId);
  } catch(err) {
    Logger.log('_saludMenuHandler error: ' + err.message);
    _whatsappReply(from, '⚠️ No pude generar el reporte: ' + err.message, token, phoneId);
  }
}

// Llamado desde WhatsApp.gs cuando el cliente acaba de tocar "Salud
// financiera" sin tener ingreso configurado y manda el monto.
function _saludHandleConfigurarIngreso(body, from, token, phoneId) {
  var monto = _saludParsearMonto(body);
  if (!monto) {
    _whatsappReply(from,
      '⚠️ No reconozco eso como un monto válido. Intenta de nuevo con un número.\n\n' +
      'Ejemplos: `3500` · `$3,500` · `B/. 4000`.\n\n' +
      'O escribe *menu* para volver al menú principal.',
      token, phoneId);
    return;
  }
  try {
    _saludSetConfigIngreso(monto, 'fijo');
    if (typeof _menuClearIntent === 'function') _menuClearIntent(from);
    _whatsappReply(from,
      '✅ Ingreso mensual guardado: *$' + monto.toFixed(2) + '*\n\n' +
      'Generando tu reporte de salud financiera del mes pasado…',
      token, phoneId);
    var scorecard = _saludComputarMensual();
    Utilities.sleep(400);
    _whatsappReply(from, _saludRenderScorecard(scorecard), token, phoneId);
  } catch(err) {
    Logger.log('_saludHandleConfigurarIngreso error: ' + err.message);
    _whatsappReply(from,
      '⚠️ No pude guardar el ingreso: ' + err.message + '\n\n' +
      'Verifica que tu cuenta tenga la hoja Config_Operaciones.',
      token, phoneId);
  }
}

// ════════════════════════════════════════════════════════════════════
//  TOOLS para el AsesorGastos (Claude conversacional)
// ════════════════════════════════════════════════════════════════════

// Llamado desde _agEjecutarTool cuando Claude lo invoca. Devuelve
// el scorecard estructurado para que Claude lo describa al usuario.
function _agToolSaludFinanciera(input) {
  if (typeof _saludComputarMensual !== 'function') {
    return { ok: false, error: 'Módulo de salud financiera no disponible en este cliente.' };
  }
  return _saludComputarMensual(input && input.mes);
}

// ════════════════════════════════════════════════════════════════════
//  TEST HELPERS — para correr desde el editor del GAS
// ════════════════════════════════════════════════════════════════════

function _saludTestParseo() {
  var ejemplos = ['3500', '$3,500', 'B/. 4000', '3500.50', 'Gano 4000 al mes', 'mi ingreso es 2500'];
  ejemplos.forEach(function(e) {
    Logger.log(e + ' → ' + _saludParsearMonto(e));
  });
}

function _saludTestReporte() {
  var s = _saludComputarMensual();
  Logger.log(JSON.stringify(s, null, 2));
  Logger.log('---');
  Logger.log(_saludRenderScorecard(s));
}
