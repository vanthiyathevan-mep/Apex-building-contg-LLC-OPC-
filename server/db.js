'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  username TEXT,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  record_id INTEGER,
  summary TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  contact_person TEXT, phone TEXT, email TEXT, address TEXT, trn TEXT, notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY,
  emp_no TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  designation TEXT, trade TEXT, phone TEXT, email TEXT,
  daily_rate REAL NOT NULL DEFAULT 0,
  joining_date TEXT, visa_expiry TEXT, passport_no TEXT,
  status TEXT NOT NULL DEFAULT 'Active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  client_id INTEGER REFERENCES clients(id),
  manager_id INTEGER REFERENCES employees(id),
  location TEXT, plot_no TEXT,
  start_date TEXT, end_date TEXT,
  contract_value REAL NOT NULL DEFAULT 0,
  budget REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Planning',
  progress INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'Supplier',
  category TEXT, contact_person TEXT, phone TEXT, email TEXT, trn TEXT, address TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT, unit TEXT NOT NULL DEFAULT 'Nos',
  unit_cost REAL NOT NULL DEFAULT 0,
  stock_qty REAL NOT NULL DEFAULT 0,
  reorder_level REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY,
  material_id INTEGER NOT NULL REFERENCES materials(id),
  project_id INTEGER REFERENCES projects(id),
  movement_date TEXT NOT NULL,
  type TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_cost REAL NOT NULL DEFAULT 0,
  reference TEXT, notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS equipment (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT,
  ownership TEXT NOT NULL DEFAULT 'Owned',
  status TEXT NOT NULL DEFAULT 'Available',
  project_id INTEGER REFERENCES projects(id),
  daily_cost REAL NOT NULL DEFAULT 0,
  purchase_date TEXT, purchase_cost REAL NOT NULL DEFAULT 0,
  next_service_date TEXT, registration_expiry TEXT, notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS timesheets (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  work_date TEXT NOT NULL,
  hours REAL NOT NULL DEFAULT 8,
  overtime_hours REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (employee_id, project_id, work_date)
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  assignee_id INTEGER REFERENCES employees(id),
  start_date TEXT, due_date TEXT,
  status TEXT NOT NULL DEFAULT 'Not Started',
  priority TEXT NOT NULL DEFAULT 'Medium',
  progress INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS site_logs (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  log_date TEXT NOT NULL,
  weather TEXT,
  manpower_count INTEGER NOT NULL DEFAULT 0,
  work_done TEXT NOT NULL,
  issues TEXT, safety_incidents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY,
  po_no TEXT NOT NULL UNIQUE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  project_id INTEGER REFERENCES projects(id),
  order_date TEXT NOT NULL,
  delivery_date TEXT,
  status TEXT NOT NULL DEFAULT 'Draft',
  vat_rate REAL NOT NULL DEFAULT 5,
  subtotal REAL NOT NULL DEFAULT 0,
  vat_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  received_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS po_items (
  id INTEGER PRIMARY KEY,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  material_id INTEGER REFERENCES materials(id),
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT,
  unit_price REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  invoice_no TEXT NOT NULL UNIQUE,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  issue_date TEXT NOT NULL,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'Draft',
  vat_rate REAL NOT NULL DEFAULT 5,
  retention_pct REAL NOT NULL DEFAULT 0,
  subtotal REAL NOT NULL DEFAULT 0,
  vat_amount REAL NOT NULL DEFAULT 0,
  retention_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT,
  rate REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  payment_date TEXT NOT NULL,
  amount REAL NOT NULL,
  method TEXT NOT NULL DEFAULT 'Bank Transfer',
  reference TEXT, notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id),
  supplier_id INTEGER REFERENCES suppliers(id),
  expense_date TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  vat_amount REAL NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'Unpaid',
  reference TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_timesheets_project ON timesheets(project_id);
CREATE INDEX IF NOT EXISTS idx_stock_project ON stock_movements(project_id);
CREATE INDEX IF NOT EXISTS idx_expenses_project ON expenses(project_id);
CREATE INDEX IF NOT EXISTS idx_invoices_project ON invoices(project_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_po_project ON purchase_orders(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
`;

const DEFAULT_SETTINGS = {
  company_name: 'Apex Building Contracting LLC OPC',
  company_address: 'United Arab Emirates',
  company_phone: '',
  company_email: '',
  company_trn: '',
  currency: 'AED',
  default_vat_rate: '5',
  default_retention_pct: '10',
  invoice_terms: 'Payment due within 30 days of invoice date.',
};

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  return db;
}

/** Run fn inside a transaction; rolls back on throw. */
function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDatabase, tx, DEFAULT_SETTINGS };
