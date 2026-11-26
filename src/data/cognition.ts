/**
 * Cognition: how experience becomes preference.
 *
 * Three inputs move the creature, deliberately weighted apart:
 *
 *  - **manual** (0.5) - the user picked the word on purpose;
 *  - **environment** (0.15) - time spent somewhere is weaker evidence;
 *  - **autonomous** (0.08) - its own foraging, weakest of all.
 *
 * If autonomous feeding moved interests as strongly as manual feeding, the
 * creature would reinforce its own choices and get stuck on one subject. The
 * weights, the profile blend, and the hunting exploration factor are what keep
 * it curious.
 *
 * Everything here is deterministic: the same feeding log and the same model
 * rebuild the same profiles, because the model is fixed and the arithmetic is
 * ordered.
 */
import type { XrawlDatabase } from './db';
import { embedWithCache } from './embeddings';
import { loadInterestProfiles, saveInterestProfiles } from './repositories/interest-profile-repository';
import { applyPersonalityDelta } from './repositories/personality-repository';
import {
  PROFILE_ANCHORS,
  SEMANTIC_CONFIG,
  SEMANTIC_INFLUENCE,
  profileScore,
  seedProfiles,
  updateProfiles,
  type InterestProfile,
  type InfluenceSource,
} from '@/progression/semantics';
import { planHunt, type HuntPlan } from '@/progression/hunting';
import { wordRarity } from '@/progression/frequency';
import type { EmbeddingProvider } from '@/semantics/provider';
import { environmentAnchorText, feedingText } from '@/semantics/provider';

/** Rounded pool summary for UI and logs. */
export interface ProfileSummary {
  readonly category: string;
  readonly share: number;
}

export interface CognitionSnapshot {
  readonly model: string;
  /** Category the last observation landed on. */
  readonly assigned: string;
  /** Cosine to that category before the update; 0 for the first observation. */
  readonly similarity: number;
  readonly profiles: readonly ProfileSummary[];
  /** True when the pool was built from anchors by this call. */
  readonly seeded: boolean;
}

function summary(profiles: readonly InterestProfile[]): ProfileSummary[] {
  return [...profiles]
    .sort((left, right) => right.weight - left.weight)
    .map((profile) => ({
      category: profile.category,
      share: Math.round(profile.weight * 100) / 100,
    }));
}

/**
 * Read the pool, building it from anchor phrases on first use (or after a model
 * change, when the old vectors were deleted as unusable).
 *
 * The anchor embeddings go through the same content-hash cache, so this cost is
 * paid once per model, ever.
 */
export async function ensureProfiles(
  db: XrawlDatabase,
  provider: EmbeddingProvider,
  now: number,
): Promise<{ profiles: readonly InterestProfile[]; seeded: boolean }> {
  const existing = await loadInterestProfiles(db, provider.model, provider.dimensions);
  if (existing.length > 0) return { profiles: existing, seeded: false };

  const vectors = await embedWithCache(
    db,
    provider,
    PROFILE_ANCHORS.map((anchor) => ({
      subjectType: 'context' as const,
      text: anchor.text,
      subjectId: `anchor:${anchor.category}`,
    })),
    { now },
  );

  const anchors = PROFILE_ANCHORS.map((anchor, index) => ({
    category: anchor.category,
    vector: vectors[index] ?? [],
  })).filter((anchor) => anchor.vector.length > 0);

  const seeded = seedProfiles(anchors, now);
  await saveInterestProfiles(db, provider.model, provider.dimensions, seeded, now);
  return { profiles: seeded, seeded: true };
}

export interface FeedingCognitionInput {
  readonly word: string;
  readonly sentence: string;
  readonly environment: string;
  readonly source: InfluenceSource;
  readonly now: number;
}

/**
 * Learn from one feeding.
 *
 * The word is embedded **with its sentence**, so `database` on a page about
 * cooking and `database` on a page about compilers pull in different
 * directions. That is the whole point of contextual embeddings.
 */
export async function evolveFromFeeding(
  db: XrawlDatabase,
  provider: EmbeddingProvider,
  input: FeedingCognitionInput,
): Promise<CognitionSnapshot> {
  const prepared = await ensureProfiles(db, provider, input.now);
  const influence = SEMANTIC_INFLUENCE[input.source];

  const [vector] = await embedWithCache(
    db,
    provider,
    [{ subjectType: 'context', text: feedingText(input.word, input.sentence) }],
    { now: input.now },
  );

  if (!vector || vector.length === 0) {
    return {
      model: provider.model,
      assigned: SEMANTIC_CONFIG.generalProfile,
      similarity: 0,
      profiles: summary(prepared.profiles),
      seeded: prepared.seeded,
    };
  }

  const update = updateProfiles(prepared.profiles, vector, influence, input.now);
  await saveInterestProfiles(
    db,
    provider.model,
    provider.dimensions,
    update.profiles,
    input.now,
  );

  // The scalar tendencies the reward formula reads. Signed: a word that does
  // not fit the creature's interests slightly lowers its affinity for that
  // environment and word, which is what makes preferences directional.
  const evidence = Math.min(1, Math.max(-1, update.similarity * 2 - 1));
  const learningRate = Math.min(0.5, Math.max(0.05, influence));

  await applyPersonalityDelta(db, {
    kind: 'interest',
    key: input.environment,
    evidence,
    learningRate,
    now: input.now,
  });
  await applyPersonalityDelta(db, {
    kind: 'preference',
    key: input.word,
    evidence,
    learningRate,
    now: input.now,
  });

  return {
    model: provider.model,
    assigned: update.assigned,
    similarity: update.similarity,
    profiles: summary(update.profiles),
    seeded: prepared.seeded,
  };
}

