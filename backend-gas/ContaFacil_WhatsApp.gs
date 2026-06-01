// ════════════════════════════════════════════════════════════════════
//  ContaFacil_WhatsApp.gs
//
//  Recepción de facturas vía WhatsApp Business Cloud API (Meta).
//
//  FLUJO
//  ─────
//    1. Cliente envía foto/PDF de factura al número WhatsApp de iris.
//    2. Meta hace POST al webhook (este Apps Script web app).
//    3. Descargamos la media autenticando con el token permanente.
//    4. La IA clasifica: ¿gasto recibido o ingreso emitido?
//    5. Si gasto → se crea pendiente en Acreedores_Pending (mismo flujo
//       que el email forwarding existente). El usuario aprueba desde la app.
//    6. Si ingreso → se crea registro pendiente en Ingresos.
//    7. Respondemos al cliente vía WhatsApp confirmando recepción.
//
//  SCRIPT PROPERTIES requeridas
//  ────────────────────────────
//    META_WHATSAPP_TOKEN  — token permanente (System User) que generaste
//                           en developers.facebook.com
//    META_PHONE_ID        — phone_number_id (1035238479681939 para iris)
//    META_VERIFY_TOKEN    — string que tú eligen, debe coincidir con la
//                           configurada en el Webhook de Meta
//
//  GRAPH API VERSION
//  ─────────────────
//    Usamos v19.0 (estable a 2026). Si Meta deprecia, subir aquí.
// ════════════════════════════════════════════════════════════════════

var META_GRAPH_VERSION = 'v19.0';
var META_GRAPH_BASE    = 'https://graph.facebook.com/' + META_GRAPH_VERSION;

// URL del frontend web para incluir en respuestas de WhatsApp.
// Orden de resolución:
//   1. Script Property FRONTEND_URL (override manual del admin)
//   2. Slug derivado del nombre del negocio en config (empresa_nombre
//      o empresa_comercial, en ese orden). Ej: "Panadería Aurorita"
//      → balanceclip.net/panaderia-aurorita/
//   3. Portal genérico balanceclip.net/
// Antes había un hardcoded a iris-albelo-ho — fix de bug donde
// Aurorita recibía links que apuntaban al panel de Iris.
function _whatsappFrontendUrl() {
  var url = PropertiesService.getScriptProperties().getProperty('FRONTEND_URL');
  if (url) return url;
  try {
    var cfg = _getConfig() || {};
    var raw = String(cfg.empresa_nombre || cfg.empresa_comercial || '');
    var slug = raw.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // quitar tildes/diacríticos
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    if (slug) return 'https://balanceclip.net/' + slug + '/';
  } catch(err) { /* fallthrough */ }
  return 'https://balanceclip.net/';
}

// ────────────────────────────────────────────────────────────────────
//  doGet hook — verificación del webhook (Meta hace GET con hub.challenge)
//  Llamar desde doGet(e) ANTES de cualquier otro routing.
//  Retorna null si la request no es una verificación de WhatsApp.
// ────────────────────────────────────────────────────────────────────
function _whatsappHandleVerify(params) {
  var mode      = params['hub.mode']         || params.hub_mode;
  var token     = params['hub.verify_token'] || params.hub_verify_token;
  var challenge = params['hub.challenge']    || params.hub_challenge;
  if (mode !== 'subscribe' || !challenge) return null;
  var expected  = PropertiesService.getScriptProperties().getProperty('META_VERIFY_TOKEN') || '';
  if (token !== expected) {
    Logger.log('WhatsApp verify FAIL: token recibido=' + token + ' vs esperado=' + (expected ? '(set)' : '(MISSING)'));
    return ContentService.createTextOutput('Forbidden').setMimeType(ContentService.MimeType.TEXT);
  }
  Logger.log('WhatsApp verify OK — devolviendo challenge');
  return ContentService.createTextOutput(String(challenge)).setMimeType(ContentService.MimeType.TEXT);
}

// ────────────────────────────────────────────────────────────────────
//  doPost hook — recepción de mensajes
//  Llamar desde doPost(e) ANTES del routing por `action`.
//  Detecta el payload de Meta y procesa. Retorna null si no aplica.
// ────────────────────────────────────────────────────────────────────
function _whatsappHandleWebhook(data) {
  if (!data) return null;
  // Caso 1: webhook directo de Meta (single-tenant — sin router)
  if (data.object === 'whatsapp_business_account') {
    return _whatsappHandleWebhookMeta(data);
  }
  // Caso 2: forward del Router (multi-tenant)
  if (data.action === 'procesarWhatsAppForward' && data.msg) {
    return _whatsappHandleForward(data);
  }
  return null;
}

