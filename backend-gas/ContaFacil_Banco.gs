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
  // Privacy: solo guardamos totales mensuales agregados (totales por cat
  // como JSON), nunca movimientos individuales. Idempotente: re-subir
  // el mismo período sobreescribe sus rows.
  var historial = [];
  try {
    _bancoPersistirMensual(from, movs, categorias);
    historial = _bancoLeerHistorial(from);
    Logger.log('Banco historial: ' + historial.length + ' meses para phone=' + from);
  } catch(err) {
    Logger.log('Banco historial error: ' + err.message + ' stack=' + (err.stack || ''));
  }
  analisis.historial = historial;

  // Cachear el análisis crudo (movs + categorias + historial) por 30 min
  // para que el usuario pueda pedir drill-downs vía texto sin reenviar
  // el archivo. La data del banco NO va a un sheet persistente — solo
  // CacheService (TTL automático, no buscable, scope del script).
  try { _bancoCacheAnalisis(from, movs, categorias, historial); }
  catch(err) { Logger.log('Banco cache error: ' + err.message); }

  var msgText  = _bancoFormatearMensaje(analisis);
  _whatsappReply(from, msgText, token, phoneId);
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
  var prompt =
    'Eres un clasificador de movimientos bancarios panameños. Te paso una lista NUMERADA de descripciones.\n\n' +
    'Para CADA línea, devolveme la categoría más probable. Categorías válidas:\n\n' +
    '  comida           — restaurantes, café (Kotowa, Starbucks, McDonalds), supermercado pequeño, delivery (UBER EATS, PEDIDOSYA, RAPPI)\n' +
    '  transporte       — UBER RIDES (NO Eats), taxi, gasolinera (TERPEL, PUMA, DELTA), peaje, parking\n' +
    '  telco            — Más Móvil, +Móvil, Tigo, Cable Onda, internet, celular\n' +
    '  servicios        — luz (ENSA), agua (IDAAN), gas, electricidad\n' +
    '  entretenimiento  — Netflix, Spotify, Disney+, HBO, Twitch, CINEPOLIS, cine\n' +
    '  ads              — Facebook Ads (FACEBK), Google Ads (GOOGL), TikTok ads\n' +
    '  yappy_salida     — YAPPY BG A <nombre> (vos mandando)\n' +
    '  yappy_entrada    — YAPPY BG DE <nombre> (vos recibiendo)\n' +
    '  ach_salida       — BANCA MOVIL TRANSFERENCIA A, ACH/transferencia saliente, PAGO ACH\n' +
    '  ach_entrada      — ACH entrante, DEPOSITO, ABONO, deposito cuenta\n' +
    '  retiro_atm       — RETIRO CAJERO, ATM\n' +
    '  pago_tarjeta     — PAGO TARJETA CRÉDITO\n' +
    '  prestamo         — pago préstamo, cuota leasing\n' +
    '  seguro           — Assa, Mapfre, Pan-American, prima seguro\n' +
    '  educacion        — colegio, universidad (USMA, ULACIT, UTP), matrícula\n' +
    '  salud            — farmacia (Arrocha, MetroFarma), médico, clínica, hospital\n' +
    '  belleza          — peluquería, barbería, spa, salón, Kevins Studio\n' +
    '  comercio         — PriceSmart, Super 99, Riba Smith, Xtra, El Machetazo\n' +
    '  ropa             — Zara, H&M, almacenes, tiendas de ropa\n' +
    '  hospedaje        — agoda, booking, hoteles, airbnb\n' +
    '  comision_banco   — cargos del banco, comisión, ITBMS bancario\n' +
    '  otro             — todo lo demás\n\n' +
    'FORMATO de RESPUESTA: una línea por entrada con "N=categoria". Sin comentarios, sin explicaciones, sin markdown.\n\n' +
    'Ejemplo:\n' +
    '  1=transporte\n' +
    '  2=comida\n' +
    '  3=telco\n\n' +
    'DESCRIPCIONES:\n' +
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
    topMerchant: topMerchant,
    topYappyOut: topYappyOut, topYappyIn: topYappyIn,
    suscripciones: suscripciones.slice(0, 5),
    pequenos: { count: pequenos.length, suma: sumaPequenos },
    form90: form90,
    flags: flags,
  };
}

