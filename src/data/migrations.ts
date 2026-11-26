/**
 * Append-only schema history.
 *
 * Each entry is the complete set of stores *at that version*, plus the upgrader
 * that converts data written by the previous entry. Once a version has shipped
 * its definition is frozen: corrections go in a new entry, never an edit.
 *
 * Keeping the history in one inspectable list (instead of inline
 * `db.version(n)` calls) is what lets tests open a database at a *historical*
 * version, populate it, and then verify the upgrade path — the case that
 * actually breaks users.
 */
import { SPECIES, getSpecies } from '@/creature/species';
import { siteHost } from './observation';
import type { CreatureGeneticsRecord } from './schema';


export interface Migration {
  readonly version: number;
  readonly description: string;
  /** Full Dexie store map at this version (not just the delta). */
  readonly stores: Record<string, string>;
  /**
   * Runs inside Dexie's version transaction, after stores exist and before the
   * open resolves. Backfills only; never rewrite a shipped upgrader.
   */
  readonly upgrade?: (tx: { table: (name: string) => unknown }) => Promise<void>;
}

/**
 * Bookkeeping table: not game data, present from v1 so migrations have a home.
 *
 * The v1 store map is written out in full instead of spread from
 * `XRAWL_TABLE_SCHEMAS`: that constant keeps growing, and a v1 database must
 * keep opening with exactly the tables v1 shipped with. New tables belong to a
 * new version entry.
 */
const V1_STORES: Record<string, string> = {
  creatures: 'id, bornAt, updatedAt, stage',
  vocabulary: 'word, timesSeen, timesEaten, firstSeenAt, lastSeenAt, firstEatenAt, lastEatenAt',
  feedingEvents: 'id, eatenAt, word, creatureId, environment, [creatureId+eatenAt], [word+eatenAt]',
  environments: 'id, kind, exposureMs, lastExposedAt',
  sessions: 'id, startedAt, lastActiveAt, endedAt',
  upgrades: 'id, purchasedAt, updatedAt',
  personality: 'id, kind, updatedAt, [kind+updatedAt]',
  embeddings: 'id, model, subjectType, subjectId, sourceHash, updatedAt, [model+subjectType+subjectId]',
  meta: 'key',
};

/**
 * V2 — creature rows move from a rendered `appearance` blob + free-form
 * `attributes` to *genetics input* + live `state`.
 *
 * Nothing rendered is stored any more: appearance and attributes are derived at
 * load from genetics and purchased upgrade levels. That is what keeps a
 * evolution consistent with the body it draws. The old columns are backfilled
 * into equivalent genetics/state, so no creature loses its identity.
 */
const V2_STORES: Record<string, string> = {
  ...V1_STORES,
  creatures: 'id, bornAt, updatedAt, stage, species',
};

interface LegacyCreatureRow {
  id: string;
  name: string;
  stage: string;
  bornAt: number;
  updatedAt: number;
  appearance?: { seed?: number; traits?: Record<string, number | string> };
  attributes?: Record<string, number>;
  genetics?: CreatureGeneticsRecord;
  species?: string;
  state?: Record<string, number>;
}

