/**
 * Upgrade catalog: what word points can buy.
 *
 * Costs and limits are data, not branches. The *effects* live with the
 * creature math (creature/loadout.ts) so a purchase never touches the body and
 * an evolution never touches a stat; this module only prices those effects.
 */
import { UPGRADE_EFFECTS } from '@/creature/loadout';

export interface UpgradeDefinition {
  /** Stable key, also the row id in the upgrades table. */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: 'locomotion' | 'metabolism' | 'senses';
  readonly maxLevel: number;
  /** Word points for level 1. */
  readonly baseCost: number;
  /** Each level multiplies the previous price by this factor. */
  readonly costGrowth: number;
}

/**
 * Deliberately bounded: small levels, gentle multipliers. A player should be
 * able to buy something after a handful of discoveries, and never finish the
 * catalog in one long article.
 */
export const UPGRADE_CATALOG: readonly UpgradeDefinition[] = [
  {
    id: 'locomotion.speed',
    name: 'Quick legs',
    description: 'Move faster across the page.',
    category: 'locomotion',
    maxLevel: 8,
    baseCost: 40,
    costGrowth: 1.55,
  },
  {
    id: 'digestion.rate',
    name: 'Strong jaw',
    description: 'Finish an eaten word faster.',
    category: 'metabolism',
    maxLevel: 8,
    baseCost: 35,
    costGrowth: 1.5,
  },
  {
    id: 'metabolism.capacity',
    name: 'Bigger stomach',
    description: 'Hold more words before resting.',
    category: 'metabolism',
    maxLevel: 8,
    baseCost: 30,
    costGrowth: 1.5,
  },
  {
    id: 'senses.reach',
    name: 'Wider senses',
    description: 'Notice words from further away.',
    category: 'senses',
    maxLevel: 8,
    baseCost: 45,
    costGrowth: 1.5,
  },
  {
    id: 'senses.vocabulary',
    name: 'Longer reach',
    description: 'Eat longer words.',
    category: 'senses',
    maxLevel: 6,
    baseCost: 55,
    costGrowth: 1.6,
  },
  // Behaviour upgrades. They cost more than raw stats because they change what
  // the creature does, not only how fast it does it.
  {
    id: 'senses.curiosity',
    name: 'Curiosity',
    description: 'Try unfamiliar words more often instead of only favourites.',
    category: 'senses',
    maxLevel: 6,
    baseCost: 60,
    costGrowth: 1.6,
  },
  {
    id: 'senses.selection',
    name: 'Keen judgement',
    description: 'Weigh the walk against the word: pick better targets.',
    category: 'senses',
    maxLevel: 8,
    baseCost: 70,
    costGrowth: 1.6,
  },
  {
    id: 'senses.semantics',
    name: 'Sharp sense',
    description: 'Prefer words that resemble what it already likes.',
    category: 'senses',
    maxLevel: 6,
    baseCost: 65,
    costGrowth: 1.6,
  },
];

export function findUpgrade(id: string): UpgradeDefinition | undefined {
  return UPGRADE_CATALOG.find((upgrade) => upgrade.id === id);
}

/**
 * Price of buying a specific level (1-based). Level 1 costs the base price,
 * later levels compound. Rounded to a whole word point so balances are integers.
 */
export function upgradeCost(definition: UpgradeDefinition, level: number): number {
  const target = Math.max(1, Math.floor(level));
  return Math.round(definition.baseCost * Math.pow(definition.costGrowth, target - 1));
}

/**
 * Every catalog entry must have a creature-side effect. Checked at module load
 * so a renamed effect id fails loudly in development instead of silently
 * selling an upgrade that does nothing.
 */
export function catalogIdsWithoutEffect(): string[] {
  return UPGRADE_CATALOG.filter((upgrade) => UPGRADE_EFFECTS[upgrade.id] === undefined).map(
    (upgrade) => upgrade.id,
  );
}
