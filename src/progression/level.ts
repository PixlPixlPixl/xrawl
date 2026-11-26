/**
 * Experience and level curve.
 *
 * Pure integer arithmetic: a save file replayed on any engine reaches the same
 * level, and a level is always derived from total XP rather than stored.
 */
import { clamp } from './numbers';

/** Highest level the curve defines. Past it, XP keeps counting but not levels. */
export const MAX_LEVEL = 60;

/** XP needed to advance from a level to the next one. */
export function xpToAdvance(level: number): number {
  const steps = Math.max(0, Math.floor(level) - 1);
  return 30 + 25 * steps + 5 * steps * steps;
}

function buildThresholds(): number[] {
  const thresholds: number[] = [0];
  for (let level = 1; level < MAX_LEVEL; level += 1) {
    thresholds.push(thresholds[level - 1]! + xpToAdvance(level));
  }
  return thresholds;
}

const THRESHOLDS: readonly number[] = buildThresholds();

/** Cumulative XP at which each level begins (index 0 is level 1). */
export function levelThresholds(): readonly number[] {
  return THRESHOLDS;
}

/** Total XP required to reach a level; level 1 is 0 XP. */
export function totalXpForLevel(level: number): number {
  const target = Math.floor(level) - 1;
  if (target <= 0) return 0;
  if (target >= THRESHOLDS.length) return THRESHOLDS[THRESHOLDS.length - 1]!;
  return THRESHOLDS[target]!;
}

export interface LevelProgress {
  readonly level: number;
  /** XP accumulated inside the current level. */
  readonly intoLevel: number;
  /** XP span of the current level. */
  readonly levelSpan: number;
  readonly totalXp: number;
  /** XP still needed for the next level; 0 at MAX_LEVEL. */
  readonly xpForNextLevel: number;
}

export function levelProgress(xp: number): LevelProgress {
  const totalXp = Math.max(0, Math.floor(Number.isFinite(xp) ? xp : 0));
  let level = 1;
  while (level < MAX_LEVEL && totalXp >= THRESHOLDS[level]!) level += 1;

  const base = THRESHOLDS[level - 1]!;
  const span = level >= MAX_LEVEL ? 0 : THRESHOLDS[level]! - base;
  return {
    level,
    intoLevel: totalXp - base,
    levelSpan: span,
    totalXp,
    xpForNextLevel: level >= MAX_LEVEL ? 0 : span - (totalXp - base),
  };
}

export function levelForXp(xp: number): number {
  return levelProgress(xp).level;
}

/**
 * Life stage shown next to the creature. Stages are a *projection* of level,
 * so they never need storing as separate progression state.
 */
const STAGE_BY_LEVEL: ReadonlyArray<{ readonly fromLevel: number; readonly stage: string }> = [
  { fromLevel: 30, stage: 'elder' },
  { fromLevel: 18, stage: 'adult' },
  { fromLevel: 10, stage: 'juvenile' },
  { fromLevel: 4, stage: 'nymph' },
  { fromLevel: 1, stage: 'hatchling' },
];

export function stageForLevel(level: number): string {
  const clamped = clamp(Math.floor(level), 1, MAX_LEVEL);
  for (const entry of STAGE_BY_LEVEL) {
    if (clamped >= entry.fromLevel) return entry.stage;
  }
  return 'hatchling';
}
