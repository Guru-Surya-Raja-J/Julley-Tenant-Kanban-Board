import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { pool } from '../src/db/pool.js';
import { createTask, createWorld, registerUser, startTestNode } from './helpers.js';

describe('role-based access control', () => {
  let node;
  let world;
  const tenantPath = () => `/tenants/${world.tenant.id}`;

  before(async () => {
    node = await startTestNode();
    world = await createWorld(node.baseUrl, 'Rbac');
  });

  after(async () => {
    await node.stop();
    await pool.end();
  });

  describe('Member', () => {
    it('can create, edit, move and delete tasks', async () => {
      const task = await createTask(world.member, world.tenant.id, world.columns[0].id);
      const edit = await world.member.patch(`${tenantPath()}/tasks/${task.id}`, {
        patch: { title: 'Edited' },
        baseVersion: task.version,
      });
      assert.equal(edit.status, 200);
      const move = await world.member.post(`${tenantPath()}/tasks/${task.id}/move`, {
        columnId: world.columns[1].id,
        baseVersion: edit.body.task.version,
      });
      assert.equal(move.status, 200);
      assert.equal((await world.member.del(`${tenantPath()}/tasks/${task.id}`)).status, 200);
    });

    it('can read boards, activity and members', async () => {
      assert.equal((await world.member.get(`${tenantPath()}/boards`)).status, 200);
      assert.equal((await world.member.get(`${tenantPath()}/activity`)).status, 200);
      assert.equal((await world.member.get(`${tenantPath()}/members`)).status, 200);
    });

    it('can read columns, in order', async () => {
      const list = await world.member.get(`${tenantPath()}/boards/${world.board.id}/columns`);
      assert.deepEqual(list.body.columns.map((c) => c.id), world.columns.map((c) => c.id));
      const one = await world.member.get(`${tenantPath()}/columns/${world.columns[0].id}`);
      assert.equal(one.body.column.name, world.columns[0].name);
    });

    it("can't read another tenant's columns through their own tenant's URL", async () => {
      const foreign = await createWorld(node.baseUrl, 'Column Foreign');
      assert.equal((await world.member.get(`${tenantPath()}/columns/${foreign.columns[0].id}`)).status, 404);
      assert.equal((await world.member.get(`${tenantPath()}/boards/${foreign.board.id}/columns`)).status, 404);
    });

    it('cannot change boards or columns', async () => {
      const column = world.columns[0];
      const attempts = [
        world.member.post(`${tenantPath()}/boards`, { name: 'No' }),
        world.member.patch(`${tenantPath()}/boards/${world.board.id}`, { patch: { name: 'No' }, baseVersion: 1 }),
        world.member.del(`${tenantPath()}/boards/${world.board.id}`),
        world.member.post(`${tenantPath()}/boards/${world.board.id}/columns`, { name: 'No' }),
        world.member.patch(`${tenantPath()}/columns/${column.id}`, { patch: { name: 'No' }, baseVersion: 1 }),
        world.member.post(`${tenantPath()}/columns/${column.id}/move`, { baseVersion: 1 }),
        world.member.del(`${tenantPath()}/columns/${column.id}`),
      ];
      for (const res of await Promise.all(attempts)) assert.equal(res.status, 403);
    });

    it('cannot manage the tenant, its members or the organization', async () => {
      const outsider = await registerUser(node.baseUrl, 'Outsider');
      const attempts = [
        world.member.patch(tenantPath(), { name: 'No' }),
        world.member.del(tenantPath()),
        world.member.post(`${tenantPath()}/members`, { email: outsider.email }),
        world.member.patch(`/organizations/${world.org.id}`, { name: 'No' }),
        world.member.del(`/organizations/${world.org.id}`),
        world.member.get(`/organizations/${world.org.id}/members`),
        world.member.post(`/organizations/${world.org.id}/tenants`, { name: 'No' }),
      ];
      for (const res of await Promise.all(attempts)) assert.equal(res.status, 403);
    });
  });

  describe('Tenant Admin', () => {
    it('can manage boards and columns', async () => {
      const board = await world.tenantAdmin.post(`${tenantPath()}/boards`, { name: 'Admin board' });
      assert.equal(board.status, 201);
      const column = await world.tenantAdmin.post(`${tenantPath()}/boards/${board.body.board.id}/columns`, { name: 'New' });
      assert.equal(column.status, 201);
      assert.equal((await world.tenantAdmin.del(`${tenantPath()}/columns/${column.body.column.id}`)).status, 200);
      assert.equal((await world.tenantAdmin.del(`${tenantPath()}/boards/${board.body.board.id}`)).status, 204);
    });

    it('can rename the tenant and manage its members', async () => {
      assert.equal((await world.tenantAdmin.patch(tenantPath(), { name: 'Renamed' })).status, 200);
      const outsider = await registerUser(node.baseUrl, 'Hire');
      const added = await world.tenantAdmin.post(`${tenantPath()}/members`, { email: outsider.email });
      assert.equal(added.status, 201);
      const promoted = await world.tenantAdmin.patch(`${tenantPath()}/members/${added.body.member.id}`, { role: 'tenant_admin' });
      assert.equal(promoted.body.member.role, 'tenant_admin');
      assert.equal((await world.tenantAdmin.del(`${tenantPath()}/members/${added.body.member.id}`)).status, 204);
    });

    it('cannot grant org_admin, by any route', async () => {
      const outsider = await registerUser(node.baseUrl, 'Climber');
      const viaTenant = await world.tenantAdmin.post(`${tenantPath()}/members`, { email: outsider.email, role: 'org_admin' });
      assert.equal(viaTenant.status, 400);
      const viaOrg = await world.tenantAdmin.post(`/organizations/${world.org.id}/members`, { email: outsider.email });
      assert.equal(viaOrg.status, 403);
    });

    it('cannot delete the tenant or create sibling tenants', async () => {
      assert.equal((await world.tenantAdmin.del(tenantPath())).status, 403);
      assert.equal((await world.tenantAdmin.post(`/organizations/${world.org.id}/tenants`, { name: 'No' })).status, 403);
    });

    it("cannot touch a membership outside their tenant, even knowing its id", async () => {
      const { body } = await world.orgAdmin.get(`/organizations/${world.org.id}/members`);
      const orgAdminRow = body.members.find((m) => m.role === 'org_admin');
      const res = await world.tenantAdmin.del(`${tenantPath()}/members/${orgAdminRow.id}`);
      assert.equal(res.status, 404);
    });

    it('has no admin powers in another tenant of the organization', async () => {
      const other = (await world.orgAdmin.post(`/organizations/${world.org.id}/tenants`, { name: 'Elsewhere' })).body.tenant;
      assert.equal((await world.tenantAdmin.get(`/tenants/${other.id}`)).status, 404);
    });
  });

  describe('Org Admin', () => {
    it('can enter every tenant without a tenant membership', async () => {
      const task = await createTask(world.orgAdmin, world.tenant.id, world.columns[0].id, 'From the org admin');
      assert.equal(task.title, 'From the org admin');
    });

    it('creates, renames and deletes tenants', async () => {
      const created = await world.orgAdmin.post(`/organizations/${world.org.id}/tenants`, { name: 'Temporary' });
      assert.equal(created.status, 201);
      const id = created.body.tenant.id;
      assert.equal((await world.orgAdmin.patch(`/tenants/${id}`, { name: 'Temp 2' })).status, 200);
      assert.equal((await world.orgAdmin.del(`/tenants/${id}`)).status, 204);
      assert.equal((await world.orgAdmin.get(`/tenants/${id}`)).status, 404);
    });

    it('cannot remove the last org admin', async () => {
      const { body } = await world.orgAdmin.get(`/organizations/${world.org.id}/members`);
      const self = body.members.find((m) => m.role === 'org_admin');
      const res = await world.orgAdmin.del(`/organizations/${world.org.id}/members/${self.id}`);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'LAST_ORG_ADMIN');
    });

    it('two admins removing each other at once leaves one standing', async () => {
      const second = await registerUser(node.baseUrl, 'Second Admin');
      const third = await world.orgAdmin.post('/organizations', { name: 'Duel Org' });
      const org = third.body.organization;
      const added = await world.orgAdmin.post(`/organizations/${org.id}/members`, { email: second.email });
      const { body } = await world.orgAdmin.get(`/organizations/${org.id}/members`);
      const first = body.members.find((m) => m.userId === world.orgAdmin.user.id);

      const results = await Promise.all([
        world.orgAdmin.del(`/organizations/${org.id}/members/${added.body.member.id}`),
        second.del(`/organizations/${org.id}/members/${first.id}`),
      ]);
      const successes = results.filter((r) => r.status === 204).length;
      assert.equal(successes, 1, JSON.stringify(results.map((r) => r.status)));
    });

    it('any signed-in user can create an organization and becomes its admin', async () => {
      const founder = await registerUser(node.baseUrl, 'Founder');
      const res = await founder.post('/organizations', { name: 'New Co' });
      assert.equal(res.status, 201);
      assert.equal(res.body.organization.role, 'org_admin');
    });

    it('deleting an organization removes everything beneath it', async () => {
      const temp = await createWorld(node.baseUrl, 'Doomed');
      assert.equal((await temp.orgAdmin.del(`/organizations/${temp.org.id}`)).status, 204);
      assert.equal((await temp.member.get(`/tenants/${temp.tenant.id}`)).status, 404);
      assert.equal((await temp.orgAdmin.get(`/organizations/${temp.org.id}`)).status, 404);
    });
  });

  describe('People search', () => {
    let search;
    let sibling;
    let colleague;
    let outsider;

    before(async () => {
      search = (client, q) => client.get(`${tenantPath()}/members/search?q=${encodeURIComponent(q)}`);
      // A colleague in a sibling branch, and a stranger in another organization.
      sibling = (await world.orgAdmin.post(`/organizations/${world.org.id}/tenants`, { name: 'Sibling Search' })).body.tenant;
      colleague = await registerUser(node.baseUrl, 'Zelda Colleague');
      await world.orgAdmin.post(`/tenants/${sibling.id}/members`, { email: colleague.email });
      const foreign = await createWorld(node.baseUrl, 'Zelda Foreign');
      outsider = foreign.member;
    });

    it('finds people in the organization by the first letters of a name or email', async () => {
      const byName = await search(world.tenantAdmin, 'zel');
      assert.deepEqual(byName.body.people.map((p) => p.id), [colleague.user.id]);
      const byEmail = await search(world.tenantAdmin, colleague.email.slice(0, 8));
      assert.ok(byEmail.body.people.some((p) => p.id === colleague.user.id));
    });

    it('never reveals people from another organization', async () => {
      const { body } = await search(world.tenantAdmin, 'zelda');
      assert.ok(!body.people.some((p) => p.id === outsider.user.id));
      const direct = await search(world.tenantAdmin, outsider.email);
      assert.deepEqual(direct.body.people, []);
    });

    it('leaves out people already in the tenant, and org admins', async () => {
      const member = await search(world.tenantAdmin, world.member.email);
      assert.deepEqual(member.body.people, []);
      const admin = await search(world.tenantAdmin, world.orgAdmin.email);
      assert.deepEqual(admin.body.people, []);
    });

    it('treats wildcards in the search text literally', async () => {
      const { body } = await search(world.tenantAdmin, '%');
      assert.deepEqual(body.people, []);
      const underscore = await search(world.tenantAdmin, '_');
      assert.deepEqual(underscore.body.people, []);
    });

    it('returns only what the picker needs', async () => {
      const { body } = await search(world.tenantAdmin, 'zel');
      assert.deepEqual(Object.keys(body.people[0]).sort(), ['color', 'email', 'id', 'name']);
    });

    it('is for admins: members get 403, strangers 404, and empty text is refused', async () => {
      assert.equal((await search(world.member, 'zel')).status, 403);
      assert.equal((await search(outsider, 'zel')).status, 404);
      assert.equal((await search(world.tenantAdmin, ' ')).status, 400);
    });

    it('lets an org admin search for people who could become org admins', async () => {
      const path = `/organizations/${world.org.id}/members/search`;
      const { body } = await world.orgAdmin.get(`${path}?q=zel`);
      assert.deepEqual(body.people.map((p) => p.id), [colleague.user.id]);
      const self = await world.orgAdmin.get(`${path}?q=${encodeURIComponent(world.orgAdmin.email)}`);
      assert.deepEqual(self.body.people, []);
      assert.equal((await world.tenantAdmin.get(`${path}?q=zel`)).status, 403);
    });

    it('returns nothing to a connection with no scope set', async () => {
      const { rows } = await pool.query(`SELECT * FROM app_search_org_people('zel', 8)`);
      assert.deepEqual(rows, []);
    });
  });

  describe('Validation', () => {
    it('rejects unknown patch fields, so tenant_id cannot be rewritten', async () => {
      const task = await createTask(world.member, world.tenant.id, world.columns[0].id);
      const res = await world.member.patch(`${tenantPath()}/tasks/${task.id}`, {
        patch: { tenantId: '00000000-0000-4000-8000-000000000000' },
        baseVersion: task.version,
      });
      assert.equal(res.status, 400);
    });

    it('returns structured errors for bad input', async () => {
      const res = await world.member.post(`${tenantPath()}/tasks`, { columnId: 'nope', title: '' });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_FAILED');
      assert.ok(res.body.error.details.issues.length >= 2);
    });

    it('treats a malformed id as not found', async () => {
      const res = await world.member.get(`${tenantPath()}/tasks/not-a-uuid`);
      assert.equal(res.status, 404);
    });
  });
});
