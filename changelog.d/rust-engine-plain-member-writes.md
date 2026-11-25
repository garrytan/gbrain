**On the Rust engine, a member without the labelled-only grant can write on a brain where another member has it.**

### Fixed
- On a brain with the Rust engine where some member has the labelled-only grant, every remote write by any other member (`put_page`, `capture`) was refused, because the write check read the brain owner with raw SQL. It now reads the owner through the engine, live, so a plain member's writes go through as on PGLite and Postgres. A labelled-only member's own writes are still refused on Rust until that policy is served there. Nothing to do on upgrade.

### Known gap
- On the Rust engine, a plain member's write over a page that has only a soft-deleted row and names readers or sits under a folder rule can still be refused, because the visibility check in `src/core/persistence/page-visibility.ts` still reads that case with raw SQL. A page with a live row is judged through typed reads, and so is the brain owner's own remote write.
