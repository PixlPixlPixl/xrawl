import type { XrawlDatabase } from '../db';
import type { CreatureGeneticsRecord, CreatureRecord } from '../schema';

/**
 * The creature is a singleton in practice, but it is stored by id so a later
 * build can keep a lineage (or multiple creatures) without a migration.
 */
export const CREATURE_ID = 'xrawl-0';

export interface CreateCreatureInput {
  readonly id?: string;
  readonly name: string;
  readonly species: string;
  readonly genetics: CreatureGeneticsRecord;
  readonly stage?: string;
  readonly state?: Record<string, number>;
  readonly now: number;
}

export function defaultCreatureRecord(input: CreateCreatureInput): CreatureRecord {
  return {
    id: input.id ?? CREATURE_ID,
    name: input.name,
    species: input.species,
    stage: input.stage ?? 'hatchling',
    bornAt: input.now,
    updatedAt: input.now,
    genetics: input.genetics,
    state: input.state ?? { satiety: 0, stomach: 0, feedings: 0 },
  };
}

export async function getCreature(
  db: XrawlDatabase,
  id: string = CREATURE_ID,
): Promise<CreatureRecord | undefined> {
  return db.creatures.get(id);
}

export async function putCreature(db: XrawlDatabase, creature: CreatureRecord): Promise<void> {
  await db.creatures.put(creature);
}

/** Reads the creature, creating it with the supplied defaults if the db is new. */
export async function ensureCreature(
  db: XrawlDatabase,
  input: CreateCreatureInput,
): Promise<CreatureRecord> {
  const id = input.id ?? CREATURE_ID;
  return db.transaction('rw', db.creatures, async () => {
    const existing = await db.creatures.get(id);
    if (existing) return existing;
    const created = defaultCreatureRecord({ ...input, id });
    await db.creatures.add(created);
    return created;
  });
}

/**
 * Patch semantics for the two open namespaces: `state` and `genetics` are merged
 * key-by-key, so a caller that knows about satiety cannot erase a gene it never
 * touched. Appearance and attributes are *not* stored here — they are derived
 * from genetics plus purchased levels.
 */
export async function updateCreature(
  db: XrawlDatabase,
  changes: {
    readonly id?: string;
    readonly name?: string;
    readonly species?: string;
    readonly stage?: string;
    readonly state?: Record<string, number>;
    readonly genetics?: Partial<CreatureGeneticsRecord>;
    readonly now: number;
  },
): Promise<CreatureRecord | undefined> {
  const id = changes.id ?? CREATURE_ID;
  return db.transaction('rw', db.creatures, async () => {
    const existing = await db.creatures.get(id);
    if (!existing) return undefined;

    const updated: CreatureRecord = {
      ...existing,
      name: changes.name ?? existing.name,
      species: changes.species ?? existing.species,
      stage: changes.stage ?? existing.stage,
      updatedAt: changes.now,
      state: { ...existing.state, ...(changes.state ?? {}) },
      genetics: { ...existing.genetics, ...(changes.genetics ?? {}) },
    };
    await db.creatures.put(updated);
    return updated;
  });
}

/** Atomic read-modify-write for a single live state value. */
export async function adjustCreatureState(
  db: XrawlDatabase,
  key: string,
  delta: number,
  now: number,
): Promise<number | undefined> {
  return db.transaction('rw', db.creatures, async () => {
    const existing = await db.creatures.get(CREATURE_ID);
    if (!existing) return undefined;
    const value = (existing.state[key] ?? 0) + delta;
    existing.state[key] = value;
    existing.updatedAt = now;
    await db.creatures.put(existing);
    return value;
  });
}
