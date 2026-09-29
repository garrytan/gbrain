# Test audit — lane `seams` (gbrain @ 2ede415, v0.59.11.0)

Read-only discovery. Every probe edit was reverted with `git checkout -- .`; `git status --short` is empty at the end. Nothing was committed or pushed.

Method: openclaw `test-audit` skill (evidence fields per candidate), gbrain `AGENTS.md`/`CLAUDE.md`, and `docs/TESTING.md` "Coverage responsibilities before consolidation". Cost comes from `scripts/ubicloud/weights.json` (ms per file per lane). Scratch artifacts sit next to this report: `seam-callers.tsv`, `test-only-exports.tsv`, `unreachable.tsv`, `dead-modules.txt`, `dead-tests.txt`, `bundled-src.txt`, plus the scripts `dead-exports.ts`, `reach.ts` and `modtable.py`.

## TL;DR

1. **The biggest lever is dead production modules kept alive only by tests, not `ForTests` seams.** 42 `src/` modules (9,261 prod LOC) are unreachable from every runtime entry point and every script. I confirmed this three ways: a static import walk, the repo's own `scripts/check-orphan-modules.mjs` (it reports "45/46 test-only-reachable"; 7 of those are script-used, and 4 more are allowlisted hard orphans), and a `bun build` of all runtime entries plus the package `exports`, where none of the 42 appear in the source maps. Then I poisoned all 42 with a top-level `throw`. The CLI (`--version`, `--help`, `doctor`, `upgrade/jobs/takes/recall --help`) and imports of every runtime entry (cli, mcp/server, openclaw engine, core/index, minions/index, ingestion/index, ingestion/test-harness, operations, extract) all still succeed. Only the dedicated test files fail. 37 test files (8,427 LOC; unit 18.1 s + serial 0.33 s + e2e 9.45 s) test nothing but these modules. 11 more are mixed and need a split.
2. **Four of these dead modules claim shipped product behavior, so their tests give false assurance.** This needs a wire-or-delete product decision, not a silent deletion (details in §2.3).
3. **The seam inventory itself is mostly legitimate.** There are 165 test-named exports in `src/` (75 reset/clear, 27 injector, 15 introspection, 48 `__testing`/private bundles). None has a production caller, and there are no `GBRAIN_TEST_*` reads in `src/`. High-confidence cleanups are small: 7 seams with zero callers anywhere, 3 compatibility or test-only wrappers, and 4 tests that only test a test seam. Together that's about 75 prod LOC and 60 test LOC.
4. **`test/scripts` and `test/helpers` protect real CI behavior.** Every script test's target is wired into `package.json`, `verify`, workflows, or a CI script. The helper self-tests guard corpus isolation. No deletions are recommended there.

## 1. Seam inventory (test-only exports / knobs in src)

| Category | Count | Non-test callers | Verdict |
|---|---:|---|---|
| reset/clear module state (`_reset*ForTest(s)`, `clear*`, `_uninstall*`) | 75 | none (by design) | Keep: module-level memos/warn-once need isolation. Delete only the zero-caller ones (§3.1). |
| injectors (`__set*ForTests`, `__setTestEngineOverride`, `_set*Probe`) | 27 | none | Keep: DI for network/LLM/git/engine. The gateway transports alone are imported by 77–88 test files. |
| introspection/drain (`_peek*`, `_cacheSize*`, `__liveReporterCount*`, …) | 15 | none | Implementation-coupled by nature. Each has 1–2 consumer files. Low priority. |
| `__testing` / `__test__` / `_testHelpers` private bundles | 48 | none | They reach private functions from 52 test files. Not dead code. Review per file only if another lane flags the test. |
| exported functions with **no** reference outside their own declaration except tests (non-public files) | 211 (136 excluding the seam names above) | none | Dead-in-prod exports. Largely subsumed by §2. The rest need per-symbol review (examples in §3). |
| exported only so tests can reach an otherwise internally used function | 1,207 | none | Normal "export for test". Not a deletion signal. |
| test-only env knobs | `GBRAIN_TEST_*` in src: **0**. `NODE_ENV==='test'` guards: 2 (`src/cli.ts:359` update-marker, `src/core/backup/status-file.ts:546` backup nag, with `GBRAIN_FORCE_BACKUP_NAG` as its test override) | — | Keep: they stop the corpus from spawning detached network refreshes and nags (see comment at cli.ts:355–358). |

