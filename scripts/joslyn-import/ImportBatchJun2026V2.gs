/**
 * ════════════════════════════════════════════════════════════════════
 *  IMPORT BATCH V2 — Gastos personales Joslyn López (10-jun-2026)
 *
 *  Importa 29 transacciones del consolidado de gastos por categoría,
 *  EXCLUYENDO Farmacia Arrocha (se manejará por separado vía email).
 *
 *  Desglose:
 *    - 15 × Super Carnes      ($380.13)   alimentación
 *    -  4 × Rey Paseo Albrook ($133.74)   alimentación
 *    - 10 × Viviana Ordoñez   ($1,550)    manutención
 *    Total: $2,063.87, todos alcance=personal, categoría otros_gastos
 *
 *  USO (dentro del editor de Apps Script de Joslyn López):
 *    1. File → New → Script → "ImportBatchJun2026V2"
 *    2. Pegar este contenido y guardar.
 *    3. Dropdown de funciones:
 *         - importBatchJun2026V2DryRun     → preview, no toca nada
 *         - importBatchJun2026V2Ejecutar   → inserta los 29 egresos
 *         - importBatchJun2026V2Rollback   → marca como anulado (reversible)
 *    4. Click ▶ Ejecutar. Mirá el Log.
 *    5. Refrescá el dashboard.
 *
 *  Notas técnicas:
 *    - alcance = 'personal' (NO afectan P&L del negocio).
 *    - categoría = otros_gastos (no deducible en Form 90).
 *    - Sin ITBMS (transacciones bancarias sin desglose).
 *    - Tag de identificación: BATCH-IMPORT-JUN2026-V2 en la nota.
 * ════════════════════════════════════════════════════════════════════
 */

