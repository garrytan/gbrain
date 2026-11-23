**On the experimental Rust engine, the nightly purge now deletes checkpoints older than seven days, as it does on PGLite and Postgres.**

### Changed
- The purge of stale checkpoints moved from raw SQL into a typed engine member. PGLite and Postgres run the same SQL as before.
- On the Rust engine the purge keeps the same durable records the SQL engines keep, where the Rust store holds the data.

### Fixed
- On the Rust engine the purge now reads a sync delete tombstone's recorded time in the form Postgres stores it, with a time zone offset. Before, it kept such a tombstone even after its page was restored or deleted again.
- On the Rust engine a sync of a changed file now keeps the commit's change reason with the page's old version, as PGLite and Postgres do. Version history reads show it, and a reason a purge removed stays removed.
- On the Rust engine a sync that reuses stored chunk vectors no longer stops on the safe-chunk check. A page chunked before the safe-fence chunker reads as having no reusable chunks, as on PGLite and Postgres.
- On the Rust engine `gbrain sources status` now counts each source's live pages, chunks and embedded chunks instead of stopping with an unsupported-SQL error. PGLite and Postgres run the same SQL as before.
- On the Rust engine a sync now extracts links and timeline entries as PGLite and Postgres do. Before, the extraction stopped on an unsupported-SQL error when it read the old slugs of renamed pages, and the sync told you to run `gbrain extract --stale` afterwards.
- On the Rust engine the sync notifier now reads each source's last synced commit. A request to sync a commit the source already reached is no longer counted as due, and `gbrain sources status` reads when each source first became due instead of stopping with an unsupported-SQL error.
- On the Rust engine link and timeline extraction now reads which pages are quarantined, so a sync's extraction no longer stops with an unsupported-SQL error there. PGLite and Postgres run the same SQL as before.
- On the Rust engine link extraction now reads the page details and attendance links of the pages a sync changed, so the extraction no longer stops with an unsupported-SQL error there. PGLite and Postgres run the same SQL as before.
- On the Rust engine a sync now writes the timeline entries it extracts from each page, as PGLite and Postgres do. Before, the timeline step stopped with an unsupported-SQL error when it read each page's trust tier. PGLite and Postgres run the same SQL as before.
- On the Rust engine, `gbrain sources status` and the doctor hold check now read each source's held files, hold counts by code, unsupported-image counts and conversion log, instead of stopping because the engine has no raw SQL.
- On the Rust engine, `gbrain sources status` now shows each source's shared-skills setting, and shared-skill setup reads the source policy, instead of stopping because the engine has no raw SQL.
- On the Rust engine, `gbrain sync status` now reports a source's state, holds, admission, oldest blocker and recovery records as PGLite does, instead of stopping because the engine has no raw SQL. PGLite and Postgres run the same SQL as before.
- On the Rust engine the automatic writer claim of a source checkout (the first page write to a source with a local path, and shared-skill setup) now records the worktree binding, instead of stopping because the engine has no raw SQL. The source then reads as claimed, its root is listed in the connect gate's root bindings, and its worktree heartbeat is stamped. PGLite and Postgres run the same SQL as before.
- On the Rust engine `gbrain sources writer claim --expected-state` now works. The command reads the writer state you reviewed and refuses when it changed, as on PGLite and Postgres, instead of stopping with an unsupported-capability error.
- On the Rust engine `gbrain sources writer lock` and `unlock`, and the prepare and cancel steps of a writer transfer, now run instead of stopping because the engine has no raw SQL.
- On the Rust engine a reviewed `gbrain sources writer transfer accept` now moves the source to the successor checkout, as on PGLite and Postgres: the successor host owns the worktree at the next epoch, and the shared-skills content receipt points at the new root. Before, the accept stopped because the engine has no raw SQL. A dry-run accept still stops on the Rust engine. PGLite and Postgres run the same SQL as before.
- The reviewed writer state now lists sources, bindings and locks in the same order on every database, whatever its text collation. A state reviewed before this change on a Postgres database with a non-C collation can read as changed once; review it again.
