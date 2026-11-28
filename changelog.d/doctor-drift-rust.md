### Fixed

- `gbrain doctor` on a Rust-engine brain now checks multi-source slug drift. Before, the `multi_source_drift` row said "Not verified" on those brains because its source list and its page lookup were raw SQL; both are now engine reads, so the row reports drift the same way it does on PGLite and Postgres.
- `gbrain doctor` on a Rust-engine brain now compares the schema packs each source overrides. The `schema_pack_source_drift` row said "Not verified" there because it read the overrides with raw SQL; it now warns when sources name different packs, the same as on PGLite and Postgres.
