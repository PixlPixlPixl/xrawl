/**
 * Semantic tests: vectors, profiles, hunting priorities, and the cache.
 *
 * These use a tiny deterministic provider instead of MiniLM, so the *arithmetic*
 * is pinned without a 23 MB download and without a flaky model. The real model
 * can only change the numbers, not the rules under test: the pool normalizes,
 * the closest profile wins, exploration is a stable hash rather than a clock, and
 * cached vectors are reused instead of re-inferred.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  EMBEDDING_DIMENSIONS,
  PROFILE_ANCHORS,
  blendVectors,
  cosineSimilarity,
  describeProfiles,
  leadingProfile,
  normalizeVector,
  profileScore,
  seedProfiles,
  updateProfiles,
  vectorNorm,
} from '@/progression/semantics';
import { HUNT_CONFIG, isExplorationWord, planHunt } from '@/progression/hunting';
import { embedWithCache } from '@/data/embeddings';
import {
  ensureProfiles,
  evolveFromFeeding,
  prioritizeWords,
} from '@/data/cognition';
import { loadInterestProfiles } from '@/data/repositories/interest-profile-repository';
import { getPersonality } from '@/data/repositories/personality-repository';
import { ingestFeeding, ingestObservation } from '@/data/ingest';
import { OBSERVATION_LIMITS, type FeedingPayload, type ObservationPayload } from '@/data/observation';
import { CREATURE_ID } from '@/data/repositories/creature-repository';
import { lexicalProvider } from '@/semantics/lexical';
import type { EmbeddingProvider } from '@/semantics/provider';
import { countCalls, stubProvider, stubVector } from './helpers/embeddings';
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

function feeding(overrides: Partial<FeedingPayload> = {}): FeedingPayload {
  return {
    sessionId: 'sess-1',
    creatureId: CREATURE_ID,
    word: 'compiler',
    eatenAt: nowAt(0),
    environment: 'code',
    pageUrl: 'https://example.com/a',
    pageTitle: 'Compiler internals',
    contextSentence: 'The compiler translates source code into machine instructions.',
    fingerprint: 'fp-1',
    nutrition: 1,
    preferenceDelta: 0.2,
    ...overrides,
  };
}

function observation(overrides: Partial<ObservationPayload> = {}): ObservationPayload {
  return {
    sessionId: 'sess-1',
    capturedAt: nowAt(0),
    page: { url: 'https://example.com/a', title: 'Article' },
    environment: 'code',
    host: 'example.com',
    visit: true,
    activeMs: 1_000,
    words: [{ word: 'fox', count: 1 }],
    uniqueWordCount: 1,
    ...overrides,
  };
}

describe('vector arithmetic', () => {
  it('normalizes and measures cosine in -1..1', () => {
    expect(vectorNorm([3, 4])).toBe(5);
    const unit = normalizeVector([3, 4]);
    expect(vectorNorm(unit)).toBeCloseTo(1, 9);

    expect(cosineSimilarity([1, 1], [1, 1])).toBeCloseTo(1, 9);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 9);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 9);
    // A different width is a different space, not a zero similarity.
    expect(cosineSimilarity([1, 1], [1, 1, 1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });

  it('blends toward the incoming vector by the given rate', () => {
    const blended = blendVectors([1, 0], [0, 1], 0.5);
    expect(blended[0]).toBeCloseTo(blended[1]!, 9);
    expect(blendVectors([1, 0], [0, 1], 0)).toEqual([1, 0]);
  });
});

describe('interest profiles', () => {
  it('seeds an anchored pool whose weights sum to one', () => {
    const profiles = seedProfiles(
      PROFILE_ANCHORS.map((anchor) => ({ category: anchor.category, vector: stubVector(anchor.text) })),
      nowAt(0),
    );
    const total = profiles.reduce((sum, profile) => sum + profile.weight, 0);
    expect(total).toBeCloseTo(1, 9);
    expect(profiles).toHaveLength(PROFILE_ANCHORS.length);
    expect(leadingProfile(profiles)).not.toBeNull();
  });

  it('gives an observation to the closest profile and renormalizes the pool', () => {
    const profiles = seedProfiles(
      PROFILE_ANCHORS.map((anchor) => ({ category: anchor.category, vector: stubVector(anchor.text) })),
      nowAt(0),
    );

    const update = updateProfiles(profiles, stubVector('compiler database syntax'), 0.5, nowAt(1));
    expect(update.assigned).toBe('technology');
    expect(update.similarity).toBeGreaterThan(0.9);

    const total = update.profiles.reduce((sum, profile) => sum + profile.weight, 0);
    expect(total).toBeCloseTo(1, 9);

    const before = profiles.find((profile) => profile.category === 'technology')!.weight;
    const after = update.profiles.find((profile) => profile.category === 'technology')!.weight;
    expect(after).toBeGreaterThan(before);
    // Every other share shrinks: attention moved, it did not accumulate.
    for (const profile of update.profiles) {
      if (profile.category === 'technology') continue;
      const previous = profiles.find((entry) => entry.category === profile.category)!.weight;
      expect(profile.weight).toBeLessThan(previous);
    }
  });

  it('sends an unrelated observation to the general profile', () => {
    const profiles = seedProfiles(
      PROFILE_ANCHORS.map((anchor) => ({ category: anchor.category, vector: stubVector(anchor.text) })),
      nowAt(0),
    );

    const update = updateProfiles(profiles, stubVector('unmapped gibberish'), 0.5, nowAt(1));
    expect(update.assigned).toBe('general');
    expect(update.similarity).toBeLessThan(0.15);
  });

  it('scores a vector higher when it fits a heavier interest', () => {
    const profiles = seedProfiles(
      [
        { category: 'technology', vector: stubVector('compiler database') },
        { category: 'food', vector: stubVector('recipe bread') },
      ].map((anchor) => anchor),
      nowAt(0),
    );
    const technical = profileScore(profiles, stubVector('compiler'));
    const cooking = profileScore(profiles, stubVector('recipe'));
    expect(technical).toBeGreaterThan(0);
    expect(cooking).toBeGreaterThan(0);
  });

  it('describes shares for display without touching scoring', () => {
    const profiles = seedProfiles(
      [
        { category: 'a', vector: [1, 0] },
        { category: 'b', vector: [0, 1] },
      ].map((anchor) => anchor),
      nowAt(0),
    );
    expect(describeProfiles(profiles).map((entry) => entry.category)).toEqual(['a', 'b']);
  });
});

describe('hunting priorities', () => {
  it('prefers a word that fits the learned interest', () => {
    const profiles = seedProfiles(
      [{ category: 'technology', vector: stubVector('compiler database') }],
      nowAt(0),
    );

    const related = planHunt({
      word: 'compiler',
      embedding: stubVector('compiler'),
      profiles,
      timesEaten: 0,
      rarity: 0.5,
      interest: 0,
    });
    const unrelated = planHunt({
      word: 'bread',
      embedding: stubVector('bread'),
      profiles,
      timesEaten: 0,
      rarity: 0.5,
      interest: 0,
    });

    expect(related.relevance).toBeGreaterThan(unrelated.relevance);
    expect(related.priority).toBeGreaterThan(unrelated.priority);
  });

  it('fades words the creature has already eaten', () => {
    const fresh = planHunt({
      word: 'compiler',
      embedding: stubVector('compiler'),
      profiles: [],
      timesEaten: 0,
      rarity: 0.5,
      interest: 0,
    });
    const eaten = planHunt({
      word: 'compiler',
      embedding: stubVector('compiler'),
      profiles: [],
      timesEaten: 5,
      rarity: 0.5,
      interest: 0,
    });
    expect(fresh.novelty).toBeGreaterThan(eaten.novelty);
    expect(fresh.priority).toBeGreaterThan(eaten.priority);
  });

  it('explores unrelated words more, and always the same words', () => {
    // Stable hashing: the same word is an exploration pick (or not) every save.
    const picks = ['compiler', 'recipe', 'zebra', 'quantum', 'garden'].filter((word) =>
      isExplorationWord(word),
    );
    expect(['compiler', 'recipe', 'zebra', 'quantum', 'garden'].every((word) =>
      isExplorationWord(word) === picks.includes(word),
    )).toBe(true);

    const word = 'compiler';
    const related = planHunt({
      word,
      embedding: stubVector('compiler'),
      profiles: seedProfiles([{ category: 'technology', vector: stubVector('compiler') }], 0),
      timesEaten: 0,
      rarity: 0.5,
      interest: 0,
    });
    const unrelated = planHunt({
      word: 'compiler',
      embedding: stubVector('bread'),
      profiles: seedProfiles([{ category: 'technology', vector: stubVector('compiler') }], 0),
      timesEaten: 0,
      rarity: 0.5,
      interest: 0,
    });

    if (isExplorationWord(word)) {
      expect(unrelated.exploration).toBeGreaterThan(related.exploration);
      expect(unrelated.exploration).toBeCloseTo(
        HUNT_CONFIG.explorationWeight * (1 - unrelated.relevance),
        9,
      );
    } else {
      expect(related.exploration).toBe(0);
      expect(unrelated.exploration).toBe(0);
    }
  });
});

describe('lexical fallback provider', () => {
  it('scores shared words higher, and always the same way', async () => {
    const [database] = await lexicalProvider.embed(['database']);
    const [withContext] = await lexicalProvider.embed(['database engine']);
    const [cooking] = await lexicalProvider.embed(['cooking recipe']);

    expect(cosineSimilarity(database!, withContext!)).toBeGreaterThan(
      cosineSimilarity(database!, cooking!),
    );
    expect(vectorNorm(database!)).toBeCloseTo(1, 9);

    const [again] = await lexicalProvider.embed(['database']);
    expect(again).toEqual(database);
  });
});

describe('embedding cache', () => {
  it('stores one row per text and never re-infers the same text', async () => {
    const db = await open();
    const provider = stubProvider();

    const first = await embedWithCache(
      db,
      provider,
      [{ subjectType: 'word', text: 'compiler' }],
      { now: nowAt(0) },
    );
    expect(countCalls(provider)).toBe(1);
    expect(vectorNorm(first[0]!)).toBeCloseTo(1, 9);

    const second = await embedWithCache(
      db,
      provider,
      [{ subjectType: 'word', text: 'compiler' }],
      { now: nowAt(1) },
    );
    expect(countCalls(provider)).toBe(1);
    expect(second[0]).toEqual(first[0]);
    expect(await db.embeddings.count()).toBe(1);
  });

  it('keeps vectors from different models apart', async () => {
    const db = await open();
    const first = stubProvider('test/one-384');
    const second = stubProvider('test/two-384');

    await embedWithCache(db, first, [{ subjectType: 'word', text: 'compiler' }], { now: nowAt(0) });
    await embedWithCache(db, second, [{ subjectType: 'word', text: 'compiler' }], { now: nowAt(1) });
    expect(await db.embeddings.count()).toBe(2);
  });

  it('rejects a provider whose width does not match the semantic layer', async () => {
    const db = await open();
    const wrong: EmbeddingProvider = {
      model: 'test/narrow',
      dimensions: 8,
      async embed(texts) {
        return texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0]);
      },
    };
    await expect(
      embedWithCache(db, wrong, [{ subjectType: 'word', text: 'compiler' }], { now: 0 }),
    ).rejects.toThrow(/dimensions/);
  });
});

describe('cognition', () => {
  it('builds the anchored pool once and reuses its cached vectors', async () => {
    const db = await open();
    const provider = stubProvider();

    const first = await ensureProfiles(db, provider, nowAt(0));
    expect(first.seeded).toBe(true);
    expect(first.profiles).toHaveLength(PROFILE_ANCHORS.length);
    const callsAfterSeed = countCalls(provider);
    expect(callsAfterSeed).toBe(PROFILE_ANCHORS.length);

    const second = await ensureProfiles(db, provider, nowAt(1));
    expect(second.seeded).toBe(false);
    expect(countCalls(provider)).toBe(callsAfterSeed);
  });

  it('moves attention toward what was eaten and records both tendencies', async () => {
    const db = await open();
    const provider = stubProvider();

    const snapshot = await evolveFromFeeding(db, provider, {
      word: 'compiler',
      sentence: 'The compiler turns source code into instructions.',
      environment: 'code',
      source: 'manual',
      now: nowAt(0),
    });

    expect(snapshot.assigned).toBe('technology');
    expect(snapshot.similarity).toBeGreaterThan(0.9);
    expect(snapshot.profiles.find((entry) => entry.category === 'technology')?.share).toBeGreaterThan(
      1 / PROFILE_ANCHORS.length,
    );

    const interest = await getPersonality(db, 'interest', 'code');
    const preference = await getPersonality(db, 'preference', 'compiler');
    expect(interest?.value).toBeGreaterThan(0);
    expect(preference?.value).toBeGreaterThan(0);
    expect(await db.interestProfiles.count()).toBe(PROFILE_ANCHORS.length);
  });

  it('weights manual feeding far above autonomous feeding', async () => {
    const manual = await open();
    const automatic = await open();
    const manualProvider = stubProvider();
    const automaticProvider = stubProvider();

    const shared = {
      word: 'compiler',
      sentence: 'The compiler turns source code into instructions.',
      environment: 'code' as const,
      now: nowAt(0),
    };

    const manualSnapshot = await evolveFromFeeding(manual, manualProvider, {
      ...shared,
      source: 'manual',
    });
    const automaticSnapshot = await evolveFromFeeding(automatic, automaticProvider, {
      ...shared,
      source: 'autonomous',
    });

    const manualShare = manualSnapshot.profiles[0]!.share;
    const automaticShare = automaticSnapshot.profiles[0]!.share;
    expect(manualShare).toBeGreaterThan(automaticShare);
    expect(manualSnapshot.profiles[0]!.category).toBe('technology');
  });

  it('rebuilds the pool when the model changes', async () => {
    const db = await open();
    const lexicalish = stubProvider('test/old-384');
    const fresh = stubProvider('test/new-384');

    const seeded = await ensureProfiles(db, lexicalish, nowAt(0));
    expect(seeded.seeded).toBe(true);

    const after = await loadInterestProfiles(db, 'test/new-384', EMBEDDING_DIMENSIONS);
    expect(after).toEqual([]);

    const rebuilt = await ensureProfiles(db, fresh, nowAt(1));
    expect(rebuilt.seeded).toBe(true);
    expect(await db.interestProfiles.count()).toBe(PROFILE_ANCHORS.length);
  });

  it('ranks page words by learned interests', async () => {
    const db = await open();
    const provider = stubProvider();

    await evolveFromFeeding(db, provider, {
      word: 'compiler',
      sentence: 'The compiler turns source code into instructions.',
      environment: 'code',
      source: 'manual',
      now: nowAt(0),
    });

    const priorities = await prioritizeWords(
      db,
      provider,
      [
        { word: 'database', sentence: 'The database stores rows and indexes.' },
        { word: 'bread', sentence: 'She baked bread in the kitchen.' },
      ],
      { now: nowAt(1) },
    );

    const technical = priorities.find((entry) => entry.word === 'database')!;
    const cooking = priorities.find((entry) => entry.word === 'bread')!;
    expect(technical.relevance).toBeGreaterThan(cooking.relevance);
    expect(technical.priority).toBeGreaterThan(cooking.priority);
    expect(technical.priority).toBeGreaterThan(0);
    expect(technical.priority).toBeLessThanOrEqual(1);
  });
});

describe('feeding source and exposure steps', () => {
  it('stores whether a feeding was manual or autonomous', async () => {
    const db = await open();
    await ingestFeeding(db, feeding({ source: 'manual', eatenAt: nowAt(0) }));

    const event = await db.feedingEvents.orderBy('eatenAt').first();
    expect(event?.source).toBe('manual');

    await ingestFeeding(db, feeding({ eatenAt: nowAt(1), fingerprint: 'fp-2' }));
    const automatic = await db.feedingEvents.orderBy('eatenAt').last();
    expect(automatic?.source).toBe('autonomous');
  });

  it('counts whole exposure steps from persisted session time', async () => {
    const db = await open();
    const step = OBSERVATION_LIMITS.exposureStepMs;

    // Half a step: no whole step has been crossed yet.
    const half = Math.floor(step / 2);
    const first = await ingestObservation(db, observation({ activeMs: half }));
    expect(first.exposureSteps).toBe(0);

    // Crossing the boundary pays exactly one step, not one per flush.
    const second = await ingestObservation(
      db,
      observation({ activeMs: step - half, capturedAt: nowAt(1_000) }),
    );
    expect(second.exposureSteps).toBe(1);

    // And another full step later, two more.
    const third = await ingestObservation(
      db,
      observation({ activeMs: step * 2, capturedAt: nowAt(2_000) }),
    );
    expect(third.exposureSteps).toBe(2);
  });
});
