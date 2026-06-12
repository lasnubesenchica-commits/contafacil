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
  var lista = Object.keys(unicas).slice(0, 200);
  if (!lista.length) return {};

  var prompt =
    'Eres un clasificador de movimientos bancarios panameños. Te paso una lista de DESCRIPCIONES.\n\n' +
    'Para CADA una, devolveme la categoría más probable. Categorías válidas:\n\n' +
    '  comida           — restaurantes, café (Kotowa, Starbucks), supermercado pequeño, delivery (UBER EATS, PEDIDOSYA, RAPPI)\n' +
    '  transporte       — UBER (NO Eats), taxi, gasolinera, peaje, parking\n' +
    '  telco            — Más Móvil, +Móvil, Tigo, Cable Onda, MASMOVIL, internet, celular\n' +
    '  servicios        — luz (ENSA, IDAAN), agua, gas, electricidad\n' +
    '  entretenimiento  — Netflix, Spotify, Disney+, HBO, Twitch, cine, juegos\n' +
    '  ads              — Facebook Ads (FACEBK), Google Ads (GOOGL), TikTok ads\n' +
    '  yappy_salida     — YAPPY BG A <nombre> (vos mandando)\n' +
    '  yappy_entrada    — YAPPY BG DE <nombre> (vos recibiendo)\n' +
    '  ach_salida       — ACH/transferencia saliente, PAGO ACH\n' +
    '  ach_entrada      — ACH entrante, DEPÓSITO, ABONO\n' +
    '  retiro_atm       — RETIRO CAJERO, ATM\n' +
    '  pago_tarjeta     — PAGO TARJETA CRÉDITO\n' +
    '  prestamo         — pago préstamo, cuota leasing\n' +
    '  seguro           — Assa, Mapfre, Pan-American, prima seguro\n' +
    '  educacion        — colegio, universidad (USMA, ULACIT, UTP), matrícula\n' +
    '  salud            — farmacia (Arrocha, MetroFarma), médico, clínica, hospital\n' +
    '  belleza          — peluquería, barbería, spa, salón, Kevins Studio\n' +
    '  comercio         — PriceSmart, Super 99, Riba Smith, Xtra, El Machetazo\n' +
    '  ropa             — Zara, H&M, almacenes, tiendas de ropa\n' +
    '  comision_banco   — cargos del banco, comisión, ITBMS bancario\n' +
    '  otro             — todo lo demás\n\n' +
    'Devuelve SOLO JSON válido, sin markdown:\n' +
    '{ "<descripcion exacta>": "<categoria>", ... }\n\n' +
    'DESCRIPCIONES:\n' +
    lista.map(function(d, i) { return (i + 1) + '. ' + d; }).join('\n');

  var payload = {
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 4000,
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
  var jm   = text.match(/\{[\s\S]*\}/);
  if (!jm) return {};
  try { return JSON.parse(jm[0]); }
  catch(e) { Logger.log('Banco clasif JSON parse: ' + e.message); return {}; }
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
      if (!byMerchantOut[mk]) byMerchantOut[mk] = { count: 0, sum: 0, montos: [] };
      byMerchantOut[mk].count++;
      byMerchantOut[mk].sum += -monto;
      byMerchantOut[mk].montos.push(monto);
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

  // Suscripciones: mismo merchant (de gastos) ≥ 2 veces con montos
  // similares (variación < 15% sobre el promedio).
  var suscripciones = [];
  Object.keys(byMerchantOut).forEach(function(mk) {
    var info = byMerchantOut[mk];
    if (info.count < 2) return;
    var avg = info.sum / info.count;
    if (avg < 3) return;
    var allClose = info.montos.every(function(x) {
      return Math.abs(Math.abs(x) - avg) / avg < 0.15;
    });
    if (allClose) suscripciones.push({ merchant: mk, count: info.count, avg: avg });
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

  // Top merchant — el que se llevó más plata acumulada (single insight
  // más punzante que el "top categoría" que abstrae).
  var topMerchant = null;
  var bestSum = 0;
  Object.keys(byMerchantOut).forEach(function(mk) {
    if (byMerchantOut[mk].sum > bestSum) {
      bestSum = byMerchantOut[mk].sum;
      topMerchant = { name: mk, sum: byMerchantOut[mk].sum, count: byMerchantOut[mk].count };
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
  var ratioGasto = totalIn > 0 ? totalOut / totalIn : 0;
  if (totalIn > 0 && ratioGasto > 0.9 && totalOut - totalIn > 20) {
    flags.push('⚠️ Gastaste el ' + Math.round(ratioGasto * 100) + '% de lo que ingresaste — margen muy ajustado.');
  }
  if (deltaSaldo != null && deltaSaldo < -20) {
    flags.push('📉 Tu saldo bajó ' + _bancoFmtDolar(Math.abs(deltaSaldo)) + ' en este período.');
  }
  if (topCats.length && topCats[0].sum / Math.max(totalOut, 1) > 0.4) {
    flags.push('🎯 Una sola categoría (' + _bancoCatLabel(topCats[0].cat) + ') se llevó el ' +
               Math.round((topCats[0].sum / totalOut) * 100) + '% de tu gasto — concentración alta.');
  }
  if (saldoFin != null && dias > 0 && totalOut > 0) {
    var gastoDiario = totalOut / dias;
    var runwayDias  = gastoDiario > 0 ? Math.floor(saldoFin / gastoDiario) : 999;
    if (runwayDias < 7) {
      flags.push('⏳ Al ritmo de gasto actual, tu saldo dura ~' + runwayDias + ' día(s) más.');
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
    a.topCats.forEach(function(c) {
      var p = pct(c.sum, a.totalOut);
      msg += _bancoCatLabel(c.cat) + ': ' + fmt(c.sum) + ' (' + p + '%)\n';
    });
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
