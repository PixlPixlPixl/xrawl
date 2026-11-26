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
import { ingestFeeding, ingestObservation, type IngestFeedingOptions, type IngestResult } from './ingest';
import { journalFeedings, journalOverview, journalVocabulary, journalWordDetail } from './journal';
import type { JournalPayload, JournalQuery } from '@/shared/types/journal';
import type { FeedingPayload, ObservationPayload } from './observation';
import { getSpecies, resolveGenetics } from '@/creature/species';
import { resolveLoadout } from '@/creature/loadout';
import { listUpgrades } from './repositories/upgrade-repository';
import { upgradeStatuses, purchaseUpgradeWithPoints, type PurchaseOutcome, type UpgradeStatus } from './progression';
import { getProgression } from './repositories/progression-repository';
import { levelProgress } from '@/progression/level';
import { describeAffinities } from '@/progression/affinity';
import { getCreature } from './repositories/creature-repository';
import type { CreatureLoadoutSnapshot as SharedCreatureLoadout } from '@/shared/types/creature';
import { CREATURE_ID, ensureCreature } from './repositories/creature-repository';
import { countFeedingEvents } from './repositories/feeding-repository';
import { countVocabulary } from './repositories/vocabulary-repository';
import { summarizeInterestProfiles } from './repositories/interest-profile-repository';
import {
  evolveFromFeeding,
  prioritizeWords,
  type CognitionSnapshot,
  type PriorityRequest,
  type WordPriority,
} from './cognition';
import {
  describeSite,
  readInterests,
  recordBrowsingExposure,
  setSiteOverride,
  type BrowsingExposureInput,
  type BrowsingExposureResult,
} from './interests';
import type { InterestKind } from '@/progression/interests';
import type { EnvironmentKind } from '@/shared/types/page';
import { countEmbeddings } from './embeddings';
import {
  createSemanticService,
  type SemanticService,
  type SemanticState,
} from '@/semantics/service';
import {
  requestPersistentStorage,
  storageEstimate,
  type StorageEstimate,
} from './resilience';

export interface ProgressionStatus {
  readonly level: number;
  readonly xp: number;
  /** XP still needed for the next level; 0 at the cap. */
  readonly xpForNextLevel: number;
  readonly wordPoints: number;
  readonly lifetimeWordPoints: number;
  readonly discoveries: number;
  readonly feedings: number;
  /** Normalized affinity distribution; sums to 1 (rounded for display). */
  readonly affinities: Readonly<Partial<Record<string, number>>>;
  /**
   * Browsing interests, decayed to "now" and rounded. This is the deterministic
   * environment channel; it exists even when the model has never loaded.
   */
  readonly interests: ReadonlyArray<{ readonly interest: string; readonly weight: number }>;
}

/** Last inference batch: what the model cost, on this device, right now. */
export interface SemanticBatchStatus {
  readonly count: number;
  readonly ms: number;
  readonly device: 'wasm' | 'webgpu';
}

/** What the popup can say about the model and the learned interests. */
export interface SemanticStatus {
  /** `idle`/`loading`/`ready`/`fallback`; loading is lazy and on first use. */
  readonly state: SemanticState;
  readonly model: string;
  /** Rounded attention shares, biggest first. Empty until something is eaten. */
  readonly profiles: ReadonlyArray<{ readonly category: string; readonly share: number }>;
  readonly embeddingCount: number;
  /** Size/time/backend of the last batch, or null before the model has run. */
  readonly lastBatch: SemanticBatchStatus | null;
}

export interface DatabaseStatus {
  readonly schemaVersion: number;
  readonly creatureId: string;
  /**
   * When this database was first opened, from its own `meta` table.
   *
   * Compared with the `storage.local` creation marker, this is what lets the
   * UI say "history was reset" instead of quietly starting a new lineage: the
   * marker outlives an evicted database, the `meta` row does not.
   */
  readonly createdAt: number;
  readonly vocabularyCount: number;
  readonly feedingCount: number;
  readonly storage: StorageEstimate | null;
  readonly progression: ProgressionStatus;
  /** Catalog with owned levels and current prices, for a shop UI. */
  readonly upgrades: readonly UpgradeStatus[];
  readonly semantics: SemanticStatus;
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
  /** Embedding backend; injected by tests, lazily loads MiniLM in production. */
  readonly semantics?: SemanticService;
  /**
   * The user's "store page context" preference. Injected because the data layer
   * must not touch browser storage; the background passes a reader that resolves
   * it from `storage.local`.
   */
  readonly readContextStorage?: () => Promise<boolean>;
}

export interface DatabaseService {
  status(): Promise<DatabaseStatus>;
  ingestObservation(payload: ObservationPayload): Promise<IngestResult>;
  ingestFeeding(payload: FeedingPayload, options?: IngestFeedingOptions): Promise<boolean>;
  /** Read-only projection of the history tables for the journal page. */
  journal(query: JournalQuery): Promise<JournalPayload>;
  creatureLoadout(): Promise<CreatureLoadoutSnapshot | null>;
  purchaseUpgrade(upgradeId: string): Promise<PurchaseOutcome>;
  /** Learn from a feeding; safe to call after the transaction has committed. */
  learnFromFeeding(payload: FeedingPayload): Promise<CognitionSnapshot>;
  /**
   * Learn from focused browsing time. Deterministic: no model, no vectors, just
   * host/kind/time into the interest weights.
   */
  learnFromBrowsing(input: BrowsingExposureInput): Promise<BrowsingExposureResult>;
  /** What this site would teach, and whether the user has overridden it. */
  siteInterest(
    host: string,
    environment: EnvironmentKind,
  ): Promise<{ host: string; override: InterestKind | null; interests: readonly { interest: InterestKind; weight: number }[] }>;
  /** Set (or clear, with null) one host's interest override. */
  setSiteInterest(host: string, interest: InterestKind | null): Promise<InterestKind | null>;
  /** Rank candidate words for the content script's creature, with the model used. */
  prioritize(requests: readonly PriorityRequest[]): Promise<{
    readonly model: string;
    readonly priorities: readonly WordPriority[];
  }>;
  exportAll(options?: { excludeEmbeddings?: boolean }): Promise<XrawlExportEnvelope>;
  importAll(envelope: unknown): Promise<ImportResult>;
  close(): Promise<void>;
}

