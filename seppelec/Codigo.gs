/* ═══════════════════════════════════════════════════════════════
   SEPPELEC · Flujo CxC — Backend STANDALONE (Google Apps Script)

   Sistema independiente: NO forma parte de BalanceClip/ContaFacil, no
   usa clients.json ni el provisioner. Es su propio proyecto Apps Script
   ligado a su propia Hoja de cálculo.

   ── Instalación (una sola vez) ──────────────────────────────────
   1. Crea una Hoja de cálculo de Google nueva (será la base de datos).
   2. En esa hoja: Extensiones → Apps Script.
   3. Borra el contenido y pega TODO este archivo. Guarda.
   4. Implementar → Nueva implementación → Tipo: Aplicación web.
        - Ejecutar como:  Yo
        - Quién tiene acceso:  Cualquier persona
      Copia la URL /exec que te da.
   5. Pega esa URL en seppelec/index.html → const GAS_URL = '...'.

   La pestaña "Flujo_CXC" y la contraseña se crean solas.
   ═══════════════════════════════════════════════════════════════ */

var FLUJO_SHEET     = 'Flujo_CXC';
var LINEA_KEY       = 'FLUJO_LINEA';
var PW_KEY          = 'FLUJO_PW_HASH';
var DEFAULT_LINEA   = 70000;
var HEADER = ['orden_compra', 'factura', 'fecha_factura', 'monto',
              'estado', 'fecha_pago', 'abonado', 'actualizado',
              'orden_url', 'factura_url'];

// ── Router ──────────────────────────────────────────────────────
function doGet(e) {
  var params   = (e && e.parameter) || {};
  var action   = params.action || '';
  var callback = params.callback || '';
  try {
    if (action === 'getFlujoCxc')  return _getFlujo(callback);
    if (action === 'getAuthState') return _jsonp({ success: true, hasPassword: _hasPw() }, callback);
    return _jsonp({ success: false, error: 'accion desconocida: ' + action }, callback);
  } catch (err) {
    return _jsonp({ success: false, error: String(err && err.message || err) }, callback);
  }
}

function doPost(e) {
  try {
    var data   = JSON.parse(e.postData.contents);
    var action = data.action || '';
    if (action === 'saveFlujoCxc')   return _saveFlujo(data);
    if (action === 'verifyPassword') return _json({ success: true, valid: _checkPw(data.password) });
    if (action === 'setPassword')    return _setPw(data);
    if (action === 'parsePdf')       return _parsePdf(data);
    return _json({ success: false, error: 'accion desconocida: ' + action });
  } catch (err) {
    return _json({ success: false, error: String(err && err.message || err) });
  }
}

// ── Salidas ─────────────────────────────────────────────────────
function _jsonp(obj, callback) {
  var s = JSON.stringify(obj);
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + s + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.JSON);
}
function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Hoja ────────────────────────────────────────────────────────
function _sheet() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(FLUJO_SHEET);
  if (!sh) {
    sh = ss.insertSheet(FLUJO_SHEET);
    sh.getRange(1, 1, 1, HEADER.length).setValues([HEADER]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(2, 3, sh.getMaxRows() - 1, 1).setNumberFormat('@'); // fecha_factura como texto
    sh.getRange(2, 6, sh.getMaxRows() - 1, 1).setNumberFormat('@'); // fecha_pago como texto
  }
  // migración: asegura que el encabezado tenga todas las columnas (incl. urls nuevas)
  var hdr = sh.getRange(1, 1, 1, HEADER.length).getValues()[0];
  var need = false;
  for (var i = 0; i < HEADER.length; i++) { if (String(hdr[i] || '') !== HEADER[i]) { need = true; break; } }
  if (need) sh.getRange(1, 1, 1, HEADER.length).setValues([HEADER]).setFontWeight('bold');
  return sh;
}
function _dateStr(v) {
  if (v instanceof Date) {
    return v.getFullYear() + '-' + ('0' + (v.getMonth() + 1)).slice(-2) + '-' + ('0' + v.getDate()).slice(-2);
  }
  return String(v == null ? '' : v).trim();
}
function _linea() {
  var n = parseFloat(PropertiesService.getScriptProperties().getProperty(LINEA_KEY));
  return isNaN(n) ? DEFAULT_LINEA : n;
}

