// ════════════════════════════════════════════════════════════════════
//  BalanceClip Email Watcher — facturas@balanceclip.net
//
//  Apps Script independiente *bound a la cuenta Gmail
//  facturas@balanceclip.net*. Su único trabajo es detectar los emails
//  de confirmación de reenvío que envía Google cuando un usuario
//  configura su Gmail para reenviar a facturas@, extraer el código
//  de verificación, y devolvérselo al usuario por WhatsApp (vía el
//  router).
//
//  Cómo desplegar
//  ──────────────
//    1. Iniciá sesión en Google con facturas@balanceclip.net.
//    2. Abrí https://script.google.com y *Crear proyecto nuevo*.
//    3. Pegá ESTE archivo entero como Code.gs.
//    4. Project Settings → Script Properties:
//         ROUTER_URL          — deployment URL del WhatsApp router
//                               (https://script.google.com/macros/s/<ID>/exec)
//         EMAIL_WATCHER_TOKEN — string aleatorio (compartido con el
//                               router; tiene que ser el MISMO valor).
//    5. En el editor, correr una vez la función `installTrigger()`.
//       Aceptar el permiso de Gmail. Esto crea un trigger time-based
//       que ejecuta `watchInbox()` cada 1 minuto.
//    6. Verificar con `testParse()` (opcional — parsea el último email
//       de google sin marcar nada como leído).
//
//  Flujo
//  ─────
//    1. Usuario hace "configurar email" en WhatsApp y le da su gmail.
//    2. Router guarda email→phone y le dice al usuario los pasos en
//       Gmail.
//    3. Usuario completa el formulario en Gmail. Google manda un mail
//       de confirmación a facturas@balanceclip.net con un magic-link
//       (Google ya no usa códigos numéricos — solo el link).
//    4. Este watcher (corriendo cada 1 min) detecta el mail y extrae
//       el remitente original + el link 'vf-...'.
//    5. Fetchea el link → eso confirma el reenvío automáticamente.
//    6. POSTea al router con { email, status, link } — el router
//       localiza el phone del usuario y le manda el resultado:
//       confirmed → "✅ Verificado, andá a Gmail y marcá la casilla"
//       expired   → "El link expiró, volvé a empezar"
//       otro      → mandar el link como fallback para click manual
//    7. Marca el thread como leído para no reprocesarlo.
// ════════════════════════════════════════════════════════════════════

