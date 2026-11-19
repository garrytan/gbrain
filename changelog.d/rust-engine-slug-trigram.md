**A Rust brain now finds a page from part of its name, the way Postgres does, and tied partial matches come back in the same order on every engine.**

### Changed
- Tied partial matches from `resolve_slugs` now come back in slug order, then source order, on Postgres, PGLite and Rust. Before, the order of equally close matches was undefined.

### Added
- The Rust engine answers `resolve_slugs` for a name that is not an exact slug: up to five live pages whose title is trigram-similar to the name (pg_trgm similarity 0.3 or more) or whose slug contains it, closest first. It used to refuse `engine_capability_missing`. Scores match Postgres on ASCII text; two different multibyte trigrams that collide in pg_trgm's 24-bit checksum, or a rare character the C library classes differently, can score differently.
