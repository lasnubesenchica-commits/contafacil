// ═══════════════════════════════════════════════════════════════
//  ContaFacil_Planilla.gs  —  v1.0
//  Módulo de Planilla para CEYCO
//
//  Hojas:
//    Empleados  — catálogo de empleados (creada automáticamente)
//    Egresos    — donde se registran los pagos (hoja existente)
//
//  Acciones doGet:
//    getEmpleados           → lista catálogo completo
//    getPlanillaPreview     → calcula quincena con deducciones
//
//  Acciones doPost:
//    guardarEmpleado        → crea o actualiza empleado
//    registrarPlanilla      → registra quincena como egresos en lote
//    desactivarEmpleado     → marca empleado como inactivo
//
//  Constantes fiscales Panamá (2024):
//    CSS Patronal  : 12.25% sobre salario bruto
//    CSS Empleado  : 9.75%  sobre salario bruto
//    ISR Persona Natural (método gradual, Art. 700 Código Fiscal):
//      Hasta B/.11,000/año          → 0%
//      B/.11,001 – B/.50,000/año   → 15% sobre exceso de B/.11,000
//      Más de B/.50,000/año        → B/.5,850 + 25% sobre exceso de B/.50,000
// ═══════════════════════════════════════════════════════════════

var SHEET_EMPLEADOS   = 'Empleados';
var EMP_NCOLS         = 14;  // número de columnas de la hoja Empleados

// Mapa de columnas — base 1
var COL_EMP = {
  ID:            1,  // A  id_empleado  (EMP-001)
  FECHA_REG:     2,  // B  fecha_registro
  ESTADO:        3,  // C  activo | inactivo
  NOMBRE:        4,  // D  nombre completo
  CEDULA:        5,  // E  cédula / pasaporte
  CARGO:         6,  // F  cargo / puesto
  TIPO:          7,  // G  fijo | variable
  SALARIO_BASE:  8,  // H  salario mensual bruto base
  APLICA_ISR:    9,  // I  TRUE | FALSE
  BANCO:        10,  // J  banco de pago
  CUENTA:       11,  // K  número de cuenta
  NOTAS:        12,  // L  notas adicionales
  FECHA_INI:    13,  // M  fecha inicio labores
  FECHA_FIN:    14,  // N  fecha fin (si inactivo)
};

// Constantes CSS Panamá
var CSS_PATRONAL  = 0.1225;  // 12.25%
var CSS_EMPLEADO  = 0.0975;  // 9.75%

// ── Inicializar hoja Empleados ────────────────────
function _initEmpleadosSheet(ss) {
  var existing = ss.getSheetByName(SHEET_EMPLEADOS);
  if (existing) return existing;

  var sheet = ss.insertSheet(SHEET_EMPLEADOS);
  SpreadsheetApp.flush();

  var meta = [
    'METADATA','','','DATOS PERSONALES','','','CONTRATO','','','PAGO','','NOTAS','VIGENCIA',''
  ];
  var headers = [
    'id_empleado','fecha_registro','estado',
    'nombre','cedula','cargo',
    'tipo','salario_base','aplica_isr',
    'banco','cuenta',
    'notas',
    'fecha_inicio','fecha_fin'
  ];

  sheet.getRange(1, 1, 1, EMP_NCOLS).setValues([meta])
    .setBackground('#1a2535').setFontColor('#ffffff').setFontWeight('bold');
  sheet.getRange(2, 1, 1, EMP_NCOLS).setValues([headers])
    .setBackground('#37474F').setFontColor('#ffffff').setFontWeight('bold');
  sheet.setFrozenRows(2);

  var widths = [100,130,80,200,120,150,70,110,90,120,140,200,110,110];
  for (var i = 0; i < widths.length; i++) sheet.setColumnWidth(i+1, widths[i]);
  sheet.getRange('H3:H1000').setNumberFormat('#,##0.00');

  // Validación tipo
  var tipoRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['fijo','variable'], true).build();
  sheet.getRange('G3:G1000').setDataValidation(tipoRule);

  // Validación estado
  var estRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['activo','inactivo'], true).build();
  sheet.getRange('C3:C1000').setDataValidation(estRule);

  // Validación aplica_isr
  var isrRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['TRUE','FALSE'], true).build();
  sheet.getRange('I3:I1000').setDataValidation(isrRule);

  Logger.log('✅ Hoja Empleados creada.');
  return sheet;
}

