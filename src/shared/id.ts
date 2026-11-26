/** Small, dependency-free identity helpers used for target ids and cache keys. */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const SECOND_SEED = 0x9e3779b9;

export function hashString(input: string, seed = FNV_OFFSET): string {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}

/**
 * Deterministic value in [0, 1) from a string.
 *
 * Used where a rule wants an occasional event without a clock or a random
 * number generator: the same word always "rolls" the same value, so replaying a
 * save reproduces the same decisions exactly.
 */
export function stableUnit(input: string, seed = FNV_OFFSET): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0) / 4294967296;
}

/**
 * 64-bit-ish stable key assembled from parts. Two independent 32-bit FNV
 * runs keep collisions vanishingly unlikely for the tens of thousands of
 * word targets a page can produce.
 */
export function stableKey(...parts: Array<string | number>): string {
  const joined = parts.join('\u0001');
  return hashString(joined) + hashString(joined, SECOND_SEED);
}
