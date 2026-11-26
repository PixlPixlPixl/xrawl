# Commands

Run from the repo root (Linux, `sh`).

- `npm run dev` / `npm run dev:firefox` — WXT dev (copies ORT WASM first).
- `npm run build` → `.output/chrome-mv3`; `npm run build:firefox`; `npm run zip`.
- `npm run compile` = `tsc --noEmit`.
- `npm run lint` = `eslint .`.
- `npm test` = `vitest run`; `npm run test:watch`.
- `npm run check` = compile + lint + test (the fast CI gate).
- `npm run verify` = build + real-browser suite (`node test/verify.mjs`, needs a display).
- `npm run verify:headless` = same under `xvfb-run -a`.
- `npm run build:wordfreq` regenerates `progression/data/wordfreq-en.ts` from a source msgpack; `npm run build:ort` re-copies ORT binaries.
- `serena memories check` validates memory references.

Note: `npm install` runs `wxt prepare` (postinstall), which generates `.wxt/` type stubs — `tsc` fails without it.