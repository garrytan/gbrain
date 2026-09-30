# Test audit — LANE=patterns (cross-cutting sweep over `test/**`)

Repo: garrytan/gbrain @ `2ede415` (v0.59.11.0). Read-only lane; no edits committed. All mutation
probes were reverted with `git checkout -- .`; `git status --short` was empty after every batch.

Method: openclaw `test-audit` skill (value bar, retention bar, candidate-evidence fields), gbrain
`AGENTS.md`/`docs/TESTING.md` "Coverage responsibilities before consolidation" (shared PGLite/Postgres
scenarios are NOT duplicate coverage; name a surviving owner for the same contract AND boundary).
Scanners: `~/.capy/work/test-audit/scan.py`, `scan2.py` (raw output `scan.json`, `scan2.json`,
`neardup.txt`); probe log `probes.log`. Cost = `scripts/ubicloud/weights.json` ms per file (per-file,
so a per-test deletion saves only a fraction of the file number; I say so where it matters).

History caveat: the checkout has only 50 commits; most test files trace to the squash/graft commit
`d9909cd` (v0.47.5.0, 2026-08-28), so `git log -S` cannot recover original intent before that.

Corpus: 2,644 `*.test.ts` files (357 serial, 20 slow, ~315 in `test/e2e`); weights cover 2,591 files.

---

## Top candidates (full evidence)

### C1. `test/regressions/v0.36.1.0-iron-rule.test.ts` — whole file (6 tests)
- **Tests:** R1 ×2 (`user message default path…`, `system prompt: no anti-bias section…`), R2 (`null profile → null tag…`),
  R3 (`deriveResolutionTuple operates without any grade_takes imports`), R4 (`this regression is covered by existing v0.34.1 source-isolation suite`),
  R5 (`this regression is covered by existing search-mode test suite`), `IRON RULE inventory > all 5 regressions have an addressed status`.
- **What it can detect:** R4, R5 are `expect(true).toBe(true)` with no production import → detect nothing.
  The inventory test asserts a local object literal contains the word `covered` → self-comparison, detects nothing.
  R3's comment claims it "will fail to compile" if takes-resolution couples to grade_takes — false; it just calls a pure function.
  R1/R2 are line-for-line copies of owner tests.
- **Probe A:** mutated `tagFindingWithCalibration` so a null profile returns a tag → BOTH
  `eval-contradictions-calibration-join.test.ts > tagFindingWithCalibration — R2 regression > null profile returns null tag` and the iron-rule R2 copy failed (18 pass / 2 fail). The copy adds no detection.
- **Surviving owners (same contract, same in-process boundary):**
  R1 → `test/think-with-calibration.test.ts` `withCalibration:false omits the anti-bias section (R1 regression guard)`, `withCalibration omitted entirely → same as false (R1)`, `without calibration: question first, then retrieval, then instruction (regression R1)` (stricter: also checks takes + instruction order).
  R2 → `test/eval-contradictions-calibration-join.test.ts` (probe-proven).
  R3 → `test/takes-resolution.test.ts` (`deriveResolutionTuple({quality:'correct'…})` toEqual full tuple) + `test/e2e/takes-postgres.test.ts`.
  R4/R5 → the file names `test/source-isolation-pglite.test.ts`, which **does not exist** (only `test/e2e/source-isolation-pglite.test.ts`); `test/search-mode.test.ts` exists.
- **Non-test callers of seams:** none needed (only public functions).
- **History:** introduced as a "D26 IRON RULE index" marker; traced to `d9909cd`.
- **Unlocks:** −156 test LOC, −1 unit file. **Cost:** 159 ms (unit).
- **Risk:** low. **Action:** delete. Validate: `bun test test/think-with-calibration.test.ts test/eval-contradictions-calibration-join.test.ts test/takes-resolution.test.ts`.

