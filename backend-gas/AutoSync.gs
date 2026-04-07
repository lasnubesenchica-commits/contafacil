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
