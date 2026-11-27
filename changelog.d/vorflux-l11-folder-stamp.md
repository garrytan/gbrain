**A folder source synced on a Rust brain now records when it last synced, so `gbrain doctor` stops reporting it as never synced.**

### Fixed
- Importing a folder source on a Rust brain now sets the source's last sync time, as Postgres and PGLite do. Before, the import wrote the time with raw SQL, the Rust engine refused it, and the refusal was hidden, so `sync_freshness` in `gbrain doctor` kept showing the source as never synced.
- On a Postgres server or pooler that starts sessions as read-only, the folder-source sync time is still written, because the write keeps the same read-only retry that other autocommit writes use.
