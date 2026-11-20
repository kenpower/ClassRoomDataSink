<script lang="ts">
  import { page } from '$app/state';
  import { base } from '$app/paths';
  import { api, type Room } from '$lib/api';
  import { LiveRoom } from '$lib/live.svelte';
  import { DEFAULT_CLIENT_URL } from '$lib/config';
  import { bytes, dateTime, relTime, PRIVACY_NOTICE } from '$lib/format';
  import Qr from '$lib/components/Qr.svelte';
  import StatusBadge from '$lib/components/StatusBadge.svelte';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';

  const code = $derived(page.params.code ?? '');
  let room = $state<Room | null>(null);
  let error = $state('');
  let fullscreen = $state(false);
  let now = $state(Date.now());
  let presenterKey = $state<string | null>(null);
  let confirm = $state<{ title: string; message: string; label: string; run: () => Promise<unknown> } | null>(null);
  let confirmOpen = $state(false);
  let copied = $state('');

  const storageKey = (c: string) => `roomsink:clientUrl:${c}`;
  let clientUrl = $state('');
  const joinUrl = $derived.by(() => {
    const u = clientUrl.trim();
    if (!u) return '';
    try {
      const url = new URL(u);
      url.searchParams.set('r', code);
      return url.toString();
    } catch {
      return '';
    }
  });

  let live = $state<LiveRoom | null>(null);

  async function load() {
    try {
      room = await api.getRoom(code);
    } catch (e) {
      error = (e as Error).message;
    }
  }

  $effect(() => {
    const c = code;
    try {
      clientUrl = localStorage.getItem(storageKey(c)) ?? DEFAULT_CLIENT_URL;
    } catch {
      clientUrl = DEFAULT_CLIENT_URL;
    }
    void load();
    const l = new LiveRoom(c);
    live = l;
    l.start();
    const tick = setInterval(() => (now = Date.now()), 30_000);
    return () => {
      l.stop();
      clearInterval(tick);
    };
  });

  $effect(() => {
    try {
      if (clientUrl) localStorage.setItem(storageKey(code), clientUrl);
    } catch {
      /* private mode */
    }
  });

  // Keep app toggles and counters in sync with live room messages.
  $effect(() => {
    const info = live?.room;
    if (!info || !room) return;
    if (info.status && info.status !== room.status) void load();
  });

  const status = $derived(live?.room?.status ?? room?.status ?? 'draft');
  const expiresAt = $derived(live?.room?.expiresAt ?? room?.expiresAt ?? '');
  const expiringSoon = $derived(!!expiresAt && new Date(expiresAt).getTime() - now < 3600_000);
  const rejections = $derived(Object.entries(live?.room?.rejections ?? room?.rejections ?? {}));

  async function toggleApp(name: string, enabled: boolean) {
    if (!room) return;
    const apps = room.apps.map((a) => (a.name === name ? { ...a, enabled } : a));
    try {
      room = await api.patchRoom(code, { apps });
    } catch (e) {
      error = (e as Error).message;
    }
  }

  function ask(title: string, message: string, label: string, run: () => Promise<unknown>) {
    confirm = { title, message, label, run };
    confirmOpen = true;
  }

  async function copy(text: string, what: string) {
    await navigator.clipboard.writeText(text);
    copied = what;
    setTimeout(() => (copied = ''), 2000);
  }

  function preview(data: unknown): string {
    const s = JSON.stringify(data);
    return s.length > 120 ? s.slice(0, 117) + '…' : s;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && fullscreen) fullscreen = false;
  }
</script>

<svelte:window onkeydown={onKey} />

