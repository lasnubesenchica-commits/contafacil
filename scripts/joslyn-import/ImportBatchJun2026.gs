/**
 * ════════════════════════════════════════════════════════════════════
 *  IMPORT BATCH — Gastos personales Joslyn López (10-jun-2026)
 *
 *  Importa 34 transacciones de banco (Farmacia Arrocha, Super Carnes,
 *  Rey, Transferencias a Viviana) directamente a la hoja Egresos
 *  con la estructura correcta para que P&L, Informe Anual, Registro
 *  de Gastos y filtros del dashboard lean todo correctamente.
 *
 *  USO (dentro del editor de Apps Script de Joslyn López):
 *    1. Crear archivo nuevo: File → New → Script → "ImportBatchJun2026"
 *    2. Pegar todo este contenido.
 *    3. Dropdown de funciones (arriba) → seleccionar:
 *         - importBatchJun2026DryRun     → muestra qué va a insertar, no toca nada
 *         - importBatchJun2026Ejecutar   → inserta los 34 egresos
 *    4. Click ▶ Ejecutar. Mirá el Log (Ctrl+Enter).
 *    5. Refrescá el dashboard para ver los nuevos egresos.
 *
 *  Notas técnicas:
 *    - alcance = 'personal' en todos (NO afectan P&L del negocio).
 *    - Farmacia Arrocha → categoría gastos_medicos (DP-1, deducible
 *      personal en el Form 90).
 *    - Resto → otros_gastos (gasto familiar no deducible).
 *    - Sin ITBMS (transacciones bancarias, no facturas con desglose).
 *    - num_factura vacío.
 *
 *  ¿Algo salió mal? Cada egreso queda con nota 'BATCH-IMPORT-JUN2026'
 *  para poder filtrarlos y borrarlos en bulk si hace falta.
 * ════════════════════════════════════════════════════════════════════
 */

