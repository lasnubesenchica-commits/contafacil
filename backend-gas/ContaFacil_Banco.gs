// ════════════════════════════════════════════════════════════════════
//  CONTAFACIL_BANCO — análisis express de estado de cuenta bancario
//  ──────────────────────────────────────────────────────────────────
//  Cuando el usuario manda un .xlsx por WhatsApp (típicamente el export
//  "Últimos movimientos" del Banco General), el bot:
//    1. Detecta que es estado de cuenta (mime/extensión)
//    2. Parsea el xlsx en memoria con Utilities.unzip + XML
//    3. Encuentra la sección de movimientos (cabecera Fecha/Descripción/Monto)
//    4. Pide a Claude clasificar las descripciones únicas en categorías
//    5. Calcula insights (flujo, top cats, top yappys, suscripciones)
//    6. Responde con un mensaje resumido en WhatsApp
//
//  No persiste nada — el análisis es efímero. La data del banco no toca
//  ningún sheet ni se almacena. Si en el futuro queremos historial,
//  pedirle al usuario consent explícito antes.
// ════════════════════════════════════════════════════════════════════


// Heuristic: detectar si un mensaje document es un estado de cuenta.
// Banco General exporta como .xlsx (mime: vnd.openxmlformats-…sheet).
// También aceptamos .xls y .csv por si vienen de otros bancos panameños.
// Procesa un xlsx que llegó por email a analisis@balanceclip.net y fue
// forwardeado por el router. data = { from, blob (base64), filename, mime }.
// Reusa _bancoProcesarMovimientos, que ya manda los resultados por WhatsApp
// y deja el cache listo para drill-downs y asesor.
function _bancoHandleEmailForward(data) {
  try {
    var props   = PropertiesService.getScriptProperties();
    var token   = props.getProperty('META_WHATSAPP_TOKEN');
    var phoneId = props.getProperty('META_PHONE_ID');
    if (!token || !phoneId) {
      Logger.log('_bancoHandleEmailForward: META_WHATSAPP_TOKEN / META_PHONE_ID no configurados');
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'wa_creds_missing' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    var bytes    = Utilities.base64Decode(data.blob);
    var filename = data.filename || 'estado-de-cuenta.xlsx';
    var mime     = data.mime || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    var blob     = Utilities.newBlob(bytes, mime, filename);

    _bancoProcesarMovimientos(blob, filename, data.from, token, phoneId);
    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    Logger.log('_bancoHandleEmailForward ERROR: ' + err.message + ' ' + (err.stack || ''));
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function _bancoEsEstadoDeCuenta(mediaObj) {
  var filename = String((mediaObj && mediaObj.filename) || '').toLowerCase();
  var mime     = String((mediaObj && mediaObj.mime_type) || '').toLowerCase();
  if (mime.indexOf('spreadsheetml') >= 0) return true;
  if (mime.indexOf('ms-excel') >= 0)      return true;
  if (mime === 'text/csv')                return true;
  if (/\.(xlsx|xls|csv)$/.test(filename)) return true;
  return false;
}

// Punto de entrada principal — invocado desde _whatsappProcesarMensaje
// cuando se detecta xlsx/csv.
function _bancoProcesarMovimientos(blob, filename, from, token, phoneId) {
  _whatsappReply(from, '📊 Recibí tu estado de cuenta. Analizándolo, dame un momento…', token, phoneId);

  var movs;
  try {
    if (/\.csv$/i.test(filename)) movs = _bancoParseCSV(blob);
    else                          movs = _bancoParseXLSX(blob);
  } catch(err) {
    Logger.log('Banco parse error: ' + err.message);
    _whatsappReply(from,
      '⚠️ No pude leer el archivo. ¿Es el export "Últimos movimientos" de tu banco?\n\n' +
      'Detalle: ' + err.message,
      token, phoneId);
    return;
  }

  if (!movs || !movs.length) {
    _whatsappReply(from,
      '🤔 No encontré movimientos en el archivo. ¿Tiene columnas *Fecha*, *Descripción* y *Monto*?',
      token, phoneId);
    return;
  }

  // Clasificar descripciones únicas con Claude. Si Claude falla todo
  // sigue funcionando — solo perdemos las categorías nombradas.
  var categorias = {};
  try { categorias = _bancoClasificarDescripciones(movs); }
  catch(err) { Logger.log('Banco Claude error: ' + err.message); }

  var analisis = _bancoAnalizar(movs, categorias);

  // Persistir aggregates por mes + cargar historial previo para deltas.
  // Privacy: solo guardamos totales mensuales agregados, nunca movs
  // individuales. Idempotente: re-subir el mismo período sobreescribe.
  // En modo DEMO (visitantes no registrados), NO persistimos nada —
  // cumple Ley 81 Art. 5 (minimización) y la policy pública.
  var historial = [];
  if (!_bancoEsDemo()) {
    try {
      _bancoPersistirMensual(from, movs, categorias);
      historial = _bancoLeerHistorial(from);
      Logger.log('Banco historial: ' + historial.length + ' meses para phone=' + from);
    } catch(err) {
      Logger.log('Banco historial error: ' + err.message + ' stack=' + (err.stack || ''));
    }
  } else {
    Logger.log('Banco DEMO: persistencia + historial skipped para visitor');
  }
  analisis.historial = historial;

  // Cachear el análisis crudo (movs + categorias + historial) por 30 min
  // para que el usuario pueda pedir drill-downs vía texto sin reenviar
  // el archivo. La data del banco NO va a un sheet persistente — solo
  // CacheService (TTL automático, no buscable, scope del script).
  try { _bancoCacheAnalisis(from, movs, categorias, historial); }
  catch(err) { Logger.log('Banco cache error: ' + err.message); }

  // _bancoFormatearMensaje devuelve ahora un array de 2 mensajes
  // (header→desglose, tendencia→cierre) para que cada uno quede dentro
  // del límite de "Leer más" de WhatsApp mobile (~1500 chars).
  var msgs = _bancoFormatearMensaje(analisis);
  if (typeof msgs === 'string') msgs = [msgs];
  msgs.forEach(function(t) { _whatsappReply(from, t, token, phoneId); });

  // Después del análisis principal mandar el menú interactivo con
  // botones de drill (top cats + meses recientes + descargar Excel).
  // Es un mensaje SEPARADO porque el análisis principal supera el
  // límite de 1024 chars del body interactivo.
  try { _bancoEnviarMenuDrill(movs, categorias, from, token, phoneId); }
  catch(err) { Logger.log('Banco menu drill error: ' + err.message); }

  // En modo DEMO (visitor en el router): después del análisis y el menú,
  // mandar un mensaje de descubrimiento sutil mostrando que BalanceClip
  // hace más cosas además de analizar bancos. Aprovecha hallazgos
  // específicos del análisis para que se sienta personalizado.
  try {
    if (_bancoEsDemo()) _bancoEnviarUpsellVisitor(analisis, from, token, phoneId);
  } catch(err) { Logger.log('Banco upsell visitor error: ' + err.message); }
}

// ────────────────────────────────────────────────────────────────────
//  Upsell sutil al visitor — solo se ejecuta en modo DEMO (router).
//  Personaliza el mensaje basado en lo que encontró en el análisis:
//  deducibles Form 90, suscripciones, top merchant. Termina con un
//  llamado a acción doble: probar 7 días o ver qué más hace BalanceClip.
// ────────────────────────────────────────────────────────────────────
function _bancoEnviarUpsellVisitor(analisis, from, token, phoneId) {
  // Pausa breve para que el menú drill llegue antes que el upsell.
  Utilities.sleep(600);

  var lineas = ['💡 *El análisis bancario es solo el comienzo*', ''];

  // Hallazgos relevantes en orden de impacto.
  var findings = [];
  if (analisis.form90 && analisis.form90.length) {
    analisis.form90.slice(0, 2).forEach(function(f) {
      findings.push('• *$' + f.sum.toFixed(2) + '* en ' + f.label + ' (deducibles Form 90 DGI)');
    });
  }
  if (analisis.suscripciones && analisis.suscripciones.length) {
    var n = analisis.suscripciones.length;
    var totalSub = analisis.suscripciones.reduce(function(s, x) { return s + x.avg; }, 0);
    findings.push('• ' + n + ' suscripción' + (n > 1 ? 'es' : '') + ' recurrente' + (n > 1 ? 's' : '') +
                  ' (~$' + totalSub.toFixed(2) + '/mes)');
  }
  if (!findings.length && analisis.topMerchant && analisis.topMerchant.name) {
    findings.push('• Tu mayor gasto se fue a *' + analisis.topMerchant.name + '*');
  }
  if (findings.length) {
    lineas.push('En tu cuenta detecté:');
    findings.forEach(function(f) { lineas.push(f); });
    lineas.push('');
  }

  lineas.push('Como cliente BalanceClip automatizamos esto y más:');
  lineas.push('📸 Registras facturas por WhatsApp (foto o PDF)');
  lineas.push('📧 Reenvío automatizado desde tu Gmail/Outlook');
  lineas.push('📊 Dashboard para analizar ingresos vs gastos, finanzas personales y reportes fiscales');
  lineas.push('💬 Asesor IA con TODOS tus gastos, no solo lo del banco');
  lineas.push('');
  lineas.push('🎁 Pruébalo 7 días gratis, sin tarjeta. Planes desde $19/mes.');

  var body = lineas.join('\n');
  // _whatsappReply existe en el router (alias hacia _routerSendText) y en
  // el per-client. En per-client esta función no se llama (no es demo).
  _whatsappReply(from, body, token, phoneId);
  Utilities.sleep(400);

  // Botones de CTA en mensaje separado para mantener el upsell por debajo
  // del límite de 1024 chars del body interactivo.
  var ctaBody = '¿Cómo te ayudo a empezar?';
  try {
    UrlFetchApp.fetch(META_GRAPH_BASE + '/' + phoneId + '/messages', {
      method:      'post',
      contentType: 'application/json',
      headers:     { 'Authorization': 'Bearer ' + token },
      payload:     JSON.stringify({
        messaging_product: 'whatsapp',
        to: from,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: ctaBody },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'signup:start', title: '🎁 Probar 7 días' } },
              { type: 'reply', reply: { id: 'signup:info',  title: 'ℹ️ Ver todo lo que haces' } },
            ],
          },
        },
      }),
      muteHttpExceptions: true,
    });
  } catch(err) { Logger.log('Banco upsell btn ERROR: ' + err.message); }
}

// ────────────────────────────────────────────────────────────────────
//  PARSER XLSX — sin advanced services, todo en V8 puro.
//  xlsx es un .zip de XML. Utilities.unzip() lo descomprime; nosotros
//  parseamos los dos archivos clave: sharedStrings.xml + sheet1.xml.
// ────────────────────────────────────────────────────────────────────

function _bancoParseXLSX(blob) {
  // Utilities.unzip() requiere mime application/zip — el xlsx viene como
  // application/vnd.openxml… así que clonamos el blob forzando el mime.
  var bytes   = blob.getBytes();
  var zipBlob = Utilities.newBlob(bytes, 'application/zip', 'tmp.zip');
  var files;
  try { files = Utilities.unzip(zipBlob); }
  catch(e) { throw new Error('No es un xlsx válido (' + e.message + ')'); }

  var sharedStrings = [];
  var sheetXml = null;
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    var name = f.getName();
    if (name === 'xl/sharedStrings.xml')      sharedStrings = _bancoParsearSharedStrings(f.getDataAsString());
    else if (name === 'xl/worksheets/sheet1.xml') sheetXml = f.getDataAsString();
  }
  if (!sheetXml) throw new Error('No encontré la hoja 1 dentro del xlsx');

  var matrix = _bancoParsearSheetXml(sheetXml, sharedStrings);
  return _bancoExtraerMovsDeMatriz(matrix);
}

function _bancoParsearSharedStrings(xml) {
  var out = [];
  var re  = /<si[\s>][\s\S]*?<\/si>/g;
  var m;
  while ((m = re.exec(xml)) !== null) {
    // Concatenar todos los <t>…</t> dentro de este <si> (xlsx puede dividir
    // strings con runs de formato — solo nos interesa el texto plano).
    var tre = /<t[^>]*>([\s\S]*?)<\/t>/g;
    var s = '', t;
    while ((t = tre.exec(m[0])) !== null) s += _bancoXmlDecode(t[1]);
    out.push(s);
  }
  return out;
}

function _bancoParsearSheetXml(xml, sharedStrings) {
  var matrix = [];
  var rowRe  = /<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  var rowM;
  while ((rowM = rowRe.exec(xml)) !== null) {
    var rowIdx = parseInt(rowM[1], 10) - 1;
    var rowXml = rowM[2];
    if (!matrix[rowIdx]) matrix[rowIdx] = [];
    var row = matrix[rowIdx];

    // Soportamos celdas con contenido (<c …>…</c>) y vacías (<c …/>).
    var cellRe = /<c\s+r="([A-Z]+)\d+"([^/>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    var cellM;
    while ((cellM = cellRe.exec(rowXml)) !== null) {
      var ref   = cellM[1];
      var attrs = cellM[2] || '';
      var inner = cellM[3] || '';
      var typeM = /\bt="([^"]+)"/.exec(attrs);
      var type  = typeM ? typeM[1] : '';
      var colIdx = _bancoColLetterToIdx(ref);
      var val;

      if (type === 'inlineStr') {
        // Inline string — el valor vive dentro de <is>…<t>VALUE</t>…</is>,
        // posiblemente envuelto en uno o más <r>…</r> (runs de formato).
        // Concatenamos TODOS los <t> que aparezcan dentro del <is>.
        var isM = /<is>([\s\S]*?)<\/is>/.exec(inner);
        if (!isM) continue;
        var sIn = '';
        var tre2 = /<t[^>]*>([\s\S]*?)<\/t>/g;
        var tm;
        while ((tm = tre2.exec(isM[1])) !== null) sIn += _bancoXmlDecode(tm[1]);
        val = sIn;
      } else {
        // Resto de tipos usan <v>VALUE</v>
        var vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (!vm) continue;
        var raw = _bancoXmlDecode(vm[1]);
        if (type === 's') {
          var ix = parseInt(raw, 10);
          val = sharedStrings[ix] || '';
        } else if (type === 'str') {
          val = raw;
        } else if (type === 'b') {
          val = raw === '1';
        } else {
          // número (incluye fechas serial — se resuelve en extracción) o
          // sin tipo explícito (default = number en xlsx spec)
          val = parseFloat(raw);
          if (isNaN(val)) val = raw;
        }
      }
      row[colIdx] = val;
    }
  }
  return matrix;
}

function _bancoColLetterToIdx(letterRef) {
  var s = String(letterRef || '').replace(/\d+/g, '');
  var n = 0;
  for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n - 1;
}

function _bancoXmlDecode(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, function(_, n) { return String.fromCharCode(parseInt(n, 10)); })
    .replace(/&amp;/g, '&');
}

// Encuentra la fila de encabezados Fecha/Descripción/Monto y devuelve
// los movimientos como array de { fecha, descripcion, monto, saldo? }.
function _bancoExtraerMovsDeMatriz(matrix) {
  var headerIdx = -1, idxFecha = -1, idxDesc = -1, idxMonto = -1, idxSaldo = -1;
  for (var r = 0; r < matrix.length; r++) {
    var row = matrix[r] || [];
    var found = { fecha: -1, desc: -1, monto: -1, saldo: -1 };
    for (var c = 0; c < row.length; c++) {
      var v = String(row[c] || '').toLowerCase().trim();
      if (v === 'fecha')                                    found.fecha = c;
      else if (v === 'descripción' || v === 'descripcion')  found.desc  = c;
      else if (v === 'monto')                               found.monto = c;
      else if (v.indexOf('saldo') >= 0)                     found.saldo = c;
    }
    if (found.fecha >= 0 && found.desc >= 0 && found.monto >= 0) {
      headerIdx = r;
      idxFecha = found.fecha; idxDesc = found.desc; idxMonto = found.monto; idxSaldo = found.saldo;
      break;
    }
  }
  if (headerIdx < 0) throw new Error('No encontré las columnas Fecha/Descripción/Monto');

  var movs = [];
  for (var rr = headerIdx + 1; rr < matrix.length; rr++) {
    var rrow = matrix[rr] || [];
    var fecha = rrow[idxFecha];
    var desc  = String(rrow[idxDesc] || '').trim();
    var monto = parseFloat(rrow[idxMonto]);
    if (!desc || isNaN(monto)) continue;
    var fechaJS = (fecha instanceof Date) ? fecha : _bancoSerialDateToJSDate(fecha);
    if (!fechaJS) continue;
    movs.push({
      fecha:       fechaJS,
      descripcion: desc,
      monto:       monto,
      saldo:       idxSaldo >= 0 ? parseFloat(rrow[idxSaldo]) : null,
    });
  }
  return movs;
}

// Convierte un serial date de Excel (días desde 1899-12-30) a JS Date.
function _bancoSerialDateToJSDate(v) {
  if (v instanceof Date) return v;
  if (typeof v === 'string') {
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof v !== 'number' || !isFinite(v)) return null;
  var ms = (v - 25569) * 86400000;  // 25569 = días entre 1899-12-30 y 1970-01-01
  var d2 = new Date(ms);
  return isNaN(d2.getTime()) ? null : d2;
}

// CSV — bancos panameños usan coma o punto-y-coma; soporta entrecomillado.
function _bancoParseCSV(blob) {
  var text = blob.getDataAsString('UTF-8');
  // Detectar separador (heurística: el más frecuente fuera de comillas).
  var commaCount = (text.match(/,/g) || []).length;
  var semiCount  = (text.match(/;/g) || []).length;
  var sep = semiCount > commaCount ? ';' : ',';
  var lines = text.split(/\r?\n/);
  var matrix = lines.map(function(l) { return _bancoParseCSVLine(l, sep); });
  return _bancoExtraerMovsDeMatriz(matrix);
}

