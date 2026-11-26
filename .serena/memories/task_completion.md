# Task completion

Before calling a coding task done, run the CI gate:

```bash
npm run compile && npm run lint && npm test
# or: npm run check
```

- Type errors, lint errors and failing tests must be fixed, not ignored.
- Behaviour that touches perception/rendering needs the real-browser suite (`npm run verify:headless` on Linux without a display); Vitest cannot prove layout.
- If you change the schema, add a new append-only `MIGRATIONS` entry and a populated-database upgrade test in `test/migrations.test.ts`. Never edit a shipped entry.
- If a documented behaviour changes, update the matching README section and the test that asserts it.
- Do not leave a dev server or `wxt` process running.