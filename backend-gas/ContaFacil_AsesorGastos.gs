// ════════════════════════════════════════════════════════════════════
//  ASESOR DE GASTOS (LLM + TOOL USE)
//  ──────────────────────────────────────────────────────────────────
//  Permite al cliente preguntarle al bot cosas como:
//    • "¿Cuándo fue la última vez que pagué mi seguro?"
//    • "¿Cuántos pagos he hecho al Colegio Las Esclavas?"
//    • "¿Cuánto he gastado este mes en Farmacias Arrocha?"
//
//  Arquitectura: Claude Sonnet 4.6 con tool use. Le damos funciones
//  para buscar / agregar / listar en las hojas Egresos + Ingresos, y
//  Claude decide qué tools llamar según la pregunta. Loop server-side
//  hasta que Claude devuelva un end_turn (max 8 iteraciones).
//
//  Fuzzy match: normalización agresiva (lowercase + sin acentos + sin
//  abreviaturas societarias) + matching por tokens + fallback Jaccard.
//  Cuando el cliente dice "Farmacias Arrocha" y en la data está
//  "FCIAS ARROCHA SA" o "ARROCHA, S.A." → matchea.
// ════════════════════════════════════════════════════════════════════

var AG_CACHE_SECS    = 300;      // 5 min — cache del dataset cargado de Sheets
var AG_MAX_TOOL_ITER = 8;        // tope de iteraciones del tool loop
var AG_MAX_ROWS_OUT  = 30;       // rows max devueltos por buscar (evita prompt bloat)
var AG_ASESOR_MODEL  = 'claude-sonnet-4-6';
var AG_MAX_TOKENS    = 2000;

// Pricing Sonnet 4.6 (cached: 2026-06). $3/1M input, $15/1M output.
var AG_PRICE_IN_PER_TOKEN  = 3.0  / 1e6;
var AG_PRICE_OUT_PER_TOKEN = 15.0 / 1e6;

// ─── Stop words y abreviaturas a remover del fuzzy match ────────────
var AG_STOPWORDS = {
  'sa': 1, 'sas': 1, 'srl': 1, 'sl': 1, 'ltd': 1, 'ltda': 1, 'corp': 1,
  'cia': 1, 'compania': 1, 'inc': 1, 'co': 1, 'de': 1, 'del': 1, 'la': 1,
  'el': 1, 'los': 1, 'las': 1, 'y': 1, 'e': 1, 'a': 1, 'al': 1,
};

// ════════════════════════════════════════════════════════════════════
//  DETECCIÓN — ¿es esto una pregunta sobre gastos/ingresos registrados?
// ════════════════════════════════════════════════════════════════════
//
// Estrategia:
//   1) Phrases panameñas comunes de lookup ("cuanto llevo", "cuanto va",
//      "cuanto he", "cuando pagué", etc.) → match siempre.
//   2) Mención DIRECTA de una categoría DGI (escolares, medicos,
//      alimentacion, vestimenta, salarios, alquileres, transporte,
//      seguros, donaciones, mantenimiento, etc.) → match siempre.
//      La lista se infiere de CATEGORIAS_GASTO_DGI cuando está
//      disponible, con fallback a un set estático.
//   3) Conceptos de proveedor común ("mi luz", "mi internet", "farmacia
//      Arrocha", etc.) → match.
//   4) Verbos de petición ("muestrame", "listame") + cosa registrable.
//
// Se busca falso-negativo bajo. Falso-positivos los limita el hecho de
// que el handler que sigue es Claude con tool use — si no encuentra
// data devuelve "no encontré" y el usuario reintenta.

var AG_CATEGORY_STEMS_CACHE = null;

function _agCategoryStems() {
  if (AG_CATEGORY_STEMS_CACHE) return AG_CATEGORY_STEMS_CACHE;
  var stems = {
    // Fallback estático (se usa si CATEGORIAS_GASTO_DGI no está
    // disponible o como complemento). Stems normalizados (sin acentos,
    // singular y plural).
    salario: 1, salarios: 1, remuneracion: 1, remuneraciones: 1,
    prestacion: 1, prestaciones: 1, laboral: 1, laborales: 1,
    alquiler: 1, alquileres: 1, renta: 1,
    transporte: 1, gasolina: 1, combustible: 1, peaje: 1, gas: 1,
    banco: 1, bancario: 1, bancarios: 1,
    financiero: 1, financieros: 1, interes: 1, intereses: 1,
    depreciacion: 1, amortizacion: 1, impuesto: 1, impuestos: 1,
    honorario: 1, honorarios: 1, profesional: 1, profesionales: 1,
    oficina: 1, papeleria: 1,
    factoring: 1, especie: 1, especies: 1,
    donacion: 1, donaciones: 1, mantenimiento: 1, reparacion: 1, reparaciones: 1,
    electricidad: 1, luz: 1, agua: 1, telefono: 1, celular: 1, internet: 1, cable: 1,
    seguro: 1, seguros: 1, hospitalizacion: 1, vida: 1,
    medico: 1, medicos: 1, medica: 1, medicas: 1, doctor: 1, clinica: 1, hospital: 1,
    salud: 1, farmacia: 1, farmacias: 1, medicamento: 1, medicamentos: 1,
    escolar: 1, escolares: 1, colegio: 1, escuela: 1, universidad: 1, educativo: 1, educativos: 1, educacion: 1,
    hipotecario: 1, hipotecarios: 1, hipoteca: 1,
    discapacitado: 1, discapacitados: 1,
    alimentacion: 1, alimento: 1, alimentos: 1, comida: 1, supermercado: 1, restaurante: 1,
    vestimenta: 1, ropa: 1, vestido: 1,
    pension: 1, alimenticia: 1, manutencion: 1,
    viaje: 1, viajes: 1, recreativo: 1, recreativos: 1, hotel: 1, hoteles: 1, vuelo: 1, vuelos: 1,
    fiesta: 1, fiestas: 1, entretenimiento: 1,
    compra: 1, compras: 1, factura: 1, facturas: 1, gasto: 1, gastos: 1, pago: 1, pagos: 1,
    deducible: 1, deducibles: 1, deduccion: 1,
  };
  // Enriquecer con stems extraídos de CATEGORIAS_GASTO_DGI si el módulo
  // está cargado (mismo GAS project).
  try {
    if (typeof CATEGORIAS_GASTO_DGI !== 'undefined' && Array.isArray(CATEGORIAS_GASTO_DGI)) {
      CATEGORIAS_GASTO_DGI.forEach(function(c) {
        // valor: 'gastos_escolares' → ['gastos', 'escolares']
        String(c.valor || '').split('_').forEach(function(tok) {
          if (tok && tok.length >= 3) stems[_agNorm(tok)] = 1;
        });
        // label: 'Gastos escolares' → tokens normalizados
        _agTokens(c.label || '').forEach(function(tok) {
          if (tok && tok.length >= 3) stems[tok] = 1;
        });
      });
    }
  } catch(_) { /* silent — fallback estático ya está */ }
  AG_CATEGORY_STEMS_CACHE = stems;
  return stems;
}

function _agMencionaCategoria(normalized) {
  var stems = _agCategoryStems();
  var tokens = normalized.split(/\s+/);
  for (var i = 0; i < tokens.length; i++) {
    if (stems[tokens[i]]) return true;
  }
  return false;
}

