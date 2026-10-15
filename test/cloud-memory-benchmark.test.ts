/** Prevent benchmark summaries from dropping errors, mixing conditions or treating a small apparent win as evidence. */
import { expect, test } from 'bun:test';
import { benchmarkConditions, compareMatrix, summarizeMatrix, type BenchmarkRow } from '../evals/cloud-memory/matrix.ts';

function row(id: string, question: string, overrides: Partial<BenchmarkRow> = {}): BenchmarkRow {
  const condition = benchmarkConditions().find(c => c.id === id)!;
  return { ...condition, question_id: question, question_type: 'synthetic', repeat: 0, backend: 'local',
    vector_enabled: condition.embeddings, recall_any: false, recall_all: false, gold_found: 0, gold_total: 1,
    latency_ms: 10, returned: 0, embedding_requests: 0, cloud_requests: 0, cloud_statuses: [],
    markdown_chars: 0, query_error: null, degraded: [], ...overrides };
}

test('the matrix covers both corpora and embedding settings for local, fast and thinking exactly once', () => {
  const conditions = benchmarkConditions();
  expect(conditions).toHaveLength(12);
  expect(new Set(conditions.map(c => c.id)).size).toBe(12);
  for (const corpus of ['full', 'recent']) for (const embeddings of [true, false]) {
    expect(conditions.filter(c => c.corpus === corpus && c.embeddings === embeddings).map(c => c.mode)).toEqual(['local', 'fast', 'thinking']);
  }
});

test('errors stay in quality denominators; repetitions affect latency and fallback counts rather than first-pass quality', () => {
  const id = 'full/no-embeddings/fast';
  const rows = [row(id, 'q1', { backend: 'hydradb', recall_all: true, recall_any: true, gold_found: 1 }),
    row(id, 'q2', { query_error: 'operation_error', latency_ms: 20 }),
    row(id, 'q1', { repeat: 1, backend: 'local', latency_ms: 30 })];
  const summary = summarizeMatrix(rows).find(c => c.id === id)!;
  expect(summary.questions).toBe(2);
  expect(summary.measurements).toBe(3);
  expect(summary.recall_all_at_k).toBe(0.5);
  expect(summary.gold_session_recall).toBe(0.5);
  expect(summary.query_errors).toBe(1);
  expect(summary.cloud_errors).toBe(1);
  expect(summary.cloud_fallbacks).toBe(1);
  expect(summary.p50_ms).toBe(20);
  expect(summary.p95_ms).toBe(30);
});

test('paired comparisons join questions within the declared conditions and correct the complete family', () => {
  const rows = benchmarkConditions().flatMap(c => Array.from({ length: 20 }, (_, i) => row(c.id, `q${i}`, {
    recall_all: c.mode !== 'local', recall_any: c.mode !== 'local', gold_found: Number(c.mode !== 'local'),
    backend: c.mode === 'local' ? 'local' : 'hydradb',
  }))).reverse();
  const comparisons = compareMatrix(rows);
  expect(comparisons).toHaveLength(18);
  const cloud = comparisons.filter(c => c.kind === 'cloud-vs-local');
  expect(cloud).toHaveLength(8);
  for (const comparison of cloud) {
    expect(comparison.n).toBe(20);
    expect(comparison.wins).toBe(20);
    expect(comparison.losses).toBe(0);
    expect(comparison.delta).toBe(1);
    expect(comparison.benefit_supported).toBe(true);
    expect(comparison.holm_p_value).toBeGreaterThanOrEqual(comparison.p_value);
  }
  expect(comparisons.filter(c => c.kind === 'thinking-vs-fast').every(c => c.delta === 0 && !c.benefit_supported)).toBe(true);
});

test('a two-question apparent win cannot be advertised as a supported benefit', () => {
  const rows = benchmarkConditions().flatMap(c => ['q1', 'q2'].map(q => row(c.id, q, { recall_all: c.mode !== 'local' })));
  expect(compareMatrix(rows).every(c => !c.benefit_supported)).toBe(true);
});

test('missing paired observations stop comparison rather than silently shrinking the sample', () => {
  const rows = benchmarkConditions().map(c => row(c.id, 'q1'));
  expect(() => compareMatrix(rows.filter(r => r.id !== 'full/embeddings/fast'))).toThrow('Incomplete paired benchmark');
});
