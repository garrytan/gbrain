> Appendix to [../gbrain-evals.md](../gbrain-evals.md). Detailed per-area notes from one research pass over gbrain-evals `cd447b3` (v0.10.237) and gbrain `6ce7195`. Paths are relative to the gbrain-evals root unless marked `gbrain:`. "G1" to "G10" in the text name the appendix files listed in the main map.

# g3-longmemeval-pmb: LongMemEval, PrecisionMemBench, situation recall, sealed confirmation, memory proof wave, stats/power/pilot

Checkout: the gbrain-evals checkout (HEAD cd447b3, v0.10.237). Paths are relative to that root. No runner was executed, no API key was used, and no paid command was run. Costs are the figures recorded in committed reports or code, not measured here.

## Summary

| Runner | Entry path | Measures | Run command | Tier / time / cost | LLM keys | Corpus | Coupling |
|---|---|---|---|---|---|---|---|
| LongMemEval retrieval | eval/runner/longmemeval.ts, eval/runner/longmemeval-batch.sh | Strict all-evidence recall (recall_all@k) on 470 answerable questions, plus recall_any, nDCG_any, abstention noise | `bun eval/runner/longmemeval.ts --path <file> --budget-usd N`; `bash eval/runner/longmemeval-batch.sh --dataset s --budget-usd N` | Paid. Embeddings $0 when warm, about $2 to $7.56 cold; rerank about $0.35 to $0.50 per arm; warm arm about 40 min, cold capture about 3.1 h | OpenAI (embeddings), Voyage (rerank arms), Anthropic Haiku (expansion arms). `--keyword-only` needs none | LongMemEval _s cleaned (500 Q, 470 scored); also _m and oracle; downloaded, not committed | in-process |
| LongMemEval answer grounding | eval/runner/longmemeval-answers.ts | Secondary grounding judge over retained evidence (not the official QA scorer) | `bun eval/runner/longmemeval-answers.ts` (flags not read) | Paid, cost unknown | ANTHROPIC_API_KEY | NDJSON evidence stream from a retrieval run | none (type-only gbrain imports) |
| LongMemEval-M cue pilot | eval/runner/longmemeval-m-pilot-*.ts, longmemeval-m-pilot-manifest.py | Recall on a frozen 28-question sample of the cleaned _m history, with memory-cue windows | Stage order in eval/runner/longmemeval-m-pilot-build.ts and -live.ts; feasibility and cost scripts are free | Paid. Full-scale ceiling about $26,801 at 800-byte windows (prereg); pilot not complete | OpenRouter (Sonnet 4.6 cue generation, text-embedding-3-large) | _m cleaned, 2.7 GB, not committed; selection committed | in-process via gbrain-cues alias |
| LongMemEval verifiers | scripts/verify-published-longmemeval.py, scripts/verify-longmemeval-opaque-qa.py, scripts/verify-longmemeval-opaque-followups.py | Recount of committed receipts, paired McNemar, no-leak checks | `python3 scripts/verify-published-longmemeval.py` (also in npm `validate`) | $0, keyless, no network | none | committed docs/benchmarks receipts | none |
| Retrieval refresh | scripts/run-retrieval-refresh.py, scripts/summarize-retrieval-refresh.py, scripts/plot-retrieval-refresh.py | Fixed matrix of non-LongMemEval cells (baselines, relationships, concept, source-swamp, precision); summary tables and SVG | `python3 scripts/run-retrieval-refresh.py`; summarize and plot scripts (matplotlib) | Paid. 2026-09-09: $475 reserved of $1,000, gross $0.7133, conservative bound $4.79 | Voyage, OpenAI, Anthropic via spawned bun runners | committed docs/benchmarks/2026-09-09-retrieval-refresh | CLI-spawn of bun runners, which are in-process inside |
| PrecisionMemBench (gbrain) | eval/runner/precisionmembench.ts | Precision, recall, active passes on 77 single-query cases over 35 beliefs | `bun eval/runner/precisionmembench.ts --mode gbrain-hybrid` (also gbrain-keyword, gbrain-adaptive --entity-max 1 --other-max 1, gbrain-think --paid --budget-run-id) | keyword $0; think about $0.06 per case (one Opus 5.5 case, 2026-11-01) | embedding key for hybrid; Anthropic for gbrain-think | eval/precisionmembench/fixtures (committed) | in-process |
| PrecisionMemBench (any system) | eval/runner/precisionmembench-system.ts, eval/runner/precisionmembench-s3.ts, eval/runner/precisionmembench-instrument.ts | Same scorer over a shim URL, gbrain-shootout or fake system; S3 aggregation; policy sweep | `bun eval/runner/precisionmembench-system.ts --system <shim URL>\|gbrain-shootout\|fake --output <dir>`; `bun eval/runner/precisionmembench-instrument.ts [--keyword]` | Keyword and fake $0; paid with --paid | per system | same fixtures | HTTP (shim) or in-process (gbrain-shootout) |
| Situation recall regression gate | eval/runner/situation-recall-regression.ts, eval/runner/situation-recall-orchestration.ts | Promotion gate: B vs C0 vs C1 across about 50 categories, plus the cat36 primary metric | `bun eval/runner/situation-recall-regression.ts inventory \| compare <manifest> <results> \| collect <profile> <artifact>` | Per-cell budget reserved in a ledger (amounts not read); orchestration spawns drivers | depends on the category driver | eval/regression/situation-recall-v1.json; eval/data/associative-recall-v1 | gate: none; orchestration: CLI (spawn) |
| Situation recall drivers | eval/runner/situation-recall-associative.ts, -cat36.ts, -cat13b.ts, -development.ts, -programmatic.ts, -native*.ts | Cat36 associative recall (all evidence in top-5 chunks), cat13b source swamp; native collectors | Driven by orchestration; usage not read | Programmatic live mode paid | Anthropic (programmatic); others unknown | associative-recall-v1 (120 families, 480 probes) | in-process (dynamic import of gbrain subpaths); native collectors none |
| Sealed confirmation | eval/runner/sealed-confirmation.ts, eval/runner/sealed-confirmation-lib.ts, scripts/sealed-confirmation-overlap.py | Held-out recall and answer accuracy on sealed sets v1 and v2 (labels private, commitment-checked) | `bun eval/runner/sealed-confirmation.ts validate\|run\|answer\|score\|solvability\|evidence-freeze\|evidence-answer\|decide` | Paid. Generation $15.82 (v1), $20.99 (v2) | ANTHROPIC (reader claude-sonnet-4-6), OPENAI (judge gpt-4o-2024-08-06) | eval/data/sealed-confirmation-v1, -v2 (public halves only) | in-process (imports longmemeval.ts run(); loadGbrain) |
| Memory proof wave | eval/runner/memory-proof-wave-*.ts, eval/runner/memory-proof-wave/ | Non-inferiority of gbrain vs memory-bank comparator on sealed BEAM (54 conversations, 1,080 questions) | `bun eval/runner/memory-proof-wave-power.ts simulate`; `bun eval/runner/memory-proof-wave-grouping.ts check`; `bun eval/runner/memory-proof-wave-sealed-analysis.ts --pair <gbrain>:<comparator> --margin 3.5` | Power and grouping $0. Sealed spend cap $450 (prereg) | harness-side keys (judge gemini-3.5-flash); analysis none | eval/data/memory-proof-wave (grouping manifest, harness lock); BEAM public | none (analysis); harness is external |
| Power, stats, pilot | eval/runner/power/*, eval/runner/stats/*, eval/runner/pilot/* | Clopper-Pearson, fixed-sequence, paired and wild-cluster tests; risk-ratio and size-contrast power; 10x wave 1 architecture pilot | `bun eval/runner/power/validate.ts`; `bun eval/runner/pilot/run.ts split\|smoke`; `build <paid flags>` | power and stats $0. Pilot 2026-10-08: $60.48 spent of $80 ledger cap | pilot: ANTHROPIC_API_KEY, OPENAI_API_KEY, OpenRouter | pilot replays frozen W10a captures | pilot: provider HTTP via fetch, one deep import; power and stats: none |

Scope note: the brief lists scripts/summarize-retrieval-refresh.py and scripts/plot-retrieval-refresh.py under a summarize/ path. The files are in scripts/ (there is no summarize/ directory).

---

## LongMemEval retrieval (eval/runner/longmemeval.ts family)

### Entry file and helpers

- Entry: eval/runner/longmemeval.ts (1,707 lines). Header comment lines 1-75 define the scope, metrics and run commands.
- Batch wrapper: eval/runner/longmemeval-batch.sh (N workers, wall budget 600 s per batch, MAX_BATCHES 50, default TOP_K 5, default WORKERS 3; lines 1-80).
- Helpers: eval/runner/longmemeval-cache.ts (embedding cache, bun:sqlite), eval/runner/longmemeval-aggregate.ts (receipt aggregator), eval/runner/longmemeval-chart.ts, eval/runner/longmemeval-validate-ndjson.ts, eval/runner/longmemeval-session-ids.ts (opaque session ids), eval/runner/import-embedded.ts (importFromContentEmbedded), eval/runner/metrics.ts, eval/runner/receipt.ts, eval/runner/budget-ledger.ts, eval/registry.ts:1158-1166 (registry entry).

### What it measures

Question answered: after gbrain imports each question's haystack sessions and runs its retrieval stack (keyword, vector, hybrid, optional expansion or reranker), does the top-k contain every labeled evidence session? The headline is strict recall_all@5 on the 470 answerable questions (30 abstention questions excluded). No LLM answers or judges questions in this runner. QA accuracy lives in separate reader and judge runs (see Published numbers).

### How it is run

- Single run: `bun eval/runner/longmemeval.ts --budget-usd 5` (full run); `--limit 25 --budget-usd 1` (smoke); `--keyword-only` (no embeddings); `--dataset oracle`; `--top-k 5`; `--seed 42`; `--adapters hybrid-sessdiv --overfetch-factor 3`; `--print-plan` (run_config_hash per adapter, no run). Source: header lines 58-67; parseOpts lines 174-224.
- Batch: `bash eval/runner/longmemeval-batch.sh [--dataset s|oracle] [--top-k N] [--adapters a,b] [--workers N] [--budget-usd N]`. The wrapper opens one budget-ledger run shared by all workers and restarts until the NDJSON holds every planned (adapter, question) row (header lines 1-50).
- Other flags: --cache-dir, --no-cache, --ndjson, --output, --max-wall-seconds, --workers via wrapper, --embedding-model, --embedding-dims, --reports-dir, --retain-evidence, --min-recall-all (env LME_MIN_RECALL_ALL), BRAINBENCH_ALLOW_SKIP.
- Paid calls need --budget-usd (or BRAINBENCH_BUDGET_USD). Without it the runner refuses to start (longmemeval.ts:1165-1177). Only a stubbed transport makes no provider request.
- Dataset path default: `~/datasets/longmemeval/longmemeval_<split>.json`, where split s gives `longmemeval_s.json`, oracle gives `longmemeval_oracle.json` (longmemeval.ts:176-190). Reports use the cleaned file `longmemeval_s_cleaned.json` (SHA-256 d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442), so `--path` is needed for the reported run. The header (line 89-91) and batch.sh (line 100) point to the uncleaned xiaowu0162/longmemeval repository. Mismatch noted in the observations below.

### Adapters and pinned search config

- Default adapters: keyword, vector, hybrid, hybrid+expansion (longmemeval.ts:183-189).
- ADAPTER_SPECS (longmemeval.ts:460-468): keyword, vector, hybrid, hybrid+expansion, hybrid-sessdiv, hybrid+expansion-sessdiv, hybrid+rerank, hybrid-sessdiv+rerank.
- PINNED_SEARCH_CONFIG (longmemeval.ts:427-430): search.mode balanced, search.reranker.enabled false, search.autocut false, plus config pins. Rerank specs overlay reranker on with a pinned model (lines 484-488). The pins exist because gbrain's balanced bundle silently enables the reranker when a key is present (header lines 9-14).
- Sessdiv: over-fetch topK x factor chunks and keep K distinct sessions (header lines 69-73).

### Dataset, splits, counts

| Item | Value | Evidence |
|---|---|---|
| Source (cleaned) | huggingface.co/datasets/xiaowu0162/longmemeval-cleaned (reports); original xiaowu0162/longmemeval (runner header, batch.sh) | docs/benchmarks/2026-05-07-longmemeval-s.md; eval/runner/longmemeval-batch.sh:100 |
| _s split | 500 questions, about 50 sessions per question, about 115,000 tokens per question | docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin.md:7 |
| Scored questions | 470 answerable; 30 abstention (`_abs`) excluded from recall denominators | longmemeval.ts header lines 27-41; eval/registry.ts:1163 |
| Question types (answerable) | single-session-user 64, single-session-assistant 56, single-session-preference 30, temporal-reasoning 127, knowledge-update 72, multi-session 121 | eval/data/longmemeval-m-pilot-selection.json (bucket_counts) |
| Raw type counts (500) | knowledge-update 78, multi-session 133, single-session-assistant 56, single-session-preference 30, single-session-user 70, temporal-reasoning 133 | eval/data/longmemeval-m-pilot-selection.json (raw_type_counts) |
| _m split (cleaned) | longmemeval_m_cleaned.json, revision 98d7416c24c778c2fee6e6f3006e7a073259d48f, 2,737,100,077 bytes, SHA-256 9d79e552...ee495f, 500 questions | eval/data/longmemeval-m-pilot-selection.json; docs/benchmarks/2026-09-24-longmemeval-m-pilot-preregistration.md |
| oracle split | evidence sessions only, about 3 sessions per question | longmemeval.ts:62, 178-179 |
| Metrics | recall_all@k: 1 iff every answer session in top-k (headline). recall_any@k: at least one (diagnostic; old inflating headline). ndcg_any@k: binary-graded. abs_noise@k: abstention diagnostic | eval/runner/metrics.ts:102 (recallAllAtK), :110 (recallAnyAtK), :138 (ndcgAtK); longmemeval.ts header 27-41 |

### Committed vs cached vs downloaded

| Artifact | Status | Location |
|---|---|---|
| Dataset JSON (_s, _m, oracle) | Downloaded, not committed | ~/datasets/longmemeval/ (default) |
| Embedding cache (SQLite) | Generated, gitignored, not committed. About 700 MB for full _s (historical) | eval/reports/longmemeval/embed-cache/ (README: eval/data/longmemeval/embed-cache/README.md) |
| Cache README | Committed | eval/data/longmemeval/embed-cache/README.md (no database shipped) |
| M-pilot selection | Committed (8 KB JSON, 28 selected: 24 answerable, 4 abstention) | eval/data/longmemeval-m-pilot-selection.json |
| Per-question receipts and NDJSON rows | Committed | docs/benchmarks/2026-05-07-longmemeval-s (2.5 MB), 2026-09-06-longmemeval-ranker-wave (4.4 MB), 2026-09-09-retrieval-refresh (86 MB), 2026-09-29-longmemeval-opaque-qa (54 MB), 2026-10-04-longmemeval-opaque-followups (21 MB), 2026-10-07-longmemeval-w10a-current-pin (11 MB), 2026-10-07-longmemeval-w10b-reader-replay (4.9 MB), 2026-10-07-longmemeval-w10c-full-context (0.8 MB) |
| Harness cell JSONs | Committed | eval/harness-provider/cells/**/longmemeval-s-*.json, eval/harness-provider/timestamp-manifests/longmemeval-s.json |
| Cache key | Model and dims, SHA-256 of text, and input_type (query or document). A key change orphans old entries | eval/runner/longmemeval-cache.ts header; eval/data/longmemeval/embed-cache/README.md |

