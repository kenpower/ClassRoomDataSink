import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface JoinTokenPayload {
  v: 1;
  kid: string;
  room: string;
  cid: string;
  iat: number; // seconds
  exp: number; // seconds
}

export const JOIN_TOKEN_MAX_AGE_S = 12 * 60 * 60;

function sign(secret: string, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest();
}

/** Issue `base64url(json).base64url(hmac)`; exp is the earlier of room expiry and 12 h after issue. */
export function issueJoinToken(
  keys: { secret: string; kid: string },
  room: string,
  cid: string,
  roomExpiresAt: Date,
  now = Date.now(),
): { token: string; payload: JoinTokenPayload } {
  const iat = Math.floor(now / 1000);
  const exp = Math.min(Math.floor(roomExpiresAt.getTime() / 1000), iat + JOIN_TOKEN_MAX_AGE_S);
  const payload: JoinTokenPayload = { v: 1, kid: keys.kid, room, cid, iat, exp };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { token: `${body}.${sign(keys.secret, body).toString('base64url')}`, payload };
}

/** Returns the payload when the signature, kid, room and expiry are all valid; otherwise null. */
export function verifyJoinToken(
  keys: { secret: string; kid: string },
  token: unknown,
  room: string,
  now = Date.now(),
): JoinTokenPayload | null {
  if (typeof token !== 'string' || token.length > 512) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(sig)) return null;
  const expected = sign(keys.secret, body);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: JoinTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (
    !payload ||
    payload.v !== 1 ||
    payload.kid !== keys.kid ||
    payload.room !== room ||
    typeof payload.cid !== 'string' ||
    !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(payload.cid) ||
    typeof payload.exp !== 'number' ||
    typeof payload.iat !== 'number'
  )
    return null;
  if (payload.exp * 1000 <= now) return null;
  return payload;
}

export function sha256Hex(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

/** A random 32-byte presenter key and the SHA-256 hash that is stored. */
export function newPresenterKey(): { key: string; hash: string } {
  const key = randomBytes(32).toString('base64url');
  return { key, hash: sha256Hex(key) };
}

export function presenterKeyMatches(given: unknown, storedHash: string | null | undefined): boolean {
  if (typeof given !== 'string' || !storedHash || given.length > 128) return false;
  const a = Buffer.from(sha256Hex(given), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 32 random bytes → 43 base64url characters, matching ws_tickets.ticket CHAR(43). */
export function newTicket(): string {
  return randomBytes(32).toString('base64url');
}