function _bancoParseCSVLine(line, sep) {
  var out = [], cur = '', inQ = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line.charAt(i);
    if (ch === '"') {
      if (inQ && line.charAt(i+1) === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === sep && !inQ) {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  // Intentar convertir números
  return out.map(function(x) {
    var t = x.trim();
    if (/^-?\d+(\.\d+)?$/.test(t)) return parseFloat(t);
    return t;
  });
}

// ────────────────────────────────────────────────────────────────────
//  CLASIFICACIÓN — Claude Haiku 4.5 (rápido + barato).
//  Una sola llamada para todas las descripciones únicas, devuelve
//  un mapa { "descripcion": "categoria" }.
// ────────────────────────────────────────────────────────────────────

var _BANCO_CATEGORIAS = [
  'comida', 'transporte', 'telco', 'servicios', 'entretenimiento', 'ads',
  'yappy_salida', 'yappy_entrada', 'ach_salida', 'ach_entrada',
  'retiro_atm', 'pago_tarjeta', 'prestamo', 'seguro',
  'educacion', 'salud', 'belleza', 'comercio', 'ropa',
  'comision_banco', 'otro',
];

function _bancoClasificarDescripciones(movs) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) return {};

  // Deduplicar descripciones para reducir tokens.
  var unicas = {};
  for (var i = 0; i < movs.length; i++) unicas[movs[i].descripcion] = true;
  var lista = Object.keys(unicas).slice(0, 500);  // tope alto: el formato compacto soporta volumen
  if (!lista.length) return {};

  // Formato compacto: input numerado, output "N=cat" por línea.
  // Antes el output JSON repetía las descripciones largas como keys
  // → con 200+ descripciones el output excedía max_tokens y volvía
  // truncado (fallback a vacío → todo se clasificaba como 'otro').
  // El compact format reduce ~7× los tokens de output.
  //
  // PROMPT v2: enriquecido con tabla explícita de merchants panameños
  // canónicos. Antes el clasificador infería (y a veces fallaba) en
  // merchants comunes como REY, RIBA SMITH, ARROCHA, COLEGIO LAS
  // ESCLAVAS. Ahora le damos la lista y le pedimos match por substring
  // como prioridad sobre la inferencia.
  var prompt =
    'Eres un clasificador de movimientos bancarios PANAMEÑOS especializado. Te paso una lista NUMERADA de descripciones; devolveme la categoría más precisa para cada una.\n\n' +
    '═══════════════ CATEGORÍAS VÁLIDAS ═══════════════\n\n' +
    '  comida           — restaurantes, café, comida rápida, supermercados de alimentación, panadería, delivery\n' +
    '  transporte       — combustible, ride-share (UBER RIDES), taxi, parking, peaje\n' +
    '  telco            — celular, internet, cable, telefonía\n' +
    '  servicios        — luz, agua, gas, electricidad\n' +
    '  entretenimiento  — suscripciones streaming, cine, juegos, espectáculos\n' +
    '  ads              — publicidad digital (Facebook/Google/TikTok Ads)\n' +
    '  yappy_salida     — YAPPY BG A <nombre> (vos mandando P2P)\n' +
    '  yappy_entrada    — YAPPY BG DE <nombre> (vos recibiendo P2P)\n' +
    '  ach_salida       — transferencias bancarias salientes\n' +
    '  ach_entrada      — ACH/depósitos entrantes\n' +
    '  retiro_atm       — RETIRO CAJERO, ATM\n' +
    '  pago_tarjeta     — PAGO TARJETA DE CRÉDITO\n' +
    '  prestamo         — pagos de préstamo, leasing, cuotas\n' +
    '  seguro           — primas de seguro (auto, vida, salud, casa)\n' +
    '  educacion        — colegios, universidades, matrículas, colegiaturas (DEDUCIBLE Form 90 DP-2)\n' +
    '  salud            — farmacias, médicos, hospitales, laboratorios, dentistas (DEDUCIBLE Form 90 DP-1)\n' +
    '  belleza          — peluquería, barbería, spa, salón, manicure\n' +
    '  comercio         — retail GENERAL no-alimentación (electrónica, ferretería, oficina)\n' +
    '  ropa             — tiendas de ropa, calzado\n' +
    '  hospedaje        — hoteles, Airbnb, hostales\n' +
    '  comision_banco   — comisiones del banco, mantenimiento cuenta, ITBMS bancario\n' +
    '  otro             — todo lo demás\n\n' +
    '═══════════ TABLA DE MERCHANTS PANAMEÑOS ═══════════\n' +
    'REGLA: si la descripción contiene (substring, case-insensitive) cualquiera de los nombres de abajo, usa la categoría indicada. Esta tabla TIENE PRIORIDAD sobre tu inferencia.\n\n' +
    '🍽 comida:\n' +
    '   Supermercados grandes: REY · RIBA SMITH · SUPER 99 · EL MACHETAZO · XTRA · ROMERO · NOVEY MARKET · COMERCIAL FACEBOOK · MERCADO · PRICESMART · COSTCO\n' +
    '   Mini supers/mercados: MINI SUPER · SUPER CARNES · FRUTERIA · FRUTAS Y VERDURAS · QUESOS · CARNICERIA · ABARROTERIA · COLMADO\n' +
    '   Cadenas comida: MCDONALDS · KFC · BURGER KING · SUBWAY · TGI FRIDAYS · T.G.I.FRIDAY · POPEYES · BAJA FRESH · ONE WOK · WENDYS · FRIDAYS · DOMINOS · PIZZA HUT\n' +
    '   Restaurantes/café: KOTOWA · STARBUCKS · JUAN VALDEZ · BOQUETE BAKERY · BZA PARRIL · BJ LA PARRIL · CHURRERIA · TOTUMAS · BOCAS RICAS · DURAN COFFE · ANANSI · MAITO\n' +
    '   Heladerías/postres: GELARTI · HELADERIA · YOGEN · YOGURT · DULCERIA · POSTRES\n' +
    '   Genéricos: BAKERY · PANADERIA · RESTAURANTE · CAFE · COFFEE · PIZZERIA · SUSHI · GRILL · BISTRO · COCINA · DELI · QUESERIA\n' +
    '   Bebidas/licor: FELIPE MOTTA · LICORERIA · CERVECERIA · VINOTECA · MOTTA INTERNATIONAL · VINO · LICOR\n' +
    '   Delivery: UBER EATS · PEDIDOSYA · RAPPI · GLOVO · APPETITO24\n\n' +
    '🚗 transporte:\n' +
    '   Combustible: TERPEL · PUMA · DELTA · ACCEL · GASOLINERA · ESTACION DE SERVICIO\n' +
    '   Movilidad: UBER RIDES · UBER (sin EATS) · CABIFY · TAXI · DIDI\n' +
    '   Otros: PANAMAPASS · AUTOPISTA · PARKING · ESTACIONAMIENTO · SLP PARKING · MULTIPARKING\n\n' +
    '📱 telco: +MOVIL · MAS MOVIL · MASMOVIL · MAS M (sufijo en "SERVICIO CELULAR MAS M") · TIGO · CABLE ONDA · CLARO · DIGICEL · RECARGA TELEFONIA · SERVICIO CELULAR\n\n' +
    '💡 servicios: ENSA · IDAAN · EDEMET · GAS TROPIGAS · NATURGY · DGI (impuestos no son servicios, ver "otro")\n\n' +
    '🎬 entretenimiento:\n' +
    '   Suscripciones: APPLE.COM · NETFLIX · SPOTIFY · HBO MAX · DISNEY+ · AMAZON PRIME · YOUTUBE PREMIUM · PARAMOUNT · CLAUDE.AI · CHATGPT · OPENAI\n' +
    '   Cine: CINEPOLIS · CINEMARK · CINE\n' +
    '   Eventos: TICKETPLUS · TUTICKET\n' +
    '   Hosting/web: HOSTINGER · GODADDY · NAMECHEAP · DIGITAL OCEAN · AWS (cuando es personal)\n\n' +
    '📢 ads: FACEBK · FACEBOOK ADS · GOOGL · GOOGLE ADS · TIKTOK ADS · INSTAGRAM ADS · LINKEDIN ADS\n\n' +
    '🏥 salud (DEDUCIBLE Form 90 DP-1):\n' +
    '   Farmacias: ARROCHA · METRO FARMA · METROFARM · EL JAVILLO · FARMACIA · FARMA VALUE · FARMACIA DON BOSCO · FARMACIA SAN JUAN · FARMASAVE\n' +
    '   Médico: HOSPITAL · CLINICA · LABORATORIO · CONSULTORIO · DENTAL · ODONTOLOGIA · CIRUGIA · GINECOLOGIA · PEDIATRA · DR. · DRA. · MEDICO · CENTRO MEDICO\n' +
    '   Mascotas (veterinarios y similares también aplican salud para tracking personal): VETERINARIO · CLINICA VETERINARIA · MASCOTAS · PET\n' +
    '   IMPORTANTE: FELIPE MOTTA NO es farmacia — es cadena de licorerías/wine shop (clasifica como "comida").\n\n' +
    '🎓 educacion (DEDUCIBLE Form 90 DP-2):\n' +
    '   Colegios: COLEGIO LAS ESCLAVAS · COLEGIO BLISS · ST MARY · SAN FRANCISCO · EPISCOPAL · KING\'S COLLEGE · ACADEMIA INTERAMERICANA · COLEGIO + cualquier nombre · ESCUELA\n' +
    '   Universidades: USMA · ULACIT · UTP · UMIP · QLU · UDELAS · FLORIDA STATE · UNIVERSITY OF · UNIVERSIDAD\n' +
    '   Genérico: MATRICULA · COLEGIATURA · MENSUALIDAD ESCOLAR\n\n' +
    '💄 belleza: KEVINS STUDIO · ESTETICA · PELUQUERIA · BARBERIA · BARBER · SPA · SALON · NAILS · MANICURE · PEDICURE · BARBER SHOP\n\n' +
    '👕 ropa: ZARA · H&M · FOREVER 21 · BERSHKA · MANGO · ALDO · TOMMY HILFIGER · NIKE · ADIDAS · ALMACEN · BOUTIQUE · MULTIPLAZA (ropa)\n\n' +
    '🏨 hospedaje: HOTEL · AIRBNB · BOOKING.COM · AGODA · EXPEDIA · HOSTAL · RESORT · CABAÑA · POSADA · HOSTEL\n\n' +
    '🛡 seguro: ASSA · MAPFRE · PAN-AMERICAN · SEGURO MUNDIAL · INTERNACIONAL DE SEGUROS · ANCON SEGUROS · ACERTA · PRIMA · SEGURO DE FRAUDE · COMPAÑIA DE SEGURO\n\n' +
    '🛒 comercio (NO alimentación): NOVEY (ferretería) · COCHEZ · DO IT CENTER · CASA DE LAS BATERIAS · OFFICE DEPOT · PANAFOTO · MULTI MAX · ELECTRO MOTORS · MEDIA MARKT\n\n' +
    '🏦 comision_banco: ITBMS · COMISION · MANTENIMIENTO CUENTA · CARGO DE SERVICIO · CARGO POR · INTERESES BANCARIOS · IMPUESTO SEGURO\n\n' +
    '═══════════════ REGLAS ESPECIALES (resuelven ambigüedades) ═══════════════\n' +
    '1. YAPPY BG A <merchant conocido>: si el nombre matchea un merchant (ej: "Pedidos Ya", "App Panapass", comercio), usa la CAT DEL MERCHANT (comida, transporte, etc.), NO yappy_salida. Solo usa yappy_salida cuando el destinatario es claramente una persona física.\n' +
    '2. BANCA MOVIL TRANSFERENCIA A <merchant conocido>: idem — si el destinatario es Cía. de Seguro, Colegio, Hospital, etc., usa esa cat, no ach_salida.\n' +
    '3. RECARGA TELEFONIA / RECARGA CELULAR: siempre telco, aunque el descriptor empiece por BANCA MOVIL.\n' +
    '4. PriceSmart en Panamá: principalmente alimentación/bulk grocery → comida.\n' +
    '5. FELIPE MOTTA: licorería/wine shop, NO farmacia → comida (bebidas).\n' +
    '6. UBER: si dice "UBER EATS" → comida; si dice "UBER RIDES" o solo "UBER" → transporte.\n' +
    '7. INTERES CUENTA DE AHORROS: ach_entrada (es interés ganado, ingreso).\n' +
    '8. YAPPY BS (no BG): tratar igual que YAPPY BG (mismo tipo de mov, distinto producto Banco).\n\n' +
    '═══════════════ FORMATO DE RESPUESTA ═══════════════\n' +
    'Una línea por entrada con "N=categoria". Sin comentarios, sin explicaciones, sin markdown.\n\n' +
    'Ejemplo:\n' +
    '  1=transporte\n' +
    '  2=comida\n' +
    '  3=telco\n\n' +
    '═══════════════ DESCRIPCIONES A CLASIFICAR ═══════════════\n' +
    lista.map(function(d, i) { return (i + 1) + '. ' + d; }).join('\n');

  var payload = {
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 8000,  // suficiente para ~500 líneas "N=cat"
    messages:   [{ role: 'user', content: prompt }],
  };
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify(payload),
    headers:            { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    Logger.log('Claude clasif error ' + res.getResponseCode() + ': ' + res.getContentText().substring(0, 400));
    return {};
  }
  var data = JSON.parse(res.getContentText());
  var text = (data.content && data.content[0] && data.content[0].text) || '';
  // Parsear el formato compacto. Tolera lineas en blanco, espacios y prefijos.
  var out = {};
  var lineas = text.split(/\r?\n/);
  for (var li = 0; li < lineas.length; li++) {
    var match = /^\s*(\d+)\s*=\s*([a-z_]+)\s*$/.exec(lineas[li]);
    if (!match) continue;
    var idx = parseInt(match[1], 10) - 1;
    var cat = match[2];
    if (idx >= 0 && idx < lista.length) out[lista[idx]] = cat;
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
//  ANALYTICS — agregaciones sobre los movimientos clasificados.
// ────────────────────────────────────────────────────────────────────

function _bancoAnalizar(movs, categorias) {
  var totalIn = 0, totalOut = 0;
  var catTotalsOut = {};   // cat → { count, sum } — SOLO gastos (monto<0)
  var yappyOut  = {};      // nombre → suma
  var yappyIn   = {};      // nombre → suma
  var byMerchantOut = {};  // merchant → { count, sum, montos: [] } — solo gastos

  movs.forEach(function(m) {
    var monto = m.monto;
    if (monto >= 0) {
      totalIn += monto;
    } else {
      totalOut += -monto;
      // Agregar al catTotals SOLO si es gasto — así topCats no incluye
      // entradas y el porcentaje contra totalOut tiene sentido.
      var cat = categorias[m.descripcion] || 'otro';
      if (!catTotalsOut[cat]) catTotalsOut[cat] = { count: 0, sum: 0 };
      catTotalsOut[cat].count++;
      catTotalsOut[cat].sum += -monto;

      // Merchant key para detección de suscripciones — solo cargos.
      // Recortamos el sufijo de tarjeta "-4187-94XX-XXXX-0953" o ref ACH.
      var mk = m.descripcion.split(/-\d{4}-?\d|\s+\d{6,}/)[0].trim().substring(0, 40);
      if (!byMerchantOut[mk]) byMerchantOut[mk] = { count: 0, sum: 0, montos: [], fechas: [], cat: null };
      byMerchantOut[mk].count++;
      byMerchantOut[mk].sum += -monto;
      byMerchantOut[mk].montos.push(monto);
      byMerchantOut[mk].fechas.push(m.fecha);
      byMerchantOut[mk].cat = categorias[m.descripcion] || byMerchantOut[mk].cat || 'otro';
    }

    // Extraer nombre Yappy del texto: "YAPPY BG A/DE <NOMBRE> [POR …]"
    var ym = /YAPPY\s+BG\s+(A|DE)\s+(.+?)(?:\s+POR\b|\s*$)/i.exec(m.descripcion);
    if (ym) {
      var dir = ym[1].toUpperCase();
      // Tomar las primeras 3 palabras del nombre — los Yappy panas suelen
      // venir con razón social/nombre largo; los 3 primeros tokens bastan.
      var name = ym[2].split(/\s+/).slice(0, 3).join(' ').trim();
      if (dir === 'A')      yappyOut[name] = (yappyOut[name] || 0) + Math.abs(monto);
      else if (dir === 'DE') yappyIn[name]  = (yappyIn[name]  || 0) + Math.abs(monto);
    }
  });

  // Top categorías de gasto
  var topCats = Object.keys(catTotalsOut)
    .map(function(c) { return { cat: c, sum: catTotalsOut[c].sum, count: catTotalsOut[c].count }; })
    .sort(function(a, b) { return b.sum - a.sum; })
    .slice(0, 5);

  var topYappyOut = Object.keys(yappyOut)
    .map(function(k) { return { name: k, sum: yappyOut[k] }; })
    .sort(function(a, b) { return b.sum - a.sum; }).slice(0, 3);
  var topYappyIn = Object.keys(yappyIn)
    .map(function(k) { return { name: k, sum: yappyIn[k] }; })
    .sort(function(a, b) { return b.sum - a.sum; }).slice(0, 3);

  // Suscripciones: mismo merchant (de gastos) ≥ 3 veces con montos
  // similares (variación < 15% del promedio) y patrón mensual (intervalo
  // mediano entre cargos 22-38 días). Antes el threshold de 2x daba
  // muchos falsos positivos (clínica/restaurante/cine visitados 2 veces
  // por casualidad).
  var suscripciones = [];
  Object.keys(byMerchantOut).forEach(function(mk) {
    var info = byMerchantOut[mk];
    if (info.count < 3) return;
    var avg = info.sum / info.count;
    if (avg < 3) return;
    var allClose = info.montos.every(function(x) {
      return Math.abs(Math.abs(x) - avg) / avg < 0.15;
    });
    if (!allClose) return;
    // Patrón mensual: ordenar fechas y verificar que el intervalo
    // mediano entre cargos consecutivos cae en [22, 38] días.
    var fechasOrd = info.fechas.slice().filter(Boolean).sort(function(a, b) { return a - b; });
    if (fechasOrd.length < 3) return;
    var intervalos = [];
    for (var i = 1; i < fechasOrd.length; i++) {
      intervalos.push((fechasOrd[i] - fechasOrd[i-1]) / 86400000);
    }
    intervalos.sort(function(a, b) { return a - b; });
    var mediana = intervalos[Math.floor(intervalos.length / 2)];
    if (mediana < 22 || mediana > 38) return;
    suscripciones.push({ merchant: mk, count: info.count, avg: avg });
  });
  suscripciones.sort(function(a, b) { return b.avg - a.avg; });

  // Gastos chicos (< $10) — el "death by a thousand cuts"
  var pequenos = movs.filter(function(m) { return m.monto < 0 && m.monto > -10; });
  var sumaPequenos = pequenos.reduce(function(s, m) { return s + Math.abs(m.monto); }, 0);

  // Rango de fechas + saldo inicial/final.
  // BG exporta newest-first pero buscamos por fecha por robustez en
  // caso de bancos que sorten al revés.
  var fechas = movs.map(function(m) { return m.fecha; }).filter(Boolean)
                   .sort(function(a, b) { return a - b; });
  var inicio = fechas[0];
  var fin    = fechas[fechas.length - 1];
  var dias   = fechas.length ? Math.max(1, Math.round((fin - inicio) / 86400000) + 1) : 0;

  // Saldo: el saldo[N] mostrado en la fila N es el saldo DESPUÉS de
  // aplicar ese movimiento. Para tener el saldo inicial del período,
  // tomamos el más viejo y restamos su monto (reverse). El final es
  // simplemente el del más reciente.
  //
  // Detectar orden del export: BG y la mayoría exportan newest-first.
  // Usamos la fecha del primer vs último elemento del array; si hay
  // empate (BG pone el mismo timestamp para movs del mismo día) caemos
  // a "newest-first" por default (asumimos BG).
  var newestMov, oldestMov;
  if (movs.length === 1) {
    newestMov = oldestMov = movs[0];
  } else {
    var first = movs[0], last = movs[movs.length - 1];
    var bgStyle = !first.fecha || !last.fecha || first.fecha >= last.fecha;
    newestMov = bgStyle ? first : last;
    oldestMov = bgStyle ? last  : first;
  }
  var saldoIni = null, saldoFin = null, deltaSaldo = null;
  if (newestMov && newestMov.saldo != null && !isNaN(newestMov.saldo) &&
      oldestMov && oldestMov.saldo != null && !isNaN(oldestMov.saldo)) {
    saldoFin   = newestMov.saldo;
    saldoIni   = oldestMov.saldo - oldestMov.monto;
    deltaSaldo = saldoFin - saldoIni;
  }

  // Top merchant — el que se llevó más plata acumulada en GASTOS REALES.
  // Excluimos:
  //  - ach_salida y transferencias por banca móvil (mover plata entre
  //    cuentas propias o pagar tarjetas — no es consumo)
  //  - yappy_salida (P2P a una persona, no un "merchant")
  //  - pago_tarjeta (es un settlement, los cargos individuales ya cuentan)
  var topMerchant = null;
  var bestSum = 0;
  var CATS_NO_MERCHANT = ['ach_salida', 'yappy_salida', 'pago_tarjeta'];
  Object.keys(byMerchantOut).forEach(function(mk) {
    var info = byMerchantOut[mk];
    if (CATS_NO_MERCHANT.indexOf(info.cat) >= 0) return;
    if (/BANCA\s+MOVIL\s+TRANSFER|TRANSFER.*CUENTA|PAGO\s+TC|PAGO\s+TARJETA|^YAPPY\s+BG\s+/i.test(mk)) return;
    if (info.sum > bestSum) {
      bestSum = info.sum;
      topMerchant = { name: mk, sum: info.sum, count: info.count };
    }
  });

  // Form 90 (DGI Panamá) — deducibles personales que detectamos en el
  // estado de cuenta. El match único de ContaFacil: ningún otro app
  // de finanzas panameño hace este cruce.
  // Mapa categoría bancaria → línea del Form 90.
  var form90Map = {
    salud:     { label: 'Gastos médicos',         linea: 'DP-1' },
    educacion: { label: 'Gastos escolares',       linea: 'DP-2' },
    seguro:    { label: 'Seguros de salud',       linea: 'DP-1', nota: '_(solo si el seguro es médico)_' },
    prestamo:  { label: 'Intereses préstamos',    linea: 'DP-3/DP-4', nota: '_(verificar si es hipotecario o educativo)_' },
  };
  var form90 = [];
  Object.keys(form90Map).forEach(function(c) {
    if (catTotalsOut[c]) {
      form90.push({
        cat:    c,
        label:  form90Map[c].label,
        linea:  form90Map[c].linea,
        nota:   form90Map[c].nota || '',
        sum:    catTotalsOut[c].sum,
        count:  catTotalsOut[c].count,
      });
    }
  });

  // Health flags — heurísticas sobre la salud financiera del período.
  // Triggers conservadores: solo levantamos bandera cuando la señal
  // es clara, para no convertirnos en un bot alarmista.
  var flags = [];
  var ahorroPct = totalIn > 0 ? (totalIn - totalOut) / totalIn : 0;

  // Ahorro bajo — más informativo que la flag anterior de "gastaste 90%".
  // Reemplaza la flag ratio. Solo aplica si tuviste ingreso real
  // ($100+) y el ahorro fue positivo pero bajo (<10%). El caso de
  // déficit (ahorroPct < 0) ya se ve en el bloque Flujo como "Déficit".
  if (totalIn > 100 && ahorroPct >= 0 && ahorroPct < 0.1) {
    flags.push('💪 Ahorraste solo ' + Math.round(ahorroPct * 100) +
               '% de tu ingreso — espacio para ajustar gastos discrecionales.');
  }

  if (deltaSaldo != null && deltaSaldo < -20) {
    flags.push('📉 Tu saldo bajó ' + _bancoFmtDolar(Math.abs(deltaSaldo)) + ' en este período.');
  }

  // Concentración — diferenciamos entre cat de consumo real (alarma)
  // vs cat de transferencia (info neutral). "Tu top categoría es
  // Transfer salida 49%" no es problema: es plata moviéndose entre
  // cuentas o yendo a personas, no consumo concentrado.
  var CATS_TRANSFER = ['ach_salida', 'yappy_salida', 'pago_tarjeta'];
  if (topCats.length && topCats[0].sum / Math.max(totalOut, 1) > 0.4) {
    var c0 = topCats[0];
    var pct0 = Math.round((c0.sum / totalOut) * 100);
    if (CATS_TRANSFER.indexOf(c0.cat) >= 0) {
      flags.push('💱 El ' + pct0 + '% de tus salidas fue ' + _bancoCatLabel(c0.cat) +
                 ' — verificá si fueron a cuentas propias o pagos reales.');
    } else if (c0.cat !== 'otro') {
      flags.push('🎯 Una sola categoría (' + _bancoCatLabel(c0.cat) +
                 ') se llevó el ' + pct0 + '% de tu gasto — concentración alta.');
    }
  }

  // Runway — solo si el saldo está BAJANDO (deltaSaldo < 0). Si la
  // persona tiene ingresos sostenidos compensando, no es señal real
  // de riesgo: el saldo se recupera al próximo ingreso.
  if (saldoFin != null && deltaSaldo != null && deltaSaldo < 0 &&
      dias > 0 && totalOut > 0) {
    var gastoDiario = totalOut / dias;
    var runwayDias  = gastoDiario > 0 ? Math.floor(saldoFin / gastoDiario) : 999;
    if (runwayDias < 7) {
      flags.push('⏳ Al ritmo de gasto actual y con saldo bajando, tu saldo dura ~' + runwayDias + ' día(s) más.');
    }
  }

  return {
    totalIn: totalIn, totalOut: totalOut, neto: totalIn - totalOut,
    nMovs: movs.length, dias: dias,
    inicio: inicio, fin: fin,
    saldoIni: saldoIni, saldoFin: saldoFin, deltaSaldo: deltaSaldo,
    topCats: topCats,
    topCatDesgloses: _bancoComputarTopCatDesgloses(movs, categorias, topCats, 2, 4),
    topMerchant: topMerchant,
    topYappyOut: topYappyOut, topYappyIn: topYappyIn,
    suscripciones: suscripciones.slice(0, 5),
    pequenos: { count: pequenos.length, suma: sumaPequenos },
    form90: form90,
    flags: flags,
    oportunidad: _bancoComputarOportunidad(suscripciones, pequenos.length, sumaPequenos, dias, topMerchant, totalOut),
  };
}

// Para los top N categorías de gasto, agrupa por destinatario/merchant
// y devuelve el top M destinatarios de cada una. Es el "gancho" del
// mensaje: responde directo "el #1 de tu gasto fue Comida — y se fue a
// Riba Smith, Super 99 y…". Reusa _bancoExtractDestinatario.
function _bancoComputarTopCatDesgloses(movs, categorias, topCats, nCats, nDest) {
  return topCats.slice(0, nCats).map(function(tc) {
    var byDest = {};
    movs.forEach(function(m) {
      if (m.monto >= 0) return;
      if ((categorias[m.descripcion] || 'otro') !== tc.cat) return;
      var key = _bancoExtractDestinatario(m);
      byDest[key] = (byDest[key] || 0) + (-m.monto);
    });
    var top = Object.keys(byDest).map(function(k) {
      return { name: k, sum: byDest[k] };
    }).sort(function(a, b) { return b.sum - a.sum; }).slice(0, nDest);
    return { cat: tc.cat, sum: tc.sum, top: top };
  });
}

// Consolida los hallazgos accionables en 1-2 bullets enfocados en
// "dónde está la mayor oportunidad de ahorro". Prioridad:
//  1. Suscripciones (cambio inmediato, alto impacto mensual)
//  2. Gastos chicos significativos ($200+/año proyectado)
//  3. Top merchant (si no hubo suscripciones ni chicos)
function _bancoComputarOportunidad(suscripciones, nPequenos, sumaPequenos, dias, topMerchant, totalOut) {
  var out = [];
  if (suscripciones.length) {
    var subTotal = suscripciones.reduce(function(s, x) { return s + x.avg; }, 0);
    out.push({
      icon: '🔁',
      title: suscripciones.length + ' suscripción(es) recurrente(s) ≈ ' + _bancoFmtDolar(subTotal) + '/mes',
      accion: 'Auditá las que no usás y cancelá. Top: ' + suscripciones[0].merchant,
    });
  }
  if (nPequenos >= 10 && dias > 0) {
    var anual = (sumaPequenos / dias) * 365;
    if (anual >= 200) {
      out.push({
        icon: '☕',
        title: nPequenos + ' compras <$10 = ' + _bancoFmtDolar(sumaPequenos) + ' (~' + _bancoFmtDolar(anual) + '/año)',
        accion: 'Recortando 50% ahorrás ' + _bancoFmtDolar(anual / 2) + '/año.',
      });
    }
  }
  if (out.length === 0 && topMerchant && topMerchant.sum >= 100 && totalOut > 0) {
    var pctTm = Math.round((topMerchant.sum / totalOut) * 100);
    out.push({
      icon: '🏆',
      title: 'Top gasto: ' + topMerchant.name + ' ' + _bancoFmtDolar(topMerchant.sum) + ' (' + pctTm + '%)',
      accion: 'Evaluá si hay alternativa más barata o si se puede reducir.',
    });
  }
  return out.slice(0, 2);
}

function _bancoFmtDolar(n) { return '$' + (isFinite(n) ? Number(n).toFixed(2) : '0.00'); }

// Si está en modo DEMO (visitantes no registrados): saltamos persistencia,
// agregamos un banner de "registrate" al cierre del análisis. Activa via
// Script Property IS_DEMO = "true" en el GAS dedicado a visitantes.
function _bancoEsDemo() {
  try {
    return PropertiesService.getScriptProperties().getProperty('IS_DEMO') === 'true';
  } catch(e) { return false; }
}

function _bancoCatLabel(c) {
  var L = {
    comida: '🍽 Comida', transporte: '🚗 Transporte', telco: '📱 Telco',
    servicios: '💡 Servicios', entretenimiento: '🎬 Entretenimiento',
    ads: '📢 Ads', yappy_salida: '💸 Yappy salida', yappy_entrada: '💰 Yappy entrada',
    ach_salida: '🏦 Transfer salida', ach_entrada: '🏦 Transfer entrada',
    retiro_atm: '🏧 Retiros ATM', pago_tarjeta: '💳 Pago TC',
    prestamo: '🏛 Préstamo', seguro: '🛡 Seguro', educacion: '🎓 Educación',
    salud: '🏥 Salud', belleza: '💄 Belleza', comercio: '🛒 Comercio',
    ropa: '👕 Ropa', comision_banco: '🏦 Comisión banco', otro: '📋 Otro',
  };
  return L[c] || ('📋 ' + c);
}

function _bancoFormatearMensaje(a) {
  var fmt = _bancoFmtDolar;
  var fechaStr = function(d) {
    return d ? Utilities.formatDate(d, 'America/Panama', 'd MMM') : '—';
  };

  var ahorro = a.totalIn > 0 ? Math.round((a.neto / a.totalIn) * 100) : 0;

  // ═══ MENSAJE 1 — Header + Flujo + Top cats + Desglose ═══
  var m1 = '';
  m1 += '📊 *Análisis · ' + fechaStr(a.inicio) + ' – ' + fechaStr(a.fin) +
        ' · ' + a.nMovs + ' movs*\n';
  if (a.saldoIni != null && a.saldoFin != null) {
    var arrow = a.deltaSaldo >= 0 ? '↗' : '↘';
    var sign  = a.deltaSaldo >= 0 ? '+' : '−';
    m1 += '💵 Saldo ' + fmt(a.saldoIni) + ' ' + arrow + ' ' + fmt(a.saldoFin) +
          ' (' + sign + fmt(Math.abs(a.deltaSaldo)) + ')\n';
  }
  m1 += '\n*Flujo*\n';
  m1 += '✅ Ingresos: ' + fmt(a.totalIn) + '\n';
  m1 += '❌ Gastos:   ' + fmt(a.totalOut) + '\n';
  m1 += (a.neto >= 0 ? '💰 Ahorro:    ' : '⚠️ Déficit:   ') +
        fmt(Math.abs(a.neto)) +
        (a.totalIn > 0 ? ' (' + (ahorro >= 0 ? '+' : '') + ahorro + '%)' : '') + '\n\n';

  if (a.topCats.length) {
    m1 += '*Top categorías de gasto*\n';
    m1 += '```\n' + _bancoBarsCategorias(a.topCats, a.totalOut) + '```\n\n';
  }

  if (a.topCatDesgloses && a.topCatDesgloses.length) {
    a.topCatDesgloses.forEach(function(d, idx) {
      if (!d.top || !d.top.length) return;
      var rank = idx === 0 ? '#1' : '#2';
      m1 += '🔍 *¿A dónde va ' + rank + ': ' + _bancoCatLabel(d.cat) + '?*\n';
      m1 += '```\n' + _bancoFmtTablaDestinatarios(d.top, d.sum) + '```\n\n';
    });
  }

  m1 += '_Sigue ↓ tendencia mensual + oportunidades…_';

  // ═══ MENSAJE 2 — Tendencia + Oportunidad + Cierre ═══
  var m2 = '';
  if (a.historial && a.historial.length >= 2) {
    m2 += '*📈 Tendencia mensual*\n';
    m2 += '```\n' + _bancoBarsTendencia(a.historial) + '```\n\n';
  }

  if (a.oportunidad && a.oportunidad.length) {
    m2 += '💡 *Tu mayor oportunidad de ahorro*\n';
    a.oportunidad.forEach(function(op) {
      m2 += op.icon + ' ' + op.title + '\n';
      m2 += '   → ' + op.accion + '\n';
    });
    m2 += '\n';
  }

  m2 += '👇 *Menú abajo* — detalle por categoría/mes o descargar reportes\n\n';

  m2 += '💬 *O pregúntame en lenguaje natural:*\n';
  m2 += '_Entendiendo tus gastos_\n';
  m2 += '• _"¿está alto mi gasto en comida?"_\n';
  m2 += '• _"¿a quién le pago más en transferencias?"_\n';
  m2 += '• _"muéstrame los gastos de transporte en mayo"_\n';
  m2 += '_Detectando patrones_\n';
  m2 += '• _"¿qué suscripciones tengo activas?"_\n';
  m2 += '• _"¿hay algún cargo raro o inusual?"_\n';
  m2 += '• _"¿en qué mes gasté más y por qué?"_\n';
  m2 += '_Optimizando_\n';
  m2 += '• _"¿qué deducibles del Form 90 puedo aprovechar?"_\n';
  m2 += '• _"¿cuánto debería ahorrar al mes?"_\n';
  m2 += '• _"si dejo de enviarle Yappys a X ¿cuánto ahorro?"_\n\n';

  m2 += '📥 _Descarga el *Reporte PDF* o el *Excel* desde el menú para ' +
        'ver la matriz destinatario × mes, el semáforo de salud financiera ' +
        'y todos los insights accionables._';

  // Banner solo para visitantes (modo DEMO): explica la limitación de
  // no-historial y los invita a registrarse para guardar evolución.
  if (_bancoEsDemo()) {
    m2 += '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    m2 += '🎁 *Estás en modo demo*\n';
    m2 += 'Tu data NO se guarda — el análisis es solo para esta sesión. ' +
          'Si quieres mantener histórico mes a mes (tendencias, evolución, ' +
          'benchmarks), registrate con la prueba *gratis 7 días*. ' +
          'Escribe *demo* para empezar.';
  }

  return [m1.substring(0, 4000), m2.substring(0, 4000)];
}

// ════════════════════════════════════════════════════════════════════
//  BARS — render Unicode bar charts dentro de bloques monospace (```)
// ════════════════════════════════════════════════════════════════════

var _BANCO_BAR_W = 10;          // ancho de la barra en chars
var _BANCO_NAME_W = 16;         // ancho del nombre de cat (sin emoji)

function _bancoBar(part, max, width) {
  width = width || _BANCO_BAR_W;
  var filled = max > 0 ? Math.round((part / max) * width) : 0;
  if (filled > width) filled = width;
  if (filled < 0)     filled = 0;
  // Si tiene valor mayor a 0 pero redondea a 0 segmentos, mostramos al
  // menos uno para que el usuario sepa que algo hay (no ceros raros).
  if (filled === 0 && part > 0) filled = 1;
  var s = '';
  for (var i = 0; i < filled; i++)  s += '█';
  for (var j = filled; j < width; j++) s += '░';
  return s;
}

// Pad a un string a un ancho fijo (en chars). Si es más corto que w,
// pad con espacios; si más largo, trunca con "…". No considera el
// ancho real de chars unicode (los emojis varían por plataforma).
function _bancoPadCat(label, w) {
  w = w || _BANCO_NAME_W;
  // Para alineación más consistente entre plataformas, separamos el
  // emoji (suele ser 1 ó 2 chars wide pero unpredictable) del texto.
  var emojiMatch = String(label).match(/^(\S+)\s+(.+)$/);
  var emoji = '', text = String(label);
  if (emojiMatch) { emoji = emojiMatch[1]; text = emojiMatch[2]; }
  if (text.length > w - 1) text = text.substring(0, w - 1) + '…';
  while (text.length < w) text += ' ';
  return (emoji ? emoji + ' ' : '') + text;
}

// Render de las top categorías como bars proporcionales al total.
function _bancoBarsCategorias(topCats, totalOut) {
  if (!topCats || !topCats.length) return '';
  var max = Math.max.apply(null, topCats.map(function(c) { return c.sum; }));
  return topCats.map(function(c) {
    var bar = _bancoBar(c.sum, max);
    var pct = totalOut > 0 ? Math.round((c.sum / totalOut) * 100) : 0;
    return _bancoPadCat(_bancoCatLabel(c.cat)) + ' ' + bar + ' ' + _bancoFmtDolar(c.sum) + ' (' + pct + '%)';
  }).join('\n') + '\n';
}

// Render de la tendencia mensual — cada fila un mes con bar relativo
// al MAYOR mes del rango.
// Render tendencia mensual — formato visualmente IDÉNTICO a
// _bancoBarsCategorias. Nombre completo del mes (sin emoji), padding
// 19 chars para alinear con cats. Monto con decimales. Delta% del
// mes vs mes anterior entre paréntesis.
function _bancoBarsTendencia(historial) {
  if (!historial || !historial.length) return '';
  var NAME_W = 19;
  var max = Math.max.apply(null, historial.map(function(h) { return h.totalOut; }));
  return historial.map(function(h, i) {
    var bar = _bancoBar(h.totalOut, max);
    var pct = i === 0 ? null : (historial[i-1].totalOut > 0
      ? Math.round(((h.totalOut - historial[i-1].totalOut) / historial[i-1].totalOut) * 100)
      : null);
    // El primer mes no tiene anterior — omitimos el paréntesis. Para el
    // resto: + / - / ~ (sin cambio significativo).
    var deltaPart = '';
    if (pct !== null) {
      var pctStr = (pct > 5)  ? '+' + pct + '%'
                 : (pct < -5) ? pct + '%'
                 : '~';
      deltaPart = ' (' + pctStr + ')';
    }
    // Sin año (redundante, el período total ya está en el header).
    var label = _bancoMesLabelFull(h.yearMonth) + (h.parcial ? ' parcial' : '');
    if (label.length > NAME_W) label = label.substring(0, NAME_W - 1) + '…';
    while (label.length < NAME_W) label += ' ';
    return label + ' ' + bar + ' ' + _bancoFmtDolar(h.totalOut) + deltaPart;
  }).join('\n') + '\n';
}

// Render deltas mes vs mes anterior — formato IDÉNTICO a
// _bancoBarsCategorias. Reusa _bancoPadCat (cat con emoji + texto pad),
// _bancoFmtDolar y _bancoBar.
function _bancoBarsDeltas(cats) {
  if (!cats || !cats.length) return '';
  var max = Math.max.apply(null, cats.map(function(c) { return c.cur; }));
  return cats.map(function(c) {
    var bar = _bancoBar(c.cur, max);
    var pctStr;
    if (c.deltaPct === null)       pctStr = 'NUEVO';
    else if (c.deltaPct > 5)       pctStr = '+' + Math.round(c.deltaPct) + '%';
    else if (c.deltaPct < -5)      pctStr = Math.round(c.deltaPct) + '%';
    else                           pctStr = '~';
    return _bancoPadCat(_bancoCatLabel(c.cat)) + ' ' + bar + ' ' +
           _bancoFmtDolar(c.cur) + ' (' + pctStr + ')';
  }).join('\n') + '\n';
}

// Nombre completo del mes — "2026-03" → "Marzo 2026"
function _bancoMesLabelFull(ym) {
  var meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
               'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  var parts = String(ym || '').split('-');
  if (parts.length !== 2) return ym || '???';
  var m = parseInt(parts[1], 10);
  return meses[m-1] || '???';
}

// Tabla de destinatarios — formato visualmente IDÉNTICO a
// _bancoBarsCategorias. Mismos helpers de bar y monto, mismo orden de
// campos, mismo ancho efectivo del nombre. La diferencia con cats es
// que los nombres NO tienen emoji prefix, así que padeamos a 19 chars
// para compensar el ancho visual del emoji+espacio del lado cats
// (emoji renderea ~2 cols en mobile + 1 space + 16 text pad = ~19).
function _bancoFmtTablaDestinatarios(top, sumTotal) {
  if (!top || !top.length) return '';
  var NAME_W = 19;
  var max = Math.max.apply(null, top.map(function(x) { return x.sum; }));
  return top.map(function(item) {
    var name = String(item.name);
    if (name.length > NAME_W) name = name.substring(0, NAME_W - 1) + '…';
    while (name.length < NAME_W) name += ' ';
    var bar = _bancoBar(item.sum, max);
    var pctIt = sumTotal > 0 ? Math.round((item.sum / sumTotal) * 100) : 0;
    return name + ' ' + bar + ' ' + _bancoFmtDolar(item.sum) + ' (' + pctIt + '%)';
  }).join('\n') + '\n';
}

// Versión compacta del fmt $ — sin decimales (más fácil de alinear).
// Para los valores chicos (<$5) sí mostramos decimales.
function _bancoFmtDolarCompacto(n) {
  if (!isFinite(n)) return '$0';
  var abs = Math.abs(n);
  if (abs < 5) return '$' + Number(n).toFixed(2);
  return '$' + Math.round(n);
}

function _bancoMesLabel(ym) {
  var meses = ['ENE','FEB','MAR','ABR','MAY','JUN','JUL','AGO','SEP','OCT','NOV','DIC'];
  var parts = String(ym || '').split('-');
  if (parts.length !== 2) return ym || '???';
  var m = parseInt(parts[1], 10);
  return (meses[m-1] || '???');
}

// ════════════════════════════════════════════════════════════════════
//  PERSISTENCIA — sheet Banco_Historico
//  ────────────────────────────────────────────────────────────────
//  Solo guardamos AGGREGATES por mes (totales + cat totals como JSON).
//  Nunca movimientos individuales. Cada upload sobreescribe los meses
//  que cubre (idempotente — re-subir el mismo período es seguro).
//
//  Schema:
//    A  phone        — número (sin +) del usuario
//    B  year_month   — YYYY-MM
//    C  total_in     — número
//    D  total_out    — número
//    E  cats_json    — JSON { cat: sumOut, ... }
//    F  n_movs       — número
//    G  parcial      — true si el mes está incompleto (último día del
//                      mes > último día con movimientos)
//    H  updated_at   — timestamp ISO
// ════════════════════════════════════════════════════════════════════

var _BANCO_SHEET = 'Banco_Historico';

function _bancoEnsureHistorialSheet() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sh = ss.getSheetByName(_BANCO_SHEET);
  if (!sh) {
    sh = ss.insertSheet(_BANCO_SHEET);
    sh.getRange(1, 1, 1, 8).setValues([[
      'phone','year_month','total_in','total_out','cats_json','n_movs','parcial','updated_at'
    ]]);
    sh.getRange(1, 1, 1, 8).setFontWeight('bold').setBackground('#f3f4f6');
    sh.setFrozenRows(1);
    sh.setColumnWidth(5, 300);
    Logger.log('Banco_Historico sheet creado');
  }
  // Forzar text format en col A (phone) y B (year_month). Sin esto Sheets
  // auto-convierte "2026-06" a Date (interpretado como 2026-06-01) y al
  // leer de vuelta sale como Date object — rompe sort y labels.
  // Idempotente: aplicar siempre es safe (incluso a un sheet ya existente
  // con rows mal-formateadas que vamos a re-normalizar al leer).
  sh.getRange('A:B').setNumberFormat('@');
  return sh;
}

// Normaliza year_month leído del sheet — puede venir como string ya
// formateado ("2026-06") o como Date object (de filas escritas antes
// del fix de text format).
function _bancoNormalizarYM(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, 'America/Panama', 'yyyy-MM');
  }
  return String(v || '');
}

