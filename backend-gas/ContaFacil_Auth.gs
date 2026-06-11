// ═══════════════════════════════════════════════════════════════
//  ContaFacil_Auth — Autenticación con password global
//
//  Modelo:
//   - Hay un único hash de contraseña por instalación, guardado en
//     config_operaciones bajo la clave `password_hash`.
//   - El frontend NO recibe el hash. Solo sabe si hay password
//     configurada (`hasPassword`).
//   - Para verificar / cambiar / setear, el frontend envía la
//     password en plano vía HTTPS POST y el backend la hashea con
//     SHA-256 server-side y compara.
//
//  Endpoints:
//   - getAuthState (GET / JSONP)        → { success, hasPassword }
//   - verifyPassword (POST)             → { success, valid }
//   - setPassword (POST, params:
//       password, currentPassword?)     → { success } o { success:false, error }
//   - resetPassword (POST,
//       overrideToken?: string)         → { success }
//       Solo borra el hash si se pasa el token de override (lo controla
//       el equipo BalanceClip vía Script Properties; sin token, falla).
// ═══════════════════════════════════════════════════════════════

var AUTH_KEY = 'password_hash';

function _authHashServer(pwd) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
                                       String(pwd || ''),
                                       Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = (bytes[i] + 256) % 256;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

function _authJsonp(obj, callback) {
  var json = JSON.stringify(obj);
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function _authReadStoredHash() {
  try {
    var cfg = _getConfig();
    return String(cfg[AUTH_KEY] || '').trim();
  } catch (e) {
    return '';
  }
}

function _authWriteHash(hash) {
  // Escribimos directo a config_operaciones porque _handleGuardarConfig
  // tiene una whitelist de claves que no incluye password_hash.
  // Mantenemos esto fuera de esa whitelist a propósito (no queremos exponer
  // password_hash al endpoint público de guardarConfig).
  var ss    = SpreadsheetApp.openById(CONFIG_OP.SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_CONFIG_OP) || _initConfigSheet(ss);
  var rows  = sheet.getDataRange().getValues();
  var rowIdx = -1;
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '').trim() === AUTH_KEY) { rowIdx = i + 1; break; }
  }
  if (rowIdx > 0) {
    sheet.getRange(rowIdx, 2).setValue(String(hash || ''));
  } else {
    var newRow = sheet.getLastRow() + 1;
    sheet.getRange(newRow, 1).setValue(AUTH_KEY);
    sheet.getRange(newRow, 2).setValue(String(hash || ''));
  }
  // Invalidar cache de config (consumido por _authReadStoredHash)
  try { _cfgCacheOp = null; } catch (e) {}
  Logger.log('🔐 password_hash ' + (hash ? 'set' : 'cleared') + ' en config_operaciones row ' + (rowIdx > 0 ? rowIdx : 'NEW'));
}

// ── GET handlers ─────────────────────────────────────────────

function _handleGetAuthState(params, callback) {
  var hash = _authReadStoredHash();
  return _authJsonp({
    success:     true,
    hasPassword: !!hash,
  }, callback);
}

// ── POST handlers ────────────────────────────────────────────

function _handleVerifyPassword(data) {
  try {
    var stored = _authReadStoredHash();
    if (!stored) {
      return _authJsonp({ success: true, valid: false, error: 'Sin password configurada' });
    }
    var pwd = String(data.password || '');
    if (!pwd) {
      return _authJsonp({ success: false, error: 'password requerida' });
    }
    var h = _authHashServer(pwd);
    return _authJsonp({ success: true, valid: h === stored });
  } catch (err) {
    Logger.log('verifyPassword error: ' + err.message);
    return _authJsonp({ success: false, error: err.message });
  }
}

