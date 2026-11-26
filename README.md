# Xrawl

Xrawl is a desktop word-scraping companion. It starts as a browser extension,
but the game engine, world model, and persistence contracts are deliberately
kept independent of browser APIs so the same simulation can later run inside a
desktop host.

This repository implements **all seven initial-release milestones**: the
perception engine and its debug harness, the persistence foundation and journal,
the parameterised creature with its movement/gait/FABRIK stack, eating and
progression, the companion and foraging modes, environment/personality
learning, and the semantic layer that turns feedings into an evolving interest
profile.

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
- **`Alt+Shift+M`** — switch between companion and foraging.
- **`Alt+Shift+F`** — manual feeding mode: click a word to feed it, `Esc`
  leaves. Off by default, so the creature never hijacks links or selection.
- **Toolbar popup** — live stats, top words, environment classification, scan
  metadata, rescan, snapshot export, creature controls, the upgrade shop, the
  site-interest override, and the world-memory panel (export/import, journal).

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
                    │ (future)     │            │ (implemented)│
                    └──────────────┘            └──────────────┘
                            │
                            ▼
                    ┌──────────────────────────────────────────────┐
                    │ ui        debug overlay · popup              │
                    └──────────────────────────────────────────────┘
```

| System | Allowed to know about | Must not depend on |
| --- | --- | --- |
| Creature simulation (implemented) | genetics, attributes, targets, gait | DOM, WXT, IndexedDB |
| Rendering (implemented) | a pose of plain points, appearance colours | browser storage, progression rules, action decisions |
| Perception (implemented) | DOM and word geometry | creature behaviour |
| Progression (implemented) | feeding events, rarity, upgrades | DOM, rendering |
| Cognition (implemented) | context, embeddings, preferences | browser APIs, DOM |
| Persistence (implemented) | data models, repositories, migrations | creature rendering, DOM |

### Current file map

```text
src/
├── entrypoints/
│   ├── background.ts                 background worker (stats cache/relay)
│   ├── content.ts                    injects the debug harness
│   └── popup/                        HTML + CSS + popup UI
├── app/
│   ├── content-session.ts            composition root (platform + world + ui)
│   ├── observation-reporter.ts       browse-time / word deltas sent to the background
│   ├── feeding-outbox.ts             retry queue: an unacknowledged bite is re-sent
│   ├── feeding-mode.ts               click-a-word selection mode + highlight
│   └── creature-session.ts           frame loop: snapshot -> engine -> SVG + feed
├── creature/                         simulation: no DOM, no Dexie, no platform
│   ├── species.ts                    gene sets -> appearance + attributes
│   ├── loadout.ts                    genetics + purchases -> live loadout
│   ├── brain.ts                      action state machine + speed budgets
│   ├── targets.ts                    eligible words -> forage points
│   ├── engine.ts                     the tick: controllers + pose + events
│   ├── movement/
│   │   ├── movement-controller.ts    where the body goes, how it faces
│   │   └── gait-controller.ts        when feet lift, where they land
│   ├── rig/
│   │   ├── fabrik.ts                 IK solver over plain points
│   │   ├── rig.ts                    appearance -> limb chains
│   │   └── pose.ts                   per-frame geometry (controllers meet)
│   └── render/svg-renderer.ts        draws a pose; decides nothing
├── progression/                      scoring: no DOM, no Dexie, no platform
│   ├── reward.ts                     B + L + F + N + E + P, every part capped
│   ├── frequency.ts                  local wordfreq table + rarityScore
│   ├── level.ts                      XP curve, derived level, life stage
│   ├── affinity.ts                   environment/personality terms, discovery eligibility
│   ├── semantics.ts                  vector math, interest profiles, attention pool
│   ├── hunting.ts                    hunting priority + deterministic exploration
│   ├── upgrades.ts                   catalog + prices (effects live in creature/loadout.ts)
│   └── data/                         generated frequency table + its attribution
├── data/                             persistence: no DOM, no rendering, no UI
│   ├── schema.ts                     row types + index declarations
│   ├── migrations.ts                 append-only version history
│   ├── db.ts                         Dexie instance, version + downgrade guards
│   ├── repositories/                 one module per table; only code that reads/writes tables
│   ├── ingest.ts                     observation/feeding write path (clamping, transactions)
│   ├── progression.ts                feeding award + point-funded purchases (transactional)
│   ├── export.ts                     whole-database export/import
│   ├── export-format.ts              export envelope type + guard
│   ├── observation.ts                payload contracts + hard limits
│   ├── cognition.ts                  feeding/exposure → profiles → hunting priorities
│   ├── embeddings.ts                 content-hash vector cache (reuse, never re-infer)
│   ├── resilience.ts                 persist()/storage-estimate probes
│   └── service.ts                    background-owned database service (lazy open)
├── platform/
│   ├── types.ts                      Platform ports (scheduler, viewport, storage)
│   └── browser/
│       ├── browser-adapter.ts        the only browser API implementation of ports
│       ├── messaging.ts              typed runtime/tab message helpers
│       ├── navigation.ts             SPA URL change detection
│       └── resilience.ts             eviction-aid marker in extension storage
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
├── semantics/                        the model behind cognition (no DOM, no Dexie)
│   ├── provider.ts                   EmbeddingProvider port + text/anchors
│   ├── minilm.ts                     lazy MiniLM pipeline (WASM Q8, WebGPU fp16)
│   ├── lexical.ts                    deterministic hashed fallback
│   └── service.ts                    one vector space per session, timeout + fallback
├── ui/debug/overlay.ts               canvas outlines, HUD, hover tooltip
├── shared/
│   ├── constants/config.ts           tuning surface
│   ├── text.ts                       word normalization shared by both sides
│   ├── id.ts                         stable hashing
│   └── types/                        geometry, page, word-target, creature, messaging
└── public/ort/                      generated ONNX Runtime WASM (gitignored)
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

