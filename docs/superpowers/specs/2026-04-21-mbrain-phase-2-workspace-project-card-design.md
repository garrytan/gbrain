# MBrain Phase 2 Workspace Project Card Design

## Context

Phase 2 already has:

- persisted structural context maps
- context-map report artifacts
- workspace system-card rendering

The next smallest follow-up is not a generalized project/corpus-card system. It is one `workspace-project-card` artifact that reuses the existing map report and canonical project-page metadata to produce a compact orientation card for the most relevant project page visible in the current workspace.

## Recommendation

Add one additive `workspace-project-card` read artifact.

This slice should:

- consume the existing `context-map-report`
- choose one relevant `project` page from the recommended reads
- enrich the card with canonical project-page metadata that already exists

This slice should not:

- introduce new map kinds
- persist cards
- infer project ownership or status beyond explicit canonical metadata
- implement corpus-level aggregation

## Scope

This slice includes:

- one workspace project-card service
- one shared operation:
  - `workspace-project-card`
- local benchmark coverage for latency and correctness

This slice excludes:

- schema changes
- persisted card rows or files
- multi-card ranking
- generalized corpus-card orchestration

## Card Contract

Input should include:

- optional `map_id`
- optional `scope_id`
- optional `kind`

Output should include:

- `selection_reason`
- `candidate_count`
- `card`

`card` should include:

- `card_kind` fixed to `workspace_project`
- `project_slug`
- `title`
- `path`
- optional `repo`
- optional `status`
- `related_systems`
- `summary_lines`

## Locked Decisions

- the card must call `context-map-report`, not re-implement map selection
- the chosen project page is the first `projects/` page among recommended reads
- if no project page is present, the card is `null` with deterministic reason `no_project_read`
- `related_systems` come only from explicit canonical wikilinks already extracted into the Note Manifest
- `summary_lines` may mention:
  - report freshness/state
  - project path
  - repo availability
  - explicit status
  - linked system count

## Query Behavior

### `workspace-project-card`

Returns one compact orientation card for the most relevant project page visible from the current workspace map report.

The card layer must not:

- mutate canonical pages
- invent project metadata
- infer priorities or active work
- hide stale map status

## Acceptance

This slice is accepted when:

- `workspace-project-card` returns a deterministic card when a project page is available
- direct `map_id` reads reuse the same card path
- no-project cases return a deterministic empty result
- benchmark and correctness checks pass under the local sqlite execution envelope

## Next Boundary

If this slice succeeds, the next smallest follow-up is a generalized corpus or multi-card orientation layer that can compose project and system cards without duplicating selection logic.
