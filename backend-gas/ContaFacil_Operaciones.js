// ═══════════════════════════════════════════════════════════════
//  ContaFacil_Operaciones.gs
//  Módulo: Compras & Ventas — Ramon Pico / Círculo Financiero
//  v10 — Estado 'facturado' + _handleRegistrarPagoOperacion
//         + _handleMarcarCostoOperativo
// ═══════════════════════════════════════════════════════════════

var SHEET_CV           = 'Compras_Ventas';
var EMAIL_COMPROBANTES = 'lasnubesenchica+comprobantes@gmail.com';
var CONFIANZA_MINIMA   = 70;
var RUC_CIRCULO        = '1753684';

var COL_CV = {
  ID_ITEM:           1,
  FECHA_REG:         2,
  ESTADO:            3,
  FUENTE:            4,
  CONFIANZA_MATCH:   5,
  FLAG_REVISION:     6,
  FECHA_COMPRA:      7,
  NUM_FAC_CARBONE:   8,
  CODIGO_PROD:       9,
  DESCRIPCION_PROD:  10,
  PRECIO_UNIT_CARB:  11,
  ITBMS_CARBONE:     12,
  TOTAL_CARBONE:     13,
  FECHA_VENTA:       14,
  NUM_FAC_EMITIDA:   15,
  NOMBRE_CLIENTE:    16,
  RUC_CLIENTE:       17,
  DV_CLIENTE:        18,
  PRECIO_VENTA:      19,
  ITBMS_VENTA:       20,
  TOTAL_VENTA:       21,
  MARGEN:            22,
  ID_ORDEN_WEB:      23,
  DRIVE_URL_CARB:    24,
  DRIVE_URL_EMIT:    25,
  NOTAS:             26,
  INGRESO_ID:        27,
  CANTIDAD:          28,
};

// ═══════════════════════════════════════════════════════════════
//  HANDLERS — llamados desde doGet
// ═══════════════════════════════════════════════════════════════

