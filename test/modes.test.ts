/**
 * Gameplay mode tests: companion trailing, foraging scoring, manual feeding.
 *
 * They pin what makes the two modes different without duplicating the
 * simulation: one engine, two selection strategies, and a travel cost that lets
 * "near and dull" beat "far and interesting" only for a creature that has not
 * bought judgement.
 */
import { describe, expect, it } from 'vitest';
import {
  FORAGE_CONFIG,
  forageScore,
  selectForageTarget,
  travelCost,
  type ForageCandidate,
  type ForagePlan,
} from '@/progression/forage';
import { isExplorationWord } from '@/progression/hunting';
import { COMPANION_CONFIG, clampTrailing, companionDestination } from '@/creature/companion';
import { CreatureEngine } from '@/creature/engine';
import { getSpecies, resolveGenetics } from '@/creature/species';
import { resolveLoadout, UPGRADE_EFFECTS } from '@/creature/loadout';
import type { ForageTarget } from '@/creature/targets';
import { UPGRADE_CATALOG } from '@/progression/upgrades';
import type { CreatureAttributes } from '@/shared/types/creature';

const spider = getSpecies('spider');
const genetics = resolveGenetics(spider.defaults);

function attributes(overrides: Partial<CreatureAttributes> = {}): CreatureAttributes {
  return { ...resolveLoadout(genetics).attributes, ...overrides };
}

/** Engine with a readable origin, so distances in assertions are obvious. */
function engine(origin = { x: 100, y: 100 }, upgrades: Record<string, number> = {}): CreatureEngine {
  const loadout = resolveLoadout(genetics, upgrades);
  return new CreatureEngine({
    appearance: loadout.appearance,
    attributes: loadout.attributes,
    gait: spider.gait,
    genetics,
    origin,
  });
}

function plan(overrides: Partial<ForagePlan> = {}): ForagePlan {
  return { rarity: 0, novelty: 0, affinity: 0, environment: 0, ...overrides };
}

function candidate(word: string, x: number, y: number, foragePlan = plan()): ForageCandidate {
  return { word, point: { x, y }, plan: foragePlan };
}

function target(
  id: string,
  point: { x: number; y: number },
  overrides: { word?: string; plan?: Partial<ForagePlan>; length?: number } = {},
): ForageTarget {
  return {
    id,
    word: overrides.word ?? 'word',
    point,
    length: overrides.length ?? 4,
    interest: 0.5,
    plan: plan(overrides.plan),
    fingerprint: `fp-${id}`,
    contextSentence: 'a sentence',
    environment: 'article',
  };
}

/** Run until a feeding happens or the budget runs out. */
function runUntilFed(
  sim: CreatureEngine,
  input: { targets: readonly ForageTarget[]; manualTargetId?: string | null; now?: number },
  budget = 400,
): ReturnType<CreatureEngine['step']> | null {
  for (let step = 0; step < budget; step += 1) {
    const result = sim.step({
      dtSeconds: 0.05,
      targets: input.targets,
      now: (input.now ?? 1_000) + step * 50,
      mode: 'foraging',
      manualTargetId: input.manualTargetId ?? null,
    });
    if (result.feeding) return result;
  }
  return null;
}

describe('travel cost', () => {
  it('rises quadratically with distance and shrinks with intelligence', () => {
    const near = travelCost(200, 400, 1);
    const far = travelCost(400, 400, 1);
    const smart = travelCost(400, 400, 0.25);

    expect(far).toBeCloseTo(near * 4, 9);
    expect(smart).toBeCloseTo(far * 0.25, 9);
    // Very far words saturate at the ceiling rather than freezing the creature
    // in place, but the ceiling is above every positive term, so they can lose.
    expect(travelCost(900, 400, 1)).toBeCloseTo(FORAGE_CONFIG.maxCost, 9);
  });
});

