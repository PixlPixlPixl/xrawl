/**
 * Genetics, species, and the two derived outputs.
 *
 * A species is a *default gene set plus two pure projections*: one onto
 * appearance, one onto attributes. Nothing downstream branches on species id —
 * a spider and a mite flow through exactly the same rig, gait, and renderer.
 *
 * The separation matters later: evolution rewrites genetics, purchases rewrite
 * attributes, and neither needs to know the other exists.
 */
import type {
  CreatureAppearance,
  CreatureAttributes,
  CreatureGenetics,
} from '@/shared/types/creature';

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clampHue(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return ((value % 360) + 360) % 360;
}

/** Fill a partial gene set with species defaults and clamp everything. */
export function resolveGenetics(
  defaults: CreatureGenetics,
  overrides: Partial<CreatureGenetics> = {},
): CreatureGenetics {
  const merged: CreatureGenetics = { ...defaults, ...overrides };

  return {
    bodyWidth: clamp(merged.bodyWidth, 6, 120),
    bodyHeight: clamp(merged.bodyHeight, 4, 120),
    bodySegments: Math.round(clamp(merged.bodySegments, 1, 6)),

    // A bilateral rig needs an even limb count to pair up.
    limbCount: Math.max(2, Math.round(clamp(merged.limbCount, 2, 24) / 2) * 2),
    limbSegments: Math.round(clamp(merged.limbSegments, 2, 6)),
    limbReach: clamp(merged.limbReach, 4, 120),
    jointSize: clamp(merged.jointSize, 0.5, 8),
    strokeWidth: clamp(merged.strokeWidth, 0.4, 6),

    hue: clampHue(merged.hue),
    saturation: clamp(merged.saturation, 5, 100),
    lightness: clamp(merged.lightness, 10, 90),
    accentShift: clamp(merged.accentShift, -180, 180),

    agility: clamp(merged.agility, 0, 1),
    metabolism: clamp(merged.metabolism, 0, 1),
    perception: clamp(merged.perception, 0, 1),
    reach: clamp(merged.reach, 0, 1),
    capacity: clamp(merged.capacity, 0, 1),
  };
}

function hsl(hue: number, saturation: number, lightness: number, alpha = 1): string {
  return alpha >= 1
    ? `hsl(${Math.round(hue)} ${Math.round(saturation)}% ${Math.round(lightness)}%)`
    : `hsla(${Math.round(hue)} ${Math.round(saturation)}% ${Math.round(lightness)}% / ${alpha})`;
}

/**
 * Gene set -> drawable construction. Bone lengths are *proportions* of
 * `limbReach`, distributed so the last segment is shortest (a leg tapers).
 */
export function appearanceFromGenetics(genetics: CreatureGenetics): CreatureAppearance {
  const segments = genetics.limbSegments;
  const weights: number[] = [];
  for (let index = 0; index < segments; index += 1) {
    // 0.45, 0.32, 0.23 … a gently tapering chain.
    weights.push(0.45 - index * 0.11 > 0.08 ? 0.45 - index * 0.11 : 0.08);
  }
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const segmentLengths = weights.map((weight) => (weight / total) * genetics.limbReach);

  return {
    body: {
      width: genetics.bodyWidth,
      height: genetics.bodyHeight,
      segments: genetics.bodySegments,
    },
    limbs: {
      count: genetics.limbCount,
      segmentLengths,
      jointSize: genetics.jointSize,
      strokeWidth: genetics.strokeWidth,
    },
    style: {
      primaryColor: hsl(genetics.hue, genetics.saturation, genetics.lightness),
      secondaryColor: hsl(genetics.hue, genetics.saturation, genetics.lightness - 14),
      accentColor: hsl(genetics.hue + genetics.accentShift, Math.min(100, genetics.saturation + 10), 68),
      opacity: clamp(0.55 + genetics.lightness / 200, 0.55, 1),
      glow: clamp(0.15 + genetics.saturation / 140, 0, 0.85),
    },
  };
}

/** Gene set -> innate gameplay attributes, before any purchase is applied. */
export function attributesFromGenetics(genetics: CreatureGenetics): CreatureAttributes {
  return {
    movementSpeed: 42 + genetics.agility * 88,
    eatingSpeed: 1.2 + genetics.metabolism * 3.2,
    detectionRadius: 90 + genetics.perception * 170,
    maximumWordLength: Math.round(6 + genetics.reach * 14),
    stomachCapacity: Math.round(3 + genetics.capacity * 9),
    // Behaviour genes. Perception makes the spider a slightly better chooser,
    // but these start modest: upgrades, not birth, are how a creature becomes
    // curious or decisive.
    explorationRate: 0.2 + genetics.perception * 0.1,
    travelCost: 1,
    semanticSensitivity: 1,
  };
}

export interface SpeciesDefinition {
  readonly id: string;
  readonly name: string;
  readonly defaults: CreatureGenetics;
  /** Scales stride length and step timing relative to limb reach. */
  readonly gait: {
    readonly strideFactor: number;
    readonly stepDurationMs: number;
    /** Vertical arc of a moving foot, in CSS px. */
    readonly liftHeight: number;
  };
}

const SPIDER_DEFAULTS: CreatureGenetics = {
  bodyWidth: 26,
  bodyHeight: 18,
  bodySegments: 2,

  limbCount: 8,
  limbSegments: 3,
  limbReach: 38,
  jointSize: 2.2,
  strokeWidth: 1.9,

  hue: 268,
  saturation: 62,
  lightness: 42,
  accentShift: 150,

  agility: 0.62,
  metabolism: 0.48,
  perception: 0.58,
  reach: 0.55,
  capacity: 0.4,
};

const MITE_DEFAULTS: CreatureGenetics = {
  ...SPIDER_DEFAULTS,
  bodyWidth: 16,
  bodyHeight: 13,
  bodySegments: 1,
  limbCount: 6,
  limbSegments: 2,
  limbReach: 22,
  jointSize: 1.6,
  strokeWidth: 1.4,
  hue: 32,
  saturation: 74,
  lightness: 50,
  accentShift: -40,
  agility: 0.78,
  metabolism: 0.66,
  perception: 0.4,
  reach: 0.35,
  capacity: 0.3,
};

export const SPECIES: readonly SpeciesDefinition[] = [
  {
    id: 'spider',
    name: 'Spider',
    defaults: SPIDER_DEFAULTS,
    gait: { strideFactor: 0.5, stepDurationMs: 180, liftHeight: 5 },
  },
  {
    id: 'mite',
    name: 'Mite',
    defaults: MITE_DEFAULTS,
    gait: { strideFactor: 0.55, stepDurationMs: 130, liftHeight: 3 },
  },
];

export const DEFAULT_SPECIES_ID = 'spider';

export function getSpecies(id: string): SpeciesDefinition {
  return SPECIES.find((species) => species.id === id) ?? SPECIES[0]!;
}
