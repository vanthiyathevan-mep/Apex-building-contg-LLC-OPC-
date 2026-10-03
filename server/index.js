'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('./db');
const auth = require('./auth');
const api = require('./api');
const reports = require('./reports');
const { ValidationError } = require('./resources');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 1024 * 1024;
const COOKIE = 'erp_session';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; frame-ancestors 'none'",
};
const SETTING_KEYS = ['company_name', 'company_address', 'company_phone', 'company_email', 'company_trn', 'currency',
  'default_vat_rate', 'default_retention_pct', 'invoice_terms'];

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new api.HttpError(413, 'Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new api.HttpError(400, 'Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  const isString = typeof body === 'string';
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isString ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isString ? body : JSON.stringify(body));
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  let file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    if (path.extname(rel)) return send(res, 404, 'Not found');
    file = path.join(PUBLIC_DIR, 'index.html'); // SPA fallback
  }
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

function createApp({ dbFile, adminPassword, secureCookies = false } = {}) {
  const db = openDatabase(dbFile || path.join(__dirname, '..', 'data', 'erp.db'));
  const generatedPassword = auth.ensureAdmin(db, adminPassword);
  const cookieAttrs = `Path=/; HttpOnly; SameSite=Strict${secureCookies ? '; Secure' : ''}`;

  async function handleApi(req, res, url, segs) {
    const method = req.method;
    const query = Object.fromEntries(url.searchParams);
    const cookies = parseCookies(req.headers.cookie);

    // Public endpoints
    if (segs[0] === 'login' && method === 'POST') {
      const body = await readBody(req);
      const username = String(body.username || '').trim();
      const key = `${req.socket.remoteAddress}|${username.toLowerCase()}`;
      if (auth.loginThrottled(key)) return send(res, 429, { error: 'Too many failed attempts. Try again in 15 minutes.' });
      const u = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
      if (!u || !auth.verifyPassword(String(body.password || ''), u.password_hash)) {
        auth.recordLoginFailure(key);
        return send(res, 401, { error: 'Invalid username or password' });
      }
      auth.clearLoginFailures(key);
      const token = auth.createSession(db, u.id);
      api.logActivity(db, u, 'signed in', { key: 'users' }, u.id, u.full_name);
      return send(res, 200, { user: { id: u.id, username: u.username, full_name: u.full_name, role: u.role } },
        { 'Set-Cookie': `${COOKIE}=${token}; ${cookieAttrs}; Max-Age=${auth.SESSION_TTL_MS / 1000}` });
    }
    if (segs[0] === 'logout' && method === 'POST') {
      auth.destroySession(db, cookies[COOKIE]);
      return send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; ${cookieAttrs}; Max-Age=0` });
    }
    if (segs[0] === 'health') return send(res, 200, { ok: true });

    const user = auth.getSessionUser(db, cookies[COOKIE]);
    if (!user) return send(res, 401, { error: 'Not signed in' });

    // Mutations must come from our own JSON client (blocks cross-site form posts).
    if (method !== 'GET' && !String(req.headers['content-type'] || '').includes('application/json')) {
      return send(res, 415, { error: 'Content-Type must be application/json' });
    }

    const [a, b, c, d] = segs;
    if (a === 'me' && !b && method === 'GET') return send(res, 200, { user });
    if (a === 'me' && b === 'password' && method === 'POST') {
      const body = await readBody(req);
      const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
      if (!auth.verifyPassword(String(body.current_password || ''), row.password_hash)) throw new ValidationError('Current password is incorrect');
      if (String(body.new_password || '').length < 8) throw new ValidationError('New password must be at least 8 characters');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(body.new_password), user.id);
      return send(res, 200, { ok: true });
    }
    if (a === 'meta' && method === 'GET') return send(res, 200, { resources: api.meta(user), reports: reports.listReports(user), settings: api.getSettings(db) });
    if (a === 'settings') {
      if (method === 'GET') return send(res, 200, api.getSettings(db));
      if (method === 'PUT') {
        if (user.role !== 'admin') throw new api.HttpError(403, 'Only administrators can change settings');
        const body = await readBody(req);
        const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
        for (const k of SETTING_KEYS) {
          if (body[k] === undefined) continue;
          const v = String(body[k]).trim().slice(0, 2000);
          if ((k === 'default_vat_rate' || k === 'default_retention_pct') && !(Number(v) >= 0 && Number(v) <= 100)) {
            throw new ValidationError(`${k.replace(/_/g, ' ')} must be between 0 and 100`);
          }
          up.run(k, v);
        }
        api.logActivity(db, user, 'updated', { key: 'settings' }, null, 'Company settings');
        return send(res, 200, api.getSettings(db));
      }
    }
    if (a === 'dashboard' && method === 'GET') return send(res, 200, reports.dashboard(db, user));
    if (a === 'reports' && b && method === 'GET') {
      const result = reports.runReport(db, user, b, query);
      if (query.format === 'csv') {
        const rows = result.rows;
        const cols = rows.length ? Object.keys(rows[0]) : [];
        const csv = api.toCsv({ fields: cols.map((k) => ({ name: k, label: k })), computed: {} }, rows);
        return send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${b}.csv"` });
      }
      return send(res, 200, result);
    }
    if (a === 'projects' && b && c === 'summary' && method === 'GET') return send(res, 200, reports.projectSummary(db, user, b));
    if (a === 'activity' && method === 'GET') {
      if (user.role !== 'admin' && user.role !== 'manager') throw new api.HttpError(403, 'Not allowed');
      return send(res, 200, db.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT 500').all());
    }

    // Generic resources: /api/:resource[/:id[/actions/:name]] and /api/:resource/options
    if (a && !b) {
      if (method === 'GET') {
        const result = api.list(db, user, a, query);
        if (query.format === 'csv') {
          const { resources } = require('./resources');
          return send(res, 200, api.toCsv(resources[a], result.rows),
            { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${a}.csv"` });
        }
        return send(res, 200, result);
      }
      if (method === 'POST') return send(res, 201, api.save(db, user, a, null, await readBody(req)));
    }
    if (a && b === 'options' && method === 'GET') return send(res, 200, api.options(db, user, a, query));
    if (a && b && /^\d+$/.test(b)) {
      if (!c) {
        if (method === 'GET') return send(res, 200, api.getOne(db, user, a, b));
        if (method === 'PUT') return send(res, 200, api.save(db, user, a, b, await readBody(req)));
        if (method === 'DELETE') return send(res, 200, api.remove(db, user, a, b));
      }
      if (c === 'actions' && d && method === 'POST') return send(res, 200, api.action(db, user, a, b, d));
    }
    throw new api.HttpError(404, 'Not found');
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, 'Bad request'); }
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      return serveStatic(req, res, decodeURIComponent(url.pathname));
    }
    const segs = url.pathname.slice(5).split('/').filter(Boolean);
    try {
      await handleApi(req, res, url, segs);
    } catch (err) {
      const mapped = err instanceof api.HttpError || err instanceof ValidationError ? err : api.translateDbError(err);
      if (mapped) return send(res, mapped.status || 400, { error: mapped.message });
      console.error(err);
      send(res, 500, { error: 'Internal server error' });
    }
  });

  return { server, db, generatedPassword };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  const { server, db, generatedPassword } = createApp({
    dbFile: process.env.ERP_DB_FILE,
    adminPassword: process.env.ERP_ADMIN_PASSWORD,
    secureCookies: process.env.ERP_SECURE_COOKIES === '1',
  });
  if (process.env.ERP_DEMO === '1' && db.prepare('SELECT COUNT(*) AS n FROM projects').get().n === 0) {
    require('../scripts/seed-demo').seedDemo(db);
    console.log('Demo data loaded (ERP_DEMO=1).');
  }
  server.listen(port, host, () => {
    console.log(`Apex Construction ERP running at http://localhost:${port}`);
    if (generatedPassword) {
      console.log('──────────────────────────────────────────────');
      console.log(' Initial administrator account created');
      console.log('   username: admin');
      console.log(`   password: ${generatedPassword}`);
      console.log(' Sign in and change this password under "My Account".');
      console.log('──────────────────────────────────────────────');
    }
  });
}

module.exports = { createApp };
