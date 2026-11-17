# Research map: gbrain-evals as the parity oracle

This map describes `garrytan/gbrain-evals`: every benchmark runner, corpus, metric and published reference number, and exactly how each runner reaches TypeScript gbrain. It ends with a recommendation for running the evals against a Rust storage engine (the confirmed first build target) and, later, a Rust binary.

- gbrain-evals: `main` at `cd447b3ae60560ef69b629151640b318f86fe8ae` ("Release v0.10.237", 2026-11-16). Read from a shallow clone. Paths without a prefix are relative to the gbrain-evals root.
- gbrain pins in gbrain-evals `package.json`:

| Alias | Commit | gbrain version | Used for |
|---|---|---|---|
| `gbrain` | `6ce7195b44a034f85aec811f11fbf862db376f50` | 0.60.733.0 (2026-11-16) | almost every runner |
| `gbrain-cues` | `939232f1746381b4e932d620d6c709e29198f14c` | 0.55.0.0 (2026-09-24) | memory-cue arms (Cat 36, LongMemEval-M pilot) |
| `gbrain-reader` | `e78f1c38b947b053f3a46881340f74f316be855a` | 0.59.0.0 (2026-09-26) | LongMemEval reading-notes runners |

  Paths marked `gbrain:` are relative to the gbrain repo at the `gbrain` pin, read with `git show <sha>:<path>`.
- Method: ten parallel read-only research passes, one per area, plus spot checks of the key claims. No eval was run, no API key was used, no paid command was run. Two cheap commands ran: a read-only `bun` script that printed the tier table from `eval/registry.ts`, and `bun eval/runner/scoreboard.ts check` (exit 0). Counts from text search are marked as such; they can over- or under-count.
- Appendices: the detailed per-area notes are in [`gbrain-evals/`](gbrain-evals/). This page is the summary and the recommendation. Where this page and an appendix differ, this page wins (it reconciles the appendices).

| Appendix | Covers |
|---|---|
| G1 [imports.md](gbrain-evals/imports.md) | Every gbrain import, symbol, engine method, operation; pin and overlay selection; receipts |
| G2 [brainbench-categories.md](gbrain-evals/brainbench-categories.md) | BrainBench core, tiers, Cat 1 to 39, multi-adapter, scoreboard |
| G3 [longmemeval-and-memory-benchmarks.md](gbrain-evals/longmemeval-and-memory-benchmarks.md) | LongMemEval family, PrecisionMemBench, situation recall, sealed confirmation, memory proof wave, power and stats |
| G4 [probes-and-experiments.md](gbrain-evals/probes-and-experiments.md) | N1 to N15, P4/P5/P8, Q1/Q2, T0, one-off research runners |
| G5 [runner-subdirs-a.md](gbrain-evals/runner-subdirs-a.md) | cat40, cat41, decide, evidence-delivery, lifecycle, graph-backend, batch, bg1 and others |
| G6 [runner-subdirs-b.md](gbrain-evals/runner-subdirs-b.md) | nightly, refresh-barrier, live-recall, memory-qa, memory-trust, predictive, systems, skillopt-method, MCP contract |
| G7 [workload-suites-systems-harness.md](gbrain-evals/workload-suites-systems-harness.md) | Workload suites, `eval/systems` protocol, harness provider, shootout, generators |
| G8 [datasets-and-published-results.md](gbrain-evals/datasets-and-published-results.md) | Every dataset with size and origin, published numbers, receipts, sparse checkout |
| G9 [scripts-tests-ci.md](gbrain-evals/scripts-tests-ci.md) | package.json scripts, CI, scripts/, test/, run rules |
| G10 [engine-selection.md](gbrain-evals/engine-selection.md) | How each runner would select a Rust `BrainEngine`, per file, with the smallest change |

Related maps in this folder: the storage engine maps ([brain-engine.md](brain-engine.md), [schema.md](schema.md), [postgres-features.md](postgres-features.md)), the jobs and tests maps ([background-jobs.md](background-jobs.md), [test-suites.md](test-suites.md), [subsystems.md](subsystems.md)) and the agent contract maps ([agent-contract.md](agent-contract.md)). The [index](README.md) lists them all.

## 1. Summary

1. **Size and shape.** The working tree is 2.0 GB; 1.9 GB of it is `docs/benchmarks/` (474 published reports, 1.37 GB of compressed receipts). The runnable part is small: `eval/` is 62 MB (41 MB of it `eval/data`), `test/` 8.6 MB, `scripts/` 0.4 MB. `eval/runner/` holds 223 top-level `.ts` files and 41 subdirectories. A sparse checkout without `docs/benchmarks` is 82 MB and works for everything except the scoreboard check (G8 section 6).
2. **One registry drives BrainBench.** `eval/registry.ts` lists 95 entries. `bun eval/runner/all.ts --tier offline` (`bun run eval:brainbench`) dispatches 37 keyless H-tier entries, each as a child `bun` process. CI runs exactly this in 3 shards, about 800 s on the slowest shard, with no secrets (G9 section 2). The paid tier dispatches 16 K/P entries and refuses to start without `--paid --budget-run-id`. 42 more entries are "listed": documented, but run by hand.
3. **Almost every runner is coupled in-process.** 249 files reference gbrain (128 in `eval/`, 72 in `test/`, 49 one-off scripts in `docs/`). G1 sorts them into: 83 that import the pinned package statically (and so ignore `--gbrain`), 2 mixed, 116 that load modules from a checkout root by absolute path (`importGbrain(gut, 'src/...')` or `import(join(root, ...))`), and 48 that only reach into `node_modules/gbrain/src/...` past the export map. The most used surfaces are `PGLiteEngine`, `configureGateway` and its test transports, `importFromContent`, `hybridSearch`, and `operations` handlers (G1).
4. **A real process boundary exists, but only in a few places.** `eval/runner/lifecycle/drivers.ts` drives `bun <checkout>/src/cli.ts` as a CLI (`call <op> <json>`), as MCP over stdio (`serve`) and as MCP over HTTP (`serve --http`). `eval/runner/cat40/gbrain-arm.ts` (`McpClient`) is the shared stdio MCP client. `eval/systems/gbrain-defaults/shim.py` is the only place that runs a gbrain executable by name (`GBRAIN_BIN`). Every other "CLI" call runs `bun <root>/src/cli.ts`, so a native binary needs one small change in each launcher (sections 7.5 and 9.2).
5. **The engine is hard-coded.** 91 sites in 82 files call `new PGLiteEngine()` directly. Only 3 files use `createEngine(config)` and 4 skillopt runners accept an `engineFactory`. No runner can select a third engine today (section 8, G10).
6. **Raw SQL is part of the contract.** About 57 eval files call `engine.executeRaw(...)` with Postgres-dialect SQL, mostly for counts, fixture setup (`INSERT INTO sources`, about ten runners) and table resets. gbrain itself also calls `executeRaw` with Postgres SQL throughout `src/` (see [storage-engine.md](storage-engine.md)). A Rust engine either runs that SQL or the callers move to typed methods.
7. **Cheap deterministic gates exist.** The 37 offline entries cost $0, need no keys and finish in seconds to a few minutes each. They use stub embeddings or none. `eval/runner/lifecycle-experiment.ts` already runs a build x engine x interface matrix (`--engines pglite,postgres --interfaces cli,mcp-stdio,mcp-http`) at $0. These are the natural Phase-0 and Phase-1 parity gates (section 9).
8. **Published reference numbers** are spread over `README.md` (lines 169 to 218), `docs/scoreboard.md`, `docs/comparison-systems.md`, `docs/receipts-manifest.json` (352 claims, each tied to an artifact hash and a golden test) and the per-report files in `docs/benchmarks/`. The headline numbers are LongMemEval-S strict retrieval 95.53% (449/470) and end-to-end QA 93.6% (468/500); they need paid embedding, rerank and reader calls and are not parity gates (section 6).
9. **Nothing in gbrain-evals plans a Rust port or a binary adapter.** The nearest precedents are the `--gbrain <checkout>@<ref>` overlay, `MPW_GBRAIN_CLI`, `GBRAIN_BIN`, the Cat 34 subprocess contract and the lifecycle drivers (G9 section 7).

## 2. Repository layout

| Path | Size, files | What it holds |
|---|---|---|
| `eval/runner/` | 13 MB, 660 files | Every runner: 223 top-level `.ts` files plus 41 family subdirectories (`cat40/`, `lifecycle/`, `memory-qa/`, `nightly/`, `q1/`, `q2/`, ...) |
| `eval/data/` | 41 MB, 2,546 files | 45 committed corpora and fixtures (section 5) |
| `eval/generators/` | 2.2 MB, 93 files | Seeded generators for the corpora; none imports gbrain; 4 call a model |
| `eval/harness-provider/` | 2.1 MB, 368 files | Python agent-memory harness (pinned `vectorize-io/agent-memory-benchmark`) and the gbrain provider for it |
| `eval/systems/` | 1.6 MB, 79 files | HTTP protocol v1 (`PROTOCOL.md`) and one shim per memory system, including `gbrain-defaults` |
| `eval/workload-suites/` | 260 KB, 16 files | Four generated workload suites (passing-details, corrections, time-relationships, beliefs) |
| `eval/precisionmembench/` | 200 KB, 15 files | PrecisionMemBench fixtures and seeding |
| `eval/registry.ts` | 1 file | The BrainBench category registry (tiers, scripts, args, timeouts, costs) |
| `eval/custody/`, `eval/decisions/`, `eval/schemas/`, `eval/regression/` | under 1.5 MB | Sealed-set custody tooling, decision-kit datasets, JSON Schemas (receipt v2), regression inventory |
| `scripts/` | 0.4 MB, 34 entries | Verifiers, CI helpers, shootout and refresh wrappers, Ubicloud launchers |
| `test/` | 8.6 MB, 475 files | `bun test` suites, sharded 6 ways in CI |
| `docs/benchmarks/` | 1.9 GB, 474 entries | Published reports and receipts |
| `docs/` (rest) | about 12 MB | Scoreboard method, comparison systems, findings, plans, audits, `gbrain-under-test.md`, `usage-receipt.md`, `settings.md` |
| `qrels/`, `baselines/`, `results/` | under 100 KB | Qrels, the `v0.41-launch` keyword baseline (12 queries), small result files |
| `patches/postgres@3.4.9.patch` | 32 KB | Cancellation fixes for the npm `postgres` driver; matters only for the `gbrain-cues` and `gbrain-reader` aliases (G1 section 6) |

## 3. How a run works

### 3.1 Tiers and dispatch

`eval/registry.ts` is the single list of BrainBench categories. Each entry has an id, a tier, a script, args, a timeout and, for paid rows, a cost estimate. `eval/runner/all.ts` reads it, picks entries by tier and spawns each script as a child (`spawn('bun', [script, ...args])` with `env: { ...process.env, ...cat.env }`, `all.ts:339-341`). It writes a combined report to `eval/reports/YYYY-MM-DD-brainbench.md`.

| Tier (registry code) | Meaning | Entries | Command |
|---|---|---|---|
| H, dispatched | keyless, hermetic, CI-safe | 37 | `bun run eval:brainbench` = `bun eval/runner/all.ts --tier offline` (`--shard k/n`, `--only <ids>`) |
| K and P, dispatched | keyed (under $1) and paid | 16 (2 K, 14 P) | `bun run eval:brainbench:paid` (needs `--paid --budget-run-id <id>`) |
| H, listed | keyless, run by hand (often needs `--gbrain <checkout>`) | 9 | the `command` printed by `all.ts` |
| P, listed | paid, run by hand with a budget ledger | 30 | per runner |
| none, listed | cannot run (no reviewed catalog) | 3 (Cat 5, 8, 9) | none |

