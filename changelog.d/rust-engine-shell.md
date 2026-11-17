**The Rust engine has a shell that refuses every storage call with a typed error until its storage lands; PGLite and Postgres brains are unchanged.**

### Added
- `openRustEngine({ addon, databasePath })` (`src/core/rust-engine.ts`) builds the Rust engine shell around an addon the loader already verified. It reports no capabilities. Plan: https://github.com/garrytan/gbrain/pull/9593, "PR sequence" step 8.
- Every `BrainEngine` member the shell does not implement refuses `engine_capability_missing` with the capability as its reason and `written=nothing`, before any work. `src/core/rust-engine/members.ts` classifies each member, and the type fails when a new member is left out.

### Changed
- Every place that assumed exactly two engine kinds now handles the Rust kind (`EngineKind`, `src/core/sql-engine-kind.ts`): SQL-only paths (migrations, cycle locks, engine migration and graduation, embed backfill, page-body batch sizes) refuse it with `engine_capability_missing` instead of treating it as Postgres. The graduation inventory records `rust: false` on every relation.
