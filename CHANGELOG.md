# Changelog

All notable changes to GBrain will be documented in this file.

Historical entries use generic identifiers for the retired hosted provider
and its removed commands.
Those identifiers and any sample command containing them are non-executable
archival labels, not supported configuration. Dates, measurements and contributor
credits are retained; no result has been reassigned to another provider. Original
identifiers and attribution are available in the pre-removal Git revision
`6040075c6cb95be5881cc2e1b76ef7d71f4e5d29` (retained on 2026-09-23).

## [Unreleased]

**Two installs at once no longer drop each other's instruction-ledger entry, and a Codex skills opt-out reaches the file Codex used before.** Every install lane reads the brain-first ledger (`~/.gbrain/agent-instructions.json`) or the skill-loading ledger, edits the instruction file and rewrites the ledger. Two installs at once (say `setup claude-code` and `setup codex`) could each read the ledger before the other wrote it, and one entry was lost; a later opt-out then left that block, and its Claude Code allow rule, in place. Each install now holds one shared lock for the whole step, and the second waits for the first. Separately, Codex loads `AGENTS.override.md` when it is non-empty and `AGENTS.md` otherwise, so an explicit skills opt-out made after the override appeared left the index in `AGENTS.md`, where it came back once the override was removed.

### Itemized changes