function _handleSincronizar(params, callback) {
  var result = { success: false, procesados: 0, nuevos: 0, vinculados: 0, error: null };
  try {
    var stats        = sincronizarEmails();
    result.success   = true;
    result.procesados = stats.procesados;
    result.nuevos    = stats.nuevos;
    result.vinculados = stats.vinculados;
    result.errores   = stats.errores;
  } catch(err) {
    result.error = err.message;
    Logger.log('Error sincronizar: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function _handleGetComprasVentas(params, callback) {
  var result = { success: false, items: [], error: null };
  try {
    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_CV);
    if (!sheet) throw new Error('Hoja Compras_Ventas no encontrada. Ejecuta initComprasVentasSheet().');
    var data  = sheet.getDataRange().getValues();
    var items = [];
    for (var i = 2; i < data.length; i++) {
      var r = data[i];
      if (!r[COL_CV.ID_ITEM - 1]) continue;
      items.push({
        id_item:          r[COL_CV.ID_ITEM - 1],
        fecha_reg:        r[COL_CV.FECHA_REG - 1],
        estado:           r[COL_CV.ESTADO - 1],
        fuente:           r[COL_CV.FUENTE - 1],
        confianza_match:  r[COL_CV.CONFIANZA_MATCH - 1],
        flag_revision:    r[COL_CV.FLAG_REVISION - 1],
        fecha_compra:     r[COL_CV.FECHA_COMPRA - 1],
        num_fac_carbone:  r[COL_CV.NUM_FAC_CARBONE - 1],
        codigo_prod:      r[COL_CV.CODIGO_PROD - 1],
        descripcion_prod: r[COL_CV.DESCRIPCION_PROD - 1],
        precio_unit_carb: r[COL_CV.PRECIO_UNIT_CARB - 1],
        itbms_carbone:    r[COL_CV.ITBMS_CARBONE - 1],
        total_carbone:    r[COL_CV.TOTAL_CARBONE - 1],
        fecha_venta:      r[COL_CV.FECHA_VENTA - 1],
        num_fac_emitida:  r[COL_CV.NUM_FAC_EMITIDA - 1],
        nombre_cliente:   r[COL_CV.NOMBRE_CLIENTE - 1],
        ruc_cliente:      r[COL_CV.RUC_CLIENTE - 1],
        dv_cliente:       r[COL_CV.DV_CLIENTE - 1],
        precio_venta:     r[COL_CV.PRECIO_VENTA - 1],
        itbms_venta:      r[COL_CV.ITBMS_VENTA - 1],
        total_venta:      r[COL_CV.TOTAL_VENTA - 1],
        margen:           r[COL_CV.MARGEN - 1],
        id_orden_web:     r[COL_CV.ID_ORDEN_WEB - 1],
        drive_url_carb:   r[COL_CV.DRIVE_URL_CARB - 1],
        drive_url_emit:   r[COL_CV.DRIVE_URL_EMIT - 1],
        notas:            r[COL_CV.NOTAS - 1],
        ingreso_id:       r[COL_CV.INGRESO_ID - 1],
        cantidad:         r[COL_CV.CANTIDAD - 1] || 1,
        _row:             i + 1,
      });
    }
    result.success = true;
    result.items   = items;
  } catch(err) {
    result.error = err.message;
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function _handleAprobarMatch(params, callback) {
  var result = { success: false, error: null };
  try {
    var idItem = params.id_item || '';
    if (!idItem) throw new Error('id_item requerido');
    _aprobarMatchPorId(idItem);
    result.success = true;
  } catch(err) {
    result.error = err.message;
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// PATCH 8 — forma_pago y drive_url_pago añadidos
function _handleRegistrarVentaDirecta(params, callback) {
  var result = { success: false, error: null };
  try {
    var data = {
      id_item:        params.id_item     || '',
      nombre_cliente: params.nombre      || '',
      ruc_cliente:    params.ruc         || '',
      dv_cliente:     params.dv          || '',
      total_venta:    parseFloat(params.total || '0') || 0,
      fecha_venta:    params.fecha       || '',
      notas:          params.notas       || '',
      forma_pago:     params.forma_pago  || '',
      drive_url_pago: params.driveUrl    || '',
    };
    _registrarVentaDirecta(data);
    result.success = true;
  } catch(err) {
    result.error = err.message;
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function _handleAnalizarFacturaPendiente(params, callback) {
  var result = { success: false, data: null, error: null };
  try {
    var idItem  = params.id_item   || '';
    var pdfB64  = params.pdfBase64 || '';
    var tipoFac = params.tipo      || 'emitida';
    if (!pdfB64) throw new Error('pdfBase64 requerido');
    var parsed = _claudeParsePdfFactura(pdfB64, 'application/pdf', tipoFac);
    if (!parsed) throw new Error('Claude no pudo extraer datos del PDF');
    if (idItem && tipoFac === 'emitida') {
      _vincularFacturaEmitidaAItem(idItem, parsed, pdfB64);
    }
    result.success = true;
    result.data    = parsed;
  } catch(err) {
    result.error = err.message;
    Logger.log('Error analizarFacturaPendiente: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function _handleBuscarOrdenWeb(params, callback) {
  var result = { success: false, ordenNum: null, error: null };
  try {
    var idItem = params.id_item || '';
    if (!idItem) throw new Error('id_item requerido');
    var ordenNum = _buscarYVincularOrdenWebPorItem(idItem);
    result.success  = true;
    result.ordenNum = ordenNum || null;
    result.encontrado = !!ordenNum;
  } catch(err) {
    result.error = err.message;
    Logger.log('Error buscarOrdenWeb: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════
//  RESET LABEL
// ═══════════════════════════════════════════════════════════════

function resetLabelEmails() {
  var label = GmailApp.getUserLabelByName('procesado_cf');
  if (!label) { Logger.log('Label procesado_cf no existe'); return; }
  var threads = label.getThreads(0, 50);
  for (var i = 0; i < threads.length; i++) threads[i].removeLabel(label);
  Logger.log('OK Label removido de ' + threads.length + ' threads');
}

// ═══════════════════════════════════════════════════════════════
//  SINCRONIZAR EMAILS
// ═══════════════════════════════════════════════════════════════

function sincronizarEmails() {
  var stats              = { procesados: 0, nuevos: 0, vinculados: 0, errores: [] };
  var pendientesEmitidas = [];

  var query   = 'to:' + EMAIL_COMPROBANTES + ' has:attachment -label:procesado_cf';
  var threads = GmailApp.search(query, 0, 50);
  var label   = _getOrCreateLabel('procesado_cf');

  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      try {
        var attachments = msg.getAttachments();
        var from        = msg.getFrom() || '';
        var date        = msg.getDate();

        var pdfMap = {};
        var xmlMap = {};

        for (var a = 0; a < attachments.length; a++) {
          var att  = attachments[a];
          var ct   = att.getContentType() || '';
          var fn   = att.getName() || '';
          var fnL  = fn.toLowerCase();

          var esPdf = fnL.endsWith('.pdf');
          var esXml = fnL.endsWith('.xml');
          if (!esPdf && !esXml) {
            esPdf = (ct === 'application/pdf');
            esXml = (ct === 'text/xml' || ct === 'application/xml');
          }
          if (!esPdf && !esXml) continue;

          var base = fn.replace(/\.(pdf|xml)$/i, '');

          if (esXml) {
            try { xmlMap[base] = att.getDataAsString(); }
            catch(e) { Logger.log('Error leyendo XML "' + fn + '": ' + e.message); }
          }
          if (esPdf) {
            try {
              var bytes    = att.getBytes();
              pdfMap[base] = { bytes: bytes, b64: Utilities.base64Encode(bytes), fn: fn };
            }
            catch(e) { Logger.log('Error leyendo PDF "' + fn + '": ' + e.message); }
          }
        }

        var procesados = {};

        for (var base in xmlMap) {
          if (procesados[base]) continue;
          var xmlStr   = xmlMap[base];
          var pdfInfo  = pdfMap[base] || null;
          var pdfB64   = pdfInfo ? pdfInfo.b64   : null;
          var pdfBytes = pdfInfo ? pdfInfo.bytes  : null;
          var fileName = pdfInfo ? pdfInfo.fn     : (base + '.xml');
          var tipoFac  = _detectarTipoFactura(xmlStr, fileName, pdfB64);
          stats.procesados++;
          try {
            if (tipoFac === 'carbone') {
              stats.nuevos += _procesarXmlCarbone(xmlStr, pdfBytes, fileName, date);
            } else if (tipoFac === 'emitida') {
              var b64ToUse = pdfB64 || (pdfBytes ? Utilities.base64Encode(pdfBytes) : null);
              if (b64ToUse) pendientesEmitidas.push({ b64: b64ToUse, bytes: pdfBytes, fn: fileName, date: date });
              else stats.errores.push('Emitida sin PDF: ' + fileName);
            } else {
              stats.errores.push('No reconocido (XML): ' + fileName + ' | de: ' + from);
            }
          } catch(e) {
            stats.errores.push('Error "' + fileName + '": ' + e.message);
            Logger.log('Error XML "' + fileName + '": ' + e.message);
          }
          procesados[base] = true;
        }

        for (var base in pdfMap) {
          if (procesados[base]) continue;
          var pdfInfo = pdfMap[base];
          var tipoFac = _detectarTipoFactura(null, pdfInfo.fn, pdfInfo.b64);
          stats.procesados++;
          try {
            if (tipoFac === 'carbone') {
              stats.nuevos += _procesarFacturaCarbone(pdfInfo.b64, pdfInfo.bytes, pdfInfo.fn, date);
            } else if (tipoFac === 'emitida') {
              pendientesEmitidas.push({ b64: pdfInfo.b64, bytes: pdfInfo.bytes, fn: pdfInfo.fn, date: date });
            } else {
              stats.errores.push('No reconocido (PDF): ' + pdfInfo.fn + ' | de: ' + from);
            }
          } catch(e) {
            stats.errores.push('Error "' + pdfInfo.fn + '": ' + e.message);
            Logger.log('Error PDF "' + pdfInfo.fn + '": ' + e.message);
          }
          procesados[base] = true;
        }

        threads[t].addLabel(label);

      } catch(msgErr) {
        stats.errores.push('Error mensaje "' + msg.getSubject() + '": ' + msgErr.message);
        Logger.log('Error mensaje: ' + msgErr.message);
      }
    }
  }

  Logger.log('Ronda 2: ' + pendientesEmitidas.length + ' facturas emitidas...');
  for (var e = 0; e < pendientesEmitidas.length; e++) {
    var em = pendientesEmitidas[e];
    try {
      stats.vinculados += _procesarFacturaEmitida(em.b64, em.bytes, em.fn, em.date);
    } catch(err) {
      stats.errores.push('Error emitida "' + em.fn + '": ' + err.message);
      Logger.log('Error emitida "' + em.fn + '": ' + err.message);
    }
  }

  Logger.log('Sincronizacion completa: ' + JSON.stringify(stats));
  return stats;
}

// ═══════════════════════════════════════════════════════════════
//  HELPERS DE GMAIL
// ═══════════════════════════════════════════════════════════════

function _getOrCreateLabel(nombre) {
  var labels = GmailApp.getUserLabels();
  for (var i = 0; i < labels.length; i++) {
    if (labels[i].getName() === nombre) return labels[i];
  }
  return GmailApp.createLabel(nombre);
}

// ═══════════════════════════════════════════════════════════════
//  DETECCIÓN DE TIPO DE FACTURA
// ═══════════════════════════════════════════════════════════════

function _detectarTipoFactura(xmlStr, fileName, pdfB64) {
  if (xmlStr) {
    var emisorBlock = xmlStr.match(/<gEmis>([\s\S]*?)<\/gEmis>/);
    if (emisorBlock) {
      if (emisorBlock[1].indexOf('1080323-1-554308') !== -1) return 'carbone';
      if (emisorBlock[1].indexOf('1753684-1-696883') !== -1) return 'emitida';
    }
    if (xmlStr.indexOf('EMPRESAS CARBONE') !== -1)   return 'carbone';
    if (xmlStr.indexOf('CIRCULO FINANCIERO') !== -1) return 'emitida';
  }

  var fn = (fileName || '').toLowerCase();
  if (fn.indexOf('1080323') !== -1 || fn.indexOf('fe01200001080323') !== -1) return 'carbone';
  if (fn.indexOf('1753684') !== -1 || fn.indexOf('fe0820000155716383') !== -1) return 'emitida';

  if (pdfB64) return _claudeClasificarFactura(pdfB64);
  return 'desconocido';
}

// ═══════════════════════════════════════════════════════════════
//  PARSEAR XML DE CARBONE
// ═══════════════════════════════════════════════════════════════

function _procesarXmlCarbone(xmlStr, pdfBytes, fileName, fechaEmail) {
  var numFactura     = _xmlVal(xmlStr, 'dNroDF');
  var fechaEmision   = (_xmlVal(xmlStr, 'dFechaEm') || '').substring(0, 10);
  var nombreReceptor = _xmlVal(xmlStr, 'dNombRec');

  if (!numFactura) {
    Logger.log('XML Carbone sin número de factura');
    return 0;
  }
  if (_facturaYaExiste(numFactura, 'carbone')) {
    Logger.log('Factura Carbone ' + numFactura + ' ya procesada');
    return 0;
  }

  var driveUrl = pdfBytes
    ? _guardarPdfEnDrive(pdfBytes, 'Carbone_' + numFactura + '.pdf')
    : '';

  var items = _xmlItems(xmlStr);
  if (!items.length) {
    Logger.log('XML Carbone sin ítems: ' + numFactura);
    return 0;
  }

  var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_CV);
  if (!sheet) throw new Error('Hoja ' + SHEET_CV + ' no encontrada. Ejecuta initComprasVentasSheet().');

  var ahora        = new Date();
  var fechaReg     = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
  var totalFactura = items.reduce(function(s, i) { return s + i.total_item; }, 0);

  for (var j = 0; j < items.length; j++) {
    var item = items[j];
    var id   = 'CV-' + Utilities.formatDate(ahora, 'America/Panama', 'yyyyMMddHHmmss') + '-' + String(j + 1);

    var fila = new Array(28);
    for (var x = 0; x < 28; x++) fila[x] = '';

    fila[COL_CV.ID_ITEM - 1]          = id;
    fila[COL_CV.FECHA_REG - 1]        = fechaReg;
    fila[COL_CV.ESTADO - 1]           = 'pendiente';
    fila[COL_CV.FUENTE - 1]           = 'email_carbone';
    fila[COL_CV.FLAG_REVISION - 1]    = false;
    fila[COL_CV.FECHA_COMPRA - 1]     = fechaEmision;
    fila[COL_CV.NUM_FAC_CARBONE - 1]  = numFactura;
    fila[COL_CV.CODIGO_PROD - 1]      = item.codigo;
    fila[COL_CV.DESCRIPCION_PROD - 1] = item.descripcion;
    fila[COL_CV.PRECIO_UNIT_CARB - 1] = item.precio_unitario;
    fila[COL_CV.ITBMS_CARBONE - 1]    = item.itbms;
    fila[COL_CV.TOTAL_CARBONE - 1]    = item.total_item;
    fila[COL_CV.DRIVE_URL_CARB - 1]   = driveUrl;
    fila[COL_CV.CANTIDAD - 1]         = 1;
    fila[COL_CV.NOTAS - 1]            = 'Comprado a: ' + nombreReceptor +
                                        ' | Total factura Carbone: $' + totalFactura.toFixed(2) +
                                        ' | Fuente: XML';

    var lastRow = sheet.getLastRow() + 1;
    sheet.getRange(lastRow, 1, 1, 28).setValues([fila]);
    sheet.getRange(lastRow, COL_CV.PRECIO_UNIT_CARB, 1, 3).setNumberFormat('#,##0.00');
    sheet.getRange(lastRow, 1, 1, 28).setBackground('#FFF3E0');
  }

  Logger.log('✅ XML Carbone ' + numFactura + ': ' + items.length + ' ítems insertados');
  return items.length;
}

function _xmlVal(xml, tag) {
  var m = xml.match(new RegExp('<' + tag + '>([^<]*)<\/' + tag + '>'));
  return m ? m[1] : '';
}

function _xmlItems(xml) {
  var items     = [];
  var itemRegex = /<gItem>([\s\S]*?)<\/gItem>/g;
  var match;
  while ((match = itemRegex.exec(xml)) !== null) {
    var block = match[1];
    items.push({
      codigo:          _xmlVal(block, 'dCodProd'),
      descripcion:     _xmlVal(block, 'dDescProd'),
      precio_unitario: parseFloat(_xmlVal(block, 'dPrUnit')     || '0'),
      itbms:           parseFloat(_xmlVal(block, 'dValITBMS')   || '0'),
      total_item:      parseFloat(_xmlVal(block, 'dValTotItem') || '0'),
    });
  }
  return items;
}

// ═══════════════════════════════════════════════════════════════
//  PROCESAR FACTURA CARBONE (PDF)
// ═══════════════════════════════════════════════════════════════

function _procesarFacturaCarbone(pdfB64, pdfBytes, fileName, fechaEmail) {
  var parsed = _claudeParsePdfFactura(pdfB64, 'application/pdf', 'carbone');
  if (!parsed || !parsed.items || !parsed.items.length) {
    Logger.log('Claude no extrajo ítems de factura Carbone PDF');
    return 0;
  }
  if (_facturaYaExiste(parsed.num_factura, 'carbone')) {
    Logger.log('Factura Carbone ' + parsed.num_factura + ' ya procesada');
    return 0;
  }

  var driveUrl = _guardarPdfEnDrive(pdfBytes, 'Carbone_' + parsed.num_factura + '_' + fileName);
  var ss       = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet    = ss.getSheetByName(SHEET_CV);
  if (!sheet) throw new Error('Hoja ' + SHEET_CV + ' no encontrada.');

  var ahora        = new Date();
  var fechaReg     = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
  var totalFactura = 0;
  for (var i = 0; i < parsed.items.length; i++) {
    totalFactura += parseFloat(parsed.items[i].total_item || '0') || 0;
  }

  for (var j = 0; j < parsed.items.length; j++) {
    var item = parsed.items[j];
    var id   = 'CV-' + Utilities.formatDate(ahora, 'America/Panama', 'yyyyMMddHHmmss') + '-' + (j + 1);
    var fila = new Array(28);
    for (var x = 0; x < 28; x++) fila[x] = '';
    fila[COL_CV.ID_ITEM - 1]          = id;
    fila[COL_CV.FECHA_REG - 1]        = fechaReg;
    fila[COL_CV.ESTADO - 1]           = 'pendiente';
    fila[COL_CV.FUENTE - 1]           = 'email_carbone';
    fila[COL_CV.FLAG_REVISION - 1]    = false;
    fila[COL_CV.FECHA_COMPRA - 1]     = parsed.fecha_emision || '';
    fila[COL_CV.NUM_FAC_CARBONE - 1]  = parsed.num_factura   || '';
    fila[COL_CV.CODIGO_PROD - 1]      = item.codigo          || '';
    fila[COL_CV.DESCRIPCION_PROD - 1] = item.descripcion     || '';
    fila[COL_CV.PRECIO_UNIT_CARB - 1] = parseFloat(item.precio_unitario || '0') || '';
    fila[COL_CV.ITBMS_CARBONE - 1]    = parseFloat(item.itbms || '0') || '';
    fila[COL_CV.TOTAL_CARBONE - 1]    = parseFloat(item.total_item || '0') || '';
    fila[COL_CV.DRIVE_URL_CARB - 1]   = driveUrl;
    fila[COL_CV.CANTIDAD - 1]         = 1;
    fila[COL_CV.NOTAS - 1]            = 'Total factura Carbone: $' + totalFactura.toFixed(2) + ' | Fuente: PDF';
    var lastRow = sheet.getLastRow() + 1;
    sheet.getRange(lastRow, 1, 1, 28).setValues([fila]);
    sheet.getRange(lastRow, COL_CV.PRECIO_UNIT_CARB, 1, 3).setNumberFormat('#,##0.00');
    sheet.getRange(lastRow, 1, 1, 28).setBackground('#FFF3E0');
  }

  Logger.log('✅ PDF Carbone ' + parsed.num_factura + ': ' + parsed.items.length + ' ítems insertados');
  return parsed.items.length;
}

// ═══════════════════════════════════════════════════════════════
//  PROCESAR FACTURA EMITIDA (Círculo Financiero)
// ═══════════════════════════════════════════════════════════════

function _procesarFacturaEmitida(pdfB64, pdfBytes, fileName, fechaEmail) {
  var parsed = _claudeParsePdfFactura(pdfB64, 'application/pdf', 'emitida');
  if (!parsed) {
    Logger.log('Claude no extrajo datos de factura emitida');
    return 0;
  }

  var driveUrl = _guardarPdfEnDrive(pdfBytes, 'CF_Emitida_' + (parsed.num_factura || 'SN') + '_' + fileName);

  var vinculados = _matchFacturaEmitidaConItems(parsed, driveUrl);

  if (parsed.num_factura) {
    try {
      SpreadsheetApp.flush();
      var ss2    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
      var sheet2 = ss2.getSheetByName(SHEET_CV);
      if (sheet2) {
        var cvData = sheet2.getDataRange().getValues();
        for (var i = 2; i < cvData.length; i++) {
          if (String(cvData[i][COL_CV.NUM_FAC_EMITIDA - 1]).replace(/^0+/, '') === String(parsed.num_factura).replace(/^0+/, '')) {
            var idItem = String(cvData[i][COL_CV.ID_ITEM - 1] || '');
            if (idItem) {
              try { _buscarYVincularOrdenWebPorItem(idItem); }
              catch(eItem) { Logger.log('buscarOrdenWeb item ' + idItem + ': ' + eItem.message); }
            }
          }
        }
      }
    } catch(e) {
      Logger.log('buscarOrdenWeb loop ERROR: ' + e.message);
    }
  }

  return vinculados;
}

// ═══════════════════════════════════════════════════════════════
//  MATCHING — Factura emitida ↔ ítems Carbone pendientes
// ═══════════════════════════════════════════════════════════════

function _matchFacturaEmitidaConItems(parsedEmitida, driveUrlEmitida) {
  var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_CV);
  if (!sheet) return 0;

  var data       = sheet.getDataRange().getValues();
  var pendientes = [];

  for (var i = 2; i < data.length; i++) {
    var estado = String(data[i][COL_CV.ESTADO - 1]          || '').trim();
    var fac    = String(data[i][COL_CV.NUM_FAC_EMITIDA - 1] || '').trim();
    if ((estado === 'pendiente' || estado === 'inventario') && !fac) {
      pendientes.push({
        row:         i + 1,
        id:          data[i][COL_CV.ID_ITEM - 1],
        codigo:      data[i][COL_CV.CODIGO_PROD - 1]      || '',
        descripcion: data[i][COL_CV.DESCRIPCION_PROD - 1] || '',
        fecha:       data[i][COL_CV.FECHA_COMPRA - 1]     || '',
        total:       parseFloat(data[i][COL_CV.TOTAL_CARBONE - 1] || '0') || 0,
      });
    }
  }

  if (!pendientes.length) {
    Logger.log('No hay ítems pendientes para vincular con factura ' + parsedEmitida.num_factura);
    return 0;
  }
  if (!parsedEmitida.items || !parsedEmitida.items.length) {
    Logger.log('Factura emitida ' + parsedEmitida.num_factura + ' sin ítems parseados');
    return 0;
  }

  var matchResult = _claudeMatchItems(parsedEmitida, pendientes);
  if (!matchResult || !matchResult.matches || !matchResult.matches.length) {
    Logger.log('Claude no encontró matches para factura ' + parsedEmitida.num_factura);
    return 0;
  }

  var vinculados = 0;

  for (var k = 0; k < matchResult.matches.length; k++) {
    var match = matchResult.matches[k];
    if (typeof match.idx_carbone === 'undefined' || match.idx_carbone === null) continue;
    if (typeof match.idx_emitido === 'undefined' || match.idx_emitido === null) continue;

    var pendItem    = pendientes[match.idx_carbone];
    var itemEmitido = parsedEmitida.items[match.idx_emitido];

    if (!pendItem || !itemEmitido) continue;

    var confianza   = parseInt(match.confianza || '0') || 0;
    var flagRev     = confianza < CONFIANZA_MINIMA;
    var totalVenta  = parseFloat(match.total_venta_asignado  || itemEmitido.total_item || '0') || 0;
    var itbmsVenta  = parseFloat(match.itbms_venta_asignado  || itemEmitido.itbms      || '0') || 0;
    var precioVenta = totalVenta > 0 ? parseFloat((totalVenta - itbmsVenta).toFixed(2)) : 0;
    var margen      = totalVenta > 0 ? parseFloat((totalVenta - pendItem.total).toFixed(2)) : '';

    // PATCH 2 — estado 'facturado' (o queda 'pendiente' si baja confianza)
    var nuevoEstado = flagRev ? 'pendiente' : 'facturado';

    sheet.getRange(pendItem.row, COL_CV.ESTADO).setValue(nuevoEstado);
    sheet.getRange(pendItem.row, COL_CV.CONFIANZA_MATCH).setValue(confianza);
    sheet.getRange(pendItem.row, COL_CV.FLAG_REVISION).setValue(flagRev);
    sheet.getRange(pendItem.row, COL_CV.FECHA_VENTA).setValue(parsedEmitida.fecha_emision   || '');
    sheet.getRange(pendItem.row, COL_CV.NUM_FAC_EMITIDA).setValue(parsedEmitida.num_factura || '');
    sheet.getRange(pendItem.row, COL_CV.NOMBRE_CLIENTE).setValue(parsedEmitida.nombre_cliente || '');
    sheet.getRange(pendItem.row, COL_CV.RUC_CLIENTE).setValue(parsedEmitida.ruc_cliente      || '');
    sheet.getRange(pendItem.row, COL_CV.DV_CLIENTE).setValue(parsedEmitida.dv_cliente        || '');
    sheet.getRange(pendItem.row, COL_CV.PRECIO_VENTA).setValue(precioVenta || '');
    sheet.getRange(pendItem.row, COL_CV.ITBMS_VENTA).setValue(itbmsVenta   || '');
    sheet.getRange(pendItem.row, COL_CV.TOTAL_VENTA).setValue(totalVenta   || '');
    sheet.getRange(pendItem.row, COL_CV.MARGEN).setValue(margen);
    sheet.getRange(pendItem.row, COL_CV.DRIVE_URL_EMIT).setValue(driveUrlEmitida);

    var notaActual = String(sheet.getRange(pendItem.row, COL_CV.NOTAS).getValue() || '');
    sheet.getRange(pendItem.row, COL_CV.NOTAS).setValue(
      notaActual + ' | Match IA: ' + (match.razon || '') + ' (' + confianza + '%)'
    );

    // PATCH 3 — color azul claro para 'facturado'; no llamar _intentarCerrarCiclo aquí
    sheet.getRange(pendItem.row, 1, 1, 28).setBackground(flagRev ? '#FFF9C4' : '#E3F2FD');

    // No cerrar ciclo aquí: el ciclo se cierra al registrar el comprobante de pago

    Logger.log('✅ Match: ' + pendItem.id + ' → fac ' + parsedEmitida.num_factura +
               ' | confianza: ' + confianza + '% | venta: $' + totalVenta);
    vinculados++;
  }

  return vinculados;
}

// ═══════════════════════════════════════════════════════════════
//  CERRAR CICLO → INGRESO + EGRESO costo_mercancia
//  v10 — recibe pagoCtx opcional { forma_pago, drive_url_pago }
//         retorna { ingresoId, egresoId }
// ═══════════════════════════════════════════════════════════════

// PATCH 11 — firma ampliada con pagoCtx
function _intentarCerrarCiclo(rowNum, sheet, pagoCtx) {
  // pagoCtx = { forma_pago, drive_url_pago } — opcional, viene del registro de pago

  var rowData   = sheet.getRange(rowNum, 1, 1, 28).getValues()[0];
  var guardCell = sheet.getRange(rowNum, COL_CV.INGRESO_ID);
  if (guardCell.getValue()) return null;

  var totalVenta    = parseFloat(rowData[COL_CV.TOTAL_VENTA - 1]    || '0') || 0;
  var numFacEmitida = String(rowData[COL_CV.NUM_FAC_EMITIDA - 1]    || '');
  var nombreCli     = String(rowData[COL_CV.NOMBRE_CLIENTE - 1]     || '');

  if (!numFacEmitida || !nombreCli || !totalVenta) return null;

  var driveUrlEmit = pagoCtx && pagoCtx.drive_url_pago
    ? pagoCtx.drive_url_pago
    : String(rowData[COL_CV.DRIVE_URL_EMIT - 1] || '');

  var formaPago = (pagoCtx && pagoCtx.forma_pago) ? pagoCtx.forma_pago : 'Factura';

  // ── 1. Crear Ingreso ────────────────────────────────────────
  var ordenData = {
    orderNumber:    numFacEmitida,
    fecha:          rowData[COL_CV.FECHA_VENTA - 1],
    nombre:         nombreCli,
    ruc:            rowData[COL_CV.RUC_CLIENTE - 1],
    dv:             rowData[COL_CV.DV_CLIENTE - 1],
    pago:           formaPago,
    totalNum:       totalVenta,
    totalStr:       '$' + totalVenta.toFixed(2),
    productos:      [{ titulo: rowData[COL_CV.DESCRIPCION_PROD - 1], cantidad: 1 }],
    voucherUrl:     driveUrlEmit,
    montoPagado:    totalVenta,
    estadoPago:     'completo',
    saldoPendiente: '',
    codigoTrans:    rowData[COL_CV.ID_ITEM - 1],
    pagador:        nombreCli,
    fechaPago:      rowData[COL_CV.FECHA_VENTA - 1],
  };

  var ingresoId = crearIngreso(ordenData);
  guardCell.setValue(ingresoId);
  sheet.getRange(rowNum, COL_CV.ESTADO).setValue('cerrado');
  sheet.getRange(rowNum, 1, 1, 28).setBackground('#F1F8E9');
  Logger.log('✅ Ciclo cerrado: ' + rowData[COL_CV.ID_ITEM - 1] + ' → Ingreso: ' + ingresoId);

  var egresoId = null;

  // ── 2. Crear Egreso costo_mercancia (si no existe ya) ───────
  try {
    var idItem = String(rowData[COL_CV.ID_ITEM - 1] || '');
    if (!idItem) return { ingresoId: ingresoId, egresoId: null };

    var ss       = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheetEgr = ss.getSheetByName(SHEET_EGRESOS);
    if (!sheetEgr) sheetEgr = _initEgresosSheet(ss);

    // Guard: verificar si ya existe un egreso con este id_item
    var lastEgrRow = sheetEgr.getLastRow();
    if (lastEgrRow > 2) {
      var existingIds = sheetEgr
        .getRange(3, COL_E.ID_ITEM_CV, lastEgrRow - 2, 1)
        .getValues();
      for (var d = 0; d < existingIds.length; d++) {
        if (String(existingIds[d][0] || '') === idItem) {
          Logger.log('ℹ️ Egreso costo_mercancia ya existe para ítem ' + idItem + ' — omitiendo');
          return { ingresoId: ingresoId, egresoId: null };
        }
      }
    }

    // Datos del costo
    var totalCarb    = parseFloat(rowData[COL_CV.TOTAL_CARBONE - 1]  || '0') || 0;
    var itbmsCarb    = parseFloat(rowData[COL_CV.ITBMS_CARBONE - 1]  || '0') || 0;
    var subtotalCarb = 0;
    if (totalCarb > 0) {
      if (itbmsCarb > 0) {
        subtotalCarb = parseFloat((totalCarb - itbmsCarb).toFixed(2));
      } else {
        subtotalCarb = parseFloat((totalCarb / 1.07).toFixed(2));
        itbmsCarb    = parseFloat((totalCarb - subtotalCarb).toFixed(2));
      }
    }

    var numFacCarb  = String(rowData[COL_CV.NUM_FAC_CARBONE - 1]  || '');
    var driveCarb   = String(rowData[COL_CV.DRIVE_URL_CARB - 1]   || '');
    var descripProd = String(rowData[COL_CV.DESCRIPCION_PROD - 1]  || '');

    var fechaCompra = rowData[COL_CV.FECHA_COMPRA - 1];
    if (fechaCompra instanceof Date) {
      fechaCompra = Utilities.formatDate(fechaCompra, 'America/Panama', 'yyyy-MM-dd');
    } else {
      fechaCompra = String(fechaCompra || '').slice(0, 10);
    }

    var ahora   = new Date();
    var yearEgr = fechaCompra
      ? new Date(fechaCompra + 'T12:00:00').getFullYear()
      : ahora.getFullYear();

    // Correlativo
    var seqEgr = 1;
    lastEgrRow = sheetEgr.getLastRow();
    if (lastEgrRow > 2) {
      var idsEgr = sheetEgr.getRange(3, COL_E.ID, lastEgrRow - 2, 1).getValues();
      for (var ke = idsEgr.length - 1; ke >= 0; ke--) {
        var ve     = String(idsEgr[ke][0] || '');
        var partsE = ve.split('-');
        var ne     = parseInt(partsE[partsE.length - 1], 10);
        if (!isNaN(ne)) { seqEgr = ne + 1; break; }
      }
    }
    egresoId = 'EGR-RP-' + yearEgr + '-' + String(seqEgr).padStart(4, '0');

    var fechaCompraDate = new Date(fechaCompra + 'T12:00:00');
    var mesEgr  = isNaN(fechaCompraDate.getTime()) ? '' : (fechaCompraDate.getMonth() + 1);
    var anioEgr = isNaN(fechaCompraDate.getTime()) ? yearEgr : fechaCompraDate.getFullYear();

    var filaEgr = new Array(EGRESOS_NCOLS);
    for (var xe = 0; xe < EGRESOS_NCOLS; xe++) filaEgr[xe] = '';

    filaEgr[COL_E.ID - 1]          = egresoId;
    filaEgr[COL_E.FECHA_REG - 1]   = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
    filaEgr[COL_E.ESTADO - 1]      = 'registrado';
    filaEgr[COL_E.FECHA_GASTO - 1] = fechaCompra || Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd');
    filaEgr[COL_E.MES - 1]         = mesEgr;
    filaEgr[COL_E.ANIO - 1]        = anioEgr;
    filaEgr[COL_E.SUBTOTAL - 1]    = subtotalCarb || '';
    filaEgr[COL_E.ITBMS - 1]       = itbmsCarb    || '';
    filaEgr[COL_E.TOTAL - 1]       = totalCarb    || '';
    filaEgr[COL_E.MONEDA - 1]      = 'USD';
    filaEgr[COL_E.TIPO_EGRESO - 1] = 'costo_mercancia';
    filaEgr[COL_E.CATEGORIA - 1]   = 'costo_mercancia';
    filaEgr[COL_E.PROVEEDOR - 1]   = 'Empresas Carbone S.A.';
    filaEgr[COL_E.RUC_PROV - 1]    = '1080323-1-554308';
    filaEgr[COL_E.DV_PROV - 1]     = '54';
    filaEgr[COL_E.NFACTURA - 1]    = numFacCarb;
    filaEgr[COL_E.ID_ITEM_CV - 1]  = idItem;
    filaEgr[COL_E.DRIVE_URL - 1]   = driveCarb;
    filaEgr[COL_E.DESCRIPCION - 1] = descripProd;
    filaEgr[COL_E.NOTAS - 1]       = 'Costo venta · Fac emitida: ' + numFacEmitida +
                                      ' · Cliente: ' + nombreCli +
                                      ' · Ingreso: ' + ingresoId;

    var newEgrRow = sheetEgr.getLastRow() + 1;
    sheetEgr.getRange(newEgrRow, 1, 1, EGRESOS_NCOLS).setValues([filaEgr]);
    sheetEgr.getRange(newEgrRow, COL_E.SUBTOTAL, 1, 3).setNumberFormat('#,##0.00');
    sheetEgr.getRange(newEgrRow, 1, 1, EGRESOS_NCOLS).setBackground('#FFF3E0');

    Logger.log('✅ Egreso costo_mercancia: ' + egresoId +
               ' | ítem: ' + idItem + ' | costo: $' + totalCarb);

  } catch(egrErr) {
    // Aislado: el ingreso ya quedó guardado, el cierre del ciclo está completo
    Logger.log('⚠️ Error creando egreso en _intentarCerrarCiclo: ' + egrErr.message);
  }

  return { ingresoId: ingresoId, egresoId: egresoId };
}

// ═══════════════════════════════════════════════════════════════
//  VINCULAR CON ORDEN WEB
// ═══════════════════════════════════════════════════════════════

function _buscarYVincularOrdenWebPorItem(idItem) {
  var ss       = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheetCV  = ss.getSheetByName(SHEET_CV);
  var sheetOrd = ss.getSheetByName(CONFIG.SHEET_ORDENES);
  if (!sheetCV || !sheetOrd) throw new Error('Hojas no encontradas');

  var cvData   = sheetCV.getDataRange().getValues();
  var itemRow  = -1;
  var itemData = null;
  for (var i = 2; i < cvData.length; i++) {
    if (String(cvData[i][COL_CV.ID_ITEM - 1]) === String(idItem)) {
      itemRow  = i + 1;
      itemData = cvData[i];
      break;
    }
  }
  if (!itemData) throw new Error('Item no encontrado: ' + idItem);

  var numFacEmitida = String(itemData[COL_CV.NUM_FAC_EMITIDA - 1] || '');
  var nombreCli     = String(itemData[COL_CV.NOMBRE_CLIENTE - 1]  || '').toLowerCase().trim();
  var totalVenta    = parseFloat(itemData[COL_CV.TOTAL_VENTA - 1]  || '0') || 0;
  var fechaVenta    = _parseDate(itemData[COL_CV.FECHA_VENTA - 1]);

  if (!numFacEmitida || !nombreCli) throw new Error('Item sin factura emitida o cliente');

  var ordData = sheetOrd.getDataRange().getValues();
  for (var j = 1; j < ordData.length; j++) {
    var nombreOrd = String(ordData[j][COL_O.NOMBRE - 1]       || '').toLowerCase().trim();
    var totalOrd  = parseFloat(ordData[j][COL_O.TOTAL_NUM - 1] || '0') || 0;
    var fechaOrd  = _parseDate(ordData[j][COL_O.FECHA - 1]);

    var nombreMatch = _similaridad(nombreOrd, nombreCli) > 0.7;
    var montoMatch  = totalOrd > 0 && Math.abs(totalOrd - totalVenta) / totalOrd < 0.05;
    var fechaMatch  = fechaOrd && fechaVenta && Math.abs(fechaOrd - fechaVenta) < 10 * 24 * 3600 * 1000;

    if (nombreMatch && montoMatch && fechaMatch) {
      var ordenNum = ordData[j][COL_O.ORDEN_NUM - 1];
      _aplicarOrdenWebAFactura(sheetCV, numFacEmitida, ordenNum);
      Logger.log('✅ Orden web vinculada: ' + ordenNum + ' → ítem ' + idItem);
      return ordenNum;
    }
  }
  return null;
}

function _buscarYVincularOrdenWebPorOrden(ordenNum, nombreCliente, totalOrden, fechaOrden) {
  var ss      = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheetCV = ss.getSheetByName(SHEET_CV);
  if (!sheetCV) return;

  var cvData     = sheetCV.getDataRange().getValues();
  var nombreOrd  = String(nombreCliente || '').toLowerCase().trim();
  var totalOrd   = parseFloat(totalOrden || '0') || 0;
  var fechaOrdD  = _parseDate(fechaOrden);
  var vinculados = 0;

  var facturas = {};
  for (var i = 2; i < cvData.length; i++) {
    var idOrdenWeb = String(cvData[i][COL_CV.ID_ORDEN_WEB - 1]   || '').trim();
    var numFac     = String(cvData[i][COL_CV.NUM_FAC_EMITIDA - 1] || '').trim();
    var estado     = String(cvData[i][COL_CV.ESTADO - 1]          || '').trim();
    var nombreCli  = String(cvData[i][COL_CV.NOMBRE_CLIENTE - 1]  || '').toLowerCase().trim();
    var totalVenta = parseFloat(cvData[i][COL_CV.TOTAL_VENTA - 1]  || '0') || 0;
    var fechaVenta = _parseDate(cvData[i][COL_CV.FECHA_VENTA - 1]);

    // PATCH 6 — incluir 'facturado' en estados válidos para vincular orden web
    if (!numFac || idOrdenWeb || (estado !== 'vinculado' && estado !== 'facturado' && estado !== 'cerrado')) continue;
    if (numFac === 'VENTA-DIRECTA') continue;

    if (!facturas[numFac]) {
      facturas[numFac] = { nombreCli: nombreCli, totalVenta: totalVenta, fechaVenta: fechaVenta, rows: [] };
    }
    facturas[numFac].rows.push(i + 1);
  }

  for (var numFac in facturas) {
    var fac         = facturas[numFac];
    var nombreMatch = _similaridad(fac.nombreCli, nombreOrd) > 0.7;
    var montoMatch  = fac.totalVenta > 0 && totalOrd > 0 && Math.abs(fac.totalVenta - totalOrd) / Math.max(fac.totalVenta, totalOrd) < 0.05;
    var fechaMatch  = fac.fechaVenta && fechaOrdD && Math.abs(fac.fechaVenta - fechaOrdD) < 10 * 24 * 3600 * 1000;

    if (nombreMatch && (montoMatch || fechaMatch)) {
      _aplicarOrdenWebAFactura(sheetCV, numFac, ordenNum);
      vinculados += fac.rows.length;
    }
  }

  if (vinculados > 0) Logger.log('✅ Trigger: orden ' + ordenNum + ' vinculada — ' + vinculados + ' ítems');
}

function _aplicarOrdenWebAFactura(sheetCV, numFacEmitida, ordenNum) {
  var cvData = sheetCV.getDataRange().getValues();
  for (var j = 2; j < cvData.length; j++) {
    if (String(cvData[j][COL_CV.NUM_FAC_EMITIDA - 1]) === String(numFacEmitida)) {
      sheetCV.getRange(j + 1, COL_CV.ID_ORDEN_WEB).setValue(ordenNum);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  APROBAR MATCH MANUAL
// ═══════════════════════════════════════════════════════════════

function _aprobarMatchPorId(idItem) {
  var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_CV);
  if (!sheet) throw new Error('Hoja ' + SHEET_CV + ' no encontrada');

  var data = sheet.getDataRange().getValues();
  for (var i = 2; i < data.length; i++) {
    if (String(data[i][COL_CV.ID_ITEM - 1]) === String(idItem)) {
      var rowNum = i + 1;
      // PATCH 4 — estado 'facturado', color azul, sin cerrar ciclo
      sheet.getRange(rowNum, COL_CV.FLAG_REVISION).setValue(false);
      sheet.getRange(rowNum, COL_CV.ESTADO).setValue('facturado');
      sheet.getRange(rowNum, 1, 1, 28).setBackground('#E3F2FD');
      Logger.log('✅ Match aprobado → facturado: ' + idItem);
      return;
    }
  }
  throw new Error('Item no encontrado: ' + idItem);
}

// ═══════════════════════════════════════════════════════════════
//  REGISTRAR VENTA DIRECTA
// ═══════════════════════════════════════════════════════════════

function _registrarVentaDirecta(data) {
  var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_CV);
  if (!sheet) throw new Error('Hoja ' + SHEET_CV + ' no encontrada');

  var ahora    = new Date();
  var fechaReg = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');

  if (data.id_item) {
    var rows = sheet.getDataRange().getValues();
    for (var i = 2; i < rows.length; i++) {
      if (String(rows[i][COL_CV.ID_ITEM - 1]) === String(data.id_item)) {
        var rowNum    = i + 1;
        var totalCarb = parseFloat(rows[i][COL_CV.TOTAL_CARBONE - 1] || '0') || 0;
        sheet.getRange(rowNum, COL_CV.FECHA_VENTA).setValue(data.fecha_venta || fechaReg.substring(0, 10));
        sheet.getRange(rowNum, COL_CV.NOMBRE_CLIENTE).setValue(data.nombre_cliente);
        sheet.getRange(rowNum, COL_CV.RUC_CLIENTE).setValue(data.ruc_cliente || '');
        sheet.getRange(rowNum, COL_CV.DV_CLIENTE).setValue(data.dv_cliente   || '');
        sheet.getRange(rowNum, COL_CV.TOTAL_VENTA).setValue(data.total_venta);
        sheet.getRange(rowNum, COL_CV.ITBMS_VENTA).setValue(0);
        sheet.getRange(rowNum, COL_CV.PRECIO_VENTA).setValue(data.total_venta);
        sheet.getRange(rowNum, COL_CV.MARGEN).setValue(data.total_venta - totalCarb);
        // PATCH 9 — estado 'facturado', drive_url y forma_pago
        sheet.getRange(rowNum, COL_CV.NUM_FAC_EMITIDA).setValue('VENTA-DIRECTA');
        sheet.getRange(rowNum, COL_CV.ESTADO).setValue('facturado');
        sheet.getRange(rowNum, COL_CV.NOTAS).setValue(
          (rows[i][COL_CV.NOTAS - 1] || '') +
          ' | Venta directa s/factura — Neto: $' + data.total_venta.toFixed(2) +
          (data.notas ? ' | ' + data.notas : '')
        );
        if (data.drive_url_pago) sheet.getRange(rowNum, COL_CV.DRIVE_URL_EMIT).setValue(data.drive_url_pago);
        sheet.getRange(rowNum, 1, 1, 28).setBackground('#E3F2FD');
        _intentarCerrarCiclo(rowNum, sheet, { forma_pago: data.forma_pago, drive_url_pago: data.drive_url_pago });
        return;
      }
    }
    throw new Error('Item no encontrado: ' + data.id_item);
  } else {
    var id   = 'CV-D-' + Utilities.formatDate(ahora, 'America/Panama', 'yyyyMMddHHmmss');
    var fila = new Array(28);
    for (var x = 0; x < 28; x++) fila[x] = '';
    fila[COL_CV.ID_ITEM - 1]         = id;
    fila[COL_CV.FECHA_REG - 1]       = fechaReg;
    fila[COL_CV.ESTADO - 1]          = 'vinculado';
    fila[COL_CV.FUENTE - 1]          = 'manual';
    fila[COL_CV.CONFIANZA_MATCH - 1] = 100;
    fila[COL_CV.FLAG_REVISION - 1]   = false;
    fila[COL_CV.FECHA_VENTA - 1]     = data.fecha_venta || fechaReg.substring(0, 10);
    fila[COL_CV.NUM_FAC_EMITIDA - 1] = 'VENTA-DIRECTA';
    fila[COL_CV.NOMBRE_CLIENTE - 1]  = data.nombre_cliente;
    fila[COL_CV.RUC_CLIENTE - 1]     = data.ruc_cliente || '';
    fila[COL_CV.DV_CLIENTE - 1]      = data.dv_cliente  || '';
    fila[COL_CV.TOTAL_VENTA - 1]     = data.total_venta;
    fila[COL_CV.ITBMS_VENTA - 1]     = 0;
    fila[COL_CV.PRECIO_VENTA - 1]    = data.total_venta;
    fila[COL_CV.MARGEN - 1]          = data.total_venta;
    fila[COL_CV.CANTIDAD - 1]        = 1;
    fila[COL_CV.NOTAS - 1]           = 'Venta directa s/factura Carbone — Neto | ' + (data.notas || '');
    var lastRow = sheet.getLastRow() + 1;
    sheet.getRange(lastRow, 1, 1, 28).setValues([fila]);
    sheet.getRange(lastRow, COL_CV.TOTAL_VENTA, 1, 1).setNumberFormat('#,##0.00');
    sheet.getRange(lastRow, 1, 1, 28).setBackground('#E8F5E9');
    var ordenData = {
      orderNumber: id, fecha: data.fecha_venta, nombre: data.nombre_cliente,
      ruc: data.ruc_cliente, dv: data.dv_cliente,
      pago: data.forma_pago || 'Venta Directa', totalNum: data.total_venta,
      totalStr: '$' + data.total_venta.toFixed(2),
      productos: [{ titulo: data.notas || 'Venta directa', cantidad: 1 }],
      montoPagado: data.total_venta, estadoPago: 'completo',
      codigoTrans: id, pagador: data.nombre_cliente, fechaPago: data.fecha_venta,
    };
    var ingresoId = crearIngreso(ordenData);
    sheet.getRange(lastRow, COL_CV.INGRESO_ID).setValue(ingresoId);
    // PATCH 10 — color verde + estado cerrado explícito
    sheet.getRange(lastRow, COL_CV.ESTADO).setValue('cerrado');
    sheet.getRange(lastRow, 1, 1, 28).setBackground('#E8F5E9');
    Logger.log('✅ Venta directa nueva: ' + id + ' → Ingreso: ' + ingresoId);
  }
}

// ═══════════════════════════════════════════════════════════════
//  VINCULAR FACTURA EMITIDA A ÍTEM (upload manual desde admin)
// ═══════════════════════════════════════════════════════════════

function _vincularFacturaEmitidaAItem(idItem, parsedEmitida, pdfB64) {
  var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_CV);
  var data  = sheet.getDataRange().getValues();

  for (var i = 2; i < data.length; i++) {
    if (String(data[i][COL_CV.ID_ITEM - 1]) === String(idItem)) {
      var rowNum   = i + 1;
      var pdfBytes = Utilities.base64Decode(pdfB64);
      var driveUrl = _guardarPdfEnDrive(pdfBytes, 'CF_Manual_' + (parsedEmitida.num_factura || idItem) + '.pdf');
      var costo    = parseFloat(data[i][COL_CV.TOTAL_CARBONE - 1] || '0') || 0;
      var venta    = parseFloat(parsedEmitida.total || '0') || 0;

      sheet.getRange(rowNum, COL_CV.FECHA_VENTA).setValue(parsedEmitida.fecha_emision   || '');
      sheet.getRange(rowNum, COL_CV.NUM_FAC_EMITIDA).setValue(parsedEmitida.num_factura || '');
      sheet.getRange(rowNum, COL_CV.NOMBRE_CLIENTE).setValue(parsedEmitida.nombre_cliente || '');
      sheet.getRange(rowNum, COL_CV.RUC_CLIENTE).setValue(parsedEmitida.ruc_cliente      || '');
      sheet.getRange(rowNum, COL_CV.DV_CLIENTE).setValue(parsedEmitida.dv_cliente        || '');
      sheet.getRange(rowNum, COL_CV.TOTAL_VENTA).setValue(venta || '');
      sheet.getRange(rowNum, COL_CV.ITBMS_VENTA).setValue(parsedEmitida.itbms_total     || '');
      sheet.getRange(rowNum, COL_CV.PRECIO_VENTA).setValue(parsedEmitida.subtotal        || '');
      sheet.getRange(rowNum, COL_CV.DRIVE_URL_EMIT).setValue(driveUrl);
      // PATCH 5 — estado 'facturado', color azul, sin cerrar ciclo aquí
      sheet.getRange(rowNum, COL_CV.ESTADO).setValue('facturado');
      sheet.getRange(rowNum, COL_CV.CONFIANZA_MATCH).setValue(100);
      sheet.getRange(rowNum, COL_CV.FLAG_REVISION).setValue(false);
      sheet.getRange(rowNum, COL_CV.MARGEN).setValue(venta - costo);
      sheet.getRange(rowNum, 1, 1, 28).setBackground('#E3F2FD');
      // El ciclo se cierra al registrar el comprobante de pago
      return;
    }
  }
  throw new Error('Item no encontrado: ' + idItem);
}

// ═══════════════════════════════════════════════════════════════
//  CLAUDE — PARSEAR PDF
// ═══════════════════════════════════════════════════════════════

function _claudeParsePdfFactura(pdfB64, mimeType, tipo) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY no configurada');

  var promptCarbone =
    'Eres un extractor de datos de facturas de Empresas Carbone S.A. (proveedor panameño). ' +
    'Analiza este PDF y responde SOLO con JSON válido, sin markdown ni texto adicional:\n' +
    '{"num_factura":"","fecha_emision":"YYYY-MM-DD","ruc_emisor":"","nombre_receptor":"",' +
    '"subtotal":0,"itbms_total":0,"total":0,' +
    '"items":[{"num_item":1,"codigo":"","descripcion":"","cantidad":1,' +
    '"precio_unitario":0,"descuento":0,"itbms":0,"total_item":0}]}\n' +
    'IMPORTANTE: NO extraigas ni incluyas RUC ni DV del receptor. ' +
    'Si un campo no está visible usa null. Los montos deben ser números, no strings.';

  var promptEmitida =
    'Eres un extractor de datos de facturas electrónicas panameñas (DGI). ' +
    'Analiza este Comprobante Auxiliar de Factura Electrónica y responde SOLO con JSON válido:\n' +
    '{"num_factura":"","fecha_emision":"YYYY-MM-DD","ruc_emisor":"","nombre_emisor":"",' +
    '"nombre_cliente":"","ruc_cliente":"","dv_cliente":"","subtotal":0,"itbms_total":0,"total":0,' +
    '"forma_pago":"","items":[{"num_item":1,"codigo":"","descripcion":"","cantidad":1,' +
    '"precio_unitario":0,"descuento":0,"itbms":0,"total_item":0}]}\n' +
    'El campo dv_cliente es el dígito verificador (DV) del RUC del cliente final. ' +
    'Si un campo no está visible usa null. Los montos deben ser números, no strings.';

  var payload = {
    model:      'claude-sonnet-4-20250514',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: mimeType, data: pdfB64 } },
        { type: 'text', text: tipo === 'carbone' ? promptCarbone : promptEmitida }
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
  if (response.getResponseCode() !== 200) {
    throw new Error('Claude API error ' + response.getResponseCode() + ': ' +
                    response.getContentText().substring(0, 200));
  }

  var respData = JSON.parse(response.getContentText());
  var text = '';
  for (var i = 0; i < (respData.content || []).length; i++) {
    if (respData.content[i].type === 'text') { text = respData.content[i].text; break; }
  }
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

// ═══════════════════════════════════════════════════════════════
//  CLAUDE — CLASIFICAR TIPO (fallback)
// ═══════════════════════════════════════════════════════════════

function _claudeClasificarFactura(pdfB64) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) return 'desconocido';

  var payload = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 10,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfB64 } },
        { type: 'text', text: '¿Esta factura panameña fue emitida POR Empresas Carbone S.A. (RUC 1080323-1-554308) o POR Circulo Financiero S.A. (RUC 1753684-1-696883)? Responde SOLO: "carbone" o "emitida" o "desconocido".' }
      ]
    }]
  };

  var options = {
    method: 'post', contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  try {
    var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', options);
    var respData = JSON.parse(response.getContentText());
    var text = '';
    for (var i = 0; i < (respData.content || []).length; i++) {
      if (respData.content[i].type === 'text') { text = respData.content[i].text.trim().toLowerCase(); break; }
    }
    if (text === 'carbone' || text === 'emitida') return text;
  } catch(e) { Logger.log('Error clasificar: ' + e.message); }
  return 'desconocido';
}

