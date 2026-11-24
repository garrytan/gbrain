**A purge on a Rust brain gets further: its belief ledger steps and Git commit redaction now run.**

### Changed
- On the Rust engine, a purge now raises the source's purge counter, checks for a belief ledger, records and releases the fields it hides, and redacts the purged text from pending Git commit messages, all with the same results as Postgres.
- A restore that replays purges now writes its page tombstones and reads the restored schema through the engine, not raw SQL.
