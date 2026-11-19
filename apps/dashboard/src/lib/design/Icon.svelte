<script lang="ts">
  import { ICON_PATHS } from './icons';

  /**
   * Drevanta inline icon: 24×24 viewBox, 1.8 stroke, round caps/joins,
   * currentColor, default 18px rendering (design-system.md §Iconography).
   */
  interface IconProps {
    name: string;
    size?: number;
    label?: string;
  }
  let { name, size = 18, label = '' }: IconProps = $props();

  const d = $derived(ICON_PATHS[name] ?? '');
</script>

<svg
  class="ico"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden={label ? undefined : 'true'}
  role={label ? 'img' : undefined}
>
  {#if label}<title>{label}</title>{/if}
  {#each d.split(' M') as seg, i}
    <path d={i === 0 ? seg : 'M' + seg} />
  {/each}
</svg>
