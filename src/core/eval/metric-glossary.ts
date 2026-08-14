/**
 * v0.32.3 — Single source of truth for evaluation-metric plain-English
 * glosses. Drives `gbrain search stats` JSON output (`_meta.metric_glossary`
 * block), `gbrain eval compare` reports, and the auto-generated
 * `docs/eval/METRIC_GLOSSARY.md` file.
 *
 * Per [CDX-25]: glosses live in one `_meta.metric_glossary` block per
 * response, NOT as sibling `_gloss` fields on every metric. Less invasive
 * to machine-readable consumers (gbrain-evals repo, CI gates).
 *
 * Every entry has THREE fields:
 *   - industry_term: the canonical name used in IR / NLP literature
 *     (preserved verbatim so users searching the literature find what we
 *     report)
 *   - eli10: plain-English explanation a 16-year-old could follow
 *   - range: explicit numeric range + interpretation ("higher is better",
 *     "0..1 where 1 = perfect")
 *
 * The doc generator at `scripts/generate-metric-glossary.ts` consumes this
 * module and writes `docs/eval/METRIC_GLOSSARY.md`. A CI guard
 * (`scripts/check-eval-glossary-fresh.sh`) regenerates the doc and diffs
 * against the committed version — out-of-date docs fail the build.
 */

export interface MetricGlossEntry {
  industry_term: string;
  eli10: string;
  range: string;
}