export interface ExposureCognitionInput {
  readonly environment: string;
  readonly host: string;
  /** Number of whole exposure steps accumulated (already throttled upstream). */
  readonly steps: number;
  readonly now: number;
}

/**
 * Learn from time spent in an environment.
 *
 * Weaker than a feeding on purpose, and it only fires on whole steps, so idling
 * on a page for eight hours is not eight hours of evidence. The anchor text
 * stands in for a page summary: at this point there is no text to embed.
 */
export async function evolveFromExposure(
  db: XrawlDatabase,
  provider: EmbeddingProvider,
  input: ExposureCognitionInput,
): Promise<CognitionSnapshot> {
  const prepared = await ensureProfiles(db, provider, input.now);
  const steps = Math.min(3, Math.max(0, Math.trunc(input.steps)));
  if (steps === 0) {
    return {
      model: provider.model,
      assigned: SEMANTIC_CONFIG.generalProfile,
      similarity: 0,
      profiles: summary(prepared.profiles),
      seeded: prepared.seeded,
    };
  }

  const [vector] = await embedWithCache(
    db,
    provider,
    [
      {
        subjectType: 'environment',
        text: environmentAnchorText(input.environment, input.host),
        subjectId: input.environment,
      },
    ],
    { now: input.now },
  );

  let profiles = prepared.profiles;
  let assigned: string = SEMANTIC_CONFIG.generalProfile;
  let similarity = 0;

  for (let step = 0; step < steps; step += 1) {
    if (!vector || vector.length === 0) break;
    const update = updateProfiles(profiles, vector, SEMANTIC_INFLUENCE.environment, input.now);
    profiles = update.profiles;
    assigned = update.assigned;
    similarity = update.similarity;
  }

  await saveInterestProfiles(db, provider.model, provider.dimensions, profiles, input.now);

  return {
    model: provider.model,
    assigned,
    similarity,
    profiles: summary(profiles),
    seeded: prepared.seeded,
  };
}

export interface PriorityRequest {
  readonly word: string;
  /** Sentence the word appeared in, when the caller has one. */
  readonly sentence?: string;
}

export interface WordPriority extends HuntPlan {
  readonly word: string;
}

export interface PriorityOptions {
  readonly now: number;
  /** How many top candidates pay for a context embedding (default 24). */
  readonly contextLimit?: number;
}

const CONTEXT_PRIORITY_LIMIT = 24;

/**
 * Rank candidate words for hunting.
 *
 * Two stages, because inference is the expensive part: every word gets a cheap
 * word-level embedding, then only the most promising candidates are re-embedded
 * with their sentence and re-scored. A page with 400 visible words therefore
 * costs about 400 word lookups (usually cache hits) plus 24 real inferences.
 */
export async function prioritizeWords(
  db: XrawlDatabase,
  provider: EmbeddingProvider,
  requests: readonly PriorityRequest[],
  options: PriorityOptions,
): Promise<WordPriority[]> {
  if (requests.length === 0) return [];

  const prepared = await ensureProfiles(db, provider, options.now);
  const profiles = prepared.profiles;

  const words = requests.map((request) => request.word);
  const vocabulary = await db.vocabulary.bulkGet(words);
  const timesEaten = new Map<string, number>();
  for (let index = 0; index < words.length; index += 1) {
    const row = vocabulary[index];
    if (row) timesEaten.set(words[index]!, row.timesEaten);
  }

  const wordVectors = await embedWithCache(
    db,
    provider,
    words.map((word) => ({ subjectType: 'word' as const, text: word })),
    { now: options.now },
  );

  const contextLimit = Math.max(0, options.contextLimit ?? CONTEXT_PRIORITY_LIMIT);
  const candidates: Array<{ index: number; relevance: number }> = [];
  const relevanceByIndex: number[] = [];

  for (let index = 0; index < requests.length; index += 1) {
    const vector = wordVectors[index] ?? [];
    const relevance = vector.length > 0 ? profileScore(profiles, vector) : 0;
    relevanceByIndex[index] = relevance;
    if (requests[index]!.sentence && requests[index]!.sentence!.length > 0) {
      candidates.push({ index, relevance });
    }
  }

  const top = candidates
    .sort((left, right) => right.relevance - left.relevance || left.index - right.index)
    .slice(0, contextLimit);

  if (top.length > 0) {
    const contextVectors = await embedWithCache(
      db,
      provider,
      top.map((candidate) => ({
        subjectType: 'context' as const,
        text: feedingText(requests[candidate.index]!.word, requests[candidate.index]!.sentence ?? ''),
      })),
      { now: options.now },
    );

    for (let offset = 0; offset < top.length; offset += 1) {
      const candidate = top[offset]!;
      const vector = contextVectors[offset] ?? [];
      if (vector.length === 0) continue;
      const contextRelevance = profileScore(profiles, vector);
      // The sentence is trusted more than the bare word: 60/40.
      relevanceByIndex[candidate.index] =
        0.4 * (relevanceByIndex[candidate.index] ?? 0) + 0.6 * contextRelevance;
    }
  }

  return requests.map((request, index) => {
    const plan = planHunt({
      word: request.word,
      embedding: wordVectors[index] ?? [],
      profiles,
      timesEaten: timesEaten.get(request.word) ?? 0,
      // Unknown words are neutral, exactly as the reward formula treats them.
      rarity: wordRarity(request.word).rarity,
    });
    return { word: request.word, ...plan, relevance: relevanceByIndex[index] ?? plan.relevance };
  });
}
