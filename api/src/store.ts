import { ulid } from 'ulid';
import type { ResultSetHeader } from 'mysql2/promise';
import { tx, isDuplicateKey, type Db, type Conn, type Row } from './db.js';
import { ApiError, roomNotFound } from './errors.js';
import { pickWeighted, randomRoomCode } from './codes.js';
import type { RoomLimits } from './ratelimit.js';
import type { EventInput } from './validate.js';
import type { LiveEvent } from './live.js';

export type RoomStatus = 'draft' | 'open' | 'closed';

export interface AppDef {
  name: string;
  enabled: boolean;
  maxEventsPerClient: number;
  allowFreeText: boolean;
  groups: Record<string, number> | null;
  config: Record<string, unknown>;
  schema: unknown | null;
}

export interface Room {
  code: string;
  title: string;
  owner: string;
  status: RoomStatus;
  purpose: 'teaching' | 'research';
  publicConfig: Record<string, unknown>;
  limits: StoredLimits;
  presenterKeyHash: string | null;
  nextSeq: number;
  eventCount: number;
  bytesUsed: number;
  createdAt: Date;
  closesAt: Date;
  expiresAt: Date;
}

/** rooms.limits JSON: rate/cap overrides plus lifecycle durations. */
export interface StoredLimits extends Partial<RoomLimits> {
  openMinutes?: number;
  retainHours?: number;
}

export interface RoomWithApps extends Room {
  apps: AppDef[];
  owners: string[];
}

export const DEFAULT_OPEN_MINUTES = 180;
export const DEFAULT_RETAIN_HOURS = 24;
export const MAX_LIFETIME_MS = 30 * 24 * 3600 * 1000;
export const RETIRED_CODE_DAYS = 30;
export const IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000;

const asJson = <T>(v: unknown, fallback: T): T => {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
};

function rowToRoom(r: Row): Room {
  return {
    code: r.code,
    title: r.title,
    owner: r.owner,
    status: r.status,
    purpose: r.purpose,
    publicConfig: asJson(r.public_config, {}),
    limits: asJson(r.limits, {}),
    presenterKeyHash: r.presenter_key_hash ?? null,
    nextSeq: Number(r.next_seq),
    eventCount: Number(r.event_count),
    bytesUsed: Number(r.bytes_used),
    createdAt: r.created_at,
    closesAt: r.closes_at,
    expiresAt: r.expires_at,
  };
}

function rowToApp(r: Row): AppDef {
  return {
    name: r.name,
    enabled: !!r.enabled,
    maxEventsPerClient: Number(r.max_events_per_client),
    allowFreeText: !!r.allow_free_text,
    groups: asJson(r.groups, null),
    config: asJson(r.config, {}),
    schema: asJson(r.schema, null),
  };
}

export function openMinutes(l: StoredLimits) {
  return l.openMinutes && l.openMinutes > 0 ? l.openMinutes : DEFAULT_OPEN_MINUTES;
}
export function retainHours(l: StoredLimits) {
  return l.retainHours && l.retainHours > 0 ? l.retainHours : DEFAULT_RETAIN_HOURS;
}

/** Short-lived cache of rooms + apps; invalidated on every mutation (single API instance). */
class RoomCache {
  private m = new Map<string, { at: number; room: RoomWithApps | null }>();
  constructor(private ttlMs: number) {}
  get(code: string) {
    const e = this.m.get(code);
    if (!e) return undefined;
    if (Date.now() - e.at > this.ttlMs) {
      this.m.delete(code);
      return undefined;
    }
    return e.room;
  }
  set(code: string, room: RoomWithApps | null) {
    if (this.m.size > 5000) this.m.clear();
    this.m.set(code, { at: Date.now(), room });
  }
  delete(code: string) {
    this.m.delete(code);
  }
  clear() {
    this.m.clear();
  }
}

interface PendingWrite {
  room: RoomWithApps;
  cid: string;
  key: string;
  events: (EventInput & { bytes: number })[];
  limits: RoomLimits;
  resolve: (r: WriteResult) => void;
  reject: (e: unknown) => void;
}

