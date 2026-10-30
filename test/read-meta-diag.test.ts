/**
 * Self-describing slow-read documents (core/read-heartbeat.ts) and the bounded `gbrain diag` bundle.
 *
 * 1. Protects: a slow read's --json document gains elapsed_ms and complete, and complete is false with each field
 *    named when a field was not read (a `*_read` with status not_read), a listing is paged or capped, a budget stopped
 *    the run or a doctor check is unknown for its budget; an error envelope never claims complete; diag returns every
 *    section with its own elapsed_ms and status, says not_read with reason budget for what its budget cut off and
 *    not_applicable for what cannot apply, and never lists search results.
 * 2. Fails when: completeness is assumed, a cut-off section silently disappears, or diag waits past its budget.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { beginSlowRead, endSlowRead, incompleteFields, withReadMeta } from '../src/core/read-heartbeat.ts';
import { collectDiag, diagSection, DIAG_PROBE_QUERY } from '../src/commands/diag.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const quiet = { json: true, writeErr: () => {} };

describe('withReadMeta', () => {
  test('a document with nothing left out is complete, with the elapsed time since the read began', () => {
    let clock = 1_000;
    beginSlowRead('orphan pages', { ...quiet, now: () => clock });
    clock = 4_500;
    expect(withReadMeta<Record<string, unknown>>({ total: 3 }, clock)).toEqual({ total: 3, elapsed_ms: 3_500, complete: true });
  });

  test('each marker of a cut makes it incomplete and is named', () => {
    beginSlowRead('sync status for source alpha-example', quiet);
    const doc = withReadMeta({
      sources: [{ id: 'alpha-example', holds_read: { status: 'not_read', fix: 'gbrain sync status --detail' } }],
      git_holds: { count: 40, items_complete: false },
      budget_hit: true,
      checks: [{ name: 'a', details: { health: 'unknown', reason: 'budget' } }, { name: 'b', status: 'ok' }],
    }) as Record<string, unknown>;
    expect(doc.complete).toBe(false);
    expect(doc.incomplete).toEqual([
      { field: 'sources[0].holds_read', reason: 'not_read' },
      { field: 'git_holds.items_complete', reason: 'bounded' },
      { field: 'budget_hit', reason: 'budget' },
      { field: 'checks[0].details', reason: 'budget' },
    ]);
  });

  test('a paged listing keeps its own complete flag; an error envelope gets elapsed_ms only; an array is unchanged', () => {
    beginSlowRead('orphan pages', quiet);
    expect(withReadMeta({ complete: false, next_cursor: 'c1' })).toMatchObject({ complete: false, next_cursor: 'c1' });
    beginSlowRead('sync status for source alpha-example', quiet);
    const error = withReadMeta({ error: 'invalid_params', code: 'invalid_params' }) as Record<string, unknown>;
    expect(typeof error.elapsed_ms).toBe('number');
    expect('complete' in error).toBe(false);
    beginSlowRead('anomalous cohorts', quiet);
    expect(withReadMeta([{ cohort: 'x' }])).toEqual([{ cohort: 'x' }]);
  });

  test('outside a read nothing is added, and the read ends with its document', () => {
    endSlowRead();
    expect(withReadMeta({ total: 1 })).toEqual({ total: 1 });
    expect(incompleteFields({ a: { b: [{ status: 'not_read' }] } })).toEqual([{ field: 'a.b[0]', reason: 'not_read' }]);
  });
});

describe('gbrain diag', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  test('every section answers with its own elapsed time and status; what cannot apply says so', async () => {
    const doc = await collectDiag(engine, { budgetMs: 30_000, query: DIAG_PROBE_QUERY }) as Record<string, Record<string, unknown>>;
    for (const name of ['gbrain', 'skew', 'sources', 'holds', 'pool', 'search']) {
      expect(typeof doc[name]!.elapsed_ms).toBe('number');
      expect(['ok', 'not_read', 'not_applicable', 'error']).toContain(doc[name]!.status as string);
    }
    expect(doc.gbrain).toMatchObject({ status: 'ok', engine: 'pglite' });
    expect(doc.sources).toMatchObject({ status: 'ok', count: 1 });
    expect(doc.holds).toMatchObject({ status: 'ok', total: 0, by_source: {} });
    expect(doc.pool).toMatchObject({ status: 'not_applicable' });
    expect(doc.search).toMatchObject({ status: 'not_applicable' });
  }, 60_000);

  test('the search section times one search and reports its result count, never its results', async () => {
    const makeContext = async (e: BrainEngine) => ({ engine: e, config: { engine: 'pglite', embedding_disabled: true }, remote: false, dryRun: false, sourceId: 'default',
      logger: { info() {}, warn() {}, error() {} } }) as never;
    await engine.putPage('notes/probe', { type: 'note', title: 'Probe', compiled_truth: 'gbrain diagnostic probe text', timeline: '', frontmatter: {} }, { sourceId: 'default' });
    const doc = await collectDiag(engine, { budgetMs: 30_000, query: DIAG_PROBE_QUERY, makeContext }) as Record<string, Record<string, unknown>>;
    expect(doc.search).toMatchObject({ status: 'ok', query: DIAG_PROBE_QUERY });
    expect(typeof doc.search!.result_count).toBe('number');
    expect(JSON.stringify(doc.search)).not.toContain('notes/probe');
  }, 60_000);

  test('a section past its time says not_read with reason budget, and the bundle does not wait for it', async () => {
    const started = performance.now();
    const slow = await diagSection(() => new Promise(resolve => setTimeout(() => resolve({ late: true }), 5_000)), 100, performance.now() + 10_000);
    expect(slow).toMatchObject({ status: 'not_read', reason: 'budget' });
    expect(performance.now() - started).toBeLessThan(2_000);
    const spent = await diagSection(async () => ({ never: true }), 1_000, performance.now() - 1);
    expect(spent).toMatchObject({ status: 'not_read', reason: 'budget', elapsed_ms: 0 });
    const failed = await diagSection(async () => { throw Object.assign(new Error('relation missing'), { code: '42P01' }); }, 1_000, performance.now() + 1_000);
    expect(failed).toMatchObject({ status: 'error', code: 'schema_behind' });
  });

  test.skipIf(!process.env.DATABASE_URL)('on Postgres the pool section reads connections and the sessions the server ended', async () => {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    try {
      const doc = await collectDiag(pg.engine, { budgetMs: 30_000, query: DIAG_PROBE_QUERY }) as Record<string, Record<string, unknown>>;
      expect(doc.pool).toMatchObject({ status: 'ok' });
      expect(doc.pool!.max_connections).toBeGreaterThan(0);
      expect(doc.pool!.backends).toBeGreaterThanOrEqual(1);
      expect((doc.pool!.sessions_ended as { status: string }).status).toMatch(/^(ok|not_read)$/);
    } finally { await pg.close(); }
  }, 120_000);

  test('a spent bundle budget marks every later section not_read', async () => {
    const doc = await collectDiag(engine, { budgetMs: 1, query: DIAG_PROBE_QUERY }) as Record<string, Record<string, unknown>>;
    await Bun.sleep(5);
    const late = ['holds', 'pool', 'search'].map(name => doc[name]!);
    expect(late.every(s => s.status === 'not_read' && s.reason === 'budget')).toBe(true);
  }, 60_000);
});
