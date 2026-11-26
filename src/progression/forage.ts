/**
 * Foraging score: which word is worth eating, all things considered.
 *
 *   S(w) = R(w) + N(w) + A(w) + E(w) - C(w)
 *
 *  - R: rarity (the frequency table's reward)
 *  - N: novelty (has it eaten this word before?)
 *  - A: affinity with the creature's learned preference
 *  - E: environment affinity from browsing
 *  - C: travel cost, rising with distance and falling with intelligence
 *
 * Kept apart from `hunting.ts` (which ranks words *before* distance is known) so
 * the same word can be attractive far away and uninteresting next door. The
 * result is deterministic: no clocks, no random numbers, and ties keep scan
 * order.
 */
import { clamp, clamp01 } from './numbers';
import { HUNT_CONFIG } from './hunting';
import { isExplorationWord } from './hunting';

export interface ForagePlan {
  /** R: 0..1 from the word-frequency table. */
  readonly rarity: number;
  /** N: 0..1, 1 for a word never eaten. */
  readonly novelty: number;
  /** A: 0..1 semantic preference from the learned profile pool. */
  readonly affinity: number;
  /** E: 0..1 browsing interest for the word's subject. */
  readonly environment: number;
}

/** The attributes that change *how* the score is computed. */
export interface ForageAttributes {
  readonly detectionRadius: number;
  /** Travel-cost multiplier: low means good selection (intelligence). */
  readonly travelCost: number;
  /** How much semantic affinity outweighs the rest (semantic sensitivity). */
  readonly semanticSensitivity: number;
  /** Fraction of words treated as exploration picks (curiosity). */
  readonly explorationRate: number;
}

export interface ForageCandidate {
  readonly word: string;
  readonly point: { readonly x: number; readonly y: number };
  readonly plan: ForagePlan;
}

export interface ForageScore {
  readonly score: number;
  readonly reward: number;
  readonly novelty: number;
  readonly affinity: number;
  readonly environment: number;
  readonly travel: number;
  readonly exploration: number;
}

export const FORAGE_CONFIG = {
  /** Weights of each term in S(w). Cost is subtracted, the rest added. */
  reward: 0.15,
  novelty: 0.2,
  affinity: 0.3,
  environment: 0.2,
  travel: 0.5,
  /**
   * Ceiling for C(w). Without one, distance would either be ignored past the
   * detection radius (if the ratio were clamped) or grow without bound and
   * freeze the creature in place. 1.5 is above every positive term, so a
   * sufficiently distant word can genuinely be rejected.
   */
  maxCost: 1.5,
  /** Ceiling for the exploration bonus, shared with hunting. */
  exploration: HUNT_CONFIG.explorationWeight,
  /** Affinity is multiplied by this, clamped, so sensitivity stays readable. */
  sensitivityFloor: 0.5,
  sensitivityCeiling: 3,
} as const;

/**
 * C(w): quadratic in distance, so a word twice as far costs four times as much.
 *
 * Quadratic rather than linear on purpose: walking is cheap for a nearby word,
 * expensive for one across the page, which is what makes a *smart* creature
 * choose differently from a fast one.
 */
export function travelCost(
  distance: number,
  detectionRadius: number,
  weight: number,
): number {
  const span = Math.max(1, detectionRadius);
  const ratio = Number.isFinite(distance) ? Math.max(0, distance) / span : 1;
  const cost = Math.max(0, weight) * FORAGE_CONFIG.travel * ratio * ratio;
  return Math.min(FORAGE_CONFIG.maxCost, cost);
}

/**
 * Exploration bonus: the same deterministic hash as hunting, but the *rate*
 * comes from curiosity, so buying curiosity literally makes the creature try
 * more unfamiliar words.
 */
export function explorationBonus(
  word: string,
  affinity: number,
  environment: number,
  rate: number,
): number {
  const chance = clamp(rate, 0, 1);
  if (!isExplorationWord(word, chance)) return 0;
  return FORAGE_CONFIG.exploration * (1 - Math.max(clamp01(affinity), clamp01(environment)));
}

export function forageScore(
  candidate: ForageCandidate,
  distance: number,
  attributes: ForageAttributes,
): ForageScore {
  const plan = candidate.plan;
  const reward = FORAGE_CONFIG.reward * clamp01(plan.rarity);
  const novelty = FORAGE_CONFIG.novelty * clamp01(plan.novelty);
  const affinity =
    FORAGE_CONFIG.affinity *
    clamp(attributes.semanticSensitivity, FORAGE_CONFIG.sensitivityFloor, FORAGE_CONFIG.sensitivityCeiling) *
    clamp01(plan.affinity);
  const environment = FORAGE_CONFIG.environment * clamp01(plan.environment);
  const travel = travelCost(distance, attributes.detectionRadius, attributes.travelCost);
  const exploration = explorationBonus(
    candidate.word,
    plan.affinity,
    plan.environment,
    attributes.explorationRate,
  );

  return {
    score: reward + novelty + affinity + environment + exploration - travel,
    reward,
    novelty,
    affinity,
    environment,
    travel,
    exploration,
  };
}

/**
 * Best candidate by S(w) within `radius`.
 *
 * `Infinity` is allowed and means "anywhere on the page", which is how foraging
 * resumes after the creature has wandered: cost still discourages the far ones,
 * it just does not forbid them.
 */
export function selectForageTarget<T extends ForageCandidate>(
  candidates: readonly T[],
  origin: { readonly x: number; readonly y: number },
  attributes: ForageAttributes,
  radius = Infinity,
): { candidate: T; score: ForageScore; distance: number } | null {
  let best: T | null = null;
  let bestScore: ForageScore | null = null;
  let bestDistance = Infinity;

  for (const candidate of candidates) {
    const distance = Math.hypot(candidate.point.x - origin.x, candidate.point.y - origin.y);
    if (distance > radius) continue;

    const score = forageScore(candidate, distance, attributes);
    // Strictly greater keeps scan order on a tie: deterministic selection.
    if (bestScore === null || score.score > bestScore.score) {
      best = candidate;
      bestScore = score;
      bestDistance = distance;
    }
  }

  if (best === null || bestScore === null) return null;
  return { candidate: best, score: bestScore, distance: bestDistance };
}
