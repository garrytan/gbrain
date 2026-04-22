# Phase 4 Profile Memory Operations Design

## Goal

Expose the canonical `Profile Memory` table through shared `get`, `list`, and
`upsert` operations so the new personal retrieval stack has an actual write and
inspection surface.

## Scope

- direct shared operations for `profile_memory_entries`
- deterministic dry-run preview for writes
- default personal scope wiring
- verification coverage for write, direct read, and filtered list behavior

## Non-Goals

- `Personal Episode` writes
- automatic promotion from governance into profile memory
- fuzzy or semantic profile-memory search

## Acceptance

- `profile-memory-upsert`, `profile-memory-get`, and `profile-memory-list` are registered
- `upsert_profile_memory_entry` supports dry-run preview and deterministic defaults
- created entries are immediately readable through `get` and `list`
- `test:phase4` includes the new operation test coverage
