import { config } from '../config.js';
import { startEmbeddedPostgres } from './embedded.js';
import { migrate } from './migrate.js';
import { seed } from './seed.js';

// Real PostgreSQL with no install, started by `npm start`. Kept apart from the API
// process so that nodemon restarts don't restart the database.
const { port } = new URL(config.ownerDatabaseUrl);

const server = await startEmbeddedPostgres({ dir: config.devDatabaseDir, port: Number(port) });
await migrate();
await seed();
console.log(`[db] PostgreSQL ready on port ${port}`);

async function shutdown() {
  await server.stop().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
