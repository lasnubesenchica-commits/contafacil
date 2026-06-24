// ════════════════════════════════════════════════════════════════════
//  INTELIGENCIA PROACTIVA (Fase 6)
//  ──────────────────────────────────────────────────────────────────
//  Detecta patrones en los gastos del cliente y le devuelve insights
//  accionables sin que tenga que pedirlos.
//
//  3 dimensiones:
//
//    1. Pagos recurrentes (bills): proveedores con ≥3 gastos en los
//       últimos 6 meses, intervalo mensual y monto estable. Alerta
//       cuando un pago esperado no se ha visto.
//
//    2. Anomalías de spending: categorías donde el gasto de los
//       últimos 7 días supera significativamente el promedio
//       histórico de las últimas 12 semanas.
//
//    3. Suscripciones detectadas en cuenta bancaria: hook al detector
//       que ya existe en ContaFacil_Banco._bancoAnalizar — si hay
//       cache reciente de análisis bancario, mostrarlas.
//
//  Sin trigger automático — el bot solo habla cuando el cliente le
//  habla. Se accede por:
//    a) Menú principal → "📈 Insights y alertas"
//    b) Pregunta libre → tool analizar_proactivo en AsesorGastos
//    c) Hint en mensaje de confirmación de factura/quick-text si
//       detecta algo relevante en ese momento
// ════════════════════════════════════════════════════════════════════

var PROACTIVO_RECURRENTES_VENTANA_MESES   = 6;   // mirar últimos 6 meses
var PROACTIVO_RECURRENTES_MIN_PAGOS       = 3;   // ≥3 pagos para considerar recurrente
var PROACTIVO_RECURRENTES_TOLERANCIA_DIAS = 5;   // grace period tras fecha esperada
var PROACTIVO_RECURRENTES_VARIANZA_MAX    = 0.30; // monto debe estar ±30% del promedio

var PROACTIVO_ANOMALIA_VENTANA_DIAS    = 7;
var PROACTIVO_ANOMALIA_HIST_SEMANAS    = 12;
var PROACTIVO_ANOMALIA_DELTA_PCT_MIN   = 0.50;  // 50% sobre promedio
var PROACTIVO_ANOMALIA_DELTA_ABS_MIN   = 30;    // $30 sobre promedio

// ════════════════════════════════════════════════════════════════════
//  DETECCIÓN DE PAGOS RECURRENTES
// ════════════════════════════════════════════════════════════════════

// Devuelve [{proveedor, monto_avg, frecuencia_dias, n_pagos,
//            ultima_fecha, proxima_esperada}].
// Solo proveedores con patrón claramente mensual.
function _proactivoDetectarRecurrentes() {
  if (typeof _agLoadDataset !== 'function') return [];
  var ds = _agLoadDataset();
  var hoy = new Date();
  var ventanaInicio = new Date(hoy.getFullYear(), hoy.getMonth() - PROACTIVO_RECURRENTES_VENTANA_MESES, hoy.getDate());

  // Agrupar por proveedor normalizado
  var groups = {};
  ds.egresos.forEach(function(r) {
    if (r.fecha < ventanaInicio) return;
    if (r.alcance !== 'personal' && r.alcance !== '') return;
    var prov = _proactivoNormProveedor(r.proveedor);
    if (!prov) return;
    if (!groups[prov]) groups[prov] = { proveedor_original: r.proveedor, pagos: [] };
    groups[prov].pagos.push({ fecha: r.fecha, monto: r.total, categoria: r.categoria });
  });

  var recurrentes = [];
  Object.keys(groups).forEach(function(prov) {
    var g = groups[prov];
    if (g.pagos.length < PROACTIVO_RECURRENTES_MIN_PAGOS) return;
    // Ordenar cronológicamente
    g.pagos.sort(function(a, b) { return a.fecha - b.fecha; });
    // Calcular intervalos en días
    var intervalos = [];
    for (var i = 1; i < g.pagos.length; i++) {
      var d = (g.pagos[i].fecha - g.pagos[i - 1].fecha) / 86400000;
      intervalos.push(d);
    }
    if (!intervalos.length) return;
    var medianaIntervalo = _proactivoMediana(intervalos);
    // Solo consideramos patrones mensuales (22-38 días)
    if (medianaIntervalo < 22 || medianaIntervalo > 38) return;

    var montoAvg = g.pagos.reduce(function(s, p) { return s + p.monto; }, 0) / g.pagos.length;
    // Varianza: si los montos varían más de 30% del avg, NO es recurrente
    // (probablemente es un proveedor con compras puntuales).
    var allClose = g.pagos.every(function(p) {
      return Math.abs(p.monto - montoAvg) / montoAvg < PROACTIVO_RECURRENTES_VARIANZA_MAX;
    });
    if (!allClose) return;

    var ultima = g.pagos[g.pagos.length - 1];
    var proxima = new Date(ultima.fecha.getTime() + medianaIntervalo * 86400000);
    recurrentes.push({
      proveedor:        g.proveedor_original,
      categoria:        ultima.categoria,
      monto_avg:        +montoAvg.toFixed(2),
      frecuencia_dias:  Math.round(medianaIntervalo),
      n_pagos:          g.pagos.length,
      ultima_fecha:     Utilities.formatDate(ultima.fecha, 'America/Panama', 'yyyy-MM-dd'),
      ultima_fecha_obj: ultima.fecha,
      proxima_esperada: Utilities.formatDate(proxima, 'America/Panama', 'yyyy-MM-dd'),
      proxima_obj:      proxima,
    });
  });
  // Ordenar por monto descendente — los más significativos primero
  recurrentes.sort(function(a, b) { return b.monto_avg - a.monto_avg; });
  return recurrentes;
}

