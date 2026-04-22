# Phase 4 Personal Profile Lookup Design

## Goal

Add the first bounded `personal_profile_lookup` retrieval route on top of a
canonical `Profile Memory` table.

## Scope

- canonical `profile_memory_entries` storage
- exact-subject lookup with optional `profile_type` disambiguation
- direct shared operation and retrieval-selector intent
- automatic scope-gate enforcement for `personal_profile_lookup`
- retrieval-trace support when a personal task thread requests trace persistence
- local benchmark and verification coverage

## Non-Goals

- `Personal Episode` storage or recall
- mixed-scope retrieval
- promotion/governance write path into profile memory
- fuzzy ranking or semantic personal recall

## Acceptance

- schema exists across SQLite, PGLite, and Postgres
- engine supports upsert/get/list/delete for profile memory
- route returns deterministic `direct_subject_match`, `ambiguous_subject_match`, and `no_match`
- selector dispatches `personal_profile_lookup` only after the scope gate allows personal scope
- persisted traces record both personal route selection and scope-gate evidence
- benchmark reports `personal_profile_lookup_route` and `personal_profile_lookup_route_correctness`
- local acceptance reports `phase4_status: pass`
