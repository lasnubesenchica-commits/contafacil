// ═══════════════════════════════════════════════════════════════
//  ContaFacil_Proveedores.gs
//  Módulo: Gestión de Proveedores — BalanceClip
//  v1.0 — Multi-proveedor: onboarding, config, detección dinámica
//
//  DEPENDENCIAS: debe estar en el mismo proyecto que el backend
//  principal y ContaFacil_Operaciones.gs
//  NO redefine COL_E, COL_CV, CONFIG — los hereda del contexto GAS.
// ═══════════════════════════════════════════════════════════════

var SHEET_PROVEEDORES  = 'Proveedores_Config';
var PROV_NCOLS         = 11;

// Columnas de Proveedores_Config (base 1)
var COL_P = {
  ID:              1,  // A  id_proveedor (PROV-001)
  NOMBRE:          2,  // B  nombre
  RUC:             3,  // C  ruc
  DV:              4,  // D  dv
  EMAIL_ORIGEN:    5,  // E  email_origen (from: filtro Gmail)
  KEYWORDS:        6,  // F  keywords_deteccion (csv separado por |)
  PROMPT_OVERRIDE: 7,  // G  prompt_override (texto adicional para Claude)
  ACTIVO:          8,  // H  activo (TRUE/FALSE)
  FECHA_ALTA:      9,  // I  fecha_alta
  DRIVE_EJEMPLO:   10, // J  drive_url_factura_ejemplo
  NOTAS:           11, // K  notas
};

// ═══════════════════════════════════════════════════════════════
//  INIT — crear hoja Proveedores_Config con Carbone pre-cargado
//  Llamar UNA SOLA VEZ desde initSheets() o manualmente.
// ═══════════════════════════════════════════════════════════════

function initProveedoresSheet() {
  var ss       = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var existing = ss.getSheetByName(SHEET_PROVEEDORES);
  if (existing) {
    Logger.log('⚠️ Hoja "' + SHEET_PROVEEDORES + '" ya existe.');
    return existing;
  }

  var sheet = ss.insertSheet(SHEET_PROVEEDORES);
  SpreadsheetApp.flush();

  // Fila 1: agrupadores semánticos
  var meta = ['ID','DATOS FISCALES','','','GMAIL','DETECCIÓN IA','','CONFIG','','ARCHIVO','NOTAS'];
  sheet.getRange(1, 1, 1, PROV_NCOLS).setValues([meta]);
  sheet.getRange(1, 1, 1, PROV_NCOLS)
    .setBackground('#37474F').setFontColor('#FFF').setFontWeight('bold');

  // Fila 2: nombres de columnas
  var headers = [
    'id_proveedor','nombre','ruc','dv','email_origen',
    'keywords_deteccion','prompt_override','activo','fecha_alta',
    'drive_url_ejemplo','notas'
  ];
  sheet.getRange(2, 1, 1, PROV_NCOLS).setValues([headers]);
  sheet.getRange(2, 1, 1, PROV_NCOLS)
    .setBackground('#546E7A').setFontColor('#FFF').setFontWeight('bold');
  sheet.setFrozenRows(2);

  // Validación booleana para columna "activo"
  var ruleActivo = SpreadsheetApp.newDataValidation()
    .requireCheckbox().build();
  sheet.getRange('H3:H100').setDataValidation(ruleActivo);

  // Anchos de columna
  var widths = [90, 200, 130, 50, 220, 200, 350, 60, 110, 300, 200];
  for (var i = 0; i < widths.length; i++) sheet.setColumnWidth(i + 1, widths[i]);

  // ── Pre-cargar Carbone como proveedor #1 ──────────────────
  var ahora  = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
  var carbone = new Array(PROV_NCOLS);
  for (var x = 0; x < PROV_NCOLS; x++) carbone[x] = '';
  carbone[COL_P.ID - 1]           = 'PROV-001';
  carbone[COL_P.NOMBRE - 1]       = 'Empresas Carbone S.A.';
  carbone[COL_P.RUC - 1]          = '1080323-1-554308';
  carbone[COL_P.DV - 1]           = '54';
  carbone[COL_P.EMAIL_ORIGEN - 1] = 'carbone';   // keyword de dominio
  carbone[COL_P.KEYWORDS - 1]     = '1080323|EMPRESAS CARBONE|fe01200001080323';
  carbone[COL_P.PROMPT_OVERRIDE- 1] = '';
  carbone[COL_P.ACTIVO - 1]       = true;
  carbone[COL_P.FECHA_ALTA - 1]   = ahora;
  carbone[COL_P.DRIVE_EJEMPLO - 1]= '';
  carbone[COL_P.NOTAS - 1]        = 'Proveedor original — migrado automáticamente';

  sheet.getRange(3, 1, 1, PROV_NCOLS).setValues([carbone]);
  sheet.getRange(3, 1, 1, PROV_NCOLS).setBackground('#FFF3E0');

  Logger.log('✅ Hoja "' + SHEET_PROVEEDORES + '" creada con Carbone pre-cargado.');
  return sheet;
}

