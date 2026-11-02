import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { errorHandler, notFound } from './http/errors.js';
import { activityRoutes } from './modules/activity/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { boardRoutes } from './modules/boards/routes.js';
import { columnRoutes } from './modules/columns/routes.js';
import { orgMemberRoutes, tenantMemberRoutes } from './modules/members/routes.js';
import { organizationRoutes } from './modules/organizations/routes.js';
import { taskRoutes } from './modules/tasks/routes.js';
import { orgTenantRoutes, tenantRoutes } from './modules/tenants/routes.js';
import { Hub } from './realtime/hub.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { connectSrc: ["'self'", 'ws:', 'wss:'] },
      },
    }),
  );
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', async (req, res) => {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/organizations', organizationRoutes);
  app.use('/api/organizations/:orgId/tenants', orgTenantRoutes);
  app.use('/api/organizations/:orgId/members', orgMemberRoutes);
  app.use('/api/tenants/:tenantId/members', tenantMemberRoutes);
  app.use('/api/tenants/:tenantId/boards', boardRoutes);
  app.use('/api/tenants/:tenantId/activity', activityRoutes);
  app.use('/api/tenants/:tenantId', columnRoutes);
  app.use('/api/tenants/:tenantId', taskRoutes);
  app.use('/api/tenants', tenantRoutes);

  app.use('/api', (req, res, next) => next(notFound('Route')));

  // Optional, for hosting the built frontend from one origin. See FRONTEND_DIST.
  if (config.frontendDist && existsSync(config.frontendDist)) {
    app.use(express.static(config.frontendDist));
    app.get('/{*path}', (req, res) => res.sendFile(join(config.frontendDist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}

/** Boots one node: HTTP, WebSocket hub and bus. Resolves once it is accepting traffic. */
export async function startNode({ port = config.port } = {}) {
  const server = createServer(createApp());
  const hub = new Hub(server);
  await hub.start();
  await new Promise((resolve) => server.listen(port, resolve));
  return {
    port: server.address().port,
    hub,
    async stop() {
      await hub.stop();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
