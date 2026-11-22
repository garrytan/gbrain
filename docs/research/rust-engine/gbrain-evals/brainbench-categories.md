> Appendix to [../gbrain-evals.md](../gbrain-evals.md). Detailed per-area notes from one research pass over gbrain-evals `cd447b3` (v0.10.237) and gbrain `6ce7195`. Paths are relative to the gbrain-evals root unless marked `gbrain:`. "G1" to "G10" in the text name the appendix files listed in the main map.

# G2: BrainBench core and category runners

Checkout: the gbrain-evals checkout (HEAD cd447b3, v0.10.237). Paths below are relative to that root.
Method: read the files and grepped imports and call sites. I ran `bun` once, read-only, to print the
tier selection from `eval/registry.ts` (`tiersFor`, `REGISTRY`). No runner was executed. No keys were used.
Cat 40 and Cat 41 (`eval/runner/cat40/`, `cat41/`) are covered by another agent and only referenced here.

## Tier selection (eval/registry.ts, eval/runner/all.ts)

| Tier arg | Registry tiers | Dispatched categories (legacy alias) |
|---|---|---|
| `--tier offline` (default) | H | 1, 2, 3, 4, 6, 7, 10, 11, 12, 19, 22, 23, 24, 27, 28, 34, 36, 37, 38, 39, N3, temporal-edges, N4, N6, N12, N13, N14, N15, N7, N8, N2, A4, SO, ARS, N9, N1-ci, N5-ci (37 total) |
| `--tier paid` | K, P | 13, 13b, 14, 15, 18, 18b, 20, 21, 25, 26, 29, 35, multi-adapter, relational-ab (K), constrained-relational (K), precisionmembench (16 total) |
| `--tier all` | H, K, P | the 53 above |

Not run by any tier (`tier none` or `run.kind = listed`): Cat 5, 8, 9 (cannot run: no reviewed claim catalog or scenario catalog), plus 13b-sit, 36-live, 37-paid, 38-paid, 39-paid, 40, 40-hard, 41, 30-33, temporal-contradictions, temporal-ingest-answer, and the P5 decision-kit rows. `all.ts` lists each one with its reason (`selectCategories`, all.ts:197-210).

Paid guard: any selection with a K or P row refuses to start without `--paid --budget-run-id <id>` (all.ts:523-532, `requirePaidArm`). The default program cap is $500 (eval/RUNBOOK.md:42).

## Summary table

