> Appendix to [../gbrain-evals.md](../gbrain-evals.md). Detailed per-area notes from one research pass over gbrain-evals `cd447b3` (v0.10.237) and gbrain `6ce7195`. Paths are relative to the gbrain-evals root unless marked `gbrain:`. "G1" to "G10" in the text name the appendix files listed in the main map.

# G9: package scripts, CI, scripts/, test/, rules (gbrain-evals)

Checkout: the gbrain-evals checkout (HEAD cd447b3, v0.10.237, 2026-11-16). Read only. No bun install, no paid or keyed runs.
Pins at this HEAD: gbrain 6ce7195 (v0.60.733.0), gbrain-cues 939232f, gbrain-reader e78f1c3.

## Key findings

1. CI is keyless. `.github/workflows/ci.yml` and `links.yml` reference no `secrets.*` (grep, zero hits). CI runs the offline tier only.
2. CI installs gbrain as a TypeScript package, not a binary: `bun install --frozen-lockfile` pulls `github:garrytan/gbrain#6ce7195` and its `bin` is `src/cli.ts` (run under Bun). The pinned gbrain has no postinstall or prepare script.
3. In-process coupling is wide: 35 test files import gbrain directly (32 in test/eval); 333 of 418 test/eval files reach gbrain through relative imports (static analysis, see section 4). About 2,133 of 2,289 serial test seconds sit in those files.
4. A pure, gbrain-free test subset exists: 48 files (44 in test/eval plus 4 colocated under eval/) that import nothing from gbrain and do not spawn processes, touch a DB, or read keys. They total about 26 s of serial test time. 43 more gbrain-free files spawn processes, use PGLite, or read keys (about 129 s).
5. Three process-level gbrain couplings already exist: `MPW_GBRAIN_CLI` (node_modules/gbrain/src/cli.ts), `GBRAIN_BIN` (eval/systems/gbrain-defaults/shim.py:62), and `--gbrain <checkout>` overlays. No Rust plan, binary adapter spec, or `system under test` contract is written anywhere in the docs (see section 7).

## 1. package.json scripts

Tier key: offline = keyless, no network (CI-safe). keyed = needs provider keys and is below $1/run per registry. paid = provider spend, needs `--paid --budget-run-id <id>` and an open ledger run (eval/runner/paid-arm.ts). "$0" means no provider call.

