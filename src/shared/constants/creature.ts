/**
 * Creature tuning surface. Numbers only — no DOM, no rendering decisions.
 */
export const CREATURE_CONFIG = {
  /** Solver iterations before giving up on a pose this frame. */
  fabrikMaxIterations: 18,
  /** Acceptable foot error, in CSS px, before another iteration runs. */
  fabrikEpsilon: 0.35,

  /** Body bob amplitude in CSS px, proportional to movement speed. */
  bounceAmplitude: 1.6,

  /** How many body-widths of lead the creature keeps when following a word. */
  followLead: 0.8,
  /** Distance at which a word counts as reached, in CSS px. */
  reachEpsilon: 6,
  /** Distance at which a word counts as interesting, as a fraction of detectionRadius. */
  detectionFactor: 1,

  /** Seconds of steady movement before boredom points the creature elsewhere. */
  foragePatienceSeconds: 2.4,
  /** Stomach units digested per second while resting. */
  digestionPerSecond: 0.28,
  /** Seconds spent completing an eat, scaled by word length and eatingSpeed. */
  eatSecondsPerChar: 0.055,
  /** Seconds of idling before the creature settles into rest. */
  restAfterIdleSeconds: 5,
  /**
   * Seconds before the same word may be eaten again. Page text cannot be
   * removed, so a consumed word would otherwise be re-eaten every arrival.
   */
  eatCooldownSeconds: 25,

  /** Maximum turning rate, radians per second (keeps turns readable). */
  maxTurnRate: 7.5,
  /** Stop translating when the target is this close, in CSS px. */
  arrivalEpsilon: 2,
} as const;

