// ═══════════════════════════════════════════════════════════════
//  ContaFacil_Operaciones_CEYCO.gs
//  Módulo: Compras & Ventas — Configurable multi-cliente
//  v1.0 — Arquitectura dinámica: datos de empresa/proveedor
//          leídos desde hoja 'Config' del Sheet.
//          Sin hardcoding de RUC, nombre, email ni proveedor.
//
//  DEPLOYMENT: Mismo proyecto GAS que Code.gs (CEYCO).
//  Comparte COL_E, COL_I, EGRESOS_NCOLS, INGRESOS_NCOLS de Code.gs.
//
//  SETUP INICIAL (ejecutar en orden, una sola vez):
//    1. Ejecutar initConfigSheet()   → crea hoja 'Config'
//    2. Ejecutar initProveedoresSheet() → crea hoja 'Proveedores'
//    3. Ejecutar initComprasVentasSheet() → crea hoja 'Compras_Ventas'
//    4. Desde el dashboard (?admin=1 → Configuración) llenar
//       los datos de empresa y proveedor base.
//    4. Redesplegar Web App (mismo deployment que el sistema principal).
// ═══════════════════════════════════════════════════════════════

// ── CONFIG ESTÁTICA (solo el Sheet ID — lo demás viene de la hoja Config) ──
var CONFIG_OP = {
  SHEET_ID: '1UCV17jyqvwbiR6YyuUkvhhjPJrR_9Bh7w9XgSGRZkNk',  // ← mismo Sheet que el sistema
};

// ── NOMBRES DE HOJAS ─────────────────────────────────────────
var SHEET_CV_OP          = 'Compras_Ventas';
var SHEET_CONFIG_OP      = 'Config_Operaciones';  // nueva hoja — no existe aún
var SHEET_PROVEEDORES_OP = 'Proveedores_Config';  // hoja existente en el Sheet

// ── COLUMNAS Config_Operaciones ──────────────────────────────
// Fila 1 = cabecera, datos desde fila 2 (una fila por clave)
// Columna A = clave, Columna B = valor

// ── COLUMNAS Proveedores_Config (base 1) ─────────────────────────
// ── COLUMNAS Proveedores_Config (base 1) ─────────────────────
// Estructura real existente en el Sheet de CEYCO:
// fila 1 = grupos semánticos, fila 2 = nombres snake_case, datos desde fila 3
var COL_PROV_OP = {
  ID:              1,   // A  id_proveedor
  NOMBRE:          2,   // B  nombre
  RUC:             3,   // C  ruc
  DV:              4,   // D  dv
  EMAIL_ORIGEN:    5,   // E  email_origen
  KEYWORDS:        6,   // F  keywords_deteccion
  PROMPT_OVERRIDE: 7,   // G  prompt_override
  ACTIVO:          8,   // H  activo
  FECHA_ALTA:      9,   // I  fecha_alta
  DRIVE_EJEMPLO:  10,   // J  drive_url_ejemplo
  NOTAS:          11,   // K  notas
  APLICA_A:       12,   // L  aplica_a: 'retail' | 'st' | 'ambos'
};
var PROV_NCOLS_OP = 12;

// ── COLUMNAS Compras_Ventas (base 1) — igual que RP ──────────
var COL_CV_OP = {
  ID_ITEM:          1,
  FECHA_REG:        2,
  ESTADO:           3,
  FUENTE:           4,
  CONFIANZA_MATCH:  5,
  FLAG_REVISION:    6,
  FECHA_COMPRA:     7,
  NUM_FAC_PROVEEDOR:8,   // antes NUM_FAC_CARBONE — ahora genérico
  CODIGO_PROD:      9,
  DESCRIPCION_PROD: 10,
  PRECIO_UNIT_PROV: 11,  // antes PRECIO_UNIT_CARB
  ITBMS_PROV:       12,  // antes ITBMS_CARBONE
  TOTAL_PROV:       13,  // antes TOTAL_CARBONE
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
  DRIVE_URL_PROV:   24,  // antes DRIVE_URL_CARB
  DRIVE_URL_EMIT:   25,
  NOTAS:            26,
  INGRESO_ID:       27,
  CANTIDAD:         28,
};
var CV_NCOLS_OP = 28;

// Nombres de hojas — strings simples, no colisionan con Code.gs
// COL_E, COL_I, EGRESOS_NCOLS, INGRESOS_NCOLS son heredados de Code.gs (objetos/números)
var SHEET_INGRESOS = 'Ingresos';
var SHEET_EGRESOS  = 'Egresos';
// ── CACHÉ de config en memoria (válido por request) ───────────
var _cfgCacheOp = null;

// ═══════════════════════════════════════════════════════════════
//  _getConfig() — Lee Config_Operaciones del Sheet
//  Cachea en memoria para el request actual.
//  Todos los valores son strings; el caller hace el cast.
// ═══════════════════════════════════════════════════════════════

function _getConfig() {
  if (_cfgCacheOp) return _cfgCacheOp;

  var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_CONFIG_OP);

  // Defaults seguros si la hoja no existe aún
  var defaults = {
    empresa_nombre:       'Mi Empresa S.A.',
    empresa_ruc:          '',
    empresa_dv:           '',
    email_comprobantes:   '',   // legado — plus-address anterior (Retail)
    email_op_destino:     '',   // nuevo: To: fijo (ej: facturas@balanceclip.net)
    email_op_remitente:   '',   // nuevo: From: del cliente permitido   // legado — plus-address anterior (Retail)
    email_op_destino:     '',   // nuevo: To: fijo (ej: facturas@balanceclip.net)
    email_op_remitente:   '',   // nuevo: From: del cliente permitido
    drive_folder_id:      '',
    confianza_minima:     '70',
    itbms_rate:           '0.07',
    prefijo_id:           'RP',
    modulo_activo:        'true',
    email_st_entrante:    'lasnubesenchica+ceyco@gmail.com',  // legado — plus-address anterior
    email_st_destino:     '',   // dirección To: fija (ej: facturas@balanceclip.net)
    email_st_remitente:   '',   // From: del cliente permitido (ej: mediarank.io@gmail.com)
  };

  if (!sheet) {
    Logger.log('⚠️  Config_Operaciones no encontrada — usando defaults. Ejecutar initConfigSheet().');
    _cfgCacheOp = defaults;
    return _cfgCacheOp;
  }

  var data = sheet.getDataRange().getValues();
  var cfg  = Object.assign({}, defaults);

  for (var i = 1; i < data.length; i++) {  // fila 1 = cabecera, datos desde fila 2
    var clave = String(data[i][0] || '').trim();
    var valor = String(data[i][1] || '').trim();
    if (clave) cfg[clave] = valor;
  }

  _cfgCacheOp = cfg;
  return _cfgCacheOp;
}

// ═══════════════════════════════════════════════════════════════
//  _getProveedorBase() — Primer proveedor activo.
// ═══════════════════════════════════════════════════════════════

function _getProveedorBase() {
  var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_PROVEEDORES_OP);
  if (!sheet || sheet.getLastRow() <= 2) return null;

  var data  = sheet.getRange(3, 1, sheet.getLastRow() - 2, PROV_NCOLS_OP).getValues();
  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    if (!r[COL_PROV_OP.ID - 1]) continue;
    var activo = String(r[COL_PROV_OP.ACTIVO - 1]).toLowerCase() === 'true';
    if (!activo) continue;
    return {
      id:              r[COL_PROV_OP.ID - 1],
      nombre:          r[COL_PROV_OP.NOMBRE - 1]          || '',
      ruc:             r[COL_PROV_OP.RUC - 1]              || '',
      dv:              r[COL_PROV_OP.DV - 1]               || '',
      email_origen:    r[COL_PROV_OP.EMAIL_ORIGEN - 1]     || '',
      keywords:        String(r[COL_PROV_OP.KEYWORDS - 1] || '').replace(/\|/g, ','),
      prompt_override: r[COL_PROV_OP.PROMPT_OVERRIDE - 1]  || '',
      aplica_a:        r[COL_PROV_OP.APLICA_A - 1] || 'retail',
    };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
//  _matchearProveedor
//  Encuentra el proveedor configurado que corresponde a una
//  factura específica, usando dos señales en orden de precisión:
//    1. Email de origen del mensaje (más exacto)
//    2. Keywords en el nombre del archivo
//  Si no hay match, retorna null → Claude usa prompt genérico.
//  Esto corrige el bug donde provBase se aplicaba a todas las
//  facturas independientemente del proveedor real.
// ═══════════════════════════════════════════════════════════════

function _matchearProveedor(fileName, fromEmail) {
  var proveedores = _getTodosProveedores();
  var fnLower     = (fileName  || '').toLowerCase();
  var fromLower   = (fromEmail || '').toLowerCase();

  for (var i = 0; i < proveedores.length; i++) {
    var pv = proveedores[i];
    if (!pv.activo) continue;

    // 1. Match por email de origen (más confiable)
    if (pv.email_origen) {
      var emailOrigen = pv.email_origen.toLowerCase().trim();
      if (emailOrigen && fromLower.indexOf(emailOrigen) !== -1) {
        Logger.log('  🔍 Proveedor matcheado por email: ' + pv.nombre + ' ← ' + fromEmail);
        return pv;
      }
    }

    // 2. Match por keywords en el nombre del archivo
    var keywords = (pv.keywords || '').toLowerCase().split(/[,|]/);
    for (var k = 0; k < keywords.length; k++) {
      var kw = keywords[k].trim();
      if (kw && fnLower.indexOf(kw) !== -1) {
        Logger.log('  🔍 Proveedor matcheado por keyword "' + kw + '": ' + pv.nombre);
        return pv;
      }
    }

    // 3. Match por RUC en el nombre del archivo
    var rucNorm = (pv.ruc || '').replace(/[-\.]/g, '').toLowerCase();
    if (rucNorm && fnLower.indexOf(rucNorm) !== -1) {
      Logger.log('  🔍 Proveedor matcheado por RUC: ' + pv.nombre);
      return pv;
    }
  }

  Logger.log('  ℹ️  Sin match de proveedor para: ' + fileName + ' | de: ' + fromEmail + ' — usando prompt genérico');
  return null;
}

// ═══════════════════════════════════════════════════════════════
//  _getProveedores() — Todos los proveedores activos
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
      aplica_a:        r[COL_PROV_OP.APLICA_A - 1] || 'retail',
      prompt_override: r[COL_PROV_OP.PROMPT_OVERRIDE - 1]  || '',
      drive_ejemplo:   r[COL_PROV_OP.DRIVE_EJEMPLO - 1]    || '',
      fecha_alta:      r[COL_PROV_OP.FECHA_ALTA - 1]       || '',
    });
  }
  return items;
}

// ═══════════════════════════════════════════════════════════════
//  WEB APP ENTRY POINTS
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
//  DISPATCH — llamado desde doGet y doPost de Code.gs
//  Retorna null si la action no es de Operaciones (Code.gs continúa).
//  Retorna un ContentService output si la maneja.
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
  // ── Acreedores (módulo independiente) ──
  var resAcr = doGet_Acreedores(action, params, callback);
  if (resAcr !== null) return resAcr;
  return null;  // no es una action de Operaciones
}

// doPost — manejado por Code.gs. Handlers de Operaciones registrados en doPost_Operaciones().

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
  // ── Acreedores (módulo independiente) ──
  var resAcrPost = doPost_Acreedores(action, data);
  if (resAcrPost !== null) return resAcrPost;
  return null;  // no es una action de Operaciones
}


// ═══════════════════════════════════════════════════════════════
//  HANDLER: getConfig (público — para llenar el panel Setup)
// ═══════════════════════════════════════════════════════════════

function _handleGetConfigPublic(params, callback) {
  var cfg  = _getConfig();
  var prov = _getProveedorBase();
  return _jsonp({
    success: true,
    config:  cfg,
    proveedor_base: prov,
    proveedores: _getTodosProveedores(),
  }, callback);
}

// ═══════════════════════════════════════════════════════════════
//  HANDLER: guardarConfig — escribe en Config_Operaciones
// ═══════════════════════════════════════════════════════════════

