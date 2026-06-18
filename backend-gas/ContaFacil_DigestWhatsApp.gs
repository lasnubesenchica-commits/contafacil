// ════════════════════════════════════════════════════════════════════
//  ContaFacil_DigestWhatsApp.gs
//  Módulo: Notificaciones programadas por WhatsApp (template HSM)
//  v1.0 — Resumen diario + tap-to-engage para transferencias pendientes
//
//  Dos flujos:
//
//  A) Tap-to-engage para transferencias bancarias pendientes
//     ────────────────────────────────────────────────────
//     Trigger: llamado por AutoSync después de _sincronizarTransferenciasBG.
//     Manda template solo si: (i) la ventana de 24h está cerrada,
//     (ii) hay items en queue, (iii) pasó el debounce desde el último
//     template enviado. Cuando el cliente toca el botón, el bot drena
//     la queue (envía cada pendiente con el interactivo de categorización).
//     Costo Meta: $0.016 por template enviado.
//
//  B) Resumen diario (digest)
//     ──────────────────────
//     Trigger: time-based diario a las 19:00 Panamá. Manda template
//     solo si hubo actividad ese día (egresos o ingresos > 0).
//     Botón "Ver detalle" → bot manda mensaje free-form con desglose
//     completo (window abierto por el tap, no cuesta extra).
//     Costo Meta: $0.016/día/cliente (≤ $0.48/mes/cliente).
//
//  Feature flags (Script Properties)
//  ─────────────────────────────────
//    WA_TEMPLATE_DIGEST_ENABLED         true|false  (default false)
//    WA_TEMPLATE_TAP_TO_ENGAGE_ENABLED  true|false  (default false)
//    WA_TEMPLATE_DIGEST_NAME            resumen_diario_balanceclip
//    WA_TEMPLATE_TAP_TO_ENGAGE_NAME     transferencia_pendiente_clasificar
//    WA_TEMPLATE_LANG                   es_LA
//
//  Hasta que Meta apruebe las plantillas, los flags quedan en false
//  y los handlers loggean su intención sin enviar. Una vez aprobadas:
//  flippear el flag a true (sin redeploy) y empieza a enviar.
// ════════════════════════════════════════════════════════════════════

var DIGEST_DEFAULT_HOUR     = 19;   // 7pm Panamá
var TAP_TO_ENGAGE_DEBOUNCE_H = 6;   // max 1 template cada 6h por cliente
var WA_WINDOW_HOURS         = 24;   // ventana customer-service de Meta

// ──────────────────────────────────────────────────────────────────────
//  FEATURE FLAGS / CONFIG READERS
// ──────────────────────────────────────────────────────────────────────

function _digestFlagsActivos() {
  return {
    digest:        _waFlag('WA_TEMPLATE_DIGEST_ENABLED', false),
    tap:           _waFlag('WA_TEMPLATE_TAP_TO_ENGAGE_ENABLED', false),
    digestName:    _waProp('WA_TEMPLATE_DIGEST_NAME',         'resumen_diario_balanceclip'),
    tapName:       _waProp('WA_TEMPLATE_TAP_TO_ENGAGE_NAME',  'transferencia_pendiente_clasificar'),
    lang:          _waProp('WA_TEMPLATE_LANG',                'es_LA'),
  };
}

function _waFlag(key, def) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (v == null) return def;
  return String(v).toLowerCase() === 'true';
}

function _waProp(key, def) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return (v == null || v === '') ? def : String(v);
}

// ──────────────────────────────────────────────────────────────────────
//  24h WINDOW TRACKING
//  En cada inbound del cliente actualizamos el timestamp. La ventana
//  está "abierta" si el último inbound fue dentro de las últimas 24h.
//  Permite decidir si vale la pena gastar template o si podemos mandar
//  un mensaje normal sin costo.
// ──────────────────────────────────────────────────────────────────────

function _waUpdateLastInbound(phone) {
  if (!phone) return;
  try {
    PropertiesService.getScriptProperties().setProperty('lastInbound_' + phone, String(Date.now()));
  } catch (e) { /* silent — no queremos romper el flujo principal por esto */ }
}

function _waIsWindowOpen(phone) {
  if (!phone) return false;
  var ts = parseInt(PropertiesService.getScriptProperties().getProperty('lastInbound_' + phone), 10) || 0;
  return (Date.now() - ts) < (WA_WINDOW_HOURS * 60 * 60 * 1000);
}

