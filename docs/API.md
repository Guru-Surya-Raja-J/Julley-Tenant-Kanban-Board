# REST API

Base path `/api`. JSON in and out. Except for register and login, every route needs
`Authorization: Bearer <token>`.

## Conventions

**Errors** always have this shape:

```json
{ "error": { "code": "EDIT_CONFLICT", "message": "Human-readable text", "details": {} } }
```

| Status | Meaning |
|---|---|
| `400` | Invalid input (`VALIDATION_FAILED`, `INVALID_ASSIGNEE`, `CROSS_BOARD_MOVE`, `NOT_DELETED`) |
| `401` | Missing or invalid token |
| `403` | You are in this tenant, but your role doesn't allow this |
| `404` | Doesn't exist, **or you have no access to it**. The two are deliberately indistinguishable |
| `409` | Conflict (`EDIT_CONFLICT`, `MOVE_CONFLICT`, `VERSION_CONFLICT`, `LAST_ORG_ADMIN`, `ALREADY_EXISTS`, `EMAIL_TAKEN`) |
| `429` | Rate limited (`/auth` routes) |

**`baseVersion`** is the entity version your client was looking at. It is how the server tells a real
conflict from an unrelated concurrent change.

**`Idempotency-Key`** is an optional header on tenant-scoped mutations. Send a unique value per
operation, and reuse it when retrying. A retry returns the original result with `"replayed": true`
rather than applying the change twice. Keys are scoped per user and tenant.

**Client-chosen IDs.** Creating a task or column accepts an optional `id` (UUID), so an optimistic item
keeps its identity once confirmed.

**Placement.** Moves and creates take `afterId` and/or `beforeId`. The server computes the position,
falling back from `afterId` to `beforeId` to the end of the list if an anchor has since moved.

**Roles** below: *Member* means any member of the tenant, and each higher role can do everything a lower
one can. Org Admins count as members of every tenant in their organization.

## Authentication

| Method and path | Body | Returns |
|---|---|---|
| `POST /auth/register` | `{email, name, password}` (8+ characters) | `201 {token, user}` |
| `POST /auth/login` | `{email, password}` | `{token, user}` |
| `GET /auth/me` | | `{user}` |

## Organizations

| Method and path | Role | Body | Returns |
|---|---|---|---|
| `GET /organizations` | Any user | | `{organizations}`, only your own |
| `POST /organizations` | Any user | `{name}` | `201 {organization}`; you become its Org Admin |
| `GET /organizations/:orgId` | Member | | `{organization}` |
| `PATCH /organizations/:orgId` | Org Admin | `{name, baseVersion?}` | `{organization}` |
| `DELETE /organizations/:orgId` | Org Admin | | `204`; deletes everything beneath it |

### Organization admins

| Method and path | Role | Body | Returns |
|---|---|---|---|
| `GET /organizations/:orgId/members` | Org Admin | | `{members}`: every membership in the org |
| `GET /organizations/:orgId/members/search?q=` | Org Admin | | `{people}`: org members who aren't org admins yet, at most 8 |
| `POST /organizations/:orgId/members` | Org Admin | `{email}` | `201 {member}`: adds an Org Admin |
| `DELETE /organizations/:orgId/members/:memberId` | Org Admin | | `204`; `409 LAST_ORG_ADMIN` if it is the last one |

## Tenants (branches)

| Method and path | Role | Body | Returns |
|---|---|---|---|
| `GET /organizations/:orgId/tenants` | Member | | `{tenants}`: all for an Org Admin, otherwise your own |
| `POST /organizations/:orgId/tenants` | Org Admin | `{name}` | `201 {tenant}` |
| `GET /tenants/:tenantId` | Member | | `{tenant}` |
| `PATCH /tenants/:tenantId` | Tenant Admin | `{name, baseVersion?}` | `{tenant}` |
| `DELETE /tenants/:tenantId` | Org Admin | | `204`; revokes live subscriptions |

### Tenant members

| Method and path | Role | Body | Returns |
|---|---|---|---|
| `GET /tenants/:tenantId/members` | Member | | `{members}`, including org admins |
| `GET /tenants/:tenantId/members/search?q=` | Tenant Admin | | `{people}`: org members not yet in this tenant, at most 8 |
| `POST /tenants/:tenantId/members` | Tenant Admin | `{email, role?}` (`member` or `tenant_admin`) | `201 {member}` |
| `PATCH /tenants/:tenantId/members/:memberId` | Tenant Admin | `{role}` | `{member}` |
| `DELETE /tenants/:tenantId/members/:memberId` | Tenant Admin | | `204`; revokes live subscriptions |

Search matches any part of a name or email, with matches at the start listed first. It never returns people
from outside the organization, so it can't be used to browse other organizations' users. Someone outside can
still be added by their exact email through `POST`.

## Boards

| Method and path | Role | Body | Returns |
|---|---|---|---|
| `GET /tenants/:tenantId/boards` | Member | | `{boards, seq}` |
| `POST /tenants/:tenantId/boards` | Tenant Admin | `{name, description?, columns?: string[]}` | `201 {board, columns, seq}` |
| `GET /tenants/:tenantId/boards/:boardId` | Member | | `{board, columns, tasks, seq}` |
| `PATCH /tenants/:tenantId/boards/:boardId` | Tenant Admin | `{patch: {name?, description?}, baseVersion}` | `{board, seq}` |
| `DELETE /tenants/:tenantId/boards/:boardId` | Tenant Admin | | `204` |

