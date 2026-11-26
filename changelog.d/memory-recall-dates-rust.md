**On a Rust-engine brain, memory_recall's date read is now served; the verb still stops at one more read.**

### Fixed
- The read that gives each recalled fact its written date (the UTC day, including years before 100) is now a typed engine member, `readFactWrittenDates`, on all three engines. PGLite and Postgres send the same statement as before; the Rust engine answers it from its own store.

### Known gap
- `memory_recall` itself still refuses on a Rust-engine brain: the next read on its path, `ownMemberFactIds` (the own-page flag of each fact), is not served yet, and the brain owner's remote read is a separate named loss (row RA-1). Row 32e-b-7 of `docs/designs/RUST_ENGINE.md` tracks it as a swap blocker.