Offline tier wall time: 1,322 s summed over categories (CI measurements in `eval/runner/brainbench-shard-weights.json`, 2026-10-23, `BRAINBENCH_CONCURRENCY=2`). CI splits it into 3 shards with a 900 s bound each.

### 3.2 Guards that every runner shares

- **Hermetic environment.** `eval/runner/hermetic-env.ts` strips every `*_API_KEY` and provider endpoint and points `GBRAIN_HOME` at an empty temp directory before gbrain code loads, so `loadConfig()` cannot read keys back from `~/.gbrain/.env`.
- **Paid gate.** `eval/runner/paid-arm.ts` refuses a paid arm without `--paid --budget-run-id`. `eval/runner/budget-ledger.ts` keeps a SQLite ledger (`.budget/ledger.sqlite`) and prices calls with gbrain's own `canonicalLookup` (`gbrain/core/model-pricing`) and `lookupEmbeddingPrice`. The default program cap is $500 (`eval/RUNBOOK.md:42`).
- **Preregistration.** `eval/runner/prereg.ts` checks that a preregistration commit precedes the results commit; CI runs it.
- **Receipts.** `eval/runner/receipt.ts` writes receipt schema v2 (`eval/schemas/receipt.schema.json`). Required fields include `gbrain_version`, `gbrain_pin`, `n_total`, `n_scored`, `completion_rate`, `errors`; optional fields include `resolved_config`, `judge`, `hashes` and `execution.product {package, declared_pin, declared_sha, version, package_sha256, loaded_git_head}`. Model calls also write one `usage-receipt/v1` line each (`docs/usage-receipt.md`).

### 3.3 How a run selects the gbrain under test

| Mechanism | Where | What it selects | Who honors it |
|---|---|---|---|
| Pinned package | `node_modules/gbrain` (installed by `bun install`) | the `gbrain` pin | every static `import ... from 'gbrain/...'` (83 files); the default for everything |
| `--gbrain <checkout>[@<ref>]` or `GBRAIN_UNDER_TEST` | `eval/runner/gbrain-under-test.ts` (`gbrainSpecFrom`, `resolveGbrainUnderTest`, `importGbrain`) | a `git archive` copy of a gbrain commit under `.gbrain-overlays/`, `bun install --frozen-lockfile` run in it, tree hash and VERSION verified | runners that call `importGbrain(gut, ...)` or spawn `join(gut.root, 'src/cli.ts')` (37 files mention the flag) |
| Product alias | `adapters/gbrain-inline.ts` `productPackage`, `cat36ProductPackage(arm)`, `type-accuracy.ts --package` | `gbrain` vs `gbrain-cues` | those runners only |
| Per-arm specs | `decide.ts`, `lifecycle-lite.ts`, `n9-multi-hop-paraphrase.ts`, `lifecycle-experiment.ts --builds a=<sha>,b=<ref>` | two or more checkouts in one run | those runners |
| `GBRAIN_BIN` | `eval/systems/gbrain-defaults/shim.py:62` | a gbrain executable on PATH (Docker image builds gbrain at `GBRAIN_SHA`) | gbrain-defaults system only |
| `MPW_GBRAIN_CLI` | `eval/workload-suites/bench-infra.ts:89`, `eval/runner/harness-cell.ts:448,590` | the `cli.ts` the Python harness runs with `bun` | harness provider only |

Caveat: `gbrainVersion()` (`eval/runner/gbrain-version.ts`, 74 call sites) resolves the installed alias, so a receipt from an overlay run can carry the pin's version. Runners that stamp `gut.version` or `productIdentityFor(gut)` are correct (G1 section 5.4).

## 4. Runner inventory

Coupling codes used in every table below:

- **in-process**: imports gbrain modules and calls them in the same Bun process.
- **CLI**: spawns gbrain (`bun <root>/src/cli.ts ...`, or `GBRAIN_BIN`) and reads its output.
- **MCP-stdio / MCP-HTTP**: speaks JSON-RPC to `gbrain serve` (stdio) or `gbrain serve --http` (`POST /mcp`).
- **none**: no gbrain at all (pure scoring, recounts, data checks).

Engine bucket (offline tier only; section 8 and G10 explain it): **B** constructs `PGLiteEngine` directly but uses public methods only; **C** also uses raw SQL or PGLite internals; **D** out-of-process, engine comes from the brain's `config.json`; **-** no engine.

### 4.1 Offline tier: the 37 entries `--tier offline` dispatches ($0, no keys)

All 37 need no API key. Runners that touch embeddings stub them with gbrain's `__setEmbedTransportForTests` or use keyword search only. Seconds are the CI weights from `brainbench-shard-weights.json`.

| Registry id (alias) | Script | Measures | s | Corpus | gbrain surface used | Coupling, bucket |
|---|---|---|---|---|---|---|
| relational-graph-first (Cat 1) | `before-after.ts` | Relational recall before vs after graph traversal | 9 | `eval/data/world-v1` | `putPage`, `traversePaths`, `runExtract` (links, then timeline, `--source db`) | in-process, B |
| link-type-accuracy (Cat 2) | `type-accuracy.ts` | Link type accuracy vs gold | 1 | world-v1 | `gbrain/link-extraction` parser only | in-process, - |
| alias-keyword-lookup (Cat 3) | `identity.ts` | Alias lookup through keyword search | 8 | generated in run | `searchKeyword`, `getChunks`, deep `core/page-state/projections.ts` | in-process, B |
| timeline-round-trip (Cat 4) | `temporal.ts` | Timeline store and read-back | 6 | generated | `addTimelineEntry`, `getTimeline` | in-process, B |
| prose-autolink-precision (Cat 6) | `cat6-prose-scale.ts` | Auto-link precision under prose variants | 12 | world-v1 + injections | link extraction; links join SQL | in-process, C |
| pglite-latency (Cat 7) | `perf.ts` | Op latency P50/P95/P99 at 1K and 10K pages | 66 | generated | 10 engine methods (`traversePaths`, `getBacklinks`, `listPages`, `getTimeline`, `addLink`, `putPage`, `searchKeyword`, `getPage`, ...) | in-process, B |
| adversarial-robustness (Cat 10) | `adversarial.ts` | 22 robustness edge cases | 5 | in file | link extraction, `traversePaths` | in-process, B |
| text-ingestion-fidelity (Cat 11) | `cat11-multimodal.ts` | Markdown/HTML ingestion fidelity (audio needs a key and is skipped) | 6 | `eval/data/multimodal` | `importFromContent`, `getChunks` | in-process, B |
| mcp-operation-contract (Cat 12) | `mcp-contract.ts` | Remote vs local trust boundary and limits on operation handlers | 9 | generated, about 150 pages | `operations[].handler` with `remote: true/false` | in-process, B |
| doctor-remediation (Cat 19) | `cat19-doctor-remediate.ts` | Doctor and remediate move a sick brain to health | 7 | generated | `getHealth`, deep `brain-score-recommendations`, `runEmbedCore`; count SQL | in-process, C |
| source-isolation (Cat 22) | `cat22-source-isolation.ts` | Cross-source leaks under federated scoping | 7 | generated | `listPages`, `traverseGraph`; `INSERT INTO sources`, `INSERT INTO links` | in-process, C |
| phantom-redirect (Cat 23) | `cat23-phantom-redirect.ts` | Phantom to canonical page redirect | 6 | generated | deep `core/entities/resolve.ts` | in-process, B |
| capture-provenance (Cat 24) | `cat24-capture-provenance.ts` | Provenance write-through, trust gate, dedup | 6 | generated | `operationsByName.put_page.handler`; provenance column SQL | in-process, C |
| graph-signals (Cat 27) | `cat27-graph-signals.ts` | Adjacency, cross-source and session-demote signals on vs off | 15 | generated | `hybridSearch`, `setConfig`; `INSERT INTO sources` | in-process, C |
| federated-sync-latency (Cat 28) | `cat28-federated-sync-latency.ts` | Federated import overhead | 44 | generated | `importFromContent`; `INSERT INTO sources`, count | in-process, C |
| brainbench-memory-conformance (Cat 34) | `cat34-brainbench-memory.ts` | gbrain's own `evals/brainbench` conformance suite | 1 | gbrain repo `evals/brainbench/` | spawns `bun <checkout>/src/cli.ts eval brainbench`; skips (`--allow-skip`) when no checkout, as in CI | CLI, D |
| associative-retrieval-smoke (Cat 36) | `cat36-associative-retrieval.ts --offline --smoke` | Span coverage of associative recall | 10 | `eval/data/associative-recall-v1` | `gbrain-cues` PGLite opened on a copied snapshot dir; `INSERT INTO sources`, `UPDATE pages` | in-process, C |
| memory-poisoning (Cat 37) | `cat37-memory-poisoning.ts` | Attack success with the write gate off vs on | 100 | generated scenarios | `memory-trust/sut.ts`: operations, `dumpDataDir`, quarantine SQL | in-process, C |
| state-resolution (Cat 38) | `cat38-state-resolution.ts` | Current value served across trust tiers | 47 | generated | `sut.ts`; `UPDATE persistence_brain`, facts SQL | in-process, C |
| deletion-audit (Cat 39) | `cat39-deletion-audit.ts` | forget and `delete --purge` leave nothing live | 31 | generated | `sut.ts`; `lower()` and `~` regex scans over facts, takes, pages, chunks | in-process, C |
| temporal-asof (N3) | `n3-temporal-asof.ts` | As-of and date-filter answers vs gold | 25 | generated | operations; facts SQL | in-process, C |
| temporal-edges | `temporal-edges.ts` | Current, as-of and during relationships from linked notes | 48 | generated | `readPageSnapshot`; `link_transitions` SQL, `to_regclass` | in-process, C |
| entity-resolution (N4) | `n4-entity-resolution.ts` | Entity slug resolution, recall, remember | 14 | generated | `insertFact`; `INSERT INTO sources`, alias SQL | in-process, C |
| visibility-leak-fuzz (N6) | `n6-visibility-fuzz.ts` | Do read ops leak protected content to 7 caller types | 124 | generated | in-process MCP `dispatchToolCall`/`handleToolCall`; SQL | in-process, C |
| format-fidelity (N12) | `n12-format-fidelity.ts` | Transcript and format parsing, attendee roles | 11 | generated | `importFromContent`, `setConfig` | in-process, B |
| code-intelligence (N13) | `n13-code-intelligence.ts` | Readiness of six `code_*` operations on a vendored snapshot | 7 | `eval/data/n13-code-scout` | in-process MCP dispatch; counts on `code_edges_*` | in-process, C |
| large-page-fidelity (N14) | `n14-large-page-fidelity.ts` | Find and read deep content in large pages | 101 | generated | body-segment columns SQL | in-process, C |
| skillopt-method (N15) | `n15-skillopt-method.ts` | Can skill optimizers be told apart (hermetic default) | 6 | `eval/data/skillopt-method-v3` | no direct import; `skillopt-method/headroom.ts` opens PGLite | in-process, B |
| open-loops-email (N7) | `n7-open-loops-email.ts` | Gmail-shaped open-loop detection | 5 | generated | `open_loops` SELECT/UPDATE/DELETE SQL | in-process, C |
| proactive-recall (N8) | `n8-proactive-recall.ts` | Unsolicited recall and false alarms | 115 | generated + associative-recall-v1 | `softDeletePage`; `INSERT INTO sources` | in-process, C |
| contradiction-surfacing (N2) | `n2-contradiction-surfacing.ts` | Discovery of planted contradictions (offline part) | 56 | generated | chunk join, `md5`/`string_agg` SQL | in-process, C |
| abstention (A4) | `a4-abstention.ts` | CRAG grade calibration and abstention (offline part) | 30 | generated | operations, `search/crag`; chunk SQL | in-process, C |
| system-one-jev-record (SO) | `system-one-jev.ts` (`verify`) | Recount of committed System One receipts and hashes | 1 | `eval/data/system-one-v1` | none ("No gbrain, key or network") | none, - |
| agent-retrieval-shapes (ARS) | `agent-retrieval-shapes.ts` | 15 retrieval shapes on an operator-style brain | 54 | generated | operations; count SQL | in-process, C |
| multi-hop-paraphrase (N9) | `n9-multi-hop-paraphrase.ts` | 2 and 3 hop questions, canonical vs paraphrase (keyword default) | 127 | world-v1 + n9 generator | `relational-ab.ts` `RelationalSearch`; links SQL | in-process, C |
| knowledge-update-ci (N1) | `n1-knowledge-update.ts --slice ci` | Supersession and value changes through the lifecycle | 109 | generated | lifecycle drivers, cell pglite x `mcp-stdio`, plus in-process reads | MCP-stdio + in-process, D |
| forget-residue-ci (N5) | `n5-forget-residue.ts --slice ci` | Forget survives reimport and restart | 93 | generated | lifecycle drivers | CLI/MCP, D |

