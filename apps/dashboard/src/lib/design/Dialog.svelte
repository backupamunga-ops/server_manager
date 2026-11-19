<script lang="ts">
  import type { Snippet } from 'svelte';
import Icon from './Icon.svelte';

  /**
   * Drevanta dialog (design-system.md §Data & feedback + source CSS):
   * native <dialog class="modaldialog">, .modal-head/.modal-body/.modal-foot,
   * width min(650px, calc(100vw - 32px)), 10px radius, backdrop rgb(2 6 23/.55),
   * labelled title + visible close control, scrollable body.
   */
  interface DialogProps {
    open?: boolean;
    title: string;
    onclose?: () => void;
    children?: Snippet;
    footer?: Snippet;
  }
  let {
    open = $bindable(false),
    title,
    onclose,
    children,
    footer,
  }: DialogProps = $props();

  let el: HTMLDialogElement | null = $state(null);

  $effect(() => {
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  });

  function handleClose() {
    open = false;
    onclose?.();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<dialog bind:this={el} class="modaldialog" aria-labelledby="dlg-title" onclose={handleClose}>
  <form method="dialog">
    <header class="modal-head">
      <div>
        <h2 id="dlg-title">{title}</h2>
      </div>
      <button class="icon-btn" type="button" aria-label="Close dialog" onclick={() => el?.close()}>
        <Icon name="close" />
      </button>
    </header>
    <div class="modal-body">
      {@render children?.()}
    </div>
    {#if footer}
      <footer class="modal-foot">
        {@render footer()}
      </footer>
    {/if}
  </form>
</dialog>
