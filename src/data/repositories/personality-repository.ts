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
    return created;
  });
}

export async function setPersonality(
  db: XrawlDatabase,
  record: Omit<PersonalityRecord, 'id'>,
): Promise<PersonalityRecord> {
  const withId: PersonalityRecord = { ...record, id: personalityId(record.kind, record.key) };
  await db.personality.put(withId);
  return withId;
}

function clamp11(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(-1, value));
}
