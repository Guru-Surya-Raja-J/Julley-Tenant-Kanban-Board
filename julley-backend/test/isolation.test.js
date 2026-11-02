import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { pool } from '../src/db/pool.js';
import { appRoleClient, createTask, createWorld, startTestNode } from './helpers.js';

describe('tenant and organization isolation', () => {
  let node;
  let acme; // two tenants in one org
  let acmeOtherTenant;
  let globex; // a different org
  let acmeTask;
  let globexTask;

  before(async () => {
    node = await startTestNode();
    acme = await createWorld(node.baseUrl, 'Acme');
    globex = await createWorld(node.baseUrl, 'Globex');
    acmeOtherTenant = (await acme.orgAdmin.post(`/organizations/${acme.org.id}/tenants`, { name: 'Second' })).body.tenant;
    acmeTask = await createTask(acme.member, acme.tenant.id, acme.columns[0].id, 'Acme secret');
    globexTask = await createTask(globex.member, globex.tenant.id, globex.columns[0].id, 'Globex secret');
  });

  after(async () => {
    await node.stop();
    await pool.end();
  });

  describe('through the API', () => {
    it("answers 404, never 403, for another organization's tenant", async () => {
      const res = await acme.orgAdmin.get(`/tenants/${globex.tenant.id}`);
      assert.equal(res.status, 404);
    });

    it('gives an unknown tenant and a foreign tenant the same response', async () => {
      const foreign = await acme.member.get(`/tenants/${globex.tenant.id}/boards`);
      const unknown = await acme.member.get('/tenants/00000000-0000-4000-8000-000000000000/boards');
      assert.equal(foreign.status, unknown.status);
      assert.deepEqual(foreign.body, unknown.body);
    });

    it('does not list foreign organizations or tenants', async () => {
      const orgs = await acme.member.get('/organizations');
      assert.deepEqual(orgs.body.organizations.map((o) => o.id), [acme.org.id]);
      const tenants = await acme.member.get(`/organizations/${globex.org.id}/tenants`);
      assert.equal(tenants.status, 404);
    });

    it('hides sibling tenants in the same organization from a tenant member', async () => {
      const tenants = await acme.member.get(`/organizations/${acme.org.id}/tenants`);
      assert.deepEqual(tenants.body.tenants.map((t) => t.id), [acme.tenant.id]);
      const direct = await acme.member.get(`/tenants/${acmeOtherTenant.id}`);
      assert.equal(direct.status, 404);
    });

    it('shows an org admin every tenant in their organization', async () => {
      const tenants = await acme.orgAdmin.get(`/organizations/${acme.org.id}/tenants`);
      assert.equal(tenants.body.tenants.length, 2);
    });

    it("does not resolve another tenant's task through your own tenant's URL", async () => {
      // The user legitimately belongs to the tenant in the URL; the task does not.
      const read = await acme.member.get(`/tenants/${acme.tenant.id}/tasks/${globexTask.id}`);
      assert.equal(read.status, 404);
      const write = await acme.member.patch(`/tenants/${acme.tenant.id}/tasks/${globexTask.id}`, {
        patch: { title: 'hacked' },
        baseVersion: 1,
      });
      assert.equal(write.status, 404);
      const remove = await acme.member.del(`/tenants/${acme.tenant.id}/tasks/${globexTask.id}`);
      assert.equal(remove.status, 404);
      const check = await globex.member.get(`/tenants/${globex.tenant.id}/tasks/${globexTask.id}`);
      assert.equal(check.body.task.title, 'Globex secret');
    });

    it("cannot create a task in another tenant's column", async () => {
      const res = await acme.member.post(`/tenants/${acme.tenant.id}/tasks`, {
        columnId: globex.columns[0].id,
        title: 'smuggled',
      });
      assert.equal(res.status, 404);
    });

    it("cannot move a task into another tenant's column", async () => {
      const res = await acme.member.post(`/tenants/${acme.tenant.id}/tasks/${acmeTask.id}/move`, {
        columnId: globex.columns[0].id,
        baseVersion: acmeTask.version,
      });
      assert.equal(res.status, 404);
    });

    it("cannot read another tenant's board or activity", async () => {
      const board = await acme.member.get(`/tenants/${acme.tenant.id}/boards/${globex.board.id}`);
      assert.equal(board.status, 404);
      const activity = await acme.member.get(`/tenants/${globex.tenant.id}/activity`);
      assert.equal(activity.status, 404);
    });

    it('does not show foreign events in activity', async () => {
      const { body } = await acme.member.get(`/tenants/${acme.tenant.id}/activity`);
      assert.ok(body.events.length > 0);
      assert.ok(body.events.every((event) => event.tenantId === acme.tenant.id));
      assert.ok(!JSON.stringify(body).includes('Globex secret'));
    });

    it('cannot assign a task to a user outside the tenant', async () => {
      const res = await acme.member.patch(`/tenants/${acme.tenant.id}/tasks/${acmeTask.id}`, {
        patch: { assigneeId: globex.member.user.id },
        baseVersion: acmeTask.version,
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'INVALID_ASSIGNEE');
    });

    it('rejects a client-chosen id that already exists in another tenant', async () => {
      const res = await acme.member.post(`/tenants/${acme.tenant.id}/tasks`, {
        id: globexTask.id,
        columnId: acme.columns[0].id,
        title: 'collision',
      });
      assert.equal(res.status, 409);
      assert.ok(!JSON.stringify(res.body).includes('Globex'));
    });

    it('rejects requests without a valid token', async () => {
      const res = await fetch(`${node.baseUrl}/api/tenants/${acme.tenant.id}/boards`);
      assert.equal(res.status, 401);
      const forged = await fetch(`${node.baseUrl}/api/organizations`, {
        headers: { authorization: 'Bearer not.a.token' },
      });
      assert.equal(forged.status, 401);
    });
  });

  describe('in the database, as the API role', () => {
    let db;
    before(async () => {
      db = await appRoleClient();
    });
    after(() => db.end());

    const inTenant = async (tenantId, fn) => {
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      try {
        return await fn();
      } finally {
        await db.query('ROLLBACK');
      }
    };

    it('returns no rows at all when no tenant is set (fails closed)', async () => {
      for (const table of ['boards', 'columns', 'tasks', 'activity_logs']) {
        const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${table}`);
        assert.equal(rows[0].n, 0, table);
      }
    });

    it('filters a query that has no WHERE clause down to the current tenant', async () => {
      const titles = await inTenant(acme.tenant.id, async () => {
        const { rows } = await db.query('SELECT DISTINCT tenant_id FROM tasks');
        return rows;
      });
      assert.deepEqual(titles.map((r) => r.tenant_id), [acme.tenant.id]);
    });

    it("cannot update another tenant's rows", async () => {
      const count = await inTenant(acme.tenant.id, async () => {
        const { rowCount } = await db.query(`UPDATE tasks SET title = 'hacked' WHERE id = $1`, [globexTask.id]);
        return rowCount;
      });
      assert.equal(count, 0);
    });

    it('cannot insert a row into another tenant', async () => {
      await assert.rejects(
        inTenant(acme.tenant.id, () =>
          db.query(`INSERT INTO boards (tenant_id, name) VALUES ($1, 'smuggled')`, [globex.tenant.id]),
        ),
        /row-level security/,
      );
    });

    it('cannot delete or rewrite the audit trail', async () => {
      await assert.rejects(
        inTenant(acme.tenant.id, () => db.query('DELETE FROM activity_logs')),
        /permission denied/,
      );
      await assert.rejects(
        inTenant(acme.tenant.id, () => db.query(`UPDATE activity_logs SET action = 'x'`)),
        /permission denied/,
      );
    });

    it('does not leak the tenant setting across transactions', async () => {
      await inTenant(acme.tenant.id, () => db.query('SELECT 1'));
      const { rows } = await db.query('SELECT count(*)::int AS n FROM tasks');
      assert.equal(rows[0].n, 0);
    });

    it('runs as a role that cannot bypass row-level security', async () => {
      const { rows } = await db.query(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      );
      assert.deepEqual(rows[0], { rolsuper: false, rolbypassrls: false });
    });
  });

  describe('in the database, with RLS out of the way', () => {
    it('rejects a task pointing at a column in another tenant, even as superuser', async () => {
      const { default: pg } = await import('pg');
      const owner = new pg.Client({ connectionString: process.env.OWNER_DATABASE_URL });
      await owner.connect();
      try {
        await assert.rejects(
          owner.query(
            `INSERT INTO tasks (tenant_id, board_id, column_id, title, position) VALUES ($1, $2, $3, 'x', 'a0')`,
            [acme.tenant.id, acme.board.id, globex.columns[0].id],
          ),
          /foreign key/,
        );
        await assert.rejects(
          owner.query(
            `INSERT INTO memberships (user_id, organization_id, tenant_id, role) VALUES ($1, $2, $3, 'member')`,
            [acme.member.user.id, acme.org.id, globex.tenant.id],
          ),
          /foreign key/,
        );
      } finally {
        await owner.end();
      }
    });
  });
});
