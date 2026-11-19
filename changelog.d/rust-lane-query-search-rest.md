**On the experimental Rust engine, more of the checks that run around `query`, `search` and `think` now get real answers instead of a refusal.**

### Fixed
- Backup coverage now counts a Rust brain's live pages. Before, the count ran raw SQL that the Rust engine cannot run, so the backup check reported the count as unknown. PGLite and Postgres run the same SQL as before.
- Backup coverage now reads a Rust brain's maturity (live pages, active facts and the brain's start date). Before, that read was refused on Rust, so the check could not tell a new brain from an old one. PGLite and Postgres run the same SQL as before.
- `think` over MCP on a Rust brain now reads the brain's remote read policy. Before, that config read was refused on Rust, so the caller was treated as restricted and `think` gathered no pages and no takes; it now gathers what PGLite gathers. PGLite and Postgres run the same SQL as before.
