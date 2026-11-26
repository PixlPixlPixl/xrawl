/**
 * Forage targets: eligible words turned into plain points.
 *
 * Perception already produces `WordTarget[]`; this module is the *only* place
 * that decides which of those the creature may care about. Keeping it separate
 * means the action machine and engine never touch rects or page metadata.
 *
 * Each target carries its scoring *components* rather than a single priority,
 * because scoring also depends on distance: see `progression/forage.ts`.
 */
import type { Point } from './rig/fabrik';
import type { ForagePlan } from '@/progression/forage';
import type { Rect } from '@/shared/types/geometry';
import type { WordTarget } from '@/shared/types/word-target';

export interface ForageTarget {
  readonly id: string;
  /** Normalized dictionary form, used for reports and feeding events. */
  readonly word: string;
  /** Document-space centre of the word's most substantial rect. */
  readonly point: Point;
  readonly length: number;
  /** 0..1 — rarer words are more interesting, and richer to eat. */
  readonly interest: number;
  /**
   * Scoring inputs from the background (rarity, novelty, affinity, environment).
   * Unscored words get a conservative fallback so the creature still forages
   * sensibly before the first priority response arrives.
   */
  readonly plan: ForagePlan;
  /** `WordTarget.fingerprint`, carried through to feeding events. */
  readonly fingerprint: string;
  readonly contextSentence: string;
  readonly environment: string;
}

export interface ForageFilter {
  readonly maximumWordLength: number;
  /** Hard cap on candidates handed to the engine; nearest/rarest kept. */
  readonly maxCandidates?: number;
  /** Scoring components by normalized word, from the background. */
  readonly plans?: ReadonlyMap<string, ForagePlan>;
}

/** The plan used before (or without) any learned scoring. */
export function fallbackPlan(interest: number): ForagePlan {
  return {
    rarity: interest,
    // Never eaten as far as the content script knows: novelty is optimistic.
    novelty: 1,
    affinity: 0,
    environment: 0,
  };
}

/**
 * Build a candidate list from a page snapshot.
 *
 * Hidden or occluded words are excluded — the creature can only go after what
 * the user can see. Words longer than the creature's reach are excluded too;
 * that is an attribute, so an upgrade changes what counts as forage.
 */
export function buildForageTargets(
  targets: readonly WordTarget[],
  filter: ForageFilter,
): ForageTarget[] {
  const counts = new Map<string, number>();
  for (const target of targets) {
    counts.set(target.normalized, (counts.get(target.normalized) ?? 0) + 1);
  }

  const candidates: ForageTarget[] = [];
  for (const target of targets) {
    if (!target.visibility.rendered || !target.visibility.inViewport) continue;
    if (target.visibility.occluded) continue;
    if (target.normalized.length === 0) continue;
    if (target.normalized.length > filter.maximumWordLength) continue;
    if (target.rects.length === 0) continue;

    // The largest rect is the word's visual anchor when it wraps.
    let anchor = target.rects[0]!;
    for (const rect of target.rects) {
      if (rect.width * rect.height > anchor.width * anchor.height) anchor = rect;
    }

    const frequency = counts.get(target.normalized) ?? 1;
    const interest = Math.min(1, 1 / frequency);
    candidates.push({
      id: target.id,
      word: target.normalized,
      point: { x: anchor.x + anchor.width / 2, y: anchor.y + anchor.height / 2 },
      length: target.normalized.length,
      interest,
      plan: filter.plans?.get(target.normalized) ?? fallbackPlan(interest),
      fingerprint: target.fingerprint,
      contextSentence: target.context.sentence,
      environment: target.environment,
    });
  }

  const cap = filter.maxCandidates ?? 1_200;
  if (candidates.length <= cap) return candidates;

  // Deterministic trim: keep the rarest candidates, oldest scan order first.
  return candidates.sort((a, b) => b.interest - a.interest).slice(0, cap);
}

function contains(rects: readonly Rect[], point: Point): boolean {
  for (const rect of rects) {
    if (
      point.x >= rect.x &&
      point.x <= rect.x + rect.width &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.height
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The visible word under a document-space point, if any.
 *
 * Used by the manual feeding mode: a click is only a feeding command while that
 * mode is on, so this must answer "which word did the user mean" from the same
 * measured geometry the outlines use, never from the DOM again.
 */
export function wordAtPoint(
  targets: readonly WordTarget[],
  point: Point,
): WordTarget | null {
  // Prefer the smallest painted rect containing the point: nested words (a word
  // inside a link) resolve to the tightest hit, which is what the user sees.
  let best: WordTarget | null = null;
  let bestArea = Infinity;

  for (const target of targets) {
    if (!target.visibility.rendered || !target.visibility.inViewport) continue;
    if (target.visibility.occluded) continue;
    if (!contains(target.rects, point)) continue;

    const area = target.rects.reduce(
      (total, rect) => (contains([rect], point) ? Math.min(total, rect.width * rect.height) : total),
      Infinity,
    );
    if (area < bestArea) {
      best = target;
      bestArea = area;
    }
  }

  return best;
}
