// ═══════════════════════════════════════════════════════════════
//  ContaFacil_Acreedores.gs  - v2.0 BalanceClip
//  Módulo: Acreedores y egresos generales automáticos
//
//  v2.0 — FIX: routing de emails corregido
//    - Query propia con cascada: email_acr_destino/remitente (nuevo)
//      → email_op_destino/remitente (fallback) → email_comprobantes (legado)
//    - Excluye AMBOS labels: -label:procesado_cf_op Y -label:cf_acreedor_procesado
//      para no colisionar con Comercialización
//    - Match en 3 niveles: nombre archivo → contenido PDF (Haiku) → ignora
//    - NO consume threads donde ningún adjunto es de un acreedor configurado
//
//  SETUP:
//    1. Ejecutar initAcreedoresSheets()
//    2. Ejecutar installAcreedoresTrigger()
//    3. Crear label Gmail: "cf_acreedor_procesado"
//    4. Configurar email_acr_destino y email_acr_remitente
//       desde Configuración → Registro General en el admin
// ═══════════════════════════════════════════════════════════════

var SHEET_ACREEDORES_CONFIG  = 'Acreedores_Config';
var SHEET_ACREEDORES_PENDING = 'Acreedores_Pending';
var LABEL_ACREEDOR           = 'cf_acreedor_procesado';

var CATEGORIAS_ACREEDOR = [
  { valor: 'nomina',                   label: 'Nómina / Salarios (L42)'               },
  { valor: 'prestaciones_laborales',   label: 'Prestaciones laborales (L43)'          },
  { valor: 'gastos_representacion',    label: 'Gastos de representación (L44)'        },
  { valor: 'alquileres',               label: 'Alquileres (L46)'                      },
  { valor: 'cargos_bancarios',         label: 'Cargos bancarios (L53)'               },
  { valor: 'vigilancia_seguridad',     label: 'Vigilancia y seguridad (L54)'         },
  { valor: 'gastos_financieros',       label: 'Intereses y gastos financieros (L55)' },
  { valor: 'combustible_transporte',   label: 'Combustible y transporte (L56)'       },
  { valor: 'depreciacion',             label: 'Depreciación (L57)'                   },
  { valor: 'amortizacion',             label: 'Amortización (L58)'                   },
  { valor: 'impuestos_tasas',          label: 'Impuestos y tasas municipales (L59)'  },
  { valor: 'honorarios_profesionales', label: 'Honorarios profesionales (L60)'       },
  { valor: 'seguros',                  label: 'Seguros (L63-66)'                     },
  { valor: 'mantenimiento_reparacion', label: 'Mantenimiento y reparaciones (L67)'   },
  { valor: 'publicidad_mercadeo',      label: 'Publicidad y mercadeo (L68)'          },
  { valor: 'gastos_oficina',           label: 'Gastos de oficina y suministros (L69)'},
  { valor: 'telecomunicaciones',       label: 'Internet y telecomunicaciones (L71)'  },
  { valor: 'servicios_publicos',       label: 'Servicios públicos - agua, luz (L75)' },
  { valor: 'tecnologia_software',      label: 'Tecnología y software (L76)'          },
  { valor: 'capacitacion',             label: 'Capacitación y formación (L76)'       },
  { valor: 'otros_deducibles',         label: 'Otros gastos deducibles (L77)'        },
];

var COL_ACR = {
  ID:              1,
  NOMBRE:          2,
  RUC:             3,
  DV:              4,
  KEYWORDS:        5,
  CATEGORIA_DEF:   6,
  PROMPT_OVERRIDE: 7,
  ACTIVO:          8,
  FECHA_ALTA:      9,
  DRIVE_EJEMPLO:  10,
  NOTAS:          11,
};
var ACR_NCOLS = 11;

var COL_PEND = {
  ID:           1,
  FECHA_REG:    2,
  ESTADO:       3,
  ACREEDOR_ID:  4,
  ACREEDOR_NOM: 5,
  FECHA_FAC:    6,
  NUM_FAC:      7,
  SUBTOTAL:     8,
  ITBMS:        9,
  TOTAL:       10,
  CATEGORIA:   11,
  DESCRIPCION: 12,
  DRIVE_URL:   13,
  NOTAS:       14,
  EGRESO_ID:   15,
  MSG_ID:      16,
};
var PEND_NCOLS = 16;

var _acreedoresCache = null;

// ═══════════════════════════════════════════════════════════════
//  DISPATCH
// ═══════════════════════════════════════════════════════════════

function doGet_Acreedores(action, params, callback) {
  if (action === 'getAcreedores')         return _handleGetAcreedores(params, callback);
  if (action === 'toggleAcreedor')        return _handleToggleAcreedor(params, callback);
  if (action === 'getPendientesAcreedor') return _handleGetPendientesAcreedor(params, callback);
  if (action === 'aprobarAcreedor')       return _handleAprobarAcreedor(params, callback);
  if (action === 'rechazarAcreedor')      return _handleRechazarAcreedor(params, callback);
  if (action === 'eliminarPendienteAcr')  return _handleEliminarPendienteAcr(params, callback);
  if (action === 'sincronizarAcreedores') return _handleSincronizarAcreedores(params, callback);
  if (action === 'getCategorias')         return _handleGetCategorias(params, callback);
  return null;
}

function doPost_Acreedores(action, data) {
  if (action === 'guardarAcreedor')         return _handleGuardarAcreedor(data);
  if (action === 'analizarFacturaAcreedor') return _handleAnalizarFacturaAcreedor(data);
  if (action === 'actualizarPendienteAcr')  return _handleActualizarPendienteAcr(data);
  return null;
}

// ═══════════════════════════════════════════════════════════════
//  QUERY GMAIL — v2.0
//  Cascada de email propia para Acreedores.
//  CRÍTICO: excluye procesado_cf_op para no reprocesar lo de Comercialización.
// ═══════════════════════════════════════════════════════════════

