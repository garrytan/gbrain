**`gbrain doctor` on a Rust-engine brain no longer fails a read-only skill-pack source as a source that never synced.**

### Fixed
- A source that holds an adopted, read-only skill pack has no commits to sync, so `sync_freshness` exempts it. On a Rust brain that exemption read through raw SQL, which the engine refuses, so the check judged the pack source as a git source with no successful sync and failed with a false "run `gbrain sync`" fix. The check now reads the adopted packs through a typed engine read and gives the same answer as PGLite and Postgres.
