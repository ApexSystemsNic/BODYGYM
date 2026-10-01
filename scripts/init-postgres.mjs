import {
  pool,
  testPostgresConnection,
} from '../server/postgres.js';

import {
  initPostgresSchema,
} from '../server/postgres-schema.js';

import {
  seedPostgresIfEmpty,
} from '../server/postgres-seed.js';

try {
  const connection =
    await testPostgresConnection();

  console.log(
    `Conectado a PostgreSQL: ${connection.database}`
  );

  console.log(
    `Hora del servidor PostgreSQL: ${connection.now}`
  );

  await initPostgresSchema();

  console.log(
    'Esquema PostgreSQL creado/verificado.'
  );

  await seedPostgresIfEmpty();

  const products = await pool.query(`
    SELECT COUNT(*)::integer AS n
    FROM products
  `);

  const combos = await pool.query(`
    SELECT COUNT(*)::integer AS n
    FROM combos
  `);

  const reviews = await pool.query(`
    SELECT COUNT(*)::integer AS n
    FROM reviews
  `);

  const orders = await pool.query(`
    SELECT COUNT(*)::integer AS n
    FROM orders
  `);

  console.log(
    `Productos en PostgreSQL: ${products.rows[0].n}`
  );

  console.log(
    `Combos en PostgreSQL: ${combos.rows[0].n}`
  );

  console.log(
    `Reseñas en PostgreSQL: ${reviews.rows[0].n}`
  );

  console.log(
    `Pedidos en PostgreSQL: ${orders.rows[0].n}`
  );

  console.log(
    'Inicialización PostgreSQL completada correctamente.'
  );
} catch (error) {
  console.error(
    'Error inicializando PostgreSQL:',
    error
  );

  process.exitCode = 1;
} finally {
  await pool.end();
}