import { randomUUID } from 'node:crypto';
import { withTenant } from '../../db/tenancy.js';
import { recordEvent, tenantMutation } from '../../domain/events.js';
import { assertNotMovedSince, describeChanges, nextFieldVersions, resolvePatch } from '../../domain/fieldPatch.js';
import { needsRebalance, rankFor, rebalance } from '../../domain/ordering.js';
import { badRequest, notFound } from '../../http/errors.js';

export function serializeTask(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    boardId: row.board_id,
    columnId: row.column_id,
    title: row.title,
    description: row.description,
    priority: row.priority,
    assigneeId: row.assignee_id,
    dueDate: row.due_date,
    position: row.position,
    version: row.version,
    fieldVersions: row.field_versions,
    createdBy: row.created_by,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Patchable API field -> database column.
const FIELD_COLUMNS = {
  title: 'title',
  description: 'description',
  priority: 'priority',
  assigneeId: 'assignee_id',
  dueDate: 'due_date',
};

/**
 * Locks the target column for placement. FOR NO KEY UPDATE serializes other
 * placements here, without blocking the foreign-key checks of unrelated writes.
 * Lock order on every path: column, then task, then the tenant event counter.
 */
async function lockColumn(tx, columnId) {
  const { rows } = await tx.query(
    'SELECT id, board_id FROM columns WHERE id = $1 AND deleted_at IS NULL FOR NO KEY UPDATE',
    [columnId],
  );
  if (!rows[0]) throw notFound('Column');
  return rows[0];
}

// A task in a soft-deleted column is unreachable until the column is restored.
// Two steps, not a locking join: if a concurrent move commits while this waits for
// the lock, a join would re-check against the old column row and lose the task.
async function loadLiveTask(tx, taskId) {
  const { rows } = await tx.query('SELECT * FROM tasks WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [taskId]);
  if (!rows[0]) throw notFound('Task');
  const column = await tx.query('SELECT 1 FROM columns WHERE id = $1 AND deleted_at IS NULL', [rows[0].column_id]);
  if (!column.rowCount) throw notFound('Task');
  return serializeTask(rows[0]);
}

/** The assignee must be able to see the task: a member of this tenant or an org admin. */
async function assertAssignable(tx, access, userId) {
  if (!userId) return;
  const { rowCount } = await tx.query(
    `SELECT 1 FROM memberships
     WHERE user_id = $1 AND organization_id = $2 AND (tenant_id IS NULL OR tenant_id = $3)`,
    [userId, access.organizationId, access.tenantId],
  );
  if (!rowCount) throw badRequest('INVALID_ASSIGNEE', 'The assignee is not a member of this branch');
}

async function recordRebalance(tx, access, boardId, rebalanced) {
  if (!rebalanced) return;
  await recordEvent(tx, access, {
    action: 'column.rebalanced',
    entityType: 'column',
    entityId: rebalanced.columnId,
    boardId,
    payload: rebalanced,
  });
}

export function listTasks(access, boardId) {
  return withTenant(access, async (tx) => {
    const { rows } = await tx.query(
      `SELECT t.* FROM tasks t
       JOIN columns c ON c.id = t.column_id AND c.deleted_at IS NULL
       WHERE t.board_id = $1 AND t.deleted_at IS NULL
       ORDER BY t.column_id, t.position`,
      [boardId],
    );
    return rows.map(serializeTask);
  });
}

export function getTask(access, taskId) {
  return withTenant(access, async (tx) => {
    const { rows } = await tx.query(
      `SELECT t.* FROM tasks t
       JOIN columns c ON c.id = t.column_id AND c.deleted_at IS NULL
       WHERE t.id = $1 AND t.deleted_at IS NULL`,
      [taskId],
    );
    if (!rows[0]) throw notFound('Task');
    return serializeTask(rows[0]);
  });
}

export function createTask(access, input, opId) {
  return tenantMutation(access, opId, async (tx) => {
    const column = await lockColumn(tx, input.columnId);
    await assertAssignable(tx, access, input.assigneeId);
    const position = await rankFor(tx, 'tasks', input.columnId, { afterId: input.afterId, beforeId: input.beforeId });
    const { rows } = await tx.query(
      `INSERT INTO tasks
         (id, tenant_id, board_id, column_id, title, description, priority, assignee_id, due_date, position, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        input.id ?? randomUUID(),
        access.tenantId,
        column.board_id,
        input.columnId,
        input.title,
        input.description ?? '',
        input.priority ?? 'medium',
        input.assigneeId ?? null,
        input.dueDate ?? null,
        position,
        access.userId,
      ],
    );
    const rebalanced = needsRebalance(position)
      ? { columnId: input.columnId, positions: await rebalance(tx, 'tasks', input.columnId) }
      : null;
    const task = serializeTask(rows[0]);
    if (rebalanced) task.position = rebalanced.positions[task.id];
    const seq = await recordEvent(tx, access, {
      action: 'task.created',
      entityType: 'task',
      entityId: task.id,
      boardId: task.boardId,
      payload: { task },
    }, opId);
    await recordRebalance(tx, access, task.boardId, rebalanced);
    return { task, seq };
  });
}

export function updateTask(access, taskId, { patch, baseVersion }, opId) {
  return tenantMutation(access, opId, async (tx) => {
    const current = await loadLiveTask(tx, taskId);
    const changed = resolvePatch({ current, patch, baseVersion, actorId: access.userId, entity: 'task' });
    const fields = Object.keys(changed);
    if (!fields.length) return { task: current, seq: null };
    if (changed.assigneeId) await assertAssignable(tx, access, changed.assigneeId);

    const version = current.version + 1;
    const assignments = fields.map((field, i) => `${FIELD_COLUMNS[field]} = $${i + 4}`);
    const { rows } = await tx.query(
      `UPDATE tasks SET version = $2, field_versions = $3, updated_at = now(), ${assignments.join(', ')}
       WHERE id = $1 RETURNING *`,
      [taskId, version, nextFieldVersions(current, fields, version, access.userId), ...fields.map((f) => changed[f])],
    );
    const task = serializeTask(rows[0]);
    const seq = await recordEvent(tx, access, {
      action: 'task.updated',
      entityType: 'task',
      entityId: taskId,
      boardId: task.boardId,
      payload: { task, changes: describeChanges(current, changed) },
    }, opId);
    return { task, seq };
  });
}

export function moveTask(access, taskId, { columnId, afterId, beforeId, baseVersion }, opId) {
  return tenantMutation(access, opId, async (tx) => {
    const column = await lockColumn(tx, columnId);
    const current = await loadLiveTask(tx, taskId);
    if (current.boardId !== column.board_id) {
      throw badRequest('CROSS_BOARD_MOVE', 'A task can only move within its own board');
    }
    assertNotMovedSince({ current, baseVersion, actorId: access.userId, entity: 'task' });

    const position = await rankFor(tx, 'tasks', columnId, { afterId, beforeId, excludeId: taskId });
    const version = current.version + 1;
    const { rows } = await tx.query(
      `UPDATE tasks SET column_id = $2, position = $3, version = $4, field_versions = $5, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [taskId, columnId, position, version, nextFieldVersions(current, ['position'], version, access.userId)],
    );
    // Rebalance before any event: the tenant counter must be the last lock taken,
    // or this could deadlock against a concurrent edit of a task in this column.
    const rebalanced = needsRebalance(position)
      ? { columnId, positions: await rebalance(tx, 'tasks', columnId) }
      : null;
    const task = serializeTask(rows[0]);
    if (rebalanced) task.position = rebalanced.positions[taskId];
    const seq = await recordEvent(tx, access, {
      action: 'task.moved',
      entityType: 'task',
      entityId: taskId,
      boardId: task.boardId,
      payload: { task, from: { columnId: current.columnId }, to: { columnId } },
    }, opId);
    await recordRebalance(tx, access, task.boardId, rebalanced);
    return { task, seq };
  });
}

// Soft delete: the rank is released, so a live task may later take the same key.
export function deleteTask(access, taskId, opId) {
  return tenantMutation(access, opId, async (tx) => {
    await loadLiveTask(tx, taskId);
    const { rows } = await tx.query(
      `UPDATE tasks SET deleted_at = now(), position = NULL, version = version + 1, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [taskId],
    );
    const task = serializeTask(rows[0]);
    const seq = await recordEvent(tx, access, {
      action: 'task.deleted',
      entityType: 'task',
      entityId: taskId,
      boardId: task.boardId,
      payload: { task },
    }, opId);
    return { task, seq };
  });
}

export function restoreTask(access, taskId, { columnId, afterId, beforeId }, opId) {
  return tenantMutation(access, opId, async (tx) => {
    const { rows: found } = await tx.query('SELECT column_id FROM tasks WHERE id = $1', [taskId]);
    if (!found[0]) throw notFound('Task');
    const targetColumn = columnId ?? found[0].column_id;
    const column = await lockColumn(tx, targetColumn);

    const { rows: locked } = await tx.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [taskId]);
    const current = serializeTask(locked[0]);
    if (!current.deletedAt) throw badRequest('NOT_DELETED', 'That task is not deleted');
    if (current.boardId !== column.board_id) {
      throw badRequest('CROSS_BOARD_MOVE', 'A task can only move within its own board');
    }

    const position = await rankFor(tx, 'tasks', targetColumn, { afterId, beforeId, excludeId: taskId });
    const version = current.version + 1;
    const { rows } = await tx.query(
      `UPDATE tasks SET deleted_at = NULL, column_id = $2, position = $3, version = $4,
         field_versions = $5, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [taskId, targetColumn, position, version, nextFieldVersions(current, ['position'], version, access.userId)],
    );
    const task = serializeTask(rows[0]);
    const seq = await recordEvent(tx, access, {
      action: 'task.restored',
      entityType: 'task',
      entityId: taskId,
      boardId: task.boardId,
      payload: { task },
    }, opId);
    return { task, seq };
  });
}
