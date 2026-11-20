import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/** Read `NAME` or, if `NAME_FILE` is set, the trimmed contents of that file (Docker secrets). */
function fromEnvOrFile(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim();
  return env[name];
}

const csv = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const schema = z.object({
  NODE_ENV: z.string().default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  DB_HOST: z.string().default('db'),
  DB_PORT: z.coerce.number().int().default(3306),
  DB_NAME: z.string().default('roomsink'),
  DB_USER: z.string().default('roomsink'),
  DB_PASSWORD: z.string().default(''),
  DB_MIGRATE_USER: z.string().optional(),
  DB_MIGRATE_PASSWORD: z.string().optional(),
  DB_POOL_SIZE: z.coerce.number().int().min(1).max(200).default(20),
  TOKEN_SECRET: z.string().optional(),
  TOKEN_KID: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).default('k1'),
  AUTH_BASE_URL: z.string().url().default('https://compucore2.setu.ie/auth'),
  AUTH_JWT_SECRET: z.string().optional(),
  AUTH_PROVIDERS: z.string().default('microsoft,google'),
  AUTH_TOKEN_MAX_AGE_S: z.coerce.number().int().min(0).default(0),
  STAFF_EMAIL_DOMAINS: z.string().default(''),
  STAFF_EMAILS: z.string().default(''),
  ADMIN_EMAILS: z.string().default(''),
  SESSION_HOURS: z.coerce.number().min(0.1).max(24).default(8),
  SESSION_MAX_HOURS: z.coerce.number().min(0.1).max(72).default(12),
  PUBLIC_API_URL: z.string().url().optional(),
  ADMIN_URL: z.string().url().optional(),
  CORS_CLIENT_ORIGINS: z.string().default(''),
  ADMIN_ORIGIN: z.string().default(''),
  IP_ALLOWLIST: z.string().default(''),
  TRUST_PROXY_CIDRS: z.string().default(''),
  MEMORY_LIMIT_MB: z.coerce.number().int().min(64).default(400),
  CLEANUP_INTERVAL_MS: z.coerce.number().int().min(1000).default(5 * 60 * 1000),
  RUN_MIGRATIONS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  SDK_PATH: z.string().optional(),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const merged = {
    ...env,
    DB_PASSWORD: fromEnvOrFile(env, 'DB_PASSWORD'),
    DB_MIGRATE_PASSWORD: fromEnvOrFile(env, 'DB_MIGRATE_PASSWORD'),
    TOKEN_SECRET: fromEnvOrFile(env, 'TOKEN_SECRET'),
    AUTH_JWT_SECRET: fromEnvOrFile(env, 'AUTH_JWT_SECRET'),
  };
  const parsed = schema.safeParse(merged);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const c = parsed.data;
  let tokenSecretEphemeral = false;
  let tokenSecret = c.TOKEN_SECRET;
  if (!tokenSecret) {
    tokenSecret = randomBytes(32).toString('base64url');
    tokenSecretEphemeral = true;
  } else if (Buffer.byteLength(tokenSecret) < 32) {
    throw new Error('Invalid configuration: TOKEN_SECRET must be at least 32 bytes');
  }
  return {
    env: c.NODE_ENV,
    port: c.PORT,
    host: c.HOST,
    logLevel: c.LOG_LEVEL,
    db: {
      host: c.DB_HOST,
      port: c.DB_PORT,
      database: c.DB_NAME,
      user: c.DB_USER,
      password: c.DB_PASSWORD ?? '',
      migrateUser: c.DB_MIGRATE_USER ?? c.DB_USER,
      migratePassword: c.DB_MIGRATE_PASSWORD ?? c.DB_PASSWORD ?? '',
      poolSize: c.DB_POOL_SIZE,
    },
    token: { secret: tokenSecret, kid: c.TOKEN_KID, ephemeral: tokenSecretEphemeral },
    auth: {
      baseUrl: c.AUTH_BASE_URL.replace(/\/+$/, ''),
      jwtSecret: c.AUTH_JWT_SECRET,
      providers: c.AUTH_PROVIDERS,
      tokenMaxAgeS: c.AUTH_TOKEN_MAX_AGE_S,
      staffDomains: csv(c.STAFF_EMAIL_DOMAINS).map((d) => d.toLowerCase().replace(/^@/, '')),
      staffEmails: csv(c.STAFF_EMAILS).map((e) => e.toLowerCase()),
      adminEmails: csv(c.ADMIN_EMAILS).map((e) => e.toLowerCase()),
      sessionHours: c.SESSION_HOURS,
      sessionMaxHours: c.SESSION_MAX_HOURS,
    },
    publicApiUrl: c.PUBLIC_API_URL?.replace(/\/+$/, ''),
    adminUrl: (c.ADMIN_URL ?? (c.ADMIN_ORIGIN ? `${c.ADMIN_ORIGIN.replace(/\/+$/, '')}/admin/` : '/admin/')).replace(/\/*$/, '/'),
    cors: { clientOrigins: csv(c.CORS_CLIENT_ORIGINS), adminOrigin: c.ADMIN_ORIGIN || undefined },
    ipAllowlist: csv(c.IP_ALLOWLIST),
    trustProxyCidrs: csv(c.TRUST_PROXY_CIDRS),
    memoryLimitMb: c.MEMORY_LIMIT_MB,
    cleanupIntervalMs: c.CLEANUP_INTERVAL_MS,
    runMigrations: c.RUN_MIGRATIONS,
    sdkPath: c.SDK_PATH,
  };
}
