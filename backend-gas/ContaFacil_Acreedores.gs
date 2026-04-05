// ═══════════════════════════════════════════════════════════════
//  ContaFacil_Acreedores.gs  - v1.0
//  Módulo: Acreedores y egresos generales automáticos
//
//  Independiente de Comercialización - puede desplegarse solo.
//  Comparte CONFIG.SHEET_ID, COL_E, EGRESOS_NCOLS de Code.gs.
//
//  ARQUITECTURA:
//    - Hoja propia: Acreedores_Config  (lista de acreedores)
//    - Hoja propia: Acreedores_Pending (egresos en estado borrador)
//    - Escribe en: Egresos (al aprobar)
//    - Label Gmail propio: cf_acreedor_procesado
//    - Trigger propio: procesarEmailsAcreedores() - independiente de Op.
//
//  FLUJO:
//    1. Cliente reenvía facturas a facturas@balanceclip.net
//    2. Trigger cada 15 min ejecuta procesarEmailsAcreedores()
//    3. Por cada email no procesado:
//       a. Lee adjuntos PDF
//       b. Claude Haiku clasifica si el emisor es un acreedor configurado
//       c. Si sí → Claude Sonnet parsea → crea egreso en estado 'borrador'
//          en hoja Acreedores_Pending, con categoria sugerida por IA
//       d. Si no → ignora silenciosamente, pone label cf_acreedor_procesado
//    4. El usuario ve los borradores en Registro General → Acreedores
//       y aprueba, edita o elimina cada uno
//    5. Al aprobar → se escribe en Egresos con estado 'registrado'
//
//  SETUP:
//    1. Ejecutar initAcreedoresSheets()
//    2. Ejecutar installAcreedoresTrigger()
//    3. Crear label Gmail: "cf_acreedor_procesado"
// ═══════════════════════════════════════════════════════════════

// ── CONSTANTES ───────────────────────────────────────────────
var SHEET_ACREEDORES_CONFIG  = 'Acreedores_Config';
var SHEET_ACREEDORES_PENDING = 'Acreedores_Pending';
var LABEL_ACREEDOR           = 'cf_acreedor_procesado';

// Categorias fiscales disponibles para egresos de acreedores
// Alineadas con Formulario 03 DGI Panamá y buenas prácticas contables
var CATEGORIAS_ACREEDOR = [
  { valor: 'alquiler_local',              label: 'Alquiler de local / oficina' },
  { valor: 'servicios_publicos',          label: 'Servicios publicos (agua, luz)' },
  { valor: 'internet_telecomunicaciones', label: 'Internet y telecomunicaciones' },
  { valor: 'seguros',                     label: 'Seguros' },
  { valor: 'mantenimiento_reparacion',    label: 'Mantenimiento y reparaciones' },
  { valor: 'servicios_profesionales',     label: 'Servicios profesionales (legal, contable)' },
  { valor: 'publicidad_marketing',        label: 'Publicidad y marketing' },
  { valor: 'transporte_combustible',      label: 'Transporte y combustible' },
  { valor: 'suministros_oficina',         label: 'Suministros de oficina' },
  { valor: 'planilla_empleados',          label: 'Planilla y cargas sociales' },
  { valor: 'financiero_bancario',         label: 'Gastos financieros y bancarios' },
  { valor: 'capacitacion',               label: 'Capacitacion y formacion' },
  { valor: 'tecnologia_software',         label: 'Tecnologia y software' },
  { valor: 'otros_gastos_generales',      label: 'Otros gastos generales' },
];

// ── COLUMNAS Acreedores_Config (base 1) ──────────────────────
// Fila 1 = meta, fila 2 = headers, datos desde fila 3
var COL_ACR = {
  ID:              1,   // A  id_acreedor
  NOMBRE:          2,   // B  nombre
  RUC:             3,   // C  ruc
  DV:              4,   // D  dv
  KEYWORDS:        5,   // E  keywords_deteccion
  CATEGORIA_DEF:   6,   // F  categoria_default
  PROMPT_OVERRIDE: 7,   // G  prompt_override
  ACTIVO:          8,   // H  activo
  FECHA_ALTA:      9,   // I  fecha_alta
  DRIVE_EJEMPLO:  10,   // J  drive_url_ejemplo
  NOTAS:          11,   // K  notas
};
var ACR_NCOLS = 11;

