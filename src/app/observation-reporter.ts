/**
 * Content-side observation reporter.
 *
 * The content script never touches IndexedDB. It measures visible browse time
 * and per-page word counts, then hands *deltas* to the background worker through
 * an injected `send` port. Nothing here is game state: it is raw measurement that
 * the persistence layer accumulates.
 *
 * Flushes are coarse by design (one per page change plus a slow heartbeat), so
 * perception stays hot-path clean and message traffic stays low. Word counts are
 * sent once per page identity, and retried on the next signal if the first
 * snapshot for that page arrived before any targets were measured.
 */
import { hostOf, type ObservationPayload, type WordSightingPayload } from '@/data/observation';
import { stableKey } from '@/shared/id';
import type { WorldSnapshot } from '@/shared/types/word-target';

export interface ObservationReporterOptions {
  /** Delivery port; the browser composition root passes a messaging adapter. */
  readonly send: (payload: ObservationPayload) => void;
  /** Minimum spacing between heartbeat flushes while a page stays open. */
  readonly heartbeatMs?: number;
  readonly now?: () => number;
  readonly isVisible?: () => boolean;
}

const DEFAULT_HEARTBEAT_MS = 15_000;

export class ObservationReporter {
  private readonly send: (payload: ObservationPayload) => void;
  private readonly heartbeatMs: number;
  private readonly now: () => number;
  private readonly isVisible: () => boolean;

  readonly sessionId: string;
  private lastSnapshot: WorldSnapshot | null = null;
  private lastTickAt: number;
  private activeMsSinceFlush = 0;
  private readonly visitsSent = new Set<string>();
  private readonly wordsSent = new Set<string>();
  private stopped = false;

  constructor(options: ObservationReporterOptions) {
    this.send = options.send;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.now = options.now ?? Date.now;
    this.isVisible = options.isVisible ?? (() => true);
    this.sessionId = stableKey('session', this.now(), Math.random());
    this.lastTickAt = this.now();
  }

  /** Feed every world snapshot in; the reporter decides when to flush. */
  observe(snapshot: WorldSnapshot): void {
    if (this.stopped) return;

    this.accrueActiveTime();

    const previous = this.lastSnapshot;
    this.lastSnapshot = snapshot;

    if (previous === null || pageKey(previous) !== pageKey(snapshot)) {
      // Attribute accumulated time to the page it was actually spent on.
      if (previous !== null) this.flush(previous, false);
      this.flush(snapshot, true);
      return;
    }

    // The first snapshot for a page can arrive before the initial pass has
    // measured anything; keep looking until that page's words are sent.
    if (!this.wordsSent.has(pageKey(snapshot)) && snapshot.targets.length > 0) {
      this.flush(snapshot, false);
      return;
    }

    if (this.activeMsSinceFlush >= this.heartbeatMs) this.flush(snapshot, false);
  }

  /**
   * Stop the clock: the window lost focus or the document was hidden.
   *
   * Time spent in a background tab is not browse time, so the reporter must not
   * accrue it - otherwise a tab left open overnight would silently rewire the
   * creature's interests. Accrues up to this instant first, so a focused minute
   * is not lost just because it ended with a blur.
   */
  pause(): void {
    if (this.stopped) return;
    this.accrueActiveTime();
  }

  /** Restart the clock after a focus or visibility change. */
  resume(): void {
    if (this.stopped) return;
    this.lastTickAt = this.now();
  }

  /**
   * Undo `stop()` after a back/forward-cache restore.
   *
   * A bfcache page is frozen and thawed, not unloaded, so the reporter must
   * accept snapshots again - otherwise browse time and word sightings stop for
   * the rest of that page's life. The clock restarts at "now" rather than
   * counting the time the page spent frozen.
   */
  restore(): void {
    this.stopped = false;
    this.lastTickAt = this.now();
  }

  /** Final flush when the session closes or the page unloads. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.accrueActiveTime();
    if (this.lastSnapshot !== null) this.flush(this.lastSnapshot, true);
  }

  /** Move the clock forward, counting only time spent on a visible page. */
  private accrueActiveTime(): void {
    const now = this.now();
    if (this.isVisible() && this.lastSnapshot !== null) {
      this.activeMsSinceFlush += Math.max(0, now - this.lastTickAt);
    }
    this.lastTickAt = now;
  }

  private flush(snapshot: WorldSnapshot, allowVisit: boolean): void {
    const key = pageKey(snapshot);

    const visit = allowVisit && !this.visitsSent.has(key);
    if (visit) this.visitsSent.add(key);

    const includeWords = !this.wordsSent.has(key) && snapshot.targets.length > 0;
    if (includeWords) this.wordsSent.add(key);

    if (!visit && !includeWords && this.activeMsSinceFlush <= 0) return;

    this.send({
      sessionId: this.sessionId,
      capturedAt: this.now(),
      page: { url: snapshot.page.url, title: snapshot.page.title },
      environment: snapshot.environment.kind,
      host: hostOf(snapshot.page.url),
      visit,
      activeMs: Math.round(this.activeMsSinceFlush),
      words: includeWords ? collectWordCounts(snapshot) : [],
      uniqueWordCount: snapshot.stats.uniqueWordCount,
    });

    this.activeMsSinceFlush = 0;
  }
}

function pageKey(snapshot: WorldSnapshot): string {
  return `${snapshot.page.url}#${snapshot.page.title}`;
}

/** Word counts for a page snapshot, deduped by target fingerprint. */
export function collectWordCounts(snapshot: WorldSnapshot): WordSightingPayload[] {
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const target of snapshot.targets) {
    if (seen.has(target.fingerprint)) continue;
    seen.add(target.fingerprint);
    counts.set(target.normalized, (counts.get(target.normalized) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([word, count]) => ({ word, count }));
}
