/**
 * Deterministic lexical embeddings.
 *
 * A stand-in for MiniLM that never needs a download: tokens are hashed into a
 * fixed-width space with a stable sign, so texts sharing words score higher.
 * It is *not* a semantic model and does not pretend to be - it keeps the game
 * playable when the model cannot load, and it gives tests a provider that cannot
 * flake.
 *
 * Every vector it produces is recorded under its own model id, so vectors from
 * two different models are never compared.
 */
import { stableUnit } from '@/shared/id';
import { EMBEDDING_DIMENSIONS, FALLBACK_EMBEDDING_MODEL, normalizeVector } from '@/progression/semantics';
import { normalizeWord } from '@/shared/text';
import type { EmbeddingProvider } from './provider';

const TOKEN = /[\p{L}\p{N}']+/gu;
const SIGN_SEED = 0x9e3779b9;

function tokens(text: string): string[] {
  const matches = text.match(TOKEN) ?? [];
  const words: string[] = [];
  for (const match of matches) {
    const word = normalizeWord(match);
    if (word.length > 0) words.push(word);
  }
  return words;
}

/** Hashed bag of words, unit length. Deterministic for any input. */
export function lexicalVector(text: string): number[] {
  const vector: number[] = [];
  for (let index = 0; index < EMBEDDING_DIMENSIONS; index += 1) vector.push(0);
  for (const token of tokens(text)) {
    const slot = Math.min(EMBEDDING_DIMENSIONS - 1, Math.floor(stableUnit(token) * EMBEDDING_DIMENSIONS));
    const sign = stableUnit(token, SIGN_SEED) < 0.5 ? -1 : 1;
    vector[slot] = vector[slot]! + sign;
  }
  return normalizeVector(vector);
}

export const lexicalProvider: EmbeddingProvider = {
  model: FALLBACK_EMBEDDING_MODEL,
  dimensions: EMBEDDING_DIMENSIONS,
  async embed(texts) {
    return texts.map((text) => lexicalVector(text));
  },
};