function _getEmailAcrQuery() {
  var cfg = {};
  try { cfg = _getConfig(); } catch(e) { cfg = {}; }

  // Prioridad 1: campos dedicados para Registro General
  // Prioridad 2: fallback a los de Comercialización
  // Prioridad 3: legado email_comprobantes
  var dest = cfg.email_acr_destino  || cfg.email_op_destino  || cfg.email_comprobantes || '';
  var rem  = cfg.email_acr_remitente || cfg.email_op_remitente || '';

  if (!dest) {
    Logger.log('Acreedores: email destino no configurado');
    return null;
  }

  var base;
  if (dest && rem) {
    base = 'to:' + dest + ' from:' + rem + ' has:attachment';
    Logger.log('📧 Query Acreedores: to:' + dest + ' from:' + rem);
  } else {
    base = 'to:' + dest + ' has:attachment';
    Logger.log('📧 Query Acreedores (sin remitente): to:' + dest);
  }

  // Excluir: lo que Comercialización ya procesó Y lo que Acreedores ya procesó
  return base + ' -label:procesado_cf_op -label:' + LABEL_ACREEDOR;
}

// ═══════════════════════════════════════════════════════════════
//  SINCRONIZAR EMAILS — v2.0
// ═══════════════════════════════════════════════════════════════

function _sincronizarEmailsAcreedores() {
  var stats = { procesados: 0, nuevos: 0, ignorados: 0, errores: [] };

  var query = _getEmailAcrQuery();
  if (!query) return stats;

  var ss  = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var cfg = {};
  try { cfg = _getConfig(); } catch(e) {}

  var label   = _getOrCreateLabelAcr(LABEL_ACREEDOR);
  var threads = GmailApp.search(query, 0, 50);
  Logger.log('📬 Threads para Acreedores: ' + threads.length);

  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      try {
        var attachments        = msg.getAttachments();
        var msgId              = msg.getId();
        var todosListos        = true;   // sin errores de parse = ok para poner label
        var tieneAlgunAcreedor = false;  // al menos un adjunto fue de acreedor

        for (var a = 0; a < attachments.length; a++) {
          var att  = attachments[a];
          var mime = att.getContentType() || '';
          var fnL  = (att.getName() || '').toLowerCase();

          // Solo PDFs
          if (mime !== 'application/pdf' && !fnL.endsWith('.pdf')) continue;

          var fileName = att.getName() || ('adjunto_' + a + '.pdf');
          var clave    = msgId + '|' + fileName;

          // Dedup: ya procesado antes
          if (_pendientePorMsgIdFileName(clave)) {
            Logger.log('Acreedores: ya procesado: ' + fileName);
            tieneAlgunAcreedor = true;
            continue;
          }

          var pdfBytes = att.getBytes();
          var pdfB64   = Utilities.base64Encode(pdfBytes);

          // ── Match Nivel 1: nombre de archivo (rápido, sin API) ──
          var acreedor = _matchearAcreedor(fileName);

          // ── Match Nivel 2: contenido PDF con Claude Haiku ───────
          if (!acreedor) {
            acreedor = _matchearAcreedorContenido(pdfB64);
          }

          if (!acreedor) {
            // No es de ningún acreedor configurado — ignorar silenciosamente
            stats.ignorados++;
            Logger.log('⏭ Acreedores ignora (no es acreedor registrado): ' + fileName);
            continue;
          }

          // ── Acreedor encontrado — parsear ────────────────────────
          tieneAlgunAcreedor = true;
          try {
            var parsed   = _claudeParsearFacturaAcreedor(pdfB64, acreedor);
            var driveUrl = _guardarPdfAcreedor(pdfBytes, fileName, acreedor.nombre, cfg);

            if (parsed.num_factura && _pendienteYaExiste(parsed.num_factura, acreedor.id)) {
              Logger.log('Acreedores: factura ya existe: ' + parsed.num_factura);
              _registrarClaveAcreedor(ss, clave, msgId, fileName);
              continue;
            }

            _crearPendiente(ss, acreedor, parsed, driveUrl, clave, msgId, fileName);
            stats.nuevos++;
            Logger.log('✅ Acreedor procesado: ' + acreedor.nombre + ' | ' + (parsed.num_factura || 'SN'));
          } catch(parseErr) {
            stats.errores.push(fileName + ': ' + parseErr.message);
            Logger.log('❌ Error parseando acreedor: ' + parseErr.message);
            todosListos = false;
          }
        }

        stats.procesados++;

        // ── Decisión de label ───────────────────────────────────
        if (tieneAlgunAcreedor) {
          // Tiene acreedores — consumir el thread independientemente de errores parciales
          threads[t].addLabel(label);
          Logger.log(todosListos
            ? '✅ Label cf_acreedor_procesado aplicado.'
            : '⚠️  Label cf_acreedor_procesado aplicado (con errores parciales).');
        } else {
          // Todo ignorado — no consumir el thread
          Logger.log('⏭ Thread sin acreedores — sin label.');
        }

      } catch(msgErr) {
        stats.errores.push('Mensaje ' + msgId + ': ' + msgErr.message);
        Logger.log('❌ Error en mensaje: ' + msgErr.message);
      }
    }
  }

  Logger.log('✅ Acreedores: ' + JSON.stringify(stats));
  return stats;
}

// ═══════════════════════════════════════════════════════════════
//  MATCHING — v2.0
// ═══════════════════════════════════════════════════════════════

