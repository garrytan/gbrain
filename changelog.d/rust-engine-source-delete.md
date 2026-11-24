**`gbrain sources remove` now works on a brain that uses the Rust engine.**

### Fixed
- Removing a source on a Rust-engine brain stopped with `engine_capability_missing` (`raw_sql`), and the source stayed. The Rust engine now removes the source, its pages and every record kept for that source in one write, as Postgres and PGLite do. That includes its write-gate holds and their receipts, managed-sync resume cursors and its page names in captured eval candidates.
- As on Postgres, the Rust engine refuses to remove a source while an OAuth client is registered to it, and clears the source from clients that are only bound to it.
