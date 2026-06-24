// ════════════════════════════════════════════════════════════════════
//  DEDUCIBLES PERSONALES DGI — Form 90 Panamá (Fase 5)
//  ──────────────────────────────────────────────────────────────────
//  Detección proactiva de gastos deducibles del Impuesto Sobre la
//  Renta de persona natural (Form 90 DGI Panamá). El cliente típico
//  deja $500-$3,000 sin reclamar al año por no llevar el track
//  correcto. Este módulo:
//
//    1. Insert hint en cada factura aprobada cuya categoría DGI mapee
//       a una línea DP-N. Acumulado anual se ve en el mensaje.
//    2. Resumen por WhatsApp del año fiscal actual con desglose por
//       línea DP-N. Comando: opción del menú "Mis deducibles DGI".
//    3. Genera un Excel pre-llenado en Drive con todos los registros
//       deducibles del año, listo para llevar al contador o subir a
//       eTax2.
//    4. Expone un tool a Claude (resumen_deducibles_dgi) para que
//       el cliente pueda preguntar libremente "¿cuánto llevo en
//       deducibles este año?".
//
//  IMPORTANTE: no hardcodeamos los topes legales de cada línea DP-N
//  porque cambian con reformas fiscales (CFP Art. 762 ha cambiado
//  varias veces en los últimos años). El bot muestra el acumulado
//  y recomienda contrastar con el contador. Evita responsabilidad
//  legal de dar un consejo desactualizado.
// ════════════════════════════════════════════════════════════════════

// Mapeo categoría DGI interna → línea del Form 90.
// Source: CATEGORIAS_GASTO_DGI en Code.js (sección "Deducibles personales").
var DEDUCIBLES_LINEAS = {
  gastos_medicos: {
    linea:      'DP-1',
    label:      'Gastos médicos',
    descripcion: 'Salud propia y de dependientes (cónyuge, hijos)',
  },
  gastos_escolares: {
    linea:      'DP-2',
    label:      'Gastos escolares',
    descripcion: 'Educación de hijos dependientes',
  },
  intereses_hipotecarios: {
    linea:      'DP-3',
    label:      'Intereses hipotecarios',
    descripcion: 'Vivienda principal en territorio nacional',
  },
  intereses_prestamos_educativos: {
    linea:      'DP-4',
    label:      'Intereses préstamos educativos',
    descripcion: 'Educación propia o de dependientes',
  },
  gastos_escolares_discapacitados: {
    linea:      'DP-5',
    label:      'Gastos escolares (discapacidad)',
    descripcion: 'Educación especial para hijos con discapacidad',
  },
};

// ════════════════════════════════════════════════════════════════════
//  HELPERS DE CONSULTA
// ════════════════════════════════════════════════════════════════════

function _deduciblesEsLineaDP(categoria) {
  return !!DEDUCIBLES_LINEAS[String(categoria || '').trim()];
}

function _deduciblesGetLinea(categoria) {
  return DEDUCIBLES_LINEAS[String(categoria || '').trim()] || null;
}

// ════════════════════════════════════════════════════════════════════
//  HINT PARA FACTURA APROBADA — línea corta para insertar en el
//  mensaje de aprobación del bot cuando la categoría es deducible.
// ════════════════════════════════════════════════════════════════════

function _deduciblesHintParaFactura(categoria) {
  var info = _deduciblesGetLinea(categoria);
  if (!info) return '';
  var hoy = new Date();
  var anio = hoy.getFullYear();
  var acum = _deduciblesAcumuladoPorLinea(anio, categoria);
  return '\n💰 Suma a tus *deducibles personales* (' + info.linea + ' — ' + info.label + ')' +
         '\n   Acumulado ' + anio + ': $' + acum.toFixed(2);
}

// ════════════════════════════════════════════════════════════════════
//  ACUMULADO POR LÍNEA — usa el dataset del AsesorGastos (que ya
//  filtra anulados, cancelados, rechazados).
// ════════════════════════════════════════════════════════════════════

function _deduciblesAcumuladoPorLinea(anioFiscal, categoria) {
  if (typeof _agLoadDataset !== 'function') return 0;
  var ds = _agLoadDataset();
  var anioStr = String(anioFiscal);
  var sum = 0;
  ds.egresos.forEach(function(r) {
    if (r.categoria !== categoria) return;
    if (r.alcance !== 'personal') return;
    if (String(r.fechaIso).substring(0, 4) !== anioStr) return;
    sum += r.total;
  });
  return +sum.toFixed(2);
}