// ═══════════════════════════════════════════════════════════════
//  CLAUDE — MATCHING ÍTEMS
// ═══════════════════════════════════════════════════════════════

function _claudeMatchItems(parsedEmitida, pendientes) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY no configurada');

  var itemsEmitidos = JSON.stringify((parsedEmitida.items || []).map(function(it, idx) {
    return { idx: idx, codigo: it.codigo || '', descripcion: it.descripcion || '',
             cantidad: it.cantidad || 1, total_item: it.total_item || 0, itbms: it.itbms || 0 };
  }), null, 2);

  var itemsCarbone = JSON.stringify(pendientes.map(function(p, idx) {
    return { idx: idx, id: p.id, codigo: p.codigo || '', descripcion: p.descripcion || '',
             costo_total: p.total, fecha_compra: p.fecha };
  }), null, 2);

  var prompt =
    'Eres un sistema de matching de facturas para una distribuidora en Panamá.\n\n' +
    'FACTURA EMITIDA:\nNúmero: ' + (parsedEmitida.num_factura || '') +
    '\nFecha: ' + (parsedEmitida.fecha_emision || '') +
    '\nCliente: ' + (parsedEmitida.nombre_cliente || '') +
    '\nTotal: $' + (parsedEmitida.total || 0) +
    '\nÍtems:\n' + itemsEmitidos +
    '\n\nÍTEMS PENDIENTES/INVENTARIO:\n' + itemsCarbone +
    '\n\nREGLAS:\n' +
    '1. Usa el código de producto como criterio principal.\n' +
    '2. Ignora diferencias de hasta $0.10 en montos.\n' +
    '3. UNA factura emitida puede corresponder a MÚLTIPLES ítems.\n' +
    '4. Distribuye el ingreso PROPORCIONALMENTE al costo de cada ítem.\n' +
    '5. Confianza: 95+=mismo código, 80-94=descripción muy similar, 60-79=similar.\n' +
    '6. Solo incluye matches con confianza >= 60.\n\n' +
    'Responde SOLO con JSON válido:\n' +
    '{"matches":[{"idx_emitido":0,"idx_carbone":0,"confianza":95,' +
    '"razon":"mismo código","total_venta_asignado":0,"itbms_venta_asignado":0}]}';

  var payload = {
    model: 'claude-sonnet-4-20250514', max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }]
  };

  var options = {
    method: 'post', contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', options);
  if (response.getResponseCode() !== 200) {
    throw new Error('Claude match API error: ' + response.getResponseCode());
  }

  var respData = JSON.parse(response.getContentText());
  var text = '';
  for (var i = 0; i < (respData.content || []).length; i++) {
    if (respData.content[i].type === 'text') { text = respData.content[i].text; break; }
  }
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

// ═══════════════════════════════════════════════════════════════
//  HELPERS GENERALES
// ═══════════════════════════════════════════════════════════════

function _guardarPdfEnDrive(pdfBytesOrB64, filename) {
  try {
    var folder = DriveApp.getFolderById(CONFIG.VOUCHER_FOLDER_ID);
    var bytes  = (typeof pdfBytesOrB64 === 'string')
                   ? Utilities.base64Decode(pdfBytesOrB64)
                   : pdfBytesOrB64;
    var blob   = Utilities.newBlob(bytes, 'application/pdf', filename);
    var file   = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return 'https://drive.google.com/file/d/' + file.getId() + '/view';
  } catch(err) {
    Logger.log('Error guardando PDF en Drive: ' + err.message);
    return '';
  }
}

function _facturaYaExiste(numFactura, tipo) {
  if (!numFactura) return false;
  var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_CV);
  if (!sheet) return false;
  var data  = sheet.getDataRange().getValues();
  var col   = tipo === 'carbone' ? COL_CV.NUM_FAC_CARBONE - 1 : COL_CV.NUM_FAC_EMITIDA - 1;
  for (var i = 2; i < data.length; i++) {
    if (String(data[i][col]) === String(numFactura)) return true;
  }
  return false;
}