function _bancoFmtDolar(n) { return '$' + (isFinite(n) ? Number(n).toFixed(2) : '0.00'); }

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
  var pct = function(part, whole) { return whole > 0 ? Math.round((part / whole) * 100) : 0; };
  var fechaStr = function(d) {
    return d ? Utilities.formatDate(d, 'America/Panama', 'd MMM') : '—';
  };

  var ahorro = a.totalIn > 0 ? Math.round((a.neto / a.totalIn) * 100) : 0;
  var msg = '📊 *Análisis de movimientos*\n';
  msg += '_' + fechaStr(a.inicio) + ' – ' + fechaStr(a.fin) + ' · ' + a.dias + ' días · ' + a.nMovs + ' movs_\n\n';

  // Saldo — contexto absoluto. "Ahorraste $X" sin saber el saldo
  // miente: capaz tenés balance bajando hacia 0.
  if (a.saldoIni != null && a.saldoFin != null) {
    var arrow = a.deltaSaldo >= 0 ? '↗' : '↘';
    var sign  = a.deltaSaldo >= 0 ? '+' : '−';
    msg += '*Saldo*\n💵 ' + fmt(a.saldoIni) + ' ' + arrow + ' ' + fmt(a.saldoFin) +
           ' (' + sign + fmt(Math.abs(a.deltaSaldo)) + ')\n\n';
  }

  msg += '*Flujo*\n';
  msg += '✅ Ingresaste: ' + fmt(a.totalIn) + '\n';
  msg += '❌ Gastaste:    ' + fmt(a.totalOut) + '\n';
  msg += (a.neto >= 0 ? '💰 Ahorrado:   ' : '⚠️ Déficit:    ') +
         fmt(Math.abs(a.neto)) +
         (a.totalIn > 0 ? ' (' + (ahorro >= 0 ? '+' : '') + ahorro + '%)' : '') + '\n\n';

  // Banderas de salud — destacadas para que se vean primero.
  if (a.flags && a.flags.length) {
    msg += '*Atención*\n';
    a.flags.forEach(function(f) { msg += f + '\n'; });
    msg += '\n';
  }

  // Form 90 — match único de ContaFacil. Mostrar arriba del fold.
  if (a.form90 && a.form90.length) {
    msg += '💡 *Posibles deducibles · Form 90*\n';
    a.form90.forEach(function(f) {
      msg += '   • ' + f.label + ' (' + f.linea + '): ' + fmt(f.sum) + '\n';
      if (f.nota) msg += '     ' + f.nota + '\n';
    });
    msg += '_Si son personales, registralos como gasto deducible en tu app._\n\n';
  }

  // Top merchant — punzante, dato accionable.
  if (a.topMerchant && a.topMerchant.sum >= 5) {
    var pctMerch = pct(a.topMerchant.sum, a.totalOut);
    msg += '🏆 *Tu gasto más grande:* ' + a.topMerchant.name +
           ' ' + fmt(a.topMerchant.sum) +
           (pctMerch > 0 ? ' (' + pctMerch + '%)' : '') + '\n\n';
  }

  if (a.topCats.length) {
    msg += '*Top categorías de gasto*\n';
    msg += '```\n' + _bancoBarsCategorias(a.topCats, a.totalOut) + '```\n\n';
  }

  // Tendencia mensual + deltas — solo si hay ≥2 meses de historial
  // (caso contrario no aporta nada nuevo vs el bloque de Flujo).
  if (a.historial && a.historial.length >= 2) {
    msg += '*📈 Tendencia mensual*\n';
    msg += '```\n' + _bancoBarsTendencia(a.historial) + '```\n';
    var deltas = _bancoComputarDeltasMesAnt(a.historial);
    if (deltas && deltas.length) {
      var d0 = deltas[0];
      // Si el mes actual está parcial, advertirlo en el header — comparar
      // 11 días vs un mes completo da % engañosos sin esta nota.
      var parcialNote = d0.curParcial ? ' (parcial)' : '';
      msg += '\n*' + d0.label + parcialNote + ' vs ' + d0.prevLabel + '*\n';
      msg += '```\n' + _bancoBarsDeltas(d0.cats) + '```\n';
    }
    msg += '\n';
  }

  if (a.topYappyOut.length || a.topYappyIn.length) {
    msg += '*Yappys*\n';
    if (a.topYappyOut.length) {
      msg += '💸 Le mandaste a:\n';
      a.topYappyOut.forEach(function(y) { msg += '   • ' + y.name + ': ' + fmt(y.sum) + '\n'; });
    }
    if (a.topYappyIn.length) {
      msg += '💰 Recibiste de:\n';
      a.topYappyIn.forEach(function(y) { msg += '   • ' + y.name + ': ' + fmt(y.sum) + '\n'; });
    }
    msg += '\n';
  }

  if (a.suscripciones.length) {
    msg += '🔁 *Cargos recurrentes detectados*\n';
    a.suscripciones.forEach(function(s) {
      msg += '   • ' + s.merchant + ': ' + fmt(s.avg) + ' (' + s.count + 'x)\n';
    });
    msg += '_Revisalos — quizás hay suscripciones olvidadas._\n\n';
  }

  if (a.pequenos.count >= 5) {
    msg += '☕ *Gastos chicos que suman*\n';
    msg += a.pequenos.count + ' compras < $10 = ' + fmt(a.pequenos.suma) + '\n';
    var anual = a.dias > 0 ? (a.pequenos.suma / a.dias) * 365 : 0;
    if (anual > 100) {
      msg += '_Al ritmo actual, esos chicos te cuestan ~' + fmt(anual) + ' al año._\n';
    }
    msg += '\n';
  }

  msg += '📈 _Mandame el del próximo mes y te muestro cómo evolucionaste._\n';
  msg += '💡 _Tip: respondé `ver <categoría o mes>` para detalle, `excel` para descargar la data,_\n';
  msg += '   _o preguntame cualquier cosa sobre tus finanzas (ej: "¿cuánto debería ahorrar?",_\n';
  msg += '   _"¿es alto mi gasto en comida?", "¿cómo bajo los gastos chicos?")._';

  return msg.substring(0, 4000);  // WhatsApp text cap
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
function _bancoBarsTendencia(historial) {
  if (!historial || !historial.length) return '';
  // historial viene ordenado de más viejo a más nuevo
  var max = Math.max.apply(null, historial.map(function(h) { return h.totalOut; }));
  return historial.map(function(h, i) {
    var bar = _bancoBar(h.totalOut, max);
    var arrow = '';
    if (i > 0) {
      var prev = historial[i-1].totalOut;
      if (prev > 0) {
        if (h.totalOut > prev * 1.05)      arrow = ' ↗';
        else if (h.totalOut < prev * 0.95) arrow = ' ↘';
      }
    }
    var label = _bancoMesLabel(h.yearMonth);
    var parcial = h.parcial ? ' parcial' : '';
    return label + ' ' + bar + ' ' + _bancoFmtDolar(h.totalOut) + arrow + parcial;
  }).join('\n') + '\n';
}

