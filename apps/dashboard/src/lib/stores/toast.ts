/**
 * Toast store — Drevanta .toast pattern (fixed overlay, role="status",
 * max-width 360px, medium shadow). Non-intrusive operational feedback.
 */
import { writable } from 'svelte/store';

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  message: string;
}

export const toasts = writable<Toast[]>([]);

let nextId = 1;

export function toast(kind: Toast['kind'], message: string, ttl = 5000): void {
  const id = nextId++;
  toasts.update((list) => [...list, { id, kind, message }]);
  setTimeout(() => {
    toasts.update((list) => list.filter((t) => t.id !== id));
  }, ttl);
}
