// ═══════════════════════════════════════════════════════════════
//  ContaFacil_ServiciosTecnicos.gs
//  Módulo: Servicios Técnicos — Ramon Pico / Círculo Financiero
//  v1.3 — Cotizaciones + Ejecución + Comparativo
//         + proveedor/num_factura en ítems del resumen
//         + _handleActualizarItemTipo (reclasificación desde UI)
//         + _handleActualizarEgresoST (editar egreso existente)
//         + _handleEliminarItemCotizacion anula egreso automáticamente
//
//  HOJAS NUEVAS:
//    Servicios_Tecnicos  — 1 fila por ST (cabecera doble, datos desde fila 3)
//    ST_Items            — 1 fila por ítem cotizado/real (cabecera doble, datos desde fila 3)
//
//  MIGRACIÓN REQUERIDA en hoja Egresos:
//    Ejecutar migrarEgresosST() UNA SOLA VEZ para agregar col id_st_item (col 21)
//
//  ACTIONS doGet:
//    getCotizaciones | aprobarCotizacion | iniciarEjecucion | cerrarST
//    getResumenST | enviarCotizacionEmail | eliminarItemCotizacion
//    eliminarST | cancelarST
//
//  ACTIONS doPost:
//    crearCotizacion | actualizarCotizacion | agregarItemCotizacion
//    registrarIngresoST | registrarEgresoST | actualizarItemTipo
//    actualizarEgresoST  ← NUEVO v1.3
//
//  REGISTRO EN doGet() — agregar ANTES del health check:
//    if (action === 'getCotizaciones')        return _handleGetCotizaciones(params, callback);
//    if (action === 'aprobarCotizacion')      return _handleAprobarCotizacion(params, callback);
//    if (action === 'iniciarEjecucion')       return _handleIniciarEjecucion(params, callback);
//    if (action === 'cerrarST')               return _handleCerrarST(params, callback);
//    if (action === 'getResumenST')           return _handleGetResumenST(params, callback);
//    if (action === 'enviarCotizacionEmail')  return _handleEnviarCotizacionEmail(params, callback);
//    if (action === 'eliminarItemCotizacion') return _handleEliminarItemCotizacion(params, callback);
//    if (action === 'cancelarST')             return _handleCancelarST(params, callback);
//    if (action === 'eliminarST')             return _handleEliminarST(params, callback);
//
//  REGISTRO EN doPost() — agregar ANTES del bloque default:
//    if (action === 'crearCotizacion')        return _handleCrearCotizacion(data);
//    if (action === 'actualizarCotizacion')   return _handleActualizarCotizacion(data);
//    if (action === 'agregarItemCotizacion')  return _handleAgregarItemCotizacion(data);
//    if (action === 'registrarIngresoST')     return _handleRegistrarIngresoST(data);
//    if (action === 'registrarEgresoST')      return _handleRegistrarEgresoST(data);
//    if (action === 'actualizarItemTipo')     return _handleActualizarItemTipo(data);
//    if (action === 'actualizarEgresoST')     return _handleActualizarEgresoST(data);  ← NUEVO v1.3
// ═══════════════════════════════════════════════════════════════

// ── CONSTANTES DE HOJAS ───────────────────────────────────────
var SHEET_ST      = 'Servicios_Tecnicos';
var SHEET_ST_ITEM = 'ST_Items';

// ── COLUMNAS Servicios_Tecnicos (base 1) ─────────────────────
var COL_ST = {
  ID:                   1,   // A  id_st
  FECHA_REG:            2,   // B  fecha_registro
  ESTADO:               3,   // C  estado
  NUM_COT:              4,   // D  num_cotizacion
  NOMBRE_CLI:           5,   // E  nombre_cliente
  RUC_CLI:              6,   // F  ruc_cliente
  DV_CLI:               7,   // G  dv_cliente
  CONTACTO:             8,   // H  contacto (tel/email)
  EMAIL_CLI:            9,   // I  email_cliente
  DESCRIPCION:         10,   // J  descripcion_servicio
  TOTAL_COSTO_COT:     11,   // K  total_costo_cotizado
  MARGEN_PCT:          12,   // L  margen_pct
  PRECIO_VENTA:        13,   // M  precio_venta
  TOTAL_COSTO_REAL:    14,   // N  total_costo_real
  FECHA_APROBACION:    15,   // O  fecha_aprobacion
  FECHA_INICIO:        16,   // P  fecha_inicio_ejecucion
  FECHA_CIERRE:        17,   // Q  fecha_cierre
  INGRESO_ID:          18,   // R  ingreso_id
  DRIVE_URL:           19,   // S  drive_url (cotizacion PDF si aplica)
  NOTAS:               20,   // T  notas
  MES:                 21,   // U  mes
  ANIO:                22,   // V  anio
};
var ST_NCOLS = 22;

// ── COLUMNAS ST_Items (base 1) ────────────────────────────────
var COL_STI = {
  ID:              1,   // A  id_item_st
  ID_ST:           2,   // B  id_st (FK)
  TIPO:            3,   // C  tipo (producto|mano_obra|flete|impuesto|combustible|fianza|subcontrato|otro)
  DESCRIPCION:     4,   // D  descripcion
  CANTIDAD:        5,   // E  cantidad
  PRECIO_UNIT:     6,   // F  precio_unitario
  APLICA_ITBMS:    7,   // G  aplica_itbms (TRUE/FALSE)
  MONTO_COT:       8,   // H  monto_cotizado (subtotal sin ITBMS)
  ITBMS_COT:       9,   // I  itbms_cotizado
  TOTAL_COT:      10,   // J  total_cotizado
  MARGEN_ITEM_PCT:11,   // K  margen_item_pct (override del ST, vacío = usa margen del ST)
  PRECIO_VENTA_ITEM:12, // L  precio_venta_item
  ES_ADICIONAL:   13,   // M  es_adicional (FALSE=cotizado, TRUE=surgió en ejecución)
  MONTO_REAL:     14,   // N  monto_real (costo real ejecutado)
  ITBMS_REAL:     15,   // O  itbms_real
  TOTAL_REAL:     16,   // P  total_real
  DRIVE_URL:      17,   // Q  drive_url_factura_real
  EGRESO_ID:      18,   // R  egreso_id vinculado
  ESTADO_ITEM:    19,   // S  estado (cotizado|ejecutado|pendiente|cancelado)
  NOTAS:          20,   // T  notas
  FECHA_REG:      21,   // U  fecha_registro
};
var STI_NCOLS = 21;

// ── COLUMNA NUEVA EN EGRESOS (requiere migrarEgresosST) ───────
var COL_E_ST_ITEM = 21;  // id_st_item

// ── TIPOS DE ÍTEM VÁLIDOS ─────────────────────────────────────
var ST_TIPOS_ITEM = [
  'producto', 'mano_obra', 'flete', 'impuesto',
  'combustible', 'fianza', 'subcontrato', 'aduana', 'shipping_handling', 'otro'
];

// ── ESTADOS DE ST ─────────────────────────────────────────────
var ST_ESTADOS = ['cotizado', 'aprobado', 'en_ejecucion', 'cerrado', 'cancelado'];


// ═══════════════════════════════════════════════════════════════
//  INIT — ejecutar UNA SOLA VEZ
// ═══════════════════════════════════════════════════════════════

function initSTSheets() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  _initServiciosTecnicosSheet(ss);
  _initSTItemsSheet(ss);
  Logger.log('✅ Hojas ST inicializadas.');
}

function _initServiciosTecnicosSheet(ss) {
  if (ss.getSheetByName(SHEET_ST)) {
    Logger.log('⚠️ Hoja "' + SHEET_ST + '" ya existe.');
    return ss.getSheetByName(SHEET_ST);
  }
  var sheet = ss.insertSheet(SHEET_ST);
  SpreadsheetApp.flush();

  var meta = [
    'METADATA','','','',
    'CLIENTE','','','','',
    'COTIZACIÓN','','','',
    'EJECUCIÓN','','','','',
    'CIERRE','','','',
  ];
  var headers = [
    'id_st','fecha_registro','estado','num_cotizacion',
    'nombre_cliente','ruc_cliente','dv_cliente','contacto','email_cliente',
    'descripcion_servicio','total_costo_cotizado','margen_pct','precio_venta',
    'total_costo_real','fecha_aprobacion','fecha_inicio_ejecucion','fecha_cierre',
    'ingreso_id','drive_url','notas','mes','anio',
  ];

  sheet.getRange(1, 1, 1, ST_NCOLS).setValues([meta]);
  sheet.getRange(1, 1, 1, ST_NCOLS)
    .setBackground('#1A237E').setFontColor('#FFFFFF').setFontWeight('bold');
  sheet.getRange(2, 1, 1, ST_NCOLS).setValues([headers]);
  sheet.getRange(2, 1, 1, ST_NCOLS)
    .setBackground('#283593').setFontColor('#FFFFFF').setFontWeight('bold');

  sheet.getRange(1, 1,  1, 4).setBackground('#1A237E');
  sheet.getRange(1, 5,  1, 5).setBackground('#1B5E20');
  sheet.getRange(1, 10, 1, 4).setBackground('#E65100');
  sheet.getRange(1, 14, 1, 4).setBackground('#4A148C');
  sheet.getRange(1, 18, 1, 5).setBackground('#880E4F');

  sheet.setFrozenRows(2);

  var ruleEstado = SpreadsheetApp.newDataValidation()
    .requireValueInList(ST_ESTADOS, true)
    .setAllowInvalid(false).build();
  sheet.getRange('C3:C1000').setDataValidation(ruleEstado);

  var widths = [160,140,110,130,180,110,60,130,180,280,100,80,100,100,120,120,110,150,250,250,50,70];
  for (var i = 0; i < widths.length; i++) sheet.setColumnWidth(i + 1, widths[i]);

  sheet.getRange('K3:N1000').setNumberFormat('#,##0.00');
  Logger.log('✅ Hoja "' + SHEET_ST + '" creada.');
  return sheet;
}

function _initSTItemsSheet(ss) {
  if (ss.getSheetByName(SHEET_ST_ITEM)) {
    Logger.log('⚠️ Hoja "' + SHEET_ST_ITEM + '" ya existe.');
    return ss.getSheetByName(SHEET_ST_ITEM);
  }
  var sheet = ss.insertSheet(SHEET_ST_ITEM);
  SpreadsheetApp.flush();

  var meta = [
    'ID','FK','TIPO','DESCRIPCIÓN','','',
    'COTIZADO','','','',
    'MARGEN/VENTA','',
    'ADICIONAL','REAL','','',
    'COMPROBANTE','','',
    'ESTADO','FECHA',
  ];
  var headers = [
    'id_item_st','id_st','tipo','descripcion','cantidad','precio_unitario',
    'aplica_itbms','monto_cotizado','itbms_cotizado','total_cotizado',
    'margen_item_pct','precio_venta_item',
    'es_adicional','monto_real','itbms_real','total_real',
    'drive_url_factura','egreso_id',
    'estado_item','notas','fecha_registro',
  ];

  sheet.getRange(1, 1, 1, STI_NCOLS).setValues([meta]);
  sheet.getRange(1, 1, 1, STI_NCOLS)
    .setBackground('#37474F').setFontColor('#FFFFFF').setFontWeight('bold');
  sheet.getRange(2, 1, 1, STI_NCOLS).setValues([headers]);
  sheet.getRange(2, 1, 1, STI_NCOLS)
    .setBackground('#546E7A').setFontColor('#FFFFFF').setFontWeight('bold');

  sheet.getRange(1, 7,  1, 4).setBackground('#E65100');
  sheet.getRange(1, 11, 1, 2).setBackground('#1B5E20');
  sheet.getRange(1, 14, 1, 3).setBackground('#4A148C');

  sheet.setFrozenRows(2);

  var ruleTipo = SpreadsheetApp.newDataValidation()
    .requireValueInList(ST_TIPOS_ITEM, true)
    .setAllowInvalid(false).build();
  sheet.getRange('C3:C1000').setDataValidation(ruleTipo);

  var ruleEstadoItem = SpreadsheetApp.newDataValidation()
    .requireValueInList(['cotizado', 'ejecutado', 'pendiente', 'cancelado'], true)
    .setAllowInvalid(false).build();
  sheet.getRange('S3:S1000').setDataValidation(ruleEstadoItem);

  sheet.getRange('F3:F1000').setNumberFormat('#,##0.00');
  sheet.getRange('H3:J1000').setNumberFormat('#,##0.00');
  sheet.getRange('L3:L1000').setNumberFormat('#,##0.00');
  sheet.getRange('N3:P1000').setNumberFormat('#,##0.00');

  var widths = [160,140,110,280,70,100,80,100,80,100,90,100,80,100,80,100,250,150,100,200,140];
  for (var i = 0; i < widths.length; i++) sheet.setColumnWidth(i + 1, widths[i]);

  Logger.log('✅ Hoja "' + SHEET_ST_ITEM + '" creada.');
  return sheet;
}

// ── Migración Egresos: agregar col id_st_item (col 21) ───────

function migrarEgresosST() {
  var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_EGRESOS);
  if (!sheet) { Logger.log('❌ Hoja Egresos no encontrada'); return; }

  var lastCol  = sheet.getLastColumn();
  var headers  = sheet.getRange(2, 1, 1, lastCol).getValues()[0];
  if (headers.indexOf('id_st_item') !== -1) {
    Logger.log('⚠️ Columna id_st_item ya existe en col ' +
               (headers.indexOf('id_st_item') + 1) + ' — migración cancelada');
    return;
  }

  sheet.getRange(1, 21).setValue('');
  sheet.getRange(2, 21).setValue('id_st_item');
  sheet.getRange(2, 21)
    .setBackground('#546E7A')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold');
  sheet.setColumnWidth(21, 150);

  Logger.log('✅ migrarEgresosST completada — columna id_st_item insertada en col 21');
}


// ═══════════════════════════════════════════════════════════════
//  HELPERS INTERNOS ST
// ═══════════════════════════════════════════════════════════════

function _nextSTSeq(ss) {
  var sheet   = ss.getSheetByName(SHEET_ST);
  var anio    = new Date().getFullYear();
  var seq     = 1;
  if (!sheet || sheet.getLastRow() <= 2) return { anio: anio, seq: seq };
  var ids = sheet.getRange(3, COL_ST.ID, sheet.getLastRow() - 2, 1).getValues();
  for (var k = ids.length - 1; k >= 0; k--) {
    var v     = String(ids[k][0] || '');
    var parts = v.split('-');
    var n     = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(n)) { seq = n + 1; break; }
  }
  return { anio: anio, seq: seq };
}

function _calcItemTotals(item) {
  var cantidad     = parseFloat(item.cantidad      || '1') || 1;
  var precioUnit   = parseFloat(item.precio_unitario || '0') || 0;
  var aplicaITBMS  = item.aplica_itbms === true || item.aplica_itbms === 'true' || item.aplica_itbms === 'TRUE';

  var montoCot;
  if (precioUnit > 0) {
    montoCot = parseFloat((precioUnit * cantidad).toFixed(2));
  } else {
    montoCot = parseFloat(item.monto_cotizado || '0') || 0;
  }

  var itbmsCot = aplicaITBMS ? parseFloat((montoCot * CONFIG.ITBMS_RATE).toFixed(2)) : 0;
  var totalCot = parseFloat((montoCot + itbmsCot).toFixed(2));

  return { montoCot: montoCot, itbmsCot: itbmsCot, totalCot: totalCot };
}

