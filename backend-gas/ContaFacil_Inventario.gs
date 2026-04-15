// ═══════════════════════════════════════════════════════════════
//  ContaFacil_Inventario.gs  — v2
//  Módulo: Gestión de Inventario BalanceClip
//  Archivo NUEVO — no modifica ningún archivo existente.
//
//  CORRECCIÓN v2: usa ContentService inline (igual que el resto
//  de handlers de Code__3_.js) — no depende de _jsonp.
//
//  Hojas requeridas en el Sheet:
//    Inventario_Maestro      (2,196 SKUs al 2026-03-29)
//    Inventario_Movimientos  (20 movimientos historial dic-2025)
//
//  Las 4 acciones ya están en el doGet de Code__3_.js:
//    if (action === 'getInventario')       return _handleGetInventario(params, callback);
//    if (action === 'getMovimientosInv')   return _handleGetMovimientosInv(params, callback);
//    if (action === 'registrarEntradaInv') return _handleRegistrarEntradaInv(params, callback);
//    if (action === 'ajustarInventario')   return _handleAjustarInventario(params, callback);
// ═══════════════════════════════════════════════════════════════

var SHEET_INV_MAESTRO = 'Inventario_Maestro';
var SHEET_INV_MOV     = 'Inventario_Movimientos';

// ── Columnas Inventario_Maestro (base 1) ──────────────────────
var COL_IM = {
  CODIGO:        1,   // A
  DESCRIPCION:   2,   // B
  MARCA:         3,   // C
  CATEGORIA:     4,   // D
  UNIDAD:        5,   // E
  UBICACION:     6,   // F
  COSTO_REF:     7,   // G
  EXIST_INICIAL: 8,   // H
  VALOR_INICIAL: 9,   // I  fórmula =H*G
  EXIST_ACTUAL:  10,  // J  fórmula SUMIFS
  VALOR_ACTUAL:  11,  // K  fórmula =J*G
  ACTIVO:        12,  // L
  NOTAS:         13,  // M
};
var INV_MAESTRO_NCOLS    = 13;
var INV_MAESTRO_DATA_ROW = 3;  // filas 1-2 = cabeceras dobles

// ── Columnas Inventario_Movimientos (base 1) ──────────────────
var COL_MV = {
  ID:          1,   // A
  FECHA:       2,   // B
  TIPO:        3,   // C
  CODIGO_SKU:  4,   // D
  DESC_SKU:    5,   // E
  CANTIDAD:    6,   // F
  COSTO_UNIT:  7,   // G
  COSTO_TOTAL: 8,   // H
  ORIGEN:      9,   // I
  NUM_FACTURA: 10,  // J
  ID_ST:       11,  // K
  CLI_PROV:    12,  // L
  DRIVE_URL:   13,  // M
  NOTAS:       14,  // N
};
var INV_MOV_NCOLS    = 14;
var INV_MOV_DATA_ROW = 3;  // filas 1-2 = cabeceras dobles

var INV_ORIGEN = {
  VENTA:     'venta',
  COMPRA:    'compra',
  AJUSTE:    'ajuste',
  HISTORIAL: 'importacion_historial',
};


// ═══════════════════════════════════════════════════════════════
//  _invResp  — helper local de respuesta JSONP/JSON
//  Mismo patrón que el resto de handlers de Code__3_.js,
//  pero encapsulado aquí para no depender de ningún helper global.
// ═══════════════════════════════════════════════════════════════

