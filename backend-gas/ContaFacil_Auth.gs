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
  // Reusa _handleGuardarConfig para que invalide el cache automáticamente
  _handleGuardarConfig({ password_hash: String(hash || '') });
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
