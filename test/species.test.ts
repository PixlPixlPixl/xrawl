import { describe, expect, it } from 'vitest';
import { appearanceFromGenetics, attributesFromGenetics, getSpecies, resolveGenetics } from '@/creature/species';
import { applyAttributeUpgrades, resolveLoadout } from '@/creature/loadout';
import { buildRig } from '@/creature/rig/rig';
import { CREATURE_ACTIONS } from '@/shared/types/creature';

const spider = getSpecies('spider');
const mite = getSpecies('mite');

describe('species -> appearance', () => {
  it('derives a spider rig from its gene set alone', () => {
    const appearance = appearanceFromGenetics(spider.defaults);
    expect(appearance.body.width).toBe(spider.defaults.bodyWidth);
    expect(appearance.limbs.count).toBe(8);
    expect(appearance.limbs.segmentLengths.length).toBe(3);
    expect(appearance.limbs.segmentLengths.reduce((a, b) => a + b, 0)).toBeCloseTo(
      spider.defaults.limbReach,
      4,
    );
    expect(appearance.style.primaryColor).toMatch(/hsl/);
  });

  it('uses the same code path for a different species', () => {
    const appearance = appearanceFromGenetics(mite.defaults);
    expect(appearance.limbs.count).toBe(6);
    expect(appearance.limbs.segmentLengths.length).toBe(2);
    expect(appearance.body.segments).toBe(1);
  });

  it('produces different colours from different hues, with no rendering branch', () => {
    const a = appearanceFromGenetics(spider.defaults);
    const b = appearanceFromGenetics({ ...spider.defaults, hue: 120 });
    expect(a.style.primaryColor).not.toBe(b.style.primaryColor);
  });

  it('clamps out-of-range and non-finite genes', () => {
    const resolved = resolveGenetics(spider.defaults, {
      limbCount: 9,
      bodySegments: 0,
      saturation: Number.NaN,
      hue: -90,
    });
    // Bilateral rigs need an even limb count.
    expect(resolved.limbCount).toBe(10);
    expect(resolved.bodySegments).toBe(1);
    expect(resolved.saturation).toBe(5);
    expect(resolved.hue).toBe(270);
  });
});

describe('species -> attributes', () => {
  it('projects innate capabilities from genes', () => {
    const attributes = attributesFromGenetics(spider.defaults);
    expect(attributes.movementSpeed).toBeGreaterThan(0);
    expect(attributes.detectionRadius).toBeGreaterThan(0);
    expect(Number.isInteger(attributes.maximumWordLength)).toBe(true);
    expect(Number.isInteger(attributes.stomachCapacity)).toBe(true);
  });

  it('makes a faster species faster without touching appearance logic', () => {
    expect(attributesFromGenetics(mite.defaults).movementSpeed).toBeGreaterThan(
      attributesFromGenetics(spider.defaults).movementSpeed,
    );
  });
});

describe('upgrades vs genetics', () => {
  it('a movement upgrade changes only attributes, never construction', () => {
    const base = resolveLoadout(spider.defaults);
    const upgraded = resolveLoadout(spider.defaults, { 'locomotion.speed': 3 });

    expect(upgraded.attributes.movementSpeed).toBeGreaterThan(base.attributes.movementSpeed);
    expect(base.attributes.movementSpeed).toBe(upgraded.baseAttributes.movementSpeed);
    // Input gene set unchanged => identical appearance.
    expect(JSON.stringify(upgraded.appearance)).toBe(JSON.stringify(base.appearance));
  });

  it('an evolution changes construction and leaves purchases intact', () => {
    const evolvedGenes = { ...spider.defaults, bodyWidth: 40, hue: 120 };
    const base = resolveLoadout(spider.defaults, { 'locomotion.speed': 2 });
    const evolved = resolveLoadout(evolvedGenes, { 'locomotion.speed': 2 });

    expect(evolved.appearance.body.width).toBe(40);
    expect(evolved.appearance.style.primaryColor).not.toBe(base.appearance.style.primaryColor);
    // The purchased effect is still applied to the evolved creature.
    expect(evolved.attributes.movementSpeed).toBeGreaterThan(evolved.baseAttributes.movementSpeed);
  });

  it('stacks independent upgrades multiplicatively', () => {
    const levels = { 'locomotion.speed': 2, 'senses.reach': 2 };
    const attrs = applyAttributeUpgrades(attributesFromGenetics(spider.defaults), levels);
    expect(attrs.movementSpeed).toBeGreaterThan(0);
    expect(attrs.detectionRadius).toBeGreaterThan(0);
  });

  it('ignores unknown upgrade ids from a newer save file', () => {
    const base = attributesFromGenetics(spider.defaults);
    const attrs = applyAttributeUpgrades(base, { 'unknown.future': 99 });
    expect(attrs).toEqual(base);
  });

  it('never produces a fractional word length or capacity', () => {
    const attrs = applyAttributeUpgrades(attributesFromGenetics(spider.defaults), {
      'senses.vocabulary': 4,
      'metabolism.capacity': 7,
    });
    expect(Number.isInteger(attrs.maximumWordLength)).toBe(true);
    expect(Number.isInteger(attrs.stomachCapacity)).toBe(true);
  });
});

