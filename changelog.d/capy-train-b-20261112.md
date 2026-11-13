**Upgrade and maintenance stability for self-hosters: upgrades are tested from real releases every night, health alerts page only on what needs someone, routine maintenance noise heals itself, an upgrade adds nothing you didn't turn on, the serve restart after a self-upgrade runs once per build without freezing the autopilot, a macOS brain on an external volume starts under launchd, a new doctor check counts session connections against the pooler limit, and twenty-one dream-cycle, doctor and repair fixes stop phantom work and false failures.**

An upgrade could break a brain an older release created with no one noticing before its users did, a weekly health alert could read "score 30" because of the agent's own skills folder, a nightly cycle could end `partial` for reasons that needed no one, and one upgrade path installed a daemon on a brain that never asked for one. This release fixes all four.

On a brain with no code, `resolve_symbol_edges` used to stamp up to 2,000 chunks per source on every run, each one a non-HOT row update on the largest table. It now skips sources with no symbol edges and walks only chunks that own one, and code-graph readiness waits on the same chunks. Several phases also misreported their own results. A drain window closing at the wrong moment read as a non-retryable `atom_drain_no_progress`, an accepted concept publication still committing failed the whole concept phase, and the managed conversation-facts backfill printed "0 facts inserted" while its facts were still publishing. Each now reports what actually happened.

`doctor embedding_state` warned that thousands of deleted-page chunks were overdue and recommended a brain-wide irreversible purge that would remove almost none of them, because the purge holds derived retirements for 30 days. It now counts overdue chunks with the purge's own predicates and reports held chunks as information. `autopilot --status` and doctor's `global_maintenance_stalled` could keep a stalled verdict for up to a day after a clean pass; the pass now refreshes it.

### Serve restart, macOS launchd and the session lane (#8144)

**The serve restart after a self-upgrade now tries once per installed build, leaves alone a serve service installed for another brain, and no longer freezes the autopilot while it runs.** #7478 had the relaunched autopilot restart the serve its installed service runs when that serve was still on the old build. Three gaps came out of its review (#8013). A restart that came back unverified was tried again by every autopilot relaunch, because the attempt was only remembered in memory. On macOS, where the autopilot doesn't filter processes by `GBRAIN_HOME`, one brain's autopilot could restart the `com.gbrain.serve` installed for another brain on the same OS user. And the restart command ran synchronously for up to ten minutes, which stopped the daemon's timers and signal handling while `systemctl --user restart` waited for the old serve to stop.

Now `serve-restart-attempt.json` under the brain's `.gbrain` directory remembers the build the restart was tried on, so each build gets one attempt across relaunches. The autopilot restarts the serve service only when its plist or unit starts this brain's own serve wrapper, and audits any other case as `skipped` / `manual`. The restart command runs asynchronously with a 120-second cap.

**On macOS, an autopilot for a brain on an external volume now starts under launchd instead of exiting 78, and an autopilot pause no longer makes the worker restart itself every ten minutes or makes doctor call the held queue wedged.** launchd opens a job's program and its log files before the job runs. When those sat on a volume other than the home folder, as they do for a brain on an external `GBRAIN_HOME`, launchd ended every spawn with exit code 78 (`EX_CONFIG`) and no pid, even though the same wrapper ran fine by hand. `gbrain autopilot --install` now detects a brain home on another volume, has launchd start the wrapper through `/bin/bash`, and writes the job's logs to `~/Library/Logs/gbrain/<label>.log` and `.err`. The wrapper and every brain file stay under `GBRAIN_HOME`, and `--status` reads the new log path. A brain on the home volume gets the same plist as before. Re-run `--install` to move an existing job onto the new layout.

An autopilot pause (`gbrain autopilot pause`, or the marker a migration sets) stops the worker's job claims. The worker's own no-progress watchdog didn't know that. With jobs waiting and nothing completing, it emitted `stalled` and the autopilot restarted its worker about every ten minutes for as long as the pause lasted. Now the watchdog restarts its clock while either marker is present, so a long pause can't trip it the moment the pause clears. The database liveness probe keeps running, and a real stall after resume is still caught. Doctor's `wedged_queue` reports a queue held by a pause as a warning that says which pause holds it and how it clears, instead of failing with advice to restart the worker.

