/**
 * Action machine: the single source of truth for what the creature is doing.
 *
 * Transitions are a pure function of the current action plus a small context.
 * The renderer never decides anything: it draws the frame it is given, and the
 * engine only delegates motion to the movement/gait controllers.
 *
 * ```
 *   idle ──word in range──▶ approaching ──within reach──▶ eating ──done──▶ following
 *     ▲                          ▲                                            │
 *     │                          └──────────── word in range ────────────────┘
 *     │                                                                       │
 *     ├──quiet──▶ resting ──word in range──▶ approaching                      │
 *     └──quiet──▶ foraging ──word in range──▶ approaching ◀───────────────────┘
 * ```
 */
import { CREATURE_CONFIG } from '@/shared/constants/creature';
import type { CreatureAction } from '@/shared/types/creature';

export interface BrainInput {
  readonly action: CreatureAction;
  /** Seconds spent in the current action. */
  readonly actionElapsed: number;
  /** Distance to the current target, or `Infinity` when there is none. */
  readonly distance: number;
  /** Whether a target exists at all right now. */
  readonly hasTarget: boolean;
  /** 0..1 progress of an eat. */
  readonly eatProgress: number;
  readonly detectionRadius: number;
  /** Units currently held. */
  readonly stomach: number;
  readonly capacity: number;
  /** 0..1 fullness; resting lasts until it decays. */
  readonly satiety: number;
  /** True while a target was eaten and is digesting. */
  readonly digesting: boolean;
}

export interface BrainDecision {
  readonly action: CreatureAction;
  /** Target must be dropped on this transition (an eaten word, a lost one). */
  readonly dropTarget: boolean;
}

function stay(action: CreatureAction): BrainDecision {
  return { action, dropTarget: false };
}

export function decideAction(input: BrainInput): BrainDecision {
  const inRange = input.hasTarget && input.distance <= input.detectionRadius;

  switch (input.action) {
    case 'eating':
      if (input.eatProgress < 1) return stay('eating');
      if (input.stomach >= input.capacity || input.satiety >= 0.85) {
        return { action: 'resting', dropTarget: true };
      }
      return { action: 'following', dropTarget: true };

    case 'approaching':
      if (!input.hasTarget) return { action: 'following', dropTarget: true };
      if (input.distance <= CREATURE_CONFIG.reachEpsilon) return stay('eating');
      // The word vanished or was replaced by something far away: stop dashing.
      if (input.distance > input.detectionRadius * 1.6) return stay('following');
      return stay('approaching');

    case 'following':
      if (!input.hasTarget) {
        return input.actionElapsed > CREATURE_CONFIG.foragePatienceSeconds
          ? { action: 'foraging', dropTarget: false }
          : stay('following');
      }
      if (inRange) return stay('approaching');
      return stay('following');

    case 'foraging':
      if (inRange) return stay('approaching');
      if (input.actionElapsed > CREATURE_CONFIG.foragePatienceSeconds * 1.5) {
        return { action: 'idle', dropTarget: false };
      }
      return stay('foraging');

    case 'idle':
      if (inRange) return stay('approaching');
      if (input.actionElapsed > CREATURE_CONFIG.restAfterIdleSeconds) {
        return { action: 'resting', dropTarget: false };
      }
      return stay('idle');

    case 'resting':
      // Rest is about digestion, not proximity: waking the moment a word
      // appears would make a full creature oscillate rest/approach forever.
      // A very close, very interesting word can still rouse it early.
      if (input.satiety < 0.35 && inRange && input.distance < input.detectionRadius * 0.4) {
        return stay('approaching');
      }
      if (input.satiety < 0.2) return stay('idle');
      return stay('resting');

    default:
      return stay('idle');
  }
}

/**
 * Movement budget per action. Kept next to the machine so "what the creature
 * does" and "how fast it does it" cannot drift apart.
 */
export const ACTION_SPEED_SCALE: Record<CreatureAction, number> = {
  idle: 0,
  following: 0.55,
  foraging: 0.45,
  approaching: 1,
  eating: 0,
  resting: 0,
};

/** Actions in which the feet should be planted rather than walking. */
export function isStationaryAction(action: CreatureAction): boolean {
  return action === 'idle' || action === 'eating' || action === 'resting';
}