Package-export note: `src/core/operations.ts` (a public `./operations` export) re-exports `__resetRequestToolsPersistLimiterForTests` (line 124), and `src/core/schema-pack/index.ts:95-96` re-exports `_cacheSizeForTests`/`_cacheNamesForTests`. A test seam leaking into a public barrel is a small API-hygiene follow-up.

## 2. Dead production modules kept alive by tests (the main opportunity)

### 2.1 Evidence that they are dead

- **Static walk:** `reach.ts` (entries: `src/cli.ts`, package `exports`, all `scripts/**`, `admin/src/**`, plus string-referenced src paths). The only dynamic-import sites with variable specifiers are `guardrails.ts:220` (user plugins) and `skillpack-load.ts:237` (itself dead), so the walk is sound.
- **Repo guard:** `node scripts/check-orphan-modules.mjs` prints `OK (1467 modules, 32 entrypoints, 4 allowlisted, 45/46 test-only-reachable)`. Its list minus 7 script-used modules (`bootstrap/template-repo`, `eval-contradictions/fixture-redact`, `eval/longmemeval/{diagnostics,evidence-packet}`, `eval/shared/autocut-replay`, `mcp/http-transport`, `mcp/tool-catalog`) plus its 4 allowlisted orphans gives exactly my 42.
- **Bundle:** `bun build` of cli + mcp/server + openclaw-context-engine + admin-embedded + agent-install/entry + every package `exports` target (1,402 src files in the maps). None of the 42 are present.
- **Mutation probe (poison):** a `throw new Error('SEAM_PROBE:<path>')` at the top of all 42 files. Every runtime entry import passed (rc=0, no SEAM_PROBE). `bun src/cli.ts --version` and `--help`, `doctor --fast` on a fresh PGLite home, and `upgrade|jobs|takes|recall --help` all ran without SEAM_PROBE. All 40 non-E2E dependent test files failed at import (`0 pass 1 fail`). So the only detectors of these modules are their own tests. Reverted.

### 2.2 Module → test table (prod LOC; test LOC, ms/lane)

Pure means the test imports nothing live except type-only imports or engine/queue fixture substrate. A pure test goes with its module.

