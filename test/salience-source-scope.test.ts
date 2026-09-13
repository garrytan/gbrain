/**
 * A7 (test-gap wave 1) — source isolation for the salience/insights read trio.
 *
 * Pre-fix, `get_recent_salience` and `find_anomalies` queried `pages` with no
 * source filter, and `find_contradictions` surfaced report findings from any
 * source: a remote caller scoped to source A could read source B's slugs and
 * titles. DECIDED fail-closed: all three route through sourceScopeOpts(ctx);
 * the contradictions report keeps a finding only when BOTH endpoints resolve
 * inside the caller's scope.
 *
 * Anti-vacuity: every scoped assertion is paired with an unscoped local
 * control proving the fixture DOES leak without the scope (the test can fail).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
const get_recent_salience = operations.find(o => o.name === 'get_recent_salience')!;
const find_anomalies = operations.find(o => o.name === 'find_anomalies')!;
const find_contradictions = operations.find(o => o.name === 'find_contradictions')!;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: true,
    ...overrides,
  } as OperationContext;
}

/** Local trusted brain-wide ctx — the anti-vacuity control. */
const localUnscoped = () => ctxOf({ remote: false, sourceId: undefined });

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('alpha', 'alpha', '/tmp/alpha') ON CONFLICT (id) DO NOTHING`);
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('beta', 'beta', '/tmp/beta') ON CONFLICT (id) DO NOTHING`);
  // Two pages per source, all updated "now" (inside every salience window).
  await engine.putPage('alpha/one', {
    type: 'note', title: 'Alpha One', compiled_truth: 'alpha content one', frontmatter: {},
  }, { sourceId: 'alpha' });
  await engine.putPage('alpha/two', {
    type: 'note', title: 'Alpha Two', compiled_truth: 'alpha content two', frontmatter: {},
  }, { sourceId: 'alpha' });
  await engine.putPage('beta/secret-one', {
    type: 'note', title: 'Beta Secret One', compiled_truth: 'beta-only content', frontmatter: {},
  }, { sourceId: 'beta' });
  await engine.putPage('beta/secret-two', {
    type: 'note', title: 'Beta Secret Two', compiled_truth: 'beta-only content', frontmatter: {},
  }, { sourceId: 'beta' });
  // Tag cohorts for find_anomalies. Zero baseline history means a cohort is
  // anomalous at count > mean+1, i.e. >= 2 pages touched today.
  await engine.addTag('alpha/one', 'alpha-topic', { sourceId: 'alpha' });
  await engine.addTag('alpha/two', 'alpha-topic', { sourceId: 'alpha' });
  await engine.addTag('beta/secret-one', 'beta-topic', { sourceId: 'beta' });
  await engine.addTag('beta/secret-two', 'beta-topic', { sourceId: 'beta' });
});

function assertNoBeta(payload: unknown) {
  const text = JSON.stringify(payload);
  expect(text).not.toContain('beta/secret');
  expect(text).not.toContain('Beta Secret');
  expect(text).not.toContain('"beta"');
}

describe('get_recent_salience source scoping', () => {
  test('anti-vacuity control: local unscoped sees BOTH sources', async () => {
    const rows = await get_recent_salience.handler(localUnscoped(), {}) as Array<{ slug: string }>;
    const slugs = rows.map(r => r.slug);
    expect(slugs).toContain('alpha/one');
    expect(slugs).toContain('beta/secret-one');
  });

  test('remote scalar scope alpha: alpha rows only, no beta identity', async () => {
    const rows = await get_recent_salience.handler(ctxOf({ sourceId: 'alpha' }), {}) as Array<{ slug: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map(r => r.slug).sort()).toEqual(['alpha/one', 'alpha/two']);
    assertNoBeta(rows);
  });

  test('federated grant [alpha]: identical isolation', async () => {
    const ctx = ctxOf({ auth: { allowedSources: ['alpha'] } as any });
    const rows = await get_recent_salience.handler(ctx, {}) as Array<{ slug: string }>;
    expect(rows.length).toBeGreaterThan(0);
    assertNoBeta(rows);
  });

  test('remote __all__ sentinel fail-closes to empty', async () => {
    const rows = await get_recent_salience.handler(ctxOf({ sourceId: '__all__' }), {}) as Array<{ slug: string }>;
    expect(rows).toEqual([]);
  });
});

describe('find_anomalies source scoping', () => {
  test('anti-vacuity control: local unscoped surfaces the beta cohort', async () => {
    const rows = await find_anomalies.handler(localUnscoped(), {}) as Array<{ cohort_value: string; page_slugs: string[] }>;
    const cohorts = rows.map(r => r.cohort_value);
    expect(cohorts).toContain('beta-topic');
  });

  test('remote scalar scope alpha: no beta cohort, no beta slugs', async () => {
    const rows = await find_anomalies.handler(ctxOf({ sourceId: 'alpha' }), {}) as Array<{ cohort_value: string; page_slugs: string[] }>;
    expect(rows.map(r => r.cohort_value)).toContain('alpha-topic');
    assertNoBeta(rows);
  });

  test('federated grant [alpha]: identical isolation', async () => {
    const ctx = ctxOf({ auth: { allowedSources: ['alpha'] } as any });
    const rows = await find_anomalies.handler(ctx, {}) as Array<{ cohort_value: string; page_slugs: string[] }>;
    expect(rows.map(r => r.cohort_value)).toContain('alpha-topic');
    assertNoBeta(rows);
  });
});

