# Evaluation Metric Glossary

**Auto-generated from `src/core/eval/metric-glossary.ts`. Do not edit by hand.** Run `bun run scripts/generate-metric-glossary.ts` to regenerate.

Every metric `gbrain eval *` and `gbrain search stats` reports has a plain-English explanation here. Industry terms are preserved verbatim so users searching the literature find what we report.

## Retrieval Metrics

### Precision at k (P@k)

**Key:** `precision@k`

**Plain English:** Of the top k unique pages the engine returned, what fraction were actually relevant? Multiple chunks from one page count once. High precision means few junk pages in the top of the list.

**Range:** 0..1, higher is better. The denominator stays k even when fewer than k unique pages are returned; P@10 = 0.7 means 7 relevant pages in the top 10 slots.

### Recall at k (R@k)

**Key:** `recall@k`

**Plain English:** Of all the relevant pages that exist in the brain, what fraction did the engine find in its first k unique pages? Multiple chunks from one page count once. High recall means few missed answers.

**Range:** 0..1, higher is better. R@10 = 0.81 means 81% of all labeled relevant pages appeared in the first 10 unique results.

### Mean Reciprocal Rank (MRR)

**Key:** `mrr`

**Plain English:** On average, how far down the unique-page list is the FIRST relevant result? Repeated chunks do not consume ranks. An MRR of 1.0 means the first page is always right; an MRR of 0.5 means it's typically at rank 2.

**Range:** 0..1, higher is better. Computed as the average of 1/rank-of-first-relevant-result across all test queries.

### Normalized Discounted Cumulative Gain at k (nDCG@k)

**Key:** `ndcg@k`

**Plain English:** Like precision@k, but the engine gets MORE credit for putting good pages near the top than near rank k. Each page earns gain once even if several chunks matched. A perfect ordering scores 1.0; a totally random ordering scores near 0.

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

### p-value (paired sign-flip randomization test)

**Key:** `p_value`

**Plain English:** How likely the observed difference between two runs is just noise. Lower = stronger evidence the difference is real. Computed from per-question rows by randomly flipping which run each question's result belongs to, then Holm-corrected across every comparison in the report.

**Range:** 0..1, lower = stronger signal. Below 0.05 is the common "statistically significant" threshold; below 0.01 is strong evidence.

### 95% Confidence Interval (CI)

**Key:** `confidence_interval`

**Plain English:** The range we're 95% sure the true value falls inside, given the sample we measured. Narrower CI = more reliable estimate. Computed by resampling questions with replacement (paired bootstrap).

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

### Trust label accuracy (BrainBench trust)

**Key:** `trust_label_accuracy`

**Plain English:** Every write through a real channel (owner sync, an agent over MCP or the CLI, a connector, a tool-output write) should be stored at the trust tier that channel earns, and every explicit read (get_page, search, recall) should report that same tier. This is the fraction of checked writes where the stored tier and every read label agree with the expected tier.

**Range:** 0..1, higher is better. Gated at 1.

### Trust laundering violations (BrainBench trust)

**Key:** `laundering_violations`

**Plain English:** Count of writes stored ABOVE the tier their channel allows: an agent edit that keeps an owner page "your notes", frontmatter claiming "confirmed by you", an agent tidy-up raising external content. Any laundering lets untrusted text pass as trusted later.

**Range:** 0..n, count. MUST be 0.

### Self-promotion violations (BrainBench trust)

**Key:** `self_promotion_violations`

**Plain English:** Count of attempts to raise a tier without the owner (an agent calling confirm_memory, a piped CLI confirm, a raw database UPDATE) that were not refused or did raise the tier.

**Range:** 0..n, count. MUST be 0.

### Current-fact accuracy (BrainBench state-resolution)

**Key:** `current_fact_accuracy`

