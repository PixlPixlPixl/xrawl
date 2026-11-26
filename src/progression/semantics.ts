/**
 * Semantic layer: one fixed model, a learned interest profile.
 *
 * Nothing here trains. MiniLM maps text onto a 384-dimensional unit sphere, and
 * the creature's preferences are vector arithmetic on top of those vectors. That
 * keeps the loop deterministic: the same feeding log and the same model always
 * produce the same profiles, so a save replays to identical preferences.
 *
 * Profiles form a pool, exactly like environment affinity: weights always sum
 * to 1, so attention shifts between interests instead of accumulating in every
 * direction at once.
 *
 * This module is pure. It never loads the model, touches storage, or reads the
 * clock; the provider and the repository supply those.
 */

/** Pinned model id. A different model is a different row namespace, never a
 * silent reinterpretation of vectors already stored. */
export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIMENSIONS = 384;

/**
 * Deterministic stand-in used when the model cannot load (offline, blocked,
 * slow device). It keeps the same width and the same *idea*: words that share
 * tokens score higher. Its vectors are only ever compared with its own, because
 * every cache row records which model produced it.
 */
export const FALLBACK_EMBEDDING_MODEL = 'xrawl/lexical-384';

export type SemanticVector = readonly number[];

/**
 * How strongly each kind of *feeding* moves a profile.
 *
 * The user deliberately choosing a word matters most; the creature's own
 * foraging is weakest, or it would reinforce its own choices and get stuck
 * eating one subject.
 *
 * Browsing time is not here on purpose: environment exposure develops broad
 * interests through the classifier and keyword lists (`interests.ts`), which
 * needs no model and therefore cannot be a profile influence.
 */
export const SEMANTIC_INFLUENCE = {
  manual: 0.5,
  autonomous: 0.08,
} as const;

export type InfluenceSource = keyof typeof SEMANTIC_INFLUENCE;

export const SEMANTIC_CONFIG = {
  /**
   * Below this cosine an observation is not "about" any known interest and
   * lands on the general profile. Prevents every new subject from bending the
   * nearest existing one.
   */
  minSimilarity: 0.15,
  /** Observations needed for the blend rate to halve; early learning is fast. */
  blendHalfLife: 6,
  /** Profiles below this share of the pool are forgotten. */
  pruneBelow: 0.02,
  /** Hard ceiling; the weakest profile is dropped when exceeded. */
  maxProfiles: 8,
  generalProfile: 'general',
} as const;

/**
 * One learned interest. `vector` is a normalized `EMBEDDING_DIMENSIONS` vector;
 * `weight` is that profile's share of the pool (all weights sum to 1).
 */
export interface InterestProfile {
  readonly category: string;
  readonly vector: SemanticVector;
  readonly weight: number;
  readonly observations: number;
  readonly updatedAt: number;
}

/**
 * Seed phrases for the starting categories.
 *
 * These are only anchors: the creature still learns where each feeding belongs,
 * and a page about something none of these capture lands on `general`. The
 * phrases are embedded once, by the same model, and cached by content hash.
 */
export const PROFILE_ANCHORS = [
  {
    category: 'technology',
    text: 'software, code, programming, compiler, algorithm, database, server, repository',
  },
  {
    category: 'science',
    text: 'science, research, physics, biology, chemistry, experiment, theory, evidence',
  },
  {
    category: 'nature',
    text: 'nature, animal, plant, forest, ocean, weather, ecology, insect, bird',
  },
  {
    category: 'food',
    text: 'food, cooking, recipe, kitchen, taste, meal, ingredient, restaurant, bread',
  },
  {
    category: 'literature',
    text: 'literature, story, novel, poem, author, character, essay, history, language',
  },
  {
    category: 'general',
    text: 'everyday language, common words, news, conversation, general reading, notes',
  },
] as const;