// Nivel 1: nombre de archivo. Cubre RUC, keywords y primera palabra del nombre.
function _matchearAcreedor(fileName) {
  var acreedores  = _getAcreedores();
  var fnLower     = (fileName || '').toLowerCase();
  var fnNoGuiones = fnLower.replace(/[-\.]/g, '');

  for (var i = 0; i < acreedores.length; i++) {
    var ac = acreedores[i];
    if (!ac.activo) continue;

    // 1a. RUC en nombre de archivo (con y sin guiones)
    var rucNorm = (ac.ruc || '').replace(/[-\.]/g, '').toLowerCase();
    if (rucNorm && (fnLower.indexOf(rucNorm) !== -1 || fnNoGuiones.indexOf(rucNorm) !== -1)) {
      Logger.log('  Acreedor por RUC en archivo: ' + ac.nombre);
      return ac;
    }

    // 1b. Keywords en nombre de archivo
    var keywords = (ac.keywords || '').toLowerCase().split(/[,|;]/);
    for (var k = 0; k < keywords.length; k++) {
      var kw = keywords[k].trim();
      if (kw && kw.length > 2 && fnLower.indexOf(kw) !== -1) {
        Logger.log('  Acreedor por keyword "' + kw + '": ' + ac.nombre);
        return ac;
      }
    }

    // 1c. Primera palabra del nombre del acreedor en nombre de archivo
    var nombrePrimera = (ac.nombre || '').split(' ')[0].toLowerCase();
    if (nombrePrimera && nombrePrimera.length > 3 && fnLower.indexOf(nombrePrimera) !== -1) {
      Logger.log('  Acreedor por nombre en archivo: ' + ac.nombre);
      return ac;
    }
  }
  return null;
}

// Nivel 2: contenido del PDF con Claude Haiku.
// Cubre nombres genéricos (factura.pdf, invoice.pdf, etc.).
// Una sola llamada Haiku por adjunto no reconocido.
function _matchearAcreedorContenido(pdfB64) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) return null;

  var acreedores = _getAcreedores().filter(function(a) { return a.activo; });
  if (!acreedores.length) return null;

  var lista = acreedores.map(function(a, idx) {
    var entrada = 'ID' + idx + ': "' + a.nombre + '"';
    if (a.ruc) entrada += ' RUC:' + a.ruc;
    if (a.keywords) {
      var kws = a.keywords.split(/[,|;]/).map(function(k) { return k.trim(); }).filter(Boolean);
      if (kws.length) entrada += ' kw:' + kws.join(',');
    }
    return entrada;
  }).join('\n');

  var prompt =
    'Este es un PDF de una factura panameña. Tengo estos acreedores configurados:\n' +
    lista + '\n\n' +
    'Responde SOLO con el ID del acreedor que EMITIÓ esta factura (ejemplo: "ID2"), ' +
    'o "ninguno" si no corresponde a ninguno. Sin explicación adicional.';

  try {
    var payload = {
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfB64 } },
        { type: 'text', text: prompt }
      ]}]
    };
    var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post', contentType: 'application/json',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify(payload), muteHttpExceptions: true,
    });
    if (response.getResponseCode() !== 200) {
      Logger.log('⚠️ Haiku error ' + response.getResponseCode());
      return null;
    }
    var text    = '';
    var content = JSON.parse(response.getContentText()).content || [];
    for (var i = 0; i < content.length; i++) {
      if (content[i].type === 'text') { text = content[i].text.trim(); break; }
    }
    Logger.log('🤖 Haiku acreedor: "' + text + '"');
    if (!text || text.toLowerCase() === 'ninguno') return null;
    var match = text.match(/^ID(\d+)$/i);
    if (!match) return null;
    var idx = parseInt(match[1], 10);
    var resultado = acreedores[idx] || null;
    if (resultado) Logger.log('  Acreedor por contenido PDF: ' + resultado.nombre);
    return resultado;
  } catch(e) {
    Logger.log('⚠️ _matchearAcreedorContenido error: ' + e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
//  CLAUDE — parsear factura de acreedor
// ═══════════════════════════════════════════════════════════════

function _claudeParsearFacturaAcreedor(pdfB64, acreedor) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY no configurada');

  var catList = CATEGORIAS_ACREEDOR.map(function(c) {
    return c.valor + ' - ' + c.label;
  }).join('\n');

  var promptOverride = acreedor.prompt_override || '';
  var prompt =
    'Eres un extractor de facturas de ' + acreedor.nombre +
    (acreedor.ruc ? ' (RUC ' + acreedor.ruc + ')' : '') + ' en Panamá.\n' +
    (promptOverride ? promptOverride + '\n' : '') +
    'Responde SOLO con JSON válido, sin markdown:\n' +
    '{"num_factura":"","fecha":"YYYY-MM-DD","subtotal":0,"itbms":0,"total":0,' +
    '"descripcion":"","categoria_sugerida":"","confianza_categoria":0}\n' +
    'categoria_sugerida debe ser uno de:\n' + catList + '\n' +
    'confianza_categoria: número de 0 a 100.\n' +
    'Si un campo no está visible usar null. Montos como números.';

  var payload = {
    model:      'claude-sonnet-4-20250514',
    max_tokens: 600,
    messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfB64 } },
      { type: 'text', text: prompt }
    ]}]
  };
  var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload), muteHttpExceptions: true,
  });
  if (resp.getResponseCode() !== 200)
    throw new Error('Claude error ' + resp.getResponseCode() + ': ' + resp.getContentText().substring(0,200));
  var text    = '';
  var content = JSON.parse(resp.getContentText()).content || [];
  for (var i = 0; i < content.length; i++) {
    if (content[i].type === 'text') { text = content[i].text; break; }
  }
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

// ═══════════════════════════════════════════════════════════════
//  HELPERS DE HOJAS
// ═══════════════════════════════════════════════════════════════

