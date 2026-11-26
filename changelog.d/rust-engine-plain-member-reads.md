**On the Rust engine, a member without the labelled-only grant can read again.**

### Fixed
- On a brain with the Rust engine that serves several people, every read by a member other than the owner (over MCP, through a bound token, or from a stdio server bound to the member) was refused, because the check for the labelled-only grant could not read the members table and counted that as "labelled-only". It now reads the members through the engine, so a plain member reads the open pages, the pages that name it and its folders, as on PGLite and Postgres. A read the engine refuses (`engine_capability_missing`) is reported loudly, never read as labelled-only for every member; any other failed read still counts as labelled-only, so that failure only narrows. Members with the labelled-only grant are still refused on Rust until that policy is served there.

### Known gap
- On the Rust engine, a write by a plain member (`put_page`, `capture`) can still be refused. Some of the write checks (in `src/core/persistence/page-visibility.ts`) still read the page's visibility with raw SQL, which the Rust engine does not run. Reads are not affected.
