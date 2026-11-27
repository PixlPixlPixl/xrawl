/**
 * Gait controller: *when* each foot lifts, *where* it lands, and *when* it plants.
 *
 * The controller owns per-foot world positions. It knows the rig (how many limbs,
 * where their bases and rest targets are) and the body transform, but it never
 * bends a limb — it only chooses foot targets. FABRIK runs later.
 *
 * Protocol:
 *  - Every foot runs one gait cycle at its own phase. Phase 0 is the instant a
 *    foot lifts: `0..duty` is airborne, `duty..1` is planted. Offsets are spread
 *    evenly over the legs, one side rippling rear-to-front and the other side
 *    half a cycle later, so the legs take turns, the wave travels frontwards, and
 *    the two sides of a band never lift together.
 *  - The cycle lasts exactly as long as the body needs to carry one foot one
 *    stride, and turning counts: a pivot sweeps the outer feet much faster than
 *    the body travels. That is what keeps every foot near its own stance; a
 *    longer cycle lets feet fall behind and pile up.
 *  - Feet plant in world space, so the body drags a planted foot for its whole
 *    stance. That drag is what makes the body look pulled by the legs rather than
 *    sliding.
 *  - A landing point is that leg's rest target on the body as it will be when the
 *    foot lands. A foot that lifts half a drag behind its stance and lands half a
 *    drag ahead swings symmetrically around it, which keeps each leg in its own
 *    lane; aiming at the current body leaves every foot a drag short, and aiming a
 *    whole stance ahead aims all of them at one patch of ground.
 */
import { CREATURE_CONFIG } from '@/shared/constants/creature';
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
  /** 0..1 position in the foot's own cycle; 0 is the instant after liftoff. */
  phase: number;
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

