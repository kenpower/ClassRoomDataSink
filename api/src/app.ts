import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { AppConfig } from './config.js';
import { ApiError } from './errors.js';
import { createPool, type Db } from './db.js';
import { Store } from './store.js';
import { MemoryRateLimitStore, DEFAULT_LIMITS, type RateLimitStore } from './ratelimit.js';
import { MemoryLiveBus, type LiveBus } from './live.js';
import { Metrics } from './metrics.js';
import { StaffAuth } from './auth.js';
import { SchemaCache } from './validate.js';
import { IpHasher, ipInCidrs, parseCidr } from './ip.js';
import { RejectionStats, RoomStatsNotifier, limit, type Ctx } from './context.js';
import { clientRoutes } from './routes/client.js';
import { adminRoutes } from './routes/admin.js';
import { readRoutes } from './routes/read.js';
import { authRoutes } from './routes/auth.js';
import { runCleanup } from './cleanup.js';

export interface BuildOptions {
  db?: Db;
  limiter?: RateLimitStore;
  live?: LiveBus;
  logger?: boolean;
  startCleanup?: boolean;
  memoryUsageMb?: () => number;
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** Paths whose CORS policy is the (anonymous) client one; everything else is admin-origin only. */
function isClientRoute(req: FastifyRequest): boolean {
  const url = req.url.split('?')[0]!;
  if (/^\/api\/v1\/rooms\/[^/]+\/(config|join|me)$/.test(url)) return true;
  if (/^\/api\/v1\/rooms\/[^/]+\/events$/.test(url)) {
    const method = req.method === 'OPTIONS' ? String(req.headers['access-control-request-method'] ?? '').toUpperCase() : req.method;
    return method === 'POST';
  }
  return false;
}

export async function buildApp(cfg: AppConfig, opts: BuildOptions = {}): Promise<{ app: FastifyInstance; ctx: Ctx; close: () => Promise<void> }> {
  const ipHasher = new IpHasher();
  const trust = cfg.trustProxyCidrs.map(parseCidr);
  const allow = cfg.ipAllowlist.map(parseCidr);

  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: cfg.logLevel,
            // JSON on stdout; never log payloads, tokens or full IPs.
            serializers: {
              req: (r) => ({ method: r.method, url: String(r.url).split('?')[0] }),
              res: (r) => ({ statusCode: r.statusCode }),
            },
            redact: ['req.headers', 'headers', 'body'],
          },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 64 * 1024,
    trustProxy: trust.length ? (addr: string) => ipInCidrs(addr, trust) : false,
    // Room codes and app names are case-normalised by handlers, keep routing exact.
    routerOptions: { ignoreTrailingSlash: true, maxParamLength: 64 },
    forceCloseConnections: true,
  });

  const db = opts.db ?? createPool(cfg.db);
  const store = new Store(db);
  const live = opts.live ?? new MemoryLiveBus();
  const metrics = new Metrics();
  let ctxRef!: Ctx;
  const roomStats = new RoomStatsNotifier(() => ctxRef);
  const ctx: Ctx = {
    cfg,
    store,
    limiter: opts.limiter ?? new MemoryRateLimitStore(),
    live,
    metrics,
    staffAuth: new StaffAuth(cfg.auth, cfg.token.secret),
    schemas: new SchemaCache(),
    rejections: new RejectionStats(),
    roomStats,
    memoryUsageMb: opts.memoryUsageMb ?? (() => process.memoryUsage().rss / (1024 * 1024)),
  };
  ctxRef = ctx;
  metrics.gauge('roomsink_ws_connections', 'Open live WebSocket connections', () => live.connectionCount());
  metrics.gauge('roomsink_ratelimit_keys', 'Rate-limit buckets in memory', () => ctx.limiter.size());

  // Only JSON bodies are accepted. Record the raw size for the per-route single/batch limits.
  app.removeAllContentTypeParsers();
  const jsonParser = app.getDefaultJsonParser('error', 'error');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawSize = Buffer.byteLength(body as string);
    jsonParser(req, body as string, done);
  });

  app.setErrorHandler((err: Error & { code?: string; statusCode?: number }, req, reply) => {
    let e: ApiError;
    if (err instanceof ApiError) e = err;
    else if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') e = new ApiError('INVALID_PAYLOAD', 'Body too large', { status: 413 });
    else if (err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') e = new ApiError('INVALID_PAYLOAD', 'Content-Type must be application/json', { status: 415 });
    else if (err.code?.startsWith('FST_ERR_CTP') || err.code === 'FST_ERR_VALIDATION' || err instanceof SyntaxError || err.statusCode === 400)
      e = new ApiError('INVALID_PAYLOAD', 'Malformed request body');
    else {
      req.log.error({ err: { message: err.message, code: err.code, stack: err.stack } }, 'unhandled error');
      e = new ApiError('INTERNAL', 'Internal error');
    }
    if (e.retryAfter !== undefined) reply.header('Retry-After', String(e.retryAfter));
    reply.code(e.statusCode).send(e.toBody());
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send(new ApiError('NOT_FOUND', 'Not found').toBody());
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    const url = req.url;
    if (url === '/healthz' || url === '/readyz' || url === '/metrics') return;
    if (allow.length && !ipInCidrs(req.ip, allow)) throw new ApiError('FORBIDDEN', 'Address not allowed');
    if (url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      limit(ctx, `ip:${req.ip}`, DEFAULT_LIMITS.ipRate, DEFAULT_LIMITS.ipBurst);
    }
  });

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unmatched';
    metrics.requests.inc({ route, method: req.method, status: String(reply.statusCode) });
    if (route === '/healthz' || route === '/readyz' || route === '/metrics') return;
    req.log.info(
      { method: req.method, route, status: reply.statusCode, ms: Math.round(reply.elapsedTime), ip: ipHasher.hash(req.ip) },
      'request',
    );
  });

  const clientOrigins = cfg.cors.clientOrigins;
  await app.register(cors, {
    hook: 'onRequest',
    delegator: (req, cb) => {
      const base = {
        methods: ['GET', 'POST', 'PATCH', 'DELETE'],
        allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Presenter-Key'],
        exposedHeaders: ['Retry-After', 'Content-Disposition'],
        maxAge: 600,
      };
      if (req.url.startsWith('/sdk/')) return cb(null, { ...base, origin: '*' });
      if (isClientRoute(req)) return cb(null, { ...base, origin: clientOrigins.includes('*') ? '*' : clientOrigins });
      cb(null, { ...base, origin: cfg.cors.adminOrigin ? [cfg.cors.adminOrigin] : false });
    },
  });
  await app.register(websocket, { options: { maxPayload: 1024 } });

  // Ops endpoints. /metrics is not routed by the proxy, so it is reachable on the internal network only.
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await store.ping();
      return { ok: true };
    } catch {
      reply.code(503);
      return { ok: false };
    }
  });
  app.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', 'text/plain; version=0.0.4');
    return metrics.render();
  });

  // The client SDK, a dependency-free ES module.
  const sdkFile = cfg.sdkPath ?? path.resolve(here, '..', '..', 'sdk', 'roomsink.js');
  let sdkCache: string | null = null;
  app.get('/sdk/roomsink.js', async (_req, reply) => {
    try {
      sdkCache ??= await readFile(sdkFile, 'utf8');
    } catch {
      throw new ApiError('NOT_FOUND', 'SDK not bundled');
    }
    reply.header('Content-Type', 'text/javascript; charset=utf-8');
    reply.header('Cache-Control', 'public, max-age=300');
    return sdkCache;
  });

  await app.register(async (scope) => {
    authRoutes(scope, ctx);
    clientRoutes(scope, ctx);
    adminRoutes(scope, ctx);
    readRoutes(scope, ctx);
  });

  const sweeper = setInterval(() => ctx.limiter.sweep(), 60_000);
  sweeper.unref();
  let cleanupTimer: NodeJS.Timeout | undefined;
  if (opts.startCleanup) {
    const run = () =>
      runCleanup(db, store, live)
        .then((r) => {
          if (r.ran && (r.closed || r.deleted)) app.log.info({ ...r }, 'cleanup');
          metrics.cleanupDeleted.inc({}, r.deleted);
        })
        .catch((err) => app.log.error({ err: String(err) }, 'cleanup failed'));
    cleanupTimer = setInterval(run, cfg.cleanupIntervalMs);
    cleanupTimer.unref();
    setTimeout(run, 2000).unref();
  }

  const close = async () => {
    clearInterval(sweeper);
    if (cleanupTimer) clearInterval(cleanupTimer);
    roomStats.stop();
    live.stop();
    await app.close();
    if (!opts.db) await db.end();
  };
  return { app, ctx, close };
}
