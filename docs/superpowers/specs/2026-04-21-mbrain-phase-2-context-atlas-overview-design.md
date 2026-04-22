# MBrain Phase 2 Context Atlas Overview Design

## Context

Phase 2 now has:

- deterministic note manifests
- deterministic note sections
- persisted structural context maps
- persisted context-atlas registry entries
- deterministic atlas selection

The next smallest approved slice is not persisted map reports, summary-card files, or semantic orientation. It is one read-only overview artifact that turns the selected atlas entry into a compact, human-readable orientation payload.

## Approaches

### Option 1: Persist atlas report artifacts

This would add a new table or file artifact for overview cards and rebuild them alongside atlas entries.

- Pros: fast reads later
- Cons: extra lifecycle, extra staleness rules, and more derived state than this phase needs

### Option 2: Build the overview on read from existing atlas and map state

This reads one atlas entry, resolves bounded entrypoints through manifests and sections, and returns a compact payload.

- Pros: smallest diff, no new schema, freshness stays honest
- Cons: read path does a bit more work each time

### Option 3: Jump directly to broader routing reports

This would mix overview output with route planning, map reports, and prompt-time guidance.

- Pros: more ambitious surface
- Cons: wrong phase boundary and too much policy at once

## Recommendation

Choose `Option 2`.

Add one `atlas-overview` read artifact that:

- accepts either `atlas_id` or atlas selection params
- resolves the chosen atlas entry
- returns compact metadata plus bounded recommended reads

This slice should not:

- persist overview artifacts
- generate prose summaries with an LLM
- rank semantic relevance
- rebuild maps or atlas rows on demand

## Scope

This slice includes:

- one overview service over the existing atlas selection and atlas read paths
- one shared operation:
  - `atlas-overview`
- deterministic resolution of atlas entrypoints into recommended reads
- local benchmark coverage for overview latency and correctness

This slice excludes:

- new schema or migrations
- summaryCardPath persistence
- map reports, corpus cards, or project cards
- prompt routing policy

## Overview Contract

Input should include:

- optional `atlas_id`
- optional `scope_id`
- optional `kind`
- optional `max_budget_hint`
- optional `allow_stale`

Output should include:

- `selection_reason`
- `candidate_count`
- `overview`

`overview` should include:

- `overview_kind` fixed to `structural`
- `entry` — the resolved atlas entry
- `recommended_reads` — bounded resolved entrypoints

Each recommended read should include:

- `node_id`
- `node_kind`
- `label`
- `page_slug`
- `path`
- optional `section_id`

## Locked Decisions

- if `atlas_id` is provided, the service must read that atlas entry directly
- if `atlas_id` is omitted, the service must reuse deterministic atlas selection
- recommended reads are resolved only from existing `entrypoints`
- page entrypoints resolve through `note_manifest_entries`
- section entrypoints resolve through `note_section_entries`
- unresolved entrypoints are omitted from `recommended_reads`
- `recommended_reads` stays bounded by the existing atlas entrypoint budget
- freshness must be disclosed exactly as the atlas read path reports it

## Query Behavior

### `atlas-overview`

Returns one compact overview artifact for the chosen atlas entry.

The overview service must not:

- mutate atlas rows
- synthesize new entrypoints
- infer semantic relationships
- hide stale freshness

## Acceptance

This slice is accepted when:

- `atlas-overview` returns a compact structural overview for a selected atlas entry
- direct `atlas_id` reads work without re-running selection
- recommended reads resolve page and section entrypoints deterministically
- stale atlas freshness is visible through the overview artifact
- benchmark and correctness checks pass under the local sqlite execution envelope

## Next Boundary

If this slice succeeds, the next smallest follow-up is a richer orientation/report layer over atlas overview output.

If it fails, the fix should remain inside overview rendering and entrypoint resolution. It should not jump ahead to persisted reports, semantic ranking, or automatic route planning.
