**A sync on a Rust brain can now read its admitted writes, its concurrent-write proof and its admission effects, so it no longer stops where Postgres and PGLite keep going.**

### Changed
- A Rust brain now reads the writes a sync run admitted, the revision writer that proves a page moved under the run, and the `sync.admission` effects (a pinned pass and a pending delete) through typed engine members. Before, these reads stopped a Rust sync with a missing-member refusal.

### Fixed
- A Rust brain dates its `sync.admission` stamp at the moment it writes it, as Postgres and PGLite do. A delete queued earlier in the same transaction now counts as admitted before the stamp, so the sync waits for it.
- A new parity test checks that, on every engine, a sync pass whose matching lease has expired is not treated as pinned.