function _calcSTTotals(sheetSTI, idST) {
  if (!sheetSTI || sheetSTI.getLastRow() <= 2) return { totalCostoCot: 0, items: [] };
  var numRows = sheetSTI.getLastRow() - 2;
  var data    = sheetSTI.getRange(3, 1, numRows, STI_NCOLS).getValues();
  var total   = 0;
  var items   = [];
  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    if (String(r[COL_STI.ID_ST - 1]) !== String(idST)) continue;
    if (String(r[COL_STI.ESTADO_ITEM - 1]) === 'cancelado') continue;
    total += parseFloat(r[COL_STI.TOTAL_COT - 1] || '0') || 0;
    items.push(r);
  }
  return { totalCostoCot: parseFloat(total.toFixed(2)), items: items };
}

function _calcSTTotalsReal(sheetSTI, idST) {
  if (!sheetSTI || sheetSTI.getLastRow() <= 2) return 0;
  var numRows = sheetSTI.getLastRow() - 2;
  var data    = sheetSTI.getRange(3, 1, numRows, STI_NCOLS).getValues();
  var total   = 0;
  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    if (String(r[COL_STI.ID_ST - 1]) !== String(idST)) continue;
    total += parseFloat(r[COL_STI.TOTAL_REAL - 1] || '0') || 0;
  }
  return parseFloat(total.toFixed(2));
}

function _getSTById(ss, idST) {
  var sheet = ss.getSheetByName(SHEET_ST);
  if (!sheet || sheet.getLastRow() <= 2) return null;
  var numRows = sheet.getLastRow() - 2;
  var data    = sheet.getRange(3, 1, numRows, ST_NCOLS).getValues();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][COL_ST.ID - 1]) === String(idST)) {
      return { row: i + 3, data: data[i] };
    }
  }
  return null;
}

