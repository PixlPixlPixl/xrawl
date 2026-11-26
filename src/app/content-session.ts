/**
 * Content-script composition root.
 *
 * Assembles platform ports, world state, perception, and the debug overlay.
 * This is the only place where the browser-facing and engine-facing halves
 * meet; neither half imports the other.
 */
import { browser } from '#imports';
import { XRAWL_CONFIG } from '@/shared/constants/config';
import type {
  DownloadResult,
  ExportPayload,
  PrioritizePayload,
  StatusPayload,
  XrawlResponse,
} from '@/shared/types/messaging';
import { isContentRequest } from '@/shared/types/messaging';
import type { WorldSnapshot } from '@/shared/types/word-target';
import { DebugOverlay } from '@/ui/debug/overlay';
import { WorldState } from '@/world/world-state';
import { WordScanner } from '@/world/perception/word-scanner';
import { createBrowserPlatform } from '@/platform/browser/browser-adapter';
import { onRuntimeMessage } from '@/platform/browser/messaging';
import { observeUrlChanges } from '@/platform/browser/navigation';
import { ObservationReporter } from './observation-reporter';
import { CreatureSession } from './creature-session';
import type { FeedingPayload } from '@/data/observation';
import type { CreatureLoadoutSnapshot } from '@/shared/types/creature';

function buildStatus(snapshot: WorldSnapshot, overlayVisible: boolean): StatusPayload {
  return {
    stats: snapshot.stats,
    page: snapshot.page,
    environment: snapshot.environment,
    overlayVisible,
    capturedAt: snapshot.capturedAt,
  };
}

function buildExportPayload(snapshot: WorldSnapshot): ExportPayload {
  const limit = XRAWL_CONFIG.messaging.exportTargetLimit;
  const truncated = snapshot.targets.length > limit;
  return {
    snapshot: truncated ? { ...snapshot, targets: snapshot.targets.slice(0, limit) } : snapshot,
    truncated,
    exportedTargetCount: Math.min(limit, snapshot.targets.length),
  };
}

