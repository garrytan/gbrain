# Troubleshooting

**Say to your agent first:** *"Run a brain health check and fix what you find"* — this routes to the maintain skill, which runs `gbrain doctor` and either auto-fixes or prints the exact repair command; your agent can run the whole loop (*"Get my brain health score to 90"* uses the remediation planner with a cost cap). The sections below are for when you want the manual path.

**Agents:** every gbrain error and refusal carries `code` and a `fix` whose `next` says who acts and whether to stop and ask. Follow the [agent operator protocol](../protocol/AGENT_OPERATOR_v1.md) first; `gbrain errors <code>` explains any code offline. This page covers symptoms that are not a single error.

## Symptom table

<a id="symptom-table"></a>

**Who acts**: *agent* runs it; *agent, after the user agrees* means relay the consent and stop first; *user* means the user runs it in their own terminal; *brain host* means the operator of the machine that runs the brain. **Consent** lists the effects (`paid`, `destructive`, `credentials`, `egress`, `persistent_install`) that need the user's agreement; "none" means the agent can just run it. **Verify** is always read-only.

| Symptom | Next step | Who acts | Consent | Verify |
|---|---|---|---|---|
| Recall returns conversation facts like "Date said …", "Attendees said …" or "Summary said …" | `gbrain repair conversation-labels` previews them ([conversation labels](repair.md#conversation-labels)); apply the printed command with `--yes` | agent, after the user agrees | `destructive` | `gbrain doctor --only conversation_label_facts --json` is ok |
| Conversation facts are dated 1970-01-01 | same preview: `gbrain repair conversation-labels` (an undated page's pre-fix facts carry a `segment 1970-01-01` context); add a `date:` to the page frontmatter before re-extracting it | agent, after the user agrees | `destructive` | `gbrain doctor --only conversation_label_facts --json` is ok |
| A gbrain call failed with a code you don't recognize | follow `fix.next` ([protocol](../protocol/AGENT_OPERATOR_v1.md)); `gbrain errors <code>` | agent | as the fix's `consent` | the fix's `verify` |
| A graph read omits a relationship you know existed, or says someone still works somewhere they left | the default read returns relationships true today: repeat with `status: "all"` or `as_of`; to record an end, add a dated timeline line (`Ended works_at [[companies/x]]`) or `add_link ... valid_until` ([temporal edges](temporal-edges.md)) | agent | none | `gbrain doctor --only edge_validity --json` |
| A command exited 3 (`confirmation_required`) | relay `user_message`; run `fix.command` only after the user agrees | agent, after the user agrees | the payload's `effects` | the fix's `verify` |
| [Database unreachable or `GBRAIN_DB_ACCESS <reason>`](#database-unreachable) | `gbrain engine status --probe`, then `gbrain db-repair` (diagnose); `gbrain db-repair --yes` applies safe fixes | agent; `--yes` after the user agrees | none to diagnose; `--apply-rewrites` rewrites the config URL (undoable) | `gbrain engine status --probe --json` |
| [PGLite `RuntimeError: Aborted()` at startup](#pglite-aborted) | automatic repair on the next command; else `gbrain pglite-repair --dry-run`, then `gbrain pglite-repair --yes` | agent; `--yes` after the user agrees | `destructive` (a WAL backup is kept and the restore command printed) | `gbrain doctor --only connection --json` |
| [`expected N dimensions, not M` on import](#embedding-dimensions) | `gbrain doctor` prints the exact `gbrain config set …` or `gbrain migrate embeddings --to <provider:model>` command | agent, after the user agrees | `migrate embeddings`: `paid`, needs the brain's writer lock | `gbrain doctor --only embeddings,embedding_width_consistency --json` |
| [Keyword-only recall; the user wants semantic search](#embedding-dimensions) | the readiness fix: `gbrain init --force --embedding-model <provider:model> --path <brain path>` (keeps pages and facts) | agent, after the user agrees | `credentials`, `paid`; needs the brain's writer lock | `gbrain doctor --only embeddings --json` |
| [Doctor residue (`timeline_history`, `derived_visibility`, `safe_index_pending`)](#doctor-residue) | preview `gbrain doctor --remediation-plan --json` or `gbrain repair`; then `gbrain repair <kind> --apply` | brain host, after the user agrees | `destructive` (rewrites derived rows) | `gbrain doctor --only timeline_history,derived_visibility,safe_index_pending --json` |
| Low health score | preview `gbrain doctor --remediation-plan --json`; then `gbrain doctor --remediate --yes --target-score 90 --max-usd 5` | agent, after the user agrees | `paid`; `destructive` with `--include-repairs` (approve with `--expect <plan_hash>` from the preview) | `gbrain doctor --json` |
| [Sync held a file (`Held <path>: invalid_frontmatter …`, `git_held_files`)](#held-files) | `gbrain sources status <id>`, then preview `gbrain repair frontmatter --source <id>` and apply the printed `--apply --expect <hash> --yes` | agent; the apply after the user agrees | `destructive` (rewrites the previewed lines of the files) | `gbrain doctor --only git_held_files --json` |
| [Sync held a file for its facts or takes fence (`Held <path>: invalid_fence …`)](#held-fence-files) | nothing for most holds: the next maintenance run repairs and commits the fence. To see or do it now, preview `gbrain repair fences --source <id>` and run its printed `--apply --expect <hash>`; to pause automatic repair, `gbrain config set fences.repair.enabled false` (ask the user first). A `manual` reason needs the edit the hold names | agent; the apply needs no extra consent | none (model repair spends within the `fences.repair.*` caps; raising them is `paid`, the user's call) | `gbrain doctor --only fence_integrity --json` |
| [Managed catch-up stuck, or `Held <path>: preparation_stalled`, or the drain stopped `preparation_abandoned` / `preparation_systemic` / `write_capacity`](#catch-up-stuck) | `gbrain sources writer status --source <id> --json` (what the stuck write was doing: step, `waiting_on`, owner, version), fix what it names or upgrade the owner, then `gbrain sources retry-held <id>` and the same sync with its options | agent; a restart or upgrade of the owner after the user agrees | none to inspect; `persistent_install` when the fix restarts a service | `gbrain sources status <id> --json`, then `gbrain doctor --only git_held_files,persistence_write_stall --json` |
| [A Google or GitHub item is held (`connector_held_items`)](#held-connector-items) | `gbrain sources status <id>`, fix the cause, then `gbrain sources retry-held <id>` and `gbrain sync --source <id>` | agent, after the user agrees | `egress` (fetches from the provider again) | `gbrain doctor --only connector_held_items --json` |
| [`gbrain migrate --to` refused with `writer_coordinator_required`](../ENGINES.md#engine-migration-refused) | follow the refusal's `fix`: relay its `user_message` (stay on PGLite and share with `gbrain mcp expose`, or leave the brain as it is) | agent, after the user agrees | `persistent_install`, `egress` (for `gbrain mcp expose`) | `gbrain doctor --no-migrate --json` |
| [A write was refused with a named reason](#write-refused) | the reason's recovery in [write refusal reasons](write-refusals.md) | as the refusal's `fix` | as the refusal's `fix` | the refusal's `verify` |
| [Managed sync blocked with `checkpoint_validation_timeout`](#checkpoint-validation-timeout) | `gbrain repair request-indexes --apply` when an index is missing or INVALID, then the printed `gbrain sync --source <id> --no-pull --retry-failed …` | brain host | none | `gbrain doctor --only persistence_request_indexes --json` |
| [Doctor warns `persistence_session_timeouts` (`session_timeouts_not_applied`)](#session-timeouts-not-applied) | `ALTER ROLE <gbrain role> SET statement_timeout = '5min'` on the database, or accept it: preparation reads carry their own bound | brain host | none (a role default; `destructive` only in that it changes a server setting) | `gbrain doctor --only persistence_session_timeouts --json` |
| [`queue_capacity`, `persistence_capacity` or `persistence_request_growth`](#write-capacity) | run the printed `gbrain config set persistence.limits.<limit> <value>` | brain host | none | `gbrain doctor --only persistence_capacity,persistence_request_growth --json` |
| [`dream_paid_loop`, or dream keeps skipping one transcript](#dream-paid-loop) | fix the cause, then `gbrain dream reset-key --list` and `gbrain dream reset-key '<key>'` | agent, after the user agrees | `paid` (the key is retried) | `gbrain doctor --only dream_paid_loop --json` |
| [Search answers look keyword-only on a large Postgres brain](#hybrid-search-returns-only-keyword-hits) | read doctor's `vector_plan`; run the index command it prints | brain host | none | `gbrain doctor --only vector_plan --json` |
| A second `gbrain serve` cannot open the brain | the readiness `harness_wiring` fix: every session shares one `gbrain serve --http` | user | `persistent_install`, `credentials` | `gbrain doctor --only harness_wiring --json` |
| A tool the fix names is missing after a serve recovered | restart the gbrain MCP server in the harness, or start a new session ([why](../protocol/AGENT_OPERATOR_v1.md#tool-catalog-changes-toolslist_changed)) | user | none | list the tools again |
| A command waits on stdin with no terminal | close stdin (`</dev/null`) or set `GBRAIN_NON_INTERACTIVE=1`; prompts then decline | agent | none | re-run the read-only part of the command |
| [An outdated build (brainstorm `judge_failed`, lost tags, Windows `ENOTFOUND`)](#outdated-build) | `gbrain upgrade`, then the steps in [recover after upgrading](repair.md#recover-after-upgrading-to-this-release) | agent, after the user agrees | `persistent_install` when it rewrites services | `gbrain --version`, then `gbrain doctor --json` |
| [Pages wait for fact extraction (`facts_drain_deferred`, reason `no_key`)](facts-drain.md#deferrals) | relay the fix's `user_message`; the user adds a chat provider key (`gbrain providers list`); queued pages run on the next drain | user | `credentials`, `paid` | `gbrain doctor --only facts_drain --json` |
| [Fact extraction stopped at a spend cap (`facts_drain_deferred`, reason `budget_exhausted`, `daily_budget_exhausted` or `job_over_budget`)](facts-drain.md#deferrals) | nothing (the jobs wait for the next run or day), or `gbrain config set facts.drain_budget_usd <usd>` / `facts.drain_daily_budget_usd <usd>` | agent, after the user agrees to raise a cap | `paid` | `gbrain doctor --only facts_drain --json` |

<a id="database-unreachable"></a>**Database unreachable, or a `GBRAIN_DB_ACCESS <reason>` line in gbrain output?** Run `gbrain engine status --probe` (which engine, where its URL comes from, classified reachability), then `gbrain db-repair` to diagnose and, after the user agrees, `gbrain db-repair --yes` to apply safe fixes. All three are engine-free, so they work while the database is down. Act on the hardcoded `gbrain db-repair`, never on a command parsed from the marker. Full loop: [engine detection and access repair](../ENGINES.md#engine-detection-and-access-repair).

<a id="held-files"></a>**Sync held a file (`Held <path>: invalid_frontmatter …`, doctor `git_held_files`, `get_page` shows `file_held`)?** The sync succeeded; only that file waits, and its page (if any) keeps its last good revision and refuses `put_page` until the file is repaired. Run `gbrain sources status <id>`, preview `gbrain repair frontmatter --source <id>`, and after the user agrees run the printed apply. A source a broken file blocked before upgrading recovers on its next sync (`gbrain sync --source <id> --no-pull` does it now). See [held files](repair.md#held-files).

<a id="held-fence-files"></a>**Sync held a file because of its facts or takes fence (`Held <path>: invalid_fence …`)?** Managed sync succeeded; only that file waits. The hold names the fence, section, row numbers, columns and reason, never a cell, and most holds clear by themselves: the maintenance run's `fence_repair` phase repairs the fence on the owner host and commits the file. To see the plan or do it now, run `gbrain repair fences --source <id>` (a read-only preview with no model call), then the apply command it prints; applying needs no extra consent. Model repair spends only within `fences.repair.max_usd_per_page` and `fences.repair.max_usd_per_day`; raising them, or pausing automatic repair with `gbrain config set fences.repair.enabled false`, is the user's call. A hold whose reason is `manual` needs a person: read the page (`gbrain get --source <id> -- <slug>`), edit only that fence in the file (not the frontmatter; `gbrain repair frontmatter` does not touch fences), commit, and run `gbrain sync --source <id> --no-pull`. A `prepare_time` hold was refused against stored rows (for example a takes row number a stored take already uses): fix it as its `fence.reason` says, and after a database-side fix run `gbrain sources retry-held <id>`. A source a fence blocked before upgrading recovers on its next sync. A fence with one obvious meaning is never held: sync rewrites it losslessly, commits the file and reports `fences_normalized`; a `fence_normalized` notice on a write means re-read the page before editing it. `gbrain doctor --only fence_integrity` counts every malformed fence still waiting (held, stored or unsynced) by tier. See [fence holds](write-refusals.md#invalid_fence), [fence repair](repair.md#fences) and the [fence format](fence-format.md).

<a id="concurrent-write-hold"></a>**Sync held a file with `concurrent_write`?** A Git edit raced a database-only write; nothing was overwritten. Preview `gbrain sources reconcile <id> <slug> --preview`, let the user choose, then `gbrain sources retry-held <id>`. See [concurrent_write](write-refusals.md#concurrent_write).

<a id="catch-up-stuck"></a>**Managed catch-up stuck (one write `running` for minutes while the rest waits), held N files as `preparation_stalled`, or the drain stopped with `preparation_abandoned`, `preparation_systemic` or `write_capacity`?** Every managed write's *preparation* has a deadline (`persistence.sync_preparation_ms`, default 120 s, for sync members; `persistence.maintenance_preparation_ms`, default 120 s, for maintenance writes; a hard ceiling `persistence.preparation_ceiling_ms`, default 600 s; `persistence.max_preparation_attempts`, default 2; all behind the `preparation_deadlines` write switch), so one stuck write costs at most its budget times its attempts and the rest of the source keeps publishing. The runbook branches on what you see; every command below is read-only unless it says otherwise, and the files themselves are never the problem in this branch.

1. **While it is stuck.** The progress line prints `stalled <N>s on <step>` instead of an ETA. Run `gbrain sources writer status --source <id> --json`: the blocked request's `claim.stall` names the step (`origin_check`, `knowledge_publication`, …), `waiting_on` (`git`, `fs`, `db`, `pool`, or an honest `unknown`), `step_age_ms`, the budget, and the owner process (kind, pid, gbrain version). An owner whose version predates this release never gives up: upgrade it and restart it (`gbrain serve`, the jobs worker or autopilot; the drain's own process ends with the drain). Otherwise wait out the budget: the write is released, retried once, then held.
2. **Held files (`preparation_stalled`).** `gbrain sources status <id> --json` lists them with the step each stalled on; no `gbrain repair` applies. After the cause is fixed (or gbrain upgraded), run `gbrain sources retry-held <id>` and then the same sync with the same options, which the hold's `fix` and `retry-held` print, for example `gbrain sync --source <id> --no-pull --no-embed`. If that sync still has a backlog, it finishes the backlog and then re-screens the scheduled files in the same run. Verify with `gbrain sources status <id> --json` (the held count drops) and `gbrain doctor --only git_held_files --json`. A held deletion keeps its page until that retry. A stalled hold also re-screens by itself when the gbrain version changes.
3. **The drain stopped `preparation_abandoned` (exit 0).** A preparation in the sync's own process was still running past its allowance (its budget plus 30 s) and cannot be cancelled in-process, so the sync exited to end it; `drain.stall.step` says where. Rerun `next.command` (`safe_to_loop` is true): the next pass holds the entry if it stalls again.
4. **The drain stopped `preparation_systemic` (exit 1).** Too many writes stalled in one run (more than `sync.hold_escalate_count` / `sync.hold_escalate_pct` of the run's screened imports, or five in a row with no page committed between), so the run stopped with one diagnostic instead of holding every file. `breaker` carries the rule, the counts and the last step. Inspect the writer as in step 1, fix the cause, then rerun the same sync: it re-freezes the stopped entry with a fresh request and re-screens the files that run held.
5. **The drain stopped `write_capacity` (exit 1).** Other writers' requests held the sync writer's outstanding-request cap (`persistence.limits.principal_outstanding`, default 100; on one host the CLI sync shares the `local_cli` principal with fact-fence adoption and `dream`) for the whole 30 s window, so the sync could not admit its next write. It waited and printed `waiting for write capacity (N outstanding of M)` first; nothing failed and the cursor is intact. `gbrain sources writer status --source <id> --json` lists the outstanding requests. Let them finish, or raise the cap (`gbrain config set persistence.limits.principal_outstanding 200`), then rerun the same sync. Reference: [drain stops](write-refusals.md#drain-write-capacity).
6. **A `put_page`, `remember` or maintenance write finished `preparation_stalled`.** Nothing is held: the receipt names the step. Read the writer as in step 1, then resubmit a foreground write under a new `request_id`; the next maintenance run submits its write again.
7. **A manual fence defect among the holds** (`invalid_fence`, reason `manual`, or `repeated_marker`) is a different branch: see [held fence files](#held-fence-files). `gbrain sources status` keeps the kinds apart and routes each to its own command.

Turning the `preparation_deadlines` switch off (`gbrain config set persistence.preparation_deadlines false`) restores the previous behaviour exactly: no deadlines on sync or maintenance writes, no attempt counter, no `preparation_stalled` holds. See [`preparation_stalled`](write-refusals.md#preparation_stalled), [managed sync drain stops](write-refusals.md#managed-sync-drain-stops) and the [timing knobs](live-sync.md#catching-up-a-large-backlog-on-managed-postgres).

<a id="held-connector-items"></a>**A Google or GitHub item is held after repeated failures (doctor `connector_held_items`, `gbrain waiting` says coverage is partial)?** Run `gbrain sources status <id>`, fix the cause, then after the user agrees run `gbrain sources retry-held <id>` and `gbrain sync --source <id>`. See [held items](google-connect.md#held-items).

<a id="checkpoint-validation-timeout"></a>**A managed sync is blocked with `checkpoint_validation_timeout`?** Run the printed commands on the brain host: `gbrain repair request-indexes --apply` when an index is missing or INVALID, then the printed `gbrain sync --source <id> --no-pull --retry-failed …`. Doctor's `persistence_request_growth` warns before lifetime request IDs run out.

<a id="pglite-aborted"></a>**PGLite crashes at startup with `RuntimeError: Aborted()` (often right after a macOS upgrade)?** Not a macOS incompatibility — the OS-upgrade reboot killed gbrain mid-write and tore the data dir's WAL. gbrain repairs this automatically on the next command (data preserved, backup kept); if auto-repair is disabled or skipped, run `gbrain pglite-repair --dry-run` to diagnose and `gbrain pglite-repair --yes` to repair in place. Full recovery ladder (repair → rebuild → engine switch) in [`docs/ENGINES.md` — Troubleshooting: startup abort](../ENGINES.md#troubleshooting-startup-abort-runtimeerror-aborted) and [`docs/INSTALL.md`](../INSTALL.md#pglite-crashes-at-startup-runtimeerror-aborted).

<a id="embedding-dimensions"></a>**`gbrain import` fails with `expected N dimensions, not M`?** Run `gbrain doctor`. It will print the exact `gbrain config set ...` or `gbrain migrate embeddings` command to repair the mismatch (`migrate embeddings` re-embeds through the provider: effect `paid`, ask the user first). You should not need to delete `~/.gbrain`. Fresh `gbrain init --pglite` auto-detects your embedding provider from API keys: set `VOYAGE_API_KEY` (or `OPENAI_API_KEY` / another provider key) in the environment — or in `~/.gbrain/config.json`, which init also reads — before running init, or pass `--embedding-model <provider>:<model>` explicitly. With multiple keys set, init fires an interactive picker (non-TTY auto-picks the Voyage default when its key is present). With no keys at all, init continues keyless (keyword-only search) with a loud notice; add a key later and re-run `gbrain init --force --embedding-model voyage:voyage-4` to enable embeddings (effects: `credentials` and `paid`, since every page is embedded through the provider; it needs the brain's writer lock, so stop a running `gbrain serve` first; pages and facts are kept), or pass `--no-embedding` up front to make keyless explicit. `gbrain config get embedding_disabled` reports whether embedding is off and which plane says so (the config file and the database setting; `true` on either turns it off); `gbrain config set embedding_disabled true|false` and `gbrain config unset embedding_disabled` change both, and the `init --force --embedding-model` enable path clears both. See [`docs/integrations/embedding-providers.md`](../integrations/embedding-providers.md) for the full provider matrix and [`docs/operations/headless-install.md`](../operations/headless-install.md) for Docker/CI sequencing.

**`gbrain doctor` warns `default_source_local_path`?** Your `default` source has no `local_path` AND that null pointer is provably breaking write-through (the repo fallback is another source's own working tree, or file-backed default pages have no resolvable root). A null `local_path` on its own is the designed fallback topology and reports ok. The repair is a pointer update, never a file move: `gbrain sources set-path default <path>` prints the prior value before changing it and refuses a path that nests inside or swallows another source's tree (exit 6; `--force` bypasses). **Say to your agent:** *"Run a brain health check and fix what you find"* — the maintain skill runs `gbrain doctor` and applies the printed repair.

**A Gmail, Calendar or GitHub connector source still has an old `local_path`?** Connector sources sync from their provider, so autopilot ignores their `local_path`: once a connector has synced (or tried to) at least once, autopilot syncs it on every interval and runs its database phases with no checkout. A connector that has never synced stays idle until you run `gbrain sync --source <id>` once; autopilot prints that command the first time it skips one. To remove the stale pointer, run `gbrain sources set-path <id> --clear` (connector sources only; it refuses a filesystem source and a connector bound to a canonical owner). `config.syncEnabled=false` still opts a source out. **Say to your agent:** *"My Gmail source points at an old folder. Clear it and keep it syncing."*

<a id="write-refused"></a>**A save, sync or background effect was refused with a named reason?** Reasons such as `file_database_drift`, `ambiguous_source_path`, `physical_root_device_changed`, `cursor_processing_options_conflict`, `take_row_collision`, `invalid_source_uri`, `queue_capacity` and parked effects (`targets_parked`, doctor `parked_effects`) each come with a recovery step in the error's `suggestion`. [Write refusal reasons](write-refusals.md) explains each one and its recovery. **Say to your agent:** *"My save was refused. Explain the reason and show me the fix before you run it."*

<a id="doctor-residue"></a>**`gbrain doctor` warns `timeline_history`, `derived_visibility`, or unsealed pages under `contextual_retrieval_coverage`?** Preview the fix with `gbrain repair`, then apply one kind at a time with `gbrain repair <kind> --apply` on the brain host. See [repair residual damage](repair.md).

**`gbrain doctor` warns `timeline_orphans`?** Timeline rows from an earlier version of a page are still in the database after the dated bullet was edited or deleted. Preview with `gbrain extract timeline --prune-orphans --dry-run`, then remove them with `gbrain extract timeline --prune-orphans` (add `--source-id <id>` to limit it). Rows no page version ever produced, such as enrichment and meeting fan-out, are kept.

**A doctor check says "Not verified"?** <a id="not-verified-doctor-checks"></a>The check could not read its input, so it reports `warn` instead of `ok`; `gbrain doctor --json` carries `details.code: "not_verified"` and the underlying reason in `details.reason`. Fix the cause, then re-run `gbrain doctor`:

| Check | What it could not read | Fix |
| --- | --- | --- |
| `multi_source_drift` | a source's `local_path` root or a directory below it (`details.unreadable_sources`), the walk hit its bound (`details.limit` files / `details.timeout_ms`), or, for a source whose slugs are pinned to its git root, where `local_path` sits in its git work tree (`details.git_root_skipped`) | fix the path or permissions (`gbrain sources status`); for a large source re-run with `GBRAIN_DRIFT_LIMIT=<files> GBRAIN_DRIFT_TIMEOUT_MS=<ms> gbrain doctor`; for a git-root source, check that `git -C <local_path> rev-parse --show-prefix` succeeds (a checkout git can read and that it trusts) |
| `embed_staleness` | the stale-chunk count (the embed worker's own predicate) | the reason names the database error; re-run `gbrain doctor` once it is fixed |
| `schema_pack_consistency`, `schema_pack_source_drift` | the pages or config query, or a source's active schema pack | `gbrain schema lint --with-db` runs the same classification locally; `gbrain schema active` debugs pack resolution |

`bootstrap_push_health` and `gbrain bootstrap status` report only the push record of the workspace named by this machine's bootstrap receipt; another workspace's stale or failed push is listed as such (a warn naming that workspace), never as this workspace's state. `reranker_health` auth warnings are audit-log history (`details.live_probe_performed: false`), not a live check of the key. These warns can appear while every other check reads green; each one names a check that did not run.

<a id="git-convergence"></a>**`gbrain doctor` warns or fails `git_convergence`, or `bootstrap_push_health` warns that a workspace is ahead?** A Git checkout the brain syncs from (a source's `local_path` or `sync.repo_path`) has commits its upstream does not have, or uncommitted changes, so the system of record on the remote is behind the brain (#5063). Commits not on the upstream warn after 6 hours and fail after 24; uncommitted changes older than 6 hours warn. Doctor compares with the local `@{u}` ref and never fetches, so it is only as fresh as the last fetch; checkouts without an upstream and connector sources are skipped. Commit and push the checkout (`gbrain sources push --path <root>` for a bootstrap workspace, `git push` otherwise). `bootstrap_push_health` no longer reports `ok` on a recent successful push while the workspace still has commits not on origin.

**`brain_score` shows a low "timeline density (entity and event pages)"?** The 15-point timeline component grades only linkable pages whose type's active-pack primitive is `entity` or `temporal` (people, companies, meetings, emails, events…); reference documents such as notes, writing and guides have no events and are not graded, so do not stamp "page created" rows onto them. Types the pack does not declare are still graded. Raise the score by giving those entity and event pages real timeline entries (`gbrain extract timeline`).

**`gbrain doctor` warns `slug_collisions`, or sync prints slug collisions?** Two or more files in a source map to the same page slug (for example `notes/Foo Bar.md` and `notes/foo-bar.md`), and only one is indexed. Rename all but one file in each group, commit, then sync.

<a id="session-timeouts-not-applied"></a>**Doctor warns `persistence_session_timeouts` with `session_timeouts_not_applied`?** gbrain sets `statement_timeout` (`GBRAIN_STATEMENT_TIMEOUT`, default 5min) and `idle_in_transaction_session_timeout` as connection startup parameters, and a transaction-mode pooler (PgBouncer with `ignore_startup_parameters`, Supavisor) drops them: `SHOW statement_timeout` through the configured URL reads `0`, so a statement outside a transaction has no server-side bound and a relation lock held in another session (a migration's `ALTER TABLE pages` queued behind a long transaction, for example) holds it for as long as the lock lasts. Managed write *preparation* reads are not affected since v0.60.108: they run under a transaction-local `statement_timeout` of the write's remaining preparation budget, so a lock-blocked read ends at the budget and the member is released `preparation_deadline` with no statement left on the server (#6278). For every other autocommit statement, set the default on the role instead of the connection: `ALTER ROLE <gbrain role> SET statement_timeout = '5min'` (read-only to check: `gbrain doctor --only persistence_session_timeouts --json`). Setting `GBRAIN_STATEMENT_TIMEOUT` has no effect through such a pooler.

<a id="persistence-write-stall"></a>**A managed write stays `running` and later writes queue behind it, or doctor warns `persistence_write_stall`?** The owner keeps renewing a hung claim; doctor warns past `persistence.max_claim_ms` (default 600000) and names the request, root, age, phase and, for a preparation, its step and what it waited on. A write stuck *preparing* is released at its deadline and finally held or failed `preparation_stalled` on its own: see [catch-up stuck](#catch-up-stuck). A write stuck *publishing*, or one whose owner predates the deadlines, still needs the owner restarted: run `gbrain sources writer status --source <id> --json` (read-only), then restart the `gbrain serve` that owns the root and attach that output when reporting it.

<a id="write-capacity"></a>**Managed writes refused with `queue_capacity`, or doctor warns `persistence_capacity`?** A per-principal or per-brain write-journal limit (`persistence.limits.*`) is full (`queue_capacity`), or doctor sees lifetime request IDs or receipt bytes at 80% or more (`persistence_capacity`). For the cumulative limits (lifetime request IDs and receipt bytes), the warning and the refusal print a `gbrain config set persistence.limits.<limit> <value>` sized for about one more year; run it on the brain host, then retry with the same request ID. For outstanding-request or queued-byte limits, let outstanding writes finish and check `gbrain sources writer status`. Receipt compaction age is `persistence.receipt_retention_days` (default 30). Limits and defaults: [bounded admission and retention](concurrent-writes.md#bounded-admission-and-retention).

<a id="dream-paid-loop"></a>**Dream keeps skipping one transcript, or doctor warns `dream_paid_loop`?** A dream key died `dream.breaker.max_dead_submissions` times (default 3) in 24 hours and is refused so it stops billing you. Fix the cause, then `gbrain dream reset-key --list` and `gbrain dream reset-key '<key>'`. See [the paid-loop breaker](../operations/spend-controls.md#dream-paid-loop-breaker-dreambreakermax_dead_submissions).

**Hourly cron sync keeps timing out on a federated brain?** Switch your
cron to a per-source loop with shell `timeout(1)` doing the OS-level kill
and gbrain self-terminating gracefully half-a-minute earlier:

```bash
gbrain sync --break-lock --all --max-age 1800
for src in $(gbrain sources list --json | jq -r '.[].id'); do
  timeout 600 gbrain sync --source "$src" --timeout 540 || true
done
```

When `--timeout` fires mid-import, `gbrain sync` exits 0 with status
`partial` and `last_commit` UNCHANGED — the next run re-walks the same
diff and `content_hash` short-circuits already-imported files. The
`--max-age 1800` first command self-heals any wedged-but-alive locks
left by a hung previous run, keyed on the lock's last refresh time
(NOT when it was acquired) so healthy long-running holders are safe by
construction. Scope note: the extract + embed phases still run to
completion once started; `--timeout` interrupts the import walk only.

**Dream cycle silently losing wiki links on Supabase?** The engine
self-retries every bulk batch write (`addLinksBatch` /
`addTimelineEntriesBatch` / `upsertChunks`) on Supavisor pooler blips,
with a 12s worst-case wait that covers the full 5-10s circuit-breaker
recovery window. `gbrain doctor` surfaces incidents via the
`batch_retry_health` check (reads the last 24h of
`~/.gbrain/audit/batch-retry-YYYY-Www.jsonl`). To tune for an unusually
slow pooler:

```bash
# Defaults: 3 retries, base 1s, max 10s, decorrelated jitter.
# Override per operator without a release:
export GBRAIN_BULK_MAX_RETRIES=5       # int >= 0; 0 disables retries
export GBRAIN_BULK_RETRY_BASE_MS=2000  # int > 0
export GBRAIN_BULK_RETRY_MAX_MS=15000  # int >= base
```

Bad values surface at `gbrain doctor` startup with a paste-ready fix
(not at first-retry mid-cycle). PGLite-only installs pay zero cost — the
retry wrap is engine-level, but PGLite has no pooler so retries never
fire in practice.

**Dream cycle losing ~150 link rows per run with `'No database
connection: connect() has not been called'` errors in the log?** The
retry layer self-heals on a nulled-out database singleton: a
`reconnect` callback on `withRetry` rebuilds the connection between
attempts, and `PostgresEngine.batchRetry` injects `() => this.reconnect()`
so engine-level batch writes survive a mid-cycle disconnect by something
else in the same process. `gbrain capture` does not trail a
`'No database connection'` stderr line from a background facts:absorb
worker firing after CLI exit, because op dispatch awaits
`getFactsQueue().drainPending({timeout: 1000})` before
`engine.disconnect()`. To find which code path is still calling
disconnect mid-process, run `gbrain doctor --json | jq '.checks[] |
select(.id=="batch_retry_health")'`; the check surfaces the
24h disconnect-call count and the most-recent caller frame from the
`~/.gbrain/audit/db-disconnect-YYYY-Www.jsonl` audit.

<a id="outdated-build"></a>**`gbrain brainstorm` returning `judge_failed: true` with 0 scored
ideas?** You are on an outdated build. Upgrade with `gbrain upgrade`
(it also runs any pending migrations; no config change is needed), then
confirm with `gbrain --version` and `gbrain doctor --json`. Current builds size the
judge's output cap to the idea count instead of truncating mid-JSON
past ~40 ideas, and slash-form model ids (`gbrain brainstorm
--judge-model anthropic/claude-sonnet-4-6 --max-cost 5`) resolve
pricing the same as the colon form instead of failing with
`BudgetExhausted reason=no_pricing`.

**`gbrain reindex --markdown` wiped your auto/dream/signal-detector
tags?** Run `gbrain upgrade`. Tag reconciliation is add-only: re-import
and `reindex --markdown` ADD current frontmatter tags and never delete,
so enrichment tags written to the DB (auto-tag, dream synthesize,
signal-detector) survive a re-chunk. The reindex DB-only fallback also
reconstructs the full markdown (frontmatter + body + timeline) before
re-chunking, so a page with no on-disk source keeps its frontmatter,
title, and timeline instead of getting overwritten with empty
frontmatter. Trade-off: removing a tag from a page's frontmatter does
not remove it from the DB on the next sync (frontmatter-tag removal
needs a provenance column, deferred).

**`gbrain sync` wedges on a large brain (no progress, high CPU)?**
Three tools. First, name the stalling file:

```bash
GBRAIN_SYNC_TRACE=1 gbrain sync --no-pull --no-embed --yes
```

The last `[sync] begin import: <path>` line with no following completion
is the file being processed when the hang hit. Second, if you suspect a
schema-pack `inference.regex` with catastrophic backtracking, complete
the sync with the pack disabled and re-run extraction later:

```bash
gbrain sync --no-schema-pack --no-pull --no-embed --yes
```

`gbrain schema lint` warns on the classic nested-quantifier ReDoS
shapes (`(a+)+`, `(a*)*`, …) in pack regexes, and the runtime caps
inference-regex input length (override via `GBRAIN_MAX_REGEX_INPUT_CHARS`).
Third, on a PGLite brain with a live `gbrain serve` (your agent's MCP
server), `gbrain sync` delegates through authenticated local IPC to the
owner, whether it serves HTTP or stdio. If the client exits, accepted page
requests can finish; repeat the same options to resume the managed sync
cursor. Embeds defer to the owner's background work. See
[`docs/architecture/serve-sync-concurrency.md`](../architecture/serve-sync-concurrency.md)
for supported flags, managed-mode limits and the full triage.

**`gbrain init --migrate-only` / a schema migration fails on Windows
with `getaddrinfo ENOTFOUND`?** Run `gbrain upgrade`. Schema bring-up
runs its phases in-process rather than spawning a child `gbrain init
--migrate-only` per phase; a spawned child is what dies on
Windows + bun + Supabase pooler with a DNS-resolution failure even
though the parent connects fine, and running in-process removes the
spawn entirely. The grandfather migration runs as a chunked bulk SQL
pass (keyed on the page PK, soft-delete-filtered, source-safe) and
completes in seconds on an 80K-page PGLite brain.

## Hybrid search returns only keyword hits

**Symptom.** On a large Postgres brain, `gbrain query` answers look keyword-only,
search metadata carries `vector_candidates_incomplete`, or each query takes about
8 seconds. The vector arm ran out of its 8 s candidate budget, usually because
the planner chose a sequential scan over the HNSW index (`idx_chunks_embedding`).

**Say to your agent:** *"Check whether vector search is using its index"* — the
agent runs `gbrain doctor` and reads the `vector_plan` check.

`gbrain doctor` reports `vector_plan` (Postgres only):

- `ok`: the statement vector search sends uses the HNSW index.
- skipped: PGLite, a column wider than pgvector's HNSW cap (exact scan by
  design), or fewer than 10,000 embedded chunks (a sequential scan is right
  for a small brain).
- warn, index unused: the message names the plan the planner chose and whether
  the HNSW index exists and is valid. Fix in this order: upgrade gbrain on the
  brain host (`gbrain upgrade`) and rerun `gbrain doctor`; if the index is
  missing or INVALID, run the `CREATE INDEX CONCURRENTLY` / `REINDEX INDEX
  CONCURRENTLY` command doctor prints.
- warn, stale text above 5%: run `gbrain embed --stale` so chunks edited after
  embedding get fresh vectors.
- warn, legacy guard: see below.

**Legacy guard (temporary rollback).** Vector search checks content freshness
outside the HNSW candidate scan. `search.vector_legacy_guard` restores the older
statement, which checked freshness inside the scan. Use it only when vector
search is slower or returns different results than before your upgrade, and
report the regression:

1. The setting belongs to the process that runs searches on the brain host
   (`gbrain serve`, autopilot, job workers), never to a thin client.
2. Set it with `gbrain config set search.vector_legacy_guard true`, or export
   `GBRAIN_VECTOR_LEGACY_GUARD=1` in that service's environment (the variable
   wins over the config key).
3. Restart the owning service. It reads the setting once at its first search and
   prints `[gbrain] vector legacy guard active` to stderr.
4. Confirm with `gbrain doctor`: `vector_plan` warns "legacy guard configured …
   active after restarting the owning service".
5. Remove it once the regression is fixed: `gbrain config set
   search.vector_legacy_guard false` (or unset the variable) and restart again.

**Filtered vector results changed (#6132).** HNSW scans use `relaxed_order`; restore with `gbrain config set search.hnsw_iterative_scan strict_order`, then restart serve.

The guard is temporary. The release that retires it prints a one-time notice
when the inert setting is still present.

## Global maintenance timeouts

**Doctor warns `global_maintenance_timeouts`, or late maintenance phases
(orphans, purge, the brain-wide embed) never seem to run?** On a large brain
one `autopilot-global-maintenance` job may not fit every phase before its
deadline (30 minutes by default). Each job stops starting phases that its
deadline would cut off and the next job resumes at that phase, so one pass can
span several jobs; the resume point is the config row
`autopilot.global_maintenance.progress`. A phase that was running when a job
died is skipped for the rest of that pass so the others still run, and doctor
warns once it has killed three jobs in a row (or the last three jobs all died
at the deadline).

1. Run the named phase in the foreground, without the job deadline:
   `gbrain dream --phase <name>` (for example `gbrain dream --phase embed`).
2. Give the job more time if your brain needs it:
   `gbrain config set autopilot.global_maintenance_timeout_ms 3600000`, or set
   `GBRAIN_GLOBAL_MAINTENANCE_TIMEOUT_MS` in the autopilot service environment
   (the variable wins over the config key; values below 60000 are ignored).
   Unset both to return to the default.
3. Confirm with `gbrain doctor`: `global_maintenance_timeouts` is `ok` after the
   next job finishes within its deadline.
## auto_chronicle has no effect

**Say to your agent:** *"Why aren't my meetings showing up as timeline events?"*

Automatic event extraction is on by default. See the
[Life Chronicle guide](life-chronicle.md) for what qualifies, the cost, the
three-step check, and the skip codes. `gbrain doctor` reports it as the
`auto_chronicle` check. To turn it off, run
`gbrain config set auto_chronicle false`.
