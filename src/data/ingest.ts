/**
 * The write path: turns one observation flush into repository calls.
 *
 * All game-table writes funnel through here so that "what happens on an
 * observation" is one reviewable function rather than logic scattered across
 * message handlers. It is transactional per flush: a flush either records its
 * vocabulary, environment, and session deltas or records none of them.
 */
import { stableKey } from '@/shared/id';
import type { XrawlDatabase } from './db';
import {
  clampActiveMs,
  isValidWord,
  OBSERVATION_LIMITS,
  type FeedingPayload,
  type ObservationPayload,
  type WordSightingPayload,
} from './observation';
import { buildFeedingEvent } from './repositories/feeding-repository';
import { awardFeeding } from './progression';
import { recordEnvironmentExposure } from './repositories/environment-repository';
import { recordSessionActivity, startSession } from './repositories/session-repository';
import { recordWordEaten, recordWordSightings } from './repositories/vocabulary-repository';

export interface IngestResult {
  readonly sessionId: string;
  readonly wordsWritten: number;
  readonly activeMs: number;
  /**
   * Whole exposure steps this flush crossed in its environment (see
   * `OBSERVATION_LIMITS.exposureStepMs`). Derived from persisted session time, so
   * environment learning is reproducible from the observation log rather than
   * from an in-memory timer.
   */
  readonly exposureSteps: number;
}

/** Defensive normalization: the content script is not a trusted source. */
export function sanitizeObservation(payload: ObservationPayload): ObservationPayload {
  const words: WordSightingPayload[] = [];
  for (const entry of payload.words) {
    if (words.length >= OBSERVATION_LIMITS.maxWordsPerFlush) break;
    if (typeof entry.word !== 'string' || !isValidWord(entry.word)) continue;
    const count = Math.floor(entry.count);
    if (!Number.isFinite(count) || count <= 0) continue;
    words.push({ word: entry.word, count });
  }

  return {
    ...payload,
    activeMs: clampActiveMs(payload.activeMs),
    words,
  };
}

/**
 * Records an observation flush.
 *
 * Every numeric input is clamped and every word is length-checked first, so a
 * malformed or hostile payload costs one skipped word, never a corrupt table.
 */
export async function ingestObservation(
  db: XrawlDatabase,
  raw: ObservationPayload,
): Promise<IngestResult> {
  const payload = sanitizeObservation(raw);

  let exposureSteps = 0;

  await db.transaction(
    'rw',
    [db.sessions, db.vocabulary, db.environments],
    async () => {
      await startSession(db, payload.sessionId, payload.capturedAt);

      const before = await db.sessions.get(payload.sessionId);
      const beforeMs = before?.environments[payload.environment] ?? 0;

      if (payload.words.length > 0) {
        await recordWordSightings(db, payload.words, payload.environment, payload.capturedAt);
      }

      await recordEnvironmentExposure(db, {
        kind: payload.environment,
        host: payload.host,
        exposureMs: payload.activeMs,
        observations: 1,
        wordsSeen: payload.words.reduce((total, entry) => total + entry.count, 0),
        uniqueWords: payload.uniqueWordCount,
        visit: payload.visit,
        now: payload.capturedAt,
      });

      const wordsSeen = payload.words.reduce((total, entry) => total + entry.count, 0);
      await recordSessionActivity(
        db,
        payload.sessionId,
        {
          activeMs: payload.activeMs,
          observations: 1,
          pageVisits: payload.visit ? 1 : 0,
          wordsSeen,
          environment: payload.environment,
          environmentMs: payload.activeMs,
        },
        payload.capturedAt,
      );

      const stepMs = OBSERVATION_LIMITS.exposureStepMs;
      const afterMs = beforeMs + payload.activeMs;
      exposureSteps = Math.max(
        0,
        Math.floor(afterMs / stepMs) - Math.floor(beforeMs / stepMs),
      );
    },
  );

  return {
    sessionId: payload.sessionId,
    wordsWritten: payload.words.length,
    activeMs: payload.activeMs,
    exposureSteps,
  };
}

/**
 * Records one feeding event, its denormalized vocabulary counter, and the
 * progression reward it earns - all in one transaction, so XP, word points and
 * the event that explains them can never disagree.
 *
 * `title` is truncated because it is page-controlled text. The event id is
 * content-derived, so a retried delivery is detected and rewarded exactly once.
 */
export interface IngestFeedingOptions {
  /**
   * Store the sentence the word was eaten in. Off by default: it is page text,
   * and cognition only needs it *in memory* to build the contextual vector. The
   * hash is always kept, because it is what dedupes that vector in the cache.
   */
  readonly storeContext?: boolean;
}

export async function ingestFeeding(
  db: XrawlDatabase,
  raw: FeedingPayload,
  options: IngestFeedingOptions = {},
): Promise<boolean> {
  if (typeof raw.word !== 'string' || !isValidWord(raw.word)) return false;

  const sentence = raw.contextSentence.slice(0, OBSERVATION_LIMITS.maxSentenceLength);
  const contextHash = stableKey('context', sentence);

  const event = buildFeedingEvent({
    creatureId: raw.creatureId,
    word: raw.word,
    eatenAt: raw.eatenAt,
    environment: raw.environment,
    pageUrl: raw.pageUrl.slice(0, 2_000),
    pageTitle: raw.pageTitle.slice(0, 500),
    contextSentence: options.storeContext === true ? sentence : '',
    contextHash,
    fingerprint: raw.fingerprint,
    source: raw.source === 'manual' ? 'manual' : 'autonomous',
    nutrition: Number.isFinite(raw.nutrition) ? raw.nutrition : 0,
    preferenceDelta: Number.isFinite(raw.preferenceDelta) ? raw.preferenceDelta : 0,
  });

  // Progression reads the vocabulary row to know whether this is a discovery,
  // so vocabulary must be in scope along with the tables it writes.
  await db.transaction(
    'rw',
    [db.feedingEvents, db.vocabulary, db.sessions, db.progression, db.creatures, db.personality],
    async () => {
      if (await db.feedingEvents.get(event.id)) return;

      // Reading the vocabulary row first is what tells the award whether this
      // feeding is a discovery, so it has to happen before the counter moves.
      const previous = await db.vocabulary.get(raw.word);
      const priorEats = previous?.timesEaten ?? 0;

      await recordWordEaten(db, raw.word, raw.environment, raw.eatenAt);
      await startSession(db, raw.sessionId, raw.eatenAt);
      await recordSessionActivity(db, raw.sessionId, { feedingCount: 1 }, raw.eatenAt);

      const reward = await awardFeeding(db, {
        word: raw.word,
        environment: raw.environment,
        isNewDiscovery: priorEats === 0,
        priorEats,
        creatureId: raw.creatureId,
        now: raw.eatenAt,
      });

      // Written last so the row carries what it actually paid. A failure above
      // rolls back the whole transaction: no event without its reward.
      await db.feedingEvents.put({
        ...event,
        xp: reward.breakdown.xp,
        points: reward.breakdown.wordPoints,
      });
    },
  );

  return true;
}