### C2. Migration `__testing` typeof probes + the dead exports they keep alive
- **Tests:** `phase functions exported for unit testing` in `test/migrations-v0_12_0.test.ts`, `test/migrations-v0_12_2.test.ts`,
  `test/migrations-v0_13_0.test.ts`, `test/migration-orchestrator-v0_21_0.test.ts`.
- **What it can detect:** only that an object property is a function. **Probe B1:** made v0_12_0 `phaseASchema` throw → the probe still passed (the real dry-run test failed instead).
  **Probe B2 (behavior-preserving):** un-exported `__testing` → the probe FAILED. It detects nothing behavioral and breaks on a no-op refactor: textbook implementation coupling.
- **Non-test callers of the seam:** none. `grep "__testing.phase|__testing.readStats"` shows zero callers for these four modules anywhere in `src/` or `test/` besides the typeof lines (other migration versions — v0_16_0, v0_22_4, v0_31_0, v0_32_2, v0_29_1 — do call their own `__testing` for real; not candidates).
- **Surviving owner:** each file's orchestrator tests (e.g. v0_12_0 `dry-run skips all side-effect phases`, proven by B1) plus `test/migration-resume.test.ts`.
- **Unlocks:** −4 tests (~30 test LOC) and **−27 production LOC** (four `export const __testing = {…}` blocks: 6+9+6+6 lines incl. doc comment) — net-negative prod.
- **Cost:** files are 262/286/245/239 ms; the probe itself is ~0 ms (savings are maintenance, not time).
- **Risk:** low. **Action:** delete tests + delete the four `__testing` exports.

### C3. typeof-export / "module can be imported" probes (≈36 tests in 18 files)
Pure probes whose every assertion is `typeof X === 'function'` or `toBeDefined()` on an import. An import failure or missing export
already fails `bun run typecheck` (tsconfig includes `src` and `test`) and every behavior test that calls the export.
| File | Test(s) | Surviving behavioral owner | File ms |
|---|---|---|---|
| test/features.test.ts | `exports runFeatures`, `exports featuresTeaserForDoctor`, **`covers all 7 recipes`** (asserts only `runFeatures` defined) | **NONE** — see gap below | 223 |
| test/enrichment-service.test.ts | 3× `module exports …`, `enrichment result includes tier fields` (asserts only `toBeDefined`) | test/e2e/extraction-review-postgres.test.ts calls `enrichEntity` | 202 |
| test/transcription.test.ts | `module exports transcribe function`, `TranscriptionResult interface shape`, `detects provider from env vars` (body: "We just verify the function is callable") | same file `rejects unsupported audio format`, `rejects missing API key…` (probe E) | 187 |
| test/doctor.test.ts | `doctor module exports runDoctor`, `LATEST_VERSION is importable from migrate`, `takesWeightGridCheck is exported as a pure function` | same file L636/664 call `takesWeightGridCheck(engine)`; doctor CLI tests | 8723 (file) |
| test/code-callers-cli.test.ts | `code-callers module exports runCodeCallers`, `code-callees module exports runCodeCallees` (whole file) | test/code-callers-pin.serial.test.ts, test/e2e/cli-source-scoping-pglite.test.ts | 191 |
| test/cycle-abort.test.ts | `signal field exists on CycleOpts interface` (asserts `typeof runCycle`; never touches `signal`) | same file `runCycle accepts signal in opts without error` | 480 |
| test/eval-whoknows.test.ts | `module exports WhoknowsFn type alias` (asserts `typeof runEvalWhoknows`) | same file `runEvalWhoknows accepts null engine…` | 297 |
| test/whoknows.test.ts | `public surface: rankCandidates / findExperts / runWhoknows are functions` | test/e2e/read-enrichment-privacy.test.ts `findExperts` | 241 |
| test/salience.test.ts | `computeAnomaliesFromBuckets is exported and pure` | test/anomalies.test.ts | 172 |
| test/extract.test.ts | `is a function` (walkMarkdownFiles) | test/sync-walker-submodule.test.ts, test/notability-eval.test.ts | 222 |
| test/migrate.test.ts | `runMigrations is exported and callable` | rest of migrate.test.ts | 8243 (file) |
| test/v0_37_fix_wave.serial.test.ts | `reinit-pglite module exports runReinitPglite` | test/v0_37_gap_fill.serial.test.ts calls `runReinitPglite` | 591 |
| test/ai/gateway-chat.test.ts | `chat() function is exported…`, `ChatBlock + ChatMessage + ChatResult types are exported` (`expect(mod).toBeDefined()`) | gateway chat behavior tests | 187 |
| test/e2e/mcp.test.ts | `MCP server module can be imported` (in the **E2E** lane) | rest of mcp.test.ts | e2e |
| test/operations-embedding-column.test.ts | 2× `exists` | subsequent tests in the same describes dereference the op | 719 |
| test/search/query-op-autocut.test.ts, query-op-adaptive-return.test.ts | `query op exists` | same files | 346/395 |
| test/helpers/agent-harness.unit.test.ts | `resolve*Binary returns a string or null`, `hasHermesAuth returns a boolean` (tautological unions) | none needed (helper smoke) | 448 |
- **Probe F (key finding):** made `runFeatures` throw at entry → `test/features.test.ts` + `test/features-recipe-secrets.test.ts` **19 pass / 0 fail**. `gbrain features` has no behavioral test at all; the three probes give false confidence (one is literally named "covers all 7 recipes").
- **Probe E:** `transcribe` throwing → the 3 typeof probes passed; the 2 real tests failed.
- **Unlocks:** ≈36 tests, ≈180–220 test LOC, one whole file (`code-callers-cli.test.ts`). ms: small (per-test ~0; whole-file deletion of code-callers-cli saves ~191 ms).
- **Risk:** low, except `features`: **action there = rewrite at boundary** (a real `runFeatures(engine, ['--json'])` PGLite test) before deleting the probes. Everywhere else: delete.