function _getAcreedores() {
  if (_acreedoresCache) return _acreedoresCache;
  var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_ACREEDORES_CONFIG);
  if (!sheet || sheet.getLastRow() <= 2) { _acreedoresCache = []; return []; }
  var data  = sheet.getRange(3, 1, sheet.getLastRow() - 2, ACR_NCOLS).getValues();
  var items = [];
  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    if (!r[COL_ACR.ID - 1]) continue;
    items.push({
      id:              String(r[COL_ACR.ID - 1]),
      nombre:          r[COL_ACR.NOMBRE - 1]          || '',
      ruc:             r[COL_ACR.RUC - 1]              || '',
      dv:              r[COL_ACR.DV - 1]               || '',
      keywords:        String(r[COL_ACR.KEYWORDS - 1]  || ''),
      categoria_def:   r[COL_ACR.CATEGORIA_DEF - 1]   || '',
      prompt_override: r[COL_ACR.PROMPT_OVERRIDE - 1] || '',
      activo:          String(r[COL_ACR.ACTIVO - 1]).toLowerCase() === 'true',
      fecha_alta:      r[COL_ACR.FECHA_ALTA - 1]      || '',
      drive_ejemplo:   r[COL_ACR.DRIVE_EJEMPLO - 1]   || '',
      notas:           r[COL_ACR.NOTAS - 1]            || '',
      _row:            i + 3,
    });
  }
  _acreedoresCache = items;
  return items;
}

function _guardarPdfAcreedor(pdfBytes, fileName, nombreAcreedor, cfg) {
  try {
    var folderId = (cfg && cfg.drive_folder_id) ? cfg.drive_folder_id : '';
    if (!folderId) return '';
    var folder = DriveApp.getFolderById(folderId);
    var nombre = 'Acreedor_' + (nombreAcreedor || '').replace(/\s+/g,'_').substring(0,30) + '_' + fileName;
    var blob   = Utilities.newBlob(pdfBytes, 'application/pdf', nombre);
    var file   = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return 'https://drive.google.com/file/d/' + file.getId() + '/view';
  } catch(e) { Logger.log('Error subiendo PDF acreedor: ' + e.message); return ''; }
}

function _pendienteYaExiste(numFactura, acreedorId) {
  if (!numFactura) return false;
  var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_ACREEDORES_PENDING);
  if (!sheet || sheet.getLastRow() <= 2) return false;
  var data  = sheet.getRange(3, 1, sheet.getLastRow() - 2, PEND_NCOLS).getValues();
  for (var i = 0; i < data.length; i++) {
    var estado = String(data[i][COL_PEND.ESTADO - 1] || '');
    if (estado === 'rechazado') continue;
    if (String(data[i][COL_PEND.NUM_FAC - 1])     === String(numFactura) &&
        String(data[i][COL_PEND.ACREEDOR_ID - 1]) === String(acreedorId)) return true;
  }
  return false;
}

function _pendientePorMsgIdFileName(clave) {
  if (!clave) return false;
  var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_ACREEDORES_PENDING);
  if (!sheet || sheet.getLastRow() <= 2) return false;
  var ids = sheet.getRange(3, COL_PEND.MSG_ID, sheet.getLastRow() - 2, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || '') === String(clave)) return true;
  }
  return false;
}

function _registrarClaveAcreedor(ss, clave, msgId, fileName) {
  var sheet = ss.getSheetByName(SHEET_ACREEDORES_PENDING);
  if (!sheet) return;
  var data = sheet.getRange(3, 1, sheet.getLastRow() - 2, PEND_NCOLS).getValues();
  for (var i = 0; i < data.length; i++) {
    var existingClave = String(data[i][COL_PEND.MSG_ID - 1] || '');
    if (existingClave === clave) return;
    if (existingClave === msgId) { sheet.getRange(i + 3, COL_PEND.MSG_ID).setValue(clave); return; }
  }
}

function _crearPendiente(ss, acreedor, parsed, driveUrl, clave, msgId, fileName) {
  var sheet = ss.getSheetByName(SHEET_ACREEDORES_PENDING);
  if (!sheet) throw new Error('Hoja Acreedores_Pending no encontrada. Ejecutar initAcreedoresSheets().');

  var ahora    = new Date();
  var fechaReg = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
  var lastRow  = sheet.getLastRow();
  var seq      = 1;
  if (lastRow > 2) {
    var ids = sheet.getRange(3, COL_PEND.ID, lastRow - 2, 1).getValues();
    for (var k = ids.length - 1; k >= 0; k--) {
      var parts = String(ids[k][0] || '').split('-');
      var n     = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(n)) { seq = n + 1; break; }
    }
  }
  var id = 'PENDR-' + Utilities.formatDate(ahora, 'America/Panama', 'yyyyMM') +
           '-' + String(seq).padStart(4, '0');

  var catSugerida = acreedor.categoria_def || parsed.categoria_sugerida || CATEGORIAS_ACREEDOR[0].valor;

  var fila = new Array(PEND_NCOLS);
  for (var x = 0; x < PEND_NCOLS; x++) fila[x] = '';
  fila[COL_PEND.ID - 1]          = id;
  fila[COL_PEND.FECHA_REG - 1]   = fechaReg;
  fila[COL_PEND.ESTADO - 1]      = 'borrador';
  fila[COL_PEND.ACREEDOR_ID - 1] = acreedor.id;
  fila[COL_PEND.ACREEDOR_NOM -1] = acreedor.nombre;
  fila[COL_PEND.FECHA_FAC - 1]   = parsed.fecha        || '';
  fila[COL_PEND.NUM_FAC - 1]     = parsed.num_factura  || '';
  fila[COL_PEND.SUBTOTAL - 1]    = parseFloat(parsed.subtotal || '0') || '';
  fila[COL_PEND.ITBMS - 1]       = parseFloat(parsed.itbms    || '0') || '';
  fila[COL_PEND.TOTAL - 1]       = parseFloat(parsed.total    || '0') || '';
  fila[COL_PEND.CATEGORIA - 1]   = catSugerida;
  fila[COL_PEND.DESCRIPCION - 1] = parsed.descripcion  || acreedor.nombre;
  fila[COL_PEND.DRIVE_URL - 1]   = driveUrl;
  fila[COL_PEND.NOTAS - 1]       = 'IA confianza cat: ' + (parsed.confianza_categoria || '?') + '%';
  fila[COL_PEND.EGRESO_ID - 1]   = '';
  fila[COL_PEND.MSG_ID - 1]      = clave || msgId || '';

  var newRow = sheet.getLastRow() + 1;
  sheet.getRange(newRow, 1, 1, PEND_NCOLS).setValues([fila]);
  sheet.getRange(newRow, COL_PEND.SUBTOTAL, 1, 3).setNumberFormat('#,##0.00');
  sheet.getRange(newRow, 1, 1, PEND_NCOLS).setBackground('#FFF9C4');
  return id;
}

