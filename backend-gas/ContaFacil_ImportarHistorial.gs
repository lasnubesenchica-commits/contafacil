// ═══════════════════════════════════════════════════════════════
//  ContaFacil_ImportHistorial.gs  — v2.9k
//  v2.9k — fallback de clasificación para archivos desconocidos:
//    _clasificarArchivos: post-loop, si factura_ceyco ya está
//    identificada, cualquier archivo no clasificado (JPEG, PDF con
//    nombre sin keywords) se promueve automáticamente a factura_costo
//    en vez de descartarse silenciosamente.
//    Resuelve: "LOGIG TRADE DE PANAMA.jpeg" → desconocido (FACT518)
//    y cualquier proveedor con nombre de archivo atípico en el futuro.
//  v2.9j — crédito fiscal ITBM importación (DHL/FedEx):
//    Post-proceso B: conserva itbm_credito en parsed._itbm_credito.
//    PASO 9: genera egreso tipo credito_fiscal + ST_Item tipo
//    credito_fiscal por cada factura de importación con ITBM.
//    El costo neto (sin ITBM) sigue registrándose como impuesto.
//    Requiere credito_fiscal en ST_TIPOS_ITEM (ServiciosTecnicos.gs).
//  v2.9h — fix matching códigos TME/Weidmüller:
//    1. _normalizarCodigo: strip prefijo "WM-" antes de normalizar,
//       permite matching entre WM-1083230000 (TME) y 1083230000 (CEYCO).
//    2. Prompt REGLA 1: instrucción explícita para facturas TME donde
//       el código está como primera línea del bloque descripción,
//       no en columna separada. Ej: WM-1083230000 → codigo="WM-1083230000".
//  v2.9g — retry automático en llamadas Claude API:
//    _claudeFetchConRetry: 3 intentos con backoff 15s para errores
//    529 (Overloaded), 500, 503, 429. Aplica a parsear CEYCO y costo.
//    max_tokens confirmado en 2000 en ambas funciones ✅
//  v2.9f — drive_url_factura en ST_Items:
//    _crearSTItem y _crearSTItemGeneral ahora escriben la URL de la
//    factura de costo en COL_STI.DRIVE_URL (col Q drive_url_factura).
//  v2.9e — fix crítico id_st_item:
//    fila[COL_E.ID_ST_ITEM-1] se asignaba DESPUÉS de setValues → nunca se escribía.
//    Movido ANTES del setValues. Requiere ContaFacil_Main v12.2 (EGRESOS_NCOLS=21).
//  v2.9c — fix columna id_st_item (incompleto):
//    Escribir id_st_item con getRange(row,21).setValue() directo en la hoja,
//    independiente de EGRESOS_NCOLS. Evita el problema del array corto.
//  v2.9b — fix columna id_st_item (parcial, array corto):
//    id_st_item se escribía en col Q (id_item_cv) en vez de col U (id_st_item=21).
//  v2.9 — 1 fix sobre v2.8:
//    FIX-4: id_st_item y drive_url ahora se registran en TODOS los egresos
//           (producto, envío/manejo y costo general). El ID del ST_Item se
//           pre-genera antes del egreso para que ambos registros compartan
//           la misma referencia — necesario para borrado/edición en dashboard.
//  v2.8 — 1 fix sobre v2.7:
//    FIX-3: Regla DHL simplificada — restar SOLO líneas ITBM/ITBMS
//           (en cualquier variante: ITBM, ITBMS, I.T.B.M.S., I.T.B.M.S.(7%))
//           IMP, MISCELANEOS, aranceles → NO se restan (son costo real)
//           Ejemplo PC242424: 46.61 - 12.24 - 1.54 = 32.83 ✅
//           Post-proceso B reescrito — lógica más simple y robusta.
//  v2.7 — 2 fixes sobre v2.6:
//    FIX-1: Post-proceso A — S&H genérico ya NO se crea si la
//           diferencia está cubierta por ítems de envío explícitos
//           (Transport TME, SHIPPING COST Dimyeen, etc.)
//           Resuelve: duplicación "Transport + SHIPPING & HANDLING"
//    FIX-2: Prompt DHL — itbm_mercancias apuntaba al TOTAL IMPUESTOS
//           de la sección (incluía IMP+MISCELANEOS). Corregido.
//  ─────────────────────────────────────────────────────────────
//  v2.6 — 3 cambios mínimos sobre v2.0:
//    1. Prompt _parsearFacturaCosto: ejemplo TME Transport → codigo=null
//    2. _insertarEgreso: guard total<=0 (FedEx $0 omitido)
//    3. PASO 4: dedup facturas_costo por proveedor+num_factura
//  Módulo: Importación de historial de ventas CEYCO desde Google Drive
//  Ramon Pico / Círculo Financiero S.A.
//
//  LÓGICA v2:
//    • Factura CEYCO  → multi-ítem, cada ítem tiene código de producto
//    • Facturas costo → todas las demás (proveedor, aduana, DHL, flete)
//                       pueden ser múltiples por folder
//    • Voucher        → comprobante de pago del cliente (Yappy, ACH, etc.)
//    • .msg           → ignorar siempre
//
//  MATCHING ÍTEM-A-ÍTEM:
//    1. Normalizar código (uppercase, strip guiones/espacios/puntos)
//    2. Buscar código normalizado en ítems de facturas de costo
//    3. Fallback: matching por descripción si código no coincide
//    4. Sin match en facturas → buscar en inventario → descontar stock
//    5. Sin match en ninguno  → marcar ítem con WARNING para revisión
//
//  TIPOS DE COSTO POR ÍTEM:
//    'venta_directa'   — ítem matcheado con factura de proveedor
//    'venta_inventario'— ítem cubierto por inventario (stock decrementado)
//    'warning'         — ítem sin costo encontrado — requiere revisión CEYCO
//
//  COSTOS GENERALES (flete, aduana, DHL sin código de producto):
//    → Un ST_Item separado por cada factura de costo general
//    → Egreso independiente, no vinculado a un ítem de producto
//
//  ESTADO DEL ST:
//    'venta_directa'   — todos los ítems vienen de facturas de costo
//    'venta_inventario'— todos los ítems vienen de inventario
//    'mixta'           — combinación de directa + inventario
//    'warning'         — al menos un ítem sin costo → FLAG revisión
//    + 'cerrado' / 'en_ejecucion' según si hay voucher
//
//  EJECUCIÓN (una sola vez, en orden):
//    1. verificarSetupImportacion()
//    2. importarHistorialMes('ENERO 2026')
//    3. Revisar hoja Import_Log
//    4. Repetir para FEBRERO 2026 y MARZO 2026
// ═══════════════════════════════════════════════════════════════

// ── CONFIG DEL MÓDULO ─────────────────────────────────────────
var IH_CONFIG = {
  DRIVE_FOLDER_ID:  '1X5kaZXlks1iAOG4SN-aVL0TJDQainROt',
  MESES_VALIDOS:    ['ENERO 2026', 'FEBRERO 2026', 'MARZO 2026'],
  SHEET_IMPORT_LOG: 'Import_Log',
  LOG_NCOLS:        14,   // +2 cols vs v1: tipo_venta, items_warning
  MIME_IGNORADOS:   [
    'application/vnd.ms-outlook',   // .msg
    'application/octet-stream',     // catch-all — evaluar por extensión
  ],
  EXT_IGNORADAS:    ['.msg', '.eml', '.tmp'],
};

// ── COLUMNAS Import_Log (base 1) ─────────────────────────────
var COL_IL = {
  FECHA_IMPORT:   1,   // A
  MES:            2,   // B
  CARPETA:        3,   // C
  ID_ST:          4,   // D
  NUM_FACTURA:    5,   // E
  CLIENTE:        6,   // F
  TOTAL_VENTA:    7,   // G
  TOTAL_COSTO:    8,   // H
  TIPO_VENTA:     9,   // I  'venta_directa'|'venta_inventario'|'mixta'|'warning'
  TIPO_COSTO:    10,   // J  detalle de fuentes de costo
  ESTADO:        11,   // K  'completo'|'sin_voucher'|'sin_costo'|'error'
  INGRESO_ID:    12,   // L
  ITEMS_WARNING: 13,   // M  códigos de producto sin costo encontrado
  ERROR_MSG:     14,   // N
};

// ── TIPOS de clasificación ────────────────────────────────────
var IH_TIPO = {
  FACTURA_CEYCO:    'factura_ceyco',
  FACTURA_COSTO:    'factura_costo',    // cualquier factura de proveedor/aduana/flete
  VOUCHER:          'voucher',
  NOTA_CREDITO:     'nota_credito',     // nota de crédito emitida por CEYCO que anula una factura
  IGNORAR:          'ignorar',
  DESCONOCIDO:      'desconocido',
};


// ═══════════════════════════════════════════════════════════════
//  FUNCIÓN PRINCIPAL
// ═══════════════════════════════════════════════════════════════

function importarHistorialMes(mes) {
  if (IH_CONFIG.MESES_VALIDOS.indexOf(mes) === -1) {
    Logger.log('❌ Mes no válido: "' + mes + '". Usar: ' + IH_CONFIG.MESES_VALIDOS.join(', '));
    return;
  }
  Logger.log('═══════════════════════════════════════════');
  Logger.log('🗂️  IMPORTANDO HISTORIAL: ' + mes);
  Logger.log('═══════════════════════════════════════════');

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  _initImportLog(ss);

  var logSheet      = ss.getSheetByName(IH_CONFIG.SHEET_IMPORT_LOG);
  var yaProcessadas = _carpetasYaProcesadas(logSheet, mes);

  if (yaProcessadas.total > 0) {
    Logger.log('⚠️  ' + yaProcessadas.total + ' carpeta(s) ya procesadas — se omitirán y se retomará desde donde quedó.');
    Logger.log('   Para reimportar todo desde cero: limpiarEnero2026() + reimportar.');
  }

  var rootFolder    = DriveApp.getFolderById(IH_CONFIG.DRIVE_FOLDER_ID);
  var mesFolderIter = rootFolder.getFoldersByName(mes);
  if (!mesFolderIter.hasNext()) {
    Logger.log('❌ Carpeta "' + mes + '" no encontrada en Drive.');
    return;
  }
  var mesFolder = mesFolderIter.next();

  var factFolders = mesFolder.getFolders();
  var stats = { completo: 0, sin_voucher: 0, warning: 0, error: 0, omitidas: yaProcessadas.total };

  while (factFolders.hasNext()) {
    var factFolder    = factFolders.next();
    var nombreCarpeta = factFolder.getName();

    if (yaProcessadas.set[nombreCarpeta]) {
      Logger.log('⏭️  Omitiendo (ya procesada): ' + nombreCarpeta);
      continue;
    }

    Logger.log('\n📁 ' + nombreCarpeta);

    try {
      var resultado = _procesarCarpetaFactura(ss, factFolder, mes);
      _registrarLogImport(logSheet, mes, nombreCarpeta, resultado);

      var s = resultado.estado;
      if (s === 'error')       { stats.error++;       Logger.log('  ❌ ' + resultado.error_msg); }
      else if (s === 'warning'){ stats.warning++;      Logger.log('  ⚠️  Warning — items sin costo: ' + resultado.items_warning); }
      else if (s === 'sin_voucher'){ stats.sin_voucher++; Logger.log('  ⚠️  Sin voucher — ST: ' + resultado.id_st); }
      else                     { stats.completo++;     Logger.log('  ✅ ST: ' + resultado.id_st + ' | $' + resultado.total_venta + ' | tipo: ' + resultado.tipo_venta); }
    } catch (err) {
      stats.error++;
      Logger.log('  ❌ Excepción: ' + err.message);
      _registrarLogImport(logSheet, mes, nombreCarpeta, {
        id_st: '', num_factura: '', cliente: '',
        total_venta: 0, total_costo: 0,
        tipo_venta: '', tipo_costo: '',
        estado: 'error', ingreso_id: '',
        items_warning: '', error_msg: err.message,
      });
    }
    Utilities.sleep(2000); // respetar quota Claude
  }

  Logger.log('\n═══════════════════════════════════════════');
  Logger.log('📊 RESUMEN ' + mes + ':');
  Logger.log('  ✅ Completos:    ' + stats.completo);
  Logger.log('  ⚠️  Sin voucher: ' + stats.sin_voucher);
  Logger.log('  🚨 Warning:     ' + stats.warning);
  Logger.log('  ❌ Errores:     ' + stats.error);
  Logger.log('  ⏭️  Omitidas:    ' + stats.omitidas + ' (ya procesadas)');
  Logger.log('═══════════════════════════════════════════');
}


// ═══════════════════════════════════════════════════════════════
//  _procesarCarpetaFactura — núcleo del módulo
// ═══════════════════════════════════════════════════════════════

function _procesarCarpetaFactura(ss, folder, mes) {
  var resultado = {
    id_st: '', num_factura: '', cliente: '',
    total_venta: 0, total_costo: 0,
    tipo_venta: '', tipo_costo: '',
    estado: 'error', ingreso_id: '',
    items_warning: '', error_msg: '',
  };

  // ── PASO 1: Listar archivos, ignorar .msg y similares ────────
  var archivosIter = folder.getFiles();
  var archivos     = [];
  var fileIdsVistos = {};  // dedup por fileId — Drive a veces itera duplicados
  while (archivosIter.hasNext()) {
    var f    = archivosIter.next();
    var mime = f.getMimeType() || '';
    var nombre = f.getName();
    var fid  = f.getId();

    // Ignorar duplicados por fileId
    if (fileIdsVistos[fid]) {
      Logger.log('  ⏭️  Ignorando duplicado: ' + nombre);
      continue;
    }
    fileIdsVistos[fid] = true;

    // Ignorar .msg / .eml y catch-all
    if (_debeIgnorar(nombre, mime)) {
      Logger.log('  ⏭️  Ignorando: ' + nombre);
      continue;
    }
    archivos.push(f);
  }

  if (archivos.length === 0) {
    resultado.error_msg = 'Carpeta sin archivos procesables';
    return resultado;
  }
  Logger.log('  📄 Archivos a procesar: ' + archivos.length);

  // ── PASO 2: Clasificar con Claude Haiku ──────────────────────
  var clasificados = _clasificarArchivos(archivos);
  Logger.log('  🏷️  ceyco=' + (clasificados.factura_ceyco ? '✅' : '❌') +
             ' | nc=' + (clasificados.nota_credito ? '✅' : '❌') +
             ' | costos=' + clasificados.facturas_costo.length +
             ' | voucher=' + (clasificados.voucher ? '✅' : '❌'));

  // ── DESVÍO: Nota de crédito ──────────────────────────────────
  // Escenario 1: carpeta tiene factura_ceyco + NC → anulación antes de despacho
  // Escenario 2: carpeta tiene solo NC → despacho ya ocurrió, reversa contable
  if (clasificados.factura_ceyco && clasificados.nota_credito) {
    Logger.log('  📋 NC + factura detectadas — Escenario 1 (anulación sin despacho)');
    return _procesarNotaCredito(ss, clasificados, mes, resultado);
  }
  if (!clasificados.factura_ceyco && clasificados.nota_credito) {
    Logger.log('  🔄 NC sola detectada — derivando a Escenario 2 (despacho ya ocurrió)');
    return _procesarNotaCreditoEscenario2(ss, clasificados.nota_credito, mes, resultado);
  }

  if (!clasificados.factura_ceyco) {
    resultado.error_msg = 'No se encontró factura emitida por CEYCO';
    return resultado;
  }

  // ── PASO 3: Parsear factura CEYCO — multi-ítem ───────────────
  var datosCeyco = _parsearFacturaCeyco(clasificados.factura_ceyco);
  if (!datosCeyco || !datosCeyco.items || !datosCeyco.items.length) {
    resultado.error_msg = 'No se pudieron extraer ítems de la factura CEYCO';
    return resultado;
  }

  resultado.num_factura = datosCeyco.num_factura || '';
  resultado.cliente     = datosCeyco.nombre_cliente || '';
  resultado.total_venta = parseFloat(datosCeyco.total || '0') || 0;

  Logger.log('  📋 Factura: ' + resultado.num_factura +
             ' | ' + resultado.cliente +
             ' | $' + resultado.total_venta +
             ' | ' + datosCeyco.items.length + ' ítem(s)');

  // Guard de duplicado
  if (_ingresoYaExiste(ss, resultado.num_factura, resultado.cliente)) {
    resultado.error_msg = 'DUPLICADO: Ingreso con factura "' + resultado.num_factura + '" ya existe';
    return resultado;
  }

  // ── PASO 4: Parsear TODAS las facturas de costo ──────────────
  //    Resultado: array de { archivo, datos: { proveedor, items[], es_general } }
  //    es_general = true cuando la factura es flete/aduana/DHL sin código de producto
  var facturasCostoParseadas = [];
  var _fVistos = {};  // dedup: evita dos JPGs del mismo doc (mismo proveedor+num_factura)
  for (var fc = 0; fc < clasificados.facturas_costo.length; fc++) {
    try {
      var datosCosto = _parsearFacturaCosto(clasificados.facturas_costo[fc]);
      if (datosCosto) {
        var _fProv = String(datosCosto.proveedor || '').trim().toUpperCase();
        var _fNum  = String(datosCosto.num_factura || '').trim();
        var _fKey  = _fProv + '||' + _fNum;
        if (_fNum && _fVistos[_fKey]) {
          Logger.log('  ⏭️  Factura duplicada omitida: ' + datosCosto.proveedor + ' | ' + _fNum);
        } else {
          if (_fNum) _fVistos[_fKey] = true;
          // Adjuntar drive_url al objeto datos — disponible luego en
          // _crearEgresoItem/_crearEgresoEnvio para registrar comprobante.
          datosCosto._drive_url = clasificados.facturas_costo[fc].getUrl();
          facturasCostoParseadas.push({
            archivo: clasificados.facturas_costo[fc],
            datos:   datosCosto,
          });
          Logger.log('  💰 Costo: ' + datosCosto.proveedor +
                     ' | $' + datosCosto.total +
                     ' | ' + (datosCosto.items || []).length + ' ítem(s)' +
                     (datosCosto.es_general ? ' [GENERAL]' : ''));
        }
      }
    } catch (parseErr) {
      Logger.log('  ⚠️  Error parseando factura de costo: ' + parseErr.message);
    }
    Utilities.sleep(500);
  }

  // ── PASO 5: Matching ítem-a-ítem ─────────────────────────────
  //    Para cada ítem de la factura CEYCO:
  //      A) Buscar en ítems de facturas de costo por código normalizado
  //      B) Fallback: matching por descripción
  //      C) Si no hay match: buscar en inventario
  //      D) Si tampoco: marcar WARNING
  var matchResults = _matchearItems(datosCeyco.items, facturasCostoParseadas, ss);

  // ── PASO 6: Calcular totales y tipo de venta del ST ──────────
  var totalCostoItems = 0;
  var tiposVenta      = {};
  var codigosWarning  = [];

  matchResults.items.forEach(function(item) {
    totalCostoItems += item.costo_total || 0;
    tiposVenta[item.tipo_costo] = true;
    if (item.tipo_costo === 'warning') codigosWarning.push(item.codigo || item.descripcion);
  });

  resultado.total_costo = parseFloat(totalCostoItems.toFixed(2));

  // Sumar costos generales (flete, aduana, etc.)
  matchResults.costos_generales.forEach(function(cg) {
    resultado.total_costo += parseFloat(cg.datos.total || '0') || 0;
  });
  resultado.total_costo = parseFloat(resultado.total_costo.toFixed(2));

  // Determinar tipo_venta
  if (tiposVenta['warning'] && !tiposVenta['venta_directa'] && !tiposVenta['venta_inventario']) {
    resultado.tipo_venta = 'warning';
  } else if (tiposVenta['venta_directa'] && !tiposVenta['venta_inventario']) {
    resultado.tipo_venta = 'venta_directa';
  } else if (tiposVenta['venta_inventario'] && !tiposVenta['venta_directa']) {
    resultado.tipo_venta = 'venta_inventario';
  } else {
    resultado.tipo_venta = tiposVenta['warning'] ? 'warning' : 'mixta';
  }

  resultado.tipo_costo    = facturasCostoParseadas.map(function(f){ return f.datos.proveedor; }).join(', ') || 'inventario';
  resultado.items_warning = codigosWarning.join(', ');

  // ── PASO 7: Crear ST ─────────────────────────────────────────
  var ahora      = new Date();
  var fechaFactu = datosCeyco.fecha ||
    Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd');
  var fechaDate  = new Date(fechaFactu + 'T12:00:00');
  var mesST      = isNaN(fechaDate.getTime()) ? ahora.getMonth()+1 : fechaDate.getMonth()+1;
  var anioST     = isNaN(fechaDate.getTime()) ? ahora.getFullYear() : fechaDate.getFullYear();

  var sheetST    = ss.getSheetByName(SHEET_ST)    || _initServiciosTecnicosSheet(ss);
  var sheetSTI   = ss.getSheetByName(SHEET_ST_ITEM)|| _initSTItemsSheet(ss);
  var seqData    = _nextSTSeq(ss);
  var idST       = 'ST-RP-' + seqData.anio + '-' + String(seqData.seq).padStart(4, '0');
  var driveUrlFact = clasificados.factura_ceyco.getUrl();
  var margenCalc   = (resultado.total_venta > 0 && resultado.total_costo > 0)
    ? parseFloat(((resultado.total_venta / resultado.total_costo - 1) * 100).toFixed(2))
    : 0;
  var fechaReg = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');

  var notaST = 'Importado historial Drive | Mes: ' + mes +
               ' | Carpeta: ' + folder.getName() +
               ' | Tipo venta: ' + resultado.tipo_venta;
  if (codigosWarning.length) notaST += ' | ⚠️ SIN COSTO: ' + resultado.items_warning;

  var filaST = new Array(ST_NCOLS);
  for (var xs = 0; xs < ST_NCOLS; xs++) filaST[xs] = '';
  filaST[COL_ST.ID - 1]              = idST;
  filaST[COL_ST.FECHA_REG - 1]       = fechaReg;
  filaST[COL_ST.ESTADO - 1]          = clasificados.voucher ? 'cerrado' : 'en_ejecucion';
  // NUM_COT: número de factura real si existe, sino correlativo
  var numCotST = resultado.num_factura
    ? 'FACT ' + String(resultado.num_factura).replace(/^0+/, '')
    : 'COT-RP-' + seqData.anio + '-' + String(seqData.seq).padStart(4, '0');
  filaST[COL_ST.NUM_COT - 1]         = numCotST;
  filaST[COL_ST.NOMBRE_CLI - 1]      = datosCeyco.nombre_cliente || '';
  filaST[COL_ST.RUC_CLI - 1]         = datosCeyco.ruc_cliente    || '';
  filaST[COL_ST.DV_CLI - 1]          = datosCeyco.dv_cliente     || '';
  filaST[COL_ST.DESCRIPCION - 1]     = datosCeyco.descripcion    || datosCeyco.items[0].descripcion || '';
  filaST[COL_ST.TOTAL_COSTO_COT - 1] = resultado.total_costo || '';
  filaST[COL_ST.TOTAL_COSTO_REAL - 1]= resultado.total_costo || '';
  filaST[COL_ST.MARGEN_PCT - 1]      = margenCalc || '';
  filaST[COL_ST.PRECIO_VENTA - 1]    = resultado.total_venta || '';
  filaST[COL_ST.DRIVE_URL - 1]       = driveUrlFact;
  filaST[COL_ST.FECHA_CIERRE - 1]    = clasificados.voucher ? fechaFactu : '';
  filaST[COL_ST.MES - 1]             = mesST;
  filaST[COL_ST.ANIO - 1]            = anioST;
  filaST[COL_ST.NOTAS - 1]           = notaST;

  var newSTRow = sheetST.getLastRow() + 1;
  sheetST.getRange(newSTRow, 1, 1, ST_NCOLS).setValues([filaST]);
  sheetST.getRange(newSTRow, COL_ST.TOTAL_COSTO_COT, 1, 3).setNumberFormat('#,##0.00');

  var bgST = resultado.tipo_venta === 'warning'         ? '#FFEBEE' :
             resultado.tipo_venta === 'venta_inventario'? '#E3F2FD' :
             clasificados.voucher                        ? '#F1F8E9' : '#F3E5F5';
  sheetST.getRange(newSTRow, 1, 1, ST_NCOLS).setBackground(bgST);
  resultado.id_st = idST;

  // ── PASO 8: Crear egresos y ST_Items por ítem de producto ────
  // El idItemST se genera ANTES de crear el egreso para que el egreso
  // pueda registrar id_st_item (necesario para operaciones de borrado
  // y edición en el dashboard de Servicios Técnicos).
  var seqItemCounter = 0;

  matchResults.items.forEach(function(itemMatch) {
    seqItemCounter++;
    var egresoId = null;

    // Generar ID del ST_Item por adelantado — se pasa al egreso y al STI
    var idItemST = 'STI-RP-' + Utilities.formatDate(ahora, 'America/Panama', 'yyyyMMddHHmmss') + '-' + seqItemCounter;
    itemMatch._id_st_item = idItemST;

    if (itemMatch.tipo_costo === 'venta_directa' && itemMatch.factura_costo_datos) {
      if (itemMatch.es_envio) {
        // Ítems de envío/manejo: usar descripción normalizada como clave única
        egresoId = _crearEgresoEnvio(ss, idST, itemMatch, ahora, fechaFactu);
      } else {
        egresoId = _crearEgresoItem(ss, idST, itemMatch, ahora, fechaFactu);
      }
    } else if (itemMatch.tipo_costo === 'venta_inventario' && itemMatch.inv_item) {
      egresoId = _crearEgresoInventario(ss, idST, itemMatch, ahora, fechaFactu, resultado.num_factura);
    }

    // Pasar idItemST pre-generado a _crearSTItem para que use el mismo ID
    _crearSTItem(sheetSTI, idST, seqItemCounter, itemMatch, egresoId, ahora, idItemST);
  });

  // ── PASO 9: Egresos y ST_Items de costos generales (FedEx, DHL, MBE boleta) ─
  // Cada costo general genera: 1 egreso contable + 1 ST_Item visible en el dashboard
  matchResults.costos_generales.forEach(function(cg) {
    seqItemCounter++;
    // Pre-generar idItemST para que egreso general y ST_Item compartan el mismo ID
    var idItemSTGen = 'STI-RP-' + Utilities.formatDate(ahora, 'America/Panama', 'yyyyMMddHHmmss') + '-' + seqItemCounter;
    var egresoGenId = _crearEgresoGeneral(ss, idST, cg.datos, cg.archivo.getUrl(), ahora, fechaFactu, idItemSTGen);
    // Crear ST_Item para que aparezca en la tabla de costos del dashboard
    _crearSTItemGeneral(sheetSTI, idST, seqItemCounter, cg.datos, egresoGenId, ahora, idItemSTGen);
    Logger.log('  💸 Costo general: ' + cg.datos.proveedor + ' $' + cg.datos.total);

    // ── Crédito fiscal ITBM (si aplica) ────────────────────
    // Si la factura de importación tenía ITBM acreditable, crear un
    // egreso separado tipo credito_fiscal y su ST_Item correspondiente.
    var itbmCredito = parseFloat(cg.datos._itbm_credito || '0') || 0;
    if (itbmCredito > 0) {
      seqItemCounter++;
      var idItemSTCred = 'STI-RP-' + Utilities.formatDate(ahora, 'America/Panama', 'yyyyMMddHHmmss') + '-' + seqItemCounter;
      var egresoCreditoId = _crearEgresoCreditoFiscal(ss, idST, cg.datos, itbmCredito, cg.archivo.getUrl(), ahora, fechaFactu, idItemSTCred);
      _crearSTItemCreditoFiscal(sheetSTI, idST, seqItemCounter, cg.datos, itbmCredito, egresoCreditoId, ahora, idItemSTCred);
      Logger.log('  💳 Crédito fiscal ITBM: ' + cg.datos.proveedor + ' $' + itbmCredito);
    }
  });

  // ── PASO 10: Registrar ingreso ───────────────────────────────
  var sheetIng    = ss.getSheetByName(CONFIG.SHEET_INGRESOS);
  if (!sheetIng) throw new Error('Hoja Ingresos no encontrada');

  var precioVenta = resultado.total_venta;
  // FIX: usar subtotal e ITBMS ya extraídos por Claude (soporta facturas mixtas gravado/exento).
  var tieneItbms  = datosCeyco.tiene_itbms !== false;
  var subtotalIng = parseFloat(datosCeyco.subtotal || '0') || 0;
  var itbmsIng    = parseFloat(datosCeyco.itbms    || '0') || 0;
  if (subtotalIng === 0 && precioVenta > 0) {
    subtotalIng = tieneItbms
      ? parseFloat((precioVenta / 1.07).toFixed(2))
      : precioVenta;
    itbmsIng = tieneItbms
      ? parseFloat((precioVenta - subtotalIng).toFixed(2))
      : 0;
  }
  var idIng     = 'ING-RP-' + Utilities.formatDate(ahora, 'America/Panama', 'yyyyMMddHHmmss') +
                  '-IH-' + String(seqData.seq).padStart(4, '0');
  var estadoIng = clasificados.voucher ? 'confirmado' : 'pendiente';

  var filaIng = new Array(INGRESOS_NCOLS);
  for (var xi = 0; xi < INGRESOS_NCOLS; xi++) filaIng[xi] = '';
  filaIng[COL_I.ID_TRANS - 1]      = idIng;
  filaIng[COL_I.FECHA_REG - 1]     = fechaReg;
  filaIng[COL_I.ESTADO - 1]        = estadoIng;
  filaIng[COL_I.CONFIANZA_IA - 1]  = 'ia_historial';
  filaIng[COL_I.FECHA_INGRESO - 1] = fechaFactu;
  filaIng[COL_I.MES - 1]           = mesST;
  filaIng[COL_I.ANIO_FISCAL - 1]   = anioST;
  filaIng[COL_I.SUBTOTAL - 1]      = subtotalIng;
  filaIng[COL_I.ITBMS - 1]         = itbmsIng;
  filaIng[COL_I.TOTAL - 1]         = precioVenta;
  filaIng[COL_I.MONEDA - 1]        = 'USD';
  filaIng[COL_I.TIPO_INGRESO - 1]  = 'venta_producto';
  filaIng[COL_I.CATEGORIA - 1]     = tieneItbms ? 'venta_producto_gravado' : 'venta_producto_exento';
  filaIng[COL_I.NOMBRE_CLI - 1]    = datosCeyco.nombre_cliente || '';
  filaIng[COL_I.RUC_CLI - 1]       = datosCeyco.ruc_cliente    || '';
  filaIng[COL_I.TIPO_PERSONA - 1]  = detectarTipoPersona(String(datosCeyco.ruc_cliente || ''));
  filaIng[COL_I.NUM_FACTURA - 1]   = datosCeyco.num_factura    || '';
  filaIng[COL_I.TIPO_COMP - 1]     = 'factura_emitida';
  filaIng[COL_I.DRIVE_URL - 1]     = driveUrlFact;  // factura emitida
  filaIng[COL_I.DESCRIPCION - 1]   = datosCeyco.descripcion    || datosCeyco.items[0].descripcion || '';
  filaIng[COL_I.NOTAS_INT - 1]     = 'ST: ' + idST + ' | Historial ' + mes +
                                      ' | Tipo: ' + resultado.tipo_venta +
                                      (codigosWarning.length ? ' | ⚠️ ' + resultado.items_warning : '');
  filaIng[COL_I.FLAG_REV - 1]      = resultado.tipo_venta === 'warning';
  filaIng[COL_I.DV_CLI - 1]        = datosCeyco.dv_cliente || '';

  var newIngRow = sheetIng.getLastRow() + 1;
  sheetIng.getRange(newIngRow, 1, 1, INGRESOS_NCOLS).setValues([filaIng]);
  sheetIng.getRange(newIngRow, COL_I.SUBTOTAL, 1, 3).setNumberFormat('#,##0.00');
  var bgIng = resultado.tipo_venta === 'warning' ? '#FFEBEE' :
              estadoIng === 'confirmado'          ? '#F1F8E9' : '#FFF3E0';
  sheetIng.getRange(newIngRow, 1, 1, INGRESOS_NCOLS).setBackground(bgIng);
  resultado.ingreso_id = idIng;

  // Vincular ingreso al ST + anotar voucher en notas si existe
  sheetST.getRange(newSTRow, COL_ST.INGRESO_ID).setValue(idIng);
  if (clasificados.voucher) {
    var driveUrlVoucher = clasificados.voucher.getUrl();
    // Guardar URL del voucher en drive_url del ingreso (= comprobante de pago)
    sheetIng.getRange(newIngRow, COL_I.DRIVE_URL).setValue(driveUrlVoucher);
    var notaActST = String(sheetST.getRange(newSTRow, COL_ST.NOTAS).getValue() || '');
    sheetST.getRange(newSTRow, COL_ST.NOTAS).setValue(
      notaActST + ' | Voucher: ' + driveUrlVoucher
    );
    resultado.estado = codigosWarning.length ? 'warning' : 'completo';
  } else {
    resultado.estado = codigosWarning.length ? 'warning' : 'sin_voucher';
  }

  Logger.log('  ✅ ST: ' + idST + ' | ING: ' + idIng + ' | tipo: ' + resultado.tipo_venta);
  return resultado;
}