var BATCH_DATA = [
  {
    "fecha": "2026-03-16",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "otros_gastos",
    "alcance": "personal",
    "descripcion": "Manutención",
    "num_factura": ""
  },
  {
    "fecha": "2026-03-30",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "otros_gastos",
    "alcance": "personal",
    "descripcion": "Manutención",
    "num_factura": ""
  },
  {
    "fecha": "2026-04-16",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "otros_gastos",
    "alcance": "personal",
    "descripcion": "Manutención",
    "num_factura": ""
  },
  {
    "fecha": "2026-05-03",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "otros_gastos",
    "alcance": "personal",
    "descripcion": "Manutención",
    "num_factura": ""
  },
  {
    "fecha": "2026-05-15",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "otros_gastos",
    "alcance": "personal",
    "descripcion": "Manutención",
    "num_factura": ""
  },
  {
    "fecha": "2026-05-30",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "otros_gastos",
    "alcance": "personal",
    "descripcion": "Manutención",
    "num_factura": ""
  },
  {
    "fecha": "2026-05-19",
    "proveedor": "SUPER CARNES",
    "total": 12.93,
    "categoria": "otros_gastos",
    "alcance": "personal",
    "descripcion": "SUPER CARNES 12-4187-94XX-XXXX-0953",
    "num_factura": ""
  },
  {
    "fecha": "2026-05-20",
    "proveedor": "SUPER CARNES",
    "total": 11.37,
    "categoria": "otros_gastos",
    "alcance": "personal",
    "descripcion": "SUPER CARNES 12-4187-94XX-XXXX-0953",
    "num_factura": ""
  },
  {
    "fecha": "2026-05-22",
    "proveedor": "SUPER CARNES",
    "total": 32.85,
    "categoria": "otros_gastos",
    "alcance": "personal",
    "descripcion": "SUPER CARNES 12-4187-94XX-XXXX-0953",
    "num_factura": ""
  },
  {
    "fecha": "2026-05-28",
    "proveedor": "SUPER CARNES",
    "total": 44.73,
    "categoria": "otros_gastos",
    "alcance": "personal",
    "descripcion": "SUPER CARNES 12-4187-94XX-XXXX-0953",
    "num_factura": ""
  },
  {
    "fecha": "2026-06-01",
    "proveedor": "SUPER CARNES",
    "total": 14.78,
    "categoria": "otros_gastos",
    "alcance": "personal",
    "descripcion": "SUPER CARNES 12-4187-94XX-XXXX-0953",
    "num_factura": ""
  },
  {
    "fecha": "2026-06-05",
    "proveedor": "SUPER CARNES",
    "total": 28.96,
    "categoria": "otros_gastos",
    "alcance": "personal",
    "descripcion": "SUPER CARNES 12-4187-94XX-XXXX-0953",
    "num_factura": ""
  },
  {
    "fecha": "2026-03-19",
    "proveedor": "FARMACIA ARROCHA",
    "total": 7.11,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "FARMACIA ARROCHA CLAYT-4187-94XX-XXXX-0953",
    "num_factura": ""
  },
  {
    "fecha": "2026-03-20",
    "proveedor": "FARMACIA ARROCHA",
    "total": 7.52,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "FARMACIA ARROCHA CLAYT-4187-94XX-XXXX-0953",
    "num_factura": ""
  },
  {
    "fecha": "2026-03-21",
    "proveedor": "FARMACIA ARROCHA",
    "total": 7.77,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "FARMACIA ARROCHA TUMBA-4187-94XX-XXXX-0953",
    "num_factura": ""
  },
  {
    "fecha": "2026-04-06",
    "proveedor": "FARMACIA ARROCHA",
    "total": 2.7,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "FARMACIA ARROCHA CLAYT-4187-94XX-XXXX-0953",
    "num_factura": ""
  },
  {
    "fecha": "2026-04-08",
    "proveedor": "FARMACIA ARROCHA",
    "total": 2.7,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "FARMACIA ARROCHA CLAYT-4187-94XX-XXXX-0953",
    "num_factura": ""
  },
  {
    "fecha": "2026-04-25",
    "proveedor": "FARMACIA ARROCHA",
    "total": 1.24,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "FARMACIA ARROCHA ALBRO-4187-94XX-XXXX-0953",
    "num_factura": ""
  },
  {
    "fecha": "2026-05-16",
    "proveedor": "FARMACIA ARROCHA",
    "total": 3.58,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "FARMACIA ARROCHA CLAYT-4187-94XX-XXXX-0953",
    "num_factura": ""
  },
  {
    "fecha": "2026-05-19",
    "proveedor": "FARMACIA ARROCHA",
    "total": 7.4,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "FARMACIA ARROCHA CLAYT-4187-94XX-XXXX-0953",
    "num_factura": ""
  },
  {
    "fecha": "2026-05-19",
    "proveedor": "FARMACIA ARROCHA",
    "total": 11.91,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "FARMACIA ARROCHA CLAYT-4187-94XX-XXXX-0953",
    "num_factura": ""
  },
  {
    "fecha": "2026-05-22",
    "proveedor": "FARMACIA ARROCHA",
    "total": 17.83,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "FARMACIA ARROCHA TUMBA-4187-94XX-XXXX-0953",
    "num_factura": ""
  },
  {
    "fecha": "2026-05-22",
    "proveedor": "FARMACIA ARROCHA",
    "total": 2.14,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "FARMACIA ARROCHA CLAYT-4187-94XX-XXXX-0953",
    "num_factura": ""
  },
  {
    "fecha": "2026-05-23",
    "proveedor": "FARMACIA ARROCHA",
    "total": 2.14,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "FARMACIA ARROCHA CLAYT-4187-94XX-XXXX-0953",
    "num_factura": ""
  },
  {
    "fecha": "2026-05-26",
    "proveedor": "FARMACIA ARROCHA",
    "total": 8.12,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "FARMACIA ARROCHA CLAYT-4187-94XX-XXXX-0953",
    "num_factura": ""
  },
  {
    "fecha": "2026-06-01",
    "proveedor": "FARMACIA ARROCHA",
    "total": 12.25,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "FARMACIA ARROCHA CLAYT-4187-94XX-XXXX-0953",
    "num_factura": ""
  },
  {
    "fecha": "2026-06-01",
    "proveedor": "FARMACIA ARROCHA",
    "total": 7.08,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "FARMACIA ARROCHA CLAYT-4187-94XX-XXXX-0953",
    "num_factura": ""
  },
  {
    "fecha": "2026-06-02",
    "proveedor": "FARMACIA ARROCHA",
    "total": 14.46,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "FARMACIA ARROCHA ALBRO-4187-94XX-XXXX-0953",
    "num_factura": ""
  },
  {
    "fecha": "2026-06-04",
    "proveedor": "FARMACIA ARROCHA",
    "total": 25.43,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "FARMACIA ARROCHA ALBRO-4187-94XX-XXXX-0953",
    "num_factura": ""
  },
  {
    "fecha": "2026-06-08",
    "proveedor": "FARMACIA ARROCHA",
    "total": 5.07,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "FARMACIA ARROCHA CENTE-4187-94XX-XXXX-0953",
    "num_factura": ""
  },
  {
    "fecha": "2026-06-10",
    "proveedor": "FARMACIA ARROCHA",
    "total": 8.16,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "FARMACIA ARROCHA TUMBA-4187-94XX-XXXX-0953",
    "num_factura": ""
  },
  {
    "fecha": "2026-03-20",
    "proveedor": "REY PASEO ALBROOK",
    "total": 65.15,
    "categoria": "otros_gastos",
    "alcance": "personal",
    "descripcion": "REY PASEO ALBROOK 1102-4187-94XX-XXXX-0953",
    "num_factura": ""
  },
  {
    "fecha": "2026-05-20",
    "proveedor": "REY PASEO ALBROOK",
    "total": 3.96,
    "categoria": "otros_gastos",
    "alcance": "personal",
    "descripcion": "REY PASEO ALBROOK 1102-4187-94XX-XXXX-0953",
    "num_factura": ""
  },
  {
    "fecha": "2026-06-04",
    "proveedor": "REY PASEO ALBROOK",
    "total": 5.58,
    "categoria": "otros_gastos",
    "alcance": "personal",
    "descripcion": "REY PASEO ALBROOK 1102-4187-94XX-XXXX-0953",
    "num_factura": ""
  }
];