### C4. `test/v0_37_fix_wave.serial.test.ts` › `GBrainConfig type includes voyage_api_key field (TS compile guard)`
- **What it can detect:** nothing. The body never references `voyage_api_key` (it does `import(...).then(m => ({type: undefined}))` then `expect(true).toBe(true)`), so neither bun nor tsc can fail on it.
- **Probe C:** deleted `voyage_api_key?: string;` from `GBrainConfig` → test **1 pass / 0 fail**. `tsc --noEmit` reported 9 errors in `src/core/advisor/collect-setup-smells.ts`, `src/core/ai/provider-env.ts`, `src/core/config-db-merge.ts` and 3 real tests — i.e. the typecheck gate over real consumers is the owner.
- **Blame:** L248 test name `db56c778` 2026-09-24; body from `d9909cd`.
- **Unlocks:** −7 LOC. **Cost:** within 591 ms serial file (~0 for this test). **Risk:** low. **Action:** delete.

### C5. `test/schema-pack-manifest-v041_2.test.ts` › `AggregatorKind type union covers exactly the enum values`
- **Identity copier:** `type AggregatorKind = typeof AGGREGATOR_KINDS[number]` (src/core/schema-pack/manifest-v1.ts:200), so `const typed: AggregatorKind = k` for `k of AGGREGATOR_KINDS` is a tautology and `typeof typed === 'string'` is always true.
- **Probe D:** renamed `count_based` → `exposes exactly 4 v1 aggregator kinds` and `accepts all 4 aggregator kinds` failed; the tautology test passed.
- **Owner:** the two tests above in the same file. **Unlocks:** −7 LOC. **Risk:** low. **Action:** delete.

