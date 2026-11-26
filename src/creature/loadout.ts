/**
 * Loadout: how genetics + purchases become a live creature.
 *
 * Two independent projections, never mixed:
 *
 *   genetics ──▶ appearance          (species construction, what evolution rewrites)
 *           └──▶ base attributes
 *   upgrades ──▶ attribute multipliers (what purchases rewrite)
 *
 * A purchase therefore can never change the body, and an evolution can never
 * silently double a stat. Both are pure functions, so a save file can be
 * re-derived at load time instead of trusting stored copies.
 */
import type { CreatureAttributes, CreatureGenetics } from '@/shared/types/creature';
import { appearanceFromGenetics, attributesFromGenetics } from './species';

/**
 * Upgrade effects are data, not branches. Every entry is a pure multiplier
 * function of level, so a new upgrade is a new entry and nothing else.
 */
export const UPGRADE_EFFECTS: Record<
  string,
  (level: number, attributes: CreatureAttributes) => Partial<CreatureAttributes>
> = {
  // Movement upgrade: the user's own example.
  'locomotion.speed': (level) => ({ movementSpeed: 1 + level * 0.18 }),
  'digestion.rate': (level) => ({ eatingSpeed: 1 + level * 0.22 }),
  'senses.reach': (level) => ({ detectionRadius: 1 + level * 0.15 }),
  'senses.vocabulary': (level) => ({ maximumWordLength: 1 + level * 0.25 }),
  'metabolism.capacity': (level) => ({ stomachCapacity: 1 + level * 0.35 }),

  // Behaviour upgrades: these change *decisions*, not the body.
  'senses.curiosity': (level) => ({ explorationRate: 1 + level * 0.25 }),
  'senses.selection': (level) => ({ travelCost: 1 / (1 + level * 0.4) }),
  'senses.semantics': (level) => ({ semanticSensitivity: 1 + level * 0.3 }),
};

const MULTIPLIED: readonly (keyof CreatureAttributes)[] = [
  'movementSpeed',
  'eatingSpeed',
  'detectionRadius',
  'maximumWordLength',
  'stomachCapacity',
  'explorationRate',
  'travelCost',
  'semanticSensitivity',
];

/**
 * Behaviour attributes are rates and weights, so they are clamped rather than
 * rounded: curiosity can never reach 100%, and intelligence can never make
 * travel free (which would make distance meaningless).
 */
const BEHAVIOUR_LIMITS: Record<string, readonly [number, number]> = {
  explorationRate: [0, 0.6],
  travelCost: [0.2, 1],
  semanticSensitivity: [0, 3],
};

/**
 * Apply purchased levels to base attributes.
 *
 * Unknown upgrade ids are ignored on purpose: a save file from a newer build
 * must not throw, it just lacks the effect until that build is installed.
 */
export function applyAttributeUpgrades(
  base: CreatureAttributes,
  levels: Readonly<Record<string, number>>,
): CreatureAttributes {
  const multipliers: Record<string, number> = {};
  for (const key of MULTIPLIED) multipliers[key] = 1;

  for (const [id, level] of Object.entries(levels)) {
    const effect = UPGRADE_EFFECTS[id];
    if (!effect || !Number.isFinite(level) || level <= 0) continue;
    const delta = effect(level, base);
    for (const key of MULTIPLIED) {
      const factor = delta[key];
      if (typeof factor === 'number' && Number.isFinite(factor)) {
        multipliers[key] *= factor;
      }
    }
  }

  const result = { ...base };
  for (const key of MULTIPLIED) {
    result[key] = base[key] * multipliers[key]!;
  }
  result.maximumWordLength = Math.max(1, Math.round(result.maximumWordLength));
  result.stomachCapacity = Math.max(1, Math.round(result.stomachCapacity));

  for (const [key, [low, high]] of Object.entries(BEHAVIOUR_LIMITS)) {
    const value = result[key as keyof CreatureAttributes];
    result[key as keyof CreatureAttributes] = Number.isFinite(value)
      ? Math.min(high, Math.max(low, value))
      : low;
  }

  return result;
}

export interface CreatureLoadout {
  readonly appearance: ReturnType<typeof appearanceFromGenetics>;
  readonly baseAttributes: CreatureAttributes;
  readonly attributes: CreatureAttributes;
}

export function resolveLoadout(
  genetics: CreatureGenetics,
  upgradeLevels: Readonly<Record<string, number>> = {},
): CreatureLoadout {
  const baseAttributes = attributesFromGenetics(genetics);
  return {
    appearance: appearanceFromGenetics(genetics),
    baseAttributes,
    attributes: applyAttributeUpgrades(baseAttributes, upgradeLevels),
  };
}
