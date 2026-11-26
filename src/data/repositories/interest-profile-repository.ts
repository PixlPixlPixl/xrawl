/**
 * Interest profile storage.
 *
 * Profiles are *memory*, not cache: they are the vectors the creature learned
 * from its own feedings and the shares of attention it gives them. Rows carry
 * the model that produced them, because vectors from two models are not
 * comparable, and a model change therefore rebuilds the pool instead of mixing.
 */
import type { XrawlDatabase } from '../db';
import { interestProfileId, type InterestProfileRecord } from '../schema';
import type { InterestProfile } from '@/progression/semantics';

function toRecord(
  profile: InterestProfile,
  model: string,
  dimensions: number,
  createdAt: number,
): InterestProfileRecord {
  return {
    id: interestProfileId(profile.category),
    category: profile.category,
    model,
    dimensions,
    vector: Array.from(profile.vector),
    weight: profile.weight,
    observations: profile.observations,
    createdAt,
    updatedAt: profile.updatedAt,
  };
}

/**
 * Load the pool for one model.
 *
 * Rows written by a different model are deleted here, not merged: comparing a
 * MiniLM vector with a lexical one is meaningless, and silently keeping both
 * would make the creature's preferences drift toward whichever space was cached
 * last. The caller re-seeds from anchors afterwards.
 */
export async function loadInterestProfiles(
  db: XrawlDatabase,
  model: string,
  dimensions: number,
): Promise<InterestProfile[]> {
  const rows = await db.interestProfiles.toArray();
  const usable: InterestProfile[] = [];
  const stale: string[] = [];

  for (const row of rows) {
    if (row.model !== model || row.dimensions !== dimensions || row.vector.length !== dimensions) {
      stale.push(row.id);
      continue;
    }
    usable.push({
      category: row.category,
      vector: row.vector,
      weight: row.weight,
      observations: row.observations,
      updatedAt: row.updatedAt,
    });
  }

  if (stale.length > 0) await db.interestProfiles.bulkDelete(stale);

  return usable.sort((left, right) =>
    right.weight - left.weight || (left.category < right.category ? -1 : 1),
  );
}

/** Replace the pool with exactly these profiles (pruned categories disappear). */
export async function saveInterestProfiles(
  db: XrawlDatabase,
  model: string,
  dimensions: number,
  profiles: readonly InterestProfile[],
  now: number,
): Promise<void> {
  await db.transaction('rw', db.interestProfiles, async () => {
    const existing = await db.interestProfiles.toArray();
    const kept = new Set(profiles.map((profile) => interestProfileId(profile.category)));
    const stale = existing.filter((row) => !kept.has(row.id)).map((row) => row.id);
    if (stale.length > 0) await db.interestProfiles.bulkDelete(stale);

    const createdAt = new Map(existing.map((row) => [row.id, row.createdAt]));
    const rows = profiles.map((profile) =>
      toRecord(
        profile,
        model,
        dimensions,
        createdAt.get(interestProfileId(profile.category)) ?? now,
      ),
    );
    if (rows.length > 0) await db.interestProfiles.bulkPut(rows);
  });
}

/**
 * Rounded attention shares of whatever is stored, model-agnostic.
 *
 * Used by status surfaces, which must not load a model just to describe what the
 * creature already learned.
 */
export async function summarizeInterestProfiles(
  db: XrawlDatabase,
): Promise<Array<{ category: string; share: number }>> {
  const rows = await db.interestProfiles.toArray();
  return rows
    .sort((left, right) => right.weight - left.weight || (left.category < right.category ? -1 : 1))
    .map((row) => ({ category: row.category, share: Math.round(row.weight * 100) / 100 }));
}

export async function countInterestProfiles(db: XrawlDatabase): Promise<number> {
  return db.interestProfiles.count();
}

/** Forget every learned interest (used by an explicit reset, not by scoring). */
export async function clearInterestProfiles(db: XrawlDatabase): Promise<void> {
  await db.interestProfiles.clear();
}