function downloadJson(document: Document, payload: ExportPayload): number {
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `xrawl-words-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  anchor.style.display = 'none';
  document.documentElement.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return json.length;
}

function ok<T>(data: T): XrawlResponse<T> {
  return { ok: true, data };
}

export function startContentSession(): void {
  const document = globalThis.document;
  const window = globalThis.window;
  const platform = createBrowserPlatform({ window, document });
  const world = new WorldState();
  const scanner = new WordScanner({ document, platform, world });
  const overlay = new DebugOverlay(document, window);
  overlay.mount();

  // Measurements go to the background, which owns the database. Nothing here
  // ever opens IndexedDB — the content script shares the page's origin.
  const reporter = new ObservationReporter({
    send: (payload) => {
      try {
        void browser.runtime.sendMessage({ type: 'xrawl/observe', payload }).catch(() => undefined);
      } catch {
        // Background worker unavailable during startup/shutdown.
      }
    },
    // Browse time requires all three: the document visible, its tab active, and
    // the browser window focused. `hasFocus()` is the only signal a content
    // script has for the latter two, and it is false for a background tab.
    isVisible: () => document.visibilityState !== 'hidden' && document.hasFocus(),
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') reporter.pause();
    else reporter.resume();
  });
  window.addEventListener('blur', () => reporter.pause());
  window.addEventListener('focus', () => reporter.resume());

  const sendFeeding = (payload: FeedingPayload): void => {
    try {
      void browser.runtime.sendMessage({ type: 'xrawl/feed', payload }).catch(() => undefined);
    } catch {
      // Background worker unavailable during startup/shutdown.
    }
  };

  const creature = new CreatureSession({
    document,
    window,
    platform,
    sessionId: reporter.sessionId,
    sendFeeding,
  });

  let statsPushTimer: number | null = null;
  let pendingSnapshot: WorldSnapshot | null = null;
  let lastPushAt = 0;

  let priorityTimer: number | null = null;
  let lastPriorityAt = 0;

  const pushStatsNow = (snapshot: WorldSnapshot): void => {
    const payload = buildStatus(snapshot, overlay.isVisible);
    try {
      void browser.runtime.sendMessage({ type: 'xrawl/stats', payload }).catch(() => undefined);
    } catch {
      // Background worker unavailable during startup/shutdown.
    }
  };

  const scheduleStatsPush = (snapshot: WorldSnapshot): void => {
    pendingSnapshot = snapshot;
    if (statsPushTimer !== null) return;

    const elapsed = platform.scheduler.now() - lastPushAt;
    const delay = Math.max(0, XRAWL_CONFIG.messaging.statsPushIntervalMs - elapsed);
    statsPushTimer = window.setTimeout(() => {
      statsPushTimer = null;
      const latest = pendingSnapshot;
      pendingSnapshot = null;
      if (latest === null) return;
      lastPushAt = platform.scheduler.now();
      pushStatsNow(latest);
    }, delay);
  };

  /**
   * Ask the background to rank the words currently on the page.
   *
   * Only one request is in flight at a time per throttle window, and the words
   * are deduplicated: the same word in five paragraphs needs one embedding, and
   * the response is a plain word-to-priority map the creature applies wholesale.
   */
  const schedulePriorities = (): void => {
    if (priorityTimer !== null) return;
    const elapsed = platform.scheduler.now() - lastPriorityAt;
    const delay = Math.max(0, XRAWL_CONFIG.messaging.prioritizeIntervalMs - elapsed);
    priorityTimer = window.setTimeout(() => {
      priorityTimer = null;
      if (!creature.isRunning) return;

      const words: Array<{ word: string; sentence?: string }> = [];
      const seen = new Set<string>();
      for (const target of world.getSnapshot().targets) {
        if (words.length >= XRAWL_CONFIG.messaging.maxPriorityWords) break;
        const word = target.normalized;
        if (word.length === 0 || word.length > 64 || seen.has(word)) continue;
        seen.add(word);
        words.push({ word, sentence: target.context.sentence });
      }
      if (words.length === 0) return;

      lastPriorityAt = platform.scheduler.now();
      try {
        void browser.runtime
          .sendMessage({ type: 'xrawl/prioritize', words })
          .then((response: unknown) => {
            const envelope = response as { ok?: boolean; data?: PrioritizePayload } | null;
            if (!envelope?.ok || !envelope.data) return;
            const map = new Map<string, number>();
            for (const entry of envelope.data.priorities) map.set(entry.word, entry.priority);
            creature.applyPriorities(map);
          })
          .catch(() => undefined);
      } catch {
        // Background worker unavailable; the creature keeps its rarity fallback.
      }
    }, delay);
  };

  world.subscribe((snapshot, reason) => {
    overlay.syncSnapshot(snapshot, reason);
    // Throttled; scroll updates carry refreshed visibility counts.
    scheduleStatsPush(snapshot);
    // Persistence is coarser than the UI: the reporter decides when to flush.
    reporter.observe(snapshot);
    // The creature consumes the same snapshot; it never reads the DOM itself.
    creature.syncSnapshot(snapshot);
    // Learned hunting priorities arrive out of band, from the background.
    schedulePriorities();
  });

  window.addEventListener('pagehide', () => reporter.stop());

  const toggleOverlay = (visible: boolean): void => {
    overlay.setVisible(visible);
    void platform.storage.set(XRAWL_CONFIG.overlayEnabledStorageKey, visible);
  };

  onRuntimeMessage((message, _sender, sendResponse) => {
    if (!isContentRequest(message)) return false;

    switch (message.type) {
      case 'xrawl/get-stats':
        sendResponse(ok(buildStatus(world.getSnapshot(), overlay.isVisible)));
        break;
      case 'xrawl/get-snapshot':
        sendResponse(ok(buildExportPayload(world.getSnapshot())));
        break;
      case 'xrawl/rescan':
        scanner.rescan();
        sendResponse(ok(buildStatus(world.getSnapshot(), overlay.isVisible)));
        break;
      case 'xrawl/set-overlay':
        toggleOverlay(message.visible);
        sendResponse(ok(buildStatus(world.getSnapshot(), overlay.isVisible)));
        break;
      case 'xrawl/download-snapshot': {
        const payload = buildExportPayload(world.getSnapshot());
        const bytes = downloadJson(document, payload);
        const result: DownloadResult = {
          bytes,
          truncated: payload.truncated,
          count: payload.exportedTargetCount,
        };
        sendResponse(ok(result));
        break;
      }
      default:
        sendResponse({ ok: false, error: 'Unknown request' });
        break;
    }
    return false;
  });

  window.addEventListener('keydown', (event) => {
    if (!event.altKey || !event.shiftKey || event.code !== 'KeyX') return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT')
    ) {
      return;
    }
    event.preventDefault();
    toggleOverlay(!overlay.isVisible);
  });

  void (async () => {
    const enabled = await platform.storage.get<boolean>(
      XRAWL_CONFIG.overlayEnabledStorageKey,
      true,
    );
    overlay.setVisible(enabled);
    const creatureEnabled = await platform.storage.get<boolean>(
      XRAWL_CONFIG.creatureEnabledStorageKey,
      true,
    );
    creature.mount();
    creature.setVisible(creatureEnabled);
    scanner.start();

    // The background owns the database, so the live loadout (species genes +
    // purchased levels) is fetched rather than read locally. Failure is
    // non-fatal: the creature falls back to its species defaults.
    void browser.runtime
      .sendMessage({ type: 'xrawl/creature-loadout' })
      .then((response: unknown) => {
        const loadout = response as { ok?: boolean; data?: CreatureLoadoutSnapshot | null } | null;
        if (loadout?.ok && loadout.data) creature.applyLoadout(loadout.data);
      })
      .catch(() => undefined);
    observeUrlChanges(window, () => scanner.rescan());
    pushStatsNow(world.getSnapshot());
  })();
}
