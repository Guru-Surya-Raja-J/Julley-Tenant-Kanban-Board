import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { resolveTenantAccess, withTenantSystem } from '../db/tenancy.js';
import { currentSeq, readEventsAfter } from '../domain/events.js';
import { verifyToken } from '../http/access.js';
import { Bus } from './bus.js';
import { Presence } from './presence.js';

const AUTH_TIMEOUT_MS = 5_000;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const PUMP_BATCH = 200;

const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().max(2000) }),
  z.object({
    type: z.literal('subscribe'),
    tenantId: z.uuid(),
    lastSeq: z.number().int().nonnegative().nullish(),
    boardId: z.uuid().nullish(),
  }),
  z.object({ type: z.literal('unsubscribe') }),
  z.object({ type: z.literal('presence.update'), boardId: z.uuid().nullish(), taskId: z.uuid().nullish() }),
  z.object({ type: z.literal('ping') }),
]);

/**
 * WebSocket fan-out. Channels are per tenant, and a socket is in at most one.
 *
 * A socket joining mid-stream goes through replay: it is added to the channel
 * first and buffers live events, then reads history up to the current sequence,
 * then flushes what it buffered. That order leaves no gap and sends no duplicate.
 */
export class Hub {
  constructor(server) {
    this.nodeId = randomUUID();
    this.channels = new Map(); // tenantId -> {conns, lastSeq, pumping, again}
    this.conns = new Set();
    this.bus = new Bus({
      onMessage: (message) => this.#onBusMessage(message),
      onReconnect: () => {
        for (const tenantId of this.channels.keys()) this.#pump(tenantId);
      },
    });
    this.presence = new Presence({
      nodeId: this.nodeId,
      publish: (message) => this.bus.publish(message),
      onChange: (tenantId) => this.#broadcastPresence(tenantId),
    });
    this.wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
    this.wss.on('connection', (ws) => this.#onConnection(ws));
    this.pingTimer = setInterval(() => this.#pingAll(), config.wsPingIntervalMs);
    this.pingTimer.unref();
  }

  start() {
    return this.bus.start();
  }

  async stop() {
    clearInterval(this.pingTimer);
    this.presence.stop();
    for (const conn of this.conns) conn.ws.terminate();
    await new Promise((resolve) => this.wss.close(resolve));
    await this.bus.stop();
  }

  // --- connection lifecycle ---------------------------------------------------

  #onConnection(ws) {
    const conn = {
      id: randomUUID(),
      ws,
      user: null,
      tenantId: null,
      cursor: 0,
      replaying: false,
      buffer: [],
      alive: true,
      boardId: null,
      taskId: null,
      expiry: null,
      queue: Promise.resolve(),
    };
    this.conns.add(conn);
    conn.authTimer = setTimeout(() => ws.close(4401, 'auth timeout'), AUTH_TIMEOUT_MS);

    ws.on('pong', () => {
      conn.alive = true;
    });
    // Handled strictly in arrival order, so subscribe then presence.update is safe.
    ws.on('message', (data) => {
      conn.queue = conn.queue
        .then(() => this.#onMessage(conn, data))
        .catch((err) => {
          console.error('[ws] handler error', err);
          this.#send(conn, { type: 'error', code: 'INTERNAL', message: 'Something went wrong' });
        });
    });
    ws.on('close', () => this.#onClose(conn));
    ws.on('error', () => ws.terminate());
  }

  #onClose(conn) {
    clearTimeout(conn.authTimer);
    clearTimeout(conn.expiry);
    this.#leave(conn);
    this.conns.delete(conn);
  }

  #pingAll() {
    for (const conn of this.conns) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      conn.ws.ping();
    }
  }

