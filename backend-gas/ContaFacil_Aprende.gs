// ════════════════════════════════════════════════════════════════════
//  EDUCACIÓN CONTEXTUAL — Aprende (Fase 9)
//  ──────────────────────────────────────────────────────────────────
//  Dos features:
//
//  1. MINI-CURSOS (5 disponibles) accesibles escribiendo "aprende":
//     - Regla 50/30/20
//     - Form 90 DGI Panamá (deducibles personales)
//     - Fondo de emergencia
//     - Cómo leer tu estado de cuenta
//     - Suscripciones y gastos chicos
//
//     Cada curso es 3-5 lecciones cortas. El cliente avanza con
//     botón "Siguiente", sale con "Salir". Estado del curso en
//     Script Properties (TTL de facto 24h por ts).
//
//  2. GLOSARIO por demanda: "qué es X" / "explícame X" / "define X"
//     - 15+ términos clave (ITBMS, ISR, DGI, RUC, DV, CUFE, Form 90/91,
//       deducible, alcance, suscripción, etc.)
//     - Fallback a Claude si el término no está en el diccionario.
//
//  NO ocupa row del menú principal (ya está al cap de 10). Acceso
//  100% por NL — "aprende" abre lista, "que es X" busca término.
// ════════════════════════════════════════════════════════════════════

var APRENDE_PROGRESO_KEY_PRE = 'aprende_';
var APRENDE_MODEL = 'claude-haiku-4-5';

// ════════════════════════════════════════════════════════════════════
//  CURSOS — texto plano, 3-5 lecciones cada uno
// ════════════════════════════════════════════════════════════════════