### Cost and time (with and without warm cache)

| Item | Figure | Source |
|---|---|---|
| Cold embeddings, _s, text-embedding-3-large 1536d (registry) | about $2 (historical estimate) | eval/registry.ts:1161; docs/benchmarks/2026-05-07-longmemeval-s.md (line 167) |
| Cold embedding of 500 histories, W10a | $7.56 | docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin.md:77 |
| Warm cache, embeddings | $0 for later arms (zero cache misses) | docs/benchmarks/2026-09-06-longmemeval-ranker-wave.md:77; longmemeval.ts:202-205 comment |
| Voyage rerank | $0.35 for 500 queries (W10a); about $0.50 per reranked arm (historical) | W10a line 78; ranker-wave line 222 |
| Haiku expansion | about $1 per expansion variant (historical) | ranker-wave line 222 |
| Cold capture time | 3 h 7 min for 500 histories (22.5 s per question, mostly embedding) | W10a line 84 |
| Warm arm wall time | 2,401 to 2,417 s per reranked or tokenmax arm (about 40 min); A1 cold-built arm 7,505 s | ranker-wave table lines 209-219 |
| Reader and judge (W10a/W10b) | Sonnet 5.5 batch $11.59 for 500 (list $19.84); Opus 5.5 notes $24.01; official judge $0.18 to $0.25 batch | W10a line 79-81; W10b line 110 |
| Full historical program | about $55 actual, $60 booked against $75 cap | ranker-wave line 222 |

