// Consistent SQLite backup (safe while the server is running) + integrity check.
// Usage: npm run backup:db [-- --reason <text>] [-- --dir <folder>]
// Default output: backups/bodyfactory-<ISO date>[-<reason>].db  (backups/ is not versioned)
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const dbPath = resolve(process.env.DB_PATH || join(root, 'data', 'bodyfactory.db'));
const dir = resolve(arg('--dir') || join(root, 'backups'));
const reason = (arg('--reason') || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');

if (!existsSync(dbPath)) { console.error(`Database not found: ${dbPath}`); process.exit(1); }
mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(dbPath);
const before = db.prepare('PRAGMA integrity_check').get().integrity_check;
if (before !== 'ok') { console.error(`integrity_check failed: ${before}`); process.exit(2); }
const file = join(dir, `bodyfactory-${new Date().toISOString().replace(/[:.]/g, '-')}${reason ? '-' + reason : ''}.db`);
db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
db.close();
const copy = new DatabaseSync(file, { readOnly: true });
const check = copy.prepare('PRAGMA integrity_check').get().integrity_check;
copy.close();
console.log(`Backup: ${file} (integrity_check: ${check})`);
if (check !== 'ok') process.exit(2);
