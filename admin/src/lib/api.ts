import { API_URL } from './config';
import { auth } from './auth.svelte';
import type { components } from './api-types';

export type Room = components['schemas']['Room'];
export type RoomSummary = components['schemas']['RoomSummary'];
export type RoomInput = components['schemas']['RoomInput'];
export type CreateRoomInput = components['schemas']['CreateRoomInput'];
export type CreatedRoom = components['schemas']['CreatedRoom'];
export type App = components['schemas']['App'];
export type AppInput = components['schemas']['AppInput'];
export type Event = components['schemas']['Event'];
export type Summary = components['schemas']['Summary'];
export type LiveMessage = components['schemas']['LiveMessage'];
export type ApiErrorBody = components['schemas']['Error'];

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_URL}/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'omit',
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const e = (json as ApiErrorBody | null)?.error;
    if (res.status === 401) {
      auth.clear();
      auth.login();
    }
    throw new ApiError(res.status, e?.code ?? 'HTTP', e?.message ?? res.statusText);
  }
  return json as T;
}

const enc = encodeURIComponent;

export const api = {
  listRooms: (all = false) => call<{ rooms: RoomSummary[] }>('GET', `/admin/rooms${all ? '?all=1' : ''}`),
  getRoom: (code: string) => call<Room>('GET', `/admin/rooms/${enc(code)}`),
  createRoom: (input: CreateRoomInput) => call<CreatedRoom>('POST', '/admin/rooms', input),
  patchRoom: (code: string, input: RoomInput) => call<Room>('PATCH', `/admin/rooms/${enc(code)}`, input),
  deleteRoom: (code: string) => call<void>('DELETE', `/admin/rooms/${enc(code)}`),
  openRoom: (code: string, closesAt?: string) => call<Room>('POST', `/admin/rooms/${enc(code)}/open`, closesAt ? { closesAt } : {}),
  closeRoom: (code: string) => call<Room>('POST', `/admin/rooms/${enc(code)}/close`),
  rotateKey: (code: string) => call<{ code: string; presenterKey: string }>('POST', `/admin/rooms/${enc(code)}/rotate-key`),
  cloneRoom: (code: string) => call<CreatedRoom>('POST', `/admin/rooms/${enc(code)}/clone`, {}),
  clearEvents: (code: string, app?: string) => call<{ deleted: number }>('DELETE', `/admin/rooms/${enc(code)}/events${app ? `?app=${enc(app)}` : ''}`),
  events: (code: string, opts: { app?: string; since?: number; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.app) q.set('app', opts.app);
    if (opts.since) q.set('since', String(opts.since));
    if (opts.limit) q.set('limit', String(opts.limit));
    return call<{ events: Event[]; nextSince: number; more: boolean }>('GET', `/rooms/${enc(code)}/events?${q}`);
  },
  summary: (code: string) => call<Summary>('GET', `/rooms/${enc(code)}/summary`),
  liveTicket: (code: string) => call<{ ticket: string; expiresIn: number }>('POST', `/rooms/${enc(code)}/live-ticket`),

  /** Exports need the Authorization header, so fetch then save the blob. */
  async download(code: string, format: 'csv' | 'json', app?: string) {
    const q = new URLSearchParams({ format });
    if (app) q.set('app', app);
    const res = await fetch(`${API_URL}/api/v1/rooms/${enc(code)}/export?${q}`, {
      headers: auth.token ? { Authorization: `Bearer ${auth.token}` } : {},
      credentials: 'omit',
    });
    if (!res.ok) throw new ApiError(res.status, 'EXPORT', 'Export failed');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `roomsink-${code}${app ? `-${app}` : ''}.${format}`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  },

  liveUrl(code: string, ticket: string, opts: { app?: string; since?: number }) {
    const base = API_URL || location.origin;
    const u = new URL(`${base}/api/v1/rooms/${enc(code)}/live`);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.searchParams.set('ticket', ticket);
    if (opts.app) u.searchParams.set('app', opts.app);
    if (opts.since) u.searchParams.set('since', String(opts.since));
    return u.toString();
  },
};