var APRENDE_CURSOS = {
  'regla-50-30-20': {
    titulo:      '🎯 Regla 50/30/20',
    descripcion: 'Marco más popular de planificación personal',
    pasos: [
      '📚 *Lección 1 de 4 — ¿Qué es la regla 50/30/20?*\n\n' +
        'La popularizó Elizabeth Warren (senadora de EE.UU. y profesora de Harvard) en su libro *All Your Worth* (2005). Es una guía simple para distribuir tu ingreso neto:\n\n' +
        '• *50% Necesidades* — lo que no puedes evitar\n' +
        '• *30% Deseos* — gastos discrecionales\n' +
        '• *20% Ahorro/Inversión* — para tu futuro\n\n' +
        'No es una regla rígida — es un benchmark para detectar desbalances.',

      '📚 *Lección 2 de 4 — Qué cuenta como Necesidad*\n\n' +
        'Necesidades son gastos que existirían incluso si dejaras de trabajar:\n\n' +
        '• Vivienda (alquiler o hipoteca + intereses)\n' +
        '• Servicios básicos (luz, agua, internet)\n' +
        '• Alimentación básica del hogar\n' +
        '• Transporte para trabajar (combustible, transporte público)\n' +
        '• Salud (medicina recurrente, seguros)\n' +
        '• Educación de hijos dependientes\n\n' +
        '*Pista:* si pierdes el ingreso y NO podrías evitar este gasto el próximo mes, es Necesidad.',

      '📚 *Lección 3 de 4 — Deseos vs Ahorro*\n\n' +
        '*Deseos* son gastos que mejoran tu calidad de vida pero podrías recortar sin afectar lo esencial:\n' +
        '• Restaurantes, entretenimiento, viajes recreativos\n' +
        '• Ropa más allá de lo necesario\n' +
        '• Suscripciones (Netflix, Spotify, gym)\n' +
        '• Hobbies, regalos extra\n\n' +
        '*Ahorro/Inversión* es lo que separas para tu futuro ANTES de gastar:\n' +
        '• Fondo de emergencia\n' +
        '• Retiro / pensión privada\n' +
        '• Inversiones (fondos indexados, renta fija)\n' +
        '• Pago acelerado de deudas (más allá del mínimo)',

      '📚 *Lección 4 de 4 — Cómo aplicarla*\n\n' +
        '1. *Configura tu ingreso* en "Mi salud financiera" del menú.\n' +
        '2. Cada vez que toques esa opción, BalanceClip te muestra tu distribución real comparada con la regla.\n' +
        '3. Si estás fuera de rango, el bot te indica qué categoría pesa más.\n\n' +
        '*Tip realista:* lograr 50/30/20 perfecto es difícil. La meta es estar cerca y, si tu ahorro está bajo 20%, identificar qué reducir primero.\n\n' +
        '🎓 Curso completado. Cuando quieras, repítelo escribiendo *aprende*.',
    ],
    cierre_cta: 'Para ver TU distribución real, toca *menu* → "Mi salud financiera".',
  },

  'form-90-dgi': {
    titulo:      '🧾 Form 90 DGI Panamá',
    descripcion: 'Deducibles personales del Impuesto Sobre la Renta',
    pasos: [
      '📚 *Lección 1 de 4 — ¿Qué es el Form 90?*\n\n' +
        'El Form 90 es la *Declaración Jurada del Impuesto Sobre la Renta para Persona Natural* (residentes en Panamá).\n\n' +
        'Si tu renta gravable anual supera *$11,000*, debes presentarlo en marzo del año siguiente al cierre fiscal.\n\n' +
        'Lo que muchos no saben: el Form 90 permite *RESTAR de tu renta gravable* los gastos personales deducibles. Esto baja directamente el impuesto que pagas.',

      '📚 *Lección 2 de 4 — Las 5 líneas DP-N de deducibles*\n\n' +
        'En el Form 90 hay 5 líneas de deducciones personales:\n\n' +
        '• *DP-1* — Gastos médicos (salud propia y dependientes)\n' +
        '• *DP-2* — Gastos escolares de hijos dependientes\n' +
        '• *DP-3* — Intereses hipotecarios (vivienda principal)\n' +
        '• *DP-4* — Intereses de préstamos educativos\n' +
        '• *DP-5* — Gastos escolares de dependientes con discapacidad\n\n' +
        'Cada línea tiene topes legales que cambian con reformas — confírmalos con tu contador antes de presentar.',

      '📚 *Lección 3 de 4 — Cómo BalanceClip te ayuda*\n\n' +
        'Cada factura que registras (foto, PDF, quick text, email) tiene una *categoría DGI* asignada. Si esa categoría es deducible, el bot:\n\n' +
        '1. Te muestra el acumulado anual al aprobar la factura.\n' +
        '2. Suma al total que verás en "Mis deducibles DGI" del menú.\n' +
        '3. Cuando se acerque marzo, te ofrece un *Excel pre-llenado* con todo el detalle agrupado por línea — listo para entregar a tu contador.',

      '📚 *Lección 4 de 4 — Estrategia para no perder deducciones*\n\n' +
        'El error más común: pagar gastos deducibles pero no guardar comprobantes. La DGI puede pedirlos en una auditoría hasta 5 años después.\n\n' +
        '*3 hábitos clave:*\n\n' +
        '• Cada vez que pagues medicinas, doctor o colegio → manda foto al bot inmediatamente.\n' +
        '• Configura *reenvío automático* en tu Gmail para las facturas digitales (escribe *configurar email*).\n' +
        '• Cada mes, revisa "Mis deducibles DGI" para verificar que el acumulado avanza.\n\n' +
        '🎓 Curso completado. Para ver tu acumulado actual: *menu* → "Mis deducibles DGI".',
    ],
    cierre_cta: 'Tap *menu* → "Mis deducibles DGI" para ver tu acumulado del año.',
  },

  'fondo-emergencia': {
    titulo:      '🛡️ Fondo de emergencia',
    descripcion: 'La base de cualquier plan financiero',
    pasos: [
      '📚 *Lección 1 de 3 — ¿Por qué un fondo de emergencia?*\n\n' +
        'Es dinero líquido (cuenta de ahorro, no inversiones) que cubre tus gastos esenciales por *3 a 6 meses* en caso de:\n\n' +
        '• Pérdida de empleo o ingresos\n' +
        '• Emergencia médica no cubierta\n' +
        '• Reparación urgente (auto, casa)\n' +
        '• Cualquier imprevisto que de otro modo te llevaría a deuda con tarjeta\n\n' +
        'Es la *primera meta financiera* — antes de invertir, antes de cualquier otra cosa.',

      '📚 *Lección 2 de 3 — ¿Cuánto exactamente?*\n\n' +
        'Fórmula: *gastos mensuales esenciales × meses de cobertura*\n\n' +
        '*Mínimo (3 meses):* si tienes ingreso estable, sin dependientes, fácil de reemplazar.\n' +
        '*Recomendado (6 meses):* asalariado típico con familia.\n' +
        '*Conservador (9-12 meses):* freelancer, dueño de negocio, ingreso variable.\n\n' +
        'Para calcular tu objetivo, suma:\n' +
        '• Alquiler/hipoteca\n• Servicios básicos\n• Alimentación\n• Transporte\n• Salud y seguros\n• Cualquier deuda mínima\n\n' +
        'NO incluyas restaurantes, viajes ni gastos discrecionales.',

      '📚 *Lección 3 de 3 — Cómo construirlo*\n\n' +
        '*1. Empieza pequeño.* Una primera meta de $500-$1,000 ya cubre el 90% de imprevistos cotidianos.\n\n' +
        '*2. Automatízalo.* Transferencia automática mensual a una cuenta separada del día que cobras.\n\n' +
        '*3. Guárdalo donde no lo veas.* Cuenta de ahorro distinta del banco principal. Bonus: con un rendimiento ligero (Banco General Promerica, Banistmo CDP, etc).\n\n' +
        '*4. Plantéalo como objetivo en el bot.* Escribe *menu* → "Mis objetivos" → describe "fondo emergencia de $6000". El bot calcula tu meta mensual y te muestra progreso real.\n\n' +
        '🎓 Curso completado.',
    ],
    cierre_cta: 'Para plantear tu fondo de emergencia: *menu* → "Mis objetivos".',
  },

  'leer-estado-cuenta': {
    titulo:      '🏦 Leer tu estado de cuenta',
    descripcion: 'Sacar info accionable de los movimientos del banco',
    pasos: [
      '📚 *Lección 1 de 3 — Qué buscar en tu estado*\n\n' +
        'Cuando descargas tu Excel de Banco General, hay 4 dimensiones que importan:\n\n' +
        '• *Flujo:* ingresos vs gastos totales del período\n' +
        '• *Categorías:* en qué se va el dinero (comida, transporte, ocio, etc.)\n' +
        '• *Frecuencia:* qué cargos se repiten cada mes (suscripciones)\n' +
        '• *Outliers:* el gasto inusualmente alto del mes\n\n' +
        'BalanceClip los detecta todos al subir el XLSX. Pero saber qué buscar tú mismo te ayuda a interpretar.',

      '📚 *Lección 2 de 3 — Suscripciones: la fuga silenciosa*\n\n' +
        'Las suscripciones de $5-$15 mensuales parecen pequeñas pero suman. Casos comunes:\n\n' +
        '• Streaming (Netflix, Disney+, HBO, Spotify, Apple Music)\n' +
        '• Gym, apps de fitness, meditación\n' +
        '• Almacenamiento cloud (iCloud, Dropbox)\n' +
        '• Apps de citas, juegos, productividad\n\n' +
        'Un cliente típico tiene *6-12 suscripciones activas* y usa la mitad. Auditar cada 6 meses y cancelar las olvidadas libera $30-$80/mes — eso es $360-$960 al año.\n\n' +
        'BalanceClip las detecta automáticamente cuando subes el XLSX.',

      '📚 *Lección 3 de 3 — Patrones que indican problema*\n\n' +
        '*Señales de alerta cuando revisas tu estado:*\n\n' +
        '• Cargos a tarjeta de crédito que solo pagas el mínimo → estás acumulando interés.\n' +
        '• Saldo final consistentemente más bajo que el inicial → estás gastando más de lo que entra.\n' +
        '• Top 1 merchant > 40% del gasto total → concentración riesgosa.\n' +
        '• Yappy frecuente sin justificar → gastos pequeños que se diluyen mentalmente.\n' +
        '• Retiros ATM frecuentes → efectivo sin rastreo.\n\n' +
        '🎓 Curso completado. Para analizar tu estado de cuenta ahora: *menu* → "Analizar mi cuenta".',
    ],
    cierre_cta: 'Sube tu XLSX de Banco General desde *menu* → "Analizar mi cuenta".',
  },

  'suscripciones': {
    titulo:      '🔁 Suscripciones y gastos chicos',
    descripcion: 'La bola de nieve invisible',
    pasos: [
      '📚 *Lección 1 de 2 — El efecto bola de nieve*\n\n' +
        'Tres cargos de $10/mes no se sienten en el momento. Pero al año son *$360* — equivalente a 36 almuerzos o un viaje corto.\n\n' +
        'Si tienes 8 suscripciones promediando $9 cada una, son *$72/mes = $864/año*.\n\n' +
        'El problema no es el monto individual — es que se cargan automáticamente y no las notas. El cerebro descarta cargos pequeños y solo registra los grandes.',

      '📚 *Lección 2 de 2 — Auditoría en 5 minutos*\n\n' +
        'Cada 6 meses haz esto:\n\n' +
        '1. Sube tu estado de cuenta bancario a BalanceClip — detecta las suscripciones automáticamente.\n\n' +
        '2. Por cada una, pregúntate: *¿la usé las últimas 4 semanas?*\n   • Sí, mucho → mantener\n   • Sí, poco → bajar al plan más barato\n   • No → cancelar HOY\n\n' +
        '3. Para cancelar: la mayoría se hace desde la app/web. No llames al servicio al cliente — diseñan ese proceso para retenerte.\n\n' +
        '4. Si te ofrecen descuento por quedarte, acéptalo solo si REALMENTE usas el servicio. Si no, sigues pagando algo que no necesitas.\n\n' +
        '🎓 Curso completado. Para detectar tus suscripciones ahora: *menu* → "Analizar mi cuenta" y sube tu XLSX.',
    ],
    cierre_cta: 'Para detectar tus suscripciones actuales: sube tu XLSX en *menu* → "Analizar mi cuenta".',
  },
};

