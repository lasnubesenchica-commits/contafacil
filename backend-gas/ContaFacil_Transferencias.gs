// ════════════════════════════════════════════════════════════════════
//  ContaFacil_Transferencias.gs
//  Módulo: Notificaciones de transferencia bancaria → Egresos automáticos
//  v1.0 — Banco General (Yappy, ACH, banca móvil)
//
//  Flujo
//  ─────
//    1. Cliente configura filtro Gmail: from mensajesyalertas@bgeneral.com
//       → reenviar a facturas@balanceclip.net (mismo alias que usa para
//        facturas, sin cambios en el setup del cliente).
//    2. AutoSync detecta el email body-only (sin adjunto), lo parsea, y:
//       a. Si el beneficiario ya está en Beneficiarios_Config →
//          registra el egreso silenciosamente con la categoría guardada
//          y envía confirmación corta al WhatsApp del cliente.
//       b. Si NO está → encola en Transferencias_Pendientes y manda
//          lista interactiva al cliente para que clasifique. La respuesta
//          del cliente registra el egreso + persiste el beneficiario para
//          futuras transferencias.
//    3. Si el cliente está fuera de la ventana de 24h de WhatsApp y el
//       envío del interactivo falla, el item queda en queue. Cuando el
//       cliente vuelva a escribir al bot, _transfDrainQueue le envía
//       las pendientes acumuladas.
//
//  Schema persistido
//  ─────────────────
//    Hoja Beneficiarios_Config: 1 fila por beneficiario único
//    Hoja Transferencias_Pendientes: queue + auditoría de cada notificación
//
//  Categorización del egreso
//  ─────────────────────────
//    Categorías DGI estándar + no deducibles del Art. 697 (mismas que
//    usa el resto del sistema). Las no deducibles auto-marcan
//    alcance='personal' para excluirse de reportes fiscales.
// ════════════════════════════════════════════════════════════════════

var SHEET_BENEFICIARIOS    = 'Beneficiarios_Config';
var SHEET_TRANSF_PENDIENTES = 'Transferencias_Pendientes';

var COL_BENEF = {
  ID:                1,  // A — id_beneficiario (BENEF-0001)
  NOMBRE_CANONICO:   2,  // B — uppercase, sin acentos (key de lookup)
  NOMBRE_ORIGINAL:   3,  // C — como aparece en el email (para display)
  ALIASES:           4,  // D — variantes csv (futuro: handle variaciones)
  CATEGORIA_DEFAULT: 5,  // E — key DGI ej 'pension_alimenticia'
  ALCANCE_DEFAULT:   6,  // F — 'negocio' | 'personal'
  CONCEPTO_HINT:     7,  // G — texto del concepto que confirmó la categoría
  N_TRANSFERENCIAS:  8,  // H — counter (incrementa cada vez que se aplica)
  CREATED_AT:        9,  // I — fecha de alta
  UPDATED_AT:       10,  // J — última transferencia
};
var BENEF_NCOLS = 10;

var COL_TP = {
  ID:                 1,  // A — id_pendiente (TR-0001)
  CREATED_AT:         2,  // B — fecha que llegó el email
  EMAIL_MSGID:        3,  // C — Gmail message ID (dedup)
  PHONE:              4,  // D — phone del cliente a notificar
  PARSED_JSON:        5,  // E — { destinatario, monto, fecha, concepto, canal, cuenta_term }
  ESTADO:             6,  // F — pendiente_clasif | clasificada | registrada | descartada
  CATEGORIA_APLICADA: 7,  // G — key DGI aplicada
  EGRESO_ID:          8,  // H — id_egreso creado en hoja Egresos
  LAST_ATTEMPT:       9,  // I — fecha del último intento de enviar al cliente
  ERROR_MSG:         10,  // J — error de Meta si el envío falló
};
var TP_NCOLS = 10;

// Categorías curadas para el list interactivo (Meta limita a 10 filas
// totales). Cubren los casos más frecuentes de transferencias panameñas;
// para casos exóticos el cliente edita después desde el mobile.
var TRANSF_CAT_OPTIONS = [
  { key: 'pension_alimenticia',     title: '💸 Pensión Alimenticia', desc: 'no deducible' },
  { key: 'manutencion',             title: '💸 Manutención',         desc: 'no deducible' },
  { key: 'gastos_alimentacion',     title: '🍽️ Alimentación',        desc: 'no deducible' },
  { key: 'gastos_medicos',          title: '🏥 Gastos Médicos',      desc: 'DP-1 · ISR persona natural' },
  { key: 'salarios_remuneraciones', title: '👤 Salarios',             desc: 'G1' },
  { key: 'honorarios_servicios',    title: '💼 Honorarios prof.',     desc: 'G12' },
  { key: 'alquileres',              title: '🏠 Alquiler',             desc: 'G4' },
  { key: 'transporte',              title: '⛽ Transporte',            desc: 'G5' },
  { key: 'otros_gastos',            title: '📋 Otros Gastos',         desc: 'catch-all' },
  { key: '__skip__',                title: '❌ Ignorar',               desc: 'no registrar' },
];