// ═══════════════════════════════════════════════════════════════
//  _clasificarArchivos
//  Clasifica todos los archivos de una carpeta.
//  Retorna: { factura_ceyco, facturas_costo[], voucher, nota_credito }
// ═══════════════════════════════════════════════════════════════

function _clasificarArchivos(archivos) {
  var resultado = {
    factura_ceyco:   null,
    facturas_costo:  [],
    voucher:         null,
    nota_credito:    null,   // nota de crédito emitida por CEYCO
  };

  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');

  for (var i = 0; i < archivos.length; i++) {
    var archivo = archivos[i];
    var nombre  = archivo.getName();
    var mime    = archivo.getMimeType() || 'application/pdf';

    try {
      var blob = archivo.getBlob();
      var b64  = Utilities.base64Encode(blob.getBytes());

      // PRE-CHECK: para imágenes JPEG/PNG, intentar leer texto plano del blob
      // y verificar si el RUC de CEYCO aparece en posición de emisor.
      // Esto evita que facturas DGI en formato imagen se clasifiquen mal.
      var tipoForzado = _preCheckRucCeyco(blob, mime, nombre);
      var tipo;
      if (tipoForzado) {
        tipo = tipoForzado;
        Logger.log('    "' + nombre + '" → ' + tipo + ' (pre-check RUC)');
      } else {
        tipo = _clasificarArchivo(b64, mime, nombre, apiKey);
        Logger.log('    "' + nombre + '" → ' + tipo);
      }

      if      (tipo === IH_TIPO.FACTURA_CEYCO && !resultado.factura_ceyco) {
        resultado.factura_ceyco = archivo;
      }
      else if (tipo === IH_TIPO.NOTA_CREDITO && !resultado.nota_credito) {
        resultado.nota_credito = archivo;
      }
      else if (tipo === IH_TIPO.FACTURA_COSTO) {
        resultado.facturas_costo.push(archivo);
      }
      else if (tipo === IH_TIPO.VOUCHER && !resultado.voucher) {
        resultado.voucher = archivo;
      }

    } catch (err) {
      Logger.log('    ⚠️  Error clasificando "' + nombre + '": ' + err.message + ' — infiriendo por nombre');
      var tipoInf = _inferirTipoPorNombre(nombre);
      if      (tipoInf === IH_TIPO.FACTURA_CEYCO && !resultado.factura_ceyco) resultado.factura_ceyco = archivo;
      else if (tipoInf === IH_TIPO.NOTA_CREDITO  && !resultado.nota_credito)  resultado.nota_credito  = archivo;
      else if (tipoInf === IH_TIPO.FACTURA_COSTO) resultado.facturas_costo.push(archivo);
      else if (tipoInf === IH_TIPO.VOUCHER && !resultado.voucher) resultado.voucher = archivo;
    }
    Utilities.sleep(300);
  }

  // ── FALLBACK FINAL: promover archivos desconocidos a factura_costo ──
  // Si Haiku + _inferirTipoPorNombre no lograron clasificar un archivo
  // pero la factura CEYCO ya está identificada (contexto confirmado),
  // los archivos restantes sin clasificar son casi siempre facturas de
  // proveedor con nombres atípicos (ej: "LOGIG TRADE DE PANAMA.jpeg",
  // "AEMC.pdf"). Los promovemos a factura_costo en vez de descartar.
  // EXCEPCIÓN: si no hay factura_ceyco, no asumimos nada.
  if (resultado.factura_ceyco) {
    for (var jf = 0; jf < archivos.length; jf++) {
      var archFb = archivos[jf];
      var yaClasificado =
        (resultado.factura_ceyco  && resultado.factura_ceyco.getId()  === archFb.getId()) ||
        (resultado.nota_credito   && resultado.nota_credito.getId()   === archFb.getId()) ||
        (resultado.voucher        && resultado.voucher.getId()         === archFb.getId()) ||
        resultado.facturas_costo.some(function(fc) { return fc.getId() === archFb.getId(); });

      if (!yaClasificado) {
        var nbFb = archFb.getName();
        var mbFb = archFb.getMimeType() || '';
        if (!_debeIgnorar(nbFb, mbFb)) {
          Logger.log('    "' + nbFb + '" → factura_costo (fallback: desconocido promovido)');
          resultado.facturas_costo.push(archFb);
        }
      }
    }
  }

  return resultado;
}

// Pre-check por nombre de archivo para detectar facturas DGI de CEYCO
// sin gastar tokens de Haiku. Retorna tipo forzado o null si no aplica.
function _preCheckRucCeyco(blob, mime, nombre) {
  // Patrón DGI estándar en nombre de archivo: 01_01_0000000NNN_001_0000.pdf
  if (/^\d{2}_\d{2}_\d{7,}_\d{3}_\d{4}/.test(nombre)) return IH_TIPO.FACTURA_CEYCO;

  // Para PDFs, intentar leer texto plano buscando el RUC de la empresa como emisor
  if (mime === 'application/pdf') {
    try {
      var text    = blob.getDataAsString('UTF-8').substring(0, 3000);
      var empRuc  = _getConfig().empresa_ruc || '';
      var empRucN = empRuc.split('-')[0]; // parte numérica antes del primer guion
      // El RUC aparece en la cabecera como emisor
      if (empRuc && text.indexOf(empRuc) !== -1) return IH_TIPO.FACTURA_CEYCO;
      if (empRucN && empRucN.length >= 5 && text.indexOf(empRucN) !== -1) return IH_TIPO.FACTURA_CEYCO;
    } catch(e) { /* PDF binario — no readable, continuar con Haiku */ }
  }
  return null;
}

function _clasificarArchivo(b64, mimeType, nombre, apiKey) {
  var contentBlock = (mimeType === 'application/pdf')
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image',    source: { type: 'base64', media_type: mimeType,           data: b64 } };

  var _cfg      = _getConfig();
  var _empNombre = _cfg.empresa_nombre    || 'la empresa';
  var _empComercial = _cfg.empresa_comercial || _empNombre;
  var _empRuc   = _cfg.empresa_ruc        || '';
  var _empRucLabel = _empRuc ? ' (RUC ' + _empRuc + ')' : '';

  var prompt =
    _empComercial + ' tiene RUC ' + _empRuc + ' (' + _empNombre + ').\n\n' +
    'Clasifica este documento. Responde SOLO con una de estas palabras:\n' +
    '  factura_ceyco   — factura fiscal DGI donde ' + _empComercial + _empRucLabel + ' es el EMISOR.\n' +
    '                    El RUC aparece en la cabecera del documento junto al nombre de la empresa\n' +
    '                    como el que EMITE/VENDE. El receptor es el cliente.\n' +
    '                    El nombre del archivo puede ser cualquiera (no solo patrón DGI).\n' +
    '  nota_credito    — nota de crédito DGI emitida por ' + _empComercial + _empRucLabel + '.\n' +
    '                    El documento dice "Nota de crédito" o "Nota de crédito referenciada"\n' +
    '                    en el encabezado. La empresa es el EMISOR. Anula o revierte una factura.\n' +
    '  factura_costo   — factura de proveedor o courier cobrada A ' + _empComercial + ':\n' +
    '                    facturas de proveedor local o extranjero (TME, Mouser, Dimyeen, etc.),\n' +
    '                    factura DHL/FedEx con cobro de flete + impuestos de importación.\n' +
    '  voucher         — comprobante bancario, Yappy, ACH, transferencia, depósito.\n' +
    '  desconocido     — cualquier otra cosa que NO sea factura ni voucher.\n\n' +
    'REGLAS — siempre son "desconocido":\n' +
    '  1. ORDEN DE COMPRA emitida por un cliente A ' + _empComercial + ' (aparece como vendedor/proveedor).\n' +
    '  2. DECLARACIÓN DE ADUANA / FORMULARIO ADUANERO de la Autoridad Nacional de Aduanas\n' +
    '     de Panamá (sello GEA, formulario rosado). El costo ya está en la factura DHL.\n' +
    '  3. COTIZACIÓN o PROFORMA donde la empresa es el vendedor.\n\n' +
    'Una sola palabra, sin puntuación.';

  var payload = {
    model: 'claude-haiku-4-5-20251001', max_tokens: 10,
    messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: prompt }] }]
  };

  var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload), muteHttpExceptions: true,
  });

  if (resp.getResponseCode() !== 200) throw new Error('Haiku error ' + resp.getResponseCode());

  var text = '';
  var content = JSON.parse(resp.getContentText()).content || [];
  for (var i = 0; i < content.length; i++) {
    if (content[i].type === 'text') { text = content[i].text.trim().toLowerCase().replace(/[^a-z_]/g,''); break; }
  }
  var validos = [IH_TIPO.FACTURA_CEYCO, IH_TIPO.NOTA_CREDITO, IH_TIPO.FACTURA_COSTO, IH_TIPO.VOUCHER, IH_TIPO.DESCONOCIDO];
  return validos.indexOf(text) !== -1 ? text : _inferirTipoPorNombre(nombre);
}

function _inferirTipoPorNombre(nombre) {
  var n = nombre.toLowerCase();
  // Documentos que deben ignorarse
  if (/orden.de.compra|purchase.order|liquidacion|declaracion|aduana|formulario/.test(n)) return IH_TIPO.DESCONOCIDO;
  // Nota de crédito — patrón CUFE FE04 (tipo 4 = nota de crédito DGI) o nombre explícito
  if (/^fe04/.test(n) || /nota.de.credito|nota_credito|notacredito|credit.note/.test(n)) return IH_TIPO.NOTA_CREDITO;
  // Patrón carpeta "NC NNN..." — nota de crédito por nombre de carpeta
  if (/^nc[\s_\-]\d+/.test(n))                                                           return IH_TIPO.NOTA_CREDITO;
  // Patrones DGI factura normal: FE01 o 01_01_0000000NNN_001_0000
  if (/^fe01/.test(n))                                                                   return IH_TIPO.FACTURA_CEYCO;
  if (/^\d{2}_\d{2}_\d{7,}/.test(nombre))                                               return IH_TIPO.FACTURA_CEYCO;
  if (/deposito|transferencia|comprobante|banco|pago|voucher|yappy|ach/.test(n))         return IH_TIPO.VOUCHER;
  if (/dhl|fedex|ups|flete|proveedor|factura_prov|tme|mouser|digikey|dimyeen|phoenix|electrisa|miguelez|talleres/.test(n)) return IH_TIPO.FACTURA_COSTO;
  // PI = Proforma Invoice / Purchase Invoice — documento de proveedor extranjero
  if (/^pi[\s_\-]/.test(n) || /\bpi\b/.test(n))                                         return IH_TIPO.FACTURA_COSTO;
  if (/invoice|factura|bill/.test(n))                                                    return IH_TIPO.FACTURA_COSTO;
  if (/^\d{7,}/.test(nombre.replace(/[^0-9]/g, '')))                                    return IH_TIPO.FACTURA_CEYCO;
  return IH_TIPO.DESCONOCIDO;
}

function _debeIgnorar(nombre, mime) {
  var n = nombre.toLowerCase();
  for (var i = 0; i < IH_CONFIG.EXT_IGNORADAS.length; i++) {
    if (n.indexOf(IH_CONFIG.EXT_IGNORADAS[i]) !== -1) return true;
  }
  if (mime === 'application/vnd.ms-outlook') return true;
  return false;
}



// ═══════════════════════════════════════════════════════════════
//  _claudeFetchConRetry
//  Wrapper con reintentos automáticos para errores transitorios
//  de la API de Claude (529 Overloaded, 500, 503, 429).
//  - Hasta 3 intentos
//  - Espera 15s entre intentos
//  - Lanza error solo si los 3 intentos fallan
// ═══════════════════════════════════════════════════════════════

function _claudeFetchConRetry(payload, contexto) {
  var apiKey  = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  var opciones = {
    method: 'post', contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload), muteHttpExceptions: true,
  };
  var REINTENTOS    = 3;
  var ESPERA_MS     = 15000;
  var CODIGOS_RETRY = [429, 500, 503, 529];

  for (var intento = 1; intento <= REINTENTOS; intento++) {
    var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', opciones);
    var code = resp.getResponseCode();
    if (code === 200) return resp;

    var reintentable = CODIGOS_RETRY.indexOf(code) !== -1;
    Logger.log('  ⚠️  Claude API ' + code + ' (' + contexto + ') — intento ' + intento + '/' + REINTENTOS +
               (reintentable && intento < REINTENTOS ? ' — reintentando en ' + (ESPERA_MS/1000) + 's...' : ''));

    if (!reintentable || intento === REINTENTOS) {
      throw new Error('Claude API error ' + code + ' (' + contexto + ') tras ' + intento + ' intento(s)');
    }
    Utilities.sleep(ESPERA_MS);
  }
}

// ═══════════════════════════════════════════════════════════════
//  _parsearFacturaCeyco — multi-ítem con código de producto
// ═══════════════════════════════════════════════════════════════

function _parsearFacturaCeyco(archivo) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  var blob   = archivo.getBlob();
  var mime   = blob.getContentType() || 'application/pdf';
  var b64    = Utilities.base64Encode(blob.getBytes());

  var contentBlock = (mime === 'application/pdf')
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image',    source: { type: 'base64', media_type: mime, data: b64 } };

  var prompt =
    'Extrae datos de esta factura DGI emitida por CEYCO (Consultores Electrotecnicos).\n\n' +
    'Responde SOLO con JSON válido, sin markdown:\n' +
    '{\n' +
    '  "num_factura": "número completo ej: 0000000515",\n' +
    '  "fecha": "YYYY-MM-DD",\n' +
    '  "nombre_cliente": "nombre del receptor",\n' +
    '  "ruc_cliente": "RUC del receptor sin DV",\n' +
    '  "dv_cliente": "DV del receptor",\n' +
    '  "descripcion": "descripción general del servicio/venta",\n' +
    '  "tiene_itbms": true,\n' +
    '  "subtotal": 0.00,\n' +
    '  "itbms": 0.00,\n' +
    '  "total": 0.00,\n' +
    '  "items": [\n' +
    '    {\n' +
    '      "linea": 1,\n' +
    '      "codigo": "código exacto del producto ej: VCCD2, LX1D6B7, 170M1570",\n' +
    '      "codigo_alt": "código alternativo o de fabricante si hay dos referencias, null si no",\n' +
    '      "descripcion": "descripción del ítem",\n' +
    '      "cantidad": 1,\n' +
    '      "precio_unitario": 0.00,\n' +
    '      "itbms": 0.00,\n' +
    '      "total": 0.00\n' +
    '    }\n' +
    '  ]\n' +
    '}\n\n' +
    'REGLAS:\n' +
    '1. nombre_cliente y ruc_cliente = del RECEPTOR, NO del emisor CEYCO\n' +
    '2. codigo = código exacto de la columna "Código" de la factura. Leer con cuidado:\n' +
    '   - Distinguir 0 (cero) de O (letra O), 1 (uno) de I (letra I), 5 de S\n' +
    '   - Copiar el código EXACTAMENTE como aparece en la factura\n' +
    '   - Si hay dos códigos en la misma celda, poner el primero en codigo y el segundo en codigo_alt\n' +
    '3. Extraer TODOS los ítems, no solo el primero\n' +
    '4. tiene_itbms = false si la factura muestra exento o 0% ITBMS\n' +
    '5. Montos como números. null si el campo no es visible.';

  var payload = {
    model: 'claude-sonnet-4-6', max_tokens: 2000,
    messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: prompt }] }]
  };

  var resp = _claudeFetchConRetry(payload, 'parsear CEYCO');

  var text = '';
  var content = JSON.parse(resp.getContentText()).content || [];
  for (var i = 0; i < content.length; i++) {
    if (content[i].type === 'text') { text = content[i].text; break; }
  }
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}


// ═══════════════════════════════════════════════════════════════
//  _parsearFacturaCosto — multi-ítem, detecta si es general
//
//  v2.7 FIX-2: itbm_mercancias ahora apunta al TOTAL IMPUESTOS
//  de la sección "Información de Pago de Impuestos del Envío",
//  no solo a la línea ITBM. Corrige DHL extrayendo $45.07/$46.61
//  en vez de descontar el total de impuestos correctamente.
// ═══════════════════════════════════════════════════════════════