type Outcome = { ok: true; result: WriteResult } | { ok: false; error: ApiError };

export interface WriteResult {
  ids: string[];
  seqs: number[];
  duplicate: boolean;
  live: LiveEvent[];
}

export class Store {
  readonly cache = new RoomCache(5000);
  constructor(readonly db: Db) {}

  // ---------- rooms ----------

  /** Fetch a live (non-expired) room with apps and co-owners. Expired rooms are indistinguishable from unknown ones. */
  async getRoom(code: string, { fresh = false } = {}): Promise<RoomWithApps | null> {
    if (!fresh) {
      const c = this.cache.get(code);
      if (c !== undefined) return c && c.expiresAt.getTime() > Date.now() ? c : null;
    }
    const [rooms] = await this.db.query<Row[]>('SELECT * FROM rooms WHERE code = ? AND expires_at > UTC_TIMESTAMP(3)', [code]);
    if (!rooms[0]) {
      this.cache.set(code, null);
      return null;
    }
    const [apps] = await this.db.query<Row[]>('SELECT * FROM apps WHERE room = ? ORDER BY name', [code]);
    const [owners] = await this.db.query<Row[]>('SELECT staff_id FROM room_owners WHERE room = ? ORDER BY staff_id', [code]);
    const room: RoomWithApps = { ...rowToRoom(rooms[0]), apps: apps.map(rowToApp), owners: owners.map((o) => o.staff_id) };
    this.cache.set(code, room);
    return room;
  }

  async requireRoom(code: string, opts?: { fresh?: boolean }): Promise<RoomWithApps> {
    const r = await this.getRoom(code, opts);
    if (!r) throw roomNotFound();
    return r;
  }

  async countActiveRoomsForOwner(owner: string): Promise<number> {
    const [r] = await this.db.query<Row[]>(
      "SELECT COUNT(*) n FROM rooms WHERE owner = ? AND status IN ('draft','open') AND expires_at > UTC_TIMESTAMP(3)",
      [owner],
    );
    return Number(r[0]!.n);
  }

  async listRooms(staff: string | null) {
    const base = `SELECT r.*, (SELECT COUNT(*) FROM clients c WHERE c.room = r.code AND c.deleted = FALSE) AS client_count
      FROM rooms r WHERE r.expires_at > UTC_TIMESTAMP(3)`;
    const [rows] = staff
      ? await this.db.query<Row[]>(
          `${base} AND (r.owner = ? OR r.code IN (SELECT room FROM room_owners WHERE staff_id = ?)) ORDER BY r.created_at DESC LIMIT 500`,
          [staff, staff],
        )
      : await this.db.query<Row[]>(`${base} ORDER BY r.created_at DESC LIMIT 1000`);
    return rows.map((r) => ({ ...rowToRoom(r), clientCount: Number(r.client_count) }));
  }

  async clientCount(code: string): Promise<{ total: number; deleted: number }> {
    const [r] = await this.db.query<Row[]>(
      'SELECT COUNT(*) total, COALESCE(SUM(deleted), 0) deleted FROM clients WHERE room = ?',
      [code],
    );
    return { total: Number(r[0]!.total), deleted: Number(r[0]!.deleted) };
  }