// ═══════════════════════════════════════════════════════════════
//  LEER PROVEEDORES ACTIVOS (caché en memoria por request)
//  Devuelve array de objetos proveedor. Llama desde los módulos
//  de detección y procesamiento para evitar re-leer el sheet.
// ═══════════════════════════════════════════════════════════════

var _proveedoresCache = null;

function _getProveedoresActivos() {
  if (_proveedoresCache) return _proveedoresCache;

  var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_PROVEEDORES);
  if (!sheet || sheet.getLastRow() <= 2) {
    // Si no existe la hoja, devolver solo Carbone hardcodeado
    // para mantener compatibilidad con instalaciones antiguas
    return [{
      id:              'PROV-001',
      nombre:          'Empresas Carbone S.A.',
      ruc:             '1080323-1-554308',
      dv:              '54',
      email_origen:    'carbone',
      keywords:        ['1080323', 'EMPRESAS CARBONE', 'fe01200001080323'],
      prompt_override: '',
      activo:          true,
    }];
  }

  var numRows = sheet.getLastRow() - 2;
  var data    = sheet.getRange(3, 1, numRows, PROV_NCOLS).getValues();
  var result  = [];

  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    if (!r[COL_P.ID - 1]) continue;
    var activo = r[COL_P.ACTIVO - 1];
    if (activo === false || String(activo).toLowerCase() === 'false') continue;

    var kwRaw = String(r[COL_P.KEYWORDS - 1] || '');
    var kws   = kwRaw ? kwRaw.split('|').map(function(k) { return k.trim().toUpperCase(); }) : [];

    result.push({
      id:              String(r[COL_P.ID - 1]           || ''),
      nombre:          String(r[COL_P.NOMBRE - 1]       || ''),
      ruc:             String(r[COL_P.RUC - 1]          || ''),
      dv:              String(r[COL_P.DV - 1]           || ''),
      email_origen:    String(r[COL_P.EMAIL_ORIGEN - 1] || '').toLowerCase(),
      keywords:        kws,
      prompt_override: String(r[COL_P.PROMPT_OVERRIDE - 1] || ''),
      activo:          true,
    });
  }

  _proveedoresCache = result;
  return result;
}

// ═══════════════════════════════════════════════════════════════
//  DETECCIÓN DINÁMICA DE TIPO/PROVEEDOR
//
//  Reemplaza la lógica hardcodeada de _detectarTipoFactura en
//  ContaFacil_Operaciones.gs. Devuelve:
//    { tipo: 'carbone'|'emitida'|'desconocido', proveedor: {...}|null }
//
//  MIGRACIÓN: en _detectarTipoFactura(), reemplazar el bloque
//  hardcodeado por:
//    var det = _detectarTipoFacturaDinamico(xmlStr, fileName, pdfB64);
//    return det.tipo;
// ═══════════════════════════════════════════════════════════════