// ════════════════════════════════════════════════════════════════════
//  GLOSARIO — términos comunes del lenguaje fiscal/financiero panameño
// ════════════════════════════════════════════════════════════════════

var APRENDE_GLOSARIO = {
  'itbms': '*ITBMS* (Impuesto sobre la Transferencia de Bienes Muebles y la prestación de Servicios) es el impuesto al consumo de Panamá. La tasa estándar es *7%*, con tasas especiales de 10% (alcohol, hospedaje) y 15% (tabaco). Como consumidor lo pagas; como negocio registrado, lo cobras y reportas mensualmente a DGI.',

  'isr': '*ISR* (Impuesto Sobre la Renta) es el impuesto que pagas anualmente sobre tu renta gravable (ingresos menos deducciones permitidas). En Panamá:\n• Persona Natural: 0% hasta $11,000 · 15% de $11,001 a $50,000 · 25% sobre $50,000\n• Persona Jurídica: 25% sobre utilidad neta\nSe declara en marzo del año siguiente.',

  'dgi': '*DGI* (Dirección General de Ingresos) es la entidad gubernamental de Panamá responsable de administrar tributos. Equivalente al SAT en México o el IRS en EE.UU. Sus formularios principales: Form 90 (ISR persona natural), Form 91 (ISR persona jurídica), Form 430 (ITBMS mensual).',

  'ruc': '*RUC* (Registro Único de Contribuyentes) es tu identificador fiscal en Panamá. Para personas naturales coincide con la cédula. Para jurídicas se asigna al constituir la sociedad. Siempre va acompañado del *DV* (dígito verificador).',

  'dv': '*DV* (Dígito Verificador) es un número de 1-2 dígitos que valida el RUC. Es generado por DGI y siempre se reporta junto al RUC en facturas y declaraciones. Ejemplo: RUC `8-123-456` DV `74`.',

  'cufe': '*CUFE* (Código Único de Factura Electrónica) es un identificador único que la DGI asigna a cada factura electrónica autorizada en Panamá. Aparece en el XML de la factura. Sirve para validar que la factura fue efectivamente reportada por el proveedor.',

  'form 90': '*Form 90* — Declaración Jurada del ISR para Persona Natural en Panamá. Obligatorio si tu renta gravable anual supera $11,000. Se presenta en marzo. Aquí declaras tus ingresos del año fiscal y restas tus deducciones personales (líneas DP-1 a DP-5). Para más, escribe *aprende* y elige el curso de Form 90.',

  'form 91': '*Form 91* — Declaración Jurada del ISR para Persona Jurídica. Equivalente al Form 90 pero para empresas. Incluye Anexo 94 con desglose detallado de gastos operativos y costos de venta.',

  'anexo 94': '*Anexo 94* es el desglose detallado de gastos operativos y costos de venta que se adjunta al Form 91. Las categorías DGI internas de BalanceClip (alquileres, salarios, honorarios_servicios, etc.) mapean a las líneas L1-L24 del Anexo 94.',

  'deducible': 'Un gasto *deducible* es uno que puedes restar de tu renta gravable antes de calcular el ISR. Eso reduce el impuesto que pagas. Para personas naturales, los deducibles más comunes son: gastos médicos, escolares de dependientes, intereses hipotecarios e intereses de préstamos educativos (las líneas DP-1 a DP-5 del Form 90).',

  'alcance': 'En BalanceClip, *alcance* indica si un gasto es *negocio* (deducible del ISR de la empresa) o *personal* (deducible del Form 90 si aplica, o simplemente tracking sin impacto fiscal). Cambia el alcance desde el menú: "Cambiar categoría" (también ajusta alcance si aplica).',

  'suscripcion': 'Una *suscripción* es un cargo recurrente automático que se cobra mensualmente sin que tengas que autorizarlo cada vez. BalanceClip las detecta cuando subes tu estado de cuenta bancario: identifica proveedores con 3+ cargos mensuales de monto similar. Para más, escribe *aprende* y elige "Suscripciones y gastos chicos".',

  'fondo emergencia': '*Fondo de emergencia* es dinero líquido en cuenta de ahorro que cubre tus gastos esenciales por 3-6 meses. Es la primera meta financiera antes de invertir. Para construirlo paso a paso, escribe *aprende* y elige el curso "Fondo de emergencia".',

  'regla 50 30 20': '*Regla 50/30/20* es el marco de planificación personal popularizado por Elizabeth Warren: 50% necesidades + 30% deseos + 20% ahorro. Para ver TU distribución real, toca *menu* → "Mi salud financiera". Para entender la regla a profundidad, escribe *aprende* y elige el curso 50/30/20.',

  'flujo neto': '*Flujo neto* (cash flow neto) es la diferencia entre ingresos y gastos en un período. Positivo = ahorraste; negativo = gastaste más de lo que recibiste.',

  'runway': '*Runway* es cuántos meses puedes seguir gastando al ritmo actual antes de quedarte sin dinero. Fórmula: saldo actual ÷ gasto mensual promedio. Útil para freelancers e ingreso variable.',

  'savings rate': '*Savings rate* o *tasa de ahorro* es el % de tu ingreso que ahorras cada mes. Fórmula: (ingreso − gastos) ÷ ingreso × 100. La regla 50/30/20 recomienda ≥20%. Estudios de jubilación temprana sugieren 40%+.',
};