// ════════════════════════════════════════════════════════════════════
//  SHEET INITIALIZERS — llamados por inicializarSistema()
// ════════════════════════════════════════════════════════════════════

function _initBeneficiariosSheet(ss) {
  ss = ss || SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var existing = ss.getSheetByName(SHEET_BENEFICIARIOS);
  if (existing) return existing;

  var sheet = ss.insertSheet(SHEET_BENEFICIARIOS);
  SpreadsheetApp.flush();

  var meta = ['ID', 'IDENTIDAD', '', '', 'CATEGORIZACIÓN', '', '', 'CONTADOR', 'AUDIT', ''];
  var headers = [
    'id_beneficiario', 'nombre_canonico', 'nombre_original', 'aliases',
    'categoria_default', 'alcance_default', 'concepto_hint',
    'n_transferencias', 'created_at', 'updated_at',
  ];
  sheet.getRange(1, 1, 1, BENEF_NCOLS).setValues([meta]);
  sheet.getRange(1, 1, 1, BENEF_NCOLS).setBackground('#37474F').setFontColor('#FFFFFF').setFontWeight('bold');
  sheet.getRange(2, 1, 1, BENEF_NCOLS).setValues([headers]);
  sheet.getRange(2, 1, 1, BENEF_NCOLS).setBackground('#546E7A').setFontColor('#FFFFFF').setFontWeight('bold');
  sheet.setFrozenRows(2);

  var widths = [110, 200, 200, 200, 180, 90, 200, 90, 140, 140];
  for (var i = 0; i < widths.length; i++) sheet.setColumnWidth(i + 1, widths[i]);
  Logger.log('✅ Hoja Beneficiarios_Config creada.');
  return sheet;
}

function _initTransferenciasPendientesSheet(ss) {
  ss = ss || SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var existing = ss.getSheetByName(SHEET_TRANSF_PENDIENTES);
  if (existing) return existing;

  var sheet = ss.insertSheet(SHEET_TRANSF_PENDIENTES);
  SpreadsheetApp.flush();

  var meta = ['ID', 'AUDIT', '', 'DESTINATARIO', 'PAYLOAD', 'STATUS', 'RESULTADO', '', 'RETRY', ''];
  var headers = [
    'id_pendiente', 'created_at', 'email_msgid', 'phone',
    'parsed_json', 'estado', 'categoria_aplicada', 'egreso_id',
    'last_attempt', 'error_msg',
  ];
  sheet.getRange(1, 1, 1, TP_NCOLS).setValues([meta]);
  sheet.getRange(1, 1, 1, TP_NCOLS).setBackground('#37474F').setFontColor('#FFFFFF').setFontWeight('bold');
  sheet.getRange(2, 1, 1, TP_NCOLS).setValues([headers]);
  sheet.getRange(2, 1, 1, TP_NCOLS).setBackground('#546E7A').setFontColor('#FFFFFF').setFontWeight('bold');
  sheet.setFrozenRows(2);

  var widths = [110, 140, 200, 130, 420, 130, 180, 140, 140, 300];
  for (var i = 0; i < widths.length; i++) sheet.setColumnWidth(i + 1, widths[i]);
  Logger.log('✅ Hoja Transferencias_Pendientes creada.');
  return sheet;
}

// ════════════════════════════════════════════════════════════════════
//  DETECTOR + PARSER — Banco General
//  Sender canónico: mensajesyalertas@bgeneral.com
//  Subjects observados:
//    "Transferencia a <X> realizada"  (ACH / banca móvil)
//    "Yappy enviado a <X>"             (Yappy)
//    "ACH a <X> realizada"             (variantes ACH)
// ════════════════════════════════════════════════════════════════════

var BG_SENDER_PATTERNS = [
  'mensajesyalertas@bgeneral.com',
  'mensajesyalertas@banco-general.com',  // dominio alterno observado
];