function _asesorGastosEsPregunta(text) {
  var t = _agNorm(text);
  if (!t || t.length < 4) return false;

  // 1) Señales fuertes — phrases panameñas de lookup directo.
  //    Algunas no requieren mención de categoría porque la pregunta YA
  //    deja claro que es sobre los registros (cuanto llevo, cuanto he, etc).
  if (/\bcuant[oa]\s+(llevo|va|tengo|he|llevamos|vamos|tenemos)\b/.test(t)) return true;
  if (/\bcuant(o|a)s?\s+(veces|pagos|facturas|gastos|recibos|operaciones|registros|cobros|cargos|compras|ingresos|ventas)\b/.test(t)) return true;
  if (/\b(ultim[ao]|reciente)\s+(pago|factura|gasto|registro|compra|visita|cobro|recibo|ingreso|venta)\b/.test(t)) return true;
  if (/\b(cuando|cuándo)\b.*\b(ultim|pagu|registr|fui|fue|compr|visit|hice|cobr)/.test(t)) return true;
  if (/\bcuanto\s+(he|llevo)\s+(gast|pagad|invert|registrad|cobrad|ingresad)/.test(t)) return true;
  if (/\bcuanto\s+(gast|pagu|invert|registr|cobr|ingres)\w*\s+(en|a|con|este|el|del|por)\b/.test(t)) return true;
  if (/\b(historial|listado|listame|mostr|enseñ|busca|dame|damelo|dame el)\b.*\b(pago|gasto|factura|registro|compra|operacion|ingreso|venta)/.test(t)) return true;
  if (/\b(he|llevo|tengo)\s+(pagado|gastado|invertido|registrado|cobrado|ingresado)\b/.test(t)) return true;
  if (/\b(pagué|pague|gasté|gaste|registré|registre|cobré|cobre)\b/.test(t)) return true;
  if (/\b(mi|mis)\s+(seguro|gimnasio|luz|electricidad|internet|cable|alquiler|hipoteca|carro|auto|telefono|celular|colegio|escuela|farmacia|medicament|gas|agua|servicio)\w*/.test(t)) return true;

  // 2) Mención de categoría DGI (escolares, medicos, alimentacion, etc.)
  //    + verbo o pregunta. Sin esto, palabras como "seguro" en
  //    "no estoy seguro" matchearían falsamente.
  if (_agMencionaCategoria(t)) {
    // Hay categoría → basta con que la oración parezca pregunta o pedido.
    if (/\?/.test(t)) return true;
    if (/^(que|cuanto|cuanta|cuantas|cuantos|cuando|como|donde|cual|cuales|hay|tengo|tenia|tenemos)\b/.test(t)) return true;
    if (/\b(muestra|muéstrame|muestrame|enseña|enseñame|listame|dame|busca|buscar|encuentra|necesito|quiero|quisiera)\b/.test(t)) return true;
    if (/\b(gaste|gasté|pague|pagué|llevo|he|tengo|cobre|cobré|registre|registré)\b/.test(t)) return true;
  }

  return false;
}

// ════════════════════════════════════════════════════════════════════
//  HANDLER PRINCIPAL — orquesta el loop con Claude
// ════════════════════════════════════════════════════════════════════

function _asesorGastosHandle(question, from, token, phoneId, intent) {
  _whatsappReply(from, '🔎 Revisando tus registros…', token, phoneId);
  try {
    // Cargar conversación previa si existe (TTL 10 min). Si viene un
    // intent del menú arrancamos fresh — el intent inicia un flujo
    // nuevo y mezclar thread anterior puede confundir a Claude.
    var prior = intent ? [] : (_agSesionLoad(from) || []);
    var resultado = _agConsultarConTools(question, prior, from, intent);
    if (!resultado || !resultado.texto) {
      _whatsappReply(from, '🤔 No pude armar una respuesta. Intenta reformular la pregunta.', token, phoneId);
      return true;
    }
    _whatsappReply(from, _agRender(resultado.texto), token, phoneId);
    // Persistir el thread actualizado para la próxima vuelta
    _agSesionSave(from, resultado.messages);
  } catch(err) {
    Logger.log('AsesorGastos error: ' + err.message + '\n' + (err.stack || ''));
    _whatsappReply(from, '⚠️ No pude procesar la consulta: ' + err.message, token, phoneId);
  }
  return true;
}

function _agRender(text) {
  // Agregar footer del menú si está disponible (Fase 1+) sin exceder
  // el límite de 4000 chars de WhatsApp. Si el cuerpo de la respuesta
  // es muy largo, mejor sacrificar el footer que truncar contenido.
  var body = String(text || '');
  var footer = (typeof botFooterMenu === 'function') ? botFooterMenu() : '';
  if (footer && (body.length + footer.length) <= 3990) {
    return (body + footer).substring(0, 4000);
  }
  return body.substring(0, 4000);
}

// ════════════════════════════════════════════════════════════════════
//  CAPA DATOS — carga de hojas + cache
// ════════════════════════════════════════════════════════════════════

function _agLoadDataset() {
  // Caching ligero (no usamos CacheService porque las filas pueden ser
  // muchas y superar el límite de 100KB por entry; usamos memo en
  // closure dentro de una misma invocación del Apps Script).
  if (_agLoadDataset.__memo) return _agLoadDataset.__memo;

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var egresos = _agLoadEgresos(ss);
  var ingresos = _agLoadIngresos(ss);

  var ds = { egresos: egresos, ingresos: ingresos };
  _agLoadDataset.__memo = ds;
  return ds;
}

function _agLoadEgresos(ss) {
  var sheet = ss.getSheetByName(SHEET_EGRESOS);
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow < 3) return [];
  var values = sheet.getRange(3, 1, lastRow - 2, EGRESOS_NCOLS).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var id = row[COL_E.ID - 1];
    if (!id) continue;
    var estado = String(row[COL_E.ESTADO - 1] || '').toLowerCase();
    // Excluir registros sin efecto contable (cancelados, rechazados,
    // anulados). Conservar aprobado, pendiente, registrado, etc —
    // algunos clientes registran sin aprobar y eso sigue contando.
    // Sin este filtro, el AsesorGastos toma egresos anulados como
    // activos y los reporta como duplicados de los reemplazos
    // (caso real: BATCH001-006 anulados vs BV2024-2029 vigentes).
    if (estado.indexOf('cancel') >= 0 || estado.indexOf('rechaz') >= 0 || estado.indexOf('anul') >= 0) continue;
    var fecha = _agParseDate(row[COL_E.FECHA_GASTO - 1] || row[COL_E.FECHA_REG - 1]);
    if (!fecha) continue;
    out.push({
      kind:        'egreso',
      id:          String(id),
      fecha:       fecha,
      fechaIso:    Utilities.formatDate(fecha, 'America/Panama', 'yyyy-MM-dd'),
      mes:         Utilities.formatDate(fecha, 'America/Panama', 'yyyy-MM'),
      total:       parseFloat(row[COL_E.TOTAL - 1]) || 0,
      subtotal:    parseFloat(row[COL_E.SUBTOTAL - 1]) || 0,
      itbms:       parseFloat(row[COL_E.ITBMS - 1]) || 0,
      categoria:   String(row[COL_E.CATEGORIA - 1] || ''),
      proveedor:   String(row[COL_E.PROVEEDOR - 1] || ''),
      ruc:         String(row[COL_E.RUC_PROV - 1] || ''),
      numFactura:  String(row[COL_E.NFACTURA - 1] || ''),
      descripcion: String(row[COL_E.DESCRIPCION - 1] || ''),
      tipoOp:      String(row[COL_E.TIPO_EGRESO - 1] || ''),
      alcance:     String(row[COL_E.ALCANCE - 1] || ''),
      estado:      estado,
      notas:       String(row[COL_E.NOTAS - 1] || '').substring(0, 200),
      driveUrl:    String(row[COL_E.DRIVE_URL - 1] || ''),
    });
  }
  return out;
}

function _agLoadIngresos(ss) {
  var sheet = ss.getSheetByName(CONFIG.SHEET_INGRESOS);
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow < 3) return [];
  var values = sheet.getRange(3, 1, lastRow - 2, INGRESOS_NCOLS).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var id = row[COL_I.ID_TRANS - 1];
    if (!id) continue;
    var estado = String(row[COL_I.ESTADO - 1] || '').toLowerCase();
    if (estado.indexOf('cancel') >= 0 || estado.indexOf('anul') >= 0) continue;
    var fecha = _agParseDate(row[COL_I.FECHA_INGRESO - 1] || row[COL_I.FECHA_REG - 1]);
    if (!fecha) continue;
    out.push({
      kind:        'ingreso',
      id:          String(id),
      fecha:       fecha,
      fechaIso:    Utilities.formatDate(fecha, 'America/Panama', 'yyyy-MM-dd'),
      mes:         Utilities.formatDate(fecha, 'America/Panama', 'yyyy-MM'),
      total:       parseFloat(row[COL_I.TOTAL - 1]) || 0,
      subtotal:    parseFloat(row[COL_I.SUBTOTAL - 1]) || 0,
      itbms:       parseFloat(row[COL_I.ITBMS - 1]) || 0,
      categoria:   String(row[COL_I.CATEGORIA - 1] || ''),
      proveedor:   String(row[COL_I.NOMBRE_CLI - 1] || ''),  // unificamos en "proveedor" = contraparte
      ruc:         String(row[COL_I.RUC_CLI - 1] || ''),
      numFactura:  String(row[COL_I.NUM_FACTURA - 1] || ''),
      descripcion: String(row[COL_I.DESCRIPCION - 1] || ''),
      tipoOp:      String(row[COL_I.TIPO_INGRESO - 1] || ''),
      alcance:     '',
      estado:      estado,
      notas:       String(row[COL_I.NOTAS_INT - 1] || '').substring(0, 200),
      driveUrl:    String(row[COL_I.DRIVE_URL - 1] || ''),
    });
  }
  return out;
}

