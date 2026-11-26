/**
 * Companion behaviour: the creature follows the pointer at a distance.
 *
 * Deliberately plain geometry rather than a steering loop: the goal is a point
 * on the segment from the cursor to the creature, `trailing` pixels from the
 * cursor. Inside a deadzone it simply does not move, which is what stops a
 * following pet from vibrating when the mouse jitters over a link.
 *
 * Return conventions matter: `null` means "stay put" rather than "go home", so
 * the engine never interprets a stationary cursor as a destination at the
 * origin of the page.
 */
import type { Point } from './rig/fabrik';

export const COMPANION_CONFIG = {
  /** How far behind the pointer the creature tries to sit, in CSS px. */
  trailingDistancePx: 96,
  /** Do not move at all while the pointer is this close to the trailing spot. */
  deadzonePx: 14,
  /**
   * Seconds between opportunistic autonomous bites while trailing. The
   * companion eats on request; this is the "occasional" exception, and a long
   * interval keeps it from turning into a foraging creature.
   */
  autonomousEatIntervalSeconds: 14,
  /** Only words this close to the creature are candidates for that bite. */
  autonomousEatRadiusPx: 70,
  /** Trailing speed relative to the creature's movement speed. */
  followSpeedScale: 0.62,
} as const;

/**
 * Where to walk to follow the pointer, or `null` when already close enough.
 *
 * `trailing` is clamped to a sane range so a bad configuration cannot park the
 * creature on the cursor or leave it miles behind.
 */
export function companionDestination(
  pointer: Point | null | undefined,
  position: Point,
  trailing: number = COMPANION_CONFIG.trailingDistancePx,
): Point | null {
  if (pointer === null || pointer === undefined) return null;
  if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) return null;

  const gap = clampTrailing(trailing);
  const dx = position.x - pointer.x;
  const dy = position.y - pointer.y;
  const distance = Math.hypot(dx, dy);

  // Already inside the comfortable band: no destination, so no jitter.
  if (distance <= gap + COMPANION_CONFIG.deadzonePx) return null;
  const unitX = distance === 0 ? 0 : dx / distance;
  const unitY = distance === 0 ? 0 : dy / distance;

  return { x: pointer.x + unitX * gap, y: pointer.y + unitY * gap };
}

export function clampTrailing(trailing: number): number {
  if (!Number.isFinite(trailing)) return COMPANION_CONFIG.trailingDistancePx;
  return Math.min(320, Math.max(16, Math.round(trailing)));
}
