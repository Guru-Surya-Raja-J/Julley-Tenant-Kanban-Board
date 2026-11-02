import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

try {
  // Values already in the environment win over the file.
  process.loadEnvFile(join(BACKEND_ROOT, '.env'));
} catch {
  // No .env file: the defaults below are meant for local development.
}

const env = process.env;

const isProduction = env.NODE_ENV === 'production';

if (isProduction && !env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production');
}

export const config = {
  isProduction,
  port: Number(env.PORT ?? 4000),
  // Where `npm start` keeps its local PostgreSQL data.
  devDatabaseDir: env.DEV_DATABASE_DIR ?? join(BACKEND_ROOT, '.pgdata'),
  // Optional: a built julley-frontend for this server to host as well.
  frontendDist: env.FRONTEND_DIST ?? null,
  // The API connects as a non-owner role, so row-level security always applies.
  databaseUrl: env.DATABASE_URL ?? 'postgres://kanban_app:kanban_app@localhost:54329/kanban',
  // Migrations run as the database owner.
  ownerDatabaseUrl: env.OWNER_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54329/kanban',
  jwtSecret: env.JWT_SECRET ?? 'dev-only-secret-do-not-use-in-production',
  jwtTtlSeconds: Number(env.JWT_TTL_SECONDS ?? 60 * 60 * 12),
  corsOrigin: env.CORS_ORIGIN ?? 'http://localhost:5173',
  authRateLimit: Number(env.AUTH_RATE_LIMIT ?? 30),
  // When a rank key grows past this, the column's keys are rewritten.
  rebalanceKeyLength: Number(env.REBALANCE_KEY_LENGTH ?? 48),
  // A client further behind than this reloads a snapshot instead of replaying.
  maxReplayEvents: Number(env.MAX_REPLAY_EVENTS ?? 500),
  wsPingIntervalMs: Number(env.WS_PING_INTERVAL_MS ?? 30_000),
  presenceHeartbeatMs: Number(env.PRESENCE_HEARTBEAT_MS ?? 10_000),
  presenceTtlMs: Number(env.PRESENCE_TTL_MS ?? 30_000),
};
