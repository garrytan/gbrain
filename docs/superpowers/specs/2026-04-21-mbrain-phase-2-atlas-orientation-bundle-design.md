# MBrain Phase 2 Atlas Orientation Bundle Design

## Context

Phase 2 now has:

- structural atlas selection
- atlas overview and atlas report artifacts
- atlas orientation cards

The next smallest follow-up is not a multi-atlas comparison layer. It is one
`atlas-orientation-bundle` read artifact that composes the existing atlas report
and atlas orientation card for the same selected atlas entry.

## Recommendation

Add one additive `atlas-orientation-bundle` read artifact.

This slice should:

- reuse the existing atlas report as the top-level selector
- reuse the existing atlas orientation card through direct `atlas_id`
- return one compact bundle for the chosen atlas entry

This slice should not:

- add schema or persisted bundle rows
- duplicate atlas selection logic
- synthesize semantic summaries beyond deterministic summary lines
- compare multiple atlas entries

## Scope

This slice includes:

- one atlas orientation bundle service
- one shared operation:
  - `atlas-orientation-bundle`
- local benchmark coverage for latency and correctness

This slice excludes:

- schema changes
- persisted atlas bundle artifacts
- multi-atlas ranking or comparison
- new atlas kinds

## Bundle Contract

Input should include:

- optional `atlas_id`
- optional `scope_id`
- optional `kind`
- optional `max_budget_hint`
- optional `allow_stale`

Output should include:

- `selection_reason`
- `candidate_count`
- `bundle`

`bundle` should include:

- `bundle_kind` fixed to `atlas_orientation`
- `title`
- `atlas_entry_id`
- `freshness`
- `budget_hint`
- `summary_lines`
- `report`
- `card`

## Locked Decisions

- top-level selection must reuse `atlas-report`
- the nested card must be loaded only through direct `atlas_id`
- the bundle must not rerun free-form atlas selection after a report is chosen
- summary lines may mention:
  - atlas freshness
  - atlas budget hint
  - recommended read count
  - anchor count

## Query Behavior

### `atlas-orientation-bundle`

Returns one compact deterministic atlas bundle for the current selection scope.

The bundle layer must not:

- mutate atlas or map rows
- hide stale atlas freshness
- mix report and card data from different atlas entries
- broaden retrieval beyond the chosen atlas entry

## Acceptance

This slice is accepted when:

- `atlas-orientation-bundle` returns a deterministic bundle when an atlas report
  exists
- the nested report and card resolve the same `atlas_entry_id`
- no-atlas cases return a deterministic empty result
- benchmark and correctness checks pass under the local sqlite execution
  envelope

## Next Boundary

If this slice succeeds, the next smallest follow-up is a broader multi-atlas or
comparison layer that can reason across multiple atlas bundles without changing
the deterministic single-atlas stack.
