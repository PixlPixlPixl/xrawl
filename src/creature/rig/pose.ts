/**
 * Pose: the per-frame geometry the renderer draws.
 *
 * This is where the three controllers meet: the movement controller supplies
 * origin/heading, the gait controller supplies foot targets, and FABRIK turns
 * those into joints. The output is plain points — no DOM, no SVG, no style.
 */
import { CREATURE_CONFIG } from '@/shared/constants/creature';
import type { CreatureAppearance, CreatureAction } from '@/shared/types/creature';
import type { Point } from './fabrik';
import { seedChain, solveFabrik } from './fabrik';
import { toWorld, type CreatureRig } from './rig';

export interface LimbPose {
  readonly index: number;
  readonly side: -1 | 1;
  /** Joint chain from body attachment to foot. */
  readonly joints: readonly Point[];
  /** Foot height above the ground, for the shadow offset. */
  readonly lift: number;
  /** Whether this foot was airborne this frame. */
  readonly stepping: boolean;
}

export interface CreaturePose {
  readonly origin: Point;
  readonly heading: number;
  /** Vertical bob applied to the body only, in CSS px. */
  readonly bob: number;
  readonly limbs: readonly LimbPose[];
  /** World-space body ellipse. */
  readonly body: { readonly cx: number; readonly cy: number; readonly rx: number; readonly ry: number };
  /** Head position (forward tip of the body). */
  readonly head: Point;
  /** Jaw opening, 0..1 — 0 closed, 1 fully open during an eat. */
  readonly jaw: number;
  /** 0..1 — how fed the creature is; drives the abdomen bulge. */
  readonly satiety: number;
  /** Which behaviour produced this pose; the renderer only reports it. */
  readonly action: CreatureAction;
}

export interface PoseInput {
  readonly action: CreatureAction;
  readonly rig: CreatureRig;
  readonly appearance: CreatureAppearance;
  readonly origin: Point;
  readonly heading: number;
  readonly feet: ReadonlyArray<Point>;
  /** Per-foot lift and stepping flag; parallel to `feet`. */
  readonly feetState: ReadonlyArray<{ lift: number; stepping: boolean }>;
  /** 0..1 progress of an eat. */
  readonly eatProgress: number;
  /** 0..1 stomach fullness. */
  readonly satiety: number;
  /** Time in seconds, for idle micro-motion. */
  readonly time: number;
}

/**
 * Solve every limb and assemble the drawable pose.
 *
 * Joints start from the previous rest pose each frame (a straight chain toward
 * the foot), so FABRIK has a sensible seed even when the foot teleports across
 * the page on a re-scan.
 */
export function buildPose(input: PoseInput): CreaturePose {
  const { rig, appearance, origin, heading } = input;
  const bob = bodyBob(input.action, input.time);

  const limbs: LimbPose[] = rig.limbs.map((limb, index) => {
    const foot = input.feet[index] ?? toWorld(limb.restTarget, origin, heading);
    const state = input.feetState[index] ?? { lift: 0, stepping: false };
    // The bob is a body offset, so the limb roots ride it too: drawing the body
    // above fixed leg attachments makes the torso slide over its own hips.
    const world = toWorld(limb.base, origin, heading);
    const base = { x: world.x, y: world.y - bob };

    // Limbs bend away from the body mid-line so mirrored legs mirror too.
    const seed = seedChain(base, foot, limb.boneLengths, { bendSign: limb.side });
    const joints = solveFabrik(seed, limb.boneLengths, foot, {
      pinStart: true,
      pinEnd: true,
    });

    return {
      index,
      side: limb.side,
      joints,
      lift: state.lift,
      stepping: state.stepping,
    };
  });

  const forward = { x: Math.cos(heading), y: Math.sin(heading) };
  const halfWidth = appearance.body.width / 2;
  const halfHeight = appearance.body.height / 2;

  return {
    origin,
    heading,
    bob,
    limbs,
    body: {
      cx: origin.x + forward.x * halfWidth,
      cy: origin.y + forward.y * halfWidth,
      rx: halfWidth,
      ry: halfHeight,
    },
    head: {
      x: origin.x + forward.x * appearance.body.width,
      y: origin.y + forward.y * appearance.body.width - bob,
    },
    jaw: input.action === 'eating' ? Math.sin(Math.min(1, input.eatProgress) * Math.PI) : 0,
    satiety: input.satiety,
    action: input.action,
  };
}

/**
 * Body bob.
 *
 * While walking the body rises and falls with the gait; while eating it
 * pulses; while resting it breathes slowly. This is a *drawing* offset: the
 * locomotion origin never moves, so feet do not chase the bounce.
 */
function bodyBob(action: CreatureAction, time: number): number {
  const amplitude = CREATURE_CONFIG.bounceAmplitude;

  switch (action) {
    case 'following':
    case 'foraging':
    case 'approaching':
      return Math.sin(time * 9.5) * amplitude;
    case 'eating':
      return Math.sin(time * 6) * amplitude * 0.45;
    case 'resting':
      return Math.sin(time * 1.1) * amplitude * 0.2;
    case 'idle':
      return Math.sin(time * 1.6) * amplitude * 0.35;
    default:
      return 0;
  }
}
