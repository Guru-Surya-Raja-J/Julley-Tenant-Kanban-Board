import { withTenant } from '../db/tenancy.js';

export const BUS_CHANNEL = 'kanban_bus';

/**
 * Records a mutation. Called inside the mutating transaction, so the change, its
 * audit row and its announcement commit or roll back as one. NOTIFY is delivered
 * only on commit, which rules out announcing work that never happened.
 *
 * Only {tenantId, seq} goes through NOTIFY. Listeners read the row itself, so the
 * 8 KB NOTIFY payload limit can never truncate an event.
 */
export async function recordEvent(tx, access, { action, entityType, entityId, boardId = null, payload = {} }, opId = null) {
  const { rows } = await tx.query(
    'UPDATE tenants SET event_seq = event_seq + 1 WHERE id = $1 RETURNING event_seq',
    [access.tenantId],
  );
  const seq = rows[0].event_seq;
  await tx.query(
    `INSERT INTO activity_logs
       (tenant_id, seq, actor_id, action, entity_type, entity_id, board_id, client_op_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [access.tenantId, seq, access.userId, action, entityType, entityId, boardId, opId, payload],
  );
  await tx.query('SELECT pg_notify($1, $2)', [
    BUS_CHANNEL,
    JSON.stringify({ kind: 'event', tenantId: access.tenantId, seq }),
  ]);
  return seq;
}

/** Tells every node that a user's access changed, so live sockets get re-checked. */
export function notifyAccessChanged(tx, { userId = null, tenantId = null }) {
  return tx.query('SELECT pg_notify($1, $2)', [
    BUS_CHANNEL,
    JSON.stringify({ kind: 'access', userId, tenantId }),
  ]);
}

/** Runs a tenant mutation once per Idempotency-Key: a retry gets the original result. */
export async function idempotent(tx, access, opId, run) {
  if (opId) {
    const { rows } = await tx.query(
      `SELECT payload, seq FROM activity_logs
       WHERE tenant_id = $1 AND actor_id = $2 AND client_op_id = $3`,
      [access.tenantId, access.userId, opId],
    );
    if (rows[0]) return { ...rows[0].payload, seq: rows[0].seq, replayed: true };
  }
  return run();
}

/**
 * A tenant-scoped mutation with retry safety. Two simultaneous requests with one
 * key can both pass the check above, and the loser then hits a unique index: the
 * idempotency key's, or the row's own if the client chose its id. Re-running finds
 * the winner's result. A genuine duplicate simply fails the same way again.
 */
export async function tenantMutation(access, opId, run) {
  const attempt = () => withTenant(access, (tx) => idempotent(tx, access, opId, () => run(tx)));
  try {
    return await attempt();
  } catch (err) {
    if (opId && err.code === '23505') return attempt();
    throw err;
  }
}

const EVENT_SELECT = `
  SELECT a.seq, a.tenant_id, a.action, a.entity_type, a.entity_id, a.board_id,
         a.client_op_id, a.payload, a.created_at,
         CASE WHEN u.id IS NULL THEN NULL
              ELSE json_build_object('id', u.id, 'name', u.name, 'color', u.color) END AS actor
  FROM activity_logs a
  LEFT JOIN users u ON u.id = a.actor_id`;

export function toEvent(row) {
  return {
    seq: row.seq,
    tenantId: row.tenant_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    boardId: row.board_id,
    opId: row.client_op_id,
    payload: row.payload,
    actor: row.actor,
    at: row.created_at,
  };
}

export async function readEventsAfter(tx, tenantId, afterSeq, limit) {
  const { rows } = await tx.query(
    `${EVENT_SELECT} WHERE a.tenant_id = $1 AND a.seq > $2 ORDER BY a.seq ASC LIMIT $3`,
    [tenantId, afterSeq, limit],
  );
  return rows.map(toEvent);
}

/** One board's events, oldest first: everything needed to rebuild it from nothing. */
export async function readBoardHistory(tx, tenantId, boardId, afterSeq, limit) {
  const { rows } = await tx.query(
    `${EVENT_SELECT} WHERE a.tenant_id = $1 AND a.board_id = $2 AND a.seq > $3 ORDER BY a.seq ASC LIMIT $4`,
    [tenantId, boardId, afterSeq, limit],
  );
  return rows.map(toEvent);
}

export async function readEventsBefore(tx, tenantId, { beforeSeq, boardId, limit }) {
  const { rows } = await tx.query(
    `${EVENT_SELECT}
     WHERE a.tenant_id = $1
       AND ($2::bigint IS NULL OR a.seq < $2)
       AND ($3::uuid IS NULL OR a.board_id = $3 OR a.board_id IS NULL)
     ORDER BY a.seq DESC LIMIT $4`,
    [tenantId, beforeSeq ?? null, boardId ?? null, limit],
  );
  return rows.map(toEvent);
}

export async function currentSeq(tx, tenantId) {
  const { rows } = await tx.query('SELECT event_seq FROM tenants WHERE id = $1', [tenantId]);
  return rows[0]?.event_seq ?? 0;
}