function _handleGuardarConfig(data) {
  try {
    var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_CONFIG_OP) || _initConfigSheet(ss);

    var claves = [
      'empresa_nombre', 'empresa_ruc', 'empresa_dv',
      'email_comprobantes',   // legado — mantener para no romper instancias existentes
      'email_op_destino',     // nuevo: To: fijo (facturas@balanceclip.net)
      'email_op_remitente',   // nuevo: From: del cliente permitido
      'drive_folder_id',
      'confianza_minima', 'itbms_rate', 'prefijo_id',
      'email_st_entrante',
      'email_st_destino',    // nuevo: To: fijo ST
      'email_st_remitente',  // nuevo: From: del cliente ST
      'trigger_op_intervalo',
      'trigger_st_intervalo',
    ];

    // Leer mapa actual clave→fila
    var existing = sheet.getDataRange().getValues();
    var filaMap  = {};
    for (var i = 1; i < existing.length; i++) {
      var k = String(existing[i][0] || '').trim();
      if (k) filaMap[k] = i + 1;  // fila real (base 1)
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

    _cfgCacheOp = null;  // invalidar caché
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

    var data  = sheet.getRange(3, 1, sheet.getLastRow() - 2, PROV_NCOLS_OP).getValues();
    var found = false;
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][COL_PROV_OP.ID - 1]) === String(id)) {
        sheet.getRange(i + 3, COL_PROV_OP.ACTIVO).setValue(activo);
        found = true;
        break;
      }
    }
    if (!found) throw new Error('Proveedor no encontrado: ' + id);
    result.success = true;
  } catch (err) {
    result.error = err.message;
  }
  return _jsonp(result, callback);
}

// ═══════════════════════════════════════════════════════════════
//  HANDLER: guardarProveedor (nuevo o editar)
// ═══════════════════════════════════════════════════════════════

function _handleGuardarProveedor(data) {
  try {
    var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_PROVEEDORES_OP) || _initProveedoresSheet(ss);

    var nombre = String(data.nombre || '').trim();
    var ruc    = String(data.ruc    || '').trim();
    if (!nombre || !ruc) throw new Error('nombre y ruc son obligatorios');

    var ahora = new Date();

    // Guardar factura ejemplo en Drive si viene base64
    var driveEjemplo = '';
    if (data.imageBase64 && data.mimeType) {
      try {
        var cfg    = _getConfig();
        var folder = DriveApp.getFolderById(cfg.drive_folder_id);
        var bytes  = Utilities.base64Decode(data.imageBase64);
        var blob   = Utilities.newBlob(bytes, data.mimeType,
                       'FacturaEjemplo_' + nombre.replace(/\s+/g, '_') + '.' +
                       (data.mimeType === 'application/pdf' ? 'pdf' : 'jpg'));
        var file   = folder.createFile(blob);
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        driveEjemplo = 'https://drive.google.com/file/d/' + file.getId() + '/view';
      } catch(driveErr) {
        Logger.log('⚠️  No se pudo guardar factura ejemplo: ' + driveErr.message);
      }
    }

    if (data.id) {
      // ── Editar existente ──
      var rows  = sheet.getRange(3, 1, sheet.getLastRow() - 2, PROV_NCOLS_OP).getValues();
      var found = false;
      for (var i = 0; i < rows.length; i++) {
        if (String(rows[i][COL_PROV_OP.ID - 1]) === String(data.id)) {
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
      // ── Nuevo proveedor ──
      var lastRow = sheet.getLastRow();
      var seq     = 1;
      if (lastRow > 2) {
        var ids = sheet.getRange(3, COL_PROV_OP.ID, lastRow - 2, 1).getValues();
        for (var j = ids.length - 1; j >= 0; j--) {
          var parts = String(ids[j][0] || '').split('-');
          var n     = parseInt(parts[parts.length - 1], 10);
          if (!isNaN(n)) { seq = n + 1; break; }
        }
      }
      var newId = 'PROV-' + String(seq).padStart(3, '0');

      var fila = new Array(PROV_NCOLS_OP);
      for (var x = 0; x < PROV_NCOLS_OP; x++) fila[x] = '';
      fila[COL_PROV_OP.ID - 1]             = newId;
      fila[COL_PROV_OP.NOMBRE - 1]         = nombre;
      fila[COL_PROV_OP.RUC - 1]            = ruc;
      fila[COL_PROV_OP.DV - 1]             = data.dv              || '';
      fila[COL_PROV_OP.EMAIL_ORIGEN - 1]   = data.email_origen    || '';
      fila[COL_PROV_OP.KEYWORDS - 1]       = String(data.keywords || '').replace(/,/g, '|');
      fila[COL_PROV_OP.ACTIVO - 1]         = true;
      fila[COL_PROV_OP.PROMPT_OVERRIDE - 1]= data.prompt_override || '';
      fila[COL_PROV_OP.DRIVE_EJEMPLO - 1]  = driveEjemplo;
      fila[COL_PROV_OP.FECHA_ALTA - 1]     = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd');
      fila[COL_PROV_OP.APLICA_A - 1]      = data.aplica_a || 'retail';

      sheet.getRange(sheet.getLastRow() + 1, 1, 1, PROV_NCOLS_OP).setValues([fila]);


      Logger.log('✅ Proveedor creado: ' + newId + ' | ' + nombre + ' | aplica_a: ' + (data.aplica_a || 'retail'));
      return _json({ success: true, id: newId });
    }

  } catch (err) {
    Logger.log('Error guardarProveedor: ' + err.message);
    return _json({ success: false, error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
//  HANDLER: analizarFacturaEjemplo
//  Sube una factura, la analiza con Claude y retorna datos
//  sugeridos para el formulario de nuevo proveedor.
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
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages:   [{
        role:    'user',
        content: [
          contentBlock,
          { type: 'text', text:
            'Analiza esta factura panameña. Responde SOLO con JSON válido, sin markdown:\n' +
            '{"nombre_proveedor":"","ruc":"","dv":"","tiene_itbms":true,' +
            '"formato_num_fac":"","email_origen":"","keywords":"","notas_formato":""}\n' +
            'keywords = palabras clave que identifican a este proveedor en el nombre del archivo.\n' +
            'notas_formato = instrucción breve para Claude al parsear futuras facturas de este proveedor.\n' +
            'Si un campo no es visible usar null.'
          }
        ]
      }]
    };

    var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post', contentType: 'application/json',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify(payload), muteHttpExceptions: true,
    });

    if (resp.getResponseCode() !== 200) {
      throw new Error('Claude API error ' + resp.getResponseCode());
    }

    var text = '';
    var content = JSON.parse(resp.getContentText()).content || [];
    for (var i = 0; i < content.length; i++) {
      if (content[i].type === 'text') { text = content[i].text; break; }
    }
    var parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    parsed.success = true;
    return ContentService.createTextOutput(JSON.stringify(parsed))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log('Error analizarFacturaEjemplo: ' + err.message);
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ═══════════════════════════════════════════════════════════════
//  SINCRONIZAR EMAILS
//  Lee correos a EMAIL_COMPROBANTES, detecta tipo de factura
//  usando _detectarTipoFactura() con datos dinámicos de Config.
// ═══════════════════════════════════════════════════════════════

function _handleSincronizar(params, callback) {
  var result = { success: false, procesados: 0, nuevos: 0, vinculados: 0, errores: [], error: null };
  try {
    var stats      = sincronizarEmails();
    result.success = true;
    result.procesados = stats.procesados;
    result.nuevos    = stats.nuevos;
    result.vinculados = stats.vinculados;
    result.errores   = stats.errores;
  } catch (err) {
    result.error = err.message;
    Logger.log('Error sincronizar: ' + err.message);
  }
  return _jsonp(result, callback);
}

// Función llamada por el trigger automático de Operaciones
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
  var stats = { procesados: 0, nuevos: 0, vinculados: 0, errores: [] };
  var pendientesEmitidas = [];

  // Construir query Gmail — mismo patrón de cascada que ST (v2.1)
  var query;
  if (cfg.email_op_destino && cfg.email_op_remitente) {
    // Modo nuevo: destino fijo + remitente del cliente
    query = 'to:' + cfg.email_op_destino + ' from:' + cfg.email_op_remitente + ' has:attachment -label:procesado_cf_op';
    Logger.log('📧 Query Retail: to:' + cfg.email_op_destino + ' from:' + cfg.email_op_remitente);
  } else if (cfg.email_op_destino) {
    // Solo destino configurado (migración parcial)
    query = 'to:' + cfg.email_op_destino + ' has:attachment -label:procesado_cf_op';
    Logger.log('📧 Query Retail (sin remitente): to:' + cfg.email_op_destino);
  } else if (cfg.email_comprobantes) {
    // Legado: plus-address anterior
    query = 'to:' + cfg.email_comprobantes + ' has:attachment -label:procesado_cf_op';
    Logger.log('📧 Query Retail (legado): to:' + cfg.email_comprobantes);
  } else {
    throw new Error('Email de entrada Retail no configurado. Ir a Configuración → Operaciones.');
  }
  var threads = GmailApp.search(query, 0, 50);
  var label   = _getOrCreateLabel('procesado_cf_op');

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
          var esPdf = fnL.endsWith('.pdf') || ct === 'application/pdf';
          var esXml = fnL.endsWith('.xml') || ct === 'text/xml' || ct === 'application/xml';
          if (!esPdf && !esXml) continue;
          var base = fn.replace(/\.(pdf|xml)$/i, '');
          if (esXml) {
            try { xmlMap[base] = att.getDataAsString(); }
            catch(e) { Logger.log('Error leyendo XML: ' + fn); }
          }
          if (esPdf) {
            try {
              var bytes = att.getBytes();
              pdfMap[base] = { bytes: bytes, b64: Utilities.base64Encode(bytes), fn: fn };
            }
            catch(e) { Logger.log('Error leyendo PDF: ' + fn); }
          }
        }

        var procesados = {};

        // ── Procesar XMLs (DGI e-Tax) ──
        for (var base in xmlMap) {
          if (procesados[base]) continue;
          var xmlStr   = xmlMap[base];
          var pdfInfo  = pdfMap[base] || null;
          var pdfB64   = pdfInfo ? pdfInfo.b64  : null;
          var pdfBytes = pdfInfo ? pdfInfo.bytes : null;
          var fileName = pdfInfo ? pdfInfo.fn    : (base + '.xml');
          var tipoFac  = _detectarTipoFactura(xmlStr, fileName, pdfB64);
          stats.procesados++;
          try {
            if (tipoFac === 'proveedor') {
              stats.nuevos += _procesarXmlProveedor(xmlStr, pdfBytes, fileName, date, from);
            } else if (tipoFac === 'emitida') {
              var b64u = pdfB64 || (pdfBytes ? Utilities.base64Encode(pdfBytes) : null);
              if (b64u) pendientesEmitidas.push({ b64: b64u, bytes: pdfBytes, fn: fileName, date: date });
              else stats.errores.push('Emitida sin PDF: ' + fileName);
            } else {
              stats.errores.push('No reconocido (XML): ' + fileName + ' | de: ' + from);
            }
          } catch(e) {
            stats.errores.push('Error "' + fileName + '": ' + e.message);
          }
          procesados[base] = true;
        }

        // ── Procesar PDFs sin XML par ──
        for (var base in pdfMap) {
          if (procesados[base]) continue;
          var pdfInfo = pdfMap[base];
          var tipoFac = _detectarTipoFactura(null, pdfInfo.fn, pdfInfo.b64);
          stats.procesados++;
          try {
            if (tipoFac === 'proveedor') {
              stats.nuevos += _procesarFacturaProveedor(pdfInfo.b64, pdfInfo.bytes, pdfInfo.fn, date, from);
            } else if (tipoFac === 'emitida') {
              pendientesEmitidas.push({ b64: pdfInfo.b64, bytes: pdfInfo.bytes, fn: pdfInfo.fn, date: date });
            } else {
              stats.errores.push('No reconocido (PDF): ' + pdfInfo.fn + ' | de: ' + from);
            }
          } catch(e) {
            stats.errores.push('Error "' + pdfInfo.fn + '": ' + e.message);
          }
          procesados[base] = true;
        }

        threads[t].addLabel(label);

      } catch(msgErr) {
        stats.errores.push('Error mensaje: ' + msgErr.message);
      }
    }
  }

  // ── Ronda 2: procesar facturas emitidas ──
  Logger.log('Ronda 2: ' + pendientesEmitidas.length + ' facturas emitidas...');
  for (var ei = 0; ei < pendientesEmitidas.length; ei++) {
    var em = pendientesEmitidas[ei];
    try {
      stats.vinculados += _procesarFacturaEmitida(em.b64, em.bytes, em.fn, em.date);
    } catch(err) {
      stats.errores.push('Error emitida "' + em.fn + '": ' + err.message);
    }
  }

  Logger.log('Sincronización: ' + JSON.stringify(stats));
  return stats;
}

// ═══════════════════════════════════════════════════════════════
//  DETECCIÓN DE TIPO DE FACTURA — Dinámica
//  Usa RUC de empresa y proveedor base desde Config/Proveedores.
//  Retorna: 'proveedor' | 'emitida' | 'desconocido'
// ═══════════════════════════════════════════════════════════════

