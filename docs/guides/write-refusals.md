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
| <a id="embedding_budget_below_worst_case"></a>`embedding_budget_below_worst_case` | `embedding_budget_below_worst_case` | `gbrain migrate embeddings` (or the local `migrate_embeddings` operation) was given a `--max-cost-usd` cap below the migration's worst-case authorization: every planned provider request at its maximum input size, plus any debits a resumed run already holds. The run stopped before any provider request, re-chunk or vector invalidation, so nothing changed. The message and JSON carry `cap_usd`, `worst_case_usd`, `debited_usd` and `required_cap_usd`. | Re-run with the value the `suggestion` names, for example `gbrain migrate embeddings --to <provider:model> --dim <N> --max-cost-usd <required_cap_usd> --yes` (operation: `max_cost_usd`). Preview first with `--dry-run`, which prints the worst-case authorization beside the estimate. Requests settle to reported usage, so actual spend is usually far below the cap. See [embedding migration](embedding-migration.md). |
| `cursor_processing_options_conflict` | `invalid_params` | An unfinished sync's processing options (`--no-embed`, `--no-extract`, `--no-schema-pack`) conflict with this run, or the cursor predates saved options and has none. When options are saved, a run that omits those flags, including autopilot and `sync` jobs, adopts them. | When the message prints a resume command (`gbrain sync --source <source> --no-pull` plus the saved flags), run it or drop the conflicting flag. When it reports no saved options, resolve pending requests first, then rediscover with `gbrain sync --source <source> --no-pull --retry-failed` and the processing flags you want. |
| `take_row_collision` | `take_row_collision` | A save adds a takes-table row whose row number already belongs to a different take that exists only in the database. The save stops instead of overwriting that take. | Renumber the new takes row, or add the existing take to the page's takes table, then save with the current `expected_revision` and a **new** request ID (the content changed). |
| `invalid_source_uri` | `invalid_source_uri` | The brain has shared skillpacks, and the page's stored `source_uri` is a `file:` URI that cannot be turned into a local path, so gbrain cannot prove the write stays outside a skillpack. Shared-skill protection stays on. | The source owner inspects the page's stored `source_uri` on the brain host and replaces it with an absolute file URI or clears it; there is no dedicated command yet. Retry with a **new** request ID. |
| `queue_capacity` | `queue_capacity` | Admission would exceed a write-journal limit. Existing requests keep their place; nothing is evicted. For the cumulative limits (lifetime request IDs and receipt bytes), `detail` names the limit, for example `principal_lifetime_ids`. | For a cumulative limit, run the printed `gbrain config set persistence.limits.<limit> <value>` (sized for about one more year at the current rate), then retry with the **same** request ID. For outstanding-request, queued-byte or recovery-byte limits, let outstanding requests finish and check `gbrain sources writer status`. See [bounded admission and retention](concurrent-writes.md#bounded-admission-and-retention). |
| <a id="connector-account-changed"></a>`account_changed`, `account_unresolved` | `connector_account_changed` | A managed Google or GitHub connector's credential resolves to a different account than the one pinned for the source (Google email, GitHub App installation or login), or to no account at all. Google checks every enabled service before any service runs. Nothing was imported. No reset flag authorizes an account change. | The suggestion gives two branches with real values. (A) Restore the credential for the pinned account (the configured `g_token_env`, `g_token_command`, vault credential, `gh_token_env` or GitHub App key), then `gbrain sync --source <source>`. (B) For a deliberate change, add a new source for the new account (`gbrain google setup --account <email>`, or `gbrain sources add <new-id> --kind github … --app-install <id>`), then `gbrain sources archive <source>`; existing pages stay under the old source. |
| <a id="connector-intent-outdated"></a>`pre_upgrade` | `connector_intent_outdated` | A connector write was admitted in the intent format retired in v0.60.11.0. With detail `pre_upgrade` it was admitted before this brain's upgrade; otherwise a connector host older than v0.60.11.0 admitted it. The consumer recovers any file publication in progress first, then fails the request. | `pre_upgrade`: nothing to do; the item is fetched again on the next `gbrain sync --source <source>` under a new request ID. Otherwise: `gbrain upgrade` on the host that runs connector jobs, then `gbrain sync --source <source>`. |
| <a id="unsupported-mutation-protocol"></a>`consumer_upgrade_required` | `unsupported_mutation_protocol` | A v0.60.11.0 connector sent a `connector_v2_*` write to a persistence consumer older than v0.60.11.0, which does not know the format. Other `permission_denied` refusals on connector receipts are never relabeled as upgrades. | `gbrain upgrade` on every consumer and worktree-owner host, then `gbrain sync --source <source>`. Upgrade those hosts before connector hosts. |
| `unbound_source` | `owner_unavailable` | On Postgres, a page write went to a source that has a checkout path but no canonical owner. It is refused by default because another host may own the files. The same reason appears when the source was bound, or the page gained a canonical file, after a database-only write was accepted, and (as a `source_changed` sync failure) when a canonical file appears at the path of a page written while the source was unbound. | Bind the source (`gbrain sources writer status <source> --json`, then `gbrain sources writer claim <source> --path <checkout> --admin-intent writer_claim --expected-state <admin_state>`), or opt in with `gbrain config set persistence.unbound_write database_only`. See [unbound sources on Postgres](#unbound-sources-on-postgres). |
| <a id="embedding_zero_norm"></a>`zero_norm`, `non_finite` or `empty_input` | `embedding_zero_norm` | The embedding provider returned a vector with no direction (all zeros, NaN or infinity) for a chunk, or the chunk text was empty. A vector index silently skips such a row, so gbrain refuses to store it. Only that chunk is refused: the page text and every other chunk's vector are saved, and the page is left for `gbrain embed --stale`. It is never retried as a rate limit or network error. | Inspect the named page's chunk text (empty, whitespace- or symbol-only chunks are the usual cause) or the embedding provider, fix it, then run `gbrain embed <slug>` (add `--source <source>` for a non-default source). If normal text also returns zero vectors, the provider or model is broken; check it with `gbrain doctor`. |
| `targets_parked` (doctor: `parked_effects`) | effect `error_code` | A Git backup or withdrawal target failed five times in a row and was set aside so the other pages keep committing. The page write itself committed; its Git backup or withdrawal is incomplete. Contention, dependency waits, shutdown and transient database errors never count toward the five. | `gbrain sources writer status <source>`, fix the cause it names, preview with `gbrain sources writer retry-effects <source> --request-id <id> --dry-run`, then run it without `--dry-run`. Each run grants one more attempt per parked target; a target that fails again parks again. |
| <a id="writer_admin_locked"></a>`writer_admin_locked` | `writer_admin_locked` | The operator set the brain's writer admin lock (`gbrain sources writer lock`), so writer claim, activate, transfer prepare and transfer accept refuse for every caller. Ordinary writes are not affected. | Agents: stop and ask the operator; do not unlock it yourself. The operator runs, on the brain host, `gbrain sources writer unlock`, re-reads `gbrain sources writer status <source> --json`, administers, then `gbrain sources writer lock` again. See the [writer admin lock](../architecture/topologies.md#writer-admin-lock). |
| <a id="writer_not_quiesced"></a>`writer_not_quiesced` | `writer_not_quiesced` | Activation found an older writer, a legacy lock, or queued, running or recovering work. When work blocks it, the message names the blocking effect id, kind, source, page and request id. | Stop the writers named in the [claim and activate runbook](../architecture/topologies.md#claim-and-activate-runbook), inspect the named work with `gbrain sources writer status <source> --json`, let it finish, then retry. A committed write whose queued embedding effect is never claimed cannot be cleared by a command yet; see [stale queued embedding effects](repair.md#stale-queued-embedding-effects). |
| unknown option (repair) | `invalid_params` | `gbrain repair` refuses any option it does not list, so a mistyped flag or `--max-usd` never runs a repair silently without it. | Fix the option (`gbrain repair --help`). To cap paid repair work, run `gbrain doctor --remediate --yes --include-repairs --max-usd <n>`. |

`gbrain doctor` reports parked targets as the `parked_effects` check with the
exact `retry-effects` command per request. It reports `persistence_capacity`
when lifetime request IDs or receipt bytes reach 80% of a limit, with the
`gbrain config set` value to use; outstanding-request, queued-byte and
recovery-byte limits can refuse writes without that warning.

## Unbound sources on Postgres

A source with a checkout path (`local_path`, or `sync.repo_path` for the
`default` source) normally publishes every page write to a markdown file in
that checkout, through the source's canonical owner. PGLite claims that owner
automatically on the first write. Postgres does not, because several hosts can
share one Postgres brain and only one of them may own the files. Until someone
binds the source, `put_page`, `capture` and `delete_page` to it refuse with
`owner_unavailable` and `detail: unbound_source`. The suggestion names both
ways out with the real source filled in:

1. **Bind the source** on the host that holds the checkout. Run
   `gbrain sources writer status <source> --json` and note `admin_state`, then
   `gbrain sources writer claim <source> --path <checkout> --admin-intent writer_claim --expected-state <admin_state>`.
   If an operator has locked writer administration, ask them to unlock it
   first. Read [topologies](../architecture/topologies.md) before claiming a
   source that other hosts write to.
2. **Allow database-only writes** with
   `gbrain config set persistence.unbound_write database_only` (the default is
   `refuse`; no other value is accepted, and the key can only be set on the
   brain host). A `put_page` to a new page, or to a page that is already
   database-only, then writes to the database only. Its result says
   `write_through: { written: false, skipped: "unbound_source" }` with a
   warning. Pages written this way stay database-only: binding the source
   later does not materialize them into canonical files, later writes keep
   them database-only, and sync never deletes or overwrites them.

The opt-in never applies to a page that came from a canonical file (it has a
stored source path). An edit there could be lost on the owner's next sync, so
it keeps refusing with only the bind option. `capture` and `delete_page` also
keep refusing.

If the source is bound after a database-only write was accepted but before it
was published, the write fails with the same reason and nothing is written;
read the page again and resubmit with a new request ID. If a canonical file
appears at the path of a database-only page after binding, sync stops for that
file with `source_changed` and reason `unbound_source`; neither copy is
overwritten and the database page stays served. Rename or remove the file,
commit, and sync again.

`gbrain doctor` reports the `unbound_source` check: the number of such pages
per source. While the source is unbound it is `ok` and prints the bind command;
after binding it warns, because those pages sit outside the canonical files.
There is no command yet that turns them into files; to move one, save its
content under a new slug and delete the database-only page.

## Related

- [Concurrent writes and durable receipts](concurrent-writes.md) — receipt states, retries, capacity limits
- [Repair residual damage](repair.md) — `gbrain repair` for history, visibility and safe-chunk damage
- [Multi-source brains](multi-source-brains.md) — sources, slug-root mode and write-through
- [Topologies](../architecture/topologies.md) — the writer administration procedure behind self-transfer
