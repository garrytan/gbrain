**On an experimental Rust brain, the background writer's effect pass now runs to the end: it no longer stops at the read that picks the next effect to claim. PGLite and Postgres brains send the same SQL as before.**

### Changed
- The effect claim's candidate read is a typed engine call, `selectClaimableEffect`: the oldest effect this host may claim now, locked for the claim's transaction. Postgres and PGLite send the same SQL text as before, byte for byte, from `src/core/engine-sql/persistence-effect-scans.ts`.
- On a Rust brain the read finds no effect, because the Rust store records none, so the pass ends with nothing to run. A host id that is not a uuid is refused the same way Postgres refuses it.

### Fixed
- Reading a write receipt (`get_write_request`) checks the writer's registration once again, not twice, so the receipt stays within its 9-statement budget.