  /** Insert a room with a fresh code not in use and not retired in the last 30 days. */
  async createRoom(input: {
    title: string;
    owner: string;
    purpose: 'teaching' | 'research';
    publicConfig: Record<string, unknown>;
    limits: StoredLimits;
    presenterKeyHash: string | null;
    closesAt?: Date;
    expiresAt?: Date;
    apps: AppDef[];
    owners: string[];
    status?: RoomStatus;
  }): Promise<string> {
    const now = new Date();
    const closesAt = input.closesAt ?? new Date(now.getTime() + openMinutes(input.limits) * 60_000);
    const expiresAt = input.expiresAt ?? new Date(closesAt.getTime() + retainHours(input.limits) * 3600_000);
    checkTimes(now, closesAt, expiresAt);
    for (let attempt = 0; attempt < 20; attempt++) {
      const code = randomRoomCode();
      try {
        await tx(this.db, async (c) => {
          const [retired] = await c.query<Row[]>(
            'SELECT 1 FROM retired_codes WHERE code = ? AND retired_at > UTC_TIMESTAMP(3) - INTERVAL ? DAY',
            [code, RETIRED_CODE_DAYS],
          );
          if (retired.length) throw Object.assign(new Error('retired'), { code: 'ER_DUP_ENTRY' });
          await c.query(
            `INSERT INTO rooms (code, title, owner, status, purpose, public_config, limits, presenter_key_hash, created_at, closes_at, expires_at)
             VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), ?, ?, ?, ?)`,
            [
              code,
              input.title,
              input.owner,
              input.status ?? 'draft',
              input.purpose,
              JSON.stringify(input.publicConfig),
              JSON.stringify(input.limits),
              input.presenterKeyHash,
              now,
              closesAt,
              expiresAt,
            ],
          );
          await replaceApps(c, code, input.apps, true);
          await replaceOwners(c, code, input.owners, input.owner, true);
        });
        this.cache.delete(code);
        return code;
      } catch (err) {
        if (isDuplicateKey(err)) continue;
        throw err;
      }
    }
    throw new ApiError('UNAVAILABLE', 'Could not allocate a room code');
  }

  async updateRoom(
    code: string,
    patch: {
      title?: string;
      purpose?: 'teaching' | 'research';
      publicConfig?: Record<string, unknown>;
      limits?: StoredLimits;
      closesAt?: Date;
      expiresAt?: Date;
      apps?: AppDef[];
      owners?: string[];
    },
  ) {
    await tx(this.db, async (c) => {
      const [rows] = await c.query<Row[]>('SELECT * FROM rooms WHERE code = ? AND expires_at > UTC_TIMESTAMP(3) FOR UPDATE', [code]);
      if (!rows[0]) throw roomNotFound();
      const room = rowToRoom(rows[0]);
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (patch.title !== undefined) {
        sets.push('title = ?');
        vals.push(patch.title);
      }
      if (patch.purpose !== undefined) {
        sets.push('purpose = ?');
        vals.push(patch.purpose);
      }
      if (patch.publicConfig !== undefined) {
        sets.push('public_config = CAST(? AS JSON)');
        vals.push(JSON.stringify(patch.publicConfig));
      }
      if (patch.limits !== undefined) {
        sets.push('limits = CAST(? AS JSON)');
        vals.push(JSON.stringify(patch.limits));
      }
      if (patch.closesAt !== undefined || patch.expiresAt !== undefined) {
        const closesAt = patch.closesAt ?? room.closesAt;
        const expiresAt = patch.expiresAt ?? room.expiresAt;
        checkTimes(new Date(), closesAt, expiresAt, room.status === 'closed');
        sets.push('closes_at = ?', 'expires_at = ?');
        vals.push(closesAt, expiresAt);
      }
      if (sets.length) await c.query(`UPDATE rooms SET ${sets.join(', ')} WHERE code = ?`, [...vals, code]);
      if (patch.apps) await replaceApps(c, code, patch.apps);
      if (patch.owners) await replaceOwners(c, code, patch.owners, room.owner);
    });
    this.cache.delete(code);
  }

  /**
   * Open: a draft (or a room whose close time has passed) gets a fresh window of openMinutes from now,
   * unless closesAt is given. Close: closes now and data expires retainHours later.
   */
  async setStatus(code: string, status: 'open' | 'closed', opts: { closesAt?: Date } = {}): Promise<void> {
    await tx(this.db, async (c) => {
      const [rows] = await c.query<Row[]>('SELECT * FROM rooms WHERE code = ? AND expires_at > UTC_TIMESTAMP(3) FOR UPDATE', [code]);
      if (!rows[0]) throw roomNotFound();
      const room = rowToRoom(rows[0]);
      const now = Date.now();
      if (status === 'open') {
        let closesAt =
          opts.closesAt?.getTime() ??
          (room.status === 'draft' || room.closesAt.getTime() <= now ? now + openMinutes(room.limits) * 60_000 : room.closesAt.getTime());
        const expiresAt = Math.min(now + MAX_LIFETIME_MS, Math.max(room.expiresAt.getTime(), closesAt + retainHours(room.limits) * 3600_000));
        closesAt = Math.min(closesAt, expiresAt);
        if (closesAt <= now) throw new ApiError('INVALID_PAYLOAD', 'closesAt must be in the future');
        await c.query("UPDATE rooms SET status = 'open', closes_at = ?, expires_at = ? WHERE code = ?", [new Date(closesAt), new Date(expiresAt), code]);
      } else {
        const expiresAt = Math.min(now + MAX_LIFETIME_MS, now + retainHours(room.limits) * 3600_000);
        await c.query("UPDATE rooms SET status = 'closed', closes_at = ?, expires_at = ? WHERE code = ?", [new Date(now), new Date(expiresAt), code]);
      }
    });
    this.cache.delete(code);
  }