// ════════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════════

function _aprendeNorm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function _aprendeBuscarGlosario(termino) {
  var key = _aprendeNorm(termino);
  if (APRENDE_GLOSARIO[key]) return APRENDE_GLOSARIO[key];
  // Buscar match parcial (la primera palabra del término puede bastar)
  var keys = Object.keys(APRENDE_GLOSARIO);
  for (var i = 0; i < keys.length; i++) {
    if (key.indexOf(keys[i]) >= 0) return APRENDE_GLOSARIO[keys[i]];
    if (keys[i].indexOf(key) >= 0 && key.length >= 3) return APRENDE_GLOSARIO[keys[i]];
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════
//  DETECTORES — invocados desde ContaFacil_WhatsApp.gs
// ════════════════════════════════════════════════════════════════════

function _aprendeEsTriggerMenu(text) {
  var t = _aprendeNorm(text);
  if (!t || t.length > 30) return false;
  return /^(aprende|aprender|cursos|curso|educame|enseñame|enseña|tips|tutorial|tutoriales|capacitate)\b/i.test(t);
}

// "qué es X" / "explícame X" / "define X" / "dime que es X"
function _aprendeEsTriggerDefinicion(text) {
  var t = _aprendeNorm(text);
  if (!t || t.length > 60) return false;
  return /^(que\s+es|que\s+significa|define|definicion\s+de|explicame|explica\s+que\s+es|dime\s+que\s+es|que\s+quiere\s+decir)\s+/i.test(t);
}

function _aprendeExtraerTermino(text) {
  var t = _aprendeNorm(text);
  // Quita las preguntas comunes para quedarse con el término
  return t.replace(/^(que\s+es|que\s+significa|define|definicion\s+de|explicame|explica\s+que\s+es|dime\s+que\s+es|que\s+quiere\s+decir)\s+/i, '')
          .replace(/^(el|la|los|las|un|una|unos|unas)\s+/, '')
          .replace(/\?+$/, '')
          .trim();
}

// ════════════════════════════════════════════════════════════════════
//  HANDLERS
// ════════════════════════════════════════════════════════════════════

function _aprendeMenuHandler(from, token, phoneId) {
  var sections = [
    {
      title: '📚 Cursos disponibles',
      rows: Object.keys(APRENDE_CURSOS).map(function(id) {
        var c = APRENDE_CURSOS[id];
        return { id: 'aprende:start:' + id, title: c.titulo, description: c.descripcion };
      }),
    },
  ];
  _whatsappReplyLista(from,
    '📚 *Aprende con BalanceClip*\n\n' +
    'Cursos cortos para entender mejor cómo funcionan tus finanzas personales y la fiscalidad panameña. Cada uno son 2-4 lecciones breves.',
    'Ver cursos',
    sections,
    token, phoneId);
}

function _aprendeHandleDefinicion(text, from, token, phoneId) {
  var termino = _aprendeExtraerTermino(text);
  if (!termino) {
    _whatsappReply(from, '⚠️ No identifiqué el término. Intenta: _"qué es ITBMS"_ o _"define deducible"_.', token, phoneId);
    return;
  }
  var def = _aprendeBuscarGlosario(termino);
  if (def) {
    _whatsappReply(from, def + '\n\n_Para ver todos los cursos disponibles: escribe *aprende*._', token, phoneId);
    return;
  }
  // Fallback Claude — explicación general
  try {
    var explicacion = _aprendeClaudeExplicar(termino);
    if (explicacion) {
      _whatsappReply(from, explicacion + '\n\n_Para ver todos los cursos disponibles: escribe *aprende*._', token, phoneId);
      return;
    }
  } catch(e) { Logger.log('_aprendeClaudeExplicar error: ' + e.message); }
  _whatsappReply(from,
    '🤔 No tengo una definición específica para "' + termino + '". ' +
    'Puedes escribir *aprende* para ver los cursos disponibles, o reformular tu pregunta.',
    token, phoneId);
}

function _aprendeClaudeExplicar(termino) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) return null;
  var system =
    'Eres un educador financiero panameño. El usuario te pregunta qué es un término. Responde en 3-5 líneas máximo, en español neutro, con un ejemplo concreto si aplica al contexto panameño (DGI, ITBMS, ISR, etc.). NO inventes datos ni topes legales. Si el término no es financiero/fiscal, devuelve "NO_ES_FINANCIERO". Si no estás seguro, dilo claro.';
  var payload = {
    model:      APRENDE_MODEL,
    max_tokens: 350,
    system:     system,
    messages:   [{ role: 'user', content: 'Qué es: ' + termino }],
  };
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify(payload),
    headers:            { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) return null;
  var data = JSON.parse(res.getContentText());
  var raw = '';
  (data.content || []).forEach(function(b) { if (b.type === 'text') raw += b.text; });
  raw = raw.trim();
  if (!raw || raw.indexOf('NO_ES_FINANCIERO') >= 0) return null;
  return raw;
}

