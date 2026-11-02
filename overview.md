# Tenant Flow: Project Overview

The reference document for this project. It restates the assignment in full, maps every requirement
to a design decision and the code that implements it, and records why each decision was made. If you
only read one file, read this one.

- Running the project: [README.md](README.md)
- REST reference: [docs/API.md](docs/API.md)
- WebSocket reference: [docs/WEBSOCKET.md](docs/WEBSOCKET.md)
- Schema and ER diagram: [docs/DATABASE.md](docs/DATABASE.md)
- Measured performance: [docs/BENCHMARKS.md](docs/BENCHMARKS.md)

---

## 1. The assignment

**Source:** `JulleyOnline Assignment.pdf`, "Real-Time Collaborative Kanban Board Assignment
(Multi-Organization + Multi-Tenant)".

**Problem statement.** Build a real-time collaborative task board where multiple users across
organizations and their branches (tenants) can collaborate with strict data isolation and live
synchronization.

### 1.1 Requirements, in full

| Area | # | Requirement |
|---|---|---|
| Backend | B1 | CRUD APIs for Organizations, Tenants (Branches), Boards, Columns, Tasks |
| | B2 | Multi-organization → multi-tenant hierarchy |
| | B3 | Strict data isolation at tenant level |
| | B4 | Role-based access control (Org Admin, Tenant Admin, Member) |
| | B5 | Real-time sync using WebSockets or SSE |
| | B6 | Concurrency handling to avoid conflicting updates |
| Database | D1 | Tables: organizations, tenants, users, memberships, boards, columns, tasks, activity_logs |
| | D2 | Hierarchy: Organization → Tenants → Boards |
| | D3 | All business data scoped by tenant_id |
| | D4 | Efficient ordering of tasks within columns |
| | D5 | Versioning or timestamps for conflict handling |
| Frontend | F1 | Organization selector + Tenant (branch) switcher |
| | F2 | Kanban board UI with drag-and-drop |
| | F3 | Task detail panel |
| | F4 | Real-time updates across users in same tenant |
| Advanced | A1 | Presence indicators per tenant |
| | A2 | Scoped WebSocket channels per tenant |
| | A3 | Optimistic UI updates |
| | A4 | Undo/redo |
| | A5 | Activity logs per tenant |
| | A6 | Conflict resolution strategy |
| Edge cases | E1 | Cross-tenant data leakage prevention |
| | E2 | Cross-organization isolation |
| | E3 | Concurrent edits |
| | E4 | Drag-drop conflicts |
| | E5 | Network recovery |
| Deliverables | L1 | Backend + real-time server |
| | L2 | Frontend UI |
| | L3 | Database schema (ER diagram) |
| | L4 | README (architecture, tenancy model, trade-offs) |
| | L5 | API + WebSocket documentation |

### 1.2 How it will be graded

| Criterion | Weight | What it means for this build |
|---|---|---|
| Architecture | 30% | Modular backend, explicit tenancy model |
| Correctness | 20% | Edge cases actually handled, and proven by tests |
| Advanced thinking | 20% | Concurrency and scalability reasoning |
| Database design | 15% | Isolation enforced by the database, not by convention |
| Frontend quality | 15% | A polished, responsive board that stays honest about sync state |

---

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React 19, Vite (the supplied base code), zustand, dnd-kit | Base code kept. zustand lets socket and queue code update state outside React. dnd-kit is the maintained sortable library with keyboard support |
| API | Node 22, Express 5, zod | Small, familiar, async errors propagate natively in Express 5 |
| Real-time | `ws` (WebSockets) | Bidirectional, which presence needs. SSE would need a second channel for client messages |
| Database | PostgreSQL via `pg`, hand-written SQL | RLS, row locks and `NOTIFY` are the core of the design. An ORM would hide exactly what is being graded |
| Local database | `embedded-postgres` | Real PostgreSQL binaries from npm. `npm start` in the backend works with no Docker and no install |
| Ordering keys | `fractional-indexing` | Well-tested implementation of the algorithm described in §6 |

Plain JavaScript, matching the base code.

---

## 3. System architecture

