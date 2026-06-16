// ═══════════════════════════════════════════════════════════════
//  BalanceClip — GAS CENTRAL
//  Proyecto independiente — 1 solo para todos los clientes
//  v1.0 — skeleton inicial
//
//  ARQUITECTURA:
//    n8n → GAS Central (este archivo)
//      → _clasificarArchivos (Haiku)
//      → _parsearFacturaCeyco / _parsearFacturaCosto (Sonnet)
//      → matching ítem-ítem
//      → GAS Cliente (delgado) → escritura en Sheets
//
//  CONTRATO doPost:
//    {
//      cliente:  "ceyco",           // identificador del cliente
//      pdfs:     [ { nombre, base64, mime } ],
//      mes:      "ENERO 2026",
//      contexto: { ... }            // opcional — datos extra por cliente
//    }
//
//  RESPUESTA:
//    { success, cliente, resultado: { st, ingresos, egresos, ... }, error }
//
//  SCRIPT PROPERTIES requeridas:
//    CLAUDE_API_KEY   — clave compartida para todos los clientes
//
//  GAS CLIENTE CEYCO (delgado — solo escritura):
//    https://script.google.com/macros/s/AKfycbwLGTYAbIhEdbMIbKLZekngmMI62bGG9KprhtO-opQ2DoF8H5UOTCz6R2qBllf2FVBtOw/exec
// ═══════════════════════════════════════════════════════════════

// ── REGISTRO DE CLIENTES ──────────────────────────────────────
// Agregar un cliente nuevo = añadir 1 entrada aquí + crear su GAS delgado.
var CLIENTES = {
  ceyco: {
    nombre:     'CEYCO',
    gas_url:    'https://script.google.com/macros/s/AKfycbwLGTYAbIhEdbMIbKLZekngmMI62bGG9KprhtO-opQ2DoF8H5UOTCz6R2qBllf2FVBtOw/exec',
    ruc:        '2470636-1-814806',   // RUC del cliente (para identificar su factura)
    prefijo_st: 'ST-CEY',             // prefijo para IDs de ST generados
    prefijo_ing:'ING-CEY',
    prefijo_egr:'EGR-CEY',
  },
  // cliente2: { ... }   ← Fase 4: agregar aquí
};

// ── MODELOS CLAUDE ────────────────────────────────────────────
var BC_MODEL_CLASIFICAR = 'claude-haiku-4-5-20251001';   // barato, rápido
var BC_MODEL_PARSEAR    = 'claude-sonnet-4-6';    // preciso

// ═══════════════════════════════════════════════════════════════
//  _extractJsonObj — parser robusto de JSON desde respuestas Claude
//  Strip ```json fences, luego recorta del primer { al último }
//  para tolerar texto explicativo después del objeto (común en
//  Sonnet 4.6, que es más verboso que su predecesor).
// ═══════════════════════════════════════════════════════════════
function _extractJsonObj(text) {
  var t = String(text || '').replace(/```json|```/g, '').trim();
  var s = t.indexOf('{'), e = t.lastIndexOf('}');
  return JSON.parse(s >= 0 && e > s ? t.substring(s, e + 1) : t);
}

// ═══════════════════════════════════════════════════════════════
//  WEB APP ENTRY POINT
// ═══════════════════════════════════════════════════════════════

