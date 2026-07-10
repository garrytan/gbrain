# Evaluation Metric Glossary

**Auto-generated from `src/core/eval/metric-glossary.ts`. Do not edit by hand.** Run `bun run scripts/generate-metric-glossary.ts` to regenerate.

Every metric `gbrain eval *` and `gbrain search stats` reports has a plain-English explanation here. Industry terms are preserved verbatim so users searching the literature find what we report.

## Retrieval Metrics

### Precision at k (P@k)

**Key:** `precision@k`

**Plain English:** Of the top k results the engine returned, what fraction were actually relevant? High precision means few junk results in the top of the list.

**Range:** 0..1, higher is better. P@10 = 0.7 means 7 of the top 10 results were on-topic.

### Recall at k (R@k)

**Key:** `recall@k`

**Plain English:** Of all the relevant results that exist in the brain, what fraction did the engine find in its top k? High recall means few missed answers.

**Range:** 0..1, higher is better. R@10 = 0.81 means out of every 100 questions, the right answer was in the top 10 for 81 of them.

### Mean Reciprocal Rank (MRR)

**Key:** `mrr`

**Plain English:** On average, how far down the list is the FIRST relevant result? An MRR of 1.0 means the first hit is always right; an MRR of 0.5 means it's typically at rank 2.

**Range:** 0..1, higher is better. Computed as the average of 1/rank-of-first-relevant-result across all test queries.

### Normalized Discounted Cumulative Gain at k (nDCG@k)

**Key:** `ndcg@k`

**Plain English:** Like precision@k, but the engine gets MORE credit for putting good results near the top than near rank k. A perfect ordering scores 1.0; a totally random ordering scores near 0.

**Range:** 0..1, higher is better. nDCG@10 above 0.65 is the common "ship it" threshold for hybrid retrieval on technical corpora.

## Retrieval-Quality / Evidence Metrics (NamedThingBench)

### Hit rate at 1 (Hit@1)

**Key:** `hit@1`

**Plain English:** Fraction of queries where the right page is the very first result. NamedThingBench hard-gates title-substring Hit@1 >= 0.95 and alias Hit@1 >= 0.98 — a query that is a page's name or title phrase should land it at rank 1, not "somewhere in the top 10".

**Range:** 0..1, higher is better.

### Hit rate at 3 (Hit@3)

**Key:** `hit@3`

**Plain English:** Fraction of queries where the right page is in the top 3 results. NamedThingBench requires the multi-chunk-dilution family to hit 1.0 — a page with one strong chunk among many weak ones must never be buried.

**Range:** 0..1, higher is better.

### Average rank-1 match score

**Key:** `avg_rank1_score`

**Plain English:** The mean base (pre-boost) retrieval score of the TOP result across recent searches, from `gbrain search stats`. It is NOT a labeled accuracy number — it is a drift signal: if this trends DOWN over time, retrieval quality is regressing (the early warning that would have caught the duplicate-page incident before a human did).

**Range:** 0..1. Watch the trend, not the absolute value; pair with the <0.6 / 0.6-0.85 / >=0.85 bucket counts for shape.

### Create-safety hint (evidence contract)

**Key:** `create_safety`

**Plain English:** A result's answer to "is this page already in the brain — safe to NOT write a new one?" Derived from the strongest evidence, NOT a raw score: exists (alias_hit / exact_title_match / high_vector_match — do not duplicate), probable (solid keyword match — prefer updating), unknown (weak match — look closer). An agent keys its don't-duplicate decision off this, which is what prevents the incident's duplicate-stub class.

**Range:** enum: exists | probable | unknown

## Set-Similarity / Stability Metrics

### Jaccard similarity at k (set Jaccard @k)

**Key:** `jaccard@k`

**Plain English:** How much do two result lists overlap? Compare the top k slugs from the captured baseline against the current run; Jaccard@10 = 1.0 means perfect agreement, 0.0 means zero overlap.

**Range:** 0..1, higher = more stable. Below 0.5 on a stable corpus means retrieval changed significantly.

### Top-1 stability rate

**Key:** `top1_stability`

