// ═══════════════════════════════════════════════════════════════
//  ContaFacil_EmailST.gs  — v2.0
//  Módulo: Procesamiento automático de emails de Servicios Técnicos
//  Ramon Pico / Círculo Financiero S.A.
//
//  v2.0 — Motor unificado con el Importador Histórico:
//    - Usa _procesarDesdeBlobs() de ContaFacil_ImportarHistorial.gs
//    - Usa _wrapAttachment() para adaptar adjuntos Gmail a la
//      misma interfaz que los DriveFile del histórico
//    - Matching ítem-a-ítem (códigos CEYCO vs facturas de costo)
//    - Fallback a Inventario_Maestro
//    - Crédito fiscal ITBM para DHL/FedEx
//    - Movimientos de inventario
//    - Retry automático en Claude API
//    - Tipo venta: venta_directa | venta_inventario | mixta | warning
//    - Elimina _inferirTipoPorNombre y _parsearFacturaCosto
//      (ya definidas en ContaFacil_ImportarHistorial.gs)
//
//  FLUJO:
//    1. Ceyco reenvía email a lasnubesenchica+ceyco@gmail.com
//    2. Trigger cada 15 min ejecuta procesarEmailsST()
//    3. Por cada email no procesado (búsqueda por plus-address):
//       a. Sube adjuntos a Drive → ST_Emails/{Cliente}/{yyyy-MM}/
//       b. Crea wrappers con _wrapAttachment() para cada adjunto
//       c. Llama a _procesarDesdeBlobs() — mismo motor que histórico
//       d. Aplica label st-procesado o st-error
//    4. Trigger automático + botón manual en dashboard
//
//  SIN INTERFERENCIA con Operaciones (Compras_Ventas):
//    - Este módulo escribe en Servicios_Tecnicos, ST_Items, Egresos, Ingresos
//    - NO toca Compras_Ventas ni Config_Operaciones ni Proveedores_Config
//
//  SETUP:
//    1. Ejecutar setupEmailST()
//    2. Ejecutar installEmailSTTrigger() UNA sola vez
//    3. Crear labels Gmail: "st-procesado" y "st-error"
// ═══════════════════════════════════════════════════════════════

// ── CONFIG ESPECÍFICA DE ESTE MÓDULO ─────────────────────────
var CONFIG_ST_EMAIL = {
  // GMAIL_SEARCH_QUERY se construye dinámicamente desde Config_Operaciones
  // usando _getEmailSTQuery() — no hardcodeado aquí
  GMAIL_LABEL_PROCESADO: 'st-procesado',
  GMAIL_LABEL_ERROR:     'st-error',
  CEYCO_RUC:             '2470636-1-814806',
  DRIVE_SUBFOLDER_ST:    'ST_Emails',
  SHEET_EMAIL_LOG:       'Email_ST_Log',
  EMAIL_LOG_NCOLS:       10,
  EMAIL_ST_DEFAULT:      'lasnubesenchica+ceyco@gmail.com',  // fallback si no hay config
};

// ── Obtener el email de entrada ST desde Config_Operaciones ───
// Si no está configurado, usa el default hardcodeado como fallback.
function _getEmailSTQuery() {
  try {
    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName('Config_Operaciones');
    if (sheet) {
      var data = sheet.getDataRange().getValues();
      for (var i = 1; i < data.length; i++) {
        if (String(data[i][0] || '').trim() === 'email_st_entrante') {
          var email = String(data[i][1] || '').trim();
          if (email) return 'to:' + email + ' is:unread';
        }
      }
    }
  } catch(e) {
    Logger.log('⚠️ _getEmailSTQuery: ' + e.message + ' — usando default');
  }
  return 'to:' + CONFIG_ST_EMAIL.EMAIL_ST_DEFAULT + ' is:unread';
}

// ── COLUMNAS Email_ST_Log (base 1) ────────────────────────────
var COL_EL = {
  FECHA_PROC:    1,
  MESSAGE_ID:    2,
  ASUNTO:        3,
  REMITENTE:     4,
  ID_ST:         5,
  NUM_ADJUNTOS:  6,
  ESTADO:        7,
  DETALLES:      8,
  DRIVE_FOLDER:  9,
  ERROR_MSG:     10,
};


