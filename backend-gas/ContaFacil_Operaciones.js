// ═══════════════════════════════════════════════════════════════
//  ContaFacil_Operaciones_CEYCO.gs BalanceClip.net
//  Módulo: Compras & Ventas — Configurable multi-cliente
//  v2.1 — FIX: sincronizarEmails() no consume threads desconocidos
//         FIX: email_acr_destino / email_acr_remitente en guardarConfig
// ═══════════════════════════════════════════════════════════════

var CONFIG_OP = {
  SHEET_ID: '1UCV17jyqvwbiR6YyuUkvhhjPJrR_9Bh7w9XgSGRZkNk',
};

var SHEET_CV_OP          = 'Compras_Ventas';
var SHEET_CONFIG_OP      = 'Config_Operaciones';
var SHEET_PROVEEDORES_OP = 'Proveedores_Config';

var COL_PROV_OP = {
  ID:              1,
  NOMBRE:          2,
  RUC:             3,
  DV:              4,
  EMAIL_ORIGEN:    5,
  KEYWORDS:        6,
  PROMPT_OVERRIDE: 7,
  ACTIVO:          8,
  FECHA_ALTA:      9,
  DRIVE_EJEMPLO:  10,
  NOTAS:          11,
  APLICA_A:       12,
};
var PROV_NCOLS_OP = 12;

var COL_CV_OP = {
  ID_ITEM:          1,
  FECHA_REG:        2,
  ESTADO:           3,
  FUENTE:           4,
  CONFIANZA_MATCH:  5,
  FLAG_REVISION:    6,
  FECHA_COMPRA:     7,
  NUM_FAC_PROVEEDOR:8,
  CODIGO_PROD:      9,
  DESCRIPCION_PROD: 10,
  PRECIO_UNIT_PROV: 11,
  ITBMS_PROV:       12,
  TOTAL_PROV:       13,
  FECHA_VENTA:      14,
  NUM_FAC_EMITIDA:  15,
  NOMBRE_CLIENTE:   16,
  RUC_CLIENTE:      17,
  DV_CLIENTE:       18,
  PRECIO_VENTA:     19,
  ITBMS_VENTA:      20,
  TOTAL_VENTA:      21,
  MARGEN:           22,
  ID_ORDEN_WEB:     23,
  DRIVE_URL_PROV:   24,
  DRIVE_URL_EMIT:   25,
  NOTAS:            26,
  INGRESO_ID:       27,
  CANTIDAD:         28,
};
var CV_NCOLS_OP = 28;

var SHEET_INGRESOS = 'Ingresos';
var SHEET_EGRESOS  = 'Egresos';
var _cfgCacheOp    = null;

// ═══════════════════════════════════════════════════════════════
//  _getConfig()
// ═══════════════════════════════════════════════════════════════

function _getConfig() {
  if (_cfgCacheOp) return _cfgCacheOp;

  var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_CONFIG_OP);

  var defaults = {
    empresa_nombre:       'Mi Empresa S.A.',
    empresa_comercial:    '',
    empresa_ruc:          '',
    empresa_dv:           '',
    email_comprobantes:   '',
    email_op_destino:     '',
    email_op_remitente:   '',
    email_acr_destino:    '',   // email destino dedicado para Registro General
    email_acr_remitente:  '',   // remitente dedicado para Registro General
    drive_folder_id:      '',
    confianza_minima:     '70',
    itbms_rate:           '0.07',
    prefijo_id:           'RP',
    modulo_activo:        'true',
    email_st_entrante:    'lasnubesenchica+ceyco@gmail.com',
    email_st_destino:     '',
    email_st_remitente:   '',
  };

  if (!sheet) {
    Logger.log('⚠️  Config_Operaciones no encontrada — usando defaults.');
    _cfgCacheOp = defaults;
    return _cfgCacheOp;
  }

  var data = sheet.getDataRange().getValues();
  var cfg  = Object.assign({}, defaults);
  for (var i = 1; i < data.length; i++) {
    var clave = String(data[i][0] || '').trim();
    var valor = String(data[i][1] || '').trim();
    if (clave) cfg[clave] = valor;
  }
  _cfgCacheOp = cfg;
  return _cfgCacheOp;
}

// ═══════════════════════════════════════════════════════════════
//  _getProveedorBase()
// ═══════════════════════════════════════════════════════════════

function _getProveedorBase() {
  var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_PROVEEDORES_OP);
  if (!sheet || sheet.getLastRow() <= 2) return null;
  var data = sheet.getRange(3, 1, sheet.getLastRow() - 2, PROV_NCOLS_OP).getValues();
  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    if (!r[COL_PROV_OP.ID - 1]) continue;
    if (String(r[COL_PROV_OP.ACTIVO - 1]).toLowerCase() !== 'true') continue;
    return {
      id:              r[COL_PROV_OP.ID - 1],
      nombre:          r[COL_PROV_OP.NOMBRE - 1]          || '',
      ruc:             r[COL_PROV_OP.RUC - 1]              || '',
      dv:              r[COL_PROV_OP.DV - 1]               || '',
      email_origen:    r[COL_PROV_OP.EMAIL_ORIGEN - 1]     || '',
      keywords:        String(r[COL_PROV_OP.KEYWORDS - 1] || '').replace(/\|/g, ','),
      prompt_override: r[COL_PROV_OP.PROMPT_OVERRIDE - 1]  || '',
      aplica_a:        r[COL_PROV_OP.APLICA_A - 1]         || 'retail',
    };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
//  _getTodosProveedores()
// ═══════════════════════════════════════════════════════════════

function _getTodosProveedores() {
  var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_PROVEEDORES_OP);
  if (!sheet || sheet.getLastRow() <= 2) return [];
  var data  = sheet.getRange(3, 1, sheet.getLastRow() - 2, PROV_NCOLS_OP).getValues();
  var items = [];
  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    if (!r[COL_PROV_OP.ID - 1]) continue;
    items.push({
      id:              r[COL_PROV_OP.ID - 1],
      nombre:          r[COL_PROV_OP.NOMBRE - 1]          || '',
      ruc:             r[COL_PROV_OP.RUC - 1]              || '',
      dv:              r[COL_PROV_OP.DV - 1]               || '',
      email_origen:    r[COL_PROV_OP.EMAIL_ORIGEN - 1]     || '',
      keywords:        String(r[COL_PROV_OP.KEYWORDS - 1] || '').replace(/\|/g, ','),
      activo:          String(r[COL_PROV_OP.ACTIVO - 1]).toLowerCase() === 'true',
      aplica_a:        r[COL_PROV_OP.APLICA_A - 1]         || 'retail',
      prompt_override: r[COL_PROV_OP.PROMPT_OVERRIDE - 1]  || '',
      drive_ejemplo:   r[COL_PROV_OP.DRIVE_EJEMPLO - 1]    || '',
      fecha_alta:      r[COL_PROV_OP.FECHA_ALTA - 1]       || '',
    });
  }
  return items;
}

// ═══════════════════════════════════════════════════════════════
//  _matchearProveedor()
// ═══════════════════════════════════════════════════════════════