// Render de deltas entre el último mes y el anterior — cat por cat
function _bancoBarsDeltas(cats) {
  if (!cats || !cats.length) return '';
  return cats.map(function(c) {
    var name = _bancoPadCat(_bancoCatLabel(c.cat));
    var prev = _bancoFmtDolar(c.prev);
    var cur  = _bancoFmtDolar(c.cur);
    var arrow, sign;
    if (c.deltaPct === null) { arrow = '🆕'; sign = ''; }
    else if (c.deltaPct > 5)  { arrow = '↗'; sign = '+' + Math.round(c.deltaPct) + '%'; }
    else if (c.deltaPct < -5) { arrow = '↘'; sign = Math.round(c.deltaPct) + '%'; }
    else                      { arrow = '='; sign = ''; }
    return name + ' ' + prev + ' → ' + cur + '  ' + arrow + ' ' + sign;
  }).join('\n') + '\n';
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
      return { fecha: new Date(m.f), monto: m.m, descripcion: m.d, cat: m.c };
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
  // "excel" o "ver excel" / "descargar excel" — comando de export
  if (/^(ver\s+|descargar\s+)?excel\b/.test(t) || /^(ver\s+|descargar\s+)?xlsx\b/.test(t)) {
    return { type: 'excel' };
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
      'Mandame el xlsx del banco otra vez y después podés pedir drill-downs.',
      token, phoneId);
    return;
  }
  var msg = '';
  if (intent.type === 'cat')        msg = _bancoRenderDrillCat(cache, intent.cat);
  else if (intent.type === 'month') msg = _bancoRenderDrillMes(cache, intent.ym);
  else if (intent.type === 'cross') msg = _bancoRenderDrillCross(cache, intent.cat, intent.ym);
  else if (intent.type === 'excel') { _bancoExportarExcel(cache, from, token, phoneId); return; }
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

