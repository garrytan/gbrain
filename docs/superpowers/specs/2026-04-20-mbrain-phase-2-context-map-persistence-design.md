# MBrain Phase 2 Context Map Persistence Design

## Context

Phase 2 now has three proven deterministic layers:

- `Note Manifest`
- `note_section_entries`
- in-memory structural `neighbors` and `path`

The next smallest step toward the approved `Context Map` workstream is to persist a scope-bounded structural map artifact without jumping ahead to atlas routing, reports, semantic extraction, or inferred bridges.

The question for this slice is narrow: can `mbrain` materialize a deterministic structural map artifact that is rebuildable from existing derived inputs and cheap to inspect later?

## Approaches Considered

### Option 1: Jump directly to Context Atlas and report artifacts

This would add map persistence, atlas indexing, project cards, and report generation at once.

This is rejected. It combines multiple independent concerns and would make failures hard to localize.

### Option 2: Persist individual structural edges only

This would store page/section edges durably but still require each consumer to reconstruct map-level metadata and graph payloads.

This is workable, but it is the wrong abstraction level for the next step. We already proved the edge model in memory. The next question is whether we can persist a scope-bounded map artifact, not whether we can duplicate raw edges in another table.

### Option 3: Persist one deterministic structural context-map artifact

This stores a rebuildable graph snapshot plus the smallest metadata needed for staleness and inspection. It keeps scope explicit, does not add atlas behavior, and reuses the structural graph service as the only builder.

This is the recommended approach.

## Recommendation

Add a single persisted `context_map_entries` layer that stores:

- map identity and scope
- deterministic build metadata
- node and edge counts
- a JSON graph payload derived from the current structural graph snapshot

Then expose only:

- `map-build`
- `map-get`
- `map-list`

This keeps the slice additive and fully derived. A persisted map can be deleted and rebuilt without touching canonical Markdown.

## Scope

This slice includes:

- additive schema and engine support for persisted context maps
- one builder over the existing structural graph snapshot
- one default persisted map kind: `workspace`
- narrow inspection operations to build, get, and list maps
- a local benchmark for build/get/list correctness and latency

This slice excludes:

- `Context Atlas`
- project, corpus, task, or personal map selection logic
- map reports, workspace cards, or project cards
- semantic or inferred map edges
- automatic background refresh on canonical writes

## Data Model

Each persisted context map entry should include:

- `id`
- `scope_id`
- `kind`
- `title`
- `build_mode`
- `status`
- `source_set_hash`
- `extractor_version`
- `node_count`
- `edge_count`
- `community_count`
- `graph_json`
- `generated_at`
- `stale_reason`

### Locked decisions

- `id` is deterministic for this slice: `context-map:workspace:<scope_id>`
- `kind` is fixed to `workspace` for MVP
- `build_mode` is fixed to `structural`
- `status` is `ready` on successful builds
- `community_count` stays `0` until later slices add clustering
- `graph_json` stores the exact node and edge payload returned by the deterministic structural graph builder
- `source_set_hash` is derived from sorted manifest and section content hashes in scope

## Build Behavior

The builder must:

1. Read the latest manifest and section rows for the scope.
2. Build the structural graph snapshot using the existing deterministic graph service.
3. Compute `source_set_hash` from the underlying derived inputs.
4. Materialize a persisted map entry with counts and graph JSON.
5. Replace any existing entry for the same deterministic map id.

The builder must not:

- invent missing edges
- mix scopes
- write back into canonical note content
- claim freshness if the source set cannot be read

## Query Behavior

### `map-build`

Builds or rebuilds the persisted structural context map for the scope and returns summary metadata.

### `map-get`

Fetches one persisted map artifact by deterministic id. This is an inspection surface, not a routing engine.

### `map-list`

Lists persisted context map entries for a scope so later atlas work has a stable inspection primitive.

## Refresh and Staleness

This slice does not add implicit rebuild-on-write. Rebuild remains explicit through `map-build`.

Staleness rules for this slice:

- a persisted map is stale if its `source_set_hash` no longer matches the current manifest/section source set
- stale detection may be implemented as a helper during `map-build` and `map-get`
- stale maps must remain readable but disclose `stale_reason`

This is enough to support later refresh policies without adding background jobs now.

## Acceptance

This slice is accepted when:

- a persisted structural workspace map can be built deterministically from existing derived inputs
- `map-get` returns the stored graph payload and metadata
- `map-list` returns persisted map summaries
- rebuilds replace the previous persisted artifact cleanly
- benchmark and correctness checks pass under the local sqlite execution envelope

## Next Boundary

If this slice succeeds, the next smallest follow-up can either:

- add staleness-aware map refresh behavior, or
- add the first `Context Atlas` registry layer over persisted maps

If it fails, the fix should stay inside structural graph or map persistence. It should not jump ahead to semantic maps or atlas routing.
