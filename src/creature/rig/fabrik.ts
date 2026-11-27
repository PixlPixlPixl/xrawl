/**
 * FABRIK: Forward And Backward Reaching Inverse Kinematics.
 *
 * Pure math over plain points. Used by the renderer to bend each limb chain to a
 * foot target that the gait controller chose — the renderer never invents joint
 * positions, and the solver never decides where a foot should go.
 *
 * Reference: Aristidou & Lasenby, "FABRIK: a fast, iterative solver for the
 * Inverse Kinematics problem" (2011).
 */
import { CREATURE_CONFIG } from '@/shared/constants/creature';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface SolveOptions {
  /** `true` if the first joint cannot move (attached to the body). */
  readonly pinStart?: boolean;
  /** `true` if the last joint must stay on the target (a planted foot). */
  readonly pinEnd?: boolean;
  readonly tolerance?: number;
  readonly maxIterations?: number;
}

/** Distance between two points. Pure, no allocation beyond the result. */
export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Total length of a limb described by its bone lengths.
 * Also the radius the chain can reach from its base.
 */
export function chainLength(boneLengths: readonly number[]): number {
  let total = 0;
  for (const length of boneLengths) total += Math.max(0, length);
  return total;
}

function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * Solve a chain of `boneLengths.length` bones for the given joint positions.
 *
 * `joints` must contain `boneLengths.length + 1` points: index 0 is the base
 * (attached to the body), index `n` is the foot. The returned chain has the
 * same length and ordering; bone lengths are preserved exactly.
 *
 * Returns a copy of the input when the target is unreachable — FABRIK's answer
 * for "stretch as far as possible, pointing straight at the target" is the
 * correct one for a drawn creature.
 */
export function solveFabrik(
  joints: readonly Point[],
  boneLengths: readonly number[],
  target: Point,
  options: SolveOptions = {},
): Point[] {
  const boneCount = boneLengths.length;
  if (joints.length !== boneCount + 1 || boneCount < 1) {
    throw new Error(`FABRIK: expected ${boneCount + 1} joints for ${boneCount} bones`);
  }

  const tolerance = options.tolerance ?? CREATURE_CONFIG.fabrikEpsilon;
  const maxIterations = options.maxIterations ?? CREATURE_CONFIG.fabrikMaxIterations;
  const pinStart = options.pinStart ?? true;
  const pinEnd = options.pinEnd ?? true;

  const root = joints[0]!;
  const reach = chainLength(boneLengths);
  const rootToTarget = distance(root, target);

  // Unreachable: lay the chain out straight toward the target. This keeps the
  // limb visually attached and pointed, instead of failing or jittering.
  if (rootToTarget > reach + tolerance) {
    return straightChain(root, boneLengths, target);
  }

  // Degenerate: the target sits on the root. Any direction is arbitrary; keep
  // the previous pose rather than producing NaNs.
  if (rootToTarget < tolerance) {
    return joints.map((joint) => ({ ...joint }));
  }

  const chain: Point[] = joints.map((joint) => ({ ...joint }));

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const end = chain[boneCount]!;
    if (distance(end, target) < tolerance) break;

    // Forward: pin the foot on the target, then walk back to the root.
    if (pinEnd) chain[boneCount] = { x: target.x, y: target.y };
    for (let index = boneCount - 1; index >= 0; index -= 1) {
      const next = chain[index + 1]!;
      const bone = boneLengths[index]!;
      const previous = chain[index]!;
      const ratio = bone / Math.max(tolerance, distance(next, previous));
      chain[index] = lerp(next, previous, ratio);
    }

    // Backward: re-pin the root, then walk forward toward the foot.
    if (pinStart) chain[0] = { x: root.x, y: root.y };
    for (let index = 1; index <= boneCount; index += 1) {
      const previous = chain[index - 1]!;
      const bone = boneLengths[index - 1]!;
      const next = chain[index]!;
      const ratio = bone / Math.max(tolerance, distance(previous, next));
      chain[index] = lerp(previous, next, ratio);
    }
  }

  // Never force the foot onto the target after solving: that would change the
  // last bone's length. Convergence is the guarantee, and the residue is
  // bounded by `tolerance`.
  return chain;
}

