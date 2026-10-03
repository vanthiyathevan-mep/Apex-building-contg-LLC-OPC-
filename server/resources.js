'use strict';
/**
 * Resource definitions drive the generic CRUD API (server/api.js) and the
 * generic list/form UI (public/js). Each resource maps to one table.
 *
 * Field types: text, textarea, email, number, money, int, percent, date,
 * select, ref, bool, password (write-only, virtual).
 */
const { hashPassword } = require('./auth');

class ValidationError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const MANAGE = ['admin', 'manager'];
const FINANCE = ['admin', 'manager', 'accountant'];
const SITE = ['admin', 'manager', 'site_engineer'];
const FINANCE_READ = ['admin', 'manager', 'accountant', 'viewer'];

// Shared cost SQL for a project row aliased `t` (used by projects + reports).
const PROJECT_COST_SQL = {
  labor_cost: `(SELECT COALESCE(SUM(cost),0) FROM timesheets x WHERE x.project_id = t.id)`,
  material_cost: `(SELECT COALESCE(SUM(CASE x.type WHEN 'OUT' THEN x.quantity * x.unit_cost WHEN 'RETURN' THEN -x.quantity * x.unit_cost ELSE 0 END),0)
                   FROM stock_movements x WHERE x.project_id = t.id)`,
  purchase_cost: `(SELECT COALESCE(SUM(i.amount),0) FROM po_items i JOIN purchase_orders p ON p.id = i.po_id
                   WHERE p.project_id = t.id AND p.status = 'Received' AND i.material_id IS NULL)`,
  expense_cost: `(SELECT COALESCE(SUM(amount),0) FROM expenses x WHERE x.project_id = t.id)`,
  committed_cost: `(SELECT COALESCE(SUM(subtotal),0) FROM purchase_orders x WHERE x.project_id = t.id AND x.status = 'Approved')`,
  invoiced: `(SELECT COALESCE(SUM(subtotal),0) FROM invoices x WHERE x.project_id = t.id AND x.status = 'Issued')`,
  received: `(SELECT COALESCE(SUM(pm.amount),0) FROM payments pm JOIN invoices x ON x.id = pm.invoice_id WHERE x.project_id = t.id)`,
};
const PROJECT_TOTAL_COST_SQL =
  `(${PROJECT_COST_SQL.labor_cost} + ${PROJECT_COST_SQL.material_cost} + ${PROJECT_COST_SQL.purchase_cost} + ${PROJECT_COST_SQL.expense_cost})`;

const INVOICE_PAID_SQL = `(SELECT COALESCE(SUM(amount),0) FROM payments pm WHERE pm.invoice_id = t.id)`;
const INVOICE_STATE_SQL = `(CASE
  WHEN t.status <> 'Issued' THEN t.status
  WHEN ${INVOICE_PAID_SQL} >= t.total - 0.005 THEN 'Paid'
  WHEN t.due_date IS NOT NULL AND t.due_date < date('now') THEN 'Overdue'
  WHEN ${INVOICE_PAID_SQL} > 0 THEN 'Partially Paid'
  ELSE 'Unpaid' END)`;

