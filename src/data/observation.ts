/**
 * Observation contracts: the plain-data handoff from perception to persistence.
 *
 * The content script is untrusted (it runs beside arbitrary page code), so the
 * background re-validates every field before writing. These shapes are also the
 * import/export surface for a desktop host: same data, same tables.
 */
import type { EnvironmentKind } from '@/shared/types/page';

export interface WordSightingPayload {
  readonly word: string;
  readonly count: number;
}

/**
 * One flush of page-level activity. Carries deltas since the previous flush, not
 * absolute totals, so the background can accumulate without reading page state.
 */
export interface ObservationPayload {
  readonly sessionId: string;
  readonly capturedAt: number;
  readonly page: { readonly url: string; readonly title: string };
  readonly environment: EnvironmentKind;
  readonly host: string;
  /** Whether this flush marks a new page visit within the session. */
  readonly visit: boolean;
  /** Visible time since the last flush, computed by the content script. */
  readonly activeMs: number;
  readonly words: readonly WordSightingPayload[];
  readonly uniqueWordCount: number;
}

/** \`manual\` when the user chose the word; the creature's own foraging is autonomous. */
export type FeedingSource = 'manual' | 'autonomous';

export interface FeedingPayload {
  readonly sessionId: string;
  readonly creatureId: string;
  readonly word: string;
  readonly eatenAt: number;
  readonly environment: EnvironmentKind;
  readonly pageUrl: string;
  readonly pageTitle: string;
  readonly contextSentence: string;
  readonly fingerprint: string;
  /** Defaults to autonomous: only an explicit user action is manual. */
  readonly source?: FeedingSource;
  readonly nutrition: number;
  readonly preferenceDelta: number;
}

/** Hard caps applied by the background before writing anything. */
export const OBSERVATION_LIMITS = {
  maxWordsPerFlush: 2_000,
  maxWordLength: 64,
  maxActiveMsPerFlush: 60 * 60 * 1_000,
  maxSentenceLength: 240,
  /**
   * Active time in one environment needed for one exposure-learning step.
   * Coarse on purpose: a minute of browsing is moderate evidence, and per-flush
   * learning would turn idling into training.
   */
  exposureStepMs: 45_000,
} as const;

export function isValidWord(word: string): boolean {
  return word.length > 0 && word.length <= OBSERVATION_LIMITS.maxWordLength;
}

export function clampActiveMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(OBSERVATION_LIMITS.maxActiveMsPerFlush, value);
}

/** Host from a URL, `unknown` when unparseable. Never throws. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return 'unknown';
  }
}
