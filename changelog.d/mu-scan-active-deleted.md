**On a multi-user Rust brain, the eval harness's live-only text scan no longer finds a deleted page.**

### Fixed
- A multi-user Rust brain keeps a commit log, and each log record copies the values its commit wrote. The eval harness's text scan with `activeOnly` read those copies, so it still found the text of a page after the page was deleted, and the text of that page's fence facts. The live-only scan now leaves out the commit log, as it already left out the search and link indexes. It now gives the same answer as PGLite and Postgres.

### Blast radius
- Only `scanTextColumns` with `activeOnly` on a Rust brain with multi-user mode on. A scan without `activeOnly` still reads the commit log. Single-user Rust brains, PGLite and Postgres are unchanged.