// ── COLUMNAS Acreedores_Pending (base 1) ─────────────────────
// Fila 1 = meta, fila 2 = headers, datos desde fila 3
var COL_PEND = {
  ID:           1,   // A  id_pendiente
  FECHA_REG:    2,   // B  fecha_registro
  ESTADO:       3,   // C  estado: borrador | aprobado | rechazado
  ACREEDOR_ID:  4,   // D  id_acreedor
  ACREEDOR_NOM: 5,   // E  nombre_acreedor
  FECHA_FAC:    6,   // F  fecha_factura
  NUM_FAC:      7,   // G  num_factura
  SUBTOTAL:     8,   // H  subtotal
  ITBMS:        9,   // I  itbms
  TOTAL:       10,   // J  total
  CATEGORIA:   11,   // K  categoria (sugerida por IA, editable)
  DESCRIPCION: 12,   // L  descripcion
  DRIVE_URL:   13,   // M  drive_url
  NOTAS:       14,   // N  notas
  EGRESO_ID:   15,   // O  egreso_id (vacio hasta aprobacion)
  MSG_ID:      16,   // P  gmail_message_id (para dedup)
};
var PEND_NCOLS = 16;

// ── CACHÉ ─────────────────────────────────────────────────────
var _acreedoresCache = null;

// ═══════════════════════════════════════════════════════════════
//  DISPATCH - registrar en doGet_Operaciones y doPost_Operaciones
//  de ContaFacil_Operaciones.gs
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
  if (action === 'guardarAcreedor')          return _handleGuardarAcreedor(data);
  if (action === 'analizarFacturaAcreedor')  return _handleAnalizarFacturaAcreedor(data);
  if (action === 'actualizarPendienteAcr')   return _handleActualizarPendienteAcr(data);
  return null;
}

// ═══════════════════════════════════════════════════════════════
//  HELPERS INTERNOS
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

// Igual que _matchearProveedor pero contra Acreedores_Config
function _matchearAcreedor(fileName, pdfB64) {
  var acreedores = _getAcreedores();
  var fnLower    = (fileName || '').toLowerCase();

  for (var i = 0; i < acreedores.length; i++) {
    var ac = acreedores[i];
    if (!ac.activo) continue;

    // 1. Match por RUC en nombre de archivo
    var rucNorm = (ac.ruc || '').replace(/[-\.]/g, '').toLowerCase();
    if (rucNorm && fnLower.indexOf(rucNorm) !== -1) {
      Logger.log('  Acreedor matcheado por RUC en archivo: ' + ac.nombre);
      return ac;
    }

    // 2. Match por keywords en nombre de archivo
    var keywords = (ac.keywords || '').toLowerCase().split(/[,|]/);
    for (var k = 0; k < keywords.length; k++) {
      var kw = keywords[k].trim();
      if (kw && fnLower.indexOf(kw) !== -1) {
        Logger.log('  Acreedor matcheado por keyword "' + kw + '": ' + ac.nombre);
        return ac;
      }
    }
  }
  return null; // No match por nombre - necesita Claude
}

// Clasificar con Claude si el emisor del PDF es algún acreedor configurado
function _claudeClasificarAcreedor(pdfB64) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) return null;

  var acreedores = _getAcreedores().filter(function(a) { return a.activo; });
  if (!acreedores.length) return null;

  var lista = acreedores.map(function(a) {
    return '- ' + a.nombre + (a.ruc ? ' (RUC ' + a.ruc + ')' : '');
  }).join('\n');

  var pregunta =
    'Analiza esta factura e identifica quien la EMITIO (el emisor/vendedor, NO el receptor/cliente).\n\n' +
    'LISTA DE ACREEDORES CONFIGURADOS:\n' + lista + '\n\n' +
    'Responde SOLO con JSON valido, sin markdown:\n' +
    '{"es_acreedor": true/false, "nombre_encontrado": "nombre exacto de la lista o null"}\n\n' +
    'es_acreedor = true SOLO si el emisor coincide con uno de los acreedores de la lista.\n' +
    'Si el emisor NO esta en la lista, responde es_acreedor: false.';

  try {
    var payload = {
      model: 'claude-haiku-4-5-20251001', max_tokens: 60,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfB64 } },
          { type: 'text', text: pregunta }
        ]
      }]
    };
    var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post', contentType: 'application/json',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify(payload), muteHttpExceptions: true,
    });
    var text = '';
    var content = JSON.parse(resp.getContentText()).content || [];
    for (var i = 0; i < content.length; i++) {
      if (content[i].type === 'text') { text = content[i].text; break; }
    }
    var parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    if (!parsed.es_acreedor) return null;

    // Buscar el acreedor cuyo nombre coincida con nombre_encontrado
    var nombreIA = String(parsed.nombre_encontrado || '').toLowerCase();
    for (var j = 0; j < acreedores.length; j++) {
      var a = acreedores[j];
      if (nombreIA && a.nombre.toLowerCase().indexOf(nombreIA.split(' ')[0]) !== -1) return a;
    }
    // Fallback: si Claude dice es_acreedor=true pero no matcheamos, retornar primer activo
    return acreedores[0] || null;
  } catch(e) {
    Logger.log('Error _claudeClasificarAcreedor: ' + e.message);
    return null;
  }
}

