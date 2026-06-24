// ════════════════════════════════════════════════════════════════════
//  OBJETIVOS FINANCIEROS (Fase 7)
//  ──────────────────────────────────────────────────────────────────
//  Permite al cliente plantear objetivos concretos de ahorro y trackear
//  su progreso usando datos reales:
//    - Ingreso configurado en Fase 4 (Salud financiera)
//    - Gastos registrados en Egresos
//    - Cálculo automático: meta mensual, % avance, meses estimados
//
//  Tipos predefinidos: vivienda, fondo de emergencia, vacaciones,
//  pagar deuda, inversión, otro.
//
//  STORAGE: Script Properties key "bc_objetivos_json" → array de
//  objetos. Sin hoja nueva (overhead bajo, multi-tenant simple).
//
//  CREACIÓN: lenguaje natural parseado por Claude Haiku. El cliente
//  describe libremente:
//    "ahorrar 10000 para casa en 2 años"
//    "fondo emergencia de 6000"
//    "pagar préstamo de 5000 en 12 meses"
//
//  TRACKING: cada objetivo muestra meta mensual derivada vs ahorro
//  estimado del mes pasado (usa _saludComputarMensual de Fase 4).
// ════════════════════════════════════════════════════════════════════

var OBJS_KEY = 'bc_objetivos_json';
var OBJS_MODEL = 'claude-haiku-4-5';

var OBJS_TIPOS = {
  vivienda:   { label: 'Vivienda (inicial casa propia)', emoji: '🏠' },
  emergencia: { label: 'Fondo de emergencia',            emoji: '🛡️' },
  vacaciones: { label: 'Vacaciones / viaje',             emoji: '✈️' },
  deuda:      { label: 'Pagar deuda',                    emoji: '💳' },
  inversion:  { label: 'Inversión / portafolio',         emoji: '📈' },
  otro:       { label: 'Otro objetivo',                  emoji: '🎯' },
};

// ════════════════════════════════════════════════════════════════════
//  STORAGE
// ════════════════════════════════════════════════════════════════════

function _objsLoad() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(OBJS_KEY);
    if (!raw) return [];
    var arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch(e) {
    Logger.log('_objsLoad ERROR: ' + e.message);
    return [];
  }
}

function _objsSave(arr) {
  try {
    PropertiesService.getScriptProperties().setProperty(OBJS_KEY, JSON.stringify(arr || []));
  } catch(e) {
    Logger.log('_objsSave ERROR: ' + e.message);
    throw e;
  }
}

function _objsCrear(input) {
  var arr = _objsLoad();
  var tipo = String(input.tipo || 'otro').toLowerCase();
  if (!OBJS_TIPOS[tipo]) tipo = 'otro';
  var obj = {
    id:             'obj_' + Date.now(),
    tipo:           tipo,
    nombre:         String(input.nombre || OBJS_TIPOS[tipo].label).substring(0, 80),
    monto_objetivo: Math.max(0, parseFloat(input.monto_objetivo) || 0),
    monto_actual:   Math.max(0, parseFloat(input.monto_actual)   || 0),
    fecha_objetivo: input.fecha_objetivo || null,
    creado_en:      Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd'),
    estado:         'activo',
  };
  arr.push(obj);
  _objsSave(arr);
  return obj;
}

function _objsEliminarPorIndice(indice1based) {
  var arr = _objsLoad();
  var i = indice1based - 1;
  if (i < 0 || i >= arr.length) return false;
  arr.splice(i, 1);
  _objsSave(arr);
  return true;
}

// ════════════════════════════════════════════════════════════════════
//  PROGRESO — usa datos reales (ingreso Fase 4 + ahorro estimado)
// ════════════════════════════════════════════════════════════════════

