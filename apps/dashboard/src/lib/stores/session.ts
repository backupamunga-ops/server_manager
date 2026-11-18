import { writable } from 'svelte/store';
import type { SessionInfo } from '@cloudlane/contracts';

export const session = writable<SessionInfo | null>(null);
export const installationStatus = writable<'unclaimed' | 'claimed' | 'active' | null>(null);
export const theme = writable<{ palette: string; mode: 'light' | 'dark' }>({
  palette: 'original',
  mode: 'dark',
});