function importBatchJun2026DryRun() { _importBatchJun2026_run(false); }
function importBatchJun2026Ejecutar() { _importBatchJun2026_run(true); }

function _importBatchJun2026_run(ejecutar) {
  var dry = !ejecutar;
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_EGRESOS);
  if (!sheet) throw new Error('Hoja Egresos no encontrada');

  var cfg = _getConfig();
  var prefijo = (cfg && cfg.prefijo_id) ? cfg.prefijo_id : 'RP';

  Logger.log('═══════════════════════════════════════════════');
  Logger.log(dry ? '🔍 DRY-RUN — no se modificará nada' : '✅ EJECUTANDO inserción');
  Logger.log('═══════════════════════════════════════════════');
  Logger.log('Total a insertar: ' + BATCH_DATA.length + ' egresos');
  Logger.log('Suma: $' + BATCH_DATA.reduce(function(s,r){return s + r.total;}, 0).toFixed(2));
  Logger.log('');

  // Resumen por categoría
  var byCategoria = {};
  for (var i = 0; i < BATCH_DATA.length; i++) {
    var c = BATCH_DATA[i].categoria;
    if (!byCategoria[c]) byCategoria[c] = { n: 0, total: 0 };
    byCategoria[c].n++;
    byCategoria[c].total += BATCH_DATA[i].total;
  }
  Object.keys(byCategoria).forEach(function(c) {
    Logger.log('  ' + c + ': ' + byCategoria[c].n + ' rows | $' + byCategoria[c].total.toFixed(2));
  });
  Logger.log('');

  if (dry) {
    Logger.log('Muestra de las primeras 5 filas a insertar:');
    for (var j = 0; j < Math.min(5, BATCH_DATA.length); j++) {
      var r = BATCH_DATA[j];
      Logger.log('  ' + r.fecha + ' | ' + r.proveedor + ' | $' + r.total + ' | ' + r.categoria + ' (' + r.alcance + ')');
    }
    Logger.log('');
    Logger.log('Para insertar de verdad: corré importBatchJun2026Ejecutar');
    return;
  }

  // Construir filas para inserción en batch
  var ahora = new Date();
  var stamp = Utilities.formatDate(ahora, 'America/Panama', 'yyyyMMddHHmmss');
  var filas = [];
  var pendId = 1;
  for (var k = 0; k < BATCH_DATA.length; k++) {
    var item = BATCH_DATA[k];
    var fechaReg = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
    var egresoId = 'EGR-' + prefijo + '-' + Utilities.formatDate(ahora, 'America/Panama', 'yyyy') +
                   '-BATCH' + String(k+1).padStart(3, '0') + '-' + stamp.slice(-6);

    var fechaDate = null;
    var fm = String(item.fecha).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (fm) {
      try {
        fechaDate = Utilities.parseDate(fm[1] + '-' + fm[2] + '-' + fm[3], 'America/Panama', 'yyyy-MM-dd');
      } catch (e) {}
    }

    var fila = new Array(EGRESOS_NCOLS).fill('');
    fila[COL_E.ID - 1]          = egresoId;
    fila[COL_E.FECHA_REG - 1]   = fechaReg;
    fila[COL_E.ESTADO - 1]      = 'registrado';
    fila[COL_E.FECHA_GASTO - 1] = fechaDate || item.fecha;
    fila[COL_E.MES - 1]         = fm ? parseInt(fm[2], 10) : '';
    fila[COL_E.ANIO - 1]        = fm ? parseInt(fm[1], 10) : '';
    fila[COL_E.SUBTOTAL - 1]    = item.total;
    fila[COL_E.ITBMS - 1]       = 0;
    fila[COL_E.TOTAL - 1]       = item.total;
    fila[COL_E.MONEDA - 1]      = 'USD';
    fila[COL_E.TIPO_EGRESO - 1] = item.categoria;
    fila[COL_E.CATEGORIA - 1]   = item.categoria;
    fila[COL_E.PROVEEDOR - 1]   = item.proveedor;
    fila[COL_E.NFACTURA - 1]    = item.num_factura || '';
    fila[COL_E.DESCRIPCION - 1] = item.descripcion || '';
    fila[COL_E.NOTAS - 1]       = 'BATCH-IMPORT-JUN2026 | ' + item.proveedor;
    fila[COL_E.ALCANCE - 1]     = item.alcance;
    filas.push(fila);
  }

  // Insertar en bloque (más rápido que appendRow una por una)
  var startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, filas.length, EGRESOS_NCOLS).setValues(filas);
  sheet.getRange(startRow, COL_E.FECHA_GASTO, filas.length, 1).setNumberFormat('yyyy-MM-dd');
  sheet.getRange(startRow, COL_E.SUBTOTAL, filas.length, 3).setNumberFormat('#,##0.00');
  sheet.getRange(startRow, 1, filas.length, EGRESOS_NCOLS).setBackground('#E3F2FD');

  Logger.log('✅ Insertados ' + filas.length + ' egresos en filas ' + startRow + '-' + (startRow + filas.length - 1));
  Logger.log('Refrescá el dashboard de Joslyn López para ver los cambios.');
  Logger.log('');
  Logger.log('Si necesitás revertir: corré importBatchJun2026Rollback');
}

