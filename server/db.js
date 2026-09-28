import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.DB_PATH || join(root, 'data', 'bodyfactory.db');
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  presentation TEXT NOT NULL DEFAULT '',
  flavors TEXT NOT NULL DEFAULT '[]',
  price_retail REAL NOT NULL DEFAULT 0,
  price_wholesale REAL NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  servings INTEGER NOT NULL DEFAULT 0,
  serving_size TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '',
  badges TEXT NOT NULL DEFAULT '[]',
  tag TEXT NOT NULL DEFAULT '',
  popularity INTEGER NOT NULL DEFAULT 0,
  macros TEXT NOT NULL DEFAULT '{}',
  benefits TEXT NOT NULL DEFAULT '[]',
  usage TEXT NOT NULL DEFAULT '',
  warnings TEXT NOT NULL DEFAULT '[]',
  description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS combos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  items TEXT NOT NULL DEFAULT '[]',
  discount REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product TEXT NOT NULL,
  name TEXT NOT NULL,
  stars INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'approved'
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  price_mode TEXT NOT NULL,
  customer_name TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  lines TEXT NOT NULL,
  total REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'nuevo'
);
CREATE TABLE IF NOT EXISTS admins (
  username TEXT PRIMARY KEY,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT ''
);
`);

// Migración aditiva: cuentas de usuario del panel con rol y estado.
//   role   'admin' = administrador (gestiona usuarios) · 'staff' = empleado (productos, pedidos y reseñas)
//   active 1 = puede iniciar sesión · 0 = desactivada
// Las cuentas existentes conservan su acceso como administradoras. Idempotente: solo añade lo que falta.
{
  const cols = new Set(db.prepare('PRAGMA table_info(admins)').all().map((c) => c.name));
  const add = [
    ['role', "ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'"],
    ['active', 'ALTER TABLE admins ADD COLUMN active INTEGER NOT NULL DEFAULT 1'],
    ['created_at', "ALTER TABLE admins ADD COLUMN created_at TEXT NOT NULL DEFAULT ''"],
  ].filter(([c]) => !cols.has(c));
  if (add.length) {
    db.exec('BEGIN');
    try {
      for (const [, sql] of add) db.exec(sql);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    console.log(`Migración aplicada: admins (${add.map(([c]) => c).join(', ')}).`);
  }
}

// Migración aditiva: advertencias por producto (bases creadas antes de existir la columna).
if (!db.prepare('PRAGMA table_info(products)').all().some((c) => c.name === 'warnings')) {
  db.exec("ALTER TABLE products ADD COLUMN warnings TEXT NOT NULL DEFAULT '[]'");
  console.log('Migración aplicada: products.warnings.');
}

// Migración aditiva: moderación de reseñas. Las reseñas existentes se marcan 'approved'
// para no cambiar el comportamiento actual del sitio (no se oculta ni se borra nada).
// Las reseñas públicas nuevas se insertan siempre como 'pending' (ver POST /api/reviews).
if (!db.prepare('PRAGMA table_info(reviews)').all().some((c) => c.name === 'status')) {
  db.exec("ALTER TABLE reviews ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'");
  console.log('Migración aplicada: reviews.status (pending/approved/rejected).');
}

const JSON_FIELDS = ['flavors', 'badges', 'macros', 'benefits', 'warnings'];

export function hydrate(row) {
  if (!row) return row;
  const out = { ...row };
  for (const f of JSON_FIELDS) out[f] = JSON.parse(out[f]);
  out.active = !!out.active;
  return out;
}

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}

export function verifyPassword(password, admin) {
  const a = Buffer.from(hashPassword(password, admin.salt).hash, 'hex');
  const b = Buffer.from(admin.hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

const PRODUCT_COLS = [
  'id', 'name', 'brand', 'category', 'presentation', 'flavors', 'price_retail', 'price_wholesale', 'stock',
  'servings', 'serving_size', 'image', 'badges', 'tag', 'popularity', 'macros', 'benefits', 'usage', 'warnings', 'description', 'active',
];

export function saveProduct(p, { create }) {
  const params = PRODUCT_COLS.map((c) => {
    const v = p[c];
    if (JSON_FIELDS.includes(c)) return JSON.stringify(v ?? (c === 'warnings' ? [] : v));
    if (c === 'active') return v ? 1 : 0;
    return v;
  });
  if (create) {
    db.prepare(`INSERT INTO products (${PRODUCT_COLS.join(',')}) VALUES (${PRODUCT_COLS.map(() => '?').join(',')})`).run(...params);
  } else {
    const set = PRODUCT_COLS.filter((c) => c !== 'id').map((c) => `${c} = ?`).join(', ');
    const rest = params.slice(1);
    db.prepare(`UPDATE products SET ${set}, updated_at = datetime('now') WHERE id = ?`).run(...rest, p.id);
  }
}

// Base nueva: se crea con el catálogo público versionado en server/seed/catalog.json
// (generado con `npm run export:catalog`). Nunca incluye pedidos, reseñas ni usuarios.
function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
  if (count > 0) return;
  const seedPath = join(root, 'server', 'seed', 'catalog.json');
  if (!existsSync(seedPath)) { console.log('Base de datos vacía: agrega productos desde /admin.'); return; }
  const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
  db.exec('BEGIN');
  try {
    for (const p of seed.products || []) saveProduct({ warnings: [], ...p, active: p.active !== false }, { create: true });
    for (const c of seed.combos || []) {
      db.prepare('INSERT INTO combos (id, name, note, items, discount, active) VALUES (?,?,?,?,?,?)')
        .run(c.id, c.name, c.note || '', JSON.stringify(c.items), c.discount, c.active === false ? 0 : 1);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log(`Base de datos inicializada con el catálogo (${(seed.products || []).length} productos).`);
}

// Archivo con la contraseña inicial generada (solo si no se definió ADMIN_PASSWORD). Vive junto a la base,
// fuera de public/ y de Git; se elimina en cuanto esa cuenta cambia su contraseña.
export const initialPasswordFile = join(dirname(dbPath), 'initial-admin-password.txt');

function ensureAdmin() {
  if (db.prepare('SELECT COUNT(*) AS n FROM admins').get().n > 0) return;
  const username = normalizeUsername(process.env.ADMIN_USER || 'admin') || 'admin';
  let password = process.env.ADMIN_PASSWORD;
  const generated = !password;
  if (generated) password = randomBytes(12).toString('base64url');
  const { salt, hash } = hashPassword(password);
  db.prepare("INSERT INTO admins (username, salt, hash, role, active, created_at) VALUES (?,?,?,'admin',1,datetime('now'))").run(username, salt, hash);
  // La contraseña nunca se escribe en la consola ni en los logs.
  if (generated) writeFileSync(initialPasswordFile, `${username}\n${password}\n`, { mode: 0o600 });
  console.log(`Usuario administrador creado: ${username}.${generated ? ` Contraseña inicial en ${initialPasswordFile} (cámbiala al entrar).` : ''}`);
}

// Nombres de usuario: minúsculas, 3-32 caracteres, letras, números, punto, guion y guion bajo.
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export function normalizeUsername(u) {
  const v = String(u ?? '').trim().toLowerCase();
  return USERNAME_RE.test(v) ? v : '';
}
export const MIN_PASSWORD = 10;

seedIfEmpty();
ensureAdmin();
