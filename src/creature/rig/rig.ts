/**
 * Rig construction: appearance -> limb chains.
 *
 * A rig is derived, never authored. Body size, limb count, bone lengths and
 * joint size all come from `CreatureAppearance`, so a different species or an
 * evolved body produces a different rig with no renderer changes.
 *
 * Coordinates here are **body-local**: +x is forward, +y is the creature's right.
 * `rig.limbs[n].base` and `.restTarget` are local; the controller rotates and
 * translates them into document space each tick.
 */
import type { CreatureAppearance } from '@/shared/types/creature';
import { CREATURE_CONFIG } from '@/shared/constants/creature';
import type { Point } from './fabrik';

export interface LimbRig {
  readonly index: number;
  readonly side: -1 | 1;
  /** Band position from front (0) to back. */
  readonly band: number;
  /** Body-local attachment point. */
  readonly base: Point;
  readonly boneLengths: readonly number[];
  /** Body-local resting foot position. */
  readonly restTarget: Point;
}

export interface CreatureRig {
  readonly body: CreatureAppearance['body'];
  readonly limbs: readonly LimbRig[];
  /** Distance from base to a fully extended foot. */
  readonly reach: number;
  /** Stride length in CSS px. */
  readonly stride: number;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Build a bilateral rig.
 *
 * Feet are placed on an arc around each base so the first solve already bends
 * knees outward: a straight-out foot would give FABRIK a degenerate pose.
 */
export function buildRig(
  appearance: CreatureAppearance,
  options: { readonly strideFactor: number },
): CreatureRig {
  const { body, limbs } = appearance;
  const pairs = Math.max(1, Math.round(limbs.count / 2));
  const reach = limbs.segmentLengths.reduce((sum, length) => sum + length, 0);
  const stride = Math.max(4, reach * clampNumber(options.strideFactor, 0.15, 1));

  const halfWidth = body.width / 2;
  const halfHeight = body.height / 2;
  const bandCount = pairs;
  const limbList: LimbRig[] = [];

  for (let pair = 0; pair < bandCount; pair += 1) {
    // Spread bases over the middle 80% of the body so the ends stay free for
    // the head and abdomen.
    const t = bandCount === 1 ? 0.5 : pair / (bandCount - 1);
    const baseX = halfWidth * (0.8 - t * 1.6);

    // Front bands splay forward, rear bands backward; the middle is near-out.
    // The direction matters: sweeping the *front* pair backwards folds every
    // foot toward the body centre, so front and rear legs cross and several
    // feet compete for the same ground. Positive sweep must open the fan.
    const sweep = bandCount === 1 ? 0 : (0.5 - t) * 2;
    const restDistance = reach * CREATURE_CONFIG.restStanceFraction;

    for (const side of [-1, 1] as const) {
      const angle = side * (Math.PI / 2 - sweep * CREATURE_CONFIG.legSplay);
      const restTarget: Point = {
        x: baseX + Math.cos(angle) * restDistance,
        y: side * halfHeight + Math.sin(angle) * restDistance,
      };

      limbList.push({
        index: limbList.length,
        side,
        band: pair,
        base: { x: baseX, y: side * halfHeight * 0.92 },
        boneLengths: limbs.segmentLengths,
        restTarget,
      });
    }
  }

  return { body, limbs: limbList, reach, stride };
}

/** Rotate + translate a body-local point into document space. */
export function toWorld(point: Point, origin: Point, heading: number): Point {
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  return {
    x: origin.x + point.x * cos - point.y * sin,
    y: origin.y + point.x * sin + point.y * cos,
  };
}
