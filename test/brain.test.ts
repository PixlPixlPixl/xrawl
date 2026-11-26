import { describe, expect, it } from 'vitest';
import { ACTION_SPEED_SCALE, decideAction, isStationaryAction, type BrainInput } from '@/creature/brain';
import { CREATURE_ACTIONS } from '@/shared/types/creature';

function input(overrides: Partial<BrainInput> = {}): BrainInput {
  return {
    action: 'idle',
    actionElapsed: 0,
    distance: Infinity,
    hasTarget: false,
    eatProgress: 0,
    detectionRadius: 150,
    stomach: 0,
    capacity: 4,
    satiety: 0,
    digesting: false,
    manual: false,
    ...overrides,
  };
}

describe('action transitions', () => {
  it('approaches a word that is in range', () => {
    const decision = decideAction(input({ action: 'following', hasTarget: true, distance: 40 }));
    expect(decision.action).toBe('approaching');
    expect(decision.dropTarget).toBe(false);
  });

  it('eats on arrival and drops the word when done', () => {
    expect(decideAction(input({ action: 'approaching', hasTarget: true, distance: 2 })).action).toBe(
      'eating',
    );

    const finished = decideAction(
      input({ action: 'eating', hasTarget: true, distance: 0, eatProgress: 1 }),
    );
    expect(finished.action).toBe('following');
    expect(finished.dropTarget).toBe(true);
  });

  it('does not leave eating before the bite completes', () => {
    expect(decideAction(input({ action: 'eating', eatProgress: 0.4 })).action).toBe('eating');
  });

  it('rests when the stomach is full', () => {
    const decision = decideAction(
      input({ action: 'eating', eatProgress: 1, stomach: 4, capacity: 4 }),
    );
    expect(decision.action).toBe('resting');
    expect(decision.dropTarget).toBe(true);
  });

  it('follows while a target exists but is out of range', () => {
    expect(
      decideAction(input({ action: 'following', hasTarget: true, distance: 400 })).action,
    ).toBe('following');
  });

  it('forages when the word disappears after patience runs out', () => {
    expect(
      decideAction(input({ action: 'following', hasTarget: false, actionElapsed: 1 })).action,
    ).toBe('following');
    expect(
      decideAction(input({ action: 'following', hasTarget: false, actionElapsed: 5 })).action,
    ).toBe('foraging');
  });

  it('wakes from rest for a word the user picked', () => {
    // Full creature, word across the page: the machine rests, but a deliberate
    // pick must still be walked to or the click looks broken.
    const resting = decideAction(
      input({
        action: 'resting',
        hasTarget: true,
        distance: 900,
        stomach: 4,
        capacity: 4,
        satiety: 1,
      }),
    );
    expect(resting.action).toBe('resting');

    const picked = decideAction(
      input({
        action: 'resting',
        hasTarget: true,
        distance: 900,
        stomach: 4,
        capacity: 4,
        satiety: 1,
        manual: true,
      }),
    );
    expect(picked.action).toBe('approaching');
  });

  it('approaches a manual pick from idle even outside detection range', () => {
    const decision = decideAction(
      input({ action: 'idle', hasTarget: true, distance: 900, manual: true }),
    );
    expect(decision.action).toBe('approaching');
  });

  it('gives up foraging and idles', () => {
    expect(
      decideAction(input({ action: 'foraging', actionElapsed: 10, hasTarget: false })).action,
    ).toBe('idle');
  });

  it('leaves a lost target mid-approach instead of dashing', () => {
    expect(
      decideAction(input({ action: 'approaching', hasTarget: false })).action,
    ).toBe('following');

    const far = decideAction(input({ action: 'approaching', distance: 400 }));
    expect(far.action).toBe('following');
  });

  it('stays resting until digestion finishes, even with a word nearby', () => {
    expect(
      decideAction(input({ action: 'resting', hasTarget: true, distance: 30, satiety: 0.9 })).action,
    ).toBe('resting');
  });

  it('wakes from rest early only for a very close, very interesting word', () => {
    expect(
      decideAction(
        input({ action: 'resting', hasTarget: true, distance: 20, satiety: 0.2, detectionRadius: 150 }),
      ).action,
    ).toBe('approaching');
  });

  it('returns to idle once digestion empties the stomach', () => {
    expect(decideAction(input({ action: 'resting', satiety: 0.05 })).action).toBe('idle');
  });

  it('settles from idle into rest after quiet', () => {
    expect(decideAction(input({ action: 'idle', actionElapsed: 1 })).action).toBe('idle');
    expect(decideAction(input({ action: 'idle', actionElapsed: 9 })).action).toBe('resting');
  });

  it('only ever returns declared actions', () => {
    const cases = (['idle', 'following', 'foraging', 'approaching', 'eating', 'resting'] as const).flatMap(
      (action) => [
        input({ action }),
        input({ action, hasTarget: true, distance: 5 }),
        input({ action, hasTarget: true, distance: 600 }),
        input({ action, actionElapsed: 30 }),
        input({ action, eatProgress: 1, stomach: 5, capacity: 5, satiety: 1 }),
      ],
    );

    for (const caseInput of cases) {
      const result = decideAction(caseInput);
      expect(CREATURE_ACTIONS).toContain(result.action);
    }
  });
});

describe('action budgets', () => {
  it('moves only in walking states', () => {
    expect(ACTION_SPEED_SCALE.approaching).toBe(1);
    expect(ACTION_SPEED_SCALE.following).toBeGreaterThan(0);
    expect(ACTION_SPEED_SCALE.eating).toBe(0);
    expect(ACTION_SPEED_SCALE.resting).toBe(0);
    expect(ACTION_SPEED_SCALE.idle).toBe(0);
  });

  it('classifies stationary states', () => {
    expect(isStationaryAction('eating')).toBe(true);
    expect(isStationaryAction('idle')).toBe(true);
    expect(isStationaryAction('resting')).toBe(true);
    expect(isStationaryAction('approaching')).toBe(false);
  });
});