describe('find_contradictions source scoping', () => {
  beforeEach(async () => {
    // Private in-scope content remains in the stored report. Only the
    // trusted, unscoped local control may inspect this historical payload.
    await engine.putPage('alpha/private-note', {
      type: 'note', title: 'Alpha Private', compiled_truth: 'alpha private content',
      frontmatter: { visibility: 'private' },
    }, { sourceId: 'alpha' });
    const finding = (aSlug: string, bSlug: string) => ({
      kind: 'direct', severity: 'high', axis: 'fact', confidence: 0.9,
      a: { slug: aSlug, chunk_id: null, take_id: null },
      b: { slug: bSlug, chunk_id: null, take_id: null },
      resolution_kind: 'manual', resolution_command: '',
    });
    await engine.writeContradictionsRun({
      run_id: 'fixture-run-1', judge_model: 'test', prompt_version: 'v1',
      queries_evaluated: 4, queries_with_contradiction: 4, total_contradictions_flagged: 4,
      wilson_ci_lower: 0, wilson_ci_upper: 1, judge_errors_total: 0,
      cost_usd_total: 0, duration_ms: 1,
      source_tier_breakdown: {},
      report_json: {
        per_query: [{
          contradictions: [
            finding('alpha/one', 'alpha/two'),           // fully in-scope for alpha
            finding('alpha/one', 'beta/secret-one'),     // cross-boundary — must drop
            finding('beta/secret-one', 'beta/secret-two'), // fully out-of-scope
            finding('alpha/one', 'alpha/private-note'),  // in-scope but private endpoint — remote must drop
          ],
        }],
      },
    });
  });

  const touchesPrivate = (res: { contradictions: Array<{ a: { slug: string }; b: { slug: string } }> }) =>
    res.contradictions.some(f => f.a.slug === 'alpha/private-note' || f.b.slug === 'alpha/private-note');

  test('anti-vacuity control: local unscoped returns all 4 findings (incl. the private-endpoint one)', async () => {
    const res = await find_contradictions.handler(localUnscoped(), {}) as { contradictions: Array<{ a: { slug: string }; b: { slug: string } }> };
    expect(res.contradictions.length).toBe(4);
    expect(touchesPrivate(res)).toBe(true);
  });

  // Stored text has no trustworthy snapshot provenance. Current endpoint
  // visibility cannot authorize old private content, so restricted readers
  // must receive an explicit unavailable result BEFORE loading any report.
  for (const [label, overrides] of [
    ['remote scalar', { sourceId: 'alpha' }],
    ['remote federated', { auth: { allowedSources: ['alpha'] } }],
    ['remote unscoped', {}],
    ['unset trust', { remote: undefined }],
    ['local scalar', { remote: false, sourceId: 'alpha' }],
    ['local federated', { remote: false, auth: { allowedSources: ['alpha'] } }],
    ['remote empty grant with scalar floor', { sourceId: 'alpha', auth: { allowedSources: [] } }],
    ['local empty grant with scalar floor', { remote: false, sourceId: 'alpha', auth: { allowedSources: [] } }],
  ] as const) {
    test(`${label}: reports unavailable before any database load`, async () => {
      const original = engine.loadContradictionsTrend;
      let loads = 0;
      engine.loadContradictionsTrend = async () => {
        loads++;
        throw new Error('Restricted callers must not load stored reports');
      };
      try {
        const res = await find_contradictions.handler(ctxOf(overrides as Partial<OperationContext>), { limit: 1, severity: 'high', slug: 'alpha/one' });
        expect(res).toEqual({
          contradictions: [],
          note: 'Stored contradiction reports are temporarily available only to trusted local callers without a source filter.',
        });
        expect(loads).toBe(0);
      } finally {
        engine.loadContradictionsTrend = original;
      }
    });
  }

  test('trusted unscoped local retains filters, limits and full-run totals', async () => {
    const res = await find_contradictions.handler(localUnscoped(), { limit: 1, slug: 'alpha/one', severity: 'high' }) as {
      contradictions: Array<{ a: { slug: string }; b: { slug: string } }>; total_in_run: number;
    };
    expect(res.contradictions).toHaveLength(1);
    expect(res.contradictions[0].a.slug).toBe('alpha/one');
    expect(res.total_in_run).toBe(4);
  });

  test('an empty grant without a scalar remains a legitimate unscoped local context', async () => {
    const res = await find_contradictions.handler(ctxOf({ remote: false, auth: { allowedSources: [] } as any }), {}) as {
      contradictions: unknown[];
    };
    expect(res.contradictions).toHaveLength(4);
  });
});
