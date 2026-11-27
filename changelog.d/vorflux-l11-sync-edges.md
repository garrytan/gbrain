**A Rust brain now refuses a sync page window of size 0, as Postgres and PGLite do.**

### Fixed
- Reading a sync pass's pages with a page size of 0 now fails on a Rust brain with an invalid-input error. Before, it returned no pages, while Postgres and PGLite refused the request. No sync asked for size 0, so no sync changes.