/** Turn a legacy row's seed into a plausible genetics record. */
export function geneticsFromLegacy(row: LegacyCreatureRow): CreatureGeneticsRecord {
  const species = row.species ? getSpecies(row.species) : getSpecies(SPECIES[0]!.id);
  const seed = row.appearance?.seed ?? 0;
  const hue = ((seed % 360) + 360) % 360;

  // Preserve any stated gameplay numbers by inverting the known gene ranges,
  // falling back to the species defaults when a value is absent.
  const attributes = row.attributes ?? {};
  const defaults = species.defaults;
  const invert = (value: number | undefined, min: number, span: number, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(1, Math.max(0, (value - min) / span))
      : fallback;

  return {
    ...defaults,
    hue: row.appearance?.traits?.hue !== undefined ? hue : defaults.hue,
    agility: invert(attributes.movementSpeed, 42, 88, defaults.agility),
    metabolism: invert(attributes.eatingSpeed, 1.2, 3.2, defaults.metabolism),
    perception: invert(attributes.detectionRadius, 90, 170, defaults.perception),
    reach: invert(attributes.maximumWordLength, 6, 14, defaults.reach),
    capacity: invert(attributes.stomachCapacity, 3, 9, defaults.capacity),
  };
}

/**
 * V3 - progression: XP, levels, word points, and the history the reward
 * formula scores against (feeding counts per environment).
 *
 * Existing creatures get an empty row rather than a retroactive payout: the
 * feeding log is intact, but awarding past events would make the totals inside
 * this migration depend on the order a user happened to browse in. Rewards
 * start accruing from this version forward.
 */
const V3_STORES: Record<string, string> = {
  ...V2_STORES,
  progression: 'id, updatedAt, level',
};

/**
 * V4 - environment affinity becomes one normalized distribution over every
 * environment kind (a shared 100% pool) instead of an independent "share of
 * lifetime feedings" computed per environment.
 *
 * No index changes; the upgrader seeds each row's distribution from the feeding
 * counts v3 already recorded, so an existing creature keeps the affinity its
 * history implies instead of starting from zero.
 */
const V4_STORES: Record<string, string> = { ...V3_STORES };

/**
 * V5 - learned interest profiles get their own table.
 *
 * A profile is a vector plus its share of the attention pool, which is a
 * different thing from a cached embedding: caches are keyed by content and can
 * be thrown away, profiles are the creature's memory. Splitting them means
 * clearing an embedding cache never forgets what the creature likes.
 *
 * No upgrader: a v4 world has no profiles yet, so the first semantic pass builds
 * them from its established interests and accumulates from there.
 */
const V5_STORES: Record<string, string> = {
  ...V4_STORES,
  interestProfiles: 'id, category, weight, updatedAt',
};

/**
 * V6 - browsing interests and per-site overrides.
 *
 * `progression` gains `interests` and `interestsUpdatedAt`: interests built from
 * focused browsing time, decayed lazily from the timestamp. The new
 * `interestOverrides` table lets the user state what a site is about instead of
 * relying on a host regex.
 *
 * The upgrader only backfills the two new columns; nothing is invented, so an
 * existing creature starts with no browsing interests rather than a guess.
 */
const V6_STORES: Record<string, string> = {
  ...V5_STORES,
  interestOverrides: 'host, updatedAt',
};

/**
 * V7 - the feeding log becomes a readable journal.
 *
 * `feedingEvents` gains `host` (indexed, so "what did it eat on this site" is a
 * lookup instead of a scan) and the reward it actually paid (`points`, `xp`).
 * Rewards are stored with the event because they cannot be recomputed later:
 * the formula reads the state *before* the feeding, and replaying the log in a
 * different order would produce different totals.
 *
 * The upgrader derives `host` from the stored URL and leaves rewards at 0, which
 * the journal renders as "not recorded" rather than inventing a number.
 */
const V7_STORES: Record<string, string> = {
  ...V6_STORES,
  feedingEvents:
    'id, eatenAt, word, creatureId, environment, host, [creatureId+eatenAt], [word+eatenAt], [host+eatenAt]',
};

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'Baseline: creature, vocabulary, feeding, environment, session, upgrade, personality, embedding',
    stores: V1_STORES,
  },
  {
    version: 2,
    description: 'Creature stores genetics + live state; appearance/attributes are derived',
    stores: V2_STORES,
    async upgrade({ table }) {
      const creatures = table('creatures') as import('dexie').Table<Record<string, unknown>, string>;
      await creatures.toCollection().modify((row) => {
        const legacy = row as unknown as LegacyCreatureRow;
        if (legacy.genetics) {
          legacy.species ??= SPECIES[0]!.id;
          legacy.state ??= {};
          return;
        }
        legacy.genetics = geneticsFromLegacy(legacy);
        legacy.species ??= SPECIES[0]!.id;
        legacy.state = { ...(legacy.attributes ?? {}) };
        delete (legacy as { appearance?: unknown }).appearance;
        delete (legacy as { attributes?: unknown }).attributes;
      });
    },
  },
  {
    version: 3,
    description: 'Progression: XP, level, word points, and per-environment feeding history',
    stores: V3_STORES,
    async upgrade({ table }) {
      const creatures = table('creatures') as import('dexie').Table<Record<string, unknown>, string>;
      const progression = table('progression') as import('dexie').Table<
        Record<string, unknown>,
        string
      >;
      const rows = await creatures.toArray();
      for (const row of rows) {
        const id = String(row.id);
        await progression.put({
          id,
          xp: 0,
          level: 1,
          wordPoints: 0,
          lifetimeWordPoints: 0,
          spentWordPoints: 0,
          feedings: 0,
          discoveries: 0,
          environments: {},
          updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
        });
      }
    },
  },
  {
    version: 4,
    description: 'Environment affinity is a normalized distribution, seeded from feeding counts',
    stores: V4_STORES,
    async upgrade({ table }) {
      const progression = table('progression') as import('dexie').Table<
        Record<string, unknown>,
        string
      >;
      const rows = await progression.toArray();
      for (const row of rows) {
        const counts = row.environments;
        const distribution: Record<string, number> = {};
        let total = 0;

        if (counts && typeof counts === 'object') {
          for (const [kind, value] of Object.entries(counts as Record<string, unknown>)) {
            if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
            distribution[kind] = value;
            total += value;
          }
        }

        if (total > 0) {
          for (const kind of Object.keys(distribution)) {
            distribution[kind] = distribution[kind]! / total;
          }
        }

        await progression.put({ ...row, affinities: distribution });
      }
    },
  },
  {
    version: 5,
    description: 'Learned interest profiles (vector + attention share) in their own table',
    stores: V5_STORES,
  },
  {
    version: 6,
    description: 'Browsing interests (decayed) and per-site interest overrides',
    stores: V6_STORES,
    async upgrade({ table }) {
      const progression = table('progression') as import('dexie').Table<
        Record<string, unknown>,
        string
      >;
      await progression.toCollection().modify((row) => {
        row.interests ??= {};
        row.interestsUpdatedAt ??= 0;
      });
    },
  },
  {
    version: 7,
    description: 'Feeding log is a journal: host index plus the reward each feeding paid',
    stores: V7_STORES,
    async upgrade({ table }) {
      const feedingEvents = table('feedingEvents') as import('dexie').Table<
        Record<string, unknown>,
        string
      >;
      await feedingEvents.toCollection().modify((row) => {
        const url = typeof row.pageUrl === 'string' ? row.pageUrl : '';
        row.host ??= siteHost(url);
        row.points ??= 0;
        row.xp ??= 0;
        row.source ??= 'autonomous';
      });
    },
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
