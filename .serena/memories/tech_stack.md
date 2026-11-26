# Tech stack

- TypeScript (strict, `noUnusedLocals`/`noUnusedParameters`; `noUncheckedIndexedAccess` off). ESM (`"type": "module"`).
- WXT 0.20 (`wxt.config.ts`, `srcDir: src`, `publicDir: src/public`) for Chrome MV3 (default) and Firefox builds; `#imports` provides `browser`/`defineBackground`/`defineContentScript`.
- Path alias `@/*` → `src/*` (tsconfig via `.wxt/tsconfig.json`, and vitest alias).
- Persistence: Dexie 4 over IndexedDB, schema v7. Tests run it against `fake-indexeddb` (`test/setup.ts`).
- ML: `@huggingface/transformers` running `Xenova/all-MiniLM-L6-v2` (ONNX Runtime WASM/WebGPU); ORT binaries generated into `src/public/ort` by `npm run build:ort`, must ship locally (MV3 CSP, no CDN). `'wasm-unsafe-eval'` in the extension CSP is required.
- Tests: Vitest (`test/**/*.test.ts`, node env, `fileParallelism: false` because IndexedDB state is per-worker). Acceptances: `test/verify.mjs` with `playwright-core` driving a real Chromium.
- Lint: ESLint 9 flat config; types owned by `tsc`.
- No runtime framework in UI: hand-written DOM/HTML/CSS in the popup, journal and overlay.
- Node 22 in CI (two jobs: check, and browser verify under xvfb).