  #send(conn, message) {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    // A client that can't keep up is cut loose. It recovers through replay.
    if (conn.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      conn.ws.terminate();
      return;
    }
    conn.ws.send(JSON.stringify(message));
  }

  // --- client messages --------------------------------------------------------

  async #onMessage(conn, data) {
    let parsed;
    try {
      parsed = ClientMessage.parse(JSON.parse(data.toString()));
    } catch {
      this.#send(conn, { type: 'error', code: 'BAD_MESSAGE', message: 'Unrecognized message' });
      return;
    }

    if (parsed.type === 'auth') return this.#onAuth(conn, parsed);
    if (parsed.type === 'ping') return this.#send(conn, { type: 'pong' });
    if (!conn.user) {
      this.#send(conn, { type: 'error', code: 'UNAUTHORIZED', message: 'Send auth first' });
      return;
    }
    if (parsed.type === 'subscribe') return this.#onSubscribe(conn, parsed);
    if (parsed.type === 'unsubscribe') return this.#leave(conn);
    if (parsed.type === 'presence.update' && conn.tenantId) {
      conn.boardId = parsed.boardId ?? null;
      conn.taskId = parsed.taskId ?? null;
      this.presence.set(conn.tenantId, conn.id, this.#presenceEntry(conn));
    }
  }

  async #onAuth(conn, { token }) {
    const session = verifyToken(token);
    const user = session && (await this.#loadUser(session.userId));
    if (!user) {
      conn.ws.close(4401, 'invalid token');
      return;
    }
    clearTimeout(conn.authTimer);
    clearTimeout(conn.expiry);
    conn.user = user;
    // The socket can't outlive the credential that opened it.
    const remaining = session.exp * 1000 - Date.now();
    conn.expiry = setTimeout(() => conn.ws.close(4401, 'token expired'), remaining);
    conn.expiry.unref();
    this.#send(conn, { type: 'auth.ok', user });
  }

  async #loadUser(userId) {
    const { rows } = await pool.query('SELECT id, name, color FROM users WHERE id = $1', [userId]);
    return rows[0] ?? null;
  }

  async #onSubscribe(conn, { tenantId, lastSeq, boardId }) {
    // Non-members get the same reply whether or not the tenant exists.
    const access = await resolveTenantAccess(conn.user.id, tenantId);
    if (!access) {
      this.#send(conn, { type: 'error', code: 'NOT_FOUND', message: 'Tenant not found', tenantId });
      return;
    }

    this.#leave(conn);
    conn.tenantId = tenantId;
    conn.boardId = boardId ?? null;
    conn.taskId = null;
    conn.replaying = true;
    conn.buffer = [];
    await this.#join(conn, tenantId);

    const { seq, events, resync } = await withTenantSystem(tenantId, async (tx) => {
      const current = await currentSeq(tx, tenantId);
      if (lastSeq === null || lastSeq === undefined) return { seq: current, events: [], resync: false };
      const behind = current - lastSeq;
      if (behind < 0 || behind > config.maxReplayEvents) return { seq: current, events: [], resync: true };
      return { seq: current, events: await readEventsAfter(tx, tenantId, lastSeq, config.maxReplayEvents), resync: false };
    });

    // Access may have been revoked while that ran.
    if (conn.tenantId !== tenantId) return;

    this.presence.set(tenantId, conn.id, this.#presenceEntry(conn));
    this.#send(conn, { type: 'subscribed', tenantId, seq, role: access.role, presence: this.presence.list(tenantId) });
    if (resync) this.#send(conn, { type: 'resync.required', tenantId, seq });
    for (const event of events) this.#send(conn, { type: 'event', event });

    conn.cursor = seq;
    for (const event of conn.buffer) {
      if (event.seq > conn.cursor) {
        this.#send(conn, { type: 'event', event });
        conn.cursor = event.seq;
      }
    }
    conn.buffer = [];
    conn.replaying = false;
  }

  #presenceEntry(conn) {
    return {
      connId: conn.id,
      userId: conn.user.id,
      name: conn.user.name,
      color: conn.user.color,
      boardId: conn.boardId,
      taskId: conn.taskId,
    };
  }

  // --- channels ---------------------------------------------------------------

  async #join(conn, tenantId) {
    let channel = this.channels.get(tenantId);
    if (!channel) {
      channel = { conns: new Set(), lastSeq: null, pumping: false, again: false };
      this.channels.set(tenantId, channel);
    }
    channel.conns.add(conn);
    if (channel.lastSeq === null) {
      const seq = await withTenantSystem(tenantId, (tx) => currentSeq(tx, tenantId));
      channel.lastSeq ??= seq;
    }
  }

  #leave(conn) {
    const { tenantId } = conn;
    if (!tenantId) return;
    conn.tenantId = null;
    conn.replaying = false;
    conn.buffer = [];
    const channel = this.channels.get(tenantId);
    channel?.conns.delete(conn);
    if (channel && !channel.conns.size) this.channels.delete(tenantId);
    this.presence.remove(tenantId, conn.id);
  }

  #onBusMessage(message) {
    if (message.kind === 'event') {
      if (this.channels.has(message.tenantId)) this.#pump(message.tenantId);
    } else if (message.kind === 'presence') {
      this.presence.receive(message);
    } else if (message.kind === 'access') {
      this.#recheckAccess(message).catch((err) => console.error('[ws] access recheck failed', err));
    }
  }

  /** Reads new events from the log and fans them out. Coalesces bursts into one loop. */
  async #pump(tenantId) {
    const channel = this.channels.get(tenantId);
    if (!channel) return;
    if (channel.pumping) {
      channel.again = true;
      return;
    }
    channel.pumping = true;
    try {
      do {
        channel.again = false;
        if (channel.lastSeq === null) {
          channel.lastSeq = await withTenantSystem(tenantId, (tx) => currentSeq(tx, tenantId));
        }
        const events = await withTenantSystem(tenantId, (tx) =>
          readEventsAfter(tx, tenantId, channel.lastSeq, PUMP_BATCH),
        );
        for (const event of events) {
          channel.lastSeq = event.seq;
          for (const conn of channel.conns) {
            if (conn.replaying) conn.buffer.push(event);
            else if (event.seq > conn.cursor) {
              conn.cursor = event.seq;
              this.#send(conn, { type: 'event', event });
            }
          }
        }
        if (events.length === PUMP_BATCH) channel.again = true;
      } while (channel.again);
    } catch (err) {
      console.error('[ws] pump failed', err);
    } finally {
      channel.pumping = false;
    }
  }

  /** Runs when memberships change or a tenant is deleted anywhere in the cluster. */
  async #recheckAccess({ userId, tenantId }) {
    const affected = [...this.conns].filter(
      (conn) =>
        conn.user && conn.tenantId && ((userId && conn.user.id === userId) || (tenantId && conn.tenantId === tenantId)),
    );
    for (const conn of affected) {
      const subscribed = conn.tenantId;
      const access = await resolveTenantAccess(conn.user.id, subscribed);
      if (!access && conn.tenantId === subscribed) {
        this.#leave(conn);
        this.#send(conn, { type: 'subscription.revoked', tenantId: subscribed });
      }
    }
  }

  #broadcastPresence(tenantId) {
    const channel = this.channels.get(tenantId);
    if (!channel) return;
    const message = { type: 'presence', tenantId, members: this.presence.list(tenantId) };
    for (const conn of channel.conns) {
      if (!conn.replaying) this.#send(conn, message);
    }
  }
}
