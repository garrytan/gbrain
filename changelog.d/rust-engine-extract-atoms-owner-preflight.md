**On a Rust brain, `extract_atoms` now stops by name before it pays for a model call, for a second gbrain process and for the process that owns the brain.**

### Fixed
- When one gbrain process owns a Rust brain and a second process connects to it, the second process could run `extract_atoms`, pay for every model call, and then lose all the atoms, because saving them needs a transaction that the owner connection refuses. The dream cycle paid again on every run. The second process now refuses up front with `engine_capability_missing` before the first model call, dry runs included.

### Known gap
- This build keeps the Postgres and PGLite page discovery and page state statements exactly as they were, and a Rust brain does not serve that discovery yet. A Rust brain therefore refuses `extract_atoms` by name (`engine_capability_missing`, member `listExtractablePages`) before any model call, for the owner and for a second process alike, even when there is nothing to extract. Postgres and PGLite are not affected. This lasts until the Rust store keeps the discovery and page state that the Postgres statements read.
