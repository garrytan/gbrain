**On a Rust brain, `put_page` with a reason now saves the page.**

### Fixed
- Saving a page with a change reason (`gbrain put_page --reason`, or the MCP `put_page` tool with `reason`) was refused on a Rust brain, and nothing was written. The reason step read the page's visibility with raw SQL. It now uses a typed engine read, `readPageWorldVisible`. PGLite and Postgres send the same statement as before.
- On a Rust brain, a version saved from a page as it was read now keeps the read tags in their order, keeps the writer of the revision it was read at (any spelling of that revision), and stores the revision in lower case, as PGLite and Postgres do.