// Claude parsea el PDF y sugiere categoria + datos del egreso
function _claudeParsearFacturaAcreedor(pdfB64, acreedor) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY no configurada');

  var catList = CATEGORIAS_ACREEDOR.map(function(c) {
    return c.valor + ' - ' + c.label;
  }).join('\n');

  var promptExtra = acreedor && acreedor.prompt_override
    ? '\nNota especifica del acreedor: ' + acreedor.prompt_override
    : '';

  var prompt =
    'Analiza esta factura panamena y extrae sus datos.' + promptExtra + '\n\n' +
    'CATEGORIAS DE GASTO DISPONIBLES:\n' + catList + '\n\n' +
    'Responde SOLO con JSON valido, sin markdown:\n' +
    '{\n' +
    '  "num_factura": "",\n' +
    '  "fecha": "YYYY-MM-DD",\n' +
    '  "proveedor": "",\n' +
    '  "ruc_proveedor": "",\n' +
    '  "dv_proveedor": "",\n' +
    '  "subtotal": 0,\n' +
    '  "itbms": 0,\n' +
    '  "total": 0,\n' +
    '  "descripcion": "descripcion breve del concepto",\n' +
    '  "categoria_sugerida": "valor_exacto_de_la_lista",\n' +
    '  "confianza_categoria": 0\n' +
    '}\n\n' +
    'confianza_categoria: 0-100, que tan seguro estas de la categoria.\n' +
    'Si un campo no es visible usa null.';

  var payload = {
    model: 'claude-sonnet-4-20250514', max_tokens: 400,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfB64 } },
        { type: 'text', text: prompt }
      ]
    }]
  };

  var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload), muteHttpExceptions: true,
  });

  if (resp.getResponseCode() !== 200) throw new Error('Claude API error ' + resp.getResponseCode());

  var text = '';
  var content = JSON.parse(resp.getContentText()).content || [];
  for (var i = 0; i < content.length; i++) {
    if (content[i].type === 'text') { text = content[i].text; break; }
  }
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

// ═══════════════════════════════════════════════════════════════
//  TRIGGER Y SINCRONIZACIÓN
// ═══════════════════════════════════════════════════════════════

function installAcreedoresTrigger(intervaloMin) {
  intervaloMin = parseInt(intervaloMin || '15', 10);
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'procesarEmailsAcreedores') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('procesarEmailsAcreedores').timeBased()
    .everyMinutes(intervaloMin).create();
  Logger.log('Trigger Acreedores instalado - cada ' + intervaloMin + ' min');
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

// Función llamada por el trigger automático
function procesarEmailsAcreedores() {
  try {
    var stats = _sincronizarEmailsAcreedores();
    Logger.log('Trigger Acreedores: ' + JSON.stringify(stats));
  } catch(err) {
    Logger.log('Error trigger Acreedores: ' + err.message);
  }
}

function _sincronizarEmailsAcreedores() {
  var stats = { procesados: 0, nuevos: 0, ignorados: 0, errores: [] };

  // Construir query - misma lógica de cascada que Comercialización/ST
  // pero con label propio para no pisar los otros triggers
  var ss  = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var cfg = null;
  try {
    // Reutiliza _getConfig() de ContaFacil_Operaciones.gs si esta disponible
    cfg = _getConfig();
  } catch(e) {
    cfg = {};
  }

  var query;
  if (cfg.email_op_destino && cfg.email_op_remitente) {
    query = 'to:' + cfg.email_op_destino + ' from:' + cfg.email_op_remitente +
            ' has:attachment -label:' + LABEL_ACREEDOR;
  } else if (cfg.email_comprobantes) {
    query = 'to:' + cfg.email_comprobantes + ' has:attachment -label:' + LABEL_ACREEDOR;
  } else {
    Logger.log('Acreedores: email destino no configurado');
    return stats;
  }

  var label   = _getOrCreateLabelAcr(LABEL_ACREEDOR);
  var threads = GmailApp.search(query, 0, 50);

  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      try {
        var attachments  = msg.getAttachments();
        var msgId        = msg.getId();
        var todosListos  = true;  // asume que todos los PDFs del msg están procesados

        for (var a = 0; a < attachments.length; a++) {
          var att  = attachments[a];
          var mime = att.getContentType() || '';
          if (mime !== 'application/pdf') continue;

          var fileName = att.getName() || ('adjunto_' + a + '.pdf');
          var clave    = msgId + '|' + fileName;  // clave única por adjunto

          // Dedup primario: este adjunto específico ya fue procesado
          if (_pendientePorMsgIdFileName(clave)) {
            Logger.log('Acreedores: adjunto ya procesado: ' + fileName);
            continue;
          }

          var pdfBytes = att.getBytes();
          var pdfB64   = Utilities.base64Encode(pdfBytes);

          // 1. Match rápido por nombre de archivo
          var acreedor = _matchearAcreedor(fileName, null);

          // 2. Si no matcheó, usar Claude Haiku
          if (!acreedor) {
            acreedor = _claudeClasificarAcreedor(pdfB64);
          }

          if (!acreedor) {
            Logger.log('Acreedores: PDF no es de acreedor configurado: ' + fileName);
            stats.ignorados++;
            // Este adjunto no es de un acreedor — no bloquea el label del thread
            continue;
          }

          // 3. Es un acreedor — parsear con Claude Sonnet
          try {
            var parsed   = _claudeParsearFacturaAcreedor(pdfB64, acreedor);
            var driveUrl = _guardarPdfAcreedor(pdfBytes, fileName, acreedor.nombre, cfg);

            // Dedup secundario por num_factura + acreedor (mismo PDF en email diferente)
            if (parsed.num_factura && _pendienteYaExiste(parsed.num_factura, acreedor.id)) {
              Logger.log('Acreedores: factura ya existe: ' + parsed.num_factura);
              // Ya existe — marcar la clave para no reintentar
              _registrarClaveAcreedor(ss, clave, msgId, fileName);
              continue;
            }

            _crearPendiente(ss, acreedor, parsed, driveUrl, clave, msgId, fileName);
            stats.nuevos++;
            Logger.log('Acreedor procesado: ' + acreedor.nombre + ' | ' + (parsed.num_factura || 'SN'));
          } catch(parseErr) {
            stats.errores.push(fileName + ': ' + parseErr.message);
            Logger.log('Error parseando acreedor: ' + parseErr.message);
            todosListos = false;  // error en este adjunto — no poner label aún
          }
        }

        stats.procesados++;
        // Solo poner label si no hubo errores que requieran reintento
        if (todosListos) {
          threads[t].addLabel(label);
        }
      } catch(msgErr) {
        stats.errores.push('Mensaje ' + msgId + ': ' + msgErr.message);
      }
    }
  }
  return stats;
}