function _getOrCreateLabelAcr(nombre) {
  var labels = GmailApp.getUserLabels();
  for (var i = 0; i < labels.length; i++) {
    if (labels[i].getName() === nombre) return labels[i];
  }
  return GmailApp.createLabel(nombre);
}

// ═══════════════════════════════════════════════════════════════
//  HANDLERS doGet
// ═══════════════════════════════════════════════════════════════

function _handleGetCategorias(params, callback) {
  return _jsonpAcr({ success: true, categorias: CATEGORIAS_ACREEDOR }, callback);
}

function _handleGetAcreedores(params, callback) {
  var result = { success: false, items: [], error: null };
  try {
    _acreedoresCache = null;
    result.items   = _getAcreedores();
    result.success = true;
  } catch(err) { result.error = err.message; }
  return _jsonpAcr(result, callback);
}

function _handleToggleAcreedor(params, callback) {
  var result = { success: false, error: null };
  try {
    var id     = params.id     || '';
    var activo = params.activo === 'true';
    if (!id) throw new Error('id requerido');
    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_ACREEDORES_CONFIG);
    if (!sheet) throw new Error('Hoja Acreedores_Config no encontrada');
    var lastRow = sheet.getLastRow();
    if (lastRow <= 2) throw new Error('Sin acreedores');
    var data  = sheet.getRange(3, 1, lastRow - 2, ACR_NCOLS).getValues();
    var found = false;
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][COL_ACR.ID - 1]) === String(id)) {
        sheet.getRange(i + 3, COL_ACR.ACTIVO).setValue(activo);
        _acreedoresCache = null;
        found = true;
        break;
      }
    }
    if (!found) throw new Error('Acreedor no encontrado: ' + id);
    result.success = true;
  } catch(err) { result.error = err.message; }
  return _jsonpAcr(result, callback);
}

function _handleGetPendientesAcreedor(params, callback) {
  var result = { success: false, items: [], error: null };
  try {
    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_ACREEDORES_PENDING);
    if (!sheet || sheet.getLastRow() <= 2) {
      result.success = true;
      return _jsonpAcr(result, callback);
    }
    var numRows = sheet.getLastRow() - 2;
    var data    = sheet.getRange(3, 1, numRows, PEND_NCOLS).getValues();
    var items   = [];
    for (var i = 0; i < data.length; i++) {
      var r = data[i];
      if (!r[COL_PEND.ID - 1]) continue;
      var estado = String(r[COL_PEND.ESTADO - 1] || '');
      if (estado === 'rechazado') continue;  // ocultar rechazados
 
      // Normalizar fecha factura
      var fechaFac = r[COL_PEND.FECHA_FAC - 1];
      if (fechaFac instanceof Date) {
        fechaFac = Utilities.formatDate(fechaFac, 'America/Panama', 'yyyy-MM-dd');
      } else {
        fechaFac = String(fechaFac || '').slice(0, 10);
      }
 
      items.push({
        id:           String(r[COL_PEND.ID - 1]),
        fecha_reg:    r[COL_PEND.FECHA_REG - 1]   || '',
        estado:       estado,
        acreedor_id:  r[COL_PEND.ACREEDOR_ID - 1]  || '',
 
        // ── Nombres que usa el frontend ──
        acreedor_nom: r[COL_PEND.ACREEDOR_NOM - 1] || '',  // acrAbrirDetalle: item.acreedor_nom
        fecha_fac:    fechaFac,                              // acrAbrirDetalle: item.fecha_fac
        num_fac:      r[COL_PEND.NUM_FAC - 1]      || '',  // acrAbrirDetalle: item.num_fac
        drive_url:    r[COL_PEND.DRIVE_URL - 1]    || '',  // acrAbrirDetalle: item.drive_url
 
        // ── Montos ──
        subtotal:     parseFloat(r[COL_PEND.SUBTOTAL - 1]) || 0,
        itbms:        parseFloat(r[COL_PEND.ITBMS - 1])    || 0,
        total:        parseFloat(r[COL_PEND.TOTAL - 1])     || 0,
 
        // ── Clasificación ──
        categoria:    r[COL_PEND.CATEGORIA - 1]    || '',
        descripcion:  r[COL_PEND.DESCRIPCION - 1]  || '',
        notas:        r[COL_PEND.NOTAS - 1]        || '',
        egreso_id:    r[COL_PEND.EGRESO_ID - 1]    || '',
      });
    }
    result.success = true;
    result.items   = items.reverse();  // más recientes primero
  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleGetPendientesAcreedor: ' + err.message);
  }
  return _jsonpAcr(result, callback);
}

