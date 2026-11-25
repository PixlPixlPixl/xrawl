/**
 * Repository behaviour tests, run against a real IndexedDB implementation.
 *
 * These lock in the invariants the game will lean on: append-only history,
 * monotonic timestamps, bounded personality values, model-keyed vectors, and
 * transaction safety. If a future migration or refactor breaks one of them, it
 * fails here before progression is built on top.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { XrawlDatabase } from '@/data/db';
import {
  adjustCreatureState,
  ensureCreature,
  getCreature,
  updateCreature,
} from '@/data/repositories/creature-repository';
import { getSpecies } from '@/creature/species';
import {
  appendFeedingEvent,
  countFeedingEvents,
  listFeedingEvents,
  listFeedingEventsForWord,
} from '@/data/repositories/feeding-repository';
import {
  listEnvironmentsByExposure,
  recordEnvironmentExposure,
  sumExposureByKind,
} from '@/data/repositories/environment-repository';
import {
  endSession,
  listSessions,
  recordSessionActivity,
  startSession,
  totalActiveMs,
} from '@/data/repositories/session-repository';
import { purchaseUpgrade, upgradeLevel } from '@/data/repositories/upgrade-repository';
import {
  applyPersonalityDelta,
  getPersonality,
  listPersonality,
} from '@/data/repositories/personality-repository';
import {
  findEmbedding,
  findEmbeddingBySubject,
  putEmbedding,
  pruneEmbeddingsForModel,
} from '@/data/repositories/embedding-repository';
import {
  countVocabulary,
  listMostEaten,
  listRecentWords,
  recordWordEaten,
  recordWordSightings,
} from '@/data/repositories/vocabulary-repository';
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

describe('creature repository', () => {
  const spider = getSpecies('spider');

  it('creates the creature once and returns the same row afterwards', async () => {
    const db = await open();
    const creature = await ensureCreature(db, {
      name: 'Xrawl',
      species: spider.id,
      genetics: spider.defaults,
      now: nowAt(0),
    });
    const again = await ensureCreature(db, {
      name: 'Other',
      species: 'mite',
      genetics: getSpecies('mite').defaults,
      now: nowAt(100),
    });

    expect(creature.id).toBe('xrawl-0');
    expect(again.name).toBe('Xrawl');
    expect(again.bornAt).toBe(nowAt(0));
  });

  it('merges open namespaces rather than replacing them', async () => {
    const db = await open();
    await ensureCreature(db, {
      name: 'Xrawl',
      species: spider.id,
      genetics: spider.defaults,
      state: { satiety: 1 },
      now: nowAt(0),
    });

    const updated = await updateCreature(db, {
      state: { stomach: 5 },
      genetics: { hue: 42 },
      now: nowAt(10),
    });

    expect(updated?.state.satiety).toBe(1);
    expect(updated?.state.stomach).toBe(5);
    expect(updated?.genetics.hue).toBe(42);
    expect(updated?.genetics.limbCount).toBe(spider.defaults.limbCount);
  });

  it('adjusts one live state value atomically', async () => {
    const db = await open();
    await ensureCreature(db, {
      name: 'Xrawl',
      species: spider.id,
      genetics: spider.defaults,
      now: nowAt(0),
    });
    const satiety = await adjustCreatureState(db, 'satiety', -0.25, nowAt(5));
    expect(satiety).toBe(-0.25);
    const record = await getCreature(db);
    expect(record?.state.satiety).toBe(-0.25);
  });
});

describe('vocabulary repository', () => {
  it('accumulates sightings without rewinding timestamps', async () => {
    const db = await open();
    await recordWordSightings(db, [{ word: 'fox', count: 2 }], 'article', nowAt(100));
    await recordWordSightings(db, [{ word: 'fox', count: 1 }], 'article', nowAt(50));
    await recordWordSightings(db, [{ word: 'dog', count: 3 }], 'docs', nowAt(200));

    const fox = await db.vocabulary.get('fox');
    expect(fox?.timesSeen).toBe(3);
    expect(fox?.firstSeenAt).toBe(nowAt(50));
    expect(fox?.lastSeenAt).toBe(nowAt(100));
    expect(fox?.environments.article).toBe(3);

    const dog = await db.vocabulary.get('dog');
    expect(dog?.environments.docs).toBe(3);
    expect(await countVocabulary(db)).toBe(2);
  });

  it('creates a never-seen word on first eat and increments thereafter', async () => {
    const db = await open();
    await recordWordEaten(db, 'orb', 'search', nowAt(10));
    await recordWordEaten(db, 'orb', 'search', nowAt(20));

    const orb = await db.vocabulary.get('orb');
    expect(orb?.timesEaten).toBe(2);
    expect(orb?.firstEatenAt).toBe(nowAt(10));
    expect(orb?.lastEatenAt).toBe(nowAt(20));
    expect(orb?.timesSeen).toBe(0);
  });

  it('orders by recency and by eat count', async () => {
    const db = await open();
    await recordWordSightings(
      db,
      [
        { word: 'alpha', count: 1 },
        { word: 'beta', count: 1 },
        { word: 'gamma', count: 1 },
      ],
      'article',
      nowAt(0),
    );
    await recordWordEaten(db, 'alpha', 'article', nowAt(100));
    await recordWordEaten(db, 'alpha', 'article', nowAt(110));

    const recent = await listRecentWords(db, 10);
    expect(recent.length).toBe(3);

    const eaten = await listMostEaten(db, 1);
    expect(eaten[0]?.word).toBe('alpha');
  });
});

describe('feeding repository', () => {
  it('appends immutable events and dedupes retries by content id', async () => {
    const db = await open();
    const base = {
      creatureId: 'xrawl-0',
      word: 'fox',
      eatenAt: nowAt(100),
      environment: 'article' as const,
      pageUrl: 'https://example.com/a',
      pageTitle: 'A',
      contextSentence: 'the quick brown fox',
      contextHash: 'h1',
      fingerprint: 'fp1',
      nutrition: 0.8,
      preferenceDelta: 0.1,
    };

    const first = await appendFeedingEvent(db, base);
    const retry = await appendFeedingEvent(db, base);

    expect(retry.id).toBe(first.id);
    expect(await countFeedingEvents(db)).toBe(1);
  });

  it('queries by creature and by word using compound indexes', async () => {
    const db = await open();
    for (let index = 0; index < 3; index += 1) {
      await appendFeedingEvent(db, {
        creatureId: 'xrawl-0',
        word: index === 0 ? 'fox' : 'other',
        eatenAt: nowAt(index * 100),
        environment: 'article',
        pageUrl: 'u',
        pageTitle: 't',
        contextSentence: 'c',
        contextHash: `h${index}`,
        fingerprint: `fp${index}`,
        nutrition: 1,
        preferenceDelta: 0,
      });
    }

    const all = await listFeedingEvents(db, { creatureId: 'xrawl-0' });
    expect(all.length).toBe(3);
    expect(all[0]?.eatenAt).toBe(nowAt(200));

    const fox = await listFeedingEventsForWord(db, 'fox');
    expect(fox.length).toBe(1);
    expect(fox[0]?.word).toBe('fox');
  });
});

describe('environment repository', () => {
  it('accumulates exposure per kind and host', async () => {
    const db = await open();
    await recordEnvironmentExposure(db, {
      kind: 'article',
      host: 'example.com',
      exposureMs: 1_000,
      observations: 1,
      wordsSeen: 10,
      uniqueWords: 8,
      visit: true,
      now: nowAt(0),
    });
    await recordEnvironmentExposure(db, {
      kind: 'article',
      host: 'example.com',
      exposureMs: 500,
      observations: 1,
      wordsSeen: 5,
      uniqueWords: 3,
      now: nowAt(1_000),
    });

    const row = await db.environments.get('article:example.com');
    expect(row?.exposureMs).toBe(1_500);
    expect(row?.visits).toBe(1);
    expect(row?.wordsSeen).toBe(15);
    expect(row?.uniqueWords).toBe(8);
    expect(row?.lastExposedAt).toBe(nowAt(1_000));

    const byExposure = await listEnvironmentsByExposure(db, 5);
    expect(byExposure[0]?.id).toBe('article:example.com');

    const totals = await sumExposureByKind(db);
    expect(totals.article?.exposureMs).toBe(1_500);
  });
});

describe('session repository', () => {
  it('keeps open sessions at endedAt 0 and sums active time', async () => {
    const db = await open();
    const id = 'session-a';
    await startSession(db, id, nowAt(0));
    await recordSessionActivity(db, id, { activeMs: 1_000, observations: 1, pageVisits: 1, environment: 'article', environmentMs: 1_000 }, nowAt(1_000));
    await recordSessionActivity(db, id, { activeMs: 500, observations: 1 }, nowAt(1_500));

    const openSession = await db.sessions.get(id);
    expect(openSession?.endedAt).toBe(0);
    expect(openSession?.activeMs).toBe(1_500);
    expect(openSession?.environments.article).toBe(1_000);
    expect(await totalActiveMs(db)).toBe(1_500);

    await endSession(db, id, nowAt(2_000));
    const closed = await db.sessions.get(id);
    expect(closed?.endedAt).toBe(nowAt(2_000));

    const sessions = await listSessions(db, 5);
    expect(sessions.length).toBe(1);
  });

  it('counts feedings inside the session they occurred in', async () => {
    const db = await open();
    await startSession(db, 's', nowAt(0));
    await recordSessionActivity(db, 's', { feedingCount: 2 }, nowAt(10));
    expect((await db.sessions.get('s'))?.feedingCount).toBe(2);
  });
});

describe('upgrade repository', () => {
  it('increments levels atomically and records spend', async () => {
    const db = await open();
    await purchaseUpgrade(db, 'metabolism.chew', { cost: 10, now: nowAt(0) });
    const second = await purchaseUpgrade(db, 'metabolism.chew', { cost: 15, now: nowAt(50) });

    expect(second.level).toBe(2);
    expect(second.totalSpent).toBe(25);
    expect(await upgradeLevel(db, 'metabolism.chew')).toBe(2);
    expect(await upgradeLevel(db, 'missing')).toBe(0);
  });

  it('refuses a purchase past the level cap', async () => {
    const db = await open();
    await purchaseUpgrade(db, 'cap', { cost: 1, now: nowAt(0), maxLevel: 1 });
    await expect(
      purchaseUpgrade(db, 'cap', { cost: 1, now: nowAt(10), maxLevel: 1 }),
    ).rejects.toThrow(/max level/);
    expect(await upgradeLevel(db, 'cap')).toBe(1);
  });
});

describe('personality repository', () => {
  it('keeps values bounded and confidence rising with samples', async () => {
    const db = await open();
    for (let index = 0; index < 10; index += 1) {
      await applyPersonalityDelta(db, {
        kind: 'interest',
        key: 'birds',
        evidence: 1,
        learningRate: 0.2,
        now: nowAt(index * 10),
      });
    }

    const record = await getPersonality(db, 'interest', 'birds');
    expect(record?.id).toBe('interest:birds');
    expect(record!.value).toBeGreaterThan(0.5);
    expect(record!.value).toBeLessThanOrEqual(1);
    expect(record!.sampleCount).toBe(10);
    expect(record!.confidence).toBeGreaterThan(0.5);
  });

  it('clamps non-finite and out-of-range evidence', async () => {
    const db = await open();
    await applyPersonalityDelta(db, { kind: 'trait', key: 'x', evidence: 100, now: 0 });
    const record = await getPersonality(db, 'trait', 'x');
    expect(record?.value).toBe(1);

    await applyPersonalityDelta(db, { kind: 'trait', key: 'y', evidence: Number.NaN, now: 0 });
    expect((await getPersonality(db, 'trait', 'y'))?.value).toBe(0);
  });

  it('lists tendencies by kind and by recency', async () => {
    const db = await open();
    await applyPersonalityDelta(db, { kind: 'interest', key: 'a', evidence: 0.5, now: nowAt(0) });
    await applyPersonalityDelta(db, { kind: 'preference', key: 'b', evidence: 0.5, now: nowAt(10) });

    const interests = await listPersonality(db, 'interest');
    expect(interests.map((row) => row.key)).toEqual(['a']);

    const all = await listPersonality(db);
    expect(all[0]?.key).toBe('b');
  });
});

describe('embedding repository', () => {
  it('keys vectors by model and dimensions so a swap cannot collide', async () => {
    const db = await open();
    const base = {
      subjectType: 'word' as const,
      subjectId: 'fox',
      sourceHash: 'src-1',
      now: nowAt(0),
    };

    await putEmbedding(db, { ...base, model: 'small', vector: [0.1, 0.2] });
    const small = await findEmbedding(db, {
      model: 'small',
      dimensions: 2,
      subjectType: 'word',
      sourceHash: 'src-1',
    });
    expect(small?.dimensions).toBe(2);
    expect(small?.vector).toEqual([0.1, 0.2]);

    // Same model name, different width: a distinct row, not an overwrite.
    await putEmbedding(db, { ...base, model: 'small', vector: [0.1, 0.2, 0.3] });
    const wide = await findEmbedding(db, {
      model: 'small',
      dimensions: 3,
      subjectType: 'word',
      sourceHash: 'src-1',
    });
    expect(wide).toBeDefined();
    expect(await db.embeddings.count()).toBe(2);
  });

  it('finds the newest vector for a subject and prunes other models', async () => {
    const db = await open();
    await putEmbedding(db, {
      subjectType: 'word',
      subjectId: 'fox',
      model: 'v1',
      vector: [1],
      sourceHash: 'a',
      now: nowAt(0),
    });
    await putEmbedding(db, {
      subjectType: 'word',
      subjectId: 'fox',
      model: 'v2',
      vector: [1, 2],
      sourceHash: 'b',
      now: nowAt(10),
    });

    const newest = await findEmbeddingBySubject(db, 'v2', 'word', 'fox');
    expect(newest?.model).toBe('v2');

    const pruned = await pruneEmbeddingsForModel(db, 'v2');
    expect(pruned).toBe(1);
    expect(await db.embeddings.count()).toBe(1);
  });
});
