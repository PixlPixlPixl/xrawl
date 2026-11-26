/**
 * Progression tests: the deterministic reward/upgrade system.
 *
 * These pin the properties that make progression trustworthy: capped bonuses,
 * neutral treatment of unknown words, discovery awarded only once, idempotent
 * deliveries, and a shop that cannot spend points it does not have.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  decodeFrequencyTable,
  frequencyMap,
  lookupZipf,
  rarityScore,
  UNKNOWN_WORD_RARITY,
  wordRarity,
} from '@/progression/frequency';
import { WORD_FREQUENCY_TABLE } from '@/progression/data/wordfreq-en';
import {
  AFFINITY_CONFIG,
  affinityFromCounts,
  environmentShare,
  isEligibleDiscoveryWord,
  nextAffinity,
  personalityAffinity,
} from '@/progression/affinity';
import { computeReward, REWARD_CONFIG } from '@/progression/reward';
import {
  MAX_LEVEL,
  levelForXp,
  levelProgress,
  levelThresholds,
  stageForLevel,
  totalXpForLevel,
  xpToAdvance,
} from '@/progression/level';
import { UPGRADE_CATALOG, catalogIdsWithoutEffect, findUpgrade, upgradeCost } from '@/progression/upgrades';
import { ingestFeeding } from '@/data/ingest';
import { awardFeeding, purchaseUpgradeWithPoints, upgradeStatuses } from '@/data/progression';
import { getProgression } from '@/data/repositories/progression-repository';
import { CREATURE_ID } from '@/data/repositories/creature-repository';
import { freshDatabaseName, nowAt, openDatabase } from './helpers/db';
import type { XrawlDatabase } from '@/data/db';
import type { ProgressionRecord } from '@/data/schema';
import type { FeedingPayload } from '@/data/observation';

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
    word: 'octopus',
    eatenAt: nowAt(0),
    environment: 'article',
    pageUrl: 'https://example.com/a',
    pageTitle: 'Article',
    contextSentence: 'an octopus in the sea',
    fingerprint: 'fp-1',
    nutrition: 1,
    preferenceDelta: 0,
    ...overrides,
  };
}

describe('frequency table', () => {
  it('round-trips the shipped encoding', () => {
    const decoded = decodeFrequencyTable(WORD_FREQUENCY_TABLE);
    expect(decoded.size).toBeGreaterThan(25_000);
    expect(decoded.get('the')).toBeGreaterThan(7);
  });

  it('gives common words a low rarity and clamps the scale', () => {
    expect(rarityScore(9)).toBe(0);
    expect(rarityScore(6)).toBe(0);
    expect(rarityScore(4.5)).toBeCloseTo(0.5, 5);
    expect(rarityScore(3)).toBe(1);
    expect(rarityScore(1)).toBe(1);
  });

  it('treats unknown words as neutral instead of maximally rare', () => {
    const unknown = wordRarity('zzznotawordzzz');
    expect(unknown.known).toBe(false);
    expect(unknown.zipf).toBeNull();
    expect(unknown.rarity).toBe(UNKNOWN_WORD_RARITY);
    expect(rarityScore(Number.NaN)).toBe(UNKNOWN_WORD_RARITY);

    const common = wordRarity('the');
    expect(common.known).toBe(true);
    expect(common.rarity).toBe(0);
    expect(lookupZipf('the')).toBe(common.zipf);
    expect(frequencyMap().size).toBe(decodeFrequencyTable(WORD_FREQUENCY_TABLE).size);
  });
});

describe('reward formula', () => {
  const baseInput = {
    word: 'octopus',
    environment: 'article' as const,
    isNewDiscovery: false,
    priorEats: 2,
    environmentShare: 0,
    personalityAffinity: 0,
  };

  it('caps every bonus so one huge rare word cannot dominate', () => {
    const giant = computeReward({
      ...baseInput,
      word: 'a'.repeat(64),
      isNewDiscovery: true,
      zipf: 0,
    });

    expect(giant.length).toBe(REWARD_CONFIG.length.cap);
    expect(giant.rarity).toBe(REWARD_CONFIG.rarity.cap);
    expect(giant.discovery).toBe(REWARD_CONFIG.discovery.first);
    expect(giant.total).toBeLessThanOrEqual(
      REWARD_CONFIG.base +
        REWARD_CONFIG.length.cap +
        REWARD_CONFIG.rarity.cap +
        REWARD_CONFIG.discovery.first +
        REWARD_CONFIG.environment.cap +
        REWARD_CONFIG.personality.cap,
    );
  });

  it('awards more for a first discovery than for repeats, with a floor', () => {
    const first = computeReward({ ...baseInput, isNewDiscovery: true, priorEats: 0 });
    const second = computeReward({ ...baseInput, priorEats: 1 });
    const repeated = computeReward({ ...baseInput, priorEats: 40 });

    expect(first.discovery).toBeGreaterThan(second.discovery);
    expect(second.discovery).toBeGreaterThan(repeated.discovery);
    expect(repeated.discovery).toBe(REWARD_CONFIG.discovery.repeatFloor);
  });

  it('keeps word points proportional to XP, not a second independent curve', () => {
    const breakdown = computeReward({ ...baseInput, zipf: 4.5 });
    expect(breakdown.xp).toBe(Math.round(breakdown.total));
    expect(breakdown.wordPoints).toBe(Math.floor(breakdown.total * REWARD_CONFIG.wordPointShare));
  });

  it('pays the environment bonus in proportion to that environment share', () => {
    const wholeDiet = computeReward({ ...baseInput, environmentShare: 1 });
    const sixty = computeReward({ ...baseInput, environmentShare: 0.6 });
    const tenth = computeReward({ ...baseInput, environmentShare: 0.1 });
    const none = computeReward({ ...baseInput, environmentShare: 0 });

    // Pool 10, normalized by 0.5: a favourite is a moderate 5, not a runaway.
    expect(REWARD_CONFIG.environment.pool).toBe(10);
    expect(REWARD_CONFIG.environment.normalizer).toBe(0.5);
    expect(wholeDiet.environment).toBe(REWARD_CONFIG.environment.cap);
    expect(wholeDiet.environment).toBe(5);
    expect(sixty.environment).toBe(3);
    expect(tenth.environment).toBe(0.5);
    expect(none.environment).toBe(0);
  });

  it('ignores out-of-range affinity inputs rather than scaling them up', () => {
    const negative = computeReward({ ...baseInput, environmentShare: -3, personalityAffinity: -2 });
    expect(negative.environment).toBe(0);
    expect(negative.personality).toBe(0);

    const huge = computeReward({ ...baseInput, environmentShare: 5, personalityAffinity: 5 });
    expect(huge.environment).toBe(REWARD_CONFIG.environment.cap);
    expect(huge.personality).toBe(REWARD_CONFIG.personality.cap);
  });
});

describe('levels', () => {
  it('derives levels from cumulative XP', () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(totalXpForLevel(2))).toBe(2);
    expect(levelForXp(totalXpForLevel(3) - 1)).toBe(2);
    expect(levelForXp(Number.MAX_SAFE_INTEGER)).toBe(MAX_LEVEL);

    const progress = levelProgress(totalXpForLevel(5) + 3);
    expect(progress.level).toBe(5);
    expect(progress.intoLevel).toBe(3);
  });

  it('is monotonic and strictly increasing in cost', () => {
    const thresholds = levelThresholds();
    for (let index = 1; index < thresholds.length; index += 1) {
      expect(thresholds[index]!).toBeGreaterThan(thresholds[index - 1]!);
      expect(xpToAdvance(index + 1)).toBeGreaterThan(xpToAdvance(index));
    }
  });

  it('maps levels onto life stages', () => {
    expect(stageForLevel(1)).toBe('hatchling');
    expect(stageForLevel(5)).toBe('nymph');
    expect(stageForLevel(12)).toBe('juvenile');
    expect(stageForLevel(20)).toBe('adult');
    expect(stageForLevel(31)).toBe('elder');
  });
});

describe('upgrade catalog', () => {
  it('only sells upgrades that actually change an attribute', () => {
    expect(catalogIdsWithoutEffect()).toEqual([]);
  });

  it('prices each level above the one before it', () => {
    for (const definition of UPGRADE_CATALOG) {
      for (let level = 2; level <= definition.maxLevel; level += 1) {
        expect(upgradeCost(definition, level)).toBeGreaterThan(upgradeCost(definition, level - 1));
      }
    }
    expect(findUpgrade('senses.vocabulary')?.maxLevel).toBe(6);
  });
});

describe('affinity inputs', () => {
  it('seeds a distribution from recorded counts, always summing to 100%', () => {
    expect(affinityFromCounts({})).toEqual({});
    expect(affinityFromCounts({ article: 3 })).toEqual({ article: 1 });

    const seeded = affinityFromCounts({ code: 6, docs: 3, article: 1 });
    expect(environmentShare(seeded, 'code')).toBeCloseTo(0.6, 6);
    expect(environmentShare(seeded, 'docs')).toBeCloseTo(0.3, 6);
    expect(environmentShare(seeded, 'article')).toBeCloseTo(0.1, 6);
    expect(environmentShare(seeded, 'video')).toBe(0);
  });

  it('moves affinity toward the environment just fed, shrinking the others', () => {
    const start = { code: 1 };
    const oneArticle = nextAffinity(start, 'article');

    // One feeding claims the learning rate; the rest of the pool is renormalized.
    expect(environmentShare(oneArticle, 'article')).toBeCloseTo(AFFINITY_CONFIG.learningRate, 6);
    expect(environmentShare(oneArticle, 'code')).toBeCloseTo(1 - AFFINITY_CONFIG.learningRate, 6);

    const twoArticles = nextAffinity(oneArticle, 'article');
    expect(environmentShare(twoArticles, 'article')).toBeGreaterThan(
      environmentShare(oneArticle, 'article'),
    );
    expect(environmentShare(twoArticles, 'code')).toBeLessThan(environmentShare(oneArticle, 'code'));

    for (const distribution of [start, oneArticle, twoArticles]) {
      const total = Object.values(distribution).reduce((sum, value) => sum + (value ?? 0), 0);
      expect(total).toBeCloseTo(1, 9);
    }
  });

  it('settles on the feeding mix rather than on the total count', () => {
    // Six code feedings and four article feedings, interleaved evenly.
    const pattern = [
      'code',
      'code',
      'article',
      'code',
      'code',
      'article',
      'code',
      'article',
      'article',
      'code',
    ] as const;

    let distribution = nextAffinity({}, 'code');
    for (let index = 1; index < 300; index += 1) {
      distribution = nextAffinity(distribution, pattern[index % pattern.length]!);
    }

    // ~60% of the diet is code, so ~60% of the pool is technical affinity.
    expect(environmentShare(distribution, 'code')).toBeGreaterThan(0.5);
    expect(environmentShare(distribution, 'code')).toBeLessThan(0.7);
    expect(environmentShare(distribution, 'article')).toBeGreaterThan(0.3);
    expect(environmentShare(distribution, 'article')).toBeLessThan(0.5);
  });

  it('matches interests by environment and preferences by word only', () => {
    const records = [
      { kind: 'interest' as const, key: 'article', value: 0.5, confidence: 1 },
      { kind: 'preference' as const, key: 'octopus', value: 0.4, confidence: 0.5 },
      { kind: 'preference' as const, key: 'unrelated', value: 1, confidence: 1 },
      { kind: 'trait' as const, key: 'curious', value: 1, confidence: 1 },
    ];

    expect(personalityAffinity(records, { word: 'octopus', environment: 'article' })).toBeCloseTo(0.7, 5);
    expect(personalityAffinity(records, { word: 'other', environment: 'docs' })).toBe(0);
  });

  it('does not count fragments or numbers as discoveries', () => {
    expect(isEligibleDiscoveryWord('a')).toBe(false);
    expect(isEligibleDiscoveryWord('7')).toBe(false);
    expect(isEligibleDiscoveryWord('!!')).toBe(false);
    expect(isEligibleDiscoveryWord('two words')).toBe(false);
    expect(isEligibleDiscoveryWord('cat')).toBe(true);
    expect(isEligibleDiscoveryWord('x2')).toBe(true);
    expect(isEligibleDiscoveryWord('caf\u00e9')).toBe(true);
  });
});

describe('feeding awards', () => {
  it('awards XP and word points once per word, less on repeats', async () => {
    const db = await open();

    await ingestFeeding(db, feeding({ eatenAt: nowAt(0), fingerprint: 'fp-1' }));
    const afterFirst = await getProgression(db, CREATURE_ID);
    expect(afterFirst?.discoveries).toBe(1);
    expect(afterFirst?.feedings).toBe(1);
    expect(afterFirst?.xp).toBeGreaterThan(0);
    expect(afterFirst?.wordPoints).toBeGreaterThan(0);

    await ingestFeeding(db, feeding({ eatenAt: nowAt(1_000), fingerprint: 'fp-2' }));
    const afterSecond = await getProgression(db, CREATURE_ID);
    expect(afterSecond?.discoveries).toBe(1);
    expect(afterSecond?.feedings).toBe(2);

    const lastReward = await awardFeeding(db, {
      word: 'octopus',
      environment: 'article',
      isNewDiscovery: false,
      priorEats: 2,
      now: nowAt(2_000),
    });
    expect(lastReward.discovered).toBe(false);
    expect(lastReward.breakdown.discovery).toBeLessThan(
      computeReward({
        word: 'octopus',
        environment: 'article',
        isNewDiscovery: true,
        priorEats: 0,
        environmentShare: 0,
        personalityAffinity: 0,
      }).discovery,
    );
  });

  it('is idempotent: replaying the same feeding awards nothing twice', async () => {
    const db = await open();
    const payload = feeding({ eatenAt: nowAt(0), fingerprint: 'fp-dup' });

    await ingestFeeding(db, payload);
    const once = await getProgression(db, CREATURE_ID);
    await ingestFeeding(db, payload);
    const twice = await getProgression(db, CREATURE_ID);

    expect(twice).toEqual(once);
  });

  it('uses environment history for the affinity term', async () => {
    const db = await open();
    await ingestFeeding(db, feeding({ word: 'alpha', environment: 'docs', eatenAt: nowAt(0) }));
    await ingestFeeding(db, feeding({ word: 'beta', environment: 'docs', eatenAt: nowAt(1) }));
    const third = await awardFeeding(db, {
      word: 'gamma',
      environment: 'docs',
      isNewDiscovery: true,
      priorEats: 0,
      now: nowAt(2),
    });

    // Only docs has been eaten, so it holds the whole pool: the full 5 points.
    expect(third.environmentShare).toBe(1);
    expect(third.breakdown.environment).toBe(REWARD_CONFIG.environment.cap);
    expect(third.affinities).toEqual({ docs: 1 });

    // One article feeding hands 20% of the pool to article, shrinking docs.
    await ingestFeeding(db, feeding({ word: 'delta', environment: 'article', eatenAt: nowAt(3) }));
    expect(third.affinities).toEqual({ docs: 1 });

    const nextDocs = await awardFeeding(db, {
      word: 'epsilon',
      environment: 'docs',
      isNewDiscovery: true,
      priorEats: 0,
      now: nowAt(4),
    });
    expect(nextDocs.environmentShare).toBeCloseTo(0.8, 6);
    expect(nextDocs.breakdown.environment).toBe(4);

    const article = await awardFeeding(db, {
      word: 'zeta',
      environment: 'article',
      isNewDiscovery: true,
      priorEats: 0,
      now: nowAt(5),
    });
    expect(article.environmentShare).toBeCloseTo(0.16, 6);
    expect(article.breakdown.environment).toBe(0.8);

    // The pool is always 100%, however many environments are in play.
    const total = Object.values(article.affinities).reduce((sum, value) => sum + (value ?? 0), 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('raises the creature level and stage as XP accumulates', async () => {
    const db = await open();
    let reward = await awardFeeding(db, {
      word: 'one',
      environment: 'article',
      isNewDiscovery: true,
      priorEats: 0,
      now: nowAt(0),
    });

    for (let index = 0; reward.progression.level < 2 && index < 30; index += 1) {
      reward = await awardFeeding(db, {
        word: 'word' + index,
        environment: 'article',
        isNewDiscovery: true,
        priorEats: 0,
        now: nowAt(index + 1),
      });
    }

    expect(reward.progression.level).toBeGreaterThanOrEqual(2);
    expect(stageForLevel(reward.progression.level)).toBe(reward.stage);
  });
});

describe('upgrade purchases', () => {
  it('spends word points and raises the level in one transaction', async () => {
    const db = await open();
    const cost = upgradeCost(findUpgrade('locomotion.speed')!, 1);

    // Seed a balance directly: reward amounts are covered by the feeding tests.
    await db.progression.put({
      id: CREATURE_ID,
      xp: 0,
      level: 1,
      wordPoints: cost * 4,
      lifetimeWordPoints: cost * 4,
      spentWordPoints: 0,
      feedings: 0,
      discoveries: 0,
      environments: {},
      affinities: {},
      interests: {},
      interestsUpdatedAt: 0,
      updatedAt: nowAt(0),
    });

    const first = await purchaseUpgradeWithPoints(db, 'locomotion.speed', nowAt(0));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.upgrade.level).toBe(1);
    expect(first.progression.wordPoints).toBe(cost * 3);
    expect(first.progression.spentWordPoints).toBe(cost);

    const second = await purchaseUpgradeWithPoints(db, 'locomotion.speed', nowAt(1));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.cost).toBeGreaterThan(first.cost);
    expect(second.upgrade.level).toBe(2);
    expect(second.progression.wordPoints).toBe(cost * 3 - second.cost);
    expect(second.progression.spentWordPoints).toBe(cost + second.cost);
  });

  it('rejects purchases the balance cannot cover', async () => {
    const db = await open();
    const outcome = await purchaseUpgradeWithPoints(db, 'senses.vocabulary', nowAt(0));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('insufficient-points');
    expect(outcome.balance).toBe(0);
    expect(outcome.cost).toBeGreaterThan(0);
  });

  it('refuses unknown upgrades and maxed levels', async () => {
    const db = await open();

    const unknown = await purchaseUpgradeWithPoints(db, 'not.a.real.upgrade', nowAt(0));
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.reason).toBe('unknown-upgrade');

    const definition = findUpgrade('digestion.rate')!;
    let balance = 0;
    for (let level = 0; level <= definition.maxLevel; level += 1) {
      balance += upgradeCost(definition, Math.min(definition.maxLevel, level + 1));
    }
    await db.progression.put({
      id: CREATURE_ID,
      xp: 0,
      level: 1,
      wordPoints: balance,
      lifetimeWordPoints: balance,
      spentWordPoints: 0,
      feedings: 0,
      discoveries: 0,
      environments: {},
      affinities: {},
      interests: {},
      interestsUpdatedAt: 0,
      updatedAt: nowAt(0),
    });

    for (let level = 0; level < definition.maxLevel; level += 1) {
      const bought = await purchaseUpgradeWithPoints(db, definition.id, nowAt(level));
      expect(bought.ok).toBe(true);
    }

    const maxed = await purchaseUpgradeWithPoints(db, definition.id, nowAt(99));
    expect(maxed.ok).toBe(false);
    if (maxed.ok) return;
    expect(maxed.reason).toBe('max-level');
  });

  it('reports the same catalog to the shop as the data layer buys', async () => {
    const db = await open();
    const statuses = await upgradeStatuses(db);
    expect(statuses.map((row) => row.id)).toEqual(UPGRADE_CATALOG.map((row) => row.id));
    expect(statuses.every((row) => row.level === 0)).toBe(true);
    expect(statuses.every((row) => row.nextCost > 0)).toBe(true);
  });
});

describe('affinity migration', () => {
  it('seeds a v3 row distribution from its feeding counts', async () => {
    const name = freshDatabaseName('xrawl-affinity-migration');

    const old = await openDatabase({ name, schemaVersion: 3 });
    // A v3 row predates the normalized distribution, so it is written without
    // one - exactly the shape an existing world upgrades from.
    const legacyRow = {
      id: CREATURE_ID,
      xp: 120,
      level: 3,
      wordPoints: 5,
      lifetimeWordPoints: 9,
      spentWordPoints: 4,
      feedings: 10,
      discoveries: 7,
      environments: { code: 6, docs: 3, article: 1 },
      updatedAt: nowAt(0),
    } as unknown as ProgressionRecord;
    await old.db.progression.put(legacyRow);
    old.close();

    const reopened = await openDatabase({ name });
    cleanup.push(() => reopened.destroy());

    const row = await reopened.db.progression.get(CREATURE_ID);
    expect(row?.xp).toBe(120);
    expect(row?.affinities.code).toBeCloseTo(0.6, 6);
    expect(row?.affinities.docs).toBeCloseTo(0.3, 6);
    expect(row?.affinities.article).toBeCloseTo(0.1, 6);
  });
});