function _matchearProveedor(fileName, fromEmail) {
  var proveedores = _getTodosProveedores();
  var fnLower     = (fileName  || '').toLowerCase();
  var fromLower   = (fromEmail || '').toLowerCase();
  for (var i = 0; i < proveedores.length; i++) {
    var pv = proveedores[i];
    if (!pv.activo) continue;
    if (pv.email_origen) {
      var emailOrigen = pv.email_origen.toLowerCase().trim();
      if (emailOrigen && fromLower.indexOf(emailOrigen) !== -1) {
        Logger.log('  🔍 Proveedor por email: ' + pv.nombre);
        return pv;
      }
    }
    var keywords = (pv.keywords || '').toLowerCase().split(/[,|]/);
    for (var k = 0; k < keywords.length; k++) {
      var kw = keywords[k].trim();
      if (kw && fnLower.indexOf(kw) !== -1) {
        Logger.log('  🔍 Proveedor por keyword "' + kw + '": ' + pv.nombre);
        return pv;
      }
    }
    var rucNorm = (pv.ruc || '').replace(/[-\.]/g, '').toLowerCase();
    if (rucNorm && fnLower.indexOf(rucNorm) !== -1) {
      Logger.log('  🔍 Proveedor por RUC: ' + pv.nombre);
      return pv;
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
//  DISPATCH
// ═══════════════════════════════════════════════════════════════

function doGet_Operaciones(action, params, callback) {
  if (action === 'getComprasVentas')      return _handleGetComprasVentas(params, callback);
  if (action === 'sincronizarEmails')     return _handleSincronizar(params, callback);
  if (action === 'aprobarMatch')          return _handleAprobarMatch(params, callback);
  if (action === 'buscarOrdenWeb')        return _handleBuscarOrdenWeb(params, callback);
  if (action === 'vincularOrdenWeb')      return _handleVincularOrdenWeb(params, callback);
  if (action === 'registrarVentaDirecta') return _handleRegistrarVentaDirecta(params, callback);
  if (action === 'marcarCostoOperativo')  return _handleMarcarCostoOperativo(params, callback);
  if (action === 'getProveedores')        return _handleGetProveedores(params, callback);
  if (action === 'toggleProveedor')       return _handleToggleProveedor(params, callback);
  if (action === 'getConfig')             return _handleGetConfigPublic(params, callback);
  if (action === 'healthCheck')           return _handleGetConfigPublic(params, callback);
  if (action === 'estadoTriggerST')       return _handleEstadoTriggerST(params, callback);
  if (action === 'getEmailSTLog')         return _handleGetEmailSTLog(params, callback);
  if (action === 'estadoTriggerOp')       return _handleEstadoTriggerOp(params, callback);
  var resAcr = doGet_Acreedores(action, params, callback);
  if (resAcr !== null) return resAcr;
  return null;
}

function doPost_Operaciones(action, data) {
  if (action === 'analizarFacturaPendiente') return _handleAnalizarFacturaPendiente(data);
  if (action === 'registrarPagoOperacion')   return _handleRegistrarPagoOperacion(data);
  if (action === 'guardarProveedor')         return _handleGuardarProveedor(data);
  if (action === 'analizarFacturaEjemplo')   return _handleAnalizarFacturaEjemplo(data);
  if (action === 'guardarConfig')            return _handleGuardarConfig(data);
  if (action === 'instalarTriggerST')        return _handleInstalarTriggerST(data);
  if (action === 'removerTriggerST')         return _handleRemoverTriggerST(data);
  if (action === 'instalarTriggerOp')        return _handleInstalarTriggerOp(data);
  if (action === 'removerTriggerOp')         return _handleRemoverTriggerOp(data);
  var resAcrPost = doPost_Acreedores(action, data);
  if (resAcrPost !== null) return resAcrPost;
  return null;
}

// ═══════════════════════════════════════════════════════════════
//  HANDLER: getConfig (público)
// ═══════════════════════════════════════════════════════════════

function _handleGetConfigPublic(params, callback) {
  var cfg  = _getConfig();
  var prov = _getProveedorBase();
  return _jsonp({
    success:        true,
    config:         cfg,
    proveedor_base: prov,
    proveedores:    _getTodosProveedores(),
    empresa:        cfg.empresa_nombre || '',
  }, callback);
}

// ═══════════════════════════════════════════════════════════════
//  HANDLER: guardarConfig
//  FIX 3A: se agregan email_acr_destino y email_acr_remitente
// ═══════════════════════════════════════════════════════════════

function _handleGuardarConfig(data) {
  try {
    var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_CONFIG_OP) || _initConfigSheet(ss);

    var claves = [
      'empresa_nombre', 'empresa_comercial', 'empresa_ruc', 'empresa_dv',
      'email_comprobantes',
      'email_op_destino',
      'email_op_remitente',
      'email_acr_destino',    // ← NUEVO: email destino de Registro General / Acreedores
      'email_acr_remitente',  // ← NUEVO: remitente permitido de Registro General
      'drive_folder_id',
      'confianza_minima', 'itbms_rate', 'prefijo_id',
      'email_st_entrante',
      'email_st_destino',
      'email_st_remitente',
      'trigger_op_intervalo',
      'trigger_st_intervalo',
    ];

    var existing = sheet.getDataRange().getValues();
    var filaMap  = {};
    for (var i = 1; i < existing.length; i++) {
      var k = String(existing[i][0] || '').trim();
      if (k) filaMap[k] = i + 1;
    }

    for (var c = 0; c < claves.length; c++) {
      var clave = claves[c];
      if (typeof data[clave] === 'undefined') continue;
      var valor = String(data[clave] || '').trim();
      if (filaMap[clave]) {
        sheet.getRange(filaMap[clave], 2).setValue(valor);
      } else {
        var newRow = sheet.getLastRow() + 1;
        sheet.getRange(newRow, 1).setValue(clave);
        sheet.getRange(newRow, 2).setValue(valor);
      }
    }

    _cfgCacheOp = null;
    Logger.log('✅ Config guardada');
    return _json({ success: true });
  } catch (err) {
    Logger.log('Error guardarConfig: ' + err.message);
    return _json({ success: false, error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
//  HANDLER: getProveedores
// ═══════════════════════════════════════════════════════════════

function _handleGetProveedores(params, callback) {
  var result = { success: false, items: [], error: null };
  try {
    result.items   = _getTodosProveedores();
    result.success = true;
  } catch (err) {
    result.error = err.message;
  }
  return _jsonp(result, callback);
}

// ═══════════════════════════════════════════════════════════════
//  HANDLER: toggleProveedor
// ═══════════════════════════════════════════════════════════════

function _handleToggleProveedor(params, callback) {
  var result = { success: false, error: null };
  try {
    var id     = params.id     || '';
    var activo = params.activo === 'true';
    if (!id) throw new Error('id requerido');
    var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_PROVEEDORES_OP);
    if (!sheet) throw new Error('Hoja Proveedores_Config no encontrada');
    var lastRow = sheet.getLastRow();
    if (lastRow <= 2) throw new Error('Sin proveedores registrados');
    var data  = sheet.getRange(3, 1, lastRow - 2, PROV_NCOLS_OP).getValues();
    var found = false;
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][COL_PROV_OP.ID - 1]) === id) {
        sheet.getRange(i + 3, COL_PROV_OP.ACTIVO).setValue(activo);
        found = true;
        break;
      }
    }
    if (!found) throw new Error('Proveedor no encontrado: ' + id);
    result.success = true;
  } catch(err) {
    result.error = err.message;
  }
  return _jsonp(result, callback);
}

// ═══════════════════════════════════════════════════════════════
//  HANDLER: guardarProveedor
// ═══════════════════════════════════════════════════════════════

function _handleGuardarProveedor(data) {
  try {
    var nombre = String(data.nombre || '').trim();
    var ruc    = String(data.ruc    || '').trim();
    if (!nombre) throw new Error('nombre requerido');
    if (!ruc)    throw new Error('ruc requerido');

    var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_PROVEEDORES_OP);
    if (!sheet) throw new Error('Hoja Proveedores_Config no encontrada');
    var ahora = new Date();

    // Guardar PDF ejemplo en Drive si viene base64
    var driveEjemplo = '';
    if (data.pdfBase64 && data.pdfFileName) {
      var cfg = _getConfig();
      driveEjemplo = _guardarPdfEnDrive(
        Utilities.base64Decode(data.pdfBase64),
        'Ejemplo_' + nombre.replace(/\s/g,'_') + '_' + data.pdfFileName,
        cfg
      );
    }

    if (data.id) {
      // Actualizar existente
      var lastRow = sheet.getLastRow();
      if (lastRow <= 2) throw new Error('Sin proveedores registrados');
      var rows  = sheet.getRange(3, 1, lastRow - 2, PROV_NCOLS_OP).getValues();
      var found = false;
      for (var i = 0; i < rows.length; i++) {
        if (String(rows[i][COL_PROV_OP.ID - 1]) === data.id) {
          var rowNum = i + 3;
          sheet.getRange(rowNum, COL_PROV_OP.NOMBRE).setValue(nombre);
          sheet.getRange(rowNum, COL_PROV_OP.RUC).setValue(ruc);
          sheet.getRange(rowNum, COL_PROV_OP.DV).setValue(data.dv || '');
          sheet.getRange(rowNum, COL_PROV_OP.EMAIL_ORIGEN).setValue(data.email_origen || '');
          sheet.getRange(rowNum, COL_PROV_OP.KEYWORDS).setValue(String(data.keywords || '').replace(/,/g, '|'));
          sheet.getRange(rowNum, COL_PROV_OP.PROMPT_OVERRIDE).setValue(data.prompt_override || '');
          sheet.getRange(rowNum, COL_PROV_OP.APLICA_A).setValue(data.aplica_a || 'retail');
          if (driveEjemplo) sheet.getRange(rowNum, COL_PROV_OP.DRIVE_EJEMPLO).setValue(driveEjemplo);
          found = true;
          Logger.log('✅ Proveedor actualizado: ' + data.id);
          break;
        }
      }
      if (!found) throw new Error('Proveedor no encontrado: ' + data.id);
      return _json({ success: true, id: data.id });
    } else {
      // Nuevo proveedor
      var lastRow2 = sheet.getLastRow();
      var seq      = 1;
      if (lastRow2 > 2) {
        var ids = sheet.getRange(3, COL_PROV_OP.ID, lastRow2 - 2, 1).getValues();
        for (var j = ids.length - 1; j >= 0; j--) {
          var parts = String(ids[j][0] || '').split('-');
          var n     = parseInt(parts[parts.length - 1], 10);
          if (!isNaN(n)) { seq = n + 1; break; }
        }
      }
      var newId = 'PROV-' + String(seq).padStart(3, '0');
      var fila  = new Array(PROV_NCOLS_OP);
      for (var x = 0; x < PROV_NCOLS_OP; x++) fila[x] = '';
      fila[COL_PROV_OP.ID - 1]              = newId;
      fila[COL_PROV_OP.NOMBRE - 1]          = nombre;
      fila[COL_PROV_OP.RUC - 1]             = ruc;
      fila[COL_PROV_OP.DV - 1]              = data.dv              || '';
      fila[COL_PROV_OP.EMAIL_ORIGEN - 1]    = data.email_origen    || '';
      fila[COL_PROV_OP.KEYWORDS - 1]        = String(data.keywords || '').replace(/,/g, '|');
      fila[COL_PROV_OP.ACTIVO - 1]          = true;
      fila[COL_PROV_OP.PROMPT_OVERRIDE - 1] = data.prompt_override || '';
      fila[COL_PROV_OP.DRIVE_EJEMPLO - 1]   = driveEjemplo;
      fila[COL_PROV_OP.FECHA_ALTA - 1]      = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd');
      fila[COL_PROV_OP.APLICA_A - 1]        = data.aplica_a || 'retail';
      sheet.getRange(sheet.getLastRow() + 1, 1, 1, PROV_NCOLS_OP).setValues([fila]);
      Logger.log('✅ Proveedor creado: ' + newId + ' | ' + nombre);
      return _json({ success: true, id: newId });
    }
  } catch (err) {
    Logger.log('Error guardarProveedor: ' + err.message);
    return _json({ success: false, error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
//  HANDLER: analizarFacturaEjemplo
// ═══════════════════════════════════════════════════════════════

function _handleAnalizarFacturaEjemplo(data) {
  try {
    var b64      = data.imageBase64 || '';
    var mimeType = data.mimeType    || 'application/pdf';
    if (!b64) throw new Error('imageBase64 requerido');
    var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
    if (!apiKey) throw new Error('CLAUDE_API_KEY no configurada');
    var contentBlock = mimeType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
      : { type: 'image',    source: { type: 'base64', media_type: mimeType,           data: b64 } };
    var payload = {
      model:    'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: [
        contentBlock,
        { type: 'text', text:
          'Analiza esta factura panameña. Responde SOLO con JSON válido, sin markdown:\n' +
          '{"nombre_proveedor":"","ruc":"","dv":"","tiene_itbms":true,' +
          '"formato_num_fac":"","email_origen":"","keywords":"","notas_formato":""}\n' +
          'keywords = palabras clave que identifican a este proveedor en el nombre del archivo.\n' +
          'notas_formato = instrucción breve para Claude al parsear futuras facturas.\n' +
          'Si un campo no es visible usar null.'
        }
      ]}]
    };
    var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post', contentType: 'application/json',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify(payload), muteHttpExceptions: true,
    });
    if (resp.getResponseCode() !== 200) throw new Error('Claude API error ' + resp.getResponseCode());
    var text    = '';
    var content = JSON.parse(resp.getContentText()).content || [];
    for (var i = 0; i < content.length; i++) {
      if (content[i].type === 'text') { text = content[i].text; break; }
    }
    var parsed  = JSON.parse(text.replace(/```json|```/g, '').trim());
    parsed.success = true;
    return ContentService.createTextOutput(JSON.stringify(parsed)).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    Logger.log('Error analizarFacturaEjemplo: ' + err.message);
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ═══════════════════════════════════════════════════════════════
//  SINCRONIZAR EMAILS — v2.1
//  FIX 1: solo pone label procesado_cf_op si el thread tiene
//  adjuntos válidos de Comercialización. Si todo es desconocido,
//  NO consume el thread → Acreedores puede leerlo después.
// ═══════════════════════════════════════════════════════════════

function _handleSincronizar(params, callback) {
  var result = { success: false, procesados: 0, nuevos: 0, vinculados: 0, ignorados: 0, errores: [], error: null };
  try {
    var stats      = sincronizarEmails();
    result.success    = true;
    result.procesados = stats.procesados;
    result.nuevos     = stats.nuevos;
    result.vinculados = stats.vinculados;
    result.ignorados  = stats.ignorados;
    result.errores    = stats.errores;
  } catch (err) {
    result.error = err.message;
    Logger.log('Error sincronizar: ' + err.message);
  }
  return _jsonp(result, callback);
}

function ejecutarSincronizacionOp() {
  try {
    var stats = sincronizarEmails();
    Logger.log('⏱ Trigger Op: ' + JSON.stringify(stats));
  } catch(err) {
    Logger.log('❌ Trigger Op error: ' + err.message);
  }
}

function sincronizarEmails() {
  var cfg   = _getConfig();
  var stats = { procesados: 0, nuevos: 0, vinculados: 0, ignorados: 0, errores: [] };
  var pendientesEmitidas = [];

  // ── Construir query Gmail ────────────────────────────────────
  var query;
  if (cfg.email_op_destino && cfg.email_op_remitente) {
    query = 'to:' + cfg.email_op_destino + ' from:' + cfg.email_op_remitente +
            ' has:attachment -label:procesado_cf_op';
    Logger.log('📧 Query Retail: to:' + cfg.email_op_destino + ' from:' + cfg.email_op_remitente);
  } else if (cfg.email_op_destino) {
    query = 'to:' + cfg.email_op_destino + ' has:attachment -label:procesado_cf_op';
    Logger.log('📧 Query Retail (sin remitente): to:' + cfg.email_op_destino);
  } else if (cfg.email_comprobantes) {
    query = 'to:' + cfg.email_comprobantes + ' has:attachment -label:procesado_cf_op';
    Logger.log('📧 Query Retail (legado): to:' + cfg.email_comprobantes);
  } else {
    throw new Error('Email de entrada Retail no configurado. Ir a Configuración → Operaciones.');
  }

  var threads = GmailApp.search(query, 0, 50);
  var label   = _getOrCreateLabel('procesado_cf_op');
  Logger.log('📬 Threads encontrados para Comercialización: ' + threads.length);

  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      try {
        var attachments = msg.getAttachments();
        var from        = msg.getFrom() || '';
        var date        = msg.getDate();
        var pdfMap      = {};
        var xmlMap      = {};

        for (var a = 0; a < attachments.length; a++) {
          var att  = attachments[a];
          var ct   = att.getContentType() || '';
          var fn   = att.getName() || '';
          var fnL  = fn.toLowerCase();
          var esPdf = fnL.endsWith('.pdf') || ct === 'application/pdf';
          var esXml = fnL.endsWith('.xml') || ct === 'text/xml' || ct === 'application/xml';
          if (!esPdf && !esXml) continue;
          var base = fn.replace(/\.(pdf|xml)$/i, '');
          if (esXml) {
            try { xmlMap[base] = att.getDataAsString(); } catch(e) { Logger.log('Error leyendo XML: ' + fn); }
          }
          if (esPdf) {
            try {
              var bytes = att.getBytes();
              pdfMap[base] = { bytes: bytes, b64: Utilities.base64Encode(bytes), fn: fn };
            } catch(e) { Logger.log('Error leyendo PDF: ' + fn); }
          }
        }

        // ── Banderas por mensaje ─────────────────────────────
        // tieneValido:    al menos un adjunto fue de Comercialización (procesado o encolado)
        // tienePendiente: error de parse que requiere reintento
        var tieneValido    = false;
        var tienePendiente = false;
        var procesados     = {};

        // ── Ronda 1: XMLs + su PDF par ───────────────────────
        for (var base in xmlMap) {
          var xmlStr   = xmlMap[base];
          var pdfInfo  = pdfMap[base] || null;
          var pdfB64   = pdfInfo ? pdfInfo.b64   : null;
          var pdfBytes = pdfInfo ? pdfInfo.bytes  : null;
          var fileName = pdfInfo ? pdfInfo.fn     : (base + '.xml');
          var tipoFac  = _detectarTipoFactura(xmlStr, fileName, pdfB64);
          stats.procesados++;
          try {
            if (tipoFac === 'proveedor') {
              stats.nuevos += _procesarXmlProveedor(xmlStr, pdfBytes, fileName, date, from);
              tieneValido = true;
            } else if (tipoFac === 'emitida') {
              var b64u = pdfB64 || (pdfBytes ? Utilities.base64Encode(pdfBytes) : null);
              if (b64u) { pendientesEmitidas.push({ b64: b64u, bytes: pdfBytes, fn: fileName, date: date }); tieneValido = true; }
              else      { stats.errores.push('Emitida sin PDF: ' + fileName); tienePendiente = true; }
            } else {
              // DESCONOCIDO — no es proveedor de Comercialización
              // NO consumir el thread → Acreedores podrá leerlo
              stats.ignorados++;
              Logger.log('⏭ Comercialización ignora: ' + fileName + ' | from: ' + from);
            }
          } catch(e) {
            stats.errores.push('Error "' + fileName + '": ' + e.message);
            tienePendiente = true;
          }
          procesados[base] = true;
        }

        // ── Ronda 2: PDFs sin XML par ────────────────────────
        for (var base in pdfMap) {
          if (procesados[base]) continue;
          var pdfInfo = pdfMap[base];
          var tipoFac = _detectarTipoFactura(null, pdfInfo.fn, pdfInfo.b64);
          stats.procesados++;
          try {
            if (tipoFac === 'proveedor') {
              stats.nuevos += _procesarFacturaProveedor(pdfInfo.b64, pdfInfo.bytes, pdfInfo.fn, date, from);
              tieneValido = true;
            } else if (tipoFac === 'emitida') {
              pendientesEmitidas.push({ b64: pdfInfo.b64, bytes: pdfInfo.bytes, fn: pdfInfo.fn, date: date });
              tieneValido = true;
            } else {
              // DESCONOCIDO — no consumir el thread
              stats.ignorados++;
              Logger.log('⏭ Comercialización ignora PDF: ' + pdfInfo.fn + ' | from: ' + from);
            }
          } catch(e) {
            stats.errores.push('Error "' + pdfInfo.fn + '": ' + e.message);
            tienePendiente = true;
          }
          procesados[base] = true;
        }

        // ── Decisión de label ────────────────────────────────
        // SOLO poner label si el mensaje tenía adjuntos válidos de Comercialización.
        // Si todo fue ignorado → NO poner label → Acreedores puede leer el thread.
        if (tieneValido) {
          threads[t].addLabel(label);
          Logger.log(tienePendiente
            ? '⚠️  Label procesado_cf_op aplicado (con errores parciales).'
            : '✅ Label procesado_cf_op aplicado.');
        } else {
          Logger.log('⏭ Thread sin adjuntos de Comercialización — sin label (disponible para Acreedores).');
        }

      } catch(msgErr) {
        stats.errores.push('Error mensaje: ' + msgErr.message);
        Logger.log('❌ Error en mensaje: ' + msgErr.message);
      }
    }
  }

  // ── Ronda 3: facturas emitidas ───────────────────────────────
  Logger.log('Ronda emitidas: ' + pendientesEmitidas.length + '...');
  for (var ei = 0; ei < pendientesEmitidas.length; ei++) {
    var em = pendientesEmitidas[ei];
    try {
      stats.vinculados += _procesarFacturaEmitida(em.b64, em.bytes, em.fn, em.date);
    } catch(err) {
      stats.errores.push('Error emitida "' + em.fn + '": ' + err.message);
    }
  }

  Logger.log('✅ Comercialización: ' + JSON.stringify(stats));
  return stats;
}