`.github/workflows/ci.yml` runs two jobs: `npm run compile && npm run lint &&
npm test` on every push and pull request, and the browser suite under xvfb.

It drives the persistence channel through the popup (the only context whose
`runtime.sendMessage` reaches the background listener): it waits for observation
flushes to reach the database, asserts a known fixture word persisted, exports
and re-imports the world, and checks that invalid and newer-schema envelopes are
rejected without touching live data.

The creature section inspects the live SVG: eight articulated limb paths whose
bone lengths match the rig, a body that moves and re-orients over time, an
alternating gait where some feet are airborne and others planted (never all
airborne at once), and a jaw that only animates in the eating state.

The fixture covers normal paragraphs, hard-wrapped long words, hidden content
(CSS and `hidden`), `visibility` overrides, overflow-clipped strips, editable/
sensitive subtrees, overlay-owned text, code blocks, SVG/script/template
content, inline-split spans, an animation-revealed paragraph, a lazy
`content-visibility` section below the fold, a paragraph covered by an opaque
panel, an `display:contents` wrapper, screen-reader-only/legacy-clip/clip-path
text, an open shadow root with static and post-load text, and below-the-fold
words. The 45 checks cover:

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
| popup → content | `xrawl/set-mode` | companion or foraging (persisted, shared) |
| popup → content | `xrawl/set-feeding-mode` | modal "click a word to feed it" |
| popup → content | `xrawl/set-trailing` | companion trailing distance (persisted) |
| popup → content | `xrawl/download-snapshot` | JSON file download initiated in-page |
| content → background | `xrawl/observe` | browse-time + word deltas for the database |
| content → background | `xrawl/feed` | one feeding event (append-only, `source` says who chose it) |
| content → background | `xrawl/prioritize` | rank visible words against learned interests |
| popup → background | `xrawl/site-interest` | what this host teaches, plus the option list |
| popup → background | `xrawl/set-site-interest` | set or clear (`null`) a host override |
| content → background | `xrawl/creature-loadout` | resolved genetics + purchase levels |
| popup → background | `xrawl/db-status` | schema version, counts, storage, progression, model state |
| popup → background | `xrawl/db-export` | whole-database JSON envelope |
| popup → background | `xrawl/db-import` | replace tables from an export envelope |
| journal → background | `xrawl/journal` | overview, feedings, vocabulary, word detail |
| journal → background | `xrawl/set-context-storage` | opt in/out of storing the sentence a word was eaten in |

All shapes and guards live in `src/shared/types/messaging.ts`. Persistence
messages are validated there before the background touches the database; the
write path then clamps and sanitizes them again in `src/data/ingest.ts`.

## Persistence

The game database is **Dexie over IndexedDB**, owned exclusively by the
background worker. Content scripts never open it: Chrome content scripts share
the host page's origin for web storage, so writing there would put the world
inside the page's namespace. The content script measures and sends
`xrawl/observe` deltas; the background writes through repositories.

```text
content script ──xrawl/observe──▶ background ──▶ DatabaseService ──▶ repositories ──▶ Dexie/IndexedDB
                ──xrawl/feed────▶             (lazy open, single instance)
```

Observations are periodic, so a dropped flush only delays what the next one
carries. A feeding is not: losing it loses the word and its reward for good, so
`app/feeding-outbox.ts` queues every `xrawl/feed` and retries with backoff until
the background acknowledges the write (the event id is bucketed by ten seconds,
so a retry is paid once while two genuine meals stay two events).

### Tables (v7)

| Table | Key | Purpose |
| --- | --- | --- |
| `creatures` | `id` | Genetics input + live state; appearance/attributes are derived |
| `vocabulary` | `word` | Per-word seen/eaten counters and first/last timestamps |
| `feedingEvents` | `id` | Immutable log; one row per eating event, with host and the reward it paid |
| `environments` | `kind:host` | Accumulated exposure, visits, word volume |
| `sessions` | `id` | Visible browse time, page visits, feedings |
| `upgrades` | `id` | Purchased upgrades with level and spend |
| `progression` | `id` | One row per creature: xp, derived level, word points, feeding history, affinity pool |
| `personality` | `kind:key` | Learned interests/traits as bounded values with confidence |
| `embeddings` | derived | Vectors keyed by model **and** dimensions |
| `interestProfiles` | `category` | Learned interest vectors plus their share of the attention pool |
| `interestOverrides` | `host` | The user's declared interest for one site |
| `meta` | `key` | Schema bookkeeping, not game data |

