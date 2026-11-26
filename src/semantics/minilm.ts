/**
 * MiniLM on ONNX Runtime Web, loaded only when it is first needed.
 *
 * Why so defensive: the model is ~23 MB of quantized weights. Loading it at
 * extension startup would slow every browser launch for a feature most users
 * have not touched yet, so the pipeline is created on the first embedding
 * request and the browser caches the files afterwards.
 *
 * Device policy: WebGPU when the browser really exposes an adapter, otherwise
 * WASM. The user asked for Q8 as the compatibility baseline, so Q8/WASM is the
 * default and WebGPU is an accelerator, never a requirement.
 */
import type { FeatureExtractionPipeline } from '@huggingface/transformers';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '@/progression/semantics';
import type { EmbeddingBatchStats, EmbeddingProvider } from './provider';

/** Texts per forward pass. Big enough to amortise overhead, small enough to stay responsive. */
const BATCH_SIZE = 16;

let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;
/** Which backend the pipeline actually chose (not which was hoped for). */
let loadedDevice: 'wasm' | 'webgpu' = 'wasm';
/** Last batch timing, surfaced through `EmbeddingProvider.stats`. */
let lastBatch: EmbeddingBatchStats | null = null;

/** The slice of an extension runtime this module needs to resolve a path. */
export interface RuntimeLike {
  getURL?: (path: string) => string;
}

function extensionRuntime(): RuntimeLike | null {
  const globals = globalThis as {
    browser?: { runtime?: RuntimeLike };
    chrome?: { runtime?: RuntimeLike };
  };
  return globals.browser?.runtime ?? globals.chrome?.runtime ?? null;
}

/**
 * URL of the ONNX Runtime binaries shipped in `public/ort`, or null on a host
 * with no extension runtime (a bare page, a unit test).
 *
 * Both globals are checked: Chrome has no `browser` global (WXT's `browser` is
 * `chrome` there), so reading `globalThis.browser` alone left `wasmPaths`
 * unset and sent ORT to its CDN default, which the extension CSP blocks - the
 * model then failed to load and the session silently stayed on the lexical
 * fallback for every Chrome user.
 */
export function bundledOrtBase(runtime: RuntimeLike | null = extensionRuntime()): string | null {
  return typeof runtime?.getURL === 'function' ? runtime.getURL('ort/') : null;
}

async function detectDevice(): Promise<'webgpu' | 'wasm'> {
  const navigator = (globalThis as { navigator?: { gpu?: { requestAdapter(): Promise<unknown> } } })
    .navigator;
  if (!navigator?.gpu) return 'wasm';
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}

async function createPipeline(): Promise<FeatureExtractionPipeline> {
  const transformers = await import('@huggingface/transformers');
  const { env } = transformers;

  // Fetch weights from the Hub, cache them in the browser, never look for a
  // local ./models directory (the extension bundle has none).
  env.allowLocalModels = false;
  env.useBrowserCache = true;

  // WASM binaries ship inside the extension (public/ort) when the build copied
  // them; otherwise transformers.js falls back to its CDN default, which the
  // extension's own CSP refuses.
  const wasmBase = bundledOrtBase();
  const wasm = env.backends?.onnx?.wasm;
  if (wasmBase !== null && wasm) {
    wasm.wasmPaths = wasmBase;
    // One thread: the model runs inside a service worker, where ORT's thread
    // pool would need a SharedArrayBuffer and a nested worker. Single-threaded
    // WASM is the mobile-compatible baseline; WebGPU is the accelerator.
    wasm.numThreads = 1;
  }

  const device = await detectDevice();
  loadedDevice = device;

  // SAFETY: transformers.js declares `pipeline` with one overload per task, and
  // the resulting union is too complex for TypeScript to represent in this
  // position. Narrowing it to the feature-extraction factory is exact: the task
  // string is a literal and the options are the documented ones. The vectors it
  // returns are still shape-checked in `vectorsFrom` before use.
  const createFeatureExtractor = transformers.pipeline as unknown as (
    task: 'feature-extraction',
    model: string,
    options: { device: 'wasm' | 'webgpu'; dtype: 'q8' | 'fp16' },
  ) => Promise<FeatureExtractionPipeline>;

  return createFeatureExtractor('feature-extraction', EMBEDDING_MODEL, {
    device,
    // Q8 is the compatibility baseline; WebGPU gets fp16 because it does not
    // implement the same quantized kernels.
    dtype: device === 'webgpu' ? 'fp16' : 'q8',
  });
}

function pipeline(): Promise<FeatureExtractionPipeline> {
  pipelinePromise ??= createPipeline().catch((error: unknown) => {
    // Let a later call retry; a failed first load must not disable the model
    // for the rest of the session.
    pipelinePromise = null;
    throw error;
  });
  return pipelinePromise;
}

function vectorsFrom(output: unknown): number[][] {
  const candidate = output as { tolist?: () => number[][] | number[][][] };
  if (typeof candidate?.tolist === 'function') {
    const list = candidate.tolist();
    const first = Array.isArray(list[0]) ? (list as number[][]) : [(list as unknown) as number[]];
    return first.map((entry) => Array.from(entry as number[]));
  }

  const flat = output as { data?: Float32Array | number[]; dims?: number[] };
  if (flat?.data && flat.dims) {
    const dims = flat.dims;
    const width = dims[dims.length - 1] ?? EMBEDDING_DIMENSIONS;
    const rows = Math.floor(flat.data.length / Math.max(1, width));
    const vectors: number[][] = [];
    for (let row = 0; row < rows; row += 1) {
      const values: number[] = [];
      for (let column = 0; column < width; column += 1) {
        values.push(flat.data[row * width + column]!);
      }
      vectors.push(values);
    }
    return vectors;
  }

  throw new Error('MiniLM returned an unrecognised shape');
}

/** The real provider: lazy, batched, Q8 on WASM unless WebGPU is available. */
export const miniLmProvider: EmbeddingProvider = {
  model: EMBEDDING_MODEL,
  dimensions: EMBEDDING_DIMENSIONS,
  async embed(texts) {
    if (texts.length === 0) return [];
    const extractor = await pipeline();

    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += BATCH_SIZE) {
      const batch = texts.slice(start, start + BATCH_SIZE);
      const startedAt = Date.now();
      const output = await extractor(batch, { pooling: 'mean', normalize: true });
      vectors.push(...vectorsFrom(output));

      // Recorded rather than logged: the mobile budget is measured from the
      // popup's model line, without console noise.
      lastBatch = { count: batch.length, ms: Date.now() - startedAt, device: loadedDevice };
    }

    if (vectors.length !== texts.length) {
      throw new Error(`MiniLM returned ${vectors.length} vectors for ${texts.length} texts`);
    }
    return vectors;
  },
  stats: () => lastBatch,
};