Summary: a warm-cache retrieval-only run still pays for reranking or expansion calls. A warm cache removes the embedding cost only. The code comment "complete in minutes for ~$0" (longmemeval.ts:202-205) is not supported by the measured warm arm wall times above, which are about 40 minutes per arm.

### LLM keys and offline modes

- Retrieval runner: OpenAI key for embeddings (`text-embedding-3-large` in reports); Voyage key for rerank arms (fail-closed preflight, longmemeval.ts ADAPTER_SPECS notes); Anthropic key for expansion arms.
- Offline: `--keyword-only` (no embeddings); `--no-cache` disables cache; `__setEmbedTransportForTests` stubs the embed transport for hermetic tests (longmemeval.ts header 17-19).
- Embedding cache (SQLite, WAL, 10 s busy timeout) is the only offline replay path for vectors.

### Published gbrain numbers (retrieval, strict recall_all@5 on 470)

| Report | Build | Configuration | Result | Status |
|---|---|---|---|---|
| docs/benchmarks/2026-05-07-longmemeval-s.md, rescored Aug 31 | v0.28.8 | hybrid | 83.40% (392/470) | superseded |
| same, Sept 2 rerun | v0.48.2.0 | hybrid, reranker off, autocut off | 93.19% (438/470) | historical; opaque recount 436 |
| same, Sept 2 rerun | v0.48.2.0 | hybrid+rerank (Voyage rerank-2.5) | 95.32% (448/470) | opaque recount 451 |
| same, Sept 2 rerun | v0.48.2.0 | hybrid-sessdiv+rerank | 95.53% (449/470) | opaque recount 452 |
| docs/benchmarks/2026-09-06-longmemeval-ranker-wave.md | v0.48.4.0 | release config (balanced, rerank, autocut off) | 95.53% (449/470) | release arm |
| docs/benchmarks/2026-10-04-longmemeval-opaque-followups.md | gbrain 109b992, v0.60.37.0 | release config, opaque ids | 95.96% (451/470) | current; hybrid no-rerank 436 (92.77%) |

### QA accuracy (judged answers, 500 questions)

| Report | Build | Reader | Judge | Result | Status |
|---|---|---|---|---|---|
| 2026-09-06 ranker wave | v0.48.4.0 | claude-sonnet-4-6 | gpt-4o, official prompts | 86.6% (433/500) | INVALID per Sept 28 notice: gold `answer_` prefix leaked to reader |
| 2026-09-29 opaque QA | a7cb37b (v0.59.13.0) | claude-sonnet-4-6, notes mode, 1,024 tokens, reranker off | official evaluate_qa.py 443/500 (house 439/500 = 87.8%) | 87.8% (439/500) | current for that run |
| 2026-10-04 frontier reader | v0.60.37.0 | gpt-5.4 (medium reasoning), official prompt | official 448/500; report headline 447/500 | 89.4% (447/500) | development |
| 2026-10-07 W10a | current pin | claude-sonnet-5-5, notes | gpt-4o official 468/500 (93.6%, exact 95% CI 91.1 to 95.6); secondary gpt-6.1-sol 475/500 | 93.6% (468/500) | current headline |
| 2026-10-07 W10b reader replay | a7cb37b retrieval | claude-opus-5-5 notes (474); sonnet-5-5 notes 462, direct 465; gpt-6.1-sol 464; gpt-5.4 460 | gpt-4o official | Opus 94.8% (474/500) | development |
| 2026-10-07 W10c full context | c5fb0201 retrieval, 150-question subset | sonnet-5-5 whole history 144/150 vs gbrain 139/150 | gpt-4o official | whole history 96.0%, gbrain 92.7% | comparison |

Reader sources: 2026-09-06 and 2026-09-29 use the reader in gbrain-reader (see the Reader section). W10 reports use batch APIs (50 percent list price).

### Competitor numbers (self-reported unless marked; not comparable)

Source: docs/comparison-systems.md (rows 158-183; comparison guide says rows are not a leaderboard). The guide states that the reader, judge, prompts and retrieval metric differ.

| System | Figure | Metric and caveat |
|---|---|---|
| MemPalace raw (ChromaDB), published | 96.6% (483/500) | R@5 any-hit. Our strict recomputation: 85.7% (403/470) |
| MemPalace hybrid v4 + LLM rerank, published | 99.2% (496/500) in committed reproduction; README 100% claim | R@5 any-hit. Our strict recomputation: 90.0% (423/470) |
| Lethe v1 (arXiv 2606.15903) | 93.8% | R@5 gold-session in top-k; recall_all not stated |
| agentmemory | 95.2% R@5 (any-hit) | BM25 plus vector |
| Mem0 (self-reported, April 2026) | 94.4% (472/500); 94.8% at top-50 | QA accuracy, own reader and judge |
| Mem0 (independent, arXiv 2603.04814) | 49.0% | QA accuracy |
| Zep (research page) | 90.2% (451/500) | QA accuracy, gpt-5.4 reader and judge |
| Hindsight (Vectorize) | 91.4% (own repo, Gemini-3 answerer); 94.6% on vendor page | QA accuracy |
| Mastra Observational Memory | 93.6% micro (468/500) gpt-5-mini actor | QA accuracy |
| OMEGA | 95.4% | QA accuracy, self-reported |
| LongMemEval paper, Stella V5 _m | 0.706 R@5 (K=V) | recall_all@k strict, per paper |