function _transfEsEmailBG(msg) {
  var from = String(msg.getFrom() || '').toLowerCase();
  for (var i = 0; i < BG_SENDER_PATTERNS.length; i++) {
    if (from.indexOf(BG_SENDER_PATTERNS[i]) >= 0) {
      var subj = String(msg.getSubject() || '');
      // Patrón laxo — cubre las variantes conocidas + descartar avisos
      // que NO son de transferencia (saldo, login, etc).
      return /transferencia.*realizada|yappy\s+(enviado|recibido)|ach.*realizada|pago.*realizado/i.test(subj);
    }
  }
  return false;
}

// Parsea el body plain-text de BG. Los emails tienen formato consistente:
//   Hola, <NOMBRE CLIENTE>:
//   La siguiente transferencia, debitada de la cuenta con terminación NNNN, ha sido realizada:
//   A: <destinatario>
//   Banco: <banco destino>
//   Cuenta con terminación: <NNNN>
//   Monto: US$<monto>
//   Fecha de transferencia: <DD-MMM-YY>
//   Descripción: <concepto>
//   A través de: <BANCA MÓVIL|YAPPY|ACH>
function _transfParsearBodyBG(body) {
  var lines = String(body || '').split(/\r?\n/);
  var data = {};
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i].trim();
    if (!l) continue;
    var m;
    if ((m = l.match(/^A:\s*(.+)$/i)))                                       data.destinatario = m[1].trim();
    else if ((m = l.match(/^Banco:\s*(.+)$/i)))                              data.banco        = m[1].trim();
    else if ((m = l.match(/^Cuenta\s+con\s+terminaci[oó]n:\s*(\d+)/i)))      data.cuenta_term  = m[1];
    else if ((m = l.match(/^Monto:\s*(?:US\$|B\.|\$|USD)?\s*([\d,]+(?:\.\d{1,2})?)/i))) data.monto = parseFloat(m[1].replace(/,/g, ''));
    else if ((m = l.match(/^Fecha\s+de\s+transferencia:\s*(.+)$/i)))         data.fecha_raw    = m[1].trim();
    else if ((m = l.match(/^Descripci[oó]n:\s*(.+)$/i)))                     data.concepto     = m[1].trim();
    else if ((m = l.match(/^A\s+trav[eé]s\s+de:\s*(.+)$/i)))                 data.canal        = m[1].trim();
  }
  data.fecha = _transfParseFechaBG(data.fecha_raw);
  return data;
}

// Convierte "15-jun-26" → "2026-06-15"
function _transfParseFechaBG(raw) {
  if (!raw) return '';
  var m = String(raw).trim().toLowerCase().match(/^(\d{1,2})[-\/\s]+(\w+)[-\/\s]+(\d{2,4})/);
  if (!m) return '';
  var d  = parseInt(m[1], 10);
  var yy = parseInt(m[3], 10);
  if (yy < 100) yy += 2000;  // "26" → 2026
  var mes = { ene:1, feb:2, mar:3, abr:4, may:5, jun:6, jul:7, ago:8, sep:9, oct:10, nov:11, dic:12 };
  var mm  = mes[m[2].substring(0, 3)];
  if (!mm || !d) return '';
  return yy + '-' + String(mm).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

// ════════════════════════════════════════════════════════════════════
//  BENEFICIARIO MANAGEMENT
// ════════════════════════════════════════════════════════════════════

// Normaliza nombre para comparación: uppercase, sin acentos, espacios
// colapsados. Maneja variaciones como "Viviana Ordonez" vs "VIVIANA ORDÓÑEZ".
function _transfNormalizarNombre(s) {
  return String(s || '').trim().toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // saca acentos
    .replace(/[^A-Z0-9\s]/g, ' ')                       // saca puntuación
    .replace(/\s+/g, ' ')
    .trim();
}

// Devuelve { categoria_default, alcance_default, nombre_original, id }
// o null si no hay match. Match por nombre canónico.
function _transfBuscarBeneficiario(nombreRaw) {
  var canonico = _transfNormalizarNombre(nombreRaw);
  if (!canonico) return null;

  var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_BENEFICIARIOS);
  if (!sheet || sheet.getLastRow() <= 2) return null;

  var data = sheet.getRange(3, 1, sheet.getLastRow() - 2, BENEF_NCOLS).getValues();
  for (var i = 0; i < data.length; i++) {
    var canRow = String(data[i][COL_BENEF.NOMBRE_CANONICO - 1] || '').trim();
    if (canRow === canonico) {
      return {
        id:                String(data[i][COL_BENEF.ID - 1] || ''),
        nombre_canonico:   canRow,
        nombre_original:   String(data[i][COL_BENEF.NOMBRE_ORIGINAL - 1] || ''),
        categoria_default: String(data[i][COL_BENEF.CATEGORIA_DEFAULT - 1] || ''),
        alcance_default:   String(data[i][COL_BENEF.ALCANCE_DEFAULT - 1] || 'negocio'),
        concepto_hint:     String(data[i][COL_BENEF.CONCEPTO_HINT - 1] || ''),
        n_transferencias:  parseInt(data[i][COL_BENEF.N_TRANSFERENCIAS - 1], 10) || 0,
        _row:              i + 3,
      };
    }
  }
  return null;
}