function _handleAprobarAcreedor(params, callback) {
  var result = { success: false, error: null };
  try {
    var id = String(params.id || '').trim();
    if (!id) throw new Error('id requerido');

    var ss      = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet   = ss.getSheetByName(SHEET_ACREEDORES_PENDING);
    if (!sheet) throw new Error('Hoja Acreedores_Pending no encontrada');
    var numRows = sheet.getLastRow() - 2;
    if (numRows <= 0) throw new Error('Sin pendientes');
    var data    = sheet.getRange(3, 1, numRows, PEND_NCOLS).getValues();
    var found   = false;

    for (var i = 0; i < data.length; i++) {
      if (String(data[i][COL_PEND.ID - 1]) !== id) continue;
      var rowNum = i + 3;
      var r      = data[i];

      // Crear egreso en hoja Egresos
      var cfg       = _getConfig();
      var prefijo   = (cfg && cfg.prefijo_id) ? cfg.prefijo_id : 'RP';
      var ahora     = new Date();
      var egresoId  = 'EGR-' + prefijo + '-' + Utilities.formatDate(ahora, 'America/Panama', 'yyyy') +
                      '-' + Utilities.formatDate(ahora, 'America/Panama', 'MMddHHmmss');
      var sheetE    = ss.getSheetByName(SHEET_EGRESOS);
      if (sheetE) {
        var fechaReg = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
        var fechaGasto = r[COL_PEND.FECHA_FAC - 1] || Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd');
        if (fechaGasto instanceof Date) fechaGasto = Utilities.formatDate(fechaGasto, 'America/Panama', 'yyyy-MM-dd');
        var filE = new Array(EGRESOS_NCOLS);
        for (var x = 0; x < EGRESOS_NCOLS; x++) filE[x] = '';
        filE[COL_E.ID - 1]            = egresoId;
        filE[COL_E.FECHA_REG - 1]     = fechaReg;
        filE[COL_E.FECHA_GASTO - 1]   = fechaGasto;
        filE[COL_E.DESCRIPCION - 1]   = r[COL_PEND.DESCRIPCION - 1] || r[COL_PEND.ACREEDOR_NOM - 1] || '';
        filE[COL_E.CATEGORIA - 1]     = r[COL_PEND.CATEGORIA - 1]   || '';
        filE[COL_E.SUBTOTAL - 1]      = parseFloat(r[COL_PEND.SUBTOTAL - 1] || '0') || '';
        filE[COL_E.ITBMS - 1]         = parseFloat(r[COL_PEND.ITBMS - 1]    || '0') || '';
        filE[COL_E.TOTAL - 1]         = parseFloat(r[COL_PEND.TOTAL - 1]    || '0') || '';
        filE[COL_E.NUM_COMPROBANTE-1] = r[COL_PEND.NUM_FAC - 1] || '';
        filE[COL_E.DRIVE_URL - 1]     = r[COL_PEND.DRIVE_URL - 1]   || '';
        filE[COL_E.ESTADO - 1]        = 'registrado';
        filE[COL_E.FUENTE - 1]        = 'acreedor_auto';
        var lastRowE = sheetE.getLastRow() + 1;
        sheetE.getRange(lastRowE, 1, 1, EGRESOS_NCOLS).setValues([filE]);
        sheetE.getRange(lastRowE, 1, 1, EGRESOS_NCOLS).setBackground('#E8F5E9');
      }

      // Actualizar pendiente
      sheet.getRange(rowNum, COL_PEND.ESTADO).setValue('aprobado');
      sheet.getRange(rowNum, COL_PEND.EGRESO_ID).setValue(egresoId);
      sheet.getRange(rowNum, 1, 1, PEND_NCOLS).setBackground('#E8F5E9');
      found = true;
      result.egreso_id = egresoId;
      Logger.log('✅ Acreedor aprobado: ' + id + ' → ' + egresoId);
      break;
    }
    if (!found) throw new Error('Pendiente no encontrado: ' + id);
    result.success = true;
  } catch(err) { result.error = err.message; }
  return _jsonpAcr(result, callback);
}

function _handleRechazarAcreedor(params, callback) {
  var result = { success: false, error: null };
  try {
    var id = String(params.id || '').trim();
    if (!id) throw new Error('id requerido');
    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_ACREEDORES_PENDING);
    if (!sheet) throw new Error('Hoja Acreedores_Pending no encontrada');
    var data  = sheet.getRange(3, 1, sheet.getLastRow() - 2, PEND_NCOLS).getValues();
    var found = false;
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][COL_PEND.ID - 1]) !== id) continue;
      sheet.getRange(i + 3, COL_PEND.ESTADO).setValue('rechazado');
      sheet.getRange(i + 3, 1, 1, PEND_NCOLS).setBackground('#FFEBEE');
      found = true; break;
    }
    if (!found) throw new Error('Pendiente no encontrado: ' + id);
    result.success = true;
  } catch(err) { result.error = err.message; }
  return _jsonpAcr(result, callback);
}

function _handleEliminarPendienteAcr(params, callback) {
  var result = { success: false, error: null };
  try {
    var id = String(params.id || '').trim();
    if (!id) throw new Error('id requerido');
    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_ACREEDORES_PENDING);
    if (!sheet) throw new Error('Hoja Acreedores_Pending no encontrada');
    var data  = sheet.getRange(3, 1, sheet.getLastRow() - 2, PEND_NCOLS).getValues();
    var found = false;
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][COL_PEND.ID - 1]) !== id) continue;
      sheet.deleteRow(i + 3);
      found = true; break;
    }
    if (!found) throw new Error('Pendiente no encontrado: ' + id);
    result.success = true;
  } catch(err) { result.error = err.message; }
  return _jsonpAcr(result, callback);
}

function _handleSincronizarAcreedores(params, callback) {
  var result = { success: false, procesados: 0, nuevos: 0, ignorados: 0, errores: [], error: null };
  try {
    var stats      = _sincronizarEmailsAcreedores();
    result.success   = true;
    result.procesados = stats.procesados;
    result.nuevos    = stats.nuevos;
    result.ignorados = stats.ignorados;
    result.errores   = stats.errores;
  } catch(err) { result.error = err.message; }
  return _jsonpAcr(result, callback);
}

// ═══════════════════════════════════════════════════════════════
//  HANDLERS doPost
// ═══════════════════════════════════════════════════════════════

