import mysql, { type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise';
import type { AppConfig } from './config.js';

export type Db = Pool;
export type Conn = PoolConnection;
export type Row = RowDataPacket;

export function createPool(cfg: AppConfig['db']): Pool {
  return mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    connectionLimit: cfg.poolSize,
    waitForConnections: true,
    queueLimit: 500,
    enableKeepAlive: true,
    charset: 'utf8mb4',
    timezone: 'Z',
    dateStrings: false,
    // JSON columns come back parsed; BIGINTs as numbers (seq never exceeds 2^53).
    supportBigNumbers: true,
    bigNumberStrings: false,
    multipleStatements: false,
  });
}

/** Run fn in a transaction, committing on success and rolling back on any throw. */
export async function tx<T>(pool: Pool, fn: (c: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      /* connection may be dead */
    }
    throw err;
  } finally {
    conn.release();
  }
}

export function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ER_DUP_ENTRY';
}

export function isDeadlock(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;
  return code === 'ER_LOCK_DEADLOCK' || code === 'ER_LOCK_WAIT_TIMEOUT';
}
