<script lang="ts">
  import JsonEditor from './JsonEditor.svelte';
  import AppsEditor from './AppsEditor.svelte';
  import type { AppInput, RoomInput } from '../api';
  import { fromLocalInput, toLocalInput } from '../format';

  let {
    initial,
    submitLabel,
    onsubmit,
    showOpen = false,
  }: {
    initial: RoomInput & { closesAt?: string; expiresAt?: string };
    submitLabel: string;
    onsubmit: (input: RoomInput, opts: { open: boolean }) => Promise<void>;
    showOpen?: boolean;
  } = $props();

  // svelte-ignore state_referenced_locally
  const init = initial;
  let title = $state(init.title ?? '');
  let purpose = $state<'teaching' | 'research'>(init.purpose ?? 'teaching');
  let closesAt = $state(init.closesAt ? toLocalInput(init.closesAt) : '');
  let expiresAt = $state(init.expiresAt ? toLocalInput(init.expiresAt) : '');
  let publicConfig = $state<unknown>(init.publicConfig ?? {});
  let publicValid = $state(true);
  let apps = $state<AppInput[]>(init.apps ?? []);
  let appsValid = $state(true);
  let owners = $state((init.owners ?? []).join(', '));
  let openNow = $state(false);
  let error = $state('');
  let busy = $state(false);

  const canSubmit = $derived(title.trim().length > 0 && title.length <= 100 && publicValid && appsValid && !busy);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    busy = true;
    error = '';
    try {
      const input: RoomInput = {
        title: title.trim(),
        purpose,
        publicConfig: publicConfig as Record<string, unknown>,
        apps,
        owners: owners
          .split(/[\s,]+/)
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      };
      const c = fromLocalInput(closesAt);
      const x = fromLocalInput(expiresAt);
      if (c) input.closesAt = c;
      if (x) input.expiresAt = x;
      await onsubmit(input, { open: openNow });
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<form onsubmit={submit} novalidate>
  <div class="field">
    <label for="title">Title</label>
    <input id="title" bind:value={title} maxlength="100" required />
  </div>
  <div class="grid">
    <div class="field">
      <label for="purpose">Purpose</label>
      <select id="purpose" bind:value={purpose}>
        <option value="teaching">Teaching</option>
        <option value="research">Research</option>
      </select>
    </div>
    <div class="field">
      <label for="closes">Closes at <span class="hint">default: 3 h after opening</span></label>
      <input id="closes" type="datetime-local" bind:value={closesAt} />
    </div>
    <div class="field">
      <label for="expires">Data deleted at <span class="hint">default: 24 h after closing, max 30 days</span></label>
      <input id="expires" type="datetime-local" bind:value={expiresAt} />
    </div>
  </div>
  <div class="field">
    <label for="owners">Co-owners <span class="hint">staff emails, comma separated</span></label>
    <input id="owners" bind:value={owners} />
  </div>
  <JsonEditor id="publicConfig" label="Public config" hint="sent to every client, ≤ 8 KB" bind:value={publicConfig} bind:valid={publicValid} maxBytes={8192} />
  <h2>Apps</h2>
  <AppsEditor bind:apps bind:valid={appsValid} />
  {#if showOpen}
    <div class="field open-now">
      <label><input type="checkbox" bind:checked={openNow} /> Open the room straight away</label>
    </div>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <div class="row actions">
    <button class="primary" type="submit" disabled={!canSubmit}>{submitLabel}</button>
  </div>
</form>

<style>
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 0 1rem; }
  #title, #owners { width: 100%; }
  .actions { margin-top: 1.25rem; }
  .open-now { margin-top: 1rem; }
  label:has(input[type='checkbox']) { font-weight: 400; }
</style>
