/**
 * Embedding cache.
 *
 * The model is deterministic, so a vector is a pure function of (model, text).
 * Caching by content hash means the same sentence is never processed twice - the
 * expensive part on a phone is inference, not storage - and a repeated feeding
 * of the same word in the same context costs a lookup.
 *
 * Cache rows are keyed by model *and* width, so a model swap writes new rows
 * beside the old ones instead of silently reinterpreting them.
 */
import type { XrawlDatabase } from './db';
import { buildEmbeddingId, type EmbeddingSubjectType } from './schema';
import { stableKey } from '@/shared/id';
import {
  EMBEDDING_DIMENSIONS,
  normalizeVector,
  vectorNorm,
} from '@/progression/semantics';
import type { EmbeddingProvider } from '@/semantics/provider';

export interface EmbeddingRequest {
  readonly subjectType: EmbeddingSubjectType;
  readonly text: string;
  /** Optional logical owner (a word, an environment); defaults to the hash. */
  readonly subjectId?: string;
}

export interface EmbedRequestOptions {
  readonly now: number;
}

function isValidVector(vector: readonly number[], dimensions: number): boolean {
  if (vector.length !== dimensions) return false;
  for (const value of vector) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  }
  return vectorNorm(vector) > 0;
}

/**
 * Embed a batch, reusing every cached vector.
 *
 * Vectors come back in request order, normalized, whatever mix of cache hits and
 * fresh inference produced them.
 */
export async function embedWithCache(
  db: XrawlDatabase,
  provider: EmbeddingProvider,
  requests: readonly EmbeddingRequest[],
  options: EmbedRequestOptions,
): Promise<number[][]> {
  if (requests.length === 0) return [];

  const dimensions = provider.dimensions;
  if (dimensions !== EMBEDDING_DIMENSIONS) {
    throw new Error(`provider ${provider.model} emits ${dimensions} dimensions`);
  }

  const results: Array<number[] | null> = requests.map(() => null);
  const misses: Array<{ index: number; id: string; request: EmbeddingRequest; hash: string }> = [];

  const ids = requests.map((request) => {
    const hash = stableKey('text', request.text, request.subjectType);
    return { hash, id: buildEmbeddingId(provider.model, dimensions, request.subjectType, hash) };
  });

  const cached = await db.embeddings.bulkGet(ids.map((entry) => entry.id));
  for (let index = 0; index < requests.length; index += 1) {
    const row = cached[index];
    const request = requests[index]!;
    if (row && row.model === provider.model && isValidVector(row.vector, dimensions)) {
      results[index] = row.normalized ? Array.from(row.vector) : normalizeVector(row.vector);
      continue;
    }
    misses.push({ index, id: ids[index]!.id, request, hash: ids[index]!.hash });
  }

  if (misses.length === 0) return results as number[][];

  const vectors = await provider.embed(misses.map((miss) => miss.request.text));
  if (vectors.length !== misses.length) {
    throw new Error(`provider returned ${vectors.length} vectors for ${misses.length} texts`);
  }

  const rows: Array<Parameters<XrawlDatabase['embeddings']['put']>[0]> = [];
  for (let offset = 0; offset < misses.length; offset += 1) {
    const miss = misses[offset]!;
    const raw = vectors[offset]!;
    if (!isValidVector(raw, dimensions)) continue;

    const vector = normalizeVector(raw);
    results[miss.index] = vector;
    rows.push({
      id: miss.id,
      subjectType: miss.request.subjectType,
      subjectId: miss.request.subjectId ?? miss.hash,
      model: provider.model,
      dimensions,
      vector,
      normalized: true,
      sourceHash: miss.hash,
      createdAt: options.now,
      updatedAt: options.now,
    });
  }

  if (rows.length > 0) await db.embeddings.bulkPut(rows);

  return results.map((vector) => vector ?? []);
}

/** Cached vector for one text, or null when it has never been embedded. */
export async function readCachedEmbedding(
  db: XrawlDatabase,
  model: string,
  dimensions: number,
  request: EmbeddingRequest,
): Promise<number[] | null> {
  const hash = stableKey('text', request.text, request.subjectType);
  const id = buildEmbeddingId(model, dimensions, request.subjectType, hash);
  const row = await db.embeddings.get(id);
  if (!row || row.model !== model || !isValidVector(row.vector, dimensions)) return null;
  return row.normalized ? Array.from(row.vector) : normalizeVector(row.vector);
}

export async function countEmbeddings(db: XrawlDatabase): Promise<number> {
  return db.embeddings.count();
}