Design notes that matter later:

- **Feeding is append-only.** `feedingEvents` is the source of truth; vocabulary
  counters are a denormalized cache that can be rebuilt from the log.
- **Timestamps use `0`, never `null`.** IndexedDB does not index `null`, so
  `endedAt: 0` keeps "open sessions" queryable.
- **Embeddings are keyed by model + dimension + source hash.** Swapping models
  writes new rows and leaves the old ones intact for comparison or pruning.
- **Compound indexes** (`[creatureId+eatenAt]`, `[word+eatenAt]`,
  `[host+eatenAt]`, `[model+subjectType+subjectId]`, `[kind+updatedAt]`) cover
  the queries progression, cognition and the journal actually run.
- **Rewards are journaled, not derived later.** `feedingEvents.points` / `xp` are
  written in the same transaction as the award, because the formula scores the
  state *before* the feeding and a replay would disagree.

### Migration rules

1. `src/data/migrations.ts` is the history. It is append-only: shipped entries
   are never edited, corrections go in a new entry.
2. Each entry holds the complete store map at that version plus its upgrader.
3. `meta.schemaVersion` is written after every successful open, so an
   interrupted upgrade is visible.
4. Opening a store written by a **newer** build is refused, not silently
   written to. The same rule guards imports.
5. Tests build a *populated* old-version database and upgrade it — see
   `test/migrations.test.ts`. Creating an empty database proves nothing.

### Export and import

The popup's **Memory** panel exports the whole world as one JSON envelope
(`format`, `formatVersion`, `schemaVersion`, counts, tables) and imports it back.
Import validates the envelope before opening a transaction, then clears and
rewrites every table in it **inside one transaction** — a bad file cannot leave
half a world behind. Embedding rows are excluded from exports by default
because they are a cache; the vectors can be regenerated.

### Storage resilience

IndexedDB survives extension updates but not eviction or uninstall:

- `unlimitedStorage` is declared, and `navigator.storage.persist()` is requested
  on first open (`src/data/resilience.ts`).
- The store records its own first open in `meta.createdAt`, and a creation
  marker is kept in `browser.storage.local`, which survives a wiped database.
  The popup compares the two: a marker that predates the store means the history
  was reset, an absent marker means a new install (`describeHistory` in
  `src/entrypoints/popup/main.ts`).
- The embedding cache is trimmed oldest-first past its ceiling
  (`EMBEDDING_CACHE_LIMIT`), and learned preference rows keep their strongest
  evidence up to `PERSONALITY_ROW_LIMITS`, so no table grows without bound.
- Export/import is the real backstop: it is the only thing that survives
  extension removal.

`browser.storage.local` remains reserved for lightweight settings (the overlay
toggle); game history belongs in the database.

## Journal

The popup's **Journal** button opens a full page (`journal.html`) that reads the
history tables and renders them. It is the first screen that answers "is the
creature eating the right words?" without reading a database dump.

### Overview

Cards for words consumed (with how many were manual), unique vocabulary (eaten
words, against every word ever seen), level with an XP bar, the word-point
balance, feedings per focused minute, and when the first feeding happened. Below
them, the sites the creature has actually lived in, ranked by focused exposure
with each site's share of total time.

Words per minute is the one derived number here: feedings divided by the
*visible, focused* time recorded in `sessions`, so a tab left open in the
background cannot make the creature look lazy.

### Feeding history

One row per event: **Word**, **Time** (local clock plus a today/yesterday/date
label), **Source** (the site host), **Page** (title, linking to the URL), **Type**
(manual or autonomous, plus the page kind), and **Reward** in word points with
the XP it also paid.

Rewards are stored on the event, not recomputed: the formula reads the state
*before* a feeding, so replaying an old event in a new order would pay a
different number. Rows written before schema v7 show "-" rather than a
fabricated value. Filters are chips for manual/autonomous and a search box that
treats anything containing a dot as a site and anything else as a word.

### Vocabulary

Browse every discovered word, sorted by times eaten (default), last seen, or
alphabetically, with an "eaten only" filter. The search box accepts either a
word prefix or a site: `github.com` lists what was eaten there, in the chosen
order.

Clicking a word opens a detail panel with its first/last sighting and first/last
eating times, the environments it was seen in, the sites it was eaten on
(clicking one filters the history), its recent feedings, and its **related
words**:

- with a model, the eight nearest cached word vectors by cosine similarity in
  the creature's *current* model space (the highest-weight profile names it);
- without one, the words eaten most often on the same sites.

