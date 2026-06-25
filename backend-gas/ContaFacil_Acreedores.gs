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
var LABEL_ACREEDOR           = 'cf_acreedor_procesado';   // thread completamente procesado
var LABEL_ACREEDOR_PENDING   = 'cf_acreedor_pending';     // thread con rate limit, pendiente de retry
var LABEL_ACREEDOR_VISTO     = 'cf_acreedor_visto';       // PREFIJO; el label real lleva sufijo por-cliente (ver _labelAcrVisto)

// Sufijo corto y estable por cliente, derivado del SHEET_ID (único por
// cliente, inyectado por el deploy). CRÍTICO para los labels "visto": en
// el buzón compartido (facturas@/analisis@balanceclip.net) varios scripts
// de clientes corren bajo la MISMA cuenta de Gmail y comparten el namespace
// de labels. Sin sufijo, un cliente en modo broad podría marcar "visto" un
// thread de OTRO cliente broad y ocultárselo a su propio sync. Con sufijo
// por-cliente, cada uno excluye solo el suyo.
function _clientLabelTag() {
  var id = '';
  try { id = String(CONFIG.SHEET_ID || ''); } catch (e) {}
  var h = 0;
  for (var i = 0; i < id.length; i++) {
    h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

// Nombre completo del label "visto" de Acreedores para ESTE cliente.
function _labelAcrVisto() {
  return LABEL_ACREEDOR_VISTO + '_' + _clientLabelTag();
}

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
  // ─── NO DEDUCIBLES (auto-marcan alcance=personal) ─────────────
  { valor: 'gastos_alimentacion',      label: '🍽️ Gastos de Alimentación',           no_deducible: true },
  { valor: 'gastos_vestimenta',        label: '👕 Gastos de Vestimenta',             no_deducible: true },
  { valor: 'pension_alimenticia',      label: '👨‍👩‍👧 Pensión Alimenticia',                no_deducible: true },
  { valor: 'manutencion',              label: '💸 Manutención',                       no_deducible: true },
  { valor: 'viajes_recreativos',       label: '✈️ Viajes Recreativos',               no_deducible: true },
  { valor: 'fiestas_entretenimiento',  label: '🎉 Fiestas y Entretenimiento',         no_deducible: true },
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
  if (action === 'getFacturaXml')         return _handleGetFacturaXml(params, callback);
  return null;
}

function _handleGetFacturaXml(params, callback) {
  var fileId = params && (params.fileId || params.file_id);
  if (!fileId) return _jsonp({ success: false, error: 'fileId requerido' }, callback);
  try {
    var file = DriveApp.getFileById(fileId);
    var blob = file.getBlob();
    var xml  = blob.getDataAsString('UTF-8');
    return _jsonp({ success: true, xml: xml, name: file.getName(), mimeType: file.getMimeType() }, callback);
  } catch (e) {
    Logger.log('_handleGetFacturaXml error: ' + e.message);
    return _jsonp({ success: false, error: e.message }, callback);
  }
}

function doPost_Acreedores(action, data) {
  if (action === 'guardarAcreedor')            return _handleGuardarAcreedor(data);
  if (action === 'analizarFacturaAcreedor')    return _handleAnalizarFacturaAcreedor(data);
  if (action === 'actualizarPendienteAcr')     return _handleActualizarPendienteAcr(data);
  if (action === 'guardarPreferenciaAcreedor') return _handleGuardarPreferencia(data);
  if (action === 'actualizarAlcanceEgreso')    return _handleActualizarAlcanceEgreso(data);
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

  if (!dest) {
    Logger.log('Acreedores: email destino no configurado');
    return null;
  }

  // Query AMPLIO + validación de destino en código.
  //
  // Por qué amplio: Gmail NO indexa de forma confiable el alias destino
  // cuando el email viene por una cadena de auto-forward (proveedor →
  // gmail personal del cliente → caf_ → alias → hostinger → inbox).
  // En esos casos `to:<alias>` no matchea aunque el header
  // X-Forwarded-To / Received: for <alias> esté presente. Caso real:
  // factura PedidosYA #0044590513 confirmada visible en inbox pero
  // invisible para `to:`, `deliveredto:` y free-text del alias.
  //
  // Cubrimos ambos casos:
  //   1. Envíos directos al alias — siempre los matchea Gmail.
  //   2. Auto-forwards en cadena — NO los matchea Gmail; los detectamos
  //      validando que el alias aparezca en los headers del mensaje
  //      (función `_emailDestinoEsAlias` antes de procesar).
  //
  // `newer_than:14d` acota el universo a un periodo razonable. El
  // trigger corre cada 15 min, así que 14d cubre cualquier rezago.
  // Para backfill inicial se puede subir manualmente.
  // Estrategia de query — dos modos:
  //
  // MODO LABEL (multi-cliente Workspace):
  //   Si `email_acr_label` está configurado, el filtro nativo del
  //   buzón Workspace ya etiquetó los emails de ESTE cliente. Query
  //   directo: `label:<X> has:attachment -label:<processed>`. Esto
  //   AISLA cada cliente en un buzón compartido (crítico para evitar
  //   que el script de Iris robe emails de CEYCO o viceversa).
  //
  // MODO BROAD (legado, single-tenant):
  //   Sin `email_acr_label`, query amplio + validación
  //   `_emailDestinoEsAlias` en código. Necesario porque Gmail no
  //   indexa de forma confiable el alias en cadenas de auto-forward.
  //
  // En ambos modos `_esReenvioPermitidoAcr` aplica defense-in-depth.
  var inboxLabel = String(cfg.email_acr_label || '').trim();
  var base;
  if (inboxLabel) {
    base = 'label:' + inboxLabel + ' has:attachment -label:' + LABEL_ACREEDOR + ' newer_than:14d';
    Logger.log('📧 Query Acreedores (label-scoped): ' + base);
  } else {
    base = 'has:attachment -label:' + LABEL_ACREEDOR + ' -label:' + _labelAcrVisto() + ' newer_than:14d';
    Logger.log('📧 Query Acreedores (broad): ' + base + ' | dest=' + dest);
  }
  return base;
}

// Valida que el mensaje haya sido entregado/reenviado al alias
// configurado, escaneando el bloque de headers del raw content.
// Necesario porque el query es amplio (ver _getEmailAcrQuery).
function _emailDestinoEsAlias(msg, dest) {
  if (!dest) return true;
  try {
    var raw  = String(msg.getRawContent() || '').toLowerCase();
    var head = raw.substring(0, 12000);
    return head.indexOf(String(dest).toLowerCase()) !== -1;
  } catch (e) {
    Logger.log('  ⚠️ No se pudo validar destino: ' + e.message);
    return false;
  }
}

// Verifica que el email haya sido REENVIADO desde el remitente registrado.
// Aceptamos cualquiera de estos marcadores en los headers raw:
//   - X-Forwarded-For: <remitente> ...
//   - Return-Path: <remitente>+caf_=...@gmail.com  (Gmail confirmed-auto-forwarder)
//   - Delivered-To: <remitente>
// Esto soporta el caso real donde una persona reenvía facturas de
// múltiples proveedores a un alias central (facturas@balanceclip.net),
// sin abrir la puerta a spam de cualquier remitente.
// Verifica que el email haya sido REENVIADO desde el remitente registrado
// en config (`email_acr_remitente`). Aceptamos como evidencia cualquiera
// de estos marcadores en los headers raw:
//   1. <rem> exacto                     — X-Forwarded-For, Delivered-To,
//                                          Resent-From, Received: from
//   2. <localpart>+caf_=...@<domain>    — Gmail confirmed-auto-forwarder
//                                          rewrite del Return-Path (caso
//                                          de auto-forward Gmail nativo)
//
// Si no hay remitente configurado en cfg → return true (instalación
// sin restricción de origen). Si está configurado y el email no muestra
// ningún marcador → rechazamos.
function _esReenvioPermitidoAcr(msg) {
  var cfg = {};
  try { cfg = _getConfig(); } catch(e) {}

  var rem = String(cfg.email_acr_remitente || cfg.email_op_remitente || '').trim().toLowerCase();
  if (!rem) return true;

  var localPart = rem.split('@')[0] || rem;
  var pat_caf   = localPart + '+caf_';

  try {
    var raw  = String(msg.getRawContent() || '').toLowerCase();
    // Header block está al inicio. Limitamos a 12k para evitar leer body
    // grandes (PDFs base64 inflados pueden ser MB).
    var head = raw.substring(0, 12000);
    if (head.indexOf(rem)     !== -1) return true;
    if (head.indexOf(pat_caf) !== -1) return true;
    return false;
  } catch (e) {
    Logger.log('  ⚠️ No se pudo leer raw content para validar reenviador: ' + e.message);
    return true;
  }
}

// ═══════════════════════════════════════════════════════════════
//  RESET LABELS — utilidad de mantenimiento
//
//  Quita las labels cf_acreedor_procesado y procesado_cf_op de
//  todos los threads que matchean el email destino. Se usa cuando
//  hubo runs previos que aplicaron labels sin procesar
//  correctamente (ej. el bug del from: filter pre-fix).
//
//  Disponible vía POST { action:'resetLabelsAcreedores' } desde
//  el panel Configuración o ejecutable manual desde el editor.
// ═══════════════════════════════════════════════════════════════
function _handleResetLabelsAcreedores(data) {
  try {
    var cfg = _getConfig();
    var dest = (cfg.email_acr_destino || cfg.email_op_destino || cfg.email_comprobantes || '').trim();
    if (!dest) {
      return _jsonAcr({ success: false, error: 'Email destino no configurado' });
    }

    var query = 'to:' + dest + ' has:attachment (label:' + LABEL_ACREEDOR + ' OR label:' + LABEL_ACREEDOR_PENDING + ' OR label:' + _labelAcrVisto() + ' OR label:procesado_cf_op OR label:' + _labelOpVisto() + ')';
    var threads = GmailApp.search(query, 0, 200);
    Logger.log('🧹 Reset labels: encontrados ' + threads.length + ' threads para limpiar.');

    var labelAcr     = _getOrCreateLabelAcr(LABEL_ACREEDOR);
    var labelPending = null;
    try { labelPending = GmailApp.getUserLabelByName(LABEL_ACREEDOR_PENDING); } catch (e) {}
    var labelVisto = null;
    try { labelVisto = GmailApp.getUserLabelByName(_labelAcrVisto()); } catch (e) {}
    var labelOp = null;
    try { labelOp = GmailApp.getUserLabelByName('procesado_cf_op'); } catch (e) {}
    var labelOpVisto = null;
    try { labelOpVisto = GmailApp.getUserLabelByName(_labelOpVisto()); } catch (e) {}

    var removed = 0;
    for (var i = 0; i < threads.length; i++) {
      try { threads[i].removeLabel(labelAcr); } catch (e) {}
      if (labelPending) {
        try { threads[i].removeLabel(labelPending); } catch (e) {}
      }
      if (labelVisto) {
        try { threads[i].removeLabel(labelVisto); } catch (e) {}
      }
      if (labelOp) {
        try { threads[i].removeLabel(labelOp); } catch (e) {}
      }
      if (labelOpVisto) {
        try { threads[i].removeLabel(labelOpVisto); } catch (e) {}
      }
      removed++;
    }

    Logger.log('🧹 Labels removidas de ' + removed + ' threads. La próxima sync los reprocesará.');
    return _jsonAcr({ success: true, threads: removed });
  } catch (err) {
    Logger.log('❌ resetLabelsAcreedores: ' + err.message);
    return _jsonAcr({ success: false, error: err.message });
  }
}

// Ejecutable directo desde el editor de Apps Script si el usuario quiere
// disparar la limpieza manualmente sin frontend.
function resetLabelsAcreedoresManual() {
  var res = _handleResetLabelsAcreedores({});
  Logger.log(res.getContent());
}

// ═══════════════════════════════════════════════════════════════
//  PARSER MIME — soporte para bulk forward (.eml adjuntos)
//
//  Caso de uso: cuando el cliente selecciona N facturas en Gmail web
//  y usa "Reenviar como datos adjuntos", Gmail empaqueta cada email
//  como un attachment de tipo message/rfc822 (.eml). El email
//  contenedor llega a facturas@balanceclip.net con N adjuntos .eml,
//  cada uno con su propio PDF/XML de factura adentro.
//
//  _expandirEmlAdjuntos toma la lista de attachments del mensaje
//  outer y devuelve una lista plana donde cada .eml fue parseado
//  recursivamente y sus PDFs/XMLs internos fueron extraídos. El
//  resto del pipeline procesa esos adjuntos sintéticos como si
//  hubieran sido attachments directos del email outer.
// ═══════════════════════════════════════════════════════════════

function _expandirEmlAdjuntos(attachments) {
  var out = [];
  for (var i = 0; i < attachments.length; i++) {
    var att  = attachments[i];
    var name = String(att.getName() || '').toLowerCase();
    var mime = String(att.getContentType() || '').toLowerCase();
    var isEml = mime === 'message/rfc822' || name.endsWith('.eml');
    if (!isEml) { out.push(att); continue; }
    try {
      var raw   = att.getDataAsString();
      var inner = _parseEmlInnerAttachments(raw);
      Logger.log('  📦 .eml expandido: ' + att.getName() + ' → ' + inner.length + ' adjunto(s) interno(s)');
      for (var j = 0; j < inner.length; j++) out.push(inner[j]);
    } catch (e) {
      Logger.log('  ⚠️ No pude expandir .eml ' + att.getName() + ': ' + e.message);
    }
  }
  return out;
}

// Parsea un .eml (raw MIME) y extrae todos los PDFs / XMLs como
// objetos compatibles con la interfaz de GmailAttachment. Recursivo:
// soporta múltiples niveles de multipart y .eml anidados.
function _parseEmlInnerAttachments(raw) {
  return _parseMimeBody(raw);
}

function _parseMimeBody(raw) {
  var result = [];
  if (!raw) return result;

  var headerEnd = raw.search(/\r?\n\r?\n/);
  if (headerEnd === -1) return result;
  var headers = raw.substring(0, headerEnd);
  var body    = raw.substring(headerEnd).replace(/^\r?\n\r?\n/, '');

  var ct = _mimeHeader(headers, 'Content-Type');
  if (!ct) return result;

  if (/multipart\//i.test(ct)) {
    var bMatch = ct.match(/boundary\s*=\s*"?([^";\r\n]+)"?/i);
    if (!bMatch) return result;
    var boundary = '--' + bMatch[1];
    var parts = body.split(boundary);
    for (var p = 1; p < parts.length; p++) {
      var part = parts[p];
      // Skip closing boundary (which has -- after the dashes)
      if (part.charAt(0) === '-' && part.charAt(1) === '-') continue;
      part = part.replace(/^\r?\n/, '');
      var subs = _parseMimePart(part);
      for (var s = 0; s < subs.length; s++) result.push(subs[s]);
    }
    return result;
  }

  // Single-part top — parse as a part
  return _parseMimePart(raw);
}