function _guardarPdfAcreedor(pdfBytes, fileName, nombreAcreedor, cfg) {
  try {
    var folderId = cfg ? (cfg.drive_folder_id || '') : '';
    if (!folderId) return '';
    var folder   = DriveApp.getFolderById(folderId);
    var nombre   = 'Acreedor_' + (nombreAcreedor || '').replace(/\s+/g,'_').substring(0,30) +
                   '_' + fileName;
    var blob     = Utilities.newBlob(pdfBytes, 'application/pdf', nombre);
    var file     = folder.createFile(blob);
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
        String(data[i][COL_PEND.ACREEDOR_ID - 1]) === String(acreedorId)) {
      return true;
    }
  }
  return false;
}

// Dedup por clave compuesta msgId|fileName — permite que un mismo email
// con multiples PDFs sea reprocesado hasta que todos sus adjuntos esten listos
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

// Registra una clave procesada sin crear pendiente (para duplicados por num_factura)
function _registrarClaveAcreedor(ss, clave, msgId, fileName) {
  var sheet = ss.getSheetByName(SHEET_ACREEDORES_PENDING);
  if (!sheet) return;
  // Buscar el pendiente existente con el mismo msgId base y actualizar su clave
  // si no tiene clave compuesta aún (migración hacia el nuevo formato)
  var data = sheet.getRange(3, 1, sheet.getLastRow() - 2, PEND_NCOLS).getValues();
  for (var i = 0; i < data.length; i++) {
    var existingClave = String(data[i][COL_PEND.MSG_ID - 1] || '');
    // Si ya tiene la clave compuesta exacta, no hacer nada
    if (existingClave === clave) return;
    // Si tiene el msgId base (formato antiguo), actualizar a clave compuesta
    if (existingClave === msgId) {
      sheet.getRange(i + 3, COL_PEND.MSG_ID).setValue(clave);
      return;
    }
  }
}

