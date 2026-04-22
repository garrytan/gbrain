# MBrain Phase 2 Context Map Staleness Design

## Context

Phase 2 now persists one deterministic structural workspace map through `context_map_entries`.

What is still missing is honest freshness reporting. Today the stored map can become outdated after manifest or section rows change, but `map-get` and `map-list` still return the persisted row as if it were current.

The next smallest slice is to add staleness disclosure without introducing background refresh or atlas routing.

## Recommendation

Keep the current operation surface:

- `map-build`
- `map-get`
- `map-list`

Add a small service layer that:

1. recomputes the current manifest/section source-set hash for a scope
2. compares it with the persisted `source_set_hash`
3. returns a derived view of the map with:
   - `status: "stale"` when the hashes differ
   - `stale_reason: "source_set_changed"` when stale
   - `status: "ready"` and `stale_reason: null` when current

## Scope

This slice includes:

- deterministic source-set hash reuse as a shared helper
- staleness-aware read helpers for one map and many maps
- operation updates so `map-get` and `map-list` disclose stale state
- correctness coverage proving that a canonical note change marks the persisted map stale until explicit rebuild
- benchmark coverage that includes stale detection in the published acceptance path

This slice excludes:

- automatic rebuild on canonical write
- background map maintenance
- new CLI operations
- atlas or routing behavior

## Locked Decisions

- stale detection remains explicit on read; it does not mutate stored rows
- stale maps remain readable
- `map-build` remains the only way to refresh the persisted artifact
- stale reason is fixed to `source_set_changed` for this slice

## Acceptance

This slice is accepted when:

- `map-get` returns `status: stale` after manifest/section source hashes change
- `map-list` returns stale summaries for outdated persisted maps
- explicit `map-build` returns the map to `status: ready`
- benchmark and correctness tests continue to pass on the local sqlite envelope