// ── Cálculo de deducciones ────────────────────────
// salarioQuincenal = salario mensual / 2
// CSS se calcula sobre el bruto quincenal
// ISR se calcula mensual y se divide en 2 para la quincena
function _calcularDeducciones(salarioMensual, aplicaIsr) {
  var brutoQuincenal  = parseFloat((salarioMensual / 2).toFixed(2));
  var cssPatronal     = parseFloat((brutoQuincenal * CSS_PATRONAL).toFixed(2));
  var cssEmpleado     = parseFloat((brutoQuincenal * CSS_EMPLEADO).toFixed(2));

  // ISR mensual (método gradual Art. 700)
  var isrMensual = 0;
  if (aplicaIsr) {
    var anual = salarioMensual * 12;
    var isrAnual = 0;
    if (anual <= 11000) {
      isrAnual = 0;
    } else if (anual <= 50000) {
      isrAnual = (anual - 11000) * 0.15;
    } else {
      isrAnual = 5850 + (anual - 50000) * 0.25;
    }
    isrMensual = parseFloat((isrAnual / 12).toFixed(2));
  }
  var isrQuincenal = parseFloat((isrMensual / 2).toFixed(2));

  var totalDeducciones = parseFloat((cssEmpleado + isrQuincenal).toFixed(2));
  var netoAPagar       = parseFloat((brutoQuincenal - totalDeducciones).toFixed(2));

  return {
    bruto_quincenal:  brutoQuincenal,
    css_patronal:     cssPatronal,
    css_empleado:     cssEmpleado,
    isr_quincenal:    isrQuincenal,
    total_deducciones:totalDeducciones,
    neto_a_pagar:     netoAPagar,
    // Costo total para la empresa = bruto + patronal
    costo_empresa:    parseFloat((brutoQuincenal + cssPatronal).toFixed(2)),
  };
}

// ── getEmpleados ──────────────────────────────────
function _handleGetEmpleados(params, callback) {
  var result = { success: false, items: [], error: null };
  try {
    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = _initEmpleadosSheet(ss);

    if (sheet.getLastRow() <= 2) {
      result.success = true;
      return _jsonp(result, callback);
    }

    var numRows = sheet.getLastRow() - 2;
    var data    = sheet.getRange(3, 1, numRows, EMP_NCOLS).getValues();
    var items   = [];

    for (var i = 0; i < data.length; i++) {
      var r = data[i];
      if (!r[COL_EMP.ID - 1]) continue;

      var fechaReg = r[COL_EMP.FECHA_REG - 1];
      if (fechaReg instanceof Date) {
        fechaReg = Utilities.formatDate(fechaReg, 'America/Panama', 'yyyy-MM-dd');
      }
      var fechaIni = r[COL_EMP.FECHA_INI - 1];
      if (fechaIni instanceof Date) {
        fechaIni = Utilities.formatDate(fechaIni, 'America/Panama', 'yyyy-MM-dd');
      }
      var fechaFin = r[COL_EMP.FECHA_FIN - 1];
      if (fechaFin instanceof Date) {
        fechaFin = Utilities.formatDate(fechaFin, 'America/Panama', 'yyyy-MM-dd');
      }

      var salario    = parseFloat(r[COL_EMP.SALARIO_BASE - 1] || 0) || 0;
      var aplicaIsr  = String(r[COL_EMP.APLICA_ISR - 1] || '').toUpperCase() === 'TRUE';
      var deducciones = _calcularDeducciones(salario, aplicaIsr);

      items.push({
        id_empleado:   r[COL_EMP.ID - 1],
        fecha_reg:     fechaReg,
        estado:        String(r[COL_EMP.ESTADO - 1]  || 'activo').toLowerCase(),
        nombre:        r[COL_EMP.NOMBRE - 1]         || '',
        cedula:        r[COL_EMP.CEDULA - 1]         || '',
        cargo:         r[COL_EMP.CARGO - 1]          || '',
        tipo:          String(r[COL_EMP.TIPO - 1]    || 'fijo').toLowerCase(),
        salario_base:  salario,
        aplica_isr:    aplicaIsr,
        banco:         r[COL_EMP.BANCO - 1]          || '',
        cuenta:        r[COL_EMP.CUENTA - 1]         || '',
        notas:         r[COL_EMP.NOTAS - 1]          || '',
        fecha_inicio:  fechaIni,
        fecha_fin:     fechaFin || '',
        // Cálculos precalculados para la UI
        deducciones:   deducciones,
        _row:          i + 3,
      });
    }

    result.success = true;
    result.items   = items;
  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleGetEmpleados: ' + err.message);
  }
  return _jsonp(result, callback);
}

