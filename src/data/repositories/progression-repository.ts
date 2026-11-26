/**
 * Progression rows: one per creature, holding both currencies and the history
 * the reward formula scores against.
 *
 * Ordinary increments go through here so that "what a feeding is worth" and
 * "what a purchase costs" never each grow their own copy of the arithmetic.
 */
import type { EnvironmentKind } from '@/shared/types/page';
import type { XrawlDatabase } from '../db';
import type { ProgressionRecord } from '../schema';
import { levelForXp } from '@/progression/level';

export function emptyProgression(id: string, now: number): ProgressionRecord {
  return {
    id,
    xp: 0,
    level: 1,
    wordPoints: 0,
    lifetimeWordPoints: 0,
    spentWordPoints: 0,
    feedings: 0,
    discoveries: 0,
    environments: {},
    affinities: {},
    updatedAt: now,
  };
}

export async function getProgression(
  db: XrawlDatabase,
  id: string,
): Promise<ProgressionRecord | undefined> {
  return db.progression.get(id);
}

/** Reads the row, creating an all-zeroes one if this creature has none yet. */
export async function ensureProgression(
  db: XrawlDatabase,
  id: string,
  now: number,
): Promise<ProgressionRecord> {
  return db.transaction('rw', db.progression, async () => {
    const existing = await db.progression.get(id);
    if (existing) return existing;

    const created = emptyProgression(id, now);
    await db.progression.add(created);
    return created;
  });
}

export interface ProgressionAward {
  readonly xp: number;
  /** 0 when the reward did not round up to a whole point. */
  readonly wordPoints: number;
  readonly discovered: boolean;
  readonly environment: EnvironmentKind;
  /** Distribution after this feeding; omitted only by non-feeding writers. */
  readonly affinities?: Partial<Record<EnvironmentKind, number>>;
}

/**
 * Applies one feeding award. Level is recomputed from the new XP total rather
 * than incremented, so a repaired or imported row can never drift upward.
 */
export async function applyProgressionAward(
  db: XrawlDatabase,
  id: string,
  award: ProgressionAward,
  now: number,
): Promise<ProgressionRecord> {
  return db.transaction('rw', db.progression, async () => {
    const existing = (await db.progression.get(id)) ?? emptyProgression(id, now);
    const xp = Math.max(0, existing.xp + Math.max(0, Math.round(award.xp)));
    const wordPoints = Math.max(0, existing.wordPoints + Math.max(0, Math.floor(award.wordPoints)));

    const updated: ProgressionRecord = {
      ...existing,
      xp,
      level: levelForXp(xp),
      wordPoints,
      lifetimeWordPoints: existing.lifetimeWordPoints + Math.max(0, Math.floor(award.wordPoints)),
      feedings: existing.feedings + 1,
      discoveries: existing.discoveries + (award.discovered ? 1 : 0),
      environments: {
        ...existing.environments,
        [award.environment]: (existing.environments[award.environment] ?? 0) + 1,
      },
      affinities: award.affinities ?? existing.affinities ?? {},
      updatedAt: now,
    };

    await db.progression.put(updated);
    return updated;
  });
}

/** Deducts spendable points; returns null when the balance would go negative. */
export async function spendWordPoints(
  db: XrawlDatabase,
  id: string,
  cost: number,
  now: number,
): Promise<ProgressionRecord | null> {
  return db.transaction('rw', db.progression, async () => {
    const existing = await db.progression.get(id);
    if (!existing) return null;

    const price = Math.max(0, Math.round(cost));
    if (existing.wordPoints < price) return null;

    const updated: ProgressionRecord = {
      ...existing,
      wordPoints: existing.wordPoints - price,
      spentWordPoints: existing.spentWordPoints + price,
      updatedAt: now,
    };
    await db.progression.put(updated);
    return updated;
  });
}
