import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { withOrg, withTenant } from '../../db/tenancy.js';
import { notifyAccessChanged, recordEvent } from '../../domain/events.js';
import { authenticate, idParam, parseBody, requireOrg, requireTenant } from '../../http/access.js';
import { badRequest, conflict, notFound } from '../../http/errors.js';

const TENANT_ROLES = z.enum(['tenant_admin', 'member']);
const AddTenantMember = z.object({ email: z.string().max(200), role: TENANT_ROLES.default('member') });
const UpdateTenantMember = z.object({ role: TENANT_ROLES });
const AddOrgAdmin = z.object({ email: z.string().max(200) });
const SearchQuery = z.object({ q: z.string().trim().min(1).max(100) });

const SEARCH_LIMIT = 8;

function parseSearch(req) {
  const query = SearchQuery.safeParse(req.query);
  if (!query.success) throw badRequest('VALIDATION_FAILED', 'Search text is required');
  // Typed text is matched literally: % and _ aren't wildcards here.
  return query.data.q.replace(/[\\%_]/g, '\\$&');
}

async function searchPeople(tx, pattern) {
  const { rows } = await tx.query('SELECT * FROM app_search_org_people($1, $2)', [pattern, SEARCH_LIMIT]);
  return rows;
}

function serialize(row) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    email: row.email,
    color: row.color,
    role: row.role,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
  };
}

async function userIdForEmail(email) {
  const { rows } = await pool.query('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
  if (!rows[0]) throw notFound('A user with that email');
  return rows[0].id;
}

async function selectMember(tx, id) {
  const { rows } = await tx.query(
    `SELECT m.*, u.name, u.email, u.color FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.id = $1`,
    [id],
  );
  return rows[0];
}

// Activity history is visible to every member, so it must not carry email addresses.
function memberEventPayload(row) {
  const member = serialize(row);
  delete member.email;
  return { member };
}

// Mounted at /api/tenants/:tenantId/members
export const tenantMemberRoutes = Router({ mergeParams: true });
tenantMemberRoutes.use(authenticate);

// Everyone in the tenant can see who else is in it (needed for assignees and
// presence). Org admins count, since they can act in every tenant.
tenantMemberRoutes.get('/', requireTenant(), async (req, res) => {
  const rows = await withTenant(req.access, async (tx) => {
    const result = await tx.query(
      `SELECT DISTINCT ON (m.user_id) m.*, u.name, u.email, u.color
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = $1 OR (m.tenant_id IS NULL AND m.organization_id = $2)
       ORDER BY m.user_id, m.role`,
      [req.access.tenantId, req.access.organizationId],
    );
    return result.rows;
  });
  rows.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ members: rows.map(serialize) });
});

// People in the organization who could be added to this tenant.
tenantMemberRoutes.get('/search', requireTenant('tenant_admin'), async (req, res) => {
  const pattern = parseSearch(req);
  res.json({ people: await withTenant(req.access, (tx) => searchPeople(tx, pattern)) });
});

