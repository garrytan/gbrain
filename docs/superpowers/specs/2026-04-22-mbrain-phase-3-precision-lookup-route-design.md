# Phase 3 Precision Lookup Route Design

## Goal

Add a bounded retrieval-protocol artifact for `precision lookup` intent so the
agent can route exact note/page/section reads without inflating the answer into
broad synthesis.

## Scope

- note-corpus canonical artifacts only
- exact page lookup by `slug`
- exact section lookup by `section_id`
- additive read-only operation surface
- benchmark and verification coverage

## Non-Goals

- external source-record routing
- live code verification
- automatic Retrieval Trace persistence
- route selection across all intents

## Route Contract

The route returns:

- exact target kind: `page` or `section`
- exact canonical path
- bounded retrieval route steps
- narrow supporting reads only
- explicit no-match degradation

## Acceptance

- service and operation tests cover page, section, and no-match cases
- CLI help is exposed
- benchmark reports `precision_lookup_route` and `precision_lookup_route_correctness`
- local acceptance reports `phase3_status: pass`