// Inserta nuevo beneficiario. Solo se llama cuando el cliente clasifica
// por primera vez una transferencia a este destinatario (vía interactive).
function _transfRegistrarBeneficiario(nombreOriginal, categoria, alcance, concepto) {
  var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = _initBeneficiariosSheet(ss);  // idempotente
  var canonico = _transfNormalizarNombre(nombreOriginal);
  if (!canonico) return null;

  // Ya existe? actualizar default (caso: el cliente cambió de opinión)
  var existing = _transfBuscarBeneficiario(nombreOriginal);
  if (existing) {
    sheet.getRange(existing._row, COL_BENEF.CATEGORIA_DEFAULT).setValue(categoria);
    sheet.getRange(existing._row, COL_BENEF.ALCANCE_DEFAULT).setValue(alcance);
    sheet.getRange(existing._row, COL_BENEF.CONCEPTO_HINT).setValue(concepto || '');
    sheet.getRange(existing._row, COL_BENEF.UPDATED_AT).setValue(
      Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm:ss')
    );
    return existing.id;
  }

  // Generar ID secuencial
  var lastRow = sheet.getLastRow();
  var seq = 1;
  if (lastRow > 2) {
    var ids = sheet.getRange(3, COL_BENEF.ID, lastRow - 2, 1).getValues();
    for (var k = ids.length - 1; k >= 0; k--) {
      var parts = String(ids[k][0] || '').split('-');
      var n = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(n)) { seq = n + 1; break; }
    }
  }
  var id = 'BENEF-' + String(seq).padStart(4, '0');
  var stamp = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm:ss');

  var fila = new Array(BENEF_NCOLS);
  for (var x = 0; x < BENEF_NCOLS; x++) fila[x] = '';
  fila[COL_BENEF.ID - 1]                = id;
  fila[COL_BENEF.NOMBRE_CANONICO - 1]   = canonico;
  fila[COL_BENEF.NOMBRE_ORIGINAL - 1]   = String(nombreOriginal || '').trim();
  fila[COL_BENEF.CATEGORIA_DEFAULT - 1] = categoria;
  fila[COL_BENEF.ALCANCE_DEFAULT - 1]   = alcance;
  fila[COL_BENEF.CONCEPTO_HINT - 1]     = concepto || '';
  fila[COL_BENEF.N_TRANSFERENCIAS - 1]  = 0;
  fila[COL_BENEF.CREATED_AT - 1]        = stamp;
  fila[COL_BENEF.UPDATED_AT - 1]        = stamp;

  sheet.appendRow(fila);
  Logger.log('✅ Beneficiario nuevo: ' + id + ' ' + nombreOriginal + ' → ' + categoria);
  return id;
}

function _transfIncrementarBeneficiarioCounter(beneficiarioId) {
  if (!beneficiarioId) return;
  var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_BENEFICIARIOS);
  if (!sheet || sheet.getLastRow() <= 2) return;
  var ids = sheet.getRange(3, COL_BENEF.ID, sheet.getLastRow() - 2, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || '') === beneficiarioId) {
      var row = i + 3;
      var prev = parseInt(sheet.getRange(row, COL_BENEF.N_TRANSFERENCIAS).getValue(), 10) || 0;
      sheet.getRange(row, COL_BENEF.N_TRANSFERENCIAS).setValue(prev + 1);
      sheet.getRange(row, COL_BENEF.UPDATED_AT).setValue(
        Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm:ss')
      );
      return;
    }
  }
}

// ════════════════════════════════════════════════════════════════════
//  PENDIENTES QUEUE
// ════════════════════════════════════════════════════════════════════

