<script lang="ts">
  let { status }: { status: 'draft' | 'open' | 'closed' } = $props();
</script>

<span class="badge {status}">{status}</span>

<style>
  .badge {
    display: inline-block;
    padding: 0.1em 0.55em;
    border-radius: 999px;
    font-size: 0.8rem;
    font-weight: 600;
    border: 1px solid currentColor;
    text-transform: capitalize;
  }
  .open { color: var(--ok); }
  .draft { color: var(--muted); }
  .closed { color: var(--danger); }
</style>
