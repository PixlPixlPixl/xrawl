/**
 * Movement controller: *where* the creature goes and *how it faces*.
 *
 * Knows nothing about legs. It exposes position, heading and speed, and reports
 * arrival. Turning is rate-limited so a fast target change cannot snap the
 * body around (which would look like teleporting, not crawling).
 */
import { CREATURE_CONFIG } from '@/shared/constants/creature';
import type { Point } from '../rig/fabrik';

export interface MoveOptions {
  readonly maxSpeed: number;
  /** Multiplier applied to maxSpeed for the current action (eating = 0). */
  readonly speedScale: number;
}

export interface MoveResult {
  readonly arrived: boolean;
  readonly distanceRemaining: number;
  /** Signed turn applied this tick, radians. */
  readonly turned: number;
}

export class MovementController {
  /** Mutable in place: allocated once, never replaced, so callers may hold it. */
  readonly position: { x: number; y: number };
  heading: number;
  /** Distance actually travelled this tick, in CSS px. */
  lastTravel = 0;

  constructor(start: Point, heading = 0) {
    this.position = { x: start.x, y: start.y };
    this.heading = heading;
  }

  /** Shortest signed angular difference from `from` to `to`, in radians. */
  static angleDelta(from: number, to: number): number {
    let delta = (to - from) % (Math.PI * 2);
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    return delta;
  }

  step(dtSeconds: number, destination: Point, options: MoveOptions): MoveResult {
    const dx = destination.x - this.position.x;
    const dy = destination.y - this.position.y;
    const remaining = Math.hypot(dx, dy);

    if (remaining <= CREATURE_CONFIG.arrivalEpsilon) {
      this.lastTravel = 0;
      return { arrived: true, distanceRemaining: remaining, turned: 0 };
    }

    const desiredHeading = Math.atan2(dy, dx);
    const delta = MovementController.angleDelta(this.heading, desiredHeading);
    const maxTurn = CREATURE_CONFIG.maxTurnRate * dtSeconds;
    const turned = Math.min(maxTurn, Math.abs(delta)) * Math.sign(delta);
    this.heading += turned;

    // Move along the *actual* heading, not straight at the target: the creature
    // must turn before it can commit to a new direction. Throttle by how well
    // it is facing, otherwise a rate-limited turn plus full speed becomes an
    // orbit around the target that never converges.
    const alignment = Math.max(0, Math.cos(MovementController.angleDelta(this.heading, desiredHeading)));
    const speed = Math.max(0, options.maxSpeed * options.speedScale) * alignment;
    const stepLength = Math.min(remaining, speed * dtSeconds);
    this.lastTravel = stepLength;

    if (stepLength > 0) {
      this.position.x += Math.cos(this.heading) * stepLength;
      this.position.y += Math.sin(this.heading) * stepLength;
    }

    return {
      arrived: stepLength > 0 && remaining - stepLength <= CREATURE_CONFIG.arrivalEpsilon,
      distanceRemaining: Math.max(0, remaining - stepLength),
      turned,
    };
  }

  teleport(point: Point, heading?: number): void {
    this.position.x = point.x;
    this.position.y = point.y;
    if (heading !== undefined) this.heading = heading;
  }
}
