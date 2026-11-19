**On the experimental Rust engine, more of the checks that run around `query`, `search` and `think` now get real answers instead of a refusal.**

### Fixed
- Backup coverage now counts a Rust brain's live pages. Before, the count ran raw SQL that the Rust engine cannot run, so the backup check reported the count as unknown. PGLite and Postgres run the same SQL as before.
