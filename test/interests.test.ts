/**
 * Environment interest tests: the non-AI half of the creature's taste.
 *
 * These pin what makes it trustworthy: host rules and user overrides decide the
 * category, exposure saturates instead of growing without bound, weights decay
 * lazily from timestamps, and a word's interest is a lexicon lookup rather than a
 * guess. No model is involved, which is the point.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXPOSURE_CONFIG,
  applyExposure,
  decayWeights,
  describeInterests,
  interestsForKind,
  interestsForSite,
  wordInterest,
  wordInterests,
} from '@/progression/interests';
import { HUNT_CONFIG, planHunt } from '@/progression/hunting';
import {
  describeSite,
  readInterests,
  recordBrowsingExposure,
  setSiteOverride,
} from '@/data/interests';
import { prioritizeWords } from '@/data/cognition';
import { getProgression } from '@/data/repositories/progression-repository';
import { CREATURE_ID } from '@/data/repositories/creature-repository';
import { countCalls, stubProvider } from './helpers/embeddings';
import { freshDatabaseName, nowAt, openDatabase } from './helpers/db';
import type { XrawlDatabase } from '@/data/db';
import type { ProgressionRecord } from '@/data/schema';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function open(): Promise<XrawlDatabase> {
  const opened = await openDatabase();
  cleanup.push(() => opened.destroy());
  return opened.db;
}

describe('site classification', () => {
  it('maps well-known hosts to interests without a model', () => {
    const technology = interestsForSite('github.com', 'unknown');
    expect(technology[0]?.interest).toBe('technology');

    expect(interestsForSite('allrecipes.com', 'unknown')[0]?.interest).toBe('cooking');
    expect(interestsForSite('arxiv.org', 'unknown')[0]?.interest).toBe('science');
    expect(interestsForSite('bbc.co.uk', 'unknown')[0]?.interest).toBe('news');
  });

  it('falls back to the page kind when the host is unknown', () => {
    expect(interestsForSite('example.com', 'code')[0]?.interest).toBe('technology');
    expect(interestsForSite('example.com', 'docs').map((entry) => entry.interest)).toContain(
      'technology',
    );
    expect(interestsForSite('example.com', 'article')[0]?.interest).toBe('general');
    expect(interestsForKind('email')).toHaveLength(0);
  });

  it('lets a user override win over both host rules and page kind', () => {
    const overridden = interestsForSite('github.com', 'code', 'cooking');
    expect(overridden).toEqual([{ interest: 'cooking', weight: 1 }]);

    // Absence of an override is the automatic path.
    expect(interestsForSite('github.com', 'code', null)[0]?.interest).toBe('technology');
  });
});

describe('exposure arithmetic', () => {
  it('grows toward one, and a longer visit does not grow linearly', () => {
    const short = applyExposure({ weights: {}, updatedAt: 0 }, [{ interest: 'technology', weight: 1 }], 90_000, 0);
    const long = applyExposure({ weights: {}, updatedAt: 0 }, [{ interest: 'technology', weight: 1 }], 180_000, 0);
    const twice = applyExposure(short, [{ interest: 'technology', weight: 1 }], 90_000, 90_000);

    expect(short.weights.technology!).toBeGreaterThan(0.6);
    expect(short.weights.technology!).toBeLessThan(0.7);
    expect(long.weights.technology!).toBeGreaterThan(short.weights.technology!);
    expect(long.weights.technology!).toBeLessThan(1);

    // Total focused time dominates, but a gap between visits still decays:
    // two ninety-second visits separated by ninety seconds land between one
    // ninety-second visit and one continuous three-minute visit.
    expect(twice.weights.technology!).toBeGreaterThan(short.weights.technology!);
    expect(twice.weights.technology!).toBeLessThan(long.weights.technology!);
  });

  it('halves an interest after one half-life and forgets it eventually', () => {
    const halfLife = EXPOSURE_CONFIG.halfLifeMs;
    const decayed = decayWeights({ technology: 0.8 }, halfLife);
    expect(decayed.technology!).toBeCloseTo(0.4, 6);

    // Many half-lives of silence prune the interest instead of keeping noise.
    const forgotten = decayWeights({ technology: 0.8 }, halfLife * 6);
    expect(forgotten.technology).toBeUndefined();
  });

  it('keeps unrelated interests while raising a new one', () => {
    const current = { weights: { technology: 0.9, cooking: 0.1 }, updatedAt: 0 };
    const next = applyExposure(current, [{ interest: 'cooking', weight: 1 }], 60_000, 60_000);

    expect(next.weights.cooking!).toBeGreaterThan(current.weights.cooking!);
    expect(next.weights.technology!).toBeLessThan(current.weights.technology!);
    expect(describeInterests(next.weights)[0]?.interest).toBe('technology');
  });

  it('ignores a zero-length or clock-skewed visit', () => {
    const current = { weights: { technology: 0.5 }, updatedAt: nowAt(0) };
    const empty = applyExposure(current, [{ interest: 'technology', weight: 1 }], 0, nowAt(0));
    expect(empty.weights.technology).toBeCloseTo(0.5, 9);
  });
});

describe('word interests', () => {
  it('matches a word to the interests whose lists name it', () => {
    expect(wordInterests('database')).toContain('technology');
    expect(wordInterests('recipe')).toContain('cooking');
    expect(wordInterests('xyzzy')).toEqual([]);
  });

  it('scores by the creature\u2019s weights, and 0 for unknown words', () => {
    expect(wordInterest('database', { technology: 0.8, cooking: 0.1 })).toBe(0.8);
    expect(wordInterest('recipe', { technology: 0.8, cooking: 0.2 })).toBe(0.2);
    expect(wordInterest('recipe', { technology: 0.9 })).toBe(0);
    expect(wordInterest('xyzzy', { technology: 1 })).toBe(0);
  });

  it('raises hunting priority for a word the creature is curious about', () => {
    const base = {
      word: 'database',
      embedding: [],
      profiles: [],
      timesEaten: 0,
      rarity: 0.5,
    };

    const indifferent = planHunt({ ...base, interest: 0 });
    const curious = planHunt({ ...base, interest: 0.8 });
    expect(curious.priority - indifferent.priority).toBeCloseTo(
      HUNT_CONFIG.interest * 0.8,
      9,
    );
  });
});

describe('browsing interests in the store', () => {
  it('records exposure on the progression row and decays on read', async () => {
    const db = await open();
    await recordBrowsingExposure(db, {
      host: 'github.com',
      environment: 'code',
      activeMs: 90_000,
      now: nowAt(0),
    });

    const row = await getProgression(db, CREATURE_ID);
    expect(row?.interests.technology).toBeGreaterThan(0.6);
    expect(row?.interestsUpdatedAt).toBe(nowAt(0));

    const later = await readInterests(db, nowAt(EXPOSURE_CONFIG.halfLifeMs));
    expect(later.weights.technology!).toBeCloseTo((row?.interests.technology ?? 0) / 2, 4);
  });

  it('respects a stored override instead of the host rule', async () => {
    const db = await open();
    await setSiteOverride(db, 'github.com', 'cooking', nowAt(0));

    const result = await recordBrowsingExposure(db, {
      host: 'www.github.com',
      environment: 'code',
      activeMs: 60_000,
      now: nowAt(1),
    });

    expect(result.overridden).toBe(true);
    expect(result.interest).toBe('cooking');

    const site = await describeSite(db, 'github.com', 'code');
    expect(site.override).toBe('cooking');
    expect(site.interests).toEqual([{ interest: 'cooking', weight: 1 }]);
  });

  it('clears an override back to automatic', async () => {
    const db = await open();
    await setSiteOverride(db, 'github.com', 'cooking', nowAt(0));
    await setSiteOverride(db, 'github.com', null, nowAt(1));

    const site = await describeSite(db, 'github.com', 'code');
    expect(site.override).toBeNull();
    expect(site.interests[0]?.interest).toBe('technology');
    expect(await db.interestOverrides.count()).toBe(0);
  });

  it('makes hunting prefer words from a deeply visited interest', async () => {
    const db = await open();
    const provider = stubProvider();

    // Three focused minutes on a code host: technology should lead.
    await recordBrowsingExposure(db, {
      host: 'github.com',
      environment: 'code',
      activeMs: 180_000,
      now: nowAt(0),
    });

    const priorities = await prioritizeWords(
      db,
      provider,
      [{ word: 'database' }, { word: 'recipe' }],
      { now: nowAt(1), contextLimit: 0 },
    );

    const technical = priorities.find((entry) => entry.word === 'database')!;
    const cooking = priorities.find((entry) => entry.word === 'recipe')!;
    expect(technical.interest).toBeGreaterThan(0.8);
    expect(cooking.interest).toBe(0);
    expect(technical.priority).toBeGreaterThan(cooking.priority);
    expect(countCalls(provider)).toBeGreaterThan(0);
  });
});

describe('interest migration', () => {
  it('backfills interests for a v5 world without inventing any', async () => {
    const name = freshDatabaseName('xrawl-interests-migration');

    const old = await openDatabase({ name, schemaVersion: 5 });
    const legacyRow = {
      id: CREATURE_ID,
      xp: 40,
      level: 2,
      wordPoints: 3,
      lifetimeWordPoints: 5,
      spentWordPoints: 2,
      feedings: 4,
      discoveries: 3,
      environments: { code: 4 },
      affinities: { code: 1 },
      updatedAt: nowAt(0),
    } as unknown as ProgressionRecord;
    await old.db.progression.put(legacyRow);
    old.close();

    const reopened = await openDatabase({ name });
    cleanup.push(() => reopened.destroy());

    const row = await reopened.db.progression.get(CREATURE_ID);
    expect(row?.interests).toEqual({});
    expect(row?.interestsUpdatedAt).toBe(0);
    expect(row?.xp).toBe(40);
    expect(await reopened.db.interestOverrides.count()).toBe(0);
  });
});
