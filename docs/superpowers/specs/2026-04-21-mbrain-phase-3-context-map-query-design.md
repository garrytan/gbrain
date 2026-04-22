# MBrain Phase 3 Context Map Query Design

## Context

Phase 3 now has one bounded navigation primitive: `map-explain`.

`map-explain` answers:

- what is this node?
- which local anchors should I open next?

The next smallest behavior is `map-query`, which should answer:

- which nodes in this persisted map best match a structural query string?
- which canonical anchors should I read first after that match?

This should stay narrower than global search and more direct than broad map
reports.

## Recommendation

Add one additive `map-query` read path.

This slice should:

- accept a persisted `map_id` or a scope-based selection route
- require one plain-text `query`
- match deterministically against node labels and page slugs in persisted
  `graph_json`
- return a bounded ranked node list plus canonical follow-through reads
- disclose stale status when the selected map is stale

This slice should not:

- add semantic ranking or embeddings
- replace canonical note search
- rebuild maps automatically on read
- turn query results into truth claims

## Scope

This slice includes:

- one read-only query service over persisted context maps
- one operation and CLI surface
- one benchmark script and benchmark-shape test
- verification doc updates for the new query command

This slice excludes:

- new storage or schema
- fuzzy entity resolution outside the selected map
- multi-map aggregation
- path or explain behavior changes

## Query Contract

The query read should expose:

- `selection_reason`
- `candidate_count`
- `result`

The `result` block should include:

- `query_kind`
- `map_id`
- `query`
- `status`
- `summary_lines`
- `matched_nodes`
- `recommended_reads`

Each `matched_nodes` item should include:

- `node_id`
- `node_kind`
- `label`
- `page_slug`
- `score`

`recommended_reads` should stay compact and point to canonical page or section
anchors already present in the matched node set.

## Locked Decisions

- matching remains deterministic and structural: exact label match outranks label
  substring match, which outranks page-slug substring match
- query results are bounded by `limit`, with a small default
- stale maps remain queryable, but the result must warn before broad trust
- recommended reads are derived from matched nodes only; `map-query` does not
  expand neighborhoods on its own

## Retrieval Behavior

`map-query` is for navigation narrowing.

It should help the agent answer:

- which structural anchors in this scope seem relevant?
- which canonical notes or sections should I open next?

It should not answer:

- what is the final synthesized answer?
- which inferred cluster is globally most important?

That keeps `map-query` aligned with the protocol contract:

- persisted map first
- bounded structural matching second
- canonical follow-through reads third

## Acceptance

This slice is accepted when:

- `map-query` returns deterministic ranked node matches for direct-map reads
- scope-based reads disclose `no_match` when no persisted map exists
- stale persisted maps stay queryable but surface stale warnings
- recommended reads point back to canonical page or section anchors from the
  matched node set
- the benchmark reports `readiness_status: pass` and `phase3_status: pass`

## Next Boundary

If this slice succeeds, the next smallest Phase 3 behavior is persisted
multi-hop `map-path` routing or protocol-level retrieval integration over the
new `map-explain` and `map-query` primitives.
