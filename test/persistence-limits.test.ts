/**
 * Storage-growth limits.
 *
 * Three tables grow with use - the feeding log, the embedding cache and the
 * learned personality rows - so each has an explicit ceiling or an explicit
 * identity rule. These tests keep those decisions honest: a retried feeding is
 * paid once, a cache over its ceiling is trimmed oldest-first, and the weakest
 * personality evidence is forgotten before the table can grow forever.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { XrawlDatabase } from '@/data/db';
import { ingestFeeding } from '@/data/ingest';
import { embedWithCache } from '@/data/embeddings';
import type { EmbeddingProvider } from '@/semantics/provider';
import {
  countFeedingEvents,
  feedingEventId,
  FEEDING_DEDUPE_WINDOW_MS,
} from '@/data/repositories/feeding-repository';
import {
  applyPersonalityDelta,
  listPersonality,
} from '@/data/repositories/personality-repository';
import { getProgression } from '@/data/repositories/progression-repository';
import type { FeedingPayload } from '@/data/observation';
import { nowAt, openDatabase } from './helpers/db';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function open(): Promise<XrawlDatabase> {
  const opened = await openDatabase();
  cleanup.push(() => opened.destroy());
  return opened.db;
}

function feeding(overrides: Partial<FeedingPayload> = {}): FeedingPayload {
  return {
    sessionId: 'sess-1',
    creatureId: 'xrawl-0',
    word: 'database',
    eatenAt: nowAt(0),
    environment: 'code',
    pageUrl: 'https://github.com/a/b',
    pageTitle: 'repo',
    contextSentence: 'the database is slow',
    fingerprint: 'fp-1',
    nutrition: 1,
    preferenceDelta: 0.5,
    ...overrides,
  };
}

describe('feeding identity', () => {
  it('gives a retry inside the window the same id', () => {
    const first = feedingEventId('xrawl-0', 'database', nowAt(0), 'fp-1');
    const retry = feedingEventId('xrawl-0', 'database', nowAt(FEEDING_DEDUPE_WINDOW_MS - 1), 'fp-1');
    expect(retry).toBe(first);
  });

  it('separates two genuine meals of the same word', () => {
    // The engine's own cooldown is 25 s, well past the bucket width.
    const first = feedingEventId('xrawl-0', 'database', nowAt(0), 'fp-1');
    const later = feedingEventId('xrawl-0', 'database', nowAt(30_000), 'fp-1');
    expect(later).not.toBe(first);
  });

  it('separates the same word eaten on a different target or creature', () => {
    const base = feedingEventId('xrawl-0', 'database', nowAt(0), 'fp-1');
    expect(feedingEventId('xrawl-0', 'database', nowAt(0), 'fp-2')).not.toBe(base);
    expect(feedingEventId('xrawl-1', 'database', nowAt(0), 'fp-1')).not.toBe(base);
  });

  it('is stable for a non-finite timestamp instead of producing NaN keys', () => {
    expect(feedingEventId('xrawl-0', 'database', Number.NaN, 'fp')).toBe(
      feedingEventId('xrawl-0', 'database', 0, 'fp'),
    );
  });

  it('pays a retried delivery exactly once', async () => {
    const db = await open();
    const payload = feeding();

    expect(await ingestFeeding(db, payload)).toBe(true);
    const afterFirst = await getProgression(db, 'xrawl-0');
    expect(await countFeedingEvents(db)).toBe(1);

    // Same event, re-sent a couple of seconds later: deduped, no second reward.
    await ingestFeeding(db, { ...payload, eatenAt: payload.eatenAt + 1_500 });
    const afterRetry = await getProgression(db, 'xrawl-0');

    expect(await countFeedingEvents(db)).toBe(1);
    expect(afterRetry?.xp).toBe(afterFirst?.xp);
    expect(afterRetry?.wordPoints).toBe(afterFirst?.wordPoints);
    expect((await db.vocabulary.get('database'))?.timesEaten).toBe(1);
  });
});

describe('embedding cache ceiling', () => {
  /** A unit vector wide enough to pass the provider sanity check. */
  function unitVector(): number[] {
    const vector = new Array<number>(384).fill(0);
    vector[0] = 1;
    return vector;
  }

  const provider: EmbeddingProvider = {
    model: 'model',
    dimensions: 384,
    embed: async (texts) => texts.map(() => unitVector()),
  };

  function request(word: string) {
    return { subjectType: 'word' as const, text: word, subjectId: word };
  }

  it('evicts oldest-first once the cache passes its ceiling', async () => {
    const db = await open();
    const words = ['a', 'b', 'c', 'd', 'e', 'f'];

    // Distinct timestamps so the eviction order is unambiguous.
    for (let index = 0; index < words.length; index += 1) {
      await embedWithCache(db, provider, [request(words[index]!)], {
        now: nowAt(index * 1_000),
        cacheLimit: 6,
      });
    }
    expect(await db.embeddings.count()).toBe(6);

    await embedWithCache(db, provider, [request('g')], {
      now: nowAt(10_000),
      cacheLimit: 3,
    });

    const kept = (await db.embeddings.toArray()).map((row) => row.subjectId).sort();
    expect(kept).toEqual(['e', 'f', 'g']);
  });

  it('does not evict while the cache is under its ceiling', async () => {
    const db = await open();
    await embedWithCache(db, provider, [request('solo')], { now: nowAt(0), cacheLimit: 20 });
    expect(await db.embeddings.count()).toBe(1);
  });

  it('reuses a cached vector instead of re-embedding it', async () => {
    const db = await open();
    let inferences = 0;
    const counting: EmbeddingProvider = {
      ...provider,
      embed: async (texts) => {
        inferences += 1;
        return texts.map(() => unitVector());
      },
    };

    await embedWithCache(db, counting, [request('word')], { now: nowAt(0) });
    const [cached] = await embedWithCache(db, counting, [request('word')], { now: nowAt(1_000) });

    expect(inferences).toBe(1);
    expect(cached?.[0]).toBe(1);
  });
});

describe('personality ceiling', () => {
  it('forgets the weakest preferences once the kind is full', async () => {
    const db = await open();

    // Fill the preference kind to its ceiling directly (the trim only runs when
    // a new row is created, so seeding by hand keeps the test fast).
    const titles: string[] = [];
    for (let index = 0; index < 600; index += 1) {
      const key = `word-${index}`;
      titles.push(key);
      const strength = index / 1_000;
      await db.personality.put({
        id: `preference:${key}`,
        kind: 'preference',
        key,
        value: strength,
        confidence: 1,
        sampleCount: 10,
        updatedAt: nowAt(index),
        lastEvidenceAt: nowAt(index),
      });
    }

    // The strongest row is the newest; a brand new, strongly-evidenced word must
    // survive, and the weakest (oldest) row must be the one that goes.
    await applyPersonalityDelta(db, {
      kind: 'preference',
      key: 'fresh',
      evidence: 1,
      learningRate: 1,
      now: nowAt(10_000),
    });

    const rows = await listPersonality(db, 'preference', 1_000);
    expect(rows.length).toBe(600);
    expect(rows.some((row) => row.key === 'fresh')).toBe(true);
    expect(rows.some((row) => row.key === 'word-0')).toBe(false);
  });
});
