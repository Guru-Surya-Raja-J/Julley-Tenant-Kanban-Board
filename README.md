# Tenant Flow

A real-time collaborative Kanban board for organizations and their branches (tenants), with strict
data isolation, live sync, presence, optimistic updates, undo/redo and conflict resolution.

| Document | Contents |
|---|---|
| [overview.md](overview.md) | The assignment in full, every design decision, requirement traceability |
| [docs/API.md](docs/API.md) | REST reference |
| [docs/WEBSOCKET.md](docs/WEBSOCKET.md) | WebSocket protocol reference |
| [docs/DATABASE.md](docs/DATABASE.md) | Schema, ER diagram, isolation policies |
| [docs/BENCHMARKS.md](docs/BENCHMARKS.md) | Measured throughput and latency, and what wasn't measured |

## Run it

Requires Node 22 or newer. Nothing else: PostgreSQL comes from npm. Use two terminals.

**Terminal 1: backend**

```bash
cd julley-backend
npm install
npm start
```

This starts PostgreSQL (data in `julley-backend/.pgdata/`), migrates and seeds it, and runs the API on
port 4000 under **nodemon**, so saving a backend file restarts the API automatically. The database keeps
running through those restarts.

**Terminal 2: frontend**

```bash
cd julley-frontend
npm install
npm run dev
```

Open http://localhost:5173. Vite forwards `/api` and `/ws` to the backend.

**Try the real-time features:** open two browser windows (one private), sign in as `ben@acme.test` and
`cara@acme.test`, select the Mumbai branch in both, and drag a card. The sign-in page lists these
accounts in development.

| Account (password `password123`) | Role |
|---|---|
| `alice@acme.test` | Org Admin, Acme Logistics (Mumbai, Berlin) |
| `ben@acme.test` | Tenant Admin, Mumbai |
| `dan@acme.test` | Tenant Admin, Berlin |
| `cara@acme.test` | Member, Mumbai and Berlin |
| `gina@globex.test` | Org Admin, Globex Retail (Austin) |
| `hank@globex.test` | Member, Austin |

**Using Docker for the database instead:** in `julley-backend`, run `docker compose up -d`, then
`npm run db:migrate`, `npm run db:seed` and `npm run api` (nodemon without the built-in database). The
compose file uses the same port and credentials as the defaults, so no configuration is needed.

## Three things to try

**1. Time Machine.** Open any board and click **Time Machine**, then press play or drag the slider. The
board rebuilds itself from its event log, showing who changed what and when. This isn't a separate feature
bolted on: the log is already the source of truth for live sync and recovery, so replaying it is cheap. The
browser tests check the invariant behind it: after a long session of moves, deletes, undos and conflicts,
replaying the log reproduces the live board exactly.

**2. Bot teammates, if you only have one browser window.** Open the Mumbai branch, then in a third terminal:

```bash
cd julley-backend
npm run simulate
```

Bots sign in through the real API and work on the board in front of you: moves, simultaneous edits that
merge, drag races where one loses with a `409`, and retried requests that apply once. It finishes by checking
that no two cards share a position and the event sequence has no gaps.

**3. Break it.** With two windows open, turn off your Wi-Fi in one, make changes in both, and turn it back on.
Or drag the same card in both windows at once. Or remove someone from a branch while they are looking at it.

## Test it

```bash
cd julley-backend
npm test            # integration tests against real PostgreSQL, no setup needed
npm run bench       # measure throughput and latency, see docs/BENCHMARKS.md
npm run lint

cd julley-frontend
npm test            # optimistic view and event replay unit tests
npm run test:e2e    # two real browsers; needs both installs and Chrome (or E2E_CHANNEL=msedge)
npm run lint
```

## Architecture

```
Browser                       Node (any number of instances)            PostgreSQL
view = server state       ──► REST: auth → tenant access → service  ──► RLS, composite FKs
       + pending ops                                                    activity_logs
                          ◄── WebSocket hub ◄── event bus (LISTEN) ◄─── NOTIFY on commit
```

A write runs in one transaction with the tenant set for row-level security. The same transaction
increments the tenant's event counter, appends to `activity_logs` and calls `pg_notify`. Because
`NOTIFY` is transactional, only committed work is announced. Each node then reads the new rows and
fans them out to that tenant's sockets, in order.

The activity log is therefore the audit trail, the live stream and the recovery mechanism at once.
They cannot disagree, and no event can be lost between commit and publish.

