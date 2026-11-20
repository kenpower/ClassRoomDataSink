import type { FastifyRequest } from 'fastify';
import type { AppConfig } from './config.js';
import type { Store } from './store.js';
import type { RateLimitStore } from './ratelimit.js';
import type { LiveBus } from './live.js';
import type { Metrics } from './metrics.js';
import type { StaffAuth, Staff } from './auth.js';
import type { SchemaCache } from './validate.js';
import { ApiError, type ErrorCode } from './errors.js';
import { DEFAULT_LIMITS } from './ratelimit.js';

export interface Ctx {
  cfg: AppConfig;
  store: Store;
  limiter: RateLimitStore;
  live: LiveBus;
  metrics: Metrics;
  staffAuth: StaffAuth;
  schemas: SchemaCache;
  rejections: RejectionStats;
  roomStats: RoomStatsNotifier;
  /** Overridable for tests. */
  memoryUsageMb: () => number;
}

/** Throw RATE_LIMITED (429 + Retry-After) when the bucket is empty. */
export function limit(ctx: Ctx, key: string, rate: number, burst: number, code: ErrorCode = 'RATE_LIMITED', status?: number) {
  const r = ctx.limiter.take(key, rate, burst);
  if (!r.ok) throw new ApiError(code, 'Too many requests', { retryAfter: r.retryAfter, status });
}

/** Global write ceiling and memory cap: shed load with 503 rather than fall over. */
export function checkGlobalCapacity(ctx: Ctx) {
  if (ctx.memoryUsageMb() > ctx.cfg.memoryLimitMb) throw new ApiError('UNAVAILABLE', 'Server busy', { retryAfter: 5 });
  const r = ctx.limiter.take('global:writes', DEFAULT_LIMITS.globalWriteRate, DEFAULT_LIMITS.globalWriteBurst);
  if (!r.ok) throw new ApiError('UNAVAILABLE', 'Server busy', { retryAfter: r.retryAfter });
}

/** Per-room counts of rejected client writes, shown on the dashboard. In memory, best effort. */
export class RejectionStats {
  private m = new Map<string, Record<string, number>>();
  record(room: string, code: string) {
    if (this.m.size > 10_000) this.m.clear();
    const r = this.m.get(room) ?? {};
    r[code] = (r[code] ?? 0) + 1;
    this.m.set(room, r);
  }
  get(room: string): Record<string, number> {
    return { ...(this.m.get(room) ?? {}) };
  }
  delete(room: string) {
    this.m.delete(room);
  }
}

/** Coalesces "room changed" notifications into at most one `room` message per second per room. */
export class RoomStatsNotifier {
  private dirty = new Set<string>();
  private timer: NodeJS.Timeout;
  constructor(private ctxRef: () => Ctx) {
    this.timer = setInterval(() => void this.flush(), 1000);
    this.timer.unref();
  }
  mark(room: string) {
    this.dirty.add(room);
  }
  async flush() {
    const ctx = this.ctxRef();
    const rooms = [...this.dirty];
    this.dirty.clear();
    for (const code of rooms) {
      try {
        const info = await roomLiveInfo(ctx, code);
        if (info) ctx.live.publishRoom(code, info);
      } catch {
        /* best effort */
      }
    }
  }
  stop() {
    clearInterval(this.timer);
  }
}

export async function roomLiveInfo(ctx: Ctx, code: string) {
  const room = await ctx.store.getRoom(code, { fresh: true });
  if (!room) return null;
  const clients = await ctx.store.clientCount(code);
  return {
    code: room.code,
    status: room.status,
    closesAt: room.closesAt.toISOString(),
    expiresAt: room.expiresAt.toISOString(),
    eventCount: room.eventCount,
    bytesUsed: room.bytesUsed,
    clients: clients.total - clients.deleted,
    deletedClients: clients.deleted,
    apps: room.apps.map((a) => ({ name: a.name, enabled: a.enabled })),
    rejections: ctx.rejections.get(code),
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    rawSize?: number;
    staff?: Staff;
  }
}

export type Req = FastifyRequest;
