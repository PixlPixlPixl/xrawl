/**
 * Central tuning surface for the perception engine and its debug harness.
 * No DOM here — just numbers and strings so hosts can adjust behaviour.
 */
export const XRAWL_CONFIG = {
  /** Attribute marking elements owned by Xrawl (outlines, HUD, tooltip). */
  overlayAttribute: 'data-xrawl-overlay',
  overlayEnabledStorageKey: 'xrawl.debug.overlayEnabled',

  scan: {
    /** Text nodes measured per animation frame before yielding to the page. */
    nodesPerFrame: 120,
    /** Minimum quiet period after DOM mutations before a layout pass runs. */
    mutationDebounceMs: 260,
    /** Debounce for viewport resizes (layout invalidates all geometry). */
    resizeDebounceMs: 220,
    /** Debounce for nested scroll containers that need a scoped re-measure. */
    scopedScrollDebounceMs: 100,
    /** Standard attributes whose changes can affect rendering/visibility. */
    mutationAttributeFilter: [
      'class',
      'style',
      'hidden',
      'contenteditable',
      'inert',
      'open',
      'aria-hidden',
    ],
    /** Hard floor between mutation-driven passes; adapts upward with pass cost. */
    minMutationPassSpacingMs: 400,
    /** A pass never claims more word targets than this (keeps messages sane). */
    maxTargets: 20_000,
    /** Segmentation LRU capacity, keyed by raw text-node content. */
    segmentationCacheSize: 8_000,
    /** Context sentence length budget. */
    sentenceMaxChars: 240,
    /** Surrounding block text length budget. */
    surroundingMaxChars: 320,
    /** Text nodes whose surrounding block is larger than this fall back to node text. */
    surroundingBlockLimit: 2_000,
    /** How often the URL is polled when the Navigation API is unavailable. */
    urlPollIntervalMs: 1_000,
  },

  overlay: {
    cullMarginPx: 12,
    hitTestCellPx: 96,
    strokeAlpha: 0.62,
    hoveredStrokeAlpha: 0.95,
    tooltipOffsetPx: 14,
  },

  messaging: {
    /** Max targets serialized into a single snapshot response. */
    exportTargetLimit: 8_000,
    /** Minimum interval between stats pushes to the background worker. */
    statsPushIntervalMs: 400,
  },
} as const;
