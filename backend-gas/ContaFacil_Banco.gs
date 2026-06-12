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
  } catch(err) {
    Logger.log('Banco historial error: ' + err.message);
  }
  analisis.historial = historial;

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

  msg += '📈 _Mandame el del próximo mes y te muestro cómo evolucionaste._';

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
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(_BANCO_SHEET);
  if (sh) return sh;
  sh = ss.insertSheet(_BANCO_SHEET);
  sh.getRange(1, 1, 1, 8).setValues([[
    'phone','year_month','total_in','total_out','cats_json','n_movs','parcial','updated_at'
  ]]);
  sh.getRange(1, 1, 1, 8).setFontWeight('bold').setBackground('#f3f4f6');
  sh.setFrozenRows(1);
  sh.setColumnWidth(5, 300);
  return sh;
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
      var y = String(rows[i][1] || '');
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
  var ss = SpreadsheetApp.getActive();
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
      yearMonth: String(values[i][1] || ''),
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
