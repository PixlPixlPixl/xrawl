/**
 * Environment interests: what browsing makes the creature curious about.
 *
 * Deliberately *not* part of the embedding system. A host rule and a short word
 * list answer "what kind of page is this" and "is this word about cooking",
 * which is enough to develop interests from exposure without loading a model.
 * The two channels stay separate:
 *
 *  - browsing time  -> broad interests (this module, decayed, no vectors);
 *  - manual feeding -> specific preferences (cognition, embeddings).
 *
 * Interests decay with a half-life, so last month's recipe blog does not keep the
 * creature hungry for cooking forever. All arithmetic is a pure function of
 * recorded times, so the same history always produces the same weights.
 */
import type { EnvironmentKind } from '@/shared/types/page';
import { clamp01 } from './numbers';

export const INTEREST_KINDS = ['technology', 'cooking', 'science', 'news', 'general'] as const;
export type InterestKind = (typeof INTEREST_KINDS)[number];

export const INTEREST_LABELS: Readonly<Record<InterestKind, string>> = {
  technology: 'Technology',
  cooking: 'Food & cooking',
  science: 'Science',
  news: 'News & politics',
  general: 'General reading',
};

export interface InterestContribution {
  readonly interest: InterestKind;
  /** How strongly this page (or this matched word) pulls that interest, 0..1. */
  readonly weight: number;
}

/** Hosts that are unambiguous. Checked without `www.`, lowercase. */
const HOST_RULES: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly interests: readonly InterestContribution[];
}> = [
  // Technology
  {
    pattern: /^(github|gitlab|gitea|bitbucket|codeberg)./,
    interests: [{ interest: 'technology', weight: 1 }],
  },
  {
    pattern: /^(stackoverflow|stackexchange|serverfault|superuser|askubuntu)./,
    interests: [{ interest: 'technology', weight: 1 }],
  },
  {
    pattern: /^(npmjs|pypi|crates\.io|packages\.)|^developer\.|^devdocs\.|^learn\.microsoft/,
    interests: [{ interest: 'technology', weight: 0.9 }],
  },
  {
    pattern: /^(news\.ycombinator|lobste\.rs|hackernews)/,
    interests: [
      { interest: 'technology', weight: 0.8 },
      { interest: 'news', weight: 0.3 },
    ],
  },
  // Food
  {
    pattern: /^(allrecipes|seriouseats|food52|epicurious|bbcgoodfood|tasty|delish|bonappetit|kingarthurbaking)./,
    interests: [{ interest: 'cooking', weight: 1 }],
  },
  {
    pattern: /^(cooking\.|food\.|recipes\.|eatyourbooks)/,
    interests: [{ interest: 'cooking', weight: 0.9 }],
  },
  // Science
  {
    pattern: /^(arxiv|biorxiv|medrxiv|pubmed|ncbi|nature|science|cell|phys|pnas|scientificamerican|newscientist|quantummagazine)./,
    interests: [{ interest: 'science', weight: 1 }],
  },
  {
    pattern: /^(journals\.|research\.|scholar\.)/,
    interests: [{ interest: 'science', weight: 0.8 }],
  },
  // News
  {
    pattern: /^(bbc|cnn|nytimes|theguardian|guardian|reuters|apnews|wsj|washingtonpost|politico|npr|aljazeera|lemonde|spiegel|thetimes|ft)./,
    interests: [{ interest: 'news', weight: 1 }],
  },
  {
    pattern: /^(news\.|politics\.|elections\.)/,
    interests: [{ interest: 'news', weight: 0.8 }],
  },
];

/** Fallback by page kind when no host rule matched. */
const KIND_INTERESTS: Readonly<Record<EnvironmentKind, readonly InterestContribution[]>> = {
  code: [{ interest: 'technology', weight: 1 }],
  docs: [
    { interest: 'technology', weight: 0.7 },
    { interest: 'science', weight: 0.2 },
  ],
  forum: [
    { interest: 'general', weight: 0.5 },
    { interest: 'news', weight: 0.25 },
  ],
  social: [{ interest: 'general', weight: 0.5 }],
  commerce: [{ interest: 'general', weight: 0.4 }],
  search: [{ interest: 'general', weight: 0.5 }],
  video: [{ interest: 'general', weight: 0.4 }],
  article: [{ interest: 'general', weight: 0.8 }],
  email: [],
  unknown: [{ interest: 'general', weight: 0.4 }],
};

