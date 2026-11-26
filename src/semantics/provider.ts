/**
 * Embedding provider port.
 *
 * The data layer never imports a model. It asks a provider for vectors and the
 * provider decides how they are produced (MiniLM on WASM/WebGPU, or the
 * deterministic lexical stand-in). That keeps the store, the reward formula and
 * the tests free of ONNX, and makes a desktop host able to inject its own.
 */

/** Timing and backend of the last inference batch, for on-device budgets. */
export interface EmbeddingBatchStats {
  readonly count: number;
  readonly ms: number;
  readonly device: 'wasm' | 'webgpu';
}

export interface EmbeddingProvider {
  /** Model identity, stored on every cache row. */
  readonly model: string;
  /** Vector width; a provider must never emit a different one. */
  readonly dimensions: number;
  /**
   * Embed a batch of texts in one call.
   *
   * Implementations return unit-length vectors (the semantic layer blends and
   * compares cosines), one vector per input, in input order.
   */
  embed(texts: readonly string[]): Promise<number[][]>;
  /**
   * Last batch the provider actually ran, or null before the first one.
   *
   * Optional because a deterministic test provider has no cost worth reporting;
   * the real one uses it to answer "is this affordable on a midrange phone?".
   */
  stats?(): EmbeddingBatchStats | null;
}

/**
 * The text a feeding is represented by.
 *
 * The word alone is a weak signal (`database` on its own says little); the
 * sentence it was read in says what the word *meant here*. Kept in one place so
 * the cache key and the model input can never diverge.
 */
export function feedingText(word: string, contextSentence: string): string {
  const sentence = contextSentence.trim();
  if (sentence.length === 0) return word;
  // The word may already appear in the sentence; repeating it is harmless for a
  // pooled sentence embedding and keeps the input stable and inspectable.
  return sentence.length >= word.length && sentence.toLowerCase().includes(word.toLowerCase())
    ? sentence
    : `${word}: ${sentence}`;
}

