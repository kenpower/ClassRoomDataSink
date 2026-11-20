import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError, roomNotFound } from '../errors.js';
import { APP_NAME_RE, normaliseCode } from '../codes.js';
import { bearer, type Staff } from '../auth.js';
import { newPresenterKey } from '../tokens.js';
import { jsonByteLength } from '../validate.js';
import { DEFAULT_LIMITS } from '../ratelimit.js';
import type { Ctx } from '../context.js';
import { roomLiveInfo } from '../context.js';
import type { AppDef, RoomWithApps, StoredLimits } from '../store.js';

const jsonObject = (maxBytes: number, label: string) =>
  z
    .record(z.string(), z.unknown())
    .refine((v) => jsonByteLength(v) <= maxBytes, { message: `${label} must be at most ${maxBytes / 1024} KB` });

const appSchema = z
  .object({
    name: z.string().regex(APP_NAME_RE),
    enabled: z.boolean().default(true),
    maxEventsPerClient: z.number().int().min(1).max(50_000).default(100),
    allowFreeText: z.boolean().default(false),
    groups: z
      .record(z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), z.number().min(0).max(1_000_000))
      .refine((g) => Object.keys(g).length <= 20, { message: 'at most 20 groups' })
      .nullable()
      .default(null),
    config: jsonObject(4 * 1024, 'app config').default({}),
    schema: z.union([z.record(z.string(), z.unknown()), z.boolean()]).nullable().default(null),
  })
  .strict();

const limitsSchema = z
  .object({
    maxEvents: z.number().int().min(1).max(DEFAULT_LIMITS.roomMaxEvents),
    maxClients: z.number().int().min(1).max(DEFAULT_LIMITS.roomMaxClients),
    maxBytes: z.number().int().min(1).max(DEFAULT_LIMITS.roomMaxBytes),
    writesPerSecond: z.number().min(0.1).max(DEFAULT_LIMITS.roomWriteRate),
    clientWritesPerSecond: z.number().min(0.1).max(20),
    clientWriteBurst: z.number().int().min(1).max(200),
    joinsPerHour: z.number().int().min(1).max(5000),
    openMinutes: z.number().int().min(1).max(30 * 24 * 60),
    retainHours: z.number().int().min(1).max(30 * 24),
  })
  .partial()
  .strict();

const date = z.iso.datetime({ offset: true }).transform((s) => new Date(s));
const staffId = z.string().min(1).max(255);

const roomBase = {
  title: z.string().trim().min(1).max(100),
  purpose: z.enum(['teaching', 'research']),
  publicConfig: jsonObject(8 * 1024, 'publicConfig'),
  limits: limitsSchema,
  closesAt: date,
  expiresAt: date,
  apps: z
    .array(appSchema)
    .max(50)
    .refine((a) => new Set(a.map((x) => x.name)).size === a.length, { message: 'app names must be unique' }),
  owners: z.array(staffId).max(20),
};

const createSchema = z
  .object({
    ...roomBase,
    purpose: roomBase.purpose.default('teaching'),
    publicConfig: roomBase.publicConfig.default({}),
    limits: roomBase.limits.default({}),
    closesAt: roomBase.closesAt.optional(),
    expiresAt: roomBase.expiresAt.optional(),
    apps: roomBase.apps.default([]),
    owners: roomBase.owners.default([]),
    open: z.boolean().default(false),
    presenterKey: z.boolean().default(true),
  })
  .strict();

const patchSchema = z.object(roomBase).partial().strict();
const openSchema = z.object({ closesAt: date.optional() }).strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    const i = r.error.issues[0]!;
    throw new ApiError('INVALID_PAYLOAD', `${i.path.join('.') || 'body'}: ${i.message}`);
  }
  return r.data;
}