function _parseMimePart(rawPart) {
  var result = [];
  var headerEnd = rawPart.search(/\r?\n\r?\n/);
  if (headerEnd === -1) return result;
  var headers = rawPart.substring(0, headerEnd);
  var body    = rawPart.substring(headerEnd).replace(/^\r?\n\r?\n/, '');

  var ct = _mimeHeader(headers, 'Content-Type');
  if (!ct) return result;
  var ctLow = ct.toLowerCase();

  // Recurse into nested multipart
  if (/multipart\//i.test(ct)) {
    var bMatch = ct.match(/boundary\s*=\s*"?([^";\r\n]+)"?/i);
    if (!bMatch) return result;
    var boundary = '--' + bMatch[1];
    var parts = body.split(boundary);
    for (var p = 1; p < parts.length; p++) {
      var part = parts[p];
      if (part.charAt(0) === '-' && part.charAt(1) === '-') continue;
      part = part.replace(/^\r?\n/, '');
      var subs = _parseMimePart(part);
      for (var s = 0; s < subs.length; s++) result.push(subs[s]);
    }
    return result;
  }

  // Recurse into nested message/rfc822 (forwarded email inside forwarded email)
  if (/message\/rfc822/i.test(ct)) {
    var nested = _parseMimeBody(body);
    for (var n = 0; n < nested.length; n++) result.push(nested[n]);
    return result;
  }

  // Leaf part — extract filename + content type
  var fileName = '';
  var disp = _mimeHeader(headers, 'Content-Disposition');
  if (disp) {
    var fnMatch = disp.match(/filename\s*=\s*"?([^";\r\n]+)"?/i);
    if (fnMatch) fileName = fnMatch[1].trim();
  }
  if (!fileName) {
    var nMatch = ct.match(/name\s*=\s*"?([^";\r\n]+)"?/i);
    if (nMatch) fileName = nMatch[1].trim();
  }

  var contentType = ctLow.split(';')[0].trim();
  var fnLow       = fileName.toLowerCase();

  var isPdf = contentType === 'application/pdf' || contentType === 'application/x-pdf' || fnLow.endsWith('.pdf');
  var isXml = contentType === 'text/xml' || contentType === 'application/xml' || fnLow.endsWith('.xml');
  var isOctet = contentType === 'application/octet-stream' && (fnLow.endsWith('.pdf') || fnLow.endsWith('.xml'));

  if (!isPdf && !isXml && !isOctet) return result;
  if (!fileName) fileName = isPdf ? 'inner.pdf' : 'inner.xml';

  var enc = _mimeHeader(headers, 'Content-Transfer-Encoding') || '7bit';
  enc = enc.toLowerCase().split(';')[0].trim();

  var bytes;
  try {
    if (enc === 'base64') {
      var clean = body.replace(/[\r\n\s]/g, '');
      bytes = Utilities.base64Decode(clean);
    } else if (enc === 'quoted-printable') {
      bytes = Utilities.newBlob(_decodeQuotedPrintable(body)).getBytes();
    } else {
      // 7bit / 8bit / binary — pass through
      bytes = Utilities.newBlob(body).getBytes();
    }
  } catch (e) {
    Logger.log('  ⚠️ No pude decodear ' + fileName + ' (' + enc + '): ' + e.message);
    return result;
  }

  var finalContentType = isXml ? (contentType === 'application/xml' ? 'application/xml' : 'text/xml')
                              : 'application/pdf';

  // Build attachment-like object compatible with GmailAttachment interface
  // (the existing pipeline calls getBytes / getName / getContentType / getDataAsString)
  result.push((function (b, n, c) {
    return {
      _isSyntheticEml: true,
      getBytes:        function () { return b; },
      getName:         function () { return n; },
      getContentType:  function () { return c; },
      getDataAsString: function () { return Utilities.newBlob(b).getDataAsString('UTF-8'); }
    };
  })(bytes, fileName, finalContentType));

  return result;
}

function _mimeHeader(headers, name) {
  // Find header by name, unfold continuation lines (CRLF + WSP)
  var re = new RegExp('^' + name + '\\s*:\\s*([^\\r\\n]+(?:\\r?\\n[ \\t][^\\r\\n]+)*)', 'im');
  var m  = headers.match(re);
  if (!m) return null;
  return m[1].replace(/\r?\n[ \t]+/g, ' ').trim();
}

function _decodeQuotedPrintable(s) {
  return String(s || '')
    .replace(/=\r?\n/g, '')                                                                              // soft line break
    .replace(/=([0-9A-F]{2})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); });
}

// ═══════════════════════════════════════════════════════════════
//  PARSER XML DGI PANAMA — fallback cuando el PDF adjunto está vacío
//
//  Algunos proveedores (Petróleos Delta, PedidosYa, webposonline, etc)
//  envían factura electrónica donde el PDF adjunto pesa 0 bytes y el
//  documento real es el XML firmado por DGI. El XML tiene todos los
//  campos estructurados, así que es MÁS confiable que OCR vía Claude.
// ═══════════════════════════════════════════════════════════════

function _findXmlAdjuntoEnLista(attachments) {
  for (var i = 0; i < attachments.length; i++) {
    var att  = attachments[i];
    var name = (att.getName() || '').toLowerCase();
    var mime = String(att.getContentType() || '').toLowerCase();
    if (mime === 'text/xml' || mime === 'application/xml' || name.indexOf('.xml') !== -1) {
      return att;
    }
  }
  return null;
}

// Helper namespace-agnostic — busca un child por nombre local sin
// importar el xmlns. Las facturas DGI usan dos namespaces anidados
// y XmlService los maneja, pero es más robusto buscar por nombre.
function _xmlChild(parent, name) {
  if (!parent) return null;
  var children = parent.getChildren();
  for (var i = 0; i < children.length; i++) {
    if (children[i].getName() === name) return children[i];
  }
  return null;
}

function _xmlText(parent, name) {
  var c = _xmlChild(parent, name);
  return c ? String(c.getText() || '').trim() : '';
}

