/**
 * Export / import tests.
 *
 * The requirements these enforce:
 *  - a user can take their world out and bring it back;
 *  - import validates *before* opening a transaction (a bad file cannot wipe
 *    live tables halfway through);
 *  - an export from a newer schema is refused rather than silently truncated;
 *  - a round trip is lossless, including the open-namespace fields.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { exportDatabase, importDatabase, validateImport } from '@/data/export';
import {
  XRAWL_EXPORT_FORMAT,
  XRAWL_EXPORT_FORMAT_VERSION,
  type XrawlExportEnvelope,
} from '@/data/export-format';
import { LATEST_SCHEMA_VERSION } from '@/data/db';
import type { XrawlDatabase } from '@/data/db';
import { ensureCreature } from '@/data/repositories/creature-repository';
import { getSpecies } from '@/creature/species';
import { appendFeedingEvent } from '@/data/repositories/feeding-repository';
import { applyPersonalityDelta } from '@/data/repositories/personality-repository';
import { recordWordSightings } from '@/data/repositories/vocabulary-repository';
import { freshDatabaseName, nowAt, openDatabase } from './helpers/db';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function open(): Promise<XrawlDatabase> {
  const opened = await openDatabase();
  cleanup.push(() => opened.destroy());
  return opened.db;
}

const spider = getSpecies('spider');

async function seed(db: XrawlDatabase): Promise<void> {
  await ensureCreature(db, {
    name: 'Xrawl',
    species: spider.id,
    genetics: spider.defaults,
    state: { satiety: 0.4 },
    now: nowAt(0),
  });
  await recordWordSightings(
    db,
    [
      { word: 'fox', count: 3 },
      { word: 'dog', count: 1 },
    ],
    'article',
    nowAt(10),
  );
  await appendFeedingEvent(db, {
    creatureId: 'xrawl-0',
    word: 'fox',
    eatenAt: nowAt(100),
    environment: 'article',
    pageUrl: 'https://example.com/a',
    pageTitle: 'A',
    contextSentence: 'quick brown fox',
    contextHash: 'h',
    fingerprint: 'fp',
    nutrition: 1,
    preferenceDelta: 0.2,
  });
  await applyPersonalityDelta(db, { kind: 'interest', key: 'birds', evidence: 0.6, now: nowAt(200) });
}

function exportOptions() {
  return { exclude: ['embeddings'] as const, appVersion: '0.1.0', now: nowAt(500) };
}

describe('exportDatabase', () => {
  it('produces a versioned envelope with counts and rows', async () => {
    const db = await open();
    await seed(db);
    const envelope = await exportDatabase(db, { ...exportOptions() });

    expect(envelope.format).toBe(XRAWL_EXPORT_FORMAT);
    expect(envelope.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(envelope.counts.vocabulary).toBe(2);
    expect(envelope.counts.feedingEvents).toBe(1);
    expect(envelope.counts.creatures).toBe(1);
    expect(envelope.tables.embeddings).toBeUndefined();
  });
});

describe('validateImport', () => {
  it('rejects non-xrawl files', () => {
    expect(() => validateImport({})).toThrow(/not a xrawl export/i);
    expect(() => validateImport({ format: 'something-else' })).toThrow(/not a xrawl export/i);
  });

  it('rejects exports from a newer schema', async () => {
    const db = await open();
    const envelope = await exportDatabase(db, exportOptions());
    const future: XrawlExportEnvelope = { ...envelope, schemaVersion: LATEST_SCHEMA_VERSION + 1 };
    expect(() => validateImport(future)).toThrow(/newer/);
  });

  it('rejects a newer export format version', async () => {
    const db = await open();
    const envelope = await exportDatabase(db, exportOptions());
    const future = { ...envelope, formatVersion: XRAWL_EXPORT_FORMAT_VERSION + 1 };
    expect(() => validateImport(future)).toThrow(/newer/);
  });
});

describe('import round trip', () => {
  it('replaces tables losslessly', async () => {
    const source = await open();
    await seed(source);
    const envelope = await exportDatabase(source, exportOptions());

    const target = await open();
    // Pre-existing junk that must be cleared, not merged.
    await recordWordSightings(target, [{ word: 'junk', count: 1 }], 'article', nowAt(0));

    const result = await importDatabase(target, JSON.parse(JSON.stringify(envelope)));

    expect(result.imported.vocabulary).toBe(2);
    expect(result.imported.feedingEvents).toBe(1);
    expect(await target.vocabulary.get('junk')).toBeUndefined();

    const fox = await target.vocabulary.get('fox');
    expect(fox?.timesSeen).toBe(3);
    expect(fox?.environments.article).toBe(3);

    const creature = await target.creatures.get('xrawl-0');
    expect(creature?.state.satiety).toBe(0.4);
    expect(creature?.genetics.limbCount).toBe(spider.defaults.limbCount);
    expect(creature?.species).toBe('spider');

    const personality = await target.personality.get('interest:birds');
    expect(personality?.value).toBeGreaterThan(0);

    // The imported data still works: a new event lands beside the old ones.
    await appendFeedingEvent(target, {
      creatureId: 'xrawl-0',
      word: 'dog',
      eatenAt: nowAt(300),
      environment: 'article',
      pageUrl: 'u',
      pageTitle: 't',
      contextSentence: 'c',
      contextHash: 'h2',
      fingerprint: 'fp2',
      nutrition: 1,
      preferenceDelta: 0,
    });
    expect(await target.feedingEvents.count()).toBe(2);
  });

  it('leaves live data untouched when the file is invalid', async () => {
    const target = await open();
    await seed(target);

    await expect(importDatabase(target, { format: 'nope' })).rejects.toThrow(/not a xrawl export/i);

    expect((await target.vocabulary.get('fox'))?.timesSeen).toBe(3);
    expect(await target.feedingEvents.count()).toBe(1);
  });

  it('leaves live data untouched when a later table fails', async () => {
    const target = await open();
    const envelope = await exportDatabase(target, exportOptions());

    // A row containing a function cannot be structured-cloned into IndexedDB,
    // so the bulkPut aborts *inside* the transaction — after earlier tables in
    // the same transaction were already cleared.
    const poisoned = {
      ...envelope,
      tables: {
        ...envelope.tables,
        vocabulary: [
          {
            word: 'fox',
            timesSeen: 1,
            timesEaten: 0,
            firstSeenAt: nowAt(0),
            lastSeenAt: nowAt(0),
            firstEatenAt: 0,
            lastEatenAt: 0,
            environments: {},
            bogus: () => undefined,
          },
        ],
      },
    };

    await expect(
      importDatabase(target, poisoned as unknown as XrawlExportEnvelope),
    ).rejects.toThrow();
    expect(await target.vocabulary.count()).toBe(0);
  });

  it('refuses to write an export from a newer schema into an older database', async () => {
    const target = await open();
    const envelope = await exportDatabase(target, exportOptions());
    const future = { ...envelope, schemaVersion: LATEST_SCHEMA_VERSION + 5 };

    await expect(importDatabase(target, future)).rejects.toThrow(/newer/);
  });

  it('round-trips through JSON text, which is what a file download contains', async () => {
    const source = await open();
    await seed(source);
    const text = JSON.stringify(await exportDatabase(source, exportOptions()), null, 2);

    const target = await open();
    const result = await importDatabase(target, JSON.parse(text));
    expect(result.imported.vocabulary).toBe(2);
    expect((await target.creatures.get('xrawl-0'))?.name).toBe('Xrawl');
  });
});

describe('cross-database identity', () => {
  it('keeps the exported schema version, not the importing database version', async () => {
    const source = await openDatabase({ name: freshDatabaseName() });
    await source.db.open();
    const envelope = await exportDatabase(source.db, exportOptions());
    expect(envelope.schemaVersion).toBe(source.db.verno);
    source.close();
    await source.destroy();
  });
});
