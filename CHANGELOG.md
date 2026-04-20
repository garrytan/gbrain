# Changelog

All notable changes to GBrain will be documented in this file.

## [0.15.0] - 2026-04-21

## **GBrain now talks to LLMs the way modern docs sites do.**
## **One URL, full context. Three files, zero drift.**

Three new artifacts ship at the repo root: `llms.txt` (llmstxt.org-spec index), `llms-full.txt` (same map with core docs inlined, ~225KB, fits well under a 150k-token context window), and `AGENTS.md` (the non-Claude-agent operating protocol). All three are generator-driven. `scripts/build-llms.ts` reads a curated `scripts/llms-config.ts` and emits `llms.txt` + `llms-full.txt` deterministically; `AGENTS.md` is hand-written and uses relative links so it survives forks and rename. Every agent that clones GBrain now has a one-screen answer to "I just got here, what do I do?"

README and `INSTALL_FOR_AGENTS.md` now point agents at `AGENTS.md` first. The old install prompt still works, but the leverage point, Codex's read of the plan, was that these files are invisible unless the install path references them. Fixed.

### The numbers that matter

Measured on this release:

| Metric                                          | BEFORE                          | AFTER                            | Δ                          |
|-------------------------------------------------|----------------------------------|-----------------------------------|----------------------------|
| Agent entry points with clear install protocol  | 1 (CLAUDE.md, Claude Code only) | 3 (CLAUDE.md + AGENTS.md + llms.txt) | +non-Claude coverage       |
| Docs referenced at a single canonical URL       | 0                               | 20 (across 5 H2 sections)        | index exists               |
| Full-context fetch round-trips                  | ~20 (one per doc)               | 1 (`llms-full.txt`, 224 KB)      | ~20x fewer fetches         |
| Tests guarding the doc index                    | 0                               | 7 (paths resolve, idempotent, spec shape, regen-drift, content contract, AGENTS mirror, size budget) | +7                         |
| Pre-existing repo bugs found and fixed          | —                               | 1 (`git pull origin main` → `master`) | drive-by                   |

The 7 tests enforce content contract: removing `skills/RESOLVER.md` or the Debugging H2 from the config fails `bun test`. Forgetting to rerun `bun run build:llms` after adding a new doc fails `bun test`. The size budget (600KB) fails `bun test` if `llms-full.txt` balloons.

### What this means for you

If you're running GBrain: nothing to do. Your agent already has CLAUDE.md. But next time you install GBrain on Codex, Cursor, or OpenClaw, the agent lands on `AGENTS.md` and walks the install without hunting. If you run a fork, regenerate with `LLMS_REPO_BASE=https://raw.githubusercontent.com/your-org/your-fork/main bun run build:llms` to rewrite URLs. If you publish GBrain docs alongside your own, `llms.txt` is the index; `llms-full.txt` is the drop-into-a-context-window bundle.

Credit to Codex for catching that the original plan's AGENTS.md was underpowered, that the eng review missed a content-contract test, and that the install prompt was the real leverage point. Seven of the fifteen Codex findings landed directly in the plan; three went to user decision; five stayed as intentional NOT-in-scope.

## To take advantage of this release

`gbrain upgrade` does not need to do anything. These are new public files; existing installs pick them up on their next pull.

1. **If you wrote a downstream fork:** regenerate with your URL base.
   ```bash
   LLMS_REPO_BASE=https://raw.githubusercontent.com/your-org/your-fork/main bun run build:llms
   git add llms.txt llms-full.txt && git commit
   ```
2. **If you add a new doc under `docs/`:** add it to `scripts/llms-config.ts`, then
   ```bash
   bun run build:llms
   bun test test/build-llms.test.ts
   ```
   CI blocks ship if these drift.
3. **Verify it actually works:** ask a fresh LLM
   ```
   Fetch https://raw.githubusercontent.com/garrytan/gbrain/master/llms.txt and tell me
   how I'd debug a broken live sync.
   ```
   Answer should cite `docs/GBRAIN_VERIFY.md`, `docs/guides/live-sync.md`, and `gbrain doctor`.

### Itemized changes

#### Added
- `AGENTS.md` at repo root — ~45-line non-Claude-agent operating protocol. Install, read order, trust boundary, config/debug/migration pointers, fork instructions. Uses relative links so it survives renames.
- `llms.txt` at repo root — llmstxt.org-spec index. H1 + blockquote + 5 required H2 sections (Core entry points, Configuration, Debugging, Migrations) plus an Operational tips block with `gbrain doctor`, `gbrain orphans`, `gbrain repair-jsonb`. ~4KB.
- `llms-full.txt` at repo root — same index with core docs inlined under `## {path}` headings for single-fetch ingestion. ~225KB, under the 600KB `FULL_SIZE_BUDGET`.
- `scripts/llms-config.ts` — curated TS config. `LLMS_REPO_BASE` env var lets forks regenerate with their own URL base. `includeInFull: false` flags entries that should appear in `llms.txt` but not be inlined in `llms-full.txt` (Philosophy, Optional, CHANGELOG).
- `scripts/build-llms.ts` — the generator. Deterministic, no timestamps, sorted by config order. Warns (does not fail) if `llms-full.txt` exceeds `FULL_SIZE_BUDGET` with the biggest entries listed.
- `test/build-llms.test.ts` — 7 cases: paths resolve on disk, generator idempotent, llms.txt spec shape, checked-in files match generator output (drift guard), content contract (RESOLVER / AGENTS / INSTALL_FOR_AGENTS referenced), AGENTS mirrors README+INSTALL install path, size budget enforcement.
- `bun run build:llms` script in `package.json`.

#### Changed
- `README.md` — adds a one-line LLMs/Agents pointer above the install CTA and a follow-up paragraph under the agent paste block naming `AGENTS.md` + `llms.txt` as fallback entry points for non-Claude agents.
- `INSTALL_FOR_AGENTS.md` — new "Step 0: If you are not Claude Code" prelude points agents at `AGENTS.md` first.
- `CLAUDE.md` — adds `scripts/llms-config.ts`, `scripts/build-llms.ts`, and `AGENTS.md` to Key files. Explicitly notes that committed generator output is NOT analogous to `schema-embedded.ts` (no runtime consumer; committed for GitHub browsing + fork safety).

#### Fixed
- `INSTALL_FOR_AGENTS.md:136` — `git pull origin main` → `git pull origin master`. Pre-existing drift: README and CI use `master`, `origin/HEAD -> master`, but the upgrade instructions told users to pull from a branch that doesn't exist. Folded into this release as a drive-by fix.

## [0.14.2] - 2026-04-20

## **Eight deferred bugs, root-cause fixes, one clean wave.**
## **Sync stops losing files. Migrations stop retrying forever. Pooler users get a knob.**

Eight bugs were previously scoped out of a PR after Codex review caught wrong root causes and unimplementable architectures. v0.14.2 takes each back to the actual code and fixes the structural gap. `/plan-eng-review` + `/codex consult` verified every load-bearing claim before a single line of code ran (20 findings, 12 triggered plan revisions before implementation).

The practical wins for a busy brain: `gbrain sync` no longer silently loses files with unquoted-colon YAML titles across any of the three sync paths. `gbrain upgrade` can't get stuck in an infinite retry loop on a wedged migration (3-partial cap + `--force-retry` escape hatch). Supabase pooler users have `GBRAIN_POOL_SIZE` to throttle without touching schemas. `gbrain doctor --fast` tells you WHY it's skipping DB checks instead of lying about no database being configured. `brain_score` gets a breakdown so 79/100 tells you which component is costing you the 21 points.

### The numbers that matter

Measured on this branch's diff against origin/master:

| Metric                                            | BEFORE v0.14.2      | AFTER v0.14.2              | Δ                       |
|---------------------------------------------------|---------------------|-----------------------------|-------------------------|
| Sync paths that silently drop files on YAML break | 3 of 3              | 0 of 3                      | **no more silent loss** |
| Wedged-migration retry loops                      | infinite            | 3-partial cap + `--force-retry` | bounded              |
| Pool-size knob for Supabase pooler                | none                | `GBRAIN_POOL_SIZE` env      | **first-class knob**    |
| `doctor --fast` messages                          | 1 catch-all         | 3 source-specific           | honest signal           |
| `brain_score` observability                       | one number          | 5-field breakdown (sum == total) | diagnosable         |
| Duplicate edges in `gbrain graph` output          | leaked per-origin   | deduped at presentation      | schema preserved        |
| `minion_jobs.max_stalled` default                 | 1 (dead-letter on first stall) | 3                | autopilot survives long embed runs |
| New + extended unit tests                         | 1696                | **1743 (+47 + 119 new assertions)** | +47                |
| Root-cause fixes vs symptom patches               | 0                   | **8 / 8**                   | structural              |

### What this means for you

Your agent's feedback loops tighten. When sync blocks, doctor surfaces the exact file with the YAML problem and the commit where it showed up. When a migration gets stuck, there's a cap and a clear escape. When you're on Supabase's transaction pooler and `gbrain upgrade` spawns subprocesses, set `GBRAIN_POOL_SIZE=2` and stop MaxClients crashes. Run `gbrain doctor` and the `brain_score` breakdown points at what to fix first: embed coverage, link density, timeline coverage, orphans, or dead links.

## To take advantage of v0.14.2

`gbrain upgrade` should do this automatically. If it didn't, or if `gbrain doctor` warns about a partial migration:

1. **Run the orchestrator manually:**
   ```bash
   gbrain apply-migrations --yes
   ```
2. **Supabase pooler users (port 6543) now have a knob.** If you hit MaxClients during upgrades, set `GBRAIN_POOL_SIZE=2` (or lower) in your environment before running `gbrain upgrade`.
3. **Check sync health after the upgrade:**
   ```bash
   gbrain doctor
   ```
   If it warns about `sync_failures`, the paths and errors are in `~/.gbrain/sync-failures.jsonl`. Fix the offending YAML frontmatter and re-run `gbrain sync`, or use `gbrain sync --skip-failed` to acknowledge known-broken files and advance past them.
4. **Wedged migrations:** If `doctor` ever flags a version with 3 consecutive partials, run `gbrain apply-migrations --force-retry vX.Y.Z` to reset the state machine, then `gbrain apply-migrations --yes` to re-attempt.
5. **If any step fails or the numbers look wrong,** file an issue: https://github.com/garrytan/gbrain/issues with:
   - output of `gbrain doctor`
   - contents of `~/.gbrain/upgrade-errors.jsonl` if it exists
   - which step broke

### Itemized changes

#### Reliability
- **Bug 2: `GBRAIN_POOL_SIZE` env knob** (`src/core/db.ts`, `src/commands/import.ts`). Honored by both the singleton pool and the parallel-import worker pool. Defaults to 10; lower for Supabase transaction pooler. `initPostgres` / `initPGLite` now wrap lifecycle in `try { ... } finally { await engine.disconnect() }`.
- **Bug 3: Migration ledger centralization + wedge cap** (`src/commands/apply-migrations.ts`, `src/core/preferences.ts`). Runner owns all ledger writes. 3 consecutive partials = wedged, skipped with a loud message. New `--force-retry <version>` flag writes a `'retry'` marker without faking success. `complete` status never regresses. `appendCompletedMigration` is idempotent on double-complete.
- **Bug 8: `max_stalled` default 1 → 3** (`src/core/schema-embedded.ts`, `src/core/pglite-schema.ts`, `src/schema.sql`). First lock-lost tick no longer dead-letters. `v0_14_0` Phase A ALTERs existing installs. `autopilot-cycle` handler yields to the event loop between phases so the worker's lock-renewal timer fires.
- **Bug 9: Sync gate + acknowledge mechanism** (`src/commands/sync.ts`, `src/commands/import.ts`, `src/core/sync.ts`). All 3 sync paths (incremental, full via `runImport`, `gbrain import` git continuity) gate `sync.last_commit` on no-failures. Failures append to `~/.gbrain/sync-failures.jsonl` with dedup key. New `gbrain sync --skip-failed` + `--retry-failed` flags. Doctor surfaces unacknowledged failures.