// ────────────────────────────────────────────────────────────────────
//  Trigger principal — corre cada 1 min vía time-based trigger
// ────────────────────────────────────────────────────────────────────
function watchInbox() {
  var props     = PropertiesService.getScriptProperties();
  var routerUrl = props.getProperty('ROUTER_URL');
  var token     = props.getProperty('EMAIL_WATCHER_TOKEN');
  if (!routerUrl || !token) {
    Logger.log('Faltan ROUTER_URL o EMAIL_WATCHER_TOKEN en Script Properties');
    return;
  }

  // Gmail manda los emails de confirmación desde forwarding-noreply@google.com
  // Filtramos también los últimos 7 días para no escanear el archivo viejo.
  var query = 'from:forwarding-noreply@google.com is:unread newer_than:7d';
  var threads = GmailApp.search(query, 0, 20);
  Logger.log('Threads unread encontrados: ' + threads.length);

  for (var t = 0; t < threads.length; t++) {
    var msgs = threads[t].getMessages();
    for (var m = 0; m < msgs.length; m++) {
      var msg = msgs[m];
      if (!msg.isUnread()) continue;
      try {
        var ok = procesarConfirmacionGmail(msg, routerUrl, token);
        if (ok) msg.markRead();
      } catch(err) {
        Logger.log('Error procesando msg ' + msg.getId() + ': ' + err.message);
        // No marcar como leído — se reintenta en la próxima corrida.
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────
//  Parsea un email de Google de "Forwarding Confirmation" y le dispara
//  el código al router. Devuelve true si se procesó OK (se puede
//  marcar el mail como leído).
// ────────────────────────────────────────────────────────────────────
function procesarConfirmacionGmail(msg, routerUrl, token) {
  var subject = msg.getSubject() || '';
  var body    = msg.getPlainBody() || '';

  // Sólo nos interesan los de confirmación de reenvío
  // (Google también manda notificaciones sobre cambios de configuración
  // que no tienen código — los saltamos).
  var esConfirmacion = /forwarding|reenv[ií]o|confirmation|confirmaci[oó]n/i.test(subject);
  if (!esConfirmacion) {
    Logger.log('No es confirmación, asunto: ' + subject);
    return true; // marcar como leído igual — no nos sirve
  }

  // ── Extraer email del usuario que pidió el reenvío ──
  //   En el cuerpo aparece como "X@example.com has requested..." o
  //   "X@example.com ha solicitado..." según idioma.
  var emailMatch =
    body.match(/([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})\s+(has requested|ha solicitado|wants|quiere)/i) ||
    body.match(/(?:from|de)\s+([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})/i);
  var userEmail = emailMatch ? emailMatch[1].toLowerCase() : null;

  // ── Extraer URL de confirmación ──
  // Google ya no manda un código numérico — el flujo actual es solo
  // un magic-link. El email contiene DOS urls:
  //   vf-[...]  = verify forwarding   ← la que queremos
  //   uf-[...]  = unverify forwarding ← cancelación, NO tocar
  // Filtramos específicamente por 'vf-'.
  var linkMatch = body.match(/https:\/\/mail-settings\.google\.com\/mail\/vf-[^\s\]\)>]+/i);
  var link = linkMatch ? linkMatch[0] : null;

  Logger.log('Parsed: email=' + userEmail + ' link=' + (link ? 'present' : 'none'));

  if (!userEmail || !link) {
    Logger.log('Faltan datos críticos — abortando (subject: ' + subject + ')');
    Logger.log('--- Body excerpt (primeros 1500 chars) para diagnosticar regex ---');
    Logger.log(body.substring(0, 1500));
    Logger.log('--- Fin body excerpt ---');
    // Devolvemos false para NO marcar como leído — quizá Google volvió
    // a generar el mail y el parsing falló por un cambio de formato.
    return false;
  }

  // ── Auto-confirmación: fetchamos el magic-link ──
  // Resultados posibles:
  //   confirmed   → la respuesta indica éxito explícito
  //   expired     → el link ya fue usado o expiró
  //   unclear     → 200 OK pero no detectamos señal de éxito ni de error
  //   http_error  → respuesta no-200
  //   fetch_error → excepción en UrlFetchApp
  var status = 'unclear';
  try {
    var r = UrlFetchApp.fetch(link, {
      method:             'get',
      followRedirects:    true,
      muteHttpExceptions: true,
    });
    var rc = r.getResponseCode();
    var rt = r.getContentText() || '';
    Logger.log('Auto-confirm GET → ' + rc + ' (' + rt.length + ' chars)');
    if (rc === 200) {
      if (/Confirmation Success|been confirmed|successfully confirmed|confirmaci[oó]n (correcta|exitosa)|reenv[ií]o (confirmado|verificado)/i.test(rt)) {
        status = 'confirmed';
      } else if (/expired|already (been )?(used|confirmed)|invalid|expir/i.test(rt)) {
        status = 'expired';
      }
    } else {
      status = 'http_error';
      Logger.log('Auto-confirm response body (primeros 500): ' + rt.substring(0, 500));
    }
  } catch(err) {
    Logger.log('Auto-confirm fetch error: ' + err.message);
    status = 'fetch_error';
  }

  // ── Avisar al router ──
  var payload = {
    action: 'verifyEmailCode',
    token:  token,
    email:  userEmail,
    status: status,
    link:   link,  // el router decide si se lo manda al usuario como fallback
  };
  var resp = UrlFetchApp.fetch(routerUrl, {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true,
    followRedirects:    true,
  });
  Logger.log('Router responded ' + resp.getResponseCode() + ': ' + (resp.getContentText() || '').substring(0, 200));
  return true;
}

// ────────────────────────────────────────────────────────────────────
//  Instala el trigger time-based (correr UNA vez desde el editor)
// ────────────────────────────────────────────────────────────────────
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'watchInbox') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('watchInbox').timeBased().everyMinutes(1).create();
  Logger.log('Trigger instalado: watchInbox cada 1 min.');
}

// ────────────────────────────────────────────────────────────────────
//  Helpers de diagnóstico — correr desde el editor
// ────────────────────────────────────────────────────────────────────
function testConfig() {
  var props = PropertiesService.getScriptProperties();
  var routerUrl = props.getProperty('ROUTER_URL');
  var token     = props.getProperty('EMAIL_WATCHER_TOKEN');
  Logger.log('ROUTER_URL:          ' + (routerUrl ? '✅ ' + routerUrl.substring(0, 50) + '…' : '❌ MISSING'));
  Logger.log('EMAIL_WATCHER_TOKEN: ' + (token ? '✅ set ('+token.length+' chars)' : '❌ MISSING'));
  var triggers = ScriptApp.getProjectTriggers().filter(function(t) { return t.getHandlerFunction() === 'watchInbox'; });
  Logger.log('Trigger watchInbox:  ' + (triggers.length ? '✅ instalado' : '❌ NO instalado (correr installTrigger())'));
}

// Parsea el último email de forwarding sin marcar nada — para debug.
function testParse() {
  var threads = GmailApp.search('from:forwarding-noreply@google.com', 0, 1);
  if (!threads.length) { Logger.log('No hay emails de forwarding-noreply@google.com en el buzón'); return; }
  var msg = threads[0].getMessages()[0];
  var body = msg.getPlainBody() || '';
  Logger.log('Subject: ' + msg.getSubject());
  Logger.log('--- Body (primeros 1500 chars) ---');
  Logger.log(body.substring(0, 1500));
  Logger.log('--- Fin body ---');

  var em = body.match(/([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})\s+(has requested|ha solicitado|wants|quiere)/i);
  var lm = body.match(/https:\/\/mail-settings\.google\.com\/mail\/vf-[^\s\]\)>]+/i);
  Logger.log('Email user: ' + (em ? em[1] : 'NO MATCH'));
  Logger.log('Verify link (vf-): ' + (lm ? lm[0].substring(0,80)+'…' : 'NO MATCH'));
}
