**On the Rust engine, a member without the labelled-only grant can write on a brain where another member has it.**

### Fixed
- On a brain with the Rust engine where some member has the labelled-only grant, every remote write by any other member (`put_page`, `capture`) was refused, because the write check read the brain owner with raw SQL. It now reads the owner through the engine, live, so a plain member's writes go through as on PGLite and Postgres. A labelled-only member's own writes are still refused on Rust until that policy is served there. Nothing to do on upgrade.
