# MBrain Phase 2 Context Atlas Selection Design

## Context

Phase 2 now has:

- deterministic note manifests
- deterministic note sections
- persisted structural context maps
- staleness-aware context-map reads
- persisted context-atlas registry entries

The next smallest approved slice is not report generation, semantic ranking, or multi-map routing. It is one deterministic selection primitive over the existing atlas registry so later retrieval code can choose a compact orientation artifact without re-implementing registry policy inline.

## Recommendation

Add one additive `atlas-select` operation over the persisted atlas registry.

This slice should:

- read from persisted atlas entries only
- apply deterministic filters for scope, kind, freshness, and optional budget
- return one selected atlas entry plus a compact selection reason

This slice should not:

- generate cards or reports
- rank semantically similar maps
- choose between personal and workspace scope automatically
- rebuild maps or atlas entries as part of selection

## Scope

This slice includes:

- a selection service over the existing atlas registry
- one shared operation:
  - `atlas-select`
- deterministic reason strings for no-match and selected-match outcomes
- local benchmark coverage for selection latency and correctness

This slice excludes:

- any schema migration
- new atlas kinds or new map builders
- prompt-time routing policies beyond selecting one atlas entry
- inferred or semantic entrypoints

## Selection Contract

Selection input should include:

- `scope_id`
- optional `kind`
- optional `max_budget_hint`
- optional `allow_stale`

Selection output should include:

- `entry` — the chosen atlas entry or `null`
- `reason` — deterministic explanation for the outcome
- `candidate_count` — number of atlas entries considered before final filtering

## Locked Decisions

- `scope_id` is required for selection and defaults to `workspace:default`
- `kind` narrows candidates before ranking
- `allow_stale` defaults to `false`
- `max_budget_hint` is a hard filter, not a scoring signal
- selection order is:
  1. scope match
  2. kind match when provided
  3. freshness gate (`fresh` only unless `allow_stale=true`)
  4. `budget_hint <= max_budget_hint` when provided
  5. newest `generated_at`
  6. lexicographic `id`

## Query Behavior

### `atlas-select`

Returns the best atlas entry for the requested scope under the deterministic rules above.

The selector must not:

- mutate atlas rows
- rebuild stale entries
- synthesize summary text
- infer hidden relevance from node labels or graph payloads

## Acceptance

This slice is accepted when:

- `atlas-select` returns the fresh matching atlas entry for a scope
- `kind` filtering works deterministically
- `max_budget_hint` excludes over-budget entries
- `allow_stale=false` rejects stale-only candidates
- `allow_stale=true` can still return a stale match when no fresh match exists
- benchmark and correctness checks pass under the local sqlite execution envelope

## Next Boundary

If this slice succeeds, the next smallest follow-up is a routing-facing atlas overview artifact or a broader multi-map routing layer.

If it fails, the fix should stay inside deterministic selection behavior. It should not jump ahead to semantic ranking, map reports, or automatic rebuild policies.