**Plain English:** Fraction of queries where the #1 result is the same between two runs. The most aggressive stability check — small ranking shifts that don't change the top answer don't hurt it.

**Range:** 0..1, higher = more stable. Above 0.85 typically means safe-to-merge for retrieval changes.

## Statistical-Significance Metrics

### p-value (paired bootstrap)

**Key:** `p_value`

**Plain English:** How likely the observed difference between two modes is just noise. Lower = stronger evidence the difference is real. We compute paired bootstrap with 10,000 resamples and Bonferroni correction across the 12 comparisons (3 modes × 4 metrics).

**Range:** 0..1, lower = stronger signal. Below 0.05 is the common "statistically significant" threshold; below 0.01 is strong evidence.

### 95% Confidence Interval (CI)

**Key:** `confidence_interval`

**Plain English:** The range we're 95% sure the true value falls inside, given the sample we measured. Narrower CI = more reliable estimate. Computed via bootstrap resampling.

**Range:** Two-tuple [low, high]. If 0 is inside the CI for a Δ, the difference isn't statistically significant.

## Operational / Cost Metrics

### Cache hit rate

**Key:** `cache_hit_rate`

**Plain English:** Fraction of searches that reused a recent cached answer instead of running fresh. Higher hit rate = lower latency + lower LLM spend, but stale results may slip through if the threshold is too loose.

**Range:** 0..1, higher generally better. 0.7-0.9 is the sweet spot for a busy brain; above 0.9 may indicate the similarity threshold is too loose.

### Average results returned

**Key:** `avg_results`

**Plain English:** Mean number of search-result rows the engine returned per call. Should be near the active mode's searchLimit unless the brain is small or the budget is dropping results.

**Range:** 0..searchLimit. Far below searchLimit suggests budget pressure or sparse retrieval.

### Average tokens delivered

**Key:** `avg_tokens`

**Plain English:** Estimated tokens (chars / 4) in the chunk text returned per search call. The direct measure of how much context an agent loop is paying for each search.

**Range:** 0..tokenBudget. Approximates OpenAI tiktoken count for English; off by ~5-10% for Anthropic and worse for non-English.

### Cost per query (USD)

**Key:** `cost_per_query_usd`

**Plain English:** Sum of LLM + embedding API charges for one search call. Includes Haiku expansion call (tokenmax mode only) + embedding cost + downstream answer-model cost if measured.

**Range:** 0..unbounded. Conservative mode is typically <\$0.001 per call; tokenmax with answer-gen can exceed \$0.01.

### p99 latency (ms)

**Key:** `p99_latency_ms`

**Plain English:** 99th percentile wall-clock time per search call. The latency that 1% of users see — long-tail experience, not the average.

**Range:** 0..unbounded. Warm-cache hits should be <50ms; tokenmax with expansion can exceed 200ms due to the Haiku call.

## Result-Sizing Metrics

### Autocut signal

**Key:** `autocut.signal`

**Plain English:** Which signal autocut used to size the result set. 'rerank' means it found a real score cliff in the cross-encoder rerank scores and cut there; 'none' means no trustworthy cliff (no reranker, <2 scored results, or the gap was too small) so it returned the full list.

**Range:** 'rerank' | 'none'. 'none' is not a failure — it means autocut declined to cut because the signal didn't justify it.

### Autocut gap ratio

**Key:** `autocut.gap_ratio`

**Plain English:** The size of the largest score drop autocut found, as a fraction of the top result's score. A gap of 0.40 means the score fell by 40% of the top score at the steepest point. Autocut cuts there only when this clears the sensitivity threshold (autocut_jump, default 0.20).

**Range:** 0..1, higher = a sharper cliff (more confident cut). Below the autocut_jump threshold → no cut.

## BrainBench — Cross-Harness Memory Conformance

### Know-to-ask failure rate (BrainBench)

**Key:** `know_to_ask_failure_rate`

**Plain English:** Of the conversation turns where memory SHOULD have surfaced something unprompted, the fraction where nothing relevant was injected. This is the thesis failure mode every agent harness shares: the agent can't ask for what it doesn't know it forgot — the memory layer has to volunteer it.