function _detectarTipoFactura(xmlStr, fileName, pdfB64) {
  var cfg        = _getConfig();
  var proveedores = _getTodosProveedores();

  var rucEmpresa  = (cfg.empresa_ruc  || '').replace(/[-\.]/g, '');
  // RUCs de todos los proveedores activos para detección
  var rucsProveedores = proveedores
    .filter(function(p) { return p.activo; })
    .map(function(p) { return (p.ruc || '').replace(/[-\.]/g, '').toLowerCase(); })
    .filter(function(r) { return !!r; });

  // ── 1. Detección por XML (más confiable) ──
  if (xmlStr) {
    var emisorBlock = xmlStr.match(/<gEmis>([\s\S]*?)<\/gEmis>/);
    if (emisorBlock) {
      var bloque = emisorBlock[1];
      // El emisor es la empresa → factura emitida por nosotros
      if (rucEmpresa && bloque.indexOf(rucEmpresa) !== -1) return 'emitida';
      // El emisor es alguno de los proveedores configurados → factura de compra
      for (var ri = 0; ri < rucsProveedores.length; ri++) {
        if (rucsProveedores[ri] && bloque.indexOf(rucsProveedores[ri]) !== -1) return 'proveedor';
      }
    }
    // Texto plano como fallback
    if (rucEmpresa && xmlStr.indexOf(rucEmpresa) !== -1) return 'emitida';
    for (var rj = 0; rj < rucsProveedores.length; rj++) {
      if (rucsProveedores[rj] && xmlStr.indexOf(rucsProveedores[rj]) !== -1) return 'proveedor';
    }
    if (cfg.empresa_nombre && xmlStr.toUpperCase().indexOf(cfg.empresa_nombre.toUpperCase().split(' ')[0]) !== -1) return 'emitida';
    // Nombres de proveedores en texto XML
    for (var pi2 = 0; pi2 < proveedores.length; pi2++) {
      var pn = (proveedores[pi2].nombre || '').toUpperCase().split(' ')[0];
      if (pn && xmlStr.toUpperCase().indexOf(pn) !== -1) return 'proveedor';
    }
  }

  // ── 2. Detección por nombre de archivo ──
  var fn = (fileName || '').toLowerCase();

  // RUC de empresa en nombre de archivo (patrón DGI: fe01200001RUCNNN_...)
  if (rucEmpresa && fn.indexOf(rucEmpresa.toLowerCase()) !== -1) return 'emitida';

  // RUC o keywords de cualquier proveedor configurado
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

  // ── 3. Fallback: clasificar con Claude Haiku ──
  if (pdfB64) return _claudeClasificarFactura(pdfB64, cfg, null);
  return 'desconocido';
}

// ═══════════════════════════════════════════════════════════════
//  CLAUDE — Clasificar tipo de factura (fallback Haiku)
// ═══════════════════════════════════════════════════════════════

function _claudeClasificarFactura(pdfB64, cfg, provBase) {
  // provBase puede ser null — en ese caso Claude clasifica sin contexto de proveedor
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) return 'desconocido';

  var empresaNombre = cfg.empresa_nombre || 'la empresa emisora';
  var empresaRuc    = cfg.empresa_ruc    || '';
  var provNombre    = provBase ? (provBase.nombre || 'el proveedor') : 'el proveedor principal';
  var provRuc       = provBase ? (provBase.ruc    || '') : '';

  var pregunta =
    '¿Esta factura panameña fue emitida POR ' + provNombre +
    (provRuc ? ' (RUC ' + provRuc + ')' : '') +
    ' o POR ' + empresaNombre +
    (empresaRuc ? ' (RUC ' + empresaRuc + ')' : '') + '?\n' +
    'Responde SOLO: "proveedor" si el emisor es ' + provNombre.split(' ')[0] +
    ', "emitida" si el emisor es ' + empresaNombre.split(' ')[0] +
    ', o "desconocido".';

  var payload = {
    model: 'claude-haiku-4-5-20251001', max_tokens: 15,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfB64 } },
        { type: 'text', text: pregunta }
      ]
    }]
  };

  try {
    var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post', contentType: 'application/json',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify(payload), muteHttpExceptions: true,
    });
    var text = '';
    var content = JSON.parse(resp.getContentText()).content || [];
    for (var i = 0; i < content.length; i++) {
      if (content[i].type === 'text') { text = content[i].text.trim().toLowerCase(); break; }
    }
    if (text === 'proveedor' || text === 'emitida') return text;
  } catch(e) { Logger.log('Error clasificar: ' + e.message); }
  return 'desconocido';
}

// ═══════════════════════════════════════════════════════════════
//  PARSEAR FACTURA DE PROVEEDOR — XML DGI
// ═══════════════════════════════════════════════════════════════

function _procesarXmlProveedor(xmlStr, pdfBytes, fileName, fechaEmail, fromEmail) {
  var numFactura     = _xmlVal(xmlStr, 'dNroDF');
  var fechaEmision   = (_xmlVal(xmlStr, 'dFechaEm') || '').substring(0, 10);
  var nombreReceptor = _xmlVal(xmlStr, 'dNombRec');

  if (!numFactura) { Logger.log('XML sin número de factura'); return 0; }
  if (_facturaYaExiste(numFactura, 'proveedor')) {
    Logger.log('Factura proveedor ' + numFactura + ' ya procesada'); return 0;
  }

  var cfg = _getConfig();
  var driveUrl = pdfBytes ? _guardarPdfEnDrive(pdfBytes, 'Proveedor_' + numFactura + '.pdf', cfg) : '';
  var items    = _xmlItems(xmlStr);
  if (!items.length) { Logger.log('XML sin ítems: ' + numFactura); return 0; }

  var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_CV_OP);
  if (!sheet) throw new Error('Hoja Compras_Ventas no encontrada. Ejecutar initComprasVentasSheet().');

  var provBase     = _matchearProveedor(fileName, fromEmail);
  var ahora        = new Date();
  var fechaReg     = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
  var totalFactura = items.reduce(function(s, i) { return s + i.total_item; }, 0);

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
    fila[COL_CV_OP.CODIGO_PROD - 1]       = item.codigo;
    fila[COL_CV_OP.DESCRIPCION_PROD - 1]  = item.descripcion;
    fila[COL_CV_OP.PRECIO_UNIT_PROV - 1]  = item.precio_unitario;
    fila[COL_CV_OP.ITBMS_PROV - 1]        = item.itbms;
    fila[COL_CV_OP.TOTAL_PROV - 1]        = item.total_item;
    fila[COL_CV_OP.DRIVE_URL_PROV - 1]    = driveUrl;
    fila[COL_CV_OP.CANTIDAD - 1]          = 1;
    fila[COL_CV_OP.NOTAS - 1]             = 'Proveedor: ' + (provBase ? provBase.nombre : '') +
                                         ' | Total factura: $' + totalFactura.toFixed(2) + ' | XML';

    var lastRow = sheet.getLastRow() + 1;
    sheet.getRange(lastRow, 1, 1, CV_NCOLS_OP).setValues([fila]);
    sheet.getRange(lastRow, COL_CV_OP.PRECIO_UNIT_PROV, 1, 3).setNumberFormat('#,##0.00');
    sheet.getRange(lastRow, 1, 1, CV_NCOLS_OP).setBackground('#FFF3E0');
  }

  Logger.log('✅ XML proveedor ' + numFactura + ': ' + items.length + ' ítems');
  return items.length;
}

// ═══════════════════════════════════════════════════════════════
//  PARSEAR FACTURA DE PROVEEDOR — PDF via Claude
// ═══════════════════════════════════════════════════════════════

function _procesarFacturaProveedor(pdfB64, pdfBytes, fileName, fechaEmail, fromEmail) {
  var cfg      = _getConfig();
  var provBase = _matchearProveedor(fileName, fromEmail);
  var parsed   = _claudeParsePdfFactura(pdfB64, 'application/pdf', 'proveedor', cfg, provBase);

  if (!parsed || !parsed.items || !parsed.items.length) {
    Logger.log('Claude no extrajo ítems de PDF proveedor');
    return 0;
  }
  if (_facturaYaExiste(parsed.num_factura, 'proveedor')) {
    Logger.log('Factura proveedor ' + parsed.num_factura + ' ya procesada');
    return 0;
  }

  var driveUrl = _guardarPdfEnDrive(pdfBytes, 'Proveedor_' + parsed.num_factura + '_' + fileName, cfg);
  var ss       = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
  var sheet    = ss.getSheetByName(SHEET_CV_OP);
  if (!sheet) throw new Error('Hoja Compras_Ventas no encontrada.');

  var ahora        = new Date();
  var fechaReg     = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
  var totalFactura = parsed.items.reduce(function(s, i) { return s + (parseFloat(i.total_item||0)||0); }, 0);

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
    fila[COL_CV_OP.NOTAS - 1]             = 'Total factura: $' + totalFactura.toFixed(2) + ' | PDF';

    var lastRow = sheet.getLastRow() + 1;
    sheet.getRange(lastRow, 1, 1, CV_NCOLS_OP).setValues([fila]);
    sheet.getRange(lastRow, COL_CV_OP.PRECIO_UNIT_PROV, 1, 3).setNumberFormat('#,##0.00');
    sheet.getRange(lastRow, 1, 1, CV_NCOLS_OP).setBackground('#FFF3E0');
  }

  Logger.log('✅ PDF proveedor ' + parsed.num_factura + ': ' + parsed.items.length + ' ítems');
  return parsed.items.length;
}

// ═══════════════════════════════════════════════════════════════
//  PROCESAR FACTURA EMITIDA — mismo flujo que RP
// ═══════════════════════════════════════════════════════════════

function _procesarFacturaEmitida(pdfB64, pdfBytes, fileName, fechaEmail) {
  var cfg    = _getConfig();
  var parsed = _claudeParsePdfFactura(pdfB64, 'application/pdf', 'emitida', cfg, null);
  if (!parsed) { Logger.log('Claude no extrajo factura emitida'); return 0; }

  var driveUrl   = _guardarPdfEnDrive(pdfBytes, 'Emitida_' + (parsed.num_factura||'SN') + '_' + fileName, cfg);
  var vinculados = _matchFacturaEmitidaConItems(parsed, driveUrl);
  return vinculados;
}

// ═══════════════════════════════════════════════════════════════
//  MATCHING — Factura emitida ↔ ítems pendientes
// ═══════════════════════════════════════════════════════════════