```
julley-backend/
  src/db/        pool, tenancy scopes, migrations, seed
  src/http/      errors, authentication, tenant/org authorization
  src/domain/    rank keys, field-level conflict detection, event recording
  src/modules/   auth, organizations, tenants, members, boards, columns, tasks, activity
  src/realtime/  event bus, WebSocket hub, presence
  test/          integration tests

julley-frontend/
  src/lib/         API client, socket client, optimistic view (pure functions)
  src/store/       session, board (state, op queue, undo), presence, activity, toasts
  src/components/  UI
  test/, e2e/      unit and browser tests
```

## Tenancy model

Shared database, shared schema, `tenant_id` on every business table. Four independent layers enforce
isolation, so a bug in one does not leak data:

1. **Routing.** Every tenant resource is under `/api/tenants/:tenantId`, and middleware resolves the
   caller's role. Non-members get `404`, so tenant IDs cannot be probed.
2. **Row-level security.** The API connects as `kanban_app`, a non-owner role that cannot bypass RLS.
   A query that forgets its `WHERE tenant_id` returns only the current tenant's rows, and with no
   tenant set it returns nothing. The setting is transaction-local, so pooled connections can't leak it.
3. **Composite foreign keys.** `tasks (tenant_id, board_id, column_id)` references
   `columns (tenant_id, board_id, id)`. A cross-tenant link is rejected even for a superuser.
4. **Channel authorization.** Sockets join a tenant through the same access check, and access changes
   re-check live sockets immediately, across nodes.

Roles: **Org Admin** (everything in the organization, including every branch), **Tenant Admin**
(boards, columns and members of one branch), **Member** (tasks in one branch). The full matrix is in
[overview.md §4.1](overview.md#41-roles).

## How concurrency is handled

- **Edits** use field-level optimistic concurrency. Changes to different fields merge. Two people
  changing the same field produce a `409` with both values, and the UI asks which to keep.
- **Drags** send intent ("after task A"), never a position, and the server computes the rank key under
  a lock on the target column. Dragging the same card: first writer wins, and the loser's card returns
  with an explanation. Dragging different cards to one spot: both succeed.
- **Retries** are safe. Every mutation carries an `Idempotency-Key`, so a retry after a lost response
  returns the original result.
- **Ordering** uses fractional rank keys, so a move writes one row. `UNIQUE (column_id, position)` makes
  duplicate keys impossible, and columns are rebalanced automatically when keys grow long.
- **Undo** is per user. It sends the inverse action with the version from after your own action, so the
  server refuses it if a colleague has since changed the same field.
- **Measured, not assumed:** one tenant sustained about 100 writes per second on a laptop that was also
  running the database and the load generator, with no errors. See [docs/BENCHMARKS.md](docs/BENCHMARKS.md).
- **Network recovery:** sockets reconnect with backoff and replay from the last event sequence. Writes
  made while offline stay on screen and are sent in order on reconnect.

## Trade-offs

| Decision | Benefit | Cost | Revisit when |
|---|---|---|---|
| Shared schema + RLS | One migration, one pool, simple operations | Tenants share resources | A very large tenant appears: partition or shard by `tenant_id` |
| `LISTEN/NOTIFY` as the bus | No extra infrastructure; delivery tied to commit | A global lock on commit under very high write rates | Thousands of writes per second: fan out via Redis or NATS, and keep the log as the source of truth |
| Per-tenant sequence row | Gap-free order makes recovery trivial | Writes within one tenant serialize at commit | One tenant needs hundreds of writes per second |
| Field-level versions, not CRDTs | Simple, explainable, suits short structured fields | Two people editing one description get a conflict, not a merge | Real-time collaborative text is required |
| Client-side undo | Standard for collaborative tools, no server state | History is lost on reload | Persistent history is requested |
| In-memory operation queue | Simple | Unsent changes are lost if the tab closes while offline | True offline-first is required |
| JWT in `localStorage` | No CSRF surface, simple | Readable by XSS; no revocation before expiry | Production: `httpOnly` refresh cookies, short-lived access tokens |
| Per-node rate limiting | No extra infrastructure | The limit multiplies by node count | Production: shared store |

## Configuration

**Backend:** copy `julley-backend/.env.example` to `.env` to change anything; the defaults work for
development. Production requires `JWT_SECRET`, `DATABASE_URL` and `OWNER_DATABASE_URL`. Run
`npm run db:migrate`, then `npm run start:prod`, which runs plain Node with no file watching. Run as many
instances as you like behind a load balancer; no sticky sessions are needed.

**Frontend:** `npm run build` produces static files in `dist/`. Host them anywhere that also forwards
`/api` and `/ws` to the backend, or set `FRONTEND_DIST` on the backend to serve them from one process. In
development, set `API_TARGET` if the backend isn't on `http://localhost:4000`.
