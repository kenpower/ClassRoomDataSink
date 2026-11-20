import { inject } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet, type JWTVerifyGetKey } from 'jose';
import mysql from 'mysql2/promise';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { buildApp, type BuildOptions } from '../src/app.js';
import { createPool } from '../src/db.js';

export const ISSUER = 'https://idp.test';
export const AUDIENCE = 'roomsink';

export async function makeIdp() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' };
  const keyGetter: JWTVerifyGetKey = createLocalJWKSet({ keys: [jwk] });
  const sign = (sub: string, roles: string[] = ['roomsink-staff'], opts: { exp?: string; iss?: string; aud?: string } = {}) =>
    new SignJWT({ roles })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setSubject(sub)
      .setIssuer(opts.iss ?? ISSUER)
      .setAudience(opts.aud ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? '10m')
      .sign(privateKey);
  return { keyGetter, sign };
}

export function testConfig(extra: Record<string, string> = {}) {
  const db = inject('db');
  return loadConfig({
    NODE_ENV: 'test',
    DB_HOST: db.host,
    DB_PORT: String(db.port),
    DB_USER: db.user,
    DB_PASSWORD: db.password,
    DB_NAME: db.database,
    TOKEN_SECRET: 'test-secret-test-secret-test-secret-0123456789',
    AUTH_ISSUER: ISSUER,
    AUTH_AUDIENCE: AUDIENCE,
    CORS_CLIENT_ORIGINS: 'https://apps.example',
    ADMIN_ORIGIN: 'https://admin.example',
    LOG_LEVEL: 'silent',
    ...extra,
  });
}

let migrated = false;
export async function setupApp(opts: BuildOptions & { env?: Record<string, string> } = {}) {
  const cfg = testConfig(opts.env);
  if (!migrated) {
    await migrate(cfg.db);
    migrated = true;
  }
  const idp = await makeIdp();
  const db = createPool(cfg.db);
  const built = await buildApp(cfg, { logger: false, jwksKeyGetter: idp.keyGetter, db, ...opts });
  await built.app.ready();
  const staffToken = await idp.sign('staff-1');
  return {
    ...built,
    db,
    idp,
    staffToken,
    async close() {
      await built.close();
      await db.end();
    },
  };
}

export type TestApp = Awaited<ReturnType<typeof setupApp>>;

export async function createRoom(t: TestApp, body: Record<string, unknown> = {}, token = t.staffToken) {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/v1/admin/rooms',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      title: 'Test room',
      open: true,
      apps: [{ name: 'quiz', groups: { A: 1, B: 1 } }, { name: 'free', allowFreeText: true }],
      ...body,
    },
  });
  if (res.statusCode !== 201) throw new Error(`createRoom failed: ${res.statusCode} ${res.body}`);
  return res.json() as { code: string; presenterKey: string; room: Record<string, unknown> };
}

export async function join(t: TestApp, code: string, headers: Record<string, string> = {}) {
  const res = await t.app.inject({ method: 'POST', url: `/api/v1/rooms/${code}/join`, payload: {}, headers });
  if (res.statusCode !== 201) throw new Error(`join failed: ${res.statusCode} ${res.body}`);
  return res.json() as { token: string; cid: string; groups: Record<string, string>; expiresAt: string };
}

let keyN = 0;
export function send(t: TestApp, code: string, token: string, payload: unknown, opts: { key?: string; headers?: Record<string, string> } = {}) {
  return t.app.inject({
    method: 'POST',
    url: `/api/v1/rooms/${code}/events`,
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': opts.key ?? `k-${Date.now()}-${keyN++}`, ...opts.headers },
    payload: payload as Record<string, unknown>,
  });
}

/** Raw root connection for poking at the DB in tests. */
export async function rawConn() {
  const db = inject('db');
  return mysql.createConnection({ ...db, timezone: 'Z' });
}