function _matchFacturaEmitidaConItems(parsedEmitida, driveUrlEmitida) {
  var cfg  = _getConfig();
  var ss   = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_CV_OP);
  if (!sheet) return 0;

  var data       = sheet.getDataRange().getValues();
  var pendientes = [];

  for (var i = 2; i < data.length; i++) {
    var estado = String(data[i][COL_CV_OP.ESTADO - 1]            || '').trim();
    var fac    = String(data[i][COL_CV_OP.NUM_FAC_EMITIDA - 1]   || '').trim();
    if ((estado === 'pendiente' || estado === 'inventario') && !fac) {
      pendientes.push({
        row:         i + 1,
        id:          data[i][COL_CV_OP.ID_ITEM - 1],
        codigo:      data[i][COL_CV_OP.CODIGO_PROD - 1]      || '',
        descripcion: data[i][COL_CV_OP.DESCRIPCION_PROD - 1] || '',
        fecha:       data[i][COL_CV_OP.FECHA_COMPRA - 1]     || '',
        total:       parseFloat(data[i][COL_CV_OP.TOTAL_PROV - 1] || '0') || 0,
      });
    }
  }

  if (!pendientes.length || !parsedEmitida.items || !parsedEmitida.items.length) return 0;

  var confianzaMin = parseInt(cfg.confianza_minima || '70', 10);
  var matchResult  = _claudeMatchItems(parsedEmitida, pendientes, cfg);
  if (!matchResult || !matchResult.matches || !matchResult.matches.length) return 0;

  var vinculados = 0;

  for (var k = 0; k < matchResult.matches.length; k++) {
    var match = matchResult.matches[k];
    if (typeof match.idx_carbone === 'undefined' || typeof match.idx_emitido === 'undefined') continue;

    var pendItem    = pendientes[match.idx_carbone];
    var itemEmitido = parsedEmitida.items[match.idx_emitido];
    if (!pendItem || !itemEmitido) continue;

    var confianza   = parseInt(match.confianza || '0') || 0;
    var flagRev     = confianza < confianzaMin;
    var totalVenta  = parseFloat(match.total_venta_asignado  || itemEmitido.total_item || '0') || 0;
    var itbmsVenta  = parseFloat(match.itbms_venta_asignado  || itemEmitido.itbms      || '0') || 0;
    var precioVenta = totalVenta > 0 ? parseFloat((totalVenta - itbmsVenta).toFixed(2)) : 0;
    var margen      = totalVenta > 0 ? parseFloat((totalVenta - pendItem.total).toFixed(2)) : '';
    var nuevoEstado = flagRev ? 'pendiente' : 'facturado';

    sheet.getRange(pendItem.row, COL_CV_OP.ESTADO).setValue(nuevoEstado);
    sheet.getRange(pendItem.row, COL_CV_OP.CONFIANZA_MATCH).setValue(confianza);
    sheet.getRange(pendItem.row, COL_CV_OP.FLAG_REVISION).setValue(flagRev);
    sheet.getRange(pendItem.row, COL_CV_OP.FECHA_VENTA).setValue(parsedEmitida.fecha_emision   || '');
    sheet.getRange(pendItem.row, COL_CV_OP.NUM_FAC_EMITIDA).setValue(parsedEmitida.num_factura || '');
    sheet.getRange(pendItem.row, COL_CV_OP.NOMBRE_CLIENTE).setValue(parsedEmitida.nombre_cliente || '');
    sheet.getRange(pendItem.row, COL_CV_OP.RUC_CLIENTE).setValue(parsedEmitida.ruc_cliente      || '');
    sheet.getRange(pendItem.row, COL_CV_OP.DV_CLIENTE).setValue(parsedEmitida.dv_cliente        || '');
    sheet.getRange(pendItem.row, COL_CV_OP.PRECIO_VENTA).setValue(precioVenta || '');
    sheet.getRange(pendItem.row, COL_CV_OP.ITBMS_VENTA).setValue(itbmsVenta   || '');
    sheet.getRange(pendItem.row, COL_CV_OP.TOTAL_VENTA).setValue(totalVenta   || '');
    sheet.getRange(pendItem.row, COL_CV_OP.MARGEN).setValue(margen);
    sheet.getRange(pendItem.row, COL_CV_OP.DRIVE_URL_EMIT).setValue(driveUrlEmitida);

    var notaActual = String(sheet.getRange(pendItem.row, COL_CV_OP.NOTAS).getValue() || '');
    sheet.getRange(pendItem.row, COL_CV_OP.NOTAS).setValue(
      notaActual + ' | Match IA: ' + (match.razon || '') + ' (' + confianza + '%)'
    );
    sheet.getRange(pendItem.row, 1, 1, CV_NCOLS_OP).setBackground(flagRev ? '#FFF9C4' : '#E3F2FD');
    vinculados++;
  }
  return vinculados;
}

// ═══════════════════════════════════════════════════════════════
//  CERRAR CICLO → INGRESO + EGRESO
// ═══════════════════════════════════════════════════════════════

function _intentarCerrarCiclo(rowNum, sheet, pagoCtx) {
  var cfg      = _getConfig();
  var provBase = _getProveedorBase();
  var rowData  = sheet.getRange(rowNum, 1, 1, CV_NCOLS_OP).getValues()[0];
  var guardCell = sheet.getRange(rowNum, COL_CV_OP.INGRESO_ID);
  if (guardCell.getValue()) return null;

  var totalVenta    = parseFloat(rowData[COL_CV_OP.TOTAL_VENTA - 1]    || '0') || 0;
  var numFacEmitida = String(rowData[COL_CV_OP.NUM_FAC_EMITIDA - 1]    || '');
  var nombreCli     = String(rowData[COL_CV_OP.NOMBRE_CLIENTE - 1]     || '');
  if (!numFacEmitida || !nombreCli || !totalVenta) return null;

  var driveUrlEmit = (pagoCtx && pagoCtx.drive_url_pago)
    ? pagoCtx.drive_url_pago
    : String(rowData[COL_CV_OP.DRIVE_URL_EMIT - 1] || '');
  var formaPago = (pagoCtx && pagoCtx.forma_pago) ? pagoCtx.forma_pago : 'Factura';

  // ── 1. Crear Ingreso ──
  var esVentaDirecta = numFacEmitida === 'VENTA-DIRECTA';
  var itbmsRate = parseFloat(cfg.itbms_rate || '0.07');
  var subtotal  = parseFloat((totalVenta / (1 + itbmsRate)).toFixed(2));
  var itbms     = parseFloat((totalVenta - subtotal).toFixed(2));
  var fechaVenta = rowData[COL_CV_OP.FECHA_VENTA - 1];
  if (fechaVenta instanceof Date) {
    fechaVenta = Utilities.formatDate(fechaVenta, 'America/Panama', 'yyyy-MM-dd');
  } else {
    fechaVenta = String(fechaVenta || '').slice(0, 10);
  }

  var ahora    = new Date();
  var fechaReg = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
  var prefijo  = cfg.prefijo_id || 'RP';

  // Correlativo ingreso
  var ss       = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
  var sheetIng = ss.getSheetByName(SHEET_INGRESOS);
  if (!sheetIng) throw new Error('Hoja Ingresos no encontrada');

  var seqIng   = 1;
  var lastIngRow = sheetIng.getLastRow();
  if (lastIngRow > 2) {
    var idsIng = sheetIng.getRange(3, COL_I.ID_TRANS, lastIngRow - 2, 1).getValues();
    for (var ki = idsIng.length - 1; ki >= 0; ki--) {
      var parts = String(idsIng[ki][0] || '').split('-');
      var ni    = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(ni)) { seqIng = ni + 1; break; }
    }
  }
  var ingresoId = 'ING-' + prefijo + '-' + new Date().getFullYear() + '-' +
                  String(seqIng).padStart(4, '0');

  var filaIng = _filaVacia(INGRESOS_NCOLS);
  filaIng[COL_I.ID_TRANS - 1]      = ingresoId;
  filaIng[COL_I.FECHA_REG - 1]     = fechaReg;
  filaIng[COL_I.ESTADO - 1]        = 'confirmado';
  filaIng[COL_I.CONFIANZA_IA - 1]  = 'operaciones';
  filaIng[COL_I.FECHA_INGRESO - 1] = fechaVenta;
  filaIng[COL_I.MES - 1]           = new Date((fechaVenta || ahora.toISOString().slice(0,10)) + 'T12:00:00').getMonth() + 1;
  filaIng[COL_I.ANIO_FISCAL - 1]   = new Date((fechaVenta || ahora.toISOString().slice(0,10)) + 'T12:00:00').getFullYear();
  filaIng[COL_I.SUBTOTAL - 1]      = subtotal;
  filaIng[COL_I.ITBMS - 1]         = itbms;
  filaIng[COL_I.TOTAL - 1]         = totalVenta;
  filaIng[COL_I.MONEDA - 1]        = 'USD';
  filaIng[COL_I.TIPO_INGRESO - 1]  = 'venta_producto';
  filaIng[COL_I.CATEGORIA - 1]     = 'venta_producto_gravado';
  filaIng[COL_I.NOMBRE_CLI - 1]    = nombreCli;
  filaIng[COL_I.RUC_CLI - 1]       = rowData[COL_CV_OP.RUC_CLIENTE - 1] || '';
  filaIng[COL_I.TIPO_PERSONA - 1]  = detectarTipoPersona(String(rowData[COL_CV_OP.RUC_CLIENTE - 1] || ''));
  filaIng[COL_I.NUM_FACTURA - 1]   = numFacEmitida;
  filaIng[COL_I.TIPO_COMP - 1]     = esVentaDirecta ? 'venta_directa' : 'factura_emitida';
  filaIng[COL_I.DRIVE_URL - 1]     = driveUrlEmit;
  filaIng[COL_I.DESCRIPCION - 1]   = String(rowData[COL_CV_OP.DESCRIPCION_PROD - 1] || '');
  filaIng[COL_I.NOTAS_INT - 1]     = 'CV: ' + String(rowData[COL_CV_OP.ID_ITEM - 1] || '') +
                                      ' | ' + formaPago;
  filaIng[COL_I.DV_CLI - 1]        = rowData[COL_CV_OP.DV_CLIENTE - 1] || '';

  var newIngRow = sheetIng.getLastRow() + 1;
  sheetIng.getRange(newIngRow, 1, 1, INGRESOS_NCOLS).setValues([filaIng]);
  sheetIng.getRange(newIngRow, COL_I.SUBTOTAL, 1, 3).setNumberFormat('#,##0.00');
  sheetIng.getRange(newIngRow, 1, 1, INGRESOS_NCOLS).setBackground('#F1F8E9');

  guardCell.setValue(ingresoId);
  sheet.getRange(rowNum, COL_CV_OP.ESTADO).setValue('cerrado');
  sheet.getRange(rowNum, 1, 1, CV_NCOLS_OP).setBackground('#F1F8E9');
  Logger.log('✅ Ciclo cerrado: ' + rowData[COL_CV_OP.ID_ITEM - 1] + ' → Ingreso: ' + ingresoId);

  // ── 2. Crear Egreso costo_mercancia ──
  var egresoId = null;
  try {
    var idItem = String(rowData[COL_CV_OP.ID_ITEM - 1] || '');
    if (!idItem) return { ingresoId: ingresoId, egresoId: null };

    var sheetEgr = ss.getSheetByName(SHEET_EGRESOS);
    if (!sheetEgr) { Logger.log('⚠️  Hoja Egresos no encontrada'); return { ingresoId: ingresoId, egresoId: null }; }

    // Guard duplicado por id_item
    var lastEgrRow = sheetEgr.getLastRow();
    if (lastEgrRow > 2) {
      var existingEgr = sheetEgr.getRange(3, 1, lastEgrRow - 2, EGRESOS_NCOLS).getValues();
      for (var d = 0; d < existingEgr.length; d++) {
        if (String(existingEgr[d][COL_E.ID_ITEM_CV - 1] || '') === idItem) {
          Logger.log('ℹ️  Egreso ya existe para ítem ' + idItem);
          return { ingresoId: ingresoId, egresoId: String(existingEgr[d][COL_E.ID - 1] || '') };
        }
      }
    }

    var totalProv    = parseFloat(rowData[COL_CV_OP.TOTAL_PROV - 1]  || '0') || 0;
    var itbmsProv    = parseFloat(rowData[COL_CV_OP.ITBMS_PROV - 1]  || '0') || 0;
    var subtotalProv = totalProv > 0
      ? (itbmsProv > 0 ? parseFloat((totalProv - itbmsProv).toFixed(2)) : parseFloat((totalProv / (1 + itbmsRate)).toFixed(2)))
      : 0;
    if (!itbmsProv && totalProv > 0) itbmsProv = parseFloat((totalProv - subtotalProv).toFixed(2));

    var fechaCompra = rowData[COL_CV_OP.FECHA_COMPRA - 1];
    if (fechaCompra instanceof Date) {
      fechaCompra = Utilities.formatDate(fechaCompra, 'America/Panama', 'yyyy-MM-dd');
    } else {
      fechaCompra = String(fechaCompra || '').slice(0, 10);
    }
    var yearEgr = fechaCompra ? new Date(fechaCompra + 'T12:00:00').getFullYear() : ahora.getFullYear();

    var seqEgr = 1;
    lastEgrRow = sheetEgr.getLastRow();
    if (lastEgrRow > 2) {
      var idsEgr = sheetEgr.getRange(3, COL_E.ID, lastEgrRow - 2, 1).getValues();
      for (var ke = idsEgr.length - 1; ke >= 0; ke--) {
        var ve    = String(idsEgr[ke][0] || '');
        var ptsE  = ve.split('-');
        var ne    = parseInt(ptsE[ptsE.length - 1], 10);
        if (!isNaN(ne)) { seqEgr = ne + 1; break; }
      }
    }
    egresoId = 'EGR-' + prefijo + '-' + yearEgr + '-' + String(seqEgr).padStart(4, '0');

    var filaEgr = _filaVacia(EGRESOS_NCOLS);
    filaEgr[COL_E.ID - 1]          = egresoId;
    filaEgr[COL_E.FECHA_REG - 1]   = fechaReg;
    filaEgr[COL_E.ESTADO - 1]      = 'registrado';
    filaEgr[COL_E.FECHA_GASTO - 1] = fechaCompra || Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd');
    filaEgr[COL_E.MES - 1]         = new Date((fechaCompra||'2000-01-01') + 'T12:00:00').getMonth() + 1;
    filaEgr[COL_E.ANIO - 1]        = yearEgr;
    filaEgr[COL_E.SUBTOTAL - 1]    = subtotalProv || '';
    filaEgr[COL_E.ITBMS - 1]       = itbmsProv    || '';
    filaEgr[COL_E.TOTAL - 1]       = totalProv    || '';
    filaEgr[COL_E.MONEDA - 1]      = 'USD';
    filaEgr[COL_E.TIPO_EGRESO - 1] = 'costo_mercancia';
    filaEgr[COL_E.CATEGORIA - 1]   = 'costo_mercancia';
    filaEgr[COL_E.PROVEEDOR - 1]   = provBase ? provBase.nombre : '';
    filaEgr[COL_E.RUC_PROV - 1]    = provBase ? provBase.ruc    : '';
    filaEgr[COL_E.DV_PROV - 1]     = provBase ? provBase.dv     : '';
    filaEgr[COL_E.NFACTURA - 1]    = String(rowData[COL_CV_OP.NUM_FAC_PROVEEDOR - 1] || '');
    filaEgr[COL_E.ID_ITEM_CV - 1]  = idItem;
    filaEgr[COL_E.DRIVE_URL - 1]   = String(rowData[COL_CV_OP.DRIVE_URL_PROV - 1] || '');
    filaEgr[COL_E.DESCRIPCION - 1] = String(rowData[COL_CV_OP.DESCRIPCION_PROD - 1] || '');
    filaEgr[COL_E.NOTAS - 1]       = 'Costo venta · Fac emitida: ' + numFacEmitida +
                                      ' · Cliente: ' + nombreCli +
                                      ' · Ingreso: ' + ingresoId;

    var newEgrRow = sheetEgr.getLastRow() + 1;
    sheetEgr.getRange(newEgrRow, 1, 1, EGRESOS_NCOLS).setValues([filaEgr]);
    sheetEgr.getRange(newEgrRow, COL_E.SUBTOTAL, 1, 3).setNumberFormat('#,##0.00');
    sheetEgr.getRange(newEgrRow, 1, 1, EGRESOS_NCOLS).setBackground('#FFF3E0');
    Logger.log('✅ Egreso: ' + egresoId + ' | $' + totalProv);

  } catch(egrErr) {
    Logger.log('⚠️  Error creando egreso: ' + egrErr.message);
  }

  return { ingresoId: ingresoId, egresoId: egresoId };
}

