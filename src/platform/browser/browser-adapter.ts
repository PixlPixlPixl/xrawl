/**
 * Browser implementation of the platform ports.
 *
 * This is the only place in the codebase that reaches for browser APIs
 * (`window`, `performance`, extension storage). Engines receive the resulting
 * `Platform` object, never the globals.
 */
import { browser } from '#imports';
import type { Platform, Scheduler, StoragePort, TimerHandle, ViewportPort } from '@/platform/types';
import type { ScrollOffset, ViewportSize } from '@/shared/types/geometry';

interface BrowserGlobals {
  readonly window: Window;
  readonly document: Document;
}

function createScheduler(win: Window, doc: Document): Scheduler {
  return {
    now: () => win.performance.now(),

    nextFrame: () =>
      new Promise<void>((resolve) => {
        // rAF is paused in hidden tabs; fall back to a timer so a scan started
        // in the background still makes progress.
        if (doc.visibilityState === 'visible' && typeof win.requestAnimationFrame === 'function') {
          win.requestAnimationFrame(() => resolve());
        } else {
          win.setTimeout(resolve, 0);
        }
      }),

    timeout: (callback, delayMs): TimerHandle => win.setTimeout(callback, delayMs),
    clearTimeout: (handle) => win.clearTimeout(handle),
  };
}

function createViewport(win: Window): ViewportPort {
  const scrollOffset = (): ScrollOffset => ({ x: win.scrollX, y: win.scrollY });
  const size = (): ViewportSize => ({
    width: win.innerWidth,
    height: win.innerHeight,
  });

  return {
    read: () => ({ scroll: scrollOffset(), size: size() }),
    scrollOffset,
    size,
  };
}

function createStorage(): StoragePort {
  return {
    async get<T>(key: string, fallback: T): Promise<T> {
      try {
        const stored = await browser.storage.local.get(key);
        return key in stored ? (stored[key] as T) : fallback;
      } catch {
        return fallback;
      }
    },
    async set(key: string, value: unknown): Promise<void> {
      try {
        await browser.storage.local.set({ [key]: value });
      } catch {
        // Storage failures must never take down perception.
      }
    },
  };
}

export function createBrowserPlatform(globals: BrowserGlobals): Platform {
  return {
    scheduler: createScheduler(globals.window, globals.document),
    viewport: createViewport(globals.window),
    storage: createStorage(),
  };
}
