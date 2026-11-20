import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError, roomNotFound } from '../errors.js';
import { normaliseCode } from '../codes.js';
import { bearer } from '../auth.js';
import { issueJoinToken, verifyJoinToken, type JoinTokenPayload } from '../tokens.js';
import { BATCH_BODY_LIMIT, checkData, jsonByteLength, parseEnvelope } from '../validate.js';
import { DEFAULT_LIMITS, resolveRoomLimits } from '../ratelimit.js';
import { checkGlobalCapacity, limit, type Ctx } from '../context.js';
import type { RoomWithApps } from '../store.js';

const IDEM_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export function publicConfig(room: RoomWithApps) {
  return {
    code: room.code,
    title: room.title,
    status: room.status === 'open' && room.closesAt.getTime() <= Date.now() ? 'closed' : room.status,
    closesAt: room.closesAt.toISOString(),
    apps: room.apps.filter((a) => a.enabled).map((a) => ({ name: a.name, config: a.config })),
    publicConfig: room.publicConfig,
  };
}

export function clientRoutes(app: FastifyInstance, ctx: Ctx) {
  const codeParam = (req: FastifyRequest) => {
    const code = normaliseCode((req.params as { code?: string }).code);
    if (!code) throw roomNotFound();
    return code;
  };

  /** Room lookup for anonymous callers, counting misses towards the brute-force block. */
  const lookupRoom = async (req: FastifyRequest): Promise<RoomWithApps> => {
    const blockKey = `failblock:${req.ip}`;
    const blocked = ctx.limiter.blockedFor(blockKey);
    if (blocked) throw new ApiError('RATE_LIMITED', 'Too many unknown room codes', { retryAfter: blocked });
    const code = normaliseCode((req.params as { code?: string }).code);
    const room = code ? await ctx.store.getRoom(code) : null;
    if (!room) {
      const r = ctx.limiter.take(`fail:${req.ip}`, DEFAULT_LIMITS.failedCodesPerMin / 60, DEFAULT_LIMITS.failedCodesPerMin);
      if (!r.ok) ctx.limiter.block(blockKey, Date.now() + DEFAULT_LIMITS.failedCodeBlockMs);
      throw roomNotFound();
    }
    return room;
  };

  const requireJoinToken = (req: FastifyRequest, code: string): JoinTokenPayload => {
    const p = verifyJoinToken(ctx.cfg.token, bearer(req), code);
    if (!p) throw new ApiError('TOKEN_INVALID', 'Join token is missing, invalid or expired');
    return p;
  };

  app.get('/api/v1/rooms/:code/config', async (req, reply) => {
    const room = await lookupRoom(req);
    reply.header('Cache-Control', 'public, max-age=5');
    return publicConfig(room);
  });

  app.post('/api/v1/rooms/:code/join', { bodyLimit: 1024 }, async (req, reply) => {
    limit(ctx, `join-ip:${req.ip}`, DEFAULT_LIMITS.ipJoinRate, DEFAULT_LIMITS.ipJoinRate * 3);
    const room = await lookupRoom(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => k !== 'existingToken'))
      throw new ApiError('INVALID_PAYLOAD', 'Body may only contain existingToken');
    if (room.status !== 'open' || room.closesAt.getTime() <= Date.now()) throw new ApiError('ROOM_CLOSED', 'Room is not open');

    if (body.existingToken !== undefined) {
      const p = verifyJoinToken(ctx.cfg.token, body.existingToken, room.code);
      if (p) {
        const client = await ctx.store.getClient(room.code, p.cid);
        if (client && !client.deleted) {
          return { token: body.existingToken, cid: p.cid, groups: client.groups, expiresAt: new Date(p.exp * 1000).toISOString() };
        }
      }
    }
    checkGlobalCapacity(ctx);
    const limits = resolveRoomLimits(room.limits);
    limit(ctx, `join-room:${room.code}`, limits.joinsPerHour / 3600, limits.joinsPerHour);
    const { cid, groups } = await ctx.store.createClient(room, limits);
    const { token, payload } = issueJoinToken(ctx.cfg.token, room.code, cid, room.expiresAt);
    ctx.metrics.joins.inc();
    ctx.roomStats.mark(room.code);
    reply.code(201);
    return { token, cid, groups, expiresAt: new Date(payload.exp * 1000).toISOString() };
  });

  app.post('/api/v1/rooms/:code/events', { bodyLimit: BATCH_BODY_LIMIT }, async (req, reply) => {
    const started = process.hrtime.bigint();
    const code = codeParam(req);
    try {
      const tok = requireJoinToken(req, code);
      const idemKey = req.headers['idempotency-key'];
      if (typeof idemKey !== 'string' || !IDEM_RE.test(idemKey)) throw new ApiError('INVALID_PAYLOAD', 'Idempotency-Key header is required');

      const room = await ctx.store.getRoom(code);
      if (!room) throw roomNotFound();
      const limits = resolveRoomLimits(room.limits);
      checkGlobalCapacity(ctx);
      limit(ctx, `cid:${code}:${tok.cid}`, limits.clientWritesPerSecond, limits.clientWriteBurst);
      limit(ctx, `room-w:${code}`, limits.writesPerSecond, limits.writesPerSecond * 2);

      // 1. Content type is enforced by the parser (only application/json is registered); size here.
      const { events, batch } = parseEnvelope(req.body, req.rawSize ?? 0);
      // 3–5. App exists and is enabled, data shape, JSON Schema.
      const prepared = events.map((e) => {
        const def = room.apps.find((a) => a.name === e.app);
        if (!def || !def.enabled) throw new ApiError('APP_DISABLED', 'App is not enabled in this room');
        checkData(e.data, def.allowFreeText);
        if (def.schema !== null && def.schema !== undefined) ctx.schemas.validate(def.schema, e.data);
        return { ...e, bytes: jsonByteLength(e.data) };
      });
      if (room.status !== 'open') throw new ApiError('ROOM_CLOSED', 'Room is closed');
      // 6. Caps (per client per app, then per room) and the insert happen in one transaction.
      const res = await ctx.store.writeEvents(room, tok.cid, idemKey, prepared, limits);
      if (!res.duplicate) {
        ctx.metrics.eventsWritten.inc({}, res.ids.length);
        ctx.live.publishEvents(code, res.live);
        ctx.roomStats.mark(code);
      }
      ctx.metrics.writeLatency.observe(Number(process.hrtime.bigint() - started) / 1e9);
      reply.code(202);
      // 7. Never echo the payload back.
      return batch
        ? { id: res.ids[0], seq: res.seqs[0] ?? null, ids: res.ids, seqs: res.seqs, duplicate: res.duplicate || undefined }
        : { id: res.ids[0], seq: res.seqs[0] ?? null, duplicate: res.duplicate || undefined };
    } catch (err) {
      if (err instanceof ApiError) {
        ctx.metrics.rejections.inc({ code: err.code });
        ctx.rejections.record(code, err.code);
      }
      throw err;
    }
  });

  app.get('/api/v1/rooms/:code/me', async (req) => {
    const code = codeParam(req);
    const tok = requireJoinToken(req, code);
    if (!(await ctx.store.getRoom(code))) throw roomNotFound();
    const client = await ctx.store.getClient(code, tok.cid);
    if (!client) throw new ApiError('TOKEN_INVALID', 'Unknown client');
    const events = await ctx.store.listEvents(code, { cid: tok.cid, limit: 5000 });
    return {
      cid: tok.cid,
      deleted: client.deleted,
      groups: client.groups,
      events: events.map(({ cid: _cid, ...e }) => e),
    };
  });

  app.delete('/api/v1/rooms/:code/me', async (req) => {
    const code = codeParam(req);
    const tok = requireJoinToken(req, code);
    limit(ctx, `del:${code}:${tok.cid}`, 1, 5);
    if (!(await ctx.store.getRoom(code))) throw roomNotFound();
    const deleted = await ctx.store.deleteClientData(code, tok.cid);
    ctx.live.publishDeleted(code, { cid: tok.cid });
    ctx.roomStats.mark(code);
    return { deleted };
  });
}