function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({
      status:  'OK',
      service: 'BalanceClip GAS Central v1.0',
      ts:      new Date().toISOString(),
      clientes: Object.keys(CLIENTES),
    }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var result = { success: false, cliente: null, resultado: null, error: null };
  try {
    var data    = JSON.parse(e.postData.contents);
    // DEBUG temporal
    Logger.log('=== doPost recibido ===');
    Logger.log('cliente: ' + data.cliente);
    Logger.log('mes: ' + data.mes);
    Logger.log('n pdfs: ' + (data.pdfs || []).length);
    for (var d = 0; d < (data.pdfs || []).length; d++) {
      Logger.log('  pdf[' + d + ']: nombre=' + data.pdfs[d].nombre + 
                 ' | mime=' + data.pdfs[d].mime + 
                 ' | b64len=' + (data.pdfs[d].base64 || '').length);
    }
    // FIN DEBUG
    var cliente = String(data.cliente || '').toLowerCase().trim();
    var pdfs    = data.pdfs    || [];   // [ { nombre, base64, mime } ]
    var mes     = data.mes     || '';
    var contexto= data.contexto|| {};

    Logger.log('doPost — cliente: ' + cliente + ' | pdfs: ' + pdfs.length + ' | mes: ' + mes);

    result.cliente = cliente;

    // ── Validaciones ─────────────────────────────────────────
    if (!CLIENTES[cliente]) throw new Error('Cliente desconocido: "' + cliente + '"');
    if (!pdfs.length)       throw new Error('pdfs[] vacío — se requiere al menos 1 archivo');
    if (!mes)               throw new Error('mes requerido (ej: "ENERO 2026")');

    var cfg = CLIENTES[cliente];

    // ── PASO 1: Clasificar archivos ───────────────────────────
    Logger.log('PASO 1: Clasificando ' + pdfs.length + ' archivo(s)...');
    var clasificacion = _clasificarArchivos(pdfs, cfg);
    Logger.log('Clasificación: ' + JSON.stringify(_resumirClasificacion(clasificacion)));

    // ── PASO 2: Parsear factura del cliente ───────────────────
    var facturaCeyco = _buscarPorTipo(clasificacion, 'factura_ceyco');
    if (!facturaCeyco) throw new Error('No se encontró factura del cliente en los archivos');

    Logger.log('PASO 2: Parseando factura cliente (' + facturaCeyco.nombre + ')...');
    var parsedCeyco = _parsearFacturaCeyco(facturaCeyco.base64, facturaCeyco.mime);
    Logger.log('Factura cliente: ' + JSON.stringify({
      num_factura: parsedCeyco.num_factura,
      cliente:     parsedCeyco.cliente,
      total:       parsedCeyco.total,
      n_items:     (parsedCeyco.items || []).length,
    }));

    // ── PASO 3: Parsear facturas de costo ────────────────────
    var facturasCosto = _filtrarPorTipo(clasificacion, 'factura_costo');
    Logger.log('PASO 3: Parseando ' + facturasCosto.length + ' factura(s) de costo...');
    var parsedCostos = [];
    for (var i = 0; i < facturasCosto.length; i++) {
      try {
        var pc = _parsearFacturaCosto(facturasCosto[i].base64, facturasCosto[i].mime, facturasCosto[i].nombre);
        parsedCostos.push(pc);
        Logger.log('  Costo [' + i + ']: ' + pc.proveedor + ' | $' + pc.total);
      } catch (parseErr) {
        Logger.log('  ⚠️ Error parseando costo [' + i + ']: ' + parseErr.message);
        parsedCostos.push({ _error: parseErr.message, _nombre: facturasCosto[i].nombre });
      }
    }

    // ── PASO 4: Matching ítem-ítem ────────────────────────────
    Logger.log('PASO 4: Matching ítem-ítem...');
    var matching = _matchingItems(parsedCeyco.items || [], parsedCostos, cfg);

    // ── PASO 5: Calcular costos y construir filas ─────────────
    Logger.log('PASO 5: Calculando costos...');
    var filas = _construirFilas(parsedCeyco, parsedCostos, matching, mes, cfg);

    // ── PASO 6: Enviar al GAS Cliente delgado ────────────────
    Logger.log('PASO 6: Enviando a GAS Cliente ' + cfg.nombre + '...');
    var gasResp = _enviarAGasCliente(cfg.gas_url, {
      action:    'escribirRegistros',
      cliente:   cliente,
      mes:       mes,
      st:        filas.st,
      ingresos:  filas.ingresos,
      egresos:   filas.egresos,
      st_items:  filas.st_items,
    });

    Logger.log('GAS Cliente resp: ' + JSON.stringify(gasResp));

    result.success   = true;
    result.resultado = {
      st:           filas.st,
      n_ingresos:   filas.ingresos.length,
      n_egresos:    filas.egresos.length,
      n_st_items:   filas.st_items.length,
      n_warnings:   matching.warnings.length,
      warnings:     matching.warnings,
      gas_resp:     gasResp,
    };

  } catch (err) {
    result.error = err.message;
    Logger.log('❌ Error doPost: ' + err.message);
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════
//  PASO 1 — CLASIFICAR ARCHIVOS con Haiku
// ═══════════════════════════════════════════════════════════════

// Tipos posibles: factura_ceyco | factura_costo | voucher | nota_credito | ignorar
function _clasificarArchivos(pdfs, cfg) {
  // DEBUG temporal
  Logger.log('Archivos recibidos:');
  for (var d = 0; d < pdfs.length; d++) {
    Logger.log('  [' + d + '] nombre: ' + pdfs[d].nombre + ' | mime: ' + pdfs[d].mime + ' | base64 length: ' + (pdfs[d].base64 || '').length);
  }
  var apiKey = _getApiKey();
  var clasificados = [];

  for (var i = 0; i < pdfs.length; i++) {
    var archivo = pdfs[i];
    var nombre  = String(archivo.nombre || '').toLowerCase();
    var mime    = String(archivo.mime   || 'application/pdf');
    var base64  = archivo.base64 || '';

    // Guard: extensiones a ignorar sin llamar a Claude
    if (nombre.indexOf('.msg') !== -1 || nombre.indexOf('.eml') !== -1) {
      clasificados.push({ nombre: archivo.nombre, base64: base64, mime: mime, tipo: 'ignorar', razon: 'extension_ignorada' });
      continue;
    }

    // Clasificar con Haiku
    try {
      var tipo = _llamarClaudeClasificar(base64, mime, nombre, cfg.ruc, apiKey);
      clasificados.push({ nombre: archivo.nombre, base64: base64, mime: mime, tipo: tipo });
      Logger.log('  [' + i + '] ' + archivo.nombre + ' → ' + tipo);
    } catch (err) {
      Logger.log('  [' + i + '] Error clasificando ' + archivo.nombre + ': ' + err.message);
      clasificados.push({ nombre: archivo.nombre, base64: base64, mime: mime, tipo: 'desconocido', _error: err.message });
    }
  }

  // Post-proceso: si hay factura_ceyco identificada, promover desconocidos a factura_costo
  var hayFacturaCeyco = clasificados.some(function(c) { return c.tipo === 'factura_ceyco'; });
  if (hayFacturaCeyco) {
    for (var j = 0; j < clasificados.length; j++) {
      if (clasificados[j].tipo === 'desconocido') {
        clasificados[j].tipo   = 'factura_costo';
        clasificados[j].razon  = 'promovido_fallback';
        Logger.log('  Promovido a factura_costo (fallback): ' + clasificados[j].nombre);
      }
    }
  }

  return clasificados;
}

function _llamarClaudeClasificar(base64, mime, nombre, rucCliente, apiKey) {

  // ── Pre-check por nombre — sin gastar tokens ──────────────────
  // Patrón DGI: 01_01_0000000NNN_001_0000.pdf → siempre factura_ceyco
  if (/^\d{2}_\d{2}_\d{7,}_\d{3}_\d{4}/.test(nombre)) return 'factura_ceyco';

  // Inferir por nombre antes de llamar a Haiku
  var tipoNombre = _inferirTipoPorNombre(nombre);
  if (tipoNombre !== 'desconocido') return tipoNombre;

  // ── Clasificar con Haiku (solo si no se pudo inferir) ────────
  var contentBlock = _buildContentBlock(base64, mime);

  var prompt =
    'CEYCO tiene RUC ' + rucCliente + ' (Consultores Electrotecnicos y Contratistas).\n\n' +
    'Clasifica este documento. Responde SOLO con una de estas palabras:\n' +
    '  factura_ceyco   — factura fiscal DGI donde CEYCO (RUC ' + rucCliente + ') es el EMISOR.\n' +
    '                    El RUC aparece en la cabecera como el que EMITE/VENDE.\n' +
    '                    El receptor es el cliente final.\n' +
    '  nota_credito    — nota de crédito DGI emitida por CEYCO. Anula una factura.\n' +
    '  factura_costo   — factura de proveedor o courier cobrada A CEYCO:\n' +
    '                    facturas de Dimyeen, TME, Mouser, DHL, FedEx, etc.\n' +
    '                    Proforma Invoice (PI) de proveedor extranjero.\n' +
    '  voucher         — comprobante de pago (Yappy, ACH, transferencia).\n' +
    '  desconocido     — orden de compra, declaración de aduana, cotización.\n\n' +
    'Una sola palabra, sin puntuación.\n' +
    'Nombre del archivo: ' + nombre;

  var payload = {
    model:      BC_MODEL_CLASIFICAR,
    max_tokens: 10,
    messages: [{
      role:    'user',
      content: [ contentBlock, { type: 'text', text: prompt } ],
    }],
  };

  var resp = _claudeFetch(payload, apiKey);
  var tipo = resp.trim().toLowerCase().replace(/[^a-z_]/g, '');

  var TIPOS_VALIDOS = ['factura_ceyco', 'factura_costo', 'voucher', 'nota_credito', 'desconocido'];
  return TIPOS_VALIDOS.indexOf(tipo) >= 0 ? tipo : 'desconocido';
}

// ── Inferir tipo por nombre de archivo — sin tokens ──────────
function _inferirTipoPorNombre(nombre) {
  var n = nombre.toLowerCase();
  // Ignorar
  if (/orden.de.compra|purchase.order|liquidacion|declaracion|aduana|formulario/.test(n)) return 'ignorar';
  // Nota de crédito
  if (/^fe04/.test(n) || /nota.de.credito|nota_credito|notacredito|credit.note/.test(n))  return 'nota_credito';
  if (/^nc[\s_\-]\d+/.test(n))                                                             return 'nota_credito';
  // Factura CEYCO — patrón DGI
  if (/^fe01/.test(n))                          return 'factura_ceyco';
  if (/^\d{2}_\d{2}_\d{7,}/.test(nombre))      return 'factura_ceyco';
  // Voucher
  if (/deposito|transferencia|comprobante|banco|pago|voucher|yappy|ach/.test(n)) return 'voucher';
  // Factura de costo — proveedores conocidos y PI
  if (/dhl|fedex|ups|flete|tme|mouser|digikey|dimyeen|phoenix|electrisa|miguelez/.test(n)) return 'factura_costo';
  if (/^pi[\s_\-]/.test(n) || /\bpi\b/.test(n))  return 'factura_costo';
  if (/invoice|bill/.test(n))                     return 'factura_costo';
  return 'desconocido';
}

// ═══════════════════════════════════════════════════════════════
//  PASO 2 — PARSEAR FACTURA DEL CLIENTE con Sonnet
// ═══════════════════════════════════════════════════════════════

function _parsearFacturaCeyco(base64, mime) {
  var apiKey = _getApiKey();

  var prompt =
    'Eres un extractor de facturas panameñas (DGI e-Tax 2.0). ' +
    'Analiza esta factura emitida por el cliente y responde SOLO con JSON válido, sin markdown:\n' +
    '{\n' +
    '  "num_factura": "",\n' +
    '  "fecha": "YYYY-MM-DD",\n' +
    '  "cliente": "",\n' +
    '  "ruc_cliente": "",\n' +
    '  "dv_cliente": "",\n' +
    '  "subtotal": 0,\n' +
    '  "itbms": 0,\n' +
    '  "total": 0,\n' +
    '  "items": [\n' +
    '    { "descripcion": "", "codigo": "", "cantidad": 1, "precio_unitario": 0, "itbms_item": 0, "total_item": 0 }\n' +
    '  ]\n' +
    '}\n\n' +
    'REGLAS:\n' +
    '1. num_factura = número de la factura emitida\n' +
    '2. cliente = nombre del RECEPTOR (quien compra)\n' +
    '3. ruc_cliente = RUC del receptor. En facturas DGI: "N-20-606 DV 09" → ruc="N-20-606", dv="09"\n' +
    '4. codigo = código de producto si existe en la factura (columna separada o primera línea del item)\n' +
    '5. Montos como números, null si no existe el campo\n' +
    '6. Si el item no tiene código visible, usar null (no inventar)';

  var payload = {
    model:      BC_MODEL_PARSEAR,
    max_tokens: 2000,
    messages: [{
      role:    'user',
      content: [ _buildContentBlock(base64, mime), { type: 'text', text: prompt } ],
    }],
  };

  var text   = _claudeFetchConRetry(payload, _getApiKey(), 3);
  var parsed = _extractJsonObj(text);
  return parsed;
}

// ═══════════════════════════════════════════════════════════════
//  PASO 3 — PARSEAR FACTURA DE COSTO con Sonnet
// ═══════════════════════════════════════════════════════════════

function _parsearFacturaCosto(base64, mime, nombreArchivo) {
  var prompt =
    'Extrae datos del EMISOR y los ítems de esta factura de costo para CEYCO.\n\n' +
    'Responde SOLO con JSON válido, sin markdown:\n' +
    '{\n' +
    '  "num_factura": "referencia o número",\n' +
    '  "fecha": "YYYY-MM-DD",\n' +
    '  "proveedor": "nombre del emisor",\n' +
    '  "ruc_proveedor": null,\n' +
    '  "dv_proveedor": null,\n' +
    '  "es_extranjero": false,\n' +
    '  "es_general": false,\n' +
    '  "subtotal": 0.00,\n' +
    '  "itbms": 0.00,\n' +
    '  "total": 0.00,\n' +
    '  "total_bruto": 0.00,\n' +
    '  "itbm_credito": 0.00,\n' +
    '  "itbm_mercancias": 0.00,\n' +
    '  "es_courier_importacion": false,\n' +
    '  "moneda": "USD",\n' +
    '  "items": [\n' +
    '    {\n' +
    '      "codigo": "código principal del ítem",\n' +
    '      "codigo_alt": null,\n' +
    '      "descripcion": "descripción",\n' +
    '      "cantidad": 1,\n' +
    '      "precio_unitario": 0.00,\n' +
    '      "itbms": 0.00,\n' +
    '      "total": 0.00\n' +
    '    }\n' +
    '  ]\n' +
    '}\n\n' +
    'REGLAS CRÍTICAS:\n' +
    '1. codigo: valor en columnas "Part No.", "Part Number", "Ref.", "SKU", "Code",\n' +
    '   "Symbol", "Article No.", "Item No.", "Catalog No.", "Order No." o similares.\n' +
    '   Solo null si el ítem genuinamente no tiene ninguna referencia.\n' +
    '2. codigo_alt: si un ítem tiene DOS referencias, extraer ambas.\n' +
    '   Ejemplo: "68569354 / FS450R12KE3" → codigo="68569354", codigo_alt="FS450R12KE3"\n' +
    '3. es_general = true SOLO si NINGÚN ítem tiene código de producto.\n' +
    '   Si hay ítems con código → es_general=false aunque también haya ítems sin código.\n' +
    '4. es_courier_importacion = true si es factura DHL/FedEx/UPS con impuestos de importación.\n' +
    '5. Para facturas DHL/FedEx con sello DGI panameño:\n' +
    '   - total_bruto = TOTAL final del documento\n' +
    '   - itbm_mercancias = SUMA de líneas cuya etiqueta sea exactamente ITBM, ITBMS,\n' +
    '     I.T.B.M.S o variantes. NO incluir IMP, MISCELANEOS, arancel, derechos.\n' +
    '   - itbm_credito = mismo valor que itbm_mercancias\n' +
    '   - total = total_bruto - itbm_mercancias\n' +
    '   Ejemplo DHL PC259052: si total_bruto=52.39 e itbm_mercancias=28.85 → total=23.54\n' +
    '6. Extraer TODOS los ítems incluyendo líneas de envío y manejo:\n' +
    '   - SHIPPING COST, HANDLING FEE, FREIGHT, FLETE, TRANSPORT → codigo=null\n' +
    '   - Ejemplo Dimyeen: {codigo:null, descripcion:"SHIPPING COST", cantidad:1, precio_unitario:160, total:160}\n' +
    '   - Ejemplo Dimyeen: {codigo:null, descripcion:"HANDLING FEE", cantidad:1, precio_unitario:32.19, total:32.19}\n' +
    '   - NO omitir estas líneas aunque no tengan código de producto.\n' +
    '7. Montos como números. null solo si realmente no es visible.\n' +
    'Nombre del archivo: ' + (nombreArchivo || '');

  var payload = {
    model:      BC_MODEL_PARSEAR,
    max_tokens: 2000,
    messages: [{
      role:    'user',
      content: [ _buildContentBlock(base64, mime), { type: 'text', text: prompt } ],
    }],
  };

  var text   = _claudeFetchConRetry(payload, _getApiKey(), 3);
  var parsed = _extractJsonObj(text);
  return parsed;
}

// ═══════════════════════════════════════════════════════════════
//  PASO 4 — MATCHING ÍTEM-A-ÍTEM
// ═══════════════════════════════════════════════════════════════

function _matchingItems(itemsCeyco, parsedCostos, cfg) {
  var CONFIANZA_MINIMA = 70;
  var resultado  = [];
  var warnings   = [];
 
  // ── 1. Separar facturas con ítems de producto vs. generales ──
  // Generales = sin códigos de producto (flete, aduana, DHL puros)
  var facturasConItems  = [];
  var facturasGenerales = [];
  for (var c = 0; c < parsedCostos.length; c++) {
    var pc = parsedCostos[c];
    if (pc._error) continue;
    var tieneCodigosProducto = !pc.es_general &&
      (pc.items || []).some(function(it) { return !!it.codigo; });
    if (tieneCodigosProducto) {
      facturasConItems.push({ datos: pc, idx: c });
    } else {
      facturasGenerales.push({ datos: pc, idx: c });
    }
  }
 
  // ── 2. Construir índice de ítems de costo por código normalizado ──
  var mapaCodigoCosto = {};
  for (var fi = 0; fi < facturasConItems.length; fi++) {
    var fc = facturasConItems[fi];
    (fc.datos.items || []).forEach(function(item) {
      if (item.es_envio) return;  // shipping/handling no va al mapa de código
      if (item.codigo) {
        var cNorm = _normalizarCodigo(item.codigo);
        if (cNorm && !mapaCodigoCosto[cNorm]) {
          mapaCodigoCosto[cNorm] = { item: item, facturaDatos: fc.datos, idx: fc.idx };
        }
      }
    });
  }
 
  // ── 3. Matching ítem-a-ítem (factura CEYCO vs costos) ────────
  var itemsCostoUsados = {};
  for (var i = 0; i < itemsCeyco.length; i++) {
    var itemC      = itemsCeyco[i];
    var codigoCeyco= itemC.codigo || '';
    var codigoNorm = _normalizarCodigo(codigoCeyco);
    var matchObj   = null;
    var confianza  = 0;
    var metodo     = '';
 
    // A) Match exacto por código
    if (codigoNorm && mapaCodigoCosto[codigoNorm] && !itemsCostoUsados[codigoNorm]) {
      matchObj  = mapaCodigoCosto[codigoNorm];
      confianza = 100;
      metodo    = 'codigo_exacto';
      itemsCostoUsados[codigoNorm] = true;
    }
 
    // B) Fallback: similaridad de descripción
    if (!matchObj && (itemC.descripcion || '').trim()) {
      var descNormC = _normalizarDesc(itemC.descripcion);
      var mejorSim  = 0;
      var mejorMatch= null;
      for (var fi2 = 0; fi2 < facturasConItems.length; fi2++) {
        var fc2 = facturasConItems[fi2];
        (fc2.datos.items || []).forEach(function(item2) {
          if (item2.es_envio || !item2.descripcion) return;
          var sim = _similaridad(descNormC, _normalizarDesc(item2.descripcion));
          if (sim > mejorSim) {
            mejorSim   = sim;
            mejorMatch = { item: item2, facturaDatos: fc2.datos, idx: fc2.idx };
          }
        });
      }
      if (mejorSim >= CONFIANZA_MINIMA) {
        matchObj  = mejorMatch;
        confianza = Math.round(mejorSim);
        metodo    = 'descripcion';
      }
    }
 
    if (matchObj) {
      resultado.push({
        item_ceyco:   itemC,
        item_costo:   matchObj.item,
        parsed_costo: matchObj.facturaDatos,
        idx_factura:  matchObj.idx,
        confianza:    confianza,
        metodo:       metodo,
        tipo_venta:   'venta_directa',
        es_envio:     false,
      });
    } else {
      warnings.push({
        codigo:      itemC.codigo      || null,
        descripcion: itemC.descripcion || '',
        total:       itemC.total_item  || 0,
      });
      resultado.push({
        item_ceyco:   itemC,
        item_costo:   null,
        parsed_costo: null,
        idx_factura:  -1,
        confianza:    0,
        metodo:       'sin_match',
        tipo_venta:   'warning',
        es_envio:     false,
      });
    }
  }
 
  // ── 3b. Extraer ítems de envío/manejo sin código ─────────────
  // Migrado de ContaFacil_ImportarHistorial.gs bloque 3b
  // SHIPPING COST, HANDLING FEE, etc. — líneas sin código en
  // facturas de proveedor extranjero. Se crean como ST_Items
  // separados de tipo shipping_handling.
  var _envioRE = /shipping|handling|freight|flete|manejo|cargo|fee|transport/i;
 
  for (var fj = 0; fj < facturasConItems.length; fj++) {
    var fcj = facturasConItems[fj];
    (fcj.datos.items || []).forEach(function(item) {
      // Solo ítems sin código o marcados explícitamente como envío
      if (item.codigo && !item.es_envio) return;
      var desc      = String(item.descripcion || '').trim();
      if (!desc) return;
      var totalItem = parseFloat(item.total || item.precio_unitario || '0') || 0;
      if (totalItem <= 0) return;
 
      // Incluir si tiene flag es_envio O si la descripción parece envío/manejo
      var esEnvio = item.es_envio || _envioRE.test(desc);
      if (!esEnvio) return;
 
      resultado.push({
        item_ceyco:   null,
        item_costo:   item,
        parsed_costo: fcj.datos,
        idx_factura:  fcj.idx,
        confianza:    100,
        metodo:       'envio_explicito',
        tipo_venta:   'venta_directa',
        es_envio:     true,
        envio_desc:   desc + ' — ' + (fcj.datos.proveedor || ''),
        envio_total:  totalItem,
      });
    });
  }
 
  // ── 4. Agregar facturas generales (DHL, aduana, flete puro) ──
  // Estas ya se manejan en _construirFilas como costos_generales
  // Las marcamos para que _construirFilas las procese correctamente
  for (var fg = 0; fg < facturasGenerales.length; fg++) {
    var fcg = facturasGenerales[fg];
    resultado.push({
      item_ceyco:   null,
      item_costo:   null,
      parsed_costo: fcg.datos,
      idx_factura:  fcg.idx,
      confianza:    100,
      metodo:       'costo_general',
      tipo_venta:   'venta_directa',
      es_envio:     false,
      es_general:   true,
    });
  }
 
  return { items: resultado, warnings: warnings };
}

// ═══════════════════════════════════════════════════════════════
//  PASO 5 — CONSTRUIR FILAS para el GAS Cliente
// ═══════════════════════════════════════════════════════════════

function _construirFilas(parsedCeyco, parsedCostos, matching, mes, cfg) {
  var ahora    = new Date();
  var fechaReg = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
  var ts       = Utilities.formatDate(ahora, 'America/Panama', 'yyyyMMddHHmmss');
 
  // ── Determinar tipo de venta del ST ──────────────────────────
  var tipoVenta = 'venta_directa';
  if (matching.warnings.length > 0) tipoVenta = 'warning';
 
  var idST = cfg.prefijo_st + '-' + ts;
 
  // ── ST ────────────────────────────────────────────────────────
  var st = {
    id_st:        idST,
    mes:          mes,
    num_factura:  parsedCeyco.num_factura || '',
    cliente:      parsedCeyco.cliente     || '',
    ruc_cliente:  parsedCeyco.ruc_cliente || '',
    dv_cliente:   parsedCeyco.dv_cliente  || '',
    total_venta:  parsedCeyco.total       || 0,
    estado:       tipoVenta,
    tipo_venta:   tipoVenta,
    fecha_reg:    fechaReg,
  };
 
  // ── INGRESO ───────────────────────────────────────────────────
  var totalVenta  = parseFloat(parsedCeyco.total)    || 0;
  var itbmsCey    = parseFloat(parsedCeyco.itbms)    || 0;
  var subtotalCey = parseFloat(parsedCeyco.subtotal) ||
                    parseFloat((totalVenta / 1.07).toFixed(2));
 
  var ingreso = {
    id_trans:     cfg.prefijo_ing + '-' + ts,
    fecha_reg:    fechaReg,
    estado:       'pendiente',
    num_factura:  parsedCeyco.num_factura || '',
    cliente:      parsedCeyco.cliente     || '',
    ruc_cliente:  parsedCeyco.ruc_cliente || '',
    dv_cliente:   parsedCeyco.dv_cliente  || '',
    subtotal:     subtotalCey,
    itbms:        itbmsCey,
    total:        totalVenta,
    mes:          mes,
    id_st:        idST,
  };
 
  // ── ST_ITEMS + EGRESOS ────────────────────────────────────────
  var st_items = [];
  var egresos  = [];
  var seqItem  = 0;
 
  // Rastrear facturas ya procesadas para evitar egresos duplicados
  var facturasEgresoCreado = {};
 
  for (var i = 0; i < matching.items.length; i++) {
    var m = matching.items[i];
    seqItem++;
    var itemId   = idST + '-ITEM-' + String(seqItem).padStart(3, '0');
    var egresoId = cfg.prefijo_egr + '-' + ts + '-' + String(seqItem).padStart(3, '0');
 
    // ── Caso 1: ítem de producto matcheado ───────────────────
    if (!m.es_envio && !m.es_general && m.tipo_venta === 'venta_directa' && m.item_costo) {
      var totalCosto  = parseFloat(m.item_costo.total_item || m.item_costo.total || '0') || 0;
      var itbmsCosto  = parseFloat(m.item_costo.itbms || '0') || 0;
      var subCosto    = totalCosto > 0
        ? parseFloat((totalCosto / 1.07).toFixed(2))
        : parseFloat((totalCosto - itbmsCosto).toFixed(2));
 
      st_items.push({
        id:            itemId,
        id_st:         idST,
        tipo:          'producto',
        descripcion:   m.item_ceyco.descripcion || '',
        codigo:        m.item_ceyco.codigo       || '',
        proveedor:     m.parsed_costo ? m.parsed_costo.proveedor    : '',
        num_fac_costo: m.parsed_costo ? m.parsed_costo.num_factura  : '',
        total_cot:     m.item_ceyco.total_item   || 0,
        total_real:    totalCosto,
        confianza:     m.confianza,
        metodo:        m.metodo,
        egreso_id:     egresoId,
      });
 
      // Crear egreso por producto (1 egreso por factura de costo, no por ítem)
      var idxFac = m.idx_factura;
      if (m.parsed_costo && !facturasEgresoCreado['prod_' + idxFac]) {
        var pc = m.parsed_costo;
        // Sumar todos los ítems con código de esta factura
        var totalFacturaProd = (pc.items || []).reduce(function(s, it) {
          if (it.codigo && !it.es_envio) return s + (parseFloat(it.total || it.total_item || '0') || 0);
          return s;
        }, 0);
        if (totalFacturaProd <= 0) totalFacturaProd = parseFloat(pc.total || '0') || 0;
        var itbmsF  = parseFloat(pc.itbms || '0') || 0;
        var subF    = totalFacturaProd > 0
          ? parseFloat((totalFacturaProd / 1.07).toFixed(2))
          : parseFloat((totalFacturaProd - itbmsF).toFixed(2));
 
        egresos.push({
          id:          egresoId,
          fecha_reg:   fechaReg,
          estado:      'registrado',
          tipo_egreso: 'costo_servicio_tecnico',
          categoria:   'costo_servicio_tecnico',
          proveedor:   pc.proveedor     || '',
          ruc_prov:    pc.ruc_proveedor || '',
          dv_prov:     pc.dv_proveedor  || '',
          num_fac:     pc.num_factura   || '',
          subtotal:    subF,
          itbms:       itbmsF,
          total:       totalFacturaProd,
          descripcion: m.item_ceyco.descripcion || '',
          notas:       'ST: ' + idST + ' | Producto matcheado | Confianza: ' + m.confianza + '%',
          id_st_item:  itemId,
          mes:         mes,
        });
        facturasEgresoCreado['prod_' + idxFac] = egresoId;
      }
    }
 
    // ── Caso 2: ítem de envío/manejo (SHIPPING COST, HANDLING FEE) ──
    else if (m.es_envio && m.item_costo) {
      var totalEnvio = m.envio_total || parseFloat(m.item_costo.total || m.item_costo.total_item || '0') || 0;
      var subEnvio   = totalEnvio > 0 ? parseFloat((totalEnvio / 1.07).toFixed(2)) : 0;
      var itbEnvio   = totalEnvio > 0 ? parseFloat((totalEnvio - subEnvio).toFixed(2)) : 0;
 
      st_items.push({
        id:            itemId,
        id_st:         idST,
        tipo:          'shipping_handling',
        descripcion:   m.envio_desc || (m.item_costo.descripcion + ' — ' + (m.parsed_costo ? m.parsed_costo.proveedor : '')),
        codigo:        '',
        proveedor:     m.parsed_costo ? m.parsed_costo.proveedor   : '',
        num_fac_costo: m.parsed_costo ? m.parsed_costo.num_factura : '',
        total_cot:     totalEnvio,
        total_real:    totalEnvio,
        confianza:     100,
        metodo:        m.metodo,
        egreso_id:     egresoId,
      });
 
      egresos.push({
        id:          egresoId,
        fecha_reg:   fechaReg,
        estado:      'registrado',
        tipo_egreso: 'shipping_handling',
        categoria:   'shipping_handling',
        proveedor:   m.parsed_costo ? m.parsed_costo.proveedor    : '',
        ruc_prov:    m.parsed_costo ? m.parsed_costo.ruc_proveedor: '',
        dv_prov:     m.parsed_costo ? m.parsed_costo.dv_proveedor : '',
        num_fac:     m.parsed_costo ? m.parsed_costo.num_factura  : '',
        subtotal:    subEnvio,
        itbms:       itbEnvio,
        total:       totalEnvio,
        descripcion: m.envio_desc || (m.item_costo.descripcion || ''),
        notas:       'ST: ' + idST + ' | Envío/manejo',
        id_st_item:  itemId,
        mes:         mes,
      });
    }
 
    // ── Caso 3: costo general (DHL puro, aduana, flete sin ítems) ──
    else if (m.es_general && m.parsed_costo) {
      var pc2      = m.parsed_costo;
      var totalGen = parseFloat(pc2.total || '0') || 0;
      if (totalGen <= 0) continue;
 
      var itbmsGen = parseFloat(pc2.itbms || '0') || 0;
      var subGen   = totalGen > 0 ? parseFloat((totalGen / 1.07).toFixed(2)) : 0;
      var tipoGen  = pc2.es_courier_importacion ? 'impuesto' : 'shipping_handling';
 
      st_items.push({
        id:            itemId,
        id_st:         idST,
        tipo:          tipoGen,
        descripcion:   (pc2.proveedor || '') + ' — costo general',
        codigo:        '',
        proveedor:     pc2.proveedor     || '',
        num_fac_costo: pc2.num_factura   || '',
        total_cot:     totalGen,
        total_real:    totalGen,
        confianza:     100,
        metodo:        'costo_general',
        egreso_id:     egresoId,
      });
 
      egresos.push({
        id:          egresoId,
        fecha_reg:   fechaReg,
        estado:      'registrado',
        tipo_egreso: tipoGen,
        categoria:   tipoGen,
        proveedor:   pc2.proveedor     || '',
        ruc_prov:    pc2.ruc_proveedor || '',
        dv_prov:     pc2.dv_proveedor  || '',
        num_fac:     pc2.num_factura   || '',
        subtotal:    subGen,
        itbms:       itbmsGen,
        total:       totalGen,
        descripcion: 'Costo general ST: ' + idST,
        notas:       'ST: ' + idST + ' | Costo general (' + tipoGen + ')',
        id_st_item:  itemId,
        mes:         mes,
      });
 
      // Crédito fiscal ITBM (DHL/FedEx con impuesto de importación)
      var itbmCred = parseFloat(pc2.itbm_credito || pc2._itbm_credito || '0') || 0;
      if (itbmCred > 0) {
        seqItem++;
        var itemIdCred = idST + '-ITBM-' + String(seqItem).padStart(3, '0');
        var egresoCred = cfg.prefijo_egr + '-ITBM-' + ts + '-' + String(seqItem).padStart(3, '0');
 
        st_items.push({
          id:            itemIdCred,
          id_st:         idST,
          tipo:          'credito_fiscal',
          descripcion:   'ITBM importación — ' + (pc2.proveedor || ''),
          codigo:        '',
          proveedor:     pc2.proveedor   || '',
          num_fac_costo: pc2.num_factura || '',
          total_cot:     itbmCred,
          total_real:    itbmCred,
          confianza:     100,
          metodo:        'itbm_importacion',
          egreso_id:     egresoCred,
        });
 
        egresos.push({
          id:          egresoCred,
          fecha_reg:   fechaReg,
          estado:      'registrado',
          tipo_egreso: 'credito_fiscal',
          categoria:   'credito_fiscal',
          proveedor:   pc2.proveedor     || '',
          ruc_prov:    pc2.ruc_proveedor || '',
          dv_prov:     pc2.dv_proveedor  || '',
          num_fac:     pc2.num_factura   || '',
          subtotal:    itbmCred,
          itbms:       0,
          total:       itbmCred,
          descripcion: 'Crédito fiscal ITBM importación',
          notas:       'ST: ' + idST + ' | Factura: ' + (pc2.num_factura || '') + ' | ITBM importación',
          id_st_item:  itemIdCred,
          mes:         mes,
        });
      }
    }
 
    // ── Caso 4: warning (sin match) ───────────────────────────
    else if (m.tipo_venta === 'warning') {
      st_items.push({
        id:            itemId,
        id_st:         idST,
        tipo:          'otro',
        descripcion:   m.item_ceyco.descripcion || '',
        codigo:        m.item_ceyco.codigo       || '',
        proveedor:     '',
        num_fac_costo: '',
        total_cot:     m.item_ceyco.total_item   || 0,
        total_real:    0,
        confianza:     0,
        metodo:        'sin_match',
        egreso_id:     '',
      });
    }
  }
 
  return {
    st:       st,
    ingresos: [ingreso],
    egresos:  egresos,
    st_items: st_items,
  };
}

// ═══════════════════════════════════════════════════════════════
//  PASO 6 — ENVIAR AL GAS CLIENTE DELGADO
// ═══════════════════════════════════════════════════════════════

function _enviarAGasCliente(gasUrl, payload) {
  var options = {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true,
  };
  var response = UrlFetchApp.fetch(gasUrl, options);
  var code     = response.getResponseCode();
  if (code !== 200) {
    throw new Error('GAS Cliente respondió con código ' + code + ': ' +
                    response.getContentText().substring(0, 200));
  }
  return JSON.parse(response.getContentText());
}

// ═══════════════════════════════════════════════════════════════
//  HELPERS — Claude API
// ═══════════════════════════════════════════════════════════════

function _getApiKey() {
  var key = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!key) throw new Error('CLAUDE_API_KEY no configurada en Script Properties');
  return key;
}

function _buildContentBlock(base64, mime) {
  if (mime === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } };
  }
  var validImg = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  var imgMime  = validImg.indexOf(mime) >= 0 ? mime : 'image/jpeg';
  return { type: 'image', source: { type: 'base64', media_type: imgMime, data: base64 } };
}

