<script lang="ts">
  import { onMount } from 'svelte';
  import { auth } from '$lib/auth.svelte';

  let working = $state(true);
  onMount(async () => {
    if (location.hash) await auth.completeLogin(location.hash);
    else if (!auth.signedIn) auth.error = 'Nothing to do here.';
    working = false;
  });
</script>

<h1>Sign in</h1>
{#if working}
  <p aria-live="polite">Completing sign-in…</p>
{:else if auth.error}
  <p class="error" role="alert">{auth.error}</p>
  <button type="button" class="primary" onclick={() => auth.login('/admin/')}>Sign in again</button>
{/if}
