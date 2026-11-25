/**
 * Background-owned database service.
 *
 * This is the only module that holds a live `XrawlDatabase` in the extension.
 * Content scripts never see it: they send observation and feeding payloads over
 * runtime messaging, and the background writes through the repositories. Keeping
 * the store on the extension origin also keeps it out of reach of page code that
 * shares the content script's window.
 *
 * The database is opened lazily, so a popup query or a debug build that never
 * feeds anything does not pay for an IndexedDB open at startup. Boot work is a
 * single promise shared by every caller, which prevents two concurrent opens
 * (and two migrations) on the same database.
 */
import type { XrawlDatabase, XrawlDbOptions } from './db';
import { openXrawlDatabase } from './db';
import { exportDatabase, importDatabase, type ImportResult } from './export';
import type { XrawlExportEnvelope } from './export-format';
import { ingestFeeding, ingestObservation, type IngestResult } from './ingest';
import type { FeedingPayload, ObservationPayload } from './observation';
import { getSpecies, resolveGenetics } from '@/creature/species';
import { resolveLoadout } from '@/creature/loadout';
import { listUpgrades } from './repositories/upgrade-repository';
import { getCreature } from './repositories/creature-repository';
import type { CreatureLoadoutSnapshot as SharedCreatureLoadout } from '@/shared/types/creature';
import { CREATURE_ID, ensureCreature } from './repositories/creature-repository';
import { countFeedingEvents } from './repositories/feeding-repository';
import { countVocabulary } from './repositories/vocabulary-repository';
import {
  requestPersistentStorage,
  storageEstimate,
  type StorageEstimate,
} from './resilience';

export interface DatabaseStatus {
  readonly schemaVersion: number;
  readonly creatureId: string;
  readonly vocabularyCount: number;
  readonly feedingCount: number;
  readonly storage: StorageEstimate | null;
}

/** What the content script needs to build the creature it renders. */
export type CreatureLoadoutSnapshot = SharedCreatureLoadout;

export interface DatabaseServiceOptions extends XrawlDbOptions {
  readonly dbName?: string;
  readonly appVersion: string;
  readonly creatureName?: string;
  /** Species used when the database has no creature yet. */
  readonly speciesId?: string;
  /** Host hook fired once the store opens (e.g. an eviction-aid marker). */
  readonly onOpened?: (now: number) => void;
}

export interface DatabaseService {
  status(): Promise<DatabaseStatus>;
  ingestObservation(payload: ObservationPayload): Promise<IngestResult>;
  ingestFeeding(payload: FeedingPayload): Promise<boolean>;
  creatureLoadout(): Promise<CreatureLoadoutSnapshot | null>;
  exportAll(options?: { excludeEmbeddings?: boolean }): Promise<XrawlExportEnvelope>;
  importAll(envelope: unknown): Promise<ImportResult>;
  close(): Promise<void>;
}

export function createDatabaseService(options: DatabaseServiceOptions): DatabaseService {
  let pending: Promise<XrawlDatabase> | null = null;

  const open = (): Promise<XrawlDatabase> => {
    if (pending) return pending;

    pending = (async () => {
      const dbOptions: XrawlDbOptions = {};
      if (options.indexedDB) dbOptions.indexedDB = options.indexedDB;
      if (options.IDBKeyRange) dbOptions.IDBKeyRange = options.IDBKeyRange;
      const db = openXrawlDatabase(options.dbName, dbOptions);

      const now = Date.now();
      await db.open();
      const species = getSpecies(options.speciesId ?? 'spider');
      await ensureCreature(db, {
        name: options.creatureName ?? 'Xrawl',
        species: species.id,
        genetics: species.defaults,
        now,
      });

      // Best-effort only: persistence is a hint to the browser, not a guarantee.
      void requestPersistentStorage();
      options.onOpened?.(now);

      return db;
    })();

    // A failed open must not poison the service: the next caller retries.
    pending.catch(() => {
      pending = null;
    });

    return pending;
  };

  return {
    async status() {
      const db = await open();
      const [vocabularyCount, feedingCount, storage] = await Promise.all([
        countVocabulary(db),
        countFeedingEvents(db),
        storageEstimate(),
      ]);
      return {
        schemaVersion: db.verno,
        creatureId: CREATURE_ID,
        vocabularyCount,
        feedingCount,
        storage,
      };
    },

    async ingestObservation(payload) {
      return ingestObservation(await open(), payload);
    },

    async ingestFeeding(payload) {
      return ingestFeeding(await open(), payload);
    },

    async creatureLoadout() {
      const db = await open();
      const [record, upgrades] = await Promise.all([getCreature(db), listUpgrades(db)]);
      if (!record) return null;

      const species = getSpecies(record.species);
      const genetics = resolveGenetics(species.defaults, record.genetics);
      const levels: Record<string, number> = {};
      for (const upgrade of upgrades) levels[upgrade.id] = upgrade.level;

      const loadout = resolveLoadout(genetics, levels);
      return {
        creatureId: record.id,
        name: record.name,
        species: species.id,
        stage: record.stage,
        genetics,
        upgradeLevels: levels,
        appearance: loadout.appearance,
        attributes: loadout.attributes,
      };
    },

    async exportAll({ excludeEmbeddings = true } = {}) {
      const db = await open();
      return exportDatabase(db, {
        exclude: excludeEmbeddings ? ['embeddings'] : [],
        appVersion: options.appVersion,
        now: Date.now(),
      });
    },

    async importAll(envelope) {
      return importDatabase(await open(), envelope);
    },

    async close() {
      if (!pending) return;
      const db = await pending.catch(() => null);
      pending = null;
      db?.close();
    },
  };
}