| Dead module (LOC) | Tests (LOC, ms) | Class |
|---|---|---|
| core/data-research.ts (435) | data-research.test.ts (343, u182) | pure |
| core/archive-crawler-config.ts (350) | archive-crawler-config.test.ts (328, u179) | pure |
| core/fail-improve.ts (287) | fail-improve.test.ts (234, u329) | pure |
| core/eval-capture-graph.ts (169) | code-intel/eval-capture-graph.test.ts (150, u201) | pure |
| commands/eval-schema-authoring.ts (176) | eval-schema-authoring.test.ts (94, u184) | pure |
| core/artifact/index.ts (149) | artifact-abstraction.test.ts (50, u187) · e2e/schema-cathedral (176, e4680) | pure + mixed |
| core/distribution/index.ts (124) | distribution-import-boundary.test.ts (93, u175) | pure (architecture test of a dead module) |
| core/diarize/payload-fitter.ts (268) | payload-fitter.test.ts (70, u161) · payload-fitter-summarize.test.ts (217, u203) | pure |
| core/conversation-parser/llm-polish.ts (231) | conversation-parser/llm-polish.test.ts (174, u185) | pure |
| core/enrichment/{budget,completeness}.ts (369+275) | enrichment.test.ts (357, **u4286**) | pure |
| core/calibration/{take-forecast,recall-footer,cross-brain,nudge}.ts (170+81+169+209) | take-forecast (213, u164) · recall-footer (154, u165) · cross-brain-calibration (259, u335) · nudge (299, u153) | pure (type-only imports of commands/calibration) |
| core/eval-contradictions/calibration-join.ts (102) | eval-contradictions-calibration-join (170, u192) · regressions/v0.36.1.0-iron-rule (156, u159) | pure + mixed |
| core/progressive-batch/{orchestrator,retrofit-wrap,stage-report}.ts (778+78+52) | progressive-batch/orchestrator.test.ts (625, u269) · retrofit-wrap.test.ts (84, u185) | pure |
| core/ingestion/{daemon,dedup,skillpack-load}.ts + sources/{file-watcher,inbox-folder,gstack-learnings,markdown-greenfield}.ts (544+169+345+309+369+344+333 = 2,413) | ingestion/daemon (558, u333) · migration-mode (226, u159) · dedup (160, u177) · skillpack-load (318, u167) · sources/file-watcher (294, u703) · sources/inbox-folder (358, u795) · gstack-learnings (224, u174) · markdown-greenfield (336, u210) · e2e/ingestion-roundtrip (334, **e4097**) | pure |
| core/minions/{budget-tracker,self-fix,lease-cap-controller,batch-projection,stagger}.ts (291+275+285+186+35) | budget-tracker (230, u1843) · self-fix (223, u1278) · lease-cap-controller (160, u2234) · batch-projection (282, u222) · e2e/minions-budget-cathedral (126, e1820) · e2e/minions-controller-bounce-only (98, e1873) · e2e/minions-self-fix-flow (144, e1661) · mixed: minions-quiet-hours (215, u5534; the stagger part only), skillopt/silent-abort-3516 (294, u565), e2e/jobs-watch-readsnapshot (86, e2072; uses `setOwnerBudget` as fixture) | pure + mixed |
| core/upgrade-checkpoint.ts (160) | upgrade-checkpoint.serial.test.ts (214, s332) · mixed: e2e/v030_1-integration-pglite (Lane E only, 4 of 14 tests; file e26038, dominated by initSchema, so small ms win) | pure + mixed |
| core/schema-pack/{expand-type-filter,rewrite-links-batch}.ts (186+91) | schema-pack-expand-type-filter (145, u182) · schema-pack-rewrite-links-batch (83, u1919) · mixed: company-brain-schema (111, u318) | pure + mixed |
| core/skillpack/brain-pack-lint.ts (69) | mixed: skillpack-init-brain-pack (83, u302) | mixed |
| core/chronicle/backstop.ts (38) | mixed: chronicle-extract (199, u1588) | mixed |
| core/onboard/impact-capture.ts (188) | mixed: e2e/onboard-full-flow (181, e2035) | mixed |
| core/source-config-redact.ts (47) | source-config-redact.test.ts (54, u160) | **HOLD**, see §2.3 |
| core/chunkers/{llm,semantic}.ts, core/search/{keyword,vector}.ts (163+342+10+10) | none (allowlisted hard orphans in check-orphan-modules) | prod-only deletion; allowlist entries must go too |

Totals:
- **Pure tests:** 37 files, 8,427 LOC; unit 18,131 ms + serial 332 ms + e2e 9,451 ms.
- **Mixed:** 11 files, 1,777 LOC (unit 8,626 ms, e2e 34,825 ms). Only the dead-module cases are removable. The E2E ms mostly stays because setup dominates.
- **Prod:** 9,261 LOC across 42 modules.
- Deleting them lets `MAX_TEST_ONLY_REACHABLE` in `scripts/check-orphan-modules.mjs` ratchet from 46 toward 7, and the 4 allowlist entries go away.

### 2.3 Wire-or-delete decisions (do not delete silently)

