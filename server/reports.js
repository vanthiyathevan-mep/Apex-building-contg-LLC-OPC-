'use strict';
const { PROJECT_COST_SQL, INVOICE_PAID_SQL, INVOICE_STATE_SQL, resources, canRead, round2 } = require('./resources');
const { HttpError } = require('./api');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const finance = (user) => canRead(resources.invoices, user);

const projectCostCols = Object.entries(PROJECT_COST_SQL).map(([k, sql]) => `${sql} AS ${k}`).join(',\n');

function withProjectTotals(p) {
  const total_cost = round2(p.labor_cost + p.material_cost + p.purchase_cost + p.expense_cost);
  return {
    ...p,
    total_cost,
    budget_variance: round2(p.budget - total_cost),
    budget_used_pct: p.budget > 0 ? Math.round((total_cost / p.budget) * 1000) / 10 : null,
    gross_margin: round2(p.invoiced - total_cost),
    outstanding: round2((p.invoiced_gross || 0) - p.received),
  };
}

function projectCosting(db, where = '', params = []) {
  return db.prepare(`
    SELECT t.id, t.code, t.name, t.status, t.progress, t.contract_value, t.budget, t.start_date, t.end_date,
           c.name AS client_name,
           ${projectCostCols},
           (SELECT COALESCE(SUM(total),0) FROM invoices x WHERE x.project_id = t.id AND x.status = 'Issued') AS invoiced_gross
    FROM projects t LEFT JOIN clients c ON c.id = t.client_id
    ${where}
    ORDER BY t.code`).all(...params).map(withProjectTotals);
}

