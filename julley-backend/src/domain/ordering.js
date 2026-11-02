import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { config } from '../config.js';

// Rank keys for tasks within a column and columns within a board. The two tables
// differ only in which "scope" column groups their rows.
const SCOPES = {
  tasks: { table: 'tasks', scope: 'column_id' },
  columns: { table: 'columns', scope: 'board_id' },
};

/**
 * Picks a rank key from a placement intent. The caller must hold a lock on the
 * scope row (the column or board), which serializes concurrent placements.
 *
 * Anchors can be stale: a colleague may have moved them away since the client
 * rendered. So fall back from "after" to "before" to "end of the list".
 */
export async function rankFor(tx, kind, scopeId, { afterId = null, beforeId = null, excludeId = null } = {}) {
  const { table, scope } = SCOPES[kind];

  const positionOf = async (id) => {
    if (!id || id === excludeId) return null;
    const { rows } = await tx.query(
      `SELECT position FROM ${table} WHERE id = $1 AND ${scope} = $2 AND deleted_at IS NULL`,
      [id, scopeId],
    );
    return rows[0]?.position ?? null;
  };

  const neighbour = async (comparison, order, position) => {
    const { rows } = await tx.query(
      `SELECT position FROM ${table}
       WHERE ${scope} = $1 AND deleted_at IS NULL AND position ${comparison} $2
         AND ($3::uuid IS NULL OR id <> $3)
       ORDER BY position ${order} LIMIT 1`,
      [scopeId, position, excludeId],
    );
    return rows[0]?.position ?? null;
  };

  const afterPosition = await positionOf(afterId);
  if (afterPosition !== null) {
    return generateKeyBetween(afterPosition, await neighbour('>', 'ASC', afterPosition));
  }

  const beforePosition = await positionOf(beforeId);
  if (beforePosition !== null) {
    return generateKeyBetween(await neighbour('<', 'DESC', beforePosition), beforePosition);
  }

  const { rows } = await tx.query(
    `SELECT position FROM ${table}
     WHERE ${scope} = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id <> $2)
     ORDER BY position DESC LIMIT 1`,
    [scopeId, excludeId],
  );
  return generateKeyBetween(rows[0]?.position ?? null, null);
}

export function needsRebalance(position) {
  return position.length > config.rebalanceKeyLength;
}

/** Rewrites every key in a scope with short fresh ones. Returns {id: position}. */
export async function rebalance(tx, kind, scopeId) {
  const { table, scope } = SCOPES[kind];
  const { rows } = await tx.query(
    `SELECT id FROM ${table} WHERE ${scope} = $1 AND deleted_at IS NULL ORDER BY position`,
    [scopeId],
  );
  const keys = generateNKeysBetween(null, null, rows.length);
  const constraint = kind === 'tasks' ? 'tasks_column_position_key' : 'columns_board_position_key';
  // A new key may equal a key another row holds until this statement set finishes.
  await tx.query(`SET CONSTRAINTS ${constraint} DEFERRED`);
  await tx.query(
    `UPDATE ${table} AS t SET position = v.position
     FROM unnest($1::uuid[], $2::text[]) AS v(id, position)
     WHERE t.id = v.id`,
    [rows.map((row) => row.id), keys],
  );
  return Object.fromEntries(rows.map((row, index) => [row.id, keys[index]]));
}
