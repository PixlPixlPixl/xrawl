/**
 * SPA navigation detection.
 *
 * Content scripts live in an isolated JS world, so patching
 * `history.pushState` from here would not affect the page's own calls.
 * Strategy:
 *  1. `window.navigation` (Navigation API) when available — fires on all
 *     same-document navigations.
 *  2. `popstate` / `hashchange` events.
 *  3. A low-frequency URL poll as the safety net (1s, no DOM work).
 */
import { XRAWL_CONFIG } from '@/shared/constants/config';

export function observeUrlChanges(win: Window, onChange: () => void): () => void {
  let lastUrl = win.location.href;
  const emitIfChanged = () => {
    const current = win.location.href;
    if (current === lastUrl) return;
    lastUrl = current;
    onChange();
  };

  win.addEventListener('popstate', emitIfChanged);
  win.addEventListener('hashchange', emitIfChanged);

  interface NavigateLike {
    addEventListener(type: 'navigate', listener: () => void): void;
    removeEventListener(type: 'navigate', listener: () => void): void;
  }
  const navigation = (win as Window & { navigation?: NavigateLike }).navigation;
  navigation?.addEventListener('navigate', emitIfChanged);

  const poll = win.setInterval(emitIfChanged, XRAWL_CONFIG.scan.urlPollIntervalMs);

  return () => {
    win.removeEventListener('popstate', emitIfChanged);
    win.removeEventListener('hashchange', emitIfChanged);
    navigation?.removeEventListener('navigate', emitIfChanged);
    win.clearInterval(poll);
  };
}