{#if fullscreen}
  <section class="present" aria-label="Join screen">
    <p class="present-title">{room?.title}</p>
    {#if joinUrl}<Qr text={joinUrl} size={560} label="QR code to join room {code}" />{/if}
    <p class="present-code" aria-label="Room code {code.split('').join(' ')}">{code}</p>
    {#if joinUrl}<p class="present-url">{joinUrl}</p>{/if}
    <p class="present-count" aria-live="polite">{live?.room?.clients ?? 0} joined</p>
    <button type="button" onclick={() => (fullscreen = false)}>Exit full screen (Esc)</button>
  </section>
{:else}
  <div class="row head">
    <h1><span class="mono code">{code}</span> {room?.title ?? ''}</h1>
    <StatusBadge {status} />
    <span class="conn" class:on={live?.connected} role="status">{live?.connected ? 'Live' : 'Connecting…'}</span>
  </div>

  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if expiringSoon}
    <div class="banner" role="alert">
      All data in this room will be deleted {relTime(expiresAt, now)} ({dateTime(expiresAt)}). Export it now if you need it.
    </div>
  {/if}

  {#if room}
    <div class="row toolbar">
      {#if status !== 'open'}
        <button type="button" class="primary" onclick={async () => (room = await api.openRoom(code))}>Open room</button>
      {:else}
        <button type="button" onclick={() => ask('Close room?', 'Students will no longer be able to send data. They can still delete their data.', 'Close room', async () => (room = await api.closeRoom(code)))}>Close room</button>
      {/if}
      <button type="button" onclick={() => (fullscreen = true)} disabled={!joinUrl}>Full-screen QR</button>
      <a class="button" href="{base}/rooms/{code}/edit">Edit</a>
      <button type="button" onclick={() => api.download(code, 'csv')}>Export CSV</button>
      <button type="button" onclick={() => api.download(code, 'json')}>Export JSON</button>
      <button
        type="button"
        onclick={() => ask('Rotate presenter key?', 'The old key will stop working immediately.', 'Rotate key', async () => (presenterKey = (await api.rotateKey(code)).presenterKey))}
        >New presenter key</button
      >
      <button type="button" class="danger" onclick={() => ask('Delete all events?', `This permanently deletes all ${room!.eventCount} events in this room. Joined clients stay joined.`, 'Delete all events', () => api.clearEvents(code))}>Clear data</button>
    </div>

    {#if presenterKey}
      <div class="card key" role="status">
        New presenter key (shown once): <code>{presenterKey}</code>
        <button type="button" onclick={() => copy(presenterKey!, 'key')}>{copied === 'key' ? 'Copied' : 'Copy'}</button>
      </div>
    {/if}

    <section class="stats" aria-label="Live counters">
      <div class="card stat"><span class="n" data-testid="clients">{live?.room?.clients ?? room.clientCount ?? 0}</span><span>clients joined</span></div>
      <div class="card stat"><span class="n" data-testid="events">{live?.room?.eventCount ?? room.eventCount}</span><span>events</span></div>
      <div class="card stat"><span class="n">{bytes(live?.room?.bytesUsed ?? room.bytesUsed)}</span><span>stored</span></div>
      <div class="card stat"><span class="n">{live?.room?.deletedClients ?? room.deletedClients ?? 0}</span><span>deleted their data</span></div>
    </section>

    <div class="cols">
      <section class="card" aria-labelledby="join-h">
        <h2 id="join-h">Join</h2>
        <div class="field">
          <label for="client-url">Client app URL</label>
          <input id="client-url" type="url" bind:value={clientUrl} placeholder="https://apps.example.com/quiz/" />
          <div class="hint">The room code is added as <code>?r={code}</code>.</div>
        </div>
        {#if joinUrl}
          <Qr text={joinUrl} size={200} label="QR code to join room {code}" />
          <p class="row"><code class="url">{joinUrl}</code> <button type="button" onclick={() => copy(joinUrl, 'url')}>{copied === 'url' ? 'Copied' : 'Copy link'}</button></p>
        {/if}
        <p>Closes {relTime(room.closesAt, now)} · data deleted {relTime(expiresAt, now)}</p>
      </section>

      <section class="card" aria-labelledby="apps-h">
        <h2 id="apps-h">Apps</h2>
        {#if !room.apps.length}<p>No apps. <a href="{base}/rooms/{code}/edit">Add one</a>.</p>{/if}
        <ul class="apps">
          {#each room.apps as a (a.name)}
            <li>
              <label class="switch">
                <input type="checkbox" role="switch" checked={a.enabled} onchange={(e) => toggleApp(a.name, (e.currentTarget as HTMLInputElement).checked)} />
                <span class="mono">{a.name}</span>
              </label>
              {#if a.groups}<span class="hint">groups: {Object.keys(a.groups).join(', ')}</span>{/if}
            </li>
          {/each}
        </ul>
        <h3>Rejected requests</h3>
        {#if rejections.length}
          <ul>
            {#each rejections as [k, v] (k)}<li><code>{k}</code>: {v}</li>{/each}
          </ul>
        {:else}
          <p class="hint">None so far.</p>
        {/if}
      </section>
    </div>

    <section aria-labelledby="recent-h">
      <h2 id="recent-h">Recent events</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th scope="col">Seq</th><th scope="col">Time</th><th scope="col">App</th><th scope="col">Group</th><th scope="col">Client</th><th scope="col">Data</th></tr>
          </thead>
          <tbody>
            {#each live?.recent ?? [] as e (e.seq)}
              <tr>
                <td>{e.seq}</td>
                <td>{new Date(e.t).toLocaleTimeString()}</td>
                <td class="mono">{e.app}</td>
                <td>{e.group ?? ''}</td>
                <td class="mono" title={e.cid}>{e.cid.slice(-6)}</td>
                <!-- Plain text interpolation: payloads are escaped, never rendered as HTML. -->
                <td class="mono data">{preview(e.data)}</td>
              </tr>
            {:else}
              <tr><td colspan="6" class="hint">Waiting for events…</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <section class="card" aria-labelledby="privacy-h">
      <h2 id="privacy-h">Privacy notice for your slide</h2>
      <p id="privacy-text">{PRIVACY_NOTICE}</p>
      <button type="button" onclick={() => copy(PRIVACY_NOTICE, 'privacy')}>{copied === 'privacy' ? 'Copied' : 'Copy notice'}</button>
    </section>
  {/if}
{/if}

<ConfirmDialog
  bind:open={confirmOpen}
  title={confirm?.title ?? ''}
  message={confirm?.message ?? ''}
  confirmLabel={confirm?.label ?? 'Confirm'}
  danger
  onconfirm={async () => {
    try {
      await confirm?.run();
      await load();
    } catch (e) {
      error = (e as Error).message;
    }
  }}
/>

<style>
  .head { margin-bottom: 0.75rem; }
  .head h1 { margin: 0; }
  .code { letter-spacing: 0.08em; }
  .conn { font-size: 0.85rem; color: var(--muted); }
  .conn.on { color: var(--ok); }
  .toolbar { margin-bottom: 1rem; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: 0.75rem; margin-bottom: 1rem; }
  .stat { display: flex; flex-direction: column; }
  .stat .n { font-size: 2rem; font-weight: 700; }
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr)); gap: 1rem; }
  .cols h2 { margin-top: 0; }
  #client-url { width: 100%; }
  #client-url + .hint { margin-top: 0.4rem; }
  .url { word-break: break-all; }
  .apps { list-style: none; padding: 0; margin: 0 0 1rem; display: grid; gap: 0.4rem; }
  .switch { display: inline-flex; gap: 0.5rem; align-items: center; font-weight: 400; margin: 0; }
  .switch input { width: 1.2rem; height: 1.2rem; }
  h3 { font-size: 1rem; }
  .data { max-width: 32rem; overflow-wrap: anywhere; }
  .key { margin-bottom: 1rem; word-break: break-all; }
  .present {
    position: fixed; inset: 0; background: var(--surface); z-index: 100;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.5rem; padding: 1rem; text-align: center;
  }
  .present-title { font-size: 1.75rem; margin: 0; }
  .present-code { font-family: ui-monospace, monospace; font-size: clamp(3rem, 12vw, 8rem); font-weight: 800; letter-spacing: 0.12em; margin: 0; }
  .present-url { font-size: 1.25rem; color: var(--muted); margin: 0; word-break: break-all; }
  .present-count { font-size: 1.5rem; margin: 0.25rem 0 1rem; }
</style>