function _parsearFacturaCosto(archivo) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  var blob   = archivo.getBlob();
  var mime   = blob.getContentType() || 'application/pdf';
  var b64    = Utilities.base64Encode(blob.getBytes());

  // GUARD: si el documento tiene el RUC de la empresa como emisor, no es una factura de costo.
  // Es una cotización o documento interno que llegó a esta carpeta por error.
  // En este caso retornar null para que _matchearItems lo ignore.
  if (mime === 'application/pdf') {
    try {
      var rawText  = blob.getDataAsString('UTF-8').substring(0, 2000);
      var _gr      = _getConfig().empresa_ruc || '';
      var _grN     = _gr.split('-')[0];
      if (_gr && rawText.indexOf(_gr) !== -1) {
        Logger.log('    ⚠️  Descartando documento con RUC de la empresa como emisor: ' + archivo.getName());
        return null;
      }
      if (_grN && _grN.length >= 5 && rawText.indexOf(_grN) !== -1) {
        Logger.log('    ⚠️  Descartando documento con RUC de la empresa como emisor: ' + archivo.getName());
        return null;
      }
    } catch(e) { /* PDF binario — continuar con Sonnet */ }
  }

  var contentBlock = (mime === 'application/pdf')
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image',    source: { type: 'base64', media_type: mime, data: b64 } };

  var prompt =
    'Extrae datos del EMISOR y los ítems de esta factura de costo para ' + (_getConfig().empresa_comercial || _getConfig().empresa_nombre || 'la empresa') + '.\n\n' +
    'Responde SOLO con JSON válido, sin markdown:\n' +
    '{\n' +
    '  "num_factura": "referencia o número",\n' +
    '  "fecha": "YYYY-MM-DD",\n' +
    '  "proveedor": "nombre del emisor",\n' +
    '  "ruc_proveedor": null,\n' +
    '  "dv_proveedor": null,\n' +
    '  "es_extranjero": false,\n' +
    '  "es_general": false,\n' +
    '  "subtotal": 0.00,\n' +
    '  "itbms": 0.00,\n' +
    '  "total": 0.00,\n' +
    '  "total_bruto": 0.00,\n' +
    '  "itbm_mercancias": 0.00,\n' +
    '  "itbm_servicios": 0.00,\n' +
    '  "moneda": "USD",\n' +
    '  "tipo_costo": "producto|producto_extranjero|flete|flete_internacional|aduana|impuesto_importacion|servicio|otro",\n' +
    '  "items": [\n' +
    '    {\n' +
    '      "codigo": "código principal del ítem (Part#, Symbol, Order No., etc.)",\n' +
    '      "codigo_alt": "código alternativo si hay dos en la misma celda (ej: part# fabricante), null si no aplica",\n' +
    '      "descripcion": "descripción incluyendo código si aparece",\n' +
    '      "cantidad": 1,\n' +
    '      "precio_unitario": 0.00,\n' +
    '      "itbms": 0.00,\n' +
    '      "total": 0.00\n' +
    '    }\n' +
    '  ]\n' +
    '}\n\n' +
    'REGLAS CRÍTICAS:\n' +
    '1. codigo y codigo_alt: cuando un ítem tiene DOS referencias en la misma celda\n' +
    '   (ej: Dimyeen lista "68569354 / FS450R12KE3/AGDR71CS"), extraer AMBOS:\n' +
    '   codigo = el primero (68569354), codigo_alt = el segundo (FS450R12KE3AGDR71CS).\n' +
    '   Esto permite matching con cualquiera de los dos códigos.\n' +
    '   REGLA GENERAL: cualquier valor en columnas "Part No.", "Part Number", "Ref.",\n' +
    '   "SKU", "Code", "Symbol", "Article No.", "Item No.", "Catalog No.", "Mfr. Part No.",\n' +
    '   "Order No." o similares ES el código — incluyendo secuencias numéricas largas.\n' +
    '   Proveedores extranjeros (europeos, asiáticos, norteamericanos) frecuentemente usan\n' +
    '   códigos numéricos de 7-10 dígitos como 1083239000, 1860720000, 3030462.\n' +
    '   Estos son referencias de catálogo válidas, NO números de orden ni de factura.\n' +
    '   Solo usar null si el ítem genuinamente no tiene ninguna columna de referencia.\n' +
    '   CASO ESPECIAL TME (Transfer Multisort Elektronik): los ítems NO tienen\n' +
    '   columna de código separada. El código aparece como PRIMERA LÍNEA del bloque\n' +
    '   "Producto/Artykuł Descripción/Opis", con formato WM-XXXXXXXXXX o XXXXXXXXXX.\n' +
    '   Ejemplo estructura TME:\n' +
    '     Núm 1 | WM-1083230000                           ← primera línea = codigo\n' +
    '           | Etiqueta;7÷40mm;poliámido 66;blanco...  ← resto = descripcion\n' +
    '   → codigo="WM-1083230000", descripcion="Etiqueta;7÷40mm;poliámido 66;blanco..."\n' +
    '   La línea "Transport / Koszty wysyłki" en TME es envío → codigo=null.\n' +
    '2. es_general = true ÚNICAMENTE si NINGÚN ítem tiene código de producto/parte.\n' +
    '   es_general=true SOLO para: flete puro sin ítems, derechos de aduana globales,\n' +
    '   servicio genérico sin referencia. Si hay columnas con códigos → es_general=false.\n' +
    '3. es_extranjero = true si el proveedor es extranjero (TME, Mouser, Digi-Key, FedEx, etc.)\n' +
    '4. Para facturas DHL/FedEx/aduana con sello DGI panameño → tipo_costo = "impuesto_importacion".\n' +
    '   Extraer:\n' +
    '   - total_bruto = el TOTAL final del documento (ej: "TOTAL DE CARGOS A PAGAR")\n' +
    '   - itbm_mercancias = SUMA de TODAS las líneas cuya etiqueta contenga\n' +
    '     "ITBM", "ITBMS", "I.T.B.M.S" o variantes (con o sin porcentaje, con o sin puntos).\n' +
    '     Recorrer TODO el documento línea por línea y sumar cada una que coincida.\n' +
    '     NO incluir líneas que sean IMP, MISCELANEOS, arancel, derechos u otros conceptos.\n' +
    '     Ejemplo factura DHL Panama PC242424:\n' +
    '       IMP          8.33  ← NO es ITBM, no sumar\n' +
    '       ITBM        12.24  ← SÍ sumar\n' +
    '       MISCELANEOS  2.50  ← NO es ITBM, no sumar\n' +
    '       I.T.B.M.S. (7%) 1.54  ← SÍ sumar\n' +
    '       → itbm_mercancias = 12.24 + 1.54 = 13.78\n' +
    '   - itbm_servicios = 0  (ya está incluido en itbm_mercancias)\n' +
    '   - total = total_bruto - itbm_mercancias\n' +
    '   Ejemplo DHL PC242424: total_bruto=46.61, itbm_mercancias=13.78 → total=32.83\n' +
    '   Si no hay ninguna línea ITBM/ITBMS, dejar itbm_mercancias=0.\n' +
    '5. Extraer TODOS los ítems del documento, incluyendo líneas de envío y manejo:\n' +
    '   - SHIPPING COST, HANDLING FEE, FREIGHT, FLETE, TRANSPORT y similares\n' +
    '     deben extraerse como ítems separados con codigo=null.\n' +
    '   - TME (Transfer Multisort Elektronik): la línea "Transport" o\n' +
    '     "Transport / Koszty wysyłki" es el costo de envío — extraerla\n' +
    '     SIEMPRE con codigo=null: {codigo:null, descripcion:"Transport", total:X}\n' +
    '   - Ejemplo Dimyeen: SHIPPING COST $165.00 → {codigo:null, descripcion:"SHIPPING COST", cantidad:1, precio_unitario:165, total:165}\n' +
    '   - Ejemplo Dimyeen: HANDLING FEE $296.34 → {codigo:null, descripcion:"HANDLING FEE", cantidad:1, precio_unitario:296.34, total:296.34}\n' +
    '   - NO omitir estas líneas aunque no tengan código de producto.\n' +
    '6. Montos como números. null solo si realmente no es visible.';

  var payload = {
    model: 'claude-sonnet-4-6', max_tokens: 2000,
    messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: prompt }] }]
  };

  var resp = _claudeFetchConRetry(payload, 'parsear costo');

  var text = '';
  var content = JSON.parse(resp.getContentText()).content || [];
  for (var i = 0; i < content.length; i++) {
    if (content[i].type === 'text') { text = content[i].text; break; }
  }

  var parsed = JSON.parse(text.replace(/```json|```/g, '').trim());

  // ── Post-proceso A: detectar shipping/handling no extraído ───
  //
  // v2.7 FIX-1: antes de crear un ítem genérico "SHIPPING & HANDLING",
  // verificar si la diferencia (total - suma de ítems con código) ya
  // está cubierta por ítems sin código explícitos (Transport TME,
  // SHIPPING COST Dimyeen, etc.). Si la cobertura es suficiente
  // (diferencia residual <= $1), NO crear el ítem genérico duplicado.
  //
  if (!parsed.es_general && parsed.items && parsed.items.length > 0) {
    var sumaItemsCodigo = 0;
    var itemsSinCodigo  = [];
    (parsed.items || []).forEach(function(it) {
      if (it.codigo && !it.es_envio) {
        sumaItemsCodigo += parseFloat(it.total || '0') || 0;
      } else if (!it.codigo) {
        itemsSinCodigo.push(it);
      }
    });
    var totalDoc = parseFloat(parsed.total || '0') || 0;

    // Fix para facturas de anticipo prepagado (TME, etc.): total=0 pero ítems tienen precio real.
    // En este caso usar la suma de ítems como total real del costo.
    if (totalDoc === 0 && sumaItemsCodigo > 0) {
      Logger.log('    💡 Factura prepagada: total=$0 → usando suma de ítems $' + sumaItemsCodigo);
      parsed.total = sumaItemsCodigo;
      totalDoc = sumaItemsCodigo;
    }

    var diferencia = parseFloat((totalDoc - sumaItemsCodigo).toFixed(2));

    // Marcar ítems sin código con descripción de envío como es_envio=true
    // (ej: TME Transport que Claude extrae con codigo=null tras el prompt fix)
    // Solo afecta items ya en itemsSinCodigo — nunca productos con código
    var _envioRE = /^(transport|koszty|wysyłki|wysylki|shipping|handling|freight|flete)/i;
    itemsSinCodigo.forEach(function(it) {
      var _d = String(it.descripcion || '').trim();
      if (_envioRE.test(_d) && !it.es_envio) {
        it.es_envio = true;
        Logger.log('    💡 Sin-código marcado envío: "' + _d + '" $' + (it.total || 0));
      }
    });
    // Recalcular itemsSinCodigo excluyendo los recién marcados como envío
    var _sinCodigoNoEnvio = itemsSinCodigo.filter(function(it) { return !it.es_envio; });

    // ── FIX-1: calcular cuánto de la diferencia ya está cubierto ──
    // por ítems de envío explícitos (Transport, SHIPPING COST, etc.)
    var _sumaEnvioExplicito = itemsSinCodigo.reduce(function(acc, it) {
      return acc + (parseFloat(it.total || it.precio_unitario || '0') || 0);
    }, 0);
    var _diferenciaSinCubrir = parseFloat((diferencia - _sumaEnvioExplicito).toFixed(2));

    if (_diferenciaSinCubrir > 1 && _sinCodigoNoEnvio.length === 0) {
      // Solo hay una diferencia residual no cubierta por ítems explícitos
      Logger.log('    💡 S&H residual: $' + _diferenciaSinCubrir +
                 ' (total $' + totalDoc + ' - productos $' + sumaItemsCodigo +
                 ' - envío explícito $' + _sumaEnvioExplicito + ')');
      parsed.items.push({
        codigo:          null,
        codigo_alt:      null,
        descripcion:     'SHIPPING & HANDLING',
        cantidad:        1,
        precio_unitario: _diferenciaSinCubrir,
        itbms:           0,
        total:           _diferenciaSinCubrir,
        es_envio:        true,
      });
    } else if (diferencia > 1 && _sumaEnvioExplicito >= diferencia - 1) {
      // La diferencia está completamente cubierta por ítems explícitos — no duplicar
      Logger.log('    ✅ Diferencia $' + diferencia.toFixed(2) +
                 ' cubierta por ítems de envío explícitos ($' +
                 _sumaEnvioExplicito.toFixed(2) + ') — S&H genérico omitido.');
    }
  }

  // Post-proceso B: calcular costo neto para facturas de importación/aduana.
  var esImportacion = parsed.tipo_costo === 'impuesto_importacion' ||
    /dhl|fedex|federal.express|ups/i.test(String(parsed.proveedor || ''));

  // Detectar facturas donde TODOS los ítems son impuestos/aranceles sin código
  // (ej: Mail Boxes factura de aduana con arancel, ITBMS, tasa única)
  if (!esImportacion && !parsed.es_general && parsed.items && parsed.items.length > 0) {
    var todosImpuestos = parsed.items.every(function(it) {
      if (it.codigo) return false;
      return /impuesto|arancel|itbm|tasa|tax|duty|tariff|aduana/i.test(String(it.descripcion || ''));
    });
    if (todosImpuestos) {
      Logger.log('    💡 Factura de impuestos detectada: ' + (parsed.proveedor || '') + ' $' + parsed.total);
      parsed.es_general = true;
      parsed.tipo_costo = 'impuesto_importacion';
      parsed.items      = [];
    }
  }

  if (esImportacion) {
    // ── Post-proceso B v2.8: restar SOLO líneas ITBM/ITBMS ──────
    // Regla: total_neto = total_bruto - suma(líneas cuya etiqueta sea ITBM/ITBMS)
    // IMP, MISCELANEOS, arancel, derechos → NO se restan (son costo real de CEYCO)
    //
    // Claude devuelve itbm_mercancias = suma de líneas ITBM/ITBMS del documento.
    // itbm_servicios = 0 (ya incluido en itbm_mercancias según el prompt).
    // Fallback: si Claude no lo extrajo, buscar en parsed.items líneas ITBM.

    var totalBruto = parseFloat(parsed.total_bruto || '0') || 0;
    var totalRaiz  = parseFloat(parsed.total || '0') || 0;

    // Si total_bruto no fue extraído, usar total como bruto
    if (totalBruto === 0) {
      totalBruto = totalRaiz;
    }

    // Leer itbm_mercancias del prompt (suma de líneas ITBM/ITBMS)
    var itbmTotal = parseFloat(parsed.itbm_mercancias || '0') || 0;

    // Fallback: si Claude no extrajo itbm_mercancias, intentar sumar
    // el campo itbms del nivel raíz (en algunos docs Claude lo pone ahí)
    if (itbmTotal === 0) {
      var itbmsRaiz = parseFloat(parsed.itbms || '0') || 0;
      if (itbmsRaiz > 0) {
        itbmTotal = itbmsRaiz;
        Logger.log('    💡 ITBM desde campo raíz: $' + itbmTotal);
      }
    }

    if (totalBruto > 0 && itbmTotal > 0) {
      var costoNeto = parseFloat((totalBruto - itbmTotal).toFixed(2));
      Logger.log('    💡 Importación ' + (parsed.proveedor || '') +
                 ': $' + totalBruto + ' - ITBM $' + itbmTotal + ' = neto $' + costoNeto);
      parsed.total_bruto   = totalBruto;
      parsed.total         = costoNeto;  // costo neto sin ITBM
      parsed.itbms         = 0;
      parsed._itbm_credito = parseFloat(itbmTotal.toFixed(2)); // conservar para egreso crédito fiscal
    } else {
      // Sin ITBM extraíble — usar total tal como está
      parsed.total_bruto   = totalBruto;
      parsed._itbm_credito = 0;
      Logger.log('    ℹ️  Importación sin ITBM extraíble: ' + (parsed.proveedor || '') + ' $' + totalBruto);
    }

    parsed.tipo_costo = 'impuesto_importacion';
    parsed.es_general = true;
    parsed.items      = [];  // limpiar ítems — entra a costos_generales
  }

  parsed._mime = mime;  // conservar mime para saber si es JPEG (revisión manual)
  return parsed;
}


// ═══════════════════════════════════════════════════════════════
//  _matchearItems
//  Cruza cada ítem de la factura CEYCO contra los ítems de las
//  facturas de costo por código exacto (normalizado), y contra
//  el inventario como fallback.
//
//  Los costos generales (flete, aduana, DHL — sin código de
//  producto) se prorratean entre los ítems de producto
//  proporcionalmente a su precio de venta.
//
//  Retorna:
//    {
//      items: [{ ...itemCeyco, tipo_costo, costo_total,
//                costo_producto, costo_prorrateado,
//                factura_costo_datos, inv_item }],
//      costos_generales: [{ datos, archivo }]   ← para crear egresos
//    }
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
//  _procesarNotaCredito  — Escenario 1: anulación sin despacho
//
//  Flujo:
//    1. Parsear factura CEYCO original para datos de cliente/montos
//    2. Parsear nota de crédito para su número y fecha
//    3. Crear ST en estado 'cancelado'
//    4. Registrar Ingreso 1: factura original (positivo, estado 'anulado')
//    5. Registrar Ingreso 2: nota de crédito (negativo, tipo_comp 'nota_credito')
//    6. Sin egresos, sin ST_Items, sin movimientos de inventario
// ═══════════════════════════════════════════════════════════════

function _procesarNotaCredito(ss, clasificados, mes, resultado) {
  var ahora    = new Date();
  var fechaReg = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');

  // Parsear factura CEYCO para datos del cliente y montos
  var datosCeyco = _parsearFacturaCeyco(clasificados.factura_ceyco);
  if (!datosCeyco || !datosCeyco.items || !datosCeyco.items.length) {
    resultado.error_msg = 'No se pudieron extraer datos de la factura (nota de credito)';
    return resultado;
  }

  var numFact    = datosCeyco.num_factura    || '';
  var cliente    = datosCeyco.nombre_cliente || '';
  var rucCli     = datosCeyco.ruc_cliente    || '';
  var dvCli      = datosCeyco.dv_cliente     || '';
  var totalVenta = parseFloat(datosCeyco.total || '0') || 0;
  var tieneItbms = datosCeyco.tiene_itbms !== false;
  // Usar mismo campo que el flujo normal: datosCeyco.fecha (no fecha_emision)
  var fechaFactu = datosCeyco.fecha ||
    Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd');
  var fechaDate  = new Date(fechaFactu + 'T12:00:00');
  var mesST      = isNaN(fechaDate.getTime()) ? ahora.getMonth()+1 : fechaDate.getMonth()+1;
  var anioST     = isNaN(fechaDate.getTime()) ? ahora.getFullYear() : fechaDate.getFullYear();

  // FIX: usar subtotal e ITBMS ya extraídos por Claude (soporta facturas mixtas gravado/exento).
  // El cálculo total/1.07 asume 100% gravado y falla cuando hay ítems exentos (A) + (E) mezclados.
  var subtotalFact = parseFloat(datosCeyco.subtotal || '0') || 0;
  var itbmsFact    = parseFloat(datosCeyco.itbms    || '0') || 0;
  if (subtotalFact === 0 && totalVenta > 0) {
    // Fallback solo si Claude no extrajo subtotal
    subtotalFact = tieneItbms ? parseFloat((totalVenta / 1.07).toFixed(2)) : totalVenta;
    itbmsFact    = tieneItbms ? parseFloat((totalVenta - subtotalFact).toFixed(2)) : 0;
  }

  // Parsear nota de credito para su numero y fecha
  var datosNC = _parsearFacturaCeyco(clasificados.nota_credito);
  var numNC   = (datosNC && datosNC.num_factura) ? datosNC.num_factura : 'NC';
  var fechaNC = (datosNC && datosNC.fecha)       ? datosNC.fecha       : fechaFactu;

  // Obtener secuencia ST (misma funcion que el flujo normal)
  var seqData = _nextSTSeq(ss);
  var idST    = 'ST-RP-' + seqData.anio + '-' + String(seqData.seq).padStart(4, '0');

  // Crear ST en estado cancelado
  var sheetST = ss.getSheetByName(SHEET_ST) || _initServiciosTecnicosSheet(ss);

  var filaST = new Array(ST_NCOLS);
  for (var xs = 0; xs < ST_NCOLS; xs++) filaST[xs] = '';
  filaST[COL_ST.ID - 1]              = idST;
  filaST[COL_ST.FECHA_REG - 1]       = fechaReg;
  filaST[COL_ST.ESTADO - 1]          = 'cancelado';
  // NUM_COT: factura original + nota de crédito
  var numCotST = (numFact ? 'FACT ' + String(numFact).replace(/^0+/, '') : '')
    + (numFact && numNC && numNC !== 'NC' ? ' / NC ' + String(numNC).replace(/^0+/, '') : '')
    || 'COT-RP-' + seqData.anio + '-' + String(seqData.seq).padStart(4, '0');
  filaST[COL_ST.NUM_COT - 1]         = numCotST;
  filaST[COL_ST.NOMBRE_CLI - 1]      = cliente;
  filaST[COL_ST.RUC_CLI - 1]         = rucCli;
  filaST[COL_ST.DV_CLI - 1]          = dvCli;
  filaST[COL_ST.DESCRIPCION - 1]     = (datosCeyco.descripcion || datosCeyco.items[0].descripcion || '') +
                                        ' | ANULADO NC ' + numNC;
  filaST[COL_ST.TOTAL_COSTO_COT - 1] = 0;
  filaST[COL_ST.TOTAL_COSTO_REAL - 1]= 0;
  filaST[COL_ST.MARGEN_PCT - 1]      = 0;
  filaST[COL_ST.PRECIO_VENTA - 1]    = 0;
  filaST[COL_ST.DRIVE_URL - 1]       = clasificados.factura_ceyco.getUrl();
  filaST[COL_ST.FECHA_CIERRE - 1]    = fechaNC;
  filaST[COL_ST.MES - 1]             = mesST;
  filaST[COL_ST.ANIO - 1]            = anioST;
  filaST[COL_ST.NOTAS - 1]           = 'Importado historial Drive | Mes: ' + mes +
                                        ' | FACT ' + numFact + ' anulada por NC ' + numNC;

  var newSTRow = sheetST.getLastRow() + 1;
  sheetST.getRange(newSTRow, 1, 1, ST_NCOLS).setValues([filaST]);
  sheetST.getRange(newSTRow, COL_ST.TOTAL_COSTO_COT, 1, 3).setNumberFormat('#,##0.00');
  sheetST.getRange(newSTRow, 1, 1, ST_NCOLS).setBackground('#FFEBEE');
  Logger.log('  ST cancelado: ' + idST + ' | ' + cliente +
             ' | FACT ' + numFact + ' + NC ' + numNC);

  // Ingresos
  var sheetIng = ss.getSheetByName(CONFIG.SHEET_INGRESOS);
  if (!sheetIng) { resultado.error_msg = 'Hoja Ingresos no encontrada'; return resultado; }

  var idBase = 'ING-RP-' + Utilities.formatDate(ahora, 'America/Panama', 'yyyyMMddHHmmss') +
               '-IH-' + String(seqData.seq).padStart(4, '0');

  // Ingreso 1: factura original — positivo, estado anulado
  var idIng1   = idBase + 'A';
  var filaIng1 = new Array(INGRESOS_NCOLS);
  for (var xi = 0; xi < INGRESOS_NCOLS; xi++) filaIng1[xi] = '';
  filaIng1[COL_I.ID_TRANS - 1]      = idIng1;
  filaIng1[COL_I.FECHA_REG - 1]     = fechaReg;
  filaIng1[COL_I.ESTADO - 1]        = 'anulado';
  filaIng1[COL_I.CONFIANZA_IA - 1]  = 'ia_historial';
  filaIng1[COL_I.FECHA_INGRESO - 1] = fechaFactu;
  filaIng1[COL_I.MES - 1]           = mesST;
  filaIng1[COL_I.ANIO_FISCAL - 1]   = anioST;
  filaIng1[COL_I.SUBTOTAL - 1]      = subtotalFact;
  filaIng1[COL_I.ITBMS - 1]         = itbmsFact;
  filaIng1[COL_I.TOTAL - 1]         = totalVenta;
  filaIng1[COL_I.MONEDA - 1]        = 'USD';
  filaIng1[COL_I.TIPO_INGRESO - 1]  = 'venta_producto';
  filaIng1[COL_I.CATEGORIA - 1]     = tieneItbms ? 'venta_producto_gravado' : 'venta_producto_exento';
  filaIng1[COL_I.NOMBRE_CLI - 1]    = cliente;
  filaIng1[COL_I.RUC_CLI - 1]       = rucCli;
  filaIng1[COL_I.TIPO_PERSONA - 1]  = detectarTipoPersona(String(rucCli));
  filaIng1[COL_I.NUM_FACTURA - 1]   = numFact;
  filaIng1[COL_I.TIPO_COMP - 1]     = 'factura_emitida';
  filaIng1[COL_I.DRIVE_URL - 1]     = clasificados.factura_ceyco.getUrl();
  filaIng1[COL_I.DESCRIPCION - 1]   = 'FACT ' + numFact + ' anulada por NC ' + numNC;
  filaIng1[COL_I.NOTAS_INT - 1]     = 'ST: ' + idST + ' | Historial ' + mes +
                                       ' | Anulado por NC ' + numNC;
  filaIng1[COL_I.FLAG_REV - 1]      = false;
  filaIng1[COL_I.DV_CLI - 1]        = dvCli;

  var newIng1Row = sheetIng.getLastRow() + 1;
  sheetIng.getRange(newIng1Row, 1, 1, INGRESOS_NCOLS).setValues([filaIng1]);
  sheetIng.getRange(newIng1Row, COL_I.SUBTOTAL, 1, 3).setNumberFormat('#,##0.00');
  sheetIng.getRange(newIng1Row, 1, 1, INGRESOS_NCOLS).setBackground('#FFEBEE');

  // Ingreso 2: nota de credito — negativo, revierte la factura
  var idIng2   = idBase + 'B';
  var filaIng2 = new Array(INGRESOS_NCOLS);
  for (var xj = 0; xj < INGRESOS_NCOLS; xj++) filaIng2[xj] = '';
  filaIng2[COL_I.ID_TRANS - 1]      = idIng2;
  filaIng2[COL_I.FECHA_REG - 1]     = fechaReg;
  filaIng2[COL_I.ESTADO - 1]        = 'anulado';
  filaIng2[COL_I.CONFIANZA_IA - 1]  = 'ia_historial';
  filaIng2[COL_I.FECHA_INGRESO - 1] = fechaNC;
  filaIng2[COL_I.MES - 1]           = mesST;
  filaIng2[COL_I.ANIO_FISCAL - 1]   = anioST;
  filaIng2[COL_I.SUBTOTAL - 1]      = -subtotalFact;
  filaIng2[COL_I.ITBMS - 1]         = -itbmsFact;
  filaIng2[COL_I.TOTAL - 1]         = -totalVenta;
  filaIng2[COL_I.MONEDA - 1]        = 'USD';
  filaIng2[COL_I.TIPO_INGRESO - 1]  = 'venta_producto';
  filaIng2[COL_I.CATEGORIA - 1]     = tieneItbms ? 'venta_producto_gravado' : 'venta_producto_exento';
  filaIng2[COL_I.NOMBRE_CLI - 1]    = cliente;
  filaIng2[COL_I.RUC_CLI - 1]       = rucCli;
  filaIng2[COL_I.TIPO_PERSONA - 1]  = detectarTipoPersona(String(rucCli));
  filaIng2[COL_I.NUM_FACTURA - 1]   = numNC;
  filaIng2[COL_I.TIPO_COMP - 1]     = 'nota_credito';
  filaIng2[COL_I.DRIVE_URL - 1]     = clasificados.nota_credito.getUrl();
  filaIng2[COL_I.DESCRIPCION - 1]   = 'NC ' + numNC + ' anula FACT ' + numFact;
  filaIng2[COL_I.NOTAS_INT - 1]     = 'ST: ' + idST + ' | Historial ' + mes +
                                       ' | NC anula FACT ' + numFact;
  filaIng2[COL_I.FLAG_REV - 1]      = false;
  filaIng2[COL_I.DV_CLI - 1]        = dvCli;

  var newIng2Row = sheetIng.getLastRow() + 1;
  sheetIng.getRange(newIng2Row, 1, 1, INGRESOS_NCOLS).setValues([filaIng2]);
  sheetIng.getRange(newIng2Row, COL_I.SUBTOTAL, 1, 3).setNumberFormat('#,##0.00');
  sheetIng.getRange(newIng2Row, 1, 1, INGRESOS_NCOLS).setBackground('#FFEBEE');

  // Vincular ingreso 1 al ST
  sheetST.getRange(newSTRow, COL_ST.INGRESO_ID).setValue(idIng1);

  Logger.log('  NC procesada: ST=' + idST +
             ' | ING1=' + idIng1 + ' +$' + totalVenta +
             ' | ING2=' + idIng2 + ' -$' + totalVenta + ' | Neto=$0');

  resultado.id_st       = idST;
  resultado.num_factura = numFact;
  resultado.cliente     = cliente;
  resultado.total_venta = 0;
  resultado.total_costo = 0;
  resultado.tipo_venta  = 'cancelado';
  resultado.tipo_costo  = 'nota_credito';
  resultado.estado      = 'completo';
  resultado.ingreso_id  = idIng1;
  return resultado;
}


