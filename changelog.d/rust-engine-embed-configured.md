**On an experimental Rust brain, embedding work that is already done now settles in bulk, as on PGLite. PGLite and Postgres brains behave as before.**

### Fixed
- A Rust brain now answers the bulk check that finds queued embedding work whose pages already carry current vectors, and marks that work finished, as PGLite does. Before, the check was raw SQL the Rust store refuses.
