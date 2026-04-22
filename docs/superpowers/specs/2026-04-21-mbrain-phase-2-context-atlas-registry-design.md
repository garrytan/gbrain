# MBrain Phase 2 Context Atlas Registry Design

## Context

Phase 2 now has:

- deterministic note manifests
- deterministic note sections
- persisted structural context maps
- staleness-aware context-map reads

The next smallest approved slice is not atlas routing, report generation, or multi-map ranking. It is the first durable registry layer over persisted maps so the system can discover which maps exist and whether they are safe to trust.

## Recommendation

Add one additive `context_atlas_entries` registry that indexes persisted context maps.

This slice should:

- read from `context_map_entries`
- materialize one atlas entry per persisted map
- expose atlas inspection through:
  - `atlas-build`
  - `atlas-get`
  - `atlas-list`

This slice should not:

- answer routing questions
- recommend which atlas entry to use for a prompt
- generate summary cards or reports
- cluster or rank atlas entries

## Scope

This slice includes:

- additive atlas registry schema and engine support
- one deterministic builder over existing context maps
- one default atlas entry kind for the current scope-bounded workspace map
- entrypoint extraction from existing map graph payloads
- local benchmark coverage for atlas build/get/list correctness and latency

This slice excludes:

- automatic rebuild on canonical writes
- atlas routing policies
- task, repo, corpus, or personal atlas selection logic
- summaryCardPath generation
- semantic entrypoints or inferred bridges

## Data Model

Each atlas entry should include:

- `id`
- `map_id`
- `scope_id`
- `kind`
- `title`
- `freshness`
- `entrypoints`
- `budget_hint`
- `generated_at`

### Locked decisions

- `id` is deterministic for this slice: `context-atlas:workspace:<scope_id>`
- `map_id` points to `context-map:workspace:<scope_id>`
- `kind` is fixed to `workspace`
- `freshness` is derived from the staleness-aware context-map read:
  - `fresh` when map status is `ready`
  - `stale` when map status is `stale`
- `entrypoints` are the first bounded set of structural anchor nodes:
  - page nodes first
  - sorted deterministically
  - capped to a small fixed budget
- `budget_hint` is a small integer hint for later prompt loading, not a policy engine

## Build Behavior

The atlas builder must:

1. Read the persisted structural workspace map through the stale-aware context-map service.
2. Extract a small deterministic atlas summary from the existing graph payload.
3. Persist one atlas entry linked to the map id.
4. Replace any existing deterministic atlas entry for the same scope.

The builder must not:

- mutate context-map payloads
- invent semantic bridges
- write canonical summaries back into Markdown
- hide stale map state

## Query Behavior

### `atlas-build`

Builds or rebuilds the atlas registry entry for the persisted structural workspace map.

### `atlas-get`

Reads one persisted atlas entry by id.

### `atlas-list`

Lists persisted atlas entries for a scope so later routing work has a stable registry primitive.

## Acceptance

This slice is accepted when:

- a persisted atlas entry can be built from the existing workspace map
- `atlas-get` returns the linked map id, freshness, bounded entrypoints, and budget hint
- `atlas-list` returns atlas summaries for the scope
- stale context maps produce stale atlas freshness
- benchmark and correctness checks pass under the local sqlite execution envelope

## Next Boundary

If this slice succeeds, the next smallest follow-up is atlas selection or routing behavior over multiple atlas entries.

If it fails, the fix should remain inside atlas registry derivation. It should not jump ahead to summary cards, semantic ranking, or prompt-time routing.
