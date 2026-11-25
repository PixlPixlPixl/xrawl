import { describe, expect, it } from 'vitest';
import { ObservationReporter, collectWordCounts } from '@/app/observation-reporter';
import type { ObservationPayload } from '@/data/observation';
import type { ScanStats, WorldSnapshot, WordTarget } from '@/shared/types/word-target';

function stats(uniqueWordCount: number): ScanStats {
  return {
    targetCount: uniqueWordCount,
    textNodeCount: 1,
    rectCount: uniqueWordCount,
    visibleInViewport: uniqueWordCount,
    uniqueWordCount,
    topWords: [],
    passes: 1,
    lastPassKind: 'initial',
    lastPassStartedAt: 0,
    lastPassDurationMs: 0,
    lastPassNodeCount: 1,
    lastPassLimited: false,
    mutationBatches: 0,
    deferredPasses: 0,
    lastPassChanged: true,
    segmentation: { cacheSize: 0, hits: 0, misses: 0 },
  };
}

function target(word: string, index: number, url: string): WordTarget {
  return {
    id: `${url}:n:${index}`,
    fingerprint: `${url}#${word}#${index}`,
    text: word,
    normalized: word,
    rects: [{ x: 0, y: 0, width: 10, height: 10 }],
    visibility: { rendered: true, inViewport: true, viewportRatio: 1, occluded: false },
    context: { sentence: word, surrounding: word },
    page: { url, title: 'T' },
    environment: 'article',
    scanOrder: index,
    source: { nodeId: `n${index}`, segmentIndex: 0 },
  };
}

function snapshot(url: string, words: readonly string[]): WorldSnapshot {
  const unique = [...new Set(words)];
  return {
    revision: 1,
    page: { url, title: 'T' },
    environment: { kind: 'article', confidence: 1, reasons: [] },
    viewport: { scroll: { x: 0, y: 0 }, size: { width: 800, height: 600 } },
    targets: words.map((word, index) => target(word, index, url)),
    stats: stats(unique.length),
    capturedAt: 0,
  };
}

interface Harness {
  readonly reporter: ObservationReporter;
  readonly sent: ObservationPayload[];
  tick(ms: number): void;
}

function harness(options: { visible?: boolean; heartbeatMs?: number } = {}): Harness {
  let clock = 0;
  const sent: ObservationPayload[] = [];
  const reporter = new ObservationReporter({
    send: (payload) => sent.push(payload),
    heartbeatMs: options.heartbeatMs ?? 15_000,
    now: () => clock,
    isVisible: () => options.visible ?? true,
  });

  return {
    reporter,
    sent,
    tick(ms) {
      clock += ms;
    },
  };
}

describe('collectWordCounts', () => {
  it('counts each fingerprint once per page, most frequent first', () => {
    const base = snapshot('https://a.test/x', ['fox', 'fox', 'dog']);
    // Two targets with identical fingerprints (same node, same segment).
    const duplicate = { ...target('fox', 0, 'https://a.test/x'), id: 'dup' };

    const counts = collectWordCounts({ ...base, targets: [...base.targets, duplicate] });
    expect(counts).toEqual([
      { word: 'fox', count: 2 },
      { word: 'dog', count: 1 },
    ]);
  });
});

describe('ObservationReporter', () => {
  it('reports a visit with words as soon as targets exist', () => {
    const h = harness();
    h.reporter.observe(snapshot('https://a.test/x', ['fox', 'dog']));

    expect(h.sent.length).toBe(1);
    const payload = h.sent[0]!;
    expect(payload.visit).toBe(true);
    expect(payload.words.map((entry) => entry.word)).toEqual(['dog', 'fox']);
    expect(payload.uniqueWordCount).toBe(2);
    expect(payload.host).toBe('a.test');
    expect(payload.environment).toBe('article');
  });

  it('retries word collection when the first snapshot for a page is empty', () => {
    const h = harness();

    // Initial snapshot: page known, nothing measured yet.
    h.reporter.observe(snapshot('https://a.test/x', []));
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]!.visit).toBe(true);
    expect(h.sent[0]!.words).toEqual([]);

    // Initial pass commits: words now arrive without a second visit.
    h.tick(100);
    h.reporter.observe(snapshot('https://a.test/x', ['fox']));
    expect(h.sent.length).toBe(2);
    expect(h.sent[1]!.visit).toBe(false);
    expect(h.sent[1]!.words.map((entry) => entry.word)).toEqual(['fox']);

    // Nothing more to send for the same page.
    h.tick(100);
    h.reporter.observe(snapshot('https://a.test/x', ['fox']));
    expect(h.sent.length).toBe(2);
  });

  it('does not repeat word counts for the same page', () => {
    const h = harness();
    h.reporter.observe(snapshot('https://a.test/x', ['fox']));
    h.tick(20_000);
    h.reporter.observe(snapshot('https://a.test/x', ['fox']));
    expect(h.sent.length).toBe(2);
    expect(h.sent[1]!.words).toEqual([]);
    expect(h.sent[1]!.visit).toBe(false);
    expect(h.sent[1]!.activeMs).toBe(20_000);
  });

  it('sends a fresh visit and words after a page change', () => {
    const h = harness();
    h.reporter.observe(snapshot('https://a.test/one', ['fox']));
    h.tick(500);
    h.reporter.observe(snapshot('https://a.test/two', ['dog']));

    expect(h.sent.length).toBe(3);
    // Previous page gets its remaining time, then the new page gets a visit.
    expect(h.sent[1]!.visit).toBe(false);
    expect(h.sent[1]!.page.url).toBe('https://a.test/one');
    expect(h.sent[2]!.visit).toBe(true);
    expect(h.sent[2]!.page.url).toBe('https://a.test/two');
    expect(h.sent[2]!.words.map((entry) => entry.word)).toEqual(['dog']);
  });

  it('accumulates no browse time while the document is hidden', () => {
    const h = harness({ visible: false, heartbeatMs: 1_000 });
    h.reporter.observe(snapshot('https://a.test/x', ['fox']));
    h.tick(5_000);
    h.reporter.observe(snapshot('https://a.test/x', ['fox']));

    // Nothing changed and no time was counted, so there is nothing to report.
    expect(h.sent.length).toBe(1);

    h.reporter.stop();
    const final = h.sent[h.sent.length - 1]!;
    expect(final.activeMs).toBe(0);
  });

  it('flushes the open page once on stop and then goes quiet', () => {
    const h = harness();
    h.reporter.observe(snapshot('https://a.test/x', ['fox']));
    h.tick(1_000);
    h.reporter.stop();

    expect(h.sent.length).toBe(2);
    expect(h.sent[1]!.activeMs).toBe(1_000);
    expect(h.sent[1]!.visit).toBe(false);

    h.reporter.observe(snapshot('https://a.test/x', ['fox']));
    h.reporter.stop();
    expect(h.sent.length).toBe(2);
  });

  it('records a visit even if the page was closed before any probe ran', () => {
    const h = harness();
    h.reporter.observe(snapshot('https://a.test/x', []));
    h.tick(50);
    h.reporter.stop();
    expect(h.sent.every((payload) => payload.sessionId === h.reporter.sessionId)).toBe(true);
  });
});
