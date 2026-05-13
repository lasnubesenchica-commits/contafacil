// ═══════════════════════════════════════════════════════════════
//  BalanceClip — Backend de Órdenes + Ingresos + Egresos
//  Google Apps Script AUTO UPDATER WORKING
//  v12 — corregirComprobante añadido (PATCH)
//  v12.1 — actualizarNotasIngreso añadido (PATCH)
//  v12.2 — EGRESOS_NCOLS = 21, COL_E.ID_ST_ITEM = 21 (col U)
//           _initEgresosSheet: cabecera col U = id_st_item
//           _handleGetEgresos: expone id_st_item en respuestas
//  v12.3 — confirmarIngreso: cambia estado ingreso → 'confirmado'
//           al registrar pago completo del cliente en ST.
//           Actualiza drive_url si viene comprobante.
//  v12.5 — drive_url cross-reference desde Servicios_Tecnicos
//           _buildStUrlMaps: mapa ST → drive_url (factura emitida)
//                            mapa ST → drive_url (ítem impuesto DHL/FedEx)
//           _handleGetEgresos: usa stMap para costo_mercancia sin URL
//                              usa stImpMap para credito_fiscal sin URL
//           _handleGetIngresos: prefiere ST.drive_url (factura emitida)
//                               sobre drive_url del ingreso (puede ser voucher)
//  v12.7 — getConfig / guardarConfig para panel Setup de Operaciones
//  v12.6 — cross-reference preciso para credito_fiscal con múltiples FedEx
//           _buildStUrlMaps: mapa impMap = egreso_id → drive_url_factura courier
//           _extractNumFacBase: extrae num_factura normalizado desde notas
//           _handleGetEgresos: pre-índice "id_st|num_fac" → drive_url exacto
//                              fallback a stMap si no hay match preciso
// ═══════════════════════════════════════════════════════════════

// ── CONFIG ────────────────────────────────────────────────────
var CONFIG = {
  SHEET_ID:          '1UCV17jyqvwbiR6YyuUkvhhjPJrR_9Bh7w9XgSGRZkNk',
  SHEET_ORDENES:     'Ordenes',
  SHEET_INGRESOS:    'Ingresos',
  ADMIN_EMAIL:       'finanzas@contecpma.com',
  NEGOCIO:           'Consultores Electrotecnicos y Contratistas, S.A.',
  WA_NUM:            '50760909384',
  VOUCHER_FOLDER_ID: '1OiVyKh7HdyQUKPNB7EYu2UsOmdUCyyYd',
  ITBMS_RATE:        0.07,
  // RUC_CLIENTE se lee dinámicamente de Config_Operaciones (empresa_ruc) — no hardcodear aquí
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
  DV_CLI:       25,
  FACTURA_DATA: 26,   // JSON parseado de XML FE Panamá (v13.1)
};
var INGRESOS_NCOLS = 26;

// Columnas Tab Egresos (base 1) — 21 cols, 2 filas cabecera
// v12.2: añadida col U id_st_item (= 21)
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
  ID_ST_ITEM:  21,   // U  id_st_item  ← v12.2
  ALCANCE:     22,   // V  alcance     ← v13.0 ('negocio' | 'personal')
  FACTURA_DATA:23,   // W  factura_data ← v13.1 (JSON parseado XML FE Panamá)
};
var EGRESOS_NCOLS = 23;  // v13.1: era 22

// Columnas Compras_Ventas usadas por _handleCorregirComprobante
var _CC_DRIVE_URL_EMIT = 25;  // col Y — drive_url_emitida (= COL_CV.DRIVE_URL_EMIT)
var _CC_INGRESO_ID     = 27;  // col AA — ingreso_id (= COL_CV.INGRESO_ID)

// ═══════════════════════════════════════════════════════════════
//  XML FE PANAMÁ — Parser server-side (v13.1)
//  Espejo de _parseFeXml en frontend; produce el mismo shape
// ═══════════════════════════════════════════════════════════════

function _xmlGetAllByLocalName(root, localName) {
  var out = [];
  var d = root.getDescendants();
  for (var i = 0; i < d.length; i++) {
    var el = d[i].asElement();
    if (!el) continue;
    if (el.getName() === localName) out.push(el);
  }
  return out;
}
function _xmlFindFirst(parent, localName) {
  if (!parent) return null;
  var arr = _xmlGetAllByLocalName(parent, localName);
  return arr.length ? arr[0] : null;
}
function _xmlText(root, localName) {
  var arr = _xmlGetAllByLocalName(root, localName);
  return arr.length ? String(arr[0].getText() || '').trim() : '';
}
function _xmlChildText(parent, localName) {
  // Igual a _xmlText pero limitado al subárbol del parent
  if (!parent) return '';
  var d = parent.getDescendants();
  for (var i = 0; i < d.length; i++) {
    var el = d[i].asElement();
    if (!el) continue;
    if (el.getName() === localName) return String(el.getText() || '').trim();
  }
  return '';
}

function _parseFeXmlGas(xmlText) {
  var data = { emisor: {}, receptor: {}, items: [], totales: {}, meta: {} };
  if (!xmlText || typeof xmlText !== 'string') return data;
  try {
    var doc  = XmlService.parse(xmlText);
    var root = doc.getRootElement();
    function g(name) { return _xmlText(root, name); }

    data.meta.cufe     = g('dId') || g('dCUFE') || g('dNroAutFE');
    data.meta.nroFac   = g('dNroDF') || g('dNroFac');
    data.meta.fecha    = g('dFechaEm') || g('dFecFac');
    data.meta.tipo     = g('dTipoDF') || g('dTipFac') || '';
    data.meta.qrCode   = g('dQRCode');
    data.meta.authCode = g('dProtAut') || g('dCodProt');

    // ── Emisor: gEmis > dNombEm + gRucEmi(dRuc, dDV) ─────────────
    var gEmis   = _xmlFindFirst(root, 'gEmis');
    var gRucEmi = _xmlFindFirst(gEmis, 'gRucEmi');
    data.emisor.nombre = _xmlChildText(gEmis, 'dNombEm') || g('dNombEm') || g('dNomEmi');
    data.emisor.ruc    = _xmlChildText(gRucEmi, 'dRuc') || g('dRucEM') || g('dRucEmi');
    data.emisor.dv     = _xmlChildText(gRucEmi, 'dDV')  || g('dDvEm')  || g('dDvEmi');
    data.emisor.dir    = _xmlChildText(gEmis, 'dDirEm') || g('dDirEm') || g('dDirFis') || g('dDir');
    data.emisor.tel    = _xmlChildText(gEmis, 'dTfnEm') || _xmlChildText(gEmis, 'dTelEm') || g('dTelEm');
    data.emisor.email  = _xmlChildText(gEmis, 'dCorElectEmi') || _xmlChildText(gEmis, 'dEmailEm') || g('dEmailEm');

    // ── Receptor: gDatRec > dNombRec + gRucRec(dRuc, dDV) ────────
    var gDatRec = _xmlFindFirst(root, 'gDatRec');
    var gRucRec = _xmlFindFirst(gDatRec, 'gRucRec');
    data.receptor.nombre = _xmlChildText(gDatRec, 'dNombRec') || g('dNombRec') || g('dNomRec');
    data.receptor.ruc    = _xmlChildText(gRucRec, 'dRuc') || g('dRucRec');
    data.receptor.dv     = _xmlChildText(gRucRec, 'dDV')  || g('dDvRec');
    data.receptor.dir    = _xmlChildText(gDatRec, 'dDirecRec') || _xmlChildText(gDatRec, 'dDirRec') || g('dDirRec');

    var items = _xmlGetAllByLocalName(root, 'gItem');
    for (var k = 0; k < items.length; k++) {
      var el = items[k];
      data.items.push({
        desc:   _xmlChildText(el, 'dDescProd') || _xmlChildText(el, 'dDesItem') || _xmlChildText(el, 'dDescItem'),
        cant:   parseFloat(_xmlChildText(el, 'dCantCodInt') || _xmlChildText(el, 'dCant') || '1') || 1,
        prUnit: parseFloat(_xmlChildText(el, 'dPrUnit') || '0') || 0,
        total:  parseFloat(_xmlChildText(el, 'dValTotItem') || _xmlChildText(el, 'dPrItem') || '0') || 0,
        itbms:  parseFloat(_xmlChildText(el, 'dValITBMS') || '0') || 0,
      });
    }

    data.totales.neto  = parseFloat(g('dTotNeto')  || g('dSubTot')     || '0') || 0;
    data.totales.itbms = parseFloat(g('dTotITBMS') || g('dTotalITBMS') || '0') || 0;
    data.totales.total = parseFloat(g('dVTot')     || g('dTotalFac')   || '0') || 0;
    data.totales.desc  = parseFloat(g('dTotDesc')  || '0') || 0;
  } catch(e) {
    Logger.log('_parseFeXmlGas error: ' + e.message);
  }
  return data;
}

// Detecta si el blob/mime corresponde a XML
function _esXmlMime(mime, fileName) {
  var m  = String(mime || '').toLowerCase();
  var fn = String(fileName || '').toLowerCase();
  if (m === 'text/xml' || m === 'application/xml') return true;
  if (m === 'application/octet-stream' && fn.indexOf('.xml') === fn.length - 4) return true;
  return fn.indexOf('.xml') === fn.length - 4;
}