function _objsCalcularProgreso(obj) {
  var pct = obj.monto_objetivo > 0 ? (obj.monto_actual / obj.monto_objetivo) : 0;
  var restante = Math.max(0, obj.monto_objetivo - obj.monto_actual);

  var hoy = new Date();
  var mesesRestantes = null;
  if (obj.fecha_objetivo && /^\d{4}-\d{2}-\d{2}$/.test(obj.fecha_objetivo)) {
    var fechaObj = new Date(obj.fecha_objetivo);
    var msDiff = fechaObj - hoy;
    mesesRestantes = Math.max(1, Math.round(msDiff / (30 * 86400000)));
  }
  var metaMensual = mesesRestantes ? (restante / mesesRestantes) : null;

  // Estimar ahorro mensual real usando el scorecard de Fase 4
  var ahorroMensual = null;
  if (typeof _saludComputarMensual === 'function') {
    try {
      var s = _saludComputarMensual();
      if (s && s.ok && s.ahorro && typeof s.ahorro.monto === 'number') {
        ahorroMensual = s.ahorro.monto;
      }
    } catch(e) { /* silent — si no hay ingreso configurado, no podemos estimar */ }
  }

  var mesesAlMetaActual = null;
  if (ahorroMensual && ahorroMensual > 0 && restante > 0) {
    mesesAlMetaActual = Math.ceil(restante / ahorroMensual);
  }

  return {
    pct_avance:           Math.min(100, Math.round(pct * 1000) / 10),
    restante:             +restante.toFixed(2),
    meses_restantes:      mesesRestantes,
    meta_mensual:         metaMensual != null ? +metaMensual.toFixed(2) : null,
    ahorro_mensual_real:  ahorroMensual,
    meses_al_meta_actual: mesesAlMetaActual,
  };
}

// ════════════════════════════════════════════════════════════════════
//  RENDER WHATSAPP
// ════════════════════════════════════════════════════════════════════

function _objsRenderListado(arr) {
  if (!arr.length) {
    return '🎯 *Mis objetivos*\n\n' +
           'Aún no tienes objetivos activos. Plantear uno te ayuda a ' +
           'mantener foco y medir progreso real.\n\n' +
           '*Ejemplos de qué se puede plantear:*\n' +
           '• Inicial para casa propia ($50,000 en 5 años)\n' +
           '• Fondo de emergencia (3-6 meses de gastos)\n' +
           '• Pagar un préstamo específico\n' +
           '• Vacaciones a un destino\n' +
           '• Capital para inversión\n\n' +
           '*Escríbeme en lenguaje natural cuál quieres lograr*, ejemplos:\n' +
           '• _"Ahorrar 10000 para casa en 2 años"_\n' +
           '• _"Fondo de emergencia de 6000"_\n' +
           '• _"Pagar préstamo de 5000 en 12 meses"_';
  }
  var lineas = ['🎯 *Mis objetivos*', ''];
  arr.forEach(function(obj, i) {
    var prog = _objsCalcularProgreso(obj);
    var tipoInfo = OBJS_TIPOS[obj.tipo] || OBJS_TIPOS.otro;
    lineas.push('━━━━━━━━━━━━━━━━━━━━━━━');
    lineas.push('');
    lineas.push((i + 1) + '. ' + tipoInfo.emoji + ' *' + obj.nombre + '*');
    lineas.push('Objetivo: $' + obj.monto_objetivo.toFixed(2) + ' · Avance: *' + prog.pct_avance + '%*');
    lineas.push('Acumulado: $' + obj.monto_actual.toFixed(2) + ' · Falta: $' + prog.restante.toFixed(2));
    if (obj.fecha_objetivo && prog.meses_restantes != null) {
      lineas.push('Fecha objetivo: ' + obj.fecha_objetivo + ' (' + prog.meses_restantes + ' meses restantes)');
      lineas.push('Meta mensual sugerida: *$' + prog.meta_mensual.toFixed(2) + '/mes*');
    } else {
      lineas.push('_Sin fecha objetivo — la meta mensual se calcula cuando definas una._');
    }
    if (prog.ahorro_mensual_real != null) {
      var diff = prog.ahorro_mensual_real - (prog.meta_mensual || 0);
      var ahorroStr = '$' + prog.ahorro_mensual_real.toFixed(2);
      if (prog.meta_mensual && diff >= 0) {
        lineas.push('✅ Tu ahorro actual (' + ahorroStr + '/mes) supera la meta. Llegarías en *' + prog.meses_al_meta_actual + ' meses* al ritmo actual.');
      } else if (prog.meta_mensual) {
        lineas.push('⚠️ Tu ahorro actual (' + ahorroStr + '/mes) está $' + Math.abs(diff).toFixed(2) + ' bajo la meta. Al ritmo actual llegarías en *' + (prog.meses_al_meta_actual || '?') + ' meses*.');
      } else {
        lineas.push('💰 Tu ahorro actual: ' + ahorroStr + '/mes. Al ritmo actual llegarías en *' + (prog.meses_al_meta_actual || '?') + ' meses*.');
      }
    } else {
      lineas.push('_Para estimar tu ahorro real, configura tu ingreso en "Mi salud financiera"._');
    }
    lineas.push('');
  });
  lineas.push('━━━━━━━━━━━━━━━━━━━━━━━');
  lineas.push('');
  lineas.push('_Para *agregar* otro objetivo: descríbelo libre._');
  lineas.push('_Para *eliminar* el número N: escribe "eliminar objetivo N"._');
  return lineas.join('\n');
}

