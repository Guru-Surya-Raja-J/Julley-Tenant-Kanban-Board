import { Router } from 'express';
import { z } from 'zod';
import { authenticate, idParam, opIdFrom, parseBody, requireTenant } from '../../http/access.js';
import { createColumn, deleteColumn, getColumn, listColumns, moveColumn, restoreColumn, updateColumn } from './service.js';

const CreateBody = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(120),
  afterId: z.uuid().nullish(),
  beforeId: z.uuid().nullish(),
});
const UpdateBody = z.object({
  patch: z.object({ name: z.string().trim().min(1).max(120) }).strict(),
  baseVersion: z.number().int().nonnegative(),
});
const MoveBody = z.object({
  afterId: z.uuid().nullish(),
  beforeId: z.uuid().nullish(),
  baseVersion: z.number().int().nonnegative(),
});
const RestoreBody = z.object({ afterId: z.uuid().nullish(), beforeId: z.uuid().nullish() });

// Columns shape the board for everyone, so only admins may change them.
const admin = requireTenant('tenant_admin');

// Mounted at /api/tenants/:tenantId
export const columnRoutes = Router({ mergeParams: true });
columnRoutes.use(authenticate);

columnRoutes.get('/boards/:boardId/columns', requireTenant(), async (req, res) => {
  res.json({ columns: await listColumns(req.access, idParam(req, 'boardId', 'Board')) });
});

columnRoutes.get('/columns/:columnId', requireTenant(), async (req, res) => {
  res.json({ column: await getColumn(req.access, idParam(req, 'columnId', 'Column')) });
});

columnRoutes.post('/boards/:boardId/columns', admin, async (req, res) => {
  const boardId = idParam(req, 'boardId', 'Board');
  const result = await createColumn(req.access, boardId, parseBody(CreateBody, req), opIdFrom(req));
  res.status(201).json(result);
});

columnRoutes.patch('/columns/:columnId', admin, async (req, res) => {
  const id = idParam(req, 'columnId', 'Column');
  res.json(await updateColumn(req.access, id, parseBody(UpdateBody, req), opIdFrom(req)));
});

columnRoutes.post('/columns/:columnId/move', admin, async (req, res) => {
  const id = idParam(req, 'columnId', 'Column');
  res.json(await moveColumn(req.access, id, parseBody(MoveBody, req), opIdFrom(req)));
});

columnRoutes.post('/columns/:columnId/restore', admin, async (req, res) => {
  const id = idParam(req, 'columnId', 'Column');
  res.json(await restoreColumn(req.access, id, parseBody(RestoreBody, req), opIdFrom(req)));
});

columnRoutes.delete('/columns/:columnId', admin, async (req, res) => {
  const id = idParam(req, 'columnId', 'Column');
  res.json(await deleteColumn(req.access, id, opIdFrom(req)));
});
