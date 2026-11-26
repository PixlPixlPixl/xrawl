/**
 * Embedding provider port.
 *
 * The data layer never imports a model. It asks a provider for vectors and the
 * provider decides how they are produced (MiniLM on WASM/WebGPU, or the
 * deterministic lexical stand-in). That keeps the store, the reward formula and
 * the tests free of ONNX, and makes a desktop host able to inject its own.
 */

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

/**
 * Synthetic context for an environment, used by exposure learning.
 *
 * There is no page text at the point where "you spent a minute in docs" is
 * known, so each environment kind gets a fixed description. It is deliberately
 * short: an anchor, not a summary.
 */
export const ENVIRONMENT_ANCHORS: Readonly<Record<string, string>> = {
  code: 'source code, repository, compiler, algorithm, function, database, api, syntax',
  docs: 'documentation, reference, manual, guide, api, tutorial, installation',
  article: 'article, blog post, news, story, opinion, explanation, reading',
  social: 'social feed, post, comment, conversation, community, discussion',
  media: 'video, music, image, stream, episode, gallery',
  shop: 'product, price, cart, review, shopping, order, delivery',
  reference: 'wiki, encyclopedia, reference, definition, overview',
  unknown: 'page, website, text, words, browsing',
};

/** Fallback text for a kind that has no anchor of its own. */
export function environmentAnchorText(environment: string, host: string): string {
  const anchor = ENVIRONMENT_ANCHORS[environment] ?? ENVIRONMENT_ANCHORS.unknown!;
  const site = host.trim();
  return site.length > 0 ? `${anchor} on ${site}` : anchor;
}
