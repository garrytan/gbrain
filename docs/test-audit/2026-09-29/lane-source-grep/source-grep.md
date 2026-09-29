# Test audit — LANE=source-grep (gbrain @ 2ede415, read-only)

Method: openclaw `test-audit` skill (discovery mode), gbrain AGENTS.md / CLAUDE.md / docs/TESTING.md
"Coverage responsibilities before consolidation". Every mutation probe below was a temporary edit to
`src/**`, followed by `bun test <file>` on the grep test and its claimed owner, then `git checkout -- <file>`.
The tree was verified clean afterwards (`git status --short` → empty). Raw probe log:
`~/.capy/work/test-audit/probes.log`. Inventory artefacts: `inventory.tsv`, `pertest.json`,
`struct_src.json` in the same directory.

Caveat on history: the checkout is a **shallow clone (50 commits)**. Every older test file shows its
last change as the boundary commit `d9909cd` (2026-08-28), so `git log -S` and blame can't go past that
point. Provenance below comes from the issue and version references in each file's header.

Caveat on cost: `scripts/ubicloud/weights.json` records **per-file** ms. A pure source-grep file costs
150–275 ms, and most of that is bun's per-file startup. Unit compute totals 3,985 s over 1,953 files, so
**deleting source-grep tests saves almost no compute**. The payoff is less refactor friction, fewer
tests that give false confidence (see the probes), and less LOC. Treat ms as a side benefit only.

---

## 1. Inventory and sizing

