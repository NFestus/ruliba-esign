import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';
const KEY = 'esign-theme';
const listeners = new Set<() => void>();

/** Light by default. The choice is a per-device convenience, so localStorage is fine (and optional). */
export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* private mode: theme still applies for this visit */
  }
  listeners.forEach((l) => l());
}

export function initTheme() {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    /* ignore */
  }
  document.documentElement.dataset.theme = saved === 'dark' ? 'dark' : 'light';
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    currentTheme,
  );
}
