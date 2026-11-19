# Lane C: claimed coverage made real, evals, dead code (GBRA-47 W6 + W7)

Evidence for every test retirement (docs/TESTING.md "Retiring a test"), every
deletion, and the discriminating mutation of every new regression test or
guard in lane C. Probe edits were reverted after each run.

## Retirements and deletions

| Deleted / changed | Evidence case | Probe edit or reachability proof | Result | Surviving owner | Owner result |
|---|---|---|---|---|---|
| `test/eval-contradictions-fixture-redact.test.ts` with `src/core/eval-contradictions/fixture-redact.ts` and `scripts/build-contradictions-fixture.ts` | Intentionally abandoned contract | `git grep eval-contradictions/fixture-redact`: only the script (deleted with it), the orphan guard's permitted row and the test. The fixture it built (`test/fixtures/contradictions-eval-gold.jsonl`) was never committed; the script no longer typechecked. No docs, skills or `--help` promise it. | no runtime caller | none needed | n/a |
| `scripts/check-exports-count.sh` (guard) | Retained contract, stronger owner | `package.json`: remove the `./pglite-lock` export | guard rc=1 | `test/public-exports.test.ts` (exact `EXPECTED_EXPORTS` match, catches additions and renames too) | fails 4 of 52 |
| `scripts/check-pagetype-exhaustive.sh` (guard) | Vacuous | `PageType` is `string` since v0.38 (`src/core/types.ts`), so an exhaustive switch over it cannot exist; 0 `switch (x.type)` sites among `PageType` importers | guard could never fail | n/a (TypeScript narrowing on closed unions is the remaining tool) | n/a |
| `src/core/chunkers/semantic.ts`, `chunkers/llm.ts`, `search/keyword.ts`, `search/vector.ts` | Intentionally abandoned (hard orphans) | no importer in src/, test/, scripts/, evals/; not in package.json `exports` (28 subpaths; search exports are hybrid, expansion, evidence-delivery); no hit in `test/fixtures/goldens/` (export-surface golden), `recipes/` or `templates/` | orphan guard now 0 allowlisted | `search/hybrid` owns keyword and vector retrieval | n/a |
| `src/core/postgres-engine/forward-reference-bootstrap.ts` (facade) | Retained contract, import repointed | one importer, `test/e2e/postgres-bootstrap.test.ts`, now imports `src/core/engine-sql/bootstrap.ts` | n/a | `test/e2e/postgres-bootstrap.test.ts` | 13/13 pass against pgvector |
| `_resetJsonGuardForTests`, `_resetLockBusyLogCacheForTest` | Dead seams | `git grep -w`: definitions only | n/a | n/a | n/a |
| `scripts/fix-v0.11.0.sh`, `spike-bun-vm-timeout.ts`, `smoke-test-mcp.ts`, `bench-grandfather-5530.ts` | Finished one-offs | references: a ledger string literal in two tests (fixture data, kept), the redos-guard header (rewritten to current behavior), the refactor-wave-1 checklist (dated design record) | n/a | `test/redos-hardening.test.ts` pins that node:vm is gone | pass |
| `evals/skillopt-judge`, `evals/skillopt-reflect` | Abandoned (E2) | no reader in src/, test/, scripts/, CI; both failed every fixture (no gateway) | n/a | n/a | n/a |
| `evals/embedding-provider-eval.json` | Privacy (E4, D-11: no history rewrite) | zero readers; it named a real person | `check-fixture-privacy` failed on it once evals/ entered its scope | `check-fixture-privacy.sh` (evals/ + docs/test-audit/) | passes after deletion |
| `test/benchmark-search-quality.ts` | Broken, owned elsewhere (E5) | hard-coded 1536-d vectors; exits 100 on the 1024-d default | n/a | BrainBench CI gate (`scripts/ci-brainbench-gate.sh`) | n/a |
| `test/fixtures/brainstorm-eval.jsonl`; `setLiteral`, `doctorSourceFiles`, `normalizeSqlText` | Unreferenced | `git grep -w`: definitions only / no reader | n/a | n/a | n/a |
| `.gbrain-evals/eval-results.jsonl` | D-7 | gitignored and `git rm --cached`; the `--record` modes keep appending locally | n/a | n/a | n/a |

## New tests and guards: discriminating mutations

