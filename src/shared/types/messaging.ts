import type { EnvironmentKind, EnvironmentClassification, PageInfo } from './page';
import type { ScanStats, WorldSnapshot } from './word-target';

export interface StatusPayload {
  readonly stats: ScanStats;
  readonly page: PageInfo;
  readonly environment: EnvironmentClassification;
  /** Whether the in-page outline overlay is currently shown. */
  readonly overlayVisible: boolean;
  readonly capturedAt: number;
}

/** content → background */
export interface StatsPushMessage {
  readonly type: 'xrawl/stats';
  readonly payload: StatusPayload;
}

/** popup → background */
export interface CachedStatsRequest {
  readonly type: 'xrawl/get-cached-stats';
  readonly tabId: number;
}

/** background → popup (+ any other listeners) */
export interface StatsBroadcastMessage {
  readonly type: 'xrawl/stats-broadcast';
  readonly tabId: number;
  readonly payload: StatusPayload;
}

/** popup → content */
export type ContentRequest =
  | { readonly type: 'xrawl/get-stats' }
  | { readonly type: 'xrawl/get-snapshot' }
  | { readonly type: 'xrawl/rescan' }
  | { readonly type: 'xrawl/set-overlay'; readonly visible: boolean }
  | { readonly type: 'xrawl/download-snapshot' };

/* ------------------------------------------------------------------------- */
/* Persistence channel                                                        */
/* ------------------------------------------------------------------------- */

/**
 * content → background: one flush of page activity. `words` are deltas since the
 * previous flush; the background clamps and accumulates them.
 */
export interface ObserveMessage {
  readonly type: 'xrawl/observe';
  readonly payload: {
    readonly sessionId: string;
    readonly capturedAt: number;
    readonly page: { readonly url: string; readonly title: string };
    readonly environment: EnvironmentKind;
    readonly host: string;
    readonly visit: boolean;
    readonly activeMs: number;
    readonly words: ReadonlyArray<{ readonly word: string; readonly count: number }>;
    readonly uniqueWordCount: number;
  };
}

/** content → background: one feeding event. Immutable once written. */
export interface FeedMessage {
  readonly type: 'xrawl/feed';
  readonly payload: {
    readonly sessionId: string;
    readonly creatureId: string;
    readonly word: string;
    readonly eatenAt: number;
    readonly environment: EnvironmentKind;
    readonly pageUrl: string;
    readonly pageTitle: string;
    readonly contextSentence: string;
    readonly fingerprint: string;
    readonly nutrition: number;
    readonly preferenceDelta: number;
  };
}

/** popup → background: database summary. */
export interface DatabaseStatusRequest {
  readonly type: 'xrawl/db-status';
}

/**
 * content → background: the creature's current loadout.
 *
 * The content script never reads the database, so genetics and purchased
 * upgrade levels arrive over messaging and are projected into appearance +
 * attributes there. Derivation is pure, so both sides agree.
 */
export interface CreatureLoadoutRequest {
  readonly type: 'xrawl/creature-loadout';
}

export type CreatureLoadoutPayload = import('@/shared/types/creature').CreatureLoadoutSnapshot;

export interface DatabaseStatusPayload {
  readonly schemaVersion: number;
  readonly creatureId: string;
  readonly vocabularyCount: number;
  readonly feedingCount: number;
  readonly storage: { readonly usage: number; readonly quota: number; readonly persisted: boolean } | null;
}

/** popup → background: whole-database JSON. */
export interface DatabaseExportRequest {
  readonly type: 'xrawl/db-export';
}

/** popup → background: replace tables from an export envelope. */
export interface DatabaseImportRequest {
  readonly type: 'xrawl/db-import';
  readonly envelope: unknown;
}

export type PersistenceRequest =
  | ObserveMessage
  | FeedMessage
  | DatabaseStatusRequest
  | DatabaseExportRequest
  | DatabaseImportRequest
  | CreatureLoadoutRequest;

export interface ExportPayload {
  readonly snapshot: WorldSnapshot;
  readonly truncated: boolean;
  readonly exportedTargetCount: number;
}