// ──────────────────────────────────────────────────────────────────────
//  TEMPLATE DEBOUNCE — evita spam de templates al mismo phone
//  Tracking por (phone, kind) para que digest y tap-to-engage tengan
//  buckets independientes.
// ──────────────────────────────────────────────────────────────────────

function _waCanSendTemplate(phone, kind, debounceHours) {
  if (!phone) return false;
  var key = 'tplSent_' + kind + '_' + phone;
  var ts  = parseInt(PropertiesService.getScriptProperties().getProperty(key), 10) || 0;
  return (Date.now() - ts) >= (debounceHours * 60 * 60 * 1000);
}

function _waMarkTemplateSent(phone, kind) {
  if (!phone) return;
  PropertiesService.getScriptProperties().setProperty('tplSent_' + kind + '_' + phone, String(Date.now()));
}

// ──────────────────────────────────────────────────────────────────────
//  META TEMPLATE SEND HELPER
//  Construye el payload con body params + quick reply button payload,
//  hace POST a Graph API y devuelve { success, error, statusCode }.
// ──────────────────────────────────────────────────────────────────────

function _waSendTemplate(to, templateName, lang, bodyParams, btnPayload, token, phoneId) {
  if (!to || !templateName || !token || !phoneId) {
    return { success: false, error: 'faltan params' };
  }
  var components = [];
  if (bodyParams && bodyParams.length) {
    components.push({
      type: 'body',
      parameters: bodyParams.map(function(v) {
        return { type: 'text', text: String(v == null ? '' : v) };
      }),
    });
  }
  if (btnPayload) {
    components.push({
      type: 'button',
      sub_type: 'quick_reply',
      index: '0',
      parameters: [{ type: 'payload', payload: String(btnPayload) }],
    });
  }
  var payload = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: lang || 'es_LA' },
      components: components,
    },
  };
  try {
    var r = UrlFetchApp.fetch(META_GRAPH_BASE + '/' + phoneId + '/messages', {
      method:             'post',
      contentType:        'application/json',
      headers:            { 'Authorization': 'Bearer ' + token },
      payload:            JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    var code = r.getResponseCode();
    var bodyRaw = r.getContentText();
    if (code >= 200 && code < 300) return { success: true, statusCode: code };
    Logger.log('_waSendTemplate HTTP ' + code + ': ' + bodyRaw.substring(0, 300));
    return { success: false, statusCode: code, error: bodyRaw.substring(0, 200) };
  } catch (err) {
    Logger.log('_waSendTemplate ERROR: ' + err.message);
    return { success: false, error: err.message };
  }
}

// ════════════════════════════════════════════════════════════════════
//  FLUJO A — TAP-TO-ENGAGE TRANSFERENCIAS PENDIENTES
//
//  Llamado por AutoSync después de _sincronizarTransferenciasBG. Si hay
//  transferencias en estado pendiente_clasif para el cliente Y la
//  ventana está cerrada Y pasó el debounce → manda template.
//  El handler del botón (en _whatsappOnInteractive, ver Transferencias.gs)
//  llama a _transfDrainQueue que envía cada pendiente con el interactivo.
// ════════════════════════════════════════════════════════════════════

function _tapToEngageCheckAndSend() {
  var flags = _digestFlagsActivos();
  if (!flags.tap) {
    Logger.log('tap-to-engage: flag OFF — skip');
    return;
  }
  var phone = String(CONFIG.WA_NUM || '').replace(/\D/g, '');
  if (phone.length === 8) phone = '507' + phone;
  if (!phone || phone.length < 10) {
    Logger.log('tap-to-engage: WA_NUM inválido — skip');
    return;
  }
  if (_waIsWindowOpen(phone)) {
    Logger.log('tap-to-engage: ventana abierta — el bot ya pudo mandar interactivo directo, no necesita template');
    return;
  }
  if (!_waCanSendTemplate(phone, 'transferencia_pendiente', TAP_TO_ENGAGE_DEBOUNCE_H)) {
    Logger.log('tap-to-engage: dentro del debounce (' + TAP_TO_ENGAGE_DEBOUNCE_H + 'h) — skip');
    return;
  }
  // Listar pendientes
  if (typeof _transfPendientesPorPhone !== 'function') {
    Logger.log('tap-to-engage: módulo Transferencias no disponible — skip');
    return;
  }
  var pendings = _transfPendientesPorPhone(phone, 99);
  if (!pendings.length) {
    Logger.log('tap-to-engage: queue vacía — skip');
    return;
  }
  var total = 0;
  pendings.forEach(function(p) { total += parseFloat(p.parsed.monto) || 0; });

  var props   = PropertiesService.getScriptProperties();
  var token   = props.getProperty('META_WHATSAPP_TOKEN');
  var phoneId = props.getProperty('META_PHONE_ID');
  if (!token || !phoneId) {
    Logger.log('tap-to-engage: META credentials faltan — skip');
    return;
  }
  var clientName = String(CONFIG.NEGOCIO || '').split(' ')[0] || 'cliente';
  var bodyParams = [clientName, String(pendings.length), total.toFixed(2)];
  var btnPayload = 'tr:queue:open';

  var r = _waSendTemplate(phone, flags.tapName, flags.lang, bodyParams, btnPayload, token, phoneId);
  if (r.success) {
    _waMarkTemplateSent(phone, 'transferencia_pendiente');
    Logger.log('✅ Template tap-to-engage enviado a +' + phone + ' (' + pendings.length + ' pendientes)');
  } else {
    Logger.log('✗ Template tap-to-engage FALLÓ: ' + (r.error || 'desconocido'));
  }
}

// Handler — cliente tocó "Revisar pendientes" del template.
// La ventana ahora está abierta por el tap, drenar queue libremente.
function _tapToEngageHandleRevisar(from, token, phoneId) {
  if (typeof _transfDrainQueue === 'function') {
    _transfDrainQueue(from, token, phoneId);
  } else {
    _whatsappReply(from, '⚠️ El módulo de transferencias no está disponible.', token, phoneId);
  }
}

// ════════════════════════════════════════════════════════════════════
//  FLUJO B — RESUMEN DIARIO (DIGEST)
//
//  Trigger time-based diario a las 19:00 Panamá (instalado por
//  installDigestTrigger). Lee actividad del día, manda template si
//  hubo > 0 movimientos. Botón "Ver detalle" → bot manda mensaje
//  free-form con desglose.
// ════════════════════════════════════════════════════════════════════

function _digestSendDaily() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) {
    Logger.log('digest: lock no obtenido — skip');
    return;
  }
  try {
    var flags = _digestFlagsActivos();
    if (!flags.digest) {
      Logger.log('digest: flag OFF — skip (dejá WA_TEMPLATE_DIGEST_ENABLED=true para activar)');
      return;
    }
    var phone = String(CONFIG.WA_NUM || '').replace(/\D/g, '');
    if (phone.length === 8) phone = '507' + phone;
    if (!phone || phone.length < 10) {
      Logger.log('digest: WA_NUM inválido — skip');
      return;
    }
    var activity = _digestComputeActivity();
    if (!activity.tieneActividad) {
      Logger.log('digest: sin actividad hoy — no se envía (correcto por diseño)');
      return;
    }
    var props   = PropertiesService.getScriptProperties();
    var token   = props.getProperty('META_WHATSAPP_TOKEN');
    var phoneId = props.getProperty('META_PHONE_ID');
    if (!token || !phoneId) {
      Logger.log('digest: META credentials faltan — skip');
      return;
    }
    var clientName = String(CONFIG.NEGOCIO || '').split(' ')[0] || 'cliente';
    var bodyParams = [
      clientName,                // {{1}}
      activity.itemsString,      // {{2}}
      activity.totalString,      // {{3}}
      activity.estadoString,     // {{4}}
    ];
    var btnPayload = 'tr:digest:detail';

    var r = _waSendTemplate(phone, flags.digestName, flags.lang, bodyParams, btnPayload, token, phoneId);
    if (r.success) {
      _waMarkTemplateSent(phone, 'digest');
      Logger.log('✅ Digest enviado a +' + phone + ' (' + activity.itemsString + ', $' + activity.totalString + ')');
    } else {
      Logger.log('✗ Digest FALLÓ: ' + (r.error || 'desconocido'));
    }
  } finally {
    lock.releaseLock();
  }
}