### C6. `test/e2e/mechanical.test.ts` › `describeE2E('E2E: Performance Baselines')` › `import + search + link performance`
- **What it can detect:** only a thrown error from import/search/add_link; it computes p50/p99 and **only `console.log`s** them — no thresholds, no expects.
- **Owner:** the 22 other describes in the same file exercise import, search, add_link and get_backlinks on the same Postgres boundary with assertions (the file is the `e2e.yml` L266 named job).
- **Cost:** file 60,319 ms over 23 describes, each with its own `setupDB()` → **~2.6 s est.** per describe (estimate; not measured — needs Postgres). This one pays a full `setupDB` + 13-fixture import for zero assertions.
- **Unlocks:** −33 LOC, ~2.6 s off a named PR-critical E2E job. **Risk:** low. **Action:** delete (or, if baselines matter, move to a bench script — `test/e2e/bench-vs-openclaw/` already exists).

### C7. Exact cross-file duplicate test bodies
- `test/link-extraction-relative-path.test.ts` › `flat layout unchanged: verb inference still fires on the resolved slug` is byte-identical to
  `test/link-extraction-dir-whitelist-2576.test.ts` › `verb inference works for non-whitelisted dirs (typed edge, not just mentions)` (same input, same asserts, same pure boundary). Delete one (−9 LOC). Risk low.
- `test/e2e/schema-cathedral.test.ts` › `v0.39 T22d — artifact-type routing` (2 tests: `detectArtifactKind dispatches by extension`, `validateManifestByKind rejects cross-kind manifests`) duplicate pure-function assertions in `test/artifact-abstraction.test.ts` (`detectArtifactKind by extension`, and the cross-kind `toThrow(/api_version/)` cases at L38/42). They sit in an E2E-lane file (4,680 ms) that deliberately cold-builds the PGLite schema, but these two never touch the engine. Delete the describe (−12 LOC). Risk low.

### C8. `test/e2e/openrouter-{anthropic,deepseek}-subagent-replay.live.test.ts` — one-parameter clone pair
- `diff` shows the files differ **only** in comments, `MODEL`, and the describe name (168 LOC each, 0.89 line-overlap).
- Gate: `OPENROUTER_API_KEY`; **no workflow sets it** (grep of `.github/workflows`), so CI only ever sees skips, yet the E2E lane charges 1,464 + 1,913 ms for two skip-only files.
- **Action:** merge into one table-driven file over `[MODEL…]` (−~165 LOC, −1 E2E file slot ≈1.5 s). Keep the live contract (it is the opt-in live-provider owner per TESTING.md). Risk low.

### C9. Unconditionally skipped tests that no longer execute anywhere
- `test/e2e/sync-lock-recovery.test.ts` › `pipe through \`head -5\` exits cleanly, next sync runs without lock-busy` — `test.skip` since "v0.41.7+ follow-up" (36 LOC). Its comment defers to `test/process-cleanup.test.ts`, whose header in turn cites **`E2E sync-pipe-sigpipe.test.ts` — which does not exist**. So the SIGPIPE→lock-release path has no real-process owner; only the unit registry test. **Action:** rewrite deterministically or delete and fix the stale reference; do not count it as coverage. Risk **med** (real gap either way).
- `test/e2e/skillpack-third-party.test.ts` › `search returns the local fixture; info shows full details` — `test.skip` (~73 LOC); comment names the owner `test/skillpack-registry-client.test.ts` (exists; 25 `fetchImpl` uses). **Action:** delete. Risk low.

### C10. No-op tests with no production reference
- `test/e2e/cjk-roundtrip.test.ts` › `vector path skip-gracefully without OPENAI_API_KEY`: logs a line if the key is missing, then `expect(true).toBe(true)` unconditionally; imports nothing. Delete (−10 LOC). Risk low.

---

## Category counts (raw scanner hit → confirmed low-value after reading)

