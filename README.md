# Xrawl

Xrawl is a desktop word-scraping companion. It starts as a browser extension,
but the game engine, world model, and persistence contracts are deliberately
kept independent of browser APIs so the same simulation can later run inside a
desktop host.

This repository currently implements **milestone 1: the word-discovery
debugger**. There is intentionally no creature, movement, or progression code
yet — everything else depends on reliable word perception.

## Quick start

```bash
npm install
npm run dev          # WXT dev server (auto-starts a browser profile)
```

Production build:

```bash
npm run build        # → .output/chrome-mv3
```

Then open `chrome://extensions`, enable Developer mode, and **Load unpacked**
from `.output/chrome-mv3`. Open any article and every discovered word gets a
debug outline.

### Using the debug harness

- **Outlines** — one thin outline per discovered word run, colored by word.
  Wrapped words draw one outline per line fragment.
- **Hover a word** — a tooltip shows the original text, normalized form, rect
  count, viewport ratio, environment, context sentence, surrounding block text,
  target id, and page URL.
- **HUD** (top right) — total targets, targets in view, unique words, last pass
  duration/kind, environment, and a capped-scan warning.
- **`Alt+Shift+X`** — toggle outlines. The setting is persisted.
- **Toolbar popup** — live stats, top words, environment classification,
  scan metadata, rescan, copy full snapshot JSON, download snapshot JSON.

The snapshot JSON is exactly what later layers consume:

```jsonc
{
  "revision": 12,
  "page": { "url": "...", "title": "..." },
  "environment": { "kind": "article", "confidence": 0.83, "reasons": ["og:type article", "article element"] },
  "viewport": { "scroll": { "x": 0, "y": 0 }, "size": { "width": 1280, "height": 800 } },
  "targets": [
    {
      "id": "1abcdef:12:3",           // session-unique: pageKey:nodeId:segmentIndex
      "fingerprint": "...",             // content-derived, survives reloads
      "text": "Quick",                  // original segment text
      "normalized": "quick",            // NFKC + lowercase + edge punctuation stripped
      "rects": [ { "x": 80, "y": 120, "width": 42.5, "height": 19 } ], // document space
      "visibility": { "rendered": true, "inViewport": true, "viewportRatio": 1, "occluded": false },
      "context": { "sentence": "The quick brown fox…", "surrounding": "The quick brown fox…" },
      "page": { "url": "...", "title": "..." },
      "environment": "article",
      "scanOrder": 3,
      "source": { "nodeId": "n12", "segmentIndex": 3 }
    }
  ],
  "stats": {
    "targetCount": 184,
    "textNodeCount": 41,
    "rectCount": 197,
    "visibleInViewport": 63,
    "uniqueWordCount": 121,
    "topWords": [ { "word": "the", "count": 9 } ],
    "passes": 2,
    "lastPassKind": "layout",
    "lastPassStartedAt": 1234.5,
    "lastPassDurationMs": 18.2,
    "lastPassNodeCount": 41,
    "lastPassLimited": false,
    "mutationBatches": 1,
    "deferredPasses": 0,
    "lastPassChanged": true,
    "segmentation": { "cacheSize": 41, "hits": 0, "misses": 41 }
  },
  "capturedAt": 1710000000000
}
```

## Architecture

Four layers, with a strict dependency direction. The engines never import
browser globals; only the platform layer does.

```text
                    ┌──────────────────────────────────────────────┐
  browser / host ──▶│ platform  (browser-adapter, messaging, …)    │
                    └───────────────┬──────────────────────────────┘
                                    │ ports: scheduler, viewport, storage
                                    ▼
                    ┌──────────────────────────────────────────────┐
                    │ world     perception · environment · state  │
                    └───────┬───────────────────────────┬──────────┘
                            │ WordTarget[] (plain data) │
                            ▼                           ▼
                    ┌──────────────┐            ┌──────────────┐
                    │ creature     │            │ persistence  │
                    │ (future)     │            │ (future)     │
                    └──────────────┘            └──────────────┘
                            │
                            ▼
                    ┌──────────────────────────────────────────────┐
                    │ ui        debug overlay · popup              │
                    └──────────────────────────────────────────────┘
```

| System | Allowed to know about | Must not depend on |
| --- | --- | --- |
| Creature simulation (future) | creature state, targets, physics | DOM, WXT, IndexedDB |
| Rendering (future) | creature state, vector parameters | browser storage, progression rules |
| Perception (implemented) | DOM and word geometry | creature behaviour |
| Progression (future) | feeding events, rarity, upgrades | DOM, rendering |
| Cognition (future) | context, embeddings, preferences | browser APIs |
| Persistence (future) | data models and repositories | creature rendering |

