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

---

## Coverage

Every metric printed by any `gbrain eval *` or `gbrain search stats` command resolves through `getMetricGloss()` in `src/core/eval/metric-glossary.ts`. Adding a new metric to the glossary REQUIRES updating this doc; the CI guard catches drift.
