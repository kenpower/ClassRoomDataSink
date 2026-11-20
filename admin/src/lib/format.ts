export function relTime(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  const abs = Math.abs(ms);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 60_000) return rtf.format(Math.round(ms / 1000), 'second');
  if (abs < 3600_000) return rtf.format(Math.round(ms / 60_000), 'minute');
  if (abs < 86400_000) return rtf.format(Math.round(ms / 3600_000), 'hour');
  return rtf.format(Math.round(ms / 86400_000), 'day');
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** For <input type="datetime-local"> */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(v: string): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export const PRIVACY_NOTICE = `This activity collects your answers anonymously for teaching. No name, email or IP address is stored — only a random ID for this device. Data is deleted automatically after the session (within 24 hours of closing). You can delete your data at any time using the "Delete my data" button.`;
