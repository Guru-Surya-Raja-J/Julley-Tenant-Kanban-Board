// Measures the claims in the README against a throwaway PostgreSQL. `npm run bench`.
// Load generator and server share one Node process, so read these as a conservative
// lower bound for a single node, and compare them with each other more than absolutely.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 54333;
Object.assign(process.env, {
  DATABASE_URL: `postgres://kanban_app:kanban_app@localhost:${PORT}/kanban`,
  OWNER_DATABASE_URL: `postgres://postgres:postgres@localhost:${PORT}/kanban`,
  JWT_SECRET: 'bench-secret',
  AUTH_RATE_LIMIT: '100000',
});

const { startEmbeddedPostgres } = await import('../src/db/embedded.js');
const { migrate } = await import('../src/db/migrate.js');
const { startNode } = await import('../src/app.js');
const { pool } = await import('../src/db/pool.js');
const { default: WebSocket } = await import('ws');

const WRITERS = 32;
const OPS = 3000;

const dir = await mkdtemp(join(tmpdir(), 'tenant-flow-bench-'));
const database = await startEmbeddedPostgres({ dir, port: PORT, persistent: false });
await migrate();
const node = await startNode({ port: 0 });
const base = `http://localhost:${node.port}/api`;

async function call(token, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const { body: auth } = await call(null, 'POST', '/auth/register', { email: 'bench@test.dev', name: 'Bench', password: 'password123' });
const { token } = auth;
const { body: { organization } } = await call(token, 'POST', '/organizations', { name: 'Bench Org' });

async function makeTenant(name, cards) {
  const { body: { tenant } } = await call(token, 'POST', `/organizations/${organization.id}/tenants`, { name });
  const { body: { columns } } = await call(token, 'POST', `/tenants/${tenant.id}/boards`, { name: 'Board', columns: ['A', 'B'] });
  const tasks = [];
  for (let i = 0; i < cards; i += 1) {
    const { body } = await call(token, 'POST', `/tenants/${tenant.id}/tasks`, { columnId: columns[0].id, title: `Card ${i}` });
    tasks.push(body.task);
  }
  return { id: tenant.id, columns, tasks, flip: 1 };
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

/** Moves cards between columns from WRITERS concurrent clients across the given tenants. */
async function moveLoad(tenants) {
  let next = 0;
  let errors = 0;
  const latencies = [];
  const started = performance.now();
  await Promise.all(
    Array.from({ length: WRITERS }, async () => {
      for (;;) {
        const op = next;
        next += 1;
        if (op >= OPS) return;
        const tenant = tenants[op % tenants.length];
        const task = tenant.tasks[op % tenant.tasks.length];
        const column = tenant.columns[op % 2];
        const begin = performance.now();
        const { status } = await call(token, 'POST', `/tenants/${tenant.id}/tasks/${task.id}/move`, { columnId: column.id, baseVersion: 0 });
        latencies.push(performance.now() - begin);
        if (status !== 200) errors += 1;
      }
    }),
  );
  const seconds = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  return {
    throughput: Math.round(OPS / seconds),
    p50: percentile(latencies, 0.5).toFixed(0),
    p95: percentile(latencies, 0.95).toFixed(0),
    p99: percentile(latencies, 0.99).toFixed(0),
    errors,
  };
}

/** Commit-to-socket latency for one write, seen by every subscriber of the tenant. */
async function fanout(tenant, subscribers, writes) {
  const sockets = await Promise.all(
    Array.from({ length: subscribers }, () =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${node.port}/ws`);
        ws.once('error', reject);
        ws.once('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
        ws.on('message', (raw) => {
          const message = JSON.parse(raw);
          if (message.type === 'auth.ok') ws.send(JSON.stringify({ type: 'subscribe', tenantId: tenant.id }));
          if (message.type === 'subscribed') resolve(ws);
        });
      }),
    ),
  );

  const latencies = [];
  for (let i = 0; i < writes; i += 1) {
    const task = tenant.tasks[i % tenant.tasks.length];
    const arrived = sockets.map(
      (ws) =>
        new Promise((resolve) => {
          const onMessage = (raw) => {
            const message = JSON.parse(raw);
            if (message.type === 'event' && message.event.entityId === task.id) {
              ws.off('message', onMessage);
              resolve(performance.now());
            }
          };
          ws.on('message', onMessage);
        }),
    );
    const begin = performance.now();
    await call(token, 'POST', `/tenants/${tenant.id}/tasks/${task.id}/move`, { columnId: tenant.columns[i % 2].id, baseVersion: 0 });
    for (const time of await Promise.all(arrived)) latencies.push(time - begin);
  }
  for (const ws of sockets) ws.terminate();
  latencies.sort((a, b) => a - b);
  return { p50: percentile(latencies, 0.5).toFixed(0), p95: percentile(latencies, 0.95).toFixed(0), p99: percentile(latencies, 0.99).toFixed(0) };
}

console.log(`Setting up. ${WRITERS} concurrent writers, ${OPS} moves per scenario.\n`);
const one = [await makeTenant('Solo', 100)];
const many = [];
for (let i = 0; i < 8; i += 1) many.push(await makeTenant(`Branch ${i}`, 25));

console.log('Write load (card moves through the full stack: auth, RLS, locks, event log, notify)');
console.log('scenario        moves/s   p50 ms   p95 ms   p99 ms   errors');
const print = (label, r) =>
  console.log(`${label.padEnd(15)} ${String(r.throughput).padStart(7)} ${r.p50.padStart(8)} ${r.p95.padStart(8)} ${r.p99.padStart(8)} ${String(r.errors).padStart(8)}`);
print('1 tenant', await moveLoad(one));
print('8 tenants', await moveLoad(many));

console.log('\nFan-out (write sent, until a subscriber has the event)');
console.log('subscribers     p50 ms   p95 ms   p99 ms');
for (const count of [1, 50, 200]) {
  const r = await fanout(one[0], count, 100);
  console.log(`${String(count).padEnd(15)} ${r.p50.padStart(6)} ${r.p95.padStart(8)} ${r.p99.padStart(8)}`);
}

await node.stop();
await pool.end();
await database.stop().catch(() => {});
await rm(dir, { recursive: true, force: true }).catch(() => {});
process.exit(0);
