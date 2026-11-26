import type { EnvironmentKind } from '@/shared/types/page';
import { stableKey } from '@/shared/id';
import { siteHost } from '../observation';
import type { XrawlDatabase } from '../db';
import type { FeedingEventRecord } from '../schema';
import type { FeedingSource } from '../observation';

export interface FeedingEventInput {
  readonly id?: string;
  readonly creatureId: string;
  readonly word: string;
  readonly eatenAt: number;
  readonly environment: EnvironmentKind;
  readonly pageUrl: string;
  readonly pageTitle: string;
  readonly contextSentence: string;
  readonly contextHash: string;
  readonly fingerprint: string;
  readonly source?: FeedingSource;
  readonly nutrition: number;
  readonly preferenceDelta: number;
  /** Derived from `pageUrl` when omitted. */
  readonly host?: string;
  /** Reward paid, filled in by ingest once the award has been computed. */
  readonly points?: number;
  readonly xp?: number;
}

/**
 * Bucket width used to make a feeding's id stable across a retried delivery.
 *
 * The id used to include the exact timestamp, so only a byte-identical resend
 * deduped - a rebuilt retry (the content script re-queueing after a dropped
 * message) would pay twice. Rounding the timestamp into ten-second buckets
 * makes a retry land on the same id while two genuine meals cannot collide:
 * the engine's own eat cooldown is 25 seconds for the same target.
 */
export const FEEDING_DEDUPE_WINDOW_MS = 10_000;

export function feedingEventId(
  creatureId: string,
  word: string,
  eatenAt: number,
  fingerprint: string,
): string {
  const bucket = Number.isFinite(eatenAt) ? Math.floor(eatenAt / FEEDING_DEDUPE_WINDOW_MS) : 0;
  return stableKey('feed', creatureId, word, bucket, fingerprint);
}

export function buildFeedingEvent(input: FeedingEventInput): FeedingEventRecord {
  const host = input.host ?? siteHost(input.pageUrl);
  return {
    id: input.id ?? feedingEventId(input.creatureId, input.word, input.eatenAt, input.fingerprint),
    creatureId: input.creatureId,
    word: input.word,
    eatenAt: input.eatenAt,
    environment: input.environment,
    pageUrl: input.pageUrl,
    pageTitle: input.pageTitle,
    contextSentence: input.contextSentence,
    contextHash: input.contextHash,
    fingerprint: input.fingerprint,
    source: input.source ?? 'autonomous',
    nutrition: input.nutrition,
    preferenceDelta: input.preferenceDelta,
    host,
    points: input.points ?? 0,
    xp: input.xp ?? 0,
  };
}

/**
 * Append-only. The id is content-derived, so a retried append (content script
 * reconnect, double flush) cannot duplicate the same event.
 */
export async function appendFeedingEvent(
  db: XrawlDatabase,
  input: FeedingEventInput,
): Promise<FeedingEventRecord> {
  const event = buildFeedingEvent(input);
  await db.feedingEvents.put(event);
  return event;
}

export async function listFeedingEvents(
  db: XrawlDatabase,
  options: { creatureId?: string; limit?: number; offset?: number } = {},
): Promise<FeedingEventRecord[]> {
  const { creatureId, limit = 100, offset = 0 } = options;
  if (creatureId) {
    return db.feedingEvents
      .where('[creatureId+eatenAt]')
      .between([creatureId, -Infinity], [creatureId, Infinity])
      .reverse()
      .offset(offset)
      .limit(limit)
      .toArray();
  }
  return db.feedingEvents.orderBy('eatenAt').reverse().offset(offset).limit(limit).toArray();
}

export async function listFeedingEventsForWord(
  db: XrawlDatabase,
  word: string,
  limit = 50,
): Promise<FeedingEventRecord[]> {
  return db.feedingEvents
    .where('[word+eatenAt]')
    .between([word, -Infinity], [word, Infinity])
    .reverse()
    .limit(limit)
    .toArray();
}

export async function countFeedingEvents(db: XrawlDatabase): Promise<number> {
  return db.feedingEvents.count();
}

/**
 * Newest-first history filtered by a word, a site, or a creature.
 *
 * Each filter uses an index. When no extra predicate is applied on top of the
 * index, both the page and the total come from IndexedDB natively (`count` +
 * `limit`), so nothing is deserialized for rows the caller will not see. Only a
 * source filter, which is not indexed, needs a cursor over the range.
 */
export async function queryFeedingEvents(
  db: XrawlDatabase,
  filter: { word?: string; host?: string; source?: 'manual' | 'autonomous'; creatureId?: string },
  limit: number,
  offset = 0,
): Promise<{ entries: FeedingEventRecord[]; total: number; hasMore: boolean }> {
  const wanted = Math.max(1, Math.floor(limit));
  const skip = Math.max(0, Math.floor(offset));
  const matches = (row: FeedingEventRecord): boolean =>
    (filter.source === undefined || row.source === filter.source) &&
    (filter.creatureId === undefined || row.creatureId === filter.creatureId);

  const source = filter.word
    ? db.feedingEvents
        .where('[word+eatenAt]')
        .between([filter.word, -Infinity], [filter.word, Infinity])
    : filter.host
      ? db.feedingEvents
          .where('[host+eatenAt]')
          .between([filter.host, -Infinity], [filter.host, Infinity])
      : filter.creatureId
        ? db.feedingEvents
            .where('[creatureId+eatenAt]')
            .between([filter.creatureId, -Infinity], [filter.creatureId, Infinity])
        : db.feedingEvents.orderBy('eatenAt');

  // Fast path: the index answers both questions, so no row outside the page is
  // ever materialized.
  if (filter.source === undefined) {
    const total = await source.count();
    const entries = await source.reverse().offset(skip).limit(wanted).toArray();
    return { entries, total, hasMore: total > skip + entries.length };
  }

  let seen = 0;
  let total = 0;
  const entries: FeedingEventRecord[] = [];

  // Newest first, one cursor, both the page and the total from it. This path
  // only exists because `source` has no index of its own.
  await source
    .reverse()
    .each((row) => {
      if (!matches(row)) return;
      total += 1;
      if (seen >= skip && entries.length < wanted) entries.push(row);
      seen += 1;
    });

  return { entries, total, hasMore: total > skip + entries.length };
}

/** Every word eaten on a host, with how many times, newest site use first. */
export async function wordsEatenOnHost(
  db: XrawlDatabase,
  host: string,
  limit = 500,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  await db.feedingEvents
    .where('[host+eatenAt]')
    .between([host, -Infinity], [host, Infinity])
    .limit(limit)
    .each((row) => {
      counts.set(row.word, (counts.get(row.word) ?? 0) + 1);
    });
  return counts;
}

/** Last event time per word, used by progression to space feedings out. */
export async function lastFeedingAt(db: XrawlDatabase): Promise<number> {
  const newest = await db.feedingEvents.orderBy('eatenAt').last();
  return newest?.eatenAt ?? 0;
}