- **`core/minions/budget-tracker.ts` / `self-fix.ts` / `lease-cap-controller.ts` / `batch-projection.ts`.** Their headers claim runtime `--budget-usd` enforcement, subagent self-fix and an adaptive lease cap. The live `--budget-usd` path uses a *different* module, `src/core/budget/budget-tracker.ts` (17 live src files). The minions twin is superseded. `self_fix_max_depth` and the lease-cap controller have no live references at all. Recommendation: delete, after the parent confirms these features aren't meant to be wired.
- **`core/upgrade-checkpoint.ts`.** Its header promises `gbrain upgrade --resume`. That flag doesn't exist (`rg -- "--resume" src/commands/upgrade.ts` finds nothing, and no docs mention it). The 18 serial tests and E2E Lane E protect a feature users can't reach.
- **`core/calibration/nudge.ts`.** Migration `take_nudge_log_v0_36` (migrate.ts:3588) creates a table whose only writer is this dead module. Keep the migration (migration contract) even if nudge.ts goes.
- **`core/source-config-redact.ts`: HOLD, route to the security lane.** `scripts/check-source-config-leak.sh` (a CI guard, passes today) names `redactSourceConfig()` as the required remediation and whitelists this file, but no serializer calls it. Deleting the module orphans the guard's advice. Wiring it may be the right fix. Either way the unit test is not what protects secrets today.

Risk for the whole batch: **low technical risk** (bundle-proven dead) but a **product decision**, because some modules are unfinished features someone may intend to wire. Validation: `node scripts/check-orphan-modules.mjs` (lower the ceiling), `bun run typecheck`, the `bun build` source-map check above, then `bun run verify`.

## 3. Seam-level candidates (high confidence, small)

### 3.1 Zero-caller seams (no production caller and no test caller)