describe('forage score S = R + N + A + E - C', () => {
  it('adds the positive terms and subtracts the walk', () => {
    const rich = candidate('compiler', 0, 0, plan({ rarity: 1, novelty: 1, affinity: 1, environment: 1 }));
    const score = forageScore(rich, 0, attributes());

    expect(score.reward).toBeCloseTo(FORAGE_CONFIG.reward, 9);
    expect(score.novelty).toBeCloseTo(FORAGE_CONFIG.novelty, 9);
    expect(score.affinity).toBeCloseTo(FORAGE_CONFIG.affinity, 9);
    expect(score.environment).toBeCloseTo(FORAGE_CONFIG.environment, 9);
    expect(score.travel).toBe(0);
    expect(score.exploration).toBe(0);
    expect(score.score).toBeCloseTo(
      FORAGE_CONFIG.reward +
        FORAGE_CONFIG.novelty +
        FORAGE_CONFIG.affinity +
        FORAGE_CONFIG.environment,
      9,
    );
  });

  it('weighs a favourite subject over a merely rare word', () => {
    const favourite = candidate('database', 0, 0, plan({ affinity: 1 }));
    const rare = candidate('xyzzy', 0, 0, plan({ rarity: 1 }));
    // No exploration: this test is about the affinity term alone, and an
    // exploration pick would add an unrelated bonus on top.
    const attrs = attributes({ explorationRate: 0 });

    expect(forageScore(favourite, 0, attrs).score).toBeGreaterThan(forageScore(rare, 0, attrs).score);
  });

  it('lets intelligence prefer a far better word over a near dull one', () => {
    const nearDull = candidate('the', 100, 0, plan({ rarity: 0.1, novelty: 0.1 }));
    const farGood = candidate(
      'compiler',
      380,
      0,
      plan({ rarity: 1, novelty: 1, affinity: 0.8, environment: 0.6 }),
    );
    const origin = { x: 0, y: 0 };

    expect(selectForageTarget([nearDull, farGood], origin, attributes({ travelCost: 1 }))?.candidate.word).toBe(
      'the',
    );
    expect(
      selectForageTarget([nearDull, farGood], origin, attributes({ travelCost: 0.2 }))?.candidate.word,
    ).toBe('compiler');
  });

  it('keeps selection deterministic: ties keep scan order', () => {
    const picked = selectForageTarget(
      [candidate('alpha', 0, 0), candidate('beta', 0, 0)],
      { x: 0, y: 0 },
      attributes(),
    );
    expect(picked?.candidate.word).toBe('alpha');
  });

  it('only considers candidates inside the radius', () => {
    const far = candidate('compiler', 900, 0);
    expect(selectForageTarget([far], { x: 0, y: 0 }, attributes(), 100)).toBeNull();
  });

  it('awards exploration by curiosity, deterministically', () => {
    const explorer = ['compiler', 'recipe', 'zebra', 'quantum', 'garden', 'pepper'].find((word) =>
      isExplorationWord(word, 0.9),
    )!;

    const bored = attributes({ explorationRate: 0 });
    const curious = attributes({ explorationRate: 0.9 });

    expect(forageScore(candidate(explorer, 0, 0), 0, bored).exploration).toBe(0);
    expect(forageScore(candidate(explorer, 0, 0), 0, curious).exploration).toBeGreaterThan(0);
    // The same word always pays the same bonus: no clock, no random roll.
    expect(forageScore(candidate(explorer, 0, 0), 0, curious).exploration).toBe(
      forageScore(candidate(explorer, 0, 0), 0, curious).exploration,
    );
  });

  it('raises the affinity term with semantic sensitivity', () => {
    const word = candidate('database', 0, 0, plan({ affinity: 0.5 }));
    const dull = forageScore(word, 0, attributes({ semanticSensitivity: 1 }));
    const sharp = forageScore(word, 0, attributes({ semanticSensitivity: 2.5 }));
    expect(sharp.affinity).toBeGreaterThan(dull.affinity);
  });
});

describe('companion trailing', () => {
  it('aims for a point behind the pointer', () => {
    const destination = companionDestination({ x: 500, y: 100 }, { x: 100, y: 100 }, 96);
    expect(destination).not.toBeNull();
    expect(destination!.x).toBeCloseTo(404, 6);
    expect(destination!.y).toBeCloseTo(100, 6);
  });

  it('does nothing when the pointer is already inside the comfortable band', () => {
    expect(companionDestination({ x: 150, y: 100 }, { x: 100, y: 100 }, 96)).toBeNull();
    expect(companionDestination(null, { x: 100, y: 100 }, 96)).toBeNull();
  });

  it('clamps a bad trailing distance instead of trusting it', () => {
    expect(clampTrailing(-40)).toBe(16);
    expect(clampTrailing(9_999)).toBe(320);
    expect(clampTrailing(Number.NaN)).toBe(COMPANION_CONFIG.trailingDistancePx);
  });
});