function _claudeFetch(payload, apiKey) {
  var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method:             'post',
    contentType:        'application/json',
    headers:            { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  var code = response.getResponseCode();
  if (code !== 200) {
    throw new Error('Claude API error ' + code + ': ' +
                    response.getContentText().substring(0, 300));
  }

  var respData = JSON.parse(response.getContentText());
  var text     = '';
  var content  = respData.content || [];
  for (var i = 0; i < content.length; i++) {
    if (content[i].type === 'text') { text = content[i].text; break; }
  }
  return text;
}

// Retry con backoff para errores 529/500/503/429
function _claudeFetchConRetry(payload, apiKey, maxIntentos) {
  var intentos = maxIntentos || 3;
  var backoffMs = 15000;  // 15 segundos entre intentos

  for (var intento = 1; intento <= intentos; intento++) {
    try {
      var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
        method:             'post',
        contentType:        'application/json',
        headers:            { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        payload:            JSON.stringify(payload),
        muteHttpExceptions: true,
      });

      var code = response.getResponseCode();

      // Éxito
      if (code === 200) {
        var respData = JSON.parse(response.getContentText());
        var text     = '';
        var content  = respData.content || [];
        for (var i = 0; i < content.length; i++) {
          if (content[i].type === 'text') { text = content[i].text; break; }
        }
        return text;
      }

      // Errores retriables
      var RETRIABLE = [429, 500, 503, 529];
      if (RETRIABLE.indexOf(code) >= 0 && intento < intentos) {
        Logger.log('⚠️ Claude API error ' + code + ' — intento ' + intento + '/' + intentos + '. Reintentando en ' + (backoffMs/1000) + 's...');
        Utilities.sleep(backoffMs);
        continue;
      }

      // Error no retriable o último intento
      throw new Error('Claude API error ' + code + ': ' + response.getContentText().substring(0, 300));

    } catch (fetchErr) {
      if (intento < intentos) {
        Logger.log('⚠️ Excepción en intento ' + intento + ': ' + fetchErr.message + '. Reintentando...');
        Utilities.sleep(backoffMs);
      } else {
        throw fetchErr;
      }
    }
  }

  throw new Error('Claude API: agotados ' + intentos + ' intentos');
}

