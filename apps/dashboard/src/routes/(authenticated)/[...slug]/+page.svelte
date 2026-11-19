<script lang="ts">
  import { onMount } from 'svelte';
  import '@fontsource/inter/latin-400.css';
  import '@fontsource/inter/latin-500.css';
  import '@fontsource/inter/latin-600.css';
  import '@fontsource/inter/latin-700.css';
  import '@fontsource/jetbrains-mono/latin-400.css';
  import '@fontsource/jetbrains-mono/latin-500.css';
  import '$lib/proto/proto.css';
  import { mountApp } from '$lib/proto/proto';

  let { data } = $props();
  void data; // session guard happens in +layout.ts; the ported app renders itself.

  let cleanup: (() => void) | null = null;
  onMount(() => {
    cleanup = mountApp();
    return () => { cleanup?.(); };
  });
</script>

<div id="app"></div>
