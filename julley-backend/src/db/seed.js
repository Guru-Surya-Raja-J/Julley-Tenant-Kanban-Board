import { pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import { generateNKeysBetween } from 'fractional-indexing';
import pg from 'pg';
import { config } from '../config.js';
import { recordEvent } from '../domain/events.js';
import { serializeBoard } from '../modules/boards/routes.js';
import { serializeColumn } from '../modules/columns/service.js';
import { moveTask, serializeTask } from '../modules/tasks/service.js';
import { pool } from './pool.js';

export const SEED_PASSWORD = 'password123';

const USERS = [
  ['alice', 'Alice Fernandes', 'alice@acme.test', '#b5482f'],
  ['ben', 'Ben Okafor', 'ben@acme.test', '#2f6f8f'],
  ['cara', 'Cara Lindqvist', 'cara@acme.test', '#7a5c99'],
  ['dan', 'Dan Ito', 'dan@acme.test', '#3f7d5a'],
  ['gina', 'Gina Rossi', 'gina@globex.test', '#a8742a'],
  ['hank', 'Hank Weber', 'hank@globex.test', '#a33f6b'],
];

const ORGS = [
  {
    name: 'Acme Logistics',
    admins: ['alice'],
    tenants: [
      {
        name: 'Mumbai',
        members: [['ben', 'tenant_admin'], ['cara', 'member']],
        boards: [
          {
            name: 'Warehouse rollout',
            description: 'Moving the Andheri warehouse onto the new scanners.',
            // Where cards begin, and the moves that bring them to the columns listed below.
            startIn: {
              'Order 40 handheld scanners': 'Backlog',
              'Compare pilot accuracy against manual counts': 'In progress',
              'Train floor leads on handheld scanners': 'Backlog',
              'Pilot scanning in aisle 12': 'Backlog',
            },
            moves: [
              ['Order 40 handheld scanners', 'In progress', 'ben'],
              ['Compare pilot accuracy against manual counts', 'Review', 'ben'],
              ['Order 40 handheld scanners', 'Done', 'ben'],
              ['Train floor leads on handheld scanners', 'In progress', 'ben'],
              ['Pilot scanning in aisle 12', 'In progress', 'cara'],
            ],
            columns: {
              Backlog: [
                ['Audit barcode label stock', 'medium', null, ''],
                ['Draft shift plan for cutover week', 'low', 'cara', ''],
                ['Confirm spare scanner budget', 'medium', 'alice', ''],
              ],
              'In progress': [
                ['Train floor leads on handheld scanners', 'high', 'ben', 'Two sessions booked. Second one still needs a room.'],
                ['Pilot scanning in aisle 12', 'urgent', 'cara', 'Pilot started Monday. Track mis-scans per shift.'],
              ],
              Review: [['Compare pilot accuracy against manual counts', 'high', 'ben', '']],
              Done: [['Order 40 handheld scanners', 'medium', 'ben', '']],
            },
          },
          {
            name: 'Fleet maintenance',
            description: '',
            columns: {
              'To do': [['Renew permits for the Pune route', 'high', 'ben', '']],
              'In progress': [],
              Done: [],
            },
          },
        ],
      },
      {
        name: 'Berlin',
        members: [['dan', 'tenant_admin'], ['cara', 'member']],
        boards: [
          {
            name: 'Customs paperwork',
            description: '',
            columns: {
              'To do': [['Update EORI records', 'high', 'dan', '']],
              'In progress': [['Reconcile Q3 duty invoices', 'medium', 'cara', '']],
              Done: [],
            },
          },
        ],
      },
    ],
  },
  {
    name: 'Globex Retail',
    admins: ['gina'],
    tenants: [
      {
        name: 'Austin',
        members: [['hank', 'member']],
        boards: [
          {
            name: 'Store opening',
            description: '',
            columns: {
              'To do': [['Sign the signage contract', 'urgent', 'hank', '']],
              Doing: [],
              Done: [],
            },
          },
        ],
      },
    ],
  },
];

async function insertBoard(client, ids, tenantId, ownerId, board) {
  const access = { tenantId, userId: ownerId };
  const { rows } = await client.query(
    'INSERT INTO boards (tenant_id, name, description, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
    [tenantId, board.name, board.description, ownerId],
  );
  const boardId = rows[0].id;
  const columnNames = Object.keys(board.columns);
  const columnKeys = generateNKeysBetween(null, null, columnNames.length);
  const columns = [];
  for (const [c, columnName] of columnNames.entries()) {
    const column = await client.query(
      'INSERT INTO columns (tenant_id, board_id, name, position) VALUES ($1, $2, $3, $4) RETURNING *',
      [tenantId, boardId, columnName, columnKeys[c]],
    );
    columns.push(column.rows[0]);
  }
  await recordEvent(client, access, {
    action: 'board.created',
    entityType: 'board',
    entityId: boardId,
    boardId,
    payload: { board: serializeBoard(rows[0]), columns: columns.map(serializeColumn) },
  });

  const startingColumn = Object.fromEntries(columnNames.map((name) => [name, []]));
  for (const name of columnNames) {
    for (const task of board.columns[name]) startingColumn[board.startIn?.[task[0]] ?? name].push(task);
  }

  const taskIds = {};
  for (const column of columns) {
    const tasks = startingColumn[column.name];
    const taskKeys = generateNKeysBetween(null, null, tasks.length);
    for (const [t, [title, priority, assignee, description]] of tasks.entries()) {
      const inserted = await client.query(
        `INSERT INTO tasks (tenant_id, board_id, column_id, title, description, priority, assignee_id, position, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [tenantId, boardId, column.id, title, description, priority, assignee ? ids[assignee] : null, taskKeys[t], ownerId],
      );
      taskIds[title] = inserted.rows[0].id;
      await recordEvent(client, access, {
        action: 'task.created',
        entityType: 'task',
        entityId: inserted.rows[0].id,
        boardId,
        payload: { task: serializeTask(inserted.rows[0]) },
      });
    }
  }

  const columnIds = Object.fromEntries(columns.map((column) => [column.name, column.id]));
  return (board.moves ?? []).map(([title, column, user]) => ({
    tenantId,
    userId: ids[user],
    taskId: taskIds[title],
    columnId: columnIds[column],
  }));
}

/** Demo data. Runs as the owner, and only into an empty database. */
export async function seed() {
  const client = new pg.Client({ connectionString: config.ownerDatabaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT count(*)::int AS n FROM users');
    if (rows[0].n > 0) return false;

    await client.query('BEGIN');
    const hash = await bcrypt.hash(SEED_PASSWORD, 10);
    const ids = {};
    const moves = [];
    for (const [key, name, email, color] of USERS) {
      const res = await client.query(
        'INSERT INTO users (email, name, password_hash, color) VALUES ($1, $2, $3, $4) RETURNING id',
        [email, name, hash, color],
      );
      ids[key] = res.rows[0].id;
    }

    for (const org of ORGS) {
      const created = await client.query('INSERT INTO organizations (name) VALUES ($1) RETURNING id', [org.name]);
      const orgId = created.rows[0].id;
      for (const admin of org.admins) {
        await client.query(
          `INSERT INTO memberships (user_id, organization_id, tenant_id, role) VALUES ($1, $2, NULL, 'org_admin')`,
          [ids[admin], orgId],
        );
      }
      for (const tenant of org.tenants) {
        const inserted = await client.query(
          'INSERT INTO tenants (organization_id, name) VALUES ($1, $2) RETURNING id',
          [orgId, tenant.name],
        );
        const tenantId = inserted.rows[0].id;
        for (const [member, role] of tenant.members) {
          await client.query(
            'INSERT INTO memberships (user_id, organization_id, tenant_id, role) VALUES ($1, $2, $3, $4)',
            [ids[member], orgId, tenantId, role],
          );
        }
        for (const board of tenant.boards) {
          moves.push(...(await insertBoard(client, ids, tenantId, ids[org.admins[0]], board)));
        }
      }
    }
    await client.query('COMMIT');

    // After commit, and through the real service, as the people who made them.
    for (const { tenantId, userId, taskId, columnId } of moves) {
      await moveTask({ tenantId, userId }, taskId, { columnId, baseVersion: 0 });
    }
    // Spread the history out, so it reads like days of work rather than one second.
    await client.query(`
      UPDATE activity_logs a SET created_at = now() - (t.event_seq - a.seq) * interval '53 minutes'
      FROM tenants t WHERE t.id = a.tenant_id`);
    console.log('[seed] demo data created');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  seed()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
