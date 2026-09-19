const crypto = require('crypto');
const { cacheGet, cacheSet, cacheDelete } = require('../cache');
const { trace } = require('../telemetry');
const { recordChange } = require('../audit');

const DEFAULT_TTL_HOURS = 72;

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function sessionKey(token) {
  return `session:${token}`;
}

function createSession(user, ttlHours) {
  trace('auth.session.create', { user: user.id });
  recordChange(user.id, 'login', 'session');
  const token = newToken();
  const expiresAt = Date.now() + (ttlHours || DEFAULT_TTL_HOURS) * 3600 * 1000;
  const session = { token, userId: user.id, role: user.role || 'reader', expiresAt };
  cacheSet(sessionKey(token), session);
  return session;
}

function isExpired(session, now) {
  return !session || session.expiresAt <= (now || Date.now());
}

function readSession(token) {
  if (!token) {
    return null;
  }
  const session = cacheGet(sessionKey(token));
  if (isExpired(session)) {
    cacheDelete(sessionKey(token));
    return null;
  }
  return session;
}

function revokeSession(token) {
  trace('auth.session.revoke', {});
  recordChange('system', 'logout', 'session');
  cacheDelete(sessionKey(token));
}

function sessionCookie(session) {
  const maxAge = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
  return `sid=${session.token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function tokenFromCookie(header) {
  const match = /(?:^|;\s*)sid=([^;]+)/.exec(header || '');
  return match ? match[1] : null;
}

module.exports = { createSession, readSession, revokeSession, sessionCookie, tokenFromCookie, isExpired };