export const METRIC_GLOSSARY: Readonly<Record<string, Readonly<MetricGlossEntry>>> = Object.freeze({
  // ────────────────────────────────────────────────────────────────────────
  // Retrieval metrics (IR literature)
  // ────────────────────────────────────────────────────────────────────────
  'precision@k': Object.freeze({
    industry_term: 'Precision at k (P@k)',
    eli10: 'Of the top k results the engine returned, what fraction were actually relevant? High precision means few junk results in the top of the list.',
    range: '0..1, higher is better. P@10 = 0.7 means 7 of the top 10 results were on-topic.',
  }),
  'recall@k': Object.freeze({
    industry_term: 'Recall at k (R@k)',
    eli10: 'Of all the relevant results that exist in the brain, what fraction did the engine find in its top k? High recall means few missed answers.',
    range: '0..1, higher is better. R@10 = 0.81 means out of every 100 questions, the right answer was in the top 10 for 81 of them.',
  }),
  'mrr': Object.freeze({
    industry_term: 'Mean Reciprocal Rank (MRR)',
    eli10: 'On average, how far down the list is the FIRST relevant result? An MRR of 1.0 means the first hit is always right; an MRR of 0.5 means it\'s typically at rank 2.',
    range: '0..1, higher is better. Computed as the average of 1/rank-of-first-relevant-result across all test queries.',
  }),
  'ndcg@k': Object.freeze({
    industry_term: 'Normalized Discounted Cumulative Gain at k (nDCG@k)',
    eli10: 'Like precision@k, but the engine gets MORE credit for putting good results near the top than near rank k. A perfect ordering scores 1.0; a totally random ordering scores near 0.',
    range: '0..1, higher is better. nDCG@10 above 0.65 is the common "ship it" threshold for hybrid retrieval on technical corpora.',
  }),

  // ────────────────────────────────────────────────────────────────────────
  // NamedThingBench (retrieval-quality) + the agent-facing evidence contract
  // ────────────────────────────────────────────────────────────────────────
  'hit@1': Object.freeze({
    industry_term: 'Hit rate at 1 (Hit@1)',
    eli10: 'Fraction of queries where the right page is the very first result. NamedThingBench hard-gates title-substring Hit@1 >= 0.95 and alias Hit@1 >= 0.98 — a query that is a page\'s name or title phrase should land it at rank 1, not "somewhere in the top 10".',
    range: '0..1, higher is better.',
  }),
  'hit@3': Object.freeze({
    industry_term: 'Hit rate at 3 (Hit@3)',
    eli10: 'Fraction of queries where the right page is in the top 3 results. NamedThingBench requires the multi-chunk-dilution family to hit 1.0 — a page with one strong chunk among many weak ones must never be buried.',
    range: '0..1, higher is better.',
  }),
  'avg_rank1_score': Object.freeze({
    industry_term: 'Average rank-1 match score',
    eli10: 'The mean base (pre-boost) retrieval score of the TOP result across recent searches, from `gbrain search stats`. It is NOT a labeled accuracy number — it is a drift signal: if this trends DOWN over time, retrieval quality is regressing (the early warning that would have caught the duplicate-page incident before a human did).',
    range: '0..1. Watch the trend, not the absolute value; pair with the <0.6 / 0.6-0.85 / >=0.85 bucket counts for shape.',
  }),
  'create_safety': Object.freeze({
    industry_term: 'Create-safety hint (evidence contract)',
    eli10: 'A result\'s answer to "is this page already in the brain — safe to NOT write a new one?" Derived from the strongest evidence, NOT a raw score: exists (alias_hit / exact_title_match / high_vector_match — do not duplicate), probable (solid keyword match — prefer updating), unknown (weak match — look closer). An agent keys its don\'t-duplicate decision off this, which is what prevents the incident\'s duplicate-stub class.',
    range: 'enum: exists | probable | unknown',
  }),

  // ────────────────────────────────────────────────────────────────────────
  // Set-similarity / stability metrics (replay + regression checks)
  // ────────────────────────────────────────────────────────────────────────
  'jaccard@k': Object.freeze({
    industry_term: 'Jaccard similarity at k (set Jaccard @k)',
    eli10: 'How much do two result lists overlap? Compare the top k slugs from the captured baseline against the current run; Jaccard@10 = 1.0 means perfect agreement, 0.0 means zero overlap.',
    range: '0..1, higher = more stable. Below 0.5 on a stable corpus means retrieval changed significantly.',
  }),
  'top1_stability': Object.freeze({
    industry_term: 'Top-1 stability rate',
    eli10: 'Fraction of queries where the #1 result is the same between two runs. The most aggressive stability check — small ranking shifts that don\'t change the top answer don\'t hurt it.',
    range: '0..1, higher = more stable. Above 0.85 typically means safe-to-merge for retrieval changes.',
  }),

  // ────────────────────────────────────────────────────────────────────────
  // Statistical-significance metrics (per-mode comparison)
  // ────────────────────────────────────────────────────────────────────────
  'p_value': Object.freeze({
    industry_term: 'p-value (paired bootstrap)',
    eli10: 'How likely the observed difference between two modes is just noise. Lower = stronger evidence the difference is real. We compute paired bootstrap with 10,000 resamples and Bonferroni correction across the 12 comparisons (3 modes × 4 metrics).',
    range: '0..1, lower = stronger signal. Below 0.05 is the common "statistically significant" threshold; below 0.01 is strong evidence.',
  }),
  'confidence_interval': Object.freeze({
    industry_term: '95% Confidence Interval (CI)',
    eli10: 'The range we\'re 95% sure the true value falls inside, given the sample we measured. Narrower CI = more reliable estimate. Computed via bootstrap resampling.',
    range: 'Two-tuple [low, high]. If 0 is inside the CI for a Δ, the difference isn\'t statistically significant.',
  }),

  // ────────────────────────────────────────────────────────────────────────
  // Operational / cost metrics
  // ────────────────────────────────────────────────────────────────────────
  'cache_hit_rate': Object.freeze({
    industry_term: 'Cache hit rate',
    eli10: 'Fraction of searches that reused a recent cached answer instead of running fresh. Higher hit rate = lower latency + lower LLM spend, but stale results may slip through if the threshold is too loose.',
    range: '0..1, higher generally better. 0.7-0.9 is the sweet spot for a busy brain; above 0.9 may indicate the similarity threshold is too loose.',
  }),
  'avg_results': Object.freeze({
    industry_term: 'Average results returned',
    eli10: 'Mean number of search-result rows the engine returned per call. Should be near the active mode\'s searchLimit unless the brain is small or the budget is dropping results.',
    range: '0..searchLimit. Far below searchLimit suggests budget pressure or sparse retrieval.',
  }),
  'avg_tokens': Object.freeze({
    industry_term: 'Average tokens delivered',
    eli10: 'Estimated tokens (chars / 4) in the chunk text returned per search call. The direct measure of how much context an agent loop is paying for each search.',
    range: '0..tokenBudget. Approximates OpenAI tiktoken count for English; off by ~5-10% for Anthropic and worse for non-English.',
  }),
  'cost_per_query_usd': Object.freeze({
    industry_term: 'Cost per query (USD)',
    eli10: 'Sum of LLM + embedding API charges for one search call. Includes Haiku expansion call (tokenmax mode only) + embedding cost + downstream answer-model cost if measured.',
    range: '0..unbounded. Conservative mode is typically <\\$0.001 per call; tokenmax with answer-gen can exceed \\$0.01.',
  }),
  'p99_latency_ms': Object.freeze({
    industry_term: 'p99 latency (ms)',
    eli10: '99th percentile wall-clock time per search call. The latency that 1% of users see — long-tail experience, not the average.',
    range: '0..unbounded. Warm-cache hits should be <50ms; tokenmax with expansion can exceed 200ms due to the Haiku call.',
  }),

  // ────────────────────────────────────────────────────────────────────────
  // Result-sizing metrics (v0.42.3.0 autocut)
  // ────────────────────────────────────────────────────────────────────────
  'autocut.signal': Object.freeze({
    industry_term: 'Autocut signal',
    eli10: "Which signal autocut used to size the result set. 'rerank' means it found a real score cliff in the cross-encoder rerank scores and cut there; 'none' means no trustworthy cliff (no reranker, <2 scored results, or the gap was too small) so it returned the full list.",
    range: "'rerank' | 'none'. 'none' is not a failure — it means autocut declined to cut because the signal didn't justify it.",
  }),
  'autocut.gap_ratio': Object.freeze({
    industry_term: 'Autocut gap ratio',
    eli10: 'The size of the largest score drop autocut found, as a fraction of the top result\'s score. A gap of 0.40 means the score fell by 40% of the top score at the steepest point. Autocut cuts there only when this clears the sensitivity threshold (autocut_jump, default 0.20).',
    range: '0..1, higher = a sharper cliff (more confident cut). Below the autocut_jump threshold → no cut.',
  }),

  // ────────────────────────────────────────────────────────────────────────
  // BrainBench — cross-harness memory conformance suite
  // (`gbrain eval brainbench`; docs/eval/BRAINBENCH.md)
  // ────────────────────────────────────────────────────────────────────────
  'know_to_ask_failure_rate': Object.freeze({
    industry_term: 'Know-to-ask failure rate (BrainBench)',
    eli10: 'Of the conversation turns where memory SHOULD have surfaced something unprompted, the fraction where nothing relevant was injected. This is the thesis failure mode every agent harness shares: the agent can\'t ask for what it doesn\'t know it forgot — the memory layer has to volunteer it.',
    range: '0..1, LOWER is better. 0.15 means memory stayed silent on 15% of the turns where it had the answer.',
  }),
  'false_fire_rate': Object.freeze({
    industry_term: 'False-fire rate (BrainBench)',
    eli10: 'Of the turns where memory should have stayed SILENT, the fraction where it injected anyway. The anti-gaming companion to the know-to-ask rate — "always inject" would ace one and bomb the other. Silence beats noise.',
    range: '0..1, LOWER is better.',
  }),
  'push_precision': Object.freeze({
    industry_term: 'Push precision (BrainBench)',
    eli10: 'Of everything the memory layer volunteered into context, what fraction was actually relevant to the turn? Micro-averaged over injected pointers, so a 3-pointer turn weighs three times a 1-pointer turn — the way a token budget experiences it.',
    range: '0..1, higher is better.',
  }),
  'push_recall': Object.freeze({
    industry_term: 'Push recall (BrainBench)',
    eli10: 'Of everything that SHOULD have been volunteered (the gold pointers), what fraction actually was? Pointer budgets cap this by design: a seam that may inject only 1 fragment cannot reach full recall on a 3-entity turn — that constraint is what the per-harness rows measure.',
    range: '0..1, higher is better.',
  }),
  'write_back_fidelity': Object.freeze({
    industry_term: 'Write-back fidelity (BrainBench)',
    eli10: 'Of the facts stated in a conversation, what fraction survived the PRODUCTION conversation→memory pipeline (segmentation, insertion, dedup) and are findable afterward with the right entity attached? Measures the write path users actually run, not a test-only insert.',
    range: '0..1, higher is better.',
  }),
  'provenance_accuracy': Object.freeze({
    industry_term: 'Provenance accuracy (BrainBench)',
    eli10: 'Of the facts that survived write-back, what fraction carry correct provenance — the right source tag, session id, and origin page? A fact you can\'t trace is a fact you can\'t trust, audit, or expire.',
    range: '0..1, higher is better.',
  }),
  'continuity_rate': Object.freeze({
    industry_term: 'Cross-session continuity rate (BrainBench)',
    eli10: 'A decision is recorded in one session and persisted through the production write path; a different harness asks about it later on the same brain. What fraction of those decision probes were recalled — by pointer injection or stored-fact lookup? This is the continuity-that-survives-the-harness-hop moat, measured.',
    range: '0..1, higher is better. Scored per reader harness (the v1 write path is harness-independent, disclosed in docs/eval/BRAINBENCH.md).',
  }),
  'source_isolation_violations': Object.freeze({
    industry_term: 'Source-isolation violations (BrainBench)',
    eli10: 'Count of injected pointers that belong to a source other than the active one. Cross-source leakage is gbrain\'s must-never-violate invariant (a missed source filter is a data leak), so this gates at ZERO — any baseline, any run.',
    range: '0..n, count. MUST be 0; any value above 0 fails the gate.',
  }),
  'avg_injected_tokens': Object.freeze({
    industry_term: 'Average injected tokens per turn (BrainBench)',
    eli10: 'Estimated tokens of volunteered context per replayed turn (chars/4 heuristic). The intrusion-budget diagnostic: two seams with equal precision can differ 3x in how much context they spend to get it. Reported, not gated, until calibration data exists.',
    range: '0..n tokens, judgment call — lower is cheaper, but starving the agent has its own cost. Non-gating.',
  }),
  'extraction_recall': Object.freeze({
    industry_term: 'Extraction recall (BrainBench --llm)',
    eli10: 'With the real LLM extractor running (instead of the deterministic gold extractor), what fraction of the gold facts did it actually extract and persist? Only scored in --llm runs — the hermetic CI gate never calls a model.',
    range: '0..1, higher is better. Absent in deterministic runs.',
  }),
  'extraction_precision': Object.freeze({
    industry_term: 'Extraction precision (BrainBench --llm)',
    eli10: 'Of everything the real LLM extractor persisted, what fraction matches a gold fact? Low precision means the extractor invents or over-extracts — junk memory that pollutes future recall.',
    range: '0..1, higher is better. Absent in deterministic runs.',
  }),
});

