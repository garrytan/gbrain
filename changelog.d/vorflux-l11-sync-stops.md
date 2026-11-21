**A sync on a Rust brain now gets further: it can read and record its import provenance, its page join, its admitted writes, its concurrent-write proof and its admission effects, so it no longer stops where Postgres and PGLite keep going.**

### Changed
- A Rust brain now records and reads where each synced page came from (its sync import provenance) through typed engine members. Before, the git-gap census stopped on a Rust brain with a missing-member refusal.
- A Rust brain now reads a sync pass's page join and the `sync.admission` switch through typed engine members. The whole-source cursor that Postgres uses still refuses by name on Rust.
- A Rust brain now reads the writes a sync run admitted, the revision writer that proves a page moved under the run, and the `sync.admission` effects (a pinned pass and a pending delete) through typed engine members. Before, these reads stopped a Rust sync with a missing-member refusal.

### Fixed
- On Postgres, a sync pass now sees which pages were imported with the current parser. Before, the expected parser was sent in a form that never matched, so every page looked as if a different parser had imported it. The pass compared the parser fields again later, so this cost extra work and gave no wrong result.
- A Rust brain dates its `sync.admission` stamp at the moment it writes it, as Postgres and PGLite do. A delete queued earlier in the same transaction now counts as admitted before the stamp, so the sync waits for it.
