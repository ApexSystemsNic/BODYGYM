// Exports the public catalog (products and combos) from the SQLite database to
// server/seed/catalog.json. That file is what a fresh installation uses to create
// its initial database. It never contains orders, reviews, admin users or sessions.
//
// Usage: npm run export:catalog            (reads DB_PATH or data/bodyfactory.db)
//        node scripts/export-catalog.mjs --out <file>
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = resolve(process.env.DB_PATH || join(root, 'data', 'bodyfactory.db'));
const outArg = process.argv.indexOf('--out');
const out = resolve(outArg > -1 ? process.argv[outArg + 1] : join(root, 'server', 'seed', 'catalog.json'));

if (!existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}
const db = new DatabaseSync(dbPath, { readOnly: true });
const JSON_FIELDS = ['flavors', 'badges', 'macros', 'benefits', 'warnings'];
const COLS = [
  'id', 'name', 'brand', 'category', 'presentation', 'flavors', 'price_retail', 'price_wholesale', 'stock',
  'servings', 'serving_size', 'image', 'badges', 'tag', 'popularity', 'macros', 'benefits', 'usage', 'warnings',
  'description', 'active',
];
const products = db.prepare(`SELECT ${COLS.join(', ')} FROM products ORDER BY id`).all().map((row) => {
  const p = { ...row };
  for (const f of JSON_FIELDS) p[f] = JSON.parse(p[f] || (f === 'macros' ? '{}' : '[]'));
  p.active = !!p.active;
  return p;
});
const combos = db.prepare('SELECT id, name, note, items, discount, active FROM combos ORDER BY id').all()
  .map((c) => ({ ...c, items: JSON.parse(c.items), active: !!c.active }));
db.close();

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ products, combos }, null, 2) + '\n');
console.log(`Catalog exported: ${products.length} products, ${combos.length} combos -> ${out}`);
