/**
 * Local word-frequency lookup and rarity scoring.
 *
 * Ships a compressed table generated from wordfreq (see ./data), so the
 * extension has no Python dependency and no network call at runtime. This
 * module is pure: no DOM, no database, no platform - just text in, numbers out.
 */
import { WORD_FREQUENCY_SOURCE, WORD_FREQUENCY_TABLE } from './data/wordfreq-en';

/** Zipf value at which a word stops being "common" for scoring. */
export const COMMON_ZIPF_THRESHOLD = 6;
/** Zipf value at which a word is treated as fully rare. */
export const RARE_ZIPF_THRESHOLD = 3;

/**
 * Rarity of a word the table has never heard of.
 *
 * Neutral on purpose. Treating unknown text as maximally rare would make random
 * strings, typos and page-generated identifiers the most profitable words to
 * eat, which is a farm, not a reward.
 */
export const UNKNOWN_WORD_RARITY = 0.5;

export interface WordRarity {
  /** Normalized dictionary form that was looked up. */
  readonly word: string;
  /** Zipf frequency, or null when the local table does not know the word. */
  readonly zipf: number | null;
  /** 0 (very common) .. 1 (rare); neutral for unknown words. */
  readonly rarity: number;
  readonly known: boolean;
}

/**
 * Normalize a Zipf frequency onto 0..1.
 *
 * Lower Zipf numbers mean rarer words, so the scale is inverted between the
 * two thresholds and clamped outside them. Inputs are clamped rather than
 * rejected: a caller passing a bogus frequency still gets a finite score.
 */
export function rarityScore(zipfFrequency: number): number {
  if (!Number.isFinite(zipfFrequency)) return UNKNOWN_WORD_RARITY;
  return Math.max(
    0,
    Math.min(
      1,
      (COMMON_ZIPF_THRESHOLD - zipfFrequency) / (COMMON_ZIPF_THRESHOLD - RARE_ZIPF_THRESHOLD),
    ),
  );
}

/**
 * Decode the front-coded table into a word -> Zipf map.
 *
 * Each entry is "prefix-length, suffix, zipf-code": the first character is the
 * length of the prefix shared with the previous word, the last two characters
 * are the Zipf frequency times 100 in base 36. Keeping the numeric field at the
 * end means the suffix needs no delimiter.
 */
export function decodeFrequencyTable(table: string): Map<string, number> {
  const frequencies = new Map<string, number>();
  let previous = '';

  for (const line of table.split('\n')) {
    if (line.length < 3) continue;
    const prefixLength = parseInt(line[0]!, 36);
    const code = parseInt(line.slice(-2), 36);
    if (!Number.isFinite(prefixLength) || !Number.isFinite(code)) continue;

    const word = previous.slice(0, prefixLength) + line.slice(1, -2);
    frequencies.set(word, code / 100);
    previous = word;
  }

  return frequencies;
}

let decoded: Map<string, number> | null = null;

/** Decoded table, built once per realm on first lookup. */
export function frequencyMap(): ReadonlyMap<string, number> {
  if (decoded === null) decoded = decodeFrequencyTable(WORD_FREQUENCY_TABLE);
  return decoded;
}

export function lookupZipf(word: string): number | null {
  const value = frequencyMap().get(word);
  return value === undefined ? null : value;
}

export function wordRarity(word: string): WordRarity {
  const zipf = lookupZipf(word);
  if (zipf === null) {
    return { word, zipf: null, rarity: UNKNOWN_WORD_RARITY, known: false };
  }
  return { word, zipf, rarity: rarityScore(zipf), known: true };
}

/** Provenance of the shipped table, for UI/debug surfaces and licensing. */
export const FREQUENCY_TABLE_SOURCE = WORD_FREQUENCY_SOURCE;