// ═══════════════════════════════════════════════════════════════
//  DETECCIÓN DE TIPO DE FACTURA
// ═══════════════════════════════════════════════════════════════

function _detectarTipoFactura(xmlStr, fileName, pdfB64) {
  var cfg         = _getConfig();
  var proveedores = _getTodosProveedores();
  var rucEmpresa  = (cfg.empresa_ruc || '').replace(/[-\.]/g, '');
  var rucsProveedores = proveedores
    .filter(function(p) { return p.activo; })
    .map(function(p) { return (p.ruc || '').replace(/[-\.]/g, '').toLowerCase(); })
    .filter(function(r) { return !!r; });

  if (xmlStr) {
    var emisorBlock = xmlStr.match(/<gEmis>([\s\S]*?)<\/gEmis>/);
    if (emisorBlock) {
      var bloque = emisorBlock[1];
      if (rucEmpresa && bloque.indexOf(rucEmpresa) !== -1) return 'emitida';
      for (var ri = 0; ri < rucsProveedores.length; ri++) {
        if (rucsProveedores[ri] && bloque.indexOf(rucsProveedores[ri]) !== -1) return 'proveedor';
      }
    }
    if (rucEmpresa && xmlStr.indexOf(rucEmpresa) !== -1) return 'emitida';
    for (var rj = 0; rj < rucsProveedores.length; rj++) {
      if (rucsProveedores[rj] && xmlStr.indexOf(rucsProveedores[rj]) !== -1) return 'proveedor';
    }
    if (cfg.empresa_nombre && xmlStr.toUpperCase().indexOf(cfg.empresa_nombre.toUpperCase().split(' ')[0]) !== -1) return 'emitida';
    for (var pi2 = 0; pi2 < proveedores.length; pi2++) {
      var pn = (proveedores[pi2].nombre || '').toUpperCase().split(' ')[0];
      if (pn && xmlStr.toUpperCase().indexOf(pn) !== -1) return 'proveedor';
    }
  }

  var fn = (fileName || '').toLowerCase();
  if (rucEmpresa && fn.indexOf(rucEmpresa.toLowerCase()) !== -1) return 'emitida';
  for (var pa = 0; pa < proveedores.length; pa++) {
    var pv = proveedores[pa];
    if (!pv.activo) continue;
    var rucPv = (pv.ruc || '').replace(/[-\.]/g, '').toLowerCase();
    if (rucPv && fn.indexOf(rucPv) !== -1) return 'proveedor';
    var keywords = (pv.keywords || '').toLowerCase().split(/[,|]/);
    for (var k = 0; k < keywords.length; k++) {
      var kw = keywords[k].trim();
      if (kw && fn.indexOf(kw) !== -1) return 'proveedor';
    }
  }

  // Fallback: Claude Haiku
  if (pdfB64) {
    var provBase    = _getProveedorBase();
    var empresaNombre = cfg.empresa_nombre || 'la empresa';
    var empresaRuc    = cfg.empresa_ruc    || '';
    var provNombre    = provBase ? provBase.nombre : 'el proveedor principal';
    var provRuc       = provBase ? (provBase.ruc || '') : '';
    var pregunta =
      '¿Esta factura panameña fue emitida POR ' + provNombre +
      (provRuc ? ' (RUC ' + provRuc + ')' : '') +
      ' o POR ' + empresaNombre +
      (empresaRuc ? ' (RUC ' + empresaRuc + ')' : '') + '?\n' +
      'Responde SOLO: "proveedor" si el emisor es ' + provNombre.split(' ')[0] +
      ', "emitida" si el emisor es ' + empresaNombre.split(' ')[0] +
      ', o "desconocido".';
    var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
    if (apiKey) {
      try {
        var payload = {
          model: 'claude-haiku-4-5-20251001', max_tokens: 15,
          messages: [{ role: 'user', content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfB64 } },
            { type: 'text', text: pregunta }
          ]}]
        };
        var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
          method: 'post', contentType: 'application/json',
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          payload: JSON.stringify(payload), muteHttpExceptions: true,
        });
        var text = '';
        var content = JSON.parse(resp.getContentText()).content || [];
        for (var ci = 0; ci < content.length; ci++) {
          if (content[ci].type === 'text') { text = content[ci].text.trim().toLowerCase(); break; }
        }
        if (text === 'proveedor' || text === 'emitida') return text;
      } catch(e) { Logger.log('Error Haiku clasificar: ' + e.message); }
    }
  }

  return 'desconocido';
}

