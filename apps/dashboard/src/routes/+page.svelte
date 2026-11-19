<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { api, ApiError } from '$api/client';
  import { palette, dark } from '$stores/prefs';

  /**
   * Landing: public-safe routing per master guide §3 — installation status
   * decides setup vs login vs app; the session endpoint decides auth state.
   */
  let error = $state(false);

  onMount(async () => {
    try {
      const status = await api.installation.status();
      if (status.status === 'unclaimed' || status.status === 'claimed') {
        await goto('/setup', { replaceState: true });
        return;
      }
      try {
        const session = await api.auth.session();
        if (session && session.userId) {
          await goto('/overview', { replaceState: true });
          return;
        }
        await goto('/login', { replaceState: true });
      } catch (err) {
        // 401 = simply not signed in — that is the normal logged-out path.
        if (err instanceof ApiError && err.status === 401) {
          await goto('/login', { replaceState: true });
          return;
        }
        throw err;
      }
    } catch {
      // Network-level failure (API down, 5xx, transport error).
      error = true;
    }
  });
</script>

<div class="loader">
  <div class="brand-row">
    <span class="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h7l2 2h9v12H3z"/></svg>
    </span>
    <span class="brand">cloudlane.</span>
  </div>
  {#if error}
    <p class="sub">Cannot reach the Cloudlane API. Make sure the server is running.</p>
  {:else}
    <p class="sub"><span class="spinner" aria-hidden="true"></span>Loading…</p>
  {/if}
</div>

<style>
  .loader {
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 10px;
    text-align: center;
  }
  .brand-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .brand-mark {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: var(--palette-button, var(--primary));
    color: var(--palette-button-text, #fff);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .brand {
    font-size: 19px;
    font-weight: 700;
    letter-spacing: -0.04em;
    color: var(--text);
  }
  .sub {
    color: var(--muted);
    font-size: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
    justify-content: center;
  }
  .spinner {
    display: inline-block;
    width: 16px;
    height: 16px;
    border: 2px solid var(--border-default);
    border-top-color: var(--primary);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
</style>