| Test / guard | Probe edit | Observed failure |
|---|---|---|
| `scripts/check-test-env-opt-ins.ts` (D7) | run on the pre-rename tree | 12 dead gates named: the compile smoke, 6x `GBRAIN_SKIP_SUBPROCESS_TESTS`, `GBRAIN_SKIP_LAUNCHD_E2E`, `GBRAIN_REQUIRE_LAUNCHD`, `GBRAIN_REQUIRE_COMPILE`, `GBRAIN_BASH32_REQUIRE`, `GBRAIN_ENFORCE_E5_BUDGET` |
| `test/operator-env-preload.test.ts` › "renamed test opt-in ... stops the run" | delete the RENAMED loop in the preload | exit 0 instead of 2, no rename line |
| `test/scripts/check-bash32.test.ts` › "refuses the pre-rename GBRAIN_BASH32_REQUIRE" | delete the old-name check in `check-bash32.sh` | exit 0 instead of 2 |
| compile smoke (`binary-self-update-compiled.serial`) | was gated off | now 1 pass (0.6s) instead of 0 pass 1 skip |
| `check-bash32.test.ts` real-parser cases | `GBRAIN_TEST_BASH32_REQUIRE=1` | 3 cases execute (were skipped under the stripped old name) |
| `bun run test:agent-voice` (D10) | add `'put_page'` to `READ_ONLY_OPS` in `recipes/agent-voice/code/tools.mjs` | 3 failures in `tools-allowlist.test.mjs` |
| `check:jsonb-params` over the real tree (F1) | append an `executeRaw('... $1::jsonb', [JSON.stringify(x)])` to `src/core/sql-query.ts` | rc=1 naming `src/core/sql-query.ts:159` |
| `check:image-decoders` (F2) | `avif_dec.wasm` -> `avif_dec_missing.wasm` in the smoketest import | rc=1 with the bun build error and Why/Fix (was a silent rc=1) |
| `check-skill-refs` stale allowlist (F10) | allowlist a clean file | `[stale-allowlist]` failure; the real tree's `skills/setup/SKILL.md` entry was stale |
| guard self-test fixtures (F9): fixture-privacy (bad, bad-evals, bad-test-audit), no-pii-in-agent-voice (bad, bad-path), skill-brain-first, batch-audit-site, gateway-routed (bad, bad-import), source-scope-onboard, trailing-newline | each bad tree | each guard exits non-zero; good trees pass; self-test 31 guards in 15s |
| scripts/ in typecheck (F3) | the tree before the fixes | 9 errors in 4 scripts |
| `test/docs-repo-paths.test.ts` (T7.3) | append a `scripts/check-exports-count.sh` reference to CONTRIBUTING.md | "CONTRIBUTING.md:621 names scripts/check-exports-count.sh, which does not exist" |
| `scripts/bench-graph-quality.ts` (V-10) | the pre-rewrite benchmark | 4 thresholds failed (link recall 0.500, precision 0.682, type accuracy 0.600, relational recall 0.400) on stale ground truth; after the rewrite all pass |

## Evals sub-lane (E1, E3, E8, E10)

| Test | Probe edit | Observed failure |
|---|---|---|
| eval-takes-bootstrap-harness › "classified and written" | `run-case.ts`: drop the `.md` write | `the extractor skipped the page (mirror_unavailable)` |
| same | `corpus.jsonl`: first case type -> `person` | `selected 0 pages; the case page must be the only eligible one` |
| eval-takes-bootstrap › "replay --max N" | `harness.mjs`: score against the full corpus | expected 0, received 1 |
| eval-takes-bootstrap › "per-variant and per-archetype" | `scorer.ts`: `v.pass = v.matched === v.expected` | fails |
| eval-run-all-outcome › "failed brainbench ... exit 1" | `eval-run-all.ts`: `return 0` | expected 1, received 0 |
| eval-run-all › "explicit --suites ... eval_suite_unwired" | remove `if (unwired) throw unwired` | expected 1, received 0 |
| takes-quality runner.serial › "unpriced ... without a cap warns and runs" | always throw for unpriced models | fails |
| runner.serial › "canonically priced ... under a cap"; pricing › "every canonically priced model"; model-pricing drift guard | canonical lookup only for the old 6 ids | all three fail |
| boundaries › "--budget-usd with unknown model -> no_pricing"; runner.serial › "unpriced ... under a user cap refuses" | remove the under-cap refusal | both fail |

| Changed test | Case | Surviving owner | Owner result under the probe |
|---|---|---|---|
| pricing › "retired gemini-1.5-pro is no longer in the allowlist" | Abandoned (E10: every canonically priced model is gateable) | pricing › "every canonically priced model is budget-gateable" | passes |
| pricing › "throws PricingNotFoundError on unknown"; estimateCost "throws on unknown" | Retained contract moved to the runner (refuse under a cap) | boundaries › "--budget-usd with unknown model -> no_pricing"; runner.serial › "unpriced ... under a user cap refuses" | both fail when the refusal is removed |
| pricing › "error message names the model AND points to the file" | Abandoned (pointed at the deleted allowlist) | pricing › "no_pricing refusal whose fix registers the rate" | n/a |
| pricing › "MODEL_PRICING table: finite positive rates" | Vacuous (table deleted) | `model-pricing.test.ts` › "every entry has finite positive rates" | n/a |

## Takes-bootstrap graduation run (D-6)

2026-10-04, `anthropic:claude-haiku-4-5`, all 123 variants of 41 archetypes,
estimate $0.23 under a hard $1 cap, actual $0.0935. Verdict: **not
graduated**; the autopilot tier stays `manual_only`.

