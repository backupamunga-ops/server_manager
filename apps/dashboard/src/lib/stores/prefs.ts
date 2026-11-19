/**
 * UI preferences: palette family + dark mode (non-sensitive, localStorage OK
 * per master guide §4 — "Non-sensitive palette preferences ... may persist").
 */
import { browser } from '$app/environment';
import { writable } from 'svelte/store';

export const PALETTES = [
  { id: 'original', label: 'Original · Teal / Slate' },
  { id: 'slate', label: 'Slate & Charcoal' },
  { id: 'sand', label: 'Sand & Saddle' },
  { id: 'sage', label: 'Sage & Burgundy' },
  { id: 'mauve', label: 'Mauve Meadow' },
] as const;

export type PaletteId = (typeof PALETTES)[number]['id'];

const PALETTE_KEY = 'cloudlane.palette';
const DARK_KEY = 'cloudlane.dark';

function initialPalette(): PaletteId {
  if (!browser) return 'original';
  const v = localStorage.getItem(PALETTE_KEY);
  return PALETTES.some((p) => p.id === v) ? (v as PaletteId) : 'original';
}

function initialDark(): boolean {
  if (!browser) return false;
  return localStorage.getItem(DARK_KEY) === '1';
}

export const palette = writable<PaletteId>(initialPalette());
export const dark = writable<boolean>(initialDark());

if (browser) {
  let p = initialPalette();
  let d = initialDark();
  const apply = () => {
    document.documentElement.dataset.palette = p;
    document.documentElement.classList.toggle('dark', d);
  };
  palette.subscribe((v) => {
    p = v;
    localStorage.setItem(PALETTE_KEY, v);
    apply();
  });
  dark.subscribe((v) => {
    d = v;
    localStorage.setItem(DARK_KEY, v ? '1' : '0');
    apply();
  });
  apply();
}
