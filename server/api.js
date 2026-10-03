'use strict';
/** Generic, metadata-driven CRUD over the resources in resources.js. */
const { tx } = require('./db');
const { resources, ValidationError, canRead, canWrite, lockedBy } = require('./resources');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const today = () => new Date().toISOString().slice(0, 10);

function getSettings(db) {
  const out = {};
  for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) out[key] = value;
  return out;
}

function resolveDefault(f, settings) {
  if (f.default === 'today') return today();
  if (typeof f.default === 'string' && f.default.startsWith('setting:')) return Number(settings[f.default.slice(8)] ?? 0);
  return f.default;
}

/** Coerce + validate a single raw value for a field. Returns null for empty. */
function coerce(db, f, raw) {
  if (f.type === 'bool') return raw === true || raw === 1 || raw === '1' || raw === 'true' ? 1 : 0;
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return null;
  const bad = (msg) => { throw new ValidationError(`${f.label}: ${msg}`); };
  switch (f.type) {
    case 'number': case 'money': case 'percent': case 'int': {
      const n = Number(raw);
      if (!Number.isFinite(n)) bad('must be a number');
      if (f.type === 'int' && !Number.isInteger(n)) bad('must be a whole number');
      if (f.min !== undefined && n < f.min) bad(`must be at least ${f.min}`);
      if (f.max !== undefined && n > f.max) bad(`must be at most ${f.max}`);
      return f.type === 'money' ? Math.round(n * 100) / 100 : n;
    }
    case 'date': {
      const s = String(raw).trim();
      if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s))) bad('must be a valid date (YYYY-MM-DD)');
      return s;
    }
    case 'ref': {
      const id = Number(raw);
      if (!Number.isInteger(id) || id <= 0) bad('invalid selection');
      const target = resources[f.ref];
      if (!db.prepare(`SELECT 1 FROM ${target.table} WHERE id = ?`).get(id)) bad('selected record does not exist');
      return id;
    }
    default: {
      const s = String(raw).trim();
      if (s.length > 10000) bad('is too long');
      if (f.type === 'email' && !EMAIL_RE.test(s)) bad('must be a valid email address');
      if (f.type === 'select' && !f.options.includes(s)) bad(`must be one of: ${f.options.join(', ')}`);
      if (f.pattern && !new RegExp(f.pattern).test(s)) bad('has an invalid format');
      return s;
    }
  }
}

function buildRecord(db, fields, body, existing, settings) {
  const data = {};
  for (const f of fields) {
    if (f.readonly) continue;
    let v;
    if (Object.prototype.hasOwnProperty.call(body, f.name)) v = coerce(db, f, body[f.name]);
    else if (existing && !f.virtual) v = existing[f.name];
    else v = null;
    if (v === null && !existing && f.default !== undefined) v = resolveDefault(f, settings);
    if (v === null && f.required) throw new ValidationError(`${f.label} is required`);
    data[f.name] = v;
  }
  return data;
}

function columnsOf(r) {
  return [...r.fields.filter((f) => !f.virtual).map((f) => f.name), ...(r.extraColumns || [])];
}

function selectSql(r) {
  const cols = ['t.id', ...r.fields.filter((f) => !f.virtual).map((f) => `t.${f.name}`), 't.created_at'];
  const joins = [];
  for (const f of r.fields) {
    if (f.type !== 'ref') continue;
    const target = resources[f.ref];
    const alias = `j_${f.name}`;
    joins.push(`LEFT JOIN ${target.table} ${alias} ON ${alias}.id = t.${f.name}`);
    cols.push(`${target.display(alias)} AS ${f.name}_label`);
  }
  for (const [name, c] of Object.entries(r.computed)) cols.push(`${c.sql} AS ${name}`);
  cols.push(`${r.display('t')} AS _label`);
  return `SELECT ${cols.join(', ')} FROM ${r.table} t ${joins.join(' ')}`;
}

const dateFieldOf = (r) => r.fields.find((f) => f.type === 'date' && f.default === 'today');

function whereSql(r, query) {
  const where = [];
  const params = [];
  if (query.q) {
    const like = `%${String(query.q).slice(0, 100)}%`;
    const searchCols = r.search.map((c) => `t.${c} LIKE ?`);
    for (const f of r.fields) {
      if (f.type === 'ref') { searchCols.push(`${resources[f.ref].display(`j_${f.name}`)} LIKE ?`); }
    }
    where.push(`(${searchCols.join(' OR ')})`);
    for (let i = 0; i < searchCols.length; i++) params.push(like);
  }
  for (const f of r.fields) {
    if (f.virtual || query[f.name] === undefined || query[f.name] === '') continue;
    where.push(`t.${f.name} = ?`);
    params.push(f.type === 'ref' || f.type === 'int' || f.type === 'bool' ? Number(query[f.name]) : String(query[f.name]));
  }
  for (const [name, c] of Object.entries(r.computed)) {
    if (query[name] === undefined || query[name] === '') continue;
    where.push(`${c.sql} = ?`);
    params.push(String(query[name]));
  }
  const df = dateFieldOf(r);
  if (df && query.from && DATE_RE.test(query.from)) { where.push(`t.${df.name} >= ?`); params.push(query.from); }
  if (df && query.to && DATE_RE.test(query.to)) { where.push(`t.${df.name} <= ?`); params.push(query.to); }
  return { sql: where.length ? ` WHERE ${where.join(' AND ')}` : '', params };
}