var BATCH_DATA = [
  {
    "fecha": "2026-04-02",
    "proveedor": "SUPER CARNES",
    "total": 29.82,
    "categoria": "gastos_alimentacion",
    "alcance": "personal",
    "descripcion": "Compra alimentación",
    "num_factura": ""
  },
  {
    "fecha": "2026-04-10",
    "proveedor": "SUPER CARNES",
    "total": 54.44,
    "categoria": "gastos_alimentacion",
    "alcance": "personal",
    "descripcion": "Compra alimentación",
    "num_factura": ""
  },
  {
    "fecha": "2026-04-13",
    "proveedor": "SUPER CARNES",
    "total": 14.87,
    "categoria": "gastos_alimentacion",
    "alcance": "personal",
    "descripcion": "Compra alimentación",
    "num_factura": ""
  },
  {
    "fecha": "2026-04-18",
    "proveedor": "SUPER CARNES",
    "total": 15.34,
    "categoria": "gastos_alimentacion",
    "alcance": "personal",
    "descripcion": "Compra alimentación",
    "num_factura": ""
  },
  {
    "fecha": "2026-04-24",
    "proveedor": "SUPER CARNES",
    "total": 34.93,
    "categoria": "gastos_alimentacion",
    "alcance": "personal",
    "descripcion": "Compra alimentación",
    "num_factura": ""
  },
  {
    "fecha": "2026-04-30",
    "proveedor": "SUPER CARNES",
    "total": 22.1,
    "categoria": "gastos_alimentacion",
    "alcance": "personal",
    "descripcion": "Compra alimentación",
    "num_factura": ""
  },
  {
    "fecha": "2026-05-08",
    "proveedor": "SUPER CARNES",
    "total": 42.59,
    "categoria": "gastos_alimentacion",
    "alcance": "personal",
    "descripcion": "Compra alimentación",
    "num_factura": ""
  },
  {
    "fecha": "2026-05-08",
    "proveedor": "SUPER CARNES",
    "total": 0.74,
    "categoria": "gastos_alimentacion",
    "alcance": "personal",
    "descripcion": "Compra alimentación",
    "num_factura": ""
  },
  {
    "fecha": "2026-05-11",
    "proveedor": "SUPER CARNES",
    "total": 19.68,
    "categoria": "gastos_alimentacion",
    "alcance": "personal",
    "descripcion": "Compra alimentación",
    "num_factura": ""
  },
  {
    "fecha": "2026-05-19",
    "proveedor": "SUPER CARNES",
    "total": 12.93,
    "categoria": "gastos_alimentacion",
    "alcance": "personal",
    "descripcion": "Compra alimentación",
    "num_factura": ""
  },
  {
    "fecha": "2026-05-20",
    "proveedor": "SUPER CARNES",
    "total": 11.37,
    "categoria": "gastos_alimentacion",
    "alcance": "personal",
    "descripcion": "Compra alimentación",
    "num_factura": ""
  },
  {
    "fecha": "2026-05-22",
    "proveedor": "SUPER CARNES",
    "total": 32.85,
    "categoria": "gastos_alimentacion",
    "alcance": "personal",
    "descripcion": "Compra alimentación",
    "num_factura": ""
  },
  {
    "fecha": "2026-05-28",
    "proveedor": "SUPER CARNES",
    "total": 44.73,
    "categoria": "gastos_alimentacion",
    "alcance": "personal",
    "descripcion": "Compra alimentación",
    "num_factura": ""
  },
  {
    "fecha": "2026-06-01",
    "proveedor": "SUPER CARNES",
    "total": 14.78,
    "categoria": "gastos_alimentacion",
    "alcance": "personal",
    "descripcion": "Compra alimentación",
    "num_factura": ""
  },
  {
    "fecha": "2026-06-05",
    "proveedor": "SUPER CARNES",
    "total": 28.96,
    "categoria": "gastos_alimentacion",
    "alcance": "personal",
    "descripcion": "Compra alimentación",
    "num_factura": ""
  },
  {
    "fecha": "2026-03-20",
    "proveedor": "REY PASEO ALBROOK",
    "total": 65.15,
    "categoria": "gastos_alimentacion",
    "alcance": "personal",
    "descripcion": "Compra supermercado",
    "num_factura": ""
  },
  {
    "fecha": "2026-04-01",
    "proveedor": "REY PASEO ALBROOK",
    "total": 59.05,
    "categoria": "gastos_alimentacion",
    "alcance": "personal",
    "descripcion": "Compra supermercado",
    "num_factura": ""
  },
  {
    "fecha": "2026-05-20",
    "proveedor": "REY PASEO ALBROOK",
    "total": 3.96,
    "categoria": "gastos_alimentacion",
    "alcance": "personal",
    "descripcion": "Compra supermercado",
    "num_factura": ""
  },
  {
    "fecha": "2026-06-04",
    "proveedor": "REY PASEO ALBROOK",
    "total": 5.58,
    "categoria": "gastos_alimentacion",
    "alcance": "personal",
    "descripcion": "Compra supermercado",
    "num_factura": ""
  },
  {
    "fecha": "2026-01-15",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención a Viviana",
    "num_factura": ""
  },
  {
    "fecha": "2026-02-01",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención a Viviana",
    "num_factura": ""
  },
  {
    "fecha": "2026-02-16",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 200.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención a Viviana",
    "num_factura": ""
  },
  {
    "fecha": "2026-03-01",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención a Viviana",
    "num_factura": ""
  },
  {
    "fecha": "2026-03-16",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención a Viviana",
    "num_factura": ""
  },
  {
    "fecha": "2026-03-30",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención a Viviana",
    "num_factura": ""
  },
  {
    "fecha": "2026-04-16",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención a Viviana",
    "num_factura": ""
  },
  {
    "fecha": "2026-05-03",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención a Viviana",
    "num_factura": ""
  },
  {
    "fecha": "2026-05-15",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención a Viviana",
    "num_factura": ""
  },
  {
    "fecha": "2026-05-30",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención a Viviana",
    "num_factura": ""
  }
];
var BATCH_TAG = 'BATCH-IMPORT-JUN2026-V2';