/** Shortest signed angular difference between two headings, radians. */
function angleDelta(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

export class GaitController {
  readonly feet: Foot[];
  readonly rig: CreatureRig;
  private readonly options: GaitOptions;
  /** Liftoff phase of each foot, indexed by limb index. */
  private readonly offsets: readonly number[];
  /** Furthest a rest foot sits from the body centre; the radius a pivot sweeps. */
  private readonly leverArm: number;
  private lastHeading: number;

  constructor(rig: CreatureRig, options: GaitOptions, transform: BodyTransform) {
    this.rig = rig;
    this.options = options;
    this.lastHeading = transform.heading;
    this.offsets = waveOffsets(rig.limbs);
    this.leverArm = rig.limbs.reduce(
      (max, limb) => Math.max(max, Math.hypot(limb.restTarget.x, limb.restTarget.y)),
      0,
    );

    this.feet = rig.limbs.map((limb, index) => {
      const planted = toWorld(limb.restTarget, transform.origin, transform.heading);
      return {
        limb,
        position: { ...planted },
        plantedAt: { ...planted },
        landingAt: null,
        stepping: false,
        phase: this.restPhase(index),
        lift: 0,
      };
    });
  }

  /**
   * Advance the gait. `speed` is the body's speed in CSS px/s; the turn rate comes
   * from the heading change, so a pivot steps its feet even with the body still.
   */
  update(dtSeconds: number, transform: BodyTransform, speed: number): void {
    const dt = Math.max(1e-4, dtSeconds);
    const turnRate = angleDelta(this.lastHeading, transform.heading) / dt;
    this.lastHeading = transform.heading;

    const surface = speed + Math.abs(turnRate) * this.leverArm;
    if (surface <= CREATURE_CONFIG.gaitMinSpeed) {
      // Standing: land anything still in the air rather than freeze it there.
      for (const foot of this.feet) {
        if (foot.stepping) this.plant(foot);
      }
      return;
    }

    const cycle = this.cycleFor(this.rig.stride / surface);
    const duty = this.dutyFor(cycle, dt);
    const targets = this.landingTargets(transform, speed, turnRate, cycle, duty);

    this.feet.forEach((foot, index) => {
      foot.phase += dt / cycle;
      if (foot.phase >= 1) {
        foot.phase -= Math.floor(foot.phase);
        this.liftOff(foot, targets[index]!, transform);
      }
      if (!foot.stepping) return;
      if (foot.phase >= duty) this.plant(foot);
      else this.raise(foot, duty);
    });
  }

  /** All feet snap back to their resting positions; used when the creature stops. */
  plantAll(transform: BodyTransform): void {
    this.lastHeading = transform.heading;
    this.feet.forEach((foot, index) => {
      const planted = toWorld(foot.limb.restTarget, transform.origin, transform.heading);
      foot.stepping = false;
      foot.lift = 0;
      foot.position = { ...planted };
      foot.plantedAt = { ...planted };
      foot.landingAt = null;
      foot.phase = this.restPhase(index);
    });
  }

  /** Fraction of feet currently airborne (0..1). */
  get airFraction(): number {
    if (this.feet.length === 0) return 0;
    let lifting = 0;
    for (const foot of this.feet) if (foot.stepping) lifting += 1;
    return lifting / this.feet.length;
  }

  private liftOff(foot: Foot, target: Point, transform: BodyTransform): void {
    // A step that never landed is replaced, not stacked on top of: the foot is
    // already standing where the previous step was taking it.
    if (foot.landingAt !== null) this.plant(foot);
    foot.stepping = true;
    foot.plantedAt = { ...foot.position };
    foot.landingAt = this.withinReach(target, foot.limb, transform);
  }

  /**
   * Keep a landing point inside the leg's reach.
   *
   * The rest stance already spends most of the chain, so a projected landing point
   * can ask for more than the bones have, and FABRIK would answer by straightening
   * the leg. The target is moved fully back onto the reach limit, not just nudged:
   * a partly corrected target still leaves a straight leg on the next frame.
   */
  private withinReach(target: Point, limb: LimbRig, transform: BodyTransform): Point {
    const base = toWorld(limb.base, transform.origin, transform.heading);
    const limit = this.rig.reach * CREATURE_CONFIG.stepMaxReachFraction;
    const dx = target.x - base.x;
    const dy = target.y - base.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= limit || distance < 1e-6) return target;

    return {
      x: base.x + (dx / distance) * limit,
      y: base.y + (dy / distance) * limit,
    };
  }

  private raise(foot: Foot, duty: number): void {
    if (foot.landingAt === null) return;
    const t = Math.min(1, foot.phase / duty);
    const eased = easeInOut(t);
    foot.position = {
      x: foot.plantedAt.x + (foot.landingAt.x - foot.plantedAt.x) * eased,
      y: foot.plantedAt.y + (foot.landingAt.y - foot.plantedAt.y) * eased,
    };
    foot.lift = Math.sin(Math.PI * t) * this.options.liftHeight;
  }

  private plant(foot: Foot): void {
    if (foot.landingAt !== null) {
      foot.position = { ...foot.landingAt };
      foot.plantedAt = { ...foot.landingAt };
      foot.landingAt = null;
    }
    foot.stepping = false;
    foot.lift = 0;
  }

  /** A planted phase at the start of the foot's stance, just before its slot. */
  private restPhase(index: number): number {
    return (1 - this.offsets[index]!) % 1;
  }

  /**
   * Airborne share of the cycle.
   *
   * A step should last the species' step duration when the cycle allows it, but it
   * must also survive the frame rate: a window shorter than a frame would lift and
   * plant a foot between two renders, so the foot would appear to teleport. The
   * cap keeps a majority of the legs down, which is what makes the gait read as a
   * crawl instead of a shimmer.
   */
  private dutyFor(cycle: number, dt: number): number {
    const wanted = Math.max(this.options.stepDurationMs / 1000, dt * 2) / cycle;
    return Math.min(CREATURE_CONFIG.stepDutyCycle, wanted);
  }

  /** Keep a cycle long enough for the swing to be visible across several frames. */
  private cycleFor(naturalCycle: number): number {
    return Math.max(CREATURE_CONFIG.minCycleSeconds, naturalCycle);
  }

  /**
   * Landing point per foot: its rest target on the body as it will be when the
   * foot lands. The body travels for the whole airborne window before that, so the
   * projection covers the airborne time and lands a drag-half ahead of the stance
   * the foot lifts from.
   */
  private landingTargets(
    transform: BodyTransform,
    speed: number,
    turnRate: number,
    cycle: number,
    duty: number,
  ): Point[] {
    const seconds = cycle * duty;

    const projected: BodyTransform = {
      origin: {
        x: transform.origin.x + Math.cos(transform.heading) * speed * seconds,
        y: transform.origin.y + Math.sin(transform.heading) * speed * seconds,
      },
      heading: transform.heading + turnRate * seconds,
    };

    return this.feet.map((foot) =>
      toWorld(foot.limb.restTarget, projected.origin, projected.heading),
    );
  }
}

/**
 * Liftoff phase of each foot, spread evenly over the cycle.
 *
 * One side ripples from rear to front, and the other side runs the same ripple
 * half a cycle later. The two sides of a band then lift half a cycle apart, so a
 * band is never unsupported on both sides at once, and the crest of the wave
 * visibly travels frontwards along each side — which is how a real spider walks.
 * Neighbouring legs on the same side overlap, as they do on a spider; they are a
 * stride apart on the ground, so they never share a patch of it.
 */
function waveOffsets(limbs: readonly LimbRig[]): number[] {
  const rear = limbs.reduce((max, limb) => Math.max(max, limb.band), 0);
  const bands = Math.max(1, Math.round(limbs.length / 2));
  const slots = bands * 2;
  return limbs.map((limb) => {
    const along = rear - limb.band;
    const slot = limb.side === -1 ? along : along + bands;
    return (slot % slots) / slots;
  });
}
