# MBrain Phase 3 Context Map Path Design

## Context

Phase 3 now has two persisted-map navigation primitives:

- `map-explain` for one-node local explanation
- `map-query` for bounded structural matching

The next smallest behavior is `map-path`, which should explain how two nodes in
the same persisted context map connect.

This is narrower than retrieval-protocol integration and more aligned with the
Context Map workstream contract, which explicitly calls out `path` alongside
`query` and `explain`.

## Recommendation

Add one additive `map-path` read path.

This slice should:

- accept a persisted `map_id` or a scope-based selection route
- require exact `from_node_id` and `to_node_id`
- compute a bounded shortest path over the persisted `graph_json`
- return the node chain, edge chain, and canonical follow-through reads
- disclose stale status when the selected map is stale

This slice should not:

- rebuild maps automatically on read
- replace the existing live `section-path` primitive
- add semantic routing or weighted graph search
- treat path output as canonical truth

## Scope

This slice includes:

- one read-only path service over persisted context maps
- one operation and CLI surface
- one benchmark script and benchmark-shape test
- verification doc updates for the new path command

This slice excludes:

- new storage or schema
- multi-map routing
- retrieval protocol changes
- query or explain behavior changes

## Path Contract

The path read should expose:

- `selection_reason`
- `candidate_count`
- `path`

The `path` block should include:

- `path_kind`
- `map_id`
- `from_node_id`
- `to_node_id`
- `status`
- `hop_count`
- `node_ids`
- `edges`
- `summary_lines`
- `recommended_reads`

Each `edges` item should include:

- `edge_kind`
- `from_node_id`
- `to_node_id`
- `source_page_slug`
- `source_section_id`

`recommended_reads` should stay compact and point to canonical page or section
anchors already present in the path.

## Locked Decisions

- path search remains deterministic breadth-first search over persisted
  `graph_json`
- path search is undirected at traversal time, matching the existing structural
  graph behavior
- no path should return a deterministic `no_path` disclosure, not an exception
- stale maps remain path-readable, but the result must warn before broad trust
- recommended reads are derived from nodes on the resolved path only

## Retrieval Behavior

`map-path` is a navigation explanation, not a proof of truth.

It should help the agent answer:

- how are these two anchors connected in the current scope?
- which canonical artifacts justify that bridge?

It should not answer:

- whether the bridge is semantically important beyond the structural path
- whether the path itself is enough to synthesize a final answer

That keeps `map-path` aligned with the protocol contract:

- persisted map first
- bounded path explanation second
- canonical follow-through reads third

## Acceptance

This slice is accepted when:

- `map-path` returns deterministic shortest paths for direct-map reads
- scope-based reads disclose `no_match` when no persisted map exists
- disconnected nodes return `no_path`
- stale persisted maps stay path-readable but surface stale warnings
- recommended reads point back to canonical page or section anchors from the
  path
- the benchmark reports `readiness_status: pass` and `phase3_status: pass`

## Next Boundary

If this slice succeeds, the next realistic step is retrieval-protocol
integration: using persisted `map-query`, `map-explain`, and `map-path`
selectively inside higher-level read routes without letting them replace
canonical sources.
