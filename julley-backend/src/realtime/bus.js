import pg from 'pg';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { BUS_CHANNEL } from '../domain/events.js';

/**
 * The cross-node message bus: Postgres LISTEN/NOTIFY.
 * Nodes share nothing else, so any instance can serve any socket.
 */
export class Bus {
  constructor({ onMessage, onReconnect }) {
    this.onMessage = onMessage;
    this.onReconnect = onReconnect;
    this.stopped = false;
    this.client = null;
  }

  start() {
    return this.#connect();
  }

  async #connect() {
    const client = new pg.Client({ connectionString: config.databaseUrl });
    client.on('notification', (msg) => {
      try {
        this.onMessage(JSON.parse(msg.payload));
      } catch (err) {
        console.error('[bus] bad notification', err.message);
      }
    });
    const lost = () => {
      if (this.client !== client) return;
      this.client = null;
      if (!this.stopped) setTimeout(() => this.#reconnect(), 1000).unref();
    };
    client.on('error', lost);
    client.on('end', lost);
    await client.connect();
    await client.query(`LISTEN ${BUS_CHANNEL}`);
    this.client = client;
  }

  async #reconnect() {
    if (this.stopped || this.client) return;
    try {
      await this.#connect();
      // Anything sent while disconnected was missed, so catch up from the log.
      this.onReconnect?.();
    } catch {
      setTimeout(() => this.#reconnect(), 2000).unref();
    }
  }

  publish(message) {
    return pool.query('SELECT pg_notify($1, $2)', [BUS_CHANNEL, JSON.stringify(message)]);
  }

  async stop() {
    this.stopped = true;
    const { client } = this;
    this.client = null;
    await client?.end().catch(() => {});
  }
}
