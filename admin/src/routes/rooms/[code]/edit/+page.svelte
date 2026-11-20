<script lang="ts">
  import { page } from '$app/state';
  import { base } from '$app/paths';
  import { goto } from '$app/navigation';
  import { api, type Room } from '$lib/api';
  import RoomForm from '$lib/components/RoomForm.svelte';

  const code = $derived(page.params.code ?? '');
  let room = $state<Room | null>(null);
  let error = $state('');

  $effect(() => {
    api.getRoom(code).then(
      (r) => (room = r),
      (e) => (error = e.message),
    );
  });
</script>

<h1>Edit room <span class="mono">{code}</span></h1>
{#if error}<p class="error" role="alert">{error}</p>{/if}
{#if room}
  {#key room.code}
    <RoomForm
      initial={{
        title: room.title,
        purpose: room.purpose,
        publicConfig: room.publicConfig,
        apps: room.apps,
        owners: room.owners,
        closesAt: room.closesAt,
        expiresAt: room.expiresAt,
      }}
      submitLabel="Save changes"
      onsubmit={async (input) => {
        // Only send times if they changed, so an untouched form never fails on a past close time.
        if (input.closesAt && Math.abs(new Date(input.closesAt).getTime() - new Date(room!.closesAt).getTime()) < 60_000) delete input.closesAt;
        if (input.expiresAt && Math.abs(new Date(input.expiresAt).getTime() - new Date(room!.expiresAt).getTime()) < 60_000) delete input.expiresAt;
        await api.patchRoom(code, input);
        await goto(`${base}/rooms/${code}`);
      }}
    />
  {/key}
{:else if !error}
  <p>Loading…</p>
{/if}
