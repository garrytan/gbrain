# Troubleshooting

**Say to your agent first:** *"Run a brain health check and fix what you find"* — this routes to the maintain skill, which runs `gbrain doctor` and either auto-fixes or prints the exact repair command; your agent can run the whole loop (*"Get my brain health score to 90"* uses the remediation planner with a cost cap). The sections below are for when you want the manual path.

**Agents:** every gbrain error and refusal carries `code` and a `fix` whose `next` says who acts and whether to stop and ask. Follow the [agent operator protocol](../protocol/AGENT_OPERATOR_v1.md) first; `gbrain errors <code>` explains any code offline. This page covers symptoms that are not a single error.

## Symptom table

<a id="symptom-table"></a>

**Who acts**: *agent* runs it; *agent, after the user agrees* means relay the consent and stop first; *user* means the user runs it in their own terminal; *brain host* means the operator of the machine that runs the brain. **Consent** lists the effects (`paid`, `destructive`, `credentials`, `egress`, `persistent_install`) that need the user's agreement; "none" means the agent can just run it. **Verify** is always read-only.

| Symptom | Next step | Who acts | Consent | Verify |
|---|---|---|---|---|
| A withdrawal committed but a large page's file still shows the withdrawn row; writer status lists its mirror parked with [`segmented_mirror_writer_gate`](write-refusals.md#segmented_mirror_writer_gate), or an effect retrying with [`recovery_version_unsupported`](write-refusals.md#recovery_version_unsupported) (or `effect_unavailable` on v0.60.290.0) holds every write on the worktree | `gbrain upgrade` on the hosts the refusal or a doctor `segmented_storage` warning names (for `recovery_version_unsupported`, the owner host; doctor's information case, this host's own superseded pre-upgrade writes, does not hold the mirror), then restart their serve, sync and worker processes. A gated mirror resumes by itself once the older writes are 7 days old; never delete a recovery record or its staging file | brain host | none | `gbrain sources writer status --source <source> --json` shows no parked or retrying mirror |
| The dream cycle's purge phase fails every night with `managed_purge_failed` (`42P01`, relation `query_cache` does not exist), or doctor `schema_missing_tables` warns | upgrade (#6911: the purge skips a missing rebuildable cache), then preview recreating it: `gbrain repair missing-tables` ([missing tables](repair.md#missing-tables)); apply the printed `--apply --expect <hash>` command. Pages parked by the earlier failures: `gbrain pages purge-deleted --retry-parked --dry-run`, then without `--dry-run` | agent, after the user agrees | `destructive` (the parked-page retry purges them) | `gbrain doctor --only schema_missing_tables --json` reports ok |
| A managed source's autopilot freshness `sync` jobs each land about one page, or `sources status` says `parked` while a sync job runs | upgrade (#6706: sync jobs drain to their deadline and count as the source's live drain), then restart `gbrain jobs work` / the supervisor so the worker loads the handler; a job result with `incomplete: true` names its follow-up (`continuation_job_id`) or the next step in `next` | agent | none | `gbrain sync status --source <id> --json` shows `live_job_id` or a cursor at `done`; `gbrain jobs get <id> --json` shows `outcome` |
| A classic `gbrain sync` with pull returns `partial` / `pull_failed` on every run after the upstream was force-pushed, and doctor `sync_failures` names `upstream_rewritten`, `upstream_unknown` or `upstream_diverged` | follow the check's `fix` ([upstream rewritten](#upstream-rewritten)): `upstream_diverged` runs `gbrain git commit-push --pull --path <checkout>`; `upstream_rewritten` and `upstream_unknown` preview `gbrain sources reset-upstream <id> --expect-local <sha> --expect-upstream <sha> --dry-run`, then run it without `--dry-run`; then `gbrain sync --source <id>` | agent; the reset after the user agrees | `destructive` (the reset; the old history is kept under a backup ref) | `gbrain doctor --only sync_failures --json` no longer names the source |
| Doctor `sync_freshness` says a source has "no successful sync recorded" or "first sync running" | follow the check's `fix`: `first sync running` (code `sync_first_run_in_progress`, warn) means wait; `no successful sync recorded` (code `sync_no_successful_sync`, fail) names the last attempt and its `reason`: wait for a queued job, inspect holds (`gbrain sync status --source <id> --json`), or retry (`gbrain sync --source <id>`) ([details](#sync-freshness-no-successful-sync)) | agent | none | `gbrain doctor --only sync_freshness --json` |
| Recall returns conversation facts like "Date said …", "Attendees said …" or "Summary said …" | `gbrain repair conversation-labels` previews them ([conversation labels](repair.md#conversation-labels)); apply the printed command with `--yes` | agent, after the user agrees | `destructive` | `gbrain doctor --only conversation_label_facts --json` is ok |
| Conversation facts are dated 1970-01-01 | same preview: `gbrain repair conversation-labels` (an undated page's pre-fix facts carry a `segment 1970-01-01` context); add a `date:` to the page frontmatter before re-extracting it | agent, after the user agrees | `destructive` | `gbrain doctor --only conversation_label_facts --json` is ok |
| `remember` or `put_page` refused `source_changed` "The canonical file contains an uncoordinated local edit" on many pages nobody edited, or doctor `lost_caller_writes` warns | upgrade to v0.60.157.0 or later (a database-only v0.13.1 `validate: false` stamp was read as a file edit, #6429); then `gbrain repair failed-writes --source <id>` previews the refused writes and prints the apply command ([failed writes](repair.md#failed-writes)) | agent; the apply after the user agrees | none to preview | `gbrain doctor --only lost_caller_writes --json` is ok |
| A write (`add_timeline_entry`, `put_page`, `remember`, any `mutating` tool) refused `invalid_params` "unknown parameter … write operations always reject unknown parameters; nothing was written" | the call named a parameter the tool does not declare (for example `content` instead of `detail`); the `suggestion` names the submitted key and the declared one; resend with the declared name. Reads keep the `mcp.strict_params` warn grace period | agent | none | the resent call returns no `invalid_params` and no `unknown_param` warning |
| `gbrain config set chat_model` (or `expansion_model`) printed `[config] WARN: … outranks it, so the model in use does not change`, or its `--json` says `effective: false` | the value is stored in the database, but `shadowed_by` names what wins at runtime (never its value): a `models.*` key (`gbrain config unset <that key>`, after asking: it may select other models too), an environment variable (`GBRAIN_MODEL`, `GBRAIN_CHAT_MODEL`, `GBRAIN_EXPANSION_MODEL`: the user removes it from their shell profile or service environment), or the `config.json` pin (`gbrain config unset chat_model --file` removes only the pin) | agent for the config changes, after the user agrees; user for an environment variable | none | `gbrain config get chat_model` reports `source: db plane`, and a repeat `config set … --json` says `effective: true` |
| Facts extraction or embedding reports `(cause=AIConfigError model_not_found)` or `gbrain models doctor` says `model_not_found` while the key is valid | the provider refused the model, not the key (a 404, or a 403 "project does not have access to model"): the fix text names the config key that selected the model when the gateway knows it ("Selected via models.tier.reasoning. Fix: gbrain config set …"; an env var or config.json pin says what to clear); otherwise check the model id with `gbrain models`, enable the model for the project in the provider console or set another model (`gbrain config set models.facts <provider:model>`) | user (provider console); agent for the config change, after the user agrees | none | `gbrain models doctor` reports the model `ok` |
| Doctor `links_extraction_lag` or sync says "N page(s) have un-extracted edges" | `gbrain extract --stale --dry-run --json`, then on the host `gbrain extract --stale --catch-up [--source-id <id>]` | user above 120 s, else agent | none | dry run: `actionable: 0` |
| Doctor `links_extraction_lag` says "N page(s) failed link extraction 3 runs in a row and are held", or `extract --stale` lists failed pages | Read each page's code (`unknown_source`: the page's source row is gone; restore the source or delete the page), fix the cause, then `gbrain extract --stale [--source-id <id>] --retry-held` | agent | none | `gbrain extract --stale --dry-run --json`: `held: 0` |
| `gbrain apply-migrations --yes` or `gbrain upgrade` stops with `Migration <N> … exhausted retries` / SQLSTATE 57014 and the schema stays behind (`migrations_pending`, reason `still_behind`) | upgrade first (#7108: long backfills run in committed batches), then follow the error's or doctor `schema_version`'s `fix` ([migration statement timeout](#migration-statement-timeout)) | agent; a longer `--statement-timeout` or ending a session only after the user agrees | none for a rerun | `gbrain doctor --only schema_version --json` |
| A gbrain call failed with a code you don't recognize | follow `fix.next` ([protocol](../protocol/AGENT_OPERATOR_v1.md)); `gbrain errors <code>` | agent | as the fix's `consent` | the fix's `verify` |
| A graph read omits a relationship you know existed, or says someone still works somewhere they left | the default read returns relationships true today: repeat with `status: "all"` or `as_of`; to record an end, add a dated timeline line (`Ended works_at [[companies/x]]`) or `add_link ... valid_until` ([temporal edges](temporal-edges.md)) | agent | none | `gbrain doctor --only edge_validity --json` |
| A command exited 3 (`confirmation_required`) | relay `user_message`; run `fix.command` only after the user agrees | agent, after the user agrees | the payload's `effects` | the fix's `verify` |
| A scheduled job, workspace script or hook finds nothing in the brain (every lookup empty), or its log shows `no_brain` or `GBRAIN_DB_ACCESS no_url`, while the same command works by hand | the job runs without the brain's config: call gbrain through one wrapper that sets `GBRAIN_HOME` and loads the brain's env file, and stop discarding its stderr ([the wrapper](cron-schedule.md#calling-gbrain-unattended)); `gbrain doctor --only cron_gbrain_home --json` names crontab lines that skip it | agent | none | the job's log shows results, and `gbrain engine status --json` run through the wrapper names the expected `db_url_source` |
| `gbrain sources refresh` refuses `refresh_not_owner` from cron or a script but works by hand | the caller resolves another gbrain home, so it is another host; the refusal names the identity file, `HOME` and `GBRAIN_HOME` it read. Set the owner's `GBRAIN_HOME` in the wrapper (not `HOME`, which also swaps git credentials); never copy or delete a `host.json` | agent | none | `gbrain sources refresh <id> --dry-run` through the wrapper |
| `gbrain sources refresh` refuses `refresh_diverged` on every run | something commits into the managed checkout outside gbrain, usually a script that writes files and runs `git commit` without pushing. `git log @{upstream}..HEAD` names the commits; move that writer to `gbrain git commit-push -- <paths>`, then publish the stray commits merged with the upstream (`gbrain git commit-push --push-only --keep-checkout --path <checkout>`) and retry, as the [refusal](write-refusals.md#refresh_diverged) says; never force ([scripts and the managed checkout](shared-checkout-git.md#scripts-and-the-managed-checkout)) | agent; reconciling after the user agrees | `destructive` when reconciling drops local commits | `gbrain sources refresh <id> --dry-run` |
| A `--json` caller fails to parse gbrain's output | something other than gbrain wrote to stdout, usually a wrapper or a hook it runs; send that output to a log file or stderr (gbrain's own notices already go to stderr) | agent | none | the same call piped to `jq .` parses |
| gbrain calls time out from a script or language runtime but finish by hand, or each search takes several seconds | a cold CLI start takes 3–6 s on a pooled Postgres brain: set caller timeouts of at least 10 s in both the shell and the runtime (a runtime exec timeout can override the shell's), and turn on the [warm CLI socket](cli-socket.md). If warm searches stay slow, measure the round trip to the database; one in another region dominates search time | agent; moving the database after the user agrees | none | `GBRAIN_DEBUG=1 gbrain search <query>` prints a `[cli-socket] warm:` line |
| After a database change some processes still use the old server, or a URL variable silently keeps its old value | a shell-sourced env file has an unquoted `&` (the assignment ends there), or a process kept the environment it started with. Quote every value, keep Postgres URLs to `?sslmode=require` (driver options as variables, such as `GBRAIN_PREPARE=false`), update every URL variable the tooling reads, restart every gbrain process, and prove the switch from the database side ([switching a database](../../INSTALL_FOR_AGENTS.md#switching-a-database)). Never paste `env` output into a transcript while debugging | agent, after the user agrees | none | a row written after the restart appears on the new server |
| Doctor `parked_effects` lists `git_target_ignored` effects | a `.gitignore` rule excludes those pages' files, so their Git effects cannot commit. The user decides: un-ignore (narrow the rule, commit it, then `gbrain sources writer retry-effects <source> --parked-code git_target_ignored`) or keep the pages database-only and leave the effects parked ([gitignored paths](shared-checkout-git.md#scripts-and-the-managed-checkout)) | agent, after the user decides | none | `gbrain sources writer status --source <id> --json` |
| Sync and the maintenance cycle re-read a whole source on every run after its Git history was rewritten (force-push, `git filter-repo`) | the recorded base commit no longer exists. Move the checkout onto the new history ([upstream rewritten](#upstream-rewritten)); before the next rewrite, run `gbrain sources set-sync <id> off` and `gbrain sources mirror-readonly <id>` first | agent; the reset after the user agrees | `destructive` (the reset keeps a backup ref) | `gbrain doctor --only sync_failures --json` |
| [Database unreachable or `GBRAIN_DB_ACCESS <reason>`](#database-unreachable) | `gbrain engine status --probe`, then `gbrain db-repair` (diagnose); `gbrain db-repair --yes` applies safe fixes | agent; `--yes` after the user agrees | none to diagnose; `--apply-rewrites` rewrites the config URL (undoable) | `gbrain engine status --probe --json` |
| [PGLite `RuntimeError: Aborted()` at startup](#pglite-aborted) | automatic repair on the next command; else `gbrain pglite-repair --dry-run`, then `gbrain pglite-repair --yes` | agent; `--yes` after the user agrees | `destructive` (a WAL backup is kept and the restore command printed) | `gbrain doctor --only connection --json` |
| [`expected N dimensions, not M` on import](#embedding-dimensions) | `gbrain doctor` prints the exact `gbrain config set …` or `gbrain migrate embeddings --to <provider:model>` command | agent, after the user agrees | `migrate embeddings`: `paid`, needs the brain's writer lock | `gbrain doctor --only embeddings,embedding_width_consistency --json` |
| [Keyword-only recall; the user wants semantic search](#embedding-dimensions) | the readiness fix: `gbrain init --force --embedding-model <provider:model> --path <brain path>` (keeps pages and facts) | agent, after the user agrees | `credentials`, `paid`; needs the brain's writer lock | `gbrain doctor --only embeddings --json` |
| [Doctor residue (`timeline_history`, `derived_visibility`, `safe_index_pending`)](#doctor-residue) | preview `gbrain doctor --remediation-plan --json` or `gbrain repair`; then `gbrain repair <kind> --apply` | brain host, after the user agrees | `destructive` (rewrites derived rows) | `gbrain doctor --only timeline_history,derived_visibility,safe_index_pending --json` |
| Low health score | preview `gbrain doctor --remediation-plan --json`; then `gbrain doctor --remediate --yes --target-score 90 --max-usd 5` | agent, after the user agrees | `paid`; `destructive` with `--include-repairs` (approve with `--expect <plan_hash>` from the preview) | `gbrain doctor --json` |
| [Sync held a file (`Held <path>: invalid_frontmatter …`, `git_held_files`)](#held-files) | `gbrain sources status <id>`, then preview `gbrain repair frontmatter --source <id>` and apply the printed `--apply --expect <hash> --yes` | agent; the apply after the user agrees | `destructive` (rewrites the previewed lines of the files) | `gbrain doctor --only git_held_files --json` |
| [Sync held a file for its facts or takes fence (`Held <path>: invalid_fence …`)](#held-fence-files) | nothing for most holds: the next maintenance run repairs and commits the fence. To see or do it now, preview `gbrain repair fences --source <id>` and run its printed `--apply --expect <hash>`; to pause automatic repair, `gbrain config set fences.repair.enabled false` (ask the user first). A `manual` reason needs the edit the hold names | agent; the apply needs no extra consent | none (model repair spends within the `fences.repair.*` caps; raising them is `paid`, the user's call) | `gbrain doctor --only fence_integrity --json` |
| A managed catch-up on a live checkout keeps dying (`revision_conflict`, `pinned_git_worktree_conflict`, `page_identity_changed`, `write ECONNABORTED`), or you want an agent to drive the recovery | `gbrain sync status --source <id> --json` (cursor, `committed_last_10m`, each hold and the last error with `class` / `safe_actions` / `needs_human`); when nothing moved and `needs_human` is false, `gbrain sync unblock --source <id> --apply`, then the sync it prints ([runbook](sync-unblock-runbook.md)) | agent; a person only when `needs_human` names a slug | none | `gbrain sync status --source <id> --json` |
| [Every write on a source stays pending; writer status shows a request `recovering` with `unexpected_file_bytes`](repair.md#stuck-recovery) | preview `gbrain repair stuck-recovery --source <id>` on the owner host, show the user the diff it prints, then run the choice they pick: `--keep prior` or `--keep disk` with `--apply --expect <hash> --yes`; never delete the file to unblock it | agent; the apply after the user picks a version | `destructive` (both versions are backed up first) | `gbrain sources writer status --source <id> --json` shows no recovering request |
| [Sync held a file with `worktree_dirty`](#worktree-dirty-hold) | commit (or restore) the file, then `gbrain sync unblock --source <id> --apply` and the sync it prints | agent; whoever edits the file commits it | none | `gbrain sources status <id> --json` |
| A managed sync of a source far behind HEAD prints `staged catch-up: synced to <commit>, short of HEAD`, or `sliced catch-up: committed the <phase> slice of <commit> through <path>` | Staging is automatic: `gbrain sync --source <id> --no-pull` takes stage after stage (each the furthest first-parent commit whose delta fits 100,000 entries and 16 MiB) until it reaches HEAD, and a stop resumes at the stored cursor; a scheduled sync takes one stage per run. A first sync, a `--full` sync or one commit that alone exceeds the bound is cut into path slices instead (#6349): every import slice, then bounded deletion slices, pinned at one target; `last_commit` moves only when the last slice settles, and the same command resumes an unfinished target at its stored slice. Only one file whose manifest entry alone exceeds the byte bound still refuses `request_too_large`, naming it; exclude it (`--exclude`, or `gbrain config set sync.exclude`) and rerun | agent | none | `gbrain sync status --source <id> --json` (cursor target reaches HEAD) |
| A write, sync, connector run or activation refuses `storage_error` with `requires exactly one known boolean persistence state` (`detail: persistence_mode_unknown`) | The `persistence_brain` singleton is missing, duplicated or malformed, so gbrain cannot tell whether the brain is managed and refuses instead of writing around the owner (#6482). Run `gbrain sources writer status --probe --json` on the brain host (it reports `mode: unknown` and the problem instead of refusing), restore the one row (`gbrain doctor --json` names the repair), then rerun the command | host operator | none | `gbrain doctor --json` |
| [Doctor warns `persistence_terminal_failures`, or `gbrain sync status` shows `terminal write failures` with BLOCKING or unresolved rows](#terminal-write-failures) | run the check's `fix.command`; for the pile, `gbrain sources writer failures <id> --group-by category` and each group's drill-down; `gbrain write-request <request> --json` names one receipt's `diagnosis.fix` | agent; a group whose `needs_human` is true after the user decides | none to inspect; as the fix's `consent` | `gbrain doctor --only persistence_terminal_failures --json` is ok |
| The drain stopped `connection_lost` | check the database and pooler (`gbrain doctor --json`), then rerun the same sync; it resumes at the stored cursor | agent | none | `gbrain sync status --source <id> --json` |
| [Managed catch-up stuck, or `Held <path>: preparation_stalled`, or the drain stopped `preparation_abandoned` / `preparation_systemic` / `write_capacity`](#catch-up-stuck) | `gbrain sources writer status --source <id> --json` (what the stuck write was doing: step, `waiting_on`, owner, version), fix what it names or upgrade the owner, then `gbrain sources retry-held <id>` and the same sync with its options | agent; a restart or upgrade of the owner after the user agrees | none to inspect; `persistent_install` when the fix restarts a service | `gbrain sources status <id> --json`, then `gbrain doctor --only git_held_files,persistence_write_stall --json` |
| [The catch-up is parked: `data_moving: false`, doctor `managed_sync_not_moving`, or `gbrain sources writer movement` exited 1](#managed-sync-not-moving) | `gbrain sources status <id> --json` prints the exact writer-status command; run it: `gbrain sources writer status --source <id> --json` ends each running claim in a `claim.next` (`claim_running`: rerun after `retry_after_ms`; `claim_overdue`: `tell_user_to_run`, restart the named owner pid) | agent; the restart after the user agrees | none to inspect; `persistent_install` when the fix restarts a service | `gbrain sources writer movement <id>` (exit 0 when the data moves again), then `gbrain doctor --only managed_sync_not_moving --json` |
| [The drain stopped `drain_stalled` with `cause: owner_wedged_here`](#managed-sync-not-moving) | before the ceiling: wait `retry_after_ms`, then rerun `next.command` (`safe_to_loop` is true); past it: restart the owner process the stop names (`gbrain serve`, the jobs worker or autopilot), then `gbrain sources retry-held <id>` and the same sync | agent; the restart after the user agrees | none to inspect; `persistent_install` when the fix restarts a service | `gbrain sources writer status --source <id> --json` (the claim is gone or publishing), then `gbrain sources writer movement <id>` |
| [A managed sync run is blocked: doctor `managed_sync_blocked`, a freshness `sync` job ended `dead`, or get_brain_health `sync_blocked` is not `none`](#managed-sync-blocked) | `gbrain sync status --source <id> --json` names the page the run stopped on, its fault class and its exit (a hold to reconcile, a repair to preview, or the resume command); `gbrain jobs get <id> --json` shows the same `next` in the dead job's progress | agent; a reconcile or repair apply after the user agrees | the step's own consent | `gbrain doctor --only managed_sync_blocked --json` is ok, and the next freshness job ends `completed` |
| [Doctor warns `two_consumers_on_host`](#two-consumers-on-host) | `gbrain sources writer status --json` lists the consumers alive on this host (`host.consumers`: pid, kind, mode, age); let the shorter-lived one finish (a `gbrain sync` run ends on its own) or restart it so it defers to the resident one | agent; a restart after the user agrees | none to inspect | `gbrain doctor --only two_consumers_on_host --json` |
| [Doctor warns `consumers_without_heartbeat`](#consumers-without-heartbeat) | upgrade and restart the process whose pid and kind the check names (it predates the heartbeat table and never defers) | brain host, after the user agrees | `persistent_install` when it rewrites services | `gbrain doctor --only consumers_without_heartbeat --json` |
| [Doctor warns `serve_build_drift`: serve is running an older build than this checkout](#serve-build-drift) | restart serve with the command the check prints (`systemctl --user restart gbrain-serve.service`, `launchctl kickstart -k gui/<uid>/com.gbrain.serve`, or stop the named pid and start it again), then restart each other listed worker | brain host, after the user agrees | none | `gbrain doctor --only serve_build_drift --json` is ok |
| [Doctor fails `runtime_build_skew`: serve, the jobs supervisor, workers and job children run different builds](#runtime-build-skew) | `gbrain upgrade --restart-only` restarts every listed process onto the installed build and verifies one build runs; it refuses with the exact step for a process it cannot restart (the check also prints the manual restart) | brain host, after the user agrees | none | `gbrain doctor --only runtime_build_skew --json` is ok |
| [Doctor warns `host_identity_mismatch`, or maintenance jobs report `owner_unavailable` / `host_mismatch` for weeks](#host-identity-mismatch) | set `GBRAIN_HOME` on that process's supervisor to the value the check prints (the owner's home; config appends `.gbrain` itself) and restart it; never edit or delete a `host.json` | brain host, after the user agrees | `persistent_install` when it rewrites a service definition | `gbrain doctor --only host_identity_mismatch --json` |
| [`fence_repair` or chronicle refused `owner_unavailable`, reason `host_mismatch`](#owner-unavailable) | `gbrain sources writer status --source <id> --json` on the brain host (the owner host id); run the step there, or give the worker and the shell one `GBRAIN_HOME`. Never copy or regenerate `host.json`. Do not retry from the same host | brain host | none | `gbrain sources writer status --source <id> --json` shows this host's id as the owner |
| [`owner_unavailable`, reason `transfer_in_progress` or `clone_in_progress`](#owner-unavailable) | wait 30 s and retry the same step; the worktree is draining for a writer transfer or recovering from a topology clone | agent | none | `gbrain sources writer status --source <id> --json` shows state `active` |
| [A page write refused `owner_unavailable`, detail `unbound_source`, on a classic Postgres brain](write-refusals.md#unbound-sources-on-postgres) | don't retry; write the page as `<slug>.md` in the source's checkout, commit it, and run `gbrain sync --source <id>` (a remote agent gives those steps to the user); database-only pages or managed mode are the user's choice | agent, after the user agrees (remote: user) | none | `gbrain get <slug> --source <id>` |
| [`owner_unavailable`, reason `binding_missing`, `incarnation_changed`, `local_path_missing` or `coordination_path_missing`](#owner-unavailable) | `gbrain sources writer status --source <id> --json`; the registration is missing or outdated and re-binding or re-registering the checkout is the host administrator's decision | brain host | none | the same status read shows an active binding for this host |
| Background work (autopilot, jobs, connector syncs) refused `owner_unavailable` "Background writes to source <id> are paused: its canonical owner could not be verified" or "its worktree is recovering" | run the fix, `gbrain sources writer status --source <id> --json`, which names what the source waits on; a deleted owner marker (`.gbrain-owner.json`) is repaired by a writer self-transfer, the user's decision. Nothing was submitted and no request id was used; interactive writes are unaffected | agent; the self-transfer after the user agrees | none to inspect | the same status read shows an active binding; the next background run admits |
| Doctor warns `purge_parked_pages` | a park an older gbrain wrote is retried once by the next purge run after an upgrade and is not counted; for the rest, fix the cause each page's last error names, preview `gbrain pages purge-deleted --retry-parked --dry-run --json`, then with the user's agreement run `gbrain pages purge-deleted --retry-parked --yes` | agent, after the user agrees | `destructive` | `gbrain doctor --only purge_parked_pages --json` |
| [`gbrain repair fences` skipped a file `sync_in_progress` while a sync runs](repair.md#fence-repair-during-a-sync) | nothing: a write in flight or the running sync's frozen manifest still names that file; every other candidate repairs now and the next run picks this one up (`gbrain sync --source <id> --no-pull` finishes the sync) | agent | none | `gbrain doctor --only fence_integrity --json` |
| [A Google or GitHub item is held (`connector_held_items`)](#held-connector-items) | `gbrain sources status <id>`, fix the cause, then `gbrain sources retry-held <id>` and `gbrain sync --source <id>` | agent, after the user agrees | `egress` (fetches from the provider again) | `gbrain doctor --only connector_held_items --json` |
| `gbrain google status` exits 1 naming `calendar_unreadable`, doctor warns `google_calendar_readable`, or the sync log prints `[google] calendar_unreadable` (calendar pages stop arriving) | `gbrain google calendars --account <email>` lists the calendars the account can read; then `gbrain sources set-calendar <source> <calendar-id>` and `gbrain sync --source <source>` ([unreadable calendar](google-connect.md#unreadable-calendar)) | agent, after the user agrees which calendar | none (on a managed brain whose source also syncs Gmail or Contacts, the change re-reads their history: `confirmation_required`, re-run with `--yes` after the user agrees) | `gbrain doctor --only google_calendar_readable --json` is ok |
| `gbrain google setup` stops with `api_access_blocked`, `gbrain google status` exits 1 listing `api_access.problems`, or doctor warns `google_api_access` (a Google API disabled for the OAuth project, or a scope not granted) | enable each API at the link the report names (the Google Cloud project is in the report), or `gbrain google connect --reauth <email>` for a missing scope; then `gbrain sync --source <source>` ([API access](google-connect.md#api-access)) | user (only the project owner can enable an API) | none | `gbrain google status --json` shows no `api_access.problems` |
| `gbrain waiting` lists bank, payment or shipping alerts as people waiting on you | upgrade (#5012: mail with `Precedence: bulk/list/junk`, a `List-Id` or a no-reply `Reply-To` opens no reply-owed loop); for loops opened before the upgrade, `gbrain waiting` prints `gbrain loops drop sender <email> --source <id> --dry-run` per sender; preview, then run it without `--dry-run` (cannot be undone), or `gbrain loops mute sender <email>` for a reversible stop ([open loops](open-loops.md#the-surfaces)) | agent, after the user agrees | none to preview | `gbrain waiting --json` no longer lists the sender |
| [`gbrain migrate --to` refused with `writer_coordinator_required`](../ENGINES.md#engine-migration-refused) | follow the refusal's `fix`: relay its `user_message` (stay on PGLite and share with `gbrain mcp expose`, or leave the brain as it is) | agent, after the user agrees | `persistent_install`, `egress` (for `gbrain mcp expose`) | `gbrain doctor --no-migrate --json` |
| [A write was refused with a named reason](#write-refused) | the reason's recovery in [write refusal reasons](write-refusals.md) | as the refusal's `fix` | as the refusal's `fix` | the refusal's `verify` |
| [`gbrain sync` refused `managed_sync_flag_refused`](write-refusals.md#managed_sync_flag_refused) | rerun the same command without the flag `detail` names (`--skip-failed` or `--include-gitignored`); fix a failed file and rerun the plain sync (`--retry-failed` is a deprecated alias), or commit an ignored file | agent | none | `gbrain sources status --json` |
| [Sync with the deprecated `--retry-failed` alias says failures "belong to a run with different sync options"](#retry-other-options) | run the command printed on each line: `resumable (replay …)` or `resumable (fresh discovery …)` reruns under the failed run's options, `safely orphaned` previews `gbrain repair managed-sync-orphans --source <id>` (apply with its hash), `unresolved` names what has to finish first | agent; the repair apply after the user agrees | the repair retires bookkeeping rows only | `gbrain sync status --source <id> --json` |
| [Managed sync blocked with `checkpoint_validation_timeout`](#checkpoint-validation-timeout) | `gbrain repair request-indexes --apply` when an index is missing or INVALID, then the printed `gbrain sync --source <id> --no-pull …` | brain host | none | `gbrain doctor --only persistence_request_indexes --json` |
| Writes fail with `connection_inherited_read_only` (SQLSTATE 25006) | [reset the pooler's server connections, stop session-level `SET`, check role defaults](write-refusals.md#connection_inherited_read_only) | brain host | none | `gbrain doctor --json` |
| [Doctor warns `persistence_session_timeouts` (`session_timeouts_not_applied`)](#session-timeouts-not-applied) | `ALTER ROLE <gbrain role> SET statement_timeout = '5min'` on the database, or accept it: preparation reads carry their own bound | brain host | none (a role default; `destructive` only in that it changes a server setting) | `gbrain doctor --only persistence_session_timeouts --json` |
| `gbrain init` or `gbrain upgrade` stops with `schema_lock_blocked` naming a pid (or, before #5227, sat in `wait_event_type=Lock` with no output) | let the named session finish, or with the user's agreement end it on the database host: `SELECT pg_terminate_backend(<pid>)`; then rerun the same command ([ENGINES.md](../ENGINES.md#schema-lock-blocked)) | brain host, after the user agrees | `destructive` when it ends another session | the rerun completes; `gbrain doctor --json` shows the schema at head |
| [`queue_capacity`, `persistence_capacity` or `persistence_request_growth`](#write-capacity) | run the printed `gbrain config set persistence.limits.<limit> <value>` | brain host | none | `gbrain doctor --only persistence_capacity,persistence_request_growth --json` |
| [`dream_paid_loop`, or dream keeps skipping one transcript](#dream-paid-loop) | fix the cause, then `gbrain dream reset-key --list` and `gbrain dream reset-key '<key>'` | agent, after the user agrees | `paid` (the key is retried) | `gbrain doctor --only dream_paid_loop --json` |
| [A page exists (`gbrain get <slug>` returns it) but search never finds text from it](memory-boundaries.md#large-pages) | `gbrain reindex --oversized --dry-run --json` lists pages stored before the upgrade with a size-based `embed_skip` marker (without `--dry-run` it keyword-indexes them, free); a page above an operator-lowered `content_sanity.bytes_block` keeps its marker until it is raised; a page the content-quality gate quarantined shows in `gbrain quarantine list` (`gbrain quarantine clear <slug>` re-checks it once the user agrees); a file over the 24 MiB page ceiling was never stored ([`file_too_large`](write-refusals.md#file_too_large)). Its chunks waiting for embedding approval (doctor `partial_embedding`) are a paid step: `gbrain embed --held --dry-run`, then `gbrain embed --held --source <id> --max-usd <N>` as printed | agent for the reindex; the user decides embedding spend, a `bytes_block` change and a quarantine clear | none for the reindex; `paid` for `gbrain embed` | `gbrain reindex --oversized --dry-run --json` lists nothing; `gbrain search "<phrase from deep in the page>"` returns the page |
| [Search answers look keyword-only on a large Postgres brain](#hybrid-search-returns-only-keyword-hits) | read doctor's `vector_plan`; run the index command it prints | brain host | none | `gbrain doctor --only vector_plan --json` |
| [Broad keyword queries take about 8 s and come back vector-only (`keyword_arm_failed`, or `skipped_after_timeout` for 10 minutes after a timeout) on a large Postgres brain](#keyword-search-times-out-on-a-large-postgres-brain) | read doctor's `keyword_plan`; narrow with `--source-id`, or raise `search.keyword_statement_timeout_ms` on the brain host and restart the serving process | brain host | none | `gbrain doctor --only keyword_plan --json` |
| A second `gbrain serve` cannot open the brain | the readiness `harness_wiring` fix: every session shares one `gbrain serve --http` | user | `persistent_install`, `credentials` | `gbrain doctor --only harness_wiring --json` |
| `harness_wiring` reports `http_serve_unreachable` or `http_serve_unhealthy` for an HTTP registration | nothing automatic: doctor probed the registered `/health` without credentials and the endpoint did not answer as a healthy gbrain server; check the URL in the harness config and the server it points at (a hosted brain is its operator's). A `wired_running` verdict with `mcp_access: unverified` proves a listener only: confirm tools in a new session | user | none | `gbrain doctor --only harness_wiring --json` |
| A tool the fix names is missing after a serve recovered | restart the gbrain MCP server in the harness, or start a new session ([why](../protocol/AGENT_OPERATOR_v1.md#tool-catalog-changes-toolslist_changed)) | user | none | list the tools again |
| A command waits on stdin with no terminal | close stdin (`</dev/null`) or set `GBRAIN_NON_INTERACTIVE=1`; prompts then decline | agent | none | re-run the read-only part of the command |
| [An outdated build (brainstorm `judge_failed`, lost tags, Windows `ENOTFOUND`)](#outdated-build) | `gbrain upgrade`, then the steps in [recover after upgrading](repair.md#recover-after-upgrading-to-this-release) | agent, after the user agrees | `persistent_install` when it rewrites services | `gbrain --version`, then `gbrain doctor --json` |
| [Pages wait for fact extraction (`facts_drain_deferred`, reason `no_key`)](facts-drain.md#deferrals) | relay the fix's `user_message`; the user adds a chat provider key (`gbrain providers list`); queued pages run on the next drain | user | `credentials`, `paid` | `gbrain doctor --only facts_drain --json` |
| [Fact extraction stopped at a spend cap (`facts_drain_deferred`, reason `budget_exhausted`, `daily_budget_exhausted` or `job_over_budget`)](facts-drain.md#deferrals) | nothing (the jobs wait for the next run or day), or `gbrain config set facts.drain_budget_usd <usd>` / `facts.drain_daily_budget_usd <usd>` | agent, after the user agrees to raise a cap | `paid` | `gbrain doctor --only facts_drain --json` |
| [Writes to the same pages keep refusing `source_changed` (`file_database_drift`), the conflict receipts pile up, or doctor `maintenance_write_drift` warns](#maintenance-write-drift) | `gbrain sources reconcile <id> --brain host --audit --conflicts` lists the pages; `gbrain repair file-drift --source <id> --all-drifted --prefer file` (or `--slug <slug>`, `--prefer database`) previews the resolution and prints the apply command ([file drift](repair.md#file-drift)) | agent; the apply after the user agrees | none to preview | `gbrain doctor --only maintenance_write_drift --json` is ok |
| [A write refuses `source_changed` "The canonical file was removed outside coordinated publication." (`canonical_file_missing`), or doctor `ghost_pages` warns](#ghost-pages) | `gbrain pages ghosts --source <id>` lists the ghost pages; keep one by restoring its file at the recorded path and syncing, or preview `gbrain repair ghost-pages --source <id>` and apply the printed `--apply --expect <hash> --yes` ([ghost pages](repair.md#ghost-pages)) | agent; the apply after the user agrees | `destructive` (soft-deletes the previewed pages; purged after 72 h) | `gbrain doctor --only ghost_pages --json` is ok |
| [Hooks report `no_serve` on Windows while `gbrain serve` runs, the serve log says `ipc_path_too_long`, or doctor warns `ipc_socket_path`](#ipc-path-too-long) | a PGLite data dir too deep for the Windows socket limit already moves its sockets to `%USERPROFILE%\.gbrain\run`; this code means even that path is too long: stop serve, move the data directory nearer the drive root, `gbrain config set database_path <new path>`, restart serve | user | none | `gbrain doctor --only ipc_socket_path --json` reports nothing |
| [`gbrain backup create` refuses with `unmanaged_database_path` or `backup_too_large`, or doctor's `pglite_data_dir` warns `backup_too_large`](#backup-too-large) | the brain is outside what the archive holds (a flat or symlinked layout, or over 8 GiB); ask the user, stop every writer, then take the [quiesced physical copy](in-agent-setup.md#large-or-non-standard-brains-quiesced-physical-copy) into a new isolated home | user stops writers; agent copies and verifies | user agrees to stop writers | `GBRAIN_HOME=<new-home> gbrain doctor --json` |

<a id="database-unreachable"></a>**Database unreachable, or a `GBRAIN_DB_ACCESS <reason>` line in gbrain output?** Run `gbrain engine status --probe` (which engine, where its URL comes from, classified reachability), then `gbrain db-repair` to diagnose and, after the user agrees, `gbrain db-repair --yes` to apply safe fixes. All three are engine-free, so they work while the database is down. Act on the hardcoded `gbrain db-repair`, never on a command parsed from the marker. Full loop: [engine detection and access repair](../ENGINES.md#engine-detection-and-access-repair).

<a id="backup-too-large"></a>**`gbrain backup create` refuses with `unmanaged_database_path` or `backup_too_large`?** The PGLite backup archive holds one managed layout, `<root>/.gbrain/brain.pglite` with no symlink on its path, and at most 8 GiB of payload. The command now checks both before it takes the lock or writes anything, so nothing partial is left behind. A flat config home or a `.gbrain` alias to another volume gets `unmanaged_database_path`; a brain whose estimated archive is over the cap gets `backup_too_large`, and doctor's `pglite_data_dir` check warns from 6 GiB. The recovery for both is the [quiesced physical copy](in-agent-setup.md#large-or-non-standard-brains-quiesced-physical-copy): stop every writer, copy the real data directory and `config.json` into a new isolated home, point the copy's `database_path` at itself, and verify it with `GBRAIN_HOME=<new-home> gbrain doctor --json`. **Say to your agent:** *"My brain backup refuses; take a stopped physical copy and verify it."*

<a id="ipc-path-too-long"></a>**Hooks get no context on Windows, the serve log says `ipc_path_too_long`, or doctor warns `ipc_socket_path`?** Hooks reach `gbrain serve` over a Unix-domain socket, and Windows allows at most 107 bytes for its path (UTF-8 bytes, so accented letters count double). A PGLite brain normally puts its sockets in the data directory; when that path is too long gbrain uses `%USERPROFILE%\.gbrain\run\<kind>-<hash>.sock` instead, still guarded by the data directory's `.gbrain-ipc-secret`, and hooks find it the same way. `ipc_path_too_long` means even the profile path is too long. The serve log and `gbrain doctor --only ipc_socket_path --json` print the path, its byte count and the limit. Fix it by moving the brain: stop serve, move the data directory to a short path such as `C:\gbrain\brain.pglite`, run `gbrain config set database_path C:\gbrain\brain.pglite`, then restart serve. **Say to your agent:** *"My hooks can't reach gbrain serve on Windows; check the IPC socket path."*

<a id="held-files"></a>**Sync held a file (`Held <path>: invalid_frontmatter …`, doctor `git_held_files`, `get_page` shows `file_held`)?** The sync succeeded; only that file waits, and its page (if any) keeps its last good revision and refuses `put_page` until the file is repaired. Run `gbrain sources status <id>`, preview `gbrain repair frontmatter --source <id>`, and after the user agrees run the printed apply. A source a broken file blocked before upgrading recovers on its next sync (`gbrain sync --source <id> --no-pull` does it now). See [held files](repair.md#held-files).

<a id="held-fence-files"></a>**Sync held a file because of its facts or takes fence (`Held <path>: invalid_fence …`)?** Managed sync succeeded; only that file waits. The hold names the fence, section, row numbers, columns and reason, never a cell, and most holds clear by themselves: the maintenance run's `fence_repair` phase repairs the fence on the owner host and commits the file. To see the plan or do it now, run `gbrain repair fences --source <id>` (a read-only preview with no model call), then the apply command it prints; applying needs no extra consent. Model repair spends only within `fences.repair.max_usd_per_page` and `fences.repair.max_usd_per_day`; raising them, or pausing automatic repair with `gbrain config set fences.repair.enabled false`, is the user's call. A hold whose reason is `manual` needs a person: read the page (`gbrain get --source <id> -- <slug>`), edit only that fence in the file (not the frontmatter; `gbrain repair frontmatter` does not touch fences), commit, and run `gbrain sync --source <id> --no-pull`. A `prepare_time` hold was refused against stored rows (for example a takes row number a stored take already uses): fix it as its `fence.reason` says, and after a database-side fix run `gbrain sources retry-held <id>`. A source a fence blocked before upgrading recovers on its next sync. A fence with one obvious meaning is never held: sync rewrites it losslessly, commits the file and reports `fences_normalized`; a `fence_normalized` notice on a write means re-read the page before editing it. `gbrain doctor --only fence_integrity` counts every malformed fence still waiting (held, stored or unsynced) by tier. See [fence holds](write-refusals.md#invalid_fence), [fence repair](repair.md#fences) and the [fence format](fence-format.md).

<a id="concurrent-write-hold"></a>**Sync held a file with `concurrent_write`?** A Git edit raced a database-only write; nothing was overwritten. Preview `gbrain sources reconcile <id> <slug> --preview`, let the user choose, then `gbrain sources retry-held <id>`. See [concurrent_write](write-refusals.md#concurrent_write).

<a id="worktree-dirty-hold"></a>**Sync held a file with `worktree_dirty`?** The working tree holds uncommitted bytes for the file that match neither the pinned commit nor the page (an agent mid-edit on a live checkout), so sync held it instead of overwriting the edit and kept going; nothing is lost and the run finished. Commit the file (or restore it), then `gbrain sync unblock --source <id> --apply` re-screens every held file that is now committed and prints the sync to run; a later commit that changes the file re-screens it on its own. A file held three times is reported `needs_human` by `gbrain sync status`: find out what keeps editing it. Bytes committed at HEAD past the pinned target are imported as HEAD has them, never held. See [worktree_dirty](write-refusals.md#worktree_dirty) and the [sync unblock runbook](sync-unblock-runbook.md).

<a id="catch-up-stuck"></a>**Managed catch-up stuck (one write `running` for minutes while the rest waits), held N files as `preparation_stalled`, or the drain stopped with `preparation_abandoned`, `preparation_systemic` or `write_capacity`?** Every managed write's *preparation* has a deadline (`persistence.sync_preparation_ms`, default 120 s, for sync members; `persistence.maintenance_preparation_ms`, default 120 s, for maintenance writes; a hard ceiling `persistence.preparation_ceiling_ms`, default 600 s; `persistence.max_preparation_attempts`, default 2; all behind the `preparation_deadlines` write switch), so one stuck write is cut off at its budget, but a cut-off preparation that ignores cancellation keeps its root blocked until the ceiling (600 s from the claim's start), when the owner frees the root and the next claim holds the entry; the rest of the source keeps publishing meanwhile, and a sync beside such an owner prints `stalled <N>s on <step>` with the owner's pid and kind from the allowance to the ceiling instead of stopping. One wedge therefore costs up to ten minutes and one held file, never the run. The runbook branches on what you see; every command below is read-only unless it says otherwise, and the files themselves are never the problem in this branch. Start every branch with `gbrain doctor --only serve_build_drift --json`: on a warning, restart serve and its workers on this build first (see [serve build drift](#serve-build-drift)) and stop there until it reads ok.

1. **While it is stuck.** The progress line prints `stalled <N>s on <step>` instead of an ETA. Run `gbrain sources writer status --source <id> --json`: the blocked request's `claim.stall` names the step (`origin_check`, `knowledge_publication`, …), `waiting_on` (`git`, `fs`, `db`, `pool`, or an honest `unknown`), `step_age_ms`, the budget, and the owner process (kind, pid, gbrain version). An owner whose version predates this release never gives up: upgrade it and restart it (`gbrain serve`, the jobs worker or autopilot; the drain's own process ends with the drain). Otherwise wait out the budget: the write is released, retried once, then held. A release does not always free the root: a preparation that ignores cancellation holds its root barrier until the ceiling, and `writer status --json` ends the claim in a `claim.next` that says so (`claim_running` with `retry_after_ms` to the ceiling, or `claim_overdue` as `tell_user_to_run` naming the owner pid once the ceiling has passed or the owner reads `restart_required`).
2. **Held files (`preparation_stalled`).** `gbrain sources status <id> --json` lists them with the step each stalled on; no `gbrain repair` applies. After the cause is fixed (or gbrain upgraded), run `gbrain sources retry-held <id>` and then the same sync with the same options, which the hold's `fix` and `retry-held` print, for example `gbrain sync --source <id> --no-pull --no-embed`. If that sync still has a backlog, it finishes the backlog and then re-screens the scheduled files in the same run. Verify with `gbrain sources status <id> --json` (the held count drops) and `gbrain doctor --only git_held_files --json`. A held deletion keeps its page until that retry. A stalled hold also re-screens by itself when the gbrain version changes.
3. **The drain stopped `preparation_abandoned` (exit 0).** A preparation in the sync's own process was still running past its allowance (its budget plus 30 s) and cannot be cancelled in-process, so the sync exited to end it; `drain.stall.step` says where. Rerun `next.command` (`safe_to_loop` is true): the next pass holds the entry if it stalls again.
4. **The drain stopped `preparation_systemic` (exit 1).** Too many writes stalled in one run (more than `GBRAIN_SYNC_HOLD_ESCALATE_COUNT` / `GBRAIN_SYNC_HOLD_ESCALATE_PCT` of the run's screened imports, or five in a row with no page committed between), so the run stopped with one diagnostic instead of holding every file. `breaker` carries the rule, the counts and the last step. Inspect the writer as in step 1, fix the cause, then rerun the same sync: it re-freezes the stopped entry with a fresh request and re-screens the files that run held.
5. **The drain stopped `write_capacity` (exit 1).** Other writers' requests held the sync writer's outstanding-request cap (`persistence.limits.principal_outstanding`, default 100; on one host the CLI sync shares the `local_cli` principal with fact-fence adoption and `dream`) for the whole 30 s window, so the sync could not admit its next write. It waited and printed `waiting for write capacity (N outstanding of M)` first; nothing failed and the cursor is intact. `gbrain sources writer status --source <id> --json` lists the outstanding requests. Let them finish, or raise the cap (`gbrain config set persistence.limits.principal_outstanding 200`), then rerun the same sync. Reference: [drain stops](write-refusals.md#drain-write-capacity).
6. **A `put_page`, `remember` or maintenance write finished `preparation_stalled`.** Nothing is held: the receipt names the step. Read the writer as in step 1, then resubmit a foreground write under a new `request_id`; the next maintenance run submits its write again.
7. **A manual fence defect among the holds** (`invalid_fence`, reason `manual`, or `repeated_marker`) is a different branch: see [held fence files](#held-fence-files). `gbrain sources status` keeps the kinds apart and routes each to its own command.

Turning the `preparation_deadlines` switch off (`gbrain config set persistence.preparation_deadlines false`) restores the previous behaviour exactly: no deadlines on sync or maintenance writes, no attempt counter, no `preparation_stalled` holds. See [`preparation_stalled`](write-refusals.md#preparation_stalled), [managed sync drain stops](write-refusals.md#managed-sync-drain-stops) and the [timing knobs](live-sync.md#catching-up-a-large-backlog-on-managed-postgres).

<a id="held-connector-items"></a>**A Google or GitHub item is held after repeated failures (doctor `connector_held_items`, `gbrain waiting` says coverage is partial)?** Run `gbrain sources status <id>`, fix the cause, then after the user agrees run `gbrain sources retry-held <id>` and `gbrain sync --source <id>`. See [held items](google-connect.md#held-items).

<a id="retry-other-options"></a>**A sync (or the deprecated `--retry-failed` alias) lists failures that "belong to a run with different sync options"?** A managed retry resumes only the cursor its own options select; each other failure gets one line with its class and the command that settles it. `resumable (replay …)`: an unfinished run holds it, and the command resumes that run under its recorded options. `resumable (fresh discovery, not a replay …)`: no run holds it any more; the command starts a new run from HEAD under the failed run's options, which clears the failure when it completes. For a failure recorded before runs kept their options, the options are recovered only when an option set reproduces its cursor key exactly. `safely orphaned`: nothing current can resume it; preview `gbrain repair managed-sync-orphans --source <id>` and apply with the hash it prints. `unresolved`: its options were never recorded and nothing selects it; the line says what has to finish first (a request still in flight, or a current run whose completion lets the orphan repair retire it).

<a id="checkpoint-validation-timeout"></a>**A managed sync is blocked with `checkpoint_validation_timeout`?** Run the printed commands on the brain host: `gbrain repair request-indexes --apply` when an index is missing or INVALID, then the printed `gbrain sync --source <id> --no-pull …`. Doctor's `persistence_request_growth` warns before lifetime request IDs run out.

<a id="pglite-aborted"></a>**PGLite crashes at startup with `RuntimeError: Aborted()` (often right after a macOS upgrade)?** Not a macOS incompatibility — the OS-upgrade reboot killed gbrain mid-write and tore the data dir's WAL. gbrain repairs this automatically on the next command (data preserved, backup kept); if auto-repair is disabled or skipped, run `gbrain pglite-repair --dry-run` to diagnose and `gbrain pglite-repair --yes` to repair in place. Full recovery ladder (repair → rebuild → engine switch) in [`docs/ENGINES.md` — Troubleshooting: startup abort](../ENGINES.md#troubleshooting-startup-abort-runtimeerror-aborted) and [`docs/INSTALL.md`](../INSTALL.md#pglite-crashes-at-startup-runtimeerror-aborted).

<a id="embedding-dimensions"></a>**`gbrain import` fails with `expected N dimensions, not M`?** Run `gbrain doctor`. It will print the exact `gbrain config set ...` or `gbrain migrate embeddings` command to repair the mismatch (`migrate embeddings` re-embeds through the provider: effect `paid`, ask the user first). You should not need to delete `~/.gbrain`. Fresh `gbrain init --pglite` auto-detects your embedding provider from API keys: set `VOYAGE_API_KEY` (or `OPENAI_API_KEY` / another provider key) in the environment — or in `~/.gbrain/config.json`, which init also reads — before running init, or pass `--embedding-model <provider>:<model>` explicitly. With multiple keys set, init fires an interactive picker (non-TTY auto-picks the Voyage default when its key is present). With no keys at all, init continues keyless (keyword-only search) with a loud notice; add a key later and re-run `gbrain init --force --embedding-model voyage:voyage-4` to enable embeddings (effects: `credentials` and `paid`, since every page is embedded through the provider; it needs the brain's writer lock, so stop a running `gbrain serve` first; pages and facts are kept), or pass `--no-embedding` up front to make keyless explicit. `gbrain config get embedding_disabled` reports whether embedding is off and which plane says so (the config file and the database setting; `true` on either turns it off); `gbrain config set embedding_disabled true|false` and `gbrain config unset embedding_disabled` change both, and the `init --force --embedding-model` enable path clears both. See [`docs/integrations/embedding-providers.md`](../integrations/embedding-providers.md) for the full provider matrix and [`docs/operations/headless-install.md`](../operations/headless-install.md) for Docker/CI sequencing.

<a id="embed-backfill-skipped"></a>**A sync job or `embed-backfill` job reports `embed_backfill_skipped` (reason `embedding_disabled`)?** Nothing is wrong: the brain is keyless by choice (`embedding_disabled`), so sync queues no embed-backfill and a backfill already queued ends on its first attempt without reading a page. Search stays keyword-only. The notice appears once per brain state (the first skip after the brain became keyless); its fix is the optional step that turns embedding on and names the provider key it needs (effects `credentials` and `paid`: ask the user first).

**`gbrain doctor` warns `default_source_local_path`?** Your `default` source has no `local_path` AND that null pointer is provably breaking write-through (the repo fallback is another source's own working tree, or file-backed default pages have no resolvable root). A null `local_path` on its own is the designed fallback topology and reports ok. The repair is a pointer update, never a file move: `gbrain sources set-path default <path>` prints the prior value before changing it and refuses a path that nests inside or swallows another source's tree (exit 6; `--force` bypasses). The check also warns when any source's `local_path` is a relative path such as `.`, or when a `default` source with no path falls back to a relative `sync.repo_path`, because sync refuses those (`sync_anchor_relative`); see [relative source path](#relative-source-path). **Say to your agent:** *"Run a brain health check and fix what you find"* — the maintain skill runs `gbrain doctor` and applies the printed repair.

**A Gmail, Calendar or GitHub connector source still has an old `local_path`?** Connector sources sync from their provider, so autopilot ignores their `local_path`: once a connector has synced (or tried to) at least once, autopilot syncs it on every interval and runs its database phases with no checkout. A connector that has never synced stays idle until you run `gbrain sync --source <id>` once; autopilot prints that command the first time it skips one. To remove the stale pointer, run `gbrain sources set-path <id> --clear` (connector sources, or any source whose `local_path` is relative; it refuses a filesystem source with an absolute path and any source bound to a canonical owner). `config.syncEnabled=false` still opts a source out. **Say to your agent:** *"My Gmail source points at an old folder. Clear it and keep it syncing."*

<a id="write-refused"></a>**A save, sync or background effect was refused with a named reason?** Reasons such as `file_database_drift`, `ambiguous_source_path`, `physical_root_device_changed`, `cursor_processing_options_conflict`, `take_row_collision`, `invalid_source_uri`, `queue_capacity` and parked effects (`targets_parked`, doctor `parked_effects`) each come with a recovery step in the error's `suggestion`. [Write refusal reasons](write-refusals.md) explains each one and its recovery. **Say to your agent:** *"My save was refused. Explain the reason and show me the fix before you run it."*

<a id="doctor-residue"></a>**`gbrain doctor` warns `timeline_history`, `derived_visibility`, or unsealed pages under `contextual_retrieval_coverage`?** Preview the fix with `gbrain repair`, then apply one kind at a time with `gbrain repair <kind> --apply` on the brain host. See [repair residual damage](repair.md).

<a id="extract-health-halts"></a>**Doctor warns `extract_health` with "kind(s) with halt rate > 10%" after the cause was already fixed?** The check is a rate over the last 7 days, not a list of open faults: `halt_count` and `round_completed_count` are 7-day sums from the extraction rollup (one row per kind per day), so halts recorded before a fix keep the rate up until their days leave the window. Read each kind's age before acting: `last halt today` (or `1d ago`) means the extractor is still halting, while `last halt 5d ago` on a kind that has run since means the halts are history. `gbrain doctor --only extract_health --json` gives the same per kind in `details.kinds[]`: `halt_rate`, `last_halt_age_days`, `top_halt_reason` and every reason with its count in `halt_reasons`; runs that stopped at an expected budget or deadline cap count in `expected_limit_count`, not as halts. Fix the reason that is still current, then let the window age out: expiry is how a repaired cause clears, and there is no acknowledgement or reset command. A halt with `last_halt_age_days` at 0 after the fix means the cause is not fixed. **Say to your agent:** *"Is extract_health warning about current halts or old ones?"*

**`gbrain doctor` warns `timeline_orphans`?** Timeline rows from an earlier version of a page are still in the database after the dated bullet was edited or deleted. Preview with `gbrain extract timeline --prune-orphans --dry-run`, then remove them with `gbrain extract timeline --prune-orphans` (add `--source-id <id>` to limit it). Rows no page version ever produced, such as enrichment and meeting fan-out, are kept.

**A doctor check says "Not verified"?** <a id="not-verified-doctor-checks"></a>The check could not read its input, so it reports `warn` instead of `ok`; `gbrain doctor --json` carries `details.code: "not_verified"` and the underlying reason in `details.reason`. Fix the cause, then re-run `gbrain doctor`:

| Check | What it could not read | Fix |
| --- | --- | --- |
| `multi_source_drift` | a source's `local_path` root or a directory below it (`details.unreadable_sources`), the walk hit its bound (`details.limit` files / `details.timeout_ms`), or, for a source whose slugs are pinned to its git root, where `local_path` sits in its git work tree (`details.git_root_skipped`) | fix the path or permissions (`gbrain sources status`); for a large source re-run with `GBRAIN_DRIFT_LIMIT=<files> GBRAIN_DRIFT_TIMEOUT_MS=<ms> gbrain doctor`; for a git-root source, check that `git -C <local_path> rev-parse --show-prefix` succeeds (a checkout git can read and that it trusts) |
| `embed_staleness` | the stale-chunk count (the embed worker's own predicate) | the reason names the database error; re-run `gbrain doctor` once it is fixed |
| `schema_pack_consistency`, `schema_pack_source_drift` | the pages or config query, or a source's active schema pack | `gbrain schema lint --with-db` runs the same classification locally; `gbrain schema active` debugs pack resolution |

`bootstrap_push_health` and `gbrain bootstrap status` report only the push record of the workspace named by this machine's bootstrap receipt; another workspace's stale or failed push is listed as such (a warn naming that workspace), never as this workspace's state. `reranker_health` auth warnings are audit-log history (`details.live_probe_performed: false`), not a live check of the key. These warns can appear while every other check reads green; each one names a check that did not run.

<a id="git-convergence"></a>**`gbrain doctor` warns or fails `git_convergence`, or `bootstrap_push_health` warns that a workspace is ahead?** A Git checkout the brain syncs from (a source's `local_path` or `sync.repo_path`) has commits its upstream does not have, or uncommitted changes, so the system of record on the remote is behind the brain (#5063). Commits not on the upstream warn after 6 hours and fail after 24; uncommitted changes older than 6 hours warn. Doctor compares with the local `@{u}` ref and never fetches, so it is only as fresh as the last fetch; checkouts without an upstream and connector sources are skipped. Commit and push the checkout (`gbrain sources push --path <root>` for a bootstrap workspace; otherwise commit your files with `gbrain git commit-push -m "<msg>" -- <paths>` and publish waiting commits with `gbrain git commit-push --push-only`, see [shared-checkout git](shared-checkout-git.md#outcomes)). `bootstrap_push_health` no longer reports `ok` on a recent successful push while the workspace still has commits not on origin.

<a id="tracked-ownership-marker"></a>**`gbrain doctor` warns `tracked_ownership_marker`, or `gbrain sources push` / `bootstrap verify` refuses a `.gbrain-owner*.json` or `.gbrain-bootstrap.lock/` path?** An ownership marker (`.gbrain-owner.json`, the `.gbrain-owner-<hash>.json` reservation beside a root, a `.gbrain-owner.json.<uuid>.tmp` staging file) or the bootstrap lock directory was committed to a source checkout (#5186). These files are this machine's claim on the checkout, never brain content, and must not reach a remote. Since this fix gbrain appends their patterns to the checkout's `.git/info/exclude` whenever it stamps or adopts a root, the bootstrap `.gitignore` template lists them, and the push deny list refuses a tracked one while an untracked one is excluded from the commit (`excludedUntracked`). None of that un-tracks a file already in the index: run the `git -C <root> rm --cached <paths>` the check prints (the files stay on disk, gbrain keeps reading them), commit, push, then `gbrain doctor --only tracked_ownership_marker --json`. A root stamped before this fix gains the exclude rule on its next stamp or transfer; until then the deny list is the backstop, and `bootstrap verify`'s `deny_globs` treats a merely-on-disk marker as fine. If a marker already reached a remote, rotate it the same way you would any published credential: the token alone is not remote authority (the reservation that proves ownership lives outside the root), but treat the history as exposed.

**`brain_score` shows a low "timeline density (entity and event pages)"?** The 15-point timeline component grades only linkable pages whose type's active-pack primitive is `entity` or `temporal` (people, companies, meetings, emails, events…); reference documents such as notes, writing and guides have no events and are not graded, so do not stamp "page created" rows onto them. Types the pack does not declare are still graded. Raise the score by giving those entity and event pages real timeline entries (`gbrain extract timeline`).

**`gbrain doctor` warns `slug_collisions`, or sync prints slug collisions?** Two or more files in a source map to the same page slug (for example `notes/Foo Bar.md` and `notes/foo-bar.md`), and only one is indexed. Rename all but one file in each group, commit, then sync.

<a id="session-timeouts-not-applied"></a>**Doctor warns `persistence_session_timeouts` with `session_timeouts_not_applied`?** gbrain sets `statement_timeout` (`GBRAIN_STATEMENT_TIMEOUT`, default 5min) and `idle_in_transaction_session_timeout` as connection startup parameters, and a transaction-mode pooler (PgBouncer with `ignore_startup_parameters`, Supavisor) drops them: `SHOW statement_timeout` through the configured URL reads `0`, so a statement outside a transaction has no server-side bound and a relation lock held in another session (a migration's `ALTER TABLE pages` queued behind a long transaction, for example) holds it for as long as the lock lasts. Managed write *preparation* reads are not affected since v0.60.108: they run under a transaction-local `statement_timeout` of the write's remaining preparation budget, so a lock-blocked read ends at the budget and the member is released `preparation_deadline` with no statement left on the server (#6278). For every other autocommit statement, set the default on the role instead of the connection: `ALTER ROLE <gbrain role> SET statement_timeout = '5min'` (read-only to check: `gbrain doctor --only persistence_session_timeouts --json`). Setting `GBRAIN_STATEMENT_TIMEOUT` has no effect through such a pooler.

<a id="managed-sync-blocked"></a>**A managed sync run is blocked (doctor `managed_sync_blocked`, a freshness `sync` job ended `dead`, or get_brain_health reports `sync_blocked`)?** The source's unfinished run stopped on a page request that did not commit and recorded the stop, so it resumes nothing by itself while the other sources keep syncing (#6858: one source stopped for 21 hours while every freshness job reported `completed`). Such a job now ends `dead`: its error names the stop and the run's `next` command, and `gbrain jobs get <id> --json` carries `outcome`, `drain` and `next` in its progress. Doctor warns as soon as a run is blocked and fails once it has been blocked for more than an hour; get_brain_health turns to `attention` past the same hour, with a count band and no source names. A sync pass that stopped before it finished (in discovery, path `<discovery>`, or on one file) counts as blocked too, until a later sync of the source succeeds. So does an open pass whose process was killed or crashed with no process left holding its drain lease (code `pass_interrupted`, aged from the pass row's last write), and passes that keep stopping that way (`pass_abandoned`). Run `gbrain sync status --source <id> --json` (read-only): it names the page, its fault class and its exit. Clear the cause it names and run the step it prints; the next freshness job resumes the run once the cause is gone. A page publication that `gbrain repair stuck-recovery --keep disk` abandoned is not a blocker: the next plain sync retries that page after the rest of its run, imports it when the kept file is committed, and holds it `worktree_dirty` otherwise.

<a id="managed-sync-not-moving"></a>**The catch-up is parked (`sources status --json` says `data_moving: false`, doctor warns `managed_sync_not_moving`, `gbrain sources writer movement` exited 1), or the drain stopped `drain_stalled` with `cause: owner_wedged_here`?** Liveness is not movement: `/health` can be ok, the pid alive and `sync_running: true` while no page has committed for weeks. A managed source is *not moving* when an unfinished `managed-sync` cursor has had neither a committed `managed_sync_*` receipt nor a head step advance for longer than `persistence.preparation_ceiling_ms` (600 s) while a drain or a full consumer is live on the owner host; with nothing live it is `movement_state: parked` (a cursor left between cron runs; informational, not scored). A parked cursor whose write queue still holds admitted requests while no consumer runs and nothing has moved for longer than that ceiling is stranded: nothing will ever drain it, so doctor `managed_sync_not_moving` fails (#6552, #6712 PR 2) and its fix is the resume sync with the cursor's stored options (`gbrain sync --source <id> …`), which consumes the queue itself; `details.stranded` counts such sources. When the sync backlog itself cannot be read, every surface says `movement_state: unknown` (`unknown.reason: backlog_read_failed`) instead of `nothing_pending`: doctor warns with `details.health: unknown`, `sources status` prints a `movement UNKNOWN` line, and `gbrain sources writer movement` exits 1 with code `movement_unknown` (`--warn-only` exits 0); rerun the movement command, and run `gbrain doctor --json` if the read keeps failing. Every surface routes to the same two read-only calls, so the agent reaches the owner, the step and the next action without SQL:

1. `gbrain sources status <id> --json`: `data_moving`, `not_moving_since`, `movement_state` and, beside `data_moving: false`, the exact `gbrain sources writer status --source <id> --json` to run next. Doctor's `managed_sync_not_moving` fix is that same command.
2. `gbrain sources writer status --source <id> --json`: every running claim ends in one `claim.next` envelope (`code` `claim_running`, `claim_overdue` or `claim_lapsed`). `claim_running` carries `retry_after_ms` and a `run` of the same status command while the owner is inside its allowance (the owner's own budget will cut the write; nothing to do but rerun after the delay), `tell_user_to_run` naming the owner `kind` and pid past the ceiling or when the owner reads `restart_required` (restart that process), `run` the printed resume command for a lapsed claim. `host.consumers` lists the processes on this host holding a consumer (pid, kind, mode `full|waiter_only`, started_at, the pool gauge), so a second consumer is visible in the same call.
3. After the restart (or after waiting out the ceiling), `gbrain sources retry-held <id>` re-screens the entry the owner held and prints the sync to run; `gbrain sources writer movement <id>` then waits one window and exits 0 only when a page committed (`moved`) or nothing is pending (`current`). See the [transcript](#managed-sync-wedge-transcript) below for what each step prints.

A `drain_stalled` stop with `cause: owner_wedged_here` is the same situation seen from the sync CLI: a live owner on this host holds the head write past the ceiling or its heartbeat row reads wedged. Before the ceiling the stop is loop-safe (`next.safe_to_loop: true`, `retry_after_ms` set); past it the stop names the pid to restart. Reference: [drain stops](write-refusals.md#drain-stalled).

<a id="two-consumers-on-host"></a>**Doctor warns `two_consumers_on_host`?** Two resident gbrain processes on this host (`serve`, `sync`, `jobs`, `autopilot`, `mcp`) have each run a *full* persistence consumer for more than 30 s, so both claim writes on the same roots. One full consumer per host is a preference, not a fenced role: a `serve` always starts full; every other resident kind probes the `persistence_consumers` heartbeat table at start and on every tick and runs *waiter-only* (it submits and waits, claims nothing) while a live, full, not-wedged consumer of this host exists, promoting itself when that row lapses (60 s), reads wedged or stops being full. Two processes that start within one renewal of each other can both start full, and a sync CLI that took its consumer before the `serve` started keeps it for that run; doctor lists both until one exits. Rows younger than 30 s and short-lived kinds (`put`, `import`, `dream`, `cycle`, `sources`, `cli`) are listed, never warned. `gbrain sources writer status --json` shows them under `host.consumers` (read-only); let the shorter-lived process finish, or restart it so it defers. With `persistence.single_consumer` off (`gbrain config set persistence.single_consumer false`, or `GBRAIN_SINGLE_CONSUMER=0`) every process keeps its own consumer as before and the warning describes the configured behavior. `gbrain sync --no-delegate` keeps that one run's own consumer on either engine.

<a id="consumers-without-heartbeat"></a>**Doctor warns `consumers_without_heartbeat`?** A running claim on this host is stamped by a process (`claim_phase.owner`: kind, pid, gbrain version) that has no `persistence_consumers` row. Every full consumer on this release renews its row every 10 s, so an owner without one runs a gbrain release from before the heartbeat table: it never defers to the resident consumer and the host runs two full consumers until it is upgraded. The check names the pid, kind and version from the stamp; upgrade and restart that process (after the user agrees). A new sync CLI beside an older `serve` says so on its start line (`owner row missing: older serve or no serve; running own consumer`).

<a id="serve-build-drift"></a>**Doctor warns `serve_build_drift` ("serve is running an older build than this checkout; restart serve and workers")?** Upgrading or pulling the checkout does not restart the processes already running from it. Every live consumer on this host writes its gbrain version into its `persistence_consumers` heartbeat row, and the check compares the live `serve`, `sync`, `jobs`, `autopilot` and `mcp` rows with this binary's version in one read. Until they restart, one-shot commands from the checkout (`gbrain sync`, `bun run src/cli.ts …`) run newer code against an older consumer. The check prints the restart for the serve: `systemctl --user restart gbrain-serve.service` or `launchctl kickstart -k gui/<uid>/com.gbrain.serve` when that service is installed, otherwise the pid to stop and start again the way it was launched. Restart each other listed process (the jobs worker, autopilot) the same way, after the user agrees; nothing restarts automatically. A serve older than the heartbeat table writes no row, so this check reads ok beside it and [`consumers_without_heartbeat`](#consumers-without-heartbeat) names it once it holds claims. A serve newer than this checkout is reported, not warned: upgrade the checkout before running one-shot commands from it. Verify with `gbrain doctor --only serve_build_drift --json`; on PGLite there is one process and the check reads ok.

<a id="runtime-build-skew"></a>**Doctor fails `runtime_build_skew` (several gbrain builds are running on this host)?** Run `gbrain upgrade --restart-only` after the user agrees: it restarts every gbrain process on this host onto the installed build and verifies one build runs and the warm CLI socket accepts it ([restart](upgrades-auto-update.md#restart)); `--dry-run --json` previews it. Each long-running process keeps the build it loaded when it started, but `gbrain jobs run-child` starts a fresh process from the install on disk for every job, so after a checkout reset, a pull or an upgrade on disk one host can run serve, the supervisor and its workers, and their job children on different builds. The check reads each process's own record: serve and the other resident consumers from their heartbeat rows (Postgres), the supervisor from its PID file, each `gbrain jobs work` from its worker-registry entry, and the job children from the `job_build_skew:` line a child writes into a job's history (`gbrain jobs get <id>`) when its build differs from its worker's. It fails when the running builds differ, warns when only a process's install holds another build, and lists every process with its pid and version (never a path). By hand, the message names one restart, serve first, then the supervisor, then a worker: restart serve with its service command, stop the supervisor with `gbrain jobs supervisor stop` and start it again with `gbrain jobs supervisor start --detach`, or stop a worker's pid (SIGTERM drains its jobs, and its supervisor starts a fresh one). A job child whose worker needs a readiness protocol or feature the child lacks refuses the job: the job is released without counting an attempt and the worker stops on a configuration block until it is restarted on one build. A process started before builds were recorded is named as unrecorded; restarting it makes it report one. `/health` on `gbrain serve --http` carries `build` (`version`, `installed_version`, `restart_pending`) on every 200. Verify with `gbrain doctor --only runtime_build_skew --json`.

<a id="host-identity-mismatch"></a>**Doctor warns `host_identity_mismatch`, or fence repair, chronicle and other maintenance jobs have reported `owner_unavailable` with reason `host_mismatch` for days?** Host identity is a file, `host.json` under the persistence home (`GBRAIN_HOME`, else `$HOME/.gbrain`). A job worker or container launched with a different `HOME` or without `GBRAIN_HOME` mints a new identity after every restart and sees the binding as another host's, so its writes never reach the owner while every health signal stays green. Doctor flags it when this process's identity differs from the binding owner's and the owner's checkout resolves on this filesystem (same machine id or volume), or, for a container without a stable machine id, when the checkout is present at the binding's path and this `host.json` was minted after the binding under a different `HOME`/`GBRAIN_HOME`. The check names both files, the environment each was minted under (`minted_under: {home, gbrain_home, hostname, machine_id}`; `unknown` for a file minted before it was recorded) and the one-line fix: set `GBRAIN_HOME` on that process's supervisor to the owner's home (the printed value; config appends `.gbrain` itself) and restart it. Nothing re-derives or rewrites an existing `host.json`: re-owning the binding would break every other host sharing the brain. Verify with `gbrain doctor --only host_identity_mismatch --json`.

<a id="managed-sync-wedge-transcript"></a>**What the agent sees while a catch-up is wedged, step by step.** The brain is `default`, the owner is a `gbrain serve` with pid 4121, the sync CLI runs beside it, and the head write of a 16-member bulk group has been `preparing` with nothing in flight at the database. Output is abbreviated to the fields that decide the next step.

```text
$ gbrain sync --source default --no-pull --no-embed
[sync] managed catch-up: 13627 entries frozen, 13412 remaining; publishing in bulk groups (each page keeps its own request).
[sync] 215/13627 processed · stalled 160s on import_screen (waiting on db) · allowed 2m30s · owner serve pid 4121
[sync] 215/13627 processed · stalled 430s on import_screen (waiting on db) · allowed 2m30s · owner serve pid 4121
Managed sync blocked: 215 entries this run (215 written, 0 waived), 13412 remaining.
  Oldest unfinished request 01J9W6Y5D0X7K2Q8R4T1V3B9ZC (running), step=import_screen, waiting_on=db, cause=owner_wedged_here, owner serve pid 4121; claimable here: no.
  Next: gbrain sync --source default --no-pull --no-embed (safe to rerun in a loop)
  Why: The head write is held by gbrain serve (pid 4121) on this host, parked at step import_screen for 430s. Its budget frees the root by the 600 s ceiling (170 s from now) and the next pass holds the entry; rerun then. If it is still held after the ceiling, restart pid 4121.

$ gbrain sources status default --json
{ "id": "default", "managed_sync": { "index": 215, "total": 13627, "held": 0 }, "sync_running": true,
  "data_moving": false, "not_moving_since": "2026-10-08T15:02:11Z", "movement_state": "not_moving",
  "next": { "command": "gbrain sources writer status --source default --json",
            "why": "No page of this source committed and the head write's step did not advance for 11 min while a consumer is live on its owner host." } }

$ gbrain doctor --only managed_sync_not_moving --json
{ "name": "managed_sync_not_moving", "status": "warn",
  "message": "Source default has 13412 unfinished entries and a live consumer on this host, but no page committed and no step advanced for 11 min.",
  "details": { "source_id": "default", "data_moving": false, "not_moving_since": "2026-10-08T15:02:11Z", "movement_state": "not_moving" },
  "fix": { "command": "gbrain sources writer status --source default --json", "next": "run", "actor": "agent", "consent": [] } }

$ gbrain sources writer status --source default --json
{ "host": { "consumers": [
    { "pid": 4121, "kind": "serve", "mode": "full", "started_at": "2026-10-08T14:50:03Z", "pool": { "checked_out": 10, "max": 10, "waiters": 3 } },
    { "pid": 4388, "kind": "sync", "mode": "waiter_only", "started_at": "2026-10-08T14:51:20Z" } ] },
  "blockers": [ { "request_id": "01J9W6Y5D0X7K2Q8R4T1V3B9ZC", "operation": "managed_sync_import", "state": "running",
    "claim": { "phase": "preparing", "step": "import_screen", "step_age_ms": 661000, "waiting_on": "pool",
               "owner": { "kind": "serve", "pid": 4121, "build": "0.60.113.0" }, "pool": { "checked_out": 10, "max": 10, "waiters": 3 },
               "stall": { "reason": "preparation_overdue", "step": "import_screen", "budget_ms": 120000 } },
    "next": { "code": "claim_overdue", "retry_after_ms": 0, "fix": { "next": "tell_user_to_run", "actor": "host_admin", "consent": [],
      "user_message": "gbrain serve (pid 4121) has held this write at import_screen for 11 min, past the 600 s ceiling, waiting on its connection pool (10 of 10 checked out, 3 waiting). Restart that serve.",
      "why": "The owner's budget cut the write at 120 s, but the preparation ignored cancellation and still holds its root barrier; only the owner process can release it now.",
      "verify": { "argv": ["gbrain", "sources", "writer", "status", "--source", "default", "--json"] } } } } ],
  "data_moving": false, "not_moving_since": "2026-10-08T15:02:11Z", "sync_running": true }

# after the operator restarted pid 4121:
$ gbrain sources retry-held default
Re-screening 1 held entry of source default. Run: gbrain sync --source default --no-pull --no-embed
$ gbrain sources writer movement default
Judging movement for 300 s (preparation budget 120 s + 60 s, floored at 300 s)...
default: moved (3 pages committed, head advanced import_screen -> knowledge_publication). Exit 0.
```

Two calls, no SQL: the doctor or `sources status` row names the command, and `writer status` ends in the action. A `data_moving: false` that returns after the restart means a different owner is wedged or the same one wedged again: the same two calls name it.

<a id="persistence-write-stall"></a>**A managed write stays `running` and later writes queue behind it, or doctor warns `persistence_write_stall`?** The owner keeps renewing a hung claim; doctor warns past `persistence.max_claim_ms` (default 600000) and names the request, root, age, phase and, for a preparation, its step and what it waited on. A claim released and taken again every few seconds never ages that far, so doctor also warns about a running request at least `persistence.max_claim_ms` old when no request on its root (its worktree, or for a database-only request the source's other database-only requests) reached a terminal state within that window (#6635); each stall carries `request_age_ms` and the message uses the larger age. A write stuck *preparing* is released at its deadline and finally held or failed `preparation_stalled` on its own: see [catch-up stuck](#catch-up-stuck). A write stuck *publishing*, or one whose owner predates the deadlines, still needs the owner restarted: run `gbrain sources writer status --source <id> --json` (read-only), then restart the `gbrain serve` that owns the root and attach that output when reporting it.

<a id="terminal-write-failures"></a>**Doctor warns `persistence_terminal_failures`, or `gbrain sync status` reports terminal write failures?** Every write leaves a receipt, and a receipt that ended `failed`, `conflict` or `cancelled` stays in `persistence_requests` until compaction. gbrain reads them at query time and sorts each one into a category with a class, safe actions, whether a person decides, and a structured fix (nothing new is stored). Most rows need no action, so the check separates three things:

- **Active blockers** hold work now: a receipt still holding a publication recovery record (it blocks every queued write on its root), or a receipt that blocks a managed sync's checkpoint. Doctor warns whenever one exists, whatever the trend, and its `fix.command` is the next step (for a recovery record, `gbrain sync --source <id> --no-pull`, which runs the owner pass that clears it; a `recovery_blocked` record names the file to inspect instead).
- **Unresolved rows** are terminal receipts in the window (`persistence.terminal_failures.window_days`, default 7, never longer than `persistence.receipt_retention_days`) that no later write superseded. Doctor warns when any of them is a gbrain-defect class (`owner_exception`, `database_refusal`, `writer_guard`, `outside_fence`, `gbrain_defect`): report those with the receipt ids. The rest are ordinary refusals the caller already received (`caller_conflict`, `caller_refusal`, `operator_cancelled`) or sync faults a rerun retries. A `schema_missing` row (#6904) is a write that met a missing table or column: when the schema is behind, its fix is `gbrain apply-migrations --yes` as the database role that owns the gbrain tables, then resubmit; at head, it asks the user and points at doctor's `schema_missing_tables` check and the `gbrain repair missing-tables` preview.
- **Historical rows** do not block: a later write superseded them (`superseded`, `already_written`, `duplicate`), or they came from a build older than the release that fixed their cause (sync knock-on cancels before 0.60.216.0, the `Publication failed (P0001)` refusal before 0.60.40.0). Doctor counts them and never warns on them.

A spike warns only on its own: when at least `persistence.terminal_failures.spike_min` (default 25) receipts ended in the last 24 h and that is more than `persistence.terminal_failures.spike_factor` (default 3) times the median of the 7 days before. When most of those receipts were written by a gbrain build older than the release that fixed their class, the warning says an older write owner is still producing them and names the build; its fix is the read-only `gbrain sources writer status --source <id> --json` that names the owner, so upgrade or restart that process. A `file_database_drift` row is the page-drift class: [file drift](repair.md#file-drift) resolves it with `gbrain repair file-drift`. A read that does not finish within its deadline (5 s per statement, 2 s to get a connection) reports `unknown`, never a clean pile; rerun it.

```bash
gbrain doctor --only persistence_terminal_failures --json      # blockers, unresolved, historical, the fix
gbrain sync status --source <id>                               # the same summary for one source, with BLOCKING lines
gbrain sources writer failures <id> --group-by category        # groups on code + origin + category (+ operation for a sync_fault), each with its drill-down
gbrain sources writer failures <id> --category owner_exception --code storage_error --origin owner_exception --json
gbrain write-request <request> --json                          # one receipt: write_error_reason, suggestion, diagnosis.fix
```

All five are read-only. `sources writer failures` prints a table, or one JSON document with `--json`; a full page ends with `truncated` and the exact next command (`--before <cursor>`), and `--state all` adds the resolved and historical rows. A receipt whose code and origin do not say what happened (most often an old `storage_error` compacted without its message) is `diagnosis_required`: its fix is the read-only `gbrain sources writer status --source <id> --json`, and nothing is guessed. With `gbrain serve --http`, the admin-only `/metrics` carries the same counts per source (`gbrain_writer_terminal_failures_active_blockers`, `_unresolved`, `_historical`, `_new_24h`, `_defects`, and `_known 0` when the read timed out), from one aggregate shared by every scrape for 60 s; the public `/health` never does. To tune the thresholds:

```bash
gbrain config set persistence.terminal_failures.window_days 14
gbrain config set persistence.terminal_failures.spike_factor 3
gbrain config set persistence.terminal_failures.spike_min 25
```

Refused writes a caller never saw land (`lost_caller_writes`) have their own repair: [failed writes](repair.md#failed-writes). Why a single write was refused: [write refusals](write-refusals.md).

<a id="owner-unavailable"></a>**`fence_repair`, chronicle, fact-fence adoption or another maintenance step refused `owner_unavailable`?** A managed source publishes only through the host that owns its checkout, and the refusal's `reason` says which condition this is; the fix is always the read-only `gbrain sources writer status --source <id> --json`, and nothing claims or transfers ownership to get a step through.

| `reason` | What it means | Next |
|---|---|---|
| `host_mismatch` | Another host id owns the checkout. The message prints both ids' first 8 characters and, to a local caller, the `host.json` this process read (`<GBRAIN_HOME>/.gbrain/persistence/host.json`). A maintenance worker (launchd, cron, autopilot) started with a different `GBRAIN_HOME` or user than the shell that ran the sync reads a different identity file and is, to the brain, a different host. `retryable: false`: a retry from the same environment cannot change the answer. | Run the step on the owner host writer status names, or make both environments use one `GBRAIN_HOME`. Never copy or regenerate `host.json`: a new identity orphans the ownership and pending writes recorded for the old one. |
| `transfer_in_progress` | The worktree is `draining`: a writer transfer was prepared and not yet accepted or cancelled. | `fix.next` is `wait`: retry after 30 s; the status read shows the state. A transfer prepared more than 30 minutes ago never ends on its own, so its refusal reads `ask_user` and names both exits: `gbrain sources writer transfer accept` on the successor, or `gbrain sources writer transfer cancel <source> --expected-epoch <n>` on the owner host (`--dry-run` previews; the worktree returns to active at the same epoch and the prepared manifest is cleared). A drain an older release prepared records no time and keeps the wait, whose `why` names the cancel. |
| `clone_in_progress` | The worktree is `recovering`: a topology clone or reclone is in progress. | `wait`: retry after 30 s; it is `active` when the clone finishes. |
| `binding_missing` | The source has no canonical worktree binding at all. | Claiming a checkout is the host administrator's decision. |
| `incarnation_changed` | The binding belongs to an earlier incarnation of the source (removed and re-added, or restored). | Re-bind the checkout on the brain host. |
| `local_path_missing` | This host owns the worktree but has no checkout path registered. | Register the checkout again on the brain host. |
| `coordination_path_missing` | This host's registration has no coordination directory. | Repair the registration on the brain host. |
| `not_sent`, `outcome_unknown` | The local owner's IPC lane did not take the write, or lost its acknowledgment. | `gbrain sources writer status --probe --json`; for `outcome_unknown` read the receipt (`gbrain write-request -- <id>`) before resubmitting. |

A running sync is not one of these: `gbrain repair fences` now runs during a catch-up for every candidate the sync does not still name ([fence repair during a sync](repair.md#fence-repair-during-a-sync)), and a candidate it does name is `sync_in_progress`, not `owner_unavailable`.

<a id="write-capacity"></a>**Managed writes refused with `queue_capacity`, or doctor warns `persistence_capacity`?** A per-principal or per-brain write-journal limit (`persistence.limits.*`) is full (`queue_capacity`), or doctor sees lifetime request IDs or receipt bytes at 80% or more (`persistence_capacity`). For the cumulative limits (lifetime request IDs and receipt bytes), the warning and the refusal print a `gbrain config set persistence.limits.<limit> <value>` sized for about one more year; run it on the brain host, then retry with the same request ID. For outstanding-request or queued-byte limits, let outstanding writes finish and check `gbrain sources writer status`. Receipt compaction age is `persistence.receipt_retention_days` (default 30). Limits and defaults: [bounded admission and retention](concurrent-writes.md#bounded-admission-and-retention).

<a id="doctor-ops-tier"></a>**`gbrain doctor` is slow on a large brain, or you need to see what is wrong in seconds?** Run `gbrain doctor --tier ops --json`: only the operator sections (write capacity, unresolved write failures, a managed sync cursor that stopped moving, [receipt compaction](repair.md#receipt-compaction) freshness, a serve on an older build, schema-pack consistency, embedding state) under a 4000 ms deadline (`--budget-ms <n>`). A section the deadline cut off reads unknown (`details.health: "unknown"`, `reason: "budget"`, `exact: false`), never clear; the report says `complete: false` and lists it in `unknown_sections`; rerun it with `gbrain doctor --only <name> --json`. On PGLite, serve-only sections read `not_applicable` and the report stays complete. The default doctor runs the same sections first and bounds each check and a plain `--json` run ([doctor budgets](repair.md#doctor-budgets)); above `doctor.orphan_ratio.full_scan_max_pages` pages (default 50000) it samples `orphan_ratio`, and `--tier deep` scans fully. From a thin client, `gbrain doctor --tier ops` (or `--only persistence_capacity`) asks the serve: an admin token gets the ops report, a read token the `get_brain_health` bands (no raw counts), and a serve that predates the ops tier refuses `doctor_tier_unavailable` (run it on the brain host, or upgrade and restart the serve). Agents without a shell call MCP `get_brain_health` (read) or `run_doctor` with `tier: "ops"` (admin).

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
spawn entirely. The v0.13.1 grandfather migration writes nothing since #7814: it
records completion and leaves every page as it was.

<a id="ghost-pages"></a>**A write refuses `source_changed` with "The canonical file was removed outside coordinated publication." (`canonical_file_missing`), or doctor `ghost_pages` warns?** The page is a ghost: its canonical file is gone on the owner host but the database page is live, so every write refuses and no sync can import a file that is not there. On the owner host, list them with `gbrain pages ghosts --source <id>` (read-only). For each, the user decides: to keep the page, restore its file at the recorded path (from Git or a backup; gbrain has no automated file restore) and run `gbrain sync --source <id>`; to remove it, preview `gbrain repair ghost-pages --source <id>`, show the user the list, and after they agree run the printed `--apply --expect <hash> --yes`. Removed pages are purged after 72 h; `gbrain restore <slug> --force` undoes one until then. Off the owner host it refuses `not_owner_host`; on an unreadable checkout `ghost_storage_unknown`; when ghosts are more than half of the source's file-backed pages `ghost_mass_delete_refused` (check the checkout first). See [ghost pages](repair.md#ghost-pages). **Say to your agent:** *"Which pages lost their files? Show me the list before you remove anything."*

<a id="maintenance-write-drift"></a>**Writes to the same pages keep refusing `source_changed` with `file_database_drift`, or doctor `maintenance_write_drift` warns?** Each of those pages has a canonical file that differs from its database copy, usually from an edit outside a coordinated write, so every coordinated write to it refuses and leaves a conflict receipt. Maintenance now checks the file first: `synthesize_concepts` skips a drifted concept before any model call (the phase warns and names the commands below) and other maintenance writes refuse before admission, so the pile stops growing. To list the pages, run `gbrain sources reconcile <id> --brain host --audit --conflicts` (read-only; receipts per slug, whether the file still differs, its drift class and producer; MCP `list_write_conflicts` gives remote readers the database-derived part). Then preview `gbrain repair file-drift --source <id> --all-drifted --prefer file` (add `--class <name>` when the preview reports mixed classes, narrow it with `--only '<path glob>'` / `--skip '<path glob>'` over the canonical file paths, or pick pages with `--slug`), show the user the per-page `exceptions`, and after they agree run the printed `--apply --expect <hash>` command exactly as printed. For derived pages under one directory, such as regenerated concepts: (6) preview `gbrain repair file-drift --source default --all-drifted --only 'concepts/**' --prefer database`, show the user the count and the exceptions, and after they agree run the apply command it prints, which applies exactly the previewed pages. To keep resolving such a directory with the database copy from now on, the user can declare it under `storage:` `keep_db:` in the source's gbrain.yml; the owner host's serve, jobs or autopilot consumer then reconciles drifted pages there at most 10 every 10 minutes, and doctor echoes the policy with its matched count and receipt cost ([keep_db](repair.md#file-drift-keep-db)). `--keep` is refused here: use `--prefer database` or `--prefer file`. See [file drift](repair.md#file-drift). **Say to your agent:** *"Which pages keep refusing source_changed? Preview resolving them and show me before you apply."*

<a id="embedding-identity-unqualified"></a>**`facts-absorb` dies with `embedding_configuration` ("records its embedding model without a provider") while `gbrain config get embedding_model` shows a valid `provider:model`, or doctor `embedding_identity_unqualified` warns?** The brain's database `config` row `embedding_model` holds a bare model name from an older install (for example `text-embedding-3-small`), and managed fact extraction reads only that row. `gbrain config set` cannot change it. The doctor check prints the preview with the configured model filled in: run `gbrain migrate embeddings --to <provider:model> --dry-run` (read-only), show the user the cost, and only after they approve run it without `--dry-run`, with `--yes --max-cost-usd <cap>`. It re-embeds active facts even when the model is unchanged, so it is a paid step. When no model is configured outside the database, the check asks for the provider-qualified id instead. **Say to your agent:** *"Why did facts extraction stop with an embedding configuration error?"*

## Embedding state

**Symptom.** Doctor `embedding_state` warns, `get_brain_health` reports
`unsearchable` above zero, or a page you know exists never shows up in search.

**Say to your agent:** *"Which pages can search not see, and why?"* The agent
runs `gbrain pages unsearchable --source <id> --json` (read-only) and follows
each row's `fix`.

Every chunk, and every live page with no chunk row, is in exactly one state,
derived from the rows against the active embedding column (no stored status):

| State | What it means | Exit (each row's `fix`) |
|---|---|---|
| `embedded` | The chunk has a vector in the active column. | None. |
| `pending` | The embed job will embed it (no vector, page live, no `embed_skip`). Doctor `embeddings` ages this backlog and owns its warning. | `gbrain embed --stale --catch-up --source <id> --yes` (paid; preview with `--dry-run`). On a brain keyless by choice keyword search reads these chunks and they do not count as unsearchable. |
| `keyword_only` | The page carries `embed_skip`: the import gate found its body over `content_sanity.bytes_block` (info, by design; its chunks still feed keyword search and are never purged). Removing the marker alone is undone on the next import. | A marker under the current `bytes_block` (written by an older release under its 500 KB default): `gbrain reindex --oversized --source <id>` clears it for free. Otherwise split the page, or, after the operator approves, `gbrain config set content_sanity.bytes_block <bytes>` then `gbrain sync --source <id> --full`, which re-imports and embeds it. |
| `quarantined` | The content-quality gate hid the page as junk; it has no searchable chunks. Doctor `quarantined_pages` owns its warning. | Review with `gbrain quarantine list --json`; clear a false positive with `gbrain quarantine clear <slug> --source-id <id> --force` (the owner's call). |
| `empty` | A live page with no body text: nothing to index. | Write content to it, or delete the stub (`gbrain delete <slug> --source <id> --force`, restorable) after the user agrees. |
| `deleted_page_chunks` | Chunks of a soft-deleted page. Search never reads them; the purge lifecycle removes them after 72 h (info until then, a warning past it, code `deleted_page_chunks_overdue`). | `gbrain pages purge-deleted --dry-run --json`, then `gbrain pages purge-deleted --yes` once the user agrees (brain-wide, irreversible). |
| `chunkless_healable` | A live page with body text but no chunk rows (written without the chunking step, or an `embed_skip` page an older gbrain stored without chunks or whose `reindex --oversized` rewrite failed). Keyword search cannot find it. Doctor warns on a keyed brain (code `chunkless_pages_healable`). | `gbrain embed --stale --catch-up --source <id> --yes` chunks and embeds it (paid); an `embed_skip` page gets chunks and no vectors. The cycle's embed phase runs the same safety net. |

`unsearchable` sums `pending`, `quarantined`, `empty` and `chunkless_healable`;
`keyword_only` and `deleted_page_chunks` never count. The doctor's ops tier
reads only index-backed counts: vector-less chunks through the partial index
`WHERE <active column> IS NULL` (`content_chunks_stale_idx` for the default
`embedding` column), gated and deleted pages through their indexes, and
`embedded` as a planner estimate (`basis: estimated`); it omits `empty` and
`chunkless_healable` (`unsearchable_complete: false`). A registry-routed brain
whose active column has no such index reports `unknown` there (code
`embedding_state_unknown`, never a slow scan); the standard tier
(`gbrain doctor --only embedding_state --json`) counts every state exactly.
Pending chunks written by a binary older than the pending-age stamp carry no
age: `details.unstamped_pending` gives their count, this writer's version and
a `created_at` lower bound, and never warns on its own.

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

## Keyword search times out on a large Postgres brain

**Symptom.** On a large Postgres brain (hundreds of thousands of pages), a
broad `gbrain search` or `gbrain query` with common words takes about 8
seconds and comes back with only vector hits; search metadata carries
`keyword_arm_failed`, and the server log says `canceling statement due to
statement timeout` (SQLSTATE 57014). The strict keyword statement ranks every
matching chunk before its `LIMIT`, so its cost grows with how common the terms
are, and the commonest terms cannot finish inside the keyword statement bound.
An arm that timed out is not evidence of absence: the pages exist, the arm
could not rank them in time.

**Say to your agent:** *"Check whether keyword search is hitting its time
limit"* — the agent runs `gbrain doctor` and reads the `keyword_plan` check.

`gbrain doctor` reports `keyword_plan` (Postgres only):

- `ok`: the brain's commonest keyword term (from the planner's statistics for
  `content_chunks.search_vector`) is counted inside half of the bound; the
  message shows the plan the planner chose for it.
- skipped: PGLite (no statement timeout), fewer than 10,000 chunks, or no
  planner statistics yet (run `ANALYZE content_chunks` on the brain host, or
  let the next sync refresh them).
- warn, `canary_timed_out` or `canary_slow`: the commonest term's bounded count
  did not finish in 2 s, or took more than half of the bound. Broad queries on
  this brain will hit the bound. One canary term is not workload coverage, and
  a timed-out count is never "no matches".

**The bound is an operator knob.** `search.keyword_statement_timeout_ms`
(integer milliseconds, default 8000, range 1000 to 60000) is the
transaction-local `statement_timeout` the Postgres engine sets around every
keyword, keyword-count, keyword-page, title and CJK search statement. A remote
caller cannot change it, and `gbrain config set` refuses a value outside the
range (exit 2, nothing written). It is read once per connection, so:

1. Set it on the brain host: `gbrain config set search.keyword_statement_timeout_ms 20000`
   (or `search.keyword_statement_timeout_ms` under `search` in the config file,
   which wins over the database value).
2. Restart the process that runs searches (`gbrain serve`, autopilot, job
   workers); the next CLI command picks it up by itself.
3. Confirm with `gbrain doctor --only keyword_plan --json`: `details.timeout_ms`
   shows the value in effect.

A longer bound buys time, not a cheaper statement: a query whose terms match
most of the corpus still reads and ranks every match, so prefer narrowing with
`--source-id` (MCP `source_id`) or `match: "keyword"` paging, and follow
[#6495](https://github.com/garrytan/gbrain/issues/6495) for the bounded
candidate set that will answer broad terms from a capped set instead of
failing open.

**A timed-out keyword search is skipped for 10 minutes.** After hybrid search's
keyword statement hits the bound, a serving process (`gbrain serve`, an MCP
session) skips that exact statement for
`search.keyword_timeout_negative_cache_seconds` (integer seconds, default 600,
range 0 to 86400, 0 turns it off) instead of holding a backend for the whole
bound again. The skipped search answers from the vector arm at once and its
metadata carries `keyword_arm_failed` with reason `skipped_after_timeout`
(error code `keyword_skipped_after_timeout` in `gbrain errors`). The skip
covers the same statement only: the same terms with the same source scope,
types, dates, slug filters, visibility and trust floor of the caller, and the
same keyword bound. A narrower query (another `--source-id`, `--types`,
`--since`) still runs keyword search, another brain is never affected, and
the skip ends by itself when the entry expires, so a brief contention spike
recovers without anyone acting. A call with `use_cache: false` runs the
statement anyway.

Limits: the cache lives in the serving process's memory, so a one-shot CLI
command (`gbrain search …`) starts with an empty cache and gains nothing from
it, and a restart clears it. The TTL is read on the first timeout after the
process starts; a changed value takes effect after a restart. Each timeout
writes one counter row (`search.keyword_timeout_stats`: timeouts, skips counted
since the previous timeout, last timeout time), never one per search, and
`gbrain doctor --only keyword_plan --json` reports it under
`details.negative_cache`. Postgres only: PGLite has no keyword statement
timeout.

## Migration statement timeout

<a id="migration-statement-timeout"></a>

**Symptom.** `gbrain apply-migrations --yes` (or `gbrain upgrade`) prints
`Migration <N> (<name>) exhausted retries` or `hit statement_timeout (SQLSTATE
57014)`, exits 1 with `migrations_pending` (reason `still_behind`), and the
schema stays below head. Doctor's `schema_version` check names the migration.

**Why.** Each migration's SQL runs in one transaction under a 10-minute
statement budget, which overrides a lower server default (Supabase enforces
about 2 minutes). A lock wait stops much sooner, at the schema lock timeout
(`schema_lock_blocked`), so a statement timeout means the migration's own work
outlasted the budget. Every attempt then rolls back.

**What gbrain does about it.** Before some published migrations, gbrain runs
their backfill in committed batches of 5,000 rows, using the migration's own
predicate. An interrupted run keeps every committed batch, and
`gbrain apply-migrations --yes` continues from the rows still left. The
published migration then runs unchanged and has little or nothing left to
write.

| Migration | Done in batches first |
|---|---|
| v011 `links_provenance_columns` | `link_source = 'markdown'` on legacy links |
| v028 `cathedral_ii_chunk_fts_backfill` | chunk keyword vectors |
| v033 `admin_dashboard_columns_v0_26_3` | request-log agent names. A row with no token resolves to NULL, so the migration still rewrites those rows itself. |
| v116 `code_edges_source_backfill_and_callee_index` | `source_id` on code edges |
| v161 `index_pending_text_projections` | its partial pages index, built concurrently under the migration statement budget (Postgres), because the migration caps its own build at 30 seconds |
| v221 `chunk_embedding_pending_since` | `embedding_pending_since` on chunks without a vector, with the same active-column choice and `embedding_pending_since_backfilled_at` provenance (#7108) |

The other migrations whose work grows with a table are either bounded
differently or can't be split without editing a published migration:

- v153 rewrites every page row and queues one projection job per live page. It
  grows with the page count, not the chunk count.
- v189 scans page bodies for private-key markers. The scan only reads, and it
  writes only the matching pages.
- v123's handler rewrites keyword vectors only when the configured keyword
  language changes. It runs outside the migration transaction.
- Index builds and constraint validations inside a migration (v011's unique
  constraint, v174, v226 and similar) are single statements that can't be
  split. Apart from the build itself, they only read.
- v160 (ANALYZE samples `pages`), v200 (a partial index on `op_checkpoints`)
  and v234 (a column on `persistence_host_bindings`) cap themselves at 30
  seconds. They touch a sample, a small table or only the catalog.

**When it still happens.** gbrain records the timed-out migration (config
`schema_migration_timeout`, deleted once a run reaches head). Apply-migrations
and doctor then name it and give the fix for the case:

1. **This release batches a migration that timed out without batching.** Run
   `gbrain apply-migrations --yes`.
2. **Idle-in-transaction sessions were open.** They may hold locks on the
   table. Check them with `gbrain doctor --locks`. With the user's agreement,
   end the ones that are still open on the database host
   (`SELECT pg_terminate_backend(<pid>)`), then run
   `gbrain apply-migrations --yes`.
3. **No idle session was seen.** A plain rerun fails the same way. With the
   user's agreement, run it once with a longer budget:
   `gbrain apply-migrations --yes --statement-timeout 120` (whole minutes;
   `0` removes the limit). While it runs, the migration holds its table locks,
   so writes to that table wait. Please also report it, so the migration can be
   batched.

`--statement-timeout` is operator-only and applies to that run only. It sets
the budget for migration SQL and for the batches above. It doesn't lift the
30-second caps that v160, v200 and v234 set on themselves, or the timeouts of
migration handlers.

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

Doctor also warns when the last three dream `patterns` or `synthesize`
subagent children died at their own subagent timeout, even though each
maintenance job completed (the phase records a partial result). Raise that
child's timeout with `gbrain config set dream.<phase>.subagent_timeout_ms <ms>`;
`gbrain dream --phase <phase>` reruns it and spends model tokens, so ask the
user first. The warning clears once that phase's next child completes.

## Global maintenance stalled

**Doctor reports `global_maintenance_stalled`, or `gbrain autopilot --status`
exits 1 with a `Global maintenance:` line?** A brain-wide maintenance pass
stamps `autopilot.last_global_at` only when no phase blocked it. Each blocking
phase keeps a streak in `autopilot.global_maintenance.progress`, keyed by why
it blocked: `fail:<code>` (the phase failed), `budget`, `child:<outcome>` or
`deferred`. After a phase fails with the same code in three passes in a row,
later passes stamp past it (the job result lists it under
`pass_completed_with_failing_phase`) and the phase backs off: it is skipped
for two global intervals, then four, up to a day. A `deferred` streak
(synthesize triage left transcripts for the next pass) lets a pass stamp past
it once the deferred count has not shrunk for three passes in a row; while the
count keeps shrinking, the stamp waits. Budget and child blockers never let a
pass stamp past them; child failures back off too. A phase that fails with a
run-scoped code (a missing table, `permission_denied`, `write_quota_exhausted`,
`recovery_required`) is a `fail:<code>` streak like any other failure, and
the pass goes on to the next phase. A lost connection or contention stops the
job and the next job retries that phase first, at most three jobs in a row;
after that it is the phase's streak and the pass goes on. A phase skipped for
`insufficient_cycle_budget` after another phase ran in the same job moves to
the next job instead of counting as a `budget` streak.

Doctor warns when the stamp is older than three global intervals
(`autopilot.global_floor_min`, 60 minutes by default) while maintenance jobs
failed or a phase streak is active, fails once it is a week old, and also
warns while passes stamp past a phase that keeps failing. The message names
the phase, its blocker key and back-off, or the last failed job.

1. Run the named phase in the foreground to see its error:
   `gbrain dream --phase <name>`. LLM and embedding phases spend tokens, so
   ask the user first. With no phase named, read the failed job:
   `gbrain jobs get <id>`. For a `deferred` streak, doctor names
   `gbrain dream retriage` instead: preview with
   `gbrain dream retriage --dry-run`, then run it to judge the whole backlog in
   one pass without the `dream.triage.max_ms` window (paid; it asks before
   spending more than a few dollars). It reads conversation pages too, so it
   works on `dream.synthesize.conversation_pages` brains.
2. Fix the cause the error names, then end the back-off so the next pass
   runs the phase again: `gbrain autopilot --retry-global --phase <name>`
   (without `--phase`, every backed-off phase). The streak count stays, so a
   phase that still fails backs off again. Upgrading gbrain drops every
   streak, and a phase that fails for a different reason starts a new one.
3. Confirm with `gbrain doctor --only global_maintenance_stalled`: it is `ok`
   after a pass completes with the phase passing.

## Content-drift sweep

**Doctor reports `content_drift_sweep` as a warning, or an embed run prints
`content-drift sweep ... FAILED`?** Every `embed --stale` run, embed job and
embed-backfill job runs the content-drift sweep: it re-queues chunks whose text
changed after their vector was computed (`embedded_text_hash` no longer
matches `md5(chunk_text)`). The sweep examines 5,000 chunk rows per statement
in id order and commits its cursor with each batch, in the config row
`embed.content_drift_sweep.<column>.<scope>`, so a pass spans as many runs as
it needs; one run sweeps for at most 60 seconds. After a pass completes, the
next starts once `embed.content_drift.pass_interval_hours` have passed (24 by
default; 0 repeats it every run). A pass that fits in one batch repeats on
every run. The run's result carries `content_drift` (`contentDrift` on
embed-backfill): rows checked and invalidated, the cursor, and `state`
(`complete`, `partial`, `waiting`, `stopped`, `failed`, or `unsupported`
on a schema before migration v133).

A failed batch commits nothing and leaves the cursor before it; the embed run
goes on with the rest of its work and the next run retries the batch. Search
already ignores a vector whose text changed, so a stalled sweep delays
re-embedding, not answers.

1. Read the error: `gbrain doctor --only content_drift_sweep --json` names the
   scope, the chunk id and the message.
2. Fix what it names (a lock held by another session, a statement timeout far
   below one batch, a database error), then run `gbrain embed --stale`. It
   spends embedding tokens, so ask the user first.
3. Confirm with `gbrain doctor --only content_drift_sweep`: it is `ok` once a
   batch commits.

## auto_chronicle has no effect

**Say to your agent:** *"Why aren't my meetings showing up as timeline events?"*

Automatic event extraction is on by default. See the
[Life Chronicle guide](life-chronicle.md) for what qualifies, the cost, the
three-step check, and the skip codes. `gbrain doctor` reports it as the
`auto_chronicle` check. To turn it off, run
`gbrain config set auto_chronicle false`.

## Upstream rewritten

<a id="upstream-rewritten"></a>

**Say to your agent:** *"My brain repo's remote was force-pushed and sync keeps saying the pull failed. Fix it without losing anything."*

A classic source that syncs with pull fast-forwards its checkout to the
upstream. When that is impossible, the sync still imports local HEAD (nothing
is blocked) and records what it found; the sync result (`upstream` in
`gbrain sync --json`), `gbrain sources status <id> --json` and doctor
`sync_failures` report it with the next step. It is never a sync-failure ledger
row, and the next pull that fast-forwards (or finds nothing to do) clears it.
Before every fetch the sync records the upstream commit the checkout contains,
so the cases are told apart:

- `upstream_rewritten`: the upstream commit the checkout last contained is not in
  the new upstream history, so someone force-pushed. A merge would bring back
  the commits that push removed, so the fix is a reset after the user agrees:
  preview `gbrain sources reset-upstream <id> --expect-local <sha> --expect-upstream <sha> --dry-run`
  (doctor prints the exact command), then run it without `--dry-run` and
  `gbrain sync --source <id>`.
- `upstream_unknown`: the checkout and upstream diverged and nothing usable was
  recorded (the first pull after an upgrade, after an earlier fetch already
  brought the rewrite in). Same fix; the preview names any local commit that
  was never on the upstream.
- `upstream_diverged`: the checkout has its own commits and the upstream moved
  forward normally. Run `gbrain git commit-push --pull --path <checkout>`, then
  `gbrain sync --source <id>`.

Nothing is classified while a rebase, merge, cherry-pick or revert is in
progress in the checkout. `reset-upstream` takes the checkout's commit lock
and changes nothing (`reset_upstream_refused`) when HEAD or the upstream moved
since the command was printed (`expect_mismatch`: sync again for a fresh
command), when tracked files have uncommitted edits (`dirty_tree`), or when a
local commit was never on the upstream (`local_commits`: it names them and the
backup ref a reset would create; push or re-apply them first). Otherwise it
keeps the old HEAD under `refs/gbrain/backup/<UTC stamp>-<sha>`, runs
`git reset --keep` to the upstream and verifies HEAD before it reports
`reset`. To get the old history back: `git log <backup ref>`.

## Sync freshness: no successful sync recorded

<a id="sync-freshness-no-successful-sync"></a>

**Say to your agent:** *"Doctor says my source was never synced, but a sync keeps running. What's going on?"*

A sync stamps a source's `last_sync_at` only when it succeeds, so a source whose
syncs keep ending `partial` or failing has none, however many pages it imported.
`gbrain doctor` keeps freshness and sync outcome apart for such a source:

- **First sync running** (`warn`, code `sync_first_run_in_progress`): the source
  holds a live sync lock inside the staleness ceiling. Running is not fresh, and
  a second sync only contends for the lock, so the fix is to wait and re-run
  `gbrain doctor --only sync_freshness --json`. A lock held past the ceiling
  reads as wedged (`fail`) with its `--break-lock` command.
- **No successful sync recorded** (`fail`, code `sync_no_successful_sync`): no
  sync is running. The message names the last attempt, read-only from the newest
  `sync` job and (on a managed brain) `gbrain sync status`: its time, result
  (`failed`, `completed (partial)`, a managed error code) and held files, or
  `no attempt recorded`. `details.no_successful_sync[]` carries each source's
  `reason` and `fix`:
  - `attempt_queued`: a sync job is queued or running; wait.
  - `holds_pending`: files are held; inspect them with
    `gbrain sync status --source <id> --json` and follow its `next`.
  - `last_attempt_unsuccessful`: read the job (`gbrain jobs get <id> --json`)
    or the managed failure, then retry.
  - `no_attempt`: run `gbrain sync --source <id>` (`--no-pull` on a managed brain).

## Relative source path

<a id="relative-source-path"></a>

**Say to your agent:** *"Sync refused with `sync_anchor_relative`, or doctor warns that my default source's local_path is relative."*

A source's stored directory (`sources.local_path`, or the legacy `sync.repo_path`)
must be an absolute path. A relative one such as `.` names whatever directory
gbrain runs from, so it cannot say which folder is the brain. Before #7630, a
`gbrain sync --source default` or `gbrain sync --all` run from an unrelated
folder treated that folder as the brain repo: it ran `git init`, committed
everything in it and imported its markdown. Sync now refuses
`sync_anchor_relative` (exit 3) before any Git probe, cost estimate or import,
and nothing is changed. Doctor's `default_source_local_path` check warns on
every source with a relative path, and on a relative `sync.repo_path` behind a
default source with no path.

Ask the user which directory holds the source, then do one of:

- `gbrain sources set-path <id> <absolute-directory>` points the source at that
  directory (non-destructive; it only updates the pointer).
- `gbrain sources set-path <id> --clear` clears the relative pointer. It changes
  no file or page. A `default` source with no path writes through
  `sync.repo_path` (the designed fallback), and its sync refuses until a path
  is set again. On a managed brain, a source with a canonical owner refuses
  `--clear` (`writer_transfer_required`); point it at its directory instead.

A path that is absolute only on another operating system (a Windows drive path
such as `C:\brain-example`, set by another host sharing the brain, read on Linux
or macOS) is refused the same way, as not an absolute path on this host. Use
`set-path` with this host's directory (or `gbrain config set sync.repo_path` for
the legacy key); `--clear` refuses such a path. An explicit absolute `--repo`
passes the refusal, but it never advances the sync position of a source whose
stored path is relative.

Until the path is absolute, the main readers do not treat the folder gbrain
runs from as the source either: page and fact writes skip the file and stay in
the database (`repo_not_found`, `no_repo_configured`), a captured file keeps
no origin path, matching a folder to its source ignores the path, fence repair
edits stored pages, managed activation refuses it (`source_changed`, detail
`source_path_missing`), the dream, autopilot, per-phase and global
maintenance cycles and `gbrain maintain` run only their database phases
(a cycle run on a directory that matches no registered source fails its
sync phase `sync_anchor_relative` while the `default` source's path is
relative),
`sources set-path` does not count it as another source's tree, the
write-through leak guard counts a live source's relative path as owning any
tree (so every source with no `local_path`, the `default` source and any
`.sources/<id>` source, saves its pages to the database only, `source_repo_belongs_to_other_source`, until that path is set
or cleared), `gbrain autopilot
--install` asks for `--repo`, a remote `submit_job` for the source is
refused, import does not count the folder as a configured root or stamp it
fresh, and a managed brain does not record it as a managed root. A few other
local commands may still read it from the folder they run in, so set the path
first. A managed brain that ran before this fix may already have recorded the
folders it ran from as managed roots; those records stay until an operator
drains them (tracked in #7646).

For `sync.repo_path`: `gbrain config set sync.repo_path <absolute-directory>`.
`config set` refuses a relative value and writes nothing.

If an earlier sync already initialized and imported the wrong folder, the user
decides what to undo: the folder's new `.git` directory and the pages imported
from it are theirs to review before anything is removed.
Verify with `gbrain sources status <id> --json` and
`gbrain doctor --only default_source_local_path --json`.