| Seam | Location | Evidence | Unlocks |
|---|---|---|---|
| `_clearIdentityCacheForTest` | src/cli.ts:1028-1031 | 0 test refs. Mentioned only in comments in thin-client-upgrade-prompt.ts | 4 LOC |
| `_clearPromptStateForTest` | src/core/thin-client-upgrade-prompt.ts:324-334 | Empty body ("No in-process state to clear today… exists for symmetry"), 0 refs | 11 LOC |
| `_resetFactsDimCheckCacheForTest` | src/core/embedding-dim-check.ts:650-655 | No-op body (WeakMap can't clear), 0 refs | 6 LOC |
| `_resetRerankWarningsForTest` | src/core/ai/gateway.ts:1351-1353 | 0 refs. The memo is actually cleared by `configureGateway` (gateway.ts:458), which is what `test/rerank-no-key.serial.test.ts` "…and the test seam clears it" really uses | 3 LOC |
| `clearRegistryForTests` | src/core/backfill-registry.ts:42-45 | 0 refs | 4 LOC |
| `_resetRollupErrorLogForTests` | src/core/extract/rollup-writer.ts:182-188 | 0 refs | 7 LOC |
| `PostgresEngine.__resetFactsEmbeddingCastCacheForTest()` | src/core/postgres-engine.ts:4357-4360 | 0 callers. Kept alive only by a source-grep test (below) | 4 LOC |

History: every one of these first appears in the squashed baseline `d9909cd` (2026-08-28), except `_resetRerankWarningsForTest`, which appears in `db56c77` (v0.56.2.0). No other history is available.

### 3.2 Tests that only test a seam

**A. `test/embedding-dim-check-facts.test.ts` › "postgres-engine fact insert cast (T6, codex #20) › cached cast suffix has a test-only reset hook for unit cases"** (lines 254-256; file unit 190 ms)
- **What it detects:** only whether the string `__resetFactsEmbeddingCastCacheForTest` exists in postgres-engine.ts.
- **Probe:** a behavior-preserving rename of that zero-caller method made the test FAIL (20 pass, 1 fail). So it's implementation-coupled and pins a dead seam.
- **Non-test callers:** none. **Surviving owner:** not needed, since no behavior is asserted.
- **Action:** delete the test (3 LOC) and the method (4 LOC). Risk: low.

**B. `test/backoff.test.ts` › "backoff › _resetForTest clears module state"** (lines 114-120; unit 195 ms)
- **Probe 1:** broke the production counter (removed `_activeProcesses++` in `preflight`). This test still PASSED, while "concurrent process limit blocks when exceeded", "complete decrements…" and "preflight returns boolean" failed.
- **Probe 2:** made `_resetForTest` a no-op. Only this test failed.
- So it detects breakage of a test helper only. The seam itself stays (used by `beforeEach`), and the owner for the real counter contract is the three tests named above.
- **Action:** delete the test (7 LOC). Risk: low. `src/core/backoff.ts` is live (enrichment-service.ts, minions/worker.ts).

**C. `test/core/git-head.test.ts` › "isSourceUnchangedSinceSync — test-seam round-trip › case 10: …ForTests round-trip"** (lines 123-141; unit 198 ms)
- **Probe:** broke both real probes in `src/core/git-head.ts` (`DEFAULT_HEAD_PROBE` and `DEFAULT_CLEAN_PROBE` always return `null`). **All 21 tests in git-head.test.ts, including case 10, still PASSED.** Its "restore worked" assertion (non-git path → false) is satisfied by a broken probe too.
- **Owner at the real git boundary:** `test/source-health.test.ts` (unit 1,990 ms). It FAILED on the same probe: "isSourceUnchangedSinceSync (ignore-untracked) — local caught-up contract › HEAD == last_commit, clean → caught up", "… WITH untracked dirs → still caught up (the headline bug)", and "computeAllSourceMetrics › commit-relative lag › LOCAL (probeContent)…".
- **Action:** delete case 10 (about 19 LOC). Keep cases 1-9 and 11+: they are predicate logic over injected probes, a legitimate DI use. Risk: low.

**D. `test/resolvers.test.ts` › "_resetDefaultRegistry gives a fresh instance"** (lines 172-179)
- Same pattern as B: the seam is used by `beforeEach` at lines 163-164, and this test asserts only the seam.
- Not separately probed. Confidence is medium-high by analogy with B.
- **Action:** delete (8 LOC). The file weight (unit 4,231 ms) comes from the url_reachable network cases, not this test.

**E. `test/search/title-match.test.ts` › "tokenizeTitle › MIN_CONTENT_TOKENS is 2 (the precision floor)"** (lines 65-67; unit 270 ms)
- **Probe up (2→3):** the behavior tests "isTitlePhraseMatch — positive (the incident) › the exact incident query matches" and "… case + whitespace insensitive" failed, plus the pin.
- **Probe down (2→1):** "isTitlePhraseMatch — negative (precision guard) › single generic content word does NOT match (would over-promote)" failed, plus the pin.
- So the constant pin is redundant in both directions, and the behavior tests are the owner.
- **Action:** delete the pin test (3 LOC). The `__test__` export in `src/core/search/title-match.ts:93` then has no consumer and can go (1 LOC). Risk: low.

### 3.3 Compatibility or test-only wrappers with no production caller (rewrite tests to the real function, delete the wrapper)

**F. `checkDnsRebinding`** (src/core/resolvers/builtin/url-reachable.ts:130-138, doc says "Compatibility helper; the shared validator is the only address policy")
- **Callers:** 0 production; tests are `test/resolvers.test.ts` › "url_reachable resolver › checkDnsRebinding: validates IP literals using the shared policy", "… rejects an unparseable URL" and "… fails closed on DNS failure".
- **Probe A** (dropped the `isInternalUrl` layer in `validateAndResolveUrl`): the owner `test/ssrf-validate.test.ts` failed 5 tests ("validateAndResolveUrl — static rejections (via isInternalUrl) › rejects http://127.0.0.1 (loopback)", "… 169.254.169.254 (AWS metadata)", decimal and hex encodings…). The resolver's real-path tests "blocks localhost via SSRF guard" and "blocks RFC1918 addresses" also failed.
- **Probe B** (DNS failure fails open): the owner failed "validateAndResolveUrl — DNS resolution failures › rejects when DNS lookup fails (ENOTFOUND)".
- So the wrapper tests are fully duplicated by the owner on the same boundary (the shared validator used by `fetchWithSSRFGuard`).
- **Action:** delete the wrapper (9 LOC) and its 3 tests (about 15 LOC). Risk: low. Security contract retained in ssrf-validate.test.ts and the resolver's SSRF tests.

**G. `maybeWarnUnscopedDefaultWrite`** (src/core/source-resolver.ts:605-612)
- A one-line projection of `assessUnscopedDefaultWrite`. Its only production caller is the stdio MCP lane (`src/mcp/server.ts:104-105`), which calls `assessUnscopedDefaultWrite` directly.
- The tests in `test/source-resolver-default-write-guard.test.ts` › "maybeWarnUnscopedDefaultWrite (stdio MCP lane, keyed on the RESOLVED tier)" (about 10 cases) protect a real trust-boundary (remote MCP) contract, so **keep the assertions**.
- **Action:** rewrite them to call `assessUnscopedDefaultWrite(...).warning`, then delete the wrapper (8 LOC). Risk: low.

**H. `_maybeOcrGatedForTests`** (src/core/import-file.ts:1941-1948)
- Bypasses the `GBRAIN_EMBEDDING_IMAGE_OCR` opt-in gate.
- **Probe:** inverted the gate (OCR runs when *not* opted in, a privacy and cost regression). `test/ocr-run-budget.test.ts` (7 tests, unit 1,854 ms) still passed. `test/persistence-image-import.serial.test.ts` still passed. Only `test/e2e/chunk-canonical-text-privacy.test.ts` › "successful OCR normalizes protected markers before image sealing" failed.
- So the budget tests can't see the gate by construction, and the gate's only owner is one E2E case.
- **Action:** rewrite ocr-run-budget at the import boundary (env set, real `maybeOcr` path) and delete the wrapper (8 LOC). Keep the budget contract. Risk: medium (cost contract), so this is a rewrite, not a delete.

### 3.4 Other dead-in-prod exported functions (sample; the 136 need per-symbol review)

`resolveParallelism` (sync.ts:5607), `getMigration` (migrations/index.ts:55, used by 8 tests), `estimateAnthropicCost`, `resolveFile` (file-resolver.ts), `filterOutQuarantined`/`hasContentFlag` (quarantine.ts), `isSupabaseOnly`, `isSupabaseAutoMaintenance`, `writeSnooze`, `removeEntry`, and the `_*AuditFeatureName` exports. Each is referenced nowhere in `src/`, `scripts/` or `admin/src` except its own declaration. The full list is in `test-only-exports.tsv` (column 1 `DEAD-IN-PROD`). I left these as a follow-up rather than ranking them, because many are one-liners inside live modules and the deletion unit is small.

## 4. test/scripts and test/helpers (tests of test infrastructure)

- **`test/scripts/*.test.ts` (39 files):** every target script is wired.
  - Most are direct `package.json`/`verify`/workflow entries: run-unit-parallel, run-serial-tests, run-e2e, test-shard, merge-lcov, coverage gates, check-* guards, e2e-matrix/select-e2e, native workflows.
  - The ones that looked unwired are reached indirectly: `classify-tests.ts` via `check-structural-manifest.sh` in verify, `ubicloud/schedule.ts` via `ci-ubicloud.ts`, `native/compiled-smoke-cleanup.ts` via `compiled-smoke.ts`, `check-skill-refs.mjs`/`check-module-size.sh`/`check-wasm-embedded.sh` via package scripts, and `typecheck-incremental` pins `pkg.scripts.typecheck` semantics against real tsc.
  - These guard real CI behavior (sharding, rescue passes, gate exit codes). **No deletion candidates.**
  - Cost hot spots, which are lane or speed topics rather than value problems: run-unit-parallel 16,187 ms, e2e-runner 10,910 ms, run-serial-pool 9,499 ms, typecheck-incremental 8,637 ms, check-engine-dynamic-import 5,442 ms, run-verify-parallel 4,653 ms.
- **`test/helpers/*.test.ts` (10 files):** agent-harness, cli-spawn, git-fixture, reset-pglite(-narrow), schema-diff(-indexes), wait-for, with-env and with-snapshot. They protect helpers the whole corpus relies on for isolation, where a broken helper means cross-file flakiness. Keep. Note `reset-pglite.test.ts` costs 15,178 ms, a candidate for a speed pass, not deletion.

## 5. Retained false positives (looked low-value, are the independent contract)

- **`src/core/search/sql-ranking.ts` `__test__`** (escapeLikePattern / escapeSqlLiteral / buildLikePrefixLiteral) → `test/sql-ranking.test.ts`. SQL-escaping security contract. The direct unit test is the cheapest independent guard.
- **Gateway transport injectors** (`__setChatTransportForTests` 77 files, `__setEmbedTransportForTests` 88, rerank 9, plus generateText/generateObject). They make the keyless unit corpus possible, and the alternative is live providers.
- **`__setTestEngineOverride`** in migrations v0_22_4/v0_28_0/v0_31_0/v0_32_2. Migration contract tests (`migrations-v0_32_2`, `migration-orchestrator-v0_31_0`, e2e/frontmatter-migration) need an engine without a configured home. Keep.
- **The 75 reset/clear seams** other than the 6 zero-caller ones. Each backs a real module-level memo or warn-once; removing a seam requires removing the memo.
- **The `NODE_ENV==='test'` guards plus `GBRAIN_FORCE_BACKUP_NAG`.** They protect CI from detached network refreshes. The override lets `backup-status-file.serial` and `hook-backup-notice.serial` test the nag at the real boundary.
- **`test/ai/gateway-reset-baseline.test.ts` › "__unconfigureGatewayForTests() gives a genuinely unconfigured gateway".** It tests a seam, but that seam's correctness is a corpus-isolation contract for 80+ files. Keep.
- **The rest of `test/core/git-head.test.ts` (cases 1-9, 11+).** Predicate logic through DI, with the real boundary owned by `test/source-health.test.ts` (proven by probe).
- **`test/ocr-run-budget.test.ts` budget assertions.** The cost-cap contract. Rewrite at the boundary (H), don't delete.
- **Script-used modules the orphan guard counts as "test-only"** (mcp/http-transport, mcp/tool-catalog, bootstrap/template-repo, eval-contradictions/fixture-redact, longmemeval diagnostics/evidence-packet, eval/shared/autocut-replay). Used by `scripts/**` (check-tool-catalog-fresh, shared-skills lifecycle, generate-template-repo, lme-miss-diagnostics, …). Not dead.
- **`core/source-config-redact.ts` + test.** HOLD (§2.3). A CI security guard's remediation depends on it.
- **`src/core/agent-install/{entry,setup}.ts`.** My first walk flagged them, but they are a direct entry (`scripts/setup-in-agent.sh`) and are in the bundle.

## 6. Sizing summary

| Batch | Prod LOC removable | Test LOC removable | Compute (weights.json) | Confidence / risk |
|---|---:|---:|---|---|
| Dead modules, pure tests (§2, excluding source-config-redact HOLD) | ~9,210 (includes 525 untested allowlisted orphans) | 8,427 (37 files) | unit 18.1 s + serial 0.33 s + e2e 9.45 s ≈ 27.9 s file-time/run | High that the code is dead; needs a product wire-or-delete sign-off |
| Dead modules, mixed-file splits | (included above) | part of 1,777 (11 files) | small; E2E setup dominates | Medium; per-file surgery |
| Zero-caller seams (§3.1) | ~39 | 0 | 0 | High / low risk |
| Seam-only tests (§3.2 A–E) | ~5 | ~40 | negligible (tests inside kept files) | High (A, B, C, E probed); D medium-high |
| Wrappers (§3.3 F–H) | ~25 | ~15 deleted + ~10 cases rewritten | negligible | F, G high / low risk; H medium (rewrite) |

Bottom line: the seams themselves are cheap and mostly justified. The real reduction is the 42-module dead-code cluster and its 37 pure tests, which should go as one owner-boundary PR per feature cluster (ingestion, minions-v0.41, calibration-v0.36.1, progressive-batch, misc), each paired with lowering the `check-orphan-modules` ratchet, after the parent confirms none of those features is meant to be wired.
