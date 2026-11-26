/**
 * Affinity inputs for the environment and personality reward terms.
 *
 * Environment affinity is a *distribution*, not a set of independent scores:
 * every environment shares one pool that always sums to 100%. Feeding moves the
 * distribution toward that environment, and the environments it came from lose
 * exactly that much. A creature that eats 60% of its words on technical sites
 * therefore holds ~60% technical affinity, and 60% of the pool is what a
 * technical feeding pays - not a flat favourite bonus.
 *
 * Everything here is pure and deterministic: the distribution after a sequence
 * of feedings is a function of that sequence and a fixed learning rate, so a
 * save file replays to the same affinities.
 */
import type { EnvironmentKind } from '@/shared/types/page';
import type { PersonalityKind } from '@/data/schema';
import { clamp01, clamp11, round2 } from './numbers';

export interface AffinityRecord {
  readonly kind: PersonalityKind;
  readonly key: string;
  readonly value: number;
  readonly confidence: number;
}

/** A normalized distribution of affinity over environment kinds (sums to 1). */
export type EnvironmentAffinities = Partial<Record<EnvironmentKind, number>>;

export const AFFINITY_CONFIG = {
  /**
   * How far one feeding moves the distribution toward that environment.
   *
   * 0.2 means a single feeding claims 20% and the previous mix keeps 80%, so a
   * new habit takes roughly a dozen feedings to dominate. Small enough that the
   * creature has a history, large enough that it is not stuck with it forever.
   */
  learningRate: 0.2,
  /** Shares smaller than this are dropped instead of tracked as dust. */
  pruneBelow: 0.001,
} as const;

/** Keeps a distribution at exactly 100% however it was seeded. */
function normalize(distribution: Partial<Record<string, number>>): EnvironmentAffinities {
  const result: EnvironmentAffinities = {};
  let total = 0;

  for (const [kind, value] of Object.entries(distribution)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    result[kind as EnvironmentKind] = value;
    total += value;
  }

  if (total <= 0) return {};

  for (const [kind, value] of Object.entries(result)) {
    result[kind as EnvironmentKind] = value / total;
  }
  return result;
}

/**
 * Starting distribution from recorded feeding counts.
 *
 * Used for rows written before affinities were stored (and as a repair path if
 * a row's distribution is missing): the lifetime mix is the best estimate the
 * history supports.
 */
export function affinityFromCounts(
  counts: Readonly<Partial<Record<string, number>>> = {},
): EnvironmentAffinities {
  const distribution: Partial<Record<string, number>> = {};
  let total = 0;

  for (const [kind, value] of Object.entries(counts)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    distribution[kind] = value;
    total += value;
  }

  if (total <= 0) return {};
  return normalize(distribution);
}

/**
 * One feeding's effect on the distribution: the fed environment gains the
 * learning rate, every other environment keeps the rest, and the pool is
 * renormalized back to 100%.
 */
export function nextAffinity(
  current: EnvironmentAffinities,
  environment: EnvironmentKind,
  rate: number = AFFINITY_CONFIG.learningRate,
): EnvironmentAffinities {
  const learning = clamp01(rate);
  const keep = 1 - learning;
  const distribution: Partial<Record<string, number>> = {};

  for (const [kind, value] of Object.entries(current)) {
    const decayed = clamp01(value) * keep;
    if (decayed < AFFINITY_CONFIG.pruneBelow) continue;
    distribution[kind] = decayed;
  }

  distribution[environment] = (distribution[environment] ?? 0) + learning;
  return normalize(distribution);
}

/** Share of the pool held by one environment, 0..1. */
export function environmentShare(
  affinities: EnvironmentAffinities,
  environment: EnvironmentKind,
): number {
  const value = affinities[environment];
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return clamp01(value);
}

/** Rounded copy for display surfaces; never used for scoring. */
export function describeAffinities(affinities: EnvironmentAffinities): EnvironmentAffinities {
  const described: EnvironmentAffinities = {};
  for (const [kind, value] of Object.entries(affinities)) {
    described[kind as EnvironmentKind] = round2(value);
  }
  return described;
}

/**
 * Personality affinity in -1..1.
 *
 * Interests are keyed by environment kind; preferences are keyed by word. A
 * trait is a general tendency and has no single subject, so it contributes
 * nothing here. Unlike environment affinity this is *signed* evidence from
 * learned personality rows, not a share of a pool, so it is summed and clamped
 * rather than normalized.
 */
export function personalityAffinity(
  records: readonly AffinityRecord[],
  subject: { readonly word: string; readonly environment: string },
): number {
  let total = 0;
  for (const record of records) {
    if (record.kind === 'interest' && record.key === subject.environment) {
      total += record.value * record.confidence;
    } else if (record.kind === 'preference' && record.key === subject.word) {
      total += record.value * record.confidence;
    }
  }
  return clamp11(total);
}

/** Shortest word that can count as a new discovery. */
export const MIN_DISCOVERY_LENGTH = 2;

/** A word must contain at least one letter to be evidence of vocabulary. */
const HAS_LETTER = /\p{L}/u;

/**
 * Whether eating this word counts as a genuinely new discovery.
 *
 * The content script already segments with Intl.Segmenter and strips edge
 * punctuation, but this is the trust boundary, so it is checked again here:
 *
 *  - a single character ("c" out of "c++", "s" out of a possessive) is too
 *    cheap to farm, and is not vocabulary evidence;
 *  - a token with no letter at all ("123") is a number, not a word;
 *  - whitespace means the caller passed a fragment of a sentence, not a word.
 *
 * Hyphenated compounds arrive as separate segments ("state", "of", "the",
 * "art"); each real component may be a discovery, the raw compound never is.
 */
export function isEligibleDiscoveryWord(word: string): boolean {
  if (word.length < MIN_DISCOVERY_LENGTH) return false;
  if (word.length > 64) return false;
  if (/\s/.test(word)) return false;
  return HAS_LETTER.test(word);
}
