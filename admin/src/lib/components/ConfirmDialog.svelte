<script lang="ts">
  /** Accessible confirm dialog built on <dialog> (focus trap and Esc handled by the browser). */
  let {
    open = $bindable(false),
    title,
    message,
    confirmLabel = 'Confirm',
    danger = false,
    requireText = '',
    onconfirm,
  }: {
    open?: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
    requireText?: string;
    onconfirm: () => void | Promise<void>;
  } = $props();

  let dialog = $state<HTMLDialogElement>();
  let typed = $state('');
  let busy = $state(false);
  const id = `dlg-${Math.random().toString(36).slice(2)}`;

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) {
      typed = '';
      dialog.showModal();
    } else if (!open && dialog.open) dialog.close();
  });

  async function confirm() {
    busy = true;
    try {
      await onconfirm();
      open = false;
    } finally {
      busy = false;
    }
  }
</script>

<dialog bind:this={dialog} aria-labelledby="{id}-t" aria-describedby="{id}-m" onclose={() => (open = false)}>
  <h2 id="{id}-t">{title}</h2>
  <p id="{id}-m">{message}</p>
  {#if requireText}
    <div class="field">
      <label for="{id}-i">Type <code>{requireText}</code> to confirm</label>
      <input id="{id}-i" bind:value={typed} autocomplete="off" />
    </div>
  {/if}
  <div class="row end">
    <button type="button" onclick={() => (open = false)}>Cancel</button>
    <button type="button" class={danger ? 'danger' : 'primary'} disabled={busy || (!!requireText && typed !== requireText)} onclick={confirm}>
      {confirmLabel}
    </button>
  </div>
</dialog>

<style>
  dialog {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
    max-width: min(32rem, calc(100vw - 2rem));
    padding: 1.25rem;
  }
  dialog::backdrop { background: rgb(0 0 0 / 0.45); }
  h2 { margin-top: 0; }
  .end { justify-content: flex-end; }
</style>
