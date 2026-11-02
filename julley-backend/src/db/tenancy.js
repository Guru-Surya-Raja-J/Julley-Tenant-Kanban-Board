import { transaction } from './pool.js';

// The only ways business code reaches the database. Each opens a transaction with
// its RLS scope applied, so the scope is decided once rather than per query.

/** Scope: what this user can see by their own memberships. */
export function withUser(userId, fn) {
  return transaction({ userId }, fn);
}

/** Scope: a whole organization. Only call after verifying the caller may act on it. */
export function withOrg(userId, orgId, fn) {
  return transaction({ userId, orgId }, fn);
}

/** Scope: one tenant, for a caller already authorized by requireTenant. */
export function withTenant(access, fn, options) {
  return transaction(
    { userId: access.userId, tenantId: access.tenantId },
    fn,
    options,
  );
}

/** Scope: a tenant and its organization, for org admins creating or deleting tenants. */
export function withOrgTenant(userId, orgId, tenantId, fn) {
  return transaction({ userId, orgId, tenantId }, fn);
}

/** Scope: one tenant with no user, for the realtime hub reading its own event log. */
export function withTenantSystem(tenantId, fn) {
  return transaction({ tenantId }, fn);
}

const ACCESS_SQL = `
  SELECT t.id AS tenant_id, t.organization_id, m.role
  FROM tenants t
  JOIN memberships m
    ON m.organization_id = t.organization_id
   AND m.user_id = $1
   AND (m.tenant_id IS NULL OR m.tenant_id = t.id)
  WHERE t.id = $2
  ORDER BY m.role  -- enum order: org_admin outranks tenant_admin outranks member
  LIMIT 1`;

/** The single source of truth for "may this user enter this tenant, and as what?" */
export async function resolveTenantAccess(userId, tenantId) {
  const row = await withUser(userId, async (tx) => {
    const { rows } = await tx.query(ACCESS_SQL, [userId, tenantId]);
    return rows[0];
  });
  if (!row) return null;
  return {
    userId,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    role: row.role,
  };
}

/** The caller's org-wide role, or null if they have no membership in the org at all. */
export async function resolveOrgAccess(userId, organizationId) {
  const rows = await withUser(userId, async (tx) => {
    const result = await tx.query(
      `SELECT role FROM memberships
       WHERE user_id = $1 AND organization_id = $2
       ORDER BY role LIMIT 1`,
      [userId, organizationId],
    );
    return result.rows;
  });
  if (!rows[0]) return null;
  return { userId, organizationId, role: rows[0].role };
}
