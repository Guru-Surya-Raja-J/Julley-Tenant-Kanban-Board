import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { generateNKeysBetween } from 'fractional-indexing';
import { z } from 'zod';
import { withTenant } from '../../db/tenancy.js';
import { currentSeq, readBoardHistory, recordEvent, tenantMutation } from '../../domain/events.js';
import { describeChanges, nextFieldVersions, resolvePatch } from '../../domain/fieldPatch.js';
import { authenticate, idParam, opIdFrom, parseBody, requireTenant } from '../../http/access.js';
import { badRequest, notFound } from '../../http/errors.js';
import { serializeColumn } from '../columns/service.js';
import { serializeTask } from '../tasks/service.js';

const DEFAULT_COLUMNS = ['To do', 'In progress', 'Done'];

const CreateBody = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(''),
  columns: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
});
const UpdateBody = z.object({
  patch: z
    .object({
      name: z.string().trim().min(1).max(120),
      description: z.string().max(2000),
    })
    .partial()
    .strict(),
  baseVersion: z.number().int().nonnegative(),
});

const HistoryQuery = z.object({
  afterSeq: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

export function serializeBoard(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description,
    version: row.version,
    fieldVersions: row.field_versions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Mounted at /api/tenants/:tenantId/boards
export const boardRoutes = Router({ mergeParams: true });
boardRoutes.use(authenticate);

boardRoutes.get('/', requireTenant(), async (req, res) => {
  const result = await withTenant(req.access, async (tx) => {
    const { rows } = await tx.query('SELECT * FROM boards ORDER BY created_at');
    return { boards: rows.map(serializeBoard), seq: await currentSeq(tx, req.access.tenantId) };
  });
  res.json(result);
});

boardRoutes.post('/', requireTenant('tenant_admin'), async (req, res) => {
  const body = parseBody(CreateBody, req);
  const opId = opIdFrom(req);
  const result = await tenantMutation(req.access, opId, async (tx) => {
    const id = randomUUID();
    const { rows } = await tx.query(
      `INSERT INTO boards (id, tenant_id, name, description, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, req.access.tenantId, body.name, body.description, req.userId],
    );
    const names = body.columns ?? DEFAULT_COLUMNS;
    const keys = generateNKeysBetween(null, null, names.length);
    const columns = [];
    for (let i = 0; i < names.length; i += 1) {
      const inserted = await tx.query(
        `INSERT INTO columns (tenant_id, board_id, name, position) VALUES ($1, $2, $3, $4) RETURNING *`,
        [req.access.tenantId, id, names[i], keys[i]],
      );
      columns.push(serializeColumn(inserted.rows[0]));
    }
    const board = serializeBoard(rows[0]);
    const seq = await recordEvent(tx, req.access, {
      action: 'board.created',
      entityType: 'board',
      entityId: id,
      boardId: id,
      payload: { board, columns },
    }, opId);
    return { board, columns, seq };
  });
  res.status(201).json(result);
});

// The full board, read at one point in time, with the event sequence it reflects.
// REPEATABLE READ is what makes "apply events after this seq" exactly correct.
boardRoutes.get('/:boardId', requireTenant(), async (req, res) => {
  const boardId = idParam(req, 'boardId', 'Board');
  const snapshot = await withTenant(
    req.access,
    async (tx) => {
      const board = await tx.query('SELECT * FROM boards WHERE id = $1', [boardId]);
      if (!board.rows[0]) throw notFound('Board');
      const columns = await tx.query(
        'SELECT * FROM columns WHERE board_id = $1 AND deleted_at IS NULL ORDER BY position',
        [boardId],
      );
      const tasks = await tx.query(
        `SELECT t.* FROM tasks t
         JOIN columns c ON c.id = t.column_id AND c.deleted_at IS NULL
         WHERE t.board_id = $1 AND t.deleted_at IS NULL
         ORDER BY t.column_id, t.position`,
        [boardId],
      );
      return {
        board: serializeBoard(board.rows[0]),
        columns: columns.rows.map(serializeColumn),
        tasks: tasks.rows.map(serializeTask),
        seq: await currentSeq(tx, req.access.tenantId),
      };
    },
    { isolation: 'REPEATABLE READ' },
  );
  res.json(snapshot);
});

// The board's full event log. Replaying it reproduces the board at any past moment.
boardRoutes.get('/:boardId/history', requireTenant(), async (req, res) => {
  const boardId = idParam(req, 'boardId', 'Board');
  const query = HistoryQuery.safeParse(req.query);
  if (!query.success) throw badRequest('VALIDATION_FAILED', 'Invalid query parameters');
  const { afterSeq, limit } = query.data;
  const events = await withTenant(req.access, async (tx) => {
    const { rowCount } = await tx.query('SELECT 1 FROM boards WHERE id = $1', [boardId]);
    if (!rowCount) throw notFound('Board');
    return readBoardHistory(tx, req.access.tenantId, boardId, afterSeq, limit);
  });
  res.json({ events, nextAfterSeq: events.length === limit ? events.at(-1).seq : null });
});

boardRoutes.patch('/:boardId', requireTenant('tenant_admin'), async (req, res) => {
  const boardId = idParam(req, 'boardId', 'Board');
  const body = parseBody(UpdateBody, req);
  const opId = opIdFrom(req);
  const result = await tenantMutation(req.access, opId, async (tx) => {
    const { rows } = await tx.query('SELECT * FROM boards WHERE id = $1 FOR UPDATE', [boardId]);
    if (!rows[0]) throw notFound('Board');
    const current = serializeBoard(rows[0]);
    const changed = resolvePatch({
      current,
      patch: body.patch,
      baseVersion: body.baseVersion,
      actorId: req.userId,
      entity: 'board',
    });
    const fields = Object.keys(changed);
    if (!fields.length) return { board: current, seq: null };

    const version = current.version + 1;
    const updated = await tx.query(
      `UPDATE boards SET name = $2, description = $3, version = $4, field_versions = $5, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [
        boardId,
        changed.name ?? current.name,
        changed.description ?? current.description,
        version,
        nextFieldVersions(current, fields, version, req.userId),
      ],
    );
    const board = serializeBoard(updated.rows[0]);
    const seq = await recordEvent(tx, req.access, {
      action: 'board.updated',
      entityType: 'board',
      entityId: boardId,
      boardId,
      payload: { board, changes: describeChanges(current, changed) },
    }, opId);
    return { board, seq };
  });
  res.json(result);
});

boardRoutes.delete('/:boardId', requireTenant('tenant_admin'), async (req, res) => {
  const boardId = idParam(req, 'boardId', 'Board');
  const opId = opIdFrom(req);
  await tenantMutation(req.access, opId, async (tx) => {
    const { rows } = await tx.query('DELETE FROM boards WHERE id = $1 RETURNING *', [boardId]);
    if (!rows[0]) throw notFound('Board');
    const seq = await recordEvent(tx, req.access, {
      action: 'board.deleted',
      entityType: 'board',
      entityId: boardId,
      boardId,
      payload: { board: serializeBoard(rows[0]) },
    }, opId);
    return { seq };
  });
  res.status(204).end();
});