// Extiende el sheet a ncols columnas si tiene menos (migración lazy)
function _ensureSheetCols(sheet, ncols, headerLabel) {
  if (!sheet || !ncols) return;
  var cur = sheet.getMaxColumns();
  if (cur < ncols) sheet.insertColumnsAfter(cur, ncols - cur);
  if (headerLabel) {
    var hdr = sheet.getRange(2, ncols);
    if (!hdr.getValue()) {
      hdr.setValue(headerLabel).setBackground('#546E7A').setFontColor('#FFFFFF').setFontWeight('bold');
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  WEB APP ENTRY POINT — doPost
// ═══════════════════════════════════════════════════════════════

function doPost(e) {
  try {
    var data   = JSON.parse(e.postData.contents);
    var action = data.action || '';
    Logger.log('doPost action: ' + action + ' | id_item: ' + (data.id_item||''));

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

    // ── ADMIN: corregir comprobante de ítem cerrado ─────────────
    if (action === 'corregirComprobante') {
      return _handleCorregirComprobante(data);
    }

    // ── ADMIN: analizar factura de egreso con IA ────────────────
    if (action === 'parseFacturaEgreso') {
      return _handleParseFacturaEgreso(data);
    }

    // ── ADMIN: analizar comprobante de ingreso con IA ───────────
    // ── SERVICIOS TÉCNICOS ──────────────────────────────────────
    if (action === 'crearCotizacion')        return _handleCrearCotizacion(data);
    if (action === 'actualizarCotizacion')   return _handleActualizarCotizacion(data);
    if (action === 'agregarItemCotizacion')  return _handleAgregarItemCotizacion(data);
    if (action === 'registrarIngresoST')     return _handleRegistrarIngresoST(data);
    if (action === 'registrarEgresoST')      return _handleRegistrarEgresoST(data);
    if (action === 'parseComprobanteIngreso') {
      return _handleParseComprobanteIngreso(data);
    }
    // ── CONFIGURACIÓN OPERACIONES ──────────────────────────────
    if (action === 'guardarConfig') return _handleGuardarConfig(data);
    if (action === 'inicializarSistema') return _handleInicializarSistema(data, '');
    if (action === 'installSyncTrigger') return _handleInstallUnifiedSyncTrigger(data, '');
    if (action === 'healthCheck')        return _handleHealthCheck(data, '');
    if (action === 'enviarOnboarding')   return _handleEnviarOnboarding(data);
    if (action === 'runSyncNow')         return _handleRunSyncNow(data, '');
    if (action === 'getConfigSummary')   return _handleGetConfigSummary(data, '');
    // ── PROVEEDORES ────────────────────────────────────────────
    if (action === 'analizarFacturaEjemplo') return _handleAnalizarFacturaEjemplo(data);
    if (action === 'guardarProveedor')       return _handleGuardarProveedor(data);

    // ── ACTUALIZAR ITEMS ────────────────────────────────────────────
    if (action === 'actualizarItemTipo') return _handleActualizarItemTipo(data);
    if (action === 'actualizarEgresoST') return _handleActualizarEgresoST(data);

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
      var pagoParams = {
        id_item:    data.id_item    || '',
        forma_pago: data.forma_pago || '',
        driveUrl:   driveUrlPago,
        callback:   '',
      };
      return _handleRegistrarPagoOperacion(pagoParams, '');
    }

    // ── PLANILLA ────────────────────────────────────────────────
    if (action === 'guardarEmpleado')    return _handleGuardarEmpleado(data);
    if (action === 'registrarPlanilla')  return _handleRegistrarPlanilla(data);
    if (action === 'desactivarEmpleado') return _handleDesactivarEmpleado(data);

    // ── ACREEDORES ───────────────────────────────────────────────
    if (action === 'guardarAcreedor')            return _handleGuardarAcreedor(data);
    if (action === 'analizarFacturaAcreedor')    return _handleAnalizarFacturaAcreedor(data);
    if (action === 'actualizarPendienteAcr')     return _handleActualizarPendienteAcr(data);
    if (action === 'guardarPreferenciaAcreedor') return _handleGuardarPreferencia(data);
    if (action === 'resetLabelsAcreedores')      return _handleResetLabelsAcreedores(data);
    if (action === 'subirFacturaEgreso')         return _handleSubirFacturaEgreso(data);
    if (action === 'subirFacturaIngreso')         return _handleSubirFacturaIngreso(data);
    if (action === 'importarFacturaGmail')        return _handleImportarFacturaGmail(data);
    if (action === 'importarHistorialGmail')      return _handleImportarHistorialGmail(data);
    if (action === 'procesarEmailGmail')          return _handleProcesarEmailGmail(data);
    if (action === 'categorizarEmailsGmail')      return _handleCategorizarEmailsGmail(data);
    if (action === 'categorizarTransaccionesOFX') return _handleCategorizarTransaccionesOFX(data);
    if (action === 'importarLoteOFX')             return _handleImportarLoteOFX(data);

    // ── AUTH (password global) ──────────────────────────────────
    if (action === 'verifyPassword')              return _handleVerifyPassword(data);
    if (action === 'setPassword')                 return _handleSetPassword(data);
    if (action === 'resetPassword')               return _handleResetPassword(data);

    // ── REPORTES por email ──────────────────────────────────────
    if (action === 'enviarReporteCierre')         return _handleEnviarReporteCierre(data);

    // ── TRIGGERS de sincronización ──────────────────────────────
    // (handlers definidos en ContaFacil_Operaciones.js — los exponemos aquí
    // porque Code.js es el único entry point real de doPost)
    if (action === 'instalarTriggerOp')           return _handleInstalarTriggerOp(data);
    if (action === 'removerTriggerOp')            return _handleRemoverTriggerOp(data);
    if (action === 'instalarTriggerST')           return _handleInstalarTriggerST(data);
    if (action === 'removerTriggerST')            return _handleRemoverTriggerST(data);

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

    var ingresoId = String(sheet.getRange(found, COL_O.INGRESO_ID).getValue() || '').trim();
    if (ingresoId) {
      try {
        var ssIng    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
        var sheetIng = ssIng.getSheetByName(CONFIG.SHEET_INGRESOS);
        if (sheetIng && sheetIng.getLastRow() > 2) {
          var ingData = sheetIng.getRange(3, 1, sheetIng.getLastRow() - 2, INGRESOS_NCOLS).getValues();
          for (var ai = 0; ai < ingData.length; ai++) {
            if (String(ingData[ai][COL_I.ID_TRANS - 1]) === ingresoId) {
              var ingRow = ai + 3;
              sheetIng.getRange(ingRow, COL_I.ESTADO).setValue('anulado');
              sheetIng.getRange(ingRow, 1, 1, INGRESOS_NCOLS).setBackground('#FFEBEE');
              var notaIng  = String(sheetIng.getRange(ingRow, COL_I.NOTAS_INT).getValue() || '');
              var stampIng = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm');
              sheetIng.getRange(ingRow, COL_I.NOTAS_INT).setValue(
                notaIng + ' | ANULADO por cancelación de orden: ' + stampIng
              );
              Logger.log('✅ Ingreso anulado por cancelación: ' + ingresoId);
              break;
            }
          }
        }
      } catch(anulErr) {
        Logger.log('⚠️ Error anulando ingreso ' + ingresoId + ': ' + anulErr.message);
      }
    }
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
    if (action === 'anularRegistro')      return _handleAnularRegistro(params, callback);
    if (action === 'eliminarRegistro')    return _handleEliminarRegistro(params, callback);
    if (action === 'actualizarCategoria')        return _handleActualizarCategoria(params, callback);
    if (action === 'actualizarCategoriaEgreso')  return _handleActualizarCategoria({ tipo:'egreso', id: params.id, categoria: params.categoria }, callback);
    if (action === 'reclasificarEgreso')   return _handleReclasificarEgreso(params, callback);
    if (action === 'getCatalogoGastos')    return _handleGetCatalogoGastos(params, callback);
    if (action === 'sincronizarEmails')        return _handleSincronizar(params, callback);
    if (action === 'getComprasVentas')         return _handleGetComprasVentas(params, callback);
    if (action === 'aprobarMatch')             return _handleAprobarMatch(params, callback);
    if (action === 'registrarVentaDirecta')    return _handleRegistrarVentaDirecta(params, callback);
    if (action === 'analizarFacturaPendiente') return _handleAnalizarFacturaPendiente(params, callback);
    if (action === 'buscarOrdenWeb')           return _handleBuscarOrdenWeb(params, callback);
    if (action === 'vincularOrdenWeb')         return _handleVincularOrdenWeb(params, callback);
    if (action === 'moverAInventario')         return _handleMoverAInventario(params, callback);
    if (action === 'registrarEgresoOperativo') return _handleRegistrarEgresoOperativo(params, callback);
    if (action === 'marcarCostoOperativo')     return _handleMarcarCostoOperativo(params, callback);
    if (action === 'registrarPagoOperacion')   return _handleRegistrarPagoOperacion(params, callback);
    if (action === 'getEgresos')               return _handleGetEgresos(params, callback);
    if (action === 'getIngresos')              return _handleGetIngresos(params, callback);
    if (action === 'getPL')                    return _handleGetPL(params, callback);
    if (action === 'registrarIngresoManual')   return _handleRegistrarIngresoManual(params, callback);
    if (action === 'actualizarIngreso')        return _handleActualizarIngreso(params, callback);
    if (action === 'actualizarNotasIngreso')   return _handleActualizarNotasIngreso(params, callback);
    if (action === 'confirmarIngreso')         return _handleConfirmarIngreso(params, callback);
    // ── SERVICIOS TÉCNICOS ──────────────────────────────────────
    if (action === 'getCotizaciones')        return _handleGetCotizaciones(params, callback);
    if (action === 'aprobarCotizacion')      return _handleAprobarCotizacion(params, callback);
    if (action === 'iniciarEjecucion')       return _handleIniciarEjecucion(params, callback);
    if (action === 'cerrarST')               return _handleCerrarST(params, callback);
    if (action === 'cancelarST')             return _handleCancelarST(params, callback);
    if (action === 'getResumenST')           return _handleGetResumenST(params, callback);
    if (action === 'enviarCotizacionEmail')  return _handleEnviarCotizacionEmail(params, callback);
    if (action === 'eliminarItemCotizacion') return _handleEliminarItemCotizacion(params, callback);
    if (action === 'actualizarDatosST')      return _handleActualizarDatosST(params, callback);
    if (action === 'sincronizarEmailsST')    return _handleSincronizarEmailsST(params, callback);
    // ── CONFIGURACIÓN OPERACIONES ──────────────────────────────
    if (action === 'getConfig')      return _handleGetConfigPublic(params, callback);
    if (action === 'healthCheck')    return _handleGetConfigPublic(params, callback);
    if (action === 'anularItemCV')   return _handleAnularItemCV(params, callback);
    if (action === 'eliminarItemCV') return _handleEliminarItemCV(params, callback);
    // ── PROVEEDORES ─────────────────────────────────────────────
    if (action === 'getProveedores')  return _handleGetProveedores(params, callback);
    if (action === 'toggleProveedor') return _handleToggleProveedor(params, callback);
    // ── INVENTARIO ──────────────────────────────────────────────
    if (action === 'getInventario')       return _handleGetInventario(params, callback);
    if (action === 'getMovimientosInv')   return _handleGetMovimientosInv(params, callback);
    if (action === 'registrarEntradaInv') return _handleRegistrarEntradaInv(params, callback);
    if (action === 'ajustarInventario')   return _handleAjustarInventario(params, callback);
    // ── ELIMINAR ST ─────────────────────────────────────────────
    if (action === 'eliminarST') return _handleEliminarST(params, callback);
    // ── PLANILLA ────────────────────────────────────────────────
    if (action === 'getEmpleados')       return _handleGetEmpleados(params, callback);
    if (action === 'getPlanillaPreview') return _handleGetPlanillaPreview(params, callback);

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

    // ── ACREEDORES ───────────────────────────────────────────────
    if (action === 'getAcreedores')         return _handleGetAcreedores(params, callback);
    if (action === 'toggleAcreedor')        return _handleToggleAcreedor(params, callback);
    if (action === 'getPendientesAcreedor') return _handleGetPendientesAcreedor(params, callback);
    if (action === 'aprobarAcreedor')       return _handleAprobarAcreedor(params, callback);
    if (action === 'rechazarAcreedor')      return _handleRechazarAcreedor(params, callback);
    if (action === 'eliminarPendienteAcr')  return _handleEliminarPendienteAcr(params, callback);
    if (action === 'sincronizarAcreedores') return _handleSincronizarAcreedores(params, callback);
    if (action === 'verificarReenvioGmail') return _handleVerificarReenvioGmail(params, callback);
    if (action === 'getCategorias')         return _handleGetCategorias(params, callback);

    // ── INICIALIZACIÓN ──────────────────────────────────────────
    if (action === 'inicializarSistema')              return _handleInicializarSistema(params, callback);
    if (action === 'installSyncTrigger')              return _handleInstallUnifiedSyncTrigger(params, callback);
    if (action === 'healthCheck')                     return _handleHealthCheck(params, callback);
    if (action === 'runSyncNow')                      return _handleRunSyncNow(params, callback);
    if (action === 'getConfigSummary')                return _handleGetConfigSummary(params, callback);
    if (action === 'instalarTriggerComercializacion') return _handleInstalarTriggerOp({ intervalo: params.intervalo || '15' });
    if (action === 'instalarTriggerProyectos')        return _handleInstalarTriggerST({ intervalo: params.intervalo || '15' });
    if (action === 'instalarTriggerAcreedores')       return _handleInstalarTriggerAcr({ intervalo: params.intervalo || '15' });

    // ── Estado de triggers (consumido por panel Sistema) ────────
    if (action === 'estadoTriggerOp')                 return _handleEstadoTriggerOp(params, callback);
    if (action === 'estadoTriggerST')                 return _handleEstadoTriggerST(params, callback);

    // ── AUTH (estado público) ───────────────────────────────────
    if (action === 'getAuthState')                    return _handleGetAuthState(params, callback);

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
  fila[COL_I.TIPO_COMP - 1]     = orden.tipoComprobante || 'orden_web';
  fila[COL_I.DRIVE_URL - 1]     = orden.voucherUrl || '';
  fila[COL_I.DRIVE_PATH - 1]    = '';
  fila[COL_I.DESCRIPCION - 1]   = desc;
  fila[COL_I.NOTAS_INT - 1]     = notas;
  fila[COL_I.FLAG_REV - 1]      = String(orden.estadoPago) === 'parcial';
  fila[COL_I.DV_CLI - 1]        = orden.dv || '';

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
  row[COL_O.PAGADOR - 1]      = data.pagador        || '';
  row[COL_O.FECHA_PAGO - 1]   = data.fechaPago      || '';
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
    'CLASIF FISCAL','','','CLIENTE','','','COMPROBANTE','','','','NOTAS','','','','XML'
  ];
  var headers = [
    'id_transaccion','fecha_registro','estado','confianza_ia',
    'fecha_ingreso','mes','anio_fiscal',
    'subtotal','itbms','total','moneda',
    'tipo_ingreso','categoria_ingreso','concepto_exento_frm93',
    'nombre_cliente','ruc_cliente','tipo_persona_cliente',
    'num_factura','tipo_comprobante','drive_url','drive_path',
    'descripcion','notas_internas','flag_revision','dv_cliente','factura_data'
  ];

  sheet.getRange(1, 1, 1, INGRESOS_NCOLS).setValues([meta]);
  sheet.getRange(1, 1, 1, INGRESOS_NCOLS).setBackground('#37474F').setFontColor('#FFFFFF').setFontWeight('bold');
  sheet.getRange(2, 1, 1, INGRESOS_NCOLS).setValues([headers]);
  sheet.getRange(2, 1, 1, INGRESOS_NCOLS).setBackground('#546E7A').setFontColor('#FFFFFF').setFontWeight('bold');
  sheet.setFrozenRows(2);

  var w = [170,150,100,100,110,50,80,90,70,90,60,120,140,140,160,110,110,120,110,250,200,300,250,90,300];
  for (var i = 0; i < w.length; i++) sheet.setColumnWidth(i + 1, w[i]);
  sheet.getRange('H3:J1000').setNumberFormat('#,##0.00');
  Logger.log('✅ Hoja Ingresos creada.');
}

// v12.2: _initEgresosSheet actualizada — col U id_st_item añadida
function _initEgresosSheet(ss) {
  var existing = ss.getSheetByName(SHEET_EGRESOS);
  if (existing) return existing;

  var sheet = ss.insertSheet(SHEET_EGRESOS);
  SpreadsheetApp.flush();

  var meta = [
    'METADATA','','','FECHA','','','MONTOS','','','','CLASIFICACIÓN','',
    'PROVEEDOR','','','COMPROBANTE','','','NOTAS','','','','XML'
  ];
  var headers = [
    'id_egreso','fecha_registro','estado','fecha_egreso','mes','anio_fiscal',
    'subtotal','itbms','total','moneda',
    'tipo_egreso','categoria',
    'proveedor','ruc_proveedor','dv_proveedor',
    'num_factura_ref','id_item_cv','drive_url',
    'descripcion','notas','id_st_item','alcance','factura_data'
  ];

  sheet.getRange(1, 1, 1, EGRESOS_NCOLS).setValues([meta]);
  sheet.getRange(1, 1, 1, EGRESOS_NCOLS)
    .setBackground('#37474F').setFontColor('#FFFFFF').setFontWeight('bold');
  sheet.getRange(2, 1, 1, EGRESOS_NCOLS).setValues([headers]);
  sheet.getRange(2, 1, 1, EGRESOS_NCOLS)
    .setBackground('#546E7A').setFontColor('#FFFFFF').setFontWeight('bold');
  sheet.setFrozenRows(2);

  var widths = [180,150,100,110,50,80,90,70,90,60,120,130,200,130,80,140,160,260,300,220,160,100,300];
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

// Ejecutar una sola vez en el editor GAS para autorizar permisos,
// después el provisioner puede llamarlo vía ?action=inicializarSistema.
function inicializarSistema() {
  initSheets();
  initComprasVentasSheet();
  initConfigSheet();
  initProveedoresSheet();
  initSTSheets();
  initAcreedoresSheets();
  migrarEgresosDV();
  migrarEgresosST();
  installTrigger();
  Logger.log('✅ Sistema inicializado completamente.');
}

function _handleInicializarSistema(params, callback) {
  var result = { success: false, message: '', authResetToken: null };
  try {
    inicializarSistema();

    // Guardar credenciales del provisioner si vienen en el request.
    // El provisioner las pasa una sola vez al final del setup para
    // evitar que el admin tenga que entrar manualmente al editor GAS
    // a setear Script Properties después del deploy.
    var props = PropertiesService.getScriptProperties();
    if (params && params.claudeApiKey) {
      props.setProperty('CLAUDE_API_KEY', String(params.claudeApiKey));
    }
    if (params && params.authResetToken) {
      props.setProperty('AUTH_RESET_TOKEN', String(params.authResetToken));
    } else if (!props.getProperty('AUTH_RESET_TOKEN')) {
      // Auto-generar si no existe ni viene en params
      var generated = Utilities.getUuid().replace(/-/g, '');
      props.setProperty('AUTH_RESET_TOKEN', generated);
      result.authResetToken = generated;
    }

    result.success = true;
    result.message = 'Sistema inicializado correctamente.';
  } catch (e) {
    result.message = 'Error: ' + e.message;
    Logger.log('Error inicializarSistema: ' + e.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// ════════════════════════════════════════════════════════════════
//  HEALTH CHECK — verifica el estado del provisioning end-to-end.
//  Llamado por el provisioner (deploy.html) al final del setup para
//  confirmar que todo quedó conectado correctamente. Devuelve estado
//  por componente sin exponer secretos (solo "set"/"missing" para
//  Script Properties).
// ════════════════════════════════════════════════════════════════
function _handleHealthCheck(params, callback) {
  var result = {
    sheet:    { ok: false },
    drive:    { ok: false },
    gmail:    { ok: false },
    config:   { ok: false },
    triggers: [],
    scriptProperties: {},
    overall:  'unknown'
  };

  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    result.sheet.ok       = true;
    result.sheet.name     = ss.getName();
    result.sheet.tabCount = ss.getSheets().length;
  } catch (e) {
    result.sheet.error = e.message;
  }

  try {
    if (CONFIG.VOUCHER_FOLDER_ID) {
      var folder = DriveApp.getFolderById(CONFIG.VOUCHER_FOLDER_ID);
      result.drive.ok         = true;
      result.drive.folderName = folder.getName();
    } else {
      result.drive.error = 'VOUCHER_FOLDER_ID no configurado';
    }
  } catch (e) {
    result.drive.error = e.message;
  }

  try {
    var labels = GmailApp.getUserLabels();
    result.gmail.ok         = true;
    result.gmail.labelCount = labels.length;
  } catch (e) {
    result.gmail.error = e.message;
  }

  try {
    var cfg = _getConfig();
    result.config.ok                    = true;
    result.config.empresa_nombre        = cfg.empresa_nombre || '';
    result.config.forwarder             = cfg.email_acr_remitente || cfg.email_op_remitente || '';
    result.config.destino               = cfg.email_acr_destino || cfg.email_op_destino || '';
    result.config.flow_acreedor         = String(cfg.flow_acreedor || 'true').toLowerCase() !== 'false';
    result.config.flow_comercializacion = String(cfg.flow_comercializacion || 'false').toLowerCase() === 'true';
    result.config.email_acr_label       = cfg.email_acr_label || null;
    result.config.email_op_label        = cfg.email_op_label  || null;
  } catch (e) {
    result.config.error = e.message;
  }

  try {
    var trigs = ScriptApp.getProjectTriggers();
    result.triggers = trigs.map(function (t) {
      return {
        function: t.getHandlerFunction(),
        type:     String(t.getEventType())
      };
    });
  } catch (e) {
    result.triggersError = e.message;
  }

  // Solo verifica que existan, NO expone los valores.
  var props = PropertiesService.getScriptProperties();
  ['CLAUDE_API_KEY', 'AUTH_RESET_TOKEN'].forEach(function (k) {
    result.scriptProperties[k] = props.getProperty(k) ? 'set' : 'missing';
  });

  var coreChecks = [result.sheet.ok, result.drive.ok, result.gmail.ok, result.config.ok];
  if (coreChecks.every(function (x) { return x; })) result.overall = 'healthy';
  else if (coreChecks.some(function (x) { return x; })) result.overall = 'degraded';
  else result.overall = 'unhealthy';

  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// ════════════════════════════════════════════════════════════════
//  ENVIAR ONBOARDING EMAIL — manda al cliente su URL de dashboard,
//  AUTH_RESET_TOKEN y instrucciones de forwarding setup. Llamado
//  por el provisioner al final del setup.
// ════════════════════════════════════════════════════════════════
function _handleEnviarOnboarding(data) {
  var result = { success: false };
  try {
    data = data || {};
    var clientEmail = String(data.clientEmail || '').trim();
    if (!clientEmail) throw new Error('clientEmail es requerido');

    var cfg = _getConfig();
    var clientName     = data.clientName     || cfg.empresa_nombre || 'Cliente';
    var dashboardUrl   = data.dashboardUrl   || '';
    var authResetToken = data.authResetToken || '';
    var forwarderEmail = data.forwarderEmail || cfg.email_acr_remitente || '';
    var sharedInbox    = cfg.email_acr_destino || 'facturas@balanceclip.net';

    var subject = '🎉 Tu sistema BalanceClip está listo, ' + clientName;
    var html    = _buildOnboardingEmailHtml({
      clientName:     clientName,
      dashboardUrl:   dashboardUrl,
      authResetToken: authResetToken,
      forwarderEmail: forwarderEmail,
      sharedInbox:    sharedInbox
    });

    MailApp.sendEmail({
      to:       clientEmail,
      subject:  subject,
      htmlBody: html
    });

    result.success = true;
    result.sentTo  = clientEmail;
  } catch (e) {
    result.error = e.message;
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

// ════════════════════════════════════════════════════════════════
//  Plantilla HTML del onboarding email — diseño profesional con
//  layout en tablas (compatible con todos los email clients) y
//  pasos detallados de forwarding setup (espejados del wizard
//  de Captura Automática del dashboard).
// ════════════════════════════════════════════════════════════════
function _buildOnboardingEmailHtml(p) {
  var clientName     = _escHtml(p.clientName || 'Cliente');
  var dashboardUrl   = String(p.dashboardUrl || '');
  var dashboardSafe  = _escHtml(dashboardUrl);
  var authResetToken = _escHtml(p.authResetToken || '');
  var forwarderEmail = _escHtml(p.forwarderEmail || '');
  var sharedInbox    = _escHtml(p.sharedInbox || 'facturas@balanceclip.net');
  var fwdSettingsUrl = 'https://mail.google.com/mail/u/0/#settings/fwdandpop';
  var waMsg = encodeURIComponent('Hola, soy ' + (p.clientName || 'cliente nuevo') + '. Ya agregué facturas@balanceclip.net como dirección de reenvío en mi Gmail. Por favor aprueben el código de verificación. Gracias.');
  var waLink = 'https://wa.me/50769812266?text=' + waMsg;

  // Helpers de estilo para mantener consistencia
  var bgPage    = '#F8F9FA';
  var orange    = '#D04E00';
  var orangeDk  = '#A33D00';
  var blue      = '#1565C0';
  var textDk    = '#1A1A2E';
  var muted     = '#6C757D';
  var border    = '#DEE2E6';
  var surface   = '#FFFFFF';
  var surface2  = '#F1F3F5';

  // Card de paso reutilizable
  function stepCard(num, title, body) {
    return '' +
      '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 12px;border:1px solid ' + border + ';border-radius:10px;background:' + surface + '">' +
        '<tr>' +
          '<td width="44" valign="top" style="padding:18px 0 18px 18px">' +
            '<div style="width:32px;height:32px;border-radius:50%;background:' + orange + ';color:#fff;font-weight:700;font-size:14px;text-align:center;line-height:32px;font-family:Arial,sans-serif">' + num + '</div>' +
          '</td>' +
          '<td valign="top" style="padding:18px 18px 18px 12px;font-family:Arial,sans-serif">' +
            '<div style="font-weight:600;font-size:15px;color:' + textDk + ';margin-bottom:6px">' + title + '</div>' +
            '<div style="font-size:13px;color:' + muted + ';line-height:1.55">' + body + '</div>' +
          '</td>' +
        '</tr>' +
      '</table>';
  }

  function sectionHeader(emoji, title) {
    return '' +
      '<div style="margin:32px 0 14px;padding-bottom:8px;border-bottom:2px solid ' + orange + '">' +
        '<span style="font-size:20px;margin-right:8px">' + emoji + '</span>' +
        '<span style="font-size:17px;font-weight:700;color:' + textDk + ';font-family:Arial,sans-serif">' + title + '</span>' +
      '</div>';
  }

  return '' +
'<!DOCTYPE html>' +
'<html><head><meta charset="UTF-8"></head>' +
'<body style="margin:0;padding:0;background:' + bgPage + ';font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;color:' + textDk + '">' +
  '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:' + bgPage + ';padding:32px 16px">' +
    '<tr><td align="center">' +

      '<table cellpadding="0" cellspacing="0" border="0" width="640" style="max-width:640px;width:100%;background:' + surface + ';border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06)">' +

        // ── HEADER (banner con branding) ──
        '<tr><td style="background:linear-gradient(135deg,' + orange + ' 0%,' + orangeDk + ' 100%);padding:28px 32px;color:#fff;font-family:Arial,sans-serif">' +
          '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;opacity:0.85;margin-bottom:4px">BalanceClip</div>' +
          '<div style="font-size:22px;font-weight:700;margin-bottom:4px">¡Bienvenido, ' + clientName + '!</div>' +
          '<div style="font-size:14px;opacity:0.92">Tu sistema de contabilidad inteligente está activo</div>' +
        '</td></tr>' +

        // ── BODY ──
        '<tr><td style="padding:32px">' +

          '<p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:' + textDk + '">' +
            'Acabamos de configurar tu sistema. En pocos pasos vas a estar capturando facturas automáticamente desde tu Gmail.' +
          '</p>' +

          // ── DASHBOARD ──
          sectionHeader('📊', 'Tu dashboard') +
          '<p style="margin:0 0 16px;font-size:14px;color:' + textDk + ';line-height:1.55">' +
            'Acá vas a ver todas tus facturas, gastos, reportes ITBMS y declaración anual:' +
          '</p>' +
          '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 14px"><tr><td align="center">' +
            '<a href="' + dashboardSafe + '" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 28px;background:' + orange + ';color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;font-family:Arial,sans-serif">Abrir mi dashboard →</a>' +
          '</td></tr></table>' +
          '<p style="margin:14px 0 0;font-size:13px;color:' + muted + ';line-height:1.55">' +
            '<strong>Primer login:</strong> te va a pedir crear un password — ese queda como tu admin password.<br>' +
            '<strong>URL directo:</strong> <a href="' + dashboardSafe + '" target="_blank" rel="noopener noreferrer" style="color:' + orange + ';word-break:break-all">' + dashboardSafe + '</a>' +
          '</p>' +

          // ── PASO 1: Agregar dirección de reenvío ──
          sectionHeader('📧', 'Paso 1 — Agregar dirección de reenvío') +
          '<p style="margin:0 0 16px;font-size:14px;color:' + textDk + ';line-height:1.55">' +
            'En tu Gmail (<strong>' + forwarderEmail + '</strong>) vas a agregar <strong>' + sharedInbox + '</strong> como dirección de reenvío. Solo se hace <strong>una vez</strong>.' +
          '</p>' +

          stepCard('A', 'Copiá esta dirección',
            '<div style="background:' + surface2 + ';padding:10px 14px;border-radius:6px;font-family:Consolas,Monaco,monospace;font-size:14px;color:' + textDk + ';margin-top:6px;display:inline-block">' + sharedInbox + '</div>'
          ) +

          stepCard('B', 'Abrí la configuración de Gmail',
            '<a href="' + fwdSettingsUrl + '" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:9px 16px;background:' + textDk + ';color:#fff;text-decoration:none;border-radius:6px;font-size:13px;font-weight:600;margin:6px 0 8px;font-family:Arial,sans-serif">Abrir Gmail → Reenvío y POP/IMAP ↗</a>' +
            '<br>Una vez ahí: <strong>"Agregar dirección de reenvío"</strong> → pegá <code style="background:' + surface2 + ';padding:2px 6px;border-radius:3px;font-size:12px">' + sharedInbox + '</code> → <strong>Siguiente</strong>.'
          ) +

          stepCard('C', 'Avisanos por WhatsApp para aprobar el código',
            'Gmail va a mandar un correo con código de verificación a <code style="background:' + surface2 + ';padding:2px 6px;border-radius:3px;font-size:12px">' + sharedInbox + '</code>. Avisanos por WhatsApp y aprobamos el código del lado nuestro (generalmente en menos de 1 hora).' +
            '<br><a href="' + waLink + '" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:9px 16px;background:#25D366;color:#fff;text-decoration:none;border-radius:6px;font-size:13px;font-weight:600;margin-top:8px;font-family:Arial,sans-serif">💬 Avisar por WhatsApp ↗</a>'
          ) +

          // ── PASO 2: Filtros por proveedor ──
          sectionHeader('🔍', 'Paso 2 — Crear filtro por proveedor') +
          '<p style="margin:0 0 16px;font-size:14px;color:' + textDk + ';line-height:1.55">' +
            'Desde cualquier correo real de un proveedor, le decís a Gmail: <em>"reenviá a ' + sharedInbox + ' los correos de este remitente que tengan adjunto"</em>. Repetís por cada proveedor.' +
          '</p>' +

          stepCard('1', 'Abrí un correo del proveedor',
            'Andá a Gmail y abrí cualquier factura recibida (por ejemplo, una factura de un proveedor habitual).'
          ) +

          stepCard('2', 'Menú "⋮" arriba a la derecha del correo',
            'Click en <strong>⋮ → Filtrar mensajes de este tipo</strong>. Gmail pre-llena el remitente automáticamente.'
          ) +

          stepCard('3', 'Marcá "Tiene adjunto" → Crear filtro',
            'En la siguiente pantalla, marcá <strong>Reenviar a:</strong> y elegí <code style="background:' + surface2 + ';padding:2px 6px;border-radius:3px;font-size:12px">' + sharedInbox + '</code> → <strong>Crear filtro</strong>.'
          ) +

          '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:8px 0 0;background:#FFF8E6;border-left:3px solid #E65100;border-radius:6px"><tr><td style="padding:12px 14px;font-size:13px;color:' + textDk + ';line-height:1.55;font-family:Arial,sans-serif">' +
            '🔁 <strong>Repetí los 3 pasos por cada proveedor</strong> que quieras capturar. El filtro queda guardado en Gmail y aplica a todos los correos futuros — no necesitás hacerlo de nuevo.' +
          '</td></tr></table>' +

          // ── ALTERNATIVA: Captura manual con foto ──
          sectionHeader('📸', 'Alternativa rápida: subí una foto desde tu celular') +
          '<p style="margin:0 0 16px;font-size:14px;color:' + textDk + ';line-height:1.55">' +
            '¿Tenés una factura física en papel, o un PDF que recibiste por WhatsApp? No hace falta que la reenvíes por mail — la podés subir directo desde el dashboard:' +
          '</p>' +

          stepCard('1', 'Abrí tu dashboard',
            'Entrá desde tu celular o computadora a <a href="' + dashboardSafe + '" target="_blank" rel="noopener noreferrer" style="color:' + orange + '">' + dashboardSafe + '</a>'
          ) +

          stepCard('2', 'Click en "+ Registrar gasto"',
            'En el módulo Registro General, vas a ver un botón <strong>"+ Registrar gasto"</strong>. Hacé click ahí.'
          ) +

          stepCard('3', 'Tomá una foto o subí el PDF',
            'Desde el celular, podés <strong>tomar la foto en el momento</strong> con la cámara. Desde la PC, arrastrá el archivo o seleccionalo. Funciona con <strong>JPG, PNG o PDF</strong>.'
          ) +

          stepCard('4', 'La IA llena los datos automáticamente',
            'En unos segundos la IA extrae proveedor, RUC, número de factura, fecha, subtotal, ITBMS y total. Vos solo confirmás los datos y categoría → guardar.'
          ) +

          '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:8px 0 0;background:#E3F2FD;border-left:3px solid ' + blue + ';border-radius:6px"><tr><td style="padding:12px 14px;font-size:13px;color:' + textDk + ';line-height:1.55;font-family:Arial,sans-serif">' +
            '💡 <strong>Tip</strong>: el reenvío por Gmail (Pasos 1 y 2) es ideal para facturas <em>recurrentes</em> — proveedores que te facturan todos los meses. La foto manual es ideal para gastos <em>únicos</em> o facturas en papel que no recibís por email.' +
          '</td></tr></table>' +

          // ── TOKEN DE RECUPERACIÓN ──
          (authResetToken ? (
            sectionHeader('🔑', 'Token de recuperación') +
            '<p style="margin:0 0 12px;font-size:14px;color:' + textDk + ';line-height:1.55">' +
              'Guardá este token en lugar seguro (gestor de passwords, papel, etc). Lo necesitás <strong>solo si olvidás tu password</strong> de admin:' +
            '</p>' +
            '<div style="background:' + surface2 + ';border:1px dashed ' + border + ';padding:14px 16px;border-radius:8px;font-family:Consolas,Monaco,monospace;font-size:12px;color:' + textDk + ';word-break:break-all;text-align:center">' + authResetToken + '</div>'
          ) : '') +

          // ── ¿QUÉ SIGUE? ──
          sectionHeader('🚀', '¿Qué sigue?') +
          '<ol style="margin:0;padding-left:20px;font-size:14px;color:' + textDk + ';line-height:1.7">' +
            '<li>Hacé los Pasos 1 y 2 arriba (toma ~5 minutos por proveedor)</li>' +
            '<li>Esperá la primera factura — el sistema la captura en hasta 15 min</li>' +
            '<li>Aprobá la factura desde tu dashboard en <strong>Registro General → Pendientes</strong></li>' +
            '<li>Al final del mes / año, los reportes ITBMS y Cierre Anual se generan automáticamente</li>' +
          '</ol>' +

        '</td></tr>' +

        // ── FOOTER ──
        '<tr><td style="background:' + surface2 + ';padding:20px 32px;border-top:1px solid ' + border + ';font-family:Arial,sans-serif">' +
          '<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' +
            '<td style="font-size:12px;color:' + muted + ';line-height:1.6">' +
              '<strong>¿Dudas?</strong><br>' +
              'Escribinos por WhatsApp: <a href="' + waLink + '" target="_blank" rel="noopener noreferrer" style="color:' + orange + '">+507 6981-2266</a>' +
            '</td>' +
            '<td align="right" style="font-size:11px;color:' + muted + ';letter-spacing:1px;text-transform:uppercase">' +
              '<a href="https://balanceclip.net" target="_blank" rel="noopener noreferrer" style="color:' + muted + ';text-decoration:none">balanceclip.net</a>' +
            '</td>' +
          '</tr></table>' +
        '</td></tr>' +

      '</table>' +

      '<div style="font-size:11px;color:' + muted + ';margin-top:16px;font-family:Arial,sans-serif">' +
        'BalanceClip — Sistema de contabilidad operado por Las Nubes en Chica' +
      '</div>' +

    '</td></tr>' +
  '</table>' +
'</body></html>';
}

function _escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ════════════════════════════════════════════════════════════════
//  RUN SYNC NOW — disparar manualmente ejecutarSincronizacionUnificada
//  desde el admin panel. Devuelve los stats de Acreedores/Comercialización
//  para que el operador vea inmediatamente cuántos threads se procesaron.
// ════════════════════════════════════════════════════════════════
function _handleRunSyncNow(params, callback) {
  var result = { success: false, ranAt: '', durationMs: 0 };
  var t0 = Date.now();
  try {
    if (typeof ejecutarSincronizacionUnificada !== 'function') {
      throw new Error('ejecutarSincronizacionUnificada no está definida en este script');
    }
    ejecutarSincronizacionUnificada();
    result.success    = true;
    result.ranAt      = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
    result.durationMs = Date.now() - t0;
  } catch (e) {
    result.error      = e.message;
    result.durationMs = Date.now() - t0;
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// ════════════════════════════════════════════════════════════════
//  GET CONFIG SUMMARY — vista detalle del config_operaciones del
//  cliente para el admin panel. NO incluye secrets (CLAUDE_API_KEY,
//  AUTH_RESET_TOKEN, password_hash). Solo campos operacionales.
// ════════════════════════════════════════════════════════════════
function _handleGetConfigSummary(params, callback) {
  var result = { success: false, config: {} };
  try {
    var cfg    = _getConfig();
    var safe   = {};
    var fields = [
      'empresa_nombre', 'empresa_comercial', 'empresa_ruc', 'empresa_dv',
      'email_acr_destino', 'email_acr_remitente', 'email_acr_label',
      'email_op_destino',  'email_op_remitente',  'email_op_label',
      'email_st_destino',  'email_st_remitente',
      'email_comprobantes', 'drive_folder_id', 'itbms_rate', 'prefijo_id',
      'flow_acreedor', 'flow_comercializacion'
    ];
    fields.forEach(function (f) {
      safe[f] = cfg[f] !== undefined ? cfg[f] : null;
    });
    result.success = true;
    result.config  = safe;
  } catch (e) {
    result.error = e.message;
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function _handleInstalarTriggerAcr(data) {
  var result = { success: false, error: null };
  try {
    installAcreedoresTrigger(parseInt((data || {}).intervalo || '15', 10));
    result.success = true;
  } catch(err) { result.error = err.message; }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
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
//  v12.2: expone id_st_item en la respuesta
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
//  _handleGetEgresos — v12.4 PATCH
//  Cross-referencia drive_url desde ST_Items para egresos
//  credito_fiscal que no tienen drive_url propio.
//  La factura de DHL/FedEx vive en el ST_Item de tipo 'impuesto'
//  del mismo ST — se busca por id_st extraído de las notas.
// ═══════════════════════════════════════════════════════════════

// ── Helper compartido v12.6: construye los mapas de URLs desde ST ───
function _buildStUrlMaps(ss) {
  var stMap    = {};  // id_st → ST.drive_url (factura emitida CEYCO)
  var impMap   = {};  // egreso_id_impuesto → drive_url_factura (factura courier)

  // Mapa desde Servicios_Tecnicos: id_st → drive_url
  try {
    var sheetST = ss.getSheetByName('Servicios_Tecnicos');
    if (sheetST && sheetST.getLastRow() > 2) {
      var headers   = sheetST.getRange(2, 1, 1, sheetST.getLastColumn()).getValues()[0];
      var idxIdST   = headers.indexOf('id_st');
      var idxDriveU = headers.indexOf('drive_url');
      if (idxIdST >= 0 && idxDriveU >= 0) {
        var stData = sheetST.getRange(3, 1, sheetST.getLastRow() - 2, sheetST.getLastColumn()).getValues();
        for (var i = 0; i < stData.length; i++) {
          var idST   = String(stData[i][idxIdST]   || '').trim();
          var driveU = String(stData[i][idxDriveU] || '').trim();
          if (idST && driveU) stMap[idST] = driveU;
        }
      }
    }
  } catch(e) { Logger.log('⚠️ _buildStUrlMaps ST: ' + e.message); }

  // Mapa desde ST_Items tipo 'impuesto': egreso_id → drive_url_factura
  // Cols (base 1): id_st=2, tipo=3, drive_url_factura=17, egreso_id=18
  try {
    var sheetSTI = ss.getSheetByName('ST_Items');
    if (sheetSTI && sheetSTI.getLastRow() > 2) {
      var stiData = sheetSTI.getRange(3, 1, sheetSTI.getLastRow() - 2, 18).getValues();
      for (var j = 0; j < stiData.length; j++) {
        var tipo    = String(stiData[j][2]  || '').trim();   // col 3
        var driveI  = String(stiData[j][16] || '').trim();   // col 17
        var egrId   = String(stiData[j][17] || '').trim();   // col 18
        if (tipo === 'impuesto' && driveI && egrId) {
          impMap[egrId] = driveI;
        }
      }
    }
  } catch(e) { Logger.log('⚠️ _buildStUrlMaps STI: ' + e.message); }

  return { stMap: stMap, impMap: impMap };
}

// ── Extrae id_st desde el campo notas de un egreso/ingreso ────
function _extractStId(notas) {
  var m = String(notas || '').match(/ST:\s*(ST-RP-[\d-]+)/);
  return m ? m[1] : null;
}

// ── Extrae num_factura normalizado desde notas de un credito_fiscal ──
// "Factura FedEx: 0000091505" → "91505"  (strip leading zeros)
// "Factura: PC238679"         → "PC238679"
function _extractNumFacBase(notas) {
  var m = String(notas || '').match(/Factura(?:\s+FedEx)?:\s*0*([A-Z0-9]+)/i);
  return m ? m[1].toUpperCase() : null;
}

// ═══════════════════════════════════════════════════════════════
//  _handleGetEgresos — v12.6
//  Pre-índice "id_st|num_fac_normalizado" → drive_url exacto
//  para resolver STs con múltiples facturas FedEx
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

    var maps   = _buildStUrlMaps(ss);
    var stMap  = maps.stMap;
    var impMap = maps.impMap;  // egreso_id_impuesto → drive_url

    // Leer todos los egresos para poder cruzar impuesto ↔ credito_fiscal
    var numDataRows = sheet.getLastRow() - 2;
    var ncols = Math.min(sheet.getLastColumn(), EGRESOS_NCOLS);
    var data  = sheet.getRange(3, 1, numDataRows, ncols).getValues();

    // Pre-construir índice: id_st+num_fac_normalizado → egreso_id de tipo impuesto
    // Para resolver ST-0022 con múltiples FedEx
    var impEgresoIdx = {};  // "ST-RP-2026-0022|91505" → drive_url
    for (var p = 0; p < data.length; p++) {
      var rp = data[p];
      if (!rp[COL_E.ID - 1]) continue;
      var tipoP  = String(rp[COL_E.TIPO_EGRESO - 1] || '');
      var eIdP   = String(rp[COL_E.ID - 1]          || '').trim();
      if (tipoP !== 'impuesto' && tipoP !== 'costo_servicio_tecnico') continue;
      var notasP = String(rp[COL_E.NOTAS - 1]      || '');
      var stP    = _extractStId(notasP);
      var nfP    = String(rp[COL_E.NFACTURA - 1]   || '').trim().toUpperCase();
      // Normalizar: quitar ceros al frente para números puros
      var nfNorm = nfP.replace(/^0+/, '') || nfP;
      if (stP && nfNorm && impMap[eIdP]) {
        impEgresoIdx[stP + '|' + nfNorm] = impMap[eIdP];
      }
    }

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

      var driveUrl   = String(r[COL_E.DRIVE_URL - 1]   || '').trim();
      var tipoEgreso = String(r[COL_E.TIPO_EGRESO - 1] || '');
      var notas      = String(r[COL_E.NOTAS - 1]       || '');
      var stId       = _extractStId(notas);

      if (!driveUrl && stId) {
        if (tipoEgreso === 'credito_fiscal') {
          // Buscar el documento exacto del courier por num_factura
          var numBase = _extractNumFacBase(notas);
          if (numBase) {
            var key = stId + '|' + numBase;
            driveUrl = impEgresoIdx[key] || '';
          }
          // Fallback: primer impuesto del ST
          if (!driveUrl) driveUrl = stMap[stId] || '';
        } else {
          // Miguelez, Electrisa, otros sin URL → factura emitida del ST
          driveUrl = stMap[stId] || '';
        }
      }

      items.push({
        id_egreso:    r[COL_E.ID - 1],
        fecha_reg:    r[COL_E.FECHA_REG - 1],
        estado:       r[COL_E.ESTADO - 1]       || 'registrado',
        fecha_egreso: fechaGasto,
        mes:          r[COL_E.MES - 1]          || '',
        anio:         r[COL_E.ANIO - 1]         || '',
        tipo_egreso:  tipoEgreso,
        categoria:    r[COL_E.CATEGORIA - 1]    || '',
        subtotal:     parseFloat(r[COL_E.SUBTOTAL - 1])  || 0,
        itbms:        parseFloat(r[COL_E.ITBMS - 1])     || 0,
        total:        parseFloat(r[COL_E.TOTAL - 1])      || 0,
        proveedor:    r[COL_E.PROVEEDOR - 1]   || '',
        ruc_prov:     r[COL_E.RUC_PROV - 1]    || '',
        dv_prov:      r[COL_E.DV_PROV - 1]     || '',
        num_fac_ref:  r[COL_E.NFACTURA - 1]    || '',
        id_item_cv:   r[COL_E.ID_ITEM_CV - 1]  || '',
        drive_url:    driveUrl,
        descripcion:  r[COL_E.DESCRIPCION - 1] || '',
        notas:        notas,
        id_st_item:   (ncols >= COL_E.ID_ST_ITEM)   ? (r[COL_E.ID_ST_ITEM - 1]   || '') : '',
        alcance:      (ncols >= COL_E.ALCANCE)      ? (r[COL_E.ALCANCE - 1]      || 'negocio') : 'negocio',
        factura_data: (ncols >= COL_E.FACTURA_DATA) ? (r[COL_E.FACTURA_DATA - 1] || '') : '',
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
    // tipo_egreso y categoria son siempre el valor DGI (ej: 'nomina', 'alquileres', etc.)
    var dgiCat = params.tipo || params.categoria || 'otros_deducibles';
    fila[COL_E.TIPO_EGRESO - 1] = dgiCat;
    fila[COL_E.CATEGORIA - 1]   = dgiCat;
    fila[COL_E.PROVEEDOR - 1]   = params.proveedor   || '';
    fila[COL_E.RUC_PROV - 1]    = params.ruc_prov    || '';
    fila[COL_E.DV_PROV - 1]     = params.dv_prov     || '';
    fila[COL_E.NFACTURA - 1]    = params.num_fac     || '';
    fila[COL_E.ID_ITEM_CV - 1]  = '';
    fila[COL_E.DRIVE_URL - 1]   = params.driveUrl    || '';
    fila[COL_E.DESCRIPCION - 1] = params.descripcion || '';
    fila[COL_E.NOTAS - 1]       = params.notas       || '';
    // id_st_item no aplica para egresos operativos manuales
    fila[COL_E.ALCANCE - 1]     = params.alcance === 'personal' ? 'personal' : 'negocio';

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
//  _handleSubirFacturaEgreso
// ═══════════════════════════════════════════════════════════════

function _handleSubirFacturaEgreso(data) {
  var result = { success: false };
  try {
    var egresoId = data.egreso_id || '';
    var b64      = data.file_b64  || '';
    var mime     = data.file_mime || 'application/pdf';
    var nombre   = data.file_name || (egresoId + '.pdf');
    if (!egresoId || !b64) throw new Error('egreso_id y file_b64 requeridos');

    var folder   = DriveApp.getFolderById(CONFIG.VOUCHER_FOLDER_ID);
    var bytes    = Utilities.base64Decode(b64);
    var blob     = Utilities.newBlob(bytes, mime, nombre);
    var file     = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    var driveUrl = 'https://drive.google.com/file/d/' + file.getId() + '/view';

    // Si es XML FE Panamá, parsear ahora que tenemos el blob en memoria
    var facturaJson = '';
    if (_esXmlMime(mime, nombre)) {
      try {
        var xmlText  = blob.getDataAsString('UTF-8');
        var parsed   = _parseFeXmlGas(xmlText);
        facturaJson  = JSON.stringify(parsed);
      } catch(eXml) {
        Logger.log('XML parse skipped (egreso ' + egresoId + '): ' + eXml.message);
      }
    }

    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = _initEgresosSheet(ss);
    _ensureSheetCols(sheet, EGRESOS_NCOLS, 'factura_data');
    var numRows = sheet.getLastRow() - 2;
    if (numRows > 0) {
      var ids = sheet.getRange(3, COL_E.ID, numRows, 1).getValues();
      for (var i = 0; i < ids.length; i++) {
        if (String(ids[i][0]) === egresoId) {
          sheet.getRange(3 + i, COL_E.DRIVE_URL).setValue(driveUrl);
          if (facturaJson) sheet.getRange(3 + i, COL_E.FACTURA_DATA).setValue(facturaJson);
          break;
        }
      }
    }
    result.success  = true;
    result.driveUrl = driveUrl;
    if (facturaJson) result.facturaParsed = true;
    Logger.log('📄 Factura subida Drive para ' + egresoId + ': ' + driveUrl + (facturaJson ? ' [XML parseado]' : ''));
  } catch(e) {
    result.error = e.message;
    Logger.log('Error subirFacturaEgreso: ' + e.message);
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════
//  _handleSubirFacturaIngreso
// ═══════════════════════════════════════════════════════════════

function _handleSubirFacturaIngreso(data) {
  var result = { success: false };
  try {
    var ingresoId = data.ingreso_id || '';
    var b64       = data.file_b64   || '';
    var mime      = data.file_mime  || 'application/pdf';
    var nombre    = data.file_name  || (ingresoId + '.pdf');
    if (!ingresoId || !b64) throw new Error('ingreso_id y file_b64 requeridos');

    var folder   = DriveApp.getFolderById(CONFIG.VOUCHER_FOLDER_ID);
    var bytes    = Utilities.base64Decode(b64);
    var blob     = Utilities.newBlob(bytes, mime, nombre);
    var file     = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    var driveUrl = 'https://drive.google.com/file/d/' + file.getId() + '/view';

    // Si es XML FE Panamá, parsear ahora que tenemos el blob en memoria
    var facturaJson = '';
    if (_esXmlMime(mime, nombre)) {
      try {
        var xmlText = blob.getDataAsString('UTF-8');
        var parsed  = _parseFeXmlGas(xmlText);
        facturaJson = JSON.stringify(parsed);
      } catch(eXml) {
        Logger.log('XML parse skipped (ingreso ' + ingresoId + '): ' + eXml.message);
      }
    }

    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(CONFIG.SHEET_INGRESOS);
    if (sheet) {
      _ensureSheetCols(sheet, INGRESOS_NCOLS, 'factura_data');
      var numRows = sheet.getLastRow() - 2;
      if (numRows > 0) {
        var ids = sheet.getRange(3, COL_I.ID_TRANS, numRows, 1).getValues();
        for (var i = 0; i < ids.length; i++) {
          if (String(ids[i][0]) === ingresoId) {
            sheet.getRange(3 + i, COL_I.DRIVE_URL).setValue(driveUrl);
            if (facturaJson) sheet.getRange(3 + i, COL_I.FACTURA_DATA).setValue(facturaJson);
            break;
          }
        }
      }
    }
    result.success  = true;
    result.driveUrl = driveUrl;
    if (facturaJson) result.facturaParsed = true;
    Logger.log('📄 Comprobante subido Drive para ' + ingresoId + ': ' + driveUrl + (facturaJson ? ' [XML parseado]' : ''));
  } catch(e) {
    result.error = e.message;
    Logger.log('Error subirFacturaIngreso: ' + e.message);
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
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
      // id_st_item vacío — egresos de inventario Carbone no tienen ST_Item

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
//  _handleGetIngresos
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
//  _handleGetIngresos — v12.6
//  Usa ST.drive_url (factura emitida por CEYCO) como fuente principal
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

    // Construir mapa ST → drive_url (factura emitida)
    var maps  = _buildStUrlMaps(ss);
    var stMap = maps.stMap;

    var numIngRows = sheet.getLastRow() - 2;
    var ncols = Math.min(sheet.getLastColumn(), INGRESOS_NCOLS);
    var data  = sheet.getRange(3, 1, numIngRows, ncols).getValues();
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

      var notas    = String(r[COL_I.NOTAS_INT - 1] || '');
      var driveUrl = String(r[COL_I.DRIVE_URL - 1] || '').trim();
      var stId     = _extractStId(notas);

      // Preferir ST.drive_url (factura emitida) sobre drive_url del ingreso
      // que puede ser el voucher de pago del cliente.
      // EXCEPCIÓN: notas_credito conservan su propio drive_url (apunta al PDF de la NC)
      var tipoComp = String(r[COL_I.TIPO_COMP - 1] || '');
      if (stId && stMap[stId] && tipoComp !== 'nota_credito') {
        driveUrl = stMap[stId];
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
        dv_cliente:        (ncols >= COL_I.DV_CLI ? r[COL_I.DV_CLI - 1] : '') || '',
        factura_data:      (ncols >= COL_I.FACTURA_DATA ? r[COL_I.FACTURA_DATA - 1] : '') || '',
        tipo_persona:      r[COL_I.TIPO_PERSONA - 1] || '',
        num_factura:       r[COL_I.NUM_FACTURA - 1]  || '',
        tipo_comprobante:  r[COL_I.TIPO_COMP - 1]    || '',
        drive_url:         driveUrl,                  // ← ST.drive_url si existe
        descripcion:       r[COL_I.DESCRIPCION - 1]  || '',
        notas:             notas,
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

    var catUnificada = params.categoria || 'ventas_servicios';
    // Mapping a tipo_ingreso (campo legacy mantenido en la hoja para
    // compatibilidad). Las 19 keys nuevas + las 14 legacy resuelven
    // todas a un tipo_ingreso interno.
    var mapaTipo = {
      // ── Keys legacy (datos viejos) ──
      'venta_producto_gravado':   'venta_producto',
      'venta_producto_exento':    'venta_producto',
      'servicio_tecnico_gravado': 'servicio_tecnico',
      'servicio_tecnico_exento':  'servicio_tecnico',
      'asesoria_consultoria':     'servicio_asesoria',
      'servicios_profesionales':  'servicio_profesional',
      'salarios':                 'salario',
      'comision':                 'comision',
      'exportacion':              'exportacion',
      'otro_gravado':             'otro',
      'otro_exento':              'otro',
      // ── Keys nuevas DGI Form 91 (L1-L19) ──
      'salarios_con_retencion':     'salario',
      'remuneracion_sin_retencion': 'salario',
      'ingresos_especies':          'otro',
      'gastos_repr_asalariado':     'otro',
      'dietas':                     'otro',
      'actividad_agropecuaria':     'venta_producto',
      'honorarios_comision':        'comision',
      'honorarios_profesionales':   'servicio_profesional',
      'alquiler_habitacional':      'alquiler',
      'alquiler_comercial':         'alquiler',
      'intereses_financieros':      'otro',
      'ganancia_capital_legacy':    'otro',
      'otros_ingresos':             'otro',
      'ventas_servicios':           'venta_producto',
      'devoluciones_descuentos':    'venta_producto',
      'descuento_jubilados':        'venta_producto',
      'ingresos_exentos':           'otro',
      'fuente_extranjera':          'otro',
      'gastos_repr_actividad':      'otro',
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
    fila[COL_I.DV_CLI - 1]        = params.dv || '';

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
//  _handleActualizarIngreso — actualiza todos los campos editables del modal
// ═══════════════════════════════════════════════════════════════

function _handleActualizarIngreso(params, callback) {
  var result = { success: false, ingresoId: null, error: null };
  try {
    var id = String(params.id || '').trim();
    if (!id) throw new Error('id requerido');

    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(CONFIG.SHEET_INGRESOS);
    if (!sheet) throw new Error('Hoja Ingresos no encontrada');
    var lastRow = sheet.getLastRow();
    if (lastRow <= 2) throw new Error('Hoja Ingresos sin datos');

    var ids = sheet.getRange(3, COL_I.ID_TRANS, lastRow - 2, 1).getValues();
    var rowIdx = -1;
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === id) { rowIdx = i + 3; break; }
    }
    if (rowIdx === -1) throw new Error('Ingreso no encontrado: ' + id);

    var fechaIngreso = params.fecha || Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd');
    var fDate = new Date(fechaIngreso + 'T12:00:00');
    var mes   = isNaN(fDate.getTime()) ? '' : (fDate.getMonth() + 1);
    var anio  = isNaN(fDate.getTime()) ? '' : fDate.getFullYear();

    var total    = parseFloat(params.total)    || 0;
    var itbms    = parseFloat(params.itbms)    || 0;
    var subtotal = parseFloat(params.subtotal) || parseFloat((total - itbms).toFixed(2));

    var catUnificada = params.categoria || 'ventas_servicios';
    // Mapping a tipo_ingreso (campo legacy mantenido en la hoja para
    // compatibilidad). Las 19 keys nuevas + las 14 legacy resuelven
    // todas a un tipo_ingreso interno.
    var mapaTipo = {
      // ── Keys legacy (datos viejos) ──
      'venta_producto_gravado':   'venta_producto',
      'venta_producto_exento':    'venta_producto',
      'servicio_tecnico_gravado': 'servicio_tecnico',
      'servicio_tecnico_exento':  'servicio_tecnico',
      'asesoria_consultoria':     'servicio_asesoria',
      'servicios_profesionales':  'servicio_profesional',
      'salarios':                 'salario',
      'comision':                 'comision',
      'exportacion':              'exportacion',
      'otro_gravado':             'otro',
      'otro_exento':              'otro',
      // ── Keys nuevas DGI Form 91 (L1-L19) ──
      'salarios_con_retencion':     'salario',
      'remuneracion_sin_retencion': 'salario',
      'ingresos_especies':          'otro',
      'gastos_repr_asalariado':     'otro',
      'dietas':                     'otro',
      'actividad_agropecuaria':     'venta_producto',
      'honorarios_comision':        'comision',
      'honorarios_profesionales':   'servicio_profesional',
      'alquiler_habitacional':      'alquiler',
      'alquiler_comercial':         'alquiler',
      'intereses_financieros':      'otro',
      'ganancia_capital_legacy':    'otro',
      'otros_ingresos':             'otro',
      'ventas_servicios':           'venta_producto',
      'devoluciones_descuentos':    'venta_producto',
      'descuento_jubilados':        'venta_producto',
      'ingresos_exentos':           'otro',
      'fuente_extranjera':          'otro',
      'gastos_repr_actividad':      'otro',
    };
    var tipoIng = mapaTipo[catUnificada] || 'venta_producto';

    var rucCli = String(params.ruc || '').trim();

    // Updates campo por campo (preserva FECHA_REG, ESTADO, DRIVE_URL, etc.)
    sheet.getRange(rowIdx, COL_I.FECHA_INGRESO).setValue(fechaIngreso);
    sheet.getRange(rowIdx, COL_I.MES).setValue(mes);
    sheet.getRange(rowIdx, COL_I.ANIO_FISCAL).setValue(anio);
    sheet.getRange(rowIdx, COL_I.SUBTOTAL).setValue(subtotal || '');
    sheet.getRange(rowIdx, COL_I.ITBMS).setValue(itbms || '');
    sheet.getRange(rowIdx, COL_I.TOTAL).setValue(total || '');
    sheet.getRange(rowIdx, COL_I.TIPO_INGRESO).setValue(tipoIng);
    sheet.getRange(rowIdx, COL_I.CATEGORIA).setValue(catUnificada);
    sheet.getRange(rowIdx, COL_I.NOMBRE_CLI).setValue(params.nombre || '');
    sheet.getRange(rowIdx, COL_I.RUC_CLI).setValue(rucCli);
    sheet.getRange(rowIdx, COL_I.TIPO_PERSONA).setValue(detectarTipoPersona(rucCli));
    sheet.getRange(rowIdx, COL_I.NUM_FACTURA).setValue(params.num_factura || '');
    sheet.getRange(rowIdx, COL_I.DESCRIPCION).setValue(params.descripcion || '');
    sheet.getRange(rowIdx, COL_I.NOTAS_INT).setValue(params.notas || '');
    sheet.getRange(rowIdx, COL_I.DV_CLI).setValue(params.dv || '');
    sheet.getRange(rowIdx, COL_I.SUBTOTAL, 1, 3).setNumberFormat('#,##0.00');

    result.success   = true;
    result.ingresoId = id;
    Logger.log('✏️ Ingreso actualizado: ' + id + ' | fila ' + rowIdx);
  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleActualizarIngreso: ' + err.message);
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

    var catValues = CATEGORIAS_GASTO_DGI.map(function(c) { return c.valor + ' — ' + c.label; }).join('\n');

    var prompt =
      'Eres un extractor de datos de facturas panameñas (DGI e-Tax 2.0 y facturas tradicionales). ' +
      'Analiza esta factura y responde SOLO con JSON válido, sin markdown ni texto adicional:\n' +
      '{"num_factura":"","fecha":"YYYY-MM-DD","proveedor":"","nombre_comercial":"","descripcion_corta":"",' +
      '"ruc_proveedor":"","dv_proveedor":"",' +
      '"ruc_receptor":"","nombre_receptor":"","subtotal":0,"itbms":0,"total":0,' +
      '"categoria_gasto":"","' +
      'items":[{"descripcion":"","cantidad":1,"precio_unitario":0,"itbms":0,"total":0}]}\n' +
      '\nESTRUCTURA DE UNA FACTURA PANAMEÑA:\n' +
      '  ▶ PARTE SUPERIOR (CABECERA): datos del EMISOR = el vendedor/proveedor (nombre empresa, RUC, dirección, teléfono).\n' +
      '  ▶ PARTE MEDIA: sección "Cliente:" o "Receptor:" = datos del RECEPTOR = quien COMPRA (nombre, RUC del cliente).\n' +
      '  NUNCA confundir: el RUC del EMISOR está en la cabecera junto al nombre del negocio.\n' +
      '                   el RUC del RECEPTOR está después de "Cliente:" o "RUC:" en la sección del cliente.\n' +
      '\nREGLAS:\n' +
      '1. proveedor = razón social legal del EMISOR (cabecera, parte SUPERIOR del documento), NO del receptor/cliente.\n' +
      '   Ejemplo: "ORLYN, S.A." (es la entidad legal).\n' +
      '2. nombre_comercial = nombre comercial / fantasía / sucursal visible en el recibo, distinto de la razón social.\n' +
      '   Es el nombre que el cliente reconoce, no la entidad legal.\n' +
      '   Ejemplos:\n' +
      '     "ORLYN, S.A. ESTACION TERPEL ALBROOK CANFIELD" → nombre_comercial="Estación Terpel Albrook Canfield"\n' +
      '     "DELIVERY HERO PANAMA (E-COMMERCE) S.A." → nombre_comercial="PedidosYa" (si está visible en el header/logo)\n' +
      '     "FARMACIAS ARROCHA, S.A." → nombre_comercial="Farmacia Arrocha"\n' +
      '   null si NO hay nombre comercial distinto del legal.\n' +
      '3. descripcion_corta = una frase narrativa de 4-8 palabras que un humano escribiría para describir este gasto.\n' +
      '   Combiná: la categoría natural del producto/servicio comprado + nombre comercial (o razón social si no hay comercial).\n' +
      '   Empezá con la categoría natural (sustantivo común), seguida del lugar/marca.\n' +
      '   Ejemplos buenos:\n' +
      '     • "Combustible Estación Terpel Albrook"\n' +
      '     • "Almuerzo Restaurante La Casa del Marisco"\n' +
      '     • "Útiles oficina PriceSmart"\n' +
      '     • "Honorarios contables Conte CPMA"\n' +
      '     • "Materiales construcción Cochez"\n' +
      '     • "Medicinas Farmacia Arrocha"\n' +
      '     • "Servicio delivery PedidosYa"\n' +
      '   Ejemplos malos (NO hacer):\n' +
      '     • "ACT95 CA #06" (literal del item, no narrativo)\n' +
      '     • "ORLYN, S.A. — ACT95 CA #06" (frankenstein)\n' +
      '     • "Factura de gasolina" (genérico, sin lugar)\n' +
      '   Esta es la descripción que aparece en el dashboard del cliente — debe ser legible y útil.\n' +
      '4. ruc_proveedor = RUC del EMISOR (cabecera). Formatos posibles:\n' +
      '   "N-20-606 DV 09"        → ruc_proveedor="N-20-606",      dv_proveedor="09"\n' +
      '   "8-517-1400 DV 85"      → ruc_proveedor="8-517-1400",    dv_proveedor="85"\n' +
      '   "1891245-1-720993 DV 32"→ ruc_proveedor="1891245-1-720993", dv_proveedor="32"\n' +
      '   "155604-1-409777 DV 44" → ruc_proveedor="155604-1-409777",  dv_proveedor="44"\n' +
      '   Persona jurídica: formato largo con tres segmentos (ej: XXXXXX-1-YYYYYY).\n' +
      '5. dv_proveedor = SOLO el número después de "DV" en la cabecera del EMISOR. Nunca el DV del cliente.\n' +
      '6. ruc_receptor = RUC del RECEPTOR (sección "Cliente:", parte media/inferior). Solo dígitos y guiones, sin DV.\n' +
      '7. nombre_receptor = nombre del receptor/cliente.\n' +
      '8. fecha en formato YYYY-MM-DD.\n' +
      '9. subtotal = monto antes de ITBMS | itbms = impuesto | total = monto final.\n' +
      '10. items[].descripcion: descripción de los productos/servicios comprados (LITERAL del recibo, sin reformular).\n' +
      '11. categoria_gasto = elige el valor que MEJOR describe este gasto según los productos/servicios y el nombre del proveedor.\n' +
      '    Valores válidos (elige exactamente uno):\n' + catValues + '\n' +
      '    Si no encaja en ninguna categoría específica usa "otros_deducibles".\n' +
      '    COSTOS DE VENTAS (Anexo 94 DGI L28-L35) — usá estas SOLO si el gasto está vinculado a la producción/comercialización del bien o servicio vendido (no a la operación administrativa):\n' +
      '      - "compras_locales" (L28): compras de mercancía/materia prima a proveedores locales.\n' +
      '      - "compras_importadas" (L29): compras a proveedores del exterior (importadas).\n' +
      '      - "salarios_costo" (L30): salarios de personal de producción/operativo directo (no admin).\n' +
      '      - "depreciacion_costo" (L31): depreciación de maquinaria/equipos de producción.\n' +
      '      - "mantenimiento_costo" (L32): mantenimiento de equipos de producción.\n' +
      '      - "servicios_costo" (L33): electricidad/agua/teléfono de la planta o local productivo.\n' +
      '      - "seguros_costo" (L34): seguros sobre inventario, maquinaria o el local productivo.\n' +
      '      - "otros_costos_venta" (L35): otros costos directos sin línea específica (catch-all de la sección Costos).\n' +
      '    Si NO está claro que el gasto sea costo de producción/ventas, usá las categorías de Gastos Operativos (nomina, alquileres, depreciacion, mantenimiento_reparacion, servicios_publicos, seguros, etc.), no las de Costo.\n' +
      '12. Montos como números, no strings. null solo si el campo realmente no existe.';

    var payload = {
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1000,
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
    if (code !== 200) throw new Error('Claude API error ' + code + ': ' + response.getContentText().substring(0, 200));

    var respData = JSON.parse(response.getContentText());
    var text     = '';
    var content  = respData.content || [];
    for (var i = 0; i < content.length; i++) {
      if (content[i].type === 'text') { text = content[i].text; break; }
    }

    var parsed = JSON.parse(text.replace(/```json|```/g, '').trim());

    // Validate categoria_gasto is a known value
    var catGasto = parsed.categoria_gasto || null;
    var validCat = false;
    for (var ci = 0; ci < CATEGORIAS_GASTO_DGI.length; ci++) {
      if (CATEGORIAS_GASTO_DGI[ci].valor === catGasto) { validCat = true; break; }
    }
    if (!validCat) catGasto = null;

    return ContentService
      .createTextOutput(JSON.stringify({
        success:           true,
        num_factura:       parsed.num_factura       || null,
        fecha:             parsed.fecha             || null,
        proveedor:         parsed.proveedor         || null,
        nombre_comercial:  parsed.nombre_comercial  || null,
        descripcion_corta: parsed.descripcion_corta || null,
        ruc_proveedor:     parsed.ruc_proveedor     || null,
        dv_proveedor:      parsed.dv_proveedor      || null,
        ruc_receptor:      parsed.ruc_receptor      || null,
        nombre_receptor:   parsed.nombre_receptor   || null,
        subtotal:          parsed.subtotal          || null,
        itbms:             parsed.itbms             || null,
        total:             parsed.total             || null,
        categoria_gasto:   catGasto,
        items:             Array.isArray(parsed.items) ? parsed.items : [],
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
      'Eres un extractor de datos de comprobantes de pago panameños y un clasificador fiscal DGI. ' +
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
      '  "notas": "cualquier dato adicional relevante (banco origen, referencia, etc.)",\n' +
      '  "categoria_dgi": "clasifica el ingreso a UNA de las líneas DGI Formulario 91 (ver guía abajo)"\n' +
      '}\n\n' +
      'REGLAS GENERALES:\n' +
      '1. Para Yappy: monto = lo que se pagó; nombre_pagador = quien envió el pago.\n' +
      '2. Para transferencias: incluir banco origen y referencia en notas.\n' +
      '3. Para facturas: tiene_itbms = true si el documento muestra ITBMS o impuesto del 7% o 10%.\n' +
      '4. fecha siempre en formato YYYY-MM-DD.\n' +
      '5. Si un campo no es visible, usa null (no inventar datos).\n\n' +
      'GUÍA DE CLASIFICACIÓN categoria_dgi (Formulario 91 DGI Panamá):\n' +
      'Elige EXACTAMENTE una de estas keys según la naturaleza del ingreso. Si no estás seguro, usa "ventas_servicios" (L14) que es el catch-all comercial.\n\n' +
      'ACTIVIDAD / PROFESIÓN (lo más común):\n' +
      '  - "ventas_servicios" (L14): venta de productos o prestación de servicios comerciales. Factura DGI estándar, e-Factura, venta al detal o mayorista. ESTE ES EL DEFAULT si el comprobante es una factura comercial sin contexto especial.\n' +
      '  - "honorarios_profesionales" (L8): honorarios por servicios profesionales independientes (médicos, abogados, contadores, arquitectos, ingenieros, consultores). Suele venir en factura emitida por persona natural con RUC profesional.\n' +
      '  - "honorarios_comision" (L7): comisiones por venta o intermediación (vendedores, brokers, agentes).\n' +
      '  - "alquiler_comercial" (L10): renta de local comercial, oficina, bodega. Incluye ITBMS 7%.\n' +
      '  - "alquiler_habitacional" (L9): renta de vivienda. EXENTO de ITBMS por ley.\n' +
      '  - "intereses_financieros" (L11): intereses bancarios, rendimientos de inversión, intereses por préstamos otorgados.\n' +
      '  - "actividad_agropecuaria" (L6): venta de productos agrícolas, ganadería, pesca.\n' +
      '  - "otros_ingresos" (L13): ingresos comerciales que no encajen específicamente arriba.\n\n' +
      'REMUNERACIONES PERSONALES (asalariados):\n' +
      '  - "salarios_con_retencion" (L1): comprobante de pago de planilla / sueldo con retención mensual.\n' +
      '  - "remuneracion_sin_retencion" (L2): pago personal sin retención del empleador.\n' +
      '  - "gastos_repr_asalariado" (L4): gastos de representación como parte del salario.\n' +
      '  - "dietas" (L5): pagos por participación en juntas o sesiones.\n\n' +
      'ESPECIALES:\n' +
      '  - "fuente_extranjera" (L18): claramente proviene de cliente fuera de Panamá (factura en USD pero con dirección extranjera, etc.).\n' +
      '  - "ingresos_exentos" (L17): dividendos locales con ISR ya pagado, donaciones no comerciales.\n' +
      '  - "devoluciones_descuentos" (L15): notas crédito o devoluciones (signo negativo).\n\n' +
      'Si el comprobante no da pistas claras, default a "ventas_servicios".';

    var payload = {
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1000,
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
    if (code !== 200) throw new Error('Claude API error ' + code + ': ' + response.getContentText().substring(0, 200));

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
        categoria_dgi:    parsed.categoria_dgi    || null,
      }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log('Error _handleParseComprobanteIngreso: ' + err.message);
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ═══════════════════════════════════════════════════════════════
//  _handleCorregirComprobante  ← PATCH v12
// ═══════════════════════════════════════════════════════════════

function _handleCorregirComprobante(data) {
  try {
    var idItem    = data.id_item    || '';
    var ingresoId = data.ingreso_id || '';
    if (!idItem) throw new Error('id_item requerido');

    var b64      = data.imageBase64 || '';
    var mimeType = data.imageMime   || 'image/jpeg';
    var fileName = data.imageName   || ('comp_corr_' + idItem + '_' + Date.now() + '.jpg');
    if (!b64) throw new Error('imageBase64 requerido');

    var folder  = DriveApp.getFolderById(CONFIG.VOUCHER_FOLDER_ID);
    var bytes   = Utilities.base64Decode(b64);
    var blob    = Utilities.newBlob(bytes, mimeType, fileName);
    var file    = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    var driveUrl = 'https://drive.google.com/file/d/' + file.getId() + '/view';

    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);

    var sheetCV = ss.getSheetByName('Compras_Ventas');
    if (!sheetCV) throw new Error('Hoja Compras_Ventas no encontrada');

    var cvData  = sheetCV.getDataRange().getValues();
    var cvFound = false;
    for (var i = 2; i < cvData.length; i++) {
      if (String(cvData[i][0]) === String(idItem)) {
        sheetCV.getRange(i + 1, _CC_DRIVE_URL_EMIT).setValue(driveUrl);
        cvFound = true;
        Logger.log('✅ CV drive_url_emit actualizado: ' + idItem);
        break;
      }
    }
    if (!cvFound) Logger.log('⚠️ id_item no encontrado en CV: ' + idItem);

    var ingFound = false;
    if (ingresoId && ingresoId.indexOf('OPERATIVO-') === -1) {
      var sheetIng = ss.getSheetByName(CONFIG.SHEET_INGRESOS);
      if (sheetIng && sheetIng.getLastRow() > 2) {
        var ingData = sheetIng.getRange(3, 1, sheetIng.getLastRow() - 2, INGRESOS_NCOLS).getValues();
        for (var j = 0; j < ingData.length; j++) {
          if (String(ingData[j][COL_I.ID_TRANS - 1]) === String(ingresoId)) {
            var rowIng = j + 3;
            sheetIng.getRange(rowIng, COL_I.DRIVE_URL).setValue(driveUrl);
            var notaActual = String(sheetIng.getRange(rowIng, COL_I.NOTAS_INT).getValue() || '');
            var stamp      = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm');
            var notaNueva  = 'Comprobante corregido: ' + stamp;
            sheetIng.getRange(rowIng, COL_I.NOTAS_INT).setValue(
              notaActual ? notaActual + ' | ' + notaNueva : notaNueva
            );
            ingFound = true;
            Logger.log('✅ Ingresos drive_url actualizado: ' + ingresoId);
            break;
          }
        }
        if (!ingFound) Logger.log('⚠️ ingreso_id no encontrado en Ingresos: ' + ingresoId);
      }
    }

    return ContentService
      .createTextOutput(JSON.stringify({
        success:  true,
        driveUrl: driveUrl,
        cvFound:  cvFound,
        ingFound: ingFound,
      }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log('Error _handleCorregirComprobante: ' + err.message);
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ═══════════════════════════════════════════════════════════════
//  _handleActualizarNotasIngreso  ← PATCH v12.1
// ═══════════════════════════════════════════════════════════════

function _handleActualizarNotasIngreso(params, callback) {
  var result = { success: false, error: null };
  try {
    var ingresoId = String(params.ingreso_id || '').trim();
    var datosPago = String(params.datos_pago  || '').trim();

    if (!ingresoId) throw new Error('ingreso_id requerido');
    if (!datosPago)  throw new Error('datos_pago requerido');

    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(CONFIG.SHEET_INGRESOS);
    if (!sheet) throw new Error('Hoja Ingresos no encontrada');

    var lastRow = sheet.getLastRow();
    if (lastRow <= 2) throw new Error('Hoja Ingresos vacía');

    var numRows = lastRow - 2;
    var ids     = sheet.getRange(3, COL_I.ID_TRANS, numRows, 1).getValues();
    var found   = false;

    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0]).trim() === ingresoId) {
        var rowNum     = i + 3;
        var notaActual = String(sheet.getRange(rowNum, COL_I.NOTAS_INT).getValue() || '');
        var notaNueva  = notaActual ? notaActual + ' | ' + datosPago : datosPago;
        sheet.getRange(rowNum, COL_I.NOTAS_INT).setValue(notaNueva);
        found = true;
        Logger.log('✅ Notas actualizadas en ingreso: ' + ingresoId);
        break;
      }
    }

    if (!found) throw new Error('Ingreso no encontrado: ' + ingresoId);
    result.success = true;

  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleActualizarNotasIngreso: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function _handleAnularRegistro(params, callback) {
  var result = { success: false, error: null };
  try {
    var tipo = params.tipo || '';
    var id   = params.id   || '';
    Logger.log('ANULAR — tipo: [' + tipo + '] id: [' + id + ']');
    if (!tipo || !id) throw new Error('tipo e id requeridos');
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);

    if (tipo === 'ingreso') {
      var sheetIng = ss.getSheetByName(CONFIG.SHEET_INGRESOS);
      var lastRowIng = sheetIng.getLastRow();
      Logger.log('Ingresos lastRow: ' + lastRowIng);
      if (lastRowIng <= 2) throw new Error('Hoja Ingresos sin datos');
      var dataIng = sheetIng.getRange(3, 1, lastRowIng - 2, INGRESOS_NCOLS).getValues();
      Logger.log('Filas a buscar: ' + dataIng.length + ' | Primera ID: [' + String(dataIng[0][COL_I.ID_TRANS-1]) + ']');
      for (var i = 0; i < dataIng.length; i++) {
        if (String(dataIng[i][COL_I.ID_TRANS-1]) === id) {
          sheetIng.getRange(i+3, COL_I.ESTADO).setValue('anulado');
          sheetIng.getRange(i+3, 1, 1, INGRESOS_NCOLS).setBackground('#FFEBEE');
          Logger.log('✅ Anulado en fila ' + (i+3));
          break;
        }
      }
    } else {
      var sheetEgr = ss.getSheetByName(SHEET_EGRESOS);
      var lastRowEgr = sheetEgr.getLastRow();
      Logger.log('Egresos lastRow: ' + lastRowEgr);
      if (lastRowEgr <= 2) throw new Error('Hoja Egresos sin datos');
      var dataEgr = sheetEgr.getRange(3, 1, lastRowEgr - 2, EGRESOS_NCOLS).getValues();
      Logger.log('Filas a buscar: ' + dataEgr.length + ' | Primera ID: [' + String(dataEgr[0][COL_E.ID-1]) + ']');
      for (var j = 0; j < dataEgr.length; j++) {
        if (String(dataEgr[j][COL_E.ID-1]) === id) {
          sheetEgr.getRange(j+3, COL_E.ESTADO).setValue('anulado');
          sheetEgr.getRange(j+3, 1, 1, EGRESOS_NCOLS).setBackground('#FFEBEE');
          Logger.log('✅ Anulado en fila ' + (j+3));
          break;
        }
      }
    }
    result.success = true;
  } catch(err) {
    result.error = err.message;
    Logger.log('ERROR: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback+'('+json+')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════
//  _handleEliminarRegistro — elimina físicamente la fila del sheet
// ═══════════════════════════════════════════════════════════════

function _handleEliminarRegistro(params, callback) {
  var result = { success: false, error: null };
  try {
    var tipo = params.tipo || '';
    var id   = params.id   || '';
    if (!tipo || !id) throw new Error('tipo e id requeridos');
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);

    if (tipo === 'ingreso') {
      var sheetIng = ss.getSheetByName(CONFIG.SHEET_INGRESOS);
      var lastRowIng = sheetIng.getLastRow();
      if (lastRowIng <= 2) throw new Error('Hoja Ingresos sin datos');
      var dataIng = sheetIng.getRange(3, COL_I.ID_TRANS, lastRowIng - 2, 1).getValues();
      for (var i = 0; i < dataIng.length; i++) {
        if (String(dataIng[i][0]) === id) {
          sheetIng.deleteRow(i + 3);
          Logger.log('🗑️ Ingreso eliminado fila ' + (i + 3) + ' id=' + id);
          break;
        }
      }
    } else {
      var sheetEgr = ss.getSheetByName(SHEET_EGRESOS);
      var lastRowEgr = sheetEgr.getLastRow();
      if (lastRowEgr <= 2) throw new Error('Hoja Egresos sin datos');
      var dataEgr = sheetEgr.getRange(3, COL_E.ID, lastRowEgr - 2, 1).getValues();
      for (var j = 0; j < dataEgr.length; j++) {
        if (String(dataEgr[j][0]) === id) {
          sheetEgr.deleteRow(j + 3);
          Logger.log('🗑️ Egreso eliminado fila ' + (j + 3) + ' id=' + id);
          break;
        }
      }
    }
    result.success = true;
  } catch(err) {
    result.error = err.message;
    Logger.log('ERROR eliminarRegistro: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════
//  CATÁLOGO UNIFICADO DGI — Gastos Deducibles
//  Formulario Persona Jurídica General (e-Tax 2.0)
//  Secciones COSTOS (líneas 27-41) y GASTOS (líneas 42-77)
//  v2.0 — alineado con formulario oficial DGI Panamá
//  Los COSTOS son inmutables desde el P&L (vienen de ST_Items).
//  Solo los GASTOS son reclasificables por el usuario.
// ═══════════════════════════════════════════════════════════════

// ── COSTOS DIRECTOS (Líneas 27-41 formulario DGI) ────────────
var TIPOS_COSTO_DIRECTO = [
  { valor: 'costo_mercancia',         label: 'Costo de mercancía / inventario',   linea_dgi: '28-34' },
  { valor: 'costo_servicio_tecnico',  label: 'Costo de servicio técnico',         linea_dgi: '35'    },
  { valor: 'impuesto_aduana',         label: 'Impuesto / Aduana (importación)',   linea_dgi: '35'    },
  { valor: 'credito_fiscal',          label: 'Crédito fiscal ITBMS',              linea_dgi: 'ITBMS' },
];

// ── GASTOS OPERATIVOS (Líneas 42-77 formulario DGI) ──────────
// Reclasificables por el usuario desde el P&L
var CATEGORIAS_GASTO_DGI = [
  { valor: 'nomina',                   label: 'Nómina / Salarios',                linea_dgi: '42',    emoji: '👤' },
  { valor: 'prestaciones_laborales',   label: 'Prestaciones laborales',           linea_dgi: '43',    emoji: '👥' },
  { valor: 'gastos_representacion',    label: 'Gastos de representación',         linea_dgi: '44',    emoji: '🤝' },
  { valor: 'alquileres',               label: 'Alquileres',                       linea_dgi: '46',    emoji: '🏠' },
  { valor: 'cargos_bancarios',         label: 'Cargos bancarios',                 linea_dgi: '53',    emoji: '🏦' },
  { valor: 'vigilancia_seguridad',     label: 'Vigilancia y seguridad',           linea_dgi: '54',    emoji: '🔒' },
  { valor: 'gastos_financieros',       label: 'Intereses y gastos financieros',   linea_dgi: '55',    emoji: '📊' },
  { valor: 'combustible_transporte',   label: 'Combustible y transporte',         linea_dgi: '56',    emoji: '⛽' },
  { valor: 'depreciacion',             label: 'Depreciación',                     linea_dgi: '57',    emoji: '📉' },
  { valor: 'amortizacion',             label: 'Amortización',                     linea_dgi: '58',    emoji: '📋' },
  { valor: 'impuestos_tasas',          label: 'Impuestos y tasas municipales',    linea_dgi: '59',    emoji: '🏛️' },
  { valor: 'honorarios_profesionales', label: 'Honorarios profesionales',         linea_dgi: '60',    emoji: '💼' },
  { valor: 'seguros',                  label: 'Seguros',                          linea_dgi: '63-66', emoji: '🛡️' },
  { valor: 'mantenimiento_reparacion', label: 'Mantenimiento y reparaciones',     linea_dgi: '67',    emoji: '🔧' },
  { valor: 'publicidad_mercadeo',      label: 'Publicidad y mercadeo',            linea_dgi: '68',    emoji: '📣' },
  { valor: 'gastos_oficina',           label: 'Gastos de oficina y suministros',  linea_dgi: '69',    emoji: '🖇️' },
  { valor: 'telecomunicaciones',       label: 'Internet y telecomunicaciones',    linea_dgi: '71',    emoji: '📶' },
  { valor: 'servicios_publicos',       label: 'Servicios públicos (agua, luz)',   linea_dgi: '75',    emoji: '💡' },
  { valor: 'tecnologia_software',      label: 'Tecnología y software',            linea_dgi: '76',    emoji: '💻' },
  { valor: 'capacitacion',             label: 'Capacitación y formación',         linea_dgi: '76',    emoji: '📚' },
  // ── Costos de Ventas (Anexo 94 DGI - Estado de Costo de Ventas) ──
  // Detalle por línea del Anexo 94. Para clientes sin módulo
  // Comercialización que necesitan registrar costos directos por
  // categoría. Reducen Utilidad Bruta (no son gastos operativos).
  { valor: 'compras_locales',          label: 'Compras locales',                  linea_dgi: '28',    emoji: '🛍️' },
  { valor: 'compras_importadas',       label: 'Compras importadas',               linea_dgi: '29',    emoji: '📦' },
  { valor: 'salarios_costo',           label: 'Salarios y remuneraciones (Costo)',linea_dgi: '30',    emoji: '👤' },
  { valor: 'depreciacion_costo',       label: 'Depreciación (Costo)',             linea_dgi: '31',    emoji: '📉' },
  { valor: 'mantenimiento_costo',      label: 'Mantenimiento (Costo)',            linea_dgi: '32',    emoji: '🔧' },
  { valor: 'servicios_costo',          label: 'Electricidad, agua y tel. (Costo)',linea_dgi: '33',    emoji: '💡' },
  { valor: 'seguros_costo',            label: 'Seguros (Costo)',                  linea_dgi: '34',    emoji: '🛡️' },
  { valor: 'otros_costos_venta',       label: 'Otros costos de venta',            linea_dgi: '35',    emoji: '🛒' },
  { valor: 'otros_deducibles',         label: 'Otros gastos deducibles',          linea_dgi: '77',    emoji: '📋' },
  // ── Deducibles Personales (ISR persona natural) ──
  { valor: 'deducibles_personales',           label: 'Deducibles Personales',          linea_dgi: 'DP',  emoji: '👨‍👩‍👧' },
  { valor: 'gastos_medicos',                  label: 'Gastos médicos',                  linea_dgi: 'DP-1', emoji: '🏥' },
  { valor: 'gastos_escolares',                label: 'Gastos escolares',                linea_dgi: 'DP-2', emoji: '📖' },
  { valor: 'intereses_hipotecarios',          label: 'Intereses hipotecarios',          linea_dgi: 'DP-3', emoji: '🏡' },
  { valor: 'intereses_prestamos_educativos',  label: 'Intereses préstamos educativos',  linea_dgi: 'DP-4', emoji: '🎓' },
  { valor: 'gastos_escolares_discapacitados', label: 'Gastos escolares discapacitados', linea_dgi: 'DP-5', emoji: '♿' },
];

// Categorías que cuentan como COSTO DE VENTAS (Anexo 94 L28-L35), no
// como gasto operativo. Reducen Utilidad Bruta en el P&L y agregan
// al Costo de Ventas en el reporte anual DGI.
var COSTO_KEYS_ANEXO94 = [
  'compras_locales',
  'compras_importadas',
  'salarios_costo',
  'depreciacion_costo',
  'mantenimiento_costo',
  'servicios_costo',
  'seguros_costo',
  'otros_costos_venta',
];

// ════════════════════════════════════════════════════════════════════
//  CATEGORIAS_INGRESO_DGI — catálogo oficial Formulario 91/93 DGI Panamá
//  Cada entrada mapea a una línea exacta del formulario. Campos:
//    valor:           key interna (snake_case, estable, no cambia)
//    label:           nombre legible
//    linea:           número de línea en Form 91/93
//    seccion:         'remuneracion' | 'actividad' | 'sustractivo' | 'especial'
//    emoji:           icono UI
//    itbms_status:    'gravado' | 'exento' | 'no_aplica'
//    itbms_rate:      0 | 7 | 10 (% — solo si gravado; 0 si exento/no_aplica)
//    retencion_rate:  número decimal o null (ej. 0.08 = 8%)
//    retencion_tipo:  string descriptivo de cuándo aplica retención
//    signo:           1 (suma) | -1 (resta, para sustractivos)
//    hint:            texto contextual mostrado en el modal
// ════════════════════════════════════════════════════════════════════
var CATEGORIAS_INGRESO_DGI = [
  // ── Segmento A: Remuneraciones personales (Form 91 sección Salarios) ──
  { valor: 'salarios_con_retencion',     label: 'Salarios y otras remuneraciones (c/retención)',  linea: '1',  seccion: 'remuneracion', emoji: '💼',
    itbms_status: 'no_aplica', itbms_rate: 0,  retencion_rate: null, retencion_tipo: 'Escala empleador (planilla)', signo: 1,
    hint: 'Salario con retención mensual ya aplicada por el empleador. La escala ISR depende del nivel anual.' },
  { valor: 'remuneracion_sin_retencion', label: 'Otras remuneraciones personales (s/retención)',  linea: '2',  seccion: 'remuneracion', emoji: '💵',
    itbms_status: 'no_aplica', itbms_rate: 0,  retencion_rate: null, retencion_tipo: null, signo: 1,
    hint: 'Remuneración no sujeta a retención del empleador. El contribuyente declara directo.' },
  { valor: 'ingresos_especies',          label: 'Ingresos en especies',                            linea: '3',  seccion: 'remuneracion', emoji: '🎁',
    itbms_status: 'no_aplica', itbms_rate: 0,  retencion_rate: null, retencion_tipo: null, signo: 1,
    hint: 'Registra el equivalente monetario al valor de mercado del bien/servicio recibido.' },
  { valor: 'gastos_repr_asalariado',     label: 'Gastos de Representación (asalariado)',           linea: '4',  seccion: 'remuneracion', emoji: '🤝',
    itbms_status: 'no_aplica', itbms_rate: 0,  retencion_rate: 0.10, retencion_tipo: '10% flat (régimen separado)', signo: 1,
    hint: 'Régimen separado: tributa 10% flat, no por escala. Retención típica por empleador.' },
  { valor: 'dietas',                     label: 'Dietas',                                          linea: '5',  seccion: 'remuneracion', emoji: '📅',
    itbms_status: 'no_aplica', itbms_rate: 0,  retencion_rate: null, retencion_tipo: null, signo: 1,
    hint: 'Pagos por participación en juntas/sesiones. Tributa según escala ISR.' },

  // ── Segmento B: Ingresos por Actividad y/o Profesión ──
  { valor: 'actividad_agropecuaria',     label: 'Actividad Agropecuaria',                          linea: '6',  seccion: 'actividad', emoji: '🌾',
    itbms_status: 'exento',    itbms_rate: 0,  retencion_rate: null, retencion_tipo: null, signo: 1,
    hint: 'Productores con ingresos < B/. 250,000/año están exentos de ISR (Ley 8/2010). Verifica umbral anual.' },
  { valor: 'honorarios_comision',        label: 'Honorarios por Comisiones',                       linea: '7',  seccion: 'actividad', emoji: '💳',
    itbms_status: 'gravado',   itbms_rate: 7,  retencion_rate: 0.08, retencion_tipo: '8% si cliente es retentor designado', signo: 1,
    hint: 'ITBMS 7% sobre comisiones. Retención 8% si el cliente es Estado/Gran Contribuyente o retentor designado.' },
  { valor: 'honorarios_profesionales',   label: 'Honorarios por Servicios Profesionales',          linea: '8',  seccion: 'actividad', emoji: '💼',
    itbms_status: 'gravado',   itbms_rate: 7,  retencion_rate: 0.08, retencion_tipo: '8% si cliente es retentor designado', signo: 1,
    hint: 'ITBMS 7% si emites factura como contribuyente ITBMS. Retención 8% si tu cliente es retentor designado.' },
  { valor: 'alquiler_habitacional',      label: 'Alquiler Habitacional',                           linea: '9',  seccion: 'actividad', emoji: '🏠',
    itbms_status: 'exento',    itbms_rate: 0,  retencion_rate: null, retencion_tipo: null, signo: 1,
    hint: 'Exento de ITBMS por ley (vivienda). Sí tributa ISR sobre renta neta (deducibles: mantenimiento, IBI, depreciación).' },
  { valor: 'alquiler_comercial',         label: 'Alquiler Comercial',                              linea: '10', seccion: 'actividad', emoji: '🏢',
    itbms_status: 'gravado',   itbms_rate: 7,  retencion_rate: null, retencion_tipo: null, signo: 1,
    hint: 'ITBMS 7% sobre la renta. Deducibles: mantenimiento, IBI, depreciación del inmueble.' },
  { valor: 'intereses_financieros',      label: 'Intereses y otros Ingresos Financieros',          linea: '11', seccion: 'actividad', emoji: '🏦',
    itbms_status: 'no_aplica', itbms_rate: 0,  retencion_rate: 0.05, retencion_tipo: '5% retenido por institución (productos sujetos)', signo: 1,
    hint: 'Cuentas de ahorro PN exentas hasta cierto umbral. Otros productos: 5% retenido por el banco/institución.' },
  { valor: 'ganancia_capital_legacy',    label: 'Ganancia capital (pre-Ley 18/2006)',              linea: '12', seccion: 'actividad', emoji: '📉',
    itbms_status: 'no_aplica', itbms_rate: 0,  retencion_rate: 0.10, retencion_tipo: '10% flat (régimen histórico)', signo: 1,
    hint: 'Régimen legacy casi obsoleto. Para ganancias actuales de valores ver Form 106.' },
  { valor: 'otros_ingresos',             label: 'Otros Ingresos',                                  linea: '13', seccion: 'actividad', emoji: '📋',
    itbms_status: 'gravado',   itbms_rate: 7,  retencion_rate: null, retencion_tipo: null, signo: 1,
    hint: 'Catch-all para ingresos sin línea específica. Revisa ITBMS y retención manualmente.' },
  { valor: 'ventas_servicios',           label: 'Ventas y Prestación de Servicios',                linea: '14', seccion: 'actividad', emoji: '🛒',
    itbms_status: 'gravado',   itbms_rate: 7,  retencion_rate: null, retencion_tipo: null, signo: 1,
    hint: 'El bulk de la actividad comercial/servicios. ITBMS 7% default. 10% en alcohol/tabaco/hospedaje. Exento en canasta básica.' },

  // ── Sustractivos (restan de la base gravable) ──
  { valor: 'devoluciones_descuentos',    label: 'Menos: Devoluciones y Descuentos',                linea: '15', seccion: 'sustractivo', emoji: '↩️',
    itbms_status: 'gravado',   itbms_rate: 7,  retencion_rate: null, retencion_tipo: null, signo: -1,
    hint: 'Notas crédito y descuentos comerciales. Ingresa el monto positivo; el sistema lo resta automáticamente.' },
  { valor: 'descuento_jubilados',        label: 'Menos: Descuento Jubilados (Farmacias) Ley 6/87', linea: '16', seccion: 'sustractivo', emoji: '👵',
    itbms_status: 'exento',    itbms_rate: 0,  retencion_rate: null, retencion_tipo: null, signo: -1,
    hint: 'Solo aplica a farmacias. 20% descuento de ley a jubilados, deducible de la base.' },

  // ── Especiales (clasificación con tratamiento DGI distinto) ──
  { valor: 'ingresos_exentos',           label: 'Ingresos Exentos / No Gravables',                 linea: '17', seccion: 'especial', emoji: '🛡️',
    itbms_status: 'no_aplica', itbms_rate: 0,  retencion_rate: null, retencion_tipo: null, signo: 1,
    hint: 'No suman a renta gravable: dividendos locales con ISR ya pagado, donaciones no comerciales, etc.' },
  { valor: 'fuente_extranjera',          label: 'Fuente Extranjera',                               linea: '18', seccion: 'especial', emoji: '🌎',
    itbms_status: 'no_aplica', itbms_rate: 0,  retencion_rate: null, retencion_tipo: null, signo: 1,
    hint: 'Renta producida fuera de Panamá. Por principio de territorialidad NO tributa ISR Panamá.' },
  { valor: 'gastos_repr_actividad',      label: 'Gastos de Representación (actividad)',            linea: '19', seccion: 'especial', emoji: '🎯',
    itbms_status: 'no_aplica', itbms_rate: 0,  retencion_rate: 0.10, retencion_tipo: '10% flat', signo: 1,
    hint: 'Gastos de representación recibidos como parte de actividad/profesión. 10% flat.' },
];

// Mapping legacy → nueva key, para que datos viejos sigan funcionando
// (frontend usa este mapa al leer registros antiguos).
var LEGACY_INGRESO_MAP = {
  'venta_producto_gravado':   'ventas_servicios',
  'venta_producto_exento':    'ventas_servicios',
  'servicio_tecnico_gravado': 'ventas_servicios',
  'servicio_tecnico_exento':  'ventas_servicios',
  'asesoria_consultoria':     'honorarios_profesionales',
  'servicios_profesionales':  'honorarios_profesionales',
  'salarios':                 'salarios_con_retencion',
  'comision':                 'honorarios_comision',
  'alquiler_cobrado':         'alquiler_comercial',
  'intereses':                'intereses_financieros',
  'dividendos':               'otros_ingresos',
  'exportacion':              'ventas_servicios',
  'otro_gravado':             'otros_ingresos',
  'otro_exento':              'ingresos_exentos',
};

// ═══════════════════════════════════════════════════════════════
//  _handleReclasificarEgreso
//  Actualiza tipo_egreso en hoja Egresos.
//  Solo aplica a egresos de Registro General (sin id_st_item, sin id_item_cv).
//  Params: id_egreso, nuevo_tipo (debe estar en CATEGORIAS_GASTO_DGI)
// ═══════════════════════════════════════════════════════════════
function _handleReclasificarEgreso(params, callback) {
  var result = { success: false, error: null };
  try {
    var idEgreso  = String(params.id_egreso  || '').trim();
    var nuevoTipo = String(params.nuevo_tipo || '').trim();
    if (!idEgreso)  throw new Error('id_egreso requerido');
    if (!nuevoTipo) throw new Error('nuevo_tipo requerido');

    // Validar que el nuevo tipo esté en el catálogo de gastos (no costos)
    var valido = false;
    for (var c = 0; c < CATEGORIAS_GASTO_DGI.length; c++) {
      if (CATEGORIAS_GASTO_DGI[c].valor === nuevoTipo) { valido = true; break; }
    }
    if (!valido) throw new Error('Tipo no válido: ' + nuevoTipo + '. Debe ser un gasto operativo DGI.');

    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_EGRESOS);
    if (!sheet) throw new Error('Hoja Egresos no encontrada');

    var lastRow = sheet.getLastRow();
    if (lastRow <= 2) throw new Error('Hoja Egresos vacía');

    var data  = sheet.getRange(3, 1, lastRow - 2, EGRESOS_NCOLS).getValues();
    var found = false;

    for (var i = 0; i < data.length; i++) {
      if (String(data[i][COL_E.ID - 1] || '').trim() !== idEgreso) continue;

      // Verificar que es un egreso de Registro General (no vinculado a ST ni CV)
      var idST = String(data[i][COL_E.ID_ST_ITEM - 1] || '').trim();
      var idCV = String(data[i][COL_E.ID_ITEM_CV - 1] || '').trim();
      if (idST || idCV) {
        throw new Error('Solo se pueden reclasificar egresos de Registro General (sin vínculo a ST o CV).');
      }

      var rowNum    = i + 3;
      var tipoAnterior = String(data[i][COL_E.TIPO_EGRESO - 1] || '');
      var stamp        = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm');

      // Actualizar tipo_egreso y categoria
      sheet.getRange(rowNum, COL_E.TIPO_EGRESO).setValue(nuevoTipo);
      sheet.getRange(rowNum, COL_E.CATEGORIA).setValue(nuevoTipo);

      // Registrar el cambio en notas
      var notasActual = String(sheet.getRange(rowNum, COL_E.NOTAS).getValue() || '');
      var notaReclasif = 'Reclasificado: ' + tipoAnterior + ' → ' + nuevoTipo + ' | ' + stamp;
      sheet.getRange(rowNum, COL_E.NOTAS).setValue(
        notasActual ? notasActual + ' | ' + notaReclasif : notaReclasif
      );

      result.success      = true;
      result.tipo_anterior = tipoAnterior;
      result.tipo_nuevo    = nuevoTipo;
      found = true;
      Logger.log('✅ Reclasificado egreso ' + idEgreso + ': ' + tipoAnterior + ' → ' + nuevoTipo);
      break;
    }

    if (!found) throw new Error('Egreso no encontrado: ' + idEgreso);

  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleReclasificarEgreso: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════
//  _handleGetCatalogoGastos
//  Devuelve CATEGORIAS_GASTO_DGI para que el frontend se sincronice.
// ═══════════════════════════════════════════════════════════════
function _handleGetCatalogoGastos(params, callback) {
  var result = { success: true, categorias: CATEGORIAS_GASTO_DGI, costos: TIPOS_COSTO_DIRECTO };
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function _handleActualizarCategoria(params, callback) {
  var result = { success: false, error: null };
  try {
    var tipo      = params.tipo      || '';
    var id        = params.id        || '';
    var categoria = params.categoria || '';
    if (!tipo || !id || !categoria) throw new Error('tipo, id y categoria requeridos');
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);

    if (tipo === 'ingreso') {
      var sheetIng2 = ss.getSheetByName(CONFIG.SHEET_INGRESOS);
      var dataIng2  = sheetIng2.getRange(3, 1, sheetIng2.getLastRow()-2, INGRESOS_NCOLS).getValues();
      for (var i = 0; i < dataIng2.length; i++) {
        if (String(dataIng2[i][COL_I.ID_TRANS-1]) === id) {
          sheetIng2.getRange(i+3, COL_I.CATEGORIA).setValue(categoria);
          break;
        }
      }
    } else {
      // Egresos: actualizar AMBOS campos para mantenerlos en sync
      // tipo_egreso es la fuente del P&L, categoria es la fuente de Registro General
      var sheetEgr2 = ss.getSheetByName(SHEET_EGRESOS);
      var dataEgr2  = sheetEgr2.getRange(3, 1, sheetEgr2.getLastRow()-2, EGRESOS_NCOLS).getValues();
      for (var j = 0; j < dataEgr2.length; j++) {
        if (String(dataEgr2[j][COL_E.ID-1]) === id) {
          var rowNum = j + 3;
          sheetEgr2.getRange(rowNum, COL_E.TIPO_EGRESO).setValue(categoria);
          sheetEgr2.getRange(rowNum, COL_E.CATEGORIA).setValue(categoria);
          break;
        }
      }
    }
    result.success = true;
  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleActualizarCategoria: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback+'('+json+')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════
//  _handleConfirmarIngreso  ← v12.3
//  Cambia el estado de un ingreso a 'confirmado' y opcionalmente
//  actualiza drive_url con el comprobante de pago del cliente.
//  Llamado desde servicios_tecnicos.html al registrar pago completo.
// ═══════════════════════════════════════════════════════════════

function _handleConfirmarIngreso(params, callback) {
  var result = { success: false, error: null };
  try {
    var ingresoId = String(params.ingreso_id || '').trim();
    var driveUrl  = String(params.drive_url  || '').trim();

    if (!ingresoId) throw new Error('ingreso_id requerido');

    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(CONFIG.SHEET_INGRESOS);
    if (!sheet) throw new Error('Hoja Ingresos no encontrada');

    var lastRow = sheet.getLastRow();
    if (lastRow <= 2) throw new Error('Hoja Ingresos vacía');

    var numRows = lastRow - 2;
    var ids     = sheet.getRange(3, COL_I.ID_TRANS, numRows, 1).getValues();
    var found   = false;

    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0] || '').trim() !== ingresoId) continue;

      var rowNum       = i + 3;
      var estadoActual = String(sheet.getRange(rowNum, COL_I.ESTADO).getValue() || '');

      if (estadoActual === 'anulado') {
        throw new Error('No se puede confirmar un ingreso anulado');
      }

      sheet.getRange(rowNum, COL_I.ESTADO).setValue('confirmado');
      sheet.getRange(rowNum, 1, 1, INGRESOS_NCOLS).setBackground('#F1F8E9');

      if (driveUrl) {
        sheet.getRange(rowNum, COL_I.DRIVE_URL).setValue(driveUrl);
      }

      var stamp   = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm');
      var notaAct = String(sheet.getRange(rowNum, COL_I.NOTAS_INT).getValue() || '');
      sheet.getRange(rowNum, COL_I.NOTAS_INT).setValue(
        notaAct + ' | Confirmado: ' + stamp +
        (estadoActual !== 'confirmado' ? ' (era: ' + estadoActual + ')' : '')
      );

      found = true;
      Logger.log('✅ Ingreso confirmado: ' + ingresoId + ' (era: ' + estadoActual + ')');
      break;
    }

    if (!found) throw new Error('Ingreso no encontrado: ' + ingresoId);
    result.success = true;

  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleConfirmarIngreso: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════
//  _handleGetPL  — Estado de Resultados server-side
//  Fuente canónica de COGS: ST_Items (agrupado por ST.mes/anio)
//  + egresos "Costo venta" de Compras_Ventas
//  Parámetros opcionales: mes (1-12), anio (ej 2026)
//  Sin parámetros → devuelve todos los períodos disponibles
//  Respuesta:
//    { success, periodos: { "2026-3": { mes, anio, ing, cogs, gastos, itbms_cobrado,
//                                       itbms_pagado, ub, un, ingresos:[], egresos:[] } } }
// ═══════════════════════════════════════════════════════════════
function _handleGetPL(params, callback) {
  var result = { success: false, periodos: {}, error: null };
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);

    // ── Leer Ingresos ─────────────────────────────────────────
    var sheetIng = ss.getSheetByName(CONFIG.SHEET_INGRESOS);
    var ingRows  = sheetIng && sheetIng.getLastRow() > 2
      ? sheetIng.getRange(3, 1, sheetIng.getLastRow() - 2, INGRESOS_NCOLS).getValues()
      : [];

    // Mapa de drive_url del ST (factura emitida) para ingresos
    var maps  = _buildStUrlMaps(ss);
    var stMap = maps.stMap;

    // ── Leer ST (para mapa id_st → mes/anio) ─────────────────
    var sheetST  = ss.getSheetByName(SHEET_ST);
    var stMesMap = {};   // id_st → { mes, anio }
    if (sheetST && sheetST.getLastRow() > 2) {
      var stData = sheetST.getRange(3, 1, sheetST.getLastRow() - 2, ST_NCOLS).getValues();
      for (var s = 0; s < stData.length; s++) {
        var sr   = stData[s];
        var stId = String(sr[COL_ST.ID - 1] || '').trim();
        if (!stId) continue;
        stMesMap[stId] = {
          mes:  parseInt(sr[COL_ST.MES  - 1]) || 0,
          anio: parseInt(sr[COL_ST.ANIO - 1]) || 0,
        };
      }
    }

    // ── Leer ST_Items ─────────────────────────────────────────
    var sheetSTI = ss.getSheetByName(SHEET_ST_ITEM);
    var stiRows  = sheetSTI && sheetSTI.getLastRow() > 2
      ? sheetSTI.getRange(3, 1, sheetSTI.getLastRow() - 2, STI_NCOLS).getValues()
      : [];

    // ── Leer Egresos (solo para itbms_pagado y egresos CV) ────
    var sheetEgr = ss.getSheetByName(SHEET_EGRESOS);
    var egrRows  = sheetEgr && sheetEgr.getLastRow() > 2
      ? sheetEgr.getRange(3, 1, sheetEgr.getLastRow() - 2, EGRESOS_NCOLS).getValues()
      : [];

    // Tipos de STI que van a COGS
    var TIPOS_COGS_STI = { producto: true, shipping_handling: true, impuesto: true };

    var periodos = {};

    function getPeriodo(mes, anio) {
      var key = anio + '-' + mes;
      if (!periodos[key]) {
        periodos[key] = {
          mes: mes, anio: anio,
          ing: 0, subtotal: 0, itbms_cobrado: 0,
          cogs: 0, gastos: 0, itbms_pagado: 0,
          ingresos: [], egresos_gasto: [], cogs_items: [],
        };
      }
      return periodos[key];
    }

    // ── Procesar Ingresos ─────────────────────────────────────
    for (var i = 0; i < ingRows.length; i++) {
      var r   = ingRows[i];
      if (!r[COL_I.ID_TRANS - 1]) continue;
      if (String(r[COL_I.ESTADO - 1]).toLowerCase() === 'anulado') continue;

      var mes  = parseInt(r[COL_I.MES        - 1]) || 0;
      var anio = parseInt(r[COL_I.ANIO_FISCAL - 1]) || 0;
      // Fallback: derivar de fecha_ingreso si MES/ANIO_FISCAL vienen vacíos (registros legacy/importados)
      if (!mes || !anio) {
        var fIng = r[COL_I.FECHA_INGRESO - 1];
        var dI   = (fIng instanceof Date) ? fIng : new Date(String(fIng || '') + 'T12:00:00');
        if (!isNaN(dI.getTime())) {
          if (!mes)  mes  = dI.getMonth() + 1;
          if (!anio) anio = dI.getFullYear();
        }
      }
      if (!mes || !anio) continue;

      var subtotal = parseFloat(r[COL_I.SUBTOTAL - 1]) || 0;
      var itbms    = parseFloat(r[COL_I.ITBMS    - 1]) || 0;
      var total    = parseFloat(r[COL_I.TOTAL     - 1]) || 0;

      var notas    = String(r[COL_I.NOTAS_INT - 1] || '');
      var driveUrl = String(r[COL_I.DRIVE_URL  - 1] || '').trim();
      var stId     = _extractStId(notas);
      if (stId && stMap[stId]) driveUrl = stMap[stId];

      var p = getPeriodo(mes, anio);
      p.subtotal     += subtotal;
      p.itbms_cobrado+= itbms;
      p.ing          += total;

      var fechaIng = r[COL_I.FECHA_INGRESO - 1];
      if (fechaIng instanceof Date) {
        fechaIng = Utilities.formatDate(fechaIng, 'America/Panama', 'yyyy-MM-dd');
      } else {
        fechaIng = String(fechaIng || '').slice(0, 10);
      }

      p.ingresos.push({
        id:             r[COL_I.ID_TRANS    - 1],
        nombre_cliente: r[COL_I.NOMBRE_CLI  - 1] || '',
        num_factura:    r[COL_I.NUM_FACTURA  - 1] || '',
        tipo_ingreso:   r[COL_I.TIPO_INGRESO - 1] || '',
        subtotal:       subtotal,
        itbms:          itbms,
        total:          total,
        fecha:          fechaIng,
        drive_url:      driveUrl,
        estado:         String(r[COL_I.ESTADO - 1] || '').toLowerCase(),
        notas:          String(r[COL_I.NOTAS_INT  - 1] || ''),
      });
    }

    // ── Procesar ST_Items → COGS por período ─────────────────
    for (var j = 0; j < stiRows.length; j++) {
      var sr = stiRows[j];
      if (!sr[COL_STI.ID - 1]) continue;
      if (String(sr[COL_STI.ESTADO_ITEM - 1]).toLowerCase() === 'cancelado') continue;

      var tipo      = String(sr[COL_STI.TIPO - 1] || '').toLowerCase();
      if (!TIPOS_COGS_STI[tipo]) continue;   // solo producto/shipping_handling/impuesto

      var idST = String(sr[COL_STI.ID_ST - 1] || '').trim();
      var stPeriodo = stMesMap[idST];
      if (!stPeriodo || !stPeriodo.mes || !stPeriodo.anio) continue;

      var totalReal = parseFloat(sr[COL_STI.TOTAL_REAL - 1]) || 0;
      var totalCot  = parseFloat(sr[COL_STI.TOTAL_COT  - 1]) || 0;
      var monto     = totalReal > 0 ? totalReal : totalCot;
      var per = getPeriodo(stPeriodo.mes, stPeriodo.anio);
      per.cogs += monto;
      per.cogs_items.push({
        id_st:       idST,
        tipo:        tipo,
        descripcion: String(sr[COL_STI.DESCRIPCION - 1] || ''),
        proveedor:   '',   // se enriquece desde egresoMap abajo si hay egreso_id
        egreso_id:   String(sr[COL_STI.EGRESO_ID   - 1] || '').trim(),
        drive_url:   String(sr[COL_STI.DRIVE_URL   - 1] || '').trim(),
        monto:       monto,
        origen:      'ST',
      });
    }

    // ── Procesar Egresos: itbms_pagado + gastos op + CV costo ─
    for (var k = 0; k < egrRows.length; k++) {
      var er = egrRows[k];
      if (!er[COL_E.ID - 1]) continue;
      if (String(er[COL_E.ESTADO - 1]).toLowerCase() === 'anulado') continue;
      // Excluir gastos personales del P&L — no deducibles, no afectan DGI
      if (String(er[COL_E.ALCANCE - 1] || 'negocio').toLowerCase() === 'personal') continue;

      var eMes  = parseInt(er[COL_E.MES  - 1]) || 0;
      var eAnio = parseInt(er[COL_E.ANIO - 1]) || 0;
      // Fallback: derivar de fecha_egreso si MES/ANIO vienen vacíos (registros legacy/importados)
      if (!eMes || !eAnio) {
        var fEgr = er[COL_E.FECHA_GASTO - 1];
        var dE   = (fEgr instanceof Date) ? fEgr : new Date(String(fEgr || '') + 'T12:00:00');
        if (!isNaN(dE.getTime())) {
          if (!eMes)  eMes  = dE.getMonth() + 1;
          if (!eAnio) eAnio = dE.getFullYear();
        }
      }
      if (!eMes || !eAnio) continue;

      var eTipo  = String(er[COL_E.TIPO_EGRESO - 1] || '').toLowerCase();
      var eTotal = parseFloat(er[COL_E.TOTAL   - 1]) || 0;
      var eItbms = parseFloat(er[COL_E.ITBMS   - 1]) || 0;
      var eNotas = String(er[COL_E.NOTAS - 1] || '');
      var p      = getPeriodo(eMes, eAnio);

      // ITBMS pagado = columna itbms de TODOS los egresos
      p.itbms_pagado += eItbms;

      // Egresos de Compras_Ventas (costo_mercancia con nota "Costo venta") → COGS
      if (eTipo === 'costo_mercancia' && eNotas.indexOf('Costo venta') !== -1) {
        p.cogs += eTotal;
        p.cogs_items.push({
          id_st:       String(er[COL_E.ID_ITEM_CV - 1] || ''),
          tipo:        'producto',
          descripcion: String(er[COL_E.DESCRIPCION - 1] || ''),
          proveedor:   String(er[COL_E.PROVEEDOR   - 1] || ''),
          egreso_id:   String(er[COL_E.ID          - 1] || ''),
          drive_url:   String(er[COL_E.DRIVE_URL   - 1] || '').trim(),
          monto:       eTotal,
          origen:      'COM',
        });
        continue;
      }

      // credito_fiscal se excluye del P&L (es partida DGI)
      if (eTipo === 'credito_fiscal') continue;
      // costo_mercancia y costo_servicio_tecnico ya están en ST_Items → saltar
      if (eTipo === 'costo_mercancia' || eTipo === 'costo_servicio_tecnico') continue;
      // impuesto_aduana / impuesto_importacion cubiertos por ST_Items → saltar
      if (eTipo === 'impuesto_aduana' || eTipo === 'impuesto_importacion') continue;
      // Cualquier egreso con id_st_item ya está contabilizado en ST_Items → saltar
      var eStItem = String(er[COL_E.ID_ST_ITEM - 1] || '').trim();
      if (eStItem) continue;

      // Categorías Anexo 94 L28-L35 → Costo de Ventas (no gasto operativo).
      // Reducen Utilidad Bruta. Para mobile P&L que consume estos
      // totales directamente del backend.
      if (COSTO_KEYS_ANEXO94.indexOf(eTipo) !== -1) {
        p.cogs += eTotal;
        p.cogs_items.push({
          id_st:       '',
          tipo:        eTipo,
          descripcion: String(er[COL_E.DESCRIPCION - 1] || ''),
          proveedor:   String(er[COL_E.PROVEEDOR   - 1] || ''),
          egreso_id:   String(er[COL_E.ID          - 1] || ''),
          drive_url:   String(er[COL_E.DRIVE_URL   - 1] || '').trim(),
          monto:       eTotal,
          origen:      'GRAL',
        });
        continue;
      }

      // Lo que queda son gastos operativos reales sin vínculo a ST
      p.gastos += eTotal;
      p.egresos_gasto.push({
        id:          er[COL_E.ID         - 1],
        proveedor:   er[COL_E.PROVEEDOR  - 1] || '',
        descripcion: er[COL_E.DESCRIPCION- 1] || '',
        tipo_egreso: eTipo,
        total:       eTotal,
        itbms:       eItbms,
        mes:         eMes,
        anio:        eAnio,
        alcance:     String(er[COL_E.ALCANCE - 1] || 'negocio'),
        drive_url:   String(er[COL_E.DRIVE_URL - 1] || '').trim(),
      });
    }

    // ── Enriquecer proveedor en cogs_items desde egresoMap ───
    // egresoMap fue construido en _handleGetCotizaciones — reusarlo aquí
    // Lo reconstruimos desde los egrRows que ya leímos
    var eMap = {};
    for (var em = 0; em < egrRows.length; em++) {
      var eid = String(egrRows[em][COL_E.ID - 1] || '').trim();
      if (!eid) continue;
      eMap[eid] = {
        proveedor: String(egrRows[em][COL_E.PROVEEDOR - 1] || ''),
        drive_url: String(egrRows[em][COL_E.DRIVE_URL - 1] || '').trim(),
      };
    }

    // ── Calcular UB / UN por período ──────────────────────────
    for (var key in periodos) {
      var p      = periodos[key];
      p.ub       = p.subtotal - p.cogs;
      p.un       = p.ub - p.gastos;
      p.itbms_neto = p.itbms_cobrado - p.itbms_pagado;
      // Enriquecer proveedor en cogs_items
      for (var ci = 0; ci < p.cogs_items.length; ci++) {
        var item = p.cogs_items[ci];
        if (item.egreso_id && eMap[item.egreso_id]) {
          if (!item.proveedor)  item.proveedor  = eMap[item.egreso_id].proveedor;
          if (!item.drive_url)  item.drive_url  = eMap[item.egreso_id].drive_url;
        }
      }
      // Ordenar ingresos por fecha desc
      p.ingresos.sort(function(a, b) {
        return String(b.fecha).localeCompare(String(a.fecha));
      });
    }

    result.success  = true;
    result.periodos = periodos;

  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleGetPL: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════
//  MIGRACIÓN ONE-SHOT — Parsea XMLs legacy y popula factura_data
//  Correr manualmente desde el editor GAS:
//    migrarFacturasXmlLegacy()
//  Procesa Ingresos y Egresos. Solo toca filas con drive_url cuyo
//  archivo en Drive sea XML y que aún no tengan factura_data.
//  Idempotente — saltea filas ya procesadas.
// ═══════════════════════════════════════════════════════════════

// Detecta si el JSON ya guardado en factura_data tiene contenido útil.
// Endurecido v2: requiere emisor.ruc (campo obligatorio en FE Panamá).
// Si está vacío o el parser viejo no lo extrajo, reprocesa.
function _facturaDataEsUtil(jsonStr) {
  if (!jsonStr) return false;
  try {
    var d = JSON.parse(jsonStr);
    if (!d) return false;
    if (d.emisor && d.emisor.ruc) return true;
    return false;
  } catch(_) {
    return false;
  }
}

function migrarFacturasXmlLegacy() {
  var stats = { ingresos: { ok:0, reproc:0, skip:0, err:0 }, egresos: { ok:0, reproc:0, skip:0, err:0 } };
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);

  function _procesar(sheetName, ncols, idCol, urlCol, dataCol, label) {
    var sh = ss.getSheetByName(sheetName);
    if (!sh) { Logger.log('⚠️ Hoja no encontrada: ' + sheetName); return; }
    _ensureSheetCols(sh, ncols, 'factura_data');
    var n = sh.getLastRow() - 2;
    if (n <= 0) return;
    var actualCols = Math.min(sh.getLastColumn(), ncols);
    var data = sh.getRange(3, 1, n, actualCols).getValues();
    for (var i = 0; i < data.length; i++) {
      var r        = data[i];
      var rowIdx   = i + 3;
      var id       = String(r[idCol - 1]  || '').trim();
      var url      = String(r[urlCol - 1] || '').trim();
      var existing = (actualCols >= dataCol) ? String(r[dataCol - 1] || '').trim() : '';
      var isReproc = false;
      if (!id || !url) { stats[label].skip++; continue; }
      if (existing) {
        if (_facturaDataEsUtil(existing)) { stats[label].skip++; continue; }
        // JSON vacío de un intento anterior fallido → reprocesar
        isReproc = true;
      }

      var fileId = null;
      var m = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
      if (m) fileId = m[1];
      if (!fileId) { var m2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/); if (m2) fileId = m2[1]; }
      if (!fileId) { var m3 = url.match(/\/d\/([a-zA-Z0-9_-]+)/);   if (m3) fileId = m3[1]; }
      if (!fileId) { stats[label].skip++; continue; }

      try {
        var file = DriveApp.getFileById(fileId);
        var name = file.getName();
        var mime = file.getMimeType();
        if (!_esXmlMime(mime, name)) { stats[label].skip++; continue; }
        var xmlText = file.getBlob().getDataAsString('UTF-8');
        var parsed  = _parseFeXmlGas(xmlText);
        // Validar que el parser produjo algo útil antes de escribir
        if (!_facturaDataEsUtil(JSON.stringify(parsed))) {
          stats[label].err++;
          Logger.log('✗ ' + label + ' ' + id + ' → parser regresó shape vacío');
          continue;
        }
        sh.getRange(rowIdx, dataCol).setValue(JSON.stringify(parsed));
        if (isReproc) stats[label].reproc++;
        else          stats[label].ok++;
        Logger.log((isReproc ? '↻ ' : '✓ ') + label + ' ' + id + ' → ' + (parsed.meta.nroFac || '?'));
      } catch(e) {
        stats[label].err++;
        Logger.log('✗ ' + label + ' ' + id + ' → ' + e.message);
      }
    }
  }

  _procesar(CONFIG.SHEET_INGRESOS, INGRESOS_NCOLS, COL_I.ID_TRANS, COL_I.DRIVE_URL, COL_I.FACTURA_DATA, 'ingresos');
  _procesar(SHEET_EGRESOS,         EGRESOS_NCOLS,  COL_E.ID,       COL_E.DRIVE_URL, COL_E.FACTURA_DATA, 'egresos');

  Logger.log('═══ RESUMEN MIGRACIÓN ═══');
  Logger.log('Ingresos: ' + stats.ingresos.ok + ' nuevos, ' + stats.ingresos.reproc + ' reprocesados, ' + stats.ingresos.skip + ' saltados, ' + stats.ingresos.err + ' errores');
  Logger.log('Egresos : ' + stats.egresos.ok  + ' nuevos, ' + stats.egresos.reproc  + ' reprocesados, ' + stats.egresos.skip  + ' saltados, ' + stats.egresos.err  + ' errores');
  return stats;
}

// ════════════════════════════════════════════════════════════════════
//  migrarCategoriasIngresoLegacy
//
//  Re-clasifica los registros de la hoja Ingresos con categorías
//  legacy (venta_producto_gravado, servicios_profesionales, etc.) a
//  las keys canónicas DGI Form 91 (ventas_servicios, honorarios_*, etc.).
//
//  Herramienta admin one-shot. Ejecutar desde el Apps Script editor:
//      migrarCategoriasIngresoLegacy({ dryRun: true })   // preview
//      migrarCategoriasIngresoLegacy({ dryRun: false })  // aplicar
//
//  Idempotente: re-ejecutar es no-op (las keys nuevas no están en el
//  mapa legacy, así que no se vuelven a tocar).
//
//  Actualiza la columna CATEGORIA. NO toca TIPO_INGRESO (esa se
//  mantiene como agregación más amplia y sigue siendo coherente).
// ════════════════════════════════════════════════════════════════════
function migrarCategoriasIngresoLegacy(opts) {
  opts = opts || {};
  var dryRun = opts.dryRun !== false;   // default true por seguridad
  var ss     = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sh     = ss.getSheetByName(CONFIG.SHEET_INGRESOS);
  if (!sh) throw new Error('Hoja Ingresos no encontrada');

  var lastRow = sh.getLastRow();
  if (lastRow < 3) {
    Logger.log('Hoja Ingresos vacía — nada que migrar');
    return { dryRun: dryRun, total: 0, cambios: 0, sinCambio: 0, detalle: [] };
  }

  var range  = sh.getRange(3, 1, lastRow - 2, INGRESOS_NCOLS);
  var values = range.getValues();

  var stats = { dryRun: dryRun, total: values.length, cambios: 0, sinCambio: 0, detalle: [] };

  for (var i = 0; i < values.length; i++) {
    var row    = values[i];
    var rowNum = i + 3;
    var idTr   = String(row[COL_I.ID_TRANS - 1]  || '');
    var catCur = String(row[COL_I.CATEGORIA - 1] || '').toLowerCase().trim();

    if (!catCur) { stats.sinCambio++; continue; }

    var catNueva = LEGACY_INGRESO_MAP[catCur];
    if (!catNueva) {
      // No es legacy — ya está en una key nueva (o es valor desconocido).
      // Lo dejamos quieto.
      stats.sinCambio++;
      continue;
    }

    stats.cambios++;
    stats.detalle.push({ row: rowNum, id: idTr, antes: catCur, despues: catNueva });

    if (!dryRun) {
      sh.getRange(rowNum, COL_I.CATEGORIA).setValue(catNueva);
    }
  }

  Logger.log('═══ MIGRACIÓN INGRESOS — ' + (dryRun ? 'DRY RUN' : 'APLICADA') + ' ═══');
  Logger.log('Total filas: ' + stats.total);
  Logger.log('Cambios: ' + stats.cambios);
  Logger.log('Sin cambio: ' + stats.sinCambio);
  if (stats.detalle.length) {
    Logger.log('Detalle (primeros 50):');
    for (var d = 0; d < Math.min(50, stats.detalle.length); d++) {
      Logger.log('  fila ' + stats.detalle[d].row + ' [' + stats.detalle[d].id + '] · ' +
                 stats.detalle[d].antes + ' → ' + stats.detalle[d].despues);
    }
    if (stats.detalle.length > 50) Logger.log('  ... y ' + (stats.detalle.length - 50) + ' más');
  }
  if (dryRun) Logger.log('⚠️ DRY RUN — no se modificaron datos. Re-ejecutar con { dryRun: false } para aplicar.');
  return stats;
}

// ── Wrappers sin parámetros para correr desde el Apps Script editor ──
// El botón "Run" del editor no permite pasar argumentos, así que estas
// dos funciones son la forma de invocar la migración:
//
//   migrarCategoriasIngresoPreview()   → dry-run, solo loguea
//   migrarCategoriasIngresoAplicar()   → escribe los cambios en la hoja
//
function migrarCategoriasIngresoPreview() {
  return migrarCategoriasIngresoLegacy({ dryRun: true });
}
function migrarCategoriasIngresoAplicar() {
  return migrarCategoriasIngresoLegacy({ dryRun: false });
}