```
                     ┌──────────────────────────── Browser ──────────────────────────┐
                     │  React views ← derived view = server state + pending operations │
                     │                 ▲                        ▲                     │
                     │        socket client             operation queue               │
                     └─────────────────┼────────────────────────┼─────────────────────┘
                              WebSocket│ /ws                REST│ /api
                                       ▼                        ▼
    ┌──────────────── Node process (N of these, stateless) ────────────────┐
    │  realtime hub                       HTTP modules                     │
    │  · auth, tenant channels            auth, organizations, tenants,    │
    │  · replay, presence                 members, boards, columns, tasks, │
    │                                     activity                         │
    │        ▲                                      │                      │
    │        │ events                  tenancy layer│ withTenant / withOrg │
    │  event bus (LISTEN)                           ▼                      │
    └────────┼───────────────────────────────────────┼─────────────────────┘
             │ NOTIFY on commit                      │ SET LOCAL app.tenant_id
             └────────────── PostgreSQL ◄────────────┘
                 RLS · composite FKs · activity_logs (the event log)
```

**A write's path:**

1. The client applies the change to its local view immediately and queues the operation.
2. The REST call passes `authenticate` → `requireTenant(role)` → zod validation → service.
3. The service runs in one transaction with `app.tenant_id` set, so RLS covers every statement.
4. In that transaction it locks what it needs, checks for conflicts, and writes the change.
5. Also in that transaction it increments the tenant's sequence number, inserts the `activity_logs`
   row, and calls `pg_notify`.
6. On commit, Postgres delivers the notification to every Node process. Rolled-back work is never
   announced, because `NOTIFY` is transactional.
7. Each process with subscribers for that tenant reads the new rows and fans them out, in order.
8. The originating client receives the HTTP response and removes the operation from its queue. It
   ignores the matching event's echo, because the entity's version is already applied.

**Why the activity log is also the event log:** the audit trail, the live stream and the recovery
mechanism are one table. They cannot disagree, and an event cannot be lost between "commit" and
"publish", which is the classic dual-write bug.

### 3.1 Module layout

```
julley-backend/            one terminal: npm start (nodemon + local PostgreSQL)
  src/
    config.js              environment
    index.js, app.js       process entry point; Express assembly
    db/                    pool, tenancy layer, migrations, seed, embedded Postgres runner
    http/                  errors, validation, auth + tenant middleware
    domain/                ordering.js (rank keys), fieldPatch.js (conflict detection), events.js
    modules/               one folder per resource: routes + service
    realtime/              bus.js (LISTEN/NOTIFY), hub.js (channels, replay), presence.js
  test/                    integration tests against real PostgreSQL

julley-frontend/           another terminal: npm start (Vite)
  src/
    lib/                   API client, socket client, optimistic view computation
    store/                 session, board (state + op queue + undo), presence, toasts
    components/            UI
  test/                    optimistic view unit tests
  e2e/                     two-browser tests
```

---

## 4. Tenancy model

**Shared database, shared schema, `tenant_id` discriminator**, enforced by four independent layers.
A bug in any one layer does not leak data.

| Layer | Mechanism | What it stops |
|---|---|---|
| 1. Routing | Every tenant resource sits under `/api/tenants/:tenantId/...`. `requireTenant` resolves the caller's effective role | Non-members. They get `404`, so tenant IDs cannot be probed for existence |
| 2. Row-level security | `boards`, `columns`, `tasks`, `activity_logs` carry `tenant_id = current_setting('app.tenant_id')`. The API connects as a non-owner role that cannot bypass RLS | A query that forgets its `WHERE tenant_id`. Returns nothing rather than another tenant's rows |
| 3. Composite foreign keys | `tasks (tenant_id, board_id, column_id) → columns (tenant_id, board_id, id)` and so on | Cross-tenant references. The database rejects a task pointing at another tenant's column, even from a superuser session |
| 4. Channel authorization | A socket joins a tenant only after the same access check; events are read under RLS; access changes re-check live sockets | Real-time leakage, including users removed while connected |

**Fail closed:** with no `app.tenant_id` set, the policy compares against `NULL` and matches nothing.
Settings use `set_config(..., true)`, which is transaction-local, so a pooled connection cannot carry
one request's tenant into the next.

