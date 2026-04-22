# MBrain Phase 2 Workspace Corpus Card Design

## Context

Phase 2 now has:

- persisted structural context maps
- context-map reports
- workspace system cards
- workspace project cards
- workspace orientation bundles

The next smallest follow-up is not a new persisted corpus tier. It is one
`workspace-corpus-card` read artifact that compresses the existing workspace
orientation bundle into a smaller prompt-budget summary.

## Recommendation

Add one additive `workspace-corpus-card` read artifact.

This slice should:

- consume the existing `workspace-orientation-bundle`
- expose the most important workspace anchors without nesting full card payloads
- keep a bounded `recommended_reads` list for fast orientation

This slice should not:

- add schema or persisted corpus-card rows
- re-run map selection logic outside the bundle
- invent corpus metadata not present in the bundle or canonical pages
- aggregate multiple projects or systems of the same kind

## Scope

This slice includes:

- one workspace corpus-card service
- one shared operation:
  - `workspace-corpus-card`
- local benchmark coverage for latency and correctness

This slice excludes:

- schema changes
- persisted report or card artifacts
- new map or atlas kinds
- broader corpus ranking or multi-card orchestration

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

- `card_kind` fixed to `workspace_corpus`
- `title`
- `map_id`
- `status`
- `anchor_slugs`
- `recommended_reads`
- `summary_lines`

## Locked Decisions

- top-level selection must reuse `workspace-orientation-bundle`
- the card must not read maps directly when a bundle is already available
- anchor slugs come only from attached system/project cards
- `recommended_reads` stays bounded and deterministic
- summary lines may mention:
  - map freshness/state
  - how many anchor artifacts are attached
  - whether system/project anchors are available
  - how many compact reads are exposed

## Query Behavior

### `workspace-corpus-card`

Returns one compact deterministic corpus-oriented card for the current workspace
scope.

The card layer must not:

- mutate canonical pages
- hide stale map status
- broaden retrieval beyond the chosen workspace orientation bundle
- include full nested workspace system/project card payloads

## Acceptance

This slice is accepted when:

- `workspace-corpus-card` returns a deterministic card when a workspace
  orientation bundle exists
- anchor slugs reflect the attached system/project cards when available
- no-bundle cases return a deterministic empty result
- benchmark and correctness checks pass under the local sqlite execution
  envelope

## Next Boundary

If this slice succeeds, the next smallest follow-up is a broader multi-card
orientation layer that can combine workspace corpus cards with map or atlas
reports without changing the deterministic bundle/card stack.