| Pattern | Raw hits | Confirmed candidates | Examples |
|---|---|---|---|
| Assertion-free tests (no expect/assert/throw in body) | 208 tests | **2** (mechanical perf, cjk vector no-op) | 190+ are helper-delegated (`expectCode`, `expectUsageExit`, `exerciseX(engine…)` shared scenarios) or no-throw contracts |
| Files with zero `expect` | 46 | **0** | all delegate to `test/helpers/*` scenarios (PGLite + Postgres arms) — retained |
| `expect(true)`/`expect(1)` trivial asserts | 28 sites / 16 tests | **5** (iron-rule R4, R5; v0_37 TS guard; cjk vector; plus 2 E2E "skipped" placeholder markers — harmless) | 13 `expect(1).toBe(1)` sites are fixture strings inside lint/runner tests |
| Self-comparison / identity copier | 1 inventory self-check + 1 type tautology | **2** (iron-rule inventory; AggregatorKind) | |
| typeof-export-is-function / "module imports" probes | 78 typeof sites; 122 "typeof/defined-only" tests | **≈36 tests / 18 files** (+4 `__testing` exports) | C2, C3 |
| Copied inventories / restated constants (`expect(CONST).toEqual([...literal])`) | 32 | **1 delete** (AggregatorKind), 2–3 weak change-detectors (see below); rest retained | |
| Tests of mocks | 0 (no mock-return-then-assert; no test mocks its own module-under-test among 70 `mock.module` files) | **0** | |
| Exact duplicate bodies across files | 6 groups | **2** (C7) + 1 clone pair (C8); 3 are PGLite↔Postgres parity (retained) | |
| Near-duplicate files (≥40% line overlap) | 28 pairs | **1** (openrouter pair); ~10 are PGLite/Postgres parity, rest share setup boilerplate but test different contracts | `neardup.txt` |
| Version-stamped files (`*v0_xx*`, `*-regression*`) | 45 files | **1** (iron-rule); migrations-v* are the migration contract (retained) | |
| Unconditional `test.skip` | 14 literal sites | **2** executable-but-skipped (C9); 9 are else-branch visibility markers; 3 are fixture strings | |
| Env-gated with no CI job setting the gate | 7 gates / 8 files | **move-lane**, not delete | below |

Orphan opt-in gates (skip-only in every CI lane; per TESTING.md a skip is not evidence): `GBRAIN_TRIAGE_CALIBRATION_LIVE` (test/cycle-synthesize-triage-calibration.test.ts, 339 ms), `GBRAIN_TEST_SHARED_SKILLS_BENCHMARK` (test/shared-skills-catalog-performance.test.ts, 385 ms), `GBRAIN_TEST_PACKAGE_SMOKE` (test/e2e/postgres-driver-install.test.ts, 306 ms, 1 day old), `VOYAGE_API_KEY` (test/e2e/voyage-multimodal.test.ts, 270 ms), `OPENROUTER_API_KEY` (2 files, 3,377 ms), `GBRAIN_SELFUPDATE_COMPILE_SMOKE` (test/binary-self-update-compiled.serial.test.ts, 345 ms; owned by `bun run test:compile-smoke`, not in any workflow). ≈5.0 s of lane time for zero executed assertions. Recommendation: exclude `*.live.test.ts`/opt-in files from CI discovery or give them a named opt-in job; do not delete (they are the live-provider owners).

---

## Retained false positives (looked low-value, are the independent contract)

