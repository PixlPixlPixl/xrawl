/**
 * Gait controller: *when* each foot lifts, *where* it lands, and *when* it plants.
 *
 * The controller owns per-foot world positions. It knows the rig (how many limbs,
 * where their bases and rest targets are) and the body transform, but it never
 * bends a limb — it only chooses foot targets. FABRIK runs later.
 *
 * Protocol:
 *  - Feet plant in world space, so a moving body drags a planted foot behind it
 *    until the drag crosses the step threshold. That drag is what makes the body
 *    look pulled by the legs rather than sliding.
 *  - Stepping alternates between the rig's two groups (band parity). A group may
 *    only start once the other group has had its turn, so a sudden speed change
 *    cannot lift every foot at once.
 *  - The body bob is a drawing offset, not part of the locomotion origin, so
 *    feet never chase the bounce.
 */
import type { Point } from '../rig/fabrik';
import { toWorld, type CreatureRig, type LimbRig } from '../rig/rig';

export interface Foot {
  readonly limb: LimbRig;
  /** World-space position of the foot (includes the step arc while airborne). */
  position: Point;
  /** Where the current step started; the interpolation origin. */
  plantedAt: Point;
  /** Where the current step will land; `null` when standing still. */
  landingAt: Point | null;
  /** True while the foot is lifted and moving. */
  stepping: boolean;
  /** 0..1 progress through the current step. */
  stepPhase: number;
  /** Height of the foot above the ground in CSS px, 0 when planted. */
  lift: number;
}

export interface BodyTransform {
  readonly origin: Point;
  /** Radians; body-local +x points here. */
  readonly heading: number;
}

export interface GaitOptions {
  readonly strideFactor: number;
  readonly stepDurationMs: number;
  readonly liftHeight: number;
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

export class GaitController {
  readonly feet: Foot[];
  readonly rig: CreatureRig;
  private readonly options: GaitOptions;

  /** Which group may start the next step. */
  private nextGroup: 0 | 1 = 0;
  /** Seconds until the alternating group is allowed to lift. */
  private groupCooldown = 0;
  private lastOrigin: Point;

  constructor(rig: CreatureRig, options: GaitOptions, transform: BodyTransform) {
    this.rig = rig;
    this.options = options;
    this.lastOrigin = { ...transform.origin };

    this.feet = rig.limbs.map((limb) => {
      const planted = toWorld(limb.restTarget, transform.origin, transform.heading);
      return {
        limb,
        position: { ...planted },
        plantedAt: { ...planted },
        landingAt: null,
        stepping: false,
        stepPhase: 1,
        lift: 0,
      };
    });
  }

  /**
   * Advance the gait. `speed` is the body's speed in CSS px/s, used only to
   * predict where a foot should land.
   */
  update(dtSeconds: number, transform: BodyTransform, speed: number): void {
    const velocity: Point = {
      x: (transform.origin.x - this.lastOrigin.x) / Math.max(1e-4, dtSeconds),
      y: (transform.origin.y - this.lastOrigin.y) / Math.max(1e-4, dtSeconds),
    };
    this.lastOrigin = { ...transform.origin };

    this.groupCooldown = Math.max(0, this.groupCooldown - dtSeconds);

    for (const foot of this.feet) {
      this.advanceStep(foot, dtSeconds);
    }

    if (this.groupCooldown > 0) return;

    const desired = this.desiredTargets(transform, velocity, speed);
    const group = this.nextGroup;
    const stepThreshold = this.rig.stride * 0.55;
    const duration = Math.max(0.005, this.options.stepDurationMs / 1000);

    let started = false;
    for (const foot of this.feet) {
      if (foot.limb.group !== group || foot.stepping) continue;
      const target = desired.get(foot)!;
      if (Math.hypot(foot.position.x - target.x, foot.position.y - target.y) < stepThreshold) {
        continue;
      }

      foot.plantedAt = { ...foot.position };
      foot.landingAt = target;
      foot.stepping = true;
      foot.stepPhase = 0;
      started = true;
    }

    if (started) {
      this.nextGroup = group === 0 ? 1 : 0;
      // The alternating group may not lift until this group's feet have landed.
      // A shorter cooldown lets both groups overlap, and then every foot is in
      // the air at once — which is not a gait, it is a fall.
      this.groupCooldown = duration;
    }
  }

  private advanceStep(foot: Foot, dtSeconds: number): void {
    if (!foot.stepping || foot.landingAt === null) return;

    const duration = Math.max(0.005, this.options.stepDurationMs / 1000);
    foot.stepPhase = Math.min(1, foot.stepPhase + dtSeconds / duration);
    const eased = easeInOut(foot.stepPhase);

    const from = foot.plantedAt;
    const to = foot.landingAt;
    foot.position = {
      x: from.x + (to.x - from.x) * eased,
      y: from.y + (to.y - from.y) * eased,
    };
    foot.lift = Math.sin(Math.PI * foot.stepPhase) * this.options.liftHeight;

    if (foot.stepPhase >= 1) {
      foot.stepping = false;
      foot.plantedAt = { ...to };
      foot.position = { ...to };
      foot.landingAt = null;
      foot.lift = 0;
    }
  }

  /** All feet snap back to their resting positions; used when the creature stops. */
  plantAll(transform: BodyTransform): void {
    for (const foot of this.feet) {
      const planted = toWorld(foot.limb.restTarget, transform.origin, transform.heading);
      foot.stepping = false;
      foot.stepPhase = 1;
      foot.lift = 0;
      foot.position = { ...planted };
      foot.plantedAt = { ...planted };
      foot.landingAt = null;
    }
  }

  /** Fraction of feet currently airborne (0..1); drives the body bob. */
  get airFraction(): number {
    if (this.feet.length === 0) return 0;
    let lifting = 0;
    for (const foot of this.feet) if (foot.stepping) lifting += 1;
    return lifting / this.feet.length;
  }

  /**
   * Where each foot would rest if it planted right now.
   *
   * Moving feet lead slightly ahead of the body, so the creature does not look
   * like it is reaching backwards.
   */
  private desiredTargets(
    transform: BodyTransform,
    velocity: Point,
    speed: number,
  ): Map<Foot, Point> {
    const leadSeconds = Math.min(0.18, this.rig.stride / Math.max(1, speed));
    const map = new Map<Foot, Point>();

    for (const foot of this.feet) {
      const resting = toWorld(foot.limb.restTarget, transform.origin, transform.heading);
      map.set(foot, {
        x: resting.x + velocity.x * leadSeconds,
        y: resting.y + velocity.y * leadSeconds,
      });
    }
    return map;
  }
}
