function syncEmailsTrigger() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log('Otra ejecucion en curso — abortando');
    return;
  }
  try {
    Logger.log('Iniciando sync: ' +
      Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm:ss'));

    var result = _handleSincronizar({}, '');

    try {
      var data = JSON.parse(result.getContent());
      if (data.success) {
        Logger.log('Sync OK — procesados: ' + (data.procesados || 0) +
          ' | nuevos: ' + (data.nuevos || 0) +
          ' | vinculados: ' + (data.vinculados || 0));
      } else {
        Logger.log('Sync error: ' + (data.error || 'desconocido'));
      }
    } catch(e) {
      Logger.log('Sync completado (resultado no parseable)');
    }

  } catch(err) {
    Logger.log('syncEmailsTrigger ERROR: ' + err.message);
  } finally {
    lock.releaseLock();
  }
}

// ════════════════════════════════════════════════════════════════
//  Trigger unificado — procesa AMBOS flujos según config:
//    1. Comercialización / Retail (email_op_*)
//    2. Registro General / Acreedores (email_acr_*)
//  Cada cliente solo paga el costo de los flujos que tiene
//  configurados; los que no tengan email destino se saltan.
//
//  ESTE es el handler al que apunta el toggle "Trigger
//  sincronización" del panel Configuración → Sistema.
// ════════════════════════════════════════════════════════════════
function ejecutarSincronizacionUnificada() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log('Otra ejecucion en curso — abortando');
    return;
  }
  try {
    var ts = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
    Logger.log('🔄 Sync unificada · ' + ts);

    var cfg = {};
    try { cfg = _getConfig(); } catch (e) {}

    // ── Flags por cliente — qué flujos corren ──
    // Por defecto: solo Acreedores (caso Iris y la mayoría de clientes Pro).
    // Para activar Comercialización en un cliente (ej. CEYCO), agregar fila
    // en config_operaciones: flow_comercializacion = true.
    // El flag de Acreedores también es opt-out por si algún cliente
    // quisiera deshabilitarlo (raro).
    var flagAcr = String(cfg.flow_acreedor || 'true').toLowerCase() !== 'false';
    var flagOp  = String(cfg.flow_comercializacion || 'false').toLowerCase() === 'true';

    // ── Flujo 1: Comercialización (Retail) ──
    if (flagOp && (cfg.email_op_destino || cfg.email_comprobantes)) {
      try {
        var statsOp = sincronizarEmails();
        Logger.log('  ✓ Comercialización: ' + JSON.stringify(statsOp));
      } catch (errOp) {
        Logger.log('  ✗ Comercialización error: ' + errOp.message);
      }
    } else {
      Logger.log('  ⏭ Comercialización: deshabilitado (flow_comercializacion != true)');
    }

    // ── Flujo 2: Registro General / Acreedores ──
    var hasAcr = !!(cfg.email_acr_destino || cfg.email_op_destino || cfg.email_comprobantes);
    if (flagAcr && hasAcr && typeof _sincronizarEmailsAcreedores === 'function') {
      try {
        var statsAcr = _sincronizarEmailsAcreedores();
        Logger.log('  ✓ Registro General: ' + JSON.stringify(statsAcr));
      } catch (errAcr) {
        Logger.log('  ✗ Registro General error: ' + errAcr.message);
      }
    } else if (!flagAcr) {
      Logger.log('  ⏭ Registro General: deshabilitado (flow_acreedor=false)');
    } else if (!hasAcr) {
      Logger.log('  ⏭ Registro General: sin email destino — saltado');
    }

  } catch (err) {
    Logger.log('ejecutarSincronizacionUnificada ERROR: ' + err.message);
  } finally {
    lock.releaseLock();
  }
}

function installSyncTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'syncEmailsTrigger') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('syncEmailsTrigger')
    .timeBased()
    .everyMinutes(15)
    .create();
  Logger.log('Trigger instalado — cada 15 minutos');
}

// ════════════════════════════════════════════════════════════════
//  Trigger UNIFICADO — recomendado para clientes nuevos.
//  Instala ejecutarSincronizacionUnificada que respeta los flags
//  flow_acreedor / flow_comercializacion del config_operaciones.
//  Limpia cualquier trigger legacy (syncEmailsTrigger) o duplicado
//  para evitar doble procesamiento del inbox.
// ════════════════════════════════════════════════════════════════
function installUnifiedSyncTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var legacy = ['syncEmailsTrigger', 'ejecutarSincronizacionUnificada'];
  for (var i = 0; i < triggers.length; i++) {
    if (legacy.indexOf(triggers[i].getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('ejecutarSincronizacionUnificada')
    .timeBased()
    .everyMinutes(15)
    .create();
  Logger.log('✓ Trigger unificado instalado — cada 15 min');
  return { success: true, function: 'ejecutarSincronizacionUnificada', intervalo: 15 };
}

function _handleInstallUnifiedSyncTrigger(data, callback) {
  var result;
  try {
    result = installUnifiedSyncTrigger();
  } catch (e) {
    result = { success: false, error: e.message };
    Logger.log('Error instalando trigger unificado: ' + e.message);
  }
  var json = JSON.stringify(result);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function pauseSyncTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var count = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'syncEmailsTrigger') {
      ScriptApp.deleteTrigger(triggers[i]);
      count++;
    }
  }
  Logger.log(count > 0 ? 'Sync pausado' : 'No habia trigger activo');
}

// ════════════════════════════════════════════════════════════════
//  HELPER — forzar autorización completa de scopes
//
//  ejecutarSincronizacionUnificada llama a las funciones de sync
//  vía `typeof X === 'function'` para no romper si un módulo no
//  está cargado. Este patrón evita que el static analyzer de Apps
//  Script detecte la dependencia a GmailApp/DriveApp, y por tanto
//  el dialog inicial de autorización NO pide esos scopes. Cuando
//  el trigger corre después, falla con "permission denied".
//
//  Esta función llama EXPLÍCITAMENTE a Gmail+Drive+Sheets para que
//  Apps Script detecte todos los scopes y los pida en el primer run.
//
//  Cuando provisiones un cliente nuevo (o copies un script), corre
//  esta función una vez desde el editor:
//     Run → forzarAutorizacionScopes → Allow all permissions.
//  Después el trigger tiene autorización completa.
// ════════════════════════════════════════════════════════════════
function forzarAutorizacionScopes() {
  var info = { gmail: 0, drive: 0, sheet: '' };
  try { info.gmail = GmailApp.getUserLabels().length; } catch(e) { info.gmail = 'ERR: ' + e.message; }
  try { info.drive = DriveApp.getRootFolder() ? 1 : 0; } catch(e) { info.drive = 'ERR: ' + e.message; }
  try { info.sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getName(); } catch(e) { info.sheet = 'ERR: ' + e.message; }
  Logger.log('✅ Scopes autorizados — ' + JSON.stringify(info));
  return info;
}
