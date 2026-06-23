// ════════════════════════════════════════════════════════════════════
//  MENÚ PRINCIPAL — Discoverability del cliente (Fase 1)
//  ──────────────────────────────────────────────────────────────────
//  Punto único de entrada para que el cliente vea, en menos de 10
//  segundos, todo lo que el bot puede hacer por él.
//
//  Estructura:
//    Nivel 0 — Welcome con 2 botones (saludo / fallback default)
//    Nivel 1 — Menú principal (list message, 8 opciones, 4 secciones)
//    Nivel 2 — Sub-flujos: acciones rápidas rule-based (sin Claude)
//              y prompts conversacionales que setean intent
//
//  Convención: row ids con prefijo `menu:<accion>`.
//  Dispatcher en ContaFacil_WhatsApp.gs detecta el prefijo y delega
//  a `_menuHandleTap`.
//
//  Fase 1 NO incluye edición conversacional (cambiar categoría,
//  alcance, borrar) — eso es Fase 3.
// ════════════════════════════════════════════════════════════════════

var MENU_INTENT_TTL_SEC = 10 * 60;       // 10 min para mantener intent activo
var MENU_INTENT_KEY_PRE = 'MENUINT_';

// ════════════════════════════════════════════════════════════════════
//  DETECTORES DE TRIGGER
// ════════════════════════════════════════════════════════════════════

// Saludo / primer contacto / texto que no matchea otra cosa
function _menuEsTriggerWelcome(text) {
  var t = String(text || '').trim().toLowerCase();
  if (!t || t.length > 30) return false;
  return /^(hola|hello|hi|hey|buenas|buen[oa]s? (dias|tardes|noches)|saludos|que tal|inicio|start)\b/i.test(t);
}

// Solicitud explícita de ver el menú
function _menuEsTriggerMenu(text) {
  var t = String(text || '').trim().toLowerCase();
  if (!t || t.length > 30) return false;
  return /^(\/?(menu|menú|menus|menús|opciones|opcs|ayuda|help|que puedes hacer|que haces|que sabes hacer))\??$/i.test(t);
}

// ════════════════════════════════════════════════════════════════════
//  WELCOME (Nivel 0)
//  ──────────────────────────────────────────────────────────────────
//  El welcome ES el menú principal — un solo mensaje con saludo + las
//  opciones a un tap. Evita el paso intermedio "tap para ver opciones
//  → tap de nuevo para abrir menú".
// ════════════════════════════════════════════════════════════════════

function _menuSendWelcome(from, token, phoneId) {
  var negocio = String(CONFIG.NEGOCIO || '').trim();
  var saludoNeg = negocio ? (' de ' + negocio) : '';
  var body =
    '👋 Hola. Soy el asistente' + saludoNeg + ' de BalanceClip.\n\n' +
    'Puedo ayudarte a consultar gastos, registrar facturas, analizar tu banco y generar reportes.\n\n' +
    'Toca el botón para ver todas las opciones, o escríbeme directamente lo que necesites.';
  _menuSendListaConBody(from, body, token, phoneId);
}

// ════════════════════════════════════════════════════════════════════
//  MENÚ PRINCIPAL (Nivel 1) — list message
// ════════════════════════════════════════════════════════════════════

function _menuSendPrincipal(from, token, phoneId) {
  var body =
    '📋 *Menú principal*\n\n' +
    'Selecciona qué quieres hacer.\n' +
    'También puedes escribirme una pregunta directa.';
  _menuSendListaConBody(from, body, token, phoneId);
}

// Helper interno: envía el list message con un body custom (welcome
// o menú a secas). Las secciones y el botón de apertura son los mismos.
function _menuSendListaConBody(from, body, token, phoneId) {
  var sections = [
    {
      title: '📊 Mis registros',
      rows: [
        { id: 'menu:resumen-mes',     title: 'Resumen del mes',       description: 'Totales del mes y categorías principales' },
        { id: 'menu:proveedor-top',   title: 'Mis top proveedores',   description: 'A quién le pagas más' },
        { id: 'menu:buscar',          title: 'Buscar gasto/ingreso',  description: 'Por proveedor, fecha o categoría' },
      ],
    },
    {
      title: '🏦 Banco',
      rows: [
        { id: 'menu:banco-analizar',   title: 'Analizar mi cuenta',    description: 'Subir XLSX de Banco General' },
        { id: 'menu:banco-pendientes', title: 'Transferencias pend.',  description: 'Notificaciones sin clasificar' },
      ],
    },
    {
      title: '📥 Reportes',
      rows: [
        { id: 'menu:excel-mes', title: 'Excel del mes', description: 'Descarga el detalle del mes' },
        { id: 'menu:pyl',       title: 'Reporte anual', description: 'Cierre fiscal DGI Panamá' },
      ],
    },
    {
      title: 'ℹ️ Otros',
      rows: [
        { id: 'menu:info', title: '¿Qué puedo hacer?', description: 'Tour rápido de todas las funciones' },
      ],
    },
  ];
  _whatsappReplyLista(from, body, 'Abrir menú', sections, token, phoneId);
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
    case 'open':              _menuSendPrincipal(from, token, phoneId);        return true;
    case 'resumen-mes':       _menuResumenMes(from, token, phoneId);           return true;
    case 'proveedor-top':     _menuProveedorTop(from, token, phoneId);         return true;
    case 'buscar':            _menuBuscarPrompt(from, token, phoneId);         return true;
    case 'banco-analizar':    _menuBancoAnalizar(from, token, phoneId);        return true;
    case 'banco-pendientes':  _menuBancoPendientes(from, token, phoneId);      return true;
    case 'excel-mes':         _menuExcelMes(from, token, phoneId);             return true;
    case 'pyl':               _menuPyl(from, token, phoneId);                  return true;
    case 'info':              _menuInfo(from, token, phoneId);                 return true;
    default:
      Logger.log('Menú: acción desconocida ' + accion);
      _whatsappReply(from, '⚠️ Opción no reconocida. Escribe *menu* para ver las opciones disponibles.', token, phoneId);
      return true;
  }
}