// ═══════════════════════════════════════════════════════════════
//  _parsearNotaCredito
//  Extrae datos de una NC DGI emitida por CEYCO:
//    - num_factura: número de la NC
//    - fecha: fecha de emisión de la NC
//    - num_factura_referenciada: número de la factura original que anula
//    - nombre_cliente, ruc_cliente, dv_cliente, total, subtotal, itbms
//    - items: ítems de la NC (para devolver al inventario)
// ═══════════════════════════════════════════════════════════════

function _parsearNotaCredito(archivo) {
  var blob = archivo.getBlob();
  var mime = blob.getContentType() || 'application/pdf';
  var b64  = Utilities.base64Encode(blob.getBytes());

  var contentBlock = (mime === 'application/pdf')
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image',    source: { type: 'base64', media_type: mime, data: b64 } };

  var prompt =
    'Extrae datos de esta Nota de Crédito DGI emitida por CEYCO.\n\n' +
    'Responde SOLO con JSON válido, sin markdown:\n' +
    '{\n' +
    '  "num_factura": "número de la NOTA DE CRÉDITO, ej: 0000000114",\n' +
    '  "fecha": "YYYY-MM-DD (fecha de emisión de la NC)",\n' +
    '  "num_factura_referenciada": "número de la FACTURA ORIGINAL que esta NC anula, campo Número/Referencia en Información Complementaria, ej: 0000000516",\n' +
    '  "nombre_cliente": "nombre del receptor",\n' +
    '  "ruc_cliente": "RUC del receptor sin DV",\n' +
    '  "dv_cliente": "DV del receptor",\n' +
    '  "tiene_itbms": true,\n' +
    '  "subtotal": 0.00,\n' +
    '  "itbms": 0.00,\n' +
    '  "total": 0.00,\n' +
    '  "items": [\n' +
    '    {\n' +
    '      "linea": 1,\n' +
    '      "codigo": "código del producto de la columna Código",\n' +
    '      "descripcion": "descripción del ítem",\n' +
    '      "cantidad": 1\n' +
    '    }\n' +
    '  ]\n' +
    '}\n\n' +
    'REGLAS:\n' +
    '1. num_factura_referenciada: buscar en la sección "Información Complementaria" el campo "Número/Referencia". Es el número de la factura original que se está anulando. CRÍTICO — no confundir con el número de la NC.\n' +
    '2. subtotal y total: tomar de la sección "Totales" del documento.\n' +
    '3. items: extraer TODOS los ítems con su código y cantidad exacta. Las cantidades son necesarias para devolver el stock al inventario.\n' +
    '4. nombre_cliente y ruc_cliente: del RECEPTOR, no del emisor CEYCO.\n' +
    '5. Montos como números. null si no visible.';

  var payload = {
    model: 'claude-sonnet-4-6', max_tokens: 2000,
    messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: prompt }] }]
  };

  var resp = _claudeFetchConRetry(payload, 'parsear NC');
  var text = '';
  var content = JSON.parse(resp.getContentText()).content || [];
  for (var i = 0; i < content.length; i++) {
    if (content[i].type === 'text') { text = content[i].text; break; }
  }
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}


// ═══════════════════════════════════════════════════════════════
//  _procesarNotaCreditoEscenario2
//
//  Flujo: carpeta tiene SOLO la NC (sin factura original).
//    1. Parsear NC → extraer num_factura_referenciada
//    2. Verificar que la factura original ya existe en Ingresos
//    3. Buscar el ST original y marcarlo 'anulado'
//    4. Marcar el Ingreso original como 'anulado'
//    5. Registrar Ingreso negativo en el mes de la NC
//    6. Devolver ítems al inventario (stock + movimiento devolucion_nc)
// ═══════════════════════════════════════════════════════════════

function _procesarNotaCreditoEscenario2(ss, archivoNC, mes, resultado) {
  var ahora    = new Date();
  var fechaReg = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');

  // ── Parsear la NC ─────────────────────────────────────────────
  var datosNC = _parsearNotaCredito(archivoNC);
  if (!datosNC) {
    resultado.error_msg = 'No se pudieron extraer datos de la nota de crédito';
    return resultado;
  }

  var numNC      = datosNC.num_factura             || 'NC';
  var fechaNC    = datosNC.fecha                   || fechaReg.slice(0, 10);
  var numFactRef = datosNC.num_factura_referenciada || '';
  var cliente    = datosNC.nombre_cliente           || '';
  var rucCli     = datosNC.ruc_cliente              || '';
  var dvCli      = datosNC.dv_cliente               || '';
  var totalNC    = parseFloat(datosNC.total         || '0') || 0;
  var tieneItbms = datosNC.tiene_itbms !== false;

  // FIX subtotal: usar campos directos, no total/1.07
  var subtotalNC = parseFloat(datosNC.subtotal || '0') || 0;
  var itbmsNC    = parseFloat(datosNC.itbms    || '0') || 0;
  if (subtotalNC === 0 && totalNC > 0) {
    subtotalNC = tieneItbms ? parseFloat((totalNC / 1.07).toFixed(2)) : totalNC;
    itbmsNC    = tieneItbms ? parseFloat((totalNC - subtotalNC).toFixed(2)) : 0;
  }

  Logger.log('  🔄 NC ' + numNC + ' | Factura ref: ' + numFactRef +
             ' | Cliente: ' + cliente + ' | $' + totalNC + ' | Fecha NC: ' + fechaNC);

  // ── Guard: factura referenciada debe existir en Ingresos ──────
  if (!numFactRef) {
    resultado.error_msg = 'NC ' + numNC + ': no se pudo extraer num_factura_referenciada del PDF';
    return resultado;
  }
  if (!_ingresoYaExiste(ss, numFactRef, cliente)) {
    resultado.error_msg = 'NC ' + numNC + ': factura original ' + numFactRef +
                          ' no encontrada en Ingresos — importarla primero';
    return resultado;
  }

  // Mes/año de la NC (para el Ingreso negativo)
  var fechaNcDate = new Date(fechaNC + 'T12:00:00');
  var mesNC  = isNaN(fechaNcDate.getTime()) ? ahora.getMonth() + 1 : fechaNcDate.getMonth() + 1;
  var anioNC = isNaN(fechaNcDate.getTime()) ? ahora.getFullYear()  : fechaNcDate.getFullYear();

  // ── PASO 1: Marcar ST original como 'anulado' ─────────────────
  var sheetST  = ss.getSheetByName(SHEET_ST);
  var idSTOrig = '';
  if (sheetST && sheetST.getLastRow() > 2) {
    var stData       = sheetST.getRange(3, 1, sheetST.getLastRow() - 2, ST_NCOLS).getValues();
    var numCotBuscar = 'FACT ' + String(numFactRef).replace(/^0+/, '');
    for (var s = 0; s < stData.length; s++) {
      var numCotST = String(stData[s][COL_ST.NUM_COT - 1]    || '').trim();
      var nomCliST = String(stData[s][COL_ST.NOMBRE_CLI - 1] || '').trim().toUpperCase();
      if (numCotST === numCotBuscar && nomCliST === cliente.trim().toUpperCase()) {
        idSTOrig = String(stData[s][COL_ST.ID - 1] || '').trim();
        var filaSTOrig = s + 3;
        // Quitar validación de datos antes de escribir 'anulado' (no está en la lista original)
        // y ampliarla para incluirlo permanentemente en este ST
        var celdaEstado = sheetST.getRange(filaSTOrig, COL_ST.ESTADO);
        celdaEstado.clearDataValidations();
        var reglaNueva = SpreadsheetApp.newDataValidation()
          .requireValueInList(['cotizado','aprobado','en_ejecucion','cerrado','cancelado','anulado'], true)
          .setAllowInvalid(false).build();
        celdaEstado.setDataValidation(reglaNueva);
        celdaEstado.setValue('anulado');
        var notaActST  = String(sheetST.getRange(filaSTOrig, COL_ST.NOTAS).getValue() || '');
        sheetST.getRange(filaSTOrig, COL_ST.NOTAS).setValue(
          notaActST + ' | ANULADO por NC ' + numNC + ' (' + fechaNC + ')'
        );
        sheetST.getRange(filaSTOrig, 1, 1, ST_NCOLS).setBackground('#FFEBEE');
        Logger.log('  ✅ ST original marcado anulado: ' + idSTOrig);
        break;
      }
    }
    if (!idSTOrig) {
      Logger.log('  ⚠️  ST original no encontrado para FACT ' + numFactRef + ' — se continúa sin marcar');
    }
  }

  // ── PASO 2: Marcar Ingreso original como 'anulado' ────────────
  var sheetIng = ss.getSheetByName(CONFIG.SHEET_INGRESOS);
  if (!sheetIng) { resultado.error_msg = 'Hoja Ingresos no encontrada'; return resultado; }

  var idIngOrig = '';
  if (sheetIng.getLastRow() > 2) {
    var ingData = sheetIng.getRange(3, COL_I.NUM_FACTURA, sheetIng.getLastRow() - 2, 1).getValues();
    for (var ni = 0; ni < ingData.length; ni++) {
      if (String(ingData[ni][0] || '').trim() === String(numFactRef).trim()) {
        var filaIngOrig = ni + 3;
        idIngOrig = String(sheetIng.getRange(filaIngOrig, COL_I.ID_TRANS).getValue() || '');
        sheetIng.getRange(filaIngOrig, COL_I.ESTADO).setValue('anulado');
        var notaIngOrig = String(sheetIng.getRange(filaIngOrig, COL_I.NOTAS_INT).getValue() || '');
        sheetIng.getRange(filaIngOrig, COL_I.NOTAS_INT).setValue(
          notaIngOrig + ' | ANULADO por NC ' + numNC + ' (' + fechaNC + ')'
        );
        sheetIng.getRange(filaIngOrig, 1, 1, INGRESOS_NCOLS).setBackground('#FFEBEE');
        Logger.log('  ✅ Ingreso original marcado anulado: ' + idIngOrig);
        break;
      }
    }
  }

  // ── PASO 3: Registrar Ingreso negativo en mes de la NC ────────
  var idIngNC = 'ING-RP-' + Utilities.formatDate(ahora, 'America/Panama', 'yyyyMMddHHmmss') + '-NC2';

  var filaIngNC = new Array(INGRESOS_NCOLS);
  for (var xj = 0; xj < INGRESOS_NCOLS; xj++) filaIngNC[xj] = '';
  filaIngNC[COL_I.ID_TRANS - 1]      = idIngNC;
  filaIngNC[COL_I.FECHA_REG - 1]     = fechaReg;
  filaIngNC[COL_I.ESTADO - 1]        = 'anulado';
  filaIngNC[COL_I.CONFIANZA_IA - 1]  = 'ia_historial';
  filaIngNC[COL_I.FECHA_INGRESO - 1] = fechaNC;
  filaIngNC[COL_I.MES - 1]           = mesNC;
  filaIngNC[COL_I.ANIO_FISCAL - 1]   = anioNC;
  filaIngNC[COL_I.SUBTOTAL - 1]      = -subtotalNC;
  filaIngNC[COL_I.ITBMS - 1]         = -itbmsNC;
  filaIngNC[COL_I.TOTAL - 1]         = -totalNC;
  filaIngNC[COL_I.MONEDA - 1]        = 'USD';
  filaIngNC[COL_I.TIPO_INGRESO - 1]  = 'venta_producto';
  filaIngNC[COL_I.CATEGORIA - 1]     = tieneItbms ? 'venta_producto_gravado' : 'venta_producto_exento';
  filaIngNC[COL_I.NOMBRE_CLI - 1]    = cliente;
  filaIngNC[COL_I.RUC_CLI - 1]       = rucCli;
  filaIngNC[COL_I.TIPO_PERSONA - 1]  = detectarTipoPersona(String(rucCli));
  filaIngNC[COL_I.NUM_FACTURA - 1]   = numNC;
  filaIngNC[COL_I.TIPO_COMP - 1]     = 'nota_credito';
  filaIngNC[COL_I.DRIVE_URL - 1]     = archivoNC.getUrl();
  filaIngNC[COL_I.DESCRIPCION - 1]   = 'NC ' + numNC + ' anula FACT ' + numFactRef + ' (despacho revertido)';
  filaIngNC[COL_I.NOTAS_INT - 1]     = 'Historial ' + mes +
                                        ' | NC anula FACT ' + numFactRef +
                                        (idSTOrig  ? ' | ST: '  + idSTOrig  : '') +
                                        (idIngOrig ? ' | Ing: ' + idIngOrig : '');
  filaIngNC[COL_I.FLAG_REV - 1]      = false;
  filaIngNC[COL_I.DV_CLI - 1]        = dvCli;

  var newIngRow = sheetIng.getLastRow() + 1;
  sheetIng.getRange(newIngRow, 1, 1, INGRESOS_NCOLS).setValues([filaIngNC]);
  sheetIng.getRange(newIngRow, COL_I.SUBTOTAL, 1, 3).setNumberFormat('#,##0.00');
  sheetIng.getRange(newIngRow, 1, 1, INGRESOS_NCOLS).setBackground('#FFEBEE');

  Logger.log('  ✅ Ingreso NC negativo: ' + idIngNC + ' -$' + totalNC +
             ' | Mes: ' + mesNC + '/' + anioNC);

  // ── PASO 4: Devolver ítems al inventario ──────────────────────
  var itemsNC       = datosNC.items || [];
  var itemsDevueltos = 0;

  if (itemsNC.length > 0) {
    var sheetInvM = ss.getSheetByName(SHEET_INV_MAESTRO);
    if (sheetInvM && sheetInvM.getLastRow() >= INV_MAESTRO_DATA_ROW) {
      var invNumRows = sheetInvM.getLastRow() - INV_MAESTRO_DATA_ROW + 1;
      var invData    = sheetInvM.getRange(
        INV_MAESTRO_DATA_ROW, 1, invNumRows, COL_IM.COSTO_REF
      ).getValues();

      itemsNC.forEach(function(itemNC) {
        var codigoNC   = String(itemNC.codigo   || '').trim();
        var cantidadNC = parseFloat(itemNC.cantidad || '0') || 0;
        if (!codigoNC || cantidadNC <= 0) return;

        var codigoNorm        = _normalizarCodigo(codigoNC);
        var filaInvEncontrada = -1;

        for (var iv = 0; iv < invData.length; iv++) {
          var codigoInvNorm = _normalizarCodigo(String(invData[iv][COL_IM.CODIGO - 1] || ''));
          if (codigoInvNorm && codigoInvNorm === codigoNorm) {
            filaInvEncontrada = INV_MAESTRO_DATA_ROW + iv;
            break;
          }
        }

        if (filaInvEncontrada > 0) {
          // El stock en Inv_Maestro es una fórmula SUMIFS sobre Inventario_Movimientos.
          // No hay que escribir nada en Inv_Maestro — basta con registrar el movimiento
          // de entrada y la fórmula se actualiza sola.
          try {
            _registrarMovimientoInventario(
              ss,
              'entrada',
              codigoNC,
              cantidadNC,
              'devolucion_nc',
              numNC,
              idSTOrig || '',
              '',
              0,
              '',
              fechaNC,
              'NC ' + numNC + ' revierte FACT ' + numFactRef
            );
            Logger.log('  📦 Devolución: ' + codigoNC + ' +' + cantidadNC + ' (mov. devolucion_nc registrado)');
            itemsDevueltos++;
          } catch (invErr) {
            Logger.log('  ⚠️  Error mov. inventario ' + codigoNC + ': ' + invErr.message);
          }
        } else {
          Logger.log('  ⚠️  ' + codigoNC + ' ×' + cantidadNC + ' — sin match en Inv_Maestro');
        }
      });
    } else {
      Logger.log('  ⚠️  Hoja Inv_Maestro no encontrada — devolución de stock omitida');
    }
  } else {
    Logger.log('  ⚠️  NC sin ítems extraídos — devolución de stock no aplicada');
  }

  Logger.log('  ✅ Escenario 2 completo: NC ' + numNC + ' -$' + totalNC +
             ' | ' + itemsDevueltos + '/' + itemsNC.length + ' ítem(s) devueltos al inventario');

  resultado.id_st       = idSTOrig;
  resultado.num_factura = numFactRef;
  resultado.cliente     = cliente;
  resultado.total_venta = 0;
  resultado.total_costo = 0;
  resultado.tipo_venta  = 'cancelado';
  resultado.tipo_costo  = 'nota_credito_e2';
  resultado.estado      = 'completo';
  resultado.ingreso_id  = idIngNC;
  return resultado;
}


