---
important: data-loss
---
**A source delete can no longer leave its pages behind, a purge keeps the conversation-facts outcome rows, an older gbrain can no longer roll back a newer schema, and the commit door's dry run refuses whatever the real run refuses.** This is the persistence/sync salvage wave: five fix PRs built in late October (#7853, #8237, #8152, #8320, #8330) rebuilt on current master, so the fixes they carry that master does not already have finally ship.

### Data you could lose before

- **A source delete never strands its pages (#7072).** On a brain without managed persistence, an expired-archive purge, `gbrain sources purge` or `sources remove` now refuses with `source_pages_remain` and changes nothing when the database would not cascade the delete to the source's pages (the pages-to-sources foreign key is missing, does not cascade, or its trigger is disabled). The nightly purge lists that source under `blocked` and moves on. Brains whose foreign key is intact purge as before, and pages an earlier purge already stranded are not touched. Managed brains already delete a source's pages before its row.
- **Older binaries can't overwrite a newer schema (#7776).** An older gbrain that runs `gbrain init`, `apply-migrations` (including `--force-schema`) or `upgrade` against a brain a newer gbrain migrated now refuses with `client_behind` before anything runs. Before, its schema replay reinstalled its own older function bodies, write guards included. New doctor check `schema_function_bodies` compares the installed bodies with this binary's.
- **Facts purge keeps outcome rows (#7831).** `gbrain forget <id> --purge` on a claim whose text is exactly `EXTRACTION_COMPLETE` or `EXTRACTION_NOT_APPLICABLE` no longer deletes the outcome rows with the same text, so those pages aren't extracted (and paid for) again.
- **Secret audit (#8034).** `audit-secrets` and re-scans again report a password glued to a redaction marker by punctuation. Import-time redaction is unchanged.
- **Ghost code pages (#7967).** `gbrain repair ghost-pages` retires a code or image page at its recorded file instead of at `<slug>.md`, and on a git-canonical source the door commits the file's removal.
- **Failed repairs change nothing (#7960 item 1).** When `gbrain repair provenance --apply` fails in the database after writing the page file, it puts the file back and reverts its commit.
- **Dream write-through (#8092).** After a refused commit, rewrites of existing atom and concept files and removals of retired atoms' files are retried on the next run, and a busy commit lock no longer freezes the worker's event loop.
- **Read-only mirrors stay read-only (#7098).** On a brain without managed persistence, a source marked `gbrain sources mirror-readonly` is left alone by page write-through and delete, timeline entries, fact fences, `forget`, the extract cycle, `sync --full` and `brainstorm --save`; owner trust repairs list its pages `needs_review`.
- **Dream runs leave read-only mirrors alone too (#8935).** On a brain without managed persistence, the dream cycle no longer writes, rewrites or removes page files in a source marked `gbrain sources mirror-readonly` (or a clone gbrain owns), and no longer puts a fallback file for another source under `.sources/` inside such a checkout. The pages stay in the database, and the mirror's `git pull --ff-only` keeps working. Reported and first fixed by @javieraldape in #9212.
- **An agent's sessions are not saved as you (#8080).** Dream synthesis and OpenClaw sub-agent compaction honor the agent speaker marker. When an agent continues a session already saved as yours, gbrain saves nothing from it and reports `speaker_mismatch`. `gbrain repair agent-session-facts --apply` reads the session corpus once per run and keeps in-page rows attributed correctly after a slow write.

### The commit door

- **Dry run (#7752).** `gbrain git commit-push --dry-run` runs the real run's path checks (source root, a `--base` that moved, a sparse-checkout exclusion, another writer's staged file, a staged rename, a deleted or modified file under an ignore rule) against a copy of the index and exits 1 with the same error. It still writes nothing and takes no lock.
- **Literal paths (#7792, #7793).** The `brain-commit-push.sh` fallback treats glob characters as literal, so committing `[ab].md` no longer also commits `a.md`, and the fix commands the door prints for another writer's staged file name literal paths.
- **Extract receipts (#7620).** Receipts are sealed in the transaction that writes them, so remote `search` and `query` no longer report `safe_index_pending` after every extraction. Receipts written before this release still need `gbrain repair safe-chunks --apply` once.
- **Strict door index refresh (#7755, #7756, #7757, #7758, #7717).** The refresh removes index copies a killed gbrain left behind, retries a briefly refused rename on Windows, and a page committed with a legacy file mode (100664) gets no mode-only commit.

### Clearer refusals and next steps

- **Protocol guard refusals (#7777)** fail with the guard's own code and remedy instead of an "unexpected owner exception" `storage_error`. Contributed by @javieraldape (#7913, rewritten on master).
- **`unreadable_state` (#7780)** says the role cannot fully read the writer state and asks before suggesting a role change.
- **Stored source paths (#7646)** are judged absolute by one rule everywhere (sync, `config set`, write-through, `set-path --clear`, doctor). Writes on a relative root record `relative_root` and name `gbrain sources set-path`.
- **Git-canonical conversion (#7956)** refuses a root it can't read with `source_root_unreadable`, and an apply whose source was switched back to mixed while it ran reports `incomplete`.
- **`git-durability` enable (#7634)** checks its approval before writing `AGENTS.md`, wiring a credential or retrying parked pushes.
- **Parked push retry (#7110)** keeps going past a request whose page became private and ends `partial`.
- **Embedding stop signal (#7772)** retries as `embedding_aborted` instead of failing for good.
- **Retired grandfather receipts (#7837)** read as history in doctor's `persistence_terminal_failures`.
- **Synthesis holds (#7849)** each name the fix that releases them, and doctor counts swept holds.
- **Copied brain (#7671)** `physical_root_directory_changed` names the relocated-root self-transfer as its fix. Nothing is re-stamped automatically.
- **Repair wording (#7715, #7910, #7881):** stuck-recovery on a git-canonical source says commit-then-sync; `repair url-clone-fences` lists a held file once; a streamed put/capture refusal uses the page-write wording.

Brainstorm message idea from @javieraldape (#7113, rewritten on master). Every change behaves the same on a repo-less brain except the door and conversion items, which need a checkout as they always have.

### A forget interrupted after its Git commit still withdraws the fact

**Git is the parent, so the database now follows a commit that already landed.** On a source configured `canonical: git`, a write is committed to Git first and its database row second. When something failed between the two (an unexpected error after the Git commit, before the row committed), the write ended `failed` with `storage_error` and the reply said "nothing was saved", although Git held the change. For a `forget` that meant the fact stayed active until the next sync, no withdrawal was recorded, and the same claim could be remembered again as a new fact (GST-2517).

- The owner now replays such a write. The replay finds its change already committed and records it without a second commit. A `forget` turns the fact inactive and records its withdrawal, and a `remember` or `put_page` gets its one row. A shared fact forgotten by the owner and a member's own-page fact behave the same. A killed process in the same window was already recovered this way.
- If the replay fails too, the request ends failed with the landed commit on its receipt (`landed_before_row`). A `remember` or `forget` reply then names that commit and says the database has not recorded it, instead of "nothing was saved". A `forget` submitted again with a new request_id records the withdrawal without a second commit.
- `gbrain repair failed-writes` no longer says a refused `forget` "will be produced again by the next dream cycle": only callers make forgets, so it lists one as a write to resubmit.

### For contributors

- No git call under `src` passes git's global `--literal-pathspecs` switch any more; read paths name each path as `:(literal)<path>` through `literalPathspecs`, `test/git-env-guard.test.ts` refuses the switch anywhere in `src`, and `literalPathspecs('')` throws.
- The crash robot reports a failed page read as `read_failure` instead of a false `projection_drift` (#7651).

<!-- behavior-change: extract_receipt_sealed_7620 -->
<!-- behavior-change: commit_push_dry_run_checks_paths -->
<!-- behavior-change: schema_client_behind_7776 -->
<!-- behavior-change: purge_keeps_outcome_markers_7831 -->
<!-- behavior-change: audit_secrets_glued_marker_8034 -->
<!-- behavior-change: fence_locators_skip_code_8020 -->
<!-- behavior-change: ghost_code_page_recorded_file_7967 -->
<!-- behavior-change: derived_write_through_retry_8092 -->
<!-- behavior-change: owner_repair_file_restore_7960 -->
<!-- behavior-change: protocol_guard_refusal_typed_7777 -->
<!-- behavior-change: door_index_refresh_7717 -->
<!-- behavior-change: stored_root_predicate_7646 -->
<!-- behavior-change: sync_anchor_relative_jobs_7646 -->
<!-- behavior-change: conversion_root_owner_7956 -->
<!-- behavior-change: stuck_recovery_strict_followup_7715 -->
<!-- behavior-change: url_clone_fences_held_preview_7910 -->
<!-- behavior-change: streamed_put_visibility_wording_7881 -->
<!-- behavior-change: git_durability_refusal_no_side_effects_7634 -->
<!-- behavior-change: parked_push_hidden_page_7110 -->
<!-- behavior-change: embedding_preflight_abort_7772 -->
<!-- behavior-change: mirror_read_only_legacy_writers_7098 -->
<!-- behavior-change: copied_root_fix_names_self_transfer_7671 -->
<!-- behavior-change: door_landed_replay_gst2517 -->
