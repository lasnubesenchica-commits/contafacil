// ═══════════════════════════════════════════════════════════════
//  ContaFacil_Reportes — Envío de reportes por email
//
//  enviarReporteCierre(data)
//    Envía el Cierre Fiscal Anual de un año a uno o varios
//    destinatarios. Adjunta un Excel con detalle de ingresos
//    y gastos del año, y un link al folder de Drive con los
//    comprobantes (CONFIG.VOUCHER_FOLDER_ID).
//
//    Filtros aplicados (consistentes con el P&L del frontend):
//      - Ingresos: solo confirmado / abono / pendiente; year
//        derivado de anio_fiscal o (fallback) parseo de
//        fecha_ingreso.
//      - Egresos: excluye anulados, excluye alcance=personal
//        y excluye tipo_egreso=credito_fiscal. Year igual.
//
//    Espera: { action, year, emails, mensaje? }
//    Retorna: { success: true, sent: N } o { success:false, error }
// ═══════════════════════════════════════════════════════════════

function _handleEnviarReporteCierre(data) {
  try {
    var year = parseInt(data.year);
    if (!year) return _rptJson({ success:false, error:'year requerido' });

    var emails = String(data.emails || '')
      .split(/[,;\s]+/)
      .map(function(s){ return s.trim(); })
      .filter(Boolean);

    var emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    var bad = emails.filter(function(e){ return !emailRe.test(e); });
    if (bad.length) {
      return _rptJson({ success:false, error:'Emails inválidos: ' + bad.join(', ') });
    }
    if (!emails.length) {
      return _rptJson({ success:false, error:'Al menos un email requerido' });
    }

    var mensaje = String(data.mensaje || '').slice(0, 2000);

    // ── Recolectar ingresos del año ──────────────────────────────
    var ingresos    = _rptCargarIngresosAnio(year);
    var egresosAll  = _rptCargarEgresosAnioAll(year);          // incluye credito_fiscal (para ITBMS)
    var egresos     = egresosAll.filter(function(e){ return e.tipo_egreso !== 'credito_fiscal'; });

    // ── Generar Excel temporal ──────────────────────────────────
    var ts = Utilities.formatDate(new Date(), 'America/Panama', 'yyyyMMdd_HHmmss');
    var ssTemp = SpreadsheetApp.create('Cierre_' + year + '_' + ts);
    var fileId = ssTemp.getId();

    try {
      // Sheet Ingresos
      var sIng = ssTemp.getActiveSheet();
      sIng.setName('Ingresos');
      var headIng = ['Fecha','Mes','Año','N° Factura','Cliente','RUC',
                     'Tipo','Categoría','Subtotal','ITBMS','Total','Estado','Drive URL'];
      sIng.getRange(1,1,1,headIng.length).setValues([headIng])
          .setFontWeight('bold').setBackground('#1565C0').setFontColor('#ffffff');
      if (ingresos.length) {
        var rowsIng = ingresos.map(function(i){
          return [
            i.fecha_ingreso || '',
            i.mes           || '',
            i.anio_fiscal   || year,
            i.num_factura   || '',
            i.nombre_cliente|| '',
            i.ruc_cliente   || '',
            i.tipo_ingreso  || '',
            i.categoria_ingreso || '',
            Number(i.subtotal || 0),
            Number(i.itbms || 0),
            Number(i.total || 0),
            i.estado || '',
            i.drive_url || '',
          ];
        });
        sIng.getRange(2,1,rowsIng.length,headIng.length).setValues(rowsIng);
        sIng.getRange(2,9,rowsIng.length,3).setNumberFormat('"B/. "#,##0.00');
      }
      sIng.autoResizeColumns(1, headIng.length);
      sIng.setFrozenRows(1);

      // Sheet Gastos
      var sEgr = ssTemp.insertSheet('Gastos');
      var headEgr = ['Fecha','Mes','Año','N° Factura','Proveedor','RUC',
                     'Tipo Egreso (DGI)','Subtotal','ITBMS','Total',
                     'Alcance','Estado','Descripción','Drive URL'];
      sEgr.getRange(1,1,1,headEgr.length).setValues([headEgr])
          .setFontWeight('bold').setBackground('#6A1B9A').setFontColor('#ffffff');
      if (egresos.length) {
        var rowsEgr = egresos.map(function(e){
          return [
            e.fecha_egreso || '',
            e.mes          || '',
            e.anio         || year,
            e.num_fac_ref  || '',
            e.proveedor    || '',
            e.ruc_prov     || '',
            e.tipo_egreso  || 'sin_clasificar',
            Number(e.subtotal || 0),
            Number(e.itbms || 0),
            Number(e.total || 0),
            e.alcance      || 'negocio',
            e.estado       || '',
            e.descripcion  || '',
            e.drive_url    || '',
          ];
        });
        sEgr.getRange(2,1,rowsEgr.length,headEgr.length).setValues(rowsEgr);
        sEgr.getRange(2,8,rowsEgr.length,3).setNumberFormat('"B/. "#,##0.00');
      }
      sEgr.autoResizeColumns(1, headEgr.length);
      sEgr.setFrozenRows(1);

      // Sheet Resumen
      var sRes = ssTemp.insertSheet('Resumen', 0);
      var totIngBruto = ingresos.reduce(function(s,i){ return s + Number(i.subtotal||0); }, 0);
      var totItbmsCob = ingresos.reduce(function(s,i){ return s + Number(i.itbms||0); }, 0);
      var totEgr      = egresos .reduce(function(s,e){ return s + Number(e.total||0); }, 0);
      var totItbmsPag = egresos .reduce(function(s,e){ return s + Number(e.itbms||0); }, 0);
      var rentaAprox  = totIngBruto - totEgr;

      var resumen = [
        ['Informe Anual — Año ' + year, ''],
        ['', ''],
        ['Ingresos brutos (sin ITBMS)',     totIngBruto],
        ['ITBMS cobrado',                   totItbmsCob],
        ['Total gastos deducibles',         totEgr],
        ['ITBMS pagado',                    totItbmsPag],
        ['', ''],
        ['Renta antes de ISR (aproximada)', rentaAprox],
        ['', ''],
        ['Generado',  Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm')],
        ['N° ingresos', ingresos.length],
        ['N° gastos',   egresos.length],
      ];
      sRes.getRange(1,1,resumen.length,2).setValues(resumen);
      sRes.getRange(1,1,1,2).setFontWeight('bold').setFontSize(13);
      sRes.getRange(3,2,4,1).setNumberFormat('"B/. "#,##0.00');
      sRes.getRange(8,2,1,1).setNumberFormat('"B/. "#,##0.00').setFontWeight('bold');
      sRes.setColumnWidth(1, 280);
      sRes.setColumnWidth(2, 180);

      SpreadsheetApp.flush();

      // ── Exportar como xlsx ──────────────────────────────────
      var xlsxUrl = 'https://docs.google.com/spreadsheets/d/' + fileId +
                    '/export?format=xlsx&id=' + fileId;
      var blob = UrlFetchApp.fetch(xlsxUrl, {
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
        muteHttpExceptions: true,
      }).getBlob().setName('Cierre_' + year + '.xlsx');

      // ── Drive folder con comprobantes ───────────────────────
      var driveFolderUrl = '';
      try {
        var folder = DriveApp.getFolderById(CONFIG.VOUCHER_FOLDER_ID);
        driveFolderUrl = folder.getUrl();
      } catch (eDrive) {
        Logger.log('No se pudo obtener folder Drive: ' + eDrive.message);
      }

      // ── Cuerpo HTML del email (estilo dashboard) ────────────
      var cfg     = _rptObtenerConfig();
      var empresa = cfg.empresa_nombre || 'Iris Albelo';
      var ruc     = cfg.empresa_ruc    || '';

      var aggregates = _rptComputeDgiAggregates(ingresos, egresosAll, year);
      var html = _rptBuildEmailHtml(aggregates, {
        empresa:     empresa,
        ruc:         ruc,
        mensaje:     mensaje,
        driveUrl:    driveFolderUrl,
        generadoStr: Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm'),
        vencimiento: '31 marzo ' + (year + 1),
        nIngresos:   ingresos.length,
        nEgresos:    egresos.length,
      });

      // ── Enviar a cada destinatario ──────────────────────────
      var subject = 'Informe Anual ' + year + (empresa ? ' — ' + empresa : '');
      emails.forEach(function(to){
        GmailApp.sendEmail(to, subject, '', {
          htmlBody:    html,
          attachments: [blob],
          name:        empresa + ' · BalanceClip',
        });
      });

      Logger.log('enviarReporteCierre OK · year=' + year + ' · sent=' + emails.length);
      return _rptJson({ success:true, sent: emails.length });

    } finally {
      // Cleanup: enviar el spreadsheet temporal a la papelera
      try { DriveApp.getFileById(fileId).setTrashed(true); }
      catch (eClean) { Logger.log('No se pudo borrar tmp: ' + eClean.message); }
    }

  } catch (err) {
    Logger.log('Error _handleEnviarReporteCierre: ' + err.message);
    return _rptJson({ success:false, error: err.message });
  }
}

// ── Helpers internos ────────────────────────────────────────────

function _rptJson(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function _rptEsc(s) {
  return String(s||'')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

function _rptYearFromRow(direct, fechaStr) {
  var y = parseInt(direct);
  if (y) return y;
  var m = String(fechaStr || '').match(/^(\d{4})/);
  return m ? parseInt(m[1]) : 0;
}

function _rptCargarIngresosAnio(year) {
  var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.SHEET_INGRESOS);
  if (!sheet || sheet.getLastRow() <= 2) return [];

  var ncols = Math.min(sheet.getLastColumn(), INGRESOS_NCOLS);
  var data  = sheet.getRange(3, 1, sheet.getLastRow() - 2, ncols).getValues();
  var out   = [];
  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    if (!r[COL_I.ID_TRANS - 1]) continue;
    var estado = String(r[COL_I.ESTADO - 1] || '').toLowerCase();
    if (estado !== 'confirmado' && estado !== 'abono' && estado !== 'pendiente') continue;

    var fechaIng = r[COL_I.FECHA_INGRESO - 1];
    if (fechaIng instanceof Date) {
      fechaIng = Utilities.formatDate(fechaIng, 'America/Panama', 'yyyy-MM-dd');
    } else {
      fechaIng = String(fechaIng || '').slice(0, 10);
    }

    var anio = _rptYearFromRow(r[COL_I.ANIO_FISCAL - 1], fechaIng);
    if (anio !== year) continue;

    out.push({
      id_trans:          r[COL_I.ID_TRANS - 1],
      estado:            estado,
      fecha_ingreso:     fechaIng,
      mes:               r[COL_I.MES - 1] || '',
      anio_fiscal:       r[COL_I.ANIO_FISCAL - 1] || anio,
      subtotal:          parseFloat(r[COL_I.SUBTOTAL - 1]) || 0,
      itbms:             parseFloat(r[COL_I.ITBMS - 1])    || 0,
      total:             parseFloat(r[COL_I.TOTAL - 1])    || 0,
      tipo_ingreso:      r[COL_I.TIPO_INGRESO - 1] || '',
      categoria_ingreso: r[COL_I.CATEGORIA - 1]    || '',
      nombre_cliente:    r[COL_I.NOMBRE_CLI - 1]   || '',
      ruc_cliente:       r[COL_I.RUC_CLI - 1]      || '',
      num_factura:       r[COL_I.NUM_FACTURA - 1]  || '',
      drive_url:         String(r[COL_I.DRIVE_URL - 1] || '').trim(),
    });
  }
  return out;
}

function _rptCargarEgresosAnio(year) {
  var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_EGRESOS);
  if (!sheet || sheet.getLastRow() <= 2) return [];

  var ncols = Math.min(sheet.getLastColumn(), EGRESOS_NCOLS);
  var data  = sheet.getRange(3, 1, sheet.getLastRow() - 2, ncols).getValues();
  var out   = [];
  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    if (!r[COL_E.ID - 1]) continue;
    if (String(r[COL_E.ESTADO - 1] || '').toLowerCase() === 'anulado') continue;

    var alcance = (ncols >= COL_E.ALCANCE) ? (r[COL_E.ALCANCE - 1] || 'negocio') : 'negocio';
    if (alcance === 'personal') continue;                       // no deducible — fuera de cierre
    var tipoEgr = String(r[COL_E.TIPO_EGRESO - 1] || '');
    if (tipoEgr === 'credito_fiscal') continue;                 // se reporta aparte en ITBMS

    var fechaEgr = r[COL_E.FECHA_GASTO - 1];
    if (fechaEgr instanceof Date) {
      fechaEgr = Utilities.formatDate(fechaEgr, 'America/Panama', 'yyyy-MM-dd');
    } else {
      fechaEgr = String(fechaEgr || '').slice(0, 10);
    }

    var anio = _rptYearFromRow(r[COL_E.ANIO - 1], fechaEgr);
    if (anio !== year) continue;

    out.push({
      id_egreso:    r[COL_E.ID - 1],
      estado:       r[COL_E.ESTADO - 1] || 'registrado',
      fecha_egreso: fechaEgr,
      mes:          r[COL_E.MES - 1]    || '',
      anio:         r[COL_E.ANIO - 1]   || anio,
      tipo_egreso:  tipoEgr,
      categoria:    r[COL_E.CATEGORIA - 1]   || '',
      subtotal:     parseFloat(r[COL_E.SUBTOTAL - 1]) || 0,
      itbms:        parseFloat(r[COL_E.ITBMS - 1])    || 0,
      total:        parseFloat(r[COL_E.TOTAL - 1])    || 0,
      proveedor:    r[COL_E.PROVEEDOR - 1]   || '',
      ruc_prov:     r[COL_E.RUC_PROV - 1]    || '',
      num_fac_ref:  r[COL_E.NFACTURA - 1]    || '',
      drive_url:    String(r[COL_E.DRIVE_URL - 1] || '').trim(),
      descripcion:  r[COL_E.DESCRIPCION - 1] || '',
      alcance:      alcance,
    });
  }
  return out;
}

