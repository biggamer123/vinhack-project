const crypto = require('crypto');

const ITERATIONS = 210000;
const KEY_LENGTH = 32;

function hashPassword(password, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, useSalt, ITERATIONS, KEY_LENGTH, 'sha256').toString('hex');
  return `pbkdf2$${ITERATIONS}$${useSalt}$${hash}`;
}

function parseHash(stored) {
  const [scheme, iterations, salt, hash] = String(stored).split('$');
  if (scheme !== 'pbkdf2' || !salt || !hash) {
    return null;
  }
  return { iterations: Number(iterations), salt, hash };
}

function verifyPassword(password, stored) {
  const parsed = parseHash(stored);
  if (!parsed) {
    return false;
  }
  const candidate = crypto
    .pbkdf2Sync(password, parsed.salt, parsed.iterations, KEY_LENGTH, 'sha256')
    .toString('hex');
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(parsed.hash));
}

function needsRehash(stored) {
  const parsed = parseHash(stored);
  return !parsed || parsed.iterations < ITERATIONS;
}

function isStrongPassword(password) {
  return typeof password === 'string' && password.length >= 12 && /\d/.test(password) && /[A-Z]/.test(password);
}

module.exports = { hashPassword, verifyPassword, needsRehash, isStrongPassword, parseHash };