// Procesa el payload original de Meta — usado en modo single-tenant
// (cuando el webhook de Meta apunta directo a este GAS sin router).
function _whatsappHandleWebhookMeta(data) {
  try {
    var entries = data.entry || [];
    for (var e = 0; e < entries.length; e++) {
      var changes = entries[e].changes || [];
      for (var c = 0; c < changes.length; c++) {
        var value = changes[c].value || {};
        var msgs  = value.messages || [];
        for (var m = 0; m < msgs.length; m++) {
          try { _whatsappProcesarMensaje(msgs[m], value.metadata || {}); }
          catch(err) { Logger.log('WhatsApp procesarMensaje ERROR: ' + err.message); }
        }
      }
    }
  } catch(err) {
    Logger.log('WhatsApp handleWebhook ERROR: ' + err.message);
  }
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

// Procesa un mensaje individual forwarded por el Router.
// El router ya validó que este mensaje pertenece a este cliente.
function _whatsappHandleForward(data) {
  try {
    _whatsappProcesarMensaje(data.msg || {}, data.metadata || {});
  } catch(err) {
    Logger.log('_whatsappHandleForward ERROR: ' + err.message);
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ────────────────────────────────────────────────────────────────────
//  Procesar un mensaje individual de WhatsApp
// ────────────────────────────────────────────────────────────────────
function _whatsappProcesarMensaje(msg, metadata) {
  var props     = PropertiesService.getScriptProperties();
  var token     = props.getProperty('META_WHATSAPP_TOKEN');
  var phoneId   = props.getProperty('META_PHONE_ID') || (metadata.phone_number_id || '');
  if (!token) { Logger.log('META_WHATSAPP_TOKEN no configurado'); return; }

  var from    = msg.from || '';
  var msgId   = msg.id   || '';
  var tipo    = msg.type || '';
  Logger.log('WhatsApp msg from=' + from + ' type=' + tipo + ' id=' + msgId);

  // ── Idempotencia: ignorar duplicados ──
  // Meta hace retry del webhook si la primera response demora más
  // de su timeout (~20s). Sin esta guarda, cada retry crea otro
  // pendiente o aprueba otra vez el mismo gasto → duplicados.
  if (msgId && _whatsappYaProcesado(msgId)) {
    Logger.log('Mensaje ya procesado anteriormente — ignorando duplicado: ' + msgId);
    return;
  }

  // ── Respuesta interactiva (botón o ítem de lista) ──
  // El usuario tapeó "✅ Aprobar" / "📝 Cambiar categoría" o eligió
  // una categoría del list message.
  if (tipo === 'interactive') {
    _whatsappOnInteractive(msg, from, token, phoneId);
    return;
  }

  // ── Mensaje de texto: responder con instrucciones simples ──
  if (tipo === 'text') {
    var body = (msg.text && msg.text.body) || '';
    _whatsappReply(from, '¡Hola! 👋 Soy el asistente fiscal de BalanceClip.\n\n' +
      'Mándame una foto o PDF de tu factura/recibo y la registro automáticamente. ' +
      'La IA detecta si es gasto o ingreso, le saca el monto, la categoría DGI y la deja pendiente ' +
      'para que la apruebes desde la app:\n' + _whatsappFrontendUrl(), token, phoneId);
    return;
  }

  // ── Media: image o document ──
  if (tipo !== 'image' && tipo !== 'document') {
    _whatsappReply(from, '⚠️ Tipo de mensaje no soportado (' + tipo + '). Envía una foto o PDF.', token, phoneId);
    return;
  }

  var mediaObj = msg[tipo] || {};
  var mediaId  = mediaObj.id || '';
  var mime     = mediaObj.mime_type || (tipo === 'image' ? 'image/jpeg' : 'application/pdf');
  if (!mediaId) { Logger.log('Sin media_id en mensaje ' + msgId); return; }

  // ── Descargar la media ──
  var mediaBlob;
  try {
    mediaBlob = _whatsappDescargarMedia(mediaId, token);
  } catch(err) {
    Logger.log('Error descargando media: ' + err.message);
    _whatsappReply(from, '⚠️ No pude descargar el archivo. Intenta enviarlo de nuevo.', token, phoneId);
    return;
  }

  // ── Clasificar con IA + extraer campos ──
  var parsed;
  try {
    var b64 = Utilities.base64Encode(mediaBlob.getBytes());
    parsed = _whatsappClasificarYExtraer(b64, mime);
  } catch(err) {
    Logger.log('Error IA: ' + err.message);
    _whatsappReply(from, '⚠️ Error procesando el comprobante. ' + err.message, token, phoneId);
    return;
  }

  Logger.log('IA parsed: ' + JSON.stringify(parsed));

  // ── Gate de calidad: validaciones objetivas + auto-eval IA ──
  var calidad = _whatsappValidarCalidad(parsed);
  Logger.log('Calidad: score=' + calidad.score + ' problemas=' + calidad.problemas.join(',') + ' ia_conf=' + calidad.ia_conf + ' ia_legi=' + calidad.ia_legi);

  if (calidad.score < 60) {
    var detalleProblemas = calidad.problemas.length
      ? '*No pude leer:* ' + calidad.problemas.join(', ') + '\n\n'
      : '';
    _whatsappReply(from,
      '⚠️ *No pude procesar el comprobante* (calidad ' + calidad.score + '%)\n\n' +
      detalleProblemas +
      'Por favor reenvíalo con mejor calidad:\n' +
      '📐 Ponelo plano y bien enfocado\n' +
      '💡 Buena iluminación, sin reflejos ni sombras\n' +
      '🔍 Que se lean monto, fecha, proveedor y RUC\n' +
      '📄 Si tienes el PDF original, envía el PDF',
      token, phoneId);
    return;
  }

  if (calidad.score < 80) {
    var avisos = calidad.problemas.length
      ? ' Campos dudosos: ' + calidad.problemas.join(', ') + '.'
      : '';
    _whatsappReply(from,
      '⚠️ *Lectura parcial* (calidad ' + calidad.score + '%). Revisa bien los datos antes de aprobar.' + avisos,
      token, phoneId);
  }

  // ── Guardar según tipo detectado ──
  var resumen;
  try {
    // WhatsApp solo procesa GASTOS por política de producto. La IA puede
    // confundirse y devolver 'ingreso' (esp. cuando razón social difiere
    // del nombre comercial, o cuando los RUCs no matchean exacto). Si lo
    // hace, forzamos a gasto e informamos en el log para revisar después.
    if (parsed.tipo_transaccion === 'ingreso') {
      Logger.log('IA clasificó como ingreso pero WA solo procesa gastos — forzando gasto. RUC recep: ' + (parsed.ruc_receptor || '?') + ' nombre: ' + (parsed.nombre_otro || '?'));
      parsed.tipo_transaccion = 'gasto';
    }
    // Red de seguridad: si la IA devolvió una categoría que pertenece al
    // Form 91 (ingresos), la reseteamos a 'otros_deducibles' para que
    // el gasto quede con una categoría válida del Form 90.
    var CATEGORIAS_INGRESO = [
      'ventas_servicios', 'honorarios_comision', 'alquiler_comercial',
      'alquiler_habitacional', 'intereses_financieros', 'salarios_con_retencion',
      'dietas', 'fuente_extranjera', 'otros_ingresos',
    ];
    if (parsed.categoria_dgi && CATEGORIAS_INGRESO.indexOf(parsed.categoria_dgi) !== -1) {
      Logger.log('IA devolvió categoría de ingreso (' + parsed.categoria_dgi + ') en un gasto — reseteando a otros_deducibles');
      parsed.categoria_dgi = 'otros_deducibles';
    }
    // Sanity check matemático: (subtotal − descuento) + itbms ≈ total.
    // Si no cuadra y total > 0, el cliente probablemente confundió
    // descuento con ITBMS — preferimos confiar en el TOTAL impreso y
    // reset itbms=0 + reset confianza baja para que el cliente revise.
    var sub = Number(parsed.subtotal) || 0;
    var desc = Number(parsed.descuento) || 0;
    var itbms = Number(parsed.itbms) || 0;
    var tot = Number(parsed.total) || 0;
    var calcTot = (sub - desc) + itbms;
    if (tot > 0 && Math.abs(calcTot - tot) > 0.05) {
      // Heurística: si subtotal − itbms ≈ total, la IA probablemente
      // tomó el descuento como itbms. Reseteamos itbms a 0.
      if (Math.abs((sub - itbms) - tot) <= 0.05) {
        Logger.log('Heurística A: itbms (' + itbms + ') parece ser un DESCUENTO. Reseteando itbms=0. tot=' + tot + ' sub=' + sub);
        parsed.descuento = itbms;
        parsed.itbms = 0;
        parsed.tiene_itbms = false;
      } else {
        Logger.log('Sanity check falló: (sub-desc)+itbms=' + calcTot.toFixed(2) + ' != total=' + tot.toFixed(2) + ' — bajando confianza');
      }
      // En cualquier caso de discrepancia, bajamos confianza para que
      // el cliente reciba el warning de "Lectura parcial" y revise.
      parsed.confianza = Math.min(Number(parsed.confianza) || 50, 50);
    }

    // Validación de TASA de ITBMS: en Panamá las tasas válidas son
    // 7% (estándar), 10% (alcohol/tabaco/hospedaje selectivo), o 0%
    // (exento). Cualquier otra ratio itbms/subtotal indica que el
    // número probablemente NO es ITBMS — más probable que sea un
    // descuento o un cargo distinto. Esto cubre el caso donde la
    // matemática cierra pero los conceptos están mal asignados
    // (ej: sub=79.40, itbms=6.70, total=86.10 → ratio 8.4% inválido).
    if (parsed.itbms > 0 && parsed.subtotal > 0) {
      var ratio = parsed.itbms / parsed.subtotal;
      var TASAS_VALIDAS_PANAMA = [0.07, 0.10, 0.15];
      var tolerancia = 0.005; // ±0.5% de tolerancia
      var matcheaTasa = TASAS_VALIDAS_PANAMA.some(function(t) {
        return Math.abs(ratio - t) < tolerancia;
      });
      if (!matcheaTasa) {
        // Solo movemos el valor a descuento si la IA YA había detectado
        // un descuento > 0 (señal de que hay descuento real en el documento
        // que la IA intentó capturar; la confusión fue con itbms). Si la
        // IA reportó descuento=0, probablemente halucinó el itbms — en
        // ese caso solo zeroeamos itbms sin inventar un descuento fantasma.
        var descPrevio = Number(parsed.descuento) || 0;
        if (descPrevio > 0) {
          Logger.log('Heurística B: ITBMS ratio ' + (ratio * 100).toFixed(2) +
                     '% no matchea tasas válidas PA. itbms=' + parsed.itbms +
                     ' sub=' + parsed.subtotal + ' — moviendo a descuento (' +
                     'descuento previo: ' + descPrevio + ').');
          parsed.descuento = descPrevio + parsed.itbms;
        } else {
          Logger.log('Heurística B: ITBMS ratio ' + (ratio * 100).toFixed(2) +
                     '% no matchea tasas válidas PA. itbms=' + parsed.itbms +
                     ' sub=' + parsed.subtotal + ' — probable hallucinación ' +
                     '(IA no reportó descuento). Solo zeroeando itbms ' +
                     'sin crear descuento fantasma.');
        }
        parsed.itbms = 0;
        parsed.tiene_itbms = false;
        parsed.confianza = Math.min(Number(parsed.confianza) || 50, 50);
      }
    }

    // NOTA: aquí había una "Heurística C" que recalculaba parsed.total
    // como (subtotal − descuento) + itbms cuando la matemática no
    // cerraba. RESULTÓ CONTRAPRODUCENTE: cuando la IA leía mal el
    // subtotal pero bien el total, esta heurística inventaba un total
    // erróneo (ej: subtotal=79.30 wrong + total=89.10 correct → heurística
    // sobreescribía a 72.60, número que no existía en la factura).
    //
    // Conclusión empírica: el TOTAL es casi siempre el dato más
    // confiable (número grande y prominente en negrita al final de la
    // factura). Subtotal puede tener errores por descuentos por línea,
    // sumas parciales, etc. Por eso ya NO recalculamos total — solo
    // bajamos confianza si la matemática no cierra, para que el cliente
    // reciba el warning de "Lectura parcial" y revise antes de aprobar.

    resumen = _whatsappGuardarGasto(parsed, mediaBlob, mime, from, msgId);
  } catch(err) {
    Logger.log('Error guardando: ' + err.message);
    _whatsappReply(from, '⚠️ Detecté los datos pero no pude guardar: ' + err.message, token, phoneId);
    return;
  }

  // ── Confirmar al usuario ──
  _whatsappReply(from, resumen, token, phoneId);
}

// ────────────────────────────────────────────────────────────────────
//  Validación de calidad — combina auto-eval IA + validaciones objetivas.
//  Devuelve { score 0-100, ia_conf, ia_legi, problemas:[...] }.
//  Umbrales (en el caller):
//    < 60  → rechazo, pedir reenvío
//    60-79 → aviso de lectura parcial, sigue procesando
//    ≥ 80  → procesamiento normal
// ────────────────────────────────────────────────────────────────────
function _whatsappValidarCalidad(parsed) {
  var ia_conf = Number(parsed && parsed.confianza)   || 0;
  var ia_legi = Number(parsed && parsed.legibilidad) || ia_conf; // fallback si IA no devuelve legibilidad

  var problemas = [];

  var total = Number(parsed && parsed.total) || 0;
  if (total <= 0) problemas.push('monto');

  var fechaStr = parsed && parsed.fecha;
  var fechaValida = fechaStr && /^\d{4}-\d{2}-\d{2}$/.test(String(fechaStr)) && !isNaN(Date.parse(fechaStr));
  if (!fechaValida) problemas.push('fecha');

  var nom = parsed && parsed.nombre_otro;
  if (!nom || String(nom).trim().length < 2) problemas.push('proveedor');

  // RUC del otro (proveedor para gasto, cliente para ingreso) — requiere >=4 dígitos
  var rucOtroDigits = parsed && parsed.ruc_otro ? String(parsed.ruc_otro).replace(/[^0-9]/g, '') : '';
  if (rucOtroDigits.length < 4) problemas.push('RUC');

  // Score = min(confianza IA, legibilidad IA) − penalty por cada validación objetiva fallida
  var base = Math.min(ia_conf, ia_legi);
  var penalty = problemas.length * 15;
  var score = Math.max(0, base - penalty);

  // Hard-fail: sin monto no se puede registrar nada → forzar rechazo
  if (total <= 0) score = Math.min(score, 40);

  return {
    score:     Math.round(score),
    ia_conf:   ia_conf,
    ia_legi:   ia_legi,
    problemas: problemas,
  };
}

// ────────────────────────────────────────────────────────────────────
//  Descarga la media de Meta API
//    Paso 1: GET /<media_id> → { url, mime_type }
//    Paso 2: GET <url> con Bearer token → binary
// ────────────────────────────────────────────────────────────────────
function _whatsappDescargarMedia(mediaId, token) {
  var r1 = UrlFetchApp.fetch(META_GRAPH_BASE + '/' + mediaId, {
    method: 'get',
    headers: { 'Authorization': 'Bearer ' + token },
    muteHttpExceptions: true,
  });
  if (r1.getResponseCode() !== 200) {
    throw new Error('Meta media metadata ' + r1.getResponseCode() + ': ' + r1.getContentText().substring(0, 200));
  }
  var meta = JSON.parse(r1.getContentText());
  if (!meta.url) throw new Error('Meta media metadata sin url');
  var r2 = UrlFetchApp.fetch(meta.url, {
    method: 'get',
    headers: { 'Authorization': 'Bearer ' + token },
    muteHttpExceptions: true,
  });
  if (r2.getResponseCode() !== 200) {
    throw new Error('Meta media download ' + r2.getResponseCode());
  }
  return r2.getBlob();
}

// ────────────────────────────────────────────────────────────────────
//  Envía un mensaje de texto al usuario vía WhatsApp Cloud API
// ────────────────────────────────────────────────────────────────────
function _whatsappReply(to, text, token, phoneId) {
  if (!to || !text || !token || !phoneId) {
    Logger.log('_whatsappReply: faltan params');
    return;
  }
  try {
    UrlFetchApp.fetch(META_GRAPH_BASE + '/' + phoneId + '/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + token },
      payload: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        text: { body: String(text).substring(0, 4096) },
      }),
      muteHttpExceptions: true,
    });
  } catch(err) {
    Logger.log('_whatsappReply ERROR: ' + err.message);
  }
}

