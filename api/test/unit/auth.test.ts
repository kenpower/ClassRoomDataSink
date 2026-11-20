import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { StaffAuth } from '../../src/auth.js';
import { loadConfig } from '../../src/config.js';

const STARS = 'stars-shared-secret-for-tests-0123456789';
const cfg = loadConfig({
  AUTH_JWT_SECRET: STARS,
  STAFF_EMAIL_DOMAINS: 'setu.ie',
  STAFF_EMAILS: 'guest@outlook.com',
  ADMIN_EMAILS: 'boss@gmail.com',
  TOKEN_SECRET: 'x'.repeat(40),
});
const auth = () => new StaffAuth(cfg.auth, cfg.token.secret);
const stars = (claims: Record<string, unknown>, secret = STARS, alg = 'HS256') =>
  new SignJWT(claims).setProtectedHeader({ alg }).sign(new TextEncoder().encode(secret));

describe('STARS sign-in', () => {
  it('verifies HS256 tokens without exp and reads identity', async () => {
    const id = await auth().verifyStarsToken(await stars({ user_id: 'A.Teacher@setu.ie', email: 'A.Teacher@setu.ie', display_name: 'A Teacher', auth_provider: 'microsoft' }));
    expect(id).toMatchObject({ id: 'a.teacher@setu.ie', name: 'A Teacher', provider: 'microsoft' });
  });
  it('falls back to user_id when mail is missing', async () => {
    const id = await auth().verifyStarsToken(await stars({ user_id: 'x@setu.ie', email: null }));
    expect(id.id).toBe('x@setu.ie');
  });
  it('rejects wrong secret, other algorithms and expired tokens', async () => {
    await expect(auth().verifyStarsToken(await stars({ email: 'a@setu.ie' }, 'wrong-secret-wrong-secret-wrong'))).rejects.toThrow();
    await expect(auth().verifyStarsToken(await stars({ email: 'a@setu.ie' }, STARS + STARS, 'HS512'))).rejects.toThrow();
    await expect(auth().verifyStarsToken(await stars({ email: 'a@setu.ie', exp: 1000 }))).rejects.toThrow();
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"email":"a@setu.ie"}').toString('base64url')}.`;
    await expect(auth().verifyStarsToken(none)).rejects.toThrow();
  });
  it('authorises by domain, staff list and admin list (any domain)', () => {
    const a = auth();
    const who = (email: string) => ({ id: email, email, name: email, provider: 'google' });
    expect(a.authorise(who('t@setu.ie')).isAdmin).toBe(false);
    expect(a.authorise(who('t@dept.setu.ie')).sub).toBe('t@dept.setu.ie');
    expect(a.authorise(who('guest@outlook.com')).isAdmin).toBe(false);
    expect(a.authorise(who('boss@gmail.com')).isAdmin).toBe(true);
    expect(() => a.authorise(who('random@gmail.com'))).toThrow(/not authorised/);
    expect(() => a.authorise(who('t@evilsetu.ie'))).toThrow();
    expect(() => a.authorise(who('t@setu.ie.evil.com'))).toThrow();
  });
});

describe('RoomSink sessions', () => {
  it('issues, verifies and refreshes sessions; codes are single use', async () => {
    const a = auth();
    const code = a.createLoginCode({ sub: 'boss@gmail.com', name: 'Boss', isAdmin: true });
    const s = await a.redeemLoginCode(code);
    await expect(a.redeemLoginCode(code)).rejects.toThrow();
    const staff = await a.verify(s.token);
    expect(staff).toEqual({ sub: 'boss@gmail.com', name: 'Boss', isAdmin: true });
  });
  it('caps renewals at SESSION_MAX_HOURS after sign-in', async () => {
    const a = auth();
    await expect(a.issueSession({ sub: 'x@setu.ie', name: 'x', isAdmin: false }, Date.now() - 13 * 3600_000)).rejects.toThrow(/maximum age/);
  });
  it('rejects STARS tokens used as sessions and admin claims for non-listed users', async () => {
    const a = auth();
    await expect(a.verify(await stars({ email: 'boss@gmail.com' }))).rejects.toThrow();
    const s = await a.issueSession({ sub: 't@setu.ie', name: 't', isAdmin: true });
    expect((await a.verify(s.token)).isAdmin).toBe(false);
  });
});
