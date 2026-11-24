import type { Rect, Visibility, Viewport } from './geometry';
import type { EnvironmentClassification, EnvironmentKind, PageInfo } from './page';

export interface WordContext {
  /** The sentence (or line) the word was found in. */
  readonly sentence: string;
  /** Surrounding block text, collapsed and truncated. */
  readonly surrounding: string;
}

/**
 * Discovered words carry both document-space rects and a measured
 * visibility snapshot. Rects are re-derived from a `Range` per layout pass;
 * visibility is cheap to recompute on scroll (pure geometry).
 */
export type WordVisibility = Visibility;

export interface WordTargetSource {
  /** Stable-per-session id of the text node the word belongs to. */
  readonly nodeId: string;
  /** Segment index within the text node. */
  readonly segmentIndex: number;
}

export interface WordTarget {
  /**
   * Unique within a page snapshot: `<pageKey>:<nodeId>:<segmentIndex>`.
   * `nodeId` is stable for the lifetime of a text node, so outlines and
   * overlay hover state survive re-measurement.
   */
  readonly id: string;
  /**
   * Content-derived identity (`pageKey + normalized word + text-node hash +
   * segment index`). Survives a page reload as long as the content does, so
   * the persistence layer can dedupe the same word on the same page later.
   */
  readonly fingerprint: string;
  /** Original segment text as written in the document (case preserved). */
  readonly text: string;
  /** Normalized dictionary form: NFKC, lowercased, edge punctuation stripped. */
  readonly normalized: string;
  /** One or more document-space rectangles — wrapped words have several. */
  readonly rects: readonly Rect[];
  /** Mutable only within the world model: refreshed on scroll/resize. */
  visibility: WordVisibility;
  readonly context: WordContext;
  readonly page: PageInfo;
  readonly environment: EnvironmentKind;
  /** Document scan order (proxy for reading order). */
  readonly scanOrder: number;
  readonly source: WordTargetSource;
}

export interface WordCount {
  readonly word: string;
  readonly count: number;
}

export type PassKind = 'initial' | 'layout' | 'resize' | 'manual';

export interface SegmentationStats {
  readonly cacheSize: number;
  readonly hits: number;
  readonly misses: number;
}

export interface ScanStats {
  /** Word targets in the world (world-derived). */
  readonly targetCount: number;
  /** Text nodes with at least one target (scanner-derived). */
  readonly textNodeCount: number;
  /** Total rects across all targets (world-derived). */
  readonly rectCount: number;
  /** Targets with at least one rect in the current viewport (world-derived). */
  readonly visibleInViewport: number;
  /** Distinct normalized words (world-derived). */
  readonly uniqueWordCount: number;
  /** Most frequent words, capped (world-derived). */
  readonly topWords: readonly WordCount[];
  /** Completed measurement passes. */
  readonly passes: number;
  /** What triggered the last pass. */
  readonly lastPassKind: PassKind;
  readonly lastPassStartedAt: number;
  readonly lastPassDurationMs: number;
  /** Text nodes visited by the last pass. */
  readonly lastPassNodeCount: number;
  /** Text nodes skipped because the target cap was hit. */
  readonly lastPassLimited: boolean;
  /** Mutation batches observed since start. */
  readonly mutationBatches: number;
  /** Passes skipped because the document was hidden. */
  readonly deferredPasses: number;
  /** Whether the last structural pass changed anything worth re-rendering. */
  readonly lastPassChanged: boolean;
  readonly segmentation: SegmentationStats;
}

/** Stats that come from the world store rather than the scanner. */
export type WorldDerivedStatKey =
  | 'targetCount'
  | 'textNodeCount'
  | 'rectCount'
  | 'visibleInViewport'
  | 'uniqueWordCount'
  | 'topWords';

export type BaseScanStats = Omit<ScanStats, WorldDerivedStatKey>;

export const EMPTY_BASE_STATS: BaseScanStats = Object.freeze({
  passes: 0,
  lastPassKind: 'initial',
  lastPassStartedAt: 0,
  lastPassDurationMs: 0,
  lastPassNodeCount: 0,
  lastPassLimited: false,
  mutationBatches: 0,
  deferredPasses: 0,
  lastPassChanged: false,
  segmentation: { cacheSize: 0, hits: 0, misses: 0 },
});

export interface WorldSnapshot {
  readonly revision: number;
  readonly page: PageInfo;
  readonly environment: EnvironmentClassification;
  readonly viewport: Viewport;
  readonly targets: readonly WordTarget[];
  readonly stats: ScanStats;
  readonly capturedAt: number;
}