function _parseFacturaXmlDgi(xmlString) {
  // Strip BOM si está presente
  if (xmlString && xmlString.charCodeAt(0) === 0xFEFF) {
    xmlString = xmlString.substring(1);
  }

  var doc  = XmlService.parse(xmlString);
  var root = doc.getRootElement(); // rContFe

  // Navegar rContFe → xFe → rFE → gDGen / gItem / gTot
  var xFe = _xmlChild(root, 'xFe');
  if (!xFe) throw new Error('XML no contiene <xFe>');
  var rFE = _xmlChild(xFe, 'rFE');
  if (!rFE) throw new Error('XML no contiene <rFE>');

  var gDGen = _xmlChild(rFE, 'gDGen');
  if (!gDGen) throw new Error('XML no contiene <gDGen>');

  // Emisor
  var gEmis    = _xmlChild(gDGen, 'gEmis');
  var gRucEmi  = gEmis ? _xmlChild(gEmis, 'gRucEmi') : null;
  var rucEmi   = gRucEmi ? _xmlText(gRucEmi, 'dRuc') : '';
  var dvEmi    = gRucEmi ? _xmlText(gRucEmi, 'dDV')  : '';
  var nombEm   = gEmis   ? _xmlText(gEmis, 'dNombEm') : '';

  // Receptor
  var gDatRec  = _xmlChild(gDGen, 'gDatRec');
  var gRucRec  = gDatRec ? _xmlChild(gDatRec, 'gRucRec') : null;
  var rucRec   = gRucRec ? _xmlText(gRucRec, 'dRuc') : '';

  // Documento
  var dNroDF    = _xmlText(gDGen, 'dNroDF');
  var dPtoFacDF = _xmlText(gDGen, 'dPtoFacDF');
  var dFechaEm  = _xmlText(gDGen, 'dFechaEm');
  var fecha     = dFechaEm ? dFechaEm.substring(0, 10) : '';

  // Totales
  var gTot      = _xmlChild(rFE, 'gTot');
  var subtotal  = gTot ? parseFloat(_xmlText(gTot, 'dTotNeto'))  : 0;
  var itbms     = gTot ? parseFloat(_xmlText(gTot, 'dTotITBMS')) : 0;
  var total     = gTot ? parseFloat(_xmlText(gTot, 'dVTot'))     : 0;

  // Descripción del primer item
  var gItem        = _xmlChild(rFE, 'gItem');
  var descripcion  = gItem ? _xmlText(gItem, 'dDescProd') : '';

  // Construir num_factura: PtoFac-NroDF (formato Panameño)
  var numFactura = dPtoFacDF ? (dPtoFacDF + '-' + dNroDF) : dNroDF;

  return {
    nombre_proveedor:    nombEm || '',
    ruc_proveedor:       rucEmi ? (rucEmi + (dvEmi ? '-' + dvEmi : '')) : '',
    ruc_receptor:        rucRec || '',
    num_factura:         numFactura || '',
    fecha:               fecha,
    subtotal:            isNaN(subtotal) ? 0 : subtotal,
    itbms:               isNaN(itbms)    ? 0 : itbms,
    total:               isNaN(total)    ? 0 : total,
    descripcion:         descripcion || '',
    categoria_sugerida: '',  // El XML no infiere categoría — usuario clasifica manualmente
    confianza_categoria: 0
  };
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

  var label      = _getOrCreateLabelAcr(LABEL_ACREEDOR);
  var dest       = (cfg.email_acr_destino || cfg.email_op_destino || cfg.email_comprobantes || '').trim();
  var inboxLabel = String(cfg.email_acr_label || '').trim();
  var threads    = GmailApp.search(query, 0, 100);
  Logger.log('📬 Threads para Acreedores: ' + threads.length);

  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      try {
        var msgId = msg.getId();

        // ── Validar que el mensaje fue entregado al alias configurado ──
        // Solo en modo broad (sin email_acr_label). En modo label el
        // filtro nativo de Workspace ya pre-cualificó el mensaje.
        if (!inboxLabel && !_emailDestinoEsAlias(msg, dest)) {
          stats.ignorados = (stats.ignorados || 0) + 1;
          continue;
        }

        var attachments        = msg.getAttachments();
        // Expandir bulk forwards: si el email contiene .eml/message/rfc822
        // como attachments (caso "Forward as attachment" en Gmail web),
        // los reemplazamos por sus PDFs/XMLs internos. El resto del
        // pipeline trata cada uno como si hubiera llegado solo.
        attachments            = _expandirEmlAdjuntos(attachments);
        var todosListos        = true;   // sin errores de parse = ok para poner label
        var tieneAlgunAcreedor = false;  // al menos un adjunto fue de acreedor
        var tieneRateLimit     = false;  // 429 de Claude — error transitorio, NO marcar thread

        // ── Validar que el mensaje haya llegado vía el reenviador permitido ──
        if (!_esReenvioPermitidoAcr(msg)) {
          var _subj = '';
          try { _subj = String(msg.getSubject() || '').substring(0, 80); } catch(eS){}
          var _from = '';
          try { _from = String(msg.getFrom() || '').substring(0, 60); } catch(eF){}
          Logger.log('  ⏭ Descartado (no reenviador): ' + msgId + ' | from=' + _from + ' | subject=' + _subj);
          stats.ignorados = (stats.ignorados || 0) + 1;
          continue;
        }

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
          var parsed;

          // ── Caso PDF vacío: facturas electrónicas DGI Panamá donde el ──
          // ── proveedor adjunta el PDF como placeholder de 0 bytes y el ──
          // ── XML firmado es el documento real (Petróleos Delta, PedidosYa, ──
          // ── webposonline, etc). Fallback: parsear el XML directamente. ──
          if (pdfBytes.length === 0) {
            Logger.log('  ⚠️ PDF vacío: ' + fileName + ' — buscando XML hermano…');
            var xmlAtt = _findXmlAdjuntoEnLista(attachments);
            if (!xmlAtt) {
              Logger.log('  ✗ Sin XML hermano — saltando ' + fileName);
              todosListos = false;
              continue;
            }
            try {
              parsed = _parseFacturaXmlDgi(xmlAtt.getDataAsString());
              Logger.log('  ✓ Parsed via XML DGI: ' + parsed.nombre_proveedor + ' / ' + parsed.num_factura + ' / ' + parsed.total);
            } catch (eXml) {
              Logger.log('  ✗ Error parseando XML DGI: ' + eXml.message);
              todosListos = false;
              stats.errores.push({ msgId: msgId, file: fileName, error: 'XML: ' + eXml.message });
              continue;
            }
            tieneAlgunAcreedor = true;
          } else {
            // ── Path normal: PDF con contenido → Claude vision ──
            tieneAlgunAcreedor = true;
            var pdfB64 = Utilities.base64Encode(pdfBytes);
            try {
              parsed = _claudeParsearFacturaLibre(pdfB64, fileName);
            } catch (eClaude) {
              // Distinguir errores transitorios (429 rate limit, 503,
              // network) de errores permanentes (PDF corrupto, etc).
              // Los transitorios NO deben consumir el thread —
              // queremos que el próximo run reintente.
              var msgErr     = String(eClaude.message || '');
              var isTransient = /\b429\b|rate_limit|503|temporarily|timeout|Failed to fetch/i.test(msgErr);
              Logger.log('  ✗ Claude error: ' + msgErr + (isTransient ? ' (transitorio — thread NO se marcará)' : ''));
              todosListos = false;
              if (isTransient) tieneRateLimit = true;
              stats.errores.push({ msgId: msgId, file: fileName, error: 'Claude: ' + msgErr });
              continue;
            }
          }

          try {
            var acreedor = {
              id:            'LIBRE',
              nombre:        parsed.nombre_proveedor || fileName,
              ruc:           parsed.ruc_proveedor    || '',
              categoria_def: parsed.categoria_sugerida || ''
            };
            // Buscar acreedor existente o auto-crearlo (queda activo por defecto).
            // El usuario puede luego desactivarlo desde Configuración → Automático
            // para descartar futuras facturas del mismo proveedor.
            var pref = _findOrAutoCreateAcreedor(
              acreedor.nombre,
              acreedor.ruc,
              acreedor.categoria_def
            );
            if (pref && pref.activo === false) {
              Logger.log('⏭ Acreedor ' + pref.nombre + ' está desactivado — factura ignorada.');
              _registrarClaveAcreedor(ss, clave, msgId, fileName);
              continue;
            }
            if (pref && pref.categoria_def) {
              acreedor.id           = pref.id;
              acreedor.categoria_def = pref.categoria_def;
              if (pref.desc_default) parsed.descripcion = pref.desc_default;
              parsed.categoria_sugerida = pref.categoria_def;
              Logger.log('🎯 Preferencia aplicada: ' + acreedor.nombre + ' → ' + pref.categoria_def);
            } else if (pref) {
              acreedor.id = pref.id;
            }
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
        if (tieneRateLimit) {
          // Rate limit transitorio de Claude — marcar el thread como
          // PENDING para que sea visible en el inbox y el próximo run
          // lo reintente. Dedup attachment-level salta las que ya
          // están guardadas, retry solo las que faltan.
          var pendingLabel = _getOrCreateLabelAcr(LABEL_ACREEDOR_PENDING);
          threads[t].addLabel(pendingLabel);
          Logger.log('⏸ Rate limit de Claude — thread marcado cf_acreedor_pending para retry en próximo run.');
        } else if (tieneAlgunAcreedor) {
          // Tiene acreedores — consumir el thread (errores permanentes
          // como PDF corrupto NO deben loopar infinitamente).
          threads[t].addLabel(label);
          // Si venía de un retry exitoso, quitar el pending label.
          try {
            var prevPending = GmailApp.getUserLabelByName(LABEL_ACREEDOR_PENDING);
            if (prevPending) threads[t].removeLabel(prevPending);
          } catch (eRem) {}
          Logger.log(todosListos
            ? '✅ Label cf_acreedor_procesado aplicado.'
            : '⚠️  Label cf_acreedor_procesado aplicado (con errores parciales no-transitorios).');
        } else if (!inboxLabel) {
          // MODO BROAD: el thread se escaneó completo y no tenía nada
          // para este cliente (no es del reenviador permitido, no va al
          // alias, o sin adjuntos de acreedor). Lo marcamos
          // cf_acreedor_visto para que el query amplio deje de re-leerlo
          // en CADA corrida (cada getMessages/getRawContent cuenta contra
          // la cuota diaria de Gmail — esa es la causa raíz del error
          // "Service invoked too many times for one day: gmail").
          // Consistente con cómo cf_acreedor_procesado ya trata los
          // threads como terminales; un reenvío de factura siempre llega
          // en un thread nuevo, así que no perdemos facturas futuras.
          // En modo label-scoped no aplica: el universo ya es pequeño.
          try {
            threads[t].addLabel(_getOrCreateLabelAcr(_labelAcrVisto()));
            Logger.log('⏭ Thread sin acreedores — marcado ' + _labelAcrVisto() + ' (no re-escaneo).');
          } catch (eVisto) {
            Logger.log('⏭ Thread sin acreedores — no se pudo marcar visto: ' + eVisto.message);
          }
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

  var anioActual = parseInt(Utilities.formatDate(new Date(), 'America/Panama', 'yyyy'), 10);
  var promptOverride = acreedor.prompt_override || '';
  var prompt =
    'Eres un extractor de facturas de ' + acreedor.nombre +
    (acreedor.ruc ? ' (RUC ' + acreedor.ruc + ')' : '') + ' en Panamá.\n' +
    (promptOverride ? promptOverride + '\n' : '') +
    'Responde SOLO con JSON válido, sin markdown:\n' +
    '{"num_factura":"","fecha":"YYYY-MM-DD","subtotal":0,"itbms":0,"total":0,' +
    '"descripcion":"","categoria_sugerida":"","confianza_categoria":0,"ruc_receptor":""}\n' +
    'categoria_sugerida debe ser uno de:\n' + catList + '\n' +
    'confianza_categoria: número de 0 a 100.\n' +
    'ruc_receptor: RUC del receptor/cliente a quien va dirigida la factura (solo dígitos y guiones, sin DV). null si no aparece.\n' +
    'fecha: formato Panamá DD/MM/YYYY → devolvé como YYYY-MM-DD. AÑO SANITY CHECK: estamos en ' + anioActual + ', las facturas llegan en tiempo real. Si tu lectura da un año >2 años en el pasado (ej: ' + (anioActual - 6) + ' cuando estamos en ' + anioActual + '), revisá el dígito final — "0"↔"6", "0"↔"8", "5"↔"6" se confunden en PDFs de baja calidad. Solo aceptás un año pasado si está claramente legible.\n' +
    'Si un campo no está visible usar null. Montos como números.';

  var payload = {
    model:      'claude-sonnet-4-6',
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
  return _extractJsonObj(text);
}

// ═══════════════════════════════════════════════════════════════
//  CLAUDE — parsear factura sin acreedor previo (modo libre)
// ═══════════════════════════════════════════════════════════════

function _claudeParsearFacturaLibre(pdfB64, fileName, mediaType) {
  mediaType = mediaType || 'application/pdf';
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY no configurada');

  var catList = CATEGORIAS_ACREEDOR.map(function(c) {
    return c.valor + ' - ' + c.label;
  }).join('\n');

  var anioActual = parseInt(Utilities.formatDate(new Date(), 'America/Panama', 'yyyy'), 10);
  var prompt =
    'Eres un extractor de facturas de gastos operativos panameñas.\n' +
    'Extrae todos los campos del documento y responde SOLO con JSON válido, sin markdown:\n' +
    '{"nombre_proveedor":"","ruc_proveedor":"","ruc_receptor":"","num_factura":"","fecha":"YYYY-MM-DD",' +
    '"subtotal":0,"itbms":0,"total":0,"descripcion":"","categoria_sugerida":"","confianza_categoria":0}\n\n' +
    'categoria_sugerida debe ser uno de:\n' + catList + '\n\n' +
    'Reglas:\n' +
    '- nombre_proveedor: razón social del EMISOR de la factura (quien cobra, no quien paga).\n' +
    '- ruc_proveedor: RUC del emisor, solo dígitos y guiones.\n' +
    '- ruc_receptor: RUC del RECEPTOR (a quien va dirigida, sección "Cliente"). Solo dígitos y guiones, sin DV. null si no aparece.\n' +
    '- descripcion: servicio o producto facturado en pocas palabras.\n' +
    '- confianza_categoria: 0-100, qué tan seguro estás de la categoría.\n' +
    '- fecha: formato Panamá DD/MM/YYYY → YYYY-MM-DD. AÑO SANITY CHECK: estamos en ' + anioActual + '. Si tu lectura da un año >2 años en el pasado (ej: ' + (anioActual - 6) + '), revisá el dígito final — "0"↔"6", "0"↔"8", "5"↔"6" se confunden en docs gastados o crops. Solo aceptás un año pasado si la fecha está claramente legible.\n' +
    '- Si un campo no es visible usar null. Montos como números sin símbolo de moneda.';

  var contentBlock = mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfB64 } }
    : { type: 'image',    source: { type: 'base64', media_type: mediaType,          data: pdfB64 } };
  var payload = {
    model:      'claude-sonnet-4-6',
    max_tokens: 600,
    messages: [{ role: 'user', content: [ contentBlock, { type: 'text', text: prompt } ]}]
  };
  var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload), muteHttpExceptions: true,
  });
  if (resp.getResponseCode() !== 200)
    throw new Error('Claude error ' + resp.getResponseCode() + ': ' + resp.getContentText().substring(0, 200));
  var text    = '';
  var content = JSON.parse(resp.getContentText()).content || [];
  for (var i = 0; i < content.length; i++) {
    if (content[i].type === 'text') { text = content[i].text; break; }
  }
  return _extractJsonObj(text);
}

// ═══════════════════════════════════════════════════════════════
//  HELPERS DE HOJAS
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
//  PREFERENCIAS DE PROVEEDOR — guardar / buscar
// ═══════════════════════════════════════════════════════════════

function _buscarPreferenciaAcreedor(nombre, ruc) {
  var lista = _getAcreedores();
  var rucNorm = (ruc || '').replace(/[-\.]/g, '').toLowerCase();
  // Buscar por RUC primero, luego por nombre exacto
  for (var i = 0; i < lista.length; i++) {
    var a = lista[i];
    if (rucNorm && (a.ruc || '').replace(/[-\.]/g, '').toLowerCase() === rucNorm) return a;
  }
  var nomLower = (nombre || '').toLowerCase().trim();
  for (var j = 0; j < lista.length; j++) {
    if ((lista[j].nombre || '').toLowerCase().trim() === nomLower) return lista[j];
  }
  return null;
}