function _invResp(obj, callback) {
  var json = JSON.stringify(obj);
  if (callback) {
    return ContentService
      .createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}


// ═══════════════════════════════════════════════════════════════
//  _buscarEnInventarioMaestro
//  Busca un SKU por código. Exacto primero, luego sin espacios.
//  Retorna { codigo, descripcion, marca, categoria, unidad,
//             ubicacion, costo, _row } o null.
// ═══════════════════════════════════════════════════════════════

function _buscarEnInventarioMaestro(ss, codigo) {
  var sheet = ss.getSheetByName(SHEET_INV_MAESTRO);
  if (!sheet) { Logger.log('⚠️ "' + SHEET_INV_MAESTRO + '" no encontrada'); return null; }

  var lastRow = sheet.getLastRow();
  if (lastRow < INV_MAESTRO_DATA_ROW) return null;

  var numRows = lastRow - INV_MAESTRO_DATA_ROW + 1;
  // Leer A–J (10 cols) para incluir exist_actual (col J) — necesario para validar
  // stock antes de decrementar desde ImportHistorial. El costo extra vs A–G es
  // mínimo porque SUMIFS en col J ya está calculado por Sheets antes de getValues().
  var data   = sheet.getRange(INV_MAESTRO_DATA_ROW, 1, numRows, COL_IM.EXIST_ACTUAL).getValues();
  var buscar = String(codigo || '').trim().toUpperCase();

  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0] || '').trim().toUpperCase() === buscar) {
      return {
        codigo:       String(data[i][0] || ''),
        descripcion:  String(data[i][1] || ''),
        marca:        String(data[i][2] || ''),
        categoria:    String(data[i][3] || ''),
        unidad:       String(data[i][4] || 'PZA'),
        ubicacion:    String(data[i][5] || ''),
        costo:        parseFloat(data[i][6] || '0') || 0,
        exist_actual: parseFloat(data[i][9] || '0') || 0,  // col J (index 9)
        _row:         INV_MAESTRO_DATA_ROW + i,
      };
    }
  }
  // Fallback: comparación sin espacios
  var buscarNorm = buscar.replace(/\s+/g, '');
  for (var j = 0; j < data.length; j++) {
    if (String(data[j][0] || '').trim().toUpperCase().replace(/\s+/g, '') === buscarNorm) {
      Logger.log('  ℹ️ Código con variación de espacios: "' + data[j][0] + '" ≈ "' + codigo + '"');
      return {
        codigo:       String(data[j][0] || ''),
        descripcion:  String(data[j][1] || ''),
        marca:        String(data[j][2] || ''),
        categoria:    String(data[j][3] || ''),
        unidad:       String(data[j][4] || 'PZA'),
        ubicacion:    String(data[j][5] || ''),
        costo:        parseFloat(data[j][6] || '0') || 0,
        exist_actual: parseFloat(data[j][9] || '0') || 0,  // col J (index 9)
        _row:         INV_MAESTRO_DATA_ROW + j,
      };
    }
  }
  return null;
}


// ═══════════════════════════════════════════════════════════════
//  _registrarMovimientoInventario
//  Punto único de escritura en Inventario_Movimientos.
//  La exist_actual del Maestro se recalcula automáticamente
//  vía fórmulas SUMIFS en columna J.
// ═══════════════════════════════════════════════════════════════

function _registrarMovimientoInventario(ss, tipo, codigo, cantidad, origen,
                                         numFactura, idST, clienteProv,
                                         costoUnit, driveUrl, fecha, notas) {
  try {
    var sheet = ss.getSheetByName(SHEET_INV_MOV);
    if (!sheet) { Logger.log('⚠️ "' + SHEET_INV_MOV + '" no encontrada'); return null; }
    if (!codigo || !cantidad || cantidad <= 0) {
      Logger.log('⚠️ _registrarMovimientoInventario: código o cantidad inválidos');
      return null;
    }

    var ahora    = new Date();
    var fechaMov = fecha || Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd');
    var anio     = new Date(fechaMov + 'T12:00:00').getFullYear() || ahora.getFullYear();

    // Correlativo anual
    var seq     = 1;
    var lastRow = sheet.getLastRow();
    if (lastRow >= INV_MOV_DATA_ROW) {
      var ids = sheet.getRange(INV_MOV_DATA_ROW, COL_MV.ID,
                               lastRow - INV_MOV_DATA_ROW + 1, 1).getValues();
      for (var k = ids.length - 1; k >= 0; k--) {
        var parts = String(ids[k][0] || '').split('-');
        var n     = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(n)) { seq = n + 1; break; }
      }
    }
    var idMov = 'MOV-CEYCO-' + anio + '-' + String(seq).padStart(4, '0');

    // Descripción del SKU via lookup
    var descSku = '';
    var itemInv = _buscarEnInventarioMaestro(ss, codigo);
    if (itemInv) descSku = itemInv.descripcion;

    var costoU = parseFloat(costoUnit) || 0;
    var cant   = parseFloat(cantidad)  || 0;
    var costoT = parseFloat((costoU * cant).toFixed(4));

    // Inicializar fila con vacíos
    var fila = new Array(INV_MOV_NCOLS);
    for (var x = 0; x < INV_MOV_NCOLS; x++) fila[x] = '';

    fila[COL_MV.ID          - 1] = idMov;
    fila[COL_MV.FECHA       - 1] = fechaMov;
    fila[COL_MV.TIPO        - 1] = tipo;
    fila[COL_MV.CODIGO_SKU  - 1] = codigo;
    fila[COL_MV.DESC_SKU    - 1] = descSku;
    fila[COL_MV.CANTIDAD    - 1] = cant;
    fila[COL_MV.COSTO_UNIT  - 1] = costoU || '';
    fila[COL_MV.COSTO_TOTAL - 1] = costoT || '';
    fila[COL_MV.ORIGEN      - 1] = origen      || INV_ORIGEN.VENTA;
    fila[COL_MV.NUM_FACTURA - 1] = numFactura  || '';
    fila[COL_MV.ID_ST       - 1] = idST        || '';
    fila[COL_MV.CLI_PROV    - 1] = clienteProv || '';
    fila[COL_MV.DRIVE_URL   - 1] = driveUrl    || '';
    fila[COL_MV.NOTAS       - 1] = notas       || '';

    var newRow = sheet.getLastRow() + 1;
    sheet.getRange(newRow, 1, 1, INV_MOV_NCOLS).setValues([fila]);
    sheet.getRange(newRow, COL_MV.COSTO_UNIT, 1, 2).setNumberFormat('#,##0.0000');
    sheet.getRange(newRow, 1, 1, INV_MOV_NCOLS)
      .setBackground(tipo === 'salida' ? '#FFF3E0' : '#E8F5E9');

    Logger.log('  📦 ' + idMov + ' | ' + tipo + ' | ' + codigo + ' ×' + cant);
    return idMov;

  } catch(err) {
    Logger.log('  ❌ Error _registrarMovimientoInventario: ' + err.message);
    return null;
  }
}


