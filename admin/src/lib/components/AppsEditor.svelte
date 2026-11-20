<script lang="ts">
  import JsonEditor from './JsonEditor.svelte';
  import type { AppInput } from '../api';

  type Row = AppInput & { _key: number; _valid: { groups: boolean; config: boolean; schema: boolean } };
  let { apps = $bindable([]), valid = $bindable(true) }: { apps: AppInput[]; valid?: boolean } = $props();

  let n = 0;
  const toRow = (a: AppInput): Row => ({
    enabled: true,
    maxEventsPerClient: 100,
    allowFreeText: false,
    groups: null,
    config: {},
    schema: null,
    ...a,
    _key: n++,
    _valid: { groups: true, config: true, schema: true },
  });
  let rows = $state<Row[]>(apps.map(toRow));
  const NAME_RE = /^[a-z0-9-]{1,40}$/;

  $effect(() => {
    apps = rows.map(({ _key, _valid, ...a }) => a);
    const names = rows.map((r) => r.name);
    valid =
      rows.every((r) => NAME_RE.test(r.name) && r._valid.groups && r._valid.config && r._valid.schema && (r.maxEventsPerClient ?? 1) >= 1) &&
      new Set(names).size === names.length;
  });

  function add() {
    rows.push(toRow({ name: `app-${rows.length + 1}` }));
  }
  function remove(i: number) {
    rows.splice(i, 1);
  }
</script>

<div class="apps">
  {#each rows as row, i (row._key)}
    <fieldset class="card">
      <legend>App {i + 1}</legend>
      <div class="grid">
        <div class="field">
          <label for="app-name-{row._key}">Name <span class="hint">a-z, 0-9, -</span></label>
          <input id="app-name-{row._key}" bind:value={row.name} aria-invalid={!NAME_RE.test(row.name)} maxlength="40" />
        </div>
        <div class="field">
          <label for="app-max-{row._key}">Max events per client</label>
          <input id="app-max-{row._key}" type="number" min="1" max="50000" bind:value={row.maxEventsPerClient} />
        </div>
        <div class="field checks">
          <label><input type="checkbox" bind:checked={row.enabled} /> Enabled</label>
          <label><input type="checkbox" bind:checked={row.allowFreeText} /> Allow free text <span class="hint">(200 chars, not 40)</span></label>
        </div>
      </div>
      <JsonEditor id="app-groups-{row._key}" label="Groups" hint='weighted A/B, e.g. {"{"}"A":1,"B":1{"}"} — empty for none' bind:value={row.groups} bind:valid={row._valid.groups} allowNull rows={2} maxBytes={2048} />
      <JsonEditor id="app-config-{row._key}" label="Config" hint="sent to clients, ≤ 4 KB" bind:value={row.config} bind:valid={row._valid.config} rows={3} maxBytes={4096} />
      <JsonEditor id="app-schema-{row._key}" label="JSON Schema" hint="optional, validates data" bind:value={row.schema} bind:valid={row._valid.schema} allowNull rows={3} maxBytes={16384} />
      <button type="button" class="danger" onclick={() => remove(i)}>Remove app {row.name}</button>
    </fieldset>
  {/each}
  <button type="button" onclick={add}>+ Add app</button>
</div>

<style>
  .apps { display: grid; gap: 1rem; }
  fieldset { margin: 0; }
  legend { font-weight: 600; padding: 0 0.25rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: 0 1rem; }
  .checks label { font-weight: 400; }
</style>