function _detectarTipoFacturaDinamico(xmlStr, fileName, pdfB64) {
  var proveedores = _getProveedoresActivos();
  var fn          = (fileName || '').toUpperCase();
  var xmlUp       = (xmlStr   || '').toUpperCase();

  // 1 ── Chequear si es factura EMITIDA por Círculo Financiero
  if (xmlStr) {
    if (xmlStr.indexOf(RUC_EMPRESA) !== -1 ||
        xmlStr.toUpperCase().indexOf(NOMBRE_EMPRESA.toUpperCase()) !== -1) {
      return { tipo: 'emitida', proveedor: null };
    }
  }
  var rucSinGuiones = RUC_EMPRESA.replace(/-/g, '');
    if (fn.indexOf(rucSinGuiones) !== -1 || fn.indexOf(RUC_EMPRESA) !== -1) {
    return { tipo: 'emitida', proveedor: null };
  }

  // 2 ── Buscar coincidencia entre proveedores registrados
  for (var i = 0; i < proveedores.length; i++) {
    var prov = proveedores[i];

    // Chequeo por RUC en XML
    if (xmlStr && xmlStr.indexOf(prov.ruc) !== -1) {
      return { tipo: 'carbone', proveedor: prov };
    }

    // Chequeo por keywords en XML y nombre de archivo
    for (var k = 0; k < prov.keywords.length; k++) {
      var kw = prov.keywords[k];
      if (!kw) continue;
      if (xmlUp.indexOf(kw) !== -1) return { tipo: 'carbone', proveedor: prov };
      if (fn.indexOf(kw)    !== -1) return { tipo: 'carbone', proveedor: prov };
    }

    // Chequeo por email_origen en nombre de archivo
    if (prov.email_origen && fn.indexOf(prov.email_origen.toUpperCase()) !== -1) {
      return { tipo: 'carbone', proveedor: prov };
    }
  }

  // 3 ── Fallback: Claude clasifica el PDF
  if (pdfB64) {
    var provNombres = proveedores.map(function(p) {
      return '"' + p.nombre + '" (RUC ' + p.ruc + ')';
    }).join(', ');
    var tipoFallback = _claudeClasificarFacturaDinamico(pdfB64, proveedores);
    return tipoFallback;
  }

  return { tipo: 'desconocido', proveedor: null };
}

// ═══════════════════════════════════════════════════════════════
//  CLAUDE — Clasificación dinámica (fallback multi-proveedor)
// ═══════════════════════════════════════════════════════════════

function _claudeClasificarFacturaDinamico(pdfB64, proveedores) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) return { tipo: 'desconocido', proveedor: null };

  // Construir pregunta con todos los proveedores registrados
  var opciones = proveedores.map(function(p, idx) {
    return '"PROV' + idx + '" para ' + p.nombre + ' (RUC: ' + p.ruc + ')';
  });
  var opcionesStr = opciones.join(', ') +
    ', "emitida" si fue emitida POR Círculo Financiero S.A. (RUC 1753684-1-696883)' +
    ', o "desconocido".';

  var prompt = '¿Esta factura panameña fue emitida POR cuál empresa? ' +
    'Responde SOLO con: ' + opcionesStr +
    ' Sin texto adicional.';

  var payload = {
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 20,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfB64 } },
        { type: 'text', text: prompt }
      ]
    }]
  };

  try {
    var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post', contentType: 'application/json',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    var respData = JSON.parse(response.getContentText());
    var text = '';
    for (var i = 0; i < (respData.content || []).length; i++) {
      if (respData.content[i].type === 'text') { text = respData.content[i].text.trim(); break; }
    }
    if (text === 'emitida') return { tipo: 'emitida', proveedor: null };
    // Buscar si la respuesta es PROV0, PROV1, etc.
    var mProv = text.match(/^PROV(\d+)$/i);
    if (mProv) {
      var idx = parseInt(mProv[1]);
      if (proveedores[idx]) return { tipo: 'carbone', proveedor: proveedores[idx] };
    }
  } catch(e) {
    Logger.log('Error _claudeClasificarFacturaDinamico: ' + e.message);
  }
  return { tipo: 'desconocido', proveedor: null };
}

// ═══════════════════════════════════════════════════════════════
//  CLAUDE — Parse de factura con prompt_override inyectado
//
//  Wrapper sobre _claudeParsePdfFactura que inyecta el
//  prompt_override del proveedor antes de llamar a Claude.
//  Usar en _procesarFacturaCarbone() en lugar de la llamada directa.
// ═══════════════════════════════════════════════════════════════