**Why not one schema or database per tenant?** Stronger physical isolation, but migrations and
connection pools grow with tenant count, and it is more than a Kanban tool needs. If one tenant ever
outgrows the shared table, `tenant_id` is the natural partition and shard key.

### 4.1 Roles

Memberships are rows of `(user, organization, tenant?, role)`. A `CHECK` constraint ties `org_admin`
to `tenant_id IS NULL` and the other two roles to a specific tenant.

| Action | Org Admin | Tenant Admin | Member |
|---|---|---|---|
| Create an organization | any signed-in user, who becomes its Org Admin | | |
| Rename / delete the organization | ✅ | ❌ | ❌ |
| Create / delete tenants | ✅ | ❌ | ❌ |
| Rename a tenant | ✅ | ✅ | ❌ |
| Manage org admins | ✅ | ❌ | ❌ |
| Manage tenant members | ✅ | ✅ (own tenant) | ❌ |
| Create / edit / delete boards and columns | ✅ | ✅ | ❌ |
| Create / edit / move / delete tasks | ✅ | ✅ | ✅ |
| View boards, activity, presence | ✅ all tenants in org | ✅ own tenant | ✅ own tenant |

Guard rails: the last Org Admin cannot be removed, and Tenant Admins cannot grant `org_admin`.

**People search** suggests names as an admin types, but only from people already in the organization. A
global search would let any admin browse every other company's users, which would break cross-organization
isolation (E2). Someone from outside is added by their exact email, so the admin must already know it.

---

## 5. Data model summary

Full detail and the ER diagram are in [docs/DATABASE.md](docs/DATABASE.md).

```
organizations 1─* tenants 1─* boards 1─* columns 1─* tasks
organizations 1─* memberships *─1 users
tenants       1─* memberships (nullable: NULL means org-wide admin)
tenants       1─* activity_logs
```

Notable columns:

- `tenants.event_seq`: per-tenant gap-free event counter (§8).
- `*.version` and `*.field_versions`: optimistic concurrency (§7).
- `tasks.position`, `columns.position`: `TEXT COLLATE "C"` rank keys (§6). `NULL` when soft-deleted.
- `activity_logs`: append-only. The API role is granted only `SELECT` and `INSERT`.

---

## 6. Ordering

**Fractional rank keys.** Each task stores a string such that ordering by that string is the display
order. Inserting between two tasks generates a key between their keys.

| Approach | Cost of one move | Problem |
|---|---|---|
| Integer positions | Rewrites every following row | Write amplification, contention, conflicts on unrelated tasks |
| Float midpoint | One row | Runs out of precision after about 50 inserts in one spot |
| **Rank keys** | **One row** | Keys grow slowly; handled by rebalancing |

Decisions that make this correct under concurrency:

- **Clients send intent, not a key.** A move request says "after task A" or "before task B". The
  server computes the key, so a stale client can never submit a stale key.
- **Target column lock.** The server takes `FOR NO KEY UPDATE` on the target column before computing a
  key. Two people dropping at the same spot are serialized and get distinct keys. The weaker lock mode
  does not block foreign-key checks from other tasks.
- **`UNIQUE (column_id, position)`** makes duplicate keys impossible rather than unlikely. It is
  deferrable so rebalancing can rewrite a column in one transaction.
- **`COLLATE "C"`** makes Postgres sort bytewise, the same way the key generator does. Locale-aware
  collation would silently sort `a` and `Z` differently.
- **Moved anchors.** If the anchor task has left the column, the server falls back to the other anchor
  and then to the end of the column. The drop still lands somewhere sensible.
- **Rebalancing.** When a key passes `REBALANCE_KEY_LENGTH`, the column is rewritten with short keys
  and a `column.rebalanced` event is published. Because clients only send IDs, in-flight requests are
  unaffected.

---

## 7. Concurrency and conflict resolution

**Strategy: field-level optimistic concurrency.** Non-overlapping changes merge automatically; true
conflicts are surfaced, not silently overwritten.

