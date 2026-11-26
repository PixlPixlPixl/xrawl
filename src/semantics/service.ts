/**
 * Semantic service: decides *once* which provider this session will use.
 *
 * The important invariant: one session, one vector space. MiniLM and the
 * lexical fallback produce vectors in different spaces, and mixing them would
 * compare apples to shipping containers. So the service waits for the model (up
 * to a timeout) and then commits either to it or to the fallback - it never
 * upgrades mid-session. Learned profiles record which model produced them, and
 * a later model change rebuilds them from scratch.
 *
 * Loading is lazy and shared: the first embedding request pays for the model,
 * every later caller awaits the same promise.
 */
import { EMBEDDING_DIMENSIONS, FALLBACK_EMBEDDING_MODEL } from '@/progression/semantics';
import { lexicalProvider } from './lexical';
import type { EmbeddingBatchStats, EmbeddingProvider } from './provider';

export type SemanticState = 'idle' | 'loading' | 'ready' | 'fallback';

export interface SemanticService {
  /** Where the service is: nothing loaded yet, loading, model, or fallback. */
  state(): SemanticState;
  /** Model id of the provider in use (or that will be used). */
  model(): string;
  /** Resolve the provider, loading the model if this is the first request. */
  prepare(): Promise<EmbeddingProvider>;
  /** Embed texts with the chosen provider, batching is the provider's job. */
  embed(texts: readonly string[]): Promise<number[][]>;
  /** Last inference batch (size, milliseconds, backend), when there was one. */
  stats(): EmbeddingBatchStats | null;
}

export interface SemanticServiceOptions {
  /** Model loader. Lazy by default: MiniLM is not touched until first use. */
  readonly load?: () => Promise<EmbeddingProvider>;
  readonly fallback?: EmbeddingProvider;
  /**
   * How long to wait for the model before committing to the fallback.
   * The load itself is not cancelled: the browser keeps filling its cache, so
   * the *next* session usually starts fast.
   */
  readonly timeoutMs?: number;
  readonly logger?: (message: string, error: unknown) => void;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export function createSemanticService(options: SemanticServiceOptions = {}): SemanticService {
  const fallback = options.fallback ?? lexicalProvider;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // The default loader imports MiniLM only when it is actually needed, so a
  // build that never embeds anything never downloads the runtime either.
  const load =
    options.load ??
    (async (): Promise<EmbeddingProvider> => (await import('./minilm')).miniLmProvider);

  let state: SemanticState = 'idle';
  let decided = false;
  let provider: EmbeddingProvider | null = null;
  let decidedPromise: Promise<EmbeddingProvider> | null = null;

  const commit = (next: EmbeddingProvider, nextState: SemanticState): EmbeddingProvider => {
    provider = next;
    state = nextState;
    decided = true;
    return next;
  };

  /**
   * The decision is made exactly once. A model that finishes loading *after*
   * the deadline already committed the fallback is discarded for this session:
   * profiles hashed in the fallback space cannot be compared with MiniLM
   * vectors, so flipping would silently reset what the creature had learned.
   * (The pipeline itself stays warm in `minilm.ts`, so the next session - or
   * the next service worker - starts on the model.)
   */
  const settle = (next: EmbeddingProvider, nextState: SemanticState): EmbeddingProvider => {
    if (decided && provider !== null) return provider;
    return commit(next, nextState);
  };

  const prepare = (): Promise<EmbeddingProvider> => {
    if (provider) return Promise.resolve(provider);
    if (decidedPromise) return decidedPromise;

    state = 'loading';
    let timer: ReturnType<typeof setTimeout> | null = null;

    const attempt = load().then(
      (loaded) => settle(loaded, 'ready'),
      (error: unknown) => {
        options.logger?.('semantic model unavailable; using lexical fallback', error);
        return settle(fallback, 'fallback');
      },
    );

    const deadline = new Promise<EmbeddingProvider>((resolve) => {
      timer = setTimeout(() => {
        if (decided) return;
        options.logger?.(`semantic model still loading after ${timeoutMs}ms; using fallback`, null);
        resolve(commit(fallback, 'fallback'));
      }, timeoutMs);
    });

    decidedPromise = Promise.race([attempt, deadline]).then((resolved) => {
      // The deadline is no longer useful once the race is over, and leaving it
      // armed keeps a service worker alive for nothing.
      if (timer !== null) clearTimeout(timer);
      timer = null;
      return resolved;
    });
    return decidedPromise;
  };

  return {
    state: () => state,
    model: () => provider?.model ?? (state === 'fallback' ? FALLBACK_EMBEDDING_MODEL : 'pending'),
    prepare,
    async embed(texts) {
      if (texts.length === 0) return [];
      const chosen = await prepare();
      if (chosen.dimensions !== EMBEDDING_DIMENSIONS) {
        throw new Error(`provider ${chosen.model} emits ${chosen.dimensions} dimensions`);
      }
      return chosen.embed(texts);
    },
    stats: () => provider?.stats?.() ?? null,
  };
}
