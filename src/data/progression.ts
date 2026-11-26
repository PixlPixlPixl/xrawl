/**
 * Progression service: the bridge between a feeding event and the reward math.
 *
 * The arithmetic lives in src/progression (pure, no database); this module is
 * the only place that reads history for it and writes the result back. Both
 * entry points - a feeding and a purchase - are transactional so a reward can
 * never half-apply and points can never be spent without gaining the upgrade.
 */
import type { EnvironmentKind } from '@/shared/types/page';
import { normalizeWord } from '@/shared/text';
import type { ProgressionRecord, UpgradeRecord } from './schema';
import type { XrawlDatabase } from './db';
import { CREATURE_ID, getCreature, putCreature } from './repositories/creature-repository';
import {
  applyProgressionAward,
  ensureProgression,
  getProgression,
  spendWordPoints,
} from './repositories/progression-repository';
import { getUpgrade, purchaseUpgrade } from './repositories/upgrade-repository';
import { listPersonality } from './repositories/personality-repository';
import {
  affinityFromCounts,
  environmentShare,
  isEligibleDiscoveryWord,
  nextAffinity,
  personalityAffinity,
  type EnvironmentAffinities,
} from '@/progression/affinity';
import { stageForLevel } from '@/progression/level';
import { computeReward, type RewardBreakdown } from '@/progression/reward';
import {
  UPGRADE_CATALOG,
  findUpgrade,
  upgradeCost,
  type UpgradeDefinition,
} from '@/progression/upgrades';

export interface FeedingRewardInput {
  /** Raw word as reported; normalized here before scoring. */
  readonly word: string;
  readonly environment: EnvironmentKind;
  /** True only if this feeding is the first time the creature eats it. */
  readonly isNewDiscovery: boolean;
  /** Number of times the word was eaten before this feeding. */
  readonly priorEats: number;
  readonly creatureId?: string;
  readonly now: number;
}

export interface FeedingReward {
  readonly creatureId: string;
  /** Dictionary form that was actually scored. */
  readonly word: string;
  readonly breakdown: RewardBreakdown;
  readonly progression: ProgressionRecord;
  readonly previousLevel: number;
  readonly levelUp: boolean;
  readonly stage: string;
  readonly discovered: boolean;
  /** Share of the environment pool this feeding was paid from (0..1). */
  readonly environmentShare: number;
  /** The distribution after this feeding - this is what the next one scores. */
  readonly affinities: EnvironmentAffinities;
}

/**
 * Scores and stores one feeding.
 *
 * Callers normally invoke this inside their own transaction (ingest does) so
 * the feeding row, the vocabulary counter and the award commit together. Called
 * outside one, each write commits on its own - still deterministic, just not
 * atomic, which is why ingest wraps it.
 */
export async function awardFeeding(
  db: XrawlDatabase,
  input: FeedingRewardInput,
): Promise<FeedingReward> {
  const creatureId = input.creatureId ?? CREATURE_ID;
  const word = normalizeWord(input.word);
  const now = input.now;

  const progression = await ensureProgression(db, creatureId, now);
  const personality = await listPersonality(db, undefined, 200);

  const discovered = input.isNewDiscovery && isEligibleDiscoveryWord(word);

  // Score from the distribution as it stood *before* this feeding: eating is
  // what moves affinity, it does not retroactively pay for itself.
  const affinities =
    progression.affinities ?? affinityFromCounts(progression.environments);
  const share = environmentShare(affinities, input.environment);

  const personalityValue = personalityAffinity(personality, {
    word,
    environment: input.environment,
  });

  const breakdown = computeReward({
    word,
    environment: input.environment,
    isNewDiscovery: discovered,
    priorEats: Math.max(0, input.priorEats),
    environmentShare: share,
    personalityAffinity: personalityValue,
  });

  const nextAffinitiesValue = nextAffinity(affinities, input.environment);

  const updated = await applyProgressionAward(
    db,
    creatureId,
    {
      xp: breakdown.xp,
      wordPoints: breakdown.wordPoints,
      discovered,
      environment: input.environment,
      affinities: nextAffinitiesValue,
    },
    now,
  );

  const previousLevel = progression.level;
  const levelUp = updated.level > previousLevel;
  const stage = stageForLevel(updated.level);

  // Stage is a projection of level, but the creature row is where the rest of
  // the app reads it from, so keep the stored copy in step on a level change.
  if (levelUp) {
    const creature = await getCreature(db, creatureId);
    if (creature && creature.stage !== stage) {
      await putCreature(db, { ...creature, stage, updatedAt: now });
    }
  }

  return {
    creatureId,
    word,
    breakdown,
    progression: updated,
    previousLevel,
    levelUp,
    stage,
    discovered,
    environmentShare: share,
    affinities: updated.affinities,
  };
}