/** Next sequential document number, e.g. PO-2026-0007. */
function nextNumber(db, table, column, prefix, pad = 4) {
  const rows = db.prepare(`SELECT ${column} AS v FROM ${table} WHERE ${column} LIKE ?`).all(prefix + '%');
  let max = 0;
  for (const { v } of rows) {
    const n = parseInt(String(v).slice(prefix.length), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return prefix + String(max + 1).padStart(pad, '0');
}
const yearOf = (date) => (date && /^\d{4}/.test(date) ? date.slice(0, 4) : String(new Date().getFullYear()));

function autoNumber(column, table, prefixFn, pad) {
  return (db, data) => {
    if (!data[column]) data[column] = nextNumber(db, table, column, prefixFn(data), pad);
  };
}

function applyStock(db, materialId, delta) {
  const m = db.prepare('SELECT id, name, stock_qty FROM materials WHERE id = ?').get(materialId);
  if (!m) throw new ValidationError('Material not found');
  const next = round2(m.stock_qty + delta);
  if (next < 0) throw new ValidationError(`Insufficient stock for ${m.name}: available ${m.stock_qty}`);
  db.prepare('UPDATE materials SET stock_qty = ? WHERE id = ?').run(next, materialId);
}

/** Receiving stock updates the material's moving-average unit cost. */
function receiveStock(db, materialId, qty, unitCost) {
  const m = db.prepare('SELECT stock_qty, unit_cost FROM materials WHERE id = ?').get(materialId);
  if (!m) throw new ValidationError('Material not found');
  const newQty = m.stock_qty + qty;
  const avg = newQty > 0 ? (Math.max(m.stock_qty, 0) * m.unit_cost + qty * unitCost) / (Math.max(m.stock_qty, 0) + qty) : unitCost;
  db.prepare('UPDATE materials SET stock_qty = ?, unit_cost = ? WHERE id = ?').run(round2(newQty), round2(avg), materialId);
}

const stockDelta = (type, qty) => (type === 'IN' || type === 'RETURN' ? qty : type === 'OUT' ? -qty : qty);

const resources = {
  projects: {
    label: 'Projects', singular: 'Project', table: 'projects', group: 'Operations', icon: '🏗️',
    write: MANAGE,
    display: (a) => `${a}.code || ' — ' || ${a}.name`,
    search: ['code', 'name', 'location'],
    defaultSort: 'id DESC',
    fields: [
      { name: 'code', label: 'Project Code', type: 'text', list: true, placeholder: 'Auto-generated' },
      { name: 'name', label: 'Project Name', type: 'text', required: true, list: true },
      { name: 'client_id', label: 'Client', type: 'ref', ref: 'clients', list: true },
      { name: 'manager_id', label: 'Project Manager', type: 'ref', ref: 'employees' },
      { name: 'location', label: 'Location', type: 'text', list: true },
      { name: 'plot_no', label: 'Plot No.', type: 'text' },
      { name: 'start_date', label: 'Start Date', type: 'date' },
      { name: 'end_date', label: 'Completion Date', type: 'date', list: true },
      { name: 'contract_value', label: 'Contract Value', type: 'money', list: true, min: 0 },
      { name: 'budget', label: 'Cost Budget', type: 'money', min: 0 },
      { name: 'status', label: 'Status', type: 'select', options: ['Tendering', 'Planning', 'Active', 'On Hold', 'Completed', 'Cancelled'], default: 'Planning', list: true, filter: true },
      { name: 'progress', label: 'Progress %', type: 'percent', min: 0, max: 100, default: 0, list: true },
      { name: 'description', label: 'Scope / Description', type: 'textarea' },
    ],
    computed: {
      total_cost: { label: 'Actual Cost', type: 'money', sql: PROJECT_TOTAL_COST_SQL, list: true },
    },
    detailView: 'project',
    hooks: {
      beforeSave: [autoNumber('code', 'projects', (d) => `PRJ-${yearOf(d.start_date)}-`, 3)],
    },
  },

  clients: {
    label: 'Clients', singular: 'Client', table: 'clients', group: 'Operations', icon: '🤝',
    write: FINANCE,
    display: (a) => `${a}.name`,
    search: ['name', 'contact_person', 'phone', 'email', 'trn'],
    defaultSort: 'name ASC',
    fields: [
      { name: 'name', label: 'Client Name', type: 'text', required: true, list: true },
      { name: 'contact_person', label: 'Contact Person', type: 'text', list: true },
      { name: 'phone', label: 'Phone', type: 'text', list: true },
      { name: 'email', label: 'Email', type: 'email', list: true },
      { name: 'trn', label: 'TRN (Tax Reg. No.)', type: 'text', list: true },
      { name: 'address', label: 'Address', type: 'textarea' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
    computed: {
      project_count: { label: 'Projects', type: 'int', sql: `(SELECT COUNT(*) FROM projects p WHERE p.client_id = t.id)`, list: true },
    },
  },

  tasks: {
    label: 'Tasks & Milestones', singular: 'Task', table: 'tasks', group: 'Operations', icon: '✅',
    write: SITE,
    display: (a) => `${a}.title`,
    search: ['title', 'notes'],
    defaultSort: 'due_date IS NULL, due_date ASC',
    fields: [
      { name: 'project_id', label: 'Project', type: 'ref', ref: 'projects', required: true, list: true, filter: true },
      { name: 'title', label: 'Task / Milestone', type: 'text', required: true, list: true },
      { name: 'assignee_id', label: 'Assigned To', type: 'ref', ref: 'employees', list: true },
      { name: 'start_date', label: 'Start Date', type: 'date' },
      { name: 'due_date', label: 'Due Date', type: 'date', list: true },
      { name: 'status', label: 'Status', type: 'select', options: ['Not Started', 'In Progress', 'Blocked', 'Done'], default: 'Not Started', list: true, filter: true },
      { name: 'priority', label: 'Priority', type: 'select', options: ['Low', 'Medium', 'High', 'Critical'], default: 'Medium', list: true },
      { name: 'progress', label: 'Progress %', type: 'percent', min: 0, max: 100, default: 0, list: true },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
    hooks: {
      beforeSave: [(db, d) => {
        if (d.status === 'Done') d.progress = 100;
        if (d.start_date && d.due_date && d.due_date < d.start_date) throw new ValidationError('Due date cannot be before start date');
      }],
    },
  },

  site_logs: {
    label: 'Daily Site Reports', singular: 'Site Report', table: 'site_logs', group: 'Operations', icon: '📋',
    write: SITE,
    display: (a) => `'Site report ' || ${a}.log_date`,
    search: ['work_done', 'issues', 'weather'],
    defaultSort: 'log_date DESC, id DESC',
    fields: [
      { name: 'project_id', label: 'Project', type: 'ref', ref: 'projects', required: true, list: true, filter: true },
      { name: 'log_date', label: 'Date', type: 'date', required: true, list: true, default: 'today' },
      { name: 'weather', label: 'Weather', type: 'select', options: ['Clear', 'Hot', 'Humid', 'Windy / Dusty', 'Rain', 'Sandstorm'], list: true },
      { name: 'manpower_count', label: 'Manpower on Site', type: 'int', min: 0, default: 0, list: true },
      { name: 'safety_incidents', label: 'Safety Incidents', type: 'int', min: 0, default: 0, list: true },
      { name: 'work_done', label: 'Work Done', type: 'textarea', required: true, list: true },
      { name: 'issues', label: 'Issues / Delays', type: 'textarea' },
    ],
  },

  employees: {
    label: 'Employees', singular: 'Employee', table: 'employees', group: 'Workforce', icon: '👷',
    write: MANAGE,
    display: (a) => `${a}.emp_no || ' — ' || ${a}.full_name`,
    search: ['emp_no', 'full_name', 'designation', 'trade', 'phone'],
    defaultSort: 'emp_no ASC',
    fields: [
      { name: 'emp_no', label: 'Employee No.', type: 'text', list: true, placeholder: 'Auto-generated' },
      { name: 'full_name', label: 'Full Name', type: 'text', required: true, list: true },
      { name: 'designation', label: 'Designation', type: 'text', list: true },
      { name: 'trade', label: 'Trade', type: 'select', options: ['Management', 'Engineer', 'Foreman', 'Mason', 'Carpenter', 'Steel Fixer', 'Electrician', 'Plumber', 'Painter', 'Welder', 'Operator', 'Driver', 'Helper', 'Admin', 'Other'], list: true, filter: true },
      { name: 'phone', label: 'Phone', type: 'text', list: true },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'daily_rate', label: 'Daily Rate', type: 'money', min: 0, default: 0, list: true },
      { name: 'joining_date', label: 'Joining Date', type: 'date' },
      { name: 'passport_no', label: 'Passport No.', type: 'text' },
      { name: 'visa_expiry', label: 'Visa Expiry', type: 'date', list: true },
      { name: 'status', label: 'Status', type: 'select', options: ['Active', 'On Leave', 'Terminated'], default: 'Active', list: true, filter: true },
    ],
    hooks: { beforeSave: [autoNumber('emp_no', 'employees', () => 'EMP-', 4)] },
  },

  timesheets: {
    label: 'Timesheets', singular: 'Timesheet Entry', table: 'timesheets', group: 'Workforce', icon: '⏱️',
    write: SITE,
    display: (a) => `(SELECT e.full_name FROM employees e WHERE e.id = ${a}.employee_id) || ' · ' || ${a}.work_date`,
    search: ['notes'],
    defaultSort: 'work_date DESC, id DESC',
    fields: [
      { name: 'work_date', label: 'Date', type: 'date', required: true, list: true, default: 'today' },
      { name: 'employee_id', label: 'Employee', type: 'ref', ref: 'employees', required: true, list: true, filter: true },
      { name: 'project_id', label: 'Project', type: 'ref', ref: 'projects', required: true, list: true, filter: true },
      { name: 'hours', label: 'Regular Hours', type: 'number', min: 0, max: 24, default: 8, list: true },
      { name: 'overtime_hours', label: 'Overtime Hours', type: 'number', min: 0, max: 16, default: 0, list: true },
      { name: 'cost', label: 'Labor Cost', type: 'money', readonly: true, list: true },
      { name: 'notes', label: 'Notes', type: 'text' },
    ],
    hooks: {
      beforeSave: [(db, d) => {
        if (d.hours + d.overtime_hours > 24) throw new ValidationError('Total hours cannot exceed 24 in a day');
        const emp = db.prepare('SELECT daily_rate, status FROM employees WHERE id = ?').get(d.employee_id);
        if (!emp) throw new ValidationError('Employee not found');
        const hourly = emp.daily_rate / 8;
        // UAE Labour Law: overtime paid at a 25% premium.
        d.cost = round2(hourly * d.hours + hourly * 1.25 * d.overtime_hours);
      }],
    },
  },

  suppliers: {
    label: 'Suppliers & Subcontractors', singular: 'Supplier', table: 'suppliers', group: 'Procurement', icon: '🚚',
    write: FINANCE,
    display: (a) => `${a}.name`,
    search: ['name', 'category', 'contact_person', 'phone', 'trn'],
    defaultSort: 'name ASC',
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true, list: true },
      { name: 'type', label: 'Type', type: 'select', options: ['Supplier', 'Subcontractor', 'Consultant', 'Equipment Rental'], default: 'Supplier', list: true, filter: true },
      { name: 'category', label: 'Category / Trade', type: 'text', list: true },
      { name: 'contact_person', label: 'Contact Person', type: 'text', list: true },
      { name: 'phone', label: 'Phone', type: 'text', list: true },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'trn', label: 'TRN', type: 'text' },
      { name: 'address', label: 'Address', type: 'textarea' },
    ],
  },

  purchase_orders: {
    label: 'Purchase Orders', singular: 'Purchase Order', table: 'purchase_orders', group: 'Procurement', icon: '🧾',
    write: FINANCE,
    display: (a) => `${a}.po_no`,
    search: ['po_no', 'notes'],
    defaultSort: 'id DESC',
    printable: true,
    fields: [
      { name: 'po_no', label: 'PO No.', type: 'text', list: true, placeholder: 'Auto-generated' },
      { name: 'supplier_id', label: 'Supplier', type: 'ref', ref: 'suppliers', required: true, list: true, filter: true },
      { name: 'project_id', label: 'Project', type: 'ref', ref: 'projects', list: true, filter: true },
      { name: 'order_date', label: 'Order Date', type: 'date', required: true, list: true, default: 'today' },
      { name: 'delivery_date', label: 'Required Delivery', type: 'date' },
      { name: 'status', label: 'Status', type: 'select', options: ['Draft', 'Approved', 'Received', 'Cancelled'], default: 'Draft', list: true, filter: true },
      { name: 'vat_rate', label: 'VAT %', type: 'percent', min: 0, max: 100, default: 'setting:default_vat_rate' },
      { name: 'subtotal', label: 'Subtotal', type: 'money', readonly: true },
      { name: 'vat_amount', label: 'VAT', type: 'money', readonly: true },
      { name: 'total', label: 'Total', type: 'money', readonly: true, list: true },
      { name: 'received_at', label: 'Received On', type: 'date', readonly: true },
      { name: 'notes', label: 'Notes / Terms', type: 'textarea' },
    ],
    children: {
      key: 'items', table: 'po_items', fk: 'po_id', label: 'Line Items',
      fields: [
        { name: 'material_id', label: 'Stock Material', type: 'ref', ref: 'materials', hint: 'Leave blank for direct-to-site purchases/services' },
        { name: 'description', label: 'Description', type: 'text', required: true },
        { name: 'quantity', label: 'Qty', type: 'number', min: 0, default: 1 },
        { name: 'unit', label: 'Unit', type: 'text' },
        { name: 'unit_price', label: 'Unit Price', type: 'money', min: 0, default: 0 },
        { name: 'amount', label: 'Amount', type: 'money', readonly: true },
      ],
    },
    actions: [{ name: 'receive', label: 'Mark as Received', confirm: 'Receive all items? Stock items will be added to inventory.', when: { status: 'Approved' } }],
    hooks: {
      beforeSave: [
        (db, d, ctx) => {
          if (ctx.existing && ['Received', 'Cancelled'].includes(ctx.existing.status)) {
            throw new ValidationError(`A ${ctx.existing.status.toLowerCase()} purchase order cannot be edited`);
          }
          if (d.status === 'Received') throw new ValidationError('Use "Mark as Received" to receive a purchase order');
          if (!ctx.children || ctx.children.length === 0) throw new ValidationError('Add at least one line item');
          let subtotal = 0;
          for (const it of ctx.children) { it.amount = round2(it.quantity * it.unit_price); subtotal += it.amount; }
          d.subtotal = round2(subtotal);
          d.vat_amount = round2(subtotal * d.vat_rate / 100);
          d.total = round2(d.subtotal + d.vat_amount);
          d.received_at = ctx.existing ? ctx.existing.received_at : null;
        },
        autoNumber('po_no', 'purchase_orders', (d) => `PO-${yearOf(d.order_date)}-`, 4),
      ],
      beforeDelete: [(db, row) => {
        if (row.status === 'Received') throw new ValidationError('A received purchase order cannot be deleted');
      }],
    },
    actionHandlers: {
      receive(db, row) {
        if (row.status !== 'Approved') throw new ValidationError('Only approved purchase orders can be received');
        const today = new Date().toISOString().slice(0, 10);
        const items = db.prepare('SELECT * FROM po_items WHERE po_id = ?').all(row.id);
        const ins = db.prepare(`INSERT INTO stock_movements (material_id, project_id, movement_date, type, quantity, unit_cost, reference, notes)
                                VALUES (?, NULL, ?, 'IN', ?, ?, ?, ?)`);
        for (const it of items) {
          if (!it.material_id) continue;
          receiveStock(db, it.material_id, it.quantity, it.unit_price);
          ins.run(it.material_id, today, it.quantity, it.unit_price, row.po_no, 'Received against purchase order');
        }
        db.prepare(`UPDATE purchase_orders SET status = 'Received', received_at = ? WHERE id = ?`).run(today, row.id);
        return `Received ${row.po_no}`;
      },
    },
  },

  materials: {
    label: 'Materials & Inventory', singular: 'Material', table: 'materials', group: 'Procurement', icon: '🧱',
    write: SITE,
    display: (a) => `${a}.code || ' — ' || ${a}.name || ' (' || ${a}.unit || ')'`,
    search: ['code', 'name', 'category'],
    defaultSort: 'code ASC',
    fields: [
      { name: 'code', label: 'Item Code', type: 'text', list: true, placeholder: 'Auto-generated' },
      { name: 'name', label: 'Material', type: 'text', required: true, list: true },
      { name: 'category', label: 'Category', type: 'select', options: ['Cement & Concrete', 'Steel & Rebar', 'Blocks & Bricks', 'Aggregates', 'Timber & Formwork', 'Electrical', 'Plumbing', 'Finishes', 'Waterproofing', 'Consumables', 'Other'], list: true, filter: true },
      { name: 'unit', label: 'Unit', type: 'text', required: true, default: 'Nos', list: true },
      { name: 'unit_cost', label: 'Avg. Unit Cost', type: 'money', min: 0, default: 0, list: true },
      { name: 'stock_qty', label: 'In Stock', type: 'number', readonly: true, list: true },
      { name: 'reorder_level', label: 'Reorder Level', type: 'number', min: 0, default: 0, list: true },
    ],
    computed: {
      stock_value: { label: 'Stock Value', type: 'money', sql: `ROUND(t.stock_qty * t.unit_cost, 2)`, list: true },
      low_stock: { label: 'Low Stock', type: 'bool', sql: `(t.stock_qty <= t.reorder_level AND t.reorder_level > 0)` },
    },
    hooks: {
      beforeSave: [
        autoNumber('code', 'materials', () => 'MAT-', 4),
        (db, d, ctx) => { d.stock_qty = ctx.existing ? ctx.existing.stock_qty : 0; },
      ],
    },
  },

  stock_movements: {
    label: 'Stock Movements', singular: 'Stock Movement', table: 'stock_movements', group: 'Procurement', icon: '🔁',
    write: SITE,
    ops: ['create', 'delete'],
    display: (a) => `${a}.type || ' · ' || (SELECT m.name FROM materials m WHERE m.id = ${a}.material_id) || ' × ' || ${a}.quantity`,
    search: ['reference', 'notes'],
    defaultSort: 'movement_date DESC, id DESC',
    fields: [
      { name: 'movement_date', label: 'Date', type: 'date', required: true, list: true, default: 'today' },
      { name: 'type', label: 'Type', type: 'select', options: ['IN', 'OUT', 'RETURN', 'ADJUST'], required: true, list: true, filter: true,
        hint: 'IN = received to store · OUT = issued to project · RETURN = returned from project · ADJUST = stock count correction (+/-)' },
      { name: 'material_id', label: 'Material', type: 'ref', ref: 'materials', required: true, list: true, filter: true },
      { name: 'project_id', label: 'Project', type: 'ref', ref: 'projects', list: true, filter: true },
      { name: 'quantity', label: 'Quantity', type: 'number', required: true, list: true },
      { name: 'unit_cost', label: 'Unit Cost', type: 'money', min: 0, list: true, hint: 'Blank = current average cost' },
      { name: 'reference', label: 'Reference (DN / MRN)', type: 'text', list: true },
      { name: 'notes', label: 'Notes', type: 'text' },
    ],
    computed: {
      value: { label: 'Value', type: 'money', sql: `ROUND(t.quantity * t.unit_cost, 2)`, list: true },
    },
    hooks: {
      beforeSave: [(db, d) => {
        const m = db.prepare('SELECT unit_cost FROM materials WHERE id = ?').get(d.material_id);
        if (!m) throw new ValidationError('Material not found');
        if (d.type !== 'ADJUST' && !(d.quantity > 0)) throw new ValidationError('Quantity must be greater than zero');
        if (d.type === 'ADJUST' && d.quantity === 0) throw new ValidationError('Adjustment quantity cannot be zero');
        if ((d.type === 'OUT' || d.type === 'RETURN') && !d.project_id) throw new ValidationError(`A project is required for ${d.type} movements`);
        if (d.unit_cost == null) d.unit_cost = m.unit_cost;
      }],
      afterSave: [(db, id, d) => {
        if (d.type === 'IN') receiveStock(db, d.material_id, d.quantity, d.unit_cost);
        else applyStock(db, d.material_id, stockDelta(d.type, d.quantity));
      }],
      beforeDelete: [(db, row) => applyStock(db, row.material_id, -stockDelta(row.type, row.quantity))],
    },
  },

  equipment: {
    label: 'Plant & Equipment', singular: 'Equipment', table: 'equipment', group: 'Procurement', icon: '🚜',
    write: SITE,
    display: (a) => `${a}.code || ' — ' || ${a}.name`,
    search: ['code', 'name', 'category', 'notes'],
    defaultSort: 'code ASC',
    fields: [
      { name: 'code', label: 'Asset Code', type: 'text', list: true, placeholder: 'Auto-generated' },
      { name: 'name', label: 'Equipment', type: 'text', required: true, list: true },
      { name: 'category', label: 'Category', type: 'select', options: ['Excavator', 'Loader', 'Crane', 'Truck', 'Pickup / Car', 'Generator', 'Compressor', 'Concrete Mixer', 'Scaffolding', 'Power Tools', 'Other'], list: true, filter: true },
      { name: 'ownership', label: 'Ownership', type: 'select', options: ['Owned', 'Hired', 'Leased'], default: 'Owned', list: true },
      { name: 'status', label: 'Status', type: 'select', options: ['Available', 'In Use', 'Under Maintenance', 'Out of Service'], default: 'Available', list: true, filter: true },
      { name: 'project_id', label: 'Deployed At', type: 'ref', ref: 'projects', list: true, filter: true },
      { name: 'daily_cost', label: 'Daily Cost / Hire Rate', type: 'money', min: 0, default: 0 },
      { name: 'purchase_date', label: 'Purchase Date', type: 'date' },
      { name: 'purchase_cost', label: 'Purchase Cost', type: 'money', min: 0, default: 0 },
      { name: 'next_service_date', label: 'Next Service', type: 'date', list: true },
      { name: 'registration_expiry', label: 'Registration Expiry', type: 'date' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
    hooks: {
      beforeSave: [
        autoNumber('code', 'equipment', () => 'EQ-', 4),
        (db, d) => { if (d.status === 'In Use' && !d.project_id) throw new ValidationError('Select the project where the equipment is in use'); },
      ],
    },
  },

  invoices: {
    label: 'Invoices / Progress Claims', singular: 'Invoice', table: 'invoices', group: 'Finance', icon: '💰',
    write: FINANCE, read: FINANCE_READ,
    display: (a) => `${a}.invoice_no`,
    search: ['invoice_no', 'notes'],
    defaultSort: 'id DESC',
    printable: true,
    fields: [
      { name: 'invoice_no', label: 'Invoice No.', type: 'text', list: true, placeholder: 'Auto-generated' },
      { name: 'project_id', label: 'Project', type: 'ref', ref: 'projects', required: true, list: true, filter: true },
      { name: 'issue_date', label: 'Invoice Date', type: 'date', required: true, list: true, default: 'today' },
      { name: 'due_date', label: 'Due Date', type: 'date', list: true },
      { name: 'status', label: 'Status', type: 'select', options: ['Draft', 'Issued', 'Cancelled'], default: 'Draft', filter: true },
      { name: 'vat_rate', label: 'VAT %', type: 'percent', min: 0, max: 100, default: 'setting:default_vat_rate' },
      { name: 'retention_pct', label: 'Retention %', type: 'percent', min: 0, max: 100, default: 'setting:default_retention_pct' },
      { name: 'subtotal', label: 'Gross Amount', type: 'money', readonly: true },
      { name: 'vat_amount', label: 'VAT', type: 'money', readonly: true },
      { name: 'retention_amount', label: 'Retention Held', type: 'money', readonly: true },
      { name: 'total', label: 'Net Payable', type: 'money', readonly: true, list: true },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
    computed: {
      client_name: { label: 'Client', type: 'text', sql: `(SELECT c.name FROM projects p JOIN clients c ON c.id = p.client_id WHERE p.id = t.project_id)`, list: true },
      paid: { label: 'Paid', type: 'money', sql: INVOICE_PAID_SQL, list: true },
      balance: { label: 'Balance', type: 'money', sql: `ROUND(t.total - ${INVOICE_PAID_SQL}, 2)`, list: true },
      payment_state: { label: 'Status', type: 'status', sql: INVOICE_STATE_SQL, list: true },
    },
    children: {
      key: 'items', table: 'invoice_items', fk: 'invoice_id', label: 'Bill Items',
      fields: [
        { name: 'description', label: 'Description of Work', type: 'text', required: true },
        { name: 'quantity', label: 'Qty', type: 'number', min: 0, default: 1 },
        { name: 'unit', label: 'Unit', type: 'text' },
        { name: 'rate', label: 'Rate', type: 'money', min: 0, default: 0 },
        { name: 'amount', label: 'Amount', type: 'money', readonly: true },
      ],
    },
    hooks: {
      beforeSave: [
        (db, d, ctx) => {
          if (!ctx.children || ctx.children.length === 0) throw new ValidationError('Add at least one bill item');
          if (d.due_date && d.due_date < d.issue_date) throw new ValidationError('Due date cannot be before invoice date');
          if (ctx.existing && d.status !== 'Issued') {
            const { n } = db.prepare('SELECT COUNT(*) AS n FROM payments WHERE invoice_id = ?').get(ctx.existing.id);
            if (n > 0) throw new ValidationError('This invoice has payments recorded and must stay Issued');
          }
          let subtotal = 0;
          for (const it of ctx.children) { it.amount = round2(it.quantity * it.rate); subtotal += it.amount; }
          d.subtotal = round2(subtotal);
          d.vat_amount = round2(subtotal * d.vat_rate / 100);
          d.retention_amount = round2(subtotal * d.retention_pct / 100);
          d.total = round2(d.subtotal + d.vat_amount - d.retention_amount);
          if (ctx.existing) {
            const { paid } = db.prepare('SELECT COALESCE(SUM(amount),0) AS paid FROM payments WHERE invoice_id = ?').get(ctx.existing.id);
            if (paid > d.total + 0.005) throw new ValidationError(`Net payable cannot be less than the ${paid} already received`);
          }
        },
        autoNumber('invoice_no', 'invoices', (d) => `INV-${yearOf(d.issue_date)}-`, 4),
      ],
    },
  },

  payments: {
    label: 'Payments Received', singular: 'Payment', table: 'payments', group: 'Finance', icon: '🏦',
    write: FINANCE, read: FINANCE_READ,
    display: (a) => `'Payment ' || ${a}.payment_date || ' · ' || printf('%.2f', ${a}.amount)`,
    search: ['reference', 'notes'],
    defaultSort: 'payment_date DESC, id DESC',
    fields: [
      { name: 'invoice_id', label: 'Invoice', type: 'ref', ref: 'invoices', required: true, list: true, filter: true },
      { name: 'payment_date', label: 'Date Received', type: 'date', required: true, list: true, default: 'today' },
      { name: 'amount', label: 'Amount', type: 'money', required: true, min: 0.01, list: true },
      { name: 'method', label: 'Method', type: 'select', options: ['Bank Transfer', 'Cheque', 'PDC', 'Cash', 'Card'], default: 'Bank Transfer', list: true },
      { name: 'reference', label: 'Reference / Cheque No.', type: 'text', list: true },
      { name: 'notes', label: 'Notes', type: 'text' },
    ],
    hooks: {
      beforeSave: [(db, d, ctx) => {
        const inv = db.prepare('SELECT id, invoice_no, status, total FROM invoices WHERE id = ?').get(d.invoice_id);
        if (!inv) throw new ValidationError('Invoice not found');
        if (inv.status !== 'Issued') throw new ValidationError(`Payments can only be recorded against Issued invoices (${inv.invoice_no} is ${inv.status})`);
        const { paid } = db.prepare('SELECT COALESCE(SUM(amount),0) AS paid FROM payments WHERE invoice_id = ? AND id <> ?')
          .get(d.invoice_id, ctx.existing ? ctx.existing.id : 0);
        const balance = round2(inv.total - paid);
        if (d.amount > balance + 0.005) throw new ValidationError(`Amount exceeds the outstanding balance of ${balance.toFixed(2)} on ${inv.invoice_no}`);
      }],
    },
  },

  expenses: {
    label: 'Expenses', singular: 'Expense', table: 'expenses', group: 'Finance', icon: '💸',
    write: FINANCE, read: FINANCE_READ,
    display: (a) => `${a}.description`,
    search: ['description', 'reference'],
    defaultSort: 'expense_date DESC, id DESC',
    fields: [
      { name: 'expense_date', label: 'Date', type: 'date', required: true, list: true, default: 'today' },
      { name: 'project_id', label: 'Project', type: 'ref', ref: 'projects', list: true, filter: true, hint: 'Leave blank for company overheads' },
      { name: 'category', label: 'Category', type: 'select', required: true, list: true, filter: true,
        options: ['Subcontract', 'Equipment Hire', 'Transport', 'Fuel', 'Permits & Fees', 'Site Utilities', 'Accommodation', 'Insurance', 'Safety', 'Office & Overheads', 'Other'] },
      { name: 'description', label: 'Description', type: 'text', required: true, list: true },
      { name: 'supplier_id', label: 'Paid To', type: 'ref', ref: 'suppliers', list: true },
      { name: 'amount', label: 'Amount (excl. VAT)', type: 'money', required: true, min: 0, list: true },
      { name: 'vat_amount', label: 'Input VAT', type: 'money', min: 0, default: 0 },
      { name: 'payment_status', label: 'Payment', type: 'select', options: ['Unpaid', 'Paid'], default: 'Unpaid', list: true, filter: true },
      { name: 'reference', label: 'Bill / Receipt No.', type: 'text' },
    ],
  },

  users: {
    label: 'Users', singular: 'User', table: 'users', group: 'Administration', icon: '🔐',
    write: ['admin'], read: ['admin'],
    display: (a) => `${a}.full_name`,
    search: ['username', 'full_name'],
    defaultSort: 'username ASC',
    fields: [
      { name: 'username', label: 'Username', type: 'text', required: true, list: true, pattern: '^[A-Za-z0-9._-]{3,32}$' },
      { name: 'full_name', label: 'Full Name', type: 'text', required: true, list: true },
      { name: 'role', label: 'Role', type: 'select', required: true, options: ['admin', 'manager', 'accountant', 'site_engineer', 'viewer'], default: 'viewer', list: true, filter: true },
      { name: 'active', label: 'Active', type: 'bool', default: 1, list: true },
      { name: 'password', label: 'Password', type: 'password', virtual: true, hint: 'At least 8 characters. Leave blank to keep the current password.' },
    ],
    hooks: {
      beforeSave: [(db, d, ctx) => {
        if (d.password) {
          if (d.password.length < 8) throw new ValidationError('Password must be at least 8 characters');
          d.password_hash = hashPassword(d.password);
        } else if (!ctx.existing) {
          throw new ValidationError('Password is required for new users');
        }
        delete d.password;
        if (ctx.existing && ctx.existing.id === ctx.user.id && (d.role !== 'admin' || !d.active)) {
          throw new ValidationError('You cannot remove your own admin access');
        }
      }],
      afterSave: [(db, id, d) => {
        if (!d.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      }],
      beforeDelete: [(db, row, ctx) => {
        if (row.id === ctx.user.id) throw new ValidationError('You cannot delete your own account');
      }],
    },
    extraColumns: ['password_hash'],
  },
};

// Normalise definitions.
for (const [key, r] of Object.entries(resources)) {
  r.key = key;
  r.read = r.read || null; // null => every authenticated role
  r.ops = r.ops || ['create', 'update', 'delete'];
  r.computed = r.computed || {};
  r.hooks = r.hooks || {};
  for (const f of r.fields) if (f.type === 'ref' && !resources[f.ref]) throw new Error(`Unknown ref ${f.ref} in ${key}`);
}

const canRead = (r, user) => !r.read || r.read.includes(user.role);
const canWrite = (r, user) => r.write.includes(user.role);

module.exports = {
  resources, ValidationError, canRead, canWrite, round2,
  PROJECT_COST_SQL, PROJECT_TOTAL_COST_SQL, INVOICE_PAID_SQL, INVOICE_STATE_SQL,
};