  async setPresenterKeyHash(code: string, hash: string) {
    const [r] = await this.db.query<ResultSetHeader>('UPDATE rooms SET presenter_key_hash = ? WHERE code = ? AND expires_at > UTC_TIMESTAMP(3)', [hash, code]);
    if (!r.affectedRows) throw roomNotFound();
    this.cache.delete(code);
  }

  /** Hard-delete a room (cascade removes apps/clients/events) and retire its code. */
  async deleteRoom(code: string) {
    await tx(this.db, async (c) => {
      await c.query('INSERT INTO retired_codes (code, retired_at) VALUES (?, UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE retired_at = VALUES(retired_at)', [code]);
      await c.query('DELETE FROM idempotency WHERE room = ?', [code]);
      await c.query('DELETE FROM ws_tickets WHERE room = ?', [code]);
      await c.query('DELETE FROM rooms WHERE code = ?', [code]);
    });
    this.cache.delete(code);
  }

  async clearEvents(code: string, app?: string): Promise<number> {
    const deleted = await tx(this.db, async (c) => {
      await c.query('SELECT code FROM rooms WHERE code = ? FOR UPDATE', [code]);
      const [r] = app
        ? await c.query<ResultSetHeader>('DELETE FROM events WHERE room = ? AND app = ?', [code, app])
        : await c.query<ResultSetHeader>('DELETE FROM events WHERE room = ?', [code]);
      await recount(c, code);
      return r.affectedRows;
    });
    this.cache.delete(code);
    return deleted;
  }

  // ---------- clients ----------

  async getClient(code: string, cid: string): Promise<{ groups: Record<string, string>; deleted: boolean } | null> {
    const [rows] = await this.db.query<Row[]>('SELECT `groups`, deleted FROM clients WHERE room = ? AND cid = ?', [code, cid]);
    if (!rows[0]) return null;
    return { groups: asJson(rows[0].groups, {}), deleted: !!rows[0].deleted };
  }

  /** Create a client with weighted A/B groups per app, enforcing the room's client cap. */
  async createClient(room: RoomWithApps, limits: RoomLimits): Promise<{ cid: string; groups: Record<string, string> }> {
    const groups: Record<string, string> = {};
    for (const app of room.apps) {
      if (!app.groups) continue;
      const g = pickWeighted(app.groups);
      if (g) groups[app.name] = g;
    }
    const cid = ulid();
    await tx(this.db, async (c) => {
      // Lock the room row so concurrent joins can't overshoot maxClients.
      const [rows] = await c.query<Row[]>('SELECT status FROM rooms WHERE code = ? AND expires_at > UTC_TIMESTAMP(3) FOR UPDATE', [room.code]);
      if (!rows[0]) throw roomNotFound();
      if (rows[0].status !== 'open') throw new ApiError('ROOM_CLOSED', 'Room is not open');
      const [cnt] = await c.query<Row[]>('SELECT COUNT(*) n FROM clients WHERE room = ?', [room.code]);
      if (Number(cnt[0]!.n) >= limits.maxClients) throw new ApiError('CAP_REACHED', 'Room is full');
      await c.query('INSERT INTO clients (room, cid, joined_at, `groups`, deleted) VALUES (?, ?, UTC_TIMESTAMP(3), CAST(? AS JSON), FALSE)', [
        room.code,
        cid,
        JSON.stringify(groups),
      ]);
    });
    return { cid, groups };
  }