// ── getPlanillaPreview ────────────────────────────
// Genera vista previa de quincena con salarios ajustados
// params.ajustes = JSON [{id_empleado, salario_override}]
function _handleGetPlanillaPreview(params, callback) {
  var result = { success: false, resumen: null, empleados: [], error: null };
  try {
    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = _initEmpleadosSheet(ss);

    if (sheet.getLastRow() <= 2) {
      result.success = true;
      return _jsonp(result, callback);
    }

    // Parsear ajustes de salario variable
    var ajustesMap = {};
    try {
      var ajustes = JSON.parse(params.ajustes || '[]');
      ajustes.forEach(function(a) {
        if (a.id_empleado) ajustesMap[a.id_empleado] = parseFloat(a.salario_override) || null;
      });
    } catch(e) {}

    var numRows = sheet.getLastRow() - 2;
    var data    = sheet.getRange(3, 1, numRows, EMP_NCOLS).getValues();
    var empleados = [];
    var totBruto = 0, totCssPatronal = 0, totCssEmp = 0, totIsr = 0, totNeto = 0, totCostoEmpresa = 0;

    for (var i = 0; i < data.length; i++) {
      var r = data[i];
      if (!r[COL_EMP.ID - 1]) continue;
      if (String(r[COL_EMP.ESTADO - 1] || '').toLowerCase() !== 'activo') continue;

      var idEmp     = String(r[COL_EMP.ID - 1]);
      var salario   = ajustesMap[idEmp] !== undefined && ajustesMap[idEmp] !== null
        ? ajustesMap[idEmp]
        : (parseFloat(r[COL_EMP.SALARIO_BASE - 1] || 0) || 0);
      var aplicaIsr = String(r[COL_EMP.APLICA_ISR - 1] || '').toUpperCase() === 'TRUE';
      var ded       = _calcularDeducciones(salario, aplicaIsr);

      totBruto        += ded.bruto_quincenal;
      totCssPatronal  += ded.css_patronal;
      totCssEmp       += ded.css_empleado;
      totIsr          += ded.isr_quincenal;
      totNeto         += ded.neto_a_pagar;
      totCostoEmpresa += ded.costo_empresa;

      empleados.push({
        id_empleado:     idEmp,
        nombre:          r[COL_EMP.NOMBRE - 1]     || '',
        cargo:           r[COL_EMP.CARGO - 1]       || '',
        tipo:            String(r[COL_EMP.TIPO - 1] || 'fijo').toLowerCase(),
        salario_mensual: salario,
        aplica_isr:      aplicaIsr,
        banco:           r[COL_EMP.BANCO - 1]       || '',
        cuenta:          r[COL_EMP.CUENTA - 1]      || '',
        deducciones:     ded,
      });
    }

    result.success  = true;
    result.empleados = empleados;
    result.resumen  = {
      total_empleados:   empleados.length,
      total_bruto:       parseFloat(totBruto.toFixed(2)),
      total_css_patronal:parseFloat(totCssPatronal.toFixed(2)),
      total_css_empleado:parseFloat(totCssEmp.toFixed(2)),
      total_isr:         parseFloat(totIsr.toFixed(2)),
      total_neto:        parseFloat(totNeto.toFixed(2)),
      costo_empresa:     parseFloat(totCostoEmpresa.toFixed(2)),
    };
  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleGetPlanillaPreview: ' + err.message);
  }
  return _jsonp(result, callback);
}