export function isSemanticVector(value: unknown): value is SemanticVector {
  if (!Array.isArray(value) || value.length !== EMBEDDING_DIMENSIONS) return false;
  for (const entry of value as number[]) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return false;
  }
  return true;
}

/** Euclidean length, summed in index order so the result is bit-stable. */
export function vectorNorm(vector: SemanticVector): number {
  let sum = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index]!;
    sum += value * value;
  }
  return Math.sqrt(sum);
}

/** Unit-length copy; an all-zero vector normalizes to itself. */
export function normalizeVector(vector: SemanticVector): number[] {
  const norm = vectorNorm(vector);
  if (norm === 0 || !Number.isFinite(norm)) return Array.from(vector, () => 0);
  const unit: number[] = [];
  for (let index = 0; index < vector.length; index += 1) {
    unit.push(vector[index]! / norm);
  }
  return unit;
}

/**
 * Cosine similarity in -1..1, or 0 when the vectors cannot be compared.
 *
 * A dimension mismatch is a *model* mismatch, which is never a similarity of
 * zero-but-comparable: it is incomparable, so it scores nothing.
 */
export function cosineSimilarity(left: SemanticVector, right: SemanticVector): number {
  if (left.length !== right.length || left.length === 0) return 0;

  const leftNorm = vectorNorm(left);
  const rightNorm = vectorNorm(right);
  if (leftNorm === 0 || rightNorm === 0) return 0;

  let dot = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
  }

  const value = dot / (leftNorm * rightNorm);
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(-1, value));
}

/** Normalized weighted blend: `(1 - rate) * current + rate * incoming`. */
export function blendVectors(
  current: SemanticVector,
  incoming: SemanticVector,
  rate: number,
): number[] {
  const clamped = Math.min(1, Math.max(0, rate));
  const width = Math.min(current.length, incoming.length);
  const blended: number[] = [];
  for (let index = 0; index < width; index += 1) {
    blended.push(current[index]! * (1 - clamped) + incoming[index]! * clamped);
  }
  return normalizeVector(blended);
}

/** One profile's relevance to an observation, clamped to 0..1 (no anti-interest). */
export function profileSimilarity(profile: InterestProfile, vector: SemanticVector): number {
  return Math.max(0, cosineSimilarity(profile.vector, vector));
}

/**
 * Relevance of a vector to the whole pool: each profile contributes in
 * proportion to its share, so a favourite interest dominates but a weaker one
 * still counts.
 */
export function profileScore(profiles: readonly InterestProfile[], vector: SemanticVector): number {
  if (profiles.length === 0) return 0;
  const unit = normalizeVector(vector);
  let score = 0;
  for (const profile of profiles) {
    score += profile.weight * profileSimilarity(profile, unit);
  }
  return Math.min(1, Math.max(0, score));
}

/** The profile holding the largest share, or null for an empty pool. */
export function leadingProfile(profiles: readonly InterestProfile[]): InterestProfile | null {
  let leader: InterestProfile | null = null;
  for (const profile of profiles) {
    if (leader === null || profile.weight > leader.weight) leader = profile;
  }
  return leader;
}

export interface ProfileUpdate {
  readonly profiles: readonly InterestProfile[];
  /** Category the observation landed on. */
  readonly assigned: string;
  /** Cosine to that category *before* the update. */
  readonly similarity: number;
  /** True when this observation created a new profile. */
  readonly created: boolean;
}

/**
 * Fold one experience into the profile pool.
 *
 * Rules, all deterministic:
 *  - The closest profile takes the observation, unless nothing is close enough
 *    (`minSimilarity`), in which case the observation goes to `general`.
 *  - That profile's vector moves toward the observation by `influence`, slowed
 *    down as it accumulates evidence (`blendHalfLife`) so early learning is
 *    quick and later learning refines instead of thrashing.
 *  - The pool is re-normalized to sum to 1 and the weakest profiles are pruned,
 *    so a creature cannot hoard unlimited interests.
 *
 * Ties and iteration order are fixed by sorting on category, never by insertion.
 */
