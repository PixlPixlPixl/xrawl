import { describe, expect, it } from 'vitest';
import { GaitController } from '@/creature/movement/gait-controller';
import { MovementController } from '@/creature/movement/movement-controller';
import { buildRig } from '@/creature/rig/rig';
import { appearanceFromGenetics, getSpecies } from '@/creature/species';

const spider = getSpecies('spider');
const rig = buildRig(appearanceFromGenetics(spider.defaults), {
  strideFactor: spider.gait.strideFactor,
});

function gait(): GaitController {
  return new GaitController(
    rig,
    spider.gait,
    { origin: { x: 0, y: 0 }, heading: 0 },
  );
}

describe('gait controller', () => {
  it('starts with every foot planted at its rest position', () => {
    const controller = gait();
    expect(controller.feet.length).toBe(8);
    for (const foot of controller.feet) {
      expect(foot.stepping).toBe(false);
      expect(foot.lift).toBe(0);
    }
    expect(controller.airFraction).toBe(0);
  });

  it('does not step while the body is still', () => {
    const controller = gait();
    const transform = { origin: { x: 0, y: 0 }, heading: 0 };
    for (let index = 0; index < 120; index += 1) {
      controller.update(1 / 60, transform, 0);
    }
    expect(controller.airFraction).toBe(0);
  });

  it('steps when the body travels far enough', () => {
    const controller = gait();
    const movement = new MovementController({ x: 0, y: 0 }, 0);
    let sawStep = false;

    for (let index = 0; index < 240; index += 1) {
      movement.step(1 / 60, { x: 400, y: 0 }, { maxSpeed: 80, speedScale: 1 });
      const transform = { origin: { ...movement.position }, heading: movement.heading };
      controller.update(1 / 60, transform, 80);
      if (controller.airFraction > 0) sawStep = true;
    }

    expect(sawStep).toBe(true);
  });

  it('never lifts every foot at once', () => {
    const controller = gait();
    const movement = new MovementController({ x: 0, y: 0 }, 0);

    for (let index = 0; index < 600; index += 1) {
      movement.step(1 / 60, { x: 900, y: 120 }, { maxSpeed: 120, speedScale: 1 });
      const transform = { origin: { ...movement.position }, heading: movement.heading };
      controller.update(1 / 60, transform, 120);

      const airborne = controller.feet.filter((foot) => foot.stepping).length;
      expect(airborne).toBeLessThan(controller.feet.length);
    }
  });

  it('shares the stepping out over both sides of the body', () => {
    const controller = gait();
    const movement = new MovementController({ x: 0, y: 0 }, 0);
    const sidesSeenAirborne = new Set<number>();

    for (let index = 0; index < 400; index += 1) {
      movement.step(1 / 60, { x: 900, y: 0 }, { maxSpeed: 120, speedScale: 1 });
      const transform = { origin: { ...movement.position }, heading: movement.heading };
      controller.update(1 / 60, transform, 120);
      for (const foot of controller.feet) {
        if (foot.stepping) sidesSeenAirborne.add(foot.limb.side);
      }
    }

    // Both sides must step, or the body would be dragged rather than walked.
    expect(sidesSeenAirborne.size).toBe(2);
  });

  it('never lifts a mirrored pair at the same time', () => {
    const controller = gait();
    const movement = new MovementController({ x: 0, y: 0 }, 0);

    for (let index = 0; index < 300; index += 1) {
      movement.step(1 / 60, { x: 900, y: 0 }, { maxSpeed: 120, speedScale: 1 });
      const transform = { origin: { ...movement.position }, heading: movement.heading };
      controller.update(1 / 60, transform, 120);

      // Both halves of one band in the air leaves that band unsupported.
      for (const band of [0, 1, 2, 3]) {
        const airborne = controller.feet.filter(
          (foot) => foot.limb.band === band && foot.stepping,
        ).length;
        expect(airborne).toBeLessThan(2);
      }
    }
  });

  it('keeps lift within the configured arc height', () => {
    const controller = gait();
    const movement = new MovementController({ x: 0, y: 0 }, 0);

    for (let index = 0; index < 300; index += 1) {
      movement.step(1 / 60, { x: 600, y: 80 }, { maxSpeed: 100, speedScale: 1 });
      const transform = { origin: { ...movement.position }, heading: movement.heading };
      controller.update(1 / 60, transform, 100);
      for (const foot of controller.feet) {
        expect(foot.lift).toBeGreaterThanOrEqual(0);
        expect(foot.lift).toBeLessThanOrEqual(spider.gait.liftHeight + 1e-6);
      }
    }
  });

  it('plants every foot when told to stop', () => {
    const controller = gait();
    const movement = new MovementController({ x: 0, y: 0 }, 0);
    for (let index = 0; index < 120; index += 1) {
      movement.step(1 / 60, { x: 300, y: 0 }, { maxSpeed: 100, speedScale: 1 });
      controller.update(1 / 60, { origin: { ...movement.position }, heading: 0 }, 100);
    }

    controller.plantAll({ origin: { ...movement.position }, heading: 0 });
    for (const foot of controller.feet) {
      expect(foot.stepping).toBe(false);
      expect(foot.lift).toBe(0);
    }
  });

  it('steps the feet of a body that only turns', () => {
    const controller = gait();
    const origin = { x: 0, y: 0 };
    let sawStep = false;

    // Pivoting in place: no travel, only heading change. The outer feet sweep
    // the ground, so they have to step or the legs shear.
    for (let index = 0; index < 120; index += 1) {
      controller.update(1 / 60, { origin, heading: index * 0.05 }, 0);
      if (controller.airFraction > 0) sawStep = true;
    }

    expect(sawStep).toBe(true);
  });

  /**
   * Walk a straight line and a turn, returning the closest any two feet come
   * relative to the distance those two feet hold at rest.
   */
  function closestFootPair(destination: { x: number; y: number }, speed: number): number {
    const controller = gait();
    const movement = new MovementController({ x: 0, y: 0 }, 0);
    let closest = Infinity;

    for (let index = 0; index < 600; index += 1) {
      movement.step(1 / 60, destination, { maxSpeed: speed, speedScale: 1 });
      controller.update(1 / 60, { origin: { ...movement.position }, heading: movement.heading }, speed);
      if (index < 90) continue;

      for (let a = 0; a < controller.feet.length; a += 1) {
        for (let b = a + 1; b < controller.feet.length; b += 1) {
          const first = controller.feet[a]!;
          const second = controller.feet[b]!;
          const restSpacing = Math.hypot(
            first.limb.restTarget.x - second.limb.restTarget.x,
            first.limb.restTarget.y - second.limb.restTarget.y,
          );
          closest = Math.min(
            closest,
            Math.hypot(
              first.position.x - second.position.x,
              first.position.y - second.position.y,
            ) / restSpacing,
          );
        }
      }
    }

    return closest;
  }

  it('keeps the feet in their own lanes while walking', () => {
    // A leg should never be dragged most of the way onto its neighbour: below
    // half their rest spacing the picture reads as legs overlapping.
    expect(closestFootPair({ x: 2400, y: 0 }, 96)).toBeGreaterThan(0.5);
    expect(closestFootPair({ x: 2400, y: 0 }, 40)).toBeGreaterThan(0.5);
  });

  it('keeps the feet in their own lanes through a turn', () => {
    expect(closestFootPair({ x: -600, y: 400 }, 96)).toBeGreaterThan(0.5);
  });

  it('keeps at least half the legs down at every speed', () => {
    for (const speed of [20, 60, 96, 190]) {
      const controller = gait();
      const movement = new MovementController({ x: 0, y: 0 }, 0);
      for (let index = 0; index < 400; index += 1) {
        movement.step(1 / 60, { x: 2400, y: 0 }, { maxSpeed: speed, speedScale: 1 });
        controller.update(1 / 60, { origin: { ...movement.position }, heading: 0 }, speed);
        const airborne = controller.feet.filter((foot) => foot.stepping).length;
        expect(airborne).toBeLessThanOrEqual(controller.feet.length / 2);
      }
    }
  });

  it('never lets a rear leg end up ahead of a front leg on the same side', () => {
    const controller = gait();
    const movement = new MovementController({ x: 0, y: 0 }, 0);

    for (let index = 0; index < 600; index += 1) {
      movement.step(1 / 60, { x: 2400, y: 0 }, { maxSpeed: 96, speedScale: 1 });
      const transform = { origin: { ...movement.position }, heading: movement.heading };
      controller.update(1 / 60, transform, 96);
      if (index < 90) continue;

      const cos = Math.cos(transform.heading);
      const sin = Math.sin(transform.heading);
      const ahead = (position: { x: number; y: number }) =>
        (position.x - transform.origin.x) * cos + (position.y - transform.origin.y) * sin;

      for (const side of [-1, 1] as const) {
        const legs = controller.feet
          .filter((foot) => foot.limb.side === side)
          .sort((a, b) => a.limb.band - b.limb.band);
        for (let a = 0; a < legs.length; a += 1) {
          for (let b = a + 1; b < legs.length; b += 1) {
            expect(ahead(legs[b]!.position)).toBeLessThan(ahead(legs[a]!.position) + 1);
          }
        }
      }
    }
  });
});