| Runner | Entry path | Measures | Run command | Tier / time / cost | LLM keys | Corpus | Coupling |
|---|---|---|---|---|---|---|---|
| BrainBench umbrella | eval/runner/all.ts | Dispatches registry categories per tier, writes `eval/reports/YYYY-MM-DD-brainbench.md` | `bun eval/runner/all.ts --tier offline` | offline: $0, about 1,322 s serial in CI weights (brainbench-shard-weights.json); paid: see table rows | offline none; paid per child | per child | none (spawns child Bun processes) |
| multi-adapter (Adapters) | eval/runner/multi-adapter.ts + adapters/ | Relational, fuzzy and synthetic-outsider retrieval, P@5 and R@5, 5 adapters | `bun run eval:run`; keyless: `BRAINBENCH_N=1 bun eval/runner/multi-adapter.ts --adapter grep-only --queries relational` | P (in `--tier paid`), timeout 7200 s, cost unknown | `OPENAI_API_KEY` for vector and hybrid adapters | eval/data/world-v1, queries in runner/queries | in-process |
| Cat 1 before-after | eval/runner/before-after.ts | Relational retrieval before vs after graph traversal (world-v1) | `bun eval/runner/before-after.ts` | H, 9 s | none | eval/data/world-v1 | in-process |
| Cat 2 type-accuracy | eval/runner/type-accuracy.ts (+ world-v1-gold.ts) | Link type accuracy vs gold | `bun run eval:type-accuracy` | H, 1 s | none | eval/data/world-v1 | in-process (link-extraction) |
| Cat 3 identity | eval/runner/identity.ts | Alias lookup through keyword search | (via all.ts, `--only 3`) | H, 8 s | none | generated in-run | in-process |
| Cat 4 temporal | eval/runner/temporal.ts | Timeline store and round trip | (via all.ts, `--only 4`) | H, 6 s | none | generated in-run | in-process |
| Cat 6 prose-scale | eval/runner/cat6-prose-scale.ts (+ adversarial-injections.ts) | Auto-link precision under prose variants | `bun run eval:cat6` | H, 12 s | none | world-v1 base pages + injections | in-process (dynamic import) |
| Cat 7 perf | eval/runner/perf.ts | Engine op latency P50/P95/P99 at 1K and 10K pages | (via all.ts, `--only 7`) | H, exclusive, 66 s | none | generated | in-process |
| Cat 10 adversarial | eval/runner/adversarial.ts | Robustness on 22 edge cases | (via all.ts) | H, 5 s | none | hand-written in file | in-process |
| Cat 11 multimodal | eval/runner/cat11-multimodal.ts | md/html ingestion fidelity; audio needs a key | `bun run eval:cat11` | H, 6 s | GROQ or OPENAI only for audio | fixtures | in-process (+ dynamic gbrain/transcription) |
| Cat 13 conceptual | eval/runner/cat13-conceptual.ts (+ cat13-gap-localize, cat13-kacf-calibrate, README-cat13-phase-e0.md, adapters/) | Conceptual search nDCG@5 across keyword, vector, hybrid, rerank | `bun eval/runner/cat13-conceptual.ts` (flags in README-cat13-phase-e0.md) | P, report-only, timeout 7200 s, about $3 (registry) | `OPENAI_API_KEY`; `VOYAGE_API_KEY` for rerank | synthetic-v1 concepts | in-process |
| Cat 13b source swamp | eval/runner/cat13b-source-swamp.ts | Curated page vs bulk chat ranking | (via all.ts) | P, report-only, 3600 s, cost unknown | `OPENAI_API_KEY` | generated pages | in-process |
| Cat 14 think calibration | eval/runner/cat14-calibration.ts | Calibrated vs plain think, blind judge | (via all.ts) | P, report-only, 3600 s, cost unknown | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | committed probe set | in-process (gbrain/think) |
| Cat 15 propose-takes | eval/runner/cat15-propose-takes.ts | Claim extraction precision/recall | (via all.ts, needs `--paid --budget-run-id`) | P, paidFlags, 3600 s, cost unknown | `ANTHROPIC_API_KEY` | hand-labeled corpus | in-process (deep import) |
| Cat 18 embedders | eval/runner/cat18-embedding-providers.ts | OpenAI vs Voyage embedders | (via all.ts) | P, report-only, 3600 s, cost unknown | `OPENAI_API_KEY`, `VOYAGE_API_KEY` | synthetic-v1 | in-process |
| Cat 18b matrix | eval/runner/cat18b-embedding-rerank-matrix.ts | Embedder x reranker, 4 cells | (via all.ts) | P, report-only, 3600 s, cost unknown | OpenAI and Voyage | synthetic-v1 | in-process |
| Cat 19 doctor remediate | eval/runner/cat19-doctor-remediate.ts | Doctor/remediate loop moves a sick brain | (via all.ts) | H, 7 s, stub embeddings | none by default; `OPENAI_API_KEY` only with `CAT19_LIVE_EMBED=1` | generated sick brain | in-process |
| Cat 20 brainstorm | eval/runner/cat20-brainstorm.ts (+ cat20-judges.ts keyless re-score) | Grounding and structure of brainstorm ideas | (via all.ts) | P, report-only, 3600 s, cost unknown | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | synthetic-v1 | in-process (deep import) |
| Cat 21 code retrieval | eval/runner/cat21-code-retrieval.ts (+ cat21-paired.ts keyless) | voyage-code-3 vs text-embedding-3-large on symbols | (via all.ts) | P, report-only, 3600 s, cost unknown | OpenAI and Voyage | code corpus fixtures | in-process |
| Cat 22 source isolation | eval/runner/cat22-source-isolation.ts | Federated source scoping leaks | (via all.ts) | H, 7 s | none | generated multi-source brain | in-process |
| Cat 23 phantom redirect | eval/runner/cat23-phantom-redirect.ts | Phantom to canonical redirect resolution | (via all.ts) | H, 6 s | none | generated | in-process |
| Cat 24 capture provenance | eval/runner/cat24-capture-provenance.ts | Provenance write-through, trust gate, dedup | (via all.ts) | H, 6 s | none (provider key names stripped) | generated | in-process (+ operationsByName) |
| Cat 25 trajectory routing | eval/runner/cat25-trajectory-routing.ts | think trajectory routing A/B | (via all.ts, needs `--paid --budget-run-id`) | P, paidFlags, 3600 s, cost unknown | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | committed | in-process (runThink) |
| Cat 26 contextual retrieval | eval/runner/cat26-contextual-retrieval.ts | Contextual retrieval modes | (via all.ts) | P, report-only, 3600 s, cost unknown | `OPENAI_API_KEY` | synthetic | in-process |
| Cat 27 graph signals | eval/runner/cat27-graph-signals.ts | Adjacency, cross-source, session-demote graph signals on/off | (via all.ts) | H, 15 s | none (OpenAI names listed in file, not in H path) | generated | in-process |
| Cat 28 federated sync latency | eval/runner/cat28-federated-sync-latency.ts | Federated import engine overhead (single-thread) | (via all.ts) | H, exclusive, 44 s | none | generated | in-process |
| Cat 29 think vs search | eval/runner/cat29-think-vs-search.ts | think synthesis vs raw search, blind judge | (via all.ts) | P, report-only, 3600 s, cost unknown | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | synthetic-v1 | in-process (runThink) |
| Cat 34 memory conformance | eval/runner/cat34-brainbench-memory.ts | Cross-harness memory conformance via gbrain's own suite | `bun eval/runner/cat34-brainbench-memory.ts` (`--allow-skip` if no checkout) | H, 1 s on the runner; needs external checkout | none; subprocess strips `*_API_KEY` | gbrain repo `evals/brainbench/` | CLI (spawns `bun src/cli.ts eval brainbench` in a gbrain checkout) |
| Cat 35 transcript distill | eval/runner/cat35-transcript-distill.ts (+ cat35-checks, cat35-judges, cat35-transcript-distill-chart) | Planted salient units survive distillation | `CAT35_FULL=1 bun eval/runner/cat35-transcript-distill.ts` (smoke: no env) | P, report-only, 10800 s, $54 (registry, full run) | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | generated transcripts | in-process (deep node_modules imports) |
| Cat 36 associative retrieval (smoke) | eval/runner/cat36-associative-retrieval.ts (+ cat36-corpus, cat36-scorer, cat36-snapshot, cat36-production, cat36-operation-conformance, cat36-grounded-answers) | Span coverage of associative cues (offline smoke only) | `bun eval/runner/cat36-associative-retrieval.ts --offline --smoke` | H, 10 s (timeout 180 s); live arm listed (36-live) | none for smoke; grounded-answers lane uses Anthropic | committed cat36 corpus | in-process (dynamic import of product package) |
| Cat 37 memory poisoning | eval/runner/cat37-memory-poisoning.ts (+ memory-trust/sut.ts, agent.ts) | Attack success off vs on, keyless contracts | `bun eval/runner/cat37-memory-poisoning.ts [--gbrain <checkout>]` | H, 100 s; paid arm (37-paid) listed, $365 | none for H; paid needs `--paid` | generated scenarios | in-process via importGbrain + child Bun workers |
| Cat 38 state resolution | eval/runner/cat38-state-resolution.ts | Current value served across trust tiers | `bun eval/runner/cat38-state-resolution.ts [--gbrain <checkout>]` | H, 47 s; paid arm (38-paid) listed, $16 | none for H (`--model-arm dry` default) | GoldStore generated | in-process via importGbrain, git CLI, child workers |
| Cat 39 deletion audit | eval/runner/cat39-deletion-audit.ts | forget/delete --purge leaves nothing live | `bun eval/runner/cat39-deletion-audit.ts [--gbrain <checkout>]` | H, 31 s; paid arm (39-paid) listed, $5 | none for H | generated targets | in-process via importGbrain |
| temporal-edges (P1 E1) | eval/runner/temporal-edges.ts | Current, as-of and during relationships from linked notes | (via all.ts) | H, report-only, 48 s | none | eval/generators/temporal-edges-gen.ts | in-process (gbrain/operations) |
| temporal-contradictions (P1 E2) | eval/runner/temporal-contradictions.ts | Dream edge_contradictions closes superseded jobs | listed (not in all.ts) | P, listed, paid judge via gbrain gateway | yes (judge) | generated ledger | in-process via importGbrain (gbrain-under-test) |
| temporal-ingest-answer (P1 E3) | eval/runner/temporal-ingest-answer.ts | Correction surfaces as current on agent surfaces | listed (not in all.ts) | H, listed, report-only, needs `--gbrain` pair | none | generated | in-process (gbrain/operations, importGbrain) |
| judge-repeat | eval/runner/judge-repeat.ts | Judge-only repeats over fixed answers (judge SD) | `bun eval/runner/judge-repeat.ts` (see file usage) | paid; cost per call | judge keys per `--judge` | answers.ndjson files | none (no gbrain import) |
| Scoreboard | eval/runner/scoreboard.ts, scoreboard-cli.ts | Aggregates head-to-head rows into tables | `bun run eval:scoreboard check` ($0) | $0 for check/fixture; doctor before spend | none for check | committed rows | none |
| Shared helpers | judge.ts, metrics.ts, types.ts, compare.ts, cost-speed.ts, smoke.ts, world-v1-gold.ts | Scoring, judge, paired compare, cost columns | n/a (library; compare via `bun eval/runner/compare.ts A B`) | n/a | judge.ts: `ANTHROPIC_API_KEY` (default `claude-haiku-5-5`) | n/a | none, except smoke.ts (gbrain/ai/gateway) |
| Query CLIs | eval/cli/query-validate.ts, query-new.ts, world-view.ts; eval/runner/queries/ | Validates or scaffolds retrieval questions; renders world | `bun run eval:query:validate`, `bun run eval:query:new`, `bun run eval:world:view` | $0, no model calls | none | eval/data/world-v1, queries | none (world-view spawns the browser opener only) |

