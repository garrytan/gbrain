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
    ['Set-Similarity / Stability Metrics', ['jaccard@k', 'top1_stability']],
    ['Statistical-Significance Metrics', ['p_value', 'confidence_interval']],
    ['Operational / Cost Metrics', ['cache_hit_rate', 'avg_results', 'avg_tokens', 'cost_per_query_usd', 'p99_latency_ms']],
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