Bucket totals for the dispatched offline tier: B 10, C 22, D 3, no engine 2.

### 4.2 Paid BrainBench tier: the 16 entries `--tier paid` dispatches

All are in-process. Costs are registry estimates where present; "unknown" means `cost_estimate.usd` is null.

| Registry id (Cat) | Script | Measures | Cost | Keys |
|---|---|---|---|---|
| concept-search (13) | `cat13-conceptual.ts` | Conceptual search nDCG@5 across keyword, vector, hybrid, rerank | about $3 | OpenAI; Voyage for rerank |
| source-swamp (13b) | `cat13b-source-swamp.ts` | Curated page vs bulk chat archive ranking | unknown | OpenAI |
| think-calibration (14) | `cat14-calibration.ts` | Calibrated vs plain `think`, blind judge | unknown | Anthropic, OpenAI |
| propose-takes (15) | `cat15-propose-takes.ts` | Claim extraction precision and recall | unknown | Anthropic |
| embedding-providers (18) | `cat18-embedding-providers.ts` | OpenAI vs Voyage embedders | unknown | OpenAI, Voyage |
| embedder-reranker-matrix (18b) | `cat18b-embedding-rerank-matrix.ts` | Embedder x reranker, 4 cells | unknown | OpenAI, Voyage |
| brainstorm-grounding (20) | `cat20-brainstorm.ts` | Grounding and structure of brainstorm ideas | unknown | Anthropic, OpenAI |
| code-retrieval (21) | `cat21-code-retrieval.ts` | voyage-code-3 vs text-embedding-3-large on symbols | unknown | OpenAI, Voyage |
| trajectory-routing (25) | `cat25-trajectory-routing.ts` | `think` trajectory routing A/B | unknown | Anthropic, OpenAI |
| contextual-retrieval (26) | `cat26-contextual-retrieval.ts` | Contextual retrieval modes | unknown | OpenAI |
| think-vs-search (29) | `cat29-think-vs-search.ts` | `think` synthesis vs raw search, blind judge | unknown | Anthropic, OpenAI |
| transcript-distillation (35) | `cat35-transcript-distill.ts` | Planted salient units survive distillation | $54 full (`CAT35_FULL=1`), $3.24 smoke | Anthropic, OpenAI |
| multi-adapter | `multi-adapter.ts` + `adapters/` | Relational, fuzzy and outsider retrieval P@5/R@5 across 5 adapters | unknown; `grep-only` adapter is keyless | OpenAI for vector and hybrid |
| precisionmembench | `precisionmembench.ts` | Precision and recall on 77 cases over 35 beliefs | keyword $0; `gbrain-think` about $0.06 per case | embeddings; Anthropic for think |
| relational-ab (K) | `relational-ab.ts` | Relational retrieval off vs on (`--stub-embed` keyless) | about $0.07 | OpenAI |
| constrained-relational (K) | `constrained-relational.ts` | Constrained relational retrieval | budget $1 | OpenAI |

### 4.3 Listed registry entries (42, run by hand)

- H, listed (keyless): `temporal-ingest-answer`, `line-grammar-typing`, `relation-line-variants`, `forward-reference-heal`, `n4-similar-pages` (all in-process; the middle three share `eval/runner/p5-brain.ts`), `memory-lifecycle` (`lifecycle-experiment.ts`, CLI + MCP, $0), `knowledge-update` and `forget-residue` (full N1 and N5 matrices), `qrels-regression` (`scripts/generate-v0.41-launch.ts`, keyword baseline `baselines/v0.41-launch.baseline.ndjson`; CI runs its `--check`).
- P, listed (paid, ledger-gated): skillopt Cat 30 to 33, the paid arms of Cat 36 to 39, temporal-contradictions, line-grammar-junk-audit, save-notes-dedup, write-then-answer, quote-grounding (P8), write-cost (P8), facts-absorb-gate, system-one-jev (paid), N9 paid, LongMemEval retrieval, answers and M pilot, reading-notes, model ladder and model ladder hard (Cat 40), program-primary and hard (T0, T0b), proactive-brief, agent-operator (Cat 41), evidence-delivery, sealed-confirmation, situation-recall, shootout-cell, lifecycle-lite, source-swamp situation recall.
- None: source-attribution (Cat 5), skill-compliance (Cat 8), end-to-end-workflows (Cat 9). They have no reviewed claim or scenario catalog and cannot run.

### 4.4 Runner families outside the BrainBench tiers

Grouped by family. Costs come from receipts, budget constants or protocol docs; "unknown" means no figure was found (details in the appendix named in the last column).

