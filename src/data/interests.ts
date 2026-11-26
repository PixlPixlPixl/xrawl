/**
 * Browsing interests in the store.
 *
 * One write path for "the user spent focused time on this host". It is separate
 * from cognition on purpose: this needs no model, no vectors and no cache, just
 * the host, the page kind and the elapsed time - which is exactly why it keeps
 * working on a phone, offline, or before the model has ever loaded.
 *
 * Weights are decayed lazily from `interestsUpdatedAt`, so nothing has to run in
 * the background for interests to fade.
 */
import type { XrawlDatabase } from './db';
import { interestOverrideId, type InterestOverrideRecord } from './schema';
import { CREATURE_ID } from './repositories/creature-repository';
import { emptyProgression, getProgression } from './repositories/progression-repository';
import {
  applyExposure,
  decayWeights,
  describeInterests,
  interestsForSite,
  type ExposureInterests,
  type InterestContribution,
  type InterestKind,
} from '@/progression/interests';
import type { EnvironmentKind } from '@/shared/types/page';

export interface BrowsingExposureInput {
  readonly host: string;
  readonly environment: EnvironmentKind;
  /** Focused, visible milliseconds - never background-tab time. */
  readonly activeMs: number;
  readonly now: number;
  readonly creatureId?: string;
}

export interface BrowsingExposureResult {
  /** The interest this page pulled most strongly. */
  readonly interest: InterestKind;
  readonly contributions: readonly InterestContribution[];
  readonly weights: Partial<Record<InterestKind, number>>;
  /** True when a user override decided the interest instead of a rule. */
  readonly overridden: boolean;
}



/**
 * Apply one stretch of browsing to the creature's interests.
 *
 * Called after the observation transaction commits, once per whole exposure
 * step, so a heartbeat flush cannot pay twice for the same minute.
 */
export async function recordBrowsingExposure(
  db: XrawlDatabase,
  input: BrowsingExposureInput,
): Promise<BrowsingExposureResult> {
  const host = interestOverrideId(input.host);

  const override = host.length > 0 ? await db.interestOverrides.get(host) : undefined;
  const contributions = interestsForSite(host, input.environment, override?.interest ?? null);
  const interest = contributions[0]?.interest ?? 'general';

  if (input.activeMs <= 0 || contributions.length === 0) {
    const current = await readInterests(db, input.now);
    return {
      interest,
      contributions,
      weights: current.weights,
      overridden: override !== undefined,
    };
  }

  const creatureId = input.creatureId ?? CREATURE_ID;

  return db.transaction('rw', db.progression, async () => {
    const existing = (await db.progression.get(creatureId)) ?? emptyProgression(creatureId, input.now);
    const current: ExposureInterests = {
      weights: existing.interests ?? {},
      updatedAt: existing.interestsUpdatedAt ?? 0,
    };
    const next = applyExposure(current, contributions, input.activeMs, input.now);

    await db.progression.put({
      ...existing,
      interests: next.weights,
      interestsUpdatedAt: next.updatedAt,
      updatedAt: input.now,
    });

    return {
      interest,
      contributions,
      weights: next.weights,
      overridden: override !== undefined,
    };
  });
}

/** Decayed weights as of `now`, for status displays and hunting. */
export async function readInterests(
  db: XrawlDatabase,
  now: number,
  creatureId: string = CREATURE_ID,
): Promise<{ weights: Partial<Record<InterestKind, number>>; described: Array<{ interest: InterestKind; weight: number }> }> {
  const row = await getProgression(db, creatureId);
  const weights = decayWeights(row?.interests ?? {}, now - (row?.interestsUpdatedAt ?? 0));
  return { weights, described: describeInterests(weights) };
}

/* ------------------------------------------------------------------------- */
/* per-site overrides                                                         */
/* ------------------------------------------------------------------------- */

/**
 * Set or clear one host's interest.
 *
 * `null` deletes the row, which is how a site goes back to automatic
 * classification - absence is the "no opinion" state.
 */
export async function setSiteOverride(
  db: XrawlDatabase,
  host: string,
  interest: InterestKind | null,
  now: number,
): Promise<InterestOverrideRecord | undefined> {
  const normalized = interestOverrideId(host);
  if (normalized.length === 0) return undefined;

  if (interest === null) {
    await db.interestOverrides.delete(normalized);
    return undefined;
  }

  const record: InterestOverrideRecord = { host: normalized, interest, updatedAt: now };
  await db.interestOverrides.put(record);
  return record;
}

/** What a page would teach right now, including whether it is overridden. */
export async function describeSite(
  db: XrawlDatabase,
  host: string,
  environment: EnvironmentKind,
): Promise<{ host: string; override: InterestKind | null; interests: readonly InterestContribution[] }> {
  const normalized = interestOverrideId(host);
  const override = normalized.length > 0 ? await db.interestOverrides.get(normalized) : undefined;
  return {
    host: normalized,
    override: override?.interest ?? null,
    interests: interestsForSite(normalized, environment, override?.interest ?? null),
  };
}