/**
 * Seed a chain for FABRIK.
 *
 * A perfectly straight seed is an unstable fixed point: with every joint
 * collinear, FABRIK's forward and backward passes pull along the same line and
 * never produce rotation, so a reachable-but-folded target stalls at a
 * straight-but-wrong pose. Short chains are the worst case — a two-bone leg has
 * one joint, and a nearly straight seed leaves it almost no moment arm, so the
 * solver needs dozens of iterations to fold a knee that a better seed folds in
 * a handful.
 *
 * So the seed is a spiral: every bone turns by the same angle, chosen so the
 * resulting chain spans the root-to-target chord. That is already close to the
 * answer for most targets, which keeps the drawn limb bent on every frame.
 *
 * Bone lengths are exact in the seed; only the final foot position is
 * approximate, and the solver corrects it.
 */
export function seedChain(
  root: Point,
  target: Point,
  boneLengths: readonly number[],
  options: { readonly bendSign?: -1 | 1 } = {},
): Point[] {
  const boneCount = boneLengths.length;
  if (boneCount < 1) return [{ ...root }];

  const dx = target.x - root.x;
  const dy = target.y - root.y;
  const chord = Math.hypot(dx, dy);
  const chordAngle = chord > 1e-6 ? Math.atan2(dy, dx) : 0;
  const bendSign = options.bendSign ?? 1;
  const turn = turnForChord(boneLengths, chord) * bendSign;

  const joints: Point[] = [{ ...root }];
  let x = root.x;
  let y = root.y;
  for (let index = 0; index < boneCount; index += 1) {
    // Each bone turns a little more than the one before, so the chain spirals
    // instead of kinking at a single joint.
    const angle = chordAngle + turn * ((index + 1) / boneCount);
    x += Math.cos(angle) * boneLengths[index]!;
    y += Math.sin(angle) * boneLengths[index]!;
    joints.push({ x, y });
  }
  return joints;
}

/**
 * Total turn, in radians, that makes a spiralled chain span `chord`.
 *
 * The span shrinks as the turn grows, so the first crossing is the smallest fold
 * that reaches the target; bisecting inside the bracket finds it to a fraction of
 * a degree. When the chord cannot be spanned even straight, a small turn is
 * returned — enough to break the collinear fixed point.
 */
function turnForChord(boneLengths: readonly number[], chord: number): number {
  const boneCount = boneLengths.length;
  const span = (turn: number): number => {
    let x = 0;
    let y = 0;
    for (let index = 0; index < boneCount; index += 1) {
      const angle = turn * ((index + 1) / boneCount);
      x += Math.cos(angle) * boneLengths[index]!;
      y += Math.sin(angle) * boneLengths[index]!;
    }
    return Math.hypot(x, y);
  };

  const samples = 24;
  if (span(0) <= chord) return MIN_SEED_TURN;

  let previousTurn = 0;
  for (let step = 1; step <= samples; step += 1) {
    const turn = (step / samples) * Math.PI;
    if (span(turn) <= chord) {
      let low = previousTurn;
      let high = turn;
      for (let refine = 0; refine < 18; refine += 1) {
        const mid = (low + high) / 2;
        if (span(mid) > chord) low = mid;
        else high = mid;
      }
      return (low + high) / 2;
    }
    previousTurn = turn;
  }

  return Math.max(MIN_SEED_TURN, previousTurn);
}

/** Smallest fold used when no turn can close the chord. */
const MIN_SEED_TURN = 0.35;

function straightChain(root: Point, boneLengths: readonly number[], target: Point): Point[] {
  const chain: Point[] = [{ x: root.x, y: root.y }];
  const angle = Math.atan2(target.y - root.y, target.x - root.x);
  let x = root.x;
  let y = root.y;
  for (const length of boneLengths) {
    x += Math.cos(angle) * length;
    y += Math.sin(angle) * length;
    chain.push({ x, y });
  }
  return chain;
}

/**
 * Total length swept by a chain laid out from `base` in a given direction —
 * handy for placing a rest pose before the first solve.
 */
export function chainEnd(base: Point, boneLengths: readonly number[], angle: number): Point {
  const reach = chainLength(boneLengths);
  return { x: base.x + Math.cos(angle) * reach, y: base.y + Math.sin(angle) * reach };
}
