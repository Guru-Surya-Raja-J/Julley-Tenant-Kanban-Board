const HEARTBEAT_MS = 20_000;
const HEARTBEAT_TIMEOUT_MS = 8_000;
const MAX_BACKOFF_MS = 15_000;

/**
 * The WebSocket connection. Owns reconnecting and heartbeats, and knows nothing
 * about boards: messages go to `onMessage`, and `onStatus` reports
 * 'connecting' | 'live' | 'reconnecting' | 'closed'.
 */
export class RealtimeClient {
  constructor({ url, getToken, onMessage, onStatus, onOpen, onAuthFailed }) {
    Object.assign(this, { url, getToken, onMessage, onStatus, onOpen, onAuthFailed });
    this.ws = null;
    this.attempts = 0;
    this.stopped = true;
    this.timers = {};
  }

  connect() {
    this.stopped = false;
    this.#open();
  }

  disconnect() {
    this.stopped = true;
    this.#clearTimers();
    const { ws } = this;
    this.ws = null;
    ws?.close();
    this.onStatus('closed');
  }

  /** Drops the socket and reconnects now, skipping any backoff in progress. */
  reconnectNow() {
    if (this.stopped) return;
    this.attempts = 0;
    clearTimeout(this.timers.retry);
    if (this.ws?.readyState === WebSocket.OPEN) return;
    this.ws?.close();
    this.ws = null;
    this.#open();
  }

  /**
   * The browser reports it lost the network. A socket can sit there looking open
   * until the heartbeat notices, so abandon it now and start retrying.
   */
  dropForOffline() {
    if (this.stopped || !this.ws) return;
    const { ws } = this;
    this.ws = null;
    this.authed = false;
    ws.onclose = null;
    ws.close();
    this.#clearTimers();
    this.#scheduleRetry();
  }

  send(message) {
    if (this.ws?.readyState === WebSocket.OPEN && this.authed) {
      this.ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  #open() {
    this.#clearTimers();
    this.authed = false;
    this.onStatus(this.attempts ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token: this.getToken() }));
    };
    ws.onmessage = (raw) => {
      if (this.ws !== ws) return;
      const message = JSON.parse(raw.data);
      if (message.type === 'auth.ok') {
        this.authed = true;
        this.attempts = 0;
        this.#startHeartbeat(ws);
        this.onOpen();
        return;
      }
      if (message.type === 'pong') {
        clearTimeout(this.timers.pongDeadline);
        return;
      }
      this.onMessage(message);
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.authed = false;
      this.#clearTimers();
      if (this.stopped) return;
      if (event.code === 4401) {
        this.stopped = true;
        this.onStatus('closed');
        this.onAuthFailed();
        return;
      }
      this.#scheduleRetry();
    };
    // Every failed connection also fires close, which handles the retry.
    ws.onerror = () => {};
  }

  #scheduleRetry() {
    this.attempts += 1;
    this.onStatus('reconnecting');
    const ceiling = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempts);
    // Jitter, so a restarted server isn't hit by every client at the same moment.
    const delay = ceiling / 2 + Math.random() * (ceiling / 2);
    this.timers.retry = setTimeout(() => this.#open(), delay);
  }

  /** Detects half-open connections, which never fire a close event on their own. */
  #startHeartbeat(ws) {
    this.timers.heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'ping' }));
      clearTimeout(this.timers.pongDeadline);
      this.timers.pongDeadline = setTimeout(() => ws.close(), HEARTBEAT_TIMEOUT_MS);
    }, HEARTBEAT_MS);
  }

  #clearTimers() {
    clearTimeout(this.timers.retry);
    clearTimeout(this.timers.pongDeadline);
    clearInterval(this.timers.heartbeat);
  }
}