function _transfPendienteInsert(emailMsgId, phone, parsed) {
  var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = _initTransferenciasPendientesSheet(ss);

  // Dedup por msgId
  var existente = _transfPendientePorMsgId(emailMsgId);
  if (existente) return existente;

  var lastRow = sheet.getLastRow();
  var seq = 1;
  if (lastRow > 2) {
    var ids = sheet.getRange(3, COL_TP.ID, lastRow - 2, 1).getValues();
    for (var k = ids.length - 1; k >= 0; k--) {
      var parts = String(ids[k][0] || '').split('-');
      var n = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(n)) { seq = n + 1; break; }
    }
  }
  var id = 'TR-' + String(seq).padStart(4, '0');
  var stamp = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm:ss');

  var fila = new Array(TP_NCOLS);
  for (var x = 0; x < TP_NCOLS; x++) fila[x] = '';
  fila[COL_TP.ID - 1]          = id;
  fila[COL_TP.CREATED_AT - 1]  = stamp;
  fila[COL_TP.EMAIL_MSGID - 1] = emailMsgId || '';
  fila[COL_TP.PHONE - 1]       = phone || '';
  fila[COL_TP.PARSED_JSON - 1] = JSON.stringify(parsed || {});
  fila[COL_TP.ESTADO - 1]      = 'pendiente_clasif';

  sheet.appendRow(fila);
  return { id: id, _row: sheet.getLastRow() };
}

function _transfPendientePorMsgId(msgId) {
  if (!msgId) return null;
  var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_TRANSF_PENDIENTES);
  if (!sheet || sheet.getLastRow() <= 2) return null;
  var data = sheet.getRange(3, 1, sheet.getLastRow() - 2, TP_NCOLS).getValues();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][COL_TP.EMAIL_MSGID - 1] || '') === msgId) {
      return { id: String(data[i][COL_TP.ID - 1] || ''), _row: i + 3 };
    }
  }
  return null;
}

function _transfPendienteGetById(id) {
  if (!id) return null;
  var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_TRANSF_PENDIENTES);
  if (!sheet || sheet.getLastRow() <= 2) return null;
  var data = sheet.getRange(3, 1, sheet.getLastRow() - 2, TP_NCOLS).getValues();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][COL_TP.ID - 1] || '') === id) {
      var parsed = {};
      try { parsed = JSON.parse(data[i][COL_TP.PARSED_JSON - 1] || '{}'); } catch(e) {}
      return {
        id:                 String(data[i][COL_TP.ID - 1] || ''),
        phone:              String(data[i][COL_TP.PHONE - 1] || ''),
        parsed:             parsed,
        estado:             String(data[i][COL_TP.ESTADO - 1] || ''),
        categoria_aplicada: String(data[i][COL_TP.CATEGORIA_APLICADA - 1] || ''),
        egreso_id:          String(data[i][COL_TP.EGRESO_ID - 1] || ''),
        _row:               i + 3,
      };
    }
  }
  return null;
}

function _transfPendienteUpdate(row, fields) {
  if (!row) return;
  var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_TRANSF_PENDIENTES);
  if (!sheet) return;
  if (fields.estado !== undefined)             sheet.getRange(row, COL_TP.ESTADO).setValue(fields.estado);
  if (fields.categoria_aplicada !== undefined) sheet.getRange(row, COL_TP.CATEGORIA_APLICADA).setValue(fields.categoria_aplicada);
  if (fields.egreso_id !== undefined)          sheet.getRange(row, COL_TP.EGRESO_ID).setValue(fields.egreso_id);
  if (fields.last_attempt !== undefined)       sheet.getRange(row, COL_TP.LAST_ATTEMPT).setValue(fields.last_attempt);
  if (fields.error_msg !== undefined)          sheet.getRange(row, COL_TP.ERROR_MSG).setValue(String(fields.error_msg).substring(0, 500));
}

// Lista pendientes con estado='pendiente_clasif' para un phone (drain).
function _transfPendientesPorPhone(phone, maxItems) {
  if (!phone) return [];
  var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_TRANSF_PENDIENTES);
  if (!sheet || sheet.getLastRow() <= 2) return [];
  var data = sheet.getRange(3, 1, sheet.getLastRow() - 2, TP_NCOLS).getValues();
  var out = [];
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][COL_TP.PHONE - 1] || '') !== phone) continue;
    if (String(data[i][COL_TP.ESTADO - 1] || '') !== 'pendiente_clasif') continue;
    var parsed = {};
    try { parsed = JSON.parse(data[i][COL_TP.PARSED_JSON - 1] || '{}'); } catch(e) {}
    out.push({
      id:     String(data[i][COL_TP.ID - 1] || ''),
      parsed: parsed,
      _row:   i + 3,
    });
    if (maxItems && out.length >= maxItems) break;
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════
//  REGISTRAR EGRESO desde una transferencia clasificada
//  Reusa _handleRegistrarEgresoOperativo (mismo handler que usa el
//  mobile para registrar gastos manuales). Construye el params con
//  los datos parseados + categoria del cliente.
// ════════════════════════════════════════════════════════════════════

