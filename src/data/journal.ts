/**
 * Journal queries: the read side of the history screen.
 *
 * Everything here is a *projection* of tables that already exist. The journal
 * never writes, never rescores a feeding, and never reads page coordinates:
 * a stored rect stops meaning anything the moment the page reflows, while a
 * URL, a title and a timestamp keep their meaning forever.
 *
 * Reading is deliberately bounded. A vocabulary search embeds at most a few
 * hundred candidate vectors, and the feeding log is cursored page by page, so
 * opening the journal on a year of history is a screenful of work rather than
 * a full-table scan.
 */
import { cosineSimilarity, EMBEDDING_DIMENSIONS } from '@/progression/semantics';
import { levelProgress } from '@/progression/level';
import { normalizeWord } from '@/shared/text';
import { stableKey } from '@/shared/id';
import { buildEmbeddingId, type EnvironmentRecord } from './schema';
import type { XrawlDatabase } from './db';
import { CREATURE_ID, getCreature } from './repositories/creature-repository';
import { getProgression } from './repositories/progression-repository';
import {
  listFeedingEventsForWord,
  queryFeedingEvents,
  wordsEatenOnHost,
} from './repositories/feeding-repository';
import { listEnvironmentsByExposure, sumExposureByKind } from './repositories/environment-repository';
import { getVocabularyEntry } from './repositories/vocabulary-repository';
import { environmentLabel } from '@/shared/types/journal';
import type {
  JournalEnvironment,
  JournalFeedingsPage,
  JournalFeedingsQuery,
  JournalOverview,
  JournalRelatedWord,
  JournalVocabularyPage,
  JournalVocabularyQuery,
  JournalWord,
  JournalWordDetail,
} from '@/shared/types/journal';
import type { FeedingEventRecord, VocabularyRecord } from './schema';

/** Candidates embedded when looking for a word's neighbours. */
const RELATED_CANDIDATE_LIMIT = 600;
const RELATED_LIMIT = 8;
/** Neighbours weaker than this are noise, not a relationship. */
const RELATED_MIN_SIMILARITY = 0.2;

const isEaten = (row: VocabularyRecord): boolean => row.timesEaten > 0;

function toFeeding(row: FeedingEventRecord): JournalFeedingsPage['entries'][number] {
  return {
    id: row.id,
    word: row.word,
    eatenAt: row.eatenAt,
    host: row.host,
    pageTitle: row.pageTitle,
    pageUrl: row.pageUrl,
    environment: row.environment,
    source: row.source,
    points: row.points,
    xp: row.xp,
  };
}

function toWord(row: VocabularyRecord): JournalWord {
  return {
    word: row.word,
    timesSeen: row.timesSeen,
    timesEaten: row.timesEaten,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    firstEatenAt: row.firstEatenAt,
    lastEatenAt: row.lastEatenAt,
    environments: row.environments,
  };
}

/** Sum of focused browsing time, in ms. Sessions are one row per page lifetime. */
async function totalActiveMs(db: XrawlDatabase): Promise<number> {
  let total = 0;
  await db.sessions.each((session) => {
    total += Math.max(0, session.activeMs);
  });
  return total;
}

function environmentRows(rows: readonly EnvironmentRecord[], totalMs: number): JournalEnvironment[] {
  const total = Math.max(1, totalMs);
  return rows.map((row) => ({
    kind: row.kind,
    host: row.host,
    label: environmentLabel(row.kind),
    exposureMinutes: Math.round((row.exposureMs / 60_000) * 10) / 10,
    visits: row.visits,
    wordsSeen: row.wordsSeen,
    share: Math.round((row.exposureMs / total) * 1000) / 1000,
  }));
}

export interface OverviewOptions {
  readonly creatureId?: string;
  /** Mirror of the user's context-storage preference, so the page can show it. */
  readonly contextStorage: boolean;
}

export async function journalOverview(
  db: XrawlDatabase,
  options: OverviewOptions,
): Promise<JournalOverview> {
  const creatureId = options.creatureId ?? CREATURE_ID;
  const [creature, progression, totalMs, vocabularyCount, eatenCount] = await Promise.all([
    getCreature(db, creatureId),
    getProgression(db, creatureId),
    totalActiveMs(db),
    db.vocabulary.count(),
    db.vocabulary.filter(isEaten).count(),
  ]);

  const [sites, newest, oldest, manualFeedings, byKind] = await Promise.all([
    listEnvironmentsByExposure(db, 8),
    db.feedingEvents.orderBy('eatenAt').last(),
    db.feedingEvents.orderBy('eatenAt').first(),
    db.feedingEvents.filter((row) => row.source === 'manual').count(),
    sumExposureByKind(db),
  ]);

  // Shares are of *all* recorded exposure, not of the eight sites listed, so a
  // truncated list cannot make a site look like the whole world.
  const siteMs = Object.values(byKind).reduce((sum, entry) => sum + (entry?.exposureMs ?? 0), 0);
  const feedings = progression?.feedings ?? 0;
  const activeMinutes = totalMs / 60_000;
  const xp = progression?.xp ?? 0;
  const progress = levelProgress(xp);

  return {
    creatureName: creature?.name ?? 'Xrawl',
    species: creature?.species ?? 'spider',
    stage: creature?.stage ?? 'hatchling',
    level: progress.level,
    xp,
    xpForNextLevel: progress.xpForNextLevel,
    intoLevel: progress.intoLevel,
    levelSpan: progress.levelSpan,
    wordPoints: progression?.wordPoints ?? 0,
    lifetimeWordPoints: progression?.lifetimeWordPoints ?? 0,
    wordsConsumed: feedings,
    uniqueConsumed: eatenCount,
    uniqueDiscovered: vocabularyCount,
    manualFeedings,
    wordsPerMinute: activeMinutes > 0 ? Math.round((feedings / activeMinutes) * 10) / 10 : 0,
    activeMinutes: Math.round(activeMinutes * 10) / 10,
    firstFeedingAt: oldest?.eatenAt ?? 0,
    lastFeedingAt: newest?.eatenAt ?? 0,
    environments: environmentRows(sites, siteMs),
    contextStorage: options.contextStorage,
  };
}

