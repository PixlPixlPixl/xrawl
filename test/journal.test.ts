/**
 * Journal tests: the read side of the history screen.
 *
 * These pin the three promises the journal makes - a reward you can check, a
 * history that survives a schema upgrade, and page context that is *not* kept
 * unless asked - plus the two ways a word can have neighbours (vectors, or
 * shared sites when no model has run).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ingestFeeding, ingestObservation } from '@/data/ingest';
import { journalFeedings, journalOverview, journalVocabulary, journalWordDetail } from '@/data/journal';
import { openDatabase } from './helpers/db';
import { nowAt } from './helpers/db';
import type { XrawlDatabase } from '@/data/db';
import type { FeedingPayload, ObservationPayload } from '@/data/observation';
import { CREATURE_ID } from '@/data/repositories/creature-repository';
import { buildEmbeddingId } from '@/data/schema';
import { stableKey } from '@/shared/id';
import { EMBEDDING_DIMENSIONS, normalizeVector } from '@/progression/semantics';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function open(options: Parameters<typeof openDatabase>[0] = {}): Promise<XrawlDatabase> {
  const opened = await openDatabase(options);
  cleanup.push(() => opened.destroy());
  return opened.db;
}

function feeding(overrides: Partial<FeedingPayload> = {}): FeedingPayload {
  return {
    sessionId: 'sess-1',
    creatureId: CREATURE_ID,
    word: 'octopus',
    eatenAt: nowAt(0),
    environment: 'article',
    pageUrl: 'https://www.github.com/pixl/xrawl',
    pageTitle: 'Repository README',
    contextSentence: 'the octopus is a clever animal',
    fingerprint: 'fp-1',
    nutrition: 1,
    preferenceDelta: 0,
    ...overrides,
  };
}

function observation(overrides: Partial<ObservationPayload> = {}): ObservationPayload {
  return {
    sessionId: 'sess-1',
    capturedAt: nowAt(0),
    page: { url: 'https://github.com/pixl/xrawl', title: 'Repository README' },
    environment: 'code',
    host: 'github.com',
    visit: true,
    activeMs: 60_000,
    words: [],
    uniqueWordCount: 0,
    ...overrides,
  };
}

describe('feeding rows carry what they paid', () => {
  it('records host and reward, and keeps the sentence out of the log by default', async () => {
    const db = await open();
    await ingestFeeding(db, feeding({ fingerprint: 'fp-a', word: 'compiler' }));

    const event = (await db.feedingEvents.toArray())[0]!;
    expect(event.host).toBe('github.com');
    expect(event.points).toBeGreaterThan(0);
    expect(event.xp).toBeGreaterThan(event.points);
    expect(event.contextSentence).toBe('');
    // The hash stays: it is what dedupes the contextual vector in the cache.
    expect(event.contextHash.length).toBeGreaterThan(8);

    const progression = await db.progression.get(CREATURE_ID);
    expect(progression?.wordPoints).toBe(event.points);
  });

  it('stores the sentence only when context storage is on', async () => {
    const db = await open();
    await ingestFeeding(db, feeding({ fingerprint: 'fp-b', word: 'octopus' }), { storeContext: true });
    const event = (await db.feedingEvents.toArray())[0]!;
    expect(event.contextSentence).toBe('the octopus is a clever animal');
  });
});

describe('schema v7 upgrade', () => {
  it('derives the host and leaves old rewards unclaimed', async () => {
    const name = 'xrawl-v6-journal';
    const first = await openDatabase({ name, schemaVersion: 6 });
    await first.db.feedingEvents.put({
      id: 'legacy-event',
      creatureId: CREATURE_ID,
      word: 'octopus',
      eatenAt: nowAt(0),
      environment: 'article',
      pageUrl: 'https://news.ycombinator.com/item?id=1',
      pageTitle: 'A story',
      contextSentence: 'the octopus',
      contextHash: 'hash',
      fingerprint: 'fp-legacy',
      source: 'autonomous',
      nutrition: 1,
      preferenceDelta: 0,
    } as never);
    first.close();

    const db = await open({ name });
    const row = (await db.feedingEvents.toArray())[0]!;
    expect(row.host).toBe('news.ycombinator.com');
    expect(row.points).toBe(0);
    expect(row.xp).toBe(0);
  });
});

describe('overview', () => {
  it('totals feedings, vocabulary, rate and site share', async () => {
    const db = await open();
    await ingestObservation(db, observation({ activeMs: 120_000 }));
    await ingestFeeding(db, feeding({ fingerprint: 'fp-1', word: 'compiler', eatenAt: nowAt(0) }));
    await ingestFeeding(
      db,
      feeding({
        fingerprint: 'fp-2',
        word: 'database',
        eatenAt: nowAt(60_000),
        source: 'manual',
        environment: 'code',
      }),
    );

    const overview = await journalOverview(db, { contextStorage: false });
    expect(overview.wordsConsumed).toBe(2);
    expect(overview.uniqueConsumed).toBe(2);
    expect(overview.manualFeedings).toBe(1);
    expect(overview.wordsPerMinute).toBe(1);
    expect(overview.firstFeedingAt).toBe(nowAt(0));
    expect(overview.lastFeedingAt).toBe(nowAt(60_000));

    const site = overview.environments.find((entry) => entry.host === 'github.com');
    expect(site?.label).toBe('Code');
    expect(site?.exposureMinutes).toBe(2);
    expect(site?.share).toBeCloseTo(1, 5);
  });
});

describe('feeding history', () => {
  it('pages newest first and filters by word, site and source', async () => {
    const db = await open();
    for (let index = 0; index < 3; index += 1) {
      await ingestFeeding(
        db,
        feeding({
          fingerprint: 'fp-' + index,
          word: index === 0 ? 'compiler' : 'octopus',
          eatenAt: nowAt(index * 60_000),
          pageUrl: index === 2 ? 'https://allrecipes.com/x' : 'https://github.com/x',
        }),
      );
    }

    const page = await journalFeedings(db, { view: 'feedings', limit: 2 });
    expect(page.total).toBe(3);
    expect(page.hasMore).toBe(true);
    expect(page.entries.map((entry) => entry.word)).toEqual(['octopus', 'octopus']);

    const second = await journalFeedings(db, { view: 'feedings', limit: 2, offset: 2 });
    expect(second.entries.map((entry) => entry.word)).toEqual(['compiler']);
    expect(second.hasMore).toBe(false);

    const bySite = await journalFeedings(db, { view: 'feedings', host: 'allrecipes.com' });
    expect(bySite.total).toBe(1);

    const byWord = await journalFeedings(db, { view: 'feedings', word: 'Octopus' });
    expect(byWord.total).toBe(2);
  });
});

describe('vocabulary', () => {
  it('searches by prefix and by site, and hides words that were only seen', async () => {
    const db = await open();
    await ingestObservation(
      db,
      observation({
        words: [
          { word: 'compiler', count: 2 },
          { word: 'compile', count: 1 },
          { word: 'database', count: 1 },
        ],
        uniqueWordCount: 3,
      }),
    );
    await ingestFeeding(db, feeding({ fingerprint: 'fp-1', word: 'compiler', pageUrl: 'https://github.com/x' }));
    await ingestFeeding(db, feeding({ fingerprint: 'fp-2', word: 'database', pageUrl: 'https://arxiv.org/x' }));

    const prefix = await journalVocabulary(db, { view: 'vocabulary', search: 'compile' });
    expect(prefix.entries.map((entry) => entry.word).sort()).toEqual(['compile', 'compiler']);

    const eaten = await journalVocabulary(db, { view: 'vocabulary', filter: 'eaten' });
    expect(eaten.total).toBe(2);

    const site = await journalVocabulary(db, { view: 'vocabulary', search: 'github.com' });
    expect(site.entries.map((entry) => entry.word)).toEqual(['compiler']);
  });

  it('sorts by times eaten by default', async () => {
    const db = await open();
    await ingestFeeding(db, feeding({ fingerprint: 'fp-1', word: 'octopus' }));
    await ingestFeeding(db, feeding({ fingerprint: 'fp-2', word: 'octopus' }));
    await ingestFeeding(db, feeding({ fingerprint: 'fp-3', word: 'compiler' }));

    const page = await journalVocabulary(db, { view: 'vocabulary', filter: 'eaten' });
    expect(page.entries[0]?.word).toBe('octopus');
    expect(page.entries[0]?.timesEaten).toBe(2);
  });
});

describe('word detail', () => {
  it('falls back to shared sites when no model has run', async () => {
    const db = await open();
    await ingestFeeding(db, feeding({ fingerprint: 'fp-1', word: 'compiler' }));
    await ingestFeeding(db, feeding({ fingerprint: 'fp-2', word: 'database' }));

    const detail = await journalWordDetail(db, 'compiler');
    expect(detail.model).toBeNull();
    expect(detail.related.length).toBeGreaterThan(0);
    expect(detail.related[0]?.reason).toBe('site');
    expect(detail.hosts).toEqual(['github.com']);
  });

  it('uses cached vectors in one model space when they exist', async () => {
    const db = await open();
    const model = 'xrawl/lexical-384';
    const dimensions = EMBEDDING_DIMENSIONS;
    const vectorOf = (values: number[]): number[] => {
      const padded = Array.from({ length: dimensions }, (_, index) => values[index] ?? 0);
      return normalizeVector(padded);
    };

    await db.interestProfiles.put({
      id: 'general',
      category: 'general',
      model,
      dimensions,
      vector: vectorOf([1, 0]),
      weight: 1,
      observations: 1,
      createdAt: 0,
      updatedAt: 0,
    });

    const putWord = async (word: string, values: number[]): Promise<void> => {
      await db.embeddings.put({
        id: buildEmbeddingId(model, dimensions, 'word', stableKey('text', word, 'word')),
        subjectType: 'word',
        subjectId: stableKey('text', word, 'word'),
        model,
        dimensions,
        vector: vectorOf(values),
        normalized: true,
        sourceHash: stableKey('text', word, 'word'),
        createdAt: 0,
        updatedAt: 0,
      });
    };

    await putWord('compiler', [1, 0]);
    await putWord('database', [0.9, 0.2]);
    await putWord('octopus', [0, 1]);

    await ingestFeeding(db, feeding({ fingerprint: 'fp-1', word: 'compiler' }));
    await ingestFeeding(db, feeding({ fingerprint: 'fp-2', word: 'database' }));
    await ingestFeeding(db, feeding({ fingerprint: 'fp-3', word: 'octopus' }));

    const detail = await journalWordDetail(db, 'compiler');
    expect(detail.model).toBe(model);
    expect(detail.related[0]).toMatchObject({ word: 'database', reason: 'semantic' });
    expect(detail.related[0]?.similarity).toBeGreaterThan(0.9);
  });
});