export interface DownloadResult {
  readonly bytes: number;
  readonly truncated: boolean;
  readonly count: number;
}

export type XrawlResponse<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: string };

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isContentRequest(message: unknown): message is ContentRequest {
  if (!isObject(message) || typeof message.type !== 'string') return false;
  switch (message.type) {
    case 'xrawl/get-stats':
    case 'xrawl/get-snapshot':
    case 'xrawl/rescan':
    case 'xrawl/download-snapshot':
      return true;
    case 'xrawl/set-overlay':
      return typeof message.visible === 'boolean';
    default:
      return false;
  }
}

export function isStatsPushMessage(message: unknown): message is StatsPushMessage {
  return isObject(message) && message.type === 'xrawl/stats' && isObject(message.payload);
}

export function isCachedStatsRequest(message: unknown): message is CachedStatsRequest {
  return isObject(message) && message.type === 'xrawl/get-cached-stats' && typeof message.tabId === 'number';
}

export function isStatsBroadcast(message: unknown): message is StatsBroadcastMessage {
  return (
    isObject(message) &&
    message.type === 'xrawl/stats-broadcast' &&
    typeof message.tabId === 'number' &&
    isObject(message.payload)
  );
}

/**
 * Guards for the persistence channel. These are the trust boundary: message
 * payloads arrive from a content script that shares a window with page code, so
 * shapes are checked here before the background touches the database.
 */
const ENVIRONMENT_KINDS: readonly EnvironmentKind[] = [
  'article',
  'docs',
  'code',
  'forum',
  'social',
  'commerce',
  'search',
  'video',
  'email',
  'unknown',
];

export function isEnvironmentKind(value: unknown): value is EnvironmentKind {
  return typeof value === 'string' && (ENVIRONMENT_KINDS as readonly string[]).includes(value);
}

export function isObserveMessage(message: unknown): message is ObserveMessage {
  if (!isObject(message) || message.type !== 'xrawl/observe') return false;
  const payload = message.payload;
  if (!isObject(payload)) return false;
  return (
    typeof payload.sessionId === 'string' &&
    payload.sessionId.length > 0 &&
    typeof payload.capturedAt === 'number' &&
    isObject(payload.page) &&
    typeof payload.page.url === 'string' &&
    typeof payload.page.title === 'string' &&
    isEnvironmentKind(payload.environment) &&
    typeof payload.host === 'string' &&
    typeof payload.visit === 'boolean' &&
    typeof payload.activeMs === 'number' &&
    Array.isArray(payload.words) &&
    payload.words.every(
      (entry) =>
        isObject(entry) && typeof entry.word === 'string' && typeof entry.count === 'number',
    ) &&
    typeof payload.uniqueWordCount === 'number'
  );
}

export function isFeedMessage(message: unknown): message is FeedMessage {
  if (!isObject(message) || message.type !== 'xrawl/feed') return false;
  const payload = message.payload;
  if (!isObject(payload)) return false;
  return (
    typeof payload.sessionId === 'string' &&
    typeof payload.creatureId === 'string' &&
    typeof payload.word === 'string' &&
    payload.word.length > 0 &&
    typeof payload.eatenAt === 'number' &&
    isEnvironmentKind(payload.environment) &&
    typeof payload.pageUrl === 'string' &&
    typeof payload.pageTitle === 'string' &&
    typeof payload.contextSentence === 'string' &&
    typeof payload.fingerprint === 'string' &&
    typeof payload.nutrition === 'number' &&
    typeof payload.preferenceDelta === 'number'
  );
}

export function isDatabaseStatusRequest(message: unknown): message is DatabaseStatusRequest {
  return isObject(message) && message.type === 'xrawl/db-status';
}

export function isCreatureLoadoutRequest(message: unknown): message is CreatureLoadoutRequest {
  return isObject(message) && message.type === 'xrawl/creature-loadout';
}

export function isDatabaseExportRequest(message: unknown): message is DatabaseExportRequest {
  return isObject(message) && message.type === 'xrawl/db-export';
}

export function isDatabaseImportRequest(message: unknown): message is DatabaseImportRequest {
  return isObject(message) && message.type === 'xrawl/db-import' && 'envelope' in message;
}
