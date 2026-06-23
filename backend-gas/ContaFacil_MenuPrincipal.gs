// ════════════════════════════════════════════════════════════════════
//  MENÚ PRINCIPAL — WhatsApp
//  ──────────────────────────────────────────────────────────────────
//  Punto único de entrada para que el cliente descubra todas las
//  funcionalidades del bot sin tener que adivinar qué escribir.
//
//  Estructura:
//    Nivel 0 — Welcome (2 botones): primer contacto / saludos
//    Nivel 1 — Menú principal (list message): 10 opciones en 4 secciones
//    Nivel 2 — Sub-flujos: acciones específicas (rule-based o
//              conversacionales con intent stored en CacheService)
//
//  Convención: row ids con prefijo `menu:<accion>[:<param>]`.
//  Dispatcher en ContaFacil_WhatsApp.gs detecta el prefix y delega
//  a _menuHandleTap.
// ════════════════════════════════════════════════════════════════════

// Sin regionalismos en strings dirigidos al usuario: tú/usted neutro,
// imperativo en 2da persona estándar (toca, ve, escribe, dime, etc.)

var MENU_INTENT_TTL_SEC  = 10 * 60;       // 10 min para mantener intent activo
var MENU_INTENT_KEY_PRE  = 'MENUINT_';

// ════════════════════════════════════════════════════════════════════
//  DETECTORES DE TRIGGER
// ════════════════════════════════════════════════════════════════════

// Saludo / primer contacto → mandar welcome
function _menuEsTriggerWelcome(text) {
  var t = String(text || '').trim().toLowerCase();
  if (!t || t.length > 30) return false;
  return /^(hola|hello|hi|hey|buenas|buen[oa]s? (dias|tardes|noches)|saludos|que tal|inicio|start)\b/i.test(t);
}

// Solicitud explícita de menú
function _menuEsTriggerMenu(text) {
  var t = String(text || '').trim().toLowerCase();
  if (!t || t.length > 30) return false;
  return /^(\/?(menu|menú|menus|menús|opciones|opcs|ayuda|help|que puedes hacer|que haces|que sabes hacer))\??$/i.test(t);
}

// ════════════════════════════════════════════════════════════════════
//  WELCOME (Nivel 0)
// ════════════════════════════════════════════════════════════════════

function _menuSendWelcome(from, token, phoneId) {
  var negocio = String(CONFIG.NEGOCIO || '').trim();
  var saludoNeg = negocio ? (' de ' + negocio) : '';
  var body =
    '👋 Hola. Soy el asistente' + saludoNeg + ' de BalanceClip.\n\n' +
    'Puedo ayudarte a:\n' +
    '• Consultar tus gastos e ingresos registrados\n' +
    '• Editar categorías sin entrar al dashboard\n' +
    '• Analizar tu estado de cuenta del banco\n' +
    '• Procesar facturas (foto o PDF)\n' +
    '• Generar reportes\n\n' +
    'Toca un botón para empezar, o escribe directamente lo que necesites.';
  _whatsappReplyBotones(from,
    body,
    'BalanceClip',
    [
      { id: 'menu:open',           title: '📋 Ver menú' },
      { id: 'menu:banco-analizar', title: '🏦 Analizar banco' },
    ],
    token, phoneId
  );
}

// ════════════════════════════════════════════════════════════════════
//  MENÚ PRINCIPAL (Nivel 1)
// ════════════════════════════════════════════════════════════════════

