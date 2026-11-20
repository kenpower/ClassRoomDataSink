import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { randomRoomCode } from '../../src/codes.js';
import { createRoom, join, send, setupApp, rawConn, STARS_SECRET, type TestApp } from '../helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await setupApp();
});
afterAll(async () => t?.close());

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe('staff sign-in via STARS', () => {
  it('login redirects to STARS with the callback and providers', async () => {
    const r = await t.app.inject({ url: '/api/v1/auth/login?return=/admin/rooms' });
    expect(r.statusCode).toBe(302);
    const u = new URL(r.headers.location as string);
    expect(u.origin + u.pathname).toBe('https://compucore2.setu.ie/auth/sign_in');
    expect(u.searchParams.get('redirect')).toBe('https://roomsink.example/api/v1/auth/callback');
    expect(u.searchParams.get('auth_provider')).toBe('microsoft,google');
    expect(u.searchParams.get('origin_url')).toBe('/admin/rooms');
  });
  it('callback verifies the token, then a one-time code becomes a session', async () => {
    const token = await new SignJWT({ user_id: 'T@setu.ie', email: 'T@setu.ie', display_name: 'Teacher' })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode(STARS_SECRET));
    const r = await t.app.inject({ url: `/api/v1/auth/callback?token=${token}&origin_url=/admin/` });
    expect(r.statusCode).toBe(302);
    const loc = new URL(r.headers.location as string);
    expect(loc.href.startsWith('https://admin.example/admin/auth#')).toBe(true);
    const code = new URLSearchParams(loc.hash.slice(1)).get('code');
    const s = await t.app.inject({ method: 'POST', url: '/api/v1/auth/session', payload: { code } });
    expect(s.statusCode).toBe(200);
    expect(s.json().user).toMatchObject({ id: 't@setu.ie', isAdmin: false });
    const again = await t.app.inject({ method: 'POST', url: '/api/v1/auth/session', payload: { code } });
    expect(again.statusCode).toBe(401);
    const me = await t.app.inject({ url: '/api/v1/auth/me', headers: auth(s.json().token) });
    expect(me.json().id).toBe('t@setu.ie');
  });
  it('callback rejects non-staff and bad tokens without leaking details', async () => {
    const outsider = await new SignJWT({ email: 'someone@gmail.com' }).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(STARS_SECRET));
    const r = await t.app.inject({ url: `/api/v1/auth/callback?token=${outsider}` });
    expect(r.headers.location).toContain('#error=not_staff');
    const bad = await t.app.inject({ url: '/api/v1/auth/callback?token=abc.def.ghi' });
    expect(bad.headers.location).toContain('#error=sign_in_failed');
  });
  it('ignores off-site return targets', async () => {
    const r = await t.app.inject({ url: '/api/v1/auth/login?return=https://evil.example/' });
    expect(new URL(r.headers.location as string).searchParams.get('origin_url')).toBe('/admin/');
  });
});