The MemPalace and agentmemory R@5 rows are any-hit. gbrain's headline is strict. Do not compare them directly. The comparison page recommends its own guide over this table.

### Reader module (gbrain-reader pin)

- Pin: gbrain-reader -> github:garrytan/gbrain#e78f1c38b947b053f3a46881340f74f316be855a (v0.59.0.0, package.json:71). Export: `"./eval/longmemeval/reader": "./src/eval/longmemeval/reader.ts"` (checked in the gbrain checkout at that commit).
- What it does (src/eval/longmemeval/reader.ts at that commit): builds the reader prompt and user text (renderRetrievedAsHypothesis, buildReaderUserText, buildReaderRequest), with READER_MAX_TOKENS 512 for direct mode and 1,024 for notes mode, READER_MAX_SESSION_CHARS 60,000 per session, prompt version `gbrain-lme-reader-v3-abstention-fullsessions` (direct) and `gbrain-lme-reader-v4-notes-fullsessions` (notes), and sha256 pins (readerConfigHash). generateAnswer calls the gateway and returns the answer with a context receipt (rendered chars, distinct sessions, truncated count). The official prompt has no abstention instruction; this reader adds one, and that difference is disclosed in its header.
- Who imports it: eval/runner/reading-notes-run.ts:6-9 and :22; eval/runner/reading-notes-requests.ts:19-20 and :100 (resolveReaderConfig, readerConfigHash, generateAnswer, READER_MAX_SESSION_CHARS, SearchResult type). eval/runner/longmemeval.ts does not import it. eval/runner/longmemeval-answers.ts has its own Anthropic client and uses the gateway ChatResult type only.
- Coupling: in-process (package subpath import). Not a binary, not MCP.

### Coupling

- In-process. eval/runner/longmemeval.ts imports:
  - gbrain/pglite-engine: PGLiteEngine. Engine methods called: connect, initSchema, setConfig, executeRaw, searchKeyword, searchVector, disconnect.
  - gbrain/search/hybrid: hybridSearch(engine, query, {limit, expansion, expandFn}).
  - gbrain/search/expansion: expandQuery.
  - gbrain/types: SearchResult (type only).
  - gbrain/config: loadConfig.
  - gbrain/embedding: embedQuery (query-side embed for the vector adapter).
  - gbrain/ai/gateway: configureGateway, diagnoseEmbedding, getEmbeddingModel, getEmbeddingDimensions, getExpansionModel, __setEmbedTransportForTests.
  - ai (npm): embedMany (aiSdkEmbedMany).
  - eval/runner/import-embedded.ts -> gbrain/import-file importFromContent (wrapped as importFromContentEmbedded).
- For a CLI or MCP adapter to replace this, the runner would need a way to take (question, sessions) -> ranked session ids for each adapter key, with the same pinned search config and recall metrics. The CLI form in eval/runner comments: `gbrain eval longmemeval ... --mode balanced --reranker on --autocut off` (cited in docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin.md:114).

### Parity-gate fit

Deterministic for keyword and cached-vector arms; needs embedding and rerank providers otherwise. Slow (hours per full run cold). Retrieval is parity-testable through its NDJSON rows. Strongest candidate for a CLI-JSON parity gate once the adapter keys are mapped.

---

## LongMemEval answer grounding (eval/runner/longmemeval-answers.ts)

- Measures: a secondary grounding check of answers against retained evidence. It is not the official answer-accuracy scorer (JUDGE_SYSTEM text, line 21). Reference pages are kept out of the reader's view.
- Judge: JUDGE_MODEL = claude-haiku-5-5 (longmemeval-answers.ts:19). Answer model is a profile field (`answer_model`), with a required thinking floor (lines 136-143).
- Run: `bun eval/runner/longmemeval-answers.ts` (flags and profile file not read). Input is a retained LongMemEval evidence stream from a retrieval run (registry: eval/registry.ts:1168-1170).
- Keys: ANTHROPIC_API_KEY. Cost and time: unknown.
- Imports: @anthropic-ai/sdk (direct), gbrain/types (type), gbrain/ai/gateway (type ChatResult). No engine methods called.
- Coupling: none at runtime (type-only gbrain imports); reads NDJSON evidence.
- Parity-gate fit: needs LLM. Not deterministic.

---

## LongMemEval-M cue pilot (eval/runner/longmemeval-m-pilot-*.ts)

### Files

eval/runner/longmemeval-m-pilot-build.ts, -live.ts (397 lines), -replay.ts, -outcomes.ts, -feasibility.ts, -hypothetical-cost.ts, -import-check.ts, -offset-audit.ts, -batch-payload.ts, eval/runner/longmemeval-m-pilot-manifest.py (Python, ijson), eval/data/longmemeval-m-pilot-selection.json.

### What it measures

Whether gbrain's cue-window (memory cue) retrieval recovers the original evidence on the cleaned _m history, using the strict recall_all@5 formula over 24 answerable questions plus 4 abstention questions (prereg). Scope: 28 frozen questions.

### How it is run

Stages: manifest scan and extract (python, `PYTHONPATH=... python3 eval/runner/longmemeval-m-pilot-manifest.py scan|extract`), feasibility (`bun eval/runner/longmemeval-m-pilot-feasibility.ts <manifest>`, free), build and live (paid, budget ledger). See docs/benchmarks/2026-09-24-longmemeval-m-pilot-preregistration.md:70-83.

### Cost and time

- Prereg ceiling at production 800-byte windows: about 1,007,370 Sonnet calls, about $26,801, about 495 hours serial (lines 46-49). It exceeds the $10,000 authorization.
- Hypothetical: 4,096-byte windows about $1,830 (26.1 h); 8,192-byte windows about $1,191 (14.3 h) (lines 57-61). These are arithmetic, not measured.
- Status in the prereg: four individual B cases observed; not a complete cell. Matched C0 and C1 still required.

### Keys and corpus

- Keys: OpenRouter (openrouter:anthropic/claude-sonnet-4.6 for generation, openrouter:openai/text-embedding-3-large for embeddings; eval/runner/situation-recall-experiment-policy.ts:4-6).
- Corpus: longmemeval_m_cleaned.json (2.7 GB) downloaded to ~/.capy/work/longmemeval-m-pilot/, not committed. Selected source JSON 141,534,917 bytes (not committed; SHA-256 committed).

### Metrics and scoring

Native recall_all@5 over the gold original session ids, with chunk-to-span grounding checks (prereg). Denominator 24 answerable questions.

### gbrain imports (gbrain-cues alias, pin 939232f)

- gbrain-cues/pglite-engine: PGLiteEngine (replay.ts).
- gbrain-cues/search/hybrid: hybridSearch (replay.ts).
- gbrain-cues/ai/gateway: configureGateway (replay.ts); configurePilotC1Gateway (build.ts via gateway type).
- gbrain-cues/import-file: importFromContent (import-check.ts).
- gbrain-cues/types: SearchResult (type).
- gbrain-cues/engine: BrainEngine (type, live.ts:13).
- Deep imports into node_modules/gbrain-cues/src/core/ (not in its exports): markdown (parseMarkdown), markdown-chunks (prepareMarkdownChunks), batch-rows (sanitizeText), embedding-context (buildContextualPrefix, sanitizeTitle, wrapChunkForEmbedding), memory-cues/windows (buildCueWindows), memory-cues/providers (CUE_SYSTEM_PROMPT).
- Engine methods called (build.ts and live.ts): connect, initSchema, setConfig, getConfig, getChunks, disconnect.

