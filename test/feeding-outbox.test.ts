/**
 * Feeding-outbox tests.
 *
 * A feeding is the one message whose loss is permanent (the word, its XP and its
 * word points never reach the journal), so the queue's retry contract is worth
 * pinning down with no browser and no real clock.
 */
import { describe, expect, it } from 'vitest';
import { FeedingOutbox, type FeedingOutboxTimers } from '@/app/feeding-outbox';
import type { FeedingPayload } from '@/data/observation';

function payload(word: string): FeedingPayload {
  return {
    sessionId: 'session',
    creatureId: 'xrawl-0',
    word,
    eatenAt: 1,
    environment: 'article',
    pageUrl: 'https://example.com/',
    pageTitle: 'Example',
    contextSentence: word,
    fingerprint: `fp-${word}`,
    source: 'autonomous',
    nutrition: 0.5,
    preferenceDelta: 0.2,
  };
}

/** A scheduler that only runs when the test says so. */
function manualTimers(): FeedingOutboxTimers & { runNext(): void; pending(): number } {
  const queue: Array<{ callback: () => void; delayMs: number; handle: number }> = [];
  let nextHandle = 1;
  return {
    schedule(callback, delayMs) {
      const handle = nextHandle++;
      queue.push({ callback, delayMs, handle });
      return handle;
    },
    cancel(handle) {
      const index = queue.findIndex((entry) => entry.handle === handle);
      if (index >= 0) queue.splice(index, 1);
    },
    runNext() {
      const entry = queue.shift();
      entry?.callback();
    },
    pending() {
      return queue.length;
    },
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('delivery', () => {
  it('delivers immediately when the background accepts', async () => {
    const timers = manualTimers();
    const delivered: string[] = [];
    const outbox = new FeedingOutbox({
      deliver: async (entry) => {
        delivered.push(entry.word);
        return true;
      },
      timers,
    });

    outbox.push(payload('alpha'));
    outbox.push(payload('beta'));
    await settle();

    expect(delivered).toEqual(['alpha', 'beta']);
    expect(outbox.pending).toBe(0);
    expect(timers.pending()).toBe(0);
  });

  it('keeps the feeding and retries when delivery fails', async () => {
    const timers = manualTimers();
    let attempts = 0;
    const outbox = new FeedingOutbox({
      deliver: async () => {
        attempts += 1;
        return attempts >= 2;
      },
      timers,
      baseDelayMs: 10,
    });

    outbox.push(payload('alpha'));
    await settle();

    expect(attempts).toBe(1);
    expect(outbox.pending).toBe(1);
    expect(timers.pending()).toBe(1);

    timers.runNext();
    await settle();

    expect(attempts).toBe(2);
    expect(outbox.pending).toBe(0);
  });

  it('treats a thrown delivery as a failure, not a crash', async () => {
    const timers = manualTimers();
    let attempts = 0;
    const outbox = new FeedingOutbox({
      deliver: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('service worker asleep');
        return true;
      },
      timers,
      baseDelayMs: 10,
    });

    outbox.push(payload('alpha'));
    await settle();
    expect(outbox.pending).toBe(1);

    timers.runNext();
    await settle();
    expect(attempts).toBe(2);
    expect(outbox.pending).toBe(0);
  });

  it('backs off further on each failure, and resets after a success', async () => {
    const timers = manualTimers();
    const delays: number[] = [];
    const schedule = timers.schedule;
    timers.schedule = (callback, delayMs) => {
      delays.push(delayMs);
      return schedule(callback, delayMs);
    };
    let attempts = 0;
    const outbox = new FeedingOutbox({
      deliver: async () => {
        attempts += 1;
        return attempts >= 4;
      },
      timers,
      baseDelayMs: 100,
      maxDelayMs: 250,
    });

    outbox.push(payload('alpha'));
    await settle();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      timers.runNext();
      await settle();
    }

    // 100 -> 180 -> capped at 250.
    expect(delays).toEqual([100, 180, 250]);
    expect(attempts).toBe(4);
    expect(outbox.pending).toBe(0);
  });

  it('flush retries without waiting for the timer', async () => {
    const timers = manualTimers();
    let attempts = 0;
    const outbox = new FeedingOutbox({
      deliver: async () => {
        attempts += 1;
        return attempts >= 2;
      },
      timers,
      baseDelayMs: 60_000,
    });

    outbox.push(payload('alpha'));
    await settle();
    expect(timers.pending()).toBe(1);

    outbox.flush();
    await settle();
    expect(attempts).toBe(2);
    expect(outbox.pending).toBe(0);
    expect(timers.pending()).toBe(0);
  });
});

describe('bounds', () => {
  it('drops the oldest feeding past the ceiling instead of growing forever', async () => {
    const timers = manualTimers();
    const outbox = new FeedingOutbox({
      deliver: async () => false,
      timers,
      maxPending: 2,
    });

    outbox.push(payload('one'));
    outbox.push(payload('two'));
    outbox.push(payload('three'));
    await settle();

    expect(outbox.pending).toBe(2);
    expect(outbox.droppedCount).toBe(1);
  });
});
