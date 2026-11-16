**`bun run verify` now fails when a schema migration would take every page it touches out of search until `gbrain projections drain` rebuilds them, unless the migration is listed with the reason search keeps answering (#9192).**

### For contributors
- `bun run check:migration-projection`, part of `bun run verify`, fails on a migration whose SQL, or whose handler's own source, updates a page column the page revision trigger watches (`UPDATE pages ... SET` or an `INSERT INTO pages ... DO UPDATE SET` upsert) or writes `tags`. The dollar-quoted body of a `CREATE FUNCTION` or `CREATE PROCEDURE` is skipped; a `DO` block is read.
- A migration that has to do this goes in `scripts/migration-projection-baseline.tsv` with the reason search keeps answering, or why it cannot. v153 and v189 are listed. A listed migration that no longer matches fails as stale.
- The guard cannot see a handler that changes pages through helpers or functions defined elsewhere, SQL assembled at run time, or writes made by a database function the migration calls. Review those by hand.
