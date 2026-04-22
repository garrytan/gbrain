# Phase 5 Memory Inbox Foundations Design

## Goal

Add the first canonical governance-state store for `mbrain`: `Memory Candidate`
records inside a `Memory Inbox`, without yet implementing promotion,
contradiction resolution, or target-domain writes.

## Scope

- add canonical `memory_candidate_entries` storage
- support deterministic candidate creation, direct read, filtered list, and
  bounded status transitions
- preserve provenance, scope, sensitivity, and target-domain metadata on every
  candidate
- expose the inbox foundation through shared operations
- add benchmark and Phase 5 acceptance coverage for the foundation slice

## Non-Goals

- promotion into canonical memory domains
- rejection or supersession outcomes beyond status persistence
- contradiction graphing or duplicate merge logic
- automatic candidate generation from map analysis
- human review UI

## Candidate Model

The foundation slice should store at least:

- `id`
- `scope_id`
- `candidate_type`
- `proposed_content`
- `source_refs`
- `generated_by`
- `extraction_kind`
- `confidence_score`
- `importance_score`
- `recurrence_score`
- `sensitivity`
- `status`
- `target_object_type`
- `target_object_id`
- `created_at`
- `reviewed_at`
- `review_reason`

## Status Rules

The foundation slice supports only the safe early lifecycle:

```text
captured -> candidate -> staged_for_review
```

Rules:

- creation defaults to `captured`
- status may advance one step at a time through the published path
- invalid backward or skipped transitions are rejected
- later statuses such as `promoted`, `rejected`, and `superseded` remain for
  later Phase 5 slices

## Operations

This slice should expose:

- `create-memory-candidate`
- `get-memory-candidate`
- `list-memory-candidates`
- `advance-memory-candidate-status`

The shared contract must remain contract-first, with thin CLI/MCP adapters.

## Acceptance

- inbox foundation is durable across SQLite, PGLite, and Postgres
- candidate records preserve provenance and sensitivity metadata
- bounded status transitions are deterministic
- benchmark reports `memory_inbox_foundations` and
  `memory_inbox_foundations_correctness`
- `phase5-acceptance` starts with this slice as its first published benchmark