| Kind | Expected / matched | Predicted / precise | Precision | Recall |
|---|---|---|---|---|
| fact | 42 / 32 | 70 / 50 | 0.714 | 0.762 |
| take | 33 / 32 | 47 / 42 | 0.894 | 0.970 |
| bet | 24 / 18 | 33 / 18 | 0.545 | 0.750 |
| hunch | 18 / 12 | 16 / 12 | 0.750 | 0.667 |

75 of 123 variants pass; overall precision 0.735, recall 0.803; 0 malformed;
3 forbid violations (press claims attributed to the page holder). Misses
split between classifier defects (bio facts, quotes and panel attributions
return no claims; press attribution leaks; one strong take typed as a bet)
and incomplete archetype labels (valid unlabeled claims count as imprecise).
Next: complete the labels per archetype, then fix bio-fact recall and
press-claim attribution, then rerun.

## Postgres arms and blind pins sub-lane (D8, D9)

### D8: unit-lane PostgreSQL arms

`scripts/check-postgres-lane-coverage.ts` (TS AST) found 167 test files outside
`test/e2e/` with a DATABASE_URL-gated arm (`testBackends()` loops and gated
`process.env.DATABASE_URL` reads included, not only arms that report `skip`).
111 were already covered, mostly by `test/e2e` `registerPostgresTests`
wrappers; two of the audit's seven (export-safety via
`test/e2e/export-snapshot-postgres`, symbol-resolver-projection-race via
`projection-recovery-parity`) were among them. 55 ran in no lane; they now run
in persistence-validation's `unit-postgres-arms` job (2 shards: 215 and 242
pass, 0 fail, 0 skip on a fresh pgvector database). One allowlist row:
`test/export-scale.slow.test.ts` (its 100,001-page arm passes but takes 527s).
One real failure, fixed: `persistence-memory-mutations` shared the
`gbrain_test` database and inherited another file's embedding width ("expected
1024 dimensions, not 1536"); it now uses `isolatedPersistencePostgres`.
Guard probe: removing a file from the workflow list fails the guard with the
exact fix line (`test/scripts/postgres-lane-coverage.test.ts`, 10 cases).

### D9: retired blind pins and their behavioral owners

| Deleted / changed test | Probe edit | Result | Surviving owner | Owner result |
|---|---|---|---|---|
| `test/fact-withdrawal-prepare-wiring.test.ts` › import-prepare row | `src/core/persistence/import-prepare.ts:198` `await ready.validate(tx)` -> `if (Date.now() < 0) await ready.validate(tx)` | pin passes 7/7 (blind) | `persistence-file-import` › "publication refuses a fact withdrawn between managed-import preparation and publication" (PGLite and Postgres) | fails (boundaries include `before_publication`, `before_file`) |
| same › sync row | disable validate at `sync-prepare.ts:415` | pin passes (blind); `persistence-sync-failures` also passes | `persistence-managed-sync` › "a fact withdrawn between sync preparation and canonical file writeback" | fails |
| same › connector row | disable validate at `connector-sync.ts:1057` | pin passes (blind); `google-attachment-backfill` also passes | `persistence-connectors` › "a fact withdrawn between bound connector preparation" | fails |
| same › reconcile row | disable validate at `reconcile-prepare.ts:106` | equivalent mutant (the preview's `withdrawals_digest` pin refuses first) | `persistence-reconcile` › "a fact withdrawn between reconciliation preparation" | fails with both the digest check and validate disabled |
| same › page-prepare and coordinator rows | page-prepare:394; coordinator:265 | pin passes (blind) | `withdrawal-publication-file`; two `persistence-file-import` cases | fail (1; 3) |
| same › sync code-file and rename rows | disable validate | equivalent mutants (code imports' validate is a no-op; `applyPrepared` repeats the rename check) | n/a | n/a |
| `think-save-source` pins | clear the save scope in `think.ts`, `ops/takes.ts`, `auto-think.ts` | pin passes 5/5 (blind) | `think-cli-source-flag.serial` (CLI `--save` x3, think op), `auto-think-phase` (scoped cycle) | each fails under its probe |
| `post-upgrade-banner` pin | `upgrade.ts:819` `if (Date.now() < 0) console.log(line)` | pin passes (blind) | `post-upgrade-banner` › real `foresights post-upgrade` CLI block on a brain with findings | fails |
| `autopilot-operator-pause` pins | disable worker gate 1 (`worker.ts:830`), gate 2 (`:894`), shadow the daemon's `autopilotPaused` | pin passes each time (blind) | in-process worker parks then runs after resume; released-un-run job claimed as the pause lands; spawned daemon reports the pause and resumes | each fails under its probe |
| `embed-concurrency-pool-clamp` pins | `workers: Number(process.env.GBRAIN_EMBED_CONCURRENCY ?? 20)` at `embed.ts:1378` and `:2100` | pin passes 4/4 (blind) | `embed.serial` #5183 case (pool 3, both loops) | fails under each |
| `consent` source pin (~195) | extra argv on the post-upgrade `applyMigrations` call | pin passes (blind) | `upgrade-no-autopilot.serial` › "post-upgrade passes the opt-out to migrations"; the pin became a direct consent-matrix assertion | fails |
