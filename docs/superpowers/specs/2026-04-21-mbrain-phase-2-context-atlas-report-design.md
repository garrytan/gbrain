# MBrain Phase 2 Context Atlas Report Design

## Context

Phase 2 now has:

- deterministic note manifests
- deterministic note sections
- persisted context maps
- persisted context-atlas registry entries
- atlas selection
- atlas overview artifacts

The next smallest approved slice is not persisted summary cards or semantic synthesis. It is one read-only report artifact over `atlas-overview` so broad-synthesis flows can consume a compact, human-readable orientation output without re-rendering overview data ad hoc.

## Recommendation

Add one additive `atlas-report` read artifact over the existing atlas overview service.

This slice should:

- accept either `atlas_id` or atlas selection params
- reuse `atlas-overview` as the only source of truth
- return a compact report with deterministic summary lines and recommended reads

This slice should not:

- persist report files or report rows
- generate prose with an LLM
- infer semantic communities or bridges
- rebuild maps or atlas entries on demand

## Scope

This slice includes:

- one report service over `atlas-overview`
- one shared operation:
  - `atlas-report`
- local benchmark coverage for report latency and correctness

This slice excludes:

- new schema or migrations
- persisted `reportPath` or `summaryCardPath`
- semantic ranking or route planning
- free-form summarization

## Report Contract

Input should include:

- optional `atlas_id`
- optional `scope_id`
- optional `kind`
- optional `max_budget_hint`
- optional `allow_stale`

Output should include:

- `selection_reason`
- `candidate_count`
- `report`

`report` should include:

- `report_kind` fixed to `structural`
- `title`
- `entry_id`
- `freshness`
- `summary_lines`
- `recommended_reads`

## Locked Decisions

- `atlas-report` must call `atlas-overview`, not re-implement selection logic
- `summary_lines` must be deterministic and bounded
- summary lines may mention:
  - freshness
  - budget hint
  - count of recommended reads
- stale reports must include an explicit rebuild warning
- fresh reports must include an explicit orientation-safe statement
- `recommended_reads` are reused directly from the overview artifact

## Query Behavior

### `atlas-report`

Returns a compact, human-readable report for the chosen atlas artifact.

The report layer must not:

- mutate atlas or overview state
- invent new entrypoints
- synthesize semantic claims
- hide stale freshness

## Acceptance

This slice is accepted when:

- `atlas-report` returns deterministic report output for a selected atlas
- direct `atlas_id` reads reuse the same report path
- stale reports include an explicit warning
- fresh reports include orientation-safe disclosure
- benchmark and correctness checks pass under the local sqlite execution envelope

## Next Boundary

If this slice succeeds, the next smallest follow-up is a richer map-report or project-card layer over the same overview/report primitives.

If it fails, the fix should remain inside deterministic report rendering. It should not jump ahead to persisted cards, semantic summaries, or route planning.
