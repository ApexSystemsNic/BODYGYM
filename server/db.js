import pg from 'pg';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { execute } from './postgres.js';

// Capa de datos PostgreSQL (DATABASE_URL, ver server/postgres.js). El esquema y los datos ya existen en
// PostgreSQL (npm run postgres:init / postgres:migrate): el runtime no crea tablas, no siembra y no crea
// usuarios. No hay ningún respaldo en SQLite.

// Las columnas TIMESTAMPTZ se devuelven como texto UTC «YYYY-MM-DD HH:MM:SS» (el formato que ya consumen
// el panel y el sitemap), en lugar de objetos Date.
pg.types.setTypeParser(1184, (v) => new Date(v).toISOString().slice(0, 19).replace('T', ' '));

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

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

export async function saveProduct(p, { create }) {
  const params = PRODUCT_COLS.map((c) => {
    const v = p[c];
    if (JSON_FIELDS.includes(c)) return JSON.stringify(v ?? (c === 'warnings' ? [] : v));
    if (c === 'active') return v ? 1 : 0;
    return v;
  });
  if (create) {
    await execute(`INSERT INTO products (${PRODUCT_COLS.join(',')}) VALUES (${PRODUCT_COLS.map((_, i) => `$${i + 1}`).join(',')})`, params);
  } else {
    const cols = PRODUCT_COLS.filter((c) => c !== 'id');
    const set = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    await execute(`UPDATE products SET ${set}, updated_at = CURRENT_TIMESTAMP WHERE id = $${cols.length + 1}`, [...params.slice(1), p.id]);
  }
}

// Archivo legado con la contraseña inicial que generaba el arranque con SQLite. PostgreSQL ya tiene su
// administrador migrado y nada depende de este archivo: solo se conserva la ruta para que el cambio de
// contraseña pueda borrarlo si existe (junto a DB_PATH si está definida; solo se usa para ubicar el archivo).
export const initialPasswordFile = join(process.env.DB_PATH ? dirname(process.env.DB_PATH) : join(root, 'data'), 'initial-admin-password.txt');

// Nombres de usuario: minúsculas, 3-32 caracteres, letras, números, punto, guion y guion bajo.
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export function normalizeUsername(u) {
  const v = String(u ?? '').trim().toLowerCase();
  return USERNAME_RE.test(v) ? v : '';
}
export const MIN_PASSWORD = 10;