// ═══════════════════════════════════════════════════════════════
//  PROCESAR XML PROVEEDOR
// ═══════════════════════════════════════════════════════════════

function _procesarXmlProveedor(xmlStr, pdfBytes, fileName, fechaEmail, fromEmail) {
  var numFactura   = _xmlVal(xmlStr, 'dNroDF');
  var fechaEmision = (_xmlVal(xmlStr, 'dFechaEm') || '').substring(0, 10);
  if (!numFactura) { Logger.log('XML sin número de factura'); return 0; }
  if (_facturaYaExiste(numFactura, 'proveedor')) { Logger.log('Factura ya procesada: ' + numFactura); return 0; }

  var cfg      = _getConfig();
  var provBase = _matchearProveedor(fileName, fromEmail);
  var driveUrl = pdfBytes ? _guardarPdfEnDrive(pdfBytes, 'Proveedor_' + numFactura + '.pdf', cfg) : '';
  var items    = _xmlItems(xmlStr);
  if (!items.length) { Logger.log('XML sin ítems: ' + numFactura); return 0; }

  var ss         = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
  var sheet      = ss.getSheetByName(SHEET_CV_OP);
  if (!sheet) throw new Error('Hoja Compras_Ventas no encontrada. Ejecutar initComprasVentasSheet().');
  var ahora      = new Date();
  var fechaReg   = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
  var totalFac   = items.reduce(function(s, i) { return s + (parseFloat(i.total_item||0)||0); }, 0);

  for (var j = 0; j < items.length; j++) {
    var item = items[j];
    var id   = _nuevoIdCV(ahora, j + 1, cfg);
    var fila = _filaVacia(CV_NCOLS_OP);
    fila[COL_CV_OP.ID_ITEM - 1]           = id;
    fila[COL_CV_OP.FECHA_REG - 1]         = fechaReg;
    fila[COL_CV_OP.ESTADO - 1]            = 'pendiente';
    fila[COL_CV_OP.FUENTE - 1]            = 'email_proveedor';
    fila[COL_CV_OP.FLAG_REVISION - 1]     = false;
    fila[COL_CV_OP.FECHA_COMPRA - 1]      = fechaEmision;
    fila[COL_CV_OP.NUM_FAC_PROVEEDOR - 1] = numFactura;
    fila[COL_CV_OP.CODIGO_PROD - 1]       = item.codigo       || '';
    fila[COL_CV_OP.DESCRIPCION_PROD - 1]  = item.descripcion  || '';
    fila[COL_CV_OP.PRECIO_UNIT_PROV - 1]  = parseFloat(item.precio_unitario||0) || '';
    fila[COL_CV_OP.ITBMS_PROV - 1]        = parseFloat(item.itbms||0) || '';
    fila[COL_CV_OP.TOTAL_PROV - 1]        = parseFloat(item.total_item||0) || '';
    fila[COL_CV_OP.DRIVE_URL_PROV - 1]    = driveUrl;
    fila[COL_CV_OP.CANTIDAD - 1]          = 1;
    fila[COL_CV_OP.NOTAS - 1]             = 'Total: $' + totalFac.toFixed(2) + ' | ' + (provBase ? provBase.nombre : '') + ' | XML';
    var lastRow = sheet.getLastRow() + 1;
    sheet.getRange(lastRow, 1, 1, CV_NCOLS_OP).setValues([fila]);
    sheet.getRange(lastRow, COL_CV_OP.PRECIO_UNIT_PROV, 1, 3).setNumberFormat('#,##0.00');
    sheet.getRange(lastRow, 1, 1, CV_NCOLS_OP).setBackground('#FFF3E0');
  }
  Logger.log('✅ XML proveedor ' + numFactura + ': ' + items.length + ' ítems');
  return items.length;
}