function _menuSendPrincipal(from, token, phoneId) {
  var sections = [
    {
      title: '📊 Mis registros',
      rows: [
        { id: 'menu:resumen-mes',     title: 'Resumen del mes',      description: 'Total y categorías más fuertes' },
        { id: 'menu:proveedor-top',   title: 'Mis top proveedores',  description: 'A quién le pagas más' },
        { id: 'menu:buscar',          title: 'Buscar gasto/ingreso', description: 'Por proveedor, fecha o categoría' },
      ],
    },
    {
      title: '✏️ Editar registros',
      rows: [
        { id: 'menu:editar-cat',      title: 'Cambiar categoría',    description: 'Re-clasificar un gasto registrado' },
        { id: 'menu:editar-alcance',  title: 'Personal o de negocio', description: 'Cambiar el alcance de un gasto' },
      ],
    },
    {
      title: '🏦 Banco',
      rows: [
        { id: 'menu:banco-analizar',  title: 'Analizar mi cuenta',   description: 'Subir XLSX de Banco General' },
        { id: 'menu:banco-pendientes', title: 'Transferencias pend.', description: 'Notificaciones sin clasificar' },
      ],
    },
    {
      title: '📥 Reportes',
      rows: [
        { id: 'menu:excel-mes',       title: 'Excel del mes',        description: 'Movimientos del mes en hoja' },
        { id: 'menu:pyl',             title: 'Reporte anual',        description: 'Cierre fiscal DGI Panamá' },
      ],
    },
  ];
  _whatsappReplyLista(from,
    '📋 *Menú principal*\n\nSelecciona qué quieres hacer.\nTambién puedes escribirme una pregunta directa.',
    'Abrir menú',
    sections,
    token, phoneId
  );
}

// ════════════════════════════════════════════════════════════════════
//  DISPATCHER de `menu:*` (Nivel 2)
//  ──────────────────────────────────────────────────────────────────
//  Llamado desde _whatsappOnInteractive cuando el id matchea `menu:*`.
//  Devuelve true si manejó el tap.
// ════════════════════════════════════════════════════════════════════

function _menuHandleTap(rowId, from, token, phoneId) {
  var accion = String(rowId || '').replace(/^menu:/, '');
  Logger.log('Menu tap: ' + accion + ' from ' + from);
  switch (accion) {
    case 'open':              _menuSendPrincipal(from, token, phoneId); return true;
    case 'resumen-mes':       _menuResumenMes(from, token, phoneId);    return true;
    case 'proveedor-top':     _menuProveedorTop(from, token, phoneId);  return true;
    case 'buscar':            _menuBuscarPrompt(from, token, phoneId);  return true;
    case 'editar-cat':        _menuEditarCatPrompt(from, token, phoneId); return true;
    case 'editar-alcance':    _menuEditarAlcancePrompt(from, token, phoneId); return true;
    case 'banco-analizar':    _menuBancoAnalizar(from, token, phoneId); return true;
    case 'banco-pendientes':  _menuBancoPendientes(from, token, phoneId); return true;
    case 'excel-mes':         _menuExcelMes(from, token, phoneId);      return true;
    case 'pyl':               _menuPyl(from, token, phoneId);           return true;
    default:
      Logger.log('Menu acción desconocida: ' + accion);
      _whatsappReply(from, '⚠️ Opción desconocida. Escribe *menu* para ver las opciones disponibles.', token, phoneId);
      return true;
  }
}

// ════════════════════════════════════════════════════════════════════
//  SUB-FLUJOS — acciones rápidas (rule-based, $0)
// ════════════════════════════════════════════════════════════════════

