import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

/** Starts a real PostgreSQL server from the npm binaries. Development and tests only. */
export async function startEmbeddedPostgres({ dir, port, persistent = true, database = 'kanban' }) {
  const server = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent,
    onLog: () => {},
    onError: (message) => {
      const text = String(message);
      if (/FATAL|PANIC/.test(text)) console.error('[postgres]', text.trim());
    },
  });

  const initialised = await stat(join(dir, 'PG_VERSION')).then(() => true, () => false);
  if (!initialised) {
    await mkdir(dir, { recursive: true });
    await server.initialise();
  }
  await server.start();

  const client = server.getPgClient();
  await client.connect();
  const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
  await client.end();
  if (!rowCount) await server.createDatabase(database);

  return server;
}
