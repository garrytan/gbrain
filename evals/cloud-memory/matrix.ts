/** Fixed benchmark conditions and paired statistics; no provider calls or gold-label selection. */
import { holmAdjusted, pairedClusterStatistics } from '../../src/core/eval/paired-bootstrap.ts';

export interface Condition {
  id: string;
  corpus: 'full' | 'recent';
  embeddings: boolean;
  mode: 'local' | 'fast' | 'thinking';
}

export function benchmarkConditions(): Condition[] {
  return (['full', 'recent'] as const).flatMap(corpus => [true, false].flatMap(embeddings =>
    (['local', 'fast', 'thinking'] as const).map(mode => ({
      id: `${corpus}/${embeddings ? 'embeddings' : 'no-embeddings'}/${mode}`, corpus, embeddings, mode,
    }))));
}

export interface BenchmarkRow extends Condition {
  question_id: string;
  question_type: string;
  repeat: number;
  backend: string;
  vector_enabled: boolean;
  recall_any: boolean;
  recall_all: boolean;
  gold_found: number;
  gold_total: number;
  latency_ms: number;
  returned: number;
  embedding_requests: number;
  cloud_requests: number;
  cloud_statuses: number[];
  markdown_chars: number;
  query_error: string | null;
  degraded: unknown;
}

export function summarizeMatrix(rows: BenchmarkRow[]) {
  return benchmarkConditions().map(condition => {
    const measurements = rows.filter(r => r.id === condition.id);
    const first = measurements.filter(r => r.repeat === 0);
    const times = measurements.map(r => r.latency_ms).sort((a, b) => a - b);
    const denominator = first.reduce((n, r) => n + r.gold_total, 0);
    return { ...condition, questions: first.length, measurements: measurements.length,
      recall_any_at_k: first.length ? first.filter(r => r.recall_any).length / first.length : null,
      recall_all_at_k: first.length ? first.filter(r => r.recall_all).length / first.length : null,
      gold_session_recall: denominator ? first.reduce((n, r) => n + r.gold_found, 0) / denominator : null,
      p50_ms: times.length ? times[Math.floor(times.length / 2)] : null,
      p95_ms: times.length ? times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] : null,
      cloud_fallbacks: condition.mode === 'local' ? 0 : measurements.filter(r => r.backend !== 'hydradb' && !r.query_error).length,
      cloud_errors: condition.mode === 'local' ? 0 : measurements.filter(r => r.query_error).length,
      query_errors: measurements.filter(r => r.query_error).length,
      embedding_requests: measurements.reduce((n, r) => n + r.embedding_requests, 0),
    };
  });
}

/** Compare every predeclared axis, correcting one family of 18 primary-metric comparisons. */
export function compareMatrix(rows: BenchmarkRow[], seed = 20261014, draws = 10000) {
  const conditions = benchmarkConditions();
  const pairs: Array<{ kind: string; baseline: string; candidate: string }> = [];
  for (const c of conditions.filter(c => c.mode !== 'local')) {
    pairs.push({ kind: 'cloud-vs-local', baseline: `${c.corpus}/${c.embeddings ? 'embeddings' : 'no-embeddings'}/local`, candidate: c.id });
    if (c.mode === 'thinking') pairs.push({ kind: 'thinking-vs-fast', baseline: c.id.replace('/thinking', '/fast'), candidate: c.id });
  }
  for (const c of conditions.filter(c => c.embeddings)) {
    pairs.push({ kind: 'embeddings-vs-no-embeddings', baseline: c.id.replace('/embeddings/', '/no-embeddings/'), candidate: c.id });
  }
  const first = new Map(rows.filter(r => r.repeat === 0).map(r => [`${r.id}:${r.question_id}`, r]));
  const comparisons = pairs.map(pair => {
    const baseline = rows.filter(r => r.id === pair.baseline && r.repeat === 0);
    const observations = baseline.map(row => {
      const candidate = first.get(`${pair.candidate}:${row.question_id}`);
      if (!candidate) throw new Error('Incomplete paired benchmark; do not drop missing observations.');
      return { cluster: row.question_id, baseline: Number(row.recall_all), candidate: Number(candidate.recall_all) };
    });
    if (!observations.length) throw new Error('Cannot compare an empty benchmark condition.');
    return { ...pair, metric: 'recall_all_at_k', ...pairedClusterStatistics(observations, { seed, draws }) };
  });
  const adjusted = holmAdjusted(comparisons.map(c => c.p_value));
  return comparisons.map((c, i) => ({ ...c, holm_p_value: adjusted[i],
    benefit_supported: c.delta > 0 && c.lower95 > 0 && adjusted[i] <= 0.05,
    regression_supported: c.delta < 0 && c.upper95 < 0 && adjusted[i] <= 0.05,
  }));
}
