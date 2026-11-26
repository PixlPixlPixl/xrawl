/**
 * Copy ONNX Runtime Web's WASM binaries into the extension bundle.
 *
 * Why: MV3 extension pages may only execute their *own* scripts, so
 * transformers.js cannot import ORT's loader from a CDN. The runtime has to ship
 * with the extension, and `env.backends.onnx.wasm.wasmPaths` points at
 * `/ort/` accordingly.
 *
 * The binaries are generated, not committed: they are ~31 MB of WebAssembly that
 * a rebuild can reproduce from `node_modules` at any time. Missing binaries
 * (a trimmed install) only disable local inference; the build still succeeds.
 */
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');
const TARGET = path.join(ROOT, 'src', 'public', 'ort');

/** The two builds ORT may select: plain SIMD, and SIMD with the JSEP/WebGPU kernels. */
const PATTERN = /^ort-wasm-simd-threaded(\.jsep)?\.(mjs|wasm)$/i;

async function main() {
  let entries;
  try {
    entries = await readdir(SOURCE);
  } catch {
    console.warn('[xrawl] onnxruntime-web is not installed; skipping WASM copy.');
    return;
  }

  const files = entries.filter((name) => PATTERN.test(name));
  if (files.length === 0) {
    console.warn('[xrawl] no ort-wasm binaries found in onnxruntime-web/dist.');
    return;
  }

  await mkdir(TARGET, { recursive: true });
  for (const name of files) {
    await copyFile(path.join(SOURCE, name), path.join(TARGET, name));
  }

  console.log(`[xrawl] copied ${files.length} ONNX Runtime WASM files to src/public/ort`);
}

await main();