// Devuelve { linea: 'DP-1', label, total, count, ultima_fecha, registros }
// por cada categoría DP-N detectada en el año.
function _deduciblesScorecardAnual(anioFiscal) {
  if (typeof _agLoadDataset !== 'function') {
    return { ok: false, error: 'AsesorGastos no disponible' };
  }
  if (!anioFiscal) anioFiscal = new Date().getFullYear();
  var anioStr = String(anioFiscal);
  var ds = _agLoadDataset();
  var porCategoria = {};
  Object.keys(DEDUCIBLES_LINEAS).forEach(function(cat) {
    porCategoria[cat] = {
      linea:         DEDUCIBLES_LINEAS[cat].linea,
      label:         DEDUCIBLES_LINEAS[cat].label,
      descripcion:   DEDUCIBLES_LINEAS[cat].descripcion,
      total:         0,
      count:         0,
      ultima_fecha:  null,
      registros:     [],
    };
  });

  ds.egresos.forEach(function(r) {
    if (!DEDUCIBLES_LINEAS[r.categoria]) return;
    if (r.alcance !== 'personal') return;
    if (String(r.fechaIso).substring(0, 4) !== anioStr) return;
    var bucket = porCategoria[r.categoria];
    bucket.total += r.total;
    bucket.count++;
    if (!bucket.ultima_fecha || r.fechaIso > bucket.ultima_fecha) bucket.ultima_fecha = r.fechaIso;
    bucket.registros.push({
      id:        r.id,
      fecha:     r.fechaIso,
      proveedor: r.proveedor,
      monto:     r.total,
    });
  });

  // Sumas
  var totalGeneral = 0;
  Object.keys(porCategoria).forEach(function(c) {
    porCategoria[c].total = +porCategoria[c].total.toFixed(2);
    totalGeneral += porCategoria[c].total;
  });

  return {
    ok:            true,
    anio_fiscal:   parseInt(anioStr, 10),
    total_general: +totalGeneral.toFixed(2),
    por_linea:     porCategoria,
  };
}

// ════════════════════════════════════════════════════════════════════
//  RENDER WHATSAPP — resumen para mensaje de chat
// ════════════════════════════════════════════════════════════════════

function _deduciblesRenderResumen(scorecard) {
  if (!scorecard || !scorecard.ok) {
    return '⚠️ No pude generar el resumen: ' + (scorecard ? scorecard.error : 'error desconocido');
  }
  var lineas = [];
  lineas.push('🧾 *Tus deducibles personales DGI — año fiscal ' + scorecard.anio_fiscal + '*');
  lineas.push('');
  lineas.push('Acumulado total: *$' + scorecard.total_general.toFixed(2) + '*');
  lineas.push('');
  lineas.push('━━━━━━━━━━━━━━━━━━━━━━━');
  lineas.push('');

  var orden = ['gastos_medicos', 'gastos_escolares', 'intereses_hipotecarios',
               'intereses_prestamos_educativos', 'gastos_escolares_discapacitados'];
  var algunoConRegistros = false;
  orden.forEach(function(cat) {
    var b = scorecard.por_linea[cat];
    if (!b) return;
    if (b.count === 0) {
      lineas.push('▫️ *' + b.linea + ' — ' + b.label + '*: $0.00 _(sin registros)_');
    } else {
      algunoConRegistros = true;
      lineas.push('✅ *' + b.linea + ' — ' + b.label + '*: $' + b.total.toFixed(2));
      lineas.push('    ' + b.count + ' registro(s) · última: ' + b.ultima_fecha);
    }
  });
  lineas.push('');

  if (!algunoConRegistros) {
    lineas.push('_Aún no tienes gastos categorizados como deducibles personales este año fiscal. Al registrar tus facturas, asigna las que correspondan (salud, educación, intereses hipotecarios) a sus categorías DP-N para que sumen aquí._');
  } else {
    lineas.push('━━━━━━━━━━━━━━━━━━━━━━━');
    lineas.push('');
    lineas.push('📚 *Sobre las deducciones personales*');
    lineas.push('El Form 90 de DGI Panamá permite restar de tu renta gravable los gastos personales que califiquen — médicos, educación, intereses hipotecarios y de préstamos educativos. Llevar el track durante el año evita perder deducciones al cierre fiscal en febrero/marzo.');
    lineas.push('');
    lineas.push('_Los topes legales por línea (ej: DP-3 hasta $15K, DP-2 con límite por dependiente) cambian con reformas. Confirma con tu contador antes de presentar la declaración. Este resumen es solo un acumulado de tus registros, no asesoría fiscal._');
  }
  return lineas.join('\n');
}

