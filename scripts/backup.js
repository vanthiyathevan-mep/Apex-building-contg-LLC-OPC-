'use strict';
/**
 * Writes a consistent snapshot of the live database (safe while the app is running).
 *   npm run backup                       -> <db dir>/backups/erp-YYYYMMDD-HHMMSS.db
 *   npm run backup -- /path/to/dir       -> /path/to/dir/erp-YYYYMMDD-HHMMSS.db
 * Keeps the newest ERP_BACKUP_KEEP snapshots (default 30) in the target directory.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');

async function run() {
  const dbFile = process.env.ERP_DB_FILE || path.join(__dirname, '..', 'data', 'erp.db');
  if (!fs.existsSync(dbFile)) throw new Error(`Database not found: ${dbFile}`);
  const dir = process.argv[2] || path.join(path.dirname(dbFile), 'backups');
  fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const target = path.join(dir, `erp-${stamp}.db`);
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try { await backup(db, target); } finally { db.close(); }
  console.log(`Backup written: ${target} (${(fs.statSync(target).size / 1024).toFixed(0)} KB)`);

  const keep = Number(process.env.ERP_BACKUP_KEEP) || 30;
  const old = fs.readdirSync(dir).filter((f) => /^erp-\d{8}-\d{6}\.db$/.test(f)).sort().slice(0, -keep);
  for (const f of old) fs.unlinkSync(path.join(dir, f));
  if (old.length) console.log(`Removed ${old.length} old backup(s); keeping ${keep}.`);
}

run().catch((err) => { console.error(err.message); process.exit(1); });
