/**
 * Semantic service tests.
 *
 * The invariant under test is "one session, one vector space": once the service
 * has committed - to the model or to the lexical fallback - nothing that arrives
 * later may replace it, because profiles learned in one space cannot be compared
 * with vectors from another.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSemanticService } from '@/semantics/service';
import { bundledOrtBase } from '@/semantics/minilm';
import type { EmbeddingProvider } from '@/semantics/provider';

function provider(model: string, vectors: number[][] = [[1, 0]]): EmbeddingProvider {
  return {
    model,
    dimensions: 384,
    embed: async (texts) => texts.map((_, index) => vectors[index % vectors.length] ?? [1, 0]),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('bundledOrtBase', () => {
  it('resolves the ORT directory through the extension runtime', () => {
    expect(
      bundledOrtBase({ getURL: (path: string) => `chrome-extension://abc/${path}` }),
    ).toBe('chrome-extension://abc/ort/');
  });

  it('returns null when there is no runtime (a test, a bare page)', () => {
    expect(bundledOrtBase(null)).toBeNull();
    expect(bundledOrtBase({})).toBeNull();
  });

  it('reads the global the host actually exposes', () => {
    // Chrome has no `browser` global; the helper must fall through to `chrome`.
    const globals = globalThis as { chrome?: { runtime?: { getURL?: (p: string) => string } } };
    const previous = globals.chrome;
    globals.chrome = { runtime: { getURL: (path: string) => `chrome-extension://xyz/${path}` } };
    try {
      expect(bundledOrtBase()).toBe('chrome-extension://xyz/ort/');
    } finally {
      if (previous === undefined) delete globals.chrome;
      else globals.chrome = previous;
    }
  });
});

describe('provider selection', () => {
  it('commits to the model when it loads in time', async () => {
    const service = createSemanticService({ load: async () => provider('model-a') });
    await expect(service.prepare()).resolves.toMatchObject({ model: 'model-a' });
    expect(service.state()).toBe('ready');
    expect(service.model()).toBe('model-a');
  });

  it('falls back when the model rejects', async () => {
    const service = createSemanticService({
      load: async () => {
        throw new Error('offline');
      },
      logger: () => undefined,
    });
    const chosen = await service.prepare();
    expect(chosen.model).toBe('xrawl/lexical-384');
    expect(service.state()).toBe('fallback');
  });

  it('does not flip to a model that finishes after the deadline', async () => {
    vi.useFakeTimers();
    let finish: (value: EmbeddingProvider) => void = () => undefined;
    const slow = new Promise<EmbeddingProvider>((resolve) => {
      finish = resolve;
    });
    const service = createSemanticService({
      load: () => slow,
      timeoutMs: 1_000,
      logger: () => undefined,
    });

    const pending = service.prepare();
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(pending).resolves.toMatchObject({ model: 'xrawl/lexical-384' });
    expect(service.state()).toBe('fallback');

    // The model finally arrives. The space is already committed for this
    // session, so the promise keeps resolving to the fallback.
    finish(provider('model-late'));
    await Promise.resolve();
    await Promise.resolve();
    await expect(service.prepare()).resolves.toMatchObject({ model: 'xrawl/lexical-384' });
    expect(service.state()).toBe('fallback');
    expect(service.model()).toBe('xrawl/lexical-384');
  });

  it('reuses one provider for every caller', async () => {
    let loads = 0;
    const service = createSemanticService({
      load: async () => {
        loads += 1;
        return provider('model-a');
      },
    });
    await Promise.all([service.prepare(), service.prepare(), service.prepare()]);
    expect(loads).toBe(1);
  });
});

describe('embedding and stats', () => {
  it('returns an empty list for no input, without loading anything', async () => {
    let loads = 0;
    const service = createSemanticService({
      load: async () => {
        loads += 1;
        return provider('model-a');
      },
    });
    await expect(service.embed([])).resolves.toEqual([]);
    expect(loads).toBe(0);
  });

  it('rejects a provider whose width disagrees with the vector space', async () => {
    const service = createSemanticService({
      load: async () => ({ ...provider('bad'), dimensions: 12 }),
    });
    await expect(service.embed(['hello'])).rejects.toThrow(/dimensions/);
  });

  it('reports the last batch when the provider measures one', async () => {
    const withStats: EmbeddingProvider = {
      ...provider('model-a'),
      stats: () => ({ count: 16, ms: 240, device: 'wasm' }),
    };
    const service = createSemanticService({ load: async () => withStats });
    expect(service.stats()).toBeNull();
    await service.embed(['a']);
    expect(service.stats()).toEqual({ count: 16, ms: 240, device: 'wasm' });
  });
});
