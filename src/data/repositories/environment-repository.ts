import type { EnvironmentKind } from '@/shared/types/page';
import type { XrawlDatabase } from '../db';
import { environmentBucketId, type EnvironmentRecord } from '../schema';

export interface EnvironmentExposure {
  readonly kind: EnvironmentKind;
  readonly host: string;
  readonly exposureMs: number;
  readonly observations?: number;
  readonly wordsSeen?: number;
  readonly uniqueWords?: number;
  readonly visit?: boolean;
  readonly now: number;
}

/**
 * Accumulates exposure per (environment, host) bucket. Upsert-and-add, so a
 * session that reports the same bucket many times never double-counts a visit.
 */
export async function recordEnvironmentExposure(
  db: XrawlDatabase,
  input: EnvironmentExposure,
): Promise<EnvironmentRecord> {
  const id = environmentBucketId(input.kind, input.host);

  return db.transaction('rw', db.environments, async () => {
    const existing = await db.environments.get(id);
    const record: EnvironmentRecord = existing
      ? {
          ...existing,
          exposureMs: existing.exposureMs + Math.max(0, input.exposureMs),
          visits: existing.visits + (input.visit ? 1 : 0),
          observations: existing.observations + (input.observations ?? 0),
          wordsSeen: existing.wordsSeen + (input.wordsSeen ?? 0),
          uniqueWords: Math.max(existing.uniqueWords, input.uniqueWords ?? 0),
          lastExposedAt: Math.max(existing.lastExposedAt, input.now),
        }
      : {
          id,
          kind: input.kind,
          host: input.host,
          exposureMs: Math.max(0, input.exposureMs),
          visits: input.visit ? 1 : 0,
          observations: input.observations ?? 0,
          wordsSeen: input.wordsSeen ?? 0,
          uniqueWords: input.uniqueWords ?? 0,
          firstExposedAt: input.now,
          lastExposedAt: input.now,
        };

    await db.environments.put(record);
    return record;
  });
}

/** Heaviest exposure first — "what has the creature actually lived in?". */
export async function listEnvironmentsByExposure(
  db: XrawlDatabase,
  limit = 20,
): Promise<EnvironmentRecord[]> {
  return db.environments.orderBy('exposureMs').reverse().limit(limit).toArray();
}

/** Totals per kind, collapsing host buckets for aggregate stats. */
export async function sumExposureByKind(
  db: XrawlDatabase,
): Promise<Partial<Record<EnvironmentKind, { exposureMs: number; visits: number }>>> {
  const rows = await db.environments.toArray();
  const totals: Partial<Record<EnvironmentKind, { exposureMs: number; visits: number }>> = {};
  for (const row of rows) {
    const entry = totals[row.kind] ?? { exposureMs: 0, visits: 0 };
    entry.exposureMs += row.exposureMs;
    entry.visits += row.visits;
    totals[row.kind] = entry;
  }
  return totals;
}
