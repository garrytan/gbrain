# Testing (gbrain repo)

On-demand reference (see CLAUDE.md Reference map). Current behavior + invariants
only.

`test/e2e/serve-http-oauth.test.ts` additionally pins confidential POST/Basic revocation, public-client SDK fallthrough, malformed/mixed authentication rejection, cross-client isolation, unknown-token opacity, metadata auth methods, no-store responses, strict post-revoke `401`, and retryable backend `503` semantics.

### Test command tiers

Seven test command tiers, each with a clear scope:

| Command | What it runs | Wallclock | When to use |
|---|---|---|---|
| `bun run test` | Parallel unit-test fast loop. Sharded fan-out via `scripts/run-unit-parallel.sh` (default 4 shards — CPU-detected, clamped to a max of 8; 4 matches CI's fan-out and avoids PGLite WASM-init contention), then a serial pass over `*.serial.test.ts`. Excludes `*.slow.test.ts` and `test/e2e/*`. No pre-checks, no typecheck. Builds/refreshes the PGLite schema snapshot BEFORE the shard fan-out and exports `GBRAIN_PGLITE_SNAPSHOT` so PGLite-booting files restore a baked schema instead of replaying every migration (~3.5x per booting file; see "PGLite schema snapshot" below). Opt out: `GBRAIN_NO_SNAPSHOT=1`. Memory-safe by default: total concurrency (shards × intra-shard width) is capped to available memory at `GBRAIN_TEST_MEM_PER_FILE_MB` (default 1536 — a PGLite WASM instance) per concurrent slot, shedding INTRA-SHARD width first and shards only after it (bun's `--max-concurrency` bounds only `test.concurrent` tests — 1 file in the corpus — so intra width is nearly free to shed, while every dropped shard removes a whole bun process of real fan-out; the old shards-first order collapsed a 16GB box to a serial 1×4 run, measured 3.25× slower than 4×1 on the same machine). Two phantom-failure classes are automatically re-run serially (the rescue pass): failures carrying the WASM out-of-memory signature, and shards killed externally (SIGTERM/SIGKILL well before the shard timeout — sibling workspaces' process cleanup, memory jetsam). On machines without coreutils `timeout`, the fallback watchdog drops a `.watchdog` sentinel before TERMing a shard at the cap so the WEDGED/EXIT-HANG classifier stays reachable there (a bare rc=143 used to read as a plain failure). Phantoms pass serially and the run goes green with an `oom_rescued` note; real failures fail again serially and stay red. Knobs: `GBRAIN_TEST_NO_MEM_ADAPT=1`, `GBRAIN_TEST_NO_OOM_FALLBACK=1`, `GBRAIN_TEST_MAX_CONCURRENCY` (intra-shard, default 4), `GBRAIN_TEST_SHARD_TIMEOUT` / `GBRAIN_TEST_SHARD_KILL_AFTER`, plus `--shards N` / `--max-concurrency N` / `--dry-run` script args. | a few minutes on a Mac dev box | Inner edit loop. Default. |
| `bun run verify` | CI's authoritative pre-test gate set, fanned out by `scripts/run-verify-parallel.sh` through a bounded worker pool (default `detect_cpus`; override `GBRAIN_VERIFY_MAX_PARALLEL`) with the heavy checks ordered first (typecheck, the two compile-embed checks, admin build, fuzz bundles, guard self-tests, the PGLite-booting chronicle eval check, whole-tree greps). The battery includes the deterministic `check:eval-chronicle` eval gate; `check:eval-canary` is deliberately NOT in the battery (its test-file twin `test/eval-canary.test.ts` spawns the identical runner in the unit matrix, and CI's verify job and matrix always run together — the package script stays for on-demand runs, so `verify`-only local callers should know the canary rides the unit lane instead). The `CHECKS` array in that script is the single source of truth — CI literally calls `bun run verify` in a dedicated job. | ~50s (pool-bounded; longest check dominates) | Before pushing; before `/ship`. |
| `bun run test:full` | `verify && bun run test && bun run test:slow && [smart e2e]`. The local equivalent of "everything CI runs." Smart e2e: runs e2e only when `DATABASE_URL` is set; else loud skip notice to stderr. | ~3-5min depending on slow + e2e | Pre-merge sanity, before opening a PR. |
| `bun run test:slow` | Just the `*.slow.test.ts` set (intentional cold-path correctness checks). | seconds-to-minutes | When touching slow-path code. |
| `bun run test:serial` | Just the `*.serial.test.ts` set (cross-file-contention quarantine; one bun process per file for true module-registry isolation), run through a POOL of concurrent per-file processes — the isolation is per-process, not per-machine. Dispatch is heaviest-first (LPT) from the advisory `scripts/serial-weights.json` (seconds; mined from the `.context/serial-durations.txt` table each run banks; absent/corrupt weights fall back to discovery order, absent keys to the corpus p75 — scheduling only, never correctness; LPT order + the corrupt-weights fail-soft are pinned by `test/scripts/run-serial-pool.test.ts`). Pool defaults to `min(detect_cpus, 4)` then memory-adapts (same doctrine as the parallel runner); a small growth-guarded set of files (machine-global state or contention-critical timing — see the justified `EXCLUSIVE_FILES` list in `scripts/run-serial-tests.sh`, capped at 3 by `test/scripts/serial-files.test.ts`) runs on a sequential EXCLUSIVE lane after the pool. Per-test timeout 120s (pooled contention headroom); each pooled file is wall-clock-killed at 300s (`timeout -k`, exit-hang containment). Externally-killed files (exit 143/137 or a missing exit sentinel — sibling-workspace cleanup, memory jetsam) get ONE sequential rescue re-run, mirroring the parallel runner's doctrine: phantoms stay green with a rescue note, real failures stay red. Prints per-file PASS lines plus a top-10 slowest-files list. Knobs: `GBRAIN_SERIAL_POOL=N` (explicit pool width — bypasses the memory clamp; `1` restores fully-sequential), `GBRAIN_SERIAL_FILE_TIMEOUT`. | a few minutes for all ~220 files at pool=4 | Debugging quarantined files; CI's serial-tests job. |
| `bun run test:e2e` | Real Postgres E2E. Requires Docker + `DATABASE_URL`. Sequential within a shard; `SHARD=N/M` fans out against separate databases (ci-local runs 4 containers). Activates the PGLite snapshot like every other runner (per-file cold-path opt-outs where the test asserts the path TO post-initSchema state), exporting it as an ABSOLUTE path so CLI children spawned with varying cwd still find it. | ~5-10min | Pre-ship; nightly. |
| `bun run test:compile-smoke` | Self-update integrity verify under a REAL `bun build --compile` binary, offline (sets `GBRAIN_SELFUPDATE_COMPILE_SMOKE=1`). The unit suite mocks the network seams; this proves the dependency-free crypto/base64/JSON verify path survives compilation — the failure mode `sigstore-js` would have hit. | ~5s (one compile) | When touching `src/core/binary-self-update.ts`; pre-ship on self-update changes. |

