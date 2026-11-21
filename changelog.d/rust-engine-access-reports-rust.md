**`gbrain access serves` and doctor `open_shared_pages` list source ids in the same order on every engine, and the Rust engine answers `gbrain access who-can-read` and the open-page count.**

<!-- behavior-change: open_pages_sources_byte_order -->

### Fixed
- On a Postgres brain whose database uses a non-C collation (for example `en_US`), the source list of the open-page count (`open_pages.sources` in `gbrain access serves --json`, the serves receipt and doctor `open_shared_pages`) now comes in byte order, as on PGLite. Before, the order depended on the database locale. PGLite output does not change.
- On a brain with the Rust engine, `gbrain access who-can-read`, the open-page count of `gbrain access serves` and doctor `open_shared_pages` give the same answers as PGLite instead of stopping on a raw SQL refusal. Member writes and `gbrain access serves several` still refuse on the Rust engine.