// Busca en la hoja Egresos las facturas pasadas del mismo proveedor y
// devuelve la categoría más frecuente. Cubre el caso donde el cliente
// tiene historial (vía email o reclasificación) pero todavía no hay
// una preferencia explícita en Acreedores_Config.
// Devuelve null si no hay match o si todas son 'otros_deducibles'.
function _categoriaHistoricaEgresos(nombre, ruc) {
  try {
    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_EGRESOS);
    if (!sheet || sheet.getLastRow() < 3) return null;

    // Normalización tolerante: lowercase, sin acentos, sin puntuación.
    // Tolera diferencias entre "Congregación" vs "Congregacion" y
    // sufijos legales S.A. / S. de R.L.
    function _normN(s) {
      return String(s || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/\b(s\.?a\.?|s\.?\s*de\s*r\.?l\.?|sociedad anonima|inc|ltd|corp)\b/g, '')
        .replace(/[^a-z0-9]+/g, '');
    }
    var rucNorm = String(ruc || '').replace(/[-\.\s]/g, '').toLowerCase();
    var nomNorm = _normN(nombre);
    if (!rucNorm && !nomNorm) return null;

    // Columnas relevantes: PROVEEDOR (13), RUC_PROV (14), CATEGORIA (12)
    var ncols = Math.max(COL_E.PROVEEDOR, COL_E.RUC_PROV, COL_E.CATEGORIA, COL_E.TIPO_EGRESO, COL_E.ESTADO);
    var data  = sheet.getRange(3, 1, sheet.getLastRow() - 2, ncols).getValues();
    var counts = {};
    for (var i = 0; i < data.length; i++) {
      var estado = String(data[i][COL_E.ESTADO - 1] || '').toLowerCase();
      if (estado === 'anulado') continue;
      var rowNom = _normN(data[i][COL_E.PROVEEDOR - 1]);
      var rowRuc = String(data[i][COL_E.RUC_PROV - 1] || '').replace(/[-\.\s]/g, '').toLowerCase();
      var match = (rucNorm && rowRuc && rucNorm === rowRuc);
      if (!match && nomNorm && rowNom) {
        // Exacto o uno contiene al otro (≥6 chars) para tolerar
        // truncaciones / variantes del mismo nombre.
        match = (nomNorm === rowNom) ||
                (nomNorm.length >= 6 && rowNom.indexOf(nomNorm) >= 0) ||
                (rowNom.length >= 6 && nomNorm.indexOf(rowNom) >= 0);
      }
      if (!match) continue;
      var cat = String(data[i][COL_E.CATEGORIA - 1] || data[i][COL_E.TIPO_EGRESO - 1] || '').trim();
      if (!cat || cat === 'sin_clasificar') continue;
      counts[cat] = (counts[cat] || 0) + 1;
    }

    // Pick la más frecuente; si la única es 'otros_deducibles', devolver null
    // (no aporta info nueva, dejamos que la IA decida).
    var best = null, bestN = 0;
    for (var k in counts) {
      if (counts[k] > bestN) { best = k; bestN = counts[k]; }
    }
    if (!best || (best === 'otros_deducibles' && Object.keys(counts).length === 1)) return null;
    return best;
  } catch (e) {
    Logger.log('_categoriaHistoricaEgresos error: ' + e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
//  AUTO-CREATE — crea un acreedor si no existe en Acreedores_Config
//  Devuelve siempre el acreedor (existente o nuevo) con flag activo.
//  Usado por la sincronización de emails para que el panel
//  Configuración → Automático se llene solo.
// ═══════════════════════════════════════════════════════════════
function _findOrAutoCreateAcreedor(nombre, ruc, categoriaDef) {
  // 1. Buscar en la lista existente
  var existing = _buscarPreferenciaAcreedor(nombre, ruc);
  if (existing) {
    // 1a. Si la entrada existente tiene 'otros_deducibles' como categoría
    // por default (no porque el usuario la haya puesto explícitamente,
    // sino porque la IA la creó así en una factura previa), intentar
    // mejorarla mirando el historial de Egresos. Esto recupera del caso
    // donde una prueba previa creó una entrada subóptima.
    try {
      var actualCat = String(existing.categoria_def || '').trim();
      var notasObj = {};
      try { notasObj = JSON.parse(existing.notas || '{}'); } catch (e) {}
      var setByUser = !!notasObj.pref_usuario;
      if (!setByUser && (!actualCat || actualCat === 'otros_deducibles')) {
        var hist = _categoriaHistoricaEgresos(nombre, ruc);
        if (hist) {
          var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
          var sheet = ss.getSheetByName(SHEET_ACREEDORES_CONFIG);
          if (sheet && existing._row) {
            sheet.getRange(existing._row, COL_ACR.CATEGORIA_DEF).setValue(hist);
            existing.categoria_def = hist;
            _acreedoresCache = null;
            Logger.log('🕰  Acreedor upgrade con categoría histórica: ' + nombre + ' → ' + hist);
          }
        }
      }
    } catch (e) {
      Logger.log('Upgrade hist error: ' + e.message);
    }
    return existing;
  }

  // 1b. Fallback histórico para acreedor nuevo: mirar los Egresos
  // pasados del mismo proveedor y usar la categoría más usada.
  // Cubre el caso donde el cliente ya tiene facturas de este proveedor
  // categorizadas correctamente (vía email o reclasificación) pero
  // todavía no había una entrada de Acreedores_Config.
  if (!categoriaDef || categoriaDef === 'otros_deducibles') {
    var historica = _categoriaHistoricaEgresos(nombre, ruc);
    if (historica) {
      Logger.log('🕰  Categoría histórica encontrada para ' + nombre + ': ' + historica);
      categoriaDef = historica;
    }
  }

  // 2. No existe → crear con activo=true
  try {
    _acreedoresCache = null;
    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_ACREEDORES_CONFIG);
    if (!sheet) {
      Logger.log('⚠️ No se pudo auto-crear acreedor: hoja Acreedores_Config no existe.');
      return null;
    }

    var ahora   = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd');
    var lastRow = sheet.getLastRow();
    var seq     = lastRow <= 2 ? 1 : lastRow - 1;
    var id      = 'AUTO-' + ahora.replace(/-/g,'') + '-' + String(seq).padStart(3,'0');

    var fila = new Array(ACR_NCOLS).fill('');
    fila[COL_ACR.ID - 1]            = id;
    fila[COL_ACR.NOMBRE - 1]        = String(nombre || '').trim() || 'Proveedor sin nombre';
    fila[COL_ACR.RUC - 1]           = String(ruc || '').trim();
    fila[COL_ACR.CATEGORIA_DEF - 1] = String(categoriaDef || 'otros_deducibles');
    fila[COL_ACR.ACTIVO - 1]        = 'true';
    fila[COL_ACR.FECHA_ALTA - 1]    = ahora;
    fila[COL_ACR.NOTAS - 1]         = JSON.stringify({ origen: 'auto_email', fecha: ahora });
    sheet.appendRow(fila);

    Logger.log('🆕 Acreedor auto-creado: ' + fila[COL_ACR.NOMBRE - 1] +
               (fila[COL_ACR.RUC - 1] ? ' (RUC ' + fila[COL_ACR.RUC - 1] + ')' : ''));

    // Forzar invalidación del cache para que la próxima búsqueda lo encuentre
    _acreedoresCache = null;
    return _buscarPreferenciaAcreedor(fila[COL_ACR.NOMBRE - 1], fila[COL_ACR.RUC - 1]);
  } catch (err) {
    Logger.log('❌ Error auto-creando acreedor: ' + err.message);
    return null;
  }
}

function _handleGuardarPreferencia(data) {
  try {
    var nombre     = String(data.nombre    || '').trim();
    var ruc        = String(data.ruc       || '').trim();
    var categoria  = String(data.categoria || '').trim();
    var descripcion = String(data.descripcion || '').trim();
    if (!nombre && !ruc) throw new Error('nombre o ruc requerido');

    _acreedoresCache = null;
    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_ACREEDORES_CONFIG);
    if (!sheet) throw new Error('Hoja Acreedores_Config no encontrada');

    var notasJson = JSON.stringify({ desc_default: descripcion, pref_usuario: true });
    var ahora     = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd');

    // Buscar fila existente por RUC o nombre
    var existing = _buscarPreferenciaAcreedor(nombre, ruc);
    if (existing && existing._row) {
      // Actualizar fila existente
      sheet.getRange(existing._row, COL_ACR.CATEGORIA_DEF).setValue(categoria);
      sheet.getRange(existing._row, COL_ACR.NOTAS).setValue(notasJson);
      Logger.log('✅ Preferencia actualizada: ' + nombre + ' | ' + categoria);
      return _jsonpAcr({ success: true, action: 'updated', nombre: nombre });
    }

    // Crear fila nueva
    var lastRow = sheet.getLastRow();
    var seq     = lastRow <= 2 ? 1 : lastRow - 1;
    var id      = 'PREF-' + ahora.replace(/-/g,'') + '-' + String(seq).padStart(3,'0');
    var fila    = new Array(ACR_NCOLS).fill('');
    fila[COL_ACR.ID - 1]             = id;
    fila[COL_ACR.NOMBRE - 1]         = nombre;
    fila[COL_ACR.RUC - 1]            = ruc;
    fila[COL_ACR.CATEGORIA_DEF - 1]  = categoria;
    fila[COL_ACR.ACTIVO - 1]         = 'true';
    fila[COL_ACR.FECHA_ALTA - 1]     = ahora;
    fila[COL_ACR.NOTAS - 1]          = notasJson;
    sheet.appendRow(fila);
    Logger.log('✅ Preferencia creada: ' + nombre + ' | ' + categoria);
    return _jsonpAcr({ success: true, action: 'created', nombre: nombre });
  } catch(err) {
    Logger.log('❌ guardarPreferenciaAcreedor: ' + err.message);
    return _jsonpAcr({ success: false, error: err.message });
  }
}

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
      desc_default:    (function(n){ try { return JSON.parse(n).desc_default||''; } catch(e){ return ''; } })(String(r[COL_ACR.NOTAS-1]||'')),
      _row:            i + 3,
    });
  }
  _acreedoresCache = items;
  return items;
}