// ════════════════════════════════════════════════════════════════════
//  FORM 90 GENERATOR — Excel/CSV en Drive con todos los registros
//  deducibles del año. URL devuelta al cliente.
// ════════════════════════════════════════════════════════════════════

function _deduciblesGenerarForm90Excel(anioFiscal) {
  if (!anioFiscal) anioFiscal = new Date().getFullYear();
  var scorecard = _deduciblesScorecardAnual(anioFiscal);
  if (!scorecard.ok) throw new Error(scorecard.error);

  // Crear un nuevo Spreadsheet en Drive con un nombre identificable.
  var nombreNeg = String(CONFIG.NEGOCIO || 'Cliente').replace(/[^a-zA-Z0-9 ]/g, '').trim();
  var fileName = 'Form90_Deducibles_' + nombreNeg + '_' + anioFiscal;
  var ss = SpreadsheetApp.create(fileName);
  var sheet = ss.getActiveSheet();
  sheet.setName('Deducibles ' + anioFiscal);

  // Headers
  var headers = ['Línea DP', 'Categoría', 'Fecha', 'Proveedor', 'Monto USD', 'Descripción'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');

  // Filas detalle, agrupadas por línea
  var rows = [];
  var orden = ['gastos_medicos', 'gastos_escolares', 'intereses_hipotecarios',
               'intereses_prestamos_educativos', 'gastos_escolares_discapacitados'];
  orden.forEach(function(cat) {
    var b = scorecard.por_linea[cat];
    if (!b || b.count === 0) return;
    b.registros.sort(function(a, c) { return String(a.fecha).localeCompare(String(c.fecha)); });
    b.registros.forEach(function(r) {
      rows.push([b.linea, b.label, r.fecha, r.proveedor, r.monto, '']);
    });
    // Subtotal por línea
    rows.push(['', b.label + ' (subtotal)', '', '', b.total, b.count + ' registros']);
    rows.push(['', '', '', '', '', '']);
  });
  // Total general
  rows.push(['', 'TOTAL DEDUCIBLES PERSONALES', '', '', scorecard.total_general, scorecard.anio_fiscal]);

  if (rows.length) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }

  // Auto-resize y formato número en la columna Monto
  sheet.autoResizeColumns(1, headers.length);
  sheet.getRange(2, 5, rows.length, 1).setNumberFormat('"$"#,##0.00');

  // Mover a la carpeta del cliente si está configurada
  try {
    var folderId = CONFIG && CONFIG.VOUCHER_FOLDER_ID;
    if (folderId) {
      var file = DriveApp.getFileById(ss.getId());
      var folder = DriveApp.getFolderById(folderId);
      folder.addFile(file);
      DriveApp.getRootFolder().removeFile(file);
    }
  } catch(e) {
    Logger.log('Form90 Drive move ERROR: ' + e.message);
  }

  // Permiso de lectura por link
  try {
    DriveApp.getFileById(ss.getId()).setSharing(
      DriveApp.Access.ANYONE_WITH_LINK,
      DriveApp.Permission.VIEW
    );
  } catch(e) { Logger.log('Form90 sharing ERROR: ' + e.message); }

  return {
    ok:        true,
    file_name: fileName,
    url:       ss.getUrl(),
    file_id:   ss.getId(),
    rows:      rows.length,
    total:     scorecard.total_general,
  };
}

// ════════════════════════════════════════════════════════════════════
//  HANDLER DEL MENÚ — invocado al tocar "Mis deducibles DGI"
// ════════════════════════════════════════════════════════════════════

