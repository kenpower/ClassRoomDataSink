import { createHmac, randomBytes } from 'node:crypto';
import { jwtVerify, SignJWT, type JWTPayload } from 'jose';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from './config.js';
import { ApiError } from './errors.js';

/**
 * Staff authentication against the STARS auth service.
 *
 * STARS redirects back to the API with an HS256 JWT signed with a shared secret (AUTH_JWT_SECRET). It has
 * no roles, so RoomSink authorises staff by email domain / list, and admins by ADMIN_EMAILS. The API then
 * issues its own short-lived session token (HS256, keyed from TOKEN_SECRET) that the admin SPA keeps in
 * memory and sends as a Bearer token. The STARS secret never leaves the API.
 */
export interface Staff {
  sub: string; // lower-cased email (or user_id when the account has no mail)
  name: string;
  isAdmin: boolean;
}

export interface StarsIdentity {
  id: string;
  email: string;
  name: string;
  provider: string;
}

export function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  const m = /^Bearer\s+(\S{1,8192})$/i.exec(h);
  return m?.[1];
}

const SESSION_ISS = 'roomsink';
const SESSION_AUD = 'roomsink-admin';

export class StaffAuth {
  private readonly sessionKey: Uint8Array;
  private readonly starsKey?: Uint8Array;
  /** One-time login codes handed to the SPA in the URL fragment (single instance, 60 s). */
  private readonly codes = new Map<string, { staff: Staff; authTime: number; exp: number }>();

  constructor(
    private readonly cfg: AppConfig['auth'],
    tokenSecret: string,
  ) {
    this.sessionKey = createHmac('sha256', tokenSecret).update('roomsink-staff-session-v1').digest();
    if (cfg.jwtSecret) this.starsKey = new TextEncoder().encode(cfg.jwtSecret);
  }

  get configured() {
    return !!this.starsKey;
  }

  /** Verify the token STARS puts on the callback URL. Algorithm pinned to HS256. */
  async verifyStarsToken(token: string): Promise<StarsIdentity> {
    if (!this.starsKey) throw new ApiError('UNAUTHORISED', 'Staff sign-in is not configured (AUTH_JWT_SECRET)');
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.starsKey, {
        algorithms: ['HS256'],
        maxTokenAge: this.cfg.tokenMaxAgeS > 0 ? this.cfg.tokenMaxAgeS : undefined,
      }));
    } catch {
      throw new ApiError('UNAUTHORISED', 'Invalid sign-in token');
    }
    const str = (k: string) => (typeof payload[k] === 'string' ? (payload[k] as string).trim() : '');
    const email = str('email').toLowerCase();
    const userId = str('user_id').toLowerCase();
    const id = email || userId;
    if (!id) throw new ApiError('UNAUTHORISED', 'Sign-in token has no user');
    const name = str('display_name') || [str('forename'), str('surname')].filter(Boolean).join(' ') || id;
    return { id, email: email || userId, name: name.slice(0, 200), provider: str('auth_provider') };
  }

  /** Staff = email in STAFF_EMAILS or ADMIN_EMAILS, or in one of STAFF_EMAIL_DOMAINS (or a subdomain). */
  authorise(identity: StarsIdentity): Staff {
    const addrs = [identity.email, identity.id].filter((a) => a.includes('@'));
    const isAdmin = addrs.some((a) => this.cfg.adminEmails.includes(a));
    const listed = addrs.some((a) => this.cfg.staffEmails.includes(a));
    const domainOk = addrs.some((a) => {
      const domain = a.split('@').pop()!;
      return this.cfg.staffDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
    });
    if (!isAdmin && !listed && !domainOk) throw new ApiError('FORBIDDEN', 'This account is not authorised as staff');
    return { sub: identity.id, name: identity.name, isAdmin };
  }

  createLoginCode(staff: Staff, authTime = Date.now()): string {
    const now = Date.now();
    for (const [k, v] of this.codes) if (v.exp < now) this.codes.delete(k);
    if (this.codes.size > 10_000) this.codes.clear();
    const code = randomBytes(32).toString('base64url');
    this.codes.set(code, { staff, authTime, exp: now + 60_000 });
    return code;
  }

  async redeemLoginCode(code: unknown) {
    if (typeof code !== 'string') throw new ApiError('UNAUTHORISED', 'Invalid login code');
    const entry = this.codes.get(code);
    this.codes.delete(code);
    if (!entry || entry.exp < Date.now()) throw new ApiError('UNAUTHORISED', 'Login code invalid or expired');
    return this.issueSession(entry.staff, entry.authTime);
  }

  /** Our own session token. Renewable until SESSION_MAX_HOURS after the original sign-in. */
  async issueSession(staff: Staff, authTime = Date.now()) {
    const now = Date.now();
    const maxEnd = authTime + this.cfg.sessionMaxHours * 3600_000;
    const exp = Math.min(now + this.cfg.sessionHours * 3600_000, maxEnd);
    if (exp <= now) throw new ApiError('UNAUTHORISED', 'Session has reached its maximum age; sign in again');
    const token = await new SignJWT({ name: staff.name, adm: staff.isAdmin, auth_time: Math.floor(authTime / 1000) })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(SESSION_ISS)
      .setAudience(SESSION_AUD)
      .setSubject(staff.sub)
      .setIssuedAt()
      .setExpirationTime(Math.floor(exp / 1000))
      .sign(this.sessionKey);
    return { token, expiresAt: new Date(exp).toISOString(), user: { id: staff.sub, name: staff.name, isAdmin: staff.isAdmin } };
  }

  async verifySession(token: string): Promise<Staff & { authTime: number }> {
    try {
      const { payload } = await jwtVerify(token, this.sessionKey, { algorithms: ['HS256'], issuer: SESSION_ISS, audience: SESSION_AUD });
      if (typeof payload.sub !== 'string') throw new Error('no sub');
      const sub = payload.sub;
      // Re-check the admin list each request so removing someone from ADMIN_EMAILS takes effect immediately.
      const isAdmin = payload.adm === true && this.cfg.adminEmails.includes(sub);
      return { sub, name: String(payload.name ?? sub), isAdmin, authTime: Number(payload.auth_time ?? 0) * 1000 };
    } catch {
      throw new ApiError('UNAUTHORISED', 'Invalid or expired session');
    }
  }

  /** Used by the request guards. */
  async verify(token: string): Promise<Staff> {
    const { authTime: _a, ...staff } = await this.verifySession(token);
    return staff;
  }
}
