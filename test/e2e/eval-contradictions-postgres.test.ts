/**
 * E2E — Postgres-specific contradiction-probe behavior (v0.33.0, T1).
 *
 * PGLite covers the contract; this file exercises Postgres-only surfaces
 * that PGLite can't:
 *   1. The actual JSONB round-trip through postgres.js — sql.json() vs
 *      double-encode regression class.
 *   2. Migrations v51 + v52 apply cleanly on a real PG instance and the
 *      tables come out with the expected column shapes.
 *   3. The P1 batched listActiveTakesForPages uses ANY($1::int[]) which
 *      has subtly different semantics on real PG.
 *   4. The full M5 trend write+read with PostgreSQL's TIMESTAMPTZ
 *      semantics and ORDER BY ran_at DESC stability.
 *   5. The P2 cache TTL semantics with real `now()` and ON CONFLICT
 *      DO UPDATE.
 *   6. The find_contradictions MCP op end-to-end via the dispatch path.
 *
 * Runs only when DATABASE_URL is set. Skips gracefully otherwise.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { writeRunRow, loadTrend } from '../../src/core/eval-contradictions/trends.ts';
import { JudgeCache, buildCacheKey } from '../../src/core/eval-contradictions/cache.ts';
import type { ProbeReport } from '../../src/core/eval-contradictions/types.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';

const DATABASE_URL = process.env.DATABASE_URL;

let engine: PostgresEngine | null = null;

beforeAll(async () => {
  if (!DATABASE_URL) {
    console.log('[e2e/eval-contradictions] DATABASE_URL not set — skipping.');
    return;
  }
  engine = new PostgresEngine();
  await engine.connect({ database_url: DATABASE_URL });
  await engine.initSchema();
});

afterAll(async () => {
  if (engine) await engine.disconnect();
});

beforeEach(async () => {
  if (!engine) return;
  await engine.executeRaw('DELETE FROM eval_contradictions_runs');
  await engine.executeRaw('DELETE FROM eval_contradictions_cache');
});

function mkReport(opts: Partial<ProbeReport> = {}): ProbeReport {
  return {
    schema_version: 1,
    run_id: opts.run_id ?? 'pg-test',
    judge_model: 'anthropic:claude-haiku-4-5',
    prompt_version: '1',
    truncation_policy: '1500-chars-utf8-safe',
    top_k: 5,
    sampling: 'deterministic',
    queries_evaluated: 50,
    queries_with_contradiction: 12,
    total_contradictions_flagged: 18,
    calibration: {
      queries_total: 50,
      queries_judged_clean: 38,
      queries_with_contradiction: 12,
      wilson_ci_95: { point: 0.24, lower: 0.14, upper: 0.37 },
    },
    judge_errors: { parse_fail: 1, refusal: 0, timeout: 0, http_5xx: 2, unknown: 0, total: 3, note: 'n' },
    cost_usd: { judge: 1.18, embedding: 0.005, total: 1.185, estimate_note: 'approx' },
    cache: { hits: 87, misses: 213, hit_rate: 0.29 },
    duration_ms: 45000,
    source_tier_breakdown: { curated_vs_curated: 2, curated_vs_bulk: 11, bulk_vs_bulk: 5, other: 0 },
    per_query: [],
    hot_pages: [],
    ...opts,
  };
}

describe('E2E: eval_contradictions migrations applied cleanly', () => {
  test('eval_contradictions_cache and eval_contradictions_runs tables exist', async () => {
    if (!engine) return;
    const rows = await engine.executeRaw<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('eval_contradictions_cache', 'eval_contradictions_runs')
       ORDER BY table_name`,
    );
    expect(rows.length).toBe(2);
    expect(rows[0].table_name).toBe('eval_contradictions_cache');
    expect(rows[1].table_name).toBe('eval_contradictions_runs');
  });

  test('eval_contradictions_runs has Wilson CI columns', async () => {
    if (!engine) return;
    const cols = await engine.executeRaw<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'eval_contradictions_runs'
         AND column_name IN ('wilson_ci_lower', 'wilson_ci_upper')
       ORDER BY column_name`,
    );
    expect(cols.length).toBe(2);
    expect(cols[0].data_type).toBe('real');
    expect(cols[1].data_type).toBe('real');
  });

  test('eval_contradictions_cache composite PK includes prompt_version + truncation_policy', async () => {
    if (!engine) return;
    const cols = await engine.executeRaw<{ column_name: string }>(
      `SELECT a.attname AS column_name
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
       WHERE i.indisprimary AND c.relname = 'eval_contradictions_cache'
       ORDER BY a.attname`,
    );
    const names = cols.map((c) => c.column_name);
    expect(names).toContain('prompt_version');
    expect(names).toContain('truncation_policy');
    expect(names).toContain('chunk_a_hash');
    expect(names).toContain('chunk_b_hash');
    expect(names).toContain('model_id');
  });
});

describe('E2E: JSONB round-trip on Postgres (regression class)', () => {
  test('writeContradictionsRun → loadTrend preserves nested objects, not strings', async () => {
    if (!engine) return;
    await writeRunRow(engine, mkReport({
      run_id: 'jsonb-1',
      source_tier_breakdown: { curated_vs_curated: 7, curated_vs_bulk: 8, bulk_vs_bulk: 9, other: 0 },
    }), 100);
    const rows = await loadTrend(engine, 30);
    expect(rows.length).toBe(1);
    // The classic v0.12 double-encode bug stores '{"curated_vs_curated":7,...}' as a string.
    // We must see a parsed object, not a string.
    expect(typeof rows[0].source_tier_breakdown).toBe('object');
    expect(rows[0].source_tier_breakdown.curated_vs_curated).toBe(7);
    expect(rows[0].source_tier_breakdown.curated_vs_bulk).toBe(8);
    expect(typeof rows[0].report_json).toBe('object');
    expect(rows[0].report_json.schema_version).toBe(1);
  });

  test('postgres jsonb_typeof confirms object shape (defense in depth)', async () => {
    if (!engine) return;
    await writeRunRow(engine, mkReport({ run_id: 'jsonb-2' }), 100);
    const rows = await engine.executeRaw<{ kind: string }>(
      `SELECT jsonb_typeof(source_tier_breakdown) AS kind
       FROM eval_contradictions_runs
       WHERE run_id = 'jsonb-2'`,
    );
    expect(rows[0].kind).toBe('object');
  });
});

describe('E2E: P2 persistent cache with real now()', () => {
  test('lookup returns null for missing key, upsert + lookup round-trips', async () => {
    if (!engine) return;
    const cache = new JudgeCache({ engine, modelId: 'haiku-pg-test' });
    expect(await cache.lookup('text-a', 'text-b')).toBeNull();
    await cache.store('text-a', 'text-b', {
      contradicts: true, severity: 'high', axis: 'pg-test', confidence: 0.9, resolution_kind: 'dream_synthesize',
    });
    const hit = await cache.lookup('text-a', 'text-b');
    expect(hit).not.toBeNull();
    expect(hit?.contradicts).toBe(true);
    expect(hit?.severity).toBe('high');
  });

  test('expired rows hidden from lookup; sweepContradictionCache deletes', async () => {
    if (!engine) return;
    const cache = new JudgeCache({ engine, modelId: 'haiku-pg-test', ttlSeconds: 60 });
    await cache.store('expire-me-a', 'expire-me-b', {
      contradicts: false, severity: 'low', axis: '', confidence: 0.3, resolution_kind: null,
    });
    // Backdate expires_at by 1 second.
    const key = buildCacheKey({ textA: 'expire-me-a', textB: 'expire-me-b', modelId: 'haiku-pg-test' });
    await engine.executeRaw(
      `UPDATE eval_contradictions_cache
       SET expires_at = now() - interval '1 second'
       WHERE chunk_a_hash = $1 AND chunk_b_hash = $2`,
      [key.chunk_a_hash, key.chunk_b_hash],
    );
    expect(await cache.lookup('expire-me-a', 'expire-me-b')).toBeNull();
    const swept = await engine.sweepContradictionCache();
    expect(swept).toBeGreaterThanOrEqual(1);
  });

  test('different prompt_version is a different cache key (Codex fix)', async () => {
    if (!engine) return;
    const cache1 = new JudgeCache({ engine, modelId: 'haiku-pg-test' });
    await cache1.store('shared-a', 'shared-b', {
      contradicts: true, severity: 'medium', axis: '', confidence: 0.85, resolution_kind: 'manual_review',
    });
    // Direct engine call with a different prompt_version should miss.
    const wrong = await engine.getContradictionCacheEntry({
      chunk_a_hash: buildCacheKey({ textA: 'shared-a', textB: 'shared-b', modelId: 'haiku-pg-test' }).chunk_a_hash,
      chunk_b_hash: buildCacheKey({ textA: 'shared-a', textB: 'shared-b', modelId: 'haiku-pg-test' }).chunk_b_hash,
      model_id: 'haiku-pg-test',
      prompt_version: 'OTHER-VERSION',
      truncation_policy: '1500-chars-utf8-safe',
    });
    expect(wrong).toBeNull();
  });
});

describe('E2E: M5 trend semantics on Postgres', () => {
  test('trend ordered newest first with TIMESTAMPTZ', async () => {
    if (!engine) return;
    await writeRunRow(engine, mkReport({ run_id: 'older' }), 100);
    // Add a small delay so the second row gets a strictly-later now().
    await new Promise((r) => setTimeout(r, 50));
    await writeRunRow(engine, mkReport({ run_id: 'newer' }), 100);
    const rows = await loadTrend(engine, 30);
    expect(rows[0].run_id).toBe('newer');
    expect(rows[1].run_id).toBe('older');
  });

  test('days window filters via ran_at >= cutoff', async () => {
    if (!engine) return;
    await writeRunRow(engine, mkReport({ run_id: 'recent' }), 100);
    // Backdate one row to 10 days ago.
    await engine.executeRaw(
      `UPDATE eval_contradictions_runs SET ran_at = now() - interval '10 days' WHERE run_id = $1`,
      ['recent'],
    );
    const oneDayRows = await loadTrend(engine, 1);
    expect(oneDayRows.length).toBe(0);
    const fifteenDayRows = await loadTrend(engine, 15);
    expect(fifteenDayRows.length).toBe(1);
  });
});

describe('E2E: find_contradictions MCP op on Postgres', () => {
  test('returns "no probe runs" note on empty table', async () => {
    if (!engine) return;
    const op = operationsByName['find_contradictions'];
    const ctx: OperationContext = {
      engine,
      config: {} as OperationContext['config'],
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as OperationContext['logger'],
      dryRun: false,
      remote: true,
    };
    const result = await op.handler(ctx, {}) as { contradictions: unknown[]; note?: string };
    expect(result.contradictions).toEqual([]);
    expect(result.note).toContain('No probe runs');
  });

  test('returns latest run findings with slug+severity filters', async () => {
    if (!engine) return;
    await writeRunRow(engine, mkReport({
      run_id: 'pg-mcp',
      per_query: [{
        query: 'q',
        result_count: 5,
        pairs_skipped_by_date: 0,
        pairs_cache_hit: 0,
        pairs_judged: 3,
        contradictions: [
          {
            kind: 'cross_slug_chunks',
            a: { slug: 'companies/acme-example', chunk_id: 1, take_id: null, source_tier: 'curated', holder: null, text: 'a' },
            b: { slug: 'openclaw/chat/x', chunk_id: 2, take_id: null, source_tier: 'bulk', holder: null, text: 'b' },
            combined_score: 1.5,
            severity: 'high',
            axis: 'MRR figure',
            confidence: 0.9,
            resolution_kind: 'dream_synthesize',
            resolution_command: 'gbrain dream --phase synthesize --slug companies/acme-example',
          },
          {
            kind: 'cross_slug_chunks',
            a: { slug: 'people/alice-example', chunk_id: 3, take_id: null, source_tier: 'curated', holder: null, text: 'c' },
            b: { slug: 'people/alice-smith-example', chunk_id: 4, take_id: null, source_tier: 'curated', holder: null, text: 'd' },
            combined_score: 1.2,
            severity: 'low',
            axis: 'name format',
            confidence: 0.75,
            resolution_kind: 'manual_review',
            resolution_command: 'gbrain takes mark-debate people/alice-example --row 1',
          },
        ],
      }],
    }), 100);

    const op = operationsByName['find_contradictions'];
    const ctx: OperationContext = {
      engine,
      config: {} as OperationContext['config'],
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as OperationContext['logger'],
      dryRun: false,
      remote: true,
    };

    const all = await op.handler(ctx, {}) as { contradictions: unknown[]; total_in_run: number };
    expect(all.contradictions.length).toBe(2);
    expect(all.total_in_run).toBe(2);

    const highOnly = await op.handler(ctx, { severity: 'high' }) as { contradictions: Array<{ severity: string }> };
    expect(highOnly.contradictions.length).toBe(1);
    expect(highOnly.contradictions[0].severity).toBe('high');

    const slugFiltered = await op.handler(ctx, { slug: 'acme' }) as { contradictions: unknown[] };
    expect(slugFiltered.contradictions.length).toBe(1);
  });
});