| Family | Entry | Measures | Cost / time | Keys | Corpus | Coupling | Appx |
|---|---|---|---|---|---|---|---|
| LongMemEval retrieval | `longmemeval.ts`, `longmemeval-batch.sh` | Strict all-evidence recall `recall_all@k` on 470 answerable questions; `recall_any`, nDCG, abstention noise | Embeddings $0 warm, about $2 to $7.56 cold; rerank about $0.35 to $0.50 per arm; about 40 min per warm arm; cold capture about 3.1 h | OpenAI embeddings, Voyage rerank, Anthropic Haiku for expansion; `--keyword-only` keyless | LongMemEval-S cleaned (downloaded) | in-process (`PGLiteEngine` recreated per question, `hybridSearch`, `expandQuery`) | G3 |
| LongMemEval answers, reading notes, W10 batch lane | `longmemeval-answers.ts`, `reading-notes-*.ts`, `batch/w10*.ts` | Grounding judge; reader A/B with `gbrain-reader`; reader and judge accuracy through provider batch APIs | paid; `w10-rescore.ts` $0 | Anthropic, OpenAI | retrieval NDJSON, LongMemEval-S | answers: none; reading notes and batch: in-process (pinned `node_modules`) | G3, G5 |
| LongMemEval-M cue pilot | `longmemeval-m-pilot-*.ts` | Recall on 28 frozen `_m` questions with memory-cue windows | full-scale ceiling about $26,801 (prereg); pilot incomplete | OpenRouter | `_m` cleaned (2.7 GB, downloaded) | in-process (`gbrain-cues`) | G3 |
| LongMemEval verifiers | `scripts/verify-*longmemeval*.py` | Recount committed receipts, paired McNemar, no-leak checks | $0, in `bun run validate` | none | committed receipts | none | G3, G9 |
| Retrieval refresh | `scripts/run-retrieval-refresh.py` (+ summarize, plot) | Fixed matrix of non-LongMemEval cells | 2026-09-09: $0.71 gross of $475 reserved | Voyage, OpenAI, Anthropic | per cell | spawns bun runners (in-process inside) | G3 |
| PrecisionMemBench, any system | `precisionmembench-system.ts`, `-s3.ts`, `-instrument.ts` | Same scorer against a protocol shim URL, `gbrain-shootout` or a fake | keyword and fake $0 | per system | `eval/precisionmembench/fixtures` | HTTP (shim) or in-process | G3 |
| Situation recall | `situation-recall-*.ts` | Promotion gate B vs C0 vs C1 over about 50 categories; associative recall drivers | per-cell ledger | per driver | `eval/regression/situation-recall-v1.json`, associative-recall-v1 | gate none; drivers in-process | G3 |
| Sealed confirmation | `sealed-confirmation.ts` | Held-out recall and answer accuracy on sealed sets (labels private) | generation $15.82 (v1), $20.99 (v2) | Anthropic reader, OpenAI judge `gpt-4o-2024-08-06` | public halves in `eval/data/sealed-confirmation-v1`, `-v2` | in-process (`longmemeval.ts` `run()`) | G3 |
| Memory proof wave | `memory-proof-wave-*.ts` | Non-inferiority of gbrain vs a memory-bank comparator on sealed BEAM (54 conversations, 1,080 questions) | power and grouping $0; sealed cap $450 | harness side | `eval/data/memory-proof-wave` + BEAM | analysis none; runs through the Python harness | G3 |
| Power, stats, pilot | `power/`, `stats/`, `pilot/` | Clopper-Pearson, paired and wild-cluster tests, power | $0; pilot 2026-10-08 $60.48 | pilot only | frozen captures | none | G3 |
| N-series full matrices and probes | `n1`, `n2-3-prompt-ab`, `n2-judge-replay`, `n4-similar-pages`, `n5`, `n6-postgres-http`, `n14` tiers to 1 GB | See G4; `n6-postgres-http` needs Docker `pgvector/pgvector:pg16` | mostly $0; judge stages paid | mostly none | generated | `n6-postgres-http`: `serve --http` + HTTP; N1, N5: lifecycle drivers; rest in-process | G4 |
| P4 stream, P5, P8 | `p4-stream/run.ts`, `p5-agent.ts`, `p5-brain.ts`, `p8-*.ts` | Live stream compaction with Claude Code lanes; write-then-answer; quote grounding; write cost | paid, budget required | Anthropic, OpenAI | LongMemEval, BEAM, generated | P4, P8 write-cost: MCP-stdio + CLI; P5 brain: in-process | G4 |
| Q1 scoreboard cells | `q1/cell.ts` (+ 25 helpers) | BEAM-10M/1M/100K and LoCoMo cells: ingest, QA, judge | paid; hours per cell; sealed spend $7,034 of $8,000 | Anthropic, OpenAI, Particle | BEAM (custody) | HTTP to protocol shims + MCP + in-process | G4 |
| Q2 campaign and gates | `q2/*.ts` | Line-grammar junk audit, C gates, power | mostly $0; judges paid | Anthropic, OpenAI | custody sets | in-process (`importGbrain(.../line-grammar.ts)`, `p5-brain`) | G4 |
| T0 program primary | `t0-program-primary.ts`, `t0b-*.ts`, `t0/*.ts` | End-to-end failure after a correction; native Claude Code parity with gbrain hooks | hermetic $0 scripted; paid with budget | Anthropic | generated | MCP-stdio (`McpClient`) + CLI hooks; `t0/parity.ts` spawns `claude` with gbrain MCP config | G4 |
| Cat 40 model ladder and Hard | `cat40-model-ladder.ts`, `cat40/`, `scripts/cat40-*.sh` | Does gbrain's advantage over file, pg and memory arms hold across models | $0.02 to $0.30 per gbrain cell; Hard ledger cap $1,794; 20 min to 7.5 h; `--scripted` $0 | Anthropic, OpenAI, Particle | `eval/data/model-ladder-*` | MCP-stdio (`cat40/gbrain-arm.ts` `McpClient`, `serve --surface <s>`) | G5 |
| Cat 41 agent operator | `cat41-agent-operator.ts`, `cat41/` | Real Claude Code and Codex sessions in a container take the right operator actions | about $12 to $17 per 3-repeat pass, about 35 min | Anthropic, OpenAI | `cat41/scenarios.ts` | CLI inside Docker (`call`, `init --json`, `remember`, `serve`); `brief-db.ts` uses `createEngine` | G5 |
| Decision kit | `decide.ts`, `decisions/`, `eval/decisions/` | Held-out and dev verdicts for a candidate vs baseline build | paid via child memory-qa jobs | via children | `eval/decisions/datasets` | spawns child runners | G5 |
| Evidence delivery, external ideas, budgeted delivery | `evidence-delivery.ts`, `external-ideas-wave-a.ts`, `budgeted-delivery/` | Evidence packing and delivery ablations on LongMemEval-S | campaign cap $400; lane ledger $220; dry runs $0 | OpenAI, Voyage, Anthropic | LongMemEval-S, sealed sets | in-process (writes `engine: 'pglite'` config directly) | G5 |
| Facts absorb gate | `facts-absorb-gate.ts` | Does a cheaper `facts.extraction_model` keep the facts | paid, budget required | Anthropic, OpenAI | generated | MCP-stdio (`serve --surface full`) + CLI (`call`, `jobs work`) | G5 |
| Lifecycle experiment | `lifecycle-experiment.ts`, `lifecycle/` | Ingest, outage, correct, reconcile, forget, restart, query across build x engine x interface | $0, keys stripped | none | generated in code | CLI + MCP-stdio + MCP-HTTP, Postgres admin via Bun SQL | G5 |
| Lifecycle-lite | `lifecycle-lite.ts` | Update and forget behavior for any memory system | hermetic hash embedder $0 | none hermetic | generated | HTTP protocol v1; in-process for `gbrain-shootout` | G5 |
| Graph backend | `graph-backend/run-tier.sh` | Graph walk latency: gbrain CTE vs breadth-first vs PGLite vs an external graph DB | $0 LLM | none | generated graphs | in-process engines (PGLite and Postgres) + HTTP | G5 |
| BG1, RS1, SOTA, outcomes, failure causes, evaluator | `bg1/`, `rs1/`, `sota/`, `outcomes/`, `failure-causes/`, `evaluator/` | Pre-registered verdicts, judge checks, scoring libraries | analysis $0; judge checks paid | judge checks only | receipts | none | G5, G6 |
| Nightly | `nightly/run.ts` (+ `tool-contract.ts`, `smokes/`) | Dev-set pass rates, cost per correct answer, regressions; keyless CLI and serve smokes | `--fake` $0 | `--paid` only | `eval/data/nightly` | smokes: CLI + `serve --http`; tool-contract: in-process MCP dispatch | G6 |
| Refresh barrier | `refresh-barrier/run.ts` | Write landing, refusals, concurrency, quiet latency (`--engine postgres` or `pglite`) | agent caps $65 / $35 / $5 | agent arms only | fixture | in-process engines (Postgres and PGLite) + in-process MCP dispatch | G6 |
| Live recall | `live-recall/run.ts` | recall@k on private questions | Voyage paid | Voyage | private brain (not committed) or synthetic | in-process; `brain.ts` opens Postgres read-only | G6 |
| Memory QA arms | `memory-qa/run.ts`, `run-systems.ts` | LoCoMo, LongMemEval-S, BEAM accuracy per build | `--embed hash --qa none` $0 | reader and judge | downloaded datasets | in-process (PGLite, `TRUNCATE` reset) | G6 |
| Memory trust | `memory-trust/flag-rate.ts`, `sut.ts`, `repro.ts` | Write-gate flag rate; Cat 37 to 39 SUT | flag-rate paid | Anthropic, OpenAI | LongMemEval-S users | flag-rate: MCP-stdio + CLI; sut: in-process | G6 |
| Messy company | `messy-company/load.ts`, `score-*.ts` | Ownership windows, timelines, aliases, document status | $0, seconds | none | `eval/data/messy-company-v1` | in-process load; scorers none | G6 |
| Predictive | `predictive/run.ts`, `cli-arm.ts` | Agent behavior on CLI and MCP surfaces: write landing, call contract, reach, latency | grammar $0; episodes paid | agent arms | synthetic | CLI (`--no-env-file cli.ts`, `call <op> <json>`) + MCP-stdio | G6 |
| SkillOpt method | `skillopt-method/*.ts` | Optimizer headroom on gbrain skills | frontier probes paid | Anthropic, OpenAI | skillopt-method v2/v3 | in-process (`gbrain/core/skillopt`, `toolLoop`) | G6 |
| Strict-pageless | `strict-pageless/agent.ts` | Does `remember` for a pageless entity survive a rebuild | `--model fake` $0 | when not fake | refresh-barrier fixture | in-process MCP dispatch | G6 |
| Systems and shootout | `eval/systems/*`, `systems/*.ts`, `shootout-*.ts`, `harness-*.ts` | Head-to-head with other memory systems through protocol v1 | paid via metering proxy; `_fake` and `--stub-upstream` $0 | via proxy | per campaign | gbrain-defaults shim: CLI + MCP-stdio via `GBRAIN_BIN`; harness provider: CLI via `MPW_GBRAIN_CLI`; `systems/gbrain.ts`, `shootout-driver.ts`: in-process | G7 |
| Workload suites | `eval/workload-suites/cli.ts`, `bench.ts` | Generator validity offline; QA accuracy, correction and stale-answer rates (paid bench) | offline $0; bench cap $720 | bench only (`--stub` keyless) | generated, manifests in `eval/data/workload-suites` | offline none; bench CLI + MCP through the harness | G7 |
| One-off research runners | about 40 files (`a4-s4-rescore`, `chronicle-lift`, `coding-spike`, `hub-world*`, `feedback-*`, `structure-aware-chunks`, ...) | Single experiments, many cited by one report | mostly paid | varies | varies | mostly in-process; `chronicle-lift` CLI + MCP | G4 |
| Generators | `eval/generators/*.ts` (93) | Build `eval/data/*` | mostly $0; 4 call a model | 4 need keys | writes `eval/data` | none | G7 |

## 5. Corpora and datasets

Full table of all 45 `eval/data` entries with origin, shape and users: G8 section 1. Origin codes: **C** committed by hand, **G** generated by a committed generator and committed, **X** generated and gitignored, **D** downloaded at run time.

### 5.1 Committed corpora that the parity gates need

| Corpus | Path | Size, files | Origin | Shape | Main users |
|---|---|---|---|---|---|
| world-v1 | `eval/data/world-v1` | 2.0 MB, 242 | G (`eval/generators/world.ts`, Opus 4.5, 49 calls, $3.14) | 80 companies, 80 people, 50 meetings, 30 concepts, one JSON each; the BrainBench world | Cat 1, 2, 6, multi-adapter, N9, shootout driver, P5 trio |
| world-v1-attendees | `eval/data/world-v1-attendees` | 1.1 MB, 241 | G | world-v1 with attendee links | N9, attendee planner |
| synthetic-v1 | `eval/data/synthetic-v1` | 704 KB, 166 | G | people, companies, deals, meetings, daily, writing pages | Cat 13, 18, 20, 29 |
| associative-recall-v1 | `eval/data/associative-recall-v1` | 528 KB, 7 | C (frozen 2026-09-23) | 120 scenario families, 480 probes | Cat 36, N8, situation recall |
| multimodal | `eval/data/multimodal` | 64 KB, 13 | C (sha256-pinned) | ingestion format fixtures | Cat 11 |
| n13-code-scout | `eval/data/n13-code-scout` | 104 KB, 9 | G (vendored `pathe` sources) | code corpus and gold | N13 |
| messy-company-v1 | `eval/data/messy-company-v1` | 5.9 MB, 714 | G (LLM labels, ledger in `cost/`) | 226 pages (118 dev, 108 held-out), 9 gold lanes | messy-company loader and scorers |
| skillopt-method-v3 (v1, v2) | `eval/data/skillopt-method-v3` | 11 MB, 27 | G | task sets for briefing, fact-check, query; `world/pages.jsonl` | N15, Cat 30 to 33 |
| system-one-v1 | `eval/data/system-one-v1` | 7.0 MB, 741 | C (copied from a gbrain feature branch) | labelled inputs per System One slot | system-one-jev |
| source-swamp-v1 | `eval/data/source-swamp-v1` | 88 KB, 21 | C | chat archive plus one useful note | Cat 13b |
| gold | `eval/data/gold` | 48 KB, 6 | C | Cat 13 embedder subset (50 queries), contradictions, preferences, poison | several |
| baselines, qrels | `baselines/v0.41-launch.baseline.ndjson`, `qrels/` | 32 KB | C | offline keyword baseline, 12 queries | `scripts/generate-v0.41-launch.ts --check` (CI) |

Most offline runners do not read a corpus at all: they generate a small world in code from a fixed seed (`eval/generators/*-gen.ts` imported at run time). That makes them deterministic and self-contained.

### 5.2 Downloaded at run time (not in the repo)

| Dataset | Source and pin | Lands in | Code |
|---|---|---|---|
| LongMemEval-S cleaned | Hugging Face `xiaowu0162/longmemeval-cleaned` @`98d7416c`, sha256 `d6f21ea9...`; 500 questions, 470 answerable | `$GBRAIN_EVALS_DATASETS` (default `~/datasets/gbrain-evals`)`/longmemeval/` | `eval/runner/memory-qa/corpus.ts:108-110` |
| LongMemEval-M cleaned | same repo, sha256 `9d79e552...`, 2.7 GB | same | `corpus.ts:114-116` |
| LongMemEval-S (older runner default) | manual download | `~/datasets/longmemeval/longmemeval_s.json` | `eval/runner/longmemeval.ts:75`; reports used the cleaned file, so pass `--path` |
| LoCoMo `locomo10.json` | `snap-research/locomo` @`3eb6f2c`, sha256 `79fa87e9...` | dataset root `/locomo/` | `corpus.ts:103-105` |
| BEAM 100K, 1M, 10M | manifests committed in `eval/decisions/datasets/beam-*.json`; text not committed | `GBRAIN_EVALS_BEAM10M_ROOT` or dataset root | `eval/runner/memory-qa/beam10m-corpus.ts:44-47` |
| Agent-memory harness | `vectorize-io/agent-memory-benchmark` @`f618ed7` | `.harness/` | `eval/runner/harness-env.ts` |
| Sealed sets | custodian host only; sha256 commitments in public manifests | custody root | `eval/custody/`, `sealed-confirmation-lib.ts` |

### 5.3 Caches

No embedding vectors or embedding caches are committed. LongMemEval writes `eval/reports/longmemeval/embed-cache/embed-cache-<model>@<dims>.sqlite` (gitignored). A full LongMemEval-S cache is about 700 MB, keyed by model, dims and the SHA-256 of the text (`eval/data/longmemeval/embed-cache/README.md`). The cat40 large and wide worlds (41 MB, 7 MB) are regenerated with `bun eval/generators/model-ladder-gen.ts --scale large|wide`.

## 6. Metrics, scoring and reference numbers

### 6.1 Metrics and scoring methods

