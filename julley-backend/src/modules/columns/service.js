import { randomUUID } from 'node:crypto';
import { withTenant } from '../../db/tenancy.js';
import { recordEvent, tenantMutation } from '../../domain/events.js';
import { assertNotMovedSince, describeChanges, nextFieldVersions, resolvePatch } from '../../domain/fieldPatch.js';
import { needsRebalance, rankFor, rebalance } from '../../domain/ordering.js';
import { badRequest, notFound } from '../../http/errors.js';
import { serializeTask } from '../tasks/service.js';

export function serializeColumn(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    boardId: row.board_id,
    name: row.name,
    position: row.position,
    version: row.version,
    fieldVersions: row.field_versions,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// A board-row lock serializes placement of columns on that board.
async function lockBoard(tx, boardId) {
  const { rows } = await tx.query('SELECT id FROM boards WHERE id = $1 FOR NO KEY UPDATE', [boardId]);
  if (!rows[0]) throw notFound('Board');
}

async function loadColumn(tx, id, { includeDeleted = false } = {}) {
  const { rows } = await tx.query(
    `SELECT * FROM columns WHERE id = $1 ${includeDeleted ? '' : 'AND deleted_at IS NULL'} FOR NO KEY UPDATE`,
    [id],
  );
  if (!rows[0]) throw notFound('Column');
  return serializeColumn(rows[0]);
}

export function listColumns(access, boardId) {
  return withTenant(access, async (tx) => {
    const { rowCount } = await tx.query('SELECT 1 FROM boards WHERE id = $1', [boardId]);
    if (!rowCount) throw notFound('Board');
    const { rows } = await tx.query(
      'SELECT * FROM columns WHERE board_id = $1 AND deleted_at IS NULL ORDER BY position',
      [boardId],
    );
    return rows.map(serializeColumn);
  });
}

export function getColumn(access, columnId) {
  return withTenant(access, async (tx) => {
    const { rows } = await tx.query('SELECT * FROM columns WHERE id = $1 AND deleted_at IS NULL', [columnId]);
    if (!rows[0]) throw notFound('Column');
    return serializeColumn(rows[0]);
  });
}

export function createColumn(access, boardId, input, opId) {
  return tenantMutation(access, opId, async (tx) => {
    await lockBoard(tx, boardId);
    const position = await rankFor(tx, 'columns', boardId, { afterId: input.afterId, beforeId: input.beforeId });
    const { rows } = await tx.query(
      `INSERT INTO columns (id, tenant_id, board_id, name, position) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [input.id ?? randomUUID(), access.tenantId, boardId, input.name, position],
    );
    const column = serializeColumn(rows[0]);
    const seq = await recordEvent(tx, access, {
      action: 'column.created',
      entityType: 'column',
      entityId: column.id,
      boardId,
      payload: { column },
    }, opId);
    return { column, seq };
  });
}

export function updateColumn(access, columnId, { patch, baseVersion }, opId) {
  return tenantMutation(access, opId, async (tx) => {
    const current = await loadColumn(tx, columnId);
    const changed = resolvePatch({ current, patch, baseVersion, actorId: access.userId, entity: 'column' });
    const fields = Object.keys(changed);
    if (!fields.length) return { column: current, seq: null };

    const version = current.version + 1;
    const { rows } = await tx.query(
      `UPDATE columns SET name = $2, version = $3, field_versions = $4, updated_at = now() WHERE id = $1 RETURNING *`,
      [columnId, changed.name ?? current.name, version, nextFieldVersions(current, fields, version, access.userId)],
    );
    const column = serializeColumn(rows[0]);
    const seq = await recordEvent(tx, access, {
      action: 'column.updated',
      entityType: 'column',
      entityId: columnId,
      boardId: column.boardId,
      payload: { column, changes: describeChanges(current, changed) },
    }, opId);
    return { column, seq };
  });
}

export function moveColumn(access, columnId, { afterId, beforeId, baseVersion }, opId) {
  return tenantMutation(access, opId, async (tx) => {
    const { rows: found } = await tx.query('SELECT board_id FROM columns WHERE id = $1 AND deleted_at IS NULL', [columnId]);
    if (!found[0]) throw notFound('Column');
    await lockBoard(tx, found[0].board_id);
    const current = await loadColumn(tx, columnId);
    assertNotMovedSince({ current, baseVersion, actorId: access.userId, entity: 'column' });

    const position = await rankFor(tx, 'columns', current.boardId, { afterId, beforeId, excludeId: columnId });
    const version = current.version + 1;
    const { rows } = await tx.query(
      `UPDATE columns SET position = $2, version = $3, field_versions = $4, updated_at = now() WHERE id = $1 RETURNING *`,
      [columnId, position, version, nextFieldVersions(current, ['position'], version, access.userId)],
    );
    // Events are written last on every path: the tenant counter must be the final
    // lock taken, or a rebalance could deadlock against a concurrent edit.
    const positions = needsRebalance(position) ? await rebalance(tx, 'columns', current.boardId) : null;
    const column = serializeColumn(rows[0]);
    if (positions) column.position = positions[columnId];
    const seq = await recordEvent(tx, access, {
      action: 'column.moved',
      entityType: 'column',
      entityId: columnId,
      boardId: column.boardId,
      payload: { column },
    }, opId);
    if (positions) {
      await recordEvent(tx, access, {
        action: 'board.rebalanced',
        entityType: 'board',
        entityId: column.boardId,
        boardId: column.boardId,
        payload: { positions },
      });
    }
    return { column, seq };
  });
}

export function deleteColumn(access, columnId, opId) {
  return tenantMutation(access, opId, async (tx) => {
    await loadColumn(tx, columnId);
    const { rows } = await tx.query(
      `UPDATE columns SET deleted_at = now(), position = NULL, version = version + 1, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [columnId],
    );
    const column = serializeColumn(rows[0]);
    const seq = await recordEvent(tx, access, {
      action: 'column.deleted',
      entityType: 'column',
      entityId: columnId,
      boardId: column.boardId,
      payload: { column },
    }, opId);
    return { column, seq };
  });
}

export function restoreColumn(access, columnId, { afterId, beforeId }, opId) {
  return tenantMutation(access, opId, async (tx) => {
    const { rows: found } = await tx.query('SELECT board_id FROM columns WHERE id = $1', [columnId]);
    if (!found[0]) throw notFound('Column');
    await lockBoard(tx, found[0].board_id);
    const current = await loadColumn(tx, columnId, { includeDeleted: true });
    if (!current.deletedAt) throw badRequest('NOT_DELETED', 'That column is not deleted');

    const position = await rankFor(tx, 'columns', current.boardId, { afterId, beforeId, excludeId: columnId });
    const { rows } = await tx.query(
      `UPDATE columns SET deleted_at = NULL, position = $2, version = version + 1, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [columnId, position],
    );
    // The column's surviving tasks come back with it.
    const { rows: taskRows } = await tx.query(
      'SELECT * FROM tasks WHERE column_id = $1 AND deleted_at IS NULL ORDER BY position',
      [columnId],
    );
    const column = serializeColumn(rows[0]);
    const tasks = taskRows.map(serializeTask);
    const seq = await recordEvent(tx, access, {
      action: 'column.restored',
      entityType: 'column',
      entityId: columnId,
      boardId: column.boardId,
      payload: { column, tasks },
    }, opId);
    return { column, tasks, seq };
  });
}
