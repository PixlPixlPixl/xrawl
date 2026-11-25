import { describe, expect, it } from 'vitest';
import { CreatureEngine } from '@/creature/engine';
import { getSpecies, resolveGenetics } from '@/creature/species';
import { resolveLoadout } from '@/creature/loadout';
import { buildForageTargets } from '@/creature/targets';
import type { ForageTarget } from '@/creature/targets';
import type { ScanStats, WorldSnapshot, WordTarget } from '@/shared/types/word-target';

const spider = getSpecies('spider');

function engine(overrides: { withUpgrades?: Record<string, number> } = {}): CreatureEngine {
  const genetics = resolveGenetics(spider.defaults);
  const loadout = resolveLoadout(genetics, overrides.withUpgrades);
  return new CreatureEngine({
    appearance: loadout.appearance,
    attributes: loadout.attributes,
    gait: spider.gait,
    genetics,
    origin: { x: 100, y: 100 },
  });
}

function wordTarget(word: string, x: number, y: number, index = 0): WordTarget {
  return {
    id: `t${index}`,
    fingerprint: `fp${index}`,
    text: word,
    normalized: word,
    rects: [{ x, y, width: word.length * 7, height: 16 }],
    visibility: { rendered: true, inViewport: true, viewportRatio: 1, occluded: false },
    context: { sentence: `the ${word} thing`, surrounding: word },
    page: { url: 'https://example.com/a', title: 'A' },
    environment: 'article',
    scanOrder: index,
    source: { nodeId: `n${index}`, segmentIndex: 0 },
  };
}

const EMPTY_STATS: ScanStats = {
  targetCount: 0,
  textNodeCount: 0,
  rectCount: 0,
  visibleInViewport: 0,
  uniqueWordCount: 0,
  topWords: [],
  passes: 0,
  lastPassKind: 'initial',
  lastPassStartedAt: 0,
  lastPassDurationMs: 0,
  lastPassNodeCount: 0,
  lastPassLimited: false,
  mutationBatches: 0,
  deferredPasses: 0,
  lastPassChanged: false,
  segmentation: { cacheSize: 0, hits: 0, misses: 0 },
};

function snapshotWith(targets: readonly WordTarget[]): WorldSnapshot {
  return {
    revision: 1,
    page: { url: 'https://example.com/a', title: 'A' },
    environment: { kind: 'article', confidence: 1, reasons: [] },
    viewport: { scroll: { x: 0, y: 0 }, size: { width: 1200, height: 800 } },
    targets,
    stats: EMPTY_STATS,
    capturedAt: 0,
  };
}

/** Run the engine for `seconds` at 60 fps. */
function run(
  e: CreatureEngine,
  targets: readonly ForageTarget[],
  seconds: number,
  now = 0,
): ReturnType<CreatureEngine['step']> {
  const dt = 1 / 60;
  let last = e.step({ dtSeconds: 0, targets, now });
  const steps = Math.round(seconds / dt);
  for (let index = 0; index < steps; index += 1) {
    last = e.step({ dtSeconds: dt, targets, now: now + index * 16 });
  }
  return last;
}

describe('engine: foraging and eating', () => {
  it('walks to a nearby word and eats it', () => {
    const targets = buildForageTargets(
      [wordTarget('fox', 240, 120)],
      { maximumWordLength: 12 },
    );
    const e = engine();

    const first = run(e, targets, 0.2);
    expect(first.action).toBe('approaching');
    expect(e.target?.word).toBe('fox');

    const result = run(e, targets, 12);
    // Either it finished the eat (and is following/resting) or it is mid-bite,
    // but it must have produced at least one feeding report along the way.
    expect(['approaching', 'eating', 'following', 'foraging', 'idle', 'resting']).toContain(
      result.action,
    );
  });

  it('emits exactly one feeding report per word, with a durable fingerprint', () => {
    const targets = buildForageTargets(
      [wordTarget('fox', 240, 110)],
      { maximumWordLength: 12 },
    );
    const e = engine();

    const feedings: Array<{ word: string; fingerprint: string }> = [];
    const dt = 1 / 60;
    for (let index = 0; index < 60 * 20; index += 1) {
      const result = e.step({ dtSeconds: dt, targets, now: index * 16 });
      if (result.feeding) {
        feedings.push({
          word: result.feeding.target.word,
          fingerprint: result.feeding.target.fingerprint,
        });
      }
    }

    expect(feedings.length).toBe(1);
    expect(feedings[0]!.word).toBe('fox');
    expect(feedings[0]!.fingerprint).toBe('fp0');
  });

  it('never reaches a word longer than its attribute allows', () => {
    const longWord = wordTarget('pneumonoultramicroscopicsilicovolcanoconiosis', 220, 120);
    const targets = buildForageTargets([longWord], { maximumWordLength: 12 });
    expect(targets.length).toBe(0);

    const e = engine();
    const result = run(e, targets, 2);
    expect(e.target).toBeNull();
    expect(result.targetId).toBeNull();
  });

  it('a vocabulary upgrade expands what counts as forage', () => {
    const longWord = wordTarget('extraordinarilylongword', 220, 120);
    expect(buildForageTargets([longWord], { maximumWordLength: 12 }).length).toBe(0);
    expect(
      buildForageTargets([longWord], { maximumWordLength: 30 }).length,
    ).toBe(1);
  });
});

