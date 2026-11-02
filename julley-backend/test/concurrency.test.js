import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { pool } from '../src/db/pool.js';
import { createTask, createWorld, orderedTitles, startTestNode } from './helpers.js';

describe('concurrency and conflict handling', () => {
  let node;
  let world;
  let alice; // tenant admin
  let bob; // member
  const path = (suffix) => `/tenants/${world.tenant.id}${suffix}`;

  before(async () => {
    node = await startTestNode();
    world = await createWorld(node.baseUrl, 'Race');
    alice = world.tenantAdmin;
    bob = world.member;
  });

  after(async () => {
    await node.stop();
    await pool.end();
  });

  describe('field-level merge', () => {
    it('merges edits to different fields made from the same version', async () => {
      const task = await createTask(alice, world.tenant.id, world.columns[0].id, 'Merge me');
      const a = await alice.patch(path(`/tasks/${task.id}`), { patch: { title: 'New title' }, baseVersion: 1 });
      const b = await bob.patch(path(`/tasks/${task.id}`), { patch: { description: 'New desc' }, baseVersion: 1 });
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      assert.equal(b.body.task.title, 'New title');
      assert.equal(b.body.task.description, 'New desc');
      assert.equal(b.body.task.version, 3);
    });

    it('reports a true conflict on the same field, with both values', async () => {
      const task = await createTask(alice, world.tenant.id, world.columns[0].id, 'Contested');
      await alice.patch(path(`/tasks/${task.id}`), { patch: { title: 'Alice version' }, baseVersion: 1 });
      const res = await bob.patch(path(`/tasks/${task.id}`), { patch: { title: 'Bob version' }, baseVersion: 1 });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'EDIT_CONFLICT');
      const [clash] = res.body.error.details.conflicts;
      assert.equal(clash.field, 'title');
      assert.equal(clash.yours, 'Bob version');
      assert.equal(clash.theirs, 'Alice version');
      assert.equal(clash.changedBy, alice.user.id);
      assert.equal(res.body.error.details.current.version, 2);
    });

    it('lets a conflict be resolved by resubmitting from the current version', async () => {
      const task = await createTask(alice, world.tenant.id, world.columns[0].id, 'Resolve');
      await alice.patch(path(`/tasks/${task.id}`), { patch: { title: 'Alice' }, baseVersion: 1 });
      const res = await bob.patch(path(`/tasks/${task.id}`), { patch: { title: 'Bob' }, baseVersion: 2 });
      assert.equal(res.status, 200);
      assert.equal(res.body.task.title, 'Bob');
    });

    it('is not a conflict when both set the same value', async () => {
      const task = await createTask(alice, world.tenant.id, world.columns[0].id, 'Same');
      await alice.patch(path(`/tasks/${task.id}`), { patch: { priority: 'urgent' }, baseVersion: 1 });
      const res = await bob.patch(path(`/tasks/${task.id}`), { patch: { priority: 'urgent' }, baseVersion: 1 });
      assert.equal(res.status, 200);
      assert.equal(res.body.task.version, 2, 'a no-op must not bump the version');
    });

    it("never makes a user's own queued edits conflict", async () => {
      const task = await createTask(alice, world.tenant.id, world.columns[0].id, 'Mine');
      await alice.patch(path(`/tasks/${task.id}`), { patch: { title: 'One' }, baseVersion: 1 });
      const res = await alice.patch(path(`/tasks/${task.id}`), { patch: { title: 'Two' }, baseVersion: 1 });
      assert.equal(res.status, 200);
      assert.equal(res.body.task.title, 'Two');
    });

    it('of many simultaneous edits to one field, every outcome is accounted for', async () => {
      const task = await createTask(alice, world.tenant.id, world.columns[0].id, 'Stampede');
      const users = [alice, bob, world.orgAdmin];
      const results = await Promise.all(
        users.map((user, i) => user.patch(path(`/tasks/${task.id}`), { patch: { title: `Writer ${i}` }, baseVersion: 1 })),
      );
      const winners = results.filter((r) => r.status === 200);
      const losers = results.filter((r) => r.status === 409);
      assert.equal(winners.length, 1, 'exactly one writer wins');
      assert.equal(losers.length, 2);
      const { body } = await alice.get(path(`/tasks/${task.id}`));
      assert.equal(body.task.title, winners[0].body.task.title);
    });
  });

  describe('drag and drop', () => {
    it('first writer wins when two users drag the same task', async () => {
      const task = await createTask(alice, world.tenant.id, world.columns[0].id, 'Dragged');
      const [a, b] = await Promise.all([
        alice.post(path(`/tasks/${task.id}/move`), { columnId: world.columns[1].id, baseVersion: 1 }),
        bob.post(path(`/tasks/${task.id}/move`), { columnId: world.columns[2].id, baseVersion: 1 }),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.deepEqual(statuses, [200, 409]);
      const loser = a.status === 409 ? a : b;
      assert.equal(loser.body.error.code, 'MOVE_CONFLICT');
      const winner = a.status === 200 ? a : b;
      const { body } = await alice.get(path(`/tasks/${task.id}`));
      assert.equal(body.task.columnId, winner.body.task.columnId);
    });

    it('a move and a title edit of one task both succeed', async () => {
      const task = await createTask(alice, world.tenant.id, world.columns[0].id, 'Both');
      const [move, edit] = await Promise.all([
        alice.post(path(`/tasks/${task.id}/move`), { columnId: world.columns[1].id, baseVersion: 1 }),
        bob.patch(path(`/tasks/${task.id}`), { patch: { title: 'Both edited' }, baseVersion: 1 }),
      ]);
      assert.equal(move.status, 200);
      assert.equal(edit.status, 200);
      const { body } = await alice.get(path(`/tasks/${task.id}`));
      assert.equal(body.task.columnId, world.columns[1].id);
      assert.equal(body.task.title, 'Both edited');
    });

    it('places a task exactly between its anchors', async () => {
      const board = (await alice.post(path('/boards'), { name: 'Order', columns: ['A', 'B'] })).body;
      const [colA, colB] = board.columns;
      const one = await createTask(alice, world.tenant.id, colA.id, '1');
      const two = await createTask(alice, world.tenant.id, colA.id, '2');
      const three = await createTask(alice, world.tenant.id, colB.id, '3');

      const res = await alice.post(path(`/tasks/${three.id}/move`), {
        columnId: colA.id,
        afterId: one.id,
        beforeId: two.id,
        baseVersion: 1,
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await orderedTitles(alice, world.tenant.id, board.board.id, colA.id), ['1', '3', '2']);
    });

    it('moves to the top with only a "before" anchor, and to the end with none', async () => {
      const board = (await alice.post(path('/boards'), { name: 'Ends', columns: ['A'] })).body;
      const [col] = board.columns;
      const one = await createTask(alice, world.tenant.id, col.id, '1');
      const two = await createTask(alice, world.tenant.id, col.id, '2');
      await alice.post(path(`/tasks/${two.id}/move`), { columnId: col.id, beforeId: one.id, baseVersion: 1 });
      assert.deepEqual(await orderedTitles(alice, world.tenant.id, board.board.id, col.id), ['2', '1']);
      await alice.post(path(`/tasks/${two.id}/move`), { columnId: col.id, baseVersion: 2 });
      assert.deepEqual(await orderedTitles(alice, world.tenant.id, board.board.id, col.id), ['1', '2']);
    });

    it('still lands the task when its anchor has moved away', async () => {
      const board = (await alice.post(path('/boards'), { name: 'Stale', columns: ['A', 'B'] })).body;
      const [colA, colB] = board.columns;
      const anchor = await createTask(alice, world.tenant.id, colA.id, 'anchor');
      await createTask(alice, world.tenant.id, colA.id, 'other');
      const moved = await createTask(alice, world.tenant.id, colB.id, 'moved');
      await bob.post(path(`/tasks/${anchor.id}/move`), { columnId: colB.id, baseVersion: 1 });
      const res = await alice.post(path(`/tasks/${moved.id}/move`), {
        columnId: colA.id,
        afterId: anchor.id,
        baseVersion: 1,
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await orderedTitles(alice, world.tenant.id, board.board.id, colA.id), ['other', 'moved']);
    });

    it('rejects a drop into a column that was just deleted', async () => {
      const board = (await alice.post(path('/boards'), { name: 'Gone', columns: ['A', 'B'] })).body;
      const [colA, colB] = board.columns;
      const task = await createTask(bob, world.tenant.id, colA.id);
      await alice.del(path(`/columns/${colB.id}`));
      const res = await bob.post(path(`/tasks/${task.id}/move`), { columnId: colB.id, baseVersion: 1 });
      assert.equal(res.status, 404);
    });

    it('rejects a move across boards', async () => {
      const first = (await alice.post(path('/boards'), { name: 'First', columns: ['A'] })).body;
      const second = (await alice.post(path('/boards'), { name: 'Second', columns: ['B'] })).body;
      const task = await createTask(bob, world.tenant.id, first.columns[0].id);
      const res = await bob.post(path(`/tasks/${task.id}/move`), { columnId: second.columns[0].id, baseVersion: 1 });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'CROSS_BOARD_MOVE');
    });
  });

  describe('ordering under load', () => {
    it('keeps every task and gives unique keys when 30 land in one column at once', async () => {
      const board = (await alice.post(path('/boards'), { name: 'Load', columns: ['A'] })).body;
      const [col] = board.columns;
      const results = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          bob.post(path('/tasks'), { columnId: col.id, title: `Task ${i}` }),
        ),
      );
      assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.map((r) => r.status)));

      const { body } = await bob.get(path(`/boards/${board.board.id}`));
      assert.equal(body.tasks.length, 30);
      assert.equal(new Set(body.tasks.map((t) => t.position)).size, 30);
    });

    it('survives concurrent moves of different tasks into the same gap', async () => {
      const board = (await alice.post(path('/boards'), { name: 'Gap', columns: ['A', 'B'] })).body;
      const [colA, colB] = board.columns;
      const left = await createTask(alice, world.tenant.id, colA.id, 'left');
      const right = await createTask(alice, world.tenant.id, colA.id, 'right');
      const movers = await Promise.all(
        Array.from({ length: 10 }, (_, i) => createTask(alice, world.tenant.id, colB.id, `m${i}`)),
      );
      const results = await Promise.all(
        movers.map((task) =>
          bob.post(path(`/tasks/${task.id}/move`), {
            columnId: colA.id,
            afterId: left.id,
            beforeId: right.id,
            baseVersion: task.version,
          }),
        ),
      );
      assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.body?.error)));
      const titles = await orderedTitles(alice, world.tenant.id, board.board.id, colA.id);
      assert.equal(titles.length, 12);
      assert.equal(titles[0], 'left');
      assert.equal(titles.at(-1), 'right');
    });

    it('survives concurrent edits and moves across one column without deadlock', async () => {
      const board = (await alice.post(path('/boards'), { name: 'Mixed', columns: ['A', 'B'] })).body;
      const [colA, colB] = board.columns;
      const tasks = await Promise.all(
        Array.from({ length: 12 }, (_, i) => createTask(alice, world.tenant.id, colA.id, `t${i}`)),
      );
      const ops = tasks.flatMap((task, i) => [
        alice.post(path(`/tasks/${task.id}/move`), { columnId: colB.id, baseVersion: task.version }),
        bob.patch(path(`/tasks/${task.id}`), { patch: { description: `edit ${i}` }, baseVersion: task.version }),
      ]);
      const results = await Promise.all(ops);
      assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
    });

    it('rebalances when keys grow long, preserving order and telling clients', async () => {
      // The suite runs with REBALANCE_KEY_LENGTH=8, so repeated halving trips it.
      const board = (await alice.post(path('/boards'), { name: 'Rebalance', columns: ['A'] })).body;
      const [col] = board.columns;
      const first = await createTask(alice, world.tenant.id, col.id, 'first');
      const last = await createTask(alice, world.tenant.id, col.id, 'last');
      const expected = ['first'];
      let anchor = first.id;
      for (let i = 0; i < 40; i += 1) {
        const task = await createTask(alice, world.tenant.id, col.id, `n${i}`, { beforeId: last.id, afterId: anchor });
        anchor = task.id;
        expected.push(`n${i}`);
      }
      expected.push('last');

      assert.deepEqual(await orderedTitles(alice, world.tenant.id, board.board.id, col.id), expected);
      const { body } = await alice.get(path(`/boards/${board.board.id}`));
      assert.ok(body.tasks.every((t) => t.position.length <= 8), 'all keys are short again');

      const activity = await alice.get(path(`/activity?boardId=${board.board.id}&limit=100`));
      assert.ok(activity.body.events.some((e) => e.action === 'column.rebalanced'));
    });
  });

  describe('idempotency', () => {
    it('applies a retried create once, returning the original result', async () => {
      const key = randomUUID();
      const body = { columnId: world.columns[0].id, title: 'Once', id: randomUUID() };
      const first = await bob.post(path('/tasks'), body, { 'idempotency-key': key });
      const retry = await bob.post(path('/tasks'), body, { 'idempotency-key': key });
      assert.equal(first.status, 201);
      assert.equal(retry.status, 201);
      assert.equal(retry.body.task.id, first.body.task.id);
      assert.equal(retry.body.replayed, true);
    });

    it('does not move a task twice when a move is retried', async () => {
      const task = await createTask(bob, world.tenant.id, world.columns[0].id, 'Move once');
      const key = randomUUID();
      const body = { columnId: world.columns[1].id, baseVersion: 1 };
      const first = await bob.post(path(`/tasks/${task.id}/move`), body, { 'idempotency-key': key });
      const retry = await bob.post(path(`/tasks/${task.id}/move`), body, { 'idempotency-key': key });
      assert.equal(retry.status, 200);
      assert.equal(retry.body.task.version, first.body.task.version);
      const { body: now } = await bob.get(path(`/tasks/${task.id}`));
      assert.equal(now.task.version, 2);
    });

    it('handles the same key arriving twice simultaneously', async () => {
      const key = randomUUID();
      const body = { columnId: world.columns[0].id, title: 'Simultaneous', id: randomUUID() };
      const results = await Promise.all([
        bob.post(path('/tasks'), body, { 'idempotency-key': key }),
        bob.post(path('/tasks'), body, { 'idempotency-key': key }),
      ]);
      assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.map((r) => r.body)));
      const activity = await bob.get(path(`/activity?limit=100`));
      const created = activity.body.events.filter((e) => e.entityId === body.id);
      assert.equal(created.length, 1);
    });

    it("keys are per user: another user's key never returns their result", async () => {
      const key = randomUUID();
      const first = await bob.post(path('/tasks'), { columnId: world.columns[0].id, title: 'Bob' }, { 'idempotency-key': key });
      const second = await alice.post(path('/tasks'), { columnId: world.columns[0].id, title: 'Alice' }, { 'idempotency-key': key });
      assert.notEqual(first.body.task.id, second.body.task.id);
      assert.equal(second.body.task.title, 'Alice');
    });
  });

  describe('soft delete and undo support', () => {
    it('restores a deleted task with its data intact, at the requested spot', async () => {
      const board = (await alice.post(path('/boards'), { name: 'Restore', columns: ['A'] })).body;
      const [col] = board.columns;
      const one = await createTask(alice, world.tenant.id, col.id, '1');
      const two = await createTask(alice, world.tenant.id, col.id, '2', { description: 'keep me' });
      const three = await createTask(alice, world.tenant.id, col.id, '3');
      await alice.del(path(`/tasks/${two.id}`));
      assert.deepEqual(await orderedTitles(alice, world.tenant.id, board.board.id, col.id), ['1', '3']);

      const restored = await alice.post(path(`/tasks/${two.id}/restore`), { afterId: one.id, beforeId: three.id });
      assert.equal(restored.status, 200);
      assert.equal(restored.body.task.description, 'keep me');
      assert.deepEqual(await orderedTitles(alice, world.tenant.id, board.board.id, col.id), ['1', '2', '3']);
    });

    it('editing a deleted task answers 404', async () => {
      const task = await createTask(alice, world.tenant.id, world.columns[0].id, 'Doomed');
      await alice.del(path(`/tasks/${task.id}`));
      const res = await bob.patch(path(`/tasks/${task.id}`), { patch: { title: 'Too late' }, baseVersion: 1 });
      assert.equal(res.status, 404);
    });

    it('deleted keys can be reused without collision', async () => {
      const board = (await alice.post(path('/boards'), { name: 'Reuse', columns: ['A'] })).body;
      const [col] = board.columns;
      const one = await createTask(alice, world.tenant.id, col.id, '1');
      const two = await createTask(alice, world.tenant.id, col.id, '2');
      const three = await createTask(alice, world.tenant.id, col.id, '3');
      await alice.del(path(`/tasks/${two.id}`));
      const replacement = await createTask(alice, world.tenant.id, col.id, 'new', { afterId: one.id, beforeId: three.id });
      assert.equal(replacement.position, two.position);
      assert.deepEqual(await orderedTitles(alice, world.tenant.id, board.board.id, col.id), ['1', 'new', '3']);
    });

    it('deleting a column hides its tasks; restoring brings them back', async () => {
      const board = (await alice.post(path('/boards'), { name: 'Cols', columns: ['A', 'B'] })).body;
      const [colA, colB] = board.columns;
      const task = await createTask(bob, world.tenant.id, colB.id, 'Inside');
      await alice.del(path(`/columns/${colB.id}`));
      const hidden = await bob.get(path(`/boards/${board.board.id}`));
      assert.equal(hidden.body.tasks.length, 0);
      assert.equal((await bob.get(path(`/tasks/${task.id}`))).status, 404);

      const restored = await alice.post(path(`/columns/${colB.id}/restore`), { afterId: colA.id });
      assert.equal(restored.body.tasks.length, 1);
      const shown = await bob.get(path(`/boards/${board.board.id}`));
      assert.deepEqual(shown.body.columns.map((c) => c.name), ['A', 'B']);
      assert.equal(shown.body.tasks.length, 1);
    });

    it('column rename conflicts are detected too', async () => {
      const board = (await alice.post(path('/boards'), { name: 'Rename', columns: ['A'] })).body;
      const [col] = board.columns;
      await alice.patch(path(`/columns/${col.id}`), { patch: { name: 'X' }, baseVersion: 1 });
      const res = await world.orgAdmin.patch(path(`/columns/${col.id}`), { patch: { name: 'Y' }, baseVersion: 1 });
      assert.equal(res.status, 409);
    });
  });

  describe('board history', () => {
    it('returns the whole log oldest first, in pages, for this board only', async () => {
      const board = (await alice.post(path('/boards'), { name: 'History', columns: ['A'] })).body;
      const other = (await alice.post(path('/boards'), { name: 'Elsewhere', columns: ['B'] })).body;
      await createTask(alice, world.tenant.id, other.columns[0].id, 'Not mine');
      const task = await createTask(alice, world.tenant.id, board.columns[0].id, 'Mine');
      await alice.patch(path(`/tasks/${task.id}`), { patch: { title: 'Mine 2' }, baseVersion: 1 });

      const first = await bob.get(path(`/boards/${board.board.id}/history?limit=2`));
      assert.deepEqual(first.body.events.map((e) => e.action), ['board.created', 'task.created']);
      const second = await bob.get(path(`/boards/${board.board.id}/history?limit=2&afterSeq=${first.body.nextAfterSeq}`));
      assert.deepEqual(second.body.events.map((e) => e.action), ['task.updated']);
      assert.equal(second.body.nextAfterSeq, null);
    });

    it("does not serve another tenant's board history", async () => {
      const foreign = await createWorld(node.baseUrl, 'Foreign');
      const res = await bob.get(path(`/boards/${foreign.board.id}/history`));
      assert.equal(res.status, 404);
    });
  });

  describe('event sequence', () => {
    it('is gap-free and ordered, even under concurrent writes', async () => {
      await Promise.all(
        Array.from({ length: 25 }, (_, i) => createTask(bob, world.tenant.id, world.columns[2].id, `Seq ${i}`)),
      );
      const { body } = await alice.get(path('/activity?limit=100'));
      const seqs = body.events.map((event) => event.seq);
      for (let i = 1; i < seqs.length; i += 1) assert.equal(seqs[i], seqs[i - 1] - 1);
    });

    it('rolls the sequence back with a failed write: conflicts leave no trace', async () => {
      const task = await createTask(alice, world.tenant.id, world.columns[0].id, 'Trace');
      await alice.patch(path(`/tasks/${task.id}`), { patch: { title: 'A' }, baseVersion: 1 });
      const before = (await alice.get(path('/activity?limit=1'))).body.events[0].seq;
      await bob.patch(path(`/tasks/${task.id}`), { patch: { title: 'B' }, baseVersion: 1 });
      const after = (await alice.get(path('/activity?limit=1'))).body.events[0].seq;
      assert.equal(after, before);
    });
  });
});
