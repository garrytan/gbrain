# MBrain Phase 2 Workspace Orientation Bundle Design

## Context

Phase 2 now has:

- persisted structural context maps
- context-map reports
- workspace system-card rendering
- workspace project-card rendering

The next smallest follow-up is not a generalized corpus-card layer or a new persistence tier. It is one `workspace-orientation-bundle` read artifact that composes the existing workspace map report plus the existing workspace system/project cards into one compact orientation surface.

## Recommendation

Add one additive `workspace-orientation-bundle` read artifact.

This slice should:

- consume the existing `context-map-report`
- attach the existing `workspace-system-card` when a system page is available
- attach the existing `workspace-project-card` when a project page is available

This slice should not:

- introduce new schema or persisted bundle rows
- re-implement map selection logic
- synthesize semantic summaries beyond deterministic summary lines
- aggregate multiple cards of the same kind

## Scope

This slice includes:

- one workspace orientation bundle service
- one shared operation:
  - `workspace-orientation`
- local benchmark coverage for latency and correctness

This slice excludes:

- schema changes
- persisted bundle artifacts
- multi-card ranking or corpus aggregation
- new map or atlas kinds

## Bundle Contract

Input should include:

- optional `map_id`
- optional `scope_id`
- optional `kind`

Output should include:

- `selection_reason`
- `candidate_count`
- `bundle`

`bundle` should include:

- `bundle_kind` fixed to `workspace_orientation`
- `title`
- `map_id`
- `status`
- `summary_lines`
- `recommended_reads`
- optional `system_card`
- optional `project_card`

## Locked Decisions

- top-level selection must reuse `context-map-report`
- the bundle must not fetch or build maps directly
- `system_card` and `project_card` remain optional
- summary lines may mention:
  - map freshness/state
  - whether a system card is attached
  - whether a project card is attached
  - recommended read count

## Query Behavior

### `workspace-orientation`

Returns one compact deterministic orientation bundle for the current workspace scope.

The bundle layer must not:

- mutate canonical pages
- invent cards that the underlying services did not return
- hide stale map status
- broaden retrieval beyond the chosen map report

## Acceptance

This slice is accepted when:

- `workspace-orientation` returns a deterministic bundle when a workspace map report exists
- system/project cards are attached when available and omitted when absent
- no-map cases return a deterministic empty result
- benchmark and correctness checks pass under the local sqlite execution envelope

## Next Boundary

If this slice succeeds, the next smallest follow-up is a corpus or multi-card orientation layer that generalizes bundle composition without changing the underlying deterministic card services.
