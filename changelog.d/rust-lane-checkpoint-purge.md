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