// Computa actividad del día. Devuelve:
//   { tieneActividad, itemsString, totalString, estadoString }
function _digestComputeActivity() {
  var hoy = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd');
  var ss  = SpreadsheetApp.openById(CONFIG.SHEET_ID);

  // ── Egresos registrados hoy (fecha_registro empieza con hoy) ──
  var egCount = 0, egTotal = 0, transfCount = 0;
  var sheetEg = ss.getSheetByName(SHEET_EGRESOS);
  if (sheetEg && sheetEg.getLastRow() > 2) {
    var dataEg = sheetEg.getRange(3, 1, sheetEg.getLastRow() - 2, EGRESOS_NCOLS).getValues();
    for (var i = 0; i < dataEg.length; i++) {
      var fr = dataEg[i][COL_E.FECHA_REG - 1];
      var frStr = '';
      if (fr instanceof Date) frStr = Utilities.formatDate(fr, 'America/Panama', 'yyyy-MM-dd');
      else frStr = String(fr || '').substring(0, 10);
      if (frStr !== hoy) continue;
      egCount++;
      egTotal += parseFloat(dataEg[i][COL_E.TOTAL - 1]) || 0;
      var notas = String(dataEg[i][COL_E.NOTAS - 1] || '');
      if (notas.indexOf('Transferencia BG') === 0) transfCount++;
    }
  }

  // ── Ingresos registrados hoy ──
  var inCount = 0, inTotal = 0;
  // El nombre de la hoja Ingresos depende del proyecto; lo buscamos por
  // patrones comunes para no depender de un constante específica.
  var sheetIn = ss.getSheetByName('Ingresos') || ss.getSheetByName('INGRESOS');
  if (sheetIn && sheetIn.getLastRow() > 2) {
    var lastCol = Math.min(sheetIn.getLastColumn(), 25);
    var dataIn  = sheetIn.getRange(3, 1, sheetIn.getLastRow() - 2, lastCol).getValues();
    // Heurística: col B suele ser fecha_registro, col I/J suele ser total.
    // Si tu schema difiere, ajustar. Conservador: solo contamos si la fila
    // tiene un id y una fecha que matchea.
    for (var j = 0; j < dataIn.length; j++) {
      var idRow = String(dataIn[j][0] || '');
      if (!idRow) continue;
      var fechaIn = dataIn[j][1];
      var fechaStr = (fechaIn instanceof Date)
        ? Utilities.formatDate(fechaIn, 'America/Panama', 'yyyy-MM-dd')
        : String(fechaIn || '').substring(0, 10);
      if (fechaStr !== hoy) continue;
      inCount++;
      // Buscar total en cualquier columna numérica > 0 (heurístico)
      for (var k = 4; k < lastCol; k++) {
        var n = parseFloat(dataIn[j][k]);
        if (!isNaN(n) && n > 0 && n < 1e7) { inTotal += n; break; }
      }
    }
  }

  // ── Pendientes (acreedores + transferencias) ──
  var pendAcr = _digestCountAcreedoresPendientes();
  var pendTr  = _digestCountTransferenciasPendientes();

  // ── Build strings para el template ──
  var partes = [];
  var facturasOEgresosCount = egCount - transfCount;
  if (facturasOEgresosCount > 0) {
    partes.push(facturasOEgresosCount + (facturasOEgresosCount === 1 ? ' egreso' : ' egresos'));
  }
  if (transfCount > 0) {
    partes.push(transfCount + (transfCount === 1 ? ' transferencia' : ' transferencias'));
  }
  if (inCount > 0) {
    partes.push(inCount + (inCount === 1 ? ' ingreso' : ' ingresos'));
  }
  var itemsString = partes.join(' + ') || '0 movimientos';
  var totalNeto = egTotal + inTotal;
  var totalString = totalNeto.toLocaleString
    ? totalNeto.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : totalNeto.toFixed(2);

  var estadoPartes = [];
  if (pendTr > 0)  estadoPartes.push('📋 ' + pendTr + ' transferencia(s) pendiente(s) de clasificar');
  if (pendAcr > 0) estadoPartes.push('🔍 ' + pendAcr + ' factura(s) pendiente(s) de aprobar');
  var estadoString = estadoPartes.length ? estadoPartes.join(' · ') : 'Todo al día ✅';

  return {
    tieneActividad: (egCount + inCount) > 0,
    itemsString:    itemsString,
    totalString:    totalString,
    estadoString:   estadoString,
    raw: {
      egCount: egCount, egTotal: egTotal,
      inCount: inCount, inTotal: inTotal,
      transfCount: transfCount,
      pendAcr: pendAcr, pendTr: pendTr,
    },
  };
}

