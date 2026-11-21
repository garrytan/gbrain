**The page purge receipt's store probes do bounded work, list effects in one order on every engine, and the Rust engine reports a missing rebuildable cache.**

### Fixed
- A store probe counts at most the row bound plus one and now stops scanning there: the request, effect and segment text probes no longer read everything first, and the effect count builds no item text.
- The first 20 effect items of a receipt probe sort in byte order (`COLLATE "C"`) on Postgres as on PGLite and the Rust engine, so more than 20 matches return the same 20 whatever the database collation.
- On the Rust engine, a rebuildable cache the store keeps no rows of (`page_view_digests`) is reported absent, so clearing it returns null instead of failing with raw_sql.
