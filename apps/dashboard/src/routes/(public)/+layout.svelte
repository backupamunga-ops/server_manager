<script lang="ts">
  import './public.css';

  /** Public shell: centered card on canvas, brand header. */
  let { children } = $props();
</script>

<div class="public-shell">
  <header class="public-head">
    <span class="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h7l2 2h9v12H3z"/></svg>
    </span>
    <span class="brand">cloudlane.</span>
  </header>
  <main class="public-main">
    {@render children()}
  </main>
</div>

<style>
  .public-shell {
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: clamp(24px, 6vw, 64px) 16px;
  }
  .public-head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: clamp(24px, 5vh, 48px);
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
  .public-main {
    width: 100%;
    max-width: 480px;
  }
</style>