### Current file map

```text
src/
├── entrypoints/
│   ├── background.ts                 background worker (stats cache/relay)
│   ├── content.ts                    injects the debug harness
│   └── popup/                        HTML + CSS + popup UI
├── app/
│   └── content-session.ts            composition root (platform + world + ui)
├── platform/
│   ├── types.ts                      Platform ports (scheduler, viewport, storage)
│   └── browser/
│       ├── browser-adapter.ts        the only browser API implementation of ports
│       ├── messaging.ts              typed runtime/tab message helpers
│       ├── navigation.ts             SPA URL change detection
│       └── permissions.ts            lazy permission helpers (not wired yet)
├── world/
│   ├── perception/
│   │   ├── text-discovery.ts         TreeWalker + shadow roots + exclusions
│   │   ├── word-segmentation.ts      Intl.Segmenter + LRU cache
│   │   ├── geometry.ts               Range → document-space rects, clip intersection
│   │   ├── clipping.ts               overflow/contain-paint clip resolver
│   │   ├── visibility.ts             CSS visibility + opaque-cover detection
│   │   ├── context.ts                sentence index + block context
│   │   └── word-scanner.ts           orchestration, mutations, layout changes
│   ├── environment/
│   │   ├── classifier.ts             heuristic environment classification
│   │   └── tracker.ts                page identity + classification cache
│   └── world-state.ts                target store, visibility, snapshots
├── ui/debug/overlay.ts               canvas outlines, HUD, hover tooltip
├── shared/
│   ├── constants/config.ts           tuning surface
│   ├── id.ts                         stable hashing
│   └── types/                        geometry, page, word-target, messaging
└── (planned) creature/, progression/, cognition/, data/
```

Planned layers are not stubbed out: empty interfaces would be debt. Their
contracts are described in `shared/types` (plain word targets, plain geometry)
and the platform ports in `platform/types.ts`.

## How perception works

### Coordinate spaces

Word targets store **document-space** rects (`rect.x/y` from the document
origin). This is the stable representation; scrolling does not move a word.

The debug overlay converts to viewport space (`rect - scroll`) every frame.
The world model re-derives visibility from cached rects on scroll — no DOM
reads, no `Range` re-measurement. Resizes and layout changes do re-measure.

A multi-frame measurement pass reads the scroll offset **per node**, just
before its `Range` geometry; a scroll during the pass cannot mix coordinate
systems. The viewport is reconciled again before the pass commits.

The overlay canvas is sized to `documentElement.clientWidth/clientHeight`
(layout viewport, excluding scrollbars), not `innerWidth/innerHeight`, and
its backing store uses that same CSS width × DPR. Otherwise the scrollbar
width rescales drawings and every box drifts toward the left edge.

Nested scroll containers cannot be handled by page scroll math, so a captured
scroll event from an inner element schedules a **scoped** pass rooted at that
element.

### Rectangles, not a rectangle

`Range.getClientRects()` yields one fragment per rendered line/inline
boundary. Fragments on the same line that are adjacent are coalesced into one
rect; wrapped words keep multiple rects. Targets with zero rendered rects are
dropped (fully clipped/hidden), and pathological fragment counts are capped.

### Visibility and exclusion rules

Element-level pruning happens before text discovery:

- CSS-invisible subtrees: `display:none`, `visibility:hidden|collapse`,
  `opacity:0`, `content-visibility:hidden`, `[hidden]` (using
  `Element.checkVisibility` when available plus computed-style fallback).
- Non-content tags: `script`, `style`, `noscript`, `template`, media, canvas,
  iframes, native controls, buttons, `<svg>`/non-HTML namespaces.
- Editable content: `contenteditable` subtrees, `textarea`/`input`/`select`,
  and documents in `designMode` are skipped entirely.
- Sensitive content: any form containing a password/one-time-code/credit-card
  control is pruned, as are elements carrying sensitive autocomplete hints.
- Xrawl-owned subtrees (overlay canvas/HUD/tooltip) are rejected so the
  harness never perceives itself.

A text node is a candidate only if it has non-whitespace text and a rendered
element parent.

### Caching and scheduling

- **Segmentation** is cached per raw text-node string (LRU). A pass over
  unchanged text does not even consult the cache: the scanner stores the
  segment array on the tracked node.
