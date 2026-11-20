import { randomInt } from 'node:crypto';

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

export function randomRoomCode(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

/** Normalise user input (case, stray whitespace); returns null when it can't be a room code. */
export function normaliseCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const c = input.trim().toUpperCase();
  return CODE_RE.test(c) ? c : null;
}

export const APP_NAME_RE = /^[a-z0-9-]{1,40}$/;

/** Weighted choice from {group: weight}. Non-positive weights are ignored. */
export function pickWeighted(groups: Record<string, number>, rnd: () => number = () => randomInt(1_000_000) / 1_000_000): string | null {
  const entries = Object.entries(groups).filter(([, w]) => typeof w === 'number' && Number.isFinite(w) && w > 0);
  if (!entries.length) return null;
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rnd() * total;
  for (const [name, w] of entries) {
    if (r < w) return name;
    r -= w;
  }
  return entries[entries.length - 1]![0];
}
