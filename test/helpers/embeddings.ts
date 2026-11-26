/**
 * Test embedding provider with *known* geometry.
 *
 * MiniLM would make these tests slow, non-deterministic across model revisions
 * and impossible to run offline; this stub answers the only question the tests
 * care about: do two texts share a topic dimension or not? One dimension per
 * topic means "compiler database" is orthogonal to "recipe bread" by
 * construction, so nearest-profile and priority assertions are exact.
 */
import { EMBEDDING_DIMENSIONS, normalizeVector } from '@/progression/semantics';
import type { EmbeddingProvider } from '@/semantics/provider';

const TOPIC_WORDS: Readonly<Record<string, readonly string[]>> = {
  technology: ['code','compiler','database','programming','software','algorithm','repository','api','server','syntax','function'],
  science: ['science','research','physics','biology','chemistry','experiment','theory','evidence'],
  nature: ['nature','animal','plant','forest','ocean','weather','ecology','insect','bird'],
  food: ['food','cooking','recipe','kitchen','taste','meal','ingredient','restaurant','bread'],
  literature: ['literature','story','novel','poem','author','character','essay','history','language'],
};

const TOPIC_ORDER = Object.keys(TOPIC_WORDS);

export function stubVector(text: string): number[] {
  const vector: number[] = [];
  for (let index = 0; index < EMBEDDING_DIMENSIONS; index += 1) vector.push(0);

  const lower = text.toLowerCase();
  let matched = 0;
  TOPIC_ORDER.forEach((topic, slot) => {
    for (const word of TOPIC_WORDS[topic] ?? []) {
      if (lower.includes(word)) {
        vector[slot] = (vector[slot] ?? 0) + 1;
        matched += 1;
      }
    }
  });

  // Anything without a topic gets a dimension of its own: structurally
  // unrelated, which is exactly what an off-topic page is.
  if (matched === 0) vector[EMBEDDING_DIMENSIONS - 1] = 1;
  return normalizeVector(vector);
}

export interface CountingProvider extends EmbeddingProvider {
  readonly calls: number[];
}

export function stubProvider(model = 'test/stub-384'): CountingProvider {
  const calls: number[] = [];
  return {
    model,
    dimensions: EMBEDDING_DIMENSIONS,
    calls,
    async embed(texts) {
      calls.push(texts.length);
      return texts.map((text) => stubVector(text));
    },
  };
}

export function countCalls(provider: CountingProvider): number {
  return provider.calls.reduce((total, value) => total + value, 0);
}
