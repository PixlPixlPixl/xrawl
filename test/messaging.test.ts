/**
 * Trust-boundary tests for the messaging guards.
 *
 * A content script shares a window with arbitrary page code, so every message
 * that reaches the background is re-validated there. These tests are the
 * contract: a malformed or hostile payload must be rejected *before* the
 * database sees it, and a well-formed one must never be.
 */
import { describe, expect, it } from 'vitest';
import {
  isContentRequest,
  isEnvironmentKind,
  isFeedMessage,
  isObserveMessage,
  isPrioritizeRequest,
  isSetSiteInterestRequest,
  isStatsPushMessage,
  isUpgradePurchaseRequest,
} from '@/shared/types/messaging';
import { isCreatureMode } from '@/shared/types/creature';
import type { ObserveMessage } from '@/shared/types/messaging';

function observe(overrides: Record<string, unknown> = {}): unknown {
  const payload = {
    sessionId: 'session-1',
    capturedAt: 1_700_000_000_000,
    page: { url: 'https://example.com/a', title: 'A' },
    environment: 'article',
    host: 'example.com',
    visit: true,
    activeMs: 1_000,
    words: [{ word: 'hello', count: 2 }],
    uniqueWordCount: 1,
    ...overrides,
  };
  return { type: 'xrawl/observe', payload };
}

describe('observation guards', () => {
  it('accepts a well-formed observation', () => {
    expect(isObserveMessage(observe())).toBe(true);
  });

  it('rejects an unknown environment kind', () => {
    expect(isObserveMessage(observe({ environment: 'shopping-cart' }))).toBe(false);
  });

  it('rejects a missing or empty session id', () => {
    expect(isObserveMessage(observe({ sessionId: '' }))).toBe(false);
    expect(isObserveMessage({ type: 'xrawl/observe', payload: {} })).toBe(false);
  });

  it('rejects word entries that are not {word, count}', () => {
    expect(isObserveMessage(observe({ words: [{ word: 'x' }] }))).toBe(false);
    expect(isObserveMessage(observe({ words: 'hello' }))).toBe(false);
  });

  it('rejects a payload whose page is not an object', () => {
    expect(isObserveMessage(observe({ page: 'https://example.com' }))).toBe(false);
  });

  it('rejects non-objects and wrong message types', () => {
    expect(isObserveMessage(null)).toBe(false);
    expect(isObserveMessage('xrawl/observe')).toBe(false);
    expect(isObserveMessage({ type: 'xrawl/feed', payload: {} })).toBe(false);
  });

  it('narrows to the payload shape the database expects', () => {
    const message = observe();
    expect(isObserveMessage(message)).toBe(true);
    if (!isObserveMessage(message)) return;
    const typed: ObserveMessage = message;
    expect(typed.payload.words[0]?.count).toBe(2);
  });
});

describe('feeding guards', () => {
  const base = {
    type: 'xrawl/feed',
    payload: {
      sessionId: 's',
      creatureId: 'xrawl-0',
      word: 'database',
      eatenAt: 1_700_000_000_000,
      environment: 'code',
      pageUrl: 'https://github.com/a/b',
      pageTitle: 'repo',
      contextSentence: 'the database',
      fingerprint: 'fp',
      nutrition: 0.5,
      preferenceDelta: 0.4,
    },
  };

  it('accepts a minimal feeding and defaults the source', () => {
    expect(isFeedMessage(base)).toBe(true);
    expect(isFeedMessage({ ...base, payload: { ...base.payload, source: 'manual' } })).toBe(true);
  });

  it('rejects an invented source', () => {
    expect(isFeedMessage({ ...base, payload: { ...base.payload, source: 'divine' } })).toBe(false);
  });

  it('rejects an empty word or a non-numeric reward input', () => {
    expect(isFeedMessage({ ...base, payload: { ...base.payload, word: '' } })).toBe(false);
    expect(isFeedMessage({ ...base, payload: { ...base.payload, nutrition: '0.5' } })).toBe(false);
  });
});

