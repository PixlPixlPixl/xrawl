/**
 * Hunting priorities: which word is worth chasing right now.
 *
 * This is deliberately separate from the reward formula. Reward answers "how
 * much is this eating worth"; hunting answers "which of these words do I want".
 * Keeping them apart means tuning what the creature chases cannot inflate XP.
 *
 * Exploration is part of the priority, not a random roll: a word's own stable
 * hash decides whether it is an exploration pick, so the same page always
 * produces the same decision. The creature therefore occasionally eats
 * something unrelated to its interests without ever becoming unpredictable.
 */
import { clamp01 } from './numbers';
import { profileScore, type InterestProfile, type SemanticVector } from './semantics';
import { stableUnit } from '@/shared/id';

export const HUNT_CONFIG = {
  /** Share of the priority that comes from learned interests. */
  relevance: 0.6,
  /** Share from words the creature has not eaten before. */
  novelty: 0.25,
  /** Share from intrinsic rarity (the frequency table). */
  rarity: 0.15,
  /** Fraction of words treated as exploration picks, by stable hash. */
  explorationRate: 0.25,
  /** Ceiling added for one of those picks, scaled by how unrelated it is. */
  explorationWeight: 0.35,
} as const;

export interface HuntInput {
  readonly word: string;
  readonly embedding: SemanticVector;
  readonly profiles: readonly InterestProfile[];
  /** How many times this word has already been eaten (0 = novel). */
  readonly timesEaten: number;
  /** 0..1 from the frequency table; unknown words are neutral. */
  readonly rarity: number;
}

export interface HuntPlan {
  readonly relevance: number;
  readonly novelty: number;
  readonly rarity: number;
  readonly exploration: number;
  readonly priority: number;
}

/** Deterministic exploration: the word itself decides, never a clock. */
export function explorationUnits(word: string): number {
  return stableUnit(word);
}

export function isExplorationWord(word: string): boolean {
  return stableUnit(word) < HUNT_CONFIG.explorationRate;
}

/**
 * Score one candidate.
 *
 * An exploration pick is boosted by how *unrelated* it is, which is what keeps
 * the creature from reinforcing its own choices forever: a word that resembles
 * an existing interest is not an exploration victory.
 */
export function planHunt(input: HuntInput): HuntPlan {
  const relevance = profileScore(input.profiles, input.embedding);
  const novelty = 1 / (1 + Math.max(0, input.timesEaten));
  const rarity = clamp01(input.rarity);
  const exploration = isExplorationWord(input.word)
    ? HUNT_CONFIG.explorationWeight * (1 - relevance)
    : 0;

  const base =
    HUNT_CONFIG.relevance * relevance +
    HUNT_CONFIG.novelty * novelty +
    HUNT_CONFIG.rarity * rarity;

  return { relevance, novelty, rarity, exploration, priority: clamp01(base + exploration) };
}

/** Priority for a word whose vector is unavailable (still novel/rare aware). */
export function planHuntWithoutEmbedding(input: {
  word: string;
  timesEaten: number;
  rarity: number;
}): HuntPlan {
  return planHunt({ ...input, embedding: [], profiles: [] });
}