/** Page kind alone, for callers with no host (rare, but deterministic). */
export function interestsForKind(kind: EnvironmentKind): readonly InterestContribution[] {
  return KIND_INTERESTS[kind] ?? KIND_INTERESTS.unknown;
}

/**
 * What this page teaches the creature.
 *
 * An explicit override wins outright: the user knows their own sites better than
 * a regex does. Otherwise a host rule beats the page-kind heuristic, because
 * `github.com` is technology even when the page reads like an article.
 */
export function interestsForSite(
  host: string,
  kind: EnvironmentKind,
  override?: InterestKind | null,
): readonly InterestContribution[] {
  if (override) return [{ interest: override, weight: 1 }];

  const normalized = host.trim().toLowerCase().replace(/^www\./, '');
  if (normalized.length > 0) {
    for (const rule of HOST_RULES) {
      if (rule.pattern.test(normalized)) return rule.interests;
    }
  }
  return interestsForKind(kind);
}

/**
 * Word lists per interest. Short on purpose: a word either names the subject or
 * it does not, which is what keeps this honest without a model.
 */
const LEXICONS: Readonly<Record<InterestKind, readonly string[]>> = {
  technology: [
    'algorithm','api','array','backend','bandwidth','binary','bit','bug','byte','cache','cli',
    'code','codebase','compiler','compile','cookie','cpu','cryptography','database','debug',
    'dependency','deploy','deployment','devops','docker','encryption','endpoint','framework',
    'function','git','gpu','hash','http','index','interface','kernel','kubernetes','latency',
    'library','linux','loop','memory','module','network','object','operating','package','parser',
    'platform','pointer','process','programming','protocol','query','recursion','refactor',
    'repository','request','response','runtime','script','server','software','sql','stack',
    'storage','string','syntax','thread','token','type','variable','virtual','web','websocket',
  ],
  cooking: [
    'bake','baking','batter','boil','bread','broth','butter','cake','caramel','cheese','chili',
    'chocolate','chop','cook','cooking','dough','flour','flavor','flavour','food','fry','garlic',
    'grill','herb','ingredient','kitchen','knife','marinade','meal','milk','mix','olive',
    'onion','oven','pepper','recipe','roast','salt','sauce','saute','season','simmer','slice',
    'spice','sugar','taste','toast','tomato','vanilla','vegetable','whisk','yeast',
  ],
  science: [
    'atom','biology','cell','chemical','chemistry','climate','cosmos','dna','ecosystem','energy',
    'enzyme','evolution','experiment','field','gene','genome','gravity','hypothesis','laser',
    'mass','mathematics','matter','measurement','molecule','neuron','nucleus','orbit','organism',
    'particle','physics','quantum','radiation','research','researcher','science','scientific',
    'species','spectrum','statistics','study','telescope','theory','thermodynamics','virus',
  ],
  news: [
    'administration','bill','campaign','candidate','committee','congress','court','crisis',
    'democracy','economy','election','electorate','embassy','federal','government','governor',
    'health','inflation','interview','law','legislation','minister','ministry','negotiation',
    'opinion','opposition','parliament','policy','politics','poll','president','protest',
    'recession','reform','regulation','reporter','senate','senator','summit','tariff','tax',
    'trade','treaty','vote','voter','war','welfare',
  ],
  general: [
    'answer','article','book','chapter','city','community','conversation','country','culture',
    'day','example','family','friend','history','home','idea','language','letter','life','love',
    'music','name','news','note','number','page','people','person','place','question','reading',
    'review','school','season','story','summary','time','today','travel','water','weather','week',
    'word','work','world','year',
  ],
};

const LEXICON_SETS: Readonly<Record<InterestKind, ReadonlySet<string>>> = {
  technology: new Set(LEXICONS.technology),
  cooking: new Set(LEXICONS.cooking),
  science: new Set(LEXICONS.science),
  news: new Set(LEXICONS.news),
  general: new Set(LEXICONS.general),
};