// ────────────────────────────────────────────────────────────────────
//  Clasifica (gasto vs ingreso) + extrae campos en un solo Claude call
// ────────────────────────────────────────────────────────────────────
function _whatsappClasificarYExtraer(b64, mime) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY no configurada');

  // Cargar contexto del negocio del config para que el prompt pueda
  // referirse al usuario por nombre + RUC y la IA sepa exactamente
  // qué RUC buscar en la factura (deducibilidad).
  var cfgCtx = {};
  try { cfgCtx = _getConfig() || {}; } catch(e) { /* sigue sin cfg */ }
  var negLegal  = String(cfgCtx.empresa_nombre    || '');
  var negCom    = String(cfgCtx.empresa_comercial || '');
  var negRuc    = String(cfgCtx.empresa_ruc       || '');
  var negDv     = String(cfgCtx.empresa_dv        || '');
  // Si ambos nombres existen y son distintos, los mostramos juntos:
  // razón social + nombre comercial (típico en Panamá: una sociedad como
  // "VENTAS Y MERCADEO S.A" opera bajo el nombre comercial "Panadería
  // Aurorita" — la factura puede tener cualquiera de los dos).
  var negNombre;
  if (negLegal && negCom && negLegal.toLowerCase() !== negCom.toLowerCase()) {
    negNombre = negLegal + '  (también opera como: ' + negCom + ')';
  } else {
    negNombre = negLegal || negCom || 'el usuario';
  }

  // Sanitizar MIME
  if (mime === 'application/octet-stream') mime = 'image/jpeg';
  var validImg = ['image/jpeg','image/png','image/webp','image/gif'];
  var contentBlock;
  if (mime === 'application/pdf') {
    contentBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
  } else {
    var imgMime = validImg.indexOf(mime) >= 0 ? mime : 'image/jpeg';
    contentBlock = { type: 'image', source: { type: 'base64', media_type: imgMime, data: b64 } };
  }

  var prompt =
    'Analiza este comprobante panameño y extraé sus datos de forma ESTRICTA.\n\n' +
    'CONTEXTO DEL USUARIO:\n' +
    '  Nombre:  ' + negNombre + '\n' +
    '  RUC:     ' + (negRuc || '(no configurado)') + (negDv ? '   DV: ' + negDv : '') + '\n\n' +
    'CONTEXTO IMPORTANTE: el usuario está enviando este documento por WhatsApp para registrar un GASTO de su negocio. *TODOS* los comprobantes que llegan por este canal son gastos. NO clasifiques como ingreso bajo ningún concepto.\n\n' +

    '════════════════════════════════════════\n' +
    'REGLAS ESTRICTAS DE EXTRACCIÓN\n' +
    '════════════════════════════════════════\n\n' +

    '1. Solo extraé valores que estén EXPLÍCITAMENTE etiquetados en el documento. NO inventes, NO calculés, NO asumas. Si no está claro, devolvé null o 0 según el tipo.\n\n' +

    '2. **DESCUENTO NO ES ITBMS** — son cosas distintas:\n' +
    '   • ITBMS: impuesto al consumo. Labels en Panamá: "ITBMS", "I.T.B.M.S.", "Imp. 7%", "Impuesto 7%". Tasa OBLIGATORIAMENTE 7%, 10% o 0% (nunca otra).\n' +
    '   • DESCUENTO: bonificación que reduce el subtotal. Labels: "DESCUENTO", "DESC.", "Descuento Total", "Descuentos". NUNCA es lo mismo que ITBMS.\n' +
    '   • Si el documento muestra "ITBMS 0.00" o "ITBMS: -" o no muestra ITBMS pero sí descuento → ITBMS=0. NUNCA pongas el descuento como ITBMS.\n' +
    '   • **VALIDACIÓN OBLIGATORIA antes de devolver itbms > 0**: calculá `itbms / subtotal`. Si NO es ≈0.07 (7%), ≈0.10 (10%) o ≈0.15 (15%), entonces NO ES ITBMS — es otra cosa. Probablemente un descuento. Pone itbms=0 y movelo a descuento.\n' +
    '   • **ITBMS EXENTO**: muchos productos en Panamá no tienen ITBMS (leche, medicamentos, alimentos básicos como pan/arroz, libros, etc.). Las facturas de productos exentos muestran:\n' +
    '       - "Monto Exento ITBMS" ≈ subtotal (toda la base es exenta)\n' +
    '       - "ITBMS: 0.00" o "Total impuesto: 0.00"\n' +
    '       - Tabla "Desglose ITBMS" con todas las filas (Exento, 7%, 10%, 15%) en 0.00 excepto Exento.\n' +
    '       En esos casos: itbms=0, tiene_itbms=false. NO inventes un valor.\n' +
    '   • Si NO ves un label explícito de "ITBMS" con un número visible distinto de 0, devolvé itbms=0. NO calcules el 7% del subtotal "por las dudas".\n\n' +

    '3. **Sanity check matemático obligatorio** — antes de devolver el JSON, verificá:\n' +
    '       (subtotal − descuento) + itbms ≈ total\n' +
    '   Si no cuadra dentro de ±$0.05 → tus valores están mal. Volvé a revisar. Si después de revisar sigue sin cuadrar, REDUCÍ confianza al 40-50% Y prioriza el TOTAL impreso como source of truth (es el monto más prominente en negrita).\n\n' +

    '4. **CAMPOS CRÍTICOS** (prioridad máxima de precisión, en orden):\n' +
    '   a) ruc_otro (RUC del proveedor) — labels: "R.U.C.", "RUC", "RUC Emisor"\n' +
    '   b) ruc_receptor (RUC del cliente) — labels: "R.U.C.", "RUC Cliente", "Cédula"\n' +
    '   c) nombre_otro (proveedor) — razón social del que EMITE\n' +
    '   d) **total (importe FINAL a pagar — SOURCE OF TRUTH)**.\n' +
    '      Es EL CAMPO MÁS IMPORTANTE de toda la extracción. Acertalo siempre.\n' +
    '      Labels válidos: "IMPORTE TOTAL", "Total a Pagar", "Neto a Pagar", "Total General", "Total Final", "Total Pagado".\n' +
    '      ⚠️ "Subtotal", "Total Bruto", "Sub Total" o "Total" antes de descuentos NO son el total final — son intermedios.\n' +
    '      Tip 1: el TOTAL es típicamente el número MÁS PROMINENTE de la factura (negrita grande, fuente más grande, posición al final, posiblemente recuadrado o en línea destacada).\n' +
    '      Tip 2: cuando hay descuento, el TOTAL es el MÁS PEQUEÑO de los "totales" visibles.\n' +
    '      Tip 3: si ves "Son: OCHENTA Y NUEVE CON 10/100" (monto en letras) eso CONFIRMA el total numérico — debe coincidir.\n' +
    '   e) itbms — solo si está LABELED como tal\n' +
    '   f) subtotal — si no estás seguro, devolvé 0 o null. NO inventes. NO sumes valores de líneas si no es obvio. Mejor null que un valor inventado.\n' +
    '   g) fecha\n\n' +

    '5. **CAMPOS DEDUCIDOS** (inferí del contenido):\n' +
    '   • categoria_dgi: del tipo de producto/servicio + naturaleza del proveedor\n' +
    '   • La deducibilidad (negocio vs personal) NO la decides — el sistema compara ruc_receptor con el del config. Vos solo extraé el RUC fielmente.\n\n' +

    'FORMATO DE RUC EN PANAMÁ:\n' +
    '  • Jurídicas: 7 dígitos + DV (ej: 1891245-1-720993 DV 32, 311-77-66961-53)\n' +
    '  • Naturales: la CÉDULA es el RUC (ej: 8-743-456, 4-123-1234, PE-12-3456, N-21-1234, E-8-1234)\n' +
    '  • Si el documento muestra "Cédula" o "Cédula/RUC", ese valor ES el RUC del receptor.\n' +
    '  • No confundir con el número entre paréntesis al lado del nombre (suele ser ID interno del proveedor, NO el RUC).\n\n' +

    'Responde SOLO con JSON válido, sin markdown:\n' +
    '{\n' +
    '  "tipo_transaccion": "gasto",  (siempre "gasto")\n' +
    '  "confianza":         0-100  (qué tan seguro estás de los valores extraídos; bajá si el sanity check no cuadra),\n' +
    '  "legibilidad":       0-100  (calidad visual del documento),\n' +
    '  "fecha":             "YYYY-MM-DD" o null,\n' +
    '  "num_factura":       "..." o null,\n' +
    '  "subtotal":          número (solo si labeled),\n' +
    '  "descuento":         número (solo si labeled — para que el sanity check funcione; 0 si no aplica),\n' +
    '  "itbms":             número (SOLO si labeled como ITBMS/Impuesto; si no, 0),\n' +
    '  "total":             número (importe final a pagar; SOURCE OF TRUTH),\n' +
    '  "tiene_itbms":       true|false (true SOLO si itbms > 0 y está labeled),\n' +
    '  "descripcion":       "..." o null,\n' +
    '  "nombre_otro":       "razón social del proveedor (quien emite la factura)",\n' +
    '  "ruc_otro":          "RUC del proveedor (con guiones)" o null,\n' +
    '  "ruc_receptor":      "RUC del receptor exactamente como aparece (con guiones). Para personas naturales es la cédula. null si no es visible.",\n' +
    '  "categoria_dgi":     "key DGI del Form 90"\n' +
    '}\n\n' +
    'Categorías permitidas para "categoria_dgi" (keys del Anexo 94 / Form 90 — gastos deducibles):\n' +
    '  alquileres (L46), nomina (L42), combustible_transporte (L56), servicios_publicos (L75),\n' +
    '  telecomunicaciones (L71), gastos_oficina (L69), publicidad_mercadeo (L68),\n' +
    '  honorarios_profesionales (L60), seguros (L63-66), mantenimiento_reparacion (L67),\n' +
    '  compras_locales (L28 Costo), compras_importadas (L29 Costo), otros_deducibles (L77 default).\n\n' +
    'PROHIBIDAS (estas son del Form 91 para ingresos — NO usar): ventas_servicios, honorarios_comision, alquiler_comercial, alquiler_habitacional, intereses_financieros, salarios_con_retencion, dietas, fuente_extranjera, otros_ingresos.\n\n' +
    'Si no estás seguro de la categoría, usá "otros_deducibles" como default.';

  var payload = {
    model:      'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{ role: 'user', content: [ contentBlock, { type: 'text', text: prompt } ] }],
  };

  var r = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  if (r.getResponseCode() !== 200) {
    throw new Error('Claude error ' + r.getResponseCode() + ': ' + r.getContentText().substring(0, 200));
  }
  var resp = JSON.parse(r.getContentText());
  var text = '';
  var content = resp.content || [];
  for (var i = 0; i < content.length; i++) {
    if (content[i].type === 'text') { text = content[i].text; break; }
  }
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

