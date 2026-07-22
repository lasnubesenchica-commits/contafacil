// ════════════════════════════════════════════════════════════════════
//  _LasNubes.gs — Handler multi-system para el negocio de cabañas
//  ──────────────────────────────────────────────────────────────────
//  Cuando el admin (50769812266) elige "Las Nubes" en el picker de
//  multi-system, los mensajes se procesan acá en vez de forwardearse
//  a un GAS cliente. Este módulo:
//    1. Descarga la imagen/PDF desde Meta.
//    2. La sube al folder de Drive de Las Nubes.
//    3. Llama a Claude Vision para extraer campos del gasto.
//    4. Muestra un preview + botones [General] [Verde] [Lila].
//    5. Al aprobar, escribe fila(s) al tab "Egresos" del Sheet.
//    6. "rechazar" descarta y borra el archivo de Drive.
//
//  Config (Script Properties del router):
//    CLAUDE_API_KEY              — API key de Anthropic (ya existe).
//    LAS_NUBES_DRIVE_FOLDER_ID   — folder donde suben comprobantes.
//                                  Default: 1gP-ZvBe1jfsqbw04d-kUuAHEe8GLTPXC
//
//  Storage temporal (Script Property, 24h TTL):
//    lasNubesPend_<phone> = { items, driveFileId, driveUrl, sheetId, ts }
//    Solo un pending por phone a la vez. Uploads adicionales lo reemplazan
//    (con warning en el Log si sobrescribe uno no aprobado).
// ════════════════════════════════════════════════════════════════════

var LAS_NUBES_DEFAULT_FOLDER = '1gP-ZvBe1jfsqbw04d-kUuAHEe8GLTPXC';
var LAS_NUBES_PEND_TTL_MS    = 24 * 60 * 60 * 1000; // 24h

// Dispatcher — se llama desde _routerDispatchToSystem cuando type=sheet_direct.
function _lasNubesHandle(system, msg, from, token, phoneId) {
  var sheetId = system.sheetId || '';
  if (!sheetId) {
    _routerSendText(from, '⚠️ Sheet ID de Las Nubes no configurado.', token, phoneId);
    return;
  }
  var tipo = msg.type;

  // Botón de aprobación → guardar en el Sheet.
  if (tipo === 'interactive') {
    var iaReply = msg.interactive || {};
    var btnId = (iaReply.list_reply   && iaReply.list_reply.id)   ||
                (iaReply.button_reply && iaReply.button_reply.id) || '';
    if (btnId.indexOf('ln:apr:') === 0) {
      var cabana = btnId.substring('ln:apr:'.length);
      _lasNubesHandleApproval(from, cabana, sheetId, token, phoneId);
      return;
    }
    // Botón interactivo desconocido → ignorar
    Logger.log('LasNubes: interactive sin handler: ' + btnId);
    return;
  }

  // Comando "rechazar" o "no" → descartar el pending si existe.
  if (tipo === 'text') {
    var body = (msg.text && msg.text.body) ? String(msg.text.body).toLowerCase().trim() : '';
    if (body === 'rechazar' || body === 'no' || body === 'cancelar') {
      _lasNubesHandleReject(from, token, phoneId);
      return;
    }
    // Cualquier otro texto → guía rápida.
    _routerSendText(from,
      '🏡 *Modo Las Nubes activo*\n\n' +
      'Mandame una foto o PDF de un gasto y lo registro en el Sheet.\n\n' +
      '• Para elegir otro sistema: *cambiar*\n' +
      '• Para descartar un gasto pendiente: *rechazar*',
      token, phoneId);
    return;
  }

  // Media (imagen o documento) → procesar.
  if (tipo === 'image' || (tipo === 'document' && _lasNubesEsFacturaDoc(msg))) {
    _lasNubesProcessMedia(msg, from, sheetId, token, phoneId);
    return;
  }

  // Otros tipos (audio, sticker, video) → no soportado por ahora.
  _routerSendText(from,
    '🤔 Solo puedo procesar *fotos* o *PDFs* de gastos en Las Nubes.',
    token, phoneId);
}

// Detecta si un document es una factura procesable (jpg, png, pdf).
function _lasNubesEsFacturaDoc(msg) {
  var doc = msg.document || {};
  var mime = String(doc.mime_type || '').toLowerCase();
  if (mime.indexOf('image/') === 0) return true;
  if (mime === 'application/pdf')   return true;
  var filename = String(doc.filename || '').toLowerCase();
  return /\.(jpg|jpeg|png|pdf|webp|heic)$/.test(filename);
}