// ── guardarEmpleado (POST) ────────────────────────
function _handleGuardarEmpleado(data) {
  var result = { success: false, id_empleado: null, error: null };
  try {
    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = _initEmpleadosSheet(ss);
    var ahora = new Date();
    var hoy   = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd');

    var idEmp = String(data.id_empleado || '').trim();

    if (idEmp) {
      // ── Actualizar existente ──
      var numRows = sheet.getLastRow() - 2;
      if (numRows <= 0) throw new Error('Empleado no encontrado: ' + idEmp);
      var ids = sheet.getRange(3, COL_EMP.ID, numRows, 1).getValues();
      var rowNum = -1;
      for (var k = 0; k < ids.length; k++) {
        if (String(ids[k][0]).trim() === idEmp) { rowNum = k + 3; break; }
      }
      if (rowNum === -1) throw new Error('Empleado no encontrado: ' + idEmp);

      sheet.getRange(rowNum, COL_EMP.ESTADO,       1, 1).setValue(data.estado || 'activo');
      sheet.getRange(rowNum, COL_EMP.NOMBRE,        1, 1).setValue(data.nombre || '');
      sheet.getRange(rowNum, COL_EMP.CEDULA,        1, 1).setValue(data.cedula || '');
      sheet.getRange(rowNum, COL_EMP.CARGO,         1, 1).setValue(data.cargo || '');
      sheet.getRange(rowNum, COL_EMP.TIPO,          1, 1).setValue(data.tipo || 'fijo');
      sheet.getRange(rowNum, COL_EMP.SALARIO_BASE,  1, 1).setValue(parseFloat(data.salario_base) || 0);
      sheet.getRange(rowNum, COL_EMP.APLICA_ISR,    1, 1).setValue(data.aplica_isr ? 'TRUE' : 'FALSE');
      sheet.getRange(rowNum, COL_EMP.BANCO,         1, 1).setValue(data.banco || '');
      sheet.getRange(rowNum, COL_EMP.CUENTA,        1, 1).setValue(data.cuenta || '');
      sheet.getRange(rowNum, COL_EMP.NOTAS,         1, 1).setValue(data.notas || '');
      if (data.fecha_inicio) sheet.getRange(rowNum, COL_EMP.FECHA_INI, 1, 1).setValue(data.fecha_inicio);
      if (data.fecha_fin)    sheet.getRange(rowNum, COL_EMP.FECHA_FIN, 1, 1).setValue(data.fecha_fin);

      SpreadsheetApp.flush();
      result.success    = true;
      result.id_empleado = idEmp;

    } else {
      // ── Crear nuevo ──
      var lastRow = sheet.getLastRow();
      var seq     = 1;
      if (lastRow > 2) {
        var existIds = sheet.getRange(3, COL_EMP.ID, lastRow - 2, 1).getValues();
        for (var m = existIds.length - 1; m >= 0; m--) {
          var v = String(existIds[m][0] || '');
          if (v.indexOf('EMP-') === 0) {
            var n = parseInt(v.replace('EMP-', ''), 10);
            if (!isNaN(n)) { seq = n + 1; break; }
          }
        }
      }
      idEmp = 'EMP-' + String(seq).padStart(3, '0');

      var fila = new Array(EMP_NCOLS);
      for (var x = 0; x < EMP_NCOLS; x++) fila[x] = '';
      fila[COL_EMP.ID           - 1] = idEmp;
      fila[COL_EMP.FECHA_REG    - 1] = hoy;
      fila[COL_EMP.ESTADO       - 1] = 'activo';
      fila[COL_EMP.NOMBRE       - 1] = data.nombre        || '';
      fila[COL_EMP.CEDULA       - 1] = data.cedula        || '';
      fila[COL_EMP.CARGO        - 1] = data.cargo         || '';
      fila[COL_EMP.TIPO         - 1] = data.tipo          || 'fijo';
      fila[COL_EMP.SALARIO_BASE - 1] = parseFloat(data.salario_base) || 0;
      fila[COL_EMP.APLICA_ISR  - 1] = data.aplica_isr ? 'TRUE' : 'FALSE';
      fila[COL_EMP.BANCO        - 1] = data.banco         || '';
      fila[COL_EMP.CUENTA       - 1] = data.cuenta        || '';
      fila[COL_EMP.NOTAS        - 1] = data.notas         || '';
      fila[COL_EMP.FECHA_INI    - 1] = data.fecha_inicio  || hoy;

      sheet.appendRow(fila);
      sheet.getRange(sheet.getLastRow(), 1).setBackground('#F1F8E9');
      SpreadsheetApp.flush();
      result.success    = true;
      result.id_empleado = idEmp;
      Logger.log('✅ Empleado creado: ' + idEmp + ' — ' + data.nombre);
    }
  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleGuardarEmpleado: ' + err.message);
  }
  return _json(result);
}

