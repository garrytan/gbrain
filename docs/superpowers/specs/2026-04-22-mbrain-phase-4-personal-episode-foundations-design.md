# Phase 4 Personal Episode Foundations Design

## Goal

Add the canonical append-only `Personal Episode` store and a minimal shared
operation surface for recording and inspecting personal-scope event history.

## Scope

- canonical `personal_episode_entries` storage
- append-only engine contract
- direct shared operations for `record`, `get`, and `list`
- deterministic dry-run preview for writes
- verification coverage for schema, persistence, and operation behavior

## Non-Goals

- personal-episode retrieval routing
- automatic promotion from episodes into profile memory
- mixed-scope episode reads or writes

## Acceptance

- schema exists across SQLite, PGLite, and Postgres
- engine supports create/get/list/delete for personal episodes
- `personal-episode-record`, `personal-episode-get`, and `personal-episode-list` are registered
- record dry-run preview and direct persistence both work deterministically
- `test:phase4` includes the personal-episode foundation coverage
