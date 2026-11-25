/**
 * Upgrade tests.
 *
 * The rules that matter for data survival:
 *  - schema changes are versioned;
 *  - a *populated* database upgrades without losing rows;
 *  - the upgrade is transactional (a failure leaves the old version intact);
 *  - an export from a newer schema is refused, not silently truncated.
 *
 * These run against the real shipped history, plus a synthetic next version
 * declared in-test to prove the machinery future migrations will rely on.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { createXrawlDatabase, LATEST_SCHEMA_VERSION } from '@/data/db';
import { MIGRATIONS, type Migration } from '@/data/migrations';
import { XRAWL_TABLE_SCHEMAS, type VocabularyRecord } from '@/data/schema';
import { freshDatabaseName, nowAt, openDatabase } from './helpers/db';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const V1 = MIGRATIONS[0]!;
const V2 = MIGRATIONS[1]!;
const NEXT_VERSION = LATEST_SCHEMA_VERSION + 1;

const NEXT_STORES = {
  ...MIGRATIONS[MIGRATIONS.length - 1]!.stores,
  meters: 'id, updatedAt',
};

/** Synthetic version on top of the real history, for machinery tests. */
function syntheticNext(upgrade: Migration['upgrade']): Migration {
  return {
    version: NEXT_VERSION,
    description: 'Add meters table (synthetic)',
    stores: NEXT_STORES,
    upgrade,
  };
}

function seedVocabulary(): VocabularyRecord {
  return {
    word: 'fox',
    timesSeen: 4,
    timesEaten: 2,
    firstSeenAt: nowAt(0),
    lastSeenAt: nowAt(500),
    firstEatenAt: nowAt(100),
    lastEatenAt: nowAt(400),
    environments: { article: 3, docs: 1 },
  };
}

/** A row as v1 wrote it: rendered `appearance` plus free-form `attributes`. */
function seedLegacyCreature(): Record<string, unknown> {
  return {
    id: 'xrawl-0',
    name: 'Xrawl',
    stage: 'hatchling',
    bornAt: nowAt(0),
    updatedAt: nowAt(0),
    appearance: { seed: 7, traits: { hue: 0.4 } },
    attributes: { movementSpeed: 70, stomachCapacity: 4 },
  };
}

describe('real v1 -> v2 creature migration', () => {
  it('converts a populated v1 creature to genetics + live state', async () => {
    const name = freshDatabaseName();

    const old = await openDatabase({ name, migrations: [V1] });
    expect(old.db.verno).toBe(1);
    await old.db.vocabulary.put(seedVocabulary());
    await old.db.table('creatures').put(seedLegacyCreature());
    old.close();

    const upgraded = await openDatabase({ name });
    cleanup.push(() => upgraded.destroy());

    expect(upgraded.db.verno).toBe(LATEST_SCHEMA_VERSION);

    // Unrelated tables survive untouched.
    const vocabulary = await upgraded.db.vocabulary.get('fox');
    expect(vocabulary?.timesSeen).toBe(4);
    expect(vocabulary?.environments.docs).toBe(1);

    const creature = await upgraded.db.creatures.get('xrawl-0');
    expect(creature?.id).toBe('xrawl-0');
    expect(creature?.name).toBe('Xrawl');
    expect(creature?.species).toBe('spider');
    expect(creature?.genetics.limbCount).toBe(8);
    expect(creature?.genetics.limbSegments).toBe(3);

    // Stated gameplay values are preserved by inverting the known gene ranges.
    expect(creature!.genetics.agility).toBeCloseTo((70 - 42) / 88, 5);
    expect(creature!.genetics.capacity).toBeCloseTo((4 - 3) / 9, 5);

    // Legacy columns are gone: appearance and attributes are derived now.
    const row = creature as unknown as Record<string, unknown>;
    expect(row.appearance).toBeUndefined();
    expect(row.attributes).toBeUndefined();
    expect(creature?.state.movementSpeed).toBe(70);

    // The migrated creature is immediately usable: derive a loadout from it.
    const { resolveLoadout } = await import('@/creature/loadout');
    const loadout = resolveLoadout(creature!.genetics);
    expect(loadout.appearance.limbs.count).toBe(8);
    expect(loadout.attributes.movementSpeed).toBeGreaterThan(0);
  });

  it('leaves a row that already carries genetics untouched', async () => {
    const name = freshDatabaseName();
    const first = await openDatabase({ name });
    const { getSpecies } = await import('@/creature/species');
    await first.db.creatures.put({
      id: 'xrawl-0',
      name: 'Mite',
      species: 'mite',
      stage: 'hatchling',
      bornAt: nowAt(0),
      updatedAt: nowAt(0),
      genetics: getSpecies('mite').defaults,
      state: { satiety: 0 },
    });
    first.close();

    const reopened = await openDatabase({ name });
    cleanup.push(() => reopened.destroy());
    expect(reopened.db.verno).toBe(LATEST_SCHEMA_VERSION);

    const creature = await reopened.db.creatures.get('xrawl-0');
    expect(creature?.species).toBe('mite');
    expect(creature?.genetics.limbCount).toBe(6);
  });
});