export function updateProfiles(
  profiles: readonly InterestProfile[],
  incoming: SemanticVector,
  influence: number,
  now: number,
): ProfileUpdate {
  const unit = normalizeVector(incoming);
  if (vectorNorm(unit) === 0) {
    return { profiles, assigned: SEMANTIC_CONFIG.generalProfile, similarity: 0, created: false };
  }

  const clamped = Math.min(1, Math.max(0, influence));
  const sorted = [...profiles].sort((left, right) =>
    left.category < right.category ? -1 : left.category > right.category ? 1 : 0,
  );

  let best: InterestProfile | null = null;
  let bestSimilarity = -Infinity;
  for (const profile of sorted) {
    const similarity = cosineSimilarity(profile.vector, unit);
    // Strictly greater keeps the lexicographically first profile on a tie.
    if (similarity > bestSimilarity) {
      best = profile;
      bestSimilarity = similarity;
    }
  }

  const generalCategory = SEMANTIC_CONFIG.generalProfile;
  let target = best !== null && bestSimilarity >= SEMANTIC_CONFIG.minSimilarity ? best : null;
  if (target === null) {
    target = sorted.find((profile) => profile.category === generalCategory) ?? null;
  }

  let created = false;
  if (target === null) {
    target = {
      category: generalCategory,
      vector: unit,
      weight: 0,
      observations: 0,
      updatedAt: now,
    };
    created = true;
  }

  const similarity = created ? 0 : bestSimilarity;
  const blendRate = clamped / (1 + target.observations / SEMANTIC_CONFIG.blendHalfLife);

  const moved: InterestProfile = {
    category: target.category,
    vector: created ? unit : blendVectors(target.vector, unit, blendRate),
    weight: target.weight + clamped,
    observations: target.observations + 1,
    updatedAt: now,
  };

  const next: InterestProfile[] = [];
  let total = 0;
  for (const profile of sorted) {
    const updated =
      profile.category === moved.category
        ? moved
        : { ...profile, weight: profile.weight * (1 - clamped) };
    next.push(updated);
    total += updated.weight;
  }
  if (created) next.push(moved);
  if (!Number.isFinite(total) || total <= 0) total = 1;

  const normalized: InterestProfile[] = [];
  for (const profile of next) {
    const weight = profile.weight / total;
    if (weight < SEMANTIC_CONFIG.pruneBelow && profile.category !== moved.category) continue;
    normalized.push({ ...profile, weight });
  }

  // Enforce the ceiling by dropping the weakest share, never the newest one.
  while (normalized.length > SEMANTIC_CONFIG.maxProfiles) {
    let weakestIndex = 0;
    for (let index = 1; index < normalized.length; index += 1) {
      if (normalized[index]!.weight < normalized[weakestIndex]!.weight) weakestIndex = index;
    }
    normalized.splice(weakestIndex, 1);
  }

  return {
    profiles: normalized,
    assigned: moved.category,
    similarity: Math.max(0, similarity),
    created,
  };
}

/** Build the starting pool from anchor vectors (one per category, unit length). */
export function seedProfiles(
  anchors: ReadonlyArray<{ category: string; vector: SemanticVector }>,
  now: number,
): InterestProfile[] {
  const share = anchors.length > 0 ? 1 / anchors.length : 0;
  return anchors.map((anchor) => ({
    category: anchor.category,
    vector: normalizeVector(anchor.vector),
    weight: share,
    observations: 0,
    updatedAt: now,
  }));
}

/** Rounded copy for display only; scoring always uses the exact weights. */
export function describeProfiles(profiles: readonly InterestProfile[]): Array<{
  category: string;
  share: number;
}> {
  return [...profiles]
    .sort((left, right) => right.weight - left.weight || (left.category < right.category ? -1 : 1))
    .map((profile) => ({
      category: profile.category,
      share: Math.round(profile.weight * 100) / 100,
    }));
}
