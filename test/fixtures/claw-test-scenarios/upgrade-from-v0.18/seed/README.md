# v0.18 seed

This directory ships in v1 as **scaffolding only** — `dump.sql` will contain a real v0.18-shape PGLite SQL dump in v1.1. Until then the harness treats the absent dump as a no-op seed and the upgrade scenario behaves like a fresh-install scenario for the test gate.

## Generating a real v0.18 seed

To produce an authentic seed:

1. Check out gbrain at the v0.18 release (`git checkout v0.18.0`).
2. Run `gbrain init --pglite --path /tmp/v0.18-seed.pglite` against a small fixture brain.
3. Run `gbrain import <fixture-brain>` to populate it.
4. Dump the PGLite as SQL: PGLite supports `pg_dump`-style export via the `executeRaw('SELECT * FROM pg_dump(...)')` extension or via direct file copy. If neither path works, run `pglite-tools dump /tmp/v0.18-seed.pglite > dump.sql`.
5. Place `dump.sql` here.
6. Update `expected.json::min_pages_after_migration` to match your dump's page count.

## What gets tested

When `dump.sql` exists, the harness:

- Runs `seedPgliteFromFile()` to replay the dump into a fresh `<tempdir>/.gbrain/brain.pglite`
- Then runs `gbrain init --pglite` so the migration chain detects the old schema_version and walks forward to LATEST
- Asserts `gbrain doctor --json` returns `status: 'ok'` after the walk

This is the regression gate for the upgrade-wedge bug class (#239/#243/#266/#357/#366/#374/#375/#378/#395/#396) — every gbrain release that adds a column-with-index in the embedded schema blob without a corresponding bootstrap retriggered the same wedge family.
