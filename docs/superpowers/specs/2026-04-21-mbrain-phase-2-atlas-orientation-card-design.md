# MBrain Phase 2 Atlas Orientation Card Design

## Context

Phase 2 now has:

- structural context atlases with deterministic selection
- atlas overview and atlas report read artifacts
- workspace orientation bundles
- workspace corpus cards

The next smallest follow-up is not a richer atlas persistence tier. It is one
`atlas-orientation-card` read artifact that applies atlas selection and then
projects the selected map into the existing workspace corpus-card layer.

## Recommendation

Add one additive `atlas-orientation-card` read artifact.

This slice should:

- consume the existing structural atlas selection or direct atlas id lookup
- reuse the existing workspace corpus card for the selected atlas map
- surface atlas freshness and budget metadata next to the compact anchor reads

This slice should not:

- add schema or persisted orientation-card rows
- bypass atlas selection rules
- build maps or corpus cards from scratch
- generalize beyond the current workspace atlas contract

## Scope

This slice includes:

- one atlas orientation-card service
- one shared operation:
  - `atlas-orientation-card`
- local benchmark coverage for latency and correctness

This slice excludes:

- schema changes
- persisted atlas card artifacts
- new atlas kinds or scope rules
- multi-atlas aggregation

## Card Contract

Input should include:

- optional `atlas_id`
- optional `scope_id`
- optional `kind`
- optional `max_budget_hint`
- optional `allow_stale`

Output should include:

- `selection_reason`
- `candidate_count`
- `card`

`card` should include:

- `card_kind` fixed to `atlas_orientation`
- `title`
- `atlas_entry_id`
- `map_id`
- `freshness`
- `budget_hint`
- `anchor_slugs`
- `recommended_reads`
- `summary_lines`

## Locked Decisions

- top-level routing must reuse atlas selection behavior
- direct `atlas_id` lookup is allowed, but it must still respect the persisted atlas
  entry
- corpus-card output stays bounded and deterministic
- summary lines may mention:
  - atlas freshness
  - atlas budget hint
  - attached anchor count
  - compact read count

## Query Behavior

### `atlas-orientation-card`

Returns one compact deterministic orientation card for the chosen atlas scope.

The card layer must not:

- mutate atlas or map rows
- hide stale atlas freshness
- bypass the selected atlas entry and reach into unrelated maps
- expose full nested corpus-card payloads

## Acceptance

This slice is accepted when:

- `atlas-orientation-card` returns a deterministic card when a matching atlas
  entry exists
- direct `atlas_id` lookup resolves the same underlying map contract
- no-match cases return a deterministic empty result
- benchmark and correctness checks pass under the local sqlite execution
  envelope

## Next Boundary

If this slice succeeds, the next smallest follow-up is a broader multi-atlas or
multi-card orientation layer that can compare atlas outputs without changing the
deterministic atlas-to-corpus-card stack.
