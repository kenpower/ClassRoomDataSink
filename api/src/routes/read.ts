import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { ApiError, roomNotFound } from '../errors.js';
import { APP_NAME_RE, normaliseCode } from '../codes.js';
import { bearer } from '../auth.js';
import { newTicket, presenterKeyMatches } from '../tokens.js';
import { csvRow } from '../csv.js';
import { roomLiveInfo, type Ctx } from '../context.js';
import { canAccess, requireStaff } from './admin.js';
import type { RoomWithApps } from '../store.js';
import type { LiveEvent } from '../live.js';

interface ReadQuery {
  app?: string;
  since?: string;
  limit?: string;
  format?: string;
  ticket?: string;
}

function parseApp(q: ReadQuery): string | undefined {
  if (q.app === undefined || q.app === '') return undefined;
  if (!APP_NAME_RE.test(q.app)) throw new ApiError('INVALID_PAYLOAD', 'Invalid app');
  return q.app;
}

function parseSince(q: ReadQuery): number {
  if (q.since === undefined || q.since === '') return 0;
  const n = Number(q.since);
  if (!Number.isSafeInteger(n) || n < 0) throw new ApiError('INVALID_PAYLOAD', 'since must be a non-negative integer');
  return n;
}

/** Staff JWT (owner or admin) or the room's presenter key (read-only). */
export async function readAccess(ctx: Ctx, req: FastifyRequest): Promise<RoomWithApps> {
  const code = normaliseCode((req.params as { code?: string }).code);
  const room = code ? await ctx.store.getRoom(code) : null;
  const presenterKey = req.headers['x-presenter-key'];
  if (typeof presenterKey === 'string') {
    if (!room || !presenterKeyMatches(presenterKey, room.presenterKeyHash)) throw new ApiError('UNAUTHORISED', 'Invalid presenter key');
    return room;
  }
  if (!bearer(req)) throw new ApiError('UNAUTHORISED', 'Staff token or presenter key required');
  const staff = await requireStaff(ctx, req);
  if (!room) throw roomNotFound();
  if (!canAccess(staff, room)) throw new ApiError('FORBIDDEN', 'Not an owner of this room');
  return room;
}

