import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './postgres.js';

const root = join(
  dirname(fileURLToPath(import.meta.url)),
  '..'
);

const PRODUCT_COLS = [
  'id',
  'name',
  'brand',
  'category',
  'presentation',
  'flavors',
  'price_retail',
  'price_wholesale',
  'stock',
  'servings',
  'serving_size',
  'image',
  'badges',
  'tag',
  'popularity',
  'macros',
  'benefits',
  'usage',
  'warnings',
  'description',
  'active',
];

function productValue(product, column) {
  const value = product[column];

  if (column === 'flavors') {
    return JSON.stringify(Array.isArray(value) ? value : []);
  }

  if (column === 'badges') {
    return JSON.stringify(Array.isArray(value) ? value : []);
  }

  if (column === 'benefits') {
    return JSON.stringify(Array.isArray(value) ? value : []);
  }

  if (column === 'warnings') {
    return JSON.stringify(Array.isArray(value) ? value : []);
  }

  if (column === 'macros') {
    return JSON.stringify(
      value && typeof value === 'object' ? value : {}
    );
  }

  if (column === 'active') {
    return value === false ? 0 : 1;
  }

  if (
    column === 'price_retail' ||
    column === 'price_wholesale' ||
    column === 'stock' ||
    column === 'servings' ||
    column === 'popularity'
  ) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  return value ?? '';
}

export async function seedPostgresIfEmpty() {
  const countResult = await pool.query(`
    SELECT COUNT(*)::integer AS n
    FROM products
  `);

  if (countResult.rows[0].n > 0) {
    console.log(
      'PostgreSQL ya contiene productos; no se aplica el catálogo semilla.'
    );

    return;
  }

  const seedPath = join(
    root,
    'server',
    'seed',
    'catalog.json'
  );

  const seed = JSON.parse(
    await readFile(seedPath, 'utf8')
  );

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const product of seed.products || []) {
      const values = PRODUCT_COLS.map((column) =>
        productValue(product, column)
      );

      const placeholders = PRODUCT_COLS.map(
        (_, index) => `$${index + 1}`
      ).join(', ');

      await client.query(
        `
          INSERT INTO products (
            ${PRODUCT_COLS.join(', ')}
          )
          VALUES (
            ${placeholders}
          )
          ON CONFLICT (id) DO NOTHING
        `,
        values
      );
    }

    for (const combo of seed.combos || []) {
      await client.query(
        `
          INSERT INTO combos (
            id,
            name,
            note,
            items,
            discount,
            active
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6
          )
          ON CONFLICT (id) DO NOTHING
        `,
        [
          combo.id,
          combo.name,
          combo.note || '',
          JSON.stringify(
            Array.isArray(combo.items)
              ? combo.items
              : []
          ),
          Number(combo.discount) || 0,
          combo.active === false ? 0 : 1,
        ]
      );
    }

    await client.query('COMMIT');

    console.log(
      `PostgreSQL inicializado con ${
        (seed.products || []).length
      } productos y ${
        (seed.combos || []).length
      } combos.`
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}