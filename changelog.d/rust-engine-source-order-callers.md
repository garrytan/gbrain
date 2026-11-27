**Source lists, the cycle's folder-to-source lookup, `gbrain migrate` and the repair previews now sort sources the same way on every engine and every Postgres locale.**

### Fixed
- On Postgres, reads that sort sources by id now sort in byte order (`COLLATE "C"`), like PGLite and the Rust engine. This closes TODOS `repair-incarnation-collation`. On a Postgres server with a language locale (for example `en_US.utf8`), some preview hashes change once after the upgrade: run each `gbrain repair` preview again before you apply it. An apply with a hash printed before the upgrade is refused with `preview_changed`, and the refusal says to re-run the preview.