function _crearPendiente(ss, acreedor, parsed, driveUrl, clave, msgId, fileName) {
  var sheet = ss.getSheetByName(SHEET_ACREEDORES_PENDING);
  if (!sheet) throw new Error('Hoja Acreedores_Pending no encontrada. Ejecutar initAcreedoresSheets().');

  var ahora   = new Date();
  var fechaReg = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');

  // Generar ID
  var lastRow = sheet.getLastRow();
  var seq     = 1;
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

  // Categoria: prioridad a la default del acreedor (configurada por el admin),
  // IA como fallback si el acreedor no tiene default configurado.
  var catSugerida = acreedor.categoria_def || parsed.categoria_sugerida ||
                    CATEGORIAS_ACREEDOR[0].valor;

  var fila = new Array(PEND_NCOLS);
  for (var x = 0; x < PEND_NCOLS; x++) fila[x] = '';
  fila[COL_PEND.ID - 1]          = id;
  fila[COL_PEND.FECHA_REG - 1]   = fechaReg;
  fila[COL_PEND.ESTADO - 1]      = 'borrador';
  fila[COL_PEND.ACREEDOR_ID - 1] = acreedor.id;
  fila[COL_PEND.ACREEDOR_NOM -1] = acreedor.nombre;
  fila[COL_PEND.FECHA_FAC - 1]   = parsed.fecha    || '';
  fila[COL_PEND.NUM_FAC - 1]     = parsed.num_factura || '';
  fila[COL_PEND.SUBTOTAL - 1]    = parseFloat(parsed.subtotal || '0') || '';
  fila[COL_PEND.ITBMS - 1]       = parseFloat(parsed.itbms    || '0') || '';
  fila[COL_PEND.TOTAL - 1]       = parseFloat(parsed.total    || '0') || '';
  fila[COL_PEND.CATEGORIA - 1]   = catSugerida;
  fila[COL_PEND.DESCRIPCION - 1] = parsed.descripcion || acreedor.nombre;
  fila[COL_PEND.DRIVE_URL - 1]   = driveUrl;
  fila[COL_PEND.NOTAS - 1]       = 'IA confianza cat: ' + (parsed.confianza_categoria || '?') + '%';
  fila[COL_PEND.EGRESO_ID - 1]   = '';
  fila[COL_PEND.MSG_ID - 1]      = clave || msgId || '';  // clave compuesta msgId|fileName

  var newRow = sheet.getLastRow() + 1;
  sheet.getRange(newRow, 1, 1, PEND_NCOLS).setValues([fila]);
  sheet.getRange(newRow, COL_PEND.SUBTOTAL, 1, 3).setNumberFormat('#,##0.00');
  sheet.getRange(newRow, 1, 1, PEND_NCOLS).setBackground('#FFF9C4');  // amarillo = pendiente aprobacion
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
    var data  = sheet.getRange(3, 1, sheet.getLastRow() - 2, ACR_NCOLS).getValues();
    var found = false;
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][COL_ACR.ID - 1]) === String(id)) {
        sheet.getRange(i + 3, COL_ACR.ACTIVO).setValue(activo);
        found = true; break;
      }
    }
    if (!found) throw new Error('Acreedor no encontrado: ' + id);
    _acreedoresCache = null;
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
    var data  = sheet.getRange(3, 1, sheet.getLastRow() - 2, PEND_NCOLS).getValues();
    var items = [];
    for (var i = 0; i < data.length; i++) {
      var r = data[i];
      if (!r[COL_PEND.ID - 1]) continue;
      var estado = String(r[COL_PEND.ESTADO - 1] || '');
      if (estado === 'rechazado') continue; // ocultar rechazados
      var fecha = r[COL_PEND.FECHA_FAC - 1];
      if (fecha instanceof Date) {
        fecha = Utilities.formatDate(fecha, 'America/Panama', 'yyyy-MM-dd');
      } else { fecha = String(fecha || '').slice(0, 10); }
      items.push({
        id:           r[COL_PEND.ID - 1],
        fecha_reg:    r[COL_PEND.FECHA_REG - 1],
        estado:       estado,
        acreedor_id:  r[COL_PEND.ACREEDOR_ID - 1],
        acreedor_nom: r[COL_PEND.ACREEDOR_NOM - 1],
        fecha_fac:    fecha,
        num_fac:      r[COL_PEND.NUM_FAC - 1],
        subtotal:     parseFloat(r[COL_PEND.SUBTOTAL - 1]) || 0,
        itbms:        parseFloat(r[COL_PEND.ITBMS - 1])    || 0,
        total:        parseFloat(r[COL_PEND.TOTAL - 1])     || 0,
        categoria:    r[COL_PEND.CATEGORIA - 1],
        descripcion:  r[COL_PEND.DESCRIPCION - 1],
        drive_url:    r[COL_PEND.DRIVE_URL - 1],
        notas:        r[COL_PEND.NOTAS - 1],
        egreso_id:    r[COL_PEND.EGRESO_ID - 1],
        _row:         i + 3,
      });
    }
    // Ordenar: borradores primero, luego por fecha desc
    items.sort(function(a, b) {
      if (a.estado === 'borrador' && b.estado !== 'borrador') return -1;
      if (b.estado === 'borrador' && a.estado !== 'borrador') return 1;
      return String(b.fecha_fac).localeCompare(String(a.fecha_fac));
    });
    result.success = true;
    result.items   = items;
  } catch(err) { result.error = err.message; Logger.log('Error getPendientes: ' + err.message); }
  return _jsonpAcr(result, callback);
}

