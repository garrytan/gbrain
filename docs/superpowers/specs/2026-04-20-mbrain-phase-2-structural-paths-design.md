# MBrain Phase 2 Structural Paths Design

## Context

`Note Manifest` and `note_section_entries` now exist as deterministic, regenerable structural artifacts over canonical Markdown. The next smallest approved Phase 2 slice should prove that these artifacts are sufficient to support narrow graph-like orientation behavior before `Context Map` storage, reports, or atlas routing are introduced.

The immediate product question is not "can we build a map?" It is "can we explain direct structural neighbors and bounded paths from canonical note structure without inventing new truth?"

This slice therefore targets deterministic structural navigation only.

## Approaches Considered

### Option 1: Build durable Context Map storage now

This would add map tables, map metadata, and query behavior in one pass.

This is rejected for this slice. It is too wide. It mixes deterministic extraction, graph persistence, path behavior, and orientation artifacts before the smaller contracts are proven.

### Option 2: Add a durable structural-edge store first

This would persist explicit page/section/link edges in new tables and query those tables for neighbor/path behavior.

This is viable, but it adds schema churn before there is evidence that persisted edges are necessary. The current inputs already expose the exact structure needed for a first deterministic path layer.

### Option 3: Build an in-memory deterministic section graph on top of existing derived artifacts

This builds a transient graph from `note_manifest_entries` and `note_section_entries`, exposes only inspection-oriented `neighbors` and `path` behavior, and leaves durable map persistence for a later slice.

This is the recommended approach. It is the smallest slice that exercises the structural inputs we already have, proves path-explanation usefulness, and avoids committing early to a full map schema.

## Recommendation

Implement an in-memory deterministic structural graph service over existing manifest and section artifacts, then expose two narrow behaviors through the shared operation surface:

- `neighbors`: bounded structural neighbors for a page or section node
- `path`: a bounded shortest-path explanation between two page/section nodes

This slice should not introduce `Context Map`, `Context Atlas`, community detection, ranking, semantic bridges, or any new canonical data. It should only prove that the existing deterministic structural projection can power explainable navigation.

## Scope

This slice includes:

- a deterministic graph builder over `note_manifest_entries` and `note_section_entries`
- stable node identifiers for pages and sections
- explicit structural edge projection from already-approved canonical/derived inputs
- bounded `neighbors` and `path` operations
- local benchmark coverage for structural graph build, neighbors lookup, and path lookup

This slice excludes:

- persisted `Context Map` or `Context Atlas` storage
- semantic extraction or inferred bridges
- graph ranking, clustering, or report generation
- new canonical Markdown content or governance behavior
- code or task nodes beyond what canonical note artifacts already reference

## Structural Model

The structural graph in this slice is derived in memory from existing artifacts and can be rebuilt at any time.

### Node identity

Nodes are identified by stable string ids:

- page node: `page:<slug>`
- section node: `section:<section_id>`

No other node kinds are required in this slice.

### Edge kinds

Only deterministic structural edges are allowed:

- `page_contains_section`
  - from `page:<slug>`
  - to `section:<section_id>`
  - emitted for every section belonging to the page
- `section_parent`
  - from child `section:<section_id>`
  - to parent `section:<parent_section_id>`
  - emitted only when `parent_section_id` exists
- `section_links_page`
  - from `section:<section_id>`
  - to `page:<resolved_slug>`
  - emitted only when the wikilink target resolves to an existing manifest/page slug in the same scope

No edge may be emitted from implicit similarity, tag overlap, alias overlap, or semantic inference.

### Edge payload

Each returned edge should include enough data to explain itself without re-parsing Markdown:

- `edge_kind`
- `from_node_id`
- `to_node_id`
- `scope_id`
- `source_page_slug`
- `source_section_id` when applicable
- `source_path`
- `source_refs`

This data is advisory and derived. It is not canonical truth on its own.

## Query Behavior

### `neighbors`

The neighbors behavior returns a bounded set of adjacent nodes and edge explanations for one node id.

Rules:

1. It must be scope-aware from day one.
2. It must not return synthetic nodes.
3. It must disclose the deterministic edge kind for each returned relationship.
4. It must stay bounded by `limit`.
5. It must fail clearly when the node id is invalid or missing.

### `path`

The path behavior returns a bounded shortest path between two node ids using deterministic edges only.

Rules:

1. Use breadth-first search over the derived structural graph.
2. Respect a maximum hop budget.
3. Return a stable path explanation shape: nodes, traversed edges, hop count.
4. If no path exists within budget, return an explicit empty/not-found result instead of inventing a bridge.
5. The result must point back to the underlying page/section artifacts that justify each hop.

## Refresh Behavior

This slice must not add a new refresh pipeline. It should reuse the artifacts already refreshed by canonical note writes and `section-rebuild`.

The graph builder simply reads the latest manifest and section rows at query time.

This means:

- canonical note writes continue to refresh manifest and section rows
- `section-rebuild` remains the explicit repair path for derived section artifacts
- graph behavior stays fresh as long as those existing derived artifacts are fresh

## Failure and Safety Rules

The slice should fail safe:

1. Missing or stale target slugs produce fewer edges, not inferred substitutes.
2. Invalid node ids should raise a clear operation error.
3. Path lookup should return no path when a structural path is absent.
4. If deterministic structural navigation is insufficient for a user query, later phases may layer richer map behavior; this slice must not pretend to solve that problem.

## Acceptance

This slice is accepted when all of the following are true:

- deterministic neighbors lookup works for page and section nodes
- deterministic path lookup finds expected shortest paths across section-to-page structural links
- no semantic or inferred edges are emitted
- benchmark workloads remain within local guardrails
- outputs remain grounded in page/section artifacts and source handles rather than free-form summaries

## Next Phase Boundary

If this slice succeeds, the next Phase 2 step can justify a small persisted map layer or scoped graph artifact because the required deterministic inputs and path behaviors will already be proven.

If it fails, the right fix is to improve manifest/section extraction or deterministic graph rules, not to skip ahead to semantic maps.
