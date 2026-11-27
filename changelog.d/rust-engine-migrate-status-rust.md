**On a Rust brain, `gbrain migrate embeddings --status` now answers, and it names the Rust engine.**

### Fixed
- `gbrain migrate embeddings --status` (and `--status --json`) refused on a Rust brain before it read anything. It now answers there, with the same JSON as PGLite and Postgres for the same brain: the census reads it used to run as raw SQL are typed engine reads. The migration itself still refuses on Rust, because a Rust brain keeps one vector width.
- A Rust brain's status named its engine `pglite`. It now prints `rust`. PGLite and Postgres print what they printed before.
