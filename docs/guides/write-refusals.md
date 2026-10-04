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
inspection instruction. A failed write receipt (`gbrain write-request <id>`) carries the error code as
`write_error` and its diagnostic message as `write_error_message`; managed
sync and memory-verb errors add the specific reason.
Run recovery commands on the brain host unless the row says otherwise.

Keep the original `request_id`. Unless a row says to use a new one, retry the
original write with the same ID after the fix, so the brain replays it instead
of making a duplicate.

## Reference

| Reason | Error code | What it means | Recovery |
| --- | --- | --- | --- |
| `file_database_drift` | `source_changed` | The page's canonical file and its database copy disagree, usually because the file was edited outside a coordinated write. Neither copy was overwritten. A file with no `type:` line keeps the stored type, and titles compare trimmed, so those alone no longer cause this. | `gbrain sources reconcile <source> <slug> --brain <brain> --preview`, review the preview, resolve it, then `--apply <resolved-preview-file> --request-id <new uuid>`. Retry the original write with a **new** request ID. See [repair a file/database disagreement](concurrent-writes.md#repair-a-filedatabase-disagreement). |
| <a id="writer-coordinator-required"></a>`database_guard` or `database_trigger` | `writer_coordinator_required` (or `storage_error` for another trigger) | A database trigger refused a row while a write was being prepared or published, so nothing was committed and any canonical file already replaced was restored. With `database_guard`, a gbrain process wrote a row its publication does not own (another source, an unresolvable source, or a source checkpoint/topology change outside owner administration). This is a gbrain defect or a version mismatch between gbrain processes sharing the database, not a content conflict. The receipt's `write_error_detail` names the table, operation, guard branch, source relationship and stage; it never contains page text or source names. | On the brain host run `gbrain sources writer status --probe --json`. Its `recent_failures[].error_detail` adds the source ids and the gbrain build and host that ran the attempt (`attempt.consumer_version`). If that build differs from `gbrain --version`, upgrade or restart every gbrain process that shares the database (serve, autopilot, sync jobs), then retry with a **new** request ID. If the builds match, report `error_detail` on the gbrain issue tracker. Never force-write, edit SQL or disable the guard. |
| `ambiguous_source_path` | `page_identity_changed` | A source registered at a Git subfolder `<sub>` has a page whose stored path `<sub>/<file>` could mean either `<file>` in the source directory (the older Git-root spelling) or `<sub>/<file>` inside a folder of the source that repeats its name, and both files exist. Sync refuses instead of guessing. See [sources in a Git subfolder](multi-source-brains.md#sources-in-a-git-subfolder). | Rename or move one of the two files, commit, then `gbrain sync --source <source> --no-pull --retry-failed`. |
| `physical_root_device_changed` | `recovery_required` | The checkout's filesystem device number changed while everything else matches, which macOS can do after a reboot. When the owner token, brain, worktree, root, inode and a non-zero birth time all match and the caller can verify database ownership, the write path re-stamps ownership by itself and the write proceeds. This refusal means the automatic re-stamp could not be verified; the suggestion says why. | Do a deliberate self-transfer: `gbrain sources writer status <source>` (note `admin_state`), then `gbrain sources writer transfer prepare <source> --self-transfer --admin-intent writer_transfer_prepare --expected-state <admin_state>`, then `gbrain sources writer transfer accept <source> --path <root> --expected-epoch <epoch> --manifest <digest from prepare> --self-transfer --admin-intent writer_transfer_accept --expected-state <fresh admin_state>`. Retry the original write with the **same** request ID. Never delete ownership marker files. |
| <a id="embedding_budget_below_worst_case"></a>`embedding_budget_below_worst_case` | `embedding_budget_below_worst_case` | `gbrain migrate embeddings` (or the local `migrate_embeddings` operation) was given a `--max-cost-usd` cap below the migration's worst-case authorization: every planned provider request at its maximum input size, plus any debits a resumed run already holds. The run stopped before any provider request, re-chunk or vector invalidation, so nothing changed. The message and JSON carry `cap_usd`, `worst_case_usd`, `debited_usd` and `required_cap_usd`. | Re-run with the value the `suggestion` names, for example `gbrain migrate embeddings --to <provider:model> --dim <N> --max-cost-usd <required_cap_usd> --yes` (operation: `max_cost_usd`). Preview first with `--dry-run`, which prints the worst-case authorization beside the estimate. Requests settle to reported usage, so actual spend is usually far below the cap. See [embedding migration](embedding-migration.md). |
| frontmatter slug conflict | `invalid_params` | `gbrain sync` found a file whose frontmatter `slug:` names a different page than its path. The message names the file, the frontmatter slug and the slug its path expects. Nothing was written. | Remove the `slug:` line or make it match the path, commit, then run `gbrain sync --source <source> --retry-failed`. |
| `cursor_processing_options_conflict` | `invalid_params` | An unfinished sync's processing options (`--no-embed`, `--no-extract`, `--no-schema-pack`) conflict with this run, or the cursor predates saved options and has none. When options are saved, a run that omits those flags, including autopilot and `sync` jobs, adopts them. | When the message prints a resume command (`gbrain sync --source <source> --no-pull` plus the saved flags), run it or drop the conflicting flag. When it reports no saved options, resolve pending requests first, then rediscover with `gbrain sync --source <source> --no-pull --retry-failed` and the processing flags you want. |
| `take_row_collision` | `take_row_collision` | A save adds a takes-table row whose row number already belongs to a different take that exists only in the database. The save stops instead of overwriting that take. | Renumber the new takes row, or add the existing take to the page's takes table, then save with the current `expected_revision` and a **new** request ID (the content changed). |
| `invalid_source_uri` | `invalid_source_uri` | The brain has shared skillpacks, and the page's stored `source_uri` is a `file:` URI that cannot be turned into a local path, so gbrain cannot prove the write stays outside a skillpack. Shared-skill protection stays on. | The source owner inspects the page's stored `source_uri` on the brain host and replaces it with an absolute file URI or clears it; there is no dedicated command yet. Retry with a **new** request ID. |
| `queue_capacity` | `queue_capacity` | Admission would exceed a write-journal limit. Existing requests keep their place; nothing is evicted. For the cumulative limits (lifetime request IDs and receipt bytes), `detail` names the limit, for example `principal_lifetime_ids`. | For a cumulative limit, run the printed `gbrain config set persistence.limits.<limit> <value>` (sized for about one more year at the current rate), then retry with the **same** request ID. For outstanding-request, queued-byte or recovery-byte limits, let outstanding requests finish and check `gbrain sources writer status`. See [bounded admission and retention](concurrent-writes.md#bounded-admission-and-retention). |
| <a id="checkpoint-validation-timeout"></a>`index_building`, `index_missing` or `indexes_valid` | `checkpoint_validation_timeout` | A managed sync's checkpoint validation (the check that every page receipt of the run committed) hit the coordinator's 5-second statement timeout on a large `persistence_requests` table. The checkpoint request failed terminally instead of being retried ahead of every other write to the source, so other writes proceed; `last_commit` is unchanged and every page the run already committed stays committed. `detail` says which of three states the request indexes were in when the hint was built. | `index_building`: this release's index migration is still building the indexes; wait (doctor `persistence_request_indexes` shows progress), then run the printed retry. `index_missing`: run `gbrain repair request-indexes --apply` (it drops an INVALID index and rebuilds it concurrently on Postgres), then the printed retry. `indexes_valid`: run the printed retry once; if it times out again, report the request id with the `persistence_request_indexes` and `persistence_request_growth` entries of `gbrain doctor --json`. The retry is `gbrain sync --source <source> --no-pull --retry-failed` plus the run's `--repo` base and cursor options (`--full`, `--working-tree`, `--src-subpath`, `--exclude`, `--include-hidden`, `--strategy`) and saved processing flags, so it resumes the same cursor. Do not cancel the request: a cancelled checkpoint still blocks the next one. |
| <a id="connector-account-changed"></a>`account_changed`, `account_unresolved` | `connector_account_changed` | A managed Google or GitHub connector's credential resolves to a different account than the one pinned for the source (Google email, GitHub App installation or login), or to no account at all. Google checks every enabled service before any service runs. Nothing was imported. No reset flag authorizes an account change. | The suggestion gives two branches with real values. (A) Restore the credential for the pinned account (the configured `g_token_env`, `g_token_command`, vault credential, `gh_token_env` or GitHub App key), then `gbrain sync --source <source>`. (B) For a deliberate change, add a new source for the new account (`gbrain google setup --account <email>`, or `gbrain sources add <new-id> --kind github … --app-install <id>`), then `gbrain sources archive <source>`; existing pages stay under the old source. |
| <a id="connector-intent-outdated"></a>`pre_upgrade` | `connector_intent_outdated` | A connector write was admitted in the intent format retired in v0.60.11.0. With detail `pre_upgrade` it was admitted before this brain's upgrade; otherwise a connector host older than v0.60.11.0 admitted it. The consumer recovers any file publication in progress first, then fails the request. | `pre_upgrade`: nothing to do; the item is fetched again on the next `gbrain sync --source <source>` under a new request ID. Otherwise: `gbrain upgrade` on the host that runs connector jobs, then `gbrain sync --source <source>`. |
| <a id="invalid-connector-text"></a>`invalid_connector_text` | `invalid_connector_text` | A Google or GitHub item's identity field (a path, item id or account) contains a NUL or an unpaired UTF-16 surrogate, which cannot be stored. Prose (bodies, subjects, titles) is cleaned at render time and never refused. The item is counted toward a hold; the rest of the sync continues. | Nothing to run for one refusal. Once the item is held, `gbrain sources status <source>` names it; after the provider data is fixed, `gbrain sources retry-held <source>`, then `gbrain sync --source <source>`. |
| <a id="connector-holds-exhausted"></a>`connector_holds_exhausted` | `connector_holds_exhausted` | A Google or GitHub source already holds 100 items and this sync would hold another. The sync stopped without advancing its cursor. So many held items usually means a source-wide problem (a broken renderer, a revoked scope), not bad items. | `gbrain sources status <source>` to see the held items and their error codes, fix the cause, then `gbrain sources retry-held <source>` and `gbrain sync --source <source>`. `gbrain sync --source <source> --full` also clears every hold. |
| <a id="connector-fence-below-timeline"></a>`fence_not_carried` | `connector_fence_below_timeline` | A managed connector re-render would have dropped a facts or takes fence the stored page keeps below its timeline sentinel, or one that is duplicated, unbalanced or unparseable. The write was refused so those rows are not expired; the item is counted toward a hold. | Preview `gbrain repair connector-fences --source <source>`, apply it after review with `--apply`, then `gbrain sources retry-held <source>`. A page the repair counts as ambiguous needs a manual edit (see [repair](repair.md)). |
| <a id="unsupported-mutation-protocol"></a>`consumer_upgrade_required` | `unsupported_mutation_protocol` | A v0.60.11.0 connector sent a `connector_v2_*` write to a persistence consumer older than v0.60.11.0, which does not know the format. Other `permission_denied` refusals on connector receipts are never relabeled as upgrades. | `gbrain upgrade` on every consumer and worktree-owner host, then `gbrain sync --source <source>`. Upgrade those hosts before connector hosts. |
| `unbound_source` | `owner_unavailable` | On Postgres, a page write went to a source that has a checkout path but no canonical owner. It is refused by default because another host may own the files. The same reason appears when the source was bound, or the page gained a canonical file, after a database-only write was accepted, and (as a `source_changed` sync failure) when a canonical file appears at the path of a page written while the source was unbound. | Bind the source (`gbrain sources writer status <source> --json`, then `gbrain sources writer claim <source> --path <checkout> --admin-intent writer_claim --expected-state <admin_state>`), or opt in with `gbrain config set persistence.unbound_write database_only`. See [unbound sources on Postgres](#unbound-sources-on-postgres). |
| <a id="embedding_zero_norm"></a>`zero_norm`, `non_finite` or `empty_input` | `embedding_zero_norm` | The embedding provider returned a vector with no direction (all zeros, NaN or infinity) for a chunk, or the chunk text was empty. A vector index silently skips such a row, so gbrain refuses to store it. Only that chunk is refused: the page text and every other chunk's vector are saved, and the page is left for `gbrain embed --stale`. It is never retried as a rate limit or network error. | Inspect the named page's chunk text (empty, whitespace- or symbol-only chunks are the usual cause) or the embedding provider, fix it, then run `gbrain embed <slug>` (add `--source <source>` for a non-default source). If normal text also returns zero vectors, the provider or model is broken; check it with `gbrain doctor`. |
| `targets_parked` (doctor: `parked_effects`) | effect `error_code` | A Git backup or withdrawal target failed five times in a row and was set aside so the other pages keep committing. An effect `error_code` of `git_index_stale` means an index lock older than 10 minutes blocks the checkout: `.git/index.lock` in it (`git -C <checkout> rev-parse --git-path index.lock` for a linked worktree). Remove it only if no git command is running there, then run the `retry-effects` command. A fresher lock (`git_index_locked`) is retried as contention and never parks. The page write itself committed; its Git backup or withdrawal is incomplete. Contention, dependency waits, shutdown and transient database errors never count toward the five. | `gbrain sources writer status <source>`, fix the cause it names, preview with `gbrain sources writer retry-effects <source> --request-id <id> --dry-run`, then run it without `--dry-run`. Each run grants one more attempt per parked target; a target that fails again parks again. |
| <a id="writer_admin_locked"></a>`writer_admin_locked` | `writer_admin_locked` | The operator set the brain's writer admin lock (`gbrain sources writer lock`), so writer claim, activate, transfer prepare and transfer accept refuse for every caller. Ordinary writes are not affected. | Agents: stop and ask the operator; do not unlock it yourself. The operator runs, on the brain host, `gbrain sources writer unlock`, re-reads `gbrain sources writer status <source> --json`, administers, then `gbrain sources writer lock` again. See the [writer admin lock](../architecture/topologies.md#writer-admin-lock). |
| <a id="writer_not_quiesced"></a>`writer_not_quiesced` | `writer_not_quiesced` | Activation found an older writer, a legacy lock, or queued, running or recovering work. When work blocks it, the message names the blocking effect id, kind, source, page and request id. | Stop the writers named in the [claim and activate runbook](../architecture/topologies.md#claim-and-activate-runbook), inspect the named work with `gbrain sources writer status <source> --json`, let it finish, then retry. A committed write whose embedding effect is stuck queued or failed is settled by `gbrain repair embedding-effects --source <source>` (preview), then the same command with `--apply`; see [stale queued embedding effects](repair.md#stale-queued-embedding-effects). |
| <a id="activation_source_path_missing"></a>`source_path_missing` | `source_changed` | `gbrain sources writer activate` (with or without `--dry-run`) found a source whose recorded `local_path` no longer exists on this host, for example a checkout that lived in a temporary directory. Activation cannot verify that source's canonical directory, so nothing changed. The message names the source and the missing path. Claiming the source at another directory does not help while the stale path stays recorded. | Run the command the suggestion prints: `gbrain sources set-path <source> <directory>` to point the source at its checkout (the suggestion fills in the claimed directory when the source is claimed), or `gbrain sources remove <source> --confirm-destructive` when the source is no longer needed (`gbrain sources archive <source>` keeps a 72-hour grace period). Then `gbrain sources writer activate --confirm-quiesced --dry-run` and activate. |
| <a id="source_checkout_missing"></a>canonical checkout missing | `recovery_required` | A managed source lifecycle command (`gbrain sources archive`, `remove`, `purge`, `restore`, `rebind`) found that the source's canonical checkout directory was deleted out of band. A source with **no pages** that is the **only** source on that checkout is retired anyway: archive, remove and purge succeed and the receipt records `retired_without_checkout` with the missing path. Otherwise nothing changed; the message names the path, the page count and how many other sources share the checkout. Recreating an empty directory at the same path does not help (its physical identity differs). | Restore the checkout (for example from a backup) and retry. If it is gone for good, switch the brain to classic mode with `gbrain sources writer deactivate --dry-run`, then the printed `apply_command` (see the [deactivate runbook](../architecture/topologies.md#deactivate-runbook)), and retire the source there with `gbrain sources archive <source>`. |
| <a id="migrations_running"></a>`migrations_running` | `migrations_running` (exit 75) | `gbrain apply-migrations` (or the post-upgrade step of `gbrain upgrade`) found another runner holding the brain's orchestration lock and stopped before touching the migration ledger, so migrations never run twice in parallel. The message names the holder's host and pid. A holder that died is taken over automatically on the next run. `gbrain upgrade` reports this as `Migrations: running`, not as a failed upgrade. | Wait for the other run to finish; `gbrain doctor` shows migration progress. Then `gbrain apply-migrations --yes` confirms everything is applied. |
| <a id="writer_deactivate"></a>`writer_deactivate` blockers | `writer_not_quiesced`, `writer_admin_locked`, `writer_admin_state_changed`, `writer_lock_unavailable` | `gbrain sources writer deactivate` found pending work (a queued, running or recovering write, a topology change or effect that is not settled, a held connector item, or a live connector or maintenance lease), the writer admin lock, a changed admin state, or a local process holding a worktree lock. Nothing changed. The suggestion names each blocker and its exit. | Run `gbrain sources writer deactivate --dry-run` for the full list, run each named exit (`gbrain cancel-write-request <request_id>`, `gbrain sync --source <id> --no-pull --retry-failed`, `gbrain repair embedding-effects --source <id>`, `gbrain sources writer retry-effects <source> --request-id <id> --dry-run`, `gbrain sources writer unlock`, `gbrain sources retry-held <id>`), then deactivate again with a fresh `--expected-state` from `gbrain sources writer status --json`. See the [deactivate runbook](../architecture/topologies.md#deactivate-runbook). |
| <a id="extract-timeline-refused"></a>timeline extract refused | the printed code, usually `writer_coordinator_required` | `gbrain extract timeline --source db` (or a timeline-only `gbrain extract timeline` on a managed brain) could not write a page's timeline rows. It prints `refused: <code>; nothing written; existing timeline rows are untouched` per page, a summary of written versus refused, and exits 1. The rows import already stored for each page stay as they were. | `gbrain extract --stale` (add `--source-id <id>` when you scoped the run) publishes links and missing timeline rows on the managed path. If it refuses too, follow the row for the printed code. |
| unknown option (repair) | `invalid_params` | `gbrain repair` refuses any option it does not list, so a mistyped flag or `--max-usd` never runs a repair silently without it. | Fix the option (`gbrain repair --help`). To cap paid repair work, preview with `gbrain doctor --remediation-plan --json` and, after the user agrees, run `gbrain doctor --remediate --yes --include-repairs --expect <plan_hash> --max-usd <n>`. |
| <a id="colon_slug_windows_write_through"></a>`colon_slug_windows_write_through` | `colon_slug_windows_write_through` | A page slug such as `calendar:abc` is valid, but its canonical file name would contain `:`, which Windows cannot store (it names an alternate data stream). On Windows, a write that would publish that file is refused before admission, and `gbrain sync` skips each such file with this reason instead of failing the run. Database-only writes of the same slug (no repo configured, `sync.write_through` off, an unbound source, or a [read-only mirror](multi-source-brains.md#read-only-mirror-sources) source and pages created while it was one) still succeed, and macOS and Linux are unchanged. | Use a slug without `:` (the suggestion names one), or write the page from a macOS or Linux host that owns the source. For a skipped sync file, rename it without `:` on a macOS or Linux checkout, commit, then run `gbrain sync --source <source> --no-pull` on the Windows host. |
| <a id="embedding_auth_failed"></a>`embedding_auth_failed` | `embedding_auth_failed` | The embedding provider rejected the configured key (HTTP 401 or 403). Printed once per process on stderr, naming the key source in effect: an environment variable (for example `OPENAI_API_KEY`, which wins over the config key) or the config key in `~/.gbrain/config.json`. No key or part of one is printed. | Environment key in effect but the config key is right: remove the variable from the environment of the process that reported it (shell profile, `~/.gbrain/.env`, or a daemon's service definition) and restart that process. Environment key intended: replace it with a valid key, restart, and run `gbrain config unset openai_api_key` (or the matching key). Config key in effect: `gbrain config set openai_api_key <valid key>`. Then `gbrain embed --stale` embeds what was saved meanwhile. `gbrain doctor` (`embedding_key_source`) shows the key source in doctor's own environment. |
| <a id="managed_pull_skipped"></a>`managed_pull_skipped` (cycle warn); doctor `sync_freshness` "upstream unknown" or "upstream N commit(s) ahead" | `managed_pull_skipped` | A managed brain never runs `git pull` inside a cycle: Git pull needs an explicit drained maintenance window, so an explicit `gbrain sync` without `--no-pull` is refused with `writer_coordinator_required`. An unattended cycle asked to pull (autopilot passes `pull: true`, `gbrain dream --pull`) instead syncs the checkout as it is and reports it: the sync phase result carries `details.upstream_refresh` (`pulled`, `failed`, `skipped_managed` or `not_requested`), and when the checkout tracks an upstream the phase is `warn` with `details.warning` (`code`, `cause`, `fix`, `docs`). Every sync also records the checkout's last upstream observation (the upstream commit, when it was last fetched or pushed, and how many upstream commits the synced commit lacks) in the source row. Doctor `sync_freshness` reports that separately from the local projection: a source with a `remote_url` whose observation is missing or older than 24 hours is "upstream unknown", and any source whose observation saw upstream commits it has not synced is "behind"; neither is reported fresh. `details.upstream_unknown_count` and `details.upstream_behind_count` count them. | `gbrain sources refresh <source>` (the printed `fix` fills in the source). It drains writes to the source's checkout, fast-forwards it to its upstream and runs the managed sync for every source bound to that checkout; see [worktree refresh refusals](#worktree-refresh-refusals) for what it can refuse. On a brain that is not managed, `gbrain sync --source <source>` pulls and records the observation. |
| <a id="facts_absorb_write_refused"></a>`facts_absorb_write_refused (<code>)`; `ingest_log` `write_refused: <code> …` | `facts_absorb_write_refused` | A durable `facts-absorb` job extracted facts but the write path refused to store them, for example `writer_coordinator_required` because the entity's Markdown file sits in a claimed canonical worktree before `sources writer activate`, or `permission_denied`, `invalid_params` or `writer_registration_required`. These refusals do not change on retry, so the job goes straight to `dead` on its first attempt instead of re-running inference; on a brain that is not yet activated, a job whose source root is a claimed worktree is refused before extraction starts, so it makes no model call; the `facts:absorb` row in `ingest_log` (and doctor `facts_extraction_health`) records `write_refused` with the real code, not a provider failure. The source page itself was already saved. | Fix the named cause first: `gbrain sources writer status <source>`, then finish the [claim and activate runbook](../architecture/topologies.md#claim-and-activate-runbook) for a claimed worktree, or fix the grant. Then `gbrain jobs retry <job id>` (the error names the id). |
| <a id="no_pricing"></a>`no_pricing` | `no_pricing` | A cost cap you set (`--max-cost`, `--max-usd`, `--max-cost-usd`, or an explicit cap in config such as `cycle.extract_atoms.budget_usd`) cannot be enforced, because gbrain has no price for the model the run was about to call. The run stops before that call. Under a default cap an unpriced model warns and runs instead. The message names the model, provider and kind, and JSON output carries the same guidance as fields: `code`, `model`, `provider`, `kind`, `units`, `lookup`, `register_command`, `register_scope` and `docs`. | Look up the provider's current price for the model, for example by searching the web for its pricing page. A chat model needs USD per 1M input tokens and USD per 1M output tokens; an embedding or reranker model needs USD per 1M tokens. On the brain host, run `gbrain pricing set <model> --input <usd> --output <usd> --source <pricing-page-url>` (or `--rate <usd>`), then retry. An agent connected over MCP cannot register prices: give the command to the brain's operator. See [registering a model price](../operations/spend-controls.md#registering-a-model-price). |

### Other error codes

These codes carry no separate reason. Each is listed so every write error code
a receipt can report has a row here.

| Reason | Error code | What it means | Recovery |
| --- | --- | --- | --- |
| `writer_pool_capacity` | `writer_pool_capacity` | The canonical owner has no free publication slot right now; the write stays queued. | Wait and poll the receipt (`gbrain write-request <id>`). If it persists, check `gbrain sources writer status <source>`. |
| `revision_required` | `revision_required` | The operation must be bound to a revision you reviewed (for example `--if-version` or `expected_revision`), and none was given. | Preview first, then repeat with the revision the preview printed. |
| `revision_conflict` | `revision_conflict` | The page changed after the revision this write was bound to. Nothing was overwritten. | Re-read the page, merge your change, and save with the new revision. |
| `revision_backfill_pending` | `revision_backfill_pending` | The page was written before page revisions existed (an upgrade from below schema v150) and the resumable revision backfill has not reached it, so it has no revision to bind to. Its revision reads as `backfill_pending`, never a UUID. Nothing was written. | Resume the backfill with `gbrain apply-migrations --yes` (it prints its progress). If it reports rows it could not update, run `gbrain repair orphan-children` to preview orphaned child rows and torn page bodies ([orphan children](repair.md#orphan-children)). |
| `idempotency_conflict` | `idempotency_conflict` | The `request_id` was already used for a different target, content or protocol. | Use a new `request_id` for a different write; reuse an ID only to replay the same write. |
| <a id="write_pending"></a>`write_pending` | `write_pending` (CLI exit 10) | The write was accepted but has not committed yet. It keeps its request ID and may still commit. The CLI exits 10, not 1; a lost acknowledgment with no receipt is `submission_status: "unknown"` and exits 1. See [CLI exit status for writes](../protocol/MEMORY_VERBS_v1.md#cli-exit-status-for-writes). | Poll `gbrain call get_write_request '{"request_id":"<id>"}'`, or repeat the same command with the same `--request-id` and a longer `--wait <seconds>`. Scripts that only need the write admitted pass `--accept-pending` (or `GBRAIN_ACCEPT_PENDING=1`) to exit 0. |
| <a id="invalid_write_wait"></a>`invalid_write_wait` | `invalid_write_wait` | `GBRAIN_WRITE_WAIT_MS` or `persistence.write_wait_ms` is not a whole number of milliseconds from 0 to 600000. Nothing was written. | `unset GBRAIN_WRITE_WAIT_MS` (or set it to e.g. `30000`), or `gbrain config set persistence.write_wait_ms 30000`. |
| <a id="edit_page"></a>`edit_no_match`, `edit_ambiguous_match`, `edit_protected_span`, `edit_invalid` | same | An `edit_page` edit matched nothing, matched more than once, touched a protected takes/facts section, or was malformed. `detail` names `edit_index` (and `match_count`). Nothing was admitted. | Re-read `get_page include_content:true`, fix the named edit and resend with a **new** request ID. See [partial page edits](../protocol/MEMORY_VERBS_v1.md#partial-page-edits-edit_page). |
| `storage_error` | `storage_error` | The write did not commit for a reason with no more specific code. | Inspect the durable request with `gbrain write-request <id>` on the source host and follow its message. |
| `cancelled` | `cancelled` | The request was cancelled before it committed. Nothing was written. | Submit the write again if you still want it. |
| `permission_denied` | `permission_denied` | The caller is not allowed to make this write (a trust boundary, slug fence or lock). | Run it as a caller that has the permission, usually the trusted local CLI on the brain host. |
| <a id="no_source_grant"></a>`fence=no_source_grant` | `permission_denied` | The legacy bearer token's source grant is an explicit empty list (`gbrain auth rescope --token <name> --sources none`), or its sources axis has drifted (an older gbrain edited its `permissions` JSON after the grant moved to columns; doctor `legacy_token_grant_drift`), so it reads and writes no source. A write accepted before that change is refused at publication. It never falls back to the `default` source. | On the brain host: `gbrain auth rescope --token <name>` shows the grant and any drift. Empty grant: the refusal's `fix` carries the command with this token's id filled in (`gbrain auth rescope-token --id <token-id> --sources <id,...>`; the agent asks the user for the sources), or `gbrain auth list` when the token cannot be named. Drift: ask the user which grant is intended, then `gbrain auth rescope --token <name> --adopt-permissions` or `--adopt-columns` (see [grant drift](../mcp/ADMIN.md#grant-drift)). Then retry with the **same** request ID. |
| `scope_denied` | `scope_denied` | The caller's token or grant does not cover this operation or source. | Use a client with the needed scope and source grant. |
| `not_found` | `not_found` | The request, source or object named by the call does not exist. | Check the id; `gbrain sources list` lists sources. |
| `page_not_found` | `page_not_found` | The target page does not exist in that source, or disappeared during the write. | Check the slug and `--source`, then retry. |
| `write_claim_lost` | `write_claim_lost` | Another execution took over this request while it ran; that execution owns the outcome. | Poll `gbrain write-request <id>`; do not resubmit under a new ID. |
| `request_too_large` | `request_too_large` | The request is larger than the configured request or recovery capacity. | Split the write, or raise the limit the message names on the brain host. |
| `response_too_large` | `response_too_large` | The persistence response exceeded the local transport limit. The write may still have committed. | Poll `gbrain write-request <id>` before retrying. |
| `writer_registration_required` | `writer_registration_required` | The source needs an active canonical owner before this operation, for example activation. | Claim the source on its owner host (`gbrain sources writer status <source>` names the next step). |
| `writer_identity_invalid` | `writer_identity_invalid` | This host's local writer identity file is unreadable or has an unknown format. | Run `gbrain doctor` on the host; it names the identity file to repair. |
| `writer_not_initialized` | `writer_not_initialized` | The brain has no persistence identity yet, usually because migrations have not run. | Run `gbrain apply-migrations --yes` on the brain host. |
| <a id="managed-guard-page-children"></a>`writer_coordinator_required: canonical writer must use the persistence coordinator` on a tag, timeline or take write; on the client `storage_error: Publication failed (P0001)` | `writer_coordinator_required` (`storage_error` on the stored receipt) | Before v0.60.38.0, on a managed brain whose `tags`, `timeline_entries` or `takes` table had a `source_id` column gbrain does not create, the managed writer guard refused every insert and update of those rows, including coordinated ones (#5983). From v0.60.38.0 those rows always take their source from their page and the column is ignored. An uncoordinated delete of such a row on a live page is now refused there too, as on every other brain. | Upgrade to v0.60.38.0 or later on the brain host, then follow its recovery steps in the [CHANGELOG](../../CHANGELOG.md) (or [repair](repair.md#recover-after-upgrading-to-this-release)): `gbrain sync … --no-pull --retry-failed`, `gbrain extract --stale`, `gbrain extract timeline --source db`, a previewed `gbrain facts relink`, then `gbrain repair failed-writes` (preview, then `--apply --expect <hash>`) for the refused `put_page`, `add_timeline_entry` and `remember` calls; see [failed writes](repair.md#failed-writes). |
| `writer_coordinator_required` | `writer_coordinator_required` | The operation needs managed persistence (the write coordinator) and this brain or call path does not use it. A file write refused because the path sits in a managed canonical worktree names that worktree in the message, and its `detail` reads `root=<directory> source=<id or unknown> evidence=<marker file, managed-root registry or source binding>`. | Run the operation through the command the message names, on a managed brain. When the brain is not managed and the evidence is an ownership file (`.gbrain-owner.json`, `.gbrain-owner-<hash>.json`, `.gbrain-managed`), check it with `gbrain sources writer status` before removing anything: a half-finished claim is finished or rolled back through writer administration. |
| `fact_already_expired` | `fact_already_expired` | The fact the write targets is already expired or withdrawn. | Nothing to do; list active facts to find the current one. |
| `source_writeback_required` | `source_writeback_required` | The write needs a correction to the source's repository files, and this caller or profile never writes them. | Make the correction in the source repository, then sync. |
| `writer_upgrade_required` | `writer_upgrade_required` | The brain's schema is older than this operation needs. | Run `gbrain upgrade` (or `gbrain apply-migrations --yes`) on the brain host. |
| `skill_bundle_required` | `skill_bundle_required` | The write targets a shared-skill path, which only the shared skill publisher may write. | Publish the skill through the shared skill publisher instead. |

`gbrain doctor` reports parked targets as the `parked_effects` check with the
exact `retry-effects` command per request. It reports `persistence_capacity`
when lifetime request IDs or receipt bytes reach 80% of a limit, with the
`gbrain config set` value to use; outstanding-request, queued-byte and
recovery-byte limits can refuse writes without that warning.

## Worktree refresh refusals

`gbrain sources refresh <source>` is the one supported way to move a managed
checkout to new upstream commits. It runs on the source's registered owner
host, fetches, then refuses new writes to every source that shares the
checkout while queued writes finish, fast-forwards with `git merge --ff-only`
and syncs each of those sources with `--no-pull`. Each refusal below prints
`code`, a one-line `cause`, a literal `fix` with the real source filled in and
this anchor (`--json` puts them in one object on stdout); the command exits 1.

**Say to your agent:** *"Pull the latest commits into my notes source."* or
*"The refresh was refused. What do I need to do?"*

| Reason | Error code | What it means | Recovery |
| --- | --- | --- | --- |
| <a id="refresh_not_managed"></a>`refresh_not_managed` | `refresh_not_managed` | The brain is not managed, or the source has no claimed checkout. Plain sync already pulls such a source, so there is nothing to coordinate. | `gbrain sync --source <source>`. |
| <a id="refresh_not_owner"></a>`refresh_not_owner` | `refresh_not_owner` | This host is not the source's registered owner, and only the owner may move its checkout. | Run `gbrain sources refresh <source>` on the owner host; `gbrain sources writer status <source>` names it. |
| <a id="refresh_no_upstream"></a>`refresh_no_upstream` | `refresh_no_upstream` | The checkout's branch tracks no upstream (or HEAD is detached), so there is nothing to fast-forward to. | `git -C <checkout> branch --set-upstream-to <remote>/<branch>` (the fix fills in the real values), then retry. |
| <a id="fetch_failed"></a>`fetch_failed` | `fetch_failed` | `git fetch` failed or did not finish within `sources.refresh_fetch_timeout_ms` (default 120000; `GBRAIN_REFRESH_FETCH_TIMEOUT_MS`; `--fetch-timeout-ms` wins over both). Nothing changed and no refresh record was written. | Retry. For a slow remote, raise the bound with `--fetch-timeout-ms <ms>` or `gbrain config set sources.refresh_fetch_timeout_ms <ms>`. Credentials are the user's: ask them to fix authentication rather than changing the remote. |
| <a id="refresh_diverged"></a>`refresh_diverged` | `refresh_diverged` | The checkout has commits its upstream lacks, so a fast-forward is impossible. Nothing changed. | Reconcile the histories and push from a clone that is not managed, then retry. `gbrain sources reclone <source>` replaces the checkout; ask the user first, because local commits are dropped. |
| <a id="refresh_dirty"></a>`refresh_dirty` | `refresh_dirty` | Uncommitted or untracked files overlap the incoming upstream changes (the first 20 are named), or `git merge --ff-only` refused for the same reason. HEAD did not move. Uncommitted files outside the incoming changes do not refuse; they are kept and listed as `preserved_uncommitted`. | Commit or discard the named paths, then retry. Check `gbrain sources writer status <source> --json` first: a pending Git effect may be about to commit a gbrain-published file. |
| <a id="sync_in_progress"></a>`sync_in_progress` | `sync_in_progress` | A managed sync of one of the checkout's sources has an unfinished cursor. Moving the checkout now would strand it, and the refresh never waits on a sync. | Run the printed `gbrain sync --source <source> --no-pull ...` resume command (it keeps the cursor's options), then retry. |
| <a id="refresh_in_progress"></a>`refresh_in_progress` | `refresh_in_progress` | Another refresh of the same checkout is active, or a command that changes which sources share the checkout (`sources add`, `remove`, `archive`, `restore`, `reclone`) ran while one was active. | `gbrain sources refresh <source> --resume`, then retry the source command with the same request ID. |
| <a id="refresh_drain_timeout"></a>`refresh_drain_timeout` | `refresh_drain_timeout` | Queued writes or Git effects on the checkout did not finish within `--wait-drain` (default 60 s; `sources.refresh_drain_wait_ms`; `GBRAIN_REFRESH_DRAIN_WAIT_MS`). The counts are in the message. The fence was lifted and HEAD did not move. | Retry, or wait longer with `--wait-drain <seconds>`. Inspect what is queued with `gbrain sources writer status <source> --json`. |
| <a id="refresh_source_changed"></a>`refresh_source_changed` | `refresh_source_changed` | HEAD moved (an outside commit or checkout), or the checkout's ownership or set of sources changed, between the precheck and the merge. Nothing was merged and the fence was lifted. | Retry `gbrain sources refresh <source>`. |
| <a id="refresh_recovery_required"></a>`refresh_recovery_required` | `refresh_recovery_required` | Publication or source recovery is pending on the checkout, or a refresh was interrupted and HEAD is neither the commit it started from nor the verified upstream commit. Writes to the checkout stay refused until it is resolved; gbrain never adopts a HEAD it cannot verify. | `gbrain sources writer status <source>`, then `gbrain sources refresh <source> --resume`. When HEAD is unverified the fix names both ways out: reset to the start commit and run `--abandon`, or reset to the upstream commit and run `--resume`. Resetting is destructive, so ask the user first. |
| <a id="worktree_refreshing"></a>`worktree_refreshing` | `worktree_refreshing` | A write, or a managed sync started by a cycle or another command, reached a checkout while a refresh is draining or merging it. It was not journaled. `detail` is `retry_after_ms=1000`. Writes to database-only memory are not affected. | Retry the same request ID after about a second. `gbrain sources writer status <source>` shows the refresh. A cycle's sync is retried by the next cycle. |

A refresh is recorded in `persistence_worktree_refreshes` and survives a crash.
When the owner restarts it finishes the deterministic steps on its own: an
interrupted drain or a fence with HEAD unchanged is abandoned, and a merge
that already reached the verified upstream commit moves on to syncing.
`gbrain sources refresh <source> --resume` runs the remaining syncs. Doctor
reports `worktree_refresh_stuck` for a refresh active longer than 15 minutes,
with the resume command.

## Unbound sources on Postgres

A source with a checkout path (`local_path`, or `sync.repo_path` for the
`default` source) normally publishes every page write to a markdown file in
that checkout, through the source's canonical owner. PGLite claims that owner
automatically on the first write. Postgres does not, because several hosts can
share one Postgres brain and only one of them may own the files. Until someone
binds the source, page writes to it refuse with
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
   brain host). Every page write to a page with no recorded canonical file
   (a new page, or one with no stored source path) then writes to the
   database only: `put_page`, `capture`, `delete_page`, `restore_page`,
   `revert_version`, `add_tag`, `remove_tag`, `add_timeline_entry` and the
   `takes_*` writes. Its result says
   `write_through: { written: false, skipped: "unbound_source" }` with a
   warning. Pages written this way stay database-only: binding the source
   later does not materialize them into canonical files, later writes keep
   them database-only, and sync never deletes or overwrites them. To restore
   the refusal, run `gbrain config unset persistence.unbound_write`.

The opt-in never applies to a page that came from a canonical file (it has a
stored source path). An edit there could be lost on the owner's next sync, so
it keeps refusing with only the bind option. `revert_version` is also judged on
the version it writes: reverting to a version recorded while the page had a
canonical file refuses the same way (versions taken before this release did not
record it and count as file-less).

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

## Secret scan refusals and redaction

GBrain runs one secret scanner in several places. Depending on where a
credential-shaped value turns up, it blocks a push, leaves an entry out of
compiled context, skips a relay, or is replaced in output with a
`<REDACTED:pattern>` token (for example `<REDACTED:url_credentials>`). The
stored page never changes: redaction applies to what a caller receives, not
to your files or database.

| Where | What happens | What to do |
| --- | --- | --- |
| `gbrain sources push` | Refused with `blocked_secrets`, exit code 5. Nothing is committed; the index is reset to `HEAD` and files on disk are untouched. | Remove a real credential and rotate it. Allowlist only a reviewed false positive (below). |
| `gbrain bootstrap verify`, `gbrain bootstrap repo` | The secret-scan check fails, or the first push stops before anything is committed or pushed. Each finding shows its file, line, pattern, fingerprint and the version that added the rule. | Same as push. |
| Compiled context (`gbrain compile-context`) | The entry is left out. One line on stderr names the page, the pattern and the fingerprint, never the value. | Remove the value from the page, or allowlist a reviewed false positive. |
| Memory relay at compaction | The receipt and relay are skipped for that compaction window only; the checkpoint is kept. A content-free line (`reason: secret_scan_refused`, pattern, fingerprint, hint) goes to `~/.gbrain/integrations/hooks/heartbeat.jsonl`. | Nothing to run; the next window is scanned again. Remove the value from the transcript source if it keeps recurring. |
| Retrieval output | The value is replaced with `<REDACTED:pattern>`; everything else in the result is unchanged. | Nothing. Read the page on the brain host if you need the value (see what stays raw below). |
| Page reads | Not redacted. | See [what stays raw by design](#what-stays-raw-by-design). |
| Configured providers | Not redacted yet. | See [what stays raw by design](#what-stays-raw-by-design). |

An allowlist entry stops pushes and compiled context from refusing a
finding. It does not turn off retrieval redaction: search and recall still
replace an allowlisted value.

### Shapes this scanner catches

Vendor key prefixes (OpenAI, Anthropic, Voyage, GitHub, GitLab, Slack, AWS, Google,
Stripe, SendGrid, Twilio, Supabase, npm, Hugging Face, DigitalOcean, gbrain
tokens), JWTs, `Bearer` tokens, private keys, database URLs carrying a
password, `http(s)` URLs carrying a password (`url_credentials`) and
`Authorization: Basic` credentials (`basic_auth`). A private key is caught
even when a snippet or chunk cut off its `BEGIN` or `END` line: the key body
lines are redacted along with whichever fence is present.

Search chunks never hold key material. A page whose text contains a private
key is chunked from a copy in which each key is replaced by
`<REDACTED:private_key_pem>` (line breaks kept, so positions do not shift),
and evidence delivery cuts `window`, `section` and `page` text from the same
copy. A chunk from the middle of a long key, with neither its `BEGIN` nor
its `END` line, therefore carries the token instead of key lines, and key
material never reaches the embedding provider. The stored page is unchanged.
Pages indexed before v0.60.31.0 that contain a `BEGIN` or `END … PRIVATE
KEY` line are withheld from search until the upgrade re-chunks them, without
provider calls; `gbrain doctor` reports them as `credential_projection_pending`
until then, and `gbrain embed --stale` embeds the new chunks when you choose
to. Key material with no `BEGIN` or `END` line anywhere on the page, and keys
inside image OCR text, are not projected.

Retrieval output, transcript import, hooks and the memory relay also run the
assignment rule (`high_entropy_assignment`): a value of 12 or more characters
with at least one digit and enough randomness, assigned to a key such as
`password`, `token`, `secret` or `api_key`. Pushes and compiled context do
not run that rule, so a plain `DB_PASSWORD=...` line never blocks a push.

Placeholder passwords in URLs are skipped: `<password>`, `${VAR}`, `$VAR`,
and all-`*` or all-`x` masks. A URL with a user and no password, and paths
that only contain `@` (`https://registry.example/@scope/pkg`), are not
credentials.

### When a push is refused

```text
PUSH BLOCKED — secret scan findings (nothing committed):
  notes/deploy.md:12 [url_credentials] clone <REDACTED:url_credentials>git.example.com/team/repo.git
    fingerprint: sha256:<16 hex characters>
    rule [url_credentials] blocks pushes since gbrain v0.60.31.0
    allow this finding: printf '\n%s\n' sha256:<16 hex characters> >> '/home/you/brain/.gbrain-scan-allow'
Remove a real credential from the file (and rotate it) first. Allowlist only a reviewed false positive
with the "allow this finding" command above (it appends to '/home/you/brain/.gbrain-scan-allow'), then retry:
  gbrain sources push --path '/home/you/brain'
Docs: https://github.com/garrytan/gbrain/blob/master/docs/guides/write-refusals.md#secret-scan-refusals-and-redaction
```

Each finding carries:

- **fingerprint**: `sha256:` plus the first 16 hex characters of the
  value's hash. It identifies the value without revealing it.
- **rule ... since**: the gbrain version that added or changed the rule,
  shown for rules this release added or changed (`url_credentials`,
  `basic_auth`, `digitalocean` and private keys whose `BEGIN` or `END` line
  is missing). A push that worked before an upgrade and fails after it names
  the version here.
- **allow this finding**: the exact command that appends the fingerprint to
  the `.gbrain-scan-allow` file at the repository root. The path is absolute
  and quoted, so the command works from any directory.
- **retry**: the push command to run again, with the same `--path`,
  `--branch` and `--allow-unverified-remote` you used.

`gbrain sources push --json` returns the same data in `findings[]`, one
object per finding with `file`, `line`, `pattern`, `redactedPreview`,
`fingerprint`, `since`, `allowlistPath`, `allowCommand`, `retryCommand`,
`docs` and, when it applies, `staleAllowlistEntry`. The `reason` field
stays a one-line summary of at most 140 characters (count, first location,
pattern), so hook and doctor surfaces show it whole.

### Allowlisting a reviewed false positive

First decide whether the value is a real credential. If it is, remove it
from the file, rotate it with the provider, and push again; allowlisting a
real credential publishes it.

If it is not (a sample value in documentation, a test fixture), run the
"allow this finding" command from the refusal, review the change to
`.gbrain-scan-allow`, then run the retry command. The file holds one entry
per line: a fingerprint (`sha256:` and at least 16 hex characters) or a path
glob (a glob without `/` matches a file name at any depth; one with `/` is
anchored at the repository root), with `#` comments. Commit the file so
other machines push the same tree.

Prefer a fingerprint over a glob. A glob skips the scan for every file it
matches, including credentials added later.

### A stale allowlist entry for a private key

Before v0.60.31.0, a private key whose `END` line was missing (a cut-off
excerpt) was matched by its `BEGIN` line alone, and its fingerprint covered
only that line. The fingerprint now covers the key body too, so an old entry
for such a key no longer matches and the push is refused again. The refusal
says so and gives the replacement:

```text
    stale allowlist entry: sha256:<old> matched only this key's BEGIN header before gbrain v0.60.31.0; the fingerprint now covers the key body.
    if the key is a reviewed false positive, replace that line in '/home/you/brain/.gbrain-scan-allow' with: sha256:<new>
```

Replace the old line only if the key is a reviewed false positive. A cut-off
key's fingerprint depends on where the text was cut, so an entry for a
truncated key is not stable: if the excerpt changes, the fingerprint
changes and the push is refused again. For sample keys in documentation,
show a placeholder instead of key material.

### Redaction in retrieval output

Every operation that returns retrieved text redacts it before any caller
sees it: `search`, `query`, evidence delivery, `recall`, `context_pack`,
`delta`, `entity`, `synthesize`, `think`, takes, timelines, transcripts and
the other retrieval operations. The same pass applies on the CLI, both MCP
transports, subagent tools and `gbrain call`.

A safe way to see it, on a scratch brain with a value made up on the spot:

```bash
export GBRAIN_HOME="$(mktemp -d)"
gbrain init --pglite --no-embedding
PW="Gx7$(openssl rand -hex 12)"
gbrain capture --stdin <<EOF
Deploy notes for the scratch redaction check.
clone https://deploy:${PW}@git.example.com/team/repo.git
staging DB_PASSWORD="${PW}#x"
EOF
gbrain search "scratch redaction check" --json | grep chunk_text
```

Expected (one line, shown wrapped):

```text
"chunk_text": "# Deploy notes for the scratch redaction check.\n\nDeploy notes for the scratch redaction check.\n
clone <REDACTED:url_credentials>git.example.com/team/repo.git\nstaging DB_PASSWORD=\"<REDACTED:high_entropy_assignment>\"",
```

The host and path stay; only the user and password are replaced. IDs and
slugs are never redacted, so do not put secrets in page slugs.

Remembered facts are the one per-caller difference. The `fact`, `context`
and `source` fields of `recall`, `context_pack` and `delta` are redacted
for remote callers and returned raw to the trusted local CLI on the brain
host, so a credential you asked the brain to remember is readable with
`gbrain recall` there. Every MCP caller, including stdio MCP, and a thin
client connected over MCP count as remote. Search results, rendered `text`
and entity cards are redacted for every caller.

When an agent sees `<REDACTED:pattern>`, the brain holds a value of that
shape and withheld it. The agent should tell the user that, name the
pattern, and point to the brain host for the value. It should not retry
other operations to get around it.

### What stays raw by design

- **Page reads.** `get_page`, `fetch`, `get_chunks`, `get_raw_data` and
  `get_versions` return the stored text unredacted. They are explicit
  requests for a page and are governed by page visibility, not redaction.
  Installed skill files (`get_skill`, `get_skill_asset`, the skill catalog
  operations) and admin job operations are raw too.
- **Configured providers.** The embedding provider at import, a hosted
  reranker, and `synthesize`/`think` generation still receive stored text
  unredacted, except private keys, which chunks never contain. Redaction covers what callers receive, not what gbrain sends
  to a model provider you configured.
- **Your files and database.** Redaction never edits stored content. If a
  real credential reached the brain, rotate it, then follow
  ["If a secret reached the brain"](../../SECURITY.md#if-a-secret-reached-the-brain).

## Related

- [Concurrent writes and durable receipts](concurrent-writes.md) — receipt states, retries, capacity limits
- [Repair residual damage](repair.md) — `gbrain repair` for history, visibility and safe-chunk damage
- [Multi-source brains](multi-source-brains.md) — sources, slug-root mode and write-through
- [Topologies](../architecture/topologies.md) — the writer administration procedure behind self-transfer