// ═══════════════════════════════════════════════════════════════
//  PROCESAR PDF PROVEEDOR (sin XML)
// ═══════════════════════════════════════════════════════════════

function _procesarFacturaProveedor(pdfB64, pdfBytes, fileName, fechaEmail, fromEmail) {
  var cfg      = _getConfig();
  var provBase = _matchearProveedor(fileName, fromEmail);
  var parsed   = _claudeParsePdfFactura(pdfB64, 'application/pdf', 'proveedor', cfg, provBase);
  if (!parsed || !parsed.items || !parsed.items.length) { Logger.log('Claude no extrajo ítems de PDF proveedor'); return 0; }
  if (_facturaYaExiste(parsed.num_factura, 'proveedor')) { Logger.log('Factura proveedor ya procesada: ' + parsed.num_factura); return 0; }

  var driveUrl = _guardarPdfEnDrive(pdfBytes, 'Proveedor_' + parsed.num_factura + '_' + fileName, cfg);
  var ss       = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
  var sheet    = ss.getSheetByName(SHEET_CV_OP);
  if (!sheet) throw new Error('Hoja Compras_Ventas no encontrada.');
  var ahora      = new Date();
  var fechaReg   = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
  var totalFac   = parsed.items.reduce(function(s, i) { return s + (parseFloat(i.total_item||0)||0); }, 0);

  for (var j = 0; j < parsed.items.length; j++) {
    var item = parsed.items[j];
    var id   = _nuevoIdCV(ahora, j + 1, cfg);
    var fila = _filaVacia(CV_NCOLS_OP);
    fila[COL_CV_OP.ID_ITEM - 1]           = id;
    fila[COL_CV_OP.FECHA_REG - 1]         = fechaReg;
    fila[COL_CV_OP.ESTADO - 1]            = 'pendiente';
    fila[COL_CV_OP.FUENTE - 1]            = 'email_proveedor';
    fila[COL_CV_OP.FLAG_REVISION - 1]     = false;
    fila[COL_CV_OP.FECHA_COMPRA - 1]      = parsed.fecha_emision || '';
    fila[COL_CV_OP.NUM_FAC_PROVEEDOR - 1] = parsed.num_factura   || '';
    fila[COL_CV_OP.CODIGO_PROD - 1]       = item.codigo          || '';
    fila[COL_CV_OP.DESCRIPCION_PROD - 1]  = item.descripcion     || '';
    fila[COL_CV_OP.PRECIO_UNIT_PROV - 1]  = parseFloat(item.precio_unitario||0) || '';
    fila[COL_CV_OP.ITBMS_PROV - 1]        = parseFloat(item.itbms||0) || '';
    fila[COL_CV_OP.TOTAL_PROV - 1]        = parseFloat(item.total_item||0) || '';
    fila[COL_CV_OP.DRIVE_URL_PROV - 1]    = driveUrl;
    fila[COL_CV_OP.CANTIDAD - 1]          = 1;
    fila[COL_CV_OP.NOTAS - 1]             = 'Total: $' + totalFac.toFixed(2) + ' | PDF';
    var lastRow = sheet.getLastRow() + 1;
    sheet.getRange(lastRow, 1, 1, CV_NCOLS_OP).setValues([fila]);
    sheet.getRange(lastRow, COL_CV_OP.PRECIO_UNIT_PROV, 1, 3).setNumberFormat('#,##0.00');
    sheet.getRange(lastRow, 1, 1, CV_NCOLS_OP).setBackground('#FFF3E0');
  }
  Logger.log('✅ PDF proveedor ' + parsed.num_factura + ': ' + parsed.items.length + ' ítems');
  return parsed.items.length;
}

// ═══════════════════════════════════════════════════════════════
//  PROCESAR FACTURA EMITIDA
// ═══════════════════════════════════════════════════════════════

function _procesarFacturaEmitida(pdfB64, pdfBytes, fileName, fechaEmail) {
  var cfg    = _getConfig();
  var parsed = _claudeParsePdfFactura(pdfB64, 'application/pdf', 'emitida', cfg, null);
  if (!parsed) { Logger.log('Claude no extrajo factura emitida'); return 0; }
  var driveUrl   = _guardarPdfEnDrive(pdfBytes, 'Emitida_' + (parsed.num_factura||'SN') + '_' + fileName, cfg);
  return _matchFacturaEmitidaConItems(parsed, driveUrl);
}

function _matchFacturaEmitidaConItems(parsedEmitida, driveUrlEmitida) {
  var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_CV_OP);
  if (!sheet) return 0;
  var data       = sheet.getDataRange().getValues();
  var pendientes = [];
  for (var i = 2; i < data.length; i++) {
    var estado = String(data[i][COL_CV_OP.ESTADO - 1] || '').trim();
    var fac    = String(data[i][COL_CV_OP.NUM_FAC_EMITIDA - 1] || '').trim();
    if (estado === 'pendiente' && !fac) pendientes.push({ row: i + 1, data: data[i] });
  }
  if (!pendientes.length) return 0;

  // Vincular al primer pendiente sin factura emitida
  var target = pendientes[0];
  var rowNum = target.row;
  var idItem  = String(target.data[COL_CV_OP.ID_ITEM - 1] || '');
  var venta   = parseFloat(parsedEmitida.total || '0') || 0;
  var costo   = parseFloat(target.data[COL_CV_OP.TOTAL_PROV - 1] || '0') || 0;
  sheet.getRange(rowNum, COL_CV_OP.FECHA_VENTA).setValue(parsedEmitida.fecha_emision  || '');
  sheet.getRange(rowNum, COL_CV_OP.NUM_FAC_EMITIDA).setValue(parsedEmitida.num_factura || '');
  sheet.getRange(rowNum, COL_CV_OP.NOMBRE_CLIENTE).setValue(parsedEmitida.nombre_cliente || '');
  sheet.getRange(rowNum, COL_CV_OP.RUC_CLIENTE).setValue(parsedEmitida.ruc_cliente    || '');
  sheet.getRange(rowNum, COL_CV_OP.DV_CLIENTE).setValue(parsedEmitida.dv_cliente      || '');
  sheet.getRange(rowNum, COL_CV_OP.TOTAL_VENTA).setValue(venta || '');
  sheet.getRange(rowNum, COL_CV_OP.ITBMS_VENTA).setValue(parsedEmitida.itbms_total    || '');
  sheet.getRange(rowNum, COL_CV_OP.PRECIO_VENTA).setValue(parsedEmitida.subtotal       || '');
  sheet.getRange(rowNum, COL_CV_OP.DRIVE_URL_EMIT).setValue(driveUrlEmitida);
  sheet.getRange(rowNum, COL_CV_OP.ESTADO).setValue('facturado');
  sheet.getRange(rowNum, COL_CV_OP.CONFIANZA_MATCH).setValue(100);
  sheet.getRange(rowNum, COL_CV_OP.FLAG_REVISION).setValue(false);
  sheet.getRange(rowNum, COL_CV_OP.MARGEN).setValue(venta - costo);
  sheet.getRange(rowNum, 1, 1, CV_NCOLS_OP).setBackground('#E3F2FD');
  Logger.log('✅ Emitida vinculada a item: ' + idItem);
  return 1;
}

// ═══════════════════════════════════════════════════════════════
//  CLAUDE — PARSEAR PDF
// ═══════════════════════════════════════════════════════════════