// ════════════════════════════════════════════════════════════════════
//  PROGRESO DE CURSO — Script Properties
// ════════════════════════════════════════════════════════════════════

function _aprendeKey(from) {
  return APRENDE_PROGRESO_KEY_PRE + String(from || '').replace(/\D/g, '');
}

function _aprendeProgresoGet(from) {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(_aprendeKey(from));
    if (!raw) return null;
    var p = JSON.parse(raw);
    // Expiración soft: 48h sin avance → reseteo
    if (p.ts && (Date.now() - p.ts) > (48 * 3600 * 1000)) {
      _aprendeProgresoClear(from);
      return null;
    }
    return p;
  } catch(e) { return null; }
}

function _aprendeProgresoSet(from, cursoId, step) {
  try {
    PropertiesService.getScriptProperties().setProperty(_aprendeKey(from),
      JSON.stringify({ curso: cursoId, step: step, ts: Date.now() }));
  } catch(e) { Logger.log('_aprendeProgresoSet error: ' + e.message); }
}

function _aprendeProgresoClear(from) {
  try { PropertiesService.getScriptProperties().deleteProperty(_aprendeKey(from)); }
  catch(e) {}
}

// ════════════════════════════════════════════════════════════════════
//  DISPATCH DE BOTONES — aprende:start:<id> / aprende:next / aprende:exit
// ════════════════════════════════════════════════════════════════════