Each row has a `version` and a `field_versions` map, e.g. `{"title": {"v": 7, "by": "<user id>"}}`.
A client sends the `baseVersion` it was looking at. For each field in the patch, the server asks: *has
somebody else changed this field since `baseVersion`, to a different value?*

| Scenario | Result |
|---|---|
| A edits title, B edits description, from the same version | Both succeed and merge |
| A and B both edit the title | First commit wins. Second gets `409` with the competing values; the UI offers "Keep mine" or "Use theirs" |
| Both set the same value | No conflict |
| Same user, in rapid succession | Never conflicts with itself (`by` matches), so queued edits don't need rebasing |
| Same user, two tabs | Last write wins (accepted trade-off: there is no other person to protect) |

| Other race | Rule |
|---|---|
| Two users drag the same task | First writer wins. Second gets `409`, its card animates back, and a toast names who moved it |
| Two users drag different tasks to the same spot | Both succeed, serialized by the column lock |
| A drags, B edits the title of the same task | Both succeed. `position` is its own field |
| Drop into a column just deleted | `404`. The card returns; a toast explains |
| Edit a task just deleted | `404`. The panel closes and explains |
| Delete vs concurrent edit | Delete wins, and undo restores the task with the edit intact |
| Undo after someone else changed the same field | Refused with a toast. Undo never overwrites a colleague's later work |

**Lock order** is always column → task → tenant counter, so these paths cannot deadlock each other.
Any deadlock or serialization failure that does occur is retried automatically, with jitter.

**Idempotency.** Every mutation carries a client-generated `Idempotency-Key`, stored in the activity
row and unique per `(tenant, actor, key)`. If a response is lost and the request is retried, the server
returns the original result instead of applying it twice. Task IDs are also client-generated, so the
optimistic card keeps the same identity once confirmed.

---

## 8. Real-time

- **Channels.** One channel per tenant. A socket has at most one active subscription, and subscribing
  to another tenant leaves the previous one. See [docs/WEBSOCKET.md](docs/WEBSOCKET.md).
- **Ordering.** `tenants.event_seq` is incremented inside each mutating transaction. That row lock is
  held until commit, so sequence numbers are gap-free and in commit order for each tenant.
- **Cost of that choice.** Writes within one tenant are serialized for the tail of their transaction.
  Writes in different tenants are unaffected. A branch's Kanban traffic is far below this limit, and
  the payoff is much simpler recovery: "give me everything after N" is always correct.
- **Multi-node.** `LISTEN/NOTIFY` carries only `{tenantId, seq}`. Each node reads the rows from the
  database, so the 8 KB `NOTIFY` limit never truncates a payload, and bursts are coalesced into one
  read. Proven by a test that runs two servers against one database.
- **Presence.** Ephemeral, per tenant, held in memory on each node and exchanged over the same bus,
  with a heartbeat and expiry so a crashed node's users disappear. Shows who is in the tenant, which
  board they are on, and which card they have open.
- **Access changes.** Removing a member or deleting a tenant re-checks live sockets immediately.
  Removed users receive `subscription.revoked` and the UI leaves the tenant.

### 8.1 Network recovery

| Failure | Behaviour |
|---|---|
| Socket drops | Reconnect with exponential backoff and jitter. Banner shows the state |
| Socket silently dead (half-open) | Client heartbeat times out and forces a reconnect. Server pings and terminates dead sockets |
| Missed events | `subscribe {lastSeq}` replays everything after that point, then switches to live, without gaps or duplicates |
| Offline too long (over 500 events) | Server sends `resync.required`; client reloads the snapshot |
| Client detects a sequence gap | Same as above: it re-subscribes from its last sequence |
| Writes while offline | Stay in the queue and on screen as pending, then retry in order |
| Response lost after the server committed | The retry hits the idempotency key and returns the original result |
| Token expires | Socket closes with `4401`; client signs out cleanly |

---

## 9. Frontend state

The central idea is that **the screen is a pure function: `view = serverState + pendingOps`.**

- `serverState` only ever holds what the server has confirmed. Events and responses update it, and
  older versions are ignored.
- `pendingOps` holds the user's unconfirmed intents, in order, and they are sent one at a time.
- The board renders the result of replaying the pending ops on top of server state.

Consequences:

- **Rollback needs no code.** A rejected op is removed from the list and the card returns to where
  the server says it is.
- **Remote changes never get lost under a local drag.** A colleague's event updates `serverState`
  while your op is pending, and the view recomputes with both. Because ops store intent ("after task
  A") rather than a position, they rebase correctly.
- **No flicker.** A card doesn't jump back between the op being acknowledged and the echo arriving.

**Undo/redo** is per user and local to the current tenant: it undoes *your* actions, not your
colleague's. Each action records its inverse, and undo sends that inverse through the normal op
pipeline with the version from *after your action*. That is how the server knows when somebody else
has since touched the same field and can refuse. Covers task create, edit, move and delete, and
column create, rename, move and delete. `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`.

**Task editing** captures `baseVersion` when a field gains focus. Remote updates flow into fields you
aren't editing, and never into the one you are.

---

## 9.1 Beyond the brief

Added because they follow from the architecture, rather than as decoration.

| Addition | Why it exists |
|---|---|
| **Time Machine** (`TimeMachine.jsx`, `lib/replay.js`, `GET .../history`) | The event log already holds every change as a full entity, so a board can be rebuilt at any past point. Replay and live sync share one source of truth, and the browser suite asserts that replaying the whole log equals the live board |
| **Bot teammates** (`scripts/simulate-team.js`) | A reviewer with one window can watch real sync and real conflicts through the real API, then see the invariants checked |
| **Benchmarks** (`scripts/bench.js`, `docs/BENCHMARKS.md`) | Scalability claims should come with numbers, including an honest list of what wasn't measured |
| **Seed data goes through the log** (`db/seed.js`) | Demo boards have real history from their first event, rather than appearing from nowhere |
| **Login illustration** (`LoginShowcase.jsx`) | Shows live sync, conflict, recovery and isolation before sign-in. It is a labelled script, not live data |

---

## 10. Requirement traceability

Each row names where the requirement lives and how it was checked. See §11 for test locations.

| Req | Implementation |
|---|---|
| B1 | `julley-backend/src/modules/{organizations,tenants,boards,columns,tasks}` |
| B2, D2 | `tenants.organization_id`, `boards.tenant_id`; `requireTenant` resolves the chain |
| B3, D3, E1 | §4: `julley-backend/src/db/tenancy.js`, RLS in `julley-backend/src/db/migrations/001_schema.sql` |
| B4 | `julley-backend/src/http/access.js`, §4.1 |
| B5, A2 | `julley-backend/src/realtime/hub.js` |
| B6, D5, E3, A6 | `julley-backend/src/domain/fieldPatch.js`, §7 |
| D1 | `julley-backend/src/db/migrations/001_schema.sql` |
| D4 | `julley-backend/src/domain/ordering.js`, §6 |
| F1 | `julley-frontend/src/components/TopBar.jsx` |
| F2 | `julley-frontend/src/components/BoardView.jsx`, `Column.jsx`, `TaskCard.jsx` |
| F3 | `julley-frontend/src/components/TaskPanel.jsx` |
| F4 | `julley-frontend/src/store/board.js` (`applyEvent`), `julley-frontend/src/lib/socket.js` |
| A1 | `julley-backend/src/realtime/presence.js`, `julley-frontend/src/components/PresenceBar.jsx`, avatars on cards |
| A3 | `julley-frontend/src/lib/view.js`, `julley-frontend/src/store/board.js` |
| A4 | `julley-frontend/src/store/board.js` (`undo`, `redo`) |
| A5 | `julley-backend/src/modules/activity`, `julley-frontend/src/components/ActivityDrawer.jsx` |
| E2 | §4 plus the org-level policies; isolation tests |
| E4 | `moveTask` in `julley-backend/src/modules/tasks/service.js` |
| E5 | §8.1 |
| L3 | `docs/DATABASE.md` |
| L4 | `README.md` |
| L5 | `docs/API.md`, `docs/WEBSOCKET.md` |

---

## 11. Verification

Tests run against real PostgreSQL rather than mocks, because the behaviour under test is largely the
database's. In `julley-backend`, `npm test` runs 105 integration tests. In `julley-frontend`, `npm test` runs 24 unit tests and `npm run test:e2e` runs 29 browser checks.

| Suite | Proves |
|---|---|
| `julley-backend/test/isolation.test.js` | Foreign IDs return `404`; raw RLS with no tenant set returns nothing; composite FKs reject cross-tenant links; tenant A's user cannot reach tenant B or another org |
| `julley-backend/test/rbac.test.js` | The §4.1 matrix, escalation attempts, last-admin protection |
| `julley-backend/test/concurrency.test.js` | Parallel moves and inserts produce unique keys and lose nothing; field merge; conflicts; same-task drag race; idempotent retries; rebalancing |
| `julley-backend/test/realtime.test.js` | Socket auth, channel scoping, replay after disconnect, resync, revocation, two-node delivery, presence |
| `julley-frontend/test/view.test.js` | The optimistic view: rollback, rebasing over remote changes, bytewise ordering |
| `julley-frontend/test/replay.test.js` | Event replay: immutable frames, deleted columns, rebalanced keys |
| `julley-frontend/e2e/board.e2e.mjs` | Two real Chrome sessions: login, mouse and keyboard drag, live sync, presence, undo, conflicts, offline writes, a server restart, tenant and org isolation, revocation, phone and dark layouts |

### 11.1 Bugs these tests caught

Worth knowing, because each is a trap for later changes.

| Bug | Cause | Fix |
|---|---|---|
| The loser of a drag race got `404` instead of `409` | `SELECT ... JOIN ... FOR UPDATE OF t` re-checks the join after waiting for a lock, against the old column row, and drops the task | Lock the task alone, then check its column (`loadLiveTask`) |
| Simultaneous retries of a create returned `409` | With a client-chosen ID, the duplicate hits the primary key before reaching the idempotency index | Re-check on any unique violation for a keyed request (`tenantMutation`) |
| Cards landed on the wrong side when moved up within one card | dnd-kit's `onDragOver` fires only when the hovered item changes | Also recompute on `onDragMove` |
| "Live" was shown for up to 28 seconds after losing the network | An open socket can look healthy until the heartbeat times out | Drop it on the browser's `offline` event |
| Arrow keys didn't move a column | Keyboard targeting included the cards inside the column | Limit column drags to column targets |

### 11.2 Not verified

- `docker-compose.yml`: Docker wasn't running on the development machine. The default path uses the
  same PostgreSQL major version from npm, and that path is tested.
- Touch dragging on a real device. The sensor is configured and the phone layout was checked, but
  the tests use a mouse.
- Load beyond one laptop. See the "Not measured" list in [docs/BENCHMARKS.md](docs/BENCHMARKS.md).
- Screen readers. Keyboard operation is tested; assistive technology output was not.

---

## 12. Trade-offs

| Decision | Benefit | Cost | When to revisit |
|---|---|---|---|
| Shared schema with RLS | One migration, one pool, simple ops | A noisy tenant shares resources | Very large tenants: partition or shard by `tenant_id` |
| `LISTEN/NOTIFY` bus | No extra infrastructure; transactional delivery | One listener connection per node; global `NOTIFY` lock under very high write rates | Thousands of writes per second: move fan-out to Redis or NATS and keep the log as source of truth |
| Per-tenant sequence row | Gap-free ordering, simple recovery | Writes in one tenant serialize at the end of the transaction | A single tenant needing hundreds of writes per second |
| Field-level versions, not CRDTs | Simple, explainable, suits short structured fields | Two people editing one description conflict rather than merge | Real-time collaborative text is needed |
| Client-side undo | Standard for collaborative tools, no server state | History is lost on reload | Persistent history is requested |
| In-memory op queue | Simple | Unsent changes are lost if the tab closes while offline | True offline-first is required |
| JWT in `localStorage` | Simple for a demo; no CSRF surface | Readable by XSS; no server-side revocation before expiry | Production: `httpOnly` refresh cookies and short-lived access tokens |
| Soft delete for tasks and columns | Undo and history stay simple | Rows accumulate | Add a retention job |
| No REST pagination on board snapshot | One round trip to a full board | Large boards load everything | Boards above a few thousand cards |
