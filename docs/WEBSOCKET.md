# WebSocket protocol

Connect to `/ws`. All messages are JSON text frames, at most 16 KB from the client.

## Lifecycle

```
client                                   server
  │── connect ──────────────────────────►│
  │── {type:"auth", token} ─────────────►│   within 5 seconds, or closed with 4401
  │◄──────────────── {type:"auth.ok"} ───│
  │── {type:"subscribe", tenantId, ...} ►│   same access check as REST
  │◄───────────── {type:"subscribed"} ───│
  │◄──────────── replayed events, if any │
  │◄──────────────────── live events ... │
```

The token goes in a message rather than the URL, so it never reaches access logs.

**A socket subscribes to one tenant at a time.** Subscribing to another leaves the first, so a client
bug cannot blend two tenants' streams.

## Client messages

| Message | Purpose |
|---|---|
| `{type:"auth", token}` | Authenticate. Required first |
| `{type:"subscribe", tenantId, lastSeq?, boardId?}` | Join a tenant's channel. `lastSeq` replays what you missed; omit it to start from now |
| `{type:"unsubscribe"}` | Leave the channel |
| `{type:"presence.update", boardId?, taskId?}` | Share which board and card you have open |
| `{type:"ping"}` | Application heartbeat. Replies `{type:"pong"}` |

## Server messages

| Message | Meaning |
|---|---|
| `{type:"auth.ok", user}` | Authenticated |
| `{type:"subscribed", tenantId, seq, role, presence}` | Joined. `seq` is the tenant's current sequence |
| `{type:"event", event}` | A change. See below |
| `{type:"presence", tenantId, members}` | The full presence list, sent on every change |
| `{type:"resync.required", tenantId, seq}` | Too far behind to replay. Reload your data; `seq` is the new starting point |
| `{type:"subscription.revoked", tenantId}` | You lost access, or the tenant was deleted. No more events will arrive |
| `{type:"error", code, message, tenantId?}` | `UNAUTHORIZED`, `NOT_FOUND`, `BAD_MESSAGE` or `INTERNAL` |
| `{type:"pong"}` | Heartbeat reply |

`NOT_FOUND` on subscribe means the tenant doesn't exist **or** you have no access. The reply is identical
in both cases.

### Close codes

| Code | Meaning | What to do |
|---|---|---|
| `4401` | Invalid or expired token, or no auth in time | Sign in again. Don't retry with the same token |
| Others | Network or server | Reconnect with backoff |

## Events

```json
{
  "type": "event",
  "event": {
    "seq": 42,
    "tenantId": "uuid",
    "action": "task.moved",
    "entityType": "task",
    "entityId": "uuid",
    "boardId": "uuid",
    "opId": "the Idempotency-Key of the request that caused it",
    "actor": { "id": "uuid", "name": "Ben Okafor", "color": "#2f6f8f" },
    "payload": { "task": { "...": "full task after the change" } },
    "at": "2026-11-02T14:06:04.847Z"
  }
}
```

**Guarantees, per tenant:**

- `seq` increases by exactly 1 with each event, in commit order.
- Only committed changes produce events. A rejected request never does.
- Events contain the full entity, so applying one needs no earlier state.

### Event types

| Action | Payload |
|---|---|
| `task.created`, `task.deleted`, `task.restored` | `{task}` |
| `task.updated` | `{task, changes: {field: {from, to}}}` |
| `task.moved` | `{task, from: {columnId}, to: {columnId}}` |
| `column.created`, `column.moved`, `column.deleted` | `{column}` |
| `column.updated` | `{column, changes}` |
| `column.restored` | `{column, tasks}` |
| `column.rebalanced` | `{columnId, positions: {taskId: key}}`: new keys, same order |
| `board.rebalanced` | `{positions: {columnId: key}}`: same, for a board's columns |
| `board.created` | `{board, columns}` |
| `board.updated` | `{board, changes}` |
| `board.deleted` | `{board}` |
| `tenant.created`, `tenant.updated` | `{tenant}` |
| `member.added`, `member.updated`, `member.removed` | `{member}`, without email addresses |

## Presence

```json
{
  "type": "presence",
  "tenantId": "uuid",
  "members": [
    { "connId": "uuid", "userId": "uuid", "name": "Ben Okafor", "color": "#2f6f8f", "boardId": "uuid", "taskId": null }
  ]
}
```

There is one entry per connection, so one person with two tabs appears twice; clients group by `userId`.
Presence is ephemeral and shared across nodes over the bus, with a heartbeat. A crashed node's users
disappear within 30 seconds.

## Recovery

Keep the `seq` of the last event you applied.

| Situation | What to do |
|---|---|
| Reconnected | `subscribe` with `lastSeq`. Missed events replay in order, without gaps or duplicates, then live events follow |
| Received `seq` greater than `last + 1` | Something went missing. `subscribe` again with `lastSeq` |
| Received `seq` not greater than `last` | Ignore it |
| Received `resync.required` | Set `last` to its `seq`, and reload your board snapshot |

Replay is limited to the most recent 500 events (`MAX_REPLAY_EVENTS`). Beyond that, the server sends
`resync.required`.

To load a board without missing anything: subscribe first, then fetch the board snapshot, buffer events
while it loads, and apply only those with `seq` above the snapshot's `seq`.

## Limits and liveness

- The server pings every 30 seconds and terminates sockets that don't answer.
- Clients should send `ping` periodically too, because a half-open connection may never report closing.
  This client uses 20 seconds, with an 8 second timeout.
- A client that falls more than 4 MB behind is disconnected, and recovers via replay.
- A socket closes with `4401` when its token expires.