function _claudeParsePdfFactura(pdfB64, mimeType, tipo, cfg, provBase) {
  var apiKey        = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY no configurada');
  var empresaNombre = (cfg && cfg.empresa_nombre) ? cfg.empresa_nombre : 'la empresa';
  var empresaRuc    = (cfg && cfg.empresa_ruc)    ? cfg.empresa_ruc    : '';
  var provNombre    = provBase ? provBase.nombre : 'el proveedor';
  var provRuc       = provBase ? provBase.ruc    : '';
  var provOverride  = provBase ? (provBase.prompt_override || '') : '';

  var promptProveedor =
    'Eres un extractor de datos de facturas de ' + provNombre +
    (provRuc ? ' (RUC ' + provRuc + ')' : '') + ' en Panamá. ' +
    (provOverride ? provOverride + ' ' : '') +
    'Analiza este PDF y responde SOLO con JSON válido, sin markdown:\n' +
    '{"num_factura":"","fecha_emision":"YYYY-MM-DD","ruc_emisor":"","nombre_receptor":"",' +
    '"subtotal":0,"itbms_total":0,"total":0,' +
    '"items":[{"num_item":1,"codigo":"","descripcion":"","cantidad":1,' +
    '"precio_unitario":0,"descuento":0,"itbms":0,"total_item":0}]}\n' +
    'NO extraigas RUC ni DV del receptor. Si un campo no está visible usa null. Montos como números.';

  var promptEmitida =
    'Eres un extractor de facturas emitidas por ' + empresaNombre +
    (empresaRuc ? ' (RUC ' + empresaRuc + ')' : '') + ' en Panamá.\n' +
    'Responde SOLO con JSON válido, sin markdown:\n' +
    '{"num_factura":"","fecha_emision":"YYYY-MM-DD","nombre_cliente":"","ruc_cliente":"",' +
    '"dv_cliente":"","subtotal":0,"itbms_total":0,"total":0}\n' +
    'Si un campo no está visible usa null. Montos como números.';

  var prompt = tipo === 'emitida' ? promptEmitida : promptProveedor;
  var payload = {
    model:      'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages:   [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfB64 } },
      { type: 'text', text: prompt }
    ]}]
  };
  var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload), muteHttpExceptions: true,
  });
  if (resp.getResponseCode() !== 200) throw new Error('Claude API error ' + resp.getResponseCode() + ': ' + resp.getContentText().substring(0,200));
  var text    = '';
  var content = JSON.parse(resp.getContentText()).content || [];
  for (var i = 0; i < content.length; i++) {
    if (content[i].type === 'text') { text = content[i].text; break; }
  }
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

// ═══════════════════════════════════════════════════════════════
//  HANDLERS varios (analizarFacturaPendiente, registrarPago, etc.)
// ═══════════════════════════════════════════════════════════════

function _handleAnalizarFacturaPendiente(data) {
  var result = { success: false, data: null, error: null };
  try {
    var pdfB64  = data.pdfBase64 || '';
    var idItem  = data.id_item   || '';
    var tipoFac = data.tipo      || 'emitida';
    if (!pdfB64) throw new Error('pdfBase64 requerido');
    var cfg      = _getConfig();
    var provBase = _getProveedorBase();
    var parsed   = _claudeParsePdfFactura(pdfB64, 'application/pdf', tipoFac, cfg, provBase);
    if (!parsed) throw new Error('Claude no pudo extraer datos del PDF');
    if (idItem && tipoFac === 'emitida') _vincularFacturaEmitidaAItem(idItem, parsed, pdfB64, cfg);
    result.success = true;
    result.data    = parsed;
  } catch(err) { result.error = err.message; }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function _vincularFacturaEmitidaAItem(idItem, parsedEmitida, pdfB64, cfg) {
  var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_CV_OP);
  var data  = sheet.getDataRange().getValues();
  for (var i = 2; i < data.length; i++) {
    if (String(data[i][COL_CV_OP.ID_ITEM - 1]) !== String(idItem)) continue;
    var rowNum   = i + 1;
    var pdfBytes = Utilities.base64Decode(pdfB64);
    var driveUrl = _guardarPdfEnDrive(pdfBytes, 'Emitida_Manual_' + (parsedEmitida.num_factura||idItem) + '.pdf', cfg);
    var venta    = parseFloat(parsedEmitida.total || '0') || 0;
    var costo    = parseFloat(data[i][COL_CV_OP.TOTAL_PROV - 1] || '0') || 0;
    sheet.getRange(rowNum, COL_CV_OP.FECHA_VENTA).setValue(parsedEmitida.fecha_emision   || '');
    sheet.getRange(rowNum, COL_CV_OP.NUM_FAC_EMITIDA).setValue(parsedEmitida.num_factura || '');
    sheet.getRange(rowNum, COL_CV_OP.NOMBRE_CLIENTE).setValue(parsedEmitida.nombre_cliente || '');
    sheet.getRange(rowNum, COL_CV_OP.RUC_CLIENTE).setValue(parsedEmitida.ruc_cliente      || '');
    sheet.getRange(rowNum, COL_CV_OP.DV_CLIENTE).setValue(parsedEmitida.dv_cliente        || '');
    sheet.getRange(rowNum, COL_CV_OP.TOTAL_VENTA).setValue(venta || '');
    sheet.getRange(rowNum, COL_CV_OP.ITBMS_VENTA).setValue(parsedEmitida.itbms_total      || '');
    sheet.getRange(rowNum, COL_CV_OP.PRECIO_VENTA).setValue(parsedEmitida.subtotal         || '');
    sheet.getRange(rowNum, COL_CV_OP.DRIVE_URL_EMIT).setValue(driveUrl);
    sheet.getRange(rowNum, COL_CV_OP.ESTADO).setValue('facturado');
    sheet.getRange(rowNum, COL_CV_OP.CONFIANZA_MATCH).setValue(100);
    sheet.getRange(rowNum, COL_CV_OP.FLAG_REVISION).setValue(false);
    sheet.getRange(rowNum, COL_CV_OP.MARGEN).setValue(venta - costo);
    sheet.getRange(rowNum, 1, 1, CV_NCOLS_OP).setBackground('#E3F2FD');
    return;
  }
  throw new Error('Item no encontrado: ' + idItem);
}

function _handleRegistrarPagoOperacion(data) {
  var result = { success: false, error: null };
  try {
    var idItem   = data.id_item   || '';
    var voucher  = data.voucher   || '';
    var fechaPag = data.fecha_pago || Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd');
    if (!idItem) throw new Error('id_item requerido');
    var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_CV_OP);
    if (!sheet) throw new Error('Hoja CV no encontrada');
    var rows  = sheet.getDataRange().getValues();
    var found = false;
    for (var i = 2; i < rows.length; i++) {
      if (String(rows[i][COL_CV_OP.ID_ITEM - 1]) !== String(idItem)) continue;
      var rowNum = i + 1;
      sheet.getRange(rowNum, COL_CV_OP.ESTADO).setValue('cerrado');
      if (voucher) sheet.getRange(rowNum, COL_CV_OP.NOTAS).setValue((rows[i][COL_CV_OP.NOTAS - 1] || '') + ' | Pago: ' + voucher + ' ' + fechaPag);
      sheet.getRange(rowNum, 1, 1, CV_NCOLS_OP).setBackground('#E8F5E9');
      found = true;
      break;
    }
    if (!found) throw new Error('Item no encontrado: ' + idItem);
    result.success = true;
  } catch(err) { result.error = err.message; }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function _handleGetComprasVentas(params, callback) {
  var result = { success: false, items: [], error: null };
  try {
    var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_CV_OP);
    if (!sheet || sheet.getLastRow() <= 2) { result.success = true; return _jsonp(result, callback); }
    var numRows = sheet.getLastRow() - 2;
    var data    = sheet.getRange(3, 1, numRows, CV_NCOLS_OP).getValues();
    var items   = [];
    for (var i = 0; i < data.length; i++) {
      var r = data[i];
      if (!r[COL_CV_OP.ID_ITEM - 1]) continue;
      var fecha = r[COL_CV_OP.FECHA_REG - 1];
      if (fecha instanceof Date) fecha = Utilities.formatDate(fecha, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
      else fecha = String(fecha || '').slice(0, 19);
      items.push({
        id_item:           r[COL_CV_OP.ID_ITEM - 1],
        fecha_registro:    fecha,
        estado:            r[COL_CV_OP.ESTADO - 1]            || '',
        fuente:            r[COL_CV_OP.FUENTE - 1]            || '',
        confianza_match:   r[COL_CV_OP.CONFIANZA_MATCH - 1]   || '',
        flag_revision:     r[COL_CV_OP.FLAG_REVISION - 1]     || false,
        fecha_compra:      r[COL_CV_OP.FECHA_COMPRA - 1]      || '',
 
        // ── Campos proveedor — nombres genéricos (nuevos) ──
        num_fac_proveedor: r[COL_CV_OP.NUM_FAC_PROVEEDOR - 1] || '',
        precio_unit_prov:  r[COL_CV_OP.PRECIO_UNIT_PROV - 1]  || '',
        itbms_prov:        r[COL_CV_OP.ITBMS_PROV - 1]        || '',
        total_proveedor:   r[COL_CV_OP.TOTAL_PROV - 1]        || '',
        drive_url_proveedor: r[COL_CV_OP.DRIVE_URL_PROV - 1]  || '',
 
        // ── Aliases legacy — el frontend RP usa estos nombres ──
        num_fac_carbone:   r[COL_CV_OP.NUM_FAC_PROVEEDOR - 1] || '',
        precio_unit_carb:  r[COL_CV_OP.PRECIO_UNIT_PROV - 1]  || '',
        itbms_carbone:     r[COL_CV_OP.ITBMS_PROV - 1]        || '',
        total_carbone:     r[COL_CV_OP.TOTAL_PROV - 1]        || '',
        drive_url_carb:    r[COL_CV_OP.DRIVE_URL_PROV - 1]    || '',
 
        // ── Producto ──
        codigo_prod:       r[COL_CV_OP.CODIGO_PROD - 1]        || '',
        descripcion_prod:  r[COL_CV_OP.DESCRIPCION_PROD - 1]   || '',
 
        // ── Venta ──
        fecha_venta:       r[COL_CV_OP.FECHA_VENTA - 1]       || '',
        num_fac_emitida:   r[COL_CV_OP.NUM_FAC_EMITIDA - 1]   || '',
        nombre_cliente:    r[COL_CV_OP.NOMBRE_CLIENTE - 1]    || '',
        ruc_cliente:       r[COL_CV_OP.RUC_CLIENTE - 1]       || '',
        dv_cliente:        r[COL_CV_OP.DV_CLIENTE - 1]        || '',
        precio_venta:      r[COL_CV_OP.PRECIO_VENTA - 1]      || '',
        itbms_venta:       r[COL_CV_OP.ITBMS_VENTA - 1]       || '',
        total_venta:       r[COL_CV_OP.TOTAL_VENTA - 1]       || '',
        margen:            r[COL_CV_OP.MARGEN - 1]            || '',
 
        // ── Vínculos ──
        id_orden_web:      r[COL_CV_OP.ID_ORDEN_WEB - 1]      || '',
        drive_url_emit:    r[COL_CV_OP.DRIVE_URL_EMIT - 1]    || '',
        notas:             r[COL_CV_OP.NOTAS - 1]             || '',
        ingreso_id:        r[COL_CV_OP.INGRESO_ID - 1]        || '',
        cantidad:          r[COL_CV_OP.CANTIDAD - 1]          || '',
      });
    }
    result.success = true;
    result.items   = items;
  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleGetComprasVentas: ' + err.message);
  }
  return _jsonp(result, callback);
}