function _transfRegistrarEgreso(parsed, categoria, alcance) {
  var notas = 'Transferencia BG · ' + (parsed.canal || '?') +
              (parsed.cuenta_term ? ' · cuenta term. ' + parsed.cuenta_term : '') +
              (parsed.concepto    ? ' · "' + parsed.concepto + '"' : '');

  // Si la categoría es no deducible, forzar alcance personal (consistente
  // con el resto del sistema — _esCategoriaNoDeducible vive en Code.js).
  var alcanceFinal = alcance;
  if (typeof _esCategoriaNoDeducible === 'function' && _esCategoriaNoDeducible(categoria)) {
    alcanceFinal = 'personal';
  }

  var params = {
    fecha:       parsed.fecha || '',
    tipo:        categoria,
    categoria:   categoria,
    proveedor:   parsed.destinatario || '',
    ruc_prov:    '',
    dv_prov:     '',
    num_fac:     '',  // las transferencias no tienen num factura
    subtotal:    parsed.monto || 0,
    itbms:       0,    // transferencias bancarias no llevan ITBMS
    total:       parsed.monto || 0,
    descripcion: parsed.concepto || '',
    notas:       notas,
    alcance:     alcanceFinal,
  };
  var resp = _handleRegistrarEgresoOperativo(params, '');
  var data = JSON.parse(resp.getContent());
  if (!data.success) throw new Error(data.error || 'Error registrando egreso');
  return data.egresoId;
}

// ════════════════════════════════════════════════════════════════════
//  WHATSAPP — envío de notificaciones e interactivo
// ════════════════════════════════════════════════════════════════════

// Body para el list interactivo. Devuelve true si Meta aceptó el envío.
function _transfEnviarInteractivoClasif(phone, pendId, parsed, token, phoneId) {
  var fechaFmt = parsed.fecha || parsed.fecha_raw || '?';
  var body = '💸 *Transferencia detectada*\n\n' +
             '*A:* ' + (parsed.destinatario || '?') + '\n' +
             '*Monto:* $' + (parsed.monto ? parsed.monto.toFixed(2) : '?') + '\n' +
             '*Fecha:* ' + fechaFmt + '\n' +
             (parsed.concepto ? '*Concepto:* ' + parsed.concepto + '\n' : '') +
             (parsed.canal ? '*Vía:* ' + parsed.canal + '\n' : '') +
             '\n¿De qué categoría es?\n_(Las próximas transferencias a este destinatario se clasifican igual automáticamente)_';

  var rows = TRANSF_CAT_OPTIONS.map(function(opt) {
    return { id: 'tr:cat:' + pendId + ':' + opt.key, title: opt.title, description: opt.desc };
  });
  var sections = [{ title: 'Categoría DGI', rows: rows }];
  return _whatsappReplyLista(phone, body, '📋 Clasificar', sections, token, phoneId);
}

// Notificación corta cuando el beneficiario ya estaba clasificado.
function _transfEnviarConfirmacionAutoreg(phone, parsed, categoria, egresoId, token, phoneId) {
  var catLabel = _transfCategoriaLabel(categoria);
  var msg = '💸 *+$' + (parsed.monto ? parsed.monto.toFixed(2) : '?') +
            '* a ' + (parsed.destinatario || '?') + '\n' +
            catLabel + ' · ✅ registrada\n' +
            '_(' + egresoId + ')_';
  _whatsappReply(phone, msg, token, phoneId);
}

function _transfCategoriaLabel(key) {
  for (var i = 0; i < TRANSF_CAT_OPTIONS.length; i++) {
    if (TRANSF_CAT_OPTIONS[i].key === key) return TRANSF_CAT_OPTIONS[i].title;
  }
  if (typeof CATEGORIAS_GASTO_DGI !== 'undefined') {
    for (var j = 0; j < CATEGORIAS_GASTO_DGI.length; j++) {
      if (CATEGORIAS_GASTO_DGI[j].valor === key) return CATEGORIAS_GASTO_DGI[j].emoji + ' ' + CATEGORIAS_GASTO_DGI[j].label;
    }
  }
  return key;
}