// ═══════════════════════════════════════════════════════════════
//  HELPERS — Matching
// ═══════════════════════════════════════════════════════════════

function _normalizarCodigo(codigo) {
  if (!codigo) return '';
  return String(codigo)
    .toUpperCase()
    .replace(/^WM-/i, '')    // strip prefijo Weidmüller "WM-"
    .replace(/[-\s.]/g, '')  // strip guiones, espacios, puntos
    .trim();
}

function _normalizarDesc(desc) {
  if (!desc) return '';
  return String(desc)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Similaridad de Jaccard sobre trigramas
function _similaridad(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 100;

  function trigramas(s) {
    var tris = {};
    for (var i = 0; i <= s.length - 3; i++) {
      tris[s.slice(i, i + 3)] = true;
    }
    return tris;
  }

  var tA = trigramas(a);
  var tB = trigramas(b);

  var interseccion = 0;
  for (var t in tA) {
    if (tB[t]) interseccion++;
  }

  var union = Object.keys(tA).length + Object.keys(tB).length - interseccion;
  if (union === 0) return 0;
  return Math.round((interseccion / union) * 100);
}

// ═══════════════════════════════════════════════════════════════
//  HELPERS — Clasificación
// ═══════════════════════════════════════════════════════════════

function _buscarPorTipo(clasificados, tipo) {
  for (var i = 0; i < clasificados.length; i++) {
    if (clasificados[i].tipo === tipo) return clasificados[i];
  }
  return null;
}

function _filtrarPorTipo(clasificados, tipo) {
  return clasificados.filter(function(c) { return c.tipo === tipo; });
}

function _resumirClasificacion(clasificados) {
  var resumen = {};
  for (var i = 0; i < clasificados.length; i++) {
    var t = clasificados[i].tipo;
    resumen[t] = (resumen[t] || 0) + 1;
  }
  return resumen;
}

// ═══════════════════════════════════════════════════════════════
//  TEST LOCAL — ejecutar desde el editor de GAS para probar
// ═══════════════════════════════════════════════════════════════

function _testHealthCheck() {
  var resp = doGet({});
  Logger.log(resp.getContent());
}

// Para probar el flujo completo con datos reales:
// 1. Obtener base64 de los PDFs de CEYCO
// 2. Llamar: _testParsearFacturaCeyco(base64, 'application/pdf')
// 3. Llamar: _testParsearFacturaCosto(base64, 'application/pdf', 'nombre.pdf')
function _testParsearFacturaCeyco(base64, mime) {
  var result = _parsearFacturaCeyco(base64, mime);
  Logger.log(JSON.stringify(result, null, 2));
}

function _testParsearFacturaCosto(base64, mime, nombre) {
  var result = _parsearFacturaCosto(base64, mime, nombre);
  Logger.log(JSON.stringify(result, null, 2));
}

function _testFlujoCEYCO() {
  // ── Cargar los 3 PDFs desde Drive ─────────────────────────
  var archivos = [
    { id: '1jAm31hxIkZ4OW6vlVawB2XlyyNRPbKVd', nombre: '01_01_0000000535_001_0000.pdf' },
    { id: '1xULH7ioGuQzUU5qk8aVGneolx89Uz6LB', nombre: 'PI - 20260324 Dimyeen Copy.pdf' },
    { id: '17t6FPfA4cEWySlnabj-JjjFIsZIvk0CQ', nombre: 'DHL FACT 535.pdf'              },
  ];

  var pdfs = [];
  for (var i = 0; i < archivos.length; i++) {
    var file   = DriveApp.getFileById(archivos[i].id);
    var base64 = Utilities.base64Encode(file.getBlob().getBytes());
    pdfs.push({
      nombre: archivos[i].nombre,
      base64: base64,
      mime:   'application/pdf',
    });
    Logger.log('✅ Cargado: ' + archivos[i].nombre + ' (' + base64.length + ' chars)');
  }

  // ── Llamar directamente al flujo BC (sin pasar por doPost) ─
  var cfg = CLIENTES['ceyco'];
  var mes = 'MARZO 2026';

  Logger.log('PASO 1: Clasificando...');
  var clasificacion = _clasificarArchivos(pdfs, cfg);
  Logger.log('Clasificación: ' + JSON.stringify(_resumirClasificacion(clasificacion)));
  for (var c = 0; c < clasificacion.length; c++) {
    Logger.log('  ' + clasificacion[c].nombre + ' → ' + clasificacion[c].tipo);
  }

  Logger.log('PASO 2: Parseando factura CEYCO...');
  var facturaCeyco = _buscarPorTipo(clasificacion, 'factura_ceyco');
  if (!facturaCeyco) { Logger.log('❌ No se encontró factura_ceyco'); return; }
  var parsedCeyco = _parsearFacturaCeyco(facturaCeyco.base64, facturaCeyco.mime);
  Logger.log('Factura CEYCO: ' + JSON.stringify({
    num_factura: parsedCeyco.num_factura,
    cliente:     parsedCeyco.cliente,
    total:       parsedCeyco.total,
    n_items:     (parsedCeyco.items || []).length,
  }));

  Logger.log('PASO 3: Parseando facturas de costo...');
  var facturasCosto = _filtrarPorTipo(clasificacion, 'factura_costo');
  var parsedCostos  = [];
  for (var i = 0; i < facturasCosto.length; i++) {
    var pc = _parsearFacturaCosto(facturasCosto[i].base64, facturasCosto[i].mime, facturasCosto[i].nombre);
    parsedCostos.push(pc);
    Logger.log('  Costo [' + i + ']: ' + pc.proveedor + ' | $' + pc.total + ' | items: ' + (pc.items||[]).length);
  }

  Logger.log('PASO 4: Matching...');
  var matching = _matchingItems(parsedCeyco.items || [], parsedCostos, cfg);
  Logger.log('  Matcheados: ' + matching.items.filter(function(m){ return m.tipo_venta === 'venta_directa'; }).length);
  Logger.log('  Warnings:   ' + matching.warnings.length);
  if (matching.warnings.length > 0) {
    Logger.log('  Sin match: ' + JSON.stringify(matching.warnings));
  }

  Logger.log('PASO 5: Construyendo filas...');
  var filas = _construirFilas(parsedCeyco, parsedCostos, matching, mes, cfg);
  Logger.log('  ST:       ' + filas.st.id_st);
  Logger.log('  Ingresos: ' + filas.ingresos.length);
  Logger.log('  Egresos:  ' + filas.egresos.length);
  Logger.log('  ST Items: ' + filas.st_items.length);

  Logger.log('PASO 6: Enviando a GAS Cliente CEYCO...');
  var gasResp = _enviarAGasCliente(cfg.gas_url, {
    action:   'escribirRegistros',
    cliente:  'ceyco',
    mes:      mes,
    st:       filas.st,
    ingresos: filas.ingresos,
    egresos:  filas.egresos,
    st_items: filas.st_items,
  });
  Logger.log('GAS Cliente resp: ' + JSON.stringify(gasResp));
}

function _debugClasificacion() {
  var archivos = [
    { id: '1jAm31hxIkZ4OW6vlVawB2XlyyNRPbKVd', nombre: '01_01_0000000535_001_0000 (1).pdf' },
    { id: '1xULH7ioGuQzUU5qk8aVGneolx89Uz6LB', nombre: 'PI - 20260324 Dimyeen Copy.pdf'    },
    { id: '17t6FPfA4cEWySlnabj-JjjFIsZIvk0CQ', nombre: 'DHL FACT 535.pdf'                  },
  ];

  var cfg    = CLIENTES['ceyco'];
  var apiKey = _getApiKey();

  for (var i = 0; i < archivos.length; i++) {
    var file   = DriveApp.getFileById(archivos[i].id);
    var base64 = Utilities.base64Encode(file.getBlob().getBytes());
    var tipo   = _llamarClaudeClasificar(base64, 'application/pdf', archivos[i].nombre, cfg.ruc, apiKey);
    Logger.log(archivos[i].nombre + ' → ' + tipo);
  }
}

function _limpiarPruebasFinales() {
  var ss = SpreadsheetApp.openById('1UCV17jyqvwbiR6YyuUkvhhjPJrR_9Bh7w9XgSGRZkNk');

  var IDS_ST  = ['ST-RP-2026-0048', 'ST-TEST-001'];
  var IDS_ING = ['ING-CEY-20260408181047', 'ING-CEY-20260408180059', 
                 'ING-CEY-20260408172319'];

  // ── Servicios_Tecnicos ────────────────────────────────────
  var sheetST = ss.getSheetByName('Servicios_Tecnicos');
  if (sheetST.getLastRow() > 2) {
    var dataST = sheetST.getRange(3, 1, sheetST.getLastRow() - 2, 1).getValues();
    for (var i = dataST.length - 1; i >= 0; i--) {
      if (IDS_ST.indexOf(String(dataST[i][0])) !== -1) {
        sheetST.deleteRow(i + 3);
        Logger.log('✅ ST eliminado: ' + dataST[i][0]);
      }
    }
  }

  // ── ST_Items ──────────────────────────────────────────────
  var sheetSTI = ss.getSheetByName('ST_Items');
  if (sheetSTI.getLastRow() > 2) {
    var dataSTI = sheetSTI.getRange(3, 1, sheetSTI.getLastRow() - 2, 2).getValues();
    for (var j = dataSTI.length - 1; j >= 0; j--) {
      if (IDS_ST.indexOf(String(dataSTI[j][1])) !== -1) {
        sheetSTI.deleteRow(j + 3);
        Logger.log('✅ ST_Item eliminado fila ' + (j + 3));
      }
    }
  }

  // ── Ingresos ──────────────────────────────────────────────
  var sheetIng = ss.getSheetByName('Ingresos');
  if (sheetIng.getLastRow() > 2) {
    var dataIng = sheetIng.getRange(3, 1, sheetIng.getLastRow() - 2, 1).getValues();
    for (var k = dataIng.length - 1; k >= 0; k--) {
      if (IDS_ING.indexOf(String(dataIng[k][0])) !== -1) {
        sheetIng.deleteRow(k + 3);
        Logger.log('✅ Ingreso eliminado: ' + dataIng[k][0]);
      }
    }
  }

  // ── Egresos BC (prefijo EGR-CEY) ──────────────────────────
  var sheetEgr = ss.getSheetByName('Egresos');
  if (sheetEgr.getLastRow() > 2) {
    var dataEgr = sheetEgr.getRange(3, 1, sheetEgr.getLastRow() - 2, 1).getValues();
    for (var m = dataEgr.length - 1; m >= 0; m--) {
      if (String(dataEgr[m][0]).indexOf('EGR-CEY') === 0) {
        sheetEgr.deleteRow(m + 3);
        Logger.log('✅ Egreso BC eliminado: ' + dataEgr[m][0]);
      }
    }
  }

  Logger.log('🧹 Limpieza completada.');
}

function _debugParseDimyeen() {
  var file   = DriveApp.getFileById('1xULH7ioGuQzUU5qk8aVGneolx89Uz6LB');
  var base64 = Utilities.base64Encode(file.getBlob().getBytes());
  var result = _parsearFacturaCosto(base64, 'application/pdf', 'PI - 20260324 Dimyeen Copy.pdf');
  Logger.log(JSON.stringify(result, null, 2));
}
