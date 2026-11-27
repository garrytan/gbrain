**A new test fails when code sends statements straight to the database handle inside a transaction that shadow mode follows.**

### Changed
- Shadow mode only sees statements that go through the engine, so a statement sent directly to a transaction's database handle (`tx.sql`, `tx.db`, or a cast form such as `(tx as PostgresEngine).sql`) can escape its pre-read protection. A new structural test scans every code path in `src/` that starts at an engine transaction callback and fails on any such access, with the call chain that reached it. Three reviewed sites are listed with their reasons, and a second test fails if production code ever calls the index rebuild helper that one of them depends on. This is a test-only change; nothing runs differently for users.