function _claudeParsePdfFacturaProveedor(pdfB64, proveedor) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY no configurada');

  var nombreProv   = proveedor ? proveedor.nombre : 'proveedor panameño';
  var rucProv      = proveedor ? proveedor.ruc    : '';
  var extraPrompt  = (proveedor && proveedor.prompt_override) ? '\n\nNOTA ADICIONAL PARA ESTE PROVEEDOR:\n' + proveedor.prompt_override : '';

  var promptBase =
    'Eres un extractor de datos de facturas de ' + nombreProv +
    (rucProv ? ' (RUC: ' + rucProv + ')' : '') + ', proveedor panameño. ' +
    'Analiza este PDF y responde SOLO con JSON válido, sin markdown ni texto adicional:\n' +
    '{"num_factura":"","fecha_emision":"YYYY-MM-DD","ruc_emisor":"","nombre_receptor":"",' +
    '"subtotal":0,"itbms_total":0,"total":0,' +
    '"items":[{"num_item":1,"codigo":"","descripcion":"","cantidad":1,' +
    '"precio_unitario":0,"descuento":0,"itbms":0,"total_item":0}]}\n' +
    'IMPORTANTE: NO extraigas ni incluyas RUC ni DV del receptor. ' +
    'Si un campo no está visible usa null. Los montos deben ser números, no strings.' +
    extraPrompt;

  var payload = {
    model:      'claude-sonnet-4-20250514',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfB64 } },
        { type: 'text', text: promptBase }
      ]
    }]
  };

  var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

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
//  HANDLERS — llamados desde doGet / doPost
// ═══════════════════════════════════════════════════════════════

