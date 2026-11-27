**On a Rust brain, content derived from an owner-only fact, take or timeline row stays private after that row is deleted.**

### Fixed
- Deleting a fact of an owner-only source, or a take or timeline row of an owner-only page, now records the row and everything derived from it as owner-only before it goes, on a Rust brain as on PGLite and Postgres. Before, only a page delete did this, so a public page derived from the deleted row became readable by other members.

### Changed (tests)
- Tests: a parity case deletes each of the three kinds and checks the derived public page stays hidden on PGLite, Postgres and Rust; a Rust store test checks the marks, and that deleting an open fact marks nothing.