Only the 600 most-eaten words are compared, so opening the journal stays a
screenful of work. Neighbours below 0.2 similarity are dropped rather than
listed as "related" for merely being co-cached.

### What is stored, and what is not

- **Sites, titles and timestamps, never coordinates.** A stored rect stops
  meaning anything once the page reflows; a URL and a title do not.
- **Context sentences are opt-in** (Overview -> *Page context*). Off by default:
  cognition embeds the sentence in memory at learn time and the passage is
  discarded, leaving only its hash (which keys the vector cache). Turning it on
  stores the truncated sentence and lists it in the word detail.
- **Hosts are canonical**: lowercase, no `www.`, no port or path, so a site is
  one site whichever way it was reached.

The journal page only sends `xrawl/journal` reads and the context-storage
preference; it can never write game history.
## Progression

Progression is **fully deterministic**: no model, no randomness, no clock in the
scoring path. Eating a word produces a reward breakdown, XP and word points
from the word plus the creature's stored history, so the same save file always
replays to the same totals. Embeddings and learned preferences come later; this
layer works without them.

### Two currencies

| Currency | Earned by | Spent on | Stored as |
| --- | --- | --- | --- |
| **XP** | every feeding | nothing - it only raises the level | `progression.xp`; level is derived from it |
| **Word points** | every feeding, a fraction of the same reward | upgrade levels | `progression.wordPoints` |

XP is never spent, so a level is always a *projection* of total XP
(`progression/level.ts`) and can be recomputed from a save file. Word points
are an integer wallet; buying an upgrade debits `progression` and writes
`upgrades` inside one transaction, so points cannot vanish without the upgrade
being granted. The popup's **Upgrades** panel is the only shop UI.

### The reward formula

```text
R = B + L + F + N + E + P
```

| Term | Meaning | Cap |
| --- | --- | --- |
| `B` | base reward for any word | 4 |
| `L` | word-length bonus, 0.75 per character past 2 | 6 |
| `F` | frequency/rarity bonus, weight 8 x rarity | 8 |
| `N` | discovery bonus: 12 the first time, then 4/3/2... | 12 |
| `E` | environment affinity: paid from a shared pool, in proportion to that environment's affinity share | 5 |
| `P` | personality affinity, weight 4 x learned preference | 4 |

### Environment affinity is dynamic

Every environment draws from **one pool that always totals 100%**. Affinity is a
normalized distribution, not a set of independent scores:

```text
feed in "code"   ->  code 20%, every other environment keeps 80% of its share
                     (the pool is renormalized back to 100%)
```

The learning rate is 0.2 per feeding, so a new habit takes roughly a dozen
feedings to dominate and an old one fades instead of being erased. A creature
that eats 60% of its words on technical sites settles at ~60% technical
affinity - and a technical feeding pays 60% of what the environment pool makes
available.

The pool is **10 points**, then **normalized by 0.5**: a 100% favourite pays 5
points (not 50), a 60% favourite pays 3, a 1-in-10 environment pays 0.5. Large
enough that a genuinely dominant environment is worth noticing, scaled down so
it is a moderate increase rather than a runaway multiplier. Affinity is scored
*before* the feeding that moves it, so a word never pays for its own bonus.

Caps are what keep one gigantic, unusual word from out-earning a page of
normal ones. `computeReward` (`progression/reward.ts`) returns the full
breakdown, so a debug panel can always explain a number.

### Rarity without a network call

The table in `progression/data/wordfreq-en.ts` is generated from Robyn Speer's
**wordfreq** small English wordlist (28,917 words, Zipf >= 3), front-coded and
stored as a local string; it is decoded lazily into a map on first lookup.
There is no Python dependency and no network request at runtime, and only
`scripts/build-word-frequency.mjs` needs the source file to regenerate it.

```ts
rarityScore(zipf) = clamp((6 - zipf) / (6 - 3), 0, 1)   // 6 common, 3 rare
```

The data is CC BY-SA 4.0 while the wordfreq code is Apache 2.0; see
`progression/data/wordfreq-attribution.md` for the notice and what ShareAlike
means for a redistributed table.

**Unknown words are neutral, not rare.** A word the table has never seen scores
`0.5` instead of `1.0`. Otherwise random strings, typos, hashes and page IDs
would be the most profitable food on the page.

### Discoveries count once

The first time a creature eats a word it gets the full discovery bonus; every
later eating gives a smaller one that decays to a floor of 1. Discovery is
only awarded when the word is real vocabulary: at least two characters, at
least one letter, and no whitespace. A single letter (`c` out of `c++`, an
`s` stripped from a possessive) or a bare number is not a discovery, so
punctuation fragments cannot be farmed.

Segmentation is Unicode-aware (`Intl.Segmenter`, with a Unicode regex fallback),
so `state-of-the-art` contributes `state`, `of`, `the`, `art` - never the raw
compound - and punctuation never becomes a word. The same normalization
(`shared/text.ts`) runs in the content script and in the background, so both
sides key the dictionary identically.

### Upgrades

