import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRoom, join, send, setupApp, rawConn, type TestApp } from '../helpers.js';
import { issueJoinToken } from '../../src/tokens.js';
import { MemoryRateLimitStore } from '../../src/ratelimit.js';

let t: TestApp;
beforeAll(async () => {
  // TRUST_PROXY_CIDRS lets tests simulate distinct client IPs via X-Forwarded-For (inject comes from 127.0.0.1).
  t = await setupApp({ env: { TRUST_PROXY_CIDRS: '127.0.0.1/32' } });
});
afterAll(async () => t?.close());

let ipN = 1;
const freshIp = () => ({ 'x-forwarded-for': `10.9.${Math.floor(ipN / 250)}.${ipN++ % 250}` });
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const raw = (code: string, token: string, body: string, headers: Record<string, string> = {}) =>
  t.app.inject({
    method: 'POST',
    url: `/api/v1/rooms/${code}/events`,
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': `raw-${Math.random()}`, 'content-type': 'application/json', ...freshIp(), ...headers },
    payload: body,
  });

describe('payload abuse', () => {
  let code: string;
  let token: string;
  beforeAll(async () => {
    ({ code } = await createRoom(t, { apps: [{ name: 'quiz', maxEventsPerClient: 10_000 }], limits: { clientWriteBurst: 200, clientWritesPerSecond: 20 } }));
    ({ token } = await join(t, code, freshIp()));
  });

  it('rejects oversized bodies (2 KB single, 8 KB batch, route limit)', async () => {
    const big = JSON.stringify({ app: 'quiz', data: { s: 'x'.repeat(2100) } });
    expect((await raw(code, token, big)).statusCode).toBe(413);
    const huge = JSON.stringify({ events: [{ app: 'quiz', data: { s: 'x'.repeat(9000) } }] });
    const r = await raw(code, token, huge);
    expect(r.statusCode).toBe(413);
    expect(r.json().error.code).toBe('INVALID_PAYLOAD');
    expect((await raw(code, token, 'x'.repeat(100_000))).statusCode).toBe(413);
  });
  it('rejects non-JSON content types and malformed JSON', async () => {
    expect((await raw(code, token, 'app=quiz', { 'content-type': 'application/x-www-form-urlencoded' })).statusCode).toBe(415);
    expect((await raw(code, token, '{"app":"quiz"', {})).json().error.code).toBe('INVALID_PAYLOAD');
    expect((await raw(code, token, '{"app":"quiz","data":1}', { 'content-type': 'text/plain' })).statusCode).toBe(415);
  });
  it('rejects deep nesting', async () => {
    let d: unknown = 1;
    for (let i = 0; i < 200; i++) d = { a: d };
    expect((await raw(code, token, JSON.stringify({ events: [{ app: 'quiz', data: { a: { b: { c: { d: { e: 1 } } } } } }] }))).json().error.code).toBe('INVALID_PAYLOAD');
    expect((await raw(code, token, JSON.stringify({ app: 'quiz', data: d }))).statusCode).toBeGreaterThanOrEqual(400);
  });
  it('rejects __proto__ / constructor pollution attempts', async () => {
    for (const body of [
      '{"app":"quiz","data":{"__proto__":{"isAdmin":true}}}',
      '{"app":"quiz","data":{"constructor":{"prototype":{"x":1}}}}',
      '{"__proto__":{"x":1},"app":"quiz","data":1}',
    ]) {
      const r = await raw(code, token, body);
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe('INVALID_PAYLOAD');
    }
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });
  it('rejects client-supplied cid/t', async () => {
    expect((await raw(code, token, JSON.stringify({ app: 'quiz', data: 1, cid: 'X', t: 0 }))).json().error.code).toBe('INVALID_PAYLOAD');
  });
  it('stores SQL injection attempts as inert data and never echoes payloads', async () => {
    const evil = "x'); DROP TABLE events; --";
    const r = await raw(code, token, JSON.stringify({ app: 'quiz', data: { s: evil } }));
    expect(r.statusCode).toBe(202);
    expect(r.body).not.toContain('DROP');
    const inj = await t.app.inject({ url: `/api/v1/rooms/${code}/events?app=quiz'%20OR%201=1--`, headers: auth(t.staffToken) });
    expect(inj.statusCode).toBe(400);
    const since = await t.app.inject({ url: `/api/v1/rooms/${code}/events?since=0%20OR%201=1`, headers: auth(t.staffToken) });
    expect(since.statusCode).toBe(400);
    const c = await rawConn();
    const [rows] = await c.query("SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'events'");
    await c.end();
    expect((rows as { n: number }[])[0]!.n).toBe(1);
    const back = await t.app.inject({ url: `/api/v1/rooms/${code}/events?app=quiz`, headers: auth(t.staffToken) });
    expect(back.json().events.some((e: { data: { s?: string } }) => e.data.s === evil)).toBe(true);
  });
  it('room codes in URLs are validated before any query', async () => {
    for (const bad of ["ABC'--", '%27%20OR%201%3D1', '../../etc']) {
      const r = await t.app.inject({ url: `/api/v1/rooms/${bad}/config`, headers: freshIp() });
      expect(r.statusCode).toBe(404);
    }
  });
  it('XSS payloads are stored verbatim as JSON (rendered as text by the dashboard)', async () => {
    const xss = '<img src=x onerror=alert(1)>';
    const r = await raw(code, token, JSON.stringify({ app: 'quiz', data: { s: xss } }));
    expect(r.statusCode).toBe(202);
    const back = await t.app.inject({ url: `/api/v1/rooms/${code}/events?app=quiz`, headers: auth(t.staffToken) });
    expect(back.headers['content-type']).toContain('application/json');
    expect(back.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('token abuse', () => {
  it('rejects forged, expired, cross-room and malformed join tokens', async () => {
    const { code } = await createRoom(t);
    const other = await createRoom(t);
    const j = await join(t, code, freshIp());
    const otherJ = await join(t, other.code, freshIp());
    const forgedSecret = issueJoinToken({ secret: 'z'.repeat(40), kid: 'k1' }, code, j.cid, new Date(Date.now() + 3600_000)).token;
    const expired = issueJoinToken(t.ctx.cfg.token, code, j.cid, new Date(Date.now() + 3600_000), Date.now() - 13 * 3600_000).token;
    for (const tok of [forgedSecret, expired, otherJ.token, 'garbage', j.token + 'x', '']) {
      const r = await send(t, code, tok, { app: 'quiz', data: 1 }, { headers: freshIp() });
      expect(r.statusCode).toBe(401);
      expect(r.json().error.code).toBe('TOKEN_INVALID');
    }
  });
  it('rejects staff tokens on client routes and join tokens on staff routes', async () => {
    const { code } = await createRoom(t);
    const j = await join(t, code, freshIp());
    expect((await send(t, code, t.staffToken, { app: 'quiz', data: 1 }, { headers: freshIp() })).statusCode).toBe(401);
    expect((await t.app.inject({ url: '/api/v1/admin/rooms', headers: auth(j.token) })).statusCode).toBe(401);
    expect((await t.app.inject({ url: `/api/v1/rooms/${code}/events`, headers: auth(j.token) })).statusCode).toBe(401);
  });
});

describe('floods', () => {
  it('a flood from one token is limited per cid with Retry-After', async () => {
    const { code } = await createRoom(t, { apps: [{ name: 'quiz', maxEventsPerClient: 1000 }] });
    const j = await join(t, code, freshIp());
    const ip = freshIp();
    const res = [];
    for (let i = 0; i < 30; i++) res.push(await send(t, code, j.token, { app: 'quiz', data: i }, { headers: ip }));
    const ok = res.filter((r) => r.statusCode === 202).length;
    const limited = res.filter((r) => r.statusCode === 429);
    expect(ok).toBeGreaterThanOrEqual(20);
    expect(ok).toBeLessThanOrEqual(22);
    expect(limited.length).toBeGreaterThan(0);
    expect(limited[0]!.headers['retry-after']).toBeDefined();
    expect(limited[0]!.json().error).toMatchObject({ code: 'RATE_LIMITED', retryAfter: expect.any(Number) });
  });
  it('a join flood from one IP is limited', async () => {
    const { code } = await createRoom(t);
    const ip = freshIp();
    const res = await Promise.all(Array.from({ length: 130 }, () => t.app.inject({ method: 'POST', url: `/api/v1/rooms/${code}/join`, payload: {}, headers: ip })));
    const limited = res.filter((r) => r.statusCode === 429).length;
    expect(limited).toBeGreaterThan(0);
    expect(res.filter((r) => r.statusCode === 201).length).toBeLessThanOrEqual(102);
  });
  it('per-room join cap (600/hour) applies across IPs', async () => {
    const { code } = await createRoom(t, { limits: { joinsPerHour: 5 } });
    const res = [];
    for (let i = 0; i < 8; i++) res.push(await t.app.inject({ method: 'POST', url: `/api/v1/rooms/${code}/join`, payload: {}, headers: freshIp() }));
    expect(res.filter((r) => r.statusCode === 201)).toHaveLength(5);
    expect(res.at(-1)!.statusCode).toBe(429);
  });
  it('room code brute forcing is blocked after 10 misses for 10 minutes', async () => {
    const ip = freshIp();
    const { code } = await createRoom(t);
    const codes = ['AAAAAA', 'BBBBBB', 'CCCCCC', 'DDDDDD', 'EEEEEE', 'FFFFFF', 'GGGGGG', 'HHHHHH', 'JJJJJJ', 'KKKKKK', 'MMMMMM', 'NNNNNN'];
    const res = [];
    for (const c of codes) res.push(await t.app.inject({ url: `/api/v1/rooms/${c}/config`, headers: ip }));
    expect(res.slice(0, 10).every((r) => r.statusCode === 404)).toBe(true);
    // the 11th miss trips the block; after that even valid codes are refused for this IP
    const valid = await t.app.inject({ url: `/api/v1/rooms/${code}/config`, headers: ip });
    expect(valid.statusCode).toBe(429);
    expect(Number(valid.headers['retry-after'])).toBeGreaterThan(500);
    // other IPs are unaffected
    expect((await t.app.inject({ url: `/api/v1/rooms/${code}/config`, headers: freshIp() })).statusCode).toBe(200);
  });
  it('per-IP request limit (50/s, burst 300)', async () => {
    const ip = freshIp();
    const res = await Promise.all(Array.from({ length: 320 }, () => t.app.inject({ url: '/api/v1/rooms/ZZZZZZ/me', headers: ip })));
    expect(res.filter((r) => r.statusCode === 429).length).toBeGreaterThanOrEqual(15);
  });
  it('global ceiling returns 503 when memory is over the cap', async () => {
    const t2 = await setupApp({ memoryUsageMb: () => 10_000, limiter: new MemoryRateLimitStore() });
    try {
      const { code } = await createRoom(t2);
      const r = await t2.app.inject({ method: 'POST', url: `/api/v1/rooms/${code}/join`, payload: {} });
      expect(r.statusCode).toBe(503);
      expect(r.headers['retry-after']).toBeDefined();
    } finally {
      await t2.close();
    }
  });
});

describe('CORS', () => {
  it('client routes allow client origins; admin routes only the admin origin', async () => {
    const pre = (url: string, origin: string, method = 'POST') =>
      t.app.inject({ method: 'OPTIONS', url, headers: { origin, 'access-control-request-method': method, ...freshIp() } });
    expect((await pre('/api/v1/rooms/ABCDEF/join', 'https://apps.example')).headers['access-control-allow-origin']).toBe('https://apps.example');
    expect((await pre('/api/v1/rooms/ABCDEF/join', 'https://evil.example')).headers['access-control-allow-origin']).toBeUndefined();
    expect((await pre('/api/v1/admin/rooms', 'https://apps.example')).headers['access-control-allow-origin']).toBeUndefined();
    expect((await pre('/api/v1/admin/rooms', 'https://admin.example')).headers['access-control-allow-origin']).toBe('https://admin.example');
    expect((await pre('/api/v1/rooms/ABCDEF/events', 'https://apps.example', 'GET')).headers['access-control-allow-origin']).toBeUndefined();
    expect((await pre('/api/v1/rooms/ABCDEF/events', 'https://apps.example', 'POST')).headers['access-control-allow-origin']).toBe('https://apps.example');
  });
});