function _handleAprobarAcreedor(params, callback) {
  var result = { success: false, egresoId: null, error: null };
  try {
    var id        = String(params.id        || '').trim();
    var categoria = String(params.categoria || '').trim();
    if (!id)        throw new Error('id requerido');
    if (!categoria) throw new Error('categoria requerida');

    var ss        = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheetPend = ss.getSheetByName(SHEET_ACREEDORES_PENDING);
    if (!sheetPend) throw new Error('Hoja Acreedores_Pending no encontrada');

    var data  = sheetPend.getRange(3, 1, sheetPend.getLastRow() - 2, PEND_NCOLS).getValues();
    var found = false;
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][COL_PEND.ID - 1]) !== id) continue;
      var rowNum = i + 3;
      var r      = data[i];

      // Registrar en hoja Egresos
      var sheetEgr = ss.getSheetByName(SHEET_EGRESOS);
      if (!sheetEgr) throw new Error('Hoja Egresos no encontrada');

      var ahora     = new Date();
      var fechaReg  = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
      var fechaGasto = String(r[COL_PEND.FECHA_FAC - 1] || '').slice(0, 10) ||
                       Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd');
      var fechaDate = new Date(fechaGasto + 'T12:00:00');
      var mes       = isNaN(fechaDate.getTime()) ? ahora.getMonth() + 1 : fechaDate.getMonth() + 1;
      var anio      = isNaN(fechaDate.getTime()) ? ahora.getFullYear() : fechaDate.getFullYear();

      var total    = parseFloat(r[COL_PEND.TOTAL - 1])    || 0;
      var itbms    = parseFloat(r[COL_PEND.ITBMS - 1])    || 0;
      var subtotal = parseFloat(r[COL_PEND.SUBTOTAL - 1]) || parseFloat((total - itbms).toFixed(2));

      // Generar ID egreso
      var lastEgr = sheetEgr.getLastRow();
      var seqEgr  = 1;
      if (lastEgr > 2) {
        var idsEgr = sheetEgr.getRange(3, COL_E.ID, lastEgr - 2, 1).getValues();
        for (var ke = idsEgr.length - 1; ke >= 0; ke--) {
          var ve = String(idsEgr[ke][0] || '').split('-');
          var ne = parseInt(ve[ve.length - 1], 10);
          if (!isNaN(ne)) { seqEgr = ne + 1; break; }
        }
      }
      var cfg      = _getConfig();
      var prefijo  = (cfg && cfg.prefijo_id) ? cfg.prefijo_id : 'CF';
      var egresoId = 'EGR-' + prefijo + '-' + anio + '-' + String(seqEgr).padStart(4, '0');

      // Acreedor info
      var acreedorNom = String(r[COL_PEND.ACREEDOR_NOM - 1] || '');
      var acreedorId  = String(r[COL_PEND.ACREEDOR_ID - 1]  || '');
      var acreedores  = _getAcreedores();
      var acrObj      = null;
      for (var aj = 0; aj < acreedores.length; aj++) {
        if (acreedores[aj].id === acreedorId) { acrObj = acreedores[aj]; break; }
      }

      var fila = new Array(EGRESOS_NCOLS);
      for (var x = 0; x < EGRESOS_NCOLS; x++) fila[x] = '';
      fila[COL_E.ID - 1]          = egresoId;
      fila[COL_E.FECHA_REG - 1]   = fechaReg;
      fila[COL_E.ESTADO - 1]      = 'registrado';
      fila[COL_E.FECHA_GASTO - 1] = fechaGasto;
      fila[COL_E.MES - 1]         = mes;
      fila[COL_E.ANIO - 1]        = anio;
      fila[COL_E.SUBTOTAL - 1]    = subtotal || '';
      fila[COL_E.ITBMS - 1]       = itbms    || '';
      fila[COL_E.TOTAL - 1]       = total    || '';
      fila[COL_E.MONEDA - 1]      = 'USD';
      fila[COL_E.TIPO_EGRESO - 1] = categoria;  // la categoria aprobada es el tipo
      fila[COL_E.CATEGORIA - 1]   = categoria;
      fila[COL_E.PROVEEDOR - 1]   = acreedorNom;
      fila[COL_E.RUC_PROV - 1]    = acrObj ? (acrObj.ruc || '') : '';
      fila[COL_E.DV_PROV - 1]     = acrObj ? (acrObj.dv  || '') : '';
      fila[COL_E.NFACTURA - 1]    = r[COL_PEND.NUM_FAC - 1]     || '';
      fila[COL_E.DRIVE_URL - 1]   = r[COL_PEND.DRIVE_URL - 1]   || '';
      fila[COL_E.DESCRIPCION - 1] = r[COL_PEND.DESCRIPCION - 1] || acreedorNom;
      fila[COL_E.NOTAS - 1]       = 'Aprobado desde Acreedores | ' + (r[COL_PEND.NOTAS - 1] || '');

      var newEgrRow = sheetEgr.getLastRow() + 1;
      sheetEgr.getRange(newEgrRow, 1, 1, EGRESOS_NCOLS).setValues([fila]);
      sheetEgr.getRange(newEgrRow, COL_E.SUBTOTAL, 1, 3).setNumberFormat('#,##0.00');
      sheetEgr.getRange(newEgrRow, 1, 1, EGRESOS_NCOLS).setBackground('#F1F8E9');

      // Actualizar Acreedores_Pending
      sheetPend.getRange(rowNum, COL_PEND.ESTADO).setValue('aprobado');
      sheetPend.getRange(rowNum, COL_PEND.CATEGORIA).setValue(categoria);
      sheetPend.getRange(rowNum, COL_PEND.EGRESO_ID).setValue(egresoId);
      sheetPend.getRange(rowNum, 1, 1, PEND_NCOLS).setBackground('#E8F5E9');

      result.success  = true;
      result.egresoId = egresoId;
      found = true;
      Logger.log('Acreedor aprobado: ' + id + ' -> Egreso: ' + egresoId);
      break;
    }
    if (!found) throw new Error('Pendiente no encontrado: ' + id);
  } catch(err) { result.error = err.message; Logger.log('Error aprobar: ' + err.message); }
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
      var rowNum = i + 3;
      sheet.getRange(rowNum, COL_PEND.ESTADO).setValue('rechazado');
      sheet.getRange(rowNum, 1, 1, PEND_NCOLS).setBackground('#FFEBEE');
      found = true; break;
    }
    if (!found) throw new Error('Pendiente no encontrado: ' + id);
    result.success = true;
  } catch(err) { result.error = err.message; }
  return _jsonpAcr(result, callback);
}

