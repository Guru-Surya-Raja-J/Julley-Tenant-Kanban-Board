import { Router } from 'express';
import { z } from 'zod';
import { withTenant } from '../../db/tenancy.js';
import { readEventsBefore } from '../../domain/events.js';
import { authenticate, requireTenant } from '../../http/access.js';
import { badRequest } from '../../http/errors.js';

const Query = z.object({
  beforeSeq: z.coerce.number().int().positive().optional(),
  boardId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// Mounted at /api/tenants/:tenantId/activity
export const activityRoutes = Router({ mergeParams: true });
activityRoutes.use(authenticate);

activityRoutes.get('/', requireTenant(), async (req, res) => {
  const query = Query.safeParse(req.query);
  if (!query.success) throw badRequest('VALIDATION_FAILED', 'Invalid query parameters');
  const events = await withTenant(req.access, (tx) => readEventsBefore(tx, req.access.tenantId, query.data));
  res.json({ events, nextBeforeSeq: events.length === query.data.limit ? events.at(-1).seq : null });
});