function _handleGuardarAcreedor(data) {
  try {
    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_ACREEDORES_CONFIG) || _initAcreedoresSheets(ss);
    var nombre = String(data.nombre || '').trim();
    var ruc    = String(data.ruc    || '').trim();
    if (!nombre) throw new Error('nombre es obligatorio');
    var ahora = new Date();
    var driveEjemplo = '';
    if (data.imageBase64 && data.mimeType) {
      try {
        var cfg2  = _getConfig();
        var folder2 = DriveApp.getFolderById(cfg2.drive_folder_id);
        var bytes2  = Utilities.base64Decode(data.imageBase64);
        var ext2    = data.mimeType === 'application/pdf' ? 'pdf' : 'jpg';
        var blob2   = Utilities.newBlob(bytes2, data.mimeType, 'AcrEjemplo_' + nombre.replace(/\s+/g,'_') + '.' + ext2);
        var file2   = folder2.createFile(blob2);
        file2.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        driveEjemplo = 'https://drive.google.com/file/d/' + file2.getId() + '/view';
      } catch(driveErr) { Logger.log('No se pudo guardar ejemplo acreedor: ' + driveErr.message); }
    }
    if (data.id) {
      var rows  = sheet.getRange(3, 1, sheet.getLastRow() - 2, ACR_NCOLS).getValues();
      var found = false;
      for (var i = 0; i < rows.length; i++) {
        if (String(rows[i][COL_ACR.ID - 1]) !== String(data.id)) continue;
        var rowNum = i + 3;
        sheet.getRange(rowNum, COL_ACR.NOMBRE).setValue(nombre);
        sheet.getRange(rowNum, COL_ACR.RUC).setValue(ruc);
        sheet.getRange(rowNum, COL_ACR.DV).setValue(data.dv || '');
        sheet.getRange(rowNum, COL_ACR.KEYWORDS).setValue(String(data.keywords || '').replace(/,/g,'|'));
        sheet.getRange(rowNum, COL_ACR.CATEGORIA_DEF).setValue(data.categoria_def || '');
        sheet.getRange(rowNum, COL_ACR.PROMPT_OVERRIDE).setValue(data.prompt_override || '');
        if (driveEjemplo) sheet.getRange(rowNum, COL_ACR.DRIVE_EJEMPLO).setValue(driveEjemplo);
        found = true; break;
      }
      if (!found) throw new Error('Acreedor no encontrado: ' + data.id);
      _acreedoresCache = null;
      return _jsonAcr({ success: true, id: data.id });
    } else {
      var lastRow2 = sheet.getLastRow();
      var seq      = 1;
      if (lastRow2 > 2) {
        var ids2 = sheet.getRange(3, COL_ACR.ID, lastRow2 - 2, 1).getValues();
        for (var j = ids2.length - 1; j >= 0; j--) {
          var parts = String(ids2[j][0] || '').split('-');
          var n     = parseInt(parts[parts.length - 1], 10);
          if (!isNaN(n)) { seq = n + 1; break; }
        }
      }
      var newId = 'ACR-' + String(seq).padStart(3, '0');
      var fila  = new Array(ACR_NCOLS);
      for (var x = 0; x < ACR_NCOLS; x++) fila[x] = '';
      fila[COL_ACR.ID - 1]             = newId;
      fila[COL_ACR.NOMBRE - 1]         = nombre;
      fila[COL_ACR.RUC - 1]            = ruc;
      fila[COL_ACR.DV - 1]             = data.dv              || '';
      fila[COL_ACR.KEYWORDS - 1]       = String(data.keywords || '').replace(/,/g,'|');
      fila[COL_ACR.CATEGORIA_DEF - 1]  = data.categoria_def   || '';
      fila[COL_ACR.PROMPT_OVERRIDE -1] = data.prompt_override  || '';
      fila[COL_ACR.ACTIVO - 1]         = true;
      fila[COL_ACR.FECHA_ALTA - 1]     = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd');
      fila[COL_ACR.DRIVE_EJEMPLO - 1]  = driveEjemplo;
      fila[COL_ACR.NOTAS - 1]          = data.notas || '';
      sheet.getRange(sheet.getLastRow() + 1, 1, 1, ACR_NCOLS).setValues([fila]);
      _acreedoresCache = null;
      Logger.log('Acreedor creado: ' + newId + ' | ' + nombre);
      return _jsonAcr({ success: true, id: newId });
    }
  } catch(err) {
    Logger.log('Error guardarAcreedor: ' + err.message);
    return _jsonAcr({ success: false, error: err.message });
  }
}

