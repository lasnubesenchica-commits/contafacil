// ════════════════════════════════════════════════════════════════════
//  QUICK TEXT — Registro rápido de gastos por texto corto (Fase 8)
//  ──────────────────────────────────────────────────────────────────
//  Permite al cliente registrar un gasto en segundos sin tener que
//  mandar foto/PDF. Ejemplos:
//
//    "Uber 20"           → transporte $20 hoy
//    "luz 80"            → servicios básicos (ENSA inferido) $80
//    "100 a julia"       → otros gastos $100 a "Julia" hoy
//    "yappy 50 doctora"  → gastos médicos $50 a "Doctora" hoy
//    "$15 almuerzo"      → gastos alimentación $15 hoy
//
//  Flujo:
//    1. Detector heurístico filtra candidatos (corto, contiene número,
//       no es pregunta ni comando).
//    2. Claude Haiku 4.5 estructura los campos (monto, proveedor,
//       categoría DGI, fecha). Bajo costo (~$0.0005/mensaje).
//    3. Se crea pendiente en Acreedores_Pendientes (mismo flujo que
//       factura por foto — el cliente aprueba con el botón conocido).
//
//  Costo esperado: cada quick text = 1 llamada Haiku, no Sonnet.
//  Mucho más barato que el OCR de factura.
// ════════════════════════════════════════════════════════════════════

var QT_MODEL = 'claude-haiku-4-5';

// ════════════════════════════════════════════════════════════════════
//  DETECTOR — ¿este texto huele a registro rápido?
// ════════════════════════════════════════════════════════════════════

function _quickTextEsCandidato(text) {
  var t = String(text || '').trim();
  if (t.length < 3 || t.length > 100) return false;
  // Tiene un número (monto)
  if (!/\d/.test(t)) return false;
  // NO es pregunta
  if (/\?/.test(t)) return false;
  var tNorm = _qtNorm(t);
  // NO empieza con palabra interrogativa
  if (/^(que|cuanto|cuanta|cuantas|cuantos|cuando|como|donde|por que|porque|cual|cuales)\b/.test(tNorm)) return false;
  // NO es comando del menú / saludo / confirmación corta
  if (/^(menu|menu principal|opciones|ayuda|help|info|hola|hello|hi|buenas|gracias|listo|si|no|ok|dale|claro)$/i.test(tNorm)) return false;
  // NO empieza con verbo introductorio de pregunta
  if (/^(es|son|hay|tengo|tenia|tenemos|tienes|tendre|tendremos)\b/.test(tNorm)) return false;
  // NO empieza con verbos del asesor ("muéstrame X", "lista Y", "compara Z")
  if (/^(muestra|muéstrame|muestrame|enseña|enseñame|listame|liste|busca|buscar|encuentra|necesito|quiero|quisiera|compara|comparar)/.test(tNorm)) return false;
  return true;
}

function _qtNorm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

// ════════════════════════════════════════════════════════════════════
//  HANDLER — invocado desde ContaFacil_WhatsApp.gs cuando matchea
// ════════════════════════════════════════════════════════════════════

