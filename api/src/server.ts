import { loadConfig } from './config.js';
import { migrate } from './migrate.js';
import { buildApp } from './app.js';

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, time: Date.now(), msg, ...extra }));

async function main() {
  const cfg = loadConfig();
  if (cfg.token.ephemeral) log('warn', 'TOKEN_SECRET not set: using a random secret; join tokens will not survive a restart');
  if (cfg.runMigrations) {
    // The database may still be starting; retry for up to ~60 s.
    for (let i = 0; ; i++) {
      try {
        await migrate(cfg.db, (m) => log('info', m));
        break;
      } catch (err) {
        if (i >= 30) throw err;
        log('warn', 'migration attempt failed, retrying', { err: String((err as Error).message) });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
  const { app, close } = await buildApp(cfg, { startCleanup: true });
  await app.listen({ port: cfg.port, host: cfg.host });
  const shutdown = async (sig: string) => {
    log('info', `received ${sig}, shutting down`);
    const t = setTimeout(() => process.exit(1), 10_000);
    t.unref();
    await close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log('error', 'fatal', { err: String(err?.stack ?? err) });
  process.exit(1);
});
