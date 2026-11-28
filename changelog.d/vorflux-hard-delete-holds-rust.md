**Deleting pages for good on a Rust brain now also drops their held writes, as it does on Postgres and PGLite.**

### Fixed
- On a Rust brain, deleting pages for good (`deletePages`) and purging old deleted pages (`purgeDeletedPages`) left the pages' held writes, and the receipts of those held writes, in the review queue. They now go in the same write as the pages. A purge drops only the held writes seen up to the page's deletion, so one that arrived after it stays. Deleting a single page (`deletePage`) still keeps them on every engine, and the Rust store's file format does not change.
