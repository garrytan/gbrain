**On an experimental Rust brain, embedding work that is already done now settles in bulk, as on PGLite. PGLite and Postgres brains behave as before.**

### Fixed
- A Rust brain now answers the bulk check that finds queued embedding work whose pages already carry current vectors, and marks that work finished, as PGLite does. Before, the check was raw SQL the Rust store refuses.
- A Rust brain now finds the segmented page an embedding run works on, by id or by slug, as PGLite does. Before, that lookup was raw SQL the Rust store refuses, so embedding a large segmented page stopped on a Rust brain.
- A Rust brain now takes, renews and releases the per-page embedding lease that keeps two paths from sending the same chunks to the provider, as PGLite does. Before, the lease was raw SQL the Rust store refuses.
- A Rust brain now reads the chunker version, corpus generation and page kind that a page's chunks are keyed on, as PGLite does. Before, that read was raw SQL the Rust store refuses, so building or embedding a page's chunks stopped on a Rust brain.
- A Rust brain now meters each page's embedding spend on its own ledger: it refuses a held page, holds a junk page, grants only the chunks that fit the page's cap and books what the provider call cost, as PGLite does. Before, that ledger was raw SQL the Rust store refuses, so a paid embedding run stopped on a Rust brain.
- A Rust brain now installs a page's new vectors: it reads which chunks already carry a vector of the current text under the model, checks the effect still holds its claim, takes the embedding switch lock and writes each batch of vectors, as PGLite does. Before, these steps were raw SQL the Rust store refuses, so a page saved with embedding configured never got its vectors on a Rust brain.
