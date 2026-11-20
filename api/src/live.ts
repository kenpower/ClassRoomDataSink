/**
 * In-memory WebSocket fan-out. Events are buffered per room and flushed every 250 ms.
 * Behind an interface so a Redis pub/sub implementation can be swapped in for multiple instances.
 */
export interface LiveEvent {
  id: string;
  seq: number;
  app: string;
  cid: string;
  group: string | null;
  t: string;
  clientT: number | null;
  appVersion: string | null;
  data: unknown;
}

export interface Subscriber {
  app?: string;
  send(msg: string): void;
  /** Bytes queued but not yet sent; slow consumers are dropped. */
  buffered(): number;
  close(code: number, reason: string): void;
}

export interface LiveBus {
  subscribe(room: string, sub: Subscriber): () => void;
  publishEvents(room: string, events: LiveEvent[]): void;
  publishDeleted(room: string, info: { cid?: string; app?: string; all?: boolean }): void;
  publishRoom(room: string, info: Record<string, unknown>): void;
  closeRoom(room: string): void;
  connectionCount(): number;
  stop(): void;
}

const MAX_BUFFERED = 1024 * 1024;

export class MemoryLiveBus implements LiveBus {
  private rooms = new Map<string, Set<Subscriber>>();
  private pending = new Map<string, LiveEvent[]>();
  private flushTimer: NodeJS.Timeout;
  private pingTimer: NodeJS.Timeout;

  constructor(flushMs = 250, pingMs = 25_000) {
    this.flushTimer = setInterval(() => this.flush(), flushMs);
    this.pingTimer = setInterval(() => this.broadcastAll(JSON.stringify({ type: 'ping', t: Date.now() })), pingMs);
    this.flushTimer.unref();
    this.pingTimer.unref();
  }

  subscribe(room: string, sub: Subscriber) {
    let set = this.rooms.get(room);
    if (!set) this.rooms.set(room, (set = new Set()));
    set.add(sub);
    return () => {
      set!.delete(sub);
      if (set!.size === 0) this.rooms.delete(room);
    };
  }

  publishEvents(room: string, events: LiveEvent[]) {
    if (!this.rooms.has(room)) return;
    const list = this.pending.get(room);
    if (list) list.push(...events);
    else this.pending.set(room, [...events]);
  }

  publishDeleted(room: string, info: { cid?: string; app?: string; all?: boolean }) {
    this.flushRoom(room);
    this.send(room, JSON.stringify({ type: 'deleted', ...info }), info.app);
  }

  publishRoom(room: string, info: Record<string, unknown>) {
    this.send(room, JSON.stringify({ type: 'room', room: info }));
  }

  closeRoom(room: string) {
    const set = this.rooms.get(room);
    if (!set) return;
    for (const s of set) s.close(4404, 'room deleted');
    this.rooms.delete(room);
    this.pending.delete(room);
  }

  connectionCount() {
    let n = 0;
    for (const s of this.rooms.values()) n += s.size;
    return n;
  }

  flush() {
    for (const room of [...this.pending.keys()]) this.flushRoom(room);
  }

  private flushRoom(room: string) {
    const events = this.pending.get(room);
    this.pending.delete(room);
    const set = this.rooms.get(room);
    if (!events?.length || !set) return;
    const all = JSON.stringify({ type: 'events', events });
    const byApp = new Map<string, string>();
    for (const s of set) {
      if (!s.app) {
        this.safeSend(s, all);
        continue;
      }
      let msg = byApp.get(s.app);
      if (msg === undefined) {
        const filtered = events.filter((e) => e.app === s.app);
        msg = filtered.length ? JSON.stringify({ type: 'events', events: filtered }) : '';
        byApp.set(s.app, msg);
      }
      if (msg) this.safeSend(s, msg);
    }
  }

  private send(room: string, msg: string, app?: string) {
    const set = this.rooms.get(room);
    if (!set) return;
    for (const s of set) if (!app || !s.app || s.app === app) this.safeSend(s, msg);
  }

  private broadcastAll(msg: string) {
    for (const set of this.rooms.values()) for (const s of set) this.safeSend(s, msg);
  }

  private safeSend(s: Subscriber, msg: string) {
    if (s.buffered() > MAX_BUFFERED) {
      s.close(4429, 'consumer too slow');
      return;
    }
    try {
      s.send(msg);
    } catch {
      /* socket closing */
    }
  }

  stop() {
    clearInterval(this.flushTimer);
    clearInterval(this.pingTimer);
  }
}
