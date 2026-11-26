/**
 * Delivery queue for feeding events.
 *
 * A feeding is the one message that is not periodic: if it is dropped, the word
 * never reaches the journal and its XP and word points are gone for good. It
 * used to be fire-and-forget, so a service worker that was asleep, restarting,
 * or briefly unreachable silently ate the event. This queue retries with
 * backoff until the background acknowledges the write.
 *
 * Deliberately tiny and dependency-free: the content session owns one, the
 * timers are injected so tests need no real clock, and the queue is bounded so
 * a page that cannot reach the background cannot grow it without limit.
 */
import type { FeedingPayload } from '@/data/observation';

export interface FeedingOutboxTimers {
  schedule(callback: () => void, delayMs: number): number;
  cancel(handle: number): void;
}

export interface FeedingOutboxOptions {
  /** Deliver one payload; resolve `true` only when the background accepted it. */
  readonly deliver: (payload: FeedingPayload) => Promise<boolean>;
  readonly timers: FeedingOutboxTimers;
  /** Oldest events are dropped beyond this many pending deliveries. */
  readonly maxPending?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

const DEFAULT_MAX_PENDING = 25;
const DEFAULT_BASE_DELAY_MS = 2_000;
const DEFAULT_MAX_DELAY_MS = 30_000;
/** Each failed attempt waits this much longer than the previous one. */
const BACKOFF_FACTOR = 1.8;

export class FeedingOutbox {
  private readonly options: FeedingOutboxOptions;
  private readonly queue: FeedingPayload[] = [];
  private draining = false;
  private timer: number | null = null;
  private delayMs: number;
  private dropped = 0;

  constructor(options: FeedingOutboxOptions) {
    this.options = options;
    this.delayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  }

  /** How many feedings are still waiting for the background. */
  get pending(): number {
    return this.queue.length;
  }

  /** How many feedings were discarded because the queue ceiling was reached. */
  get droppedCount(): number {
    return this.dropped;
  }

  /** Queue one feeding and start delivering; never throws. */
  push(payload: FeedingPayload): void {
    const cap = Math.max(1, this.options.maxPending ?? DEFAULT_MAX_PENDING);
    if (this.queue.length >= cap) {
      this.queue.shift();
      this.dropped += 1;
    }
    this.queue.push(payload);
    void this.drain();
  }

  /** Retry now: the browser came back online, or the tab regained focus. */
  flush(): void {
    if (this.timer !== null) {
      this.options.timers.cancel(this.timer);
      this.timer = null;
    }
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining || this.timer !== null) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const payload = this.queue[0]!;
        let accepted = false;
        try {
          accepted = await this.options.deliver(payload);
        } catch {
          accepted = false;
        }
        if (!accepted) {
          this.scheduleRetry();
          return;
        }
        this.queue.shift();
        // A success means the channel works again: start the next failure from
        // the short delay instead of the one the last outage ended on.
        this.delayMs = this.options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
      }
    } finally {
      this.draining = false;
    }
  }

  private scheduleRetry(): void {
    const max = Math.max(
      this.options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
      this.options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    );
    const delay = this.delayMs;
    this.timer = this.options.timers.schedule(() => {
      this.timer = null;
      void this.drain();
    }, delay);
    this.delayMs = Math.min(max, Math.round(delay * BACKOFF_FACTOR));
  }
}