/**
 * Public accessor — returns the gloss entry for a metric, or null if
 * unknown. Callers that need the structured shape use this; callers that
 * just need the plain-English line use eli10For().
 */
export function getMetricGloss(metric: string): MetricGlossEntry | null {
  if (METRIC_GLOSSARY[metric]) return METRIC_GLOSSARY[metric];
  // Fuzzy fallback for @N metrics: `recall@10` → `recall@k`, `ndcg@5` → `ndcg@k`.
  // The glossary documents the family ("at k"); reports use a specific K value.
  const atK = metric.match(/^(.+)@\d+$/);
  if (atK) {
    const family = `${atK[1]}@k`;
    if (METRIC_GLOSSARY[family]) return METRIC_GLOSSARY[family];
  }
  return null;
}

/**
 * Convenience: return ONLY the plain-English gloss for a metric. Used in
 * `gbrain search stats` JSON output's _meta.metric_glossary block and in
 * the eval-compare report's per-metric "Plain English:" lines.
 */
export function eli10For(metric: string): string | null {
  const g = getMetricGloss(metric);
  return g?.eli10 ?? null;
}

/**
 * Build a `_meta.metric_glossary` block for a set of metrics. Returns an
 * object suitable for JSON.stringify-ing under the `_meta` key in any
 * eval / stats response.
 *
 * Per [CDX-25]: ONE _meta.metric_glossary per response, NOT sibling
 * _gloss fields on every numeric metric. Adding a metric to the response
 * doesn't bloat the JSON; the glossary lives in a single place per
 * response, indexed by metric name.
 */
