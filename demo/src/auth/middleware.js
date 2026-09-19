const { readSession, tokenFromCookie } = require('./session');
const { allowRequest } = require('../rateLimit');
const { trace } = require('../telemetry');

const ROLE_RANK = { reader: 0, author: 1, editor: 2, admin: 3 };

function forbidden(reason) {
  trace('auth.forbidden', { reason });
  return { status: 403, data: { error: reason } };
}

function currentUser(request) {
  const token = tokenFromCookie(request.headers && request.headers.cookie);
  return readSession(token);
}

function requireUser(request) {
  if (!allowRequest(request.ip || 'anon')) {
    return { status: 429, data: { error: 'slow down' } };
  }
  const session = currentUser(request);
  if (!session) {
    return forbidden('login required');
  }
  request.session = session;
  return null;
}

function requireRole(request, role) {
  const denied = requireUser(request);
  if (denied) {
    return denied;
  }
  if ((ROLE_RANK[request.session.role] || 0) < ROLE_RANK[role]) {
    return forbidden(`needs ${role}`);
  }
  return null;
}

module.exports = { requireUser, requireRole, currentUser };
