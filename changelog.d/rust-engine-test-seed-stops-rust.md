**On a Rust brain, `gbrain sync`'s pending output and the doctor's managed-sync latency check now report the embedding backlog instead of refusing.**

### Fixed
- The per-source embedding backlog (how many chunks still wait for a vector, and how long the oldest has waited) was read with raw SQL, which a Rust brain refuses. It is now a typed engine read. PGLite and Postgres send the same statement as before. On Rust, it counts only the live body of a segmented page, as the SQL engines do, so a rewrite that is still staging does not double the count.

### For contributors
- The repair orphan-bindings parity case seeds its bindings through the claim store instead of raw SQL, and the segment pending-stamp cases read back through typed reads. Both files now compare equal on all three engines.