| Metric or method | Definition | Where | Used by |
|---|---|---|---|
| `recall_all@k` (strict) | 1 if every gold evidence session is in the top k | `eval/runner/metrics.ts:102` | LongMemEval headline, sealed confirmation, LongMemEval-M pilot |
| `recall_any@k` | 1 if at least one gold item is in the top k (diagnostic; the old inflated headline) | `metrics.ts:110` | LongMemEval diagnostics, competitor comparisons |
| nDCG@k | discounted cumulative gain with binary relevance, normalized | `metrics.ts:138` | Cat 13 (nDCG@5), LongMemEval |
| Precision@k, Recall@k | mean over applicable queries; crashed probes stay in the denominator as 0 (`probe-accounting.ts`) | `eval/runner/types.ts`, `metrics.ts` | multi-adapter, Cat 1, shootout driver |
| rank-1 hit rate | top result is the gold page | Cat 13b | source swamp |
| Latency P50/P95/P99 | per engine operation | `perf.ts`, `graph-backend/analyze.ts` | Cat 7, graph backend |
| Pass/fail gates | per-category thresholds and preregistered floors (for example `docs/benchmarks/2026-10-02-ci-slices-preregistration.md` for N1 and N5 CI slices) | each runner, `eval/regression/situation-recall-v1.json` | offline tier, situation recall |
| QA accuracy | reader answers judged by the official LongMemEval prompt with `gpt-4o`; secondary judges | `longmemeval-answers.ts`, `batch/w10*.ts`, `memory-qa/qa*.ts` | LongMemEval end-to-end, Q1 scoreboard |
| LLM judges | rubric judges; blind pairwise judges for Cat 14, 20, 29 | `eval/runner/judge.ts` (default `claude-haiku-5-5`) | paid categories |
| Statistics | Wilson and Clopper-Pearson intervals, exact McNemar, paired sign-flip, family-clustered bootstrap with Holm, restricted wild cluster bootstrap-t (Webb weights, 9,999 draws) | `eval/runner/stats/*.ts`, `power/*.ts`, `memory-proof-wave/ni-stats.ts` | decisions, scoreboard, MPW |
| Scoreboard recount | `scoreboard.ts check` recomputes per-question values, cohorts, aggregates, Holm families and README text from committed rows and compares byte for byte | `eval/runner/scoreboard.ts:1-60` | `bun run validate` |

### 6.2 Reference numbers

Canonical places: `README.md:169-218` (generated scoreboard block), `docs/scoreboard.md` (method), `docs/comparison-systems.md` (pin table and cross-system rows), `docs/receipts-manifest.json` (352 published claims: 344 covered, 8 disclosed gaps; each with artifact path, sha256, JSON-pointer values and a golden test), `docs/retrieval-lessons.md`, and `docs/README.md` (index of all reports).

| Benchmark | Metric | gbrain number | Source |
|---|---|---|---|
| LongMemEval-S, release config, opaque session ids | strict `recall_all@5` | 95.96% (451/470); hybrid without rerank 92.77% (436/470) | `docs/benchmarks/2026-10-04-longmemeval-opaque-followups.md` |
| LongMemEval-S, ranker wave | strict `recall_all@5` | 95.53% (449/470) | `docs/benchmarks/2026-09-06-longmemeval-ranker-wave.md` |
| LongMemEval-S end-to-end | QA accuracy, Sonnet 5.5 reader, official `gpt-4o` judge | 93.6% (468/500), 95% CI 91.1 to 95.6 | `docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin.md` |
| BrainBench v1 relationships | Recall@5; Precision@5 (corrected denominator) | 94.6%; 29.9% to 35.4% | `docs/benchmarks/2026-04-18-brainbench-v1.md` |
| Cat 13b source swamp | rank-1 hit rate | 93.3% (gbrain v0.22.0) | `docs/benchmarks/2026-04-25-brainbench-cat13b-source-swamp.md` |
| Q1 scoreboard BEAM-10M at 8k | accuracy, three-reader mean | gbrain-defaults 56.3%; file agent 67.2% | `README.md:169-218` (measures gbrain 0.60.138.0, not current master) |
| Graph backend | latency per tier | pinned values such as team pooled p95 1438.8 ms | `docs/benchmarks/2026-10-17-graph-backend/`, `docs/receipts-manifest.json` |

Competitor numbers on LongMemEval (MemPalace, Mem0, Zep and others) use different metrics, readers and judges; `docs/comparison-systems.md` says they are not a leaderboard (G3).

None of these headline numbers is a good parity gate: they need paid embeddings, a reranker and LLM readers, and they move with provider behavior. For parity, the reference is a fresh TypeScript run on the same machine, compared receipt to receipt (section 9.3).

## 7. gbrain internals the runners use

Full inventory with file:line for every symbol, signatures at the pins, and a file x specifier matrix: G1.

### 7.1 Export-map imports (`gbrain/*`, pin `6ce7195`)

| Specifier (files) | Resolves to | Symbols used (files) | What runners call |
|---|---|---|---|
| `gbrain/pglite-engine` (56) | `gbrain:src/core/pglite-engine.ts` | `PGLiteEngine` (40 value, 15 type-only), `computeSnapshotSchemaHash` (1) | `new PGLiteEngine()`, then `connect({})` or `connect({database_path})`, `initSchema()`, engine methods (7.3), `disconnect()` |
| `gbrain/ai/gateway` (47) | `gbrain:src/core/ai/gateway.ts` | `configureGateway` (30), `__setEmbedTransportForTests` (19), `__setChatTransportForTests` (5), `getEmbeddingDimensions` (6), `getEmbeddingModel` (5), `chat` (3), `diagnoseEmbedding` (2), `toolLoop` (1), `embed` (1), `resetGateway`, `getChatModel`, `getExpansionModel`, `validateModelId`, `rerank`, other `__set*TransportForTests` | configure models once per process; keyless stubs for embeddings and chat; real `chat`, `toolLoop`, `rerank` in paid runners; model ids for receipts |
| `gbrain/types` (24) | `gbrain:src/core/types.ts` | type-only: `SearchResult`, `HybridSearchMeta`, `PageType`, `PageInput`, `BrainHealth`, `SearchOpts` | none at run time; the JSON shapes matter |
| `gbrain/operations` (21) | `gbrain:src/core/operations.ts` | `operations` (3), `operationsByName` (2), `OperationError` (1); types `OperationContext` (17), `Operation`, `ParamDef`, `AuthInfo` | `op.handler(ctx, params)` (7.4) |
| `gbrain/search/hybrid` (16) | `gbrain:src/core/search/hybrid.ts` | `hybridSearch` (15), `RRF_K`, `PRE_FUSION_POOL_FLOOR`, `rrfFusionWeighted`, `cosineReScore`, `cosineSimilarity`, `runPostFusionStages`, `applyAliasHop`, `stampUnverifiedExtractions`, `shouldBoostCompiledTruth` (1 each) | `hybridSearch(engine, query, {limit, expansion: false, expandFn?, ...})`; `relational-ab.ts` rebuilds the post-fusion pipeline from parts |
| `gbrain/core/skillopt` (16) | `gbrain:src/core/skillopt/index.ts` | `runSkillOpt` (6), `scoreSkillOnTasks` (5), `runRollout` (4), `loadHeldOut` (4), `describeJudges`, `scoreSkillPerTask`, `scoreTrajectory`, `rolloutToolsForSkill`, `SKILLOPT_HOOK_BUDGET_EXHAUSTED` | skill optimizer runs (Cat 30 to 33, `skillopt-method/`) |
| `gbrain/import-file` (14) | `gbrain:src/core/import-file.ts` | `importFromContent` (13), `importFromFile` (1) | `importFromContent(engine, slug, markdown, opts)`; `eval/runner/import-embedded.ts` wraps it to fail on `embedding_deferred` |
| `gbrain/config` (12) | `gbrain:src/core/config.ts` | `loadConfig` (7), `configPath` (3), type `GBrainConfig` | read the hermetic `GBRAIN_HOME` config |
| `gbrain/engine` (11) | `gbrain:src/core/engine.ts` | type `BrainEngine` (10), `MAX_SEARCH_LIMIT` (1) | type annotations |
| `gbrain/link-extraction` (5) | `gbrain:src/core/link-extraction.ts` | `extractPageLinks` (4), `extractEntityRefs`, `parseTimelineEntries`, type `SlugResolver` | deterministic parsing with no engine (Cat 2, 6, 10, 27) |
| `gbrain/embedding` (4) | `gbrain:src/core/embedding.ts` | `embedQuery` (3), `embed` (2), `embedBatch` (1) | vector adapters |
| `gbrain/extract` (4) | `gbrain:src/commands/extract.ts` | `runExtract` (3) | `runExtract(engine, ['links', '--source', 'db'])`: an in-process CLI call |
| `gbrain/think` (3) | `gbrain:src/core/think/index.ts` | `runThink`, types `ThinkLLMClient`, `ThinkResult` | `runThink(engine, {question, rounds, ...})` with an injected LLM client (Cat 14, 25, 29, PrecisionMemBench) |
| `gbrain/ai/invocation-guard` (2) | `gbrain:src/core/ai/invocation-guard.ts` | `withAIInvocationGuard` | skillopt rollouts |
| `gbrain/search/expansion` (1) | `gbrain:src/core/search/expansion.ts` | `expandQuery` | passed as `expandFn` (`longmemeval.ts:1353`) |
| `gbrain/core/model-pricing` (1) | `gbrain:src/core/model-pricing.ts` | `canonicalLookup` | budget ledger prices |
| `gbrain/transcription` (1, dynamic) | `gbrain:src/core/transcription.ts` | `transcribe` | Cat 11 audio (keyed) |

`gbrain-cues` (pin `939232f`) is used through `pglite-engine`, `operations`, `search/hybrid`, `ai/gateway`, `import-file`, `types`, `engine` and dynamic `memory-cues`, `config` and `contextual-retrieval`, by Cat 36 and the LongMemEval-M pilot. `gbrain-reader` (pin `e78f1c3`) is used through `eval/longmemeval/reader` (`resolveReaderConfig`, `readerConfigHash`, `READER_MAX_SESSION_CHARS`, `READER_NOTES_SYSTEM_TEXT`, `buildReaderUserText`, `generateAnswer`), `ai/gateway` (`chat`, `configureGateway`), `ai/invocation-guard` (`invokeAI`), `core/model-pricing` and `types`, by the reading-notes runners only.

### 7.2 Imports that bypass the export map

- `importGbrain(gut, 'src/...')` (`eval/runner/gbrain-under-test.ts:117`, `import(join(gut.root, subpath))`) in 41 files. Most used subpaths: `src/core/pglite-engine.ts` (18), `src/core/ai/gateway.ts` (17), `src/core/import-file.ts` (15), `src/core/operations.ts` (13), `src/core/search/hybrid.ts` (11), `src/core/config.ts` (5), `src/core/ai/invocation-guard.ts` (5), `src/mcp/dispatch.ts` (3, `dispatchToolCall`), `src/core/engine-factory.ts` (3, `createEngine`), plus about 40 more single-use paths (`feedback/*`, `eval-contradictions/*`, `access/*`, `persistence/*`, `line-grammar.ts`, `migrate.ts`, `src/mcp/server.ts` `handleToolCall`, `src/cli.ts`).
- Relative deep paths into `node_modules/gbrain/src/...` in 96 files, for example `core/search/{mode,source-boost,dedup,intent-weights,exact-lookup,token-budget,query-intent}.ts` (Cat 13 and 13b ranking internals), `core/cycle/propose-takes.ts` (Cat 15), `core/brainstorm/orchestrator.ts` (Cat 20), `commands/extract-conversation-facts.ts`, `core/transcripts/ingest.ts`, `core/cycle/synthesize.ts` (Cat 35), `core/entities/resolve.ts` (Cat 23, N4), `core/page-state/projections.ts` (Cat 3), `core/embedding-pricing.ts` (budget ledger), `eval/longmemeval/*` (batch lane).