describe('engine modes', () => {
  it('follows the pointer in companion mode and stops inside the band', () => {
    const sim = engine();
    sim.setMode('companion');

    const moved = sim.step({
      dtSeconds: 0.05,
      targets: [],
      now: 1_000,
      mode: 'companion',
      follow: { x: 600, y: 100 },
      trailingDistance: 96,
    });
    expect(moved.action).toBe('following');
    expect(sim.movement.position.x).toBeGreaterThan(100);

    for (let step = 0; step < 400; step += 1) {
      sim.step({
        dtSeconds: 0.05,
        targets: [],
        now: 1_000 + step * 50,
        mode: 'companion',
        follow: { x: 600, y: 100 },
        trailingDistance: 96,
      });
    }
    // Arrives near the trailing spot (600 - 96) and then holds position.
    expect(sim.movement.position.x).toBeGreaterThan(430);
    expect(sim.movement.position.x).toBeLessThan(520);
    expect(sim.movement.lastTravel).toBeLessThan(1);
  });

  it('eats a manually selected word in companion mode and reports it as manual', () => {
    const sim = engine();
    sim.setMode('companion');
    const word = target('t1', { x: 140, y: 100 }, { word: 'fox', length: 3 });

    let result: ReturnType<CreatureEngine['step']> | null = null;
    for (let step = 0; step < 300 && result === null; step += 1) {
      const stepped = sim.step({
        dtSeconds: 0.05,
        targets: [word],
        now: 1_000 + step * 50,
        mode: 'companion',
        follow: { x: 100, y: 100 },
        manualTargetId: 't1',
      });
      if (stepped.feeding) result = stepped;
    }

    expect(result?.feeding?.target.word).toBe('fox');
    expect(result?.feeding?.source).toBe('manual');
  });

  it('does not wander off to forage while trailing', () => {
    const sim = engine();
    sim.setMode('companion');
    const word = target('t1', { x: 400, y: 400 });

    for (let step = 0; step < 600; step += 1) {
      const result = sim.step({
        dtSeconds: 0.05,
        targets: [word],
        now: 1_000 + step * 50,
        mode: 'companion',
        follow: { x: 100, y: 100 },
      });
      expect(result.feeding).toBeNull();
      expect(result.action).not.toBe('foraging');
    }
  });

  it('hunts and eats on its own in foraging mode', () => {
    const sim = engine();
    const word = target('t1', { x: 150, y: 100 }, { word: 'octopus', length: 7 });
    const result = runUntilFed(sim, { targets: [word] });

    expect(result?.feeding?.target.word).toBe('octopus');
    expect(result?.feeding?.source).toBe('autonomous');
  });
});

describe('behaviour upgrades', () => {
  it('are in the catalog and have a creature-side effect', () => {
    for (const id of ['senses.curiosity', 'senses.selection', 'senses.semantics']) {
      expect(UPGRADE_CATALOG.some((upgrade) => upgrade.id === id)).toBe(true);
      expect(UPGRADE_EFFECTS[id]).toBeDefined();
    }
  });

  it('make the creature curious, decisive and preferential', () => {
    const base = resolveLoadout(genetics).attributes;
    const curious = resolveLoadout(genetics, { 'senses.curiosity': 6 }).attributes;
    const decisive = resolveLoadout(genetics, { 'senses.selection': 8 }).attributes;
    const sharp = resolveLoadout(genetics, { 'senses.semantics': 6 }).attributes;

    expect(curious.explorationRate).toBeGreaterThan(base.explorationRate);
    expect(decisive.travelCost).toBeLessThan(base.travelCost);
    expect(sharp.semanticSensitivity).toBeGreaterThan(base.semanticSensitivity);

    // Clamped: an upgrade can never make the creature 100% exploratory, nor
    // make travel free (which would erase distance from the score entirely).
    expect(curious.explorationRate).toBeLessThanOrEqual(0.6);
    expect(decisive.travelCost).toBeGreaterThanOrEqual(0.2);
    expect(sharp.semanticSensitivity).toBeLessThanOrEqual(3);
  });
});
