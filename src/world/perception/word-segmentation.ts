/**
 * Word segmentation — pure text in, word spans out.
 *
 * Uses `Intl.Segmenter` (grapheme-aware, locale-aware: handles contractions,
 * CJK, Thai, etc.) with a regex fallback. No DOM access here, so this module
 * is trivially reusable and testable on any host.
 */
import { XRAWL_CONFIG } from '@/shared/constants/config';

export interface WordSegment {
  /** Raw text exactly as it appears in the document. */
  readonly text: string;
  /** Normalized dictionary form. */
  readonly normalized: string;
  /** Offset of the first character within the source text node. */
  readonly start: number;
  /** Offset just past the last character within the source text node. */
  readonly end: number;
}

export interface SegmentationOptions {
  /** Drop words shorter than this after normalization (default 1). */
  readonly minLength?: number;
  /** Safety cap per text node (pathological generated text). */
  readonly maxSegments?: number;
}

const DEFAULT_OPTIONS: Required<SegmentationOptions> = { minLength: 1, maxSegments: 8_192 };

const FALLBACK_WORD = /[\p{L}\p{N}\p{M}]+(?:['\u2019][\p{L}\p{N}\p{M}]+)*/gu;
const HAS_WORD_CHARACTER = /[\p{L}\p{N}]/u;
const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const APOSTROPHES = /[\u2018\u2019\u02BC]/g;

interface SegmenterLike {
  segment(input: string): Iterable<{ segment: string; index: number; isWordLike?: boolean }>;
}

let cachedSegmenter: SegmenterLike | null | undefined;

function getSegmenter(): SegmenterLike | null {
  if (cachedSegmenter !== undefined) return cachedSegmenter;

  const intlWithSegmenter = Intl as typeof Intl & {
    Segmenter?: new (locales?: string | string[], options?: { granularity: 'word' }) => SegmenterLike;
  };

  cachedSegmenter = intlWithSegmenter.Segmenter
    ? new intlWithSegmenter.Segmenter(undefined, { granularity: 'word' })
    : null;

  return cachedSegmenter;
}

/** Normalize a raw word into its dictionary key. */
export function normalizeWord(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(APOSTROPHES, "'")
    .replace(EDGE_PUNCTUATION, '');
}

function isWordLike(text: string): boolean {
  return text.length > 0 && HAS_WORD_CHARACTER.test(text);
}

function segmentWithRegex(text: string, options: Required<SegmentationOptions>): WordSegment[] {
  const segments: WordSegment[] = [];
  FALLBACK_WORD.lastIndex = 0;

  for (let match = FALLBACK_WORD.exec(text); match !== null; match = FALLBACK_WORD.exec(text)) {
    if (segments.length >= options.maxSegments) break;
    const raw = match[0];
    if (!isWordLike(raw)) continue;
    const normalized = normalizeWord(raw);
    if (normalized.length < options.minLength) continue;
    segments.push({ text: raw, normalized, start: match.index, end: match.index + raw.length });
  }

  return segments;
}

export function segmentWords(text: string, options: SegmentationOptions = {}): WordSegment[] {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  const segmenter = getSegmenter();

  if (!segmenter) return segmentWithRegex(text, resolved);

  const segments: WordSegment[] = [];

  for (const part of segmenter.segment(text)) {
    if (segments.length >= resolved.maxSegments) break;
    // `isWordLike` is optional in older engines; punctuation still has no
    // letter/digit character, so the character test is a reliable filter.
    if (part.isWordLike === false) continue;
    if (!isWordLike(part.segment)) continue;

    const normalized = normalizeWord(part.segment);
    if (normalized.length < resolved.minLength) continue;

    segments.push({
      text: part.segment,
      normalized,
      start: part.index,
      end: part.index + part.segment.length,
    });
  }

  return segments;
}

/**
 * Small FIFO cache for segmentation results. A text node is never
 * re-segmented while its content is unchanged, even across layout passes.
 */
export class SegmentationCache {
  private readonly entries = new Map<string, readonly WordSegment[]>();
  private hitCount = 0;
  private missCount = 0;

  constructor(private readonly capacity = XRAWL_CONFIG.scan.segmentationCacheSize) {}

  get(text: string): readonly WordSegment[] {
    const cached = this.entries.get(text);
    if (cached) {
      this.hitCount += 1;
      // Refresh insertion order for a cheap LRU approximation.
      this.entries.delete(text);
      this.entries.set(text, cached);
      return cached;
    }

    this.missCount += 1;
    const segments = segmentWords(text);
    this.entries.set(text, segments);

    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }

    return segments;
  }

  get stats(): { cacheSize: number; hits: number; misses: number } {
    return { cacheSize: this.entries.size, hits: this.hitCount, misses: this.missCount };
  }

  clear(): void {
    this.entries.clear();
  }
}