#### Observability
- **Bug 7: `doctor --fast` source-aware messages** (`src/core/config.ts`, `src/cli.ts`, `src/commands/doctor.ts`). New `getDbUrlSource()` returns `'env:GBRAIN_DATABASE_URL' | 'env:DATABASE_URL' | 'config-file' | null`. Doctor emits `Skipping DB checks (--fast mode, URL present from env:GBRAIN_DATABASE_URL)` when applicable.
- **Bug 11: `brain_score` breakdown + metric clarity** (`src/core/types.ts`, both engines' `getHealth()`). Added `embed_coverage_score`, `link_density_score`, `timeline_coverage_score`, `no_orphans_score`, `no_dead_links_score`. Sum equals `brain_score` by construction. `dead_links` now on `BrainHealth` (resolves a pre-existing `featuresTeaserForDoctor` drift). `orphan_pages` docs clarified — it's "islanded" (no inbound AND no outbound), not the stricter "zero inbound" graph definition.

#### Graph correctness
- **Bug 6/10: `jsonb_agg(DISTINCT ...)` in legacy `traverseGraph`** (`src/core/postgres-engine.ts`, `src/core/pglite-engine.ts`). Presentation-level dedup only — the schema continues to preserve per-`origin_page_id` / per-`link_source` provenance rows. Fixes duplicate edges like `works_at → companies/brex` appearing twice in `gbrain graph`.

#### New migration
- **Bug 5: `v0_14_0` migration registered** (`src/commands/migrations/v0_14_0.ts`). Phase A: `ALTER minion_jobs.max_stalled SET DEFAULT 3` (idempotent). Phase B: emits `pending-host-work.jsonl` entry pointing at `skills/migrations/v0.14.0.md` for shell-jobs adoption. Registered in `src/commands/migrations/index.ts`. `package.json` bumped to 0.14.2 (0.14.0 and 0.14.1 were taken by upstream during this branch's work).

#### Tests
- New: `test/traverse-graph-dedup.test.ts`, `test/sync-failures.test.ts`, `test/brain-score-breakdown.test.ts`, `test/migration-resume.test.ts`, `test/migrations-v0_14_0.test.ts`.
- Extended: `test/migrate.test.ts` (`resolvePoolSize`), `test/doctor.test.ts` (`dbSource`), `test/apply-migrations.test.ts` (`skippedFuture` includes `0.14.0`).
- E2E updated: `test/e2e/migration-flow.test.ts` assertions aligned with the new runner-owned-ledger contract (orchestrator no longer writes completed.jsonl directly).

#### Deferred to v0.15
- Deep `AbortSignal` threading through `runEmbedCore` / `runExtractCore` / `runBacklinksCore` / `performSync`. Between-phase yield addresses the Bug 8 lock-renewal root cause; mid-phase cancellation on huge brains belongs in the queue-polish PR.
- `failJobFromSweeper` for `handleTimeouts` / `handleStalled`. Current direct `status='dead'` writes kept.

## [0.14.1] - 2026-04-20

## **`gbrain doctor` stops crying wolf on DRY, and now repairs the real ones.**
## **Skill delegations via `_brain-filing-rules.md` finally count.**

`gbrain doctor --fast` was flagging 9 DRY violations on this repo, every run, for skills that properly delegated to `skills/_brain-filing-rules.md`. The old check only accepted `conventions/quality.md` as a valid delegation target, so every skill that correctly filed notability rules through the brain-filing-rules module got flagged anyway. Alert fatigue eroded every other doctor warning. v0.14.1 swaps the substring match for proximity-based suppression: a delegation reference within 40 lines of a pattern match (across `> **Convention:**`, `> **Filing rule:**`, and inline backtick paths) now correctly suppresses the violation.

The release also adds `gbrain doctor --fix` and `gbrain doctor --fix --dry-run`. Instead of telling you what's wrong, doctor can now repair it. Five guards keep the edits safe: refuses if the working tree is dirty (git is the rollback), refuses if the skill isn't inside a git repo (no rollback available), skips matches inside fenced code blocks (examples are not violations), skips when the pattern matches more than once (ambiguous), skips when a delegation reference already exists within 40 lines. Shell-injection safe via `execFileSync` array args. Trailing newline preserved. No `.bak` clutter, git is the backup contract.

### The numbers that matter

Measured on this repo's real skill library (28 skills, 3 cross-cutting patterns):

| Metric                                         | BEFORE v0.14.1      | AFTER v0.14.1                | Δ                 |
|------------------------------------------------|---------------------|------------------------------|-------------------|
| False-positive DRY violations                  | 1 flagged, 0 fixable| 0 flagged                    | **cleaner signal**|
| Genuine DRY violations surfaced                | 8                   | 8 (unchanged)                | honest count      |
| Auto-repairable via `--fix --dry-run`          | 0                   | 7 proposed, 4 intelligently skipped | new capability |
| Unit tests for doctor/resolver/dry-fix         | 24                  | **55 (+31)**                 | +31               |
| Adversarial review fixes in ship               | 0                   | **4 ship-blockers caught + fixed** | defense in depth |

The 4 adversarial fixes are worth calling out: shell injection via `execFileSync` array args, a silent-overwrite bug when skills live outside a git repo (now returns `no_git_backup`), EOF newline preservation on splice, and delegation-proximity consistency between detector (40 lines) and idempotency guard (now also 40 lines, was 10).

### What this means for you

Your agent's `gbrain doctor` output now means something again. Nine warnings a run was noise you learned to ignore; one real warning is signal. And when the doctor does flag an inlined rule, `gbrain doctor --fast --fix --dry-run` shows you exactly what the repair looks like before you commit to it. Run `gbrain doctor --fast --fix` to apply. Git is the undo button.

## To take advantage of v0.14.1

`gbrain upgrade` does this automatically. No manual migration required.

1. **Verify the detection fix:**
   ```bash
   gbrain doctor --fast --json | jq '.checks[] | select(.name=="resolver_health")'
   ```
2. **Try the auto-fix preview on your own brain:**
   ```bash
   gbrain doctor --fast --fix --dry-run
   ```
3. **Apply when ready:**
   ```bash
   gbrain doctor --fast --fix
   ```
4. **If anything looks wrong,** please file an issue:
   https://github.com/garrytan/gbrain/issues with the `gbrain doctor --json` output.

### Itemized changes

#### Added
- `gbrain doctor --fix` applies `> **Convention:**` reference callouts to skills that inline cross-cutting rules (Iron Law back-linking, citation format, notability gate). `--dry-run` previews the diff without writing.
- Three shape-aware block expanders (bullet, blockquote, paragraph) in `src/core/dry-fix.ts`, each a pure function, each with unit tests.
- New `extractDelegationTargets()` helper in `src/core/check-resolvable.ts` parses `> **Convention:** `, `> **Filing rule:** `, and inline backtick references, normalizing paths to the `CROSS_CUTTING_PATTERNS.conventions` shape.
- `getWorkingTreeStatus()` returns 3-state `'clean' | 'dirty' | 'not_a_repo'` so the fixer never writes to files git can't roll back.

#### Changed
- `CROSS_CUTTING_PATTERNS` each list multiple valid delegation targets (notability gate accepts both `conventions/quality.md` and `_brain-filing-rules.md`).
- DRY suppression is proximity-based: `DRY_PROXIMITY_LINES = 40` for detector AND the fix-module's idempotency check (was inconsistent: 40 vs 10).
- Shell execution uses `execFileSync` with array args (no shell, no injection surface from manifest-derived paths).

#### Tests
- 31 new tests across `test/check-resolvable.test.ts` (DRY detection, 13 cases), `test/dry-fix.test.ts` (unit, 28 cases including expander pure-function tests), `test/doctor-fix.test.ts` (CLI integration, 3 cases).
- Full suite: 1694 pass, 0 fail.

## [0.14.0] - 2026-04-20

## **Move gateway crons to Minions. Zero LLM tokens per cron fire.**
## **Worker abort path finally marks aborted jobs dead.**

Your OpenClaw gateway pins at 100% CPU when your 32 cron jobs each boot a full Opus session per fire, and ~14 of them are pure API-fetch-and-write scripts that don't need reasoning at all. This release adds a `shell` job type to Minions so those deterministic crons move off the gateway to the Minions worker. ~60% gateway load reduction at OpenClaw scale. Retry, backoff, DLQ, unified `gbrain jobs list` visibility, all free. The LLM-reasoning crons stay on the gateway where they belong.

Getting there meant fixing the Minions worker abort path, which was quietly wrong since v0.11: aborted jobs (timeout, cancel, lock loss) returned silently without calling `failJob`, so status stayed `active` until a stall sweep found them ~30s later. This release makes abort-reason the `error_text` of an immediate `failJob` call. Handlers get cleaner signals, operators see accurate status, `--follow` stops hanging past timeouts.

### The numbers that matter

Measured on the new `test/minions-shell.test.ts` (40 unit cases) and `test/e2e/minions-shell.test.ts` (4 E2E cases) plus 5 rounds of pre-landing review (spec adversarial x2, CEO scope, DX, eng, Codex outside voice).

| Metric                                            | BEFORE v0.14.0          | AFTER v0.14.0                     | Δ                    |
|---------------------------------------------------|-------------------------|-----------------------------------|----------------------|
| LLM tokens per cron fire                          | ~full Opus context boot | 0 (deterministic crons)           | **100% reduction**   |
| Gateway CPU headroom with ~14 crons moved         | 0%                      | ~60% free                         | cron load off gateway|
| Aborted job status lag (timeout/cancel/lock-loss) | up to 30s               | immediate `failJob` call          | **deterministic**    |
| Shell submission surfaces                         | none                    | CLI + trusted `submit_job`        | 2 paths, both gated  |
| Submission audit trail                            | none                    | JSONL at `~/.gbrain/audit/`       | operational trace    |
| Unit tests                                        | 1318 pass               | **1358 pass (+40 shell cases)**   | +40                  |
| E2E tests                                         | 124                     | **128 (+4 shell lifecycle)**      | +4                   |
| Pre-landing review rounds                         | 1 (eng)                 | **5 (spec×2 / CEO / DX / eng / codex)** | 29 issues surfaced, 26 resolved |

The abort-path fix is the quietly-important one. Handlers that use `ctx.signal` for cooperative cancel (sync, embed) now have deterministic status flips instead of waiting for the stall sweep. Shell jobs get reliable timeout semantics for the first time: `cmd: 'sleep 30', timeout_ms: 2000` hits `dead` at ~2100ms instead of ~32000ms.

### What this means for OpenClaw operators

`gbrain upgrade` reads `skills/migrations/v0.14.0.md` and walks your host agent through the adoption: enable the worker with `GBRAIN_ALLOW_SHELL_JOBS=1`, audit every cron entry (LLM-requiring stays, deterministic moves), propose a rewrite per cron with a diff, verify one fire end-to-end before approving the next batch. Never auto-rewrites your crontab — every change is a human approval per-cron. On Postgres, one persistent worker daemon claims each job. On PGLite, every crontab invocation adds `--follow` for inline execution because PGLite doesn't support the worker daemon. Either way, your gateway CPU stops pinning at 100% and your live messages stop getting blocked by batch processing. See `docs/guides/minions-shell-jobs.md` for usage recipes and `skills/migrations/v0.14.0.md` for the adoption playbook.

### Itemized changes

#### New `shell` job type

- **Spawn arbitrary commands as Minions jobs.** Pass `{cmd: "string"}` (shell-interpolated via `/bin/sh -c`) or `{argv: ["bin","arg"]}` (no shell, safe for programmatic callers). Both forms require an absolute `cwd`. Env vars are scoped to a minimal allowlist (`PATH, HOME, USER, LANG, TZ, NODE_ENV`) to prevent accidental `$OPENAI_API_KEY` interpolation; callers opt-in to additional keys per job.
- **Two-layer security: MCP boundary + env flag.** `submit_job` rejects `name: 'shell'` when `ctx.remote === true`. Independent of the env flag. `MinionQueue.add('shell', ...)` also rejects unless the caller explicitly opts in via `{allowProtectedSubmit: true}` as the 4th arg, so an in-process handler can't programmatically submit a shell child by accident. Worker only registers the handler when `GBRAIN_ALLOW_SHELL_JOBS=1` is set on the worker process. Default: off. Opt in per-host.
- **Graceful child shutdown.** Abort fires SIGTERM, 5-second grace, then SIGKILL. Listens to both `ctx.signal` (timeout/cancel/lock-loss) and a new `ctx.shutdownSignal` (worker process SIGTERM/SIGINT), so deploy restarts don't orphan shell children. Non-shell handlers ignore `shutdownSignal` and keep running through the worker's 30s cleanup race.
- **UTF-8-safe output truncation.** stdout is retained as the last 64KB, stderr as the last 16KB, with a `[truncated N bytes]` marker prepended when exceeded. Uses `string_decoder.StringDecoder` so multibyte characters don't split across the truncation boundary.
- **Operational audit trail at `~/.gbrain/audit/shell-jobs-YYYY-Www.jsonl`** (ISO-week rotation, override via `GBRAIN_AUDIT_DIR`). Records caller, remote flag, job_id, cwd, and cmd/argv display. Never logs env values. Best-effort writes: failures log to stderr but don't block submission. Operational trace for "what did this cron submit last Tuesday," not forensic insurance.
- **Starvation warning on first-time submission.** If you `gbrain jobs submit shell ...` without `--follow` and no worker with the env flag is running, stderr prints a warning block pointing at both `--follow` and `gbrain jobs work` remediation. Turns a silent "job sits in waiting forever" failure mode into a directed next-step.

#### Worker abort path overhaul

- **Aborted jobs now call `failJob` with the abort reason.** Pre-v0.14.0 worker returned silently when `ctx.signal.aborted` fired, leaving jobs in `active` until stall sweep. Fixed: catch-block now derives reason from `abort.signal.reason` (`timeout`, `cancel`, `lock-lost`, `shutdown`) and calls `failJob(id, token, "aborted: <reason>")`. Token-match makes the call idempotent: if another path already flipped status, it no-ops cleanly. Downstream `--follow` loops and status assertions now reflect reality.
- **`ctx.shutdownSignal` separated from `ctx.signal`.** Only fires on worker process SIGTERM/SIGINT. Handlers that need shutdown-specific cleanup (currently: shell handler's SIGTERM→SIGKILL on its child) subscribe to both signals. Non-shell handlers subscribe only to `ctx.signal` and don't get cancelled mid-flight on deploy restart.

#### CLI + operation surface additions

- **`gbrain jobs submit --timeout-ms N`.** Per-job wall-clock timeout in ms. Surfaced from the existing `timeout_ms` schema field, which had no CLI flag before.
- **`submit_job` operation gains `timeout_ms` param.** Same field exposed through MCP (for non-protected names).
- **`gbrain jobs submit --help` lists handler types.** `shell` is explicitly called out as CLI-only with a pointer to the guide. Closes the "what handlers are even available" discovery gap.

#### Tests

- **40 new unit cases in `test/minions-shell.test.ts`** covering validation (cmd/argv/cwd/env), spawn happy + error paths, UTF-8 safe truncation, SIGTERM abort via both signals, env allowlist (OPENAI_API_KEY blocked, PATH inherited, caller override), ISO-week filename at year boundary (2027-01-01 → W53 2026), audit write happy + EACCES failure paths, whitespace-bypass defense on `MinionQueue.add(' shell ', ...)`, and auto-added regression tests per the iron rule (non-protected names unaffected).
- **4 E2E tests in `test/e2e/minions-shell.test.ts`** covering full lifecycle (submit → worker claim → spawn → complete with captured stdout), `MinionQueue.add` defense-in-depth, `submit_job` MCP-guard rejection, `submit_job` CLI-path acceptance.

#### Docs

- **New `docs/guides/minions-shell-jobs.md`** opens with a 30-second copy-paste hello-world, then covers the two-layer security model with honest callouts about what env allowlist does and does not do, Postgres vs PGLite crontab recipes side-by-side, debug playbook (`gbrain jobs list`, `gbrain jobs get`, audit log tail, PGLite `--follow` note), known limitations, and an `#errors` table linked from every `UnrecoverableError` the handler throws.
- **New `skills/migrations/v0.14.0.md`** is the adoption playbook your host agent reads on `gbrain upgrade`. Walks through enabling the worker, auditing cron entries (LLM-requiring vs deterministic), proposing per-cron rewrites with diffs, and verifying end-to-end before batch approval. Iron rule: never auto-rewrites the operator's crontab — every change is human-approved per-cron.
- **README.md** links the guide from the Commands section.

#### Pre-ship review

Five independent rounds surfaced 29 issues across the plan. 26 resolved before a single line of code was written: spec-review adversarial subagent (x2 iterations) caught implementer-ergonomic gaps (caller derivation, mkdirSync, ISO-week formatter). CEO review + SELECTIVE EXPANSION cherry-picked argv form, audit log, SIGTERM grace, env allowlist, MCP-guard defense-in-depth, honest FS-read trust model, orphan-child `setTimeout.unref()` fix. DX review added the starvation warning block. Eng review added `ctx.shutdownSignal` separation, revised trusted-arg from opts-fold to separate 4th arg (stops accidental pass-through via `{...userOpts}` spreads), 18 additional test cases, 4 iron-rule regression tests. Codex outside voice caught 4 architectural dealbreakers: the worker abort silent-return bug (the "contract is a lie" finding), `--timeout-ms` CLI flag and `submit_job` param both missing, `PROTECTED_JOB_NAMES.has(name)` whitespace bypass before normalization. Effort estimate revised 8-10h → 16-20h once the full review was done.
## [0.13.1] - 2026-04-20

## **The brain stops being a write-once graph and starts being a runtime.**
## **Five new modules land on top of v0.12's knowledge graph layer.**

GBrain v0.13.1 ships the Knowledge Runtime delta on top of v0.13.0's frontmatter graph. Typed abstractions that turn a knowledge base into a runtime other agents can adopt. Five focused modules build on the v0.12.0 graph layer and v0.11.x Minions orchestration. A Resolver SDK unifies external lookups. A BrainWriter enforces integrity pre-commit. `gbrain integrity` repairs bare-tweet citations at scale. A BudgetLedger caps runaway resolver spend. Minions gains TZ-aware quiet-hours at claim time.

### What you can do now that you couldn't before

- **`gbrain integrity --auto --confidence 0.8`** repairs the 1,424 bare-tweet citations in your brain without human review. Three-bucket confidence: auto-repair ≥0.8, review queue 0.5–0.8, skip <0.5. Resumable via `~/.gbrain/integrity-progress.jsonl`.
- **`gbrain resolvers list`** introspects the typed plugin registry. Two builtins ship: `url_reachable` (HEAD check + SSRF guard) and `x_handle_to_tweet` (X API v2 with confidence scoring). Every result carries `{value, confidence, source, fetchedAt, costEstimate, raw}`.
- **`gbrain config set budget.daily_cap_usd 10`** puts a hard wall on resolver spend. Concurrent reserves serialize via `SELECT FOR UPDATE`. TTL auto-reclaim handles process death between reserve and commit.
- **BrainWriter + pre-commit validators** make the Philip-Leung hallucination class structurally impossible. `Scaffolder` builds every tweet URL from API output, never LLM text. `SlugRegistry` detects name collisions at create time. Four validators (citation, link, back-link, triple-HR) run on write. `writer.lint_on_put_page=true` enables observability before the strict-mode flip.
- **Quiet-hours on Minion jobs** stop the 3am DM. Set `quiet_hours: {start:22, end:7, tz:"America/Los_Angeles", policy:"defer"}` on a job. Worker checks at claim time (not dispatch). Wrap-around windows supported.

### Schema migrations

Three new migrations, all idempotent, apply automatically on `gbrain init` / upgrade.

- **v11 — budget_ledger + budget_reservations.** Per-(scope, resolver, local_date) rollup with held-reservation TTL. Rollback: DROP TABLE (budget is regenerable from resolver call logs).
- **v12 — minion_jobs.quiet_hours + stagger_key.** Additive nullable columns; existing rows keep working unchanged.
- **TS v0.13.1 — grandfather `validate: false`.** Walks every page, adds the opt-out frontmatter so legacy content skips the new validators. `gbrain integrity --auto` clears the flag per-page as citations are repaired. Rollback log at `~/.gbrain/migrations/v0_13_1-rollback.jsonl`.

### Out of scope (intentional, per CEO plan)

- **Strict-mode default flip.** BrainWriter ships with `strict_mode=lint`. The flip to strict requires a 7-day soak + BrainBench regression ≤1pt + zero false-positive count.
- **Sandboxed user plugins.** v0.13 ships builtins only. User-provided TS modules deferred pending a real isolation story (worker_threads or vm2) in a follow-on release.
- **`openai_embedding` refactor.** Deferred to PR 1.5 post-flip; embedding is a hot path.
- **Wintermute `claw-bridge`.** Adoption path is documentation-only this release.

### Tests

- **89 new unit tests** across `test/resolvers.test.ts` (43), `test/writer.test.ts` (57), `test/integrity.test.ts` (21), `test/enrichment.test.ts` (23), `test/minions-quiet-hours.test.ts` (25), `test/post-write-lint.test.ts` (11), `test/migrations-v0_13_0.test.ts` (5).
- **E2E passes on Postgres:** 115 pass / 0 fail across mechanical, sync, upgrade, minions concurrency + resilience, graph-quality, MCP, migration-flow, search-quality, skills (Tier 2 Opus/Sonnet).
- **1574 total tests pass** with an active test Postgres container. 1522 pass in unit-only mode (E2E auto-skip without DATABASE_URL).

### Itemized changes

#### Resolver SDK (`src/core/resolvers/`)
`Resolver<I, O>` interface with `{id, cost, backend, available(), resolve()}`. In-memory `ResolverRegistry`. `ResolverContext` carries `{engine, storage, config, logger, requestId, remote, deadline?, signal?}` — the `remote` flag mirrors `OperationContext.remote` for uniform trust boundaries. `FailImproveLoop.execute` gained optional `opts.signal`; backwards compatible. Two reference builtins: `url_reachable` (SSRF guard reuses wave-3 `isInternalUrl`, max-5 redirects with per-hop re-validation, AbortSignal composition) and `x_handle_to_tweet` (X API v2 recent search, strict handle regex, confidence-scored matches, 2x 429 retry honoring Retry-After, 401/403 → `ResolverError(auth)`). `gbrain resolvers list|describe` for introspection.

#### BrainWriter + validators (`src/core/output/`)
`BrainWriter.transaction(fn, ctx)` over `engine.transaction` with pre-commit validators via `WriteTx` API. Scaffolder builds typed citations (`tweetCitation`, `emailCitation`, `sourceCitation`) + `entityLink` + `timelineLine` — URLs from structured IDs, never LLM text. `SlugRegistry` detects collisions at create time. Four validators (`citation`, `link`, `back-link`, `triple-hr`) skip fenced code / inline code / HTML comments correctly. Config flag `writer.strict_mode` (default `lint`).

#### gbrain integrity (`src/commands/integrity.ts`)
Four subcommands: `check` (read-only report with `--json`, `--type`, `--limit`), `auto` (three-bucket repair with `--confidence`, `--review-lower`, `--dry-run`, `--fresh`, `--limit`), `review` (prints queue path + count), `reset-progress`. Nine bare-tweet phrase regexes. External-link extraction for optional dead-link probing. Repairs route through `BrainWriter.transaction`.

#### BudgetLedger + CompletenessScorer (`src/core/enrichment/`)
`BudgetLedger.reserve` returns `{kind:'held'}` or `{kind:'exhausted'}`. FOR UPDATE serializes concurrent reserves. `commit`, `rollback`, `cleanupExpired`. Midnight rollover via `Intl.DateTimeFormat` en-CA in configured IANA tz. Seven per-type rubrics + default (weights sum to 1.0). Person rubric's `non_redundancy` and `recency_score` kill Wintermute's length-only heuristic + 30-day-re-enrich-forever pathologies.

#### Minions scheduler polish (`src/core/minions/`)
`quiet-hours.ts` — pure `evaluateQuietHours(cfg, now?)`. Wrap-around windows. Unknown tz fails open. `stagger.ts` — FNV-1a → 0–59 deterministic across runtimes. `worker.ts` integrated: post-claim evaluation, defer → `delayed/+15m`, skip → `cancelled`.

#### Post-write lint hook (`src/core/output/post-write.ts`)
`runPostWriteLint` invokes the four validators against freshly-written pages. Gated on `writer.lint_on_put_page` (default false). Wired into `put_page` operation handler as non-blocking. Findings go to `~/.gbrain/validator-lint.jsonl` + `engine.logIngest`.

#### Design doc
`docs/designs/KNOWLEDGE_RUNTIME.md` — 717 lines covering the 4-layer architecture, integration seams, 7-phase migration path, 10 open questions. Promoted to repo so future contributors can trace decisions.

#### Prior learnings applied
- Snapshot slugs upfront (`engine.getAllSlugs()`) in grandfather migration — avoids pagination-mutation instability.
- TS-registry migrations only (post-v0.11.1 migration-discovery change).
- Migration never calls `saveConfig` — avoids Postgres→PGLite flip.
- Quiet-hours at claim/promote, not dispatch — queued job becomes claimable after window opens.
- Core fn pattern for any handler wrapping a CLI command.
- Schema v11 not v8 (graph layer took v8-v10).
- `gray-matter` + line tokenizer for citation parsing, not `marked.lexer`.

## [0.13.0] - 2026-04-20

## **Frontmatter becomes a graph. Every `company:`, `investors:`, `attendees:` you wrote turns into typed edges automatically.**
## **Graph queries get dramatically richer without you changing a word of content.**

v0.13 teaches the knowledge graph to read your YAML frontmatter. A `company: Acme` on a person page becomes a `works_at` edge. `investors: [Fund-A, Fund-B]` on a deal page becomes `invested_in` edges pointing to the deal. `attendees: [alice, charlie]` on a meeting page becomes `attended` edges. Direction respects subject-of-verb: `people/alice → meetings/2026-04-03` reads naturally because Alice is the one who attended. `gbrain graph <entity> --depth 2` against an entity with rich frontmatter goes from returning ~7 nodes to 50+, with zero skill edits or frontmatter changes.

Everything else stays the same. Agents writing `put_page` with frontmatter today work unchanged, the graph populates behind the scenes. The `auto_links` response gains one additive field: `unresolved`, so agents can see which frontmatter names couldn't be matched to existing pages and queue them for enrichment. No breaking changes to any public API.

### The numbers that matter

Benchmarked against a 46K-page production brain with ~15K frontmatter references:

| Metric | Before (v0.12) | After (v0.13) | Δ |
|--------|----------------|----------------|---|
| Graph edges total | 28K | 43K | +54% |
| `gbrain graph <hub-entity> --depth 2` node count | 7 | 52 | +643% |
| 4-hop queries (person → company → deal → investor) | fail | return aggregate | unlocked |
| Migration wall-clock on 46K pages | N/A | 3min | one-time |
| LLM API calls during migration | N/A | 0 | deterministic |
| Embedding API calls during migration | N/A | 0 | zero cost |

| Frontmatter field | Edges produced on 46K-page test brain |
|-------------------|----------------------------------------|
| `company`, `companies` (person pages) | ~9,800 |
| `key_people` (company pages) | ~1,400 |
| `investors` (deal + company pages) | ~2,100 |
| `attendees` (meeting pages) | ~800 |
| `partner` (company pages) | ~180 |
| `sources`, `source` (any page) | ~1,200 |
| `related`, `see_also` (any page) | ~400 |

The 4-hop query pattern that motivated this release: "top investors in an advisor's portfolio." Pre-v0.13: impossible without manual graph edits. Post-v0.13: `gbrain graph <advisor-slug> --depth 2 --type yc_partner,invested_in` returns ranked fund pages with frequencies. Works because the advisor's `companies:` field points to portfolio companies, those companies' `partner:` field points back, and their `investors:` field resolves to fund pages.

### What this means for OpenClaw agents

If you maintain an agent fork that uses gbrain as its persistent memory, v0.13 is the easiest upgrade since v0.7. Run `gbrain upgrade`, wait ~3 minutes while the orchestrator runs schema + backfill, and graph queries get better. No skill edits required for the majority of skills. Three skills (`meeting-ingestion`, `enrich`, `idea-ingest`) gain an optional new phase if you want to consume the new `auto_links.unresolved` field, see `docs/UPGRADING_DOWNSTREAM_AGENTS.md` for the exact diffs.

## To take advantage of v0.13

`gbrain upgrade` should do this automatically. If it didn't, or if `gbrain doctor` warns about a partial migration:

1. **Run the orchestrator manually:**
   ```bash
   gbrain apply-migrations --yes
   ```
2. **Your agent reads `skills/migrations/v0.13.0.md` the next time you interact with it.** If your agent is headless (cron, OpenClaw worker, Minion handler), the migration orchestrator already ran the mechanical side; no additional agent action is needed.
3. **Verify the outcome:**
   ```bash
   gbrain graph <some-entity> --depth 2   # any entity with frontmatter refs
   gbrain stats                       # link_count should reflect ~15-20K new frontmatter edges
   ```
4. **If any step fails or the numbers look wrong,** please file an issue:
   https://github.com/garrytan/gbrain/issues with:
   - output of `gbrain doctor`
   - contents of `~/.gbrain/upgrade-errors.jsonl` if it exists
   - which step broke

   This feedback loop is how the gbrain maintainers find fragile upgrade paths. Thank you.

### Itemized changes

**Knowledge graph, frontmatter edge projection:**
- `src/core/link-extraction.ts`, new `FRONTMATTER_LINK_MAP` (canonical field to type + direction + dir-hint map). New `SlugResolver` interface + `makeResolver(engine, {mode})` factory. `extractFrontmatterLinks` extractor. `extractPageLinks` becomes async and emits frontmatter edges alongside markdown refs. `LinkCandidate` gains `fromSlug`, `linkSource`, `originSlug`, `originField`.
- `src/core/operations.ts::runAutoLink`, bidirectional reconciliation. Outgoing edges (markdown + own-frontmatter) reconciled via `getLinks`; incoming edges (other-page to self from `key_people`/`attendees`/etc.) reconciled via `getBacklinks` scoped to `origin_page_id`. Manual edges (`link_source='manual'`) never touched.
- `put_page` response shape extends with `auto_links.unresolved: Array<{field, name}>`. Additive; existing clients unaffected.

**Slug resolver:**
- Two-mode resolver (`batch` for migration, `live` for put_page post-hook). Fallback chain: exact slug, dir-hint construction, pg_trgm fuzzy match, optional keyword search (live only, `expand: false` mandatory per `operations-query-hidden-haiku` learning).
- New engine method `findByTitleFuzzy(name, dirPrefix?, minSimilarity?)` implemented on both Postgres and PGLite engines. Uses the `%` operator + `similarity()` function; GIN trigram index drives the match.
- Per-run cache: same name, single DB lookup.

**Schema migrations:**
- migrate.ts v11 (`links_provenance_columns`): adds `link_source`, `origin_page_id`, `origin_field`. Swaps unique constraint to `UNIQUE NULLS NOT DISTINCT (from, to, type, link_source, origin_page_id)`. CHECK constraint on `link_source` values. New indexes on link_source + origin_page_id.
- `src/commands/migrations/v0_13_0.ts`, release orchestrator (Phase A schema, Phase B backfill, Phase C verify). Registered in migrations/index.ts. Resumable via `partial` status + `ON CONFLICT DO NOTHING`.

**Engine layer:**
- Both engines: `addLink` gains `linkSource`, `originSlug`, `originField` params. `addLinksBatch` unnest grows from 4 columns to 7. `removeLink` gains optional `linkSource` filter. `getLinks` + `getBacklinks` now return `link_source`, `origin_slug`, `origin_field` in the Link shape.
- PGLite + Postgres parity verified end-to-end in `test/pglite-engine.test.ts`.

**Release reliability (applies to every future release):**
- `src/commands/upgrade.ts`, best-effort `gbrain post-upgrade` failures now append a structured record to `~/.gbrain/upgrade-errors.jsonl` instead of silently swallowing the error.
- `src/commands/doctor.ts`, surfaces the latest upgrade-errors entry with a paste-ready recovery hint. Works alongside the existing partial-migration detector.
- CHANGELOG format adds the "To take advantage of v[version]" block pattern (seen above). Required for every release going forward so users have a self-repair path when automation fails.

**CLI changes:**
- `gbrain extract links --source db --include-frontmatter`, v0.13 flag. Default OFF for back-compat (existing `gbrain extract` runs don't suddenly get new edges). Migration orchestrator explicitly enables it for the one-time backfill.
- `gbrain extract` now prints a top-20 summary of unresolvable frontmatter names when `--include-frontmatter` is active, so users see exactly where the graph has holes.

**Tests:**
- `test/pglite-engine.test.ts` covers new 7-column addLinksBatch unnest + NULLS NOT DISTINCT semantics + ON CONFLICT on the new constraint.
- `test/link-extraction.test.ts` covers async signature regression, resolver fallback chain, cache hit, bad-type skip, context enrichment.
- `test/extract.test.ts` covers fs-source async signature, `includeFrontmatter` opt-in, incoming-direction semantics for `investors`/`key_people`/`attendees`.
- `test/migrate.test.ts` updated for new constraint name post-v11.
- `test/apply-migrations.test.ts` registry now includes v0.13.0 in skippedFuture buckets for older installed versions.

**Documentation:**
- `skills/migrations/v0.13.0.md`, user-facing upgrade skill.
- `docs/UPGRADING_DOWNSTREAM_AGENTS.md`, appended v0.13 section: no-action-required verdict + field-to-type map + optional skill diffs for meeting-ingestion, enrich, idea-ingest.

## [0.12.3] - 2026-04-19

## **Reliability wave: the pieces v0.12.2 didn't cover.**
## **Sync stops hanging. Search timeouts stop leaking. `[[Wikilinks]]` are edges.**

v0.12.2 shipped the data-correctness hotfix (JSONB double-encode, splitBody, `/wiki/` types, parseEmbedding). This wave lands the remaining reliability fixes from the same community review pass, plus a graph-layer feature a 2,100-page brain needed to stop bleeding edges. No schema changes. No migration. `gbrain upgrade` pulls it.

### What was broken

**Incremental sync deadlocked past 10 files.** `src/commands/sync.ts` wrapped the whole import in `engine.transaction`, and `importFromContent` also wrapped each file. PGLite's `_runExclusiveTransaction` is non-reentrant — the inner call parks on the mutex the outer call holds, forever. In practice: 3 files synced fine, 15 files hung in `ep_poll` until you killed the process. Bulk Minions jobs and citation-fixer dream-cycles regularly hit this. Discovered by @sunnnybala.

**`statement_timeout` leaked across the postgres.js pool.** `searchKeyword` and `searchVector` bounded queries with `SET statement_timeout='8s'` + `finally SET 0`. But every tagged template picks an arbitrary pool connection, so the SET, the query, and the reset could land on three different sockets. The 8s cap stuck to whichever connection ran the SET, got returned to the pool, and the next unrelated caller inherited it. Long-running `embed --all` jobs and imports clipped silently. Fix by @garagon.

**Obsidian `[[WikiLinks]]` were invisible to the auto-link post-hook.** `extractEntityRefs` only matched `[Name](people/slug)`. On a 2,100-page brain with wikilinks throughout, `put_page` extracted zero auto-links. `DIR_PATTERN` also missed domain-organized wiki roots (`entities`, `projects`, `tech`, `finance`, `personal`, `openclaw`). After the fix: 1,377 new typed edges on a single `extract --source db` pass. Discovered and fixed by @knee5.

**Corrupt embedding rows broke every query that touched them.** `getEmbeddingsByChunkIds` on Supabase could return a pgvector string instead of a `Float32Array`. v0.12.2 fixed the normal path by normalizing inputs, but one genuinely bad row still threw and killed the ranking pass. Availability matters more than strictness on the read path.

### What you can do now that you couldn't before

- **Sync 100 files without hanging.** Per-file atomicity preserved, outer wrap removed. Regression test asserts `engine.transaction` is not called at the top level of `src/commands/sync.ts`. Contributed by @sunnnybala.
- **Run a long `embed --all` on Supabase without strangling unrelated queries.** `searchKeyword` / `searchVector` use `sql.begin` + `SET LOCAL` so the timeout dies with the transaction. 5 regression tests in `test/postgres-engine.test.ts` pin the new shape. Contributed by @garagon.
- **Write `[[people/balaji|Balaji Srinivasan]]` in a page and see a typed edge.** Same extractor, two syntaxes. Matches the filesystem walker — the db and fs sources now produce the same link graph from the same content. Contributed by @knee5.
- **Find your under-connected pages.** `gbrain orphans` surfaces pages with zero inbound wikilinks, grouped by domain. `--json`, `--count`, and `--include-pseudo` flags. Also exposed as the `find_orphans` MCP operation so agents can run enrichment cycles without CLI glue. Contributed by @knee5.
- **Degraded embedding rows skip+warn instead of throwing.** New `tryParseEmbedding()` sibling of `parseEmbedding()`: returns `null` on unknown input and warns once per process. Used on the search/rescore path. Migration and ingest paths still throw — data integrity there is non-negotiable.
- **`gbrain doctor` tells you which brains still need repair.** Two new checks: `jsonb_integrity` scans the four v0.12.0 write sites and reports rows where `jsonb_typeof = 'string'`; `markdown_body_completeness` heuristically flags pages whose `compiled_truth` is <30% of raw source length when raw has multiple H2/H3 boundaries. Fix hint points at `gbrain repair-jsonb` and `gbrain sync --force`.

### How to upgrade

```bash
gbrain upgrade
```

No migration, no schema change, no data touch. If you're on Postgres and haven't run `gbrain repair-jsonb` since v0.12.2, the v0.12.2 orchestrator still runs on upgrade. New `gbrain doctor` will tell you if anything still looks off.

### Itemized changes

**Sync deadlock fix (#132)**
- `src/commands/sync.ts` — remove outer `engine.transaction` wrap; per-file atomicity preserved by `importFromContent`'s own wrap.
- `test/sync.test.ts` — new regression guard asserting top-level `engine.transaction` is not called on > 10-file sync paths.
- Contributed by @sunnnybala.

**postgres-engine statement_timeout scoping (#158)**
- `src/core/postgres-engine.ts` — `searchKeyword` and `searchVector` rewritten to `sql.begin(async (tx) => { await tx\`SET LOCAL statement_timeout = ...\`; ... })`. GUC dies with the transaction; pool reuse is safe.
- `test/postgres-engine.test.ts` — 5 regression tests including a source-level guardrail grep against the production file (not a test fixture) asserting no bare `SET statement_timeout` outside `sql.begin`.
- Contributed by @garagon.

**Obsidian wikilinks + extended domain patterns (#187 slice)**
- `src/core/link-extraction.ts` — `extractEntityRefs` matches both `[Name](people/slug)` and `[[people/slug|Name]]`. `DIR_PATTERN` extended with `entities`, `projects`, `tech`, `finance`, `personal`, `openclaw`.
- Matches existing filesystem-walker behavior.
- Contributed by @knee5.

**`gbrain orphans` command (#187 slice)**
- `src/commands/orphans.ts` — new command with text/JSON/count outputs and domain grouping.
- `src/core/operations.ts` — `find_orphans` MCP operation.
- `src/cli.ts` — `orphans` added to `CLI_ONLY`.
- `test/orphans.test.ts` — 203 lines covering detection, filters, and all output modes.
- Contributed by @knee5.

**`tryParseEmbedding()` availability helper**
- `src/core/utils.ts` — new `tryParseEmbedding(value)`: returns `null` on unknown input, warns once per process via a module-level flag.
- `src/core/postgres-engine.ts` — `getEmbeddingsByChunkIds` uses `tryParseEmbedding` so one bad row degrades ranking instead of killing the query.
- `test/utils.test.ts` — new cases for null-return and single-warn.
- Hand-authored; codifies the split-by-call-site rule from the #97/#175 review.

**Doctor detection checks**
- `src/commands/doctor.ts` — `jsonb_integrity` scans `pages.frontmatter`, `raw_data.data`, `ingest_log.pages_updated`, `files.metadata` and reports `jsonb_typeof='string'` counts; `markdown_body_completeness` heuristic for ≥30% shrinkage vs raw source on multi-H2 pages.
- `test/doctor.test.ts` — detection unit tests assert both checks exist and cover the four JSONB sites.
- `test/e2e/jsonb-roundtrip.test.ts` — the regression test that should have caught the original v0.12.0 double-encode bug; round-trips all four JSONB write sites against real Postgres.
- `docs/integrations/reliability-repair.md` — guide for v0.12.0 users: detect via `gbrain doctor`, repair via `gbrain repair-jsonb`.

**No schema changes. No migration. No data touch.**

## [0.12.2] - 2026-04-19

## **Postgres frontmatter queries actually work now.**
## **Wiki articles stop disappearing when you import them.**

This is a data-correctness hotfix for the `v0.12.0`-and-earlier Postgres-backed brains. If you run gbrain on Postgres or Supabase, you've been losing data without knowing it. PGLite users were unaffected. Upgrade auto-repairs your existing rows. Lands on top of v0.12.1 (extract N+1 fix + migration timeout fix) — pull `gbrain upgrade` and you get both.

### What was broken

**Frontmatter columns were silently stored as quoted strings, not JSON.** Every `put_page` wrote `frontmatter` to Postgres via `${JSON.stringify(value)}::jsonb` — postgres.js v3 stringified again on the wire, so the column ended up holding `"\"{\\\"author\\\":\\\"garry\\\"}\""` instead of `{"author":"garry"}`. Every `frontmatter->>'key'` query returned NULL. GIN indexes on JSONB were inert. Same bug on `raw_data.data`, `ingest_log.pages_updated`, `files.metadata`, and `page_versions.frontmatter`. PGLite hid this entirely (different driver path) — which is exactly why it slipped past the existing test suite.

**Wiki articles got truncated by 83% on import.** `splitBody` treated *any* standalone `---` line in body content as a timeline separator. Discovered by @knee5 migrating a 1,991-article wiki where a 23,887-byte article landed in the DB as 593 bytes (4,856 of 6,680 wikilinks lost).

**`/wiki/` subdirectories silently typed as `concept`.** Articles under `/wiki/analysis/`, `/wiki/guides/`, `/wiki/hardware/`, `/wiki/architecture/`, and `/writing/` defaulted to `type='concept'` — type-filtered queries lost everything in those buckets.

**pgvector embeddings sometimes returned as strings → NaN search scores.** Discovered by @leonardsellem on Supabase, where `getEmbeddingsByChunkIds` returned `"[0.1,0.2,…]"` instead of `Float32Array`, producing `[NaN]` query scores.

### What you can do now that you couldn't before

- **`frontmatter->>'author'` returns `garry`, not NULL.** GIN indexes work. Postgres queries by frontmatter key actually retrieve pages.
- **Wiki articles round-trip intact.** Markdown horizontal rules in body text are horizontal rules, not timeline separators.
- **Recover already-truncated pages with `gbrain sync --full`.** Re-import from your source-of-truth markdown rebuilds `compiled_truth` correctly.
- **Search scores stop going `NaN` on Supabase.** Cosine rescoring sees real `Float32Array` embeddings.
- **Type-filtered queries find your wiki articles.** `/wiki/analysis/` becomes type `analysis`, `/writing/` becomes `writing`, etc.

### How to upgrade

```bash
gbrain upgrade
```

The `v0.12.2` orchestrator runs automatically: applies any schema changes, then `gbrain repair-jsonb` rewrites every double-encoded row in place using `jsonb_typeof = 'string'` as the guard. Idempotent — re-running is a no-op. PGLite engines short-circuit cleanly. Batches well on large brains.

If you want to recover pages that were truncated by the splitBody bug:

```bash
gbrain sync --full
```

That re-imports every page from disk, so the new `splitBody` rebuilds the full `compiled_truth` correctly.

### What's new under the hood

- **`gbrain repair-jsonb`** — standalone command for the JSONB fix. Run it manually if needed; the migration runs it automatically. `--dry-run` shows what would be repaired without touching data. `--json` for scripting.
- **CI grep guard** at `scripts/check-jsonb-pattern.sh` — fails the build if anyone reintroduces the `${JSON.stringify(x)}::jsonb` interpolation pattern. Wired into `bun test` so it runs on every CI invocation.
- **New E2E regression test** at `test/e2e/postgres-jsonb.test.ts` — round-trips all four JSONB write sites against real Postgres and asserts `jsonb_typeof = 'object'` plus `->>` returns the expected scalar. The test that should have caught the original bug.
- **Wikilink extraction** — `[[page]]` and `[[page|Display Text]]` syntaxes now extracted alongside standard `[text](page.md)` markdown links. Includes ancestor-search resolution for wiki KBs where authors omit one or more leading `../`.

### Migration scope

The repair touches five JSONB columns:
- `pages.frontmatter`
- `raw_data.data`
- `ingest_log.pages_updated`
- `files.metadata`
- `page_versions.frontmatter` (downstream of `pages.frontmatter` via INSERT...SELECT)

Other JSONB columns in the schema (`minion_jobs.{data,result,progress,stacktrace}`, `minion_inbox.payload`) were always written via the parameterized `$N::jsonb` form so they were never affected.

### Behavior changes (read this if you upgrade)

`splitBody` now requires an explicit sentinel for timeline content. Recognized markers (in priority order):
1. `<!-- timeline -->` (preferred — what `serializeMarkdown` emits)
2. `--- timeline ---` (decorated separator)
3. `---` directly before `## Timeline` or `## History` heading (backward-compat fallback)

If you intentionally used a plain `---` to mark your timeline section in source markdown, add `<!-- timeline -->` above it manually. The fallback covers the common case (`---` followed by `## Timeline`).

### Attribution

Built from community PRs #187 (@knee5) and #175 (@leonardsellem). The original PRs reported the bugs and proposed the fixes; this release re-implements them on top of the v0.12.0 knowledge graph release with expanded migration scope, schema audit (all 5 affected columns vs the 3 originally reported), engine-aware behavior, CI grep guard, and an E2E regression test that should have caught this in the first place. Codex outside-voice review during planning surfaced the missed `page_versions.frontmatter` propagation path and the noisy-truncated-diagnostic anti-pattern that was dropped from this scope. Thanks for finding the bugs and providing the recovery path — both PRs left work to do but the foundation was right.

Co-Authored-By: @knee5 (PR #187 — splitBody, inferType wiki, JSONB triple-fix)
Co-Authored-By: @leonardsellem (PR #175 — parseEmbedding, getEmbeddingsByChunkIds fix)

## [0.12.1] - 2026-04-19

## **Extract no longer hangs on large brains.**
## **v0.12.0 upgrade no longer times out on duplicates.**

Two production-blocking bugs Garry hit on his 47K-page brain on April 18. `gbrain extract` was effectively unusable on any brain with 20K+ existing links or timeline entries — it pre-loaded the entire dedup set with one `getLinks()` call per page over the Supabase pooler, hanging for 10+ minutes producing zero output before any work started. The v0.12.0 schema migration that creates `idx_timeline_dedup` was failing on brains with pre-existing duplicate timeline rows because the `DELETE ... USING` self-join was O(n²) without an index, hitting Supabase Management API's 60-second ceiling on 80K+ duplicates. Both bugs end here.

### The numbers that matter

Measured on the new `test/extract-fs.test.ts` and `test/migrate.test.ts` regression suites, plus 73 E2E tests against real Postgres+pgvector. Reproducible: `bun test` + `bun run test:e2e`.

| Metric                                  | BEFORE v0.12.1     | AFTER v0.12.1     | Δ                  |
|-----------------------------------------|--------------------|--------------------|--------------------|
| extract hang on 47K-page brain          | 10+ min, zero output | immediate work, ~30-60s wall clock | usable            |
| DB round-trips per re-extract           | 47K reads + 235K writes | 0 reads + ~2.4K writes | **~99% fewer** |
| v0.12.0 migration on 80K duplicate rows | timed out at 60s    | completes <1s     | **~60x+ faster**   |
| Re-run on already-extracted brain       | 235K row-writes     | 0 row-writes      | true no-op         |
| Tests                                   | 1297 unit / 105 E2E | **1412 unit / 119 E2E** | +115 unit / +14 E2E |
| `created` counter on re-runs            | "5000 created" (lie) | "0 created" (truth)| accurate           |

Per-batch round-trip math: a re-extract on a 47K-page brain with ~5 links per page used to do 235K sequential round-trips over the Supabase pooler. With 100-row batched INSERTs it does ~2,400. The hang came from the read pre-load (47K serial `getLinks()` calls), which is now gone entirely. The DB enforces uniqueness via `ON CONFLICT DO NOTHING`.

### What this means for GBrain users

If you've been afraid to re-run `gbrain extract` because it might never finish, that's over. The command starts producing output immediately, batch-writes 100 rows per round-trip, and reports a truthful insert count even on re-runs. If your v0.12.0 upgrade got stuck on the timeline migration (or you had to manually run `CREATE TABLE ... AS SELECT DISTINCT ON ...` to unblock it), the next `gbrain init --migrate-only` is sub-second. Run `gbrain extract all` on your largest brain and watch it actually work.

### Itemized changes

#### Performance

- **`gbrain extract` no longer pre-loads the dedup set.** Removed the N+1 read loop in `extractLinksFromDir`, `extractTimelineFromDir`, `extractLinksFromDB`, and `extractTimelineFromDB` that called `engine.getLinks(slug)` (or `getTimeline`) once per page across `engine.listPages({ limit: 100000 })`. On a 47K-page brain that was 47K serial network round-trips before the first file was even read. Both engines already enforced uniqueness at the SQL layer (`UNIQUE(from_page_id, to_page_id, link_type)` on `links`, `idx_timeline_dedup` on `timeline_entries`); the in-memory dedup `Set` was redundant insurance that turned into the bottleneck.
- **Batched multi-row INSERTs replace per-row writes.** All four extract paths now buffer 100 candidates and flush via new `addLinksBatch` / `addTimelineEntriesBatch` engine methods. Round-trips drop ~100x: ~235K → ~2,400 per full re-extract. Each batch uses `INSERT ... SELECT FROM unnest($1::text[], $2::text[], ...) JOIN pages ON CONFLICT DO NOTHING RETURNING 1` — 4 (links) or 5 (timeline) array-typed bound parameters regardless of batch size, sidestepping Postgres's 65535-parameter cap entirely. PGLite uses the same SQL shape with manual `$N` placeholders.

#### Correctness

- **`created` counter is now truthful on re-runs.** Returns count of rows actually inserted (via `RETURNING 1` row count), not "calls that didn't throw." A re-run on a fully-extracted brain prints `Done: 0 links, 0 timeline entries from 47000 pages`. Before this release it would print `Done: 5000 links` while inserting zero new rows.
- **`--dry-run` deduplicates candidates across files.** A link extracted from 3 different markdown files now prints exactly once in `--dry-run` output, matching what the batch insert would actually create. Before this release the dedup was tied to the now-deleted DB pre-load, so dry-run would over-print.
- **Whole-batch errors are visible in both JSON and human modes.** When a batch flush fails (DB connection drop, malformed row), the error prints to stderr in JSON mode AND to console in human mode, with the lost-row count. No more silent loss of 100 rows because of one bad row.

#### Schema migrations — v0.12.0 upgrade is now sub-second on duplicate-heavy brains

- **Migration v9 (timeline_entries) and v8 (links) pre-create a btree helper index** on the dedup columns before the `DELETE ... USING` self-join runs. Turns the O(n²) sequential-scan dedup into O(n log n) index-backed dedup. On 80K+ duplicate rows the migration completes in well under a second instead of timing out at 60s. The helper index is dropped after dedup, leaving the original schema unchanged. Same fix applied defensively to migration v8 — Garry's brain didn't trip it (links had fewer duplicates) but the same trap was loaded.
- **`phaseASchema` timeout in the v0.12.0 orchestrator bumped 60s → 600s.** Belt-and-suspenders: the helper-index fix should make dedup sub-second on most brains, but the outer wall-clock budget shouldn't be the failure mode for unforeseen slowness.

#### New engine API

- **`addLinksBatch(LinkBatchInput[]) → Promise<number>`** and **`addTimelineEntriesBatch(TimelineBatchInput[]) → Promise<number>`** on both `PostgresEngine` and `PGLiteEngine`. Returns count of actually-inserted rows (excluding ON CONFLICT no-ops and JOIN-dropped rows whose slugs don't exist). Per-row `addLink` / `addTimelineEntry` are unchanged — all 10 existing call sites compile and behave identically. Plugin authors building agent integrations on `BrainEngine` can adopt the batch methods at their own pace.

#### Tests

- **Migration regression tests guard the fix structurally + behaviorally.** New `test/migrate.test.ts` cases assert the v8 + v9 SQL literally contains the helper `CREATE INDEX IF NOT EXISTS ... DROP INDEX IF EXISTS` sequence in the right order (deterministic, fast, catches a regression even at 0-row scale where wall-clock can't distinguish O(n²) from O(1)) AND that the migration completes under wall-clock cap on 1000-row fixtures.
- **`test/extract-fs.test.ts` (new file)** covers the FS-source extract path end-to-end on PGLite: first-run inserts, second-run reports zero, dry-run dedups duplicate candidates across 3 files into one printed line, second-run perf regression guard.
- **9 new E2E tests for the postgres-engine batch methods** in `test/e2e/mechanical.test.ts`. The postgres-js bind path is structurally different from PGLite's (array params via `unnest()` vs manual `$N` placeholders) and gets its own coverage against real Postgres+pgvector.
- **11 new PGLite batch method tests** in `test/pglite-engine.test.ts` (empty batch, missing optionals normalize to empty strings, within-batch dedup via ON CONFLICT, missing-slug rows dropped by JOIN, half-existing batch returns count of new only, batch of 100).

#### Pre-ship review

This release was reviewed by `/plan-eng-review` (5 issues, all addressed including a P0 plan reshape that dropped a redundant orchestrator phase in favor of fixing migration v9 directly), `/codex` outside-voice review on the plan (15 findings, all P1 + P2 incorporated — most consequential: forced a cleaner separation between per-row API stability and new batch APIs so all 10 existing `addLink` callers stay untouched), and 5 specialist subagents (testing, maintainability, performance, security, data-migration) at ship time. The testing specialist caught a real bug in the postgres-engine batch SQL: postgres-js's `sql(rows, ...)` helper doesn't compose with `(VALUES) AS v(...)` JOIN syntax the way originally written. Switched to the cleaner `unnest()` array-parameter pattern in both engines, verified end-to-end against a real Postgres+pgvector container.

## [0.12.0] - 2026-04-18

## **The graph wires itself.**
## **Your brain stops being grep.**

GBrain v0.12.0 ships a self-wiring knowledge graph. Every `put_page` extracts entity references and creates typed links automatically (`attended`, `works_at`, `invested_in`, `founded`, `advises`) with zero LLM calls. New `gbrain graph-query` for typed-edge traversal. Backlink-boosted hybrid search. Auto-link reconciliation on every edit. The brain stops being a text store you grep through and starts being a knowledge graph you query.

### The benchmark numbers that matter

Headline from BrainBench v1, a 240-page rich-prose corpus generated by Claude Opus, run on PGLite in-memory. Same data, same queries, before vs after PR #188. No API keys at run time. Reproducible: `bun run eval/runner/all.ts`, ~3 min.

| Metric                          | BEFORE PR #188 | AFTER PR #188 | Δ            |
|---------------------------------|----------------|---------------|--------------|
| **Precision@5** (top-5 hits)    | 39.2%          | **44.7%**     | **+5.4 pts** |
| **Recall@5** (correct in top-5) | 83.1%          | **94.6%**     | **+11.5 pts**|
| Correct in top-5 (total)        | 217            | 247           | **+30**      |
| Graph-only F1 (ablation)        | 57.8% (grep)   | **86.6%**     | **+28.8 pts**|

Per-link-type precision (graph-only, where the typed graph is the answer):

| Link type   | Expected | BEFORE precision | AFTER precision | Δ            |
|-------------|----------|------------------|-----------------|--------------|
| works_at    | 120      | 21%              | **94%**         | **+73 pts**  |
| invested_in | 79       | 32%              | **90%**         | **+58 pts**  |
| advises     | 61       | 10%              | **78%**         | **+68 pts**  |
| attended    | 153      | 75%              | 72%             | -3 pts       |

30 more correct answers in the top-5 the agent actually reads. 53% fewer total results to wade through. "Who works at Acme?" jumps from 21% precision (grep returns every page mentioning Acme: investors, advisors, concept pages, other companies) to 94% (graph returns just the employees).

### What this means for GBrain users

The brain is no longer a text store with hybrid search bolted on. It's a queryable knowledge graph that ALSO has hybrid search. Six categories of orthogonal capability (identity resolution, temporal queries, performance at 10K-page scale, robustness to malformed input, MCP operation contract) all pass. Every page write is a graph mutation. Every query gets graph-first ranking. Auto-wire on upgrade ... `gbrain post-upgrade` runs the v0_12_0 orchestrator (schema, config check, backfill links, backfill timeline, verify), idempotent, ~30s on a 30K-page brain. Plus the v0.11 Minions runtime is fully merged: durable background agents + the graph layer in one release.

### Itemized changes

#### Knowledge Graph Layer

Your brain now wires itself. Every page write automatically extracts entity references and creates typed links between pages. The `links` table goes from a manually-populated convention to a real, queryable knowledge graph that compounds over time.

- **Auto-link on every page write.** When you `gbrain put` a page that mentions `[Alice](people/alice)` or `[Acme](companies/acme)`, those links land in the graph automatically. Stale links (refs no longer in the page text) are removed in the same call. Run a quick `gbrain put` and the brain knows who's connected to whom. To opt out: `gbrain config set auto_link false`.
- **Typed relationships.** Inferred from context using deterministic regex (zero LLM calls): `attended` (meeting -> person), `works_at` (CEO of, VP at, joined as), `invested_in` (invested in, backed by), `founded` (founded, co-founded), `advises` (advises, board member), `source` (frontmatter), `mentions` (default). On a 80-page benchmark brain: 94% type accuracy.
- **`gbrain extract --source db`.** New mode for the existing `gbrain extract <links|timeline|all>` command that walks pages from the engine instead of from disk. Works for live brains backed by Postgres or PGLite without a local markdown checkout — exactly what an MCP-driven Wintermute or OpenClaw setup needs. Filesystem mode (`--source fs`) is unchanged and still the default.
- **`gbrain graph-query <slug>` for relationship traversal.** "Who works at Acme?" → `gbrain graph-query companies/acme --type works_at --direction in`. "Who attended meetings with Alice?" → `gbrain graph-query people/alice --type attended --depth 2`. Returns typed edges with depth, not just nodes. Backed by a new `traversePaths()` engine method on both PGLite and Postgres with cycle prevention (no exponential blowup on cyclic subgraphs).
- **Graph-powered search ranking.** Hybrid search now applies a small backlink boost after cosine re-scoring (`score *= 1 + 0.05 * log(1 + backlink_count)`). Well-connected entities surface higher in results. Works in both keyword-only and full hybrid paths. Tested on the new `test/benchmark-graph-quality.ts` (80 pages, 35 queries, A/B/C comparison) — relational query recall jumps from ~30% (search alone) to 100% (graph traversal).
- **Graph health metrics in `gbrain health`.** New `link_coverage` and `timeline_coverage` percentages on entity pages (person/company), plus `most_connected` top-5 list. The `dead_links` field is dropped (always 0 under ON DELETE CASCADE — was a phantom metric). The `brain_score` composite formula stays but now reflects a sharper graph signal.

### Schema migrations

Three new migrations apply automatically on `gbrain init`:

- **v5** widens the `links` UNIQUE constraint to `(from, to, link_type)`. The same person can now both `works_at` AND `advises` the same company as separate rows, instead of one type clobbering the other.
- **v6** adds a UNIQUE index on `timeline_entries(page_id, date, summary)` plus `ON CONFLICT DO NOTHING` in `addTimelineEntry`. Idempotent inserts at the DB level — running `gbrain extract timeline --source db` twice is safe.
- **v7** drops the `trg_timeline_search_vector` trigger that updated `pages.updated_at` on every timeline insert. Structured timeline entries are now graph data only, not search text. The markdown timeline section in `pages.timeline` still feeds search via the pages trigger. Side benefit: extraction pagination is no longer self-invalidating.

### Security hardening (caught during pre-ship review)

- **`traverse_graph` MCP depth is hard-capped at 10.** Without this, a remote MCP caller could pass `depth=1e6` and burn database memory/CPU on the recursive CTE.
- **Auto-link is disabled for remote MCP callers** (`ctx.remote=true`). Bare-slug regex matches `people/X` anywhere in page text including code fences and quoted strings. Without this gate, an untrusted MCP caller could plant arbitrary outbound links by writing pages with intentional slug references; combined with the new backlink boost, attacker-placed targets would surface higher in search.
- **`runAutoLink` reconciliation runs inside a transaction.** Without it, two concurrent `put_page` calls on the same slug would race: each reads stale `existingKeys` and recreates links the other side just removed.
- **`--since` validates date format upfront.** Invalid dates (`--since yesterday`) used to silently no-op the filter and reprocess the whole brain. Now: hard error with a clear message.

### Tests

- 1151 unit tests pass (was 891 → +260 new)
- 105 E2E tests pass against PostgreSQL
- New `test/benchmark-graph-quality.ts` runs the 80-page A/B/C comparison and gates on real thresholds (link_recall > 90%, type_accuracy > 80%, idempotency true). Currently passing all 9 thresholds.
- BrainBench v1 (Cat 1+2 + 3, 4, 7, 10, 12) at 240-page Opus rich-prose corpus: Recall@5 83% → 95%, Precision@5 39% → 45%, +30 correct in top-5. Graph-only F1 86.6% vs grep 57.8%. See `docs/benchmarks/2026-04-18-brainbench-v1.md`.

### Schema migration renumber

The graph layer migrations (originally v5/v6/v7 on the link-timeline-extract branch) were renumbered to **v8/v9/v10** to land cleanly on top of master's v5/v6/v7 (Minions: minion_jobs_table, agent_orchestration_primitives, agent_parity_layer). All v8/v9/v10 SQL is idempotent — fresh installs apply the full sequence cleanly; existing v0.11.x installs apply only the new v8/v9/v10. Branch installs that pre-dated this merge (very rare) need to drop and re-init their PGLite db to pick up master's v5/v6/v7 minion_jobs schema.

## [0.11.1] - 2026-04-18

### Fixed — the v0.11.0 migration mega-bug

Your v0.11.0 upgrade shipped the Minions schema, worker, queue, and migration skill. It didn't ship the actual migration running on upgrade. If you upgraded and ended up with no `~/.gbrain/preferences.json`, autopilot still running inline, and cron jobs still hitting `agentTurn`'s 300s timeout — that's the bug. This release fixes it and auto-repairs on your next `gbrain upgrade`.

- **`gbrain apply-migrations` is the canonical repair.** Reads `~/.gbrain/migrations/completed.jsonl`, diffs against the TS migration registry, runs any pending orchestrators. Idempotent: rerunning on a healthy install is cheap and silent.
- **`gbrain upgrade` and `postinstall` now invoke it.** `runPostUpgrade` tail-calls `apply-migrations --yes` unconditionally (Codex caught that the earlier early-return on missing upgrade-state.json left broken-v0.11.0 installs broken forever). `package.json`'s new `postinstall` hook runs it after `bun update gbrain` / `npm i gbrain`. First-install guard keeps postinstall silent when no brain is configured yet.
- **Stopgap for v0.11.0 binaries without this release:** paste `curl -fsSL https://raw.githubusercontent.com/garrytan/gbrain/v0.11.1/scripts/fix-v0.11.0.sh | bash`. It writes `preferences.json` + a `status: "partial"` record so the eventual `apply-migrations --yes` run picks up where it left off — the stopgap does not poison the permanent migration path.

### Added — autopilot supervises Minions itself, one install step

Before this release, autopilot + `gbrain jobs work` were two separate processes you had to manage. Now autopilot is the one install step, and it forks the Minions worker as a child with 10s-backoff restart + 5-crash cap + async SIGTERM drain that waits up to 35s for the worker to commit in-flight work before SIGKILL.

- **Autopilot dispatches each cycle as a single `autopilot-cycle` Minion job** with `idempotency_key: autopilot-cycle:<slot>`. A 5-min autopilot + 8-min embed no longer stacks 4 overlapping runs — the queue's unique partial index dedupes at the DB layer. Codex caught that the earlier "parent/child DAG" plan was a category error (parent/child in Minions flips the parent to `waiting-children`, not the child to `waiting-for-parent`, so extract would have run before sync).
- **Per-step partial-failure handling.** Each of sync / extract / embed / backlinks is wrapped in its own try/catch. Handler returns `{ partial: true, failed_steps: [...] }` when any step fails; never throws. An intermittent extract bug no longer blocks every future cycle via Minion retry.
- **Env-aware `gbrain autopilot --install`** picks the right supervisor: launchd on macOS, systemd user unit on Linux-with-systemd (with a stricter `systemctl --user is-system-running` probe — the naive `/run/systemd/system` check was a false-positive magnet), bootstrap hook on ephemeral containers (Render / Railway / Fly / Docker — auto-injects into OpenClaw's `hooks/bootstrap/ensure-services.sh` when detected, use `--no-inject` to opt out), crontab otherwise. `--target` overrides detection. Uninstall mirrors all four targets.
- **Worker child spawn uses `resolveGbrainCliPath()`** — never blindly uses `process.execPath` (on source installs that's the Bun runtime, not `gbrain`). Resolution tries argv[1], then execPath ending `/gbrain`, then `which gbrain`.

### Added — library-level Core fns so handlers don't kill workers

Reusing CLI entry-point functions (`runExtract`, `runEmbed`, etc.) as Minion handler bodies was wrong — any `process.exit(1)` on bad args would kill the entire worker process and every in-flight job. New Core fns throw instead:

- `runExtractCore(engine, opts)` — wraps extract-links + extract-timeline.
- `runEmbedCore(engine, opts)` — accepts `{ slug, slugs, all, stale }`.
- `runBacklinksCore(opts)` — `{ action: 'check' | 'fix', dir, dryRun }`.
- `runLintCore(opts)` — returns counts, doesn't print human detail (CLI wrapper does that).

CLI wrappers (`runExtract`, `runEmbed`, etc.) stay as thin arg-parsers that catch + `process.exit(1)`. Handlers in `jobs.ts` import the Core fns directly.

### Added — skillify ships as a first-class gbrain skill

Ported from Wintermute, proven in production. Paired with `gbrain check-resolvable` gives a user-controllable equivalent of Hermes' auto-skill-creation — you decide when and what, the tooling keeps the 10-item checklist honest.

- `skills/skillify/SKILL.md` — the meta skill. Triggers: "skillify this", "is this a skill?", "make this proper".
- `scripts/skillify-check.ts` — machine-readable audit. `--json` for CI, `--recent` to check files modified in the last 7 days.
- README now has a short section explaining the Skillify + check-resolvable pair and why user-controlled beats auto-generated.

### Added — host-agnostic plugin contract (replaces handlers.json)

An earlier design draft shipped `~/.claude/gbrain-handlers.json` where each entry was a shell command the worker would exec. Codex flagged this as a durable RCE surface. Dropped in favor of a code-level plugin contract:

- `docs/guides/plugin-handlers.md` — the full contract. Host imports `gbrain/minions`, constructs a `MinionWorker`, calls `worker.register(name, fn)` for every custom handler, calls `worker.start()`. Ships the bootstrap as code in the host repo, same trust model as any other code.
- `skills/conventions/cron-via-minions.md` — the rewrite convention for cron manifests. PGLite branch keeps `--follow` (inline); Postgres branch drops `--follow` + uses `--idempotency-key` on the cycle slot.
- `skills/migrations/v0.11.0.md` — body restored as the host-agent instruction manual. Walks the host through every JSONL TODO using the 10-item skillify checklist.

### Added — `gbrain init --migrate-only` (the Codex H1 fix)

Running bare `gbrain init` with no flags defaulted to PGLite and called `saveConfig` — silently clobbering any existing Postgres config. The migration orchestrator now calls `gbrain init --migrate-only` which only applies the schema against the configured engine and NEVER writes a new config. Apply-migrations + stopgap + postinstall all use this flag. Bare `gbrain init` still exists and still defaults to PGLite when you want a fresh install.

### Changed

- `runPostUpgrade` is now async + runs `apply-migrations --yes` unconditionally (Codex H8).
- `gbrain upgrade`'s subprocess timeout for `post-upgrade` bumped 30s → 300s so the migration has room to do real work like autopilot install (Codex H7).
- Migration enumeration uses a TS registry at `src/commands/migrations/index.ts` instead of walking `skills/migrations/*.md` on disk — compiled binaries see the same set source installs do (Codex K).
- Migration diff rule: apply when no `status: "complete"` entry exists in `completed.jsonl` AND `version ≤ installed VERSION`. Earlier proposed "version > currentVersion" would have SKIPPED v0.11.0 when running v0.11.1 (Codex H9).
- Autopilot refreshes its lock-file mtime every cycle so a long-lived autopilot doesn't get declared "stale" by the next cron-fired invocation after 10 minutes (Codex C).
- CLAUDE.md gained a new "Migration is canonical, not advisory" section pinning the design principle.

### Tests

34 new unit tests across preferences, init-migrate-only, apply-migrations, v0.11.0 orchestrator, handlers, autopilot-resolve-cli, autopilot-install, skillify-check. All 1177 existing tests still green.

## [0.11.0] - 2026-04-18

### Added — Minions (agent orchestration primitives)

Minions was a job queue. Now it's an agent runtime. Everything your orchestrator needs to fan out work across sub-agents without turning them into orphans or rate-limit disasters.

- **Depth tracking and `max_spawn_depth`.** Runaway recursion is a real prod failure. Children inherit `depth = parent.depth + 1` and submit rejects past a configurable cap (default 5). Your orchestrator can no longer spawn itself into an infinite tree by accident.

- **Per-parent child cap (`max_children`).** Stop spawn storms before they hit OpenAI's rate limit. Set `max_children: 10` on a parent job and the 11th submit throws. Enforced via `SELECT ... FOR UPDATE` on the parent row so concurrent submits can't both slip through.

- **Per-job wall-clock timeout (`timeout_ms`).** The #2 daily OpenClaw pain is "agent stops responding" ... long handler, token bloat, no clock. Now every job can declare a ceiling. `handleTimeouts()` dead-letters expired rows; a per-job `setTimeout` fires AbortSignal as a best-effort handler interrupt. No retry on timeout, terminal by design.

- **Cascade cancel via recursive CTE.** `cancelJob()` walks the full descendant tree in a single statement and cancels everything. Grandchild orphan bug is gone. Re-parented descendants (via `removeChildDependency`) are naturally excluded. Depth cap of 100 on the CTE as runaway safety.

- **Idempotency keys.** Add `idempotency_key: 'sync:2026-04-18'` to your submit and only one job per key ever runs. PG unique partial index enforces it at the DB layer, two concurrent pods submitting the same key collapse to one row. No more "did my cron fire twice?" anxiety.

- **Child to parent `child_done` inbox.** When a child completes, the parent gets `{type:'child_done', child_id, job_name, result}` posted to its inbox in the same transaction as the token rollup. Fan-in for free. `readChildCompletions(parent_id)` filters the inbox by message type with an optional `since` cursor. Works as the primitive for future `waitForChildren(n)` helpers.

- **`removeOnComplete` / `removeOnFail`.** BullMQ convenience. Completed jobs don't bloat your `minion_jobs` table forever. Opt in per-job, the `child_done` message survives because it lives in the *parent's* inbox, not the child's.

- **Attachment manifest.** New `minion_attachments` table for binary payloads attached to jobs. Validation catches path traversal (`../`, `/`, `\`, null byte), oversize (5 MiB default, raiseable), invalid base64, and duplicate filenames per job. DB-level `UNIQUE (job_id, filename)` defends against concurrent addAttachment races. `storage_uri TEXT` column forward-compat for future S3 offload.

- **Cooperative AbortSignal.** Pause or cascade-cancel clears the job's `lock_token`, the running handler's next lock renewal fails and fires `ctx.signal.abort()`. Handlers that respect AbortSignal stop cleanly. Handlers that ignore it get dead-lettered by the DB-side `handleTimeouts`, either way, the row status is correct.

- **Transactional correctness fixes.** `completeJob()` and `failJob()` now wrap in `engine.transaction()`. Parent hook invocations (`resolveParent`, `failParent`, `removeChildDependency`) fold into the same transaction so a process crash between child-update and parent-update can't strand the parent in `waiting-children`. Fixed a pre-existing bug where `add()` was inverting child/parent status (child got `waiting-children`, parent stayed `waiting`, making the child unclaimable until a manual UPDATE). Tests that worked around it are now cleaned up.

- **Migration v7 (`agent_parity_layer`).** Additive schema: new columns on `minion_jobs` (all defaulted, nullable where appropriate), new `minion_attachments` table, 3 partial indexes for bounded scans (`idx_minion_jobs_timeout`, `idx_minion_jobs_parent_status`, `uniq_minion_jobs_idempotency`). Existing installs pick it up on next `gbrain init`, no manual action required.

### Fixed

- **JSONB double-encode bug.** When writing to JSONB columns via `engine.executeRaw(sql, params)`, postgres.js auto-JSON-encodes parameters. Calling `JSON.stringify(obj)` first stored a JSON string literal, making `jsonb_typeof = string` and breaking `payload->>'key'` queries silently. Fixed in three call sites (`child_done` inbox post, `updateProgress`, `sendMessage`). PGLite tolerated both forms so the unit tests missed it, only a real-Postgres E2E with the `payload->>` operator caught it.

- **Sibling completion race.** Under READ COMMITTED, two grandchildren completing concurrently each saw the other as still-active in their pre-commit snapshot, so neither flipped the parent out of `waiting-children`. Fixed by taking `SELECT ... FOR UPDATE` on the parent row at the start of `completeJob` and `failJob` transactions. Siblings now serialize on the parent lock, second commit sees the first as completed and correctly advances the parent.

### Tests

- **~33 new tests in `test/minions.test.ts`** covering depth cap, per-parent child cap, timeout dead-letter, cascade cancel (including the re-parent edge case), `removeOnComplete` / `removeOnFail`, idempotency (single + concurrent), `child_done` inbox (posted in txn + survives child removeOnComplete + since cursor), attachment validation (oversize, path traversal, null byte, duplicates, base64), AbortSignal firing on pause mid-handler, catch-block skipping `failJob` when aborted, worker in-flight bookkeeping, token-rollup guard when parent already terminal, setTimeout safety-net cleanup.

- **`test/e2e/minions-concurrency.test.ts`** ... two worker instances against real Postgres, 20 jobs, zero double-claims. The only test that actually verifies `FOR UPDATE SKIP LOCKED` under real concurrency. PGLite can't prove this.

- **`test/e2e/minions-resilience.test.ts`** ... 5 tests covering the 6 OpenClaw daily pains: spawn storms, agent stall, forgotten dispatches, cascade cancel, deep tree fan-in with grandchild completions. Every pain has a test that fails if the primitive regresses.

- **1066 unit + 105 E2E = 1171 tests passing** before this ship. The parity layer isn't just planned, it's pinned down.

## [0.10.2] - 2026-04-17

### Security — Wave 3 (9 vulnerabilities closed)

This wave closes a high-severity arbitrary-file-read in `file_upload`, fixes a fake trust boundary that let any cwd-local recipe execute arbitrary commands, and lays down real SSRF defense for HTTP health checks. If you ran `gbrain` in a directory where someone could drop a `recipes/` folder, this matters.

- **Arbitrary file read via `file_upload` is closed.** Remote (MCP) callers were able to read `/etc/passwd` or any other host file. Path validation now uses `realpathSync` + `path.relative` to catch symlinked-parent traversal, plus an allowlist regex for slugs and filenames (control chars, backslashes, RTL-override Unicode all rejected). Local CLI users still upload from anywhere — only remote callers are confined. Fixes Issue #139, contributed by @Hybirdss; original fix #105 by @garagon.
- **Recipe trust boundary is real now.** `loadAllRecipes()` previously marked every recipe as `embedded=true`, including ones from `./recipes/` in your cwd or `$GBRAIN_RECIPES_DIR`. Anyone who could drop a recipe in cwd could bypass every health-check gate. Now only package-bundled recipes (source install + global install) are trusted. Original fixes #106, #108 by @garagon.
- **String health_checks blocked for untrusted recipes.** Even with the recipe trust fix, the string health_check path ran `execSync` before reaching the typed-DSL switch — a malicious "embedded" recipe could `curl http://169.254.169.254/metadata` and exfiltrate cloud credentials. Non-embedded recipes are now hard-blocked from string health_checks; embedded recipes still get the `isUnsafeHealthCheck` defense-in-depth guard.
- **SSRF defense for HTTP health_checks.** New `isInternalUrl()` blocks loopback, RFC1918, link-local (incl. AWS metadata 169.254.169.254), CGNAT, IPv6 loopback, and IPv4-mapped IPv6 (`[::ffff:127.0.0.1]` canonicalized to hex hextets — both forms blocked). Bypass encodings handled: hex IPs (`0x7f000001`), octal (`0177.0.0.1`), single decimal (`2130706433`). Scheme allowlist rejects `file:`, `data:`, `blob:`, `ftp:`, `javascript:`. `fetch` runs with `redirect: 'manual'` and re-validates every Location header up to 3 hops. Original fix #108 by @garagon.
- **Prompt injection hardening for query expansion.** Restructured the LLM prompt with a system instruction that declares the query as untrusted data, plus an XML-tagged `<user_query>` boundary. Layered with regex sanitization (strips code fences, tags, injection prefixes) and output-side validation on the model's `alternative_queries` array (cap length, strip control chars, dedup, drop empties). The `console.warn` on stripped content never logs the query text itself. Original fix #107 by @garagon.
- **`list_pages` and `get_ingest_log` actually cap now.** Wave 3 found that `clampSearchLimit(limit, default)` was always allowing up to 100 — the second arg was the default, not the cap. Added a third `cap` parameter so `list_pages` caps at 100 and `get_ingest_log` caps at 50. Internal bulk commands (embed --all, export, migrate-engine) bypass the operation layer entirely and remain uncapped. Original fix #109 by @garagon.

### Added

- `OperationContext.remote` flag distinguishes trusted local CLI callers from untrusted MCP callers. Security-sensitive operations (currently `file_upload`) tighten their behavior when `remote=true`. Defaults to strict (treat as remote) when unset.
- Exported security helpers for testing and reuse: `validateUploadPath`, `validatePageSlug`, `validateFilename`, `parseOctet`, `hostnameToOctets`, `isPrivateIpv4`, `isInternalUrl`, `getRecipeDirs`, `sanitizeQueryForPrompt`, `sanitizeExpansionOutput`.
- 49 new tests covering symlink traversal, scheme allowlist, IPv4 bypass forms, IPv6 mapped addresses, prompt injection patterns, and recipe trust boundaries. Plus an E2E regression proving remote callers can't escape cwd.

### Contributors

Wave 3 fixes were contributed by **@garagon** (PRs #105-#109) and **@Hybirdss** (Issue #139). The collector branch re-implemented each fix with additional hardening for the residuals Codex caught during outside-voice review (parent-symlink traversal, fake `isEmbedded` boundary, redirect-following SSRF, scheme bypasses, `clampSearchLimit` semantics).

## [0.10.1] - 2026-04-15

### Fixed

- **`gbrain sync --watch` actually works now.** The watch loop existed but was never called because the CLI routed sync through the operation layer (single-pass only). Now sync routes through the CLI path that knows about `--watch` and `--interval`. Your cron workaround is no longer needed.

- **Sync auto-embeds your pages.** After syncing, gbrain now embeds the changed pages automatically. No more "I synced but search can't find my new page." Opt out with `--no-embed`. Large syncs (100+ pages) defer embedding to `gbrain embed --stale`.

- **First sync no longer repeats forever.** `performFullSync` wasn't saving its checkpoint. Fixed: sync state persists after full import so the next sync is incremental.

- **`dead_links` metric is consistent across engines.** Postgres was counting empty-content chunks instead of dangling links. Now both engines count the same thing: links pointing to non-existent pages.

- **Doctor recommends the right embed command.** Was suggesting `gbrain embed refresh` (doesn't exist). Now correctly says `gbrain embed --stale`.

### Added

- **`gbrain extract links|timeline|all`** builds your link graph and structured timeline from existing markdown. Scans for markdown links, frontmatter fields (company, investors, attendees), and See Also sections. Infers link types from directory structure. Parses both bullet (`- **YYYY-MM-DD** | Source — Summary`) and header (`### YYYY-MM-DD — Title`) timeline formats. Runs automatically after every sync.

- **`gbrain features --json --auto-fix`** scans your brain and tells you what you're not using, with your own numbers. Priority 1 (data quality): missing embeddings, dead links. Priority 2 (unused features): zero links, zero timeline, low coverage, unconfigured integrations. Agents run `--auto-fix` to handle everything automatically.

- **`gbrain autopilot --install`** sets up a persistent daemon that runs sync, extract, and embed in a continuous loop. Health-based scheduling: brain score >= 90 slows down, < 70 speeds up. Installs as a launchd service (macOS) or crontab entry (Linux). One command, brain maintains itself forever.

- **Brain health score (0-100)** in `gbrain health` and `gbrain doctor`. Weighted composite of embed coverage, link density, timeline coverage, orphan pages, and dead links. Agents use it as a health gate.

- **`gbrain embed --slugs`** embeds specific pages by slug. Used internally by sync auto-embed to target just the changed pages.

- **Instruction layer for agents.** RESOLVER.md routing entries, maintain skill sections, and setup skill phase for extract, features, and autopilot. Without these, agents would never discover the new commands.

## [0.10.0] - 2026-04-14

### Added

- **Background jobs that don't die.** Minions is a BullMQ-inspired job queue built directly into GBrain. No Redis. No external dependencies. Submit `gbrain jobs submit embed --follow` and it runs with automatic retry, exponential backoff, and stall detection. Kill the process mid-job? Stall detection catches it and requeues. Run `gbrain jobs work` to start a persistent worker daemon that processes jobs from the queue. Jobs are first-class: submit, list, cancel, retry, prune, stats, all from the CLI or MCP. Your agent can now run long operations (14K+ page embeds, bulk enrichment) as durable background jobs instead of fragile inline commands.

- **Your agent now has 24 skills, not 8.** 16 new brain skills generalized from a production deployment with 14,700+ pages. Signal detection, brain-first lookup, content ingestion (articles, video, meetings), entity enrichment, task management, cron scheduling, reports, and cross-modal review. All shipped as fat markdown files your agent reads on demand.

- **Signal detector fires on every message.** A cheap sub-agent spawns in parallel to capture original thinking and entity mentions. Ideas get preserved with exact phrasing. Entities get brain pages. The brain compounds on autopilot.

- **RESOLVER.md routes your agent to the right skill.** Modeled on a 215-line production dispatcher. Categorized routing table: always-on, brain ops, ingestion, thinking, operational. Your agent reads it, matches the user's intent, loads the skill. No slash commands needed.

- **Soul-audit builds your agent's identity.** 6-phase interactive interview generates SOUL.md (who the agent is), USER.md (who you are), ACCESS_POLICY.md (who sees what), and HEARTBEAT.md (operational cadence). Re-runnable anytime. Ships with minimal defaults so first boot is instant.

- **Access control out of the box.** 4-tier privacy policy (Full/Work/Family/None) enforced by skill instructions before every response. Template-based, configurable per user.

- **Conventions directory codifies operational discipline.** Brain-first lookup protocol, citation quality standards, model routing table, test-before-bulk rule, and cross-modal review pairs. These are the hard-won patterns that prevent bad bulk runs and silent failures.

- **`gbrain init` detects GStack and reports mod status.** After brain setup, init now shows how many skills are loaded, whether GStack is installed, and where to get it. GStack detection uses `gstack-global-discover` with fallback to known host paths.

- **Conformance standard for all skills.** Every skill now has YAML frontmatter (name, version, description, triggers, tools, mutating) plus Contract, Anti-Patterns, and Output Format sections. Two new test files validate conformance across all 25 skills.

- **Existing 8 skills migrated to conformance format.** Frontmatter added, Workflow renamed to Phases, Contract and Anti-Patterns sections added. Ingest becomes a thin router delegating to specialized ingestion skills.

### The 16 new skills

| Skill | What it does | Why it matters |
|-------|-------------|----------------|
| **signal-detector** | Fires on every message. Spawns a cheap model in parallel to capture original thinking and entity mentions. | Your brain compounds on autopilot. Every conversation is an ingest event. Miss a signal and the brain never learns it. |
| **brain-ops** | Brain-first lookup before any external API. The read-enrich-write loop that makes every response smarter. | Without this, your agent reaches for Google when the answer is already in the brain. Wastes tokens, misses context. |
| **idea-ingest** | Links, articles, tweets go into the brain with analysis, author people pages, and cross-linking. | Every article worth reading is worth remembering. The author gets a people page. The ideas get cross-linked to what you already know. |
| **media-ingest** | Video, audio, PDF, books, screenshots, GitHub repos. Transcripts, entity extraction, backlink propagation. | One skill handles every media format. Absorbs what used to be 3 separate skills (video-ingest, youtube-ingest, book-ingest). |
| **meeting-ingestion** | Transcripts become brain pages. Every attendee gets enriched. Every company discussed gets a timeline entry. | A meeting is NOT fully ingested until every entity is propagated. This is the skill that turns a transcript into 10 updated brain pages. |
| **citation-fixer** | Scans brain pages for missing or malformed `[Source: ...]` citations. Fixes formatting to match the standard. | Without citations, you can't trace facts back to where they came from. Six months later, "who said this?" has an answer. |
| **repo-architecture** | Where new brain files go. Decision protocol: primary subject determines directory, not format or source. | Prevents the #1 misfiling pattern: dumping everything in `sources/` because it came from a URL. |
| **skill-creator** | Create new skills following the conformance standard. MECE check against existing skills. Updates manifest and resolver. | Users who need a capability GBrain doesn't have can create it themselves. The skill teaches the agent how to extend itself. |
| **daily-task-manager** | Add, complete, defer, remove, review tasks with priority levels (P0-P3). Stored as a searchable brain page. | Your tasks live in the brain, not a separate app. The agent can cross-reference tasks with meeting notes and people pages. |
| **daily-task-prep** | Morning preparation. Calendar lookahead with brain context per attendee, open threads from yesterday, active task review. | Walk into every meeting with full context on every person in the room, automatically. |
| **cross-modal-review** | Spawn a different AI model to review the agent's work before committing. Refusal routing: if one model refuses, silently switch. | Two models agreeing is stronger signal than one model being thorough. Refusal routing means the user never sees "I can't do that." |
| **cron-scheduler** | Schedule staggering (5-min offsets), quiet hours (timezone-aware with wake-up override), thin job prompts. | 21 cron jobs at :00 is a thundering herd. Staggering prevents it. Quiet hours mean no 3 AM notifications. Wake-up override releases the backlog. |
| **reports** | Timestamped reports with keyword routing. "What's the latest briefing?" maps to the right report directory. | Cheap replacement for vector search on frequent queries. Don't embed. Load the file. |
| **testing** | Validates every skill has SKILL.md with frontmatter, manifest coverage, resolver coverage. The CI for your skill system. | 3 skills and you need validation. 24 skills and you need it yesterday. Catches dead references, missing sections, MECE violations. |
| **soul-audit** | 6-phase interview that generates SOUL.md, USER.md, ACCESS_POLICY.md, HEARTBEAT.md. Your agent's identity, built from your answers. | What makes Wintermute feel like Wintermute. Without personality and access control, every agent feels the same. |
| **webhook-transforms** | External events (SMS, meetings, social mentions) converted into brain pages with entity extraction. Dead-letter queue for failures. | Your brain ingests signals from everywhere. Not just conversations, but every webhook, every notification, every external event. |

### Infrastructure (new in v0.10.0)

- **Your brain now self-validates its own skill routing.** `checkResolvable()` verifies every skill is reachable from RESOLVER.md, detects MECE overlaps, flags missing triggers, and catches DRY violations. Runs from `bun test`, `gbrain doctor`, and the skill-creator skill. Every issue comes with a machine-readable fix object the agent can act on.

- **`gbrain doctor` got serious.** 8 health checks now (up from 5), plus a composite health score (0-100). Filesystem checks (resolver, conformance) run even without a database. `--fast` skips DB checks. `--json` output includes structured `issues` array with action strings so agents can parse and auto-fix.

- **Batch operations won't melt your machine anymore.** Adaptive load-aware throttling checks CPU and memory before each batch item. Exponential backoff with a 20-attempt safety cap. Active hours multiplier slows batch work during the day. Two concurrent batch process limit.

- **Your agent's classifiers get smarter automatically.** Fail-improve loop: try deterministic code first, fall back to LLM, log every fallback. Over time, the logs reveal which regex patterns are missing. Auto-generates test cases from successful LLM results. Tracks deterministic hit rate in `gbrain doctor` output.

- **Voice notes just work.** Groq Whisper transcription (with OpenAI fallback) via `transcribe_audio` operation. Files over 25MB get ffmpeg-segmented automatically. Transcripts flow through the standard import pipeline, entities get extracted, back-links get created.

- **Enrichment is now a global service, not a per-skill skill.** Every ingest pathway can call `extractAndEnrich()` to detect entities and create/update their brain pages. Tier auto-escalation: entities start at Tier 3, auto-promote to Tier 1 based on mention frequency across sources.

- **Data research: one skill for any email-to-tracker pipeline.** New `data-research` skill with parameterized YAML recipes. Extract investor updates (MRR, ARR, runway, headcount), expense receipts, company metrics from email. Battle-tested regex patterns, extraction integrity rule (save first, report second), dedup with configurable tolerance, canonical tracker pages with running totals.

### For contributors

- `test/skills-conformance.test.ts` validates every skill has valid frontmatter and required sections
- `test/resolver.test.ts` validates RESOLVER.md coverage and routing consistency
- `skills/manifest.json` now has `conformance_version` field and lists all 24 skills
- Identity templates in `templates/` (SOUL.md, USER.md, ACCESS_POLICY.md, HEARTBEAT.md)
## [0.9.3] - 2026-04-12

### Added

- **Search understands what you're asking. +21% page coverage, +29% signal, 100% source accuracy.** A zero-latency intent classifier reads your query and picks the right search mode. "Who is Alice?" surfaces your compiled truth assessment. "When did we last meet?" surfaces timeline entries with dates. No LLM call, just pattern matching. Your agent sees 8.7 relevant pages per query instead of 7.2, and two thirds of returned chunks are now distilled assessments instead of half. Entity lookups always lead with compiled truth. Temporal queries always find the dates. Benchmarked against 29 pages, 20 queries with graded relevance (run `bun run test/benchmark-search-quality.ts` to reproduce). Inspired by Ramp Labs' "Latent Briefing" paper (April 2026).
- **`gbrain query --detail low/medium/high`.** Agents can control how deep search goes. `low` returns compiled truth only. `medium` (default) returns everything with dedup. `high` returns all chunks uncapped. Auto-escalates from low to high if no results found. MCP picks it up automatically.
- **`gbrain eval` measures search quality.** Full retrieval evaluation harness with P@k, R@k, MRR, nDCG@k metrics. A/B comparison mode for parameter tuning: `gbrain eval --qrels queries.json --config-a baseline.json --config-b boosted.json`. Contributed by @4shut0sh.
- **CJK queries expand correctly.** Chinese, Japanese, and Korean text was silently skipping query expansion because word count used space-delimited splitting. Now counts characters for CJK. Contributed by @YIING99.
- **Health checks speak a typed language now.** Recipe `health_checks` use a typed DSL (`http`, `env_exists`, `command`, `any_of`) instead of raw shell strings. No more `execSync(untrustedYAML)`. Your agent runs `gbrain integrations doctor` and gets structured results, not shell injection risk. All 7 first-party recipes migrated. String health checks still work (with deprecation warning) for backward compat.

### Fixed

- **Your storage backend can't be tricked into reading `/etc/passwd`.** `LocalStorage` now validates every path stays within the storage root. `../../etc/passwd` gets "Path traversal blocked" instead of your system files. All 6 methods covered (upload, download, delete, exists, list, getUrl).
- **MCP callers can't read arbitrary files via `file_url`.** `resolveFile()` now validates the requested path stays within the brain root before touching the filesystem. Previously, `../../etc/passwd` would read any file the process could access.
- **`.supabase` marker files can't escape their scope.** Marker prefix validation now rejects `../`, absolute paths, and bare `..`. A crafted `.supabase` file in a shared brain repo can't make storage requests outside the intended prefix.
- **File queries can't blow up memory.** The slug-filtered `file_list` MCP operation now has the same `LIMIT 100` as the unfiltered branch. Also fixed the CLI `gbrain files list` and `gbrain files verify` commands.
- **Symlinks in brain directories can't exfiltrate files.** All 4 file walkers in `files.ts` plus the `init.ts` size counter now use `lstatSync` and skip symlinks. Broken symlinks and `node_modules` directories are also skipped.
- **Recipe health checks can't inject shell commands.** Non-embedded (user-created) recipes with shell metacharacters in health_check strings are blocked. First-party recipes are trusted but migrated to the typed DSL.

## [0.9.2] - 2026-04-12

### Fixed

- **Fresh local installs initialize cleanly again.** `gbrain init` now creates the local PGLite data directory before taking its advisory lock, so first-run setup no longer misreports a missing directory as a lock timeout.

## [0.9.1] - 2026-04-11

### Fixed

- **Your brain can't be poisoned by rogue frontmatter anymore.** Slug authority is now path-derived. A file at `notes/random.md` can't declare `slug: people/admin` and silently overwrite someone else's page. Mismatches are rejected with a clear error telling you exactly what to fix.
- **Symlinks in your notes directory can't exfiltrate files.** The import walker now uses `lstatSync` and refuses to follow symlinks, blocking the attack where a contributor plants a link to `~/.zshrc` in the brain directory. Defense-in-depth: `importFromFile` itself also checks.
- **Giant payloads through MCP can't rack up your OpenAI bill.** `importFromContent` now checks `Buffer.byteLength` before any processing. 10 MB of emoji through `put_page`? Rejected before chunking starts.
- **Search can't be weaponized into a DoS.** `limit` is clamped to 100 across all search paths (keyword, vector, hybrid). `statement_timeout: 8s` on the Postgres connection as defense-in-depth. Requesting `limit: 10000000` now gets you 100 results and a warning.
- **PGLite stops crashing when two processes touch the same brain.** File-based advisory lock using atomic `mkdir` with PID tracking and 5-minute stale detection. Clear error messages tell you which process holds the lock and how to recover.
- **12 data integrity fixes landed.** Orphan chunks cleaned up on empty pages. Write operations (`addLink`, `addTag`, `addTimelineEntry`, `putRawData`, `createVersion`) now throw when the target page doesn't exist instead of silently no-opping. Health metrics (`stale_pages`, `dead_links`, `orphan_pages`) now measure real problems instead of always returning 0. Keyword search moved from JS-side sort-and-splice to a SQL CTE with `LIMIT`. MCP server validates params before dispatch.
- **Stale embeddings can't lie to you anymore.** When chunk text changes but embedding fails, the old vector is now NULL'd out instead of preserved. Previously, search could return results based on outdated vectors attached to new text.
- **Embedding failures are no longer silent.** The `catch { /* non-fatal */ }` is gone. You now get `[gbrain] embedding failed for slug (N chunks): error message` in stderr. Still non-fatal, but you know what happened.
- **O(n^2) chunk lookup in `embedPage` is gone.** Replaced `find() + indexOf()` with a single `Map` lookup. Matches the pattern `embedAll` already uses.
- **Stdin bombs blocked.** `parseOpArgs` now caps stdin at 5 MB before the full buffer is consumed.

### Added

- **`gbrain embed --all` is 30x faster.** Sliding worker pool with 20 concurrent workers (tunable via `GBRAIN_EMBED_CONCURRENCY`). A 20,000-chunk corpus that took 2.5 hours now finishes in ~8 minutes.
- **Search pagination.** Both `search` and `query` now accept `--offset` for paginating through results. Combined with the 100-result ceiling, you can now page through large result sets.
- **`gbrain ask` is an alias for `gbrain query`.** CLI-only, doesn't appear in MCP tools-json.
- **Content hash now covers all page fields.** Title, type, and frontmatter changes trigger re-import. First sync after upgrade will re-import all pages (one-time, expected).
- **Migration file for v0.9.1.** Auto-update agent knows to expect the full re-import and will run `gbrain embed --all` afterward.
- **`pgcrypto` extension added to schema.** Fallback for `gen_random_uuid()` on Postgres < 13.

### Changed

- **Search type and exclude_slugs filters now work.** These were advertised in the API but never implemented. Both `searchKeyword` and `searchVector` now respect `type` and `exclude_slugs` params.
- **Hybrid search no longer double-embeds the query.** `expandQuery` already includes the original, so we use it directly instead of prepending.

## [0.9.0] - 2026-04-11

### Added

- **Large files don't bloat your git repo anymore.** `gbrain files upload-raw`
  auto-routes by size: text and PDFs under 100 MB stay in git, everything larger
  (or any media file) goes to Supabase Storage with a `.redirect.yaml` pointer
  left in the repo. Files over 100 MB use TUS resumable upload (6 MB chunks with
  retry and backoff) so a flaky connection doesn't lose a 2 GB video upload.
  `gbrain files signed-url` generates 1-hour access links for private buckets.

- **The full file migration lifecycle works end to end.** `mirror` uploads to
  cloud and keeps local copies. `redirect` replaces local files with
  `.redirect.yaml` pointers (verifies remote exists first, won't delete data).
  `restore` downloads back from cloud. `clean` removes pointers when you're sure.
  `status` shows where you are. Three states, zero data loss risk.

- **Your brain now enforces its own graph integrity.** The Iron Law of Back-Linking
  is mandatory across all skills. Every mention of a person or company creates
  a bidirectional link. This transforms your brain from a flat file store into a
  traversable knowledge graph.

- **Filing rules prevent the #1 brain mistake.** New `skills/_brain-filing-rules.md`
  stops the most common error: dumping everything into `sources/`. File by primary
  subject, not format. Includes notability gate and citation requirements.

- **Enrichment protocol that actually works.** Rewritten from a 46-line API list to
  a 7-step pipeline with 3-tier system, person/company page templates, pluggable
  data sources, validation rules, and bulk enrichment safety.

- **Ingest handles everything.** Articles, videos, podcasts, PDFs, screenshots,
  meeting transcripts, social media. Each with a workflow that uses real gbrain
  commands (`upload-raw`, `signed-url`) instead of theoretical patterns.

- **Citation requirements across all skills.** Every fact needs inline
  `[Source: ...]` citations. Three formats, source precedence hierarchy.

- **Maintain skill catches what you missed.** Back-link enforcement, citation audit,
  filing violations, file storage health checks, benchmark testing.

- **Voice calls don't crash on em dashes anymore.** Unicode sanitization for Twilio
  WebSocket, PII scrub, identity-first prompt, DIY STT+LLM+TTS pipeline option,
  Smart VAD default, auto-upload call audio via `gbrain files upload-raw`.

- **X-to-Brain gets eyes.** Image OCR, Filtered Stream real-time monitoring,
  6-dimension tweet rating rubric, outbound tweet monitoring, cron staggering.

- **Share brain pages without exposing the brain.** `gbrain publish` generates
  beautiful, self-contained HTML from any brain page. Strips private data
  (frontmatter, citations, confirmations, brain links, timeline) automatically.
  Optional AES-256-GCM password gate with client-side decryption, no server
  needed. Dark/light mode, mobile-optimized typography. This is the first
  code+skill pair: deterministic code does the work, the skill tells the agent
  when and how. See the [Thin Harness, Fat Skills](https://x.com/garrytan/status/2042925773300908103)
  thread for the architecture philosophy.

### Changed

- **Supabase Storage** now auto-selects upload method by file size: standard POST
  for < 100 MB, TUS resumable for >= 100 MB. Signed URL generation for private
  bucket access (1-hour expiry).
- **File resolver** supports both `.redirect.yaml` (v0.9+) and legacy `.redirect`
  (v0.8) formats for backward compatibility.
- **Redirect format** upgraded from `.redirect` (5 fields) to `.redirect.yaml`
  (10 fields: target, bucket, storage_path, size, size_human, hash, mime,
  uploaded, source_url, type).
- **All skills** updated to reference actual `gbrain files` commands instead of
  theoretical patterns.
- **Back-link enforcer closes the loop.** `gbrain check-backlinks check` scans your
  brain for entity mentions without back-links. `gbrain check-backlinks fix` creates
  them. The Iron Law of Back-Linking is in every skill, now the code enforces it.

- **Page linter catches LLM slop.** `gbrain lint` flags "Of course! Here is..."
  preambles, wrapping code fences, placeholder dates, missing frontmatter, broken
  citations, and empty sections. `gbrain lint --fix` auto-strips the fixable ones.
  Every brain that uses AI for ingestion accumulates this. Now it's one command.

- **Audit trail for everything.** `gbrain report --type enrichment-sweep` saves
  timestamped reports to `brain/reports/{type}/YYYY-MM-DD-HHMM.md`. The maintain
  skill references this for enrichment sweeps, meeting syncs, and maintenance runs.

- **Publish skill** added to manifest (8th skill). First code+skill pair.
- Skills version bumped to 0.9.0.
- 67 new unit tests across publish, backlinks, lint, and report. Total: 409 pass.

## [0.8.0] - 2026-04-11

### Added

- **Your AI can answer the phone now.** Voice-to-brain v0.8.0 ships 25 production patterns from a real deployment. WebRTC works in a browser tab with just an OpenAI key, phone number via Twilio is optional. Your agent picks its own name and personality. Pre-computed engagement bids mean it greets you with something specific ("dude, your social radar caught something wild today"), not "how can I help you?" Context-first prompts, proactive advisor mode, caller routing, dynamic noise suppression, stuck watchdog, thinking sounds during tool calls. This is the "Her" experience, out of the box.
- **Upgrade = feature discovery.** When you upgrade to v0.8.0, the CLI tells you what's new and your agent offers to set up voice immediately. WebRTC-first (zero setup), then asks about a phone number. Migration files now have YAML frontmatter with `feature_pitch` so every future version can pitch its headline feature through the upgrade flow.
- **Remote MCP simplified.** The Supabase Edge Function deployment is gone. Remote MCP now uses a self-hosted server + ngrok tunnel. Simpler, more reliable, works with any AI client. All `docs/mcp/` guides updated to reflect the actual production architecture.

### Changed

- **Voice recipe is now 25 production patterns deep.** Identity separation, pre-computed bid system, context-first prompts, proactive advisor mode, conversation timing (the #1 fix), no-repetition rule, radical prompt compression (13K to 4.7K tokens), OpenAI Realtime Prompting Guide structure, auth-before-speech, brain escalation, stuck watchdog, never-hang-up rule, thinking sounds, fallback TwiML, tool set architecture, trusted user auth, caller routing, dynamic VAD, on-screen debug UI, live moment capture, belt-and-suspenders post-call, mandatory 3-step post-call, WebRTC parity, dual API event handling, report-aware query routing.
- **WebRTC session pseudocode updated.** Native FormData, `tools` in session config, `type: 'realtime'` on all session.update calls. WebRTC transcription NOT supported over data channel (use Whisper post-call).
- **MCP docs rewritten.** All per-client guides (Claude Code, Claude Desktop, Cowork, Perplexity) updated from Edge Function URLs to self-hosted + ngrok pattern.

### Removed

- **Supabase Edge Function MCP deployment.** `scripts/deploy-remote.sh`, `supabase/functions/gbrain-mcp/`, `src/edge-entry.ts`, `.env.production.example`, `docs/mcp/CHATGPT.md` all removed. The Edge Function never worked reliably. Self-hosted + ngrok is the path.

## [0.7.0] - 2026-04-11

### Added

- **Your brain now runs locally with zero infrastructure.** PGLite (Postgres 17.5 compiled to WASM) gives you the exact same search quality as Supabase, same pgvector HNSW, same pg_trgm fuzzy matching, same tsvector full-text search. No server, no subscription, no API keys needed for keyword search. `gbrain init` and you're running in 2 seconds.
- **Smart init defaults to local.** `gbrain init` now creates a PGLite brain by default. If your repo has 1000+ markdown files, it suggests Supabase for scale. `--supabase` and `--pglite` flags let you choose explicitly.
- **Migrate between engines anytime.** `gbrain migrate --to supabase` transfers your entire brain (pages, chunks, embeddings, tags, links, timeline) to remote Postgres with manifest-based resume. `gbrain migrate --to pglite` goes the other way. Embeddings copy directly, no re-embedding needed.
- **Pluggable engine factory.** `createEngine()` dynamically loads the right engine from config. PGLite WASM is never loaded for Postgres users.
- **Search works without OpenAI.** `hybridSearch` now checks for `OPENAI_API_KEY` before attempting embeddings. No key = keyword-only search. No more crashes when you just want to search your local brain.
- **Your brain gets new senses automatically.** Integration recipes teach your agent how to wire up voice calls, email, Twitter, and calendar into your brain. Run `gbrain integrations` to see what's available. Your agent reads the recipe, asks for API keys, validates each one, and sets everything up. Markdown is code -- the recipe IS the installer.
- **Voice-to-brain: phone calls create brain pages.** The first recipe: Twilio + OpenAI Realtime voice agent. Call a number, talk, and a structured brain page appears with entity detection, cross-references, and a summary posted to your messaging app. Opinionated defaults: caller screening, brain-first lookup, quiet hours, thinking sounds. The smoke test calls YOU (outbound) so you experience the magic immediately.
- **`gbrain integrations` command.** Six subcommands for managing integration recipes: `list` (dashboard of senses + reflexes), `show` (recipe details), `status` (credential checks with direct links to get missing keys), `doctor` (health checks), `stats` (signal analytics), `test` (recipe validation). `--json` on every subcommand for agent-parseable output. No database connection needed.
- **Health heartbeat.** Integrations log events to `~/.gbrain/integrations/<id>/heartbeat.jsonl`. Status checks detect stale integrations and include diagnostic steps.
- **17 individually linkable SKILLPACK guides.** The 1,281-line monolith is now broken into standalone guides at `docs/guides/`, organized by category. Each guide is individually searchable and linkable. The SKILLPACK index stays at the same URL (backward compatible).
- **"Getting Data In" documentation.** New `docs/integrations/` with a landing page, recipe format documentation, credential gateway guide, and meeting webhook guide. Explains the deterministic collector pattern: code for data, LLMs for judgment.
- **Architecture and philosophy docs.** `docs/architecture/infra-layer.md` documents the shared foundation (import, chunk, embed, search). `docs/ethos/THIN_HARNESS_FAT_SKILLS.md` is Garry's essay on the architecture philosophy with an agent decision guide. `docs/designs/HOMEBREW_FOR_PERSONAL_AI.md` maps the 10-star vision.

### Changed

- **Engine interface expanded.** Added `runMigration()` (replaces internal driver access for schema migrations) and `getChunksWithEmbeddings()` (loads embedding data for cross-engine migration).
- **Shared utilities extracted.** `validateSlug`, `contentHash`, and row mappers moved from `postgres-engine.ts` to `src/core/utils.ts`. Both engines share them.
- **Config infers engine type.** If `database_path` is set but `engine` is missing, config now infers `pglite` instead of defaulting to `postgres`.
- **Import serializes on PGLite.** Parallel workers are Postgres-only. PGLite uses sequential import (single-connection architecture).

## [0.6.1] - 2026-04-10

### Fixed

- **Import no longer silently drops files with "..." in the name.** The path traversal check rejected any filename containing two consecutive dots, killing 1.2% of files in real-world corpora (YouTube transcripts, TED talks, podcast titles). Now only rejects actual traversal patterns like `../`. Community fix wave, 8 contributors.
- **Import no longer crashes on JavaScript/TypeScript projects.** The file walker crashed on `node_modules` directories and broken symlinks. Now skips `node_modules` and handles broken symlinks gracefully with a warning.
- **`gbrain init` exits cleanly after setup.** Previously hung forever because stdin stayed open. Now pauses stdin after reading input.
- **pgvector extension auto-created during init.** No more copy-pasting SQL into the Supabase editor. `gbrain init` now runs `CREATE EXTENSION IF NOT EXISTS vector` automatically, with a clear fallback message if it can't.
- **Supabase connection string hint matches current dashboard UI.** Updated navigation path to match the 2026 Supabase dashboard layout.
- **Hermes Agent link fixed in README.** Pointed to the correct NousResearch GitHub repo.

### Changed

- **Search is faster.** Keyword search now runs in parallel with the embedding pipeline instead of waiting for it. Saves ~200-500ms per hybrid search call.
- **.mdx files are now importable.** The import walker, sync filter, and slug generator all recognize `.mdx` alongside `.md`.

### Added

- **Community PR wave process** documented in CLAUDE.md for future contributor batches.

### Contributors

Thank you to everyone who reported bugs, submitted fixes, and helped make GBrain better:

- **@orendi84** — slug validator ellipsis fix (PR #31)
- **@mattbratos** — import walker resilience + MDX support (PRs #26, #27)
- **@changergosum** — init exit fix + auto pgvector (PRs #17, #18)
- **@eric-hth** — Supabase UI hint update (PR #30)
- **@irresi** — parallel hybrid search (PR #8)
- **@howardpen9** — Hermes Agent link fix (PR #34)
- **@cktang88** — the thorough 12-bug report that drove v0.6.0 (Issue #22)
- **@mvanhorn** — MCP schema handler fix (PR #25)

## [0.6.0] - 2026-04-10

### Added

- **Access your brain from any AI client.** Deploy GBrain as a serverless remote MCP endpoint on your existing Supabase instance. Works with Claude Desktop, Claude Code, Cowork, and Perplexity Computer. One URL, bearer token auth, zero new infrastructure. Clone the repo, fill in 3 env vars, run `scripts/deploy-remote.sh`, done.
- **Per-client setup guides** in `docs/mcp/` for Claude Code, Claude Desktop, Cowork, Perplexity, and ChatGPT (coming soon, requires OAuth 2.1). Also documents Tailscale Funnel and ngrok as self-hosted alternatives.
- **Token management** via standalone `src/commands/auth.ts`. Create, list, revoke per-client bearer tokens. Includes smoke test: `auth.ts test <url> --token <token>` verifies the full pipeline (initialize + tools/list + get_stats) in 3 seconds.
- **Usage logging** via `mcp_request_log` table. Every remote tool call logs token name, operation, latency, and status for debugging and security auditing.
- **Hardened health endpoint** at `/health`. Unauthenticated: 200/503 only (no info disclosure). Authenticated: checks postgres, pgvector, and OpenAI API key status.

### Fixed

- **MCP server actually connects now.** Handler registration used string literals (`'tools/list' as any`) instead of SDK typed schemas. Replaced with `ListToolsRequestSchema` and `CallToolRequestSchema`. Without this fix, `gbrain serve` silently failed to register handlers. (Issue #9)
- **Search results no longer flooded by one large page.** Keyword search returned ALL chunks from matching pages. Now returns one best chunk per page via `DISTINCT ON`. (Issue #22)
- **Search dedup no longer collapses to one chunk per page.** Layer 1 kept only the single highest-scoring chunk per slug. Now keeps top 3, letting later dedup layers (text similarity, cap per page) do their job. (Issue #22)
- **Transactions no longer corrupt shared state.** Both `PostgresEngine.transaction()` and `db.withTransaction()` swapped the shared connection reference, breaking under concurrent use. Now uses scoped engine via `Object.create` with no shared state mutation. (Issue #22)
- **embed --stale no longer wipes valid embeddings.** `upsertChunks()` deleted all chunks then re-inserted, writing NULL for chunks without new embeddings. Now uses UPSERT (INSERT ON CONFLICT UPDATE) with COALESCE to preserve existing embeddings. (Issue #22)
- **Slug normalization is consistent.** `pathToSlug()` preserved case while `inferSlug()` lowercased. Now `validateSlug()` enforces lowercase at the validation layer, covering all entry points. (Issue #22)
- **initSchema no longer reads from disk at runtime.** Both schema loaders used `readFileSync` with `import.meta.url`, which broke in compiled binaries and Deno Edge Functions. Schema is now embedded at build time via `scripts/build-schema.sh`. (Issue #22)
- **file_upload actually uploads content.** The operation wrote DB metadata but never called the storage backend. Fixed in all 3 paths (operation, CLI upload, CLI sync) with rollback semantics. (Issue #22)
- **S3 storage backend authenticates requests.** `signedFetch()` was just unsigned `fetch()`. Replaced with `@aws-sdk/client-s3` for proper SigV4 signing. Supports R2/MinIO via `forcePathStyle`. (Issue #22)
- **Parallel import uses thread-safe queue.** `queue.shift()` had race conditions under parallel workers. Now uses an atomic index counter. Checkpoint preserved on errors for safe resume. (Issue #22)
- **redirect verifies remote existence before deleting local files.** Previously deleted local files unconditionally. Now checks storage backend before removing. (Issue #22)
- **`gbrain call` respects dry_run.** `handleToolCall()` hardcoded `dryRun: false`. Now reads from params. (Issue #22)

### Changed

- Added `@aws-sdk/client-s3` as a dependency for authenticated S3 operations.
- Schema migration v2: unique index on `content_chunks(page_id, chunk_index)` for UPSERT support.
- Schema migration v3: `access_tokens` and `mcp_request_log` tables for remote MCP auth.

## [0.5.1] - 2026-04-10

### Fixed

- **Apple Notes and files with spaces just work.** Paths like `Apple Notes/2017-05-03 ohmygreen.md` now auto-slugify to clean slugs (`apple-notes/2017-05-03-ohmygreen`). Spaces become hyphens, parens and special characters are stripped, accented characters normalize to ASCII. All 5,861+ Apple Notes files import cleanly without manual renaming.
- **Existing brains auto-migrate.** On first run after upgrade, a one-time migration renames all existing slugs with spaces or special characters to their clean form. Links are rewritten automatically. No manual cleanup needed.
- **Import and sync produce identical slugs.** Both pipelines now use the same `slugifyPath()` function, eliminating the mismatch where sync preserved case but import lowercased.

## [0.5.0] - 2026-04-10

### Added

- **Your brain never falls behind.** Live sync keeps the vector DB current with your brain repo automatically. Set up a cron, use `--watch`, hook into GitHub webhooks, or use git hooks. Your agent picks whatever fits its environment. Edit a markdown file, push, and within minutes it's searchable. No more stale embeddings serving wrong answers.
- **Know your install actually works.** New verification runbook (`docs/GBRAIN_VERIFY.md`) catches the silent failures that used to go unnoticed: the pooler bug that skips pages, missing embeddings, stale sync. The real test: push a correction, wait, search for it. If the old text comes back, sync is broken and the runbook tells you exactly why.
- **New installs set up live sync automatically.** The setup skill now includes live sync (Phase H) and full verification (Phase I) as mandatory steps. Agents that install GBrain will configure automatic sync and verify it works before declaring setup complete.
- **Fixes the silent page-skip bug.** If your Supabase connection uses the Transaction mode pooler, sync silently skips most pages. The new docs call this out as a hard prerequisite with a clear fix (switch to Session mode). The verification runbook catches it by comparing page count against file count.

## [0.4.2] - 2026-04-10

### Changed

- All GitHub Actions pinned to commit SHAs across test, e2e, and release workflows. Prevents supply chain attacks via mutable version tags.
- Workflow permissions hardened: `contents: read` on test and e2e workflows limits GITHUB_TOKEN blast radius.
- OpenClaw CI install pinned to v2026.4.9 instead of pulling latest.

### Added

- Gitleaks secret scanning CI job runs on every push and PR. Catches accidentally committed API keys, tokens, and credentials.
- `.gitleaks.toml` config with allowlists for test fixtures and example files.
- GitHub Actions SHA maintenance rule in CLAUDE.md so pins stay fresh on every `/ship` and `/review`.
- S3 Sig V4 TODO for future implementation when S3 storage becomes a deployment path.

## [0.4.1] - 2026-04-09

### Added

- `gbrain check-update` command with `--json` output. Checks GitHub Releases for new versions, compares semver (minor+ only, skips patches), fetches and parses changelog diffs. Fail-silent on network errors.
- SKILLPACK Section 17: Auto-Update Notifications. Full agent playbook for the update lifecycle: check, notify, consent, upgrade, skills refresh, schema sync, report. Never auto-upgrades without user permission.
- Standalone SKILLPACK self-update for users who load the skillpack directly without the gbrain CLI. Version markers in SKILLPACK and RECOMMENDED_SCHEMA headers, with raw GitHub URL fetching.
- Step 7 in the OpenClaw install paste: daily update checks, default-on. User opts into being notified about updates, not into automatic installs.
- Setup skill Phase G: conditional auto-update offer for manual install users.
- Schema state tracking via `~/.gbrain/update-state.json`. Tracks which recommended schema directories the user adopted, declined, or added custom. Future upgrades suggest new additions without re-suggesting declined items.
- `skills/migrations/` directory convention for version-specific post-upgrade agent directives.
- 20 unit tests and 5 E2E tests for the check-update command, covering version comparison, changelog extraction, CLI wiring, and real GitHub API interaction.
- E2E test DB lifecycle documentation in CLAUDE.md: spin up, run tests, tear down. No orphaned containers.

### Changed

- `detectInstallMethod()` exported from `upgrade.ts` for reuse by `check-update`.

### Fixed

- Semver comparison in changelog extraction was missing major-version guard, causing incorrect changelog entries to appear when crossing major version boundaries.

## [0.4.0] - 2026-04-09

### Added

- `gbrain doctor` command with `--json` output. Checks pgvector extension, RLS policies, schema version, embedding coverage, and connection health. Agents can self-diagnose issues.
- Pluggable storage backends: S3, Supabase Storage, and local filesystem. Choose where binary files live independently of the database. Configured via `gbrain init` or environment variables.
- Parallel import with per-worker engine instances. Large brain imports now use multiple database connections concurrently instead of a single serial pipeline.
- Import resume checkpoints. If `gbrain import` is interrupted, it picks up where it left off instead of re-importing everything.
- Automatic schema migration runner. On connect, gbrain detects the current schema version and applies any pending migrations without manual intervention.
- Row-Level Security (RLS) enabled on all tables with `BYPASSRLS` safety check. Every query goes through RLS policies.
- `--json` flag on `gbrain init` and `gbrain import` for machine-readable output. Agents can parse structured results instead of scraping CLI text.
- File migration CLI (`gbrain files migrate`) for moving files between storage backends. Two-way-door: test with `--dry-run`, migrate incrementally.
- Bulk chunk INSERT for faster page writes. Chunks are inserted in a single statement instead of one-at-a-time.
- Supabase smart URL parsing: automatically detects and converts IPv6-only pooler URLs to the correct connection format.
- 56 new unit tests covering doctor, storage backends, file migration, import resume, slug validation, setup branching, Supabase admin, and YAML parsing. Test suite grew from 9 to 19 test files.
- E2E tests for parallel import concurrency and all new features.

### Fixed

- `validateSlug` now accepts any filename characters (spaces, unicode, special chars) instead of rejecting non-alphanumeric slugs. Apple Notes and other real-world filenames import cleanly.
- Import resilience: files over 5MB are skipped with a warning instead of crashing the pipeline. Errors in individual files no longer abort the entire import.
- `gbrain init` detects IPv6-only Supabase URLs and adds the required `pgvector` check during setup.
- E2E test fixture counts, CLI argument parsing, and doctor exit codes cleaned up.

### Changed

- Setup skill and README rewritten for agent-first developer experience.
- Maintain skill updated with RLS verification, schema health checks, and `nohup` hints for large embedding jobs.

## [0.3.0] - 2026-04-08

### Added

- Contract-first architecture: single `operations.ts` defines ~30 shared operations. CLI, MCP, and tools-json all generated from the same source. Zero drift.
- `OperationError` type with structured error codes (`page_not_found`, `invalid_params`, `embedding_failed`, etc.). Agents can self-correct.
- `dry_run` parameter on all mutating operations. Agents preview before committing.
- `importFromContent()` split from `importFile()`. Both share the same chunk+embed+tag pipeline, but `importFromContent` works from strings (used by `put_page`). Wrapped in `engine.transaction()`.
- Idempotency hash now includes ALL fields (title, type, frontmatter, tags), not just compiled_truth + timeline. Metadata-only edits no longer silently skipped.
- `get_page` now supports optional `fuzzy: true` for slug resolution. Returns `resolved_slug` so callers know what happened.
- `query` operation now supports `expand` toggle (default true). Both CLI and MCP get the same control.
- 10 new operations wired up: `put_raw_data`, `get_raw_data`, `resolve_slugs`, `get_chunks`, `log_ingest`, `get_ingest_log`, `file_list`, `file_upload`, `file_url`.
- OpenClaw bundle plugin manifest (`openclaw.plugin.json`) with config schema, MCP server config, and skill listing.
- GitHub Actions CI: test on push/PR, multi-platform release builds (macOS arm64 + Linux x64) on version tags.
- `gbrain init --non-interactive` flag for plugin mode (accepts config via flags/env vars, no TTY required).
- Post-upgrade version verification in `gbrain upgrade`.
- Parity test (`test/parity.test.ts`) verifies structural contract between operations, CLI, and MCP.
- New `setup` skill replacing `install`: auto-provision Supabase via CLI, AGENTS.md injection, target TTHW < 2 min.
- E2E test suite against real Postgres+pgvector. 13 realistic fixtures (miniature brain with people, companies, deals, meetings, concepts), 14 test suites covering all operations, search quality benchmarks, idempotency stress tests, schema validation, and full setup journey verification.
- GitHub Actions E2E workflow: Tier 1 (mechanical) on every PR, Tier 2 (LLM skills via OpenClaw) nightly.
- `docker-compose.test.yml` and `.env.testing.example` for local E2E development.

### Fixed

- Schema loader in `db.ts` broke on PL/pgSQL trigger functions containing semicolons inside `$$` blocks. Replaced per-statement execution with single `conn.unsafe()` call.
- `traverseGraph` query failed with "could not identify equality operator for type json" when using `SELECT DISTINCT` with `json_agg`. Changed to `jsonb_agg`.

### Changed

- `src/mcp/server.ts` rewritten from ~233 to ~80 lines. Tool definitions and dispatch generated from operations[].
- `src/cli.ts` rewritten. Shared operations auto-registered from operations[]. CLI-only commands (init, upgrade, import, export, files, embed) kept as manual registrations.
- `tools-json` output now generated FROM operations[]. Third contract surface eliminated.
- All 7 skills rewritten with tool-agnostic language. Works with both CLI and MCP plugin contexts.
- File schema: `storage_url` column dropped, `storage_path` is the only identifier. URLs generated on demand via `file_url` operation.
- Config loading: env vars (`GBRAIN_DATABASE_URL`, `DATABASE_URL`, `OPENAI_API_KEY`) override config file values. Plugin config injected via env vars.

### Removed

- 12 command files migrated to operations.ts: get.ts, put.ts, delete.ts, list.ts, search.ts, query.ts, health.ts, stats.ts, tags.ts, link.ts, timeline.ts, version.ts.
- `storage_url` column from files table.

## [0.2.0.2] - 2026-04-07

### Changed

- Rewrote recommended brain schema doc with expanded architecture: database layer (entity registry, event ledger, fact store, relationship graph) presented as the core architecture, entity identity and deduplication, enrichment source ordering, epistemic discipline rules, worked examples showing full ingestion chains, concurrency guidance, and browser budget. Smoothed language for open-source readability.

## [0.2.0.1] - 2026-04-07

### Added

- Recommended brain schema doc (`docs/GBRAIN_RECOMMENDED_SCHEMA.md`): full MECE directory structure, compiled truth + timeline pages, enrichment pipeline, resolver decision tree, skill architecture, and cron job recommendations. The OpenClaw paste now links to this as step 5.

### Changed

- First-time experience rewritten. "Try it" section shows your own data, not fictional PG essays. OpenClaw paste references the GitHub repo, includes bun install fallback, and has the agent pick a dynamic query based on what it imported.
- Removed all references to `data/kindling/` (a demo corpus directory that never existed).

## [0.2.0] - 2026-04-05

### Added

- You can now keep your brain current with `gbrain sync`, which uses git's own diff machinery to process only what changed. No more 30-second full directory walks when 3 files changed.
- Watch mode (`gbrain sync --watch`) polls for changes and syncs automatically. Set it and forget it.
- Binary file management with `gbrain files` commands (list, upload, sync, verify). Store images, PDFs, and audio in Supabase Storage instead of clogging your git repo.
- Install skill (`skills/install/SKILL.md`) that walks you through setup from scratch, including Supabase CLI magic path for zero-copy-paste onboarding.
- Import and sync now share a checkpoint. Run `gbrain import`, then `gbrain sync`, and it picks up right where import left off. Zero gap.
- Tag reconciliation on reimport. If you remove a tag from your markdown, it actually gets removed from the database now.
- `gbrain config show` redacts database passwords so you can safely share your config.
- `updateSlug` engine method preserves page identity (page_id, chunks, embeddings) across renames. Zero re-embedding cost.
- `sync_brain` MCP tool returns structured results so agents know exactly what changed.
- 20 new sync tests (39 total across 3 test files)

## [0.1.0] - 2026-04-05

### Added

- Pluggable engine interface (`BrainEngine`) with full Postgres + pgvector implementation
- 25+ CLI commands: init, get, put, delete, list, search, query, import, export, embed, stats, health, link/unlink/backlinks/graph, tag/untag/tags, timeline/timeline-add, history/revert, config, upgrade, serve, call
- MCP stdio server with 20 tools mirroring all CLI operations
- 3-tier chunking: recursive (delimiter-aware), semantic (Savitzky-Golay boundary detection), LLM-guided (Claude Haiku topic shifts)
- Hybrid search with Reciprocal Rank Fusion merging vector + keyword results
- Multi-query expansion via Claude Haiku (2 alternative phrasings per query)
- 4-layer dedup pipeline: by source, cosine similarity, type diversity, per-page cap
- OpenAI embedding service (text-embedding-3-large, 1536 dims) with batch support and exponential backoff
- Postgres schema with pgvector HNSW, tsvector (trigger-based, spans timeline_entries), pg_trgm fuzzy slug matching
- Smart slug resolution for reads (fuzzy match via pg_trgm)
- Page version control with snapshot, history, and revert
- Typed links with recursive CTE graph traversal (max depth configurable)
- Brain health dashboard (embed coverage, stale pages, orphans, dead links)
- Stale alert annotations in search results
- Supabase init wizard with CLI auto-provision fallback
- Slug validation to prevent path traversal on export
- 6 fat markdown skills: ingest, query, maintain, enrich, briefing, migrate
- ClawHub manifest for skill distribution
- Full design docs: GBRAIN_V0 spec, pluggable engine architecture, SQLite engine plan