export async function journalFeedings(
  db: XrawlDatabase,
  query: JournalFeedingsQuery,
  creatureId: string = CREATURE_ID,
): Promise<JournalFeedingsPage> {
  const limit = Math.min(200, Math.max(1, Math.floor(query.limit ?? 50)));
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const filter: Parameters<typeof queryFeedingEvents>[1] = { creatureId };
  if (query.word) filter.word = normalizeWord(query.word);
  if (query.host) filter.host = normalizeHostSearch(query.host);
  if (query.source) filter.source = query.source;

  const page = await queryFeedingEvents(db, filter, limit, offset);
  return { entries: page.entries.map(toFeeding), total: page.total, hasMore: page.hasMore };
}

/** `example.com`, `https://example.com/x` all become `example.com`. */
export function normalizeHostSearch(term: string): string {
  let value = term.trim().toLowerCase();
  if (value.startsWith('https://')) value = value.slice('https://'.length);
  else if (value.startsWith('http://')) value = value.slice('http://'.length);
  if (value.startsWith('www.')) value = value.slice('www.'.length);
  const pathless = value.split('/')[0] ?? value;
  return pathless.split(':')[0] ?? pathless;
}

function looksLikeHost(term: string): boolean {
  return term.includes('.');
}

/** Order the vocabulary index; every branch is a real index, never a sort. */
async function collectVocabularyPage(
  db: XrawlDatabase,
  query: JournalVocabularyQuery,
  limit: number,
  offset: number,
): Promise<JournalVocabularyPage> {
  const onlyEaten = (query.filter ?? 'all') === 'eaten';
  const search = query.search?.trim().toLowerCase() ?? '';

  // "Search by website" is a different lookup, not a text match on the word:
  // it lists what was eaten on that host, in the requested order.
  if (search && looksLikeHost(search)) {
    const host = normalizeHostSearch(search);
    const counts = await wordsEatenOnHost(db, host, 2_000);
    const words = [...counts.keys()];
    const records = (await db.vocabulary.bulkGet(words)).filter(
      (row): row is VocabularyRecord => row !== undefined,
    );

    const sort = query.sort ?? 'eaten';
    const sorted = records.sort((left, right) => {
      if (sort === 'alpha') return left.word.localeCompare(right.word);
      if (sort === 'recent') return right.lastEatenAt - left.lastEatenAt;
      return right.timesEaten - left.timesEaten || left.word.localeCompare(right.word);
    });
    const page = sorted.slice(offset, offset + limit);
    return {
      entries: page.map(toWord),
      total: sorted.length,
      hasMore: sorted.length > offset + page.length,
    };
  }

  const sort = query.sort ?? 'eaten';
  const index = sort === 'alpha' ? 'word' : sort === 'recent' ? 'lastEatenAt' : 'timesEaten';
  const base = search
    ? db.vocabulary.where('word').startsWith(search)
    : db.vocabulary.orderBy(index);

  const wants = Math.max(1, limit);
  const skip = Math.max(0, offset);
  let seen = 0;
  let total = 0;
  const entries: JournalWord[] = [];

  await (search || sort === 'alpha' ? base : base.reverse()).each((row) => {
      if (onlyEaten && !isEaten(row)) return;
      total += 1;
      if (seen >= skip && entries.length < wants) entries.push(toWord(row));
      seen += 1;
    });

  return { entries, total, hasMore: total > skip + entries.length };
}

export async function journalVocabulary(
  db: XrawlDatabase,
  query: JournalVocabularyQuery,
): Promise<JournalVocabularyPage> {
  const limit = Math.min(200, Math.max(1, Math.floor(query.limit ?? 50)));
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  return collectVocabularyPage(db, query, limit, offset);
}

/* ------------------------------------------------------------------------- */
/* related words                                                              */
/* ------------------------------------------------------------------------- */

interface EmbeddingSpace {
  readonly model: string;
  readonly dimensions: number;
}

