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
| `file_database_drift` | `source_changed` | The page's canonical file and its database copy disagree, usually because the file was edited outside a coordinated write. Neither copy was overwritten. A file with no `type:` line keeps the stored type, and titles compare trimmed, so those alone do not cause this. | `gbrain sources reconcile <source> <slug> --brain <brain> --preview`, review the preview, resolve it, then `--apply <resolved-preview-file> --request-id <new uuid>`. Retry the original write with a **new** request ID. See [repair a file/database disagreement](concurrent-writes.md#repair-a-filedatabase-disagreement). |
| <a id="writer-coordinator-required"></a>`database_guard` or `database_trigger` | `writer_coordinator_required` (or `storage_error` for another trigger) | A database trigger refused a row while a write was being prepared or published, so nothing was committed and any canonical file already replaced was restored. With `database_guard`, a gbrain process wrote a row its publication does not own (another source, an unresolvable source, or a source checkpoint/topology change outside owner administration). This is a gbrain defect or a version mismatch between gbrain processes sharing the database, not a content conflict. The receipt's `write_error_detail` names the table, operation, guard branch, source relationship and stage; it never contains page text or source names. | On the brain host run `gbrain sources writer status --probe --json`. Its `recent_failures[].error_detail` adds the source ids and the gbrain build and host that ran the attempt (`attempt.consumer_version`). If that build differs from `gbrain --version`, upgrade or restart every gbrain process that shares the database (serve, autopilot, sync jobs), then retry with a **new** request ID. If the builds match, report `error_detail` on the gbrain issue tracker. Never force-write, edit SQL or disable the guard. |
| `ambiguous_source_path` | `page_identity_changed` | A source registered at a Git subfolder `<sub>` has a page whose stored path `<sub>/<file>` could mean either `<file>` in the source directory (the older Git-root spelling) or `<sub>/<file>` inside a folder of the source that repeats its name, and both files exist. Sync refuses instead of guessing. See [sources in a Git subfolder](multi-source-brains.md#sources-in-a-git-subfolder). | Rename or move one of the two files, commit, then `gbrain sync --source <source> --no-pull --retry-failed`. |
| `physical_root_device_changed` | `recovery_required` | The checkout's filesystem device number changed while everything else matches, which macOS can do after a reboot. When the owner token, brain, worktree, root, inode and a non-zero birth time all match and the caller can verify database ownership, the write path re-stamps ownership by itself and the write proceeds. This refusal means the automatic re-stamp could not be verified; the suggestion says why. | Do a deliberate self-transfer: `gbrain sources writer status <source>` (note `admin_state`), then `gbrain sources writer transfer prepare <source> --self-transfer --admin-intent writer_transfer_prepare --expected-state <admin_state>`, then `gbrain sources writer transfer accept <source> --path <root> --expected-epoch <epoch> --manifest <digest from prepare> --self-transfer --admin-intent writer_transfer_accept --expected-state <fresh admin_state>`. Retry the original write with the **same** request ID. Never delete ownership marker files. |
| <a id="embedding_budget_below_worst_case"></a>`embedding_budget_below_worst_case` | `embedding_budget_below_worst_case` | `gbrain migrate embeddings` (or the local `migrate_embeddings` operation) was given a `--max-cost-usd` cap below the migration's worst-case authorization: every planned provider request at its maximum input size, plus any debits a resumed run already holds. The run stopped before any provider request, re-chunk or vector invalidation, so nothing changed. The message and JSON carry `cap_usd`, `worst_case_usd`, `debited_usd` and `required_cap_usd`. | Re-run with the value the `suggestion` names, for example `gbrain migrate embeddings --to <provider:model> --dim <N> --max-cost-usd <required_cap_usd> --yes` (operation: `max_cost_usd`). Preview first with `--dry-run`, which prints the worst-case authorization beside the estimate. Requests settle to reported usage, so actual spend is usually far below the cap. See [embedding migration](embedding-migration.md). |
| frontmatter slug conflict | `frontmatter_slug_conflict` (`invalid_params` on a gbrain older than v0.60.47.0) | A file's frontmatter `slug:` names a different page than its path. On a write nothing is written; during sync the file is held and the rest of the source imports. | Remove the `slug:` line or make it match the path, commit, then sync. See [`frontmatter_slug_conflict`](#frontmatter_slug_conflict). |
| `cursor_processing_options_conflict` | `invalid_params` | An unfinished sync's processing options (`--no-embed`, `--no-extract`, `--no-schema-pack`) conflict with this run, or the cursor predates saved options and has none. When options are saved, a run that omits those flags, including autopilot and `sync` jobs, adopts them. | When the message prints a resume command (`gbrain sync --source <source> --no-pull` plus the saved flags), run it or drop the conflicting flag. When it reports no saved options, resolve pending requests first, then rediscover with `gbrain sync --source <source> --no-pull --retry-failed` and the processing flags you want. |
| `take_row_collision` | `take_row_collision` | A save adds a takes-table row whose row number already belongs to a different take that exists only in the database. The save stops instead of overwriting that take. | Renumber the new takes row, or add the existing take to the page's takes table, then save with the current `expected_revision` and a **new** request ID (the content changed). |
| `invalid_source_uri` | `invalid_source_uri` | The brain has shared skillpacks, and the page's stored `source_uri` is a `file:` URI that cannot be turned into a local path, so gbrain cannot prove the write stays outside a skillpack. Shared-skill protection stays on. | The source owner inspects the page's stored `source_uri` on the brain host and replaces it with an absolute file URI or clears it; there is no dedicated command yet. Retry with a **new** request ID. |
| `queue_capacity` | `queue_capacity` | Admission would exceed a write-journal limit. Existing requests keep their place; nothing is evicted. For the cumulative limits (lifetime request IDs and receipt bytes), `detail` names the limit, for example `principal_lifetime_ids`; for the outstanding-request caps, `detail` carries the counts (`outstanding=<used> limit=<limit>`), and a managed `gbrain sync` drain waits them out ([`write_capacity`](#drain-write-capacity)). | For a cumulative limit, run the printed `gbrain config set persistence.limits.<limit> <value>` (sized for about one more year at the current rate), then retry with the **same** request ID. For outstanding-request, queued-byte or recovery-byte limits, let outstanding requests finish and check `gbrain sources writer status`. See [bounded admission and retention](concurrent-writes.md#bounded-admission-and-retention). |
| <a id="checkpoint-validation-timeout"></a>`index_building`, `index_missing` or `indexes_valid` | `checkpoint_validation_timeout` | A managed sync's checkpoint validation (the check that every page receipt of the run committed) hit the coordinator's 5-second statement timeout on a large `persistence_requests` table. The checkpoint request failed terminally instead of being retried ahead of every other write to the source, so other writes proceed; `last_commit` is unchanged and every page the run already committed stays committed. `detail` says which of three states the request indexes were in when the hint was built. | `index_building`: migration 179 is still building the indexes; wait (doctor `persistence_request_indexes` shows progress), then run the printed retry. `index_missing`: run `gbrain repair request-indexes --apply` (it drops an INVALID index and rebuilds it concurrently on Postgres), then the printed retry. `indexes_valid`: run the printed retry once; if it times out again, report the request id with the `persistence_request_indexes` and `persistence_request_growth` entries of `gbrain doctor --json`. The retry is `gbrain sync --source <source> --no-pull --retry-failed` plus the run's `--repo` base and cursor options (`--full`, `--working-tree`, `--src-subpath`, `--exclude`, `--include-hidden`, `--strategy`) and saved processing flags, so it resumes the same cursor. Do not cancel the request: a cancelled checkpoint still blocks the next one. |
| <a id="connector-account-changed"></a>`account_changed`, `account_unresolved` | `connector_account_changed` | A managed Google or GitHub connector's credential resolves to a different account than the one pinned for the source (Google email, GitHub App installation or login), or to no account at all. Google checks every enabled service before any service runs. Nothing was imported. No reset flag authorizes an account change. | The suggestion gives two branches with real values. (A) Restore the credential for the pinned account (the configured `g_token_env`, `g_token_command`, vault credential, `gh_token_env` or GitHub App key), then `gbrain sync --source <source>`. (B) For a deliberate change, add a new source for the new account (`gbrain google setup --account <email>`, or `gbrain sources add <new-id> --kind github … --app-install <id>`), then `gbrain sources archive <source>`; existing pages stay under the old source. |
| <a id="connector-intent-outdated"></a>`pre_upgrade` | `connector_intent_outdated` | A connector write was admitted in the intent format retired in v0.60.11.0. With detail `pre_upgrade` it was admitted before this brain's upgrade; otherwise a connector host older than v0.60.11.0 admitted it. The consumer recovers any file publication in progress first, then fails the request. | `pre_upgrade`: nothing to do; the item is fetched again on the next `gbrain sync --source <source>` under a new request ID. Otherwise: `gbrain upgrade` on the host that runs connector jobs, then `gbrain sync --source <source>`. |
| <a id="invalid-connector-text"></a>`invalid_connector_text` | `invalid_connector_text` | A Google or GitHub item's identity field (a path, item id or account) contains a NUL or an unpaired UTF-16 surrogate, which cannot be stored. Prose (bodies, subjects, titles) is cleaned at render time and never refused. The item is counted toward a hold; the rest of the sync continues. | Nothing to run for one refusal. Once the item is held, `gbrain sources status <source>` names it; after the provider data is fixed, `gbrain sources retry-held <source>`, then `gbrain sync --source <source>`. |
| <a id="connector-holds-exhausted"></a>`connector_holds_exhausted` | `connector_holds_exhausted` | A Google or GitHub source already holds 100 items and this sync would hold another. The sync stopped without advancing its cursor. So many held items usually means a source-wide problem (a broken renderer, a revoked scope), not bad items. | `gbrain sources status <source>` to see the held items and their error codes, fix the cause, then `gbrain sources retry-held <source>` and `gbrain sync --source <source>`. `gbrain sync --source <source> --full` also clears every hold. |
| <a id="connector-fence-below-timeline"></a>`fence_not_carried` | `connector_fence_below_timeline` | A managed connector re-render would have dropped a facts or takes fence the stored page keeps below its timeline sentinel, or one that is duplicated, unbalanced or unparseable. The write was refused so those rows are not expired; the item is counted toward a hold. | Preview `gbrain repair connector-fences --source <source>`, apply it after review with `--apply`, then `gbrain sources retry-held <source>`. A page the repair counts as ambiguous needs a manual edit (see [repair](repair.md)). |
| <a id="unsupported-mutation-protocol"></a>`consumer_upgrade_required` | `unsupported_mutation_protocol` | A connector on v0.60.11.0 or later sent a `connector_v2_*` write to a persistence consumer older than v0.60.11.0, which does not know the format. Other `permission_denied` refusals on connector receipts are never relabeled as upgrades. | `gbrain upgrade` on every consumer and worktree-owner host, then `gbrain sync --source <source>`. Upgrade those hosts before connector hosts. |
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
| <a id="colon_slug_windows_write_through"></a>`colon_slug_windows_write_through` | `colon_slug_windows_write_through` | A page slug such as `calendar:abc` is valid, but its canonical file name would contain `:`, which Windows cannot store (it names an alternate data stream). On Windows, a write that would publish that file is refused before admission, and `gbrain sync` skips each such file with this reason instead of failing the run. Database-only writes of the same slug (no repo configured, `sync.write_through` off, an unbound source, or a [read-only mirror](multi-source-brains.md#read-only-mirror-sources) source and pages created while it was one) still succeed, and macOS and Linux are not affected. | Use a slug without `:` (the suggestion names one), or write the page from a macOS or Linux host that owns the source. For a skipped sync file, rename it without `:` on a macOS or Linux checkout, commit, then run `gbrain sync --source <source> --no-pull` on the Windows host. |
| <a id="embedding_auth_failed"></a>`embedding_auth_failed` | `embedding_auth_failed` | The embedding provider rejected the configured key (HTTP 401 or 403). Printed once per process on stderr, naming the key source in effect: an environment variable (for example `OPENAI_API_KEY`, which wins over the config key) or the config key in `~/.gbrain/config.json`. No key or part of one is printed. | Environment key in effect but the config key is right: remove the variable from the environment of the process that reported it (shell profile, `~/.gbrain/.env`, or a daemon's service definition) and restart that process. Environment key intended: replace it with a valid key, restart, and run `gbrain config unset openai_api_key` (or the matching key). Config key in effect: `gbrain config set openai_api_key <valid key>`. Then `gbrain embed --stale` embeds what was saved meanwhile. `gbrain doctor` (`embedding_key_source`) shows the key source in doctor's own environment. |
| <a id="managed_pull_skipped"></a>`managed_pull_skipped` (cycle warn); doctor `sync_freshness` "upstream unknown" or "upstream N commit(s) ahead" | `managed_pull_skipped` | A managed brain never runs `git pull` inside a cycle: Git pull needs an explicit drained maintenance window, so an explicit `gbrain sync` without `--no-pull` is refused with `writer_coordinator_required`. An unattended cycle asked to pull (autopilot passes `pull: true`, `gbrain dream --pull`) instead syncs the checkout as it is and reports it: the sync phase result carries `details.upstream_refresh` (`pulled`, `failed`, `skipped_managed` or `not_requested`), and when the checkout tracks an upstream the phase is `warn` with `details.warning` (`code`, `cause`, `fix`, `docs`). Every sync also records the checkout's last upstream observation (the upstream commit, when it was last fetched or pushed, and how many upstream commits the synced commit lacks) in the source row. Doctor `sync_freshness` reports that separately from the local projection: a source with a `remote_url` whose observation is missing or older than 24 hours is "upstream unknown", and any source whose observation saw upstream commits it has not synced is "behind"; neither is reported fresh. `details.upstream_unknown_count` and `details.upstream_behind_count` count them. | `gbrain sources refresh <source>` (the printed `fix` fills in the source). It drains writes to the source's checkout, fast-forwards it to its upstream and runs the managed sync for every source bound to that checkout; see [worktree refresh refusals](#worktree-refresh-refusals) for what it can refuse. On a brain that is not managed, `gbrain sync --source <source>` pulls and records the observation. |
| <a id="facts_absorb_write_refused"></a>`facts_absorb_write_refused (<code>)`; `ingest_log` `write_refused: <code> …` | `facts_absorb_write_refused` | A durable `facts-absorb` job extracted facts but the write path refused to store them, for example `writer_coordinator_required` because the entity's Markdown file sits in a claimed canonical worktree before `sources writer activate`, or `permission_denied`, `invalid_params` or `writer_registration_required`. These refusals do not change on retry, so the job goes straight to `dead` on its first attempt instead of re-running inference; on a brain that is not yet activated, a job whose source root is a claimed worktree is refused before extraction starts, so it makes no model call; the `facts:absorb` row in `ingest_log` (and doctor `facts_extraction_health`) records `write_refused` with the real code, not a provider failure. The source page itself was already saved. | Fix the named cause first: `gbrain sources writer status <source>`, then finish the [claim and activate runbook](../architecture/topologies.md#claim-and-activate-runbook) for a claimed worktree, or fix the grant. Then `gbrain jobs retry <job id>` (the error names the id). |
| <a id="no_pricing"></a>`no_pricing` | `no_pricing` | A cost cap you set (`--max-cost`, `--max-usd`, `--max-cost-usd`, or an explicit cap in config such as `cycle.extract_atoms.budget_usd`) cannot be enforced, because gbrain has no price for the model the run was about to call. The run stops before that call. Under a default cap an unpriced model warns and runs instead. The message names the model, provider and kind, and JSON output carries the same guidance as fields: `code`, `model`, `provider`, `kind`, `units`, `lookup`, `register_command`, `register_scope` and `docs`. | Look up the provider's current price for the model, for example by searching the web for its pricing page. A chat model needs USD per 1M input tokens and USD per 1M output tokens; an embedding or reranker model needs USD per 1M tokens. On the brain host, run `gbrain pricing set <model> --input <usd> --output <usd> --source <pricing-page-url>` (or `--rate <usd>`), then retry. An agent connected over MCP cannot register prices: give the command to the brain's operator. See [registering a model price](../operations/spend-controls.md#registering-a-model-price). |
| <a id="managed_raw_upload"></a>raw upload on a managed brain | `writer_coordinator_required` | `gbrain files upload-raw` of a small (git-storage) file whose `.raw/` destination is inside a managed canonical worktree. The persistence coordinator does not publish raw files yet, so the worktree refuses writes from outside it; starting a `gbrain serve` owner does not change that. The refusal comes before anything is created: no `.raw/` directory and no `files` row. With no storage backend, `file_upload` for such a page no longer suggests `upload-raw`. | Configure `storage` (supabase, s3 or local) in the gbrain config, then run the printed `gbrain files upload <file> --page <slug>`; check it with `gbrain files list <slug>`. |
| <a id="timeline_rows_would_be_removed"></a>`timeline_rows_would_be_removed` | `timeline_rows_would_be_removed` | A remote `put_page` (or a `put_pages` entry) has no Timeline section at all — no `<!-- timeline -->` sentinel and no `## Timeline` or `## History` heading — and would delete dated entries the page has, including rows `add_timeline_entry` added. `put_page` content replaces the whole page, so the omission must be explicit. Nothing was written. A section that is present but empty is a deliberate delete and is not refused; a local `gbrain put` without `--expected-revision` keeps the rows instead. | Re-read with `get_page include_content:true`, keep the Timeline section and resubmit with a new `request_id`; to remove every dated entry on purpose, resubmit the same content with `drop_timeline: true` (on put_pages, per entry). A successful write that deletes rows reports `timeline_rows_removed {count, earliest, latest, warning, fix}` (dates only); `get_versions` then `revert_version` restores them as new rows. |
| <a id="preparation_stalled"></a>`preparation_stalled` | `preparation_stalled` | The write's owner could not finish *preparing* it. Every write has a preparation budget (`persistence.sync_preparation_ms` for a managed sync member, `persistence.maintenance_preparation_ms` for every other managed kind, 120 s each; `remember`, `put_page` and `edit_page` keep 30 s), the owner releases the claim at the budget and tries again, and a request cut off `persistence.max_preparation_attempts` times (default 2; a process killed mid-preparation counts too) is finished `failed` with this code instead of being claimed again and holding the rest of its root. The receipt names the last recorded step and what it was waiting on (`git`, `fs`, `db`, `pool` or `unknown`); while the write was still running, `gbrain sources writer status --json` showed the same on `claim.stall` (`preparation_overdue`). The rest of the root keeps publishing. A **managed sync member** (an import, delete or rename of a file) is also **held**: the sync turns the failed receipt into a `preparation_stalled` hold and carries on, so the file is not imported until it is retried. The file is fine; this is the write owner stalling (a database or pool wait, a hung step), never a frontmatter or fence problem, so no repair applies. The hold's `message` names the request and the step; a held deletion keeps its page. A stalled hold re-screens by itself only when the gbrain version changes; a run that stalls many files in a row stops with [`preparation_systemic`](#preparation_systemic) instead of holding them all. A **foreground write** (`put_page`, `edit_page`, `remember`) or a **maintenance write** (fact-fence adoption, maintenance page writes) gets the terminal receipt only. The deadlines sit behind `persistence.preparation_deadlines` (`false` restores the old behaviour, where only `remember`, `put_page` and `edit_page` had a 30 s budget). | Run `gbrain sources writer status --source <source> --json` (read-only: the step, its wait cause, the owner process and its gbrain version), fix what it names (restart or upgrade an owner that predates deadlines, free the pool, let the lock holder finish), then for a sync hold run `gbrain sources retry-held <source>` and the same `gbrain sync` with the same options (the hold's `fix.then.then` and `retry-held` print it, for example `gbrain sync --source <source> --no-pull --no-embed`). When that sync still has a backlog to finish, it finishes it first and re-screens the scheduled files in the same invocation (the drain yields at the checkpoint and discovers again), so one run of the printed command clears the hold. A foreground write needs a new `request_id`; the next maintenance run submits its write again. Runbook: [catch-up stuck / held N files](troubleshooting.md#catch-up-stuck). |
| <a id="write_outcome_unknown"></a>`write_outcome_unknown` | `write_outcome_unknown` | The database session dropped while the write was being admitted (a pooler reap, a failover, `pg_terminate_backend`), and it kept dropping through the re-reads, so whether the write was accepted is unknown (#6355). A single drop never reaches you: the admission attempt is re-run after 100, 300 and 900 ms, and every attempt begins by reading the retained `request_id`, so a re-run replays an admitted row instead of admitting again. Before this code existed the raw socket error (`write CONNECTION_CLOSED …`, `57P01`) reached the caller while the write went on to commit, and a receipt oracle took it for a refusal. | Read the request first: `gbrain write-request -- <request_id>` or `get_write_request { request_id }` (the error's `fix` names it). A committed or pending row means the write was accepted: replay the same `request_id` to wait for it. No row means it was not: submit it again with the same `request_id`. Never resubmit under a new `request_id` without that read. |
| <a id="fence_unrenderable"></a>`fence_unrenderable` | `fence_unrenderable` | A legacy fact row (an active `facts` row with no fence row number) was not adopted into its page's `## Facts` fence because the fence codec reads the rendered row back as something other than the stored fact: a whitespace-only claim comes back empty, `~~x~~` comes back struck, a literal `<br>` comes back as a line break, or another column changes. Surrounding whitespace and CRLF line endings are the one accepted difference: such a row is adopted and `facts.fact` takes the fence's text. A second legacy row whose normalized claim, source and visibility the page already carries is left too (`duplicate_claim`; a private and a world row with one text are two facts and both adopt). The cycle and the v0.32.2 migration print `FACTS_FENCE_FAILED: <slug> (fence_unrenderable: N row(s), <class>)`; doctor `fence_integrity` lists the pages, fact ids and reason classes under `unrenderable_legacy_facts` (never the claim text). The same code refuses a planned adoption whose rendered fence does not read back as its facts; that is a gbrain planning defect, not caller input. | Nothing to fix in the page: the rows stay active and searchable, nothing is lost, and their pages skip destructive fact reconciliation until the rows are adopted. Report the pages and reason classes with the gbrain version. Never `forget_fact` a row to clear the count. |
| <a id="reconcile-private-facts"></a>reconcile private facts | `permission_denied` | `gbrain sources reconcile --apply` (and its preview) found a `## Facts` row that would edit, renumber or change the visibility of a stored private fact, copy a stored private claim into a row under another visibility, or copy a stored private row's context (24 characters or longer) verbatim into a world row. A row is identified by its row number and claim, so a world row that only shares a private row's claim is not a private row and publishes. The refusal names the row number, never its text. It guards against verbatim copies only; reworded text is not detected, so it is not a confidentiality proof. Sources are not compared, because rows share provenance such as "Slack import". Nothing was written. | Read the stored page with the printed `gbrain get --source <id> -- <slug>`, keep the named row as stored in the file (or remove the copied text), then run a fresh `gbrain sources reconcile <id> <slug> --preview` and apply it. Change private facts with `remember` and `forget`. |
| <a id="maintenance_backpressure"></a>`maintenance_backpressure` (exit 12) | `maintenance_backpressure` | A managed maintenance run (`gbrain extract-conversation-facts`, its cycle phase or job) publishes each page as its own request, under the same local CLI writer your own CLI writes use. Before the run it counts the requests the whole run plans; before each page's model work it checks again. It stops admitting once the writer's outstanding requests, reserved receipt bytes (`persistence.limits.principal_terminal_bytes`; each request reserves 16 KiB until its receipt compacts after the retention window) or permanent request ids (`persistence.limits.principal_lifetime_ids`; never freed) would pass 80% of their limit, so the last 20% stays free for your other writes. The message names the resource. Pages already published keep their facts and nothing is half-written. | Outstanding requests: read them with `gbrain sources writer status --source <id> --json`; a resident `gbrain serve`, or the next CLI run, publishes them, then rerun the same command. Receipt bytes or request ids: run the smaller batch the message prints (`gbrain extract-conversation-facts --source-id <id> --limit <n>`), or wait for receipts to compact; raising the named `persistence.limits.*` key is the user's call. |

### Other error codes

These codes carry no separate reason. Each is listed so every write error code
a receipt can report has a row here.

| Reason | Error code | What it means | Recovery |
| --- | --- | --- | --- |
| `writer_pool_capacity` | `writer_pool_capacity` | The canonical owner has no free publication slot right now; the write stays queued. | Wait and poll the receipt (`gbrain write-request <id>`). If it persists, check `gbrain sources writer status <source>`. |
| `revision_required` | `revision_required` | The operation must be bound to a revision you reviewed (for example `--if-version` or `expected_revision`), and none was given. | Preview first, then repeat with the revision the preview printed. |
| `revision_conflict` | `revision_conflict` | The page changed after the revision this write was bound to. Nothing was overwritten. | Re-read the page, merge your change, and save with the new revision. |
| <a id="revision-backfill"></a>`revision_backfill_pending` | `revision_backfill_pending` | The page was written before page revisions existed (an upgrade from below schema v150) and the resumable revision backfill has not reached it, so it has no revision to bind to. Its revision reads as `backfill_pending`, never a UUID. Nothing was written. `gbrain doctor` reports the backfill as `revision_backfill` with the pending count and any failed rows by page. | Resume the backfill on the brain host with `gbrain apply-migrations --force-schema` (it prints its progress; `--yes` alone does not resume it once the schema is current). Rows that used all three attempts are no longer retried: run `gbrain repair orphan-children` to preview orphaned child rows and torn page bodies ([orphan children](repair.md#orphan-children)). |
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
| <a id="managed-guard-page-children"></a>`writer_coordinator_required: canonical writer must use the persistence coordinator` on a tag, timeline or take write; on the client `storage_error: Publication failed (P0001)` | `writer_coordinator_required` (`storage_error` on the stored receipt) | On a managed brain whose `tags`, `timeline_entries` or `takes` table has a `source_id` column gbrain does not create, the managed writer guard of a gbrain older than v0.60.38.0 refuses every insert and update of those rows, including coordinated ones. gbrain v0.60.38.0 and later take those rows' source from their page and ignore the column; an uncoordinated delete of such a row on a live page is refused, as on every other brain. | Upgrade to v0.60.38.0 or later on the brain host, then follow its recovery steps in the [CHANGELOG](../../CHANGELOG.md#060380---2026-10-03) (or [repair](repair.md#recover-after-an-upgrade)): `gbrain sync … --no-pull --retry-failed`, `gbrain extract --stale`, `gbrain extract timeline --source db`, a previewed `gbrain facts relink`, then `gbrain repair failed-writes` (preview, then `--apply --expect <hash>`) for the refused `put_page`, `add_timeline_entry` and `remember` calls; see [failed writes](repair.md#failed-writes). |
| `writer_coordinator_required` | `writer_coordinator_required` | The operation needs managed persistence (the write coordinator) and this brain or call path does not use it. A file write refused because the path sits in a managed canonical worktree names that worktree in the message, and its `detail` reads `root=<directory> source=<id or unknown> evidence=<marker file, managed-root registry or source binding>`. | Run the operation through the command the message names, on a managed brain. When the brain is not managed and the evidence is an ownership file (`.gbrain-owner.json`, `.gbrain-owner-<hash>.json`, `.gbrain-managed`), check it with `gbrain sources writer status` before removing anything: a half-finished claim is finished or rolled back through writer administration. |
| `fact_already_expired` | `fact_already_expired` | The fact the write targets is already expired or withdrawn. | Nothing to do; list active facts to find the current one. |
| `source_writeback_required` | `source_writeback_required` | The write needs a correction to the source's repository files, and this caller or profile never writes them. | Make the correction in the source repository, then sync. |
| `writer_upgrade_required` | `writer_upgrade_required` | The brain's schema is older than this operation needs. | Run `gbrain upgrade` (or `gbrain apply-migrations --yes`) on the brain host. |
| `skill_bundle_required` | `skill_bundle_required` | The write targets a shared-skill path, which only the shared skill publisher may write. | Publish the skill through the shared skill publisher instead. |
| `core_budget_exceeded` | `invalid_params` (detail `core_budget_exceeded`) | The write would make always-loaded core memory larger than `memory.core.max_chars`, or add a 51st core page. The message names the projected size, how far over it is and the largest core pages the caller can see. Nothing was written; writes that shrink core always pass. | Move detail into a linked non-core page and keep a one-line pointer, or ask the user to raise the budget. `gbrain core status --json` shows where the characters go. See [core memory budget](core-memory.md#budget). |
| `core_mark_owner_only` | `invalid_params` (detail `core_mark_owner_only`) | A remote caller tried to add or remove `always_load` or change `core_priority`. Only the owner designates core pages. Nothing was written. | Resubmit without changing those keys (omitted keys keep their stored values). If the marking itself should change, ask the user to run the `gbrain core add` or `remove` command the message names. See [owner only](core-memory.md#owner-only). |
| `core_delete_owner_only` | `invalid_params` (detail `core_delete_owner_only`) | A remote caller tried to delete a core page. Nothing was deleted. | Ask the user to run `gbrain core remove <slug>` first; the page can then be deleted. See [owner only](core-memory.md#owner-only). |
| `core_remote_edit_refused` | `invalid_params` (detail `core_remote_edit_refused`) | `memory.core.remote_edit` is `refuse`, so remote edits to core pages are refused. Nothing was written. | Ask the user to make the edit on the brain host, or to allow remote edits with notices (`gbrain config set memory.core.remote_edit notify`). See [remote edits](core-memory.md#remote-edits). |

`gbrain doctor` reports parked targets as the `parked_effects` check with the
exact `retry-effects` command per request. It reports `persistence_capacity`
when lifetime request IDs or receipt bytes reach 80% of a limit, with the
`gbrain config set` value to use; outstanding-request, queued-byte and
recovery-byte limits can refuse writes without that warning.

<a id="held-files-and-content-refusals"></a>
## Held files and content refusals

Some content refuses deterministically: the same bytes refuse on every retry.
On a write (`put_page`, `capture`, `gbrain import`) the call fails with the code
below and nothing is written. During `gbrain sync` the file is **held**
instead: the rest of the source imports, the checkpoint advances, and
the hold is reported by the sync result (`held`, `held_count`,
`holds_outstanding`), `gbrain sources status <source>`, doctor
`git_held_files`, `get_page` (`file_held`) and search (`stale` hits and the
`held_files` notice). A held new file has no page; a page whose newer file is
held keeps its last good revision and is read-only for `put_page` until the
file is repaired, so do not retry a refused write. A hold clears by itself
when the file changes, is deleted, or a newer gbrain can read it.

Every hold carries `code`, `reason`, `key`, `line`, a location-only `message`
(never a frontmatter value), `fix` (the exact command) and `docs` (the anchor
below). Walkthrough: [held files](repair.md#held-files).

**Say to your agent:** *"Sync held some of my notes. Tell me what is wrong
with each file and fix the ones that need no guessing."*

| Code (`reason`) | What it means | Recovery |
| --- | --- | --- |
| <a id="invalid_frontmatter"></a>`invalid_frontmatter` | The file's YAML frontmatter cannot be read without guessing. gbrain imports frontmatter it can read exactly, quoting at most an unquoted value (`author: a (b) (original: https://…)` imports and is reported under `recovered_frontmatter`). Producer checks stay strict: `gbrain frontmatter validate` and the pre-commit hook still fail on it. | Preview the fix: `gbrain repair frontmatter --source <source>`; it writes nothing until `--apply --expect <hash> --yes`. On a write, correct the named line and submit with a new request ID. |
| <a id="invalid_frontmatter-yaml_parse"></a>`invalid_frontmatter` (`yaml_parse`) | YAML no rule reads safely: a mis-indented list or mapping entry, a key line with no colon. | The preview lists it as `needs_review` with the exact line to fix by hand: one line per key, the whole value quoted. Commit and sync. |
| <a id="invalid_frontmatter-needs_interpretation"></a>`invalid_frontmatter` (`needs_interpretation`) | Reading it means choosing an interpretation: unquoted continuation lines after a value, a duplicated key, an unclosed `[` or `{`. gbrain never imports a guess. | `gbrain repair frontmatter --source <source> --include-ambiguous` shows the exact interpretation per file. Show the user each diff; apply only what they approve (`--only <path>` / `--skip <path>` select files). |
| <a id="invalid_frontmatter-ambiguous_identity_key"></a>`invalid_frontmatter` (`ambiguous_identity_key`) | `slug`, `type`, `id` or `source_id` appears twice, or its line was swallowed into another value, so gbrain cannot tell which page the file is. | Edit the file by hand: keep exactly one line for the key. The user decides which value is right. |
| <a id="invalid_frontmatter-ambiguous_protected_key"></a>`invalid_frontmatter` (`ambiguous_protected_key`) | A key that decides access or provenance (`visibility`, `derived_from`, …) is malformed, duplicated, swallowed into another value, rewritten by quoting, or inside an unclosed fence. gbrain never reads such a key as a broader value. | Edit the file by hand: write the key on one line with one quoted value. Ask the user which visibility is intended; never guess it. |
| <a id="frontmatter_slug_conflict"></a>`frontmatter_slug_conflict` | The file's frontmatter `slug:` names a different page than its path does (earlier releases reported this as `invalid_params`). The path decides the slug. | Remove the `slug:` line or make it match the path, or move the file to the path its slug names; `gbrain repair frontmatter --source <source> --include-ambiguous` proposes removing the line. Commit and sync. |
| <a id="file_too_large"></a>`file_too_large` | Over the import size limit (5 MB for Markdown and code, 10 MiB for any sync read). The limit is fixed. | Split the file into smaller files and commit, or leave it out of the source: read `gbrain config get sync.exclude`, then `gbrain config set sync.exclude '<current list>,<path>'`. The next `gbrain sync --source <source> --no-pull` clears the hold. |
| <a id="managed_image_sync_unsupported"></a>`managed_image_sync_unsupported` | With multimodal embedding on (`embedding_multimodal` / `GBRAIN_EMBEDDING_MULTIMODAL`), sync admits image files, but managed sync has no image importer yet. Each image import is held instead of refusing the whole sync (#5493); deleting or renaming an image still reconciles its page. These holds count as missing coverage (the image is not searchable) but never escalate, because they are not a content fault. | Nothing is broken; keeping them held is fine. To stop holding images, leave them out of the source (`gbrain config get sync.exclude`, then `gbrain config set sync.exclude '<current list>,**/*.png'`) or turn multimodal embedding off; either clears the holds on the next `gbrain sync --source <source> --no-pull`. A held image is re-screened when it changes and on `gbrain sources retry-held <source>`. |
| <a id="content_rejected"></a>`content_rejected` | The content-sanity gate matched junk and the operator set `content_sanity.junk_disposition` to `reject`, so the file is never imported and always visible. | Remove the matched junk from the file, or ask the user whether `junk_disposition` should go back to `quarantine`; that setting is the user's decision. |
| <a id="rename_held"></a><a id="rename_held-rename_source_changed"></a>`rename_held` (`rename_source_changed`) | A renamed file's hold cleared, but the page it was renamed from changed after the rename was recorded, so the page did not move. | `gbrain repair frontmatter --source <source> --include-ambiguous` proposes re-binding the rename to the old page's current revision; apply after the user agrees. Or restore the old file name. |
| <a id="concurrent_write"></a>`concurrent_write` | Managed sync was importing a newer Git version of the file while a database-only write (write-through off, a sandboxed or derived write) committed a different version of the same page, so the two diverge (#6194). The proof is the page's revision itself: it was written by a committed non-sync request for that page. Neither version was overwritten: the page keeps the database version, the file is held and the rest of the source syncs. Since #6340 a page that moved with no such request to name is held the same way (the hold records `page_revision` and `expected_revision` instead of a competing request), and so is a page that changed, was deleted or was re-bound in the database between the manifest freeze and the entry's turn; a page that still holds exactly what the file would import is re-bound to its new revision and passed. | `gbrain sources status <source>` names the page and the competing request. Preview with `gbrain sources reconcile <source> <slug> --preview`, decide with the user which content wins, apply the resolved preview, then `gbrain sources retry-held <source>` and `gbrain sync --source <source> --no-pull` re-screen the file. A new commit of the file re-screens it too. |
| <a id="parser_regression"></a>`parser_regression` | With `sync.parser_regression=hold`, a file whose exact bytes imported under an earlier gbrain is now refused. This is a gbrain bug. | Report it with the gbrain version, the file and the code; upgrade or pin the last good version. After a fixed gbrain is installed, `gbrain sources retry-held <source>` and then `gbrain sync --source <source> --no-pull` re-screen it. |
| <a id="preparation_stalled-hold"></a>`preparation_stalled` | The write for this file could not finish *preparing* within its attempt limit, so the sync held the file and kept going. The file is fine: no repair applies, and it is not imported until it is retried. Full reference: [`preparation_stalled`](#preparation_stalled). | `gbrain sources writer status --source <source> --json` (read-only), fix what it names, then `gbrain sources retry-held <source>` and the same sync with its options. Runbook: [catch-up stuck / held N files](troubleshooting.md#catch-up-stuck). |
| <a id="worktree_dirty"></a>`worktree_dirty` | The working tree holds uncommitted bytes for this file that match neither the pinned commit nor the current page (an agent mid-edit on a live checkout), and importing the pinned version would discard them (#6340). Before this release the refusal (`source_changed` / `pinned_git_worktree_conflict`) stopped the whole run; now the file is held, the local edit is untouched and the rest of the source syncs. The hold keeps the pinned blob (`meta.blob_oid`) and a hash of the working bytes, counts `meta.attempts` each time the same file is held again, and a page held three times is reported `needs_human` by `gbrain sync status`. Bytes that are **committed at HEAD** past the pinned target are not a conflict at all: sync imports them as HEAD has them and the later pin..HEAD diff re-imports the same bytes as a no-op. | Commit the edit (or restore the file), then `gbrain sync unblock --source <source> --apply` re-screens every held file that is now committed and prints the sync to run (`gbrain sources retry-held <source>` does the same for all holds). A later commit that changes the file re-screens it on its own. Never discard or normalize the local bytes. Runbook: [sync unblock](sync-unblock-runbook.md). |
| <a id="sync_parser_regression"></a>`sync_parser_regression` | Sync stopped without advancing because it would hold a file whose exact bytes imported before (default `sync.parser_regression=stop`). This is a gbrain bug, not a content problem. | Report it with the gbrain version, the file and the code; upgrade or pin the last good version, then `gbrain sync --source <source> --no-pull --retry-failed`. To keep syncing meanwhile, `gbrain config set sync.parser_regression hold` (ask the user). |
| <a id="changed_since_preview"></a>`changed_since_preview` | A hash-bound repair apply (`gbrain repair frontmatter --apply --expect <hash>`, `gbrain repair fences --apply --expect <hash>`) found a file, its proposed change or its page different from what the preview showed, so that item was not written; the rest of the approved set still applied. | Preview again with the same selection and apply the new hash. For frontmatter, show the user the new diff first; a fence repair needs no extra consent ([fence reason](#fence-changed_since_preview)). |

<a id="invalid_fence"></a>
### Fence holds (`invalid_fence`)

A page's facts and takes fences are its structured rows
([format](fence-format.md)). A coordinated write (managed sync, managed
`gbrain import`, `put_page` on a managed brain, managed file repair) refuses a
fence it cannot import without dropping or guessing rows: code
`invalid_fence`, wire `error` `invalid_params` (`take_row_collision` for a
stored-row collision). During managed sync the file is **held** instead and
the rest of the source syncs. The message reads
`Fence <reason>: in the <facts|takes> fence (<body|timeline>), row(s) N, column(s) C, at line L.`
(the parts that apply; the line counts within the section), then the fix. It
names fence, section, row numbers, column names and lines only, never a claim,
holder or cell. A failed receipt keeps the location in
`write_error_detail.fence` (row numbers stay on the brain host).

A managed **maintenance write** (fact-fence adoption and the cycle's other page
writes) is checked the same way before it is submitted, over the page's whole
body and timeline: a page that already carries a defect no adoption clears (for
example a second facts fence in its timeline) is skipped with the fence reason
in `failed_pages`, no request is created, and the other pages still go. The
fence census counts the stored defect (`gbrain doctor --only fence_integrity
--json`), and `gbrain repair fences --source <source>` previews it where a
repair applies.

<a id="fence-hold"></a>**What a fence hold carries.** Every surface that shows
a hold (`gbrain sources status <source>`, doctor `git_held_files`,
`get_page.file_held`, the sync result) gives the same location-only fields:

- `fence`: `reason`, `fence` (`facts` or `takes`), `section` (`body` or
  `timeline`), `rows` (row numbers), `columns` (column names) and `line` (the
  first bad line, counted within the section).
- The reason's `tier`, the repair that clears it (`deterministic`,
  `resolver`, `llm` or `manual`), and `auto_retry`, whether the maintenance
  run clears or retries it with no one acting. The table below lists both
  for every reason.
- After a repair has tried the file, `fence_repair`: that attempt's `reason`,
  `tier` and `at`, `next_attempt_after` (when the maintenance run tries it
  again; null when it will not), and `gate` and `rows` when a proposed repair
  was rejected.
- `fix`, the next command (a single held file's preview,
  `gbrain repair fences --source <source> --only <path>`), and `docs`, the
  reason's anchor below.

**What gbrain fixes by itself.** Before refusing or holding, every write path
runs the fence through a lossless normalizer: a missing end marker with only
blank lines after the table, two-dash takes markers above a table, zero,
negative or duplicate row numbers (new numbers come after every number the
page and its stored rows ever used), header aliases and column order,
header-level defaults (`confidence 1.0`, `notability medium`,
`visibility private`), enum synonyms (`critical` → `high`; `public` → `world`
only on a world-visible page, else `private`), invented facts kinds (mapped to
the closest kind, the original word kept in `context`), a short list of takes
kind synonyms, assistant holders (`System`, `assistant` → `brain`) and percent
confidences ([every rule](fence-format.md#normalized)). It never changes a
claim, an existing row number or a valid cell, and never makes a row more
visible. A fence it fixes completely is written in its normalized form:
managed sync commits the rewritten file (a read-only mirror keeps it
database-only; a company-brain source refuses `source_writeback_required`
naming the fence), and the result reports `fences_normalized` (`count`,
`by_class`, `writers`, sample paths for local callers). A write also carries
one `fence_normalized` coaching notice: the stored page differs from what was
sent, so re-read it with `get_page` before editing; `remember` and
`takes_add` write rows that never need it. `gbrain sync --dry-run` lists
`would_normalize` beside `would_hold`. `gbrain config set fences.normalize false`
turns normalization off: a fixable fence is then held or refused like any
other.

What the normalizer cannot fix exactly is refused or held as below; a refusal
lists every blocking problem in `fence_issues`
(`[{ fence, section, row, column, line, class, allowed }]`, where `allowed`
is the column's vocabulary), so the caller can correct all of them at once.

Legacy (unmanaged) sync, `gbrain import` on an unmanaged brain and other
direct imports store a fence the normalizer cannot fix as written (bad rows
skipped) and never hold it; the result reports it in `fence_issues`. Two
documented exceptions keep blocking with the typed refusal instead of
holding: `sync.holds=fail`, and company-brain sources, which never hold and
never rewrite repository files (fix the fence in the repository and commit).

<a id="fence-repair"></a>**Repair.** Fence holds clear by themselves: the
maintenance run's `fence_repair` phase repairs held files and stored pages
whose fences do not parse, on the brain's owner host. A repaired file is
committed like any page write on a managed source; on a legacy source it is
backed up under `~/.gbrain/backups/` and left for you to commit. To see what
it would change, or to do it now:

```bash
gbrain repair fences --source <source>                          # preview: read-only, no model call
gbrain repair fences --source <source> --apply --expect <hash>  # the apply command the preview prints
```

The preview lists each held file and stored page with its reasons, rows and
columns, the tier that fixes it and the estimated model cost against the
remaining daily cap, and prints the apply command with its `--expect` hash.
Applying needs no extra consent. Tier 1 and 2 changes are exact rules; Tier 3
sends only the fence header and the rows it must realign (never valid rows,
never the rest of the page) to the repair model (`models.fence_repair`, or
unset the first measured model with a key: `openai:gpt-6.1-sol`, else
`anthropic:claude-opus-5-5`), within `fences.repair.max_usd_per_page` ($0.30) and
`fences.repair.max_usd_per_day` ($1.00) ([spend](../operations/spend-controls.md#the-gates)).
Every tier's output passes [gates (a) to (g)](fence-format.md#gates) before
anything is written. `--no-llm` keeps a run to the free tiers and
`--max-usd <n>` lowers its cap; raising spend
(`gbrain config set fences.repair.max_usd_per_day <usd>`) or turning model
repair back on (`gbrain config set fences.repair.llm true`) is the user's
call. MCP and thin-client callers cannot run a repair: the hold's fix names
the owner-host command to hand to the user. Walkthrough with real output:
[fence repair](repair.md#fences).

A `manual` reason needs a person, because gbrain never guesses it: read the
page (`gbrain get --source <source> -- <slug>`), edit only the named fence in
the file (never the frontmatter), commit, then
`gbrain sync --source <source> --no-pull`. `gbrain sources status <source>`
lists every fence hold with its location. To add rows without hand-editing a
table, use `remember` (facts) or `takes_add` (takes).

**Say to your agent:** *"Sync held a page because of its facts table. Show me
which rows are wrong and fix them."*

<a id="fence-integrity"></a>**How many are left.** `gbrain doctor --only fence_integrity`
counts, per source, every malformed fence still waiting, once each: a held
file, a stored page whose fence does not parse (for example one an older
release imported as written), and a checkout file not yet synced. Each is
split by the tier that would clear it: `deterministic` (the normalizer fixes
it the next time the file syncs or the page is written), `resolver` (a
holder name to resolve), `llm` (a table only a rewrite can realign) and
`manual` (an edit only a person can decide). It also shows the oldest hold's
age, the fences normalized in the last 7 days with their top writers (a
source at 20 or more warns: something keeps writing malformed fences) and the
model-repair caps `fences.repair.max_usd_per_page` (default $0.30) and
`fences.repair.max_usd_per_day` (default $1.00) with today's spend. Each run
scans for at most `GBRAIN_DOCTOR_FENCE_TIMEOUT_MS` (10 s) and resumes where the
last one stopped; until a scan finishes the check is `partial` and never `ok`.
The maintenance run repairs the `deterministic` and `resolver` ones by itself,
and the `llm` ones while model repair is on and within the caps;
`gbrain repair fences --source <source>` previews the plan.

**Say to your agent:** *"How many broken facts or takes tables are left in my brain?"*

Each reason's **Tier** is the repair that clears it (`-` when that depends on
the page, which is screened again); **Auto** says whether the maintenance run
clears or retries it with no one acting.

| `invalid_fence` reason | What it means | Tier | Auto | Recovery |
| --- | --- | --- | --- | --- |
| <a id="fence-header_unmapped"></a>`header_unmapped` | The header has a column with no canonical name and no known spelling, so its cells cannot be placed. | `llm` | yes | Repaired by the next maintenance run (preview: `gbrain repair fences --source <source>`). By hand: rename each column to its canonical name. Format: [header spellings](fence-format.md#header-spellings). |
| <a id="fence-no_header"></a>`no_header` | The fence has table rows but no header row naming `claim` and `kind`. | `llm` | yes | Repaired by the next maintenance run. By hand: add the canonical header as the first table line. Format: [markers](fence-format.md#markers). |
| <a id="fence-row_before_header"></a>`row_before_header` | Rows sit above the header row. | `llm` | yes | Repaired by the next maintenance run. By hand: move them below the header. Format: [markers](fence-format.md#markers). |
| <a id="fence-short_row"></a>`short_row` | A row is missing a cell in the middle, so its columns are ambiguous. A row short only in its optional trailing cells parses. | `llm` | yes | Repaired by the next maintenance run. By hand: add the missing cells so every column lines up. Format: [facts](fence-format.md#facts-layouts), [takes](fence-format.md#takes-layouts). |
| <a id="fence-extra_cells"></a>`extra_cells` | A row has more cells than the header, and removing empty cells does not line it up (stray empty cells with one valid removal are rewritten by themselves). Often an unescaped `\|` cut a cell, usually the claim, in two; no gate can tell that from a misplaced cell, so it is never sent to the model. In a fence with no header, a row that starts with a row number is read by position the same way. | `manual` | no | Join the cut cell with `\|`, or remove the extra cell. Format: [facts](fence-format.md#facts-layouts), [takes](fence-format.md#takes-layouts). |
| <a id="fence-claim_split"></a>`claim_split` | A facts `kind` cell holds text, not a kind word (more than three words, sentence punctuation, a link or strikethrough): usually the end of a claim an unescaped `\|` cut in two, with the kind cell missing. gbrain does not store it as a kind note. In a fence with no header, a row that starts with a row number is read by position, so its third cell is the kind. | `manual` | no | Join the text back into the claim with `\|` and write the kind. Format: [facts](fence-format.md#facts-columns). |
| <a id="fence-holder_unresolved"></a>`holder_unresolved` | A takes `who` cell is not `world`, `brain`, `people/<slug>` or `companies/<slug>` (for example a person's display name). | `resolver` | yes | Rewritten by the next maintenance run when it resolves to exactly one verified `people/` or `companies/` page (never a private page on a world-visible page). Otherwise write one of those forms by hand. Format: [holders](fence-format.md#holders). |
| <a id="fence-missing_begin"></a>`missing_begin` | An end marker has no begin marker before it. | `manual` | no | Add the begin marker above the table, or delete the stray end marker. Format: [markers](fence-format.md#markers). |
| <a id="fence-split_rows"></a>`split_rows` | A fence has no end marker and its rows are split by blank lines or text, so gbrain cannot tell which rows belong to it. | `manual` | no | Join the rows into one table and add the end marker after the last row. Format: [markers](fence-format.md#markers). |
| <a id="fence-unclosed_trailing_content"></a>`unclosed_trailing_content` | A fence has no end marker and other text follows its table, so closing it automatically could expose text the privacy boundary hides. | `manual` | no | Add the end marker directly after the last table row, or wrap a mere mention of the marker in backticks. Format: [markers](fence-format.md#markers). |
| <a id="fence-marker_near_miss"></a>`marker_near_miss` | A line uses the two-dash takes marker (`<!-- gbrain:takes:begin -->`) or mentions it with no takes table after it. Two-dash markers directly above a takes table are rewritten by themselves. | `manual` | no | Use the exact three-dash markers around the takes table, or wrap a mere mention in backticks. Format: [markers](fence-format.md#markers). |
| <a id="fence-repeated_marker"></a>`repeated_marker` | A body or timeline section has a second begin or end marker for the same fence outside code. | `manual` | no | Keep one begin and one end marker per fence in that section, with every row in one table. Format: [markers](fence-format.md#markers). |
| <a id="fence-takes_in_facts"></a>`takes_in_facts` | A facts fence holds a takes table. | `manual` | no | Move the rows into a takes fence (or add them with `takes_add`), or rewrite them as facts rows. Format: [takes](fence-format.md#takes-columns). |
| <a id="fence-superseded_ambiguous"></a>`superseded_ambiguous` | Two rows share a number and a `superseded by #N` reference names that number, so renumbering could repoint the reference. | `manual` | no | Decide which row keeps the number, give the other a number above every number on the page, and fix the reference. Format: [row numbers](fence-format.md#row-numbers). |
| <a id="fence-enum_unmapped"></a>`enum_unmapped` | A facts `kind`, `visibility` or `notability` cell holds a value outside the allowed list and its synonyms (the message names the column and the allowed values). | `manual` | no | Use one of the allowed values. Format: [facts](fence-format.md#facts-columns). |
| <a id="fence-weight_missing"></a>`weight_missing` | A takes row has no `weight`, or the header has no weight column. Takes have no default weight. | `manual` | no | Add a weight from 0 to 1. Format: [takes](fence-format.md#takes-columns). |
| <a id="fence-holder_missing"></a>`holder_missing` | A takes row has no holder, or the header has no `who` column. | `manual` | no | Add the holder: `world`, `brain`, `people/<slug>` or `companies/<slug>`. Format: [holders](fence-format.md#holders). |
| <a id="fence-confidence_out_of_range"></a>`confidence_out_of_range` | A facts `confidence` or takes `weight` is not a number from 0 to 1 (a percent such as `85%` is rewritten by itself). | `manual` | no | Write the intended value as a decimal such as 0.8. Format: [facts](fence-format.md#facts-columns), [takes](fence-format.md#takes-columns). |
| <a id="fence-claim_value_invalid"></a>`claim_value_invalid` | A facts `claim_value` is not a number. | `manual` | no | Write a number (1,234 separators and a k/M/B suffix are allowed) or leave it empty. Format: [facts](fence-format.md#facts-columns). |
| <a id="fence-takes_kind_unsupported"></a>`takes_kind_unsupported` | A takes `kind` is not fact, take, bet or hunch and is not one of the few synonyms gbrain maps (a kind the schema pack declares but the parser does not accept included). gbrain never chooses a takes kind for you. | `manual` | no | Use one of the four kinds. Format: [takes](fence-format.md#takes-columns). |
| <a id="fence-unparseable"></a>`unparseable` | The fence does not parse cleanly: most often it has no end marker, or a row number is not a positive whole number (`column #`). | `-` | yes | Usually repaired by itself on the next write or maintenance run. By hand: add the end marker directly after the last table row, or fix the named row number. Format: [markers](fence-format.md#markers). |
| <a id="fence-row_collision"></a>`row_collision` | Two rows of the same fence kind share a row number, in one fence or across the body and timeline (`rows` lists the numbers). | `-` | yes | Usually renumbered by itself. By hand: give one row a new number above every number used on the page. Format: [row numbers](fence-format.md#row-numbers). |
| <a id="fence-quoted_fence_rows"></a>`quoted_fence_rows` | A fence sits inside a code block or inline code span, so readers treat it as an example and importing would remove the stored rows it holds. | `-` | no | Move the fence out of the code, or delete the fence to remove its rows. Format: [markers](fence-format.md#markers). |
| <a id="fence-stored_row_collision"></a>`stored_row_collision` | A new takes row's number already names a different stored take that is not in the page's fence (wire `take_row_collision`). | `-` | no | Renumber the new row, or add the stored take back to the fence. Format: [row numbers](fence-format.md#row-numbers). |
| <a id="fence-withdrawn_claim_in_malformed_fence"></a>`withdrawn_claim_in_malformed_fence` | A facts fence that does not parse holds a claim the user withdrew, so gbrain cannot tell whether the row should stay withdrawn. | `-` | yes | Repair the fence so it parses (`gbrain repair fences --source <source>` previews it); the withdrawn row then stays withdrawn. Format: [examples](fence-format.md#examples). |
| <a id="fence-target_fence_malformed"></a>`target_fence_malformed` | A verb that appends to or edits a page (`remember`, `extract_facts`, `takes_*`, `facts relink`, `edit_page`) found that page's stored fence does not parse and cannot be normalized in the same write (`edit_page` and the other takes writes never normalize). Memory verbs keep their v1 code (`invalid_params`, `detail: invalid_fence`). | `-` | yes | The maintenance run repairs the stored fence; to do it now, `gbrain repair fences --slug <slug>` on the brain host. Or read the page, fix the named fence (or write the whole page with `put_page`, which normalizes what it can and names every row it cannot), then retry with a new request_id. Format: [examples](fence-format.md#examples). |
| <a id="fence-prepare_time"></a>`prepare_time` | Hold only: the file passed the content screen, but its fence was refused while it was prepared against the stored page (a stored-row collision, a withdrawn claim, rows quoted in code). `fence.reason` names which. Managed sync holds it in the same run instead of blocking. | `-` | yes | Fix it as its `fence.reason` says. After a database-side fix (for example removing the conflicting take), `gbrain sources retry-held <source>` re-checks the file. Format: [what gbrain never guesses](fence-format.md#never-guessed). |
| <a id="fence-normalizer_failed"></a>`normalizer_failed` | The normalizer or its validator failed on this fence (a gbrain bug); the fence was not rewritten. A coordinated write refuses; a legacy import stores the page as written. | `manual` | no | Run `gbrain doctor --json` and report it with the gbrain version; an upgrade re-screens the file. Format: [what gbrain fixes](fence-format.md#normalized). |
| <a id="fence-llm_unavailable"></a>`llm_unavailable` | The repair model timed out, was rate-limited or returned a server error. | `llm` | yes | Nothing to do: the next maintenance run (or `gbrain repair fences --apply`) retries. Format: [tiers](fence-format.md#never-guessed). |
| <a id="fence-llm_empty"></a>`llm_empty` | The repair model returned nothing for the fence. | `llm` | no | Fix the named rows by hand. The same file is not sent to the model again until it, the model (`models.fence_repair`) or gbrain's repair rules change. Format: [tiers](fence-format.md#never-guessed). |
| <a id="fence-llm_refused"></a>`llm_refused` | The repair model declined to repair the fence. | `llm` | no | Fix the named rows by hand; the same file is not sent to the model again until it or the model changes. Format: [tiers](fence-format.md#never-guessed). |
| <a id="fence-llm_malformed"></a>`llm_malformed` | The repair model did not return exactly one table, or wrote text outside it. | `llm` | no | Fix the named rows by hand; the same file is not sent to the model again until it or the model changes. Format: [tiers](fence-format.md#never-guessed). |
| <a id="fence-llm_truncated"></a>`llm_truncated` | The repair model stopped before finishing; its output is rejected even when it parses. | `llm` | no | Fix the named rows by hand; the same file is not sent to the model again until it or the model changes. Format: [tiers](fence-format.md#never-guessed). |
| <a id="fence-llm_declined"></a>`llm_declined` | The repair model answered HOLD: a row has more than one reasonable reading (two values for one column, or a cell that fits two columns), so it declined to guess. | `llm` | no | Fix the named rows by hand; the same file is not sent to the model again until it, the model or the rules change. Format: [tiers](fence-format.md#never-guessed). |
| <a id="fence-llm_disabled"></a>`llm_disabled` | Model repair is off (`fences.repair.llm false`), so a fence only Tier 3 can realign waits. | `llm` | no | Fix the named rows by hand, or ask the user before turning model repair back on: `gbrain config set fences.repair.llm true` (it spends within the caps). Format: [tiers](fence-format.md#never-guessed). |
| <a id="fence-no_measured_model"></a>`no_measured_model` | `models.fence_repair` is unset and no model the fence-repair eval measured as accurate enough (`openai:gpt-6.1-sol`, `anthropic:claude-opus-5-5`, `anthropic:claude-fable-5-1`) has a provider key on this brain, so model repair is off by default. | `llm` | no | Fix the named rows by hand, or ask the user which model to trust, then `gbrain config set models.fence_repair <provider:model>` (an explicit model always runs). Format: [tiers](fence-format.md#never-guessed). |
| <a id="fence-budget_exhausted"></a>`budget_exhausted` | The page's repair estimate is over `fences.repair.max_usd_per_page` or over what is left of `fences.repair.max_usd_per_day` today (UTC). A repair run stops with exit 1 naming the spend, the cap, the reset time (next 00:00 UTC) and the pages waiting. | `llm` | yes | Nothing to do: repairs resume after 00:00 UTC. Raising a cap is the user's call: `gbrain config set fences.repair.max_usd_per_day <usd>` (or `fences.repair.max_usd_per_page`). Format: [tiers](fence-format.md#never-guessed). |
| <a id="fence-no_pricing"></a>`no_pricing` | A spend cap the user set is in force and gbrain has no price for the repair model, so no call was made. Under the default caps an unpriced model runs, metered at an estimated ceiling. | `llm` | no | Look up the model's per-token price and register it on the brain host: `gbrain pricing set <model> --input <usd> --output <usd>` ([registering a model price](../operations/spend-controls.md#registering-a-model-price)). The next run repairs it. Format: [tiers](fence-format.md#never-guessed). |
| <a id="fence-ledger_unavailable"></a>`ledger_unavailable` | The spend ledger could not be read or written, so no model call was made. | `llm` | yes | Nothing to do: the next run retries. If it keeps happening, check the database with `gbrain doctor --json`. Format: [tiers](fence-format.md#never-guessed). |
| <a id="fence-owner_unavailable"></a>`owner_unavailable` | This host is not the brain's owner host, and fence repairs run only there. | `-` | yes | Run `gbrain repair fences` on the owner host (`gbrain sources writer status <source>` names it). A remote caller hands that command to the user. Format: [tiers](fence-format.md#never-guessed). |
| <a id="fence-owner_cli_required"></a>`owner_cli_required` | The maintenance worker may not apply this managed-file repair; it must be applied from the owner host's CLI. | `-` | no | On the owner host: `gbrain repair fences --source <source>`, then the printed apply command. Format: [tiers](fence-format.md#never-guessed). |
| <a id="fence-host_mismatch"></a>`host_mismatch` | Another host id owns this source's checkout; the hold names both ids (first 8 characters). Two environments on one machine with different `GBRAIN_HOME` identity files (a launchd or cron worker and a shell) look exactly like this. Retrying from this host cannot change the answer. | `-` | no | Run `gbrain repair fences --source <source>` on the owner host (`gbrain sources writer status --source <source> --json` names it), or give the worker and the shell one `GBRAIN_HOME`. Never copy or regenerate `host.json`: a new identity orphans the ownership recorded for the old one. Format: [tiers](fence-format.md#never-guessed). |
| <a id="fence-transfer_in_progress"></a>`transfer_in_progress` | A writer transfer of the source is prepared and its worktree is draining, so no host may write it yet. | `-` | yes | Nothing to do: the next run repairs it once the transfer is accepted or cancelled; `gbrain sources writer status --source <source> --json` shows the state. Format: [tiers](fence-format.md#never-guessed). |
| <a id="fence-clone_in_progress"></a>`clone_in_progress` | A topology clone or reclone of the source's checkout is in progress and its worktree is recovering. | `-` | yes | Nothing to do: the next run repairs it once the clone finishes; `gbrain sources writer status --source <source> --json` shows the state. Format: [tiers](fence-format.md#never-guessed). |
| <a id="fence-incarnation_changed"></a>`incarnation_changed` | The source's checkout binding belongs to an earlier incarnation of the source (it was removed and re-added, or restored), so the checkout it names is not this source's. | `-` | no | On the brain host, review `gbrain sources writer status --source <source> --json` and re-bind the checkout; the next run after that repairs the file. Format: [tiers](fence-format.md#never-guessed). |
| <a id="fence-local_path_missing"></a>`local_path_missing` | This host owns the source's worktree but has no checkout path registered for it. | `-` | no | On the brain host, review `gbrain sources writer status --source <source> --json` and register the checkout again; the next run after that repairs the file. Format: [tiers](fence-format.md#never-guessed). |
| <a id="fence-coordination_path_missing"></a>`coordination_path_missing` | This host's registration for the source has a checkout path but no coordination directory (where the physical-root stamp and locks live). | `-` | no | On the brain host, review `gbrain sources writer status --source <source> --json` and repair the registration; the next run after that repairs the file. Format: [tiers](fence-format.md#never-guessed). |
| <a id="fence-sync_in_progress"></a>`sync_in_progress` | A write in flight names the file, or the file is still ahead in a running sync's frozen manifest (the sync would refuse it on its raw hash if a repair changed it first), so this one candidate waits; the rest of the source is repaired while the sync runs. A held file is not busy. When the busy set itself cannot be read, every candidate waits. | `-` | yes | Nothing to do: the next run retries. To finish the sync now: `gbrain sync --source <source> --no-pull`. Format: [tiers](fence-format.md#never-guessed). |
| <a id="fence-time_budget"></a>`time_budget` | The repair run reached its time budget (the maintenance phase stops at the smaller of 300 s and a third of the job's remaining deadline). | `-` | yes | Nothing to do: the next run resumes where it stopped. Format: [tiers](fence-format.md#never-guessed). |
| <a id="fence-changed_since_read"></a>`changed_since_read` | The file changed after the repair read it, so nothing was written. | `-` | yes | Nothing to do: the next run reads it again. Format: [tiers](fence-format.md#never-guessed). |
| <a id="fence-changed_since_preview"></a>`changed_since_preview` | `gbrain repair fences --apply --expect <hash>` found the file's bytes or the page's revision changed since the preview, so that item was not applied. | `-` | no | Preview again with the same selection and apply the new `--expect` hash. Format: [tiers](fence-format.md#never-guessed). |
| <a id="fence-still_invalid"></a>`still_invalid` | Gate (a): the proposed repair still does not parse cleanly. Nothing was written. | `-` | no | Fix the named rows by hand. Format: [gates](fence-format.md#gates). |
| <a id="fence-claim_changed"></a>`claim_changed` | Gate (b): the proposed repair changed claim text. Nothing was written. | `-` | no | Fix the named rows by hand. Format: [gates](fence-format.md#gates). |
| <a id="fence-row_number_changed"></a>`row_number_changed` | Gate (c): the proposed repair changed or dropped an existing valid row number. Nothing was written. | `-` | no | Fix the named rows by hand. Format: [gates](fence-format.md#gates). |
| <a id="fence-visibility_loosened"></a>`visibility_loosened` | Gate (d): the proposed repair made a row more visible. Nothing was written. | `-` | no | Fix the named rows by hand; ask the user which visibility is intended, never widen it yourself. Format: [gates](fence-format.md#gates). |
| <a id="fence-row_count_changed"></a>`row_count_changed` | Gate (e): the proposed repair added or dropped a row, or left one outside the fence. Nothing was written. | `-` | no | Fix the named rows by hand. Format: [gates](fence-format.md#gates). |
| <a id="fence-cell_changed"></a>`cell_changed` | Gate (f): the proposed repair changed a cell no named rule allows (a valid weight, holder, date, source, confidence or context). Nothing was written. | `-` | no | Fix the named columns of the named rows by hand. Format: [gates](fence-format.md#gates). |
| <a id="fence-protection_loosened"></a>`protection_loosened` | Gate (g): the proposed repair would show text the privacy boundary hid before it. Nothing was written. | `-` | no | Add the end marker where the fence really ends. Format: [gates](fence-format.md#gates). |

A managed source a fence refusal blocked before this release recovers on its
next sync with no command: the file is held and the rest imports
(`gbrain sync --source <source> --no-pull` does it now).

A source that a gbrain older than v0.60.47.0 blocked on one of these refusals
recovers on its next sync (scheduled or manual) with no ledger surgery: the blocked request is
converted in place and reported as `converted_from_failed`. To do it now run
`gbrain sync --source <source> --no-pull`. `gbrain config set sync.holds fail`
makes sync fail closed for teams that want it. Escalation:
more than `sync.hold_escalate_count` (default 50) holds in a source, or more
than `sync.hold_escalate_pct` (default 5%) of a run's screened imports (at
least 40), sets `holds_escalated` and makes doctor `git_held_files` fail: a
generator or an upgrade is likely writing or reading files wrong.

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
| <a id="refresh_no_upstream"></a>`refresh_no_upstream` | `refresh_no_upstream` | The checkout's branch tracks no upstream, HEAD is detached, or the checkout is not a Git checkout at all (gbrain never initializes Git on its own), so there is nothing to fast-forward to. | `git -C <checkout> branch --set-upstream-to <remote>/<branch>` (the fix fills in the real values), then retry. A checkout that is not Git has nothing to refresh; making it a clone with an upstream is the user's call. |
| <a id="fetch_failed"></a>`fetch_failed` | `fetch_failed` | `git fetch` failed or did not finish within `sources.refresh_fetch_timeout_ms` (default 120000; `GBRAIN_REFRESH_FETCH_TIMEOUT_MS`; `--fetch-timeout-ms` wins over both). Nothing changed and no refresh record was written. | Retry. For a slow remote, raise the bound with `--fetch-timeout-ms <ms>` or `gbrain config set sources.refresh_fetch_timeout_ms <ms>`. Credentials are the user's: ask them to fix authentication rather than changing the remote. |
| <a id="refresh_git_unavailable"></a>`git_unavailable` | `git_unavailable` | A git command that reads the checkout's branch or remote (`symbolic-ref`, `remote`, `config --get branch.<branch>.remote` or `.merge`) failed or did not finish, so the checkout's state is unknown. The message names the command and git's first error line. A detached HEAD or an unset key is not this refusal. Nothing changed and no refresh record was written. | Run `git -C <checkout> status` to see why git cannot read the checkout, repair what it reports, then retry `gbrain sources refresh <source>`. |
| <a id="refresh_diverged"></a>`refresh_diverged` | `refresh_diverged` | The checkout has commits its upstream lacks, so a fast-forward is impossible. Nothing changed. | Reconcile the histories and push from a clone that is not managed, then retry. `gbrain sources reclone <source>` replaces the checkout; ask the user first, because local commits are dropped. |
| <a id="refresh_dirty"></a>`refresh_dirty` | `refresh_dirty` | Uncommitted or untracked files overlap the incoming upstream changes (the first 20 are named), or `git merge --ff-only` refused for the same reason. HEAD did not move. Uncommitted files outside the incoming changes do not refuse; they are kept and listed as `preserved_uncommitted`. | Commit or discard the named paths, then retry. Check `gbrain sources writer status <source> --json` first: a pending Git effect may be about to commit a gbrain-published file. |
| <a id="sync_in_progress"></a>`sync_in_progress` | `sync_in_progress` | A managed sync of one of the checkout's sources has an unfinished cursor. Moving the checkout now would strand it, and the refresh never waits on a sync. `gbrain repair frontmatter --apply` refuses the same way while an unfinished cursor still names a selected file. | Run the printed `gbrain sync --source <source> --no-pull ...` resume command (it keeps the cursor's options), then retry (for a repair, preview again and approve the new hash). |
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

## Managed sync drain stops

`gbrain sync` on a managed brain keeps going until the source's cursor is done
(see [catching up a large backlog](live-sync.md#catching-up-a-large-backlog-on-managed-postgres)).
When it stops early, the run ends in one outcome: `resumable` (exit 0, safe to
rerun the same command) or `blocked` (exit 1, needs a fix first). `--json`
carries `outcome`, `drain.stop_reason` and `next: { command, safe_to_loop,
retry_after_ms, eta_seconds, rate_pages_per_min, why, docs }`. Run
`next.command`; loop on it only when `next.safe_to_loop` is true.

**Say to your agent:** *"Catch up my managed brain's sync backlog and tell me how long it will take."*

| Stop reason | Code | Outcome | What it means | Recovery |
| --- | --- | --- | --- | --- |
| <a id="drain-stopped-at-its-deadline"></a>`deadline` | `writer_pending` | `resumable` | `--timeout`, `--hard-deadline`, Ctrl-C or the run deadline stopped the drain. Accepted page writes keep their request IDs and the cursor is intact. | Rerun `next.command` (the same options). It resumes where the last run stopped. |
| <a id="drain-stalled"></a>`drain_stalled` | `drain_stalled` | `blocked` | The awaited page write and the oldest unfinished write on its checkout made no progress for the whole stall window: no committed receipt and no step advance. A lease renewal is not a change: the detector keys on the head claim's phase and step. With a live owner on **this host**, the drain does not stop at the allowance (the preparation budget plus 30 s): from there it prints `stalled <N>s on <step>` with the owner's pid and kind every 10 s and keeps going, because the owner's own budget frees the root by `persistence.preparation_ceiling_ms` (600 s) and the next pass holds the entry. It stops `drain_stalled` only when the ceiling passes without the root being released, or when the owner's `persistence_consumers` row reads wedged (`restart_required`, or a root barrier older than the ceiling); the stop then carries `cause: owner_wedged_here`, the owner `{kind, pid, nonce}`, `retry_after_ms` (the time left to the ceiling, 0 once past), `next.safe_to_loop: true` while the ceiling is ahead and `next.fix.next` `wait` before it, `tell_user_to_run` (restart the named pid) after it. A lapsed claim (`owner_missing`) stops at once, unless this host owns the checkout and a live full consumer exists, which gets exactly one more window. Other causes: `preparation_overdue` / `publication_overdue` (a live owner elsewhere past its allowance) and `no_progress` (an unstamped head). `drain.stall` carries `phase`, `step`, `waiting_on`, `cause`, the owner and whether this host owns the checkout. | `gbrain sources writer status --source <source> --json`: its `next_action` says whether to wait (`retry_after_ms`) or which pid to restart. Before the ceiling, rerun `next.command` after `retry_after_ms` (safe in a loop). Past it, or with a wedged owner, restart the named owner process (`gbrain serve`, the jobs worker or autopilot) on the brain host, then rerun `next.command`; the held entry needs `gbrain sources retry-held <source>` afterwards. When this host is not the owner, make sure the owner's `gbrain serve` is running. |
| <a id="drain-database-contention"></a>`database_contention` | `database_contention` | `blocked` (or an error) | Three consecutive passes hit database contention, a statement timeout or a dropped connection, or reading the awaited write's state failed (an authentication or permission failure stops at once). The drain retries transient failures with backoff before giving up. Accepted writes keep their request IDs. | Fix database access (`gbrain engine status --probe`), then rerun `next.command`. |
| <a id="drain-writer-blocked"></a>`recovery_required`, `owner_unavailable`, `unexpected_file_bytes`, `unexpected_staging_bytes` | `recovery_required` | `blocked` | The checkout's writer needs intervention before more pages can publish: interrupted publication recovery, no live owner, or unexpected bytes in the file or staging area. | `gbrain sources writer status <source>` and the fix it prints. Unexpected bytes are the user's edits; ask before discarding them. Then rerun `next.command`. |
| <a id="drain-blocked-by-a-failed-page"></a>`blocked_by_failures` | `blocked_by_failures` | `blocked` | A page write failed terminally. `managed_write` and `failures` name the page and cause. Rerunning without a fix returns the same failure. | Fix the cause, then run `next.command` (it adds `--retry-failed`). Ask the user before skipping content. |
| <a id="drain-preparation-abandoned"></a>`preparation_abandoned` | `preparation_abandoned` | `resumable` | A write this process's own writer holds was still preparing past its allowance (its budget plus 30 s, never more than the ceiling `persistence.preparation_ceiling_ms` plus 30 s) and the process cannot cancel it, so the sync exited to end it. The cursor and accepted writes are intact; `drain.stall` names the step (`stall.step`, `stall.waiting_on`). Exit 0. | Rerun `next.command` (`safe_to_loop` is true). The next pass holds the entry as `preparation_stalled` if it stalls again; `gbrain sources writer status --source <source> --json` shows what it was stuck on. |
| <a id="preparation_systemic"></a><a id="drain-preparation-systemic"></a>`preparation_systemic` | `preparation_systemic` | `blocked` | The run's breaker tripped: more `preparation_stalled` receipts than a source should hold (the `sync.hold_escalate_count` / `sync.hold_escalate_pct` rule over this run's screened imports) or five stalled entries in a row with no page committed between them. The run stopped with one diagnostic instead of holding every file: the write owner, not the files, is the likely cause. `breaker` carries the rule, the counts, the last step and the fix; exit 1. | `gbrain sources writer status --source <source> --json`, fix what it names or upgrade gbrain, then rerun the same sync: it re-freezes the stopped entry under a fresh request and schedules the files this run held for a re-screen. |
| <a id="drain-write-capacity"></a>`write_capacity` | `queue_capacity` | `blocked` | The sync could not admit its next write for the whole no-progress window (30 s) because other writers' requests held the outstanding-request cap of its write principal (`persistence.limits.principal_outstanding`, default 100; the brain cap `persistence.limits.brain_outstanding`, 1000, works the same way): on one host the CLI sync and a maintenance run (fact-fence adoption, `dream`) share the `local_cli` principal, so a long adoption queue leaves no room for a sync write. Nothing failed and the cursor is intact: the drain retried the admission with backoff while they settled, printing `waiting for write capacity (N outstanding of M)`, and stopped only when the window passed. `drain.capacity` carries the counts and the wait; exit 1. A cumulative cap (permanent request IDs, receipt bytes) is a different refusal: it names its config key and stops at once. | `gbrain sources writer status --source <source> --json` lists the outstanding requests (read-only). Let them finish, or raise the cap (`gbrain config set persistence.limits.principal_outstanding 200`), then rerun the same sync; it resumes where it stopped. |
| <a id="drain-connection-lost"></a>`connection_lost` | `connection_lost` | `blocked` | The database connection dropped three times in a row (`write ECONNABORTED`, `ECONNRESET`, `ETIMEDOUT`, `EPIPE`: a pooler closing the socket mid-statement) with no page committed between the drops (#6340). Each drop was reconnected and retried after 5, 15 and 45 s; a drop that then moves data is not reported at all. Nothing is recorded against the source: the cursor and its frozen manifest stand, and `drain.connection` carries the count and the last error text (never a URL). Exit 1. | Check the database and pooler (`gbrain doctor --json`), then rerun `next.command` (`safe_to_loop` is true, `retry_after_ms` 60 s): it resumes at the stored cursor without re-freezing the manifest, with or without `--retry-failed`. Runbook: [sync unblock](sync-unblock-runbook.md#connection). |

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
canonical file refuses the same way (a version an older gbrain recorded
without that information counts as file-less).

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
Pages indexed by a gbrain older than v0.60.31.0 that contain a `BEGIN` or
`END … PRIVATE KEY` line are withheld from search until the upgrade re-chunks them, without
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
- **rule ... since**: the gbrain version that added or changed the rule
  (v0.60.31.0 for `url_credentials`, `basic_auth`, `digitalocean` and
  private keys whose `BEGIN` or `END` line is missing). A push that worked before an upgrade and fails after it names
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

The fingerprint of a private key whose `END` line is missing (a cut-off
excerpt) covers the key body as well as its `BEGIN` line. gbrain older than
v0.60.31.0 fingerprinted the `BEGIN` line alone, so an allowlist entry
written then does not match and the push is refused. The refusal says so and
gives the replacement:

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
