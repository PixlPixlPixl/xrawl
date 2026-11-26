/**
 * Deterministic feeding reward.
 *
 * One number, five capped parts:
 *
 *   R = B + L + F + N + E + P
 *
 *   B  base reward for any word at all
 *   L  word-length bonus (longer word, more effort)
 *   F  frequency/rarity bonus (rarer word, more reward)
 *   N  discovery bonus (first time this word is eaten; smaller on repeats)
 *   E  environment affinity (share of history in this environment)
 *   P  personality affinity (the creature's learned interests/preferences)
 *
 * Every part has its own cap. Without them one gigantic, unusual word could
 * out-earn a whole page of normal ones and make everything else noise.
 *
 * No randomness, no clocks, no database: the same inputs always produce the
 * same breakdown, which is what makes stored totals auditable.
 */
import type { EnvironmentKind } from '@/shared/types/page';
import { UNKNOWN_WORD_RARITY, rarityScore, wordRarity } from './frequency';
import { clamp, round2 } from './numbers';

export interface RewardConfig {
  readonly base: number;
  readonly length: { readonly perCharacter: number; readonly afterCharacters: number; readonly cap: number };
  readonly rarity: { readonly weight: number; readonly cap: number };
  readonly discovery: { readonly first: number; readonly repeat: number; readonly repeatFloor: number };
  /**
   * Environment affinity is paid from one shared pool: every environment's
   * share of the pool is its share of the creature's diet. The pool is larger
   * than the old flat bonus so a genuinely dominant environment is worth
   * noticing, and `normalizer` scales it back down so a 100% favourite is a
   * moderate increase instead of a runaway multiplier.
   */
  readonly environment: {
    /** Points available to the whole distribution. */
    readonly pool: number;
    /** How much of the pool a 100% share actually pays (pool x normalizer = cap). */
    readonly normalizer: number;
    readonly cap: number;
  };
  readonly personality: { readonly weight: number; readonly cap: number };
  /** Fraction of the reward that becomes spendable word points. */
  readonly wordPointShare: number;
}

export const REWARD_CONFIG: RewardConfig = {
  base: 4,
  length: { perCharacter: 0.75, afterCharacters: 2, cap: 6 },
  rarity: { weight: 8, cap: 8 },
  discovery: { first: 12, repeat: 4, repeatFloor: 1 },
  environment: { pool: 10, normalizer: 0.5, cap: 5 },
  personality: { weight: 4, cap: 4 },
  wordPointShare: 0.5,
};

export interface RewardInput {
  /** Normalized dictionary form (lowercase, no edge punctuation). */
  readonly word: string;
  readonly environment: EnvironmentKind;
  /** True only the first time this creature eats this word. */
  readonly isNewDiscovery: boolean;
  /** How many times the word had been eaten before this feeding. */
  readonly priorEats: number;
  /**
   * 0..1 share of the environment affinity pool (sums to 100% across all
   * environments). Ignored when out of range.
   */
  readonly environmentShare: number;
  /** -1..1 from personalityAffinity(). */
  readonly personalityAffinity: number;
  /**
   * Zipf frequency override. Omitted: look it up in the local table.
   * Null: the caller already knows the word is unknown to the table.
   */
  readonly zipf?: number | null;
}

export interface RewardBreakdown {
  readonly base: number;
  readonly length: number;
  readonly rarity: number;
  readonly discovery: number;
  readonly environment: number;
  readonly personality: number;
  /** B + L + F + N + E + P, rounded to two decimals. */
  readonly total: number;
  /** Total experience added to the creature. */
  readonly xp: number;
  /** Word points added to the upgrade wallet. */
  readonly wordPoints: number;
  /** Share of the environment pool this feeding drew on (0..1). */
  readonly environmentShare: number;
  readonly rarityScore: number;
  readonly zipf: number | null;
  readonly knownWord: boolean;
}

function lengthBonus(word: string, config: RewardConfig['length']): number {
  // Count code points, not UTF-16 units, so an emoji counts as one character.
  const characters = [...word].length;
  const bonus = config.perCharacter * Math.max(0, characters - config.afterCharacters);
  return Math.min(config.cap, round2(bonus));
}

function discoveryBonus(input: RewardInput, config: RewardConfig['discovery']): number {
  if (input.isNewDiscovery) return config.first;
  const repeats = Math.max(0, Math.floor(input.priorEats) - 1);
  return Math.max(config.repeatFloor, config.repeat - repeats);
}

export function computeReward(input: RewardInput, config: RewardConfig = REWARD_CONFIG): RewardBreakdown {
  const word = input.word;
  const known = input.zipf === undefined ? wordRarity(word) : null;
  const zipf = input.zipf === undefined ? known!.zipf : input.zipf;
  const rarity = zipf === null ? UNKNOWN_WORD_RARITY : rarityScore(zipf);

  const base = config.base;
  const length = lengthBonus(word, config.length);
  const rarityBonus = Math.min(config.rarity.cap, round2(config.rarity.weight * rarity));
  const discovery = discoveryBonus(input, config.discovery);
  const environmentBonus = Math.min(
    config.environment.cap,
    round2(
      config.environment.pool *
        config.environment.normalizer *
        clamp(input.environmentShare, 0, 1),
    ),
  );
  const personalityBonus = Math.min(
    config.personality.cap,
    round2(config.personality.weight * clamp(input.personalityAffinity, 0, 1)),
  );

  const total = round2(base + length + rarityBonus + discovery + environmentBonus + personalityBonus);

  return {
    base,
    length,
    rarity: rarityBonus,
    discovery,
    environment: environmentBonus,
    personality: personalityBonus,
    total,
    environmentShare: clamp(input.environmentShare, 0, 1),
    xp: Math.round(total),
    wordPoints: Math.floor(total * config.wordPointShare + 1e-9),
    rarityScore: rarity,
    zipf,
    knownWord: zipf !== null,
  };
}

