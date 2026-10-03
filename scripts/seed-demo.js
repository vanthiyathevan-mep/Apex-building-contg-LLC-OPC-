'use strict';
/**
 * Loads realistic demo data so the ERP can be explored immediately.
 *   npm run seed:demo
 * Uses ERP_DB_FILE (default data/erp.db). Refuses to run if projects already exist.
 */
const path = require('node:path');
const { openDatabase } = require('../server/db');
const { ensureAdmin } = require('../server/auth');
const api = require('../server/api');

function seedDemo(db) {
  const admin = db.prepare(`SELECT id, username, role FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`).get();
  const save = (res, body) => api.save(db, admin, res, null, body);
  const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10); };

  db.prepare(`UPDATE settings SET value = ? WHERE key = 'company_address'`).run('Office 204, Al Qusais Industrial Area\nDubai, United Arab Emirates');
  db.prepare(`UPDATE settings SET value = ? WHERE key = 'invoice_terms'`).run(
    'Payment due within 30 days of invoice date.\nBank: Emirates NBD · Account: Apex Building Contracting LLC OPC · IBAN: AE00 0000 0000 0000 0000 000');

  const clients = [
    save('clients', { name: 'Al Noor Real Estate Development', contact_person: 'Khalid Al Mansoori', phone: '+971 4 555 0101', email: 'projects@alnoor.example', trn: '100234567800003', address: 'Business Bay, Dubai' }),
    save('clients', { name: 'Gulf Horizon Hospitality LLC', contact_person: 'Sarah Thompson', phone: '+971 2 555 0202', email: 'facilities@gulfhorizon.example', trn: '100345678900003', address: 'Al Reem Island, Abu Dhabi' }),
    save('clients', { name: 'Mr. Rashid Saeed Al Falasi', contact_person: 'Rashid Al Falasi', phone: '+971 50 555 0303', address: 'Al Barsha South, Dubai' }),
  ];

  const emp = (full_name, designation, trade, daily_rate, extra = {}) => save('employees', { full_name, designation, trade, daily_rate, joining_date: day(-700), visa_expiry: day(400), ...extra });
  const employees = [
    emp('Mohammed Irfan', 'Project Manager', 'Management', 900),
    emp('Anil Kumar', 'Site Engineer', 'Engineer', 550),
    emp('Joseph Mathew', 'Foreman', 'Foreman', 300, { visa_expiry: day(18) }),
    emp('Ramesh Thapa', 'Mason', 'Mason', 140),
    emp('Bikash Gurung', 'Steel Fixer', 'Steel Fixer', 140),
    emp('Abdul Rahim', 'Carpenter', 'Carpenter', 150),
    emp('Sunil Perera', 'Electrician', 'Electrician', 170),
    emp('Imran Khan', 'Helper', 'Helper', 90),
    emp('Raju Shrestha', 'Helper', 'Helper', 90, { visa_expiry: day(-3) }),
    emp('Faisal Ahmed', 'Heavy Equipment Operator', 'Operator', 220),
  ];

  const projects = [
    save('projects', { name: 'G+4 Residential Building — Al Warqa', client_id: clients[0].id, manager_id: employees[0].id, location: 'Al Warqa 1, Dubai', plot_no: '425-1187',
      start_date: day(-240), end_date: day(200), contract_value: 8_750_000, budget: 7_200_000, status: 'Active', progress: 46,
      description: 'Construction of G+4 residential building with 32 apartments, basement parking and roof amenities.' }),
    save('projects', { name: 'Hotel Lobby & F&B Fit-out', client_id: clients[1].id, manager_id: employees[0].id, location: 'Al Reem Island, Abu Dhabi',
      start_date: day(-90), end_date: day(60), contract_value: 2_350_000, budget: 1_950_000, status: 'Active', progress: 62,
      description: 'Interior fit-out of hotel lobby, restaurant and coffee shop including MEP modifications.' }),
    save('projects', { name: 'Private Villa G+1 — Al Barsha South', client_id: clients[2].id, manager_id: employees[1].id, location: 'Al Barsha South 3, Dubai', plot_no: '673-0421',
      start_date: day(-30), end_date: day(330), contract_value: 3_100_000, budget: 2_600_000, status: 'Active', progress: 8 }),
    save('projects', { name: 'Warehouse Extension — Jebel Ali', client_id: clients[0].id, location: 'Jebel Ali Industrial 2', start_date: day(30), end_date: day(270),
      contract_value: 4_200_000, budget: 3_500_000, status: 'Tendering', progress: 0 }),
  ];
  const [p1, p2, p3] = projects;

  const sup = (name, type, category, extra = {}) => save('suppliers', { name, type, category, ...extra });
  const suppliers = [
    sup('Emirates Cement Trading', 'Supplier', 'Cement & Concrete', { phone: '+971 4 555 1111', trn: '100111222300003' }),
    sup('Gulf Steel & Rebar LLC', 'Supplier', 'Steel', { phone: '+971 6 555 2222', trn: '100222333400003' }),
    sup('Al Bayan Blocks Factory', 'Supplier', 'Blocks', { phone: '+971 6 555 3333' }),
    sup('Desert Cranes Rental', 'Equipment Rental', 'Cranes & Lifting', { phone: '+971 4 555 4444' }),
    sup('Precision MEP Contracting', 'Subcontractor', 'MEP', { phone: '+971 4 555 5555', trn: '100555666700003' }),
    sup('Coastal Waterproofing Co.', 'Subcontractor', 'Waterproofing'),
  ];

  const mat = (name, category, unit, reorder_level) => save('materials', { name, category, unit, reorder_level });
  const materials = {
    cement: mat('OPC Cement 50kg', 'Cement & Concrete', 'Bag', 200),
    rebar12: mat('Rebar 12mm Grade 60', 'Steel & Rebar', 'Ton', 5),
    rebar16: mat('Rebar 16mm Grade 60', 'Steel & Rebar', 'Ton', 5),
    block20: mat('Hollow Block 20cm', 'Blocks & Bricks', 'Nos', 2000),
    sand: mat('Washed Sand', 'Aggregates', 'm³', 20),
    plywood: mat('Marine Plywood 18mm', 'Timber & Formwork', 'Sheet', 50),
    membrane: mat('Bituminous Membrane 4mm', 'Waterproofing', 'Roll', 30),
  };

  // Purchase orders: approved then received into stock.
  const po = (supplier, project, date, items, status = 'Approved') => save('purchase_orders', { supplier_id: supplier.id, project_id: project?.id, order_date: date, status, items });
  const received = [
    po(suppliers[0], p1, day(-200), [{ material_id: materials.cement.id, description: 'OPC Cement 50kg', quantity: 1500, unit: 'Bag', unit_price: 17.5 },
      { material_id: materials.sand.id, description: 'Washed Sand', quantity: 120, unit: 'm³', unit_price: 65 }]),
    po(suppliers[1], p1, day(-180), [{ material_id: materials.rebar12.id, description: 'Rebar 12mm', quantity: 40, unit: 'Ton', unit_price: 2650 },
      { material_id: materials.rebar16.id, description: 'Rebar 16mm', quantity: 35, unit: 'Ton', unit_price: 2600 }]),
    po(suppliers[2], p1, day(-120), [{ material_id: materials.block20.id, description: 'Hollow Block 20cm', quantity: 18000, unit: 'Nos', unit_price: 3.1 }]),
    po(suppliers[3], p1, day(-150), [{ description: 'Mobile crane 50T hire — 12 days incl. operator', quantity: 12, unit: 'Day', unit_price: 2800 }]),
    po(suppliers[0], null, day(-40), [{ material_id: materials.plywood.id, description: 'Marine Plywood 18mm', quantity: 220, unit: 'Sheet', unit_price: 95 },
      { material_id: materials.membrane.id, description: 'Bituminous Membrane 4mm', quantity: 25, unit: 'Roll', unit_price: 185 }]),
  ];
  for (const r of received) api.action(db, admin, 'purchase_orders', r.id, 'receive');
  po(suppliers[1], p3, day(-5), [{ material_id: materials.rebar12.id, description: 'Rebar 12mm', quantity: 18, unit: 'Ton', unit_price: 2700 }]);
  po(suppliers[0], p3, day(-2), [{ material_id: materials.cement.id, description: 'OPC Cement 50kg', quantity: 600, unit: 'Bag', unit_price: 17.75 }], 'Draft');

  // Material issues to site.
  const issue = (m, p, qty, offset, ref) => save('stock_movements', { material_id: m.id, project_id: p.id, type: 'OUT', quantity: qty, movement_date: day(offset), reference: ref });
  issue(materials.cement, p1, 1350, -170, 'MRN-001');
  issue(materials.sand, p1, 105, -165, 'MRN-002');
  issue(materials.rebar12, p1, 37, -160, 'MRN-003');
  issue(materials.rebar16, p1, 33, -150, 'MRN-004');
  issue(materials.block20, p1, 16500, -90, 'MRN-005');
  issue(materials.plywood, p2, 140, -35, 'MRN-006');
  issue(materials.membrane, p3, 4, -10, 'MRN-007');
  issue(materials.plywood, p3, 30, -8, 'MRN-008');

  // Timesheets for the last 14 days.
  const crew = { [p1.id]: employees.slice(2, 7), [p2.id]: [employees[7], employees[6]], [p3.id]: [employees[8], employees[9], employees[3]] };
  for (let d = -14; d <= 0; d++) {
    if (new Date(day(d)).getDay() === 5) continue; // Friday off
    for (const [pid, team] of Object.entries(crew)) {
      for (const [i, e] of team.entries()) {
        if (pid == p3.id && e.id === employees[3].id) continue;
        save('timesheets', { employee_id: e.id, project_id: Number(pid), work_date: day(d), hours: 8, overtime_hours: (i + d) % 3 === 0 ? 2 : 0 });
      }
    }
  }

  // Tasks & milestones.
  const task = (p, title, status, progress, start, due, assignee, priority = 'Medium') => save('tasks', { project_id: p.id, title, status, progress, start_date: day(start), due_date: day(due), assignee_id: assignee?.id, priority });
  task(p1, 'Substructure & basement slab', 'Done', 100, -230, -150, employees[1]);
  task(p1, 'Superstructure — 1st to 3rd floor slabs', 'Done', 100, -150, -40, employees[1]);
  task(p1, '4th floor & roof slab', 'In Progress', 70, -40, 5, employees[2], 'High');
  task(p1, 'Blockwork & plaster', 'In Progress', 45, -90, 60, employees[2]);
  task(p1, 'Civil Defence MEP approval', 'Blocked', 20, -20, 3, employees[0], 'Critical');
  task(p2, 'Lobby ceiling & lighting', 'In Progress', 80, -60, 2, employees[6], 'High');
  task(p2, 'Restaurant kitchen exhaust', 'Not Started', 0, 0, 20, employees[6]);
  task(p3, 'Excavation & shoring', 'In Progress', 35, -20, 10, employees[1]);
  task(p3, 'Dubai Municipality building permit', 'Done', 100, -45, -25, employees[0]);

  // Site reports.
  const log = (p, offset, weather, manpower, work_done, issues) => save('site_logs', { project_id: p.id, log_date: day(offset), weather, manpower_count: manpower, work_done, issues });
  log(p1, -1, 'Hot', 38, 'Roof slab rebar fixing 70% complete. Blockwork on 3rd floor ongoing.', 'Rebar 12mm stock low — PO raised.');
  log(p1, 0, 'Humid', 41, 'Roof slab formwork inspection with consultant. Plastering 1st floor started.', null);
  log(p2, 0, 'Clear', 14, 'Gypsum ceiling boarding in lobby. Light fixture first fix.', 'Awaiting client approval on lobby light fixture samples.');
  log(p3, 0, 'Windy / Dusty', 12, 'Excavation to -3.0m level, shoring piles 60% installed.', null);

  // Equipment.
  save('equipment', { name: 'CAT 320 Excavator', category: 'Excavator', ownership: 'Owned', status: 'In Use', project_id: p3.id, daily_cost: 950, purchase_date: day(-900), purchase_cost: 420000, next_service_date: day(12), registration_expiry: day(150) });
  save('equipment', { name: 'JCB 3CX Backhoe Loader', category: 'Loader', ownership: 'Owned', status: 'Available', daily_cost: 600, purchase_cost: 210000, next_service_date: day(45) });
  save('equipment', { name: 'Mitsubishi Canter Pickup', category: 'Pickup / Car', ownership: 'Owned', status: 'In Use', project_id: p1.id, daily_cost: 150, purchase_cost: 95000, registration_expiry: day(20) });
  save('equipment', { name: '100 kVA Diesel Generator', category: 'Generator', ownership: 'Hired', status: 'In Use', project_id: p1.id, daily_cost: 280, next_service_date: day(-2) });
  save('equipment', { name: 'Concrete Mixer 350L', category: 'Concrete Mixer', ownership: 'Owned', status: 'Under Maintenance', daily_cost: 80, purchase_cost: 9500 });

  // Expenses.
  const exp = (p, category, description, amount, offset, supplier, payment_status = 'Paid') => save('expenses', { project_id: p?.id, category, description, amount, vat_amount: Math.round(amount * 5) / 100, expense_date: day(offset), supplier_id: supplier?.id, payment_status });
  exp(p1, 'Subcontract', 'MEP first fix — progress payment 1', 185000, -60, suppliers[4]);
  exp(p1, 'Subcontract', 'Basement waterproofing', 62000, -170, suppliers[5]);
  exp(p1, 'Permits & Fees', 'Dubai Municipality & DEWA connection fees', 28500, -210);
  exp(p1, 'Site Utilities', 'Water tanker & site electricity', 14200, -15, null, 'Unpaid');
  exp(p2, 'Subcontract', 'Gypsum ceiling & partitions — subcontract', 240000, -30, suppliers[4], 'Unpaid');
  exp(p2, 'Transport', 'Material transport Dubai → Abu Dhabi', 8600, -45);
  exp(p3, 'Equipment Hire', 'Shoring piling rig hire', 46000, -12, suppliers[3], 'Unpaid');
  exp(null, 'Office & Overheads', 'Office rent — quarter', 36000, -50);
  exp(null, 'Insurance', 'Contractors All Risk & Workmen Compensation', 52000, -120);

  // Progress invoices & payments.
  const inv = (p, issue, due, items, status = 'Issued') => save('invoices', { project_id: p.id, issue_date: day(issue), due_date: day(due), status, items });
  const i1 = inv(p1, -150, -120, [{ description: 'Progress claim 1 — substructure works (12% of contract)', quantity: 1, unit: 'LS', rate: 1_050_000 }]);
  const i2 = inv(p1, -90, -60, [{ description: 'Progress claim 2 — superstructure up to 2nd floor', quantity: 1, unit: 'LS', rate: 1_400_000 }]);
  const i3 = inv(p1, -25, 5, [{ description: 'Progress claim 3 — 3rd floor slab & blockwork', quantity: 1, unit: 'LS', rate: 980_000 }]);
  const i4 = inv(p2, -60, -30, [{ description: 'Advance payment (20%)', quantity: 1, unit: 'LS', rate: 470_000 }]);
  const i5 = inv(p2, -20, 10, [{ description: 'Lobby ceiling works', quantity: 850, unit: 'm²', rate: 210 }, { description: 'Lighting first fix', quantity: 1, unit: 'LS', rate: 96_000 }]);
  inv(p3, -1, 29, [{ description: 'Mobilisation advance (10%)', quantity: 1, unit: 'LS', rate: 310_000 }], 'Draft');
  const pay = (i, amount, offset, method, reference) => save('payments', { invoice_id: i.id, amount, payment_date: day(offset), method, reference });
  pay(i1, i1.total, -115, 'Bank Transfer', 'TT-88231');
  pay(i2, 800_000, -55, 'Cheque', 'CHQ 004512');
  pay(i4, i4.total, -50, 'Bank Transfer', 'TT-90112');
  pay(i5, 100_000, -3, 'PDC', 'PDC 118820');
  void i3;

  return { projects: projects.length, employees: employees.length };
}

if (require.main === module) {
  const file = process.env.ERP_DB_FILE || path.join(__dirname, '..', 'data', 'erp.db');
  const db = openDatabase(file);
  const pw = ensureAdmin(db, process.env.ERP_ADMIN_PASSWORD);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM projects').get();
  if (n > 0) {
    console.error('Database already contains projects — demo data not loaded.');
    process.exit(1);
  }
  seedDemo(db);
  console.log(`Demo data loaded into ${file}`);
  if (pw) console.log(`Administrator account created — username: admin  password: ${pw}`);
}

module.exports = { seedDemo };