function _bancoPersistirMensual(phone, movs, categorias) {
  if (!phone || !movs || !movs.length) return;
  var sh = _bancoEnsureHistorialSheet();

  // Agregar por YYYY-MM
  var byMonth = {};
  movs.forEach(function(m) {
    if (!m.fecha) return;
    var ym = Utilities.formatDate(m.fecha, 'America/Panama', 'yyyy-MM');
    if (!byMonth[ym]) byMonth[ym] = { totalIn: 0, totalOut: 0, cats: {}, n: 0, lastDay: 0 };
    var b = byMonth[ym];
    b.n++;
    var day = parseInt(Utilities.formatDate(m.fecha, 'America/Panama', 'd'), 10);
    if (day > b.lastDay) b.lastDay = day;
    if (m.monto >= 0) {
      b.totalIn += m.monto;
    } else {
      b.totalOut += -m.monto;
      var cat = categorias[m.descripcion] || 'otro';
      b.cats[cat] = (b.cats[cat] || 0) + (-m.monto);
    }
  });

  // Determinar si cada mes está "parcial" — comparando lastDay vs el
  // último día calendárico del mes. Si lastDay < último día Y el mes
  // es el actual (no pasado), lo marcamos parcial.
  var ahora = new Date();
  var ymActual = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM');
  Object.keys(byMonth).forEach(function(ym) {
    var b = byMonth[ym];
    var parts = ym.split('-');
    var ult = new Date(parseInt(parts[0],10), parseInt(parts[1],10), 0).getDate();
    b.parcial = (ym === ymActual && b.lastDay < ult);
  });

  // Cargar rows existentes para idempotencia (mismo phone + ym → reemplazar)
  var last = sh.getLastRow();
  var rowMap = {};   // key "phone|ym" → row number (2-based)
  if (last >= 2) {
    var rows = sh.getRange(2, 1, last - 1, 2).getValues();
    for (var i = 0; i < rows.length; i++) {
      var p = String(rows[i][0] || '');
      var y = _bancoNormalizarYM(rows[i][1]);  // por si filas viejas tienen Date en B
      if (p && y) rowMap[p + '|' + y] = i + 2;
    }
  }

  var now = new Date();
  var toAppend = [];
  Object.keys(byMonth).forEach(function(ym) {
    var b = byMonth[ym];
    var row = [phone, ym, b.totalIn, b.totalOut, JSON.stringify(b.cats), b.n, b.parcial, now];
    var key = phone + '|' + ym;
    if (rowMap[key]) {
      sh.getRange(rowMap[key], 1, 1, 8).setValues([row]);
    } else {
      toAppend.push(row);
    }
  });
  if (toAppend.length) {
    sh.getRange(sh.getLastRow() + 1, 1, toAppend.length, 8).setValues(toAppend);
  }
}

// Devuelve los meses históricos del usuario, ordenados por year_month
// asc. Cap a 12 meses para no inundar el bar chart.
function _bancoLeerHistorial(phone) {
  if (!phone) return [];
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sh = ss.getSheetByName(_BANCO_SHEET);
  if (!sh) return [];
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, 8).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0] || '') !== phone) continue;
    var cats = {};
    try { cats = JSON.parse(values[i][4] || '{}'); }
    catch(e) {}
    out.push({
      yearMonth: _bancoNormalizarYM(values[i][1]),
      totalIn:   Number(values[i][2]) || 0,
      totalOut:  Number(values[i][3]) || 0,
      cats:      cats,
      nMovs:     Number(values[i][5]) || 0,
      parcial:   values[i][6] === true || String(values[i][6]).toLowerCase() === 'true',
    });
  }
  out.sort(function(a, b) { return a.yearMonth.localeCompare(b.yearMonth); });
  // Cap a 12 meses para mantener el chart legible.
  if (out.length > 12) out = out.slice(out.length - 12);
  return out;
}

// Computa deltas entre el último mes del historial y el anterior.
// Devuelve [{ label, prevLabel, cats: [{cat, prev, cur, deltaPct}] }].
// Solo top 5 cats del mes actual para no inundar.
function _bancoComputarDeltasMesAnt(historial) {
  if (!historial || historial.length < 2) return [];
  var cur  = historial[historial.length - 1];
  var prev = historial[historial.length - 2];
  // Si el mes actual está parcial, sería injusto comparar montos
  // absolutos. Reportamos igual pero el mensaje "<mes> vs <mes>" deja
  // claro que es la foto hasta hoy.
  var keys = Object.keys(cur.cats);
  keys.sort(function(a, b) { return (cur.cats[b]||0) - (cur.cats[a]||0); });
  keys = keys.slice(0, 5);
  var cats = keys.map(function(k) {
    var curV  = cur.cats[k]  || 0;
    var prevV = prev.cats[k] || 0;
    var pct;
    if (prevV === 0 && curV > 0)      pct = null;  // nuevo
    else if (prevV === 0 && curV === 0) pct = 0;
    else                                pct = ((curV - prevV) / prevV) * 100;
    return { cat: k, prev: prevV, cur: curV, deltaPct: pct };
  });
  return [{
    label:       _bancoMesLabel(cur.yearMonth)  + ' ' + cur.yearMonth.split('-')[0],
    prevLabel:   _bancoMesLabel(prev.yearMonth) + ' ' + prev.yearMonth.split('-')[0],
    curParcial:  !!cur.parcial,
    cats:        cats,
  }];
}

// ════════════════════════════════════════════════════════════════════
//  CACHE DEL ÚLTIMO ANÁLISIS — para drill-downs por texto
//  ──────────────────────────────────────────────────────────────────
//  Tras procesar el upload guardamos un snapshot slim en CacheService
//  con TTL 30 min. El usuario puede pedir "ver comida" o "ver mayo"
//  durante esa ventana sin reenviar el archivo. Pasado el TTL el bot
//  responde "expiró, mandame el archivo otra vez".
//
//  Privacy: CacheService es scope del script, no buscable, no
//  exportable. Cuando el cache expira la data se va.
// ════════════════════════════════════════════════════════════════════

var _BANCO_CACHE_TTL = 60 * 60;   // 1 hora (CacheService permite hasta 6h)

function _bancoCacheKey(phone) { return 'banco_last_' + String(phone || ''); }

function _bancoCacheAnalisis(phone, movs, categorias, historial) {
  if (!phone || !movs || !movs.length) return;
  // Slim movs: solo fields que los drill-downs necesitan, sin metadata
  // verbose. Reduce tamaño del cache ~3×.
  var slim = movs.map(function(m) {
    return {
      f: m.fecha ? m.fecha.getTime() : 0,
      m: m.monto,
      d: m.descripcion,
      c: categorias[m.descripcion] || 'otro',
      s: (m.saldo != null && !isNaN(m.saldo)) ? m.saldo : null,
    };
  });
  var payload = JSON.stringify({
    ts:        Date.now(),
    movs:      slim,
    historial: historial || [],
  });
  // CacheService.put max: 100 KB por entry. 460 movs slim ~36 KB,
  // suficiente headroom. Si nos pasamos, truncar movs al primer
  // chunk de 100 KB (raro caso).
  if (payload.length > 95000) {
    Logger.log('Banco cache payload > 95KB, truncating movs');
    while (slim.length > 100 && payload.length > 95000) {
      slim = slim.slice(0, Math.floor(slim.length * 0.9));
      payload = JSON.stringify({ ts: Date.now(), movs: slim, historial: historial });
    }
  }
  CacheService.getScriptCache().put(_bancoCacheKey(phone), payload, _BANCO_CACHE_TTL);
}