## Cat 1 to 12, the core runners

### Multi-adapter retrieval (eval/runner/multi-adapter.ts, eval/runner/adapters/)

- Entry: eval/runner/multi-adapter.ts. Adapters: adapters/gbrain-inline.ts, adapters/vector-grep-rrf-fusion.ts, adapters/vector.ts, adapters/grep-only.ts. Also adapters/vector-rerank.ts (not wired into `allAdapters`, multi-adapter.ts:666-672), adapters/claude-sonnet-with-tools.ts (Cat 8/9 agent adapter; `query()` throws, adapter.ts:272), adapters/page-results.ts (helper).
- Adapters in `allAdapters` (multi-adapter.ts:666-672): `gbrain` (GbrainInlineAdapter), `graph-oracle-parse` (regex template oracle, upper bound), `vector-grep-rrf-fusion`, `grep-only` (in-memory BM25, not shell grep), `vector`. `--adapter` selects one; unknown names error.
- Measures: relational (auto-built from world-v1 `_facts`, 4 templates, shared with shootout-driver via queries/relational.ts), fuzzy (Tier 5 hand-authored, queries/tier5-fuzzy.ts), synthetic-outsider (Tier 5.5 AI-authored, queries/tier5_5-synthetic.ts). Excludes items with empty `gold.relevant` from retrieval means (multi-adapter.ts header).
- Run: `bun run eval:run` (package.json:21), `bun run eval:run:dev` (`BRAINBENCH_N=1`), keyless: `BRAINBENCH_N=1 bun eval/runner/multi-adapter.ts --adapter grep-only --queries relational` (eval/README.md:27). Flags: `--queries relational|tier5|tier5.5|all`, `--include-subset=<name>`, `--json`, `--receipt-path`. `BRAINBENCH_N` default 5 (multi-adapter.ts:639, read only here).
- Cost and time: registry timeout 7200 s, tier P, `cost_estimate.usd: null` (unmeasured) (registry.ts:1070-1077). No measured wall time found in code; shard weights have no entry. Published: docs/benchmarks/2026-04-19-brainbench-multi-adapter.md (historical, pre-audit), and the retrieval refresh docs/benchmarks/2026-09-09-retrieval-refresh.md.
- LLM keys: `OPENAI_API_KEY` for vector and hybrid (eval/README.md:66). Grep-only and graph-oracle-parse need no key.
- Corpus: eval/data/world-v1 (committed 240-page fictional world), tier5 and tier5.5 query files (committed). Generated at run time: none.
- Metrics: precisionAtK, recallAtK (runner/types.ts, metrics.ts); mean over applicable queries; per-adapter, per-family rows; `ProbeAccounting` (probe-accounting.ts) keeps crashed-adapter probes in the denominator as 0. No statistical test in this file.
- gbrain imports and calls (multi-adapter.ts 49-63):
  - `gbrain/pglite-engine` PGLiteEngine: `connect({})`, `initSchema()`, `putPage(slug, page)`, `traversePaths(seed, opts)`, `disconnect()` (multi-adapter.ts:163-241).
  - `gbrain/extract` runExtract: `runExtract(engine, ['links','--source','db'])`, `runExtract(engine, ['timeline','--source','db'])` (multi-adapter.ts:178-179).
  - Via gbrain-inline.ts: `gbrain/pglite-engine` (PGLiteEngine connect/initSchema/setConfig/disconnect, gbrain-inline.ts:157-279), `gbrain/extract` runExtract (gbrain-inline.ts:221-222), `gbrain/import-file` importFromContent (gbrain-inline.ts:214-215, via import-embedded.ts), `gbrain/search/hybrid` hybridSearch (gbrain-inline.ts:245), `gbrain/ai/gateway` configureGateway / diagnoseEmbedding (gbrain-inline.ts:76-81, 103).
  - Via vector-grep-rrf-fusion.ts: `gbrain/pglite-engine`, `gbrain/search/hybrid` hybridSearch (line 226), `gbrain/ai/gateway` configureGateway (lines 92-102), `importFromContentEmbedded` (line 155), `gbrain/types` types.
  - Via vector.ts: `gbrain/embedding` embed, embedBatch (lines 145, 166); `gbrain/ai/gateway` configureGateway, getEmbeddingModel (lines 112-160).
  - claude-sonnet-with-tools.ts: `gbrain/pglite-engine`, `gbrain/operations` OperationError; engine putPage, setConfig, connect, initSchema (lines 233-251); tool-bridge.ts imports `gbrain/config`, `gbrain/engine`, `gbrain/operations`.
- Coupling: in-process. What a CLI or MCP adapter needs to replace: put_page (ingest), extract links and timeline, traverse paths (`traversePaths` has no CLI equivalent in this file), hybrid search with chunk results and `HybridSearchMeta`, and embedding gateway config.
- Parity-gate fit: deterministic for grep-only and graph-oracle-parse; vector and hybrid call live embeddings (not deterministic unless cached); fast for keyless relational (minutes at BRAINBENCH_N=1 per eval/README.md:36).

### Cat 1 before-after (eval/runner/before-after.ts)

- Measures: 240-page rich-prose corpus, BEFORE configuration (no auto-link, no extract, no traversal) vs AFTER (graph-first). Question: does graph traversal change relational answers?
- Run: `bun eval/runner/before-after.ts` (via all.ts `relational-graph-first`, registry.ts:318). No env flags beyond defaults found.
- Cost and time: $0, H, 9 s (brainbench-shard-weights.json key "1").
- Keys: none. Corpus: committed world-v1 pages, read from disk.
- Metrics: Precision@5, Recall@5 (corrected denominators per the 2026-04-18 report caveat). Published: docs/benchmarks/2026-04-18-brainbench-v1.md (historical).
- gbrain imports: `gbrain/extract` runExtract (called twice), `gbrain/pglite-engine` PGLiteEngine: `connect`, `initSchema`, `putPage`, `getStats`, `traversePaths`, `disconnect`.
- Coupling: in-process. Parity-gate fit: deterministic, fast.

### Cat 2 type-accuracy (eval/runner/type-accuracy.ts, eval/runner/world-v1-gold.ts)

- Measures: per-link-type accuracy of gbrain's `extractPageLinks` against world-v1 gold derived from `_facts`.
- Run: `bun run eval:type-accuracy`; registry row "link-type-accuracy" (registry.ts:326), H, 1 s.
- Gold and scorer live in world-v1-gold.ts, which has no gbrain import (comment at file top), so overlay builds share it.
- Keys: none. Corpus: eval/data/world-v1, committed.
- Coupling: in-process. Imports `gbrain/link-extraction` extractPageLinks and `gbrain/types` (type-only PageType) (type-accuracy.ts:34-35). The only other function call is the local extractor parameter.
- Published numbers: no dedicated docs/benchmarks report located by name. docs/README.md:114 points to BrainBench v1 (2026-04-18) for the original graph extraction change, the nearest match.
- Parity-gate fit: deterministic, fast, one of the cleanest candidates for a CLI JSON seam (extract links).

### Cat 3 identity (eval/runner/identity.ts), alias lookup

