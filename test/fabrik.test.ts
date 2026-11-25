import { describe, expect, it } from 'vitest';
import { chainEnd, chainLength, seedChain, solveFabrik, type Point } from '@/creature/rig/fabrik';

function chainBetween(a: Point, b: Point, lengths: readonly number[]): Point[] {
  return seedChain(a, b, lengths);
}

/** Every bone length must be preserved exactly by a solved chain. */
function assertBoneLengths(joints: readonly Point[], lengths: readonly number[]): void {
  expect(joints.length).toBe(lengths.length + 1);
  for (let index = 0; index < lengths.length; index += 1) {
    const a = joints[index]!;
    const b = joints[index + 1]!;
    const actual = Math.hypot(b.x - a.x, b.y - a.y);
    expect(actual).toBeCloseTo(lengths[index]!, 4);
  }
}

describe('solveFabrik', () => {
  const lengths = [14, 10, 8];

    it('keeps the root pinned and the foot on the target', () => {
    const root = { x: 0, y: 0 };
    const target = { x: 20, y: 9 };
    const joints = chainBetween(root, target, lengths);

    const solved = solveFabrik(joints, lengths, target, { tolerance: 0.01 });
    assertBoneLengths(solved, lengths);
    expect(solved[0]).toEqual(root);

    const foot = solved[solved.length - 1]!;
    expect(Math.hypot(foot.x - target.x, foot.y - target.y)).toBeLessThan(0.01);
  });

  it('bends the chain rather than stretching it when the target is close', () => {
    const root = { x: 0, y: 0 };
    const target = { x: 3, y: 2 }; // far inside a 32 px chain
    const joints = chainBetween(root, target, lengths);

    const solved = solveFabrik(joints, lengths, target, { tolerance: 0.01 });
    assertBoneLengths(solved, lengths);

    const foot = solved[solved.length - 1]!;
    expect(Math.hypot(foot.x - target.x, foot.y - target.y)).toBeLessThan(0.01);

    // A middle joint must sit off the root->target chord; that is the bend.
    const chordX = target.x - root.x;
    const chordY = target.y - root.y;
    const chordLength = Math.hypot(chordX, chordY);
    let maxDeviation = 0;
    for (const joint of solved.slice(1, -1)) {
      const cross = (joint.x - root.x) * chordY - (joint.y - root.y) * chordX;
      maxDeviation = Math.max(maxDeviation, Math.abs(cross) / chordLength);
    }
    expect(maxDeviation).toBeGreaterThan(1);
  });

  it('points the limb at an unreachable target without changing lengths', () => {
    const root = { x: 0, y: 0 };
    const target = { x: 200, y: 0 };
    const joints = chainBetween(root, target, lengths);

    const solved = solveFabrik(joints, lengths, target, { tolerance: 0.01 });
    assertBoneLengths(solved, lengths);

    const foot = solved[solved.length - 1]!;
    expect(foot.x).toBeCloseTo(chainLength(lengths), 4);
    expect(foot.y).toBeCloseTo(0, 6);
    // Still collinear with the target direction.
    expect(Math.abs(foot.y - root.y)).toBeLessThan(0.001);
  });

  it('is stable when the target sits exactly on the root', () => {
    const root = { x: 5, y: 5 };
    const joints = chainBetween(root, { x: 6, y: 6 }, lengths);
    const solved = solveFabrik(joints, lengths, root);
    expect(solved[0]).toEqual(root);
    expect(Number.isFinite(solved[solved.length - 1]!.x)).toBe(true);
  });

  it('rejects a mismatched joint count', () => {
    expect(() => solveFabrik([{ x: 0, y: 0 }], [10, 10], { x: 5, y: 0 })).toThrow(/expected/i);
  });

  it('is deterministic for identical inputs', () => {
    const root = { x: 0, y: 0 };
    const target = { x: 12, y: -14 };
    const joints = chainBetween(root, target, lengths);
    const first = solveFabrik(joints, lengths, target, { tolerance: 0.01 });
    const second = solveFabrik(joints, lengths, target, { tolerance: 0.01 });
    for (let index = 0; index < first.length; index += 1) {
      expect(first[index]!.x).toBeCloseTo(second[index]!.x, 9);
      expect(first[index]!.y).toBeCloseTo(second[index]!.y, 9);
    }
  });
});

describe('chain helpers', () => {
  it('sums bone lengths', () => {
    expect(chainLength([1, 2, 3])).toBe(6);
    expect(chainLength([])).toBe(0);
  });

  it('reports the end point of a straight chain', () => {
    const end = chainEnd({ x: 0, y: 0 }, [3, 4], Math.PI / 2);
    expect(end.x).toBeCloseTo(0, 6);
    expect(end.y).toBeCloseTo(7, 6);
  });
});
