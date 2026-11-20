**A Rust brain now writes derived pages: a dream summary or synthesis publish, retiring a derived page and an atoms publish give the same pages, trust tiers and stamps as Postgres and PGLite, once the derivation records reach a Rust brain.**

### Changed
- A Rust brain now stamps a derived page's trust tier from the pages it was derived from and lowers a derived page whose content did not change, as Postgres and PGLite do. Before, these writes sent raw SQL and stopped on a Rust brain.
- A Rust brain now stamps `retired_by` and `retired_at` on the derived pages it retires, and stamps `source_hash` on the atom pages an atoms publish writes. Before, both stamps sent raw SQL and stopped on a Rust brain.
- The trust check in `gbrain doctor` now counts derived facts, takes, timeline entries and pages on a Rust brain. Before, it stopped on the first table.
- Still not on a Rust brain: recording which rows a derived page was derived from (so a dream summary, `think` synthesis or drift report publish and an atoms publish still stop there), lowering the rows derived from a page whose tier went down, and the Life Chronicle events publish. These still send raw SQL and stop with `raw_sql`.
