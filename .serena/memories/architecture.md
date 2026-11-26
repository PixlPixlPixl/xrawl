# Architecture: layers and guards

Dependency direction is a contract, not a suggestion. `test/architecture.test.ts` fails on violations.

```text
platform → world → creature / data → ui
```

- `src/creature/**`, `src/progression/**`, `src/semantics/**` are **host-agnostic**: no DOM globals, no `@/platform`, `@/data`, `@/ui`, `@/app`, WXT or Dexie imports. `eslint.config.js` blocks browser globals there (`window`, `document`, storage, observers, `fetch`, …) and asks for a platform port instead.
- `src/world/**` may know the DOM (perception), but must not import creature behaviour or repositories.
- Only `src/data/db.ts` may import `dexie`. Only `entrypoints/background.ts` may import `data/db|service|export|ingest` and `platform/browser/resilience` (`browser.storage.local`).
- Content-side code (`app/`, `world/`, `ui/`, `entrypoints/content.ts`) must never import `@/data/repositories`.
- Content scripts never open IndexedDB: Chrome content scripts share the page origin. They measure and send messages; the background writes.
- UI builds nodes with `textContent`; `innerHTML`/`insertAdjacentHTML`/`eval`/`new Function` are lint errors (page text must never be parsed as HTML; CSP).
- `console` is restricted to `warn`/`error` outside scripts/tests/config.
- Cross-layer contracts are plain data plus platform ports (`src/platform/types.ts`, `src/shared/types/*`); nothing layer-specific leaks into them.