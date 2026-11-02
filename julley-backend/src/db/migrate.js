import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { config } from '../config.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

function quoteLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function ensureAppRole(client) {
  const url = new URL(config.databaseUrl);
  const role = decodeURIComponent(url.username);
  if (role !== 'kanban_app') {
    throw new Error(`DATABASE_URL must connect as kanban_app (got "${role}")`);
  }
  const password = quoteLiteral(decodeURIComponent(url.password));
  // NOBYPASSRLS and non-owner: row-level security always applies to this role.
  const { rowCount } = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = 'kanban_app'`);
  const verb = rowCount ? 'ALTER' : 'CREATE';
  await client.query(`${verb} ROLE kanban_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${password}`);
}

export async function migrate() {
  const client = new pg.Client({ connectionString: config.ownerDatabaseUrl });
  await client.connect();
  try {
    // Serializes migration runs when several instances boot together.
    await client.query('SELECT pg_advisory_lock(727001)');
    await ensureAppRole(client);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[migrate] applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