// Elimina permanentemente un pendiente del Sheet (no deja rastro)
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
      found = true;
      Logger.log('Pendiente eliminado permanentemente: ' + id);
      break;
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
    result.success  = true;
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

    // Guardar factura ejemplo en Drive si viene base64
    var driveEjemplo = '';
    if (data.imageBase64 && data.mimeType) {
      try {
        var cfg    = _getConfig();
        var folder = DriveApp.getFolderById(cfg.drive_folder_id);
        var bytes  = Utilities.base64Decode(data.imageBase64);
        var ext    = data.mimeType === 'application/pdf' ? 'pdf' : 'jpg';
        var blob   = Utilities.newBlob(bytes, data.mimeType,
                       'AcreedorEjemplo_' + nombre.replace(/\s+/g,'_') + '.' + ext);
        var file   = folder.createFile(blob);
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        driveEjemplo = 'https://drive.google.com/file/d/' + file.getId() + '/view';
      } catch(driveErr) {
        Logger.log('No se pudo guardar ejemplo acreedor: ' + driveErr.message);
      }
    }

    if (data.id) {
      // Editar existente
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
        found = true;
        break;
      }
      if (!found) throw new Error('Acreedor no encontrado: ' + data.id);
      _acreedoresCache = null;
      return _jsonAcr({ success: true, id: data.id });
    } else {
      // Nuevo
      var lastRow = sheet.getLastRow();
      var seq     = 1;
      if (lastRow > 2) {
        var ids = sheet.getRange(3, COL_ACR.ID, lastRow - 2, 1).getValues();
        for (var j = ids.length - 1; j >= 0; j--) {
          var parts = String(ids[j][0] || '').split('-');
          var n     = parseInt(parts[parts.length - 1], 10);
          if (!isNaN(n)) { seq = n + 1; break; }
        }
      }
      var newId = 'ACR-' + String(seq).padStart(3, '0');

      var fila = new Array(ACR_NCOLS);
      for (var x = 0; x < ACR_NCOLS; x++) fila[x] = '';
      fila[COL_ACR.ID - 1]             = newId;
      fila[COL_ACR.NOMBRE - 1]         = nombre;
      fila[COL_ACR.RUC - 1]            = ruc;
      fila[COL_ACR.DV - 1]             = data.dv              || '';
      fila[COL_ACR.KEYWORDS - 1]       = String(data.keywords || '').replace(/,/g,'|');
      fila[COL_ACR.CATEGORIA_DEF - 1]  = data.categoria_def  || '';
      fila[COL_ACR.PROMPT_OVERRIDE -1] = data.prompt_override || '';
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

// Analizar factura ejemplo y sugerir datos + categoria para el formulario
function _handleAnalizarFacturaAcreedor(data) {
  try {
    var b64      = data.imageBase64 || '';
    var mimeType = data.mimeType    || 'application/pdf';
    if (!b64) throw new Error('imageBase64 requerido');

    var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
    if (!apiKey) throw new Error('CLAUDE_API_KEY no configurada');

    var catList = CATEGORIAS_ACREEDOR.map(function(c) {
      return c.valor + ' - ' + c.label;
    }).join('\n');

    var contentBlock = mimeType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
      : { type: 'image',    source: { type: 'base64', media_type: mimeType,           data: b64 } };

    var payload = {
      model: 'claude-haiku-4-5-20251001', max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          contentBlock,
          { type: 'text', text:
            'Analiza esta factura panamena del EMISOR (proveedor/acreedor).\n' +
            'CATEGORIAS DE GASTO DISPONIBLES:\n' + catList + '\n\n' +
            'Responde SOLO con JSON valido, sin markdown:\n' +
            '{"nombre_acreedor":"","ruc":"","dv":"","tiene_itbms":true,' +
            '"formato_num_fac":"","keywords":"","categoria_sugerida":"valor_de_la_lista",' +
            '"confianza_categoria":0,"notas_formato":""}\n' +
            'keywords = palabras clave que identifican a este acreedor en nombre de archivo.\n' +
            'Si un campo no es visible usar null.'
          }
        ]
      }]
    };

    var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post', contentType: 'application/json',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify(payload), muteHttpExceptions: true,
    });
    if (resp.getResponseCode() !== 200) throw new Error('Claude error ' + resp.getResponseCode());

    var text = '';
    var content = JSON.parse(resp.getContentText()).content || [];
    for (var i = 0; i < content.length; i++) {
      if (content[i].type === 'text') { text = content[i].text; break; }
    }
    var parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    parsed.success = true;
    return ContentService.createTextOutput(JSON.stringify(parsed))
      .setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    Logger.log('Error analizarFacturaAcreedor: ' + err.message);
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Actualizar categoria/descripcion de un pendiente antes de aprobar
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
  if (ss.getSheetByName(SHEET_ACREEDORES_CONFIG)) {
    Logger.log('Acreedores_Config ya existe.');
    return;
  }
  var sheet = ss.insertSheet(SHEET_ACREEDORES_CONFIG);
  SpreadsheetApp.flush();
  var meta    = ['ID','DATOS FISCALES','','','DETECCION IA','CATEGORIA','CONFIG','','','ARCHIVO','NOTAS'];
  var headers = ['id_acreedor','nombre','ruc','dv','keywords_deteccion','categoria_default',
                 'prompt_override','activo','fecha_alta','drive_url_ejemplo','notas'];
  sheet.getRange(1, 1, 1, ACR_NCOLS).setValues([meta]);
  sheet.getRange(1, 1, 1, ACR_NCOLS).setBackground('#4A148C').setFontColor('#FFF').setFontWeight('bold');
  sheet.getRange(2, 1, 1, ACR_NCOLS).setValues([headers]);
  sheet.getRange(2, 1, 1, ACR_NCOLS).setBackground('#6A1B9A').setFontColor('#FFF').setFontWeight('bold');
  sheet.setFrozenRows(2);
  var w = [120,200,130,60,260,180,250,70,110,260,200];
  for (var i = 0; i < w.length; i++) sheet.setColumnWidth(i + 1, w[i]);
  Logger.log('Hoja Acreedores_Config creada.');
}

