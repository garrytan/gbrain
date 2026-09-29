# Write refusal reasons

When a managed brain refuses a write, sync or background effect, the error
names a reason and a recovery command. This page lists the reasons a user or
agent is most likely to meet, what each one means, and what to run. None of
these refusals overwrites your file or your database copy; each one stops so
that nothing is lost.

**Say to your agent:** *"My save was refused with `file_database_drift`.
Show me the preview before you fix it."* or *"Doctor says effects are parked.
What failed, and can we retry it?"*

## Where the reason appears

A refused operation prints, or returns in JSON, an error with these fields:

```json
{ "error": "source_changed", "detail": "file_database_drift",
  "message": "...", "suggestion": "On the brain host, run gbrain sources reconcile ..." }
```

`error` is the error code. `detail` is the specific reason when one code has
several causes. `suggestion` is the recovery step: usually a command, filled
in with the real source and slug where the code knows them, sometimes with
placeholders such as `<source>` or `<brain>` to fill in, and sometimes an
inspection instruction. A failed write receipt carries the error code as
`write_error`; managed sync and memory-verb errors add the specific reason.
Run recovery commands on the brain host unless the row says otherwise.

Keep the original `request_id`. Unless a row says to use a new one, retry the
original write with the same ID after the fix, so the brain replays it instead
of making a duplicate.

## Reference

| Reason | Error code | What it means | Recovery |
| --- | --- | --- | --- |
| `file_database_drift` | `source_changed` | The page's canonical file and its database copy disagree, usually because the file was edited outside a coordinated write. Neither copy was overwritten. A file with no `type:` line keeps the stored type, and titles compare trimmed, so those alone no longer cause this. | `gbrain sources reconcile <source> <slug> --brain <brain> --preview`, review the preview, resolve it, then `--apply <resolved-preview-file> --request-id <new uuid>`. Retry the original write with a **new** request ID. See [repair a file/database disagreement](concurrent-writes.md#repair-a-filedatabase-disagreement). |
| `ambiguous_source_path` | `page_identity_changed` | A source registered at a Git subfolder `<sub>` has a page whose stored path `<sub>/<file>` could mean either `<file>` in the source directory (the older Git-root spelling) or `<sub>/<file>` inside a folder of the source that repeats its name, and both files exist. Sync refuses instead of guessing. See [sources in a Git subfolder](multi-source-brains.md#sources-in-a-git-subfolder). | Rename or move one of the two files, commit, then `gbrain sync --source <source> --no-pull --retry-failed`. |
| `physical_root_device_changed` | `recovery_required` | The checkout's filesystem device number changed while everything else matches, which macOS can do after a reboot. When the owner token, brain, worktree, root, inode and a non-zero birth time all match and the caller can verify database ownership, the write path re-stamps ownership by itself and the write proceeds. This refusal means the automatic re-stamp could not be verified; the suggestion says why. | Do a deliberate self-transfer: `gbrain sources writer status <source>` (note `admin_state`), then `gbrain sources writer transfer prepare <source> --self-transfer --admin-intent writer_transfer_prepare --expected-state <admin_state>`, then `gbrain sources writer transfer accept <source> --path <root> --expected-epoch <epoch> --manifest <digest from prepare> --self-transfer --admin-intent writer_transfer_accept --expected-state <fresh admin_state>`. Retry the original write with the **same** request ID. Never delete ownership marker files. |
| `cursor_processing_options_conflict` | `invalid_params` | An unfinished sync's processing options (`--no-embed`, `--no-extract`, `--no-schema-pack`) conflict with this run, or the cursor predates saved options and has none. When options are saved, a run that omits those flags, including autopilot and `sync` jobs, adopts them. | When the message prints a resume command (`gbrain sync --source <source> --no-pull` plus the saved flags), run it or drop the conflicting flag. When it reports no saved options, resolve pending requests first, then rediscover with `gbrain sync --source <source> --no-pull --retry-failed` and the processing flags you want. |
| `take_row_collision` | `take_row_collision` | A save adds a takes-table row whose row number already belongs to a different take that exists only in the database. The save stops instead of overwriting that take. | Renumber the new takes row, or add the existing take to the page's takes table, then save with the current `expected_revision` and a **new** request ID (the content changed). |
| `invalid_source_uri` | `invalid_source_uri` | The brain has shared skillpacks, and the page's stored `source_uri` is a `file:` URI that cannot be turned into a local path, so gbrain cannot prove the write stays outside a skillpack. Shared-skill protection stays on. | The source owner inspects the page's stored `source_uri` on the brain host and replaces it with an absolute file URI or clears it; there is no dedicated command yet. Retry with a **new** request ID. |
| `queue_capacity` | `queue_capacity` | Admission would exceed a write-journal limit. Existing requests keep their place; nothing is evicted. For the cumulative limits (lifetime request IDs and receipt bytes), `detail` names the limit, for example `principal_lifetime_ids`. | For a cumulative limit, run the printed `gbrain config set persistence.limits.<limit> <value>` (sized for about one more year at the current rate), then retry with the **same** request ID. For outstanding-request, queued-byte or recovery-byte limits, let outstanding requests finish and check `gbrain sources writer status`. See [bounded admission and retention](concurrent-writes.md#bounded-admission-and-retention). |
| `targets_parked` (doctor: `parked_effects`) | effect `error_code` | A Git backup or withdrawal target failed five times in a row and was set aside so the other pages keep committing. The page write itself committed; its Git backup or withdrawal is incomplete. Contention, dependency waits, shutdown and transient database errors never count toward the five. | `gbrain sources writer status <source>`, fix the cause it names, preview with `gbrain sources writer retry-effects <source> --request-id <id> --dry-run`, then run it without `--dry-run`. Each run grants one more attempt per parked target; a target that fails again parks again. |

`gbrain doctor` reports parked targets as the `parked_effects` check with the
exact `retry-effects` command per request. It reports `persistence_capacity`
when lifetime request IDs or receipt bytes reach 80% of a limit, with the
`gbrain config set` value to use; outstanding-request, queued-byte and
recovery-byte limits can refuse writes without that warning.

## Related

- [Concurrent writes and durable receipts](concurrent-writes.md) — receipt states, retries, capacity limits
- [Repair residual damage](repair.md) — `gbrain repair` for history, visibility and safe-chunk damage
- [Multi-source brains](multi-source-brains.md) — sources, slug-root mode and write-through
- [Topologies](../architecture/topologies.md) — the writer administration procedure behind self-transfer