function _agParseDate(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  var d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

// ════════════════════════════════════════════════════════════════════
//  FUZZY MATCH — normalización agresiva + matching multinivel
// ════════════════════════════════════════════════════════════════════

function _agNorm(s) {
  if (s == null) return '';
  return String(s)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')      // sin acentos
    .replace(/[^\w\s]/g, ' ')                              // sin puntuación
    .replace(/\s+/g, ' ')
    .trim();
}

function _agTokens(s) {
  var t = _agNorm(s).split(/\s+/).filter(function(x) { return x && !AG_STOPWORDS[x]; });
  // Expansión de abreviaturas comunes en Panamá → palabra completa
  return t.map(function(w) {
    if (w === 'fcias' || w === 'fcia') return 'farmacia';
    if (w === 'sup' || w === 'super') return 'supermercado';
    if (w === 'rest') return 'restaurante';
    if (w === 'col') return 'colegio';
    return w;
  });
}

// Score de matching entre needle (lo que pregunta el user) y haystack
// (un campo de la data). Devuelve 0..1. Estrategias en orden:
//   1.0  → match exacto normalizado
//   0.95 → needle es substring del haystack normalizado
//   0.9  → todos los tokens del needle están en el haystack (cualquier orden)
//   0..1 → Jaccard token overlap sobre el más grande
function _agMatchScore(needle, haystack) {
  var n = _agNorm(needle);
  var h = _agNorm(haystack);
  if (!n || !h) return 0;
  if (n === h) return 1.0;
  if (h.indexOf(n) >= 0 || n.indexOf(h) >= 0) return 0.95;
  var tn = _agTokens(needle);
  var th = _agTokens(haystack);
  if (!tn.length || !th.length) return 0;
  // Token containment: todos los tokens del needle aparecen
  // (matching parcial: el token del needle es prefijo de algún token del haystack
  // o vice versa — para tolerar "arrocha" ↔ "arroch" o plurales).
  var allIn = tn.every(function(nt) {
    return th.some(function(ht) {
      if (nt === ht) return true;
      if (nt.length >= 4 && ht.indexOf(nt) >= 0) return true;
      if (ht.length >= 4 && nt.indexOf(ht) >= 0) return true;
      return false;
    });
  });
  if (allIn) return 0.9;
  // Jaccard
  var setN = {}; tn.forEach(function(x) { setN[x] = 1; });
  var setH = {}; th.forEach(function(x) { setH[x] = 1; });
  var inter = 0, union = 0;
  var keys = {};
  Object.keys(setN).forEach(function(k) { keys[k] = 1; });
  Object.keys(setH).forEach(function(k) { keys[k] = 1; });
  Object.keys(keys).forEach(function(k) {
    union++;
    if (setN[k] && setH[k]) inter++;
  });
  return union === 0 ? 0 : inter / union;
}

// ════════════════════════════════════════════════════════════════════
//  CONSULTAS — implementación de los tools que ve Claude
// ════════════════════════════════════════════════════════════════════

function _agFiltrar(rows, filtros) {
  filtros = filtros || {};
  var minScore = filtros.proveedor ? 0.5 : 0;
  return rows.filter(function(r) {
    // Tipo: 'egreso' | 'ingreso' | undefined=ambos
    if (filtros.tipo === 'egreso'  && r.kind !== 'egreso')  return false;
    if (filtros.tipo === 'ingreso' && r.kind !== 'ingreso') return false;
    // Rango fechas
    if (filtros.fecha_desde) {
      var fd = _agParseDate(filtros.fecha_desde);
      if (fd && r.fecha < fd) return false;
    }
    if (filtros.fecha_hasta) {
      var fh = _agParseDate(filtros.fecha_hasta);
      if (fh) {
        // Inclusivo: hasta fin del día
        var fhEnd = new Date(fh.getTime() + 86400000 - 1);
        if (r.fecha > fhEnd) return false;
      }
    }
    // Categoría — exact normalized o substring
    if (filtros.categoria) {
      var nc = _agNorm(filtros.categoria);
      var rc = _agNorm(r.categoria);
      if (rc.indexOf(nc) < 0 && nc.indexOf(rc) < 0) return false;
    }
    // Alcance — 'negocio' | 'personal'
    if (filtros.alcance && r.alcance && _agNorm(r.alcance) !== _agNorm(filtros.alcance)) return false;
    // Proveedor — fuzzy match contra proveedor + descripción
    if (filtros.proveedor) {
      var sP = _agMatchScore(filtros.proveedor, r.proveedor);
      var sD = _agMatchScore(filtros.proveedor, r.descripcion);
      if (Math.max(sP, sD) < minScore) return false;
    }
    // Monto min/max
    if (filtros.monto_min != null && r.total < filtros.monto_min) return false;
    if (filtros.monto_max != null && r.total > filtros.monto_max) return false;
    return true;
  });
}

function _agToolBuscar(input) {
  var ds = _agLoadDataset();
  var all = (ds.egresos).concat(ds.ingresos);
  var matches = _agFiltrar(all, input);
  // Ordenar: más recientes primero
  matches.sort(function(a, b) { return b.fecha - a.fecha; });
  var limit = Math.min(parseInt(input.limit, 10) || AG_MAX_ROWS_OUT, AG_MAX_ROWS_OUT);
  var slim = matches.slice(0, limit).map(function(r) {
    var row = {
      id:          r.id,
      tipo:        r.kind,
      fecha:       r.fechaIso,
      total:       r.total,
      categoria:   r.categoria,
      proveedor:   r.proveedor,
      ruc:         r.ruc,
      num_factura: r.numFactura,
      descripcion: (r.descripcion || '').substring(0, 120),
      alcance:     r.alcance,
    };
    // Estado solo si NO es el estado "final" esperado — evita ruido.
    // Si está pendiente, borrador u otro estado intermedio, Claude
    // debe mencionarlo al cliente para que sepa el contexto.
    if (r.estado && r.estado !== 'registrado' && r.estado !== 'aprobado') {
      row.estado = r.estado;
    }
    // Notas (trazabilidad): origen del registro (BATCH-IMPORT, acreedor_auto,
    // reclasificaciones), confianza IA, etc. Útil cuando el cliente
    // pregunta "¿de dónde salió ese registro?" o el bot necesita
    // distinguir imports manuales de capturas por WhatsApp.
    if (r.notas) row.notas = r.notas;
    return row;
  });
  return {
    total_matches: matches.length,
    devueltos:     slim.length,
    operaciones:   slim,
  };
}

function _agToolAgregar(input) {
  var ds = _agLoadDataset();
  var all = (ds.egresos).concat(ds.ingresos);
  var matches = _agFiltrar(all, input);
  var groupBy = input.agrupar_por || 'total';   // 'total' | 'proveedor' | 'categoria' | 'mes' | 'tipo' | 'anio'
  if (groupBy === 'total') {
    var sum = 0, count = matches.length;
    var first = null, last = null;
    matches.forEach(function(r) {
      sum += r.total;
      if (!first || r.fecha < first) first = r.fecha;
      if (!last || r.fecha > last)   last  = r.fecha;
    });
    return {
      count: count,
      suma:  +sum.toFixed(2),
      primera_fecha: first ? Utilities.formatDate(first, 'America/Panama', 'yyyy-MM-dd') : null,
      ultima_fecha:  last  ? Utilities.formatDate(last,  'America/Panama', 'yyyy-MM-dd') : null,
    };
  }
  var groups = {};
  matches.forEach(function(r) {
    var key;
    if (groupBy === 'proveedor')      key = r.proveedor || '(sin proveedor)';
    else if (groupBy === 'categoria') key = r.categoria || '(sin categoria)';
    else if (groupBy === 'mes')       key = r.mes;
    else if (groupBy === 'anio')      key = r.mes.substring(0, 4);
    else if (groupBy === 'tipo')      key = r.kind;
    else                              key = '(otros)';
    if (!groups[key]) groups[key] = { count: 0, suma: 0, ultima_fecha: null };
    groups[key].count++;
    groups[key].suma += r.total;
    if (!groups[key].ultima_fecha || r.fecha > _agParseDate(groups[key].ultima_fecha)) {
      groups[key].ultima_fecha = r.fechaIso;
    }
  });
  // Ordenar grupos por suma desc
  var arr = Object.keys(groups).map(function(k) {
    return {
      grupo: k,
      count: groups[k].count,
      suma:  +groups[k].suma.toFixed(2),
      ultima_fecha: groups[k].ultima_fecha,
    };
  }).sort(function(a, b) { return b.suma - a.suma; }).slice(0, 30);
  return { agrupado_por: groupBy, grupos: arr, total_grupos: Object.keys(groups).length };
}

function _agToolListarProveedores(input) {
  var ds = _agLoadDataset();
  var all = (ds.egresos).concat(ds.ingresos);
  var patron = input.patron || '';
  var tipo = input.tipo;
  var counts = {};
  all.forEach(function(r) {
    if (tipo && r.kind !== tipo) return;
    var p = (r.proveedor || '').trim();
    if (!p) return;
    if (patron) {
      var s = Math.max(_agMatchScore(patron, p), _agMatchScore(patron, r.descripcion));
      if (s < 0.5) return;
    }
    if (!counts[p]) counts[p] = { count: 0, suma: 0, ultima: null };
    counts[p].count++;
    counts[p].suma += r.total;
    if (!counts[p].ultima || r.fecha > counts[p].ultima) counts[p].ultima = r.fecha;
  });
  var arr = Object.keys(counts).map(function(p) {
    return {
      proveedor: p,
      count: counts[p].count,
      suma:  +counts[p].suma.toFixed(2),
      ultima_fecha: Utilities.formatDate(counts[p].ultima, 'America/Panama', 'yyyy-MM-dd'),
    };
  }).sort(function(a, b) { return b.count - a.count; }).slice(0, 30);
  return { total_proveedores: Object.keys(counts).length, proveedores: arr };
}

// ────────────────────────────────────────────────────────────────────
//  Tool: detectar_duplicados
//  ──────────────────────────────────────────────────────────────────
//  Lógica EXPLÍCITA (no alucinada por el LLM): agrupa por
//  (fecha_iso + monto_redondeado_2dec + proveedor_normalizado + alcance)
//  y devuelve grupos con count > 1.
//
//  Reglas para considerar un grupo como duplicado sospechoso:
//    - Mismo día, mismo monto, mismo proveedor (después de normalizar),
//      mismo alcance (personal/negocio).
//    - Si los num_factura difieren, NO es duplicado — son operaciones
//      distintas que coincidieron en monto/fecha (legítimo).
//    - El más reciente queda marcado como "vigente"; los anteriores
//      como "candidatos a revisar".
//
//  Esto reemplaza el patrón anterior donde el LLM deducía duplicados
//  "a ojo" y a veces marcaba operaciones legítimas. El bug que motivó
//  esto fue: Claude reportó 6 BATCH001-006 anulados como duplicados
//  contra BV2024-2029 vigentes — los anulados ahora se filtran (fix
//  previo), pero falta este tool para que la detección sea
//  determinista cuando hay duplicados reales.
// ────────────────────────────────────────────────────────────────────
function _agToolDetectarDuplicados(input) {
  var ds = _agLoadDataset();
  // Solo egresos por ahora — duplicados de ingresos son raros.
  var rows = (input && input.incluir_ingresos) ? (ds.egresos).concat(ds.ingresos) : ds.egresos.slice();

  var groups = {};
  rows.forEach(function(r) {
    var prov = _agNorm(r.proveedor);
    if (!prov) prov = '(sin proveedor)';
    var key = r.fechaIso + '|' + r.total.toFixed(2) + '|' + prov + '|' + (r.alcance || '');
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  });

  var dupes = [];
  Object.keys(groups).forEach(function(k) {
    var arr = groups[k];
    if (arr.length < 2) return;

    // Si todos los num_factura son distintos y no vacíos, NO es duplicado.
    var facturas = arr.map(function(r) { return String(r.numFactura || '').trim(); }).filter(Boolean);
    if (facturas.length === arr.length && new Set(facturas).size === arr.length) return;

    // Ordenar por id (los IDs incluyen timestamp, así que ordena cronológicamente
    // por cuándo se REGISTRÓ, no por la fecha del gasto).
    arr.sort(function(a, b) { return String(a.id).localeCompare(String(b.id)); });
    var vigente = arr[arr.length - 1];
    var anteriores = arr.slice(0, -1);

    dupes.push({
      fecha:        arr[0].fechaIso,
      monto:        +arr[0].total.toFixed(2),
      proveedor:    arr[0].proveedor,
      alcance:      arr[0].alcance,
      total_copias: arr.length,
      vigente:      { id: vigente.id, categoria: vigente.categoria, notas: (vigente.notas || '').substring(0, 100) },
      candidatos_a_revisar: anteriores.map(function(r) {
        return { id: r.id, categoria: r.categoria, notas: (r.notas || '').substring(0, 100) };
      }),
    });
  });

  // Ordenar por monto descendente — los duplicados más significativos primero.
  dupes.sort(function(a, b) { return b.monto - a.monto; });

  return {
    total_grupos_duplicados: dupes.length,
    grupos:                  dupes.slice(0, 20),
    nota_metodologia:        'Agrupado por (fecha + monto + proveedor normalizado + alcance). Excluye registros anulados/cancelados/rechazados (no aparecen). Si dos registros con mismo monto y fecha tienen num_factura distintos, NO se reportan como duplicados.',
  };
}

function _agToolInfoDataset() {
  var ds = _agLoadDataset();
  var all = (ds.egresos).concat(ds.ingresos);
  if (!all.length) {
    return { vacio: true, mensaje: 'No hay operaciones registradas todavía.' };
  }
  var minF = all[0].fecha, maxF = all[0].fecha;
  var sumE = 0, sumI = 0;
  var cats = {};
  all.forEach(function(r) {
    if (r.fecha < minF) minF = r.fecha;
    if (r.fecha > maxF) maxF = r.fecha;
    if (r.kind === 'egreso')  { sumE += r.total; cats[r.categoria || '(sin cat)'] = (cats[r.categoria || '(sin cat)'] || 0) + r.total; }
    if (r.kind === 'ingreso') sumI += r.total;
  });
  var topCats = Object.keys(cats).map(function(c) { return { categoria: c, suma: +cats[c].toFixed(2) }; })
    .sort(function(a, b) { return b.suma - a.suma; }).slice(0, 12);
  return {
    fecha_min: Utilities.formatDate(minF, 'America/Panama', 'yyyy-MM-dd'),
    fecha_max: Utilities.formatDate(maxF, 'America/Panama', 'yyyy-MM-dd'),
    total_egresos:  ds.egresos.length,
    total_ingresos: ds.ingresos.length,
    suma_egresos:   +sumE.toFixed(2),
    suma_ingresos:  +sumI.toFixed(2),
    categorias_disponibles: topCats,
  };
}

// ════════════════════════════════════════════════════════════════════
//  TOOL DEFINITIONS — schema que ve Claude
// ════════════════════════════════════════════════════════════════════

function _agToolDefs(intent) {
  var commonFilters = {
    tipo:         { type: 'string', enum: ['egreso', 'ingreso'], description: 'Filtra por tipo. Omitir para incluir ambos.' },
    proveedor:    { type: 'string', description: 'Nombre del proveedor/contraparte. Fuzzy match (acepta variaciones: "Arrocha" matchea "FCIAS ARROCHA SA"). También busca en descripción.' },
    categoria:    { type: 'string', description: 'Categoría DGI (ej: salud, educacion, alimentacion, transporte, servicios). Substring case-insensitive.' },
    fecha_desde:  { type: 'string', description: 'ISO YYYY-MM-DD inclusivo.' },
    fecha_hasta:  { type: 'string', description: 'ISO YYYY-MM-DD inclusivo.' },
    alcance:      { type: 'string', enum: ['negocio', 'personal'], description: 'Solo aplica a egresos. Omitir para incluir todos.' },
    monto_min:    { type: 'number', description: 'Monto total mínimo USD.' },
    monto_max:    { type: 'number', description: 'Monto total máximo USD.' },
  };
  var tools = [
    {
      name: 'info_dataset',
      description: 'Devuelve metadata global: rango de fechas con data, totales globales de egresos/ingresos, y top categorías. Útil al principio para saber qué hay disponible.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'listar_proveedores',
      description: 'Lista proveedores distintos que matchean un patrón (fuzzy). Devuelve count + suma + última fecha por proveedor. Útil para verificar cómo está escrito un proveedor antes de hacer una búsqueda exacta. Si patron está vacío, devuelve los top 30 más frecuentes.',
      input_schema: {
        type: 'object',
        properties: {
          patron: { type: 'string', description: 'Texto a buscar en nombre de proveedor (fuzzy). Vacío = todos.' },
          tipo:   { type: 'string', enum: ['egreso', 'ingreso'] },
        },
      },
    },
    {
      name: 'buscar_operaciones',
      description: 'Busca operaciones individuales con filtros. Devuelve las primeras N (más recientes primero) y el total de matches. Útil para "cuándo fue la última vez..." o "muéstrame las facturas de X".',
      input_schema: {
        type: 'object',
        properties: Object.assign({}, commonFilters, {
          limit: { type: 'integer', description: 'Máximo de operaciones a devolver (default 30, max 30).' },
        }),
      },
    },
    {
      name: 'agregar_operaciones',
      description: 'Suma/cuenta operaciones agrupándolas. Útil para "cuánto he gastado", "cuántas veces", "cuánto por mes". Agrupar_por: total (sin grupo), proveedor, categoria, mes, anio, tipo.',
      input_schema: {
        type: 'object',
        properties: Object.assign({}, commonFilters, {
          agrupar_por: { type: 'string', enum: ['total', 'proveedor', 'categoria', 'mes', 'anio', 'tipo'], description: 'Default: total.' },
        }),
      },
    },
    {
      name: 'detectar_duplicados',
      description: 'Devuelve grupos de registros que parecen duplicados — agrupados por (fecha + monto + proveedor normalizado + alcance). Excluye automáticamente registros anulados/cancelados/rechazados, y descarta grupos donde los números de factura difieren (esos son legítimamente distintos). Marca el más reciente de cada grupo como "vigente" y los anteriores como "candidatos a revisar". USA SIEMPRE este tool cuando el usuario pregunte por duplicados — NUNCA deduzcas duplicación a ojo desde los resultados de buscar_operaciones.',
      input_schema: {
        type: 'object',
        properties: {
          incluir_ingresos: { type: 'boolean', description: 'Si true, también busca duplicados en ingresos. Default false (solo egresos, que es el caso común).' },
        },
      },
    },
    {
      name: 'analizar_salud_financiera',
      description: 'Genera un scorecard de salud financiera del cliente para un mes, comparando su distribución de gastos personales contra la regla 50/30/20 (Elizabeth Warren). Requiere que el cliente haya configurado su ingreso mensual previamente. Si devuelve necesita_configuracion=true, pídele al cliente que toque "Mi salud financiera" en el menú principal para configurarlo. NO inventes el ingreso ni los porcentajes — usa SIEMPRE este tool.',
      input_schema: {
        type: 'object',
        properties: {
          mes: { type: 'string', description: 'Mes en formato YYYY-MM (ej: 2026-05). Si se omite, analiza el mes pasado completo.' },
        },
      },
    },
    {
      name: 'resumen_deducibles_dgi',
      description: 'Devuelve el acumulado de deducibles personales del Form 90 DGI Panamá del cliente para un año fiscal. Desglosado por línea DP-1 (gastos médicos), DP-2 (gastos escolares), DP-3 (intereses hipotecarios), DP-4 (intereses préstamos educativos), DP-5 (gastos escolares discapacitados). Usa SIEMPRE este tool cuando el usuario pregunte por deducibles, Form 90, declaración anual DGI, "cuánto llevo deducible" o equivalentes. No inventes topes legales — sugiere al cliente contrastar con su contador.',
      input_schema: {
        type: 'object',
        properties: {
          anio_fiscal: { type: 'integer', description: 'Año fiscal a consultar (ej: 2026). Si se omite, usa el año actual.' },
        },
      },
    },
    {
      name: 'insights_proactivos',
      description: 'Devuelve insights proactivos del cliente: (a) pagos recurrentes detectados, (b) bills atrasados o próximos a vencer, (c) categorías con spending fuera del patrón habitual. Útil para preguntas tipo "¿qué pagos recurrentes tengo?", "¿hay algo raro en mis gastos?", "¿qué bills tengo pendientes?". No reportes alertas falsas — si arrays están vacíos, dilo claramente.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'mis_objetivos',
      description: 'Devuelve los objetivos financieros del cliente con progreso real: monto objetivo, monto acumulado, % avance, meta mensual sugerida, y comparación con su ahorro mensual real estimado (de salud financiera). Útil para preguntas tipo "¿cómo voy con mi objetivo de casa?", "¿cuánto falta para mi fondo de emergencia?", "¿llego a tiempo a mi meta?". Si el cliente no tiene objetivos configurados, sugiérele tocar "Mis objetivos" en el menú principal para plantear uno.',
      input_schema: { type: 'object', properties: {} },
    },
  ];

  // Tools de ESCRITURA — solo expuestos cuando el menú lo solicitó.
  // No los exponemos por defecto para evitar que Claude los llame
  // espontáneamente en preguntas de solo-lectura.
  if (intent && intent.kind === 'editar_categoria') {
    tools.push({
      name: 'cambiar_categoria_egreso',
      description: 'Cambia la categoría DGI de UN egreso ya registrado. Llama este tool SOLO después de que el usuario confirme expresamente con un "sí" / "confirmo" / "ok" / "procede" / "adelante" o equivalente. La frase del usuario debe ir en confirmacion_usuario textualmente.',
      input_schema: {
        type: 'object',
        properties: {
          id_egreso:            { type: 'string', description: 'ID del egreso a re-categorizar.' },
          nueva_categoria:      { type: 'string', description: 'Valor exacto de la categoría DGI (ej: gastos_medicos, gastos_escolares, alimentacion, transporte, servicios_basicos, alquileres).' },
          confirmacion_usuario: { type: 'string', description: 'Cita literal del mensaje donde el usuario confirma. Si no hay confirmación expresa NO llames este tool.' },
        },
        required: ['id_egreso', 'nueva_categoria', 'confirmacion_usuario'],
      },
    });
  }
  if (intent && intent.kind === 'editar_alcance') {
    tools.push({
      name: 'cambiar_alcance_egreso',
      description: 'Cambia el alcance (personal o negocio) de UN egreso. Solo después de confirmación expresa del usuario.',
      input_schema: {
        type: 'object',
        properties: {
          id_egreso:            { type: 'string' },
          nuevo_alcance:        { type: 'string', enum: ['negocio', 'personal'] },
          confirmacion_usuario: { type: 'string', description: 'Cita literal de la confirmación del usuario.' },
        },
        required: ['id_egreso', 'nuevo_alcance', 'confirmacion_usuario'],
      },
    });
  }
  return tools;
}

function _agEjecutarTool(name, input, fromPhone) {
  try {
    if (name === 'info_dataset')             return _agToolInfoDataset();
    if (name === 'listar_proveedores')       return _agToolListarProveedores(input || {});
    if (name === 'buscar_operaciones')       return _agToolBuscar(input || {});
    if (name === 'agregar_operaciones')      return _agToolAgregar(input || {});
    if (name === 'detectar_duplicados')      return _agToolDetectarDuplicados(input || {});
    if (name === 'analizar_salud_financiera') return (typeof _agToolSaludFinanciera === 'function') ? _agToolSaludFinanciera(input || {}) : { error: 'Tool no cargado' };
    if (name === 'resumen_deducibles_dgi')   return (typeof _agToolResumenDeducibles === 'function') ? _agToolResumenDeducibles(input || {}) : { error: 'Tool no cargado' };
    if (name === 'insights_proactivos')      return (typeof _agToolInsightsProactivos === 'function') ? _agToolInsightsProactivos(input || {}) : { error: 'Tool no cargado' };
    if (name === 'mis_objetivos')            return (typeof _agToolMisObjetivos === 'function') ? _agToolMisObjetivos(input || {}) : { error: 'Tool no cargado' };
    if (name === 'cambiar_categoria_egreso') return _agToolCambiarCategoria(input || {}, fromPhone);
    if (name === 'cambiar_alcance_egreso')   return _agToolCambiarAlcance(input || {}, fromPhone);
    return { error: 'Tool desconocido: ' + name };
  } catch(err) {
    Logger.log('Tool ' + name + ' ERROR: ' + err.message);
    return { error: err.message };
  }
}

// ────────────────────────────────────────────────────────────────────
//  Tools de ESCRITURA — solo invocados cuando el menú activa un intent
// ────────────────────────────────────────────────────────────────────

function _agToolCambiarCategoria(input, fromPhone) {
  var id = String(input.id_egreso || '').trim();
  var nuevaCat = String(input.nueva_categoria || '').trim();
  var confirmacion = String(input.confirmacion_usuario || '').trim();
  if (!id) return { ok: false, error: 'id_egreso requerido' };
  if (!nuevaCat) return { ok: false, error: 'nueva_categoria requerida' };
  if (!confirmacion) return { ok: false, error: 'Falta confirmacion_usuario. NO se aplicó el cambio.' };
  if (typeof _handleReclasificarEgreso !== 'function') {
    return { ok: false, error: 'Backend de reclasificación no disponible.' };
  }
  var resp = _handleReclasificarEgreso({ id_egreso: id, nuevo_tipo: nuevaCat }, null);
  var data;
  try { data = JSON.parse(resp.getContent()); }
  catch(_) { data = { success: false, error: 'Respuesta inválida del backend' }; }
  if (!data.success) return { ok: false, error: data.error || 'No se pudo aplicar el cambio.' };
  // Limpiar intent del menú tras éxito para no quedar atrapados en el flujo.
  if (fromPhone && typeof _menuClearIntent === 'function') _menuClearIntent(fromPhone);
  // Invalidar memo del dataset para que la próxima consulta refleje el cambio.
  try { delete _agLoadDataset.__memo; } catch(_) {}
  return {
    ok:                 true,
    id_egreso:          id,
    categoria_anterior: data.tipo_anterior,
    categoria_nueva:    data.tipo_nuevo,
    mensaje:            'Categoría actualizada correctamente.',
  };
}

function _agToolCambiarAlcance(input, fromPhone) {
  var id = String(input.id_egreso || '').trim();
  var nuevoAlc = String(input.nuevo_alcance || '').trim().toLowerCase();
  var confirmacion = String(input.confirmacion_usuario || '').trim();
  if (!id) return { ok: false, error: 'id_egreso requerido' };
  if (nuevoAlc !== 'negocio' && nuevoAlc !== 'personal') {
    return { ok: false, error: 'nuevo_alcance debe ser "negocio" o "personal"' };
  }
  if (!confirmacion) return { ok: false, error: 'Falta confirmacion_usuario. NO se aplicó el cambio.' };
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_EGRESOS);
    if (!sheet) return { ok: false, error: 'Hoja Egresos no encontrada' };
    var lastRow = sheet.getLastRow();
    if (lastRow <= 2) return { ok: false, error: 'Hoja Egresos vacía' };
    var data = sheet.getRange(3, 1, lastRow - 2, EGRESOS_NCOLS).getValues();
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][COL_E.ID - 1] || '').trim() !== id) continue;
      var rowNum = i + 3;
      var alcAnterior = String(data[i][COL_E.ALCANCE - 1] || 'negocio');
      if (alcAnterior === nuevoAlc) {
        if (fromPhone && typeof _menuClearIntent === 'function') _menuClearIntent(fromPhone);
        return { ok: true, id_egreso: id, alcance_anterior: alcAnterior, alcance_nuevo: nuevoAlc, mensaje: 'El alcance ya estaba en "' + nuevoAlc + '".' };
      }
      sheet.getRange(rowNum, COL_E.ALCANCE).setValue(nuevoAlc);
      var stamp = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm');
      var notasActual = String(sheet.getRange(rowNum, COL_E.NOTAS).getValue() || '');
      var notaCambio = 'Alcance: ' + alcAnterior + ' → ' + nuevoAlc + ' | ' + stamp + ' (WhatsApp)';
      sheet.getRange(rowNum, COL_E.NOTAS).setValue(notasActual ? notasActual + ' | ' + notaCambio : notaCambio);
      if (fromPhone && typeof _menuClearIntent === 'function') _menuClearIntent(fromPhone);
      try { delete _agLoadDataset.__memo; } catch(_) {}
      return {
        ok:               true,
        id_egreso:        id,
        alcance_anterior: alcAnterior,
        alcance_nuevo:    nuevoAlc,
        mensaje:          'Alcance actualizado correctamente.',
      };
    }
    return { ok: false, error: 'No encontré el egreso con id ' + id };
  } catch(err) {
    return { ok: false, error: err.message };
  }
}

