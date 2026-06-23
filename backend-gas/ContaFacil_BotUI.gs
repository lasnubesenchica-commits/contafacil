// ════════════════════════════════════════════════════════════════════
//  BotUI — primitivas unificadas para mensajes WhatsApp
//  ──────────────────────────────────────────────────────────────────
//  Este módulo encapsula las llamadas a la API de WhatsApp (texto,
//  botones, listas) en wrappers con nombres consistentes.
//
//  No reemplaza a `_whatsappReply`, `_whatsappReplyBotones` ni
//  `_whatsappReplyLista` — los envuelve para que cualquier código
//  futuro use estos nombres y no tenga que conocer las firmas
//  internas. Las funciones originales siguen funcionando para
//  compatibilidad con código existente.
//
//  Convenciones de copy:
//    • Español neutro panameño (tú/usted indistinto).
//    • Sin regionalismos argentinos (vos/tenés/podés/usá/mandame/etc.).
//    • Imperativos: "envía", "toca", "escribe", "dime", "ve", "abre".
//    • Bold con *asteriscos*, italic con _underscore_.
//    • Viñetas con • para listas.
//    • Footer estándar al final de respuestas que invitan a seguir
//      explorando (cuando aplique): "_💡 Escribe *menu* para ver más._"
//
//  Convenciones de id de botones / list rows:
//    • menu:<accion>[:<param>]   — menú principal y sub-menús
//    • flow:<nombre>:<step>      — flujos guiados (signup, setup, etc.)
//    • edit:<entidad>:<accion>   — edición de registros
//    • wa:<accion>:<pendId>      — botones de aprobación de factura
//    • tr:<accion>:<pendId>      — botones del flujo de transferencias
// ════════════════════════════════════════════════════════════════════

// Envía mensaje de texto plano. Wrapper sobre _whatsappReply.
function botSendText(to, text, token, phoneId) {
  return _whatsappReply(to, text, token, phoneId);
}

// Envía mensaje interactivo con botones quick-reply (máx 3).
// buttons: [{ id, title }] — title se trunca a 20 chars.
function botSendButtons(to, body, buttons, token, phoneId, footer) {
  return _whatsappReplyBotones(to, body, footer || '', buttons, token, phoneId);
}

// Envía mensaje interactivo con lista seleccionable (máx 10 rows).
// sections: [{ title, rows: [{ id, title, description }] }]
function botSendList(to, body, listButtonText, sections, token, phoneId) {
  return _whatsappReplyLista(to, body, listButtonText || 'Abrir menú', sections, token, phoneId);
}

// Footer estándar para respuestas que pueden ofrecer navegación al menú.
// Devuelve string vacío si el menú principal aún no está implementado
// (no queremos enviar al usuario a un comando que no existe).
function botFooterMenu() {
  // Por ahora vacío. Cuando exista el menú principal (Fase 1),
  // devolver: '\n\n_💡 Escribe *menu* para ver todas las opciones._'
  return '';
}

// Adjunta el footer estándar de menú al final de un texto, solo si
// el footer no está vacío. Útil para respuestas del asesor y de
// sub-flujos rápidos que quieren mantener el menú visible.
function botWithMenuFooter(text) {
  var footer = botFooterMenu();
  if (!footer) return text;
  return String(text || '') + footer;
}