export function buildMetricGlossaryMeta(metrics: ReadonlyArray<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of metrics) {
    const e = getMetricGloss(m); // routes through fuzzy fallback
    if (e) out[m] = e.eli10;
  }
  return out;
}

/**
 * The list of EVERY metric this module documents. Auto-derived from the
 * METRIC_GLOSSARY keys so the doc generator can iterate without drift.
 */
export const ALL_METRICS: ReadonlyArray<string> = Object.freeze(Object.keys(METRIC_GLOSSARY));

/**
 * Render the glossary as a Markdown document. Consumed by
 * `scripts/generate-metric-glossary.ts` to produce
 * `docs/eval/METRIC_GLOSSARY.md`. The CI guard regenerates this and
 * diffs against the committed file — out-of-date docs fail the build.
 *
 * The output is deterministic: same input → same output bytes.
 */
export function renderMetricGlossaryMarkdown(): string {
  const lines: string[] = [];
  lines.push('# Evaluation Metric Glossary');
  lines.push('');
  lines.push('**Auto-generated from `src/core/eval/metric-glossary.ts`. Do not edit by hand.** Run `bun run scripts/generate-metric-glossary.ts` to regenerate.');
  lines.push('');
  lines.push('Every metric `gbrain eval *` and `gbrain search stats` reports has a plain-English explanation here. Industry terms are preserved verbatim so users searching the literature find what we report.');
  lines.push('');

  const groups: Array<[string, string[]]> = [
    ['Retrieval Metrics', ['precision@k', 'recall@k', 'mrr', 'ndcg@k']],
    ['Retrieval-Quality / Evidence Metrics (NamedThingBench)', ['hit@1', 'hit@3', 'avg_rank1_score', 'create_safety']],
    ['Set-Similarity / Stability Metrics', ['jaccard@k', 'top1_stability']],
    ['Statistical-Significance Metrics', ['p_value', 'confidence_interval']],
    ['Operational / Cost Metrics', ['cache_hit_rate', 'avg_results', 'avg_tokens', 'cost_per_query_usd', 'p99_latency_ms']],
    ['Result-Sizing Metrics', ['autocut.signal', 'autocut.gap_ratio']],
    ['BrainBench — Cross-Harness Memory Conformance', [
      'know_to_ask_failure_rate', 'false_fire_rate', 'push_precision', 'push_recall',
      'write_back_fidelity', 'provenance_accuracy', 'continuity_rate',
      'source_isolation_violations', 'avg_injected_tokens',
      'extraction_recall', 'extraction_precision',
    ]],
  ];

  for (const [groupTitle, metrics] of groups) {
    lines.push(`## ${groupTitle}`);
    lines.push('');
    for (const m of metrics) {
      const e = METRIC_GLOSSARY[m];
      if (!e) continue;
      lines.push(`### ${e.industry_term}`);
      lines.push('');
      lines.push(`**Key:** \`${m}\``);
      lines.push('');
      lines.push(`**Plain English:** ${e.eli10}`);
      lines.push('');
      lines.push(`**Range:** ${e.range}`);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('## Coverage');
  lines.push('');
  lines.push(`Every metric printed by any \`gbrain eval *\` or \`gbrain search stats\` command resolves through \`getMetricGloss()\` in \`src/core/eval/metric-glossary.ts\`. Adding a new metric to the glossary REQUIRES updating this doc; the CI guard catches drift.`);
  lines.push('');

  return lines.join('\n') + '\n';
}
