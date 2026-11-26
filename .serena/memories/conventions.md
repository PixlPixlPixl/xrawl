# Code conventions

- Terse, *why*-focused comments on non-obvious decisions; avoid restating the code. File-level docblocks explain the module's contract and the failure mode it prevents.
- Determinism is a rule: scoring/hunting/gameplay must replay identically. Use `stableUnit`/`stableKey`/`hashString` (`src/shared/id.ts`) rather than `Math.random` or clocks in decision paths.
- Timestamps: never `null` (IndexedDB cannot index null) — use `0` for "never/absent".
- Storage shape: only *inputs* are stored (e.g. creature genetics + live state); appearance/attributes are derived at load. Derived values are not persisted.
- Table access goes through `src/data/repositories/*`; writes that span tables are transactional and funnel through `data/ingest.ts` or `data/progression.ts`.
- Failures inside game logic are often returned as value outcomes (`{ ok: false, reason: 'insufficient-points' }`) rather than throws, so UI can explain them. I/O and protocol errors throw/reject.
- Message shapes and runtime guards live together in `src/shared/types/messaging.ts`; validate there, clamp again in the write path.
- Hosts are canonical: lowercase, no `www.`, no port/path.
- Style enforced by lint: single quotes, semicolons, 2-space indent, trailing commas (see `eslint.config.js`); `eqeqeq` smart, `prefer-const`, `no-var`, object shorthand, `no-non-null-assertion` off (`!` is used after guards).
- Config numbers belong in `src/shared/constants/*` (`XRAWL_CONFIG`, `CREATURE_CONFIG`), not inline magic values.
- Member order/naming follows existing modules: exported interfaces with `readonly` fields for contracts, `type` over `interface` for unions, no default exports except WXT entrypoints (`defineBackground`/`defineContentScript`).