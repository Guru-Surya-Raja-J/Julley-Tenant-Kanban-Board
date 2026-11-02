import pg from 'pg';
import { config } from '../config.js';

// Bigint columns (event sequence numbers) stay well inside the safe integer range.
pg.types.setTypeParser(pg.types.builtins.INT8, Number);
// Keep DATE as 'YYYY-MM-DD' rather than a timezone-shifted Date.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => console.error('[db] idle client error', err.message));

const RETRYABLE = new Set(['40P01', '40001']); // deadlock_detected, serialization_failure
const MAX_ATTEMPTS = 4;

async function runTransaction(settings, fn, isolation) {
  const client = await pool.connect();
  try {
    await client.query(isolation ? `BEGIN ISOLATION LEVEL ${isolation}` : 'BEGIN');
    // set_config(..., true) is transaction-local, so nothing leaks to the next
    // request that borrows this pooled connection.
    await client.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.org_id', $2, true),
              set_config('app.tenant_id', $3, true)`,
      [settings.userId ?? '', settings.orgId ?? '', settings.tenantId ?? ''],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function transaction(settings, fn, { isolation } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await runTransaction(settings, fn, isolation);
    } catch (err) {
      if (!RETRYABLE.has(err.code) || attempt >= MAX_ATTEMPTS) throw err;
      const delay = 20 * 2 ** attempt + Math.random() * 50;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