There is no `check:all` script anymore — it was a second, hand-synced guard
registry that drifted from `verify` (three checks were reachable ONLY from it,
i.e. never ran anywhere). The `CHECKS` array in `scripts/run-verify-parallel.sh`
is the single execution list, and it now includes the former `check:all`-only
extras (`check:newlines`, `check:exports-count`, `check:no-legacy-getconnection`).
The guard REGISTRY is `scripts/guards-manifest.tsv` (see "Guard registry and
self-test" below).

### PGLite schema snapshot (default-on)

`scripts/build-pglite-snapshot.ts` (`bun run build:pglite-snapshot`) bakes a
post-`initSchema()` PGLite data dir into `test/fixtures/pglite-snapshot.tar`
plus a version file; `PGLiteEngine.initSchema()` restores the tar instead of
replaying the embedded schema + all migrations when the env var
`GBRAIN_PGLITE_SNAPSHOT` points at it. Runners activate it through the shared
`ensure_pglite_snapshot` helper in `scripts/lib/test-env.sh` (also home of
`detect_cpus` and `detect_available_mem_mb`), sourced by
`run-unit-parallel.sh`, `test-shard.sh`, `run-slow-tests.sh`,
`run-serial-tests.sh`, `run-verify-parallel.sh`, and `run-e2e.sh` (which
re-exports the path as ABSOLUTE — its tests spawn CLI children with varying
cwd); `scripts/ci-local.sh` calls the builder directly. The helper builds/refreshes the snapshot and
exports the env var, no-ops on `GBRAIN_NO_SNAPSHOT=1` or an already-inherited
path, and is non-fatal on build failure — tests fall back to cold init, with
a one-line "active" echo so a silent fallback stays visible in CI logs.
Measured effect: ~3.5x per PGLite-booting file (a cold boot replays every
migration, ~3.1s each on a CI shard). Properties:

- **Idempotent.** A hash short-circuit exits in ~40ms when the snapshot is
  fresh, and REBUILDS a stale one. The hash covers `PGLITE_SCHEMA_SQL`, every
  migration's `sql` + `sqlFor.pglite`, AND each migration `handler`'s function
  source (`Function.prototype.toString`) — 19+ migrations carry executable
  handler code with empty `sql` that a sql-only hash cannot see.
- **Concurrency-safe.** Parallel shard runners / sibling workspaces serialize
  on an atomic `mkdir` lock (`test/fixtures/.pglite-snapshot.lock`) with
  staleness-verified takeover of a crashed builder; the tar is written first
  and the version file last, so a crash can never leave a fresh-looking torn
  fixture. `GBRAIN_SNAPSHOT_LOCK_TIMEOUT_MS` (default 120000) bounds the
  waiter; an exhausted waiter facing a still-live lock proceeds unlocked as a
  last resort (the loader gate below validates the version file, not the tar
  bytes).
- **Never authoritative.** The loader (`tryLoadSnapshot` in
  `src/core/pglite-engine.ts`) verifies the schema hash AND the embedding
  shape the snapshot was baked with (`dims=` / `model=` lines in the version
  file) against what this process would create; any mismatch — including a
  version file without shape lines — warns once and falls through to normal
  cold init. A wrong fixture can never poison the suite.
- **Opt out.** `GBRAIN_NO_SNAPSHOT=1` skips the build + env export for a run;
  the migration-replay canary tests clear the env themselves regardless.

Pinned by `test/snapshot-shape-guard.test.ts` (hash + shape refusal matrix,
handler-source hash sensitivity).

### Guard registry and self-test

`scripts/guards-manifest.tsv` is THE single registry of `scripts/check-*`
guards (currently 48), each classified `scanner` (greps/parses repo sources —
must eventually carry fixtures), `buildfresh`, or `repostate` (build/freshness
guards are exempt-with-reason, not fixture-tested).
`scripts/guard-self-test.sh` (`bun run check:guard-self-test`, wired into
`bun run verify`) proves every `selftest=yes` scanner CAN fail: it runs each
one against known-bad (must exit non-zero) and known-good (must pass) fixture
trees under `test/fixtures/guards/<guard>/{bad,good}/` via the
`GBRAIN_GUARD_ROOT` env seam, and enforces manifest completeness — a new
`scripts/check-*` script that isn't registered in the manifest fails the
build. A guard whose pattern rots into a permanently-green no-op now fails CI
instead of masquerading as coverage.

### Registry-walking ratchets

Structural suites that walk a registry so the NEXT gap of a known class
cannot ship silently. All allowlists below are shrink-only.

- `test/operations-coverage-ledger.test.ts` — every op in
  `src/core/operations.ts` maps to a covering test file in a checked-in
  ledger; the `UNCOVERED` allowlist only shrinks. Shares one
  registry-enumeration helper (`test/helpers/ops-registry.ts`) with the
  jobs-ops token-redaction sweep so two walkers can't drift.
- `test/operations-source-isolation-matrix.test.ts` — every non-localOnly
  read op runs under a scoped remote ctx and a federated grant; nothing
  carrying the other source's identity may return. Deliberate brain-wide
  behavior requires an explicit `BRAIN_WIDE_READS` entry with a rationale
  string. Anti-vacuity is mandatory: each op's control call must SEE the
  cross-source marker before its scoped assertions count; an op that can't
  be driven is an explicit counted SKIP disposition, never a silent pass.
- `test/scripts/e2e-wiring.test.ts` — every `test/e2e/*.test.ts` must be
  claimed by a PR-time lane (a `scripts/e2e-test-map.ts` row, a workflow
  mention, or the shrink-only `test/fixtures/e2e-unmapped-baseline.txt`),
  and every map entry must point at a real file (typo guard).
- `test/engine-surface-coverage.test.ts` — two-way census of the
  `BrainEngine` interface against the PGLite prototype (new methods force a
  visible list edit) plus a runtime `UNCALLED` ratchet scanning the whole
  test corpus for references, so a never-called engine method can't ship.
- `scripts/check-orphan-modules.mjs` (verify battery, guard-manifest
  registered with bad/good fixtures) — transitive import walk from the
  cli/mcp/engine entrypoints; a src module reachable from no entrypoint
  fails unless in the 4-entry reasoned allowlist, and the
  test-only-reachable tier has a shrink-only ceiling.

The takes-bootstrap graduation instrument (`evals/takes-bootstrap/`: 123-case
corpus, scorer, live harness + $0 replay) is CI-guarded keyless by
`test/eval-takes-bootstrap.test.ts` — the guard proves the instrument, not
the score; the autopilot tier flips only on a committed GRADUATED live run.

### Shell dispatch and Windows

All four of `test`, `verify`, `ci:local` and `test:e2e` hand off to shell scripts
under `scripts/`, so every `check:*` entry in `package.json` invokes its script as
`bash scripts/<name>.sh` instead of relying on the shebang — bun on Windows cannot
exec a `.sh` directly. Add a new shell-script check with that same prefix. The
`scripts/*.ts` entries run under bun and take no prefix.

The scripts must also be on disk with Unix line endings. A strict bash (WSL, Linux
CI, macOS) rejects CRLF and dies on the script's first meaningful line; the Cygwin
bash that ships with Git for Windows tolerates it, so a green local run is not by
itself evidence that a script is CRLF-clean.
The root `.gitattributes` pins `*.sh text eol=lf`, which overrides the
`core.autocrlf=true` default that Git for Windows installs. It pins `*.md` the
same way, because the frontmatter readers anchor on a `---` fence followed by a
Unix line ending and a CRLF checkout makes a document parse as having no
frontmatter, silently. Working copies cloned
before those pins need a one-time `git rm --cached -r . -q && git reset --hard` to
pick them up; see the Windows section of `CONTRIBUTING.md`.

Wallclock figures in the table above are from a Mac dev box. Windows is
substantially slower because each check pays full process-creation cost, and three
tree-walking checks (`check:privacy`, `check:test-names`, `check:test-isolation`)
plus `typecheck` can exceed the 120s per-check cap in `run-verify-parallel.sh`
there even though they pass on Linux and macOS.

### CI vs local: intentionally divergent file sets

- **CI matrix** (`.github/workflows/test.yml`) runs `scripts/test-shard.sh` across 10 matrix shards partitioned by weight-aware LPT bin-packing (`scripts/sharding.ts`; files with no mined weight fall back to the p75 file weight so a new unweighted file can't silently unbalance a shard) and INCLUDES `*.slow.test.ts` (the three outlier slow files — longmemeval, entity-resolve-perf, brainbench-e2e — run as dedicated jobs alongside the matrix) plus `evals/**/*.test.ts` (keyless-allowlist-gated — `test/scripts/evals-collection.test.ts`). Each shard's bun process is bounded by `--max-concurrency` (`GBRAIN_TEST_MAX_CONCURRENCY`, default 4). Every bun-test job — matrix shards, serial-tests, verify, the slow/eval jobs — activates the PGLite schema snapshot (built in-runner via `scripts/lib/test-env.sh`; the brainbench gate brings its own in-memory PGLite and skips it; the ~42MB tar is also cached across jobs via actions/cache, with the runner's own hash check staying authoritative). CI EXCLUDES `*.serial.test.ts` from the shards and runs them in the pooled `serial-tests` job via `bun run test:serial` — one bun process per file preserves the `mock.module` quarantine; the pool runs those processes concurrently. `bun run verify` gets its own job too, as does the BrainBench memory-conformance gate (`brainbench` job → `scripts/ci-brainbench-gate.sh`, hermetic in-memory PGLite, ~15s), which compares HEAD's fresh run against master's committed baseline (`evals/brainbench/baselines/main.json`) — the `test-status` aggregate checks its result explicitly. E2E (`.github/workflows/e2e.yml`) mirrors the content-hash skip in its own `e2e-pass-<hash>` namespace (scheduled nightly runs are exempt and always run), runs tier1 and tier2 in parallel with the jsonb-parity job in front of tier2 as the token-spend gate, and aggregates through `e2e-status`. CI is the ground truth for "did everything pass."
- **Local fast loop** (`scripts/run-unit-shard.sh` via the parallel wrapper) uses round-robin-by-index sharding and EXCLUDES `*.slow.test.ts` AND `*.serial.test.ts`. Local trades coverage for inner-loop speed; CI catches what local skips.

This divergence is intentional. Don't try to make them equal — the two scripts deliberately solve different problems. The regression test at `test/scripts/run-unit-shard.test.ts` pins what the local fast loop should and shouldn't include; `test/scripts/run-unit-parallel.test.ts` pins the wrapper's memory-adaptive concurrency and the OOM/external-kill serial rescue pass.

### Coverage lanes and gates

Line coverage is opt-in via `COVERAGE_DIR`: when set, the shell lanes
(`scripts/test-shard.sh`, `scripts/run-serial-tests.sh`, `scripts/run-e2e.sh`)
pass `--coverage --coverage-reporter=lcov` to bun; when unset, the exec line is
byte-identical to a non-coverage run. Every bun process gets its OWN coverage
dir (`$COVERAGE_DIR/shard`, `serial-$idx`, `e2e-$idx`) because a reused dir
silently overwrites `lcov.info` — the shard runner also pins xargs to a single
batch (`-n 100000 -x`) so an argv overflow fails loud instead of spawning a
second, overwriting bun process. On a green run each lane writes
`$COVERAGE_DIR/lane-manifest.json` (`{lane, sha, lcovCount, complete}`); a red
run writes no manifest, which downstream merging treats as an incomplete lane.
`run-e2e.sh` specifics: `COVERAGE_DIR` is normalized to an absolute path
against the repo root before `HOME` moves (the script redirects
`HOME`/`GBRAIN_HOME` and E2E tests spawn CLI subprocesses with varying cwd —
an un-normalized relative dir would scatter output), and `E2E_FILE_TIMEOUT_SECS`
caps each file's wallclock (default 180s; the nightly coverage lane uses 300s
for instrumentation overhead). Both env names are deliberately
non-`GBRAIN_`-prefixed so the hermetic env scrub keeps them.

**Two corpora.**

- **PR corpus** (`prCorpus`) — the 14 coverage-collecting lanes in
  `.github/workflows/test.yml`: the 10 matrix shards, `serial-tests`, and the
  three dedicated slow jobs (`slow-eval-longmemeval`,
  `slow-entity-resolve-perf`, `slow-brainbench-e2e`). Deterministic (runs identically on every PR); this
  is the corpus the gates run against.
- **fullCorpus** — nightly, schedule-only in `.github/workflows/e2e.yml`:
  `coverage-full-{unit,serial,slow,e2e}` + `coverage-full-report`. Fully
  self-contained (every lane re-runs with coverage inside that workflow,
  including the full `test/e2e/*` glob against real Postgres) — the honest
  merged unit+serial+slow+e2e number, kept as the `coverage-full-merged` trend
  artifact.

**Merge** (`scripts/merge-lcov.ts`). Walks the input dirs for `lcov.info` +
`lane-manifest.json`, sums DA hits per file:line, normalizes paths
repo-relative, and emits a merged lcov plus a summary JSON: src-only
totals/per-dir/per-file percentages, a `lineHits` map (the diff gate's input),
and the never-loaded src file list. `--manifest-expect lane,lane,...` pins the
expected lane set; a missing or `complete: false` manifest, an unparseable
lcov, or a `shard` lane with `lcovCount != 1` marks the summary
`degraded: true`. Degraded is data, not failure: the merge never aborts (exit
0), and both gates print `WOULD PASS`/`WOULD FAIL` and exit 0 on a degraded
summary instead of enforcing against partial data.

**Diff gate** (`scripts/coverage-diff-gate.ts`). Gates the added/changed lines
of `git diff origin/master...HEAD` restricted to gate scope (`src/**.ts` minus
`*.test.ts`/`*.generated.ts`/`*.d.ts`): covered/(covered+uncovered) must be
≥ 80%, AND no gate-scoped changed file may be entirely absent from the
coverage data (a never-loaded file is one violation — add a test that imports
it). Non-executable lines (no lcov record) don't count against you; empty and
doc-only diffs short-circuit to PASS via the `select-e2e` classifier. Escape
hatches: a commit body containing `[coverage-exempt: reason]` passes with a
loud warning, and `scripts/coverage-gate-exemptions.txt` (exact path or
trailing-`/` prefix per line; resolved via
`git show origin/master:scripts/coverage-gate-exemptions.txt`, never the
working tree, so a PR cannot self-exempt; SHRINK-ONLY — additions need a
graduation review in the PR description) excludes paths from the gate while
still reporting them
(`[e2e-exempt]`, `[subprocess-undercount]`). Report-only unless
`COVERAGE_GATE_ENFORCE=1`. Exit contract: 0 = pass or report-only, 1 = gate
fail while enforcing, 2 = infrastructure error (missing summary, git failure —
never conflated with a coverage verdict).

**Baseline gate** (`scripts/coverage-baseline-gate.ts`). Anti-erosion floor:
reads the baseline via `git show origin/master:scripts/coverage-baseline.json`
— the master copy, never the working tree, so a PR cannot weaken its own bar —
and compares like-for-like by corpus (`--corpus prCorpus` in test.yml,
`--corpus fullCorpus` nightly). A global drop > 0.5pp, a per-directory drop
> 1.0pp, or a never-loaded-count increase fails (deleting tests shrinks the
coverage denominator, which inflates pct for free); a corpus section that is
`null` on master is an ungated first landing. `provisional: true` in the baseline keeps the gate report-only
regardless of enforcement — the committed baseline is currently provisional
with both corpus sections unseeded. `scripts/update-coverage-baseline.ts
--summary <json> --corpus <c> [--promote]` writes the working-tree baseline
(per-file detail limited to the baseline's `watchlist`); `--promote` flips
`provisional: false` at graduation.

**CI wiring.** The 14 PR lanes upload `coverage-*` artifacts; the advisory
`coverage-report` job downloads + merges (`COVERAGE_CORPUS=prCorpus`), renders
`scripts/render-coverage-summary.ts` to the step summary (including the
behavioral-vs-structural counts from `scripts/structural-suites.tsv`), and
runs both gates with `COVERAGE_GATE_ENFORCE: '0'`. It is deliberately NOT in
`test-status` or `cache-write` needs — it cannot block a PR until graduation.

**Bun caveats.** Bun/JSC emits line records only, so function coverage is
informational (no reliable function names). There is NO subprocess coverage:
code exercised only through spawned CLI subprocesses undercounts — `src/cli.ts`
carries a permanent `[subprocess-undercount]` exemption for this. A src file
never imported by any test produces no lcov record at all; the summary reports
these as a count + sorted list, deliberately never a percentage (physical
lines ≠ executable lines), and the diff gate treats a changed-but-never-loaded
file as a violation.

**One-command local smoke** (one shard of ten, so totals reflect a tenth of
the corpus — this checks the plumbing, not the number):

```bash
COVERAGE_DIR=$PWD/.coverage bash scripts/test-shard.sh 1 10 \
  && bun scripts/merge-lcov.ts --out-lcov .coverage/merged.lcov --out-json .coverage/summary.json .coverage \
  && bun scripts/render-coverage-summary.ts --summary .coverage/summary.json
```

Optional flags: `coverage-diff-gate.ts --base <ref>` overrides the diff base
(default `origin/master`); `render-coverage-summary.ts --structural
scripts/structural-suites.tsv` adds the behavioral-vs-structural split to the
rendered summary (both CI lanes pass it); `classify-tests.ts --summary` prints
counts only.

### Failure-first logging

When `bun run test` finds any failure, the wrapper:

1. Writes failure blocks (each prefixed with `--- shard N: <test name> ---`) to `.context/test-failures.log` (workspace-local, gitignored). On systems without a writable `.context/`, falls back to `/tmp/gbrain-test-failures.log`.
2. Prints a loud stderr banner with the absolute log path, plus the last 30 lines of the failure log inlined. Banner survives `| head` / `| tail` / agent-side log truncation.
3. Writes a one-line-per-shard summary to `.context/test-summary.txt` (`shard N/M: pass=X fail=Y skip=Z rc=W`).
4. Exits non-zero. Empty failure log + non-zero exit = infrastructure problem (wedged shard, killed child); the banner says so.

If a shard hits the per-shard `GBRAIN_TEST_SHARD_TIMEOUT` cap (default 3000s — sized so the heaviest count-balanced shard finishes under 4-way contention; `GBRAIN_TEST_SHARD_KILL_AFTER` sets the grace after TERM before KILL, default 30s), the wrapper classifies the kill one of two ways:

- **EXIT-HANG → warn-pass.** If the shard's log had been silent for ≥300s at kill time AND shows zero `(fail)` markers, the shard finished all its work, leaked a handle, and never exited (a pre-existing, master-reproducible PGLite-adjacent leak — see TODOS.md "unit-shard exit hang"). The wrapper prints a `⚠️ shard N/M: EXIT-HANG ... Treating as pass-with-warning` banner, writes `EXIT-HANG (idle Ns, 0 fails) ... warn-pass` to the summary, and does NOT fail the run. Its pass counts are undercounted (bun never printed its final summary). Bun's per-test `--timeout` turns a genuinely hung TEST into a printed `(fail)` — new output — so this classification cannot mask a hung test; the residual maskable case is a file-level import hang in the very last file, which the banner keeps visible.
- **WEDGED → hard failure.** Anything else (failures present, or the log was still growing) writes `--- shard N: WEDGED after ${SHARD_TIMEOUT}s ---` to the failure log with the last 50 lines of the shard log, marks the run failed, and proceeds with other shards' results.

Triage rule: a `warn-pass` EXIT-HANG line in `.context/test-summary.txt` is NOT a test failure — don't burn time bisecting it; a `WEDGED` line is.

### File taxonomy

- `*.test.ts` → fast loop (parallel up-to-4-shard fan-out, memory-adaptive).
- `*.slow.test.ts` → run via `bun run test:slow` only (intentional cold-path tests; would dominate the fast loop's wallclock).
- `*.serial.test.ts` → run via `bun run test:serial` after the parallel pass completes; one bun process per file (`--max-concurrency=1` within a shared process is not enough — the module registry still leaks `mock.module`), with those per-file processes POOLED (per-process isolation never required one-at-a-time execution). Files touching machine-global state (launchd/cron) live on the sequential `EXCLUSIVE_FILES` lane inside `scripts/run-serial-tests.sh` — growth-guarded to ≤3 entries with justification comments. Quarantine for tests that share file-wide state and race when run alongside other files in the same `bun test` process. Several dozen files, discovered by the `*.serial.test.ts` glob — no list to maintain. Typical residents: `mock.module(...)` users (top-level mocks leak across files in a shard process, e.g. `test/embed.serial.test.ts`), env-coupled files (e.g. `test/brain-registry.serial.test.ts`), and process-lifecycle suites that assert on `process.exitCode` (e.g. `test/pglite-engine-disconnect.serial.test.ts`). **Do not put the parallelism back on a serial file unless you've fixed the contention root cause** (it just re-introduces the flake).
- `test/e2e/*.test.ts` → real-Postgres E2E. Skipped when `DATABASE_URL` is unset. One out-of-directory file rides this lane: `test/phantom-redirect-engine-parity.test.ts` (lives in `test/` for its PGLite arm, but its Postgres arm is only reachable through a DATABASE_URL-bearing lane — the unit wrappers strip the URL per #3485, so `run-e2e.sh`'s no-args list and CI's parity job carry it). `run-e2e.sh` wraps each file in a hard outer timeout (default 180s; `GBRAIN_E2E_FILE_TIMEOUT=<seconds>` overrides) because a synchronously-blocking PGLite WASM call can outlive bun's timer-based `--timeout`; LLM-bound Tier-2 files (`skills.test.ts`, `zeroentropy-live.test.ts`) automatically get 4× the cap since real provider round-trips legitimately run past 180s.
- `tests/heavy/*.sh` → ops-shape shell scripts. Cost minutes per run; NOT in default `bun test`. Run via `bun run test:heavy` or scheduled nightly via `.github/workflows/heavy-tests.yml`. Examples: pg_upgrade matrix (boot legacy brain → walk to head), RSS budget gate (measure peak worker RSS vs committed baseline), read-latency-under-sync (p50/p95/p99 under concurrent writer load), sync lock regression (N concurrent syncs assert 1 winner + N-1 lock-busy + zero leaked `gbrain_cycle_locks` rows). See `tests/heavy/README.md` for when to add a script here vs `*.slow.test.ts`. Files prefixed with `_` (e.g. `tests/heavy/_build_legacy_fixtures.sh`) are helpers/libs invoked by sibling tests — the runner skips them.
- `test/fuzz/*.test.ts` → property-based fuzz harness. Pure-validator targets in `pure-validators.test.ts` are guarded by `scripts/check-fuzz-purity.sh` (in `bun run verify`), which `bun build --target=bun` bundles each target and greps the resulting bundle for banned transitive imports (`node:fs`, `node:child_process`, engine modules). Anything that fails the guard moves to `mixed-validators.test.ts` (still property-tested, but no purity guarantee) or `filesystem-validators.test.ts` (fs-backed, uses temp dirs). Fuzz tests run in the default `bun test` loop because they're fast (~3s for ~12 properties × 1000 runs each).

The taxonomy above is LANE-based (where a test runs). A second, orthogonal axis is INTENT:

- **Behavioral** tests execute product code and assert on behavior — the default.
- **Structural** (source-shape) suites read repo source/doc TEXT and assert on its shape (wiring guards, drift pins, `doctorSource()` consumers). They are real invariants but execute no product paths, so they inflate the headline test count without adding line coverage. The committed inventory is `scripts/structural-suites.tsv`, generated by `scripts/classify-tests.ts` (suite-level, content-based detectors: repo-anchored `readFileSync`/`Bun.file` readers, grep-style exec scanners, the doctor-source helpers) and freshness-checked in `bun run verify` (`check:structural-manifest` — regenerate with `bun scripts/classify-tests.ts` when suites change shape). The inventory is approximate by design; fix misclassifications in the classifier's detector list, never by hand-editing the TSV. CI's coverage report renders behavioral vs structural counts side by side.

Guards that pin doctor source text read it through `test/helpers/doctor-source.ts` (`doctorSource()` = the façade + every `src/commands/doctor/**` module, for containment assertions; `doctorFileSource(rel)` = one named file, for positional/ordering assertions) so peeling doctor.ts into modules can't silently move a pinned string out of a guard's sight.

### TTY and interactive-CLI testing

Four escalating tools; reach for the cheapest one that answers the question:

| Question | Tool | Example |
|---|---|---|
| Does the TTY/non-TTY branch logic pick right? | Inject `isTTY` into the pure function — no subprocess | `test/init-provider-picker.test.ts`, `test/jobs-watch-mode.test.ts` |
| Does the real CLI behave right when stdin is NOT a terminal? | Spawn the CLI with piped/ignored stdio | `test/cli-stdin-hang.test.ts` (fast loop); `test/e2e/init-fresh-pglite.test.ts` (manual `test:e2e` lane — see the TODOS e2e CI-lane entry) |
| Does the real CLI render menus and read typed input under a REAL terminal? | `launchTty` from `test/helpers/tty-harness.ts` in a `*.serial.test.ts` file | `test/init-picker-pty.serial.test.ts` |
| How does the install FEEL (stalls, copy, silence windows)? | `scripts/dx-explore.ts` — instrument, not a test; nothing asserts | transcripts under `.context/dx-runs/` (see `docs/guides/bootstrap.md`) |

Real-PTY test rules: put the file in the serial lane (`*.serial.test.ts` — that
lane runs in required CI; a new `test/e2e/*` file does NOT, since unit shards
exclude the directory and the e2e workflow runs only explicitly named files,
no glob);
assert NON-default picker values (bare Enter and each prompt's 60s
`readLineSafe` timeout both resolve to the default, so a defaults-asserting
test passes with dead input); always `await session.close()` in a `finally`
(only `close()` clears the harness wall timer); and point `HOME` plus
`GBRAIN_HOME` at a temp root with pass-through auth keys stripped via
`dropEnv` so picker state is machine-independent.

### Skills-manifest freshness guard

`skills/skills.lock.json` is a committed sha256 inventory of every bundled file under
`skills/` (tamper evidence, not signatures — see `src/core/skills-integrity.ts`).
Any change under `skills/` must regenerate it: `bun run scripts/generate-skills-manifest.ts`.
`scripts/check-skills-manifest-fresh.sh` (`bun run check:skills-manifest`, wired into
`bun run verify`) regenerates to a tmp file and diffs, failing CI on drift; at runtime
`gbrain doctor` reports the same drift as a warn-only `skills_manifest_integrity` check.

### Test-isolation lint and helpers

**This section is the canonical home of the test-isolation discipline** — CONTRIBUTING.md and other docs link here rather than restating the rules.

The cross-file flake class is enforced statically by `scripts/check-test-isolation.sh`, wired into `bun run verify`. Rules (non-serial unit files only; `*.serial.test.ts` and `test/e2e/*` are skipped):

| Rule | What it bans | Fix |
|---|---|---|
| **R1** | `process.env.X = ...`, bracket assignment, `delete process.env.X`, `Object.assign(process.env, ...)`, `Reflect.set(process.env, ...)` | Use `withEnv()` from `test/helpers/with-env.ts`, OR rename file to `*.serial.test.ts` |
| **R2** | `mock.module(...)` anywhere in the file | Rename file to `*.serial.test.ts` (no DI on production code for testability) |
| **R3** | `new PGLiteEngine(` outside ~50 lines after a `beforeAll(` line | Use the canonical block (below) inside `beforeAll(` |
| **R4** | Files creating `new PGLiteEngine(` without `engine.disconnect(` inside an `afterAll(` block | Add `afterAll(() => engine.disconnect())` |

Files that violated these rules at the isolation-lint baseline are listed in `scripts/check-test-isolation.allowlist`. **The allow-list MUST shrink over time** — never add new entries.

#### Canonical PGLite block (R3 + R4 compliant)

Every test file that needs a PGLite engine should use this exact pattern:

```ts
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});
```

Why this exact shape: `beforeAll` creates a single engine per file (PGLite WASM cold-start + initSchema is ~20s); `beforeEach` truncates user data via `resetPgliteState` ("two orders of magnitude faster" than fresh-engine-per-test); `afterAll` disconnects so the engine doesn't leak across file boundaries within a shard process.

#### `withEnv` pattern (R1 fix)

```ts
import { withEnv } from './helpers/with-env.ts';

test('reads OPENAI_API_KEY', async () => {
  await withEnv({ OPENAI_API_KEY: 'sk-test' }, async () => {
    expect(loadConfig().openai_key).toBe('sk-test');
  });
});

// Delete a var (override is undefined):
await withEnv({ GBRAIN_HOME: undefined }, fn);

// Multiple keys:
await withEnv({ A: '1', B: '2', C: undefined }, fn);
```

`withEnv` saves the prior value of every key it touches and restores via try/finally — including when the callback throws. **It is cross-test safe but NOT intra-file concurrent-safe.** `process.env` is process-global; two `test.concurrent()` calls in the same file both touching the same key will race. Files using `withEnv` stay outside the `test.concurrent()` codemod's eligibility filter.

#### Speed + environment helpers (`test/helpers/`)

Reach for these before hand-rolling; the five speed helpers each have their
own unit test, and the two environment probes are exercised through their
consumer suites:

- `cli-spawn.ts` — `runCli(argv, opts)` (async, hermetic env, timeout-killed),
  `runCliBatch(argvs, {width})` (bounded pool, DEFAULT WIDTH 2 — the cap is
  per-invocation and 4 shards × width multiplies CLI children machine-wide;
  each child can boot a ~1.5GB PGLite), `runCliMemo` (argv-keyed memo for
  read-only calls like `--help`; `clearCliMemo()` drops the memo when a test
  mutates what a memoized call would observe). Replaces the per-file spawn wrappers; a file
  of N independent sequential spawns becomes one width-2 batch in `beforeAll`.
- `wait-for.ts` — `waitFor(predicate, {timeoutMs, intervalMs})` /
  `waitForValue`. Replaces fixed `setTimeout` sleeps: polls resolve as soon as
  the condition holds, and generous deadlines make slow-CI runs LESS flaky
  than a tuned sleep, not more.
- `with-snapshot.ts` — `withColdPglite(fn)`: per-TEST scoped
  `GBRAIN_PGLITE_SNAPSHOT` opt-out (save/delete/restore);
  `withSnapshotValue(value, fn)` is the general form (pin any snapshot path
  for fn's scope; `undefined` = deleted). Use instead of a
  file-level `delete process.env.GBRAIN_PGLITE_SNAPSHOT`, which forces every
  engine in the file to cold-boot. Caution: a snapshot-restored engine does
  not replay migrations on a later `initSchema()` after a version rewind —
  rewind-arc tests need the cold path (see `test/bootstrap.test.ts`).
- `reset-pglite.ts#resetPgliteStateNarrow(engine, tables)` — explicit-table
  truncate for hot loops (the full reset truncates the whole catalog). The
  table list is REQUIRED — a default would silently under-truncate.
- `git-fixture.ts` — `makeGitFixture(dir)`: build-once git repo +
  `reset()`/`commitAll()` between tests, replacing per-test `git init` chains.
- `fs-perms.ts` — `permsEnforced()` / `crontabAvailable()` probes: some hosts
  (FUSE/overlay sandboxes, root) don't enforce permission bits or lack a
  crontab; tests asserting "this write MUST fail" / "cron registered" use
  `test.skipIf(!probe())` so they skip visibly there and still run in CI.
- `git-stderr-probe.ts` — `gitStderrLeads()`: skips raw-git-stderr-slice
  assertions behind ambient git PATH shims that print their own diagnostics
  first (e.g. Conductor's auth-broker wrapper).

#### When to quarantine instead of fix

Rename to `*.serial.test.ts` when:
- The file uses `mock.module(...)` (R2 — there's no clean fix without changing production code).
- The file is genuinely env-coupled (e.g. `gbrain-home-isolation.test.ts`, `claw-test-cli.test.ts`) — module-load env readers + ESM caching defeat dynamic-import-after-env tricks.
- The file's tests intentionally share state across `it()` boundaries.

The quarantine has grown to dozens of files — treat it as debt: every addition needs a reason from the list above, and prefer fixing the contention root cause when one exists.

### Unit test inventory

`bun test` runs all tests without a database. E2E tests skip gracefully when `DATABASE_URL` is not set.

**GBRAIN_HOME isolation preload.** `test/helpers/gbrain-home-preload.ts` (bunfig
`[test]` preload) points `GBRAIN_HOME` at a per-run scratch dir when it isn't
already set, so unit tests never read — or clobber — the operator's real
`~/.gbrain` config/brain. Without it, any config-honoring code path silently
changes behavior with whatever the live `config.json` says (observed: 27
cycle/autopilot/dream tests flipped red the moment a sibling workspace's run
rewrote the real config, while the identical commit stayed green in CI). The
canonical GBRAIN_HOME convention is `config.ts:configDir()`: GBRAIN_HOME is a
PARENT dir and `.gbrain` is appended. Subprocess-spawning tests must set BOTH
`HOME: tmp` and `GBRAIN_HOME: tmp` in the child env (HOME alone loses to the
inherited preload value; in-process HOME mutation loses to Bun's cached
`os.homedir()`). The e2e wrapper sets its own GBRAIN_HOME before bun starts,
which this preload respects. Because the preload respects a pre-set value, the
unit/slow wrappers (`run-unit-parallel.sh` / `run-unit-shard.sh` /
`run-slow-tests.sh`) strip an ambient `GBRAIN_HOME` at their boundary — same
discipline as the database-URL vars — so a dev shell configured for a real
brain can't ride through. `GBRAIN_DEBUG_PRELOAD=1` prints the allocated
scratch home for debugging.

**Provider-key strip preload.** `test/helpers/provider-keys-preload.ts` (bunfig
`[test]` preload) strips the ambient provider credentials the canonical fold
recognizes (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, Gemini/Google, Voyage,
OpenRouter, ZeroEntropy, DashScope, and the Azure OpenAI endpoint fields) and
defaults `GBRAIN_MODEL_DISCOVERY=off` (respecting an explicit operator
override), so key-aware model routing (`resolveTierDefault`) resolves
identically to keyless CI and latest-model discovery never makes a real
network call from a test. Without it, a chat key exported in the dev shell
flips default-model assertions AND turns gated paths into live provider calls
(observed: 183 unit failures + 15-minute retry hangs on an
`OPENAI_API_KEY`-exporting shell). Tests that want keys inject them explicitly
(`configureGateway({env})`, `withEnv`, serial-file `process.env`) — the
preload removes ambient shell state only, before any test file loads. The e2e
wrapper (`scripts/run-e2e.sh`) opts back in at its boundary via
`GBRAIN_TEST_KEEP_PROVIDER_KEYS=1` — e2e is the lane where real keys are
deliberate (live embed/parity tests skip-gate on them).

**Database-URL run guard (#3485).** A `bun test` invocation REFUSES to start while
`DATABASE_URL` or `GBRAIN_DATABASE_URL` is ambient in the environment, because some
tests run destructive SQL against whatever those URLs point at (a bare `bun test`
with `~/.gbrain/.env` sourced has wiped a real brain). The guard is a bunfig
`[test]` preload (`test/helpers/database-url-guard-preload.ts`); it hard-fails with
instructions rather than silently unsetting (a silent unset would turn
DATABASE_URL-gated e2e tests into green skips). The e2e wrappers
(`scripts/run-e2e.sh`, the e2e/heavy workflows) opt in at their own boundary via
`GBRAIN_TEST_ALLOW_DATABASE_URL=1`; the unit/slow wrappers instead strip both
URL vars at their boundary (unit tests need no database), which keeps
`bun run test:full` working with DATABASE_URL exported. Caveat: bun loads
`bunfig.toml` from the invocation cwd, so the preload layer only applies to
runs started at the repo root — the per-file name floor below is the layer
that doesn't care about cwd. Two more layers apply after the opt-in: every
test that runs destructive SQL on the ambient URL must call
`assertSafeE2eDatabaseUrl()` (`test/helpers/db-guard.ts` — name floor: the database
name must contain "test" as a segment, or be opted in via `GBRAIN_E2E_ALLOW_DB`)
or carry an inline name floor the coverage gate recognizes
(`test/e2e/schema-drift.test.ts` keeps its own `looksLikeTestDb`, deliberately
different because it also accepts `*_e2e`), and `test/db-guard-coverage.test.ts`
statically scans the suite and fails when a file connects to `DATABASE_URL` and
runs destructive SQL unguarded. The heavy shell lane gets the same floor outside
bun: `tests/heavy/_db_floor.sh` (sourced by `scripts/run-heavy.sh` for the whole
lane, and by each database-touching heavy script itself, since scripts are
documented for direct invocation — the PGLite-based heavy scripts unset the URL
instead) checks BOTH URL variables and strips query strings before extracting
the database name, so a `?host=/tmp/test-sockets` parameter can't smuggle a
test-shaped segment past it.

Unit tests and what they cover:

- `test/facts-engine.test.ts` / `test/consolidate-valid-until.test.ts` — facts-list filtering and consolidate correctness (#4057): `unconsolidatedOnly` is applied before the 100-row limit, so newer consolidated facts cannot permanently hide older pending facts; the phase regression seeds 100 consolidated rows plus three older pending rows and requires all three to progress.
- `test/markdown.test.ts` — frontmatter parsing; `splitBody` sentinel precedence, horizontal-rule preservation, `inferType` wiki subtypes.
- `test/chunkers/recursive.test.ts` — chunking.
- `test/parity.test.ts` — operations contract parity.
- `test/cli.test.ts` — CLI structure.
- `test/cli-finish-teardown.test.ts` — the #2084 teardown contract: `computeTeardownDeadlineMs` formula/floor/live-registry scaling + `GBRAIN_TEARDOWN_DEADLINE_MS` override (garbage/zero/negative values fall back to the formula); `finishCliTeardown` clean path (drain BEFORE disconnect, no exit, no warn), backstop on hung drain or disconnect (honors an errored op's exit code), throwing drain/disconnect warned + swallowed; the gbrain-owned verdict channel is immune to PGLite WASM `process.exitCode` writes; `flushThenExit` unit coverage with mocked streams (exits once after both stream callbacks, non-TTY aliveness grace, blocked-pipe guard, EPIPE-safe, `GBRAIN_FLUSH_GRACE_MS` override).
- `test/flush-then-exit-harness.test.ts` — real spawned-Bun pipe semantics for `flushThenExit` (fixture: `test/fixtures/flush-then-exit-harness.ts`): a 4MB piped stdout payload arrives byte-complete with the exit code even with a late reader, small output survives exit with a concurrent reader, and the fence resolves promptly (wall time well under the guard + grace ceiling).
- `test/cli-should-force-exit.test.ts` — `shouldForceExitAfterMain` daemon-survival gate: `serve` (stdio and `--http`) never force-exits, including with preceding global flags; op commands / empty / flag-only argv do; the #2084 case that space-separated global-flag VALUES can't fake a command (`--timeout 30s serve` resolves to the `serve` daemon, not a `30s` command).
- `test/cli-exit-verdict-pin.test.ts` — #2084 structural class pin: greps `src/` so the NEXT raw `process.exitCode =` write fails CI (a raw write bypasses the gbrain-owned verdict channel and gets silently zeroed by the deliberate flush-exit — the bug that made doctor's FAIL path exit 0). Runtime variants live in `test/cli-finish-teardown.test.ts`; this is the review-time guard.
- `test/cli-pipe-truncation.test.ts` — real-CLI pipe completeness (the #1959 incident class), implementation-agnostic: the actual CLI run the way agents run it (piped stdout) produces complete, parseable, byte-stable `--tools-json` output and exits deliberately, well under the teardown backstop. Synthetic flush-mechanism coverage stays in `test/flush-then-exit-harness.test.ts`.
- `test/volunteer-context.test.ts` — push-based context core (#2095), hermetic in-memory PGLite: `parseWindow` lenient `user:`/`assistant:` parsing, multi-turn window extraction, confidence-gated volunteering (arm confidences, multi-turn/newest-turn boosts, `min_confidence` gate, max-pages cap), slug-only suppression, privacy (rationales are deterministic templates; synopses pass the takes/facts fence), and the approximate usage-stats join.
- `test/watch-command.test.ts` — `gbrain watch` push transport (#2095): streaming loop, rolling window, session dedupe, `--json` JSONL shape, `channel: 'watch'` event logging, clean EOF return. Hermetic PGLite + injected line/write deps (no subprocess, no real stdin).
- `test/watch-sigint.serial.test.ts` — `gbrain watch` SIGINT lifecycle against a real spawned CLI subprocess with a tmpdir brain. SERIAL: parallel unit shards flake on concurrent subprocess spawns (same rationale as `apply-migrations-pglite-spawn.serial.test.ts`).
- `test/init-picker-pty.serial.test.ts` — the interactive `gbrain init` pickers (embedding-provider + search-mode) driven under a REAL pseudo-terminal via `launchTty`: typed input lands (a NON-default mode choice verified by a follow-up non-TTY config read — bare Enter and the `readLineSafe` timeout both resolve to defaults, so a defaults-asserting test would pass with dead input), prompt-to-acknowledgement gaps bounded well under the fallback window, plus the Ctrl-D/EOF keyless fallback. On CI, missing PTY support fails loud instead of skipping. Hermetic: HOME + GBRAIN_HOME at a temp root, pass-through auth keys stripped via `dropEnv`; `session.close()` in `finally`. Serial: PTY spawn + full PGLite bootstrap, and the serial lane is what runs in required CI.
- `test/tty-harness.test.ts` — the real-PTY harness's pure helpers (`stripAnsi`, `computeStalls`, `renderStallsReport`, `parseDriveCommand`, `buildClaudeTuiSeed`) with zero subprocesses; the file's live-PTY smokes are `describe.skipIf(!ptySupported())`-gated.
- `test/autopilot-launchd-lifecycle.serial.test.ts` — autopilot lifecycle behavior, not generated-string assertions: the full install → self-disable → status → reinstall → uninstall arc with `launchctl` replaced by an argv recorder and the generated wrapper executed by a REAL bash against a genuinely deleted repo (every platform), plus a darwin-only fail-SKIP describe against the real launchd under a per-run unique label (`GBRAIN_AUTOPILOT_LABEL`) so it can never collide with — or tear down — a real install on the host. Serial: spawns subprocesses and pins HOME/GBRAIN_HOME for the whole file.
- `test/autopilot-fanout.test.ts` — Autopilot fan-out and #4046 policy regression: targeted idempotency keys reopen per dispatch interval while stable doctor/remediate keys remain unchanged; the 60-minute full-cycle floor wins with a remaining small plan, and an all-fresh restart check advances the process-local clock without masking failed stale-source submissions.
- `test/agent-scheduler-contract.serial.test.ts` — the documented external agent-scheduler shell chain (`gbrain sync --repo X && gbrain embed --stale`, live-sync.md / INSTALL_FOR_AGENTS.md Step 7) driven end-to-end through a real `/bin/sh` against a keyless PGLite brain: the `&&` short-circuit IS the contract (argv arrays can't exercise it), the keyless bare stale embed exits 0, and the pull-failure case that must break the chain does. Anti-vacuity: the fixture commits a real page and every read-back asserts pages >= 1. Serial: real spawned CLI + tmpdir HOME.
- `test/cli-format-volunteer.test.ts` — `formatResult`'s `volunteer_context` human rendering: pointer lines with confidence/arm/rationale, the empty-result message, the approximate stats summary.
- `test/config.test.ts` — config redaction.
- `test/files.test.ts` — MIME/hash.
- `test/import-file.test.ts` — import pipeline.
- `test/upgrade.test.ts` — schema migrations.
- `test/file-migration.test.ts` — file migration.
- `test/file-resolver.test.ts` — file resolution.
- `test/import-resume.test.ts` — import checkpoints.
- `test/migrate.test.ts` — migration: v8/v9 helper-btree-index SQL structural assertions; 1000-row wall-clock fixtures guarding the O(n²)→O(n log n) fix; v12/v13 SQL shape; `sqlFor` + `transaction:false` runner semantics; the `max_stalled DEFAULT 1` regression guard; v24 `sqlFor.pglite: ''` no-op assertion; v117 `context_volunteer_events` (named + idempotent entry, documented columns + both source-scoped indexes after `initSchema`, insert + 90-day `purgeStaleVolunteerEvents` round-trip).
- `test/bootstrap.test.ts` — bootstrap contract: no-op on fresh install, idempotent across two `initSchema()` calls, no-op on modern brain that already has every probed column, full bootstrap path on a simulated legacy brain, fresh-install regression guard, legacy `links` shape coverage.
- `test/schema-bootstrap-coverage.test.ts` — CI guard covering BOTH embedded schema blobs: neither may forward-reference state its engine's bootstrap can't create, and a reference covered on one blob is NOT automatically covered on the other (`dream_verdicts` exists only in the Postgres blob). PGLite half: `REQUIRED_BOOTSTRAP_COVERAGE` lists every forward reference in `PGLITE_SCHEMA_SQL`; the test fails loudly if `applyForwardReferenceBootstrap` skips one (extend both arrays when adding a column-with-index to the embedded schema blob). Also parses `src/core/migrate.ts` source text for every `ALTER TABLE ... ADD COLUMN` (top-level `sql:`, `sqlFor.{postgres,pglite}` overrides, AND handler-body `engine.runMigration(N, \`ALTER TABLE ...\`)`) and asserts each (table, column) pair is covered by the bootstrap OR by the schema blob's CREATE TABLE bodies — catching the column-only forward-reference class (e.g. `sources.archived`, `oauth_clients.source_id`) that a CREATE INDEX parser alone can't see. Postgres half (the class-closure gate): parses every CREATE INDEX column reference in `SCHEMA_SQL` and requires each to be in the blob's CREATE TABLE body AND not migration-added, or probed + ALTERed by `src/core/postgres-engine/forward-reference-bootstrap.ts` — a column that is both in the blob's CREATE TABLE and migration-added is still a forward reference for pre-existing brains, where `CREATE TABLE IF NOT EXISTS` no-ops and the blob's CREATE INDEX wedges `initSchema` before migrations can help. This gate is parser-driven (no registry to extend); intentional non-probes go in `POSTGRES_INDEX_REF_EXEMPTIONS` with a rationale. Honest scope: CREATE INDEX column references only — constraints, views, and trigger bodies are a filed TODOS.md follow-up. `parseBaseTableColumns` strips SQL line + block comments before identifying column names so commented-out lines don't hide adjacent columns.
- `test/dream-verdict-cache-ttl.test.ts` — `dream_verdicts` TTL contract on PGLite: put assigns the default TTL, expired rows miss on read and only they are swept, re-judging via upsert refreshes a nearly-expired row, the migration backfill derives expiry from `judged_at` idempotently, and a NULL-expiry row (the pre-backfill upgrade window) reads as a hit and survives the sweep — the locally-runnable pin for the NULL-tolerant read predicate both engines share.
- `test/helpers/schema-diff.ts` + `test/helpers/schema-diff.test.ts` + `test/e2e/schema-drift.test.ts` — cross-engine schema parity gate. Helper exports pure `snapshotSchema(query)` / `diffSnapshots(pg, pglite, opts)` / `formatDiffForFailure(diff)` / `isCleanDiff(diff)` over a four-tuple per column (`data_type`, `udt_name`, `is_nullable`, `column_default`). E2E test spins up fresh PGLite + Postgres, runs `engine.initSchema()` on each, snapshots `information_schema.columns`, then diffs. 2-table allowlist (`files`, `file_migration_ledger`) — every other Postgres table must reach PGLite via `PGLITE_SCHEMA_SQL` or a migration's `sqlFor.pglite` branch. Sentinels for `oauth_clients`, `mcp_request_log`, `access_tokens`, `eval_candidates` give tighter blame messages. Skips without `DATABASE_URL`. Wired into `scripts/e2e-test-map.ts` so changes to `src/schema.sql`, `src/core/pglite-schema.ts`, or `src/core/migrate.ts` trigger it. The failure message names every drift with a paste-ready hint pointing at `src/core/pglite-schema.ts`.
- `test/setup-branching.test.ts` — setup flow.
- `test/slug-validation.test.ts` — slug validation.
- `test/storage.test.ts` — storage backends.
- `test/supabase-admin.test.ts` — Supabase admin.
- `test/yaml-lite.test.ts` — YAML parsing.
- `test/check-update.test.ts` — version check + update CLI.
- `test/pglite-engine.test.ts` — PGLite engine, all BrainEngine methods including `addLinksBatch` / `addTimelineEntriesBatch` (empty batch, missing optionals, within-batch dedup via ON CONFLICT, missing-slug rows dropped by JOIN, half-existing batch, batch of 100) plus `connect()` error-wrap assertion (original error nested, #223 link in message, lock released).
- `test/links-timeline-jsonb-poison.test.ts` — gbrain#1861 PGLite half (always-on, no `DATABASE_URL`). Locks the `jsonb_to_recordset` batch-insert path for links/timeline/takes against free-text "poison" payloads (commas, quotes, backslashes, braces, em-dashes) and asserts NUL is stripped from free-text body fields but rejected in identity fields. gbrain#2011 adds lone-UTF-16-surrogate cases: every free-text field (link context; timeline summary/detail/source; take claim/source) well-forms to U+FFFD across batch + scalar write paths, while a surrogate in an identity field (slug) still fail-closed rejects the batch. The Postgres lane (`test/e2e/jsonb-batch-poison-postgres.test.ts`) is the one that actually reproduced the original crash.
- `test/engine-factory.test.ts` — engine factory + dynamic imports.
- `test/integrations.test.ts` — recipe parsing, CLI routing, recipe validation.
- `test/publish.test.ts` — content stripping, encryption, password generation, HTML output.
- `test/backlinks.test.ts` — entity extraction, back-link detection, timeline entry generation.
- `test/lint.test.ts` — LLM artifact detection, code fence stripping, frontmatter validation.
- `test/report.test.ts` — report format, directory structure.
- `test/skills-conformance.test.ts` — skill frontmatter + required sections validation.
- `test/resolver.test.ts` — RESOLVER.md coverage, routing validation; round-trip that every quoted RESOLVER.md trigger matches a frontmatter `triggers:` entry in the target skill, and every `name="<word>"` reference in any SKILL.md resolves to a declared op in `src/core/operations.ts` or a Minions handler in `PROTECTED_JOB_NAMES`.
- `test/search.test.ts` — RRF normalization, compiled truth boost, cosine similarity, dedup key.
- `test/sql-ranking.test.ts` — source-boost helpers: longest-prefix-match in SQL CASE, `detail=high` temporal-bypass, three-meta-char LIKE escape (`%`, `_`, `\`), single-quote SQL-literal doubling, env override parsing for `GBRAIN_SOURCE_BOOST` + `GBRAIN_SEARCH_EXCLUDE`, `resolveBoostMap` / `resolveHardExcludes` merge semantics.
- `test/dedup.test.ts` — source-aware dedup, compiled truth guarantee, layer interactions.
- `test/query-intent-legacy.test.ts` — query intent classification: entity/temporal/event/general (pre-concept behavior pins). `test/query-intent-concept.test.ts` — the `concept` intent: definitional/landscape cue detection, the proper-noun / quoted-phrase / sub-3-word guards, vector-lean weight routing.
- `test/eval.test.ts` — retrieval metrics: `precisionAtK`, `recallAtK`, `mrr`, `ndcgAtK`, `parseQrels`.
- `test/brainbench-fixtures.test.ts` / `test/brainbench-generator.test.ts` / `test/brainbench-metrics.test.ts` / `test/brainbench-continuity.test.ts` / `test/brainbench-writeback.test.ts` / `test/brainbench-adapters.test.ts` / `test/brainbench-scoreboard.test.ts` — the BrainBench memory-conformance unit suites (`src/eval/brainbench/`): fixture loader/validator + the sealed-gold seal (a `gold` key inside a fixture must reject) and committed-corpus integrity; generator determinism (the committed corpus is exactly what `gen.ts` produces, holdout discipline, category counts); metric formulas over hand-built turn rows (zero should-retrieve turns, empty injections, acceptable-vs-gold asymmetry, micro-averaging); cross-harness continuity (writer's decision persists through the production write-back pipeline, reader recalls on the SAME brain); write-back grading the PRODUCTION conversation→facts pipeline via the injected gold extractor; adapter seam contracts over hermetic PGLite (budget caps, suppression modes); scoreboard + gate governance (baseline determinism, count-aware gating, corpus-bless modes, justification flow, isolation gates-at-zero). `test/brainbench-floors.test.ts` — the pre-registered quality floors as executable assertions against the committed baseline (a baseline bless can't bank a threshold violation).
- `test/eval-brainbench-e2e.slow.test.ts` — BrainBench CLI end-to-end via subprocess against a small tmp corpus: the literal exit codes (0 pass / 1 regression / 2 error-or-inconclusive — the CI product), `--out` artifact validity incl. `_meta.metric_glossary`, byte-deterministic `--update-baseline`, anti-vacuous-pass, and the `eval run-all` once-per-sweep record. Slow-tiered with its own CI job (`slow-brainbench-e2e`); independent CLI runs execute once through a width-2 pool in `beforeAll`. The in-process full-corpus completion test was deleted as duplicative — CI's `brainbench` gate runs the committed corpus fresh on every PR and its baseline compare is the fixtures-hash drift guard.
- `test/check-resolvable.test.ts` — resolver reachability, MECE overlap, gap detection, proximity-based DRY detection, `extractDelegationTargets` coverage.
- `test/dry-fix.test.ts` — auto-fix: three shape-aware expander pure-function tests; five guards (working-tree-dirty, no-git-backup, inside-code-fence, already-delegated within 40 lines, ambiguous-multi-match, block-is-callout).
- `test/doctor-fix.test.ts` — `gbrain doctor --fix` CLI integration: dry-run preview, apply path, JSON output shape.
- `test/backoff.test.ts` — load-aware throttling, concurrency limits, active hours.
- `test/fail-improve.test.ts` — deterministic/LLM cascade, JSONL logging, test generation, rotation.
- `test/transcription.test.ts` — provider detection, format validation, API key errors.
- `test/enrichment-service.test.ts` — entity slugification, extraction, tier escalation.
- `test/data-research.test.ts` — recipe validation, MRR/ARR extraction, dedup, tracker parsing, HTML stripping.
- `test/minions.test.ts` — Minions job queue: CRUD, state machine, backoff, stall detection, dependencies, worker lifecycle, lock management, claim mechanics, depth/child-cap, timeouts, cascade kill, idempotency, `child_done` inbox, attachments, removeOnComplete/Fail, `max_stalled` clamp/default/plumbing coverage.
- `test/minion-queue-renewlock-signal.test.ts` — `renewLock` forwards its optional AbortSignal to `executeRawDirect` (stub-engine capture); legacy 3-arg calls unchanged; token-fence miss returns false.
- `test/cycle-drain-renewal.test.ts` — `runDrainRenewalTick` (cycle drain): per-call signal aborted on timeout (slot released), onLost once on a lost fence, throws swallowed, hung renewal resolves at the deadline. Plus two structural source-text pins on `inline-drain.ts` (the shape guard only covers `worker.ts`): the renewal must not go back to a raw `setInterval(() => queue.renewLock(...))`, and the handler invocation must stay wrapped in `withChatPhase('job:<name>')` so a drained child's gateway spend is attributed to the child rather than absorbed by an enclosing `phase:` tag.
- `test/queue-probe-cancellation.test.ts` — `probeQueueState`/`queryWedgeSignals` signal threading: the 1500ms budget CANCELS the losing probe query; fast-path signals never abort; throw still collapses to `{probe_failed: true}`.
- `test/db-pool-max-lifetime.test.ts` — `resolveMaxLifetimeSeconds`: env forms, 0-disables, 30–60min jitter bounds, warn-once on invalid, per-call jitter variance.
- `test/pool-gauge.test.ts` — `CheckoutGauge` pure semantics + the PostgresEngine seams with fake pools: counted while in flight, released on resolve, on REJECTED queries, and on the SYNCHRONOUS pre-aborted-signal throw (leak guards); `getPoolDiagnostics` fail-open.
- `test/db-probe.test.ts` — `runDbProbe` verdict matrix (pool_starved / server_unreachable / unknown), honest-disjunction + no-waiter-arithmetic wording pins, hung probes cancelled via their signals, diagnostics absent/throwing fail open.
- `test/postgres-engine-reserved-routing.test.ts` — `withReservedConnection` routing: direct pool when dual-pool active, read pool when kill-switched/in-tx, semaphore cap (directPoolSize−1) with read-pool overflow, permit released on fn throw and reserve failure.
- `test/job-isolation-protocol.test.ts` — outcome-file codec round-trip + every decode failure path (missing/malformed/oversize→UnrecoverableError; byte counts, never content), handler-error instanceof reconstruction, child-CLI invocation resolution, and REAL detached-process `killProcessGroup` tests incl. the grandchild-death guarantee (exercises the Bun negative-pid `/bin/kill` fallback for real under `bun test`).
- `test/run-child-entry.test.ts` — `runChildJobEntry` on real in-memory PGLite with a REAL claim-minted token: success (fenced updateProgress lands), handler-failure outcome (exit 0), token-mismatch never runs the handler (exit 14), missing job/handler, parent-death watchdog aborts a live handler.
- `test/child-job-runner.test.ts` — `runJobInChild` against real .mjs children: success + full env contract (incl. `GBRAIN_DIRECT_POOL_SIZE=1`), error/lease outcome reconstruction, crash, SIGTERM-ignorer → group SIGKILL at the injected grace, pre-aborted signal, spawn ENOENT → `ChildSpawnInfraError`, worker-shutdown drain (report-during-drain completes; non-reporting kill → `ChildWorkerShutdownError`).
- `test/worker-job-isolation.test.ts` — full parent path on PGLite with the `fake-run-child.mjs` fixture: claim → child → fenced completeJob (real token over env), error outcome → failJob, crash burns the attempt, spawn failure RELEASES with zero attempts burned, and the codex-2 #8 serialization-parity pin (unreportable results fail in BOTH modes, never falsely complete).
- `test/jobs-isolation-flag.test.ts` — `parseJobIsolationFlag`: space/= forms, env fallback + flag-wins, empty-env default, other flags untouched.
- `test/extract.test.ts` — link extraction, timeline extraction, frontmatter parsing, directory type inference.
- `test/extract-db.test.ts` — `gbrain extract --source db`: typed link inference, idempotency, `--type` filter, `--dry-run` JSON output.
- `test/extract-fs.test.ts` — `gbrain extract --source fs`: first-run inserts + second-run reports zero, dry-run dedups candidates across files, second-run perf regression guard for the N+1 dedup bug.
- `test/link-extraction.test.ts` — canonical `extractEntityRefs` both formats, `extractPageLinks` dedup, `inferLinkType` heuristics, `parseTimelineEntries` date variants, `isAutoLinkEnabled` config.
- `test/graph-query.test.ts` — direction in/out/both, type filter, indented tree output.
- `test/features.test.ts` — feature scanning, brain_score calculation, CLI routing, persistence.
- `test/file-upload-security.test.ts` — symlink traversal, cwd confinement, slug + filename allowlists, remote vs local trust.
- `test/query-sanitization.test.ts` — prompt-injection stripping, output sanitization, structural boundary.
- `test/search-limit.test.ts` — `clampSearchLimit` default/cap behavior across `list_pages` and `get_ingest_log`.
- `test/repair-jsonb.test.ts` — JSONB repair: TARGETS list, idempotency, engine-awareness.
- `test/migrations-v0_12_2.test.ts` — JSONB-repair orchestrator phases: schema → repair → verify → record.
- `test/orphans.test.ts` — orphans command: detection, pseudo filtering, text/json/count outputs, MCP op.
- `test/postgres-engine.test.ts` — `statement_timeout` scoping: `sql.begin` + `SET LOCAL` shape, source-level grep guardrail against a reintroduced bare `SET statement_timeout`.
- `test/sync.test.ts` — sync logic + regression guard asserting top-level `engine.transaction` is not called.
- `test/sync-pull-failed-anchor.serial.test.ts` — #3068 regression: a failed internal `git pull` (local-path origin vs `protocol.file.allow=never`) with zero imports returns `partial`/`pull_failed` (not `up_to_date`), freezes `last_commit` + `last_sync_at`, recovers after a manual pull; fall-through import of local commits preserved. Serial: pins `GBRAIN_HOME` to a temp dir for the whole file.
- `test/sync-concurrency.test.ts` — `autoConcurrency()` thresholds + PGLite-forces-serial + explicit-override clamping; `shouldRunParallel()` explicit-bypasses-floor contract; `parseWorkers()` validation rejecting `'0'`/`'-3'`/`'foo'`/`'1.5'`/trailing chars.
- `test/sync-parallel.test.ts` — PGLite-routed coverage of the bookmark gate under concurrency, head-drift gate, vanished-file failure capture, PGLite-stays-serial, and the `gbrain-sync` writer-lock contract.
- `test/sync-all-missing-path.test.ts` — `sync --all --missing-path <fail|skip>` pure helpers: `parseMissingPathMode` (default fail, explicit values, loud rejection of bad/dangling values, never swallows a following flag) and `partitionMissingPathSources` (classification driven only by the injected pathExists predicate — no fs; null `local_path` passes through runnable; order preserved).
- `test/sync-failures.test.ts` — `classifyErrorCode` regex coverage for all 12 codes against literal production message strings from `markdown.ts` and `import-file.ts`; `summarizeFailuresByCode` sort + pre-classified-honor; `recordSyncFailures` code-field persistence; `acknowledgeSyncFailures` `AcknowledgeResult` shape + backfill on legacy entries.
- `test/sync-soft-delete.serial.test.ts` — #4587 removed-file recovery arc: a `git rm` drained by sync SOFT-deletes the page (`deleted_at` set; row recoverable, not gone), an already-soft-deleted row isn't re-flipped (purge clock preserved), batch delete failures decompose to per-file batches and the run banks instead of aborting, delete → re-add inside the window revives via upsert (content updated, chunks replaced, no duplicate), soft-deleted pages stay invisible to search/getLinks/getBacklinks, the rename lane converges against an out-of-band soft delete, and full-sync reconcile + the unsyncable lane are SOFT with the purge window honored end-to-end.
- `test/sync-exclude-config.test.ts` — persisted `sync.exclude` reach: honored with no flag on incremental AND first-sync full-walk paths, trailing-slash covers directory contents, a per-call flag narrows without re-opening the persisted scope, mixed comma+newline multi-pattern values, conservative posture (pages imported before the exclusion stay live, incl. full-sync reconcile), and a throwing/unreadable config read degrades to no-persisted-scope instead of breaking the sync.
- `test/doctor.test.ts` — doctor command; assertions that `jsonb_integrity` scans the four JSONB write sites and `markdown_body_completeness` is present.
- `test/utils.test.ts` — shared SQL utilities + `tryParseEmbedding` null-return and single-warn semantics.
- `test/build-llms.test.ts` — `llms.txt`/`llms-full.txt` generator: path resolution, idempotence, spec shape, regen-drift guard, content contract, AGENTS.md install-path mirror, size-budget enforcement.
- `test/oauth.test.ts` — OAuth 2.1 provider: register, getClient, `client_credentials` grant exchange, `authorization_code` flow with PKCE challenge/verifier, refresh token rotation, `verifyAccessToken` with both OAuth + legacy `access_tokens` fallback, `revokeToken`, `sweepExpiredTokens`; contract test asserting `scope` + `localOnly` annotations on all operations; `coerceTimestamp` unit cases (null/undefined/string/number/throw-on-NaN); NULL-`expires_at`-as-expired contract for both refresh + access token paths; cascade-delete contract asserting `revoke-client` purges `oauth_tokens` + `oauth_codes` via FK CASCADE; cross-client isolation (wrong-client attempt MUST reject AND rightful owner MUST still succeed atomically afterward); empty-string `redirect_uri` bypass guard; PKCE DCR public-client gate (`token_endpoint_auth_method: "none"` returns no `client_secret`, default `client_secret_post` clients get the one-time-reveal secret, `getClient` NULL→undefined normalization, full PKCE `/authorize` → `/token` round-trip against a public client).
- `test/mcp-dispatch-summarize.test.ts` — `summarizeMcpParams` invariants: declared-keys allow-list intersection, attacker-key-name leak guard (unknown keys counted not named), 1KB byte bucketing for size-probe defense, missing op falls through to fully-redacted shape, declared-keys sorted for deterministic output.
- `test/trust-boundary-contract.test.ts` — fail-closed trust semantics under cast bypass: `ctx.remote === undefined` treated as remote/untrusted at every flipped call site; `as any` and `Partial<>` spreads can't downgrade trust by accident.
- `test/remote-privacy-sweep.test.ts` — registry-driven remote privacy sweep: every non-localOnly op dispatched remote-shaped through `dispatchToolCall` against a corpus seeded with high-entropy private sentinels, in both scalar and federated caller shapes; the full response envelope (structured fields, rendered text, errors, `_meta.brain_hot_memory`) asserted sentinel-free. Fail-closed maintenance contract: a new op fails the suite until classified in `EXPECTED_OUTCOME` (+ `PARAM_FACTORY` if it can return corpus data); localOnly ops asserted denied over non-stdio transports; publish-gated ops must deny naming their gate. Curated static sibling: `test/operations-trust-boundary.test.ts`.
- `test/check-resolvable-cli.test.ts` — CLI wrapper: exit codes, JSON envelope shape, AGENTS.md fallback chain.
- `test/regression-v0_16_4.test.ts` — `findRepoRoot` regression guard, hermetic startDir parameterization.
- `test/repo-root.test.ts` — `findRepoRoot` walk semantics + default-arg parity; the 4-tier `autoDetectSkillsDir` fallback chain (`$OPENCLAW_WORKSPACE` → `~/.openclaw/workspace` → repo-root → `./skills`); RESOLVER.md/AGENTS.md filename precedence; explicit-env-wins-over-repo-root; tier-0 `$GBRAIN_SKILLS_DIR` valid/invalid/precedence-over-`OPENCLAW_WORKSPACE`; the install-path walk in `autoDetectSkillsDirReadOnly`; no-drift on primary success; `AUTO_DETECT_HINT` + `AUTO_DETECT_HINT_READ_ONLY` content; regression guard asserting the shared `autoDetectSkillsDir` MUST NEVER return `'install_path'` source (how the read-path/write-path split stays safe).
- `test/resolver-merge.test.ts` — multi-file resolver merge: `findAllResolverFiles` empty / RESOLVER.md-only / AGENTS.md-only / both-present (RESOLVER.md first); `checkResolvable` merge semantics across `skills/RESOLVER.md` + `../AGENTS.md` for the OpenClaw layout where the skillpack ships a thin RESOLVER.md and the real dispatcher lives at the workspace root; dedup by `skillPath` (first occurrence wins); AGENTS.md-at-workspace-root works alone.
- `test/filing-audit.test.ts` — filing audit: `writes_pages` / `writes_to` frontmatter, filing-rules JSON validation.
- `test/skill-brain-first.test.ts` — shared frontmatter parser; `analyzeSkillBrainFirst` compliance ladder across 9 fixtures under `test/fixtures/brain-first-skills/` (compliant-callout, compliant-phase, compliant-position, exempt-frontmatter, missing-brain-first, multi-pattern, negation-prose, no-external, typo-frontmatter); offset helpers; external-lookup regex shape; audit snapshot+diff transition logic; `FORMERLY_HARDCODED_EXEMPT` regression absorption.
- `test/routing-eval.test.ts` — fixture parsing, structural routing, `ambiguous_with`, Haiku tie-break layer.
- `test/skill-manifest.test.ts` — skill manifest parser: drift detection, managed-block markers.
- `test/skillify-scaffold.test.ts` — `gbrain skillify scaffold` stubs: SKILL.md, script, tests, routing-eval fixtures.
- `test/skillpack-install.test.ts` — skillpack bundle + surviving installer primitives: `bundle.ts` enumeration (manifest load/validate, dependency closure, `--all`) and the `installer.ts` seams that outlived the removed `skillpack install` command (`diffSkill` behind `gbrain skillpack diff`, managed-block build/parse, lockfile concurrency, atomic writes).
- `test/skillpack-sync-guard.test.ts` — sync-guard: bundled skills stay byte-identical to `skills/` source.
- `test/http-transport.test.ts` — HTTP transport: bearer auth + missing/no-Bearer/unknown/revoked + `/health` bypass; dispatch.ts round-trip; invalid_params; application/json response shape (not SSE); CORS default-deny + allowlist; body cap on Content-Length AND chunked; two-bucket rate limit (refill, exhaust+Retry-After, LRU eviction, TTL prune, pre-auth IP fires before DB); `mcp_request_log` audit on success + auth_failed.
- `test/restart-sweep.test.ts` — `recipes/restart-sweep.md` inlined script: sentinel-anchored fenced-block extraction with salted tmp filenames to bypass ESM cache; constructor-time env reads (proves no module-load snapshot); idempotency layer load/save/atomic-tmp-rename/corrupt-JSON-recovery/30-day-prune; `(sessionKey, lastAlertedAt)` cooldown gate with 6h threshold; AGGRESSIVE-gate two-state tests; execFile argv shape proving shell metachars in `OPENCLAW_TELEGRAM_GROUP` cannot reach `/bin/sh`; real-`\n`-not-literal alert formatting; `GBRAIN_HOME` state path override.
- `test/eval-longmemeval.test.ts` — LongMemEval harness, hermetic with no `DATABASE_URL` and no API keys: PGLite create + reset over runtime-enumerated `pg_tables`, infrastructure-table preservation across resets, JSONL question parsing, retrieval-only and answer-gen modes via stubbed `ThinkLLMClient`, `--limit` cutoff, `--keyword-only` vs hybrid, default `--expansion=off` behavior, perf gate (p50 < 30ms / p99 < 50ms warm reset+import+search on Apple Silicon), `--help` works without a configured brain, fixture round-trip via `test/fixtures/longmemeval-mini.jsonl`.
- `test/longmemeval-sanitize.test.ts` — sanitization parity pinning that `INJECTION_PATTERNS` from `src/core/think/sanitize.ts` is the single source of truth (adding a pattern there must cover both `<take>` framing and `<chat_session>` framing, no per-surface regex drift).
- `test/openai-compat-multimodal.test.ts` — gateway's openai-compatible multimodal path: happy-path single + multi-input embedding, unauthenticated proxy mode, dimension-mismatch guard (throws `AIConfigError` with model id + observed + expected pre-storage), default-dim fallback when recipe declares `default_dims`, HTTP 401 / 400 / malformed-JSON / non-array error paths, regression that the existing Voyage `/multimodalembeddings` recipe still routes through its dedicated path. Hermetic via the `__setEmbedTransportForTests` seam.
- `test/serve-stdio-lifecycle.test.ts` — `MCP_STDIO=1` env guard: stdin EOF does NOT trigger shutdown when the env is set, SIGTERM still does (guard scope is correct), unset env preserves the CLI lifecycle. Exercises the `ServeOptions.mcpStdio?: boolean` test seam directly so tests don't mutate `process.env`.
- `test/db-lock-fencing.test.ts` — fenced lock identity: a `DbLockHandle` carries its acquisition fence, `refresh()` returns true while owned and false after a steal (0-row fenced UPDATE), a stolen-from handle's `release()` is a fenced no-op that leaves the successor's row intact, and `startCycleLockRefresher` aborts its controller with `LockStolenError` on a fenced miss while serializing ticks (a slow refresh never overlaps the next).
- `test/cycle-lock-steal.serial.test.ts` — runCycle steal-abort arc end-to-end: a mid-run steal produces a structured partial report (`reason: 'lock_stolen'`), runs no further phases, and never touches the successor's lock row; a steal-free cycle completes and releases normally.
- `test/cycle-any-abort-signal.test.ts` — `anyAbortSignal` combining: pre-aborted inputs, late aborts propagating their reason, duck-typed signal stubs (no `addEventListener`) observed via poll, and `dispose()` detaching the caller-signal listener + clearing the poll timer (the daemon leak class).
- `test/cycle-triage-rescue.test.ts` — the dream triage gate: `passesTriageGate` band arithmetic (floor inclusive, at/above threshold never "rescued"), content-type allowlisting, segment verification through `normForGrounding` (case/curly-quote/dash folding matches, fabricated segments never do), the ≥40-char + dedupe-by-normalized-quote rules, and fail-closed behavior on every malformed verdict shape (null score, missing/short/non-string segments) with `minSegments: 0` as the kill switch.
- `test/cycle-synthesize-verify.test.ts` — the mechanical quote verify/repair pass: span extraction with code fences / inline code / wikilinks / link targets masked, odd-mark paragraphs counted `unbalanced`, the repair ladder (exact keep → normalized replace with the verbatim slice → near-match replace → strip the marks keeping the text, never fabricate), the offset-map invariant that every replacement is a real transcript slice, ambiguity fall-through, `skipped_preexisting` scoping by content-hash slug suffix, warn-only numeric/date claim counting, write-back through `importFromContent` only when a span changed, and per-page fail-open.
- `test/cycle-write-path-mini-eval.test.ts` — the hermetic **$0** write-path mini-eval. A frozen 3-transcript mini-corpus (high / buried / routine bands, placeholder names, deliberately disjoint from the paid Cat 35 corpus so there is no tuning coupling) drives the REAL `runPhaseSynthesize` on PGLite: real triage parse + gate incl. the rescue, real fan-out + oneshot drain, real quote verify/repair, real provenance stamp + reverse-write + telemetry. The ONLY stub is the gateway chat transport (`__setChatTransportForTests`), serving a scripted judge and a scripted child. Scope honesty matters here: a scripted child CANNOT measure whether a prompt change improved model output — that stays the paid benchmark's job (receipts in `docs/eval/FIX_WAVE_BASELINES.md`). This is the no-API-key regression pin for the MECHANICAL write path, and its salient-unit presence score is the canary that catches emission, chunk-slug-rewrite, and repair-over-deletion regressions in the normal unit lane.
- `test/cycle-synthesize-triage.test.ts` / `test/cycle-synthesize-triage-calibration.test.ts` — triage gate wiring inside `runTriagePass` (reports carry `rescued`/`verified_segments`, `details.triage` rescue + token counters, dry-run parity), plus the 25-fixture calibration corpus (10 high / 10 low / 5 buried, all synthetic placeholders) enforcing band-consistent parsing, a ≥80% band-accuracy rubric-drift pin, and that ≥4 of the 5 buried fixtures reach the gate. `TRIAGE_VERSION` participates in cache validity, so a rubric bump re-judges rather than serving stale verdicts.
- `test/dream-retriage.test.ts` — `gbrain dream retriage` reads THE shared gate: reconcile-queue never cancels a rescued job, `--audit-rejects` excludes rescued files from the reject sample, alongside the spend-gate / dry-run / liveness arcs.
- `test/facts-extract-idea-kind.test.ts` — the `idea` extractor kind: taxonomy coercion (known kinds survive verbatim, `idea` stays `idea`, unknown kinds coerce to `fact`), prompt shape (the two precomputed system-prompt variants differ in EXACTLY one clause — the low-tier line — both carry the idea definition and the widened enum, and repeat calls return the identical string so prompt caching still hits), and admission wiring (no admission or an admission allowing `low` → label-honestly; a high-only admission → skip-low).
- `test/migrations-v145.test.ts` — the `facts.kind` CHECK widening: the migration's structure (canonical name, idempotent flag, probe + widened predicate), a fresh PGLite schema admitting an `idea` INSERT, and an upgrade from a pre-v145 brain swapping the 5-kind constraint for the widened one with a re-run applying nothing.
- `test/queue-stall-parent-unblock.test.ts` — the shared `killJobs` tail: a stall-exhausted child lands `child_done(dead)` in its parent's inbox and unblocks the parent, a requeued child doesn't touch the parent, all three reapers route through the tail with their own outcome, and the idempotent stranded-parent sweep self-heals parents whose children were already dead (without unblocking parents that still have a live child).
- `test/queue-started-at-retry.test.ts` — every automatic re-run path clears `started_at` (failJob delayed branch, stall requeue, lease release, promoteDelayed, parent re-claim) so a retried job's wall-clock budget measures execution, not backoff wait; end-to-end survival of the wall-clock sweep on a fresh attempt.
- `test/embed-modality-preserved.test.ts` — `carryChunkMetadata` carries modality + all code-metadata fields through re-embed merges (an image chunk stays image), plus the write-side contract that omitting modality resets it to text (why the shared list is load-bearing).
- `test/embed-oversize-heal.test.ts` — oversize-chunk healing pure core (#4530): `healOversizedChunks` split/reindex/metadata-carry (fenced_code `chunk_source` never coerced, D20-T4), `healedChunksToStaleRows` remap (only rows still needing embeddings survive), and the `healOversizedPageChunks` orchestrator incl. the freshness guard (a concurrent rewrite between snapshot and write skips the heal — no clobber).
- `test/embed-oversize-heal-drain.serial.test.ts` — the heal wired into all three real drains against PGLite: `embedStaleForSource`, `embedStalePages` (phase-end closure), and `runEmbedCore --stale` (embedAllStale) heal oversized stored rows in place while preserving the embedded sibling's vector.
- `test/embed-stall.test.ts` — the #4599 embed stall watchdog unit: `resolveEmbedStallAbortSeconds` env resolution (default 900; garbage → default; `<= 0` disables), `createEmbedStallWatchdog` fire/reset/stop semantics, the run-scoped embedding-API liveness clock, and the `assertEmbedNotStalled` handler contract (clean result no-op, stalled result throws).
- `test/jobs-embed-stall-wiring.serial.test.ts` — the X6 contract at the minion boundary: an embed job whose core result carries `reason: 'stall_timeout'` THROWS (job marked failed, banked progress in the message); a clean result resolves with the embed report.
- `test/embed.serial.test.ts` — `runEmbedCore` lifecycle on PGLite with `mock.module` seams: abort-signal threading (#1737), the #4599 stall-watchdog arc against the real lock table (stall fires → single-flight locks released + summary flushed + `reason: 'stall_timeout'` surfaces; non-CLI callers get the error RESULT, no process exit; live progress keeps the watchdog quiet), cleanup aborting an in-flight heartbeat refresh, and the #4647 heartbeat tick-timeout arc (a never-settling refresh times out per tick via `GBRAIN_EMBED_LOCK_HEARTBEAT_TIMEOUT_MS`; 3 consecutive failures → `lock_lost` + drain abort).
- `test/handlers-embed-backfill.test.ts` — the `embed-backfill` job handler's budget-cap classification matrix (#4571): default cap dropped for unpriced models, `pricing.overrides` restores enforceability, `off` uncaps, explicit caps fail closed on unpriced models (incl. an explicit $10 equal to the default), the defaulted cap still enforces for priced models, a present-but-garbage cap value keeps the $10 default FAIL-CLOSED (never droppable), and the handler-lane stall watchdog (a wedged drain aborts and fails the job, refs #4599).
- `test/rerank-sunset-short-circuit.serial.test.ts` — the #3657 post-sunset gateway short-circuit: effective-model resolution (absent per-call model → configured/legacy default), the before/on/after date matrix via the injected clock, live models and `base_urls` self-host overrides untouched, the ONE-audit-row-per-process-per-model + single stderr line contract, and `applyReranker` failing open with no per-query audit rows.
- `test/import-abort-error.test.ts` — `runImport` preflight/argv failures throw typed `ImportAbortError` instead of exiting the process; the calling process survives the abort.
- `test/lint-fix-single-pass.test.ts` — `gbrain lint --fix` walks the tree once and `total_fixed` reports the fixes THIS run applied.
- `test/snapshot-shape-guard.test.ts` — PGLite snapshot loader refusal matrix: shape-less version files, dims/model mismatches, and stale schema hashes are all refused; matching hash + shape loads; a migration-handler edit changes the hash.
- `test/stats-health-source-scope.test.ts` — #4592 source-scoped stats/health/identity: engine-level scoping (every counter confined; degrees/denominators/the islanded predicate scope BOTH edge endpoints; mutating an excluded source moves nothing a scoped caller sees) plus the op layer (remote scalar + federated grants confine `get_stats`/`get_health`/`get_brain_identity`; remote unscoped and the `__all__` sentinel fail closed to zeros; trusted local keeps the brain-wide view).
- `test/takes-list-subcommand.test.ts` — `takes list` routing (#2079: `list` is a subcommand, not a slug) + the #4629 `--limit`/`--offset` flags: cap/skip/paging, engine default without `--limit`, bare `list` unchanged, and invalid values (`0`, non-numeric) exit 1 with the positive-integer message.
- `test/stale-takes-bigint.test.ts` + `test/take-proposals.test.ts` — 64-bit row normalization at the engine boundary: `listStaleTakes` rows and `takes propose --json` / `loadProposal` rows come back as NUMBERS (never bigint/string ids or string weights) on both engines, so takes embed/propose survive real Postgres int8 rows.
- `test/llm-json-reasoning-ladder.test.ts` — `parseLlmJson`'s reasoning-block recovery ladder: strips a closed or truncated `<think>` block ONLY after a raw parse fails (valid JSON containing the tag text is untouched), case-insensitive, array payloads, and the facts/atoms extractors routing through it (the ORIGINAL failure reason is preserved when the retry also fails).
- `test/models-per-task-extract-atoms.serial.test.ts` — `gbrain models` reports `models.dream.extract_atoms` through the phase's own resolver (pins the narrow-resolver divergence: `models.tier.utility` is deliberately ignored; unconfigured falls back to the same tier default the runtime uses).
- `test/conversation-facts-pricing-wiring.test.ts` — `pricing.overrides` reaches every conversation-facts entry point: the strict config registry accepts the key, and direct extraction, the cycle backfill, and `transcripts --facts` all price through the operator override.
- `test/cycle/extract-atoms-model-config-fail-soft.test.ts` — a throwing `getConfig` during extract_atoms model resolution falls back to the tier default instead of rejecting the phase.

### E2E test inventory

E2E tests live in `test/e2e/` and run against real Postgres+pgvector (require `DATABASE_URL`), except where noted as PGLite in-memory (no `DATABASE_URL` needed). One file outside the directory also rides the e2e lane: `test/phantom-redirect-engine-parity.test.ts` (Postgres arm; see the file taxonomy above).

- `test/e2e/facts-separation-postgres.test.ts` — real-Postgres parity for cross-session facts, supersession, and the pre-limit `unconsolidatedOnly` predicate used by consolidation.

- `bun run test:e2e` runs Tier 1 (mechanical, all operations, no API keys). Includes dedicated cases for the postgres-engine `addLinksBatch` / `addTimelineEntriesBatch` bind path — postgres-js's JSONB bind (`jsonb_to_recordset(($1::jsonb)->'rows')`) differs from PGLite's and gets its own coverage.
- `test/e2e/search-quality.test.ts` — search quality against PGLite (no API keys, in-memory).
- `test/e2e/graph-quality.test.ts` — knowledge graph pipeline (auto-link via put_page, reconciliation, traversePaths) against PGLite in-memory.
- `test/e2e/jsonb-batch-poison-postgres.test.ts` — gbrain#1861 regression, the engine that actually crashed. Seeds free-text "poison" context (Zoom URL with `?pwd=`, commas, quotes, Windows backslash path, braces, em-dash) and asserts the links/timeline/takes batch writers no longer error with "malformed array literal"; also asserts NUL is stripped from free-text bodies (`context`/`summary`/`detail`/`claim`) and still rejected in identity fields. gbrain#2011 adds the lone-surrogate crash lock: a lone UTF-16 surrogate in free text (the value that aborted `extract --stale` with `22P02` on Supabase) well-forms to U+FFFD across batch + scalar paths (incl. timeline + take `source`), while a surrogate in an identity field still rejects the batch. `DATABASE_URL`-gated.
- `test/e2e/postgres-jsonb.test.ts` — round-trips all 5 JSONB write sites (`pages.frontmatter`, `raw_data.data`, `ingest_log.pages_updated`, `files.metadata`, `page_versions.frontmatter`) against real Postgres and asserts `jsonb_typeof='object'` plus `->>'key'` returns the expected scalar. Guards against the double-encode bug.
- `test/e2e/integrity-batch.test.ts` — parity for `scanIntegrity`'s batch-load fast path vs sequential. Cases (dedup, hits, validate, topPages) seed a fixture and assert both paths return identical results. Dedup case uses raw SQL via `getConn().unsafe()` to seed a `(test-source-2, people/alice)` row alongside the default-source row, since `engine.putPage` doesn't take a `source_id`. Pins multi-source overcounting; the "multi-source duplicate slugs scan once" case expects both batch + sequential paths to report 2.
- `test/e2e/jsonb-roundtrip.test.ts` — companion regression against the 4 doctor-scanned JSONB sites. Assertion-level overlap with `postgres-jsonb.test.ts` is intentional defense-in-depth: if doctor's scan surface drifts from the actual write surface, one of these tests catches it.
- `test/e2e/sync.test.ts` — `--skip-failed` failure-loop test alongside happy-path tests: broken file → `performSync` returns `blocked_by_failures` with grouped breakdown → `performSync({skipFailed: true})` advances bookmark and returns `AcknowledgeResult` with code summary → second broken file → second cycle. Saves and restores the user's real `~/.gbrain/sync-failures.jsonl` so the test is hermetic. Asserts bookmark gating, JSONL state, dedup across paths, summary aggregation, and the literal doctor-rendering string format.
- `test/e2e/upgrade.test.ts` — check-update against real GitHub API (network required).
- `test/e2e/minions-shell-pglite.test.ts` — PGLite `--follow` inline shell-job path (in-memory, no `DATABASE_URL` required) — the path the minion-orchestrator skill documents for dev use.
- `test/e2e/job-isolation.test.ts` — process isolation on real Postgres (DATABASE_URL-gated, wired EXPLICITLY into `.github/workflows/e2e.yml` tier1 — the workflow runs only named files): a concurrency-3 isolated drain through real child processes (the `fake-run-child.mjs` fixture — real spawns, no child DB pools), and the REAL `jobs run-child` CLI entrypoint end-to-end (engine bootstrap incl. the child's own pools, quiet handler registry, token validation, outcome protocol).
- `test/e2e/sync-reconcile-postgres.test.ts` — the sync reconcile's real-Postgres array-parameter binding path (`DATABASE_URL`-gated). Wired EXPLICITLY into `.github/workflows/e2e.yml` tier1 beside job-isolation, and listed in the selected-e2e EXCLUDE set so a PR touching sync.ts doesn't run it a second time there; before that it ran only on the nightly coverage-full-e2e schedule, so a regression in that bind path could reach master with every PR lane green.
- `test/e2e/pglite-cli-exit.serial.test.ts` — real spawned-CLI exit behavior on PGLite (in-memory, no `DATABASE_URL`): read commands (`search`/`get`/`query`) exit 0 promptly; CLI_ONLY `capture` exits clean and frees the single-writer lock; the `#2084` describes pin every swept disconnect site — a failed op exits 1 with the error on stderr, and the dashboard, read-only-timeout, doctor, and `dream --dry-run` paths all exit with no force-exit banner.
- `test/e2e/pgbouncer-teardown.test.ts` — PgBouncer TRANSACTION-mode teardown (#2084 / the #1972→#2015→#2084 class). Pins the bug CLASS, not timings: a CLI op against a txn-mode pooled URL exits 0 with intact stdout and does NOT ride the 10s hard-deadline backstop (the `engine.disconnect() did not return` banner is the smoking gun — pre-#2084 it printed on 100% of query-shaped ops). Gated by `GBRAIN_PGBOUNCER_URL` + `GBRAIN_PGBOUNCER_DIRECT_URL` (NOT `DATABASE_URL`) — set automatically by `bun run ci:local`'s `pgbouncer` compose service; skips gracefully elsewhere. Uses a DEDICATED `gbrain_pgbouncer` database so it never races the `gbrain_test` TRUNCATE fixtures.
- `test/e2e/volunteer-context-postgres.test.ts` — `volunteer_context` on REAL Postgres (#2095; engine parity beyond the hermetic PGLite unit suite): resolution arms through the actual op handler, the fire-and-forget volunteer-event sink landing rows, the stats join, and the RLS pin that `context_volunteer_events` has ROW LEVEL SECURITY enabled (keeps the v35 auto-RLS event trigger honest for migration-created tables). `DATABASE_URL`-gated.
- `test/e2e/openclaw-reference-compat.test.ts` — `check-resolvable` + skillpack install-model against a minimal AGENTS.md workspace fixture (`test/fixtures/openclaw-reference-minimal/`), regression guard for the OpenClaw deployment shape.
- `test/e2e/workspace-generic-compat.test.ts` — always-on (PGLite, no binary): pins the INSTALL_FOR_AGENTS.md "any repo with a workspace" contract against `test/fixtures/generic-agents-workspace/` (Hermes is the motivating consumer): `cwd_walk_up` detection, the `GBRAIN_SKILLS_DIR` override, `check-resolvable` on a root AGENTS.md, and scaffold additivity + refuse-overwrite. The real Hermes-behavior proof is the door suite below.
- `test/e2e/install-real-hermes.serial.test.ts` — the hermes "door": real `hermes` binary + real `hermes mcp add` handshake (full-catalog tool discovery; the count tracks the op catalog, so the test asserts discovery happened, not a number) + a paid `hermes -z` recall turn against a seeded brain. Triple-gated: `GBRAIN_REAL_HERMES_E2E=1` (explicit opt-in — run-e2e.sh scrubs GBRAIN_*, so it can never fire under `bun run test:e2e`) + resolvable binary + non-empty ANTHROPIC key (anthropic-pinned on purpose: a second provider key flips hermes provider-auto into a mis-routed 401). Hermetic HOME + HERMES_HOME with a tripwire on the operator's real config; evidence copies to `GBRAIN_E2E_EVIDENCE_DIR` for CI upload. Venue: heavy-tests.yml (`real-agent-e2e` + `hermes-door` jobs).
- `test/e2e/install-real-grok.serial.test.ts` — the grok "door" (xAI Grok Build; every asserted shape observed against the pin in `docs/mcp/GROK-CLI-PIN.md`). SPLIT-GATED, a deliberate divergence from the hermes door: grok's `mcp add/list/doctor` run keyless, so the compat tier (version-shape pin, documented-shape `grok mcp add gbrain -- gbrain serve --surface verbs` via a PATH-staged bin dir, saved-TOML asserts via `Bun.TOML.parse`, `mcp doctor` handshake proving the seven-verb surface, vendor-fallback provenance guard, direct-TOML surface) needs only `GBRAIN_REAL_GROK_E2E=1` + a resolvable binary; the paid SMOKE additionally needs a non-empty `XAI_API_KEY` and asserts a PER-RUN NONCE fact (grok has fs/shell tools — the committed fact is greppable, so recall of it proves nothing) with web search disabled. `mcp add` is lazy (exit 0 always) — `mcp doctor <name> --json` is the honest discriminator (exit 0/1 observed). Hermetic HOME + GROK_HOME + tmp cwd on every spawn (grok reads vendor MCP configs for trusted folders and loads `.envrc` from cwd); bounded tripwire over the operator's real `~/.grok` config/credential files (volatile paths excluded — grok rewrites logs/sessions/bin/docs every run) + a checkout guard that no `.grok/`/`.mcp.json` appeared in the repo root. Venue: heavy-tests.yml (`real-agent-e2e` + `grok-door` jobs); run directly via `GBRAIN_REAL_GROK_E2E=1 bun test test/e2e/install-real-grok.serial.test.ts`.
- `test/e2e/install-real-opencode.serial.test.ts` — the opencode "door" (SST opencode; every asserted shape observed against the pin in `docs/mcp/OPENCODE-CLI-PIN.md`). SPLIT-GATED a step past the grok door: opencode's anonymous FREE TIER drives MCP tool calls keyless, so even the nonce SMOKE runs in the keyless tier — T1 bare-semver version pin (the SST-vs-claimant discriminator), T2 documented-shape `opencode mcp add gbrain --env … -- gbrain serve --surface verbs` + the honest `opencode mcp list` discriminator (it SPAWNS every server; `✓/✗` text is the assertion surface — exit code is 0 even on failure, and `mcp debug` is OAuth-only), T2b spawn-gate CANARY (a project-config decoy is spawn-attempted with NO trust prompt — if this ever gates, the bootstrap user-global scope default's rationale changed: re-observe), T3 writer parity (gbrain's `opencode-json.ts` output handshakes through the real binary; cross-tool preservation both ways), T4 keyless SMOKE (per-run nonce + STRUCTURAL `gbrain_*` tool_use proof via `parseOpencodeJsonl`, `--format json`). The paid T5 anthropic leg additionally needs a non-empty `ANTHROPIC_API_KEY` and self-validates the pinned model id against the authed `opencode models` list BEFORE any spend. Hermetic HOME + both XDG dirs + tmp cwd on every spawn; `--pure` on every probe (`mcp list` autoloads plugins — a code-execution surface); bounded tripwire over the operator's real opencode configs/auth.json + a repo-root checkout guard. Venue: heavy-tests.yml (`real-agent-e2e` + `opencode-door` jobs, plus the schedule-only `opencode-door-canary` latest-version leg — continue-on-error, a pin-refresh signal, never a gate); run directly via `GBRAIN_REAL_OPENCODE_E2E=1 bun test test/e2e/install-real-opencode.serial.test.ts`.

**Door cadence policy** (adopted with the 4th door agent): the NEWEST door agent runs at nightly/schedule cadence (currently opencode, whose canary leg also tracks `latest`); a door drops to label-only (`real-agent-e2e`) after 2 stable monthly cycles with unchanged pins. Rationale: churn concentrates in the newest integration; steady-state doors pay for themselves on demand, not nightly.
- `test/helpers/tty-harness.ts` + `test/tty-harness.test.ts` — the DX real-PTY harness (`Bun.spawn({terminal:})`): pure text/timing helpers unit-tested with zero subprocesses, plus three live PTY smokes against `sh` guarded by `describe.skipIf(!ptySupported())`. The harness itself is a dev instrument surface — its consumer `scripts/dx-explore.ts` never runs in CI (transcripts land in gitignored `.context/dx-runs/`); see `docs/guides/bootstrap.md` for the scenario runbook.
- `test/e2e/search-swamp.test.ts` — reproduces the source-swamp case. Seeds a curated `originals/talks/article-outline-fat-code` page against two `<fork>/chat/` pages stuffed with the same multi-word phrase. Asserts the article wins keyword AND vector ranking, that `detail=high` lets the chat swamp re-surface, and that `source_id` passes through the two-stage CTE intact. PGLite in-memory.
- `test/e2e/search-exclude.test.ts` — `test/` + `archive/` pages hidden by default, `include_slug_prefixes` opts back in, caller-supplied `exclude_slug_prefixes` adds to defaults. Both keyword and vector search paths.
- `test/e2e/engine-parity.test.ts` — Postgres ↔ PGLite top-result and result-set parity for `searchKeyword` + `searchVector` (Postgres ranks pages then picks best chunk while PGLite returns chunks directly, so the source-boost behavior needs parity coverage). Skips without `DATABASE_URL`.
- `test/e2e/postgres-bootstrap.test.ts` — exercises `PostgresEngine.initSchema()` directly against a real Postgres database: bootstrap → SCHEMA_SQL → migrations converge from a pre-v0.18 brain, and a brain already at LATEST is an idempotent no-op. Live wedge-class convergence cases rewind a brain to an old schema shape and assert full `initSchema` convergence: pre-v121 timeline, pre-v143 `dream_verdicts` (including that pre-existing rows keep their `judged_at`-derived TTL instead of gaining a fresh 30 days), and pre-v7/pre-v136 `minion_jobs` shapes. Also covers the standalone `db.initSchema` replay path from `src/core/db.ts`, which shares the same bootstrap. Skips without `DATABASE_URL`.
- `test/e2e/http-transport.test.ts` — `gbrain serve --http` end-to-end against real Postgres: bearer auth round-trip, `last_used_at` SQL-level debounce, `mcp_request_log` row insertion on success and auth_failed paths, `/health` DB-down → 503 (DB-probing health check), and the dispatch round-trip with a real operation. Skips without `DATABASE_URL`.
- `test/e2e/serve-http-oauth.test.ts` — real-Postgres E2E against `gbrain serve --http` with full OAuth 2.1. Spawns a subprocess server, registers a client via the CLI, mints `client_credentials` tokens, exercises the `/mcp` JSON-RPC pipeline. Real DCR `/register` HTTP-level response-shape test (asserts `typeof body.client_id_issued_at === 'number'` over the wire, RFC 7591 §3.2.1); real CLI subprocess test for `revoke-client` (registers → mints token → revokes via `execSync` → asserts token rejected at `/mcp` → asserts re-run exits 1); server fixture flips on `--enable-dcr` so `/register` is reachable. **bun execSync env-inheritance contract:** bun's `execSync` does NOT inherit env mutations done via `process.env.X = ...`, only OS-level env from before bun started. helpers.ts loads `.env.testing` and sets `DATABASE_URL` via `process.env` mutation, which is invisible to subprocesses unless `env: { ...process.env }` is passed explicitly — every subprocess call in this file passes `env: { ...process.env }`. Reference fix for the same failure mode in sibling sync/cycle/dream/claw-test E2Es. `afterAll` cleanup is guarded on `clientId` (won't throw if `beforeAll` failed before registration); cleanup errors surface to stderr without throwing so real test failures aren't masked. Also covers the trust-boundary fix: an HTTP MCP `submit_job` for `name: "shell"` MUST reject with a permission error (request handler sets `remote: true` and `submit_job`'s protected-name guard fires), and the same guard rejects subagent submission. Skips without `DATABASE_URL`.
- `test/e2e/sync-parallel.test.ts` — `DATABASE_URL`-gated. 60-file Postgres sync at concurrency=4 imports all + no connection leak (probes `pg_stat_activity` before/after to confirm worker engines disconnected). 120-file serial-vs-parallel benchmark prints `SYNC_PARALLEL_BENCH N files | serial=Xms | parallel(4)=Yms | speedup=Zx`. Asserts parallel ≤ serial × 1.5 (CI-noise tolerant; not a strict speedup gate).
- `test/e2e/multi-source-bug-class.test.ts` — PGLite in-memory regression suite pinning every multi-source bug site: `listAllPageRefs` ordering by `(source_id, slug)`, `getPage` with sourceId picks the right `(source, slug)` row, `extract-takes` processes both overlapping `people/alice` rows independently, `listPages` filters correctly with `PageFilters.sourceId`, `addLinksBatch` with `from/to_source_id` targets the right rows, `validateSourceId` rejects path traversal, reverse-write disk layout uses `brainDir/.sources/<id>/<slug>.md` for non-default sources, `copyMigrationSources` lands source metadata before overlapping-slug pages. No `DATABASE_URL` needed. Wired into `scripts/e2e-test-map.ts` so changes to extract-takes / patterns / synthesize / embed / extract / migrate-engine auto-trigger it.
- `test/e2e/migrate-engine-sources-postgres.test.ts` — `DATABASE_URL`-gated companion for `gbrain migrate --to`: migrates a PGLite brain carrying two non-default sources with overlapping slugs into real Postgres and asserts `copyMigrationSources` created every `sources` FK parent (config JSONB intact, not double-encoded) before any page write. Unit-level manifest identity (crash manifest resumes only against the SAME target; legacy engine-only manifests start fresh) is `test/migrate-engine-resume.test.ts`.
- `test/e2e/facts-fence-reconcile-postgres.test.ts` — `DATABASE_URL`-gated round-trip for the escape-aware fence parser: renders a `## Facts` fence whose cells carry literal pipes, backslashes (Windows paths), and empty cells via `renderFactsTable`, runs the wipe-and-reinsert reconcile (`runExtractFacts`) on real Postgres, and asserts every cell survives byte-identically with no column shift.
- `test/e2e/source-isolation-pglite.test.ts` — PGLite in-memory regression suite pinning the source-isolation seal at two layers. Engine layer: `searchKeyword` / `searchVector` / `searchKeywordChunks` / `listPages` / `getPage` / `traverseGraph` / `traversePaths` apply `sourceId` (scalar fast path) and `sourceIds` (array path) correctly across both engines. Op-handler layer: routes through `sourceScopeOpts(ctx)` so a `read+write`-scoped OAuth client bound to `--source dept-x` cannot see rows from neighboring sources via `search`, `query`, `list_pages`, `get_page`, or `find_experts`. Covers both `ctx.sourceId` (single-source clients) and `ctx.auth.allowedSources` (federated_read clients) precedence; federated array wins over scalar wins over nothing. No `DATABASE_URL` needed.
- `test/e2e/think-source-isolation-pglite.test.ts` — PGLite in-memory suite pinning the `think` gather stage's source scope: seeds three sources with cross-source links and embedded takes, then asserts `runGather` under a federated `sourceIds` grant (and under a scalar `sourceId`) keeps every stream — hybrid retrieval, takes keyword + vector (`searchTakes`/`searchTakesVector`), and the `traversePaths` graph walk — inside the grant while still reaching authorized neighboring sources. No `DATABASE_URL` needed.
- `test/e2e/skill-brain-first.test.ts` — doctor reports `skill_brain_first` check with structured issues; `--fix --dry-run` previews insertion without writing; `--fix` applies the canonical Convention callout idempotently; `brain_first: exempt` frontmatter resolves the warn; `brain_first_typo` surfaces a paste-ready hint; audit JSONL records `detected` / `resolved` / `fixed` transitions; stable brain emits 0 audit lines/run.
- Test-gap-wave journey suites (each claimed by an `scripts/e2e-test-map.ts` row; DATABASE_URL-gated unless noted): `migrate-engine-pglite-to-postgres.test.ts` (whole-brain `runMigrateEngine` transfer incl. the child-process failure arm — config not flipped), `takes-write-ops-postgres.test.ts` (takes op layer + `withPageLock` serialization), `propose-takes-jsonb-postgres.test.ts` + `calibration-profile-write.test.ts` (JSONB bind shape on real Postgres), `engine-parity-cjk.test.ts` (cross-engine CJK keyword parity on an identical corpus — both engines route `hasCJK()` queries through the shared ILIKE builder in `src/core/search/cjk-keyword-sql.ts`; top-slug agreement, chunk-grain parity, mixed-query AND semantics, nonexistent-term strictness), `code-edges-read-parity.test.ts` / `ontology-merge-parity.test.ts` / `chronicle-event-projection-parity.test.ts` / `health-parity-postgres.test.ts` (read-path + getHealth parity), `sync-sigkill-resume-postgres.test.ts` (real SIGKILL mid-sync; DB-polled checkpoint, stranded-lock reclaim, exactly-once resume), `serve-http-source-grant.test.ts` (legacy no-grant federated widening vs granted confinement over real `/mcp`), `mounts-routing-pglite.test.ts` (hermetic mount-routing tiers, no DATABASE_URL), `serve-http-surface-ceiling.test.ts` (hermetic 7-verb `--surface verbs` ceiling; the FORCE_SURFACE env is narrow-only), `autopilot-linux-lifecycle.serial.test.ts` + `upgrade-bun-link-arc.serial.test.ts` (PATH-shimmed crontab/systemctl and bun-link upgrade arcs, hermetic), and the thin-client daily-driver verb extension inside `thin-client.test.ts`.
- Tier 2 (`test/e2e/skills.test.ts`) requires OpenClaw + API keys, runs nightly in CI.
- `test/e2e/claw-test.test.ts` also covers live mode token-free via shim agents (`OPENCLAW_BIN=<sh script>`): the success-oracle break path (a do-nothing agent now FAILS), the E0 child-friction merge surviving tempdir cleanup, and the upgrade staging + schema-version-probe regression.
- If `.env.testing` doesn't exist in this directory, check sibling worktrees: `find ../ -maxdepth 2 -name .env.testing -print -quit` and copy it here if found.
- **Run E2E tests without asking permission.** When you want to verify behavior, there's a relevant E2E test, or you're shipping anything covered by an E2E suite — spin up the test DB, run the tests, tear down. Don't ask, don't propose it, don't defer. The lifecycle is short (~2-30s startup, sub-minute tests, instant teardown) and the gate value is high. Skipping with "DATABASE_URL unset" is silent regression, not caution.

### API keys and running ALL tests

ALWAYS source the user's shell profile before running tests:

```bash
source ~/.zshrc 2>/dev/null || true
```

This loads `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`. Without these, Tier 2 tests
skip silently. Do NOT skip Tier 2 tests just because they require API keys — load
the keys and run them.

When asked to "run all E2E tests" or "run tests", that means ALL tiers:
- Tier 1: `bun run test:e2e` (mechanical, sync, upgrade — no API keys needed)
- Tier 2: `test/e2e/skills.test.ts` (requires OpenAI + Anthropic + openclaw CLI)
- Always spin up the test DB, source zshrc, run everything, tear down.

### E2E test DB lifecycle (ALWAYS follow this)

You are responsible for spinning up and tearing down the test Postgres container.
Do not leave containers running after tests. Do not skip E2E tests, do not ask
permission to run them — see the "run without asking" rule above.

1. **Check for `.env.testing`** — if missing, copy from sibling worktree.
   Read it to get the DATABASE_URL (it has the port number).
2. **Check if the port is free:**
   `docker ps --filter "publish=PORT"` — if another container is on that port,
   pick a different port (try 5435, 5436, 5437) and start on that one instead.
3. **Start the test DB:**
   ```bash
   docker run -d --name gbrain-test-pg \
     -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
     -e POSTGRES_DB=gbrain_test \
     -p PORT:5432 pgvector/pgvector:pg16
   ```
   Wait for ready: `docker exec gbrain-test-pg pg_isready -U postgres`
4. **Bootstrap the schema** (required — fresh containers have no `oauth_clients`,
   `mcp_request_log`, `pages` etc.; tests like `serve-http-oauth.test.ts` will fail
   with `relation "oauth_clients" does not exist` if you skip this):
   ```bash
   DATABASE_URL=postgresql://postgres:postgres@localhost:PORT/gbrain_test \
     bun run src/cli.ts doctor --json > /dev/null 2>&1
   ```
   `gbrain doctor` triggers `initSchema()` on first connect, which is the canonical
   way to bring a fresh DB to head. `apply-migrations --yes` alone does NOT seed
   the base schema — it runs ALTER-style migrations on top of `initSchema`. Tests
   that bypass the engine (raw `execSync`-spawned `auth register-client`) hit the
   schema directly and need this step to have run first.
5. **Run E2E tests:**
   `DATABASE_URL=postgresql://postgres:postgres@localhost:PORT/gbrain_test bun run test:e2e`
6. **Tear down immediately after tests finish (pass or fail):**
   `docker stop gbrain-test-pg && docker rm gbrain-test-pg`

Never leave `gbrain-test-pg` running. If you find a stale one from a previous run,
stop and remove it before starting a new one.
