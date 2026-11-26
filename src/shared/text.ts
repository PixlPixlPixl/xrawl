/**
 * Text primitives shared by perception and progression.
 *
 * The same normalization must produce the same dictionary key on both sides of
 * the content/background boundary, so it lives here rather than in either layer.
 */

const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const APOSTROPHES = /[\u2018\u2019\u02BC]/g;

/**
 * Normalize a raw word into its dictionary key: NFKC, lowercase, curly
 * apostrophes unified, and edge punctuation stripped. Punctuation inside a
 * word (hyphens, apostrophes) is preserved; segmentation has already split
 * compounds into their components.
 */
export function normalizeWord(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(APOSTROPHES, "'")
    .replace(EDGE_PUNCTUATION, '');
}
