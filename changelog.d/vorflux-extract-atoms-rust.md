**The atom extraction step of `gbrain dream` reports "no work" on a Rust brain when there is nothing to extract, and never spends model calls it cannot record.**

### Fixed
- On a Rust brain the extract_atoms phase used to refuse at its first statement, even with nothing to extract. Page discovery, the "already extracted" and tombstone checks, the atom-title lookup and the release of partial dispositions are now typed reads that the Rust store answers, so a run with no work reports `no_work` as it does on Postgres and PGLite.
- With work, a Rust brain now refuses by name ("the store keeps no extract_atoms page or transcript state") after discovery and before the first model call. It does not call the model and then fail to record the result. Postgres and PGLite send the same statements as before and are not affected.
