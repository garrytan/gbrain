# PR 2 slice evidence — delete blind and duplicate tests, seams, guards, docs

Base: master @ a6eca5e (v0.59.17.0). All probes were temporary edits reverted by the probe tool
(`(scratch) pr2/probe.py`); raw output for every row is in `(scratch) pr2/probes.log`
(48 probe records). "git:<path>" means the deleted/trimmed test was materialized from HEAD next to
its original path for the probe run. Postgres probes ran against a local `pgvector/pgvector:pg16`
container with `GBRAIN_TEST_ALLOW_DATABASE_URL=1`.

Evidence cases: **R** = retained contract (surviving owner + executed mutation failure),
**A** = intentionally abandoned contract (disposition + reachability/promise evidence),
**V** = vacuous assertion (demonstrated lack of contract).

## Source-grep pins

| Deleted test | Case | Probe edit | Result | Surviving owner | Owner result |
|---|---|---|---|---|---|
| `test/voyage-response-cap.test.ts` (whole file, 6) | R | `src/core/ai/gateway.ts`: `MAX_VOYAGE_RESPONSE_BYTES` 256 MB → 512 MB | 6 pass / 0 fail (blind) | `test/ai/gateway.test.ts` › "Voyage OOM-cap: too-large response throws" | 38 pass / 2 fail (Layer 1 + Layer 2) |
| `test/remote-ping-status-field.test.ts` (whole file, 4) | R | `src/commands/remote.ts`: terminal check reads `job.state` | 3 / 1 (text pin) | `test/remote-cli.test.ts` › "remote ping poll loop" | 7 / 2 (behavioral: blip survives, failed → exit 1) |
| `test/connection-resilience.test.ts` 22 copied-function tests (isConnectionError ×12, classifyWorkerExit ×6, reconnect ×2, supervisor counter ×2) | V | `src/core/minions/exit-classification.ts`: always `'clean_exit'` | 25 / 0 (file imports no `src/`; tests its own copies) | `test/exit-classification.test.ts` (real function) | 11 / 6 |
| `fix-wave-structural` › "parseOpArgs handles --no-<key>" | R | `src/cli.ts`: `params[positiveKey] = true` | fails (text pin) | `test/cli-args.test.ts` › "--no-<boolean> maps to false…" | 11 / 1 |
| `fix-wave-structural` › "exports classifyPgliteInitError + buildPgliteInitErrorMessage" | R | `src/core/pglite-engine.ts`: bunfs arm removed | 31 / 0 (blind) | `test/pglite-init-classifier.test.ts` | 27 / 6 |
| `worker-lock-renewal-shape` › "launchJob calls runLockRenewalTick" | R | `src/core/minions/worker.ts`: call site replaced, import kept | old shape file 17 / 1 | `test/worker-lock-renewal-e2e.serial.test.ts` › H "worker survives renewLock throws" | 0 / 1 |
| (same) note | — | same mutation | — | `scripts/check-worker-lock-renewal-shape.sh` (plan's named owner) | **rc=0 — misses it**: invariant 2 greps the whole file, so the import satisfies it. Owner is the serial behavior test above. |
| `dream-cli-flags` 9 `--source` + 5 `--once` pins | R | `src/commands/dream.ts`: bare `--once` guard unreachable | 27 / 1 | `test/dream.test.ts` › "runDream — --once (issue #2860)" | 40 / 5 |
| `book-mirror` 5 pins (export, trust comment, cost-estimate, idempotency, partial-failure) | V | `src/commands/book-mirror.ts`: child `idempotency_key: undefined` | 9 / 0 (strings survive in comments/help) | none needed; `allowed_tools` + `remote: false` pins kept; export owned by typecheck + CLI registration spawn tests | — |

## Doc pins

| Deleted test | Case | Probe edit | Result | Surviving owner | Owner result |
|---|---|---|---|---|---|
| `test/readme-hero-anchors.test.ts` (5) | V | lane probe P1 (meaning-preserving reword fails it); imports no product code | — | README links/commands/privacy owned by `docs-navigation`, `docs-cli-commands`, `check:privacy` | — |
| `test/docs-bootstrap-persistence-table.test.ts` (2) | V | `src/commands/hook.ts`: `GBRAIN_STOP_PUSH === '0'` check removed | 2 / 0 (blind) | `test/hook-command.serial.test.ts` › "GBRAIN_STOP_PUSH=0 disables the per-turn push" | pass at baseline → **fail** under mutant (10 other push-spawn cases fail at baseline in this sandbox; environment) |
| `test/docs-timeline-extraction-guide.test.ts` (2) | V | imports no product code; pins doc wording only | — | behavior: `test/extract.test.ts` | — |
| `docs-mcp-deploy` 7 doc-only pins | V | `src/commands/serve-http.ts`: nonce TTL 5 → 60 min | 9 / 0 (blind) | none (prose); route anchor test kept | — |
| `docs-mcp-deploy` › "auth help points at the owner login flow" | R (moved) | now asserts spawned `gbrain auth --help` output | — | `test/cli-help-discoverability.test.ts` › "auth help points at the owner login flow…" (new, 4 strings incl. "do not GET the generated link") | passes |
| `skillopt/deadline-and-hermetic` #4741 (2) | V | lane probe P5: reworded retracted claim passes | — | none (comment/doc wording) | — |
| 16 per-guard "wired into verify" tests (tool-catalog 1, no-tracked-symlinks 2, check-bootstrap-guards 5, privacy-script-wired 5, check-engine-dynamic-import 3) | R | `scripts/run-verify-parallel.sh`: all 7 target guards dropped from CHECKS | — | `test/scripts/run-verify-parallel.test.ts` › "every manifest guard is executed by verify or explicitly exempt" | 7 / 2, missing list names all 7 |
| (same) precondition | — | all 7 targets (`check-tool-catalog-fresh.sh`, `check-no-tracked-symlinks.sh`, `check-bootstrap-tag.sh`, `check-bootstrap-templates.sh`, `check-grok-pin.sh`, `check-privacy.sh`, `check-engine-dynamic-import.sh`) are `scripts/guards-manifest.tsv` rows; none is in `EXECUTION_EXEMPT` | — | — | — |
| "test.yml runs `bun run verify`" (privacy-script-wired) + "verify delegates to run-verify-parallel.sh" | R (moved) | `.github/workflows/test.yml`: verify step → `echo skipped` | — | `test/scripts/ci-gates.test.ts` › "the verify job runs `bun run verify`, which dispatches through run-verify-parallel.sh" (new) | 8 / 1 |
| 5 real-repo `checkResolvable` duplicates (resolver ×2, check-resolvable ×3) | R | `skills/RESOLVER.md`: row points at missing `academic-verifyx/SKILL.md` | resolver 152/2, check-resolvable 50/2 | `check-resolvable` › "repo skills/ pass check-resolvable cleanly" + `check:resolver` in verify | 48 / 1 |
| `ambient-recall-templates` › rendered template-repo HEARTBEAT pin | R | rendered copy only: `gbrain context-pack` → `gbrain ctx-pack` | 3 / 1 | `scripts/check-bootstrap-templates.sh` (verify) + `check-bootstrap-guards` › "check-bootstrap-templates.sh passes on this repo" | rc=1 / 46 / 1 |

## Cross-cutting patterns

| Deleted test | Case | Probe edit | Result | Surviving owner | Owner result |
|---|---|---|---|---|---|
| `regressions/v0.36.1.0-iron-rule` R1 | R | `src/core/think/prompt.ts`: anti-bias section always on | 6 / 1 | `test/think-with-calibration.test.ts` (R1 guards) | 9 / 2 |
| iron-rule R2 | R | `calibration-join.ts`: null profile returns a tag | 6 / 1 | `test/eval-contradictions-calibration-join.test.ts` | 12 / 1 |
| iron-rule R3 | R | `takes-resolution.ts`: quality=correct → outcome null | 6 / 1 | `test/takes-resolution.test.ts` | 20 / 2 |
| iron-rule R4, R5, inventory | V | `expect(true).toBe(true)` / self-comparison of a local literal; cites nonexistent `test/source-isolation-pglite.test.ts` | — | — | — |
| 4 "phase functions exported for unit testing" + `__testing` exports (v0_12_0, v0_12_2, v0_13_0, v0_21_0) | V + A (seam) | `v0_12_0.ts`: `phaseASchema` throws on entry | typeof probe passes (4 / 1 overall) | `migrations-v0_12_0` › "dry-run skips all side-effect phases" | fails; `__testing` had zero other callers (grep) |
| ~29 typeof / "module imports" probes in 16 files (enrichment-service 4, transcription 3, doctor 3, code-callers-cli 2 [whole file], cycle-abort 1, eval-whoknows 1, whoknows 1, salience 1, extract 1, migrate 1, v0_37_fix_wave 1, gateway-chat 2, operations-embedding-column 2, query-op-autocut 1, query-op-adaptive-return 1, agent-harness 4) | V | `src/core/transcription.ts`: `transcribe` throws on entry | old file 4 / 2 (3 probes still pass) | same file's behavioral tests; missing exports fail `bun run typecheck` (tsconfig includes test) | 1 / 2 |
| `v0_37_fix_wave` › "GBrainConfig includes voyage_api_key (TS compile guard)" | V | body never references the field; `expect(true)` | — | typecheck over real consumers | — |
| `schema-pack-manifest-v041_2` › AggregatorKind tautology | V | `count_based` renamed | tautology passes, 2 siblings fail | same file › "exposes exactly 4 v1 aggregator kinds", "accepts all 4 aggregator kinds" | 18 / 2 |
| `link-extraction-relative-path` › "flat layout unchanged…" (byte-identical duplicate) | R | `link-extraction.ts`: `founded` not inferred | 13 / 1 | `link-extraction-dir-whitelist-2576` › "verb inference works for non-whitelisted dirs" | 9 / 1 |
| `e2e/schema-cathedral` T22d block (2) | R | `artifact/index.ts`: `.gbrain-schema` unrecognized | 7 / 1 | `test/artifact-abstraction.test.ts` | 5 / 1 |
| `e2e/cjk-roundtrip` › "vector path skip-gracefully" | V | unconditional `expect(true).toBe(true)`, imports nothing | — | — | — |

## Seams

| Deleted | Case | Probe / evidence | Result | Surviving owner | Owner result |
|---|---|---|---|---|---|
| `_clearIdentityCacheForTest`, `_clearPromptStateForTest`, `_resetFactsDimCheckCacheForTest`, `_resetRerankWarningsForTest`, `clearRegistryForTests`, `_resetRollupErrorLogForTests` | A | grep of `src test scripts admin/src docs`: zero callers (only comments); typecheck green after removal | — | — | — |
| `PostgresEngine.__resetFactsEmbeddingCastCacheForTest` + `embedding-dim-check-facts` pin | A + V | zero callers; pin only greps the method name; key-files doc sentence removed | — | — | — |
| `backoff` › "_resetForTest clears module state" | V | `backoff.ts`: `_activeProcesses++` removed | seam test passes | same file: "concurrent process limit…", "complete decrements…", "preflight returns boolean" | 7 / 3 |
| `core/git-head` case 10 | V | real HEAD probe always `null` | 21 / 0 | `test/source-health.test.ts` | 30 / 3 |
| `resolvers` › "_resetDefaultRegistry gives a fresh instance" | V | reset made a no-op | only this test fails (58 / 1) — it tests the seam | — | — |
| `title-match` › `MIN_CONTENT_TOKENS` pin + `__test__` export | R | floor 2→3 and 2→1 | — | same file's positive/negative behavior tests | 11/2 and 12/1 |
| `checkDnsRebinding` wrapper + 3 tests | R | `ssrf-validate.ts`: static `isInternalUrl` layer dropped | wrapper test fails too | `test/ssrf-validate.test.ts` + `resolvers` › "blocks localhost via SSRF guard", "blocks RFC1918" | 15 / 5, and resolver real-path tests fail |
| `maybeWarnUnscopedDefaultWrite` wrapper | R (repointed) | 10 assertions now call `assessUnscopedDefaultWrite(...).warning`; mutation: tier check dropped | — | `test/source-resolver-default-write-guard.test.ts` | 21 / 6 |

## Placeholder guard: disposition of every reported site (12 at this base)

| Site | Disposition |
|---|---|
| `backoff.test.ts:33,50,52` | rewritten: infinite load/memory thresholds, escape hatches removed; mutation (`_activeProcesses++` removed) fails 3 tests |
| `seed-pglite.serial.test.ts:90` | rewritten: `expect(existsSync(dbPath)).toBe(true)` |
| `extract-stale.test.ts:100` | rewritten: seeded page stays unstamped and stale after an empty batch |
| `core/background-work.test.ts:135` | rewritten: `await expect(drain…).resolves.toBeUndefined()` |
| `operation-context-sourceid-required.test.ts:35,61` | allowlisted: assertion is `@ts-expect-error`, enforced by typecheck |
| `e2e/embedding-column-postgres.test.ts:29`, `e2e/upsert-chunks-registry-column.test.ts:552` | allowlisted: bodies of `describe.skip` markers, never execute |
| `e2e/graph-signals-eval.test.ts:225` | allowlisted: gate fails by throwing above the marker |
| `e2e/sync-credential-preflight.test.ts:111` | allowlisted: absent file is the correct outcome; other branch asserts contents |
| (deleted earlier in this slice) cjk-roundtrip, iron-rule ×2, `v0_37_fix_wave:252` | deleted with their tests |

## Pending integration (NOT deleted in this slice)

1. **`test/postgres-engine-singleton-ownership.test.ts`** — needs PR 1 item 7 (e2e-test-map entry) **and** unit rewrites for three properties the E2E owners miss. Probes against `postgres-engine-disconnect-idempotency`, `db-singleton-shared-recovery`, `postgres-reconnect-singleton`:

   | Property | Mutation | Unit pin | E2E owners |
   |---|---|---|---|
   | P1 db.connect borrower returns false | borrower returns true | fails | idempotency 3/2, shared-recovery 2/1 — **caught** |
   | P2a engine stores db.connect token | flag always true | fails | 3/2, 2/1 — **caught** |
   | P2b no TOCTOU pre-sample | `getConnection()` probe before `db.connect` | fails | 5/0, 3/0, 3/0 — **missed** |
   | P3 disconnect only when owner | unconditional `db.disconnect()` | fails | 3/2, 2/1 — **caught** |
   | P4 snapshot + null before awaiting end | end awaited before nulling | fails | 5/0, 3/0, 3/0 — **missed** |
   | P5 module reconnect never tears down shared pool | `db.disconnect()` before `db.connect` in module branch | **passes (unit pin blind)** | reconnect-singleton 2/1 — **caught** |
   | P6 instance reconnect `_reconnecting` guard | guard assignment removed | fails | 5/0, 3/0, 3/0 — **missed** |

   Still needed: keep or rewrite P2b, P4 and P6 as unit tests (P4 is the eng-named snapshot-and-null case), land the map entry, record the cadence exception, then delete.

2. **`test/embed-helper-migration.test.ts`** — needs PR 1 item 3 **and** replacements for two pins the surviving owners miss (embed.serial, embed-stale.serial, embed-stale-signature-pagination.serial, embed-stale-chunkless-pages.serial, embed-oversize-heal-drain.serial):
   - signal threading: removing `signal: effectiveSignal` from the stale-path pool → pin fails, all five owners pass (52/0, 23/0, 7/0, 15/0, 3/0).
   - `failureLabel` slug projector: removing it (pool falls back to `String(page)`) → pin fails, all owners pass. Note `embedOnePage`/`embedOneKey` catch their own errors, so `failures[]` is only reached if they throw; a behavior test would need to force a throw.
   - gap found: removing the embedAll path's `...(signal && { signal })` passes the pin AND every owner.
   Still needed: a barrier-transport abort test for the stale pool (and the embedAll pool), plus either a forced-throw failureLabel test or an explicit reachability disposition, then delete.

3. **`features` typeof probes** (`exports runFeatures`, `exports featuresTeaserForDoctor`, `covers all 7 recipes`) — needs PR 1 item 1. Probe: `runFeatures` throws on entry → `features.test.ts` 12/0 and `features-recipe-secrets.test.ts` 7/0 (all blind). Delete once the behavioral features tests land.

4. **`e2e/mcp.test.ts` "MCP server module can be imported"** — left for PR 3, which deletes the whole file.
