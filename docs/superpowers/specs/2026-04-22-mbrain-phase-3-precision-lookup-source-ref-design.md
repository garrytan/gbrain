# Phase 3 Precision Lookup Source Ref Design

## Goal

Extend note-corpus precision lookup so callers can anchor retrieval to an exact
`source_ref` already extracted into note manifest and note section caches.

## Scope

- exact `source_ref` matching against existing `source_refs`
- section-first resolution, then page fallback
- unique-match only; ambiguous citations degrade explicitly
- additive extension to existing `precision-lookup-route` and `retrieval-route`

## Non-Goals

- introducing first-class Source Record storage
- fuzzy citation matching
- multi-candidate ranking for ambiguous citations

## Acceptance

- service resolves a uniquely cited section by `source_ref`
- operation exposes the same behavior
- retrieval-route selector exposes the same behavior
- benchmarks cover the source-ref case and still pass
