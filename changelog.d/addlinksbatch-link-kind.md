**A Rust brain now stores link writes that carry a link kind or a resolution type, instead of refusing them.**

### Fixed
- On the Rust engine, `addLinksBatch` refused every link row that carried `link_kind` or `resolution_type` with `engine_capability_missing`, so nothing in that batch was written. The links pass after a remote `put_page` on a SQL primary sends `link_kind`, so shadow mode's sampled replays of those writes on the Rust side failed and were counted as not compared (`rust_write_failed`). This does not turn on remote `put_page` for a Rust brain. The Rust engine now accepts both fields and stores them as PGLite and Postgres do. A value outside the allowed set (`plain` or `typed_ner`; `qualified` or `unqualified`) is still rejected.

<!-- behavior-change: rust_links_batch_link_kind -->
