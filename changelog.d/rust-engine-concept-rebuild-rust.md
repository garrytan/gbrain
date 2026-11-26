**On a Rust brain, a concept hidden by an input purge is now rebuilt by the next synthesis, as on PGLite and Postgres, instead of refusing with an unsupported raw-SQL error.**

### Fixed
- The held-concept rebuild had three reads that ran as raw SQL: what was stated on the concept, who may read it, and the list of held concepts the purge previews name. They are now typed engine reads. PGLite and Postgres send the same statement text as before, so their answers do not change.
- The Rust engine now serves these three reads and the rebuild's other reads and link carry. On a Rust brain, the rebuild, the managed purge's re-check and the purge previews now give the same answers as PGLite.
