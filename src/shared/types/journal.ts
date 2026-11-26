/**
 * Journal contracts: what the history screen asks for and what it receives.
 *
 * The journal is a *reading* surface. It shows URLs, page titles and timestamps
 * rather than screen coordinates (which stop meaning anything once the page
 * reflows), and it never carries full page text: context sentences are only
 * stored when the user opts in (see `journal.storeContext`).
 *
 * These types are shared by the data layer, the background message handlers and
 * the journal page, so the three cannot drift apart.
 */
import type { EnvironmentKind } from './page';

export const ENVIRONMENT_LABELS: Record<EnvironmentKind, string> = {
  article: 'Article',
  docs: 'Documentation',
  code: 'Code',
  forum: 'Forum',
  social: 'Social',
  commerce: 'Shop',
  search: 'Search results',
  video: 'Video',
  email: 'Email',
  unknown: 'Unknown',
};

export function environmentLabel(kind: string): string {
  return ENVIRONMENT_LABELS[kind as EnvironmentKind] ?? kind;
}

/** One site the creature has spent time on. */
export interface JournalEnvironment {
  readonly kind: string;
  readonly host: string;
  readonly label: string;
  /** Focused minutes, of which the share is this site's fraction of all time. */
  readonly exposureMinutes: number;
  readonly visits: number;
  readonly wordsSeen: number;
  /** 0..1 of total exposure. */
  readonly share: number;
}

export interface JournalOverview {
  readonly creatureName: string;
  readonly species: string;
  readonly stage: string;
  readonly level: number;
  readonly xp: number;
  /** 0 at the level cap. */
  readonly xpForNextLevel: number;
  /** XP accumulated inside the current level, and that level's span. */
  readonly intoLevel: number;
  readonly levelSpan: number;
  readonly wordPoints: number;
  readonly lifetimeWordPoints: number;
  /** Feedings, manual and autonomous together. */
  readonly wordsConsumed: number;
  /** Words eaten at least once. */
  readonly uniqueConsumed: number;
  /** Every word ever perceived, eaten or not. */
  readonly uniqueDiscovered: number;
  readonly manualFeedings: number;
  /** Feedings per focused minute of browsing. */
  readonly wordsPerMinute: number;
  readonly activeMinutes: number;
  readonly firstFeedingAt: number;
  readonly lastFeedingAt: number;
  /** Heaviest exposure first, collapsed to the top sites. */
  readonly environments: ReadonlyArray<JournalEnvironment>;
  readonly contextStorage: boolean;
}

/** One row of the feeding log, as the journal renders it. */
export interface JournalFeeding {
  readonly id: string;
  readonly word: string;
  readonly eatenAt: number;
  readonly host: string;
  readonly pageTitle: string;
  readonly pageUrl: string;
  readonly environment: string;
  readonly source: 'manual' | 'autonomous';
  /** Word points paid; 0 for events recorded before rewards were journaled. */
  readonly points: number;
  readonly xp: number;
}

export interface JournalFeedingsPage {
  readonly entries: ReadonlyArray<JournalFeeding>;
  /** Exact when unfiltered; the number of matches scanned when filtered. */
  readonly total: number;
  readonly hasMore: boolean;
}

export interface JournalWord {
  readonly word: string;
  readonly timesSeen: number;
  readonly timesEaten: number;
  /** 0 when the word was never seen/eaten at that end of its history. */
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly firstEatenAt: number;
  readonly lastEatenAt: number;
  /** Sightings per environment kind. */
  readonly environments: Readonly<Partial<Record<string, number>>>;
}

export interface JournalVocabularyPage {
  readonly entries: ReadonlyArray<JournalWord>;
  readonly total: number;
  readonly hasMore: boolean;
}

export interface JournalRelatedWord {
  readonly word: string;
  /** Cosine similarity (semantic) or shared-site strength (fallback), 0..1. */
  readonly similarity: number;
  readonly timesEaten: number;
  /** `semantic` when embeddings were available, `site` when they were not. */
  readonly reason: 'semantic' | 'site';
}

export interface JournalContextSnippet {
  readonly eatenAt: number;
  readonly sentence: string;
}

export interface JournalWordDetail {
  readonly word: JournalWord;
  /** Stored sentences, only present when context storage is enabled. */
  readonly contexts: ReadonlyArray<JournalContextSnippet>;
  readonly feedings: ReadonlyArray<JournalFeeding>;
  /** Sites the word was eaten on, newest first. */
  readonly hosts: ReadonlyArray<string>;
  readonly related: ReadonlyArray<JournalRelatedWord>;
  /** Embedding model the neighbours were computed in, null for the site fallback. */
  readonly model: string | null;
}

export interface JournalSettings {
  readonly contextStorage: boolean;
}

export type JournalFeedingsQuery = {
  readonly view: 'feedings';
  readonly limit?: number;
  readonly offset?: number;
  readonly word?: string;
  readonly host?: string;
  readonly source?: 'manual' | 'autonomous';
};

export type JournalVocabularyQuery = {
  readonly view: 'vocabulary';
  readonly limit?: number;
  readonly offset?: number;
  /** A word prefix, or a site (anything containing a dot). */
  readonly search?: string;
  readonly sort?: 'eaten' | 'recent' | 'alpha';
  /** `eaten` hides words that were only seen. */
  readonly filter?: 'all' | 'eaten';
};

export type JournalQuery =
  | { readonly view: 'overview' }
  | JournalFeedingsQuery
  | JournalVocabularyQuery
  | { readonly view: 'word'; readonly word: string }
  | { readonly view: 'settings' };

export type JournalPayload =
  | JournalOverview
  | JournalFeedingsPage
  | JournalVocabularyPage
  | JournalWordDetail
  | JournalSettings;

export function isJournalQuery(value: unknown): value is JournalQuery {
  if (typeof value !== 'object' || value === null) return false;
  const query = value as Record<string, unknown>;
  switch (query.view) {
    case 'overview':
    case 'settings':
      return true;
    case 'feedings':
      return (
        (query.limit === undefined || typeof query.limit === 'number') &&
        (query.offset === undefined || typeof query.offset === 'number') &&
        (query.word === undefined || typeof query.word === 'string') &&
        (query.host === undefined || typeof query.host === 'string') &&
        (query.source === undefined || query.source === 'manual' || query.source === 'autonomous')
      );
    case 'vocabulary':
      return (
        (query.limit === undefined || typeof query.limit === 'number') &&
        (query.offset === undefined || typeof query.offset === 'number') &&
        (query.search === undefined || typeof query.search === 'string') &&
        (query.sort === undefined ||
          query.sort === 'eaten' ||
          query.sort === 'recent' ||
          query.sort === 'alpha') &&
        (query.filter === undefined || query.filter === 'all' || query.filter === 'eaten')
      );
    case 'word':
      return typeof query.word === 'string' && query.word.length > 0 && query.word.length <= 64;
    default:
      return false;
  }
}