function _quickTextHandle(text, from, msgId, token, phoneId) {
  try {
    var parsed = _quickTextClaudeParse(text);
    if (!parsed || parsed.es_gasto === false) {
      // Claude determinó que NO es un gasto. Devolvemos false para que
      // el caller siga al siguiente handler (AsesorGastos, etc).
      return false;
    }
    if (!parsed.monto || parsed.monto <= 0) {
      // Sin monto válido, no podemos crear el gasto. Fallback a no-quicktext.
      return false;
    }
    // Crear pendiente reusando el flujo de factura.
    var pendId = _quickTextCrearPendiente(parsed, from, msgId, text);
    // Mandar mensaje de confirmación con botones.
    _quickTextEnviarConfirmacion(parsed, pendId, from, token, phoneId);
    return true;
  } catch(err) {
    Logger.log('_quickTextHandle ERROR: ' + err.message + '\n' + (err.stack || ''));
    // Si falla la inferencia, no rompemos el flujo — dejamos que caiga
    // al siguiente handler (AsesorGastos o welcome).
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════
//  CLAUDE PARSE — Haiku 4.5 estructura los campos
// ════════════════════════════════════════════════════════════════════

function _quickTextClaudeParse(text) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY no configurada');

  var hoy = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd');
  var system =
    'Eres un parser de gastos cortos panameños. El usuario está registrando UN gasto desde WhatsApp con un mensaje muy breve.\n\n' +
    'Devuelve SOLO un JSON con estos campos:\n' +
    '  - es_gasto: boolean — true si el texto es un registro de gasto, false si es pregunta/saludo/comando.\n' +
    '  - monto: float USD\n' +
    '  - proveedor: string — comercio/persona/servicio (ej "Uber", "Farmacia Arrocha", "Julia", "ENSA")\n' +
    '  - categoria_dgi: una de [gastos_alimentacion, gastos_medicos, gastos_escolares, transporte, servicios_basicos, fiestas_entretenimiento, viajes_recreativos, otros_gastos, manutencion, gastos_vestimenta, alquileres, seguros, mantenimiento]\n' +
    '  - fecha: ISO YYYY-MM-DD. Default: ' + hoy + ' (hoy). "ayer" = ' + _qtFechaIso(-1) + '. "hace 2 dias" = ' + _qtFechaIso(-2) + '.\n' +
    '  - descripcion: el texto original tal cual\n' +
    '  - confianza: 0-100 — qué tan claro fue el parseo\n\n' +
    'Reglas:\n' +
    '- "uber", "indriver", "taxi", "gasolina", "peaje", "metro" → transporte\n' +
    '- "luz", "electricidad", "agua", "telefono", "celular", "internet", "cable" → servicios_basicos. Inferir ENSA si dice "luz" o "electricidad" sin nombre.\n' +
    '- "farmacia arrocha", "doctor", "clinica", "medicina" → gastos_medicos\n' +
    '- "colegio", "escuela", "universidad", "matricula" → gastos_escolares\n' +
    '- "supermercado", "rey", "riba smith", "machetazo", "super99", "almuerzo", "comida" → gastos_alimentacion\n' +
    '- "viviana", "manutencion", "pension" → manutencion\n' +
    '- "yappy" — el destinatario después de "yappy" o "a" determina el proveedor.\n' +
    '- Si NO está claro a qué categoría va, usar "otros_gastos".\n' +
    '- NO INVENTES topes, datos fiscales, ni proveedores nuevos.\n\n' +
    'Si el texto es claramente una PREGUNTA, SALUDO o COMANDO (no un registro de gasto), devuelve {"es_gasto": false}.\n\n' +
    'Solo el JSON. Nada antes ni después. Nada de markdown ni explicaciones.';

  var payload = {
    model:      QT_MODEL,
    max_tokens: 500,
    system:     system,
    messages:   [{ role: 'user', content: text }],
  };
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify(payload),
    headers:            { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  if (code !== 200) {
    Logger.log('QuickText Claude error ' + code + ': ' + res.getContentText().substring(0, 300));
    return null;
  }
  var data = JSON.parse(res.getContentText());
  var raw = '';
  (data.content || []).forEach(function(b) { if (b.type === 'text') raw += b.text; });
  raw = raw.trim();
  // Limpiar code fences si Claude los puso por error.
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  var parsed;
  try { parsed = JSON.parse(raw); }
  catch(e) {
    Logger.log('QuickText JSON parse error: ' + e.message + ' raw: ' + raw.substring(0, 200));
    return null;
  }
  // Log usage para tracking
  if (data.usage) {
    Logger.log('QuickText Haiku usage: in=' + (data.usage.input_tokens || 0) + ' out=' + (data.usage.output_tokens || 0));
  }
  return parsed;
}

function _qtFechaIso(deltaDias) {
  var d = new Date();
  d.setDate(d.getDate() + deltaDias);
  return Utilities.formatDate(d, 'America/Panama', 'yyyy-MM-dd');
}

// ════════════════════════════════════════════════════════════════════
//  CREAR PENDIENTE — reusa _findOrAutoCreateAcreedor + _crearPendiente
// ════════════════════════════════════════════════════════════════════

function _quickTextCrearPendiente(parsed, from, msgId, textoOriginal) {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var nombreProv = String(parsed.proveedor || 'Sin proveedor').trim();
  var catSug = String(parsed.categoria_dgi || 'otros_gastos').trim();
  var acreedor = _findOrAutoCreateAcreedor(nombreProv, '', catSug);
  if (acreedor && acreedor.categoria_def) catSug = acreedor.categoria_def;

  var clave = 'wa-quicktext-' + (msgId || Date.now());
  var parsedForPend = {
    fecha:                parsed.fecha || Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd'),
    num_factura:          '',
    subtotal:             parsed.monto || 0,
    itbms:                0,
    total:                parsed.monto || 0,
    descripcion:          'Quick text: ' + (textoOriginal || nombreProv),
    confianza_categoria:  parsed.confianza || 80,
    categoria_sugerida:   catSug,
    ruc_receptor:         '',
  };
  var pendId = _crearPendiente(ss, acreedor, parsedForPend, '', clave, msgId || '', '');
  return pendId;
}

// ════════════════════════════════════════════════════════════════════
//  CONFIRMACIÓN — mensaje con botones (mismo patrón que factura por foto)
// ════════════════════════════════════════════════════════════════════

function _quickTextEnviarConfirmacion(parsed, pendId, from, token, phoneId) {
  var fechaIso = parsed.fecha || Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd');
  var fechaLabel;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(fechaIso))) {
    var pf = String(fechaIso).split('-');
    fechaLabel = pf[2] + '/' + pf[1] + '/' + pf[0];
  } else {
    fechaLabel = fechaIso;
  }

  // Hint deducible DGI si la categoría sugerida es DP-N
  var hintDeducible = '';
  if (typeof _deduciblesHintParaFactura === 'function') {
    try { hintDeducible = _deduciblesHintParaFactura(parsed.categoria_dgi); }
    catch(e) { /* silent */ }
  }
  // Hint proactivo de bills pendientes (otro proveedor, recordatorio sutil)
  var hintProactivo = '';
  if (typeof _proactivoHintParaFactura === 'function') {
    try { hintProactivo = _proactivoHintParaFactura(parsed.categoria_dgi); }
    catch(e) { /* silent */ }
  }

  var bodyTxt =
    '⚡ *Gasto rápido recibido*\n\n' +
    '📦 ' + (parsed.proveedor || 'Sin proveedor') + '\n' +
    '📅 Fecha: ' + fechaLabel + '\n' +
    '💵 B/. ' + Number(parsed.monto || 0).toFixed(2) + '\n' +
    '📋 Categoría sugerida: ' + _waCatLabel(parsed.categoria_dgi) +
    hintDeducible +
    hintProactivo;

  _whatsappReplyBotones(from, bodyTxt, '#' + pendId, [
    { id: 'wa:apr:' + pendId, title: '✅ Aprobar' },
    { id: 'wa:cat:' + pendId, title: '📝 Cambiar categoría' },
  ], token, phoneId);
}

// ════════════════════════════════════════════════════════════════════
//  TEST HELPERS
// ════════════════════════════════════════════════════════════════════

function _qtTestDeteccion() {
  var ejemplos = [
    'uber 20',
    'luz 80',
    '100 a julia',
    'yappy 50 doctora',
    '$15 almuerzo',
    'tip 5',
    'hola',
    'menu',
    '¿cuanto gasté en uber?',
    'cuanto llevo en farmacias',
    'gracias',
    'si',
  ];
  ejemplos.forEach(function(e) {
    Logger.log((_quickTextEsCandidato(e) ? '✓' : '✗') + '  ' + e);
  });
}

function _qtTestParse() {
  var p = _quickTextClaudeParse('uber 20');
  Logger.log(JSON.stringify(p, null, 2));
}