// ════════════════════════════════════════════════════════════════════
//  HANDLER DEL MENÚ
// ════════════════════════════════════════════════════════════════════

function _objsMenuHandler(from, token, phoneId) {
  var arr = _objsLoad();
  if (!arr.length && typeof _menuSetIntent === 'function') {
    _menuSetIntent(from, { kind: 'crear_objetivo', step: 'esperar_descripcion' });
  }
  _whatsappReply(from, _objsRenderListado(arr), token, phoneId);
}

// Cuando hay intent crear_objetivo, el próximo mensaje describe el objetivo.
function _objsHandleCrearObjetivo(body, from, token, phoneId) {
  // Detectar comandos de eliminar primero (por si el cliente cambia de tema)
  var elim = String(body || '').toLowerCase().match(/eliminar\s+objetivo\s+(\d+)/);
  if (elim) {
    if (typeof _menuClearIntent === 'function') _menuClearIntent(from);
    _objsHandleEliminar(parseInt(elim[1], 10), from, token, phoneId);
    return;
  }
  try {
    var parsed = _objsClaudeParseObjetivo(body);
    if (!parsed || !parsed.es_objetivo) {
      _whatsappReply(from,
        '⚠️ No entendí el objetivo. Intenta de nuevo, ejemplo:\n' +
        '• _"ahorrar 10000 para casa en 2 años"_\n' +
        '• _"fondo emergencia de 6000"_\n' +
        '• _"pagar deuda de 3000 en 12 meses"_\n\n' +
        'O escribe *menu* para salir.', token, phoneId);
      return;
    }
    if (!parsed.monto_objetivo || parsed.monto_objetivo <= 0) {
      _whatsappReply(from,
        '⚠️ No encontré un monto válido. ¿Cuánto quieres ahorrar? Incluye un número en tu próximo mensaje.',
        token, phoneId);
      return;
    }
    var obj = _objsCrear({
      tipo:           parsed.tipo,
      nombre:         parsed.nombre,
      monto_objetivo: parsed.monto_objetivo,
      fecha_objetivo: parsed.fecha_objetivo,
      monto_actual:   parsed.monto_actual || 0,
    });
    if (typeof _menuClearIntent === 'function') _menuClearIntent(from);
    _whatsappReply(from, '✅ Objetivo creado: *' + obj.nombre + '*', token, phoneId);
    Utilities.sleep(300);
    _whatsappReply(from, _objsRenderListado(_objsLoad()), token, phoneId);
  } catch(err) {
    Logger.log('_objsHandleCrearObjetivo ERROR: ' + err.message);
    _whatsappReply(from, '⚠️ No pude crear el objetivo: ' + err.message, token, phoneId);
  }
}

function _objsHandleEliminar(indice, from, token, phoneId) {
  var arr = _objsLoad();
  if (indice < 1 || indice > arr.length) {
    _whatsappReply(from, '⚠️ No tienes objetivo en la posición ' + indice + '. Escribe "menu" → "Mis objetivos" para ver la lista numerada.', token, phoneId);
    return;
  }
  var eliminado = arr[indice - 1];
  _objsEliminarPorIndice(indice);
  _whatsappReply(from, '✅ Objetivo eliminado: *' + eliminado.nombre + '*', token, phoneId);
  Utilities.sleep(300);
  _whatsappReply(from, _objsRenderListado(_objsLoad()), token, phoneId);
}

// ════════════════════════════════════════════════════════════════════
//  CLAUDE PARSE — Haiku 4.5 estructura el objetivo del lenguaje natural
// ════════════════════════════════════════════════════════════════════

