<script lang="ts">
  /** Textarea JSON editor with live parse and size validation. `value` is only updated with valid JSON. */
  let {
    id,
    label,
    value = $bindable(),
    maxBytes = 8192,
    allowNull = false,
    rows = 6,
    hint = '',
    valid = $bindable(true),
  }: {
    id: string;
    label: string;
    value: unknown;
    maxBytes?: number;
    allowNull?: boolean;
    rows?: number;
    hint?: string;
    valid?: boolean;
  } = $props();

  let text = $state(value === null || value === undefined ? '' : JSON.stringify(value, null, 2));
  let error = $state('');

  function onInput() {
    const t = text.trim();
    if (!t) {
      if (allowNull) {
        error = '';
        valid = true;
        value = null;
      } else {
        error = 'Required (use {} for empty)';
        valid = false;
      }
      return;
    }
    try {
      const parsed = JSON.parse(t);
      if (!allowNull && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) throw new Error('Must be a JSON object');
      const size = new TextEncoder().encode(JSON.stringify(parsed)).length;
      if (size > maxBytes) throw new Error(`Too large: ${size} bytes (max ${maxBytes})`);
      error = '';
      valid = true;
      value = parsed;
    } catch (e) {
      error = (e as Error).message;
      valid = false;
    }
  }
</script>

<div class="field">
  <label for={id}>{label} {#if hint}<span class="hint">{hint}</span>{/if}</label>
  <textarea {id} {rows} bind:value={text} oninput={onInput} spellcheck="false" aria-invalid={!!error} aria-describedby="{id}-err"></textarea>
  <div id="{id}-err" class="error" aria-live="polite">{error}</div>
</div>

<style>
  textarea { width: 100%; }
</style>
