import { afterEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { createXrawlDatabase, LATEST_SCHEMA_VERSION } from '@/data/db';
import { MIGRATIONS } from '@/data/migrations';
import { XRAWL_TABLE_NAMES } from '@/data/schema';
import { freshDatabaseName, nowAt, openDatabase } from './helpers/db';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe('schema bootstrap', () => {
  it('declares every table the repositories use', async () => {
    const opened = await openDatabase();
    cleanup.push(() => opened.destroy());

    for (const table of XRAWL_TABLE_NAMES) {
      expect(opened.db.table(table)).toBeTruthy();
    }
    expect(opened.db.verno).toBe(LATEST_SCHEMA_VERSION);
  });

  it('records the applied schema version in the meta table on open', async () => {
    const opened = await openDatabase();
    cleanup.push(() => opened.destroy());

    const marker = await opened.db.meta.get('schemaVersion');
    expect(marker?.value).toBe(LATEST_SCHEMA_VERSION);
  });

  it('keeps migration history contiguous and append-only', () => {
    const versions = MIGRATIONS.map((entry) => entry.version);
    expect(versions[0]).toBe(1);
    for (let index = 1; index < versions.length; index += 1) {
      expect(versions[index]).toBe(versions[index - 1]! + 1);
    }
    expect(versions[versions.length - 1]).toBe(LATEST_SCHEMA_VERSION);
  });

  it('opens an empty database without writing game rows', async () => {
    const opened = await openDatabase();
    cleanup.push(() => opened.destroy());

    expect(await opened.db.vocabulary.count()).toBe(0);
    expect(await opened.db.feedingEvents.count()).toBe(0);
    expect(await opened.db.creatures.count()).toBe(0);
  });

  it('persists rows across a close/reopen cycle', async () => {
    const name = freshDatabaseName();
    const first = await openDatabase({ name });
    await first.db.vocabulary.put({
      word: 'fox',
      timesSeen: 3,
      timesEaten: 1,
      firstSeenAt: nowAt(0),
      lastSeenAt: nowAt(100),
      firstEatenAt: nowAt(50),
      lastEatenAt: nowAt(50),
      environments: { article: 3 },
    });
    await first.close();

    const second = await openDatabase({ name });
    cleanup.push(() => second.destroy());
    const row = await second.db.vocabulary.get('fox');
    expect(row?.timesEaten).toBe(1);
    expect(row?.environments.article).toBe(3);
  });
});

describe('downgrade guard', () => {
  it('refuses to open a database written by a newer build', async () => {
    const name = freshDatabaseName();

    // Forge a database at a version this build has never heard of, including
    // the schema marker a newer build would have written on open.
    const future = new Dexie(name);
    future.version(LATEST_SCHEMA_VERSION + 1).stores({ meta: 'key' });
    await future.open();
    await future.table('meta').put({ key: 'schemaVersion', value: LATEST_SCHEMA_VERSION + 1 });
    future.close();

    const old = createXrawlDatabase(name);
    await expect(old.open()).rejects.toThrow(/newer/i);
    old.close();

    // Clean up the forged database with a matching version declaration.
    const remover = new Dexie(name);
    remover.version(LATEST_SCHEMA_VERSION + 1).stores({ meta: 'key' });
    await remover.delete();
  });
});