Contributed by @Masashi-Ono0611 (reports #8017 and #7966, and the approaches in #8018 and #7968).

**New doctor check `session_lane_budget` counts this database role's session connections across every gbrain process against the pooler's limit.** Every gbrain process opens its own pools (serve's ordinary pool, each process's direct pool, a sync's import workers), and a pooler's per-role session limit (Supavisor `pool_size`) is shared by all of them. Nothing counted them together, so a host running a serve, a cron sync, a jobs worker and an MCP stdio server could exhaust the lane (`EMAXCONNSESSION`) with every process inside its own pool and no warning before the first refusal. The check reads `pg_stat_activity` once (no query text), attributes each `gbrain <kind>:<pid>:<nonce>` connection to a process kind and host, counts pooler and other connections apart, and warns at 80% of the limit with the kinds holding the most. Behind a pooler, set `GBRAIN_SESSION_LANE_LIMIT` to the pooler's per-role limit; with no pooler it compares with `max_connections` less the reserved slots. PGLite: not applicable. No default changes.

### What changed

| Situation | Before | Now |
|---|---|---|
| A migration fails, or an upgrade rewrites page content, on brains an older release created | found by users after the release | a new nightly Upgrade matrix workflow installs older releases (one, ten and fifty back, about 30 days back, and stable) the way the README says, upgrades each with its own `gbrain upgrade` on PGLite and Postgres, keyed and keyless, with and without a Git repository, and checks install, serve restart, schema head, doctor, preserved pages, facts and sources, new writes and searches, and the old binary reading the upgraded brain |
| A health alert from `gbrain doctor` | a score that counted every check, the agent's own skills folder included | `gbrain doctor --alert` runs only the page-class checks, fresh, under a 30 s budget, and exits 0 (`none`), 17 (`act`, with each check's own fix) or 18 (`unknown`, with `alert.consecutive_unknown`) |
| A skills folder doctor found by walking up from the current directory that gbrain did not install | graded against gbrain's conventions and lowered the score | reported as "not a gbrain skills folder (<path>)"; `--skills-dir`, `GBRAIN_SKILLS_DIR` and `OPENCLAW_WORKSPACE` still grade it |
| A dream purge or consolidate write accepted but still pending after the publish wait | the phase failed and the cycle ended `partial` | the phase warns `dream_write_deferred` with the receipt id and the next pass reconciles it; after 3 passes still pending, doctor `dream_write_deferred` names the receipt and pages |
| Every transcript in the synthesize window is already synthesized | triage, the manifest context and the child queue still ran | the phase returns `no_candidates` before any of that |
| A transcript grows between runs that keep dying | each run had a new content key, so the 3-deaths breaker never tripped | deaths also count per transcript file; the same 3-in-24h limit applies; `gbrain dream reset-key` accepts the `dream:phase:` keys `--list` prints |
| Pages whose chunks already hold current-model vectors but carry no or an old signature | read as another model's space until a paid drain stamped them | the embed phase stamps them first, up to 500 pages a run, with no provider call; doctor `embedding_restamp_stalled` pages when that keeps failing |
| A Postgres brain with `sync.repo_path` set and no autopilot, on upgrade | the v0.11.0 migration's Phase F ran `gbrain autopilot --install` | Phase F installs nothing (reason `not_installed`), prints the install command and doctor shows it as a `minions_migration` line; a brain that already runs autopilot gets it reinstalled as before |

### For operators

- The page class (`PAGE_CHECK_LEVELS`): connection, migrations, write failures and stalls, build skew, managed sync stopped, maintenance stalled, corrupt JSONB rows, RLS exposure, the paid-loop breaker, `dream_write_deferred` and `embedding_restamp_stalled`; the opt-in autopilot install suggestion that `minions_migration` shows after an upgrade never pages. Every doctor report carries `alert`; `health_score`, `brain_checks_score`, `category_scores` and `status` are unchanged. Cron recipe and exit codes: `docs/guides/troubleshooting.md`.
- New switches, on by default: `dream.write_deferral.enabled` and `embed.restamp.enabled`; `false` restores the old behavior. Every heal writes a row to the `heal.audit` config record (last 200 rows, 30 days). Nothing heals on upgrade, and repo-less brains get the same behavior.
- The upgrade matrix runs nightly against the newest release, opens one `upgrade-break` issue on a red run and closes it on a green one; `gh workflow run upgrade-matrix.yml -f candidate=<tag>` runs it on demand, and pull requests touching migrations, the schema or the updater run a subset. Upgrading a v0.59.2.0 brain now passes the preservation check (#7814), so the matrix carries no known exceptions. Details: `docs/ci-upgrade-matrix.md`.
- INSTALL_FOR_AGENTS.md has one **Opt-ins** list (keys and embeddings, autopilot, dream schedule, connectors, auto-upgrade, release channel), and `gbrain setup <harness>` prints one line pointing to it. The default keyless install starts no daemon, writes no service, connects nothing and keeps self-upgrade in `notify` mode, now locked by `test/boring-default.test.ts`.

### Itemized changes

Upgrade restart, autopilot and doctor (#8019, #8024, #7302, from #8144):

- `src/commands/upgrade-restart.ts`: the per-build attempt marker in `restartServeAfterSelfUpgrade`; the ownership check before `restartStaleServeService` collects processes; `hostExecutor` spawns asynchronously and kills a command past its timeout (120 s for the autopilot's serve restart, 600 s for `gbrain upgrade --restart-only` as before).
- `src/core/serve-service.ts`: `serveServiceRunsWrapper` reads the launchd plist or the systemd unit and checks that it starts this brain's wrapper.
- `src/core/upgrade-restart.ts`: `RestartExecutor.run` may return a promise, and `runRestartSteps` awaits each command.
- Docs: the Restart section of `docs/guides/upgrades-auto-update.md` and the `upgrade-restart.ts` key-files entry.
- Tests: `test/autopilot-serve-restart-8013.test.ts`.
- `src/core/autopilot-paths.ts`: `autopilotLaunchdHostPaths` compares the brain home's volume with the home folder's; on macOS `resolveAutopilotJob` takes its log paths from it and sets `launchdViaBash` for a brain on another volume.
- `src/commands/autopilot.ts` and `src/commands/autopilot/jobs.ts`: `generateLaunchdPlist` writes `/bin/bash` before the wrapper when `launchdViaBash` is set; `installLaunchd` creates the log directory; `plistWrapperPath` reads the wrapper after `/bin/bash`, so job ownership, status and uninstall keep working.
- `src/core/minions/worker.ts`: the non-supervised stall watchdog treats `autopilotPaused()` as a hold.
- `src/commands/doctor/checks/queue-jobs.ts`: `wedged_queue` returns `warn` with `details.paused` (`operator` or `cooperative`) while a pause marker is present.
- Docs: `docs/guides/live-sync.md` (log location for an external brain on macOS), `docs/guides/queue-operations-runbook.md` (a paused queue), and the `worker.ts` key-files entry.
- Tests: `test/autopilot-launchd-external-home-8017.test.ts` and `test/autopilot-pause-watchdog-7966.test.ts`.
- `src/core/session-lane.ts` (new) and `src/commands/doctor/checks/session-lane.ts` (new): the session-lane census and the `session_lane_budget` check, registered after `persistence_consumers`; `docs/ENGINES.md#pool-sizing` names the remedies. The Postgres doctor goldens mask that check's live census.
- `test/cli-socket.test.ts` classifies `GBRAIN_SESSION_LANE_LIMIT` (doctor only) and `GBRAIN_NAME` (a regex constant in `core/session-lane.ts`) as unable to change a socket read.
- Tests: `test/doctor-session-lane-gbra133.test.ts` (fixed rows, real PGLite, real Postgres), added to the Postgres unit arms with its measured weight.


Dream cycle (#8326, from #8137):

- Managed `gbrain extract --stale` counts pages waiting on an attendee's person page (`skipped_attendance_incomplete`) apart from pages edited during extraction (#6820).
- Extract receipts no longer write the reserved `type` key into frontmatter, so doctor's `stale_frontmatter_keys` stops gaining a page every run (#7058).
- `resolve_symbol_edges` stamps only chunks that own symbol edges and returns at once for a source with none; no migration and no bulk stamping (#7119).
- The atom drain reports a window that closes before a batch starts as a window stop (exit 11, retryable), not `atom_drain_no_progress` (#7826).
- The nightly `reports/drift-<date>` page counts as a derive-phase database-only page, so doctor's `ghost_pages` and `undeclared_db_only_pages` stop flagging it and `repair ghost-pages` stops proposing its deletion. The rest of `reports/` is unchanged (#8054).
- The nightly LongMemEval probe fixture anchors its relative-date questions with a `question_date`, so "last month" and "this year" are judged against the haystack, not today's date (#7308, #7501).
- The nightly probe runs its questions one at a time, so worst-case cost reservations fit the run cap; each question's judges still run together and no dollar cap changed (#7534).
- Enrich republishes a page whose new write-up ends with its own `## Timeline` section instead of refusing it as `CONCEPT_REPUBLICATION_LOSSY` every night; the page keeps its own timeline (#7663).
- `cycle.grade_takes.auto_resolve.enabled: true` now takes effect in the scheduled cycle, as documented; it stays off by default and the 0.95 threshold is unchanged (#7542).
- A concept whose member links were lost gets them back on the next run, with no model call and no duplicate links (#7548).
- On a managed brain, a concept publication still pending after its wait is reported as `publication_pending` (warn) instead of failing the phase; the next run reuses it (#7547).
- The managed conversation-facts backfill reports how many pages are still publishing instead of a bare "0 facts inserted" (#7500).
- `propose_takes` drops a claim whose exact text an operator already rejected on the same page, so an unrelated edit no longer puts it back in the queue; reworded claims are still proposed (#7299).

Doctor, repair and maintenance (#8327, from #8137):

- `doctor raw_provenance` exempts a generated page only when `raw_trace_exempt` is `true`; an explicit `false` no longer hides missing provenance (#8039).
- `doctor --fast --only <check>` marks the report incomplete when the early stop skipped a selected check (#8114).
- `doctor maintenance_write_drift` reports unknown (warn) instead of ok when candidates exist but none can be compared on this host (#8115).
- `gbrain repair <kind> --apply` keeps its approved set when the last approved item fails, so the printed `--expect` command resumes instead of refusing `preview_changed` (#8058).
- A clean brain-wide maintenance pass refreshes the verdict `autopilot --status` and doctor read, so a stalled warning clears with the pass (#7854).
- `doctor embedding_state` warns only on deleted-page chunks `gbrain pages purge-deleted` would remove; `deleted_page_chunks` gains `purgeable` and `held` (#7825).
- Maintenance preflight (dream `lint` and friends) recovers from a device-only physical-root change under the writer lock, as ordinary writes already did; any other identity change still refuses and a busy lock still fails closed (#7760).
- Purging a deleted page drops that page's held fence generations, which no later write could settle, so doctor `generation_held` no longer warns about a page that no longer exists (#7774).

<!-- behavior-change: propose_takes_rejected_memory_7299 -->
<!-- behavior-change: grade_takes_auto_resolve_7542 -->
<!-- behavior-change: dream_write_deferral_w3 -->
<!-- behavior-change: synthesize_no_candidates_w3 -->
<!-- behavior-change: embedding_restamp_w3 -->
<!-- behavior-change: doctor_foreign_skills_folder -->
<!-- behavior-change: upgrade_installs_no_autopilot -->
<!-- behavior-change: session_lane_budget_gbra133 -->