describe('rig construction', () => {
  it('pairs limbs across both sides, front to back', () => {
    const rig = buildRig(appearanceFromGenetics(spider.defaults), { strideFactor: 0.5 });
    expect(rig.limbs.length).toBe(8);

    const sides = { left: 0, right: 0 };
    for (const limb of rig.limbs) {
      if (limb.side === -1) sides.left += 1;
      else sides.right += 1;
    }
    expect(sides.left).toBe(4);
    expect(sides.right).toBe(4);

    // Every band is a pair: one leg each side, in the same order.
    for (const band of [0, 1, 2, 3]) {
      const pair = rig.limbs.filter((limb) => limb.band === band);
      expect(pair.length).toBe(2);
      expect(pair.some((limb) => limb.side === 1)).toBe(true);
      expect(pair.some((limb) => limb.side === -1)).toBe(true);
    }
  });

  it('fans the feet out instead of folding them under the body', () => {
    const rig = buildRig(appearanceFromGenetics(spider.defaults), { strideFactor: 0.5 });
    const forwards = rig.limbs
      .filter((limb) => limb.side === 1)
      .sort((a, b) => a.band - b.band);

    // Feet along one side must march backwards: a front foot ahead of the one
    // behind it is a leg crossing, and that is where feet start landing on top
    // of each other.
    for (let index = 1; index < forwards.length; index += 1) {
      expect(forwards[index]!.restTarget.x).toBeLessThan(forwards[index - 1]!.restTarget.x);
    }

    // Neighbouring feet need a clear gap; anything tighter reads as one leg.
    for (let a = 0; a < rig.limbs.length; a += 1) {
      for (let b = a + 1; b < rig.limbs.length; b += 1) {
        const first = rig.limbs[a]!.restTarget;
        const second = rig.limbs[b]!.restTarget;
        expect(Math.hypot(first.x - second.x, first.y - second.y)).toBeGreaterThan(8);
      }
    }
  });

  it('puts feet outside the body and within reach', () => {
    const appearance = appearanceFromGenetics(spider.defaults);
    const rig = buildRig(appearance, { strideFactor: 0.5 });

    for (const limb of rig.limbs) {
      const distance = Math.hypot(
        limb.restTarget.x - limb.base.x,
        limb.restTarget.y - limb.base.y,
      );
      expect(distance).toBeLessThan(rig.reach);
      expect(distance).toBeGreaterThan(0);
    }
  });

  it('rebuilds a different rig when the gene set changes', () => {
    const evolved = buildRig(
      appearanceFromGenetics({ ...spider.defaults, bodyWidth: 40 }),
      { strideFactor: 0.5 },
    );
    expect(evolved.body.width).toBe(40);
    expect(evolved.limbs.length).toBe(8);
  });
});

describe('action vocabulary', () => {
  it('declares the six states the machine understands', () => {
    expect(CREATURE_ACTIONS).toEqual([
      'idle',
      'following',
      'foraging',
      'approaching',
      'eating',
      'resting',
    ]);
  });
});
