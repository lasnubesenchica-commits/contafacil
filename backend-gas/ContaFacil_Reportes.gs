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
    var ingresos = _rptCargarIngresosAnio(year);
    var egresos  = _rptCargarEgresosAnio(year);

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
        ['Cierre Fiscal — Año ' + year, ''],
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

      // ── Cuerpo HTML del email ───────────────────────────────
      var fmt$ = function(n){
        return 'B/. ' + Number(n||0).toLocaleString('en-US',
          {minimumFractionDigits:2, maximumFractionDigits:2});
      };
      var cfg = _rptObtenerConfig();
      var empresa = cfg.empresa_nombre || 'Iris Albelo';
      var ruc     = cfg.empresa_ruc    || '';

      var html =
        '<div style="font-family:Arial,Helvetica,sans-serif;color:#1a2535;max-width:640px">' +
          '<h2 style="margin:0 0 .25em;color:#1a2535">Cierre Fiscal — Año ' + year + '</h2>' +
          '<div style="color:#64748b;font-size:13px;margin-bottom:1em">' +
            empresa + (ruc ? ' · RUC ' + ruc : '') +
          '</div>' +
          (mensaje ? '<div style="background:#f8fafc;border-left:3px solid #1565C0;' +
            'padding:.6em .9em;font-size:14px;margin:1em 0;white-space:pre-wrap">' +
            _rptEsc(mensaje) + '</div>' : '') +
          '<table cellpadding="8" cellspacing="0" style="border-collapse:collapse;' +
            'font-size:14px;margin:.6em 0;width:100%;max-width:520px">' +
            '<tr><td style="border:1px solid #e2e8f0"><b>Ingresos brutos</b></td>' +
                '<td style="border:1px solid #e2e8f0;text-align:right">' + fmt$(totIngBruto) + '</td></tr>' +
            '<tr><td style="border:1px solid #e2e8f0"><b>Gastos deducibles</b></td>' +
                '<td style="border:1px solid #e2e8f0;text-align:right;color:#6A1B9A">(' + fmt$(totEgr) + ')</td></tr>' +
            '<tr><td style="border:1px solid #e2e8f0"><b>Renta antes de ISR</b></td>' +
                '<td style="border:1px solid #e2e8f0;text-align:right;color:' +
                  (rentaAprox >= 0 ? '#2E7D32' : '#C62828') + ';font-weight:700">' +
                fmt$(rentaAprox) + '</td></tr>' +
            '<tr><td style="border:1px solid #e2e8f0"><b>ITBMS cobrado</b></td>' +
                '<td style="border:1px solid #e2e8f0;text-align:right;color:#1565C0">' + fmt$(totItbmsCob) + '</td></tr>' +
            '<tr><td style="border:1px solid #e2e8f0"><b>ITBMS pagado</b></td>' +
                '<td style="border:1px solid #e2e8f0;text-align:right;color:#6A1B9A">' + fmt$(totItbmsPag) + '</td></tr>' +
          '</table>' +
          '<p style="font-size:13px;color:#475569;margin:1em 0 .5em">' +
            '📎 Adjunto: <b>Cierre_' + year + '.xlsx</b> con detalle completo de ' +
            ingresos.length + ' ingreso' + (ingresos.length === 1 ? '' : 's') + ' y ' +
            egresos.length + ' gasto' + (egresos.length === 1 ? '' : 's') + '.' +
          '</p>' +
          (driveFolderUrl ?
            '<p style="font-size:13px;margin:.4em 0">' +
              '📁 <a href="' + driveFolderUrl + '" style="color:#1565C0">' +
              'Comprobantes en Google Drive</a>' +
            '</p>' : '') +
          '<hr style="border:none;border-top:1px solid #e2e8f0;margin:1.4em 0">' +
          '<div style="font-size:11px;color:#94a3b8">' +
            'Generado automáticamente desde BalanceClip — ' +
            Utilities.formatDate(new Date(), 'America/Panama', 'yyyy-MM-dd HH:mm') +
          '</div>' +
        '</div>';

      // ── Enviar a cada destinatario ──────────────────────────
      var subject = 'Cierre Fiscal ' + year + (empresa ? ' — ' + empresa : '');
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
