/**
 * The single Dexie database instance and its version history.
 *
 * Rules for this file:
 *  - Versions come from `migrations.ts`, which is append-only. Once a version
 *    ships its stores and upgrader are frozen; corrections go in a *new* version.
 *  - A `schemaVersion` marker is written into `meta` after every successful open.
 *    It records which version actually applied, so an interrupted upgrade is
 *    visible instead of silently assumed.
 *  - Nothing here touches browser globals: the IndexedDB factory and the
 *    migration list can both be injected, which keeps the database testable
 *    under `fake-indexeddb` and portable to a desktop host.
 */
import Dexie, { type EntityTable } from 'dexie';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, type Migration } from './migrations';
import {
  XRAWL_DB_NAME,
  type CreatureRecord,
  type EmbeddingRecord,
  type EnvironmentRecord,
  type FeedingEventRecord,
  type PersonalityRecord,
  type SessionRecord,
  type UpgradeRecord,
  type VocabularyRecord,
} from './schema';

export interface MetaRecord {
  key: string;
  value: string | number | boolean;
}

export interface XrawlDbOptions {
  /** IndexedDB implementation; defaults to the global one. */
  indexedDB?: IDBFactory;
  IDBKeyRange?: typeof IDBKeyRange;
  /** Defaults to the shipped history. Tests may supply a synthetic list. */
  migrations?: readonly Migration[];
  /**
   * Build only versions up to this number. Opening a *historical* database is
   * how an upgrade test creates populated old data, then reopens at latest.
   */
  schemaVersion?: number;
}

export interface XrawlDatabase extends Dexie {
  creatures: EntityTable<CreatureRecord, 'id'>;
  vocabulary: EntityTable<VocabularyRecord, 'word'>;
  feedingEvents: EntityTable<FeedingEventRecord, 'id'>;
  environments: EntityTable<EnvironmentRecord, 'id'>;
  sessions: EntityTable<SessionRecord, 'id'>;
  upgrades: EntityTable<UpgradeRecord, 'id'>;
  personality: EntityTable<PersonalityRecord, 'id'>;
  embeddings: EntityTable<EmbeddingRecord, 'id'>;
  meta: EntityTable<MetaRecord, 'key'>;
}

export function createXrawlDatabase(
  name: string = XRAWL_DB_NAME,
  options: XrawlDbOptions = {},
): XrawlDatabase {
  const { migrations = MIGRATIONS, schemaVersion } = options;

  // Dexie merges this object over its `Dexie.dependencies` defaults, and an
  // explicitly present `undefined` *replaces* the default instead of falling
  // back to it. Passing `{ indexedDB: undefined }` therefore makes Dexie report
  // "IndexedDB API missing", so forward only keys that were actually supplied.
  const dexieOptions: XrawlDbOptions = {};
  if (options.indexedDB) dexieOptions.indexedDB = options.indexedDB;
  if (options.IDBKeyRange) dexieOptions.IDBKeyRange = options.IDBKeyRange;

  const db = new Dexie(name, dexieOptions) as XrawlDatabase;
  const supportedVersion = migrations[migrations.length - 1]?.version ?? 0;

  for (const migration of migrations) {
    if (schemaVersion !== undefined && migration.version > schemaVersion) continue;
    const version = db.version(migration.version).stores(migration.stores);
    const upgrade = migration.upgrade;
    if (upgrade) version.upgrade((tx) => upgrade({ table: (tableName) => tx.table(tableName) }));
  }

  db.on('ready', async () => {
    const meta = (db as XrawlDatabase).meta;
    const marker = await meta.get('schemaVersion');
    if (typeof marker?.value === 'number' && marker.value > supportedVersion) {
      // A newer build already wrote this store. Proceeding would let this
      // build write rows with missing columns, so refuse instead of corrupting
      // a store the user cannot downgrade out of.
      db.close();
      throw new Error(
        `Database schema v${marker.value} is newer than this build supports (v${supportedVersion}).`,
      );
    }
    await meta.put({ key: 'schemaVersion', value: db.verno });
  });

  return db;
}

/** IndexedDB in the extension's own (background) context. */
export function openXrawlDatabase(
  name: string = XRAWL_DB_NAME,
  options: XrawlDbOptions = {},
): XrawlDatabase {
  return createXrawlDatabase(name, options);
}

export { LATEST_SCHEMA_VERSION };

/**
 * Forward-only schema check used by import: an export from a newer build must
 * never be written into an older database, where extra columns would be
 * silently dropped.
 */
export function assertImportableSchema(exportedVersion: number): void {
  if (exportedVersion > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `Export was written by schema v${exportedVersion}, which is newer than this build (v${LATEST_SCHEMA_VERSION}).`,
    );
  }
}