function _matchearItems(itemsCeyco, facturasCostoParseadas, ss) {

  // ── 1. Separar facturas con ítems de producto vs. generales ──
  var facturasConItems = [];
  var costos_generales = [];
  facturasCostoParseadas.forEach(function(fc) {
    // es_general = sin códigos de producto (flete, aduana, DHL)
    var tieneCodigosProducto = !fc.datos.es_general &&
      (fc.datos.items || []).some(function(it) { return !!it.codigo; });
    if (tieneCodigosProducto) {
      facturasConItems.push(fc);
    } else {
      costos_generales.push(fc);
    }
  });

  // ── 2. Mapa de ítems de costo por código normalizado ─────────
  // Si hay duplicados de código, queda el primero encontrado.
  // Cada ítem se indexa por codigo Y por codigo_alt (si existe).
  var mapaCodigoCosto = {};
  facturasConItems.forEach(function(fc) {
    (fc.datos.items || []).forEach(function(item) {
      if (item.es_envio) return;  // shipping/handling no va al mapa de código
      // Indexar por código principal
      if (item.codigo) {
        var cNorm = _normalizarCodigo(item.codigo);
        if (cNorm && !mapaCodigoCosto[cNorm]) {
          mapaCodigoCosto[cNorm] = { item: item, facturaDatos: fc.datos };
        }
      }
      // Indexar también por código alternativo (ej: part# fabricante)
      if (item.codigo_alt) {
        var cNormAlt = _normalizarCodigo(item.codigo_alt);
        if (cNormAlt && !mapaCodigoCosto[cNormAlt]) {
          mapaCodigoCosto[cNormAlt] = { item: item, facturaDatos: fc.datos };
        }
      }
    });
  });

  // ── 3. Matching ítem-a-ítem ──────────────────────────────────
  // Orden: A) código exacto normalizado → A2) codigo_alt CEYCO → B) inventario → C) warning
  var itemsCostoUsados = {};

  var itemsResultado = itemsCeyco.map(function(itemC) {
    var codigoCeyco = itemC.codigo || '';
    var codigoNorm  = _normalizarCodigo(codigoCeyco);

    // A) Matching por código exacto normalizado
    var match = (codigoNorm && mapaCodigoCosto[codigoNorm] && !itemsCostoUsados[codigoNorm])
                ? mapaCodigoCosto[codigoNorm]
                : null;

    // A2) Si no matcheó, intentar con codigo_alt de la factura CEYCO
    if (!match && itemC.codigo_alt) {
      var codigoAltNorm = _normalizarCodigo(itemC.codigo_alt);
      if (codigoAltNorm && mapaCodigoCosto[codigoAltNorm] && !itemsCostoUsados[codigoAltNorm]) {
        match = mapaCodigoCosto[codigoAltNorm];
        Logger.log('    🔗 Match por codigo_alt CEYCO: ' + itemC.codigo_alt + ' → ' + match.facturaDatos.proveedor);
      }
    }

    if (match) {
      var codigoUsado = _normalizarCodigo(match.item.codigo || '');
      itemsCostoUsados[codigoUsado] = true;
      if (match.item.codigo_alt) {
        itemsCostoUsados[_normalizarCodigo(match.item.codigo_alt)] = true;
      }
      // También marcar el código de CEYCO para evitar re-match
      if (codigoNorm) itemsCostoUsados[codigoNorm] = true;
      Logger.log('    ✅ Match: ' + codigoCeyco + ' → ' + match.facturaDatos.proveedor);
      return {
        linea:               itemC.linea,
        codigo:              codigoCeyco,
        descripcion:         itemC.descripcion,
        cantidad:            itemC.cantidad          || 1,
        precio_venta:        parseFloat(itemC.total  || '0') || 0,
        costo_unitario:      match.item.precio_unitario || 0,
        costo_producto:      parseFloat(match.item.total || '0') || 0,
        costo_prorrateado:   0,
        costo_total:         parseFloat(match.item.total || '0') || 0,
        costo_itbms:         parseFloat(match.item.itbms || '0') || 0,
        tipo_costo:          'venta_directa',
        factura_costo_datos: match.facturaDatos,
        inv_item:            null,
      };
    }

    // Buscar en inventario — usar código normalizado para mejor match
    var invItem = codigoNorm ? _buscarEnInventarioMaestro(ss, codigoCeyco) : null;
    // Fallback: buscar con código normalizado (cubre O↔0, S↔5, etc.)
    if (!invItem && codigoNorm) {
      invItem = _buscarEnInventarioMaestroNorm(ss, codigoNorm);
    }
    if (invItem) {
      var costoInv = parseFloat(((invItem.costo || 0) * (itemC.cantidad || 1)).toFixed(2));
      Logger.log('    📦 Inventario: ' + codigoCeyco + ' × ' + (itemC.cantidad || 1) + ' = $' + costoInv);
      return {
        linea:               itemC.linea,
        codigo:              codigoCeyco,
        descripcion:         itemC.descripcion,
        cantidad:            itemC.cantidad || 1,
        precio_venta:        parseFloat(itemC.total || '0') || 0,
        costo_unitario:      invItem.costo  || 0,
        costo_producto:      costoInv,
        costo_prorrateado:   0,
        costo_total:         costoInv,
        costo_itbms:         0,
        tipo_costo:          'venta_inventario',
        factura_costo_datos: null,
        inv_item:            invItem,
        _codigo_sku:         invItem.codigo,
        _cantidad:           itemC.cantidad || 1,
      };
    }

    // Sin costo — WARNING
    Logger.log('    ⚠️  SIN COSTO: ' + codigoCeyco);
    return {
      linea:               itemC.linea,
      codigo:              codigoCeyco,
      descripcion:         itemC.descripcion,
      cantidad:            itemC.cantidad || 1,
      precio_venta:        parseFloat(itemC.total || '0') || 0,
      costo_unitario:      0,
      costo_producto:      0,
      costo_prorrateado:   0,
      costo_total:         0,
      costo_itbms:         0,
      tipo_costo:          'warning',
      factura_costo_datos: null,
      inv_item:            null,
    };
  });

  // ── 3b. Extraer ítems sin código de facturas de proveedor ────
  // SHIPPING COST, HANDLING FEE, etc. — aparecen en facturas extranjeras
  // como líneas sin código de producto. Se crean como ST_Items separados
  // de tipo 'venta_directa' con su costo real, y se EXCLUYEN del prorrateo DHL.
  var itemsEnvio = [];
  facturasConItems.forEach(function(fc) {
    (fc.datos.items || []).forEach(function(item) {
      if (item.codigo && !item.es_envio) return; // solo ítems sin código o marcados como envío
      var desc = String(item.descripcion || '').trim();
      if (!desc) return;
      var totalItem = parseFloat(item.total || item.precio_unitario || '0') || 0;
      if (totalItem <= 0) return;
      // Incluir si tiene flag es_envio O si parece un costo de envío/manejo
      var esEnvio = item.es_envio || /shipping|handling|freight|flete|manejo|cargo|fee|transport/i.test(desc);
      if (!esEnvio) return;
      Logger.log('    📦 Envío/manejo: ' + desc + ' $' + totalItem + ' (' + fc.datos.proveedor + ')');
      itemsEnvio.push({
        linea:               null,
        codigo:              null,
        descripcion:         desc + ' — ' + fc.datos.proveedor,
        cantidad:            parseFloat(item.cantidad || '1') || 1,
        precio_venta:        0,   // no tiene precio de venta directo
        costo_unitario:      totalItem,
        costo_producto:      totalItem,
        costo_prorrateado:   0,
        costo_total:         totalItem,
        costo_itbms:         parseFloat(item.itbms || '0') || 0,
        tipo_costo:          'venta_directa',
        factura_costo_datos: fc.datos,
        inv_item:            null,
        es_envio:            true,  // flag para excluir del prorrateo DHL
        es_jpeg:             (String(fc.datos._mime || '').indexOf('image') !== -1),
      });
    });
  });

  // Combinar ítems de producto + ítems de envío
  var itemsResultadoFinal = itemsResultado.concat(itemsEnvio);

  // ── 4. Costos generales (DHL/FedEx) — NO se prorratean ──────
  // Se registran como egresos separados en el ST sin afectar el costo
  // unitario de los ítems de producto. Evita duplicación contable.
  var totalGenerales = 0;
  costos_generales.forEach(function(cg) {
    totalGenerales += parseFloat(cg.datos.total || '0') || 0;
  });
  if (totalGenerales > 0) {
    Logger.log('    ℹ️  Costos generales $' + totalGenerales.toFixed(2) +
               ' — registrados como egresos separados (sin prorrateo en ítems).');
  }

  return { items: itemsResultadoFinal, costos_generales: costos_generales };
}

// Normaliza códigos: uppercase, strip espacios/guiones/puntos
function _normalizarCodigo(codigo) {
  if (!codigo) return '';
  return String(codigo)
    .toUpperCase()
    // Strip prefijos de catálogo de fabricante que no forman parte del código base:
    // WM- = Weidmüller (usado por TME), permite matching entre WM-1083230000 y 1083230000
    .replace(/^WM-/, '')
    .replace(/[\s\-\.\/]/g, '')  // strip espacios, guiones, puntos, barras
    // Normalizar caracteres ambiguos OCR → dígito canónico
    // Se aplica DESPUÉS de uppercase para ser consistente
    .replace(/O/g, '0')   // letra O → cero
    .replace(/I/g, '1')   // letra I → uno
    .replace(/S/g, '5')   // letra S → cinco
    .replace(/B/g, '8')   // letra B → ocho  (ej: B8 → 88, raro pero posible)
    .replace(/Z/g, '2')   // letra Z → dos
    .trim();
}

// Versión que mantiene letras para logging legible
function _normalizarCodigoDisplay(codigo) {
  if (!codigo) return '';
  return String(codigo).toUpperCase().replace(/[\s\-\.\/]/g, '').trim();
}

// Normaliza descripción para matching: uppercase, solo alfanumérico
function _normalizarDesc(desc) {
  if (!desc) return '';
  return String(desc).toUpperCase().replace(/[^A-Z0-9]/g, '').trim();
}

// Búsqueda en inventario usando código ya normalizado (OCR-safe).
// Complementa _buscarEnInventarioMaestro que busca texto exacto.
// Útil cuando el código en la factura CEYCO tiene errores OCR (O↔0, S↔5, etc.)
function _buscarEnInventarioMaestroNorm(ss, codigoNorm) {
  if (!codigoNorm) return null;
  var sheet = ss.getSheetByName(SHEET_INV_MAESTRO);
  if (!sheet) return null;
  var lastRow = sheet.getLastRow();
  if (lastRow < INV_MAESTRO_DATA_ROW) return null;
  var numRows = lastRow - INV_MAESTRO_DATA_ROW + 1;
  var data    = sheet.getRange(INV_MAESTRO_DATA_ROW, 1, numRows, COL_IM.COSTO_REF).getValues();
  for (var i = 0; i < data.length; i++) {
    var codigoInv = _normalizarCodigo(String(data[i][0] || ''));
    if (codigoInv && codigoInv === codigoNorm) {
      Logger.log('    🔍 Match normalizado: ' + data[i][0] + ' ≈ búsqueda norm: ' + codigoNorm);
      return _buildInventarioItem(data[i], INV_MAESTRO_DATA_ROW + i);
    }
  }
  return null;
}


// ═══════════════════════════════════════════════════════════════
//  CREACIÓN DE EGRESOS
// ═══════════════════════════════════════════════════════════════

function _crearEgresoItem(ss, idST, itemMatch, ahora, fechaGasto) {
  var fc = itemMatch.factura_costo_datos;
  return _insertarEgreso(ss, {
    idST:        idST,
    fechaGasto:  fechaGasto,
    ahora:       ahora,
    proveedor:   fc.proveedor        || '',
    ruc:         fc.ruc_proveedor    || '',
    dv:          fc.dv_proveedor     || '',
    num_fac:     fc.num_factura      || '',
    total:       itemMatch.costo_total,
    itbms:       itemMatch.costo_itbms,
    moneda:      fc.moneda           || 'USD',
    tipo_egreso: _mapTipoEgreso(fc.tipo_costo),
    driveUrl:    fc._drive_url       || '',
    id_st_item:  itemMatch._id_st_item || '',
    descripcion: itemMatch.descripcion + ' [' + itemMatch.codigo + ']',
    notas:       'ST: ' + idST + ' | Ítem: ' + itemMatch.codigo,
    es_inventario: false,
  });
}

// Egreso para ítems de envío/manejo (SHIPPING, HANDLING, Transport, etc.)
// Usa descripción como clave única en vez de código para evitar colisión con otros
// ítems de la misma factura (mismo proveedor + num_factura).
function _crearEgresoEnvio(ss, idST, itemMatch, ahora, fechaGasto) {
  var fc = itemMatch.factura_costo_datos;
  var descCorta = String(itemMatch.descripcion || '').slice(0, 60);
  return _insertarEgreso(ss, {
    idST:        idST,
    fechaGasto:  fechaGasto,
    ahora:       ahora,
    proveedor:   fc.proveedor        || '',
    ruc:         fc.ruc_proveedor    || '',
    dv:          fc.dv_proveedor     || '',
    num_fac:     (fc.num_factura || '') + '-ENV',  // sufijo para diferenciar del num_factura principal
    total:       itemMatch.costo_total,
    itbms:       itemMatch.costo_itbms || 0,
    moneda:      fc.moneda           || 'USD',
    tipo_egreso: 'costo_mercancia',
    driveUrl:    fc._drive_url       || '',
    id_st_item:  itemMatch._id_st_item || '',
    descripcion: descCorta,
    notas:       'ST: ' + idST + ' | Envío/manejo',
    es_inventario: false,
  });
}

function _crearEgresoInventario(ss, idST, itemMatch, ahora, fechaGasto, numFactCeyco) {
  var egresoId = _insertarEgreso(ss, {
    idST:        idST,
    fechaGasto:  fechaGasto,
    ahora:       ahora,
    proveedor:   'Inventario CEYCO',
    ruc:         '',
    dv:          '',
    num_fac:     'INV-' + (itemMatch._codigo_sku || itemMatch.codigo),
    total:       itemMatch.costo_total,
    itbms:       0,
    moneda:      'USD',
    tipo_egreso: 'costo_mercancia',
    driveUrl:    '',
    descripcion: itemMatch.descripcion + ' ×' + (itemMatch._cantidad || 1),
    notas:       'ST: ' + idST + ' | Origen: inventario | Fact CEYCO: ' + numFactCeyco,
    es_inventario: true,
  });

  // Registrar movimiento de inventario (decremento)
  if (itemMatch._codigo_sku && itemMatch._cantidad) {
    try {
      _registrarMovimientoInventario(
        ss,
        'salida',
        itemMatch._codigo_sku,
        itemMatch._cantidad,
        INV_ORIGEN.HISTORIAL,
        numFactCeyco,
        idST,
        '',
        itemMatch.inv_item.costo || 0,
        '',
        fechaGasto,
        'Historial | ST: ' + idST
      );
    } catch (invErr) {
      Logger.log('  ⚠️  Error registrando movimiento inventario: ' + invErr.message);
    }
  }
  return egresoId;
}

function _crearEgresoGeneral(ss, idST, datosCosto, driveUrl, ahora, fechaGasto, idItemST) {
  return _insertarEgreso(ss, {
    idST:        idST,
    fechaGasto:  fechaGasto,
    ahora:       ahora,
    proveedor:   datosCosto.proveedor     || '',
    ruc:         datosCosto.ruc_proveedor || '',
    dv:          datosCosto.dv_proveedor  || '',
    num_fac:     datosCosto.num_factura   || '',
    total:       parseFloat(datosCosto.total || '0') || 0,
    itbms:       parseFloat(datosCosto.itbms || '0') || 0,
    moneda:      datosCosto.moneda        || 'USD',
    tipo_egreso: _mapTipoEgreso(datosCosto.tipo_costo),
    driveUrl:    driveUrl || '',
    id_st_item:  idItemST  || '',
    descripcion: (datosCosto.items && datosCosto.items[0]) ? datosCosto.items[0].descripcion : (datosCosto.proveedor + ' — costo general'),
    notas:       'ST: ' + idST + ' | Costo general (flete/aduana/servicio)',
    es_inventario: false,
  });
}

// Inserta una fila en la hoja Egresos. Centralizado para evitar duplicación.
function _insertarEgreso(ss, p) {
  var sheetEgr = ss.getSheetByName(SHEET_EGRESOS);
  if (!sheetEgr) { Logger.log('⚠️  Hoja Egresos no encontrada'); return null; }

  var total    = parseFloat(p.total)    || 0;
  var itbms    = parseFloat(p.itbms)    || 0;

  // Guard: no crear egresos de $0 (ej: FedEx cuyo total = ITBM ya pagado en MBE)
  if (total <= 0) {
    Logger.log('    ⏭️  Egreso $0 omitido: ' + (p.proveedor || ''));
    return null;
  }

  var subtotal = parseFloat((total - itbms).toFixed(2));

  var fechaDate = new Date((p.fechaGasto || p.ahora.toISOString().slice(0,10)) + 'T12:00:00');
  var yearEgr   = isNaN(fechaDate.getTime()) ? p.ahora.getFullYear() : fechaDate.getFullYear();
  var mesEgr    = isNaN(fechaDate.getTime()) ? '' : (fechaDate.getMonth() + 1);

  // Correlativo anual
  var lastRow = sheetEgr.getLastRow();
  var seqEgr  = 1;
  if (lastRow > 2) {
    var idsEgr = sheetEgr.getRange(3, COL_E.ID, lastRow - 2, 1).getValues();
    for (var ke = idsEgr.length - 1; ke >= 0; ke--) {
      var ve = String(idsEgr[ke][0] || '');
      if (ve.indexOf('EGR-RP-') === 0) {
        var parts = ve.split('-');
        var n     = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(n)) { seqEgr = n + 1; break; }
      }
    }
  }
  var egresoId = 'EGR-RP-' + yearEgr + '-' + String(seqEgr).padStart(4, '0');

  // Guard duplicado (solo si no es inventario)
  // Clave: proveedor + num_factura + descripcion (permite múltiples ítems de la misma factura)
  if (!p.es_inventario && p.proveedor && p.num_fac && lastRow > 2) {
    var pNorm  = p.proveedor.trim().toUpperCase();
    var fNorm  = p.num_fac.trim();
    var dNorm  = String(p.descripcion || '').trim().toUpperCase().slice(0, 40);
    var existEgr = sheetEgr.getRange(3, 1, lastRow - 2, EGRESOS_NCOLS).getValues();
    for (var d = 0; d < existEgr.length; d++) {
      var pe = String(existEgr[d][COL_E.PROVEEDOR    - 1] || '').trim().toUpperCase();
      var ne = String(existEgr[d][COL_E.NFACTURA     - 1] || '').trim();
      var de = String(existEgr[d][COL_E.DESCRIPCION  - 1] || '').trim().toUpperCase().slice(0, 40);
      if (pe === pNorm && ne && ne === fNorm && de === dNorm) {
        Logger.log('    ⚠️  Egreso duplicado ignorado: ' + pNorm + ' / ' + fNorm + ' / ' + dNorm);
        return null;
      }
    }
  }

  var fila = new Array(EGRESOS_NCOLS);
  for (var x = 0; x < EGRESOS_NCOLS; x++) fila[x] = '';
  fila[COL_E.ID - 1]          = egresoId;
  fila[COL_E.FECHA_REG - 1]   = Utilities.formatDate(p.ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
  fila[COL_E.ESTADO - 1]      = 'registrado';
  fila[COL_E.FECHA_GASTO - 1] = p.fechaGasto || Utilities.formatDate(p.ahora, 'America/Panama', 'yyyy-MM-dd');
  fila[COL_E.MES - 1]         = mesEgr;
  fila[COL_E.ANIO - 1]        = yearEgr;
  fila[COL_E.SUBTOTAL - 1]    = subtotal || '';
  fila[COL_E.ITBMS - 1]       = itbms    || '';
  fila[COL_E.TOTAL - 1]       = total    || '';
  fila[COL_E.MONEDA - 1]      = p.moneda || 'USD';
  fila[COL_E.TIPO_EGRESO - 1] = p.tipo_egreso || 'costo_mercancia';
  fila[COL_E.CATEGORIA - 1]   = p.tipo_egreso || 'costo_mercancia';
  fila[COL_E.PROVEEDOR - 1]   = p.proveedor   || '';
  fila[COL_E.RUC_PROV - 1]    = p.ruc         || '';
  fila[COL_E.DV_PROV - 1]     = p.dv          || '';
  fila[COL_E.NFACTURA - 1]    = p.num_fac     || '';
  fila[COL_E.ID_ITEM_CV - 1]  = '';  // Q — id_item_cv (Compras_Ventas), vacío en historial
  fila[COL_E.DRIVE_URL - 1]   = p.driveUrl    || '';
  fila[COL_E.DESCRIPCION - 1] = p.descripcion || '';
  fila[COL_E.NOTAS - 1]       = p.notas       || '';
  // id_st_item en col U (21) — debe escribirse en el array ANTES de setValues
  if (p.id_st_item && COL_E.ID_ST_ITEM) {
    fila[COL_E.ID_ST_ITEM - 1] = p.id_st_item;
  }

  var newRow = sheetEgr.getLastRow() + 1;
  sheetEgr.getRange(newRow, 1, 1, EGRESOS_NCOLS).setValues([fila]);
  sheetEgr.getRange(newRow, COL_E.SUBTOTAL, 1, 3).setNumberFormat('#,##0.00');
  var bgEgr = p.es_inventario ? '#E3F2FD' : '#F3E5F5';
  sheetEgr.getRange(newRow, 1, 1, EGRESOS_NCOLS).setBackground(bgEgr);

  Logger.log('    💾 Egreso: ' + egresoId + ' | ' + p.proveedor + ' | $' + total);
  return egresoId;
}

function _mapTipoEgreso(tipoCosto) {
  var m = {
    'producto':             'costo_mercancia',
    'producto_extranjero':  'costo_mercancia',
    'flete':                'costo_servicio_tecnico',
    'flete_internacional':  'costo_servicio_tecnico',
    'aduana':               'costo_servicio_tecnico',
    'impuesto_importacion': 'costo_servicio_tecnico',
    'servicio':             'servicios_profesionales',
    'otro':                 'costo_mercancia',
  };
  return m[tipoCosto] || 'costo_mercancia';
}

// Mapeo tipo_costo de factura → tipo de ST_Item (alineado con ST_TIPOS_ITEM)
function _mapTipoSTItem(tipoCosto, esEnvio) {
  if (esEnvio) return 'shipping_handling';
  var m = {
    'producto':             'producto',
    'producto_extranjero':  'producto',
    'flete':                'shipping_handling',
    'flete_internacional':  'shipping_handling',
    'aduana':               'impuesto',
    'impuesto_importacion': 'impuesto',
    'servicio':             'subcontrato',
    'otro':                 'producto',
  };
  return m[tipoCosto] || 'producto';
}


// ═══════════════════════════════════════════════════════════════
//  CREACIÓN DE ST_ITEMS
// ═══════════════════════════════════════════════════════════════

function _crearSTItem(sheetSTI, idST, seq, itemMatch, egresoId, ahora, idItemSTPre) {
  var fechaReg = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
  var total    = parseFloat(itemMatch.costo_total || '0') || 0;
  var itbms    = parseFloat(itemMatch.costo_itbms || '0') || 0;
  var subtotal = parseFloat((total - itbms).toFixed(2));

  // Usar ID pre-generado si se pasó (flujo de importación historial),
  // para que egreso y ST_Item compartan el mismo id_st_item.
  var idItemST = idItemSTPre || ('STI-RP-' + Utilities.formatDate(ahora, 'America/Panama', 'yyyyMMddHHmmss') + '-' + seq);

  // Clasificar tipo según origen del ítem:
  //   es_envio=true  → shipping_handling (Transport TME, SHIPPING COST Dimyeen, etc.)
  //   es_jpeg=true   → shipping_handling pendiente (MBE leído de imagen)
  //   warning        → producto pendiente
  //   default        → producto ejecutado
  var tipoItem = itemMatch.es_envio  ? 'shipping_handling' :
                 itemMatch.es_jpeg   ? 'shipping_handling' :
                 itemMatch.tipo_costo === 'warning' ? 'producto' : 'producto';

  var notas = 'Historial | ' + itemMatch.tipo_costo;
  if (itemMatch.tipo_costo === 'warning') {
    notas += ' — SIN COSTO ⚠️ Requiere revisión';
  } else if (itemMatch.tipo_costo === 'venta_inventario') {
    notas += ' | Inventario';
    if (itemMatch.costo_prorrateado > 0) notas += ' | Flete/aduana prorrateado: $' + itemMatch.costo_prorrateado.toFixed(2);
  } else {
    if (itemMatch.costo_prorrateado > 0) {
      notas += ' | Costo producto: $' + itemMatch.costo_producto.toFixed(2) +
               ' + Flete/aduana: $' + itemMatch.costo_prorrateado.toFixed(2) +
               ' = Total: $' + itemMatch.costo_total.toFixed(2);
    }
  }

  var filaItem = new Array(STI_NCOLS);
  for (var xi = 0; xi < STI_NCOLS; xi++) filaItem[xi] = '';
  filaItem[COL_STI.ID - 1]            = idItemST;
  filaItem[COL_STI.ID_ST - 1]         = idST;
  filaItem[COL_STI.TIPO - 1]          = tipoItem;
  // Ítems de JPEG: envolver descripción en [] para señalar revisión manual
  var _descBase = (itemMatch.codigo ? '[' + itemMatch.codigo + '] ' : '') + (itemMatch.descripcion || '');
  filaItem[COL_STI.DESCRIPCION - 1]   = itemMatch.es_jpeg ? '[' + _descBase + ']' : _descBase;
  filaItem[COL_STI.CANTIDAD - 1]      = itemMatch.cantidad || 1;
  filaItem[COL_STI.APLICA_ITBMS - 1]  = itbms > 0;
  filaItem[COL_STI.MONTO_COT - 1]     = subtotal;
  filaItem[COL_STI.ITBMS_COT - 1]     = itbms;
  filaItem[COL_STI.TOTAL_COT - 1]     = total;
  filaItem[COL_STI.MONTO_REAL - 1]    = subtotal;
  filaItem[COL_STI.ITBMS_REAL - 1]    = itbms;
  filaItem[COL_STI.TOTAL_REAL - 1]    = total;
  // drive_url_factura: URL de la factura de costo del proveedor (col Q)
  var _driveUrlFactura = (itemMatch.factura_costo_datos && itemMatch.factura_costo_datos._drive_url)
    ? itemMatch.factura_costo_datos._drive_url
    : '';
  filaItem[COL_STI.DRIVE_URL - 1]     = _driveUrlFactura;
  filaItem[COL_STI.EGRESO_ID - 1]     = egresoId || '';
  // Si el ítem proviene de un archivo JPEG, marcarlo pendiente para revisión manual
  var _esPendiente = itemMatch.tipo_costo === 'warning' || itemMatch.es_jpeg;
  filaItem[COL_STI.ESTADO_ITEM - 1]   = _esPendiente ? 'pendiente' : 'ejecutado';
  filaItem[COL_STI.ES_ADICIONAL - 1]  = false;
  filaItem[COL_STI.NOTAS - 1]         = notas;
  filaItem[COL_STI.FECHA_REG - 1]     = fechaReg;

  var newRow = sheetSTI.getLastRow() + 1;
  sheetSTI.getRange(newRow, 1, 1, STI_NCOLS).setValues([filaItem]);
  sheetSTI.getRange(newRow, COL_STI.MONTO_COT, 1, 3).setNumberFormat('#,##0.00');
  var bg = itemMatch.tipo_costo === 'warning'         ? '#FFEBEE' :
           itemMatch.tipo_costo === 'venta_inventario'? '#E3F2FD' : '#E8F5E9';
  sheetSTI.getRange(newRow, 1, 1, STI_NCOLS).setBackground(bg);
}