// Bloque extra de system prompt que se inyecta cuando el AsesorGastos
// viene desde un tap del menú. Explica a Claude el flujo paso a paso
// y las condiciones para llamar al tool de escritura.
function _agIntentSystemPrompt(intent) {
  if (!intent || !intent.kind) return '';
  if (intent.kind === 'editar_categoria') {
    return (
      '\nCONTEXTO DEL MENÚ — el usuario tocó "Cambiar categoría".\n' +
      'Tu trabajo en este turno y los siguientes:\n' +
      '1) Identificar UN solo egreso a partir de la descripción del usuario (usa buscar_operaciones).\n' +
      '2) Si hay varios candidatos, lista hasta 5 numerados y pídele que elija "1", "2", etc.\n' +
      '3) Muestra el egreso seleccionado (proveedor, fecha, monto, categoría actual) y pregunta a qué categoría DGI lo quiere cambiar. Lista 8-10 opciones comunes con su nombre interno entre paréntesis: gastos_medicos, gastos_escolares, alimentacion, transporte, servicios_basicos, seguros, alquileres, mantenimiento, honorarios_servicios, otros_gastos.\n' +
      '4) Cuando el usuario elija categoría, muestra resumen "voy a cambiar X de A a B" y pide confirmación expresa ("sí" / "confirmo").\n' +
      '5) SOLO cuando confirme con un sí explícito, llama el tool cambiar_categoria_egreso con id_egreso, nueva_categoria (valor interno exacto) y confirmacion_usuario (lo que escribió el usuario).\n' +
      '6) Tras el tool, confirma con un mensaje corto: "✅ Listo. <Proveedor> ahora aparece como <nueva categoría>."\n'
    );
  }
  if (intent.kind === 'editar_alcance') {
    return (
      '\nCONTEXTO DEL MENÚ — el usuario tocó "Personal o negocio".\n' +
      'Flujo:\n' +
      '1) Identifica UN egreso (buscar_operaciones).\n' +
      '2) Si hay varios candidatos, lista hasta 5 numerados y pide elegir.\n' +
      '3) Muestra el egreso con su alcance actual y pregunta a cuál cambiarlo: "negocio" o "personal".\n' +
      '4) Pide confirmación expresa antes de aplicar.\n' +
      '5) Solo entonces llama cambiar_alcance_egreso con id_egreso, nuevo_alcance, confirmacion_usuario.\n' +
      '6) Confirma con un mensaje corto: "✅ Listo. Ahora ese gasto es <alcance>."\n'
    );
  }
  if (intent.kind === 'buscar') {
    return (
      '\nCONTEXTO DEL MENÚ — el usuario tocó "Buscar gasto/ingreso".\n' +
      'Su próximo mensaje describe qué quiere encontrar. Usa las tools de lectura para responder con la información solicitada. Si la pregunta es ambigua, pide una sola aclaración concreta.\n'
    );
  }
  return '';
}

