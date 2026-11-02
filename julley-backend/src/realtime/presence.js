import { config } from '../config.js';

const MAX_BUS_ENTRIES = 40; // keeps a presence message inside the 8 KB NOTIFY limit

/**
 * Who is connected, per tenant. Ephemeral by design: held in memory on each node,
 * shared over the bus, and expired by heartbeat so a crashed node's users vanish.
 */
export class Presence {
  constructor({ nodeId, publish, onChange }) {
    this.nodeId = nodeId;
    this.publish = publish;
    this.onChange = onChange;
    this.local = new Map(); // tenantId -> Map(connId -> entry)
    this.remote = new Map(); // tenantId -> Map(nodeId -> {entries, at})
    this.timer = setInterval(() => this.#tick(), config.presenceHeartbeatMs);
    this.timer.unref();
  }

  set(tenantId, connId, entry) {
    if (!this.local.has(tenantId)) this.local.set(tenantId, new Map());
    this.local.get(tenantId).set(connId, entry);
    this.#changed(tenantId);
  }

  remove(tenantId, connId) {
    const entries = this.local.get(tenantId);
    if (!entries?.delete(connId)) return;
    this.#changed(tenantId);
    if (!entries.size) this.local.delete(tenantId);
  }

  list(tenantId) {
    const entries = [...(this.local.get(tenantId)?.values() ?? [])];
    for (const peer of this.remote.get(tenantId)?.values() ?? []) entries.push(...peer.entries);
    return entries;
  }

  /** A presence message from another node. */
  receive({ node, tenantId, entries }) {
    if (node === this.nodeId) return;
    if (!this.remote.has(tenantId)) this.remote.set(tenantId, new Map());
    const peers = this.remote.get(tenantId);
    const firstContact = !peers.has(node);
    peers.set(node, { entries, at: Date.now() });
    // A node that just appeared shouldn't wait for our heartbeat to see our users.
    if (firstContact && this.local.has(tenantId)) this.#broadcast(tenantId);
    this.onChange(tenantId);
  }

  stop() {
    clearInterval(this.timer);
    for (const tenantId of this.local.keys()) {
      this.publish({ kind: 'presence', node: this.nodeId, tenantId, entries: [] }).catch(() => {});
    }
  }

  #changed(tenantId) {
    this.#broadcast(tenantId);
    this.onChange(tenantId);
  }

  #broadcast(tenantId) {
    const entries = [...(this.local.get(tenantId)?.values() ?? [])].slice(0, MAX_BUS_ENTRIES);
    this.publish({ kind: 'presence', node: this.nodeId, tenantId, entries }).catch((err) => {
      console.error('[presence] publish failed', err.message);
    });
  }

  #tick() {
    for (const tenantId of this.local.keys()) this.#broadcast(tenantId);
    const cutoff = Date.now() - config.presenceTtlMs;
    for (const [tenantId, peers] of this.remote) {
      let expired = false;
      for (const [node, peer] of peers) {
        if (peer.at < cutoff) {
          expired = true;
          peers.delete(node);
        }
      }
      if (!peers.size) this.remote.delete(tenantId);
      if (expired) this.onChange(tenantId);
    }
  }
}