// ═══════════════════════════════════════════════════════════════
//  ACTION HANDLER — llamado desde doGet del backend
//  Registrado en Code.gs:
//    if (action === 'sincronizarEmailsST') return _handleSincronizarEmailsST(params, callback);
// ═══════════════════════════════════════════════════════════════

function _handleSincronizarEmailsST(params, callback) {
  var result = { success: false, procesados: 0, nuevos_st: 0, error: null };
  try {
    var threads    = GmailApp.search(_getEmailSTQuery(), 0, 20);
    var labelProc  = GmailApp.getUserLabelByName(CONFIG_ST_EMAIL.GMAIL_LABEL_PROCESADO);
    var labelError = GmailApp.getUserLabelByName(CONFIG_ST_EMAIL.GMAIL_LABEL_ERROR);
    var procesados = 0;
    var nuevos     = 0;

    for (var t = 0; t < threads.length; t++) {
      var thread   = threads[t];
      var messages = thread.getMessages();
      for (var m = 0; m < messages.length; m++) {
        var msg = messages[m];
        if (!msg.isUnread()) continue;
        var msgId = msg.getId();
        if (_stEmailYaProcesado(msgId)) { msg.markRead(); continue; }
        try {
          var res = _procesarMensajeST(msg);
          _registrarLogEmail({
            fecha_proc:   Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm:ss'),
            message_id:   msgId,
            asunto:       msg.getSubject(),
            remitente:    msg.getFrom(),
            id_st:        res.id_st    || '',
            num_adjuntos: res.adjuntos || 0,
            estado:       res.error_msg ? 'error' : (res.estado === 'sin_voucher' ? 'parcial' : res.estado),
            detalles:     JSON.stringify({ tipo_venta: res.tipo_venta, total_venta: res.total_venta, total_costo: res.total_costo }),
            drive_folder: res.drive_folder || '',
            error_msg:    res.error_msg || '',
          });
          msg.markRead();
          if (res.error_msg) { if (labelError) thread.addLabel(labelError); }
          else               { if (labelProc)  thread.addLabel(labelProc); if (res.id_st) nuevos++; }
          procesados++;
        } catch(err) {
          Logger.log('Error procesando ' + msgId + ': ' + err.message);
          _registrarLogEmail({
            fecha_proc: Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm:ss'),
            message_id: msgId, asunto: msg.getSubject(), remitente: msg.getFrom(),
            id_st: '', num_adjuntos: 0, estado: 'error',
            detalles: '', drive_folder: '', error_msg: err.message,
          });
          msg.markRead();
          if (labelError) thread.addLabel(labelError);
          procesados++;
        }
      }
    }

    result.success    = true;
    result.procesados = procesados;
    result.nuevos_st  = nuevos;
    Logger.log('✅ sincronizarEmailsST: ' + procesados + ' procesados, ' + nuevos + ' STs nuevos');
  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleSincronizarEmailsST: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}


// ═══════════════════════════════════════════════════════════════
//  TRIGGER
// ═══════════════════════════════════════════════════════════════

function installEmailSTTrigger(intervaloMin) {
  intervaloMin = parseInt(intervaloMin || '15', 10);
  var minutosValidos = [15, 30];
  var horasValidas   = [1, 2];

  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'procesarEmailsST') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  var builder = ScriptApp.newTrigger('procesarEmailsST').timeBased();
  if (minutosValidos.indexOf(intervaloMin) !== -1) {
    builder.everyMinutes(intervaloMin).create();
  } else if (horasValidas.indexOf(intervaloMin) !== -1) {
    builder.everyHours(intervaloMin).create();
  } else {
    builder.everyMinutes(15).create();
    intervaloMin = 15;
  }
  var label = intervaloMin < 60
    ? 'cada ' + intervaloMin + ' min'
    : 'cada ' + (intervaloMin/60) + ' hora(s)';
  Logger.log('✅ Trigger procesarEmailsST instalado — ' + label);
}

function removeEmailSTTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'procesarEmailsST') {
      ScriptApp.deleteTrigger(triggers[i]);
      Logger.log('✅ Trigger removido');
    }
  }
}

// Función llamada por el trigger automático
function procesarEmailsST() {
  var threads = GmailApp.search(_getEmailSTQuery(), 0, 20);
  Logger.log('📬 Threads no leídos a +ceyco: ' + threads.length);
  if (threads.length === 0) return;

  var labelProc  = GmailApp.getUserLabelByName(CONFIG_ST_EMAIL.GMAIL_LABEL_PROCESADO);
  var labelError = GmailApp.getUserLabelByName(CONFIG_ST_EMAIL.GMAIL_LABEL_ERROR);

  for (var t = 0; t < threads.length; t++) {
    var thread   = threads[t];
    var messages = thread.getMessages();
    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      if (!msg.isUnread()) continue;
      var msgId = msg.getId();
      if (_stEmailYaProcesado(msgId)) { msg.markRead(); continue; }

      try {
        Logger.log('📧 Procesando: "' + msg.getSubject() + '" de ' + msg.getFrom());
        var resultado = _procesarMensajeST(msg);

        _registrarLogEmail({
          fecha_proc:   Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm:ss'),
          message_id:   msgId,
          asunto:       msg.getSubject(),
          remitente:    msg.getFrom(),
          id_st:        resultado.id_st    || '',
          num_adjuntos: resultado.adjuntos || 0,
          estado:       resultado.error_msg ? 'error' : (resultado.estado === 'sin_voucher' ? 'parcial' : resultado.estado),
          detalles:     JSON.stringify({ tipo_venta: resultado.tipo_venta, total_venta: resultado.total_venta }),
          drive_folder: resultado.drive_folder || '',
          error_msg:    resultado.error_msg || '',
        });

        msg.markRead();
        if (resultado.error_msg) { if (labelError) thread.addLabel(labelError); }
        else                     { if (labelProc)  thread.addLabel(labelProc); }

        Logger.log(resultado.error_msg
          ? '❌ Error: ' + resultado.error_msg
          : '✅ ST ' + resultado.id_st + ' | tipo: ' + resultado.tipo_venta + ' | estado: ' + resultado.estado);

      } catch (err) {
        Logger.log('❌ Excepción ' + msgId + ': ' + err.message);
        _registrarLogEmail({
          fecha_proc: Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm:ss'),
          message_id: msgId, asunto: msg.getSubject(), remitente: msg.getFrom(),
          id_st: '', num_adjuntos: 0, estado: 'error',
          detalles: '', drive_folder: '', error_msg: err.message,
        });
        msg.markRead();
        if (labelError) thread.addLabel(labelError);
      }
    }
  }
}


// ═══════════════════════════════════════════════════════════════
//  _procesarMensajeST
//  Orquesta el procesamiento de un email individual.
//  Sube adjuntos a Drive → crea wrappers → llama al motor compartido.
// ═══════════════════════════════════════════════════════════════

