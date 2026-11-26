/**
 * Creature engine.
 *
 * Pure simulation. It receives plain configuration (a loadout) and plain page
 * data (forage targets), and emits a pose plus discrete events each tick.
 * No DOM, no SVG, no browser APIs, no IndexedDB — the renderer and the
 * persistence layer both consume its output.
 *
 * Composition of the three animation components:
 *
 *   MovementController   → where the body is, how it is facing
 *   GaitController       → which feet lift, where they land
 *   buildPose / FABRIK   → how the limbs actually bend
 *
 * The engine owns state, not animation. Whether a word is "in range" is decided
 * here once per tick so the renderer cannot disagree with the brain.
 */
import { CREATURE_CONFIG } from '@/shared/constants/creature';
import type {
  CreatureAction,
  CreatureAppearance,
  CreatureAttributes,
  CreatureGenetics,
} from '@/shared/types/creature';
import { resolveGenetics } from './species';
import { resolveLoadout } from './loadout';
import { ACTION_SPEED_SCALE, decideAction, isStationaryAction } from './brain';
import { MovementController } from './movement/movement-controller';
import { GaitController, type BodyTransform } from './movement/gait-controller';
import { buildPose, type CreaturePose } from './rig/pose';
import { buildRig, type CreatureRig } from './rig/rig';
import type { Point } from './rig/fabrik';
import { findBestTarget, type ForageTarget } from './targets';

export interface CreatureEngineConfig {
  readonly appearance: CreatureAppearance;
  readonly attributes: CreatureAttributes;
  readonly gait: { strideFactor: number; stepDurationMs: number; liftHeight: number };
  readonly genetics?: CreatureGenetics;
  readonly origin?: Point;
  readonly heading?: number;
}

/** What the creature ate this tick; the caller decides where it is recorded. */
export interface FeedingReport {
  readonly target: ForageTarget;
  readonly eatenAt: number;
  readonly nutrition: number;
  readonly preferenceDelta: number;
}

export interface StepInput {
  readonly dtSeconds: number;
  /** Eligible words, already in the same coordinate space as the creature. */
  readonly targets: readonly ForageTarget[];
  /** Milliseconds, injected so the engine is deterministic under test. */
  readonly now: number;
  /** 0..1 stomach fullness projection, from the persisted creature state. */
  readonly satiety?: number;
}

export interface StepResult {
  readonly pose: CreaturePose;
  readonly action: CreatureAction;
  readonly targetId: string | null;
  readonly feeding: FeedingReport | null;
  readonly arrived: boolean;
}

const MAX_DT = 0.12;

export class CreatureEngine {
  appearance: CreatureAppearance;
  attributes: CreatureAttributes;
  private readonly gaitOptions: CreatureEngineConfig['gait'];
  private rig: CreatureRig;

  readonly movement: MovementController;
  gait: GaitController;

  action: CreatureAction = 'idle';
  actionElapsed = 0;
  private eatProgress = 0;
  private stomach = 0;
  private satiety = 0;
  private time = 0;
  private currentTarget: ForageTarget | null = null;
  private digestingFor = 0;
  /** Fingerprint -> time it was eaten, so a page's words are not re-eaten. */
  private readonly eatenAt = new Map<string, number>();

  constructor(config: CreatureEngineConfig) {
    this.appearance = config.appearance;
    this.attributes = config.attributes;
    this.gaitOptions = config.gait;

    this.rig = buildRig(this.appearance, { strideFactor: this.gaitOptions.strideFactor });
    this.movement = new MovementController(
      config.origin ?? { x: 0, y: 0 },
      config.heading ?? 0,
    );
    this.gait = new GaitController(this.rig, this.gaitOptions, this.transform());
  }

  /** Purchased progression: attributes change, construction does not. */
  setAttributes(attributes: CreatureAttributes): void {
    this.attributes = attributes;
  }

  /** Evolution: construction changes, so the rig is rebuilt. */
  setAppearance(appearance: CreatureAppearance): void {
    const previousOrigin = { ...this.movement.position };
    const previousHeading = this.movement.heading;
    this.appearance = appearance;
    this.rig = buildRig(appearance, { strideFactor: this.gaitOptions.strideFactor });
    this.gait = new GaitController(this.rig, this.gaitOptions, {
      origin: previousOrigin,
      heading: previousHeading,
    });
  }

  get currentRig(): CreatureRig {
    return this.rig;
  }

  get target(): ForageTarget | null {
    return this.currentTarget;
  }

  get stomachFill(): number {
    return this.stomach;
  }