/* ------------------------------------------------------------------------- */
/* upgrades                                                                   */
/* ------------------------------------------------------------------------- */

export type PurchaseFailureReason = 'unknown-upgrade' | 'max-level' | 'insufficient-points';

export interface PurchaseFailure {
  readonly ok: false;
  readonly reason: PurchaseFailureReason;
  readonly upgradeId: string;
  readonly cost: number;
  readonly balance: number;
  readonly level: number;
}

export interface PurchaseSuccess {
  readonly ok: true;
  readonly upgradeId: string;
  readonly upgrade: UpgradeRecord;
  readonly progression: ProgressionRecord;
  readonly cost: number;
  readonly definition: UpgradeDefinition;
}

export type PurchaseOutcome = PurchaseSuccess | PurchaseFailure;

/**
 * Buys the next level of one upgrade with word points.
 *
 * Every rejection is a value, not a throw: the caller (background message
 * handler) needs to tell the user why nothing happened.
 */
export async function purchaseUpgradeWithPoints(
  db: XrawlDatabase,
  upgradeId: string,
  now: number,
  creatureId: string = CREATURE_ID,
): Promise<PurchaseOutcome> {
  return db.transaction('rw', [db.progression, db.upgrades], async () => {
    const progression = await ensureProgression(db, creatureId, now);
    const definition = findUpgrade(upgradeId);
    const existing = await getUpgrade(db, upgradeId);
    const level = existing?.level ?? 0;

    if (!definition) {
      return {
        ok: false,
        reason: 'unknown-upgrade',
        upgradeId,
        cost: 0,
        balance: progression.wordPoints,
        level,
      };
    }

    if (level >= definition.maxLevel) {
      return {
        ok: false,
        reason: 'max-level',
        upgradeId,
        cost: upgradeCost(definition, definition.maxLevel),
        balance: progression.wordPoints,
        level,
      };
    }

    const cost = upgradeCost(definition, level + 1);
    if (progression.wordPoints < cost) {
      return {
        ok: false,
        reason: 'insufficient-points',
        upgradeId,
        cost,
        balance: progression.wordPoints,
        level,
      };
    }

    const spent = await spendWordPoints(db, creatureId, cost, now);
    if (!spent) {
      // Another writer took the points between the read and the spend. The
      // transaction is read-write on progression, so this cannot happen inside
      // one browser context, but treating it as a rejection is still correct.
      return {
        ok: false,
        reason: 'insufficient-points',
        upgradeId,
        cost,
        balance: progression.wordPoints,
        level,
      };
    }

    const upgrade = await purchaseUpgrade(db, upgradeId, {
      cost,
      now,
      maxLevel: definition.maxLevel,
    });

    return { ok: true, upgradeId, upgrade, progression: spent, cost, definition };
  });
}

export interface UpgradeStatus {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: UpgradeDefinition['category'];
  readonly level: number;
  readonly maxLevel: number;
  /** Price of the next level; 0 when maxed. */
  readonly nextCost: number;
  readonly affordable: boolean;
}

/** Catalog plus owned levels, for a shop UI or a debug panel. */
export async function upgradeStatuses(
  db: XrawlDatabase,
  creatureId: string = CREATURE_ID,
): Promise<UpgradeStatus[]> {
  const [levels, progression] = await Promise.all([
    db.upgrades.toArray(),
    getProgression(db, creatureId),
  ]);
  const owned = new Map(levels.map((row) => [row.id, row.level]));
  const balance = progression?.wordPoints ?? 0;

  return UPGRADE_CATALOG.map((definition) => {
    const level = owned.get(definition.id) ?? 0;
    const maxed = level >= definition.maxLevel;
    const nextCost = maxed ? 0 : upgradeCost(definition, level + 1);
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      category: definition.category,
      level,
      maxLevel: definition.maxLevel,
      nextCost,
      affordable: !maxed && balance >= nextCost,
    };
  });
}