// ═══════════════════════════════════════════════════════════════
//  HANDLERS RESTANTES (misma lógica que RP, datos dinámicos)
// ═══════════════════════════════════════════════════════════════

function _handleGetComprasVentas(params, callback) {
  var result = { success: false, items: [], error: null };
  try {
    var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_CV_OP);
    if (!sheet) throw new Error('Hoja Compras_Ventas no encontrada');
    var lastRow = sheet.getLastRow();
    if (lastRow <= 2) { result.success = true; return _jsonp(result, callback); }
    var data  = sheet.getRange(3, 1, lastRow - 2, CV_NCOLS_OP).getValues();
    var items = [];
    for (var i = 0; i < data.length; i++) {
      var r = data[i];
      if (!r[COL_CV_OP.ID_ITEM - 1]) continue;
      items.push({
        id_item:           r[COL_CV_OP.ID_ITEM - 1],
        fecha_reg:         r[COL_CV_OP.FECHA_REG - 1],
        estado:            r[COL_CV_OP.ESTADO - 1],
        fuente:            r[COL_CV_OP.FUENTE - 1],
        confianza_match:   r[COL_CV_OP.CONFIANZA_MATCH - 1],
        flag_revision:     r[COL_CV_OP.FLAG_REVISION - 1],
        fecha_compra:      r[COL_CV_OP.FECHA_COMPRA - 1],
        num_fac_carbone:   r[COL_CV_OP.NUM_FAC_PROVEEDOR - 1],  // alias para compatibilidad con frontend RP
        codigo_prod:       r[COL_CV_OP.CODIGO_PROD - 1],
        descripcion_prod:  r[COL_CV_OP.DESCRIPCION_PROD - 1],
        precio_unit_carb:  r[COL_CV_OP.PRECIO_UNIT_PROV - 1],
        itbms_carbone:     r[COL_CV_OP.ITBMS_PROV - 1],
        total_carbone:     r[COL_CV_OP.TOTAL_PROV - 1],
        fecha_venta:       r[COL_CV_OP.FECHA_VENTA - 1],
        num_fac_emitida:   r[COL_CV_OP.NUM_FAC_EMITIDA - 1],
        nombre_cliente:    r[COL_CV_OP.NOMBRE_CLIENTE - 1],
        ruc_cliente:       r[COL_CV_OP.RUC_CLIENTE - 1],
        dv_cliente:        r[COL_CV_OP.DV_CLIENTE - 1],
        precio_venta:      r[COL_CV_OP.PRECIO_VENTA - 1],
        itbms_venta:       r[COL_CV_OP.ITBMS_VENTA - 1],
        total_venta:       r[COL_CV_OP.TOTAL_VENTA - 1],
        margen:            r[COL_CV_OP.MARGEN - 1],
        id_orden_web:      r[COL_CV_OP.ID_ORDEN_WEB - 1],
        drive_url_carb:    r[COL_CV_OP.DRIVE_URL_PROV - 1],
        drive_url_emit:    r[COL_CV_OP.DRIVE_URL_EMIT - 1],
        notas:             r[COL_CV_OP.NOTAS - 1],
        ingreso_id:        r[COL_CV_OP.INGRESO_ID - 1],
        cantidad:          r[COL_CV_OP.CANTIDAD - 1] || 1,
        _row:              i + 3,
      });
    }
    result.success = true;
    result.items   = items;
  } catch(err) { result.error = err.message; }
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
    var data = sheet.getDataRange().getValues();
    for (var i = 2; i < data.length; i++) {
      if (String(data[i][COL_CV_OP.ID_ITEM - 1]) === String(idItem)) {
        sheet.getRange(i + 1, COL_CV_OP.FLAG_REVISION).setValue(false);
        sheet.getRange(i + 1, COL_CV_OP.ESTADO).setValue('facturado');
        sheet.getRange(i + 1, 1, 1, CV_NCOLS_OP).setBackground('#E3F2FD');
        result.success = true;
        return _jsonp(result, callback);
      }
    }
    throw new Error('Item no encontrado: ' + idItem);
  } catch(err) { result.error = err.message; }
  return _jsonp(result, callback);
}

function _handleRegistrarPagoOperacion(data) {
  var result = { success: false, ingresoId: null, error: null };
  try {
    var idItem    = data.id_item    || '';
    var formaPago = data.forma_pago || '';
    var driveUrl  = data.driveUrl   || '';
    if (!idItem) throw new Error('id_item requerido');

    var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_CV_OP);
    if (!sheet) throw new Error('Hoja CV no encontrada');

    // Subir comprobante a Drive si viene base64
    if (data.imageBase64 && data.imageName) {
      try {
        var cfg    = _getConfig();
        var folder = DriveApp.getFolderById(cfg.drive_folder_id);
        var mime   = data.imageMime || 'image/jpeg';
        var bytes  = Utilities.base64Decode(data.imageBase64);
        var blob   = Utilities.newBlob(bytes, mime, data.imageName);
        var file   = folder.createFile(blob);
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        driveUrl = 'https://drive.google.com/file/d/' + file.getId() + '/view';
      } catch(drErr) { Logger.log('⚠️  Error subiendo comprobante: ' + drErr.message); }
    }

    var rows  = sheet.getDataRange().getValues();
    var found = false;
    for (var i = 2; i < rows.length; i++) {
      if (String(rows[i][COL_CV_OP.ID_ITEM - 1]) !== idItem) continue;
      var estado = String(rows[i][COL_CV_OP.ESTADO - 1] || '').trim();
      if (estado !== 'facturado') throw new Error('Ítem no está en estado "facturado". Estado: ' + estado);
      if (String(rows[i][COL_CV_OP.INGRESO_ID - 1] || '').trim()) throw new Error('Ítem ya tiene ingreso registrado');

      var rowNum = i + 1;
      if (driveUrl)  sheet.getRange(rowNum, COL_CV_OP.DRIVE_URL_EMIT).setValue(driveUrl);
      if (formaPago) {
        var nota = String(rows[i][COL_CV_OP.NOTAS - 1] || '');
        sheet.getRange(rowNum, COL_CV_OP.NOTAS).setValue(nota + ' | Pago: ' + formaPago);
      }
      SpreadsheetApp.flush();
      _intentarCerrarCiclo(rowNum, sheet, { forma_pago: formaPago, drive_url_pago: driveUrl });
      SpreadsheetApp.flush();
      result.ingresoId = String(sheet.getRange(rowNum, COL_CV_OP.INGRESO_ID).getValue() || '');
      result.success = true;
      found = true;
      break;
    }
    if (!found) throw new Error('Ítem no encontrado: ' + idItem);
  } catch(err) { result.error = err.message; Logger.log('Error registrarPago: ' + err.message); }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function _handleRegistrarVentaDirecta(params, callback) {
  var result = { success: false, error: null };
  try {
    var data = {
      id_item:        params.id_item    || '',
      nombre_cliente: params.nombre     || '',
      ruc_cliente:    params.ruc        || '',
      dv_cliente:     params.dv         || '',
      total_venta:    parseFloat(params.total || '0') || 0,
      fecha_venta:    params.fecha      || '',
      notas:          params.notas      || '',
      forma_pago:     params.forma_pago || '',
      drive_url_pago: params.driveUrl   || '',
    };
    _registrarVentaDirecta(data);
    result.success = true;
  } catch(err) { result.error = err.message; }
  return _jsonp(result, callback);
}

function _registrarVentaDirecta(data) {
  var cfg   = _getConfig();
  var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_CV_OP);
  if (!sheet) throw new Error('Hoja CV no encontrada');
  var ahora    = new Date();
  var fechaReg = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');

  if (data.id_item) {
    var rows = sheet.getDataRange().getValues();
    for (var i = 2; i < rows.length; i++) {
      if (String(rows[i][COL_CV_OP.ID_ITEM - 1]) !== String(data.id_item)) continue;
      var rowNum    = i + 1;
      var totalProv = parseFloat(rows[i][COL_CV_OP.TOTAL_PROV - 1] || '0') || 0;
      sheet.getRange(rowNum, COL_CV_OP.FECHA_VENTA).setValue(data.fecha_venta || fechaReg.slice(0,10));
      sheet.getRange(rowNum, COL_CV_OP.NOMBRE_CLIENTE).setValue(data.nombre_cliente);
      sheet.getRange(rowNum, COL_CV_OP.RUC_CLIENTE).setValue(data.ruc_cliente || '');
      sheet.getRange(rowNum, COL_CV_OP.DV_CLIENTE).setValue(data.dv_cliente   || '');
      sheet.getRange(rowNum, COL_CV_OP.TOTAL_VENTA).setValue(data.total_venta);
      sheet.getRange(rowNum, COL_CV_OP.ITBMS_VENTA).setValue(0);
      sheet.getRange(rowNum, COL_CV_OP.PRECIO_VENTA).setValue(data.total_venta);
      sheet.getRange(rowNum, COL_CV_OP.MARGEN).setValue(data.total_venta - totalProv);
      sheet.getRange(rowNum, COL_CV_OP.NUM_FAC_EMITIDA).setValue('VENTA-DIRECTA');
      sheet.getRange(rowNum, COL_CV_OP.ESTADO).setValue('facturado');
      if (data.drive_url_pago) sheet.getRange(rowNum, COL_CV_OP.DRIVE_URL_EMIT).setValue(data.drive_url_pago);
      sheet.getRange(rowNum, 1, 1, CV_NCOLS_OP).setBackground('#E3F2FD');
      _intentarCerrarCiclo(rowNum, sheet, { forma_pago: data.forma_pago, drive_url_pago: data.drive_url_pago });
      return;
    }
    throw new Error('Item no encontrado: ' + data.id_item);
  }
}