// Drain: envía las pendientes para este phone (max 3 a la vez para no
// saturar). Llamado por _whatsappProcesarMensaje en CADA inbound del
// cliente, así si la ventana estaba cerrada y ahora se abrió, las
// pendientes acumuladas se notifican automáticamente.
function _transfDrainQueue(phone, token, phoneId) {
  if (!phone || !token || !phoneId) return;
  var pendientes = _transfPendientesPorPhone(phone, 3);
  if (!pendientes.length) return;
  Logger.log('📤 Drenando queue de transferencias: ' + pendientes.length + ' para ' + phone);
  // Header brief antes de la lista (solo si hay más de 1)
  if (pendientes.length > 1) {
    _whatsappReply(phone,
      '📋 *Tienes ' + pendientes.length + ' transferencia(s) pendientes de categorizar.* Te las voy mandando una por una.',
      token, phoneId);
    Utilities.sleep(700);
  }
  var stamp = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
  for (var i = 0; i < pendientes.length; i++) {
    var p = pendientes[i];
    var ok = false;
    try { ok = _transfEnviarInteractivoClasif(phone, p.id, p.parsed, token, phoneId); }
    catch (err) { Logger.log('Drain error: ' + err.message); }
    _transfPendienteUpdate(p._row, {
      last_attempt: stamp,
      error_msg: ok ? '' : 'send falló en drain',
    });
    if (i < pendientes.length - 1) Utilities.sleep(500);  // throttle
  }
}

// ════════════════════════════════════════════════════════════════════
//  HANDLER — respuesta del cliente al list interactivo
//  ID format: tr:cat:<pendId>:<categoryKey>
//  Llamado desde _whatsappOnInteractive (dispatcher en WhatsApp.gs).
// ════════════════════════════════════════════════════════════════════

function _transfHandleClasificacion(pendId, key, from, token, phoneId) {
  if (!pendId || !key) {
    _whatsappReply(from, '⚠️ Datos incompletos en la respuesta.', token, phoneId);
    return;
  }
  var pend = _transfPendienteGetById(pendId);
  if (!pend) {
    _whatsappReply(from, '⚠️ No encontré la transferencia ' + pendId + ' — quizás ya la procesaste.', token, phoneId);
    return;
  }
  if (pend.estado === 'registrada') {
    _whatsappReply(from, '✅ Esa transferencia ya estaba registrada como ' + (pend.egreso_id || '(sin id)') + '.', token, phoneId);
    return;
  }

  // Caso "ignorar"
  if (key === '__skip__') {
    _transfPendienteUpdate(pend._row, { estado: 'descartada' });
    _whatsappReply(from,
      '❌ Transferencia descartada (no se registra).\n' +
      '_Si era importante, mandame foto del recibo o registrala manual desde el mobile._',
      token, phoneId);
    return;
  }

  // Determinar alcance: no deducibles → personal; resto → negocio (default).
  var alcance = 'negocio';
  if (typeof _esCategoriaNoDeducible === 'function' && _esCategoriaNoDeducible(key)) alcance = 'personal';

  // Registrar egreso + persistir beneficiario
  var egresoId = '';
  try {
    egresoId = _transfRegistrarEgreso(pend.parsed, key, alcance);
  } catch (err) {
    _whatsappReply(from, '⚠️ Error registrando el egreso: ' + err.message, token, phoneId);
    return;
  }
  var benefId = _transfRegistrarBeneficiario(
    pend.parsed.destinatario || '',
    key, alcance, pend.parsed.concepto || ''
  );
  if (benefId) _transfIncrementarBeneficiarioCounter(benefId);

  _transfPendienteUpdate(pend._row, {
    estado: 'registrada',
    categoria_aplicada: key,
    egreso_id: egresoId,
  });

  var catLabel = _transfCategoriaLabel(key);
  _whatsappReply(from,
    '✅ *Registrado* — ' + egresoId + '\n' +
    catLabel + (alcance === 'personal' ? ' (no deducible)' : '') + '\n\n' +
    'Las próximas transferencias a *' + (pend.parsed.destinatario || '?') + '* se clasifican como *' + catLabel + '* automáticamente.\n' +
    '_Podés cambiar este default en la hoja Beneficiarios_Config si te equivocaste._',
    token, phoneId);
}

// ════════════════════════════════════════════════════════════════════
//  MAIN ENTRY — _sincronizarTransferenciasBG
//  Llamado por AutoSync.ejecutarSincronizacionUnificada (3er flujo).
//  Procesa emails de BG en inbox del cliente, parsea, rutea según si
//  el beneficiario está conocido o no.
// ════════════════════════════════════════════════════════════════════

var LABEL_TRANSF_BG = 'procesado_transferencias_bg';