// ── GET datos ───────────────────────────────────────────────────
function _getFlujo(callback) {
  var sh = _sheet();
  var rows = [];
  var last = sh.getLastRow();
  if (last > 1) {
    var vals = sh.getRange(2, 1, last - 1, HEADER.length).getValues();
    for (var i = 0; i < vals.length; i++) {
      var r = vals[i];
      if (String(r[0] || '') === '' && String(r[1] || '') === '' && !r[3] && String(r[2] || '') === '') continue;
      rows.push({
        po: String(r[0] || ''), inv: String(r[1] || ''), fInv: _dateStr(r[2]),
        monto: parseFloat(r[3]) || 0, estado: String(r[4] || 'orden'),
        fPago: _dateStr(r[5]), abonado: parseFloat(r[6]) || 0,
        poUrl: String(r[8] || ''), invUrl: String(r[9] || '')
      });
    }
  }
  return _jsonp({ success: true, rows: rows, linea: _linea() }, callback);
}

// ── POST guardar (reemplaza el documento completo) ──────────────
function _saveFlujo(data) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { return _json({ success: false, error: 'ocupado' }); }
  try {
    var rows = (data && data.rows) || [];
    if (data && data.linea != null && !isNaN(parseFloat(data.linea))) {
      PropertiesService.getScriptProperties().setProperty(LINEA_KEY, String(parseFloat(data.linea)));
    }
    var sh = _sheet();
    var last = sh.getLastRow();
    if (last > 1) sh.getRange(2, 1, last - 1, HEADER.length).clearContent();
    if (rows.length) {
      var now = new Date();
      var out = rows.map(function (r) {
        return [String(r.po || ''), String(r.inv || ''), _dateStr(r.fInv),
                parseFloat(r.monto) || 0, String(r.estado || 'orden'),
                _dateStr(r.fPago), parseFloat(r.abonado) || 0, now,
                String(r.poUrl || ''), String(r.invUrl || '')];
      });
      sh.getRange(2, 1, out.length, HEADER.length).setValues(out);
    }
    return _json({ success: true, saved: rows.length });
  } catch (err) {
    return _json({ success: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

// ── Contraseña de edición (los jefes ven sin ella) ──────────────
function _hash(pwd) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(pwd || ''), Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = (bytes[i] + 256) % 256;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}
function _hasPw() {
  return String(PropertiesService.getScriptProperties().getProperty(PW_KEY) || '') !== '';
}
function _checkPw(pwd) {
  var stored = String(PropertiesService.getScriptProperties().getProperty(PW_KEY) || '');
  return stored !== '' && _hash(pwd) === stored;
}
function _setPw(data) {
  var props   = PropertiesService.getScriptProperties();
  var current = String(props.getProperty(PW_KEY) || '');
  // Si ya hay contraseña, exige la actual para cambiarla.
  if (current !== '') {
    if (!data.currentPassword || _hash(data.currentPassword) !== current) {
      return _json({ success: false, error: 'Contraseña actual incorrecta' });
    }
  }
  if (!data.password) return _json({ success: false, error: 'Falta la nueva contraseña' });
  props.setProperty(PW_KEY, _hash(data.password));
  return _json({ success: true });
}

// ── Lectura de PDF con IA (Claude) ──────────────────────────────
// Reconoce si el PDF es FACTURA u ORDEN de compra y extrae los datos.
// Requiere la Script Property ANTHROPIC_API_KEY. Opcional FLUJO_MODEL
// (por defecto claude-opus-4-8).
//
//   Para activarlo: Apps Script → Configuración del proyecto →
//   Propiedades de la secuencia de comandos → agregar
//   ANTHROPIC_API_KEY = tu_api_key   (de console.anthropic.com)
function _parsePdf(data) {
  var props  = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return _json({ success: false, error: 'Falta ANTHROPIC_API_KEY en las Script Properties del proyecto.' });
  }
  // Protege la API key: si hay contraseña de edición, exígela.
  if (_hasPw() && !_checkPw(data.password)) {
    return _json({ success: false, error: 'auth' });
  }
  var b64 = String(data.base64 || '');
  if (!b64) return _json({ success: false, error: 'No se recibió el PDF.' });

  var model = props.getProperty('FLUJO_MODEL') || 'claude-opus-4-8';
  var prompt =
    'Eres un asistente contable en Panamá. Analiza este documento PDF y determina si es una FACTURA ' +
    'emitida o una ORDEN DE COMPRA (pedido). Devuelve ÚNICAMENTE un objeto JSON válido, sin texto extra, ' +
    'con esta forma:\n' +
    '{"tipo":"factura"|"orden","po":"número(s) de orden de compra (string, varios separados por coma si aplica)",' +
    '"factura":"número de factura (ej F26248) o null si es orden","fecha":"fecha del documento en formato YYYY-MM-DD",' +
    '"monto": total del documento como número (incluyendo ITBMS), "moneda":"USD"}.\n' +
    'El número de orden de compra (po) es la referencia del PEDIDO DEL CLIENTE. En las facturas de ' +
    'Seppelec aparece etiquetado como "Nº documento externo" (también puede figurar como "pedido", ' +
    '"orden de compra", "PO" o "Nº de pedido cliente"); suele ser un número de ~10 dígitos que empieza ' +
    'en 42. NO uses el "Nº cliente" (ej. CLI/00127) ni el nº de albarán como po.\n' +
    'Los importes pueden venir en formato europeo (1.234,56 = mil doscientos treinta y cuatro con 56): ' +
    'devuélvelos siempre como número con punto decimal (1234.56), sin separador de miles ni símbolo.\n' +
    'La fecha puede venir como texto (ej. "22 de junio de 2026"): conviértela a YYYY-MM-DD. ' +
    'Para una ORDEN usa la fecha del pedido. Para una FACTURA usa la fecha de la factura. ' +
    'Si un campo no aparece, usa null. No inventes valores.';

  var payload = {
    model: model,
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
        { type: 'text', text: prompt }
      ]
    }]
  };

  try {
    var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    var body = JSON.parse(res.getContentText());
    if (code !== 200) {
      return _json({ success: false, error: 'API ' + code + ': ' + ((body.error && body.error.message) || res.getContentText()) });
    }
    // Concatena los bloques de texto de la respuesta.
    var txt = '';
    (body.content || []).forEach(function (b) { if (b.type === 'text') txt += b.text; });
    // Extrae el primer objeto JSON del texto.
    var m = txt.match(/\{[\s\S]*\}/);
    if (!m) return _json({ success: false, error: 'La IA no devolvió JSON. Respuesta: ' + txt.slice(0, 200) });
    var parsed = JSON.parse(m[0]);
    var fileUrl = _saveDocFile(b64, parsed);   // guarda el PDF en Drive (si hay carpeta)
    return _json({ success: true, doc: parsed, fileUrl: fileUrl });
  } catch (err) {
    return _json({ success: false, error: String(err && err.message || err) });
  }
}