function orderSql(r, query) {
  const dir = String(query.dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const s = query.sort;
  if (s) {
    const f = r.fields.find((x) => x.name === s && !x.virtual);
    if (f) return ` ORDER BY ${f.type === 'ref' ? `${s}_label` : `t.${s}`} ${dir}, t.id DESC`;
    if (r.computed[s]) return ` ORDER BY ${s} ${dir}, t.id DESC`;
  }
  return ` ORDER BY ${r.defaultSort.split(',').map((p) => (p.trim().startsWith('t.') ? p : `t.${p.trim()}`)).join(', ')}`;
}

function getResource(name, user, needWrite) {
  const r = resources[name];
  if (!r) throw new HttpError(404, 'Unknown resource');
  if (!canRead(r, user)) throw new HttpError(403, 'You do not have access to this module');
  if (needWrite && !canWrite(r, user)) throw new HttpError(403, 'Your role cannot modify this module');
  return r;
}

function list(db, user, name, query) {
  const r = getResource(name, user);
  const base = selectSql(r);
  const where = whereSql(r, query);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), query.format === 'csv' ? 50000 : 1000);
  const offset = Math.max(parseInt(query.offset, 10) || 0, 0);
  const rows = db.prepare(`${base}${where.sql}${orderSql(r, query)} LIMIT ? OFFSET ?`).all(...where.params, limit, offset);
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM (${base}${where.sql})`).get(...where.params);
  return { rows, total: n, limit, offset };
}

function getOne(db, user, name, id) {
  const r = getResource(name, user);
  const row = db.prepare(`${selectSql(r)} WHERE t.id = ?`).get(Number(id));
  if (!row) throw new HttpError(404, `${r.singular} not found`);
  if (r.children) {
    const c = r.children;
    const refCols = c.fields.filter((f) => f.type === 'ref');
    const joins = refCols.map((f) => `LEFT JOIN ${resources[f.ref].table} j_${f.name} ON j_${f.name}.id = i.${f.name}`).join(' ');
    const labels = refCols.map((f) => `, ${resources[f.ref].display(`j_${f.name}`)} AS ${f.name}_label`).join('');
    row[c.key] = db.prepare(`SELECT i.*${labels} FROM ${c.table} i ${joins} WHERE i.${c.fk} = ? ORDER BY i.id`).all(row.id);
  }
  return row;
}

function options(db, user, name, query) {
  const r = getResource(name, user);
  const q = query.q ? `%${String(query.q).slice(0, 100)}%` : '%';
  return db.prepare(`SELECT t.id, ${r.display('t')} AS label FROM ${r.table} t WHERE (${r.display('t')}) LIKE ? ORDER BY label LIMIT 2000`).all(q);
}

function logActivity(db, user, action, r, id, summary) {
  db.prepare('INSERT INTO activity (user_id, username, action, resource, record_id, summary) VALUES (?, ?, ?, ?, ?, ?)')
    .run(user.id, user.username, action, r.key, id, summary ?? null);
}

function labelOf(db, r, id) {
  const row = db.prepare(`SELECT ${r.display('t')} AS label FROM ${r.table} t WHERE t.id = ?`).get(id);
  return row ? String(row.label) : null;
}

function assertUnlocked(r, op, row) {
  const lock = lockedBy(r, op, row);
  if (lock) throw new ValidationError(`A ${String(lock.value).toLowerCase()} ${r.singular.toLowerCase()} cannot be ${op === 'update' ? 'edited' : 'deleted'}`);
}

function runHooks(list_, ...args) { for (const h of list_ || []) h(...args); }

function save(db, user, name, id, body) {
  const r = getResource(name, user, true);
  const op = id == null ? 'create' : 'update';
  if (!r.ops.includes(op)) throw new HttpError(405, `${r.singular} records cannot be ${op === 'create' ? 'created' : 'edited'}`);
  if (!body || typeof body !== 'object') throw new ValidationError('Invalid request body');
  const settings = getSettings(db);

  return tx(db, () => {
    let existing = null;
    if (op === 'update') {
      existing = db.prepare(`SELECT * FROM ${r.table} WHERE id = ?`).get(Number(id));
      if (!existing) throw new HttpError(404, `${r.singular} not found`);
      assertUnlocked(r, 'update', existing);
    }
    const data = buildRecord(db, r.fields, body, existing, settings);
    let children = null;
    if (r.children) {
      const raw = Array.isArray(body[r.children.key]) ? body[r.children.key] : null;
      if (raw === null && existing) {
        children = db.prepare(`SELECT * FROM ${r.children.table} WHERE ${r.children.fk} = ?`).all(existing.id);
      } else {
        if ((raw || []).length > 500) throw new ValidationError('Too many line items');
        children = (raw || []).map((item, i) => {
          try { return buildRecord(db, r.children.fields, item || {}, null, settings); }
          catch (e) { throw new ValidationError(`Line ${i + 1}: ${e.message}`); }
        });
      }
    }
    const ctx = { existing, user, op, children, settings };
    runHooks(r.hooks.beforeSave, db, data, ctx);

    const cols = columnsOf(r).filter((c) => Object.prototype.hasOwnProperty.call(data, c));
    let recId;
    if (op === 'create') {
      const res = db.prepare(`INSERT INTO ${r.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => data[c]));
      recId = Number(res.lastInsertRowid);
    } else {
      recId = existing.id;
      if (cols.length) {
        db.prepare(`UPDATE ${r.table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => data[c]), recId);
      }
    }
    if (r.children) {
      const c = r.children;
      db.prepare(`DELETE FROM ${c.table} WHERE ${c.fk} = ?`).run(recId);
      const ccols = c.fields.map((f) => f.name);
      const ins = db.prepare(`INSERT INTO ${c.table} (${c.fk}, ${ccols.join(', ')}) VALUES (?, ${ccols.map(() => '?').join(', ')})`);
      for (const item of children) ins.run(recId, ...ccols.map((k) => item[k] ?? null));
    }
    runHooks(r.hooks.afterSave, db, recId, data, ctx);
    logActivity(db, user, op === 'create' ? 'created' : 'updated', r, recId, labelOf(db, r, recId));
    return getOne(db, user, name, recId);
  });
}

function remove(db, user, name, id) {
  const r = getResource(name, user, true);
  if (!r.ops.includes('delete')) throw new HttpError(405, `${r.singular} records cannot be deleted`);
  return tx(db, () => {
    const row = db.prepare(`SELECT * FROM ${r.table} WHERE id = ?`).get(Number(id));
    if (!row) throw new HttpError(404, `${r.singular} not found`);
    assertUnlocked(r, 'delete', row);
    const label = labelOf(db, r, row.id);
    runHooks(r.hooks.beforeDelete, db, row, { user });
    db.prepare(`DELETE FROM ${r.table} WHERE id = ?`).run(row.id);
    logActivity(db, user, 'deleted', r, row.id, label);
    return { ok: true };
  });
}

function action(db, user, name, id, actionName) {
  const r = getResource(name, user, true);
  const handler = r.actionHandlers && r.actionHandlers[actionName];
  if (!handler) throw new HttpError(404, 'Unknown action');
  return tx(db, () => {
    const row = db.prepare(`SELECT * FROM ${r.table} WHERE id = ?`).get(Number(id));
    if (!row) throw new HttpError(404, `${r.singular} not found`);
    const summary = handler(db, row, { user });
    logActivity(db, user, actionName, r, row.id, summary || labelOf(db, r, row.id));
    return getOne(db, user, name, row.id);
  });
}

/** Resource metadata for the UI (functions/SQL stripped). */
function meta(user) {
  const out = {};
  for (const [key, r] of Object.entries(resources)) {
    if (!canRead(r, user)) continue;
    out[key] = {
      key, label: r.label, singular: r.singular, group: r.group, icon: r.icon,
      canWrite: canWrite(r, user), ops: r.ops, printable: !!r.printable, detailView: r.detailView || null,
      dateField: dateFieldOf(r)?.name || null,
      fields: r.fields, children: r.children || null, actions: r.actions || [], locked: r.locked || null,
      computed: Object.fromEntries(Object.entries(r.computed).map(([k, c]) => [k, { label: c.label, type: c.type, list: !!c.list }])),
    };
  }
  return out;
}

function toCsv(r, rows) {
  const cols = [
    ...r.fields.filter((f) => !f.virtual).map((f) => ({ key: f.type === 'ref' ? `${f.name}_label` : f.name, label: f.label })),
    ...Object.entries(r.computed).map(([k, c]) => ({ key: k, label: c.label })),
  ];
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`; // spreadsheet formula injection guard
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map((c) => esc(c.label)).join(','), ...rows.map((row) => cols.map((c) => esc(row[c.key])).join(','))].join('\r\n');
}

/** Map SQLite constraint errors to friendly HTTP errors. */
function translateDbError(err, name) {
  const msg = String(err && err.message);
  const m = msg.match(/UNIQUE constraint failed: (\w+)\.(\w+)/);
  if (m) {
    const r = Object.values(resources).find((x) => x.table === m[1]);
    const f = r && r.fields.find((x) => x.name === m[2]);
    return new HttpError(409, `${f ? f.label : m[2]} already exists`);
  }
  if (msg.includes('UNIQUE constraint failed')) return new HttpError(409, 'A duplicate record already exists');
  if (msg.includes('FOREIGN KEY constraint failed')) {
    return new HttpError(409, 'This record is referenced by other records (e.g. projects, invoices or timesheets) and cannot be deleted');
  }
  return null;
}

module.exports = { list, getOne, options, save, remove, action, meta, toCsv, getSettings, HttpError, translateDbError, logActivity };
