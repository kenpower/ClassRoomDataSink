import { describe, expect, it } from 'vitest';
import { normaliseCode, pickWeighted, randomRoomCode, CODE_RE } from '../../src/codes.js';
import { ipInCidrs, parseCidr } from '../../src/ip.js';
import { MemoryLiveBus, type Subscriber } from '../../src/live.js';
import { loadConfig } from '../../src/config.js';

describe('room codes', () => {
  it('uses the unambiguous alphabet', () => {
    for (let i = 0; i < 500; i++) expect(randomRoomCode()).toMatch(CODE_RE);
    expect(normaliseCode(' abc234 ')).toBe('ABC234');
    expect(normaliseCode('ABCDE1')).toBeNull(); // 1 is excluded
    expect(normaliseCode('ABCDEO')).toBeNull(); // O is excluded
    expect(normaliseCode("A'; --")).toBeNull();
  });
  it('picks weighted groups', () => {
    const seq = [0.1, 0.6, 0.95];
    let i = 0;
    const rnd = () => seq[i++]!;
    expect(pickWeighted({ A: 1, B: 1 }, rnd)).toBe('A');
    expect(pickWeighted({ A: 1, B: 1 }, rnd)).toBe('B');
    expect(pickWeighted({ A: 9, B: 1 }, rnd)).toBe('B');
    expect(pickWeighted({ A: 0 })).toBeNull();
    const counts = { A: 0, B: 0 };
    for (let n = 0; n < 4000; n++) counts[pickWeighted({ A: 3, B: 1 }) as 'A' | 'B']++;
    expect(counts.A / 4000).toBeGreaterThan(0.7);
    expect(counts.A / 4000).toBeLessThan(0.8);
  });
});

describe('CIDRs', () => {
  it('matches v4, v6 and mapped addresses', () => {
    const c = ['10.0.0.0/8', '192.168.1.0/24', 'fd00::/8'].map(parseCidr);
    expect(ipInCidrs('10.1.2.3', c)).toBe(true);
    expect(ipInCidrs('::ffff:10.1.2.3', c)).toBe(true);
    expect(ipInCidrs('192.168.2.1', c)).toBe(false);
    expect(ipInCidrs('fd12::1', c)).toBe(true);
    expect(ipInCidrs('2001:db8::1', c)).toBe(false);
    expect(ipInCidrs('nonsense', c)).toBe(false);
    expect(() => parseCidr('10.0.0.0/33')).toThrow();
  });
});

describe('live bus', () => {
  it('batches events and filters by app', async () => {
    const bus = new MemoryLiveBus(10_000, 60_000);
    const got: Record<string, string[]> = { all: [], quiz: [] };
    const sub = (name: string, app?: string): Subscriber => ({ app, send: (m) => got[name]!.push(m), buffered: () => 0, close: () => {} });
    bus.subscribe('ROOM22', sub('all'));
    bus.subscribe('ROOM22', sub('quiz', 'quiz'));
    const ev = (seq: number, app: string) => ({ id: String(seq), seq, app, cid: 'c', group: null, t: '', clientT: null, appVersion: null, data: 1 });
    bus.publishEvents('ROOM22', [ev(1, 'quiz'), ev(2, 'poll')]);
    bus.publishEvents('ROOM22', [ev(3, 'poll')]);
    expect(got.all).toHaveLength(0);
    bus.flush();
    expect(got.all).toHaveLength(1);
    expect(JSON.parse(got.all[0]!).events).toHaveLength(3);
    expect(JSON.parse(got.quiz[0]!).events.map((e: { seq: number }) => e.seq)).toEqual([1]);
    bus.stop();
  });
  it('drops slow consumers', () => {
    const bus = new MemoryLiveBus(10_000, 60_000);
    let closed = 0;
    bus.subscribe('ROOM22', { send: () => {}, buffered: () => 5e6, close: () => closed++ });
    bus.publishRoom('ROOM22', {});
    expect(closed).toBe(1);
    bus.stop();
  });
});

describe('config', () => {
  it('requires a 32-byte token secret when set', () => {
    expect(() => loadConfig({ TOKEN_SECRET: 'short' })).toThrow(/TOKEN_SECRET/);
    expect(loadConfig({}).token.ephemeral).toBe(true);
    expect(loadConfig({ CORS_CLIENT_ORIGINS: 'https://a, https://b' }).cors.clientOrigins).toEqual(['https://a', 'https://b']);
  });
});