function _handleSetPassword(data) {
  try {
    var nueva = String(data.password || '');
    if (nueva.length < 4) {
      return _authJsonp({ success: false, error: 'Mínimo 4 caracteres' });
    }
    var stored = _authReadStoredHash();
    if (stored) {
      // Hay password configurada — exigir la actual para cambiarla
      var actual = String(data.currentPassword || '');
      if (!actual) {
        return _authJsonp({ success: false, error: 'Falta currentPassword' });
      }
      if (_authHashServer(actual) !== stored) {
        return _authJsonp({ success: false, error: 'Contraseña actual incorrecta' });
      }
    }
    _authWriteHash(_authHashServer(nueva));
    Logger.log('🔐 Password ' + (stored ? 'cambiada' : 'configurada'));
    return _authJsonp({ success: true });
  } catch (err) {
    Logger.log('setPassword error: ' + err.message);
    return _authJsonp({ success: false, error: err.message });
  }
}

// Reset solo con token override (admin BalanceClip).
// El token se guarda como Script Property en el proyecto GAS:
//   ScriptProperties → AUTH_RESET_TOKEN
function _handleResetPassword(data) {
  try {
    var t = String(data.overrideToken || '').trim();
    if (!t) return _authJsonp({ success: false, error: 'token requerido' });
    var expected = PropertiesService.getScriptProperties().getProperty('AUTH_RESET_TOKEN') || '';
    if (!expected) {
      return _authJsonp({ success: false, error: 'Reset deshabilitado: configura AUTH_RESET_TOKEN en Script Properties.' });
    }
    if (t !== expected) {
      Utilities.sleep(1500); // throttle ataques
      return _authJsonp({ success: false, error: 'Token inválido' });
    }
    _authWriteHash('');
    Logger.log('🔓 Password reset by admin override');
    return _authJsonp({ success: true });
  } catch (err) {
    Logger.log('resetPassword error: ' + err.message);
    return _authJsonp({ success: false, error: err.message });
  }
}

