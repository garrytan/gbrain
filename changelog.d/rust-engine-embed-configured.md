**On an experimental Rust brain, embedding work that is already done now settles in bulk, as on PGLite. PGLite and Postgres brains behave as before.**

### Fixed
- A Rust brain now answers the bulk check that finds queued embedding work whose pages already carry current vectors, and marks that work finished, as PGLite does. Before, the check was raw SQL the Rust store refuses.
- A Rust brain now finds the segmented page an embedding run works on, by id or by slug, as PGLite does. Before, that lookup was raw SQL the Rust store refuses, so embedding a large segmented page stopped on a Rust brain.
- A Rust brain now takes, renews and releases the per-page embedding lease that keeps two paths from sending the same chunks to the provider, as PGLite does. Before, the lease was raw SQL the Rust store refuses.
