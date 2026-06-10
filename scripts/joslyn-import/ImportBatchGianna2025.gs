/**
 * ════════════════════════════════════════════════════════════════════
 *  IMPORT BATCH GIANNA — Gastos hija dependiente Joslyn López
 *
 *  64 transacciones del panorama de gastos de Gianna:
 *    - 63 filas del año 2025 completo ($8,790.94)
 *    -  1 fila del 2026 (Primera Comunión $50, vía Viviana)
 *    Total: $8,840.94
 *
 *  Mapeo de categorías (con impacto fiscal):
 *    ✅ DEDUCIBLES (entran al Form 90 Anexo 91):
 *      - 15 × Colegio Las Esclavas + Primera Comunión → gastos_escolares (DP-2)
 *      - 16 × Médicos (Clínicas Albrook, San Fernando, etc) → gastos_medicos (DP-1)
 *      Subtotal deducible: $4,930.94
 *
 *    ❌ NO DEDUCIBLES (alcance=personal, excluidos auto):
 *      - 25 × Manutención mensual a Viviana → manutencion
 *      -  8 × Gimnasia Gianna → fiestas_entretenimiento
 *      Subtotal no deducible: $3,910.00
 *
 *  USO (editor de Apps Script de Joslyn López):
 *    1. File → New → Script → "ImportBatchGianna2025"
 *    2. Pegar este contenido y guardar.
 *    3. Dropdown:
 *         - importBatchGiannaDryRun     → preview
 *         - importBatchGiannaEjecutar   → inserta los 64
 *         - importBatchGiannaRollback   → anula reversible
 *    4. Click ▶. Mirá el Log.
 *    5. Refrescá el dashboard.
 *
 *  Notas:
 *    - Todos alcance='personal' (Joslyn es Persona Natural).
 *    - Tag: BATCH-IMPORT-GIANNA-2025
 * ════════════════════════════════════════════════════════════════════
 */

