# Apex Construction ERP

A web-based ERP for **Apex Building Contracting LLC OPC**. It covers projects, workforce, procurement, inventory, plant and equipment, client billing and job costing. It is built for UAE contracting work, with AED, 5% VAT, retention on progress claims, TRN on documents and visa/registration expiry tracking.

It has **no npm dependencies**. It runs on Node.js ≥ 22.5 and uses the built-in `node:sqlite` database and `node:http` server. The browser UI is plain JavaScript.

## Quick start

```bash
npm start                      # http://localhost:3000
```

On first start an `admin` account is created and its password is printed to the console. Sign in, then change the password under **My Account**.

To try it with realistic sample data (clients, 4 projects, crew, POs, invoices and more):

```bash
ERP_DEMO=1 ERP_ADMIN_PASSWORD='choose-a-password' npm start
# or, into an empty database:  npm run seed:demo
```

Run the tests with `npm test`.

### Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address |
| `ERP_DB_FILE` | `data/erp.db` | SQLite database file (back this file up) |
| `ERP_ADMIN_PASSWORD` | random | Password for the initial `admin` user (first start only) |
| `ERP_SECURE_COOKIES` | off | Set to `1` when served over HTTPS |
| `ERP_DEMO` | off | Set to `1` to load demo data into an empty database |

## Modules

| Area | Module | Highlights |
|---|---|---|
| Operations | **Projects** | Auto codes (`PRJ-2026-001`), contract value, cost budget, status and progress. The project page shows live job costing (labor, materials, direct purchases, expenses), budget used, invoiced, received, outstanding and margin, plus tabs for every related record |
| | Clients | Contacts, TRN |
| | Tasks & Milestones | Assignee, due dates, priority, progress; tasks due within 7 days appear on the dashboard |
| | Daily Site Reports | Weather, manpower, work done, issues, safety incidents |
| Workforce | Employees | Trades, daily rates, passport, **visa expiry alerts** |
| | Timesheets | Regular + overtime hours. Cost is calculated automatically (daily rate ÷ 8, overtime at +25%) |
| Procurement | Suppliers & Subcontractors | Suppliers, subcontractors, consultants, rental companies |
| | **Purchase Orders** | Line items and VAT. Status runs Draft → Approved → **Mark as Received**: stock items go into inventory and non-stock lines are charged to the project. Printable PO |
| | Materials & Inventory | Moving-average cost, stock on hand, reorder levels, low-stock alerts |
| | Stock Movements | IN / OUT (issue to project) / RETURN / ADJUST; blocks negative stock; deleting a movement reverses it |
| | Plant & Equipment | Owned or hired, deployment to projects, **service and registration due alerts** |
| Finance | **Invoices / Progress Claims** | Bill items, VAT, **retention**. Payment status (Unpaid / Partially Paid / Overdue / Paid) is derived from payments. Printable **Tax Invoice** with company and client TRN |
| | Payments Received | Bank transfer, cheque, PDC; cannot exceed the outstanding balance |
| | Expenses | Project or overhead, by category, input VAT, paid/unpaid |
| | **Reports** | Project job costing, receivables aging, labor hours & cost, expenses by category, inventory valuation, material consumption, VAT summary (output vs input), expiring documents. All exportable to CSV and printable |
| Admin | Users, Company Settings | Role-based access; company name, address, TRN, currency, default VAT and retention, invoice terms and bank details |

Every list has search, filters, date ranges, sorting, pagination and CSV export. Every change is recorded in an activity log, shown on the dashboard.

### How job cost is calculated

`Actual cost = labor (timesheets) + materials issued from store (OUT − RETURN) + received PO lines without a stock material + project expenses`

Stocked materials count toward cost when they are **issued** to the project, not when they are purchased, so nothing is counted twice. Approved but unreceived POs appear separately as *committed cost*.

### Roles

| Role | Can change |
|---|---|
| `admin` | Everything, including users and company settings |
| `manager` | All operational and financial modules |
| `accountant` | Clients, suppliers, purchase orders, invoices, payments, expenses |
| `site_engineer` | Tasks, site reports, timesheets, materials, stock movements, equipment (no access to financial modules) |
| `viewer` | Read-only (including finance) |

## Architecture

```
server/
  index.js      HTTP server, routing, auth endpoints, static files, security headers
  db.js         SQLite schema + default settings
  auth.js       scrypt password hashing, sessions, login throttling
  resources.js  Declarative module definitions (fields, validation, permissions, business rules)
  api.js        Generic CRUD / list / search / CSV engine driven by resources.js
  reports.js    Dashboard, project summary and reports
public/         Single-page UI (hash routing, no build step)
scripts/seed-demo.js   Demo data
test/api.test.js       API tests (node:test)
```

To add a field or a module, edit `server/resources.js` (and add the column in `server/db.js`). The API, forms, lists, filters and related-record tabs pick it up automatically.

### Security notes

- Passwords are hashed with scrypt. Session tokens are random, stored server-side only as SHA-256 hashes, and sent in `HttpOnly; SameSite=Strict` cookies.
- State-changing requests must be JSON. A strict Content-Security-Policy is set and the UI never injects HTML from data.
- After 10 failed logins, that username and IP pair is blocked for 15 minutes. Deactivated users are signed out immediately.
- In production, run it behind HTTPS (for example nginx or Caddy), set `ERP_SECURE_COOKIES=1`, and back up the `data/` directory regularly.
