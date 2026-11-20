<script lang="ts">
  import { base } from '$app/paths';
  import { goto } from '$app/navigation';
  import { api } from '$lib/api';
  import RoomForm from '$lib/components/RoomForm.svelte';

  let presenterKey = $state<string | null>(null);
  let code = $state('');
  let copied = $state(false);

  const initial = { title: '', purpose: 'teaching' as const, publicConfig: {}, apps: [{ name: 'quiz', enabled: true, maxEventsPerClient: 100, allowFreeText: false, groups: null, config: {}, schema: null }] };
</script>

<h1>New room</h1>

{#if presenterKey}
  <div class="card" role="status">
    <h2>Room {code} created</h2>
    <p>
      Presenter key (read-only access, e.g. for a projector laptop). <strong>It is shown only this once.</strong>
    </p>
    <p class="row">
      <code class="key">{presenterKey}</code>
      <button
        type="button"
        onclick={async () => {
          await navigator.clipboard.writeText(presenterKey!);
          copied = true;
        }}>{copied ? 'Copied' : 'Copy key'}</button
      >
    </p>
    <a class="button primary" href="{base}/rooms/{code}">Go to dashboard</a>
  </div>
{:else}
  <RoomForm
    {initial}
    submitLabel="Create room"
    showOpen
    onsubmit={async (input, { open }) => {
      const res = await api.createRoom({ ...input, title: input.title!, open });
      code = res.code;
      if (res.presenterKey) presenterKey = res.presenterKey;
      else await goto(`${base}/rooms/${res.code}`);
    }}
  />
{/if}

<style>
  .key { word-break: break-all; padding: 0.3em 0.5em; border: 1px dashed var(--border); border-radius: 6px; }
</style>