- Measures: alias resolution through keyword search (`searchKeyword`) and page chunks.
- Run: via all.ts (`--only 3` or `alias-keyword-lookup`, registry.ts:335). H, 8 s.
- Keys: none. Corpus: generated in-run pages (identity fixtures in file).
- gbrain imports: `gbrain/pglite-engine` only. Engine calls: `connect`, `initSchema`, `putPage`, `getPage`, `searchKeyword`, `getChunks` (identity.ts:119-133), `disconnect`.
- Coupling: in-process. Parity-gate fit: deterministic, fast. Maps directly to MCP `get_page` and keyword `search`.

### Cat 4 timeline (eval/runner/temporal.ts)

- Measures: timeline storage round trip: point ("what happened on date X"), range and similar queries answered from stored timeline entries (temporal.ts header).
- Run: via all.ts (`timeline-round-trip`, registry.ts:343), H, 6 s. Note: the file has NUL bytes, so `rg` treats it as binary; read with `grep -a`.
- Keys: none. Corpus: generated.
- gbrain imports: `gbrain/pglite-engine` only. Engine calls: `connect`, `initSchema`, `putPage`, `addTimelineEntry`, `getTimeline`, `disconnect`.
- Coupling: in-process. Parity-gate fit: deterministic, fast.

### Cat 6 prose-scale auto-link precision (eval/runner/cat6-prose-scale.ts, eval/runner/adversarial-injections.ts)

- Measures: auto-link precision on 500+ prose page variants made by applying injection kinds to world-v1 base pages (extends Cat 10). Question: does the extractor create wrong links under prose?
- Run: `bun run eval:cat6` (package.json:35); via all.ts `prose-autolink-precision` (registry.ts:359). H, 12 s.
- Keys: none. Corpus: world-v1 base pages plus injections (generated deterministically in adversarial-injections.ts).
- gbrain imports: static `gbrain/link-extraction`, `gbrain/types`; dynamic `import()` of `gbrain/pglite-engine`, `gbrain/import-file`, `gbrain/extract` (cat6-prose-scale.ts:778-780). Calls: `importFromContent` (x2), `runExtract(engine, ['links','--source','db'])` and `['links','--by-mention','--source','db']`, engine `connect`, `initSchema`, `executeRaw`, `disconnect`.
- Coupling: in-process. Parity-gate fit: deterministic, medium speed.

### Cat 7 performance (eval/runner/perf.ts)

- Measures: latency P50, P95, P99 and throughput for get_page, get_links, get_backlinks, get_timeline, get_stats, list_pages, search_keyword, traverse_paths, putPage at 1K and 10K pages (perf.ts:297-371).
- Run: via all.ts (`pglite-latency`, registry.ts:368), `exclusive`, 66 s.
- Keys: none. Corpus: generated.
- gbrain imports: `gbrain/pglite-engine`, `gbrain/types`. Engine methods: `connect`, `initSchema`, `putPage`, `addLink`, `getPage`, `getLinks`, `getBacklinks`, `getTimeline`, `getStats`, `listPages`, `searchKeyword`, `traversePaths`, `disconnect`.
- Coupling: in-process. Wall-clock timings are CPU-bound and not comparable across machines; parity gate would need the same host for both sides.

### Cat 10 adversarial (eval/runner/adversarial.ts)

- Measures: no crashes, no hangs over 30 s, no silent wrong data on 22 hand-written edge cases (header).
- Run: via all.ts (`adversarial-robustness`, registry.ts:393). H, 5 s.
- Keys: none. Corpus: inline in file.
- gbrain imports: `gbrain/link-extraction` (`extractPageLinks` x2), `gbrain/pglite-engine` (`connect`, `initSchema`, `putPage`, `getPage`, `searchKeyword`, `traversePaths`, `disconnect`), `gbrain/types`; also `parseTimelineEntries` (1 call).
- Coupling: in-process. Parity-gate fit: deterministic, fast.

### Cat 11 multimodal ingestion (eval/runner/cat11-multimodal.ts)

- Measures: md/html ingestion fidelity via importFromContent, read back via `engine.getChunks(slug)` (header). Audio is a separate modality needing a transcriber.
- Run: `bun run eval:cat11` (package.json:36); via all.ts `text-ingestion-fidelity` (registry.ts:401). H, 6 s.
- Keys: none for md/html. `GROQ_API_KEY` or `OPENAI_API_KEY` for audio, else audio skipped (cat11-multimodal.ts:413-417).
- Corpus: fixtures in-file or committed; no download.
- gbrain imports: static `gbrain/import-file`, `gbrain/pglite-engine`; dynamic `gbrain/transcription` (line 479). Calls: `importFromContent` (x1), engine `connect`, `initSchema`, `getChunks` (x2), `disconnect`.
- Coupling: in-process. Parity-gate fit: deterministic (non-audio), fast.

### Cat 5, 8, 9 (listed, cannot run)

| Cat | File | Status | Why |
|---|---|---|---|
| 5 source attribution | eval/runner/cat5-provenance.ts | `tier none`, listed (registry.ts:350) | no reviewed claim catalog; no gbrain in the loop. Its judge is `judge.ts` and it imports `anthropic-request.ts`. |
| 8 skill compliance | eval/runner/cat8-skill-compliance.ts | `tier none`, listed (registry.ts:375) | no reviewed probe catalog. Imports `adapters/claude-sonnet-with-tools.ts` (tool-bridge into gbrain operations, in-process). ANTHROPIC key. |
| 9 end-to-end workflows | eval/runner/cat9-workflows.ts | `tier none`, listed (registry.ts:384) | no reviewed scenario catalog. Same adapter as Cat 8, plus `judge.ts`. |

Published reports: none for 5, 8, 9.

## Cat 13 family, retrieval and embeddings

### Cat 13 conceptual (eval/runner/cat13-conceptual.ts, cat13-gap-localize.ts, cat13-kacf-calibrate.ts, README-cat13-phase-e0.md)

- Measures: nDCG@5 for conceptual queries (paraphrase, vocabulary substitution) across adapters: keyword (grep-only), vector, vector-grep-rrf-fusion (hybrid), gbrain-inline, and vector-rerank (Voyage rerank-2.5 when `--reranker on`). Held-out concepts are scored once.
- Run: `bun eval/runner/cat13-conceptual.ts` (historical: `CAT13_PROBES=500`, 2026-04-23 report). Ranker-wave flags in README-cat13-phase-e0.md table: `--embedding-model` (default `openai:text-embedding-3-large`), `--embedding-dims 1536`, `--reranker on|off`, `--autocut`, `--seed 42`, `--keyword-arm-confidence-floor`, `--search-pin key=value`.
- Cost and time: registry `cost_estimate.usd: 3` ("about $3 in the 2026-09-09 retrieval refresh", registry.ts:419); timeout 7200 s; tier P, report-only. Historical: "about eleven minutes across four adapters" (2026-04-23 report).
- LLM keys: `OPENAI_API_KEY` for embeddings; `VOYAGE_API_KEY` required for reranker-on and refuses fake embeddings (README-cat13-phase-e0.md). No no-key mode for vector or hybrid.
- Embeddings cache: none documented in this file; cold embeddings are the cost driver (registry basis).
- Corpus: synthetic-v1 concept pages, committed under eval/data (concept split 20 tuning, 10 held-out, seed 42).
- Metrics: nDCG@5 with relevance grade 3 for intended concept, 1 for related (2026-04-23 report). Probe accounting via probe-accounting.ts.
- gbrain imports: `gbrain/ai/gateway` (configureGateway x3), deep `node_modules/gbrain/src/core/search/mode.ts`. Adapters import `gbrain/pglite-engine`, `gbrain/search/hybrid`, `gbrain/embedding`. Engine `setConfig` x5. Cat13 gap-localize additionally calls the hybrid stages through `gbrain/search/hybrid` and `gbrain/engine` (cat13-gap-localize.ts imports, not fully traced: diagnostic only).
- Published: docs/benchmarks/2026-04-23-brainbench-cat13-conceptual.md (historical), docs/benchmarks/2026-09-06-longmemeval-ranker-wave.md (ranker wave; linked from README-cat13-phase-e0.md), docs/benchmarks/2026-10-02-live-negative-controls.md (negative controls for Cat 25 and 13, per docs/README.md).
- Coupling: in-process. Parity-gate fit: needs live embeddings (not deterministic, costly). Good candidate for a CLI seam on `search` with explicit config.