### Coupling

In-process (gbrain-cues), with deep imports into the package source. Not a CLI or MCP call.

### Parity-gate fit

Paid and slow. Not a parity-gate candidate until a binary path exists. The feasibility and hypothetical-cost scripts are deterministic and keyless.

---

## LongMemEval verifiers (scripts/verify-*longmemeval*.py)

| Script | What it checks | Input |
|---|---|---|
| scripts/verify-published-longmemeval.py | Recounts saved retrieval outcomes from 2026-09-06 receipts; reproduces per-arm strict counts; hashes artifacts | docs/benchmarks/2026-09-06-longmemeval-ranker-wave/longmemeval |
| scripts/verify-longmemeval-opaque-qa.py | Recounts 2026-09-29 judged answers (including reranker-on arms); re-derives paired gains, losses and exact McNemar p; checks summary.json; checks no saved reader prompt contains the `answer_` prefix or any raw session id | docs/benchmarks/2026-09-29-longmemeval-opaque-qa |
| scripts/verify-longmemeval-opaque-followups.py | Keyless recount of 2026-10-04 items 1a, 1b, 2 using the analysis scripts; checks against committed summaries | docs/benchmarks/2026-10-04-longmemeval-opaque-followups |

- Run: `python3 scripts/verify-published-longmemeval.py` (npm script `validate` runs all three and verify-documentation-refresh.py; package.json).
- Keys: none. Network: none. Cost: $0. Time: not measured.
- Coupling: none (JSON and Python only).

---

## Retrieval refresh matrix (scripts/run-retrieval-refresh.py and helpers)

- Measures: fixed documentation-refresh matrix. Cells include baselines (eval/runner/multi-adapter.ts), relationships (eval/runner/relational-ab.ts), concept-* (eval/runner/cat13-conceptual.ts runCat13), source-swamp, and precision-* (77 PrecisionMemBench cases, 72 search calls; scripts/run-retrieval-refresh.py:229-236). LongMemEval numbers in the 2026-09-09 report are reused records, not new LongMemEval cell runs (docs/benchmarks/2026-09-09-retrieval-refresh.md:20-30).
- Run: `python3 scripts/run-retrieval-refresh.py` (flags such as parallelism up to 3 at line 410). Each cell subprocess runs `bun --preload scripts/retrieval-usage.ts <runner>` (line 355). `scripts/summarize-retrieval-refresh.py` derives tables with no provider calls. `scripts/plot-retrieval-refresh.py` needs matplotlib and writes SVG under docs/benchmarks/2026-09-09-retrieval-refresh.
- Cost: each process reserves $25 before start. 2026-09-09: $475 reserved of $1,000 ceiling; gross usage estimate $0.7133; conservative bound $4.7939 (docs/benchmarks/2026-09-09-retrieval-refresh.md:402-413).
- Keys: Voyage (embedding voyage:voyage-4 for concept cells), OpenAI, Anthropic as cell requires.
- Coupling: CLI-spawn of bun runners, which then run in-process gbrain code.

---

## PrecisionMemBench (gbrain): eval/runner/precisionmembench.ts

### Files

Entry: eval/runner/precisionmembench.ts. Helpers: eval/precisionmembench/gbrainAdapter.ts, gbrainThinkAdapter.ts, seed.ts, scope.ts, gate-proto.ts, scorer/baseAdapter.ts, scorer/belief.ts, scorer/buildRetrievalReport.ts, scorer/runCases.ts (vendored from tenurehq/precisionmembench at c9689ca, MIT; eval/precisionmembench/ATTRIBUTION.md). eval/runner/retrieval-pins.ts, eval/runner/precisionmembench-instrument.ts.

### What it measures

Whether search returns only the right beliefs: precision, recall, active passes, and total passes over 77 single-query cases (35 beliefs in eval/precisionmembench/fixtures/beliefs.seed.json). Also measures superseded-belief handling and scope isolation. 12 session cases exist in fixtures/session-retrieval.cases.json (2 entries in the file) and are not run here per the doc.

### How it is run

- `bun eval/runner/precisionmembench.ts --mode gbrain-hybrid` (also `--limit 10`, `--json`).
- `bun eval/runner/precisionmembench.ts --mode gbrain-keyword` (no embed key).
- `bun eval/runner/precisionmembench.ts --mode gbrain-adaptive --entity-max 1 --other-max 1` (tight caps; recall-preserving: `--entity-max 1 --other-max 2`).
- `bun eval/runner/precisionmembench.ts --mode gbrain-think --paid --budget-run-id <id>` (metered; default model anthropic:claude-opus-5-5, gbrainThinkAdapter.ts:26).
- Modes list: MODES = gbrain-hybrid, gbrain-keyword, gbrain-think, gbrain-adaptive (eval/runner/precisionmembench.ts:91). Strict flag parsing (lines 116-169).
- Source of commands: header lines 40-44; docs/benchmarks/2026-05-29-precisionmembench.md:108-116.

### Cost and time

- Keyword and hybrid: no paid calls beyond seeding embeddings (hybrid). Keyword is hermetic.
- gbrain-think: about $0.06 per case (one Opus 5.5 case cost $0.06 on 2026-11-01; MODES comment, eval/runner/precisionmembench.ts:94). Arithmetic: about $5 for 77 cases. Not measured.
- Receipt: eval/reports/precisionmembench/receipt.json (missing key gives run_status skipped and non-zero exit unless --allow-skip).
- Wall time: not recorded in the header; p50 latency in the report (about 270 ms for adaptive, 4,945 ms for May think run).

### LLM keys

- gbrain-keyword: none.
- gbrain-hybrid: embedding provider key (provider not hard-coded here; `--embedding-model` flag, precisionmembench.ts:160).
- gbrain-think: Anthropic key, plus paid budget ledger.

### Corpus

