# MBrain Phase 3 Context Map Explain Design

## Context

Phase 2 closed the deterministic structural stack through:

- Note Manifest
- note sections
- structural paths and neighbors
- persisted context maps with stale-aware reads
- atlas selection, overview, report, and orientation artifacts
- workspace and atlas cards and bundles

The next smallest behavior is not another summary artifact. It is a bounded
navigation read that explains one node inside a persisted context map.

`05-workstream-context-map.md` explicitly assigns `explain` to the map layer.
`02-memory-loop-and-protocols.md` also requires map behavior to stay derived,
bounded, and subordinate to canonical follow-through reads.

## Recommendation

Add one additive `map-explain` read path.

This slice should:

- accept a persisted `map_id` or a scope-based map selection route
- require one structural `node_id`
- return a deterministic local explanation for that node
- include direct neighbors and canonical follow-through reads
- disclose stale status when the selected map is stale

This slice should not:

- add new storage or schema
- rebuild maps automatically on read
- perform semantic ranking or free-text query expansion
- treat map output as canonical truth

## Scope

This slice includes:

- one read-only explain service over persisted context maps
- one operation and CLI surface
- one benchmark script and benchmark-shape test
- verification doc updates for the new explain command

This slice excludes:

- new graph persistence
- map-query behavior
- multi-hop path changes
- inbox, governance, or promotion behavior

## Explain Contract

The explain read should expose:

- `selection_reason`
- `candidate_count`
- `explanation`

The `explanation` block should include:

- `explanation_kind`
- `map_id`
- `node_id`
- `node_kind`
- `label`
- `status`
- `summary_lines`
- `neighbor_edges`
- `recommended_reads`

`neighbor_edges` should be bounded and include:

- `edge_kind`
- `from_node_id`
- `to_node_id`
- `source_page_slug`
- `source_section_id`

`recommended_reads` should stay compact and point back to canonical page or
section anchors already present in the persisted map.

## Locked Decisions

- `map-explain` will reuse the persisted `graph_json` already stored on
  `context_map_entries`; it will not rebuild a fresh in-memory graph
- direct `map_id` reads remain the primary route, with scope/kind selection as
  the fallback route
- node lookup is exact by `node_id`; there is no fuzzy label matching in this
  slice
- stale maps remain readable, but the explanation must disclose the stale state
  and recommend rebuild before broad trust
- recommended reads will be derived from the explained node plus its bounded
  neighborhood, not from whole-map top-level ranking

## Retrieval Behavior

`map-explain` is a navigation primitive, not a synthesis answer.

It should help the agent answer questions like:

- what is this map node and why is it in scope?
- which nearby structural anchors should I open next?
- which canonical page or section should I read to verify this orientation?

It should not answer:

- what is the final truth about this concept?
- which broad cluster best answers the whole question?

That keeps `map-explain` aligned with the protocol contract:

- persisted map first
- bounded local explanation second
- canonical follow-through reads third

## Acceptance

This slice is accepted when:

- `map-explain` returns deterministic results for direct `map_id + node_id`
  reads
- scope-based reads disclose `no_match` when no persisted map exists
- stale persisted maps stay readable but surface stale warnings
- recommended reads point to canonical page or section anchors
- the benchmark reports `readiness_status: pass` and `phase3_status: pass`

## Next Boundary

If this slice succeeds, the next smallest Phase 3 behavior is `map-query`.
`map-query` can then reuse the same persisted-map selection rules and canonical
follow-through conventions that `map-explain` locks down here.