function _handleMarcarCostoOperativo(params, callback) {
  var result = { success: false, egresoId: null, error: null };
  try {
    var idItem    = params.id_item   || '';
    var categoria = params.categoria || 'otros_deducibles';
    if (!idItem) throw new Error('id_item requerido');

    var cfg      = _getConfig();
    var provBase = _getProveedorBase();
    var ss       = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
    var sheet    = ss.getSheetByName(SHEET_CV_OP);
    if (!sheet) throw new Error('Hoja CV no encontrada');

    var data  = sheet.getDataRange().getValues();
    for (var i = 2; i < data.length; i++) {
      if (String(data[i][COL_CV_OP.ID_ITEM - 1]) !== idItem) continue;
      var estado = String(data[i][COL_CV_OP.ESTADO - 1] || '').trim();
      if (estado !== 'pendiente') throw new Error('Solo ítems pendientes. Estado: ' + estado);

      var rowNum     = i + 1;
      var totalProv  = parseFloat(data[i][COL_CV_OP.TOTAL_PROV - 1]  || '0') || 0;
      var itbmsProv  = parseFloat(data[i][COL_CV_OP.ITBMS_PROV - 1]  || '0') || 0;
      var itbmsRate  = parseFloat(cfg.itbms_rate || '0.07');
      var subtotal   = totalProv > 0
        ? (itbmsProv > 0 ? parseFloat((totalProv - itbmsProv).toFixed(2))
                         : parseFloat((totalProv / (1 + itbmsRate)).toFixed(2)))
        : 0;

      var fechaCompra = data[i][COL_CV_OP.FECHA_COMPRA - 1];
      if (fechaCompra instanceof Date) fechaCompra = Utilities.formatDate(fechaCompra, 'America/Panama', 'yyyy-MM-dd');
      else fechaCompra = String(fechaCompra || '').slice(0, 10);

      var ahora    = new Date();
      var yearEgr  = fechaCompra ? new Date(fechaCompra + 'T12:00:00').getFullYear() : ahora.getFullYear();
      var prefijo  = cfg.prefijo_id || 'RP';

      var sheetEgr   = ss.getSheetByName(SHEET_EGRESOS);
      if (!sheetEgr) throw new Error('Hoja Egresos no encontrada');
      var seqEgr     = 1;
      var lastEgrRow = sheetEgr.getLastRow();
      if (lastEgrRow > 2) {
        var idsEgr = sheetEgr.getRange(3, COL_E.ID, lastEgrRow - 2, 1).getValues();
        for (var ke = idsEgr.length - 1; ke >= 0; ke--) {
          var ptsE = String(idsEgr[ke][0] || '').split('-');
          var ne   = parseInt(ptsE[ptsE.length - 1], 10);
          if (!isNaN(ne)) { seqEgr = ne + 1; break; }
        }
      }
      var egresoId = 'EGR-' + prefijo + '-' + yearEgr + '-' + String(seqEgr).padStart(4, '0');

      var filaEgr = _filaVacia(EGRESOS_NCOLS);
      filaEgr[COL_E.ID - 1]          = egresoId;
      filaEgr[COL_E.FECHA_REG - 1]   = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
      filaEgr[COL_E.ESTADO - 1]      = 'registrado';
      filaEgr[COL_E.FECHA_GASTO - 1] = fechaCompra || Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd');
      filaEgr[COL_E.MES - 1]         = new Date((fechaCompra||'2000-01-01') + 'T12:00:00').getMonth() + 1;
      filaEgr[COL_E.ANIO - 1]        = yearEgr;
      filaEgr[COL_E.SUBTOTAL - 1]    = subtotal   || '';
      filaEgr[COL_E.ITBMS - 1]       = itbmsProv  || '';
      filaEgr[COL_E.TOTAL - 1]       = totalProv  || '';
      filaEgr[COL_E.MONEDA - 1]      = 'USD';
      filaEgr[COL_E.TIPO_EGRESO - 1] = 'costo_operativo';
      filaEgr[COL_E.CATEGORIA - 1]   = categoria;
      filaEgr[COL_E.PROVEEDOR - 1]   = provBase ? provBase.nombre : '';
      filaEgr[COL_E.RUC_PROV - 1]    = provBase ? provBase.ruc    : '';
      filaEgr[COL_E.DV_PROV - 1]     = provBase ? provBase.dv     : '';
      filaEgr[COL_E.NFACTURA - 1]    = String(data[i][COL_CV_OP.NUM_FAC_PROVEEDOR - 1] || '');
      filaEgr[COL_E.ID_ITEM_CV - 1]  = idItem;
      filaEgr[COL_E.DRIVE_URL - 1]   = String(data[i][COL_CV_OP.DRIVE_URL_PROV - 1] || '');
      filaEgr[COL_E.DESCRIPCION - 1] = String(data[i][COL_CV_OP.DESCRIPCION_PROD - 1] || '');
      filaEgr[COL_E.NOTAS - 1]       = 'Costo operativo · ítem CV: ' + idItem;

      sheetEgr.getRange(sheetEgr.getLastRow() + 1, 1, 1, EGRESOS_NCOLS).setValues([filaEgr]);
      sheetEgr.getRange(sheetEgr.getLastRow(), COL_E.SUBTOTAL, 1, 3).setNumberFormat('#,##0.00');
      sheetEgr.getRange(sheetEgr.getLastRow(), 1, 1, EGRESOS_NCOLS).setBackground('#F3E5F5');

      sheet.getRange(rowNum, COL_CV_OP.ESTADO).setValue('cerrado');
      sheet.getRange(rowNum, COL_CV_OP.INGRESO_ID).setValue('OPERATIVO-' + egresoId);
      sheet.getRange(rowNum, 1, 1, CV_NCOLS_OP).setBackground('#F3E5F5');

      result.success  = true;
      result.egresoId = egresoId;
      return _jsonp(result, callback);
    }
    throw new Error('Ítem no encontrado: ' + idItem);
  } catch(err) { result.error = err.message; }
  return _jsonp(result, callback);
}

function _handleBuscarOrdenWeb(params, callback) {
  var result = { success: false, ordenNum: null, encontrado: false, error: null };
  try {
    result.success = true; result.encontrado = false;
    // No aplica en este módulo (sin hoja Ordenes) — retorna vacío sin error
  } catch(err) { result.error = err.message; }
  return _jsonp(result, callback);
}

function _handleVincularOrdenWeb(params, callback) {
  var result = { success: false, error: null };
  try {
    var idItem   = params.id_item   || '';
    var ordenNum = params.orden_num || '';
    if (!idItem) throw new Error('id_item requerido');
    var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_CV_OP);
    if (!sheet) throw new Error('Hoja CV no encontrada');
    var data = sheet.getDataRange().getValues();
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
    if (idItem && tipoFac === 'emitida') {
      _vincularFacturaEmitidaAItem(idItem, parsed, pdfB64, cfg);
    }
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
    var driveUrl = _guardarPdfEnDrive(pdfBytes, 'Emitida_Manual_' + (parsedEmitida.num_factura || idItem) + '.pdf', cfg);
    var costo    = parseFloat(data[i][COL_CV_OP.TOTAL_PROV - 1] || '0') || 0;
    var venta    = parseFloat(parsedEmitida.total || '0') || 0;
    sheet.getRange(rowNum, COL_CV_OP.FECHA_VENTA).setValue(parsedEmitida.fecha_emision   || '');
    sheet.getRange(rowNum, COL_CV_OP.NUM_FAC_EMITIDA).setValue(parsedEmitida.num_factura || '');
    sheet.getRange(rowNum, COL_CV_OP.NOMBRE_CLIENTE).setValue(parsedEmitida.nombre_cliente || '');
    sheet.getRange(rowNum, COL_CV_OP.RUC_CLIENTE).setValue(parsedEmitida.ruc_cliente      || '');
    sheet.getRange(rowNum, COL_CV_OP.DV_CLIENTE).setValue(parsedEmitida.dv_cliente        || '');
    sheet.getRange(rowNum, COL_CV_OP.TOTAL_VENTA).setValue(venta || '');
    sheet.getRange(rowNum, COL_CV_OP.ITBMS_VENTA).setValue(parsedEmitida.itbms_total     || '');
    sheet.getRange(rowNum, COL_CV_OP.PRECIO_VENTA).setValue(parsedEmitida.subtotal        || '');
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

// ═══════════════════════════════════════════════════════════════
//  CLAUDE — PARSEAR PDF (prompts dinámicos)
// ═══════════════════════════════════════════════════════════════

function _claudeParsePdfFactura(pdfB64, mimeType, tipo, cfg, provBase) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
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
    'Eres un extractor de datos de facturas electrónicas panameñas DGI emitidas por ' +
    empresaNombre + (empresaRuc ? ' (RUC ' + empresaRuc + ')' : '') + '. ' +
    'Responde SOLO con JSON válido:\n' +
    '{"num_factura":"","fecha_emision":"YYYY-MM-DD","ruc_emisor":"","nombre_emisor":"",' +
    '"nombre_cliente":"","ruc_cliente":"","dv_cliente":"","subtotal":0,"itbms_total":0,"total":0,' +
    '"forma_pago":"","items":[{"num_item":1,"codigo":"","descripcion":"","cantidad":1,' +
    '"precio_unitario":0,"descuento":0,"itbms":0,"total_item":0}]}\n' +
    'dv_cliente = dígito verificador del RUC del cliente. null si no visible. Montos como números.';

  var payload = {
    model:      'claude-sonnet-4-20250514',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: mimeType, data: pdfB64 } },
        { type: 'text', text: tipo === 'proveedor' ? promptProveedor : promptEmitida }
      ]
    }]
  };

  var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload), muteHttpExceptions: true,
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error('Claude API error ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0, 200));
  }
  var text = '';
  var content = JSON.parse(resp.getContentText()).content || [];
  for (var i = 0; i < content.length; i++) {
    if (content[i].type === 'text') { text = content[i].text; break; }
  }
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

// ═══════════════════════════════════════════════════════════════
//  CLAUDE — MATCHING ÍTEMS (igual que RP, contexto dinámico)
// ═══════════════════════════════════════════════════════════════

function _claudeMatchItems(parsedEmitida, pendientes, cfg) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY no configurada');

  var provBase    = _getProveedorBase();
  var empresaNom  = (cfg && cfg.empresa_nombre) ? cfg.empresa_nombre : 'la empresa';
  var provNom     = provBase ? provBase.nombre : 'el proveedor';

  var itemsEmitidos = JSON.stringify((parsedEmitida.items || []).map(function(it, idx) {
    return { idx: idx, codigo: it.codigo||'', descripcion: it.descripcion||'', cantidad: it.cantidad||1, total_item: it.total_item||0, itbms: it.itbms||0 };
  }), null, 2);

  var itemsProveedor = JSON.stringify(pendientes.map(function(p, idx) {
    return { idx: idx, id: p.id, codigo: p.codigo||'', descripcion: p.descripcion||'', costo_total: p.total, fecha_compra: p.fecha };
  }), null, 2);

  var prompt =
    'Sistema de matching de facturas para ' + empresaNom + '.\n\n' +
    'La empresa compra productos a ' + provNom + ' y los revende a clientes.\n' +
    'Una factura emitida puede tener múltiples ítems con código de producto.\n\n' +
    'FACTURA EMITIDA:\nNúmero: ' + (parsedEmitida.num_factura||'') +
    '\nCliente: ' + (parsedEmitida.nombre_cliente||'') +
    '\nTotal: $' + (parsedEmitida.total||0) +
    '\nÍtems:\n' + itemsEmitidos +
    '\n\nÍTEMS PROVEEDOR PENDIENTES:\n' + itemsProveedor +
    '\n\nREGLAS:\n' +
    '1. CÓDIGO EXCLUYENTE: si el ítem emitido tiene código, debe coincidir EXACTAMENTE con el del proveedor.\n' +
    '2. UNICIDAD: cada ítem emitido matchea con UN solo ítem de proveedor y viceversa.\n' +
    '3. Si no hay código, match por similitud de descripción (mín 60% confianza).\n' +
    '4. total_venta_asignado = total_item del ítem EMITIDO.\n\n' +
    'Responde SOLO JSON:\n' +
    '{"matches":[{"idx_emitido":0,"idx_carbone":0,"confianza":95,' +
    '"razon":"mismo código","total_venta_asignado":0,"itbms_venta_asignado":0}]}';

  var payload = {
    model: 'claude-sonnet-4-20250514', max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
  };

  var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload), muteHttpExceptions: true,
  });
  if (resp.getResponseCode() !== 200) throw new Error('Claude match error: ' + resp.getResponseCode());

  var text = '';
  var content = JSON.parse(resp.getContentText()).content || [];
  for (var i = 0; i < content.length; i++) {
    if (content[i].type === 'text') { text = content[i].text; break; }
  }
  var parsed = JSON.parse(text.replace(/```json|```/g, '').trim());

  // Guard post-IA: unicidad + código excluyente
  var usedE = {}, usedC = {}, filtrados = [];
  for (var j = 0; j < (parsed.matches||[]).length; j++) {
    var m = parsed.matches[j];
    if (usedE[m.idx_emitido] || usedC[m.idx_carbone]) continue;
    var codE = (((parsedEmitida.items||[])[m.idx_emitido])||{}).codigo || '';
    var codC = ((pendientes[m.idx_carbone])||{}).codigo || '';
    if (codE && codC && codE.trim().toUpperCase() !== codC.trim().toUpperCase()) continue;
    usedE[m.idx_emitido] = true; usedC[m.idx_carbone] = true;
    filtrados.push(m);
  }
  return { matches: filtrados };
}

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════

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