These files test gbrain functions that are not storage: ranking stages, extraction, synthesis, entity resolution. A Rust storage engine leaves them unchanged; a Rust binary would need a CLI or MCP route for each, or they stay TypeScript-only.

### 7.3 BrainEngine methods called directly by runners

`BrainEngine` at the pin has 197 method signatures plus `readonly kind: 'postgres' | 'pglite'` (`gbrain:src/core/engine.ts:830-2890`). Runners call about 35 of them directly; gbrain code they import reaches most of the rest. Files whose text contains `.method(` (name matches, so generic names overcount):

| Method | Files | Method | Files | Method | Files |
|---|---|---|---|---|---|
| `disconnect` | 120 | `getChunks` | 10 | `getStats` | 2 |
| `connect` | 103 | `putPage` | 7 | `getLinks` | 2 |
| `initSchema` | 90 | `traversePaths` | 6 | `insertFact` | 2 |
| `setConfig` | 64 | `transaction` | 6 | `updateSlug`, `unsetConfig` | 1 each |
| `executeRaw` | 60 | `deletePage` | 5 | `traversePathsDetailed`, `sweepSegments` | 1 each |
| `getConfig` | 18 | `traverseGraph`, `softDeletePage`, `searchVector` | 4 each | `searchTitles`, `searchKeywordChunks` | 1 each |
| `getPage` | 15 | `readPageSnapshot`, `listPages` | 4 each | `getTimeline`, `getHealth` | 1 each |
| `searchKeyword` | 14 | `addLink` | 3 | `getBacklinks`, `findTrajectory` | 1 each |

### 7.4 Operations invoked in-process

Runners call operation handlers directly: `op.handler(ctx, params)` in 31 files, found with `operations.find(o => o.name === N)`, `operationsByName[name]` or a map built from `operations`. `OperationContext` fields set: `engine`, `config` (for example `{engine: 'pglite', database_path: ':memory:'}`), `logger`, `dryRun`, `sourceId: 'default'`, `remote` (`true` in 23 files, `false` in 54), `transport` (`'http'` in 2), `takesHoldersAllowList` (4). `auth` is never set.

| Operation | Literal call sites | Notes |
|---|---|---|
| `get_page` | 56 | many arms |
| `search` | 46 | many arms |
| `put_page` | 19 + 3 lookups | write |
| `remember` | 17 | Cat 41, scenarios |
| `memory_cues` | 9 lookups | cue arms |
| `query` | 8 + 3 | read |
| `recall` | 7 | read |
| `delta`, `think`, `assemble_evidence` | 1 each | belief probes, evidence delivery |
| `list_pages`, `traverse_graph`, `get_links`, `get_backlinks`, `get_timeline`, `get_tags`, `get_stats`, `get_chunks`, `resolve_slugs` | via `EXPOSED_READ_TOOLS` | `eval/runner/tool-bridge.ts:41-52` exposes these to model tool loops with `remote: true` |
| `add_timeline_entry`, `add_link`, `put_page` (dry run) | via `DRY_RUN_TOOLS` | `tool-bridge.ts:59` |

In-process MCP dispatch without a transport: `dispatchToolCall` from `src/mcp/dispatch.ts` (`refresh-barrier/runtime.ts`, `live-recall/task-arms.ts`, `strict-pageless/agent.ts`, `nightly/tool-contract.ts`, `systems/gbrain-agent.ts`, N6, N13) and `handleToolCall` from `src/mcp/server.ts`. They return the MCP `{content: [{type: 'text', text}], isError}` envelope but cross no process boundary.

### 7.5 Runners that already drive gbrain out of process

| Driver | File:line | How gbrain is started | What it speaks | JSON parsed |
|---|---|---|---|---|
| `CliDriver` | `eval/runner/lifecycle/drivers.ts:73,87` | `spawn('bun', [<build>/src/cli.ts, ...args], {env, cwd: GBRAIN_HOME})` | `call <tool> <json>`, `config get <k>`, `sources writer status --json`, ... | yes |
| `McpStdioDriver` | `lifecycle/drivers.ts:117,143` | `spawn('bun', [entry, 'serve'])` | JSON-RPC over stdio | yes |
| `McpHttpDriver` | `lifecycle/drivers.ts:287,298` | `spawn('bun', [entry, 'serve', '--http', '--port', N])` | `POST /mcp`, OAuth client credentials via `/token` | yes |
| `McpClient` | `eval/runner/cat40/gbrain-arm.ts:60,93` | `spawn('bun', [<build>/src/cli.ts, 'serve', '--surface', <s>])` | `initialize` (protocol `2025-06-18`), `notifications/initialized`, `tools/list`, `tools/call` | yes |
| N6 Postgres HTTP | `eval/runner/n6-postgres-http.ts:351,217,234,271` | `serve --http --bind 127.0.0.1 --port N` | `POST /mcp`, token, `DELETE /mcp` | yes |
| Predictive CLI arm | `eval/runner/predictive/cli-arm.ts:102,227` | `execFile('bun', ['--no-env-file', cli.ts, ...argv])`; `McpClient` | model-chosen argv; MCP | text to the model; MCP JSON |
| Nightly smokes | `eval/runner/nightly/smokes/harness.ts:108,174` | `bun --no-env-file cli.ts ...`, `serve --http`, `GET /health` | CLI and HTTP | partly |
| Hooks | `eval/runner/p4-stream/hooks.ts:16`, `t0/delivery.ts:76`, `t0/parity.ts:48,125` | `bun cli.ts hook <event>`; MCP config `{command: 'bun', args: [cli.ts, 'serve', '--surface', 'starter']}` | hook stdin/stdout, MCP | no |
| Cat 34 | `eval/runner/cat34-brainbench-memory.ts:268-278` | `Bun.spawnSync(['bun', <checkout>/src/cli.ts, 'eval', 'brainbench'])`, keys stripped | gbrain's own conformance suite | exit code and output |
| Cat 41 container | `eval/runner/cat41/in-container.ts:59,236` | `box.gb(argv)` in Docker | `call list_pages`, `call recall`, `init --pglite --no-embedding --json`, `remember`, `config set`, `serve` | yes for `call` and `init --json` |
| Chronicle lift, memory-trust flag-rate, system-one | `chronicle-lift.ts:195-221`, `memory-trust/flag-rate.ts:149-188`, `system-one-jev.ts:249,301` | `spawnSync('bun', [<root>/src/cli.ts, ...])` | `init --pglite ...`, `config set`, `trust review --json`, `decide ...` | partly |
| MPW harness provider (Python) | `eval/harness-provider/mpw/gbrain_provider.py:295-375` | `subprocess.run([bun, MPW_GBRAIN_CLI, ...])` | `init --pglite --db-only --non-interactive --json`, `apply-migrations --yes --no-autopilot-install`, `config set/unset`, `--version`, `models --json` | yes |
| gbrain-defaults shim (Python) | `eval/systems/gbrain-defaults/shim.py:62,193,480,684` | `GBRAIN_BIN` (default `gbrain`), the only native-binary path | `init --pglite --json`, `doctor --json`, `jobs list --json`, `search modes --json`, `models --json`, `config ...`, `extract-conversation-facts --json`, `repair safe-chunks --json`; MCP `serve --surface starter`: `put_page`, `get_write_request`, `list_write_requests`, `query`, `list_pages`, `synthesize`, plus `think`, `recall` | yes; the shim hashes `tools/list` and the resolved config and refuses a mismatch |

No `@modelcontextprotocol/sdk` import exists; every MCP client is hand-rolled JSON-RPC.

## 8. Selecting a Rust engine: how each runner can pick it

Garry confirmed the first build target: a Rust storage engine that implements `BrainEngine` as a third engine inside `garrytan/gbrain`, next to PGLite and Postgres (see `research/storage-engine`). For the evals this changes the question. Runners that construct a `PGLiteEngine` in-process do not need a CLI or MCP adapter: they need an engine switch. Runners that spawn gbrain need the brain's config to name the new engine. Full per-file detail is in G10.

### 8.1 What gbrain (TypeScript) must expose first

These are gbrain-side changes in the checkout under test. Without them no runner can select a Rust engine.

1. A `'rust'` case in `constructEngine` (`gbrain:src/core/engine-construct.ts:10-24`; today the default case throws `Unknown engine type`).
2. Widen the engine unions: `EngineConfig.engine` (`gbrain:src/core/types.ts:2343`), `GBrainConfig.engine` (`gbrain:src/core/config.ts:37`), `BrainEngine.kind` (`gbrain:src/core/engine.ts:832`), and the `openEngine` validator (`gbrain:src/core/engine-open.ts:94`).
3. A `'rust'` branch in `gbrain:src/core/db-lock.ts` (lines 257, 324, 378, 604, 615, 626, 696, 705). Today it throws `Unknown engine kind for db-lock` for any other kind; skillopt (Cat 30 to 33) and every lock user fails without it. About 375 other `engine.kind` checks in `src/` treat "not postgres" as PGLite or "not pglite" as Postgres; each needs a decision.
4. A way for the CLI to create a Rust brain. The CLI reads the engine only from `$GBRAIN_HOME/.gbrain/config.json` (`loadConfig`, `gbrain:src/core/config.ts:744-746`: `DATABASE_URL` forces postgres, else `fileConfig.engine`, else pglite if `database_path` is set). There is no `GBRAIN_ENGINE` variable and no `init --engine` flag; `gbrain init --pglite` writes `engine: 'pglite'` (`gbrain:src/commands/init.ts:1214-1216`). A `--engine rust` (or `--rust`) init path is the one CLI change the out-of-process runners need. A hand-written `{"engine": "rust", "database_path": ...}` already passes through `loadConfig` unchanged.
5. `executeRaw` behavior. The evals send Postgres-dialect SQL (section 8.4), and so does gbrain core. Either the Rust engine accepts the statements the evals use, or the evals move to typed methods. This is open question 3.

### 8.2 One switch on the eval side

Add the switch next to the existing gbrain selector, so the same mechanism that picks the checkout picks the engine:

- `GBRAIN_UNDER_TEST=<gbrain checkout>@<ref>` (or `--gbrain`) already selects a gbrain build that contains the Rust engine, and `all.ts` passes the environment to every child (`all.ts:339-341`).
- New: `GBRAIN_EVAL_ENGINE=pglite|rust` (default `pglite`), read by one new helper `openEvalEngine(gut, {databasePath?})` in `eval/runner/gbrain-under-test.ts` after `importGbrain` (line 119). For `pglite` it keeps `new PGLiteEngine()` so existing receipts do not change. For `rust` it calls `createEngine({engine: 'rust', ...})` from `importGbrain(gut, 'src/core/engine-factory.ts')`. Sketch in G10 section 3. `hermetic-env.ts` does not strip this variable.
- New: the same variable makes the out-of-process helpers write a Rust brain config (`init --engine rust`, or the config file directly, as `eval/runner/evidence-delivery/e3.ts:159` already does for PGLite), and adds `'rust'` to the lifecycle engine axis (`ENGINES` in `eval/runner/lifecycle/slice.ts:37`, `--engines` in `lifecycle-experiment.ts`).
- Receipts: add the engine kind to `resolved_config` and `execution.product`, and stamp `gut.version` rather than `gbrainVersion()` in every runner used as a gate (section 3.3 caveat).