// ── registrarPlanilla (POST) ──────────────────────
// Registra una quincena completa como egresos en lote
// data.periodo     = '2026-Q1-1' (año-quincena)
// data.fecha_pago  = 'YYYY-MM-DD'
// data.empleados   = [{id_empleado, nombre, salario_mensual, deducciones:{...}}]
// data.notas       = string
function _handleRegistrarPlanilla(data) {
  var result = { success: false, egresos_ids: [], error: null };
  try {
    var ss        = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheetEgr  = _initEgresosSheet(ss);
    var ahora     = new Date();
    var fechaReg  = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
    var fechaPago = data.fecha_pago || Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd');
    var year      = new Date(fechaPago + 'T12:00:00').getFullYear();
    var mes       = new Date(fechaPago + 'T12:00:00').getMonth() + 1;
    var periodo   = String(data.periodo || '').trim();
    var notasBase = 'Planilla ' + periodo + (data.notas ? ' | ' + data.notas : '');

    // Obtener siguiente secuencia de egreso
    var lastRow = sheetEgr.getLastRow();
    var seq     = 1;
    if (lastRow > 2) {
      var ids = sheetEgr.getRange(3, COL_E.ID, lastRow - 2, 1).getValues();
      for (var k = ids.length - 1; k >= 0; k--) {
        var v = String(ids[k][0] || '');
        if (v.indexOf('EGR-RP-') === 0) {
          var parts = v.split('-');
          var n = parseInt(parts[parts.length - 1], 10);
          if (!isNaN(n)) { seq = n + 1; break; }
        }
      }
    }

    var empleados = data.empleados || [];
    var eIds = [];

    for (var i = 0; i < empleados.length; i++) {
      var emp = empleados[i];
      var ded = emp.deducciones || {};

      var bruto      = parseFloat(ded.bruto_quincenal  || 0);
      var cssPatr    = parseFloat(ded.css_patronal      || 0);
      var cssEmpDed  = parseFloat(ded.css_empleado      || 0);
      var isrDed     = parseFloat(ded.isr_quincenal     || 0);
      var neto       = parseFloat(ded.neto_a_pagar      || 0);
      var costoEmp   = parseFloat(ded.costo_empresa     || bruto + cssPatr);

      var egresoId   = 'EGR-RP-' + year + '-' + String(seq).padStart(4, '0');
      seq++;

      // Descripción del egreso
      var desc = emp.nombre + ' — ' + emp.cargo + ' | Quincena ' + periodo;
      var notas = notasBase +
        ' | CSS patronal: B/.' + cssPatr.toFixed(2) +
        ' | CSS empleado: B/.' + cssEmpDed.toFixed(2) +
        (isrDed > 0 ? ' | ISR: B/.' + isrDed.toFixed(2) : '') +
        ' | Neto pagado: B/.' + neto.toFixed(2) +
        (emp.banco   ? ' | Banco: ' + emp.banco   : '') +
        (emp.cuenta  ? ' | Cta: ' + emp.cuenta    : '');

      var fila = new Array(EGRESOS_NCOLS);
      for (var x = 0; x < EGRESOS_NCOLS; x++) fila[x] = '';

      fila[COL_E.ID          - 1] = egresoId;
      fila[COL_E.FECHA_REG   - 1] = fechaReg;
      fila[COL_E.ESTADO      - 1] = 'registrado';
      fila[COL_E.FECHA_GASTO - 1] = fechaPago;
      fila[COL_E.MES         - 1] = mes;
      fila[COL_E.ANIO        - 1] = year;
      fila[COL_E.TIPO_EGRESO - 1] = 'nomina';
      fila[COL_E.CATEGORIA   - 1] = 'gastos_personal';
      // Costo empresa = bruto + patronal (lo que le cuesta a CEYCO)
      fila[COL_E.SUBTOTAL    - 1] = costoEmp;
      fila[COL_E.ITBMS       - 1] = 0;   // nómina no tiene ITBMS
      fila[COL_E.TOTAL       - 1] = costoEmp;
      fila[COL_E.MONEDA      - 1] = 'USD';
      fila[COL_E.PROVEEDOR   - 1] = emp.nombre;
      fila[COL_E.RUC_PROV    - 1] = emp.cedula || '';
      fila[COL_E.DESCRIPCION - 1] = desc;
      fila[COL_E.NOTAS       - 1] = notas;

      sheetEgr.appendRow(fila);
      // Color verde claro para nómina
      sheetEgr.getRange(sheetEgr.getLastRow(), 1, 1, EGRESOS_NCOLS)
        .setBackground('#F1F8E9');

      eIds.push(egresoId);
      Logger.log('✅ Egreso planilla: ' + egresoId + ' — ' + emp.nombre + ' B/.' + costoEmp.toFixed(2));
    }

    SpreadsheetApp.flush();
    result.success    = true;
    result.egresos_ids = eIds;
    Logger.log('✅ Planilla ' + periodo + ' registrada — ' + eIds.length + ' empleados, seq hasta: ' + (seq-1));
  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleRegistrarPlanilla: ' + err.message);
  }
  return _json(result);
}