// ────────────────────────────────────────────────────────────────────
//  Guardar gasto pendiente — usa la infraestructura existente de
//  Acreedores (find/crear acreedor + crear pendiente)
// ────────────────────────────────────────────────────────────────────
function _whatsappGuardarGasto(parsed, blob, mime, from, msgId) {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);

  // 1. Encontrar o crear acreedor
  var nombreProv = parsed.nombre_otro || 'Proveedor sin identificar';
  var rucProv    = parsed.ruc_otro    || '';
  var catSug     = parsed.categoria_dgi || 'otros_deducibles';
  var acreedor   = _findOrAutoCreateAcreedor(nombreProv, rucProv, catSug);

  // 2. Guardar archivo en Drive
  var fileName = 'WA-' + msgId + '.' + (mime === 'application/pdf' ? 'pdf' : 'jpg');
  blob.setName(fileName);
  var cfg = _getConfig();
  var driveUrl = _guardarPdfAcreedor(blob.getBytes(), fileName, acreedor.nombre, cfg, mime);

  // 3. Crear pendiente — pasamos ruc_receptor extraído por la IA para que
  //    _crearPendiente compute alcance ('negocio' si coincide con empresa_ruc).
  var rucReceptor = String(parsed.ruc_receptor || '').replace(/\s/g, '');
  var clave = 'whatsapp-' + msgId;
  var parsedForPend = {
    fecha:                parsed.fecha       || '',
    num_factura:          parsed.num_factura || '',
    subtotal:             parsed.subtotal    || 0,
    itbms:                parsed.itbms       || 0,
    total:                parsed.total       || 0,
    descripcion:          parsed.descripcion || nombreProv,
    confianza_categoria:  parsed.confianza   || 0,
    categoria_sugerida:   catSug,
    ruc_receptor:         rucReceptor,
  };
  var pendId = _crearPendiente(ss, acreedor, parsedForPend, driveUrl, clave, msgId, fileName);

  // Calcular alcance localmente para mostrar en el mensaje (mismo
  // criterio que _crearPendiente: deducible solo si la factura está
  // a nombre del negocio). La comparación normaliza ambos lados
  // quitando todo lo que no sea alfanumérico, para que match aunque
  // uno tenga guiones/espacios y el otro no (ej: "8-743-456" === "8743456").
  var rucCli = String((cfg && cfg.empresa_ruc) ? cfg.empresa_ruc : '').replace(/\s/g, '');
  function _normRuc(r) { return String(r || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase(); }
  var esDeducible = !!(rucReceptor && rucCli && _normRuc(rucReceptor) === _normRuc(rucCli));
  var lineaDeducible;
  if (!rucCli) {
    lineaDeducible = '⚠️ No deducible (RUC del negocio no configurado en la app)';
  } else if (esDeducible) {
    lineaDeducible = '✅ Deducible (factura a nombre del negocio)';
  } else if (!rucReceptor) {
    lineaDeducible = '🚫 No deducible (factura sin RUC del receptor)';
  } else {
    lineaDeducible = '🚫 No deducible (factura a otro RUC, no al negocio)';
  }

  // Mandar mensaje INTERACTIVO con 2 botones (Aprobar / Cambiar categoría).
  // El usuario decide desde el mismo WhatsApp sin abrir la app.
  // Si los botones fallan o el cliente WA no los soporta, queda el
  // pendiente en la hoja igual y el usuario puede aprobar desde web.
  var props   = PropertiesService.getScriptProperties();
  var token   = props.getProperty('META_WHATSAPP_TOKEN');
  var phoneId = props.getProperty('META_PHONE_ID');

  // URL del dashboard del cliente — derivada del nombre del negocio.
  // Si el cliente quiere ver el PDF completo, editar más campos, o
  // revisar el histórico, lo hace aquí. La aprobación rápida la puede
  // hacer con el botón ✅ Aprobar de abajo.
  var slugDashboard = String((cfg && (cfg.empresa_nombre || cfg.empresa_comercial)) || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  var dashboardUrl = slugDashboard ? ('https://balanceclip.net/' + slugDashboard + '/') : '';

  // Construir la línea de monto con detalles transparentes: si hay
  // ITBMS o descuento, los mostramos para que el cliente pueda validar
  // contra la factura física antes de aprobar.
  var detallesMonto = [];
  if (Number(parsed.descuento) > 0) detallesMonto.push('desc B/. ' + Number(parsed.descuento).toFixed(2));
  if (Number(parsed.itbms)     > 0) detallesMonto.push('ITBMS B/. ' + Number(parsed.itbms).toFixed(2));
  var lineaMonto = '💵 B/. ' + Number(parsed.total || 0).toFixed(2) +
                   (detallesMonto.length ? ' (' + detallesMonto.join(' · ') + ')' : '');
  var bodyTxt = '✅ Gasto recibido\n\n' +
                '📦 ' + (acreedor.nombre || 'Sin proveedor') + '\n' +
                lineaMonto + '\n' +
                '📋 Categoría sugerida: ' + _waCatLabel(catSug) + '\n' +
                lineaDeducible +
                (dashboardUrl
                  ? '\n\n🔗 Ver o aprobar en el panel:\n' + dashboardUrl
                  : '');
  _whatsappReplyBotones(from, bodyTxt, '#' + pendId, [
    { id: 'wa:apr:' + pendId, title: '✅ Aprobar' },
    { id: 'wa:cat:' + pendId, title: '📝 Cambiar categoría' },
    { id: 'wa:rej:' + pendId, title: '❌ Rechazar' },
  ], token, phoneId);

  // Recordatorio (throttled) del reenvío automático por email — para
  // los usuarios que todavía mandan facturas manualmente.
  _whatsappRecordatorioSetupEmail(from, token, phoneId);

  return null;   // ya respondimos con interactive; el caller no envía nada más
}

// ────────────────────────────────────────────────────────────────────
//  Guardar ingreso pendiente — directo en la hoja Ingresos
// ────────────────────────────────────────────────────────────────────
function _whatsappGuardarIngreso(parsed, blob, mime, from, msgId) {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.SHEET_INGRESOS);
  if (!sheet) throw new Error('Hoja Ingresos no encontrada');

  // 1. Guardar archivo en Drive (carpeta vouchers del cliente)
  var fileName = 'WA-ING-' + msgId + '.' + (mime === 'application/pdf' ? 'pdf' : 'jpg');
  blob.setName(fileName);
  var cfg = _getConfig();
  var driveUrl = '';
  try {
    if (CONFIG.VOUCHER_FOLDER_ID) {
      var folder = DriveApp.getFolderById(CONFIG.VOUCHER_FOLDER_ID);
      var file   = folder.createFile(blob);
      driveUrl   = file.getUrl();
    }
  } catch(err) { Logger.log('Drive save ingreso ERROR: ' + err.message); }

  // 2. Generar id_trans
  var ahora    = new Date();
  var stamp    = Utilities.formatDate(ahora, 'America/Panama', 'yyyyMMddHHmmss');
  var idTrans  = 'ING-WA-' + stamp;
  var fechaIng = parsed.fecha || Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd');
  var mes      = parseInt(fechaIng.split('-')[1], 10) || 0;
  var anio     = parseInt(fechaIng.split('-')[0], 10) || 0;

  // 3. Construir fila
  var fila = new Array(INGRESOS_NCOLS);
  for (var i = 0; i < INGRESOS_NCOLS; i++) fila[i] = '';
  fila[COL_I.ID_TRANS - 1]      = idTrans;
  fila[COL_I.FECHA_REG - 1]     = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
  fila[COL_I.ESTADO - 1]        = 'pendiente';
  fila[COL_I.CONFIANZA_IA - 1]  = 'ia_whatsapp';
  fila[COL_I.FECHA_INGRESO - 1] = fechaIng;
  fila[COL_I.MES - 1]           = mes;
  fila[COL_I.ANIO_FISCAL - 1]   = anio;
  fila[COL_I.SUBTOTAL - 1]      = parseFloat(parsed.subtotal || '0') || 0;
  fila[COL_I.ITBMS - 1]         = parseFloat(parsed.itbms    || '0') || 0;
  fila[COL_I.TOTAL - 1]         = parseFloat(parsed.total    || '0') || 0;
  fila[COL_I.MONEDA - 1]        = 'USD';
  fila[COL_I.TIPO_INGRESO - 1]  = 'venta_producto';   // catch-all interno
  fila[COL_I.CATEGORIA - 1]     = parsed.categoria_dgi || 'ventas_servicios';
  fila[COL_I.NOMBRE_CLI - 1]    = parsed.nombre_otro   || 'Cliente sin identificar';
  fila[COL_I.RUC_CLI - 1]       = parsed.ruc_otro      || '';
  fila[COL_I.NUM_FACTURA - 1]   = parsed.num_factura   || '';
  fila[COL_I.TIPO_COMP - 1]     = 'whatsapp';
  fila[COL_I.DRIVE_URL - 1]     = driveUrl;
  fila[COL_I.DESCRIPCION - 1]   = parsed.descripcion   || '';
  fila[COL_I.NOTAS_INT - 1]     = 'WhatsApp from=' + from + ' msg=' + msgId + ' | IA conf=' + (parsed.confianza || 0) + '%';

  var newRow = sheet.getLastRow() + 1;
  sheet.getRange(newRow, 1, 1, INGRESOS_NCOLS).setValues([fila]);
  sheet.getRange(newRow, COL_I.SUBTOTAL, 1, 3).setNumberFormat('#,##0.00');
  sheet.getRange(newRow, 1, 1, INGRESOS_NCOLS).setBackground('#FFF9C4');

  return '✅ Ingreso recibido vía WhatsApp\n\n' +
         '👤 ' + (parsed.nombre_otro || 'Cliente sin identificar') + '\n' +
         '💵 B/. ' + Number(parsed.total || 0).toFixed(2) + (parsed.itbms ? ' (incluye ITBMS B/. ' + Number(parsed.itbms).toFixed(2) + ')' : '') + '\n' +
         '📋 Línea DGI: ' + (parsed.categoria_dgi || 'ventas_servicios') + '\n' +
         '⏳ Pendiente: ' + idTrans + '\n\n' +
         'Confírmalo desde la app: ' + _whatsappFrontendUrl() + '#registroIngresos';
}