eval/precisionmembench/fixtures/*.json (committed, from upstream). 200 KB dir.

### Metrics and scoring

Upstream scorer (vendored). Precision = returned IDs in the answer / returned. Recall = expected IDs returned / expected. Means exclude cases where the scorer returns null. Verdict 'pass' means full case set; 'partial' means --limit. No threshold is enforced (header lines 19-22). Reference numbers: docs/benchmarks/2026-05-29-precisionmembench.md, September 9 table (lines 27-34):
| Config | Mean precision | Mean recall | Active passes | All passed |
|---|---|---|---|---|
| Keyword | 0.1361 | 0.1744 | 5/43 | 34/77 |
| Hybrid, reranker off | 0.0565 | 0.9884 | 0/43 | 7/77 |
| Hybrid, reranker on | 0.0565 | 0.9884 | 0/43 | 7/77 |
| Tight adaptive, reranker off | 0.5333 | 0.7320 | 25/43 | 38/77 |
| Tight adaptive, reranker on | 0.5859 | 0.8250 | 29/43 | 41/77 |

The May rows used flawed seeding and are historical.

### gbrain imports and methods

| Import | Symbols | Called on it | File |
|---|---|---|---|
| gbrain/pglite-engine | PGLiteEngine | connect, initSchema, setConfig, executeRaw, softDeletePage, disconnect (seed.ts) | eval/precisionmembench/seed.ts:30 |
| gbrain/import-file | importFromContent | seeding (one session per belief) | seed.ts:31 |
| gbrain/config | loadConfig | config load | seed.ts:32 |
| node_modules/gbrain/src/core/ai/gateway.ts (deep, not exported) | configureGateway | seed.ts:33 |  |
| gbrain/engine | BrainEngine (type) | gbrainAdapter.ts:18 |  |
| gbrain/search/hybrid | hybridSearch | gbrainAdapter.ts:19 |  |
| node_modules/gbrain/src/core/search/query-intent.ts (deep) | classifyQueryIntent | gbrainAdapter.ts:26 |  |
| engine (BrainEngine instance) | searchKeyword | gbrainAdapter.ts |  |
| node_modules/gbrain/src/core/think/index.ts (deep) | runThink | gbrainThinkAdapter.ts:24 |  |
| eval/runner/retrieval-pins.ts (repo) | searchObservation | gbrainAdapter.ts:25 |  |

Deep imports into node_modules/gbrain/src are not in the package exports list, so they break on package layout changes.

### Coupling

In-process. Adapter receives a BrainEngine instance.

### Parity-gate fit

Deterministic for keyword and seeded hybrid. Small (77 cases). Fast except think (LLM). A parity gate needs a CLI or MCP path that returns ranked belief IDs per query.

---

## PrecisionMemBench (any system): eval/runner/precisionmembench-system.ts, -s3.ts, -instrument.ts

### precisionmembench-system.ts

- Measures: same upstream scorer, with searchText routed to a system's public read API (`--system <shim URL>`, `gbrain-shootout`, or `fake`). Beliefs go through normal ingestion with the sanitizer; supersession seeded live; scope isolation by namespace per (user, scope) (header lines 1-45).
- Run: `bun eval/runner/precisionmembench-system.ts --system <shim URL>|gbrain-shootout|fake --output <dir> [--gbrain <checkout>] [--config k=v] [--embed hash|real] [--limit N] [--paid --budget-run-id <id>]` (header lines 5-13; flag check at line 158).
- Adapter: eval/precisionmembench/systemAdapter.ts (no gbrain imports; overrides searchText only).
- HTTP: eval/runner/systems/http.ts (protocol v1 shim) when --system is a URL (line 85, 368).
- Coupling: HTTP for shim URLs; in-process for gbrain-shootout (MemorySystem, in-process).
- Keys: per system; the header says --paid joins the ledger.

### precisionmembench-s3.ts

- Aggregates run directories: `bun eval/runner/precisionmembench-s3.ts --master <run dir> [--pin <run dir>] --system <run dir>... --output <dir>` (header line 5). Pure aggregation, no gbrain import (only node:fs, node:path).
- Coupling: none.

### precisionmembench-instrument.ts

- Policy sweep and cliff read: `bun eval/runner/precisionmembench-instrument.ts [--keyword]` (line 23). Imports eval/precisionmembench/scorer (vendored), GbrainBeliefAdapter, createBenchEngine, seedGbrainEngine, configureGatewayForBench (seed.ts), BrainEngine type. Calls engine.disconnect.
- Coupling: in-process.
- Keys: keyword mode none.

---

## Situation recall (eval/runner/situation-recall-*.ts)

### Question and protocol

Protocol doc: docs/benchmarks/2026-09-23-situation-recall-protocol.md. Question: when a user's new request uses different words, does optional situation-cue retrieval return the original passage? Primary metric: all_evidence_in_top5_chunks (every required span covered by the five chunks production retrieval returns). Feature is experimental and off by default (doc line 3).

### Corpus

eval/data/associative-recall-v1 (validated by eval/runner/cat36-corpus.ts). 120 families (40 development, 80 holdout), 240 indirect positives, 120 direct controls, 120 negatives, 480 probes total (doc table). Five domains: constraints, preferences, commitments, changing decisions, causal context. Fictional fixtures.

### Gate: eval/runner/situation-recall-regression.ts

- Inventory: eval/regression/situation-recall-v1.json (decision rules: comparisons C0-B, C1-C0, C1-B; cat36 slice indirect; minimum gain 0.1; family-clustered 95% lower bound must be above 0; Holm across existing opportunity categories; allowed point decline 0; critical known-correct losses 0). Categories and runners: lines in `categories` (for example cat36 runner eval/runner/cat36-*.ts; longmemeval runner eval/runner/longmemeval.ts; precisionmembench runner eval/runner/precisionmembench.ts; namedthing from node_modules/gbrain/scripts/r1-namedthing-rerank-ab.ts).
- Usage (line 662): `bun eval/runner/situation-recall-regression.ts inventory | compare <manifest.json> <cell-results.json> | collect <profile.json> <native-artifact.json>`.
- Native contracts: 50 categories including cat5 to cat36, longmemeval, precisionmembench, multi-adapter, relational, namedthing.

### Orchestration: eval/runner/situation-recall-orchestration.ts

- Spawns each regression cell's driver argv as a detached child (spawn at line 136, cwd and log file), records git state via execFileSync('git', ...) (line 112).
- Budget: reserveRegressionBudget writes a ledger reservation per cell (lines 59-72, 200-203); a cell admitted once cannot be re-admitted; uncertain spend stays reserved.
- Usage of orchestration itself: not read in full.
- Coupling: CLI-spawn of driver argv; not MCP.

### Drivers and collectors

| File | Role | Coupling |
|---|---|---|
| eval/runner/situation-recall-associative.ts | Cat36 associative-recall driver; dynamic import of `${productPackage}/pglite-engine`, `/ai/gateway`, `/import-file`, `/search/hybrid`, `/operations`, `/config`, `/embedding` (lines 324-457) | in-process |
| eval/runner/situation-recall-cat36.ts | Cat36 row and receipt builder | none (types and pure functions) |
| eval/runner/situation-recall-cat13b.ts | Cat13b source swamp; dynamic import of gateway, config, operations.memory_cues (lines 138-192) | in-process |
| eval/runner/situation-recall-programmatic.ts | Programmatic probe runner; uses Anthropic SDK in live mode (line 329, ANTHROPIC_API_KEY); imports gbrain/config (loadConfig, configPath) | in-process (config) plus Anthropic HTTP |
| eval/runner/situation-recall-development.ts | Development gate and source-only experiment policy checks; imports Cat36 profile types | none |
| eval/runner/situation-recall-native.ts, -native-2-4-6.ts, -native-18-24.ts, -native-35.ts | Collect native metrics from category receipts (per-slice numbers) | none |
| eval/runner/situation-recall-provenance.ts | Resolves product package and git provenance (createRequire, execFileSync git) | none |
| eval/runner/situation-recall-contract.ts, -experiment-policy.ts, -observations.ts | Types, experiment policy constants, cue-lookup predicate | none |

Cost: per-cell budget reserved (amount per cell not read). Keys: ANTHROPIC for programmatic; others depend on category.

### Coupling summary

Mixed. Gate and collectors: none. Drivers: in-process gbrain subpath imports, selected per arm by product package. Orchestration: CLI-spawn. The regression inventory notes that the gate reads committed receipts, not live output (decision block).

---

## Sealed confirmation (eval/runner/sealed-confirmation*.ts)

### Files

eval/runner/sealed-confirmation.ts (541 lines; CLI), eval/runner/sealed-confirmation-lib.ts (652 lines; commitments, spend ledger, LlmClient, scoring, access log). Public data: eval/data/sealed-confirmation-v1/ and -v2/ (README.md, manifest.json, overlap-audit.json, solvability.json). Overlap audit script: scripts/sealed-confirmation-overlap.py.

### What it measures

Held-out retrieval recall (gold-session coverage) and reader answer accuracy on sealed questions. The sealed questions, chat histories and labels are private (not in the repo). Labels are opened only after their bytes match the committed hash; every open is logged.

### How it is run

`bun eval/runner/sealed-confirmation.ts validate --questions <q>`; `run --questions <q> --out-dir <dir> --adapters hybrid --top-k 5`; `answer --questions <q> --run <run.jsonl> --out <hyp.jsonl> --cap-usd 5`; `score --run <run.jsonl> --labels <private labels> --purpose "<text>" --decision-id <id> [--judge --cap-usd 2] --out <report.json>`; `solvability --questions <q> --labels <l> --out <private.jsonl> --cap-usd 10`. Evidence-delivery decisions: `evidence-freeze`, `evidence-answer`, `decide`. Usage header lines 1-40.

### Sets

| Set | Questions | Answerable | Personas | Sessions per haystack | Generator / cost | Public result |
|---|---|---|---|---|---|---|
| v1 | 150 (30 per type) | 120 | 30 | 55 (about 64,839 tokens) | gpt-6-sol; $15.82 | docs/benchmarks/2026-09-29-sealed-confirmation-protocol.md |
| v2 | 200 (80 multi-session, 40 each of temporal, knowledge-update, abstention) | 160 | 40 | 46 (about 142,697 tokens) | plan gpt-6-sol, session gpt-6-luna; $20.99 | docs/benchmarks/2026-10-02-sealed-v2-decision-1.md |

Manifest counts: eval/data/sealed-confirmation-v1/manifest.json (counts), v2 manifest (counts, generation_cost_usd 20.9937, generation_cost_note).

### Headline (v2 decision 1)

gbrain's evidence default `auto` answered 192 of 200; the chunk default answered 132 of 200 (same build, same five hits, same reader and judge). Gain +30.0 points; the report gives the persona-cluster interval. Cost: about 12,982 input tokens per question for auto vs 3,280 for chunk. Source: docs/benchmarks/2026-10-02-sealed-v2-decision-1.md (top lines).

### Keys and cost

- Reader: claude-sonnet-4-6 at temperature 0 (READER_MODEL, sealed-confirmation.ts:45); calls https://api.anthropic.com/v1/messages with ANTHROPIC_API_KEY (sealed-confirmation-lib.ts:631-633).
- Judge: gpt-4o-2024-08-06 (JUDGE_MODEL, sealed-confirmation.ts:46) via OpenAI Responses API with OPENAI_API_KEY (sealed-confirmation-lib.ts:559-561).
- Generation: gpt-6-sol / gpt-6-luna (manifest models).
- Spend ledger: SpendLedger with reservations and settlements (sealed-confirmation-lib.ts:495-540). Caps are per command (--cap-usd).

### gbrain imports

- `run` delegates to eval/runner/longmemeval.ts run() in-process (dynamic import, sealed-confirmation.ts:146; output tagged produced_by 'eval/runner/longmemeval.ts run()' line 163).
- evidence-delivery path: loadGbrain and configureGbrainGateway from eval/runner/evidence-delivery/gbrain.ts (line 367-368); freeze from eval/runner/evidence-delivery/freeze.ts; sealedFreezeInputs from eval/runner/evidence-delivery/e2-bridge.ts.
- The lib itself imports no gbrain module.
- Coupling: in-process.

### Parity-gate fit

Needs LLM keys and private files. Not a parity-gate candidate. The validate and overlap audit are offline.

---

## Memory proof wave (eval/runner/memory-proof-wave*.ts, memory-proof-wave/)

### Files

Entries: memory-proof-wave-power.ts (extract and simulate), memory-proof-wave-grouping.ts (build, check, reseal), memory-proof-wave-sealed-analysis.ts, memory-proof-wave-2-confirm-analysis.ts, memory-proof-wave-dev-power.ts, memory-proof-wave-dev-table.ts. Helpers in eval/runner/memory-proof-wave/: grouping.ts (HMAC-SHA256 split), harness-inputs.ts (reads the pinned harness outputs), ni-stats.ts (paired non-inferiority, wild cluster bootstrap), power.ts (4,000 simulations per cell), cluster-stats.ts (ICC). Data: eval/data/memory-proof-wave/grouping-manifest.json (status sealed, created 2026-10-05), harness.lock.json (harness commit f618ed7b, vectorize-io/agent-memory-benchmark).

### What it measures

Whether gbrain's graded accuracy on sealed BEAM conversations (100k, 500k, 1M) is non-inferior to the comparator's at a fixed margin (one-sided 95%), with cost per correct answer. Preregistration: docs/benchmarks/2026-10-05-memory-proof-wave-preregistration.md. Margin moved from 2.0 to 3.0 (power) to 3.5 (dev re-estimate).

### How it is run

- `bun eval/runner/memory-proof-wave-power.ts extract --harness <checkout>` then `simulate` (package.json eval:mpw:power). No model calls.
- `bun eval/runner/memory-proof-wave-grouping.ts check` (package.json eval:mpw:grouping); `build --private-dir <outside repo>`; `reseal --reason ...`.
- `bun eval/runner/memory-proof-wave-sealed-analysis.ts --pair <gbrain-dir>:<comparator-dir> [--pair ...] --margin 3.5 [--cells-dir <dir>]` (usage line 98).
- Dev table: `bun eval/runner/memory-proof-wave-dev-table.ts ...`; confirm analysis reads rejudge output directories.

### Result (sealed)

docs/benchmarks/2026-10-09-memory-proof-wave-sealed-results.md (opening lines): 54 sealed conversations, 1,080 questions. gbrain primary 0.670, comparator 0.644 (+2.6 points; one-sided bounds +0.9 and +4.4). Outcome `ahead`. Cost per correct answer 0.63 times the comparator at 20 reads per conversation (95% interval 0.57 to 0.73); 1.01 at 200 reads.

Wave 2 confirmation (docs/benchmarks/2026-10-13-memory-proof-wave-2-results.md): combined-v2 +14.00 points over combined-v1 on LongMemEval-S (lower bound +10.96), and passes other gates.

### Cost

- Power, grouping, analysis: $0 (no model calls).
- Sealed run: spend cap $450 of proxy-metered spend (prereg, "Spending cap for this decision" row), drawn from ledger mpw-confirm-sealed.
- Harness keys: judge gemini-3.5-flash (prereg, "Judge" row); answer model fixed by harness; OpenAI and Anthropic per harness config (not read).

### Metrics and statistics

Paired difference per question (gbrain minus comparator, times 100). Primary: restricted wild cluster bootstrap-t with Webb six-point weights, 9,999 draws, seed 20261005, conversations as clusters, BEAM sizes as strata (prereg; ni-stats.ts). Outcome via decide() in ni-stats.ts: ahead, non-inferior, behind, inconclusive (no tie). Cost ratio interval from stratified cluster bootstrap.

### Corpus

BEAM (arXiv 2510.27246), public. Harness at f618ed7 (eval/data/memory-proof-wave/harness.lock.json). Grouping manifest commits split membership by HMAC of cluster id with a salt not in repo; dev 20%, validation 20%, sealed remainder. Committed: commitments and the access log path.

### gbrain imports

None in these runners. harness-inputs.ts uses execFileSync (git) and gunzipSync only. The gbrain side runs through the external harness (eval/harness-provider/), out of scope here.

### Coupling

None for analysis and power. The harness itself (external Python package, comparator server 0.10.2 per eval/harness-provider/comparator.lock.json) is HTTP or subprocess; gbrain is driven through the harness's query operation (prereg line 26: `query` with return_unit page and token_budget).

### Parity-gate fit

Analysis is deterministic and keyless. The sealed run is paid and needs private files.

Naming inconsistency: the prereg (line 5) calls the comparator an "extract-first memory server", while comparison-systems.md maps the comparator to ext-memory-bank (Hindsight 0.10.2) and the sealed results call it `memory-bank`. The lock version 0.10.2 matches Hindsight. Recorded in observations.

---

## Power, stats, pilot (eval/runner/power/, eval/runner/stats/, eval/runner/pilot/)

### Power (eval/runner/power/)

| File | Purpose | Run |
|---|---|---|
| power/risk-ratio.ts | Power and validated intervals for a clustered paired failure-risk ratio (360 lines) | used by validate.ts and PW plan |
| power/size-contrast.ts | Power for a within-persona system-by-size contrast (122 lines) | used by validate.ts |
| power/validate.ts | Simulated coverage and false-positive rates (`bun eval/runner/power/validate.ts [--output <power.json>] [--sims N] [--seed N]`) | $0, keyless |

Cost: $0. Keys: none. Imports: node:fs, node:path only. Coupling: none.

### Stats (eval/runner/stats/)

| File | Purpose | Notes |
|---|---|---|
| stats/exact.ts | Clopper-Pearson exact binomial bounds (39 lines) | pure |
| stats/fixed-sequence.ts | Fixed-sequence (hierarchical) testing (25 lines) | pure |
| stats/gates.ts | Three-gate comparison policy (exact, significance, ...) over a preregistered family (277 lines; plan amendment 4) | reads files via node:fs |
| stats/paired.ts | Paired, clustered comparison; family-clustered bootstrap, sign-flip test, Holm; seededRandom (462 lines) | pure |
| stats/rows.ts | Turns per-item rows (NDJSON or JSON) into paired observations under one eligibility rule | node:fs |
| stats/wild-cluster.ts | Restricted wild cluster bootstrap-t for few clusters (179 lines), ported from memory proof wave | pure |

Keys: none. Coupling: none. Used by pilot/decide.ts (exactMcNemar), pilot/confirm.ts (evaluateFamily), situation-recall regression (paired), memory proof wave (seededRandom).

### Pilot (eval/runner/pilot/): wave 1 architecture pilot

- Measures: 10x memory advantage plan items A3, A4, A5, A10: evidence-architecture pilot over frozen W10a captures of gbrain c5fb0201's LongMemEval-S reader requests (pilot/evidence.ts header). Compares cheap and frontier readers with DIGEST and brief builders, outcome-v3 categories, and synchronous timing cohort (cohort.ts).
- Run: `bun eval/runner/pilot/run.ts split` ($0), `smoke` (keyless 2-question check, $0, scripted provider), `build <paid flags>` (brief and digest builders, cheap models). Paid flags: --paid --budget-run-id <id> --budget-ledger <path> (run.ts:16). State dir $PILOT_STATE_DIR (default ~/.capy/work/pilot).
- Cost: docs/benchmarks/2026-10-08-evidence-architecture-pilot.md:7-8: $60.48 of an $80 ledger cap; every preregistered cell complete. Dollar arithmetic in pilot/cells.ts (BUDGETS 1000, 2000, 4000, 7000 tokens, cells.ts:20).
- Confirm split (A6): pilot/confirm.ts, prereg docs/benchmarks/2026-10-08-evidence-brief-confirmation-preregistration.md; 400-question confirm split.
- Keys: ANTHROPIC_API_KEY (pilot/call.ts:29), OPENAI_API_KEY (pilot/call.ts:38), OpenRouter (cells).
- gbrain imports: pilot/evidence.ts:15 imports node_modules/gbrain/src/core/chunkers/token-estimate.ts (deep import, not exported). No engine calls.
- Coupling: none to gbrain binary; one deep in-process import (token estimate). Provider calls via fetch.

---

## Cross-cutting observations

1. Strict versus any-hit metrics. Several published numbers use any-hit R@5 (MemPalace, agentmemory, Lethe). gbrain's headline is strict recall_all@5. The May 2026 headline (97.60%, any-hit) was replaced by the strict 83.40%. Keep the metric name in every comparison.
2. Leak history. The 2026-09-06 QA number (86.6%) is invalid because the `answer_` gold prefix reached gbrain and the reader (fixed in gbrain b80cad6 and gbrain-evals v0.10.1). Retrieval numbers were recounted with opaque ids (2026-10-04). Any table citing 86.6% must carry the notice.
3. Pins. gbrain is pinned at 6ce7195 (package.json), gbrain-cues at 939232f, gbrain-reader at e78f1c3. The LongMemEval runner's search config is pinned in code (PINNED_SEARCH_CONFIG). Result files also record pins. Deep imports into node_modules/gbrain and node_modules/gbrain-cues src paths (precisionmembench, pilot, cues) are not in the package exports and would break on a layout change.
4. Dataset naming mismatch. longmemeval.ts defaults to longmemeval_s.json (uncleaned name) and its header and batch.sh point to the uncleaned repo, while every report and the registry use longmemeval_s_cleaned.json (SHA d6f21ea9). Passing --path is required for a reproduction of the reported numbers.
5. Cache path mismatch. longmemeval-cache.ts header names eval/reports/longmemeval/embed-cache.sqlite, but longmemeval.ts writes embed-cache-<model>@<dims>.sqlite under eval/reports/longmemeval/embed-cache/ (line 1193). The README in eval/data/longmemeval/embed-cache points to the directory form.
6. Default top-k. The runner defaults to top-k 8 (longmemeval.ts:195); the batch wrapper and every headline use k=5.
7. Warm-cache claim. The longmemeval.ts comment says a warm run completes "in minutes for ~$0". Measured warm arms took about 40 minutes each (2026-09-06 table) and still paid for rerank or expansion calls.
8. Comparator naming. The memory proof wave prereg (docs/benchmarks/2026-10-05-memory-proof-wave-preregistration.md:5) calls the comparator an "extract-first memory server". The lock (eval/harness-provider/comparator.lock.json, version 0.10.2) and comparison-systems.md map the comparator to Hindsight/memory-bank, not Mem0 (ext-extract-first). Doc inconsistency; resolve before quoting.
9. Reader drift. The gbrain-reader reader adds an abstention instruction absent from the official prompt (disclosed in its header). Sonnet 4.6 notes and direct readers have different scores across W10 reports; both readers and prompts must be named with any number.
10. Judge drift. Official QA judge is gpt-4o-2024-08-06 across LongMemEval, sealed sets and memory proof wave's BEAM harness uses gemini-3.5-flash. Do not pool judge-specific scores.
11. Cost model. Reservations are not charges. The budget ledger refuses paid calls without a budget (longmemeval.ts:1165-1177). Usage receipts (usage.ndjson, rows.ndjson) hold the settled amounts. Historical estimates in reports (for example $2 for embeddings) are not reconciled bills.
12. Harness dependency. The memory proof wave and PrecisionMemBench (any system) depend on pinned external harnesses (vectorize agent-memory-benchmark at f618ed7; upstream PrecisionMemBench at c9689ca). Parity work should treat these as external oracles, not gbrain code.
13. Documentation links. The brief named summarize/plot-retrieval-refresh.py. Actual location is scripts/.
14. Personal data. Docs name the upstream benchmark authors and the project maintainer. This map uses no personal names.