function _bancoExportarExcel(cache, from, token, phoneId) {
  _whatsappReply(from, '📥 Generando tu Excel, dame un momento…', token, phoneId);
  var tempId = null;
  try {
    var ss = SpreadsheetApp.create('analisis-' + Date.now());
    tempId = ss.getId();
    _bancoPoblarXlsx(ss, cache);
    var xlsxBlob = _bancoSheetToXlsxBlob(tempId);
    var fname = 'analisis-bancario-' + Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd') + '.xlsx';
    xlsxBlob.setName(fname);
    var mediaId = _bancoUploadMediaWA(xlsxBlob, fname, token, phoneId);
    _bancoSendDocumentWA(from, mediaId, fname, '📊 Tu análisis bancario completo', token, phoneId);
  } catch(err) {
    Logger.log('Banco excel export error: ' + err.message + ' ' + (err.stack || ''));
    _whatsappReply(from, '⚠️ No pude generar el Excel: ' + err.message, token, phoneId);
  } finally {
    if (tempId) {
      try { DriveApp.getFileById(tempId).setTrashed(true); } catch(e) {}
    }
  }
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

  // ─── Hoja 1: Resumen ────────────────────────────────────────
  var sh1 = ss.getActiveSheet();
  sh1.setName('Resumen');
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

  // Volver a poner Resumen al frente
  ss.setActiveSheet(sh1);
  SpreadsheetApp.flush();
}

// Pobla una hoja de detalle (cat o mes) con back-link al Resumen,
// título, total + un listado de los movimientos correspondientes.
function _bancoPoblarDetalleSheet(sh, title, movs, kind) {
  var total = movs.reduce(function(s, m) { return s + Math.abs(m.monto < 0 ? m.monto : 0); }, 0);
  var nMovs = movs.length;

  var rows = [
    ['=HYPERLINK("#\'Resumen\'!A1","← Volver al Resumen")', '', '', '', ''],
    ['', '', '', '', ''],
    [title, '', 'Total:', total, ''],
    ['', '', '# Movs:', nMovs, ''],
    ['', '', '', '', ''],
    ['Fecha','Monto','Tipo','Descripción','Categoría'],
  ];
  movs.slice().sort(function(a, b) { return b.fecha - a.fecha; }).forEach(function(m) {
    rows.push([m.fecha, m.monto, m.monto >= 0 ? 'Ingreso' : 'Gasto', m.descripcion, _bancoCatLabel(m.cat)]);
  });
  sh.getRange(1, 1, rows.length, 5).setValues(rows);
  sh.getRange(3, 1).setFontWeight('bold').setFontSize(13);
  sh.getRange(6, 1, 1, 5).setFontWeight('bold').setBackground('#F1F3F5');
  sh.setFrozenRows(6);
  sh.setColumnWidth(1, 110);
  sh.setColumnWidth(2, 90);
  sh.setColumnWidth(3, 80);
  sh.setColumnWidth(4, 380);
  sh.setColumnWidth(5, 180);
  // AutoFilter en el rango de datos
  try {
    var existingFilter = sh.getFilter();
    if (existingFilter) existingFilter.remove();
    if (rows.length > 6) sh.getRange(6, 1, rows.length - 5, 5).createFilter();
  } catch(e) { Logger.log('Banco detalle filter skip: ' + e.message); }
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
  // Termina en signo de pregunta (?) o empieza con palabra interrogativa
  if (/\?\s*$/.test(t)) return true;
  if (/^(que|cuanto|cuanta|cuantas|cuantos|como|cuando|donde|por que|porque|deberia|debo|puedo|conviene|es|son|hay|tengo|tenia|si yo|si dejo|si bajo)\b/.test(t)) return true;
  // Frases imperativas de consejo
  if (/^(consejo|asesorame|aconsejame|recomiendame|recomendacion|sugerencia|ayudame)\b/.test(t)) return true;
  return false;
}