// ────────────────────────────────────────────────────────────────────
//  Procesar nueva media: descargar → Drive → Claude → preview
// ────────────────────────────────────────────────────────────────────
function _lasNubesProcessMedia(msg, from, sheetId, token, phoneId) {
  var mediaObj = msg.image || msg.document || {};
  var mediaId  = mediaObj.id;
  if (!mediaId) {
    _routerSendText(from, '⚠️ El mensaje no incluye media id.', token, phoneId);
    return;
  }

  // Si ya había un pending sin aprobar, avisar y sobrescribir.
  var existing = _lasNubesGetPending(from);
  if (existing) {
    Logger.log('LasNubes: reemplazando pending previo de ' + from + ' (había ' + (existing.items || []).length + ' item(s))');
  }

  _routerSendText(from, '⏳ Procesando factura para *Las Nubes*…', token, phoneId);

  // 1. Descargar blob.
  var blob;
  try { blob = _whatsappDescargarMedia(mediaId, token); }
  catch(err) {
    Logger.log('LasNubes: descarga falló — ' + err.message);
    _routerSendText(from, '⚠️ No pude bajar el archivo de WhatsApp. Reintenta.', token, phoneId);
    return;
  }

  var mime     = String(blob.getContentType() || 'image/jpeg').toLowerCase();
  var ext      = (mime === 'application/pdf') ? 'pdf' : (mime.split('/')[1] || 'jpg');
  var filename = 'LN-' + Date.now() + '.' + ext;

  // 2. Subir a Drive.
  var driveInfo;
  try { driveInfo = _lasNubesSubirADrive(blob, filename); }
  catch(err) {
    Logger.log('LasNubes: upload a Drive falló — ' + err.message);
    _routerSendText(from, '⚠️ No pude subir a Drive: ' + err.message, token, phoneId);
    return;
  }

  // 3. Extraer con Claude.
  var extracted;
  try { extracted = _lasNubesExtractExpense(blob, mime); }
  catch(err) {
    Logger.log('LasNubes: Claude falló — ' + err.message);
    _routerSendText(from,
      '⚠️ No pude extraer los datos automáticamente.\n\n' +
      'Foto guardada en Drive: ' + driveInfo.url + '\n\n' +
      'Podés escribir *rechazar* y volver a mandarla, o subir directo al Sheet.',
      token, phoneId);
    return;
  }

  var items = (extracted && extracted.items) || [];
  if (!items.length) {
    _routerSendText(from,
      '🤔 No detecté ningún gasto en la imagen.\n\n' +
      'Foto guardada en Drive: ' + driveInfo.url + '\n\n' +
      'Reintenta con una foto más clara, o escribí *rechazar*.',
      token, phoneId);
    _lasNubesClearPending(from);
    return;
  }

  // 4. Guardar pending.
  _lasNubesSetPending(from, {
    items:       items,
    driveFileId: driveInfo.id,
    driveUrl:    driveInfo.url,
    sheetId:     sheetId,
    ts:          Date.now(),
  });

  // 5. Mandar preview + botones.
  _lasNubesSendApprovalPrompt(from, items, driveInfo.url, token, phoneId);
}

// ────────────────────────────────────────────────────────────────────
//  Drive: subir la factura al folder de Las Nubes
// ────────────────────────────────────────────────────────────────────
function _lasNubesSubirADrive(blob, filename) {
  var folderId = PropertiesService.getScriptProperties().getProperty('LAS_NUBES_DRIVE_FOLDER_ID') || LAS_NUBES_DEFAULT_FOLDER;
  var folder;
  try { folder = DriveApp.getFolderById(folderId); }
  catch(e) { throw new Error('folder ' + folderId + ' no accesible: ' + e.message); }

  blob.setName(filename);
  var file = folder.createFile(blob);

  // URL de vista pública para poder abrirla desde el sheet.
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }
  catch(e) { Logger.log('LasNubes: no pude setear sharing (ok, puede ser folder policy): ' + e.message); }

  return { id: file.getId(), url: file.getUrl() };
}

