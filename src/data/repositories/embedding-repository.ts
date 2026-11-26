import { stableKey } from '@/shared/id';
import type { XrawlDatabase } from '../db';
import {
  buildEmbeddingId,
  type EmbeddingRecord,
  type EmbeddingSubjectType,
} from '../schema';

export interface PutEmbeddingInput {
  readonly subjectType: EmbeddingSubjectType;
  readonly subjectId: string;
  readonly model: string;
  readonly vector: readonly number[];
  readonly normalized?: boolean;
  /** Hash of the exact text that produced the vector. */
  readonly sourceHash: string;
  readonly now: number;
}

/**
 * Vector storage is keyed by (model, dimensions, subject type, source hash), so
 * a model swap or a source-text edit writes a new row and leaves the old one
 * intact. Old rows can be pruned by model when no longer referenced.
 */
export async function putEmbedding(
  db: XrawlDatabase,
  input: PutEmbeddingInput,
): Promise<EmbeddingRecord> {
  const dimensions = input.vector.length;
  const id = buildEmbeddingId(input.model, dimensions, input.subjectType, input.sourceHash);

  return db.transaction('rw', db.embeddings, async () => {
    const existing = await db.embeddings.get(id);
    const record: EmbeddingRecord = {
      id,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      model: input.model,
      dimensions,
      vector: [...input.vector],
      normalized: input.normalized ?? false,
      sourceHash: input.sourceHash,
      createdAt: existing?.createdAt ?? input.now,
      updatedAt: input.now,
    };
    await db.embeddings.put(record);
    return record;
  });
}

/** Exact cache lookup — the common path, since the id is derivable up front. */
export async function findEmbedding(
  db: XrawlDatabase,
  input: {
    readonly model: string;
    readonly dimensions: number;
    readonly subjectType: EmbeddingSubjectType;
    readonly sourceHash: string;
  },
): Promise<EmbeddingRecord | undefined> {
  const id = buildEmbeddingId(input.model, input.dimensions, input.subjectType, input.sourceHash);
  return db.embeddings.get(id);
}

/**
 * Model-scoped key: callers that do not know a vector's width can still find
 * the newest row, and can detect width mismatches before using it.
 */
export async function findEmbeddingBySubject(
  db: XrawlDatabase,
  model: string,
  subjectType: EmbeddingSubjectType,
  subjectId: string,
): Promise<EmbeddingRecord | undefined> {
  return db.embeddings
    .where('[model+subjectType+subjectId]')
    .equals([model, subjectType, subjectId])
    .last();
}

export async function pruneEmbeddingsForModel(
  db: XrawlDatabase,
  keepModel: string,
): Promise<number> {
  return db.transaction('rw', db.embeddings, async () => {
    const obsolete = await db.embeddings.filter((row) => row.model !== keepModel).toArray();
    await db.embeddings.bulkDelete(obsolete.map((row) => row.id));
    return obsolete.length;
  });
}

export function embeddingSourceHash(text: string): string {
  return stableKey('source', text);
}
