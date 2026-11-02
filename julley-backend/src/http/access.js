import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config.js';
import { resolveOrgAccess, resolveTenantAccess } from '../db/tenancy.js';
import { badRequest, forbidden, notFound, unauthorized } from './errors.js';

export const ROLE_RANK = { member: 1, tenant_admin: 2, org_admin: 3 };

const uuid = z.uuid();

export function signToken(user) {
  return jwt.sign({ sub: user.id }, config.jwtSecret, { expiresIn: config.jwtTtlSeconds });
}

/** Returns {userId, exp}, or null when the token is missing, expired or forged. */
export function verifyToken(token) {
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    return { userId: payload.sub, exp: payload.exp };
  } catch {
    return null;
  }
}

export function authenticate(req, res, next) {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const session = token && verifyToken(token);
  if (!session) throw unauthorized();
  req.userId = session.userId;
  next();
}

function hasRole(role, minimum) {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/**
 * Authorizes the :tenantId route param and attaches req.access.
 * No membership is a 404, not a 403: the response must not confirm that a
 * tenant in somebody else's organization exists.
 */
export function requireTenant(minimumRole = 'member') {
  return async (req, res, next) => {
    if (!uuid.safeParse(req.params.tenantId).success) throw notFound('Tenant');
    const access = await resolveTenantAccess(req.userId, req.params.tenantId);
    if (!access) throw notFound('Tenant');
    if (!hasRole(access.role, minimumRole)) throw forbidden();
    req.access = access;
    next();
  };
}

/** Authorizes the :orgId route param and attaches req.orgAccess. */
export function requireOrg(minimumRole = 'member') {
  return async (req, res, next) => {
    if (!uuid.safeParse(req.params.orgId).success) throw notFound('Organization');
    const access = await resolveOrgAccess(req.userId, req.params.orgId);
    if (!access) throw notFound('Organization');
    if (!hasRole(access.role, minimumRole)) throw forbidden();
    req.orgAccess = access;
    next();
  };
}

export function parseBody(schema, req) {
  const result = schema.safeParse(req.body ?? {});
  if (!result.success) {
    throw badRequest('VALIDATION_FAILED', 'Some fields are invalid', {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

/** Client-generated key that makes a mutation safe to retry after a lost response. */
export function opIdFrom(req) {
  const key = req.get('idempotency-key');
  if (!key) return null;
  if (key.length > 100) throw badRequest('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key is too long');
  return key;
}

/** A path param that must be a UUID. A malformed one simply can't match anything. */
export function idParam(req, name, what) {
  const value = req.params[name];
  if (!uuid.safeParse(value).success) throw notFound(what);
  return value;
}
