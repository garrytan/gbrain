**Both engines gain a typed way to replace and seal a page's chunks, and the engine parity suite now covers every engine method.**

### Added
- `BrainEngine.sealChunks(slug, chunks, { sourceId, expectedRevision })` replaces a page's chunks and seals its search text in one transaction. It refuses a missing or deleted page, a segmented page, an archived source and a stale `expectedRevision`. The engine parity suite seals its fixture chunks through it, so no parity case needs raw SQL.

### Tests
- The parity suite now covers every BrainEngine method (198 of 198). Raw-SQL methods (`executeRaw`, `executeRawDirect`, `runMigration`, `keywordBoundedRead`) run on the SQL engines and are marked `refuses:raw_sql` for the planned Rust engine; `holdSchemaMigrationLock` runs on Postgres only. A case declares the capability it needs with `requires`, and `test/engine-parity/arm-capabilities.ts` says which engine has it.
- The eval-capture cutoff cases derive their cutoff from stored timestamps and wait for the wall clock to pass it; the anomaly case uses the date stored by the database rather than the JS clock date.