export function readRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/v1/rooms/:code/events', async (req) => {
    const room = await readAccess(ctx, req);
    const q = req.query as ReadQuery;
    const lim = q.limit === undefined ? 500 : Number(q.limit);
    if (!Number.isInteger(lim) || lim < 1 || lim > 1000) throw new ApiError('INVALID_PAYLOAD', 'limit must be 1-1000');
    const events = await ctx.store.listEvents(room.code, { app: parseApp(q), since: parseSince(q), limit: lim });
    const last = events.at(-1)?.seq;
    return { events, nextSince: last ?? parseSince(q), more: events.length === lim };
  });

  app.get('/api/v1/rooms/:code/summary', async (req) => {
    const room = await readAccess(ctx, req);
    const q = req.query as ReadQuery;
    const s = await ctx.store.summary(room.code, parseApp(q));
    const fresh = (await ctx.store.getRoom(room.code, { fresh: true })) ?? room;
    const clients = await ctx.store.clientCount(room.code);
    return {
      code: room.code,
      status: fresh.status,
      eventCount: fresh.eventCount,
      bytesUsed: fresh.bytesUsed,
      clients: clients.total - clients.deleted,
      deletedClients: clients.deleted,
      uniqueClients: s.uniqueClients,
      apps: s.apps,
      rejections: ctx.rejections.get(room.code),
    };
  });

  app.get('/api/v1/rooms/:code/export', async (req, reply) => {
    const room = await readAccess(ctx, req);
    const q = req.query as ReadQuery;
    const appName = parseApp(q);
    const format = q.format ?? 'csv';
    if (format !== 'csv' && format !== 'json') throw new ApiError('INVALID_PAYLOAD', 'format must be csv or json');
    const store = ctx.store;
    const code = room.code;

    async function* pages(): AsyncGenerator<LiveEvent[]> {
      let since = 0;
      for (;;) {
        const batch = await store.listEvents(code, { app: appName, since, limit: 1000 });
        if (!batch.length) return;
        yield batch;
        since = batch.at(-1)!.seq;
        if (batch.length < 1000) return;
      }
    }

    const base = `roomsink-${code}${appName ? `-${appName}` : ''}`;
    let body: AsyncGenerator<string>;
    if (format === 'csv') {
      const keys = appName ? await store.dataKeys(code, appName) : [];
      body = (async function* () {
        yield '﻿' + csvRow(['seq', 'id', 'app', 'cid', 'group', 't', 'clientT', 'appVersion', ...keys.map((k) => `data.${k}`), 'data']);
        for await (const batch of pages()) {
          let chunk = '';
          for (const e of batch) {
            const d = e.data as Record<string, unknown> | null;
            const flat = keys.map((k) => (d && typeof d === 'object' && !Array.isArray(d) ? d[k] : undefined));
            chunk += csvRow([e.seq, e.id, e.app, e.cid, e.group, e.t, e.clientT, e.appVersion, ...flat, JSON.stringify(e.data)]);
          }
          yield chunk;
        }
      })();
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${base}.csv"`);
    } else {
      body = (async function* () {
        yield '[';
        let first = true;
        for await (const batch of pages()) {
          let chunk = '';
          for (const e of batch) {
            chunk += (first ? '\n' : ',\n') + JSON.stringify(e);
            first = false;
          }
          yield chunk;
        }
        yield '\n]\n';
      })();
      reply.header('Content-Type', 'application/json; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${base}.json"`);
    }
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(Readable.from(body));
  });

  app.post('/api/v1/rooms/:code/live-ticket', async (req) => {
    const room = await readAccess(ctx, req);
    const ticket = newTicket();
    await ctx.store.createTicket(ticket, room.code);
    return { ticket, expiresIn: 30 };
  });

  app.get(
    '/api/v1/rooms/:code/live',
    {
      websocket: true,
      // Check the single-use ticket before the upgrade, so bad tickets get a plain HTTP 401.
      preValidation: async (req) => {
        const code = normaliseCode((req.params as { code?: string }).code);
        const q = req.query as ReadQuery;
        if (!code || typeof q.ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(q.ticket)) throw new ApiError('UNAUTHORISED', 'Valid ticket required');
        if (!(await ctx.store.consumeTicket(q.ticket, code))) throw new ApiError('UNAUTHORISED', 'Ticket invalid, used or expired');
        parseApp(q);
        parseSince(q);
      },
    },
    async (socket: WebSocket, req) => {
      const code = normaliseCode((req.params as { code?: string }).code)!;
      const q = req.query as ReadQuery;
      const appName = parseApp(q);
      const since = parseSince(q);
      const unsubscribe = ctx.live.subscribe(code, {
        app: appName,
        send: (m) => socket.send(m),
        buffered: () => socket.bufferedAmount,
        close: (c, r) => socket.close(c, r),
      });
      socket.on('close', unsubscribe);
      socket.on('error', unsubscribe);
      // Ignore anything the client sends except tiny pings; never let it buffer data.
      socket.on('message', (m: Buffer) => {
        if (m.length > 128) socket.close(1009, 'message too large');
      });
      try {
        const info = await roomLiveInfo(ctx, code);
        if (!info) return socket.close(4404, 'room not found');
        socket.send(JSON.stringify({ type: 'room', room: info }));
        // Backlog after `since` (up to 5,000); the client de-duplicates by seq with live batches.
        let cursor = since;
        for (let i = 0; i < 5; i++) {
          const batch = await ctx.store.listEvents(code, { app: appName, since: cursor, limit: 1000 });
          if (!batch.length) break;
          socket.send(JSON.stringify({ type: 'events', events: batch, backlog: true }));
          cursor = batch.at(-1)!.seq;
          if (batch.length < 1000) break;
        }
      } catch (err) {
        req.log.error({ err: String(err) }, 'live backlog failed');
        socket.close(1011, 'error');
      }
    },
  );
}