function importBatchJun2026V2DryRun()  { _importBatchJun2026V2_run(false); }
function importBatchJun2026V2Ejecutar(){ _importBatchJun2026V2_run(true);  }

function _importBatchJun2026V2_run(ejecutar) {
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

  var byProv = {};
  for (var i = 0; i < BATCH_DATA.length; i++) {
    var p = BATCH_DATA[i].proveedor;
    if (!byProv[p]) byProv[p] = { n: 0, total: 0 };
    byProv[p].n++;
    byProv[p].total += BATCH_DATA[i].total;
  }
  Object.keys(byProv).forEach(function(p) {
    Logger.log('  ' + p + ': ' + byProv[p].n + ' rows | $' + byProv[p].total.toFixed(2));
  });
  Logger.log('');

  if (dry) {
    Logger.log('Muestra de las primeras 5 filas:');
    for (var j = 0; j < Math.min(5, BATCH_DATA.length); j++) {
      var r = BATCH_DATA[j];
      Logger.log('  ' + r.fecha + ' | ' + r.proveedor + ' | $' + r.total + ' | ' + r.categoria + ' (' + r.alcance + ')');
    }
    Logger.log('');
    Logger.log('Para insertar de verdad: corré importBatchJun2026V2Ejecutar');
    return;
  }

  var ahora = new Date();
  var stamp = Utilities.formatDate(ahora, 'America/Panama', 'yyyyMMddHHmmss');
  var filas = [];
  for (var k = 0; k < BATCH_DATA.length; k++) {
    var item = BATCH_DATA[k];
    var fechaReg = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
    var egresoId = 'EGR-' + prefijo + '-' + Utilities.formatDate(ahora, 'America/Panama', 'yyyy') +
                   '-BV2' + String(k+1).padStart(3, '0') + '-' + stamp.slice(-6);
    var fechaDate = null;
    var fm = String(item.fecha).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (fm) {
      try { fechaDate = Utilities.parseDate(fm[1] + '-' + fm[2] + '-' + fm[3], 'America/Panama', 'yyyy-MM-dd'); } catch (e) {}
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
    fila[COL_E.NOTAS - 1]       = BATCH_TAG + ' | ' + item.proveedor;
    fila[COL_E.ALCANCE - 1]     = item.alcance;
    filas.push(fila);
  }
  var startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, filas.length, EGRESOS_NCOLS).setValues(filas);
  sheet.getRange(startRow, COL_E.FECHA_GASTO, filas.length, 1).setNumberFormat('yyyy-MM-dd');
  sheet.getRange(startRow, COL_E.SUBTOTAL, filas.length, 3).setNumberFormat('#,##0.00');
  sheet.getRange(startRow, 1, filas.length, EGRESOS_NCOLS).setBackground('#E3F2FD');

  Logger.log('✅ Insertados ' + filas.length + ' egresos en filas ' + startRow + '-' + (startRow + filas.length - 1));
  Logger.log('Refrescá el dashboard.');
  Logger.log('Para revertir: importBatchJun2026V2Rollback');
}

function importBatchJun2026V2Rollback() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_EGRESOS);
  if (!sheet) throw new Error('Hoja Egresos no encontrada');
  var data = sheet.getRange(3, 1, sheet.getLastRow() - 2, EGRESOS_NCOLS).getValues();
  var count = 0;
  for (var i = 0; i < data.length; i++) {
    var notas = String(data[i][COL_E.NOTAS - 1] || '');
    if (notas.indexOf(BATCH_TAG) === -1) continue;
    if (String(data[i][COL_E.ESTADO - 1] || '').toLowerCase() === 'anulado') continue;
    var rowNum = i + 3;
    sheet.getRange(rowNum, COL_E.ESTADO).setValue('anulado');
    sheet.getRange(rowNum, 1, 1, EGRESOS_NCOLS).setBackground('#FFEBEE');
    count++;
  }
  Logger.log('✅ Anulados ' + count + ' egresos del batch V2.');
}
