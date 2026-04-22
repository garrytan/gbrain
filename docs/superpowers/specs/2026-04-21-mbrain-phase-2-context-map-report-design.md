# MBrain Phase 2 Context Map Report Design

## Context

Phase 2 now has:

- deterministic note manifests
- deterministic note sections
- persisted context maps
- context-map stale disclosure
- persisted context-atlas registry entries
- atlas selection, overview, and report artifacts

The next smallest approved slice is not persisted cards or semantic clustering. It is one read-only `context-map-report` artifact over the persisted map layer so broad-synthesis flows can consume a compact map-oriented orientation output without going through atlas registry first.

## Recommendation

Add one additive `context-map-report` read artifact over persisted context maps.

This slice should:

- accept either `map_id` or `scope_id/kind`
- read the stale-aware map service as the source of truth
- return deterministic summary lines plus bounded recommended reads

This slice should not:

- persist report files or rows
- infer semantic communities or bridges
- rebuild maps on demand
- require atlas registry to exist

## Scope

This slice includes:

- one report service over persisted context maps
- one shared operation:
  - `map-report`
- local benchmark coverage for report latency and correctness

This slice excludes:

- schema changes
- persisted `reportPath`
- semantic ranking or route planning
- free-form summarization

## Report Contract

Input should include:

- optional `map_id`
- optional `scope_id`
- optional `kind`

Output should include:

- `selection_reason`
- `candidate_count`
- `report`

`report` should include:

- `report_kind` fixed to `structural`
- `title`
- `map_id`
- `status`
- `summary_lines`
- `recommended_reads`

## Locked Decisions

- if `map_id` is provided, the service must read that map directly
- if `map_id` is omitted, selection is deterministic:
  - scope match
  - kind match when provided
  - `ready` before `stale`
  - newest `generated_at`
  - lexicographic `id`
- recommended reads are derived from existing graph nodes, not inferred semantics
- page nodes are preferred before section nodes
- stale reports must include an explicit rebuild warning
- fresh reports must include an explicit orientation-safe statement

## Query Behavior

### `map-report`

Returns a compact, human-readable report for the chosen persisted map.

The report layer must not:

- mutate map state
- invent new graph nodes
- synthesize semantic claims
- hide stale freshness

## Acceptance

This slice is accepted when:

- `map-report` returns deterministic report output for a selected map
- direct `map_id` reads reuse the same report path
- stale reports include an explicit warning
- fresh reports include orientation-safe disclosure
- benchmark and correctness checks pass under the local sqlite execution envelope

## Next Boundary

If this slice succeeds, the next smallest follow-up is a richer project/corpus card layer over map and atlas report primitives.

If it fails, the fix should remain inside deterministic report rendering and map selection. It should not jump ahead to persisted cards, semantic summaries, or route planning.
