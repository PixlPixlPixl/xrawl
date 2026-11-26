# Project conventions

## Graphify graph

`graphify-out/graph.json` is **always committed**. The rest of `graphify-out/` is
generated and ignored, but the graph itself is part of the repository: queries
against it must work from a fresh clone.

- After a graph rebuild, `git add graphify-out/graph.json` in the same change
  (or as its own `Commit Graphify graph` commit).
- Do not add `graphify-out/graph.json` to `.gitignore`, and do not leave it
  modified in the working tree when finishing a task.
