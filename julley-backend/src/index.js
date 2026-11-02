import { startNode } from './app.js';
import { pool } from './db/pool.js';

const RETRY_MS = 1000;
const MAX_ATTEMPTS = 60;

// In development the database may still be booting when the API starts.
async function waitForDatabase() {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await pool.query('SELECT 1 FROM organizations LIMIT 1');
      return;
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
}

await waitForDatabase();
const node = await startNode();
console.log(`[api] listening on http://localhost:${node.port}`);

async function shutdown() {
  await node.stop().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