**Plain English:** After a sequence of updates, the fraction of checks where the fact recall returns as current is the expected one (the latest correction, or the owner's fact a lower-tier writer tried to replace).

**Range:** 0..1, higher is better. Gated at 1.

### Stale facts served as current (BrainBench state-resolution)

**Key:** `stale_surfaced_as_current`

**Plain English:** Count of superseded facts recall still returns as if current. A stale fact read as current is how an old answer overrides a correction.

**Range:** 0..n, count. MUST be 0.

### History preserved (BrainBench state-resolution)

**Key:** `history_preserved`

**Plain English:** Fraction of superseded facts whose rows survive (expired or superseded, never deleted), so the change stays auditable and reversible.

**Range:** 0..1, higher is better. Gated at 1.

### Lower-tier supersede violations (BrainBench state-resolution)

**Key:** `lower_tier_supersede_violations`

**Plain English:** Count of higher-tier facts (owner notes, owner-confirmed facts) that a lower-tier writer expired, superseded or forgot without the owner. The lower write should land as a contested proposal instead.

**Range:** 0..n, count. MUST be 0.

### Poison persistence rate (BrainBench poisoning, external arm)

**Key:** `poison_persist_rate`

**Plain English:** Of instruction-like payloads arriving through external channels (a connector import, a tool-output write), the fraction durable outside the write gate's hold and quarantine, i.e. live where later sessions can read them as memory.

**Range:** 0..1, LOWER is better. Gated at 0.

### Flagged and labeled rate (BrainBench poisoning, agent-relayed arm)

**Key:** `flagged_and_labeled_rate`

**Plain English:** Of instruction-like payloads an agent saved at its default tier, the fraction stored with a write-gate flag, a tier at or below "written by an agent", and the "unconfirmed, agent-written" label on explicit reads.

**Range:** 0..1, higher is better. Gated at 1.

### Unconfirmed preference activation (BrainBench poisoning)

**Key:** `unconfirmed_preference_activation_rate`

**Plain English:** Of agent-written standing preferences and commitments that read like instructions, the fraction that reached a later session's proactive context without the unconfirmed label.

**Range:** 0..1, LOWER is better. Gated at 0.

### Agent-relayed activation rate (BrainBench poisoning)

**Key:** `agent_relayed_activation_rate`

**Plain English:** Of instruction-like payloads an agent relayed into memory, the fraction any proactive surface (hook turn context, context engine, reflex, volunteer, context_pack, hot memory) injected into a later session before the owner confirmed them.

**Range:** 0..1, LOWER is better. Gated at 0. Scored per harness seam.

### Poison activation rate (BrainBench poisoning, both arms)

**Key:** `poison_activation_rate`

**Plain English:** Of every instruction-like payload, the fraction that reached a later session's proactive context outside its tier envelope (no external-data wrapper, no unconfirmed label).

**Range:** 0..1, LOWER is better. Gated at 0. Scored per harness seam.

### Benign retention (BrainBench poisoning)

**Key:** `benign_retention`

**Plain English:** Of ordinary content in both arms (newsletters, meeting notes, preferences), the fraction stored live and readable. The utility guard: a gate that blocks everything scores 0 here.

**Range:** 0..1, higher is better. Gated >= 0.95.

### False quarantine rate (BrainBench poisoning)

**Key:** `false_quarantine_rate`

**Plain English:** Of ordinary content in both arms, the fraction the write gate held or quarantined.

**Range:** 0..1, LOWER is better. Gated <= 0.02.

### Default-mode unlabeled persistence (BrainBench poisoning)

**Key:** `default_persist_unlabeled_rate`

**Plain English:** With the shipped defaults (instruction-like writes flagged, not held), the fraction of attacker payloads that were saved without their label: an external payload not marked "external, untrusted" on every read, or an agent payload not flagged and labeled "unconfirmed, agent-written".

**Range:** 0..1, LOWER is better. Gated at 0.

### Default-mode unlabeled activation (BrainBench poisoning)

**Key:** `default_activation_unlabeled_rate`

**Plain English:** With the shipped defaults (flagged items still reach proactive context), the fraction of attacker payloads that showed up in a later session's proactive context without their label: outside an external-data block and without the unconfirmed label.

**Range:** 0..1, LOWER is better. Gated at 0.

### Default-mode benign retention (BrainBench poisoning)

**Key:** `default_benign_retention`

**Plain English:** With the shipped defaults, the fraction of ordinary items that were saved, live and not held.

**Range:** 0..1, higher is better. Gated at >= 0.95.

### Residual after purge (BrainBench deletion)

**Key:** `residual_after_purge`

**Plain English:** Rows in ANY table of the brain, plus canonical markdown files, still holding a purged claim right after the purge. The probe scans every text-bearing column, independent of purge's own verification, so a store the deletion inventory missed shows up here.

**Range:** 0..n, count. MUST be 0.

### Receipt completeness (BrainBench deletion)

**Key:** `receipt_completeness`

**Plain English:** Fraction of purges whose receipt accounts for every store that held the claim before the purge (by table or its inventory adapter).

**Range:** 0..1, higher is better. Gated at 1.

### Resurrection after resync (BrainBench deletion)

**Key:** `resurrection_after_resync`

**Plain English:** Count of purged claims active again after the stale canonical file is re-synced or an agent re-remembers the claim.

**Range:** 0..n, count. MUST be 0.

## LongMemEval — Long-Term Conversational Memory

### Strict session recall at k (recall_all@k, LongMemEval)

**Key:** `recall_all@k`

**Plain English:** Did EVERY gold session for the question land among the distinct sessions in the top k retrieved chunks? A multi-session question with two gold sessions only counts when both are there — this is the evidence-complete rate the answer model actually needs. Abstention (_abs) questions stay out of the denominator unless --include-abstention.

**Range:** 0..1 per question type and aggregate, higher is better. Strict by construction: recall_all@k <= recall_any@k always.

### Lenient session recall at k (recall_any@k, LongMemEval)

**Key:** `recall_any@k`

**Plain English:** Did AT LEAST ONE gold session land among the distinct sessions in the top k retrieved chunks? The lenient companion to recall_all@k — a partial-evidence hit still counts. Per-row `recall_hit` is a deprecated alias of this metric.

**Range:** 0..1, higher is better. Reported alongside recall_all@k; the gap between them is the partial-evidence rate.

### Judged QA accuracy (LongMemEval, LLM-as-judge)

**Key:** `qa_accuracy`

**Plain English:** Of all questions in the run, what fraction did the judge model mark correct against the gold answer (official LongMemEval prompts)? The headline scores every question the judge could not grade (timeouts, refusals, malformed verdicts, budget skips) as INCORRECT, so it is never more lenient than the official scorer; the companion accuracy_excluding_errors drops those rows from the denominator and the judge_errors count says how many there were.

**Range:** 0..1, higher is better. Only comparable across runs with the same reader model, judge model, prompt version and dataset revision.

### Mean returned results per question (autocut benefit, LongMemEval replay)

**Key:** `mean_returned_results`

**Plain English:** Across the questions in an autocut floor replay, the mean number of chunk rows in the returned window (the first k rows autocut kept). This is the benefit side of the autocut trade: fewer rows per question means less context the answer model has to read. Compare it against recall_all@k, the guardrail, at each floor.

**Range:** 0..k, lower is better ONLY while recall_all@k holds. Equals k whenever autocut never trims inside the window (e.g. floor `off`).

### Mean estimated tokens returned per question (autocut benefit, LongMemEval replay)

**Key:** `mean_returned_est_tokens`

**Plain English:** Across the questions in an autocut floor replay, the mean of the summed estimated tokens (chars / 4) of the returned window. The token-denominated twin of mean_returned_results: the direct measure of how much conversational memory each question pushes into the answer model at a given floor.

**Range:** 0..unbounded, lower is better ONLY while recall_all@k holds. Approximates OpenAI tiktoken counts for English; off by ~5-10% for other tokenizers.

---

## Coverage

Every metric printed by any `gbrain eval *` or `gbrain search stats` command resolves through `getMetricGloss()` in `src/core/eval/metric-glossary.ts`. Adding a new metric to the glossary REQUIRES updating this doc; the CI guard catches drift.

