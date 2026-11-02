// Bot teammates working on a real board through the real API, so one person with one
// browser window can watch live sync and conflict handling.
//
//   npm start               (in another terminal)
//   npm run simulate        (then watch Warehouse rollout, Mumbai, in the browser)
//   npm run simulate -- 40  (more rounds)
import { randomUUID } from 'node:crypto';

const API = process.env.API_URL ?? 'http://localhost:4000/api';
const ROUNDS = Number(process.argv[2] ?? 20);
const PAUSE_MS = 1500;
const PASSWORD = 'password123';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pick = (list) => list[Math.floor(Math.random() * list.length)];

async function call(token, method, path, body, key) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function signIn(email) {
  const { status, body } = await call(null, 'POST', '/auth/login', { email, password: PASSWORD });
  if (status !== 200) throw new Error(`Couldn't sign in as ${email}. Is the seeded backend running? (${status})`);
  return { name: body.user.name.split(' ')[0], token: body.token };
}

let ben;
try {
  ben = await signIn('ben@acme.test');
} catch (err) {
  console.error(err.cause ? `Can't reach ${API}. Start the backend first with npm start.` : err.message);
  process.exit(1);
}
const cara = await signIn('cara@acme.test');
const alice = await signIn('alice@acme.test');
const team = [ben, cara, alice];

const { body: { organizations } } = await call(ben.token, 'GET', '/organizations');
const { body: { tenants } } = await call(ben.token, 'GET', `/organizations/${organizations[0].id}/tenants`);
const tenant = tenants.find((t) => t.name === 'Mumbai') ?? tenants[0];
const base = `/tenants/${tenant.id}`;
const { body: { boards } } = await call(ben.token, 'GET', `${base}/boards`);
const board = boards.find((b) => b.name === 'Warehouse rollout') ?? boards[0];
console.log(`Working on "${board.name}" in ${tenant.name}. Watch it in the browser.\n`);

const snapshot = async () => (await call(ben.token, 'GET', `${base}/boards/${board.id}`)).body;

async function randomMove({ tasks, columns }) {
  const task = pick(tasks);
  const user = pick(team);
  const column = pick(columns.filter((c) => c.id !== task.columnId));
  const { status } = await call(user.token, 'POST', `${base}/tasks/${task.id}/move`, { columnId: column.id, baseVersion: task.version });
  console.log(`  ${user.name} moved "${task.title}" to ${column.name}: ${status}`);
}

async function addCard({ columns }) {
  const user = pick(team);
  const column = pick(columns);
  const title = pick(['Check pallet labels', 'Recount aisle 7', 'Call the carrier', 'Update the shift rota', 'Test the backup scanner']);
  const { status } = await call(user.token, 'POST', `${base}/tasks`, { columnId: column.id, title });
  console.log(`  ${user.name} added "${title}": ${status}`);
}

async function mergeEdits({ tasks }) {
  const task = pick(tasks);
  const [a, b] = await Promise.all([
    call(ben.token, 'PATCH', `${base}/tasks/${task.id}`, { patch: { priority: pick(['high', 'medium', 'low']) }, baseVersion: task.version }),
    call(cara.token, 'PATCH', `${base}/tasks/${task.id}`, { patch: { description: `Checked ${new Date().toLocaleTimeString()}` }, baseVersion: task.version }),
  ]);
  console.log(`  Ben and Cara edited different fields of "${task.title}" at once: ${a.status}, ${b.status} (both merge)`);
}

async function dragRace({ tasks, columns }) {
  const task = pick(tasks);
  const targets = columns.filter((c) => c.id !== task.columnId);
  if (targets.length < 2) return;
  const [a, b] = await Promise.all([
    call(ben.token, 'POST', `${base}/tasks/${task.id}/move`, { columnId: targets[0].id, baseVersion: task.version }),
    call(cara.token, 'POST', `${base}/tasks/${task.id}/move`, { columnId: targets[1].id, baseVersion: task.version }),
  ]);
  console.log(`  Ben and Cara dragged "${task.title}" at once: Ben ${a.status}, Cara ${b.status} (first write wins)`);
}

async function lostResponse({ tasks, columns }) {
  const task = pick(tasks);
  const column = pick(columns.filter((c) => c.id !== task.columnId));
  const key = randomUUID();
  const body = { columnId: column.id, baseVersion: task.version };
  const first = await call(alice.token, 'POST', `${base}/tasks/${task.id}/move`, body, key);
  const retry = await call(alice.token, 'POST', `${base}/tasks/${task.id}/move`, body, key);
  console.log(`  Alice retried a move as if the response was lost: version ${first.body.task?.version} both times? ${first.body.task?.version === retry.body.task?.version}`);
}

const ACTIONS = [randomMove, randomMove, randomMove, addCard, mergeEdits, dragRace, lostResponse];

for (let round = 1; round <= ROUNDS; round += 1) {
  const current = await snapshot();
  if (current.tasks.length) await pick(ACTIONS)(current);
  else await addCard(current);
  await sleep(PAUSE_MS);
}

// Whatever just happened, these must hold.
const final = await snapshot();
const positions = final.tasks.map((t) => `${t.columnId}:${t.position}`);
const { body: { events } } = await call(ben.token, 'GET', `${base}/activity?limit=100`);
const seqs = events.map((e) => e.seq);
console.log('\nInvariants after the run:');
console.log(`  no two cards share a position: ${new Set(positions).size === positions.length}`);
console.log(`  event sequence has no gaps:    ${seqs.every((seq, i) => i === 0 || seq === seqs[i - 1] - 1)}`);
