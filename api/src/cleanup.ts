import type { ResultSetHeader } from 'mysql2/promise';
import type { Db, Row } from './db.js';
import type { Store } from './store.js';
import type { LiveBus } from './live.js';
import { RETIRED_CODE_DAYS } from './store.js';

export interface CleanupResult {
  ran: boolean;
  closed: number;
  deleted: number;
  idempotency: number;
  tickets: number;
}

/**
 * MySQL has no TTL, so this job does all expiry. A named lock makes sure only one copy runs at a time,
 * even if more than one API instance is started.
 */
export async function runCleanup(db: Db, store: Store, live?: LiveBus, now = new Date()): Promise<CleanupResult> {
  const conn = await db.getConnection();
  const res: CleanupResult = { ran: false, closed: 0, deleted: 0, idempotency: 0, tickets: 0 };
  try {
    const [lock] = await conn.query<Row[]>("SELECT GET_LOCK('roomsink_cleanup', 0) AS l");
    if (lock[0]?.l !== 1) return res;
    res.ran = true;
    try {
      // 1. Close rooms past closes_at.
      const [toClose] = await conn.query<Row[]>("SELECT code FROM rooms WHERE status = 'open' AND closes_at <= ? LIMIT 10000", [now]);
      if (toClose.length) {
        const codes = toClose.map((r) => r.code as string);
        const [r] = await conn.query<ResultSetHeader>("UPDATE rooms SET status = 'closed' WHERE status = 'open' AND closes_at <= ? AND code IN (?)", [now, codes]);
        res.closed = r.affectedRows;
        for (const c of codes) {
          store.cache.delete(c);
          live?.publishRoom(c, { code: c, status: 'closed' });
        }
      }
      // 2. Delete expired rooms in batches; FK cascades remove apps, clients and events. Retire codes first.
      for (;;) {
        const [expired] = await conn.query<Row[]>('SELECT code FROM rooms WHERE expires_at <= ? ORDER BY expires_at LIMIT 1000', [now]);
        if (!expired.length) break;
        const codes = expired.map((r) => r.code as string);
        await conn.beginTransaction();
        try {
          await conn.query('INSERT INTO retired_codes (code, retired_at) VALUES ? ON DUPLICATE KEY UPDATE retired_at = VALUES(retired_at)', [
            codes.map((c) => [c, now]),
          ]);
          await conn.query('DELETE FROM idempotency WHERE room IN (?)', [codes]);
          await conn.query('DELETE FROM ws_tickets WHERE room IN (?)', [codes]);
          const [d] = await conn.query<ResultSetHeader>('DELETE FROM rooms WHERE code IN (?) AND expires_at <= ?', [codes, now]);
          await conn.commit();
          res.deleted += d.affectedRows;
        } catch (err) {
          await conn.rollback();
          throw err;
        }
        for (const c of codes) {
          store.cache.delete(c);
          live?.closeRoom(c);
        }
        if (expired.length < 1000) break;
      }
      // 3. Idempotency rows older than 10 minutes and expired tickets.
      const [i] = await conn.query<ResultSetHeader>('DELETE FROM idempotency WHERE created_at < ? - INTERVAL 10 MINUTE LIMIT 50000', [now]);
      res.idempotency = i.affectedRows;
      const [t] = await conn.query<ResultSetHeader>('DELETE FROM ws_tickets WHERE expires_at <= ?', [now]);
      res.tickets = t.affectedRows;
      // 4. Codes become reusable after 30 days.
      await conn.query('DELETE FROM retired_codes WHERE retired_at < ? - INTERVAL ? DAY', [now, RETIRED_CODE_DAYS]);
    } finally {
      await conn.query("SELECT RELEASE_LOCK('roomsink_cleanup')");
    }
    return res;
  } finally {
    conn.release();
  }
}
