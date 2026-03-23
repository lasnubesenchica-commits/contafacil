// ═══════════════════════════════════════════════════════════════
//  Ramon Pico — Backend de Órdenes + Ingresos + Egresos
//  Google Apps Script
//  v10 — registrarPagoOperacion en doPost + doGet
//         marcarCostoOperativo en doGet
// ═══════════════════════════════════════════════════════════════

// ── CONFIG ────────────────────────────────────────────────────
var CONFIG = {
  SHEET_ID:          '19NdRKbHpGNwHY8liyEX7K6OYjXBak_aCRIAlEJ_msXs',
  SHEET_ORDENES:     'Ordenes',
  SHEET_INGRESOS:    'Ingresos',
  ADMIN_EMAIL:       'lasnubesenchica@gmail.com',
  NEGOCIO:           'Ramon Pico — Equipos Industriales',
  WA_NUM:            '50766724615',
  VOUCHER_FOLDER_ID: '1LeRHdrP4m0f3z6aU9xoUDyfzUa-UAoh7',
  ITBMS_RATE:        0.07,
};

// Columnas Tab Ordenes (base 1)
var COL_O = {
  ORDEN_NUM: 1, FECHA: 2, ESTADO: 3,
  NOMBRE: 4, RUC: 5, TELEFONO: 6, EMAIL: 7,
  DIRECCION: 8, NOTAS: 9, PAGO: 10,
  TOTAL_STR: 11, TOTAL_NUM: 12,
  PRODUCTOS: 13, VOUCHER: 14,
  MONTO_PAGADO: 15, ESTADO_PAGO: 16, SALDO_PEND: 17,
  CODIGO_TRANS: 18, PAGADOR: 19, FECHA_PAGO: 20,
  INGRESO_ID: 21, DV: 22,
};

// Columnas Tab Ingresos (base 1) — 24 cols, 2 filas cabecera
var COL_I = {
  ID_TRANS:      1,
  FECHA_REG:     2,
  ESTADO:        3,
  CONFIANZA_IA:  4,
  FECHA_INGRESO: 5,
  MES:           6,
  ANIO_FISCAL:   7,
  SUBTOTAL:      8,
  ITBMS:         9,
  TOTAL:        10,
  MONEDA:       11,
  TIPO_INGRESO: 12,
  CATEGORIA:    13,
  EXENTO_FRM93: 14,
  NOMBRE_CLI:   15,
  RUC_CLI:      16,
  TIPO_PERSONA: 17,
  NUM_FACTURA:  18,
  TIPO_COMP:    19,
  DRIVE_URL:    20,
  DRIVE_PATH:   21,
  DESCRIPCION:  22,
  NOTAS_INT:    23,
  FLAG_REV:     24,
};
var INGRESOS_NCOLS = 24;

// Columnas Tab Egresos (base 1) — 20 cols, 2 filas cabecera
var SHEET_EGRESOS = 'Egresos';
var COL_E = {
  ID:          1,   // A  id_egreso
  FECHA_REG:   2,   // B  fecha_registro
  ESTADO:      3,   // C  estado
  FECHA_GASTO: 4,   // D  fecha_egreso
  MES:         5,   // E  mes
  ANIO:        6,   // F  anio_fiscal
  SUBTOTAL:    7,   // G  subtotal
  ITBMS:       8,   // H  itbms
  TOTAL:       9,   // I  total
  MONEDA:     10,   // J  moneda
  TIPO_EGRESO:11,   // K  tipo_egreso
  CATEGORIA:  12,   // L  categoria
  PROVEEDOR:  13,   // M  proveedor
  RUC_PROV:   14,   // N  ruc_proveedor
  DV_PROV:    15,   // O  dv_proveedor
  NFACTURA:   16,   // P  num_factura_ref
  ID_ITEM_CV: 17,   // Q  id_item_cv
  DRIVE_URL:  18,   // R  drive_url
  DESCRIPCION:19,   // S  descripcion
  NOTAS:      20,   // T  notas
};
var EGRESOS_NCOLS = 20;

// ═══════════════════════════════════════════════════════════════
//  WEB APP ENTRY POINT — doPost
// ═══════════════════════════════════════════════════════════════