function _digestCountAcreedoresPendientes() {
  // Hoja Acreedores_Pendientes (o similar): cuenta filas con estado=pendiente.
  // Si no existe la hoja, devuelve 0 (cliente sin flujo de acreedores).
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var candidates = ['Acreedores_Pendientes', 'Pendientes_Acreedores', 'Acreedores'];
  var sheet = null;
  for (var i = 0; i < candidates.length; i++) {
    sheet = ss.getSheetByName(candidates[i]);
    if (sheet) break;
  }
  if (!sheet || sheet.getLastRow() <= 2) return 0;
  // Heurística: buscar columna que contenga "estado"
  var headers = sheet.getRange(2, 1, 1, Math.min(sheet.getLastColumn(), 30)).getValues()[0];
  var estCol = -1;
  for (var c = 0; c < headers.length; c++) {
    if (String(headers[c] || '').toLowerCase().indexOf('estado') >= 0) { estCol = c; break; }
  }
  if (estCol < 0) return 0;
  var data = sheet.getRange(3, estCol + 1, sheet.getLastRow() - 2, 1).getValues();
  var n = 0;
  for (var j = 0; j < data.length; j++) {
    if (String(data[j][0] || '').toLowerCase().indexOf('pendiente') >= 0) n++;
  }
  return n;
}