// ────────────────────────────────────────────────────────────────────
//  Helper de prueba — usar desde el Apps Script editor para validar
//  conectividad con Meta antes del primer mensaje real.
// ────────────────────────────────────────────────────────────────────
function whatsappTestConfig() {
  var props = PropertiesService.getScriptProperties();
  var token   = props.getProperty('META_WHATSAPP_TOKEN');
  var phoneId = props.getProperty('META_PHONE_ID');
  var verify  = props.getProperty('META_VERIFY_TOKEN');
  Logger.log('META_WHATSAPP_TOKEN: ' + (token  ? '✅ set ('+token.substring(0,20)+'…)' : '❌ MISSING'));
  Logger.log('META_PHONE_ID:       ' + (phoneId? '✅ ' + phoneId : '❌ MISSING'));
  Logger.log('META_VERIFY_TOKEN:   ' + (verify ? '✅ set' : '❌ MISSING'));
  if (!token || !phoneId) return;
  // Verificar el phone number existe
  var r = UrlFetchApp.fetch(META_GRAPH_BASE + '/' + phoneId, {
    headers: { 'Authorization': 'Bearer ' + token },
    muteHttpExceptions: true,
  });
  Logger.log('GET phone ' + r.getResponseCode() + ': ' + r.getContentText().substring(0, 400));
}

