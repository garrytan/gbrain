/**
 * N2-2 — bare `gbrain find-contradictions` reads the latest run.
 *
 * skills/correction-pipeline/SKILL.md documents the bare command as reading
 * the latest probe run. makeContext always populates ctx.sourceId (falling
 * back to 'default'), so the op's source-filter refusal fired for every local
 * CLI call. Driven through the real CLI seam (makeContext) so the implicit
 * source marker and the op handler are tested together; user-selected
 * sources (--source, GBRAIN_SOURCE) still get the unavailable note.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { makeContext } from '../src/cli.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const UNAVAILABLE = 'Stored contradiction reports are temporarily available only to trusted local callers without a source filter.';
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('alpha', 'alpha')`);
  await engine.writeContradictionsRun({
    run_id: 'cli-run-1', judge_model: 'test', prompt_version: 'v1',
    queries_evaluated: 1, queries_with_contradiction: 1, total_contradictions_flagged: 1,
    wilson_ci_lower: 0, wilson_ci_upper: 1, judge_errors_total: 0,
    cost_usd_total: 0, duration_ms: 1, source_tier_breakdown: {},
    report_json: {
      per_query: [{
        contradictions: [{
          kind: 'cross_slug_chunks', severity: 'medium', axis: 'headcount', confidence: 0.9,
          a: { slug: 'notes/a', chunk_id: 1, take_id: null },
          b: { slug: 'notes/b', chunk_id: 2, take_id: null },
          resolution_kind: 'manual_review', resolution_command: '# manual review',
        }],
      }],
    },
  });
});

const findContradictions = (params: Record<string, unknown>) =>
  withEnv({ GBRAIN_SOURCE: undefined }, async () => {
    const ctx = await makeContext(engine, params);
    return operationsByName['find_contradictions'].handler(ctx, {}) as Promise<{
      run_id?: string; contradictions: unknown[]; note?: string;
    }>;
  });

describe('find-contradictions through the local CLI context', () => {
  test('bare command (implicit default source) reads the latest run', async () => {
    const res = await findContradictions({});
    expect(res.note).toBeUndefined();
    expect(res.run_id).toBe('cli-run-1');
    expect(res.contradictions).toHaveLength(1);
  });

  test('--source <id> is a filter the report cannot honor: unavailable note', async () => {
    const res = await findContradictions({ source: 'alpha' });
    expect(res).toEqual({ contradictions: [], note: UNAVAILABLE });
  });

  test('--source __all__ still spans the brain', async () => {
    const res = await findContradictions({ source: '__all__' });
    expect(res.run_id).toBe('cli-run-1');
  });

  test('GBRAIN_SOURCE is user-selected scope: unavailable note', async () => {
    const res = await withEnv({ GBRAIN_SOURCE: 'alpha' }, async () => {
      const ctx = await makeContext(engine, {});
      return operationsByName['find_contradictions'].handler(ctx, {});
    });
    expect(res).toEqual({ contradictions: [], note: UNAVAILABLE });
  });
});