// ── desactivarEmpleado (POST) ─────────────────────
function _handleDesactivarEmpleado(data) {
  var result = { success: false, error: null };
  try {
    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = _initEmpleadosSheet(ss);
    var idEmp = String(data.id_empleado || '').trim();
    if (!idEmp) throw new Error('id_empleado requerido');

    var numRows = sheet.getLastRow() - 2;
    if (numRows <= 0) throw new Error('Sin empleados registrados');
    var ids = sheet.getRange(3, COL_EMP.ID, numRows, 1).getValues();
    var rowNum = -1;
    for (var k = 0; k < ids.length; k++) {
      if (String(ids[k][0]).trim() === idEmp) { rowNum = k + 3; break; }
    }
    if (rowNum === -1) throw new Error('Empleado no encontrado: ' + idEmp);

    var hoy = Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd');
    sheet.getRange(rowNum, COL_EMP.ESTADO,   1, 1).setValue('inactivo');
    sheet.getRange(rowNum, COL_EMP.FECHA_FIN,1, 1).setValue(hoy);
    sheet.getRange(rowNum, 1, 1, EMP_NCOLS).setBackground('#FFEBEE');
    SpreadsheetApp.flush();
    result.success = true;
    Logger.log('✅ Empleado desactivado: ' + idEmp);
  } catch(err) {
    result.error = err.message;
    Logger.log('Error _handleDesactivarEmpleado: ' + err.message);
  }
  return _json(result);
}