function _bancoHandleAsesor(question, from, token, phoneId) {
  var cache = _bancoLoadCache(from);
  if (!cache) {
    // Sin cache, no podemos responder con contexto. El caller cae al
    // welcome estándar.
    return false;
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
  var byMonth = {};
  var yappyOut = {}, yappyIn = {};

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
    .sort(function(a, b) { return b.sum - a.sum; }).slice(0, 3);
  var topYI = Object.keys(yappyIn)
    .map(function(k) { return { name: k, sum: yappyIn[k] }; })
    .sort(function(a, b) { return b.sum - a.sum; }).slice(0, 3);

  var meses = Object.keys(byMonth).sort();
  var pequenos = movs.filter(function(m) { return m.monto < 0 && m.monto > -10; });
  var sumaPeq = pequenos.reduce(function(s, m) { return s + Math.abs(m.monto); }, 0);

  var ctx = '';
  ctx += 'RANGO: ' + meses[0] + ' a ' + meses[meses.length - 1] + ' (' + meses.length + ' meses, ' + movs.length + ' movs)\n';
  ctx += 'INGRESOS TOTALES: $' + totalIn.toFixed(2) + '\n';
  ctx += 'GASTOS TOTALES:   $' + totalOut.toFixed(2) + '\n';
  ctx += 'AHORRO NETO:      $' + (totalIn - totalOut).toFixed(2) + ' (' + (totalIn > 0 ? Math.round((totalIn - totalOut) / totalIn * 100) : 0) + '% del ingreso)\n\n';

  ctx += 'GASTO POR MES:\n';
  meses.forEach(function(ym) {
    ctx += '  ' + ym + ': ingreso $' + byMonth[ym].in.toFixed(0) + ', gasto $' + byMonth[ym].out.toFixed(0) + '\n';
  });
  ctx += '\nTOP CATEGORÍAS DE GASTO:\n';
  topCats.forEach(function(c) {
    ctx += '  ' + c.cat + ': $' + c.sum.toFixed(2) + ' (' + Math.round(c.sum / totalOut * 100) + '%)\n';
  });
  ctx += '\nTOP MERCHANTS:\n';
  topM.forEach(function(m) { ctx += '  ' + m.name + ': $' + m.sum.toFixed(2) + '\n'; });
  if (topYO.length) {
    ctx += '\nYAPPYS QUE MÁS ENVIASTE:\n';
    topYO.forEach(function(y) { ctx += '  a ' + y.name + ': $' + y.sum.toFixed(2) + '\n'; });
  }
  if (topYI.length) {
    ctx += '\nYAPPYS QUE MÁS RECIBISTE:\n';
    topYI.forEach(function(y) { ctx += '  de ' + y.name + ': $' + y.sum.toFixed(2) + '\n'; });
  }
  if (pequenos.length >= 5) {
    ctx += '\nGASTOS CHICOS (<$10): ' + pequenos.length + ' compras = $' + sumaPeq.toFixed(2) + '\n';
  }
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
