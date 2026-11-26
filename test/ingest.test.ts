/**
 * Ingest tests: the trust boundary between the content script and the database.
 *
 * The content script shares a window with arbitrary page code, so payloads are
 * treated as hostile input: clamped, length-checked, and batched under a cap.
 * These tests pin that behaviour and the transaction semantics around it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ingestFeeding, ingestObservation, sanitizeObservation } from '@/data/ingest';
import { OBSERVATION_LIMITS, type ObservationPayload } from '@/data/observation';
import { countVocabulary } from '@/data/repositories/vocabulary-repository';
import { countFeedingEvents } from '@/data/repositories/feeding-repository';
import { nowAt, openDatabase } from './helpers/db';
import type { XrawlDatabase } from '@/data/db';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function open(): Promise<XrawlDatabase> {
  const opened = await openDatabase();
  cleanup.push(() => opened.destroy());
  return opened.db;
}

function observation(overrides: Partial<ObservationPayload> = {}): ObservationPayload {
  return {
    sessionId: 'sess-1',
    capturedAt: nowAt(0),
    page: { url: 'https://example.com/a', title: 'Article' },
    environment: 'article',
    host: 'example.com',
    visit: true,
    activeMs: 1_000,
    words: [
      { word: 'fox', count: 2 },
      { word: 'dog', count: 1 },
    ],
    uniqueWordCount: 2,
    ...overrides,
  };
}

describe('sanitizeObservation', () => {
  it('drops malformed words and non-positive counts', () => {
    const sanitized = sanitizeObservation(
      observation({
        words: [
          { word: '', count: 1 },
          { word: 'fox', count: 0 },
          { word: 'dog', count: -3 },
          { word: 'ok', count: 2 },
          // Oversized word: rejected by the length check.
          { word: 'x'.repeat(OBSERVATION_LIMITS.maxWordLength + 1), count: 1 },
        ],
      }),
    );

    expect(sanitized.words).toEqual([{ word: 'ok', count: 2 }]);
  });

  it('caps the number of words per flush', () => {
    const words = Array.from({ length: OBSERVATION_LIMITS.maxWordsPerFlush + 50 }, (_, index) => ({
      word: `w${index}`,
      count: 1,
    }));
    const sanitized = sanitizeObservation(observation({ words }));
    expect(sanitized.words.length).toBe(OBSERVATION_LIMITS.maxWordsPerFlush);
  });

  it('clamps absurd active time and rejects non-finite values', () => {
    expect(sanitizeObservation(observation({ activeMs: Number.POSITIVE_INFINITY })).activeMs).toBe(0);
    expect(sanitizeObservation(observation({ activeMs: -5 })).activeMs).toBe(0);
    expect(
      sanitizeObservation(observation({ activeMs: OBSERVATION_LIMITS.maxActiveMsPerFlush * 2 }))
        .activeMs,
    ).toBe(OBSERVATION_LIMITS.maxActiveMsPerFlush);
  });
});

describe('ingestObservation', () => {
  it('writes vocabulary, environment exposure, and session in one transaction', async () => {
    const db = await open();
    const result = await ingestObservation(db, observation());

    expect(result.wordsWritten).toBe(2);

    const fox = await db.vocabulary.get('fox');
    expect(fox?.timesSeen).toBe(2);
    expect(fox?.environments.article).toBe(2);

    const environment = await db.environments.get('article:example.com');
    expect(environment?.exposureMs).toBe(1_000);
    expect(environment?.visits).toBe(1);
    expect(environment?.wordsSeen).toBe(3);

    const session = await db.sessions.get('sess-1');
    expect(session?.activeMs).toBe(1_000);
    expect(session?.pageVisits).toBe(1);
    expect(session?.wordsSeen).toBe(3);
    expect(session?.environments.article).toBe(1_000);
  });

  it('accumulates repeated flushes from one session', async () => {
    const db = await open();
    await ingestObservation(db, observation({ capturedAt: nowAt(0), activeMs: 1_000 }));
    await ingestObservation(
      db,
      observation({ capturedAt: nowAt(1_000), activeMs: 500, visit: false, words: [] }),
    );

    const session = await db.sessions.get('sess-1');
    expect(session?.activeMs).toBe(1_500);
    expect(session?.observations).toBe(2);
    expect(session?.pageVisits).toBe(1);
    expect(await countVocabulary(db)).toBe(2);
  });

  it('never writes a malformed batch', async () => {
    const db = await open();
    await ingestObservation(
      db,
      observation({ words: [{ word: '', count: 1 }, { word: 'a'.repeat(200), count: 5 }] }),
    );
    expect(await countVocabulary(db)).toBe(0);
  });
});

describe('ingestFeeding', () => {
  it('records the event and its vocabulary counter together', async () => {
    const db = await open();
    const written = await ingestFeeding(db, {
      sessionId: 'sess-1',
      creatureId: 'xrawl-0',
      word: 'fox',
      eatenAt: nowAt(0),
      environment: 'article',
      pageUrl: 'https://example.com/a',
      pageTitle: 'Article',
      contextSentence: 'the quick brown fox',
      fingerprint: 'fp-1',
      nutrition: 1,
      preferenceDelta: 0.5,
    });

    expect(written).toBe(true);
    expect(await countFeedingEvents(db)).toBe(1);
    expect((await db.vocabulary.get('fox'))?.timesEaten).toBe(1);
    expect((await db.sessions.get('sess-1'))?.feedingCount).toBe(1);
  });

  it('rejects an empty word without touching any table', async () => {
    const db = await open();
    const written = await ingestFeeding(db, {
      sessionId: 'sess-1',
      creatureId: 'xrawl-0',
      word: '',
      eatenAt: nowAt(0),
      environment: 'article',
      pageUrl: 'u',
      pageTitle: 't',
      contextSentence: 'c',
      fingerprint: 'fp',
      nutrition: 1,
      preferenceDelta: 0,
    });

    expect(written).toBe(false);
    expect(await countFeedingEvents(db)).toBe(0);
  });

  it('truncates page-controlled text to bounded lengths', async () => {
    const db = await open();
    await ingestFeeding(
      db,
      {
        sessionId: 's',
        creatureId: 'xrawl-0',
        word: 'fox',
        eatenAt: nowAt(0),
        environment: 'article',
        pageUrl: `https://example.com/${'a'.repeat(3_000)}`,
        pageTitle: 'b'.repeat(1_000),
        contextSentence: 'c'.repeat(1_000),
        fingerprint: 'fp',
        nutrition: 1,
        preferenceDelta: 0,
      },
      { storeContext: true },
    );

    const event = await db.feedingEvents.orderBy('eatenAt').last();
    expect(event!.pageUrl.length).toBeLessThanOrEqual(2_000);
    expect(event!.pageTitle.length).toBeLessThanOrEqual(500);
    expect(event!.contextSentence.length).toBe(OBSERVATION_LIMITS.maxSentenceLength);
  });

  it('discards the sentence unless context storage is on', async () => {
    const db = await open();
    await ingestFeeding(db, {
      sessionId: 's',
      creatureId: 'xrawl-0',
      word: 'fox',
      eatenAt: nowAt(0),
      environment: 'article',
      pageUrl: 'https://example.com/a',
      pageTitle: 't',
      contextSentence: 'a private sentence',
      fingerprint: 'fp',
      nutrition: 1,
      preferenceDelta: 0,
    });

    const event = await db.feedingEvents.orderBy('eatenAt').last();
    expect(event!.contextSentence).toBe('');
    // The hash survives: it keys the contextual vector in the embedding cache.
    expect(event!.contextHash.length).toBeGreaterThan(0);
  });
});
