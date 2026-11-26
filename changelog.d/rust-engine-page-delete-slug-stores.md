**Deleting or purging a page on a Rust brain now also removes the take proposals and open loops filed under that page, as on PGLite and Postgres.**

### Fixed
- On a Rust brain, `deletePages` and `purgeDeletedPages` removed the page but left the take proposals and open loops whose page was that slug. A later page at the same slug then inherited them, and the loops kept nudging about a page that was gone. Both now delete those rows in the same transaction as the page, and keep the rows of other pages and of the same slug in other sources.