/** Interests a word belongs to, independent of how much the creature likes them. */
export function wordInterests(word: string): InterestKind[] {
  const matches: InterestKind[] = [];
  for (const kind of INTEREST_KINDS) {
    if (LEXICON_SETS[kind].has(word)) matches.push(kind);
  }
  return matches;
}

/**
 * How interesting this word is *given* the creature's exposure weights.
 *
 * Returns 0..1: the weight of the strongest matching interest, or 0 for a word
 * none of the lists know (neutral, never a bonus for being unclassifiable).
 */
export function wordInterest(
  word: string,
  weights: Partial<Record<InterestKind, number>>,
): number {
  let best = 0;
  for (const kind of wordInterests(word)) {
    const weight = weights[kind] ?? 0;
    if (weight > best) best = weight;
  }
  return clamp01(best);
}

export const EXPOSURE_CONFIG = {
  /** Half-life of an interest: a fortnight-old habit counts half as much. */
  halfLifeMs: 14 * 24 * 60 * 60 * 1_000,
  /**
   * Time at which a single visit covers ~63% of the remaining gap to 1.
   * Ninety seconds of focused reading is a real visit; a glance is not.
   */
  saturationMs: 90_000,
  /** Interests below this are forgotten rather than kept as noise. */
  pruneBelow: 0.02,
} as const;

export interface ExposureInterests {
  readonly weights: Partial<Record<InterestKind, number>>;
  /** When the weights were last updated, for the next decay. */
  readonly updatedAt: number;
}

/** Exponential decay, applied lazily from timestamps rather than by a timer. */
export function decayWeights(
  weights: Partial<Record<InterestKind, number>>,
  elapsedMs: number,
): Partial<Record<InterestKind, number>> {
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  if (elapsed === 0) return { ...weights };

  const factor = 0.5 ** (elapsed / EXPOSURE_CONFIG.halfLifeMs);
  const decayed: Partial<Record<InterestKind, number>> = {};
  for (const kind of INTEREST_KINDS) {
    const weight = weights[kind];
    if (weight === undefined) continue;
    const next = weight * factor;
    if (next >= EXPOSURE_CONFIG.pruneBelow) decayed[kind] = next;
  }
  return decayed;
}

/**
 * Fold one stretch of browsing into the weights.
 *
 * Old interests decay first, then the new exposure fills the remaining gap
 * toward 1. Saturating (rather than linear) growth is what makes a long visit
 * meaningful and an endless one not all-consuming.
 */
export function applyExposure(
  current: ExposureInterests,
  contributions: readonly InterestContribution[],
  activeMs: number,
  now: number,
): ExposureInterests {
  const elapsed = Number.isFinite(now - current.updatedAt) ? now - current.updatedAt : 0;
  const weights = decayWeights(current.weights, elapsed);
  const duration = Number.isFinite(activeMs) ? Math.max(0, activeMs) : 0;

  if (duration > 0) {
    const reach = 1 - Math.exp(-duration / EXPOSURE_CONFIG.saturationMs);
    for (const contribution of contributions) {
      const gain = reach * clamp01(contribution.weight);
      if (gain <= 0) continue;
      const before = weights[contribution.interest] ?? 0;
      weights[contribution.interest] = clamp01(before + (1 - before) * gain);
    }
  }

  for (const kind of INTEREST_KINDS) {
    const weight = weights[kind];
    if (weight !== undefined && weight < EXPOSURE_CONFIG.pruneBelow) delete weights[kind];
  }

  return { weights, updatedAt: Number.isFinite(now) ? now : current.updatedAt };
}

/** Rounded weights, biggest first, for status surfaces. */
export function describeInterests(
  weights: Partial<Record<InterestKind, number>>,
): Array<{ interest: InterestKind; weight: number }> {
  return [...INTEREST_KINDS]
    .filter((kind) => (weights[kind] ?? 0) > 0)
    .sort((left, right) => (weights[right] ?? 0) - (weights[left] ?? 0))
    .map((kind) => ({
      interest: kind,
      weight: Math.round((weights[kind] ?? 0) * 100) / 100,
    }));
}