- **Shared-scenario file pairs** (`test/managed-*.test.ts` ↔ `test/e2e/managed-*.test.ts`, `persistence-*`, `facts-separation-pglite` ↔ `facts-separation-postgres`, `links-timeline-jsonb-poison` ↔ `e2e/jsonb-batch-poison-postgres`, `list-all-sources` ↔ `e2e/list-all-sources-postgres`, `chronicle-timeline-reads` ↔ `e2e/chronicle-last-seen-postgres`, `sync-rename-reconcile` ↔ `e2e/sync-reconcile-postgres`, `vector-candidate-safety`): same helper, different engine boundary (JSONB, locking, pooler). TESTING.md rule: not duplicate coverage.
- **`test/operation-context-sourceid-required.test.ts`** (`expect(true)` tests): the assertion is `// @ts-expect-error`, enforced by `bun run typecheck` in `verify` (tsconfig includes `test`). Independent type contract.
- **No-throw tests on empty/idempotent inputs** (`extract-stale` `markPagesExtractedBatch: empty input is a no-op`, `storage` `delete is idempotent`, `pglite-engine` `skipExistenceCheck=true: silent no-op`, `oauth` `revoking already-revoked token is a no-op`, `migrations-v0_27_1` idempotent): credible regression (empty-array SQL, double-delete). Optional tightening: `seed-pglite.serial` `creates parent directories when needed` could assert `existsSync` instead of `expect(true)`.
- **`test/e2e/sync-credential-preflight.test.ts` early return** when `sync-failures.jsonl` is absent: absence is the correct post-fix outcome, not a skip.
- **`test/e2e/graph-signals-eval.test.ts` Gate 1** ends in `expect(true)` but gates via `throw` above it.
- **`test/e2e/jsonb-roundtrip.test.ts` source grep** for `${JSON.stringify(x)}::jsonb`: cheapest independent guard for a known Postgres JSONB double-encode bug class.
- **Restated constants that are wire/security/prompt contracts:** `ALLOWED_SCOPES_LIST` (scope.test.ts, wire drift), `GIT_SSRF_FLAGS` (security), `SOURCE_TIER_NAMES` order, `JUDGE_ERROR_CLASSES` closed vocabulary, `RUBRIC_DIMENSIONS` (LLM JSON schema/prompt), `AGGREGATOR_KINDS` (manifest public API), migration column sets (v94/v126), `Object.keys(...)` envelope shapes (regression-v0_16_4, get-agent-job trimmed keys = privacy), `envelope-to-gbrain` frontmatter-injection key sets (security), `PHASES` vs `BOOTSTRAP_PHASE_IDS` (two constants in lockstep). Weak change-detectors I would *not* prioritize: `CJK_CLAUSE_DELIMITERS covers ；：，、`, `LINKABLE_ENTITY_TYPES exposes the hardcoded contract`, `AGENT_IDS exposes the five supported agents`.
- **Else-branch `test.skip('… requires PostgreSQL')` markers** (persistence-*-parity, storage-tiering, unsupported-embedding-identity, voyage): visibility only, zero cost; keep.
- **Migration version-stamped files** (`migrations-v0_*`, `migrations-v1xx`): each owns one migration's contract.

---

## Sizing

| Bucket | Tests | Test LOC | Prod LOC | CI ms |
|---|---|---|---|---|
| C1 iron-rule file | 6 | 156 | 0 | 159 |
| C2 migration `__testing` probes | 4 | ~30 | −27 | ~0 |
| C3 typeof probes (excl. features until rewritten) | ~33 | ~170 | 0 | ~191 (whole code-callers-cli file) + ~0 |
| C4 + C5 + C10 no-op/tautology | 3 | ~24 | 0 | ~0 |
| C6 mechanical perf describe | 1 | 33 | 0 | ~2,600 (est., Postgres E2E) |
| C7 exact duplicates | 3 | ~21 | 0 | ~0 |
| C8 openrouter merge | (merge) | ~165 | 0 | ~1,500 (one skip-only E2E file) |
| C9 dead skipped tests | 2 | ~109 | 0 | 0 (already skipped) |
| **Total (delete/merge)** | **~52** | **~710** | **−27** | **~4.5 s** |
| Move-lane (orphan opt-in gates) | 8 files | 0 | 0 | ~5.0 s of skip-only slots (overlaps C8 by 3.4 s) |

Bottom line: the pattern sweep finds a modest, high-confidence batch (~700 test LOC, ~27 prod LOC, a few seconds of
CI) rather than a large one — gbrain's "zero-expect" and "duplicate" files are overwhelmingly deliberate shared-scenario
engine parity. The most valuable finding is not a deletion: `gbrain features` has no behavioral test (probe F), and
the SIGPIPE lock-release path points at a nonexistent E2E owner (C9).