| Upgrade | Effect | Max level | First price |
| --- | --- | --- | --- |
| `locomotion.speed` | movement speed | 8 | 40 wp |
| `digestion.rate` | eating speed | 8 | 35 wp |
| `metabolism.capacity` | stomach capacity | 8 | 30 wp |
| `senses.reach` | detection radius | 8 | 45 wp |
| `senses.vocabulary` | maximum word length | 6 | 55 wp |
| `senses.curiosity` | exploration rate (tries unfamiliar words) | 6 | 60 wp |
| `senses.selection` | travel-cost weight (better target choice) | 8 | 70 wp |
| `senses.semantics` | semantic sensitivity (prefers familiar subjects) | 6 | 65 wp |

The last three change *decisions* rather than the body; see
[Gameplay modes](#gameplay-modes).

Prices compound (`baseCost * growth^(level-1)`). Effects are data in
`creature/loadout.ts`; the catalog only prices them, and every catalog entry
must map to a real effect (checked in the tests). A failed purchase is a
*value* - `insufficient-points`, `max-level`, `unknown-upgrade` - not a throw,
because the popup has to explain why nothing happened.

Level also drives the creature's life stage (`hatchling` -> `nymph` ->
`juvenile` -> `adult` -> `elder`); the stage is written to the creature row
only when a level is gained.

### What is deliberately not here yet

