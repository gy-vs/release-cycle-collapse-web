# Release Dependency Studio

Local workbench for package graphs.

Run `npm install`, then `npm run dev`.

## Graph format

Each plan holds a package graph as text, one statement per line (`#` starts a comment):

```
package alpha@1.0.0
package beta@1.0.0
alpha -> beta@^1.0.0
beta -> alpha@^1.0.0 optional
release alpha major
```

- `package <name>@<version>` declares a package. Packages referenced by edges but never declared are assumed to be `0.0.0` and reported as `implicit_package`.
- `<from> -> <to>[@<range>] [optional]` declares a dependency edge (default range `*`).
- `release <name> <patch|minor|major>` marks a package as released; the analyzer computes who else must re-release.

## Impact analysis

`POST /api/plans/:id/analyze` (optionally with `{content, revision}`) analyzes the graph:

1. Strongly connected components are computed and condensed into a DAG, so cycles never trap or short-circuit the traversal.
2. Impact propagates on the condensed DAG, dependencies first. Inside a component, version constraints are solved jointly as a least fixed point: every package gets the smallest bump level consistent with all of its edges, not the component-wide maximum.
3. A required edge whose dependency's new version violates its range propagates the dependency's level; an optional edge propagates at most a `patch`.
4. Every impact lists its reasons as concrete edges (`from`, `to`, `range`), so reason chains stay traceable when they cross component boundaries.

The result is a pure function of the graph text and releases — independent of statement order and of which package is released first. Results are cached per `(plan, revision, content)`; saving a plan bumps its revision and invalidates the cache. In the UI, collapsing or expanding a component group only changes the display; node identity and propagation results always come from the server.

Diagnostics report `range_conflict` (two edges to the same package that no single version can satisfy), `unsatisfied_range` (a range that excludes the dependency's current version), `version_conflict`, `invalid_range` and friends.

Run `npm test` for the solver and API test suites.