var BATCH_DATA = [
  {
    "fecha": "2025-01-15",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención mensual",
    "num_factura": ""
  },
  {
    "fecha": "2025-01-30",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención mensual",
    "num_factura": ""
  },
  {
    "fecha": "2025-02-15",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención mensual",
    "num_factura": ""
  },
  {
    "fecha": "2025-02-28",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención mensual",
    "num_factura": ""
  },
  {
    "fecha": "2025-03-15",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención mensual",
    "num_factura": ""
  },
  {
    "fecha": "2025-03-30",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención mensual",
    "num_factura": ""
  },
  {
    "fecha": "2025-04-15",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención mensual",
    "num_factura": ""
  },
  {
    "fecha": "2025-04-30",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención mensual",
    "num_factura": ""
  },
  {
    "fecha": "2025-05-16",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención mensual",
    "num_factura": ""
  },
  {
    "fecha": "2025-05-30",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención mensual",
    "num_factura": ""
  },
  {
    "fecha": "2025-06-16",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención mensual",
    "num_factura": ""
  },
  {
    "fecha": "2025-07-05",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención mensual",
    "num_factura": ""
  },
  {
    "fecha": "2025-07-15",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención mensual",
    "num_factura": ""
  },
  {
    "fecha": "2025-07-30",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención mensual",
    "num_factura": ""
  },
  {
    "fecha": "2025-08-20",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención mensual",
    "num_factura": ""
  },
  {
    "fecha": "2025-09-02",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención mensual",
    "num_factura": ""
  },
  {
    "fecha": "2025-09-15",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención mensual",
    "num_factura": ""
  },
  {
    "fecha": "2025-10-01",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención mensual",
    "num_factura": ""
  },
  {
    "fecha": "2025-10-15",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención mensual",
    "num_factura": ""
  },
  {
    "fecha": "2025-11-07",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 50.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención mensual",
    "num_factura": ""
  },
  {
    "fecha": "2025-11-07",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 100.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención mensual",
    "num_factura": ""
  },
  {
    "fecha": "2025-11-15",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención mensual",
    "num_factura": ""
  },
  {
    "fecha": "2025-11-30",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención mensual",
    "num_factura": ""
  },
  {
    "fecha": "2025-12-15",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención mensual",
    "num_factura": ""
  },
  {
    "fecha": "2025-12-30",
    "proveedor": "VIVIANA ESTELA ORDOÑEZ ALVAREZ",
    "total": 150.0,
    "categoria": "manutencion",
    "alcance": "personal",
    "descripcion": "Manutención mensual",
    "num_factura": ""
  },
  {
    "fecha": "2025-02-10",
    "proveedor": "COLEGIO LAS ESCLAVAS",
    "total": 617.0,
    "categoria": "gastos_escolares",
    "alcance": "personal",
    "descripcion": "Colegio Las Esclavas — saldo 2",
    "num_factura": ""
  },
  {
    "fecha": "2025-02-11",
    "proveedor": "COLEGIO LAS ESCLAVAS",
    "total": 603.75,
    "categoria": "gastos_escolares",
    "alcance": "personal",
    "descripcion": "Colegio Las Esclavas — matricu",
    "num_factura": ""
  },
  {
    "fecha": "2025-03-20",
    "proveedor": "COLEGIO LAS ESCLAVAS",
    "total": 304.5,
    "categoria": "gastos_escolares",
    "alcance": "personal",
    "descripcion": "Colegio Las Esclavas — marzo",
    "num_factura": ""
  },
  {
    "fecha": "2025-05-05",
    "proveedor": "COLEGIO LAS ESCLAVAS",
    "total": 304.5,
    "categoria": "gastos_escolares",
    "alcance": "personal",
    "descripcion": "Colegio Las Esclavas — abril",
    "num_factura": ""
  },
  {
    "fecha": "2025-05-06",
    "proveedor": "COLEGIO LAS ESCLAVAS",
    "total": 290.0,
    "categoria": "gastos_escolares",
    "alcance": "personal",
    "descripcion": "Colegio Las Esclavas — mayo",
    "num_factura": ""
  },
  {
    "fecha": "2025-06-13",
    "proveedor": "COLEGIO LAS ESCLAVAS",
    "total": 290.0,
    "categoria": "gastos_escolares",
    "alcance": "personal",
    "descripcion": "Colegio Las Esclavas — junio",
    "num_factura": ""
  },
  {
    "fecha": "2025-07-25",
    "proveedor": "COLEGIO LAS ESCLAVAS",
    "total": 304.5,
    "categoria": "gastos_escolares",
    "alcance": "personal",
    "descripcion": "Colegio Las Esclavas — junio",
    "num_factura": ""
  },
  {
    "fecha": "2025-10-12",
    "proveedor": "COLEGIO LAS ESCLAVAS",
    "total": 22.5,
    "categoria": "gastos_escolares",
    "alcance": "personal",
    "descripcion": "Colegio Las Esclavas — Yappy APF Las Esclavas",
    "num_factura": ""
  },
  {
    "fecha": "2025-10-15",
    "proveedor": "COLEGIO LAS ESCLAVAS",
    "total": 609.0,
    "categoria": "gastos_escolares",
    "alcance": "personal",
    "descripcion": "Colegio Las Esclavas — julio y",
    "num_factura": ""
  },
  {
    "fecha": "2025-11-28",
    "proveedor": "COLEGIO LAS ESCLAVAS",
    "total": 304.5,
    "categoria": "gastos_escolares",
    "alcance": "personal",
    "descripcion": "Colegio Las Esclavas — Colegio Las Esclavas (transf.)",
    "num_factura": ""
  },
  {
    "fecha": "2025-12-03",
    "proveedor": "COLEGIO LAS ESCLAVAS",
    "total": 304.5,
    "categoria": "gastos_escolares",
    "alcance": "personal",
    "descripcion": "Colegio Las Esclavas — Colegio Las Esclavas (transf.)",
    "num_factura": ""
  },
  {
    "fecha": "2025-12-07",
    "proveedor": "COLEGIO LAS ESCLAVAS",
    "total": 290.0,
    "categoria": "gastos_escolares",
    "alcance": "personal",
    "descripcion": "Colegio Las Esclavas — diciemb",
    "num_factura": ""
  },
  {
    "fecha": "2025-01-04",
    "proveedor": "GIMNASIA GIANNA (vía Viviana)",
    "total": 35.0,
    "categoria": "fiestas_entretenimiento",
    "alcance": "personal",
    "descripcion": "POR inscripcion gimnasia Gianna",
    "num_factura": ""
  },
  {
    "fecha": "2025-01-13",
    "proveedor": "GIMNASIA GIANNA (vía Viviana)",
    "total": 30.0,
    "categoria": "fiestas_entretenimiento",
    "alcance": "personal",
    "descripcion": "POR inscripcion gimnasia Gianna",
    "num_factura": ""
  },
  {
    "fecha": "2025-02-12",
    "proveedor": "GIMNASIA GIANNA (vía Viviana)",
    "total": 35.0,
    "categoria": "fiestas_entretenimiento",
    "alcance": "personal",
    "descripcion": "POR gimnasia",
    "num_factura": ""
  },
  {
    "fecha": "2025-03-21",
    "proveedor": "GIMNASIA GIANNA (vía Viviana)",
    "total": 35.0,
    "categoria": "fiestas_entretenimiento",
    "alcance": "personal",
    "descripcion": "POR gimnasia",
    "num_factura": ""
  },
  {
    "fecha": "2025-04-30",
    "proveedor": "GIMNASIA GIANNA (vía Viviana)",
    "total": 35.0,
    "categoria": "fiestas_entretenimiento",
    "alcance": "personal",
    "descripcion": "POR gimnasia",
    "num_factura": ""
  },
  {
    "fecha": "2025-05-10",
    "proveedor": "GIMNASIA GIANNA (vía Viviana)",
    "total": 35.0,
    "categoria": "fiestas_entretenimiento",
    "alcance": "personal",
    "descripcion": "POR gimnasia",
    "num_factura": ""
  },
  {
    "fecha": "2025-05-12",
    "proveedor": "Médicos Gianna (vía Viviana)",
    "total": 20.0,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "POR reembolso gastos medicos Gianna",
    "num_factura": ""
  },
  {
    "fecha": "2025-06-03",
    "proveedor": "Médicos Gianna (vía Viviana)",
    "total": 17.29,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "POR gastos medicos Gianna",
    "num_factura": ""
  },
  {
    "fecha": "2025-06-11",
    "proveedor": "GIMNASIA GIANNA (vía Viviana)",
    "total": 35.0,
    "categoria": "fiestas_entretenimiento",
    "alcance": "personal",
    "descripcion": "gimnasia Gianna",
    "num_factura": ""
  },
  {
    "fecha": "2025-08-11",
    "proveedor": "GIMNASIA GIANNA (vía Viviana)",
    "total": 70.0,
    "categoria": "fiestas_entretenimiento",
    "alcance": "personal",
    "descripcion": "POR gimnasia",
    "num_factura": ""
  },
  {
    "fecha": "2025-08-20",
    "proveedor": "Primera comunión / Escolares (vía Viviana)",
    "total": 30.0,
    "categoria": "gastos_escolares",
    "alcance": "personal",
    "descripcion": "cuota primera comunión (de pago mixto $180)",
    "num_factura": ""
  },
  {
    "fecha": "2025-09-06",
    "proveedor": "Primera comunión / Escolares (vía Viviana)",
    "total": 50.0,
    "categoria": "gastos_escolares",
    "alcance": "personal",
    "descripcion": "POR primera comunion y otros gastos escolares",
    "num_factura": ""
  },
  {
    "fecha": "2025-10-09",
    "proveedor": "Médicos Gianna (vía Viviana)",
    "total": 40.0,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "Gastos medicos de",
    "num_factura": ""
  },
  {
    "fecha": "2026-02-16",
    "proveedor": "Primera comunión / Escolares (vía Viviana)",
    "total": 50.0,
    "categoria": "gastos_escolares",
    "alcance": "personal",
    "descripcion": "gastos escolares (de pago mixto $200)",
    "num_factura": ""
  },
  {
    "fecha": "2025-02-13",
    "proveedor": "CLINICA ALBROOK",
    "total": 20.0,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "Visita médica / consulta — Gianna",
    "num_factura": ""
  },
  {
    "fecha": "2025-04-03",
    "proveedor": "CLINICA ALBROOK",
    "total": 70.0,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "Visita médica / consulta — Gianna",
    "num_factura": ""
  },
  {
    "fecha": "2025-06-16",
    "proveedor": "CLINICA HOSP. SAN FERNANDO",
    "total": 38.5,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "Visita médica / consulta — Gianna",
    "num_factura": ""
  },
  {
    "fecha": "2025-09-15",
    "proveedor": "CLINICA ALBROOK",
    "total": 32.0,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "Visita médica / consulta — Gianna",
    "num_factura": ""
  },
  {
    "fecha": "2025-10-16",
    "proveedor": "MI SALUD MI CLINICA CH",
    "total": 42.45,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "Visita médica / consulta — Gianna",
    "num_factura": ""
  },
  {
    "fecha": "2025-10-17",
    "proveedor": "MI SALUD MI CLINICA CH",
    "total": 13.45,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "Visita médica / consulta — Gianna",
    "num_factura": ""
  },
  {
    "fecha": "2025-10-20",
    "proveedor": "CLINICA ALBROOK",
    "total": 20.0,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "Visita médica / consulta — Gianna",
    "num_factura": ""
  },
  {
    "fecha": "2025-11-06",
    "proveedor": "LABORATORIO RALY EL CA",
    "total": 41.0,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "Visita médica / consulta — Gianna",
    "num_factura": ""
  },
  {
    "fecha": "2025-12-02",
    "proveedor": "CLINICA PORTALES EL D",
    "total": 25.0,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "Visita médica / consulta — Gianna",
    "num_factura": ""
  },
  {
    "fecha": "2025-12-05",
    "proveedor": "CLINICA ALBROOK",
    "total": 45.0,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "Visita médica / consulta — Gianna",
    "num_factura": ""
  },
  {
    "fecha": "2025-12-09",
    "proveedor": "CLINICA ALBROOK",
    "total": 50.5,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "Visita médica / consulta — Gianna",
    "num_factura": ""
  },
  {
    "fecha": "2025-12-16",
    "proveedor": "CLINICA ALBROOK",
    "total": 30.0,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "Visita médica / consulta — Gianna",
    "num_factura": ""
  },
  {
    "fecha": "2025-12-17",
    "proveedor": "HOSPITAL SANTA FE",
    "total": 51.0,
    "categoria": "gastos_medicos",
    "alcance": "personal",
    "descripcion": "Visita médica / consulta — Gianna",
    "num_factura": ""
  }
];
var BATCH_TAG = 'BATCH-IMPORT-GIANNA-2025';

