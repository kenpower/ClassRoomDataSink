import { goto } from '$app/navigation';
import { base } from '$app/paths';
import { API_URL } from './config';
import type { components } from './api-types';

type Session = components['schemas']['Session'];
type User = components['schemas']['User'];

/**
 * Staff session, kept in memory only (never localStorage). Sign-in goes through the API, which redirects to
 * the STARS auth service and back; the API then hands us a one-time code in the URL fragment.
 * Reloading the page re-runs sign-in, which STARS skips when its own session is still valid.
 */
class Auth {
  token = $state<string | null>(null);
  user = $state<User | null>(null);
  expiresAt = $state<number>(0);
  error = $state<string | null>(null);
  private timer: ReturnType<typeof setTimeout> | undefined;

  get signedIn() {
    return !!this.token;
  }

  /** Full-page navigation to the API login endpoint. */
  login(returnTo = location.pathname + location.search) {
    const ret = returnTo.startsWith(`${base}/`) && !returnTo.startsWith(`${base}/auth`) ? returnTo : `${base}/`;
    location.assign(`${API_URL}/api/v1/auth/login?return=${encodeURIComponent(ret)}`);
  }

  logout() {
    this.clear();
    location.assign(`${API_URL}/api/v1/auth/logout`);
  }

  clear() {
    clearTimeout(this.timer);
    this.token = null;
    this.user = null;
  }

  /** Called on /admin/auth with the fragment from the API callback. */
  async completeLogin(fragment: string) {
    const p = new URLSearchParams(fragment.replace(/^#/, ''));
    // Remove the code from the address bar and history straight away.
    history.replaceState(history.state, '', `${base}/auth`);
    const err = p.get('error');
    if (err) {
      this.error =
        err === 'not_staff'
          ? 'Your account is signed in but is not authorised as staff for RoomSink. Ask an administrator to add you.'
          : 'Sign-in failed. Please try again.';
      return;
    }
    const code = p.get('code');
    if (!code) {
      this.error = 'Missing sign-in code.';
      return;
    }
    const res = await fetch(`${API_URL}/api/v1/auth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      credentials: 'omit',
    });
    if (!res.ok) {
      this.error = 'Sign-in code expired. Please sign in again.';
      return;
    }
    this.apply(await res.json());
    const ret = p.get('return') ?? `${base}/`;
    await goto(ret.startsWith(`${base}/`) ? ret : `${base}/`, { replaceState: true });
  }

  /** Test hook / manual use: adopt a session directly. */
  apply(s: Session) {
    this.token = s.token;
    this.user = s.user;
    this.expiresAt = new Date(s.expiresAt).getTime();
    this.error = null;
    this.schedule();
  }

  /** Silent renewal 5 minutes before expiry; falls back to a full sign-in when the max session age is reached. */
  private schedule() {
    clearTimeout(this.timer);
    const delay = Math.max(10_000, this.expiresAt - Date.now() - 5 * 60_000);
    this.timer = setTimeout(() => void this.refresh(), Math.min(delay, 2 ** 31 - 1));
  }

  async refresh() {
    if (!this.token) return;
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/refresh`, { method: 'POST', headers: { Authorization: `Bearer ${this.token}` }, credentials: 'omit' });
      if (!res.ok) throw new Error(String(res.status));
      this.apply(await res.json());
    } catch {
      if (Date.now() < this.expiresAt) {
        this.timer = setTimeout(() => void this.refresh(), 60_000);
      } else {
        this.clear();
        this.login();
      }
    }
  }
}

export const auth = new Auth();
