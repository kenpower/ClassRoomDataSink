import { api, type Event, type LiveMessage } from './api';

type RoomInfo = Extract<LiveMessage, { type: 'room' }>['room'];

/**
 * Live connection to /rooms/:code/live. Gets a fresh single-use ticket for every (re)connect and resumes
 * from the last seq seen, de-duplicating events by seq.
 */
export class LiveRoom {
  connected = $state(false);
  room = $state<RoomInfo | null>(null);
  recent = $state<Event[]>([]);
  lastSeq = 0;
  private ws: WebSocket | null = null;
  private stopped = false;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly code: string,
    readonly keep = 100,
  ) {}

  start() {
    this.stopped = false;
    void this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }

  private async connect() {
    if (this.stopped) return;
    try {
      const { ticket } = await api.liveTicket(this.code);
      // Only ask for a small backlog on first connect; the table shows recent events.
      const since = this.lastSeq || Math.max(0, (this.room?.eventCount ?? 0) - this.keep);
      const ws = new WebSocket(api.liveUrl(this.code, ticket, { since }));
      this.ws = ws;
      ws.onopen = () => {
        this.connected = true;
        this.retry = 0;
      };
      ws.onmessage = (m) => this.onMessage(JSON.parse(String(m.data)) as LiveMessage);
      ws.onclose = (e) => {
        this.connected = false;
        if (e.code === 4404) return; // room deleted
        this.scheduleReconnect();
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    const delay = Math.min(15_000, 500 * 2 ** this.retry++) * (0.5 + Math.random() / 2);
    this.timer = setTimeout(() => void this.connect(), delay);
  }

  private onMessage(msg: LiveMessage) {
    if (msg.type === 'room') this.room = msg.room;
    else if (msg.type === 'events') {
      const fresh = msg.events.filter((e) => e.seq > this.lastSeq);
      if (!fresh.length) return;
      this.lastSeq = fresh[fresh.length - 1]!.seq;
      this.recent = [...fresh.reverse(), ...this.recent].slice(0, this.keep);
      if (this.room && !msg.backlog) this.room = { ...this.room, eventCount: (this.room.eventCount ?? 0) + fresh.length };
    } else if (msg.type === 'deleted') {
      if (msg.all) this.recent = [];
      else if (msg.app) this.recent = this.recent.filter((e) => e.app !== msg.app);
      else if (msg.cid) this.recent = this.recent.filter((e) => e.cid !== msg.cid);
    }
  }
}
