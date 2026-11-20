import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from './config.js';
import { ApiError } from './errors.js';

export interface Staff {
  sub: string;
  isAdmin: boolean;
}

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

export function extractRoles(payload: JWTPayload, claim: string): string[] {
  const v = getPath(payload, claim);
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') return v.split(/[\s,]+/).filter(Boolean);
  return [];
}

export function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  const m = /^Bearer\s+(\S{1,8192})$/i.exec(h);
  return m?.[1];
}

export class StaffAuth {
  private readonly jwks?: JWTVerifyGetKey;
  constructor(
    private readonly cfg: AppConfig['auth'],
    keyGetter?: JWTVerifyGetKey,
  ) {
    this.jwks = keyGetter ?? (cfg.jwksUrl ? createRemoteJWKSet(new URL(cfg.jwksUrl), { cooldownDuration: 30_000 }) : undefined);
  }

  /** Verify a staff JWT (signature via JWKS, iss, aud, exp) and require STAFF_ROLE or ADMIN_ROLE. */
  async verify(token: string): Promise<Staff> {
    if (!this.jwks) throw new ApiError('UNAUTHORISED', 'Staff authentication is not configured');
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        issuer: this.cfg.issuer,
        audience: this.cfg.audience,
        requiredClaims: ['sub', 'exp'],
        clockTolerance: 30,
      }));
    } catch {
      throw new ApiError('UNAUTHORISED', 'Invalid or expired staff token');
    }
    const roles = extractRoles(payload, this.cfg.rolesClaim);
    const isAdmin = roles.includes(this.cfg.adminRole);
    if (!isAdmin && !roles.includes(this.cfg.staffRole)) throw new ApiError('FORBIDDEN', 'Staff role required');
    return { sub: String(payload.sub), isAdmin };
  }

  /** Looks like a JWT (three dot-separated parts) rather than a join token. */
  static looksLikeJwt(token: string) {
    return token.split('.').length === 3;
  }
}