function _parseDate(str) {
  if (!str) return null;
  try {
    var s = String(str).trim();
    var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));
    var d = new Date(s);
    if (!isNaN(d.getTime())) return d;
  } catch(e) {}
  return null;
}

function _similaridad(a, b) {
  if (!a || !b) return 0;
  var wordsA = a.split(/\s+/).filter(function(w) { return w.length > 2; });
  var wordsB = b.split(/\s+/).filter(function(w) { return w.length > 2; });
  if (!wordsA.length || !wordsB.length) return 0;
  var common = 0;
  for (var i = 0; i < wordsA.length; i++) {
    if (wordsB.indexOf(wordsA[i]) !== -1) common++;
  }
  return common / Math.max(wordsA.length, wordsB.length);
}

// ═══════════════════════════════════════════════════════════════
//  _handleRegistrarPagoOperacion
//  Registra comprobante de pago para un ítem 'facturado' → cierra ciclo
// ═══════════════════════════════════════════════════════════════

function _handleRegistrarPagoOperacion(params, callback) {
  var result = { success: false, ingresoId: null, egresoId: null, error: null };
  try {
    var idItem    = params.id_item    || '';
    var formaPago = params.forma_pago || '';
    var driveUrl  = params.driveUrl   || '';

    if (!idItem) throw new Error('id_item requerido');

    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_CV);
    if (!sheet) throw new Error('Hoja Compras_Ventas no encontrada');

    var data  = sheet.getDataRange().getValues();
    var found = false;

    for (var i = 2; i < data.length; i++) {
      if (String(data[i][COL_CV.ID_ITEM - 1]) !== idItem) continue;

      var estadoActual = String(data[i][COL_CV.ESTADO - 1] || '').trim();
      if (estadoActual !== 'facturado') {
        throw new Error('El ítem no está en estado "facturado". Estado actual: ' + estadoActual);
      }

      var guardVal = String(data[i][COL_CV.INGRESO_ID - 1] || '').trim();
      if (guardVal) throw new Error('Este ítem ya tiene un ingreso registrado: ' + guardVal);

      var rowNum = i + 1;

      // Escribir driveUrl y forma_pago en la hoja antes de leer para _intentarCerrarCiclo
      if (driveUrl) {
        sheet.getRange(rowNum, COL_CV.DRIVE_URL_EMIT).setValue(driveUrl);
      }
      if (formaPago) {
        var notaActual = String(data[i][COL_CV.NOTAS - 1] || '');
        sheet.getRange(rowNum, COL_CV.NOTAS).setValue(
          notaActual + ' | Pago: ' + formaPago
        );
      }

      // Flush para que _intentarCerrarCiclo lea los valores actualizados
      SpreadsheetApp.flush();

      // Llamar _intentarCerrarCiclo — hace ingreso + egreso + estado cerrado
      _intentarCerrarCiclo(rowNum, sheet);

      // Leer resultado: el ingreso_id ya fue escrito por _intentarCerrarCiclo
      SpreadsheetApp.flush();
      var ingresoId = String(sheet.getRange(rowNum, COL_CV.INGRESO_ID).getValue() || '');

      result.success   = true;
      result.ingresoId = ingresoId || null;
      found = true;
      Logger.log('✅ Pago registrado: ' + idItem + ' → Ingreso: ' + ingresoId);
      break;
    }

    if (!found) throw new Error('Ítem no encontrado: ' + idItem);

  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleRegistrarPagoOperacion: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════
//  _handleMarcarCostoOperativo
//  Convierte un ítem 'pendiente' en egreso costo_operativo y lo cierra
// ═══════════════════════════════════════════════════════════════

function _handleMarcarCostoOperativo(params, callback) {
  var result = { success: false, egresoId: null, error: null };
  try {
    var idItem      = params.id_item     || '';
    var categoria   = params.categoria   || 'otros_deducibles';
    var descripcion = params.descripcion || '';
    var notas       = params.notas       || '';
    var driveUrl    = params.driveUrl    || '';

    if (!idItem) throw new Error('id_item requerido');

    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_CV);
    if (!sheet) throw new Error('Hoja Compras_Ventas no encontrada');

    var data  = sheet.getDataRange().getValues();
    var found = false;

    for (var i = 2; i < data.length; i++) {
      if (String(data[i][COL_CV.ID_ITEM - 1]) !== idItem) continue;

      var estadoActual = String(data[i][COL_CV.ESTADO - 1] || '').trim();
      if (estadoActual !== 'pendiente') {
        throw new Error('Solo ítems en estado "pendiente" pueden marcarse como costo operativo. Estado actual: ' + estadoActual);
      }

      var rowNum       = i + 1;
      var totalCarb    = parseFloat(data[i][COL_CV.TOTAL_CARBONE - 1] || '0') || 0;
      var itbmsCarb    = parseFloat(data[i][COL_CV.ITBMS_CARBONE - 1] || '0') || 0;
      var subtotalCarb = 0;
      if (totalCarb > 0) {
        subtotalCarb = itbmsCarb > 0
          ? parseFloat((totalCarb - itbmsCarb).toFixed(2))
          : parseFloat((totalCarb / 1.07).toFixed(2));
        if (!itbmsCarb) itbmsCarb = parseFloat((totalCarb - subtotalCarb).toFixed(2));
      }

      var numFacCarb = String(data[i][COL_CV.NUM_FAC_CARBONE - 1] || '');
      var driveCarb  = driveUrl || String(data[i][COL_CV.DRIVE_URL_CARB - 1] || '');
      var desc       = descripcion || String(data[i][COL_CV.DESCRIPCION_PROD - 1] || '');

      var fechaCompra = data[i][COL_CV.FECHA_COMPRA - 1];
      if (fechaCompra instanceof Date) {
        fechaCompra = Utilities.formatDate(fechaCompra, 'America/Panama', 'yyyy-MM-dd');
      } else {
        fechaCompra = String(fechaCompra || '').slice(0, 10);
      }

      var ahora   = new Date();
      var yearEgr = fechaCompra ? new Date(fechaCompra + 'T12:00:00').getFullYear() : ahora.getFullYear();

      // Correlativo egreso
      var sheetEgr   = ss.getSheetByName(SHEET_EGRESOS);
      if (!sheetEgr) sheetEgr = _initEgresosSheet(ss);

      var seqEgr     = 1;
      var lastEgrRow = sheetEgr.getLastRow();
      if (lastEgrRow > 2) {
        var idsEgr = sheetEgr.getRange(3, COL_E.ID, lastEgrRow - 2, 1).getValues();
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

      var filaEgr = new Array(EGRESOS_NCOLS);
      for (var xe = 0; xe < EGRESOS_NCOLS; xe++) filaEgr[xe] = '';

      filaEgr[COL_E.ID - 1]          = egresoId;
      filaEgr[COL_E.FECHA_REG - 1]   = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
      filaEgr[COL_E.ESTADO - 1]      = 'registrado';
      filaEgr[COL_E.FECHA_GASTO - 1] = fechaCompra || Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd');
      filaEgr[COL_E.MES - 1]         = mesEgr;
      filaEgr[COL_E.ANIO - 1]        = anioEgr;
      filaEgr[COL_E.SUBTOTAL - 1]    = subtotalCarb || '';
      filaEgr[COL_E.ITBMS - 1]       = itbmsCarb    || '';
      filaEgr[COL_E.TOTAL - 1]       = totalCarb    || '';
      filaEgr[COL_E.MONEDA - 1]      = 'USD';
      filaEgr[COL_E.TIPO_EGRESO - 1] = 'costo_operativo';
      filaEgr[COL_E.CATEGORIA - 1]   = categoria;
      filaEgr[COL_E.PROVEEDOR - 1]   = 'Empresas Carbone S.A.';
      filaEgr[COL_E.RUC_PROV - 1]    = '1080323-1-554308';
      filaEgr[COL_E.DV_PROV - 1]     = '54';
      filaEgr[COL_E.NFACTURA - 1]    = numFacCarb;
      filaEgr[COL_E.ID_ITEM_CV - 1]  = idItem;
      filaEgr[COL_E.DRIVE_URL - 1]   = driveCarb;
      filaEgr[COL_E.DESCRIPCION - 1] = desc;
      filaEgr[COL_E.NOTAS - 1]       = 'Costo operativo · ítem CV: ' + idItem + (notas ? ' | ' + notas : '');

      var newEgrRow = sheetEgr.getLastRow() + 1;
      sheetEgr.getRange(newEgrRow, 1, 1, EGRESOS_NCOLS).setValues([filaEgr]);
      sheetEgr.getRange(newEgrRow, COL_E.SUBTOTAL, 1, 3).setNumberFormat('#,##0.00');
      sheetEgr.getRange(newEgrRow, 1, 1, EGRESOS_NCOLS).setBackground('#F3E5F5');

      // Marcar ítem como cerrado en CV (no genera ingreso)
      sheet.getRange(rowNum, COL_CV.ESTADO).setValue('cerrado');
      sheet.getRange(rowNum, COL_CV.INGRESO_ID).setValue('OPERATIVO-' + egresoId);
      sheet.getRange(rowNum, 1, 1, 28).setBackground('#F3E5F5');
      var notaActual = String(sheet.getRange(rowNum, COL_CV.NOTAS).getValue() || '');
      sheet.getRange(rowNum, COL_CV.NOTAS).setValue(
        notaActual + ' | Cerrado como costo_operativo → ' + egresoId
      );

      result.success  = true;
      result.egresoId = egresoId;
      found = true;
      Logger.log('✅ Costo operativo: ' + egresoId + ' | ítem: ' + idItem + ' | $' + totalCarb);
      break;
    }

    if (!found) throw new Error('Ítem no encontrado: ' + idItem);

  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleMarcarCostoOperativo: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════
//  _handleVincularOrdenWeb
//  Vincula o desvincula manualmente una orden web a un ítem CV
// ═══════════════════════════════════════════════════════════════

function _handleVincularOrdenWeb(params, callback) {
  var result = { success: false, error: null };
  try {
    var idItem   = params.id_item   || '';
    var ordenNum = params.orden_num || '';
    if (!idItem) throw new Error('id_item requerido');

    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_CV);
    if (!sheet) throw new Error('Hoja Compras_Ventas no encontrada');

    var data  = sheet.getDataRange().getValues();
    var found = false;

    for (var i = 2; i < data.length; i++) {
      if (String(data[i][COL_CV.ID_ITEM - 1]) !== idItem) continue;
      sheet.getRange(i + 1, COL_CV.ID_ORDEN_WEB).setValue(ordenNum);
      found = true;
      Logger.log('✅ Orden web vinculada manualmente: ' + idItem + ' → ' + (ordenNum || 'ninguna'));
      break;
    }

    if (!found) throw new Error('Ítem no encontrado: ' + idItem);
    result.success = true;

  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleVincularOrdenWeb: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════
//  INIT — ejecutar UNA SOLA VEZ
// ═══════════════════════════════════════════════════════════════

function initComprasVentasSheet() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  if (ss.getSheetByName(SHEET_CV)) {
    Logger.log('⚠️ Hoja "' + SHEET_CV + '" ya existe.');
    return;
  }
  var sheet = ss.insertSheet(SHEET_CV);
  SpreadsheetApp.flush();

  var meta = [
    'ID','REGISTRO','ESTADO','FUENTE','MATCH','',
    'COMPRA (Carbone)','','','','','','',
    'VENTA (Factura emitida)','','','','','','','','',
    'VÍNCULOS','','','','','CANT',
  ];
  var headers = [
    'id_item','fecha_registro','estado','fuente','confianza_match','flag_revision',
    'fecha_compra','num_factura_carbone','codigo_producto','descripcion_producto',
    'precio_unit_carbone','itbms_carbone','total_carbone',
    'fecha_venta','num_factura_emitida','nombre_cliente','ruc_cliente','dv_cliente',
    'precio_venta','itbms_venta','total_venta','margen',
    'id_orden_web','drive_url_carbone','drive_url_emitida','notas','ingreso_id','cantidad',
  ];

  sheet.getRange(1, 1, 1, meta.length).setValues([meta]);
  sheet.getRange(1, 1, 1, meta.length).setBackground('#37474F').setFontColor('#FFF').setFontWeight('bold');
  sheet.getRange(2, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(2, 1, 1, headers.length).setBackground('#546E7A').setFontColor('#FFF').setFontWeight('bold');
  sheet.getRange(1, 7, 1, 7).setBackground('#E65100');
  sheet.getRange(1, 14, 1, 9).setBackground('#1B5E20');
  sheet.setFrozenRows(2);

  // PATCH 1 — 'facturado' añadido a la lista de estados válidos
  var ruleEstado = SpreadsheetApp.newDataValidation()
    .requireValueInList(['pendiente', 'inventario', 'vinculado', 'facturado', 'cerrado'], true)
    .setAllowInvalid(false).build();
  sheet.getRange('C3:C1000').setDataValidation(ruleEstado);

  var w = [150,140,100,110,80,80,100,140,110,280,100,90,90,100,140,160,110,60,80,80,90,90,130,220,220,250,150,70];
  for (var i = 0; i < w.length; i++) sheet.setColumnWidth(i + 1, w[i]);

  sheet.getRange('K3:M1000').setNumberFormat('#,##0.00');
  sheet.getRange('S3:W1000').setNumberFormat('#,##0.00');

  Logger.log('✅ Hoja "' + SHEET_CV + '" creada.');
}