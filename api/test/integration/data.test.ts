import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createRoom, join, send, setupApp, rawConn, unlimited, type TestApp } from '../helpers.js';
import { runCleanup } from '../../src/cleanup.js';

let t: TestApp;
let base: string;
beforeAll(async () => {
  t = await setupApp({ limiter: unlimited });
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = t.app.server.address() as { port: number };
  base = `127.0.0.1:${addr.port}`;
});
afterAll(async () => t?.close());

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const count = async (sql: string, args: unknown[]) => {
  const c = await rawConn();
  const [r] = await c.query(sql, args);
  await c.end();
  return Number((r as { n: number }[])[0]!.n);
};

describe('idempotency', () => {
  it('deduplicates the same key and returns the original id/seq', async () => {
    const { code } = await createRoom(t);
    const a = await join(t, code);
    const r1 = await send(t, code, a.token, { app: 'quiz', data: 1 }, { key: 'same-key-1' });
    const r2 = await send(t, code, a.token, { app: 'quiz', data: 1 }, { key: 'same-key-1' });
    expect(r2.statusCode).toBe(202);
    expect(r2.json()).toMatchObject({ id: r1.json().id, seq: r1.json().seq, duplicate: true });
    expect(await count('SELECT COUNT(*) n FROM events WHERE room = ?', [code])).toBe(1);
  });
  it('deduplicates concurrent retries of the same key', async () => {
    const { code } = await createRoom(t);
    const a = await join(t, code);
    const rs = await Promise.all(Array.from({ length: 8 }, () => send(t, code, a.token, { app: 'quiz', data: 1 }, { key: 'race-key' })));
    expect(new Set(rs.map((r) => r.json().id)).size).toBe(1);
    expect(await count('SELECT COUNT(*) n FROM events WHERE room = ?', [code])).toBe(1);
  });
  it('keys are scoped per client', async () => {
    const { code } = await createRoom(t);
    const a = await join(t, code);
    const b = await join(t, code);
    await send(t, code, a.token, { app: 'quiz', data: 1 }, { key: 'k' });
    const rb = await send(t, code, b.token, { app: 'quiz', data: 1 }, { key: 'k' });
    expect(rb.json().duplicate).toBeUndefined();
  });
  it('requires the header', async () => {
    const { code } = await createRoom(t);
    const a = await join(t, code);
    const r = await t.app.inject({ method: 'POST', url: `/api/v1/rooms/${code}/events`, headers: auth(a.token), payload: { app: 'quiz', data: 1 } });
    expect(r.json().error.code).toBe('INVALID_PAYLOAD');
  });
});

describe('sequence numbers', () => {
  it('are unique and gap-free under concurrent writes from many clients', async () => {
    const { code } = await createRoom(t, { apps: [{ name: 'quiz', maxEventsPerClient: 1000 }] });
    const clients = await Promise.all(Array.from({ length: 30 }, () => join(t, code)));
    const writes = clients.flatMap((c) =>
      Array.from({ length: 5 }, (_, i) => (i % 2 ? send(t, code, c.token, { events: [{ app: 'quiz', data: i }, { app: 'quiz', data: i }] }) : send(t, code, c.token, { app: 'quiz', data: i }))),
    );
    const res = await Promise.all(writes);
    expect(res.every((r) => r.statusCode === 202)).toBe(true);
    const c = await rawConn();
    const [rows] = await c.query('SELECT seq FROM events WHERE room = ? ORDER BY seq', [code]);
    const [room] = await c.query('SELECT next_seq, event_count FROM rooms WHERE code = ?', [code]);
    await c.end();
    const seqs = (rows as { seq: number }[]).map((r) => Number(r.seq));
    const expected = 30 * (3 * 1 + 2 * 2);
    expect(seqs).toEqual(Array.from({ length: expected }, (_, i) => i + 1));
    expect(room).toMatchObject([{ next_seq: expected + 1, event_count: expected }]);
  });
});