function _handleAprobarMatch(params, callback) {
  var result = { success: false, error: null };
  try {
    var idItem = params.id_item || '';
    if (!idItem) throw new Error('id_item requerido');
    var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_CV_OP);
    if (!sheet) throw new Error('Hoja CV no encontrada');
    var data  = sheet.getDataRange().getValues();
    for (var i = 2; i < data.length; i++) {
      if (String(data[i][COL_CV_OP.ID_ITEM - 1]) === String(idItem)) {
        sheet.getRange(i + 1, COL_CV_OP.FLAG_REVISION).setValue(false);
        sheet.getRange(i + 1, COL_CV_OP.CONFIANZA_MATCH).setValue(100);
        result.success = true;
        return _jsonp(result, callback);
      }
    }
    throw new Error('Item no encontrado: ' + idItem);
  } catch(err) { result.error = err.message; }
  return _jsonp(result, callback);
}

function _handleBuscarOrdenWeb(params, callback) {
  var result = { success: false, orden: null, error: null };
  try {
    var num   = params.num_orden || '';
    if (!num) throw new Error('num_orden requerido');
    var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_CV_OP);
    if (!sheet || sheet.getLastRow() <= 2) throw new Error('Sin datos CV');
    var data = sheet.getDataRange().getValues();
    for (var i = 2; i < data.length; i++) {
      if (String(data[i][COL_CV_OP.ID_ORDEN_WEB - 1]) === String(num)) {
        result.success = true;
        result.orden   = { id_item: data[i][COL_CV_OP.ID_ITEM - 1], estado: data[i][COL_CV_OP.ESTADO - 1] };
        return _jsonp(result, callback);
      }
    }
    throw new Error('Orden no encontrada: ' + num);
  } catch(err) { result.error = err.message; }
  return _jsonp(result, callback);
}

function _handleVincularOrdenWeb(params, callback) {
  var result = { success: false, error: null };
  try {
    var idItem   = params.id_item   || '';
    var ordenNum = params.num_orden || '';
    if (!idItem || !ordenNum) throw new Error('id_item y num_orden requeridos');
    var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_CV_OP);
    if (!sheet) throw new Error('Hoja CV no encontrada');
    var data  = sheet.getDataRange().getValues();
    for (var i = 2; i < data.length; i++) {
      if (String(data[i][COL_CV_OP.ID_ITEM - 1]) === idItem) {
        sheet.getRange(i + 1, COL_CV_OP.ID_ORDEN_WEB).setValue(ordenNum);
        result.success = true;
        return _jsonp(result, callback);
      }
    }
    throw new Error('Ítem no encontrado: ' + idItem);
  } catch(err) { result.error = err.message; }
  return _jsonp(result, callback);
}

function _handleRegistrarVentaDirecta(params, callback) {
  var result = { success: false, error: null };
  try {
    var idItem = params.id_item || '';
    if (!idItem) throw new Error('id_item requerido');
    var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_CV_OP);
    if (!sheet) throw new Error('Hoja CV no encontrada');
    var data  = sheet.getDataRange().getValues();
    for (var i = 2; i < data.length; i++) {
      if (String(data[i][COL_CV_OP.ID_ITEM - 1]) === String(idItem)) {
        sheet.getRange(i + 1, COL_CV_OP.ESTADO).setValue('cerrado');
        sheet.getRange(i + 1, 1, 1, CV_NCOLS_OP).setBackground('#E8F5E9');
        result.success = true;
        return _jsonp(result, callback);
      }
    }
    throw new Error('Item no encontrado: ' + idItem);
  } catch(err) { result.error = err.message; }
  return _jsonp(result, callback);
}

function _handleMarcarCostoOperativo(params, callback) {
  var result = { success: false, error: null };
  try {
    var idItem = params.id_item || '';
    if (!idItem) throw new Error('id_item requerido');
    var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_CV_OP);
    if (!sheet) throw new Error('Hoja CV no encontrada');
    var data  = sheet.getDataRange().getValues();
    for (var i = 2; i < data.length; i++) {
      if (String(data[i][COL_CV_OP.ID_ITEM - 1]) === String(idItem)) {
        sheet.getRange(i + 1, COL_CV_OP.ESTADO).setValue('cerrado');
        sheet.getRange(i + 1, COL_CV_OP.FUENTE).setValue('costo_operativo');
        sheet.getRange(i + 1, 1, 1, CV_NCOLS_OP).setBackground('#F3E5F5');
        result.success = true;
        return _jsonp(result, callback);
      }
    }
    throw new Error('Item no encontrado: ' + idItem);
  } catch(err) { result.error = err.message; }
  return _jsonp(result, callback);
}

function _handleEstadoTriggerOp(params, callback) {
  var result = { success: true, activo: false, intervalo: null };
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'ejecutarSincronizacionOp') {
      result.activo = true;
      break;
    }
  }
  return _jsonp(result, callback);
}

function _handleEstadoTriggerST(params, callback) {
  var result = { success: true, activo: false };
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'procesarEmailsST') {
      result.activo = true;
      break;
    }
  }
  return _jsonp(result, callback);
}

function _handleGetEmailSTLog(params, callback) {
  var result = { success: false, items: [], error: null };
  try {
    var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
    var sheet = ss.getSheetByName('Email_ST_Log');
    if (!sheet || sheet.getLastRow() <= 1) { result.success = true; return _jsonp(result, callback); }
    var numRows = sheet.getLastRow() - 1;
    var data    = sheet.getRange(2, 1, numRows, 10).getValues();
    var items   = [];
    for (var i = 0; i < data.length; i++) {
      var r = data[i];
      if (!r[0]) continue;
      items.push({ fecha_proc: r[0], message_id: r[1], asunto: r[2], remitente: r[3],
                   id_st: r[4], num_adjuntos: r[5], estado: r[6], detalles: r[7], drive_folder: r[8], error_msg: r[9] });
    }
    result.success = true;
    result.items   = items.reverse();
  } catch(err) { result.error = err.message; }
  return _jsonp(result, callback);
}