Then: `GBRAIN_EVAL_ENGINE=rust GBRAIN_UNDER_TEST=<checkout>@<ref> bun eval/runner/all.ts --tier offline`.

### 8.3 Buckets

| Bucket | Meaning | Smallest change | Offline tier (37) | Elsewhere |
|---|---|---|---|---|
| A | Already gets its engine from `createEngine(config)` or an injected factory | default the factory to `openEvalEngine`, or set `engine` in config | 0 | Cat 30 to 33 (`engineFactory`), `cat41/brief-db.ts` (`createEngine`) |
| B | Hard-codes `new PGLiteEngine()`, uses public methods only | replace the constructor with `openEvalEngine(gut)`; static importers must also take a `gut` | 10 | 22 files (G10 2b) |
| C | Also uses raw SQL or PGLite internals | constructor swap plus one fix per statement (typed method, a new `ensureSource`, or `executeRaw` support) | 22 | 23 files |
| D | Spawns gbrain; engine comes from `config.json` | write a Rust brain config (`init --engine rust`); add `'rust'` to `lifecycle/slice.ts:37` | 3 | lifecycle-experiment, P4, P8 write-cost, Cat 40, Cat 41, predictive, chronicle-lift, harness provider, gbrain-defaults |
| E | Postgres-specific (`PostgresEngine`, `DATABASE_URL`) | none; stays Postgres-only | 0 | graph-backend, live-recall brain, N6 Postgres HTTP, nightly worker, refresh-barrier child and Postgres arm, scale-latency Postgres branch |
| - | No engine | none | 2 (Cat 2, SO) | verifiers, scoreboard, power, stats |

### 8.4 Offline tier, per runner

Construction site is `file:line` of `new PGLiteEngine()`; `connect({})` is an in-memory brain. "Static" means the runner imports the pinned package (`gbrain/pglite-engine`), ignores `--gbrain`, and must switch to `importGbrain(gut, ...)` before it can measure any other build.

| Runner | Bucket | Construction | Raw SQL or internals to replace | Smallest change |
|---|---|---|---|---|
| Cat 1 `before-after.ts` | B | `:231`, static (`:19`), `connect({})` | none | pass `gut`, `openEvalEngine` |
| Cat 2 `type-accuracy.ts` | - | none | none | none |
| Cat 3 `identity.ts` | B | `:113`, static (`:30`) | deep `page-state/projections.ts` (TypeScript over public methods) | pass `gut`, `openEvalEngine` |
| Cat 4 `temporal.ts` | B | `:505`, static (`:43`) | none | pass `gut`, `openEvalEngine` |
| Cat 6 `cat6-prose-scale.ts` | C | `:781`, dynamic pinned import (`:778`) | `:784-788` links join with `LIKE` | `getLinks` per page |
| Cat 7 `perf.ts` | B | `:296`, static (`:29`) | none | `openEvalEngine`; report latency side by side, do not gate on equality |
| Cat 10 `adversarial.ts` | B | `:208`, static (`:15`) | none | pass `gut`, `openEvalEngine` |
| Cat 11 `cat11-multimodal.ts` | B | `:536`, static (`:54`) | none | pass `gut`, `openEvalEngine` |
| Cat 12 `mcp-contract.ts` | B | `:101` in `setupEngine`, static (`:40`) | none | `openEvalEngine` in `setupEngine`; pass `gut` to `ctx()` (`:146`) |
| Cat 19 `cat19-doctor-remediate.ts` | C | `:282`, static (`:54`) | `:142-145` link and chunk counts | counts from `getStats`, or `executeRaw` subset |
| Cat 22 `cat22-source-isolation.ts` | C | `:238`, static (`:38`) | `:95` `INSERT INTO sources`, `:102` page id lookup, `:149` `INSERT INTO links` | `ensureSource` hook; `getPage`; `addLink` |
| Cat 23 `cat23-phantom-redirect.ts` | B | `:201`, static (`:48`) | none | pass `gut`, `openEvalEngine` |
| Cat 24 `cat24-capture-provenance.ts` | C | `:208`, static (`:63`) | `:126`, `:238` (column probe), `:355` provenance columns | read fields through `getPage` |
| Cat 27 `cat27-graph-signals.ts` | C | `:364`, static (`:64`) | `:305` `INSERT INTO sources`, `:335,342` page ids | `ensureSource`; `getPage` |
| Cat 28 `cat28-federated-sync-latency.ts` | C | `:101`, static (`:52`) | `:106` `INSERT INTO sources`, `:125` count | `ensureSource`; count method |
| Cat 34 `cat34-brainbench-memory.ts` | D | spawns `<checkout>/src/cli.ts eval brainbench` | none | Rust brain config in the child `GBRAIN_HOME`; check whether gbrain's suite hard-codes PGLite (not verified) |
| Cat 36 `cat36-associative-retrieval.ts` (via `cat36-production.ts`) | C | `cat36-production.ts:241`, `gbrain-cues` package, `connect({database_path})` | `:258` `INSERT INTO sources`, `:276` `UPDATE pages SET created_at`, `:244` copies a PGLite snapshot directory | needs a Rust snapshot story or a rebuild path; also pinned to the old `gbrain-cues` build |
| Cat 37, 38, 39 (via `memory-trust/sut.ts`) | C | `sut.ts:179,215` | `:183` `engine.db.dumpDataDir` (PGLite internal), `GBRAIN_PGLITE_SNAPSHOT`, information_schema probes, `UPDATE persistence_brain`, regex scans | one shared file; skip the snapshot fast path on Rust; replace counts; needs `UPDATE` support or typed setters |
| N3 `n3-temporal-asof.ts` | C | `:216` via `importGbrain` | `:335,341,344` slug `ANY`, `LIKE`, facts | `executeRaw` subset or typed list methods |
| temporal-edges | C | `:89` via `importGbrain` | `link_transitions`, `link_relationships`, `to_regclass` | `executeRaw` subset; these are gbrain temporal tables |
| N4 `n4-entity-resolution.ts` | C | `:413` via `importGbrain` | `:431` `INSERT INTO sources`, aliases and facts selects | `ensureSource`; `resolveAliases` |
| N6 `n6-visibility-fuzz.ts` | C | `:636` via `importGbrain` | `:555` `INSERT INTO sources ... WHERE NOT EXISTS`, chunk selects, count | `ensureSource`; `getChunks` |
| N12 `n12-format-fidelity.ts` | B | `:457` via `importGbrain` | none | `openEvalEngine` |
| N13 `n13-code-intelligence.ts` | C | `:197` via `importGbrain` | `:211-218` counts on `code_edges_*`, `symbol_name` | typed code-graph reads |
| N14 `n14-large-page-fidelity.ts` | C | `:699` via `importGbrain` (also a Postgres arm at `:696`) | `:828,847` body-segment columns | keep PGLite-only until segmented storage lands in Rust |
| N15 `n15-skillopt-method.ts` | B | `skillopt-method/headroom.ts:360` `openBrain` | none | `openEvalEngine` in `openBrain` |
| N7 `n7-open-loops-email.ts` | C | `:315` via `importGbrain` | `open_loops` select, update, delete; `INSERT INTO sources` | use gbrain's loops store module through `gut` |
| N8 `n8-proactive-recall.ts` | C | `:296` via `importGbrain` | `:473` `INSERT INTO sources` | `ensureSource` |
| N2 `n2-contradiction-surfacing.ts` | C | `:310` via `importGbrain` | `:337` chunk join, `:345-348` `md5`/`string_agg` signature | hash in TypeScript from `getPage`/`getChunks` |
| A4 `a4-abstention.ts` | C | `:275` via `importGbrain` | `:291` chunk join | `getChunks` per page |
| SO `system-one-jev.ts verify` | - | none | none | none |
| ARS `agent-retrieval-shapes.ts` | C | `:350` via `importGbrain` | `:460,482` counts by source and kind | count method |
| N9 `n9-multi-hop-paraphrase.ts` | C | engine passed to `relational-ab.ts:89` | `:369` links join | `getLinks` per page |
| N1 CI `n1-knowledge-update.ts --slice ci` | D (+B) | lifecycle cell pglite x mcp-stdio; in-process at `:346,414` | none | add `'rust'` to `lifecycle/slice.ts:37`; `openEvalEngine` at the two in-process sites |
| N5 CI `n5-forget-residue.ts --slice ci` | D | `lifecycle/slice.ts:179` (`init --pglite --path`) | none | add `'rust'` to `lifecycle/slice.ts:37` |

Listed H entries: `temporal-ingest-answer.ts:160` (B), `scripts/generate-v0.41-launch.ts:113` (B, loads from `GBRAIN_SRC`), and `forward-reference-heal`, `line-grammar-typing`, `relation-line-variants` (C, all through `eval/runner/p5-brain.ts:70-71`; one fix to `edges()` at `p5-brain.ts:94`, a links join, unblocks all three), `n4-similar-pages.ts:109` (C, `INSERT INTO sources` and a count), `lifecycle-experiment.ts` (D).

### 8.5 Shared fixes that unblock many runners

| Fix | Unblocks |
|---|---|
| `openEvalEngine(gut)` plus moving 14 static importers to `importGbrain` | all 10 offline B runners and 22 other B files |
| An `ensureSource(id, ...)` engine method (the interface has no public source-create; only `updateSourceConfig`) | about ten runners that `INSERT INTO sources`: Cat 22, 27, 28, 36, N4, N4-similar, N6, N7, N8, situation-recall-associative |
| `p5-brain.ts:94` `edges()` through `getLinks` | 3 listed H runners and Q2 gates |
| `memory-trust/sut.ts` without `dumpDataDir` and with typed counts | Cat 37, 38, 39 |
| `'rust'` in `lifecycle/slice.ts:37` and a Rust init path | N1, N5 (CI slices and full), lifecycle-experiment |
| A count-by-source/kind read (or an `executeRaw` subset for `SELECT count(*) FROM pages ...`) | Cat 19, 28, ARS, N4-similar, budgeted-delivery, p5-agent |

### 8.6 Engine lifetime the evals require

- In-memory brains: `connect({})` must give a fresh empty store every time. Most offline runners use this.
- Directory brains: `connect({database_path})` must reopen an existing directory (Cat 36, N14, LongMemEval-M, evidence delivery, P5 agent, messy company, systems).
- Recycling: several runners disconnect and open a new engine in a loop (`memory-qa/run.ts:637-638` every `RECYCLE_EVERY` items; `longmemeval.ts:1268,1295` per question; Cat 25 per probe). `disconnect()` must release locks and files.
- Reset: `memory-qa/run.ts:621-623` and `systems/gbrain.ts:81-83` reset by listing `pg_tables` and running `TRUNCATE ... RESTART IDENTITY CASCADE`. A Rust engine needs a typed reset or these keep PGLite.
- Single writer: PGLite enforces one process per directory (`gbrain:src/core/pglite-lock.ts`); lifecycle runners pause a server around CLI calls on PGLite (`lifecycle/slice.ts:112`). The Rust engine's concurrency model changes these runners' behavior; open question 4.
- Snapshots: Cat 36, Cat 37 to 39 and the LongMemEval-M build copy PGLite data directories as a fast path. A Rust engine needs its own snapshot format or these runners rebuild from scratch.

## 9. Recommendation

### 9.1 Two lanes, in order