export function roomView(room: RoomWithApps, extra: Record<string, unknown> = {}) {
  return {
    code: room.code,
    title: room.title,
    owner: room.owner,
    owners: room.owners,
    status: room.status,
    purpose: room.purpose,
    publicConfig: room.publicConfig,
    limits: room.limits,
    hasPresenterKey: !!room.presenterKeyHash,
    eventCount: room.eventCount,
    bytesUsed: room.bytesUsed,
    createdAt: room.createdAt.toISOString(),
    closesAt: room.closesAt.toISOString(),
    expiresAt: room.expiresAt.toISOString(),
    apps: room.apps,
    ...extra,
  };
}

export function canAccess(staff: Staff, room: RoomWithApps) {
  return staff.isAdmin || room.owner === staff.sub || room.owners.includes(staff.sub);
}

export async function requireStaff(ctx: Ctx, req: FastifyRequest): Promise<Staff> {
  if (req.staff) return req.staff;
  const token = bearer(req);
  if (!token) throw new ApiError('UNAUTHORISED', 'Staff token required');
  req.staff = await ctx.staffAuth.verify(token);
  return req.staff;
}

export function adminRoutes(app: FastifyInstance, ctx: Ctx) {
  const validateApps = (apps: AppDef[] | undefined) => {
    for (const a of apps ?? []) if (a.schema !== null) ctx.schemas.compile(a.schema);
  };

  const ownedRoom = async (req: FastifyRequest): Promise<{ staff: Staff; room: RoomWithApps }> => {
    const staff = await requireStaff(ctx, req);
    const code = normaliseCode((req.params as { code?: string }).code);
    const room = code ? await ctx.store.getRoom(code, { fresh: true }) : null;
    if (!room) throw roomNotFound();
    if (!canAccess(staff, room)) throw new ApiError('FORBIDDEN', 'Not an owner of this room');
    return { staff, room };
  };

  const afterChange = async (code: string) => {
    const info = await roomLiveInfo(ctx, code);
    if (info) ctx.live.publishRoom(code, info);
  };

  app.post('/api/v1/admin/rooms', async (req, reply) => {
    const staff = await requireStaff(ctx, req);
    const body = parse(createSchema, req.body);
    validateApps(body.apps as AppDef[]);
    if ((await ctx.store.countActiveRoomsForOwner(staff.sub)) >= DEFAULT_LIMITS.staffActiveRooms)
      throw new ApiError('CAP_REACHED', `At most ${DEFAULT_LIMITS.staffActiveRooms} active rooms per staff member`);
    const pk = body.presenterKey ? newPresenterKey() : null;
    const code = await ctx.store.createRoom({
      title: body.title,
      owner: staff.sub,
      purpose: body.purpose,
      publicConfig: body.publicConfig,
      limits: body.limits as StoredLimits,
      presenterKeyHash: pk?.hash ?? null,
      closesAt: body.closesAt,
      expiresAt: body.expiresAt,
      apps: body.apps as AppDef[],
      owners: body.owners,
    });
    if (body.open) await ctx.store.setStatus(code, 'open', { closesAt: body.closesAt });
    const room = await ctx.store.requireRoom(code, { fresh: true });
    reply.code(201);
    // The presenter key is only ever returned here and from rotate-key.
    return { code, presenterKey: pk?.key ?? null, room: roomView(room) };
  });

  app.get('/api/v1/admin/rooms', async (req) => {
    const staff = await requireStaff(ctx, req);
    const all = (req.query as { all?: string }).all === '1';
    if (all && !staff.isAdmin) throw new ApiError('FORBIDDEN', 'Admin role required for ?all=1');
    const rooms = await ctx.store.listRooms(all ? null : staff.sub);
    return {
      rooms: rooms.map((r) => ({
        code: r.code,
        title: r.title,
        owner: r.owner,
        status: r.status === 'open' && r.closesAt.getTime() <= Date.now() ? 'closed' : r.status,
        purpose: r.purpose,
        eventCount: r.eventCount,
        bytesUsed: r.bytesUsed,
        clientCount: r.clientCount,
        createdAt: r.createdAt.toISOString(),
        closesAt: r.closesAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
      })),
    };
  });

  app.get('/api/v1/admin/rooms/:code', async (req) => {
    const { room } = await ownedRoom(req);
    const clients = await ctx.store.clientCount(room.code);
    return roomView(room, { clientCount: clients.total - clients.deleted, deletedClients: clients.deleted, rejections: ctx.rejections.get(room.code) });
  });

  app.patch('/api/v1/admin/rooms/:code', async (req) => {
    const { room } = await ownedRoom(req);
    const body = parse(patchSchema, req.body);
    validateApps(body.apps as AppDef[] | undefined);
    await ctx.store.updateRoom(room.code, { ...body, apps: body.apps as AppDef[] | undefined, limits: body.limits as StoredLimits | undefined });
    await afterChange(room.code);
    return roomView(await ctx.store.requireRoom(room.code, { fresh: true }));
  });

  app.delete('/api/v1/admin/rooms/:code', async (req, reply) => {
    const { room } = await ownedRoom(req);
    await ctx.store.deleteRoom(room.code);
    ctx.live.closeRoom(room.code);
    ctx.rejections.delete(room.code);
    reply.code(204);
  });

  app.post('/api/v1/admin/rooms/:code/open', async (req) => {
    const { room } = await ownedRoom(req);
    const body = parse(openSchema, req.body);
    await ctx.store.setStatus(room.code, 'open', body);
    await afterChange(room.code);
    return roomView(await ctx.store.requireRoom(room.code, { fresh: true }));
  });

  app.post('/api/v1/admin/rooms/:code/close', async (req) => {
    const { room } = await ownedRoom(req);
    await ctx.store.setStatus(room.code, 'closed');
    await afterChange(room.code);
    return roomView(await ctx.store.requireRoom(room.code, { fresh: true }));
  });

  app.post('/api/v1/admin/rooms/:code/rotate-key', async (req) => {
    const { room } = await ownedRoom(req);
    const pk = newPresenterKey();
    await ctx.store.setPresenterKeyHash(room.code, pk.hash);
    return { code: room.code, presenterKey: pk.key };
  });

  app.post('/api/v1/admin/rooms/:code/clone', async (req, reply) => {
    const { staff, room } = await ownedRoom(req);
    const body = parse(z.object({ title: roomBase.title.optional() }).strict(), req.body);
    if ((await ctx.store.countActiveRoomsForOwner(staff.sub)) >= DEFAULT_LIMITS.staffActiveRooms)
      throw new ApiError('CAP_REACHED', `At most ${DEFAULT_LIMITS.staffActiveRooms} active rooms per staff member`);
    const pk = newPresenterKey();
    const code = await ctx.store.createRoom({
      title: body.title ?? `${room.title} (copy)`.slice(0, 100),
      owner: staff.sub,
      purpose: room.purpose,
      publicConfig: room.publicConfig,
      limits: room.limits,
      presenterKeyHash: pk.hash,
      apps: room.apps,
      owners: room.owners.filter((o) => o !== staff.sub).concat(room.owner !== staff.sub ? [room.owner] : []),
    });
    reply.code(201);
    return { code, presenterKey: pk.key, room: roomView(await ctx.store.requireRoom(code, { fresh: true })) };
  });

  app.delete('/api/v1/admin/rooms/:code/events', async (req) => {
    const { room } = await ownedRoom(req);
    const appName = (req.query as { app?: string }).app;
    if (appName !== undefined && !APP_NAME_RE.test(appName)) throw new ApiError('INVALID_PAYLOAD', 'Invalid app');
    const deleted = await ctx.store.clearEvents(room.code, appName);
    ctx.live.publishDeleted(room.code, appName ? { app: appName } : { all: true });
    await afterChange(room.code);
    return { deleted };
  });
}