// ════════════════════════════════════════════════════════════════════
//  CLAUDE TOOL LOOP
// ════════════════════════════════════════════════════════════════════

function _agConsultarConTools(question, priorMessages, fromPhone, intent) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY no configurada');

  var hoy = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd');
  var negocio = String(CONFIG.NEGOCIO || 'el cliente');

  var system =
    'Eres el asistente financiero de BalanceClip respondiendo preguntas sobre los GASTOS E INGRESOS REGISTRADOS de ' + negocio + ' por WhatsApp.\n\n' +
    'Hoy es ' + hoy + ' (zona Panamá).\n\n' +
    'Tienes herramientas (tools) para consultar la data real. Úsalas siempre — nunca inventes números.\n\n' +
    'TONO Y LENGUAJE:\n' +
    '• Español neutro panameño (tú/usted indistinto). EVITA vos/tenés/podés/querés/usá/sos/mandame.\n' +
    '• Imperativos: "puedes", "tienes", "envíame", "dime", "ve", "abre".\n\n' +
    'CONVERSACIÓN:\n' +
    '• Si el usuario manda una respuesta corta tipo "sí", "sí por favor", "ok", "y de mayo?", "muéstrame más", es una CONTINUACIÓN. Mira el historial para entender qué quería y responde directamente con esos datos. NO le pidas que reformule.\n' +
    '• Idealmente da una respuesta completa al primer intento. Solo pregunta si la opción es genuinamente ambigua.\n\n' +
    'ESTRATEGIA DE TOOLS:\n' +
    '1. Para preguntas sobre un proveedor específico, primero llama listar_proveedores con el patrón para ver cómo aparece escrito en la data; luego busca/agrega.\n' +
    '2. Si una búsqueda devuelve 0 resultados, amplía el patrón (más corto, sin acentos). La data en Panamá tiene variaciones ("Arrocha" vs "FCIAS ARROCHA" vs "Farmacia Arrocha SA").\n' +
    '3. "Cuándo fue la última vez" → buscar_operaciones + limit 1.\n' +
    '4. "Cuántos pagos he hecho" → agregar_operaciones con agrupar_por=total, filtrado por proveedor.\n' +
    '5. "Cuánto he gastado en X este mes" → agregar_operaciones con fecha_desde=primer día del mes y fecha_hasta=' + hoy + '.\n' +
    '6. Calcula los rangos de fecha (este mes, último año) a partir de hoy.\n' +
    '7. DUPLICADOS: cuando el usuario pregunte por "registros duplicados", "transacciones repetidas", "lo mismo dos veces", USA SIEMPRE el tool detectar_duplicados. NO deduzcas duplicación a ojo desde los resultados de buscar_operaciones — el LLM se equivoca con eso. El tool aplica criterios deterministas y los explica al usuario.\n\n' +
    'INTERPRETACIÓN DE LA DATA:\n' +
    '• Si un registro trae el campo "estado" significa que NO está en estado final (puede ser "pendiente", "borrador", etc). Menciónalo brevemente.\n' +
    '• Las "notas" contienen trazabilidad: "BATCH-IMPORT-*" = importado manualmente, "acreedor_auto" = capturado por IA, "Reclasificado: X → Y" = cambio anterior. Úsalas si el usuario pregunta el origen del registro.\n\n' +
    'FORMATO DE RESPUESTA:\n' +
    '• Mensaje de WhatsApp — conciso (4-8 líneas).\n' +
    '• Cifras exactas con 2 decimales y prefijo "$".\n' +
    '• Fechas en formato "15 may 2026" o "2026-05-15".\n' +
    '• Usa *bold* para cifras clave y viñetas con • para listas.\n' +
    '• Si encontraste data, da respuesta directa. Si no, dilo claro ("No encontré registros de X").\n' +
    '• No agregues advertencias legales/fiscales — esto es lookup de datos.\n';

  // Inyectar contexto del intent del menú si vino desde un tap.
  if (intent && intent.kind && typeof _agIntentSystemPrompt === 'function') {
    system += _agIntentSystemPrompt(intent);
  }

  // Construir messages: si hay thread previo, lo continuamos; sino arranca limpio.
  var messages = (priorMessages && priorMessages.length) ? priorMessages.slice() : [];
  messages.push({ role: 'user', content: question });
  var tools = _agToolDefs(intent);
  var lastText = '';
  var totalIn = 0, totalOut = 0, totalToolCalls = 0;
  var startMs = Date.now();

  for (var iter = 0; iter < AG_MAX_TOOL_ITER; iter++) {
    var payload = {
      model:      AG_ASESOR_MODEL,
      max_tokens: AG_MAX_TOKENS,
      system:     system,
      tools:      tools,
      messages:   messages,
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
      var body = res.getContentText().substring(0, 500);
      Logger.log('Claude AsesorGastos error ' + code + ': ' + body);
      throw new Error('Claude HTTP ' + code);
    }
    var data = JSON.parse(res.getContentText());
    var content = data.content || [];
    var stopReason = data.stop_reason || '';

    // Acumular usage de tokens para tracking de costo
    if (data.usage) {
      totalIn  += data.usage.input_tokens  || 0;
      totalOut += data.usage.output_tokens || 0;
    }

    // Extraer text para usar como fallback si el loop se acaba
    content.forEach(function(b) { if (b.type === 'text' && b.text) lastText += b.text; });

    // Si no hay tool_use → terminó
    var toolUses = content.filter(function(b) { return b.type === 'tool_use'; });
    if (stopReason !== 'tool_use' || !toolUses.length) {
      var textOut = '';
      content.forEach(function(b) { if (b.type === 'text') textOut += b.text; });
      messages.push({ role: 'assistant', content: content });   // persistir respuesta final en el thread
      _agRegistrarCosto(totalIn, totalOut, totalToolCalls, Date.now() - startMs, question);
      return { texto: (textOut.trim() || lastText.trim() || '(sin respuesta)'), messages: messages };
    }
    totalToolCalls += toolUses.length;

    // Persistir el turn assistant (con sus tool_use) en messages
    messages.push({ role: 'assistant', content: content });

    // Ejecutar tools y armar tool_result
    var toolResults = toolUses.map(function(tu) {
      var result = _agEjecutarTool(tu.name, tu.input, fromPhone);
      var json = JSON.stringify(result);
      // Cap por tool_result: 12KB por entry para evitar prompts gigantes
      if (json.length > 12000) json = json.substring(0, 12000) + '... [truncado]';
      Logger.log('AsesorGastos tool ' + tu.name + ' input=' + JSON.stringify(tu.input).substring(0, 200));
      return { type: 'tool_result', tool_use_id: tu.id, content: json };
    });
    messages.push({ role: 'user', content: toolResults });
  }

  // Si llegamos acá es porque agotamos el loop sin end_turn
  Logger.log('AsesorGastos: loop agotado (' + AG_MAX_TOOL_ITER + ' iter)');
  _agRegistrarCosto(totalIn, totalOut, totalToolCalls, Date.now() - startMs, question);
  return { texto: (lastText.trim() || 'No pude terminar de procesar la consulta (timeout interno). Probá reformular la pregunta.'), messages: messages };
}

