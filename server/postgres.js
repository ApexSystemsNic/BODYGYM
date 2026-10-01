import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('Falta DATABASE_URL para conectar PostgreSQL.');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function queryOne(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows[0] ?? null;
}

export async function queryAll(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

export async function execute(sql, params = []) {
  const result = await pool.query(sql, params);

  return {
    changes: result.rowCount,
    rows: result.rows,
  };
}

export async function transaction(fn) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await fn(client);

    await client.query('COMMIT');

    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function testPostgresConnection() {
  const result = await pool.query(`
    SELECT
      NOW() AS now,
      current_database() AS database
  `);

  return result.rows[0];
}