function initConfigSheet() {
  var ss = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
  if (ss.getSheetByName(SHEET_CONFIG_OP)) {
    Logger.log('⚠️  Config_Operaciones ya existe.'); return;
  }
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
  Logger.log('✅ Hoja Config_Operaciones creada. Llenar desde dashboard → Configuración.');
}

function initProveedoresSheet() {
  // Proveedores_Config ya existe en el Sheet de CEYCO — no recrear.
  // Esta función verifica que la hoja exista.
  // Si la hoja no existe por alguna razón, la crea con la estructura correcta.
  var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_PROVEEDORES_OP);

  if (sheet) {
    Logger.log('✅ Proveedores_Config existe.');
    return;
  }

  // Hoja no existe — crearla desde cero
  sheet = ss.insertSheet(SHEET_PROVEEDORES_OP);
  SpreadsheetApp.flush();
  var meta    = ['ID','DATOS FISCALES','','','GMAIL','DETECCIÓN IA','','CONFIG','','ARCHIVO','NOTAS'];
  var headers = ['id_proveedor','nombre','ruc','dv','email_origen','keywords_deteccion','prompt_override','activo','fecha_alta','drive_url_ejemplo','notas','aplica_a'];
  sheet.getRange(1, 1, 1, PROV_NCOLS_OP).setValues([meta]);
  sheet.getRange(1, 1, 1, PROV_NCOLS_OP).setBackground('#37474F').setFontColor('#FFF').setFontWeight('bold');
  sheet.getRange(2, 1, 1, PROV_NCOLS_OP).setValues([headers]);
  sheet.getRange(2, 1, 1, PROV_NCOLS_OP).setBackground('#546E7A').setFontColor('#FFF').setFontWeight('bold');
  sheet.setFrozenRows(2);
  Logger.log('✅ Hoja Proveedores_Config creada desde cero.');
}

function initComprasVentasSheet() {
  var ss = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
  if (ss.getSheetByName(SHEET_CV_OP)) {
    Logger.log('⚠️  Compras_Ventas ya existe.'); return;
  }
  var sheet = ss.insertSheet(SHEET_CV_OP);
  SpreadsheetApp.flush();

  var meta = [
    'ID','REGISTRO','ESTADO','FUENTE','MATCH','',
    'COMPRA (Proveedor)','','','','','','',
    'VENTA (Factura emitida)','','','','','','','','',
    'VÍNCULOS','','','','','CANT',
  ];
  var headers = [
    'id_item','fecha_registro','estado','fuente','confianza_match','flag_revision',
    'fecha_compra','num_factura_proveedor','codigo_producto','descripcion_producto',
    'precio_unit_proveedor','itbms_proveedor','total_proveedor',
    'fecha_venta','num_factura_emitida','nombre_cliente','ruc_cliente','dv_cliente',
    'precio_venta','itbms_venta','total_venta','margen',
    'id_orden_web','drive_url_proveedor','drive_url_emitida','notas','ingreso_id','cantidad',
  ];
  sheet.getRange(1, 1, 1, CV_NCOLS_OP).setValues([meta]);
  sheet.getRange(1, 1, 1, CV_NCOLS_OP).setBackground('#37474F').setFontColor('#FFF').setFontWeight('bold');
  sheet.getRange(2, 1, 1, CV_NCOLS_OP).setValues([headers]);
  sheet.getRange(2, 1, 1, CV_NCOLS_OP).setBackground('#546E7A').setFontColor('#FFF').setFontWeight('bold');
  sheet.getRange(1, 7, 1, 7).setBackground('#E65100');
  sheet.getRange(1, 14, 1, 9).setBackground('#1B5E20');
  sheet.setFrozenRows(2);

  var ruleEstado = SpreadsheetApp.newDataValidation()
    .requireValueInList(['pendiente','inventario','vinculado','facturado','cerrado'], true)
    .setAllowInvalid(false).build();
  sheet.getRange('C3:C1000').setDataValidation(ruleEstado);

  var w = [160,140,100,120,80,80,100,160,110,280,110,90,90,100,160,160,110,60,80,80,90,90,130,220,220,260,150,70];
  for (var i = 0; i < w.length; i++) sheet.setColumnWidth(i + 1, w[i]);
  sheet.getRange('K3:M1000').setNumberFormat('#,##0.00');
  sheet.getRange('S3:W1000').setNumberFormat('#,##0.00');
  Logger.log('✅ Hoja Compras_Ventas creada.');
}

function verificarSetupOperaciones() {
  Logger.log('🔍 Verificando setup Operaciones...');
  var ss  = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
  var cfg = _getConfig();
  Logger.log('📋 Config:');
  Logger.log('  empresa_nombre:     ' + cfg.empresa_nombre);
  Logger.log('  empresa_ruc:        ' + (cfg.empresa_ruc || '⚠️  VACÍO'));
  Logger.log('  email_comprobantes: ' + (cfg.email_comprobantes || '⚠️  VACÍO'));
  Logger.log('  drive_folder_id:    ' + (cfg.drive_folder_id || '⚠️  VACÍO'));
  Logger.log('  prefijo_id:         ' + cfg.prefijo_id);
  Logger.log('  confianza_minima:   ' + cfg.confianza_minima);

  var prov = _getProveedorBase();
  if (prov) {
    Logger.log('✅ Proveedor base: ' + prov.nombre + ' | RUC: ' + prov.ruc);
  } else {
    Logger.log('⚠️  Sin proveedor base — agregar desde dashboard → Proveedores');
  }

  [SHEET_CONFIG_OP, SHEET_PROVEEDORES_OP, SHEET_CV_OP].forEach(function(n) {
    Logger.log((ss.getSheetByName(n) ? '✅' : '❌') + ' Hoja: ' + n);
  });

  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  Logger.log((apiKey ? '✅' : '❌') + ' CLAUDE_API_KEY');
}

// ═══════════════════════════════════════════════════════════════
//  _handleAnularItemCV
//  Anula un ítem de Compras_Ventas manteniendo el registro:
//    - CV: estado → 'anulado', color rojo claro
//    - Egresos: estado → 'anulado' (si existe egreso vinculado)
//    - Ingresos: estado → 'anulado' (si tiene ingreso_id)
// ═══════════════════════════════════════════════════════════════

function _handleAnularItemCV(params, callback) {
  var result = {
    success: false,
    egreso_anulado:  false,
    ingreso_anulado: false,
    error: null
  };
  try {
    var idItem = params.id_item || '';
    var motivo = params.motivo  || 'Anulado manualmente';
    if (!idItem) throw new Error('id_item requerido');

    var ss       = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
    var sheetCV  = ss.getSheetByName(SHEET_CV_OP);
    if (!sheetCV) throw new Error('Hoja Compras_Ventas no encontrada');

    var data     = sheetCV.getDataRange().getValues();
    var found    = false;

    for (var i = 2; i < data.length; i++) {
      if (String(data[i][COL_CV_OP.ID_ITEM - 1]) !== idItem) continue;

      var rowNum    = i + 1;
      var ingresoId = String(data[i][COL_CV_OP.INGRESO_ID - 1] || '').trim();
      var estadoAct = String(data[i][COL_CV_OP.ESTADO - 1] || '').trim();
      var stamp     = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm');

      // ── 1. Anular en CV ──
      // Primero ampliar la validación de la col Estado para aceptar 'anulado'
      var estadoRange = sheetCV.getRange(3, COL_CV_OP.ESTADO, 1000, 1);
      var rule = SpreadsheetApp.newDataValidation()
        .requireValueInList(['pendiente','inventario','vinculado','facturado','cerrado','anulado'], true)
        .setAllowInvalid(false)
        .build();
      estadoRange.setDataValidation(rule);

      sheetCV.getRange(rowNum, COL_CV_OP.ESTADO).setValue('anulado');
      var notaAct = String(data[i][COL_CV_OP.NOTAS - 1] || '');
      sheetCV.getRange(rowNum, COL_CV_OP.NOTAS).setValue(
        notaAct + ' | ANULADO: ' + stamp + (motivo ? ' · ' + motivo : '')
      );
      sheetCV.getRange(rowNum, 1, 1, CV_NCOLS_OP).setBackground('#FFEBEE');
      Logger.log('✅ CV anulado: ' + idItem);
      found = true;

      // ── 2. Anular egreso vinculado ──
      var sheetEgr = ss.getSheetByName(SHEET_EGRESOS);
      if (sheetEgr && sheetEgr.getLastRow() > 2) {
        var egrData = sheetEgr.getRange(3, 1, sheetEgr.getLastRow() - 2, EGRESOS_NCOLS).getValues();
        for (var e = 0; e < egrData.length; e++) {
          if (String(egrData[e][COL_E.ID_ITEM_CV - 1] || '') === idItem) {
            var eRow = e + 3;
            sheetEgr.getRange(eRow, COL_E.ESTADO).setValue('anulado');
            var notaEgr = String(egrData[e][COL_E.NOTAS - 1] || '');
            sheetEgr.getRange(eRow, COL_E.NOTAS).setValue(
              notaEgr + ' | ANULADO: ' + stamp + ' · CV: ' + idItem
            );
            sheetEgr.getRange(eRow, 1, 1, EGRESOS_NCOLS).setBackground('#FFEBEE');
            result.egreso_anulado = true;
            Logger.log('✅ Egreso anulado para ítem: ' + idItem);
          }
        }
      }

      // ── 3. Anular ingreso vinculado ──
      if (ingresoId && ingresoId.indexOf('OPERATIVO-') === -1) {
        var sheetIng = ss.getSheetByName(SHEET_INGRESOS);
        if (sheetIng && sheetIng.getLastRow() > 2) {
          var ingData = sheetIng.getRange(3, 1, sheetIng.getLastRow() - 2, INGRESOS_NCOLS).getValues();
          for (var n = 0; n < ingData.length; n++) {
            if (String(ingData[n][COL_I.ID_TRANS - 1] || '') === ingresoId) {
              var iRow = n + 3;
              sheetIng.getRange(iRow, COL_I.ESTADO).setValue('anulado');
              var notaIng = String(ingData[n][COL_I.NOTAS_INT - 1] || '');
              sheetIng.getRange(iRow, COL_I.NOTAS_INT).setValue(
                notaIng + ' | ANULADO: ' + stamp + ' · CV: ' + idItem + (motivo ? ' · ' + motivo : '')
              );
              sheetIng.getRange(iRow, 1, 1, INGRESOS_NCOLS).setBackground('#FFEBEE');
              result.ingreso_anulado = true;
              Logger.log('✅ Ingreso anulado: ' + ingresoId);
              break;
            }
          }
        }
      }
      break;
    }

    if (!found) throw new Error('Ítem no encontrado: ' + idItem);
    result.success = true;

  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleAnularItemCV: ' + err.message);
  }
  return _jsonp(result, callback);
}

// ═══════════════════════════════════════════════════════════════
//  _handleEliminarItemCV
//  Elimina permanentemente un ítem de Compras_Ventas:
//    - CV: deleteRow
//    - Egresos: deleteRow (todas las filas con id_item_cv = id_item)
//    - Ingresos: deleteRow (fila con id_transaccion = ingreso_id)
//  PRECAUCIÓN: irreversible.
// ═══════════════════════════════════════════════════════════════