  /** Delete-my-data: hard-delete the client's events and mark the cid deleted. */
  async deleteClientData(code: string, cid: string): Promise<number> {
    return tx(this.db, async (c) => {
      await c.query('SELECT code FROM rooms WHERE code = ? FOR UPDATE', [code]);
      const [r] = await c.query<ResultSetHeader>('DELETE FROM events WHERE room = ? AND cid = ?', [code, cid]);
      await c.query('UPDATE clients SET deleted = TRUE, `groups` = JSON_OBJECT() WHERE room = ? AND cid = ?', [code, cid]);
      await c.query('DELETE FROM idempotency WHERE room = ? AND cid = ?', [code, cid]);
      await recount(c, code);
      return r.affectedRows;
    });
  }

  // ---------- events ----------

  async findIdempotent(code: string, cid: string, key: string): Promise<{ id: string; seq: number | null } | null> {
    const [rows] = await this.db.query<Row[]>(
      `SELECT i.event_id, e.seq FROM idempotency i LEFT JOIN events e ON e.id = i.event_id
       WHERE i.room = ? AND i.cid = ? AND i.\`key\` = ? AND i.created_at > UTC_TIMESTAMP(3) - INTERVAL 10 MINUTE`,
      [code, cid, key],
    );
    if (!rows[0]) return null;
    return { id: rows[0].event_id, seq: rows[0].seq === null ? null : Number(rows[0].seq) };
  }

  /**
   * Store events. Requests for the same room are coalesced: while one transaction commits, new requests queue,
   * and the next transaction takes them all (group commit). Each transaction locks the room row
   * (SELECT … FOR UPDATE), checks status and caps per request, allocates contiguous seqs from next_seq,
   * batch-inserts, bumps counters and records idempotency keys. Every request gets its own result or error.
   */
  writeEvents(
    room: RoomWithApps,
    cid: string,
    idemKey: string,
    events: (EventInput & { bytes: number })[],
    limits: RoomLimits,
  ): Promise<WriteResult> {
    return new Promise((resolve, reject) => {
      let q = this.writeQueues.get(room.code);
      if (!q) this.writeQueues.set(room.code, (q = { items: [], running: false }));
      q.items.push({ room, cid, key: idemKey, events, limits, resolve, reject });
      if (!q.running) void this.drainWrites(room.code, q);
    });
  }

  private writeQueues = new Map<string, { items: PendingWrite[]; running: boolean }>();

  private async drainWrites(code: string, q: { items: PendingWrite[]; running: boolean }) {
    q.running = true;
    try {
      while (q.items.length) {
        // Up to 100 requests (≤ 2,000 events) per transaction.
        const batch = q.items.splice(0, 100);
        let outcomes: Outcome[];
        try {
          outcomes = await tx(this.db, (c) => this.writeBatch(c, code, batch));
        } catch (err) {
          for (const item of batch) item.reject(err);
          continue;
        }
        batch.forEach((item, i) => {
          const o = outcomes[i]!;
          if (o.ok) item.resolve(o.result);
          else item.reject(o.error);
        });
      }
    } finally {
      q.running = false;
      if (!q.items.length) this.writeQueues.delete(code);
      else void this.drainWrites(code, q);
    }
  }