1. **Engine lane (now).** The Rust engine runs inside TypeScript gbrain as `engine: 'rust'`. The evals keep importing gbrain in-process; they only need the engine switch from section 8. Parity is "same runner, same gbrain checkout, `GBRAIN_EVAL_ENGINE=pglite` vs `rust`, compare receipts". Most of gbrain-evals can take part, including every runner that tests TypeScript logic on top of storage (search pipeline, extraction, operations, trust gate).
2. **Binary lane (later).** When a Rust CLI or MCP server exists, the out-of-process runners (section 7.5) can point at it. In-process runners that call engine methods or TypeScript internals cannot, unless they are moved to an operation bridge (section 9.2). Do not build the binary adapter before the engine lane works; it would cover far fewer runners.

### 9.2 Smallest adapter surface for a binary

**One launcher seam.** Every out-of-process site builds its argv as `['bun', <root>/src/cli.ts, ...]` except the gbrain-defaults shim, which uses `GBRAIN_BIN`. Add one function, `gbrainCommand(gut): string[]`, next to `importGbrain` in `eval/runner/gbrain-under-test.ts`. It returns `['bun', '--no-env-file', <root>/src/cli.ts]` by default and `[GBRAIN_BIN]` when that variable is set. Call it from: `lifecycle/drivers.ts` (`entryArgs`), `cat40/gbrain-arm.ts:93` (`McpClient`), `predictive/cli-arm.ts:102`, `nightly/smokes/harness.ts:108,174`, `n6-postgres-http.ts:351`, `chronicle-lift.ts:195-221`, `memory-trust/flag-rate.ts:149-188`, `system-one-jev.ts:249,301`, `cat34-brainbench-memory.ts:268`, `p4-stream/hooks.ts:16`, `t0/delivery.ts:76`, `t0/parity.ts:48,125`. In Python, let `MPW_GBRAIN_CLI` hold a full command (`gbrain_provider.py:295-330`).

**CLI commands with JSON that runners parse today.** A binary that wants to replace TypeScript gbrain for these runners must keep these commands, flags and JSON fields:

| Command | Flags seen | Runners |
|---|---|---|
| `init` | `--pglite` (future `--engine rust`), `--path`, `--json`, `--non-interactive`, `--no-embedding`, `--db-only`, `--embedding-model` | lifecycle, N5, Cat 41, harness provider, gbrain-defaults, chronicle-lift, memory-trust |
| `apply-migrations` | `--yes`, `--non-interactive`, `--no-autopilot-install` | harness provider, gbrain-defaults |
| `config get/set/unset` | `--force` | lifecycle, P5, chronicle-lift, harness, gbrain-defaults, Cat 41 |
| `call <op> <json>` | | lifecycle CLI driver, predictive, Cat 41, facts-absorb |
| `doctor --json`, `jobs list --json`, `jobs work`, `search modes --json`, `models --json`, `--version` | | gbrain-defaults (resolved-config hash), harness, facts-absorb |
| `get`, `search`, `query`, `recall`, `list`, `remember` | `--json` | lifecycle, predictive, Cat 41 |
| `sources writer status --json`, `sources retry-held --dry-run`, `sync status`, `sweep --once --json`, `trust review --json` | | lifecycle, P5, memory-trust |
| `extract-conversation-facts --json`, `repair safe-chunks --json` | `--source-id`, `--max-cost-usd`, `--yes`, `--apply` | gbrain-defaults (F6) |
| `hook <event>` | | P4, T0 |
| `eval brainbench`, `eval longmemeval` | | Cat 34, shootout phase 1 |

**MCP.** `serve` over stdio with `--surface starter|full`, and `serve --http --bind --port` with `/mcp`, `/token` (OAuth client credentials) and `/health`. Clients send `initialize` with protocol version `2025-06-18`, `notifications/initialized`, `tools/list` (cursor paging) and `tools/call`. Tools called: `query`, `search`, `get_page`, `get_backlinks`, `traverse_graph`, `list_pages`, `get_chunks`, `remember`, `put_page`, `get_write_request`, `list_write_requests`, `synthesize`, `think`, `recall`, `entity`, `sync`, `context_pack`. The gbrain-defaults shim hashes `tools/list` and the resolved config and refuses a mismatch, so a binary must match tool schemas, not only names. MCP is also much faster than one CLI process per read (TODOS: a local CLI cell takes 8 to 14 minutes against about 1 minute over MCP).

**Operation bridge for handler-based runners.** Runners that call `operationsByName[name].handler(ctx, params)` (Cat 12, Cat 24, `memory-trust/sut.ts`, `tool-bridge.ts`, belief probes, about 31 files) could switch to one `OpBridge` interface with two implementations: in-process handler (today) and `tools/call` over MCP. The catch is the trust boundary: these runners set `remote: true` or `false` per call, and the CLI `call` path is local while MCP is remote. A bridge must keep that distinction or the trust-gate runners measure the wrong thing.

**No binary route.** Direct engine calls (`traversePaths`, `executeRaw`, `readPageSnapshot`), `hybridSearch` stage internals, `link-extraction`, `skillopt`, `runThink` with an injected client, and the 96 deep imports test TypeScript functions, not a product surface. They stay in the engine lane, or become TypeScript-only, until a later Rust phase ports that function and exposes it (for example `query --json --explain`).

### 9.3 How to compare TypeScript and Rust

- Run each gate twice on TypeScript PGLite first. Anything that differs between two TypeScript runs is not a gate until fixed (wall-clock stamps, random seeds, map order).
- Compare receipts, not exit codes: `run_status`, `verdict`, `n_total`, `n_scored`, `errors`, and the per-item rows. Require exact equality for deterministic runners. For ranking runners (keyword, or vector with stub or cached embeddings), compare per-query ranked id lists; report rank-order differences and metric differences separately.
- Record `engine_kind` and the Rust engine build in `resolved_config`, and use `gut.version` for the gbrain version.
- Report latency (Cat 7 `perf.ts`, Cat 28) side by side; do not gate on equality.

### 9.4 Parity gates by phase

**Phase 0: harness, before any Rust code ($0, no keys).**

| Gate | Command | Why |
|---|---|---|
| 0.1 Offline baseline | `bun run eval:brainbench` twice on the pin (TypeScript PGLite) | 37 entries, about 1,322 s serial; establishes the determinism list |
| 0.2 Eval repo health | `bun run validate`; the 48 gbrain-free test files (about 26 s) | unaffected by any engine; catches repo breakage |
| 0.3 Interface baseline | `bun eval/runner/lifecycle-experiment.ts --gbrain-repo <gbrain> --engines pglite --interfaces cli,mcp-stdio,mcp-http` | the only $0 runner that already crosses CLI, stdio MCP and HTTP MCP |
| 0.4 No-op switch | land `openEvalEngine`, move the 14 static importers to `gut`, add the lifecycle engine axis; rerun 0.1 with `GBRAIN_EVAL_ENGINE=pglite` | proves the switch changes nothing before Rust exists |

**Phase 1: first Rust engine slice (pages, chunks, links, timeline, config, keyword search).**

| Gate | Runners | Cost and time | Needs from the Rust engine |
|---|---|---|---|
| 1a | Cat 1, 3, 4, 10, 11, 12, 23, N12, N15, `temporal-ingest-answer`, `scripts/generate-v0.41-launch.ts --check` | $0, under 2 min total | B bucket: public methods only |
| 1b | P5 trio (after the `edges()` fix), Cat 6, 19, 22, 24, 27, 28, N4-similar, N8, ARS, A4, N2, N9 | $0, about 10 min | `ensureSource`, a count read, links and chunk reads |
| 1c | N1 CI and N5 CI slices; lifecycle-experiment with `--engines pglite,rust` | $0, about 4 min for the slices | Rust init path, CLI and MCP through TypeScript gbrain on the Rust engine |
| Report only | Cat 7 `perf.ts`, Cat 28 latency | $0 | |

**Later phases** (each needs more engine surface): Cat 37 to 39 (facts, takes, trust, persistence state), N3 and temporal-edges (facts and temporal tables), N7 (open loops), N13 (code graph), N6 (visibility), Cat 36 (memory cues, snapshots, old `gbrain-cues` build), N14 (segmented large pages), skillopt Cat 30 to 33 (db-lock).

**Retrieval quality (after vector search lands).** LongMemEval-S with `--keyword-only` is keyless and the best large keyword-ranking gate (470 questions; the dataset is a one-time download). Hybrid arms need embeddings: build the embed cache once (about $2 to $7.56 with OpenAI), then warm runs cost $0 for embeddings (about 40 minutes per arm). Rerank arms cost about $0.35 to $0.50 each. These are the first paid gates worth their cost.

**Not parity gates.** Paid LLM categories (Cat 13 to 35 paid rows), sealed sets, the Q1 scoreboard, memory proof wave and model ladders measure model and product behavior, not storage. Postgres-only runners (bucket E) stay Postgres. Runners with no engine (Cat 2, SO, verifiers) do not change.

## 10. Open questions for Garry

1. **Reference engine.** The evals run PGLite today. Should Rust parity be judged against PGLite receipts (what the evals measure now), with known PGLite vs Postgres differences listed separately? The storage-engine map suggests Postgres as the reference behavior where the two differ.
2. **Where the eval-side switch lands.** `openEvalEngine`, `gbrainCommand` and moving 14 static importers to `gut` are gbrain-evals changes. Moving the static importers also changes what those runners measure under `--gbrain` today (they would measure the overlay, not the pin). Should these go to gbrain-evals `main`, or to a branch used only for parity runs?
3. **Raw SQL.** The evals use about 57 `executeRaw` sites with Postgres SQL. Should the Rust engine accept a SQL subset for these, or should the evals move to typed methods, which means adding `ensureSource` and count reads to `BrainEngine` (and so to PGLite and Postgres too)?
4. **Snapshots and single writer.** Can Rust runs skip the PGLite snapshot fast path (Cat 36, Cat 37 to 39, LongMemEval-M) and rebuild from scratch, at the cost of time? Which concurrency model should the lifecycle runners expect?
5. **Equality bar.** Exact receipt equality for the offline gates, and identical top-k order for keyword ranking? Or metric equality within a tolerance?
6. **Pins and CI.** gbrain-evals pins gbrain `6ce7195`. Parity runs would use a `GBRAIN_UNDER_TEST` overlay of a gbrain branch that contains the Rust engine; the overlay runs `bun install --frozen-lockfile` in a `git archive` copy, so a native addon must build or download a prebuilt there. Should gbrain-evals CI get a Rust lane, and who bumps the pin?
7. **Old aliases.** Cat 36 and the LongMemEval-M pilot use `gbrain-cues` (`939232f`, 2026-09-24), and the reading-notes runners use `gbrain-reader` (`e78f1c3`). Are these in scope for Rust parity, or excluded until re-pinned to current gbrain?
8. **Paid gates.** Which paid runs, if any, should gate a Rust phase (for example LongMemEval hybrid with a warm cache), and with what budget?
9. **Binary lane timing.** Until a Rust CLI or MCP server exists, is it enough to add only the `gbrainCommand` seam, or should the operation bridge (section 9.2) be built early?

## 11. Limits of this map

- Nothing was executed against gbrain. Costs and times are copied from registry estimates, budget constants, CI weights and published receipts; many paid runners have no recorded figure and say "unknown" in the appendices.
- Counts of imports, methods and SQL sites come from text search. Generic method names overcount, and dynamic imports built from variables can be missed.
- Several runners were classified from their construction and connect lines plus a grep for SQL, not read in full (marked in G10 section 2b).
- Not verified: whether gbrain's own `eval brainbench` (Cat 34) hard-codes PGLite; the origin of `eval/data/nightly/*.json` and `source-swamp-v1`; the runtime of `decide`, `harness-cell` and `harness-comparator`.
- gbrain-evals moves quickly (a preinstalled clone on the research machine was 3,483 commits behind `main`). Re-check line numbers before acting on them.