| Script | Runs | Tier | LLM keys | Notes |
|---|---|---|---|---|
| test | test-shards.ts, then test:py, then validate | offline | none | Full local gate |
| test:unit | `bun scripts/test-shards.ts` | offline | none | 4 shards by default (TEST_SHARDS) |
| test:serial | `bun test test/eval/ eval/` | offline | none | Single process |
| test:py | `python3 test/retrieval_refresh_orchestrator_test.py` | offline | none | Python orchestrator tests |
| validate | verify-published-longmemeval.py, verify-longmemeval-opaque-qa/followups.py, verify-documentation-refresh.py, check-links.py, eval:query:validate, validate-data.ts, scoreboard check, check-comparator-name.ts | offline | none | Keyless recounts of committed receipts |
| typecheck | tsc --noEmit (8 GB heap) plus tsconfig.scripts.json | offline | none | CI runs it unfiltered |
| eval:run | `bun eval/runner/multi-adapter.ts` | mixed | adapter-dependent | grep-only is keyless; vector adapters call embedding providers |
| eval:run:dev | same with BRAINBENCH_N=1 | mixed | adapter-dependent | |
| eval:decide | eval/runner/decide.ts | mixed | preflight checks keys | Subcommand list in its header; not read in full |
| eval:scoreboard | scoreboard-cli.ts | mixed | per subcommand | check, fixture, explain, doctor, plan, smoke, status, render are $0 (fixture uses stub judge); run, judge, dispute are paid |
| eval:world:view | eval/cli/world-view.ts | offline | none | Opens browser |
| eval:world:render | world-view.ts --no-open | offline | none | |
| eval:query:validate | eval/cli/query-validate.ts | offline | none | CI validate step |
| eval:query:new | eval/cli/query-new.ts | offline | none | Scaffolds a query |
| eval:type-accuracy | eval/runner/type-accuracy.ts | unknown | unknown | Not read in full |
| eval:brainbench | `all.ts --tier offline` | offline | none | 46 H-tier categories; CI runs it in 3 shards |
| eval:brainbench:paid | `all.ts --tier paid` | paid | yes | K and P categories; refuses without --paid and --budget-run-id |
| eval:brainbench:all | `all.ts --tier all` | paid | yes | H+K+P |
| eval:brainbench (CLI args) | --shard k/n, --only ids | offline | none | |
| eval:cat6 | cat6-prose-scale.ts | offline | none | Header: no DB, no LLM, no embeddings |
| eval:cat11 | cat11-multimodal.ts | offline by default | optional | GROQ or OPENAI key only for a real transcriber |
| eval:cat35 | `CAT35_FULL=1 cat35-transcript-distill.ts` | paid | yes | Full corpus (24 transcripts x 3 lanes); RUNBOOK pre-flight $53.40; refuses without --budget-usd |
| eval:cat35:smoke | cat35 default (2 transcripts) | paid | yes | Pre-flight $3.24 (cat35 header) |
| eval:cat36 | cat36-associative-retrieval.ts --offline | offline | none | |
| eval:cat36:smoke | same with --smoke | offline | none | |
| eval:mpw:power | memory-proof-wave-power.ts simulate | offline | none | Power simulation |
| eval:mpw:grouping | memory-proof-wave-grouping.ts check | offline | none | |
| eval:system-one | system-one-jev.ts verify | offline | none | Hermetic, "No gbrain, key or network" (header) |
| eval:system-one:plan | system-one-jev.ts plan | offline | none | Prints plan |
| eval:generate-amara-life | amara-life-gen.ts | offline | none | Templated, no LLM (header) |
| eval:generate-amara-life:dry | same with --dry-run | offline | none | |
| eval:generate-transcript-distill | transcript-distill-gen.ts | keyed on cache miss | yes | Cache hit = zero spend; cache in eval/data/transcript-distill-v1/_cache |
| eval:generate-transcript-distill:dry | same with --dry-run | offline | none | |
| harness:setup | eval/runner/harness-env.ts | offline (network) | none | Fetches pinned agent-memory-benchmark, builds CPU venv via uv |
| harness:test | eval/runner/harness-test.ts | offline | none | Python wrapper tests against local stubs |
| harness:cell | eval/runner/harness-cell.ts | unknown | unknown | Runs a harness cell; check flags before use |
| harness:comparator | eval/runner/harness-comparator.ts | unknown | unknown | |
| eval:passing-details (+ :smoke, :dry) | workload-suites/cli.ts passing-details | offline | none | Default run reads no key; --dry-run prints the paid plan |
| eval:corrections (+ :smoke, :dry) | workload-suites/cli.ts corrections | offline | none | Same pattern |
| eval:time-relationships (+ :smoke, :dry) | workload-suites/cli.ts time-relationships | offline | none | Same pattern |
| eval:beliefs (+ :smoke, :dry) | workload-suites/cli.ts beliefs | offline | none | Same pattern |
| eval:workload-suites | workload-suites/cli.ts all | offline | none | Generates, checks, compares manifest |

Counts: 49 scripts in package.json. The table groups the `:smoke` and `:dry` variants and the CLI-argument forms onto shared rows. Runtime is unknown for most; on 2026-10-23 the unsplit CI offline tier took about 800 s of a 900 s bound, which is why it was split into three shards (ci.yml:138 comment).

## 2. CI

### 2a. ci.yml

Triggers: `pull_request` (all branches) and `push` to `main`. Permissions block: none. Concurrency: none. Secrets: none.
Actions are pinned to SHAs. Bun is pinned to 1.4.4 via oven-sh/setup-bun. Installs use `bun install --frozen-lockfile` in every job.

| Job | Needs | Timeout | Matrix | What runs | Gbrain install and use |
|---|---|---|---|---|---|
| git-cache | none | 20 min | none | Saves full .git to actions/cache, key `git-objects-v1-<sha>` | none |
| checks | git-cache | 20 min | none | `bun run typecheck`, `python3 test/retrieval_refresh_orchestrator_test.py`, `bun run validate`, `bun scripts/generate-v0.41-launch.ts --check` | `bun install` pulls gbrain at pin; typecheck covers dependency sources |
| brainbench | git-cache | 20 min job, 900 s command | shard 1,2,3 | `BRAINBENCH_ALLOW_SKIP=1 BRAINBENCH_BOUND_S=900 timeout 900 bun run eval:brainbench --shard k/3` | all.ts runs each category as a Bun subprocess; N1 and N5 CI slices run on PGLite through the gbrain CLI (comment, ci.yml:139) |
| prereg-order | git-cache | 5 min | none | `bun eval/runner/prereg.ts` (preregistration commit order) | none |
| tests | git-cache | 15 min | shard 1..6 | `bun test --shard=k/6 --timings=test/timings.json test/eval/ eval/ --reporter=junit`; installs ripgrep via apt | in-process gbrain via tests |
| tested-tree | checks, tests | 5 min | none | `bun scripts/ci-tested-tree.ts record` (writes tree.json artifact) | none |
| scoreboard | git-cache | 10 min (timeout 300 on the step) | none | `bun run eval:scoreboard fixture --stub judge-repeat --json` | keyless fake provider, metering proxy in lease mode |
| receipt-secrets | git-cache | 5 min | none | `bash scripts/scan-receipts.sh` (gitleaks, pinned version and sha256) | none |
| harness | git-cache | 30 min | suite: pytest, proxy | `MPW_REQUIRE_HARNESS=1`; `bun run harness:setup` then `harness:test` (pytest) or `bun test test/eval/harness-metering-proxy.test.ts test/eval/harness-cell.test.ts test/eval/harness-cell-e2e.test.ts` (proxy) | harness-cell tests spawn gbrain CLI |

