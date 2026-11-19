**On the experimental Rust engine, a remote `query` or `search` now says when some pages in its scope are still waiting for the safe index, as it does on PGLite and Postgres.**

### Fixed
- A remote `query` or `search` on the Rust engine now adds the `safe_index_pending` notice when a page in the caller's scope has not been indexed with the safe chunker yet. Before, the check ran raw SQL that the Rust engine cannot run, so the notice never appeared there and a partial answer could read as complete.
- The check now asks every engine the same typed question, with the same source, privacy, type and slug-prefix filters. On PGLite and Postgres it runs the same SQL and uses the same index as before.
