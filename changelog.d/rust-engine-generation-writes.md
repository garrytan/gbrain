**A Rust brain now writes derived pages: a dream summary or synthesis publish, retiring a derived page and an atoms publish give the same pages, trust tiers and derivation records as Postgres and PGLite.**

### Changed
- A Rust brain now stamps a derived page's trust tier from the pages it was derived from, records which rows it was derived from, and lowers a derived page whose content did not change, as Postgres and PGLite do. Before, these writes sent raw SQL and stopped on a Rust brain, so a single-page derivation publish (the dream summary, `think` synthesis and drift report pages) could not finish.
- A Rust brain now stamps `retired_by` and `retired_at` on the derived pages it retires, and stamps `source_hash` on the atom pages an atoms publish writes. Before, both stamps sent raw SQL and stopped on a Rust brain.
- The trust check in `gbrain doctor` now counts derived facts, takes, timeline entries and pages on a Rust brain. Before, it stopped on the first table.
- On a Rust brain, a page or fact derived (through up to 8 recorded derivation steps) from a row in an owner-only source is now hidden from callers who are not the owner, as it is on Postgres and PGLite.
- Still not on a Rust brain: lowering the rows derived from a page whose tier went down, and the Life Chronicle events publish. These still send raw SQL and stop with `raw_sql`.
