<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { api } from '$lib/api/client';
  import { session, installationStatus } from '$lib/stores/session';

  let loading = true;

  onMount(async () => {
    try {
      const status = await api.installation.status();
      installationStatus.set(status.status);

      if (status.status === 'active') {
        try {
          const sess = await api.auth.session();
          session.set(sess);
        } catch {
          session.set(null);
        }
      }
    } catch {
      // network error — allow UI to show
    } finally {
      loading = false;
    }
  });

  $: currentPath = $page.url.pathname;
  $: isAuthed = $session !== null;
  $: isUnclaimed = $installationStatus === 'unclaimed';
  $: isPublicPath = currentPath.startsWith('/login') || currentPath.startsWith('/setup');
</script>

{#if loading}
  <div class="loading">Loading Cloudlane…</div>
{:else if isUnclaimed && !currentPath.startsWith('/setup')}
  <meta http-equiv="refresh" content="0; url=/setup" />
  <div class="loading">Redirecting to setup…</div>
{:else if !isAuthed && !isPublicPath}
  <meta http-equiv="refresh" content="0; url=/login" />
  <div class="loading">Redirecting to login…</div>
{:else}
  <slot />
{/if}

<style>
  .loading {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--muted, #64748b);
    background: var(--bg, #020617);
  }
</style>
