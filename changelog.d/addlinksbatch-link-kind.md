**A Rust brain now stores link writes that carry a link kind or a resolution type, instead of refusing them.**

### Fixed
- On the Rust engine, `addLinksBatch` refused every link row that carried `link_kind` or `resolution_type` with `engine_capability_missing`, so nothing in that batch was written. The links pass after a remote `put_page` sends both fields, so its links never landed on a Rust brain, and shadow mode counted those writes as not compared (`rust_write_failed`). The Rust engine now accepts both fields and stores them as PGLite and Postgres do. A value outside the allowed set (`plain` or `typed_ner`; `qualified` or `unqualified`) is still rejected.

<!-- behavior-change: rust_links_batch_link_kind -->