describe('rooms lifecycle', () => {
  it('requires staff auth for admin routes', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/admin/rooms' })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/admin/rooms', headers: auth('nope') })).statusCode).toBe(401);
  });

  it('creates, lists, patches, opens, closes, clones and deletes', async () => {
    const { code, presenterKey, room } = await createRoom(t, { open: false });
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    expect(presenterKey).toHaveLength(43);
    expect(room.status).toBe('draft');

    // draft rooms are visible but not joinable
    const cfg = await t.app.inject({ url: `/api/v1/rooms/${code}/config` });
    expect(cfg.json()).toMatchObject({ code, status: 'draft', apps: [{ name: 'free' }, { name: 'quiz' }] });
    expect((await t.app.inject({ method: 'POST', url: `/api/v1/rooms/${code}/join`, payload: {} })).json().error.code).toBe('ROOM_CLOSED');

    const list = await t.app.inject({ url: '/api/v1/admin/rooms', headers: auth(t.staffToken) });
    expect(list.json().rooms.some((r: { code: string }) => r.code === code)).toBe(true);

    const other = await t.session('other@setu.ie');
    expect((await t.app.inject({ url: `/api/v1/admin/rooms/${code}`, headers: auth(other) })).statusCode).toBe(403);
    const adminTok = await t.session('admin@gmail.com', true);
    expect((await t.app.inject({ url: `/api/v1/admin/rooms/${code}`, headers: auth(adminTok) })).statusCode).toBe(200);
    expect((await t.app.inject({ url: '/api/v1/admin/rooms?all=1', headers: auth(other) })).statusCode).toBe(403);

    const patch = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/rooms/${code}`,
      headers: auth(t.staffToken),
      payload: { title: 'Renamed', publicConfig: { theme: 'dark' }, owners: ['other@setu.ie'], apps: [{ name: 'quiz', enabled: false }] },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ title: 'Renamed', owners: ['other@setu.ie'], apps: [{ name: 'quiz', enabled: false }] });
    // co-owner now has access
    expect((await t.app.inject({ url: `/api/v1/admin/rooms/${code}`, headers: auth(other) })).statusCode).toBe(200);

    const open = await t.app.inject({ method: 'POST', url: `/api/v1/admin/rooms/${code}/open`, headers: auth(t.staffToken) });
    expect(open.json().status).toBe('open');
    const closesIn = new Date(open.json().closesAt).getTime() - Date.now();
    expect(closesIn).toBeGreaterThan(179 * 60_000);
    expect(closesIn).toBeLessThan(181 * 60_000);

    const close = await t.app.inject({ method: 'POST', url: `/api/v1/admin/rooms/${code}/close`, headers: auth(t.staffToken) });
    expect(close.json().status).toBe('closed');
    const expiresIn = new Date(close.json().expiresAt).getTime() - Date.now();
    expect(Math.round(expiresIn / 3600_000)).toBe(24);

    const clone = await t.app.inject({ method: 'POST', url: `/api/v1/admin/rooms/${code}/clone`, headers: auth(t.staffToken), payload: {} });
    expect(clone.statusCode).toBe(201);
    expect(clone.json().room).toMatchObject({ title: 'Renamed (copy)', status: 'draft' });

    const rot = await t.app.inject({ method: 'POST', url: `/api/v1/admin/rooms/${code}/rotate-key`, headers: auth(t.staffToken) });
    expect(rot.json().presenterKey).not.toBe(presenterKey);

    const del = await t.app.inject({ method: 'DELETE', url: `/api/v1/admin/rooms/${code}`, headers: auth(t.staffToken) });
    expect(del.statusCode).toBe(204);
    expect((await t.app.inject({ url: `/api/v1/rooms/${code}/config` })).statusCode).toBe(404);
    const c = await rawConn();
    const [ret] = await c.query('SELECT code FROM retired_codes WHERE code = ?', [code]);
    expect((ret as unknown[]).length).toBe(1);
    await c.end();
  });

  it('validates room input', async () => {
    const bad = async (payload: Record<string, unknown>) =>
      (await t.app.inject({ method: 'POST', url: '/api/v1/admin/rooms', headers: auth(t.staffToken), payload: { title: 'x', ...payload } })).json().error?.code;
    expect(await bad({ title: '' })).toBe('INVALID_PAYLOAD');
    expect(await bad({ apps: [{ name: 'Bad Name' }] })).toBe('INVALID_PAYLOAD');
    expect(await bad({ apps: [{ name: 'a' }, { name: 'a' }] })).toBe('INVALID_PAYLOAD');
    expect(await bad({ publicConfig: { big: 'x'.repeat(9000) } })).toBe('INVALID_PAYLOAD');
    expect(await bad({ apps: [{ name: 'a', config: { big: 'x'.repeat(5000) } }] })).toBe('INVALID_PAYLOAD');
    expect(await bad({ expiresAt: new Date(Date.now() + 31 * 86400_000).toISOString() })).toBe('INVALID_PAYLOAD');
    expect(await bad({ apps: [{ name: 'a', schema: { type: 'object', bogus: 1 } }] })).toBe('INVALID_PAYLOAD');
    expect(await bad({ unknown: 1 })).toBe('INVALID_PAYLOAD');
  });

  it('caps active rooms per staff member at 50', async () => {
    const tok = await t.session('busy@setu.ie');
    const c = await rawConn();
    const now = new Date();
    const later = new Date(Date.now() + 3600_000);
    for (let i = 0; i < 50; ) {
      const [r] = await c.query(
        "INSERT IGNORE INTO rooms (code,title,owner,status,public_config,limits,created_at,closes_at,expires_at) VALUES (?, 't', 'busy@setu.ie', 'open', '{}', '{}', ?, ?, ?)",
        [randomRoomCode(), now, later, later],
      );
      i += (r as { affectedRows: number }).affectedRows;
    }
    await c.end();
    const r = await t.app.inject({ method: 'POST', url: '/api/v1/admin/rooms', headers: auth(tok), payload: { title: 'one too many' } });
    expect(r.json().error.code).toBe('CAP_REACHED');
  });
});

describe('join, write and read', () => {
  it('joins with weighted groups and reuses tokens', async () => {
    const { code } = await createRoom(t);
    const j = await join(t, code);
    expect(j.cid).toHaveLength(26);
    expect(['A', 'B']).toContain(j.groups.quiz);
    const again = await t.app.inject({ method: 'POST', url: `/api/v1/rooms/${code}/join`, payload: { existingToken: j.token } });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ cid: j.cid, token: j.token, groups: j.groups });
  });

  it('writes single events and batches with seq; reads, summary and export', async () => {
    const { code, presenterKey } = await createRoom(t);
    const a = await join(t, code);
    const b = await join(t, code);
    const r1 = await send(t, code, a.token, { app: 'quiz', data: { answer: 'B', score: 1 }, clientT: 1700000000000, appVersion: '1.0.0' });
    expect(r1.statusCode).toBe(202);
    expect(r1.json()).toEqual({ id: expect.any(String), seq: 1 });
    const r2 = await send(t, code, b.token, { events: [{ app: 'quiz', data: { answer: '=CMD()' } }, { app: 'free', data: { text: 'hello, "world"' } }] });
    expect(r2.json()).toMatchObject({ seq: 2, seqs: [2, 3] });

    const ev = await t.app.inject({ url: `/api/v1/rooms/${code}/events?since=1`, headers: { 'x-presenter-key': presenterKey } });
    expect(ev.json().events.map((e: { seq: number }) => e.seq)).toEqual([2, 3]);
    expect(ev.json().events[0]).toMatchObject({ app: 'quiz', cid: b.cid, group: b.groups.quiz, data: { answer: '=CMD()' } });
    const quizOnly = await t.app.inject({ url: `/api/v1/rooms/${code}/events?app=quiz`, headers: auth(t.staffToken) });
    expect(quizOnly.json().events).toHaveLength(2);
    expect((await t.app.inject({ url: `/api/v1/rooms/${code}/events`, headers: { 'x-presenter-key': 'wrong' } })).statusCode).toBe(401);
    expect((await t.app.inject({ url: `/api/v1/rooms/${code}/events?limit=1001`, headers: auth(t.staffToken) })).statusCode).toBe(400);

    const sum = await t.app.inject({ url: `/api/v1/rooms/${code}/summary`, headers: auth(t.staffToken) });
    expect(sum.json()).toMatchObject({ eventCount: 3, uniqueClients: 2, clients: 2 });
    expect(sum.json().apps.quiz.events).toBe(2);
    expect(sum.json().apps.free.events).toBe(1);

    const csv = await t.app.inject({ url: `/api/v1/rooms/${code}/export?format=csv&app=quiz`, headers: auth(t.staffToken) });
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.body.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('seq,id,app,cid,group,t,clientT,appVersion,data.answer,data.score,data');
    expect(lines[2]).toContain(",'=CMD(),");
    expect(lines).toHaveLength(3);

    const json = await t.app.inject({ url: `/api/v1/rooms/${code}/export?format=json`, headers: { 'x-presenter-key': presenterKey } });
    expect(JSON.parse(json.body)).toHaveLength(3);
  });

  it('closed rooms reject writes but allow reads and delete-my-data', async () => {
    const { code } = await createRoom(t);
    const a = await join(t, code);
    await send(t, code, a.token, { app: 'quiz', data: 1 });
    await t.app.inject({ method: 'POST', url: `/api/v1/admin/rooms/${code}/close`, headers: auth(t.staffToken) });
    const w = await send(t, code, a.token, { app: 'quiz', data: 2 });
    expect(w.json().error.code).toBe('ROOM_CLOSED');
    const me = await t.app.inject({ url: `/api/v1/rooms/${code}/me`, headers: auth(a.token) });
    expect(me.json().events).toHaveLength(1);
    const del = await t.app.inject({ method: 'DELETE', url: `/api/v1/rooms/${code}/me`, headers: auth(a.token) });
    expect(del.json().deleted).toBe(1);
    const me2 = await t.app.inject({ url: `/api/v1/rooms/${code}/me`, headers: auth(a.token) });
    expect(me2.json()).toMatchObject({ deleted: true, events: [] });
  });

  it('delete-my-data marks the cid deleted and blocks further writes', async () => {
    const { code } = await createRoom(t);
    const a = await join(t, code);
    const b = await join(t, code);
    await send(t, code, a.token, { app: 'quiz', data: 1 });
    await send(t, code, b.token, { app: 'quiz', data: 1 });
    await t.app.inject({ method: 'DELETE', url: `/api/v1/rooms/${code}/me`, headers: auth(a.token) });
    const w = await send(t, code, a.token, { app: 'quiz', data: 2 });
    expect(w.statusCode).toBe(410);
    expect(w.json().error.code).toBe('CLIENT_DELETED');
    const room = await t.app.inject({ url: `/api/v1/admin/rooms/${code}`, headers: auth(t.staffToken) });
    expect(room.json()).toMatchObject({ eventCount: 1, deletedClients: 1, clientCount: 1 });
    // rejoining with the old token yields a new identity
    const re = await t.app.inject({ method: 'POST', url: `/api/v1/rooms/${code}/join`, payload: { existingToken: a.token } });
    expect(re.json().cid).not.toBe(a.cid);
  });

  it('enforces per-client app caps and room caps', async () => {
    const { code } = await createRoom(t, { apps: [{ name: 'quiz', maxEventsPerClient: 3 }], limits: { maxEvents: 5, maxClients: 2 } });
    const a = await join(t, code);
    const b = await join(t, code);
    expect((await t.app.inject({ method: 'POST', url: `/api/v1/rooms/${code}/join`, payload: {} })).json().error.code).toBe('CAP_REACHED');
    for (let i = 0; i < 3; i++) expect((await send(t, code, a.token, { app: 'quiz', data: i })).statusCode).toBe(202);
    expect((await send(t, code, a.token, { app: 'quiz', data: 9 })).json().error.code).toBe('CAP_REACHED');
    expect((await send(t, code, b.token, { events: [{ app: 'quiz', data: 1 }, { app: 'quiz', data: 2 }] })).statusCode).toBe(202);
    expect((await send(t, code, b.token, { app: 'quiz', data: 3 })).json().error.code).toBe('CAP_REACHED'); // room maxEvents 5
  });

  it('applies JSON Schema and app enablement', async () => {
    const { code } = await createRoom(t, {
      apps: [
        { name: 'poll', schema: { type: 'object', properties: { choice: { enum: ['x', 'y'] } }, required: ['choice'], additionalProperties: false } },
        { name: 'off', enabled: false },
      ],
    });
    const a = await join(t, code);
    expect((await send(t, code, a.token, { app: 'poll', data: { choice: 'x' } })).statusCode).toBe(202);
    const bad = await send(t, code, a.token, { app: 'poll', data: { choice: 'z' } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('SCHEMA_FAILED');
    expect((await send(t, code, a.token, { app: 'off', data: 1 })).json().error.code).toBe('APP_DISABLED');
    expect((await send(t, code, a.token, { app: 'nope', data: 1 })).json().error.code).toBe('APP_DISABLED');
  });

  it('clears data for one app or the whole room', async () => {
    const { code } = await createRoom(t);
    const a = await join(t, code);
    await send(t, code, a.token, { app: 'quiz', data: 1 });
    await send(t, code, a.token, { app: 'free', data: 1 });
    const r = await t.app.inject({ method: 'DELETE', url: `/api/v1/admin/rooms/${code}/events?app=quiz`, headers: auth(t.staffToken) });
    expect(r.json().deleted).toBe(1);
    const all = await t.app.inject({ method: 'DELETE', url: `/api/v1/admin/rooms/${code}/events`, headers: auth(t.staffToken) });
    expect(all.json().deleted).toBe(1);
    const room = await t.app.inject({ url: `/api/v1/admin/rooms/${code}`, headers: auth(t.staffToken) });
    expect(room.json()).toMatchObject({ eventCount: 0, bytesUsed: 0 });
  });
});
