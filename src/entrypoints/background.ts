/**
 * Background worker.
 *
 * The debug harness keeps no game state here yet. Its only job is caching the
 * latest stats per tab and relaying them to the popup without opening a
 * message channel to every content script.
 */
import { browser, defineBackground } from '#imports';
import { isCachedStatsRequest, isStatsPushMessage } from '@/shared/types/messaging';
import type { StatusPayload } from '@/shared/types/messaging';

const statsByTab = new Map<number, StatusPayload>();

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (isStatsPushMessage(message) && sender.tab?.id !== undefined) {
      const tabId = sender.tab.id;
      statsByTab.set(tabId, message.payload);

      try {
        void browser.runtime
          .sendMessage({ type: 'xrawl/stats-broadcast', tabId, payload: message.payload })
          .catch(() => undefined);
      } catch {
        // No popup open; broadcasting has no listener.
      }

      sendResponse({ ok: true, data: null });
      return false;
    }

    if (isCachedStatsRequest(message)) {
      sendResponse({ ok: true, data: statsByTab.get(message.tabId) ?? null });
      return false;
    }

    return false;
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    statsByTab.delete(tabId);
  });
});