### Cat 13b source swamp (eval/runner/cat13b-source-swamp.ts)

- Measures: whether a curated `originals/` page outranks multiple `chat/` pages with the same phrase. Source-boost signal.
- Run: via all.ts (`source-swamp`, registry.ts:426), P, report-only, timeout 3600 s, cost unknown.
- Keys: `OPENAI_API_KEY` (embeddings). Corpus: generated (ten originals, ten chat pages in the 2026-04-25 setup).
- gbrain imports: deep `node_modules/gbrain/src/core/search/source-boost.ts` (import), `gbrain/ai/gateway` and adapters (gbrain-inline, vector-grep-rrf-fusion, vector, grep-only).
- Published: docs/benchmarks/2026-04-25-brainbench-cat13b-source-swamp.md (historical; 30 queries).
- Coupling: in-process.

### Cat 18 and 18b embedding providers (eval/runner/cat18-embedding-providers.ts, cat18b-embedding-rerank-matrix.ts)

- Measures: Cat 18 is OpenAI vs Voyage embedders end to end (configureGateway per provider, importFromContent, hybridSearch keyword plus vector). Cat 18b is a 2x2 matrix of {OpenAI 1536d, Voyage 1024d} x {reranker off, Voyage rerank-2.5 on} on synthetic-v1.
- Run: via all.ts (`embedding-providers` registry.ts:459, `embedder-reranker-matrix` registry.ts:467). P, report-only, 3600 s, cost unknown.
- Keys: `OPENAI_API_KEY`, `VOYAGE_API_KEY`. Cat 18 exports `makeHashEmbedTransport`, reused by Cat 19 for its stub path (cat19-doctor-remediate.ts:63).
- gbrain imports: `gbrain/ai/gateway` (configureGateway), `gbrain/pglite-engine` (connect, initSchema, setConfig x2, executeRaw, disconnect), `gbrain/search/hybrid` (hybridSearch), `gbrain/types`.
- Published: 2026-10-06-embedding-matrix.md (name match, not checked against the runner text; treat as likely, verify before citing).
- Coupling: in-process.

### Cat 21 code retrieval (eval/runner/cat21-code-retrieval.ts, cat21-paired.ts)

- Measures: MRR, recall@5 and first-place hits for symbol-lookup queries: voyage-code-3 vs voyage-code-4 vs text-embedding-3-large (2026-10-06 report). Backs `reindex --code` nudge.
- Run: via all.ts (`code-retrieval`, registry.ts:491). P, report-only, 3600 s, cost unknown. Re-score is keyless: `cat21-paired.ts` (75-line file, exact sign-flip test over files, Holm correction).
- Keys: `OPENAI_API_KEY`, `VOYAGE_API_KEY`. Corpus: code corpus fixtures.
- gbrain imports: `gbrain/ai/gateway`, `gbrain/pglite-engine`, `gbrain/search/hybrid` (hybridSearch), `gbrain/types`.
- Published: docs/benchmarks/2026-10-06-cat21-paraphrase.md (complete, development evidence).
- Coupling: in-process.

### Cat 26 contextual retrieval (eval/runner/cat26-contextual-retrieval.ts)