// ════════════════════════════════════════════════════════════════════
//  TRACKING DE COSTO
//  ──────────────────────────────────────────────────────────────────
//  Acumula tokens + costo USD por mes (clave AG_USAGE_YYYY-MM) y
//  lifetime (clave AG_USAGE_LIFETIME). Locking para evitar lost
//  updates si dos consultas corren en paralelo. Pricing Sonnet 4.6
//  cacheado arriba — recalcular si Anthropic cambia tarifas.
// ════════════════════════════════════════════════════════════════════

function _agRegistrarCosto(inTokens, outTokens, toolCalls, durMs, question) {
  var costUsd = inTokens * AG_PRICE_IN_PER_TOKEN + outTokens * AG_PRICE_OUT_PER_TOKEN;
  Logger.log('AsesorGastos cost: in=' + inTokens + 't out=' + outTokens + 't ' +
    'tools=' + toolCalls + ' dur=' + durMs + 'ms cost=$' + costUsd.toFixed(4) +
    ' q="' + String(question || '').substring(0, 60) + '"');

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(2000);
    var props = PropertiesService.getScriptProperties();
    var ym = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM');
    _agMergeUsage(props, 'AG_USAGE_' + ym,      inTokens, outTokens, costUsd, toolCalls);
    _agMergeUsage(props, 'AG_USAGE_LIFETIME',   inTokens, outTokens, costUsd, toolCalls);
  } catch(e) {
    Logger.log('AG cost tracking error: ' + e.message);
  } finally {
    try { lock.releaseLock(); } catch(_) {}
  }
}

