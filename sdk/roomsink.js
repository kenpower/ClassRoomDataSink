/**
 * RoomSink client SDK — dependency-free ES module.
 *
 *   import { RoomSink } from 'https://your-host/sdk/roomsink.js';
 *   const rs = await RoomSink.connect({ api: 'https://your-host' }); // reads ?r=CODE, joins, caches the token
 *   rs.config; rs.app('quiz').config; rs.group('quiz');
 *   await rs.send('quiz', { answer: 'B' });
 *   await rs.deleteMyData();
 *   rs.onStatus((status) => ...);               // 'open' | 'closed' | 'draft' | 'gone'
 *
 * Also defines <roomsink-privacy>, a privacy notice with a "Delete my data" button.
 */

const VERSION = '1.0.0';
const MAX_QUEUE = 200;
const MAX_ATTEMPTS = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function safeStorage() {
  try {
    const s = globalThis.localStorage;
    const k = '__roomsink_probe__';
    s.setItem(k, '1');
    s.removeItem(k);
    return s;
  } catch {
    const m = new Map();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  }
}

export class RoomSinkError extends Error {
  constructor(code, message, status, retryAfter) {
    super(message);
    this.name = 'RoomSinkError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Errors worth retrying: network failures, 429 rate limits and 5xx. */
const retriable = (e) => e.status === 0 || e.status === 429 || e.status >= 500 || e.code === 'RATE_LIMITED';

export class RoomSink {
  /**
   * @param {{api?: string, room?: string, storage?: Storage, fetch?: typeof fetch, pollMs?: number}} opts
   */
  static async connect(opts = {}) {
    const params = new URLSearchParams(globalThis.location?.search ?? '');
    const room = String(opts.room ?? params.get('r') ?? params.get('room') ?? '')
      .trim()
      .toUpperCase();
    if (!/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(room)) throw new RoomSinkError('ROOM_NOT_FOUND', 'No valid room code (expected ?r=CODE)', 404);
    const rs = new RoomSink(room, opts);
    await rs._init();
    RoomSink.last = rs;
    return rs;
  }

  constructor(room, opts) {
    this.room = room;
    this.api = String(opts.api ?? '').replace(/\/+$/, '');
    this._fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this._storage = opts.storage ?? safeStorage();
    this._pollMs = opts.pollMs ?? 15000;
    this._tokenKey = `roomsink:${this.room}:token`;
    this._queue = [];
    this._sending = false;
    this._statusCbs = new Set();
    this._pollTimer = null;
    this.config = null;
    this.token = null;
    this.cid = null;
    this.groups = {};
    this.status = null;
  }

  async _request(method, path, { body, headers = {}, auth = false } = {}) {
    const h = { ...headers };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (auth && this.token) h.Authorization = `Bearer ${this.token}`;
    let res;
    try {
      res = await this._fetch(`${this.api}/api/v1/rooms/${this.room}${path}`, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (err) {
      throw new RoomSinkError('NETWORK', String(err?.message ?? err), 0);
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* empty body */
    }
    if (!res.ok) {
      const e = json?.error ?? {};
      const ra = Number(res.headers.get('Retry-After') ?? e.retryAfter);
      throw new RoomSinkError(e.code ?? 'HTTP_' + res.status, e.message ?? res.statusText, res.status, Number.isFinite(ra) ? ra : undefined);
    }
    return json;
  }

  async _init() {
    this.config = await this._request('GET', '/config');
    this.status = this.config.status;
    await this._join();
  }

  async _join() {
    const existing = this._storage.getItem(this._tokenKey);
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await this._request('POST', '/join', { body: existing ? { existingToken: existing } : {} });
        break;
      } catch (e) {
        // A classroom joining at once shares one IP; wait out join rate limits.
        if (!retriable(e) || attempt >= MAX_ATTEMPTS) throw e;
        await sleep(backoff(attempt, e.retryAfter));
      }
    }
    this.token = res.token;
    this.cid = res.cid;
    this.groups = res.groups ?? {};
    this.expiresAt = res.expiresAt;
    this._storage.setItem(this._tokenKey, res.token);
  }

  /** The config for one app ({} if the app is not enabled). */
  app(name) {
    const a = this.config?.apps?.find((x) => x.name === name);
    return { name, enabled: !!a, config: a?.config ?? {} };
  }

  /** The A/B group the server assigned this client for an app, or null. */
  group(name) {
    return this.groups[name] ?? null;
  }

  /**
   * Queue an event. Resolves with {id, seq} once stored. Retries with exponential backoff and jitter on
   * 429/5xx/network errors (the Idempotency-Key makes retries safe); rejects on validation errors.
   */
  send(app, data, { clientT = Date.now(), appVersion } = {}) {
    if (this._queue.length >= MAX_QUEUE) return Promise.reject(new RoomSinkError('QUEUE_FULL', 'Too many unsent events', 0));
    return new Promise((resolve, reject) => {
      const body = { app, data, clientT };
      if (appVersion) body.appVersion = appVersion;
      this._queue.push({ body, key: uuid(), resolve, reject, attempt: 0 });
      void this._drain();
    });
  }

  async _drain() {
    if (this._sending) return;
    this._sending = true;
    try {
      while (this._queue.length) {
        const item = this._queue[0];
        try {
          const res = await this._request('POST', '/events', { body: item.body, auth: true, headers: { 'Idempotency-Key': item.key } });
          this._queue.shift();
          item.resolve(res);
        } catch (e) {
          if (e.code === 'TOKEN_INVALID' && item.attempt === 0) {
            // Token expired (12 h) or the room was re-created: rejoin once, then retry.
            item.attempt++;
            this._storage.removeItem(this._tokenKey);
            try {
              await this._join();
              continue;
            } catch (je) {
              e = je;
            }
          }
          if (retriable(e) && item.attempt < MAX_ATTEMPTS) {
            await sleep(backoff(item.attempt++, e.retryAfter));
            continue;
          }
          this._queue.shift();
          if (e.code === 'ROOM_CLOSED') this._setStatus('closed');
          item.reject(e);
        }
      }
    } finally {
      this._sending = false;
    }
  }

  /** Number of events waiting to be sent. */
  get pending() {
    return this._queue.length;
  }

  /** This client's own stored events. */
  async myData() {
    return this._request('GET', '/me', { auth: true });
  }

  /** Hard-delete everything this client sent. Works after the room closes. */
  async deleteMyData() {
    const res = await this._request('DELETE', '/me', { auth: true });
    for (const item of this._queue.splice(0)) item.reject(new RoomSinkError('CLIENT_DELETED', 'Data deleted', 410));
    this._storage.removeItem(this._tokenKey);
    return res;
  }

  /** Poll the room config and report status changes ('open' | 'closed' | 'draft' | 'gone'). */
  onStatus(cb) {
    this._statusCbs.add(cb);
    if (this.status) queueMicrotask(() => cb(this.status));
    if (!this._pollTimer) {
      this._pollTimer = setInterval(async () => {
        try {
          const cfg = await this._request('GET', '/config');
          this.config = cfg;
          this._setStatus(cfg.status);
        } catch (e) {
          if (e.status === 404) this._setStatus('gone');
        }
      }, this._pollMs);
    }
    return () => {
      this._statusCbs.delete(cb);
      if (!this._statusCbs.size) this.close();
    };
  }

  _setStatus(s) {
    if (s === this.status) return;
    this.status = s;
    for (const cb of this._statusCbs) {
      try {
        cb(s);
      } catch {
        /* user callback */
      }
    }
  }

  close() {
    clearInterval(this._pollTimer);
    this._pollTimer = null;
  }
}

RoomSink.version = VERSION;
RoomSink.last = null;

function backoff(attempt, retryAfterS) {
  const base = Math.min(30_000, 500 * 2 ** attempt);
  const jitter = Math.random() * base * 0.5;
  return Math.max((retryAfterS ?? 0) * 1000, base / 2 + jitter);
}

export const PRIVACY_NOTICE =
  'This activity collects your answers anonymously for teaching. No name, email or IP address is stored. ' +
  'Data is deleted automatically after the session. You can delete your data at any time.';

/**
 * <roomsink-privacy> — privacy notice and "Delete my data" button. Works in any framework.
 * Uses RoomSink.last unless `element.client = rs` is set. Optional attribute: notice="…".
 * Fires `roomsink-deleted` when data has been deleted.
 */
if (typeof HTMLElement !== 'undefined' && typeof customElements !== 'undefined' && !customElements.get('roomsink-privacy')) {
  class RoomSinkPrivacy extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = `:host{display:block;font:14px/1.4 system-ui,sans-serif;color:inherit}
        p{margin:0 0 .5em}
        button{font:inherit;padding:.4em .9em;border-radius:6px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer}
        button:focus-visible{outline:3px solid #2563eb;outline-offset:2px}
        [role=status]{margin-top:.4em}`;
      this._p = document.createElement('p');
      this._btn = document.createElement('button');
      this._btn.type = 'button';
      this._btn.textContent = 'Delete my data';
      this._status = document.createElement('div');
      this._status.setAttribute('role', 'status');
      this._status.setAttribute('aria-live', 'polite');
      root.append(style, this._p, this._btn, this._status);
      this._btn.addEventListener('click', () => void this._delete());
    }
    connectedCallback() {
      this._p.textContent = this.getAttribute('notice') || PRIVACY_NOTICE;
    }
    async _delete() {
      const rs = this.client ?? RoomSink.last;
      if (!rs) return void (this._status.textContent = 'Not connected to a room.');
      if (!confirm('Delete everything you have sent in this activity? This cannot be undone.')) return;
      this._btn.disabled = true;
      try {
        const r = await rs.deleteMyData();
        this._status.textContent = `Deleted ${r.deleted} item(s).`;
        this.dispatchEvent(new CustomEvent('roomsink-deleted', { detail: r, bubbles: true }));
      } catch (e) {
        this._status.textContent = `Could not delete: ${e.message}`;
        this._btn.disabled = false;
      }
    }
  }
  customElements.define('roomsink-privacy', RoomSinkPrivacy);
}

export default RoomSink;