// Guarda el PDF en la carpeta de Drive indicada por la propiedad FLUJO_FOLDER_ID
// y devuelve un enlace de solo lectura ("cualquiera con el enlace"). Si no hay
// carpeta configurada o falla, devuelve '' (la lectura del PDF no se interrumpe).
function _saveDocFile(b64, parsed) {
  try {
    var folderId = PropertiesService.getScriptProperties().getProperty('FLUJO_FOLDER_ID');
    if (!folderId) return '';
    var folder = DriveApp.getFolderById(folderId);
    var tipo = String((parsed && parsed.tipo) || 'doc').toLowerCase();
    var fac  = parsed && parsed.factura && String(parsed.factura).toLowerCase() !== 'null' ? parsed.factura : '';
    var ref  = String(fac || (parsed && parsed.po) || 'doc').replace(/[\\\/:*?"<>|]+/g, '_').replace(/\s+/g, '').slice(0, 40);
    var fecha = (parsed && parsed.fecha) ? String(parsed.fecha) : Utilities.formatDate(new Date(), 'GMT-5', 'yyyy-MM-dd');
    var name = tipo + '_' + ref + '_' + fecha + '.pdf';
    var blob = Utilities.newBlob(Utilities.base64Decode(b64), 'application/pdf', name);
    var file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return file.getUrl();
  } catch (e) {
    return '';
  }
}