Shard counts: tests 6, brainbench 3, harness 2. Upload artifacts on failure: eval/reports/ (14 days). tested-files-N uploaded for tested-tree (7 days).

Runtime facts stated in ci.yml comments: a brainbench job took about 800 of 900 s on 2026-10-23 (ci.yml:138). The harness setup took up to 23 min on 2026-11-03 when unpacking a 700 MB commit (ci.yml:353). The pytest job takes about 6 min and the proxy job about 2.5 min (comment).

### 2b. Caching

| Cache | Key | Used by |
|---|---|---|
| .git objects | `git-objects-v1-<github.sha>`, restore-keys prefix | every job; git-cache saves on push or on a PR's first run |
| harness pack (.harness/packs) | `harness-pack-v1-<hash of eval/harness-provider/harness.lock.json>` | harness job |
| bun node_modules | none | not cached; each job reinstalls |

The `.git` cache is a documented workaround for slow GitHub packs (ci.yml:12-30). Without it, tests that look for a pinned commit skip (test/eval/q1-reuse-check.test.ts, five cases).

### 2c. links.yml

Triggers: weekly `cron: "17 6 * * 1"` (Monday 06:17 UTC) and `workflow_dispatch`. One job, `external-links`, timeout 10 min. Runs `python3 scripts/check-links.py --external`. HTTP 401, 403, 429 are warnings, not failures. No keys.

### 2d. Install mechanics

