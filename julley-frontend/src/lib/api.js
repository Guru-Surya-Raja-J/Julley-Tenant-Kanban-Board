const TOKEN_KEY = 'tenant-flow.token';

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

let token = readToken();
let onUnauthorized = () => {};

export function getToken() {
  return token;
}

export function setToken(next) {
  token = next;
  try {
    if (next) localStorage.setItem(TOKEN_KEY, next);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage may be blocked; the session then lasts until reload.
  }
}

export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

/** The server answered with an error. `network` is false. */
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? 'Request failed');
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details;
    this.network = false;
    // Worth retrying: the server may not have applied the request.
    this.retryable = status >= 500 || status === 429;
  }
}

/** The request may or may not have reached the server. Safe to retry with its key. */
export class NetworkError extends Error {
  constructor(cause) {
    super('Network unavailable');
    this.cause = cause;
    this.network = true;
    this.retryable = true;
  }
}

async function request(method, path, { body, opId } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(opId ? { 'idempotency-key': opId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new NetworkError(err);
  }

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // A proxy's HTML error page: the API itself is unreachable.
    throw new NetworkError(new Error(`Unexpected response (${res.status})`));
  }

  // An error with no body came from the dev proxy: the backend isn't running.
  if (!res.ok && data === null) throw new NetworkError(new Error(`Unexpected response (${res.status})`));
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized();
    throw new ApiError(res.status, data);
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body, options) => request('POST', path, { body: body ?? {}, ...options }),
  patch: (path, body, options) => request('PATCH', path, { body, ...options }),
  del: (path, options) => request('DELETE', path, options),
};