describe('content requests', () => {
  it('accepts the documented requests', () => {
    for (const request of [
      { type: 'xrawl/get-stats' },
      { type: 'xrawl/get-snapshot' },
      { type: 'xrawl/rescan' },
      { type: 'xrawl/download-snapshot' },
      { type: 'xrawl/set-overlay', visible: false },
      { type: 'xrawl/set-mode', mode: 'companion' },
      { type: 'xrawl/set-feeding-mode', active: true },
      { type: 'xrawl/set-trailing', distance: 120 },
    ]) {
      expect(isContentRequest(request)).toBe(true);
    }
  });

  it('rejects a bad mode, a non-boolean toggle, and a non-finite distance', () => {
    expect(isContentRequest({ type: 'xrawl/set-mode', mode: 'sleepy' })).toBe(false);
    expect(isContentRequest({ type: 'xrawl/set-overlay', visible: 'yes' })).toBe(false);
    expect(isContentRequest({ type: 'xrawl/set-trailing', distance: Number.NaN })).toBe(false);
    expect(isContentRequest({ type: 'xrawl/feed' })).toBe(false);
  });
});

describe('priority requests', () => {
  it('requires at least one word and caps word length', () => {
    expect(isPrioritizeRequest({ type: 'xrawl/prioritize', words: [] })).toBe(false);
    expect(isPrioritizeRequest({ type: 'xrawl/prioritize', words: [{ word: 'ok' }] })).toBe(true);
    expect(
      isPrioritizeRequest({ type: 'xrawl/prioritize', words: [{ word: 'x'.repeat(65) }] }),
    ).toBe(false);
  });

  it('allows an optional sentence but not a non-string one', () => {
    expect(
      isPrioritizeRequest({ type: 'xrawl/prioritize', words: [{ word: 'a', sentence: 'b' }] }),
    ).toBe(true);
    expect(
      isPrioritizeRequest({ type: 'xrawl/prioritize', words: [{ word: 'a', sentence: 2 }] }),
    ).toBe(false);
  });
});

describe('site override and purchase guards', () => {
  it('accepts null (back to automatic) and a known interest', () => {
    expect(
      isSetSiteInterestRequest({ type: 'xrawl/set-site-interest', host: 'a.com', interest: null }),
    ).toBe(true);
    expect(
      isSetSiteInterestRequest({ type: 'xrawl/set-site-interest', host: 'a.com', interest: 'technology' }),
    ).toBe(true);
  });

  it('rejects an unknown interest and an over-long host', () => {
    expect(
      isSetSiteInterestRequest({ type: 'xrawl/set-site-interest', host: 'a.com', interest: 'astrology' }),
    ).toBe(false);
    expect(
      isSetSiteInterestRequest({
        type: 'xrawl/set-site-interest',
        host: 'a'.repeat(256),
        interest: null,
      }),
    ).toBe(false);
  });

  it('requires a non-empty upgrade id', () => {
    expect(isUpgradePurchaseRequest({ type: 'xrawl/purchase-upgrade', upgradeId: 'x' })).toBe(true);
    expect(isUpgradePurchaseRequest({ type: 'xrawl/purchase-upgrade', upgradeId: '' })).toBe(false);
  });

  it('validates enum helpers used by several guards', () => {
    expect(isEnvironmentKind('docs')).toBe(true);
    expect(isEnvironmentKind('docs ')).toBe(false);
    expect(isCreatureMode('foraging')).toBe(true);
    expect(isCreatureMode('undefined')).toBe(false);
  });

  it('accepts a stats push only when it carries an object payload', () => {
    expect(isStatsPushMessage({ type: 'xrawl/stats', payload: { stats: {} } })).toBe(true);
    expect(isStatsPushMessage({ type: 'xrawl/stats', payload: null })).toBe(false);
  });
});