function _crearSTItemGeneral(sheetSTI, idST, seq, datosCosto, egresoId, ahora, idItemSTPre) {
  var fechaReg = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
  var total    = parseFloat(datosCosto.total || '0') || 0;
  var itbms    = parseFloat(datosCosto.itbms || '0') || 0;
  var subtotal = parseFloat((total - itbms).toFixed(2));

  var idItemST = idItemSTPre || ('STI-RP-' + Utilities.formatDate(ahora, 'America/Panama', 'yyyyMMddHHmmss') + '-' + seq);
  var tipoItem = _mapTipoItemGeneral(datosCosto.tipo_costo);
  var desc     = datosCosto.proveedor + ' — ' + (datosCosto.tipo_costo || 'costo general');
  if (datosCosto.items && datosCosto.items[0]) desc = datosCosto.items[0].descripcion || desc;

  var filaItem = new Array(STI_NCOLS);
  for (var xi = 0; xi < STI_NCOLS; xi++) filaItem[xi] = '';
  filaItem[COL_STI.ID - 1]            = idItemST;
  filaItem[COL_STI.ID_ST - 1]         = idST;
  filaItem[COL_STI.TIPO - 1]          = tipoItem;
  filaItem[COL_STI.DESCRIPCION - 1]   = desc;
  filaItem[COL_STI.CANTIDAD - 1]      = 1;
  filaItem[COL_STI.APLICA_ITBMS - 1]  = itbms > 0;
  filaItem[COL_STI.MONTO_COT - 1]     = subtotal;
  filaItem[COL_STI.ITBMS_COT - 1]     = itbms;
  filaItem[COL_STI.TOTAL_COT - 1]     = total;
  filaItem[COL_STI.MONTO_REAL - 1]    = subtotal;
  filaItem[COL_STI.ITBMS_REAL - 1]    = itbms;
  filaItem[COL_STI.TOTAL_REAL - 1]    = total;
  filaItem[COL_STI.DRIVE_URL - 1]     = datosCosto._drive_url || '';
  filaItem[COL_STI.EGRESO_ID - 1]     = egresoId || '';
  filaItem[COL_STI.ESTADO_ITEM - 1]   = 'ejecutado';
  filaItem[COL_STI.ES_ADICIONAL - 1]  = true;
  filaItem[COL_STI.NOTAS - 1]         = 'Costo general: ' + datosCosto.proveedor;
  filaItem[COL_STI.FECHA_REG - 1]     = fechaReg;

  var newRow = sheetSTI.getLastRow() + 1;
  sheetSTI.getRange(newRow, 1, 1, STI_NCOLS).setValues([filaItem]);
  sheetSTI.getRange(newRow, COL_STI.MONTO_COT, 1, 3).setNumberFormat('#,##0.00');
  sheetSTI.getRange(newRow, 1, 1, STI_NCOLS).setBackground('#FFF3E0');  // naranja claro = costo adicional
}

function _mapTipoItemGeneral(tipoCosto) {
  // Mapeo de tipo_costo de factura → tipo de ST_Item
  // FedEx/DHL/aduana/MBE boleta → 'impuesto'
  // flete de proveedor → 'shipping_handling'
  var m = {
    'flete':                'shipping_handling',
    'flete_internacional':  'shipping_handling',
    'aduana':               'impuesto',
    'impuesto_importacion': 'impuesto',
    'servicio':             'subcontrato',
  };
  return m[tipoCosto] || 'impuesto';
}


// ═══════════════════════════════════════════════════════════════
//  GUARDS Y HELPERS
// ═══════════════════════════════════════════════════════════════

function _ingresoYaExiste(ss, numFactura, nombreCliente) {
  if (!numFactura) return false;
  var sheet = ss.getSheetByName(CONFIG.SHEET_INGRESOS);
  if (!sheet || sheet.getLastRow() <= 2) return false;
  // Normalizar: strip ceros a la izquierda y convertir float (ej: 516.0) a entero string
  var _normNum = function(v) {
    var s = String(v || '').trim();
    // Si es float tipo "516.0", convertir a "516"
    if (/^\d+\.0$/.test(s)) s = s.slice(0, s.indexOf('.'));
    // Strip ceros iniciales para comparar "0000000516" == "516"
    return s.replace(/^0+/, '') || '0';
  };
  var numNorm = _normNum(numFactura);
  var data = sheet.getRange(3, COL_I.NUM_FACTURA, sheet.getLastRow() - 2, 1).getValues();
  for (var i = 0; i < data.length; i++) {
    if (_normNum(data[i][0]) === numNorm) return true;
  }
  return false;
}

// Devuelve { total, set } donde set = { nombreCarpeta: true } para las ya procesadas
function _carpetasYaProcesadas(logSheet, mes) {
  var result = { total: 0, set: {} };
  if (!logSheet || logSheet.getLastRow() <= 1) return result;
  var numRows = logSheet.getLastRow() - 1;
  var data    = logSheet.getRange(2, COL_IL.MES, numRows, 2).getValues(); // cols MES + CARPETA
  for (var i = 0; i < data.length; i++) {
    var mesFila     = String(data[i][0] || '').trim().replace(' (reimport)', '').trim();
    var carpetaFila = String(data[i][1] || '').trim();
    if (mesFila === mes && carpetaFila) {
      result.set[carpetaFila] = true;
      result.total++;
    }
  }
  return result;
}

function _mesYaImportado(logSheet, mes) {
  return _carpetasYaProcesadas(logSheet, mes).total > 0;
}


// ═══════════════════════════════════════════════════════════════
//  LOG DE IMPORTACIÓN
// ═══════════════════════════════════════════════════════════════

function _initImportLog(ss) {
  var existing = ss.getSheetByName(IH_CONFIG.SHEET_IMPORT_LOG);
  if (existing) return existing;
  var sheet = ss.insertSheet(IH_CONFIG.SHEET_IMPORT_LOG);
  SpreadsheetApp.flush();
  var headers = [
    'fecha_importacion','mes','carpeta_drive','id_st',
    'num_factura_real','cliente','total_venta','total_costo',
    'tipo_venta','tipo_costo','estado','ingreso_id',
    'items_warning','error_msg'
  ];
  sheet.getRange(1, 1, 1, IH_CONFIG.LOG_NCOLS).setValues([headers]);
  sheet.getRange(1, 1, 1, IH_CONFIG.LOG_NCOLS)
    .setBackground('#1A237E').setFontColor('#FFFFFF').setFontWeight('bold');
  sheet.setFrozenRows(1);
  var widths = [150,110,260,140,120,200,90,90,110,200,90,160,200,300];
  for (var i = 0; i < widths.length; i++) sheet.setColumnWidth(i + 1, widths[i]);
  sheet.getRange('G2:H1000').setNumberFormat('#,##0.00');
  Logger.log('✅ Hoja Import_Log creada.');
  return sheet;
}

function _registrarLogImport(logSheet, mes, carpeta, resultado) {
  var fila = new Array(IH_CONFIG.LOG_NCOLS);
  for (var x = 0; x < IH_CONFIG.LOG_NCOLS; x++) fila[x] = '';
  fila[COL_IL.FECHA_IMPORT - 1]  = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
  fila[COL_IL.MES - 1]           = mes;
  fila[COL_IL.CARPETA - 1]       = carpeta;
  fila[COL_IL.ID_ST - 1]         = resultado.id_st        || '';
  fila[COL_IL.NUM_FACTURA - 1]   = resultado.num_factura  || '';
  fila[COL_IL.CLIENTE - 1]       = resultado.cliente      || '';
  fila[COL_IL.TOTAL_VENTA - 1]   = resultado.total_venta  || '';
  fila[COL_IL.TOTAL_COSTO - 1]   = resultado.total_costo  || '';
  fila[COL_IL.TIPO_VENTA - 1]    = resultado.tipo_venta   || '';
  fila[COL_IL.TIPO_COSTO - 1]    = resultado.tipo_costo   || '';
  fila[COL_IL.ESTADO - 1]        = resultado.estado       || '';
  fila[COL_IL.INGRESO_ID - 1]    = resultado.ingreso_id   || '';
  fila[COL_IL.ITEMS_WARNING - 1] = resultado.items_warning|| '';
  fila[COL_IL.ERROR_MSG - 1]     = resultado.error_msg    || '';

  var newRow = logSheet.getLastRow() + 1;
  logSheet.getRange(newRow, 1, 1, IH_CONFIG.LOG_NCOLS).setValues([fila]);
  var bg = resultado.estado === 'completo'    ? '#F1F8E9' :
           resultado.estado === 'sin_voucher' ? '#FFF9C4' :
           resultado.estado === 'warning'     ? '#FFF3E0' : '#FFEBEE';
  logSheet.getRange(newRow, 1, 1, IH_CONFIG.LOG_NCOLS).setBackground(bg);
}


// ═══════════════════════════════════════════════════════════════
//  VERIFICACIÓN Y UTILIDADES
// ═══════════════════════════════════════════════════════════════

function verificarSetupImportacion() {
  Logger.log('🔍 Verificando setup...');
  try {
    var root = DriveApp.getFolderById(IH_CONFIG.DRIVE_FOLDER_ID);
    Logger.log('✅ Carpeta Drive raíz: "' + root.getName() + '"');
    IH_CONFIG.MESES_VALIDOS.forEach(function(mes) {
      var iter = root.getFoldersByName(mes);
      if (iter.hasNext()) {
        var mf = iter.next(); var c = 0;
        var subs = mf.getFolders(); while (subs.hasNext()) { subs.next(); c++; }
        Logger.log('  ✅ "' + mes + '" — ' + c + ' carpetas');
      } else {
        Logger.log('  ⚠️  "' + mes + '" — NO encontrada');
      }
    });
  } catch(e) { Logger.log('❌ Drive: ' + e.message); }

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  [SHEET_INV_MAESTRO, SHEET_INV_MOV].forEach(function(n) {
    var sh = ss.getSheetByName(n);
    Logger.log(sh ? '✅ "' + n + '" — ' + Math.max(0,sh.getLastRow()-2) + ' filas' : '❌ "' + n + '" no encontrada');
  });
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  Logger.log(apiKey ? '✅ CLAUDE_API_KEY OK' : '❌ CLAUDE_API_KEY falta');
  [CONFIG.SHEET_INGRESOS, SHEET_EGRESOS, SHEET_ST, SHEET_ST_ITEM].forEach(function(n) {
    Logger.log(ss.getSheetByName(n) ? '✅ "' + n + '"' : '⚠️  "' + n + '" — se creará al importar');
  });
  Logger.log('\n📋 Ejecutar: importarHistorialMes("ENERO 2026")');
}

function reimportarCarpeta(mes, nombreCarpeta) {
  Logger.log('🔄 Reimportando: ' + mes + ' / ' + nombreCarpeta);
  var root       = DriveApp.getFolderById(IH_CONFIG.DRIVE_FOLDER_ID);
  var mesIter    = root.getFoldersByName(mes);
  if (!mesIter.hasNext()) { Logger.log('❌ Mes no encontrado'); return; }
  var carpetaIter= mesIter.next().getFoldersByName(nombreCarpeta);
  if (!carpetaIter.hasNext()) { Logger.log('❌ Carpeta no encontrada'); return; }
  var ss         = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  _initImportLog(ss);
  var resultado  = _procesarCarpetaFactura(ss, carpetaIter.next(), mes);
  var logSheet   = ss.getSheetByName(IH_CONFIG.SHEET_IMPORT_LOG);
  _registrarLogImport(logSheet, mes + ' (reimport)', nombreCarpeta, resultado);
  Logger.log('Resultado: ' + JSON.stringify(resultado));
}


// ═══════════════════════════════════════════════════════════════
//  limpiarYReimportarCarpeta
// ═══════════════════════════════════════════════════════════════

function limpiarYReimportarCarpeta(mes, nombreCarpeta, ejecutar) {
  if (ejecutar === undefined) ejecutar = false;
  var modo = ejecutar ? '🗑️  EJECUTANDO' : '🔍 DRY RUN';

  Logger.log('═══════════════════════════════════════════');
  Logger.log(modo + ' — Limpiar y reimportar: ' + nombreCarpeta);
  Logger.log('═══════════════════════════════════════════');

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);

  var logSheet = ss.getSheetByName(IH_CONFIG.SHEET_IMPORT_LOG);
  if (!logSheet || logSheet.getLastRow() <= 1) {
    Logger.log('❌ Import_Log vacío'); return;
  }

  var logData   = logSheet.getRange(2, 1, logSheet.getLastRow() - 1, IH_CONFIG.LOG_NCOLS).getValues();
  var logFilas  = [];
  var idsSTCarpeta = [];

  for (var i = 0; i < logData.length; i++) {
    var carpeta = String(logData[i][COL_IL.CARPETA - 1] || '').trim();
    var carpetaBase = carpeta.replace(' (reimport)', '').trim();
    if (carpetaBase === nombreCarpeta) {
      logFilas.push(i);
      var idST = String(logData[i][COL_IL.ID_ST - 1] || '').trim();
      if (idST) idsSTCarpeta.push(idST);
    }
  }

  if (!idsSTCarpeta.length) {
    Logger.log('⚠️  No se encontró registro de "' + nombreCarpeta + '" en Import_Log.');
    Logger.log('   Si nunca fue importada, usa reimportarCarpeta() directamente.');
    return;
  }

  Logger.log('IDs ST a limpiar: ' + idsSTCarpeta.join(', '));

  var setIDs = {};
  idsSTCarpeta.forEach(function(id) { setIDs[id] = true; });
  var stats = { total: 0 };

  _borrarFilas(logSheet, logFilas, 2, ejecutar, 'Import_Log', stats);

  var sheetST = ss.getSheetByName(SHEET_ST);
  if (sheetST && sheetST.getLastRow() > 2) {
    var stData  = sheetST.getRange(3, 1, sheetST.getLastRow() - 2, ST_NCOLS).getValues();
    var stFilas = [];
    for (var s = 0; s < stData.length; s++) {
      if (setIDs[String(stData[s][COL_ST.ID - 1] || '').trim()]) {
        Logger.log('  ST: ' + stData[s][COL_ST.ID - 1] + ' | ' + stData[s][COL_ST.NOMBRE_CLI - 1] + ' | $' + stData[s][COL_ST.PRECIO_VENTA - 1]);
        stFilas.push(s);
      }
    }
    _borrarFilas(sheetST, stFilas, 3, ejecutar, 'Servicios_Tecnicos', stats);
  }

  var sheetSTI = ss.getSheetByName(SHEET_ST_ITEM);
  if (sheetSTI && sheetSTI.getLastRow() > 2) {
    var stiData  = sheetSTI.getRange(3, 1, sheetSTI.getLastRow() - 2, STI_NCOLS).getValues();
    var stiFilas = [];
    for (var t = 0; t < stiData.length; t++) {
      if (setIDs[String(stiData[t][COL_STI.ID_ST - 1] || '').trim()]) {
        Logger.log('  STI: ' + stiData[t][COL_STI.ID - 1] + ' | ' + String(stiData[t][COL_STI.DESCRIPCION - 1] || '').slice(0, 40));
        stiFilas.push(t);
      }
    }
    _borrarFilas(sheetSTI, stiFilas, 3, ejecutar, 'ST_Items', stats);
  }

  var sheetIng = ss.getSheetByName(CONFIG.SHEET_INGRESOS);
  if (sheetIng && sheetIng.getLastRow() > 2) {
    var ingData  = sheetIng.getRange(3, 1, sheetIng.getLastRow() - 2, INGRESOS_NCOLS).getValues();
    var ingFilas = [];
    for (var n = 0; n < ingData.length; n++) {
      var notas = String(ingData[n][COL_I.NOTAS_INT - 1] || '');
      if (idsSTCarpeta.some(function(id) { return notas.indexOf(id) !== -1; })) {
        Logger.log('  ING: ' + ingData[n][COL_I.ID_TRANS - 1] + ' | ' + ingData[n][COL_I.NOMBRE_CLI - 1] + ' | $' + ingData[n][COL_I.TOTAL - 1]);
        ingFilas.push(n);
      }
    }
    _borrarFilas(sheetIng, ingFilas, 3, ejecutar, 'Ingresos', stats);
  }

  var sheetEgr = ss.getSheetByName(SHEET_EGRESOS);
  if (sheetEgr && sheetEgr.getLastRow() > 2) {
    var egrCols  = Math.min(sheetEgr.getLastColumn(), 21);
    var egrData  = sheetEgr.getRange(3, 1, sheetEgr.getLastRow() - 2, egrCols).getValues();
    var egrFilas = [];
    for (var e = 0; e < egrData.length; e++) {
      var notasEgr    = String(egrData[e][COL_E.NOTAS - 1] || '');
      var idStItemEgr = egrCols >= 21 ? String(egrData[e][20] || '') : '';
      if (idsSTCarpeta.some(function(id) { return notasEgr.indexOf(id) !== -1 || idStItemEgr.indexOf(id) !== -1; })) {
        Logger.log('  EGR: ' + egrData[e][COL_E.ID - 1] + ' | ' + egrData[e][COL_E.PROVEEDOR - 1] + ' | $' + egrData[e][COL_E.TOTAL - 1]);
        egrFilas.push(e);
      }
    }
    _borrarFilas(sheetEgr, egrFilas, 3, ejecutar, 'Egresos', stats);
  }

  var sheetMov = ss.getSheetByName(SHEET_INV_MOV);
  if (sheetMov && sheetMov.getLastRow() >= INV_MOV_DATA_ROW) {
    var movData  = sheetMov.getRange(INV_MOV_DATA_ROW, 1, sheetMov.getLastRow() - INV_MOV_DATA_ROW + 1, INV_MOV_NCOLS).getValues();
    var movFilas = [];
    for (var m = 0; m < movData.length; m++) {
      var idSTMov   = String(movData[m][COL_MV.ID_ST - 1] || '').trim();
      var origenMov = String(movData[m][COL_MV.ORIGEN - 1] || '');
      var origenesLimpiar = [INV_ORIGEN.HISTORIAL, 'reversion_cancelacion', 'devolucion_nc'];
      if (setIDs[idSTMov] && origenesLimpiar.indexOf(origenMov) !== -1) {
        Logger.log('  MOV: ' + movData[m][COL_MV.ID - 1] + ' | ' + movData[m][COL_MV.TIPO - 1] + ' | ' + movData[m][COL_MV.CODIGO_SKU - 1] + ' ×' + movData[m][COL_MV.CANTIDAD - 1] + ' [' + origenMov + ']');
        movFilas.push(m);
      }
    }
    _borrarFilas(sheetMov, movFilas, INV_MOV_DATA_ROW, ejecutar, 'Inv_Movimientos', stats);
  }

  Logger.log('\n' + (ejecutar ? '✅ Limpieza completada' : '📊 DRY RUN — nada modificado'));
  Logger.log('   Total filas ' + (ejecutar ? 'borradas' : 'a borrar') + ': ' + stats.total);

  if (!ejecutar) {
    Logger.log('\n   ▶️  Para ejecutar: limpiarYReimportarCarpeta("' + mes + '", "' + nombreCarpeta + '", true)');
    return;
  }

  Logger.log('\n🔄 Reimportando carpeta...');
  var root        = DriveApp.getFolderById(IH_CONFIG.DRIVE_FOLDER_ID);
  var mesIter     = root.getFoldersByName(mes);
  if (!mesIter.hasNext()) { Logger.log('❌ Mes no encontrado en Drive'); return; }
  var carpetaIter = mesIter.next().getFoldersByName(nombreCarpeta);
  if (!carpetaIter.hasNext()) { Logger.log('❌ Carpeta no encontrada en Drive'); return; }

  var resultado = _procesarCarpetaFactura(ss, carpetaIter.next(), mes);
  _registrarLogImport(logSheet, mes, nombreCarpeta, resultado);

  Logger.log('\n═══════════════════════════════════════════');
  Logger.log('✅ ' + nombreCarpeta + ' reimportada');
  Logger.log('   ST: ' + resultado.id_st + ' | $' + resultado.total_venta + ' | ' + resultado.tipo_venta);
  Logger.log('   Estado: ' + resultado.estado);
  if (resultado.items_warning) Logger.log('   ⚠️  Warning: ' + resultado.items_warning);
  if (resultado.error_msg)     Logger.log('   ❌ Error: ' + resultado.error_msg);
  Logger.log('═══════════════════════════════════════════');
}

function _borrarFilas(sheet, indicesData, dataStart, ejecutar, label, stats) {
  var n = indicesData.length;
  Logger.log('\n[' + label + '] ' + n + ' fila(s) ' + (ejecutar ? 'a borrar' : '(dry run)'));
  if (n === 0) return;
  stats.total += n;
  if (ejecutar) {
    for (var i = indicesData.length - 1; i >= 0; i--) {
      sheet.deleteRow(indicesData[i] + dataStart);
    }
    SpreadsheetApp.flush();
    Logger.log('  ✅ Borradas de "' + sheet.getName() + '"');
  }
}

function importarEnero()   { importarHistorialMes('ENERO 2026');   }
function importarFebrero() { importarHistorialMes('FEBRERO 2026'); }
function importarMarzo()   { importarHistorialMes('MARZO 2026');   }


// ═══════════════════════════════════════════════════════════════
//  SISTEMA DE LOTES CON RETOMA AUTOMÁTICA
// ═══════════════════════════════════════════════════════════════

var BATCH_CONFIG = {
  PROP_MES:       'IH_BATCH_MES',
  PROP_CARPETAS:  'IH_BATCH_CARPETAS',
  PROP_STATS:     'IH_BATCH_STATS',
  PROP_TRIGGER:   'IH_BATCH_TRIGGER_ID',
  LOTE_SIZE:      2,
  INTERVALO_MIN:  5,
  HANDLER:        'continuarImportacion',
};

function iniciarEnero()   { iniciarImportacionEnLotes('ENERO 2026');   }
function iniciarFebrero() { iniciarImportacionEnLotes('FEBRERO 2026'); }
function iniciarMarzo()   { iniciarImportacionEnLotes('MARZO 2026');   }

function iniciarImportacionEnLotes(mes) {
  if (IH_CONFIG.MESES_VALIDOS.indexOf(mes) === -1) {
    Logger.log('❌ Mes no válido: ' + mes); return;
  }

  var props = PropertiesService.getScriptProperties();

  if (props.getProperty(BATCH_CONFIG.PROP_MES)) {
    Logger.log('⚠️  Ya hay una importación en curso: ' + props.getProperty(BATCH_CONFIG.PROP_MES));
    Logger.log('   Usa detenerImportacion() para cancelarla primero.');
    return;
  }

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  _initImportLog(ss);

  var logSheet      = ss.getSheetByName(IH_CONFIG.SHEET_IMPORT_LOG);
  var yaProcessadas = _carpetasYaProcesadas(logSheet, mes);

  var rootFolder    = DriveApp.getFolderById(IH_CONFIG.DRIVE_FOLDER_ID);
  var mesFolderIter = rootFolder.getFoldersByName(mes);
  if (!mesFolderIter.hasNext()) {
    Logger.log('❌ Carpeta "' + mes + '" no encontrada en Drive.'); return;
  }
  var mesFolder  = mesFolderIter.next();
  var folderIter = mesFolder.getFolders();
  var carpetas   = [];
  while (folderIter.hasNext()) {
    var nombre = folderIter.next().getName();
    if (!yaProcessadas.set[nombre]) carpetas.push(nombre);
  }

  if (carpetas.length === 0) {
    Logger.log('✅ Todas las carpetas de "' + mes + '" ya fueron procesadas.');
    return;
  }

  if (yaProcessadas.total > 0) {
    Logger.log('⚠️  Retomando "' + mes + '" — ' + yaProcessadas.total + ' ya procesadas, ' + carpetas.length + ' pendientes.');
  }

  Logger.log('📋 "' + mes + '" — ' + carpetas.length + ' carpetas pendientes');
  Logger.log('   Lote: ' + BATCH_CONFIG.LOTE_SIZE + ' carpetas / ' + BATCH_CONFIG.INTERVALO_MIN + ' min');
  Logger.log('   Estimado: ~' + Math.ceil(carpetas.length / BATCH_CONFIG.LOTE_SIZE) + ' disparo(s) de trigger');

  props.setProperty(BATCH_CONFIG.PROP_MES,      mes);
  props.setProperty(BATCH_CONFIG.PROP_CARPETAS, JSON.stringify(carpetas));
  props.setProperty(BATCH_CONFIG.PROP_STATS,    JSON.stringify({
    total: carpetas.length, completo: 0, sin_voucher: 0, warning: 0, error: 0
  }));

  var trigger = ScriptApp.newTrigger(BATCH_CONFIG.HANDLER)
    .timeBased()
    .everyMinutes(BATCH_CONFIG.INTERVALO_MIN)
    .create();
  props.setProperty(BATCH_CONFIG.PROP_TRIGGER, trigger.getUniqueId());

  Logger.log('✅ Trigger instalado. Primera ejecución en ~' + BATCH_CONFIG.INTERVALO_MIN + ' minutos.');
  Logger.log('   Usa estadoImportacion() para ver el progreso.');

  continuarImportacion();
}

