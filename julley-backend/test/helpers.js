import { randomUUID } from 'node:crypto';
import pg from 'pg';
import WebSocket from 'ws';
import { startNode } from '../src/app.js';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';

export { pool };

let counter = 0;

/** A small API client bound to one user. Never throws on HTTP errors. */
export function clientFor(baseUrl, token) {
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(`${baseUrl}/api${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return {
    token,
    get: (path) => call('GET', path),
    post: (path, body, headers) => call('POST', path, body ?? {}, headers),
    patch: (path, body, headers) => call('PATCH', path, body, headers),
    del: (path, headers) => call('DELETE', path, undefined, headers),
  };
}

export async function startTestNode() {
  const node = await startNode({ port: 0 });
  return { ...node, baseUrl: `http://localhost:${node.port}`, wsUrl: `ws://localhost:${node.port}/ws` };
}

export async function registerUser(baseUrl, name = 'User') {
  counter += 1;
  const email = `${name.toLowerCase().replaceAll(' ', '.')}.${counter}.${randomUUID().slice(0, 8)}@test.dev`;
  const res = await clientFor(baseUrl).post('/auth/register', { email, name, password: 'password123' });
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  return { ...clientFor(baseUrl, res.body.token), user: res.body.user, email };
}

/**
 * Builds: org -> tenant -> board (3 columns), with an org admin, a tenant admin and
 * a member. Each call makes a fresh, unrelated world.
 */
export async function createWorld(baseUrl, label = 'World') {
  const orgAdmin = await registerUser(baseUrl, `${label} OrgAdmin`);
  const tenantAdmin = await registerUser(baseUrl, `${label} TenantAdmin`);
  const member = await registerUser(baseUrl, `${label} Member`);

  const org = (await orgAdmin.post('/organizations', { name: `${label} Org` })).body.organization;
  const tenant = (await orgAdmin.post(`/organizations/${org.id}/tenants`, { name: `${label} Branch` })).body.tenant;
  await orgAdmin.post(`/tenants/${tenant.id}/members`, { email: tenantAdmin.email, role: 'tenant_admin' });
  await orgAdmin.post(`/tenants/${tenant.id}/members`, { email: member.email, role: 'member' });

  const created = (await orgAdmin.post(`/tenants/${tenant.id}/boards`, { name: `${label} Board` })).body;
  return { org, tenant, board: created.board, columns: created.columns, orgAdmin, tenantAdmin, member };
}

export async function createTask(client, tenantId, columnId, title = 'Task', extra = {}) {
  const res = await client.post(`/tenants/${tenantId}/tasks`, { columnId, title, ...extra });
  if (res.status !== 201) throw new Error(`createTask failed: ${JSON.stringify(res.body)}`);
  return res.body.task;
}

export async function orderedTitles(client, tenantId, boardId, columnId) {
  const { body } = await client.get(`/tenants/${tenantId}/boards/${boardId}`);
  return body.tasks.filter((task) => task.columnId === columnId).map((task) => task.title);
}

/** A connection as the API role (RLS applies), for testing the database directly. */
export async function appRoleClient() {
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  return client;
}

/** A WebSocket with an inbox that tests can wait on. */
export async function connectSocket(wsUrl, token) {
  const ws = new WebSocket(wsUrl);
  const inbox = [];
  const waiters = [];

  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    inbox.push(message);
    for (const waiter of [...waiters]) waiter();
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const socket = {
    ws,
    inbox,
    send: (message) => ws.send(JSON.stringify(message)),
    /** Resolves with the first inbox message matching predicate, consuming nothing. */
    waitFor(predicate, timeoutMs = 3000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const found = inbox.find(predicate);
          if (found) {
            cleanup();
            resolve(found);
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`timed out waiting; inbox: ${JSON.stringify(inbox.map((m) => m.type))}`));
        }, timeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          waiters.splice(waiters.indexOf(check), 1);
        };
        waiters.push(check);
        check();
      });
    },
    waitForEvent(action, timeoutMs) {
      return socket.waitFor((m) => m.type === 'event' && m.event.action === action, timeoutMs);
    },
    events: () => inbox.filter((m) => m.type === 'event').map((m) => m.event),
    close: () => ws.terminate(),
  };

  if (token) {
    socket.send({ type: 'auth', token });
    await socket.waitFor((m) => m.type === 'auth.ok');
  }
  return socket;
}

export async function subscribe(socket, tenantId, lastSeq) {
  socket.send({ type: 'subscribe', tenantId, lastSeq });
  return socket.waitFor((m) => m.type === 'subscribed' && m.tenantId === tenantId);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const shutdown = async (...nodes) => {
  for (const node of nodes) await node.stop();
  await pool.end();
};