function importBatchGiannaDryRun() { _importBatchGianna_run(false); }
function importBatchGiannaEjecutar(){ _importBatchGianna_run(true);  }

function _importBatchGianna_run(ejecutar) {
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

  var byCat = {};
  for (var i = 0; i < BATCH_DATA.length; i++) {
    var c = BATCH_DATA[i].categoria;
    if (!byCat[c]) byCat[c] = { n: 0, total: 0 };
    byCat[c].n++;
    byCat[c].total += BATCH_DATA[i].total;
  }
  Object.keys(byCat).forEach(function(c) {
    Logger.log('  ' + c + ': ' + byCat[c].n + ' rows | $' + byCat[c].total.toFixed(2));
  });
  Logger.log('');

  if (dry) {
    Logger.log('Primeras 5 filas:');
    for (var j = 0; j < Math.min(5, BATCH_DATA.length); j++) {
      var r = BATCH_DATA[j];
      Logger.log('  ' + r.fecha + ' | ' + r.proveedor + ' | $' + r.total + ' | ' + r.categoria);
    }
    Logger.log('');
    Logger.log('Para insertar de verdad: corré importBatchGiannaEjecutar');
    return;
  }

  var ahora = new Date();
  var stamp = Utilities.formatDate(ahora, 'America/Panama', 'yyyyMMddHHmmss');
  var filas = [];
  for (var k = 0; k < BATCH_DATA.length; k++) {
    var item = BATCH_DATA[k];
    var fechaReg = Utilities.formatDate(ahora, 'America/Panama', 'yyyy-MM-dd HH:mm:ss');
    var egresoId = 'EGR-' + prefijo + '-' + Utilities.formatDate(ahora, 'America/Panama', 'yyyy') +
                   '-GIA' + String(k+1).padStart(3, '0') + '-' + stamp.slice(-6);
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
  sheet.getRange(startRow, 1, filas.length, EGRESOS_NCOLS).setBackground('#E8F5E9');

  Logger.log('✅ Insertados ' + filas.length + ' egresos en filas ' + startRow + '-' + (startRow + filas.length - 1));
  Logger.log('Refrescá el dashboard.');
  Logger.log('Para revertir: importBatchGiannaRollback');
}

function importBatchGiannaRollback() {
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
  Logger.log('✅ Anulados ' + count + ' egresos del batch Gianna.');
}