function continuarImportacion() {
  var props = PropertiesService.getScriptProperties();
  var mes   = props.getProperty(BATCH_CONFIG.PROP_MES);

  if (!mes) {
    Logger.log('ℹ️  No hay importación en curso — eliminando trigger huérfano si existe.');
    _eliminarTriggerBatch(props);
    return;
  }

  var carpetasPendientes = JSON.parse(props.getProperty(BATCH_CONFIG.PROP_CARPETAS) || '[]');
  var stats              = JSON.parse(props.getProperty(BATCH_CONFIG.PROP_STATS)    || '{}');

  if (carpetasPendientes.length === 0) {
    _finalizarImportacion(props, mes, stats);
    return;
  }

  var lote = carpetasPendientes.splice(0, BATCH_CONFIG.LOTE_SIZE);

  Logger.log('═══════════════════════════════════════════');
  Logger.log('🔄 LOTE — "' + mes + '" | ' +
             'Procesando: ' + lote.length + ' | ' +
             'Restantes: ' + carpetasPendientes.length + ' | ' +
             'Completadas: ' + (stats.completo + stats.sin_voucher + stats.warning + stats.error));
  Logger.log('═══════════════════════════════════════════');

  var ss          = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var logSheet    = ss.getSheetByName(IH_CONFIG.SHEET_IMPORT_LOG);
  var rootFolder  = DriveApp.getFolderById(IH_CONFIG.DRIVE_FOLDER_ID);
  var mesFolderIt = rootFolder.getFoldersByName(mes);
  if (!mesFolderIt.hasNext()) {
    Logger.log('❌ Carpeta del mes no encontrada en Drive.');
    _finalizarImportacion(props, mes, stats);
    return;
  }
  var mesFolder = mesFolderIt.next();

  for (var i = 0; i < lote.length; i++) {
    var nombreCarpeta = lote[i];
    Logger.log('\n📁 ' + nombreCarpeta);
    var carpetaIter = mesFolder.getFoldersByName(nombreCarpeta);
    if (!carpetaIter.hasNext()) {
      Logger.log('  ⚠️  Carpeta no encontrada: ' + nombreCarpeta);
      stats.error++;
      continue;
    }
    try {
      var resultado = _procesarCarpetaFactura(ss, carpetaIter.next(), mes);
      _registrarLogImport(logSheet, mes, nombreCarpeta, resultado);
      var s = resultado.estado;
      if      (s === 'error')       { stats.error++;       Logger.log('  ❌ ' + resultado.error_msg); }
      else if (s === 'warning')     { stats.warning++;     Logger.log('  ⚠️  Warning: ' + resultado.items_warning); }
      else if (s === 'sin_voucher') { stats.sin_voucher++; Logger.log('  ⚠️  Sin voucher: ' + resultado.id_st); }
      else                          { stats.completo++;    Logger.log('  ✅ ' + resultado.id_st + ' | $' + resultado.total_venta); }
    } catch(err) {
      stats.error++;
      Logger.log('  ❌ Excepción: ' + err.message);
      _registrarLogImport(logSheet, mes, nombreCarpeta, {
        id_st:'', num_factura:'', cliente:'', total_venta:0, total_costo:0,
        tipo_venta:'', tipo_costo:'', estado:'error', ingreso_id:'',
        items_warning:'', error_msg: err.message,
      });
    }
    Utilities.sleep(1500);
  }

  props.setProperty(BATCH_CONFIG.PROP_CARPETAS, JSON.stringify(carpetasPendientes));
  props.setProperty(BATCH_CONFIG.PROP_STATS,    JSON.stringify(stats));

  Logger.log('\n📊 Progreso: ' +
             (stats.completo + stats.sin_voucher + stats.warning + stats.error) +
             '/' + stats.total + ' | Restantes: ' + carpetasPendientes.length);

  if (carpetasPendientes.length === 0) {
    _finalizarImportacion(props, mes, stats);
  }
}

function _finalizarImportacion(props, mes, stats) {
  _eliminarTriggerBatch(props);
  props.deleteProperty(BATCH_CONFIG.PROP_MES);
  props.deleteProperty(BATCH_CONFIG.PROP_CARPETAS);
  props.deleteProperty(BATCH_CONFIG.PROP_STATS);

  Logger.log('\n═══════════════════════════════════════════');
  Logger.log('✅ IMPORTACIÓN COMPLETADA: "' + mes + '"');
  Logger.log('   ✅ Completos:    ' + stats.completo);
  Logger.log('   ⚠️  Sin voucher: ' + stats.sin_voucher);
  Logger.log('   🚨 Warning:     ' + stats.warning);
  Logger.log('   ❌ Errores:     ' + stats.error);
  Logger.log('   Trigger eliminado — revisar Import_Log para detalles.');
  Logger.log('═══════════════════════════════════════════');
}

function _eliminarTriggerBatch(props) {
  var triggerId = props.getProperty(BATCH_CONFIG.PROP_TRIGGER);
  if (!triggerId) return;
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getUniqueId() === triggerId ||
        triggers[i].getHandlerFunction() === BATCH_CONFIG.HANDLER) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  props.deleteProperty(BATCH_CONFIG.PROP_TRIGGER);
}

function estadoImportacion() {
  var props   = PropertiesService.getScriptProperties();
  var mes     = props.getProperty(BATCH_CONFIG.PROP_MES);
  if (!mes) { Logger.log('ℹ️  No hay importación en curso.'); return; }
  var pend    = JSON.parse(props.getProperty(BATCH_CONFIG.PROP_CARPETAS) || '[]');
  var stats   = JSON.parse(props.getProperty(BATCH_CONFIG.PROP_STATS)    || '{}');
  var procMax = stats.total - pend.length;
  Logger.log('📊 Importación en curso: "' + mes + '"');
  Logger.log('   Procesadas: ' + procMax + '/' + stats.total);
  Logger.log('   Restantes:  ' + pend.length);
  Logger.log('   Completas:  ' + stats.completo + ' | Sin voucher: ' + stats.sin_voucher +
             ' | Warning: ' + stats.warning + ' | Error: ' + stats.error);
  Logger.log('   Próximo lote: siguiente disparo del trigger (~' + BATCH_CONFIG.INTERVALO_MIN + ' min)');
}

function detenerImportacion() {
  var props = PropertiesService.getScriptProperties();
  _eliminarTriggerBatch(props);
  var mes = props.getProperty(BATCH_CONFIG.PROP_MES) || '(desconocido)';
  props.deleteProperty(BATCH_CONFIG.PROP_MES);
  props.deleteProperty(BATCH_CONFIG.PROP_CARPETAS);
  props.deleteProperty(BATCH_CONFIG.PROP_STATS);
  Logger.log('🛑 Importación detenida: "' + mes + '"');
  Logger.log('   Trigger eliminado. El Import_Log conserva lo ya procesado.');
  Logger.log('   Para reimportar: limpiarEnero2026() + iniciarEnero()');
}

// ── Wrappers para reimportar carpetas específicas ─────────────

function dryRunFACT505()     { limpiarYReimportarCarpeta('ENERO 2026', 'FACT505MANZANILLO'); }
function ejecutarFACT505()   { limpiarYReimportarCarpeta('ENERO 2026', 'FACT505MANZANILLO', true); }
function reimportarFACT505() { reimportarCarpeta('ENERO 2026', 'FACT505MANZANILLO'); }

function dryRunFACT506()     { limpiarYReimportarCarpeta('ENERO 2026', 'FACT506RODIO PANAMA'); }
function ejecutarFACT506()   { limpiarYReimportarCarpeta('ENERO 2026', 'FACT506RODIO PANAMA', true); }
function reimportarFACT506() { reimportarCarpeta('ENERO 2026', 'FACT506RODIO PANAMA'); }

function dryRunFACT507()     { limpiarYReimportarCarpeta('ENERO 2026', 'FACT507SERVICIOS ELECTRICOS'); }
function ejecutarFACT507()   { limpiarYReimportarCarpeta('ENERO 2026', 'FACT507SERVICIOS ELECTRICOS', true); }
function reimportarFACT507() { reimportarCarpeta('ENERO 2026', 'FACT507SERVICIOS ELECTRICOS'); }

function dryRunFACT508()     { limpiarYReimportarCarpeta('ENERO 2026', 'FACT508KOMEX'); }
function ejecutarFACT508()   { limpiarYReimportarCarpeta('ENERO 2026', 'FACT508KOMEX', true); }
function reimportarFACT508() { reimportarCarpeta('ENERO 2026', 'FACT508KOMEX'); }

function dryRunFACT509()     { limpiarYReimportarCarpeta('ENERO 2026', 'FACT509SOFRATESA'); }
function ejecutarFACT509()   { limpiarYReimportarCarpeta('ENERO 2026', 'FACT509SOFRATESA', true); }
function reimportarFACT509() { reimportarCarpeta('ENERO 2026', 'FACT509SOFRATESA'); }

function dryRunFACT510()     { limpiarYReimportarCarpeta('ENERO 2026', 'FACT510SERVICIOS ELECTRONICOS INDUSTRIALES'); }
function ejecutarFACT510()   { limpiarYReimportarCarpeta('ENERO 2026', 'FACT510SERVICIOS ELECTRONICOS INDUSTRIALES', true); }
function reimportarFACT510() { reimportarCarpeta('ENERO 2026', 'FACT510SERVICIOS ELECTRONICOS INDUSTRIALES'); }

function dryRunFACT511()     { limpiarYReimportarCarpeta('ENERO 2026', 'FACT511SULIANIS JANETH CASTILLO'); }
function ejecutarFACT511()   { limpiarYReimportarCarpeta('ENERO 2026', 'FACT511SULIANIS JANETH CASTILLO', true); }
function reimportarFACT511() { reimportarCarpeta('ENERO 2026', 'FACT511SULIANIS JANETH CASTILLO'); }

function dryRunFACT512()     { limpiarYReimportarCarpeta('ENERO 2026', 'FACT512TALLERES INDUSTRIALES'); }
function ejecutarFACT512()   { limpiarYReimportarCarpeta('ENERO 2026', 'FACT512TALLERES INDUSTRIALES', true); }
function reimportarFACT512() { reimportarCarpeta('ENERO 2026', 'FACT512TALLERES INDUSTRIALES'); }

function dryRunFACT513()     { limpiarYReimportarCarpeta('ENERO 2026', 'FACT513ERSIGROUP'); }
function ejecutarFACT513()   { limpiarYReimportarCarpeta('ENERO 2026', 'FACT513ERSIGROUP', true); }
function reimportarFACT513() { reimportarCarpeta('ENERO 2026', 'FACT513ERSIGROUP'); }

function dryRunFACT514()     { limpiarYReimportarCarpeta('ENERO 2026', 'FACT514TALLERES INDUSTRIALES'); }
function ejecutarFACT514()   { limpiarYReimportarCarpeta('ENERO 2026', 'FACT514TALLERES INDUSTRIALES', true); }
function reimportarFACT514() { reimportarCarpeta('ENERO 2026', 'FACT514TALLERES INDUSTRIALES'); }

function dryRunFACT515()     { limpiarYReimportarCarpeta('ENERO 2026', 'FACT515SERVICIOS ELECTRONICOS INDUSTRIALES'); }
function ejecutarFACT515()   { limpiarYReimportarCarpeta('ENERO 2026', 'FACT515SERVICIOS ELECTRONICOS INDUSTRIALES', true); }
function reimportarFACT515() { reimportarCarpeta('ENERO 2026', 'FACT515SERVICIOS ELECTRONICOS INDUSTRIALES'); }


// ═══════════════════════════════════════════════════════════════
//  _crearEgresoCreditoFiscal  — v2.9j
//  Registra el ITBM acreditable de una factura de importación
//  (DHL/FedEx) como egreso tipo 'credito_fiscal' separado del
//  costo neto. Permite que el widget ITBMS Neto del P&L refleje
//  el crédito real acreditable ante DGI.
// ═══════════════════════════════════════════════════════════════

function _crearEgresoCreditoFiscal(ss, idST, datosCosto, itbmCredito, driveUrl, ahora, fechaGasto, idItemST) {
  return _insertarEgreso(ss, {
    idST:        idST,
    fechaGasto:  fechaGasto,
    ahora:       ahora,
    proveedor:   datosCosto.proveedor     || '',
    ruc:         datosCosto.ruc_proveedor || '',
    dv:          datosCosto.dv_proveedor  || '',
    num_fac:     (datosCosto.num_factura  || '') + '-ITBM',
    total:       itbmCredito,
    itbms:       itbmCredito,   // el monto ES el ITBM acreditable
    moneda:      datosCosto.moneda || 'USD',
    tipo_egreso: 'credito_fiscal',
    driveUrl:    driveUrl || '',
    id_st_item:  idItemST || '',
    descripcion: 'ITBM acreditable — ' + (datosCosto.proveedor || 'importación'),
    notas:       'ST: ' + idST + ' | Crédito fiscal ITBM importación | Factura: ' + (datosCosto.num_factura || ''),
    es_inventario: false,
  });
}

// ═══════════════════════════════════════════════════════════════
//  _crearSTItemCreditoFiscal  — v2.9j
//  Crea el ST_Item visible en el dashboard para el crédito fiscal
//  ITBM, vinculado al egreso credito_fiscal.
// ═══════════════════════════════════════════════════════════════

function _crearSTItemCreditoFiscal(sheetSTI, idST, seq, datosCosto, itbmCredito, egresoId, ahora, idItemSTPre) {
  var fechaReg = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
  var idItemST = idItemSTPre || ('STI-RP-' + Utilities.formatDate(ahora, 'America/Panama', 'yyyyMMddHHmmss') + '-' + seq);

  var filaItem = new Array(STI_NCOLS);
  for (var xi = 0; xi < STI_NCOLS; xi++) filaItem[xi] = '';
  filaItem[COL_STI.ID - 1]            = idItemST;
  filaItem[COL_STI.ID_ST - 1]         = idST;
  filaItem[COL_STI.TIPO - 1]          = 'credito_fiscal';
  filaItem[COL_STI.DESCRIPCION - 1]   = 'ITBM acreditable — ' + (datosCosto.proveedor || 'importación');
  filaItem[COL_STI.CANTIDAD - 1]      = 1;
  filaItem[COL_STI.APLICA_ITBMS - 1]  = true;
  filaItem[COL_STI.MONTO_COT - 1]     = 0;
  filaItem[COL_STI.ITBMS_COT - 1]     = 0;
  filaItem[COL_STI.TOTAL_COT - 1]     = 0;
  filaItem[COL_STI.MONTO_REAL - 1]    = 0;
  filaItem[COL_STI.ITBMS_REAL - 1]    = itbmCredito;
  filaItem[COL_STI.TOTAL_REAL - 1]    = itbmCredito;
  filaItem[COL_STI.DRIVE_URL - 1]     = datosCosto._drive_url || '';
  filaItem[COL_STI.EGRESO_ID - 1]     = egresoId || '';
  filaItem[COL_STI.ESTADO_ITEM - 1]   = 'ejecutado';
  filaItem[COL_STI.ES_ADICIONAL - 1]  = true;
  filaItem[COL_STI.NOTAS - 1]         = 'Crédito fiscal ITBM importación · ' + (datosCosto.proveedor || '');
  filaItem[COL_STI.FECHA_REG - 1]     = fechaReg;

  var newRow = sheetSTI.getLastRow() + 1;
  sheetSTI.getRange(newRow, 1, 1, STI_NCOLS).setValues([filaItem]);
  sheetSTI.getRange(newRow, COL_STI.MONTO_COT, 1, 3).setNumberFormat('#,##0.00');
  sheetSTI.getRange(newRow, 1, 1, STI_NCOLS).setBackground('#E8EAF6');  // índigo claro = crédito fiscal
}

// ═══════════════════════════════════════════════════════════════
//  WRAPPERS — FEBRERO 2026
//  6 carpetas: FACT516–FACT521
//
//  Uso:
//    dryRunFACTxxx()   → simula sin escribir, revisar log
//    ejecutarFACTxxx() → importa y escribe en Sheet
//    reimportarFACTxxx() → reimporta sin limpiar (si aún no existe el ST)
// ═══════════════════════════════════════════════════════════════

function dryRunFACT516()     { limpiarYReimportarCarpeta('FEBRERO 2026', 'FACT516TELECOM'); }
function ejecutarFACT516()   { limpiarYReimportarCarpeta('FEBRERO 2026', 'FACT516TELECOM', true); }
function reimportarFACT516() { reimportarCarpeta('FEBRERO 2026', 'FACT516TELECOM'); }
// ── FIX PUNTUAL: borrar movimientos duplicados de la FACT516 ──────────────
// Causa: limpiarYReimportarCarpeta se ejecutó dos veces antes del fix del
// limpiador. Los MOV-26/27/28 (reversion_cancelacion) quedaron duplicados.
// El stock en Inv_Maestro es fórmula SUMIFS — basta con borrar los MOV extras.
// Ejecutar UNA SOLA VEZ: limpiarMovDuplicados516()
// ── FIX PUNTUAL: limpiar duplicados de la NC114 ─────────────────────────────
// Causa: reimportarNC114() se ejecutó dos veces. Quedaron:
//   - ING-RP-20260405220139-NC2 (primer intento, antes del fix de validación ST)
//     → este se ejecutó parcialmente: marcó el ST anulado pero falló después
//     → el ST ya quedó anulado correctamente, solo hay que borrar el ING duplicado
//   - MOV-23/24/25 reversion_cancelacion (movimientos del código viejo, antes del fix)
// Ejecutar UNA SOLA VEZ: limpiarDuplicadosNC114()
function limpiarDuplicadosNC114() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);

  // 1. Borrar ING duplicado (el primero, con timestamp 220139)
  var sheetIng = ss.getSheetByName(CONFIG.SHEET_INGRESOS);
  if (sheetIng && sheetIng.getLastRow() > 2) {
    var ingData = sheetIng.getRange(3, COL_I.ID_TRANS, sheetIng.getLastRow() - 2, 1).getValues();
    for (var i = ingData.length - 1; i >= 0; i--) {
      if (String(ingData[i][0] || '').trim() === 'ING-RP-20260405220139-NC2') {
        sheetIng.deleteRow(i + 3);
        Logger.log('  🗑️  ING duplicado borrado: ING-RP-20260405220139-NC2');
        break;
      }
    }
  }

  // 2. Borrar MOV-23/24/25 (reversion_cancelacion del código viejo)
  var sheetMov = ss.getSheetByName(SHEET_INV_MOV);
  if (sheetMov && sheetMov.getLastRow() >= INV_MOV_DATA_ROW) {
    var aEliminar = ['MOV-CEYCO-2026-0023', 'MOV-CEYCO-2026-0024', 'MOV-CEYCO-2026-0025'];
    var movData = sheetMov.getRange(INV_MOV_DATA_ROW, 1,
      sheetMov.getLastRow() - INV_MOV_DATA_ROW + 1, 1).getValues();
    var filasABorrar = [];
    for (var m = 0; m < movData.length; m++) {
      if (aEliminar.indexOf(String(movData[m][0] || '').trim()) !== -1) {
        filasABorrar.push(INV_MOV_DATA_ROW + m);
        Logger.log('  🗑️  MOV a borrar: ' + movData[m][0]);
      }
    }
    for (var j = filasABorrar.length - 1; j >= 0; j--) {
      sheetMov.deleteRow(filasABorrar[j]);
    }
    Logger.log('  ✅ ' + filasABorrar.length + ' movimiento(s) de reversion_cancelacion borrados');
  }

  SpreadsheetApp.flush();
  Logger.log('✅ Limpieza NC114 completada');
}

function limpiarMovDuplicados516() {
  var ss       = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheetMov = ss.getSheetByName(SHEET_INV_MOV);
  if (!sheetMov || sheetMov.getLastRow() < INV_MOV_DATA_ROW) {
    Logger.log('❌ Hoja Inv_Movimientos no encontrada o vacía'); return;
  }

  var duplicados = ['MOV-CEYCO-2026-0026', 'MOV-CEYCO-2026-0027', 'MOV-CEYCO-2026-0028'];
  var data = sheetMov.getRange(INV_MOV_DATA_ROW, 1,
    sheetMov.getLastRow() - INV_MOV_DATA_ROW + 1, 1).getValues();

  var filasABorrar = [];
  for (var i = 0; i < data.length; i++) {
    if (duplicados.indexOf(String(data[i][0] || '').trim()) !== -1) {
      filasABorrar.push(INV_MOV_DATA_ROW + i);
      Logger.log('  🗑️  ' + data[i][0]);
    }
  }

  if (filasABorrar.length === 0) {
    Logger.log('✅ No se encontraron duplicados — ya fue ejecutada o no aplica'); return;
  }

  // Borrar de abajo hacia arriba para no desplazar índices
  for (var j = filasABorrar.length - 1; j >= 0; j--) {
    sheetMov.deleteRow(filasABorrar[j]);
  }
  SpreadsheetApp.flush();
  Logger.log('✅ ' + filasABorrar.length + ' movimiento(s) duplicado(s) borrado(s). Stock corregido automáticamente via fórmula.');
}


function dryRunFACT517()     { limpiarYReimportarCarpeta('FEBRERO 2026', 'FACT517COCACOLA'); }
function ejecutarFACT517()   { limpiarYReimportarCarpeta('FEBRERO 2026', 'FACT517COCACOLA', true); }
function reimportarFACT517() { reimportarCarpeta('FEBRERO 2026', 'FACT517COCACOLA'); }

function dryRunFACT518()     { limpiarYReimportarCarpeta('FEBRERO 2026', 'FACT518RSVPSOLUTION'); }
function ejecutarFACT518()   { limpiarYReimportarCarpeta('FEBRERO 2026', 'FACT518RSVPSOLUTION', true); }
function reimportarFACT518() { reimportarCarpeta('FEBRERO 2026', 'FACT518RSVPSOLUTION'); }
function limpiarYReimportarFACT518() {
  limpiarYReimportarCarpeta('FEBRERO 2026', 'FACT518RSVPSOLUTION', true);
}

function dryRunFACT519()     { limpiarYReimportarCarpeta('FEBRERO 2026', 'FACT519ERSIGROUP PANAMA'); }
function ejecutarFACT519()   { limpiarYReimportarCarpeta('FEBRERO 2026', 'FACT519ERSIGROUP PANAMA', true); }
function reimportarFACT519() { reimportarCarpeta('FEBRERO 2026', 'FACT519ERSIGROUP PANAMA'); }

function dryRunFACT520()     { limpiarYReimportarCarpeta('FEBRERO 2026', 'FACT520HOSPITAL NACIONAL'); }
function ejecutarFACT520()   { limpiarYReimportarCarpeta('FEBRERO 2026', 'FACT520HOSPITAL NACIONAL', true); }
function reimportarFACT520() { reimportarCarpeta('FEBRERO 2026', 'FACT520HOSPITAL NACIONAL'); }

function dryRunFACT521()     { limpiarYReimportarCarpeta('FEBRERO 2026', 'FACT521SOFRATESA'); }
function ejecutarFACT521()   { limpiarYReimportarCarpeta('FEBRERO 2026', 'FACT521SOFRATESA', true); }
function reimportarFACT521() { reimportarCarpeta('FEBRERO 2026', 'FACT521SOFRATESA'); }


// ═══════════════════════════════════════════════════════════════
//  WRAPPERS — MARZO 2026
//  13 carpetas: FACT522–FACT534 + NC 114
//
//  ⚠️  Notas especiales:
//    FACT 524 — nombre con espacio entre FACT y 524 (tal como está en Drive)
//    NC 114   — nota de crédito, se importa igual que una carpeta normal
// ═══════════════════════════════════════════════════════════════

function dryRunFACT522()     { limpiarYReimportarCarpeta('MARZO 2026', 'FACT522DISTRIBUIDORA VIKINGO'); }
function ejecutarFACT522()   { limpiarYReimportarCarpeta('MARZO 2026', 'FACT522DISTRIBUIDORA VIKINGO', true); }
function reimportarFACT522() { reimportarCarpeta('MARZO 2026', 'FACT522DISTRIBUIDORA VIKINGO'); }

function dryRunFACT523()     { limpiarYReimportarCarpeta('MARZO 2026', 'FACT523HOSPITAL NACIONAL'); }
function ejecutarFACT523()   { limpiarYReimportarCarpeta('MARZO 2026', 'FACT523HOSPITAL NACIONAL', true); }
function reimportarFACT523() { reimportarCarpeta('MARZO 2026', 'FACT523HOSPITAL NACIONAL'); }

