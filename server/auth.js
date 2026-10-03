'use strict';
const crypto = require('node:crypto');

const ROLES = ['admin', 'manager', 'accountant', 'site_engineer', 'viewer'];
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, Date.now() + SESSION_TTL_MS);
  return token;
}

function getSessionUser(db, token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.username, u.full_name, u.role, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND u.active = 1`).get(sha256(token));
  if (!row || row.expires_at < Date.now()) return null;
  return { id: row.id, username: row.username, full_name: row.full_name, role: row.role };
}

function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

/**
 * Creates the initial admin account when the users table is empty.
 * Returns the generated password (only when none was supplied), otherwise null.
 */
function ensureAdmin(db, password) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n > 0) return null;
  const pw = password || crypto.randomBytes(9).toString('base64url');
  db.prepare('INSERT INTO users (username, full_name, role, password_hash) VALUES (?, ?, ?, ?)')
    .run('admin', 'System Administrator', 'admin', hashPassword(pw));
  return password ? null : pw;
}

/** Simple in-memory login throttle: 10 failures per 15 minutes per key. */
const failures = new Map();
function loginThrottled(key) {
  const f = failures.get(key);
  if (!f) return false;
  if (Date.now() - f.first > 15 * 60 * 1000) { failures.delete(key); return false; }
  return f.count >= 10;
}
function recordLoginFailure(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > 15 * 60 * 1000) failures.set(key, { first: Date.now(), count: 1 });
  else f.count++;
}
function clearLoginFailures(key) { failures.delete(key); }

module.exports = {
  ROLES, hashPassword, verifyPassword, createSession, getSessionUser, destroySession,
  ensureAdmin, loginThrottled, recordLoginFailure, clearLoginFailures, SESSION_TTL_MS,
};