  /**
   * One simulation tick.
   *
   * `dtSeconds` is clamped so a throttled background tab cannot teleport the
   * creature across the page when frames resume.
   */
  step(input: StepInput): StepResult {
    const dt = Math.min(MAX_DT, Math.max(0, input.dtSeconds));
    this.time += dt;
    this.actionElapsed += dt;
    this.satiety = input.satiety ?? this.satiety;

    // Retire a target that vanished from the page (navigated, removed, hidden).
    if (this.currentTarget && !input.targets.some((target) => target.id === this.currentTarget!.id)) {
      this.currentTarget = null;
    }

    if (!this.currentTarget) {
      const edible = this.filterEdible(input.targets, input.now);
      // Noticing is gated by the detection radius. While actively foraging the
      // creature will also head for the nearest word anywhere on the page —
      // otherwise "foraging" would look identical to idling.
      const radius = this.attributes.detectionRadius * CREATURE_CONFIG.detectionFactor;
      const best = findBestTarget(edible, this.movement.position, radius);
      this.currentTarget =
        best?.target ??
        (this.action === 'foraging'
          ? findBestTarget(edible, this.movement.position, Infinity)?.target ?? null
          : null);
    }

    let feeding: FeedingReport | null = null;
    let arrived = false;

    if (this.action === 'eating') {
      const wordLength = this.currentTarget?.length ?? 4;
      const eatRate = 1 / Math.max(0.15, wordLength * CREATURE_CONFIG.eatSecondsPerChar);
      this.eatProgress = Math.min(1, this.eatProgress + eatRate * this.attributes.eatingSpeed * dt);

      if (this.eatProgress >= 1 && this.currentTarget) {
        this.eatenAt.set(this.currentTarget.fingerprint, input.now);
        feeding = {
          target: this.currentTarget,
          eatenAt: input.now,
          nutrition: Math.min(1, this.currentTarget.interest + 0.35),
          preferenceDelta: this.currentTarget.length / 20,
        };
        this.stomach = Math.min(this.attributes.stomachCapacity, this.stomach + 1);
        this.digestingFor = 1.6;
      }
    } else {
      this.digestingFor = Math.max(0, this.digestingFor - dt);
      // Digestion only happens at rest; it is what ends a rest, so a full
      // creature cannot loop eat/rest/approach several times a second.
      if (this.action === 'resting' && this.stomach > 0) {
        this.stomach = Math.max(0, this.stomach - CREATURE_CONFIG.digestionPerSecond * dt);
      }
    }

    const decision = decideAction({
      action: this.action,
      actionElapsed: this.actionElapsed,
      // The body stops short of the word so its head reaches the text; the
      // brain must measure the same gap, or "arrived" is unreachable.
      distance: this.currentTarget
        ? Math.max(
            0,
            Math.hypot(
              this.currentTarget.point.x - this.movement.position.x,
              this.currentTarget.point.y - this.movement.position.y,
            ) - this.rig.body.width * CREATURE_CONFIG.followLead,
          )
        : Infinity,
      hasTarget: this.currentTarget !== null,
      eatProgress: this.eatProgress,
      detectionRadius: this.attributes.detectionRadius,
      stomach: this.stomach,
      capacity: this.attributes.stomachCapacity,
      satiety: this.stomach / Math.max(1, this.attributes.stomachCapacity),
      digesting: this.digestingFor > 0,
    });

    if (decision.action !== this.action) {
      this.action = decision.action;
      this.actionElapsed = 0;
      if (decision.action === 'eating') this.eatProgress = 0;
      if (decision.dropTarget) this.currentTarget = null;
      if (isStationaryAction(decision.action)) this.gait.plantAll(this.transform());
    }

    const transform = this.transform();

    if (this.currentTarget && !isStationaryAction(this.action)) {
      const destination = lead(this.currentTarget.point, this.movement.position, this.rig.body.width);
      const result = this.movement.step(dt, destination, {
        maxSpeed: this.attributes.movementSpeed,
        speedScale: ACTION_SPEED_SCALE[this.action],
      });
      arrived = result.arrived;
    } else {
      this.movement.lastTravel = 0;
    }

    const moving = this.movement.lastTravel > 1e-3;
    if (moving) {
      this.gait.update(dt, transform, this.movement.lastTravel / Math.max(dt, 1e-4));
    } else if (this.action !== 'eating') {
      // Keep planting: a target that disappears mid-stride should not leave a
      // foot frozen in the air.
      this.gait.update(dt, transform, 0);
    }

    const pose = buildPose({
      rig: this.rig,
      appearance: this.appearance,
      origin: this.movement.position,
      heading: this.movement.heading,
      feet: this.gait.feet.map((foot) => ({
        x: foot.position.x,
        y: foot.position.y - foot.lift,
      })),
      feetState: this.gait.feet.map((foot) => ({ lift: foot.lift, stepping: foot.stepping })),
      action: this.action,
      eatProgress: this.eatProgress,
      satiety: this.stomach / Math.max(1, this.attributes.stomachCapacity),
      time: this.time,
    });

    return {
      pose,
      action: this.action,
      targetId: this.currentTarget?.id ?? null,
      feeding,
      arrived,
    };
  }

  /** Targets not still "digesting" from a previous bite. */
  private filterEdible(
    targets: readonly ForageTarget[],
    now: number,
  ): readonly ForageTarget[] {
    const cooldownMs = CREATURE_CONFIG.eatCooldownSeconds * 1000;
    let anyExcluded = false;
    for (const [fingerprint, eaten] of this.eatenAt) {
      if (now - eaten > cooldownMs) {
        this.eatenAt.delete(fingerprint);
      } else {
        anyExcluded = true;
      }
    }
    if (!anyExcluded) return targets;

    return targets.filter((target) => {
      const eaten = this.eatenAt.get(target.fingerprint);
      return eaten === undefined || now - eaten > cooldownMs;
    });
  }

  private transform(): BodyTransform {
    return { origin: this.movement.position, heading: this.movement.heading };
  }
}

/**
 * Stop short of the word so the creature's head reaches it rather than its
 * body centre landing on top of the text.
 */
function lead(destination: Point, origin: Point, bodyWidth: number): Point {
  const dx = origin.x - destination.x;
  const dy = origin.y - destination.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1e-3) return { ...destination };

  const offset = bodyWidth * CREATURE_CONFIG.followLead;
  return {
    x: destination.x + (dx / distance) * offset,
    y: destination.y + (dy / distance) * offset,
  };
}

/** Convenience for hosts that only hold genetics. */
export function createEngineFromGenetics(
  genetics: CreatureGenetics,
  gait: CreatureEngineConfig['gait'],
  upgradeLevels: Readonly<Record<string, number>> = {},
): CreatureEngine {
  const resolved = resolveGenetics(genetics);
  const loadout = resolveLoadout(resolved, upgradeLevels);
  return new CreatureEngine({
    appearance: loadout.appearance,
    attributes: loadout.attributes,
    gait,
    genetics: resolved,
  });
}
