# Phase 4 Personal Episode Foundations Implementation Plan

1. Add failing schema, engine, and operation tests for canonical personal episodes.
2. Add personal-episode types, migration, row conversion, and engine CRUD across SQLite, PGLite, and Postgres.
3. Add append-only shared operations for `record`, `get`, and `list`.
4. Add deterministic dry-run behavior for the record operation.
5. Fold the new tests into `test:phase4` and `docs/MBRAIN_VERIFY.md`.
6. Run the targeted personal-episode tests, then rerun `test:phase4`.