function _guardarPdfAcreedor(pdfBytes, fileName, nombreAcreedor, cfg, mime) {
  try {
    var folderId = (cfg && cfg.drive_folder_id) ? cfg.drive_folder_id : '';
    if (!folderId) return '';
    var folder = DriveApp.getFolderById(folderId);
    var nombre = 'Acreedor_' + (nombreAcreedor || '').replace(/\s+/g,'_').substring(0,30) + '_' + fileName;
    var blob   = Utilities.newBlob(pdfBytes, mime || 'application/pdf', nombre);
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

  // Lock para evitar race condition en la generación de IDs y append:
  // dos emails que llegan simultáneamente leerían el mismo lastRow y
  // generarían el mismo PENDR-yyyyMM-NNNN, dejando filas duplicadas.
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) {
    Logger.log('LockService timeout en _crearPendiente: ' + e.message);
  }
  try {

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
  fila[COL_PEND.FECHA_FAC - 1]   = _parseFechaPanama(parsed.fecha);
  fila[COL_PEND.NUM_FAC - 1]     = parsed.num_factura  || '';
  fila[COL_PEND.SUBTOTAL - 1]    = parseFloat(parsed.subtotal || '0') || '';
  fila[COL_PEND.ITBMS - 1]       = parseFloat(parsed.itbms    || '0') || '';
  fila[COL_PEND.TOTAL - 1]       = parseFloat(parsed.total    || '0') || '';
  fila[COL_PEND.CATEGORIA - 1]   = catSugerida;
  fila[COL_PEND.DESCRIPCION - 1] = parsed.descripcion  || acreedor.nombre;
  fila[COL_PEND.DRIVE_URL - 1]   = driveUrl;
  var notasExtra = acreedor.ruc ? ' | RUC: ' + acreedor.ruc : '';
  var rucRec = String(parsed.ruc_receptor || '').replace(/\s/g, '');
  var _cfgAcr = _getConfig();
  var rucCli = _cfgAcr && _cfgAcr.empresa_ruc ? _cfgAcr.empresa_ruc : '';
  var dvCli  = _cfgAcr && _cfgAcr.empresa_dv  ? _cfgAcr.empresa_dv  : '';
  // Alcance: deducible solo si la factura está a nombre del negocio.
  // El matcher tolera DV pegado al RUC en cualquiera de los dos lados.
  // Pero si la categoría es no-deducible (Art. 697: alimentación,
  // manutención, etc), forzamos personal sin importar el RUC.
  var alcancePend;
  if (typeof _esCategoriaNoDeducible === 'function' && _esCategoriaNoDeducible(catSugerida)) {
    alcancePend = 'personal';
  } else {
    alcancePend = _matchRucPanama(rucRec, rucCli, dvCli) ? 'negocio' : 'personal';
  }
  fila[COL_PEND.NOTAS - 1]       = 'IA confianza cat: ' + (parsed.confianza_categoria || '?') + '%' + notasExtra + ' | alcance:' + alcancePend;
  fila[COL_PEND.EGRESO_ID - 1]   = '';
  fila[COL_PEND.MSG_ID - 1]      = clave || msgId || '';

  var newRow = sheet.getLastRow() + 1;
  sheet.getRange(newRow, 1, 1, PEND_NCOLS).setValues([fila]);
  sheet.getRange(newRow, COL_PEND.SUBTOTAL, 1, 3).setNumberFormat('#,##0.00');
  sheet.getRange(newRow, COL_PEND.FECHA_FAC, 1, 1).setNumberFormat('yyyy-MM-dd');
  sheet.getRange(newRow, 1, 1, PEND_NCOLS).setBackground('#FFF9C4');
  // Defensivo: si el spreadsheet del cliente no está en TZ Panamá,
  // las fechas se corren 1 día. Forzamos Panamá una vez (idempotente).
  try {
    if (ss.getSpreadsheetTimeZone() !== 'America/Panama') {
      ss.setSpreadsheetTimeZone('America/Panama');
    }
  } catch (e) {}
  return id;

  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function _getOrCreateLabelAcr(nombre) {
  var labels = GmailApp.getUserLabels();
  for (var i = 0; i < labels.length; i++) {
    if (labels[i].getName() === nombre) return labels[i];
  }
  return GmailApp.createLabel(nombre);
}

// Parsea una fecha "YYYY-MM-DD" como medianoche en America/Panama.
// Necesario porque Google Sheets auto-detecta el string ISO y lo
// almacena como Date en la timezone del spreadsheet, que si no es
// Panamá causa off-by-one al re-formatear desde Apps Script.
// Devuelve Date o '' si el string no es válido.
function _parseFechaPanama(s) {
  if (!s) return '';
  var str = String(s).trim();
  var m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return str;  // si no es ISO, devolvemos tal cual; flujo viejo
  try {
    return Utilities.parseDate(m[1] + '-' + m[2] + '-' + m[3], 'America/Panama', 'yyyy-MM-dd');
  } catch (e) {
    return str;
  }
}

// Compara RUC del receptor de la factura contra el RUC del negocio.
// La IA a veces devuelve el RUC con el DV pegado al final ("N-19-356-74"
// o "N-19-356 DV 74"), y la config a veces tiene ruc y dv separados.
// Este matcher acepta:
//   - exacto: receptor === ruc
//   - receptor con DV pegado: receptor === ruc + dv
//   - receptor más corto (sin DV): ruc + dv === receptor + sufijo corto
//   - viceversa
function _matchRucPanama(rucReceptor, cfgRuc, cfgDv) {
  if (!rucReceptor || !cfgRuc) return false;
  function n(s) { return String(s || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase(); }
  var R = n(rucReceptor);
  var C = n(cfgRuc);
  var D = n(cfgDv);
  if (!R || !C) return false;
  if (R === C) return true;
  if (D) {
    var CD = C + D;
    if (R === CD) return true;
    // Receptor incluye el DV pero la config tiene ruc+dv largo
    if (R === C + D) return true;
  }
  // Tolerancia: uno es prefijo del otro y la diferencia es ≤ 3 chars
  // (DV en Panamá tiene 1-2 dígitos, dejamos margen)
  if (R.indexOf(C) === 0 && R.length - C.length <= 3) return true;
  if (C.indexOf(R) === 0 && C.length - R.length <= 3) return true;
  if (D) {
    var CD2 = C + D;
    if (R.indexOf(CD2) === 0 && R.length - CD2.length <= 3) return true;
    if (CD2.indexOf(R) === 0 && CD2.length - R.length <= 3) return true;
  }
  return false;
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
        msg_id:       String(r[COL_PEND.MSG_ID - 1] || ''),
        alcance:      (function(n){ var m = String(n||'').match(/\balcance:(negocio|personal)\b/); return m ? m[1] : 'negocio'; })(r[COL_PEND.NOTAS - 1]),
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
    // num_fac opcional: cuando hay IDs duplicados (race histórica), el
    // frontend pasa num_fac para apuntar al row exacto que el usuario
    // seleccionó. Si no se pasa, fallback al primer borrador con ese ID.
    var numFacTarget = String(params.num_fac || '').trim();

    var ss      = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet   = ss.getSheetByName(SHEET_ACREEDORES_PENDING);
    if (!sheet) throw new Error('Hoja Acreedores_Pending no encontrada');
    var numRows = sheet.getLastRow() - 2;
    if (numRows <= 0) throw new Error('Sin pendientes');
    var data    = sheet.getRange(3, 1, numRows, PEND_NCOLS).getValues();
    var found   = false;

    for (var i = 0; i < data.length; i++) {
      if (String(data[i][COL_PEND.ID - 1]) !== id) continue;
      // Si hay IDs duplicados (race condition histórica), priorizamos
      // los rows en estado 'borrador'. Saltamos los ya aprobados o
      // rechazados para que el click "Aprobar" del usuario surta efecto.
      var rowEstado = String(data[i][COL_PEND.ESTADO - 1] || '').toLowerCase();
      if (rowEstado && rowEstado !== 'borrador') continue;
      // Si el frontend especificó num_fac, exigimos match (para apuntar
      // al row exacto entre duplicados con mismo id).
      if (numFacTarget && String(data[i][COL_PEND.NUM_FAC - 1] || '').trim() !== numFacTarget) continue;
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
        // Mantener como Date anclada a Panamá para que no se corra al
        // re-formatear en TZ del spreadsheet. Si la celda venía vacía,
        // usamos la fecha actual parseada igual.
        var fechaGasto = r[COL_PEND.FECHA_FAC - 1];
        if (!fechaGasto) {
          fechaGasto = _parseFechaPanama(Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd'));
        } else if (!(fechaGasto instanceof Date)) {
          fechaGasto = _parseFechaPanama(String(fechaGasto));
        }
        var filE = new Array(EGRESOS_NCOLS);
        for (var x = 0; x < EGRESOS_NCOLS; x++) filE[x] = '';
        filE[COL_E.ID - 1]            = egresoId;
        filE[COL_E.FECHA_REG - 1]     = fechaReg;
        filE[COL_E.FECHA_GASTO - 1]   = fechaGasto;
        filE[COL_E.DESCRIPCION - 1]   = r[COL_PEND.DESCRIPCION - 1] || r[COL_PEND.ACREEDOR_NOM - 1] || '';
        filE[COL_E.CATEGORIA - 1]     = r[COL_PEND.CATEGORIA - 1]   || '';
        filE[COL_E.TIPO_EGRESO - 1]   = r[COL_PEND.CATEGORIA - 1]   || '';   // P&L y RG consumen este campo
        filE[COL_E.SUBTOTAL - 1]      = parseFloat(r[COL_PEND.SUBTOTAL - 1] || '0') || '';
        filE[COL_E.ITBMS - 1]         = parseFloat(r[COL_PEND.ITBMS - 1]    || '0') || '';
        filE[COL_E.TOTAL - 1]         = parseFloat(r[COL_PEND.TOTAL - 1]    || '0') || '';
        filE[COL_E.NFACTURA - 1]      = r[COL_PEND.NUM_FAC - 1]     || '';
        filE[COL_E.PROVEEDOR - 1]     = r[COL_PEND.ACREEDOR_NOM - 1]|| '';
        filE[COL_E.DRIVE_URL - 1]     = r[COL_PEND.DRIVE_URL - 1]   || '';
        filE[COL_E.ESTADO - 1]        = 'registrado';
        filE[COL_E.NOTAS - 1]         = 'acreedor_auto | ' + (r[COL_PEND.NOTAS - 1] || '');
        var notasPend = String(r[COL_PEND.NOTAS - 1] || '');
        var mAlc = notasPend.match(/\balcance:(negocio|personal)\b/);
        var catFinal = String(r[COL_PEND.CATEGORIA - 1] || '');
        // Si la categoría es no-deducible, forzamos alcance=personal
        // sin importar lo que diga el pendiente (defense in depth).
        if (typeof _esCategoriaNoDeducible === 'function' && _esCategoriaNoDeducible(catFinal)) {
          filE[COL_E.ALCANCE - 1] = 'personal';
        } else {
          filE[COL_E.ALCANCE - 1] = mAlc ? mAlc[1] : 'negocio';
        }
        var lastRowE = sheetE.getLastRow() + 1;
        sheetE.getRange(lastRowE, 1, 1, EGRESOS_NCOLS).setValues([filE]);
        sheetE.getRange(lastRowE, COL_E.FECHA_GASTO, 1, 1).setNumberFormat('yyyy-MM-dd');
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
    var numFacTarget = String(params.num_fac || '').trim();
    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_ACREEDORES_PENDING);
    if (!sheet) throw new Error('Hoja Acreedores_Pending no encontrada');
    var data  = sheet.getRange(3, 1, sheet.getLastRow() - 2, PEND_NCOLS).getValues();
    var found = false;
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][COL_PEND.ID - 1]) !== id) continue;
      // Saltar rows ya procesados (mismo ID puede aparecer múltiples
      // veces por carrera histórica en _crearPendiente).
      var st = String(data[i][COL_PEND.ESTADO - 1] || '').toLowerCase();
      if (st && st !== 'borrador') continue;
      if (numFacTarget && String(data[i][COL_PEND.NUM_FAC - 1] || '').trim() !== numFacTarget) continue;
      sheet.getRange(i + 3, COL_PEND.ESTADO).setValue('rechazado');
      sheet.getRange(i + 3, 1, 1, PEND_NCOLS).setBackground('#FFEBEE');
      found = true; break;
    }
    if (!found) throw new Error('Pendiente no encontrado: ' + id);
    // Liberar hash de dedup WhatsApp si existía, para que el cliente
    // pueda reenviar la misma factura después de rechazar.
    if (typeof _whatsappLiberarHashByPendId === 'function') _whatsappLiberarHashByPendId(id);
    result.success = true;
  } catch(err) { result.error = err.message; }
  return _jsonpAcr(result, callback);
}

function _handleEliminarPendienteAcr(params, callback) {
  var result = { success: false, error: null };
  try {
    var id = String(params.id || '').trim();
    if (!id) throw new Error('id requerido');
    var numFacTarget = String(params.num_fac || '').trim();
    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_ACREEDORES_PENDING);
    if (!sheet) throw new Error('Hoja Acreedores_Pending no encontrada');
    var data  = sheet.getRange(3, 1, sheet.getLastRow() - 2, PEND_NCOLS).getValues();
    var found = false;
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][COL_PEND.ID - 1]) !== id) continue;
      // Si hay IDs duplicados, solo eliminamos borradores (los aprobados
      // ya generaron egresos y eliminarlos rompería trazabilidad).
      var st = String(data[i][COL_PEND.ESTADO - 1] || '').toLowerCase();
      if (st && st !== 'borrador') continue;
      // Si se pasa num_fac, apunta al row exacto entre duplicados.
      if (numFacTarget && String(data[i][COL_PEND.NUM_FAC - 1] || '').trim() !== numFacTarget) continue;
      sheet.deleteRow(i + 3);
      found = true; break;
    }
    if (!found) throw new Error('Pendiente no encontrado: ' + id);
    if (typeof _whatsappLiberarHashByPendId === 'function') _whatsappLiberarHashByPendId(id);
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
    var parsed  = _extractJsonObj(text);
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
    var numFacTarget = String(data.num_fac || '').trim();
    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_ACREEDORES_PENDING);
    if (!sheet) throw new Error('Hoja no encontrada');
    var rows  = sheet.getRange(3, 1, sheet.getLastRow() - 2, PEND_NCOLS).getValues();
    var found = false;
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][COL_PEND.ID - 1]) !== id) continue;
      // Saltar rows ya procesados (mismo ID puede aparecer múltiples
      // veces por race condition histórica) — solo editamos borrador.
      var st = String(rows[i][COL_PEND.ESTADO - 1] || '').toLowerCase();
      if (st && st !== 'borrador') continue;
      // Si se pasa num_fac, exigimos match exacto (para apuntar al row
      // específico cuando hay duplicados de id).
      if (numFacTarget && String(rows[i][COL_PEND.NUM_FAC - 1] || '').trim() !== numFacTarget) continue;
      var rowNum = i + 3;
      if (data.categoria)   sheet.getRange(rowNum, COL_PEND.CATEGORIA).setValue(data.categoria);
      if (data.descripcion) sheet.getRange(rowNum, COL_PEND.DESCRIPCION).setValue(data.descripcion);
      if (data.total)       sheet.getRange(rowNum, COL_PEND.TOTAL).setValue(parseFloat(data.total)||0);
      if (data.itbms)       sheet.getRange(rowNum, COL_PEND.ITBMS).setValue(parseFloat(data.itbms)||0);
      if (data.subtotal)    sheet.getRange(rowNum, COL_PEND.SUBTOTAL).setValue(parseFloat(data.subtotal)||0);
      if (data.alcance) {
        var notas = String(sheet.getRange(rowNum, COL_PEND.NOTAS).getValue() || '');
        notas = notas.match(/\balcance:(negocio|personal)\b/)
          ? notas.replace(/\balcance:(negocio|personal)\b/, 'alcance:' + data.alcance)
          : notas + ' | alcance:' + data.alcance;
        sheet.getRange(rowNum, COL_PEND.NOTAS).setValue(notas);
      }
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

