---
important: data-loss
---

### A database-wins file-drift repair no longer discards a newer file edit

**`gbrain repair file-drift --prefer database` and `gbrain sources reconcile --apply` could overwrite a change to a page's file that sync had not imported yet, or bring back a file another writer had just deleted, with nothing in the preview saying so.** A repair now checks each page's file against sync's import record before it takes the database copy.

- `src/core/persistence/unimported-file.ts` (new): the database copy may win only when the database itself held the version the file records: the bytes sync's import record names (or the blob a sync adopted into it), or gbrain's own write of a revision the page has held (live or in its version history). Anything else is newer, whoever committed it, including gbrain's own writer commit of a revision whose database row never landed and a page with no import record at all; a wrong "keep" costs a hold and a wrong "take" costs an edit. A database edit made after the file's last commit still wins. The preview names the last commit that touched the file (sha, author, date).
- `gbrain repair file-drift --prefer database` with `--held` or `--all-drifted` leaves such pages held and lists them `kept_newer_file`; a file that another writer's delete commit removed is `kept_newer_delete` instead of being recreated. Naming one page with `--slug` still previews it, and the preview and the consent text name what it would discard.
- Every `gbrain repair file-drift` apply now asks for the user's consent (`consent: 'destructive'` in the repair registry), and the consent text lists the changes it would discard and the files a `tombstone_edited` or `purged_differs` `--prefer database` apply removes. A script that applied without `--yes` now exits 3.
- `gbrain sources reconcile` (preview and `--apply`, and the `writer_reconcile_preview` / `writer_reconcile_apply` operations) refuses `source_changed` when its result takes the database copy over such a file.
- Hold texts, `fix` steps and the docs that print a database-wins repair now give the preview as the step and say the apply needs the user's consent.
- `docs/guides/repair.md` explains the new behaviour and how to find edits an earlier repair overwrote, from the reconcile backups it kept.
- Tests: `test/db-wins-unimported-gst2579.test.ts` on PGLite and Postgres.
- The `@hono/node-server` override (pulled in by the MCP SDK) moves from `^2.0.5` to `^2.1.6`, now resolving 2.1.8, which fixes GHSA-qv5m-9pm6-hqp3 (a reset connection during a WebSocket upgrade could crash `gbrain serve --http`) and GHSA-jpvv-r467-5p4w (a backslash in a request path could get past a static-path check).

<!-- behavior-change: db_wins_unimported_gst2579 -->