- **No training and no fine-tuning.** The model is fixed; preferences are learned
  as a profile of its vectors (see [Cognition](#cognition)).
- Personality rows are written by cognition now, so the `P` term is live, but it
  still reads scalars rather than the profile vectors themselves.
- Rewards start at schema v3. Feedings recorded before that are kept in the
  log but are not paid retroactively.

## Cognition

The creature has a **fixed** semantic model and a **learned** profile. Nothing is
fine-tuned: MiniLM turns text into a 384-dimension unit vector, and the game is
arithmetic on top of those vectors. That keeps learning deterministic - the same
feeding log replays to the same preferences - and keeps the model replaceable.

### The model, loaded lazily

`@huggingface/transformers` runs `Xenova/all-MiniLM-L6-v2` through ONNX Runtime
Web:

| | |
| --- | --- |
| Weights | ~23 MB, Q8 quantized, fetched once from the Hub |
| Baseline | WASM, single thread (Q8) |
| Accelerator | WebGPU, when the browser really exposes an adapter (fp16) |
| Runtime | shipped in the bundle: `src/public/ort`, ~32 MB, generated by `npm run build:ort` |
| Startup cost | zero - the pipeline is created on the first embedding request |

MV3 needs `'wasm-unsafe-eval'` in the extension CSP, and extension pages may only
run their own scripts, so ORT's loader cannot come from a CDN: the binaries ship
with the extension and `env.backends.onnx.wasm.wasmPaths` points at `/ort/`.

**One session, one vector space.** If the model has not loaded within 20 s (slow
phone, offline), the session commits to the deterministic lexical fallback and
keeps it. Rows record which model produced them, so a later model change rebuilds
the profiles instead of comparing two incomparable spaces.

### Profiles: one attention pool

```text
technology 0.44 · general 0.18 · literature 0.12 · food 0.09 · ...
```

Profiles are seeded from short anchor phrases, then move with each experience.
The pool always sums to 1: a new interest takes share *from* the others, exactly
like environment affinity. Attention shifts; it never accumulates.

| Input | Weight | Why |
| --- | --- | --- |
| Manual feeding | 0.5 | the user chose the word on purpose |
| Autonomous feeding | 0.08 | its own foraging must not become self-reinforcing |

(Browsing time is deliberately not a profile influence; it is its own channel,
below.)

The word is embedded **with its sentence**, so `database` in a cooking article and
`database` in a compiler article pull in different directions. The blend rate slows
as a profile gathers evidence (`influence / (1 + observations / 6)`), so early
learning is fast and later learning refines instead of thrashing. Anything closer
to nothing than to an interest lands on `general` rather than bending its nearest
neighbour.

### Environment interests (no model)

Browsing develops **broad interests** with no model at all, because a host name
and a word list are enough to answer "what is this page about".

| Environment | Hosts / signals | Interest |
| --- | --- | --- |
| Technology | github, gitlab, stackoverflow, npm, developer.* | technology |
| Food | allrecipes, seriouseats, bbcgoodfood, recipe.* | cooking |
| Science | arxiv, pubmed, nature, science.org, journals.* | science |
| News | bbc, reuters, nytimes, politico, news.* | news |
| General reading | wikipedia, blogs, anything else | general |

`src/progression/interests.ts` owns the host rules, the page-kind fallback
(`code` → technology, `article` → general, `email` → nothing) and the keyword
lists that decide whether a *word* belongs to an interest. The classifier in
`src/world/environment/classifier.ts` supplies the page kind; the host rules are
checked first because `github.com` is technology even when the page reads like an
article.

**Only focused time counts.** A step is 45 s of a page being simultaneously
visible, in the active tab, and in a focused window (`document.hasFocus()`), with
the reporter pausing on blur and on `visibilitychange`. A tab left open overnight
cannot rewire the creature.

**Interests decay.** Each interest is a 0..1 weight with a 14-day half-life,
decayed lazily from `interestsUpdatedAt`: nothing runs in the background, and
last month's recipe blog does not keep it hungry for cooking. Exposure saturates
(90 s of reading covers ~63% of the remaining gap to 1), so a long visit matters
but an endless one does not dominate, and weights below 0.02 are forgotten.

**Users can override any host.** The popup's *This site* section shows what the
current host teaches and offers Automatic / Technology / Food / Science / News /
General. The choice is stored in `interestOverrides` keyed by host, so it applies
to every future visit; *Automatic* deletes the row rather than storing an opinion.

**Three channels, deliberately different sizes.**

| Channel | Effect | Where |
| --- | --- | --- |
| Browsing time | broad interests (0..1, decayed, no AI) | `progression/interests.ts` |
| Manual feeding | specific preference (strong) | `data/cognition.ts` (embeddings) |
| Autonomous feeding | reinforces existing preference, gradually | `data/cognition.ts` (embeddings) |

They meet only in hunting: `priority = 0.4 * semantic + 0.3 * browsing + 0.2 *
novelty + 0.1 * rarity + exploration`. Because browsing contributes 30%, the
creature chases technology words after a GitHub afternoon even before a single
word has been fed - and because semantic preference is capped at 40%, browsing
time can never fully dictate its personality.

### Hunting

`xrawl/prioritize` ships the page's words to the background, which scores them
against the profiles and returns a word -> priority map. Two stages keep it cheap:
every word gets a word-level embedding (usually a cache hit), then only the top 24
are re-embedded with their sentence and re-scored.

```text
priority = 0.4 * relevance + 0.3 * interest + 0.2 * novelty + 0.1 * rarity + exploration
```

(The same formula is listed with its rationale under [Cognition](#cognition):
semantic relevance, the browsing-interest channel, novelty, intrinsic rarity and
the deterministic exploration bonus.)

The creature then chooses by priority *and* proximity (75/25) rather than nearest
word. Exploration is a **stable hash of the word**, not a random roll: a quarter of
words carry up to +0.35, scaled by how *unrelated* they are, so the creature
occasionally eats something it would not normally choose - and the same page
always produces the same decision.

### Caching

- Vectors are cached by `(model, dimensions, subject type, text hash)`: a
  sentence is never embedded twice, and a repeated feeding in the same context
  costs a lookup rather than inference.
- The browser caches the model weights (Cache API, via transformers.js).
- `embeddings` is excluded from exports by default because it is rebuildable;
  `interestProfiles` is not, because it is memory.

### Benchmarking on a phone

`src/semantics/minilm.ts` records each inference batch (texts, milliseconds,
backend) as `EmbeddingProvider.stats()`, and the popup's Memory panel prints it
beside the model state (`model ready · 16 texts 240 ms wasm`). Judge the budget
there, not on a desktop: the first semantic use also pays the model download, and
WASM on a midrange phone is roughly an order of magnitude slower than a laptop. The batch size (16) and the 24-candidate context limit are the two
knobs that decide the cost.

### Privacy and cost

The only network traffic is the one-time model download from `huggingface.co`;
text never leaves the device. The build grows by the ONNX runtime (~34 MB), and
the model arrives on first semantic use, then from cache.

### What is deliberately not here yet

- No fine-tuning: the model is fixed, preference is a profile.
- No clustering: categories come from anchors plus `general`; emergent labels
  would need a second model.
- No per-tab creature counts: progression is per creature, not per player, so a
  lineage is still one row per creature rather than a shared wallet.
- Hunting priorities are per word, not per occurrence: two `database` targets
  share one score even if their sentences differ.

## Gameplay modes

The same simulation drives two strategies. The mode is shared by every tab, so
the creature behaves the same wherever it currently is.

| | Companion | Foraging |
| --- | --- | --- |
| Movement | trails the pointer at a configurable distance | walks to words it chooses |
| Eating | on request, plus a rare nearby bite | on its own |
| Selection | none unless the user picks a word | scored by `S(w)` |

### Companion

The creature walks toward a point `trailing` pixels behind the cursor and stops
once the pointer is inside that band plus a deadzone, which is what stops it
vibrating over a link. The distance is configurable (16-320 px, default 96) and
stored with the other creature settings. Inside the band it still idles and
rests, so a parked cursor gets animation rather than a frozen frame. It never
wanders off to forage: the companion eats on request, plus at most one
opportunistic nearby bite every 14 seconds.

### Manual feeding: a mode, not a default

Clicking a word only feeds it while the **feeding selection mode** is on
(popup button, or Alt+Shift+F). While it is on, clicks are captured and
`preventDefault`-ed, a highlight box follows the word under the pointer, and
Escape exits. While it is off, Xrawl never touches links, buttons or text
selection - the creature cannot hijack normal browsing. Manual feeding is sent
with `source: 'manual'`, which is the 0.5 learning influence in
[Cognition](#cognition).

### Foraging

\[
S(w) = R(w) + N(w) + A(w) + E(w) - C(w)
\]

| Term | Meaning | Weight |
| --- | --- | --- |
| `R` | rarity from the local frequency table | 0.15 |
| `N` | novelty (never eaten = 1) | 0.20 |
| `A` | learned semantic affinity | 0.30, scaled by semantic sensitivity |
| `E` | browsing interest for the subject | 0.20 |
| `C` | travel cost, quadratic in distance | 0.50, capped at 1.5 |
| - | exploration bonus (deterministic word hash) | up to 0.35 |

`C` is why distance matters: a word twice as far costs four times as much, and
past the detection radius it saturates at 1.5 (above every positive term), so
a sufficiently remote word can genuinely be refused. Intelligence (travel
cost) and semantic sensitivity (affinity weight) are what let a creature
outgrow "grab the nearest thing".

### Upgrades change behaviour, not just speed

| Upgrade | Gameplay effect |
| --- | --- |
| `locomotion.speed` | reaches targets sooner (same score, shorter walk) |
| `senses.reach` | finds words farther away |
| `senses.vocabulary` | can eat longer words |
| `digestion.rate` | finishes a word sooner |
| `metabolism.capacity` | longer feeding sessions before resting |
| `senses.curiosity` | raises exploration: tries unfamiliar words more often |
| `senses.selection` | lowers travel cost: walks farther for a better word |
| `senses.semantics` | raises semantic sensitivity: prefers familiar subjects |

Behaviour attributes are clamped in `creature/loadout.ts` (curiosity <= 0.6,
travel cost >= 0.2, sensitivity <= 3) so no purchase can make the search
degenerate into "always the same word" or "distance is free".

### One creature, many tabs

Every tab runs a session and shares the same creature id, progression and
feeding history, but only the **focused, visible tab** hosts the creature:
`setPresent` stops rendering and simulating everywhere else. Switching tabs
therefore does not spawn a second creature with a second opinion - it moves the
one that exists.

## Creature

The creature is a **parameterized vector rig**, not a hand-drawn animal with
hardcoded upgrade patches. One pipeline builds every species:

```text
genetics ──▶ appearance ──▶ rig ──▶ pose ──▶ SVG
         └─▶ attributes ──┐
upgrades ─────────────────┴─▶ attributes
```

`src/creature/` is a pure simulation: no DOM, no Dexie, no `@/platform`. A
desktop host can run it unchanged, and `test/architecture.test.ts` fails if that
stops being true.

### Appearance vs attributes

Two separate projections, never merged:

| Concept | What it is | What rewrites it |
| --- | --- | --- |
| **Genetics / species** | body size, limb count, bone lengths, hue, innate aptitude | evolution |
| **Appearance** | the derived drawable construction (`CreatureAppearance`) | recomputed from genetics |
| **Attributes** | gameplay capabilities (`CreatureAttributes`) | purchases |
| **State** | live values (satiety, stomach) | the simulation |
| **Personality** | learned tendencies (stored separately) | cognition |

A purchase therefore cannot change the body, and an evolution cannot silently
double a stat. Neither appearance nor attributes is *stored*: the creature row
holds genetics + live state, and both projections are recomputed at load (`src/creature/loadout.ts`).

Species are just default gene sets: `spider` (8 legs, 3 bones each) and `mite`
(6 legs, 2 bones). Adding a species is one entry in `src/creature/species.ts`.

### The three animation components

| Component | File | Responsibility |
| --- | --- | --- |
| Movement controller | `movement/movement-controller.ts` | where the body is; rate-limited turning; speed throttled by facing so it cannot orbit a target |
| Gait controller | `movement/gait-controller.ts` | when each foot lifts, where it lands, when it plants; alternating groups; planted feet drag with the body |
| FABRIK solver | `rig/fabrik.ts` | how articulated limbs bend, preserving bone lengths |

`rig/pose.ts` is where they meet: it seeds each chain, solves it, and emits a
`CreaturePose` of plain points. The renderer (`render/svg-renderer.ts`) draws
that pose and decides nothing.

Two solver details worth knowing:

- **The seed is curved, not straight.** A perfectly straight chain is an unstable
  fixed point — forward and backward passes cancel and the limb stalls. Seeding
  with a gentle bend gives FABRIK a moment arm.
- **The foot is never force-assigned after solving**, because that would change
  the last bone's length. Convergence is the guarantee; residue is bounded by
  the tolerance.

### Behaviours are states, not branches

```text
idle ──word in range──▶ approaching ──within reach──▶ eating ──done──▶ following
  ▲                          ▲                                          │
  │                          └──────────── word in range ────────────────┘
  ├──quiet──▶ resting ──very close word──▶ approaching
  └──quiet──▶ foraging ──word in range──▶ approaching ◀──────────────────┘
```

Transitions live in `brain.ts` as a pure function of the current action plus a
small context; the renderer never checks state. Eating is its own state with its
own jaw animation and a zero speed budget — it is not an extension of walking.
Rest is about digestion (the stomach decays only while resting), which is what
prevents an eat/rest/approach loop several times a second.

An eaten word is remembered by `fingerprint` for a cooldown, because page text
cannot be removed and the creature would otherwise re-eat it forever.

### Wiring

`src/app/creature-session.ts` owns the frame loop and is deliberately thin:
snapshot in → engine step → pose out → SVG, plus one `xrawl/feed` message per
bite. It never touches the database; the background supplies the live loadout
over `xrawl/creature-loadout`.

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
  message (the download also uses the transport cap). Occlusion hit tests are
  budgeted at 600 per pass (`scan.maxOcclusionChecks`): words past the budget
  are reported as unoccluded for that pass, which is cheap and self-correcting.
- **One vector space per session.** A model that finishes loading after the
  fallback was committed is ignored for the rest of that session, and profiles
  are model-scoped, so two spaces are never compared.
- **Segmentation fallback** when `Intl.Segmenter` is unavailable is a Unicode
  letter/number regex (no dictionary-based CJK/Thai segmentation).
- **Environment classification** is heuristic (URL/title/meta/small DOM probes)
  and deliberately low-confidence on unfamiliar sites.
- **Persistence caps.** One observation flush carries at most 2,000 words, and
  the background clamps per-flush browse time to one hour. A page whose first
  snapshot arrives before perception measured anything retries its word counts on
  the next snapshot; nothing is lost, only delayed.
- **Import replaces, it does not merge.** Importing a world overwrites the
  tables present in the file. Export first if the current world matters.
- **Vectors are a cache; profiles are memory.** Exports exclude `embeddings`
  (regenerable from source text) but include `interestProfiles`, because those
  vectors are what the creature learned and cannot be recomputed without the
  feeding log.
- **One model per session.** A session that falls back to the lexical provider
  keeps it until restart; profiles are model-scoped so switching never compares
  two vector spaces.
- **The creature never opens IndexedDB.** It receives a resolved loadout over
  messaging. Genetics and purchases change on the background's side; the
  content script only derives and draws.
- **A page's words are finite.** Eaten words are suppressed for a cooldown rather
  than deleted, so a long-lived page eventually runs out of food and the
  creature rests. Reloading or scrolling to new text supplies more.
- **The frequency table is English-only.** 28,917 words above Zipf 3.0;
  rarer words, other languages, names, and novel coinages score the neutral
  rarity instead of a guess, which is the intended anti-farming behaviour.
- **Progression is per creature, not per player.** One row keyed by creature id,
  so a lineage would need one row each rather than a shared wallet.
- **Affinity is recency-weighted, not a lifetime average.** Each feeding moves
  the distribution by the learning rate, so a creature's favourite environment
  can change as it browses. Nothing decays over wall-clock time: affinity only
  moves when something is eaten, and a long absence does not erode it.
- **Personality affinity is outside the environment pool.** It is signed
  evidence from learned rows (-1..1), so it can also *reduce* a reward; it has
  its own cap and does not compete with the environment distribution.
- **Gait is a tetrapod approximation.** Feet alternate by band parity rather
  than true per-leg phase offsets, and planted feet drag until the step
  threshold. It reads correctly for 6-8 limbs; more exotic gaits would need
  per-limb phase tables.

## Next steps

1. **Evolution**: rewrite `genetics` from accumulated evidence. Appearance and
   attributes are derived, so an evolution needs no migration and cannot
   contradict its own body.
2. **Cognition depth**: manual feeding (the influence is wired but unused),
   emergent interest categories from clustering the profile vectors, and reward
   feedback from `P` reading profiles instead of scalar tendencies.
3. **Reward feedback**: return the reward breakdown to the content script so the
   debug overlay can show what a feeding was worth, instead of the popup having
   to be reopened.
4. **Desktop host**: implement `platform/types.ts` ports over Electron/Tauri
   and feed world perception from a host extraction pipeline; the engine and
   data layers are unchanged.

## Commands

| Command | Description |
| --- | --- |
| `npm run dev` | WXT dev mode with HMR |
| `npm run build` | production Chrome MV3 build |
| `npm run build:firefox` | Firefox MV2/MV3 build |
| `npm run compile` | `tsc --noEmit` |
| `npm run lint` | ESLint: layer boundaries, unsafe HTML, stray `console` |
| `npm run check` | compile + lint + tests - the same sequence CI runs |
| `npm test` | unit + integration tests (`vitest`, real IndexedDB via `fake-indexeddb`) |
| `npm run test:watch` | same, in watch mode |
| `npm run build:wordfreq` | regenerate the local frequency table from `small_en.msgpack.gz` |
| `npm run verify` | build + real-browser acceptance suite |
| `npm run verify:headless` | same, under `xvfb-run` |
| `npm run zip` | packaged extension zip |
