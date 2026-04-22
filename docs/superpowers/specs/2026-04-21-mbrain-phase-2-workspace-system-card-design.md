# MBrain Phase 2 Workspace System Card Design

## Context

Phase 2 now has:

- persisted context maps
- context-map report artifacts
- persisted context-atlas registry entries
- atlas overview and report artifacts
- canonical system-page frontmatter with:
  - `repo`
  - `build_command`
  - `test_command`
  - `key_entry_points`

The next smallest approved slice is not a full project/corpus card system. It is one `workspace-system-card` artifact that reuses existing map report output plus canonical system-page metadata to produce a compact, actionable card for the most relevant system page in the current workspace orientation.

## Recommendation

Add one additive `workspace-system-card` read artifact.

This slice should:

- consume the existing `context-map-report`
- choose one relevant `system` page from the recommended reads
- enrich the card with canonical system-page frontmatter

This slice should not:

- introduce project or corpus map kinds
- persist card artifacts
- require atlas registry
- infer semantic ownership or business metadata

## Scope

This slice includes:

- one workspace system-card service
- one shared operation:
  - `workspace-system-card`
- local benchmark coverage for card latency and correctness

This slice excludes:

- schema changes
- persisted card rows or files
- multi-card ranking
- project/corpus-card orchestration

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

- `card_kind` fixed to `workspace_system`
- `system_slug`
- `title`
- optional `repo`
- optional `build_command`
- optional `test_command`
- `entry_points`
- `summary_lines`

## Locked Decisions

- the card must call `context-map-report`, not re-implement map selection
- the chosen system page is the first `system` page among recommended reads
- if no system page is present, the card is `null` with deterministic reason `no_system_read`
- `entry_points` come only from canonical `key_entry_points` frontmatter
- `summary_lines` may mention:
  - report freshness/state
  - repo
  - command availability
  - entry-point count

## Query Behavior

### `workspace-system-card`

Returns one compact actionable card for the most relevant system page visible from the current workspace map report.

The card layer must not:

- mutate canonical pages
- invent commands or entry points
- synthesize semantic summaries
- hide stale map status

## Acceptance

This slice is accepted when:

- `workspace-system-card` returns a deterministic card when a system page with frontmatter is available
- direct `map_id` reads reuse the same card path
- no-system cases return a deterministic empty result
- benchmark and correctness checks pass under the local sqlite execution envelope

## Next Boundary

If this slice succeeds, the next smallest follow-up is a generalized project/corpus card layer that can aggregate multiple cards and broader scope metadata.

If it fails, the fix should remain inside deterministic system-card rendering. It should not jump ahead to new map kinds, persisted cards, or semantic ranking.
