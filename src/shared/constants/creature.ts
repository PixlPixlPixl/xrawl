/**
 * Creature tuning surface. Numbers only — no DOM, no rendering decisions.
 */
export const CREATURE_CONFIG = {
  /**
   * Solver iterations before giving up on a pose this frame. Two-bone chains
   * converge much more slowly than three-bone ones near a collinear seed, so the
   * budget is sized for the worst limb a species can have.
   */
  fabrikMaxIterations: 48,
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

  /* --- Rig geometry ------------------------------------------------------ */

  /**
   * How far the end bands of the leg fan sweep away from straight out, in
   * radians. Sweeping the *front* band backwards folds the fan under the body
   * and makes neighbouring feet compete for the same ground, so the front band
   * leans forward and the rear band leans back.
   */
  legSplay: 1,
  /**
   * Rest stance as a fraction of full limb reach. The remainder is the slack a
   * step needs: a stance at full reach leaves FABRIK nothing to bend with.
   */
  restStanceFraction: 0.7,

  /* --- Gait -------------------------------------------------------------- */

  /**
   * Speed below which the gait holds its stance instead of stepping, in CSS
   * px/s. A creature drifting this slowly would otherwise shuffle in place.
   */
  gaitMinSpeed: 4,
  /**
   * Airborne share of a gait cycle. The legs' phases are spread evenly, so a duty
   * under 0.5 is what guarantees most feet are planted at every instant.
   */
  stepDutyCycle: 0.4,
  /**
   * Shortest gait cycle, in seconds. A pivot sweeps outer feet fast enough to
   * want a cycle shorter than several frames, and a foot that lifts and plants
   * between two renders reads as a teleport rather than a step.
   */
  minCycleSeconds: 0.08,
  /**
   * Longest a foot's chain may be asked to span, as a fraction of full reach.
   * A landing target past this is pulled back so FABRIK bends a knee instead of
   * straightening the leg.
   */
  stepMaxReachFraction: 0.94,
} as const;