function dashboard(db, user) {
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const year = String(new Date().getFullYear());
  const projects = one(`SELECT
      SUM(status = 'Active') AS active, SUM(status IN ('Planning','Tendering')) AS pipeline,
      SUM(status = 'Completed') AS completed, COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status IN ('Active','Planning','On Hold') THEN contract_value END),0) AS backlog_value
    FROM projects`);
  const out = {
    projects,
    workforce: one(`SELECT COUNT(*) AS active FROM employees WHERE status = 'Active'`),
    labor_today: one(`SELECT COUNT(DISTINCT employee_id) AS workers, COALESCE(SUM(hours + overtime_hours),0) AS hours
                      FROM timesheets WHERE work_date = date('now')`),
    equipment: one(`SELECT COUNT(*) AS total, SUM(status = 'In Use') AS in_use, SUM(status = 'Under Maintenance') AS maintenance FROM equipment`),
    low_stock: db.prepare(`SELECT id, code, name, unit, stock_qty, reorder_level FROM materials
                           WHERE reorder_level > 0 AND stock_qty <= reorder_level ORDER BY name LIMIT 10`).all(),
    open_tasks: db.prepare(`SELECT t.id, t.title, t.due_date, t.status, t.priority, p.code AS project_code, p.id AS project_id
                            FROM tasks t JOIN projects p ON p.id = t.project_id
                            WHERE t.status <> 'Done' AND t.due_date IS NOT NULL AND t.due_date <= date('now', '+7 day')
                            ORDER BY t.due_date LIMIT 10`).all(),
    alerts: alerts(db),
    active_projects: projectCosting(db, `WHERE t.status = 'Active'`).map((p) => ({
      id: p.id, code: p.code, name: p.name, client_name: p.client_name, progress: p.progress,
      contract_value: p.contract_value, budget: p.budget, total_cost: p.total_cost, budget_used_pct: p.budget_used_pct, end_date: p.end_date,
    })),
    pending_pos: one(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS value FROM purchase_orders WHERE status IN ('Draft','Approved')`),
    recent_activity: db.prepare(`SELECT username, action, resource, record_id, summary, created_at FROM activity ORDER BY id DESC LIMIT 12`).all()
      .filter((a) => !resources[a.resource] || canRead(resources[a.resource], user)),
  };
  if (finance(user)) {
    out.finance = {
      invoiced_ytd: one(`SELECT COALESCE(SUM(subtotal),0) AS v FROM invoices WHERE status = 'Issued' AND substr(issue_date,1,4) = ?`, year).v,
      collected_ytd: one(`SELECT COALESCE(SUM(amount),0) AS v FROM payments WHERE substr(payment_date,1,4) = ?`, year).v,
      receivables: one(`SELECT COALESCE(SUM(t.total - ${INVOICE_PAID_SQL}),0) AS v FROM invoices t WHERE t.status = 'Issued'`).v,
      overdue: one(`SELECT COUNT(*) AS n, COALESCE(SUM(t.total - ${INVOICE_PAID_SQL}),0) AS v FROM invoices t
                    WHERE ${INVOICE_STATE_SQL} = 'Overdue'`),
      retention_held: one(`SELECT COALESCE(SUM(retention_amount),0) AS v FROM invoices WHERE status = 'Issued'`).v,
      unpaid_expenses: one(`SELECT COALESCE(SUM(amount + vat_amount),0) AS v FROM expenses WHERE payment_status = 'Unpaid'`).v,
      monthly: monthlyCashflow(db, 6),
    };
  }
  return out;
}

function monthlyCashflow(db, months) {
  const rows = [];
  const d = new Date();
  d.setUTCDate(1);
  for (let i = months - 1; i >= 0; i--) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    const ym = m.toISOString().slice(0, 7);
    const g = (sql) => db.prepare(sql).get(ym).v;
    rows.push({
      month: ym,
      invoiced: g(`SELECT COALESCE(SUM(subtotal),0) AS v FROM invoices WHERE status = 'Issued' AND substr(issue_date,1,7) = ?`),
      collected: g(`SELECT COALESCE(SUM(amount),0) AS v FROM payments WHERE substr(payment_date,1,7) = ?`),
      costs: round2(
        g(`SELECT COALESCE(SUM(cost),0) AS v FROM timesheets WHERE substr(work_date,1,7) = ?`)
        + g(`SELECT COALESCE(SUM(amount),0) AS v FROM expenses WHERE substr(expense_date,1,7) = ?`)
        + g(`SELECT COALESCE(SUM(CASE type WHEN 'OUT' THEN quantity*unit_cost WHEN 'RETURN' THEN -quantity*unit_cost ELSE 0 END),0) AS v
             FROM stock_movements WHERE project_id IS NOT NULL AND substr(movement_date,1,7) = ?`)
        + g(`SELECT COALESCE(SUM(i.amount),0) AS v FROM po_items i JOIN purchase_orders p ON p.id = i.po_id
             WHERE p.status = 'Received' AND i.material_id IS NULL AND p.project_id IS NOT NULL AND substr(p.received_at,1,7) = ?`)),
    });
  }
  return rows;
}

/** Expiring documents and due services within the next 30 days (or already past). */
function alerts(db) {
  return [
    ...db.prepare(`SELECT 'Visa expiry' AS kind, emp_no || ' — ' || full_name AS subject, visa_expiry AS date, 'employees' AS resource, id
                   FROM employees WHERE status <> 'Terminated' AND visa_expiry IS NOT NULL AND visa_expiry <= date('now', '+30 day')`).all(),
    ...db.prepare(`SELECT 'Equipment service' AS kind, code || ' — ' || name AS subject, next_service_date AS date, 'equipment' AS resource, id
                   FROM equipment WHERE status <> 'Out of Service' AND next_service_date IS NOT NULL AND next_service_date <= date('now', '+30 day')`).all(),
    ...db.prepare(`SELECT 'Registration expiry' AS kind, code || ' — ' || name AS subject, registration_expiry AS date, 'equipment' AS resource, id
                   FROM equipment WHERE status <> 'Out of Service' AND registration_expiry IS NOT NULL AND registration_expiry <= date('now', '+30 day')`).all(),
  ].sort((a, b) => a.date.localeCompare(b.date));
}

function projectSummary(db, user, id) {
  const [p] = projectCosting(db, 'WHERE t.id = ?', [Number(id)]);
  if (!p) throw new HttpError(404, 'Project not found');
  const tasks = db.prepare(`SELECT status, COUNT(*) AS n FROM tasks WHERE project_id = ? GROUP BY status`).all(p.id);
  const labor = db.prepare(`SELECT COUNT(DISTINCT employee_id) AS workers, COALESCE(SUM(hours),0) AS hours, COALESCE(SUM(overtime_hours),0) AS overtime
                            FROM timesheets WHERE project_id = ?`).get(p.id);
  const expenseByCategory = db.prepare(`SELECT category, ROUND(SUM(amount),2) AS amount FROM expenses WHERE project_id = ? GROUP BY category ORDER BY amount DESC`).all(p.id);
  const summary = { ...p, tasks, labor, expense_by_category: expenseByCategory };
  if (!finance(user)) {
    for (const k of ['invoiced', 'invoiced_gross', 'received', 'outstanding', 'gross_margin']) delete summary[k];
  }
  return summary;
}

function range(query) {
  const from = DATE_RE.test(query.from || '') ? query.from : '0000-01-01';
  const to = DATE_RE.test(query.to || '') ? query.to : '9999-12-31';
  return { from, to };
}

const REPORTS = {
  'project-costing': {
    title: 'Project Job Costing', finance: true,
    run: (db) => projectCosting(db),
  },
  'receivables-aging': {
    title: 'Receivables Aging', finance: true,
    run: (db) => db.prepare(`
      SELECT t.id, t.invoice_no, t.issue_date, t.due_date, p.code AS project_code, c.name AS client_name, t.total,
             ${INVOICE_PAID_SQL} AS paid, ROUND(t.total - ${INVOICE_PAID_SQL}, 2) AS balance,
             CAST(julianday('now') - julianday(COALESCE(t.due_date, t.issue_date)) AS INTEGER) AS days_overdue
      FROM invoices t JOIN projects p ON p.id = t.project_id LEFT JOIN clients c ON c.id = p.client_id
      WHERE t.status = 'Issued' AND t.total - ${INVOICE_PAID_SQL} > 0.005
      ORDER BY days_overdue DESC`).all().map((r) => ({
        ...r,
        bucket: r.days_overdue <= 0 ? 'Current' : r.days_overdue <= 30 ? '1–30 days' : r.days_overdue <= 60 ? '31–60 days' : r.days_overdue <= 90 ? '61–90 days' : '90+ days',
      })),
  },
  'labor-summary': {
    title: 'Labor Hours & Cost', finance: false,
    run: (db, q) => {
      const { from, to } = range(q);
      return db.prepare(`
        SELECT e.emp_no, e.full_name, e.trade, p.code AS project_code, COUNT(*) AS days,
               SUM(t.hours) AS hours, SUM(t.overtime_hours) AS overtime_hours, ROUND(SUM(t.cost),2) AS cost
        FROM timesheets t JOIN employees e ON e.id = t.employee_id JOIN projects p ON p.id = t.project_id
        WHERE t.work_date BETWEEN ? AND ?
        GROUP BY e.id, p.id ORDER BY e.emp_no, p.code`).all(from, to);
    },
  },
  'expenses-by-category': {
    title: 'Expenses by Category', finance: true,
    run: (db, q) => {
      const { from, to } = range(q);
      return db.prepare(`
        SELECT e.category, COALESCE(p.code, 'Overheads') AS project_code, COUNT(*) AS entries,
               ROUND(SUM(e.amount),2) AS amount, ROUND(SUM(e.vat_amount),2) AS vat
        FROM expenses e LEFT JOIN projects p ON p.id = e.project_id
        WHERE e.expense_date BETWEEN ? AND ?
        GROUP BY e.category, p.id ORDER BY amount DESC`).all(from, to);
    },
  },
  'inventory-valuation': {
    title: 'Inventory Valuation', finance: false,
    run: (db) => db.prepare(`
      SELECT code, name, category, unit, stock_qty, unit_cost, ROUND(stock_qty * unit_cost, 2) AS stock_value, reorder_level,
             CASE WHEN reorder_level > 0 AND stock_qty <= reorder_level THEN 'Reorder' ELSE 'OK' END AS stock_status
      FROM materials ORDER BY category, code`).all(),
  },
  'material-consumption': {
    title: 'Material Consumption by Project', finance: false,
    run: (db, q) => {
      const { from, to } = range(q);
      return db.prepare(`
        SELECT p.code AS project_code, m.code AS material_code, m.name AS material, m.unit,
               ROUND(SUM(CASE s.type WHEN 'OUT' THEN s.quantity ELSE -s.quantity END), 2) AS net_quantity,
               ROUND(SUM(CASE s.type WHEN 'OUT' THEN s.quantity * s.unit_cost ELSE -s.quantity * s.unit_cost END), 2) AS cost
        FROM stock_movements s JOIN materials m ON m.id = s.material_id JOIN projects p ON p.id = s.project_id
        WHERE s.type IN ('OUT','RETURN') AND s.movement_date BETWEEN ? AND ?
        GROUP BY p.id, m.id ORDER BY p.code, cost DESC`).all(from, to);
    },
  },
  'vat-summary': {
    title: 'VAT Summary (Output vs Input)', finance: true,
    run: (db, q) => {
      const { from, to } = range(q);
      const output = db.prepare(`SELECT substr(issue_date,1,7) AS month, ROUND(SUM(subtotal),2) AS taxable, ROUND(SUM(vat_amount),2) AS vat
                                 FROM invoices WHERE status = 'Issued' AND issue_date BETWEEN ? AND ? GROUP BY month`).all(from, to);
      const inputExp = db.prepare(`SELECT substr(expense_date,1,7) AS month, ROUND(SUM(vat_amount),2) AS vat
                                   FROM expenses WHERE expense_date BETWEEN ? AND ? GROUP BY month`).all(from, to);
      const inputPo = db.prepare(`SELECT substr(received_at,1,7) AS month, ROUND(SUM(vat_amount),2) AS vat
                                  FROM purchase_orders WHERE status = 'Received' AND received_at BETWEEN ? AND ? GROUP BY month`).all(from, to);
      const months = new Map();
      const row = (m) => { if (!months.has(m)) months.set(m, { month: m, taxable_sales: 0, output_vat: 0, input_vat: 0 }); return months.get(m); };
      for (const o of output) { const r = row(o.month); r.taxable_sales = o.taxable; r.output_vat = o.vat; }
      for (const i of [...inputExp, ...inputPo]) row(i.month).input_vat = round2(row(i.month).input_vat + i.vat);
      return [...months.values()].sort((a, b) => a.month.localeCompare(b.month))
        .map((r) => ({ ...r, net_vat_payable: round2(r.output_vat - r.input_vat) }));
    },
  },
  'expiring-documents': {
    title: 'Expiring Documents & Services', finance: false,
    run: (db) => alerts(db),
  },
};

function listReports(user) {
  return Object.entries(REPORTS).filter(([, r]) => !r.finance || finance(user)).map(([key, r]) => ({ key, title: r.title }));
}

function runReport(db, user, key, query) {
  const r = REPORTS[key];
  if (!r) throw new HttpError(404, 'Unknown report');
  if (r.finance && !finance(user)) throw new HttpError(403, 'You do not have access to financial reports');
  return { key, title: r.title, rows: r.run(db, query) };
}

module.exports = { dashboard, projectSummary, listReports, runReport, alerts };