function _rptObtenerConfig() {
  // Lee config_operaciones si existe; degrada a {} en caso de error
  try {
    var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName('config_operaciones');
    if (!sheet) return {};
    var rows = sheet.getDataRange().getValues();
    var out  = {};
    for (var i = 1; i < rows.length; i++) {
      var k = String(rows[i][0] || '').trim();
      if (k) out[k] = rows[i][1];
    }
    return out;
  } catch (e) {
    return {};
  }
}

// ── Labels DGI (espejo del frontend) ────────────────────────────
var _RPT_ING_LABELS = {
  venta_producto_gravado:   'Venta de productos (gravado)',
  venta_producto_exento:    'Venta de productos (exento)',
  venta_producto:           'Venta de productos',
  servicio_tecnico_gravado: 'Servicios técnicos / proyectos (gravado)',
  servicio_tecnico_exento:  'Servicios técnicos / proyectos (exento)',
  servicio_tecnico:         'Servicios técnicos / proyectos',
  asesoria_consultoria:     'Asesoría y consultoría',
  comision:                 'Comisiones',
  exportacion:              'Exportación',
  otro_gravado:             'Otros ingresos gravados',
  otro_exento:              'Otros ingresos exentos',
  otro:                     'Otros ingresos',
};
var _RPT_EGR_LABELS = {
  costo_mercancia:          'Costo de mercancía vendida',
  costo_servicio_tecnico:   'Costo de servicios técnicos',
  impuesto_importacion:     'Impuestos de importación',
  costo_operativo:          'Gastos operativos',
  nomina:                   'Nómina y salarios',
  servicios:                'Servicios contratados',
  servicios_publicos:       'Servicios públicos',
  combustible_transporte:   'Combustible y transporte',
  publicidad_mercadeo:      'Publicidad y mercadeo',
  honorarios_profesionales: 'Honorarios profesionales',
  mantenimiento_reparacion: 'Mantenimiento y reparaciones',
  seguros:                  'Seguros',
  gastos_financieros:       'Gastos financieros',
  vigilancia_seguridad:     'Vigilancia y seguridad',
  cargos_bancarios:         'Cargos bancarios',
  alquileres:               'Alquileres',
  gastos_oficina:           'Gastos de oficina',
  telecomunicaciones:       'Telecomunicaciones',
  tecnologia_software:      'Tecnología y software',
  capacitacion:             'Capacitación',
  prestaciones_laborales:   'Prestaciones laborales',
  gastos_representacion:    'Gastos de representación',
  impuestos_tasas:          'Impuestos y tasas',
  depreciacion:             'Depreciación',
  amortizacion:             'Amortización',
  otros_deducibles:         'Otros gastos deducibles',
  sin_clasificar:           'Sin clasificar',
};
var _RPT_COSTO_KEYS = ['costo_mercancia','costo_servicio_tecnico','impuesto_importacion'];
var _RPT_MESES_LBL = ['','Enero','Febrero','Marzo','Abril','Mayo','Junio',
                      'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

function _rptIngLabel(k) { return _RPT_ING_LABELS[k] || (k || '—'); }
function _rptEgrLabel(k) { return _RPT_EGR_LABELS[k] || (k || 'Sin clasificar'); }

function _rptFmt(n) {
  return 'B/. ' + Number(n||0).toLocaleString('en-US',
    {minimumFractionDigits:2, maximumFractionDigits:2});
}

// ── Carga de egresos sin filtrar credito_fiscal (para split en email) ──
function _rptCargarEgresosAnioAll(year) {
  var ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_EGRESOS);
  if (!sheet || sheet.getLastRow() <= 2) return [];

  var ncols = Math.min(sheet.getLastColumn(), EGRESOS_NCOLS);
  var data  = sheet.getRange(3, 1, sheet.getLastRow() - 2, ncols).getValues();
  var out   = [];
  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    if (!r[COL_E.ID - 1]) continue;
    if (String(r[COL_E.ESTADO - 1] || '').toLowerCase() === 'anulado') continue;

    var alcance = (ncols >= COL_E.ALCANCE) ? (r[COL_E.ALCANCE - 1] || 'negocio') : 'negocio';
    if (alcance === 'personal') continue;

    var fechaEgr = r[COL_E.FECHA_GASTO - 1];
    if (fechaEgr instanceof Date) {
      fechaEgr = Utilities.formatDate(fechaEgr, 'America/Panama', 'yyyy-MM-dd');
    } else {
      fechaEgr = String(fechaEgr || '').slice(0, 10);
    }
    var anio = _rptYearFromRow(r[COL_E.ANIO - 1], fechaEgr);
    if (anio !== year) continue;

    out.push({
      id_egreso:    r[COL_E.ID - 1],
      estado:       r[COL_E.ESTADO - 1] || 'registrado',
      fecha_egreso: fechaEgr,
      mes:          r[COL_E.MES - 1] || '',
      anio:         r[COL_E.ANIO - 1] || anio,
      tipo_egreso:  String(r[COL_E.TIPO_EGRESO - 1] || ''),
      categoria:    r[COL_E.CATEGORIA - 1]   || '',
      subtotal:     parseFloat(r[COL_E.SUBTOTAL - 1]) || 0,
      itbms:        parseFloat(r[COL_E.ITBMS - 1])    || 0,
      total:        parseFloat(r[COL_E.TOTAL - 1])    || 0,
      proveedor:    r[COL_E.PROVEEDOR - 1]   || '',
      ruc_prov:     r[COL_E.RUC_PROV - 1]    || '',
      num_fac_ref:  r[COL_E.NFACTURA - 1]    || '',
      drive_url:    String(r[COL_E.DRIVE_URL - 1] || '').trim(),
      descripcion:  r[COL_E.DESCRIPCION - 1] || '',
      alcance:      alcance,
    });
  }
  return out;
}

