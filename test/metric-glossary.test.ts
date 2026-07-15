/**
 * v0.32.3 — metric glossary module tests.
 * Pins the public surface that drives gbrain search stats / eval compare
 * output AND the auto-generated METRIC_GLOSSARY.md doc.
 */
import { describe, expect, test } from 'bun:test';
import {
  METRIC_GLOSSARY,
  ALL_METRICS,
  getMetricGloss,
  eli10For,
  buildMetricGlossaryMeta,
  renderMetricGlossaryMarkdown,
} from '../src/core/eval/metric-glossary.ts';

describe('METRIC_GLOSSARY canonical entries', () => {
  test('every retrieval-IR metric is present', () => {
    for (const m of ['precision@k', 'recall@k', 'mrr', 'ndcg@k']) {
      expect(METRIC_GLOSSARY[m]).toBeDefined();
    }
  });

  test('every stability metric is present', () => {
    for (const m of ['jaccard@k', 'top1_stability']) {
      expect(METRIC_GLOSSARY[m]).toBeDefined();
    }
  });

  test('every stat-significance metric is present', () => {
    for (const m of ['p_value', 'confidence_interval']) {
      expect(METRIC_GLOSSARY[m]).toBeDefined();
    }
  });

  test('every operational metric is present', () => {
    for (const m of ['cache_hit_rate', 'avg_results', 'avg_tokens', 'cost_per_query_usd', 'p99_latency_ms']) {
      expect(METRIC_GLOSSARY[m]).toBeDefined();
    }
  });

  test('every entry has the three required fields', () => {
    for (const [key, entry] of Object.entries(METRIC_GLOSSARY)) {
      expect(entry.industry_term, `${key}.industry_term`).toBeTruthy();
      expect(entry.eli10, `${key}.eli10`).toBeTruthy();
      expect(entry.range, `${key}.range`).toBeTruthy();
    }
  });

  test('industry_term preserved verbatim (case-sensitive)', () => {
    expect(METRIC_GLOSSARY['ndcg@k'].industry_term).toBe('Normalized Discounted Cumulative Gain at k (nDCG@k)');
    expect(METRIC_GLOSSARY['mrr'].industry_term).toBe('Mean Reciprocal Rank (MRR)');
  });
});

describe('getMetricGloss + eli10For accessors', () => {
  test('getMetricGloss returns the full entry', () => {
    const g = getMetricGloss('recall@k');
    expect(g).not.toBeNull();
    expect(g!.industry_term).toContain('Recall at k');
  });

  test('getMetricGloss returns null for unknown metrics', () => {
    expect(getMetricGloss('made_up_metric')).toBeNull();
  });

  test('eli10For returns just the plain-English line', () => {
    const text = eli10For('cache_hit_rate');
    expect(text).toContain('Fraction of searches');
  });

  test('eli10For returns null for unknown metric', () => {
    expect(eli10For('nope')).toBeNull();
  });
});

describe('buildMetricGlossaryMeta', () => {
  test('returns a flat record keyed by metric name → eli10 string', () => {
    const meta = buildMetricGlossaryMeta(['recall@k', 'mrr']);
    expect(Object.keys(meta).sort()).toEqual(['mrr', 'recall@k']);
    expect(meta['recall@k']).toContain('relevant');
    expect(meta['mrr']).toContain('FIRST relevant result');
  });

  test('unknown metrics silently dropped (no error)', () => {
    const meta = buildMetricGlossaryMeta(['recall@k', 'made_up']);
    expect(meta['recall@k']).toBeDefined();
    expect(meta['made_up']).toBeUndefined();
  });

  test('empty array → empty object', () => {
    expect(buildMetricGlossaryMeta([])).toEqual({});
  });
});

describe('ALL_METRICS roster', () => {
  test('has every glossary key', () => {
    expect([...ALL_METRICS].sort()).toEqual(Object.keys(METRIC_GLOSSARY).sort());
  });

  test('matches the renderer output (no orphans)', () => {
    const md = renderMetricGlossaryMarkdown();
    for (const m of ALL_METRICS) {
      const entry = METRIC_GLOSSARY[m];
      expect(md, `Markdown should mention ${m}`).toContain(entry.industry_term);
    }
  });
});

describe('renderMetricGlossaryMarkdown determinism', () => {
  test('repeated calls produce identical output (deterministic)', () => {
    const a = renderMetricGlossaryMarkdown();
    const b = renderMetricGlossaryMarkdown();
    expect(a).toBe(b);
  });

  test('output includes the auto-generated marker', () => {
    const md = renderMetricGlossaryMarkdown();
    expect(md).toContain('Auto-generated from `src/core/eval/metric-glossary.ts`');
  });

  test('output groups metrics into 4 sections', () => {
    const md = renderMetricGlossaryMarkdown();
    expect(md).toContain('## Retrieval Metrics');
    expect(md).toContain('## Set-Similarity / Stability Metrics');
    expect(md).toContain('## Statistical-Significance Metrics');
    expect(md).toContain('## Operational / Cost Metrics');
  });
});