  private async writeBatch(c: Conn, code: string, batch: PendingWrite[]): Promise<Outcome[]> {
    await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED').catch(() => {});
    const [rows] = await c.query<Row[]>(
      'SELECT status, next_seq, event_count, bytes_used, closes_at FROM rooms WHERE code = ? AND expires_at > UTC_TIMESTAMP(3) FOR UPDATE',
      [code],
    );
    const r = rows[0];
    if (!r) return batch.map(() => ({ ok: false, error: roomNotFound() }));
    const open = r.status === 'open' && (r.closes_at as Date).getTime() > Date.now();

    const cids = [...new Set(batch.map((b) => b.cid))];
    // Idempotency keys already used (checked under the room lock, so retries of one key serialise).
    const [dups] = await c.query<Row[]>(
      `SELECT i.cid, i.\`key\`, i.event_id, e.seq FROM idempotency i LEFT JOIN events e ON e.id = i.event_id
       WHERE i.room = ? AND (i.cid, i.\`key\`) IN (?) AND i.created_at > UTC_TIMESTAMP(3) - INTERVAL 10 MINUTE`,
      [code, batch.map((b) => [b.cid, b.key])],
    );
    const seen = new Map<string, { id: string; seq: number | null }>();
    for (const d of dups) seen.set(`${d.cid}|${d.key}`, { id: d.event_id, seq: d.seq === null ? null : Number(d.seq) });
    const [clientRows] = await c.query<Row[]>('SELECT cid, `groups`, deleted FROM clients WHERE room = ? AND cid IN (?)', [code, cids]);
    const clients = new Map(clientRows.map((x) => [x.cid as string, { groups: asJson<Record<string, string>>(x.groups, {}), deleted: !!x.deleted }]));
    const [countRows] = await c.query<Row[]>('SELECT cid, app, COUNT(*) n FROM events WHERE room = ? AND cid IN (?) GROUP BY cid, app', [code, cids]);
    const perClientApp = new Map(countRows.map((x) => [`${x.cid}|${x.app}`, Number(x.n)]));

    let eventCount = Number(r.event_count);
    let bytesUsed = Number(r.bytes_used);
    let nextSeq = Number(r.next_seq);
    const now = new Date();
    const inserts: unknown[][] = [];
    const idemRows: unknown[][] = [];
    const outcomes: Outcome[] = [];
    const fail = (error: ApiError) => outcomes.push({ ok: false, error });

    for (const b of batch) {
      const dupKey = `${b.cid}|${b.key}`;
      const dup = seen.get(dupKey);
      if (dup) {
        outcomes.push({ ok: true, result: { ids: [dup.id], seqs: dup.seq === null ? [] : [dup.seq], duplicate: true, live: [] } });
        continue;
      }
      if (!open) {
        fail(new ApiError('ROOM_CLOSED', 'Room is closed'));
        continue;
      }
      const client = clients.get(b.cid);
      if (!client) {
        fail(new ApiError('TOKEN_INVALID', 'Unknown client'));
        continue;
      }
      if (client.deleted) {
        fail(new ApiError('CLIENT_DELETED', 'This client deleted its data'));
        continue;
      }
      // Per client per app, then per room.
      const perApp = new Map<string, number>();
      for (const e of b.events) perApp.set(e.app, (perApp.get(e.app) ?? 0) + 1);
      let capError: ApiError | null = null;
      for (const [app, n] of perApp) {
        const def = b.room.apps.find((a) => a.name === app)!;
        if ((perClientApp.get(`${b.cid}|${app}`) ?? 0) + n > def.maxEventsPerClient) capError = new ApiError('CAP_REACHED', `Event limit reached for app ${app}`);
      }
      const bytes = b.events.reduce((s, e) => s + e.bytes, 0);
      if (!capError && eventCount + b.events.length > b.limits.maxEvents) capError = new ApiError('CAP_REACHED', 'Room event limit reached');
      if (!capError && bytesUsed + bytes > b.limits.maxBytes) capError = new ApiError('CAP_REACHED', 'Room storage limit reached');
      if (capError) {
        fail(capError);
        continue;
      }

      for (const [app, n] of perApp) perClientApp.set(`${b.cid}|${app}`, (perClientApp.get(`${b.cid}|${app}`) ?? 0) + n);
      eventCount += b.events.length;
      bytesUsed += bytes;
      const ids = b.events.map(() => ulid());
      const seqs = b.events.map(() => nextSeq++);
      b.events.forEach((e, i) => {
        inserts.push([ids[i], code, seqs[i], e.app, b.cid, now, e.clientT ?? null, e.appVersion ?? null, JSON.stringify(e.data)]);
      });
      idemRows.push([code, b.cid, b.key, ids[0], now]);
      seen.set(dupKey, { id: ids[0]!, seq: seqs[0]! });
      const live: LiveEvent[] = b.events.map((e, i) => ({
        id: ids[i]!,
        seq: seqs[i]!,
        app: e.app,
        cid: b.cid,
        group: client.groups[e.app] ?? null,
        t: now.toISOString(),
        clientT: e.clientT ?? null,
        appVersion: e.appVersion ?? null,
        data: e.data,
      }));
      outcomes.push({ ok: true, result: { ids, seqs, duplicate: false, live } });
    }

    if (inserts.length) {
      await c.query(
        `INSERT INTO events (id, room, seq, app, cid, t, client_t, app_version, data) VALUES ${inserts
          .map(() => '(?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))')
          .join(', ')}`,
        inserts.flat(),
      );
      await c.query('UPDATE rooms SET next_seq = ?, event_count = ?, bytes_used = ? WHERE code = ?', [nextSeq, eventCount, bytesUsed, code]);
      await c.query('INSERT INTO idempotency (room, cid, `key`, event_id, created_at) VALUES ?', [idemRows]);
    }
    return outcomes;
  }

