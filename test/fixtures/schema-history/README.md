# Schema-history fixtures

The schema blob replays before any migration, so on an existing brain each blob
statement meets the tables of whatever release created the brain. A blob index
or reference to a column that a later migration adds wedges those brains (#7645)
unless `src/core/engine-sql/bootstrap.ts` adds the column first.

Each `<engine>/v<N>.sql.gz` here is a fresh brain as the release that shipped
schema v`N` created it: gzipped SQL with the schema and the rows a fresh install
writes. `test/schema-history-upgrade.slow.test.ts` (PGLite) and
`test/e2e/schema-history-upgrade.test.ts` (Postgres) load each one, run
`initSchema`, and require the latest schema version and a fresh install's
catalog. The PGLite test also requires a fixture for every version from v260 to
the newest one here.

`scripts/capture-schema-history-fixture.ts` writes a fixture from the release's
own engine and refuses to write one that does not restore to that release's
exact catalog, function bodies and rows. Generated secrets are blanked. When a
release ships a new schema version, capture both engines from that release's
commit (usage in the script header) and commit the two files.