| Measure | Count |
|---|---|
| Test files that read `src/**` (or `admin/src`) as text | **198** (unit 159, serial 30, e2e 8, slow 1) |
| Individual tests that read src and then assert on the text (my per-test scan) | **871** |
| Files where most tests are source greps (per-test scan) | **84** files / 608 tests |
| Repo classifier (`scripts/structural-suites.tsv`, suite-level; src readers only) | 128 files / 1,007 cases; 70 majority-structural files / 685 cases |
| Scanner false positives in the 84 (these read src for a path or spawn the CLI; they're behavioral) | ~22 (e.g. export-help, company-brain-*, e2e/qm-provisioning, e2e/remote-privacy-journeys, eval-brainbench-e2e.slow, scripts/merge-lcov, scripts/coverage-diff-gate, skillpack-scaffold-harness, cli-cwd-dotenv-quarantine, child-worker-supervisor, claude-cli-recipe, reconcile-owner-journey) |
| **Lane corpus (real source-grep files)** | **~92 files** (62 majority-grep + ~30 behavior files with 1–5 embedded grep tests) |

### Class counts (lane corpus, ~92 files)

| Class | Files | Tests | Notes |
|---|---|---|---|
| (1) Duplicated at the owning boundary, or detects nothing → delete/trim | **8** (4 verified by probe, 2 by reading the owner, 1 guard overlap, 1 low-value pins) | **~61** | Details in §2 |
| (2) Cheapest independent guard (architecture, security, default, packaging, drift) → keep | **~62** | ~420 | ~20 read in full; the rest classified from test names (§4) |
| (3) Should be a behavior test at the real boundary → rewrite | **~22** | ~150 | Includes 2 real **coverage gaps** found by probes (§3) |

**Estimated savings from class 1 alone:** ~**640 test LOC**, **3 whole files** (voyage-response-cap,
remote-ping-status-field, embed-helper-migration), and ~**674 ms** of unit compute. No production
test-only seams are unlocked, because none of these tests need an export that production lacks.
Class-3 rewrites are about LOC-neutral but convert ~150 implementation-coupled pins into real checks.

### Overlap with `scripts/guards-manifest.tsv` / `bun run verify`

Only one source-grep test duplicates a verify guard outright.
`test/worker-lock-renewal-shape.test.ts` › "launchJob calls runLockRenewalTick" re-asserts invariant 2 of
`scripts/check-worker-lock-renewal-shape.sh` (`grep -q runLockRenewalTick`), and the test's own header
says "pinned here + the CI guard". The other scanner guards (search-path, jsonb, pg-url-redaction,
worker-pool-atomicity, no-legacy-getconnection, operations-filter-bypass, …) target different patterns
from the src-grep tests. The `test/scripts/check-*.test.ts` files are guard self-tests, not duplicates.

One process note: deleting or renaming any structural suite requires regenerating
`scripts/structural-suites.tsv` (`bun scripts/classify-tests.ts`). Otherwise `check:structural-manifest`
fails in verify.

---

## 2. Class 1 candidates (full evidence)

### C1. `test/voyage-response-cap.test.ts`: delete the whole file
- **Tests (6):** "MAX_VOYAGE_RESPONSE_BYTES constant is declared at 256 MB", "Layer 1: Content-Length pre-check fires BEFORE resp.clone().json()", "Layer 1 throws on Content-Length over the cap", "Layer 2: per-embedding base64 cap…", "inbound try/catch rethrows VoyageResponseTooLargeError", "comment thread documents both layers + the cap-sizing decision".
- **What it can detect:** changes in the text of `src/core/ai/gateway.ts`. The last test pins **comments** ("Layer 1", "16K embeddings").
- **Probes:**
  - P1a rename `MAX_VOYAGE_RESPONSE_BYTES`→`VOYAGE_RESPONSE_CAP_BYTES` (behavior-preserving): grep **4 pass / 2 fail**; gateway.test.ts **40/0**. The grep test is coupled to the implementation.
  - P1b make the rethrow unreachable: grep 5/1, gateway.test.ts 39/**1 fail**. Both detect it.
  - P1c **double the cap to 512 MB**: grep **6/0 pass** (the regex `=\s*256\s*\*\s*1024\s*\*\s*1024` still matches a prefix of `256*1024*1024*2`); gateway.test.ts 38/**2 fail**. The grep test misses a real behavior break that the owner catches.
- **Non-test callers of seams:** none needed. `VoyageResponseTooLargeError` is exported and used by gateway.ts callers.
- **Surviving owner (same contract, same boundary):** `test/ai/gateway.test.ts` › describe "Voyage OOM-cap: too-large response throws (Codex P3 follow-up)". It covers "Layer 1 — Content-Length above cap propagates…", "Layer 2 — oversized base64 embedding string propagates (not swallowed)", and "VoyageResponseTooLargeError is exported as a tagged class". It drives real `embed()` through `configureGateway` with a stubbed fetch. It runs in the unit lane, so the cadence is the same.
- **History:** header says v0.31.8, D2+D10 (voyageCompatFetch OOM). File is at the shallow boundary.
- **Unlocks:** 98 test LOC, 1 file. **Cost:** 239 ms (unit). **Risk:** low.
- **Action:** delete. Validate with `bun test test/ai/gateway.test.ts`.

### C2. `test/remote-ping-status-field.test.ts`: delete the whole file
- **Tests (4):** "no `.state` property reads on job objects remain", "poll loop reads job.status", "terminal-state check tests job.status", "unpack generics type the lifecycle field as status".
- **Probes:**
  - P2a reintroduce the original bug (poll loop reads `job.state`): grep 3/1 fail; `test/remote-cli.test.ts` 6/**3 fail**.
  - P2b behavior-preserving `terminal.includes(String(job.status))`: grep **3/1 fail**; remote-cli **9/0**. The grep test is coupled to the implementation.
- **Surviving owner:** `test/remote-cli.test.ts` › describe "remote ping poll loop". It returns `get_job {status:'completed'|'failed'}` through a fake MCP server and asserts the exit and JSON status. The describe "remote ping --timeout parsing (behavioral…)" also covers it. Unit lane. The typed-generic assertion is already enforced by `tsc` in verify.
- **History:** header describes the `status` vs `state` regression in `gbrain remote ping`. Shallow boundary.
- **Unlocks:** 53 LOC, 1 file. **Cost:** 160 ms. **Risk:** low.
- **Action:** delete. Validate with `bun test test/remote-cli.test.ts`.

### C3. `test/connection-resilience.test.ts`: delete 22 of 25 tests (lines ~11–244)
- **Tests:** describes "isConnectionError" (12), "classifyWorkerExit" (6), "PostgresEngine reconnect behavior" (2), "Supervisor health check failure tracking" (2).
- **What it can detect: nothing in production.** Each of these tests exercises a function or loop **defined inside the test file**: a local `isConnectionError`, a local `classifyWorkerExit`, and simulated retry and counter loops. The file has zero `src` imports. The local `classifyWorkerExit` has also **drifted** from production: it maps code 1 to `'runtime_error'`, while `src/core/minions/exit-classification.ts` returns `'crash'`.
- **Probes:**
  - P6a production `classifyWorkerExit` always returns `'clean_exit'`: connection-resilience **25/0 pass**; `test/exit-classification.test.ts` 11/**6 fail**.
  - P6b supervisor degraded/reconnect branch made unreachable (keeping the `>= 3` literal): connection-resilience **25/0**, `supervisor.test.ts` **23/0**, `supervisor-configuration-blocked.test.ts` **22/0**. **Nothing catches it** (gap G1, §3).
- **Surviving owners:** `test/exit-classification.test.ts` (imports the real `classifyWorkerExit`). For the connection-error predicates, the real classifiers live in `src/core/pg-access-classify.ts` / `connect-probe.ts` and have their own tests. No owner is needed for the simulated loops, because they test only themselves.
- **Keep:** the 3 "Eng-review D3" guards (lines 261–331). They are architecture invariants: no per-call retry in `executeRaw`, `reconnect()` build-then-swap, and supervisor 3-strikes. Rewrite the 3-strikes one as a behavior test (G1).
- **Unlocks:** ~234 LOC. **Cost:** file stays (190 ms). **Risk:** low.
- **Action:** delete the self-copy describes; move the 3-strikes check to the supervisor harness.

### C4. `test/dream-cli-flags.test.ts`: trim 14 of 28 tests, rewrite the rest
- **Delete:** describe "--source / --source-id wiring (v0.41.13)" (9 tests, lines 70–119) and "--once wiring (issue #2860)" (5 tests, lines 154–~196).
- **Probes:**
  - P3a rename local `phaseWasExplicit` (behavior-preserving): grep 26/**2 fail**; `test/dream.test.ts` **45/0**.
  - P3b make the bare-`--once` guard unreachable: grep 27/1; dream.test.ts 40/**5 fail**.
- **Surviving owner:** `test/dream.test.ts`. It covers "runDream — --once (issue #2860)" (bare --once exits 2; `--input … --once` and `--drain --once` exit 2 because an implied phase doesn't count; `--help --once`) and the `--source` behaviors: missing value exits 2, conflict exits 2, engine=null gives "requires a connected brain", archived source exits 1, `--source-id` equivalence, and "non-resolver-user errors propagate uncaught (T3)". Same unit lane.
- **Rewrite in dream.test.ts:** `--input`+`--date` conflict, `--from > --to` "empty range", `--drain` rejecting non-extract_atoms phases, and the ISO date check. No behavior owner exists for these today. Drop the pins on help text, comments, and variable names ("IRON RULE comment", `synthInputFile` identifiers, `patterns=` literal).
- **Unlocks:** ~93 LOC deleted now, ~198 LOC once rewritten. **Cost:** 163 ms. **Risk:** low.

### C5. `test/fix-wave-structural.test.ts`: trim 2 of 31 tests
- **Delete:** "cli.ts parseOpArgs handles --no-<key> as boolean negation" (#1124) and "pglite-engine.ts exports classifyPgliteInitError + buildPgliteInitErrorMessage" (#1340).
- **Probes:**
  - P4a rename `positiveDef` in parseOpArgs (behavior-preserving): fix-wave 30/**1 fail**; `test/cli-args.test.ts` **12/0**.
  - P4b make `--no-<bool>` set `true`: fix-wave 30/1; cli-args 11/**1 fail**.
- **Surviving owners:** `test/cli-args.test.ts` › "parseOpArgs › --no-<boolean> maps to false without consuming the next flag" (calls the real parseOpArgs with `--no-expand`). `test/pglite-init-classifier.test.ts` imports both functions and covers the `$$bunfs`, ENOENT+pglite.data, wasm-abort, and corrupt arms (33 tests).
- **Keep** the rest of the file for now. It's a grab-bag; each block needs its own owner check (follow-up).
- **Unlocks:** ~20 LOC. **Risk:** low.

### C6. `test/embed-helper-migration.test.ts`: delete, after moving one default into a behavior test
- **Tests (8):** refactor-history pins ("imports runSlidingPool", "pre-migration `let nextIdx…` shape is gone", "pre-migration Promise.all fan-out is gone", "failureLabel projector uses page.slug", "call sites pass `workers: CONCURRENCY`", "threads the cancellation signal", "calls runSlidingPool at least twice") plus "preserves GBRAIN_EMBED_CONCURRENCY default of 20".
- **Probes:**
  - P5a rename lambda param `page`→`p` (behavior-preserving): grep 7/**1 fail**; `test/embed.serial.test.ts` **52/0**.
  - P5b force embedAll serial (`workers: 1`): grep 7/1; embed.serial 51/**1 fail**.
  - P5c change embedAll's default concurrency from 20 to 4: grep **8/0** (its regex also matches the second `'20'` site at line 1796) and embed.serial **52/0**. **Neither catches it** (gap G2).
- **Surviving owner:** `test/embed.serial.test.ts` › "runEmbed --all (parallel)" ("runs embedBatch calls concurrently across pages" measures max concurrent calls ≤ env; "respects GBRAIN_EMBED_CONCURRENCY=1 (serial)") plus the `--stale` abort tests (signal threading).
- **Action:** add one behavior test to embed.serial (env unset → max concurrency > 4, or ≤ 20), then delete the file. **Unlocks:** 110 LOC, 1 file. **Cost:** 275 ms. **Risk:** low once the default test lands.

### C7. `test/worker-lock-renewal-shape.test.ts` › "launchJob calls runLockRenewalTick": merge into the guard
- It is the same assertion as `scripts/check-worker-lock-renewal-shape.sh` invariant 2, which runs in verify and has a self-test (`test/scripts/check-worker-lock-renewal-shape.test.ts`). The header of the test file names the duplicate itself. ~4 LOC. Risk: low.

### C8. `test/book-mirror.test.ts` › describe "source file invariants": delete 5 of 7 pins
- **Delete:** "exports runBookMirrorCmd" (tsc and the spawn tests cover it), "documents the trust contract (codex HIGH-1 fix is in the file)" (asserts a **comment** string), "prints a cost-estimate confirmation" (identifier presence), "uses idempotency keys", and "handles partial-failure" (string literals). None of these detects a behavior break at a boundary.
- **Keep:** "uses read-only allowed_tools for subagent fan-out" and "writes via operator-trust put_page … remote: false". These are trust-boundary pins with no cheaper owner.
- ~35 LOC. Risk: low. (No probe run; this is by reading only.)

---

## 3. Class 3: rewrite at the real boundary (includes two real gaps)

| File › tests | Why | Evidence | Rewrite target |
|---|---|---|---|
| **G1** `connection-resilience` › "Supervisor still has the 3-strikes-then-reconnect path" | The only guard on `supervisor.ts` `consecutiveHealthFailures >= 3 → emit health_warn db_connection_degraded + engine.reconnect()`, and it's a literal grep | **P6b: branch unreachable → all supervisor tests pass** | Supervisor harness in `test/supervisor-configuration-blocked.test.ts` (it already sets `consecutiveHealthFailures`): 3 failing health checks → assert the event and the reconnect call |
| **G2** `embed-helper-migration` › "preserves GBRAIN_EMBED_CONCURRENCY default of 20" | Default contract; the regex matches the wrong site | **P5c: default 20→4 undetected by grep and owner** | `embed.serial.test.ts`, env unset |
| `schema-cli-contract.test.ts` (7) | "legacy v0.38 verbs are explicitly NOT in NEW_VERBS" compares two **test-local constants** (a tautology). "EXPERIMENTAL_VERBS set matches…" only checks that the words `init`/`fork`/… appear anywhere in schema.ts | **P7a: EXPERIMENTAL_VERBS emptied → 7/0 pass** (schema-cli.test.ts 15/0, also blind). Behavior coverage of verbs: suggest/diff/review-orphans/downgrade/usage have 0 behavior tests | Table-driven `runSchema([verb,'--json',…])` envelope test (`schema_version:1`, experimental tag) |
| `extract-workers.test.ts` (10) | Import and "legacy loop gone" pins; no behavior test of `extract --workers` exists | Read: no test calls runExtractCore with workers | `runExtract(['links','--workers','0'])` fails loudly; N>1 runs the pool |
| `thin-client-routing-audit.test.ts` (13) | Set-membership greps on cli.ts | `test/cli-dispatch-thin-client.test.ts` already spawns refusals for sync/embed/extract/migrate/apply-migrations/repair-jsonb/orphans/integrity/serve/config/jobs-work, but **not** pages/files/eval/code-*/dream/transcripts/storage/takes/sources | Extend that `refusedCommands` batch (one batched spawn) |
| `models-doctor-embed.test.ts` (3) | Slice-of-function greps; no test drives runModels' embedding probe | Read: no behavior caller | runModels with a fake gateway |
| `extract-conversation-facts-workers.test.ts` (~12 structural of 17) | Import and ordering pins; `extract-conversation-facts-diagnostics.serial.test.ts` already drives pool workers through the real core | Read | Fold the ordering and lock-skip assertions into the diagnostics test |
| `cli.test.ts` (structural ~15), `upgrade.serial.test.ts` (~17 "checks X before Y" order greps), `cycle-pack-gating` (14), `cycle-patterns` (15), `regression-strict-source-id` (6), `phantom-redirect-per-source-lock` (2), `asymmetric-encoding-contract` source-text half (3, self-described "belt + suspenders"), `cycle/cycle-lock-ttl` (1), `backlinks-job-default` (3) | Name-level classification; each has a callable production entry point | Not probed | Per file |
| autopilot wiring family (8 files, ~75 tests: auto-drain, cycle-failure-classification, fanout-wiring, nightly-probe-wiring, parser-probe-wiring, shutdown-engine-close, supervisor-wiring, self-upgrade) | All pin the inline tick body of `runAutopilot()`, which has no test harness | Every header gives that reason | **Keep for now.** Long term, extract a tick function (it has a real production caller: the loop) and test it directly. That's a production refactor, so it's a separate decision |

---

## 4. Retained false positives (look low-value, but are the independent contract)

- **`postgres-engine-singleton-ownership.test.ts`** (7 tests, 190 ms). The behavior owners exist (`test/e2e/postgres-engine-disconnect-idempotency.test.ts`, `db-singleton-shared-recovery.test.ts`, `postgres-reconnect-singleton.test.ts`), but I simulated a PR that touches only `src/core/postgres-engine.ts`: `scripts/select-e2e.ts` selected 25 E2E files and **none of those three**, because `scripts/e2e-test-map.ts` doesn't map them. So on PRs the static guard is the only one that runs. **Action:** add the three files to the `src/core/postgres-engine.ts` map entry, then this file becomes a class-1 delete. `postgres-engine.test.ts` (SET LOCAL statement_timeout, effective_date predicates) follows the same logic, and the absence of session-level `SET` is hard to prove through E2E. Keep.
- **`serve-http-admin-route-guard.test.ts`**: every `/admin` route needs `requireAdmin`. Security, with an anti-vacuity self-test. Keep.
- **`canonical-writer-inventory.test.ts`**: census of canonical write callsites against a reviewed ceiling TSV. Architecture. Keep.
- **`eval-contradictions/no-valid-until-write.test.ts`**: IRON RULE allow-list for writers of `facts.valid_until`. Architecture. Keep.
- **`ai/silent-drop-regression.test.ts`**: no `!process.env.OPENAI_API_KEY` gating. A no-legacy-API guard across the whole ops surface. Keep.
- **`transcription-injection.test.ts`** (execFileSync only, never shell) and **`hook-push-spawn-env.test.ts`** (detached children get the quarantined env): security, and cheaper than any behavior harness. Keep.
- **`migrate-stdout-clean.test.ts`** › "no console.log in migrate.ts": **stronger** than its behavior sibling, which only replays v122→latest. Keep both.
- **`jobs-gateway-refresh-set.test.ts`**: two-way drift check between a set and its registrations. Keep. Could become a behavior test if the set were exported, but no production need exists.
- **`think-embed-question-wiring.serial.test.ts`** CRAG pin: the synthesize behavior test is a different call site. The CRAG site can't be reached hermetically. Keep.
- **`book-mirror`** allowed_tools and `remote:false` pins: trust boundary. Keep.
- **`migrations-v0_13_0`** (no `process.execPath`/bun/.ts in phase commands: compiled-binary packaging), **`migrations-v0_14_0`** (schema defaults in all three schema sources), **`reranker-default-seam`**, **`v0_37_fix_wave` / `v0_37_gap_fill`** defaults: default, migration, and packaging contracts. Keep.
- **`cli-force-exit-teardown-arming`**, **`upgrade-skill-publish-prompt-race`**, **`serve-http-mcp-transport-cleanup`**: ordering and resource invariants with no cheap harness. Keep. The transport cleanup could get an HTTP close test later.
- **`openclaw-plugin-manifest` / `codex-plugin-manifest` / `docs-mcp-deploy` / `retrieval-reflex-recipe-routing`**: package and doc contracts, mostly reading non-src files. Out of scope; keep.

---

## 5. Recommended batches (in order)

1. **Batch A (low risk, ~400 LOC, 2 files):** delete C1 and C2, remove the 22 self-copy tests in C3, trim C5 and C7. Regenerate `scripts/structural-suites.tsv`. Validate with `bun test test/ai/gateway.test.ts test/remote-cli.test.ts test/exit-classification.test.ts test/cli-args.test.ts test/pglite-init-classifier.test.ts test/connection-resilience.test.ts test/fix-wave-structural.test.ts`, then `bun run verify`.
2. **Batch B (gaps first, then delete):** add the G1 supervisor behavior test and the G2 embed default test, then delete C6 and trim C4 and C8.
3. **Batch C (routing):** add the E2E map entries, then delete `postgres-engine-singleton-ownership.test.ts`.
4. **Batch D (rewrites):** schema-cli-contract, extract-workers, thin-client-routing-audit, models-doctor-embed.

## 6. Probe log (verbatim summary)

| Probe | Mutation | Grep test | Owner test |
|---|---|---|---|
| P1a | rename MAX_VOYAGE_RESPONSE_BYTES (preserving) | voyage-response-cap 4/2 **fail** | gateway 40/0 |
| P1b | rethrow unreachable | 5/1 | gateway 39/1 |
| P1c | cap doubled | **6/0 pass** | gateway 38/2 |
| P2a | poll reads job.state | remote-ping 3/1 | remote-cli 6/3 |
| P2b | String(job.status) (preserving) | 3/1 **fail** | remote-cli 9/0 |
| P3a | rename phaseWasExplicit (preserving) | dream-cli-flags 26/2 **fail** | dream 45/0 |
| P3b | bare --once guard unreachable | 27/1 | dream 40/5 |
| P4a | rename positiveDef (preserving) | fix-wave 30/1 **fail** | cli-args 12/0 |
| P4b | --no-bool sets true | 30/1 | cli-args 11/1 |
| P5a | failureLabel param rename (preserving) | embed-helper-migration 7/1 **fail** | embed.serial 52/0 |
| P5b | embedAll workers: 1 | 7/1 | embed.serial 51/1 |
| P5c | default 20→4 | **8/0 pass** | **52/0 pass** (gap) |
| P6a | prod classifyWorkerExit → clean_exit | connection-resilience **25/0 pass** | exit-classification 11/6 |
| P6b | supervisor 3-strikes unreachable | **25/0 pass** | supervisor 23/0, supervisor-configuration-blocked 22/0 (gap) |
| P7a | EXPERIMENTAL_VERBS emptied | schema-cli-contract **7/0 pass** | schema-cli 15/0 (gap) |
| — | select-e2e with postgres-engine.ts-only diff | — | 25 files selected, none of the 3 singleton E2E owners |
