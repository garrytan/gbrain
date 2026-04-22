# Phase 4 Personal Profile Lookup Implementation Plan

1. Add failing schema, engine, route, operation, selector, trace, and benchmark tests for personal profile lookup.
2. Add `profile_memory_entries` types, migration, and engine CRUD across SQLite, PGLite, and Postgres.
3. Add a deterministic `personal-profile-lookup-route` service and shared operation.
4. Extend the scope gate and retrieval selector with the `personal_profile_lookup` intent.
5. Extend retrieval traces so personal route selections record scope-gate evidence and profile-memory refs.
6. Publish a `phase4-personal-profile-lookup` benchmark and package scripts.
7. Document verification commands in `docs/MBRAIN_VERIFY.md`.
8. Run targeted tests and benchmark, then broader regression because selector and operation wiring changed.