// ⚠️  Nombre con espacio: "FACT 524..." (no "FACT524...")
function dryRunFACT524()     { limpiarYReimportarCarpeta('MARZO 2026', 'FACT 524EUSTORGIO GONZALEZ'); }
function ejecutarFACT524()   { limpiarYReimportarCarpeta('MARZO 2026', 'FACT 524EUSTORGIO GONZALEZ', true); }
function reimportarFACT524() { reimportarCarpeta('MARZO 2026', 'FACT 524EUSTORGIO GONZALEZ'); }

function dryRunFACT525()     { limpiarYReimportarCarpeta('MARZO 2026', 'FACT525KRILL ENERGY'); }
function ejecutarFACT525()   { limpiarYReimportarCarpeta('MARZO 2026', 'FACT525KRILL ENERGY', true); }
function reimportarFACT525() { reimportarCarpeta('MARZO 2026', 'FACT525KRILL ENERGY'); }

function dryRunFACT526()     { limpiarYReimportarCarpeta('MARZO 2026', 'FACT526TELECOM GROUP'); }
function ejecutarFACT526()   { limpiarYReimportarCarpeta('MARZO 2026', 'FACT526TELECOM GROUP', true); }
function reimportarFACT526() { reimportarCarpeta('MARZO 2026', 'FACT526TELECOM GROUP'); }

function dryRunNC114()       { limpiarYReimportarCarpeta('MARZO 2026', 'NC 114TELECOM GROUP'); }
function ejecutarNC114()     { limpiarYReimportarCarpeta('MARZO 2026', 'NC 114TELECOM GROUP', true); }
function reimportarNC114()   { reimportarCarpeta('MARZO 2026', 'NC 114TELECOM GROUP'); }

function dryRunFACT527()     { limpiarYReimportarCarpeta('MARZO 2026', 'FACT527TELECOM GROUP'); }
function ejecutarFACT527()   { limpiarYReimportarCarpeta('MARZO 2026', 'FACT527TELECOM GROUP', true); }
function reimportarFACT527() { reimportarCarpeta('MARZO 2026', 'FACT527TELECOM GROUP'); }

function dryRunFACT528()     { limpiarYReimportarCarpeta('MARZO 2026', 'FACT528CLEMENTE ENERGY'); }
function ejecutarFACT528()   { limpiarYReimportarCarpeta('MARZO 2026', 'FACT528CLEMENTE ENERGY', true); }
function reimportarFACT528() { reimportarCarpeta('MARZO 2026', 'FACT528CLEMENTE ENERGY'); }

function dryRunFACT529()     { limpiarYReimportarCarpeta('MARZO 2026', 'FACT529TUG SERVICES PANAMA'); }
function ejecutarFACT529()   { limpiarYReimportarCarpeta('MARZO 2026', 'FACT529TUG SERVICES PANAMA', true); }
function reimportarFACT529() { reimportarCarpeta('MARZO 2026', 'FACT529TUG SERVICES PANAMA'); }

function dryRunFACT530()     { limpiarYReimportarCarpeta('MARZO 2026', 'FACT530RAFAEL BARRIOS'); }
function ejecutarFACT530()   { limpiarYReimportarCarpeta('MARZO 2026', 'FACT530RAFAEL BARRIOS', true); }
function reimportarFACT530() { reimportarCarpeta('MARZO 2026', 'FACT530RAFAEL BARRIOS'); }

function dryRunFACT531()     { limpiarYReimportarCarpeta('MARZO 2026', 'FACT531EUSTORGIO GONZALEZ'); }
function ejecutarFACT531()   { limpiarYReimportarCarpeta('MARZO 2026', 'FACT531EUSTORGIO GONZALEZ', true); }
function reimportarFACT531() { reimportarCarpeta('MARZO 2026', 'FACT531EUSTORGIO GONZALEZ'); }

function dryRunFACT532()     { limpiarYReimportarCarpeta('MARZO 2026', 'FACT532TELECOM GROUP'); }
function ejecutarFACT532()   { limpiarYReimportarCarpeta('MARZO 2026', 'FACT532TELECOM GROUP', true); }
function reimportarFACT532() { reimportarCarpeta('MARZO 2026', 'FACT532TELECOM GROUP'); }

function dryRunFACT533()     { limpiarYReimportarCarpeta('MARZO 2026', 'FACT533COCACOLA'); }
function ejecutarFACT533()   { limpiarYReimportarCarpeta('MARZO 2026', 'FACT533COCACOLA', true); }
function reimportarFACT533() { reimportarCarpeta('MARZO 2026', 'FACT533COCACOLA'); }

function dryRunFACT534()     { limpiarYReimportarCarpeta('MARZO 2026', 'FACT534TAMEK'); }
function ejecutarFACT534()   { limpiarYReimportarCarpeta('MARZO 2026', 'FACT534TAMEK', true); }
function reimportarFACT534() { reimportarCarpeta('MARZO 2026', 'FACT534TAMEK'); }


// ═══════════════════════════════════════════════════════════════
//  _wrapAttachment  — v2.9L
//  Convierte un GmailAttachment en un objeto con la misma
//  interfaz que los DriveFile usados por el motor histórico:
//    .getUrl()       → url ya subida a Drive (pasada como parámetro)
//    .getBlob()      → blob del adjunto
//    .getMimeType()  → mime type
//    .getName()      → nombre del archivo
//    .getId()        → id único (generado internamente)
//
//  Esto permite que _clasificarArchivos, _parsearFacturaCeyco,
//  _parsearFacturaCosto y todo el motor funcionen sin cambios
//  cuando la fuente es un email en vez de una carpeta Drive.
// ═══════════════════════════════════════════════════════════════

function _wrapAttachment(att, driveUrl, index) {
  var blob     = Utilities.newBlob(att.getBytes(), att.getContentType(), att.getName());
  var nombre   = att.getName() || ('adjunto_' + index + '.pdf');
  var mime     = att.getContentType() || 'application/pdf';
  var fakeId   = 'EMAIL-ATT-' + index + '-' + Utilities.getUuid().replace(/-/g,'').slice(0,8);
  var url      = driveUrl || '';

  return {
    getUrl:      function() { return url; },
    getBlob:     function() { return blob; },
    getMimeType: function() { return mime; },
    getName:     function() { return nombre; },
    getId:       function() { return fakeId; },
  };
}

// ═══════════════════════════════════════════════════════════════
//  _procesarDesdeBlobs  — v2.9L
//  Motor compartido entre Drive (histórico) y Gmail (email ST).
//  Recibe la misma estructura que _procesarCarpetaFactura pero
//  con objetos ya wrapeados — sin acceso a DriveFolder.
//
//  Parámetros:
//    ss       — SpreadsheetApp.openById(...)
//    archivos — array de wrappers creados con _wrapAttachment()
//    mes      — string ej 'MARZO 2026' (para log)
//    contexto — string ej nombre de carpeta o asunto email (para notas ST)
//
//  Retorna el mismo objeto resultado que _procesarCarpetaFactura.
// ═══════════════════════════════════════════════════════════════

function _procesarDesdeBlobs(ss, archivos, mes, contexto) {
  var resultado = {
    id_st: '', num_factura: '', cliente: '',
    total_venta: 0, total_costo: 0,
    tipo_venta: '', tipo_costo: '',
    estado: 'error', ingreso_id: '',
    items_warning: '', error_msg: '',
  };

  if (!archivos || archivos.length === 0) {
    resultado.error_msg = 'Sin archivos procesables';
    return resultado;
  }

  // ── PASO 2: Clasificar con Claude Haiku ──────────────────────
  var clasificados = _clasificarArchivos(archivos);
  Logger.log('  🏷️  ceyco=' + (clasificados.factura_ceyco ? '✅' : '❌') +
             ' | nc=' + (clasificados.nota_credito ? '✅' : '❌') +
             ' | costos=' + clasificados.facturas_costo.length +
             ' | voucher=' + (clasificados.voucher ? '✅' : '❌'));

  // Desvío: nota de crédito
  if (clasificados.factura_ceyco && clasificados.nota_credito) {
    Logger.log('  📋 NC + factura detectadas — Escenario 1 (anulación sin despacho)');
    return _procesarNotaCredito(ss, clasificados, mes, resultado);
  }
  if (!clasificados.factura_ceyco && clasificados.nota_credito) {
    Logger.log('  🔄 NC sola detectada — derivando a Escenario 2 (despacho ya ocurrió)');
    return _procesarNotaCreditoEscenario2(ss, clasificados.nota_credito, mes, resultado);
  }

  if (!clasificados.factura_ceyco) {
    resultado.error_msg = 'No se encontró factura emitida por CEYCO';
    return resultado;
  }

  // ── PASO 3: Parsear factura CEYCO ────────────────────────────
  var datosCeyco = _parsearFacturaCeyco(clasificados.factura_ceyco);
  if (!datosCeyco || !datosCeyco.items || !datosCeyco.items.length) {
    resultado.error_msg = 'No se pudieron extraer ítems de la factura CEYCO';
    return resultado;
  }

  resultado.num_factura = datosCeyco.num_factura || '';
  resultado.cliente     = datosCeyco.nombre_cliente || '';
  resultado.total_venta = parseFloat(datosCeyco.total || '0') || 0;

  Logger.log('  📋 Factura: ' + resultado.num_factura + ' | ' + resultado.cliente +
             ' | $' + resultado.total_venta + ' | ' + datosCeyco.items.length + ' ítem(s)');

  if (_ingresoYaExiste(ss, resultado.num_factura, resultado.cliente)) {
    resultado.error_msg = 'DUPLICADO: Ingreso con factura "' + resultado.num_factura + '" ya existe';
    return resultado;
  }

  // ── PASO 4: Parsear facturas de costo ────────────────────────
  var facturasCostoParseadas = [];
  var _fVistos = {};
  for (var fc = 0; fc < clasificados.facturas_costo.length; fc++) {
    try {
      var datosCosto = _parsearFacturaCosto(clasificados.facturas_costo[fc]);
      if (datosCosto) {
        var _fProv = String(datosCosto.proveedor || '').trim().toUpperCase();
        var _fNum  = String(datosCosto.num_factura || '').trim();
        var _fKey  = _fProv + '||' + _fNum;
        if (_fNum && _fVistos[_fKey]) {
          Logger.log('  ⏭️  Factura duplicada omitida: ' + datosCosto.proveedor + ' | ' + _fNum);
        } else {
          if (_fNum) _fVistos[_fKey] = true;
          datosCosto._drive_url = clasificados.facturas_costo[fc].getUrl();
          facturasCostoParseadas.push({
            archivo: clasificados.facturas_costo[fc],
            datos:   datosCosto,
          });
          Logger.log('  💰 Costo: ' + datosCosto.proveedor + ' | $' + datosCosto.total +
                     ' | ' + (datosCosto.items || []).length + ' ítem(s)' +
                     (datosCosto.es_general ? ' [GENERAL]' : ''));
        }
      }
    } catch (parseErr) {
      Logger.log('  ⚠️  Error parseando factura de costo: ' + parseErr.message);
    }
    Utilities.sleep(500);
  }

  // ── PASO 5: Matching ítem-a-ítem ─────────────────────────────
  var matchResults = _matchearItems(datosCeyco.items, facturasCostoParseadas, ss);

  // ── PASO 6: Totales y tipo de venta ──────────────────────────
  var totalCostoItems = 0;
  var tiposVenta = {};
  var codigosWarning = [];
  matchResults.items.forEach(function(item) {
    totalCostoItems += item.costo_total || 0;
    tiposVenta[item.tipo_costo] = true;
    if (item.tipo_costo === 'warning') codigosWarning.push(item.codigo || item.descripcion);
  });
  resultado.total_costo = parseFloat(totalCostoItems.toFixed(2));
  matchResults.costos_generales.forEach(function(cg) {
    resultado.total_costo += parseFloat(cg.datos.total || '0') || 0;
  });
  resultado.total_costo = parseFloat(resultado.total_costo.toFixed(2));

  if (tiposVenta['warning'] && !tiposVenta['venta_directa'] && !tiposVenta['venta_inventario']) {
    resultado.tipo_venta = 'warning';
  } else if (tiposVenta['venta_directa'] && !tiposVenta['venta_inventario']) {
    resultado.tipo_venta = 'venta_directa';
  } else if (tiposVenta['venta_inventario'] && !tiposVenta['venta_directa']) {
    resultado.tipo_venta = 'venta_inventario';
  } else {
    resultado.tipo_venta = tiposVenta['warning'] ? 'warning' : 'mixta';
  }
  resultado.tipo_costo    = facturasCostoParseadas.map(function(f){ return f.datos.proveedor; }).join(', ') || 'inventario';
  resultado.items_warning = codigosWarning.join(', ');

  // ── PASO 7: Crear ST ─────────────────────────────────────────
  var ahora      = new Date();
  var fechaFactu = datosCeyco.fecha ||
    Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd');
  var fechaDate  = new Date(fechaFactu + 'T12:00:00');
  var mesST      = isNaN(fechaDate.getTime()) ? ahora.getMonth()+1 : fechaDate.getMonth()+1;
  var anioST     = isNaN(fechaDate.getTime()) ? ahora.getFullYear() : fechaDate.getFullYear();

  var sheetST    = ss.getSheetByName(SHEET_ST)    || _initServiciosTecnicosSheet(ss);
  var sheetSTI   = ss.getSheetByName(SHEET_ST_ITEM)|| _initSTItemsSheet(ss);
  var seqData    = _nextSTSeq(ss);
  var idST       = 'ST-RP-' + seqData.anio + '-' + String(seqData.seq).padStart(4, '0');
  var driveUrlFact = clasificados.factura_ceyco.getUrl();
  var margenCalc   = (resultado.total_venta > 0 && resultado.total_costo > 0)
    ? parseFloat(((resultado.total_venta / resultado.total_costo - 1) * 100).toFixed(2)) : 0;
  var fechaReg = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');

  var notaST = 'Procesado desde email | Mes: ' + mes + ' | ' + contexto +
               ' | Tipo venta: ' + resultado.tipo_venta;
  if (codigosWarning.length) notaST += ' | ⚠️ SIN COSTO: ' + resultado.items_warning;

  var tieneVoucher = !!clasificados.voucher;

  var filaST = new Array(ST_NCOLS);
  for (var xs = 0; xs < ST_NCOLS; xs++) filaST[xs] = '';
  filaST[COL_ST.ID - 1]              = idST;
  filaST[COL_ST.FECHA_REG - 1]       = fechaReg;
  filaST[COL_ST.ESTADO - 1]          = tieneVoucher ? 'cerrado' : 'en_ejecucion';
  // NUM_COT: número de factura real si existe, sino correlativo
  var numCotST = resultado.num_factura
    ? 'FACT ' + String(resultado.num_factura).replace(/^0+/, '')
    : 'COT-RP-' + seqData.anio + '-' + String(seqData.seq).padStart(4, '0');
  filaST[COL_ST.NUM_COT - 1]         = numCotST;
  filaST[COL_ST.NOMBRE_CLI - 1]      = datosCeyco.nombre_cliente || '';
  filaST[COL_ST.RUC_CLI - 1]         = datosCeyco.ruc_cliente    || '';
  filaST[COL_ST.DV_CLI - 1]          = datosCeyco.dv_cliente     || '';
  filaST[COL_ST.DESCRIPCION - 1]     = datosCeyco.descripcion    || datosCeyco.items[0].descripcion || '';
  filaST[COL_ST.TOTAL_COSTO_COT - 1] = resultado.total_costo || '';
  filaST[COL_ST.TOTAL_COSTO_REAL - 1]= resultado.total_costo || '';
  filaST[COL_ST.MARGEN_PCT - 1]      = margenCalc || '';
  filaST[COL_ST.PRECIO_VENTA - 1]    = resultado.total_venta || '';
  filaST[COL_ST.DRIVE_URL - 1]       = driveUrlFact;
  filaST[COL_ST.FECHA_CIERRE - 1]    = tieneVoucher ? fechaFactu : '';
  filaST[COL_ST.MES - 1]             = mesST;
  filaST[COL_ST.ANIO - 1]            = anioST;
  filaST[COL_ST.NOTAS - 1]           = notaST;

  var newSTRow = sheetST.getLastRow() + 1;
  sheetST.getRange(newSTRow, 1, 1, ST_NCOLS).setValues([filaST]);
  sheetST.getRange(newSTRow, COL_ST.TOTAL_COSTO_COT, 1, 3).setNumberFormat('#,##0.00');
  var bgST = resultado.tipo_venta === 'warning'          ? '#FFEBEE' :
             resultado.tipo_venta === 'venta_inventario' ? '#E3F2FD' :
             tieneVoucher                                ? '#F1F8E9' : '#F3E5F5';
  sheetST.getRange(newSTRow, 1, 1, ST_NCOLS).setBackground(bgST);
  resultado.id_st = idST;

  // ── PASO 8: Egresos y ST_Items por ítem ──────────────────────
  var seqItemCounter = 0;
  matchResults.items.forEach(function(itemMatch) {
    seqItemCounter++;
    var egresoId = null;
    var idItemST = 'STI-RP-' + Utilities.formatDate(ahora, 'America/Panama', 'yyyyMMddHHmmss') + '-' + seqItemCounter;
    itemMatch._id_st_item = idItemST;
    if (itemMatch.tipo_costo === 'venta_directa' && itemMatch.factura_costo_datos) {
      if (itemMatch.es_envio) {
        egresoId = _crearEgresoEnvio(ss, idST, itemMatch, ahora, fechaFactu);
      } else {
        egresoId = _crearEgresoItem(ss, idST, itemMatch, ahora, fechaFactu);
      }
    } else if (itemMatch.tipo_costo === 'venta_inventario' && itemMatch.inv_item) {
      egresoId = _crearEgresoInventario(ss, idST, itemMatch, ahora, fechaFactu, resultado.num_factura);
    }
    _crearSTItem(sheetSTI, idST, seqItemCounter, itemMatch, egresoId, ahora, idItemST);
  });

  // ── PASO 9: Costos generales + crédito fiscal ─────────────────
  matchResults.costos_generales.forEach(function(cg) {
    seqItemCounter++;
    var idItemSTGen = 'STI-RP-' + Utilities.formatDate(ahora, 'America/Panama', 'yyyyMMddHHmmss') + '-' + seqItemCounter;
    var egresoGenId = _crearEgresoGeneral(ss, idST, cg.datos, cg.archivo.getUrl(), ahora, fechaFactu, idItemSTGen);
    _crearSTItemGeneral(sheetSTI, idST, seqItemCounter, cg.datos, egresoGenId, ahora, idItemSTGen);
    Logger.log('  💸 Costo general: ' + cg.datos.proveedor + ' $' + cg.datos.total);
    var itbmCredito = parseFloat(cg.datos._itbm_credito || '0') || 0;
    if (itbmCredito > 0) {
      seqItemCounter++;
      var idItemSTCred = 'STI-RP-' + Utilities.formatDate(ahora, 'America/Panama', 'yyyyMMddHHmmss') + '-' + seqItemCounter;
      var egresoCreditoId = _crearEgresoCreditoFiscal(ss, idST, cg.datos, itbmCredito, cg.archivo.getUrl(), ahora, fechaFactu, idItemSTCred);
      _crearSTItemCreditoFiscal(sheetSTI, idST, seqItemCounter, cg.datos, itbmCredito, egresoCreditoId, ahora, idItemSTCred);
      Logger.log('  💳 Crédito fiscal ITBM: ' + cg.datos.proveedor + ' $' + itbmCredito);
    }
  });

  // ── PASO 10: Ingreso ──────────────────────────────────────────
  var sheetIng = ss.getSheetByName(CONFIG.SHEET_INGRESOS);
  if (!sheetIng) throw new Error('Hoja Ingresos no encontrada');

  var precioVenta = resultado.total_venta;
  // FIX: usar subtotal e ITBMS ya extraídos por Claude (soporta facturas mixtas gravado/exento).
  // El cálculo total/1.07 asume 100% gravado y falla cuando hay ítems (A) + (E) mezclados.
  var tieneItbms  = datosCeyco.tiene_itbms !== false;
  var subtotalIng = parseFloat(datosCeyco.subtotal || '0') || 0;
  var itbmsIng    = parseFloat(datosCeyco.itbms    || '0') || 0;
  if (subtotalIng === 0 && precioVenta > 0) {
    // Fallback solo si Claude no extrajo subtotal
    subtotalIng = tieneItbms ? parseFloat((precioVenta / 1.07).toFixed(2)) : precioVenta;
    itbmsIng    = tieneItbms ? parseFloat((precioVenta - subtotalIng).toFixed(2)) : 0;
  }

  var idIng = 'ING-RP-' + Utilities.formatDate(ahora, 'America/Panama', 'yyyyMMddHHmmss') +
              '-ST-' + String(seqData.seq).padStart(4, '0');
  var estadoIng = tieneVoucher ? 'confirmado' : 'pendiente';

  var filaIng = new Array(INGRESOS_NCOLS);
  for (var xi = 0; xi < INGRESOS_NCOLS; xi++) filaIng[xi] = '';
  filaIng[COL_I.ID_TRANS - 1]      = idIng;
  filaIng[COL_I.FECHA_REG - 1]     = fechaReg;
  filaIng[COL_I.ESTADO - 1]        = estadoIng;
  filaIng[COL_I.CONFIANZA_IA - 1]  = 'ia_email';
  filaIng[COL_I.FECHA_INGRESO - 1] = fechaFactu;
  filaIng[COL_I.MES - 1]           = mesST;
  filaIng[COL_I.ANIO_FISCAL - 1]   = anioST;
  filaIng[COL_I.SUBTOTAL - 1]      = subtotalIng;
  filaIng[COL_I.ITBMS - 1]         = itbmsIng;
  filaIng[COL_I.TOTAL - 1]         = precioVenta;
  filaIng[COL_I.MONEDA - 1]        = 'USD';
  filaIng[COL_I.TIPO_INGRESO - 1]  = 'venta_producto';
  filaIng[COL_I.CATEGORIA - 1]     = tieneItbms ? 'venta_producto_gravado' : 'venta_producto_exento';
  filaIng[COL_I.NOMBRE_CLI - 1]    = datosCeyco.nombre_cliente || '';
  filaIng[COL_I.RUC_CLI - 1]       = datosCeyco.ruc_cliente    || '';
  filaIng[COL_I.TIPO_PERSONA - 1]  = detectarTipoPersona(String(datosCeyco.ruc_cliente || ''));
  filaIng[COL_I.NUM_FACTURA - 1]   = datosCeyco.num_factura    || '';
  filaIng[COL_I.TIPO_COMP - 1]     = 'factura_emitida';
  filaIng[COL_I.DRIVE_URL - 1]     = driveUrlFact;
  filaIng[COL_I.DESCRIPCION - 1]   = datosCeyco.descripcion    || datosCeyco.items[0].descripcion || '';
  filaIng[COL_I.NOTAS_INT - 1]     = 'ST: ' + idST + ' | Email: ' + mes + ' | ' + contexto +
                                      ' | Tipo: ' + resultado.tipo_venta +
                                      (codigosWarning.length ? ' | ⚠️ ' + resultado.items_warning : '');
  filaIng[COL_I.FLAG_REV - 1]      = resultado.tipo_venta === 'warning';
  filaIng[COL_I.DV_CLI - 1]        = datosCeyco.dv_cliente || '';

  var newIngRow = sheetIng.getLastRow() + 1;
  sheetIng.getRange(newIngRow, 1, 1, INGRESOS_NCOLS).setValues([filaIng]);
  sheetIng.getRange(newIngRow, COL_I.SUBTOTAL, 1, 3).setNumberFormat('#,##0.00');
  var bgIng = resultado.tipo_venta === 'warning' ? '#FFEBEE' :
              estadoIng === 'confirmado'          ? '#F1F8E9' : '#FFF3E0';
  sheetIng.getRange(newIngRow, 1, 1, INGRESOS_NCOLS).setBackground(bgIng);
  resultado.ingreso_id = idIng;

  sheetST.getRange(newSTRow, COL_ST.INGRESO_ID).setValue(idIng);

  // Voucher: anotar en notas del ST e ingreso
  if (tieneVoucher) {
    var driveUrlVoucher = clasificados.voucher.getUrl();
    sheetIng.getRange(newIngRow, COL_I.DRIVE_URL).setValue(driveUrlVoucher);
    var notaActST = String(sheetST.getRange(newSTRow, COL_ST.NOTAS).getValue() || '');
    sheetST.getRange(newSTRow, COL_ST.NOTAS).setValue(notaActST + ' | Voucher: ' + driveUrlVoucher);
    resultado.estado = codigosWarning.length ? 'warning' : 'completo';
  } else {
    resultado.estado = codigosWarning.length ? 'warning' : 'sin_voucher';
  }

  Logger.log('  ✅ ST: ' + idST + ' | ING: ' + idIng + ' | tipo: ' + resultado.tipo_venta);
  return resultado;
}