function _serializeST(r) {
  var fechaReg = r[COL_ST.FECHA_REG - 1];
  if (fechaReg instanceof Date) {
    fechaReg = Utilities.formatDate(fechaReg, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
  } else { fechaReg = String(fechaReg || ''); }

  return {
    id_st:               r[COL_ST.ID - 1],
    fecha_reg:           fechaReg,
    estado:              r[COL_ST.ESTADO - 1]          || '',
    num_cotizacion:      r[COL_ST.NUM_COT - 1]         || '',
    nombre_cliente:      r[COL_ST.NOMBRE_CLI - 1]      || '',
    ruc_cliente:         r[COL_ST.RUC_CLI - 1]         || '',
    dv_cliente:          r[COL_ST.DV_CLI - 1]          || '',
    contacto:            r[COL_ST.CONTACTO - 1]        || '',
    email_cliente:       r[COL_ST.EMAIL_CLI - 1]       || '',
    descripcion:         r[COL_ST.DESCRIPCION - 1]     || '',
    total_costo_cotizado:parseFloat(r[COL_ST.TOTAL_COSTO_COT - 1] || '0') || 0,
    margen_pct:          parseFloat(r[COL_ST.MARGEN_PCT - 1]      || '0') || 0,
    precio_venta:        parseFloat(r[COL_ST.PRECIO_VENTA - 1]    || '0') || 0,
    total_costo_real:    parseFloat(r[COL_ST.TOTAL_COSTO_REAL - 1]|| '0') || 0,
    fecha_aprobacion:    r[COL_ST.FECHA_APROBACION - 1] || '',
    fecha_inicio:        r[COL_ST.FECHA_INICIO - 1]    || '',
    fecha_cierre:        r[COL_ST.FECHA_CIERRE - 1]    || '',
    ingreso_id:          r[COL_ST.INGRESO_ID - 1]      || '',
    drive_url:           r[COL_ST.DRIVE_URL - 1]       || '',
    notas:               r[COL_ST.NOTAS - 1]           || '',
    mes:                 r[COL_ST.MES - 1]             || '',
    anio:                r[COL_ST.ANIO - 1]            || '',
  };
}

function _serializeSTItem(r) {
  return {
    id_item_st:       r[COL_STI.ID - 1],
    id_st:            r[COL_STI.ID_ST - 1],
    tipo:             r[COL_STI.TIPO - 1]             || '',
    descripcion:      r[COL_STI.DESCRIPCION - 1]      || '',
    cantidad:         parseFloat(r[COL_STI.CANTIDAD - 1]   || '1') || 1,
    precio_unitario:  parseFloat(r[COL_STI.PRECIO_UNIT - 1]|| '0') || 0,
    aplica_itbms:     r[COL_STI.APLICA_ITBMS - 1] === true ||
                      String(r[COL_STI.APLICA_ITBMS - 1]).toUpperCase() === 'TRUE',
    monto_cotizado:   parseFloat(r[COL_STI.MONTO_COT - 1]      || '0') || 0,
    itbms_cotizado:   parseFloat(r[COL_STI.ITBMS_COT - 1]      || '0') || 0,
    total_cotizado:   parseFloat(r[COL_STI.TOTAL_COT - 1]      || '0') || 0,
    margen_item_pct:  parseFloat(r[COL_STI.MARGEN_ITEM_PCT - 1]|| '0') || 0,
    precio_venta_item:parseFloat(r[COL_STI.PRECIO_VENTA_ITEM - 1]|| '0') || 0,
    es_adicional:     r[COL_STI.ES_ADICIONAL - 1] === true ||
                      String(r[COL_STI.ES_ADICIONAL - 1]).toUpperCase() === 'TRUE',
    monto_real:       parseFloat(r[COL_STI.MONTO_REAL - 1]  || '0') || 0,
    itbms_real:       parseFloat(r[COL_STI.ITBMS_REAL - 1]  || '0') || 0,
    total_real:       parseFloat(r[COL_STI.TOTAL_REAL - 1]  || '0') || 0,
    drive_url:        r[COL_STI.DRIVE_URL - 1]   || '',
    egreso_id:        r[COL_STI.EGRESO_ID - 1]   || '',
    estado_item:      r[COL_STI.ESTADO_ITEM - 1] || 'cotizado',
    notas:            r[COL_STI.NOTAS - 1]       || '',
    fecha_reg:        r[COL_STI.FECHA_REG - 1]   || '',
    // proveedor y num_factura se inyectan en _handleGetResumenST
    // cruzando con el mapa de egresos — no viven en ST_Items
    proveedor:   '',
    num_factura: '',
  };
}


// ═══════════════════════════════════════════════════════════════
//  _handleCrearCotizacion  (doPost)
// ═══════════════════════════════════════════════════════════════

function _handleCrearCotizacion(data) {
  try {
    var ss      = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheetST = _initServiciosTecnicosSheet(ss);
    var sheetSTI = _initSTItemsSheet(ss);
    var ahora   = new Date();
    var fechaReg = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
    var mes      = ahora.getMonth() + 1;
    var anio     = ahora.getFullYear();

    var seqData    = _nextSTSeq(ss);
    var idST       = 'ST-RP-' + seqData.anio + '-' + String(seqData.seq).padStart(4, '0');
    var numCot     = 'COT-RP-' + seqData.anio + '-' + String(seqData.seq).padStart(4, '0');

    var items = Array.isArray(data.items) ? data.items
          : (typeof data.items === 'string' ? JSON.parse(data.items) : []);
    var totalCostoCot  = 0;
    var filasST        = [];

    for (var j = 0; j < items.length; j++) {
      var item     = items[j];
      var totales  = _calcItemTotals(item);
      totalCostoCot += totales.totalCot;

      var idItem = 'STI-RP-' +
        Utilities.formatDate(ahora, 'America/Panama', 'yyyyMMddHHmmss') +
        '-' + String(j + 1);

      var margenItemPct   = parseFloat(item.margen_item_pct || '0') || 0;
      var precioVentaItem = 0;
      if (margenItemPct > 0) {
        precioVentaItem = parseFloat((totales.totalCot * (1 + margenItemPct / 100)).toFixed(2));
      } else if (item.precio_venta_item) {
        precioVentaItem = parseFloat(item.precio_venta_item || '0') || 0;
        if (precioVentaItem > 0 && totales.totalCot > 0) {
          margenItemPct = parseFloat(((precioVentaItem / totales.totalCot - 1) * 100).toFixed(2));
        }
      }

      var filaItem = new Array(STI_NCOLS);
      for (var xi = 0; xi < STI_NCOLS; xi++) filaItem[xi] = '';
      filaItem[COL_STI.ID - 1]              = idItem;
      filaItem[COL_STI.ID_ST - 1]           = idST;
      filaItem[COL_STI.TIPO - 1]            = item.tipo        || 'otro';
      filaItem[COL_STI.DESCRIPCION - 1]     = item.descripcion || '';
      filaItem[COL_STI.CANTIDAD - 1]        = parseFloat(item.cantidad || '1') || 1;
      filaItem[COL_STI.PRECIO_UNIT - 1]     = parseFloat(item.precio_unitario || '0') || '';
      filaItem[COL_STI.APLICA_ITBMS - 1]    = totales.itbmsCot > 0;
      filaItem[COL_STI.MONTO_COT - 1]       = totales.montoCot;
      filaItem[COL_STI.ITBMS_COT - 1]       = totales.itbmsCot;
      filaItem[COL_STI.TOTAL_COT - 1]       = totales.totalCot;
      filaItem[COL_STI.MARGEN_ITEM_PCT - 1] = margenItemPct || '';
      filaItem[COL_STI.PRECIO_VENTA_ITEM - 1] = precioVentaItem || '';
      filaItem[COL_STI.ES_ADICIONAL - 1]    = false;
      filaItem[COL_STI.ESTADO_ITEM - 1]     = 'cotizado';
      filaItem[COL_STI.NOTAS - 1]           = item.notas || '';
      filaItem[COL_STI.FECHA_REG - 1]       = fechaReg;
      filasST.push(filaItem);
    }

    totalCostoCot = parseFloat(totalCostoCot.toFixed(2));

    var margenPct   = parseFloat(data.margen_pct   || '0') || 0;
    var precioVenta = parseFloat(data.precio_venta || '0') || 0;

    if (precioVenta > 0 && totalCostoCot > 0 && margenPct === 0) {
      margenPct = parseFloat(((precioVenta / totalCostoCot - 1) * 100).toFixed(2));
    } else if (margenPct > 0 && totalCostoCot > 0 && precioVenta === 0) {
      precioVenta = parseFloat((totalCostoCot * (1 + margenPct / 100)).toFixed(2));
    }

    var filaST = new Array(ST_NCOLS);
    for (var xs = 0; xs < ST_NCOLS; xs++) filaST[xs] = '';
    filaST[COL_ST.ID - 1]              = idST;
    filaST[COL_ST.FECHA_REG - 1]       = fechaReg;
    filaST[COL_ST.ESTADO - 1]          = 'cotizado';
    filaST[COL_ST.NUM_COT - 1]         = numCot;
    filaST[COL_ST.NOMBRE_CLI - 1]      = data.nombre_cliente || '';
    filaST[COL_ST.RUC_CLI - 1]         = data.ruc_cliente    || '';
    filaST[COL_ST.DV_CLI - 1]          = data.dv_cliente     || '';
    filaST[COL_ST.CONTACTO - 1]        = data.contacto       || '';
    filaST[COL_ST.EMAIL_CLI - 1]       = data.email_cliente  || '';
    filaST[COL_ST.DESCRIPCION - 1]     = data.descripcion    || '';
    filaST[COL_ST.TOTAL_COSTO_COT - 1] = totalCostoCot       || '';
    filaST[COL_ST.MARGEN_PCT - 1]      = margenPct           || '';
    filaST[COL_ST.PRECIO_VENTA - 1]    = precioVenta         || '';
    filaST[COL_ST.NOTAS - 1]           = data.notas          || '';
    filaST[COL_ST.MES - 1]             = mes;
    filaST[COL_ST.ANIO - 1]            = anio;

    var newSTRow = sheetST.getLastRow() + 1;
    sheetST.getRange(newSTRow, 1, 1, ST_NCOLS).setValues([filaST]);
    sheetST.getRange(newSTRow, COL_ST.TOTAL_COSTO_COT, 1, 3).setNumberFormat('#,##0.00');
    sheetST.getRange(newSTRow, 1, 1, ST_NCOLS).setBackground('#FFF9C4');

    if (filasST.length > 0) {
      var newItemRow = sheetSTI.getLastRow() + 1;
      sheetSTI.getRange(newItemRow, 1, filasST.length, STI_NCOLS).setValues(filasST);
      sheetSTI.getRange(newItemRow, COL_STI.MONTO_COT, filasST.length, 3).setNumberFormat('#,##0.00');
      sheetSTI.getRange(newItemRow, 1, filasST.length, STI_NCOLS).setBackground('#FFF9C4');
    }

    Logger.log('✅ Cotización creada: ' + idST + ' | ' + numCot + ' | ' +
               items.length + ' ítems | Total costo: $' + totalCostoCot);

    return ContentService
      .createTextOutput(JSON.stringify({
        success:              true,
        id_st:                idST,
        num_cotizacion:       numCot,
        total_costo_cotizado: totalCostoCot,
        precio_venta:         precioVenta,
        margen_pct:           margenPct,
      }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log('Error _handleCrearCotizacion: ' + err.message);
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}


// ═══════════════════════════════════════════════════════════════
//  _handleActualizarCotizacion  (doPost)
// ═══════════════════════════════════════════════════════════════

function _handleActualizarCotizacion(data) {
  try {
    var idST = data.id_st || '';
    if (!idST) throw new Error('id_st requerido');

    var ss  = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var rec = _getSTById(ss, idST);
    if (!rec) throw new Error('ST no encontrado: ' + idST);

    var rowNum = rec.row;
    var sheet  = ss.getSheetByName(SHEET_ST);

    var estadoActual = String(rec.data[COL_ST.ESTADO - 1] || '');
    if (estadoActual === 'cerrado' || estadoActual === 'cancelado') {
      throw new Error('No se puede editar un ST en estado "' + estadoActual + '"');
    }

    if (data.nombre_cliente !== undefined) sheet.getRange(rowNum, COL_ST.NOMBRE_CLI).setValue(data.nombre_cliente);
    if (data.ruc_cliente    !== undefined) sheet.getRange(rowNum, COL_ST.RUC_CLI).setValue(data.ruc_cliente);
    if (data.dv_cliente     !== undefined) sheet.getRange(rowNum, COL_ST.DV_CLI).setValue(data.dv_cliente);
    if (data.contacto       !== undefined) sheet.getRange(rowNum, COL_ST.CONTACTO).setValue(data.contacto);
    if (data.email_cliente  !== undefined) sheet.getRange(rowNum, COL_ST.EMAIL_CLI).setValue(data.email_cliente);
    if (data.descripcion    !== undefined) sheet.getRange(rowNum, COL_ST.DESCRIPCION).setValue(data.descripcion);
    if (data.notas          !== undefined) sheet.getRange(rowNum, COL_ST.NOTAS).setValue(data.notas);

    var totalCostoCot = parseFloat(rec.data[COL_ST.TOTAL_COSTO_COT - 1] || '0') || 0;
    var margenPct     = parseFloat(data.margen_pct   || rec.data[COL_ST.MARGEN_PCT - 1]   || '0') || 0;
    var precioVenta   = parseFloat(data.precio_venta || rec.data[COL_ST.PRECIO_VENTA - 1] || '0') || 0;

    if (data.precio_venta !== undefined && totalCostoCot > 0) {
      precioVenta = parseFloat(data.precio_venta) || 0;
      margenPct   = precioVenta > 0
        ? parseFloat(((precioVenta / totalCostoCot - 1) * 100).toFixed(2))
        : 0;
    } else if (data.margen_pct !== undefined && totalCostoCot > 0) {
      margenPct   = parseFloat(data.margen_pct) || 0;
      precioVenta = parseFloat((totalCostoCot * (1 + margenPct / 100)).toFixed(2));
    }

    sheet.getRange(rowNum, COL_ST.MARGEN_PCT).setValue(margenPct   || '');
    sheet.getRange(rowNum, COL_ST.PRECIO_VENTA).setValue(precioVenta || '');

    Logger.log('✅ ST actualizado: ' + idST);
    return ContentService
      .createTextOutput(JSON.stringify({ success: true, margen_pct: margenPct, precio_venta: precioVenta }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log('Error _handleActualizarCotizacion: ' + err.message);
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}


// ═══════════════════════════════════════════════════════════════
//  _handleAgregarItemCotizacion  (doPost)
// ═══════════════════════════════════════════════════════════════

function _handleAgregarItemCotizacion(data) {
  try {
    var idST = data.id_st || '';
    if (!idST) throw new Error('id_st requerido');

    var ss  = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var rec = _getSTById(ss, idST);
    if (!rec) throw new Error('ST no encontrado: ' + idST);

    var estadoActual = String(rec.data[COL_ST.ESTADO - 1] || '');
    if (estadoActual === 'cerrado' || estadoActual === 'cancelado') {
      throw new Error('No se pueden agregar ítems a un ST en estado "' + estadoActual + '"');
    }

    var ahora    = new Date();
    var fechaReg = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');

    var sheetSTI = ss.getSheetByName(SHEET_ST_ITEM);
    if (!sheetSTI) sheetSTI = _initSTItemsSheet(ss);
    var totalItemsST = 0;
    if (sheetSTI.getLastRow() > 2) {
      var allIds = sheetSTI.getRange(3, COL_STI.ID_ST, sheetSTI.getLastRow() - 2, 1).getValues();
      for (var k = 0; k < allIds.length; k++) {
        if (String(allIds[k][0]) === String(idST)) totalItemsST++;
      }
    }
    var idItem = 'STI-RP-' +
      Utilities.formatDate(ahora, 'America/Panama', 'yyyyMMddHHmmss') +
      '-' + String(totalItemsST + 1);

    var totales     = _calcItemTotals(data);
    var esAdicional = data.es_adicional === true || data.es_adicional === 'true';

    var margenItemPct    = parseFloat(data.margen_item_pct || '0') || 0;
    var precioVentaItem  = parseFloat(data.precio_venta_item || '0') || 0;
    if (margenItemPct > 0 && precioVentaItem === 0) {
      precioVentaItem = parseFloat((totales.totalCot * (1 + margenItemPct / 100)).toFixed(2));
    } else if (precioVentaItem > 0 && margenItemPct === 0 && totales.totalCot > 0) {
      margenItemPct = parseFloat(((precioVentaItem / totales.totalCot - 1) * 100).toFixed(2));
    }

    var filaItem = new Array(STI_NCOLS);
    for (var xi = 0; xi < STI_NCOLS; xi++) filaItem[xi] = '';
    filaItem[COL_STI.ID - 1]              = idItem;
    filaItem[COL_STI.ID_ST - 1]           = idST;
    filaItem[COL_STI.TIPO - 1]            = data.tipo        || 'otro';
    filaItem[COL_STI.DESCRIPCION - 1]     = data.descripcion || '';
    filaItem[COL_STI.CANTIDAD - 1]        = parseFloat(data.cantidad || '1') || 1;
    filaItem[COL_STI.PRECIO_UNIT - 1]     = parseFloat(data.precio_unitario || '0') || '';
    filaItem[COL_STI.APLICA_ITBMS - 1]    = totales.itbmsCot > 0;
    filaItem[COL_STI.MONTO_COT - 1]       = totales.montoCot;
    filaItem[COL_STI.ITBMS_COT - 1]       = totales.itbmsCot;
    filaItem[COL_STI.TOTAL_COT - 1]       = totales.totalCot;
    filaItem[COL_STI.MARGEN_ITEM_PCT - 1] = margenItemPct   || '';
    filaItem[COL_STI.PRECIO_VENTA_ITEM - 1] = precioVentaItem || '';
    filaItem[COL_STI.ES_ADICIONAL - 1]    = esAdicional;
    filaItem[COL_STI.ESTADO_ITEM - 1]     = esAdicional ? 'pendiente' : 'cotizado';
    filaItem[COL_STI.NOTAS - 1]           = data.notas || '';
    filaItem[COL_STI.FECHA_REG - 1]       = fechaReg;

    var newRow = sheetSTI.getLastRow() + 1;
    sheetSTI.getRange(newRow, 1, 1, STI_NCOLS).setValues([filaItem]);
    sheetSTI.getRange(newRow, COL_STI.MONTO_COT, 1, 3).setNumberFormat('#,##0.00');
    sheetSTI.getRange(newRow, 1, 1, STI_NCOLS).setBackground(esAdicional ? '#E8F5E9' : '#FFF9C4');

    var totalesRecalc = _calcSTTotals(sheetSTI, idST);
    var sheetST       = ss.getSheetByName(SHEET_ST);
    sheetST.getRange(rec.row, COL_ST.TOTAL_COSTO_COT).setValue(totalesRecalc.totalCostoCot);

    var margenST    = parseFloat(rec.data[COL_ST.MARGEN_PCT - 1] || '0') || 0;
    var nuevoPrecio = 0;
    if (margenST > 0) {
      nuevoPrecio = parseFloat((totalesRecalc.totalCostoCot * (1 + margenST / 100)).toFixed(2));
      sheetST.getRange(rec.row, COL_ST.PRECIO_VENTA).setValue(nuevoPrecio);
    }

    Logger.log('✅ Ítem agregado: ' + idItem + ' → ST: ' + idST +
               ' | Nuevo total costo: $' + totalesRecalc.totalCostoCot);

    return ContentService
      .createTextOutput(JSON.stringify({
        success:              true,
        id_item_st:           idItem,
        total_costo_cotizado: totalesRecalc.totalCostoCot,
        precio_venta:         nuevoPrecio || parseFloat(rec.data[COL_ST.PRECIO_VENTA - 1] || '0'),
      }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log('Error _handleAgregarItemCotizacion: ' + err.message);
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}


// ═══════════════════════════════════════════════════════════════
//  _handleActualizarItemTipo  (doPost)
// ═══════════════════════════════════════════════════════════════

function _handleActualizarItemTipo(data) {
  try {
    var idItemST = String(data.id_item_st || '').trim();
    var tipo     = String(data.tipo       || '').trim();

    if (!idItemST) throw new Error('id_item_st requerido');
    if (!tipo)     throw new Error('tipo requerido');
    if (ST_TIPOS_ITEM.indexOf(tipo) === -1) {
      throw new Error('Tipo inválido: "' + tipo + '". Valores permitidos: ' + ST_TIPOS_ITEM.join(', '));
    }

    var tipoMap = {
      'mano_obra':        'costo_servicio_tecnico',
      'flete':            'costo_servicio_tecnico',
      'combustible':      'combustible',
      'fianza':           'costo_servicio_tecnico',
      'subcontrato':      'servicios_profesionales',
      'producto':         'costo_mercancia',
      'impuesto':         'costo_servicio_tecnico',
      'aduana':           'costo_servicio_tecnico',
      'shipping_handling':'costo_servicio_tecnico',
      'otro':             'costo_servicio_tecnico',
    };
    var nuevoTipoEgreso = tipoMap[tipo] || 'costo_servicio_tecnico';

    var ss       = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheetSTI = ss.getSheetByName(SHEET_ST_ITEM);
    if (!sheetSTI || sheetSTI.getLastRow() <= 2) throw new Error('Hoja ST_Items vacía');

    var numRows  = sheetSTI.getLastRow() - 2;
    var dataSTI  = sheetSTI.getRange(3, 1, numRows, STI_NCOLS).getValues();
    var found    = false;
    var egresoId = '';

    for (var i = 0; i < dataSTI.length; i++) {
      if (String(dataSTI[i][COL_STI.ID - 1]) !== idItemST) continue;
      var rowSTI = i + 3;
      sheetSTI.getRange(rowSTI, COL_STI.TIPO).setValue(tipo);
      egresoId = String(dataSTI[i][COL_STI.EGRESO_ID - 1] || '').trim();
      found = true;
      Logger.log('✅ ST_Items tipo actualizado: ' + idItemST + ' → ' + tipo);
      break;
    }

    if (!found) throw new Error('Ítem no encontrado: ' + idItemST);

    var egresoActualizado = false;
    if (egresoId) {
      var sheetEgr = ss.getSheetByName(SHEET_EGRESOS);
      if (sheetEgr && sheetEgr.getLastRow() > 2) {
        var numEgr  = sheetEgr.getLastRow() - 2;
        var idsEgr  = sheetEgr.getRange(3, COL_E.ID, numEgr, 1).getValues();
        for (var e = 0; e < idsEgr.length; e++) {
          if (String(idsEgr[e][0]) !== egresoId) continue;
          var rowEgr = e + 3;
          sheetEgr.getRange(rowEgr, 11).setValue(nuevoTipoEgreso);
          sheetEgr.getRange(rowEgr, 12).setValue(nuevoTipoEgreso);
          egresoActualizado = true;
          Logger.log('✅ Egresos actualizado: ' + egresoId + ' tipo → ' + nuevoTipoEgreso);
          break;
        }
      }
    }

    return ContentService
      .createTextOutput(JSON.stringify({
        success:            true,
        tipo:               tipo,
        tipo_egreso:        nuevoTipoEgreso,
        egreso_actualizado: egresoActualizado,
        egreso_id:          egresoId,
      }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log('Error _handleActualizarItemTipo: ' + err.message);
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}


// ═══════════════════════════════════════════════════════════════
//  _handleActualizarEgresoST  (doPost)  ← NUEVO v1.3
//
//  Edita un egreso ya registrado vinculado a un ítem de ST.
//  Flujo:
//    1. Sube nuevo archivo a Drive (si viene)
//    2. Anula el egreso viejo en Egresos
//    3. Crea un egreso nuevo con los datos actualizados
//    4. Actualiza ST_Items: montos reales, drive_url, egreso_id
//    5. Recalcula total_costo_real en Servicios_Tecnicos
//
//  Payload: { id_st, id_item_st, egreso_id, tipo, descripcion,
//             proveedor, num_factura, total, itbms, fecha, notas,
//             imageBase64, imageMime, imageName }
//  Respuesta: { success, egreso_id_nuevo, egreso_id_anulado, total, total_costo_real }
// ═══════════════════════════════════════════════════════════════

function _handleActualizarEgresoST(data) {
  try {
    var idST          = String(data.id_st       || '').trim();
    var idItemST      = String(data.id_item_st  || '').trim();
    var egresoIdViejo = String(data.egreso_id   || '').trim();

    if (!idST)          throw new Error('id_st requerido');
    if (!idItemST)      throw new Error('id_item_st requerido');
    if (!egresoIdViejo) throw new Error('egreso_id requerido para actualizar');

    var ss  = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var rec = _getSTById(ss, idST);
    if (!rec) throw new Error('ST no encontrado: ' + idST);

    var total    = parseFloat(data.total)    || 0;
    var itbms    = parseFloat(data.itbms)    || 0;
    var subtotal = parseFloat(data.subtotal) || parseFloat((total - itbms).toFixed(2));
    var ahora    = new Date();

    // ── 1. Subir nuevo archivo a Drive (si viene) ─────────────
    var driveUrl = '';
    if (data.imageBase64 && data.imageName) {
      try {
        var folder  = DriveApp.getFolderById(CONFIG.VOUCHER_FOLDER_ID);
        var mimeDoc = data.imageMime || 'image/jpeg';
        var bytes   = Utilities.base64Decode(data.imageBase64);
        var blob    = Utilities.newBlob(bytes, mimeDoc, data.imageName);
        var file    = folder.createFile(blob);
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        driveUrl = 'https://drive.google.com/file/d/' + file.getId() + '/view';
      } catch(driveErr) {
        Logger.log('⚠️ Error subiendo archivo actualización ST: ' + driveErr.message);
      }
    }

    // ── 2. Anular egreso viejo ────────────────────────────────
    var sheetEgr = ss.getSheetByName(SHEET_EGRESOS);
    if (!sheetEgr) throw new Error('Hoja Egresos no encontrada');

    var stamp         = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm');
    var driveUrlVieja = '';
    var lastEgrRow    = sheetEgr.getLastRow();

    if (lastEgrRow > 2) {
      var numEgr  = lastEgrRow - 2;
      var dataEgr = sheetEgr.getRange(3, COL_E.ID, numEgr, 1).getValues();
      for (var e = 0; e < dataEgr.length; e++) {
        if (String(dataEgr[e][0] || '').trim() !== egresoIdViejo) continue;
        var rowEgr = e + 3;
        driveUrlVieja = String(sheetEgr.getRange(rowEgr, COL_E.DRIVE_URL).getValue() || '');
        sheetEgr.getRange(rowEgr, COL_E.ESTADO).setValue('anulado');
        sheetEgr.getRange(rowEgr, 1, 1, EGRESOS_NCOLS).setBackground('#FFEBEE');
        var notaVieja = String(sheetEgr.getRange(rowEgr, COL_E.NOTAS).getValue() || '');
        sheetEgr.getRange(rowEgr, COL_E.NOTAS).setValue(
          notaVieja + ' | ANULADO por edición — ' + stamp + ' | Reemplazado por nuevo egreso'
        );
        Logger.log('✅ Egreso viejo anulado: ' + egresoIdViejo);
        break;
      }
    }

    // Conservar URL vieja si no viene archivo nuevo
    if (!driveUrl) driveUrl = driveUrlVieja;

    // ── 3. Crear egreso nuevo ─────────────────────────────────
    var fechaGasto = data.fecha ||
      Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd');
    var yearEgr = new Date(fechaGasto + 'T12:00:00').getFullYear() || ahora.getFullYear();

    var seqEgr      = 1;
    var lastEgrRow2 = sheetEgr.getLastRow();
    if (lastEgrRow2 > 2) {
      var idsEgr2 = sheetEgr.getRange(3, 1, lastEgrRow2 - 2, 1).getValues();
      for (var ke = idsEgr2.length - 1; ke >= 0; ke--) {
        var ve     = String(idsEgr2[ke][0] || '');
        var partsE = ve.split('-');
        var ne     = parseInt(partsE[partsE.length - 1], 10);
        if (!isNaN(ne)) { seqEgr = ne + 1; break; }
      }
    }
    var egresoIdNuevo = 'EGR-RP-' + yearEgr + '-' + String(seqEgr).padStart(4, '0');

    var tipoMap = {
      'mano_obra':         'costo_servicio_tecnico',
      'flete':             'costo_servicio_tecnico',
      'combustible':       'combustible',
      'fianza':            'costo_servicio_tecnico',
      'subcontrato':       'servicios_profesionales',
      'producto':          'costo_mercancia',
      'impuesto':          'costo_servicio_tecnico',
      'aduana':            'costo_servicio_tecnico',
      'shipping_handling': 'costo_servicio_tecnico',
      'otro':              'costo_servicio_tecnico',
    };
    var tipoItem   = data.tipo || 'otro';
    var tipoEgreso = tipoMap[tipoItem] || 'costo_servicio_tecnico';
    var categoria  = data.categoria || tipoEgreso;
    var proveedor  = data.proveedor  || '';
    var numFactura = data.num_factura || '';

    var fechaGastoDate = new Date(fechaGasto + 'T12:00:00');
    var mesEgr  = isNaN(fechaGastoDate.getTime()) ? '' : (fechaGastoDate.getMonth() + 1);
    var anioEgr = isNaN(fechaGastoDate.getTime()) ? yearEgr : fechaGastoDate.getFullYear();

    var COL_COUNT = 21;
    var filaEgr   = new Array(COL_COUNT);
    for (var xe = 0; xe < COL_COUNT; xe++) filaEgr[xe] = '';

    filaEgr[0]  = egresoIdNuevo;
    filaEgr[1]  = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
    filaEgr[2]  = 'registrado';
    filaEgr[3]  = fechaGasto;
    filaEgr[4]  = mesEgr;
    filaEgr[5]  = anioEgr;
    filaEgr[6]  = subtotal || '';
    filaEgr[7]  = itbms    || '';
    filaEgr[8]  = total    || '';
    filaEgr[9]  = 'USD';
    filaEgr[10] = tipoEgreso;
    filaEgr[11] = categoria;
    filaEgr[12] = proveedor;
    filaEgr[13] = data.ruc_prov || '';
    filaEgr[14] = data.dv_prov  || '';
    filaEgr[15] = numFactura;
    filaEgr[16] = '';   // id_item_cv — vacío (exclusivo Compras_Ventas)
    filaEgr[17] = driveUrl;
    filaEgr[18] = data.descripcion || String(rec.data[COL_ST.DESCRIPCION - 1] || '');
    filaEgr[19] = 'ST: ' + idST + ' | Ítem: ' + idItemST +
                  ' | Edición de: ' + egresoIdViejo +
                  (data.notas ? ' | ' + data.notas : '');
    filaEgr[20] = idItemST;

    var newEgrRow = sheetEgr.getLastRow() + 1;
    sheetEgr.getRange(newEgrRow, 1, 1, COL_COUNT).setValues([filaEgr]);
    sheetEgr.getRange(newEgrRow, 7, 1, 3).setNumberFormat('#,##0.00');
    sheetEgr.getRange(newEgrRow, 1, 1, COL_COUNT).setBackground('#E8F5E9');
    Logger.log('✅ Egreso nuevo creado: ' + egresoIdNuevo + ' | Reemplaza: ' + egresoIdViejo);

    // ── 4. Actualizar fila en ST_Items ────────────────────────
    var sheetSTI = ss.getSheetByName(SHEET_ST_ITEM);
    if (sheetSTI && sheetSTI.getLastRow() > 2) {
      var numItemRows = sheetSTI.getLastRow() - 2;
      var itemData    = sheetSTI.getRange(3, 1, numItemRows, STI_NCOLS).getValues();
      for (var i = 0; i < itemData.length; i++) {
        if (String(itemData[i][COL_STI.ID - 1]) !== idItemST) continue;
        var itemRow = i + 3;
        sheetSTI.getRange(itemRow, COL_STI.MONTO_REAL).setValue(subtotal || total);
        sheetSTI.getRange(itemRow, COL_STI.ITBMS_REAL).setValue(itbms);
        sheetSTI.getRange(itemRow, COL_STI.TOTAL_REAL).setValue(total);
        if (driveUrl) sheetSTI.getRange(itemRow, COL_STI.DRIVE_URL).setValue(driveUrl);
        sheetSTI.getRange(itemRow, COL_STI.EGRESO_ID).setValue(egresoIdNuevo);
        sheetSTI.getRange(itemRow, COL_STI.ESTADO_ITEM).setValue('ejecutado');
        if (tipoItem) sheetSTI.getRange(itemRow, COL_STI.TIPO).setValue(tipoItem);
        sheetSTI.getRange(itemRow, 1, 1, STI_NCOLS).setBackground('#E8F5E9');
        Logger.log('✅ ST_Items actualizado: ' + idItemST + ' → egreso: ' + egresoIdNuevo);
        break;
      }
    }

    // ── 5. Recalcular total_costo_real en Servicios_Tecnicos ──
    var sheetSTI2 = ss.getSheetByName(SHEET_ST_ITEM);
    var totalReal = _calcSTTotalsReal(sheetSTI2, idST);
    var sheetST   = ss.getSheetByName(SHEET_ST);
    sheetST.getRange(rec.row, COL_ST.TOTAL_COSTO_REAL).setValue(totalReal);

    Logger.log('✅ actualizarEgresoST completo | ST: ' + idST +
               ' | Item: ' + idItemST + ' | Nuevo: ' + egresoIdNuevo +
               ' | Total real: $' + totalReal);

    return ContentService
      .createTextOutput(JSON.stringify({
        success:           true,
        egreso_id_nuevo:   egresoIdNuevo,
        egreso_id_anulado: egresoIdViejo,
        total:             total,
        total_costo_real:  totalReal,
      }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log('Error _handleActualizarEgresoST: ' + err.message);
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}


// ═══════════════════════════════════════════════════════════════
//  _handleEliminarItemCotizacion  (doGet)  ← MODIFICADO v1.3
//  Ya no bloquea si el ítem tiene egreso vinculado.
//  Lo anula automáticamente antes de cancelar el ítem.
// ═══════════════════════════════════════════════════════════════

function _handleEliminarItemCotizacion(params, callback) {
  var result = {
    success:        false,
    egreso_anulado: false,
    egreso_id:      '',
    error:          null,
  };
  try {
    var idItemST = params.id_item_st || '';
    var idST     = params.id_st      || '';
    if (!idItemST) throw new Error('id_item_st requerido');

    var ss       = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheetSTI = ss.getSheetByName(SHEET_ST_ITEM);
    if (!sheetSTI || sheetSTI.getLastRow() <= 2) throw new Error('Hoja ST_Items vacía');

    var numRows = sheetSTI.getLastRow() - 2;
    var data    = sheetSTI.getRange(3, 1, numRows, STI_NCOLS).getValues();
    var found   = false;
    var stamp   = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm');

    for (var i = 0; i < data.length; i++) {
      if (String(data[i][COL_STI.ID - 1]) !== String(idItemST)) continue;

      var rowNum   = i + 3;
      var egresoId = String(data[i][COL_STI.EGRESO_ID - 1] || '').trim();
      idST = idST || String(data[i][COL_STI.ID_ST - 1]);

      // ── Si tiene egreso vinculado, anularlo primero ──────────
      if (egresoId) {
        var sheetEgr = ss.getSheetByName(SHEET_EGRESOS);
        if (sheetEgr && sheetEgr.getLastRow() > 2) {
          var numEgr  = sheetEgr.getLastRow() - 2;
          var idsEgr  = sheetEgr.getRange(3, COL_E.ID, numEgr, 1).getValues();
          for (var e = 0; e < idsEgr.length; e++) {
            if (String(idsEgr[e][0] || '').trim() !== egresoId) continue;
            var rowEgr = e + 3;
            sheetEgr.getRange(rowEgr, COL_E.ESTADO).setValue('anulado');
            sheetEgr.getRange(rowEgr, 1, 1, EGRESOS_NCOLS).setBackground('#FFEBEE');
            var notaEgr = String(sheetEgr.getRange(rowEgr, COL_E.NOTAS).getValue() || '');
            sheetEgr.getRange(rowEgr, COL_E.NOTAS).setValue(
              notaEgr + ' | ANULADO — eliminación ítem ' + idItemST + ': ' + stamp
            );
            result.egreso_anulado = true;
            result.egreso_id      = egresoId;
            Logger.log('✅ Egreso anulado al borrar ítem: ' + egresoId);
            break;
          }
        }
      }

      // ── Cancelar el ítem ─────────────────────────────────────
      sheetSTI.getRange(rowNum, COL_STI.ESTADO_ITEM).setValue('cancelado');
      sheetSTI.getRange(rowNum, 1, 1, STI_NCOLS).setBackground('#FFEBEE');
      found = true;
      break;
    }

    if (!found) throw new Error('Ítem no encontrado: ' + idItemST);

    // ── Recalcular totales del ST ─────────────────────────────
    if (idST) {
      var totalesRecalc = _calcSTTotals(sheetSTI, idST);
      var recST         = _getSTById(ss, idST);
      if (recST) {
        var sheetST = ss.getSheetByName(SHEET_ST);
        sheetST.getRange(recST.row, COL_ST.TOTAL_COSTO_COT).setValue(totalesRecalc.totalCostoCot);
        sheetST.getRange(recST.row, COL_ST.TOTAL_COSTO_REAL).setValue(_calcSTTotalsReal(sheetSTI, idST));
        var margenST = parseFloat(recST.data[COL_ST.MARGEN_PCT - 1] || '0') || 0;
        if (margenST > 0) {
          sheetST.getRange(recST.row, COL_ST.PRECIO_VENTA).setValue(
            parseFloat((totalesRecalc.totalCostoCot * (1 + margenST / 100)).toFixed(2))
          );
        }
      }
    }

    result.success = true;
    Logger.log('✅ Ítem cancelado: ' + idItemST +
               (result.egreso_anulado ? ' | Egreso anulado: ' + result.egreso_id : ' | Sin egreso'));

  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleEliminarItemCotizacion v1.3: ' + err.message);
  }

  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}


// ═══════════════════════════════════════════════════════════════
//  _handleGetCotizaciones  (doGet)
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
//  PATCH ContaFacil_ServiciosTecnicos.gs → v1.3.1
//
//  FIX: columna "Proveedor" vacía en tabla Costos del P&L.
//
//  CAUSA: _handleGetCotizaciones llamaba a _serializeSTItem()
//  directamente. Ese helper inicializa proveedor='' y num_factura=''
//  por diseño (el comentario en el código dice explícitamente que
//  "se inyectan en _handleGetResumenST cruzando con el mapa de
//  egresos"). El handler getCotizaciones nunca hacía ese cruce,
//  así que plStItems.filter(si => si.item.proveedor).length === 0.
//
//  SOLUCIÓN: construir el mismo mapa egreso_id → {proveedor,
//  num_factura} que usa getResumenST, e inyectarlo en cada ítem
//  al armar itemsMap. Un solo recorrido de la hoja Egresos cubre
//  todos los STs de una vez (O(n) en vez de O(n×m)).
//
//  INSTRUCCIÓN: reemplazar la función _handleGetCotizaciones
//  en ContaFacil_ServiciosTecnicos.gs con la versión de abajo.
//  Sin más cambios. Redeploy después de guardar.
// ═══════════════════════════════════════════════════════════════

function _handleGetCotizaciones(params, callback) {
  var result = { success: false, items: [], error: null };
  try {
    var ss      = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheetST = ss.getSheetByName(SHEET_ST);

    if (!sheetST || sheetST.getLastRow() <= 2) {
      result.success = true;
      var json0 = JSON.stringify(result);
      if (callback) return ContentService.createTextOutput(callback + '(' + json0 + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
      return ContentService.createTextOutput(json0).setMimeType(ContentService.MimeType.JSON);
    }

    var filtroEstado = params.estado || '';
    var filtroId     = params.id_st  || '';

    var numSTRows = sheetST.getLastRow() - 2;
    var stData    = sheetST.getRange(3, 1, numSTRows, ST_NCOLS).getValues();

    // ── Mapa egreso_id → { proveedor, num_factura } ──────────────────────
    // Necesario para inyectar el nombre del proveedor en cada ST_Item.
    // _serializeSTItem los inicializa en '' por diseño — solo viven en Egresos.
    var egresoMap = {};
    var sheetEgr  = ss.getSheetByName(SHEET_EGRESOS);
    if (sheetEgr && sheetEgr.getLastRow() > 2) {
      var numEgrRows = sheetEgr.getLastRow() - 2;
      var egrData    = sheetEgr.getRange(3, 1, numEgrRows, EGRESOS_NCOLS).getValues();
      for (var e = 0; e < egrData.length; e++) {
        var eid = String(egrData[e][COL_E.ID - 1] || '').trim();
        if (!eid) continue;
        egresoMap[eid] = {
          proveedor:   String(egrData[e][COL_E.PROVEEDOR - 1] || ''),
          num_factura: String(egrData[e][COL_E.NFACTURA  - 1] || ''),
        };
      }
    }

    // ── ST_Items → itemsMap con proveedor inyectado ──────────────────────
    var sheetSTI   = ss.getSheetByName(SHEET_ST_ITEM);
    var itemsMap   = {};
    if (sheetSTI && sheetSTI.getLastRow() > 2) {
      var numItemRows = sheetSTI.getLastRow() - 2;
      var itemData    = sheetSTI.getRange(3, 1, numItemRows, STI_NCOLS).getValues();
      for (var j = 0; j < itemData.length; j++) {
        var r     = itemData[j];
        var stKey = String(r[COL_STI.ID_ST - 1] || '');
        if (!stKey) continue;
        if (!itemsMap[stKey]) itemsMap[stKey] = [];
        var item = _serializeSTItem(r);
        // Inyectar proveedor/num_factura desde el mapa de egresos
        if (item.egreso_id && egresoMap[item.egreso_id]) {
          item.proveedor   = egresoMap[item.egreso_id].proveedor;
          item.num_factura = egresoMap[item.egreso_id].num_factura;
        }
        itemsMap[stKey].push(item);
      }
    }

    var sts = [];
    for (var i = 0; i < stData.length; i++) {
      var r = stData[i];
      if (!r[COL_ST.ID - 1]) continue;
      if (filtroEstado && String(r[COL_ST.ESTADO - 1]) !== filtroEstado) continue;
      if (filtroId    && String(r[COL_ST.ID - 1])      !== filtroId)     continue;

      var st   = _serializeST(r);
      st.items = itemsMap[st.id_st] || [];
      sts.push(st);
    }

    sts.sort(function(a, b) {
      return String(b.fecha_reg).localeCompare(String(a.fecha_reg));
    });

    // ── Enriquecer con subtotal_venta y es_exento desde Ingresos ─────────
    try {
      var sheetIngLst = ss.getSheetByName(CONFIG.SHEET_INGRESOS);
      if (sheetIngLst && sheetIngLst.getLastRow() > 2) {
        var numIngLst  = sheetIngLst.getLastRow() - 2;
        var ingLstData = sheetIngLst.getRange(3, 1, numIngLst, INGRESOS_NCOLS).getValues();
        var ingMap = {};
        for (var ii = 0; ii < ingLstData.length; ii++) {
          var ingId = String(ingLstData[ii][COL_I.ID_TRANS - 1] || '').trim();
          if (!ingId) continue;
          var fechaIng = ingLstData[ii][COL_I.FECHA_INGRESO - 1];
          if (fechaIng instanceof Date) {
            fechaIng = Utilities.formatDate(fechaIng, 'America/Panama', 'yyyy-MM-dd');
          } else {
            fechaIng = String(fechaIng || '').slice(0, 10);
          }
          ingMap[ingId] = {
            subtotal:      parseFloat(ingLstData[ii][COL_I.SUBTOTAL  - 1] || '0') || 0,
            categoria:     String(ingLstData[ii][COL_I.CATEGORIA - 1] || ''),
            fecha_ingreso: fechaIng,
            mes:           ingLstData[ii][COL_I.MES - 1] || '',
            anio:          ingLstData[ii][COL_I.ANIO_FISCAL - 1] || '',
          };
        }
        for (var si = 0; si < sts.length; si++) {
          var ingId2 = String(sts[si].ingreso_id || '').trim();
          if (ingId2 && ingMap[ingId2]) {
            sts[si].subtotal_venta = ingMap[ingId2].subtotal;
            var cat = ingMap[ingId2].categoria;
            sts[si].es_exento      = (cat === 'servicio_tecnico_exento' || cat === 'venta_producto_exento');
            sts[si].fecha_ingreso  = ingMap[ingId2].fecha_ingreso;
            sts[si].mes_ingreso    = ingMap[ingId2].mes;
            sts[si].anio_ingreso   = ingMap[ingId2].anio;
          } else {
            sts[si].subtotal_venta = 0;
            sts[si].es_exento      = false;
            sts[si].fecha_ingreso  = '';
            sts[si].mes_ingreso    = '';
            sts[si].anio_ingreso   = '';
          }
        }
      }
    } catch(ingErr) {
      Logger.log('⚠️ _handleGetCotizaciones: error enriqueciendo subtotal_venta: ' + ingErr.message);
    }

    result.success = true;
    result.items   = sts;
  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleGetCotizaciones: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}


// ═══════════════════════════════════════════════════════════════
//  _handleAprobarCotizacion  (doGet)
// ═══════════════════════════════════════════════════════════════

function _handleAprobarCotizacion(params, callback) {
  var result = { success: false, error: null };
  try {
    var idST = params.id_st || '';
    if (!idST) throw new Error('id_st requerido');

    var ss  = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var rec = _getSTById(ss, idST);
    if (!rec) throw new Error('ST no encontrado: ' + idST);

    var estadoActual = String(rec.data[COL_ST.ESTADO - 1] || '');
    if (estadoActual !== 'cotizado') {
      throw new Error('Solo se pueden aprobar STs en estado "cotizado". Estado actual: ' + estadoActual);
    }

    var fechaAprobacion = params.fecha_aprobacion ||
      Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd');

    var sheetST = ss.getSheetByName(SHEET_ST);
    sheetST.getRange(rec.row, COL_ST.ESTADO).setValue('aprobado');
    sheetST.getRange(rec.row, COL_ST.FECHA_APROBACION).setValue(fechaAprobacion);
    sheetST.getRange(rec.row, 1, 1, ST_NCOLS).setBackground('#E3F2FD');

    result.success = true;
    Logger.log('✅ ST aprobado: ' + idST);
  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleAprobarCotizacion: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}


// ═══════════════════════════════════════════════════════════════
//  _handleIniciarEjecucion  (doGet)
// ═══════════════════════════════════════════════════════════════

function _handleIniciarEjecucion(params, callback) {
  var result = { success: false, error: null };
  try {
    var idST = params.id_st || '';
    if (!idST) throw new Error('id_st requerido');

    var ss  = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var rec = _getSTById(ss, idST);
    if (!rec) throw new Error('ST no encontrado: ' + idST);

    var estadoActual = String(rec.data[COL_ST.ESTADO - 1] || '');
    if (estadoActual !== 'aprobado') {
      throw new Error('Solo se puede iniciar ejecución desde estado "aprobado". Estado actual: ' + estadoActual);
    }

    var fechaInicio = params.fecha_inicio ||
      Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd');

    var sheetST = ss.getSheetByName(SHEET_ST);
    sheetST.getRange(rec.row, COL_ST.ESTADO).setValue('en_ejecucion');
    sheetST.getRange(rec.row, COL_ST.FECHA_INICIO).setValue(fechaInicio);
    sheetST.getRange(rec.row, 1, 1, ST_NCOLS).setBackground('#F3E5F5');

    result.success = true;
    Logger.log('✅ ST en ejecución: ' + idST);
  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleIniciarEjecucion: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}


// ═══════════════════════════════════════════════════════════════
//  _handleRegistrarIngresoST  (doPost)
// ═══════════════════════════════════════════════════════════════

function _handleRegistrarIngresoST(data) {
  try {
    var idST = data.id_st || '';
    if (!idST) throw new Error('id_st requerido');

    var ss  = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var rec = _getSTById(ss, idST);
    if (!rec) throw new Error('ST no encontrado: ' + idST);

    var estadoActual = String(rec.data[COL_ST.ESTADO - 1] || '');
    if (estadoActual !== 'aprobado' && estadoActual !== 'en_ejecucion') {
      throw new Error('Solo se puede registrar ingreso en estado "aprobado" o "en_ejecucion". Estado actual: ' + estadoActual);
    }

    var ingresoExistente = String(rec.data[COL_ST.INGRESO_ID - 1] || '').trim();
    if (ingresoExistente) {
      throw new Error('Este ST ya tiene un ingreso registrado: ' + ingresoExistente);
    }

    var precioVenta = parseFloat(rec.data[COL_ST.PRECIO_VENTA - 1] || '0') || 0;
    if (!precioVenta) throw new Error('El ST no tiene precio de venta definido. Actualiza la cotización primero.');

    var driveUrl = '';
    if (data.imageBase64 && data.imageName) {
      try {
        var folder   = DriveApp.getFolderById(CONFIG.VOUCHER_FOLDER_ID);
        var mimeComp = data.imageMime || 'image/jpeg';
        var bytes    = Utilities.base64Decode(data.imageBase64);
        var blob     = Utilities.newBlob(bytes, mimeComp, data.imageName);
        var file     = folder.createFile(blob);
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        driveUrl = 'https://drive.google.com/file/d/' + file.getId() + '/view';
      } catch(driveErr) {
        Logger.log('⚠️ Error subiendo comprobante ST: ' + driveErr.message);
      }
    }

    var ahora = new Date();

    var esGravado   = data.es_gravado !== false && data.es_gravado !== 'false';
    var subtotal    = esGravado ? parseFloat((precioVenta / 1.07).toFixed(2)) : precioVenta;
    var itbms       = esGravado ? parseFloat((precioVenta - subtotal).toFixed(2)) : 0;
    var categoria   = esGravado ? 'servicio_tecnico_gravado' : 'servicio_tecnico_exento';

    var fechaIngreso = data.fecha ||
      Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd');
    var mes  = new Date(fechaIngreso + 'T12:00:00').getMonth() + 1;
    var anio = new Date(fechaIngreso + 'T12:00:00').getFullYear();

    var id = 'ING-RP-' + Utilities.formatDate(ahora, 'America/Panama', 'yyyyMMddHHmmss') + '-ST';

    var sheetIng = ss.getSheetByName(CONFIG.SHEET_INGRESOS);
    if (!sheetIng) throw new Error('Hoja Ingresos no encontrada. Ejecuta initSheets().');

    var numFactura  = data.num_factura  || String(rec.data[COL_ST.NUM_COT - 1] || '');
    var nombreCli   = String(rec.data[COL_ST.NOMBRE_CLI - 1] || '');
    var lastIngRow  = sheetIng.getLastRow();
    if (lastIngRow > 2 && numFactura) {
      var existIng = sheetIng.getRange(3, 1, lastIngRow - 2, INGRESOS_NCOLS).getValues();
      for (var d = 0; d < existIng.length; d++) {
        if (String(existIng[d][COL_I.NUM_FACTURA - 1]) === numFactura &&
            String(existIng[d][COL_I.NOMBRE_CLI - 1]).toLowerCase() === nombreCli.toLowerCase()) {
          throw new Error('DUPLICADO: Ya existe un ingreso para el cliente "' + nombreCli +
                          '" con referencia "' + numFactura + '"');
        }
      }
    }

    var fechaReg = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');

    var fila = new Array(INGRESOS_NCOLS);
    for (var xi = 0; xi < INGRESOS_NCOLS; xi++) fila[xi] = '';
    fila[COL_I.ID_TRANS - 1]      = id;
    fila[COL_I.FECHA_REG - 1]     = fechaReg;
    fila[COL_I.ESTADO - 1]        = 'confirmado';
    fila[COL_I.CONFIANZA_IA - 1]  = 'manual';
    fila[COL_I.FECHA_INGRESO - 1] = fechaIngreso;
    fila[COL_I.MES - 1]           = mes;
    fila[COL_I.ANIO_FISCAL - 1]   = anio;
    fila[COL_I.SUBTOTAL - 1]      = subtotal;
    fila[COL_I.ITBMS - 1]         = itbms;
    fila[COL_I.TOTAL - 1]         = precioVenta;
    fila[COL_I.MONEDA - 1]        = 'USD';
    fila[COL_I.TIPO_INGRESO - 1]  = 'servicio_tecnico';
    fila[COL_I.CATEGORIA - 1]     = categoria;
    fila[COL_I.NOMBRE_CLI - 1]    = nombreCli;
    fila[COL_I.RUC_CLI - 1]       = String(rec.data[COL_ST.RUC_CLI - 1] || '');
    fila[COL_I.TIPO_PERSONA - 1]  = detectarTipoPersona(String(rec.data[COL_ST.RUC_CLI - 1] || ''));
    fila[COL_I.NUM_FACTURA - 1]   = numFactura;
    fila[COL_I.TIPO_COMP - 1]     = data.forma_pago || 'factura_emitida';
    fila[COL_I.DRIVE_URL - 1]     = driveUrl;
    fila[COL_I.DESCRIPCION - 1]   = data.descripcion || String(rec.data[COL_ST.DESCRIPCION - 1] || '');
    fila[COL_I.NOTAS_INT - 1]     = 'ST: ' + idST + ' | Cotización: ' + String(rec.data[COL_ST.NUM_COT - 1] || '') +
                                     (data.forma_pago ? ' | Pago: ' + data.forma_pago : '');
    fila[COL_I.FLAG_REV - 1]      = false;
    fila[COL_I.DV_CLI - 1]        = String(rec.data[COL_ST.DV_CLI - 1] || '');

    var newIngRow = sheetIng.getLastRow() + 1;
    sheetIng.getRange(newIngRow, 1, 1, INGRESOS_NCOLS).setValues([fila]);
    sheetIng.getRange(newIngRow, COL_I.SUBTOTAL, 1, 3).setNumberFormat('#,##0.00');
    sheetIng.getRange(newIngRow, 1, 1, INGRESOS_NCOLS).setBackground('#F1F8E9');

    var sheetST = ss.getSheetByName(SHEET_ST);
    sheetST.getRange(rec.row, COL_ST.INGRESO_ID).setValue(id);
    if (driveUrl) sheetST.getRange(rec.row, COL_ST.DRIVE_URL).setValue(driveUrl);

    Logger.log('✅ Ingreso ST: ' + id + ' | ST: ' + idST + ' | $' + precioVenta);

    return ContentService
      .createTextOutput(JSON.stringify({
        success:    true,
        ingreso_id: id,
        total:      precioVenta,
        subtotal:   subtotal,
        itbms:      itbms,
      }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log('Error _handleRegistrarIngresoST: ' + err.message);
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}


// ═══════════════════════════════════════════════════════════════
//  _handleRegistrarEgresoST  (doPost)
// ═══════════════════════════════════════════════════════════════

function _handleRegistrarEgresoST(data) {
  try {
    var idST     = data.id_st     || '';
    var idItemST = data.id_item_st || '';
    if (!idST) throw new Error('id_st requerido');

    var ss  = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var rec = _getSTById(ss, idST);
    if (!rec) throw new Error('ST no encontrado: ' + idST);

    var estadoActual = String(rec.data[COL_ST.ESTADO - 1] || '');
    if (estadoActual !== 'en_ejecucion' && estadoActual !== 'aprobado') {
      throw new Error('Solo se pueden registrar egresos en STs "aprobado" o "en_ejecucion". Estado: ' + estadoActual);
    }

    var driveUrl = '';
    if (data.imageBase64 && data.imageName) {
      try {
        var folder   = DriveApp.getFolderById(CONFIG.VOUCHER_FOLDER_ID);
        var mimeDoc  = data.imageMime || 'image/jpeg';
        var bytes    = Utilities.base64Decode(data.imageBase64);
        var blob     = Utilities.newBlob(bytes, mimeDoc, data.imageName);
        var file     = folder.createFile(blob);
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        driveUrl = 'https://drive.google.com/file/d/' + file.getId() + '/view';
      } catch(driveErr) {
        Logger.log('⚠️ Error subiendo factura egreso ST: ' + driveErr.message);
      }
    }

    var total    = parseFloat(data.total)    || 0;
    var itbms    = parseFloat(data.itbms)    || 0;
    var subtotal = parseFloat(data.subtotal) || parseFloat((total - itbms).toFixed(2));

    var ahora      = new Date();
    var fechaGasto = data.fecha ||
      Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd');

    var sheetEgr = ss.getSheetByName(SHEET_EGRESOS);
    if (!sheetEgr) throw new Error('Hoja Egresos no encontrada. Ejecuta initSheets().');

    var yearEgr    = new Date(fechaGasto + 'T12:00:00').getFullYear() || ahora.getFullYear();
    var seqEgr     = 1;
    var lastEgrRow = sheetEgr.getLastRow();
    if (lastEgrRow > 2) {
      var idsEgr = sheetEgr.getRange(3, 1, lastEgrRow - 2, 1).getValues();
      for (var ke = idsEgr.length - 1; ke >= 0; ke--) {
        var ve     = String(idsEgr[ke][0] || '');
        var partsE = ve.split('-');
        var ne     = parseInt(partsE[partsE.length - 1], 10);
        if (!isNaN(ne)) { seqEgr = ne + 1; break; }
      }
    }
    var egresoId = 'EGR-RP-' + yearEgr + '-' + String(seqEgr).padStart(4, '0');

    var proveedor  = data.proveedor  || '';
    var numFactura = data.num_factura || '';

    if (proveedor && numFactura && lastEgrRow > 2) {
      var EGRESOS_CHECK_NCOLS = Math.max(EGRESOS_NCOLS, 20);
      var existEgr = sheetEgr.getRange(3, 1, lastEgrRow - 2, EGRESOS_CHECK_NCOLS).getValues();
      for (var d = 0; d < existEgr.length; d++) {
        var provExist = String(existEgr[d][12] || '').trim().toUpperCase();
        var nfacExist = String(existEgr[d][15] || '').trim();
        if (provExist === proveedor.trim().toUpperCase() && nfacExist && nfacExist === numFactura.trim()) {
          throw new Error('DUPLICADO: Ya existe un egreso del proveedor "' + proveedor +
                          '" con factura "' + numFactura + '"');
        }
      }
    }

    var fechaGastoDate = new Date(fechaGasto + 'T12:00:00');
    var mesEgr  = isNaN(fechaGastoDate.getTime()) ? '' : (fechaGastoDate.getMonth() + 1);
    var anioEgr = isNaN(fechaGastoDate.getTime()) ? yearEgr : fechaGastoDate.getFullYear();

    var tipoMap = {
      'mano_obra':         'costo_servicio_tecnico',
      'flete':             'costo_servicio_tecnico',
      'combustible':       'combustible',
      'fianza':            'costo_servicio_tecnico',
      'subcontrato':       'servicios_profesionales',
      'producto':          'costo_mercancia',
      'impuesto':          'costo_servicio_tecnico',
      'aduana':            'costo_servicio_tecnico',
      'shipping_handling': 'costo_servicio_tecnico',
      'otro':              'costo_servicio_tecnico',
    };
    var tipoItem   = data.tipo || 'otro';
    var tipoEgreso = tipoMap[tipoItem] || 'costo_servicio_tecnico';
    var categoria  = data.categoria || tipoEgreso;

    var COL_COUNT = 21;
    var filaEgr   = new Array(COL_COUNT);
    for (var xe = 0; xe < COL_COUNT; xe++) filaEgr[xe] = '';

    filaEgr[0]  = egresoId;
    filaEgr[1]  = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
    filaEgr[2]  = 'registrado';
    filaEgr[3]  = fechaGasto;
    filaEgr[4]  = mesEgr;
    filaEgr[5]  = anioEgr;
    filaEgr[6]  = subtotal || '';
    filaEgr[7]  = itbms    || '';
    filaEgr[8]  = total    || '';
    filaEgr[9]  = 'USD';
    filaEgr[10] = tipoEgreso;
    filaEgr[11] = categoria;
    filaEgr[12] = proveedor;
    filaEgr[13] = data.ruc_prov  || '';
    filaEgr[14] = data.dv_prov   || '';
    filaEgr[15] = numFactura;
    filaEgr[16] = '';   // col 17 id_item_cv — VACÍO: exclusivo de Compras_Ventas
    filaEgr[17] = driveUrl;
    filaEgr[18] = data.descripcion || String(rec.data[COL_ST.DESCRIPCION - 1] || '');
    filaEgr[19] = 'ST: ' + idST + (idItemST ? ' | Ítem: ' + idItemST : ' | Costo adicional') +
                  (data.notas ? ' | ' + data.notas : '');
    filaEgr[20] = idItemST ? idItemST : idST;

    var newEgrRow = sheetEgr.getLastRow() + 1;
    sheetEgr.getRange(newEgrRow, 1, 1, COL_COUNT).setValues([filaEgr]);
    sheetEgr.getRange(newEgrRow, 7, 1, 3).setNumberFormat('#,##0.00');
    sheetEgr.getRange(newEgrRow, 1, 1, COL_COUNT).setBackground('#F3E5F5');

    var sheetSTI = ss.getSheetByName(SHEET_ST_ITEM);
    if (!sheetSTI) sheetSTI = _initSTItemsSheet(ss);

    if (idItemST) {
      if (sheetSTI.getLastRow() > 2) {
        var numItemRows = sheetSTI.getLastRow() - 2;
        var itemData    = sheetSTI.getRange(3, 1, numItemRows, STI_NCOLS).getValues();
        for (var i = 0; i < itemData.length; i++) {
          if (String(itemData[i][COL_STI.ID - 1]) !== String(idItemST)) continue;
          var itemRow = i + 3;
          sheetSTI.getRange(itemRow, COL_STI.MONTO_REAL).setValue(subtotal || total);
          sheetSTI.getRange(itemRow, COL_STI.ITBMS_REAL).setValue(itbms);
          sheetSTI.getRange(itemRow, COL_STI.TOTAL_REAL).setValue(total);
          sheetSTI.getRange(itemRow, COL_STI.DRIVE_URL).setValue(driveUrl);
          sheetSTI.getRange(itemRow, COL_STI.EGRESO_ID).setValue(egresoId);
          sheetSTI.getRange(itemRow, COL_STI.ESTADO_ITEM).setValue('ejecutado');
          sheetSTI.getRange(itemRow, 1, 1, STI_NCOLS).setBackground('#E8F5E9');
          break;
        }
      }
    } else {
      var ahoraSTI    = new Date();
      var idItemLib   = 'STI-RP-' + Utilities.formatDate(ahoraSTI, 'America/Panama', 'yyyyMMddHHmmss') + '-L';
      var fechaRegSTI = Utilities.formatDate(ahoraSTI, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
      var descItem    = data.descripcion || String(rec.data[COL_ST.DESCRIPCION - 1] || 'Costo adicional');
      var aplicaITB   = itbms > 0;

      var filaSTI = new Array(STI_NCOLS);
      for (var xsi = 0; xsi < STI_NCOLS; xsi++) filaSTI[xsi] = '';
      filaSTI[COL_STI.ID - 1]           = idItemLib;
      filaSTI[COL_STI.ID_ST - 1]        = idST;
      filaSTI[COL_STI.TIPO - 1]         = tipoItem;
      filaSTI[COL_STI.DESCRIPCION - 1]  = descItem;
      filaSTI[COL_STI.CANTIDAD - 1]     = 1;
      filaSTI[COL_STI.PRECIO_UNIT - 1]  = total;
      filaSTI[COL_STI.APLICA_ITBMS - 1] = aplicaITB;
      filaSTI[COL_STI.MONTO_COT - 1]    = '';
      filaSTI[COL_STI.ITBMS_COT - 1]    = '';
      filaSTI[COL_STI.TOTAL_COT - 1]    = '';
      filaSTI[COL_STI.ES_ADICIONAL - 1] = true;
      filaSTI[COL_STI.MONTO_REAL - 1]   = subtotal || total;
      filaSTI[COL_STI.ITBMS_REAL - 1]   = itbms;
      filaSTI[COL_STI.TOTAL_REAL - 1]   = total;
      filaSTI[COL_STI.DRIVE_URL - 1]    = driveUrl;
      filaSTI[COL_STI.EGRESO_ID - 1]    = egresoId;
      filaSTI[COL_STI.ESTADO_ITEM - 1]  = 'ejecutado';
      filaSTI[COL_STI.NOTAS - 1]        = data.notas || '';
      filaSTI[COL_STI.FECHA_REG - 1]    = fechaRegSTI;

      var newSTIRow = sheetSTI.getLastRow() + 1;
      sheetSTI.getRange(newSTIRow, 1, 1, STI_NCOLS).setValues([filaSTI]);
      sheetSTI.getRange(newSTIRow, COL_STI.MONTO_REAL, 1, 3).setNumberFormat('#,##0.00');
      sheetSTI.getRange(newSTIRow, 1, 1, STI_NCOLS).setBackground('#F3E5F5');
      Logger.log('✅ ST_Items adicional creado: ' + idItemLib + ' | ' + tipoItem + ' | $' + total);
    }

    var sheetSTI2 = ss.getSheetByName(SHEET_ST_ITEM);
    var totalReal = _calcSTTotalsReal(sheetSTI2, idST);
    var sheetST   = ss.getSheetByName(SHEET_ST);
    sheetST.getRange(rec.row, COL_ST.TOTAL_COSTO_REAL).setValue(totalReal);

    Logger.log('✅ Egreso ST: ' + egresoId + ' | ST: ' + idST +
               (idItemST ? ' | Ítem: ' + idItemST : ' | libre') + ' | $' + total);

    return ContentService
      .createTextOutput(JSON.stringify({
        success:          true,
        egreso_id:        egresoId,
        total:            total,
        total_costo_real: totalReal,
      }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log('Error _handleRegistrarEgresoST: ' + err.message);
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}


// ═══════════════════════════════════════════════════════════════
//  _handleGetResumenST  (doGet)  — v1.3
//  v1.3: agrega subtotal_venta y es_exento al resumen
//    subtotal_venta = monto neto sin ITBMS (correcto para gravados y exentos)
//    es_exento = true si categoria del ingreso es venta_producto_exento o servicio_tecnico_exento
// ═══════════════════════════════════════════════════════════════

function _handleGetResumenST(params, callback) {
  var result = { success: false, resumen: null, error: null };
  try {
    var idST = params.id_st || '';
    if (!idST) throw new Error('id_st requerido');

    var ss  = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var rec = _getSTById(ss, idST);
    if (!rec) throw new Error('ST no encontrado: ' + idST);
    var st = _serializeST(rec.data);

    var sheetEgr     = ss.getSheetByName(SHEET_EGRESOS);
    var egresosPorId = {};
    var colsEgr = 20;
    if (sheetEgr && sheetEgr.getLastRow() > 2) {
      var numEgrPre  = sheetEgr.getLastRow() - 2;
      var egrAllData = sheetEgr.getRange(3, 1, numEgrPre, colsEgr).getValues();
      egrAllData.forEach(function(r) {
        var eid = String(r[COL_E.ID - 1] || '').trim();
        if (eid) egresosPorId[eid] = r;
      });
    }

    function esDeInventario(egresoRow) {
      if (!egresoRow) return false;
      var notas = String(egresoRow[COL_E.NOTAS - 1] || '').toLowerCase();
      return notas.indexOf('origen: inventario') !== -1;
    }

    var sheetSTI = ss.getSheetByName(SHEET_ST_ITEM);
    var items = [];
    var egresoIdsEnSTItems = {};

    if (sheetSTI && sheetSTI.getLastRow() > 2) {
      var numRows  = sheetSTI.getLastRow() - 2;
      var itemData = sheetSTI.getRange(3, 1, numRows, STI_NCOLS).getValues();
      for (var i = 0; i < itemData.length; i++) {
        if (String(itemData[i][COL_STI.ID_ST - 1]) !== String(idST)) continue;
        var item = _serializeSTItem(itemData[i]);

        if (item.egreso_id && egresosPorId[item.egreso_id]) {
          var eRow = egresosPorId[item.egreso_id];
          item.proveedor   = String(eRow[COL_E.PROVEEDOR - 1] || '');
          item.num_factura = String(eRow[COL_E.NFACTURA  - 1] || '');
        }

        item.from_inventory = false;
        if (item.egreso_id) {
          item.from_inventory = esDeInventario(egresosPorId[item.egreso_id]);
        }

        var varMonto = 0, varPct = 0;
        if (item.total_cotizado > 0 && item.total_real > 0) {
          varMonto = parseFloat((item.total_real - item.total_cotizado).toFixed(2));
          varPct   = parseFloat(((varMonto / item.total_cotizado) * 100).toFixed(1));
        }
        item.variacion_monto = varMonto;
        item.variacion_pct   = varPct;
        item.semaforo = varPct <= 0 ? 'verde' : (varPct <= 10 ? 'amarillo' : 'rojo');

        items.push(item);
        if (item.egreso_id) egresoIdsEnSTItems[String(item.egreso_id).trim()] = true;
      }
    }

    var stTag = 'ST: ' + idST;
    if (sheetEgr && sheetEgr.getLastRow() > 2) {
      var numEgr  = sheetEgr.getLastRow() - 2;
      var egrData = sheetEgr.getRange(3, 1, numEgr, colsEgr).getValues();

      for (var e = 0; e < egrData.length; e++) {
        var row      = egrData[e];
        var egresoId = String(row[COL_E.ID - 1] || '').trim();
        if (!egresoId) continue;
        if (String(row[COL_E.ESTADO - 1] || '').toLowerCase() === 'anulado') continue;
        if (egresoIdsEnSTItems[egresoId]) continue;

        var notasE    = String(row[COL_E.NOTAS - 1] || '');
        var pertenece = notasE.indexOf(stTag) !== -1;
        if (!pertenece) continue;

        var fechaGasto = row[COL_E.FECHA_GASTO - 1];
        if (fechaGasto instanceof Date) {
          fechaGasto = Utilities.formatDate(fechaGasto, 'America/Panama', 'yyyy-MM-dd');
        } else { fechaGasto = String(fechaGasto || '').slice(0, 10); }

        var totalEgr    = parseFloat(row[COL_E.TOTAL - 1])    || 0;
        var subtotalEgr = parseFloat(row[COL_E.SUBTOTAL - 1]) || 0;
        var itbmsEgr    = parseFloat(row[COL_E.ITBMS - 1])    || 0;
        var tipoEgr     = String(row[COL_E.TIPO_EGRESO - 1]   || 'otro');
        var descEgr     = String(row[COL_E.DESCRIPCION - 1]   || '');
        var provEgr     = String(row[COL_E.PROVEEDOR - 1]     || '');
        var driveEgr    = String(row[COL_E.DRIVE_URL - 1]     || '');
        var nfacEgr     = String(row[COL_E.NFACTURA - 1]      || '');
        var fromInv     = esDeInventario(row);

        var tipoItemMap = {
          'costo_mercancia':        'producto',
          'costo_servicio_tecnico': 'mano_obra',
          'combustible':            'combustible',
          'servicios_profesionales':'subcontrato',
        };
        if (!descEgr && provEgr) descEgr = provEgr + (nfacEgr ? ' — ' + nfacEgr : '');
        if (!descEgr) descEgr = 'Costo adicional';

        items.push({
          id_item_st:       'EGR-' + egresoId,
          id_st:            idST,
          tipo:             tipoItemMap[tipoEgr] || 'otro',
          descripcion:      descEgr,
          cantidad:         1,
          precio_unitario:  totalEgr,
          aplica_itbms:     itbmsEgr > 0,
          monto_cotizado:   0, itbms_cotizado: 0, total_cotizado: 0,
          margen_item_pct:  0, precio_venta_item: 0,
          es_adicional:     true,
          monto_real:       subtotalEgr || totalEgr,
          itbms_real:       itbmsEgr,
          total_real:       totalEgr,
          drive_url:        driveEgr,
          egreso_id:        egresoId,
          estado_item:      'ejecutado',
          from_inventory:   fromInv,
          notas:            notasE,
          fecha_reg:        fechaGasto,
          proveedor:        provEgr,
          num_factura:      nfacEgr,
          variacion_monto:  0, variacion_pct: 0, semaforo: 'verde',
        });
      }
    }

    var totalCotizado = st.total_costo_cotizado;
    var totalReal = 0;
    items.forEach(function(it) { totalReal += (it.total_real || 0); });
    totalReal = parseFloat(totalReal.toFixed(2));

    var precioVenta      = st.precio_venta;
    var margenReal       = precioVenta > 0 ? parseFloat(((precioVenta - totalReal)     / precioVenta * 100).toFixed(2)) : 0;
    var margenCotizado   = precioVenta > 0 ? parseFloat(((precioVenta - totalCotizado) / precioVenta * 100).toFixed(2)) : 0;
    var utilidadReal     = parseFloat((precioVenta - totalReal).toFixed(2));
    var utilidadCotizada = parseFloat((precioVenta - totalCotizado).toFixed(2));
    var varTotalMonto    = parseFloat((totalReal - totalCotizado).toFixed(2));
    var varTotalPct      = totalCotizado > 0
      ? parseFloat(((varTotalMonto / totalCotizado) * 100).toFixed(1)) : 0;

    var sheetST = ss.getSheetByName(SHEET_ST);
    if (sheetST && Math.abs(totalReal - (st.total_costo_real || 0)) > 0.01) {
      sheetST.getRange(rec.row, COL_ST.TOTAL_COSTO_REAL).setValue(totalReal);
    }

    // Buscar ingreso para obtener subtotal_venta y es_exento
    // El subtotal ya está calculado correctamente en ambos casos:
    //   gravado: total / 1.07  (precio sin ITBMS)
    //   exento:  total          (precio ya es neto, no se descuenta nada)
    var subtotalVenta = 0;
    var esExento      = false;
    if (st.ingreso_id) {
      try {
        var sheetIngRes = ss.getSheetByName(CONFIG.SHEET_INGRESOS);
        if (sheetIngRes && sheetIngRes.getLastRow() > 2) {
          var numIngRes = sheetIngRes.getLastRow() - 2;
          var ingResData = sheetIngRes.getRange(3, 1, numIngRes, INGRESOS_NCOLS).getValues();
          for (var ir = 0; ir < ingResData.length; ir++) {
            if (String(ingResData[ir][COL_I.ID_TRANS - 1]).trim() === String(st.ingreso_id).trim()) {
              subtotalVenta = parseFloat(ingResData[ir][COL_I.SUBTOTAL - 1]) || 0;
              var catIng    = String(ingResData[ir][COL_I.CATEGORIA - 1] || '');
              esExento      = catIng === 'venta_producto_exento' || catIng === 'servicio_tecnico_exento';
              break;
            }
          }
        }
      } catch(ingErr) {
        Logger.log('⚠️  getResumenST: error buscando ingreso: ' + ingErr.message);
      }
    }
    // Fallback: si no encontramos el ingreso, calcular desde precio_venta
    if (subtotalVenta === 0 && precioVenta > 0) {
      subtotalVenta = parseFloat((precioVenta / 1.07).toFixed(2));
    }

    result.success = true;
    result.resumen = {
      id_st: idST, estado: st.estado, num_cotizacion: st.num_cotizacion,
      nombre_cliente: st.nombre_cliente, descripcion: st.descripcion,
      precio_venta: precioVenta, total_cotizado: totalCotizado, total_real: totalReal,
      variacion_monto: varTotalMonto, variacion_pct: varTotalPct,
      utilidad_cotizada: utilidadCotizada, utilidad_real: utilidadReal,
      margen_cotizado: margenCotizado, margen_real: margenReal,
      semaforo_global: varTotalPct <= 0 ? 'verde' : (varTotalPct <= 10 ? 'amarillo' : 'rojo'),
      items: items, ingreso_id: st.ingreso_id,
      subtotal_venta: subtotalVenta,
      es_exento:      esExento,
    };

  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleGetResumenST v1.2: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback+'('+json+')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}


// ═══════════════════════════════════════════════════════════════
//  _handleCerrarST  (doGet)
// ═══════════════════════════════════════════════════════════════

function _handleCerrarST(params, callback) {
  var result = { success: false, resumen: null, error: null };
  try {
    var idST = params.id_st || '';
    if (!idST) throw new Error('id_st requerido');

    var ss  = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var rec = _getSTById(ss, idST);
    if (!rec) throw new Error('ST no encontrado: ' + idST);

    var estadoActual = String(rec.data[COL_ST.ESTADO - 1] || '');
    if (estadoActual !== 'en_ejecucion') {
      throw new Error('Solo se puede cerrar un ST en estado "en_ejecucion". Estado actual: ' + estadoActual);
    }

    var ingresoId = String(rec.data[COL_ST.INGRESO_ID - 1] || '').trim();
    if (!ingresoId) {
      throw new Error('No se puede cerrar el ST sin un ingreso registrado. Registra el ingreso primero.');
    }

    var fechaCierre = params.fecha_cierre ||
      Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd');

    // FIX #4: mes/anio reflejan la fecha real de cierre, no la de creación
    var fechaCierreDate = new Date(fechaCierre + 'T12:00:00');
    var mesCierre  = isNaN(fechaCierreDate.getTime()) ? new Date().getMonth() + 1 : fechaCierreDate.getMonth() + 1;
    var anioCierre = isNaN(fechaCierreDate.getTime()) ? new Date().getFullYear()  : fechaCierreDate.getFullYear();

    var sheetST = ss.getSheetByName(SHEET_ST);
    sheetST.getRange(rec.row, COL_ST.ESTADO).setValue('cerrado');
    sheetST.getRange(rec.row, COL_ST.FECHA_CIERRE).setValue(fechaCierre);
    sheetST.getRange(rec.row, COL_ST.MES).setValue(mesCierre);
    sheetST.getRange(rec.row, COL_ST.ANIO).setValue(anioCierre);
    sheetST.getRange(rec.row, 1, 1, ST_NCOLS).setBackground('#F1F8E9');

    var sheetSTI   = ss.getSheetByName(SHEET_ST_ITEM);
    var totalReal  = _calcSTTotalsReal(sheetSTI, idST);
    sheetST.getRange(rec.row, COL_ST.TOTAL_COSTO_REAL).setValue(totalReal);

    // FIX #1b: marcar el ingreso vinculado como 'confirmado' al cerrar el ST
    // Esto asegura que el P&L lo incluya sin depender del estado 'pendiente'
    var sheetIng = ss.getSheetByName(CONFIG.SHEET_INGRESOS);
    if (ingresoId && sheetIng && sheetIng.getLastRow() > 2) {
      var numIng  = sheetIng.getLastRow() - 2;
      var dataIng = sheetIng.getRange(3, 1, numIng, INGRESOS_NCOLS).getValues();
      for (var ni = 0; ni < dataIng.length; ni++) {
        if (String(dataIng[ni][COL_I.ID_TRANS - 1]) !== ingresoId) continue;
        var estadoIng = String(dataIng[ni][COL_I.ESTADO - 1] || '');
        if (estadoIng !== 'anulado') {
          sheetIng.getRange(ni + 3, COL_I.ESTADO).setValue('confirmado');
          Logger.log('✅ Ingreso confirmado al cerrar ST: ' + ingresoId);
        }
        break;
      }
    }

    Logger.log('✅ ST cerrado: ' + idST + ' | Costo real: $' + totalReal + ' | Mes cierre: ' + mesCierre + '/' + anioCierre);

    result.success = true;
    result.resumen = {
      id_st:          idST,
      fecha_cierre:   fechaCierre,
      ingreso_id:     ingresoId,
      total_real:     totalReal,
      total_cotizado: parseFloat(rec.data[COL_ST.TOTAL_COSTO_COT - 1] || '0') || 0,
      precio_venta:   parseFloat(rec.data[COL_ST.PRECIO_VENTA - 1]    || '0') || 0,
    };

  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleCerrarST: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}


// ═══════════════════════════════════════════════════════════════
//  _handleCancelarST  (doGet)  v2
//  — Cancelación contable limpia:
//    · cotizado/aprobado  → solo marca cancelado (no hay egresos/ingreso aún)
//    · en_ejecucion       → anula egresos activos (por ID exacto desde ST_Items)
//                           + anula ingreso si existe, marca items cancelado
//    · cerrado / cancelado → bloqueado
// ═══════════════════════════════════════════════════════════════

function _handleCancelarST(params, callback) {
  var result = {
    success:         false,
    id_st:           null,
    egresos_anulados: 0,
    ingreso_anulado: false,
    error:           null,
  };
  try {
    var idST   = String(params.id_st  || '').trim();
    var motivo = String(params.motivo || '').trim();
    if (!idST) throw new Error('id_st requerido');

    var ss  = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var rec = _getSTById(ss, idST);
    if (!rec) throw new Error('ST no encontrado: ' + idST);

    var estadoActual = String(rec.data[COL_ST.ESTADO - 1] || '');
    if (estadoActual === 'cerrado') {
      throw new Error('Este ST ya está cerrado y no puede cancelarse. Los registros contables son definitivos.');
    }
    if (estadoActual === 'cancelado') {
      throw new Error('Este ST ya está cancelado.');
    }

    var stamp = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm');

    // ── Si está en ejecución: limpiar contabilidad antes de cancelar ──────
    if (estadoActual === 'en_ejecucion') {

      // 1. Recolectar egreso_ids exactos desde ST_Items
      var egresoIdsSet = {};
      var sheetSTI = ss.getSheetByName(SHEET_ST_ITEM);
      if (sheetSTI && sheetSTI.getLastRow() > 2) {
        var numSTI  = sheetSTI.getLastRow() - 2;
        var dataSTI = sheetSTI.getRange(3, 1, numSTI, STI_NCOLS).getValues();
        for (var i = 0; i < dataSTI.length; i++) {
          if (String(dataSTI[i][COL_STI.ID_ST - 1]) !== idST) continue;
          var eid = String(dataSTI[i][COL_STI.EGRESO_ID - 1] || '').trim();
          if (eid) egresoIdsSet[eid] = true;
          // Marcar item como cancelado (preserva historial, no borra fila)
          sheetSTI.getRange(i + 3, COL_STI.ESTADO_ITEM).setValue('cancelado');
          sheetSTI.getRange(i + 3, COL_STI.NOTAS).setValue(
            String(dataSTI[i][COL_STI.NOTAS - 1] || '') +
            ' | CANCELADO ST: ' + stamp + (motivo ? ' — ' + motivo : '')
          );
        }
        SpreadsheetApp.flush();
      }

      // 2. Anular egresos por ID exacto
      var sheetEgr = ss.getSheetByName(SHEET_EGRESOS);
      if (sheetEgr && sheetEgr.getLastRow() > 2 && Object.keys(egresoIdsSet).length > 0) {
        var numEgr  = sheetEgr.getLastRow() - 2;
        var dataEgr = sheetEgr.getRange(3, 1, numEgr, EGRESOS_NCOLS).getValues();
        for (var e = 0; e < dataEgr.length; e++) {
          var egresoId = String(dataEgr[e][COL_E.ID - 1] || '').trim();
          if (!egresoId || !egresoIdsSet[egresoId]) continue;
          var estadoE = String(dataEgr[e][COL_E.ESTADO - 1] || '').toLowerCase();
          if (estadoE === 'anulado') continue;
          var rowEgr = e + 3;
          sheetEgr.getRange(rowEgr, COL_E.ESTADO).setValue('anulado');
          sheetEgr.getRange(rowEgr, 1, 1, EGRESOS_NCOLS).setBackground('#FFEBEE');
          var notaE = String(dataEgr[e][COL_E.NOTAS - 1] || '');
          sheetEgr.getRange(rowEgr, COL_E.NOTAS).setValue(
            notaE + ' | ANULADO — cancelación ST ' + idST + ': ' + stamp +
            (motivo ? ' — ' + motivo : '')
          );
          result.egresos_anulados++;
        }
        SpreadsheetApp.flush();
      }

      // 3. Anular ingreso si existe
      var ingresoId = String(rec.data[COL_ST.INGRESO_ID - 1] || '').trim();
      if (ingresoId) {
        var sheetIng = ss.getSheetByName(CONFIG.SHEET_INGRESOS);
        if (sheetIng && sheetIng.getLastRow() > 2) {
          var numIng  = sheetIng.getLastRow() - 2;
          var dataIng = sheetIng.getRange(3, 1, numIng, INGRESOS_NCOLS).getValues();
          for (var n = 0; n < dataIng.length; n++) {
            if (String(dataIng[n][COL_I.ID_TRANS - 1]) !== ingresoId) continue;
            var rowIng = n + 3;
            sheetIng.getRange(rowIng, COL_I.ESTADO).setValue('anulado');
            sheetIng.getRange(rowIng, 1, 1, INGRESOS_NCOLS).setBackground('#FFEBEE');
            var notaIng = String(dataIng[n][COL_I.NOTAS_INT - 1] || '');
            sheetIng.getRange(rowIng, COL_I.NOTAS_INT).setValue(
              notaIng + ' | ANULADO — cancelación ST ' + idST + ': ' + stamp +
              (motivo ? ' — ' + motivo : '')
            );
            result.ingreso_anulado = true;
            break;
          }
          SpreadsheetApp.flush();
        }
      }
    }

    // ── Marcar el ST como cancelado ───────────────────────────────────────
    var sheetST = ss.getSheetByName(SHEET_ST);
    sheetST.getRange(rec.row, COL_ST.ESTADO).setValue('cancelado');
    var notaAct = String(rec.data[COL_ST.NOTAS - 1] || '');
    sheetST.getRange(rec.row, COL_ST.NOTAS).setValue(
      notaAct + ' | CANCELADO: ' + stamp + (motivo ? ' — ' + motivo : '')
    );
    sheetST.getRange(rec.row, 1, 1, ST_NCOLS).setBackground('#FFEBEE');
    SpreadsheetApp.flush();

    result.success = true;
    result.id_st   = idST;
    Logger.log('✅ ST cancelado: ' + idST +
               ' | Egresos anulados: ' + result.egresos_anulados +
               ' | Ingreso anulado: '  + result.ingreso_anulado);

  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleCancelarST v2: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}


// ═══════════════════════════════════════════════════════════════
//  _handleEnviarCotizacionEmail  (doGet)
// ═══════════════════════════════════════════════════════════════

function _handleEnviarCotizacionEmail(params, callback) {
  var result = { success: false, error: null };
  try {
    var idST       = params.id_st        || '';
    var emailExtra = params.email_destino || '';
    if (!idST) throw new Error('id_st requerido');

    var ss  = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var rec = _getSTById(ss, idST);
    if (!rec) throw new Error('ST no encontrado: ' + idST);

    var st = _serializeST(rec.data);

    var sheetSTI = ss.getSheetByName(SHEET_ST_ITEM);
    var items    = [];
    if (sheetSTI && sheetSTI.getLastRow() > 2) {
      var numRows  = sheetSTI.getLastRow() - 2;
      var itemData = sheetSTI.getRange(3, 1, numRows, STI_NCOLS).getValues();
      for (var i = 0; i < itemData.length; i++) {
        if (String(itemData[i][COL_STI.ID_ST - 1]) !== String(idST)) continue;
        if (String(itemData[i][COL_STI.ESTADO_ITEM - 1]) === 'cancelado') continue;
        items.push(_serializeSTItem(itemData[i]));
      }
    }

    var emailDestino = emailExtra || st.email_cliente || CONFIG.ADMIN_EMAIL;
    var html = _generarHtmlCotizacion(st, items);

    MailApp.sendEmail({
      to:       emailDestino,
      cc:       CONFIG.ADMIN_EMAIL,
      subject:  '📋 Cotización ' + st.num_cotizacion + ' — ' + CONFIG.NEGOCIO,
      htmlBody: html,
    });

    var stamp   = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm');
    var sheetST = ss.getSheetByName(SHEET_ST);
    var notaAct = String(rec.data[COL_ST.NOTAS - 1] || '');
    sheetST.getRange(rec.row, COL_ST.NOTAS).setValue(
      notaAct + ' | Email enviado a: ' + emailDestino + ' — ' + stamp
    );

    result.success       = true;
    result.email_destino = emailDestino;
    Logger.log('✅ Cotización enviada: ' + st.num_cotizacion + ' → ' + emailDestino);
  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleEnviarCotizacionEmail: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// ── Generar HTML formal de cotización ────────────────────────

function _generarHtmlCotizacion(st, items) {
  var fecha = Utilities.formatDate(new Date(), 'America/Panama', 'dd/MM/yyyy');

  var tipoLabel = {
    'producto':    '📦 Producto',
    'mano_obra':   '🔧 Mano de obra',
    'flete':       '🚛 Flete / transporte',
    'impuesto':    '🏛️ Impuesto / tasa',
    'combustible': '⛽ Combustible',
    'fianza':      '🔒 Fianza',
    'subcontrato': '🤝 Subcontrato',
    'otro':        '📌 Otro',
  };

  var rowsHtml = '';
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var bg   = i % 2 === 0 ? '#F5F5F7' : '#FFFFFF';
    var cantLabel = item.precio_unitario > 0
      ? item.cantidad + ' × $' + item.precio_unitario.toFixed(2)
      : '—';
    var itbmsLabel = item.aplica_itbms
      ? '<span style="font-size:11px;color:#E65100">+ITBMS</span>'
      : '';
    rowsHtml +=
      '<tr style="background:' + bg + '">' +
        '<td style="padding:10px 14px;font-size:13px">' +
          '<strong>' + _htmlEscape(item.descripcion) + '</strong><br>' +
          '<span style="font-size:11px;color:#6C6C70">' + (tipoLabel[item.tipo] || item.tipo) + '</span>' +
        '</td>' +
        '<td style="padding:10px 14px;font-size:13px;text-align:center">' + _htmlEscape(cantLabel) + '</td>' +
        '<td style="padding:10px 14px;font-size:13px;text-align:right">' +
          '$' + item.monto_cotizado.toFixed(2) + ' ' + itbmsLabel +
        '</td>' +
        '<td style="padding:10px 14px;font-size:13px;text-align:right;font-weight:600">' +
          '$' + item.total_cotizado.toFixed(2) +
        '</td>' +
      '</tr>';
  }

  var subtotalSinITBMS = 0;
  var totalITBMS       = 0;
  for (var j = 0; j < items.length; j++) {
    subtotalSinITBMS += items[j].monto_cotizado;
    totalITBMS       += items[j].itbms_cotizado;
  }
  subtotalSinITBMS = parseFloat(subtotalSinITBMS.toFixed(2));
  totalITBMS       = parseFloat(totalITBMS.toFixed(2));
  var totalCosto   = parseFloat((subtotalSinITBMS + totalITBMS).toFixed(2));
  var precioVenta  = st.precio_venta > 0 ? st.precio_venta : totalCosto;
  var margenPct    = st.margen_pct > 0 ? st.margen_pct : 0;

  var validezBloque =
    '<div style="background:#E8F5E9;border:1px solid #A5D6A7;border-radius:8px;padding:12px 16px;margin-top:16px;font-size:13px">' +
      '✅ Esta cotización tiene una validez de <strong>30 días</strong> a partir de la fecha de emisión.' +
    '</div>';

  var html =
    '<div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto">' +
      '<div style="background:#1A237E;padding:28px 32px;border-radius:12px 12px 0 0">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start">' +
          '<div>' +
            '<div style="font-size:28px;color:#FFF;font-weight:700;letter-spacing:2px">RAMON.PICO</div>' +
            '<div style="color:rgba(255,255,255,0.7);font-size:12px;margin-top:4px">Equipos Industriales · Círculo Financiero S.A.</div>' +
          '</div>' +
          '<div style="text-align:right">' +
            '<div style="background:rgba(255,255,255,0.15);border-radius:8px;padding:8px 16px">' +
              '<div style="font-size:11px;color:rgba(255,255,255,0.7);text-transform:uppercase;letter-spacing:1px">Cotización</div>' +
              '<div style="font-size:20px;color:#FFF;font-weight:700">' + _htmlEscape(st.num_cotizacion) + '</div>' +
              '<div style="font-size:11px;color:rgba(255,255,255,0.7)">' + fecha + '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div style="background:#FFF;border:1px solid #E5E5E7;border-top:none;padding:32px;border-radius:0 0 12px 12px">' +
        '<div style="display:flex;gap:24px;margin-bottom:28px;padding-bottom:24px;border-bottom:1px solid #E5E5E7">' +
          '<div style="flex:1">' +
            '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#6C6C70;margin-bottom:8px;font-weight:600">CLIENTE</div>' +
            '<div style="font-size:16px;font-weight:700">' + _htmlEscape(st.nombre_cliente) + '</div>' +
            (st.ruc_cliente ? '<div style="font-size:13px;color:#6C6C70">RUC: ' + _htmlEscape(st.ruc_cliente) + (st.dv_cliente ? ' DV: ' + st.dv_cliente : '') + '</div>' : '') +
            (st.contacto    ? '<div style="font-size:13px;color:#6C6C70">Tel: ' + _htmlEscape(st.contacto) + '</div>' : '') +
          '</div>' +
          '<div style="flex:1">' +
            '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#6C6C70;margin-bottom:8px;font-weight:600">SERVICIO</div>' +
            '<div style="font-size:14px;font-weight:600;line-height:1.5">' + _htmlEscape(st.descripcion) + '</div>' +
          '</div>' +
        '</div>' +
        '<table style="width:100%;border-collapse:collapse;margin-bottom:20px">' +
          '<tr style="background:#1A237E;color:#FFF">' +
            '<th style="padding:10px 14px;text-align:left;font-size:12px;font-weight:600">DESCRIPCIÓN</th>' +
            '<th style="padding:10px 14px;text-align:center;font-size:12px;font-weight:600">CANTIDAD</th>' +
            '<th style="padding:10px 14px;text-align:right;font-size:12px;font-weight:600">COSTO</th>' +
            '<th style="padding:10px 14px;text-align:right;font-size:12px;font-weight:600">TOTAL</th>' +
          '</tr>' +
          rowsHtml +
        '</table>' +
        '<div style="margin-left:auto;width:280px">' +
          (totalITBMS > 0 ?
            '<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;color:#6C6C70">' +
              '<span>Subtotal</span><span>$' + subtotalSinITBMS.toFixed(2) + '</span>' +
            '</div>' +
            '<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;color:#6C6C70">' +
              '<span>ITBMS (7%)</span><span>$' + totalITBMS.toFixed(2) + '</span>' +
            '</div>'
          : '') +
          '<div style="display:flex;justify-content:space-between;padding:10px 0;border-top:2px solid #1A237E;font-size:18px;font-weight:700;margin-top:4px">' +
            '<span>PRECIO DE VENTA</span><span style="color:#1A237E">$' + precioVenta.toFixed(2) + '</span>' +
          '</div>' +
          (margenPct > 0 ?
            '<div style="font-size:11px;color:#6C6C70;text-align:right">Margen incluido: ' + margenPct.toFixed(1) + '%</div>'
          : '') +
        '</div>' +
        validezBloque +
        (st.notas ?
          '<div style="background:#F5F5F7;border-radius:8px;padding:14px 16px;margin-top:16px;font-size:13px;color:#6C6C70">' +
            '<strong>Notas:</strong> ' + _htmlEscape(st.notas) +
          '</div>'
        : '') +
        '<div style="margin-top:28px;padding-top:20px;border-top:1px solid #E5E5E7;text-align:center">' +
          '<a href="https://wa.me/' + CONFIG.WA_NUM + '" style="display:inline-block;background:#25D366;color:#FFF;padding:10px 22px;border-radius:8px;font-weight:600;text-decoration:none;font-size:14px">📲 Contactar por WhatsApp</a>' +
          '<div style="margin-top:12px;font-size:11px;color:#6C6C70">' + CONFIG.NEGOCIO + ' · RUC 1753684-1-696883</div>' +
        '</div>' +
      '</div>' +
    '</div>';

  return html;
}

function _htmlEscape(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


// ═══════════════════════════════════════════════════════════════
//  _handleEliminarST  v3  — FIX: usa solo IDs exactos desde ST_Items
//  — Solo permite eliminar STs en estado: cotizado | aprobado | cancelado
//  — Para en_ejecucion o cerrado: usar cancelarST primero
//  — NO usa indexOf en notas para buscar egresos (era la fuente del bug
//    de contaminación cruzada entre STs con IDs similares)
// ═══════════════════════════════════════════════════════════════

function _handleEliminarST(params, callback) {
  var result = {
    success:          false,
    id_st:            null,
    items_eliminados: 0,
    egresos_anulados: 0,
    ingreso_anulado:  false,
    error:            null,
  };
  try {
    var idST = String(params.id_st || '').trim();
    if (!idST) throw new Error('id_st requerido');

    var ss  = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var rec = _getSTById(ss, idST);
    if (!rec) throw new Error('ST no encontrado: ' + idST);

    // ── Guard de estado: solo permite eliminar estados sin impacto contable firme ──
    var estadoActual = String(rec.data[COL_ST.ESTADO - 1] || '');
    var estadosPermitidos = ['cotizado', 'aprobado', 'cancelado'];
    if (estadosPermitidos.indexOf(estadoActual) === -1) {
      throw new Error(
        'No se puede eliminar un ST en estado "' + estadoActual + '". ' +
        'Solo se permiten eliminar STs cotizados, aprobados o cancelados. ' +
        'Para STs en ejecución, primero cancélalo desde el mismo botón.'
      );
    }

    var ingresoId = String(rec.data[COL_ST.INGRESO_ID - 1] || '').trim();
    var stamp     = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm');

    // ── 1. Recolectar egreso_ids EXACTOS desde ST_Items (único criterio confiable) ──
    var egresoIdsDeItems = {};   // { egresoId: true }
    var egresoIdStItemCol = {};  // { egresoId: true } — respaldo por col 21
    var sheetSTI = ss.getSheetByName(SHEET_ST_ITEM);
    var rowsSTI  = [];

    if (sheetSTI && sheetSTI.getLastRow() > 2) {
      var numSTI  = sheetSTI.getLastRow() - 2;
      var dataSTI = sheetSTI.getRange(3, 1, numSTI, STI_NCOLS).getValues();
      for (var i = 0; i < dataSTI.length; i++) {
        if (String(dataSTI[i][COL_STI.ID_ST - 1]) !== idST) continue;
        rowsSTI.push(i + 3);
        var eid = String(dataSTI[i][COL_STI.EGRESO_ID - 1] || '').trim();
        if (eid) egresoIdsDeItems[eid] = true;
      }
    }

    // ── 2. Anular egresos por ID exacto ÚNICAMENTE ────────────────────────
    var sheetEgr  = ss.getSheetByName(SHEET_EGRESOS);
    var egresosAn = 0;
    var colsRead  = Math.max(EGRESOS_NCOLS, 21);

    if (sheetEgr && sheetEgr.getLastRow() > 2 && Object.keys(egresoIdsDeItems).length > 0) {
      var numEgr  = sheetEgr.getLastRow() - 2;
      var dataEgr = sheetEgr.getRange(3, 1, numEgr, colsRead).getValues();

      for (var e = 0; e < dataEgr.length; e++) {
        var egresoId = String(dataEgr[e][COL_E.ID - 1] || '').trim();
        if (!egresoId) continue;

        var estadoE = String(dataEgr[e][COL_E.ESTADO - 1] || '').toLowerCase();
        if (estadoE === 'anulado') continue;

        // ⚠️  SOLO criterios basados en IDs exactos — NUNCA indexOf en notas
        var idStItemCol = (colsRead >= 21) ? String(dataEgr[e][20] || '').trim() : '';
        var pertenece   = egresoIdsDeItems[egresoId]
                       || idStItemCol === idST;

        if (!pertenece) continue;

        var rowEgr = e + 3;
        sheetEgr.getRange(rowEgr, COL_E.ESTADO).setValue('anulado');
        sheetEgr.getRange(rowEgr, 1, 1, EGRESOS_NCOLS).setBackground('#FFEBEE');
        var notaActual = String(dataEgr[e][COL_E.NOTAS - 1] || '');
        sheetEgr.getRange(rowEgr, COL_E.NOTAS).setValue(
          notaActual + ' | ANULADO — eliminación ST ' + idST + ': ' + stamp
        );
        egresosAn++;
      }
      SpreadsheetApp.flush();
    }

    // ── 3. Anular ingreso por ID exacto ───────────────────────────────────
    var ingresoAnulado = false;
    if (ingresoId) {
      var sheetIng = ss.getSheetByName(CONFIG.SHEET_INGRESOS);
      if (sheetIng && sheetIng.getLastRow() > 2) {
        var numIng  = sheetIng.getLastRow() - 2;
        var dataIng = sheetIng.getRange(3, 1, numIng, INGRESOS_NCOLS).getValues();
        for (var n = 0; n < dataIng.length; n++) {
          if (String(dataIng[n][COL_I.ID_TRANS - 1]) !== ingresoId) continue;
          var rowIng = n + 3;
          sheetIng.getRange(rowIng, COL_I.ESTADO).setValue('anulado');
          sheetIng.getRange(rowIng, 1, 1, INGRESOS_NCOLS).setBackground('#FFEBEE');
          var notaIng = String(dataIng[n][COL_I.NOTAS_INT - 1] || '');
          sheetIng.getRange(rowIng, COL_I.NOTAS_INT).setValue(
            notaIng + ' | ANULADO — eliminación ST ' + idST + ': ' + stamp
          );
          ingresoAnulado = true;
          break;
        }
        SpreadsheetApp.flush();
      }
    }

    // ── 4. Borrar filas ST_Items (descendente para no desplazar índices) ──
    if (sheetSTI && rowsSTI.length > 0) {
      rowsSTI.sort(function(a, b) { return b - a; });
      rowsSTI.forEach(function(rowNum) { sheetSTI.deleteRow(rowNum); });
      SpreadsheetApp.flush();
    }

    // ── 5. Borrar fila del ST ─────────────────────────────────────────────
    var sheetST = ss.getSheetByName(SHEET_ST);
    if (sheetST) {
      sheetST.deleteRow(rec.row);
      SpreadsheetApp.flush();
    }

    result.success          = true;
    result.id_st            = idST;
    result.items_eliminados = rowsSTI.length;
    result.egresos_anulados = egresosAn;
    result.ingreso_anulado  = ingresoAnulado;

    Logger.log('✅ ST eliminado: ' + idST +
               ' | Items borrados: '   + rowsSTI.length +
               ' | Egresos anulados: ' + egresosAn +
               ' | Ingreso anulado: '  + ingresoAnulado);

  } catch(err) {
    result.error = err.message;
    Logger.log('❌ _handleEliminarST v3: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}