- **Sentence indexes** and **block surrounding text** are built once per text
  node/block per pass.
- **Visibility** is cached per element per layout generation (one
  `getComputedStyle` per element at most).
- A **layout fingerprint** per node (page key + environment + text hash +
  surrounding text + rounded rect geometry) lets `WorldState.upsertNode`
  no-op when nothing changed. The overlay only re-renders on real changes.

Passes are triggered by:

1. initial `document_idle` start;
2. MutationObserver batches (child/text/visibility attributes), debounced
   260 ms with adaptive backoff (`3 × last pass duration`, floor 400 ms);
3. resize, debounced 220 ms;
4. SPA URL changes (`navigation` event / `popstate` / 1 s URL poll);
5. nested scroller scrolls, debounced 100 ms, scoped to the container;
6. resource `load` events, body `ResizeObserver` growth, and font swaps;
7. `animationend` / `transitionend`; one deferred pass after lazy
   `content-visibility` layout, plus a post-scroll drift probe;
8. manual rescan from the popup.

Text is measured in chunks (120 nodes per animation frame) so a large page
never blocks the main thread. Hidden documents defer passes until visible.
Work is capped at 20,000 targets per pass.

### No continuous scanning

There are no polling timers over the DOM. Scroll only does geometry math,
mutations are coalesced, unchanged nodes are skipped at the fingerprint level,
and a scan of a static page produces exactly one structural pass. The test
suite asserts that the pass counter stays flat while idle.

## Verification

`test/verify.mjs` launches the built extension in Chromium via
`playwright-core`, serves `test/fixtures/page.html`, and drives the real
message protocol through the background service worker.

```bash
npm run verify          # desktop (needs a display)
npm run verify:headless # Linux CI via xvfb-run
```

The fixture covers normal paragraphs, hard-wrapped long words, hidden content
(CSS and `hidden`), `visibility` overrides, overflow-clipped strips, editable/
sensitive subtrees, overlay-owned text, code blocks, SVG/script/template
content, inline-split spans, an animation-revealed paragraph, a lazy
`content-visibility` section below the fold, a paragraph covered by an opaque
panel, an `display:contents` wrapper, screen-reader-only/legacy-clip/clip-path
text, an open shadow root with static and post-load text, and below-the-fold
words. The 34 checks cover:

- word discovery, original vs normalized text, reading order;
- multi-rect wrapping and positive finite geometry;
- context sentence + surrounding text, including inline-split text nodes;
- page/title/environment/source metadata;
- unique ids/fingerprints and every required target field;
- hidden, editable, sensitive, overlay, and UI-chrome exclusion;
- visibility overrides inside hidden parents, overflow-clipped text exclusion;
- `display:contents` wrappers and visible descendants;
- screen-reader-only, legacy `clip`, and `clip-path: inset()` exclusion;
- opaque covers marked `visibility.occluded` and skipped by the outline layer;
- animation-revealed text and lazy `content-visibility` sections after scroll;
- open shadow-root text and mutations inside shadow roots;
- stats ↔ target-list consistency;
- overlay/HUD presence, hover tooltip contents;
- canvas CSS size, backing store, and origin match the layout viewport;
- scroll: viewport visibility changes while document rects stay fixed;
- idle: no passes while nothing changes;
- resize: re-measure, geometry change, `lastPassKind === "resize"`;
- manual rescan: `lastPassChanged === false` and zero new segmentation work;
- dynamic text insertion and removal;
- overlay toggle via message API and `Alt+Shift+X`;
- JSON snapshot download shape;
- popup boot/offline state and connected live-stats rendering.

### Acceptance criteria → evidence

| Criterion | Where it is proven |
| --- | --- |
| Detects individual words in paragraphs | `paragraph words are discovered…` |
| Does not include hidden content | `hidden content is excluded` |
| Includes visible descendants of hidden ancestors | `descendants may override inherited visibility` |
| Includes descendants of `display:contents` wrappers | `display:contents wrappers do not prune descendants` |
| Excludes visually hidden/clipped text | `visually hidden and clipped text is excluded` |
| Does not outline clipped/off-screen layout boxes | `overflow-clipped text is not outlined` |
| Does not outline covered text | `covered text is marked occluded` |
| Detects dynamically added text | `dynamically added text is detected` (+ removal) |
| Coordinates update after scroll and resize | `scrolling updates viewport visibility…`, `resizing re-measures geometry…` |
| Boxes are not rescaled by scrollbar width | `overlay canvas matches the layout viewport` |
| Does not scan unchanged text continuously | `unchanged text is not rescanned while idle`, `manual rescan…` |
| Ignores editable/sensitive fields | `editable and sensitive content is excluded` |

