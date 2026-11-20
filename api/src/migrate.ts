import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { loadConfig, type AppConfig } from './config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, '..', 'migrations');

/**
 * Apply versioned SQL files (NNN_name.sql) in order, once each, using the DDL-capable migration user.
 * A named lock keeps concurrent starters from racing.
 */
export async function migrate(cfg: AppConfig['db'], log: (msg: string) => void = () => {}, dir = MIGRATIONS_DIR) {
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.migrateUser,
    password: cfg.migratePassword,
    database: cfg.database,
    multipleStatements: true,
    charset: 'utf8mb4',
  });
  try {
    const [lockRows] = await conn.query<mysql.RowDataPacket[]>("SELECT GET_LOCK('roomsink_migrate', 60) AS l");
    if (lockRows[0]?.l !== 1) throw new Error('Could not obtain migration lock');
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(100) NOT NULL PRIMARY KEY,
      applied_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    const [done] = await conn.query<mysql.RowDataPacket[]>('SELECT version FROM schema_migrations');
    const applied = new Set(done.map((r) => r.version as string));
    const files = (await readdir(dir)).filter((f) => /^\d+_[\w-]+\.sql$/.test(f)).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      log(`applying migration ${file}`);
      // MySQL DDL auto-commits, so each file should be written to be safe to re-run if it fails part-way.
      await conn.query(sql);
      await conn.query('INSERT INTO schema_migrations (version, applied_at) VALUES (?, UTC_TIMESTAMP(3))', [file]);
    }
    await conn.query("SELECT RELEASE_LOCK('roomsink_migrate')");
  } finally {
    await conn.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const cfg = loadConfig();
  migrate(cfg.db, (m) => console.log(JSON.stringify({ level: 'info', msg: m })))
    .then(() => console.log(JSON.stringify({ level: 'info', msg: 'migrations complete' })))
    .catch((err) => {
      console.error(JSON.stringify({ level: 'error', msg: 'migration failed', err: String(err) }));
      process.exit(1);
    });
}
