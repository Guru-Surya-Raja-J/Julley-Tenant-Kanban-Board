// The client's optimistic view. Pure functions, so no browser or server needed.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { byPosition, computeView, isNewer, neighboursOf, placeAmong } from '../src/lib/view.js';

const BOARD = 'b1';
const column = (id, position) => ({ id, position, name: id, version: 1 });
const task = (id, columnId, position, extra = {}) => ({ id, columnId, position, title: id, version: 1, ...extra });

const state = (overrides = {}) => ({
  boardId: BOARD,
  columns: { c1: column('c1', 'a0'), c2: column('c2', 'a1') },
  tasks: {
    t1: task('t1', 'c1', 'a0'),
    t2: task('t2', 'c1', 'a1'),
    t3: task('t3', 'c2', 'a0'),
  },
  pending: [],
  ...overrides,
});

const op = (kind, fields) => ({ kind, boardId: BOARD, ...fields });
const titles = (view, columnId) => view.columns.find((c) => c.id === columnId).tasks.map((t) => t.id);

describe('optimistic view', () => {
  it('shows server state unchanged when nothing is pending', () => {
    const view = computeView(state());
    assert.deepEqual(titles(view, 'c1'), ['t1', 't2']);
    assert.equal(view.pendingIds.size, 0);
  });

  it('applies a pending move, between the requested anchors', () => {
    const view = computeView(
      state({ pending: [op('task.move', { taskId: 't3', columnId: 'c1', afterId: 't1', beforeId: 't2' })] }),
    );
    assert.deepEqual(titles(view, 'c1'), ['t1', 't3', 't2']);
    assert.deepEqual(titles(view, 'c2'), []);
    assert.ok(view.pendingIds.has('t3'));
  });

  it('rolls back simply by removing the operation', () => {
    const base = state();
    const moving = computeView({ ...base, pending: [op('task.move', { taskId: 't3', columnId: 'c1' })] });
    assert.deepEqual(titles(moving, 'c2'), []);
    const rolledBack = computeView({ ...base, pending: [] });
    assert.deepEqual(titles(rolledBack, 'c2'), ['t3']);
  });

  it('rebases a pending move over a remote change that arrives while it is in flight', () => {
    const pending = [op('task.move', { taskId: 't3', columnId: 'c1', afterId: 't1' })];
    const before = computeView(state({ pending }));
    assert.deepEqual(titles(before, 'c1'), ['t1', 't3', 't2']);
    // A colleague inserts a task right after t1.
    const after = computeView(
      state({
        pending,
        tasks: {
          ...state().tasks,
          r1: task('r1', 'c1', 'a0V'),
        },
      }),
    );
    assert.deepEqual(titles(after, 'c1'), ['t1', 't3', 'r1', 't2']);
  });

  it('keeps a pending title edit over an unrelated remote change to the same task', () => {
    const view = computeView(
      state({
        tasks: { ...state().tasks, t1: task('t1', 'c1', 'a0', { description: 'remote' }) },
        pending: [op('task.update', { taskId: 't1', patch: { title: 'mine' } })],
      }),
    );
    assert.equal(view.tasksById.t1.title, 'mine');
    assert.equal(view.tasksById.t1.description, 'remote');
  });

  it('shows a pending create and hides a pending delete', () => {
    const view = computeView(
      state({
        pending: [
          op('task.create', { task: { id: 'n1', columnId: 'c2', title: 'new' } }),
          op('task.delete', { taskId: 't1' }),
        ],
      }),
    );
    assert.deepEqual(titles(view, 'c2'), ['t3', 'n1']);
    assert.deepEqual(titles(view, 'c1'), ['t2']);
  });

  it('replays operations in order', () => {
    const view = computeView(
      state({
        pending: [
          op('task.move', { taskId: 't1', columnId: 'c2' }),
          op('task.move', { taskId: 't1', columnId: 'c1', beforeId: 't2' }),
          op('task.update', { taskId: 't1', patch: { title: 'final' } }),
        ],
      }),
    );
    assert.deepEqual(titles(view, 'c1'), ['t1', 't2']);
    assert.equal(view.tasksById.t1.title, 'final');
  });

  it('ignores an operation on a task someone else deleted', () => {
    const view = computeView(state({ pending: [op('task.move', { taskId: 'gone', columnId: 'c1' })] }));
    assert.deepEqual(titles(view, 'c1'), ['t1', 't2']);
  });

  it('ignores operations queued for another board', () => {
    const view = computeView(
      state({ pending: [{ kind: 'task.delete', boardId: 'other', taskId: 't1' }] }),
    );
    assert.deepEqual(titles(view, 'c1'), ['t1', 't2']);
  });

  it('hides tasks whose column was deleted, pending or confirmed', () => {
    const view = computeView(state({ pending: [op('column.delete', { columnId: 'c2' })] }));
    assert.deepEqual(view.columns.map((c) => c.id), ['c1']);
  });

  it('restores a column and its tasks when a delete is undone', () => {
    const view = computeView(
      state({
        columns: { c1: column('c1', 'a0') },
        pending: [op('column.restore', { columnId: 'c2', snapshot: column('c2'), afterId: 'c1' })],
      }),
    );
    assert.deepEqual(view.columns.map((c) => c.id), ['c1', 'c2']);
    assert.deepEqual(titles(view, 'c2'), ['t3']);
  });

  it('applies pending column moves', () => {
    const view = computeView(state({ pending: [op('column.move', { columnId: 'c2', beforeId: 'c1' })] }));
    assert.deepEqual(view.columns.map((c) => c.id), ['c2', 'c1']);
  });
});