export function createDatabaseService(options: DatabaseServiceOptions): DatabaseService {
  let pending: Promise<XrawlDatabase> | null = null;

  // Created eagerly (cheap) but the model behind it is loaded lazily, on the
  // first embedding request - never at extension startup.
  const semantics: SemanticService =
    options.semantics ??
    createSemanticService({
      logger: (message, error) => {
        console.warn('[xrawl] ' + message, error ?? '');
      },
    });

  const open = (): Promise<XrawlDatabase> => {
    if (pending) return pending;

    pending = (async () => {
      const dbOptions: XrawlDbOptions = {};
      if (options.indexedDB) dbOptions.indexedDB = options.indexedDB;
      if (options.IDBKeyRange) dbOptions.IDBKeyRange = options.IDBKeyRange;
      const db = openXrawlDatabase(options.dbName, dbOptions);

      const now = Date.now();
      await db.open();
      // First open of this store: remember when, so a wiped-and-recreated
      // database can be told apart from a brand new install later.
      if ((await db.meta.get('createdAt')) === undefined) {
        await db.meta.put({ key: 'createdAt', value: now });
      }
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
      const [
        vocabularyCount,
        feedingCount,
        storage,
        progression,
        upgrades,
        profiles,
        embeddingCount,
        browsing,
      ] = await Promise.all([
        countVocabulary(db),
        countFeedingEvents(db),
        storageEstimate(),
        getProgression(db, CREATURE_ID),
        upgradeStatuses(db),
        summarizeInterestProfiles(db),
        countEmbeddings(db),
        readInterests(db, Date.now()),
      ]);

      const xp = progression?.xp ?? 0;
      const progress = levelProgress(xp);

      const createdAtRow = await db.meta.get('createdAt');
      const createdAt = typeof createdAtRow?.value === 'number' ? createdAtRow.value : 0;

      return {
        schemaVersion: db.verno,
        creatureId: CREATURE_ID,
        createdAt,
        vocabularyCount,
        feedingCount,
        storage,
        progression: {
          level: progress.level,
          xp,
          xpForNextLevel: progress.xpForNextLevel,
          wordPoints: progression?.wordPoints ?? 0,
          lifetimeWordPoints: progression?.lifetimeWordPoints ?? 0,
          discoveries: progression?.discoveries ?? 0,
          feedings: progression?.feedings ?? 0,
          affinities: describeAffinities(progression?.affinities ?? {}),
          interests: browsing.described,
        },
        upgrades,
        semantics: {
          state: semantics.state(),
          model: semantics.model(),
          profiles,
          embeddingCount,
          lastBatch: semantics.stats(),
        },
      };
    },

    async ingestObservation(payload) {
      return ingestObservation(await open(), payload);
    },

    async ingestFeeding(payload, ingestOptions) {
      return ingestFeeding(await open(), payload, ingestOptions);
    },

    async journal(query) {
      const db = await open();
      const contextStorage = options.readContextStorage;
      switch (query.view) {
        case 'settings':
          return { contextStorage: contextStorage ? await contextStorage() : false };
        case 'overview':
          return journalOverview(db, {
            contextStorage: contextStorage ? await contextStorage() : false,
          });
        case 'feedings':
          return journalFeedings(db, query);
        case 'vocabulary':
          return journalVocabulary(db, query);
        case 'word':
          return journalWordDetail(db, query.word);
        default: {
          // Exhaustiveness guard: a new view added to the union without a reader
          // fails here instead of resolving undefined into the page.
          const unreachable: never = query;
          throw new Error(`unknown journal view: ${JSON.stringify(unreachable)}`);
        }
      }
    },

    async learnFromFeeding(payload) {
      const db = await open();
      const provider = await semantics.prepare();
      return evolveFromFeeding(db, provider, {
        word: payload.word,
        sentence: payload.contextSentence,
        environment: payload.environment,
        source: payload.source === 'manual' ? 'manual' : 'autonomous',
        now: payload.eatenAt,
      });
    },

    async learnFromBrowsing(input) {
      return recordBrowsingExposure(await open(), input);
    },

    async siteInterest(host, environment) {
      return describeSite(await open(), host, environment);
    },

    async setSiteInterest(host, interest) {
      const db = await open();
      const record = await setSiteOverride(db, host, interest, Date.now());
      return record?.interest ?? null;
    },

    async prioritize(requests) {
      const db = await open();
      const provider = await semantics.prepare();
      const priorities = await prioritizeWords(db, provider, requests, { now: Date.now() });
      return { model: provider.model, priorities };
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

    async purchaseUpgrade(upgradeId) {
      return purchaseUpgradeWithPoints(await open(), upgradeId, Date.now());
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