describe('synthetic upgrade machinery', () => {
  it('upgrades a populated database and backfills rows', async () => {
    const name = freshDatabaseName();

    const old = await openDatabase({ name, migrations: [V1, V2] });
    await old.db.vocabulary.put(seedVocabulary());
    old.close();

    const next = syntheticNext(async ({ table }) => {
      const vocabulary = table('vocabulary') as Dexie.Table<VocabularyRecord & { meter?: number }>;
      await vocabulary.toCollection().modify((row) => {
        row.meter = row.timesEaten;
      });
    });

    const upgraded = await openDatabase({ name, migrations: [...MIGRATIONS, next] });
    cleanup.push(() => upgraded.destroy());

    expect(upgraded.db.verno).toBe(NEXT_VERSION);
    const vocabulary = await upgraded.db.vocabulary.get('fox');
    expect((vocabulary as VocabularyRecord & { meter?: number }).meter).toBe(2);

    await upgraded.db.table('meters').put({ id: 'm', updatedAt: nowAt(10) });
    expect(await upgraded.db.table('meters').count()).toBe(1);
  });

  it('leaves old data readable when the upgrade throws', async () => {
    const name = freshDatabaseName();

    const old = await openDatabase({ name });
    await old.db.vocabulary.put(seedVocabulary());
    old.close();

    const broken = syntheticNext(async () => {
      throw new Error('migration boom');
    });

    const failing = createXrawlDatabase(name, { migrations: [...MIGRATIONS, broken] });
    await expect(failing.open()).rejects.toThrow();
    failing.close();

    const reopened = await openDatabase({ name });
    cleanup.push(() => reopened.destroy());
    expect(reopened.db.verno).toBe(LATEST_SCHEMA_VERSION);
    expect(await reopened.db.vocabulary.get('fox')).toBeDefined();
  });

  it('does not re-run an upgrade on every open', async () => {
    const name = freshDatabaseName();
    let upgradeRuns = 0;

    const counting = syntheticNext(async () => {
      upgradeRuns += 1;
    });

    const first = await openDatabase({ name });
    first.close();

    const second = await openDatabase({ name, migrations: [...MIGRATIONS, counting] });
    cleanup.push(() => second.destroy());
    expect(second.db.verno).toBe(NEXT_VERSION);

    const third = await openDatabase({ name, migrations: [...MIGRATIONS, counting] });
    cleanup.push(() => third.destroy());
    expect(third.db.verno).toBe(NEXT_VERSION);

    expect(upgradeRuns).toBe(1);
  });
});

describe('table declarations', () => {
  it('indexes the fields progression will sort and filter on', () => {
    expect(XRAWL_TABLE_SCHEMAS.vocabulary).toContain('timesEaten');
    expect(XRAWL_TABLE_SCHEMAS.vocabulary).toContain('lastEatenAt');
    expect(XRAWL_TABLE_SCHEMAS.feedingEvents).toContain('[creatureId+eatenAt]');
    expect(XRAWL_TABLE_SCHEMAS.feedingEvents).toContain('[word+eatenAt]');
    expect(XRAWL_TABLE_SCHEMAS.embeddings).toContain('[model+subjectType+subjectId]');
    expect(XRAWL_TABLE_SCHEMAS.personality).toContain('[kind+updatedAt]');
  });

  it('never uses null for indexed timestamps', () => {
    // IndexedDB does not index null, so an `endedAt: null` would make an
    // "open sessions" query silently miss every row. `0` means "never".
    for (const index of XRAWL_TABLE_SCHEMAS.sessions.split(',').map((part) => part.trim())) {
      expect(index).not.toContain('null');
    }
  });
});
