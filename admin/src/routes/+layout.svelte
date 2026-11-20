<script lang="ts">
  import '$lib/app.css';
  import { page } from '$app/state';
  import { base } from '$app/paths';
  import { auth } from '$lib/auth.svelte';

  let { children } = $props();
  const isAuthPage = $derived(page.url.pathname.startsWith(`${base}/auth`));

  $effect(() => {
    if (!auth.signedIn && !isAuthPage) auth.login();
  });
</script>

<a class="skip" href="#main">Skip to content</a>
<header>
  <nav aria-label="Main">
    <a class="brand" href="{base}/">RoomSink</a>
    {#if auth.signedIn}
      <a href="{base}/" aria-current={page.url.pathname === `${base}/` ? 'page' : undefined}>Rooms</a>
      <a href="{base}/rooms/new" aria-current={page.url.pathname === `${base}/rooms/new` ? 'page' : undefined}>New room</a>
      <span class="spacer"></span>
      <span class="user">{auth.user?.name}{auth.user?.isAdmin ? ' (admin)' : ''}</span>
      <button type="button" onclick={() => auth.logout()}>Sign out</button>
    {/if}
  </nav>
</header>
<main id="main">
  {#if auth.signedIn || isAuthPage}
    {@render children()}
  {:else}
    <p aria-live="polite">Signing in…</p>
  {/if}
</main>

<style>
  .skip { position: absolute; left: -999px; }
  .skip:focus { left: 1rem; top: 1rem; background: var(--surface); padding: 0.5rem; z-index: 10; }
  header { background: var(--surface); border-bottom: 1px solid var(--border); }
  nav { display: flex; gap: 1rem; align-items: center; max-width: 72rem; margin: 0 auto; padding: 0.6rem 1rem; flex-wrap: wrap; }
  nav a { text-decoration: none; color: var(--text); }
  nav a[aria-current='page'] { text-decoration: underline; text-underline-offset: 4px; }
  .brand { font-weight: 700; color: var(--accent) !important; }
  .spacer { flex: 1; }
  .user { color: var(--muted); font-size: 0.9rem; }
  main { max-width: 72rem; margin: 0 auto; padding: 1.25rem 1rem 3rem; }
</style>