// ═══════════════════════════════════════════════════════════════
//  GMAIL IMPORT — procesar UN mensaje (browser envía msgId + token)
// ═══════════════════════════════════════════════════════════════
function _gmailDetectMime(bytes) {
  if (!bytes || bytes.length < 4) return null;
  var b = bytes;
  if (b[0]===0x25 && b[1]===0x50 && b[2]===0x44 && b[3]===0x46) return 'application/pdf';
  if (b[0]===0xFF && b[1]===0xD8 && b[2]===0xFF)                 return 'image/jpeg';
  if (b[0]===0x89 && b[1]===0x50 && b[2]===0x4E && b[3]===0x47) return 'image/png';
  if (b[0]===0x50 && b[1]===0x4B)                                 return 'application/zip';
  // Build raw string from first 300 bytes for text detection
  var raw = '';
  for (var i=0; i<Math.min(bytes.length,300); i++) raw += String.fromCharCode(bytes[i]);
  // Strip UTF-8 BOM (EF BB BF) and leading whitespace to find actual content start
  var hdr = raw.replace(/^\xEF\xBB\xBF/, '').replace(/^\s+/, '');
  if (hdr.indexOf('<?xml')===0 || hdr.indexOf('<?XML')===0) return 'text/xml';
  if (hdr.charAt(0)==='<' && (hdr.indexOf('xmlns')>=0 || hdr.indexOf('rContFe')>=0)) return 'text/xml';
  // Broader scan: DGI FE Panama XML markers present anywhere in first 300 bytes
  if (raw.indexOf('rContFe')>=0 || raw.indexOf('dNomEmi')>=0 || raw.indexOf('dNroFac')>=0 ||
      raw.indexOf('dTotalFac')>=0 || raw.indexOf('FeRecepFE')>=0) return 'text/xml';
  if (hdr.toLowerCase().indexOf('<!doc')===0 || hdr.toLowerCase().indexOf('<html')===0) return 'text/html';
  return null;
}

function _parseDgiFExml(xmlText) {
  // Build a flat map {localName: textValue} using XmlService (handles namespaces/prefixes)
  var vals = {};
  try {
    var doc = XmlService.parse(xmlText);
    function walkEl(el) {
      var children = el.getChildren();
      if (!children.length) {
        var n = el.getName();
        if (n && !(n in vals)) vals[n] = el.getText().trim();
      }
      for (var c = 0; c < children.length; c++) walkEl(children[c]);
    }
    walkEl(doc.getRootElement());
  } catch(xe) {
    Logger.log('_parseDgiFExml XmlService: ' + xe.message + ' — usando regex');
    // Regex fallback with optional namespace prefix
    function tag(nm) {
      var m = xmlText.match(new RegExp('<(?:[\\w]+:)?' + nm + '[^>]*>([^<]*)<\\/(?:[\\w]+:)?' + nm + '>'));
      return m ? m[1].trim() : null;
    }
    vals = {
      dNomEmi: tag('dNomEmi'), dRucEmi: tag('dRucEmi'), dNroFac: tag('dNroFac'),
      dFecFac: tag('dFecFac'), dRucRec: tag('dRucRec'), dSubTot: tag('dSubTot'),
      dTotalITBMS: tag('dTotalITBMS'), dTotalFac: tag('dTotalFac')
    };
  }
  Logger.log('_parseDgiFExml vals: nom=' + vals.dNomEmi + ' ruc=' + vals.dRucEmi + ' fac=' + vals.dNroFac + ' tot=' + vals.dTotalFac);
  if (!vals.dNomEmi && !vals.dRucEmi && !vals.dNroFac) return null;
  var descItems = [], re = /<(?:[\w]+:)?dDesItem[^>]*>([^<]+)<\/(?:[\w]+:)?dDesItem>/g, mm;
  while ((mm = re.exec(xmlText)) !== null) descItems.push(mm[1].trim());
  return {
    nombre_proveedor:    vals.dNomEmi   || null,
    ruc_proveedor:       vals.dRucEmi   || null,
    ruc_receptor:        vals.dRucRec   || null,
    num_factura:         vals.dNroFac   || null,
    fecha:               vals.dFecFac   || null,
    subtotal:            parseFloat(vals.dSubTot     || '0') || 0,
    itbms:               parseFloat(vals.dTotalITBMS || '0') || 0,
    total:               parseFloat(vals.dTotalFac   || '0') || 0,
    descripcion:         descItems.join(', ') || vals.dDesItem || 'Factura electrónica DGI FE',
    categoria_sugerida:  null,
    confianza_categoria: 0
  };
}

function _claudeParsearTextoFactura(text, fileName) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY no configurada');
  var catList = CATEGORIAS_ACREEDOR.map(function(c) { return c.valor + ' - ' + c.label; }).join('\n');
  var prompt =
    'Eres un extractor de facturas de gastos operativos panameñas.\n' +
    'El siguiente es el contenido de una Factura Electrónica del DGI de Panamá (formato XML).\n' +
    'Extrae los campos y responde SOLO con JSON válido, sin markdown:\n' +
    '{"nombre_proveedor":"","ruc_proveedor":"","ruc_receptor":"","num_factura":"","fecha":"YYYY-MM-DD",' +
    '"subtotal":0,"itbms":0,"total":0,"descripcion":"","categoria_sugerida":"","confianza_categoria":0}\n\n' +
    'categoria_sugerida debe ser uno de:\n' + catList + '\n\n' +
    '- nombre_proveedor: emisor de la factura (dNomEmi o quien cobra).\n' +
    '- ruc_proveedor: RUC del emisor (dRucEmi), solo dígitos y guiones.\n' +
    '- num_factura: número de factura (dNroFac o similar).\n' +
    '- fecha: formato YYYY-MM-DD. Montos como números. null si no aparece.';
  var payload = {
    model: 'claude-sonnet-4-6', max_tokens: 400,
    messages: [{ role: 'user', content: [
      { type: 'text', text: text.substring(0, 8000) },
      { type: 'text', text: prompt }
    ]}]
  };
  var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200)
    throw new Error('Claude XML error ' + resp.getResponseCode() + ': ' + resp.getContentText().substring(0, 200));
  var out = '', content = JSON.parse(resp.getContentText()).content || [];
  for (var i = 0; i < content.length; i++) { if (content[i].type === 'text') { out = content[i].text; break; } }
  return _extractJsonObj(out);
}

function _handleCategorizarEmailsGmail(data) {
  var emails = data.emails || [];
  if (!emails.length) return _jsonAcr({ ok: true, result: [] });

  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) return _jsonAcr({ ok: false, error: 'CLAUDE_API_KEY no configurada' });

  var cats = [
    'restaurantes: Restaurantes, comida rápida, delivery de comida',
    'alimentacion: Supermercados, tiendas de alimentos, fruterías',
    'retail: Ferreterías, tiendas de ropa, compras generales',
    'combustible: Gasolineras, estaciones de servicio, Uber, transporte',
    'tecnologia: Software, apps, suscripciones digitales, telefonía celular',
    'publicidad: Publicidad digital, Facebook Ads, Google Ads, marketing',
    'salud: Farmacias, clínicas, médicos, gimnasios, seguros de salud',
    'entretenimiento: Entretenimiento, viajes, hoteles, turismo',
    'servicios: Servicios públicos, agua, electricidad, internet del hogar',
    'educacion: Colegios, universidades, cursos, libros académicos',
    'otro: Categoría no identificada o ambigua'
  ].join('\n');

  var emailsJson = emails.map(function(e) {
    return JSON.stringify({ idx: e.idx, from: String(e.from||'').substring(0,80), subject: String(e.subject||'').substring(0,80), snippet: String(e.snippet||'').substring(0,120) });
  }).join(',\n');

  var prompt = 'Eres un clasificador de facturas y recibos de empresas de Panamá.\n\n' +
    'CATEGORÍAS:\n' + cats + '\n\n' +
    'TAREA: Para cada email, asigna la categoría más apropiada e identifica el nombre del proveedor/comercio de forma limpia.\n' +
    'El campo "proveedor" debe ser el nombre comercial del negocio (sin prefijos como "Factura de", sin email addresses).\n\n' +
    'EMAILS:\n[' + emailsJson + ']\n\n' +
    'Responde ÚNICAMENTE con un array JSON válido, sin texto antes ni después:\n' +
    '[{"idx":0,"categoria":"restaurantes","proveedor":"Nombre Comercial"},...]';

  var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
    muteHttpExceptions: true
  });

  if (resp.getResponseCode() !== 200) {
    Logger.log('categorizarEmails Claude error: ' + resp.getContentText().substring(0, 200));
    return _jsonAcr({ ok: false, error: 'Claude API error ' + resp.getResponseCode() });
  }

  var text = '';
  var content = (JSON.parse(resp.getContentText()).content || []);
  for (var i = 0; i < content.length; i++) { if (content[i].type === 'text') { text = content[i].text; break; } }

  var jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return _jsonAcr({ ok: false, error: 'Claude no retornó JSON válido' });

  return _jsonAcr({ ok: true, result: JSON.parse(jsonMatch[0]) });
}

function _handleProcesarEmailGmail(data) {
  var msgId       = String(data.msgId       || '');
  var attDataB64  = String(data.attData     || '');
  var attFilename = String(data.attFilename || '');

  if (!msgId || !attDataB64 || !attFilename) {
    return _jsonAcr({ ok: false, error: 'msgId, attData y attFilename requeridos' });
  }
  try {
    var pdfBytes = Utilities.base64Decode(attDataB64.replace(/-/g,'+').replace(/_/g,'/'));
    if (!pdfBytes || !pdfBytes.length) return _jsonAcr({ ok: true, skipped: true, reason: 'pdf_vacio' });

    var mime = _gmailDetectMime(pdfBytes);
    if (!mime) return _jsonAcr({ ok: true, skipped: true, reason: 'formato_desconocido' });
    if (mime === 'text/html')       return _jsonAcr({ ok: true, skipped: true, reason: 'html_no_soportado' });
    if (mime === 'application/zip') return _jsonAcr({ ok: true, skipped: true, reason: 'zip_no_soportado' });
    if (mime !== 'application/pdf' && !mime.startsWith('image/') && mime !== 'text/xml') {
      return _jsonAcr({ ok: true, skipped: true, reason: 'formato_no_soportado' });
    }

    var clave = 'gmail:' + msgId + ':' + attFilename;
    if (_pendientePorMsgIdFileName(clave)) return _jsonAcr({ ok: true, skipped: true, reason: 'duplicado' });

    var parsed;
    if (mime === 'text/xml') {
      var xmlText = Utilities.newBlob(pdfBytes).getDataAsString('UTF-8');
      parsed = _parseDgiFExml(xmlText);
      if (!parsed) {
        Logger.log('_parseDgiFExml falló — usando Claude. xmlHead: ' + xmlText.substring(0, 200));
        parsed = _claudeParsearTextoFactura(xmlText, attFilename);
      }
    } else {
      var pdfB64 = Utilities.base64Encode(pdfBytes);
      parsed = _claudeParsearFacturaLibre(pdfB64, attFilename, mime);
    }

    var acreedor = {
      id: 'LIBRE', nombre: parsed.nombre_proveedor || attFilename,
      ruc: parsed.ruc_proveedor || '', categoria_def: parsed.categoria_sugerida || ''
    };
    var pref = _findOrAutoCreateAcreedor(acreedor.nombre, acreedor.ruc, acreedor.categoria_def);
    if (pref && pref.activo === false) {
      Logger.log('⏭ Acreedor ' + pref.nombre + ' desactivado — factura ignorada (procesarEmail).');
      return _jsonAcr({ ok: true, skipped: true, reason: 'acreedor_desactivado' });
    }
    if (pref && pref.categoria_def) {
      acreedor.id            = pref.id;
      acreedor.categoria_def = pref.categoria_def;
      if (pref.desc_default) parsed.descripcion = pref.desc_default;
      parsed.categoria_sugerida = pref.categoria_def;
    } else if (pref) {
      acreedor.id = pref.id;
    }
    if (parsed.num_factura && _pendienteYaExiste(parsed.num_factura, acreedor.id)) {
      return _jsonAcr({ ok: true, skipped: true, reason: 'duplicado' });
    }

    var ss       = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var cfg      = _getConfig();
    var saveMime = (mime === 'text/xml') ? 'text/xml' : 'application/pdf';
    var driveUrl = _guardarPdfAcreedor(pdfBytes, attFilename, acreedor.nombre, cfg, saveMime);
    var id       = _crearPendiente(ss, acreedor, parsed, driveUrl, clave, msgId, attFilename);

    Logger.log('Gmail import OK (' + mime + '): ' + acreedor.nombre + ' | ' + (parsed.num_factura || 'SN'));
    return _jsonAcr({ ok: true, id: id, nombre: acreedor.nombre, total: parsed.total || 0 });
  } catch(e) {
    Logger.log('Error _handleProcesarEmailGmail: ' + e.message);
    return _jsonAcr({ ok: false, error: e.message });
  }
}