function _handleAnalizarFacturaAcreedor(data) {
  try {
    var b64      = data.imageBase64 || '';
    var mimeType = data.mimeType    || 'application/pdf';
    if (!b64) throw new Error('imageBase64 requerido');
    var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
    if (!apiKey) throw new Error('CLAUDE_API_KEY no configurada');
    var catList = CATEGORIAS_ACREEDOR.map(function(c) { return c.valor + ' - ' + c.label; }).join('\n');
    var contentBlock = mimeType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
      : { type: 'image',    source: { type: 'base64', media_type: mimeType,           data: b64 } };
    var payload = {
      model:    'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: [
        contentBlock,
        { type: 'text', text:
          'Analiza esta factura panameña de un proveedor de servicios (gasto operativo).\n' +
          'Responde SOLO con JSON válido, sin markdown:\n' +
          '{"nombre_proveedor":"","ruc":"","dv":"","tiene_itbms":true,' +
          '"keywords":"","notas_formato":"","categoria_sugerida":"","confianza_categoria":0}\n' +
          'categoria_sugerida debe ser uno de:\n' + catList + '\n' +
          'keywords = palabras clave para identificar al emisor en nombres de archivo.\n' +
          'Si un campo no está visible usar null.'
        }
      ]}]
    };
    var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post', contentType: 'application/json',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify(payload), muteHttpExceptions: true,
    });
    if (resp.getResponseCode() !== 200) throw new Error('Claude error ' + resp.getResponseCode());
    var text    = '';
    var content = JSON.parse(resp.getContentText()).content || [];
    for (var i = 0; i < content.length; i++) {
      if (content[i].type === 'text') { text = content[i].text; break; }
    }
    var parsed  = JSON.parse(text.replace(/```json|```/g, '').trim());
    parsed.success = true;
    return ContentService.createTextOutput(JSON.stringify(parsed)).setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    Logger.log('Error analizarFacturaAcreedor: ' + err.message);
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function _handleActualizarPendienteAcr(data) {
  try {
    var id = String(data.id || '').trim();
    if (!id) throw new Error('id requerido');
    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_ACREEDORES_PENDING);
    if (!sheet) throw new Error('Hoja no encontrada');
    var rows  = sheet.getRange(3, 1, sheet.getLastRow() - 2, PEND_NCOLS).getValues();
    var found = false;
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][COL_PEND.ID - 1]) !== id) continue;
      var rowNum = i + 3;
      if (data.categoria)   sheet.getRange(rowNum, COL_PEND.CATEGORIA).setValue(data.categoria);
      if (data.descripcion) sheet.getRange(rowNum, COL_PEND.DESCRIPCION).setValue(data.descripcion);
      if (data.total)       sheet.getRange(rowNum, COL_PEND.TOTAL).setValue(parseFloat(data.total)||0);
      if (data.itbms)       sheet.getRange(rowNum, COL_PEND.ITBMS).setValue(parseFloat(data.itbms)||0);
      if (data.subtotal)    sheet.getRange(rowNum, COL_PEND.SUBTOTAL).setValue(parseFloat(data.subtotal)||0);
      found = true; break;
    }
    if (!found) throw new Error('Pendiente no encontrado: ' + id);
    return _jsonAcr({ success: true });
  } catch(err) {
    return _jsonAcr({ success: false, error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
//  TRIGGER
// ═══════════════════════════════════════════════════════════════

function procesarEmailsAcreedores() {
  try {
    var stats = _sincronizarEmailsAcreedores();
    Logger.log('Trigger Acreedores: ' + JSON.stringify(stats));
  } catch(err) {
    Logger.log('Error trigger Acreedores: ' + err.message);
  }
}

function installAcreedoresTrigger(intervaloMin) {
  intervaloMin = intervaloMin || 15;
  removeAcreedoresTrigger();
  ScriptApp.newTrigger('procesarEmailsAcreedores').timeBased()
    .everyMinutes(intervaloMin).create();
  Logger.log('Trigger Acreedores instalado — cada ' + intervaloMin + ' min');
}

function removeAcreedoresTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'procesarEmailsAcreedores') {
      ScriptApp.deleteTrigger(triggers[i]);
      Logger.log('Trigger Acreedores removido');
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  SETUP
// ═══════════════════════════════════════════════════════════════

function initAcreedoresSheets() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  _initAcreedoresConfigSheet(ss);
  _initAcresPendingSheet(ss);
  Logger.log('Acreedores: hojas inicializadas.');
}

function _initAcreedoresSheets(ss) {
  _initAcreedoresConfigSheet(ss);
  _initAcresPendingSheet(ss);
  return ss.getSheetByName(SHEET_ACREEDORES_CONFIG);
}

function _initAcreedoresConfigSheet(ss) {
  if (ss.getSheetByName(SHEET_ACREEDORES_CONFIG)) { Logger.log('Acreedores_Config ya existe.'); return; }
  var sheet = ss.insertSheet(SHEET_ACREEDORES_CONFIG);
  SpreadsheetApp.flush();
  var meta    = ['ID','DATOS FISCALES','','','DETECCION IA','CATEGORIA','CONFIG','','','ARCHIVO','NOTAS'];
  var headers = ['id_acreedor','nombre','ruc','dv','keywords_deteccion','categoria_default','prompt_override','activo','fecha_alta','drive_url_ejemplo','notas'];
  sheet.getRange(1, 1, 1, ACR_NCOLS).setValues([meta]);
  sheet.getRange(1, 1, 1, ACR_NCOLS).setBackground('#4A148C').setFontColor('#FFF').setFontWeight('bold');
  sheet.getRange(2, 1, 1, ACR_NCOLS).setValues([headers]);
  sheet.getRange(2, 1, 1, ACR_NCOLS).setBackground('#6A1B9A').setFontColor('#FFF').setFontWeight('bold');
  sheet.setFrozenRows(2);
  Logger.log('Hoja Acreedores_Config creada.');
}

function _initAcresPendingSheet(ss) {
  if (ss.getSheetByName(SHEET_ACREEDORES_PENDING)) { Logger.log('Acreedores_Pending ya existe.'); return; }
  var sheet = ss.insertSheet(SHEET_ACREEDORES_PENDING);
  SpreadsheetApp.flush();
  var meta    = ['ID','REG','ESTADO','ACREEDOR','','FACTURA','','MONTOS','','','CLASIFICACION','NOTAS','','','EGRESO','MSG'];
  var headers = ['id_pendiente','fecha_registro','estado','acreedor_id','nombre_acreedor','fecha_factura','num_factura','subtotal','itbms','total','categoria','descripcion','drive_url','notas','egreso_id','gmail_message_id'];
  sheet.getRange(1, 1, 1, PEND_NCOLS).setValues([meta]);
  sheet.getRange(1, 1, 1, PEND_NCOLS).setBackground('#4A148C').setFontColor('#FFF').setFontWeight('bold');
  sheet.getRange(2, 1, 1, PEND_NCOLS).setValues([headers]);
  sheet.getRange(2, 1, 1, PEND_NCOLS).setBackground('#6A1B9A').setFontColor('#FFF').setFontWeight('bold');
  sheet.setFrozenRows(2);
  sheet.getRange('H3:J1000').setNumberFormat('#,##0.00');
  Logger.log('Hoja Acreedores_Pending creada.');
}

// ── Micro-helpers ─────────────────────────────────────────────
function _jsonpAcr(obj, callback) {
  var json = JSON.stringify(obj);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}
function _jsonAcr(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