**Range:** 0..1, LOWER is better. 0.15 means memory stayed silent on 15% of the turns where it had the answer.

### False-fire rate (BrainBench)

**Key:** `false_fire_rate`

**Plain English:** Of the turns where memory should have stayed SILENT, the fraction where it injected anyway. The anti-gaming companion to the know-to-ask rate — "always inject" would ace one and bomb the other. Silence beats noise.

**Range:** 0..1, LOWER is better.

### Push precision (BrainBench)

**Key:** `push_precision`

**Plain English:** Of everything the memory layer volunteered into context, what fraction was actually relevant to the turn? Micro-averaged over injected pointers, so a 3-pointer turn weighs three times a 1-pointer turn — the way a token budget experiences it.

**Range:** 0..1, higher is better.

### Push recall (BrainBench)

**Key:** `push_recall`

**Plain English:** Of everything that SHOULD have been volunteered (the gold pointers), what fraction actually was? Pointer budgets cap this by design: a seam that may inject only 1 fragment cannot reach full recall on a 3-entity turn — that constraint is what the per-harness rows measure.

**Range:** 0..1, higher is better.

### Write-back fidelity (BrainBench)

**Key:** `write_back_fidelity`

**Plain English:** Of the facts stated in a conversation, what fraction survived the PRODUCTION conversation→memory pipeline (segmentation, insertion, dedup) and are findable afterward with the right entity attached? Measures the write path users actually run, not a test-only insert.

**Range:** 0..1, higher is better.

### Provenance accuracy (BrainBench)

**Key:** `provenance_accuracy`

**Plain English:** Of the facts that survived write-back, what fraction carry correct provenance — the right source tag, session id, and origin page? A fact you can't trace is a fact you can't trust, audit, or expire.

**Range:** 0..1, higher is better.

### Cross-session continuity rate (BrainBench)

**Key:** `continuity_rate`

**Plain English:** A decision is recorded in one session and persisted through the production write path; a different harness asks about it later on the same brain. What fraction of those decision probes were recalled — by pointer injection or stored-fact lookup? This is the continuity-that-survives-the-harness-hop moat, measured.

**Range:** 0..1, higher is better. Scored per reader harness (the v1 write path is harness-independent, disclosed in docs/eval/BRAINBENCH.md).

### Source-isolation violations (BrainBench)

**Key:** `source_isolation_violations`

**Plain English:** Count of injected pointers that belong to a source other than the active one. Cross-source leakage is gbrain's must-never-violate invariant (a missed source filter is a data leak), so this gates at ZERO — any baseline, any run.

**Range:** 0..n, count. MUST be 0; any value above 0 fails the gate.

### Average injected tokens per turn (BrainBench)

**Key:** `avg_injected_tokens`

**Plain English:** Estimated tokens of volunteered context per replayed turn (chars/4 heuristic). The intrusion-budget diagnostic: two seams with equal precision can differ 3x in how much context they spend to get it. Reported, not gated, until calibration data exists.

**Range:** 0..n tokens, judgment call — lower is cheaper, but starving the agent has its own cost. Non-gating.

### Extraction recall (BrainBench --llm)

**Key:** `extraction_recall`

**Plain English:** With the real LLM extractor running (instead of the deterministic gold extractor), what fraction of the gold facts did it actually extract and persist? Only scored in --llm runs — the hermetic CI gate never calls a model.

**Range:** 0..1, higher is better. Absent in deterministic runs.

### Extraction precision (BrainBench --llm)

**Key:** `extraction_precision`

**Plain English:** Of everything the real LLM extractor persisted, what fraction matches a gold fact? Low precision means the extractor invents or over-extracts — junk memory that pollutes future recall.

**Range:** 0..1, higher is better. Absent in deterministic runs.

---

## Coverage

Every metric printed by any `gbrain eval *` or `gbrain search stats` command resolves through `getMetricGloss()` in `src/core/eval/metric-glossary.ts`. Adding a new metric to the glossary REQUIRES updating this doc; the CI guard catches drift.

