**A dry run of a Google or GitHub source no longer writes pages (#9449).**

### Fixed
- `gbrain sync --source <id> --dry-run` on a Google (Gmail, Calendar, Contacts) or GitHub source of a brain without managed persistence fetched from the provider and wrote what it fetched: pages, chunks and soft-deletes. It now fetches and writes nothing, prints that the source has no preview, and returns the `dry_run` result, as Slack and meetings sources already did. A brain with managed persistence still refuses a connector dry run before any provider call (#9449).
- Tests: `test/sync-connector-dry-run-9449.test.ts` runs a dry run of every connector kind on PGLite and Postgres and checks that nothing was fetched or written.

Reported by @kostjakla-del-ok. First fixed by @Masashi-Ono0611.

Supersedes #9450
