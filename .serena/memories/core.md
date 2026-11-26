# Xrawl — core

Browser-first word-scraping companion (WXT extension, MV3) with a reusable, host-agnostic game engine. README.md is the authoritative design doc; AGENTS.md holds repo conventions.

## Source map (`src/`)
- `entrypoints/` background worker (owns DB, relays stats), content script, `popup/`, `journal/`.
- `app/` composition roots: `content-session.ts` (platform+world+UI+creature), `creature-session.ts` (frame loop), `feeding-outbox.ts` (retrying feed sends), `observation-reporter.ts`.
- `creature/` pure simulation (genetics→appearance/attributes, brain, movement, gait, FABRIK rig, SVG renderer).
- `progression/` deterministic scoring (reward formula, level/XP, rarity table, affinity, interests, forage, upgrades, semantics vectors).
- `world/` perception (scanner, segmentation, geometry, clipping, visibility, context), environment classifier, `world-state.ts`.
- `data/` Dexie persistence: schema, append-only migrations, repositories (only place tables are read/written), ingest write path, export/import, cognition, `service.ts` (background-owned lazy DB).
- `semantics/` MiniLM via transformers.js + lexical fallback, one vector space per session.
- `platform/` ports (`types.ts`) and the single browser implementation (`platform/browser`).
- `ui/debug/overlay.ts`, `shared/` (config numbers, text normalization, id hashing, types).

## Invariants (each has a guard)
- Layer dependency direction and no-browser-globals rule: `mem:architecture`.
- Persistence rules (background-only DB, append-only feeding log, migration/export discipline): `mem:persistence`.
- What "done" means for a task: `mem:task_completion`.
- `src/public/ort/` is generated and gitignored. Graphify is no longer used; project knowledge lives in `.serena/memories/`.

## Traps
- The repo README is not aspirational: it documents implemented behaviour. Changing behaviour means changing README sections that assert it, plus the matching test.
- No comments unless they explain *why*; existing files are comment-dense by deliberate style (`mem:conventions`).