- Measures: contextual-retrieval modes (`search.contextual_retrieval` knob resolved through `loadSearchModeConfig`/`resolveSearchMode` in gbrain's mode.ts, consumed by importFromContent) on the inline import path.
- Run: via all.ts (`contextual-retrieval`, registry.ts:531). P, report-only, 3600 s, cost unknown.
- Keys: `OPENAI_API_KEY` (6 references). Corpus: synthetic.
- gbrain imports: `gbrain/ai/gateway` (configureGateway), `gbrain/pglite-engine` (connect, initSchema, setConfig x2, executeRaw, disconnect), `gbrain/search/hybrid` (hybridSearch).
- Published: none found by name in docs/benchmarks.
- Coupling: in-process.

## Model-backed runners (P or K)

### Cat 14 think calibration (eval/runner/cat14-calibration.ts)

- Measures: A/B of calibrated vs plain think through gbrain's `runThink` pipeline, blind judge; win rate, voice, bias axes.
- Run: via all.ts (`think-calibration`, registry.ts:443). P, report-only, 3600 s, cost unknown (`cost_estimate` null).
- Keys: `ANTHROPIC_API_KEY` (generator and judge); `OPENAI_API_KEY` (3 refs, embeddings). Judge: `judge.ts` plus `openai-judge-shim.ts`.
- gbrain imports: `gbrain/think` runThink (4 calls), `gbrain/pglite-engine` (connect, initSchema, setConfig x2, executeRaw, disconnect), `gbrain/ai/gateway` configureGateway, and `import-embedded.ts` (importFromContent).
- Published: docs/benchmarks/2026-05-18-brainbench-cat14-cat15-calibration.md. The advice result there was retracted (erratum dated 2026-09-28), and a rerun is at docs/benchmarks/2026-10-02-cat14-rerun.md (per the report banner).
- Coupling: in-process. Parity-gate fit: needs LLM, not deterministic, slow.

### Cat 15 propose_takes (eval/runner/cat15-propose-takes.ts)

- Measures: precision and recall (F1 on training and unseen splits) of the propose_takes extractor against a hand-labeled corpus.
- Run: via all.ts (`propose-takes`, registry.ts:451, `paidFlags`, so all.ts passes `--paid --budget-run-id`). P, report-only, 3600 s, cost unknown.
- Keys: `ANTHROPIC_API_KEY` (4 refs), with `--paid` required.
- gbrain imports: deep `node_modules/gbrain/src/core/cycle/propose-takes.ts` (EXTRACT_TAKES_PROMPT, PROPOSE_TAKES_PROMPT_VERSION, header). This bypasses package exports listed in COMMON; it is a file-path import.
- Published: docs/benchmarks/2026-05-18-brainbench-cat14-cat15-calibration.md (same report as Cat 14).
- Coupling: in-process (deep import, no engine call). Parity-gate fit: needs LLM; a prompt-level import, so a CLI seam would have to expose the extractor.

### Cat 20 brainstorm grounding (eval/runner/cat20-brainstorm.ts, cat20-judges.ts)

- Measures: whether `gbrain brainstorm` ideas cite real pages and pass gbrain's internal judge; decision rule in cat20-judges.ts header: median of outside judges' mean scores on passing ideas at least 2.5, inconclusive when fewer than 10 ideas pass.
- Run: via all.ts (`brainstorm-grounding`, registry.ts:483). P, report-only, 3600 s, cost unknown. Offline re-score: `cat20-judges.ts` (135 lines, four judges, cluster bootstrap).
- Keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`. Judges in the re-score: claude-sonnet-5-5, gpt-6.1-sol, claude-opus-5-5, claude-fable-5-1.
- gbrain imports: deep `node_modules/gbrain/src/core/brainstorm/orchestrator.ts` (runBrainstorm), `gbrain/ai/gateway` (configureGateway), `gbrain/pglite-engine` (connect, initSchema, setConfig, disconnect), `import-embedded.ts`; `cat18-embedding-providers.ts` (for embedding setup); `synthetic-corpus-loader.ts`.
- Published: docs/benchmarks/2026-10-06-cat20-judges.md (inconclusive: internal judge passed 0 of 216 ideas).
- Coupling: in-process.

### Cat 25 trajectory routing (eval/runner/cat25-trajectory-routing.ts)

- Measures: whether `runThink` routes candidate entities through `classifyIntent`, `resolveEntitySlugWithSource`, `engine.findTrajectory` (header).
- Run: via all.ts (`trajectory-routing`, registry.ts:523, paidFlags). P, report-only, 3600 s, cost unknown.
- Keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, with `--paid --budget-run-id`.
- gbrain imports: `gbrain/think` runThink (4), `gbrain/pglite-engine` (connect, initSchema, setConfig x2, findTrajectory x4, disconnect), `gbrain/ai/gateway`.
- Published: 2026-10-02-live-negative-controls.md (per docs/README.md line 1268 note).
- Coupling: in-process.

### Cat 29 think vs search (eval/runner/cat29-think-vs-search.ts)

- Measures: does `gbrain think` synthesis beat raw `search` payload on multi-page relational questions, judged blind.
- Run: via all.ts (`think-vs-search`, registry.ts:555). P, report-only, 3600 s, cost unknown.
- Keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`. Uses `llm-budget.ts` and `openai-judge-shim.ts`.
- gbrain imports: `gbrain/think` runThink (1), `gbrain/search/hybrid` hybridSearch (1), `gbrain/pglite-engine` (connect, initSchema, setConfig x3, disconnect), `gbrain/ai/gateway`. Imports `cat27-graph-signals.ts` as a helper.
- Published: 2026-10-06-negative-controls.md (negative controls for Cats 14, 20, 29, 35, per docs/README.md:201).
- Coupling: in-process.

### relational-ab and constrained-relational (tier K, not in CLI scope list but dispatched in `--tier paid`)

- eval/runner/relational-ab.ts, eval/runner/constrained-relational.ts. `cost_estimate` $0.07 and $0.05 (measured, OpenAI embeddings only), registry.ts:1079-1088. Imports `gbrain/ai/gateway`, `gbrain/embedding`, `gbrain/pglite-engine`, `gbrain/search/hybrid`, `gbrain/types`. In-process.

## Maintenance, ingestion and safety runners (all H, keyless)

| Cat | Entry | Measures | Time | Coupling |
|---|---|---|---|---|
| 19 | eval/runner/cat19-doctor-remediate.ts | `gbrain doctor --remediate` moves a sick brain; plan, execute, brain_score | 7 s | in-process: `gbrain/ai/gateway`, `gbrain/extract` (runExtract x2), `gbrain/import-file` (importFromContent), `gbrain/pglite-engine` (connect, initSchema, executeRaw, disconnect), and a static deep import of `node_modules/gbrain/src/commands/embed.ts` (runEmbedCore x2, cat19-doctor-remediate.ts:62). Stub embeddings unless `CAT19_LIVE_EMBED=1`. |
| 22 | eval/runner/cat22-source-isolation.ts | Caller scoped to one source cannot see neighbor sources | 7 s | in-process: `gbrain/ai/gateway`, `gbrain/import-file`, `gbrain/pglite-engine` (getPage x2, listPages x4, searchKeyword, executeRaw x4, setConfig x2), `gbrain/search/hybrid` (hybridSearch x2). |
| 23 | eval/runner/cat23-phantom-redirect.ts | Phantom page to canonical redirect, refusal when required | 6 s | in-process: `gbrain/import-file` (importFromContent x2), `gbrain/pglite-engine` (connect, initSchema, disconnect x2). |
| 24 | eval/runner/cat24-capture-provenance.ts | source_kind, source_uri, ingested_via round trip; op trust gate | 6 s | in-process: `gbrain/ai/gateway`, `gbrain/import-file` (importFromContent x3), `gbrain/operations` (`operationsByName['put_page']`), `gbrain/pglite-engine` (executeRaw x4). |
| 27 | eval/runner/cat27-graph-signals.ts | Graph signals on vs off on hybrid search | 15 s | in-process: `gbrain/ai/gateway`, `gbrain/link-extraction`, `gbrain/pglite-engine` (executeRaw x6, setConfig x5), `gbrain/search/hybrid` (hybridSearch x2). |
| 28 | eval/runner/cat28-federated-sync-latency.ts | Federated import engine overhead (single thread, serialization microbenchmark) | 44 s, exclusive | in-process: `gbrain/ai/gateway`, `gbrain/import-file` (importFromContent), `gbrain/pglite-engine` (N engines via Promise.all). |
| 34 | eval/runner/cat34-brainbench-memory.ts | Cross-harness memory conformance through gbrain's published foreign-runner contract | 1 s on runner, depends on checkout | CLI: spawns `bun src/cli.ts eval brainbench --harness all --suite all --json --out <file>` in a gbrain checkout (`GBRAIN_REPO`, `../gbrain`, `~/git/gbrain`), with `*_API_KEY`/`*_AUTH_TOKEN` stripped (cat34-brainbench-memory.ts:268-281). Needs gbrain > v0.42.40.0. |

Published: 2026-06-12-brainbench-memory.md (Cat 34; headline table of know-to-ask, push recall, write-back, continuity).

Cat 19 published: docs/benchmarks/2026-10-02-may-snapshot-reruns.md (the May snapshot's invalid Categories 19, 20 and 21, per docs/README.md:202). Cat 22, 23, 24, 27, 28: no dedicated report found.

## Cat 35 transcript distillation (eval/runner/cat35-transcript-distill.ts, cat35-checks.ts, cat35-judges.ts, cat35-transcript-distill-chart.ts)

- Measures: share of planted salient units (facts, ideas, decisions, vibes, entities) in agent transcripts that survive gbrain's write paths (verbatim, distill lanes). Mechanical checks in cat35-checks.ts are authoritative over judge output (header).
- Run: default smoke is a two-transcript paid setup: `bun eval/runner/cat35-transcript-distill.ts`. Full: `CAT35_FULL=1 bun eval/runner/cat35-transcript-distill.ts` (package.json:37). Via all.ts the registry row forces `env: { CAT35_FULL: '1' }` (registry.ts:583), with timeout 10800 s.
- Cost: registry `cost_estimate.usd: 54` (pre-flight worst case, Opus 5.5 distilling plus gpt-6.1-sol judge, $53.40 on 2026-11-01, not yet measured). Sonnet 4.6 full runs measured $6.20 to $6.36 (2026-08-31 receipts). The default `CAT35_HARD_STOP_USD` is $40, so a full run with the current defaults needs the cap raised (eval/RUNBOOK.md:115-121).
- LLM keys: `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` (RUNBOOK.md:28). Budget: `--budget-usd` or `BRAINBENCH_BUDGET_USD` (RUNBOOK.md:37).
- Corpus: generated transcripts (eval/generators/transcript-distill-gen.ts) and committed gold. Published reports list the transcripts as fixtures.
- gbrain imports: static `gbrain/pglite-engine`, `gbrain/ai/gateway`, `gbrain/import-file`. Deep file imports: `../../node_modules/gbrain/src/core/transcripts/ingest.ts` (runTranscriptsIngest), `node_modules/gbrain/src/commands/extract-conversation-facts.ts` (runExtractConversationFactsCore), `node_modules/gbrain/src/core/cycle/synthesize.ts` (runPhaseSynthesize), plus `node_modules/gbrain/skills/_brain-filing-rules.json` (read at runtime, cat35-transcript-distill.ts:449) and `node_modules/gbrain/package.json` (line 1748). Engine calls: `connect`, `initSchema`, `getPage`, `setConfig` x5, `disconnect`.
- Metrics: salient-unit recall (macro and CI), joint score (evidence-verified recall, added 2026-09-28), per-lane gates. Judges: `gpt-6.1-sol` and Claude judges in cat35-judges.ts.
- Published: docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill.md (headline 88.1% in the report, 74.9% joint for the after lane per the 2026-09-28 addendum; human judge calibration still pending).
- Coupling: in-process, with the deepest node_modules coupling in the scope (it reads gbrain files from disk as well).
- Parity-gate fit: needs LLM, slow, expensive; not a parity gate candidate.

## Cat 36 associative retrieval (eval/runner/cat36-*.ts)

- Entry: eval/runner/cat36-associative-retrieval.ts. Helpers: cat36-corpus.ts (loader, hashes, canonical text, `loadCat36Corpus`), cat36-scorer.ts (span coverage: ndcg, recall, MRR via metrics.ts), cat36-snapshot.ts (index snapshot hashing), cat36-production.ts (production runtime), cat36-operation-conformance.ts (operation-surface replay), cat36-grounded-answers.ts (grounded answer lane, Anthropic SDK, judge.ts).
- Measures: whether cues (associative retrieval, scene and horizon arms) reach source spans. Smoke tier is H and explicitly "not capability evidence" (registry.ts:591).
- Run: `bun eval/runner/cat36-associative-retrieval.ts --offline --smoke` (package.json:40); via all.ts `associative-retrieval-smoke` (registry.ts:591), args `--offline --smoke`, `--output`, timeout 180 s. Live arm (36-live): listed, needs an approved provider profile and the memory-cue build (`gbrain-cues`), registry.ts:600.
- Cost and time: $0, 10 s (shard weights). Live: unknown.
- LLM keys: none for offline smoke. Grounded-answers lane uses `@anthropic-ai/sdk` (cat36-grounded-answers.ts:1) and needs a key.
- gbrain imports: type-only `gbrain/engine`, `gbrain/operations`, `gbrain/types` in cat36-production.ts (lines 5-7); dynamic `import(`${productPackage}/pglite-engine`)` and `import(`${productPackage}/import-file`)` (cat36-production.ts:203-204); `gbrain/ai/gateway` type ChatResult (cat36-grounded-answers.ts:5). The product package is chosen by `cat36ProductPackage(arm)` (cat36-associative-retrieval.ts), which can be `gbrain` or `gbrain-cues`.
- Published: no dedicated docs/benchmarks report located by name. Related plan: docs/plans/2026-09-28-gbrain-10x/PLAN.md, and docs/benchmarks/2026-09-23-situation-recall-protocol.md.
- Coupling: in-process (dynamic import of the product package). Parity-gate fit: smoke is deterministic and fast; live is paid.

## Cat 37, 38, 39 trust and deletion (eval/runner/cat37-memory-poisoning.ts, cat38-state-resolution.ts, cat39-deletion-audit.ts, eval/runner/memory-trust/)

- Shared SUT: eval/runner/memory-trust/sut.ts `openTrustSut(gut)` imports gbrain source by absolute path under the chosen checkout through `importGbrain` (gbrain-under-test.ts:117-119). Imports: `src/core/pglite-engine.ts` (engine module), `src/core/operations.ts` (`operationsByName`), `src/core/token-mint.ts` (`mintLegacyToken`), `src/core/persistence/identity.ts` (`registerLocalWriter`, `readLocalWriter`), `src/core/persistence/service.ts` (`disposePersistenceConsumer`), `src/core/ai/gateway.ts` (`configureGateway`, `resetGateway`), `src/core/import-file.ts` (`importFromContent`), `src/core/context/turn-context.ts` (`assembleTurnContext`), optional `src/core/trust/channel.ts` (sut.ts:201-210).
- Also: cat38 `importGbrain` of `src/core/persistence/ownership.ts` (`claimWorktree`), `src/core/persistence/sync-run.ts` (`performManagedSync`), `src/core/trust/confirm.ts`, `src/core/trust/owner-actions.ts` (cat38-state-resolution.ts:377-405). Cat 39 calls `runExtractFacts` (x4) from the purge path (cat39-deletion-audit.ts).
- Child workers: cat37 and cat38 re-spawn `process.execPath` with `--worker <mode>` via Bun.spawn (cat37-memory-poisoning.ts:743, cat38-state-resolution.ts:829). Coupling is in-process in the workers too.
- `--gbrain <checkout>[@ref]` copies the ref with `git archive` into `.gbrain-overlays/`, runs `bun install --frozen-lockfile`, and verifies the copy (gbrain-under-test.ts header). `checkout_dirty` is recorded. A symlinked overlay is refused by design.

| Cat | Measures | Time (H) | Paid arm | Published |
|---|---|---|---|---|
| 37 memory poisoning | Attack success and benign success, protections off (`gbrain trust disable --all`) vs on, across sessions | 100 s | 37-paid, $365 estimate, listed | docs/benchmarks/2026-10-07-memory-trust-preregistration.md, 2026-10-08-memory-trust-results-paid.md, 2026-10-07-memory-trust-results-harness.md |
| 38 state resolution | Current value served; lower-tier writes do not replace higher-tier ones; trust labels | 47 s | 38-paid, $16 estimate, listed | same 2026-10-07/08 memory-trust reports |
| 39 deletion audit | `forget --purge` and `delete --purge` leave nothing live or recoverable | 31 s | 39-paid, $5 estimate, listed | same reports; registry notes purge targets |

Keyless contracts pass at the shipped tree per docs/benchmarks/2026-10-08-memory-trust-results-paid.md (summary bullet). Paid arms need `--paid --budget-run-id`.

## Other runners in scope

| Runner | Notes |
|---|---|
| judge-repeat.ts | Re-judges fixed answers N times with the registered instrument. Imports `budget-ledger.ts`, `decisions/`, `memory-qa/`, `q1/cell.ts`, `sealed-confirmation-lib.ts`. No gbrain import. Coupling: none. Paid by nature (judge calls). |
| judge.ts | Shared rubric judge, default `claude-haiku-5-5` (judge.ts:150) via tool use, with `fitAnthropicRequest`. Imports `@anthropic-ai/sdk`, `openai-judge-shim.ts`, `llm-budget.ts`. No gbrain import. |
| smoke.ts | Embedder shootout pre-flight. Requires `OPENAI_API_KEY` or `VOYAGE_API_KEY` by provider (smoke.ts:167-168). Imports `gbrain/ai/gateway` (`configureGateway`/ diagnose path). Not in all.ts. |
| compare.ts | Paired comparison CLI: `bun eval/runner/compare.ts A B`. Imports `stats/gates.ts`, `stats/rows.ts`. No gbrain. |
| cost-speed.ts | Cost and speed columns from a cell's rows and proxy usage log. No gbrain. |
| metrics.ts, types.ts, world-v1-gold.ts | Shared primitives and types. No gbrain (types.ts imports metrics.ts). |
| scoreboard.ts, scoreboard-cli.ts | `bun run eval:scoreboard <cmd>` (check, fixture, explain, doctor, plan, smoke, run, status, judge, render, dispute). `check` and `fixture` are $0 (scoreboard-cli.ts header). Imports shootout-cell.ts, metering-proxy.ts, budget-ledger.ts. No direct gbrain import. |
| eval/cli/* | `query-validate.ts` (validates eval/runner/queries), `query-new.ts` (scaffolds), `world-view.ts` (renders HTML from `eval/generators/world-html.ts`). No gbrain import. |
| eval/runner/queries/ | `index.ts` (Tier 5 and 5.5 registry), `relational.ts` (builds 4 templates from world-v1 `_facts`), `validator.ts`. No gbrain. |
| adapters/vector-rerank.ts | Wraps VectorOnlyAdapter with a reranker; imports `ObservedStats` type from `cat13-conceptual.ts`. Used by Cat 13. |

## Cross-cutting observations

- Coupling is overwhelmingly in-process. Of the in-scope runners, only Cat 34 (`cat34-brainbench-memory.ts`, CLI subprocess) crosses a process boundary to gbrain. Cats 37, 38 and 39 call gbrain source through `importGbrain` (absolute-path dynamic import of `src/...` under the chosen checkout, `gbrain-under-test.ts:117-119`), and also spawn their own Bun child workers, which run the same in-process code. No in-scope runner calls `gbrain` CLI or MCP for ingestion or search. For the Rust parity oracle, the seams that exist are: the `gbrain eval brainbench` CLI (Cat 34) and nothing else.
- Engine and function surface used by almost all runners (what a CLI or MCP adapter must reproduce): `PGLiteEngine` `connect`, `initSchema`, `setConfig`, `putPage`, `getPage`, `getChunks`, `searchKeyword`, `listPages`, `getStats`, `addLink`, `getLinks`, `getBacklinks`, `traversePaths`, `getTimeline`, `addTimelineEntry`, `findTrajectory`, `executeRaw`, `disconnect`; and functions `importFromContent`, `runExtract` (`links`, `timeline`, `--by-mention`), `hybridSearch`, `configureGateway`, `extractPageLinks`, `runThink`, `runBrainstorm`, `runEmbedCore`, `operationsByName`, `dispatchToolCall` (memory-trust, n6-visibility and others).
- Imports are not all static. Some runners use `await import('gbrain/...')` (cat6, cat11, cat36-production) and some use absolute `node_modules/gbrain/src/...` file paths that bypass the package `exports` in COMMON.md (cat13, cat13b, cat15, cat20, cat35, plus the non-scope batch/ and skillopt-method/ helpers). Any gbrain move of these files breaks the runner without a type error at the import site.
- The registry is the source of truth for tiers, gates and costs (eval/registry.ts). `all.ts` maps `H` to offline and `K`/`P` to paid, `none` rows are never dispatched, and `RUNNER_HELPERS` classifies every non-registry file under eval/runner/ (registry.ts:1385-1430, with a test named in the comment). Helper files named in this map include cat13-gap-localize, cat13-kacf-calibrate, cat20-judges, cat21-paired, cat30-33, cat35-*, cat36-*.
- Gate versus report-only: all Tier H dispatched rows gate (except temporal-edges, N13, N14, N15, ARS, N9 which are report-only), and every Tier P row is report-only (registry.ts). A gating row can still be held (PromotionRules.held). Report-only results are reported, never a pass.
- Keys in H runners: several H files name provider keys but run stubs or strip them: Cat 19 uses a stub embed transport unless `CAT19_LIVE_EMBED=1`; Cat 34 strips `*_API_KEY` in its subprocess; hermetic-env.ts (lines 41-50) lists every provider key stripped for H children. Cat 11 needs a key only for audio.
- Wall time anchor: `brainbench-shard-weights.json` holds measured seconds per offline category from a 2026-10-23 CI run (BRAINBENCH_CONCURRENCY=2). The sum is about 1,322 s serial (about 22 minutes); shards split it. The file says to refresh it after a runtime change; a missing category fails `test/eval/brainbench-shards.test.ts`.
- Published reports: the category-to-report map is uneven. Dedicated reports exist for Cats 1 (2026-04-18), multi-adapter (2026-04-19), 13 (2026-04-23), 13b (2026-04-25), 14 and 15 (2026-05-18), 20 (2026-10-06), 21 (2026-10-06), 34 (2026-06-12), 35 (2026-08-16), 37 to 39 (2026-10-07/08 memory-trust), and the agent cats 40/41. No dedicated report was found under docs/benchmarks for Cats 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 18 (except a name match), 19 (only inside the May snapshot rerun), 22, 23, 24, 26, 27, 28, 29 (negative controls only), 36, or for the H-tier N-series not in scope.
- Surprise: N15 (SkillOpt method) is marked retired in its own registry row (2026-11-03 per the registry text), yet it stays `dispatched` in tier H (registry.ts:932-933). Cats 30 to 33 are `listed` and deprecated (registry.ts:563-567).
- Surprise: the paid-tier default for Cat 35 is the full run (`env CAT35_FULL=1` in the registry row, registry.ts:583), while the standalone default is a two-transcript smoke. The registry cost ($54) exceeds the default `CAT35_HARD_STOP_USD` ($40, RUNBOOK.md:117), so a full run needs the cap raised first. I did not run it to confirm the refusal; this comes from the RUNBOOK text.
- Surprise: `cat36-associative-retrieval.ts` is one file with two registry rows (smoke H, live P). Its live arm needs `gbrain-cues`, which is a separate pinned package (package.json pins, COMMON.md).
- Doc drift: eval/RUNBOOK.md line 26 says Cats 30 to 33 are deprecated and "deleted once gbrain's removal ... reaches the pin". The registry row agrees. No action taken here.