// ── GET: listar proveedores ─────────────────────────────────
function _handleGetProveedores(params, callback) {
  var result = { success: false, items: [], error: null };
  try {
    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_PROVEEDORES);

    if (!sheet || sheet.getLastRow() <= 2) {
      result.success = true;
      result.items   = [];
      var j0 = JSON.stringify(result);
      if (callback) return ContentService.createTextOutput(callback + '(' + j0 + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
      return ContentService.createTextOutput(j0).setMimeType(ContentService.MimeType.JSON);
    }

    var numRows = sheet.getLastRow() - 2;
    var data    = sheet.getRange(3, 1, numRows, PROV_NCOLS).getValues();
    var items   = [];

    for (var i = 0; i < data.length; i++) {
      var r = data[i];
      if (!r[COL_P.ID - 1]) continue;
      items.push({
        id:              String(r[COL_P.ID - 1]              || ''),
        nombre:          String(r[COL_P.NOMBRE - 1]          || ''),
        ruc:             String(r[COL_P.RUC - 1]             || ''),
        dv:              String(r[COL_P.DV - 1]              || ''),
        email_origen:    String(r[COL_P.EMAIL_ORIGEN - 1]    || ''),
        keywords:        String(r[COL_P.KEYWORDS - 1]        || ''),
        prompt_override: String(r[COL_P.PROMPT_OVERRIDE - 1] || ''),
        activo:          r[COL_P.ACTIVO - 1] !== false,
        fecha_alta:      String(r[COL_P.FECHA_ALTA - 1]      || ''),
        drive_ejemplo:   String(r[COL_P.DRIVE_EJEMPLO - 1]   || ''),
        notas:           String(r[COL_P.NOTAS - 1]           || ''),
        _row:            i + 3,
      });
    }

    result.success = true;
    result.items   = items;
  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleGetProveedores: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// ── POST: analizar factura de ejemplo y extraer datos ──────
//  Payload: { action:'analizarFacturaEjemplo', imageBase64, mimeType }
//  Respuesta: campos extraídos para que Ramon confirme en UI
function _handleAnalizarFacturaEjemplo(data) {
  try {
    var b64      = data.imageBase64 || '';
    var mimeType = data.mimeType    || 'image/jpeg';
    if (!b64) throw new Error('imageBase64 requerido');

    if (mimeType === 'application/octet-stream') mimeType = 'image/jpeg';

    var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
    if (!apiKey) throw new Error('CLAUDE_API_KEY no configurada');

    var contentBlock;
    if (mimeType === 'application/pdf') {
      contentBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
    } else {
      var validImg = ['image/jpeg','image/png','image/webp','image/gif'];
      var imgMime  = validImg.indexOf(mimeType) >= 0 ? mimeType : 'image/jpeg';
      contentBlock = { type: 'image', source: { type: 'base64', media_type: imgMime, data: b64 } };
    }

    var prompt =
      'Analiza esta factura comercial panameña (puede ser DGI e-Tax 2.0 u otro formato). ' +
      'Extrae los datos del EMISOR (quien emite la factura, no el receptor). ' +
      'Responde SOLO con JSON válido, sin markdown ni texto adicional:\n' +
      '{\n' +
      '  "nombre_proveedor": "nombre completo de la empresa emisora",\n' +
      '  "ruc": "RUC del emisor (sin DV)",\n' +
      '  "dv": "dígito verificador del emisor, solo el número",\n' +
      '  "email_origen": "dominio o parte del email del emisor si es visible, sino null",\n' +
      '  "keywords_sugeridas": ["palabras clave únicas para identificar este proveedor: RUC sin guiones, nombre corto, etc."],\n' +
      '  "tiene_itbms": true,\n' +
      '  "formato_num_factura": "descripción del formato del número de factura, ej: \'FAC-XXXXX\' o \'001-XXX-XXXXXXXX\'",\n' +
      '  "notas_formato": "cualquier particularidad del formato de esta factura que ayude a extraer datos en el futuro"\n' +
      '}\n' +
      'Si un campo no es visible usa null. Montos como números.';

    var payload = {
      model:      'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages: [{
        role:    'user',
        content: [ contentBlock, { type: 'text', text: prompt } ]
      }]
    };

    var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post', contentType: 'application/json',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });

    if (response.getResponseCode() !== 200) {
      throw new Error('Claude API error ' + response.getResponseCode() + ': ' +
                      response.getContentText().substring(0, 200));
    }

    var respData = JSON.parse(response.getContentText());
    var text = '';
    for (var i = 0; i < (respData.content || []).length; i++) {
      if (respData.content[i].type === 'text') { text = respData.content[i].text; break; }
    }
    var parsed = JSON.parse(text.replace(/```json|```/g, '').trim());

    // Construir keywords sugeridas: RUC (sin guiones), nombre corto, las de Claude
    var kwSet = {};
    if (parsed.ruc) {
      kwSet[parsed.ruc.toUpperCase()]                    = true;
      kwSet[parsed.ruc.replace(/-/g, '').toUpperCase()] = true;
    }
    if (Array.isArray(parsed.keywords_sugeridas)) {
      for (var ki = 0; ki < parsed.keywords_sugeridas.length; ki++) {
        kwSet[String(parsed.keywords_sugeridas[ki]).toUpperCase()] = true;
      }
    }
    var kwFinal = Object.keys(kwSet).filter(function(k) { return k.length > 3; });

    return ContentService
      .createTextOutput(JSON.stringify({
        success:           true,
        nombre_proveedor:  parsed.nombre_proveedor  || null,
        ruc:               parsed.ruc               || null,
        dv:                parsed.dv                || null,
        email_origen:      parsed.email_origen      || null,
        keywords:          kwFinal.join('|'),
        tiene_itbms:       !!parsed.tiene_itbms,
        formato_num_fac:   parsed.formato_num_factura || null,
        notas_formato:     parsed.notas_formato      || null,
      }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch(err) {
    Logger.log('Error _handleAnalizarFacturaEjemplo: ' + err.message);
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ── POST: guardar proveedor nuevo o actualizar existente ────
//  Payload: { action:'guardarProveedor', id?, nombre, ruc, dv,
//             email_origen, keywords, prompt_override, activo,
//             imageBase64?, imageName?, mimeType? }
function _handleGuardarProveedor(data) {
  try {
    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_PROVEEDORES);
    if (!sheet) sheet = initProveedoresSheet();

    var ahora    = new Date();
    var fechaReg = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');

    // Subir factura de ejemplo a Drive si viene en el payload
    var driveEjemplo = '';
    if (data.imageBase64 && data.imageName) {
      try {
        var folder   = DriveApp.getFolderById(CONFIG.VOUCHER_FOLDER_ID);
        var mimeType = data.mimeType || 'application/pdf';
        var bytes    = Utilities.base64Decode(data.imageBase64);
        var blob     = Utilities.newBlob(bytes, mimeType, data.imageName);
        var file     = folder.createFile(blob);
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        driveEjemplo = 'https://drive.google.com/file/d/' + file.getId() + '/view';
      } catch(driveErr) {
        Logger.log('Error subiendo ejemplo a Drive: ' + driveErr.message);
      }
    }

    var nombre   = String(data.nombre          || '').trim();
    var ruc      = String(data.ruc             || '').trim();
    var dv       = String(data.dv              || '').trim();
    var emailOri = String(data.email_origen    || '').trim().toLowerCase();
    var keywords = String(data.keywords        || '').trim();
    var promptOv = String(data.prompt_override || '').trim();
    var activo   = data.activo !== false;
    var notas    = String(data.notas           || '').trim();

    if (!nombre || !ruc) throw new Error('nombre y ruc son requeridos');

    // Auto-completar keywords con el RUC si no está incluido
    var kwArr = keywords ? keywords.split('|').map(function(k) { return k.trim().toUpperCase(); }) : [];
    var rucUp  = ruc.replace(/-/g, '').toUpperCase();
    if (kwArr.indexOf(rucUp) === -1) kwArr.push(rucUp);
    var rucFmt = ruc.toUpperCase();
    if (kwArr.indexOf(rucFmt) === -1) kwArr.push(rucFmt);
    var nombreShort = nombre.split(' ')[0].toUpperCase();
    if (nombreShort.length > 3 && kwArr.indexOf(nombreShort) === -1) kwArr.push(nombreShort);
    keywords = kwArr.filter(function(k) { return k.length > 2; }).join('|');

    // ── Actualizar fila existente si se pasó un id ──────────
    if (data.id) {
      var lastRow = sheet.getLastRow();
      if (lastRow > 2) {
        var existData = sheet.getRange(3, 1, lastRow - 2, PROV_NCOLS).getValues();
        for (var i = 0; i < existData.length; i++) {
          if (String(existData[i][COL_P.ID - 1]) === String(data.id)) {
            var rowNum = i + 3;
            sheet.getRange(rowNum, COL_P.NOMBRE).setValue(nombre);
            sheet.getRange(rowNum, COL_P.RUC).setValue(ruc);
            sheet.getRange(rowNum, COL_P.DV).setValue(dv);
            sheet.getRange(rowNum, COL_P.EMAIL_ORIGEN).setValue(emailOri);
            sheet.getRange(rowNum, COL_P.KEYWORDS).setValue(keywords);
            sheet.getRange(rowNum, COL_P.PROMPT_OVERRIDE).setValue(promptOv);
            sheet.getRange(rowNum, COL_P.ACTIVO).setValue(activo);
            sheet.getRange(rowNum, COL_P.NOTAS).setValue(notas);
            if (driveEjemplo) sheet.getRange(rowNum, COL_P.DRIVE_EJEMPLO).setValue(driveEjemplo);
            _proveedoresCache = null; // invalidar caché
            Logger.log('✅ Proveedor actualizado: ' + data.id + ' — ' + nombre);
            return ContentService
              .createTextOutput(JSON.stringify({ success: true, id: data.id, driveEjemplo: driveEjemplo }))
              .setMimeType(ContentService.MimeType.JSON);
          }
        }
      }
    }

    // ── Insertar nuevo proveedor ────────────────────────────
    // Generar ID correlativo: PROV-001, PROV-002, ...
    var maxSeq = 0;
    var lastRowN = sheet.getLastRow();
    if (lastRowN > 2) {
      var idsData = sheet.getRange(3, COL_P.ID, lastRowN - 2, 1).getValues();
      for (var j = 0; j < idsData.length; j++) {
        var idStr = String(idsData[j][0] || '');
        var mId   = idStr.match(/PROV-(\d+)/i);
        if (mId) { var nId = parseInt(mId[1]); if (nId > maxSeq) maxSeq = nId; }
      }
    }
    var newId = 'PROV-' + String(maxSeq + 1).padStart(3, '0');

    var fila = new Array(PROV_NCOLS);
    for (var x = 0; x < PROV_NCOLS; x++) fila[x] = '';
    fila[COL_P.ID - 1]              = newId;
    fila[COL_P.NOMBRE - 1]          = nombre;
    fila[COL_P.RUC - 1]             = ruc;
    fila[COL_P.DV - 1]              = dv;
    fila[COL_P.EMAIL_ORIGEN - 1]    = emailOri;
    fila[COL_P.KEYWORDS - 1]        = keywords;
    fila[COL_P.PROMPT_OVERRIDE - 1] = promptOv;
    fila[COL_P.ACTIVO - 1]          = activo;
    fila[COL_P.FECHA_ALTA - 1]      = fechaReg;
    fila[COL_P.DRIVE_EJEMPLO - 1]   = driveEjemplo;
    fila[COL_P.NOTAS - 1]           = notas;

    var newRow = sheet.getLastRow() + 1;
    sheet.getRange(newRow, 1, 1, PROV_NCOLS).setValues([fila]);
    sheet.getRange(newRow, 1, 1, PROV_NCOLS).setBackground('#F1F8E9');

    _proveedoresCache = null; // invalidar caché
    Logger.log('✅ Proveedor nuevo: ' + newId + ' — ' + nombre);

    return ContentService
      .createTextOutput(JSON.stringify({ success: true, id: newId, driveEjemplo: driveEjemplo }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch(err) {
    Logger.log('Error _handleGuardarProveedor: ' + err.message);
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ── GET: activar / desactivar proveedor ─────────────────────
function _handleToggleProveedor(params, callback) {
  var result = { success: false, error: null };
  try {
    var id     = String(params.id     || '').trim();
    var activo = params.activo !== 'false';
    if (!id) throw new Error('id requerido');

    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_PROVEEDORES);
    if (!sheet) throw new Error('Hoja Proveedores_Config no encontrada');

    var lastRow = sheet.getLastRow();
    if (lastRow <= 2) throw new Error('Sin proveedores registrados');

    var data  = sheet.getRange(3, COL_P.ID, lastRow - 2, 1).getValues();
    var found = false;
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][0]) === id) {
        sheet.getRange(i + 3, COL_P.ACTIVO).setValue(activo);
        _proveedoresCache = null;
        found = true;
        Logger.log('✅ Proveedor ' + id + ' → activo: ' + activo);
        break;
      }
    }
    if (!found) throw new Error('Proveedor no encontrado: ' + id);
    result.success = true;
  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleToggleProveedor: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════
//  MIGRACIÓN DE LA QUERY GMAIL
//
//  En ContaFacil_Operaciones.gs, la función sincronizarEmails()
//  tiene hardcodeado:
//    var query = 'to:' + EMAIL_COMPROBANTES + ' has:attachment -label:procesado_cf';
//
//  Reemplazar con esta versión dinámica que añade filtros from:
//  para todos los proveedores registrados.
// ═══════════════════════════════════════════════════════════════

function _buildGmailQuery() {
  var baseQuery = 'to:' + EMAIL_COMPROBANTES + ' has:attachment -label:procesado_cf';
  var proveedores = _getProveedoresActivos();

  // Recopilar emails de origen de todos los proveedores
  var fromFilters = [];
  for (var i = 0; i < proveedores.length; i++) {
    var em = proveedores[i].email_origen;
    if (em && em.indexOf('@') !== -1) {
      fromFilters.push('from:' + em);
    }
  }

  // Si hay filtros de email, construir query alternativa:
  // (to:comprobantes from:carbone) OR (to:comprobantes from:otroProv)
  // Si no hay emails configurados, usar la query base
  if (!fromFilters.length) return baseQuery;

  var orParts = fromFilters.map(function(f) {
    return '(' + baseQuery + ' ' + f + ')';
  });
  // También mantener la query base para que lleguen otros adjuntos al buzón
  return '(' + baseQuery + ')';
  // Nota: La detección real del proveedor se hace por RUC/keywords
  // en _detectarTipoFacturaDinamico, no por la query de Gmail.
  // La query amplia es intencional para no perder documentos.
}
