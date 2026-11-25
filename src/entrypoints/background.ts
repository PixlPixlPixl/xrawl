/**
 * Background worker.
 *
 * Two responsibilities:
 *  - Cache and relay scan stats per tab for the popup (milestone 1).
 *  - Own the game database (all persistence lives here, never in a content
 *    script that shares the page's origin).
 *
 * Persistence requests are handled behind a shape guard and answered async, so
 * the service worker keeps its message channel open (`return true`) while a
 * transaction runs.
 */
import { browser, defineBackground } from '#imports';
import { createDatabaseService, type DatabaseService } from '@/data/service';
import { markDatabaseCreated } from '@/platform/browser/resilience';
import {
  isCachedStatsRequest,
  isCreatureLoadoutRequest,
  isDatabaseExportRequest,
  isDatabaseImportRequest,
  isDatabaseStatusRequest,
  isFeedMessage,
  isObserveMessage,
  isStatsPushMessage,
} from '@/shared/types/messaging';
import type { StatusPayload, XrawlResponse } from '@/shared/types/messaging';

const statsByTab = new Map<number, StatusPayload>();

const ok = <T>(data: T): XrawlResponse<T> => ({ ok: true, data });
const fail = (error: unknown): XrawlResponse<never> => ({
  ok: false,
  error: error instanceof Error ? error.message : String(error),
});

export default defineBackground(() => {
  const database: DatabaseService = createDatabaseService({
    appVersion: browser.runtime.getManifest().version,
    // Static extension storage outlives a wiped IndexedDB, so the popup can tell
    // the difference between a fresh install and lost history.
    onOpened: (now) => {
      void markDatabaseCreated(now);
    },
  });

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

    if (isObserveMessage(message)) {
      void database
        .ingestObservation(message.payload)
        .then((result) => sendResponse(ok(result)))
        .catch((error: unknown) => {
          console.warn('[xrawl] observation write failed', (error as Error)?.stack ?? String(error));
          sendResponse(fail(error));
        });
      return true;
    }

    if (isFeedMessage(message)) {
      void database
        .ingestFeeding(message.payload)
        .then((written) => {
          if (!written) sendResponse(fail('invalid feeding payload'));
          else sendResponse(ok(null));
        })
        .catch((error: unknown) => {
          console.warn('[xrawl] feeding write failed', (error as Error)?.stack ?? String(error));
          sendResponse(fail(error));
        });
      return true;
    }

    if (isCreatureLoadoutRequest(message)) {
      void database
        .creatureLoadout()
        .then((loadout) => sendResponse(ok(loadout)))
        .catch((error: unknown) => sendResponse(fail(error)));
      return true;
    }

    if (isDatabaseStatusRequest(message)) {
      void database
        .status()
        .then((status) => sendResponse(ok(status)))
        .catch((error: unknown) => sendResponse(fail(error)));
      return true;
    }

    if (isDatabaseExportRequest(message)) {
      void database
        .exportAll()
        .then((envelope) => sendResponse(ok(envelope)))
        .catch((error: unknown) => sendResponse(fail(error)));
      return true;
    }

    if (isDatabaseImportRequest(message)) {
      void database
        .importAll(message.envelope)
        .then((result) => sendResponse(ok(result)))
        .catch((error: unknown) => sendResponse(fail(error)));
      return true;
    }

    return false;
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    statsByTab.delete(tabId);
  });
});
