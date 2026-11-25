import type { EnvironmentKind } from '@/shared/types/page';
import type { XrawlDatabase } from '../db';
import type { SessionRecord } from '../schema';

/** Sessions are keyed by the content script's stable per-instance id. */
export async function startSession(
  db: XrawlDatabase,
  id: string,
  now: number,
): Promise<SessionRecord> {
  return db.transaction('rw', db.sessions, async () => {
    const existing = await db.sessions.get(id);
    if (existing) return existing;
    const record: SessionRecord = {
      id,
      startedAt: now,
      lastActiveAt: now,
      endedAt: 0,
      activeMs: 0,
      observations: 0,
      pageVisits: 0,
      wordsSeen: 0,
      feedingCount: 0,
      environments: {},
    };
    await db.sessions.add(record);
    return record;
  });
}

export interface SessionDelta {
  readonly activeMs?: number;
  readonly observations?: number;
  readonly pageVisits?: number;
  readonly wordsSeen?: number;
  readonly feedingCount?: number;
  readonly environment?: EnvironmentKind;
  readonly environmentMs?: number;
}

/**
 * Applies a delta to an open session. `endedAt` stays 0 until `endSession`,
 * which is what keeps the `withEnd(0)`-style queries meaningful despite
 * IndexedDB's inability to index null.
 */
export async function recordSessionActivity(
  db: XrawlDatabase,
  id: string,
  delta: SessionDelta,
  now: number,
): Promise<SessionRecord | undefined> {
  return db.transaction('rw', db.sessions, async () => {
    const existing = await db.sessions.get(id);
    if (!existing) return undefined;

    const environmentMs = Math.max(0, delta.environmentMs ?? 0);
    const environments = { ...existing.environments };
    if (delta.environment && environmentMs > 0) {
      environments[delta.environment] = (environments[delta.environment] ?? 0) + environmentMs;
    }

    const record: SessionRecord = {
      ...existing,
      activeMs: existing.activeMs + Math.max(0, delta.activeMs ?? 0),
      observations: existing.observations + Math.max(0, delta.observations ?? 0),
      pageVisits: existing.pageVisits + Math.max(0, delta.pageVisits ?? 0),
      wordsSeen: existing.wordsSeen + Math.max(0, delta.wordsSeen ?? 0),
      feedingCount: existing.feedingCount + Math.max(0, delta.feedingCount ?? 0),
      environments,
      lastActiveAt: Math.max(existing.lastActiveAt, now),
    };

    await db.sessions.put(record);
    return record;
  });
}

export async function endSession(
  db: XrawlDatabase,
  id: string,
  now: number,
): Promise<SessionRecord | undefined> {
  return db.transaction('rw', db.sessions, async () => {
    const existing = await db.sessions.get(id);
    if (!existing || existing.endedAt !== 0) return existing;

    existing.endedAt = now;
    existing.lastActiveAt = Math.max(existing.lastActiveAt, now);
    await db.sessions.put(existing);
    return existing;
  });
}

export async function listSessions(
  db: XrawlDatabase,
  limit = 20,
): Promise<SessionRecord[]> {
  return db.sessions.orderBy('startedAt').reverse().limit(limit).toArray();
}

/** Summed browse time, independent of how many sessions it was split across. */
export async function totalActiveMs(db: XrawlDatabase): Promise<number> {
  let total = 0;
  await db.sessions.each((session) => {
    total += session.activeMs;
  });
  return total;
}