function _menuResumenMes(from, token, phoneId) {
  try {
    var hoy = new Date();
    var primero = new Date(Utilities.formatDate(hoy, 'America/Panama', 'yyyy-MM') + '-01T00:00:00');
    var fdHasta = Utilities.formatDate(hoy,     'America/Panama', 'yyyy-MM-dd');
    var fdDesde = Utilities.formatDate(primero, 'America/Panama', 'yyyy-MM-dd');

    var aggE = _agToolAgregar({ tipo: 'egreso',  fecha_desde: fdDesde, fecha_hasta: fdHasta, agrupar_por: 'categoria' });
    var aggI = _agToolAgregar({ tipo: 'ingreso', fecha_desde: fdDesde, fecha_hasta: fdHasta, agrupar_por: 'total' });

    var mesLabel = _menuMesLabel(hoy);
    var totalE = 0;
    (aggE.grupos || []).forEach(function(g) { totalE += g.suma; });
    var totalI = (aggI.suma || 0);

    var lineas = [];
    lineas.push('📊 *Resumen de ' + mesLabel + '*');
    lineas.push('');
    lineas.push('💰 *Ingresos:* $' + totalI.toFixed(2));
    lineas.push('💸 *Egresos:*  $' + totalE.toFixed(2));
    lineas.push('📈 *Neto:*     $' + (totalI - totalE).toFixed(2));
    lineas.push('');

    var top = (aggE.grupos || []).slice(0, 5);
    if (top.length) {
      lineas.push('*Top categorías de gasto:*');
      top.forEach(function(g) {
        lineas.push('• ' + g.grupo + ' — $' + g.suma.toFixed(2) + ' (' + g.count + ')');
      });
    } else {
      lineas.push('_Sin gastos registrados este mes._');
    }
    lineas.push('');
    lineas.push(_menuFooter());
    _whatsappReply(from, lineas.join('\n'), token, phoneId);
  } catch (err) {
    Logger.log('menu:resumen-mes error: ' + err.message);
    _whatsappReply(from, '⚠️ No pude generar el resumen: ' + err.message, token, phoneId);
  }
}

function _menuProveedorTop(from, token, phoneId) {
  try {
    var data = _agToolListarProveedores({});
    var arr = (data.proveedores || []).slice(0, 10);
    if (!arr.length) {
      _whatsappReply(from, '🔎 Aún no tienes proveedores registrados.\n\n' + _menuFooter(), token, phoneId);
      return;
    }
    var lineas = [];
    lineas.push('🏷️ *Tus top proveedores* (por frecuencia)');
    lineas.push('');
    arr.forEach(function(p, i) {
      lineas.push((i + 1) + '. *' + p.proveedor + '*');
      lineas.push('   ' + p.count + ' op · $' + p.suma.toFixed(2) + ' · última ' + p.ultima_fecha);
    });
    lineas.push('');
    lineas.push(_menuFooter());
    _whatsappReply(from, lineas.join('\n'), token, phoneId);
  } catch (err) {
    Logger.log('menu:proveedor-top error: ' + err.message);
    _whatsappReply(from, '⚠️ No pude listar los proveedores: ' + err.message, token, phoneId);
  }
}

function _menuBancoPendientes(from, token, phoneId) {
  if (typeof _transfDrainQueue === 'function') {
    // Drain procesa la queue de transferencias pendientes (BG emails).
    _transfDrainQueue(from, token, phoneId);
    return;
  }
  _whatsappReply(from, '🏦 No hay sistema de transferencias activo en este momento.', token, phoneId);
}

function _menuBancoAnalizar(from, token, phoneId) {
  var msg =
    '🏦 *Analizar tu cuenta de Banco General*\n\n' +
    'Envíame el archivo XLSX de tus últimos movimientos:\n\n' +
    '1. Ingresa a Banco General Online\n' +
    '2. Ve a *Últimos movimientos*\n' +
    '3. Descarga el archivo en formato Excel\n' +
    '4. Adjunta el archivo aquí en este chat\n\n' +
    'Te devuelvo:\n' +
    '• Saldo, flujo y top categorías\n' +
    '• Suscripciones detectadas\n' +
    '• Excel con drill-downs por mes y categoría\n' +
    '• Sugerencias de ahorro y deducibles DGI\n\n' +
    _menuFooter();
  _whatsappReply(from, msg, token, phoneId);
}

function _menuPyl(from, token, phoneId) {
  var msg =
    '📊 *Reportes fiscales*\n\n' +
    'Los reportes detallados están en tu dashboard:\n\n' +
    '• *Cierre anual* (DGI Panamá)\n' +
    '• *ITBMS mensual*\n' +
    '• *P&L por período*\n\n' +
    'Accede desde: ' + _whatsappFrontendUrl() + '/reportes/\n\n' +
    _menuFooter();
  _whatsappReply(from, msg, token, phoneId);
}