function _agMergeUsage(props, key, inTok, outTok, costUsd, toolCalls) {
  var raw = props.getProperty(key);
  var d = raw ? JSON.parse(raw) : { queries: 0, in_tokens: 0, out_tokens: 0, cost_usd: 0, tool_calls: 0 };
  d.queries++;
  d.in_tokens   += inTok;
  d.out_tokens  += outTok;
  d.cost_usd    = +(d.cost_usd + costUsd).toFixed(6);
  d.tool_calls  += toolCalls;
  props.setProperty(key, JSON.stringify(d));
}

// Reporte legible — corré desde el editor del GAS de cualquier cliente.
function _agMostrarCosto() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var keys = Object.keys(all).filter(function(k) { return k.indexOf('AG_USAGE_') === 0; }).sort();
  Logger.log('═══ COSTO ASESOR GASTOS — ' + (CONFIG && CONFIG.NEGOCIO || '?') + ' ═══');
  if (!keys.length) { Logger.log('(sin uso registrado todavía)'); return; }
  keys.forEach(function(k) {
    var d = JSON.parse(all[k]);
    var avg = d.queries > 0 ? (d.cost_usd / d.queries) : 0;
    Logger.log(k + ': ' +
      d.queries + ' queries, ' +
      d.tool_calls + ' tool calls, ' +
      'in=' + d.in_tokens.toLocaleString() + 't ' +
      'out=' + d.out_tokens.toLocaleString() + 't, ' +
      'total=$' + d.cost_usd.toFixed(4) + ', ' +
      'avg=$' + avg.toFixed(4) + '/query');
  });
}

