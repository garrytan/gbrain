**The Postgres engine now returns file sizes as plain numbers and runs its shutdown hooks only once, as PGLite already did, and both engines gain a typed way to replace and seal a page's chunks.**

### Fixed
- `getFile` and `listFilesForPage` on Postgres returned `size_bytes` as a BigInt, while PGLite returned a number. Both engines now return a number. The `gbrain files` CLI and MCP JSON output does not change: that path already converted the value.
- A second `disconnect()` of an already closed Postgres engine ran the registered shutdown hooks again. It is now a no-op, as on PGLite.

### Added
- `BrainEngine.sealChunks(slug, chunks, { sourceId, expectedRevision })` replaces a page's chunks and seals its search text in one transaction. It refuses a missing or deleted page, a segmented page, an archived source and a stale `expectedRevision`. The engine parity suite seals its fixture chunks through it, so no parity case needs raw SQL.

### Tests
- The parity suite now covers every BrainEngine method (198 of 198). Raw-SQL methods (`executeRaw`, `executeRawDirect`, `runMigration`, `keywordBoundedRead`) run on the SQL engines and are marked `refuses:raw_sql` for the planned Rust engine; `holdSchemaMigrationLock` runs on Postgres only. A case declares the capability it needs with `requires`, and `test/engine-parity/arm-capabilities.ts` says which engine has it.
- The eval-capture and anomaly cases no longer depend on fixed sleeps or on the JS clock's date, so they do not fail near UTC midnight or on a slow machine.
