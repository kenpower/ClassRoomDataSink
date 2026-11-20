/**
 * Token buckets kept behind an interface so a Redis-backed store can replace the in-memory one
 * when the API is scaled past one instance.
 */
export interface TakeResult {
  ok: boolean;
  /** Seconds until one token is available (only meaningful when !ok). */
  retryAfter: number;
}

export interface RateLimitStore {
  take(key: string, ratePerSec: number, burst: number, cost?: number): TakeResult;
  /** Block a key until a time, e.g. after too many failed room codes. */
  block(key: string, untilMs: number): void;
  blockedFor(key: string): number; // seconds remaining, 0 when not blocked
  sweep(): void;
  size(): number;
}

interface Bucket {
  tokens: number;
  last: number;
  rate: number;
  burst: number;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private buckets = new Map<string, Bucket>();
  private blocks = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}

  take(key: string, ratePerSec: number, burst: number, cost = 1): TakeResult {
    const now = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: burst, last: now, rate: ratePerSec, burst };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(burst, b.tokens + ((now - b.last) / 1000) * ratePerSec);
      b.last = now;
      b.rate = ratePerSec;
      b.burst = burst;
    }
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { ok: true, retryAfter: 0 };
    }
    const retryAfter = Math.max(1, Math.ceil((cost - b.tokens) / ratePerSec));
    return { ok: false, retryAfter };
  }

  block(key: string, untilMs: number) {
    this.blocks.set(key, untilMs);
  }

  blockedFor(key: string): number {
    const until = this.blocks.get(key);
    if (!until) return 0;
    const left = until - this.now();
    if (left <= 0) {
      this.blocks.delete(key);
      return 0;
    }
    return Math.ceil(left / 1000);
  }

  /** Drop buckets that have refilled completely (indistinguishable from new) and expired blocks. */
  sweep() {
    const now = this.now();
    for (const [k, b] of this.buckets) {
      if (b.tokens + ((now - b.last) / 1000) * b.rate >= b.burst) this.buckets.delete(k);
    }
    for (const [k, until] of this.blocks) if (until <= now) this.blocks.delete(k);
  }

  size() {
    return this.buckets.size + this.blocks.size;
  }
}

/** Default limits from the spec. Per-room values can be overridden in rooms.limits. */
export const DEFAULT_LIMITS = {
  ipRate: 50,
  ipBurst: 300,
  ipJoinRate: 10,
  ipJoinBurst: 30,
  roomJoinsPerHour: 600,
  failedCodesPerMin: 10,
  failedCodeBlockMs: 10 * 60 * 1000,
  cidWriteRate: 2,
  cidWriteBurst: 20,
  roomWriteRate: 100,
  roomWriteBurst: 200,
  roomMaxEvents: 50_000,
  roomMaxClients: 1_000,
  roomMaxBytes: 20 * 1024 * 1024,
  staffActiveRooms: 50,
  globalWriteRate: 1000,
  globalWriteBurst: 1000,
};

export interface RoomLimits {
  maxEvents: number;
  maxClients: number;
  maxBytes: number;
  writesPerSecond: number;
  clientWritesPerSecond: number;
  clientWriteBurst: number;
  joinsPerHour: number;
}

export function resolveRoomLimits(stored: Partial<RoomLimits> | null | undefined): RoomLimits {
  const s = stored ?? {};
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
  return {
    maxEvents: num(s.maxEvents, DEFAULT_LIMITS.roomMaxEvents),
    maxClients: num(s.maxClients, DEFAULT_LIMITS.roomMaxClients),
    maxBytes: num(s.maxBytes, DEFAULT_LIMITS.roomMaxBytes),
    writesPerSecond: num(s.writesPerSecond, DEFAULT_LIMITS.roomWriteRate),
    clientWritesPerSecond: num(s.clientWritesPerSecond, DEFAULT_LIMITS.cidWriteRate),
    clientWriteBurst: num(s.clientWriteBurst, DEFAULT_LIMITS.cidWriteBurst),
    joinsPerHour: num(s.joinsPerHour, DEFAULT_LIMITS.roomJoinsPerHour),
  };
}
