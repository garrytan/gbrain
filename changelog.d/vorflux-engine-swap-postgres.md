**Added: `gbrain engine swap` can move a Postgres brain to the Rust engine.**

### Added
- A Postgres brain is now a swap source. Its recovery checkpoint is a `pg_dump` of the database under the gbrain home (0600, hashed, never printed). The swap refuses with `checkpoint_unavailable` before writing anything when `pg_dump` is missing or older than the server, or the disk is short, and names what is needed.
- Any other gbrain session connected to the brain's database stops the swap with `brain_in_use`.
- The switch keeps the config file's database URL out of the run record and puts it back on a failed probe or a rollback.
