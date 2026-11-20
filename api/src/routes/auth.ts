import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from '../errors.js';
import { bearer } from '../auth.js';
import { limit, type Ctx } from '../context.js';

/** Only same-app relative paths may be used as a post-login return target (no open redirects). */
function safeReturn(v: unknown): string {
  if (typeof v !== 'string' || !/^\/admin\/[A-Za-z0-9/_?=&.-]{0,200}$/.test(v) || v.includes('//')) return '/admin/';
  return v;
}

export function authRoutes(app: FastifyInstance, ctx: Ctx) {
  const callbackUrl = (req: FastifyRequest) => {
    const base = ctx.cfg.publicApiUrl ?? `${req.protocol}://${req.host}`;
    return `${base}/api/v1/auth/callback`;
  };
  const adminPage = (fragment: Record<string, string>) => `${ctx.cfg.adminUrl}auth#${new URLSearchParams(fragment).toString()}`;

  // 1. Browser navigates here; we send it to STARS sign-in.
  app.get('/api/v1/auth/login', async (req, reply) => {
    const ret = safeReturn((req.query as { return?: string }).return);
    const u = new URL(`${ctx.cfg.auth.baseUrl}/sign_in`);
    u.searchParams.set('redirect', callbackUrl(req));
    u.searchParams.set('auth_provider', ctx.cfg.auth.providers);
    u.searchParams.set('origin_url', ret);
    reply.header('Cache-Control', 'no-store');
    return reply.redirect(u.toString(), 302);
  });

  // 2. STARS redirects back with ?token=<HS256 JWT>. Verify server-side, authorise, hand the SPA a one-time code.
  app.get('/api/v1/auth/callback', async (req, reply) => {
    limit(ctx, `login:${req.ip}`, 1, 20);
    const q = req.query as { token?: string; origin_url?: string };
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    const ret = safeReturn(q.origin_url);
    try {
      if (typeof q.token !== 'string' || !q.token) throw new ApiError('UNAUTHORISED', 'Missing token');
      const identity = await ctx.staffAuth.verifyStarsToken(q.token);
      const staff = ctx.staffAuth.authorise(identity);
      const code = ctx.staffAuth.createLoginCode(staff);
      return reply.redirect(adminPage({ code, return: ret }), 302);
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError('UNAUTHORISED', 'Sign-in failed');
      req.log.warn({ code: e.code }, 'staff sign-in rejected');
      return reply.redirect(adminPage({ error: e.code === 'FORBIDDEN' ? 'not_staff' : 'sign_in_failed' }), 302);
    }
  });

  // 3. SPA exchanges the one-time code for a session token kept in memory.
  app.post('/api/v1/auth/session', { bodyLimit: 1024 }, async (req) => {
    limit(ctx, `login:${req.ip}`, 1, 20);
    return ctx.staffAuth.redeemLoginCode((req.body as { code?: unknown } | undefined)?.code);
  });

  // Silent renewal: swap a valid session for a fresh one, up to SESSION_MAX_HOURS after sign-in.
  app.post('/api/v1/auth/refresh', async (req) => {
    const t = bearer(req);
    if (!t) throw new ApiError('UNAUTHORISED', 'Session required');
    const s = await ctx.staffAuth.verifySession(t);
    return ctx.staffAuth.issueSession(s, s.authTime);
  });

  app.get('/api/v1/auth/me', async (req) => {
    const t = bearer(req);
    if (!t) throw new ApiError('UNAUTHORISED', 'Session required');
    const s = await ctx.staffAuth.verify(t);
    return { id: s.sub, name: s.name, isAdmin: s.isAdmin };
  });

  // Clears the STARS session too, then returns to the admin.
  app.get('/api/v1/auth/logout', async (_req, reply) => {
    const u = new URL(`${ctx.cfg.auth.baseUrl}/logout`);
    u.searchParams.set('next', ctx.cfg.adminUrl.startsWith('http') ? ctx.cfg.adminUrl : `${ctx.cfg.publicApiUrl ?? ''}${ctx.cfg.adminUrl}`);
    return reply.redirect(u.toString(), 302);
  });
}