function _initAcresPendingSheet(ss) {
  if (ss.getSheetByName(SHEET_ACREEDORES_PENDING)) {
    Logger.log('Acreedores_Pending ya existe.');
    return;
  }
  var sheet = ss.insertSheet(SHEET_ACREEDORES_PENDING);
  SpreadsheetApp.flush();
  var meta    = ['ID','REG','ESTADO','ACREEDOR','','FACTURA','','MONTOS','','','CLASIFICACION','NOTAS','','','EGRESO','MSG'];
  var headers = ['id_pendiente','fecha_registro','estado','acreedor_id','nombre_acreedor',
                 'fecha_factura','num_factura','subtotal','itbms','total',
                 'categoria','descripcion','drive_url','notas','egreso_id','gmail_message_id'];
  sheet.getRange(1, 1, 1, PEND_NCOLS).setValues([meta]);
  sheet.getRange(1, 1, 1, PEND_NCOLS).setBackground('#4A148C').setFontColor('#FFF').setFontWeight('bold');
  sheet.getRange(2, 1, 1, PEND_NCOLS).setValues([headers]);
  sheet.getRange(2, 1, 1, PEND_NCOLS).setBackground('#6A1B9A').setFontColor('#FFF').setFontWeight('bold');
  sheet.setFrozenRows(2);
  var w2 = [160,150,90,100,180,100,160,90,70,90,180,250,260,220,150,200];
  for (var j = 0; j < w2.length; j++) sheet.setColumnWidth(j + 1, w2[j]);
  sheet.getRange('H3:J1000').setNumberFormat('#,##0.00');
  Logger.log('Hoja Acreedores_Pending creada.');
}

// ── Micro-helpers privados ────────────────────────────────────
function _jsonpAcr(obj, callback) {
  var json = JSON.stringify(obj);
  if (callback) return ContentService.createTextOutput(callback + '(' + json + ')')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}
function _jsonAcr(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
