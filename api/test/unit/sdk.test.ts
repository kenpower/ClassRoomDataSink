import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain JS module
import { RoomSink } from '../../../sdk/roomsink.js';

type Handler = (url: string, init: RequestInit) => { status: number; body?: unknown; headers?: Record<string, string> };
function mockFetch(h: Handler) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = h(url, init);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  };
  return { fn, calls };
}
const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};
const config = { code: 'ABCDEF', title: 't', status: 'open', apps: [{ name: 'quiz', config: { q: 1 } }], publicConfig: {} };

describe('SDK', () => {
  it('joins, caches the token and exposes config/groups', async () => {
    const storage = mem();
    const { fn, calls } = mockFetch((url) =>
      url.endsWith('/config') ? { status: 200, body: config } : { status: 201, body: { token: 'tok', cid: 'c'.repeat(26), groups: { quiz: 'B' }, expiresAt: '' } },
    );
    const rs = await RoomSink.connect({ api: 'https://x/', room: 'abcdef', fetch: fn, storage });
    expect(rs.app('quiz').config).toEqual({ q: 1 });
    expect(rs.group('quiz')).toBe('B');
    expect(storage.m.get('roomsink:ABCDEF:token')).toBe('tok');
    await RoomSink.connect({ api: 'https://x', room: 'ABCDEF', fetch: fn, storage });
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({ existingToken: 'tok' });
    expect(calls[0]!.url).toBe('https://x/api/v1/rooms/ABCDEF/config');
  });

  it('retries 429/5xx with the same idempotency key, and rejects validation errors', async () => {
    vi.useFakeTimers();
    let n = 0;
    const keys: string[] = [];
    const { fn } = mockFetch((url, init) => {
      if (url.endsWith('/config')) return { status: 200, body: config };
      if (url.endsWith('/join')) return { status: 201, body: { token: 't', cid: 'c', groups: {} } };
      keys.push((init.headers as Record<string, string>)['Idempotency-Key']!);
      n++;
      if (n === 1) return { status: 429, body: { error: { code: 'RATE_LIMITED', retryAfter: 1 } }, headers: { 'Retry-After': '1' } };
      if (n === 2) return { status: 503, body: { error: { code: 'UNAVAILABLE' } } };
      if (n === 3) return { status: 202, body: { id: 'e1', seq: 1 } };
      return { status: 400, body: { error: { code: 'INVALID_PAYLOAD', message: 'bad' } } };
    });
    const rs = await RoomSink.connect({ room: 'ABCDEF', fetch: fn, storage: mem() });
    const p = rs.send('quiz', { a: 1 });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ id: 'e1', seq: 1 });
    expect(new Set(keys).size).toBe(1);
    const bad = rs.send('quiz', { a: 2 });
    await vi.runAllTimersAsync();
    await expect(bad).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
    vi.useRealTimers();
  });

  it('rejects a missing room code and deletes data', async () => {
    await expect(RoomSink.connect({ room: 'nope', fetch: vi.fn() })).rejects.toMatchObject({ code: 'ROOM_NOT_FOUND' });
    const storage = mem();
    const { fn } = mockFetch((url, init) => {
      if (url.endsWith('/config')) return { status: 200, body: config };
      if (url.endsWith('/join')) return { status: 201, body: { token: 't', cid: 'c', groups: {} } };
      if (init.method === 'DELETE') return { status: 200, body: { deleted: 3 } };
      return { status: 500 };
    });
    const rs = await RoomSink.connect({ room: 'ABCDEF', fetch: fn, storage });
    await expect(rs.deleteMyData()).resolves.toEqual({ deleted: 3 });
    expect(storage.m.has('roomsink:ABCDEF:token')).toBe(false);
  });
});
