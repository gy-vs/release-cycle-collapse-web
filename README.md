# Release Dependency Studio

Local workbench for package release graphs. It analyses what a release
drags into its release train when the dependency graph contains cycles.

Run `npm install`, then `npm run dev` (API on :4174, UI on :4173).
Tests: `npm test`.

## Graph text format

```
package web
web -> core ^1.0.0
core -> web ^1.0.0          # edge back into the cycle
core -> util >=1.2.0        # an edge leaving the cycle
web -> util <1.5.0
util -> util ^1.0.0         # self loop
web -> trace ^3.0.0 optional
```

Ranges: exact `1.2.3`, `^`, `~`, comparators (`>=`, `>`, `<=`, `<`, `=`)
joined by spaces (intersection), `*` for any. Append `optional` for a
soft edge.

## Semantics

- Edge `X -> P range` means X depends on P; releasing a root drags every
  package it (transitively) depends on into the release train, so
  propagation follows dependency edges.
- Strongly connected components are computed with Tarjan; propagation
  runs on the condensation DAG. Every crossing edge of **every** SCC
  member is enumerated — collapsing a cycle into a UI group never hides
  outgoing edges, so packages outside a cycle cannot be missed.
- Version constraints are intervals solved **jointly by intersection**
  (never "take the max bump"). An empty intersection is a blocking
  conflict; a clash carried only by optional paths is a soft warning.
- The root component is pinned to one new version for every member, so
  choosing any package of the same SCC as the entry point gives the same
  reachable set, negotiated ranges, required versions and conflicts.
- Every result carries concrete reason chains (lists of manifest edge
  ids), including the simple paths used to walk through a cyclic
  component. Path enumeration is sorted, de-duplicated and capped, so
  output is independent of edge storage/iteration order.
- Analysis is guarded by the stored graph revision (`knownRevision` →
  HTTP 409 when the graph changed underneath the client). SCC groups and
  expand/collapse state live only in the client; server node identities
  are always package names.

## API

`POST /api/plans/:id/analyze` with `{content, root, rootVersion?, knownRevision?}`
returns SCCs, condensation edges, per-package impact (effective interval,
required version, bump level, constraint sources, reason chains) and
conflicts. Analysing draft content never mutates the stored record.