The single-board `GET` is a consistent snapshot. `seq` is the event sequence it reflects, so applying
events with a higher `seq` brings it exactly up to date.

### Board history

`GET /tenants/:tenantId/boards/:boardId/history?afterSeq=0&limit=500` (Member) returns the board's events,
oldest first, as `{events, nextAfterSeq}`. `limit` is at most 1000, and `nextAfterSeq` is `null` on the last
page. Applying every event in order reproduces the board, which is what the Time Machine does. A board
created before its events were logged starts partway through, so its first event isn't `board.created`.

## Columns

| Method and path | Role | Body | Returns |
|---|---|---|---|
| `GET /tenants/:tenantId/boards/:boardId/columns` | Member | | `{columns}`, in order |
| `GET /tenants/:tenantId/columns/:columnId` | Member | | `{column}` |
| `POST /tenants/:tenantId/boards/:boardId/columns` | Tenant Admin | `{id?, name, afterId?, beforeId?}` | `201 {column, seq}` |
| `PATCH /tenants/:tenantId/columns/:columnId` | Tenant Admin | `{patch: {name}, baseVersion}` | `{column, seq}` |
| `POST /tenants/:tenantId/columns/:columnId/move` | Tenant Admin | `{afterId?, beforeId?, baseVersion}` | `{column, seq}` |
| `DELETE /tenants/:tenantId/columns/:columnId` | Tenant Admin | | `{column, seq}`: soft delete, hides its tasks |
| `POST /tenants/:tenantId/columns/:columnId/restore` | Tenant Admin | `{afterId?, beforeId?}` | `{column, tasks, seq}` |

## Tasks

| Method and path | Role | Body | Returns |
|---|---|---|---|
| `GET /tenants/:tenantId/boards/:boardId/tasks` | Member | | `{tasks}` |
| `POST /tenants/:tenantId/tasks` | Member | `{id?, columnId, title, description?, priority?, dueDate?, assigneeId?, afterId?, beforeId?}` | `201 {task, seq}` |
| `GET /tenants/:tenantId/tasks/:taskId` | Member | | `{task}` |
| `PATCH /tenants/:tenantId/tasks/:taskId` | Member | `{patch: {...}, baseVersion}` | `{task, seq}` |
| `POST /tenants/:tenantId/tasks/:taskId/move` | Member | `{columnId, afterId?, beforeId?, baseVersion}` | `{task, seq}` |
| `DELETE /tenants/:tenantId/tasks/:taskId` | Member | | `{task, seq}`: soft delete |
| `POST /tenants/:tenantId/tasks/:taskId/restore` | Member | `{columnId?, afterId?, beforeId?}` | `{task, seq}` |

Patchable fields: `title`, `description`, `priority` (`low`, `medium`, `high`, `urgent`), `dueDate`
(`YYYY-MM-DD` or `null`), `assigneeId` (a tenant member or org admin, or `null`). A patch that changes
nothing returns `seq: null` and doesn't bump the version.

```json
{
  "id": "uuid", "tenantId": "uuid", "boardId": "uuid", "columnId": "uuid",
  "title": "Pilot scanning", "description": "", "priority": "high",
  "assigneeId": null, "dueDate": null, "position": "a0V", "version": 3,
  "fieldVersions": { "title": { "v": 3, "by": "user-uuid" } },
  "createdBy": "uuid", "deletedAt": null, "createdAt": "...", "updatedAt": "..."
}
```

### Conflict responses

Another user changed the same field since your `baseVersion`:

```json
{
  "error": {
    "code": "EDIT_CONFLICT",
    "message": "Someone else changed this task while you were editing",
    "details": {
      "conflicts": [{ "field": "title", "yours": "A", "theirs": "B", "changedBy": "user-uuid" }],
      "current": { "...": "the task as it is now" }
    }
  }
}
```

To keep your value, resend it with `baseVersion` set to `current.version`.

Another user moved the task since your `baseVersion`:

```json
{ "error": { "code": "MOVE_CONFLICT", "message": "Someone else already moved this task",
             "details": { "changedBy": "user-uuid", "current": { "...": "..." } } } }
```

## Activity

`GET /tenants/:tenantId/activity?limit=50&beforeSeq=&boardId=` (Member), newest first.

```json
{
  "events": [{
    "seq": 42, "tenantId": "uuid", "action": "task.moved",
    "entityType": "task", "entityId": "uuid", "boardId": "uuid", "opId": "client-key",
    "actor": { "id": "uuid", "name": "Ben Okafor", "color": "#2f6f8f" },
    "payload": { "task": {}, "from": { "columnId": "uuid" }, "to": { "columnId": "uuid" } },
    "at": "2026-11-02T14:06:04.847Z"
  }],
  "nextBeforeSeq": 12
}
```

`limit` is at most 100. `nextBeforeSeq` is `null` on the last page. Event types are listed in
[WEBSOCKET.md](WEBSOCKET.md#event-types).

## Health

`GET /health` (no authentication) returns `{status: "ok"}` when the database is reachable.
