import type { XrawlDatabase } from '../db';
import { personalityId, type PersonalityKind, type PersonalityRecord } from '../schema';

export async function getPersonality(
  db: XrawlDatabase,
  kind: PersonalityKind,
  key: string,
): Promise<PersonalityRecord | undefined> {
  return db.personality.get(personalityId(kind, key));
}

export async function listPersonality(
  db: XrawlDatabase,
  kind?: PersonalityKind,
  limit = 100,
): Promise<PersonalityRecord[]> {
  if (kind) {
    const rows = await db.personality
      .where('[kind+updatedAt]')
      .between([kind, -Infinity], [kind, Infinity])
      .reverse()
      .limit(limit)
      .toArray();
    return rows;
  }
  return db.personality.orderBy('updatedAt').reverse().limit(limit).toArray();
}

/**
 * Rows kept per kind.
 *
 * `preference` gains one row per eaten word, so without a ceiling the table
 * would grow forever - and since the reward reads only the newest rows, the
 * oldest would quietly stop mattering while still costing storage. Trimming
 * keeps the strongest evidence and forgets the weakest.
 */
const PERSONALITY_ROW_LIMITS: Readonly<Record<PersonalityKind, number>> = {
  preference: 600,
  interest: 64,
  trait: 64,
};

/** Keep-score for trimming: strong *and* well-evidenced rows survive. */
function strength(record: PersonalityRecord): number {
  return Math.abs(record.value) * record.confidence;
}

export interface PersonalityDelta {
  readonly kind: PersonalityKind;
  readonly key: string;
  /** Evidence in -1..1; the running value is a bounded ewma over deltas. */
  readonly evidence: number;
  /** Learning rate per observation, 0..1. */
  readonly learningRate?: number;
  readonly now: number;
}

/**
 * Online update, no retraining: each observation nudges the stored value and
 * raises confidence with sample count. Values stay inside -1..1 because the
 * engine treats them as tendencies, not scores.
 */
export async function applyPersonalityDelta(
  db: XrawlDatabase,
  delta: PersonalityDelta,
): Promise<PersonalityRecord> {
  const id = personalityId(delta.kind, delta.key);
  const rate = Math.min(1, Math.max(0, delta.learningRate ?? 0.08));

  return db.transaction('rw', db.personality, async () => {
    const existing = await db.personality.get(id);
    if (existing) {
      const value = clamp11(existing.value * (1 - rate) + delta.evidence * rate);
      const sampleCount = existing.sampleCount + 1;
      const updated: PersonalityRecord = {
        ...existing,
        value,
        sampleCount,
        confidence: 1 - 1 / (1 + sampleCount / 3),
        updatedAt: delta.now,
        lastEvidenceAt: delta.now,
      };
      await db.personality.put(updated);
      return updated;
    }

    const created: PersonalityRecord = {
      id,
      kind: delta.kind,
      key: delta.key,
      value: clamp11(delta.evidence),
      confidence: 0.25,
      sampleCount: 1,
      updatedAt: delta.now,
      lastEvidenceAt: delta.now,
    };
    await db.personality.add(created);
    // Only a new row can push the table over its ceiling.
    await trimPersonality(db, delta.kind);
    return created;
  });
}

/** Drop the weakest rows of one kind once it exceeds its cap. */
async function trimPersonality(db: XrawlDatabase, kind: PersonalityKind): Promise<void> {
  const cap = PERSONALITY_ROW_LIMITS[kind];
  if (!Number.isFinite(cap) || cap <= 0) return;

  const rows = await db.personality
    .where('[kind+updatedAt]')
    .between([kind, -Infinity], [kind, Infinity])
    .toArray();
  if (rows.length <= cap) return;

  const ranked = [...rows].sort(
    (left, right) => strength(right) - strength(left) || right.updatedAt - left.updatedAt,
  );
  const doomed = ranked.slice(cap).map((row) => row.id);
  if (doomed.length > 0) await db.personality.bulkDelete(doomed);
}

function clamp11(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(-1, value));
}
