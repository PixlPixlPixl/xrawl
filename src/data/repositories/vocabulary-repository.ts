import type { EnvironmentKind } from '@/shared/types/page';
import type { XrawlDatabase } from '../db';
import type { VocabularyRecord } from '../schema';

export interface WordSighting {
  readonly word: string;
  readonly count: number;
}

/**
 * Batch sighting update. Counters are accumulated inside one read-write
 * transaction; the first/last timestamps only advance outward so out-of-order
 * batches (a late flush after a newer one) cannot rewind history.
 */
export async function recordWordSightings(
  db: XrawlDatabase,
  sightings: readonly WordSighting[],
  environment: EnvironmentKind,
  now: number,
): Promise<void> {
  if (sightings.length === 0) return;

  await db.transaction('rw', db.vocabulary, async () => {
    const words = sightings.map((entry) => entry.word);
    const existing = await db.vocabulary.bulkGet(words);
    const existingByWord = new Map<string, VocabularyRecord>();
    for (const record of existing) {
      if (record) existingByWord.set(record.word, record);
    }

    const updates: VocabularyRecord[] = [];
    for (const entry of sightings) {
      if (entry.count <= 0) continue;
      const record = existingByWord.get(entry.word);
      if (record) {
        record.timesSeen += entry.count;
        record.lastSeenAt = Math.max(record.lastSeenAt, now);
        record.firstSeenAt = record.firstSeenAt === 0 ? now : Math.min(record.firstSeenAt, now);
        record.environments[environment] = (record.environments[environment] ?? 0) + entry.count;
        updates.push(record);
      } else {
        const created: VocabularyRecord = {
          word: entry.word,
          timesSeen: entry.count,
          timesEaten: 0,
          firstSeenAt: now,
          lastSeenAt: now,
          firstEatenAt: 0,
          lastEatenAt: 0,
          environments: { [environment]: entry.count },
        };
        existingByWord.set(entry.word, created);
        updates.push(created);
      }
    }

    await db.vocabulary.bulkPut(updates);
  });
}

export async function getVocabularyEntry(
  db: XrawlDatabase,
  word: string,
): Promise<VocabularyRecord | undefined> {
  return db.vocabulary.get(word);
}

/** Newest-seen first; ties broken by lexical order for stable pagination. */
export async function listRecentWords(
  db: XrawlDatabase,
  limit: number,
  offset = 0,
): Promise<VocabularyRecord[]> {
  return db.vocabulary.orderBy('lastSeenAt').reverse().offset(offset).limit(limit).toArray();
}

/** Most-eaten first. Rows that have never been eaten sort last by `lastEatenAt`. */
export async function listMostEaten(
  db: XrawlDatabase,
  limit: number,
  offset = 0,
): Promise<VocabularyRecord[]> {
  return db.vocabulary.orderBy('timesEaten').reverse().offset(offset).limit(limit).toArray();
}

export async function countVocabulary(db: XrawlDatabase): Promise<number> {
  return db.vocabulary.count();
}

/**
 * Increment eat counters for a word. Kept separate from `recordWordSightings`
 * because eating is a progression fact derived from `feedingEvents`; this is the
 * denormalized cache those events reconcile against.
 */
export async function recordWordEaten(
  db: XrawlDatabase,
  word: string,
  environment: EnvironmentKind,
  now: number,
): Promise<void> {
  await db.transaction('rw', db.vocabulary, async () => {
    const record = await db.vocabulary.get(word);
    if (record) {
      record.timesEaten += 1;
      record.firstEatenAt = record.firstEatenAt === 0 ? now : record.firstEatenAt;
      record.lastEatenAt = Math.max(record.lastEatenAt, now);
      await db.vocabulary.put(record);
      return;
    }
    await db.vocabulary.add({
      word,
      timesSeen: 0,
      timesEaten: 1,
      firstSeenAt: 0,
      lastSeenAt: 0,
      firstEatenAt: now,
      lastEatenAt: now,
      environments: environment ? { [environment]: 0 } : {},
    });
  });
}