// ════════════════════════════════════════════════════════════════════
//  ENDPOINT PÚBLICO — lee el tracking acumulado para el panel /admin
// ════════════════════════════════════════════════════════════════════

function _handleGetAsesorCosto(params, callback) {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var meses = [];
  var lifetime = null;
  Object.keys(all).filter(function(k) { return k.indexOf('AG_USAGE_') === 0; }).sort()
    .forEach(function(k) {
      var d;
      try { d = JSON.parse(all[k]); } catch(_) { return; }
      var entry = {
        periodo:    k.replace('AG_USAGE_', ''),
        queries:    d.queries     || 0,
        tool_calls: d.tool_calls  || 0,
        in_tokens:  d.in_tokens   || 0,
        out_tokens: d.out_tokens  || 0,
        cost_usd:   +(d.cost_usd  || 0).toFixed(6),
      };
      if (entry.periodo === 'LIFETIME') lifetime = entry;
      else                              meses.push(entry);
    });
  var result = {
    ok:           true,
    negocio:      String(CONFIG.NEGOCIO || ''),
    lifetime:     lifetime || { queries:0, tool_calls:0, in_tokens:0, out_tokens:0, cost_usd:0 },
    meses:        meses,
    pricing: {
      model:    AG_ASESOR_MODEL,
      in_per_mtok:  3.0,
      out_per_mtok: 15.0,
    },
  };
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// Borra el tracking — usar con cuidado, no recupera data histórica.
function _agResetCosto() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var dropped = 0;
  Object.keys(all).filter(function(k) { return k.indexOf('AG_USAGE_') === 0; })
    .forEach(function(k) { props.deleteProperty(k); dropped++; });
  Logger.log('AsesorGastos: reseteadas ' + dropped + ' claves de uso.');
}

// ════════════════════════════════════════════════════════════════════
//  HELPERS DE TESTING — ejecutar desde el editor de Apps Script
// ════════════════════════════════════════════════════════════════════

function _agTestPregunta(q) {
  if (!q) q = '¿Cuándo fue la última vez que tuve un gasto?';
  Logger.log('Pregunta: ' + q);
  var resp = _agConsultarConTools(q, [], null, null);
  Logger.log('Respuesta:\n' + (resp && resp.texto));
}

function _agTestDeteccion() {
  var ejemplos = [
    '¿Cuándo fue la última vez que pagué mi seguro de hospitalización?',
    '¿Cuántos pagos he hecho al Colegio Las Esclavas?',
    '¿Cuánto he gastado este mes en Farmacias Arrocha?',
    'cuando pague luz?',
    'cuantas veces fui al doctor',
    'mi gimnasio cuanto cuesta',
    'hola',                 // no
    'manda el menu',        // no
    'gracias',              // no
  ];
  ejemplos.forEach(function(e) {
    Logger.log((_asesorGastosEsPregunta(e) ? '✓' : '✗') + '  ' + e);
  });
}

// ════════════════════════════════════════════════════════════════════
//  MEMORIA DE CONVERSACIÓN
//  ──────────────────────────────────────────────────────────────────
//  CacheService por phone con TTL 10 min. Guarda el messages array
//  completo del thread Claude (incluyendo tool_use y tool_result) para
//  que mensajes cortos tipo "si", "y de mayo?", "muestrame mas" sean
//  continuaciones naturales en vez de queries aislados.
//
//  Cap defensivo: si el thread serializado > 90KB (límite Cache 100KB
//  por entry), no guardamos — la próxima vuelta empieza fresh. Esto
//  evita errores en conversaciones muy largas y limita el costo
//  acumulado de re-enviar contexto.
// ════════════════════════════════════════════════════════════════════

var AG_SESION_TTL_SEC = 10 * 60;     // 10 min
var AG_SESION_MAX_BYTES = 90 * 1024; // 90KB
var AG_SESION_KEY_PREFIX = 'AGS_';

function _agSesionKey(from) {
  return AG_SESION_KEY_PREFIX + String(from || '').replace(/\D/g, '');
}

function _agSesionSave(from, messages) {
  if (!from || !messages || !messages.length) return;
  try {
    var json = JSON.stringify(messages);
    if (json.length > AG_SESION_MAX_BYTES) {
      Logger.log('AG sesión too big (' + json.length + 'B) — skip save, next msg starts fresh');
      _agSesionClear(from);
      return;
    }
    CacheService.getScriptCache().put(_agSesionKey(from), json, AG_SESION_TTL_SEC);
  } catch(e) {
    Logger.log('AG sesión save error: ' + e.message);
  }
}

function _agSesionLoad(from) {
  if (!from) return null;
  try {
    var raw = CacheService.getScriptCache().get(_agSesionKey(from));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch(e) {
    Logger.log('AG sesión load error: ' + e.message);
    return null;
  }
}

function _agSesionClear(from) {
  if (!from) return;
  try { CacheService.getScriptCache().remove(_agSesionKey(from)); }
  catch(_) {}
}

function _agSesionActiva(from) {
  return _agSesionLoad(from) !== null;
}

// Heurística: es un buen candidato a continuación? Texto corto,
// no es un comando claro, no es un intent de mandar media.
// Llamado desde WhatsApp.gs solo cuando ya hay sesión activa.
function _agEsContinuacion(text) {
  var t = String(text || '').trim();
  if (!t) return false;
  if (t.length > 250) return false;                                     // mensaje largo = probablemente nuevo tema
  if (/^\s*(menu|menú|hola|ayuda|help|test|cancelar|salir|adios|adiós|chao)\s*$/i.test(t)) return false;
  if (/\b(factura|foto|pdf|recibo|imagen|comprobante)\b/i.test(t)) return false;  // quiere mandar media
  return true;
}