// ────────────────────────────────────────────────────────────────────
//  Claude: extraer campos del gasto
//  Retorna { items: [{fecha, descripcion, monto, categoria, proveedor}, ...] }
// ────────────────────────────────────────────────────────────────────
function _lasNubesExtractExpense(blob, mime) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY no configurada');

  // Claude vision solo acepta imágenes. Si es PDF, base64-encode con
  // media_type application/pdf (Claude puede procesar PDFs).
  var b64 = Utilities.base64Encode(blob.getBytes());
  var contentBlock;
  if (mime === 'application/pdf') {
    contentBlock = {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: b64 },
    };
  } else {
    var mediaType = mime && mime.indexOf('image/') === 0 ? mime : 'image/jpeg';
    contentBlock = {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: b64 },
    };
  }

  var prompt =
    'Este es un comprobante de gasto de "Las Nubes", un negocio de cabañas de alquiler en Panamá. ' +
    'Analizá la imagen/PDF y extraé cada ítem del comprobante.\n\n' +
    'Contexto para categorizar:\n' +
    '• Suministros: productos consumibles (papel higiénico, jabón, agua, gas, hielo, comida, etc.)\n' +
    '• Publicidad: pauta Instagram/Meta/Google, servicios de marketing\n' +
    '• Mantenimiento: reparaciones, herramientas, pintura, plomería, eléctrico, ferretería general\n' +
    '• Limpieza: pagos a personal de limpieza, servicios de aseo\n' +
    '• Basura: recolección o disposición de basura\n' +
    '• Servicios: internet, agua, luz, mensajería no-material, videos, grabaciones\n' +
    '• Delivery: solo delivery/mensajería/transporte\n' +
    '• Prestamo: pagos de préstamo, financiamiento, cuotas mensuales fijas\n' +
    '• Otro: si nada calza\n\n' +
    'REGLAS:\n' +
    '• Fecha en formato YYYY-MM-DD. Si no la ves, dejá null.\n' +
    '• Monto: solo el número (sin símbolo). Punto decimal.\n' +
    '• Proveedor — ATENCIÓN, depende del tipo de comprobante:\n' +
    '    - FACTURA FISCAL (con RUC, encabezado formal): el proveedor es el EMISOR (quien facturó).\n' +
    '    - RECIBO DE PAGO (Yappy, Nequi, ACH, transferencia, comprobante de envío de dinero):\n' +
    '      el proveedor es el DESTINATARIO del pago (a quien se le envió el dinero,\n' +
    '      quien prestó el servicio). NO tomes al remitente — el remitente es el dueño\n' +
    '      del negocio pagando. Buscá campos como "Enviado a", "Beneficiario", "Para",\n' +
    '      "Cobra", "Destinatario" para identificar al proveedor.\n' +
    '• Descripción: nombre del producto/servicio o concepto del pago. Si hay muchos ítems en la misma factura, listalos por separado.\n' +
    '• Si es una sola factura con varios ítems, devolvé un array items con uno por línea.\n' +
    '• Si es un solo gasto (recibo simple, transferencia), items tiene un solo elemento.\n\n' +
    'Respondé SOLO con JSON válido, sin markdown ni explicaciones:\n' +
    '{\n' +
    '  "items": [\n' +
    '    {\n' +
    '      "fecha":       "YYYY-MM-DD" o null,\n' +
    '      "descripcion": "…",\n' +
    '      "monto":       número,\n' +
    '      "categoria":   "Suministros"|"Publicidad"|"Mantenimiento"|"Limpieza"|"Basura"|"Servicios"|"Delivery"|"Prestamo"|"Otro",\n' +
    '      "proveedor":   "…"\n' +
    '    }\n' +
    '  ]\n' +
    '}';

  var payload = {
    model:      'claude-sonnet-4-6',
    max_tokens: 1500,
    messages:   [{ role: 'user', content: [ contentBlock, { type: 'text', text: prompt } ] }],
  };

  var r = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method:      'post',
    contentType: 'application/json',
    headers:     { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload:     JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  if (r.getResponseCode() !== 200) {
    throw new Error('Claude ' + r.getResponseCode() + ': ' + r.getContentText().substring(0, 200));
  }
  var resp = JSON.parse(r.getContentText());
  var text = '';
  var content = resp.content || [];
  for (var i = 0; i < content.length; i++) {
    if (content[i].type === 'text') { text = content[i].text; break; }
  }
  return _lasNubesParseJson(text);
}