// ═══════════════════════════════════════════════════════════════
//  _handleGetInventario  (doGet action='getInventario')
// ═══════════════════════════════════════════════════════════════

function _handleGetInventario(params, callback) {
  var result = { success: false, items: [], total_skus: 0, error: null };
  try {
    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_INV_MAESTRO);

    if (!sheet || sheet.getLastRow() < INV_MAESTRO_DATA_ROW) {
      result.success = true;
      var json0 = JSON.stringify(result);
      if (callback) return ContentService.createTextOutput(callback + '(' + json0 + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
      return ContentService.createTextOutput(json0).setMimeType(ContentService.MimeType.JSON);
    }

    var lastRow = sheet.getLastRow();
    var numRows = lastRow - INV_MAESTRO_DATA_ROW + 1;
    var data    = sheet.getRange(INV_MAESTRO_DATA_ROW, 1, numRows, INV_MAESTRO_NCOLS).getValues();

    var filtCodigo    = String(params.codigo    || '').trim().toUpperCase();
    var filtCategoria = String(params.categoria || '').trim().toLowerCase();
    var filtConStock  = params.con_stock === 'true';

    var items = [];
    for (var i = 0; i < data.length; i++) {
      var r      = data[i];
      var codigo = String(r[COL_IM.CODIGO - 1] || '').trim();
      if (!codigo) continue;

      var activo = r[COL_IM.ACTIVO - 1];
      if (activo === false || activo === 'FALSE' || activo === 0) continue;

      var existActual = parseFloat(r[COL_IM.EXIST_ACTUAL - 1]) || 0;

      if (filtCodigo    && codigo.toUpperCase() !== filtCodigo) continue;
      if (filtCategoria && String(r[COL_IM.CATEGORIA - 1] || '').toLowerCase().indexOf(filtCategoria) === -1) continue;
      if (filtConStock  && existActual <= 0) continue;

      items.push({
        codigo:        codigo,
        descripcion:   String(r[COL_IM.DESCRIPCION   - 1] || ''),
        marca:         String(r[COL_IM.MARCA         - 1] || ''),
        categoria:     String(r[COL_IM.CATEGORIA     - 1] || ''),
        unidad:        String(r[COL_IM.UNIDAD        - 1] || 'PZA'),
        ubicacion:     String(r[COL_IM.UBICACION     - 1] || ''),
        costo_ref:     parseFloat(r[COL_IM.COSTO_REF     - 1]) || 0,
        exist_inicial: parseFloat(r[COL_IM.EXIST_INICIAL - 1]) || 0,
        valor_inicial: parseFloat(r[COL_IM.VALOR_INICIAL - 1]) || 0,
        exist_actual:  existActual,
        valor_actual:  parseFloat(r[COL_IM.VALOR_ACTUAL  - 1]) || 0,
        _row:          INV_MAESTRO_DATA_ROW + i,
      });
    }

    result.success    = true;
    result.items      = items;
    result.total_skus = items.length;

  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleGetInventario: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}


// ═══════════════════════════════════════════════════════════════
//  _handleGetMovimientosInv  (doGet action='getMovimientosInv')
// ═══════════════════════════════════════════════════════════════

function _handleGetMovimientosInv(params, callback) {
  var result = { success: false, items: [], error: null };
  try {
    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_INV_MOV);

    if (!sheet || sheet.getLastRow() < INV_MOV_DATA_ROW) {
      result.success = true;
      var json0 = JSON.stringify(result);
      if (callback) return ContentService.createTextOutput(callback + '(' + json0 + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
      return ContentService.createTextOutput(json0).setMimeType(ContentService.MimeType.JSON);
    }

    var lastRow = sheet.getLastRow();
    var numRows = lastRow - INV_MOV_DATA_ROW + 1;
    var data    = sheet.getRange(INV_MOV_DATA_ROW, 1, numRows, INV_MOV_NCOLS).getValues();

    var filtCodigo = String(params.codigo || '').trim().toUpperCase();
    var filtTipo   = String(params.tipo   || '').trim();
    var filtIdST   = String(params.id_st  || '').trim();

    var items = [];
    for (var i = 0; i < data.length; i++) {
      var r = data[i];
      if (!String(r[COL_MV.ID - 1] || '')) continue;

      if (filtCodigo && String(r[COL_MV.CODIGO_SKU - 1] || '').toUpperCase() !== filtCodigo) continue;
      if (filtTipo   && String(r[COL_MV.TIPO       - 1] || '') !== filtTipo)                 continue;
      if (filtIdST   && String(r[COL_MV.ID_ST      - 1] || '') !== filtIdST)                 continue;

      var fecha = r[COL_MV.FECHA - 1];
      if (fecha instanceof Date) {
        fecha = Utilities.formatDate(fecha, 'America/Panama', 'yyyy-MM-dd');
      } else {
        fecha = String(fecha || '').slice(0, 10);
      }

      items.push({
        id_movimiento:     String(r[COL_MV.ID          - 1] || ''),
        fecha:             fecha,
        tipo:              String(r[COL_MV.TIPO         - 1] || ''),
        codigo_sku:        String(r[COL_MV.CODIGO_SKU   - 1] || ''),
        descripcion_sku:   String(r[COL_MV.DESC_SKU     - 1] || ''),
        cantidad:          parseFloat(r[COL_MV.CANTIDAD    - 1]) || 0,
        costo_unitario:    parseFloat(r[COL_MV.COSTO_UNIT  - 1]) || 0,
        costo_total:       parseFloat(r[COL_MV.COSTO_TOTAL - 1]) || 0,
        origen:            String(r[COL_MV.ORIGEN       - 1] || ''),
        num_factura:       String(r[COL_MV.NUM_FACTURA  - 1] || ''),
        id_st:             String(r[COL_MV.ID_ST        - 1] || ''),
        cliente_proveedor: String(r[COL_MV.CLI_PROV     - 1] || ''),
        drive_url:         String(r[COL_MV.DRIVE_URL    - 1] || ''),
        notas:             String(r[COL_MV.NOTAS        - 1] || ''),
      });
    }

    items.sort(function(a, b) { return String(b.fecha).localeCompare(String(a.fecha)); });
    result.success = true;
    result.items   = items;

  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleGetMovimientosInv: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}


// ═══════════════════════════════════════════════════════════════
//  _handleRegistrarEntradaInv  (doGet action='registrarEntradaInv')
// ═══════════════════════════════════════════════════════════════

function _handleRegistrarEntradaInv(params, callback) {
  var result = { success: false, id_mov: null, error: null };
  try {
    var codigo   = String(params.codigo    || '').trim();
    var cantidad = parseFloat(params.cantidad   || '0') || 0;
    var costoU   = parseFloat(params.costo_unit || '0') || 0;

    if (!codigo)   throw new Error('Parámetro "codigo" requerido');
    if (!cantidad) throw new Error('Parámetro "cantidad" requerido y mayor a 0');

    var ss      = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var itemInv = _buscarEnInventarioMaestro(ss, codigo);
    if (!itemInv) throw new Error('Código "' + codigo + '" no encontrado en Inventario_Maestro');

    var idMov = _registrarMovimientoInventario(
      ss, 'entrada', codigo, cantidad, INV_ORIGEN.COMPRA,
      params.num_factura || '', params.id_st    || '',
      params.proveedor   || '', costoU > 0 ? costoU : itemInv.costo,
      params.drive_url   || '', params.fecha    || '',
      params.notas       || ''
    );

    if (!idMov) throw new Error('No se pudo crear el movimiento de entrada');
    result.success = true;
    result.id_mov  = idMov;

  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleRegistrarEntradaInv: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}


// ═══════════════════════════════════════════════════════════════
//  _handleAjustarInventario  (doGet action='ajustarInventario')
// ═══════════════════════════════════════════════════════════════

function _handleAjustarInventario(params, callback) {
  var result = { success: false, id_mov: null, error: null };
  try {
    var codigo   = String(params.codigo   || '').trim();
    var cantidad = parseFloat(params.cantidad || '0') || 0;
    var tipo     = params.tipo === 'salida' ? 'salida' : 'entrada';

    if (!codigo)   throw new Error('Parámetro "codigo" requerido');
    if (!cantidad) throw new Error('Parámetro "cantidad" requerido y mayor a 0');

    var ss      = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var itemInv = _buscarEnInventarioMaestro(ss, codigo);
    if (!itemInv) throw new Error('Código "' + codigo + '" no encontrado en Inventario_Maestro');

    var fechaHoy = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd');
    var refNum   = 'AJUSTE-' + Utilities.formatDate(new Date(), 'America/Panama', 'yyyyMMdd');

    var idMov = _registrarMovimientoInventario(
      ss, tipo, codigo, cantidad, INV_ORIGEN.AJUSTE,
      refNum, '', 'Ajuste manual', itemInv.costo,
      '', fechaHoy, params.motivo || 'Ajuste de inventario'
    );

    if (!idMov) throw new Error('No se pudo crear el movimiento de ajuste');
    result.success = true;
    result.id_mov  = idMov;

  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleAjustarInventario: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}


// ═══════════════════════════════════════════════════════════════
//  verificarHojasInventario
//  Ejecutar desde el editor GAS para diagnóstico.
//  Solo lectura — no escribe nada.
// ═══════════════════════════════════════════════════════════════

function verificarHojasInventario() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  Logger.log('══════ VERIFICACIÓN INVENTARIO CEYCO ══════');

  var maestro = ss.getSheetByName(SHEET_INV_MAESTRO);
  var mov     = ss.getSheetByName(SHEET_INV_MOV);

  if (maestro) {
    var skus = Math.max(0, maestro.getLastRow() - 2);
    Logger.log('✅ Inventario_Maestro — ' + skus + ' SKUs');
    if (skus > 0) {
      Logger.log('   J3: ' + (maestro.getRange(3, COL_IM.EXIST_ACTUAL).getFormula() || '❌ VACÍA'));
      Logger.log('   K3: ' + (maestro.getRange(3, COL_IM.VALOR_ACTUAL).getFormula()  || '❌ VACÍA'));
    }
  } else {
    Logger.log('❌ Inventario_Maestro — NO ENCONTRADA');
  }

  if (mov) {
    Logger.log('✅ Inventario_Movimientos — ' + Math.max(0, mov.getLastRow() - 2) + ' movimientos');
  } else {
    Logger.log('❌ Inventario_Movimientos — NO ENCONTRADA');
  }

  // Test directo de lectura (sin _invResp para evitar ambigüedad)
  Logger.log('── Test lectura directa ──');
  try {
    var sheet   = ss.getSheetByName(SHEET_INV_MAESTRO);
    var lastRow = sheet.getLastRow();
    var numRows = Math.min(5, lastRow - INV_MAESTRO_DATA_ROW + 1);
    var sample  = sheet.getRange(INV_MAESTRO_DATA_ROW, 1, numRows, INV_MAESTRO_NCOLS).getValues();
    Logger.log('✅ Lectura OK — muestra primeros ' + numRows + ' SKUs:');
    sample.forEach(function(r) {
      Logger.log('   ' + r[0] + ' | exist_actual=' + r[9] + ' | valor=' + r[10]);
    });
  } catch(e) {
    Logger.log('❌ Error lectura: ' + e.message);
  }

  Logger.log('══════ FIN ══════');
}
