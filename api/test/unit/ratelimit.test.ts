import { describe, expect, it } from 'vitest';
import { MemoryRateLimitStore, resolveRoomLimits, DEFAULT_LIMITS } from '../../src/ratelimit.js';

describe('token bucket', () => {
  it('allows a burst then refills at the rate', () => {
    let now = 0;
    const s = new MemoryRateLimitStore(() => now);
    for (let i = 0; i < 20; i++) expect(s.take('cid', 2, 20).ok).toBe(true);
    const r = s.take('cid', 2, 20);
    expect(r.ok).toBe(false);
    expect(r.retryAfter).toBe(1);
    now += 500;
    expect(s.take('cid', 2, 20).ok).toBe(true);
    expect(s.take('cid', 2, 20).ok).toBe(false);
  });
  it('computes Retry-After for slow buckets', () => {
    const now = 0;
    const s = new MemoryRateLimitStore(() => now);
    for (let i = 0; i < 10; i++) s.take('fail', 10 / 60, 10);
    const r = s.take('fail', 10 / 60, 10);
    expect(r.ok).toBe(false);
    expect(r.retryAfter).toBe(6);
  });
  it('keys are independent', () => {
    const s = new MemoryRateLimitStore(() => 0);
    expect(s.take('a', 1, 1).ok).toBe(true);
    expect(s.take('a', 1, 1).ok).toBe(false);
    expect(s.take('b', 1, 1).ok).toBe(true);
  });
  it('blocks expire', () => {
    let now = 0;
    const s = new MemoryRateLimitStore(() => now);
    s.block('ip', 600_000);
    expect(s.blockedFor('ip')).toBe(600);
    now = 600_001;
    expect(s.blockedFor('ip')).toBe(0);
  });
  it('sweeps full buckets and expired blocks', () => {
    let now = 0;
    const s = new MemoryRateLimitStore(() => now);
    s.take('a', 1, 5);
    s.take('b', 1, 5);
    s.block('c', 1000);
    expect(s.size()).toBe(3);
    now = 1000;
    s.take('b', 1, 5, 5); // b drained, still active
    s.sweep();
    expect(s.size()).toBe(1);
  });
});

describe('room limits', () => {
  it('defaults and overrides', () => {
    expect(resolveRoomLimits(null).maxEvents).toBe(DEFAULT_LIMITS.roomMaxEvents);
    expect(resolveRoomLimits({ maxClients: 30 }).maxClients).toBe(30);
    expect(resolveRoomLimits({ maxClients: -1 }).maxClients).toBe(1000);
  });
});
