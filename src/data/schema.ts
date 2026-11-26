/**
 * Persistence schema: row shapes, table names, and index declarations.
 *
 * This module is deliberately free of Dexie and browser imports. Anything that
 * needs the record *types* (protocol guards, UI, export envelopes) can depend on
 * it, and a desktop host can serialize the same rows without knowing the store.
 *
 * Index strings follow Dexie's `version().stores()` syntax: the first token is
 * the primary key, `[a+b]` is a compound index. Timestamp fields use `0` for
 * "never" instead of `null` because IndexedDB does not index `null` keys —
 * `sessions.withEnd(0)` must remain queryable.
 */
import type { EnvironmentKind } from '@/shared/types/page';
import type { FeedingSource } from './observation';
import type { InterestKind } from '@/progression/interests';
import { stableKey } from '@/shared/id';

export const XRAWL_DB_NAME = 'xrawl';

export const XRAWL_TABLE_SCHEMAS = {
  creatures: 'id, bornAt, updatedAt, stage',
  vocabulary: 'word, timesSeen, timesEaten, firstSeenAt, lastSeenAt, firstEatenAt, lastEatenAt',
  feedingEvents: 'id, eatenAt, word, creatureId, environment, [creatureId+eatenAt], [word+eatenAt]',
  environments: 'id, kind, exposureMs, lastExposedAt',
  sessions: 'id, startedAt, lastActiveAt, endedAt',
  upgrades: 'id, purchasedAt, updatedAt',
  progression: 'id, updatedAt, level',
  personality: 'id, kind, updatedAt, [kind+updatedAt]',
  embeddings: 'id, model, subjectType, subjectId, sourceHash, updatedAt, [model+subjectType+subjectId]',
  interestProfiles: 'id, category, weight, updatedAt',
  interestOverrides: 'host, updatedAt',
} as const satisfies Record<string, string>;

export const XRAWL_TABLE_NAMES = Object.keys(XRAWL_TABLE_SCHEMAS) as XrawlTableName[];

export type XrawlTableName = keyof typeof XRAWL_TABLE_SCHEMAS;

/* ------------------------------------------------------------------------- */
/* creatures                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Species/genetic input.
 *
 * Only the *inputs* are stored. Appearance and attributes are pure projections
 * of this plus purchase levels, recomputed at load — a stored rendered colour
 * could disagree with its own genetics after an evolution.
 */
export interface CreatureGeneticsRecord {
  bodyWidth: number;
  bodyHeight: number;
  bodySegments: number;
  limbCount: number;
  limbSegments: number;
  limbReach: number;
  jointSize: number;
  strokeWidth: number;
  hue: number;
  saturation: number;
  lightness: number;
  accentShift: number;
  agility: number;
  metabolism: number;
  perception: number;
  reach: number;
  capacity: number;
}

/**
 * Core creature row.
 *
 * Three separate concepts live here, deliberately unmerged:
 *  - `species` / `genetics` — physical construction (evolution rewrites these);
 *  - purchases live in the `upgrades` table (progression rewrites those);
 *  - `state` — live gameplay values (stomach fill, satiety), an open namespace
 *    so tuning a value never forces a migration.
 */
export interface CreatureRecord {
  id: string;
  name: string;
  species: string;
  stage: string;
  bornAt: number;
  updatedAt: number;
  genetics: CreatureGeneticsRecord;
  state: Record<string, number>;
}

/* ------------------------------------------------------------------------- */
/* vocabulary                                                                 */
/* ------------------------------------------------------------------------- */

export interface VocabularyRecord {
  /** Normalized dictionary form (NFKC, lowercase) — the primary key. */
  word: string;
  timesSeen: number;
  timesEaten: number;
  firstSeenAt: number;
  lastSeenAt: number;
  /** 0 when never eaten. */
  firstEatenAt: number;
  lastEatenAt: number;
  /** Where the word has been encountered, keyed by environment kind. */
  environments: Partial<Record<EnvironmentKind, number>>;
}

/* ------------------------------------------------------------------------- */
/* feedingEvents                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Immutable log: one row per individual eating event. Progression, personality,
 * and the vocabulary counters are all derived/reconcilable from this log, which
 * is why feeding never overwrites history.
 */
export interface FeedingEventRecord {
  id: string;
  creatureId: string;
  word: string;
  eatenAt: number;
  environment: EnvironmentKind;
  pageUrl: string;
  pageTitle: string;
  /** Sentence the word was perceived in, for context-aware cognition later. */
  contextSentence: string;
  /** Hash of the sentence, so repeats of the same context can be discounted. */
  contextHash: string;
  /** `WordTarget.fingerprint` of the eaten target. */
  fingerprint: string;
  /** Who chose the word: the user, or the creature's own foraging. */
  source: FeedingSource;
  /** Event-local scoring inputs; interpretation belongs to progression, not data. */
  nutrition: number;
  preferenceDelta: number;
}

/* ------------------------------------------------------------------------- */
/* environments                                                               */
/* ------------------------------------------------------------------------- */

/** One row per (environment kind, host) bucket: `${kind}:${host}`. */
export interface EnvironmentRecord {
  id: string;
  kind: EnvironmentKind;
  host: string;
  exposureMs: number;
  visits: number;
  observations: number;
  wordsSeen: number;
  uniqueWords: number;
  firstExposedAt: number;
  lastExposedAt: number;
}

/* ------------------------------------------------------------------------- */
/* sessions                                                                   */
/* ------------------------------------------------------------------------- */