function doPost(e) {
  try {
    var data   = JSON.parse(e.postData.contents);
    var action = data.action || '';
     Logger.log('doPost action: ' + action + ' | id_item: ' + (data.id_item||''));  // ← agregar esta línea
    // ── ADMIN: subir voucher COD ────────────────────────────────
    if (action === 'uploadVoucherCOD') {
      if (!data.voucherBase64 || !data.orderNumber) {
        return ContentService
          .createTextOutput(JSON.stringify({ success: false, error: 'Faltan datos: voucherBase64 u orderNumber' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      var voucherUrl = saveVoucherToDrive(data);
      var ss2    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
      var sheet2 = ss2.getSheetByName(CONFIG.SHEET_ORDENES);
      if (sheet2) {
        var rows2 = sheet2.getDataRange().getValues();
        for (var j = 1; j < rows2.length; j++) {
          if (String(rows2[j][COL_O.ORDEN_NUM - 1]) === String(data.orderNumber)) {
            sheet2.getRange(j + 1, COL_O.VOUCHER).setValue(voucherUrl);
            break;
          }
        }
      }
      return ContentService
        .createTextOutput(JSON.stringify({ success: true, voucherUrl: voucherUrl }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // ── ADMIN: actualizar orden ─────────────────────────────────
    if (action === 'updateOrden' || action === 'updateYappy') {
      if (data.voucherBase64 && data.voucherName) {
        data.voucherUrl = saveVoucherToDrive(data);
      }
      _updateOrden(data);
      return ContentService
        .createTextOutput(JSON.stringify({ success: true }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // ── ADMIN: analizar factura de egreso con IA ────────────────
    if (action === 'parseFacturaEgreso') {
      return _handleParseFacturaEgreso(data);
    }

    // ── ADMIN: analizar comprobante de ingreso con IA ───────────
    if (action === 'parseComprobanteIngreso') {
      return _handleParseComprobanteIngreso(data);
    }

    if (action === 'analizarFacturaPendiente') {
      var pData = {
        id_item:   data.id_item   || '',
        pdfBase64: data.pdfBase64 || '',
        tipo:      data.tipo      || 'emitida',
      };
      return _handleAnalizarFacturaPendiente(pData, '');
    }

    // ── OPERACIONES: registrar comprobante de pago → cierra ciclo ──
    if (action === 'registrarPagoOperacion') {
      // Subir comprobante a Drive si viene en el payload
      var driveUrlPago = '';
      if (data.imageBase64 && data.imageName) {
        try {
          var folder2  = DriveApp.getFolderById(CONFIG.VOUCHER_FOLDER_ID);
          var mime2    = data.imageMime || 'image/jpeg';
          var bytes2   = Utilities.base64Decode(data.imageBase64);
          var blob2    = Utilities.newBlob(bytes2, mime2, data.imageName);
          var file2    = folder2.createFile(blob2);
          file2.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
          driveUrlPago = 'https://drive.google.com/file/d/' + file2.getId() + '/view';
        } catch(driveErr) {
          Logger.log('Error subiendo comprobante pago: ' + driveErr.message);
        }
      }
      // Delegar al handler de Operaciones
      var pagoParams = {
        id_item:    data.id_item    || '',
        forma_pago: data.forma_pago || '',
        driveUrl:   driveUrlPago,
        callback:   '',
      };
      return _handleRegistrarPagoOperacion(pagoParams, '');
    }

    // ── TIENDA: nueva orden ─────────────────────────────────────
    var voucherUrl = '';
    if (data.voucherBase64 && data.voucherName) {
      voucherUrl = saveVoucherToDrive(data);
    }
    saveOrden(data, voucherUrl);
    sendAdminEmail(data, voucherUrl);
    sendClientEmail(data);
    return ContentService
      .createTextOutput(JSON.stringify({ success: true, orderNumber: data.orderNumber }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log('Error doPost: ' + err.message);
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ═══════════════════════════════════════════════════════════════
//  _updateOrden
// ═══════════════════════════════════════════════════════════════

function _updateOrden(data) {
  var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.SHEET_ORDENES);
  if (!sheet) throw new Error('Hoja Ordenes no encontrada');

  var rows  = sheet.getDataRange().getValues();
  var found = -1;
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][COL_O.ORDEN_NUM - 1]) === String(data.orderNumber)) {
      found = i + 1;
      break;
    }
  }
  if (found === -1) throw new Error('Orden no encontrada: ' + data.orderNumber);

  if (data.estado)         sheet.getRange(found, COL_O.ESTADO).setValue(data.estado);
  if (data.montoPagado)    sheet.getRange(found, COL_O.MONTO_PAGADO).setValue(data.montoPagado);
  if (data.estadoPago)     sheet.getRange(found, COL_O.ESTADO_PAGO).setValue(data.estadoPago);
  if (data.saldoPendiente !== undefined && data.saldoPendiente !== '') sheet.getRange(found, COL_O.SALDO_PEND).setValue(data.saldoPendiente);
  if (data.codigo)         sheet.getRange(found, COL_O.CODIGO_TRANS).setValue(data.codigo);
  if (data.pagador)        sheet.getRange(found, COL_O.PAGADOR).setValue(data.pagador);
  if (data.fechaPago)      sheet.getRange(found, COL_O.FECHA_PAGO).setValue(data.fechaPago);
  if (data.voucherUrl)     sheet.getRange(found, COL_O.VOUCHER).setValue(data.voucherUrl);

  var pago       = String(rows[found - 1][COL_O.PAGO - 1] || '');
  var estadoPago = data.estadoPago || String(rows[found - 1][COL_O.ESTADO_PAGO - 1] || '');
  if (pago === 'Yappy') {
    var bg = estadoPago === 'completo' ? '#E8F5E9' :
             estadoPago === 'parcial'  ? '#FFF9C4' : '#FFF3E0';
    sheet.getRange(found, 1, 1, COL_O.DV).setBackground(bg);
  }

  if (data.estado === 'Confirmada' || data.estado === 'Entregada') {
    sheet.getRange(found, 1, 1, COL_O.DV).setBackground('#E8F5E9');
    try {
      var rowData = sheet.getRange(found, 1, 1, COL_O.DV).getValues()[0];
      _buscarYVincularOrdenWebPorOrden(
        rowData[COL_O.ORDEN_NUM - 1],
        rowData[COL_O.NOMBRE - 1],
        rowData[COL_O.TOTAL_NUM - 1],
        rowData[COL_O.FECHA - 1]
      );
    } catch(cvErr) {
      Logger.log('CV vínculo orden (updateOrden): ' + cvErr.message);
    }
  }

  if (data.estado === 'Cancelada') {
    sheet.getRange(found, 1, 1, COL_O.DV).setBackground('#FFEBEE');
  }
}

// ═══════════════════════════════════════════════════════════════
//  doGet
// ═══════════════════════════════════════════════════════════════

function doGet(e) {
  var params   = e ? (e.parameter || {}) : {};
  var action   = params.action || '';
  var callback = params.callback || '';

  try {

    // ── OPERACIONES ─────────────────────────────────────────────
    if (action === 'sincronizarEmails')        return _handleSincronizar(params, callback);
    if (action === 'getComprasVentas')         return _handleGetComprasVentas(params, callback);
    if (action === 'aprobarMatch')             return _handleAprobarMatch(params, callback);
    if (action === 'registrarVentaDirecta')    return _handleRegistrarVentaDirecta(params, callback);
    if (action === 'analizarFacturaPendiente') return _handleAnalizarFacturaPendiente(params, callback);
    if (action === 'buscarOrdenWeb')           return _handleBuscarOrdenWeb(params, callback);
    if (action === 'vincularOrdenWeb')         return _handleVincularOrdenWeb(params, callback);
    if (action === 'moverAInventario')         return _handleMoverAInventario(params, callback);
    // PATCH 12 — nuevas actions añadidas
    if (action === 'registrarEgresoOperativo') return _handleRegistrarEgresoOperativo(params, callback);
    if (action === 'marcarCostoOperativo')     return _handleMarcarCostoOperativo(params, callback);
    if (action === 'registrarPagoOperacion')   return _handleRegistrarPagoOperacion(params, callback);
    if (action === 'getEgresos')               return _handleGetEgresos(params, callback);
    if (action === 'getIngresos')              return _handleGetIngresos(params, callback);
    if (action === 'registrarIngresoManual')   return _handleRegistrarIngresoManual(params, callback);

    // ── JSONP: uploadVoucher ─────────────────────────────────────
    if (action === 'uploadVoucher') {
      var orderNumber = params.orderNumber || '';
      var fileName    = params.fileName    || ('voucher_' + orderNumber + '.jpg');
      var base64Data  = params.base64      || '';
      var result      = { success: false, voucherUrl: null, error: null };
      try {
        if (!base64Data) throw new Error('No se recibió imagen');
        var decoded  = Utilities.base64Decode(base64Data);
        var blob     = Utilities.newBlob(decoded, 'image/jpeg', fileName);
        var folder   = DriveApp.getFolderById(CONFIG.VOUCHER_FOLDER_ID);
        var file     = folder.createFile(blob);
        file.setName('Voucher_' + orderNumber + '_' + fileName);
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        var fileUrl  = 'https://drive.google.com/file/d/' + file.getId() + '/view';
        var ss2    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
        var sheet2 = ss2.getSheetByName(CONFIG.SHEET_ORDENES);
        if (sheet2) {
          var rows2 = sheet2.getDataRange().getValues();
          for (var j = 1; j < rows2.length; j++) {
            if (String(rows2[j][COL_O.ORDEN_NUM - 1]) === String(orderNumber)) {
              sheet2.getRange(j + 1, COL_O.VOUCHER).setValue(fileUrl);
              break;
            }
          }
        }
        result.success    = true;
        result.voucherUrl = fileUrl;
      } catch (uploadErr) {
        result.error = 'Error subiendo voucher: ' + uploadErr.message;
        Logger.log(result.error);
      }
      var jsonStr2 = JSON.stringify(result);
      if (callback) return ContentService.createTextOutput(callback + '(' + jsonStr2 + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
      return ContentService.createTextOutput(jsonStr2).setMimeType(ContentService.MimeType.JSON);
    }

    // ── JSONP: analyzeVoucher ────────────────────────────────────
    if (action === 'analyzeVoucher') {
      var orderNumber = params.orderNumber || '';
      var result      = { success: false, data: null, error: null };
      var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
      var sheet = ss.getSheetByName(CONFIG.SHEET_ORDENES);
      var voucherUrl = '';
      var totalOrden = 0;
      if (sheet) {
        var rows = sheet.getDataRange().getValues();
        for (var i = 1; i < rows.length; i++) {
          if (String(rows[i][COL_O.ORDEN_NUM - 1]) === String(orderNumber)) {
            voucherUrl = String(rows[i][COL_O.VOUCHER - 1] || '');
            totalOrden = parseFloat(String(rows[i][COL_O.TOTAL_NUM - 1] || '0')) || 0;
            break;
          }
        }
      }
      if (!voucherUrl) {
        result.error = 'Esta orden no tiene voucher adjunto';
      } else {
        var fileId = _extractDriveFileId(voucherUrl);
        if (!fileId) {
          result.error = 'No se pudo leer el archivo de Drive';
        } else {
          try {
            var file     = DriveApp.getFileById(fileId);
            var blob     = file.getBlob();
            var b64      = Utilities.base64Encode(blob.getBytes());
            var mimeType = blob.getContentType() || 'image/jpeg';
            var claudeResult = _callClaudeVision(b64, mimeType);
            if (claudeResult) {
              var montoPagado = parseFloat(String(claudeResult.monto || '0').replace(/[^0-9.]/g, '')) || 0;
              var estadoPago  = '';
              var saldo       = '';
              if (montoPagado > 0 && totalOrden > 0) {
                estadoPago = montoPagado >= totalOrden ? 'completo' : 'parcial';
                if (estadoPago === 'parcial') saldo = (Math.max(0, totalOrden - montoPagado)).toFixed(2);
              }
              claudeResult.estadoPago = estadoPago;
              claudeResult.saldo      = saldo;
              result.success = true;
              result.data    = claudeResult;
            } else {
              result.error = 'Claude Vision no pudo procesar la imagen';
            }
          } catch (driveErr) {
            result.error = 'Error accediendo al archivo: ' + driveErr.message;
          }
        }
      }
      var jsonStr = JSON.stringify(result);
      if (callback) return ContentService.createTextOutput(callback + '(' + jsonStr + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
      return ContentService.createTextOutput(jsonStr).setMimeType(ContentService.MimeType.JSON);
    }

    // ── JSONP: updateOrden / updateYappy ────────────────────────
    if (action === 'updateOrden' || action === 'updateYappy') {
      var result = { success: false, error: null };
      try {
        var data = {
          orderNumber:    params.orderNumber    || '',
          estado:         params.estado         || '',
          montoPagado:    params.montoPagado    || '',
          estadoPago:     params.estadoPago     || '',
          saldoPendiente: params.saldoPendiente || '',
          codigo:         params.codigo         || '',
          pagador:        params.pagador        || '',
          fechaPago:      params.fechaPago      || '',
          voucherUrl:     params.voucherUrl     || '',
        };
        _updateOrden(data);
        result.success = true;
      } catch(updateErr) {
        result.error = updateErr.message;
        Logger.log('Error updateOrden via GET: ' + updateErr.message);
      }
      var jsonStr3 = JSON.stringify(result);
      if (callback) return ContentService.createTextOutput(callback + '(' + jsonStr3 + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
      return ContentService.createTextOutput(jsonStr3).setMimeType(ContentService.MimeType.JSON);
    }

    // ── Default: health check ───────────────────────────────────
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'OK', ts: new Date().toISOString() }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log('Error doGet: ' + err.message);
    var errStr = JSON.stringify({ error: err.message });
    if (callback) return ContentService.createTextOutput(callback + '(' + errStr + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(errStr).setMimeType(ContentService.MimeType.JSON);
  }
}

// ═══════════════════════════════════════════════════════════════
//  TRIGGER onEdit
// ═══════════════════════════════════════════════════════════════

function onEditTrigger(e) {
  try {
    var sheet = e.range.getSheet();
    if (sheet.getName() !== CONFIG.SHEET_ORDENES) return;
    if (e.range.getColumn() !== COL_O.ESTADO) return;
    if (e.range.getRow() === 1) return;

    var nuevoEstado = String(e.value || '').trim();
    if (['Confirmada', 'Entregada'].indexOf(nuevoEstado) === -1) return;

    var row     = e.range.getRow();
    var rowData = sheet.getRange(row, 1, 1, COL_O.DV).getValues()[0];
    sheet.getRange(row, 1, 1, COL_O.DV).setBackground('#E8F5E9');
    Logger.log('Orden confirmada/entregada: ' + rowData[COL_O.ORDEN_NUM - 1]);

    try {
      _buscarYVincularOrdenWebPorOrden(
        rowData[COL_O.ORDEN_NUM - 1],
        rowData[COL_O.NOMBRE - 1],
        rowData[COL_O.TOTAL_NUM - 1],
        rowData[COL_O.FECHA - 1]
      );
    } catch(cvErr) {
      Logger.log('CV vínculo orden (onEdit): ' + cvErr.message);
    }

  } catch (err) {
    Logger.log('Error onEditTrigger: ' + err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
//  CREAR INGRESO — formato ContaFácil exacto
// ═══════════════════════════════════════════════════════════════

function crearIngreso(orden) {
  var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.SHEET_INGRESOS);
  if (!sheet) throw new Error('Hoja Ingresos no encontrada. Ejecuta initSheets().');

  var ahora    = new Date();
  var fechaReg = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
  var mes      = ahora.getMonth() + 1;
  var anio     = ahora.getFullYear();

  var montoPagado = parseFloat(String(orden.montoPagado || '0').replace(/[^0-9.]/g, '')) || 0;
  var totalOrden  = parseFloat(String(orden.totalNum || orden.totalStr || '0').replace(/[^0-9.]/g, '')) || 0;
  var total       = montoPagado > 0 ? montoPagado : totalOrden;
  var subtotal    = total > 0 ? parseFloat((total / (1 + CONFIG.ITBMS_RATE)).toFixed(2)) : 0;
  var itbms       = total > 0 ? parseFloat((total - subtotal).toFixed(2)) : 0;

  var fechaIngr = orden.fechaPago
    ? String(orden.fechaPago).substring(0, 10)
    : Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd');

  var desc = '';
  if (orden.productos && orden.productos.length) {
    var partes = [];
    for (var i = 0; i < orden.productos.length; i++) {
      var p = orden.productos[i];
      partes.push((p.titulo || p.title || '') + ' ×' + (p.cantidad || p.qty || 1));
    }
    desc = partes.join(' | ');
  }

  var notas = 'Pago: ' + (orden.pago || '');
  if (orden.pago === 'Yappy') {
    if (orden.estadoPago)     notas += ' | Estado: ' + orden.estadoPago;
    if (orden.codigoTrans)    notas += ' | Cód: ' + orden.codigoTrans;
    if (orden.pagador)        notas += ' | Pagador: ' + orden.pagador;
    if (orden.saldoPendiente) notas += ' | Saldo pendiente: $' + orden.saldoPendiente;
  }
  notas += ' | Tel: ' + (orden.telefono || '') + ' | Dir: ' + (orden.direccion || '');
  if (orden.notas) notas += ' | Notas: ' + orden.notas;

  var estadoIngreso = 'confirmado';
  if (String(orden.estadoPago) === 'parcial') estadoIngreso = 'abono';
  if (String(orden.estadoPago) === 'sinpago') estadoIngreso = 'pendiente';

  var id = 'ING-RP-' + Utilities.formatDate(ahora, 'America/Panama', 'yyyyMMddHHmmss');

  var fila = new Array(INGRESOS_NCOLS);
  fila[COL_I.ID_TRANS - 1]      = id;
  fila[COL_I.FECHA_REG - 1]     = fechaReg;
  fila[COL_I.ESTADO - 1]        = estadoIngreso;
  fila[COL_I.CONFIANZA_IA - 1]  = orden.pago === 'Yappy' ? 'ia_vision' : 'manual';
  fila[COL_I.FECHA_INGRESO - 1] = fechaIngr;
  fila[COL_I.MES - 1]           = mes;
  fila[COL_I.ANIO_FISCAL - 1]   = anio;
  fila[COL_I.SUBTOTAL - 1]      = subtotal || '';
  fila[COL_I.ITBMS - 1]         = itbms    || '';
  fila[COL_I.TOTAL - 1]         = total    || '';
  fila[COL_I.MONEDA - 1]        = 'USD';
  fila[COL_I.TIPO_INGRESO - 1]  = 'venta_producto';
  fila[COL_I.CATEGORIA - 1]     = 'venta_producto_gravado';
  fila[COL_I.EXENTO_FRM93 - 1]  = '';
  fila[COL_I.NOMBRE_CLI - 1]    = orden.nombre || '';
  fila[COL_I.RUC_CLI - 1]       = orden.ruc    || '';
  fila[COL_I.TIPO_PERSONA - 1]  = detectarTipoPersona(String(orden.ruc || ''));
  fila[COL_I.NUM_FACTURA - 1]   = orden.orderNumber || '';
  fila[COL_I.TIPO_COMP - 1]     = 'orden_web';
  fila[COL_I.DRIVE_URL - 1]     = orden.voucherUrl || '';
  fila[COL_I.DRIVE_PATH - 1]    = '';
  fila[COL_I.DESCRIPCION - 1]   = desc;
  fila[COL_I.NOTAS_INT - 1]     = notas;
  fila[COL_I.FLAG_REV - 1]      = String(orden.estadoPago) === 'parcial';

  var lastRow = sheet.getLastRow() + 1;
  sheet.getRange(lastRow, 1, 1, INGRESOS_NCOLS).setValues([fila]);
  sheet.getRange(lastRow, COL_I.SUBTOTAL, 1, 3).setNumberFormat('#,##0.00');

  var bgIngreso = estadoIngreso === 'confirmado' ? '#F1F8E9' :
                  estadoIngreso === 'abono'       ? '#FFF9C4' : '#FFF3E0';
  sheet.getRange(lastRow, 1, 1, 25).setBackground(bgIngreso);

  return id;
}

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════

function _extractDriveFileId(url) {
  var patterns = [
    /\/file\/d\/([a-zA-Z0-9_-]+)/,
    /id=([a-zA-Z0-9_-]+)/,
    /\/d\/([a-zA-Z0-9_-]+)/,
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = String(url).match(patterns[i]);
    if (m) return m[1];
  }
  return null;
}

function _callClaudeVision(base64, mimeType) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY no configurada en Script Properties');

  var payload = {
    model:      'claude-sonnet-4-20250514',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: base64 } },
        { type: 'text', text:
            'Analiza este voucher/comprobante de pago de Yappy (Panamá). ' +
            'Responde SOLO con JSON válido, sin texto adicional ni markdown:\n' +
            '{"monto":"monto en números con decimales ej: 150.00",' +
            '"codigo":"código o número de transacción",' +
            '"pagador":"nombre completo de quien pagó",' +
            '"fecha":"fecha y hora del pago",' +
            '"receptor":"nombre o número de quien recibió"}\n' +
            'Si un campo no es visible usa null.'
        }
      ]
    }]
  };

  var options = {
    method: 'post', contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', options);
  var code     = response.getResponseCode();
  if (code !== 200) {
    Logger.log('Claude API error ' + code + ': ' + response.getContentText());
    throw new Error('Claude API respondió con código ' + code);
  }

  var respData = JSON.parse(response.getContentText());
  var text     = '';
  var content  = respData.content || [];
  for (var i = 0; i < content.length; i++) {
    if (content[i].type === 'text') { text = content[i].text; break; }
  }
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

function detectarTipoPersona(ruc) {
  ruc = ruc.trim();
  if (/^\d{1,2}-\d{1,6}-\d{1,6}$/.test(ruc)) return 'natural';
  if (/^\d{6,}-\d{1,3}-\d{6,}$/.test(ruc))   return 'juridica';
  if (/^N-\d+/.test(ruc))                      return 'extranjero';
  if (/^[A-Z]/i.test(ruc))                     return 'juridica';
  return 'natural';
}

function safeParseJson(str) {
  try { return JSON.parse(str); } catch(e) { return []; }
}

// ═══════════════════════════════════════════════════════════════
//  GUARDAR ORDEN EN TAB ORDENES
// ═══════════════════════════════════════════════════════════════

function saveOrden(data, voucherUrl) {
  var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.SHEET_ORDENES);
  if (!sheet) throw new Error('Hoja Ordenes no encontrada. Ejecuta initSheets().');

  var fecha    = Utilities.formatDate(new Date(), 'America/Panama', 'dd/MM/yyyy HH:mm');
  var totalNum = parseFloat(String(data.total || '').replace(/[^0-9.]/g, '')) || 0;

  var row = new Array(22);
  row[COL_O.ORDEN_NUM - 1]    = data.orderNumber || '';
  row[COL_O.FECHA - 1]        = fecha;
  row[COL_O.ESTADO - 1]       = 'Nueva';
  row[COL_O.NOMBRE - 1]       = data.nombre || '';
  row[COL_O.RUC - 1]          = data.ruc || '';
  row[COL_O.TELEFONO - 1]     = data.telefono || '';
  row[COL_O.EMAIL - 1]        = data.email || '';
  row[COL_O.DIRECCION - 1]    = data.direccion || '';
  row[COL_O.NOTAS - 1]        = data.notas || '';
  row[COL_O.PAGO - 1]         = data.pago || '';
  row[COL_O.TOTAL_STR - 1]    = data.total || '';
  row[COL_O.TOTAL_NUM - 1]    = totalNum;
  row[COL_O.PRODUCTOS - 1]    = JSON.stringify(data.productos || []);
  row[COL_O.VOUCHER - 1]      = voucherUrl || '';
  row[COL_O.MONTO_PAGADO - 1] = data.montoPagado    || '';
  row[COL_O.ESTADO_PAGO - 1]  = data.estadoPago     || '';
  row[COL_O.SALDO_PEND - 1]   = data.saldoPendiente || '';
  row[COL_O.CODIGO_TRANS - 1] = data.codigo         || '';
  row[COL_O.PAGADOR - 1]      = data.pagador         || '';
  row[COL_O.FECHA_PAGO - 1]   = data.fechaPago       || '';
  row[COL_O.INGRESO_ID - 1]   = '';
  row[COL_O.DV - 1]           = data.dv || '';

  var lastRow = sheet.getLastRow() + 1;
  sheet.getRange(lastRow, 1, 1, 22).setValues([row]);
  sheet.getRange(lastRow, COL_O.TOTAL_NUM).setNumberFormat('$#,##0.00');
  if (data.montoPagado) sheet.getRange(lastRow, COL_O.MONTO_PAGADO).setNumberFormat('$#,##0.00');

  var bg = '#E3F2FD';
  if (data.pago === 'Yappy') {
    bg = data.estadoPago === 'completo' ? '#E8F5E9' :
         data.estadoPago === 'parcial'  ? '#FFF9C4' : '#FFF3E0';
  }
  sheet.getRange(lastRow, 1, 1, 22).setBackground(bg);
}

// ═══════════════════════════════════════════════════════════════
//  VOUCHER EN DRIVE
// ═══════════════════════════════════════════════════════════════

function saveVoucherToDrive(data) {
  if (!data.voucherBase64 || !data.voucherName) return '';
  return _saveVoucherBase64(
    data.voucherBase64,
    data.voucherName,
    data.voucherType || 'image/jpeg',
    data.orderNumber || 'RP',
    data.nombre || ''
  );
}

function _saveVoucherBase64(base64, nombre, tipo, orderNumber, clienteNombre) {
  try {
    var folder   = DriveApp.getFolderById(CONFIG.VOUCHER_FOLDER_ID);
    var bytes    = Utilities.base64Decode(base64);
    var blob     = Utilities.newBlob(bytes, tipo, nombre);
    var filename = orderNumber + '_' + (clienteNombre || '').replace(/\s+/g, '_') + '_voucher';
    var file     = folder.createFile(blob.setName(filename));
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return file.getUrl();
  } catch (err) {
    Logger.log('Error voucher Drive: ' + err.message);
    return '';
  }
}

// ═══════════════════════════════════════════════════════════════
//  EMAILS
// ═══════════════════════════════════════════════════════════════

function sendAdminEmail(data, voucherUrl) {
  var fecha = Utilities.formatDate(new Date(), 'America/Panama', 'dd/MM/yyyy HH:mm');
  var productosHtml = '';
  var prods = data.productos || [];
  for (var i = 0; i < prods.length; i++) {
    var p  = prods[i];
    var bg = i % 2 === 0 ? '#F5F5F7' : '#FFFFFF';
    productosHtml +=
      '<tr style="background:' + bg + '">' +
        '<td style="padding:10px 16px;font-size:14px">' + (p.titulo || '') + '</td>' +
        '<td style="padding:10px 16px;text-align:center;font-size:14px">×' + (p.cantidad || 1) + '</td>' +
        '<td style="padding:10px 16px;text-align:right;font-size:14px;font-weight:600">' + (p.precio || 'Cotizar') + '</td>' +
      '</tr>';
  }

  var voucherBloque = data.pago === 'Yappy'
    ? '<div style="background:#FFF9C4;border:1px solid #F9A825;border-radius:8px;padding:16px;margin-top:16px"><strong>📱 Voucher Yappy</strong><br>' +
      (voucherUrl ? '<a href="' + voucherUrl + '" style="color:#E05A00;font-weight:600">Ver voucher →</a>' : '<span style="color:#c0392b">⚠️ No adjuntado</span>') +
      '</div>'
    : '';

  var contableBloque =
    '<div style="background:#E8F5E9;border:1px solid #A5D6A7;border-radius:8px;padding:16px;margin-top:16px;font-size:13px">' +
      '<strong>📊 Para registrar en ContaFácil</strong><br>' +
      'Cambia el Estado de la orden a <strong>"Confirmada"</strong> en la hoja <em>Ordenes</em>. ' +
      'El ingreso se creará automáticamente en la hoja <em>Ingresos</em>.' +
    '</div>';

  var waLink = 'https://wa.me/507' + (data.telefono || '').replace(/\D/g, '') +
    '?text=Hola%20' + encodeURIComponent(data.nombre || '') +
    ',%20recibimos%20tu%20orden%20' + (data.orderNumber || '') + '.';

  var html =
    '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
      '<div style="background:#E05A00;padding:24px 32px;border-radius:12px 12px 0 0">' +
        '<div style="font-size:26px;color:#FFF;font-weight:700;letter-spacing:2px">RAMON.PICO</div>' +
        '<div style="color:rgba(255,255,255,0.8);font-size:13px;margin-top:4px">Nueva orden recibida</div>' +
      '</div>' +
      '<div style="background:#FFF;border:1px solid #E5E5E7;border-top:none;padding:32px;border-radius:0 0 12px 12px">' +
        '<div style="display:flex;justify-content:space-between;margin-bottom:24px;padding-bottom:24px;border-bottom:1px solid #E5E5E7">' +
          '<div><div style="font-size:22px;font-weight:700">' + (data.orderNumber || '') + '</div>' +
          '<div style="color:#6C6C70;font-size:13px">' + fecha + '</div></div>' +
          '<div style="background:' + (data.pago === 'Yappy' ? '#FFF9C4' : '#E8F5E9') + ';border-radius:6px;padding:8px 16px;font-weight:600;font-size:14px">' +
            (data.pago === 'Yappy' ? '📱 Yappy' : '🚚 Contra entrega') + '</div>' +
        '</div>' +
        '<div style="margin-bottom:24px">' +
          '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#6C6C70;margin-bottom:10px;font-weight:600">CLIENTE</div>' +
          '<table style="width:100%;border-collapse:collapse">' +
            '<tr><td style="padding:5px 0;color:#6C6C70;font-size:13px;width:110px">Nombre</td><td style="padding:5px 0;font-size:13px;font-weight:600">' + (data.nombre || '') + '</td></tr>' +
            '<tr><td style="padding:5px 0;color:#6C6C70;font-size:13px">Cédula/RUC</td><td style="padding:5px 0;font-size:13px">' + (data.ruc || '') + (data.dv ? ' DV: ' + data.dv : '') + '</td></tr>' +
            '<tr><td style="padding:5px 0;color:#6C6C70;font-size:13px">Teléfono</td><td style="padding:5px 0;font-size:13px"><a href="' + waLink + '" style="color:#E05A00">' + (data.telefono || '') + '</a></td></tr>' +
            '<tr><td style="padding:5px 0;color:#6C6C70;font-size:13px">Email</td><td style="padding:5px 0;font-size:13px">' + (data.email || '') + '</td></tr>' +
            '<tr><td style="padding:5px 0;color:#6C6C70;font-size:13px">Dirección</td><td style="padding:5px 0;font-size:13px">' + (data.direccion || '') + '</td></tr>' +
            (data.notas ? '<tr><td style="padding:5px 0;color:#6C6C70;font-size:13px">Notas</td><td style="padding:5px 0;font-size:13px">' + data.notas + '</td></tr>' : '') +
          '</table>' +
        '</div>' +
        '<table style="width:100%;border-collapse:collapse;margin-bottom:24px">' +
          '<tr style="background:#0A0A0A;color:#FFF"><th style="padding:10px 16px;text-align:left;font-size:12px">Producto</th><th style="padding:10px 16px;text-align:center;font-size:12px">Cant.</th><th style="padding:10px 16px;text-align:right;font-size:12px">Precio</th></tr>' +
          productosHtml +
          '<tr style="background:#0A0A0A;color:#FFF"><td colspan="2" style="padding:12px 16px;font-weight:600">TOTAL</td><td style="padding:12px 16px;text-align:right;font-size:18px;font-weight:700">' + (data.total || '') + '</td></tr>' +
        '</table>' +
        voucherBloque + contableBloque +
        '<div style="margin-top:24px;text-align:center"><a href="' + waLink + '" style="display:inline-block;background:#25D366;color:#FFF;padding:12px 24px;border-radius:8px;font-weight:600;text-decoration:none;font-size:14px">📲 Responder por WhatsApp</a></div>' +
      '</div>' +
    '</div>';

  MailApp.sendEmail({
    to:       CONFIG.ADMIN_EMAIL,
    subject:  '🛒 Nueva Orden ' + (data.orderNumber || '') + ' — ' + (data.nombre || '') + ' (' + (data.pago || '') + ')',
    htmlBody: html,
  });
}

function sendClientEmail(data) {
  var pagoBloque = data.pago === 'Contra entrega'
    ? '<div style="background:#E8F5E9;border:1px solid #A5D6A7;border-radius:8px;padding:16px;margin-top:16px"><strong>🚚 Pago contra entrega</strong><br><span style="font-size:13px;color:#2E7D32">Pagarás al recibir. Te contactaremos para coordinar.</span></div>'
    : '<div style="background:#FFF9C4;border:1px solid #F9A825;border-radius:8px;padding:16px;margin-top:16px"><strong>📱 Yappy recibido</strong><br><span style="font-size:13px;color:#6C6C70">Verificaremos tu voucher y confirmaremos pronto.</span></div>';

  var productosText = '';
  var prods = data.productos || [];
  for (var i = 0; i < prods.length; i++) {
    productosText += '• ' + (prods[i].titulo || '') + ' ×' + (prods[i].cantidad || 1) + '  —  ' + (prods[i].precio || 'Cotizar') + '\n';
  }

  var html =
    '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
      '<div style="background:#E05A00;padding:24px 32px;border-radius:12px 12px 0 0">' +
        '<div style="font-size:26px;color:#FFF;font-weight:700;letter-spacing:2px">RAMON.PICO</div>' +
        '<div style="color:rgba(255,255,255,0.8);font-size:13px;margin-top:4px">Confirmación de tu orden</div>' +
      '</div>' +
      '<div style="background:#FFF;border:1px solid #E5E5E7;border-top:none;padding:32px;border-radius:0 0 12px 12px">' +
        '<p style="font-size:16px">Hola <strong>' + (data.nombre || '') + '</strong>,</p>' +
        '<p style="color:#6C6C70;font-size:14px;line-height:1.6">Recibimos tu orden. Te contactaremos pronto para coordinar la entrega.</p>' +
        '<div style="background:#F5F5F7;border-radius:8px;padding:16px;margin:20px 0">' +
          '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#6C6C70;margin-bottom:6px">Número de orden</div>' +
          '<div style="font-size:24px;font-weight:700;color:#E05A00">' + (data.orderNumber || '') + '</div>' +
        '</div>' +
        '<div style="background:#F5F5F7;border-radius:8px;padding:16px;font-size:13px;line-height:2;white-space:pre-line;margin-bottom:8px">' + productosText + '</div>' +
        '<div style="text-align:right;font-size:18px;font-weight:700;padding:8px 0">Total: ' + (data.total || '') + '</div>' +
        pagoBloque +
        '<div style="margin-top:24px;padding-top:24px;border-top:1px solid #E5E5E7;text-align:center">' +
          '<a href="https://wa.me/' + CONFIG.WA_NUM + '" style="display:inline-block;background:#25D366;color:#FFF;padding:10px 20px;border-radius:8px;font-weight:600;text-decoration:none;font-size:14px">📲 WhatsApp</a>' +
        '</div>' +
      '</div>' +
    '</div>';

  MailApp.sendEmail({
    to:       data.email,
    subject:  '✅ Orden ' + (data.orderNumber || '') + ' recibida — ' + CONFIG.NEGOCIO,
    htmlBody: html,
  });
}

// ═══════════════════════════════════════════════════════════════
//  SETUP
// ═══════════════════════════════════════════════════════════════

function initSheets() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  _initOrdenesSheet(ss);
  _initIngresosSheet(ss);
  _initEgresosSheet(ss);
  Logger.log('✅ Hojas inicializadas.');
}

function resetSheets() {
  var ss     = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var nombres = [CONFIG.SHEET_ORDENES, CONFIG.SHEET_INGRESOS];
  for (var i = 0; i < nombres.length; i++) {
    var hoja = ss.getSheetByName(nombres[i]);
    if (hoja) { ss.deleteSheet(hoja); SpreadsheetApp.flush(); }
  }
  _initOrdenesSheet(ss);
  _initIngresosSheet(ss);
  Logger.log('✅ Hojas recreadas.');
}

function _initOrdenesSheet(ss) {
  if (ss.getSheetByName(CONFIG.SHEET_ORDENES)) {
    Logger.log('⚠️ Hoja "' + CONFIG.SHEET_ORDENES + '" ya existe.');
    return;
  }
  var sheet = ss.insertSheet(CONFIG.SHEET_ORDENES);
  SpreadsheetApp.flush();

  var headers = [
    'Orden #','Fecha','Estado','Nombre','Cédula/RUC','Teléfono','Email',
    'Dirección','Notas cliente','Método de Pago','Total','Total (num)',
    'Productos (JSON)','Voucher URL','Monto Pagado','Estado Pago',
    'Saldo Pendiente','Código Trans.','Pagador','Fecha Pago','ID Ingreso CF','DV Cliente',
  ];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length).setBackground('#E05A00').setFontColor('#FFFFFF').setFontWeight('bold');
  sheet.setFrozenRows(1);

  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['Nueva', 'Confirmada', 'Entregada', 'Cancelada'], true)
    .setAllowInvalid(false).build();
  sheet.getRange('C2:C1000').setDataValidation(rule);

  var rulePago = SpreadsheetApp.newDataValidation()
    .requireValueInList(['completo', 'parcial', 'sinpago'], true)
    .setAllowInvalid(true).build();
  sheet.getRange('P2:P1000').setDataValidation(rulePago);

  var widths = [100,130,110,160,110,100,180,200,150,130,80,90,300,250,100,90,110,140,160,120,150,60];
  for (var i = 0; i < widths.length; i++) sheet.setColumnWidth(i + 1, widths[i]);

  sheet.getRange('L2:L1000').setNumberFormat('$#,##0.00');
  sheet.getRange('O2:O1000').setNumberFormat('$#,##0.00');
  sheet.getRange('Q2:Q1000').setNumberFormat('$#,##0.00');
  Logger.log('✅ Hoja Ordenes creada.');
}

function _initIngresosSheet(ss) {
  if (ss.getSheetByName(CONFIG.SHEET_INGRESOS)) {
    Logger.log('⚠️ Hoja "' + CONFIG.SHEET_INGRESOS + '" ya existe.');
    return;
  }
  var sheet = ss.insertSheet(CONFIG.SHEET_INGRESOS);
  SpreadsheetApp.flush();

  var meta = [
    'METADATA','','','','FECHA','','','MONTOS','','','',
    'CLASIF FISCAL','','','CLIENTE','','','COMPROBANTE','','','','NOTAS','',''
  ];
  var headers = [
    'id_transaccion','fecha_registro','estado','confianza_ia',
    'fecha_ingreso','mes','anio_fiscal',
    'subtotal','itbms','total','moneda',
    'tipo_ingreso','categoria_ingreso','concepto_exento_frm93',
    'nombre_cliente','ruc_cliente','tipo_persona_cliente',
    'num_factura','tipo_comprobante','drive_url','drive_path',
    'descripcion','notas_internas','flag_revision'
  ];

  sheet.getRange(1, 1, 1, INGRESOS_NCOLS).setValues([meta]);
  sheet.getRange(1, 1, 1, INGRESOS_NCOLS).setBackground('#37474F').setFontColor('#FFFFFF').setFontWeight('bold');
  sheet.getRange(2, 1, 1, INGRESOS_NCOLS).setValues([headers]);
  sheet.getRange(2, 1, 1, INGRESOS_NCOLS).setBackground('#546E7A').setFontColor('#FFFFFF').setFontWeight('bold');
  sheet.setFrozenRows(2);

  var w = [170,150,100,100,110,50,80,90,70,90,60,120,140,140,160,110,110,120,110,250,200,300,250,90];
  for (var i = 0; i < w.length; i++) sheet.setColumnWidth(i + 1, w[i]);
  sheet.getRange('H3:J1000').setNumberFormat('#,##0.00');
  Logger.log('✅ Hoja Ingresos creada.');
}

function _initEgresosSheet(ss) {
  var existing = ss.getSheetByName(SHEET_EGRESOS);
  if (existing) return existing;

  var sheet = ss.insertSheet(SHEET_EGRESOS);
  SpreadsheetApp.flush();

  var meta = [
    'METADATA','','','FECHA','','','MONTOS','','','','CLASIFICACIÓN','',
    'PROVEEDOR','','','COMPROBANTE','','','NOTAS',''
  ];
  var headers = [
    'id_egreso','fecha_registro','estado','fecha_egreso','mes','anio_fiscal',
    'subtotal','itbms','total','moneda',
    'tipo_egreso','categoria',
    'proveedor','ruc_proveedor','dv_proveedor',
    'num_factura_ref','id_item_cv','drive_url',
    'descripcion','notas'
  ];

  sheet.getRange(1, 1, 1, EGRESOS_NCOLS).setValues([meta]);
  sheet.getRange(1, 1, 1, EGRESOS_NCOLS)
    .setBackground('#37474F').setFontColor('#FFFFFF').setFontWeight('bold');
  sheet.getRange(2, 1, 1, EGRESOS_NCOLS).setValues([headers]);
  sheet.getRange(2, 1, 1, EGRESOS_NCOLS)
    .setBackground('#546E7A').setFontColor('#FFFFFF').setFontWeight('bold');
  sheet.setFrozenRows(2);

  var widths = [180,150,100,110,50,80,90,70,90,60,120,130,200,130,80,140,160,260,300,220];
  for (var i = 0; i < widths.length; i++) sheet.setColumnWidth(i + 1, widths[i]);
  sheet.getRange('G3:I1000').setNumberFormat('#,##0.00');
  Logger.log('✅ Hoja Egresos creada.');
  return sheet;
}

function installTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'onEditTrigger') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('onEditTrigger')
    .forSpreadsheet(CONFIG.SHEET_ID)
    .onEdit()
    .create();
  Logger.log('✅ Trigger onEdit instalado.');
}

function migrarEgresosDV() {
  var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_EGRESOS);
  if (!sheet) { Logger.log('❌ Hoja Egresos no encontrada'); return; }

  var headers = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (headers.indexOf('dv_proveedor') !== -1) {
    Logger.log('⚠️ Columna dv_proveedor ya existe en col ' + (headers.indexOf('dv_proveedor') + 1) + ' — migración cancelada');
    return;
  }

  sheet.insertColumnBefore(15);
  SpreadsheetApp.flush();

  sheet.getRange(1, 15).setValue('');
  sheet.getRange(2, 15).setValue('dv_proveedor');
  sheet.getRange(2, 15)
    .setBackground('#546E7A')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold');
  sheet.setColumnWidth(15, 80);

  Logger.log('✅ migrarEgresosDV completada — columna dv_proveedor insertada en col 15');
}

// ═══════════════════════════════════════════════════════════════
//  _handleGetEgresos
// ═══════════════════════════════════════════════════════════════

function _handleGetEgresos(params, callback) {
  var result = { success: false, items: [], error: null };
  try {
    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_EGRESOS);

    if (!sheet || sheet.getLastRow() <= 2) {
      result.success = true;
      var json0 = JSON.stringify(result);
      if (callback) return ContentService.createTextOutput(callback + '(' + json0 + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
      return ContentService.createTextOutput(json0).setMimeType(ContentService.MimeType.JSON);
    }

    var numDataRows = sheet.getLastRow() - 2;
    var data  = sheet.getRange(3, 1, numDataRows, EGRESOS_NCOLS).getValues();
    var items = [];

    for (var i = 0; i < data.length; i++) {
      var r = data[i];
      if (!r[COL_E.ID - 1]) continue;
      var fechaGasto = r[COL_E.FECHA_GASTO - 1];
      if (fechaGasto instanceof Date) {
        fechaGasto = Utilities.formatDate(fechaGasto, 'America/Panama', 'yyyy-MM-dd');
      } else {
        fechaGasto = String(fechaGasto || '').slice(0, 10);
      }
      items.push({
        id_egreso:    r[COL_E.ID - 1],
        fecha_reg:    r[COL_E.FECHA_REG - 1],
        estado:       r[COL_E.ESTADO - 1]       || 'registrado',
        fecha_egreso: fechaGasto,
        tipo_egreso:  r[COL_E.TIPO_EGRESO - 1]  || '',
        categoria:    r[COL_E.CATEGORIA - 1]    || '',
        subtotal:     parseFloat(r[COL_E.SUBTOTAL - 1])  || 0,
        itbms:        parseFloat(r[COL_E.ITBMS - 1])     || 0,
        total:        parseFloat(r[COL_E.TOTAL - 1])      || 0,
        proveedor:    r[COL_E.PROVEEDOR - 1]   || '',
        ruc_prov:     r[COL_E.RUC_PROV - 1]    || '',
        dv_prov:      r[COL_E.DV_PROV - 1]     || '',
        num_fac_ref:  r[COL_E.NFACTURA - 1]    || '',
        id_item_cv:   r[COL_E.ID_ITEM_CV - 1]  || '',
        drive_url:    r[COL_E.DRIVE_URL - 1]   || '',
        descripcion:  r[COL_E.DESCRIPCION - 1] || '',
        notas:        r[COL_E.NOTAS - 1]       || '',
        _row:         i + 3,
      });
    }
    result.success = true;
    result.items   = items;
  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleGetEgresos: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════
//  _handleRegistrarEgresoOperativo
// ═══════════════════════════════════════════════════════════════

function _handleRegistrarEgresoOperativo(params, callback) {
  var result = { success: false, egresoId: null, error: null };
  try {
    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = _initEgresosSheet(ss);

    var ahora      = new Date();
    var fechaReg   = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
    var fechaGasto = params.fecha || Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd');
    var year       = new Date(fechaGasto + 'T12:00:00').getFullYear() || ahora.getFullYear();

    var lastRow = sheet.getLastRow();
    var seq     = 1;
    if (lastRow > 2) {
      var ids = sheet.getRange(3, COL_E.ID, lastRow - 2, 1).getValues();
      for (var k = ids.length - 1; k >= 0; k--) {
        var v = String(ids[k][0] || '');
        if (v.indexOf('EGR-RP-') === 0) {
          var parts = v.split('-');
          var n     = parseInt(parts[parts.length - 1], 10);
          if (!isNaN(n)) { seq = n + 1; break; }
        }
      }
    }
    var id = 'EGR-RP-' + year + '-' + String(seq).padStart(4, '0');

    var total    = parseFloat(params.total)    || 0;
    var itbms    = parseFloat(params.itbms)    || 0;
    var subtotal = parseFloat(params.subtotal) || parseFloat((total - itbms).toFixed(2));

    // Duplicate check
    var provNuevo = String(params.proveedor || '').trim().toUpperCase();
    var nfacNuevo = String(params.num_fac   || '').trim();
    if (provNuevo && nfacNuevo && lastRow > 2) {
      var existing = sheet.getRange(3, 1, lastRow - 2, EGRESOS_NCOLS).getValues();
      for (var d = 0; d < existing.length; d++) {
        var provExist = String(existing[d][COL_E.PROVEEDOR - 1] || '').trim().toUpperCase();
        var nfacExist = String(existing[d][COL_E.NFACTURA - 1]  || '').trim();
        if (provExist === provNuevo && nfacExist && nfacExist === nfacNuevo) {
          result.error = 'DUPLICADO: Ya existe un egreso del proveedor "' + params.proveedor +
                         '" con factura "' + params.num_fac + '".';
          var jd = JSON.stringify(result);
          if (callback) return ContentService.createTextOutput(callback + '(' + jd + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
          return ContentService.createTextOutput(jd).setMimeType(ContentService.MimeType.JSON);
        }
      }
    }

    var fechaDate = new Date(fechaGasto + 'T12:00:00');
    var mes  = isNaN(fechaDate.getTime()) ? '' : (fechaDate.getMonth() + 1);
    var anio = isNaN(fechaDate.getTime()) ? year : fechaDate.getFullYear();

    var fila = new Array(EGRESOS_NCOLS);
    for (var x = 0; x < EGRESOS_NCOLS; x++) fila[x] = '';
    fila[COL_E.ID - 1]          = id;
    fila[COL_E.FECHA_REG - 1]   = fechaReg;
    fila[COL_E.ESTADO - 1]      = 'registrado';
    fila[COL_E.FECHA_GASTO - 1] = fechaGasto;
    fila[COL_E.MES - 1]         = mes;
    fila[COL_E.ANIO - 1]        = anio;
    fila[COL_E.SUBTOTAL - 1]    = subtotal || '';
    fila[COL_E.ITBMS - 1]       = itbms    || '';
    fila[COL_E.TOTAL - 1]       = total    || '';
    fila[COL_E.MONEDA - 1]      = 'USD';
    fila[COL_E.TIPO_EGRESO - 1] = params.tipo        || 'costo_operativo';
    fila[COL_E.CATEGORIA - 1]   = params.categoria   || '';
    fila[COL_E.PROVEEDOR - 1]   = params.proveedor   || '';
    fila[COL_E.RUC_PROV - 1]    = params.ruc_prov    || '';
    fila[COL_E.DV_PROV - 1]     = params.dv_prov     || '';
    fila[COL_E.NFACTURA - 1]    = params.num_fac     || '';
    fila[COL_E.ID_ITEM_CV - 1]  = '';
    fila[COL_E.DRIVE_URL - 1]   = params.driveUrl    || '';
    fila[COL_E.DESCRIPCION - 1] = params.descripcion || '';
    fila[COL_E.NOTAS - 1]       = params.notas       || '';

    var newRow = sheet.getLastRow() + 1;
    sheet.getRange(newRow, 1, 1, EGRESOS_NCOLS).setValues([fila]);
    sheet.getRange(newRow, COL_E.SUBTOTAL, 1, 3).setNumberFormat('#,##0.00');
    sheet.getRange(newRow, 1, 1, EGRESOS_NCOLS).setBackground('#F5F5F5');

    result.success  = true;
    result.egresoId = id;
    Logger.log('✅ Egreso registrado: ' + id + ' | ' + (params.proveedor || '') + ' | $' + total);
  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleRegistrarEgresoOperativo: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════
//  _handleMoverAInventario
// ═══════════════════════════════════════════════════════════════

function _handleMoverAInventario(params, callback) {
  var result = { success: false, egresoId: null, error: null };
  try {
    var idItem = params.id_item || '';
    if (!idItem) throw new Error('id_item requerido');

    var ss      = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheetCV = ss.getSheetByName(SHEET_CV);
    if (!sheetCV) throw new Error('Hoja Compras_Ventas no encontrada');

    var data  = sheetCV.getDataRange().getValues();
    var found = false;

    for (var i = 2; i < data.length; i++) {
      if (String(data[i][COL_CV.ID_ITEM - 1]) !== String(idItem)) continue;

      var rowNum       = i + 1;
      var estadoActual = String(data[i][COL_CV.ESTADO - 1] || '').trim();
      if (estadoActual !== 'pendiente') {
        throw new Error('Solo se pueden mover ítems en estado "pendiente". Estado actual: ' + estadoActual);
      }

      var cantidad = parseInt(params.cantidad || '1') || 1;
      var notas    = params.notas || '';
      var stamp    = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm');

      sheetCV.getRange(rowNum, COL_CV.ESTADO).setValue('inventario');
      sheetCV.getRange(rowNum, COL_CV.CANTIDAD).setValue(cantidad);
      sheetCV.getRange(rowNum, 1, 1, 28).setBackground('#E3F2FD');

      var notaActual = String(sheetCV.getRange(rowNum, COL_CV.NOTAS).getValue() || '');
      var notaNueva  = 'Movido a inventario: ' + stamp + ' | cant: ' + cantidad;
      if (notas) notaNueva += ' | ' + notas;
      sheetCV.getRange(rowNum, COL_CV.NOTAS).setValue(
        notaActual ? notaActual + ' | ' + notaNueva : notaNueva
      );

      // ── Crear egreso de costo_mercancia ─────────────────────
      var sheetEgr    = _initEgresosSheet(ss);
      var ahora       = new Date();
      var totalCarb   = parseFloat(data[i][COL_CV.TOTAL_CARBONE - 1] || '0') || 0;
      var descripProd = String(data[i][COL_CV.DESCRIPCION_PROD - 1]  || '');
      var numFacCarb  = String(data[i][COL_CV.NUM_FAC_CARBONE - 1]   || '');
      var driveCarb   = String(data[i][COL_CV.DRIVE_URL_CARB - 1]    || '');

      var fechaCompra = data[i][COL_CV.FECHA_COMPRA - 1];
      if (fechaCompra instanceof Date) {
        fechaCompra = Utilities.formatDate(fechaCompra, 'America/Panama', 'yyyy-MM-dd');
      } else {
        fechaCompra = String(fechaCompra || '').slice(0, 10);
      }

      var yearEgr = new Date((fechaCompra || ahora.toISOString().slice(0,10)) + 'T12:00:00').getFullYear() || ahora.getFullYear();

      var lastEgr = sheetEgr.getLastRow();
      var seqEgr  = 1;
      if (lastEgr > 2) {
        var idsEgr = sheetEgr.getRange(3, COL_E.ID, lastEgr - 2, 1).getValues();
        for (var ke = idsEgr.length - 1; ke >= 0; ke--) {
          var ve     = String(idsEgr[ke][0] || '');
          var partsE = ve.split('-');
          var ne     = parseInt(partsE[partsE.length - 1], 10);
          if (!isNaN(ne)) { seqEgr = ne + 1; break; }
        }
      }
      var egresoId = 'EGR-RP-' + yearEgr + '-' + String(seqEgr).padStart(4, '0');

      var fechaCompraDate = new Date((fechaCompra || ahora.toISOString().slice(0,10)) + 'T12:00:00');
      var mesEgr  = isNaN(fechaCompraDate.getTime()) ? '' : (fechaCompraDate.getMonth() + 1);
      var anioEgr = isNaN(fechaCompraDate.getTime()) ? yearEgr : fechaCompraDate.getFullYear();

      var subCarb  = totalCarb > 0 ? parseFloat((totalCarb / 1.07).toFixed(2)) : '';
      var itbsCarb = totalCarb > 0 ? parseFloat((totalCarb - totalCarb / 1.07).toFixed(2)) : '';

      var filaEgr = new Array(EGRESOS_NCOLS);
      for (var xe = 0; xe < EGRESOS_NCOLS; xe++) filaEgr[xe] = '';

      filaEgr[COL_E.ID - 1]          = egresoId;
      filaEgr[COL_E.FECHA_REG - 1]   = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
      filaEgr[COL_E.ESTADO - 1]      = 'registrado';
      filaEgr[COL_E.FECHA_GASTO - 1] = fechaCompra || Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd');
      filaEgr[COL_E.MES - 1]         = mesEgr;
      filaEgr[COL_E.ANIO - 1]        = anioEgr;
      filaEgr[COL_E.SUBTOTAL - 1]    = subCarb;
      filaEgr[COL_E.ITBMS - 1]       = itbsCarb;
      filaEgr[COL_E.TOTAL - 1]       = totalCarb || '';
      filaEgr[COL_E.MONEDA - 1]      = 'USD';
      filaEgr[COL_E.TIPO_EGRESO - 1] = 'costo_mercancia';
      filaEgr[COL_E.CATEGORIA - 1]   = 'Inventario';
      filaEgr[COL_E.PROVEEDOR - 1]   = 'Empresas Carbone S.A.';
      filaEgr[COL_E.RUC_PROV - 1]    = '1080323-1-554308';
      filaEgr[COL_E.DV_PROV - 1]     = '54';
      filaEgr[COL_E.NFACTURA - 1]    = numFacCarb;
      filaEgr[COL_E.ID_ITEM_CV - 1]  = idItem;
      filaEgr[COL_E.DRIVE_URL - 1]   = driveCarb;
      filaEgr[COL_E.DESCRIPCION - 1] = descripProd + (cantidad > 1 ? ' ×' + cantidad : '');
      filaEgr[COL_E.NOTAS - 1]       = 'Ingreso a inventario · Cant: ' + cantidad;

      var newEgrRow = sheetEgr.getLastRow() + 1;
      sheetEgr.getRange(newEgrRow, 1, 1, EGRESOS_NCOLS).setValues([filaEgr]);
      sheetEgr.getRange(newEgrRow, COL_E.SUBTOTAL, 1, 3).setNumberFormat('#,##0.00');
      sheetEgr.getRange(newEgrRow, 1, 1, EGRESOS_NCOLS).setBackground('#FFF3E0');

      result.success  = true;
      result.egresoId = egresoId;
      found = true;
      Logger.log('✅ Ítem ' + idItem + ' → inventario | Egreso: ' + egresoId);
      break;
    }

    if (!found && !result.error) throw new Error('Ítem no encontrado: ' + idItem);

  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleMoverAInventario: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════
//  _handleGetIngresos  ← FIX: fecha_reg serializada correctamente
// ═══════════════════════════════════════════════════════════════

function _handleGetIngresos(params, callback) {
  var result = { success: false, items: [], error: null };
  try {
    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(CONFIG.SHEET_INGRESOS);

    if (!sheet || sheet.getLastRow() <= 2) {
      result.success = true;
      var json0 = JSON.stringify(result);
      if (callback) return ContentService.createTextOutput(callback + '(' + json0 + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
      return ContentService.createTextOutput(json0).setMimeType(ContentService.MimeType.JSON);
    }

    var numIngRows = sheet.getLastRow() - 2;
    var data  = sheet.getRange(3, 1, numIngRows, INGRESOS_NCOLS).getValues();
    var items = [];

    for (var i = 0; i < data.length; i++) {
      var r = data[i];
      if (!r[COL_I.ID_TRANS - 1]) continue;

      var fechaIngreso = r[COL_I.FECHA_INGRESO - 1];
      if (fechaIngreso instanceof Date) {
        fechaIngreso = Utilities.formatDate(fechaIngreso, 'America/Panama', 'yyyy-MM-dd');
      } else {
        fechaIngreso = String(fechaIngreso || '').slice(0, 10);
      }

      var fechaReg = r[COL_I.FECHA_REG - 1];
      if (fechaReg instanceof Date) {
        fechaReg = Utilities.formatDate(fechaReg, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
      } else {
        fechaReg = String(fechaReg || '');
      }

      items.push({
        id_trans:          r[COL_I.ID_TRANS - 1],
        fecha_reg:         fechaReg,
        estado:            String(r[COL_I.ESTADO - 1]       || '').toLowerCase(),
        confianza_ia:      r[COL_I.CONFIANZA_IA - 1],
        fecha_ingreso:     fechaIngreso,
        mes:               r[COL_I.MES - 1],
        anio_fiscal:       r[COL_I.ANIO_FISCAL - 1],
        subtotal:          parseFloat(r[COL_I.SUBTOTAL - 1])  || 0,
        itbms:             parseFloat(r[COL_I.ITBMS - 1])     || 0,
        total:             parseFloat(r[COL_I.TOTAL - 1])      || 0,
        moneda:            r[COL_I.MONEDA - 1]       || 'USD',
        tipo_ingreso:      r[COL_I.TIPO_INGRESO - 1] || '',
        categoria_ingreso: r[COL_I.CATEGORIA - 1]    || '',
        nombre_cliente:    r[COL_I.NOMBRE_CLI - 1]   || '',
        ruc_cliente:       r[COL_I.RUC_CLI - 1]      || '',
        tipo_persona:      r[COL_I.TIPO_PERSONA - 1] || '',
        num_factura:       r[COL_I.NUM_FACTURA - 1]  || '',
        tipo_comprobante:  r[COL_I.TIPO_COMP - 1]    || '',
        drive_url:         r[COL_I.DRIVE_URL - 1]    || '',
        descripcion:       r[COL_I.DESCRIPCION - 1]  || '',
        notas:             r[COL_I.NOTAS_INT - 1]    || '',
        flag_revision:     r[COL_I.FLAG_REV - 1]     || false,
        _row:              i + 3,
      });
    }

    items.sort(function(a, b) {
      return String(b.fecha_ingreso).localeCompare(String(a.fecha_ingreso));
    });

    result.success = true;
    result.items   = items;
  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleGetIngresos: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════
//  _handleRegistrarIngresoManual
// ═══════════════════════════════════════════════════════════════

function _handleRegistrarIngresoManual(params, callback) {
  var result = { success: false, ingresoId: null, error: null };
  try {
    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(CONFIG.SHEET_INGRESOS);
    if (!sheet) throw new Error('Hoja Ingresos no encontrada. Ejecuta initSheets() primero.');

    var ahora        = new Date();
    var fechaReg     = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
    var fechaIngreso = params.fecha || Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd');

    var total    = parseFloat(params.total)    || 0;
    var itbms    = parseFloat(params.itbms)    || 0;
    var subtotal = parseFloat(params.subtotal) || parseFloat((total - itbms).toFixed(2));
    var mes      = new Date(fechaIngreso + 'T12:00:00').getMonth() + 1;
    var anio     = new Date(fechaIngreso + 'T12:00:00').getFullYear();

    var id = 'ING-RP-' + Utilities.formatDate(ahora, 'America/Panama', 'yyyyMMddHHmmss') + '-M';

    var nombreCli  = params.nombre      || '';
    var rucCli     = params.ruc         || '';
    var dvCli      = params.dv          || '';
    var numFactura = params.num_factura || '';

    var catUnificada = params.categoria || 'venta_producto_gravado';
    var mapaTipo = {
      'venta_producto_gravado':   'venta_producto',
      'venta_producto_exento':    'venta_producto',
      'servicio_tecnico_gravado': 'servicio_tecnico',
      'servicio_tecnico_exento':  'servicio_tecnico',
      'asesoria_consultoria':     'servicio_asesoria',
      'comision':                 'comision',
      'exportacion':              'exportacion',
      'otro_gravado':             'otro',
      'otro_exento':              'otro',
    };
    var tipoIng = mapaTipo[catUnificada] || 'venta_producto';

    // Duplicate check
    if (numFactura && nombreCli) {
      var lastRow = sheet.getLastRow();
      if (lastRow > 2) {
        var existing = sheet.getRange(3, 1, lastRow - 2, INGRESOS_NCOLS).getValues();
        var refNueva = String(numFactura).trim();
        var cliNuevo = String(nombreCli).trim().toUpperCase();
        for (var d = 0; d < existing.length; d++) {
          var refExist = String(existing[d][COL_I.NUM_FACTURA - 1] || '').trim();
          var cliExist = String(existing[d][COL_I.NOMBRE_CLI - 1]  || '').trim().toUpperCase();
          if (refExist === refNueva && cliExist === cliNuevo) {
            result.error = 'DUPLICADO: Ya existe un ingreso del cliente "' + nombreCli +
                           '" con referencia "' + numFactura + '".';
            var jd = JSON.stringify(result);
            if (callback) return ContentService.createTextOutput(callback + '(' + jd + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
            return ContentService.createTextOutput(jd).setMimeType(ContentService.MimeType.JSON);
          }
        }
      }
    }

    var fila = new Array(INGRESOS_NCOLS);
    for (var xi = 0; xi < INGRESOS_NCOLS; xi++) fila[xi] = '';
    fila[COL_I.ID_TRANS - 1]      = id;
    fila[COL_I.FECHA_REG - 1]     = fechaReg;
    fila[COL_I.ESTADO - 1]        = 'confirmado';
    fila[COL_I.CONFIANZA_IA - 1]  = 'manual';
    fila[COL_I.FECHA_INGRESO - 1] = fechaIngreso;
    fila[COL_I.MES - 1]           = mes;
    fila[COL_I.ANIO_FISCAL - 1]   = anio;
    fila[COL_I.SUBTOTAL - 1]      = subtotal || '';
    fila[COL_I.ITBMS - 1]         = itbms    || '';
    fila[COL_I.TOTAL - 1]         = total    || '';
    fila[COL_I.MONEDA - 1]        = 'USD';
    fila[COL_I.TIPO_INGRESO - 1]  = tipoIng;
    fila[COL_I.CATEGORIA - 1]     = catUnificada;
    fila[COL_I.EXENTO_FRM93 - 1]  = '';
    fila[COL_I.NOMBRE_CLI - 1]    = nombreCli;
    fila[COL_I.RUC_CLI - 1]       = rucCli;
    fila[COL_I.TIPO_PERSONA - 1]  = detectarTipoPersona(rucCli);
    fila[COL_I.NUM_FACTURA - 1]   = numFactura;
    fila[COL_I.TIPO_COMP - 1]     = params.tipo_comprobante || 'manual';
    fila[COL_I.DRIVE_URL - 1]     = '';
    fila[COL_I.DRIVE_PATH - 1]    = '';
    fila[COL_I.DESCRIPCION - 1]   = params.descripcion || '';
    fila[COL_I.NOTAS_INT - 1]     = params.notas       || '';
    fila[COL_I.FLAG_REV - 1]      = false;

    var newRow = sheet.getLastRow() + 1;
    sheet.getRange(newRow, 1, 1, INGRESOS_NCOLS).setValues([fila]);
    sheet.getRange(newRow, COL_I.SUBTOTAL, 1, 3).setNumberFormat('#,##0.00');
    sheet.getRange(newRow, 1, 1, INGRESOS_NCOLS).setBackground('#F1F8E9');

    result.success   = true;
    result.ingresoId = id;
    Logger.log('✅ Ingreso manual: ' + id + ' | ' + nombreCli + ' | $' + total);
  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleRegistrarIngresoManual: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════
//  _handleParseFacturaEgreso
// ═══════════════════════════════════════════════════════════════

function _handleParseFacturaEgreso(data) {
  try {
    var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
    if (!apiKey) throw new Error('CLAUDE_API_KEY no configurada en Script Properties');

    var b64      = data.imageBase64 || '';
    var mimeType = data.mimeType    || 'image/jpeg';
    if (!b64) throw new Error('imageBase64 requerido');

    if (mimeType === 'application/octet-stream') mimeType = 'image/jpeg';

    var contentBlock;
    if (mimeType === 'application/pdf') {
      contentBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
    } else {
      var validImg = ['image/jpeg','image/png','image/webp','image/gif'];
      var imgMime  = validImg.indexOf(mimeType) >= 0 ? mimeType : 'image/jpeg';
      contentBlock = { type: 'image', source: { type: 'base64', media_type: imgMime, data: b64 } };
    }

    var prompt =
      'Eres un extractor de datos de facturas panameñas (DGI e-Tax 2.0 y facturas tradicionales). ' +
      'Analiza esta factura y responde SOLO con JSON válido, sin markdown ni texto adicional:\n' +
      '{"num_factura":"","fecha":"YYYY-MM-DD","proveedor":"","ruc_proveedor":"","dv_proveedor":"","subtotal":0,"itbms":0,"total":0,' +
      '"items":[{"descripcion":"","cantidad":1,"precio_unitario":0,"itbms":0,"total":0}]}\n' +
      '\nREGLAS IMPORTANTES:\n' +
      '1. proveedor = nombre del EMISOR (cabecera superior), NO del receptor/cliente\n' +
      '2. ruc_proveedor = RUC del emisor. En facturas DGI panameñas aparece en la cabecera como:\n' +
      '   "N-20-606 DV 09"  → ruc_proveedor="N-20-606", dv_proveedor="09"\n' +
      '   "8-517-1400 DV 85" → ruc_proveedor="8-517-1400", dv_proveedor="85"\n' +
      '3. dv_proveedor = SOLO el número después de "DV" — extraer siempre, nunca dejar null si hay RUC\n' +
      '4. fecha en formato YYYY-MM-DD\n' +
      '5. subtotal = monto antes de ITBMS | itbms = impuesto 7% | total = monto final\n' +
      '6. items[].descripcion: si todos los ítems dicen lo mismo genérico (ej: "FERRETERIA"),\n' +
      '   usa "proveedor — categoría" (ej: "King Chan — Ferretería materiales"). NO repitas.\n' +
      '7. Montos como números, no strings. null solo si el campo realmente no existe.';

    var payload = {
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role:    'user',
        content: [ contentBlock, { type: 'text', text: prompt } ]
      }]
    };

    var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method:          'post',
      contentType:     'application/json',
      headers:         { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      payload:         JSON.stringify(payload),
      muteHttpExceptions: true,
    });

    var code = response.getResponseCode();
    if (code !== 200) {
      throw new Error('Claude API error ' + code + ': ' + response.getContentText().substring(0, 200));
    }

    var respData = JSON.parse(response.getContentText());
    var text     = '';
    var content  = respData.content || [];
    for (var i = 0; i < content.length; i++) {
      if (content[i].type === 'text') { text = content[i].text; break; }
    }

    var parsed = JSON.parse(text.replace(/```json|```/g, '').trim());

    return ContentService
      .createTextOutput(JSON.stringify({
        success:       true,
        num_factura:   parsed.num_factura   || null,
        fecha:         parsed.fecha         || null,
        proveedor:     parsed.proveedor     || null,
        ruc_proveedor: parsed.ruc_proveedor || null,
        dv_proveedor:  parsed.dv_proveedor  || null,
        subtotal:      parsed.subtotal      || null,
        itbms:         parsed.itbms         || null,
        total:         parsed.total         || null,
        items:         Array.isArray(parsed.items) ? parsed.items : [],
      }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log('Error _handleParseFacturaEgreso: ' + err.message);
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ═══════════════════════════════════════════════════════════════
//  _handleParseComprobanteIngreso
// ═══════════════════════════════════════════════════════════════

function _handleParseComprobanteIngreso(data) {
  try {
    var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
    if (!apiKey) throw new Error('CLAUDE_API_KEY no configurada en Script Properties');

    var b64      = data.imageBase64 || '';
    var mimeType = data.mimeType    || 'image/jpeg';
    if (!b64) throw new Error('imageBase64 requerido');

    if (mimeType === 'application/octet-stream') mimeType = 'image/jpeg';

    var contentBlock;
    if (mimeType === 'application/pdf') {
      contentBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
    } else {
      var validImg = ['image/jpeg','image/png','image/webp','image/gif'];
      var imgMime  = validImg.indexOf(mimeType) >= 0 ? mimeType : 'image/jpeg';
      contentBlock = { type: 'image', source: { type: 'base64', media_type: imgMime, data: b64 } };
    }

    var prompt =
      'Eres un extractor de datos de comprobantes de pago panameños. ' +
      'Analiza esta imagen o documento y determina si es un:\n' +
      '  - voucher Yappy (app de pagos panameña)\n' +
      '  - comprobante de transferencia bancaria\n' +
      '  - factura comercial panameña (DGI e-Tax 2.0 u otra)\n\n' +
      'Responde SOLO con JSON válido, sin markdown ni texto adicional:\n' +
      '{\n' +
      '  "tipo_comprobante": "yappy" | "transferencia" | "factura" | "otro",\n' +
      '  "monto": "monto total en números con decimales, ej: 150.00",\n' +
      '  "fecha": "YYYY-MM-DD",\n' +
      '  "num_factura": "número de factura o referencia de transacción, null si no aplica",\n' +
      '  "nombre_pagador": "nombre completo de quien pagó (cliente)",\n' +
      '  "ruc_pagador": "RUC o cédula del pagador, null si no visible",\n' +
      '  "dv_pagador": "dígito verificador del RUC, null si no visible",\n' +
      '  "tiene_itbms": false,\n' +
      '  "descripcion": "descripción breve del concepto o producto, null si no aplica",\n' +
      '  "notas": "cualquier dato adicional relevante (banco origen, referencia, etc.)"\n' +
      '}\n\n' +
      'REGLAS:\n' +
      '1. Para Yappy: monto = lo que se pagó; nombre_pagador = quien envió el pago.\n' +
      '2. Para transferencias: incluir banco origen y referencia en notas.\n' +
      '3. Para facturas: tiene_itbms = true si el documento muestra ITBMS o impuesto del 7%.\n' +
      '4. fecha siempre en formato YYYY-MM-DD.\n' +
      '5. Si un campo no es visible, usa null (no inventar datos).';

    var payload = {
      model:      'claude-sonnet-4-20250514',
      max_tokens: 600,
      messages: [{
        role:    'user',
        content: [ contentBlock, { type: 'text', text: prompt } ]
      }]
    };

    var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method:             'post',
      contentType:        'application/json',
      headers:            { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      payload:            JSON.stringify(payload),
      muteHttpExceptions: true,
    });

    var code = response.getResponseCode();
    if (code !== 200) {
      throw new Error('Claude API error ' + code + ': ' + response.getContentText().substring(0, 200));
    }

    var respData = JSON.parse(response.getContentText());
    var text     = '';
    var content  = respData.content || [];
    for (var i = 0; i < content.length; i++) {
      if (content[i].type === 'text') { text = content[i].text; break; }
    }

    var parsed = JSON.parse(text.replace(/```json|```/g, '').trim());

    return ContentService
      .createTextOutput(JSON.stringify({
        success:          true,
        tipo_comprobante: parsed.tipo_comprobante || 'otro',
        monto:            parsed.monto            || null,
        fecha:            parsed.fecha            || null,
        num_factura:      parsed.num_factura      || null,
        nombre_pagador:   parsed.nombre_pagador   || null,
        ruc_pagador:      parsed.ruc_pagador      || null,
        dv_pagador:       parsed.dv_pagador       || null,
        tiene_itbms:      !!parsed.tiene_itbms,
        descripcion:      parsed.descripcion      || null,
        notas:            parsed.notas            || null,
      }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log('Error _handleParseComprobanteIngreso: ' + err.message);
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}