import { INTEREST_KINDS } from '@/progression/interests';
import { isCreatureMode, type CreatureMode } from './creature';
import type { EnvironmentKind, EnvironmentClassification, PageInfo } from './page';
import type { ScanStats, WorldSnapshot } from './word-target';

/** How the creature is currently being driven in this tab. */
export interface CreatureStatusPayload {
  readonly mode: CreatureMode;
  /** True while clicks feed words instead of reaching the page. */
  readonly feedingMode: boolean;
  /** Companion trailing distance behind the pointer, in CSS px. */
  readonly trailingDistance: number;
}

export interface StatusPayload {
  readonly stats: ScanStats;
  readonly page: PageInfo;
  readonly environment: EnvironmentClassification;
  /** Whether the in-page outline overlay is currently shown. */
  readonly overlayVisible: boolean;
  readonly creature: CreatureStatusPayload;
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
  /** Switch the creature between companion and foraging behaviour. */
  | { readonly type: 'xrawl/set-mode'; readonly mode: CreatureMode }
  /** Toggle the modal "click a word to feed it" selection mode. */
  | { readonly type: 'xrawl/set-feeding-mode'; readonly active: boolean }
  | { readonly type: 'xrawl/set-trailing'; readonly distance: number }
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
    /** Set only when the user picked the word themselves. */
    readonly source?: 'manual' | 'autonomous';
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
  readonly progression: {
    readonly level: number;
    readonly xp: number;
    readonly xpForNextLevel: number;
    readonly wordPoints: number;
    readonly lifetimeWordPoints: number;
    readonly discoveries: number;
    readonly feedings: number;
    /** Environment affinity distribution, summing to 1 (rounded for display). */
    readonly affinities: Readonly<Partial<Record<string, number>>>;
    /** Browsing interests, decayed to now; the non-AI environment channel. */
    readonly interests: ReadonlyArray<{ readonly interest: string; readonly weight: number }>;
  };
  /** Model state and learned attention shares (empty until something is eaten). */
  readonly semantics: {
    readonly state: 'idle' | 'loading' | 'ready' | 'fallback';
    readonly model: string;
    readonly profiles: ReadonlyArray<{ readonly category: string; readonly share: number }>;
    readonly embeddingCount: number;
  };
  readonly upgrades: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly category: 'locomotion' | 'metabolism' | 'senses';
    readonly level: number;
    readonly maxLevel: number;
    readonly nextCost: number;
    readonly affordable: boolean;
  }>;
}

/** popup → background: what this site currently teaches, and its options. */
export interface SiteInterestRequest {
  readonly type: 'xrawl/site-interest';
  readonly host: string;
  readonly environment: EnvironmentKind;
}

export interface SiteInterestPayload {
  readonly host: string;
  /** The user's override, or null when the site is classified automatically. */
  readonly override: string | null;
  readonly interests: ReadonlyArray<{ readonly interest: string; readonly weight: number }>;
  /** Every category, so the popup does not hardcode the list. */
  readonly kinds: ReadonlyArray<{ readonly id: string; readonly label: string }>;
}

/** popup → background: set or clear (null) one host's interest override. */
export interface SetSiteInterestRequest {
  readonly type: 'xrawl/set-site-interest';
  readonly host: string;
  readonly interest: string | null;
}

export interface SetSiteInterestPayload {
  readonly host: string;
  readonly override: string | null;
}

/** content → background: rank candidate words for hunting. */
export interface PrioritizeRequest {
  readonly type: 'xrawl/prioritize';
  readonly words: ReadonlyArray<{ readonly word: string; readonly sentence?: string }>;
}

/** background → content: one priority per requested word, in request order. */
export interface PrioritizePayload {
  readonly model: string;
  readonly priorities: ReadonlyArray<{
    readonly word: string;
    /** 0..1; higher means the creature would rather eat this word. */
    readonly priority: number;
    readonly relevance: number;
    readonly novelty: number;
    /** 0..1 rarity from the local frequency table. */
    readonly rarity: number;
    /** 0..1 browsing interest for this word's subject. */
    readonly interest: number;
    readonly exploration: number;
  }>;
}

/** popup → background: buy the next level of one upgrade with word points. */
export interface UpgradePurchaseRequest {
  readonly type: 'xrawl/purchase-upgrade';
  readonly upgradeId: string;
}

/** background → popup: the outcome of a purchase attempt. */
export interface UpgradePurchasePayload {
  readonly purchased: boolean;
  readonly reason?: 'unknown-upgrade' | 'max-level' | 'insufficient-points';
  readonly upgradeId: string;
  readonly level: number;
  /** Price that was (or would have been) charged. */
  readonly cost: number;
  /** Word point balance after the attempt. */
  readonly wordPoints: number;
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
  | PrioritizeRequest
  | SiteInterestRequest
  | SetSiteInterestRequest
  | DatabaseStatusRequest
  | DatabaseExportRequest
  | DatabaseImportRequest
  | CreatureLoadoutRequest
  | UpgradePurchaseRequest;

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
    case 'xrawl/set-mode':
      return isCreatureMode(message.mode);
    case 'xrawl/set-feeding-mode':
      return typeof message.active === 'boolean';
    case 'xrawl/set-trailing':
      return typeof message.distance === 'number' && Number.isFinite(message.distance);
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
    (payload.source === undefined ||
      payload.source === 'manual' ||
      payload.source === 'autonomous') &&
    typeof payload.nutrition === 'number' &&
    typeof payload.preferenceDelta === 'number'
  );
}

export function isSiteInterestRequest(message: unknown): message is SiteInterestRequest {
  return (
    isObject(message) &&
    message.type === 'xrawl/site-interest' &&
    typeof message.host === 'string' &&
    message.host.length > 0 &&
    message.host.length <= 255 &&
    isEnvironmentKind(message.environment)
  );
}

export function isSetSiteInterestRequest(message: unknown): message is SetSiteInterestRequest {
  if (!isObject(message) || message.type !== 'xrawl/set-site-interest') return false;
  if (typeof message.host !== 'string' || message.host.length === 0) return false;
  if (message.host.length > 255) return false;
  if (message.interest === null) return true;
  return (
    typeof message.interest === 'string' &&
    (INTEREST_KINDS as readonly string[]).includes(message.interest)
  );
}

export function isPrioritizeRequest(message: unknown): message is PrioritizeRequest {
  if (!isObject(message) || message.type !== 'xrawl/prioritize') return false;
  const words = message.words;
  if (!Array.isArray(words) || words.length === 0) return false;
  return words.every(
    (entry) =>
      isObject(entry) &&
      typeof entry.word === 'string' &&
      entry.word.length > 0 &&
      entry.word.length <= 64 &&
      (entry.sentence === undefined || typeof entry.sentence === 'string'),
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

export function isUpgradePurchaseRequest(message: unknown): message is UpgradePurchaseRequest {
  return (
    isObject(message) &&
    message.type === 'xrawl/purchase-upgrade' &&
    typeof message.upgradeId === 'string' &&
    message.upgradeId.length > 0
  );
}