- root package.json: no `trustedDependencies` field. `patchedDependencies` has one entry, `postgres@3.4.9` -> patches/postgres@3.4.9.patch (adds cancel-message fields to cjs/src/connection.js; 27 KB patch).
- gbrain pin (`git show 6ce7195:package.json`): bin `gbrain` -> `src/cli.ts`; `scripts` has no postinstall, preinstall, install or prepare; its own `trustedDependencies` is `["@electric-sql/pglite"]`. Bun reads trustedDependencies from the root package, so that list has no effect here (per Bun's documented behavior, not verified by running).
- bun.lock: three gbrain entries, each a full GitHub package with its own @ai-sdk/* and other dependencies: gbrain@6ce7195, gbrain-cues@939232f, gbrain-reader@e78f1c3 (lines 261-265). Install therefore fetches gbrain from GitHub three times.
- Engines: gbrain requires bun >=1.4.4 (matches CI).

## 3. Repo config files

| File | Content |
|---|---|
| bunfig.toml | `[test] preload = ["./test/support/no-provider-keys.ts", "./test/support/pglite-snapshot.ts"]`. Keys blanked, GBRAIN_HOME set to a temp dir; PGLite snapshot reused per (schema hash, model, dims). |
| tsconfig.json | ESNext, bundler resolution, strict, `noEmit`. Includes eval/**, test/**, types/**. paths: @jsquash/png/encode.js -> types/jsquash-png-encode.d.ts |
| tsconfig.scripts.json | extends tsconfig; includes scripts/**/*.ts only |
| types/ | ambient shims for Bun text imports and untyped modules (CI comment) |
| patches/ | postgres@3.4.9.patch only |
| VERSION | 0.10.237 |
| changelog.d/ | README.md only; no pending fragments |

## 4. test/ (475 files, 8.6 MB)

### 4a. Structure and sharding

| Path | Files | Notes |
|---|---|---|
| test/eval/*.test.ts | 418 | Flat directory; includes helpers batch-fake-provider.ts, cat40-loop-driver.ts, no-provider-keys-gbrain-source etc. |
| test/eval/fixtures/ | 7 subdirs | hedge, p8-quote-grounding, q1-cell, scoreboard (shootout), wild-cluster |
| test/fixtures/ | 15 subdirs | cat40-hard, failure-causes (cat40, live-recall, nightly, partc, rs1, skillopt), refresh-barrier, rs1, sota, no-provider-keys |
| test/support/ | 4 | no-provider-keys.ts, pglite-snapshot.ts (imports gbrain/pglite-engine, gbrain/ai/gateway, gbrain/core/defaults), evidence-delivery-fixture.ts, failure-causes-fixture.ts |
| test/retrieval_refresh_orchestrator_test.py | 1 | Python |
| test/timings.json | 1 | 402 entries, ms per file |
| colocated eval/**/*.test.ts | 6 | eval/runner/queries/validator, chronicle-lift, adapters/grep-only, adapters/vector, eval-adapter-config, generators/world-html |

Sharding:
- `scripts/test-shards.ts` (local): spawns N concurrent `bun test --shard=i/N --timings=test/timings.json` processes; N = TEST_SHARDS or min(4, CPU). Avoids `bun test --parallel` (hang observed on Bun 1.3.14, per comment).
- CI: six `bun test --shard` jobs with the same timings file; files split by measured time. A file missing from timings counts as median. Refresh timings with `scripts/test-timings.ts` from tested-files-* JUnit artifacts (its header lists the gh commands).
- Timings: 402 files, 2,289 s total serial (about 38 min). Largest: test/eval/predictive-cli-arm.test.ts 318 s, skillopt-method-probe 115 s, live-recall-tasks 81 s, predictive-g6 71 s, situation-recall-openrouter 65 s. Six files exceed 60 s. Six shards at ideal balance is about 6.4 min each, inside the 15 min job bound.

### 4b. Which tests import gbrain in-process

Direct imports (regex `from 'gbrain…'`, `gbrain-cues/…`, `gbrain-reader/…`, `node_modules/gbrain/…`): 35 files (32 under test/eval, 1 under test/fixtures/no-provider-keys, 2 under test/support). Specifiers and counts across test/:

| Specifier | Count of import lines |
|---|---|
| gbrain/ai/gateway | 12 |
| gbrain/pglite-engine | 10 |
| gbrain/types | 5 |
| gbrain/core/skillopt | 5 |
| gbrain/config | 5 |
| gbrain-reader/eval/longmemeval/reader | 3 |
| gbrain/search/hybrid | 2 |
| gbrain/operations | 2 |
| gbrain/engine | 2 |
| gbrain/link-extraction, gbrain/import-file, gbrain/ai/invocation-guard | 1 each |
| gbrain-reader/ai/invocation-guard, gbrain-reader/ai/gateway | 1 each |
| gbrain-cues/types, gbrain-cues/pglite-engine, gbrain-cues/operations | 1 each |

Also: test/support/evidence-delivery-fixture.ts and pglite-snapshot.ts import `../../node_modules/gbrain/src/...` relative paths (sanitize.ts, metrics.ts, defaults.ts), so they depend on gbrain's source layout, not only its exports.

Transitive reach (static analysis, relative imports followed, 418 test/eval files): 333 reach a gbrain import; 85 do not. This is an approximation: it ignores dynamic imports and bare specifiers other than gbrain. The 85 break down as 44 with no spawn, DB, PGLite or key tokens and 41 with one or more of those tokens. The 6 colocated eval/ tests import nothing from gbrain directly; 4 have no tokens and 2 (eval/runner/chronicle-lift.test.ts, eval/runner/adapters/vector.test.ts) do.

Across eval/, scripts/ and types/ together, 114 files import gbrain (mostly eval/runner/*.ts). That is outside this scope; G1 covers it.

### 4c. Tests that need a DATABASE_URL, keys, or processes

| Signal | Count | Notes |
|---|---|---|
| Reference to DATABASE_URL under test/ | 12 files | live-recall*, situation-recall-*, nightly-smokes, longmemeval-answers, cat36-grounded-answers, wave-step0, predictive-scale-latency. Gate behaviour per file not verified. |
| Reference to a *_API_KEY name | 102 files | Preload blanks every provider key (test/support/no-provider-keys.ts, list lines 17-24), so such tests cannot reach a provider; they need a skip or a placeholder. |
| Skip gates (skipIf, .skip, LIVE/RUN_PAID env) | 41 files | |
| Spawns a process (Bun.spawn, spawnSync, execFile, child_process) | 156 files | Includes harness and CLI tests |
| Uses PGLite / pglite | 50 files | PGLite snapshot preload makes these fast |
| CI-only real-provider tests | none found | No test calls a provider without a skip or a stub |

Known spawns of the gbrain CLI from tests or runners (candidates to point at a binary): harness-cell.ts:448, :590 (`MPW_GBRAIN_CLI` = `src/cli.ts`); coding-spike.ts:158; workload-suites/bench-infra.ts:89; harness-provider/mpw/gbrain_provider.py:295 (`gbrain_cli` or `MPW_GBRAIN_CLI`); harness-provider/tests/test_gbrain_provider.py:26 and test_gbrain_facts.py:26 (run real gbrain from node_modules); eval/systems/gbrain-defaults/shim.py:62 (`GBRAIN_BIN`, default `gbrain`). A rg for `src/cli.ts|MPW_GBRAIN_CLI|gbrain serve|mcp` matches about 36 test files (an upper bound: it includes fixtures and timings.json). Main ones are cat40-*, predictive-*, gbrain-defaults*, harness-metering-proxy, cat41-agent-operator, lifecycle-experiment, refresh-barrier.

### 4d. Pure tests that survive a gbrain-to-binary swap unchanged

The 48 files that import nothing from gbrain and have no spawn, DB, PGLite or key tokens (static check on the file text):

test/eval: adversarial-injections, amara-life-gen, amara-life, bg1-loader, cat35-checks, cat40-firing, ci-workflow, docs-pin-claims, evidence-delivery-decision, evidence-delivery-power, fence-repair-tier3-recount, lhf-wave-2-attendance-gate, lhf-wave-lme-analysis, lifecycle-free-port, living-pages-breakeven, memory-proof-wave-dev-power, memory-proof-wave-power, memory-qa-event-time, metrics, n2-a4-generators, n9-multihop-gen, name-guard, nightly-judge-cache, power-pw, predictive-core, predictive-verdict, program-primary, q1-instruments, q1-power, queries-tier-sets, readdir-determinism, reading-notes-recount, receipts-manifest, recorder, refresh-barrier-adjudicate, render-v2-recipe, schemas, sealed-qrels, sota-answerability, sota-scorecard, temporal-edges-gen, test-timings, transcript-distill, wild-cluster (all `.test.ts`, with `test/eval/` prefix).

colocated: eval/runner/queries/validator.test.ts, eval/runner/adapters/grep-only.test.ts, eval/runner/eval-adapter-config.test.ts, eval/generators/world-html.test.ts.

Caveats: these files may read fixtures that embed gbrain output, and tests that feed gbrain output through a runner would need a binary-produced fixture instead. A pure file that reads a shared fixture is still a pure test. Runtime of the 48 is about 26 s serial, roughly 1 percent of the suite. The 41 pure-with-tokens files (about 129 s) include the gbrain-defaults*, harness-*, lifecycle-*, memory-qa-*, and q1-* tests, which spawn or use a DB and are not in the clean set.

Tests that stay valid only with an in-process gbrain: the 32 direct importers in test/eval plus the 301 other gbrain-reaching files that call runners that import gbrain (for example cat40-*, situation-recall-*, skillopt-method-*). A binary adapter needs an adapter layer under these runners, not a change in the test body.

Test runtime summary: gbrain-reaching files 2,133 s serial; pure-with-tokens 129 s; clean pure 26 s; 22 test files lack a timing entry (18 gbrain-reaching, 4 pure).

## 5. scripts/ (34 entries, incl. ubicloud/)

| Entry | Purpose | Inputs | LLM | Cost / time |
|---|---|---|---|---|
| RUNBOOK_SHOOTOUT.md | Shootout phase guide (doc) | none | n/a | n/a |
| cat40-followups.sh | Paid steps of the Cat 40 follow-up campaign, SQLite ledger capped at $237 | step name | yes (paid) | paid, ledger-gated |
| cat40-hard.sh | Operator script for Cat 40 Hard (hello, status, paid steps) | step name, world | yes on paid steps; hello is $0 | hello $0 |
| check-comparator-name.ts | Fails if comparator product name appears outside docs/comparison-systems.md | git-tracked files | no | $0, CI validate |
| check-links.py | Markdown link and anchor check (local; --external fetches URLs) | repo | no | $0 local; external weekly |
| ci-tested-tree.ts | Records tree.json for gstack carry from JUnit reports | junit dir | no | $0 |
| correct-historical-chart-labels.py | Redraws historical charts (matplotlib) | committed summaries | no | $0 |
| finding-particle-w10b.py | Keyless recheck of the particle-1 W10b finding | committed rows | no | $0 |
| generate-v0.41-launch.ts | Regenerates baselines/v0.41-launch.baseline.ndjson; CI runs with --check | qrels, PGLite | no | $0; CI checks job |
| make-decision-splits.ts | Writes eval/decisions/splits/*.json (conversation ids only), --check | eval/decisions | no | $0 |
| model-freshness.ts | Checks provider model lists (free metadata endpoints) and prices before a paid run | provider keys, --models | reads lists only | free; needs provider keys; not in CI |
| nightly-export.sh | Exports files a nightly gbrain check needs to a dest | repo | no | $0 |
| nightly-vm.sh | Bootstrap of an Ubicloud Ubuntu 24.04 VM for the nightly check (Bun, python3, Docker pgvector images pinned by digest) | GBRAIN_DIR, BUN_VERSION | no (runs nightly command) | VM cost, not measured |
| particle-canary.ts | Paid canary: 12 fixed probes to particle-1 to detect weight changes | PARTICLE key, --paid --budget-run-id | yes (paid, opt-in) | paid; out-of-CI |
| plot-retrieval-refresh.py | SVG figures from the refresh summary (matplotlib) | docs/benchmarks/2026-09-09-retrieval-refresh | no | $0 |
| refresh-barrier-b1-guard.ts | Runs a command under an idle-machine load guard (Amendment 5) | --out, command | depends on the command | none itself |
| refresh-barrier-partc-adjudicate.ts | Part C adjudication of refresh-barrier results (Amendment 3) | run outputs | no | $0 |
| retrieval-usage.ts | Bun preload for the fixed retrieval refresh; budget reservation before each HTTP call | env | embeddings and rerank APIs (OpenAI, Voyage) | paid, per-request $ caps |
| run-retrieval-refresh.py | Runs the fixed documentation-refresh matrix ($25 reservation per process) | matrix | yes (embedding and rerank) | paid; $25 per process reservation |
| run-shootout-phase1.sh | Embedder shootout phase 1: 4 LongMemEval cells via `gbrain eval longmemeval` | env per cell | yes | paid |
| run-shootout-phase2.sh | Embedder shootout phase 2: 4 BrainBench cells (header says wrapper lacks driver, TODOS) | env | yes | paid |
| scan-receipts.sh | gitleaks over receipts, pinned by version and sha256 | docs/benchmarks, results, baselines, qrels | no | $0; CI receipt-secrets |
| sealed-confirmation-overlap.py | Overlap audit: sealed set vs LongMemEval S/M and existing data | private sealed files | no | $0; private inputs |
| summarize-retrieval-refresh.py | Derives comparison tables from fixed matrix cells | cell outputs | no | $0 |
| test-shards.ts | Runs the Bun suite as N concurrent shards | TEST_SHARDS | no | local |
| test-timings.ts | Writes test/timings.json from JUnit reports | dirs of tested-files-* | no | $0 |
| verify-a6b-rename.py | Checks Amendment A6b rename changed no numbers | base commit, manifest | no | $0 |
| verify-documentation-refresh.py | Protected bytes, tested prompt fences, links and anchors | docs | no | $0; in validate |
| verify-longmemeval-opaque-followups.py | Keyless recount of 2026-10-04 opaque-id follow-ups | committed receipts | no | $0; in validate |
| verify-longmemeval-opaque-qa.py | Keyless recount of the 2026-09-29 opaque-id answer receipts | committed receipts | no | $0; in validate |
| verify-published-longmemeval.py | Recounts saved LongMemEval retrieval outcomes | docs/benchmarks/2026-09-06-longmemeval-ranker-wave | no | $0; in validate |
| w11-packet.ts | Builds two HTML review packets (chronicle, cat35) | output dir | no | $0 |
| w11-score.ts | Scores a returned W11 review export offline | export JSON | no | $0 |
| ubicloud/ubi-runner.sh | Runs a command on an ephemeral Ubicloud VM (create, stream checkout, run, pull, destroy); needs UBICLOUD_API_KEY, ssh | command, setup script | depends on command | VM cost; needs UBICLOUD_API_KEY |

Count check: 34 entries in scripts/ (33 files plus the ubicloud directory). The table lists 31 rows; cat40-followups and cat40-hard are separate rows, and ubicloud is one row.

Scripts that call gbrain: nightly-vm.sh (clones/builds GBRAIN_DIR), run-shootout-phase1.sh (gbrain eval longmemeval CLI), verify-documentation-refresh.py (gbrain-cues alias comment), generate-v0.41-launch.ts (in-process PGLite plus gbrain bench publish), refresh-barrier-b1-guard.ts (runs a command, typically a gbrain CLI check).

## 6. Rules that govern runs (AGENTS.md, CLAUDE.md, eval/RUNBOOK.md, eval/CONTRIBUTING.md, README, TODOS)

Who may run paid tiers
- Paid runs need the user's authorized budget: "Use the task's authorized budget and scope" (CLAUDE.md, Running and publishing).
- Registry tiers (eval/registry.ts:41-47): H = hermetic, no key, runs in CI; K = keyed, under $1 per run from a measured receipt; P = paid publication run or keyed run with unmeasured cost. none = cannot run.
- all.ts paid guard: a selection with any K or P entry refuses without `--paid` and `--budget-run-id <id>` (eval/runner/all.ts header; paid-arm.ts).
- Ledger: every request to a paid host is reserved before send, including SDK retries; SQLite at .budget/ledger.sqlite (gitignored) (RUNBOOK.md:37-46; docs/budget-ledger.md). The ledger never refunds reservations (run-retrieval-refresh.py header).
- Refusal: LongMemEval, Cat13 and Cat35 refuse provider requests until `--budget-usd` or BRAINBENCH_BUDGET_USD is set (RUNBOOK.md:37).
- A stale ledger lock is cleared only by the person running the campaign (RUNBOOK.md:60). Do not clear it by hand.

Sealed sets
- Sealed confirmation v1 and v2: private labels. `sealed-confirmation.ts validate|run|answer` never read labels; `score` and `solvability` require the private labels path (RUNBOOK.md:175-177). Opening is capped: TODOS says at most three opens (plan amendment 1) and a first release preregistration is still open.
- The sealed set is not in CI and no keyless run reads its labels.

Preregistration
- Write the question, lesson, comparison and decision rule before running (CLAUDE.md step 1, "Running and publishing work").
- docs/benchmarks/preregistrations.json (3 entries, dict) is checked by `bun eval/runner/prereg.ts` in CI prereg-order: each preregistration must be committed before its results (ci.yml:168-185).
- Promotion rules must be preregistered in the same commit as a registry row, before the first counted run (eval/CONTRIBUTING.md:177).
- A preregistered gate keeps its model list unless the change is recorded in the preregistration before new cells run (CLAUDE.md "Choose models").
- Changing a counted gbrain build is a new run; a new run measures gbrain's newest release at launch; the build freezes once counted runs start (CLAUDE.md "Choose the gbrain build"). `bun eval/runner/gbrain-pin.ts bump` moves the pin.

Models and judges
- Primary models: claude-opus-5-5 and particle-1 (CLAUDE.md "Choose models"). Frontier GPT: gpt-6.1-sol. Sonnet and Haiku are not models under test. Fable only in smoke tests. Older generations not run. gpt-5.4-mini is not run.
- particle-1 never judges a counted cell. Judges stay protocol-matched (gpt-4o-2024-08-06 for LongMemEval, gpt-6.1-sol for Cat 40 Hard).
- No model judges its own family's rows.

Evidence and publication
- Name the denominator; compare matching conditions; separate control from capability; keep provenance; disclose missing evidence (CLAUDE.md "Evidence rules").
- Do not regenerate corpora to improve a score (CLAUDE.md).
- Do not publish program totals or spend in public docs, except where cost is the lesson (CLAUDE.md line 52).
- A pull request never edits VERSION, package.json version or released CHANGELOG sections; it adds changelog.d/<slug>.md (CLAUDE.md "Versions and the changelog").
- Only the user authorizes pushing, merging or publishing: "This guide does not authorize pushing, merging or publishing" (CLAUDE.md).

Testing against a non-TypeScript system or a binary
- No rule forbids a binary. The repo's own harness already talks to gbrain through its CLI: MPW_GBRAIN_CLI = node_modules/gbrain/src/cli.ts (eval/runner/harness-cell.ts:448; eval/harness-provider/mpw/gbrain_provider.py:295). CLI is run under Bun, so the "binary" is a TypeScript entry point.
- The test rule against unintended providers is enforced in-process by the preload (test/support/no-provider-keys.ts).
- AGENTS.md and CLAUDE.md do not mention Rust, a binary adapter, or GBRAIN_BIN (grep).

Other documents
- eval/RUNBOOK.md: budgets, Cat 35 cost defaults (CAT35_HARD_STOP_USD default $40; full run projection $53.40, RUNBOOK.md:117), Cat 40 Hard exit codes (3 with stable codes), sealed confirmation, Cat 36 offline vs live profiles (RUNBOOK.md:181-258).
- eval/CONTRIBUTING.md: add-a-category checklist (registry row, preregistered promotion rules, shared flags `--seed`, `--output`, `--gbrain <checkout>`, `--paid --budget-run-id` through requirePaidArm and startPaidRun, measure hermetic run time under 60 s target).
- README.md Quick start (lines 373-400): no keys, makes no model calls; `BRAINBENCH_N=1 bun eval/runner/multi-adapter.ts --adapter grep-only`.
- eval/README.md "Start with a free check" (lines 11-31): keyless checks.

## 7. Rust port, binary adapter, system-under-test: existing plans

Search: `rg -i` over the repo (excluding docs/benchmarks and CHANGELOG) for "rust", "binary adapter", "--binary", "GBRAIN_BIN", "system under test", "cargo", "crate", "non-typescript".

Result:
- No Rust plan, no Rust, cargo or crate reference outside uv.lock files for the comparison-system Python packages (py-rust-stemmers, under docs/comparison-systems/*/uv.lock). The case-insensitive "rust" hits are almost all "trust" (grep artifact).
- No "binary adapter" or "--binary" flag.
- GBRAIN_BIN: one hit, eval/systems/gbrain-defaults/shim.py:62 (`GBRAIN = os.environ.get("GBRAIN_BIN", "gbrain")`). The shim is the existing process boundary for the gbrain-defaults system.
- "system under test" appears in about 40 places (runner comments, audit docs). The protocol itself lives in eval/systems/PROTOCOL.md (G7 covers it).
- TODOS.md items that bear on a binary or subprocess contract:
  - "Speed up the local-CLI arm." Each read is a new process, so a CLI cell takes 8 to 14 minutes against about 1 minute over MCP. A batched read path would help (TODOS.md:89).
  - "Define an external TranscriptBench runner contract ... Cat34's subprocess contract is a useful starting point" (TODOS.md:217 region, line 58 of the section).
  - "Export gbrain's version. A gbrain/version subpath would replace the path-resolution helper in eval/runner/gbrain-version.ts" (TODOS.md:123).
  - "Watch MCP search time after #5932" (TODOS.md:160).
  - "Move the gold store out of the product's process" (plan amendment 6; TODOS.md:119). This is the nearest item to a process boundary.
- TODOS.md "Stop" items about gbrain's `serve`: none found with that wording.

Net: no document plans a Rust rewrite or a binary adapter. The closest precedent is the CLI spawn (`--gbrain` overlay plus `MPW_GBRAIN_CLI`) and the Cat 34 subprocess contract.

## 8. Costs and notes for a parity runner

| Item | Value | Evidence |
|---|---|---|
| Offline CI wall clock per job | tests 6 shards, each about 6-7 min ideal; brainbench 3 shards, about 800 s on the slowest | ci.yml comments; timings.json |
| Full local `bun run test` | about 38 min serial CPU; about 9.5 min at 4 shards with ideal balance (estimate, not run) | timings sum |
| Typecheck heap | 8 GB (NODE_OPTIONS), 4.4 GB needed | ci.yml comment, package.json |
| Harness setup | up to 23 min on a cold fetch; cached pack afterwards | ci.yml:353 |
| Paid runs | keyed or paid tiers only; cost in receipts | RUNBOOK, registry |

Unknown: runtime for many scripts (decide, type-accuracy, harness-cell, harness-comparator). Not measured by this task.

## 9. Gaps in this read

- The per-test "gate on DATABASE_URL" behaviour was not verified file by file (12 files reference it).
- The 41 pure-with-tokens files were not inspected individually; the token match is a text search, so a file can match on a comment.
- Static import analysis ignores dynamic `import()` with computed paths and gbrain reached only through a runner's indirect module graph beyond relative imports.
- `eval:decide`, `eval:type-accuracy`, `harness:cell`, `harness:comparator` tiers are marked unknown.

Five-line summary
1. CI is keyless and installs gbrain from GitHub at a pin via `bun install --frozen-lockfile`. gbrain's bin is a TypeScript file, `src/cli.ts`, run under Bun; no binary is built.
2. Of 418 test/eval files, 333 reach gbrain by import (32 directly; 35 across test/). 48 files are pure, gbrain-free, spawn-free scoring and schema tests (about 26 s of 2,289 s serial). These survive a binary swap unchanged.
3. Paid tiers are gated by `--paid --budget-run-id`, the SQLite ledger, and `--budget-usd`; models are frontier-only (claude-opus-5-5, particle-1, gpt-6.1-sol); sealed labels are never read by keyless runs.
4. Existing process boundaries: MPW_GBRAIN_CLI (src/cli.ts via bun) in the harness and cell runners, GBRAIN_BIN in eval/systems/gbrain-defaults/shim.py, and the Cat 34 subprocess contract. No Rust plan or binary-adapter spec exists in the docs.
5. No secrets in CI; the only caches are the .git objects (keyed by commit) and the harness pack (keyed by harness.lock.json).