// ════════════════════════════════════════════════════════════════════
//  SUB-FLUJOS RÁPIDOS — rule-based, sin llamadas a Claude ($0)
// ════════════════════════════════════════════════════════════════════

function _menuResumenMes(from, token, phoneId) {
  try {
    var hoy = new Date();
    var fdHasta = Utilities.formatDate(hoy, 'America/Panama', 'yyyy-MM-dd');
    var fdDesde = Utilities.formatDate(hoy, 'America/Panama', 'yyyy-MM') + '-01';

    var aggE = _agToolAgregar({ tipo: 'egreso',  fecha_desde: fdDesde, fecha_hasta: fdHasta, agrupar_por: 'categoria' });
    var aggI = _agToolAgregar({ tipo: 'ingreso', fecha_desde: fdDesde, fecha_hasta: fdHasta, agrupar_por: 'total' });

    var totalE = 0;
    (aggE.grupos || []).forEach(function(g) { totalE += g.suma; });
    var totalI = (aggI.suma || 0);

    var lineas = [];
    lineas.push('📊 *Resumen de ' + _menuMesLabel(hoy) + '*');
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
      _whatsappReply(from, '🔎 Aún no tienes proveedores registrados.' + _menuFooter(), token, phoneId);
      return;
    }
    var lineas = [];
    lineas.push('🏷️ *Tus top proveedores* (por frecuencia)');
    lineas.push('');
    arr.forEach(function(p, i) {
      lineas.push((i + 1) + '. *' + p.proveedor + '*');
      lineas.push('   ' + p.count + ' op · $' + p.suma.toFixed(2) + ' · última ' + p.ultima_fecha);
    });
    lineas.push(_menuFooter());
    _whatsappReply(from, lineas.join('\n'), token, phoneId);
  } catch (err) {
    Logger.log('menu:proveedor-top error: ' + err.message);
    _whatsappReply(from, '⚠️ No pude listar los proveedores: ' + err.message, token, phoneId);
  }
}

function _menuBancoPendientes(from, token, phoneId) {
  if (typeof _transfDrainQueue === 'function') {
    _transfDrainQueue(from, token, phoneId);
    return;
  }
  _whatsappReply(from, '🏦 No hay sistema de transferencias activo en este momento.' + _menuFooter(), token, phoneId);
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
    '• Asesor IA para preguntas sobre tu cuenta\n' +
    _menuFooter();
  _whatsappReply(from, msg, token, phoneId);
}

function _menuExcelMes(from, token, phoneId) {
  var msg =
    '📥 *Excel del mes*\n\n' +
    'Por el momento, descarga el detalle desde tu dashboard:\n\n' +
    _whatsappFrontendUrl() + '\n\n' +
    '_Próximamente: envío del Excel directamente aquí._' +
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
    'Accede desde: ' + _whatsappFrontendUrl() + '/reportes/' +
    _menuFooter();
  _whatsappReply(from, msg, token, phoneId);
}

function _menuInfo(from, token, phoneId) {
  var msg =
    'ℹ️ *Tour rápido de BalanceClip*\n\n' +
    '📸 *Registra facturas:* envíame foto o PDF, extraigo todo y lo dejo pendiente de aprobación.\n\n' +
    '🏦 *Analiza tu banco:* sube el XLSX de Banco General y te doy resumen, categorías, suscripciones y reportes.\n\n' +
    '💬 *Pregúntame de tus finanzas:* "¿cuánto gasté en farmacias este mes?", "¿cuándo pagué luz?", "¿cuántas veces fui al doctor?".\n\n' +
    '📧 *Reenvío automático:* escribe *configurar email* para que tus facturas lleguen al bot sin que las mandes una por una.\n\n' +
    '📥 *Reportes:* genera tu informe anual DGI, ITBMS mensual y P&L desde tu dashboard.' +
    _menuFooter();
  _whatsappReply(from, msg, token, phoneId);
}

// ════════════════════════════════════════════════════════════════════
//  SUB-FLUJOS CONVERSACIONALES — setean intent + esperan próximo mensaje
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

// ════════════════════════════════════════════════════════════════════
//  INTENT STATE — CacheService keyed por phone, TTL 10 min
//  ──────────────────────────────────────────────────────────────────
//  Cuando un sub-flujo conversacional necesita el próximo mensaje del
//  usuario para completarse, guardamos un intent. El handler de texto
//  en _whatsappProcesarMensaje lo consulta y enruta al AsesorGastos.
//
//  En Fase 1 solo se usa para `buscar`. Fases posteriores agregarán
//  intents para editar categoría, alcance, etc.
// ════════════════════════════════════════════════════════════════════

function _menuIntentKey(from) {
  return MENU_INTENT_KEY_PRE + String(from || '').replace(/\D/g, '');
}

function _menuSetIntent(from, intent) {
  if (!from || !intent) return;
  try {
    var obj = { kind: intent.kind, step: intent.step || '', ts: Date.now() };
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
  return '\n\n_💡 Escribe *menu* en cualquier momento para ver todas las opciones._';
}

function _menuMesLabel(d) {
  var meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  return meses[d.getMonth()] + ' ' + d.getFullYear();
}