  async listEvents(code: string, opts: { app?: string; since?: number; limit: number; cid?: string }): Promise<LiveEvent[]> {
    const where = ['e.room = ?', 'e.seq > ?'];
    const vals: unknown[] = [code, opts.since ?? 0];
    if (opts.app) {
        where.push('e.app = ?');
        vals.push(opts.app);
      }
    if (opts.cid) {
        where.push('e.cid = ?');
        vals.push(opts.cid);
      }
    const [rows] = await this.db.query<Row[]>(
      `SELECT e.id, e.seq, e.app, e.cid, e.t, e.client_t, e.app_version, e.data, c.groups
       FROM events e LEFT JOIN clients c ON c.room = e.room AND c.cid = e.cid
       WHERE ${where.join(' AND ')} ORDER BY e.seq ASC LIMIT ?`,
      [...vals, opts.limit],
    );
    return rows.map(rowToEvent);
  }

  async summary(code: string, app?: string) {
    const vals: unknown[] = [code];
    let filter = '';
    if (app) {
      filter = ' AND e.app = ?';
      vals.push(app);
    }
    const [rows] = await this.db.query<Row[]>(
      `SELECT e.app, JSON_UNQUOTE(JSON_EXTRACT(c.groups, CONCAT('$."', e.app, '"'))) AS grp,
              COUNT(*) AS events, COUNT(DISTINCT e.cid) AS clients, MAX(e.seq) AS last_seq
       FROM events e LEFT JOIN clients c ON c.room = e.room AND c.cid = e.cid
       WHERE e.room = ?${filter} GROUP BY e.app, grp ORDER BY e.app, grp`,
      vals,
    );
    const [uniq] = await this.db.query<Row[]>(`SELECT COUNT(DISTINCT e.cid) n FROM events e WHERE e.room = ?${filter}`, vals);
    const apps: Record<string, { events: number; clients: number; groups: Record<string, { events: number; clients: number }> }> = {};
    for (const r of rows) {
      const a = (apps[r.app] ??= { events: 0, clients: 0, groups: {} });
      a.events += Number(r.events);
      a.groups[r.grp ?? '_none'] = { events: Number(r.events), clients: Number(r.clients) };
    }
    // Unique clients per app (a client is in exactly one group per app, so summing groups is exact).
    for (const a of Object.values(apps)) a.clients = Object.values(a.groups).reduce((s, g) => s + g.clients, 0);
    return { apps, uniqueClients: Number(uniq[0]!.n) };
  }

  /** Top-level keys present in an app's data, for flattened CSV columns. */
  async dataKeys(code: string, app: string): Promise<string[]> {
    const [rows] = await this.db.query<Row[]>(
      `SELECT DISTINCT jk.k FROM events e,
         JSON_TABLE(IF(JSON_TYPE(e.data) = 'OBJECT', JSON_KEYS(e.data), JSON_ARRAY()), '$[*]' COLUMNS (k VARCHAR(64) PATH '$')) jk
       WHERE e.room = ? AND e.app = ? ORDER BY jk.k LIMIT 200`,
      [code, app],
    );
    return rows.map((r) => r.k as string);
  }