// ═══════════════════════════════════════════════════════════════
//  GMAIL HISTORIAL IMPORT — server-side con OAuth token del cliente
// ═══════════════════════════════════════════════════════════════
function _handleImportarHistorialGmail(data) {
  var token = String(data.token || '');
  var days  = parseInt(data.days) || 90;
  if (!token) return _jsonAcr({ ok: false, error: 'token requerido' });

  try {
    var after = Math.floor((Date.now() - days * 86400000) / 1000);
    var q = 'has:attachment after:' + after + ' (factura OR recibo OR invoice OR receipt OR pago)';

    var listResp = UrlFetchApp.fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=50&q=' + encodeURIComponent(q),
      { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true }
    );
    if (listResp.getResponseCode() !== 200) {
      return _jsonAcr({ ok: false, error: 'Gmail API ' + listResp.getResponseCode() + ': ' + listResp.getContentText().substring(0, 200) });
    }

    var messages = JSON.parse(listResp.getContentText()).messages || [];
    var ss  = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var cfg = _getConfig();
    var stats = { total: messages.length, nuevos: 0, duplicados: 0, errores: [] };

    for (var i = 0; i < Math.min(messages.length, 30); i++) {
      var msgId = messages[i].id;
      try {
        // Get full message
        var mResp = UrlFetchApp.fetch(
          'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + msgId + '?format=full',
          { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true }
        );
        var mFull = JSON.parse(mResp.getContentText());

        // Find PDF/image attachment
        var atts = _gmailApiAtts(mFull.payload || {}, []);
        if (!atts.length) continue;

        var att = atts[0];
        var pdfBytes;

        if (att.data) {
          // Small inline attachment — data already in payload
          pdfBytes = Utilities.base64Decode(att.data.replace(/-/g, '+').replace(/_/g, '/'));
        } else {
          // Large attachment — fetch separately
          var aResp = UrlFetchApp.fetch(
            'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + msgId + '/attachments/' + att.id,
            { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true }
          );
          var aJson = JSON.parse(aResp.getContentText());
          pdfBytes = Utilities.base64Decode((aJson.data || '').replace(/-/g, '+').replace(/_/g, '/'));
        }

        if (!pdfBytes || !pdfBytes.length) continue;

        var clave = 'gmail:' + msgId + ':' + att.filename;
        if (_pendientePorMsgIdFileName(clave)) { stats.duplicados++; continue; }

        var pdfB64  = Utilities.base64Encode(pdfBytes);
        var parsed  = _claudeParsearFacturaLibre(pdfB64, att.filename);

        var acreedor = {
          id: 'LIBRE', nombre: parsed.nombre_proveedor || att.filename,
          ruc: parsed.ruc_proveedor || '', categoria_def: parsed.categoria_sugerida || ''
        };
        var pref = _findOrAutoCreateAcreedor(acreedor.nombre, acreedor.ruc, acreedor.categoria_def);
        if (pref && pref.activo === false) {
          Logger.log('⏭ Acreedor ' + pref.nombre + ' desactivado — factura ignorada (importHist).');
          stats.ignorados = (stats.ignorados || 0) + 1;
          continue;
        }
        if (pref && pref.categoria_def) {
          acreedor.id            = pref.id;
          acreedor.categoria_def = pref.categoria_def;
          if (pref.desc_default) parsed.descripcion = pref.desc_default;
          parsed.categoria_sugerida = pref.categoria_def;
        } else if (pref) {
          acreedor.id = pref.id;
        }

        if (parsed.num_factura && _pendienteYaExiste(parsed.num_factura, acreedor.id)) {
          stats.duplicados++; continue;
        }

        var driveUrl = _guardarPdfAcreedor(pdfBytes, att.filename, acreedor.nombre, cfg);
        _crearPendiente(ss, acreedor, parsed, driveUrl, clave, msgId, att.filename);
        stats.nuevos++;
        Logger.log('✅ Gmail import: ' + acreedor.nombre + ' | ' + (parsed.num_factura || 'SN'));
      } catch(eMsg) {
        stats.errores.push(eMsg.message.substring(0, 80));
        Logger.log('⚠ Error msg ' + msgId + ': ' + eMsg.message);
      }
    }

    return _jsonAcr({ ok: true, stats: stats });
  } catch(e) {
    Logger.log('Error _handleImportarHistorialGmail: ' + e.message);
    return _jsonAcr({ ok: false, error: e.message });
  }
}

// Debug: returns compact summary of MIME parts for diagnosing no_pdf
function _gmailPayloadSummary(part, depth) {
  depth = depth || 0;
  var info = { mime: part.mimeType, fname: part.filename || '',
    hasId: !!(part.body && part.body.attachmentId),
    hasData: !!(part.body && part.body.data),
    hdrs: (part.headers||[]).map(function(h){ return h.name+':'+h.value; }).join('|') };
  var out = [info];
  if (depth < 5 && part.parts) {
    for (var i=0;i<part.parts.length;i++) {
      var sub = _gmailPayloadSummary(part.parts[i], depth+1);
      for (var j=0;j<sub.length;j++) out.push(sub[j]);
    }
  }
  return out;
}

// Recorre el árbol MIME de la Gmail API buscando PDFs/imágenes adjuntas
function _gmailApiAtts(part, result) {
  var mime  = (part.mimeType || '').toLowerCase();
  var fname = part.filename  || '';

  // filename can live in Content-Disposition or Content-Type headers
  if (!fname && part.headers) {
    for (var h = 0; h < part.headers.length; h++) {
      var hn = (part.headers[h].name  || '').toLowerCase();
      var hv =  part.headers[h].value || '';
      if (hn === 'content-disposition' || hn === 'content-type') {
        var m = hv.match(/(?:filename|name)\*?=["']?(?:utf-8'')?([^"';\s]+)/i);
        if (m) { fname = decodeURIComponent(m[1]); break; }
      }
    }
  }

  var fnLow = fname.toLowerCase();
  var isPdf = mime === 'application/pdf' || mime === 'application/x-pdf' || fnLow.endsWith('.pdf');
  var isImg = mime.startsWith('image/') || /\.(jpe?g|png)$/.test(fnLow);
  var isOct = mime === 'application/octet-stream' && /\.(pdf|jpe?g|png)$/.test(fnLow);

  if ((isPdf || isImg || isOct) && part.body && (part.body.attachmentId || part.body.data)) {
    if (!fname) fname = isPdf ? 'adjunto.pdf' : 'adjunto.jpg';
    var entry = { filename: fname, mimeType: mime };
    if (part.body.attachmentId) { entry.id   = part.body.attachmentId; }
    else                        { entry.data  = part.body.data; }
    result.push(entry);
  }
  if (part.parts) {
    for (var i = 0; i < part.parts.length; i++) _gmailApiAtts(part.parts[i], result);
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
//  GMAIL IMPORT — importarFacturaGmail (single file, browser-side)
// ═══════════════════════════════════════════════════════════════
function _handleImportarFacturaGmail(data) {
  try {
    var fileBase64   = String(data.fileBase64   || '');
    var fileName     = String(data.fileName     || 'factura.pdf');
    var emailId      = String(data.emailId      || '');
    var emailSubject = String(data.emailSubject || '');
    var emailFrom    = String(data.emailFrom    || '');

    if (!fileBase64) return _jsonAcr({ ok: false, error: 'fileBase64 requerido' });

    // Dedup: same gmail message + file
    var clave = 'gmail:' + emailId + ':' + fileName;
    if (emailId && _pendientePorMsgIdFileName(clave)) {
      return _jsonAcr({ ok: true, id: '', duplicado: true });
    }

    // Parse with Claude
    var parsed = _claudeParsearFacturaLibre(fileBase64, fileName);

    // Build synthetic acreedor (look up or auto-create in Acreedores_Config)
    var acreedor = {
      id:            'LIBRE',
      nombre:        parsed.nombre_proveedor || emailFrom || fileName,
      ruc:           parsed.ruc_proveedor    || '',
      categoria_def: parsed.categoria_sugerida || ''
    };
    var pref = _findOrAutoCreateAcreedor(acreedor.nombre, acreedor.ruc, acreedor.categoria_def);
    if (pref && pref.activo === false) {
      Logger.log('⏭ Acreedor ' + pref.nombre + ' desactivado — factura ignorada (importGmail).');
      return _jsonAcr({ ok: true, id: '', skipped: true, reason: 'acreedor_desactivado' });
    }
    if (pref && pref.categoria_def) {
      acreedor.id            = pref.id;
      acreedor.categoria_def = pref.categoria_def;
      if (pref.desc_default) parsed.descripcion = pref.desc_default;
      parsed.categoria_sugerida = pref.categoria_def;
    } else if (pref) {
      acreedor.id = pref.id;
    }

    // Dedup: same invoice number for same acreedor
    if (parsed.num_factura && _pendienteYaExiste(parsed.num_factura, acreedor.id)) {
      return _jsonAcr({ ok: true, id: '', duplicado: true });
    }

    var ss  = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var cfg = _getConfig();

    // Attempt to save PDF to Drive
    var pdfBytes = Utilities.base64Decode(fileBase64);
    var driveUrl = _guardarPdfAcreedor(pdfBytes, fileName, acreedor.nombre, cfg);

    var id = _crearPendiente(ss, acreedor, parsed, driveUrl, clave, emailId, fileName);
    return _jsonAcr({ ok: true, id: id });
  } catch(e) {
    Logger.log('Error _handleImportarFacturaGmail: ' + e.message);
    return _jsonAcr({ ok: false, error: e.message });
  }
}

// ── OFX Handlers ──────────────────────────────────────────────
function _handleActualizarAlcanceEgreso(data) {
  try {
    var id      = String(data.id      || '').trim();
    var alcance = String(data.alcance || '').trim();
    if (!id || (alcance !== 'negocio' && alcance !== 'personal'))
      throw new Error('id y alcance (negocio|personal) requeridos');
    var ss     = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet  = ss.getSheetByName(SHEET_EGRESOS);
    if (!sheet) throw new Error('Hoja Egresos no encontrada');
    var numRows = sheet.getLastRow() - 1;
    if (numRows <= 0) throw new Error('Sin egresos');
    var ids = sheet.getRange(2, COL_E.ID, numRows, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0]).trim() !== id) continue;
      sheet.getRange(i + 2, COL_E.ALCANCE).setValue(alcance);
      return _jsonAcr({ success: true });
    }
    throw new Error('Egreso no encontrado: ' + id);
  } catch(e) {
    return _jsonAcr({ success: false, error: e.message });
  }
}

function _handleCategorizarTransaccionesOFX(data) {
  var transacciones = data.transacciones || [];
  if (!transacciones.length) return _jsonAcr({ ok: true, result: [] });

  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) return _jsonAcr({ ok: false, error: 'CLAUDE_API_KEY no configurada' });

  var cats = [
    'restaurantes: Restaurantes, comida rápida, delivery de comida, cafeterías',
    'alimentacion: Supermercados, tiendas de alimentos, Riba Smith, El Rey, Super 99',
    'retail: Ferreterías, tiendas de ropa, compras generales, farmacias, Romero',
    'combustible: Gasolineras, estaciones de servicio, Texaco, Shell, Delta, Puma',
    'tecnologia: Software, apps, suscripciones digitales, AWS, Google, Meta, Facebook, telecomunicaciones',
    'publicidad: Publicidad digital, Facebook Ads, Google Ads, FACEBK, Meta, marketing',
    'salud: Farmacias, clínicas, médicos, laboratorios, Arrocha, Farmacias Metro',
    'entretenimiento: Entretenimiento, viajes, hoteles, turismo, Netflix, Spotify',
    'servicios: Servicios públicos, agua, electricidad, gas, ASSA, Cable Onda, INET',
    'educacion: Colegios, universidades, cursos, libros académicos',
    'transferencias: Transferencias entre cuentas, YAPPY, Banca Móvil, ACH, pagos internos',
    'cargos_bancarios: Comisiones bancarias, intereses, cargos del banco, cuota mantenimiento',
    'otro: Categoría no identificada o ambigua'
  ].join('\n');

  var txJson = transacciones.map(function(t) {
    return JSON.stringify({ idx: t.idx, memo: String(t.memo || '').substring(0, 100), monto: t.monto });
  }).join(',\n');

  var prompt = 'Eres un clasificador de transacciones bancarias de Banco General Panamá.\n\n' +
    'Los MEMO de las transacciones suelen ser códigos truncados, ejemplos:\n' +
    '- "REST. EL MESON DEL PRA-4187-94XX-XXXX" → restaurantes\n' +
    '- "FACEBK E4XMBLDQY2" → publicidad\n' +
    '- "YAPPY BG A NOMBRE" → transferencias\n' +
    '- "BANCA MOVIL TRANSFERENCIA" → transferencias\n' +
    '- "FARMACIA ARROCHA" → salud\n' +
    '- "TEXACO 123" → combustible\n\n' +
    'CATEGORÍAS:\n' + cats + '\n\n' +
    'TAREA: Para cada transacción, asigna la categoría más apropiada e identifica el nombre limpio del proveedor/comercio.\n' +
    'El campo "proveedor" debe ser el nombre comercial del negocio (sin números de tarjeta ni códigos bancarios).\n' +
    'Si es una transferencia interna (YAPPY, Banca Móvil, ACH), el proveedor debe ser el nombre de la persona/empresa destino si aparece.\n\n' +
    'TRANSACCIONES:\n[' + txJson + ']\n\n' +
    'Responde ÚNICAMENTE con un array JSON válido, sin texto antes ni después:\n' +
    '[{"idx":0,"categoria":"restaurantes","proveedor":"Nombre Comercial"},...]';

  var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
    muteHttpExceptions: true
  });

  if (resp.getResponseCode() !== 200) {
    Logger.log('categorizarOFX Claude error: ' + resp.getContentText().substring(0, 200));
    return _jsonAcr({ ok: false, error: 'Claude API error ' + resp.getResponseCode() });
  }

  var text = '';
  var content = (JSON.parse(resp.getContentText()).content || []);
  for (var i = 0; i < content.length; i++) { if (content[i].type === 'text') { text = content[i].text; break; } }

  var jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return _jsonAcr({ ok: false, error: 'Claude no retornó JSON válido' });

  return _jsonAcr({ ok: true, result: JSON.parse(jsonMatch[0]) });
}

