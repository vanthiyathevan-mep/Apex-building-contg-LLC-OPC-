'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/index');
const { seedDemo } = require('../scripts/seed-demo');

let app;
let base;

before(async () => {
  app = createApp({ dbFile: ':memory:', adminPassword: 'admin-pass-123' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => new Promise((r) => app.server.close(r)));

/** Minimal cookie-keeping client. */
function client() {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  return {
    call,
    cookie: () => cookie,
    get: (p) => call('GET', p),
    post: (p, b = {}) => call('POST', p, b),
    put: (p, b) => call('PUT', p, b),
    del: (p) => call('DELETE', p),
    login: (username, password) => call('POST', '/api/login', { username, password }),
  };
}

async function admin() {
  const c = client();
  const r = await c.login('admin', 'admin-pass-123');
  assert.equal(r.status, 200);
  return c;
}

async function userWithRole(adminClient, role) {
  const username = `${role}_${Math.random().toString(36).slice(2, 8)}`;
  const r = await adminClient.post('/api/users', { username, full_name: role, role, password: 'password-123' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const c = client();
  assert.equal((await c.login(username, 'password-123')).status, 200);
  return c;
}

async function baseData(c) {
  const client_ = (await c.post('/api/clients', { name: `Client ${Math.random()}` })).data;
  const project = (await c.post('/api/projects', { name: 'Test Tower', client_id: client_.id, contract_value: 500000, budget: 400000, status: 'Active', start_date: '2026-01-10' })).data;
  const supplier = (await c.post('/api/suppliers', { name: `Supplier ${Math.random()}` })).data;
  const material = (await c.post('/api/materials', { name: 'Cement', unit: 'Bag', reorder_level: 10 })).data;
  const employee = (await c.post('/api/employees', { full_name: 'Worker One', daily_rate: 200 })).data;
  return { client: client_, project, supplier, material, employee };
}

test('rejects unauthenticated access and bad credentials', async () => {
  const c = client();
  assert.equal((await c.get('/api/projects')).status, 401);
  assert.equal((await c.login('admin', 'wrong')).status, 401);
  assert.equal((await c.get('/api/me')).status, 401);
});

test('login sets an HttpOnly session cookie and logout clears it', async () => {
  const c = client();
  const r = await c.login('admin', 'admin-pass-123');
  assert.match(r.headers.get('set-cookie'), /HttpOnly/);
  assert.match(r.headers.get('set-cookie'), /SameSite=Strict/);
  assert.equal((await c.get('/api/me')).data.user.username, 'admin');
  await c.post('/api/logout');
  assert.equal((await c.get('/api/me')).status, 401);
});

test('mutations require a JSON content type (blocks cross-site form posts)', async () => {
  const c = await admin();
  const res = await fetch(`${base}/api/clients`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: c.cookie() }, body: 'name=x',
  });
  assert.equal(res.status, 415);
});

test('auto-numbers documents and validates input', async () => {
  const c = await admin();
  const { project } = await baseData(c);
  assert.match(project.code, /^PRJ-2026-\d{3}$/);
  let r = await c.post('/api/projects', { contract_value: 10 });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Project Name is required/);
  r = await c.post('/api/projects', { name: 'X', status: 'Bogus' });
  assert.equal(r.status, 400);
  r = await c.post('/api/projects', { name: 'X', progress: 150 });
  assert.match(r.data.error, /at most 100/);
  r = await c.post('/api/clients', { name: 'Bad email', email: 'nope' });
  assert.match(r.data.error, /valid email/);
  r = await c.post('/api/projects', { name: 'X', client_id: 99999 });
  assert.match(r.data.error, /does not exist/);
});

test('duplicate names and in-use deletes return 409', async () => {
  const c = await admin();
  const { client: cl } = await baseData(c);
  assert.equal((await c.post('/api/clients', { name: cl.name })).status, 409);
  const del = await c.del(`/api/clients/${cl.id}`);
  assert.equal(del.status, 409);
});

test('timesheet cost uses daily rate with 25% overtime premium', async () => {
  const c = await admin();
  const { project, employee } = await baseData(c);
  const r = await c.post('/api/timesheets', { employee_id: employee.id, project_id: project.id, work_date: '2026-02-01', hours: 8, overtime_hours: 2 });
  assert.equal(r.status, 201);
  assert.equal(r.data.cost, 200 + 25 * 1.25 * 2);
  assert.equal((await c.post('/api/timesheets', { employee_id: employee.id, project_id: project.id, work_date: '2026-02-02', hours: 20, overtime_hours: 6 })).status, 400);
});

test('purchase order → receive → issue to project flows into inventory and job cost', async () => {
  const c = await admin();
  const { project, supplier, material } = await baseData(c);
  const po = await c.post('/api/purchase_orders', {
    supplier_id: supplier.id, project_id: project.id, order_date: '2026-03-01', status: 'Approved',
    items: [
      { material_id: material.id, description: 'Cement', quantity: 100, unit_price: 20 },
      { description: 'Crane hire', quantity: 2, unit_price: 1000 },
    ],
  });
  assert.equal(po.status, 201, JSON.stringify(po.data));
  assert.equal(po.data.subtotal, 4000);
  assert.equal(po.data.vat_amount, 200);
  assert.equal(po.data.total, 4200);
  assert.match(po.data.po_no, /^PO-2026-\d{4}$/);

  // Cannot set Received directly.
  assert.equal((await c.put(`/api/purchase_orders/${po.data.id}`, { status: 'Received' })).status, 400);

  const rec = await c.post(`/api/purchase_orders/${po.data.id}/actions/receive`);
  assert.equal(rec.status, 200);
  assert.equal(rec.data.status, 'Received');
  assert.equal((await c.post(`/api/purchase_orders/${po.data.id}/actions/receive`)).status, 400);
  assert.equal((await c.put(`/api/purchase_orders/${po.data.id}`, { notes: 'x' })).status, 400);
  assert.equal((await c.del(`/api/purchase_orders/${po.data.id}`)).status, 400);

  let m = (await c.get(`/api/materials/${material.id}`)).data;
  assert.equal(m.stock_qty, 100);
  assert.equal(m.unit_cost, 20);

  const out = await c.post('/api/stock_movements', { material_id: material.id, project_id: project.id, type: 'OUT', quantity: 30, movement_date: '2026-03-05' });
  assert.equal(out.status, 201);
  assert.equal(out.data.unit_cost, 20);
  assert.match((await c.post('/api/stock_movements', { material_id: material.id, project_id: project.id, type: 'OUT', quantity: 500, movement_date: '2026-03-05' })).data.error, /Insufficient stock/);
  assert.equal((await c.post('/api/stock_movements', { material_id: material.id, type: 'OUT', quantity: 1, movement_date: '2026-03-05' })).status, 400);
  m = (await c.get(`/api/materials/${material.id}`)).data;
  assert.equal(m.stock_qty, 70);

  // Material edits cannot overwrite stock quantity.
  await c.put(`/api/materials/${material.id}`, { stock_qty: 99999, name: 'Cement OPC' });
  assert.equal((await c.get(`/api/materials/${material.id}`)).data.stock_qty, 70);

  const summary = (await c.get(`/api/projects/${project.id}/summary`)).data;
  assert.equal(summary.material_cost, 600);
  assert.equal(summary.purchase_cost, 2000);
  assert.equal(summary.total_cost, 2600);

  // Deleting the issue returns stock.
  assert.equal((await c.del(`/api/stock_movements/${out.data.id}`)).status, 200);
  assert.equal((await c.get(`/api/materials/${material.id}`)).data.stock_qty, 100);
  // Stock movements are immutable (create/delete only).
  assert.equal((await c.put(`/api/stock_movements/${out.data.id}`, { quantity: 1 })).status, 405);
});

test('invoice totals, retention, payments and balance', async () => {
  const c = await admin();
  const { project } = await baseData(c);
  const inv = await c.post('/api/invoices', {
    project_id: project.id, issue_date: '2026-04-01', due_date: '2026-05-01', status: 'Draft', retention_pct: 10,
    items: [{ description: 'Progress claim 1', quantity: 1, rate: 100000 }],
  });
  assert.equal(inv.status, 201, JSON.stringify(inv.data));
  assert.equal(inv.data.subtotal, 100000);
  assert.equal(inv.data.vat_amount, 5000);
  assert.equal(inv.data.retention_amount, 10000);
  assert.equal(inv.data.total, 95000);
  assert.match(inv.data.invoice_no, /^INV-2026-\d{4}$/);

  // Draft invoices cannot be paid.
  assert.equal((await c.post('/api/payments', { invoice_id: inv.data.id, amount: 10, payment_date: '2026-04-10' })).status, 400);
  await c.put(`/api/invoices/${inv.data.id}`, { status: 'Issued' });
  assert.equal((await c.post('/api/payments', { invoice_id: inv.data.id, amount: 60000, payment_date: '2026-04-10' })).status, 201);
  const over = await c.post('/api/payments', { invoice_id: inv.data.id, amount: 40000, payment_date: '2026-04-11' });
  assert.equal(over.status, 400);
  assert.match(over.data.error, /exceeds the outstanding balance of 35000.00/);

  const after = (await c.get(`/api/invoices/${inv.data.id}`)).data;
  assert.equal(after.paid, 60000);
  assert.equal(after.balance, 35000);
  assert.ok(['Overdue', 'Partially Paid'].includes(after.payment_state));
  // Paid invoice cannot go back to Draft.
  assert.equal((await c.put(`/api/invoices/${inv.data.id}`, { status: 'Draft' })).status, 400);
  assert.equal((await c.post('/api/invoices', { project_id: project.id, issue_date: '2026-04-01', items: [] })).status, 400);
});

test('role-based access control', async () => {
  const a = await admin();
  const { project, employee } = await baseData(a);
  const site = await userWithRole(a, 'site_engineer');
  const viewer = await userWithRole(a, 'viewer');
  const accountant = await userWithRole(a, 'accountant');

  assert.equal((await site.post('/api/timesheets', { employee_id: employee.id, project_id: project.id, work_date: '2026-05-01' })).status, 201);
  assert.equal((await site.post('/api/invoices', { project_id: project.id, items: [{ description: 'x', rate: 1 }] })).status, 403);
  assert.equal((await site.get('/api/invoices')).status, 403);
  assert.equal((await site.get('/api/reports/receivables-aging')).status, 403);
  assert.equal((await site.get(`/api/projects/${project.id}/summary`)).data.invoiced, undefined);
  assert.equal((await viewer.post('/api/clients', { name: 'Nope' })).status, 403);
  assert.equal((await viewer.get('/api/invoices')).status, 200);
  assert.equal((await accountant.post('/api/projects', { name: 'Nope' })).status, 403);
  assert.equal((await accountant.get('/api/users')).status, 403);
  assert.equal((await accountant.put('/api/settings', { company_name: 'Hacked' })).status, 403);

  const meta = (await site.get('/api/meta')).data;
  assert.ok(!meta.resources.users);
  assert.ok(!meta.resources.invoices);
  assert.equal(meta.resources.timesheets.canWrite, true);
  assert.equal(meta.resources.projects.canWrite, false);
});

test('user passwords are hashed and never returned', async () => {
  const a = await admin();
  const r = await a.post('/api/users', { username: 'pwcheck', full_name: 'PW', role: 'viewer', password: 'short' });
  assert.equal(r.status, 400);
  const ok = await a.post('/api/users', { username: 'pwcheck', full_name: 'PW', role: 'viewer', password: 'long-enough-1' });
  assert.equal(ok.status, 201);
  const list = await a.get('/api/users');
  assert.ok(!JSON.stringify(list.data).includes('password_hash'));
  assert.ok(!JSON.stringify(list.data).includes('scrypt$'));
  // Deactivating a user ends their sessions.
  const u = client();
  assert.equal((await u.login('pwcheck', 'long-enough-1')).status, 200);
  await a.put(`/api/users/${ok.data.id}`, { active: 0 });
  assert.equal((await u.get('/api/me')).status, 401);
  // Admin cannot demote or delete themselves.
  const me = (await a.get('/api/me')).data.user;
  assert.equal((await a.put(`/api/users/${me.id}`, { role: 'viewer' })).status, 400);
  assert.equal((await a.del(`/api/users/${me.id}`)).status, 400);
});

test('change own password', async () => {
  const a = await admin();
  const u = await userWithRole(a, 'manager');
  assert.equal((await u.post('/api/me/password', { current_password: 'bad', new_password: 'new-password-1' })).status, 400);
  assert.equal((await u.post('/api/me/password', { current_password: 'password-123', new_password: 'new-password-1' })).status, 200);
});

test('settings, list filtering, CSV export and static file safety', async () => {
  const a = await admin();
  const s = await a.put('/api/settings', { company_trn: '100000000000003', default_vat_rate: '5' });
  assert.equal(s.data.company_trn, '100000000000003');
  assert.equal((await a.put('/api/settings', { default_vat_rate: '500' })).status, 400);

  const { project } = await baseData(a);
  await a.post('/api/tasks', { project_id: project.id, title: 'Pour slab', status: 'In Progress' });
  await a.post('/api/tasks', { project_id: project.id, title: 'Cure slab', status: 'Done' });
  const filtered = (await a.get(`/api/tasks?project_id=${project.id}&status=Done`)).data;
  assert.equal(filtered.total, 1);
  assert.equal(filtered.rows[0].progress, 100);
  assert.equal((await a.get(`/api/tasks?project_id=${project.id}&q=pour`)).data.total, 1);

  await a.post('/api/clients', { name: '=HYPERLINK("http://evil")' });
  const csv = await a.get('/api/clients?format=csv');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.ok(csv.data.includes(`"'=HYPERLINK(""http://evil"")"`));

  const trav = await fetch(`${base}/..%2f..%2fpackage.json`);
  assert.notEqual(trav.status, 200);
  const idx = await fetch(`${base}/`);
  assert.equal(idx.status, 200);
  assert.match(idx.headers.get('content-security-policy'), /default-src 'self'/);
});

test('demo seed loads and every report runs', async () => {
  seedDemo(app.db);
  const a = await admin();
  const dash = await a.get('/api/dashboard');
  assert.equal(dash.status, 200);
  assert.ok(dash.data.finance.invoiced_ytd > 0);
  assert.equal(dash.data.finance.monthly.length, 6);
  const meta = (await a.get('/api/meta')).data;
  for (const r of meta.reports) {
    const res = await a.get(`/api/reports/${r.key}`);
    assert.equal(res.status, 200, r.key);
    assert.ok(Array.isArray(res.data.rows));
  }
  for (const key of Object.keys(meta.resources)) {
    const res = await a.get(`/api/${key}?limit=5`);
    assert.equal(res.status, 200, key);
    if (res.data.rows[0]) assert.equal((await a.get(`/api/${key}/${res.data.rows[0].id}`)).status, 200);
  }
});
