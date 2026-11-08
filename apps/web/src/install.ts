import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // we offer it from the menu instead of the browser's own banner
    deferred = e as BeforeInstallPromptEvent;
    listeners.forEach((l) => l());
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    listeners.forEach((l) => l());
  });
}

const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/**
 * Installing eSign as an app (Android, Windows, macOS Chrome/Edge: one click; iPhone/iPad: Share, Add to Home Screen).
 * Returns null when already installed.
 */
export function useInstall() {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  if (typeof window === 'undefined' || standalone()) return null;
  if (deferred)
    return {
      kind: 'prompt' as const,
      install: async () => {
        const d = deferred!;
        await d.prompt();
        await d.userChoice;
        deferred = null;
        tick((n) => n + 1);
      },
    };
  if (isIos()) return { kind: 'ios' as const };
  return { kind: 'manual' as const };
}