// ════════════════════════════════════════════════════════════════════
//  INTERACCIÓN — botones + listas Meta Cloud API
//
//  Al recibir una factura, el bot responde con 2 botones:
//    [ ✅ Aprobar ]  [ 📝 Cambiar categoría ]
//
//  Si el usuario tapea "Cambiar", mostramos una lista interactiva con
//  las categorías DGI agrupadas. Al elegir una, actualizamos el
//  pendiente y lo aprobamos en una sola acción.
//
//  Formato de IDs de botones/listas
//  ────────────────────────────────
//    "wa:apr:<pendId>"           — aprobar tal cual
//    "wa:cat:<pendId>"           — abrir lista de categorías
//    "wa:set:<pendId>:<key>"     — setear categoría y aprobar
//    "wa:rej:<pendId>"           — rechazar (lectura mala, duplicado)
// ════════════════════════════════════════════════════════════════════

// Catálogo de categorías para el list message — Meta limita a 10 FILAS
// TOTALES (no por sección). Selección curada por el usuario para
// cubrir los gastos más frecuentes; las menos comunes se hacen vía
// web app desde el link del cuerpo del mensaje.
var WA_CAT_SECTIONS = [
  { title: 'Gastos', rows: [
    { key: 'atencion_promocion_clientes', title: 'Atención y Promoción',     desc: 'G3 · clientes, publicidad' },
    { key: 'transporte',                  title: 'Transporte',               desc: 'G5 · combustible, taxi' },
    { key: 'impuestos',                   title: 'Impuestos',                desc: 'G11' },
    { key: 'gastos_oficina',              title: 'Gastos de Oficina',       desc: 'G13' },
    { key: 'mantenimiento',               title: 'Mantenimiento',            desc: 'G20' },
    { key: 'servicios_basicos',           title: 'Electricidad/Agua/Tel.',   desc: 'G21' },
    { key: 'seguros',                     title: 'Seguros',                  desc: 'G22' },
    { key: 'otros_gastos',                title: 'Otros Gastos',             desc: 'G23 · catch-all' },
    { key: 'gastos_fuente_extranjera',    title: 'Gastos Fuente Extranjera', desc: 'G24' },
  ]},
  { title: 'Compras (Costo de venta)', rows: [
    { key: 'compras_locales',             title: 'Compras - Locales',        desc: 'C1' },
  ]},
];

// Diccionario plano para etiquetar una key cuando se muestra al usuario
function _waCatLabel(key) {
  for (var s = 0; s < WA_CAT_SECTIONS.length; s++) {
    var rows = WA_CAT_SECTIONS[s].rows;
    for (var r = 0; r < rows.length; r++) {
      if (rows[r].key === key) return rows[r].title;
    }
  }
  return key;
}

// ────────────────────────────────────────────────────────────────────
//  Envía un mensaje interactivo con 2 o 3 botones de respuesta
// ────────────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────────
//  Recordatorio del flujo de setup de reenvío automático por email.
//  Se invoca después de procesar cada factura. Throttle: 1 vez cada 6h
//  por número, para no spamear a quien manda muchas facturas seguidas.
//  El botón emite id 'setup:start' que el ROUTER intercepta y dispara
//  el flujo de configuración (provider list → email → instrucciones).
// ────────────────────────────────────────────────────────────────────
function _whatsappRecordatorioSetupEmail(to, token, phoneId) {
  var props = PropertiesService.getScriptProperties();
  var key   = 'last_setup_reminder_' + to;
  var last  = Number(props.getProperty(key) || 0);
  if (Date.now() - last < 6 * 60 * 60 * 1000) return;
  props.setProperty(key, String(Date.now()));

  _whatsappReplyBotones(to,
    '💡 *Tip*: configura reenvío automático desde tu email y olvidate de mandar facturas a mano. Lo haces *una vez por proveedor* y queda funcionando para siempre.',
    null,
    [{ id: 'setup:start', title: '📧 Cómo configurar' }],
    token, phoneId
  );
}

