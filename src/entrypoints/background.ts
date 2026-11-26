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
  isPrioritizeRequest,
  isStatsPushMessage,
  isUpgradePurchaseRequest,
} from '@/shared/types/messaging';
import type {
  PrioritizePayload,
  StatusPayload,
  UpgradePurchasePayload,
  XrawlResponse,
} from '@/shared/types/messaging';
import type { PurchaseOutcome } from '@/data/progression';

const statsByTab = new Map<number, StatusPayload>();

const ok = <T>(data: T): XrawlResponse<T> => ({ ok: true, data });

/**
 * Flattens a purchase outcome into the small payload the popup renders.
 *
 * The data layer's outcome carries whole rows (upgrade record, definition);
 * the popup only needs the numbers and the reason nothing happened.
 */
function purchasePayload(outcome: PurchaseOutcome): UpgradePurchasePayload {
  if (outcome.ok) {
    return {
      purchased: true,
      upgradeId: outcome.upgradeId,
      level: outcome.upgrade.level,
      cost: outcome.cost,
      wordPoints: outcome.progression.wordPoints,
    };
  }

  return {
    purchased: false,
    reason: outcome.reason,
    upgradeId: outcome.upgradeId,
    level: outcome.level,
    cost: outcome.cost,
    wordPoints: outcome.balance,
  };
}
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
        .then((result) => {
          sendResponse(ok(result));
          // Environment learning is derived from accumulated session time, so it
          // runs after the write rather than inside it. It may fail quietly:
          // preferences are not worth losing an observation over.
          if (result.exposureSteps > 0) {
            void database
              .learnFromExposure(
                message.payload.environment,
                message.payload.host,
                result.exposureSteps,
              )
              .catch((error: unknown) => {
                console.warn('[xrawl] exposure learning skipped', String(error));
              });
          }
        })
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
          if (!written) {
            sendResponse(fail('invalid feeding payload'));
            return;
          }
          sendResponse(ok(null));
          // Cognition runs after the feeding transaction commits: the event is
          // already durable, and embedding is the slow part on a phone.
          void database.learnFromFeeding(message.payload).catch((error: unknown) => {
            console.warn('[xrawl] feeding cognition skipped', String(error));
          });
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

    if (isPrioritizeRequest(message)) {
      void database
        .prioritize(message.words)
        .then((result) => {
          const payload: PrioritizePayload = { model: result.model, priorities: result.priorities };
          sendResponse(ok(payload));
        })
        .catch((error: unknown) => sendResponse(fail(error)));
      return true;
    }

    if (isUpgradePurchaseRequest(message)) {
      void database
        .purchaseUpgrade(message.upgradeId)
        .then((outcome) => sendResponse(ok(purchasePayload(outcome))))
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
