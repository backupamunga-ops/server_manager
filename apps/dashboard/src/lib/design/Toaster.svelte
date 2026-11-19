<script lang="ts">
  import { toasts } from '$stores/toast';

  /** Renders the toast store; role="status" per the Drevanta pattern. */
  const palette: Record<string, string> = {
    success: 'var(--success)',
    error: 'var(--danger)',
    info: 'var(--info)',
  };
</script>

{#each $toasts as t (t.id)}
  <div class="toast" role="status">
    <span
      class="dot"
      style="background:{palette[t.kind]}; width:8px; height:8px; border-radius:50%; display:inline-block;"
    ></span>
    <span>{t.message}</span>
  </div>
{/each}

<style>
  .toast {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--text);
  }
</style>