function _sincronizarTransferenciasBG() {
  var stats = { procesados: 0, ignorados: 0, registrados: 0, en_queue: 0, errores: [] };
  var props   = PropertiesService.getScriptProperties();
  var token   = props.getProperty('META_WHATSAPP_TOKEN');
  var phoneId = props.getProperty('META_PHONE_ID');
  var phone   = String(CONFIG.WA_NUM || '').replace(/\D/g, '');
  if (phone && phone.length === 8) phone = '507' + phone;

  if (!phone) {
    Logger.log('Transferencias BG: WA_NUM no configurado — skip');
    return stats;
  }

  // Inicializar hojas si faltan (idempotente, primera corrida del feature
  // en clientes existentes que no las tengan todavía).
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  _initBeneficiariosSheet(ss);
  _initTransferenciasPendientesSheet(ss);

  var label = _getOrCreateLabelTransfBG();
  var query = 'from:(' + BG_SENDER_PATTERNS.join(' OR from:') + ') is:unread newer_than:30d';
  var threads = GmailApp.search(query, 0, 30);
  Logger.log('💸 Threads BG transfer: ' + threads.length);

  for (var t = 0; t < threads.length; t++) {
    var msgs = threads[t].getMessages();
    var threadOk = true;
    for (var m = 0; m < msgs.length; m++) {
      var msg = msgs[m];
      if (!msg.isUnread()) continue;
      try {
        if (!_transfEsEmailBG(msg)) {
          stats.ignorados++;
          continue;
        }
        var msgId = msg.getId();
        if (_transfPendientePorMsgId(msgId)) {
          Logger.log('  ⏭ Ya procesado: ' + msgId);
          stats.ignorados++;
          continue;
        }
        var body   = msg.getPlainBody() || '';
        var parsed = _transfParsearBodyBG(body);
        if (!parsed.destinatario || !parsed.monto) {
          Logger.log('  ⚠️ Parse incompleto — destinatario=' + parsed.destinatario + ' monto=' + parsed.monto);
          stats.errores.push('Parse incompleto en msg ' + msgId);
          threadOk = false;
          continue;
        }
        stats.procesados++;

        var beneficiario = _transfBuscarBeneficiario(parsed.destinatario);
        if (beneficiario && beneficiario.categoria_default) {
          // Conocido → registrar silencioso + notificación corta
          try {
            var egresoId = _transfRegistrarEgreso(parsed, beneficiario.categoria_default, beneficiario.alcance_default);
            _transfIncrementarBeneficiarioCounter(beneficiario.id);
            // Loggear en Pendientes con estado registrada (auditoría)
            var pend1 = _transfPendienteInsert(msgId, phone, parsed);
            _transfPendienteUpdate(pend1._row, {
              estado: 'registrada',
              categoria_aplicada: beneficiario.categoria_default,
              egreso_id: egresoId,
            });
            stats.registrados++;
            if (token && phoneId) {
              try { _transfEnviarConfirmacionAutoreg(phone, parsed, beneficiario.categoria_default, egresoId, token, phoneId); }
              catch (e) { Logger.log('Notif autoreg fallo: ' + e.message); }
            }
            Logger.log('  ✅ Auto-registrado: ' + egresoId + ' (' + beneficiario.categoria_default + ')');
          } catch (regErr) {
            Logger.log('  ✗ Error registrando auto: ' + regErr.message);
            stats.errores.push(regErr.message);
            threadOk = false;
          }
        } else {
          // Desconocido → encolar + intentar enviar interactivo
          var pend2 = _transfPendienteInsert(msgId, phone, parsed);
          stats.en_queue++;
          if (token && phoneId) {
            var stamp = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
            var sent  = false;
            try { sent = _transfEnviarInteractivoClasif(phone, pend2.id, parsed, token, phoneId); }
            catch (sendErr) { Logger.log('  ⚠️ Send interactive fallo: ' + sendErr.message); }
            _transfPendienteUpdate(pend2._row, {
              last_attempt: stamp,
              error_msg: sent ? '' : 'ventana cerrada o send falló — se reintenta en próximo inbound',
            });
            Logger.log(sent ? '  📤 Interactivo enviado' : '  📥 En queue (ventana cerrada)');
          }
        }
      } catch (msgErr) {
        Logger.log('  ✗ Error en msg: ' + msgErr.message);
        stats.errores.push(msgErr.message);
        threadOk = false;
      }
    }
    // Marcar label solo si todo el thread se procesó OK (sin errores transitorios)
    if (threadOk) {
      try { threads[t].addLabel(label); threads[t].markRead(); }
      catch (labelErr) { Logger.log('Label error: ' + labelErr.message); }
    }
  }
  return stats;
}

function _getOrCreateLabelTransfBG() {
  var label = GmailApp.getUserLabelByName(LABEL_TRANSF_BG);
  if (!label) label = GmailApp.createLabel(LABEL_TRANSF_BG);
  return label;
}
