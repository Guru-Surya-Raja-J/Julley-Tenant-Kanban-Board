import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyToFrame, buildFrames, EMPTY_FRAME, visibleTasks } from '../src/lib/replay.js';

const column = (id, position = 'a0') => ({ id, position, name: id });
const task = (id, columnId, version = 1, position = 'a0') => ({ id, columnId, version, position, title: id });
const event = (action, payload) => ({ action, payload });

const created = event('board.created', { board: { id: 'b' }, columns: [column('c1'), column('c2', 'a1')] });

describe('event log replay', () => {
  it('starts empty, with one frame per event', () => {
    const frames = buildFrames([created, event('task.created', { task: task('t1', 'c1') })]);
    assert.equal(frames.length, 3);
    assert.deepEqual(frames[0], EMPTY_FRAME);
    assert.equal(frames[1].board.id, 'b');
    assert.deepEqual(Object.keys(frames[2].tasks), ['t1']);
  });

  it('never mutates earlier frames, so scrubbing backward is exact', () => {
    const frames = buildFrames([
      created,
      event('task.created', { task: task('t1', 'c1') }),
      event('task.moved', { task: task('t1', 'c2', 2) }),
      event('task.deleted', { task: task('t1', 'c2', 3) }),
    ]);
    assert.equal(frames[2].tasks.t1.columnId, 'c1');
    assert.equal(frames[3].tasks.t1.columnId, 'c2');
    assert.equal(frames[4].tasks.t1, undefined);
  });

  it('hides tasks in a deleted column and brings them back on restore', () => {
    const frames = buildFrames([
      created,
      event('task.created', { task: task('t1', 'c2') }),
      event('column.deleted', { column: column('c2') }),
      event('column.restored', { column: column('c2', 'a1'), tasks: [task('t1', 'c2')] }),
    ]);
    assert.equal(visibleTasks(frames[2]).length, 1);
    assert.equal(visibleTasks(frames[3]).length, 0);
    assert.equal(visibleTasks(frames[4]).length, 1);
  });

  it('applies rebalanced keys to tasks and columns', () => {
    let frame = buildFrames([created, event('task.created', { task: task('t1', 'c1') })]).at(-1);
    frame = applyToFrame(frame, event('column.rebalanced', { columnId: 'c1', positions: { t1: 'Zz' } }));
    assert.equal(frame.tasks.t1.position, 'Zz');
    frame = applyToFrame(frame, event('board.rebalanced', { positions: { c1: 'Zy' } }));
    assert.equal(frame.columns.c1.position, 'Zy');
  });

  it('ignores events that do not change the board', () => {
    const frame = buildFrames([created]).at(-1);
    assert.equal(applyToFrame(frame, event('member.added', {})), frame);
  });
});
