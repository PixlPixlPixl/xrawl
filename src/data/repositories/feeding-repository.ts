import type { EnvironmentKind } from '@/shared/types/page';
import { stableKey } from '@/shared/id';
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
}

export function feedingEventId(
  creatureId: string,
  word: string,
  eatenAt: number,
  fingerprint: string,
): string {
  return stableKey('feed', creatureId, word, eatenAt, fingerprint);
}

export function buildFeedingEvent(input: FeedingEventInput): FeedingEventRecord {
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

/** Last event time per word, used by progression to space feedings out. */
export async function lastFeedingAt(db: XrawlDatabase): Promise<number> {
  const newest = await db.feedingEvents.orderBy('eatenAt').last();
  return newest?.eatenAt ?? 0;
}