function _deduciblesMenuHandler(from, token, phoneId) {
  try {
    var hoy = new Date();
    var scorecard = _deduciblesScorecardAnual(hoy.getFullYear());
    _whatsappReply(from, _deduciblesRenderResumen(scorecard), token, phoneId);

    // Solo ofrecemos generar el Excel si hay registros — sin datos
    // no tiene sentido enviar un archivo vacío.
    if (scorecard.ok && scorecard.total_general > 0) {
      Utilities.sleep(400);
      _whatsappReply(from,
        '📥 *¿Quieres el Excel para tu contador?*\n\n' +
        'Te genero un archivo con el detalle de los registros y subtotales por línea DP-N, listo para revisar antes de la declaración anual.\n\n' +
        'Responde *sí* para generarlo, o escribe *menu* para volver al menú principal.',
        token, phoneId);
      _menuSetIntent(from, { kind: 'generar_form90', step: 'esperar_confirmacion' });
    } else {
      // Sin registros: ofrecer link al dashboard para los otros reportes.
      Utilities.sleep(400);
      _whatsappReply(from,
        '📥 *Otros reportes*\n\n' +
        'Excel del mes, ITBMS y cierre anual están disponibles en tu dashboard:\n' +
        _whatsappFrontendUrl() + '/reportes/',
        token, phoneId);
    }
  } catch(err) {
    Logger.log('_deduciblesMenuHandler error: ' + err.message);
    _whatsappReply(from, '⚠️ No pude generar el resumen: ' + err.message, token, phoneId);
  }
}

// Llamado desde WhatsApp.gs cuando hay intent generar_form90 activo
// y el cliente responde "sí" / "no" / etc.
function _deduciblesHandleConfirmacionForm90(body, from, token, phoneId) {
  var t = String(body || '').trim().toLowerCase();
  if (typeof _menuClearIntent === 'function') _menuClearIntent(from);
  if (!/^(si|sí|s|yes|ok|dale|claro|por favor|porfavor|hazlo|genera|generalo|generar)/i.test(t)) {
    _whatsappReply(from, '👍 Sin problema, no genero el Excel. Cuando quieras, toca *Mis deducibles DGI* en el menú.', token, phoneId);
    return;
  }
  _whatsappReply(from, '⏳ Generando tu archivo Excel del Form 90… (15 segundos)', token, phoneId);
  try {
    var result = _deduciblesGenerarForm90Excel();
    Utilities.sleep(400);
    _whatsappReply(from,
      '✅ *Form 90 generado*\n\n' +
      '📊 Total deducibles: *$' + result.total.toFixed(2) + '*\n' +
      '📄 Filas en el Excel: ' + result.rows + '\n\n' +
      '🔗 Abre el archivo:\n' + result.url + '\n\n' +
      '_El archivo es de solo lectura. Llévalo a tu contador o úsalo de referencia al llenar el Form 90 en eTax2._',
      token, phoneId);
  } catch(err) {
    Logger.log('_deduciblesHandleConfirmacionForm90 error: ' + err.message);
    _whatsappReply(from, '⚠️ No pude generar el Excel: ' + err.message, token, phoneId);
  }
}

// ════════════════════════════════════════════════════════════════════
//  TOOL PARA EL AsesorGastos — preguntas libres del cliente
// ════════════════════════════════════════════════════════════════════

function _agToolResumenDeducibles(input) {
  var anio = (input && input.anio_fiscal) || new Date().getFullYear();
  var scorecard = _deduciblesScorecardAnual(parseInt(anio, 10));
  // Limpiamos los arrays de registros del payload para que Claude no
  // los liste enteros — el detalle se ve en el Excel descargable.
  if (scorecard && scorecard.por_linea) {
    Object.keys(scorecard.por_linea).forEach(function(k) {
      delete scorecard.por_linea[k].registros;
    });
  }
  return scorecard;
}

// ════════════════════════════════════════════════════════════════════
//  TEST HELPERS — para correr desde el editor del GAS
// ════════════════════════════════════════════════════════════════════

function _deduciblesTestScorecard() {
  var s = _deduciblesScorecardAnual();
  Logger.log(JSON.stringify(s, null, 2));
  Logger.log('---');
  Logger.log(_deduciblesRenderResumen(s));
}

function _deduciblesTestExcel() {
  var r = _deduciblesGenerarForm90Excel();
  Logger.log(JSON.stringify(r, null, 2));
}