// ── Computa todos los agregados DGI necesarios para el email ────
function _rptComputeDgiAggregates(ingresos, egresosAll, year) {
  var egrNormal = egresosAll.filter(function(e){ return e.tipo_egreso !== 'credito_fiscal'; });
  var egrCred   = egresosAll.filter(function(e){ return e.tipo_egreso === 'credito_fiscal'; });

  var ingGrav = ingresos.filter(function(i){ return !String(i.categoria_ingreso||'').includes('exento'); });
  var ingExe  = ingresos.filter(function(i){ return  String(i.categoria_ingreso||'').includes('exento'); });

  var sum = function(arr, k){ return arr.reduce(function(s,x){ return s + Number(x[k]||0); }, 0); };

  var totalIngBruto   = sum(ingresos, 'subtotal');
  var totalIngGravado = sum(ingGrav, 'subtotal');
  var totalIngExento  = sum(ingExe,  'subtotal');
  var totalITBMSCob   = sum(ingresos, 'itbms');

  // Egresos por tipo (con default sin_clasificar para vacíos)
  var egrPorTipo = {};
  egrNormal.forEach(function(e){
    var k = e.tipo_egreso || 'sin_clasificar';
    if (!egrPorTipo[k]) egrPorTipo[k] = { total:0, itbms:0, n:0 };
    egrPorTipo[k].total += Number(e.total||0);
    egrPorTipo[k].itbms += Number(e.itbms||0);
    egrPorTipo[k].n++;
  });
  var totalEgr          = sum(egrNormal, 'total');
  var totalCostoVentas  = _RPT_COSTO_KEYS.reduce(function(s,k){
    return s + ((egrPorTipo[k] && egrPorTipo[k].total) || 0);
  }, 0);
  var totalGastosDed    = totalEgr - totalCostoVentas;
  var totalITBMSPag     = sum(egrNormal, 'itbms');
  var totalCredFisc     = sum(egrCred, 'total');
  var itbmsNeto         = totalITBMSCob - totalITBMSPag - totalCredFisc;

  var rentaNeta = totalIngGravado - totalCostoVentas - totalGastosDed;
  var isrTrad   = rentaNeta > 0 ? rentaNeta * 0.25 : 0;

  // ITBMS por mes
  var itbmsPorMes = [];
  for (var m = 1; m <= 12; m++) {
    var ingM = ingresos.filter(function(x){ return _rptMesOf(x, 'fecha_ingreso') === m; });
    var egrM = egresosAll.filter(function(x){ return _rptMesOf(x, 'fecha_egreso') === m; });
    var cobr = sum(ingM, 'itbms');
    var pag  = egrM.filter(function(x){ return x.tipo_egreso !== 'credito_fiscal'; })
                   .reduce(function(s,x){ return s + Number(x.itbms||0); }, 0);
    var cred = egrM.filter(function(x){ return x.tipo_egreso === 'credito_fiscal'; })
                   .reduce(function(s,x){ return s + Number(x.total||0); }, 0);
    if (cobr > 0 || pag > 0 || cred > 0) {
      itbmsPorMes.push({ m: m, cobrado: cobr, pagado: pag, credito: cred,
                          neto: cobr - pag - cred });
    }
  }

  return {
    year: year,
    nIng: ingresos.length, nEgrNormal: egrNormal.length, nEgrCred: egrCred.length,
    totalIngBruto: totalIngBruto,
    totalIngGravado: totalIngGravado,
    totalIngExento: totalIngExento,
    totalITBMSCob: totalITBMSCob,
    totalEgr: totalEgr,
    totalCostoVentas: totalCostoVentas,
    totalGastosDed: totalGastosDed,
    totalITBMSPag: totalITBMSPag,
    totalCredFisc: totalCredFisc,
    itbmsNeto: itbmsNeto,
    rentaNeta: rentaNeta,
    isrTrad: isrTrad,
    egrPorTipo: egrPorTipo,
    itbmsPorMes: itbmsPorMes,
  };
}

