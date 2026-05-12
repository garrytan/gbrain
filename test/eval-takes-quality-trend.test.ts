/**
 * takes-quality-eval/trend — DB-backed trend reader (codex review #6 +
 * #3 rubric segregation).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { loadTrend, renderTrendTable } from '../src/core/takes-quality-eval/trend.ts';
import { writeReceiptToDb } from '../src/core/takes-quality-eval/receipt-write.ts';
import type { TakesQualityReceipt } from '../src/core/takes-quality-eval/receipt.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

function fixture(opts: {
  corpus: string;
  rubric_version?: string;
  rubric_sha8?: string;
  ts?: string;
  verdict?: 'pass' | 'fail' | 'inconclusive';
  overall?: number;
}): TakesQualityReceipt {
  return {
    schema_version: 1,
    ts: opts.ts ?? new Date().toISOString(),
    rubric_version: opts.rubric_version ?? 'v1.0',
    rubric_sha8: opts.rubric_sha8 ?? 'rrrr0001',
    corpus: { source: 'db', n_takes: 5, slug_prefix: null, corpus_sha8: opts.corpus },
    prompt_sha8: 'pppp0001',
    models_sha8: 'mmmm0001',
    models: ['openai:gpt-4o'],
    cycles_run: 1,
    successes_per_cycle: [1],
    verdict: opts.verdict ?? 'pass',
    scores: {},
    overall_score: opts.overall ?? 7.5,
    cost_usd: 0.5,
  };
}

describe('loadTrend', () => {
  test('returns empty array when no runs recorded', async () => {
    const rows = await loadTrend(engine);
    expect(rows).toEqual([]);
  });

  test('returns rows ordered newest-first by created_at', async () => {
    const earlier = fixture({ corpus: 'tr0001', ts: '2026-05-01T00:00:00Z' });
    const later = fixture({ corpus: 'tr0002', ts: '2026-05-02T00:00:00Z' });
    await writeReceiptToDb(engine, earlier);
    await writeReceiptToDb(engine, later);

    const rows = await loadTrend(engine);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // The first 2 rows should be ordered newest-first within our test set.
    const ours = rows.filter(r => r.corpus_sha8 === 'tr0001' || r.corpus_sha8 === 'tr0002');
    expect(ours[0].corpus_sha8).toBe('tr0002');
    expect(ours[1].corpus_sha8).toBe('tr0001');
  });

  test('--limit caps the result count', async () => {
    const rows = await loadTrend(engine, { limit: 1 });
    expect(rows).toHaveLength(1);
  });

  test('Codex review #3: --rubric-version filters cleanly across rubric epochs', async () => {
    await writeReceiptToDb(engine, fixture({
      corpus: 'tr0010', rubric_version: 'v1.0', rubric_sha8: 'r0001',
    }));
    await writeReceiptToDb(engine, fixture({
      corpus: 'tr0011', rubric_version: 'v2.0', rubric_sha8: 'r0002',
    }));

    const v1Rows = await loadTrend(engine, { rubricVersion: 'v1.0' });
    const v2Rows = await loadTrend(engine, { rubricVersion: 'v2.0' });

    expect(v1Rows.every(r => r.rubric_version === 'v1.0')).toBe(true);
    expect(v2Rows.every(r => r.rubric_version === 'v2.0')).toBe(true);
    expect(v1Rows.some(r => r.corpus_sha8 === 'tr0010')).toBe(true);
    expect(v2Rows.some(r => r.corpus_sha8 === 'tr0011')).toBe(true);
  });
});

describe('renderTrendTable', () => {
  test('produces a header + sep + row lines', () => {
    const out = renderTrendTable([
      { id: 1, ts: '2026-05-09T22:00:00Z', rubric_version: 'v1.0', verdict: 'pass', overall_score: 7.3, cost_usd: 1.85, corpus_sha8: 'aaaa1111' },
    ]);
    expect(out).toContain('verdict');
    expect(out).toContain('aaaa1111');
    expect(out).toContain('pass');
  });

  test('empty rows → friendly message', () => {
    const out = renderTrendTable([]);
    expect(out).toContain('No takes-quality runs recorded yet');
  });
});