function _objsClaudeParseObjetivo(body) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY no configurada');

  var hoy = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd');
  var en1Anio  = _objsFechaFutura(12);
  var en2Anios = _objsFechaFutura(24);
  var en5Anios = _objsFechaFutura(60);

  var system =
    'Eres un parser de objetivos financieros. El usuario describe en lenguaje natural una meta de ahorro que quiere lograr.\n\n' +
    'Devuelve SOLO un JSON con estos campos:\n' +
    '  - es_objetivo: boolean — true si el texto plantea un objetivo de ahorro, false si es pregunta/saludo/comando.\n' +
    '  - tipo: uno de [vivienda, emergencia, vacaciones, deuda, inversion, otro]\n' +
    '  - nombre: string corto descriptivo (ej: "Inicial casa propia", "Fondo emergencia 6 meses", "Viaje a Europa")\n' +
    '  - monto_objetivo: float USD\n' +
    '  - monto_actual: float USD ya ahorrado (default 0)\n' +
    '  - fecha_objetivo: ISO YYYY-MM-DD. Hoy: ' + hoy + ', "en 1 año"=' + en1Anio + ', "en 2 años"=' + en2Anios + ', "en 5 años"=' + en5Anios + '. Si NO menciona plazo, null.\n\n' +
    'Reglas:\n' +
    '- "casa", "vivienda", "apartamento", "inicial casa" → tipo=vivienda\n' +
    '- "emergencia", "fondo", "imprevistos" → tipo=emergencia\n' +
    '- "viaje", "vacaciones", "tour", "europa", "disney" → tipo=vacaciones\n' +
    '- "préstamo", "deuda", "tarjeta", "crédito" → tipo=deuda\n' +
    '- "invertir", "inversión", "fondo indexado", "acciones" → tipo=inversion\n' +
    '- Si nada matchea → tipo=otro\n' +
    '- NO inventes montos, fechas ni tipos. Si falta info esencial (monto), devuelve es_objetivo=false.\n\n' +
    'Si el texto es una pregunta, saludo, o comando (no un objetivo), devuelve {"es_objetivo": false}.\n\n' +
    'Solo el JSON. Sin markdown, sin explicaciones.';

  var payload = {
    model:      OBJS_MODEL,
    max_tokens: 500,
    system:     system,
    messages:   [{ role: 'user', content: body }],
  };
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify(payload),
    headers:            { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    Logger.log('Objetivos Claude error ' + res.getResponseCode() + ': ' + res.getContentText().substring(0, 300));
    return null;
  }
  var data = JSON.parse(res.getContentText());
  var raw = '';
  (data.content || []).forEach(function(b) { if (b.type === 'text') raw += b.text; });
  raw = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(raw); }
  catch(e) {
    Logger.log('Objetivos JSON parse error: ' + e.message + ' raw: ' + raw.substring(0, 200));
    return null;
  }
}

function _objsFechaFutura(meses) {
  var d = new Date();
  d.setMonth(d.getMonth() + meses);
  return Utilities.formatDate(d, 'America/Panama', 'yyyy-MM-dd');
}

// ════════════════════════════════════════════════════════════════════
//  TOOL PARA EL AsesorGastos — preguntas libres
// ════════════════════════════════════════════════════════════════════

function _agToolMisObjetivos(input) {
  var arr = _objsLoad();
  if (!arr.length) return { ok: true, objetivos: [], mensaje: 'El cliente aún no tiene objetivos configurados.' };
  return {
    ok:         true,
    objetivos:  arr.map(function(obj) {
      var prog = _objsCalcularProgreso(obj);
      return {
        nombre:               obj.nombre,
        tipo:                 obj.tipo,
        monto_objetivo:       obj.monto_objetivo,
        monto_actual:         obj.monto_actual,
        fecha_objetivo:       obj.fecha_objetivo,
        pct_avance:           prog.pct_avance,
        meta_mensual:         prog.meta_mensual,
        ahorro_mensual_real:  prog.ahorro_mensual_real,
        meses_al_meta_actual: prog.meses_al_meta_actual,
      };
    }),
  };
}

// ════════════════════════════════════════════════════════════════════
//  TEST HELPERS
// ════════════════════════════════════════════════════════════════════

function _objsTestListado() {
  Logger.log(_objsRenderListado(_objsLoad()));
}

function _objsTestParse() {
  var ejemplos = [
    'ahorrar 10000 para casa en 2 años',
    'fondo emergencia de 6000',
    'pagar deuda de 3000 en 12 meses',
    'viaje a europa 4000 en 1 año',
    'hola',
  ];
  ejemplos.forEach(function(e) {
    var p = _objsClaudeParseObjetivo(e);
    Logger.log(e + ' → ' + JSON.stringify(p));
  });
}
