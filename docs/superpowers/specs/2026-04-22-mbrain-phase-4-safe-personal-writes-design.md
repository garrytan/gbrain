# Phase 4 Safe Personal Writes Design

## Goal

Expose agent-facing personal write operations that cannot create durable personal
records unless `personal_write_target` preflight has already allowed the write.

## Scope

- `profile-memory-write` as a safe wrapper over canonical profile-memory upsert
- `personal-episode-write` as a safe wrapper over canonical personal-episode append
- deny and defer disclosures that prevent accidental personal writes from work scope
- Phase 4 verification coverage for allowed writes and blocked writes

## Non-Goals

- replacing low-level canonical CRUD operations
- adding write traces or governance state in this slice
- auto-converting one write target into the other
- changing the published Phase 4 benchmark pack

## Acceptance

- `profile-memory-write` and `personal-episode-write` stay available through the shared operation surface
- allowed writes persist canonical records in the expected personal store
- denied writes do not create durable records
- `test:phase4` includes safe personal write coverage
