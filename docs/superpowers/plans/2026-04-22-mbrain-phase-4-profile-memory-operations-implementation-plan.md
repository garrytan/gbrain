# Phase 4 Profile Memory Operations Implementation Plan

1. Add a failing operation test for `upsert`, `get`, and `list` profile-memory surfaces.
2. Add three shared operations on top of the existing profile-memory engine CRUD.
3. Add deterministic dry-run behavior for the upsert operation.
4. Fold the new test into `test:phase4` and `docs/MBRAIN_VERIFY.md`.
5. Run the new operation test, then rerun `test:phase4`.
