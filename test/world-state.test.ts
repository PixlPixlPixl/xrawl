/**
 * World-state tests.
 *
 * `WorldState` is the seam between perception and everything downstream: the
 * overlay, the creature, the reporter and the popup all read the same snapshot.
 * These tests lock in the two rules that make it cheap - an unchanged fingerprint
 * is a no-op, and scrolling re-derives visibility from cached document rects
 * without touching the DOM.
 */
import { describe, expect, it } from 'vitest';
import { WorldState } from '@/world/world-state';
import type { SnapshotReason } from '@/world/world-state';
import type { Rect, Viewport } from '@/shared/types/geometry';
import { computeVisibility } from '@/shared/types/geometry';
import type { WordTarget } from '@/shared/types/word-target';
import type { EnvironmentKind } from '@/shared/types/page';

function target(
  id: string,
  word: string,
  rects: readonly Rect[],
  viewport: Viewport,
  environment: EnvironmentKind = 'article',
): WordTarget {
  return {
    id,
    fingerprint: `fp-${id}`,
    text: word,
    normalized: word,
    rects,
    visibility: computeVisibility(rects, viewport),
    context: { sentence: word, surrounding: word },
    page: { url: 'https://example.com/', title: 'Example' },
    environment,
    scanOrder: 0,
    source: { nodeId: 'n1', segmentIndex: 0 },
  };
}

const VIEWPORT: Viewport = { scroll: { x: 0, y: 0 }, size: { width: 800, height: 600 } };

function setup(): { world: WorldState; reasons: SnapshotReason[] } {
  const world = new WorldState();
  const reasons: SnapshotReason[] = [];
  world.setPage({ url: 'https://example.com/', title: 'Example' });
  world.setEnvironment({ kind: 'article', confidence: 0.8, reasons: ['article element'] });
  world.setViewport(VIEWPORT);
  world.subscribe((_snapshot, reason) => reasons.push(reason));
  return { world, reasons };
}

describe('node upserts', () => {
  it('treats an identical fingerprint as a no-op', () => {
    const { world } = setup();
    const targets = [target('a', 'alpha', [{ x: 10, y: 10, width: 40, height: 18 }], VIEWPORT)];
    expect(world.upsertNode('n1', targets, 'same-key')).toBe(true);
    expect(world.commit()).toBe(true);

    const revision = world.getSnapshot().revision;
    expect(world.upsertNode('n1', targets, 'same-key')).toBe(false);
    expect(world.commit()).toBe(false);
    expect(world.getSnapshot().revision).toBe(revision);
  });

  it('bumps the revision once per changed node set', () => {
    const { world, reasons } = setup();
    world.upsertNode('n1', [target('a', 'alpha', [{ x: 0, y: 0, width: 40, height: 18 }], VIEWPORT)], 'k1');
    expect(world.commit()).toBe(true);

    world.upsertNode('n2', [target('b', 'beta', [{ x: 0, y: 40, width: 40, height: 18 }], VIEWPORT)], 'k2');
    expect(world.commit()).toBe(true);

    const snapshot = world.getSnapshot();
    expect(snapshot.revision).toBe(2);
    expect(snapshot.targets.map((entry) => entry.normalized)).toEqual(['alpha', 'beta']);
    expect(reasons).toEqual(['layout', 'layout']);
  });

  it('drops the targets of a node that produced none', () => {
    const { world } = setup();
    world.upsertNode('n1', [target('a', 'alpha', [{ x: 0, y: 0, width: 40, height: 18 }], VIEWPORT)], 'k1');
    world.commit();
    expect(world.getSnapshot().targets).toHaveLength(1);

    world.upsertNode('n1', [], 'k2');
    world.commit();
    expect(world.getSnapshot().targets).toHaveLength(0);
    expect(world.getSnapshot().stats.textNodeCount).toBe(0);
  });
});

describe('scroll path', () => {
  it('re-derives visibility without changing document rects', () => {
    const { world, reasons } = setup();
    const rect: Rect = { x: 100, y: 2_000, width: 60, height: 18 };
    world.upsertNode('n1', [target('a', 'far', [rect], VIEWPORT)], 'k1');
    world.commit();

    const before = world.getSnapshot();
    expect(before.stats.visibleInViewport).toBe(0);
    expect(before.targets[0]?.visibility.inViewport).toBe(false);

    reasons.length = 0;
    world.setViewport({ scroll: { x: 0, y: 1_900 }, size: VIEWPORT.size });

    const after = world.getSnapshot();
    expect(after.targets[0]?.rects[0]).toEqual(rect);
    expect(after.targets[0]?.visibility.inViewport).toBe(true);
    expect(after.stats.visibleInViewport).toBe(1);
    expect(reasons).toEqual(['scroll']);
  });

  it('ignores a viewport update that changes nothing', () => {
    const { world, reasons } = setup();
    reasons.length = 0;
    expect(world.setViewport(VIEWPORT)).toBe(false);
    expect(reasons).toEqual([]);
  });

  it('does not count occluded targets as visible', () => {
    const { world } = setup();
    const occluded = target('a', 'covered', [{ x: 10, y: 10, width: 40, height: 18 }], VIEWPORT);
    const visible = target('b', 'clear', [{ x: 10, y: 40, width: 40, height: 18 }], VIEWPORT);
    world.upsertNode('n1', [{ ...occluded, visibility: { ...occluded.visibility, occluded: true } }, visible], 'k1');
    world.commit();

    expect(world.getSnapshot().stats.visibleInViewport).toBe(1);
    expect(world.getSnapshot().stats.targetCount).toBe(2);
  });
});

describe('stats', () => {
  it('counts rects, targets and distinct words', () => {
    const { world } = setup();
    world.upsertNode(
      'n1',
      [
        target('a', 'alpha', [{ x: 0, y: 0, width: 40, height: 18 }], VIEWPORT),
        target('b', 'alpha', [
          { x: 50, y: 0, width: 40, height: 18 },
          { x: 0, y: 20, width: 40, height: 18 },
        ], VIEWPORT),
        target('c', 'beta', [{ x: 50, y: 40, width: 40, height: 18 }], VIEWPORT),
      ],
      'k1',
    );
    world.commit();

    const stats = world.getSnapshot().stats;
    expect(stats.targetCount).toBe(3);
    expect(stats.textNodeCount).toBe(1);
    expect(stats.rectCount).toBe(4);
    expect(stats.uniqueWordCount).toBe(2);
    expect(stats.topWords[0]).toEqual({ word: 'alpha', count: 2 });
  });

  it('keeps publishing scanner stats through a stats-only commit', () => {
    const { world, reasons } = setup();
    world.upsertNode('n1', [target('a', 'alpha', [{ x: 0, y: 0, width: 40, height: 18 }], VIEWPORT)], 'k1');
    world.commit();

    world.setBaseStats({
      passes: 4,
      lastPassKind: 'layout',
      lastPassStartedAt: 1,
      lastPassDurationMs: 2,
      lastPassNodeCount: 3,
      lastPassLimited: false,
      mutationBatches: 2,
      deferredPasses: 0,
      lastPassChanged: true,
      segmentation: { cacheSize: 1, hits: 0, misses: 1 },
    });
    expect(world.commit()).toBe(true);
    expect(reasons.at(-1)).toBe('stats');
    expect(world.getSnapshot().stats.passes).toBe(4);
    expect(world.getSnapshot().stats.lastPassKind).toBe('layout');
  });
});