function _bancoLoadCache(phone) {
  if (!phone) return null;
  var raw = CacheService.getScriptCache().get(_bancoCacheKey(phone));
  if (!raw) return null;
  try {
    var data = JSON.parse(raw);
    // Rehidratar fechas como Date objects
    data.movs = data.movs.map(function(m) {
      return { fecha: new Date(m.f), monto: m.m, descripcion: m.d, cat: m.c, saldo: m.s };
    });
    return data;
  } catch(e) {
    Logger.log('Banco cache parse error: ' + e.message);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════
//  INTENT PARSER — detecta el comando del usuario y devuelve qué
//  drill ejecutar. Devuelve null si el texto no calza con ningún
//  patrón conocido.
// ════════════════════════════════════════════════════════════════════

function _bancoDrillIntent(text) {
  var t = _bancoNorm(text || '');
  if (!t) return null;
  // Variantes simplificadas del Excel para probar — match antes del
  // genérico "excel" para que "excel simple" no caiga al default.
  if (/\bexcel\s+(simple|simplificado|a)\b/.test(t)) {
    return { type: 'excel_a' };
  }
  if (/\bexcel\s+(dashboard|tablero|b)\b/.test(t)) {
    return { type: 'excel_b' };
  }
  // Cualquier mensaje con la palabra "excel" o "xlsx" (independiente del
  // verbo o frase) dispara el export completo (variante actual).
  if (/\b(excel|xlsx)\b/.test(t)) {
    return { type: 'excel' };
  }
  // Mismo patrón para "pdf" o "reporte" — genera el PDF ejecutivo.
  if (/\b(pdf|reporte)\b/.test(t)) {
    return { type: 'pdf' };
  }
  // Pelar prefijo "ver" / "drill" / "d" / "detalle"
  var stripped = t.replace(/^(ver|drill|detalle|d)\s+/, '').trim();
  if (!stripped) return null;
  // Permitir explícito YYYY-MM
  var ymM = /\b(20\d{2})[-\/](\d{1,2})\b/.exec(stripped);
  // Buscar cat y mes en el texto stripped
  var cat = _bancoMatchCat(stripped);
  var ym  = ymM ? (ymM[1] + '-' + String(parseInt(ymM[2], 10)).padStart(2, '0')) :
                  _bancoMatchMes(stripped);
  if (cat && ym)  return { type: 'cross', cat: cat, ym: ym };
  if (cat)        return { type: 'cat',   cat: cat };
  if (ym)         return { type: 'month', ym: ym };
  // Permitir solo número de mes (1..12)
  var mNum = /^(\d{1,2})$/.exec(stripped);
  if (mNum) {
    var m = parseInt(mNum[1], 10);
    if (m >= 1 && m <= 12) {
      var yr = new Date().getFullYear();
      return { type: 'month', ym: yr + '-' + String(m).padStart(2, '0') };
    }
  }
  return null;
}

function _bancoNorm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

// Devuelve la key de categoría que matchea el texto. Soporta tanto la
// key directa ("comida") como sinónimos comunes ("transporte"→transporte,
// "uber"→transporte). Fuzzy: substring match contra label normalizado.
function _bancoMatchCat(text) {
  var t = _bancoNorm(text);
  if (!t) return null;
  // Catálogo local con sinónimos comunes que la gente usaría en chat
  var SINON = {
    comida: ['comida','restaurant','restaurantes','restaurante','food','almuerzo','cena','desayuno','cafe','starbucks','kotowa','mcdonalds'],
    transporte: ['transporte','transporte','uber','taxi','gasolina','combustible','gasolinera','peaje'],
    telco: ['telco','celular','telefono','internet','mas movil','tigo','cable onda'],
    servicios: ['servicios','luz','agua','electricidad','ensa','idaan'],
    entretenimiento: ['entretenimiento','netflix','spotify','disney','hbo','cine','cinepolis'],
    ads: ['ads','publicidad','facebook ads','facebk','google ads'],
    yappy_salida: ['yappy salida','yappys','yappy','yappy out'],
    yappy_entrada: ['yappy entrada','yappy in','recibido'],
    ach_salida: ['transferencia','ach','transfer','banca movil'],
    ach_entrada: ['deposito','abono','transferencia entrante'],
    retiro_atm: ['atm','retiro','cajero'],
    pago_tarjeta: ['pago tarjeta','pago tc','tarjeta de credito'],
    prestamo: ['prestamo','leasing','cuota'],
    seguro: ['seguro','seguros','assa','mapfre'],
    educacion: ['educacion','colegio','universidad','matricula','usma','ulacit'],
    salud: ['salud','farmacia','medico','clinica','hospital','arrocha','metrofarma'],
    belleza: ['belleza','peluqueria','barberia','spa','kevins'],
    comercio: ['comercio','supermercado','pricesmart','super 99','riba smith','xtra'],
    ropa: ['ropa','zara','h&m','almacen'],
    comision_banco: ['comision','itbms bancario'],
  };
  for (var key in SINON) {
    var arr = SINON[key];
    for (var i = 0; i < arr.length; i++) {
      if (t.indexOf(_bancoNorm(arr[i])) >= 0) return key;
    }
  }
  return null;
}

// Detecta nombre de mes en texto. Soporta abreviado y completo, con
// y sin acentos. Devuelve "YYYY-MM" usando el año actual.
function _bancoMatchMes(text) {
  var t = _bancoNorm(text);
  var meses = {
    'ene':1,'enero':1,'jan':1,
    'feb':2,'febrero':2,
    'mar':3,'marzo':3,
    'abr':4,'abril':4,'apr':4,
    'may':5,'mayo':5,
    'jun':6,'junio':6,
    'jul':7,'julio':7,
    'ago':8,'agosto':8,'aug':8,
    'sep':9,'sept':9,'septiembre':9,
    'oct':10,'octubre':10,
    'nov':11,'noviembre':11,
    'dic':12,'diciembre':12,'dec':12,
  };
  // Buscar primero el nombre largo (evitar que "marzo" matchee "mar")
  var ordered = Object.keys(meses).sort(function(a,b){ return b.length - a.length; });
  for (var i = 0; i < ordered.length; i++) {
    if (t.indexOf(ordered[i]) >= 0) {
      var yr = new Date().getFullYear();
      // Si el texto incluye un año explícito ej "mayo 2025" usarlo
      var yrM = /\b(20\d{2})\b/.exec(t);
      if (yrM) yr = parseInt(yrM[1], 10);
      return yr + '-' + String(meses[ordered[i]]).padStart(2, '0');
    }
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════
//  DRILL HANDLERS — renderean el detalle solicitado
// ════════════════════════════════════════════════════════════════════

function _bancoHandleDrill(intent, from, token, phoneId) {
  var cache = _bancoLoadCache(from);
  if (!cache) {
    _whatsappReply(from,
      '⏳ No tengo un análisis reciente tuyo cacheado (expiró la hora).\n\n' +
      'Envíame el xlsx del banco otra vez y después puedes pedir el desglose.',
      token, phoneId);
    return;
  }
  var msg = '';
  if (intent.type === 'cat')        msg = _bancoRenderDrillCat(cache, intent.cat);
  else if (intent.type === 'month') msg = _bancoRenderDrillMes(cache, intent.ym);
  else if (intent.type === 'cross') msg = _bancoRenderDrillCross(cache, intent.cat, intent.ym);
  else if (intent.type === 'excel')   { _bancoExportarExcel(cache, from, token, phoneId, 'full'); return; }
  else if (intent.type === 'excel_a') { _bancoExportarExcel(cache, from, token, phoneId, 'a');    return; }
  else if (intent.type === 'excel_b') { _bancoExportarExcel(cache, from, token, phoneId, 'b');    return; }
  else if (intent.type === 'pdf')     { _bancoExportarPDF(cache, from, token, phoneId);           return; }
  if (!msg) {
    _whatsappReply(from, '🤔 No encontré data para eso. Probá `ver mayo` o `ver comida`.', token, phoneId);
    return;
  }
  _whatsappReply(from, msg, token, phoneId);
}

function _bancoRenderDrillCat(cache, catKey) {
  var fmt = _bancoFmtDolar;
  var matches = cache.movs.filter(function(m) { return m.cat === catKey && m.monto < 0; });
  if (!matches.length) return '🤔 No encontré gastos clasificados como *' + _bancoCatLabel(catKey) + '* en el último análisis.';
  var total = matches.reduce(function(s, m) { return s + (-m.monto); }, 0);

  // Top merchants — agrupar por merchant key
  var byM = {};
  matches.forEach(function(m) {
    var mk = m.descripcion.split(/-\d{4}-?\d|\s+\d{6,}/)[0].trim().substring(0, 30);
    if (!byM[mk]) byM[mk] = { sum: 0, count: 0 };
    byM[mk].sum += -m.monto;
    byM[mk].count++;
  });
  var topM = Object.keys(byM).map(function(k) { return { name: k, sum: byM[k].sum, count: byM[k].count }; })
    .sort(function(a, b) { return b.sum - a.sum; });

  var msg = _bancoCatLabel(catKey) + ' — *' + fmt(total) + '* en ' + matches.length + ' mov(s)\n\n';
  msg += '*Top merchants:*\n';
  var medals = ['🥇','🥈','🥉'];
  topM.slice(0, 5).forEach(function(m, i) {
    var pre = i < 3 ? medals[i] : '  ';
    msg += pre + ' ' + m.name + ' — ' + fmt(m.sum) + ' (' + m.count + 'x)\n';
  });
  if (topM.length > 5) msg += '   + ' + (topM.length - 5) + ' más\n';
  msg += '\n';

  // Por mes — bars relativos al máximo mensual
  var byMes = {};
  matches.forEach(function(m) {
    var ym = Utilities.formatDate(m.fecha, 'America/Panama', 'yyyy-MM');
    byMes[ym] = (byMes[ym] || 0) + (-m.monto);
  });
  var meses = Object.keys(byMes).sort();
  if (meses.length > 1) {
    var maxMes = Math.max.apply(null, meses.map(function(k){ return byMes[k]; }));
    msg += '*Por mes:*\n```\n';
    meses.forEach(function(ym) {
      msg += _bancoMesLabel(ym) + ' ' + _bancoBar(byMes[ym], maxMes) + ' ' + fmt(byMes[ym]) + '\n';
    });
    msg += '```\n';
  }
  return msg.substring(0, 4000);
}

function _bancoRenderDrillMes(cache, ym) {
  var fmt = _bancoFmtDolar;
  var matches = cache.movs.filter(function(m) {
    return Utilities.formatDate(m.fecha, 'America/Panama', 'yyyy-MM') === ym;
  });
  if (!matches.length) return '🤔 No encontré movimientos en *' + _bancoMesLabel(ym) + ' ' + ym.split('-')[0] + '* en el último análisis.';

  var totalIn = 0, totalOut = 0;
  var catTotals = {};
  var byMerchant = {};
  matches.forEach(function(m) {
    if (m.monto >= 0) totalIn += m.monto;
    else {
      totalOut += -m.monto;
      catTotals[m.cat] = (catTotals[m.cat] || 0) + (-m.monto);
      var mk = m.descripcion.split(/-\d{4}-?\d|\s+\d{6,}/)[0].trim().substring(0, 30);
      if (!byMerchant[mk]) byMerchant[mk] = { sum: 0, count: 0, cat: m.cat };
      byMerchant[mk].sum += -m.monto;
      byMerchant[mk].count++;
    }
  });

  var msg = '📅 *' + _bancoMesLabel(ym) + ' ' + ym.split('-')[0] + '* — ' + matches.length + ' movs\n\n';
  msg += '✅ Ingreso: ' + fmt(totalIn) + ' · ❌ Gasto: ' + fmt(totalOut);
  msg += ' · ' + (totalIn - totalOut >= 0 ? '💰' : '⚠️') + ' ' + fmt(totalIn - totalOut) + '\n\n';

  // Top categorías
  var topCats = Object.keys(catTotals).map(function(c) { return { cat: c, sum: catTotals[c] }; })
    .sort(function(a, b) { return b.sum - a.sum; }).slice(0, 5);
  if (topCats.length) {
    msg += '*Top categorías:*\n```\n' + _bancoBarsCategorias(topCats, totalOut) + '```\n\n';
  }

  // Top merchants no-transferencia
  var CATS_NO = ['ach_salida','yappy_salida','pago_tarjeta'];
  var topM = Object.keys(byMerchant)
    .filter(function(k) { return CATS_NO.indexOf(byMerchant[k].cat) < 0 && !/^YAPPY|TRANSFER/i.test(k); })
    .map(function(k) { return { name: k, sum: byMerchant[k].sum, count: byMerchant[k].count }; })
    .sort(function(a, b) { return b.sum - a.sum; });
  if (topM.length) {
    msg += '*Top merchants (excluye transfers):*\n';
    var medals = ['🥇','🥈','🥉'];
    topM.slice(0, 5).forEach(function(m, i) {
      var pre = i < 3 ? medals[i] : '  ';
      msg += pre + ' ' + m.name + ' — ' + fmt(m.sum) + ' (' + m.count + 'x)\n';
    });
  }
  return msg.substring(0, 4000);
}

function _bancoRenderDrillCross(cache, catKey, ym) {
  var fmt = _bancoFmtDolar;
  var matches = cache.movs.filter(function(m) {
    if (m.cat !== catKey || m.monto >= 0) return false;
    return Utilities.formatDate(m.fecha, 'America/Panama', 'yyyy-MM') === ym;
  });
  if (!matches.length) return '🤔 No encontré ' + _bancoCatLabel(catKey) + ' en ' + _bancoMesLabel(ym) + ' ' + ym.split('-')[0] + '.';
  var total = matches.reduce(function(s, m) { return s + (-m.monto); }, 0);

  var msg = _bancoCatLabel(catKey) + ' en *' + _bancoMesLabel(ym) + ' ' + ym.split('-')[0] + '* — *' + fmt(total) + '*\n\n';
  // Listar cada mov con fecha
  matches.sort(function(a, b) { return b.fecha - a.fecha; });
  matches.slice(0, 15).forEach(function(m) {
    var d = Utilities.formatDate(m.fecha, 'America/Panama', 'd MMM');
    msg += '  • ' + d + ' — ' + fmt(-m.monto) + ' ' + (m.descripcion.length > 35 ? m.descripcion.substring(0, 35) + '…' : m.descripcion) + '\n';
  });
  if (matches.length > 15) msg += '\n_+ ' + (matches.length - 15) + ' más_';
  return msg.substring(0, 4000);
}

// ════════════════════════════════════════════════════════════════════
//  EXPORT EXCEL — generar xlsx con la data analizada
//  ────────────────────────────────────────────────────────────────
//  Pipeline:
//    1. Crear un Spreadsheet temporal con SpreadsheetApp.create
//    2. Poblarlo con sheets Resumen + Movimientos + Mensual
//    3. Exportar como xlsx vía Drive REST API
//    4. Subir bytes a Meta como media
//    5. Mandar mensaje type=document con el media_id
//    6. Borrar el Spreadsheet temporal
//
//  Privacy: el sheet temporal vive en el Drive del owner del script
//  por ~5s, después se borra. Nunca se comparte.
// ════════════════════════════════════════════════════════════════════

// variant: 'full' (default — 20+ hojas), 'a' (simplificado 4 hojas),
// 'b' (dashboard 3 hojas). Sirve para A/B testing en producción.
function _bancoExportarExcel(cache, from, token, phoneId, variant) {
  variant = variant || 'full';
  var labelTexto = ({
    full: 'Excel completo',
    a:    'Excel simplificado (4 hojas)',
    b:    'Excel dashboard (3 hojas)',
  })[variant] || 'Excel';
  _whatsappReply(from, '📥 Generando tu ' + labelTexto + ', dame un momento…', token, phoneId);
  var tempId = null;
  try {
    var ss = SpreadsheetApp.create('analisis-' + variant + '-' + Date.now());
    tempId = ss.getId();
    if      (variant === 'a') _bancoPoblarXlsxSimple(ss, cache);
    else if (variant === 'b') _bancoPoblarXlsxDashboard(ss, cache);
    else                      _bancoPoblarXlsx(ss, cache);
    var xlsxBlob = _bancoSheetToXlsxBlob(tempId);
    var suffix = (variant === 'a') ? '-simple' : (variant === 'b') ? '-dashboard' : '';
    var fname = 'analisis-bancario' + suffix + '-' + Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd') + '.xlsx';
    xlsxBlob.setName(fname);
    var mediaId = _bancoUploadMediaWA(xlsxBlob, fname, token, phoneId);
    _bancoSendDocumentWA(from, mediaId, fname, '📊 Tu análisis bancario — ' + labelTexto, token, phoneId);
  } catch(err) {
    Logger.log('Banco excel export error (' + variant + '): ' + err.message + ' ' + (err.stack || ''));
    _whatsappReply(from, '⚠️ No pude generar el Excel: ' + err.message, token, phoneId);
  } finally {
    if (tempId) {
      try { DriveApp.getFileById(tempId).setTrashed(true); } catch(e) {}
    }
  }
}

// Genera y envía el reporte PDF on-demand. Necesita re-computar el
// analisis desde cache.movs (porque la cache solo guarda los movs
// slim, no el objeto analisis completo).
function _bancoExportarPDF(cache, from, token, phoneId) {
  _whatsappReply(from, '📑 Generando tu reporte PDF, dame un momento…', token, phoneId);
  try {
    var categorias = {};
    cache.movs.forEach(function(m) { categorias[m.descripcion] = m.cat; });
    var analisis = _bancoAnalizar(cache.movs, categorias);
    analisis.historial = cache.historial || [];
    _bancoEnviarReportePDF(analisis, from, token, phoneId);
  } catch(err) {
    Logger.log('Banco PDF export error: ' + err.message + ' ' + (err.stack || ''));
    _whatsappReply(from, '⚠️ No pude generar el PDF: ' + err.message, token, phoneId);
  }
}

// ════════════════════════════════════════════════════════════════════
//  VARIANTE A — Excel simplificado (4 hojas)
//  Diagnóstico + Movimientos enriquecido + Cat × Mes + Dest × Mes
// ════════════════════════════════════════════════════════════════════

function _bancoPoblarXlsxSimple(ss, cache) {
  var agg = _bancoComputarAggsParaSimple(cache.movs);

  // 1. Diagnóstico (reusa el helper existente)
  var shD = ss.getActiveSheet();
  shD.setName('Diagnóstico');
  try {
    _bancoPoblarDiagnostico(shD, cache, {
      totalIn:   agg.totalIn,
      totalOut:  agg.totalOut,
      catTotals: agg.catTotals,
      catMovs:   agg.catMovs,
      mesMovs:   agg.mesMovs,
      topCats:   agg.topCatsKeys,
      meses:     agg.meses,
    });
  } catch(e) { Logger.log('Simple Diagnóstico skip: ' + e.message); }

  // 2. Movimientos enriquecido (todas las transacciones con cols analíticas)
  var shM = ss.insertSheet('Movimientos');
  _bancoPoblarMovimientosEnriquecido(shM, cache.movs);

  // 3. Cat × Mes (matriz con heatmap)
  var shC = ss.insertSheet('Categorías × Mes');
  _bancoPoblarMatrizCatMes(shC, agg);

  // 4. Dest × Mes (matriz con heatmap, top 30)
  var shTD = ss.insertSheet('Destinatarios × Mes');
  _bancoPoblarMatrizDestMes(shTD, agg);

  ss.setActiveSheet(shD);
  SpreadsheetApp.flush();
}

// ════════════════════════════════════════════════════════════════════
//  VARIANTE B — Excel dashboard (3 hojas)
//  Dashboard (todo apilado) + Movimientos enriquecido + Tabla Dinámica guía
// ════════════════════════════════════════════════════════════════════

function _bancoPoblarXlsxDashboard(ss, cache) {
  var agg = _bancoComputarAggsParaSimple(cache.movs);

  // 1. Dashboard: diagnóstico + matriz cat + matriz dest, todo apilado
  var shD = ss.getActiveSheet();
  shD.setName('Dashboard');
  _bancoPoblarDashboardCompacto(shD, cache, agg);

  // 2. Movimientos enriquecido
  var shM = ss.insertSheet('Movimientos');
  _bancoPoblarMovimientosEnriquecido(shM, cache.movs);

  // 3. Tabla dinámica: 3 pivot tables pre-armadas pointing a Movimientos.
  //    El usuario las puede modificar (cambiar agrupaciones, filtros, etc.)
  //    desde la UI nativa de Sheets/Excel.
  var shP = ss.insertSheet('Tablas Dinámicas');
  _bancoPoblarPivotsPreArmados(shP, cache.movs, agg);

  ss.setActiveSheet(shD);
  SpreadsheetApp.flush();
}

// Computa los aggregates necesarios para las variantes A y B en una
// sola pasada — más eficiente que recorrer movs múltiples veces.
function _bancoComputarAggsParaSimple(movs) {
  var totalIn = 0, totalOut = 0;
  var catTotals = {};
  var catMovs = {};
  var mesMovs = {};
  var catByMes = {};      // cat → { ym → sum }
  var destTotals = {};
  var destByMes = {};     // dest → { ym → sum }
  var mesesSet = {};

  movs.forEach(function(m) {
    var ym = Utilities.formatDate(m.fecha, 'America/Panama', 'yyyy-MM');
    mesesSet[ym] = true;
    if (!mesMovs[ym]) mesMovs[ym] = [];
    mesMovs[ym].push(m);
    if (m.monto >= 0) {
      totalIn += m.monto;
    } else {
      var s = -m.monto;
      totalOut += s;
      catTotals[m.cat] = (catTotals[m.cat] || 0) + s;
      if (!catMovs[m.cat]) catMovs[m.cat] = [];
      catMovs[m.cat].push(m);
      if (!catByMes[m.cat]) catByMes[m.cat] = {};
      catByMes[m.cat][ym] = (catByMes[m.cat][ym] || 0) + s;
      var dest = _bancoExtractDestinatario(m);
      destTotals[dest] = (destTotals[dest] || 0) + s;
      if (!destByMes[dest]) destByMes[dest] = {};
      destByMes[dest][ym] = (destByMes[dest][ym] || 0) + s;
    }
  });

  var meses = Object.keys(mesesSet).sort().slice(-12);
  var topCatsKeys = Object.keys(catTotals)
    .sort(function(a, b) { return catTotals[b] - catTotals[a]; })
    .slice(0, 10);
  var topDestKeys = Object.keys(destTotals)
    .sort(function(a, b) { return destTotals[b] - destTotals[a]; })
    .slice(0, 30);

  return {
    totalIn: totalIn, totalOut: totalOut,
    catTotals: catTotals, catMovs: catMovs, catByMes: catByMes,
    destTotals: destTotals, destByMes: destByMes,
    mesMovs: mesMovs, meses: meses,
    topCatsKeys: topCatsKeys, topDestKeys: topDestKeys,
  };
}

// Una hoja con TODAS las transacciones + columnas analíticas. El user
// usa autofilter de Excel para slicear (reemplaza los Detalle - X).
function _bancoPoblarMovimientosEnriquecido(sh, movs) {
  var headers = ['Fecha', 'Año', 'Mes', 'Día', 'Día semana',
                 'Monto', '|Monto|', 'Tipo', 'Categoría',
                 'Destinatario', 'Descripción', 'Saldo'];
  var dias = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
  var rows = movs.slice().sort(function(a, b) { return b.fecha - a.fecha; }).map(function(m) {
    var d = m.fecha;
    var dest = _bancoExtractDestinatario(m);
    var tipo = m.monto >= 0 ? 'Ingreso' : 'Gasto';
    return [
      d,
      d ? d.getFullYear() : '',
      d ? _bancoMesLabelFull(Utilities.formatDate(d, 'America/Panama', 'yyyy-MM')) : '',
      d ? d.getDate() : '',
      d ? dias[d.getDay()] : '',
      m.monto,
      Math.abs(m.monto),
      tipo,
      _bancoCatLabel(m.cat),
      dest,
      m.descripcion,
      m.saldo != null ? m.saldo : '',
    ];
  });
  var all = [headers].concat(rows);
  sh.getRange(1, 1, all.length, headers.length).setValues(all);

  // Estilos
  sh.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold').setBackground('#1A1A2E').setFontColor('#FFFFFF');
  sh.setFrozenRows(1);
  // Montos como moneda
  sh.getRange(2, 6, rows.length, 2).setNumberFormat('$#,##0.00');
  sh.getRange(2, 12, rows.length, 1).setNumberFormat('$#,##0.00');
  // Anchos
  var widths = [90, 60, 90, 50, 80, 95, 95, 75, 150, 200, 320, 95];
  widths.forEach(function(w, i) { sh.setColumnWidth(i + 1, w); });
  // Autofilter
  try {
    if (sh.getFilter()) sh.getFilter().remove();
    if (rows.length > 0) sh.getRange(1, 1, all.length, headers.length).createFilter();
  } catch(e) { Logger.log('Movs filter skip: ' + e.message); }
}

// Matriz cat × mes con heatmap.
function _bancoPoblarMatrizCatMes(sh, agg) {
  var nMeses = agg.meses.length;
  var headers = ['Categoría'];
  agg.meses.forEach(function(ym) { headers.push(_bancoMesAbbrev(ym)); });
  headers.push('Total');
  headers.push('% del gasto');

  var rows = [headers];
  agg.topCatsKeys.forEach(function(c) {
    var row = [_bancoCatLabel(c)];
    var rowTotal = agg.catTotals[c];
    agg.meses.forEach(function(ym) {
      row.push((agg.catByMes[c] && agg.catByMes[c][ym]) || 0);
    });
    row.push(rowTotal);
    var pct = agg.totalOut > 0 ? Math.round((rowTotal / agg.totalOut) * 100) : 0;
    row.push(pct + '%');
    rows.push(row);
  });
  // Totales por columna
  var totalRow = ['TOTAL'];
  agg.meses.forEach(function(ym) {
    var s = 0;
    agg.topCatsKeys.forEach(function(c) { s += (agg.catByMes[c] && agg.catByMes[c][ym]) || 0; });
    totalRow.push(s);
  });
  totalRow.push(agg.totalOut);
  totalRow.push('100%');
  rows.push(totalRow);

  sh.getRange(1, 1, rows.length, headers.length).setValues(rows);
  sh.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#1A1A2E').setFontColor('#FFFFFF');
  sh.getRange(rows.length, 1, 1, headers.length).setFontWeight('bold').setBackground('#F1F3F5');
  // Moneda en cols de meses + total
  sh.getRange(2, 2, rows.length - 1, nMeses + 1).setNumberFormat('$#,##0.00');
  sh.setFrozenRows(1);
  sh.setFrozenColumns(1);
  sh.setColumnWidth(1, 200);
  for (var i = 0; i < nMeses; i++) sh.setColumnWidth(2 + i, 90);
  sh.setColumnWidth(2 + nMeses, 110);
  sh.setColumnWidth(3 + nMeses, 90);
  // Heatmap solo en las celdas de meses (no totales)
  if (nMeses > 0 && rows.length > 2) {
    try {
      var hmRange = sh.getRange(2, 2, agg.topCatsKeys.length, nMeses);
      var rule = SpreadsheetApp.newConditionalFormatRule()
        .setGradientMinpointWithValue('#E8F5E9', SpreadsheetApp.InterpolationType.NUMBER, '0')
        .setGradientMaxpoint('#EF5350')
        .setRanges([hmRange]).build();
      var existing = sh.getConditionalFormatRules();
      existing.push(rule);
      sh.setConditionalFormatRules(existing);
    } catch(e) { Logger.log('Heatmap cat skip: ' + e.message); }
  }
}

// Matriz destinatario × mes (top 30) con heatmap.
function _bancoPoblarMatrizDestMes(sh, agg) {
  var nMeses = agg.meses.length;
  var headers = ['Destinatario / Merchant'];
  agg.meses.forEach(function(ym) { headers.push(_bancoMesAbbrev(ym)); });
  headers.push('Total');
  headers.push('% del gasto');

  var rows = [headers];
  agg.topDestKeys.forEach(function(d) {
    var row = [d];
    var rowTotal = agg.destTotals[d];
    agg.meses.forEach(function(ym) {
      row.push((agg.destByMes[d] && agg.destByMes[d][ym]) || 0);
    });
    row.push(rowTotal);
    var pct = agg.totalOut > 0 ? Math.round((rowTotal / agg.totalOut) * 100) : 0;
    row.push(pct + '%');
    rows.push(row);
  });
  // Otros (si hay > 30)
  var totalDests = Object.keys(agg.destTotals).length;
  if (totalDests > 30) {
    var otros = Object.keys(agg.destTotals).slice(30);
    var otrosRow = ['Otros (' + otros.length + ' más)'];
    var otrosTotal = 0;
    agg.meses.forEach(function(ym) {
      var s = 0;
      otros.forEach(function(d) { s += (agg.destByMes[d] && agg.destByMes[d][ym]) || 0; });
      otrosRow.push(s);
    });
    otros.forEach(function(d) { otrosTotal += agg.destTotals[d]; });
    otrosRow.push(otrosTotal);
    var pctO = agg.totalOut > 0 ? Math.round((otrosTotal / agg.totalOut) * 100) : 0;
    otrosRow.push(pctO + '%');
    rows.push(otrosRow);
  }

  sh.getRange(1, 1, rows.length, headers.length).setValues(rows);
  sh.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#1A1A2E').setFontColor('#FFFFFF');
  sh.getRange(2, 2, rows.length - 1, nMeses + 1).setNumberFormat('$#,##0.00');
  sh.setFrozenRows(1);
  sh.setFrozenColumns(1);
  sh.setColumnWidth(1, 240);
  for (var i = 0; i < nMeses; i++) sh.setColumnWidth(2 + i, 90);
  sh.setColumnWidth(2 + nMeses, 110);
  sh.setColumnWidth(3 + nMeses, 90);
  // Heatmap
  if (nMeses > 0 && rows.length > 1) {
    try {
      var hmRange = sh.getRange(2, 2, rows.length - 1, nMeses);
      var rule = SpreadsheetApp.newConditionalFormatRule()
        .setGradientMinpointWithValue('#E8F5E9', SpreadsheetApp.InterpolationType.NUMBER, '0')
        .setGradientMaxpoint('#EF5350')
        .setRanges([hmRange]).build();
      var existing = sh.getConditionalFormatRules();
      existing.push(rule);
      sh.setConditionalFormatRules(existing);
    } catch(e) { Logger.log('Heatmap dest skip: ' + e.message); }
  }
}

// Dashboard compacto (variante B): diagnóstico arriba, después las dos
// matrices apiladas en la misma hoja. Mucho scroll pero todo a la vista.
// Dashboard visual con cards + charts nativos + matrices.
// Reemplaza el approach text-heavy anterior por algo más visual,
// con insights distribuidos al lado de las gráficas, no en bloques largos.
function _bancoPoblarDashboardCompacto(sh, cache, agg) {
  var fmt = function(n) {
    if (!isFinite(n)) return '$0';
    return '$' + Math.round(n).toLocaleString('en-US');
  };
  var fechaStr = function(d) {
    return d ? Utilities.formatDate(d, 'America/Panama', "d MMM") : '—';
  };

  var ahorro = agg.totalIn > 0 ? Math.round(((agg.totalIn - agg.totalOut) / agg.totalIn) * 100) : 0;
  var neto = agg.totalIn - agg.totalOut;

  // Saldo + delta (mismo método que _bancoAnalizar)
  var first = cache.movs[0], last = cache.movs[cache.movs.length - 1];
  var saldoIni = null, saldoFin = null, deltaSaldo = null;
  if (first && last && first.saldo != null && last.saldo != null) {
    var bgStyle = !first.fecha || !last.fecha || first.fecha >= last.fecha;
    var newest = bgStyle ? first : last;
    var oldest = bgStyle ? last  : first;
    if (newest.saldo != null && oldest.saldo != null) {
      saldoFin   = newest.saldo;
      saldoIni   = oldest.saldo - oldest.monto;
      deltaSaldo = saldoFin - saldoIni;
    }
  }

  var fechas = cache.movs.map(function(m) { return m.fecha; }).filter(Boolean).sort(function(a, b) { return a - b; });
  var dias = fechas.length ? Math.max(1, Math.round((fechas[fechas.length-1] - fechas[0]) / 86400000) + 1) : 0;

  var row = 1;
  var COLS_VISIBLE = 12;

  // ════════ HEADER (banner) ════════
  sh.getRange(row, 1, 1, COLS_VISIBLE).merge()
    .setValue('REPORTE BANCARIO · ANÁLISIS EJECUTIVO')
    .setFontSize(22).setFontWeight('bold')
    .setBackground('#1A1A2E').setFontColor('#FFFFFF')
    .setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.setRowHeight(row, 48);
  row++;

  // Período subtitle
  var periodoTxt = fechaStr(fechas[0]) + ' – ' + fechaStr(fechas[fechas.length-1]) +
                   ' · ' + cache.movs.length + ' movimientos · ' + dias + ' días';
  sh.getRange(row, 1, 1, COLS_VISIBLE).merge()
    .setValue(periodoTxt)
    .setFontSize(11).setFontColor('#6b7280')
    .setHorizontalAlignment('center');
  sh.setRowHeight(row, 24);
  row += 2;

  // ════════ SALDO ════════
  if (saldoFin != null) {
    var saldoTxt = '💵 Saldo final: ' + fmt(saldoFin);
    if (deltaSaldo != null) {
      var arrow = deltaSaldo >= 0 ? '↗' : '↘';
      var sign  = deltaSaldo >= 0 ? '+' : '−';
      saldoTxt += '       ' + arrow + ' ' + sign + fmt(Math.abs(deltaSaldo)) + ' vs inicial (' + fmt(saldoIni) + ')';
    }
    sh.getRange(row, 1, 1, COLS_VISIBLE).merge()
      .setValue(saldoTxt)
      .setFontSize(15).setFontWeight('bold')
      .setBackground('#fff7ed').setFontColor('#1A1A2E')
      .setHorizontalAlignment('center');
    sh.setRowHeight(row, 36);
    row += 2;
  }

  // ════════ FLUJO (3 cards horizontales, 4 cols cada una) ════════
  var ahCls = neto >= 0 ? { bg: '#d1fae5', fg: '#064e3b' } : { bg: '#fee2e2', fg: '#7f1d1d' };
  var flujoCards = [
    { label: 'INGRESOS', valor: fmt(agg.totalIn), nota: '', bg: '#d1fae5', fg: '#064e3b' },
    { label: 'GASTOS',   valor: fmt(agg.totalOut), nota: '', bg: '#fee2e2', fg: '#7f1d1d' },
    { label: (neto >= 0 ? 'AHORRO NETO' : 'DÉFICIT'), valor: fmt(Math.abs(neto)), nota: (ahorro >= 0 ? '+' : '') + ahorro + '% del ingreso', bg: ahCls.bg, fg: ahCls.fg },
  ];
  flujoCards.forEach(function(card, i) {
    var startCol = 1 + i * 4;
    sh.getRange(row, startCol, 1, 4).merge()
      .setValue(card.label)
      .setFontSize(10).setFontWeight('bold')
      .setBackground(card.bg).setFontColor(card.fg)
      .setHorizontalAlignment('center');
    sh.getRange(row + 1, startCol, 1, 4).merge()
      .setValue(card.valor)
      .setFontSize(20).setFontWeight('bold')
      .setBackground(card.bg).setFontColor(card.fg)
      .setHorizontalAlignment('center');
    if (card.nota) {
      sh.getRange(row + 2, startCol, 1, 4).merge()
        .setValue(card.nota)
        .setFontSize(10).setFontStyle('italic')
        .setBackground(card.bg).setFontColor(card.fg)
        .setHorizontalAlignment('center');
    }
  });
  sh.setRowHeight(row, 22);
  sh.setRowHeight(row + 1, 38);
  sh.setRowHeight(row + 2, 22);
  row += 4;

  // ════════ SEMÁFORO (2x2 cards de 6 cols cada una) ════════
  var semaforo = _bancoPDFComputarSemaforo({
    totalIn: agg.totalIn, totalOut: agg.totalOut, dias: dias,
    deltaSaldo: deltaSaldo, saldoFin: saldoFin,
    topCats: agg.topCatsKeys.slice(0, 8).map(function(c) { return { cat: c, sum: agg.catTotals[c] }; }),
  }, ahorro);
  var SEM_BG = { green: '#d1fae5', yellow: '#fef3c7', red: '#fee2e2' };
  var SEM_FG = { green: '#064e3b', yellow: '#78350f', red: '#7f1d1d' };

  for (var s = 0; s < semaforo.length; s += 2) {
    [0, 1].forEach(function(j) {
      var sem = semaforo[s + j];
      if (!sem) return;
      var startCol = 1 + j * 6;
      var bg = SEM_BG[sem.color] || '#fff';
      var fg = SEM_FG[sem.color] || '#1f2937';
      sh.getRange(row, startCol, 1, 6).merge()
        .setValue(sem.label.toUpperCase())
        .setFontSize(10).setFontWeight('bold')
        .setBackground(bg).setFontColor(fg)
        .setHorizontalAlignment('center');
      sh.getRange(row + 1, startCol, 1, 6).merge()
        .setValue(String(sem.valor != null ? sem.valor : ''))
        .setFontSize(16).setFontWeight('bold')
        .setBackground(bg).setFontColor(fg)
        .setHorizontalAlignment('center');
      sh.getRange(row + 2, startCol, 1, 6).merge()
        .setValue(sem.comentario)
        .setFontSize(9).setFontStyle('italic')
        .setBackground(bg).setFontColor(fg)
        .setHorizontalAlignment('center').setWrap(true);
    });
    sh.setRowHeight(row, 20);
    sh.setRowHeight(row + 1, 32);
    sh.setRowHeight(row + 2, 30);
    row += 4;
  }

  // ════════ CHARTS SIDE-BY-SIDE (donut + bar) ════════
  // Data en filas remotas (col Z+) para no contaminar visualmente.
  var CHART_DATA_ROW = 300;

  // --- Pie/Donut data ---
  var pieData = [['Categoría', 'Monto']];
  agg.topCatsKeys.slice(0, 7).forEach(function(c) {
    pieData.push([_bancoCatPlain(c), agg.catTotals[c]]);
  });
  if (agg.topCatsKeys.length > 7) {
    var resto = agg.topCatsKeys.slice(7);
    var sumResto = resto.reduce(function(s, c) { return s + agg.catTotals[c]; }, 0);
    pieData.push(['Otros', sumResto]);
  }
  sh.getRange(CHART_DATA_ROW, 26, pieData.length, 2).setValues(pieData);

  // --- Bar data (tendencia mensual) ---
  var BAR_DATA_ROW = 320;
  var barData = [['Mes', 'Gasto']];
  var gastoPorMes = [];  // para análisis abajo
  agg.meses.forEach(function(ym) {
    var sum = 0;
    Object.keys(agg.catTotals).forEach(function(c) {
      sum += (agg.catByMes[c] && agg.catByMes[c][ym]) || 0;
    });
    barData.push([_bancoMesAbbrev(ym), sum]);
    gastoPorMes.push({ ym: ym, sum: sum });
  });
  sh.getRange(BAR_DATA_ROW, 26, barData.length, 2).setValues(barData);

  // --- Pie chart en la mitad izquierda (cols 1-6) ---
  var pieChart = sh.newChart()
    .setChartType(Charts.ChartType.PIE)
    .addRange(sh.getRange(CHART_DATA_ROW, 26, pieData.length, 2))
    .setPosition(row, 1, 0, 0)
    .setOption('title', 'Top categorías de gasto')
    .setOption('titleTextStyle', { fontSize: 13, bold: true })
    .setOption('pieHole', 0.5)
    .setOption('width', 440)
    .setOption('height', 280)
    .setOption('legend', { position: 'right', textStyle: { fontSize: 10 } })
    .setOption('colors', ['#ea580c','#0891b2','#7c3aed','#059669','#dc2626','#f59e0b','#0284c7','#6b7280'])
    .build();
  sh.insertChart(pieChart);

  // --- Bar chart en la mitad derecha (cols 7-12) ---
  var barChart = sh.newChart()
    .setChartType(Charts.ChartType.COLUMN)
    .addRange(sh.getRange(BAR_DATA_ROW, 26, barData.length, 2))
    .setPosition(row, 7, 0, 0)
    .setOption('title', 'Tendencia mensual')
    .setOption('titleTextStyle', { fontSize: 13, bold: true })
    .setOption('legend', { position: 'none' })
    .setOption('colors', ['#fb923c'])
    .setOption('width', 440)
    .setOption('height', 280)
    .setOption('vAxis', { format: '$#,##0' })
    .build();
  sh.insertChart(barChart);

  row += 15;  // espacio para charts (280px ≈ 15 rows de 20px)

  // ─── Análisis breve debajo de cada chart ───
  // Texto pie: top 3 cats con %
  var pieAnalisis = '';
  if (agg.topCatsKeys.length) {
    var pieTop = agg.topCatsKeys.slice(0, 3).map(function(c) {
      var p = agg.totalOut > 0 ? Math.round((agg.catTotals[c] / agg.totalOut) * 100) : 0;
      return _bancoCatPlain(c) + ' ' + p + '%';
    });
    pieAnalisis = 'Top 3: ' + pieTop.join(' · ');
  }
  sh.getRange(row, 1, 1, 6).merge()
    .setValue(pieAnalisis).setFontSize(10).setFontStyle('italic')
    .setFontColor('#6b7280').setHorizontalAlignment('center').setWrap(true);

  // Texto bar: pico, valle, variación
  var barAnalisis = '';
  if (gastoPorMes.length >= 2) {
    var sorted = gastoPorMes.slice().sort(function(a, b) { return b.sum - a.sum; });
    var pico = sorted[0], valle = sorted[sorted.length - 1];
    var avg = gastoPorMes.reduce(function(s, g) { return s + g.sum; }, 0) / gastoPorMes.length;
    barAnalisis = 'Pico: ' + _bancoMesAbbrev(pico.ym) + ' $' + Math.round(pico.sum).toLocaleString('en-US') +
                  ' · Valle: ' + _bancoMesAbbrev(valle.ym) + ' $' + Math.round(valle.sum).toLocaleString('en-US') +
                  ' · Promedio mensual: $' + Math.round(avg).toLocaleString('en-US');
  }
  sh.getRange(row, 7, 1, 6).merge()
    .setValue(barAnalisis).setFontSize(10).setFontStyle('italic')
    .setFontColor('#6b7280').setHorizontalAlignment('center').setWrap(true);
  sh.setRowHeight(row, 28);
  row += 2;

  // ════════ MATRIZ Cat × Mes ════════
  sh.getRange(row, 1, 1, COLS_VISIBLE).merge()
    .setValue('📊 GASTO POR CATEGORÍA × MES')
    .setFontSize(13).setFontWeight('bold')
    .setBackground('#1A1A2E').setFontColor('#FFFFFF')
    .setHorizontalAlignment('center');
  sh.setRowHeight(row, 28);
  row += 2;

  var catHeaders = ['Categoría'];
  agg.meses.forEach(function(ym) { catHeaders.push(_bancoMesAbbrev(ym)); });
  catHeaders.push('Total');
  catHeaders.push('%');
  sh.getRange(row, 1, 1, catHeaders.length).setValues([catHeaders])
    .setFontWeight('bold').setBackground('#F1F3F5');
  row++;
  var catRowsStart = row;
  agg.topCatsKeys.forEach(function(c) {
    var rowData = [_bancoCatLabel(c)];
    var rowTotal = agg.catTotals[c];
    agg.meses.forEach(function(ym) { rowData.push((agg.catByMes[c] && agg.catByMes[c][ym]) || 0); });
    rowData.push(rowTotal);
    var pct = agg.totalOut > 0 ? Math.round((rowTotal / agg.totalOut) * 100) : 0;
    rowData.push(pct + '%');
    sh.getRange(row, 1, 1, rowData.length).setValues([rowData]);
    row++;
  });
  if (agg.meses.length > 0 && agg.topCatsKeys.length > 0) {
    sh.getRange(catRowsStart, 2, agg.topCatsKeys.length, agg.meses.length + 1).setNumberFormat('$#,##0');
    sh.getRange(catRowsStart, 2 + agg.meses.length, agg.topCatsKeys.length, 1).setFontWeight('bold');
    try {
      var hmCat = sh.getRange(catRowsStart, 2, agg.topCatsKeys.length, agg.meses.length);
      var ruleC = SpreadsheetApp.newConditionalFormatRule()
        .setGradientMinpointWithValue('#E8F5E9', SpreadsheetApp.InterpolationType.NUMBER, '0')
        .setGradientMaxpoint('#EF5350')
        .setRanges([hmCat]).build();
      var ex1 = sh.getConditionalFormatRules(); ex1.push(ruleC);
      sh.setConditionalFormatRules(ex1);
    } catch(e) { Logger.log('Dashboard heatmap cat skip: ' + e.message); }
  }
  row += 2;

  // ════════ MATRIZ Dest × Mes (top 15) ════════
  sh.getRange(row, 1, 1, COLS_VISIBLE).merge()
    .setValue('🎯 GASTO POR DESTINATARIO × MES (top 15)')
    .setFontSize(13).setFontWeight('bold')
    .setBackground('#1A1A2E').setFontColor('#FFFFFF')
    .setHorizontalAlignment('center');
  sh.setRowHeight(row, 28);
  row += 2;

  var destHeaders = ['Destinatario'];
  agg.meses.forEach(function(ym) { destHeaders.push(_bancoMesAbbrev(ym)); });
  destHeaders.push('Total');
  destHeaders.push('%');
  sh.getRange(row, 1, 1, destHeaders.length).setValues([destHeaders])
    .setFontWeight('bold').setBackground('#F1F3F5');
  row++;
  var destRowsStart = row;
  var top15Dest = agg.topDestKeys.slice(0, 15);
  top15Dest.forEach(function(d) {
    var rowData = [d];
    var rowTotal = agg.destTotals[d];
    agg.meses.forEach(function(ym) { rowData.push((agg.destByMes[d] && agg.destByMes[d][ym]) || 0); });
    rowData.push(rowTotal);
    var pct = agg.totalOut > 0 ? Math.round((rowTotal / agg.totalOut) * 100) : 0;
    rowData.push(pct + '%');
    sh.getRange(row, 1, 1, rowData.length).setValues([rowData]);
    row++;
  });
  if (agg.meses.length > 0 && top15Dest.length > 0) {
    sh.getRange(destRowsStart, 2, top15Dest.length, agg.meses.length + 1).setNumberFormat('$#,##0');
    sh.getRange(destRowsStart, 2 + agg.meses.length, top15Dest.length, 1).setFontWeight('bold');
    try {
      var hmDest = sh.getRange(destRowsStart, 2, top15Dest.length, agg.meses.length);
      var ruleD = SpreadsheetApp.newConditionalFormatRule()
        .setGradientMinpointWithValue('#E8F5E9', SpreadsheetApp.InterpolationType.NUMBER, '0')
        .setGradientMaxpoint('#EF5350')
        .setRanges([hmDest]).build();
      var ex2 = sh.getConditionalFormatRules(); ex2.push(ruleD);
      sh.setConditionalFormatRules(ex2);
    } catch(e) { Logger.log('Dashboard heatmap dest skip: ' + e.message); }
  }
  row += 2;

  // ════════ HALLAZGOS (concisos, 1 línea c/u) ════════
  var hallazgos = _bancoDashboardHallazgosConcisos(cache.movs, agg, dias);
  if (hallazgos.length) {
    sh.getRange(row, 1, 1, COLS_VISIBLE).merge()
      .setValue('💡 HALLAZGOS ACCIONABLES')
      .setFontSize(13).setFontWeight('bold')
      .setBackground('#1A1A2E').setFontColor('#FFFFFF')
      .setHorizontalAlignment('center');
    sh.setRowHeight(row, 28);
    row++;
    hallazgos.forEach(function(h) {
      sh.getRange(row, 1, 1, COLS_VISIBLE).merge()
        .setValue('• ' + h)
        .setFontSize(11)
        .setBackground('#fff7ed').setFontColor('#9a3412')
        .setHorizontalAlignment('left').setVerticalAlignment('middle');
      sh.setRowHeight(row, 24);
      row++;
    });
    row++;
  }

  // ════════ Anchos de columna del dashboard ════════
  // 12 cols a ancho moderado para que el layout funcione con cards de 4 y 6 cols
  for (var c = 1; c <= COLS_VISIBLE; c++) {
    sh.setColumnWidth(c, 95);
  }
  // Esconder columnas de la data oculta de los charts (col 26+)
  try { sh.hideColumns(26, 5); } catch(e) { Logger.log('Hide cols skip: ' + e.message); }
  sh.setHiddenGridlines(true);
}

// Genera 3-5 hallazgos concisos para el dashboard (1 línea c/u).
function _bancoDashboardHallazgosConcisos(movs, agg, dias) {
  var fmt = function(n) { return '$' + Math.round(n).toLocaleString('en-US'); };
  var out = [];

  // Top cat de consumo (sin transferencias)
  var CATS_NO = ['ach_salida', 'yappy_salida', 'pago_tarjeta', 'otro'];
  var topConsumo = agg.topCatsKeys.filter(function(c) { return CATS_NO.indexOf(c) < 0; })[0];
  if (topConsumo) {
    var pct = agg.totalOut > 0 ? Math.round((agg.catTotals[topConsumo] / agg.totalOut) * 100) : 0;
    out.push('Top categoría de consumo: ' + _bancoCatLabel(topConsumo) + ' · ' + fmt(agg.catTotals[topConsumo]) + ' (' + pct + '% del gasto)');
  }

  // Top destinatario
  if (agg.topDestKeys.length) {
    var topD = agg.topDestKeys[0];
    var pctD = agg.totalOut > 0 ? Math.round((agg.destTotals[topD] / agg.totalOut) * 100) : 0;
    out.push('Top destinatario: ' + topD + ' · ' + fmt(agg.destTotals[topD]) + ' (' + pctD + '%)');
  }

  // Gastos chicos
  var chicos = movs.filter(function(m) { return m.monto < 0 && m.monto > -10; });
  if (chicos.length >= 10) {
    var sumChicos = chicos.reduce(function(s, m) { return s + Math.abs(m.monto); }, 0);
    var anual = dias > 0 ? (sumChicos / dias) * 365 : 0;
    out.push('Gastos chicos <$10: ' + chicos.length + ' compras = ' + fmt(sumChicos) + ' (proyección anual ' + fmt(anual) + ')');
  }

  // Form 90 deducibles
  var form90 = ['salud','educacion','seguro','prestamo']
    .filter(function(c) { return agg.catTotals[c]; });
  if (form90.length) {
    var sumF90 = form90.reduce(function(s, c) { return s + agg.catTotals[c]; }, 0);
    out.push('Deducibles Form 90 detectados: ' + fmt(sumF90) + ' (' + form90.map(_bancoCatPlain).join(', ') + ')');
  }

  // Yappy (si hay)
  var totalYappy = (agg.catTotals['yappy_salida'] || 0);
  if (totalYappy >= 100) {
    var pctY = agg.totalOut > 0 ? Math.round((totalYappy / agg.totalOut) * 100) : 0;
    out.push('Yappys enviados: ' + fmt(totalYappy) + ' (' + pctY + '% del gasto)');
  }

  return out.slice(0, 5);
}

// Hoja con 3 tablas analíticas pre-calculadas (snapshots con data real).
// Las pivots nativas de Sheets no siempre se preservan al exportar a xlsx;
// por eso renderear los valores directo asegura que el usuario VEA la data
// al abrir el archivo, sin necesidad de refresh.
//
// Cada tabla incluye:
//   - Heading con tipo de análisis
//   - Headers (filas/columnas/valores)
//   - Data calculada
//   - Heatmap sobre las celdas de valor
//   - Total + % por fila
//
// Al pie: instrucciones de cómo crear pivots dinámicas desde Movimientos.
function _bancoPoblarPivotsPreArmados(sh, movs, agg) {
  var nMeses = agg.meses.length;
  var fmtMoney = function(n) { return '$' + Math.round(n).toLocaleString('en-US'); };
  var addHeatmap = function(range) {
    try {
      var rule = SpreadsheetApp.newConditionalFormatRule()
        .setGradientMinpointWithValue('#E8F5E9', SpreadsheetApp.InterpolationType.NUMBER, '0')
        .setGradientMaxpoint('#EF5350')
        .setRanges([range]).build();
      var ex = sh.getConditionalFormatRules();
      ex.push(rule);
      sh.setConditionalFormatRules(ex);
    } catch(e) { Logger.log('Heatmap skip: ' + e.message); }
  };

  // ════════ HEADER + INTRO ════════
  sh.getRange(1, 1, 1, 12).merge()
    .setValue('📊 TABLAS DINÁMICAS')
    .setFontSize(18).setFontWeight('bold')
    .setBackground('#1A1A2E').setFontColor('#FFFFFF')
    .setHorizontalAlignment('center');
  sh.setRowHeight(1, 36);

  sh.getRange(2, 1, 1, 12).merge()
    .setValue('3 vistas analíticas pre-calculadas (' + movs.length + ' movs). Filtradas a *Gastos* (excluye ingresos).')
    .setFontSize(10).setFontStyle('italic').setFontColor('#6b7280')
    .setHorizontalAlignment('center');
  var nextRow = 4;

  // ════════ TABLA 1: Categoría × Mes ════════
  sh.getRange(nextRow, 1, 1, 12).merge()
    .setValue('1️⃣ GASTO POR CATEGORÍA × MES')
    .setFontSize(13).setFontWeight('bold')
    .setBackground('#fb923c').setFontColor('#FFFFFF')
    .setHorizontalAlignment('center');
  nextRow += 2;
  // Headers
  var t1Headers = ['Categoría'];
  agg.meses.forEach(function(ym) { t1Headers.push(_bancoMesAbbrev(ym)); });
  t1Headers.push('Total');
  t1Headers.push('%');
  sh.getRange(nextRow, 1, 1, t1Headers.length).setValues([t1Headers])
    .setFontWeight('bold').setBackground('#F1F3F5');
  nextRow++;
  var t1Start = nextRow;
  agg.topCatsKeys.forEach(function(c) {
    var row = [_bancoCatLabel(c)];
    var total = agg.catTotals[c];
    agg.meses.forEach(function(ym) { row.push((agg.catByMes[c] && agg.catByMes[c][ym]) || 0); });
    row.push(total);
    var pct = agg.totalOut > 0 ? Math.round((total / agg.totalOut) * 100) : 0;
    row.push(pct + '%');
    sh.getRange(nextRow, 1, 1, row.length).setValues([row]);
    nextRow++;
  });
  if (agg.topCatsKeys.length > 0 && nMeses > 0) {
    sh.getRange(t1Start, 2, agg.topCatsKeys.length, nMeses + 1).setNumberFormat('$#,##0');
    sh.getRange(t1Start, 2 + nMeses, agg.topCatsKeys.length, 1).setFontWeight('bold');
    addHeatmap(sh.getRange(t1Start, 2, agg.topCatsKeys.length, nMeses));
  }
  nextRow += 2;

  // ════════ TABLA 2: Destinatario × Mes (top 20) ════════
  sh.getRange(nextRow, 1, 1, 12).merge()
    .setValue('2️⃣ GASTO POR DESTINATARIO × MES (top 20)')
    .setFontSize(13).setFontWeight('bold')
    .setBackground('#0891b2').setFontColor('#FFFFFF')
    .setHorizontalAlignment('center');
  nextRow += 2;
  var t2Headers = ['Destinatario'];
  agg.meses.forEach(function(ym) { t2Headers.push(_bancoMesAbbrev(ym)); });
  t2Headers.push('Total');
  t2Headers.push('%');
  sh.getRange(nextRow, 1, 1, t2Headers.length).setValues([t2Headers])
    .setFontWeight('bold').setBackground('#F1F3F5');
  nextRow++;
  var t2Start = nextRow;
  var top20 = agg.topDestKeys.slice(0, 20);
  top20.forEach(function(d) {
    var row = [d];
    var total = agg.destTotals[d];
    agg.meses.forEach(function(ym) { row.push((agg.destByMes[d] && agg.destByMes[d][ym]) || 0); });
    row.push(total);
    var pct = agg.totalOut > 0 ? Math.round((total / agg.totalOut) * 100) : 0;
    row.push(pct + '%');
    sh.getRange(nextRow, 1, 1, row.length).setValues([row]);
    nextRow++;
  });
  if (top20.length > 0 && nMeses > 0) {
    sh.getRange(t2Start, 2, top20.length, nMeses + 1).setNumberFormat('$#,##0');
    sh.getRange(t2Start, 2 + nMeses, top20.length, 1).setFontWeight('bold');
    addHeatmap(sh.getRange(t2Start, 2, top20.length, nMeses));
  }
  nextRow += 2;

  // ════════ TABLA 3: Día semana × Categoría ════════
  // Computamos el agregado día × cat aquí (no estaba en agg).
  var dias = ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'];
  var diaCatTotals = {};   // dia → { cat → sum }
  var diaTotals = {};       // dia → sum
  var diasJS = [1,2,3,4,5,6,0];  // mapping JS day index (Sun=0) → posición en `dias`
  movs.forEach(function(m) {
    if (m.monto >= 0 || !m.fecha) return;
    var jsDay = m.fecha.getDay();
    var dia = dias[diasJS.indexOf(jsDay)];
    if (!dia) return;
    var s = -m.monto;
    if (!diaCatTotals[dia]) diaCatTotals[dia] = {};
    diaCatTotals[dia][m.cat] = (diaCatTotals[dia][m.cat] || 0) + s;
    diaTotals[dia] = (diaTotals[dia] || 0) + s;
  });
  // Top 6 cats que aparecen en al menos un día (suficiente para hacer el patrón)
  var top6Cats = agg.topCatsKeys.slice(0, 6);

  sh.getRange(nextRow, 1, 1, 12).merge()
    .setValue('3️⃣ PATRÓN SEMANAL: DÍA × CATEGORÍA')
    .setFontSize(13).setFontWeight('bold')
    .setBackground('#7c3aed').setFontColor('#FFFFFF')
    .setHorizontalAlignment('center');
  nextRow += 2;
  var t3Headers = ['Día'].concat(top6Cats.map(function(c) { return _bancoCatPlain(c); }));
  t3Headers.push('Total día');
  sh.getRange(nextRow, 1, 1, t3Headers.length).setValues([t3Headers])
    .setFontWeight('bold').setBackground('#F1F3F5');
  nextRow++;
  var t3Start = nextRow;
  dias.forEach(function(dia) {
    var row = [dia];
    top6Cats.forEach(function(c) {
      row.push((diaCatTotals[dia] && diaCatTotals[dia][c]) || 0);
    });
    row.push(diaTotals[dia] || 0);
    sh.getRange(nextRow, 1, 1, row.length).setValues([row]);
    nextRow++;
  });
  sh.getRange(t3Start, 2, dias.length, top6Cats.length + 1).setNumberFormat('$#,##0');
  sh.getRange(t3Start, 2 + top6Cats.length, dias.length, 1).setFontWeight('bold');
  addHeatmap(sh.getRange(t3Start, 2, dias.length, top6Cats.length));
  nextRow += 2;

  // ════════ INSTRUCCIONES AL PIE ════════
  sh.getRange(nextRow, 1, 1, 12).merge()
    .setValue('💡 ¿CÓMO CONVERTIRLAS EN PIVOTS INTERACTIVAS?')
    .setFontSize(12).setFontWeight('bold')
    .setBackground('#1A1A2E').setFontColor('#FFFFFF')
    .setHorizontalAlignment('center');
  nextRow += 2;

  var instrucciones = [
    'Las 3 tablas de arriba son snapshots de tu data. Para explorarla dinámicamente:',
    '',
    '1. Andá a la hoja *Movimientos* (toda tu data con columnas analíticas)',
    '2. Seleccioná todo: Ctrl+A (Windows/Linux) ó Cmd+A (Mac)',
    '3. Menú: *Insertar → Tabla Dinámica* (Sheets) ó *Insert → PivotTable* (Excel)',
    '4. Arrastrá columnas a los cuadrantes Filas / Columnas / Valores / Filtros',
    '',
    'Configuraciones útiles para arrancar:',
    '• Filas: Categoría · Cols: Mes · Valores: SUM(|Monto|) · Filtro: Tipo=Gasto',
    '• Filas: Destinatario · Cols: Mes · Valores: SUM(|Monto|) · Filtro: Tipo=Gasto',
    '• Filas: Día semana · Cols: Categoría · Valores: SUM(|Monto|) · Filtro: Tipo=Gasto',
    '• Filas: Mes · Cols: Tipo · Valores: SUM(Monto) → ingresos vs gastos por mes',
    '',
    'Tip: cambiá Valores → SUMARIZAR POR → COUNTA para ver *cuántas* transacciones (no $).',
    'Tip: agregá un Slicer para filtrar interactivamente por categoría/mes/destinatario.',
  ];
  instrucciones.forEach(function(line) {
    sh.getRange(nextRow, 1, 1, 12).merge()
      .setValue(line).setFontSize(10).setFontColor('#374151')
      .setHorizontalAlignment('left').setWrap(true);
    sh.setRowHeight(nextRow, 20);
    nextRow++;
  });

  // Anchos
  sh.setColumnWidth(1, 220);
  for (var i = 2; i <= 14; i++) sh.setColumnWidth(i, 90);
  sh.setHiddenGridlines(true);
}

function _bancoPoblarXlsx(ss, cache) {
  // ─── Pre-computar agregados ──────────────────────────────────
  var totalIn = 0, totalOut = 0;
  var catTotals = {};                  // cat → sumOut
  var catMovs = {};                    // cat → [movs (gastos)]
  var mesMovs = {};                    // ym → [movs (todos)]
  cache.movs.forEach(function(m) {
    if (m.monto >= 0) {
      totalIn += m.monto;
    } else {
      totalOut += -m.monto;
      catTotals[m.cat] = (catTotals[m.cat] || 0) + (-m.monto);
      if (!catMovs[m.cat]) catMovs[m.cat] = [];
      catMovs[m.cat].push(m);
    }
    var ym = Utilities.formatDate(m.fecha, 'America/Panama', 'yyyy-MM');
    if (!mesMovs[ym]) mesMovs[ym] = [];
    mesMovs[ym].push(m);
  });

  // Cap a top 10 cats por gasto + todos los meses con data (cap 12)
  var topCats = Object.keys(catTotals)
    .sort(function(a, b) { return catTotals[b] - catTotals[a]; })
    .slice(0, 10);
  var meses = Object.keys(mesMovs).sort().slice(-12);

  // ─── Hoja 1: Diagnóstico (executive summary al frente) ──────
  // Es lo PRIMERO que ve el usuario al abrir el xlsx. La data cruda
  // (Resumen, Movimientos, etc.) queda en las hojas siguientes.
  var shD = ss.getActiveSheet();
  shD.setName('Diagnóstico');
  try {
    _bancoPoblarDiagnostico(shD, cache, {
      totalIn: totalIn, totalOut: totalOut,
      catTotals: catTotals, catMovs: catMovs, mesMovs: mesMovs,
      topCats: topCats, meses: meses,
    });
  } catch(e) { Logger.log('Banco Diagnóstico skip: ' + e.message); }

  // ─── Hoja 2: Resumen ────────────────────────────────────────
  var sh1 = ss.insertSheet('Resumen');
  var rows = [
    ['ANÁLISIS BANCARIO', '', '', ''],
    ['Generado',       new Date(), '', ''],
    ['Movimientos',    cache.movs.length, '', ''],
    ['', '', '', ''],
    ['Total ingresos', totalIn, '', ''],
    ['Total gastos',   totalOut, '', ''],
    ['Neto',           totalIn - totalOut, '', ''],
    ['', '', '', ''],
    ['TOP CATEGORÍAS DE GASTO', 'Monto', '# Movs', 'Drill-down'],
  ];
  // Por cada top cat: link al sheet "Detalle - <cat>"
  topCats.forEach(function(c) {
    var label  = _bancoCatPlain(c);
    var snName = _bancoSheetSafeName('Detalle - ' + label);
    rows.push([
      _bancoCatLabel(c),
      catTotals[c],
      (catMovs[c] || []).length,
      '=HYPERLINK("#' + "'" + snName.replace(/'/g, "''") + "'" + '!A1","→ Ver detalle")',
    ]);
  });
  // Separador y header de meses
  rows.push(['', '', '', '']);
  rows.push(['POR MES', 'Gasto', '# Movs', 'Drill-down']);
  meses.forEach(function(ym) {
    var snName = _bancoSheetSafeName('Mes - ' + _bancoMesLabel(ym) + ' ' + ym.split('-')[0]);
    var out = 0, n = 0;
    mesMovs[ym].forEach(function(m) { n++; if (m.monto < 0) out += -m.monto; });
    rows.push([
      _bancoMesLabel(ym) + ' ' + ym.split('-')[0],
      out, n,
      '=HYPERLINK("#' + "'" + snName.replace(/'/g, "''") + "'" + '!A1","→ Ver detalle")',
    ]);
  });
  // Acceso a la data raw + P2P/Transferencias consolidados.
  var byYappy = _bancoConsolidarYappys(cache.movs);
  var byACH   = _bancoConsolidarACH(cache.movs);
  var hayYappys = Object.keys(byYappy).length > 0;
  var hayACH    = Object.keys(byACH).length > 0;

  if (hayYappys || hayACH) {
    rows.push(['', '', '', '']);
    rows.push(['P2P Y TRANSFERENCIAS', '', '', 'Drill-down']);
    if (hayYappys) {
      var nContactos = Object.keys(byYappy).length;
      rows.push(['Yappys por contacto', '', nContactos + ' contactos',
        '=HYPERLINK("#\'Yappys por contacto\'!A1","→ Ver detalle")']);
    }
    if (hayACH) {
      var nDest = Object.keys(byACH).length;
      rows.push(['Transferencias bancarias', '', nDest + ' destinos',
        '=HYPERLINK("#\'Transferencias\'!A1","→ Ver detalle")']);
    }
  }

  rows.push(['', '', '', '']);
  rows.push(['', '', '', '=HYPERLINK("#\'Movimientos\'!A1","→ Ver todos los movimientos")']);

  sh1.getRange(1, 1, rows.length, 4).setValues(rows);
  sh1.getRange(1, 1, 1, 4).setFontWeight('bold').setBackground('#1A1A2E').setFontColor('#FFFFFF');
  sh1.getRange(9, 1, 1, 4).setFontWeight('bold').setBackground('#F1F3F5');
  // Row del header "POR MES"
  var mesHeaderRow = 9 + topCats.length + 2;
  sh1.getRange(mesHeaderRow, 1, 1, 4).setFontWeight('bold').setBackground('#F1F3F5');
  sh1.setColumnWidth(1, 240);
  sh1.setColumnWidth(2, 110);
  sh1.setColumnWidth(3, 80);
  sh1.setColumnWidth(4, 180);

  // ─── Hoja por cada top cat ──────────────────────────────────
  topCats.forEach(function(c) {
    var label = _bancoCatPlain(c);
    var sh    = ss.insertSheet(_bancoSheetSafeName('Detalle - ' + label));
    _bancoPoblarDetalleSheet(sh, _bancoCatLabel(c), catMovs[c] || [], 'cat');
  });

  // ─── Hoja por cada mes con data ─────────────────────────────
  meses.forEach(function(ym) {
    var sh = ss.insertSheet(_bancoSheetSafeName('Mes - ' + _bancoMesLabel(ym) + ' ' + ym.split('-')[0]));
    _bancoPoblarDetalleSheet(sh, _bancoMesLabel(ym) + ' ' + ym.split('-')[0], mesMovs[ym], 'mes');
  });

  // ─── Hoja Movimientos (full con filter habilitado) ──────────
  var sh2 = ss.insertSheet('Movimientos');
  var movRows = [['Fecha','Monto','Tipo','Descripción','Categoría']];
  cache.movs.slice().sort(function(a, b) { return b.fecha - a.fecha; }).forEach(function(m) {
    movRows.push([m.fecha, m.monto, m.monto >= 0 ? 'Ingreso' : 'Gasto', m.descripcion, _bancoCatLabel(m.cat)]);
  });
  sh2.getRange(1, 1, movRows.length, 5).setValues(movRows);
  sh2.getRange(1, 1, 1, 5).setFontWeight('bold').setBackground('#F1F3F5');
  sh2.setFrozenRows(1);
  sh2.setColumnWidth(1, 100);
  sh2.setColumnWidth(2, 90);
  sh2.setColumnWidth(3, 80);
  sh2.setColumnWidth(4, 380);
  sh2.setColumnWidth(5, 180);
  // AutoFilter — habilita los dropdowns nativos de Excel en cada columna,
  // sobrevive al export xlsx. El usuario puede filtrar manualmente cualquier
  // columna sin necesidad de un sheet de detalle dedicado.
  try {
    var existingFilter = sh2.getFilter();
    if (existingFilter) existingFilter.remove();
    sh2.getRange(1, 1, movRows.length, 5).createFilter();
  } catch(e) { Logger.log('Banco filter create skip: ' + e.message); }

  // ─── Hoja Yappys por contacto (si hay Yappys detectados) ────
  if (hayYappys) {
    var shY = ss.insertSheet('Yappys por contacto');
    _bancoPoblarYappysSheet(shY, byYappy);
  }

  // ─── Hoja Transferencias (si hay ACH/transferencias) ────────
  if (hayACH) {
    var shT = ss.insertSheet('Transferencias');
    _bancoPoblarACHSheet(shT, byACH);
  }

  // ─── Hoja Mensual (si hay historial multi-mes) ──────────────
  if (cache.historial && cache.historial.length) {
    var sh3 = ss.insertSheet('Mensual');
    var mRows = [['Mes','Ingresos','Gastos','Neto','# Movs','Parcial']];
    cache.historial.forEach(function(h) {
      mRows.push([h.yearMonth, h.totalIn, h.totalOut, h.totalIn - h.totalOut, h.nMovs, h.parcial ? 'Sí' : 'No']);
    });
    sh3.getRange(1, 1, mRows.length, 6).setValues(mRows);
    sh3.getRange(1, 1, 1, 6).setFontWeight('bold').setBackground('#F1F3F5');
    sh3.setFrozenRows(1);
  }

  // Diagnóstico es lo primero que el usuario ve al abrir el xlsx
  ss.setActiveSheet(shD);
  SpreadsheetApp.flush();
}

// Pobla una hoja de detalle (cat o mes) con back-link al Resumen,
// título, total, una matriz "destinatario × mes" con heatmap para
// ver patrones temporales por destinatario, y abajo el listado crudo
// de movimientos.
function _bancoPoblarDetalleSheet(sh, title, movs, kind) {
  var total = movs.reduce(function(s, m) { return s + Math.abs(m.monto < 0 ? m.monto : 0); }, 0);
  var nMovs = movs.length;

  // Meses presentes en los gastos (cap a últimos 12)
  var mesesSet = {};
  movs.forEach(function(m) {
    if (!m || m.monto >= 0 || !m.fecha) return;
    var ym = Utilities.formatDate(m.fecha, 'America/Panama', 'yyyy-MM');
    mesesSet[ym] = true;
  });
  var meses = Object.keys(mesesSet).sort().slice(-12);
  var nMeses = meses.length;

  // Agrupar por destinatario × mes
  var grupos = _bancoAgruparPorDestinatarioMes(movs, meses);
  var TOP_N = 20;

  // ─── HEADER + METADATA (5 cols) ────────────────────────────────
  var headerRows = [
    ['=HYPERLINK("#\'Resumen\'!A1","← Volver al Resumen")', '', '', '', ''],
    ['', '', '', '', ''],
    [title, '', 'Total:', total, ''],
    ['', '', '# Movs:', nMovs, ''],
    ['', '', '', '', ''],
  ];
  sh.getRange(1, 1, headerRows.length, 5).setValues(headerRows);
  sh.getRange(3, 1).setFontWeight('bold').setFontSize(13);
  var nextRow = headerRows.length + 1;

  // ─── MATRIZ: Destinatario × Mes (con heatmap + barras) ─────────
  // Width: dest + nMeses + total + % + bar
  var matrixWidth = 1 + Math.max(nMeses, 1) + 3;
  var matrixDataStart = 0, matrixDataRows = 0;
  var monthColStart = 2;  // col B
  var totalCol = monthColStart + nMeses;
  var pctCol   = totalCol + 1;
  var barCol   = totalCol + 2;

  if (grupos.length >= 1 && nMeses >= 1) {
    // Section title — setValue antes del merge para evitar mismatch de
    // dimensiones (después de merge el setValues espera dim del rango
    // original, no la celda fusionada).
    sh.getRange(nextRow, 1).setValue('¿DÓNDE SE VA LA PLATA? (POR DESTINATARIO × MES)');
    sh.getRange(nextRow, 1, 1, matrixWidth).merge()
      .setFontSize(12).setFontWeight('bold').setBackground('#1A1A2E').setFontColor('#FFFFFF')
      .setHorizontalAlignment('center');
    nextRow++;

    // Column headers
    var colHeader = ['Destinatario / Merchant'];
    meses.forEach(function(ym) { colHeader.push(_bancoMesAbbrev(ym)); });
    colHeader.push('Total');
    colHeader.push('%');
    colHeader.push('');
    sh.getRange(nextRow, 1, 1, matrixWidth).setValues([colHeader])
      .setFontWeight('bold').setBackground('#F1F3F5').setHorizontalAlignment('center');
    sh.getRange(nextRow, 1).setHorizontalAlignment('left');
    nextRow++;

    // Data rows
    matrixDataStart = nextRow;
    var topN = grupos.slice(0, TOP_N);
    var dataRows = topN.map(function(g) {
      var row = [g.name];
      meses.forEach(function(ym) { row.push(g.perMonth[ym] || 0); });
      row.push(g.total);
      var pct = total > 0 ? Math.round((g.total / total) * 100) : 0;
      row.push(pct + '%');
      row.push(_bancoBarUnicode(g.total, grupos[0].total, 12));
      return row;
    });
    if (grupos.length > TOP_N) {
      var resto = grupos.slice(TOP_N);
      var sumResto = resto.reduce(function(s, g) { return s + g.total; }, 0);
      var restoRow = ['Otros (' + resto.length + ' más)'];
      meses.forEach(function(ym) {
        var s = 0;
        resto.forEach(function(g) { s += (g.perMonth[ym] || 0); });
        restoRow.push(s);
      });
      restoRow.push(sumResto);
      var pctR = total > 0 ? Math.round((sumResto / total) * 100) : 0;
      restoRow.push(pctR + '%');
      restoRow.push('');
      dataRows.push(restoRow);
    }
    matrixDataRows = dataRows.length;
    sh.getRange(matrixDataStart, 1, matrixDataRows, matrixWidth).setValues(dataRows);

    // Estilos
    sh.getRange(matrixDataStart, 1, matrixDataRows, 1).setFontWeight('bold');
    sh.getRange(matrixDataStart, monthColStart, matrixDataRows, nMeses + 1).setNumberFormat('$#,##0');
    sh.getRange(matrixDataStart, pctCol, matrixDataRows, 1).setHorizontalAlignment('right');
    sh.getRange(matrixDataStart, totalCol, matrixDataRows, 1).setFontWeight('bold');

    // Heatmap (color scale) en las celdas de meses
    if (nMeses > 0) {
      try {
        var hmRange = sh.getRange(matrixDataStart, monthColStart, matrixDataRows, nMeses);
        var rule = SpreadsheetApp.newConditionalFormatRule()
          .setGradientMinpointWithValue('#E8F5E9', SpreadsheetApp.InterpolationType.NUMBER, '0')
          .setGradientMaxpoint('#EF5350')
          .setRanges([hmRange])
          .build();
        var existing = sh.getConditionalFormatRules();
        existing.push(rule);
        sh.setConditionalFormatRules(existing);
      } catch(e) { Logger.log('Heatmap skip: ' + e.message); }
    }

    nextRow = matrixDataStart + matrixDataRows + 1;  // +1 separator
  }

  // ─── MOVIMIENTOS CRUDOS (5 cols) ───────────────────────────────
  var movHeaderRow = nextRow;
  var movsHeader = ['Fecha', 'Monto', 'Tipo', 'Descripción', 'Categoría'];
  var sortedMovs = movs.slice().sort(function(a, b) { return b.fecha - a.fecha; });
  var movsData = [movsHeader].concat(sortedMovs.map(function(m) {
    return [m.fecha, m.monto, m.monto >= 0 ? 'Ingreso' : 'Gasto', m.descripcion, _bancoCatLabel(m.cat)];
  }));
  sh.getRange(movHeaderRow, 1, movsData.length, 5).setValues(movsData);
  sh.getRange(movHeaderRow, 1, 1, 5).setFontWeight('bold').setBackground('#F1F3F5');

  // Freeze al header de movimientos
  sh.setFrozenRows(movHeaderRow);

  // Column widths — optimizados para la matriz cuando existe; los anchos
  // de la sección movs se ajustan a esos mismos cols (descripción wrappea).
  sh.setColumnWidth(1, 240);
  if (nMeses >= 1) {
    for (var i = 0; i < nMeses; i++) sh.setColumnWidth(monthColStart + i, 80);
    sh.setColumnWidth(totalCol, 100);
    sh.setColumnWidth(pctCol, 65);
    sh.setColumnWidth(barCol, 130);
  } else {
    sh.setColumnWidth(2, 90);
    sh.setColumnWidth(3, 100);
    sh.setColumnWidth(4, 360);
    sh.setColumnWidth(5, 180);
  }

  // Descripción: overflow (no wrap) para que las filas mantengan altura
  // normal. Si el texto excede el ancho de col, se clipa visualmente —
  // el usuario puede ensanchar la col o hacer click en la celda para ver
  // el contenido completo. Es preferible a wrap, que hace filas enormes.
  if (sortedMovs.length > 0) {
    sh.getRange(movHeaderRow + 1, 4, sortedMovs.length, 1)
      .setWrapStrategy(SpreadsheetApp.WrapStrategy.OVERFLOW);
  }

  // AutoFilter en el rango de movs crudos
  try {
    var existingFilter = sh.getFilter();
    if (existingFilter) existingFilter.remove();
    if (sortedMovs.length > 0) {
      sh.getRange(movHeaderRow, 1, sortedMovs.length + 1, 5).createFilter();
    }
  } catch(e) { Logger.log('Banco detalle filter skip: ' + e.message); }
}

// Abreviatura compacta de un yyyy-MM: "2026-06" → "Jun '26".
function _bancoMesAbbrev(ym) {
  var meses = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  var parts = String(ym || '').split('-');
  if (parts.length !== 2) return ym || '???';
  var m = parseInt(parts[1], 10);
  var y = parts[0].substring(2);
  return (meses[m-1] || '???') + " '" + y;
}

// Barra Unicode proporcional al valor sobre un máximo. Ancho max chars.
function _bancoBarUnicode(value, max, width) {
  if (!max || max <= 0 || !isFinite(value) || value <= 0) return '';
  var ratio = Math.min(1, value / max);
  var filled = Math.round(ratio * width);
  var s = '';
  for (var i = 0; i < filled; i++) s += '█';
  return s;
}

// Agrupa movs (gastos) por destinatario y desglosa por mes. Devuelve
// [{ name, count, total, perMonth: { ym: total } }] ordenado por total desc.
function _bancoAgruparPorDestinatarioMes(movs, meses) {
  var by = {};
  movs.forEach(function(m) {
    if (!m || m.monto >= 0 || !m.fecha) return;
    var key = _bancoExtractDestinatario(m);
    var ym  = Utilities.formatDate(m.fecha, 'America/Panama', 'yyyy-MM');
    if (!by[key]) by[key] = { name: key, count: 0, total: 0, perMonth: {} };
    by[key].count++;
    by[key].total += -m.monto;
    by[key].perMonth[ym] = (by[key].perMonth[ym] || 0) + (-m.monto);
  });
  return Object.keys(by).map(function(k) { return by[k]; })
    .sort(function(a, b) { return b.total - a.total; });
}

// Extrae un nombre de destinatario/merchant a partir de la descripción
// de un mov. Soporta los formatos más comunes de Banco General:
// Yappy, ACH/Banca Móvil, Pago TC; el resto cae a "merchant genérico"
// (descripción truncada limpiando códigos largos y fechas).
function _bancoExtractDestinatario(m) {
  var d = String((m && m.descripcion) || '');
  // Yappy salida
  var ym = /^YAPPY\s+BG\s+A\s+(.+?)(?:\s+POR\b|\s*$)/i.exec(d);
  if (ym) return _bancoTomarNombreLimpio(ym[1], 4);
  // Yappy entrada
  var yme = /^YAPPY\s+BG\s+DE\s+(.+?)(?:\s+POR\b|\s*$)/i.exec(d);
  if (yme) return _bancoTomarNombreLimpio(yme[1], 4);
  // ACH / Banca Móvil transferencia salida → nombre del destinatario
  var ach = /(?:BANCA\s+MOVIL\s+TRANSFERENCIA|PAGO\s+ACH|TRANSFER\w*)\s+A\s+\d+\s+(.+?)(?:\s+(?:ahorros|corriente|cta)\b|\s+ENTRE\s+CUENTAS|\s+PROPIAS?|\s*$)/i.exec(d);
  if (ach) {
    var nm = _bancoTomarNombreLimpio(ach[1], 5);
    return nm || 'Transferencia sin nombre';
  }
  // Pago Tarjeta Crédito
  if (/^PAGO\s+TC\b/i.test(d)) {
    var tcm = /PAGO\s+TC\s+(\S+(?:\s+\S+)?)/i.exec(d);
    if (tcm) return 'Pago TC ' + tcm[1];
    return 'Pago Tarjeta Crédito';
  }
  // Merchant genérico: descartar fechas, IDs largos, referencias
  var mk = d.split(/-\d{4}-?\d|\s+\d{6,}|\s+ID:|\s+#\d|\s+\d{1,2}\/\d{1,2}/)[0].trim().substring(0, 50);
  return mk || d.substring(0, 50) || 'Sin descripción';
}

// Toma palabras del nombre extraído hasta encontrar:
//  - Una palabra que arranca con letra minúscula (concepto/razón que el
//    usuario agregó después del nombre — "mayo", "manutencion", "ahorro")
//  - Un número (año, código)
//  - Un sufijo conocido del banco (POR, PARA, etc.)
//  - El límite máximo `maxWords`
// Banco General entrega los nombres SIEMPRE en MAYÚSCULAS, así que el
// primer token lowercase marca el inicio del texto agregado por el cliente.
function _bancoTomarNombreLimpio(raw, maxWords) {
  var STOP = /^(POR|PARA|REF|REFERENCIA|CONCEPTO)$/i;
  var tokens = String(raw || '').split(/\s+/);
  var keep = [];
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i];
    if (!t) continue;
    if (STOP.test(t)) break;
    if (/^\d/.test(t)) break;                     // año / código
    if (/^[a-záéíóúñ]/.test(t)) break;            // concepto en minúscula
    keep.push(t);
    if (keep.length >= (maxWords || 5)) break;
  }
  return keep.join(' ');
}

// Agrupa movs (gastos) por destinatario/merchant. Devuelve un array
// [{ name, count, total }] ordenado por total descendente.
function _bancoAgruparPorDestinatario(movs) {
  var by = {};
  movs.forEach(function(m) {
    if (!m || m.monto >= 0) return;  // solo gastos
    var key = _bancoExtractDestinatario(m);
    if (!by[key]) by[key] = { name: key, count: 0, total: 0 };
    by[key].count++;
    by[key].total += -m.monto;
  });
  return Object.keys(by).map(function(k) { return by[k]; })
    .sort(function(a, b) { return b.total - a.total; });
}

// Devuelve solo el texto de la categoría (sin emoji). "🍽 Comida" → "Comida"
function _bancoCatPlain(c) {
  var l = _bancoCatLabel(c);
  var m = /^\S+\s+(.+)$/.exec(l);
  return m ? m[1] : l;
}

// Sanitiza un nombre para usar como sheet name xlsx.
// - Max 31 chars
// - Sin chars prohibidos por Excel: : \ / ? * [ ]
function _bancoSheetSafeName(name) {
  var s = String(name || '').replace(/[:\/\\?*\[\]]/g, '');
  if (s.length > 31) s = s.substring(0, 28) + '...';
  return s;
}

// ════════════════════════════════════════════════════════════════════
//  CONSOLIDACIONES P2P + ACH para los nuevos drill-downs del xlsx
// ════════════════════════════════════════════════════════════════════

// Agrupa Yappys por contacto en ambas direcciones. Soporta el formato
// "YAPPY BG A/DE <NOMBRE> [POR <razón>]". Tomamos las primeras 4
// palabras del nombre para más fidelidad que en el bot.
function _bancoConsolidarYappys(movs) {
  var by = {};
  movs.forEach(function(m) {
    var match = /YAPPY\s+BG\s+(A|DE)\s+(.+?)(?:\s+POR\b|\s*$)/i.exec(m.descripcion || '');
    if (!match) return;
    var dir  = match[1].toUpperCase();
    var name = match[2].split(/\s+/).slice(0, 4).join(' ').trim();
    if (!name) return;
    if (!by[name]) by[name] = { sent: 0, sentCount: 0, received: 0, receivedCount: 0 };
    if (dir === 'A') {
      by[name].sent += Math.abs(m.monto);
      by[name].sentCount++;
    } else {
      by[name].received += Math.abs(m.monto);
      by[name].receivedCount++;
    }
  });
  return by;
}

// Agrupa transferencias bancarias (BANCA MOVIL TRANSFERENCIA / PAGO ACH)
// por destino. Tomamos el nombre que sigue al número de cuenta.
function _bancoConsolidarACH(movs) {
  var by = {};
  movs.forEach(function(m) {
    if (m.monto >= 0) return;
    var d = String(m.descripcion || '');
    // BANCA MOVIL TRANSFERENCIA A <acctNum> <NAME ...> [<tipo cuenta>]
    // El verbo + " A " + número de cuenta + nombre. Consumimos el "A "
    // y el número para que el destino captado sea solo el nombre.
    var match = /(?:BANCA\s+MOVIL\s+TRANSFERENCIA|PAGO\s+ACH|TRANSFER\w*)\s+A\s+\d+\s+(.+?)(?:\s+(?:ahorros|corriente|cta)\b|\s*$)/i.exec(d);
    if (!match) return;
    // Cortar el nombre cuando aparece un concept word ("ENTRE CUENTAS",
    // "PAGO POR", etc.) o cuando arranca una palabra lowercase (los
    // bancos meten el motivo en mayúsculas o minúsculas; si vienen
    // como concepto del usuario suelen ir lowercase).
    var STOP = /^(ENTRE|CUENTAS?|PROPIAS?|POR|PAGO|RETORNO|RESERVA)$/i;
    var parts = match[1].split(/\s+/);
    var keep = [];
    for (var i = 0; i < parts.length && keep.length < 5; i++) {
      var p = parts[i];
      if (!p) continue;
      if (STOP.test(p) && keep.length > 0) break;
      if (/^[a-záéíóúñ]/.test(p) && keep.length > 0) break;
      keep.push(p);
    }
    var dest = keep.join(' ').substring(0, 50);
    if (!dest) return;
    if (!by[dest]) by[dest] = { sum: 0, count: 0 };
    by[dest].sum += -m.monto;
    by[dest].count++;
  });
  return by;
}

function _bancoPoblarYappysSheet(sh, byYappy) {
  // Sort por flujo absoluto (más grande primero)
  var keys = Object.keys(byYappy).sort(function(a, b) {
    var fa = Math.abs(byYappy[a].sent - byYappy[a].received);
    var fb = Math.abs(byYappy[b].sent - byYappy[b].received);
    return fb - fa;
  });
  var rows = [
    ['=HYPERLINK("#\'Resumen\'!A1","← Volver al Resumen")', '', '', '', '', ''],
    ['', '', '', '', '', ''],
    ['Yappys por contacto', '', '', '', '', ''],
    [keys.length + ' contactos', '', '', '', '', ''],
    ['', '', '', '', '', ''],
    ['Contacto', '# Enviados', 'Total enviado', '# Recibidos', 'Total recibido', 'Flujo neto'],
  ];
  var totSent = 0, totRecv = 0;
  keys.forEach(function(k) {
    var y = byYappy[k];
    var flujo = y.received - y.sent;  // positivo si recibí más que mandé
    rows.push([k, y.sentCount, y.sent, y.receivedCount, y.received, flujo]);
    totSent += y.sent; totRecv += y.received;
  });
  rows.push(['TOTAL', '', totSent, '', totRecv, totRecv - totSent]);
  sh.getRange(1, 1, rows.length, 6).setValues(rows);
  sh.getRange(3, 1).setFontWeight('bold').setFontSize(13);
  sh.getRange(6, 1, 1, 6).setFontWeight('bold').setBackground('#F1F3F5');
  sh.getRange(rows.length, 1, 1, 6).setFontWeight('bold').setBackground('#FFF3E0');
  sh.setFrozenRows(6);
  sh.setColumnWidth(1, 280);
  sh.setColumnWidth(2, 100);
  sh.setColumnWidth(3, 120);
  sh.setColumnWidth(4, 100);
  sh.setColumnWidth(5, 120);
  sh.setColumnWidth(6, 110);
  try {
    if (rows.length > 7) sh.getRange(6, 1, rows.length - 6, 6).createFilter();
  } catch(e) {}
}

function _bancoPoblarACHSheet(sh, byACH) {
  var keys = Object.keys(byACH).sort(function(a, b) { return byACH[b].sum - byACH[a].sum; });
  var rows = [
    ['=HYPERLINK("#\'Resumen\'!A1","← Volver al Resumen")', '', ''],
    ['', '', ''],
    ['Transferencias bancarias por destino', '', ''],
    [keys.length + ' destinos', '', ''],
    ['', '', ''],
    ['Destino', '# Transferencias', 'Total enviado'],
  ];
  var tot = 0;
  keys.forEach(function(k) {
    var x = byACH[k];
    rows.push([k, x.count, x.sum]);
    tot += x.sum;
  });
  rows.push(['TOTAL', '', tot]);
  sh.getRange(1, 1, rows.length, 3).setValues(rows);
  sh.getRange(3, 1).setFontWeight('bold').setFontSize(13);
  sh.getRange(6, 1, 1, 3).setFontWeight('bold').setBackground('#F1F3F5');
  sh.getRange(rows.length, 1, 1, 3).setFontWeight('bold').setBackground('#FFF3E0');
  sh.setFrozenRows(6);
  sh.setColumnWidth(1, 360);
  sh.setColumnWidth(2, 140);
  sh.setColumnWidth(3, 140);
  try {
    if (rows.length > 7) sh.getRange(6, 1, rows.length - 6, 3).createFilter();
  } catch(e) {}
}

// Exporta el spreadsheet identificado por sheetId a bytes xlsx vía
// Drive REST API. Requiere el scope drive (ya autorizado por el resto
// del backend).
function _bancoSheetToXlsxBlob(sheetId) {
  var url = 'https://docs.google.com/spreadsheets/d/' + sheetId +
            '/export?format=xlsx';
  var res = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'Authorization': 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Drive export HTTP ' + res.getResponseCode() + ': ' + res.getContentText().substring(0, 200));
  }
  return res.getBlob();
}

// Sube un blob a la Cloud API de Meta como media. Devuelve el media_id.
function _bancoUploadMediaWA(blob, filename, token, phoneId) {
  var url = 'https://graph.facebook.com/v19.0/' + phoneId + '/media';
  var payload = {
    messaging_product: 'whatsapp',
    file:              blob,
    type:              blob.getContentType() || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  var res = UrlFetchApp.fetch(url, {
    method:             'post',
    headers:            { 'Authorization': 'Bearer ' + token },
    payload:            payload,
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Meta media upload HTTP ' + res.getResponseCode() + ': ' + res.getContentText().substring(0, 300));
  }
  var data = JSON.parse(res.getContentText());
  if (!data.id) throw new Error('Meta media upload sin id: ' + res.getContentText().substring(0, 200));
  return data.id;
}

// Envía un documento ya uploaded vía media_id.
function _bancoSendDocumentWA(to, mediaId, filename, caption, token, phoneId) {
  var url = 'https://graph.facebook.com/v19.0/' + phoneId + '/messages';
  var payload = {
    messaging_product: 'whatsapp',
    to:    to,
    type:  'document',
    document: {
      id:       mediaId,
      filename: filename,
      caption:  caption || '',
    },
  };
  UrlFetchApp.fetch(url, {
    method:             'post',
    contentType:        'application/json',
    headers:            { 'Authorization': 'Bearer ' + token },
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true,
  });
}

// ════════════════════════════════════════════════════════════════════
//  MODO ASESOR — Claude Sonnet 4.6 contestando preguntas sobre las
//  finanzas del usuario con el contexto del último análisis cacheado.
//  ──────────────────────────────────────────────────────────────────
//  Detección: texto que no matchea un comando conocido (drill/excel)
//  y huele a pregunta. Usa el cache de 1h del último análisis para
//  inyectar contexto slim (aggregates, no movs individuales) al prompt.
//
//  Modelo: Sonnet 4.6. Razonamiento financiero importa, y el costo
//  marginal sobre Haiku (~1 centavo por pregunta) es despreciable
//  contra la calidad del consejo accionable.
// ════════════════════════════════════════════════════════════════════

function _bancoEsPreguntaAsesor(text) {
  var t = _bancoNorm(text);
  if (!t || t.length < 4) return false;

  // 1) Signo de pregunta EN CUALQUIER LUGAR (no solo al final).
  //    "Puedes ayudarme con X? Quizás Y" → asesor.
  if (/\?/.test(t)) return true;

  // 2) Empieza con palabra interrogativa o de petición/sugerencia.
  if (/^(que|cuanto|cuanta|cuantas|cuantos|como|cuando|donde|por que|porque|deberia|debo|puedo|puedes|podrias|podria|conviene|es|son|hay|tengo|tenia|tendria|cual|cuales|en que|si yo|si dejo|si bajo|me)\b/.test(t)) return true;

  // 3) Verbos de petición/consejo/análisis en CUALQUIER parte del texto.
  //    Captura cosas tipo "necesito que me ayudes", "queria ver si me podes
  //    explicar", "quiero recomendaciones", etc.
  if (/\b(ayudame|ayudarme|ayuda|aconsejame|asesorame|recomienda|recomendaci|sugiere|sugerencia|consejo|analiza|analizame|dime|cuentame|explica|explicame|compara|comparame|comparar|optimiza|optimizame|necesito|quiero|quisiera|queria|me podes|me puedes|me podrias)\b/.test(t)) return true;

  // 4) Mensajes largos (5+ palabras) que tocan conceptos financieros.
  //    Filtra falsos positivos en comandos cortos como "comida" o "mayo".
  var words = t.split(/\s+/).filter(Boolean).length;
  if (words >= 5 && /\b(ahorrar|ahorro|gasto|gastos|gastando|gastar|presupuesto|ingreso|ingresos|deuda|deudas|inversion|invertir|optimizar|reducir|bajar|aumentar|finanzas|plata|dinero|oportunidad|oportunidades)\b/.test(t)) return true;

  return false;
}

function _bancoHandleAsesor(question, from, token, phoneId) {
  var cache = _bancoLoadCache(from);
  if (!cache) {
    // Hay pregunta pero no hay cache → respondemos explícito para
    // mantener los dos flujos separados (asesor vs facturas). Antes
    // dejábamos caer al welcome de facturas y confundía: el usuario
    // preguntó sobre finanzas y recibía instrucciones de facturas.
    _whatsappReply(from,
      '💬 Para analizarte la plata necesito tu estado de cuenta primero.\n\n' +
      '📊 *Para análisis financiero*: mandame el archivo *.xlsx* que descargás de tu banco ' +
      '(en Banco General: "Últimos movimientos" → Excel).\n\n' +
      '🧾 *Para procesar una factura*: mandame la foto o PDF del recibo.\n\n' +
      'Una vez tenga tu estado de cuenta, podrás preguntarme cualquier cosa por hasta una hora.',
      token, phoneId);
    return true;  // attended — NO caer al welcome de facturas
  }
  _whatsappReply(from, '🤔 Pensando en tu situación financiera…', token, phoneId);
  try {
    var context = _bancoBuildAsesorContext(cache);
    var respuesta = _bancoConsultarAsesor(question, context);
    _whatsappReply(from, _bancoRenderRespuestaAsesor(respuesta), token, phoneId);
  } catch(err) {
    Logger.log('Banco asesor error: ' + err.message);
    _whatsappReply(from, '⚠️ No pude procesar tu pregunta ahora: ' + err.message, token, phoneId);
  }
  return true;
}

// Arma un resumen slim del análisis para inyectar al prompt — solo
// aggregates, nunca movs individuales. Mantiene el prompt acotado
// (~1.5K tokens) y preserva la privacy del usuario.
function _bancoBuildAsesorContext(cache) {
  var movs = cache.movs || [];
  if (!movs.length) return '(sin datos)';
  var totalIn = 0, totalOut = 0;
  var catTotals = {};
  var byMerchant = {};
  var byCatDest = {};        // cat → { destinatario limpio → sum }
  var byMonthDest = {};      // ym → { destinatario limpio → sum }
  var byMonth = {};
  var byMonthCat = {};
  var yappyOut = {}, yappyIn = {};
  var byMerchantSubs = {};   // suscripciones

  movs.forEach(function(m) {
    var ym = Utilities.formatDate(new Date(m.fecha), 'America/Panama', 'yyyy-MM');
    if (!byMonth[ym]) byMonth[ym] = { in: 0, out: 0 };
    if (m.monto >= 0) {
      totalIn += m.monto;
      byMonth[ym].in += m.monto;
    } else {
      totalOut += -m.monto;
      byMonth[ym].out += -m.monto;
      catTotals[m.cat] = (catTotals[m.cat] || 0) + (-m.monto);
      var mk = m.descripcion.split(/-\d{4}-?\d|\s+\d{6,}/)[0].trim().substring(0, 30);
      byMerchant[mk] = (byMerchant[mk] || 0) + (-m.monto);
      if (!byMonthCat[ym]) byMonthCat[ym] = {};
      byMonthCat[ym][m.cat] = (byMonthCat[ym][m.cat] || 0) + (-m.monto);
      // Destinatario limpio (reusa el extractor con dedup)
      var dest = _bancoExtractDestinatario(m);
      if (!byCatDest[m.cat]) byCatDest[m.cat] = {};
      byCatDest[m.cat][dest] = (byCatDest[m.cat][dest] || 0) + (-m.monto);
      if (!byMonthDest[ym]) byMonthDest[ym] = {};
      byMonthDest[ym][dest] = (byMonthDest[ym][dest] || 0) + (-m.monto);
      // Suscripciones: agrupar por merchant key
      if (!byMerchantSubs[mk]) byMerchantSubs[mk] = { count: 0, sum: 0, montos: [], fechas: [] };
      byMerchantSubs[mk].count++;
      byMerchantSubs[mk].sum += -m.monto;
      byMerchantSubs[mk].montos.push(m.monto);
      byMerchantSubs[mk].fechas.push(new Date(m.fecha));
    }
    var ym2 = /YAPPY\s+BG\s+(A|DE)\s+(.+?)(?:\s+POR\b|\s*$)/i.exec(m.descripcion);
    if (ym2) {
      var name = ym2[2].split(/\s+/).slice(0, 3).join(' ');
      if (ym2[1].toUpperCase() === 'A') yappyOut[name] = (yappyOut[name] || 0) + Math.abs(m.monto);
      else                              yappyIn[name]  = (yappyIn[name]  || 0) + Math.abs(m.monto);
    }
  });

  var topCats = Object.keys(catTotals)
    .map(function(c) { return { cat: c, sum: catTotals[c] }; })
    .sort(function(a, b) { return b.sum - a.sum; }).slice(0, 8);
  var topM = Object.keys(byMerchant)
    .map(function(k) { return { name: k, sum: byMerchant[k] }; })
    .sort(function(a, b) { return b.sum - a.sum; }).slice(0, 5);
  var topYO = Object.keys(yappyOut)
    .map(function(k) { return { name: k, sum: yappyOut[k] }; })
    .sort(function(a, b) { return b.sum - a.sum; }).slice(0, 5);
  var topYI = Object.keys(yappyIn)
    .map(function(k) { return { name: k, sum: yappyIn[k] }; })
    .sort(function(a, b) { return b.sum - a.sum; }).slice(0, 5);

  var meses = Object.keys(byMonth).sort();
  var pequenos = movs.filter(function(m) { return m.monto < 0 && m.monto > -10; });
  var sumaPeq = pequenos.reduce(function(s, m) { return s + Math.abs(m.monto); }, 0);

  // Saldo inicial / final
  var first = movs[0], last = movs[movs.length - 1];
  var saldoIni = null, saldoFin = null;
  if (first && last && first.saldo != null && last.saldo != null) {
    var firstF = first.fecha && new Date(first.fecha), lastF = last.fecha && new Date(last.fecha);
    var bgStyle = !firstF || !lastF || firstF >= lastF;
    var newest = bgStyle ? first : last;
    var oldest = bgStyle ? last  : first;
    if (newest.saldo != null && oldest.saldo != null) {
      saldoFin = newest.saldo;
      saldoIni = oldest.saldo - oldest.monto;
    }
  }

  // Suscripciones (3+ cargos mensuales con monto estable)
  var suscripciones = [];
  Object.keys(byMerchantSubs).forEach(function(mk) {
    var info = byMerchantSubs[mk];
    if (info.count < 3) return;
    var avg = info.sum / info.count;
    if (avg < 3) return;
    var allClose = info.montos.every(function(x) { return Math.abs(Math.abs(x) - avg) / avg < 0.15; });
    if (!allClose) return;
    var fOrd = info.fechas.slice().filter(Boolean).sort(function(a, b) { return a - b; });
    if (fOrd.length < 3) return;
    var intervalos = [];
    for (var i = 1; i < fOrd.length; i++) intervalos.push((fOrd[i] - fOrd[i-1]) / 86400000);
    intervalos.sort(function(a, b) { return a - b; });
    var mediana = intervalos[Math.floor(intervalos.length / 2)];
    if (mediana < 22 || mediana > 38) return;
    suscripciones.push({ merchant: mk, count: info.count, avg: avg });
  });
  suscripciones.sort(function(a, b) { return b.avg - a.avg; });

  // Form 90 deducibles
  var form90Map = {
    salud:     'Gastos médicos (DP-1)',
    educacion: 'Gastos escolares (DP-2)',
    seguro:    'Seguros de salud (DP-1)',
    prestamo:  'Intereses préstamos (DP-3/DP-4)',
  };
  var form90 = [];
  Object.keys(form90Map).forEach(function(c) {
    if (catTotals[c]) form90.push({ label: form90Map[c], sum: catTotals[c] });
  });

  var ctx = '';
  ctx += 'RANGO: ' + meses[0] + ' a ' + meses[meses.length - 1] + ' (' + meses.length + ' meses, ' + movs.length + ' movs)\n';
  if (saldoIni != null && saldoFin != null) {
    ctx += 'SALDO INICIAL: $' + saldoIni.toFixed(2) + '\n';
    ctx += 'SALDO FINAL:   $' + saldoFin.toFixed(2) + ' (delta $' + (saldoFin - saldoIni).toFixed(2) + ')\n';
  }
  ctx += 'INGRESOS TOTALES: $' + totalIn.toFixed(2) + '\n';
  ctx += 'GASTOS TOTALES:   $' + totalOut.toFixed(2) + '\n';
  ctx += 'AHORRO NETO:      $' + (totalIn - totalOut).toFixed(2) + ' (' + (totalIn > 0 ? Math.round((totalIn - totalOut) / totalIn * 100) : 0) + '% del ingreso)\n\n';

  ctx += 'GASTO POR MES:\n';
  meses.forEach(function(ym) {
    ctx += '  ' + ym + ': ingreso $' + byMonth[ym].in.toFixed(0) + ', gasto $' + byMonth[ym].out.toFixed(0) + '\n';
  });

  ctx += '\nTOP CATEGORÍAS DE GASTO (período completo):\n';
  topCats.forEach(function(c) {
    ctx += '  ' + c.cat + ': $' + c.sum.toFixed(2) + ' (' + Math.round(c.sum / totalOut * 100) + '%)\n';
  });

  // Desglose por destinatario dentro de cada top cat — habilita
  // "¿a quién le pago más en transfer salida?", "¿cuánto le mandé a X?"
  ctx += '\nTOP DESTINATARIOS POR CATEGORÍA (top 5 cats × top 5 destinatarios):\n';
  topCats.slice(0, 5).forEach(function(c) {
    var dest = byCatDest[c.cat] || {};
    var topDest = Object.keys(dest).map(function(k) { return { name: k, sum: dest[k] }; })
      .sort(function(a, b) { return b.sum - a.sum; }).slice(0, 5);
    if (!topDest.length) return;
    ctx += '  ' + c.cat + ':\n';
    topDest.forEach(function(t) {
      ctx += '    ' + t.name + ': $' + t.sum.toFixed(2) + '\n';
    });
  });

  ctx += '\nGASTO POR MES Y CATEGORÍA (top 6 cats por mes):\n';
  meses.forEach(function(ym) {
    var catsMes = byMonthCat[ym] || {};
    var topCatsMes = Object.keys(catsMes)
      .map(function(c) { return { cat: c, sum: catsMes[c] }; })
      .sort(function(a, b) { return b.sum - a.sum; })
      .slice(0, 6);
    if (!topCatsMes.length) return;
    ctx += '  ' + ym + ':\n';
    topCatsMes.forEach(function(c) {
      ctx += '    ' + c.cat + ': $' + c.sum.toFixed(2) + '\n';
    });
  });

  // Destinatarios por mes — "¿a quién le mandé más en mayo?"
  ctx += '\nTOP DESTINATARIOS POR MES (top 5 por mes):\n';
  meses.forEach(function(ym) {
    var dest = byMonthDest[ym] || {};
    var topDestMes = Object.keys(dest).map(function(k) { return { name: k, sum: dest[k] }; })
      .sort(function(a, b) { return b.sum - a.sum; }).slice(0, 5);
    if (!topDestMes.length) return;
    ctx += '  ' + ym + ':\n';
    topDestMes.forEach(function(t) {
      ctx += '    ' + t.name + ': $' + t.sum.toFixed(2) + '\n';
    });
  });

  ctx += '\nTOP MERCHANTS (agrupados por descripción):\n';
  topM.forEach(function(m) { ctx += '  ' + m.name + ': $' + m.sum.toFixed(2) + '\n'; });

  if (topYO.length) {
    ctx += '\nYAPPYS QUE MÁS ENVIASTE:\n';
    topYO.forEach(function(y) { ctx += '  a ' + y.name + ': $' + y.sum.toFixed(2) + '\n'; });
  }
  if (topYI.length) {
    ctx += '\nYAPPYS QUE MÁS RECIBISTE:\n';
    topYI.forEach(function(y) { ctx += '  de ' + y.name + ': $' + y.sum.toFixed(2) + '\n'; });
  }

  if (suscripciones.length) {
    ctx += '\nSUSCRIPCIONES RECURRENTES DETECTADAS (3+ cargos mensuales estables):\n';
    suscripciones.slice(0, 8).forEach(function(s) {
      ctx += '  ' + s.merchant + ': ~$' + s.avg.toFixed(2) + '/mes (' + s.count + ' cargos)\n';
    });
  }

  if (form90.length) {
    ctx += '\nDEDUCIBLES FORM 90 (DGI Panamá) DETECTADOS:\n';
    form90.forEach(function(f) { ctx += '  ' + f.label + ': $' + f.sum.toFixed(2) + '\n'; });
  }

  if (pequenos.length >= 5) {
    ctx += '\nGASTOS CHICOS (<$10): ' + pequenos.length + ' compras = $' + sumaPeq.toFixed(2) + '\n';
  }

  // Transacciones individuales — habilita "mostrame los gastos de X
  // en mes Y", "qué fue ese cargo del 15 de junio", etc. Sin esto el
  // asesor solo tiene agregados. Sonnet 4.6 maneja 200k tokens, esto
  // suele rondar 10-30k para 12 meses.
  ctx += '\nTRANSACCIONES INDIVIDUALES (formato: fecha cat monto descripcion):\n';
  movs.forEach(function(m) {
    var f = Utilities.formatDate(new Date(m.fecha), 'America/Panama', 'yyyy-MM-dd');
    var monto = (m.monto >= 0 ? '+' : '') + m.monto.toFixed(2);
    var desc = String(m.descripcion || '').substring(0, 80);
    var cat = m.cat || 'otro';
    ctx += f + ' ' + cat + ' ' + monto + ' ' + desc + '\n';
  });

  return ctx;
}

// Llama a Claude Sonnet 4.6 con system prompt de asesor financiero
// panameño + el contexto + la pregunta. Devuelve el texto plano.
function _bancoConsultarAsesor(question, context) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY no configurada');

  var system =
    'Sos un asesor financiero personal hablando con un cliente panameño vía WhatsApp.\n\n' +
    'Tu trabajo: darle consejo concreto, accionable y honesto sobre sus finanzas usando los datos REALES de su cuenta bancaria que te paso abajo.\n\n' +
    'REGLAS:\n' +
    '1. Usá los números reales del contexto. Cuando cites cifras, usalas exactas ($ y centavos).\n' +
    '2. Andá al grano. WhatsApp = mensaje corto. Máximo 6-8 líneas a menos que la pregunta lo demande.\n' +
    '3. Si la pregunta requiere asumir algo (ej: "¿cuánto debería ahorrar?"), hacé una recomendación concreta basada en su patrón actual, no le devuelvas la pelota pidiendo más info.\n' +
    '4. Si detectás algo problemático (ahorro <10%, suscripciones olvidadas, gasto concentrado), señalalo.\n' +
    '5. Si detectás deducibles personales del Form 90 panameño (salud, educación, intereses hipotecarios, préstamos educativos), recordá que pueden bajar su ISR.\n' +
    '6. NO inventes datos que no estén en el contexto. Si te falta info para responder bien, decílo en una línea.\n' +
    '7. Usá formato WhatsApp simple: *bold*, _italic_, viñetas con •. Sin markdown complejo, sin headers de #.\n' +
    '8. Tono: cercano, directo, sin paja motivacional. Si la persona está en buen camino decílo; si no, también.\n' +
    '9. Vos sos un asistente, no un asesor financiero licenciado. No des consejos de inversión específicos (qué acciones comprar, etc.) — quedate en presupuesto, ahorro, gastos, optimización fiscal personal.\n\n' +
    'CONTEXTO FINANCIERO DEL CLIENTE:\n' +
    context;

  var payload = {
    model:      'claude-sonnet-4-6',
    max_tokens: 1500,
    system:     system,
    messages:   [{ role: 'user', content: question }],
  };
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify(payload),
    headers:            { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    var body = res.getContentText().substring(0, 400);
    Logger.log('Claude asesor error ' + res.getResponseCode() + ': ' + body);
    throw new Error('Claude HTTP ' + res.getResponseCode());
  }
  var data = JSON.parse(res.getContentText());
  // Concatenar todos los text blocks (Sonnet podría devolver thinking + text)
  var out = '';
  if (data.content && data.content.length) {
    for (var i = 0; i < data.content.length; i++) {
      if (data.content[i].type === 'text') out += data.content[i].text;
    }
  }
  return out.trim() || '(sin respuesta)';
}

function _bancoRenderRespuestaAsesor(text) {
  // Cap a WhatsApp 4000 chars, agregar un caveat suave al final si no
  // viene ya en la respuesta.
  var t = String(text || '').substring(0, 3700);
  if (!/asesor licenciado|contador|profesional/i.test(t)) {
    t += '\n\n_💬 Esto es orientación general — para temas de impuestos o inversiones específicas, contrastá con tu contador._';
  }
  return t.substring(0, 4000);
}

// ════════════════════════════════════════════════════════════════════
//  MENÚ INTERACTIVO DE DRILL — list message tras el análisis
//  ──────────────────────────────────────────────────────────────────
//  Mostrar buttons tapables para drill-down en vez de depender de
//  comandos de texto. Separa visualmente "datos predecibles" (menú)
//  de "preguntas abiertas" (lenguaje natural → asesor).
//
//  Layout: 10 items totales máx (límite WhatsApp interactive list):
//    📊 Categorías  — top 5 por gasto
//    📅 Meses       — más recientes (4)
//    📥 Descargar   — 1 (Excel)
//
//  Button id format: wa:bdrill:<tipo>:<param>
//    wa:bdrill:cat:comida       → drill cat
//    wa:bdrill:mes:2026-05      → drill mes
//    wa:bdrill:excel            → export xlsx
//
//  Manejados en _whatsappOnInteractive vía branch accion === 'bdrill'.
// ════════════════════════════════════════════════════════════════════

function _bancoEnviarMenuDrill(movs, categorias, from, token, phoneId) {
  if (!movs || !movs.length) return false;

  var catTotals = {};
  var byMonth = {};
  movs.forEach(function(m) {
    var ym = Utilities.formatDate(m.fecha, 'America/Panama', 'yyyy-MM');
    if (m.monto >= 0) {
      byMonth[ym] = byMonth[ym] || { out: 0, in: 0 };
      byMonth[ym].in += m.monto;
    } else {
      var cat = categorias[m.descripcion] || 'otro';
      catTotals[cat] = (catTotals[cat] || 0) + (-m.monto);
      byMonth[ym] = byMonth[ym] || { out: 0, in: 0 };
      byMonth[ym].out += -m.monto;
    }
  });

  var topCats = Object.keys(catTotals)
    .map(function(c) { return { cat: c, sum: catTotals[c] }; })
    .sort(function(a, b) { return b.sum - a.sum; })
    .slice(0, 5);
  // Cap WhatsApp list = 10 rows totales: 4 descargas + 5 cats + 1 mes.
  var meses = Object.keys(byMonth).sort().reverse().slice(0, 1);

  var sections = [];

  // Descargas PRIMERO — visibles sin scrollear. 3 variantes de Excel
  // para que el usuario compare cuál prefiere (A/B testing en uso real).
  sections.push({
    title: '📥 Descargas',
    rows: [
      {
        id:          'wa:bdrill:pdf',
        title:       '📑 Reporte PDF',
        description: 'Ejecutivo, branded, mobile',
      },
      {
        id:          'wa:bdrill:excel',
        title:       '📊 Excel completo',
        description: 'Versión actual (20+ hojas)',
      },
      {
        id:          'wa:bdrill:excel_a',
        title:       '📊 Excel simplificado',
        description: '4 hojas: diagnóstico + 2 matrices + movs',
      },
      {
        id:          'wa:bdrill:excel_b',
        title:       '📊 Excel dashboard',
        description: '3 hojas: todo en dashboard + movs + pivot',
      },
    ],
  });

  if (topCats.length) {
    sections.push({
      title: '🔍 Detalle por categoría',
      rows: topCats.map(function(c) {
        // Title cap 24 — _bancoCatLabel devuelve "🏷 Nombre" (~18-22 chars)
        return {
          id:          'wa:bdrill:cat:' + c.cat,
          title:       _bancoCatLabel(c.cat).substring(0, 24),
          description: _bancoFmtDolar(c.sum),
        };
      }),
    });
  }

  if (meses.length) {
    sections.push({
      title: '🔍 Detalle por mes',
      rows: meses.map(function(ym) {
        var label = _bancoMesLabel(ym) + ' ' + ym.split('-')[0];  // "JUN 2026"
        var info  = byMonth[ym];
        return {
          id:          'wa:bdrill:mes:' + ym,
          title:       label.substring(0, 24),
          description: 'Gasto: ' + _bancoFmtDolar(info.out),
        };
      }),
    });
  }

  return _whatsappReplyLista(
    from,
    '🔍 *Ver detalle de:*',
    'Ver opciones',
    sections, token, phoneId
  );
}

// Convierte un button id de drill (sin el prefijo wa:bdrill:) al
// intent que entiende _bancoHandleDrill. Llamado desde el dispatcher
// de _whatsappOnInteractive.
function _bancoHandleDrillBoton(parts, from, token, phoneId) {
  // parts viene del split de "wa:bdrill:<tipo>[:param]" cortado en bdrill
  // Ej: ["cat", "comida"], ["mes", "2026-05"], ["excel"]
  if (!parts || !parts.length) return;
  var tipo = parts[0];
  var intent;
  if (tipo === 'cat')          intent = { type: 'cat',     cat: parts[1] };
  else if (tipo === 'mes')     intent = { type: 'month',   ym:  parts[1] };
  else if (tipo === 'excel')   intent = { type: 'excel' };
  else if (tipo === 'excel_a') intent = { type: 'excel_a' };
  else if (tipo === 'excel_b') intent = { type: 'excel_b' };
  else if (tipo === 'pdf')     intent = { type: 'pdf' };
  else { Logger.log('Drill boton tipo desconocido: ' + tipo); return; }
  _bancoHandleDrill(intent, from, token, phoneId);
}

// ════════════════════════════════════════════════════════════════════
//  HOJA DIAGNÓSTICO — executive summary del Excel
//  Se renderea como hoja final del workbook. Layout:
//    1. Título + período
//    2. RESUMEN EJECUTIVO (saldo, flujo, ahorro)
//    3. SEMÁFORO DE SALUD FINANCIERA (4 indicadores con colores)
//    4. HALLAZGOS ACCIONABLES (hasta 5 insights concretos)
//    5. PRÓXIMOS PASOS (checklist accionable)
// ════════════════════════════════════════════════════════════════════

function _bancoPoblarDiagnostico(sh, cache, agg) {
  var movs = cache.movs;
  var totalIn = agg.totalIn, totalOut = agg.totalOut;
  var catTotals = agg.catTotals, catMovs = agg.catMovs;
  var fmt = _bancoFmtDolar;

  // Computar saldo inicial / final (mismo método que _bancoAnalizar)
  // En esta fase el cache slim NO trae saldo, así que típicamente quedará null.
  var first = movs[0], last = movs[movs.length - 1];
  var saldoIni = null, saldoFin = null, deltaSaldo = null;
  if (first && last && first.saldo != null && last.saldo != null) {
    var bgStyle = !first.fecha || !last.fecha || first.fecha >= last.fecha;
    var newest = bgStyle ? first : last;
    var oldest = bgStyle ? last  : first;
    if (newest.saldo != null && oldest.saldo != null) {
      saldoFin   = newest.saldo;
      saldoIni   = oldest.saldo - oldest.monto;
      deltaSaldo = saldoFin - saldoIni;
    }
  }

  var ahorroPct = totalIn > 0 ? Math.round(((totalIn - totalOut) / totalIn) * 100) : 0;
  var fechas = movs.map(function(m) { return m.fecha; }).filter(Boolean).sort(function(a, b) { return a - b; });
  var dias = fechas.length ? Math.max(1, Math.round((fechas[fechas.length-1] - fechas[0]) / 86400000) + 1) : 0;
  var periodoStr = _bancoFmtPeriodo(fechas[0], fechas[fechas.length-1]);

  // Top cat de CONSUMO (excluir transferencias)
  var CATS_NO_CONSUMO = ['ach_salida', 'yappy_salida', 'pago_tarjeta'];
  var consumoTotals = {};
  Object.keys(catTotals).forEach(function(c) {
    if (CATS_NO_CONSUMO.indexOf(c) < 0) consumoTotals[c] = catTotals[c];
  });
  var topConsumoCat = Object.keys(consumoTotals).sort(function(a, b) { return consumoTotals[b] - consumoTotals[a]; })[0] || null;
  var topConsumoPct = topConsumoCat && totalOut > 0 ? Math.round((consumoTotals[topConsumoCat] / totalOut) * 100) : 0;

  var rows = [];
  rows.push(['DIAGNÓSTICO FINANCIERO', '', '', '']);
  rows.push([periodoStr, '', '', '']);
  rows.push(['', '', '', '']);

  // SECCIÓN 1: Resumen ejecutivo
  rows.push(['📊 RESUMEN EJECUTIVO', '', '', '']);
  rows.push(['Período', periodoStr, dias + ' días', '']);
  rows.push(['Movimientos', movs.length, '', '']);
  if (saldoIni != null) rows.push(['Saldo inicial', fmt(saldoIni), '', '']);
  if (saldoFin != null) rows.push(['Saldo final',   fmt(saldoFin), '', '']);
  rows.push(['Ingresos', fmt(totalIn), '', '']);
  rows.push(['Gastos',   fmt(totalOut), '', '']);
  rows.push(['Flujo neto', fmt(totalIn - totalOut), (totalIn - totalOut >= 0 ? 'Positivo' : 'Negativo'), '']);
  rows.push(['Ahorro', ahorroPct + '%', '', '']);
  rows.push(['', '', '', '']);

  // SECCIÓN 2: Semáforo de salud
  rows.push(['🏥 SEMÁFORO DE SALUD FINANCIERA', '', '', '']);
  rows.push(['Indicador', 'Valor', 'Estado', 'Comentario']);
  var saludRows = [];

  // Indicador 1: Ahorro
  var ahorroEstado, ahorroColor, ahorroComentario;
  if (ahorroPct >= 15)      { ahorroEstado = '🟢 Saludable'; ahorroColor = 'green';  ahorroComentario = 'Estás ahorrando por encima del promedio.'; }
  else if (ahorroPct >= 5)  { ahorroEstado = '🟡 Aceptable'; ahorroColor = 'yellow'; ahorroComentario = 'Apunta a 15%+ del ingreso.'; }
  else if (ahorroPct >= 0)  { ahorroEstado = '🟡 Empate';    ahorroColor = 'yellow'; ahorroComentario = 'Gastás casi todo lo que entra.'; }
  else                      { ahorroEstado = '🔴 Negativo';  ahorroColor = 'red';    ahorroComentario = 'Gastás más de lo que ganás — revisar.'; }
  saludRows.push({ label: 'Ahorro', valor: ahorroPct + '%', estado: ahorroEstado, color: ahorroColor, comentario: ahorroComentario });

  // Indicador 2: Concentración (cat de consumo dominante)
  if (topConsumoCat) {
    var concEstado, concColor, concComentario;
    if (topConsumoPct >= 40)      { concEstado = '🔴 Alta';      concColor = 'red';    concComentario = topConsumoPct + '% en una sola cat. Diversificá.'; }
    else if (topConsumoPct >= 25) { concEstado = '🟡 Moderada';  concColor = 'yellow'; concComentario = 'Concentración aceptable.'; }
    else                          { concEstado = '🟢 Diversa';   concColor = 'green';  concComentario = 'Gasto bien distribuido entre categorías.'; }
    saludRows.push({ label: 'Concentración top cat consumo', valor: _bancoCatLabel(topConsumoCat) + ' ' + topConsumoPct + '%', estado: concEstado, color: concColor, comentario: concComentario });
  }

  // Indicador 3: Tendencia saldo
  if (deltaSaldo != null) {
    var tendEstado, tendColor, tendComentario;
    if (deltaSaldo > 50)         { tendEstado = '🟢 Subiendo';  tendColor = 'green';  tendComentario = 'Saldo creció ' + fmt(deltaSaldo) + ' — patrimonio neto al alza.'; }
    else if (deltaSaldo >= -50)  { tendEstado = '🟡 Estable';   tendColor = 'yellow'; tendComentario = 'Saldo cambió poco ' + (deltaSaldo >= 0 ? '+' : '−') + fmt(Math.abs(deltaSaldo)); }
    else                         { tendEstado = '🔴 Bajando';   tendColor = 'red';    tendComentario = 'Saldo cayó ' + fmt(Math.abs(deltaSaldo)) + ' — revisar gastos.'; }
    saludRows.push({ label: 'Tendencia del saldo', valor: fmt(deltaSaldo), estado: tendEstado, color: tendColor, comentario: tendComentario });
  }

  // Indicador 4: Runway (días con saldo actual al ritmo de gasto)
  if (saldoFin != null && dias > 0 && totalOut > 0) {
    var gastoDiario = totalOut / dias;
    var runwayDias = gastoDiario > 0 ? Math.floor(saldoFin / gastoDiario) : 999;
    var runEstado, runColor, runComentario;
    if (runwayDias >= 30)       { runEstado = '🟢 30+ días';   runColor = 'green';  runComentario = 'Tenés buen colchón al ritmo actual.'; }
    else if (runwayDias >= 15)  { runEstado = '🟡 15-29 días'; runColor = 'yellow'; runComentario = 'Colchón medio. Considerá aumentar ahorro.'; }
    else                        { runEstado = '🔴 < 15 días';  runColor = 'red';    runComentario = 'Si paran los ingresos, saldo dura poco.'; }
    saludRows.push({ label: 'Runway (saldo ÷ gasto diario)', valor: runwayDias + ' días', estado: runEstado, color: runColor, comentario: runComentario });
  }

  saludRows.forEach(function(r) { rows.push([r.label, r.valor, r.estado, r.comentario]); });
  var saludStartRow = rows.length - saludRows.length + 1;  // 1-based
  rows.push(['', '', '', '']);

  // SECCIÓN 3: Hallazgos accionables
  var hallazgos = _bancoComputarHallazgos(movs, totalIn, totalOut, catTotals, catMovs, dias);
  if (hallazgos.length) {
    rows.push(['💡 HALLAZGOS ACCIONABLES', '', '', '']);
    hallazgos.forEach(function(h, i) {
      rows.push([(i+1) + '. ' + h.titulo, h.dato, h.accion, '']);
    });
    rows.push(['', '', '', '']);
  }

  // SECCIÓN 4: Próximos pasos (checklist)
  var pasos = _bancoComputarPasos(hallazgos, saludRows);
  if (pasos.length) {
    rows.push(['📋 PRÓXIMOS PASOS RECOMENDADOS', '', '', '']);
    pasos.forEach(function(p) {
      rows.push(['☐', p, '', '']);
    });
    rows.push(['', '', '', '']);
  }

  // Footer con navegación
  rows.push(['', '', '', '']);
  rows.push(['📑 NAVEGACIÓN', '', '', '']);
  rows.push(['Resumen y desglose', '', '', '=HYPERLINK("#\'Resumen\'!A1","→ Ir al Resumen")']);
  rows.push(['Todos los movimientos', '', '', '=HYPERLINK("#\'Movimientos\'!A1","→ Ver Movimientos")']);

  // ─── Aplicar al sheet ───────────────────────────────────────
  sh.getRange(1, 1, rows.length, 4).setValues(rows);

  // Título
  sh.getRange(1, 1, 1, 4).merge().setFontSize(18).setFontWeight('bold').setBackground('#1A1A2E').setFontColor('#FFFFFF').setHorizontalAlignment('center');
  sh.getRange(2, 1, 1, 4).merge().setFontSize(11).setFontColor('#6C757D').setHorizontalAlignment('center');

  // Section headers
  var sectionHeaders = ['📊 RESUMEN EJECUTIVO', '🏥 SEMÁFORO DE SALUD FINANCIERA', '💡 HALLAZGOS ACCIONABLES', '📋 PRÓXIMOS PASOS RECOMENDADOS', '📑 NAVEGACIÓN'];
  for (var r = 0; r < rows.length; r++) {
    if (sectionHeaders.indexOf(rows[r][0]) >= 0) {
      sh.getRange(r + 1, 1, 1, 4).merge().setFontSize(13).setFontWeight('bold').setBackground('#F1F3F5').setFontColor('#1A1A2E');
    }
  }

  // Colores del semáforo en la columna C
  var SEM_COLORS = { green: '#D4EDDA', yellow: '#FFF3CD', red: '#F8D7DA' };
  saludRows.forEach(function(r, i) {
    var bg = SEM_COLORS[r.color] || '#FFFFFF';
    sh.getRange(saludStartRow + i, 3).setBackground(bg).setFontWeight('bold');
  });

  sh.setColumnWidth(1, 280);
  sh.setColumnWidth(2, 140);
  sh.setColumnWidth(3, 180);
  sh.setColumnWidth(4, 360);
  sh.setHiddenGridlines(true);
  sh.getRange(1, 4, rows.length, 1).setWrap(true);
  sh.setFrozenRows(2);
}

function _bancoFmtPeriodo(d1, d2) {
  if (!d1 || !d2) return '—';
  var meses = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  var s = d1.getDate() + ' ' + meses[d1.getMonth()];
  var e = d2.getDate() + ' ' + meses[d2.getMonth()] + ' ' + d2.getFullYear();
  return s + ' – ' + e;
}

// Computa hasta 5 hallazgos accionables basados en los datos.
function _bancoComputarHallazgos(movs, totalIn, totalOut, catTotals, catMovs, dias) {
  var out = [];
  var fmt = _bancoFmtDolar;

  // Form 90 — deducibles personales detectados
  var saludTot  = catTotals['salud']     || 0;
  var educTot   = catTotals['educacion'] || 0;
  var seguroTot = catTotals['seguro']    || 0;
  var prestTot  = catTotals['prestamo']  || 0;
  var form90Sum = saludTot + educTot + seguroTot + prestTot;
  if (form90Sum >= 50) {
    var parts = [];
    if (saludTot  >= 20) parts.push('Salud ' + fmt(saludTot) + ' (DP-1)');
    if (educTot   >= 20) parts.push('Educación ' + fmt(educTot) + ' (DP-2)');
    if (seguroTot >= 20) parts.push('Seguros ' + fmt(seguroTot));
    if (prestTot  >= 20) parts.push('Préstamos ' + fmt(prestTot) + ' (DP-3/4)');
    out.push({
      titulo: 'Deducibles Form 90 detectados',
      dato:   fmt(form90Sum) + ' total',
      accion: parts.join(' · ') + ' — registrar como Gasto Personal en ContaFacil.',
    });
  }

  // Top merchant real de consumo
  var byMerchant = {};
  movs.forEach(function(m) {
    if (m.monto >= 0) return;
    var CATS_NO = ['ach_salida', 'yappy_salida', 'pago_tarjeta'];
    if (CATS_NO.indexOf(m.cat) >= 0) return;
    if (/^YAPPY\s+BG\s+|BANCA\s+MOVIL|PAGO\s+TC/i.test(m.descripcion)) return;
    var mk = m.descripcion.split(/-\d{4}-?\d|\s+\d{6,}/)[0].trim().substring(0, 35);
    byMerchant[mk] = (byMerchant[mk] || 0) + (-m.monto);
  });
  var topM = Object.keys(byMerchant).map(function(k) { return { name: k, sum: byMerchant[k] }; })
    .sort(function(a, b) { return b.sum - a.sum; });
  if (topM.length && topM[0].sum >= 30) {
    var pct = Math.round((topM[0].sum / totalOut) * 100);
    out.push({
      titulo: 'Merchant donde más gastaste',
      dato:   topM[0].name + ' ' + fmt(topM[0].sum) + ' (' + pct + '%)',
      accion: 'Revisar si vale la pena reducir o cambiar.',
    });
  }

  // Suscripciones detectadas (mismo merchant 3+ veces, monto similar, mensual)
  var byMSubs = {};
  movs.forEach(function(m) {
    if (m.monto >= 0) return;
    var mk = m.descripcion.split(/-\d{4}-?\d|\s+\d{6,}/)[0].trim().substring(0, 35);
    if (!byMSubs[mk]) byMSubs[mk] = { sum: 0, count: 0, montos: [], fechas: [] };
    byMSubs[mk].count++;
    byMSubs[mk].sum += -m.monto;
    byMSubs[mk].montos.push(m.monto);
    byMSubs[mk].fechas.push(m.fecha);
  });
  var subsDetectadas = [];
  Object.keys(byMSubs).forEach(function(mk) {
    var info = byMSubs[mk];
    if (info.count < 3) return;
    var avg = info.sum / info.count;
    if (avg < 3) return;
    var allClose = info.montos.every(function(x) { return Math.abs(Math.abs(x) - avg) / avg < 0.15; });
    if (!allClose) return;
    var fechasOrd = info.fechas.slice().filter(Boolean).sort(function(a, b) { return a - b; });
    var intervalos = [];
    for (var i = 1; i < fechasOrd.length; i++) intervalos.push((fechasOrd[i] - fechasOrd[i-1]) / 86400000);
    intervalos.sort(function(a, b) { return a - b; });
    var mediana = intervalos[Math.floor(intervalos.length / 2)];
    if (mediana < 22 || mediana > 38) return;
    subsDetectadas.push({ merchant: mk, avg: avg, count: info.count });
  });
  subsDetectadas.sort(function(a, b) { return b.avg - a.avg; });
  if (subsDetectadas.length) {
    var subTot = subsDetectadas.reduce(function(s, x) { return s + x.avg; }, 0);
    var topSub = subsDetectadas[0];
    out.push({
      titulo: 'Suscripciones recurrentes detectadas',
      dato:   subsDetectadas.length + ' (≈' + fmt(subTot) + '/mes)',
      accion: 'Top: ' + topSub.merchant + ' ' + fmt(topSub.avg) + ' · auditar las que no usás.',
    });
  }

  // Gastos chicos (<$10)
  var chicos = movs.filter(function(m) { return m.monto < 0 && m.monto > -10; });
  if (chicos.length >= 10) {
    var sumChicos = chicos.reduce(function(s, m) { return s + Math.abs(m.monto); }, 0);
    var anual = dias > 0 ? (sumChicos / dias) * 365 : 0;
    out.push({
      titulo: 'Gastos chicos que suman',
      dato:   chicos.length + ' compras <$10 = ' + fmt(sumChicos),
      accion: 'Proyección anual ' + fmt(anual) + '. Bajándolos 50% ahorrás ' + fmt(anual / 2) + '/año.',
    });
  }

  // Top Yappy destinatario (si > 5% del gasto total)
  var byYappy = {};
  movs.forEach(function(m) {
    if (m.monto >= 0) return;
    var ym = /^YAPPY\s+BG\s+A\s+(.+?)(?:\s+POR\b|\s*$)/i.exec(m.descripcion);
    if (!ym) return;
    var name = ym[1].split(/\s+/).slice(0, 3).join(' ');
    byYappy[name] = (byYappy[name] || 0) + Math.abs(m.monto);
  });
  var topY = Object.keys(byYappy).map(function(k) { return { name: k, sum: byYappy[k] }; })
    .sort(function(a, b) { return b.sum - a.sum; });
  if (topY.length && topY[0].sum / Math.max(totalOut, 1) > 0.05) {
    var pctY = Math.round((topY[0].sum / totalOut) * 100);
    out.push({
      titulo: 'Yappys concentrados en un destinatario',
      dato:   topY[0].name + ' ' + fmt(topY[0].sum) + ' (' + pctY + '%)',
      accion: 'Si es proveedor recurrente, registralo como Acreedor en ContaFacil.',
    });
  }

  return out.slice(0, 5);
}

// Convierte hallazgos + flags de salud en próximos pasos accionables.
function _bancoComputarPasos(hallazgos, saludRows) {
  var pasos = [];
  hallazgos.forEach(function(h) {
    if (/Form 90/i.test(h.titulo))                   pasos.push('Registrar salud, educación y otros deducibles como Gastos Personales en ContaFacil para tu Form 90.');
    else if (/Suscripciones/i.test(h.titulo))        pasos.push('Auditar las suscripciones recurrentes en la hoja "Movimientos" (filtrar por merchant) y dar de baja las que no usás.');
    else if (/chicos/i.test(h.titulo))               pasos.push('Identificar las 3-5 categorías de gastos chicos más frecuentes y cortarlas al 50%.');
    else if (/Yappys concentrados/i.test(h.titulo))  pasos.push('Si el Yappy es a proveedor recurrente, registralo como Acreedor para emitir factura.');
    else if (/Merchant donde más/i.test(h.titulo))   pasos.push('Evaluar si el top merchant es necesario o si hay alternativa más barata.');
  });
  saludRows.forEach(function(r) {
    if (r.label === 'Ahorro' && r.color !== 'green') {
      pasos.push('Apartar el ahorro al INICIO del mes (no al final). Apuntá a 15%+ del ingreso.');
    }
    if (r.label === 'Runway (saldo ÷ gasto diario)' && r.color === 'red') {
      pasos.push('Construir colchón de emergencia de al menos 1 mes de gastos.');
    }
  });
  var seen = {};
  return pasos.filter(function(p) { if (seen[p]) return false; seen[p] = true; return true; });
}

// ════════════════════════════════════════════════════════════════════
//  REPORTE PDF EJECUTIVO
//  ──────────────────────────────────────────────────────────────────
//  Genera un PDF de 2-3 páginas con los insights más importantes del
//  análisis bancario, branded con el logo y colores de BalanceClip.
//
//  Pipeline:
//    HTML template (con SVG inline para charts) → newBlob('text/html')
//    → getAs('application/pdf') → upload a Meta → enviar como document.
//
//  Diseñado para servir como artefacto compartible — el cliente puede
//  archivarlo, mostrarlo a su contador, o usarlo de referencia.
// ════════════════════════════════════════════════════════════════════

function _bancoEnviarReportePDF(analisis, from, token, phoneId) {
  var html = _bancoBuildHTMLReporte(analisis);
  var blob = Utilities.newBlob(html, 'text/html', 'reporte.html').getAs('application/pdf');
  var fname = 'reporte-bancario-' + Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd') + '.pdf';
  blob.setName(fname);
  var mediaId = _bancoUploadMediaWA(blob, fname, token, phoneId);
  _bancoSendDocumentWA(from, mediaId, fname, '📑 Tu reporte ejecutivo en PDF', token, phoneId);
}

function _bancoBuildHTMLReporte(a) {
  var fmt = function(n) { return '$' + (isFinite(n) ? Number(n).toFixed(2) : '0.00'); };
  var fmtShort = function(n) {
    if (!isFinite(n)) return '$0';
    return Math.abs(n) < 5 ? '$' + n.toFixed(2) : '$' + Math.round(n).toLocaleString('en-US');
  };
  var fechaStr = function(d) {
    return d ? Utilities.formatDate(d, 'America/Panama', "d 'de' MMMM yyyy") : '—';
  };
  var hoy = Utilities.formatDate(new Date(), 'America/Panama', "d MMM yyyy");
  var ahorro = a.totalIn > 0 ? Math.round(((a.totalIn - a.totalOut) / a.totalIn) * 100) : 0;
  var deltaSaldoStr = '';
  if (a.deltaSaldo != null) {
    deltaSaldoStr = (a.deltaSaldo >= 0 ? '+' : '−') + fmt(Math.abs(a.deltaSaldo));
  }

  var semaforo = _bancoPDFComputarSemaforo(a, ahorro);
  var hallazgos = _bancoPDFComputarHallazgos(a, ahorro);

  // Paleta para slices del donut. Marca abre con el naranja BalanceClip
  // (top cat más prominente), después colores categóricamente distintos
  // para que adyacentes nunca compitan visualmente. Sin duplicados de
  // matiz en los primeros 6 (que son los que el cliente realmente ve).
  var PALETA = [
    '#ea580c',  // 1. naranja BalanceClip — top cat
    '#0891b2',  // 2. teal
    '#7c3aed',  // 3. violeta
    '#059669',  // 4. verde esmeralda
    '#dc2626',  // 5. rojo
    '#f59e0b',  // 6. amber/oro
    '#0284c7',  // 7. azul
    '#db2777',  // 8. rosa/magenta
    '#65a30d',  // 9. verde lima
    '#6b7280',  // 10. gris (Otros)
  ];

  // CSS optimizado para lectura mobile sin zoom: fuentes más grandes,
  // padding más generoso, cards más altas, single column dominante.
  var css = (
    // Página angosta tipo phone-portrait (A5): el PDF abre legible en mobile sin
    // necesidad de zoom. Si Drive ignora el @page, queda Letter por default
    // pero el contenido sigue siendo grande.
    "@page{size:148mm 210mm;margin:0;}" +
    "body{font-family:Helvetica,Arial,sans-serif;color:#1f2937;margin:0;padding:22px 18px;font-size:14px;line-height:1.5;}" +
    ".header{display:flex;align-items:center;border-bottom:3px solid #fb923c;padding-bottom:12px;margin-bottom:18px;page-break-after:avoid;}" +
    ".logo{width:48px;height:48px;margin-right:12px;border-radius:50%;}" +
    ".brand{font-size:22px;font-weight:800;line-height:1;}" +
    ".brand .bc{color:#ea580c;}" +
    ".tagline{font-size:10px;color:#6b7280;letter-spacing:1.5px;margin-top:3px;font-weight:600;}" +
    ".meta{margin-left:auto;font-size:10px;color:#6b7280;text-align:right;line-height:1.4;}" +
    ".meta strong{display:block;font-size:12px;color:#1f2937;}" +
    ".hero{background:#fff7ed;border:2px solid #fed7aa;padding:18px;border-radius:12px;margin-bottom:18px;}" +
    ".hero .kicker{font-size:10px;color:#9a3412;letter-spacing:2px;font-weight:800;}" +
    ".hero h1{margin:8px 0 2px;font-size:18px;color:#1f2937;line-height:1.2;}" +
    ".hero .subtitle{color:#6b7280;font-size:12px;}" +
    ".hero .saldo{margin-top:14px;font-size:34px;font-weight:900;color:#1f2937;letter-spacing:-1.5px;line-height:1;}" +
    ".hero .delta{font-size:13px;font-weight:700;margin-top:5px;}" +
    ".delta.up{color:#059669;}" +
    ".delta.down{color:#dc2626;}" +
    // page-break-inside: avoid → mantiene cada section unida (título + contenido).
    // Esto fixea el bug del título de Tendencia en página separada de su gráfica.
    ".section{margin-bottom:20px;page-break-inside:avoid;}" +
    ".section h2{font-size:15px;color:#1f2937;border-bottom:2px solid #fed7aa;padding-bottom:6px;margin:0 0 12px;page-break-after:avoid;}" +
    ".section h3{font-size:13px;color:#374151;margin:14px 0 8px;font-weight:700;page-break-after:avoid;}" +
    ".section h3 .pill{display:inline-block;background:#fb923c;color:#fff;font-size:12px;padding:2px 8px;border-radius:10px;margin-right:8px;vertical-align:middle;}" +
    // Flujo: 3 cards en 1 fila (siguen siendo legibles porque van GRANDES)
    ".cards-3{display:table;width:100%;border-spacing:10px 0;table-layout:fixed;}" +
    ".cards-3 .card{display:table-cell;padding:14px 10px;border-radius:10px;vertical-align:top;text-align:center;}" +
    ".cards-grid{display:table;width:100%;border-spacing:8px;table-layout:fixed;}" +
    ".cards-grid .row{display:table-row;}" +
    ".cards-grid .card{display:table-cell;padding:14px 10px;border-radius:10px;vertical-align:top;width:50%;}" +
    ".card .label{font-size:10px;text-transform:uppercase;font-weight:800;opacity:0.78;letter-spacing:1.2px;}" +
    ".card .value{font-size:20px;font-weight:900;margin:5px 0 3px;line-height:1.1;}" +
    ".card .note{font-size:11px;opacity:0.9;font-weight:600;}" +
    ".card.green{background:#d1fae5;color:#064e3b;}" +
    ".card.yellow{background:#fef3c7;color:#78350f;}" +
    ".card.red{background:#fee2e2;color:#7f1d1d;}" +
    ".bar-row{display:table;width:100%;font-size:13px;margin:6px 0;}" +
    ".bar-row > div{display:table-cell;vertical-align:middle;}" +
    ".bar-row .blabel{width:35%;padding-right:8px;font-weight:600;}" +
    ".bar-row .bouter{width:35%;height:18px;background:#f3f4f6;border-radius:5px;overflow:hidden;}" +
    ".bar-row .bouter .bfill{height:18px;background:linear-gradient(90deg,#fb923c,#ea580c);border-radius:5px;}" +
    ".bar-row .bvalue{width:30%;padding-left:8px;text-align:right;font-weight:700;}" +
    ".insight{padding:12px 14px;background:#fff7ed;border-left:4px solid #fb923c;margin-bottom:10px;border-radius:0 5px 5px 0;page-break-inside:avoid;}" +
    ".insight .ttl{font-weight:800;color:#9a3412;font-size:14px;}" +
    ".insight .body{font-size:12px;color:#374151;margin-top:3px;line-height:1.5;}" +
    ".donut-wrap{display:table;width:100%;table-layout:fixed;margin:8px 0;}" +
    ".donut-wrap .donut{display:table-cell;vertical-align:middle;width:42%;text-align:center;}" +
    ".donut-wrap .legend{display:table-cell;vertical-align:middle;width:58%;padding-left:12px;font-size:12px;}" +
    ".legend .item{padding:6px 0;display:table;width:100%;border-bottom:1px solid #f3f4f6;}" +
    ".legend .swatch{display:table-cell;vertical-align:middle;width:18px;}" +
    ".legend .lname{display:table-cell;vertical-align:middle;padding-left:8px;}" +
    ".legend .lval{display:table-cell;vertical-align:middle;text-align:right;font-weight:700;color:#1f2937;}" +
    ".table{width:100%;border-collapse:collapse;font-size:13px;}" +
    ".table th{background:#f9fafb;color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;padding:9px 6px;text-align:left;border-bottom:2px solid #e5e7eb;}" +
    ".table td{padding:9px 6px;border-bottom:1px solid #f3f4f6;}" +
    ".table td.amount{text-align:right;font-weight:700;font-family:'Courier New',monospace;}" +
    ".step{padding:9px 0 9px 26px;position:relative;font-size:13px;line-height:1.5;}" +
    ".step:before{content:'☐';position:absolute;left:0;font-size:17px;color:#fb923c;font-weight:bold;top:7px;}" +
    ".footer{margin-top:28px;padding-top:14px;border-top:2px solid #fed7aa;font-size:11px;color:#6b7280;text-align:center;line-height:1.7;}" +
    ".footer a{color:#ea580c;text-decoration:none;font-weight:700;}" +
    ".footer strong{color:#1f2937;}" +
    // Leyenda con definiciones de los indicadores del semáforo
    ".legend-defs{margin-top:14px;padding:12px 14px;background:#f9fafb;border-radius:8px;font-size:11px;color:#374151;line-height:1.55;}" +
    ".legend-defs .ld-item{padding:5px 0;}" +
    ".legend-defs .ld-item b{color:#1f2937;}" +
    ".legend-defs .ld-th{display:block;color:#6b7280;font-size:10px;margin-top:2px;}" +
    // PORTADA — primera página con título grande centrado + hero
    ".cover-page{min-height:180mm;}" +
    ".cover-content{padding-top:42mm;text-align:center;}" +
    ".cover-title{font-size:38px;font-weight:900;color:#1f2937;letter-spacing:-1.5px;margin:0 0 6px;line-height:1.1;}" +
    ".cover-subtitle{font-size:12px;color:#6b7280;letter-spacing:2.5px;text-transform:uppercase;font-weight:700;margin-bottom:30px;}" +
    ".cover-content .hero{margin-bottom:0;text-align:left;}" +
    ".page-break{page-break-before:always;}"
  );

  var logoSVG = (
    "<svg class='logo' viewBox='0 0 52 52' xmlns='http://www.w3.org/2000/svg'>" +
    "<defs><linearGradient id='og' x1='0%' y1='0%' x2='100%' y2='100%'>" +
    "<stop offset='0%' stop-color='#fb923c'/><stop offset='100%' stop-color='#ea580c'/></linearGradient></defs>" +
    "<circle cx='26' cy='26' r='26' fill='url(#og)'/>" +
    "<g transform='translate(26 26) rotate(-12) translate(-10 -18)'>" +
    "<path d='M 7 3.5 C 7 1.5, 8.5 0, 10.5 0 C 12.5 0, 14 1.5, 14 3.5 L 14 31.5 C 14 34.4, 11.6 36.7, 8.75 36.7 C 5.9 36.7, 3.5 34.4, 3.5 31.5 L 3.5 7 C 3.5 5.5, 4.8 4.2, 6.3 4.2 C 7.8 4.2, 9.1 5.5, 9.1 7 L 9.1 30.3 C 9.1 31.1, 9.8 31.8, 10.6 31.8 C 11.4 31.8, 12.1 31.1, 12.1 30.3 L 12.1 5.8' " +
    "fill='none' stroke='#ffffff' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'/></g></svg>"
  );

  var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' + css + '</style></head><body>';

  // ── PORTADA (Página 1): título grande + hero centrados verticalmente ──
  html += '<div class="cover-page">';
  html += '<div class="header">' + logoSVG +
          '<div><div class="brand">Balance<span class="bc">Clip</span></div>' +
          '<div class="tagline">REPORTE EJECUTIVO BANCARIO</div></div>' +
          '<div class="meta">Generado<strong>' + hoy + '</strong></div></div>';

  html += '<div class="cover-content">';
  html += '<div class="cover-title">Reporte Bancario</div>';
  html += '<div class="cover-subtitle">Análisis ejecutivo de tu cuenta</div>';

  // ── HERO ──
  html += '<div class="hero">';
  html += '<div class="kicker">PERÍODO ANALIZADO</div>';
  html += '<h1>' + fechaStr(a.inicio) + ' – ' + fechaStr(a.fin) + '</h1>';
  html += '<div class="subtitle">' + a.dias + ' días · ' + a.nMovs + ' movimientos</div>';
  if (a.saldoFin != null) {
    html += '<div class="saldo">' + fmt(a.saldoFin) + '</div>';
    if (deltaSaldoStr) {
      var cls = a.deltaSaldo >= 0 ? 'up' : 'down';
      var arrow = a.deltaSaldo >= 0 ? '↗' : '↘';
      html += '<div class="delta ' + cls + '">' + arrow + ' ' + deltaSaldoStr + ' vs saldo inicial (' + fmt(a.saldoIni) + ')</div>';
    }
  } else {
    html += '<div class="saldo">' + fmt(a.totalIn - a.totalOut) + '</div>';
    html += '<div class="delta" style="color:#6b7280;">flujo neto del período</div>';
  }
  html += '</div>';  // .hero
  html += '</div>';  // .cover-content
  html += '</div>';  // .cover-page
  html += '<div class="page-break"></div>';

  // ── PÁGINA 2: Header + Flujo + Semáforo + Hallazgos ──
  html += '<div class="header">' + logoSVG +
          '<div><div class="brand">Balance<span class="bc">Clip</span></div>' +
          '<div class="tagline">REPORTE · RESUMEN EJECUTIVO</div></div>' +
          '<div class="meta">Página<strong>2 de 4</strong></div></div>';

  // ── FLUJO (3 cards grandes en una fila) ──
  html += '<div class="section"><h2>Flujo del período</h2><div class="cards-3">';
  html += '<div class="card green"><div class="label">Ingresos</div><div class="value">' + fmtShort(a.totalIn) + '</div></div>';
  html += '<div class="card red"><div class="label">Gastos</div><div class="value">' + fmtShort(a.totalOut) + '</div></div>';
  var ahCls = a.neto >= 0 ? 'green' : 'red';
  html += '<div class="card ' + ahCls + '"><div class="label">' + (a.neto >= 0 ? 'Ahorro neto' : 'Déficit') + '</div><div class="value">' + fmtShort(Math.abs(a.neto)) + '</div><div class="note">' + (ahorro >= 0 ? '+' : '') + ahorro + '% del ingreso</div></div>';
  html += '</div></div>';

  // ── SEMAFORO (2x2 grid en lugar de 4 en una fila) ──
  html += '<div class="section"><h2>Semáforo de salud financiera</h2><div class="cards-grid">';
  for (var si = 0; si < semaforo.length; si += 2) {
    html += '<div class="row">';
    html += '<div class="card ' + semaforo[si].color + '"><div class="label">' + semaforo[si].label + '</div>' +
            '<div class="value">' + semaforo[si].valor + '</div><div class="note">' + semaforo[si].comentario + '</div></div>';
    if (semaforo[si+1]) {
      html += '<div class="card ' + semaforo[si+1].color + '"><div class="label">' + semaforo[si+1].label + '</div>' +
              '<div class="value">' + semaforo[si+1].valor + '</div><div class="note">' + semaforo[si+1].comentario + '</div></div>';
    } else {
      html += '<div></div>';
    }
    html += '</div>';
  }
  html += '</div>';

  // Leyenda: definiciones + rangos saludables para cada indicador.
  // Va dentro de la misma .section para que no se separe del semáforo
  // por un page-break.
  html += '<div class="legend-defs">' +
    '<div class="ld-item"><b>Ahorro</b>: porcentaje del ingreso que no gastaste. ' +
      '<span class="ld-th">🟢 ≥15% · 🟡 5–14% · 🔴 &lt;5%</span></div>' +
    '<div class="ld-item"><b>Concentración</b>: qué porcentaje de tus gastos se va a tu categoría de consumo más grande. ' +
      'Alta concentración = depender mucho de una sola fuente. ' +
      '<span class="ld-th">🟢 &lt;25% · 🟡 25–39% · 🔴 ≥40%</span></div>' +
    '<div class="ld-item"><b>Tendencia</b>: si tu saldo bancario subió o bajó en el período analizado. ' +
      '<span class="ld-th">🟢 subió · 🟡 estable · 🔴 bajó</span></div>' +
    '<div class="ld-item"><b>Runway</b>: cuántos días podrías seguir viviendo con tu saldo actual al ritmo de gasto promedio (sin nuevos ingresos). ' +
      'Es tu colchón de emergencia. ' +
      '<span class="ld-th">🟢 ≥30 días · 🟡 15–29 · 🔴 &lt;15</span></div>' +
    '</div></div>';

  // ── HALLAZGOS ──
  if (hallazgos.length) {
    html += '<div class="section"><h2>Hallazgos accionables</h2>';
    hallazgos.forEach(function(h) {
      html += '<div class="insight"><div class="ttl">' + h.titulo + '</div><div class="body">' + h.body + '</div></div>';
    });
    html += '</div>';
  }

  html += '<div class="page-break"></div>';

  // ── HEADER página 2 ──
  html += '<div class="header">' + logoSVG +
          '<div><div class="brand">Balance<span class="bc">Clip</span></div>' +
          '<div class="tagline">REPORTE · CATEGORÍAS Y PATRONES</div></div>' +
          '<div class="meta">Página<strong>3 de 4</strong></div></div>';

  // ── TOP CATEGORÍAS: donut chart + leyenda ──
  if (a.topCats && a.topCats.length) {
    html += '<div class="section"><h2>Top categorías de gasto</h2>';
    var topForDonut = a.topCats.slice(0, 6).map(function(c, i) {
      return { name: _bancoCatLabel(c.cat), value: c.sum, color: PALETA[i % PALETA.length] };
    });
    // Si hay más cats, agrupar en "Otros"
    if (a.topCats.length > 6) {
      var rest = a.topCats.slice(6).reduce(function(s, c) { return s + c.sum; }, 0);
      if (rest > 0) topForDonut.push({ name: 'Otros', value: rest, color: PALETA[9] });
    }
    html += '<div class="donut-wrap"><div class="donut">' +
            _bancoPDFDonutChart(topForDonut, 200, 0.58) +
            '</div><div class="legend">';
    var total = topForDonut.reduce(function(s, x) { return s + x.value; }, 0);
    topForDonut.forEach(function(item) {
      var pct = total > 0 ? Math.round((item.value / total) * 100) : 0;
      // Swatch como SVG inline — los PDF viewers renderean el fill garantizado.
      // Los table-cells con background-color a veces se ignoran en la conversión.
      var swatch = '<svg width="14" height="14" xmlns="http://www.w3.org/2000/svg">' +
                   '<rect width="14" height="14" rx="3" ry="3" fill="' + item.color + '"/></svg>';
      html += '<div class="item">' +
              '<div class="swatch">' + swatch + '</div>' +
              '<div class="lname">' + item.name + '<br><span style="font-size:10px;color:#6b7280;">' + pct + '%</span></div>' +
              '<div class="lval">' + fmtShort(item.value) + '</div></div>';
    });
    html += '</div></div></div>';
  }

  // ── DESGLOSE #1 y #2 — barras horizontales grandes ──
  if (a.topCatDesgloses && a.topCatDesgloses.length) {
    html += '<div class="section"><h2>¿A dónde se va la plata?</h2>';
    a.topCatDesgloses.forEach(function(d, idx) {
      if (!d.top || !d.top.length) return;
      var rank = idx === 0 ? '#1' : '#2';
      html += '<h3><span class="pill">' + rank + '</span>' + _bancoCatLabel(d.cat) + '  <span style="color:#9ca3af;font-weight:500;font-size:14px;">· ' + fmtShort(d.sum) + '</span></h3>';
      var maxD = d.top[0].sum;
      d.top.forEach(function(item) {
        var pctIt = d.sum > 0 ? Math.round((item.sum / d.sum) * 100) : 0;
        var w = Math.round((item.sum / maxD) * 100);
        html += '<div class="bar-row"><div class="blabel">' + _bancoEscapeHTML(item.name) + '</div>' +
                '<div class="bouter"><div class="bfill" style="width:' + w + '%;"></div></div>' +
                '<div class="bvalue">' + fmtShort(item.sum) + ' (' + pctIt + '%)</div></div>';
      });
    });
    html += '</div>';
  }

  // ── TENDENCIA MENSUAL — bar chart vertical SVG + insights ──
  if (a.historial && a.historial.length >= 2) {
    html += '<div class="section"><h2>Tendencia mensual</h2>';
    var meses = a.historial.map(function(h) {
      return {
        label:    _bancoMesLabelFull(h.yearMonth).substring(0, 3),
        value:    h.totalOut,
        parcial:  h.parcial,
      };
    });
    html += _bancoPDFBarChartVertical(meses, 480, 240);

    // Insights del período — números clave que enriquecen la gráfica:
    // promedio, mes más alto/bajo, variación, tendencia direccional.
    var ins = _bancoPDFComputarInsightsTendencia(a.historial);
    if (ins) {
      html += '<div class="cards-grid" style="margin-top:14px;">';
      // Primera fila: promedio + variación
      html += '<div class="row">';
      html += '<div class="card" style="background:#fef3c7;color:#78350f;"><div class="label">Promedio mensual</div>' +
              '<div class="value">' + ins.promedioStr + '</div><div class="note">de gasto</div></div>';
      html += '<div class="card" style="background:#dbeafe;color:#1e3a8a;"><div class="label">Variación</div>' +
              '<div class="value">' + ins.variacionStr + '</div><div class="note">entre mayor y menor</div></div>';
      html += '</div>';
      // Segunda fila: mes más caro + más barato
      html += '<div class="row">';
      html += '<div class="card red"><div class="label">Mes más caro</div>' +
              '<div class="value">' + ins.maxStr + '</div><div class="note">' + ins.maxLabel + ' · ' + ins.maxDeltaStr + ' vs promedio</div></div>';
      html += '<div class="card green"><div class="label">Mes más barato</div>' +
              '<div class="value">' + ins.minStr + '</div><div class="note">' + ins.minLabel + ' · ' + ins.minDeltaStr + ' vs promedio</div></div>';
      html += '</div>';
      html += '</div>';

      // Lectura direccional
      html += '<div class="insight" style="margin-top:14px;"><div class="ttl">' +
              ins.tendenciaIcon + ' Tendencia: ' + ins.tendenciaLabel + '</div>' +
              '<div class="body">' + ins.tendenciaBody + '</div></div>';
    }
    html += '</div>';
  }

  html += '<div class="page-break"></div>';

  // ── HEADER página 3 ──
  html += '<div class="header">' + logoSVG +
          '<div><div class="brand">Balance<span class="bc">Clip</span></div>' +
          '<div class="tagline">REPORTE · ACCIONES Y DEDUCIBLES</div></div>' +
          '<div class="meta">Página<strong>4 de 4</strong></div></div>';

  if (a.form90 && a.form90.length) {
    html += '<div class="section"><h2>Deducibles Form 90 (DGI Panamá)</h2>';
    html += '<table class="table"><tr><th>Categoría</th><th>Línea</th><th style="text-align:right;">Monto</th></tr>';
    a.form90.forEach(function(f) {
      html += '<tr><td>' + f.label + '</td><td>' + f.linea + '</td><td class="amount">' + fmt(f.sum) + '</td></tr>';
    });
    html += '</table>';
    html += '<div style="font-size:13px;color:#6b7280;margin-top:12px;font-style:italic;">Registrá estos gastos como deducibles en tu app de ContaFacil para bajar tu ISR.</div>';
    html += '</div>';
  }

  if (a.suscripciones && a.suscripciones.length) {
    html += '<div class="section"><h2>Suscripciones recurrentes detectadas</h2>';
    html += '<table class="table"><tr><th>Merchant</th><th style="text-align:center;">Cargos</th><th style="text-align:right;">Promedio/mes</th></tr>';
    a.suscripciones.forEach(function(s) {
      html += '<tr><td>' + _bancoEscapeHTML(s.merchant) + '</td><td style="text-align:center;">' + s.count + '</td><td class="amount">' + fmt(s.avg) + '</td></tr>';
    });
    html += '</table></div>';
  }

  var pasos = _bancoPDFComputarPasos(a, ahorro);
  if (pasos.length) {
    html += '<div class="section"><h2>Próximos pasos recomendados</h2>';
    pasos.forEach(function(p) { html += '<div class="step">' + p + '</div>'; });
    html += '</div>';
  }

  html += '<div class="footer">';
  html += 'Generado por <strong>BalanceClip</strong> · <a href="https://balanceclip.net">balanceclip.net</a><br>';
  html += 'Análisis automatizado de tu cuenta — esto es orientación general.<br>Para temas fiscales específicos, consultá con tu contador.';
  html += '</div>';

  html += '</body></html>';
  return html;
}

// Genera un donut chart SVG. items: [{name, value, color}].
// hole: ratio del agujero interno (0.5 = donut clásico, 0 = pie).
function _bancoPDFDonutChart(items, size, hole) {
  var cx = size / 2, cy = size / 2;
  var r  = size / 2 * 0.92;
  var ir = r * (hole || 0);
  var total = items.reduce(function(s, x) { return s + x.value; }, 0);
  if (total <= 0) return '';
  var startAngle = -Math.PI / 2;  // arrancar arriba
  var slices = '';
  items.forEach(function(item) {
    var pct = item.value / total;
    if (pct <= 0) return;
    var sweep = pct * 2 * Math.PI;
    var endAngle = startAngle + sweep;
    var x1 = cx + r * Math.cos(startAngle), y1 = cy + r * Math.sin(startAngle);
    var x2 = cx + r * Math.cos(endAngle),   y2 = cy + r * Math.sin(endAngle);
    var largeArc = sweep > Math.PI ? 1 : 0;
    var d;
    if (ir > 0) {
      var ix1 = cx + ir * Math.cos(startAngle), iy1 = cy + ir * Math.sin(startAngle);
      var ix2 = cx + ir * Math.cos(endAngle),   iy2 = cy + ir * Math.sin(endAngle);
      d = 'M ' + x1.toFixed(2) + ',' + y1.toFixed(2) +
          ' A ' + r.toFixed(2) + ',' + r.toFixed(2) + ' 0 ' + largeArc + ' 1 ' + x2.toFixed(2) + ',' + y2.toFixed(2) +
          ' L ' + ix2.toFixed(2) + ',' + iy2.toFixed(2) +
          ' A ' + ir.toFixed(2) + ',' + ir.toFixed(2) + ' 0 ' + largeArc + ' 0 ' + ix1.toFixed(2) + ',' + iy1.toFixed(2) + ' Z';
    } else {
      d = 'M ' + cx + ',' + cy + ' L ' + x1.toFixed(2) + ',' + y1.toFixed(2) +
          ' A ' + r.toFixed(2) + ',' + r.toFixed(2) + ' 0 ' + largeArc + ' 1 ' + x2.toFixed(2) + ',' + y2.toFixed(2) + ' Z';
    }
    slices += '<path d="' + d + '" fill="' + item.color + '" stroke="#fff" stroke-width="2"/>';
    startAngle = endAngle;
  });
  // Total en el centro (para donuts)
  var center = '';
  if (ir > 0) {
    center = '<text x="' + cx + '" y="' + (cy - 4) + '" text-anchor="middle" font-family="Helvetica" font-size="14" fill="#6b7280" font-weight="600">TOTAL</text>' +
             '<text x="' + cx + '" y="' + (cy + 22) + '" text-anchor="middle" font-family="Helvetica" font-size="26" fill="#1f2937" font-weight="900">$' + Math.round(total).toLocaleString('en-US') + '</text>';
  }
  return '<svg width="100%" viewBox="0 0 ' + size + ' ' + size + '" xmlns="http://www.w3.org/2000/svg" style="max-width:240px;">' +
         slices + center + '</svg>';
}

// Genera un bar chart vertical SVG con etiquetas. items: [{label, value, parcial?}].
function _bancoPDFBarChartVertical(items, width, height) {
  if (!items || !items.length) return '';
  var max = Math.max.apply(null, items.map(function(x) { return x.value; }));
  if (!max) return '';
  var padT = 28, padB = 50, padL = 50, padR = 14;
  var chartW = width - padL - padR;
  var chartH = height - padT - padB;
  var n = items.length;
  var step = chartW / n;
  var barW = Math.min(step * 0.66, 56);
  // Eje Y con 4 ticks
  var ticks = '';
  for (var t = 0; t <= 4; t++) {
    var val = max * (1 - t / 4);
    var y = padT + (chartH * t / 4);
    ticks += '<line x1="' + padL + '" y1="' + y.toFixed(2) + '" x2="' + (width - padR) + '" y2="' + y.toFixed(2) + '" stroke="#e5e7eb" stroke-width="1"/>';
    ticks += '<text x="' + (padL - 8) + '" y="' + (y + 4) + '" text-anchor="end" font-family="Helvetica" font-size="11" fill="#9ca3af">$' + Math.round(val).toLocaleString('en-US') + '</text>';
  }
  // Bars
  var bars = '';
  items.forEach(function(item, i) {
    var h = (item.value / max) * chartH;
    var x = padL + step * i + (step - barW) / 2;
    var y = padT + chartH - h;
    var fill = item.parcial ? 'url(#barGradParcial)' : 'url(#barGrad)';
    bars += '<rect x="' + x.toFixed(2) + '" y="' + y.toFixed(2) + '" width="' + barW.toFixed(2) + '" height="' + h.toFixed(2) + '" fill="' + fill + '" rx="4"/>';
    bars += '<text x="' + (x + barW/2).toFixed(2) + '" y="' + (y - 6).toFixed(2) + '" text-anchor="middle" font-family="Helvetica" font-size="12" fill="#1f2937" font-weight="700">$' + Math.round(item.value).toLocaleString('en-US') + '</text>';
    bars += '<text x="' + (x + barW/2).toFixed(2) + '" y="' + (padT + chartH + 22).toFixed(2) + '" text-anchor="middle" font-family="Helvetica" font-size="13" fill="#374151" font-weight="600">' + item.label + (item.parcial ? '*' : '') + '</text>';
  });
  var footnote = '';
  if (items.some(function(x) { return x.parcial; })) {
    footnote = '<text x="' + padL + '" y="' + (height - 4) + '" font-family="Helvetica" font-size="11" fill="#9ca3af" font-style="italic">* mes parcial</text>';
  }
  return '<svg width="100%" viewBox="0 0 ' + width + ' ' + height + '" xmlns="http://www.w3.org/2000/svg" style="max-width:100%;">' +
         '<defs>' +
         '<linearGradient id="barGrad" x1="0%" y1="0%" x2="0%" y2="100%">' +
         '<stop offset="0%" stop-color="#fb923c"/><stop offset="100%" stop-color="#ea580c"/></linearGradient>' +
         '<linearGradient id="barGradParcial" x1="0%" y1="0%" x2="0%" y2="100%">' +
         '<stop offset="0%" stop-color="#fed7aa"/><stop offset="100%" stop-color="#fdba74"/></linearGradient>' +
         '</defs>' +
         ticks + bars + footnote +
         '</svg>';
}

// Computa los 4 indicadores del semáforo para el PDF.
function _bancoPDFComputarSemaforo(a, ahorro) {
  var rows = [];
  // 1. Ahorro
  if (ahorro >= 15)      rows.push({ label: 'Ahorro', valor: ahorro + '%', color: 'green', comentario: 'Saludable' });
  else if (ahorro >= 5)  rows.push({ label: 'Ahorro', valor: ahorro + '%', color: 'yellow', comentario: 'Aceptable' });
  else if (ahorro >= 0)  rows.push({ label: 'Ahorro', valor: ahorro + '%', color: 'yellow', comentario: 'Justo al límite' });
  else                   rows.push({ label: 'Ahorro', valor: ahorro + '%', color: 'red', comentario: 'Déficit' });

  // 2. Concentración top cat consumo
  var CATS_NO = ['ach_salida', 'yappy_salida', 'pago_tarjeta'];
  var topConsumo = (a.topCats || []).filter(function(c) { return CATS_NO.indexOf(c.cat) < 0; })[0];
  if (topConsumo && a.totalOut > 0) {
    var pct = Math.round((topConsumo.sum / a.totalOut) * 100);
    if (pct >= 40)       rows.push({ label: 'Concentración', valor: pct + '%', color: 'red', comentario: _bancoCatPlain(topConsumo.cat) + ' alta' });
    else if (pct >= 25)  rows.push({ label: 'Concentración', valor: pct + '%', color: 'yellow', comentario: 'Aceptable' });
    else                 rows.push({ label: 'Concentración', valor: pct + '%', color: 'green', comentario: 'Diversa' });
  }

  // 3. Tendencia saldo
  if (a.deltaSaldo != null) {
    if (a.deltaSaldo > 50)        rows.push({ label: 'Tendencia', valor: '↗', color: 'green', comentario: 'Saldo subiendo' });
    else if (a.deltaSaldo >= -50) rows.push({ label: 'Tendencia', valor: '~', color: 'yellow', comentario: 'Estable' });
    else                          rows.push({ label: 'Tendencia', valor: '↘', color: 'red', comentario: 'Saldo bajando' });
  }

  // 4. Runway
  if (a.saldoFin != null && a.dias > 0 && a.totalOut > 0) {
    var diario = a.totalOut / a.dias;
    var runway = diario > 0 ? Math.floor(a.saldoFin / diario) : 999;
    if (runway >= 30)      rows.push({ label: 'Runway', valor: runway + 'd', color: 'green', comentario: '30+ días' });
    else if (runway >= 15) rows.push({ label: 'Runway', valor: runway + 'd', color: 'yellow', comentario: 'Colchón medio' });
    else                   rows.push({ label: 'Runway', valor: runway + 'd', color: 'red', comentario: '< 15 días' });
  }
  return rows;
}

// Hallazgos accionables para el PDF (similar a oportunidad pero ampliado).
function _bancoPDFComputarHallazgos(a, ahorro) {
  var fmt = function(n) { return '$' + Number(n).toFixed(0); };
  var out = [];
  if (a.suscripciones && a.suscripciones.length) {
    var subTot = a.suscripciones.reduce(function(s, x) { return s + x.avg; }, 0);
    out.push({
      titulo: '🔁 ' + a.suscripciones.length + ' suscripción(es) recurrente(s) ≈ ' + fmt(subTot) + '/mes',
      body:   'Top: ' + a.suscripciones[0].merchant + '. Auditá las que no usás — cancelar las olvidadas es la victoria más rápida.',
    });
  }
  if (a.pequenos && a.pequenos.count >= 10) {
    var anual = a.dias > 0 ? (a.pequenos.suma / a.dias) * 365 : 0;
    if (anual >= 200) {
      out.push({
        titulo: '☕ ' + a.pequenos.count + ' compras chicas < $10 = ' + fmt(a.pequenos.suma),
        body:   'Proyección anual ' + fmt(anual) + '. Bajándolas 50% ahorrás ' + fmt(anual / 2) + ' al año.',
      });
    }
  }
  if (a.topMerchant && a.topMerchant.sum >= 100 && a.totalOut > 0) {
    var pct = Math.round((a.topMerchant.sum / a.totalOut) * 100);
    out.push({
      titulo: '🏆 Top merchant: ' + a.topMerchant.name + ' · ' + fmt(a.topMerchant.sum) + ' (' + pct + '%)',
      body:   'Evaluá si hay alternativa más barata o si es un gasto discrecional reducible.',
    });
  }
  if (a.form90 && a.form90.length) {
    var f90sum = a.form90.reduce(function(s, x) { return s + x.sum; }, 0);
    out.push({
      titulo: '💡 Posibles deducibles Form 90 detectados: ' + fmt(f90sum),
      body:   'Registralos en tu ContaFacil como gastos personales deducibles — bajan tu ISR del año.',
    });
  }
  return out.slice(0, 4);
}

// Insights del período para acompañar la gráfica de tendencia mensual.
// Devuelve null si no hay suficiente data (necesita ≥2 meses).
function _bancoPDFComputarInsightsTendencia(historial) {
  if (!historial || historial.length < 2) return null;
  var fmtShort = function(n) {
    if (!isFinite(n)) return '$0';
    return Math.abs(n) < 5 ? '$' + n.toFixed(2) : '$' + Math.round(n).toLocaleString('en-US');
  };
  var values = historial.map(function(h) { return h.totalOut; });
  var labels = historial.map(function(h) { return _bancoMesLabelFull(h.yearMonth); });
  var n = values.length;
  var sum = values.reduce(function(s, v) { return s + v; }, 0);
  var promedio = sum / n;
  var maxIdx = 0, minIdx = 0;
  for (var i = 1; i < n; i++) {
    if (values[i] > values[maxIdx]) maxIdx = i;
    if (values[i] < values[minIdx]) minIdx = i;
  }
  var max = values[maxIdx], min = values[minIdx];
  var variacion = promedio > 0 ? Math.round(((max - min) / promedio) * 100) : 0;
  var maxDeltaPct = promedio > 0 ? Math.round(((max - promedio) / promedio) * 100) : 0;
  var minDeltaPct = promedio > 0 ? Math.round(((min - promedio) / promedio) * 100) : 0;

  // Tendencia direccional: comparar promedio de últimos 3 (o todos si <3)
  // vs promedio de primeros 3 (o todos si <3).
  var k = Math.min(3, Math.floor(n / 2));
  if (k < 1) k = 1;
  var firstK = values.slice(0, k).reduce(function(s, v) { return s + v; }, 0) / k;
  var lastK  = values.slice(-k).reduce(function(s, v) { return s + v; }, 0) / k;
  var tendDelta = firstK > 0 ? ((lastK - firstK) / firstK) * 100 : 0;
  var tendenciaIcon, tendenciaLabel, tendenciaBody;
  if (tendDelta > 10) {
    tendenciaIcon = '📈';
    tendenciaLabel = 'subiendo';
    tendenciaBody = 'Tus gastos vienen creciendo: ' + Math.round(tendDelta) + '% más en los últimos ' + k + ' meses vs los primeros ' + k + '. Vale la pena revisar qué categoría se está expandiendo.';
  } else if (tendDelta < -10) {
    tendenciaIcon = '📉';
    tendenciaLabel = 'bajando';
    tendenciaBody = 'Tus gastos vienen reduciendo: ' + Math.round(Math.abs(tendDelta)) + '% menos en los últimos ' + k + ' meses vs los primeros ' + k + '. Seguí así.';
  } else {
    tendenciaIcon = '➡️';
    tendenciaLabel = 'estable';
    tendenciaBody = 'Tus gastos mensuales se mantienen relativamente parejos (variación <10% entre primeros y últimos meses). Consistencia financiera.';
  }

  return {
    promedioStr:   fmtShort(promedio),
    variacionStr:  variacion + '%',
    maxStr:        fmtShort(max),
    maxLabel:      labels[maxIdx],
    maxDeltaStr:   (maxDeltaPct >= 0 ? '+' : '') + maxDeltaPct + '%',
    minStr:        fmtShort(min),
    minLabel:      labels[minIdx],
    minDeltaStr:   (minDeltaPct >= 0 ? '+' : '') + minDeltaPct + '%',
    tendenciaIcon: tendenciaIcon,
    tendenciaLabel: tendenciaLabel,
    tendenciaBody: tendenciaBody,
  };
}

// Próximos pasos para el PDF (checklist más rico que el del Excel).
function _bancoPDFComputarPasos(a, ahorro) {
  var pasos = [];
  if (a.suscripciones && a.suscripciones.length) {
    pasos.push('Auditar las suscripciones detectadas — cancelar las que no usás (impacto inmediato en gasto mensual).');
  }
  if (a.form90 && a.form90.length) {
    pasos.push('Registrar los gastos médicos / educativos / seguros detectados como deducibles en ContaFacil (Form 90 DGI Panamá).');
  }
  if (ahorro < 10) {
    pasos.push('Apartar el ahorro al INICIO del mes (no al final). Apuntá a 15%+ del ingreso bruto.');
  }
  if (a.pequenos && a.pequenos.count >= 10) {
    pasos.push('Identificar las 3-5 categorías de gastos chicos más frecuentes y cortarlas al 50% — atacan el "death by a thousand cuts".');
  }
  if (a.deltaSaldo != null && a.deltaSaldo < -50) {
    pasos.push('Tu saldo bajó en el período — revisar cargos grandes uno por uno y crear un colchón mínimo de emergencia (1 mes de gastos).');
  }
  pasos.push('Volvé a subir un nuevo estado de cuenta el mes que viene para comparar evolución y ver si los cambios surtieron efecto.');
  return pasos;
}

// Escape básico de HTML para nombres de destinatarios.
function _bancoEscapeHTML(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ════════════════════════════════════════════════════════════════════
//  PURGA DE HISTORIAL (Banco_Historico) — retención 24 meses
//  ──────────────────────────────────────────────────────────────────
//  Cumple la política de privacidad pública:
//    "Agregados mensuales … Hasta 24 meses, exclusivamente para
//     mostrarte evolución y tendencias en tus análisis posteriores."
//
//  Borra filas cuya year_month es anterior a (hoy − 24 meses). Hace
//  delete real de las rows del sheet (no anonimización), porque la
//  columna `phone` es PII identificable.
//
//  Trigger: mensual el primer día (instalar con
//  _installPurgaHistorialTrigger desde el editor).
// ════════════════════════════════════════════════════════════════════

function purgarBancoHistorialAntiguo() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sh = ss.getSheetByName(_BANCO_SHEET);
  if (!sh) { Logger.log('Purga historial: sheet no existe'); return { borradas: 0 }; }
  var last = sh.getLastRow();
  if (last < 2) { Logger.log('Purga historial: sin filas'); return { borradas: 0 }; }

  // Cutoff: hoy menos 24 meses. Comparamos como string "YYYY-MM" porque
  // así están guardados los year_month.
  var hoy = new Date();
  var cutoffDate = new Date(hoy.getFullYear(), hoy.getMonth() - 24, 1);
  var cutoff = Utilities.formatDate(cutoffDate, 'America/Panama', 'yyyy-MM');

  // Leer columna B (year_month) de todas las filas
  var values = sh.getRange(2, 1, last - 1, 2).getValues();
  var toDelete = [];   // rows 2-based a borrar
  for (var i = 0; i < values.length; i++) {
    var ym = _bancoNormalizarYM(values[i][1]);
    if (!ym) continue;
    if (ym < cutoff) toDelete.push(i + 2);  // +2 = 1 por header + 1 por base
  }

  // Borrar de abajo hacia arriba para no shiftear índices
  toDelete.sort(function(a, b) { return b - a; });
  toDelete.forEach(function(rowNum) {
    sh.deleteRow(rowNum);
  });

  Logger.log('🧹 Purga Banco_Historico: ' + toDelete.length +
             ' filas borradas (cutoff ' + cutoff + ')');
  return { borradas: toDelete.length, cutoff: cutoff };
}

// Instalador del trigger mensual. Ejecutar UNA VEZ desde el editor de
// cada cliente GAS (es per-client porque cada cliente tiene su propio
// Banco_Historico en su spreadsheet).
function _installPurgaHistorialTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'purgarBancoHistorialAntiguo') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  // Mensual, día 1, a las 3 AM hora Panamá
  ScriptApp.newTrigger('purgarBancoHistorialAntiguo')
    .timeBased()
    .onMonthDay(1)
    .atHour(3)
    .create();
  Logger.log('✓ Trigger instalado: purgarBancoHistorialAntiguo mensual día 1 @ 3 AM');
}