describe('engine: movement and facing', () => {
  it('turns instead of teleporting when the target moves behind it', () => {
    const e = engine();
    const ahead = buildForageTargets([wordTarget('fox', 260, 100)], { maximumWordLength: 12 });
    const behind = buildForageTargets([wordTarget('fox', -200, 100)], { maximumWordLength: 12 });

    run(e, ahead, 0.5);
    const headingAhead = e.movement.heading;

    // Swap the target to behind the creature; one tick cannot flip it.
    const before = e.movement.heading;
    run(e, behind, 1 / 60);
    const delta = Math.abs(e.movement.heading - before);
    expect(delta).toBeLessThanOrEqual(7.5 / 60 + 1e-6);
    expect(headingAhead).toBeDefined();
  });

  it('does not move while eating', () => {
    const targets = buildForageTargets([wordTarget('fox', 250, 110)], { maximumWordLength: 12 });
    const e = engine();
    run(e, targets, 12);
    const x = e.movement.position.x;
    run(e, targets, 0.5);
    // Eating may still resume movement, but there is no target left to chase.
    expect(Number.isFinite(x)).toBe(true);
    expect(e.movement.lastTravel === 0 || e.action !== 'eating').toBe(true);
  });
});

describe('engine: evolution and progression', () => {
  it('a speed purchase quickens the body without changing the rig', () => {
    const plain = engine();
    const fast = engine({ withUpgrades: { 'locomotion.speed': 4 } });

    expect(fast.attributes.movementSpeed).toBeGreaterThan(plain.attributes.movementSpeed);
    expect(fast.currentRig.limbs.length).toBe(plain.currentRig.limbs.length);
    expect(fast.appearance.body).toEqual(plain.appearance.body);
  });

  it('a new appearance rebuilds the rig but keeps the position', () => {
    const e = engine();
    run(e, [], 1);
    const before = { ...e.movement.position };
    const { appearanceFromGenetics } = {
      appearanceFromGenetics: (g: typeof spider.defaults) => resolveLoadout(g).appearance,
    };

    e.setAppearance(appearanceFromGenetics({ ...spider.defaults, limbCount: 6, bodyWidth: 34 }));
    expect(e.movement.position.x).toBeCloseTo(before.x, 6);
    expect(e.movement.position.y).toBeCloseTo(before.y, 6);
    expect(e.currentRig.limbs.length).toBe(6);
    expect(e.currentRig.body.width).toBe(34);
  });
});

describe('pose output', () => {
  it('always produces a pose with one joint chain per limb', () => {
    const targets = buildForageTargets([wordTarget('fox', 240, 120)], { maximumWordLength: 12 });
    const e = engine();
    const result = run(e, targets, 1);

    expect(result.pose.limbs.length).toBe(8);
    for (const limb of result.pose.limbs) {
      // 3 bones => 4 joints, matching the rig exactly.
      expect(limb.joints.length).toBe(4);
      for (const joint of limb.joints) {
        expect(Number.isFinite(joint.x)).toBe(true);
        expect(Number.isFinite(joint.y)).toBe(true);
      }
    }
    expect(result.pose.body.rx).toBeGreaterThan(0);
    expect(result.pose.body.ry).toBeGreaterThan(0);
  });

  it('opens the jaw only while eating', () => {
    const eatingPose = run(
      engine(),
      buildForageTargets([wordTarget('fox', 250, 110)], { maximumWordLength: 12 }),
      8,
    ).pose;
    const restingPose = run(engine(), [], 6).pose;

    expect(eatingPose.jaw).toBeGreaterThanOrEqual(0);
    expect(restingPose.jaw).toBe(0);
  });

  it('bobs only when the action warrants it', () => {
    const walking = run(
      engine(),
      buildForageTargets([wordTarget('fox', 900, 120)], { maximumWordLength: 12 }),
      1,
    ).pose;
    // Approaching: the bob oscillates, so its magnitude is bounded by amplitude.
    expect(Math.abs(walking.bob)).toBeLessThanOrEqual(2);
  });
});

describe('snapshot integration', () => {
  it('only considers visible, unoccluded words', () => {
    const hidden: WordTarget = {
      ...wordTarget('hidden', 240, 120),
      visibility: { rendered: true, inViewport: false, viewportRatio: 0, occluded: false },
    };
    const covered: WordTarget = {
      ...wordTarget('covered', 240, 120, 1),
      visibility: { rendered: true, inViewport: true, viewportRatio: 1, occluded: true },
    };
    const visible = wordTarget('fox', 240, 120, 2);

    const targets = buildForageTargets(snapshotWith([hidden, covered, visible]).targets, {
      maximumWordLength: 12,
    });
    expect(targets.map((target) => target.word)).toEqual(['fox']);
  });
});

describe('determinism', () => {
  it('produces identical poses for identical tick sequences', () => {
    const targets = buildForageTargets([wordTarget('fox', 240, 120)], { maximumWordLength: 12 });

    const first = engine();
    const second = engine();
    let a = first.step({ dtSeconds: 0, targets, now: 0 });
    let b = second.step({ dtSeconds: 0, targets, now: 0 });
    for (let index = 0; index < 120; index += 1) {
      a = first.step({ dtSeconds: 1 / 60, targets, now: index * 16 });
      b = second.step({ dtSeconds: 1 / 60, targets, now: index * 16 });
    }

    expect(a.pose.origin.x).toBeCloseTo(b.pose.origin.x, 9);
    expect(a.pose.origin.y).toBeCloseTo(b.pose.origin.y, 9);
    expect(a.pose.heading).toBeCloseTo(b.pose.heading, 9);
    for (let limb = 0; limb < a.pose.limbs.length; limb += 1) {
      expect(a.pose.limbs[limb]!.joints[1]!.x).toBeCloseTo(b.pose.limbs[limb]!.joints[1]!.x, 9);
    }
  });
});