describe('ordering helpers', () => {
  it('sorts bytewise, matching COLLATE "C" (uppercase before lowercase)', () => {
    const sorted = [task('a', 'c', 'a'), task('b', 'c', 'Z'), task('c', 'c', 'a0')].sort(byPosition);
    assert.deepEqual(sorted.map((t) => t.position), ['Z', 'a', 'a0']);
  });

  it('breaks position ties deterministically by id', () => {
    const sorted = [task('b', 'c', 'a0'), task('a', 'c', 'a0')].sort(byPosition);
    assert.deepEqual(sorted.map((t) => t.id), ['a', 'b']);
  });

  it('places at the end when an anchor is unknown', () => {
    const list = [task('a', 'c', 'a0'), task('b', 'c', 'a1')];
    const key = placeAmong(list, { afterId: 'missing', beforeId: 'missing' });
    assert.ok(key > 'a1');
  });

  it('places at the start with only a "before" anchor', () => {
    const list = [task('a', 'c', 'a0'), task('b', 'c', 'a1')];
    assert.ok(placeAmong(list, { beforeId: 'a' }) < 'a0');
  });

  it('survives duplicate keys without throwing', () => {
    const list = [task('a', 'c', 'a0'), task('b', 'c', 'a0')];
    assert.equal(typeof placeAmong(list, { afterId: 'a' }), 'string');
  });

  it('finds the neighbours needed to undo a move', () => {
    const list = [task('a', 'c', 'a0'), task('b', 'c', 'a1'), task('c', 'c', 'a2')];
    assert.deepEqual(neighboursOf(list, 'b'), { afterId: 'a', beforeId: 'c' });
    assert.deepEqual(neighboursOf(list, 'a'), { afterId: null, beforeId: 'b' });
    assert.deepEqual(neighboursOf(list, 'c'), { afterId: 'b', beforeId: null });
  });

  it('lets events replace equal versions, but responses only strictly newer ones', () => {
    assert.ok(isNewer({ version: 2 }, { version: 2 }));
    assert.ok(!isNewer({ version: 2 }, { version: 2 }, { strict: true }));
    assert.ok(isNewer({ version: 3 }, { version: 2 }, { strict: true }));
    assert.ok(!isNewer({ version: 1 }, { version: 2 }));
    assert.ok(isNewer({ version: 1 }, undefined));
  });
});
