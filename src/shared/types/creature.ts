/**
 * Creature contracts shared by every layer.
 *
 * These are plain, DOM-free shapes: the engine reasons about them, the SVG
 * renderer draws them, and IndexedDB stores them. Nothing here knows about
 * browsers, Dexie, or the UI.
 *
 * Appearance and attributes are deliberately separate. Appearance is *how the
 * creature is built* (and is what evolution rewrites); attributes are *what it
 * can do* (and is what purchases rewrite). A rig build reads only appearance.
 */

/** Physical construction. Rendering and the rig derive everything from this. */
export interface CreatureBody {
  /** Body length along the forward axis, in CSS px. */
  readonly width: number;
  /** Body width across the forward axis, in CSS px. */
  readonly height: number;
  /** How many body sections to draw. */
  readonly segments: number;
}

export interface CreatureLimbs {
  /** Total limbs across both sides. Must be even for a bilateral rig. */
  readonly count: number;
  /**
   * Per-segment bone lengths. Absolute units; the rig scales them so their sum
   * equals the reach it derives from this same array.
   */
  readonly segmentLengths: readonly number[];
  /** Radius of the drawn knee/foot joint, in CSS px. */
  readonly jointSize: number;
  /** Width of the drawn limb stroke, in CSS px. */
  readonly strokeWidth: number;
}

export interface CreatureStyle {
  readonly primaryColor: string;
  readonly secondaryColor: string;
  readonly accentColor: string;
  /** 0..1 — body opacity. */
  readonly opacity: number;
  /** 0..1 — how strongly the creature advertises itself (halo strength). */
  readonly glow: number;
}

export interface CreatureAppearance {
  readonly body: CreatureBody;
  readonly limbs: CreatureLimbs;
  readonly style: CreatureStyle;
}

/**
 * How the creature decides what to eat. Companion mode follows the pointer and
 * only eats on request; foraging mode hunts on its own.
 */
export type CreatureMode = 'companion' | 'foraging';

export const CREATURE_MODES: readonly CreatureMode[] = ['companion', 'foraging'];

export const DEFAULT_CREATURE_MODE: CreatureMode = 'foraging';

export function isCreatureMode(value: unknown): value is CreatureMode {
  return value === 'companion' || value === 'foraging';
}

/** Gameplay capabilities. Progression mutates these; species seeds them. */
export interface CreatureAttributes {
  /** Body translation speed in CSS px per second. */
  readonly movementSpeed: number;
  /** How quickly an eating state completes (units per second). */
  readonly eatingSpeed: number;
  /** How far away the creature notices words, in CSS px. */
  readonly detectionRadius: number;
  /** Longest word it will go after, in characters. */
  readonly maximumWordLength: number;
  /** How many words it can hold before needing to rest. */
  readonly stomachCapacity: number;
  /**
   * Fraction of words treated as exploration picks rather than preference
   * matches. Raised by curiosity: a curious creature does not only eat what it
   * already likes.
   */
  readonly explorationRate: number;
  /**
   * Weight of travel distance when scoring targets. Lower is better selection:
   * a smart creature tolerates a longer walk for a much better word.
   */
  readonly travelCost: number;
  /**
   * How strongly learned semantic preference (A) outweighs novelty. Raised by
   * semantic sensitivity: the creature prefers words that resemble what it
   * already likes.
   */
  readonly semanticSensitivity: number;
}

/**
 * Innate numeric genes. A species supplies defaults; a creature stores a
 * partial override so a future evolution pass can rewrite proportions and hue
 * without touching appearance or attributes directly.
 */
export interface CreatureGenetics {
  readonly bodyWidth: number;
  readonly bodyHeight: number;
  readonly bodySegments: number;

  readonly limbCount: number;
  readonly limbSegments: number;
  readonly limbReach: number;
  readonly jointSize: number;
  readonly strokeWidth: number;

  /** Hue in degrees, 0..360. */
  readonly hue: number;
  readonly saturation: number;
  readonly lightness: number;
  /** Degrees to shift the accent colour off the primary hue. */
  readonly accentShift: number;

  readonly agility: number;
  readonly metabolism: number;
  readonly perception: number;
  readonly reach: number;
  readonly capacity: number;
}

/** Behaviours are discrete states, never ad-hoc branches inside the renderer. */
export type CreatureAction =
  | 'idle'
  | 'following'
  | 'foraging'
  | 'approaching'
  | 'eating'
  | 'resting';

export const CREATURE_ACTIONS: readonly CreatureAction[] = [
  'idle',
  'following',
  'foraging',
  'approaching',
  'eating',
  'resting',
];

export const DEFAULT_CREATURE_ACTION: CreatureAction = 'idle';

/**
 * Wire contract: the resolved loadout the background sends to a content script.
 *
 * Lives in shared types (not the data layer) so content-side code can depend on
 * the shape without importing the database modules.
 */
export interface CreatureLoadoutSnapshot {
  readonly creatureId: string;
  readonly name: string;
  readonly species: string;
  readonly stage: string;
  readonly genetics: CreatureGenetics;
  readonly upgradeLevels: Readonly<Record<string, number>>;
  readonly appearance: CreatureAppearance;
  readonly attributes: CreatureAttributes;
}