function _handleInstalarTriggerST(data) {
  var result = { success: false, error: null };
  try {
    var intervalo = parseInt(data.intervalo || '15', 10);
    removeEmailSTTrigger();
    ScriptApp.newTrigger('procesarEmailsST').timeBased().everyMinutes(intervalo).create();
    result.success = true;
  } catch(err) { result.error = err.message; }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function _handleRemoverTriggerST(data) {
  var result = { success: false, error: null };
  try { removeEmailSTTrigger(); result.success = true; } catch(err) { result.error = err.message; }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function _handleInstalarTriggerOp(data) {
  var result = { success: false, error: null };
  try {
    var intervalo = parseInt(data.intervalo || '15', 10);
    _removerTriggerOp();
    ScriptApp.newTrigger('ejecutarSincronizacionOp').timeBased().everyMinutes(intervalo).create();
    result.success = true;
  } catch(err) { result.error = err.message; }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function _handleRemoverTriggerOp(data) {
  var result = { success: false, error: null };
  try { _removerTriggerOp(); result.success = true; } catch(err) { result.error = err.message; }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function _removerTriggerOp() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'ejecutarSincronizacionOp') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════

function _facturaYaExiste(numFactura, tipo) {
  if (!numFactura) return false;
  var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_CV_OP);
  if (!sheet || sheet.getLastRow() <= 2) return false;
  var col  = tipo === 'proveedor' ? COL_CV_OP.NUM_FAC_PROVEEDOR - 1 : COL_CV_OP.NUM_FAC_EMITIDA - 1;
  var data = sheet.getDataRange().getValues();
  for (var i = 2; i < data.length; i++) {
    if (String(data[i][col]) === String(numFactura)) return true;
  }
  return false;
}

function _nuevoIdCV(ahora, seq, cfg) {
  var prefijo = (cfg && cfg.prefijo_id) ? cfg.prefijo_id : 'RP';
  return 'CV-OP-' + Utilities.formatDate(ahora, 'America/Panama', 'yyyyMMddHHmmss') + '-' + seq;
}

function _filaVacia(n) {
  var f = new Array(n);
  for (var i = 0; i < n; i++) f[i] = '';
  return f;
}

function _getOrCreateLabel(nombre) {
  var labels = GmailApp.getUserLabels();
  for (var i = 0; i < labels.length; i++) {
    if (labels[i].getName() === nombre) return labels[i];
  }
  return GmailApp.createLabel(nombre);
}

function _guardarPdfEnDrive(pdfBytesOrB64, filename, cfg) {
  try {
    var folderId = cfg ? cfg.drive_folder_id : '';
    if (!folderId) { Logger.log('⚠️  drive_folder_id no configurado'); return ''; }
    var folder = DriveApp.getFolderById(folderId);
    var bytes  = typeof pdfBytesOrB64 === 'string' ? Utilities.base64Decode(pdfBytesOrB64) : pdfBytesOrB64;
    var blob   = Utilities.newBlob(bytes, 'application/pdf', filename);
    var file   = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return 'https://drive.google.com/file/d/' + file.getId() + '/view';
  } catch(err) { Logger.log('Error guardando PDF: ' + err.message); return ''; }
}

function _xmlVal(xml, tag) {
  var m = xml.match(new RegExp('<' + tag + '>([^<]*)<\/' + tag + '>'));
  return m ? m[1] : '';
}

function _xmlItems(xml) {
  var items = [], m, re = /<gItem>([\s\S]*?)<\/gItem>/g;
  while ((m = re.exec(xml)) !== null) {
    var b = m[1];
    items.push({
      codigo:          _xmlVal(b, 'dCodProd'),
      descripcion:     _xmlVal(b, 'dDescProd'),
      precio_unitario: parseFloat(_xmlVal(b, 'dPrUnit')     || '0'),
      itbms:           parseFloat(_xmlVal(b, 'dValITBMS')   || '0'),
      total_item:      parseFloat(_xmlVal(b, 'dValTotItem') || '0'),
    });
  }
  return items;
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

function _jsonp(obj, callback) {
  var json = JSON.stringify(obj);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function detectarTipoPersona(ruc) {
  ruc = (ruc || '').trim();
  if (/^\d{1,2}-\d{1,6}-\d{1,6}$/.test(ruc))  return 'natural';
  if (/^\d{6,}-\d{1,3}-\d{6,}$/.test(ruc))     return 'juridica';
  if (/^N-\d+/.test(ruc))                       return 'extranjero';
  if (/^[A-Z]/i.test(ruc))                      return 'juridica';
  return 'natural';
}

// ═══════════════════════════════════════════════════════════════
//  INIT — ejecutar UNA SOLA VEZ en orden
// ═══════════════════════════════════════════════════════════════

function initConfigSheet(ss) {
  if (!ss) ss = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
  var existing = ss.getSheetByName(SHEET_CONFIG_OP);
  if (existing) return existing;
  var sheet = ss.insertSheet(SHEET_CONFIG_OP);
  SpreadsheetApp.flush();
  sheet.getRange(1, 1, 1, 2).setValues([['clave', 'valor']]);
  sheet.getRange(1, 1, 1, 2).setBackground('#1A237E').setFontColor('#FFF').setFontWeight('bold');
  var defaults = [
    ['empresa_nombre',     'Mi Empresa S.A.'],
    ['empresa_ruc',        ''],
    ['empresa_dv',         ''],
    ['email_comprobantes', ''],
    ['drive_folder_id',    ''],
    ['confianza_minima',   '70'],
    ['itbms_rate',         '0.07'],
    ['prefijo_id',         'RP'],
    ['modulo_activo',      'true'],
  ];
  sheet.getRange(2, 1, defaults.length, 2).setValues(defaults);
  sheet.setColumnWidth(1, 200);
  sheet.setColumnWidth(2, 350);
  sheet.setFrozenRows(1);
  Logger.log('✅ Config_Operaciones creada.');
  return sheet;
}

function _initConfigSheet(ss) {
  return initConfigSheet(ss);
}

function initProveedoresSheet() {
  var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_PROVEEDORES_OP);
  if (sheet) { Logger.log('✅ Proveedores_Config existe.'); return; }
  sheet = ss.insertSheet(SHEET_PROVEEDORES_OP);
  SpreadsheetApp.flush();
  var meta    = ['ID','DATOS FISCALES','','','GMAIL','DETECCIÓN IA','','CONFIG','','ARCHIVO','NOTAS',''];
  var headers = ['id_proveedor','nombre','ruc','dv','email_origen','keywords_deteccion','prompt_override','activo','fecha_alta','drive_url_ejemplo','notas','aplica_a'];
  sheet.getRange(1, 1, 1, PROV_NCOLS_OP).setValues([meta]);
  sheet.getRange(1, 1, 1, PROV_NCOLS_OP).setBackground('#37474F').setFontColor('#FFF').setFontWeight('bold');
  sheet.getRange(2, 1, 1, PROV_NCOLS_OP).setValues([headers]);
  sheet.getRange(2, 1, 1, PROV_NCOLS_OP).setBackground('#546E7A').setFontColor('#FFF').setFontWeight('bold');
  sheet.setFrozenRows(2);
  Logger.log('✅ Proveedores_Config creada.');
}

function initComprasVentasSheet() {
  var ss = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
  if (ss.getSheetByName(SHEET_CV_OP)) { Logger.log('⚠️ Compras_Ventas ya existe.'); return; }
  var sheet = ss.insertSheet(SHEET_CV_OP);
  SpreadsheetApp.flush();
  var meta = ['ID','REGISTRO','ESTADO','FUENTE','MATCH','','COMPRA (Proveedor)','','','','','','','VENTA (Factura emitida)','','','','','','','','','VÍNCULOS','','','','','CANT'];
  var headers = ['id_item','fecha_registro','estado','fuente','confianza_match','flag_revision','fecha_compra','num_factura_proveedor','codigo_producto','descripcion_producto','precio_unit_proveedor','itbms_proveedor','total_proveedor','fecha_venta','num_factura_emitida','nombre_cliente','ruc_cliente','dv_cliente','precio_venta','itbms_venta','total_venta','margen','id_orden_web','drive_url_proveedor','drive_url_emitida','notas','ingreso_id','cantidad'];
  sheet.getRange(1, 1, 1, CV_NCOLS_OP).setValues([meta]);
  sheet.getRange(1, 1, 1, CV_NCOLS_OP).setBackground('#37474F').setFontColor('#FFF').setFontWeight('bold');
  sheet.getRange(2, 1, 1, CV_NCOLS_OP).setValues([headers]);
  sheet.getRange(2, 1, 1, CV_NCOLS_OP).setBackground('#546E7A').setFontColor('#FFF').setFontWeight('bold');
  sheet.setFrozenRows(2);
  Logger.log('✅ Compras_Ventas creada.');
}

function verificarSetupOperaciones() {
  Logger.log('🔍 Verificando setup Operaciones...');
  var cfg  = _getConfig();
  Logger.log('  empresa_nombre:     ' + cfg.empresa_nombre);
  Logger.log('  empresa_ruc:        ' + (cfg.empresa_ruc || '⚠️ VACÍO'));
  Logger.log('  email_op_destino:   ' + (cfg.email_op_destino || '⚠️ VACÍO'));
  Logger.log('  email_op_remitente: ' + (cfg.email_op_remitente || '⚠️ VACÍO'));
  Logger.log('  email_acr_destino:  ' + (cfg.email_acr_destino || '— (usa fallback op)'));
  Logger.log('  email_acr_remitente:' + (cfg.email_acr_remitente || '— (usa fallback op)'));
  Logger.log('  drive_folder_id:    ' + (cfg.drive_folder_id || '⚠️ VACÍO'));
  var prov = _getProveedorBase();
  Logger.log(prov ? '✅ Proveedor base: ' + prov.nombre : '⚠️ Sin proveedor base');
}