function _aprendeHandleTap(rowId, from, token, phoneId) {
  var partes = String(rowId || '').split(':');
  if (partes[1] === 'start' && partes[2]) {
    _aprendeIniciarCurso(partes[2], from, token, phoneId);
    return true;
  }
  if (partes[1] === 'next') {
    _aprendeSiguientePaso(from, token, phoneId);
    return true;
  }
  if (partes[1] === 'exit') {
    _aprendeProgresoClear(from);
    _whatsappReply(from, '👋 Curso pausado. Escribe *aprende* cuando quieras retomarlo.', token, phoneId);
    return true;
  }
  return false;
}

function _aprendeIniciarCurso(cursoId, from, token, phoneId) {
  var c = APRENDE_CURSOS[cursoId];
  if (!c) {
    _whatsappReply(from, '⚠️ Curso no encontrado. Escribe *aprende* para ver la lista.', token, phoneId);
    return;
  }
  _aprendeProgresoSet(from, cursoId, 0);
  _aprendeEnviarPaso(c, 0, from, token, phoneId);
}

function _aprendeSiguientePaso(from, token, phoneId) {
  var p = _aprendeProgresoGet(from);
  if (!p) {
    _whatsappReply(from, '⚠️ No tienes un curso activo. Escribe *aprende* para empezar uno.', token, phoneId);
    return;
  }
  var c = APRENDE_CURSOS[p.curso];
  if (!c) { _aprendeProgresoClear(from); return; }
  var siguiente = p.step + 1;
  if (siguiente >= c.pasos.length) {
    _aprendeProgresoClear(from);
    if (c.cierre_cta) {
      _whatsappReply(from, '🎓 Has completado el curso *' + c.titulo + '*.\n\n💡 ' + c.cierre_cta, token, phoneId);
    } else {
      _whatsappReply(from, '🎓 Has completado el curso *' + c.titulo + '*.', token, phoneId);
    }
    return;
  }
  _aprendeProgresoSet(from, p.curso, siguiente);
  _aprendeEnviarPaso(c, siguiente, from, token, phoneId);
}