/** One row per content-session (a single injected page lifetime). */
export interface SessionRecord {
  id: string;
  startedAt: number;
  lastActiveAt: number;
  /** 0 while the session is open. */
  endedAt: number;
  /** Only counted while the document is visible. */
  activeMs: number;
  observations: number;
  pageVisits: number;
  wordsSeen: number;
  feedingCount: number;
  /** Time spent per environment kind, in ms. */
  environments: Partial<Record<EnvironmentKind, number>>;
}

/* ------------------------------------------------------------------------- */
/* upgrades                                                                   */
/* ------------------------------------------------------------------------- */

export interface UpgradeRecord {
  /** Upgrade key, e.g. `metabolism.chew` — stable across purchases. */
  id: string;
  level: number;
  purchasedAt: number;
  updatedAt: number;
  totalSpent: number;
  meta: Record<string, number | string | boolean>;
}

/* ------------------------------------------------------------------------- */
/* progression                                                                */
/* ------------------------------------------------------------------------- */

/**
 * Running totals for one creature: the two currencies and the history the
 * reward formula scores against.
 *
 * Level is stored for indexing but is always *derived* from `xp` - a row whose
 * level disagrees with its XP is repaired by the next award. Environment counts
 * are kept here (rather than counted from the feeding log) so an award is one
 * read-write of one row, and so the affinity term is reproducible from the row
 * alone.
 */
export interface ProgressionRecord {
  /** Creature id - progression is per creature, not per player. */
  id: string;
  /** Total experience ever earned. */
  xp: number;
  /** Derived from `xp`; stored for indexes and cheap reads. */
  level: number;
  /** Spendable word points (unspent balance). */
  wordPoints: number;
  /** Points earned over all time, spent or not. */
  lifetimeWordPoints: number;
  /** Points consumed by upgrades. */
  spentWordPoints: number;
  feedings: number;
  discoveries: number;
  /** Feedings per environment kind: the raw history, kept for auditing. */
  environments: Partial<Record<EnvironmentKind, number>>;
  /**
   * Normalized environment affinity, always summing to 1 (a 100% pool shared
   * between every environment kind). Scoring reads this rather than a per-
   * environment score, so favour shifts between environments instead of
   * accumulating in several places at once.
   */
  affinities: Partial<Record<EnvironmentKind, number>>;
  /**
   * Interests developed by *browsing* (0..1 per interest, decayed lazily from
   * `interestsUpdatedAt`). Kept here rather than in the embedding profile pool
   * because it must work with no model at all.
   */
  interests: Partial<Record<InterestKind, number>>;
  interestsUpdatedAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------------- */
/* personality                                                                */
/* ------------------------------------------------------------------------- */

export type PersonalityKind = 'trait' | 'interest' | 'preference';

/** One row per learned tendency: `${kind}:${key}`. */
export interface PersonalityRecord {
  id: string;
  kind: PersonalityKind;
  key: string;
  /** Normalized to -1..1; interpretation is the creature engine's business. */
  value: number;
  confidence: number;
  sampleCount: number;
  updatedAt: number;
  lastEvidenceAt: number;
}

/* ------------------------------------------------------------------------- */
/* embeddings                                                                 */
/* ------------------------------------------------------------------------- */

export type EmbeddingSubjectType = 'word' | 'context' | 'environment' | 'personality';

/**
 * Cached contextual vector. Model identity and dimensionality are stored on the
 * row so a model swap is a new key, never a silent reinterpretation of old data.
 */
export interface EmbeddingRecord {
  id: string;
  subjectType: EmbeddingSubjectType;
  subjectId: string;
  model: string;
  dimensions: number;
  vector: number[];
  normalized: boolean;
  sourceHash: string;
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------------- */
/* interest overrides                                                         */
/* ------------------------------------------------------------------------- */

/**
 * A user's explicit answer to "what is this site about?".
 *
 * Hosts are keyed without `www.`, lowercase, so `github.com` and
 * `www.github.com` are one override. Absence means "use the classifier", which
 * is why deleting a row is how you hand a site back to automatic.
 */
export interface InterestOverrideRecord {
  host: string;
  interest: InterestKind;
  updatedAt: number;
}

/* ------------------------------------------------------------------------- */
/* interest profiles                                                          */
/* ------------------------------------------------------------------------- */

/**
 * One learned interest vector.
 *
 * `model` and `dimensions` are stored on the row, not assumed: a profile learned
 * on the lexical fallback must never be compared with a MiniLM vector, so a
 * model change is a rebuild rather than a silent mix. `weight` is this profile's
 * share of the attention pool, and all rows sum to 1.
 */
export interface InterestProfileRecord {
  /** Category key, e.g. `technology` or `general`. */
  id: string;
  category: string;
  model: string;
  dimensions: number;
  vector: number[];
  weight: number;
  observations: number;
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------------- */
/* key helpers                                                                */
/* ------------------------------------------------------------------------- */

export function environmentBucketId(kind: EnvironmentKind, host: string): string {
  return `${kind}:${host}`;
}

/**
 * Include the model *and* its dimensions in the row id: switching to a model
 * that happens to share a name but not a width can never collide with old rows.
 */
export function buildEmbeddingId(
  model: string,
  dimensions: number,
  subjectType: EmbeddingSubjectType,
  sourceHash: string,
): string {
  return stableKey('embedding', model, dimensions, subjectType, sourceHash);
}

/** Hosts are compared without `www.`, lowercase, and without a port. */
export function interestOverrideId(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, '').split(':')[0]!;
}

export function interestProfileId(category: string): string {
  return category;
}

export function personalityId(kind: PersonalityKind, key: string): string {
  return `${kind}:${key}`;
}
