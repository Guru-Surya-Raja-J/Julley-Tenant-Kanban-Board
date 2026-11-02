import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { withOrg, withUser } from '../../db/tenancy.js';
import { notifyAccessChanged } from '../../domain/events.js';
import { authenticate, parseBody, requireOrg } from '../../http/access.js';
import { conflict, notFound } from '../../http/errors.js';

const CreateBody = z.object({ name: z.string().trim().min(1).max(120) });
const UpdateBody = z.object({
  name: z.string().trim().min(1).max(120),
  baseVersion: z.number().int().optional(),
});

function serialize(row) {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const organizationRoutes = Router();
organizationRoutes.use(authenticate);

organizationRoutes.get('/', async (req, res) => {
  // No WHERE on membership: the RLS policy only reveals the caller's organizations.
  const rows = await withUser(req.userId, async (tx) => {
    const result = await tx.query(
      `SELECT o.*, (SELECT m.role FROM memberships m
                    WHERE m.organization_id = o.id AND m.user_id = $1
                    ORDER BY m.role LIMIT 1) AS role
       FROM organizations o ORDER BY o.name`,
      [req.userId],
    );
    return result.rows;
  });
  res.json({ organizations: rows.map(serialize) });
});

organizationRoutes.post('/', async (req, res) => {
  const body = parseBody(CreateBody, req);
  const id = randomUUID();
  const row = await withOrg(req.userId, id, async (tx) => {
    const { rows } = await tx.query('INSERT INTO organizations (id, name) VALUES ($1, $2) RETURNING *', [id, body.name]);
    await tx.query(
      `INSERT INTO memberships (user_id, organization_id, tenant_id, role) VALUES ($1, $2, NULL, 'org_admin')`,
      [req.userId, id],
    );
    return rows[0];
  });
  res.status(201).json({ organization: serialize({ ...row, role: 'org_admin' }) });
});

organizationRoutes.get('/:orgId', requireOrg(), async (req, res) => {
  const row = await withUser(req.userId, async (tx) => {
    const { rows } = await tx.query('SELECT * FROM organizations WHERE id = $1', [req.params.orgId]);
    return rows[0];
  });
  if (!row) throw notFound('Organization');
  res.json({ organization: serialize({ ...row, role: req.orgAccess.role }) });
});

organizationRoutes.patch('/:orgId', requireOrg('org_admin'), async (req, res) => {
  const body = parseBody(UpdateBody, req);
  const row = await withOrg(req.userId, req.params.orgId, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE organizations SET name = $2, version = version + 1, updated_at = now()
       WHERE id = $1 AND ($3::int IS NULL OR version = $3) RETURNING *`,
      [req.params.orgId, body.name, body.baseVersion ?? null],
    );
    return rows[0];
  });
  if (!row) throw conflict('VERSION_CONFLICT', 'Someone else changed this organization');
  res.json({ organization: serialize({ ...row, role: req.orgAccess.role }) });
});

organizationRoutes.delete('/:orgId', requireOrg('org_admin'), async (req, res) => {
  await withOrg(req.userId, req.params.orgId, async (tx) => {
    // Announce per tenant, so every node drops sockets subscribed to them.
    const { rows } = await tx.query('SELECT id FROM tenants WHERE organization_id = $1', [req.params.orgId]);
    for (const tenant of rows) await notifyAccessChanged(tx, { tenantId: tenant.id });
    await tx.query('DELETE FROM organizations WHERE id = $1', [req.params.orgId]);
  });
  res.status(204).end();
});