function _menuExcelMes(from, token, phoneId) {
  // Por ahora, link al dashboard donde el cliente puede descargar Excel
  // del mes. Generar XLSX server-side e inyectarlo en el chat requiere
  // crear el archivo en Drive + obtener URL pública + mandar como media,
  // que es un flujo más complejo — lo dejamos para iteración siguiente.
  var msg =
    '📥 *Excel del mes*\n\n' +
    'Por el momento, descarga el detalle desde tu dashboard:\n\n' +
    _whatsappFrontendUrl() + '\n\n' +
    '_Próximamente: te envío el Excel directamente aquí._\n\n' +
    _menuFooter();
  _whatsappReply(from, msg, token, phoneId);
}

// ════════════════════════════════════════════════════════════════════
//  SUB-FLUJOS CONVERSACIONALES — setean intent + esperan mensaje
// ════════════════════════════════════════════════════════════════════

function _menuBuscarPrompt(from, token, phoneId) {
  _menuSetIntent(from, { kind: 'buscar', step: 'esperando_consulta' });
  _whatsappReply(from,
    '🔎 *Buscar en tus registros*\n\n' +
    'Escribe qué quieres encontrar. Ejemplos:\n' +
    '• _Arrocha en junio_\n' +
    '• _gastos médicos este año_\n' +
    '• _compras mayores a $100 este mes_\n' +
    '• _último pago de luz_',
    token, phoneId
  );
}

function _menuEditarCatPrompt(from, token, phoneId) {
  _menuSetIntent(from, { kind: 'editar_categoria', step: 'identificar_gasto' });
  _whatsappReply(from,
    '✏️ *Cambiar categoría de un gasto*\n\n' +
    'Dime qué gasto quieres re-clasificar.\n' +
    'Ejemplos:\n' +
    '• _el gasto de Arrocha del 18 de junio_\n' +
    '• _factura 12345_\n' +
    '• _la última compra en el supermercado_\n\n' +
    'Si hay varios, te muestro la lista para que elijas.',
    token, phoneId
  );
}

function _menuEditarAlcancePrompt(from, token, phoneId) {
  _menuSetIntent(from, { kind: 'editar_alcance', step: 'identificar_gasto' });
  _whatsappReply(from,
    '🔀 *Cambiar alcance (personal o negocio)*\n\n' +
    'Dime qué gasto quieres reclasificar.\n' +
    'Ejemplo: _Arrocha 18 jun_ o _factura 12345_.\n\n' +
    'Una vez identificado, te pregunto si lo marcas como *personal* o *negocio*.',
    token, phoneId
  );
}

// ════════════════════════════════════════════════════════════════════
//  INTENT STATE — CacheService keyed por phone, TTL 10 min
//  ──────────────────────────────────────────────────────────────────
//  Cuando un sub-flujo conversacional necesita el próximo mensaje del
//  usuario para completarse, guardamos un intent. El handler de texto
//  en _whatsappOnRecibir lo consulta y enruta al AsesorGastos con el
//  intent como contexto extra.
// ════════════════════════════════════════════════════════════════════

function _menuIntentKey(from) {
  return MENU_INTENT_KEY_PRE + String(from || '').replace(/\D/g, '');
}

function _menuSetIntent(from, intent) {
  if (!from || !intent) return;
  try {
    var obj = Object.assign({}, intent, { ts: Date.now() });
    CacheService.getScriptCache().put(_menuIntentKey(from), JSON.stringify(obj), MENU_INTENT_TTL_SEC);
  } catch(e) { Logger.log('_menuSetIntent error: ' + e.message); }
}

function _menuLoadIntent(from) {
  if (!from) return null;
  try {
    var raw = CacheService.getScriptCache().get(_menuIntentKey(from));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch(e) {
    Logger.log('_menuLoadIntent error: ' + e.message);
    return null;
  }
}

function _menuClearIntent(from) {
  if (!from) return;
  try { CacheService.getScriptCache().remove(_menuIntentKey(from)); }
  catch(_) {}
}

// ════════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════════

function _menuFooter() {
  return '_💡 Escribe *menu* para ver todas las opciones._';
}

function _menuMesLabel(d) {
  var meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  return meses[d.getMonth()] + ' ' + d.getFullYear();
}