tenantMemberRoutes.post('/', requireTenant('tenant_admin'), async (req, res) => {
  const body = parseBody(AddTenantMember, req);
  const userId = await userIdForEmail(body.email);
  const row = await withTenant(req.access, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO memberships (user_id, organization_id, tenant_id, role) VALUES ($1, $2, $3, $4) RETURNING id`,
      [userId, req.access.organizationId, req.access.tenantId, body.role],
    );
    const member = await selectMember(tx, rows[0].id);
    await recordEvent(tx, req.access, {
      action: 'member.added',
      entityType: 'member',
      entityId: member.id,
      payload: memberEventPayload(member),
    });
    await notifyAccessChanged(tx, { userId });
    return member;
  });
  res.status(201).json({ member: serialize(row) });
});

tenantMemberRoutes.patch('/:memberId', requireTenant('tenant_admin'), async (req, res) => {
  const id = idParam(req, 'memberId', 'Member');
  const body = parseBody(UpdateTenantMember, req);
  const row = await withTenant(req.access, async (tx) => {
    const { rowCount } = await tx.query('UPDATE memberships SET role = $2 WHERE id = $1 AND tenant_id = $3', [
      id,
      body.role,
      req.access.tenantId,
    ]);
    if (!rowCount) throw notFound('Member');
    const member = await selectMember(tx, id);
    await recordEvent(tx, req.access, {
      action: 'member.updated',
      entityType: 'member',
      entityId: id,
      payload: memberEventPayload(member),
    });
    return member;
  });
  res.json({ member: serialize(row) });
});

tenantMemberRoutes.delete('/:memberId', requireTenant('tenant_admin'), async (req, res) => {
  const id = idParam(req, 'memberId', 'Member');
  await withTenant(req.access, async (tx) => {
    const member = await selectMember(tx, id);
    if (!member || member.tenant_id !== req.access.tenantId) throw notFound('Member');
    await tx.query('DELETE FROM memberships WHERE id = $1', [id]);
    await recordEvent(tx, req.access, {
      action: 'member.removed',
      entityType: 'member',
      entityId: id,
      payload: memberEventPayload(member),
    });
    await notifyAccessChanged(tx, { userId: member.user_id });
  });
  res.status(204).end();
});

// Mounted at /api/organizations/:orgId/members
export const orgMemberRoutes = Router({ mergeParams: true });
orgMemberRoutes.use(authenticate);

orgMemberRoutes.get('/', requireOrg('org_admin'), async (req, res) => {
  const rows = await withOrg(req.userId, req.params.orgId, async (tx) => {
    const result = await tx.query(
      `SELECT m.*, u.name, u.email, u.color, t.name AS tenant_name
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN tenants t ON t.id = m.tenant_id
       WHERE m.organization_id = $1
       ORDER BY m.role, u.name`,
      [req.params.orgId],
    );
    return result.rows;
  });
  res.json({ members: rows.map(serialize) });
});

// People in the organization who aren't org admins yet.
orgMemberRoutes.get('/search', requireOrg('org_admin'), async (req, res) => {
  const pattern = parseSearch(req);
  res.json({ people: await withOrg(req.userId, req.params.orgId, (tx) => searchPeople(tx, pattern)) });
});

orgMemberRoutes.post('/', requireOrg('org_admin'), async (req, res) => {
  const body = parseBody(AddOrgAdmin, req);
  const userId = await userIdForEmail(body.email);
  const row = await withOrg(req.userId, req.params.orgId, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO memberships (user_id, organization_id, tenant_id, role) VALUES ($1, $2, NULL, 'org_admin') RETURNING id`,
      [userId, req.params.orgId],
    );
    await notifyAccessChanged(tx, { userId });
    return selectMember(tx, rows[0].id);
  });
  res.status(201).json({ member: serialize(row) });
});

orgMemberRoutes.delete('/:memberId', requireOrg('org_admin'), async (req, res) => {
  const id = idParam(req, 'memberId', 'Member');
  await withOrg(req.userId, req.params.orgId, async (tx) => {
    // Locking the org serializes removals, so two admins removing each other at
    // once can't leave the organization with nobody in charge.
    await tx.query('SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE', [req.params.orgId]);
    const member = await selectMember(tx, id);
    if (!member || member.organization_id !== req.params.orgId) throw notFound('Member');
    if (member.role === 'org_admin') {
      const { rows } = await tx.query(
        `SELECT count(*)::int AS admins FROM memberships WHERE organization_id = $1 AND role = 'org_admin'`,
        [req.params.orgId],
      );
      if (rows[0].admins <= 1) throw conflict('LAST_ORG_ADMIN', 'An organization must keep at least one admin');
    }
    await tx.query('DELETE FROM memberships WHERE id = $1', [id]);
    await notifyAccessChanged(tx, { userId: member.user_id });
  });
  res.status(204).end();
});