/**
 * Which model the creature's vectors live in.
 *
 * Profiles are model-scoped, so the highest-weight profile names the space the
 * creature is actually thinking in. Without profiles the model has never run
 * and there is nothing to compare - the journal then falls back to shared sites.
 */
async function embeddingSpace(db: XrawlDatabase): Promise<EmbeddingSpace | null> {
  const profiles = await db.interestProfiles.toArray();
  if (profiles.length === 0) return null;
  const strongest = profiles.reduce((best, row) => (row.weight > best.weight ? row : best));
  if (!strongest.model || strongest.dimensions !== EMBEDDING_DIMENSIONS) return null;
  return { model: strongest.model, dimensions: strongest.dimensions };
}

/** Cosine neighbours among the most-eaten words, in one model space only. */
async function semanticNeighbours(
  db: XrawlDatabase,
  word: string,
  space: EmbeddingSpace,
): Promise<JournalRelatedWord[] | null> {
  const keyOf = (candidate: string): string =>
    buildEmbeddingId(space.model, space.dimensions, 'word', stableKey('text', candidate, 'word'));

  const candidates = (
    await db.vocabulary.orderBy('timesEaten').reverse().limit(RELATED_CANDIDATE_LIMIT).toArray()
  ).filter((row) => row.timesEaten > 0 && row.word !== word);

  const input = stableKey('text', word, 'word');
  const rows = await db.embeddings.bulkGet([
    buildEmbeddingId(space.model, space.dimensions, 'word', input),
    ...candidates.map((candidate) => keyOf(candidate.word)),
  ]);

  const [target, ...others] = rows;
  if (!target || target.subjectType !== 'word' || target.vector.length !== space.dimensions) {
    return null;
  }

  const scored: JournalRelatedWord[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const row = others[index];
    if (!row || row.vector.length !== space.dimensions) continue;
    const similarity = cosineSimilarity(target.vector, row.vector);
    if (similarity < RELATED_MIN_SIMILARITY) continue;
    scored.push({
      word: candidates[index]!.word,
      similarity: Math.round(similarity * 100) / 100,
      timesEaten: candidates[index]!.timesEaten,
      reason: 'semantic',
    });
  }

  scored.sort((left, right) => right.similarity - left.similarity || left.word.localeCompare(right.word));
  return scored.slice(0, RELATED_LIMIT);
}

/**
 * "Related" without a model: words the creature ate on the same sites.
 *
 * Weaker, but honest - and it means the journal is useful on a phone that has
 * never loaded MiniLM.
 */
async function siteNeighbours(
  db: XrawlDatabase,
  word: string,
  hosts: readonly string[],
  exclude: ReadonlySet<string>,
): Promise<JournalRelatedWord[]> {
  const tally = new Map<string, number>();
  for (const host of hosts.slice(0, 3)) {
    const counts = await wordsEatenOnHost(db, host, 2_000);
    for (const [candidate, count] of counts) {
      if (candidate === word || exclude.has(candidate)) continue;
      tally.set(candidate, (tally.get(candidate) ?? 0) + count);
    }
  }

  const max = Math.max(1, ...tally.values());
  const entries = [...tally.entries()]
    .map(([candidate, count]) => ({
      word: candidate,
      similarity: Math.round((count / max) * 100) / 100,
      timesEaten: candidate ? count : 0,
      reason: 'site' as const,
    }))
    .sort((left, right) => right.similarity - left.similarity || left.word.localeCompare(right.word));

  const records = await db.vocabulary.bulkGet(entries.slice(0, RELATED_LIMIT).map((entry) => entry.word));
  return entries.slice(0, RELATED_LIMIT).map((entry, index) => ({
    ...entry,
    timesEaten: records[index]?.timesEaten ?? entry.timesEaten,
  }));
}

export async function journalWordDetail(
  db: XrawlDatabase,
  rawWord: string,
): Promise<JournalWordDetail> {
  const word = normalizeWord(rawWord);
  const record = await getVocabularyEntry(db, word);
  const feedings = await listFeedingEventsForWord(db, word, 100);

  const hosts: string[] = [];
  for (const feeding of feedings) {
    if (!hosts.includes(feeding.host)) hosts.push(feeding.host);
  }

  const empty: JournalWord = {
    word,
    timesSeen: 0,
    timesEaten: 0,
    firstSeenAt: 0,
    lastSeenAt: 0,
    firstEatenAt: 0,
    lastEatenAt: 0,
    environments: {},
  };

  const space = await embeddingSpace(db);
  const semantic = space ? await semanticNeighbours(db, word, space) : null;
  const related = semantic ?? (await siteNeighbours(db, word, hosts, new Set([word])));

  // Only non-empty sentences mean the user opted into storing context, so an
  // old (or default-off) log simply has nothing to show here.
  const contexts = feedings
    .filter((feeding) => feeding.contextSentence.length > 0)
    .slice(0, 5)
    .map((feeding) => ({ eatenAt: feeding.eatenAt, sentence: feeding.contextSentence }));

  return {
    word: record ? toWord(record) : empty,
    contexts,
    feedings: feedings.map(toFeeding),
    hosts,
    related,
    model: semantic ? space!.model : null,
  };
}