function _handleImportarLoteOFX(data) {
  var transacciones = data.transacciones || [];
  if (!transacciones.length) return _jsonAcr({ ok: false, error: 'Sin transacciones' });

  try {
    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_ACREEDORES_PENDING);
    if (!sheet) return _jsonAcr({ ok: false, error: 'Hoja Acreedores_Pending no encontrada' });

    var lastRow   = sheet.getLastRow();
    var existFITs = {};
    if (lastRow >= 3) {
      var numFacCol = sheet.getRange(3, COL_PEND.NUM_FAC, lastRow - 2, 1).getValues();
      for (var r = 0; r < numFacCol.length; r++) {
        var v = String(numFacCol[r][0] || '');
        if (v.indexOf('ofx:') === 0) existFITs[v] = true;
      }
    }

    var ids = lastRow >= 3 ? sheet.getRange(3, COL_PEND.ID, lastRow - 2, 1).getValues() : [];
    var maxId = 0;
    for (var j = 0; j < ids.length; j++) {
      var n = parseInt(String(ids[j][0]).replace(/\D/g, ''), 10);
      if (!isNaN(n) && n > maxId) maxId = n;
    }

    var inserted = 0, skipped = 0;
    var nuevasFila = [];

    for (var t = 0; t < transacciones.length; t++) {
      var tx       = transacciones[t];
      var fitKey   = 'ofx:' + String(tx.fitid || '');
      if (existFITs[fitKey]) { skipped++; continue; }

      maxId++;
      var alcance  = String(tx.alcance || 'negocio');
      var fila     = new Array(PEND_NCOLS);
      for (var x = 0; x < PEND_NCOLS; x++) fila[x] = '';

      fila[COL_PEND.ID - 1]          = maxId;
      fila[COL_PEND.FECHA_REG - 1]   = new Date();
      fila[COL_PEND.ESTADO - 1]      = 'borrador';
      fila[COL_PEND.ACREEDOR_ID - 1] = '';
      fila[COL_PEND.ACREEDOR_NOM -1] = String(tx.proveedor || tx.memo || 'Sin nombre');
      fila[COL_PEND.FECHA_FAC - 1]   = _parseFechaPanama(tx.fecha);
      fila[COL_PEND.NUM_FAC - 1]     = fitKey;
      fila[COL_PEND.SUBTOTAL - 1]    = parseFloat(tx.monto) || 0;
      fila[COL_PEND.ITBMS - 1]       = 0;
      fila[COL_PEND.TOTAL - 1]       = parseFloat(tx.monto) || 0;
      fila[COL_PEND.CATEGORIA - 1]   = String(tx.categoria || 'otro');
      fila[COL_PEND.DESCRIPCION - 1] = String(tx.memo || tx.proveedor || '');
      fila[COL_PEND.DRIVE_URL - 1]   = '';
      fila[COL_PEND.NOTAS - 1]       = 'ofx_import | alcance:' + alcance;
      fila[COL_PEND.EGRESO_ID - 1]   = '';
      fila[COL_PEND.MSG_ID - 1]      = fitKey;

      nuevasFila.push(fila);
      existFITs[fitKey] = true;
      inserted++;
    }

    if (nuevasFila.length) {
      var startRow = sheet.getLastRow() + 1;
      sheet.getRange(startRow, 1, nuevasFila.length, PEND_NCOLS).setValues(nuevasFila);
    }

    Logger.log('OFX import: ' + inserted + ' insertadas, ' + skipped + ' duplicadas');
    return _jsonAcr({ ok: true, inserted: inserted, skipped: skipped });
  } catch(e) {
    Logger.log('Error _handleImportarLoteOFX: ' + e.message);
    return _jsonAcr({ ok: false, error: e.message });
  }
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

// ═══════════════════════════════════════════════════════════════
//  VERIFICAR REENVÍO GMAIL — chequeo end-to-end
//
//  Lee el inbox de facturas@balanceclip.net (cuenta donde corre el
//  Apps Script) y busca correos enviados desde el remitente
//  registrado del cliente (cfg.email_*_remitente). Si encuentra al
//  menos uno, el reenvío está activo.
//
//  3 estados:
//  - status=ok        → uno o más correos detectados (count, last)
//  - status=pendiente → alias configurado pero aún no llega ningún
//                       correo del remitente (esperando primera factura)
//  - status=falta     → falta config (email_*_destino o
//                       email_*_remitente vacío)
// ═══════════════════════════════════════════════════════════════

function _handleVerificarReenvioGmail(params, callback) {
  try {
    var cfg = _getConfig();
    var dest = (cfg.email_acr_destino  || cfg.email_op_destino  || cfg.email_comprobantes || '').trim();
    var rem  = (cfg.email_acr_remitente || cfg.email_op_remitente || '').trim();

    if (!dest || !rem) {
      return _jsonpAcr({
        success: true,
        status:  'falta',
        dest:    dest,
        rem:     rem,
        msg:     'Falta configurar email_destino y/o email_remitente en Configuración → Automático.',
      }, callback);
    }

    // Buscar mensajes en el inbox del Apps Script (facturas@balanceclip.net)
    // que provengan del remitente registrado y tengan adjunto.
    // Limitamos a los últimos 90 días para que la consulta sea rápida.
    var query = 'from:' + rem + ' has:attachment newer_than:90d';
    Logger.log('🔎 verificarReenvioGmail query: ' + query);
    var threads = GmailApp.search(query, 0, 50);
    var count = 0;
    var lastMs = 0;

    for (var t = 0; t < threads.length; t++) {
      var msgs = threads[t].getMessages();
      for (var m = 0; m < msgs.length; m++) {
        var msg = msgs[m];
        var fromAddr = String(msg.getFrom() || '').toLowerCase();
        if (fromAddr.indexOf(rem.toLowerCase()) === -1) continue;
        count++;
        var d = msg.getDate();
        var ms = d ? d.getTime() : 0;
        if (ms > lastMs) lastMs = ms;
      }
    }

    if (count > 0) {
      var lastIso = lastMs ? Utilities.formatDate(new Date(lastMs), 'America/Panama', 'yyyy-MM-dd HH:mm') : '';
      return _jsonpAcr({
        success: true,
        status:  'ok',
        dest:    dest,
        rem:     rem,
        count:   count,
        last:    lastIso,
        msg:     'Reenvío activo · ' + count + ' correo(s) detectado(s) en los últimos 90 días.',
      }, callback);
    }

    return _jsonpAcr({
      success: true,
      status:  'pendiente',
      dest:    dest,
      rem:     rem,
      count:   0,
      msg:     'Alias configurado, pero aún no llega ningún correo desde ' + rem +
               '. Vuelve a verificar cuando recibas la primera factura.',
    }, callback);
  } catch (err) {
    Logger.log('❌ verificarReenvioGmail: ' + err.message);
    return _jsonpAcr({
      success: false,
      error:   err.message,
    }, callback);
  }
}

// ════════════════════════════════════════════════════════════════════
//  UTILIDAD ADMIN — limpiar egresos duplicados
//
//  Cleanup one-shot para deshacer el daño del bug histórico de race
//  condition (arreglado en PR #276). Cuando _handleAprobarAcreedor
//  procesaba un pendiente con ID duplicado, podía crear varios egresos
//  para la misma factura. Esta función los detecta y marca como
//  'anulado' (no los elimina — es reversible y queda trazabilidad).
//
//  Detección: grupo por (proveedor + num_factura + fecha + total).
//  Estrategia: mantener el más antiguo de cada grupo (fecha_registro
//  mínima), anular el resto.
//
//  USO (desde el editor de Apps Script, dropdown de funciones):
//    limpiarEgresosDuplicados              → dry-run: solo log, no toca nada
//    limpiarEgresosDuplicadosEjecutar      → ejecuta los cambios
//
//  Los reportes (P&L, ITBMS, Cierre Anual) ya filtran estado='anulado',
//  así que el total inflado se corrige al instante.
// ════════════════════════════════════════════════════════════════════
function limpiarEgresosDuplicados(ejecutar) {
  var dry = !ejecutar;
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_EGRESOS);
  if (!sheet) throw new Error('Hoja Egresos no encontrada');

  var lastRow = sheet.getLastRow();
  if (lastRow < 3) { Logger.log('Sin egresos.'); return; }

  var data = sheet.getRange(3, 1, lastRow - 2, EGRESOS_NCOLS).getValues();

  var groups = {};
  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    if (!row[COL_E.ID - 1]) continue;
    var estado = String(row[COL_E.ESTADO - 1] || '').toLowerCase();
    if (estado === 'anulado') continue;

    var prov  = String(row[COL_E.PROVEEDOR - 1] || '').trim();
    var nfac  = String(row[COL_E.NFACTURA  - 1] || '').trim();
    var fecha = row[COL_E.FECHA_GASTO - 1];
    var fechaStr = (fecha instanceof Date)
      ? Utilities.formatDate(fecha, 'America/Panama', 'yyyy-MM-dd')
      : String(fecha || '').slice(0, 10);
    var total = parseFloat(row[COL_E.TOTAL - 1]) || 0;

    // Requiere num_factura para evitar falsos positivos en gastos
    // recurrentes sin número (ej: ajustes manuales del mismo monto).
    if (!nfac || !prov) continue;

    var key = prov + '|' + nfac + '|' + fechaStr + '|' + total.toFixed(2);
    if (!groups[key]) groups[key] = [];
    groups[key].push({
      sheetRow: i + 3,
      id:       String(row[COL_E.ID - 1]),
      fechaReg: String(row[COL_E.FECHA_REG - 1] || ''),
      total:    total,
    });
  }

  var totalAnulados = 0;
  var montoInflado = 0;
  var reporte = [];
  Object.keys(groups).forEach(function(key) {
    var rows = groups[key];
    if (rows.length < 2) return;
    rows.sort(function(a, b) { return a.fechaReg < b.fechaReg ? -1 : (a.fechaReg > b.fechaReg ? 1 : 0); });
    var keeper = rows[0];
    var dupes  = rows.slice(1);
    reporte.push('  • ' + key + ' — mantener ' + keeper.id + ', anular ' + dupes.length + ' (' + dupes.map(function(d){return d.id}).join(', ') + ')');

    if (!dry) {
      for (var d = 0; d < dupes.length; d++) {
        var dup = dupes[d];
        sheet.getRange(dup.sheetRow, COL_E.ESTADO).setValue('anulado');
        var notasActuales = String(sheet.getRange(dup.sheetRow, COL_E.NOTAS).getValue() || '');
        var notaAnulado = 'AUTO-ANULADO duplicado de ' + keeper.id + ' | ' +
                          Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm');
        sheet.getRange(dup.sheetRow, COL_E.NOTAS).setValue(
          notasActuales ? notasActuales + ' | ' + notaAnulado : notaAnulado
        );
        sheet.getRange(dup.sheetRow, 1, 1, EGRESOS_NCOLS).setBackground('#FFEBEE');
      }
    }
    totalAnulados += dupes.length;
    montoInflado  += dupes.length * keeper.total;
  });

  Logger.log('═══════════════════════════════════════════════');
  Logger.log(dry ? '🔍 DRY-RUN (no se modificó nada)' : '✅ EJECUTADO');
  Logger.log('═══════════════════════════════════════════════');
  Logger.log('Grupos con duplicados encontrados: ' + reporte.length);
  Logger.log('Egresos a anular: ' + totalAnulados);
  Logger.log('Monto inflado a recuperar: $' + montoInflado.toFixed(2));
  Logger.log('');
  reporte.forEach(function(r) { Logger.log(r); });
  if (dry) {
    Logger.log('');
    Logger.log('Para ejecutar de verdad: corré la función limpiarEgresosDuplicadosEjecutar');
  }
}

// Wrapper sin argumentos para poder ejecutar desde el dropdown del
// editor de Apps Script (que no permite pasar parámetros). Ejecuta
// la limpieza de verdad — marca duplicados como 'anulado'.
function limpiarEgresosDuplicadosEjecutar() {
  return limpiarEgresosDuplicados(true);
}