describe('movement controller', () => {
  it('rate-limits turning', () => {
    const movement = new MovementController({ x: 0, y: 0 }, 0);
    // Destination far behind: desired heading is PI, but one tick caps the turn.
    movement.step(1 / 60, { x: -100, y: 0 }, { maxSpeed: 100, speedScale: 1 });
    expect(Math.abs(movement.heading)).toBeLessThanOrEqual(7.5 / 60 + 1e-9);
  });

  it('reports arrival at the destination', () => {
    const movement = new MovementController({ x: 0, y: 0 }, 0);
    for (let index = 0; index < 600; index += 1) {
      const result = movement.step(1 / 60, { x: 50, y: 0 }, { maxSpeed: 80, speedScale: 1 });
      if (result.arrived) return expect(result.distanceRemaining).toBeLessThan(3);
    }
    throw new Error('never arrived');
  });

  it('throttles speed while facing away so it cannot orbit', () => {
    const movement = new MovementController({ x: 0, y: 0 }, 0);
    const result = movement.step(1 / 60, { x: -100, y: 0 }, { maxSpeed: 200, speedScale: 1 });
    // Nearly backwards: alignment ~ -1 => clamped to 0, so no travel yet.
    expect(movement.lastTravel).toBeLessThan(200 / 60);
    expect(result.distanceRemaining).toBeGreaterThan(0);
  });

  it('computes the shortest signed angle difference', () => {
    expect(MovementController.angleDelta(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2);
    expect(MovementController.angleDelta(0, -Math.PI / 2)).toBeCloseTo(-Math.PI / 2);
    // 350 degrees is the same as -10 degrees, not +350.
    const wrapped = MovementController.angleDelta(0, (350 * Math.PI) / 180);
    expect(wrapped).toBeCloseTo((-10 * Math.PI) / 180, 5);
  });
});