function _proactivoNormProveedor(p) {
  return String(p || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function _proactivoMediana(arr) {
  var sorted = arr.slice().sort(function(a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ════════════════════════════════════════════════════════════════════
//  ALERTAS DE BILLS — qué pagos recurrentes están vencidos o cercanos
// ════════════════════════════════════════════════════════════════════

// Devuelve { atrasados, proximos }:
//   atrasados: pagos esperados (ya pasaron + tolerancia) sin haber visto el nuevo
//   proximos:  pagos que vencen en los próximos 5 días
function _proactivoAlertasBills() {
  var recurrentes = _proactivoDetectarRecurrentes();
  var hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  var atrasados = [];
  var proximos  = [];

  recurrentes.forEach(function(r) {
    var diasDesdeUltimo = (hoy - r.ultima_fecha_obj) / 86400000;
    var diasParaProxima = (r.proxima_obj - hoy) / 86400000;
    var esperado = r.frecuencia_dias + PROACTIVO_RECURRENTES_TOLERANCIA_DIAS;
    if (diasDesdeUltimo > esperado) {
      atrasados.push({
        proveedor:       r.proveedor,
        categoria:       r.categoria,
        monto_esperado:  r.monto_avg,
        ultima_fecha:    r.ultima_fecha,
        dias_atraso:     Math.round(diasDesdeUltimo - r.frecuencia_dias),
      });
    } else if (diasParaProxima >= 0 && diasParaProxima <= 5) {
      proximos.push({
        proveedor:       r.proveedor,
        categoria:       r.categoria,
        monto_esperado:  r.monto_avg,
        proxima_fecha:   r.proxima_esperada,
        dias_restantes:  Math.round(diasParaProxima),
      });
    }
  });

  return { atrasados: atrasados, proximos: proximos };
}

// ════════════════════════════════════════════════════════════════════
//  DETECCIÓN DE ANOMALÍAS — categorías con spending inusual
// ════════════════════════════════════════════════════════════════════

function _proactivoDetectarAnomalias() {
  if (typeof _agLoadDataset !== 'function') return [];
  var ds = _agLoadDataset();
  var hoy = new Date();
  var ventanaInicio = new Date(hoy.getTime() - PROACTIVO_ANOMALIA_VENTANA_DIAS * 86400000);
  var histInicio = new Date(hoy.getTime() - (PROACTIVO_ANOMALIA_HIST_SEMANAS + 1) * 7 * 86400000);
  var histFin    = ventanaInicio;

  var ventanaPorCat = {};
  var histPorCat = {};
  ds.egresos.forEach(function(r) {
    if (r.alcance !== 'personal' && r.alcance !== '') return;
    var cat = r.categoria || '(sin cat)';
    if (r.fecha >= ventanaInicio && r.fecha <= hoy) {
      ventanaPorCat[cat] = (ventanaPorCat[cat] || 0) + r.total;
    } else if (r.fecha >= histInicio && r.fecha < histFin) {
      histPorCat[cat] = (histPorCat[cat] || 0) + r.total;
    }
  });

  var anomalias = [];
  Object.keys(ventanaPorCat).forEach(function(cat) {
    var ventana = ventanaPorCat[cat];
    var hist = histPorCat[cat] || 0;
    // Promedio semanal histórico
    var avgSemanal = hist / PROACTIVO_ANOMALIA_HIST_SEMANAS;
    if (avgSemanal < 1) return;  // categorías casi sin historial — ruido
    var delta = ventana - avgSemanal;
    var deltaPct = avgSemanal > 0 ? (delta / avgSemanal) : 0;
    if (delta < PROACTIVO_ANOMALIA_DELTA_ABS_MIN) return;
    if (deltaPct < PROACTIVO_ANOMALIA_DELTA_PCT_MIN) return;
    anomalias.push({
      categoria:        cat,
      gasto_semana:     +ventana.toFixed(2),
      promedio_semanal: +avgSemanal.toFixed(2),
      delta_pct:        +deltaPct.toFixed(2),
      delta_usd:        +delta.toFixed(2),
    });
  });
  anomalias.sort(function(a, b) { return b.delta_usd - a.delta_usd; });
  return anomalias;
}

// ════════════════════════════════════════════════════════════════════
//  RENDER WHATSAPP — texto de insights
// ════════════════════════════════════════════════════════════════════

function _proactivoRenderInsights(bills, anomalias, recurrentes) {
  var lineas = [];
  lineas.push('📈 *Tus insights y alertas*');
  lineas.push('');

  // ───── Alertas de bills ─────
  if (bills.atrasados.length || bills.proximos.length) {
    if (bills.atrasados.length) {
      lineas.push('⚠️ *Pagos esperados que no he visto*');
      bills.atrasados.slice(0, 5).forEach(function(b) {
        lineas.push('• *' + b.proveedor + '* — suele ser ~$' + b.monto_esperado.toFixed(2) +
                    ' (último: ' + b.ultima_fecha + ', ' + b.dias_atraso + ' día(s) atrás de lo usual)');
      });
      lineas.push('');
    }
    if (bills.proximos.length) {
      lineas.push('🔔 *Próximos a vencer*');
      bills.proximos.slice(0, 5).forEach(function(b) {
        lineas.push('• *' + b.proveedor + '* — ~$' + b.monto_esperado.toFixed(2) +
                    ' (esperado el ' + b.proxima_fecha + ', en ' + b.dias_restantes + ' día(s))');
      });
      lineas.push('');
    }
  } else {
    lineas.push('✅ *Bills al día* — no hay pagos esperados sin registrar.');
    lineas.push('');
  }

  // ───── Anomalías ─────
  if (anomalias.length) {
    lineas.push('📊 *Spending fuera de tu patrón (últimos 7 días)*');
    anomalias.slice(0, 5).forEach(function(a) {
      var pct = Math.round(a.delta_pct * 100);
      lineas.push('• *' + a.categoria + '*: $' + a.gasto_semana.toFixed(2) +
                  ' (+' + pct + '% vs $' + a.promedio_semanal.toFixed(2) + ' promedio semanal)');
    });
    lineas.push('');
  }

  // ───── Resumen de recurrentes ─────
  if (recurrentes && recurrentes.length) {
    lineas.push('━━━━━━━━━━━━━━━━━━━━━━━');
    lineas.push('');
    lineas.push('🔁 *Pagos recurrentes detectados* (últimos 6 meses)');
    recurrentes.slice(0, 8).forEach(function(r) {
      lineas.push('• ' + r.proveedor + ' — ~$' + r.monto_avg.toFixed(2) +
                  ' c/' + r.frecuencia_dias + ' días · próximo ~' + r.proxima_esperada);
    });
    lineas.push('');
  }

  if (!bills.atrasados.length && !bills.proximos.length && !anomalias.length && (!recurrentes || !recurrentes.length)) {
    lineas.push('_Aún no tengo suficiente historial para detectar patrones recurrentes ni anomalías. Mientras más gastos registres, mejor pueden ser estos insights._');
  } else {
    lineas.push('_Insights basados en tus últimos 6 meses de gastos personales. Las anomalías comparan los últimos 7 días contra tu promedio semanal de las últimas 12 semanas._');
  }
  return lineas.join('\n');
}

// ════════════════════════════════════════════════════════════════════
//  HANDLER DEL MENÚ
// ════════════════════════════════════════════════════════════════════

function _proactivoMenuHandler(from, token, phoneId) {
  try {
    var recurrentes = _proactivoDetectarRecurrentes();
    var bills = _proactivoAlertasBills();
    var anomalias = _proactivoDetectarAnomalias();
    var msg = _proactivoRenderInsights(bills, anomalias, recurrentes);
    _whatsappReply(from, msg, token, phoneId);
  } catch(err) {
    Logger.log('_proactivoMenuHandler ERROR: ' + err.message + '\n' + (err.stack || ''));
    _whatsappReply(from, '⚠️ No pude generar los insights: ' + err.message, token, phoneId);
  }
}

// ════════════════════════════════════════════════════════════════════
//  TOOL PARA AsesorGastos — preguntas libres
// ════════════════════════════════════════════════════════════════════

function _agToolInsightsProactivos(input) {
  try {
    var bills = _proactivoAlertasBills();
    var anomalias = _proactivoDetectarAnomalias();
    var recurrentes = _proactivoDetectarRecurrentes();
    // Reducimos el payload eliminando objetos Date que no serializan bien.
    recurrentes = recurrentes.map(function(r) {
      return {
        proveedor: r.proveedor, categoria: r.categoria, monto_avg: r.monto_avg,
        frecuencia_dias: r.frecuencia_dias, n_pagos: r.n_pagos,
        ultima_fecha: r.ultima_fecha, proxima_esperada: r.proxima_esperada,
      };
    });
    return {
      ok: true,
      alertas_bills_atrasados: bills.atrasados,
      alertas_bills_proximos:  bills.proximos,
      anomalias_spending:      anomalias,
      pagos_recurrentes:       recurrentes,
      ventana_anomalias_dias:  PROACTIVO_ANOMALIA_VENTANA_DIAS,
      ventana_historial_meses: PROACTIVO_RECURRENTES_VENTANA_MESES,
    };
  } catch(err) {
    return { ok: false, error: err.message };
  }
}

// ════════════════════════════════════════════════════════════════════
//  HINT INLINE — para mensaje de confirmación de factura/quick-text
//  Si hay bills atrasados relevantes a esa categoría, agrega línea corta.
// ════════════════════════════════════════════════════════════════════

function _proactivoHintParaFactura(categoria) {
  try {
    var bills = _proactivoAlertasBills();
    // Si hay un bill atrasado de la misma categoría, no agregamos hint
    // (el cliente acaba de pagarlo, probablemente). Si hay otro
    // pendiente de OTRA categoría, lo mencionamos brevemente.
    var pendientes = bills.atrasados.filter(function(b) { return b.categoria !== categoria; }).slice(0, 1);
    if (!pendientes.length) return '';
    var p = pendientes[0];
    return '\n\n🔔 _Pendiente: ' + p.proveedor + ' suele ser ~$' + p.monto_esperado.toFixed(2) +
           ' (último: ' + p.ultima_fecha + ')._';
  } catch(e) { return ''; }
}

// ════════════════════════════════════════════════════════════════════
//  TEST HELPERS
// ════════════════════════════════════════════════════════════════════

function _proactivoTestRecurrentes() {
  var r = _proactivoDetectarRecurrentes();
  Logger.log(JSON.stringify(r, null, 2));
}

function _proactivoTestBills() {
  var b = _proactivoAlertasBills();
  Logger.log(JSON.stringify(b, null, 2));
}

function _proactivoTestAnomalias() {
  var a = _proactivoDetectarAnomalias();
  Logger.log(JSON.stringify(a, null, 2));
}

function _proactivoTestRender() {
  var bills = _proactivoAlertasBills();
  var anom = _proactivoDetectarAnomalias();
  var rec  = _proactivoDetectarRecurrentes();
  Logger.log(_proactivoRenderInsights(bills, anom, rec));
}