function _aprendeEnviarPaso(curso, stepIdx, from, token, phoneId) {
  var paso = curso.pasos[stepIdx];
  var esUltimo = (stepIdx === curso.pasos.length - 1);
  if (esUltimo) {
    // Última lección: solo mostrar texto (ya incluye el cierre).
    _whatsappReply(from, paso, token, phoneId);
    _aprendeProgresoClear(from);
    return;
  }
  // Lecciones intermedias: botones Siguiente / Salir
  _whatsappReplyBotones(from, paso, '',
    [
      { id: 'aprende:next', title: '▶️ Siguiente' },
      { id: 'aprende:exit', title: '❌ Salir' },
    ],
    token, phoneId);
}

// ════════════════════════════════════════════════════════════════════
//  TOOL PARA AsesorGastos — preguntas tipo "qué cursos hay"
// ════════════════════════════════════════════════════════════════════

function _agToolListarCursos(input) {
  return {
    ok: true,
    cursos: Object.keys(APRENDE_CURSOS).map(function(id) {
      return {
        id:          id,
        titulo:      APRENDE_CURSOS[id].titulo,
        descripcion: APRENDE_CURSOS[id].descripcion,
        n_lecciones: APRENDE_CURSOS[id].pasos.length,
      };
    }),
    instruccion_para_cliente: 'Para empezar un curso, el cliente debe escribir "aprende" y tocar el que le interese.',
  };
}

// ════════════════════════════════════════════════════════════════════
//  TEST HELPERS
// ════════════════════════════════════════════════════════════════════

function _aprendeTestGlosario() {
  var ejemplos = ['que es itbms', 'define isr', 'explicame el form 90', 'que significa cufe', 'que es manaco'];
  ejemplos.forEach(function(e) {
    var t = _aprendeExtraerTermino(e);
    var def = _aprendeBuscarGlosario(t);
    Logger.log(e + ' → término="' + t + '" → ' + (def ? def.substring(0, 60) + '...' : 'NULL'));
  });
}

function _aprendeTestCurso() {
  var c = APRENDE_CURSOS['regla-50-30-20'];
  Logger.log(c.titulo + ' tiene ' + c.pasos.length + ' lecciones');
  c.pasos.forEach(function(p, i) {
    Logger.log('--- Lección ' + (i + 1) + ' ---');
    Logger.log(p);
  });
}