describe('clean-up job', () => {
  it('closes rooms past closes_at, deletes expired rooms with cascade, retires codes', async () => {
    const { code: closing } = await createRoom(t);
    const { code: expiring } = await createRoom(t);
    const a = await join(t, expiring);
    await send(t, expiring, a.token, { app: 'quiz', data: 1 }, { key: 'cleanup-k' });
    const c = await rawConn();
    await c.query('UPDATE rooms SET closes_at = UTC_TIMESTAMP(3) - INTERVAL 1 MINUTE WHERE code = ?', [closing]);
    await c.query("UPDATE rooms SET status='closed', closes_at = UTC_TIMESTAMP(3) - INTERVAL 2 DAY, expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 MINUTE WHERE code = ?", [expiring]);
    await c.query("INSERT INTO idempotency (room,cid,`key`,event_id,created_at) VALUES ('ZZZZZZ','01HZX3J8Q4M6N7P8R9S0T1V2W3','old','01HZX3J8Q4M6N7P8R9S0T1V2W3', UTC_TIMESTAMP(3) - INTERVAL 11 MINUTE)");
    await c.query("INSERT INTO ws_tickets (ticket, room, expires_at) VALUES (?, 'ZZZZZZ', UTC_TIMESTAMP(3) - INTERVAL 1 SECOND)", ['x'.repeat(43)]);
    await c.end();
    t.ctx.store.cache.clear();

    const res = await runCleanup(t.db, t.ctx.store, t.ctx.live);
    expect(res.ran).toBe(true);
    expect(res.closed).toBeGreaterThanOrEqual(1);
    expect(res.deleted).toBeGreaterThanOrEqual(1);
    expect(res.idempotency).toBeGreaterThanOrEqual(1);
    expect(res.tickets).toBeGreaterThanOrEqual(1);

    expect((await t.app.inject({ url: `/api/v1/rooms/${closing}/config` })).json().status).toBe('closed');
    expect((await t.app.inject({ url: `/api/v1/rooms/${expiring}/config` })).statusCode).toBe(404);
    for (const table of ['apps', 'clients', 'events', 'idempotency']) {
      expect(await count(`SELECT COUNT(*) n FROM ${table} WHERE room = ?`, [expiring])).toBe(0);
    }
    expect(await count('SELECT COUNT(*) n FROM retired_codes WHERE code = ?', [expiring])).toBe(1);
  });

  it('treats expired-but-not-yet-cleaned rooms as not found', async () => {
    const { code } = await createRoom(t);
    const c = await rawConn();
    await c.query('UPDATE rooms SET closes_at = UTC_TIMESTAMP(3) - INTERVAL 2 MINUTE, expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 MINUTE WHERE code = ?', [code]);
    await c.end();
    t.ctx.store.cache.clear();
    const r = await t.app.inject({ url: `/api/v1/rooms/${code}/config` });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } });
  });

  it('only one clean-up runs at a time (GET_LOCK)', async () => {
    const c = await rawConn();
    await c.query("SELECT GET_LOCK('roomsink_cleanup', 0)");
    const res = await runCleanup(t.db, t.ctx.store);
    expect(res.ran).toBe(false);
    await c.query("SELECT RELEASE_LOCK('roomsink_cleanup')");
    await c.end();
  });

  it('cascades when a room is deleted by staff', async () => {
    const { code } = await createRoom(t);
    const a = await join(t, code);
    await send(t, code, a.token, { app: 'quiz', data: 1 });
    await t.app.inject({ method: 'DELETE', url: `/api/v1/admin/rooms/${code}`, headers: auth(t.staffToken) });
    for (const table of ['apps', 'clients', 'events', 'room_owners']) expect(await count(`SELECT COUNT(*) n FROM ${table} WHERE room = ?`, [code])).toBe(0);
  });
});

describe('live WebSocket', () => {
  const ticket = async (code: string, headers: Record<string, string>) =>
    (await t.app.inject({ method: 'POST', url: `/api/v1/rooms/${code}/live-ticket`, headers })).json().ticket as string;

  const connect = (code: string, tk: string, qs = '') =>
    new Promise<{ ws: WebSocket; msgs: Record<string, unknown>[] }>((resolve, reject) => {
      const ws = new WebSocket(`ws://${base}/api/v1/rooms/${code}/live?ticket=${tk}${qs}`);
      const msgs: Record<string, unknown>[] = [];
      ws.on('message', (m) => msgs.push(JSON.parse(String(m))));
      ws.on('open', () => resolve({ ws, msgs }));
      ws.on('error', reject);
      ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
  const waitFor = async (fn: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > end) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('streams batched events within 1 s, plus room and deleted messages', async () => {
    const { code, presenterKey } = await createRoom(t);
    const a = await join(t, code);
    await send(t, code, a.token, { app: 'quiz', data: { n: 0 } });
    const { ws, msgs } = await connect(code, await ticket(code, { 'x-presenter-key': presenterKey }), '&since=0');
    await waitFor(() => msgs.some((m) => m.type === 'events' && m.backlog));
    expect(msgs[0]!.type).toBe('room');

    const started = Date.now();
    await send(t, code, a.token, { app: 'quiz', data: { n: 1 } });
    await send(t, code, a.token, { app: 'free', data: { n: 2 } });
    await waitFor(() => msgs.filter((m) => m.type === 'events' && !m.backlog).flatMap((m) => m.events as unknown[]).length >= 2);
    expect(Date.now() - started).toBeLessThan(1000);

    await waitFor(() => msgs.some((m) => m.type === 'room' && (m.room as { eventCount: number }).eventCount === 3), 3000);

    await t.app.inject({ method: 'DELETE', url: `/api/v1/rooms/${code}/me`, headers: auth(a.token) });
    await waitFor(() => msgs.some((m) => m.type === 'deleted' && m.cid === a.cid));
    ws.close();
  });

  it('filters by app', async () => {
    const { code } = await createRoom(t);
    const a = await join(t, code);
    const { ws, msgs } = await connect(code, await ticket(code, auth(t.staffToken)), '&app=free');
    await send(t, code, a.token, { app: 'quiz', data: 1 });
    await send(t, code, a.token, { app: 'free', data: 2 });
    await waitFor(() => msgs.some((m) => m.type === 'events'));
    const apps = msgs.filter((m) => m.type === 'events').flatMap((m) => (m.events as { app: string }[]).map((e) => e.app));
    expect(apps).toEqual(['free']);
    ws.close();
  });

  it('tickets are single use and required', async () => {
    const { code } = await createRoom(t);
    const tk = await ticket(code, auth(t.staffToken));
    const first = await connect(code, tk);
    first.ws.close();
    await expect(connect(code, tk)).rejects.toThrow('HTTP 401');
    await expect(connect(code, 'A'.repeat(43))).rejects.toThrow('HTTP 401');
    const other = await createRoom(t);
    await expect(connect(other.code, await ticket(code, auth(t.staffToken)))).rejects.toThrow('HTTP 401');
    expect((await t.app.inject({ method: 'POST', url: `/api/v1/rooms/${code}/live-ticket` })).statusCode).toBe(401);
  });
});
