import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { pool } from '../src/db/pool.js';
import { connectSocket, createTask, createWorld, sleep, startTestNode, subscribe } from './helpers.js';

describe('realtime', () => {
  let node;
  let nodeTwo;
  let acme;
  let globex;

  before(async () => {
    node = await startTestNode();
    nodeTwo = await startTestNode();
    acme = await createWorld(node.baseUrl, 'Acme');
    globex = await createWorld(node.baseUrl, 'Globex');
  });

  after(async () => {
    await node.stop();
    await nodeTwo.stop();
    await pool.end();
  });

  describe('authentication', () => {
    it('closes the socket on a bad token', async () => {
      const socket = await connectSocket(node.wsUrl);
      const closed = new Promise((resolve) => socket.ws.once('close', resolve));
      socket.send({ type: 'auth', token: 'garbage' });
      assert.equal(await closed, 4401);
    });

    it('refuses to subscribe before auth', async () => {
      const socket = await connectSocket(node.wsUrl);
      socket.send({ type: 'subscribe', tenantId: acme.tenant.id });
      const reply = await socket.waitFor((m) => m.type === 'error');
      assert.equal(reply.code, 'UNAUTHORIZED');
      socket.close();
    });

    it('survives malformed messages', async () => {
      const socket = await connectSocket(node.wsUrl, acme.member.token);
      socket.ws.send('this is not json');
      const reply = await socket.waitFor((m) => m.type === 'error');
      assert.equal(reply.code, 'BAD_MESSAGE');
      socket.send({ type: 'ping' });
      await socket.waitFor((m) => m.type === 'pong');
      socket.close();
    });
  });

  describe('channel scoping', () => {
    it("refuses a subscription to another organization's tenant", async () => {
      const socket = await connectSocket(node.wsUrl, acme.member.token);
      socket.send({ type: 'subscribe', tenantId: globex.tenant.id });
      const reply = await socket.waitFor((m) => m.type === 'error');
      assert.equal(reply.code, 'NOT_FOUND');
      assert.ok(!socket.inbox.some((m) => m.type === 'subscribed'));
      socket.close();
    });

    it("delivers a tenant's events only to that tenant's subscribers", async () => {
      const acmeSocket = await connectSocket(node.wsUrl, acme.member.token);
      const globexSocket = await connectSocket(node.wsUrl, globex.member.token);
      await subscribe(acmeSocket, acme.tenant.id);
      await subscribe(globexSocket, globex.tenant.id);

      await createTask(acme.tenantAdmin, acme.tenant.id, acme.columns[0].id, 'Acme confidential');
      const { event } = await acmeSocket.waitForEvent('task.created');
      assert.equal(event.payload.task.title, 'Acme confidential');
      assert.equal(event.actor.id, acme.tenantAdmin.user.id);

      await sleep(150);
      assert.equal(globexSocket.events().length, 0);
      assert.ok(!JSON.stringify(globexSocket.inbox).includes('Acme confidential'));
      acmeSocket.close();
      globexSocket.close();
    });

    it("isolates sibling tenants within one organization", async () => {
      const sibling = (await acme.orgAdmin.post(`/organizations/${acme.org.id}/tenants`, { name: 'Sibling' })).body.tenant;
      const socket = await connectSocket(node.wsUrl, acme.member.token);
      await subscribe(socket, acme.tenant.id);
      socket.send({ type: 'subscribe', tenantId: sibling.id });
      const reply = await socket.waitFor((m) => m.type === 'error');
      assert.equal(reply.code, 'NOT_FOUND');
      socket.close();
    });

    it('leaves the old channel when subscribing to another tenant', async () => {
      const second = (await acme.orgAdmin.post(`/organizations/${acme.org.id}/tenants`, { name: 'Switch' })).body.tenant;
      const socket = await connectSocket(node.wsUrl, acme.orgAdmin.token);
      await subscribe(socket, acme.tenant.id);
      await subscribe(socket, second.id);
      const before = socket.events().length;
      await createTask(acme.member, acme.tenant.id, acme.columns[0].id, 'While away');
      await sleep(150);
      assert.equal(socket.events().length, before);
      socket.close();
    });
  });

  describe('delivery', () => {
    it('broadcasts every kind of task change in order, with the op id', async () => {
      const socket = await connectSocket(node.wsUrl, acme.member.token);
      const start = await subscribe(socket, acme.tenant.id);
      const task = await createTask(acme.tenantAdmin, acme.tenant.id, acme.columns[0].id, 'Lifecycle');
      const path = `/tenants/${acme.tenant.id}/tasks/${task.id}`;
      await acme.tenantAdmin.patch(path, { patch: { title: 'Renamed' }, baseVersion: 1 }, { 'idempotency-key': 'op-rename' });
      await acme.tenantAdmin.post(`${path}/move`, { columnId: acme.columns[1].id, baseVersion: 2 });
      await acme.tenantAdmin.del(path);
      await socket.waitForEvent('task.deleted');

      const events = socket.events();
      assert.deepEqual(events.map((e) => e.action), ['task.created', 'task.updated', 'task.moved', 'task.deleted']);
      assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4].map((n) => start.seq + n));
      assert.equal(events[1].opId, 'op-rename');
      assert.deepEqual(events[1].payload.changes.title, { from: 'Lifecycle', to: 'Renamed' });
      socket.close();
    });

    it('a failed write produces no event', async () => {
      const task = await createTask(acme.tenantAdmin, acme.tenant.id, acme.columns[0].id, 'Quiet');
      await acme.tenantAdmin.patch(`/tenants/${acme.tenant.id}/tasks/${task.id}`, { patch: { title: 'A' }, baseVersion: 1 });
      const socket = await connectSocket(node.wsUrl, acme.member.token);
      await subscribe(socket, acme.tenant.id);
      const res = await acme.member.patch(`/tenants/${acme.tenant.id}/tasks/${task.id}`, { patch: { title: 'B' }, baseVersion: 1 });
      assert.equal(res.status, 409);
      await sleep(150);
      assert.equal(socket.events().length, 0);
      socket.close();
    });

    it('delivers across nodes: write on one server, receive on the other', async () => {
      const onSecondNode = await connectSocket(nodeTwo.wsUrl, acme.member.token);
      await subscribe(onSecondNode, acme.tenant.id);
      await createTask(acme.tenantAdmin, acme.tenant.id, acme.columns[0].id, 'Across nodes');
      const { event } = await onSecondNode.waitForEvent('task.created');
      assert.equal(event.payload.task.title, 'Across nodes');
      onSecondNode.close();
    });

    it('keeps order through a burst', async () => {
      const socket = await connectSocket(nodeTwo.wsUrl, acme.member.token);
      const start = await subscribe(socket, acme.tenant.id);
      await Promise.all(
        Array.from({ length: 20 }, (_, i) => createTask(acme.tenantAdmin, acme.tenant.id, acme.columns[2].id, `Burst ${i}`)),
      );
      await socket.waitFor(() => socket.events().length >= 20, 5000);
      const seqs = socket.events().map((e) => e.seq);
      assert.deepEqual(seqs, Array.from({ length: 20 }, (_, i) => start.seq + 1 + i));
      socket.close();
    });
  });

  describe('network recovery', () => {
    it('replays exactly what was missed after a reconnect', async () => {
      const first = await connectSocket(node.wsUrl, acme.member.token);
      const { seq } = await subscribe(first, acme.tenant.id);
      first.close();

      await createTask(acme.tenantAdmin, acme.tenant.id, acme.columns[0].id, 'Missed 1');
      await createTask(acme.tenantAdmin, acme.tenant.id, acme.columns[0].id, 'Missed 2');

      const second = await connectSocket(node.wsUrl, acme.member.token);
      await subscribe(second, acme.tenant.id, seq);
      await second.waitFor(() => second.events().length >= 2);
      assert.deepEqual(second.events().map((e) => e.payload.task.title), ['Missed 1', 'Missed 2']);
      assert.deepEqual(second.events().map((e) => e.seq), [seq + 1, seq + 2]);

      await createTask(acme.tenantAdmin, acme.tenant.id, acme.columns[0].id, 'Live again');
      await second.waitFor(() => second.events().length >= 3);
      assert.equal(second.events()[2].seq, seq + 3);
      second.close();
    });

    it('can replay on a different node than the original', async () => {
      const first = await connectSocket(node.wsUrl, acme.member.token);
      const { seq } = await subscribe(first, acme.tenant.id);
      first.close();
      await createTask(acme.tenantAdmin, acme.tenant.id, acme.columns[0].id, 'Other node');
      const second = await connectSocket(nodeTwo.wsUrl, acme.member.token);
      await subscribe(second, acme.tenant.id, seq);
      await second.waitFor(() => second.events().length >= 1);
      assert.equal(second.events()[0].payload.task.title, 'Other node');
      second.close();
    });

    it('sends nothing to replay when the client is up to date', async () => {
      const first = await connectSocket(node.wsUrl, acme.member.token);
      const { seq } = await subscribe(first, acme.tenant.id);
      first.close();
      const second = await connectSocket(node.wsUrl, acme.member.token);
      await subscribe(second, acme.tenant.id, seq);
      await sleep(100);
      assert.equal(second.events().length, 0);
      second.close();
    });

    it('asks for a full resync when too far behind (limit is 20 in tests)', async () => {
      const first = await connectSocket(node.wsUrl, acme.member.token);
      const { seq } = await subscribe(first, acme.tenant.id);
      first.close();
      for (let i = 0; i < 25; i += 1) {
        await createTask(acme.tenantAdmin, acme.tenant.id, acme.columns[0].id, `Far ${i}`);
      }
      const second = await connectSocket(node.wsUrl, acme.member.token);
      await subscribe(second, acme.tenant.id, seq);
      const reply = await second.waitFor((m) => m.type === 'resync.required');
      assert.equal(reply.seq, seq + 25);
      assert.equal(second.events().length, 0);
      second.close();
    });

    it('asks for a resync when the client is somehow ahead of the server', async () => {
      const socket = await connectSocket(node.wsUrl, acme.member.token);
      const { seq } = await subscribe(socket, acme.tenant.id);
      await subscribe(socket, globex.tenant.id).catch(() => {});
      socket.send({ type: 'subscribe', tenantId: acme.tenant.id, lastSeq: seq + 1000 });
      await socket.waitFor((m) => m.type === 'resync.required');
      socket.close();
    });

    it('a snapshot plus "events after its seq" reproduces the live state', async () => {
      const socket = await connectSocket(node.wsUrl, acme.member.token);
      await subscribe(socket, acme.tenant.id);
      await createTask(acme.tenantAdmin, acme.tenant.id, acme.columns[0].id, 'Before snapshot');
      const snapshot = (await acme.member.get(`/tenants/${acme.tenant.id}/boards/${acme.board.id}`)).body;
      await createTask(acme.tenantAdmin, acme.tenant.id, acme.columns[0].id, 'After snapshot');
      await socket.waitFor(() => socket.events().some((e) => e.payload.task?.title === 'After snapshot'));

      const titles = snapshot.tasks.map((t) => t.title);
      assert.ok(titles.includes('Before snapshot'));
      assert.ok(!titles.includes('After snapshot'));
      const newer = socket.events().filter((e) => e.seq > snapshot.seq);
      assert.deepEqual(newer.map((e) => e.payload.task.title), ['After snapshot']);
      socket.close();
    });
  });

  describe('access changes', () => {
    it('removes a member from the channel the moment they lose access', async () => {
      const world = await createWorld(node.baseUrl, 'Revoke');
      const socket = await connectSocket(node.wsUrl, world.member.token);
      await subscribe(socket, world.tenant.id);

      const { body } = await world.tenantAdmin.get(`/tenants/${world.tenant.id}/members`);
      const row = body.members.find((m) => m.userId === world.member.user.id);
      await world.tenantAdmin.del(`/tenants/${world.tenant.id}/members/${row.id}`);

      await socket.waitFor((m) => m.type === 'subscription.revoked');
      const countAfterRevoke = socket.events().length;
      await createTask(world.tenantAdmin, world.tenant.id, world.columns[0].id, 'After removal');
      await sleep(150);
      assert.equal(socket.events().length, countAfterRevoke);
      assert.ok(!JSON.stringify(socket.inbox).includes('After removal'));
      socket.close();
    });

    it('revokes across nodes too', async () => {
      const world = await createWorld(node.baseUrl, 'RevokeTwo');
      const socket = await connectSocket(nodeTwo.wsUrl, world.member.token);
      await subscribe(socket, world.tenant.id);
      const { body } = await world.tenantAdmin.get(`/tenants/${world.tenant.id}/members`);
      const row = body.members.find((m) => m.userId === world.member.user.id);
      await world.tenantAdmin.del(`/tenants/${world.tenant.id}/members/${row.id}`);
      await socket.waitFor((m) => m.type === 'subscription.revoked');
      socket.close();
    });

    it('drops subscribers when the tenant is deleted', async () => {
      const world = await createWorld(node.baseUrl, 'Deleted');
      const socket = await connectSocket(node.wsUrl, world.member.token);
      await subscribe(socket, world.tenant.id);
      await world.orgAdmin.del(`/tenants/${world.tenant.id}`);
      await socket.waitFor((m) => m.type === 'subscription.revoked');
      socket.close();
    });

    it('does not revoke an org admin who loses an unrelated tenant membership', async () => {
      const world = await createWorld(node.baseUrl, 'Keep');
      await world.orgAdmin.post(`/tenants/${world.tenant.id}/members`, { email: world.orgAdmin.email, role: 'member' });
      const socket = await connectSocket(node.wsUrl, world.orgAdmin.token);
      await subscribe(socket, world.tenant.id);
      const { body } = await world.orgAdmin.get(`/organizations/${world.org.id}/members`);
      const tenantRow = body.members.find((m) => m.userId === world.orgAdmin.user.id && m.tenantId);
      await world.orgAdmin.del(`/tenants/${world.tenant.id}/members/${tenantRow.id}`);
      await sleep(200);
      assert.ok(!socket.inbox.some((m) => m.type === 'subscription.revoked'));
      socket.close();
    });
  });

  describe('presence', () => {
    it('reports who is in the tenant, and only that tenant', async () => {
      const world = await createWorld(node.baseUrl, 'Presence');
      const a = await connectSocket(node.wsUrl, world.member.token);
      const b = await connectSocket(node.wsUrl, world.tenantAdmin.token);
      const stranger = await connectSocket(node.wsUrl, globex.member.token);
      await subscribe(stranger, globex.tenant.id);
      await subscribe(a, world.tenant.id);
      await subscribe(b, world.tenant.id);

      const seenByA = await a.waitFor(
        (m) => m.type === 'presence' && m.members.some((p) => p.userId === world.tenantAdmin.user.id),
      );
      assert.equal(new Set(seenByA.members.map((p) => p.userId)).size, 2);
      await sleep(100);
      assert.ok(!JSON.stringify(stranger.inbox).includes(world.member.user.id));

      b.close();
      await a.waitFor(
        (m) =>
          m.type === 'presence' &&
          m.members.length === 1 &&
          m.members[0].userId === world.member.user.id &&
          m !== seenByA,
      );
      a.close();
      stranger.close();
    });

    it('shares which card someone has open', async () => {
      const world = await createWorld(node.baseUrl, 'Editing');
      const task = await createTask(world.member, world.tenant.id, world.columns[0].id);
      const a = await connectSocket(node.wsUrl, world.member.token);
      const b = await connectSocket(node.wsUrl, world.tenantAdmin.token);
      await subscribe(a, world.tenant.id);
      await subscribe(b, world.tenant.id);
      a.send({ type: 'presence.update', boardId: world.board.id, taskId: task.id });
      const seen = await b.waitFor(
        (m) => m.type === 'presence' && m.members.some((p) => p.taskId === task.id),
      );
      const entry = seen.members.find((p) => p.taskId === task.id);
      assert.equal(entry.userId, world.member.user.id);
      assert.equal(entry.boardId, world.board.id);
      a.close();
      b.close();
    });

    it('spans nodes', async () => {
      const world = await createWorld(node.baseUrl, 'Span');
      const a = await connectSocket(node.wsUrl, world.member.token);
      const b = await connectSocket(nodeTwo.wsUrl, world.tenantAdmin.token);
      await subscribe(a, world.tenant.id);
      await subscribe(b, world.tenant.id);
      await a.waitFor((m) => m.type === 'presence' && m.members.some((p) => p.userId === world.tenantAdmin.user.id));
      await b.waitFor((m) => m.type === 'presence' && m.members.some((p) => p.userId === world.member.user.id));
      a.close();
      b.close();
    });

    it('ignores presence updates from a socket with no subscription', async () => {
      const socket = await connectSocket(node.wsUrl, acme.member.token);
      socket.send({ type: 'presence.update', boardId: acme.board.id });
      socket.send({ type: 'ping' });
      await socket.waitFor((m) => m.type === 'pong');
      assert.ok(!socket.inbox.some((m) => m.type === 'presence'));
      socket.close();
    });
  });
});
