import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { withOrg, withOrgTenant, withTenant, withUser } from '../../db/tenancy.js';
import { notifyAccessChanged, recordEvent } from '../../domain/events.js';
import { authenticate, parseBody, requireOrg, requireTenant } from '../../http/access.js';
import { conflict } from '../../http/errors.js';

const CreateBody = z.object({ name: z.string().trim().min(1).max(120) });
const UpdateBody = z.object({
  name: z.string().trim().min(1).max(120),
  baseVersion: z.number().int().optional(),
});

function serialize(row, role) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    version: row.version,
    role: role ?? row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Mounted at /api/organizations/:orgId/tenants
export const orgTenantRoutes = Router({ mergeParams: true });
orgTenantRoutes.use(authenticate);

orgTenantRoutes.get('/', requireOrg(), async (req, res) => {
  // RLS reveals every tenant to an org admin, and only their own to anyone else.
  const rows = await withUser(req.userId, async (tx) => {
    const result = await tx.query(
      `SELECT t.*, (SELECT m.role FROM memberships m
                    WHERE m.organization_id = t.organization_id AND m.user_id = $1
                      AND (m.tenant_id IS NULL OR m.tenant_id = t.id)
                    ORDER BY m.role LIMIT 1) AS role
       FROM tenants t WHERE t.organization_id = $2 ORDER BY t.name`,
      [req.userId, req.params.orgId],
    );
    return result.rows;
  });
  res.json({ tenants: rows.map((row) => serialize(row)) });
});

orgTenantRoutes.post('/', requireOrg('org_admin'), async (req, res) => {
  const body = parseBody(CreateBody, req);
  const id = randomUUID();
  const access = { userId: req.userId, tenantId: id };
  const row = await withOrgTenant(req.userId, req.params.orgId, id, async (tx) => {
    const { rows } = await tx.query(
      'INSERT INTO tenants (id, organization_id, name) VALUES ($1, $2, $3) RETURNING *',
      [id, req.params.orgId, body.name],
    );
    await recordEvent(tx, access, {
      action: 'tenant.created',
      entityType: 'tenant',
      entityId: id,
      payload: { tenant: serialize(rows[0], 'org_admin') },
    });
    return rows[0];
  });
  res.status(201).json({ tenant: serialize(row, 'org_admin') });
});

// Mounted at /api/tenants
export const tenantRoutes = Router();
tenantRoutes.use(authenticate);

tenantRoutes.get('/:tenantId', requireTenant(), async (req, res) => {
  const row = await withTenant(req.access, async (tx) => {
    const { rows } = await tx.query('SELECT * FROM tenants WHERE id = $1', [req.access.tenantId]);
    return rows[0];
  });
  res.json({ tenant: serialize(row, req.access.role) });
});

tenantRoutes.patch('/:tenantId', requireTenant('tenant_admin'), async (req, res) => {
  const body = parseBody(UpdateBody, req);
  const row = await withTenant(req.access, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE tenants SET name = $2, version = version + 1, updated_at = now()
       WHERE id = $1 AND ($3::int IS NULL OR version = $3) RETURNING *`,
      [req.access.tenantId, body.name, body.baseVersion ?? null],
    );
    if (!rows[0]) throw conflict('VERSION_CONFLICT', 'Someone else changed this branch');
    await recordEvent(tx, req.access, {
      action: 'tenant.updated',
      entityType: 'tenant',
      entityId: rows[0].id,
      payload: { tenant: serialize(rows[0], req.access.role) },
    });
    return rows[0];
  });
  res.json({ tenant: serialize(row, req.access.role) });
});

tenantRoutes.delete('/:tenantId', requireTenant('org_admin'), async (req, res) => {
  await withOrg(req.userId, req.access.organizationId, async (tx) => {
    await notifyAccessChanged(tx, { tenantId: req.access.tenantId });
    await tx.query('DELETE FROM tenants WHERE id = $1', [req.access.tenantId]);
  });
  res.status(204).end();
});