function _rptMesOf(reg, fechaKey) {
  var direct = parseInt(reg.mes);
  if (direct) return direct;
  var m = String(reg[fechaKey] || '').match(/^\d{4}-(\d{2})/);
  return m ? parseInt(m[1]) : 0;
}

// ── Construir HTML del email (tipo dashboard, email-safe) ───────
function _rptBuildEmailHtml(d, ctx) {
  // d: aggregates de _rptComputeDgiAggregates
  // ctx: { empresa, ruc, mensaje, driveUrl, generadoStr, vencimiento, year, nIngresos, nEgresos }
  var year = d.year;
  var fmt$ = _rptFmt;

  // ── Letterhead ─────────────────────────────────────────────
  var letterhead =
    '<tr><td style="background:#1a2535;padding:18px 24px" colspan="2">' +
      '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>' +
        '<td style="vertical-align:top">' +
          '<div style="font-family:Arial Black,Helvetica,sans-serif;font-size:22px;letter-spacing:.06em;color:#fff;line-height:1">' +
            _rptEsc(ctx.empresa) +
          '</div>' +
          '<div style="font-size:11px;color:rgba(255,255,255,.65);margin-top:4px">' +
            'Informe Anual' +
          '</div>' +
        '</td>' +
        '<td style="text-align:right;vertical-align:top;font-size:11px;color:rgba(255,255,255,.78);line-height:1.7">' +
          (ctx.ruc ? '<div><b style="color:#fff">RUC:</b> ' + _rptEsc(ctx.ruc) + '</div>' : '') +
          '<div><b style="color:#fff">Período fiscal:</b> 1 Ene – 31 Dic ' + year + '</div>' +
          '<div><b style="color:#fff">Generado:</b> ' + _rptEsc(ctx.generadoStr) + '</div>' +
        '</td>' +
      '</tr></table>' +
    '</td></tr>';

  // ── Title bar (orange) ─────────────────────────────────────
  var titleBar =
    '<tr><td colspan="2" style="background:#E65100;color:#fff;padding:12px 24px">' +
      '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>' +
        '<td style="font-family:Arial Black,Helvetica,sans-serif;font-size:15px;letter-spacing:.06em;color:#fff">' +
          'INFORME ANUAL — AÑO ' + year +
        '</td>' +
        '<td style="text-align:right;font-size:11px;color:rgba(255,255,255,.85)">' +
          'Vencimiento: ' + _rptEsc(ctx.vencimiento) +
        '</td>' +
      '</tr></table>' +
    '</td></tr>';

  // ── Mensaje del usuario (opcional) ─────────────────────────
  var mensajeBox = ctx.mensaje
    ? '<tr><td colspan="2" style="padding:14px 24px 0">' +
        '<div style="background:#f8fafc;border-left:3px solid #1565C0;padding:10px 14px;font-size:13px;white-space:pre-wrap;color:#475569">' +
          _rptEsc(ctx.mensaje) +
        '</div>' +
      '</td></tr>'
    : '';

  // ── Helper: encabezado de sección numerado ─────────────────
  var secHdr = function(num, title, subtitle) {
    return '<tr><td colspan="2" style="padding:18px 24px 4px">' +
      '<div style="border-bottom:2px solid #e2e8f0;padding-bottom:6px;font-family:DM Mono,Courier,monospace;font-size:11px;letter-spacing:.1em;text-transform:uppercase;font-weight:700;color:#1a2535">' +
        '<span style="display:inline-block;width:18px;height:18px;border-radius:50%;background:#1a2535;color:#fff;text-align:center;line-height:18px;font-size:10px;margin-right:8px;vertical-align:middle">' + num + '</span>' +
        title +
        (subtitle ? '<span style="float:right;font-weight:400;font-size:10px;color:#64748b;text-transform:none;letter-spacing:0">' + _rptEsc(subtitle) + '</span>' : '') +
      '</div>' +
    '</td></tr>';
  };

  // ── Sección 1: Mapa DGI ────────────────────────────────────
  var dgiRow = function(linea, label, note, valor, opts) {
    opts = opts || {};
    var bg = opts.highlight ? '#FFFDE7' : (opts.total ? '#f5f5f5' : 'transparent');
    var color = opts.color || '#1a2535';
    var fontWeight = opts.total ? '700' : '400';
    return '<tr style="background:' + bg + '">' +
      '<td style="font-family:DM Mono,Courier,monospace;font-size:11px;color:#94a3b8;padding:9px 8px;border-right:1px solid #f1f5f9;width:30px;text-align:center" valign="middle">' + linea + '</td>' +
      '<td style="padding:9px 12px;font-size:13px;font-weight:' + fontWeight + '" valign="middle">' +
        label +
        (note ? '<div style="font-size:10px;color:#94a3b8;margin-top:2px;font-weight:400">' + note + '</div>' : '') +
      '</td>' +
      '<td style="padding:9px 16px;font-family:DM Mono,Courier,monospace;font-size:14px;font-weight:600;text-align:right;white-space:nowrap;color:' + color + '" valign="middle">' + valor + '</td>' +
    '</tr>';
  };
  var dgiTable =
    '<tr><td colspan="2" style="padding:0 24px 8px">' +
      '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e2e8f0;border-radius:6px">' +
        dgiRow('A', 'Ingresos brutos gravables', 'Fuente panameña, sin ITBMS', fmt$(d.totalIngGravado), { highlight:true }) +
        dgiRow('B', 'Ingresos exentos', 'Servicios exentos · no gravables ISR',
               (d.totalIngExento > 0 ? fmt$(d.totalIngExento) : '—'),
               { color: d.totalIngExento > 0 ? '#1a2535' : '#94a3b8' }) +
        dgiRow('',  'Total ingresos brutos', '', fmt$(d.totalIngBruto), { total:true }) +
        dgiRow('C', 'Costo de ventas / servicios', 'Costo mercancía + ST + imp. importación',
               '(' + fmt$(d.totalCostoVentas) + ')', { highlight:true, color:'#E65100' }) +
        dgiRow('D', 'Gastos deducibles de operación', 'Nómina, honorarios, servicios, mantenimiento…',
               '(' + fmt$(d.totalGastosDed) + ')', { highlight:true, color:'#E65100' }) +
        dgiRow('',  'Total costos y gastos deducibles', '',
               '(' + fmt$(d.totalEgr) + ')', { total:true, color:'#E65100' }) +
        dgiRow('E', 'Renta neta gravable (A − C − D)', '',
               fmt$(d.rentaNeta),
               { total:true, color: d.rentaNeta >= 0 ? '#2E7D32' : '#C62828' }) +
        '<tr style="background:#1a2535"><td style="padding:11px 8px;color:rgba(255,255,255,.5);font-family:DM Mono,Courier,monospace;font-size:11px;border-right:1px solid rgba(255,255,255,.1);text-align:center;width:30px" valign="middle">F</td>' +
          '<td style="padding:11px 12px;font-size:13px;color:#fff;font-weight:600" valign="middle">' +
            'ISR estimado — Método tradicional (25%)' +
            '<div style="font-size:10px;color:rgba(255,255,255,.55);margin-top:2px;font-weight:400">' +
              'El CPA validará deducciones, créditos fiscales y CAIR antes de declarar' +
            '</div>' +
          '</td>' +
          '<td style="padding:11px 16px;font-family:DM Mono,Courier,monospace;font-size:15px;font-weight:700;color:#fff;text-align:right" valign="middle">' +
            (d.rentaNeta > 0 ? fmt$(d.isrTrad) : 'B/. 0.00') +
          '</td></tr>' +
      '</table>' +
      (d.rentaNeta <= 0
        ? '<div style="margin-top:10px;padding:8px 12px;background:#E8F5E9;border-left:3px solid #2E7D32;font-size:12px;color:#2E7D32">' +
            '&#x2713; La empresa reporta pérdida fiscal en ' + year + ' — no hay ISR a pagar por este período.' +
          '</div>'
        : '<div style="margin-top:10px;padding:8px 12px;background:#FFF8E1;border-left:3px solid #FFA000;font-size:12px;color:#5D4037">' +
            'Este es el ISR estimado. El CPA debe validar deducciones adicionales y determinar si aplica CAIR antes de presentar la declaración definitiva.' +
          '</div>') +
    '</td></tr>';

  // ── Sección 2: Top categorías de gastos ─────────────────────
  var topCats = Object.keys(d.egrPorTipo).map(function(k){
    return [k, d.egrPorTipo[k]];
  }).sort(function(a,b){ return b[1].total - a[1].total; }).slice(0, 8);

  var catRows = topCats.map(function(pair){
    var k = pair[0], v = pair[1];
    var pct = d.totalEgr > 0 ? (v.total / d.totalEgr * 100).toFixed(1) : '0.0';
    var esCosto = _RPT_COSTO_KEYS.indexOf(k) !== -1;
    return '<tr>' +
      '<td style="padding:7px 12px;font-size:12px;border-bottom:1px solid #f1f5f9">' + _rptEsc(_rptEgrLabel(k)) + '</td>' +
      '<td style="padding:7px 12px;font-size:11px;color:#64748b;border-bottom:1px solid #f1f5f9">' + (esCosto ? 'Costo de ventas' : 'Gasto deducible') + '</td>' +
      '<td style="padding:7px 12px;font-size:12px;text-align:right;border-bottom:1px solid #f1f5f9">' + v.n + '</td>' +
      '<td style="padding:7px 12px;font-family:DM Mono,Courier,monospace;font-size:12px;font-weight:600;text-align:right;border-bottom:1px solid #f1f5f9">' + fmt$(v.total) + '</td>' +
      '<td style="padding:7px 12px;font-family:DM Mono,Courier,monospace;font-size:11px;color:#64748b;text-align:right;border-bottom:1px solid #f1f5f9">' + pct + '%</td>' +
    '</tr>';
  }).join('');
  var catTable =
    '<tr><td colspan="2" style="padding:0 24px 8px">' +
      '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e2e8f0;border-radius:6px">' +
        '<tr style="background:#f8fafc">' +
          '<th style="text-align:left;padding:7px 12px;font-family:DM Mono,Courier,monospace;font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:#64748b">Tipo de gasto</th>' +
          '<th style="text-align:left;padding:7px 12px;font-family:DM Mono,Courier,monospace;font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:#64748b">Clasificación DGI</th>' +
          '<th style="text-align:right;padding:7px 12px;font-family:DM Mono,Courier,monospace;font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:#64748b">N° reg.</th>' +
          '<th style="text-align:right;padding:7px 12px;font-family:DM Mono,Courier,monospace;font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:#64748b">Total</th>' +
          '<th style="text-align:right;padding:7px 12px;font-family:DM Mono,Courier,monospace;font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:#64748b">%</th>' +
        '</tr>' +
        catRows +
        '<tr style="background:#f5f5f5">' +
          '<td colspan="2" style="padding:9px 12px;font-size:12px;font-weight:700;border-top:2px solid #e2e8f0">Total costos y gastos</td>' +
          '<td style="padding:9px 12px;font-size:12px;font-weight:700;text-align:right;border-top:2px solid #e2e8f0">' + d.nEgrNormal + '</td>' +
          '<td style="padding:9px 12px;font-family:DM Mono,Courier,monospace;font-size:13px;font-weight:700;text-align:right;border-top:2px solid #e2e8f0">' + fmt$(d.totalEgr) + '</td>' +
          '<td style="padding:9px 12px;font-family:DM Mono,Courier,monospace;font-size:12px;font-weight:700;text-align:right;border-top:2px solid #e2e8f0">100%</td>' +
        '</tr>' +
      '</table>' +
    '</td></tr>';

  // ── Sección 3: ITBMS resumen ────────────────────────────────
  var itbKpiCard = function(label, value, color) {
    return '<td style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:10px 14px;width:25%" valign="top">' +
      '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#64748b;margin-bottom:4px">' + label + '</div>' +
      '<div style="font-family:Arial Black,Helvetica,sans-serif;font-size:18px;line-height:1;color:' + color + '">' + value + '</div>' +
    '</td>';
  };
  var itbKpis =
    '<tr><td colspan="2" style="padding:0 24px 8px">' +
      '<table width="100%" cellpadding="0" cellspacing="6" style="border-collapse:separate;border-spacing:6px"><tr>' +
        itbKpiCard('Total cobrado', fmt$(d.totalITBMSCob), '#1565C0') +
        itbKpiCard('Total pagado',  fmt$(d.totalITBMSPag), '#6A1B9A') +
        itbKpiCard('Crédito fiscal', fmt$(d.totalCredFisc), '#00695C') +
        itbKpiCard(d.itbmsNeto >= 0 ? 'Neto a DGI' : 'Saldo a favor',
                   fmt$(Math.abs(d.itbmsNeto)),
                   d.itbmsNeto >= 0 ? '#E65100' : '#2E7D32') +
      '</tr></table>' +
    '</td></tr>';

  var itbMesRows = d.itbmsPorMes.map(function(r){
    var color = r.neto >= 0 ? '#E65100' : '#2E7D32';
    return '<tr>' +
      '<td style="padding:6px 12px;font-size:12px;font-weight:600;border-bottom:1px solid #f1f5f9">' + _RPT_MESES_LBL[r.m] + '</td>' +
      '<td style="padding:6px 12px;font-family:DM Mono,Courier,monospace;font-size:12px;text-align:right;border-bottom:1px solid #f1f5f9">' + (r.cobrado>0?fmt$(r.cobrado):'—') + '</td>' +
      '<td style="padding:6px 12px;font-family:DM Mono,Courier,monospace;font-size:12px;text-align:right;color:#6A1B9A;border-bottom:1px solid #f1f5f9">' + (r.pagado>0?fmt$(r.pagado):'—') + '</td>' +
      '<td style="padding:6px 12px;font-family:DM Mono,Courier,monospace;font-size:12px;text-align:right;color:#00695C;border-bottom:1px solid #f1f5f9">' + (r.credito>0?fmt$(r.credito):'—') + '</td>' +
      '<td style="padding:6px 12px;font-family:DM Mono,Courier,monospace;font-size:12px;font-weight:600;text-align:right;color:' + color + ';border-bottom:1px solid #f1f5f9">' + fmt$(r.neto) + '</td>' +
    '</tr>';
  }).join('');
  var itbTable = d.itbmsPorMes.length ?
    '<tr><td colspan="2" style="padding:0 24px 8px">' +
      '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e2e8f0;border-radius:6px">' +
        '<tr style="background:#f8fafc">' +
          '<th style="text-align:left;padding:7px 12px;font-family:DM Mono,Courier,monospace;font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:#64748b">Mes</th>' +
          '<th style="text-align:right;padding:7px 12px;font-family:DM Mono,Courier,monospace;font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:#64748b">Cobrado</th>' +
          '<th style="text-align:right;padding:7px 12px;font-family:DM Mono,Courier,monospace;font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:#64748b">Pagado</th>' +
          '<th style="text-align:right;padding:7px 12px;font-family:DM Mono,Courier,monospace;font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:#64748b">Crédito</th>' +
          '<th style="text-align:right;padding:7px 12px;font-family:DM Mono,Courier,monospace;font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:#64748b">Neto</th>' +
        '</tr>' +
        itbMesRows +
      '</table>' +
    '</td></tr>'
  : '<tr><td colspan="2" style="padding:0 24px 8px;font-size:12px;color:#94a3b8">Sin movimientos ITBMS en ' + year + '.</td></tr>';

  // ── Adjunto + Drive + footer ───────────────────────────────
  var adjunto =
    '<tr><td colspan="2" style="padding:18px 24px 8px">' +
      '<div style="background:#E3F2FD;border:1px solid #90CAF9;border-radius:6px;padding:12px 14px;font-size:13px;color:#0D47A1">' +
        '<b>Adjunto:</b> Cierre_' + year + '.xlsx con detalle completo de ' +
        ctx.nIngresos + ' ingreso' + (ctx.nIngresos===1?'':'s') + ' y ' +
        ctx.nEgresos + ' gasto' + (ctx.nEgresos===1?'':'s') +
        ' (incluye hoja Resumen, Ingresos y Gastos).' +
      '</div>' +
      (ctx.driveUrl
        ? '<div style="margin-top:8px;padding:12px 14px;background:#FFF8E1;border:1px solid #FFE082;border-radius:6px;font-size:13px;color:#5D4037">' +
            '<b>Comprobantes:</b> <a href="' + _rptEsc(ctx.driveUrl) + '" style="color:#1565C0;text-decoration:underline">Folder en Google Drive</a>' +
          '</div>'
        : '') +
    '</td></tr>';

  var footer =
    '<tr><td colspan="2" style="padding:14px 24px 18px;background:#f8fafc;border-top:1px solid #e2e8f0">' +
      '<div style="font-size:10px;color:#94a3b8;line-height:1.6">' +
        'Generado automáticamente desde BalanceClip · ' + _rptEsc(ctx.generadoStr) + '<br>' +
        'Este documento es una preparación interna y no sustituye la declaración formal ante DGI. ' +
        'Su CPA debe validar y firmar el formulario oficial.' +
      '</div>' +
    '</td></tr>';

  return '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#f0f2f5;font-family:Helvetica,Arial,sans-serif"><tr><td align="center" style="padding:20px 10px">' +
    '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#fff;max-width:720px;width:100%;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">' +
      letterhead + titleBar + mensajeBox +
      secHdr('1', 'Resumen para declaración jurada · líneas DGI', 'Formulario Jurídica General · Método tradicional') +
      dgiTable +
      secHdr('2', 'Detalle de costos y gastos deducibles', d.nEgrNormal + ' registros · ' + fmt$(d.totalEgr)) +
      catTable +
      secHdr('3', 'ITBMS · Resumen anual ' + year, 'Declaraciones mensuales (Formulario DGI)') +
      itbKpis + itbTable +
      adjunto + footer +
    '</table>' +
  '</td></tr></table>';
}
