/**
 * Forage targets: eligible words turned into plain points.
 *
 * Perception already produces `WordTarget[]`; this module is the *only* place
 * that decides which of those the creature may care about. Keeping it separate
 * means the action machine and engine never touch rects or page metadata.
 */
import type { Point } from './rig/fabrik';
import type { WordTarget } from '@/shared/types/word-target';

export interface ForageTarget {
  readonly id: string;
  /** Normalized dictionary form, used for reports and feeding events. */
  readonly word: string;
  /** Document-space centre of the word's most substantial rect. */
  readonly point: Point;
  readonly length: number;
  /** 0..1 — rarer words are more interesting. */
  readonly interest: number;
  /** `WordTarget.fingerprint`, carried through to feeding events. */
  readonly fingerprint: string;
  readonly contextSentence: string;
  readonly environment: string;
}

export interface ForageFilter {
  readonly maximumWordLength: number;
  /** Hard cap on candidates handed to the engine; nearest/rarest kept. */
  readonly maxCandidates?: number;
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
    candidates.push({
      id: target.id,
      word: target.normalized,
      point: { x: anchor.x + anchor.width / 2, y: anchor.y + anchor.height / 2 },
      length: target.normalized.length,
      interest: Math.min(1, 1 / frequency),
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

/** Nearest eligible target within `radius` of `origin`. */
export function findNearestTarget(
  targets: readonly ForageTarget[],
  origin: Point,
  radius: number,
): { target: ForageTarget; distance: number } | null {
  let best: ForageTarget | null = null;
  let bestDistance = Infinity;

  for (const target of targets) {
    const distance = Math.hypot(target.point.x - origin.x, target.point.y - origin.y);
    if (distance > radius || distance >= bestDistance) continue;
    best = target;
    bestDistance = distance;
  }

  return best === null ? null : { target: best, distance: bestDistance };
}
