**`gbrain backup create` and `backup restore` now work on a Rust brain.**

A Rust brain can be backed up while it is in use and restored into a new, empty folder. `backup create` asks the process that owns the brain for one copy at one exact moment, checks the copy against its own fingerprints, and waits for unfinished writes to settle (it stops with `writers_active` if they never do). `backup restore` checks the restored copy before it changes anything, then gives the restored brain a fresh brain id (naming the old and the new one), detaches sources from the old machine's folders, switches automation off, cancels unfinished jobs, and revokes the local writers and OAuth clients the backup held, naming each one so you can re-issue access. It refuses, by named reason and without publishing anything, a backup that holds unfinished write requests, a purge made after the backup's copy, or records it cannot make safe (access tokens among them).

### Added
- `gbrain backup verify-store <dir>`: a read-only check of a copied Rust brain directory (identity, format, generation, digests, keyword-index state). It is the mandatory step of the large-brain runbook for Rust brains, which is in `docs/guides/in-agent-setup.md`.

### Changed
- A Rust brain over the 8 GiB archive cap, or in a flat or symlinked layout, is refused with `backup_too_large` or `unmanaged_database_path` and pointed at the physical-copy runbook, which now covers the Rust folder layout (copy `FORMAT` and `records.redb`, never the owner socket).

PGLite backups are unchanged. Postgres brains still use `pg_dump` and `pg_restore`.
