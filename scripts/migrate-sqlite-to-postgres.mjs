import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pool } from '../server/postgres.js';
import { initPostgresSchema } from '../server/postgres-schema.js';

const root = join(
  dirname(fileURLToPath(import.meta.url)),
  '..'
);

const dbPath =
  process.env.DB_PATH ||
  join(root, 'data', 'bodyfactory.db');

const MIGRATION_KEY = 'sqlite-to-postgres-v1';

if (!existsSync(dbPath)) {
  throw new Error(
    `No se encontró la base SQLite en: ${dbPath}`
  );
}

console.log(`Base SQLite encontrada: ${dbPath}`);

const sqlite = new DatabaseSync(dbPath);

function sqliteRows(sql) {
  return sqlite.prepare(sql).all();
}

function safeDate(value) {
  const text = String(value ?? '').trim();

  if (!text) {
    return new Date().toISOString();
  }

  return text;
}

async function resetIdentity(client, table) {
  await client.query(`
    SELECT setval(
      pg_get_serial_sequence('${table}', 'id'),
      COALESCE(MAX(id), 1),
      COUNT(*) > 0
    )
    FROM ${table}
  `);
}

async function migrate() {
  await initPostgresSchema();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_migrations (
      name TEXT PRIMARY KEY,
      executed_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const alreadyDone = await pool.query(
    `
      SELECT 1
      FROM app_migrations
      WHERE name = $1
    `,
    [MIGRATION_KEY]
  );

  if (alreadyDone.rowCount > 0) {
    console.log(
      'La migración SQLite → PostgreSQL ya fue ejecutada. No se repetirá.'
    );

    return;
  }

  const products = sqliteRows(`
    SELECT *
    FROM products
    ORDER BY id
  `);

  const combos = sqliteRows(`
    SELECT *
    FROM combos
    ORDER BY id
  `);

  const reviews = sqliteRows(`
    SELECT *
    FROM reviews
    ORDER BY id
  `);

  const orders = sqliteRows(`
    SELECT *
    FROM orders
    ORDER BY id
  `);

  const gallery = sqliteRows(`
    SELECT *
    FROM gallery
    ORDER BY id
  `);

  const galleryRemoved = sqliteRows(`
    SELECT *
    FROM gallery_removed
    ORDER BY file
  `);

  const admins = sqliteRows(`
    SELECT *
    FROM admins
    ORDER BY username
  `);

  console.log('Datos encontrados en SQLite:');
  console.log(`  Productos: ${products.length}`);
  console.log(`  Combos: ${combos.length}`);
  console.log(`  Reseñas: ${reviews.length}`);
  console.log(`  Pedidos: ${orders.length}`);
  console.log(`  Galería: ${gallery.length}`);
  console.log(
    `  Fotos ocultadas: ${galleryRemoved.length}`
  );
  console.log(`  Usuarios admin: ${admins.length}`);

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    /*
     * PostgreSQL todavía no es usado por la aplicación,
     * así que SQLite es la fuente oficial en esta migración.
     *
     * Se limpia el contenido semilla de PostgreSQL para
     * reemplazarlo por una copia exacta de SQLite.
     */
    await client.query(`
      TRUNCATE TABLE
        products,
        combos,
        reviews,
        orders,
        gallery,
        gallery_removed,
        admins
      RESTART IDENTITY
    `);

    for (const row of products) {
      await client.query(
        `
          INSERT INTO products (
            id,
            name,
            brand,
            category,
            presentation,
            flavors,
            price_retail,
            price_wholesale,
            stock,
            servings,
            serving_size,
            image,
            badges,
            tag,
            popularity,
            macros,
            benefits,
            usage,
            warnings,
            description,
            active,
            updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11, $12,
            $13, $14, $15, $16, $17, $18,
            $19, $20, $21, $22
          )
        `,
        [
          row.id,
          row.name,
          row.brand,
          row.category,
          row.presentation,
          row.flavors,
          row.price_retail,
          row.price_wholesale,
          row.stock,
          row.servings,
          row.serving_size,
          row.image,
          row.badges,
          row.tag,
          row.popularity,
          row.macros,
          row.benefits,
          row.usage,
          row.warnings,
          row.description,
          row.active,
          safeDate(row.updated_at),
        ]
      );
    }

    for (const row of combos) {
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
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          row.id,
          row.name,
          row.note,
          row.items,
          row.discount,
          row.active,
        ]
      );
    }

    for (const row of reviews) {
      await client.query(
        `
          INSERT INTO reviews (
            id,
            product,
            name,
            stars,
            text,
            created_at,
            status
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          row.id,
          row.product,
          row.name,
          row.stars,
          row.text,
          safeDate(row.created_at),
          row.status,
        ]
      );
    }

    for (const row of orders) {
      await client.query(
        `
          INSERT INTO orders (
            id,
            code,
            created_at,
            price_mode,
            customer_name,
            notes,
            lines,
            total,
            status
          )
          VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9
          )
        `,
        [
          row.id,
          row.code,
          safeDate(row.created_at),
          row.price_mode,
          row.customer_name,
          row.notes,
          row.lines,
          row.total,
          row.status,
        ]
      );
    }

    for (const row of gallery) {
      await client.query(
        `
          INSERT INTO gallery (
            id,
            file,
            alt,
            created_at
          )
          VALUES ($1, $2, $3, $4)
        `,
        [
          row.id,
          row.file,
          row.alt,
          safeDate(row.created_at),
        ]
      );
    }

    for (const row of galleryRemoved) {
      await client.query(
        `
          INSERT INTO gallery_removed (
            file,
            removed_at
          )
          VALUES ($1, $2)
        `,
        [
          row.file,
          safeDate(row.removed_at),
        ]
      );
    }

    /*
     * Se copian salt y hash exactamente.
     * NO se conoce, imprime ni modifica ninguna contraseña.
     */
    for (const row of admins) {
      await client.query(
        `
          INSERT INTO admins (
            username,
            salt,
            hash,
            role,
            active,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          row.username,
          row.salt,
          row.hash,
          row.role || 'admin',
          row.active ?? 1,
          safeDate(row.created_at),
        ]
      );
    }

    /*
     * Como reviews, orders y gallery usan Identity en
     * PostgreSQL, ajustamos las secuencias después de
     * insertar los IDs originales de SQLite.
     */
    await resetIdentity(client, 'reviews');
    await resetIdentity(client, 'orders');
    await resetIdentity(client, 'gallery');

    await client.query(
      `
        INSERT INTO app_migrations (
          name,
          executed_at
        )
        VALUES ($1, CURRENT_TIMESTAMP)
      `,
      [MIGRATION_KEY]
    );

    await client.query('COMMIT');

    console.log('');
    console.log(
      'Migración SQLite → PostgreSQL completada.'
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const verification = await Promise.all([
    pool.query(
      'SELECT COUNT(*)::integer AS n FROM products'
    ),
    pool.query(
      'SELECT COUNT(*)::integer AS n FROM combos'
    ),
    pool.query(
      'SELECT COUNT(*)::integer AS n FROM reviews'
    ),
    pool.query(
      'SELECT COUNT(*)::integer AS n FROM orders'
    ),
    pool.query(
      'SELECT COUNT(*)::integer AS n FROM gallery'
    ),
    pool.query(
      'SELECT COUNT(*)::integer AS n FROM gallery_removed'
    ),
    pool.query(
      'SELECT COUNT(*)::integer AS n FROM admins'
    ),
  ]);

  console.log('');
  console.log('Verificación PostgreSQL:');
  console.log(
    `  Productos: ${verification[0].rows[0].n}`
  );
  console.log(
    `  Combos: ${verification[1].rows[0].n}`
  );
  console.log(
    `  Reseñas: ${verification[2].rows[0].n}`
  );
  console.log(
    `  Pedidos: ${verification[3].rows[0].n}`
  );
  console.log(
    `  Galería: ${verification[4].rows[0].n}`
  );
  console.log(
    `  Fotos ocultadas: ${verification[5].rows[0].n}`
  );
  console.log(
    `  Usuarios admin: ${verification[6].rows[0].n}`
  );
}

try {
  await migrate();
} catch (error) {
  console.error(
    'Error migrando SQLite → PostgreSQL:',
    error
  );

  process.exitCode = 1;
} finally {
  sqlite.close();
  await pool.end();
}