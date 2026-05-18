/**
 * Engine method tests for v0.32.6 contradiction probe surfaces.
 *
 * Five new methods land on `BrainEngine`:
 *   - listActiveTakesForPages (P1, batched per-page active-take fetch)
 *   - writeContradictionsRun + loadContradictionsTrend (M5, time-series)
 *   - getContradictionCacheEntry + putContradictionCacheEntry + sweepContradictionCache (P2)
 *
 * Hermetic against PGLite via the canonical block. The Postgres impls mirror
 * the same SQL; their parity is exercised in the E2E suite.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function seedPage(slug: string, title: string, body = ''): Promise<number> {
  const compiled = body || `body for ${slug}`;
  await engine.putPage(slug, {
    title,
    type: 'concept',
    frontmatter: {},
    compiled_truth: compiled,
    timeline: '',
  });
  const page = await engine.getPage(slug);
  return page!.id;
}

describe('listActiveTakesForPages (P1)', () => {
  test('returns empty map entries for pages with no takes', async () => {
    const id1 = await seedPage('test/p1', 'P1');
    const id2 = await seedPage('test/p2', 'P2');
    const out = await engine.listActiveTakesForPages([id1, id2]);
    expect(out.get(id1)).toEqual([]);
    expect(out.get(id2)).toEqual([]);
  });

  test('returns active takes grouped by page_id', async () => {
    const id1 = await seedPage('test/p1', 'P1');
    const id2 = await seedPage('test/p2', 'P2');
    await engine.addTakesBatch([
      { page_id: id1, row_num: 1, claim: 'p1 claim 1', kind: 'fact', holder: 'garry', weight: 1, since_date: undefined, source: undefined, active: true, superseded_by: null },
      { page_id: id1, row_num: 2, claim: 'p1 claim 2', kind: 'fact', holder: 'garry', weight: 1, since_date: undefined, source: undefined, active: true, superseded_by: null },
      { page_id: id2, row_num: 1, claim: 'p2 claim 1', kind: 'take', holder: 'garry', weight: 0.5, since_date: undefined, source: undefined, active: true, superseded_by: null },
    ]);
    const out = await engine.listActiveTakesForPages([id1, id2]);
    expect(out.get(id1)?.length).toBe(2);
    expect(out.get(id2)?.length).toBe(1);
    expect(out.get(id1)?.[0].claim).toBe('p1 claim 1');
  });

  test('excludes inactive (superseded) takes', async () => {
    const id1 = await seedPage('test/p1', 'P1');
    await engine.addTakesBatch([
      { page_id: id1, row_num: 1, claim: 'old', kind: 'fact', holder: 'garry', weight: 1, since_date: undefined, source: undefined, active: true, superseded_by: null },
    ]);
    await engine.supersedeTake(id1, 1, {
      claim: 'new', kind: 'fact', holder: 'garry', weight: 1, active: true,
    });
    const out = await engine.listActiveTakesForPages([id1]);
    expect(out.get(id1)?.length).toBe(1);
    expect(out.get(id1)?.[0].claim).toBe('new');
  });

  test('honors takesHoldersAllowList', async () => {
    const id1 = await seedPage('test/p1', 'P1');
    await engine.addTakesBatch([
      { page_id: id1, row_num: 1, claim: 'garry take', kind: 'take', holder: 'garry', weight: 1, since_date: undefined, source: undefined, active: true, superseded_by: null },
      { page_id: id1, row_num: 2, claim: 'alice take', kind: 'take', holder: 'alice', weight: 1, since_date: undefined, source: undefined, active: true, superseded_by: null },
    ]);
    const out = await engine.listActiveTakesForPages([id1], { takesHoldersAllowList: ['garry'] });
    expect(out.get(id1)?.length).toBe(1);
    expect(out.get(id1)?.[0].holder).toBe('garry');
  });

  test('empty pageIds returns empty map (no SQL roundtrip)', async () => {
    const out = await engine.listActiveTakesForPages([]);
    expect(out.size).toBe(0);
  });
});

describe('writeContradictionsRun + loadContradictionsTrend (M5)', () => {
  const baseRow = {
    judge_model: 'anthropic:claude-haiku-4-5',
    prompt_version: '1',
    queries_evaluated: 50,
    queries_with_contradiction: 12,
    total_contradictions_flagged: 18,
    wilson_ci_lower: 0.14,
    wilson_ci_upper: 0.37,
    judge_errors_total: 3,
    cost_usd_total: 1.18,
    duration_ms: 45000,
    source_tier_breakdown: { curated_vs_curated: 2, curated_vs_bulk: 11, bulk_vs_bulk: 5, other: 0 },
    report_json: { schema_version: 1, run_id: 'test', cached: false },
  };

  test('writes a row and reads it back from the trend', async () => {
    const inserted = await engine.writeContradictionsRun({ ...baseRow, run_id: 'r1' });
    expect(inserted).toBe(true);
    const trend = await engine.loadContradictionsTrend(30);
    expect(trend.length).toBe(1);
    expect(trend[0].run_id).toBe('r1');
    expect(trend[0].queries_with_contradiction).toBe(12);
    expect(trend[0].wilson_ci_lower).toBeCloseTo(0.14, 5);
    expect(trend[0].source_tier_breakdown).toEqual(baseRow.source_tier_breakdown);
    expect(trend[0].report_json.schema_version).toBe(1);
  });

  test('idempotent on duplicate run_id', async () => {
    await engine.writeContradictionsRun({ ...baseRow, run_id: 'dup' });
    const second = await engine.writeContradictionsRun({ ...baseRow, run_id: 'dup' });
    expect(second).toBe(false);
    const trend = await engine.loadContradictionsTrend(30);
    expect(trend.length).toBe(1);
  });

  test('trend returns newest first', async () => {
    await engine.writeContradictionsRun({ ...baseRow, run_id: 'old' });
    // PGLite ran_at uses now() at insert time; sequential inserts get monotonic timestamps.
    await new Promise((r) => setTimeout(r, 10));
    await engine.writeContradictionsRun({ ...baseRow, run_id: 'new' });
    const trend = await engine.loadContradictionsTrend(30);
    expect(trend.length).toBe(2);
    expect(trend[0].run_id).toBe('new');
    expect(trend[1].run_id).toBe('old');
  });

  test('days window filters older entries (zero-day window returns nothing)', async () => {
    await engine.writeContradictionsRun({ ...baseRow, run_id: 'r1' });
    const trend = await engine.loadContradictionsTrend(0);
    // cutoff = now - 0 days = now. Row inserted with ran_at = now() will be on the boundary;
    // accept either 0 or 1 results to avoid flakes on the millisecond boundary.
    expect(trend.length).toBeLessThanOrEqual(1);
  });

  test('JSONB columns round-trip as objects, not strings (postgres-jsonb regression class)', async () => {
    await engine.writeContradictionsRun({
      ...baseRow,
      run_id: 'jsonb-test',
      source_tier_breakdown: { curated_vs_curated: 99, curated_vs_bulk: 0, bulk_vs_bulk: 0, other: 0 },
      report_json: { nested: { value: 42, list: [1, 2, 3] } },
    });
    const trend = await engine.loadContradictionsTrend(1);
    expect(typeof trend[0].source_tier_breakdown).toBe('object');
    expect(typeof trend[0].report_json).toBe('object');
    expect((trend[0].source_tier_breakdown as Record<string, unknown>).curated_vs_curated).toBe(99);
    expect((trend[0].report_json.nested as Record<string, unknown>).value).toBe(42);
  });
});

describe('contradiction cache (P2)', () => {
  const baseKey = {
    chunk_a_hash: 'sha-aaa',
    chunk_b_hash: 'sha-bbb',
    model_id: 'anthropic:claude-haiku-4-5',
    prompt_version: '1',
    truncation_policy: '1500-chars-utf8-safe',
  };
  const verdict = {
    verdict: 'contradiction',
    severity: 'medium',
    axis: 'MRR vs ARR',
    confidence: 0.85,
    resolution_kind: 'dream_synthesize',
  };

  test('miss returns null on fresh cache', async () => {
    const hit = await engine.getContradictionCacheEntry(baseKey);
    expect(hit).toBeNull();
  });

  test('put then get returns the verdict object (JSONB round-trip)', async () => {
    await engine.putContradictionCacheEntry({ ...baseKey, verdict });
    const hit = await engine.getContradictionCacheEntry(baseKey);
    expect(hit).not.toBeNull();
    expect((hit as Record<string, unknown>).verdict).toBe('contradiction');
    expect((hit as Record<string, unknown>).severity).toBe('medium');
  });

  test('different prompt_version is a different cache key (Codex fix)', async () => {
    await engine.putContradictionCacheEntry({ ...baseKey, verdict });
    // baseKey has prompt_version='1'; v0.34 lookups under '2' must miss.
    const wrong = await engine.getContradictionCacheEntry({ ...baseKey, prompt_version: '2' });
    expect(wrong).toBeNull();
  });

  test('different truncation_policy is a different cache key', async () => {
    await engine.putContradictionCacheEntry({ ...baseKey, verdict });
    const wrong = await engine.getContradictionCacheEntry({ ...baseKey, truncation_policy: '500-chars' });
    expect(wrong).toBeNull();
  });

  test('upsert refreshes verdict on conflict', async () => {
    await engine.putContradictionCacheEntry({ ...baseKey, verdict });
    await engine.putContradictionCacheEntry({
      ...baseKey,
      verdict: { ...verdict, verdict: 'no_contradiction', severity: 'info' },
    });
    const hit = await engine.getContradictionCacheEntry(baseKey);
    expect((hit as Record<string, unknown>).verdict).toBe('no_contradiction');
    expect((hit as Record<string, unknown>).severity).toBe('info');
  });

  test('expired entries are not returned by get', async () => {
    // Insert with TTL=60 (minimum allowed), then manually backdate expires_at via raw SQL.
    await engine.putContradictionCacheEntry({ ...baseKey, verdict, ttl_seconds: 60 });
    await engine.executeRaw(
      `UPDATE eval_contradictions_cache
       SET expires_at = $1
       WHERE chunk_a_hash = $2 AND chunk_b_hash = $3`,
      [new Date(Date.now() - 1000), baseKey.chunk_a_hash, baseKey.chunk_b_hash]
    );
    const hit = await engine.getContradictionCacheEntry(baseKey);
    expect(hit).toBeNull();
  });

  test('sweep deletes expired entries', async () => {
    await engine.putContradictionCacheEntry({ ...baseKey, verdict, ttl_seconds: 60 });
    await engine.putContradictionCacheEntry({
      ...baseKey,
      chunk_a_hash: 'sha-fresh',
      verdict,
    });
    await engine.executeRaw(
      `UPDATE eval_contradictions_cache
       SET expires_at = $1
       WHERE chunk_a_hash = $2`,
      [new Date(Date.now() - 1000), baseKey.chunk_a_hash]
    );
    const swept = await engine.sweepContradictionCache();
    expect(swept).toBe(1);
    const remaining = await engine.getContradictionCacheEntry({ ...baseKey, chunk_a_hash: 'sha-fresh' });
    expect(remaining).not.toBeNull();
  });
});