// Marca todos los egresos del batch como 'anulado' (no los borra,
// quedan en el sheet con fondo rojo y trazabilidad). Reversible
// cambiando el estado de vuelta a 'registrado'.
function importBatchJun2026Rollback() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_EGRESOS);
  if (!sheet) throw new Error('Hoja Egresos no encontrada');
  var data = sheet.getRange(3, 1, sheet.getLastRow() - 2, EGRESOS_NCOLS).getValues();
  var count = 0;
  for (var i = 0; i < data.length; i++) {
    var notas = String(data[i][COL_E.NOTAS - 1] || '');
    if (notas.indexOf('BATCH-IMPORT-JUN2026') === -1) continue;
    if (String(data[i][COL_E.ESTADO - 1] || '').toLowerCase() === 'anulado') continue;
    var rowNum = i + 3;
    sheet.getRange(rowNum, COL_E.ESTADO).setValue('anulado');
    sheet.getRange(rowNum, 1, 1, EGRESOS_NCOLS).setBackground('#FFEBEE');
    count++;
  }
  Logger.log('✅ Rollback completo. Anulados ' + count + ' egresos del batch.');
  Logger.log('Los datos siguen en el sheet con estado=anulado. Para borrar definitivamente, filtrá por nota "BATCH-IMPORT-JUN2026" y eliminá las filas a mano.');
}