// ════════════════════════════════════════════════════════════════
//  RESET POR OTP VIA WHATSAPP (self-service del cliente)
//
//  Flujo:
//   1. solicitarCodigoReset({ phone }) → valida phone contra config,
//      genera OTP 6 dígitos, lo guarda en CacheService (5 min TTL),
//      POSTea al router para que el bot lo mande por WhatsApp.
//   2. verificarCodigoYResetear({ phone, code, newPassword }) →
//      valida OTP en cache, hashea nueva password, devuelve autoAuth.
//
//  Rate limit: max 3 OTPs/hora por número (CacheService).
//
//  Requiere Script Properties:
//   - ROUTER_URL          — URL del router de WhatsApp
//   - ROUTER_RESET_TOKEN  — shared secret para autenticar con el router
// ════════════════════════════════════════════════════════════════
function _handleSolicitarCodigoReset(data) {
  try {
    var phone = String(data.phone || '').replace(/\D/g, '').trim();
    if (!phone || phone.length < 8) {
      return _authJsonp({ success: false, error: 'Número de WhatsApp inválido' });
    }
    // Normalizar: si vino sin código país y son 8 dígitos (Panamá), prepend 507
    if (phone.length === 8) phone = '507' + phone;

    // Verificar contra el WhatsApp configurado para esta empresa.
    // Primero busca en OTP_CONFIG (inyectado por deploy-gas.js desde
    // scripts/otp-config.json), después fallback a config_operaciones.
    var registered = '';
    if (typeof OTP_CONFIG !== 'undefined' && OTP_CONFIG.WA_ADMIN_PHONE) {
      registered = String(OTP_CONFIG.WA_ADMIN_PHONE).replace(/\D/g, '').trim();
    }
    if (!registered) {
      var cfg = _getConfig();
      registered = String(cfg.wa_admin_phone || '').replace(/\D/g, '').trim();
    }
    if (registered && registered.length === 8) registered = '507' + registered;
    if (!registered) {
      return _authJsonp({
        success: false,
        error: 'No hay WhatsApp configurado para esta cuenta. Contactá a soporte de BalanceClip.'
      });
    }
    if (registered !== phone) {
      Utilities.sleep(1500);
      return _authJsonp({ success: false, error: 'Ese número no está registrado en esta cuenta' });
    }

    var cache = CacheService.getScriptCache();

    // Rate limit: max 3 OTPs por hora
    var rateKey = 'otp_rate_' + phone;
    var current = parseInt(cache.get(rateKey) || '0', 10);
    if (current >= 3) {
      return _authJsonp({ success: false, error: 'Demasiados intentos. Esperá 1 hora.' });
    }
    cache.put(rateKey, String(current + 1), 3600);

    // Generar OTP de 6 dígitos
    var otp = String(Math.floor(100000 + Math.random() * 900000));
    cache.put('otp_' + phone, otp, 300); // 5 min TTL

    // Enviar al router. Las credenciales vienen de OTP_CONFIG (inyectado
    // por deploy-gas.js) con fallback a Script Properties para retrocompat.
    var routerUrl   = '';
    var routerToken = '';
    if (typeof OTP_CONFIG !== 'undefined') {
      routerUrl   = OTP_CONFIG.ROUTER_URL         || '';
      routerToken = OTP_CONFIG.ROUTER_RESET_TOKEN || '';
    }
    if (!routerUrl || !routerToken) {
      var props = PropertiesService.getScriptProperties();
      routerUrl   = routerUrl   || props.getProperty('ROUTER_URL')         || '';
      routerToken = routerToken || props.getProperty('ROUTER_RESET_TOKEN') || '';
    }
    if (!routerUrl || !routerToken) {
      Logger.log('⚠️ ROUTER_URL o ROUTER_RESET_TOKEN no configurado (ni en OTP_CONFIG ni en Script Properties) — OTP no enviado');
      return _authJsonp({
        success: false,
        error: 'Servicio temporalmente no disponible. Contactá a soporte.'
      });
    }

    try {
      UrlFetchApp.fetch(routerUrl, {
        method:      'post',
        contentType: 'application/json',
        payload:     JSON.stringify({
          action: 'sendResetOtp',
          token:  routerToken,
          phone:  phone,
          otp:    otp,
        }),
        muteHttpExceptions: true,
      });
    } catch (err) {
      Logger.log('Error enviando OTP al router: ' + err.message);
      return _authJsonp({ success: false, error: 'No se pudo enviar el código' });
    }

    Logger.log('🔐 OTP de reset solicitado para ' + phone);
    return _authJsonp({ success: true, sent_to: phone.slice(0, 3) + '***' + phone.slice(-4) });
  } catch (err) {
    Logger.log('solicitarCodigoReset error: ' + err.message);
    return _authJsonp({ success: false, error: err.message });
  }
}

function _handleVerificarCodigoYResetear(data) {
  try {
    var phone = String(data.phone || '').replace(/\D/g, '').trim();
    if (phone.length === 8) phone = '507' + phone;
    var code        = String(data.code || '').trim();
    var newPassword = String(data.newPassword || '');

    if (!phone)               return _authJsonp({ success: false, error: 'phone requerido' });
    if (!/^\d{6}$/.test(code)) return _authJsonp({ success: false, error: 'código debe ser 6 dígitos' });
    if (newPassword.length < 4) {
      return _authJsonp({ success: false, error: 'La contraseña debe tener al menos 4 caracteres' });
    }

    var cache = CacheService.getScriptCache();
    var stored = cache.get('otp_' + phone);
    if (!stored) {
      return _authJsonp({ success: false, error: 'Código expirado. Pedí uno nuevo.' });
    }
    if (stored !== code) {
      Utilities.sleep(1500);
      return _authJsonp({ success: false, error: 'Código incorrecto' });
    }

    // Single-use: invalidar el OTP inmediatamente
    cache.remove('otp_' + phone);

    // Setear nueva password
    _authWriteHash(_authHashServer(newPassword));
    Logger.log('🔓 Password reseteada via WhatsApp OTP por ' + phone);

    // autoAuth: true → el frontend marca bc_authed=1 sin pedir login otra vez
    return _authJsonp({ success: true, autoAuth: true });
  } catch (err) {
    Logger.log('verificarCodigoYResetear error: ' + err.message);
    return _authJsonp({ success: false, error: err.message });
  }
}
