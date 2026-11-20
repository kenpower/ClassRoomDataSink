<script lang="ts">
  import { base } from '$app/paths';
  import { goto } from '$app/navigation';
  import { api, type RoomSummary } from '$lib/api';
  import { auth } from '$lib/auth.svelte';
  import StatusBadge from '$lib/components/StatusBadge.svelte';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
  import { bytes, dateTime, relTime } from '$lib/format';

  let rooms = $state<RoomSummary[]>([]);
  let loading = $state(true);
  let error = $state('');
  let showAll = $state(false);
  let toDelete = $state<RoomSummary | null>(null);
  let confirmOpen = $state(false);
  let notice = $state('');

  async function load() {
    loading = true;
    error = '';
    try {
      rooms = (await api.listRooms(showAll)).rooms;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void showAll;
    void load();
  });

  async function act(fn: () => Promise<unknown>, msg: string) {
    try {
      await fn();
      notice = msg;
      await load();
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function clone(r: RoomSummary) {
    try {
      const c = await api.cloneRoom(r.code);
      await goto(`${base}/rooms/${c.code}/edit`);
    } catch (e) {
      error = (e as Error).message;
    }
  }

  const expiringSoon = (r: RoomSummary) => new Date(r.expiresAt).getTime() - Date.now() < 3600_000;
</script>

<div class="row head">
  <h1>Rooms</h1>
  <span class="spacer"></span>
  {#if auth.user?.isAdmin}
    <label class="inline"><input type="checkbox" bind:checked={showAll} /> Show all rooms</label>
  {/if}
  <a class="button primary" href="{base}/rooms/new">New room</a>
</div>

<div aria-live="polite">
  {#if notice}<p class="ok">{notice}</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

{#if loading && !rooms.length}
  <p>Loading…</p>
{:else if !rooms.length}
  <div class="card"><p>No rooms yet. <a href="{base}/rooms/new">Create your first room</a>.</p></div>
{:else}
  <div class="table-wrap">
    <table>
      <caption class="sr-only">Your rooms</caption>
      <thead>
        <tr>
          <th scope="col">Status</th>
          <th scope="col">Code</th>
          <th scope="col">Title</th>
          {#if showAll}<th scope="col">Owner</th>{/if}
          <th scope="col">Clients</th>
          <th scope="col">Events</th>
          <th scope="col">Data deleted</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each rooms as r (r.code)}
          <tr>
            <td><StatusBadge status={r.status} /></td>
            <td><a class="mono code" href="{base}/rooms/{r.code}">{r.code}</a></td>
            <td>{r.title}</td>
            {#if showAll}<td>{r.owner}</td>{/if}
            <td>{r.clientCount}</td>
            <td>{r.eventCount} <span class="hint">({bytes(r.bytesUsed)})</span></td>
            <td>
              <span title={dateTime(r.expiresAt)} class:warn={expiringSoon(r)}>{relTime(r.expiresAt)}</span>
            </td>
            <td>
              <div class="row actions">
                {#if r.status !== 'open'}
                  <button type="button" onclick={() => act(() => api.openRoom(r.code), `Opened ${r.code}`)} aria-label="Open room {r.code}">Open</button>
                {:else}
                  <button type="button" onclick={() => act(() => api.closeRoom(r.code), `Closed ${r.code}`)} aria-label="Close room {r.code}">Close</button>
                {/if}
                <a class="button" href="{base}/rooms/{r.code}/edit" aria-label="Edit room {r.code}">Edit</a>
                <button type="button" onclick={() => clone(r)} aria-label="Clone room {r.code}">Clone</button>
                <button type="button" onclick={() => api.download(r.code, 'csv').catch((e) => (error = e.message))} aria-label="Export room {r.code} as CSV">Export</button>
                <button
                  type="button"
                  class="danger"
                  onclick={() => {
                    toDelete = r;
                    confirmOpen = true;
                  }}
                  aria-label="Delete room {r.code}">Delete</button
                >
              </div>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<ConfirmDialog
  bind:open={confirmOpen}
  title="Delete room {toDelete?.code}?"
  message="This permanently deletes the room and all {toDelete?.eventCount ?? 0} events. The code cannot be reused for 30 days."
  confirmLabel="Delete room"
  danger
  requireText={toDelete?.code ?? ''}
  onconfirm={() => act(() => api.deleteRoom(toDelete!.code), `Deleted ${toDelete!.code}`)}
/>

<style>
  .head h1 { margin: 0; }
  .head { margin-bottom: 1rem; }
  .spacer { flex: 1; }
  .inline { font-weight: 400; margin: 0; }
  .code { font-weight: 700; letter-spacing: 0.08em; }
  .actions button, .actions .button { padding: 0.25em 0.6em; min-height: 2rem; font-size: 0.9rem; }
  .warn { color: var(--danger); font-weight: 600; }
  .ok { color: var(--ok); }
</style>