function _whatsappReplyBotones(to, bodyText, footerText, buttons, token, phoneId) {
  if (!to || !buttons || !buttons.length || !token || !phoneId) {
    Logger.log('_whatsappReplyBotones: faltan params');
    return;
  }
  var btns = buttons.slice(0, 3).map(function(b) {
    return { type: 'reply', reply: { id: String(b.id).substring(0, 256), title: String(b.title).substring(0, 20) } };
  });
  var payload = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'interactive',
    interactive: {
      type:   'button',
      body:   { text: String(bodyText || '').substring(0, 1024) },
      action: { buttons: btns },
    },
  };
  if (footerText) payload.interactive.footer = { text: String(footerText).substring(0, 60) };
  try {
    var r = UrlFetchApp.fetch(META_GRAPH_BASE + '/' + phoneId + '/messages', {
      method:             'post',
      contentType:        'application/json',
      headers:            { 'Authorization': 'Bearer ' + token },
      payload:            JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    if (r.getResponseCode() !== 200) {
      Logger.log('Reply botones falló ' + r.getResponseCode() + ': ' + r.getContentText().substring(0, 200));
    }
  } catch(err) { Logger.log('_whatsappReplyBotones ERROR: ' + err.message); }
}

// ────────────────────────────────────────────────────────────────────
//  Envía un mensaje interactivo con lista seleccionable
//  sections: [{ title: 'Sección', rows: [{ id, title, description }] }]
// ────────────────────────────────────────────────────────────────────
function _whatsappReplyLista(to, bodyText, listButtonText, sections, token, phoneId) {
  if (!to || !sections || !sections.length || !token || !phoneId) {
    Logger.log('_whatsappReplyLista: faltan params');
    return false;
  }
  var sec = sections.slice(0, 10).map(function(s) {
    return {
      title: String(s.title || '').substring(0, 24),
      rows: (s.rows || []).slice(0, 10).map(function(row) {
        var o = {
          id:    String(row.id).substring(0, 200),
          title: String(row.title || '').substring(0, 24),
        };
        if (row.description) o.description = String(row.description).substring(0, 72);
        return o;
      }),
    };
  });
  var payload = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'interactive',
    interactive: {
      type:   'list',
      body:   { text: String(bodyText || '').substring(0, 1024) },
      action: { button: String(listButtonText || 'Elegir').substring(0, 20), sections: sec },
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
    if (code !== 200) {
      Logger.log('Reply lista FAIL ' + code + ': ' + r.getContentText().substring(0, 600));
      Logger.log('Payload enviado: ' + JSON.stringify(payload).substring(0, 600));
      return false;
    }
    return true;
  } catch(err) {
    Logger.log('_whatsappReplyLista ERROR: ' + err.message);
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────
//  Despacha respuestas interactivas (botón o lista)
// ────────────────────────────────────────────────────────────────────
function _whatsappOnInteractive(msg, from, token, phoneId) {
  var inter = msg.interactive || {};
  var id    = '';
  if (inter.type === 'button_reply') {
    id = (inter.button_reply || {}).id || '';
  } else if (inter.type === 'list_reply') {
    id = (inter.list_reply || {}).id || '';
  } else {
    Logger.log('Tipo interactivo desconocido: ' + inter.type);
    return;
  }
  Logger.log('Interactive id=' + id + ' from=' + from);

  // Formato: "wa:<accion>:<pendId>[:<key>]"
  var parts = String(id || '').split(':');
  if (parts[0] !== 'wa') {
    Logger.log('ID no es de WhatsApp callback: ' + id);
    return;
  }
  var accion = parts[1];
  var pendId = parts[2];
  if (accion === 'apr')      _whatsappOnAprobar(pendId, from, token, phoneId);
  else if (accion === 'cat') _whatsappOnCambiarCat(pendId, from, token, phoneId);
  else if (accion === 'set') _whatsappOnSetCat(pendId, parts[3] || '', from, token, phoneId);
  else if (accion === 'rej') _whatsappOnRechazar(pendId, from, token, phoneId);
  else Logger.log('Acción desconocida: ' + accion);
}

// ────────────────────────────────────────────────────────────────────
//  Acción: Rechazar el pendiente (lectura mala, duplicado, etc.)
//  No borramos la fila — la marcamos como 'rechazado' en estado para
//  que quede auditable si después aparece reclamo. _handleRechazarAcreedor
//  ya hace exactamente eso (mismo handler que usa el panel web).
// ────────────────────────────────────────────────────────────────────
function _whatsappOnRechazar(pendId, from, token, phoneId) {
  if (!pendId) { _whatsappReply(from, '⚠️ ID inválido.', token, phoneId); return; }
  try {
    var res = _handleRechazarAcreedor({ id: pendId });
    var json = JSON.parse(res.getContent());
    if (!json.success) {
      _whatsappReply(from, '⚠️ No pude rechazar ' + pendId + ': ' + (json.error || 'error desconocido'), token, phoneId);
      return;
    }
    _whatsappReply(from,
      '❌ Descartado: ' + pendId + '\n\n' +
      'Si la lectura fue mala, reenviá la foto/PDF con mejor calidad:\n' +
      '📐 Plano, bien enfocado\n' +
      '💡 Buena luz, sin reflejos\n' +
      '🔍 Que se lean monto, fecha y RUC',
      token, phoneId);
  } catch(err) {
    _whatsappReply(from, '⚠️ Error rechazando: ' + err.message, token, phoneId);
  }
}

// ────────────────────────────────────────────────────────────────────
//  Acción: Aprobar el pendiente (mismo handler que la web app)
// ────────────────────────────────────────────────────────────────────
function _whatsappOnAprobar(pendId, from, token, phoneId) {
  if (!pendId) { _whatsappReply(from, '⚠️ ID inválido.', token, phoneId); return; }
  try {
    var res = _handleAprobarAcreedor({ id: pendId });
    var json = JSON.parse(res.getContent());
    if (!json.success) {
      _whatsappReply(from, '⚠️ No pude aprobar ' + pendId + ': ' + (json.error || 'error desconocido'), token, phoneId);
      return;
    }
    _whatsappReply(from, '✅ Aprobado y registrado en Egresos.\n' + pendId + ' → ' + (json.egreso_id || ''), token, phoneId);
  } catch(err) {
    _whatsappReply(from, '⚠️ Error aprobando: ' + err.message, token, phoneId);
  }
}

// ────────────────────────────────────────────────────────────────────
//  Acción: Abrir la lista de categorías para que el usuario elija
// ────────────────────────────────────────────────────────────────────
function _whatsappOnCambiarCat(pendId, from, token, phoneId) {
  if (!pendId) { _whatsappReply(from, '⚠️ ID inválido.', token, phoneId); return; }
  // Construir secciones con IDs que incluyan el pendId
  var sections = WA_CAT_SECTIONS.map(function(s) {
    return {
      title: s.title,
      rows: s.rows.map(function(r) {
        return { id: 'wa:set:' + pendId + ':' + r.key, title: r.title, description: r.desc };
      }),
    };
  });
  var ok = _whatsappReplyLista(from,
    'Elige la categoría DGI correcta para ' + pendId + '.\n' +
    '(¿No está la que buscas? Abre la app desde: ' + _whatsappFrontendUrl() + '#registroGastos)',
    'Ver categorías',
    sections, token, phoneId);
  // Si Meta rechaza el list message (p.ej. límites no documentados),
  // mandar un fallback de texto para que el usuario sepa qué hacer.
  if (!ok) {
    _whatsappReply(from,
      '⚠️ No pude mostrar la lista de categorías en WhatsApp.\n\n' +
      'Cambia la categoría desde la app:\n' + _whatsappFrontendUrl() + '#registroGastos',
      token, phoneId);
  }
}

// ────────────────────────────────────────────────────────────────────
//  Acción: Setear categoría elegida + auto-aprobar + APRENDER preferencia
//  Cuando el cliente cambia la categoría desde WhatsApp, persistimos
//  la elección en Acreedores_Config.categoria_def para que la próxima
//  factura del MISMO proveedor use esta categoría automáticamente.
// ────────────────────────────────────────────────────────────────────
function _whatsappOnSetCat(pendId, nuevaKey, from, token, phoneId) {
  if (!pendId || !nuevaKey) { _whatsappReply(from, '⚠️ Datos inválidos.', token, phoneId); return; }
  try {
    // 0. Capturar info del proveedor ANTES de aprobar — la usamos para
    //    persistir la preferencia. Si falla, no rompe el flujo de aprobación.
    var acrInfo = _whatsappLookupAcreedorDePending(pendId);

    // 1. Actualizar la categoría del pendiente
    var upd = _handleActualizarPendienteAcr({ id: pendId, categoria: nuevaKey });
    var updJson;
    try { updJson = JSON.parse(upd.getContent()); } catch(e) { updJson = { success: false, error: 'parse' }; }
    if (!updJson.success) {
      _whatsappReply(from, '⚠️ No pude actualizar la categoría: ' + (updJson.error || ''), token, phoneId);
      return;
    }

    // 2. Aprobar automáticamente con la nueva categoría
    var apr = _handleAprobarAcreedor({ id: pendId });
    var aprJson = JSON.parse(apr.getContent());
    if (!aprJson.success) {
      _whatsappReply(from, '⚠️ Categoría cambiada pero no pude aprobar: ' + (aprJson.error || ''), token, phoneId);
      return;
    }

    // 3. Persistir preferencia de categoría para este proveedor — feedback
    //    loop para que la IA "aprenda" de las correcciones del cliente.
    var aprendio = false;
    if (acrInfo && (acrInfo.nombre || acrInfo.ruc)) {
      try {
        _handleGuardarPreferencia({
          nombre:    acrInfo.nombre || '',
          ruc:       acrInfo.ruc    || '',
          categoria: nuevaKey,
        });
        aprendio = true;
        Logger.log('🎓 Preferencia aprendida: ' + (acrInfo.nombre || acrInfo.ruc) + ' → ' + nuevaKey);
      } catch(err) {
        Logger.log('⚠️ No pude persistir preferencia (sigue OK la aprobación): ' + err.message);
      }
    }

    var msgAprendio = aprendio
      ? '\n\n🎓 La próxima factura de *' + (acrInfo.nombre || acrInfo.ruc) + '* se va a categorizar como *' + _waCatLabel(nuevaKey) + '* automáticamente.'
      : '';

    _whatsappReply(from,
      '✅ Categoría actualizada a "' + _waCatLabel(nuevaKey) + '" y aprobado.\n' +
      pendId + ' → ' + (aprJson.egreso_id || '') +
      msgAprendio,
      token, phoneId);
  } catch(err) {
    _whatsappReply(from, '⚠️ Error: ' + err.message, token, phoneId);
  }
}

// ────────────────────────────────────────────────────────────────────
//  Lookup del proveedor (nombre + RUC) que origina un pendiente dado.
//  Cruza Acreedores_Pending → Acreedores_Config por acreedor_id para
//  obtener el RUC (que no vive en Pending directamente).
//  Devuelve { nombre, ruc, acreedor_id } o null si no encuentra.
// ────────────────────────────────────────────────────────────────────
function _whatsappLookupAcreedorDePending(pendId) {
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    // Pending → acreedor_nom + acreedor_id
    var p = ss.getSheetByName(SHEET_ACREEDORES_PENDING);
    if (!p || p.getLastRow() <= 2) return null;
    var data = p.getRange(3, 1, p.getLastRow() - 2, PEND_NCOLS).getValues();
    var nombre = '', acrId = '';
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][COL_PEND.ID - 1]) === String(pendId)) {
        nombre = String(data[i][COL_PEND.ACREEDOR_NOM - 1] || '');
        acrId  = String(data[i][COL_PEND.ACREEDOR_ID  - 1] || '');
        break;
      }
    }
    if (!nombre && !acrId) return null;

    // Lookup RUC desde Acreedores_Config (opcional — si no hay match
    // devolvemos solo el nombre, _handleGuardarPreferencia acepta ambos).
    var ruc = '';
    if (acrId) {
      var c = ss.getSheetByName(SHEET_ACREEDORES_CONFIG);
      if (c && c.getLastRow() > 2) {
        var cdata = c.getRange(3, 1, c.getLastRow() - 2, ACR_NCOLS).getValues();
        for (var j = 0; j < cdata.length; j++) {
          if (String(cdata[j][COL_ACR.ID - 1]) === String(acrId)) {
            ruc = String(cdata[j][COL_ACR.RUC - 1] || '');
            break;
          }
        }
      }
    }
    return { nombre: nombre, ruc: ruc, acreedor_id: acrId };
  } catch(err) {
    Logger.log('_whatsappLookupAcreedorDePending error: ' + err.message);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════
//  Diagnóstico — ejecutar desde el Apps Script editor para debuggear
//  el envío del list message sin necesidad de mirar Executions.
//
//  Pasos:
//    1. Edita la línea TEST_FROM y TEST_PENDID abajo con tu celular
//       (formato 507XXXXXXXX) y un PENDR válido del sheet.
//    2. Guarda el archivo.
//    3. Dropdown del botón Run → seleccionar `whatsappTestLista`.
//    4. Run → Ctrl+Enter (o View → Logs) para ver los Logger.log.
//
//  Si Meta rechaza el list, vas a ver el código + cuerpo exacto del
//  error + el payload enviado en los logs.
// ════════════════════════════════════════════════════════════════════
function whatsappTestLista() {
  var TEST_FROM   = '507TUCELULAR';            // ← cambia por tu número
  var TEST_PENDID = 'PENDR-202605-0058';       // ← cambia por un PENDR real

  var props   = PropertiesService.getScriptProperties();
  var token   = props.getProperty('META_WHATSAPP_TOKEN');
  var phoneId = props.getProperty('META_PHONE_ID');
  if (!token || !phoneId) { Logger.log('❌ Faltan META_WHATSAPP_TOKEN o META_PHONE_ID'); return; }
  if (TEST_FROM === '507TUCELULAR') { Logger.log('⚠️ Edita TEST_FROM con tu celular real antes de correr'); return; }

  Logger.log('▶ Llamando _whatsappOnCambiarCat con pendId=' + TEST_PENDID + ' from=' + TEST_FROM);
  _whatsappOnCambiarCat(TEST_PENDID, TEST_FROM, token, phoneId);
  Logger.log('✅ Función terminó. Revisa los logs arriba para ver el resultado del envío.');
}

// ════════════════════════════════════════════════════════════════════
//  Idempotencia — evitar procesar el mismo mensaje dos veces
//
//  Meta puede mandar el mismo webhook múltiples veces (timeout, retry,
//  o duplicates de su lado). Cada mensaje tiene un msg.id único que
//  podemos usar como token de deduplicación.
//
//  Usamos CacheService (in-memory shared cache de Apps Script, TTL
//  máximo 6 horas). Si necesitamos persistencia más larga, migrar a
//  Properties — pero 6h es suficiente: los retries de Meta ocurren
//  dentro de minutos, no horas.
// ════════════════════════════════════════════════════════════════════
function _whatsappYaProcesado(msgId) {
  if (!msgId) return false;
  var cache = CacheService.getScriptCache();
  var key   = 'wa_msg_' + msgId;
  if (cache.get(key)) return true;
  cache.put(key, '1', 21600);   // 6h (máximo permitido)
  return false;
}
