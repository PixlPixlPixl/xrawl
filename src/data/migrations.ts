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
import type { CreatureGeneticsRecord } from './schema';
import { XRAWL_TABLE_SCHEMAS } from './schema';

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

/** Bookkeeping table: not game data, present from v1 so migrations have a home. */
const V1_STORES: Record<string, string> = {
  ...XRAWL_TABLE_SCHEMAS,
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
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