  // ---------- tickets ----------

  async createTicket(ticket: string, code: string, ttlMs = 30_000) {
    await this.db.query('INSERT INTO ws_tickets (ticket, room, expires_at) VALUES (?, ?, ?)', [ticket, code, new Date(Date.now() + ttlMs)]);
  }

  /** Single use: the DELETE only succeeds once, and only before expiry. */
  async consumeTicket(ticket: string, code: string): Promise<boolean> {
    const [r] = await this.db.query<ResultSetHeader>('DELETE FROM ws_tickets WHERE ticket = ? AND room = ? AND expires_at > UTC_TIMESTAMP(3)', [
      ticket,
      code,
    ]);
    return r.affectedRows === 1;
  }

  async ping() {
    await this.db.query('SELECT 1');
  }
}

export function rowToEvent(r: Row): LiveEvent {
  const groups = asJson<Record<string, string>>(r.groups, {});
  return {
    id: r.id,
    seq: Number(r.seq),
    app: r.app,
    cid: r.cid,
    group: groups[r.app] ?? null,
    t: (r.t as Date).toISOString(),
    clientT: r.client_t === null ? null : Number(r.client_t),
    appVersion: r.app_version ?? null,
    data: asJson(r.data, null),
  };
}

function checkTimes(now: Date, closesAt: Date, expiresAt: Date, allowPastClose = false) {
  if (expiresAt.getTime() > now.getTime() + MAX_LIFETIME_MS + 60_000) throw new ApiError('INVALID_PAYLOAD', 'expiresAt must be at most 30 days away');
  if (expiresAt.getTime() <= now.getTime()) throw new ApiError('INVALID_PAYLOAD', 'expiresAt must be in the future');
  if (!allowPastClose && closesAt.getTime() <= now.getTime()) throw new ApiError('INVALID_PAYLOAD', 'closesAt must be in the future');
  if (closesAt.getTime() > expiresAt.getTime()) throw new ApiError('INVALID_PAYLOAD', 'closesAt must be before expiresAt');
}

async function recount(c: Conn, code: string) {
  await c.query(
    `UPDATE rooms r SET
       event_count = (SELECT COUNT(*) FROM events e WHERE e.room = r.code),
       bytes_used = (SELECT COALESCE(SUM(LENGTH(CAST(e.data AS CHAR))), 0) FROM events e WHERE e.room = r.code)
     WHERE r.code = ?`,
    [code],
  );
}

async function replaceApps(c: Conn, code: string, apps: AppDef[], isNew = false) {
  const names = apps.map((a) => a.name);
  if (isNew) {
    /* nothing to delete */
  } else if (names.length) await c.query('DELETE FROM apps WHERE room = ? AND name NOT IN (?)', [code, names]);
  else await c.query('DELETE FROM apps WHERE room = ?', [code]);
  for (const a of apps) {
    await c.query(
      `INSERT INTO apps (room, name, enabled, max_events_per_client, allow_free_text, \`groups\`, config, \`schema\`)
       VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON))
       ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), max_events_per_client = VALUES(max_events_per_client),
         allow_free_text = VALUES(allow_free_text), \`groups\` = VALUES(\`groups\`), config = VALUES(config), \`schema\` = VALUES(\`schema\`)`,
      [
        code,
        a.name,
        a.enabled,
        a.maxEventsPerClient,
        a.allowFreeText,
        a.groups ? JSON.stringify(a.groups) : null,
        JSON.stringify(a.config),
        a.schema === null || a.schema === undefined ? null : JSON.stringify(a.schema),
      ],
    );
  }
}

async function replaceOwners(c: Conn, code: string, owners: string[], primary: string, isNew = false) {
  if (!isNew) await c.query('DELETE FROM room_owners WHERE room = ?', [code]);
  const uniq = [...new Set(owners.filter((o) => o && o !== primary))];
  for (const o of uniq) await c.query('INSERT INTO room_owners (room, staff_id) VALUES (?, ?)', [code, o]);
}
