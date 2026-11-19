**On an experimental Rust brain, a `put` gets further through the background writer: the writer no longer stops on a missing connection pool. PGLite and Postgres brains behave as before.**

### Fixed
- The background writer sizes its publication passes from the brain's connection pool. A Rust brain has no pool, so the writer stopped with a TypeError before its first claim. A Rust brain now runs one publication pass at a time, like PGLite, because its store has one writer. Postgres still sizes from its pool, unchanged.
- On a Rust brain the background writer can now pick the next queued write. It reads the oldest claimable write through a typed engine member, which the Rust store answers. PGLite and Postgres send the same statement as before.
