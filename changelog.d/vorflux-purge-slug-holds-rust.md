**Deleting a page for good now also drops its held writes on a Rust brain, as it does on Postgres and PGLite.**

### Fixed
- The purge's delete of a page's held writes (`deletePurgedSlugHolds`) used to be refused on a Rust brain. The Rust store now deletes the held writes of each purged page's slug in its source, and the receipts of those held writes, reading each slug's holds one row at a time through the store's own index. A page purged after a soft delete loses only the holds last seen up to its deletion time, so a hold that arrived later stays. Postgres and PGLite send the same statements as before, and the Rust store's file format does not change.