Manual check: open an article, scroll, resize, watch outlines stay aligned; use
DevTools to add/remove a paragraph; hover words to inspect targets.

## Message protocol

| Direction | Message | Purpose |
| --- | --- | --- |
| content → background | `xrawl/stats` | latest stats/page/environment per tab |
| popup → background | `xrawl/get-cached-stats` | fallback when content is unreachable |
| background → popup | `xrawl/stats-broadcast` | live push while the popup is open |
| popup → content | `xrawl/get-stats` | status payload |
| popup → content | `xrawl/get-snapshot` | export payload (targets capped for transport) |
| popup → content | `xrawl/rescan` | force a manual pass |
| popup → content | `xrawl/set-overlay` | toggle outlines (persisted) |
| popup → content | `xrawl/download-snapshot` | JSON file download initiated in-page |

All shapes and guards live in `src/shared/types/messaging.ts`.

## Known limitations (intentional for this milestone)

- **Top frame + open shadow roots.** `allFrames: false`; iframe content needs
  per-frame aggregation later. Open shadow roots are traversed and observed;
  closed roots are inaccessible by design.
- **Paint containment / occlusion** is only partially handled. Word rects are
  clipped to `overflow`/`contain: paint` ancestors, legacy CSS `clip`, and
  `clip-path: inset()` (plus zero-radius circles/ellipses); rects under 2 CSS px
  on a side are dropped. Words covered by a
  solid element are marked `visibility.occluded` and not outlined. Text under
  semi-transparent overlays remains outlined; full polygon/URL `clip-path`
  shapes and exotic paint effects are not evaluated. Occlusion is recomputed on the next pass, so with
  a fixed overlay open, scrolling can leave a few stale occlusion flags until
  a mutation/animation/resize/pass is triggered.
- **Document-space rects** are trusted while scrolling on the hot path. A
  post-scroll probe (12 sampled words) triggers re-measurement if layout drifted
  without an observed event; if a large panel moves content between those
  samples, it is corrected on the next pass.
- **`visibility: visible` inside a `visibility: hidden` ancestor** is
  supported: hidden elements are traversed and each text node is checked
  against its parent's resolved `visibility`.
- **Lazy `content-visibility: auto`** content is re-scanned once after layout
  settles and again after scrolling stops; content that becomes relevant
  without any scroll, mutation, animation, or resize can still be missed until
  the next pass.
- **Nested scrollers** re-measure only the scrolled element's subtree; multiple
  simultaneously scrolling containers would need one scoped pass each.
- **Caps:** 20,000 targets per pass; 8,000 targets per exported snapshot
  message (the download also uses the transport cap).
- **Segmentation fallback** when `Intl.Segmenter` is unavailable is a Unicode
  letter/number regex (no dictionary-based CJK/Thai segmentation).
- **Environment classification** is heuristic (URL/title/meta/small DOM probes)
  and deliberately low-confidence on unfamiliar sites.

## Next steps

1. **Persistence contracts** (`data/`): vocabulary, page/word targets,
   feeding history, creature state, migrations. Both perception and creature
   should talk to repositories through interfaces, not to IndexedDB directly.
2. **Feeding loop**: creature selects a `WordTarget`, resolves a durable word
   id via `fingerprint`, and records interest/preference deltas.
3. **Creature engine** (`creature/`): pure simulation reading plain targets and
   the platform scheduler; no DOM/WXT/IndexedDB imports.
4. **Desktop host**: implement `platform/types.ts` ports over Electron/Tauri and
   feed world perception from a host extraction pipeline; the engine code is
   unchanged.
5. **Personality**: model it as accumulated experiences and preference
   history (deterministic, inspectable), not weights an embedding model
   retrains.

## Commands

| Command | Description |
| --- | --- |
| `npm run dev` | WXT dev mode with HMR |
| `npm run build` | production Chrome MV3 build |
| `npm run build:firefox` | Firefox MV2/MV3 build |
| `npm run compile` | `tsc --noEmit` |
| `npm run verify` | build + real-browser acceptance suite |
| `npm run verify:headless` | same, under `xvfb-run` |
| `npm run zip` | packaged extension zip |