// Extrae el primer bloque JSON del texto (por si Claude agrega prosa alrededor).
function _lasNubesParseJson(text) {
  if (!text) return null;
  var s = String(text).trim();
  // Remover fences ```json ... ``` si vienen.
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/,'');
  var start = s.indexOf('{');
  var end   = s.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) {
    Logger.log('LasNubes JSON parse: no encontré { ... } en la respuesta');
    return null;
  }
  var json = s.substring(start, end + 1);
  try { return JSON.parse(json); }
  catch(e) {
    Logger.log('LasNubes JSON parse ERROR: ' + e.message + ' — texto: ' + json.substring(0, 200));
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────
//  Preview + botones de aprobación
// ────────────────────────────────────────────────────────────────────
function _lasNubesSendApprovalPrompt(from, items, driveUrl, token, phoneId) {
  var total = 0;
  items.forEach(function(it) { total += (Number(it.monto) || 0); });

  var lines = ['🏡 *Gasto Las Nubes*'];
  if (items.length === 1) {
    var it = items[0];
    lines.push('');
    if (it.fecha)       lines.push('📅 ' + it.fecha);
    if (it.proveedor)   lines.push('🏢 ' + it.proveedor);
    if (it.descripcion) lines.push('📝 ' + it.descripcion);
    lines.push('💵 $' + Number(it.monto || 0).toFixed(2));
    if (it.categoria)   lines.push('🏷 ' + it.categoria);
  } else {
    lines.push('');
    lines.push('🧾 ' + items.length + ' ítems detectados — total *$' + total.toFixed(2) + '*');
    lines.push('');
    var maxShow = Math.min(items.length, 8);
    for (var i = 0; i < maxShow; i++) {
      var x = items[i];
      lines.push('• $' + Number(x.monto || 0).toFixed(2) + ' — ' + (x.descripcion || x.categoria || 'ítem'));
    }
    if (items.length > maxShow) lines.push('… +' + (items.length - maxShow) + ' más');
  }
  lines.push('');
  lines.push('¿En cuál *cabaña* lo registro?');
  lines.push('_(o respondé *rechazar* para descartar)_');

  var body = lines.join('\n');
  var payload = {
    messaging_product: 'whatsapp',
    to: from,
    type: 'interactive',
    interactive: {
      type:   'button',
      body:   { text: body.substring(0, 1024) },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'ln:apr:Paseo',  title: 'Paseo'  } },
          { type: 'reply', reply: { id: 'ln:apr:Portal', title: 'Portal' } },
          { type: 'reply', reply: { id: 'ln:apr:Puente', title: 'Puente' } },
        ],
      },
    },
  };
  try {
    var r = UrlFetchApp.fetch(META_GRAPH_BASE + '/' + phoneId + '/messages', {
      method:      'post',
      contentType: 'application/json',
      headers:     { 'Authorization': 'Bearer ' + token },
      payload:     JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    var status = (r.getResponseCode() >= 200 && r.getResponseCode() < 300) ? 'ok' : ('http_' + r.getResponseCode());
    _routerLog('out', from, 'interactive', 'ln:preview', body, status);
    if (status !== 'ok') Logger.log('LasNubes preview HTTP ' + r.getResponseCode() + ': ' + r.getContentText().substring(0, 200));
  } catch(err) {
    Logger.log('LasNubes preview ERROR: ' + err.message);
  }
}

// ────────────────────────────────────────────────────────────────────
//  Aprobación: escribir fila(s) al Sheet Egresos
// ────────────────────────────────────────────────────────────────────
function _lasNubesHandleApproval(from, cabana, sheetId, token, phoneId) {
  var pending = _lasNubesGetPending(from);
  if (!pending) {
    _routerSendText(from,
      '🤔 No tengo ningún gasto pendiente para aprobar. Mandame una foto primero.',
      token, phoneId);
    return;
  }
  var items = pending.items || [];
  if (!items.length) {
    _routerSendText(from, '⚠️ El pending no tenía ítems. Reintenta con una foto.', token, phoneId);
    _lasNubesClearPending(from);
    return;
  }

  var ss;
  try { ss = SpreadsheetApp.openById(sheetId); }
  catch(err) {
    Logger.log('LasNubes: no pude abrir sheet ' + sheetId + ' — ' + err.message);
    _routerSendText(from, '⚠️ No pude abrir el Sheet de Las Nubes: ' + err.message, token, phoneId);
    return;
  }
  var sheet = ss.getSheetByName('Egresos');
  if (!sheet) {
    _routerSendText(from, '⚠️ No encontré el tab "Egresos" en el Sheet.', token, phoneId);
    return;
  }

  // ID formato egr_<timestamp>_<seq> — mismo esquema del CSV existente.
  var ts = Date.now();
  var rows = [];
  var totalMonto = 0;
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var id = 'egr_' + ts + (items.length > 1 ? ('_' + i) : '');
    var fecha = it.fecha || _lasNubesTodayISO();
    var desc  = String(it.descripcion || '').substring(0, 500);
    var monto = Number(it.monto) || 0;
    var cat   = _lasNubesNormalizarCategoria(it.categoria);
    var prov  = String(it.proveedor || '').substring(0, 200);
    // Columns: ID | Fecha | Descripcion | Monto | Categoria | Cabaña | Proveedor | URLFoto
    rows.push([id, fecha, desc, monto, cat, cabana, prov, pending.driveUrl || '']);
    totalMonto += monto;
  }
  try {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  } catch(err) {
    Logger.log('LasNubes: append falló — ' + err.message);
    _routerSendText(from, '⚠️ No pude escribir al Sheet: ' + err.message, token, phoneId);
    return;
  }

  _lasNubesClearPending(from);

  var confirm = '✅ Guardado en *Las Nubes* — cabaña *' + cabana + '*\n\n' +
                (rows.length === 1
                  ? ('1 gasto por $' + totalMonto.toFixed(2))
                  : (rows.length + ' gastos por total $' + totalMonto.toFixed(2))) + '\n\n' +
                '🔗 ' + (pending.driveUrl || '(sin foto)');
  _routerSendText(from, confirm, token, phoneId);
}