function _digestCountTransferenciasPendientes() {
  if (typeof SHEET_TRANSF_PENDIENTES !== 'string') return 0;
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_TRANSF_PENDIENTES);
  if (!sheet || sheet.getLastRow() <= 2) return 0;
  var data = sheet.getRange(3, COL_TP.ESTADO, sheet.getLastRow() - 2, 1).getValues();
  var n = 0;
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0] || '') === 'pendiente_clasif') n++;
  }
  return n;
}

// Handler — cliente tocó "Ver detalle" del digest.
// La ventana se abrió por el tap, mandamos mensaje free-form con
// desglose completo (no cuesta extra dentro de la ventana).
function _digestHandleVerDetalle(from, token, phoneId) {
  var activity = _digestComputeActivity();
  var raw      = activity.raw;
  var hoy      = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd');

  var msg = '📊 *Detalle de hoy (' + hoy + ')*\n\n';

  // Egresos
  if (raw.egCount > 0) {
    var facturasNoTransf = raw.egCount - raw.transfCount;
    msg += '*Egresos*: ' + raw.egCount + ' ($' + raw.egTotal.toFixed(2) + ')\n';
    if (facturasNoTransf > 0) msg += '  · ' + facturasNoTransf + ' factura(s)/gasto(s)\n';
    if (raw.transfCount > 0)  msg += '  · ' + raw.transfCount + ' transferencia(s) BG\n';
  }
  // Ingresos
  if (raw.inCount > 0) {
    msg += '*Ingresos*: ' + raw.inCount + ' ($' + raw.inTotal.toFixed(2) + ')\n';
  }
  if (raw.egCount === 0 && raw.inCount === 0) {
    msg += '_(Sin movimientos registrados)_\n';
  }
  // Pendientes
  if (raw.pendAcr > 0 || raw.pendTr > 0) {
    msg += '\n*Pendientes ahora*:\n';
    if (raw.pendTr > 0)  msg += '  · 📋 ' + raw.pendTr + ' transferencia(s) sin clasificar\n';
    if (raw.pendAcr > 0) msg += '  · 🔍 ' + raw.pendAcr + ' factura(s) sin aprobar\n';
  } else {
    msg += '\n✅ *No hay nada pendiente.*\n';
  }
  msg += '\n_Dashboard:_ ' + 'https://balanceclip.net/' + _digestSlugCliente() + '/';

  _whatsappReply(from, msg, token, phoneId);
}

function _digestSlugCliente() {
  // Best-effort: usa CONFIG.NEGOCIO normalizado, o '' como fallback.
  var n = String(CONFIG.NEGOCIO || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return n.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ════════════════════════════════════════════════════════════════════
//  TRIGGER INSTALLER — idempotente
//  Llamado por inicializarSistema. Si el flag está OFF cuando corre el
//  trigger, simplemente loggea y sale (cero costo). Cuando el cliente
//  active el flag, empieza a mandar sin redeploy.
// ════════════════════════════════════════════════════════════════════

function installDigestTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === '_digestSendDaily') {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }
  ScriptApp.newTrigger('_digestSendDaily')
    .timeBased()
    .atHour(DIGEST_DEFAULT_HOUR)
    .everyDays(1)
    .create();
  Logger.log('✅ Trigger digest instalado — diario a las ' + DIGEST_DEFAULT_HOUR + ':00 ' + (Session.getScriptTimeZone() || 'project tz'));
}
