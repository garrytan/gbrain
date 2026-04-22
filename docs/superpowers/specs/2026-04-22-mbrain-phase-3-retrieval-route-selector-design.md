# Phase 3 Retrieval Route Selector Design

## Goal

Expose one bounded operation that selects a retrieval route by explicit intent
and delegates to the already-published route primitives.

## Scope

- explicit `task_resume`, `broad_synthesis`, `precision_lookup` intents only
- additive selector surface over existing services
- no automatic intent inference
- no automatic Retrieval Trace writes

## Contract

Input carries:

- `intent`
- only the fields needed for that intent

Output carries:

- selected intent
- selection reason and candidate count from the delegated route
- normalized `route_kind`
- explicit `retrieval_route`
- delegated payload unchanged

## Non-Goals

- personal/profile lookup routing
- cross-intent decomposition
- source-record routing outside the note corpus
- code verification orchestration

## Acceptance

- task, synthesis, and precision intents all dispatch correctly
- missing targets degrade explicitly
- CLI help and benchmark are published
- local acceptance reports `phase3_status: pass`
