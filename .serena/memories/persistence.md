# Persistence

Dexie over IndexedDB, **owned exclusively by the background worker** (`data/service.ts`, lazy single open). Content scripts never open it (page-origin collision). Content measures → `xrawl/observe`; the background writes through repositories.

## Schema (v7, `data/schema.ts` + `data/migrations.ts`)
`creatures`, `vocabulary`, `feedingEvents`, `environments`, `sessions`, `upgrades`, `progression`, `personality`, `embeddings`, `interestProfiles`, `interestOverrides`, `meta`.

Rules:
- `migrations.ts` is **append-only**: each entry holds the full store map at that version plus an upgrader. Shipped entries are never edited.
- Opening a newer-version database or importing a newer envelope is **refused**, not silently written.
- `meta.schemaVersion` is written after each successful open.
- Migration tests must build a *populated* old-version DB (`test/migrations.test.ts`), not an empty one.
- `feedingEvents` is append-only/immutable; `vocabulary` is a denormalized cache rebuildable from the log.
- Rewards (`points`/`xp`) are journaled on the event in the award transaction (the formula reads state *before* the feeding, so replay would disagree).
- Embeddings are keyed by model + dimensions + source hash; excluded from exports by default (regenerable). `interestProfiles` are memory and ARE exported.
- Export/import replaces tables and is transactional; a bad envelope cannot leave half a world.
- Storage: `unlimitedStorage` permission + `navigator.storage.persist()`; `browser.storage.local` holds only lightweight settings (overlay toggle, context-storage flag) plus the DB-creation marker that survives a wiped IndexedDB.
- Caps keep tables bounded (`EMBEDDING_CACHE_LIMIT`, `PERSONALITY_ROW_LIMITS`, per-flush 2,000 words / 1 hour browse time).