function _handleEliminarItemCV(params, callback) {
  var result = {
    success:          false,
    egresos_borrados: 0,
    ingreso_borrado:  false,
    error:            null
  };
  try {
    var idItem = params.id_item || '';
    if (!idItem) throw new Error('id_item requerido');

    var ss       = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
    var sheetCV  = ss.getSheetByName(SHEET_CV_OP);
    if (!sheetCV) throw new Error('Hoja Compras_Ventas no encontrada');

    var data  = sheetCV.getDataRange().getValues();
    var found = false;
    var ingresoId = '';
    var cvRowNum  = -1;

    for (var i = 2; i < data.length; i++) {
      if (String(data[i][COL_CV_OP.ID_ITEM - 1]) !== idItem) continue;
      ingresoId = String(data[i][COL_CV_OP.INGRESO_ID - 1] || '').trim();
      cvRowNum  = i + 1;
      found     = true;
      break;
    }
    if (!found) throw new Error('Ítem no encontrado: ' + idItem);

    // ── 1. Borrar egresos vinculados (de atrás hacia adelante) ──
    var sheetEgr = ss.getSheetByName(SHEET_EGRESOS);
    if (sheetEgr && sheetEgr.getLastRow() > 2) {
      var egrData  = sheetEgr.getRange(3, 1, sheetEgr.getLastRow() - 2, EGRESOS_NCOLS).getValues();
      var egrRows  = [];
      for (var e = 0; e < egrData.length; e++) {
        if (String(egrData[e][COL_E.ID_ITEM_CV - 1] || '') === idItem) {
          egrRows.push(e + 3);
        }
      }
      // Borrar de atrás hacia adelante para no desplazar índices
      for (var er = egrRows.length - 1; er >= 0; er--) {
        sheetEgr.deleteRow(egrRows[er]);
        result.egresos_borrados++;
      }
      if (result.egresos_borrados > 0) {
        SpreadsheetApp.flush();
        Logger.log('✅ ' + result.egresos_borrados + ' egreso(s) borrado(s) para ítem: ' + idItem);
      }
    }

    // ── 2. Borrar ingreso vinculado ──
    if (ingresoId && ingresoId.indexOf('OPERATIVO-') === -1) {
      var sheetIng = ss.getSheetByName(SHEET_INGRESOS);
      if (sheetIng && sheetIng.getLastRow() > 2) {
        var ingData = sheetIng.getRange(3, 1, sheetIng.getLastRow() - 2, INGRESOS_NCOLS).getValues();
        for (var n = 0; n < ingData.length; n++) {
          if (String(ingData[n][COL_I.ID_TRANS - 1] || '') === ingresoId) {
            sheetIng.deleteRow(n + 3);
            SpreadsheetApp.flush();
            result.ingreso_borrado = true;
            Logger.log('✅ Ingreso borrado: ' + ingresoId);
            break;
          }
        }
      }
    }

    // ── 3. Borrar fila CV (al final para no perder referencias) ──
    // Re-buscar la fila por si cambió por el flush
    var dataFresh = sheetCV.getDataRange().getValues();
    for (var j = 2; j < dataFresh.length; j++) {
      if (String(dataFresh[j][COL_CV_OP.ID_ITEM - 1]) === idItem) {
        sheetCV.deleteRow(j + 1);
        SpreadsheetApp.flush();
        Logger.log('✅ CV borrado: ' + idItem);
        break;
      }
    }

    result.success = true;

  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleEliminarItemCV: ' + err.message);
  }
  return _jsonp(result, callback);
}


// ═══════════════════════════════════════════════════════════════
//  HANDLERS: Trigger Email ST — instalar / remover / estado
// ═══════════════════════════════════════════════════════════════

function _handleInstalarTriggerST(data) {
  try {
    var intervalo      = parseInt(data.intervalo || '15', 10);
    var minutosValidos = [15, 30];
    var horasValidas   = [1, 2];

    var triggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === 'procesarEmailsST') {
        ScriptApp.deleteTrigger(triggers[i]);
      }
    }
    var builder = ScriptApp.newTrigger('procesarEmailsST').timeBased();
    if (minutosValidos.indexOf(intervalo) !== -1) {
      builder.everyMinutes(intervalo).create();
    } else if (horasValidas.indexOf(intervalo) !== -1) {
      builder.everyHours(intervalo).create();
    } else {
      builder.everyMinutes(15).create();
      intervalo = 15;
    }
    var label = intervalo < 60
      ? 'cada ' + intervalo + ' minutos'
      : 'cada ' + (intervalo/60) + ' hora(s)';
    Logger.log('✅ Trigger procesarEmailsST instalado — ' + label);
    return _json({ success: true, intervalo: intervalo, mensaje: 'Trigger instalado — ' + label });
  } catch(err) {
    // GAS a veces lanza "sin destinatario" al configurar notificaciones del trigger.
    // Verificar si el trigger se creó de todas formas antes de reportar error.
    var triggers = ScriptApp.getProjectTriggers();
    for (var ei = 0; ei < triggers.length; ei++) {
      if (triggers[ei].getHandlerFunction() === 'procesarEmailsST') {
        Logger.log('⚠️ Trigger ST creado a pesar del error: ' + err.message);
        return _json({ success: true, mensaje: 'Trigger instalado (advertencia: ' + err.message + ')' });
      }
    }
    Logger.log('Error instalarTriggerST: ' + err.message);
    return _json({ success: false, error: err.message });
  }
}

function _handleRemoverTriggerST(data) {
  try {
    var triggers = ScriptApp.getProjectTriggers();
    var removidos = 0;
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === 'procesarEmailsST') {
        ScriptApp.deleteTrigger(triggers[i]);
        removidos++;
      }
    }
    Logger.log('✅ Trigger removido: ' + removidos);
    return _json({ success: true, removidos: removidos });
  } catch(err) {
    Logger.log('Error removerTriggerST: ' + err.message);
    return _json({ success: false, error: err.message });
  }
}

function _handleEstadoTriggerST(params, callback) {
  try {
    var triggers = ScriptApp.getProjectTriggers();
    var activo   = false;
    var ultimoRun = '';
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === 'procesarEmailsST') {
        activo = true;
        break;
      }
    }
    // Último run desde el Email_ST_Log
    try {
      var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
      var sheet = ss.getSheetByName('Email_ST_Log');
      if (sheet && sheet.getLastRow() > 1) {
        var lastRow = sheet.getLastRow();
        ultimoRun   = String(sheet.getRange(lastRow, 1).getValue() || '').slice(0, 16);
      }
    } catch(e) {}
    return _jsonp({ success: true, activo: activo, ultimo_run: ultimoRun }, callback);
  } catch(err) {
    return _jsonp({ success: false, activo: false, error: err.message }, callback);
  }
}

function _handleGetEmailSTLog(params, callback) {
  try {
    var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
    var sheet = ss.getSheetByName('Email_ST_Log');
    var items = [];
    if (sheet && sheet.getLastRow() > 1) {
      var numRows = Math.min(sheet.getLastRow() - 1, 10);
      var data    = sheet.getRange(sheet.getLastRow() - numRows + 1, 1, numRows, 10).getValues();
      // Invertir para mostrar más recientes primero
      data.reverse().forEach(function(r) {
        if (!r[0]) return;
        items.push({
          fecha_proc:   String(r[0] || '').slice(0, 16),
          message_id:   r[1] || '',
          asunto:       r[2] || '',
          remitente:    r[3] || '',
          id_st:        r[4] || '',
          num_adjuntos: r[5] || 0,
          estado:       r[6] || '',
          error_msg:    r[9] || '',
        });
      });
    }
    return _jsonp({ success: true, items: items }, callback);
  } catch(err) {
    return _jsonp({ success: false, items: [], error: err.message }, callback);
  }
}

// ═══════════════════════════════════════════════════════════════
//  HANDLERS: Trigger Operaciones — instalar / remover / estado
// ═══════════════════════════════════════════════════════════════

function _handleInstalarTriggerOp(data) {
  try {
    var intervalo = parseInt(data.intervalo || '30', 10);
    // Valores permitidos por GAS ScriptApp
    var minutosValidos = [15, 30];
    var horasValidas   = [1, 2];

    // Eliminar triggers previos
    var triggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === 'ejecutarSincronizacionOp') {
        ScriptApp.deleteTrigger(triggers[i]);
      }
    }

    var builder = ScriptApp.newTrigger('ejecutarSincronizacionOp').timeBased();

    if (minutosValidos.indexOf(intervalo) !== -1) {
      builder.everyMinutes(intervalo).create();
    } else if (horasValidas.indexOf(intervalo) !== -1) {
      builder.everyHours(intervalo).create();
    } else {
      // Default seguro
      builder.everyMinutes(30).create();
      intervalo = 30;
    }

    var label = intervalo < 60
      ? 'cada ' + intervalo + ' minutos'
      : 'cada ' + intervalo/60 + ' hora(s)';
    Logger.log('✅ Trigger Operaciones instalado — ' + label);
    return _json({ success: true, intervalo: intervalo, mensaje: 'Trigger instalado — ' + label });
  } catch(err) {
    // Verificar si el trigger se creó a pesar del error de notificación
    var triggers = ScriptApp.getProjectTriggers();
    for (var ei = 0; ei < triggers.length; ei++) {
      if (triggers[ei].getHandlerFunction() === 'ejecutarSincronizacionOp') {
        Logger.log('⚠️ Trigger Op creado a pesar del error: ' + err.message);
        return _json({ success: true, mensaje: 'Trigger instalado (advertencia: ' + err.message + ')' });
      }
    }
    Logger.log('Error instalarTriggerOp: ' + err.message);
    return _json({ success: false, error: err.message });
  }
}

function _handleRemoverTriggerOp(data) {
  try {
    var triggers  = ScriptApp.getProjectTriggers();
    var removidos = 0;
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === 'ejecutarSincronizacionOp') {
        ScriptApp.deleteTrigger(triggers[i]);
        removidos++;
      }
    }
    Logger.log('✅ Trigger Operaciones removido: ' + removidos);
    return _json({ success: true, removidos: removidos });
  } catch(err) {
    Logger.log('Error removerTriggerOp: ' + err.message);
    return _json({ success: false, error: err.message });
  }
}

function _handleEstadoTriggerOp(params, callback) {
  try {
    var triggers  = ScriptApp.getProjectTriggers();
    var activo    = false;
    var intervalo = '';
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === 'ejecutarSincronizacionOp') {
        activo    = true;
        // Intentar leer el intervalo del trigger
        try {
          var ev = triggers[i].getTriggerSource();
          intervalo = 'activo';
        } catch(e) {}
        break;
      }
    }
    return _jsonp({ success: true, activo: activo, intervalo: intervalo }, callback);
  } catch(err) {
    return _jsonp({ success: false, activo: false, error: err.message }, callback);
  }
}

// ═══════════════════════════════════════════════════════════════
//  setupAutorizaciones
//  Ejecutar UNA SOLA VEZ desde el IDE de GAS para autorizar
//  todos los scopes necesarios (Gmail, Drive, ScriptApp, Sheets).
//  Después de ejecutar esta función, los triggers se instalarán
//  correctamente desde el dashboard.
// ═══════════════════════════════════════════════════════════════

function setupAutorizaciones() {
  try {
    // Forzar autorización de ScriptApp (necesario para triggers)
    var triggers = ScriptApp.getProjectTriggers();
    Logger.log('✅ ScriptApp autorizado — ' + triggers.length + ' trigger(s) activo(s)');
  } catch(e) { Logger.log('❌ ScriptApp: ' + e.message); }

  try {
    // Forzar autorización de GmailApp (necesario para leer emails)
    var label = GmailApp.getUserLabelByName('st-procesado');
    Logger.log('✅ Gmail autorizado — label st-procesado: ' + (label ? 'existe' : 'no existe (créalo)'));
  } catch(e) { Logger.log('❌ Gmail: ' + e.message); }

  try {
    // Forzar autorización de SpreadsheetApp
    var ss = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
    Logger.log('✅ Sheets autorizado — ' + ss.getName());
  } catch(e) { Logger.log('❌ Sheets: ' + e.message); }

  try {
    // Forzar autorización de DriveApp
    DriveApp.getRootFolder();
    Logger.log('✅ Drive autorizado');
  } catch(e) { Logger.log('❌ Drive: ' + e.message); }

  Logger.log('');
  Logger.log('✅ setupAutorizaciones completado.');
  Logger.log('   Ahora puedes instalar triggers desde el dashboard sin errores.');
}

// ═══════════════════════════════════════════════════════════════
//  Funciones de trigger manuales — ejecutar desde el GAS IDE
//  El intervalo se lee de Config_Operaciones (guardado desde el
//  dashboard al hacer click en "Instalar trigger").
// ═══════════════════════════════════════════════════════════════

function instalarTriggerOpManual() {
  var cfg      = _getConfig();
  var intervalo = parseInt(cfg.trigger_op_intervalo || '30', 10);
  var data     = { intervalo: intervalo };
  var resultado = _handleInstalarTriggerOp(data);
  Logger.log('instalarTriggerOpManual: ' + resultado.getContent());
}

function removerTriggerOpManual() {
  var resultado = _handleRemoverTriggerOp({});
  Logger.log('removerTriggerOpManual: ' + resultado.getContent());
}

function instalarTriggerSTManual() {
  var cfg      = _getConfig();
  var intervalo = parseInt(cfg.trigger_st_intervalo || '15', 10);
  var data     = { intervalo: intervalo };
  var resultado = _handleInstalarTriggerST(data);
  Logger.log('instalarTriggerSTManual: ' + resultado.getContent());
}

function removerTriggerSTManual() {
  var resultado = _handleRemoverTriggerST({});
  Logger.log('removerTriggerSTManual: ' + resultado.getContent());
}
