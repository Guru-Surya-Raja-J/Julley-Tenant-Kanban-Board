// Starts a throwaway PostgreSQL, migrates it, then runs the suites against it.
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 54331;
const here = dirname(fileURLToPath(import.meta.url));

Object.assign(process.env, {
  DATABASE_URL: `postgres://kanban_app:kanban_app@localhost:${PORT}/kanban`,
  OWNER_DATABASE_URL: `postgres://postgres:postgres@localhost:${PORT}/kanban`,
  JWT_SECRET: 'test-secret',
  AUTH_RATE_LIMIT: '100000',
  // Low enough that ordinary test traffic exercises rebalancing.
  REBALANCE_KEY_LENGTH: '8',
  MAX_REPLAY_EVENTS: '20',
  PRESENCE_HEARTBEAT_MS: '300',
  PRESENCE_TTL_MS: '1000',
});

const { startEmbeddedPostgres } = await import('../src/db/embedded.js');
const { migrate } = await import('../src/db/migrate.js');

const dir = await mkdtemp(join(tmpdir(), 'tenant-flow-test-'));
const server = await startEmbeddedPostgres({ dir, port: PORT, persistent: false });

let exitCode;
try {
  await migrate();
  const filter = process.argv.slice(2);
  const files = (await readdir(here))
    .filter((file) => file.endsWith('.test.js'))
    .filter((file) => !filter.length || filter.some((f) => file.includes(f)))
    .map((file) => join(here, file));

  exitCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
} finally {
  await server.stop().catch(() => {});
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
process.exit(exitCode);