function _procesarMensajeST(msg) {
  var resultado = {
    id_st: '', adjuntos: 0, drive_folder: '',
    tipo_venta: '', total_venta: 0, total_costo: 0,
    estado: 'error', error_msg: null,
  };

  var attachments = msg.getAttachments();
  if (!attachments || attachments.length === 0) {
    resultado.error_msg = 'El email no tiene adjuntos';
    return resultado;
  }

  // Filtrar adjuntos válidos (PDF + imágenes)
  var mimeValidos = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
  var attsValidos = [];
  for (var i = 0; i < attachments.length; i++) {
    var mime = attachments[i].getContentType() || '';
    if (mimeValidos.indexOf(mime) !== -1) attsValidos.push(attachments[i]);
    else Logger.log('⏭️ Omitiendo adjunto: ' + attachments[i].getName() + ' (' + mime + ')');
  }

  if (attsValidos.length === 0) {
    resultado.error_msg = 'Sin adjuntos PDF o imagen válidos';
    return resultado;
  }
  resultado.adjuntos = attsValidos.length;

  // ── PASO 1: Subir adjuntos a Drive para obtener URLs ─────────
  // Se sube ANTES de clasificar para que los wrappers tengan URLs reales.
  // Carpeta: VOUCHER_FOLDER_ID / ST_Emails / {CLIENTE_temp} / {yyyy-MM}
  // El nombre del cliente se ajustará después de parsear la factura.
  var ahora     = new Date();
  var fechaMes  = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM');
  var tmpFolder = _getOrCreateSubfolderST(
    DriveApp.getFolderById(CONFIG.VOUCHER_FOLDER_ID),
    CONFIG_ST_EMAIL.DRIVE_SUBFOLDER_ST
  );
  tmpFolder = _getOrCreateSubfolderST(tmpFolder, 'email_' + Utilities.formatDate(ahora, 'America/Panama', 'yyyyMMddHHmmss'));
  resultado.drive_folder = tmpFolder.getUrl();

  // Subir y obtener URLs
  var driveUrls = {};   // { nombre: url }
  for (var j = 0; j < attsValidos.length; j++) {
    var att    = attsValidos[j];
    var nombre = att.getName() || ('adjunto_' + j + '.pdf');
    try {
      var blob = Utilities.newBlob(att.getBytes(), att.getContentType(), nombre);
      var file = tmpFolder.createFile(blob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      driveUrls[nombre] = 'https://drive.google.com/file/d/' + file.getId() + '/view';
      Logger.log('📁 Subido: ' + nombre);
    } catch(upErr) {
      Logger.log('⚠️ Error subiendo ' + nombre + ': ' + upErr.message);
      driveUrls[nombre] = '';
    }
  }

  // ── PASO 2: Crear wrappers — misma interfaz que DriveFile ────
  var archivosWrapped = [];
  for (var k = 0; k < attsValidos.length; k++) {
    archivosWrapped.push(_wrapAttachment(attsValidos[k], driveUrls[attsValidos[k].getName() || ''], k));
  }

  // ── PASO 3: Motor compartido con histórico ────────────────────
  var ss       = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var contexto = 'Email: ' + msg.getSubject() + ' | De: ' + msg.getFrom();
  var mes      = Utilities.formatDate(ahora, 'America/Panama', 'MMMM yyyy').toUpperCase();

  var resMotor = _procesarDesdeBlobs(ss, archivosWrapped, mes, contexto);

  // ── PASO 4: Renombrar carpeta Drive con nombre del cliente ────
  if (resMotor.cliente && resMotor.cliente !== '') {
    var nombreCli = resMotor.cliente.replace(/[\/\\:*?"<>|]/g,'_').replace(/\s+/g,'_').substring(0,40).toUpperCase();
    try {
      tmpFolder.setName(nombreCli + '_' + fechaMes);
    } catch(renErr) {
      Logger.log('⚠️ Error renombrando carpeta Drive: ' + renErr.message);
    }
  }

  // Copiar campos del resultado del motor
  resultado.id_st       = resMotor.id_st;
  resultado.tipo_venta  = resMotor.tipo_venta;
  resultado.total_venta = resMotor.total_venta;
  resultado.total_costo = resMotor.total_costo;
  resultado.estado      = resMotor.estado;
  resultado.error_msg   = resMotor.error_msg || null;

  return resultado;
}


// ═══════════════════════════════════════════════════════════════
//  DRIVE HELPERS
// ═══════════════════════════════════════════════════════════════

function _getOrCreateSubfolderST(parentFolder, nombre) {
  var iter = parentFolder.getFoldersByName(nombre);
  if (iter.hasNext()) return iter.next();
  return parentFolder.createFolder(nombre);
}


// ═══════════════════════════════════════════════════════════════
//  LOG DE PROCESAMIENTO — hoja Email_ST_Log
// ═══════════════════════════════════════════════════════════════

function _initEmailLogSheet(ss) {
  var existing = ss.getSheetByName(CONFIG_ST_EMAIL.SHEET_EMAIL_LOG);
  if (existing) return existing;
  var sheet = ss.insertSheet(CONFIG_ST_EMAIL.SHEET_EMAIL_LOG);
  SpreadsheetApp.flush();
  var headers = [
    'fecha_procesamiento', 'gmail_message_id', 'asunto', 'remitente',
    'id_st', 'num_adjuntos', 'estado', 'detalles_json', 'drive_folder_url', 'error'
  ];
  sheet.getRange(1, 1, 1, CONFIG_ST_EMAIL.EMAIL_LOG_NCOLS).setValues([headers]);
  sheet.getRange(1, 1, 1, CONFIG_ST_EMAIL.EMAIL_LOG_NCOLS)
    .setBackground('#37474F').setFontColor('#FFFFFF').setFontWeight('bold');
  sheet.setFrozenRows(1);
  var widths = [160, 180, 250, 200, 140, 80, 80, 400, 250, 300];
  for (var i = 0; i < widths.length; i++) sheet.setColumnWidth(i + 1, widths[i]);
  Logger.log('✅ Hoja Email_ST_Log creada.');
  return sheet;
}

function _stEmailYaProcesado(messageId) {
  var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG_ST_EMAIL.SHEET_EMAIL_LOG);
  if (!sheet || sheet.getLastRow() <= 1) return false;
  var ids = sheet.getRange(2, COL_EL.MESSAGE_ID, sheet.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(messageId)) return true;
  }
  return false;
}

function _registrarLogEmail(entry) {
  var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = _initEmailLogSheet(ss);
  var fila  = new Array(CONFIG_ST_EMAIL.EMAIL_LOG_NCOLS);
  for (var x = 0; x < CONFIG_ST_EMAIL.EMAIL_LOG_NCOLS; x++) fila[x] = '';
  fila[COL_EL.FECHA_PROC - 1]   = entry.fecha_proc   || '';
  fila[COL_EL.MESSAGE_ID - 1]   = entry.message_id   || '';
  fila[COL_EL.ASUNTO - 1]       = entry.asunto       || '';
  fila[COL_EL.REMITENTE - 1]    = entry.remitente    || '';
  fila[COL_EL.ID_ST - 1]        = entry.id_st        || '';
  fila[COL_EL.NUM_ADJUNTOS - 1] = entry.num_adjuntos || 0;
  fila[COL_EL.ESTADO - 1]       = entry.estado       || '';
  fila[COL_EL.DETALLES - 1]     = entry.detalles     || '';
  fila[COL_EL.DRIVE_FOLDER - 1] = entry.drive_folder || '';
  fila[COL_EL.ERROR_MSG - 1]    = entry.error_msg    || '';
  var newRow = sheet.getLastRow() + 1;
  sheet.getRange(newRow, 1, 1, CONFIG_ST_EMAIL.EMAIL_LOG_NCOLS).setValues([fila]);
  var bg = entry.estado === 'ok' ? '#F1F8E9' : entry.estado === 'parcial' ? '#FFF9C4' : '#FFEBEE';
  sheet.getRange(newRow, 1, 1, CONFIG_ST_EMAIL.EMAIL_LOG_NCOLS).setBackground(bg);
}


// ═══════════════════════════════════════════════════════════════
//  _handleActualizarDatosST  (doGet)
//  Edición post-cierre de campos del ST.
//  Registrado en Code.gs:
//    if (action === 'actualizarDatosST') return _handleActualizarDatosST(params, callback);
// ═══════════════════════════════════════════════════════════════

function _handleActualizarDatosST(params, callback) {
  var result = { success: false, id_st: null, campos_actualizados: [], error: null };
  try {
    var idST = String(params.id_st || '').trim();
    if (!idST) throw new Error('id_st requerido');
    var ss  = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var rec = _getSTById(ss, idST);
    if (!rec) throw new Error('ST no encontrado: ' + idST);
    var sheet        = ss.getSheetByName(SHEET_ST);
    var rowNum       = rec.row;
    var actualizados = [];

    var camposDirectos = [
      { param: 'nombre_cliente', col: COL_ST.NOMBRE_CLI  },
      { param: 'ruc_cliente',    col: COL_ST.RUC_CLI     },
      { param: 'dv_cliente',     col: COL_ST.DV_CLI      },
      { param: 'contacto',       col: COL_ST.CONTACTO    },
      { param: 'email_cliente',  col: COL_ST.EMAIL_CLI   },
      { param: 'descripcion',    col: COL_ST.DESCRIPCION },
    ];
    for (var i = 0; i < camposDirectos.length; i++) {
      var campo = camposDirectos[i];
      if (params[campo.param] !== undefined && params[campo.param] !== '') {
        sheet.getRange(rowNum, campo.col).setValue(params[campo.param]);
        actualizados.push(campo.param);
      }
    }
    if (params.notas) {
      var notaActual = String(sheet.getRange(rowNum, COL_ST.NOTAS).getValue() || '');
      var stamp      = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm');
      sheet.getRange(rowNum, COL_ST.NOTAS).setValue(
        notaActual ? notaActual + ' | [' + stamp + '] ' + params.notas : '[' + stamp + '] ' + params.notas
      );
      actualizados.push('notas');
    }
    if (params.precio_venta) {
      var nuevoPrecio = parseFloat(params.precio_venta) || 0;
      var totalCosto  = parseFloat(rec.data[COL_ST.TOTAL_COSTO_COT - 1] || '0') || 0;
      var nuevoMargen = (nuevoPrecio > 0 && totalCosto > 0)
        ? parseFloat(((nuevoPrecio / totalCosto - 1) * 100).toFixed(2)) : 0;
      sheet.getRange(rowNum, COL_ST.PRECIO_VENTA).setValue(nuevoPrecio);
      sheet.getRange(rowNum, COL_ST.MARGEN_PCT).setValue(nuevoMargen);
      actualizados.push('precio_venta');
    }
    if (actualizados.length === 0) throw new Error('No se enviaron campos para actualizar');
    result.success            = true;
    result.id_st              = idST;
    result.campos_actualizados = actualizados;
    Logger.log('✅ ST actualizado (' + idST + '): ' + actualizados.join(', '));
  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleActualizarDatosST: ' + err.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}


// ═══════════════════════════════════════════════════════════════
//  SETUP Y TEST
// ═══════════════════════════════════════════════════════════════

function setupEmailST() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  _initEmailLogSheet(ss);
  Logger.log('✅ Hoja Email_ST_Log OK');

  var label2 = GmailApp.getUserLabelByName(CONFIG_ST_EMAIL.GMAIL_LABEL_PROCESADO);
  var label3 = GmailApp.getUserLabelByName(CONFIG_ST_EMAIL.GMAIL_LABEL_ERROR);
  if (!label2) Logger.log('⚠️ Crear label Gmail: "' + CONFIG_ST_EMAIL.GMAIL_LABEL_PROCESADO + '"');
  else         Logger.log('✅ Label "' + CONFIG_ST_EMAIL.GMAIL_LABEL_PROCESADO + '" OK');
  if (!label3) Logger.log('ℹ️  Label opcional: "' + CONFIG_ST_EMAIL.GMAIL_LABEL_ERROR + '"');
  else         Logger.log('✅ Label "' + CONFIG_ST_EMAIL.GMAIL_LABEL_ERROR + '" OK');

  try {
    DriveApp.getFolderById(CONFIG.VOUCHER_FOLDER_ID);
    Logger.log('✅ Carpeta Drive raíz OK');
  } catch(e) { Logger.log('❌ Drive: ' + e.message); }

  var testSearch = GmailApp.search(_getEmailSTQuery(), 0, 1);
  Logger.log('✅ Query Gmail OK — threads ahora: ' + testSearch.length);

  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  Logger.log(apiKey ? '✅ CLAUDE_API_KEY OK' : '❌ CLAUDE_API_KEY falta');

  Logger.log('\n📋 Para activar: ejecutar installEmailSTTrigger()');
}

function testProcesarEmailsST() {
  Logger.log('🧪 Test manual...');
  procesarEmailsST();
  Logger.log('🧪 Test completado.');
}
