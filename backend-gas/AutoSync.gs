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
