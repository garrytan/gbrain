# MBrain Phase 3 Broad Synthesis Route Design

## Context

Phase 3 now has persisted-map navigation primitives:

- `map-explain`
- `map-query`
- `map-path`

Those primitives are useful on their own, but the protocol contract in
`02-memory-loop-and-protocols.md` says broad synthesis should use:

- curated notes first
- Context Map / Map Report for orientation second
- focused source reads after that

The next smallest integration step is not to replace `search` or `query`.
It is to add one explicit read route that packages map orientation for a
broad-synthesis question.

## Recommendation

Add one additive `broad-synthesis-route` read path.

This slice should:

- accept a plain-text `query`
- select one persisted context map
- use `map-report` for broad orientation
- use `map-query` to narrow likely anchors
- use `map-explain` on the top structural hit when one exists
- return compact canonical follow-through reads for the next retrieval step

This slice should not:

- change the existing `search` or `query` operations
- claim final truth from map output
- bypass canonical notes
- add write behavior or Retrieval Trace persistence

## Scope

This slice includes:

- one read-only broad-synthesis routing service
- one operation and CLI surface
- one benchmark script and benchmark-shape test
- verification doc updates for the new route command

This slice excludes:

- query engine changes
- new storage or schema
- task-resume protocol changes
- precision-lookup protocol changes

## Route Contract

The route read should expose:

- `selection_reason`
- `candidate_count`
- `route`

The `route` block should include:

- `route_kind`
- `map_id`
- `query`
- `status`
- `retrieval_route`
- `summary_lines`
- `matched_nodes`
- `focal_node_id`
- `recommended_reads`

`retrieval_route` should stay explicit and ordered so later Retrieval Trace
integration can reuse the same route vocabulary.

`recommended_reads` should stay compact and combine only:

- report-level orientation reads
- query-level matched-node reads
- optional top-hit explain reads

## Locked Decisions

- broad-synthesis routing will remain read-only in this slice
- the route will always start from persisted map selection, not live graph
  reconstruction
- the route will still return a non-null bundle when a map exists but the query
  matches no nodes; in that case it falls back to report-driven orientation
- the route will include a `focal_node_id` only when `map-query` found at least
  one structural match
- stale maps remain routable, but the route must warn before broad trust

## Retrieval Behavior

This route is an orientation step between the broad question and canonical
reads.

It should help the agent answer:

- which canonical notes or sections should I open first?
- which structural node is the best first anchor for this broad question?
- what explicit route should later Retrieval Trace capture?

It should not answer:

- the final synthesis itself
- whether the top structural node is already authoritative truth

That keeps the route aligned with the redesign contract:

- protocol chooses map orientation as a navigation aid
- canonical notes stay upstream of final truth

## Acceptance

This slice is accepted when:

- `broad-synthesis-route` returns deterministic report/query/explain-based
  routing for direct broad-synthesis queries
- no persisted map returns `no_match`
- a query miss still returns a non-null route when a persisted map exists
- stale persisted maps stay routable but surface stale warnings
- `retrieval_route` remains explicit and ordered
- the benchmark reports `readiness_status: pass` and `phase3_status: pass`

## Next Boundary

If this slice succeeds, the next realistic step is either:

- Retrieval Trace integration for these route decisions, or
- a protocol-level hook that lets higher-level answer assembly call this route
  automatically before broad-synthesis reads.