// ────────────────────────────────────────────────────────────────────
//  Rechazo: borrar archivo de Drive + limpiar pending
// ────────────────────────────────────────────────────────────────────
function _lasNubesHandleReject(from, token, phoneId) {
  var pending = _lasNubesGetPending(from);
  if (!pending) {
    _routerSendText(from, '🤔 No tengo nada pendiente para rechazar.', token, phoneId);
    return;
  }
  // Intentar borrar el archivo de Drive.
  if (pending.driveFileId) {
    try { DriveApp.getFileById(pending.driveFileId).setTrashed(true); }
    catch(err) { Logger.log('LasNubes reject: no pude borrar Drive file — ' + err.message); }
  }
  _lasNubesClearPending(from);
  _routerSendText(from, '👍 Descartado. Mandá otra factura cuando quieras.', token, phoneId);
}

// ────────────────────────────────────────────────────────────────────
//  Helpers de storage (pending por phone)
// ────────────────────────────────────────────────────────────────────
function _lasNubesGetPending(phone) {
  var raw = PropertiesService.getScriptProperties().getProperty('lasNubesPend_' + phone);
  if (!raw) return null;
  try {
    var p = JSON.parse(raw);
    if (!p || !p.ts || (Date.now() - p.ts) > LAS_NUBES_PEND_TTL_MS) {
      PropertiesService.getScriptProperties().deleteProperty('lasNubesPend_' + phone);
      return null;
    }
    return p;
  } catch(e) { return null; }
}

function _lasNubesSetPending(phone, data) {
  PropertiesService.getScriptProperties().setProperty(
    'lasNubesPend_' + phone,
    JSON.stringify(data)
  );
}

function _lasNubesClearPending(phone) {
  PropertiesService.getScriptProperties().deleteProperty('lasNubesPend_' + phone);
}

// ────────────────────────────────────────────────────────────────────
//  Utilidades
// ────────────────────────────────────────────────────────────────────
function _lasNubesTodayISO() {
  var tz = Session.getScriptTimeZone() || 'America/Panama';
  return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
}

function _lasNubesNormalizarCategoria(cat) {
  var VALID = ['Suministros','Publicidad','Mantenimiento','Limpieza','Basura','Servicios','Delivery','Prestamo','Otro'];
  if (!cat) return 'Otro';
  var c = String(cat).trim();
  for (var i = 0; i < VALID.length; i++) {
    if (VALID[i].toLowerCase() === c.toLowerCase()) return VALID[i];
  }
  // Aliases comunes.
  var lower = c.toLowerCase();
  if (lower.indexOf('prést') === 0 || lower.indexOf('presta') === 0) return 'Prestamo';
  if (lower.indexOf('serv') === 0)  return 'Servicios';
  if (lower.indexOf('deliv') === 0) return 'Delivery';
  return 'Otro';
}