- The brain-first and skill-loading ledgers share one lock (`~/.gbrain/agent-instructions.lock`), held across each install step: the ledger read, the file edit, the Claude Code permission edit and the ledger write (#8484). An install that cannot take it within 10 seconds, or cannot create it, changes nothing and reports why (the skills outcome's reason is `ledger_locked`). A dry run takes no lock.
- `gbrain setup codex --skill-loading off`, `--no-instructions` and `GBRAIN_SKILL_LOADING=off` also strip a spring index gbrain recorded in the other global instruction file of the same `CODEX_HOME` (`AGENTS.md` or `AGENTS.override.md`), and report it as a second skills line (`paired` in `--json`), in `--dry-run` too (#8485). A plain re-run strips nothing, and no other Codex home, OpenClaw workspace or Claude profile is touched.

## [0.60.559.0] - 2026-11-03

**`gbrain setup <harness> --skill-loading spring` can now give an agent a short index of gbrain's bundled skills instead of the full skill text.** Today gbrain either reaches the agent with no skill text at all, or copies every skill into the harness's native skills directory, where Claude Code lists about 87 skills on every turn and usually ignores them. With `--skill-loading spring`, setup writes a compact index (one line per skill: name and trigger) beside the brain-first block in the harness's instruction file, and the agent loads a skill's full text only when it needs it, with `<gbrain> bundled-skill <name>`. The option is off by default, and `MCP get_skill` is unchanged. In an A/B eval on real Claude Code and Codex CLIs with three frontier models (gbrain-evals#192), the index got the agent to load the right skill before acting in 29 of 36 Claude Code trials, against 15 with native skills and 0 with no skill text, and tied native on Codex at 22 of 24, for about a quarter of native's standing tokens per turn.

### Itemized changes

- `gbrain bundled-skill [<name>] [--asset <path>] [--json]`: prints a bundled skill's text, or a file it links, from inside the binary. It needs no brain or engine, and on a thin-client install it serves only the skills that apply there (host-only skills such as `db-repair` are refused with `skill_not_found`).
- `--skill-loading off|spring` on `gbrain setup` (Claude Code, Codex, OpenCode, OpenClaw, Hermes, Cursor), `gbrain connect --install` and `gbrain bootstrap harness`, plus `GBRAIN_SKILL_LOADING`. The choice is recorded in `~/.gbrain/skill-loading.json`, so a re-run keeps it. `--no-instructions` and `--remove` take the index out with the brain-first block.
- The index names the absolute launcher the install recorded. Setup refuses to write it when that launcher serves a different skill catalog or fewer skills than the index lists, and on a thin client the index lists only the skills the loader serves there.
- Claude Code gets one narrow allow rule, `Bash(<launcher> bundled-skill:*)`, so a skill load doesn't stop for a permission prompt. Setup removes the rule on opt-out only when it added it. `gbrain setup <harness> --skills-index-only` refreshes the index after an upgrade and keeps the rule in the Claude profile the install recorded.
- `gbrain doctor`: harness_wiring reports a stale, missing or damaged index and warns when its launcher is gone or the record cannot be read. resolver_health reads past the index block (an unterminated block hides nothing), and skill_currency no longer counts indexed skills as missing from the native directory.
- `scripts/check-skills-embedded.sh` (in verify) proves a compiled binary serves every bundled skill file byte-identical to `skills/`.
- Two known issues remain on the opt-in path. Concurrent installs can lose a skill-loading ledger entry (#8484, shared with the brain-first ledger), and `setup codex --no-instructions` leaves an index in `AGENTS.md` after `AGENTS.override.md` takes over (#8485).

## [0.60.558.0] - 2026-11-03

**The QM guide and the admin guide now warn that the attest client belongs only on QM's personal-scope memory route.** An attested call reads as the named person, including their own private facts, and gbrain can't tell who else reads the answer. Registering that client as a model-callable MCP connector, or routing it to a shared scope (a channel, group, project, team or the org), could show one person's private facts to a whole room. Shared conversations wait for `x-qm-audience` (wave 2). Docs only: no behavior changes.

## [0.60.557.0] - 2026-11-03

**SkillOpt rollouts now see the same tool errors MCP callers get.** When a read tool refused or failed during a SkillOpt rollout, the model saw only the error's one-line message. MCP callers get the full error for the same call: its code, the suggestion and a runnable `fix`. So skills were tuned against a weaker error surface than real callers read. Both SkillOpt registries (the read-only rollout registry and write-capture) now hand the model the error text a read-scope HTTP MCP caller receives for the same call, and they keep `code` for callers that branch on it. A fix names only tools the rollout offers. MCP output is unchanged. Write ops keep refusing as before.

### Itemized changes

- `src/mcp/dispatch.ts` (`asAgentToolError`): turns a failed read into an error whose message is the MCP error text for the same call, rendered for the caller's grant (a read-scope reader when the loop has none) and the loop's own tools. An AI invocation policy stop passes through unchanged, because the tool loop rethrows it.
- `src/core/skillopt/rollout.ts`, `src/core/skillopt/write-capture.ts`: read handlers throw that error, naming the source the read used.
- `test/skillopt-rollout-agent-errors.test.ts`: on both registries, a two-selector refusal and a missing-page error read exactly as a read-scope MCP caller gets them, including the suggestion and the runnable fix. A policy stop passes through, and a revoked remote grant reads `permission_denied`. The four parity cases fail on master.

## [0.60.556.0] - 2026-11-02

**Mounted brains stop sharing settings and search telemetry.** In a process that serves several brains, search telemetry for every brain was written into the first brain's database, and a handful of per-brain settings were read once from whichever brain asked first and then applied to all of them. Each of those caches now belongs to its engine, and each engine gets its own telemetry writer, which stops its timer when the engine disconnects and keeps its buffer for a reconnect. A process with one brain behaves exactly as before. Contributed by @bradgessler (#8454).

### Itemized changes

- `src/core/engine-key.ts`: `engineKey(engine)` resolves a page-transaction clone, a read-through view and a statement-deadline wrapper to the engine behind them. Every cache below keys on it.
- `src/core/search/telemetry.ts`: one writer per engine (`getTelemetryWriter(engine)`), held weakly, flushing only into its own engine. The disconnect drain bounds every live writer. A disconnect suspends the writer (no timer, buffer kept), so a PGLite reconnect, which is a disconnect and a connect, still flushes what was buffered; a collected engine retires its writer. `setEngine` is gone.
- Keyed by engine: `search.track_retrieval` (`last-retrieved.ts`), `persistence.publication_ceiling_ms` and the idle bound derived from it (`publication-deadline.ts`), the minion admission policy (`admission.ts`), the `mcp.strict_params` last-known-good fallback (`validate-params.ts`), the `write_capacity_low` throttle (`capacity-snapshot.ts`), and `search.hnsw_iterative_scan` / `search.vector_legacy_guard`, which are still latched once and now latched per engine.
- `test/engine-keyed-caches.test.ts`: two engines per setting, the second read after the first warmed the cache. All six behavior cases fail on master.

## [0.60.555.0] - 2026-11-02

**`gbrain query --limit N` without a token budget returns N rows again, a budgeted facts block takes at most N rows, the facts block never outscores the pages, and the CLI names fact rows instead of printing `undefined` (#8411).** Since the facts block went on by default (v0.60.491.0), it also ran on queries that passed no budget, because the shipped no-budget evidence plan carries an implicit 24,000-token budget. Its 22% share let up to 40 fact rows in ahead of the pages, so `--limit 3` could print more than a dozen fact rows before the 3 pages. Each block row was scored a hair above the top page, so they all showed the same score and outranked every hit, and the human CLI printed them as `[0.84xx] undefined -- …` because fact rows have no page slug.

### What changed

| Situation | Before | Now |
|---|---|---|
| `query` without `token_budget` (CLI or MCP) | the facts block ran on the implicit budget: up to 40 fact rows on top of `limit` pages | the block does not run; the facts arm fills only free slots, so `limit` caps the whole result |
| `query` with `token_budget` | up to 40 block rows (22% of the budget), whatever the `limit` | up to 40 block rows, 22% of the budget and at most `limit` rows, still oldest first ahead of the pages |
| Block row `score` | top page score + n × 1e-6: above every page | the top page's score: placed first, never ranked above a page |
| Human CLI line for a fact row | `[0.84xx] undefined -- [observed …]` and the fact text on a second line | `[0.84xx] fact:<fact_id> <entity slug> -- [observed …] <fact text>` on one line |

The contract: `limit` caps the page rows. Without `token_budget`, saved facts only fill free rows, so the result never exceeds `limit`. With `token_budget`, the facts block adds at most `limit` rows (and at most 40, within 22% of the budget) ahead of the pages. `--json` rows already carried `fact_id` and keep it. The held-out arm that earned the default (`token_budget` 5,500, `limit` 25, a mean of 7.5 fact rows) runs the same block. `search.query_facts_block` stays on by default.

## [0.60.554.0] - 2026-11-02

**The admin UI loads again on installed builds, and setup, doctor and MCP verify stop failing on a set of install and serve shapes.** `/admin`, including the OAuth consent page, was blank on every installed build because `admin/dist/index.html` loaded a bundle the embedded manifest didn't carry. It is rebuilt from source, and `check:admin-embedded` now runs in verify so the two can't drift again. Migration 0.53.0's packaged-skill install no longer fails `idempotency_conflict` when a later release ships a different payload. `gbrain setup` refuses the bootstrap harness lane only when that lane wired the same configuration it would write, so one `GBRAIN_HOME` can serve several HOMEs. Doctor and the turn-rule lane now count a gbrain hook in Claude Code's managed settings. `gbrain mcp verify` saves its fixture under its own folder, so a nearby page no longer makes remember refuse it. On the MCP side, `get_versions` and `known_as_of` stop pointing at a `get_page` read that doesn't exist, schema inspection uses the caller's own source pack, and `open_loops` explains an empty answer when none of a scoped caller's sources is a Google source, without revealing anything outside its grant.

### Itemized changes

- `admin/dist`, `src/admin-embedded.ts`: rebuilt from `admin/src` (the fresh build is byte-identical to the embedded bundle; the stale one goes). The generator no longer stamps the date, and `check:admin-embedded` runs in verify. `test/admin-embedded-manifest.test.ts` (#7126).
- `installPackagedSharedSkills`: the durable adoption id digests the request id with the skills and initial files, so an exact replay resumes and a changed payload gets its own key. `test/shared-skills-packaged-key-7734.test.ts` (#7734).
- `gbrain setup`: the `harness_lane` owner conflict applies when a recorded harness target sits in the config directory setup would write (paths compared after resolving symlinks, so another spelling of the same HOME still counts), when the harness wired project-scoped hooks, or when the receipt records no paths for that host. `test/setup-harness-lane-scope-7771.test.ts` (#7771).
- `inspectTurnHook` and `turnRuleHookYields` read `managed-settings.json` and its `managed-settings.d/*.json` drop-ins in the platform system directory. A managed turn-rule entry never makes the turn-rule lane yield to itself, and the install check names a managed hook as one it does not run. `test/turn-hook-managed-settings-8057.test.ts` (#8057).
- `gbrain mcp verify`: the memory-writer fixture lives under `gbrain-verification/<fixture>`; the entity resolver is unchanged. `test/harness-verify-entity-fixture-7699.test.ts` (#7699).
- `get_versions` / `known_as_of`: a segmented version's `body_ref` carries `version_id` and `total_bytes` only (#7800).
- `get_active_schema_pack`, `schema_explain_type`, `schema_graph`, `schema_lint`: resolve the pack through the caller's own source, the same path capture uses. `test/schema-pack-source-inspection-7942.test.ts` (#7942).
- `open_loops`: a `loops_no_google_in_scope` notice for a remote caller whose read covered no Google source and returned nothing. It names only the sources the call read, all inside the grant, and stays off when the source read itself failed; the result is byte-identical with and without sources outside the grant. `test/loops-remote-scope-notice-7286.test.ts` (#7286).
- `test/serve-stdio-lifecycle.test.ts`: the watchdog forward-progress probe gave a 20 ms RPC loop too little headroom under a loaded runner, so one scheduler stall failed it. A forced 45 ms stall failed 3 of 3 on the old margin and passes 3 of 3 now (40 RPCs of 20 ms in a 200 ms window); the assertions are unchanged, and removing `noteForwardProgress` still fails it (#8446).
- `scripts/{test,serial,e2e}-weights.json`: shard weights refreshed from the Nov 2 nightly runs.

## [0.60.553.0] - 2026-11-02

**GPT models that fill every optional tool argument with an empty value can now read pages and walk the graph.** GPT-6.1 Sol fills optional arguments with `0`, `[]`, `{}` or `false` as well as `""` and `null`. The `""` and `null` case was fixed in v0.60.549.0, but read operations still refused the others. `get_page` refused `around_chunk_id: 0`, `lines: {}` and a `context` sent without `grep`. `traverse_graph` refused `hops: []` sent beside `depth`, `link_type` and `direction`. Twenty-seven other optional arguments refused the same way (`limit: 0` on nine read operations, `types: []`, `only: []`, `schema_version: 0`, `get_versions` `diff: false` and more). gbrain now reads these as not provided, but only where the argument's own schema rules the value out: `0` when the valid range starts above zero, `[]` when the list must not be empty, `{}` when the object needs a field, `false` on a flag that only acts when true, and `context` when there is no `grep`, since it has no effect without it. Any value inside the valid range is kept, and so is any value on an argument that declares no such rule. So the normalized call is always one the caller could have sent by leaving the argument out, and it never reads more than that call would. This runs on every path that hands model arguments to an operation: MCP over HTTP and stdio, `gbrain call`, the subagent tool registry and both SkillOpt registries.

`get_page` with `known_as_of` still refuses arguments that select a window or a view of the page, because those cut the current page's text and chunk ids and a recorded version has neither. The refusal now names each argument to drop and carries a `fix`: the same call with only the arguments a recorded-time read takes. Replaying the 651 GPT-6.1 Sol calls recorded in the SkillOpt probe, 30 of 38 `traverse_graph` calls now succeed. The other 8 send a non-empty hop chain beside `depth`. The 436 `get_page` calls that sent `context` without `grep` now pass that step and stop at the next rule, because they also send both `lines` and `bytes` (and often `around_chunk_id`), real window selectors that change the answer. Those still refuse, but `get_page`'s description and its selector parameters now say to pass at most one window selector, and the refusal's `fix` is a runnable single-selector call built from the caller's own arguments: the first selector alone, with `body: "window"`. All 436 fixes read the page in the replay.

### Itemized changes

- `src/core/ops/contract.ts` (`ParamDef`): new schema fields `minimum`, `exclusiveMinimum`, `minItems`, `actsWhenTrue` and `appliesWith`. Only the normalizer reads them, and they are left out of the advertised tools/list schema.
- `src/mcp/validate-params.ts` (`normalizeOptionalParams`): drops the values those fields rule out, plus `{}` on a read operation's object whose properties require a member (a write keeps `{}`, so `edit_page within: {}` still refuses). It then drops any argument whose `appliesWith` argument is absent. Required arguments are never touched.
- Read operations declare the fields where a sweep of every read operation showed the value refuses: `minimum: 1` on the swept limits, ids, `max_bytes`, `return_window`, `schema_version` and `min_n`; `exclusiveMinimum: 0` on `search_exact` `max_seconds`; `minItems: 1` on `types`, `only` and `hops`; `actsWhenTrue` on `get_versions` `diff`; `appliesWith: 'grep'` on `get_page` `context`.
- `src/core/ops/get-page-body.ts`, `src/core/ops/pages.ts`, `src/core/ops/get-page-slice.ts`: the get_page description and the `lines`, `bytes`, `around_chunk_id`, `cursor` and `context` descriptions state the one-selector rule. The two-selector refusal names the selectors to drop and carries a read `fix`. `test/mcp-schema-budget.test.ts`: the starter list ceilings and the get_page budget rise by 100 characters for that sentence.
- `src/core/ops/known-as-of.ts`: the `known_as_of does not combine with …` refusal names the arguments to drop for the caller's transport and carries a read `fix`.
- `test/tool-args-empty-optional-sol.test.ts`: a table test over the sweep's 29 cases on every entry point (each one refuses on master), checks that in-range and non-empty values still refuse, and replays the Sol shapes for `get_page` and `traverse_graph`.

## [0.60.552.0] - 2026-11-02

**A master-red flake in the deferred-publish synthesis test is fixed.** `test/managed-synthesis-postprocess.test.ts` "#5854: a postprocess publish still pending after its wait is deferred, then finished by the next ordinary cycle" released the writer lock before disposing the in-process persistence consumer. Whenever the consumer drained the deferred publish in that gap, the "next ordinary cycle" found nothing left to write, and `written_slugs` came back `[]` (master run 41476223139, shard 14). The test now disposes the consumer before it releases the lock, so the next cycle is the only thing that can finish the publish. The assertions are unchanged. Forced probe: a 1.5 s pause after the lock release fails the old order with the exact CI diff and passes the new order (3 of 3).

## [0.60.551.0] - 2026-11-02

**The nightly opencode door now gates its nonce check on a paid Haiku turn, and a free-tier refusal fails in seconds with its reason instead of after eight silent minutes (#6049).** OpenCode's anonymous free models now cap usage per IP, and CI runners hit the cap. Past it, `opencode run` waits out the server's retry-after, which is hours, and prints nothing, so the keyless check timed out twice (about 487 s) with an empty reply and Heavy Tests went red on days the runner's IP was capped. The only trace was a `stream error` line in opencode's own log file. The paid check also could not have run in CI, because the test preload strips `ANTHROPIC_API_KEY` unless `GBRAIN_TEST_KEEP_PROVIDER_KEYS=1`, so a requested paid tier refused itself as keyless.

### What changed

| Situation | Before | Now |
|---|---|---|
| Free-tier quota refusal during a door turn | two 240 s timeouts, then `Expected to contain: "kestrel-…" Received: ""` | the turn ends on the logged refusal; the test fails in about 11 s with `provider error(s): AI_APICallError: Free usage limit reached…` and makes no second attempt |
| Nightly Heavy Tests, opencode door | keyless lane gates on 5 tests, including the free-tier nonce check (T4) | keyless lane gates on T1-T3 (4 tests); the credentialed lane runs every night and its paid nonce check (T5) gates; T4 runs only in the non-gating latest-version canary |
| Paid nonce check model | `anthropic/claude-haiku-4-5` | `anthropic/claude-haiku-5-5`, validated against `opencode models --refresh` before any spend (1.18.18's bundled catalog predates it) |
| Credentialed lane in CI | `ANTHROPIC_API_KEY` stripped by the test preload, so the paid tier refused to run | the step sets `GBRAIN_TEST_KEEP_PROVIDER_KEYS=1`; one Haiku turn a night |

### Itemized changes

- `test/helpers/agent-harness.ts`: `opencodeOneShotTurn` reads main-turn `stream error` lines from `<XDG_DATA_HOME>/opencode/log` written during the turn, returns them as `streamErrors`, and ends the turn on a quota refusal (`providerRefusal`). A provider rate limit, which opencode retries through, does not end it. `runOneShotSpawn` takes an `abortWhen` poll, and once it kills the child, a descendant that holds the output pipes open gets 8 s instead of the rest of the timeout.
- `test/helpers/agent-harness.unit.test.ts`: stub-binary probes pin the quota fast-fail (it hangs to the timeout without the fix), the fast-fail with a descendant holding the pipes, a transient error and a rate limit that opencode recovers from, and per-turn log offsets.
- `test/e2e/install-real-opencode.serial.test.ts`: T4 runs only with `GBRAIN_REAL_OPENCODE_FREE_TIER_E2E=1`, adds logged stream errors to its provider-error message, and skips its second attempt after a quota refusal. T5 pins `anthropic/claude-haiku-5-5`, refreshes the model list before its spend gate, and, like T4, reads the turn's JSON events and requires a `gbrain_*` MCP tool call, since opencode's file tools could find the nonce without one.
- `.github/workflows/heavy-tests.yml`: the schedule requests the credentialed lane (`GBRAIN_PAID_LANES=0` still turns it off), the keyless lane expects 4 passes and its summary warns that no nonce check gates the run when `GBRAIN_PAID_LANES=0`, the credentialed step keeps provider keys, and the canary sets `GBRAIN_REAL_OPENCODE_FREE_TIER_E2E=1`. `test/scripts/heavy-door-workflow.test.ts` pins all four.
- `docs/mcp/OPENCODE-CLI-PIN.md`: the per-IP free cap, where its trace is logged, the new gating split and two triage rows.

**A merge slot's full-ci runs can now clear gstack's remote gate on their own, so each tree runs the full suite once.** `gstack-pregate clear --remote pregate.json/remote_gate --run <Test run> --run <E2E run> --allow-repo-commands` verifies both runs on GitHub (same tree, both full jobs green in the newest attempt, no newer red run, under 24 hours old) and checks that the files they executed cover the gate's inventory. Checked against Test run 41342917113 and E2E run 41342918866 on one tree: `REUSE: accepted … tests=68132` and `PREGATE_VERIFY: ok`, with all 5,701 inventory files covered. A tree that changes the full-ci workflows or the scripts that attest their runs still can't vouch for itself. It gets no inventory, so gstack refuses those runs and the gate runs, the same rule remote-gate reuse already follows. That rule now covers seven files: `ci-manifest.ts` joins the list.

### Itemized changes

- `.gstack/pregate.json`: `run_profiles` `test` (`test.yml`, `full-suite`, artifact `full-suite-tree`) and `e2e` (`e2e.yml`, `e2e-full-suite`, artifact `e2e-full-suite-tree`), both accepting `workflow_dispatch` and `push`, plus `remote_gate_runs` with `bash scripts/pregate-remote-gate.sh --list` as the inventory.
- `.gstack/ship-policy.json`: `min_gstack_version` 1.91.377.0, the first gstack that reads these keys. An older gstack now refuses with an upgrade fix instead of an invalid-config error.
- `scripts/pregate-remote-gate.sh`: the files whose change stops a tree's own full-ci runs from attesting to it are now seven: `test.yml`, `e2e.yml`, `ci-reuse.ts`, `ci-full-suite-tree.sh`, `ci-executed-counts.ts`, `lib/gh-issue.ts` and, new, `ci-manifest.ts`, which writes the `ci-manifest.json` that `ci-full-suite-tree.sh` trusts for completeness, executed files and counts. A tree that changes `ci-manifest.ts` therefore no longer reuses its full-ci and runs the gate. `--list` refuses (no inventory) for a tree that changes any of the seven, or the inventory's own builders `pregate-remote-gate.sh` and `ci-ubicloud.ts`, relative to `origin/master`, when there is no `origin/master`, and under `GBRAIN_PREGATE_REUSE=0`. Both paths run one check, and `--list` adds the two builders. `test/scripts/pregate-remote-gate.test.ts` pins this.
- `docs/ci-event-parity.md`: the profiles and the refusal.

**`ubi-runner.sh reap` now destroys only the caller's own VMs, and pack, usage and reap work on macOS and on an empty project (gstack #3756, #3746).** Reap used to destroy any owner's VM whose TTL had ended. That is how one project's `up` destroyed another lane's VMs (GST-573). Now it destroys only VMs whose owner tag equals `UBI_OWNER` and logs `reap: left N expired VMs of other owners` for the rest. The operator reaper, `reap-expired.ts`, still covers every owner. gbrain keeps `UBI_REAP=0` by default, so `up` still reaps nothing unless asked. On macOS, `pack` exited 1 under bsdtar after the VM was already created. On a project with no VMs, Ubicloud's bare-newline list read as a VM named `-`, and reap died on it. A failed size read made `usage` print a short total, which the quota preflight took as room.

### Itemized changes

- `scripts/ubicloud/ubi-runner.sh`, ported from gstack 74836e41 and 693ee713:
  - `cmd_reap` checks the owner tag first and counts other owners' expired VMs. The quota refusal says reap frees only this owner's VMs and names `usage` and `reap-expired.ts` for the rest.
  - `vm_rows` skips a blank row.
  - `cmd_usage` exits 1 with no total when the list or a size read fails, and skips a VM whose `show` answers 404.
  - `quota_preflight` retries an unreadable usage while `UBI_QUOTA_WAIT` lasts, then logs it and leaves the decision to the API.
  - `cmd_pack` builds `files.tar`, appends `.git` with `tar -rf` and gzips it, with `COPYFILE_DISABLE=1` on every tar call.
- `test/scripts/ubi-runner-run.test.ts` and `test/scripts/ubi-runner.test.ts` pin the owner-scoped reap, the empty project, the unreadable usage and `COPYFILE_DISABLE`. The six new cases and the two updated reap cases fail on the old runner. The updated cases expected another owner's VM destroyed and now expect it kept.
- `test/scripts/ubi-runner-bsd-userland.test.ts` runs `pack` under bsdtar. It fails on the old runner and is skipped where no bsdtar is installed. `test/helpers/mock-ubicloud-api.ts` gains `listBody`, `ghosts` and a `show` fault.
- `scripts/ubicloud/README.md`: reap's owner scope.

**Two test-isolation flakes are fixed (found when this release's new test file moved files between CI shards).**

- `test/context-pack-pinned-federation.test.ts` set `search.remote_private_pages=visible` and left its engine in the process-wide privacy cache, so a later test file in the same CI shard saw private pages and `test/private-visibility.test.ts` failed. Its `afterAll` now resets that cache.
- `test/db-lock-fencing.test.ts` waited a fixed 120 ms for the lock refresher's second retry, which a busy runner could miss. It now waits for eight retries, up to 5 s, so its not-aborted check still covers a run of failed refreshes, with the same assertions.

## [0.60.550.0] - 2026-11-02

**Security: the stdio MCP server and the remaining hook lanes no longer let the session directory's bunfig.toml or .env run, and the hook's git probes no longer run a checkout's core.fsmonitor (#8426, #8428, #8427, #8435, #8436).** Claude Code, Codex and opencode start user-scope stdio MCP servers in the session's directory, just as they run hooks there, so with a script-mode install the `gbrain serve` entry `gbrain setup` and `gbrain bootstrap hooks` registered ran a cloned repository's `bunfig.toml` preload once per session, with nothing to approve. The user-global opencode entry `gbrain bootstrap hooks --harness opencode` writes did the same. Those entries now start serve through the same `<gbrain config dir>/hook-launcher/gbrain-hook` the setup hooks use, and `gbrain serve` reads `.gbrain-source`, a mounted brain's persistence socket, relative `file_upload` paths and the upload root from the session directory the launcher records, without changing its own directory.

- The hooks from `gbrain bootstrap hooks` (the workspace lane), `gbrain bootstrap harness` and the Codex `SessionEnd` capture both write now start gbrain through the launcher too, and the gbrain plugins' per-turn hook changes into the plugin directory before it starts gbrain. The plugin hook now needs gbrain 0.60.547.0 or newer (it exits silently on an older CLI, which would read the plugin directory as the session's).
- `gbrain post-upgrade` moves a user-scope `gbrain setup claude-code` MCP entry setup still owns onto the launcher, checking it again under setup's lock, and takes the entry's `GBRAIN_HOME` only from hooks or an MCP entry that install's receipt owns, so another install sharing the Claude settings file never redirects it to a different brain. It rewrites no Codex entry, the turn-rule hook included (a rewrite recomputes the trust of every install's groups in the shared hooks.json): for `gbrain setup codex`'s MCP table and hooks it prints the `gbrain setup codex` command, and for every `gbrain bootstrap` entry the bootstrap command that rewrites it, run from the workspace. An entry you edited after setup wrote it is kept and named, and the refresh stops when another install replaced the receipt it planned from.
- `gbrain doctor` (`harness_wiring`, `hook_session_cwd`) now also covers the stdio MCP entries and the bootstrap, harness and Codex capture lanes, with the command that fixes each. Only a user-scope Claude Code entry setup owns gets an agent-runnable fix. It reruns the install that owns the entry with its recorded `--no-hooks`, `--source` and `--gbrain-bin`, so the rerun turns nothing on and keeps the binary the install chose instead of whatever `gbrain` is first on PATH. Every `gbrain setup codex` rerun is now the user's to run, because it rewrites the shared hooks.json and its trust.
- `gbrain hook`'s git probes run with `-c core.fsmonitor=false`, and a session outside the workspace the install receipt names runs no git at all, so a `.git/config` from an extracted archive or shared folder cannot run a command at session start.
- The readiness fix for an unwired Claude Code or Codex now names `gbrain setup <harness> --no-hooks` instead of `claude mcp add` / `codex mcp add`, so the entry it writes goes through the launcher; it also writes the brain-first block and records hooks as off. When `gbrain setup` already wired that harness, the fix reruns that install with the decisions its receipt recorded (the Codex rerun is the user's to run), so it never turns an install's hooks off. The install docs now teach `gbrain setup claude-code` / `gbrain setup codex` instead of a bare stdio `mcp add`. A project-scope `.mcp.json` and committed `.claude/settings.json` hooks stay PATH-resolved, because they belong to the repository.

## [0.60.549.0] - 2026-11-02

**GPT models that fill every optional tool argument with `""` or `null` can read pages again in SkillOpt rollouts and `gbrain call`.** GPT-6.1 Sol sends `known_as_of: ""`, `cursor: ""`, `section: ""` and `grep: ""` instead of leaving those arguments out. MCP dispatch and the subagent tool registry already treated `""` on an optional string argument, and `null` on any optional argument, as not provided. The SkillOpt rollout and write-capture registries and `gbrain call` passed the arguments to the handler unchanged. There `known_as_of: ""` sent `get_page` into its recorded-time branch, which refused with "known_as_of must be an ISO 8601 instant", so a SkillOpt probe on GPT-6.1 Sol saw every `get_page` call fail and the model answered from search snippets. The same empty arguments broke about 30 other read operations on those paths (`search`, `get_links`, `traverse_graph`, `recall`, `whois` and more). All three paths now run the same step as MCP dispatch. Empty optional arguments are dropped, then the arguments are checked against the operation's schema. A missing required argument or a non-empty invalid value still refuses with `invalid_params`. The SkillOpt registries now also refuse a wrong-typed or out-of-enum argument before the handler runs, with the same `invalid_params` error MCP returns. Over remote MCP, `memory_recall` with `acting_user: ""` or `acting_user: null` refused with `actor_not_attested`, because the attested-actor check read the arguments before they were normalized. It now reads the normalized arguments, so an empty `acting_user` means the same as leaving it out. A non-empty `acting_user` is still accepted only on an attested call and only when it matches the `x-qm-actor` header.

### Itemized changes

- `src/core/skillopt/rollout.ts`, `src/core/skillopt/write-capture.ts`: each read tool drops `""` and `null` optional arguments (`normalizeOptionalParams`), then validates (`findInvalidParam`, refusing through `schemaInvalidParams`), before calling the handler. In a rollout, the shared-skill read authorization still runs first.
- `src/mcp/server.ts` (`handleToolCall`, behind `gbrain call`): drops empty optional arguments before validation, and the handler receives the cleaned arguments.
- `src/mcp/dispatch.ts` (`dispatchToolCall`): the audience and attested-actor checks on a remote call read the normalized arguments.
- `test/tool-args-empty-optional-sol.test.ts`: drives `get_page` with every optional string set to `""`, and again with every optional argument set to `null`, through MCP over HTTP (remote) and stdio (local), `gbrain call`, the subagent registry and both SkillOpt registries. It checks that a missing slug and non-empty bad values still refuse, then sweeps every read operation and checks that empty optional arguments give the same outcome as omitting them. Reverting any one of the three fixes fails it.

## [0.60.548.0] - 2026-11-02

**Meeting notes now flow into the brain on a schedule, with no custom script.**

A new `meetings` source kind imports meetings from Fireflies (the first provider behind a provider interface) into one page per meeting: title, date, attendees, the provider's summary, action items and keywords, and optionally the transcript. You save the API key once on stdin with `gbrain connectors auth fireflies --token -` (probed before it is saved, 0600, never in argv, config or the database), add the source with `gbrain sources add meetings --kind meetings --provider fireflies`, and run the first sync yourself. After that, autopilot keeps it fresh every `--sync-interval-min` minutes (default 60) and waits out the provider's rate limit. Nothing syncs until you register a source and run its first sync.

It works on a brain with no Git repository, where pages and the sync position are recorded in the database. On a brain with a Git checkout, `--dir` inside it records each page with a commit before its database row, and a missing checkout holds the meeting instead of writing it to the database alone. The record mode is chosen when the source is added and never re-inferred.

| Situation | What happens |
|---|---|
| The key's owner did not attend the meeting | the page is private |
| A meeting the provider is still processing | re-checked every sync; published when its summary arrives (or after 48 hours) |
| A meeting edited upstream | the page updates and facts extracted from the old version are retired |
| A meeting deleted upstream (inside the lookback) | the page is deleted and its facts are retired |
| A key for a different account | refused (`connector_account_changed`) before anything is imported, even after the source's config changes |
| Summary text that looks like a facts table, citation or timeline row | made inert before it lands in the page |

Guide: [docs/guides/meeting-and-slack-sources.md](docs/guides/meeting-and-slack-sources.md).

**Slack channels can flow into the brain the same way.** A new `slack` source kind reads the channels you name through your own internal Slack app and writes one page per channel per day, in the chat layout the conversation parser reads, with thread replies under their parent. Save the bot token with `gbrain connectors auth slack --token -`, then `gbrain sources add slack --kind slack --channels C0123ABCDEF`; the add checks the token and every channel first and refuses with the fix (a missing scope, or "invite the app to the channel"). It works on a brain with no Git repository, re-reads the last 7 days on every sync so edits and deletions converge (retiring the facts of the old page), keeps private channels private and out of any Git checkout, and moves a channel that becomes private out of the checkout. A channel the app loses is held while the others keep syncing.

For both kinds, `gbrain sync --source <id> --full` re-reads the whole history window, `--dry-run` fetches and writes nothing (these sources have no preview), and `gbrain connectors status fireflies` (or `slack`) reports whether a key is saved without printing it.

### Known limits

- Fact retirement on a changed page still needs a redesign ([#8432](https://github.com/garrytan/gbrain/issues/8432)): on a managed brain a retirement can race the page's own write and is not retried if it fails, every new Slack message retires and re-extracts its whole day's facts, and facts from an unchanged prefix of a long page are not re-asserted.
- Slack ([#7971](https://github.com/garrytan/gbrain/issues/7971)): a channel window too big for the per-run request cap (`s_max_requests`) or over 500 history pages does not make progress, and in Git record mode a channel that becomes private leaves HEAD but stays in Git history.
- A meetings window with more than 20,000 meetings stops with `listing_unbounded`; use a smaller `--history-days`. `connectors status` does not read a source's `--token-env`.

## [0.60.547.0] - 2026-11-02

**Security: gbrain's hooks no longer let the session directory's bunfig.toml or .env run (#8424).** A script-mode install (`bun install -g`, `bun link`) runs gbrain as a Bun script, and Bun applies the working directory's `bunfig.toml` (a top-level `preload` runs before any gbrain code) and loads its `.env` files first. Claude Code and Codex run hooks in the session's directory, so with the hooks `gbrain setup claude-code|codex` writes, or the per-turn rule hook from `--instructions-only`, `gbrain connect --install` and `gbrain bootstrap harness`, opening a session in a cloned repository ran that repository's code as you on every prompt, with nothing to approve. Each of those hooks now starts gbrain through `<gbrain config dir>/hook-launcher/gbrain-hook`, a small sh script that records the session directory in `GBRAIN_HOOK_CWD`, changes into its own directory and starts gbrain there. Its directory holds only the launcher, and it refuses to start gbrain if anything else appears there.
