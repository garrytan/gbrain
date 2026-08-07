/**
 * Source-isolation regression for the v0.29 read ops the #861 (v0.34.1) sweep
 * missed: get_recent_salience and find_anomalies. Both are scope:'read' and
 * reachable over MCP, yet pre-fix ignored the caller's source scope entirely —
 * a source-bound OAuth client could read salient pages and anomaly cohorts from
 * every source in the brain. (get_recent_transcripts is NOT covered: it is
 * localOnly + remote-gated, so it's fail-closed to remote callers by design.)
 *
 * Runs against PGLite in-memory (exercises both engines' parity surface).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

// A minimal remote ctx for driving op handlers directly (matches the
// source-isolation-pglite regression's dispatcher simulation).
function ctxFor(scope: { sourceId?: string; allowedSources?: string[] }) {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: true,
    sourceId: scope.sourceId,
    ...(scope.allowedSources
      ? { auth: { token: 't', clientId: 't', scopes: ['read'], allowedSources: scope.allowedSources } }
      : {}),
  } as never;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // 'default' is seeded by initSchema; add src-b.
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ('src-b', 'src-b', '{}'::jsonb) ON CONFLICT DO NOTHING`,
  );

  // Same slug in both sources — proves filtering is on source_id, not slug.
  await engine.putPage('people/alice', { type: 'person', title: 'Alice A', compiled_truth: 'A' }, { sourceId: 'default' });
  await engine.putPage('people/alice', { type: 'person', title: 'Alice B', compiled_truth: 'B' }, { sourceId: 'src-b' });

  // 3 default pages tagged `spikea`, 3 src-b pages tagged `spikeb`, all touched
  // today. Empty baseline (no history in the lookback window) + count > 1 makes
  // each tag cohort fire the zero-baseline anomaly branch, scoped to its source.
  for (let i = 0; i < 3; i++) {
    await engine.putPage(`notes/a-${i}`, { type: 'note', title: `A note ${i}`, compiled_truth: 'x' }, { sourceId: 'default' });
    await engine.addTag(`notes/a-${i}`, 'spikea', { sourceId: 'default' });
    await engine.putPage(`notes/b-${i}`, { type: 'note', title: `B note ${i}`, compiled_truth: 'y' }, { sourceId: 'src-b' });
    await engine.addTag(`notes/b-${i}`, 'spikeb', { sourceId: 'src-b' });
  }
}, 30_000); // PGLite initSchema + seeding exceeds the default 5s hook timeout

afterAll(async () => {
  if (engine) await engine.disconnect();
});

describe('get_recent_salience source isolation', () => {
  test('sourceId=default excludes src-b rows (incl. the shared slug)', async () => {
    const rows = await engine.getRecentSalience({ days: 30, limit: 100, sourceId: 'default' });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.source_id).toBe('default');
    // The shared slug resolves to the default page, never src-b's.
    expect(rows.find((r) => r.title === 'Alice B')).toBeUndefined();
  });

  test('sourceId=src-b excludes default rows', async () => {
    const rows = await engine.getRecentSalience({ days: 30, limit: 100, sourceId: 'src-b' });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.source_id).toBe('src-b');
  });

  test('sourceIds=[default,src-b] returns the union', async () => {
    const rows = await engine.getRecentSalience({ days: 30, limit: 100, sourceIds: ['default', 'src-b'] });
    const sources = new Set(rows.map((r) => r.source_id));
    expect(sources.has('default')).toBe(true);
    expect(sources.has('src-b')).toBe(true);
  });

  test('no source scope returns all sources (trusted local unchanged)', async () => {
    const rows = await engine.getRecentSalience({ days: 30, limit: 100 });
    expect(new Set(rows.map((r) => r.source_id)).size).toBeGreaterThanOrEqual(2);
  });

  test('op handler threads ctx.sourceId through sourceScopeOpts', async () => {
    const { operations } = await import('../../src/core/operations.ts');
    const op = operations.find((o) => o.name === 'get_recent_salience')!;
    const rows = (await op.handler(ctxFor({ sourceId: 'src-b' }), { days: 30, limit: 100 })) as Array<{ source_id: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.source_id).toBe('src-b');
  });
});

describe('find_anomalies source isolation', () => {
  const slugsOf = (rows: Array<{ page_slugs: string[] }>) => rows.flatMap((r) => r.page_slugs);

  test('sourceId=default surfaces only default cohorts/slugs', async () => {
    const rows = await engine.findAnomalies({ sourceId: 'default' });
    expect(rows.find((r) => r.cohort_value === 'spikea')).toBeDefined();
    expect(rows.find((r) => r.cohort_value === 'spikeb')).toBeUndefined();
    for (const s of slugsOf(rows)) expect(s.startsWith('notes/b-')).toBe(false);
  });

  test('sourceId=src-b surfaces only src-b cohorts/slugs', async () => {
    const rows = await engine.findAnomalies({ sourceId: 'src-b' });
    expect(rows.find((r) => r.cohort_value === 'spikeb')).toBeDefined();
    expect(rows.find((r) => r.cohort_value === 'spikea')).toBeUndefined();
    for (const s of slugsOf(rows)) expect(s.startsWith('notes/a-')).toBe(false);
  });

  test('sourceIds=[default,src-b] surfaces both cohorts', async () => {
    const rows = await engine.findAnomalies({ sourceIds: ['default', 'src-b'] });
    expect(rows.find((r) => r.cohort_value === 'spikea')).toBeDefined();
    expect(rows.find((r) => r.cohort_value === 'spikeb')).toBeDefined();
  });

  test('op handler threads ctx.sourceId through sourceScopeOpts', async () => {
    const { operations } = await import('../../src/core/operations.ts');
    const op = operations.find((o) => o.name === 'find_anomalies')!;
    const rows = (await op.handler(ctxFor({ sourceId: 'src-b' }), {})) as Array<{ cohort_value: string; page_slugs: string[] }>;
    expect(rows.find((r) => r.cohort_value === 'spikea')).toBeUndefined();
    for (const s of rows.flatMap((r) => r.page_slugs)) expect(s.startsWith('notes/a-')).toBe(false);
  });
});
