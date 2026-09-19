const { trace } = require('../telemetry');

// Thin wrapper so repositories never touch the driver directly.
function createPool(databaseUrl, driver) {
  trace('db.pool.create', {});
  return { url: databaseUrl, driver, active: 0 };
}

async function query(pool, sql, params) {
  trace('db.query', { sql: sql.slice(0, 40) });
  pool.active++;
  try {
    return await pool.driver.query(sql, params || []);
  } finally {
    pool.active--;
  }
}

async function withTransaction(pool, work) {
  await query(pool, 'BEGIN');
  try {
    const result = await work((sql, params) => query(pool, sql, params));
    await query(pool, 'COMMIT');
    return result;
  } catch (err) {
    await query(pool, 'ROLLBACK');
    throw err;
  }
}

module.exports = { createPool, query, withTransaction };
