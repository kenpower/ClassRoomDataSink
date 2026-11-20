import { describe, expect, it } from 'vitest';
import { issueJoinToken, verifyJoinToken, newPresenterKey, presenterKeyMatches, newTicket, JOIN_TOKEN_MAX_AGE_S } from '../../src/tokens.js';

const keys = { secret: 'a'.repeat(40), kid: 'k1' };
const cid = '01HZX3J8Q4M6N7P8R9S0T1V2W3';

describe('join tokens', () => {
  it('round-trips', () => {
    const { token, payload } = issueJoinToken(keys, 'ABCDEF', cid, new Date(Date.now() + 86400_000));
    expect(verifyJoinToken(keys, token, 'ABCDEF')).toEqual(payload);
    expect(payload).toMatchObject({ v: 1, kid: 'k1', room: 'ABCDEF', cid });
  });
  it('expires at the earlier of room expiry and 12 h', () => {
    const now = Date.now();
    const long = issueJoinToken(keys, 'ABCDEF', cid, new Date(now + 86400_000), now).payload;
    expect(long.exp - long.iat).toBe(JOIN_TOKEN_MAX_AGE_S);
    const short = issueJoinToken(keys, 'ABCDEF', cid, new Date(now + 3600_000), now).payload;
    expect(short.exp).toBe(Math.floor((now + 3600_000) / 1000));
  });
  it('rejects expired tokens', () => {
    const now = Date.now();
    const { token } = issueJoinToken(keys, 'ABCDEF', cid, new Date(now + 1000), now);
    expect(verifyJoinToken(keys, token, 'ABCDEF', now + 2000)).toBeNull();
  });
  it('rejects tokens for another room, kid or secret', () => {
    const { token } = issueJoinToken(keys, 'ABCDEF', cid, new Date(Date.now() + 86400_000));
    expect(verifyJoinToken(keys, token, 'ABCDEG')).toBeNull();
    expect(verifyJoinToken({ ...keys, kid: 'k2' }, token, 'ABCDEF')).toBeNull();
    expect(verifyJoinToken({ ...keys, secret: 'b'.repeat(40) }, token, 'ABCDEF')).toBeNull();
  });
  it('rejects forged or tampered tokens', () => {
    const { token } = issueJoinToken(keys, 'ABCDEF', cid, new Date(Date.now() + 86400_000));
    const [body, sig] = token.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), exp: 9e9 })).toString('base64url');
    expect(verifyJoinToken(keys, `${forged}.${sig}`, 'ABCDEF')).toBeNull();
    expect(verifyJoinToken(keys, `${body}.${sig.slice(0, -2)}AA`, 'ABCDEF')).toBeNull();
    expect(verifyJoinToken(keys, `${body}.`, 'ABCDEF')).toBeNull();
    for (const bad of [undefined, null, 42, '', 'a.b.c', 'x'.repeat(1000), '<>.<>']) expect(verifyJoinToken(keys, bad, 'ABCDEF')).toBeNull();
  });
});

describe('presenter keys and tickets', () => {
  it('stores only a hash and compares safely', () => {
    const { key, hash } = newPresenterKey();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(key);
    expect(presenterKeyMatches(key, hash)).toBe(true);
    expect(presenterKeyMatches(key + 'x', hash)).toBe(false);
    expect(presenterKeyMatches(key, null)).toBe(false);
    expect(presenterKeyMatches(undefined, hash)).toBe(false);
  });
  it('tickets are 43 base64url chars', () => {
    expect(newTicket()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
