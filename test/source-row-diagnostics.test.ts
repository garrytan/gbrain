/**
 * The source-row diagnostic (test/helpers/source-row-diagnostics.ts) that #6427 and the
 * managed-atoms connector case attach to a `source_changed` failure.
 * Protects: the original error is rethrown with what the engine and a fresh client saw;
 * other errors and successes pass through untouched.
 * Seams: none; PGLite always, Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { opError } from '../src/core/ops/contract.ts';
import { withSourceRowDiagnostics } from './helpers/source-row-diagnostics.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

for (const backend of testBackends()) describe(`${backend}: withSourceRowDiagnostics`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  beforeAll(async () => {
    if (backend === 'postgres') {
      const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engine = pg.engine;
      close = pg.close;
    } else {
      const pglite = new PGLiteEngine();
      await pglite.connect({});
      await pglite.initSchema();
      engine = pglite;
      close = () => pglite.disconnect();
    }
  }, 120_000);
  afterAll(async () => { await close?.(); });

  test('a source_changed failure carries the engine and fresh-client views; other outcomes pass through', async () => {
    await engine.executeRaw("INSERT INTO sources(id,name,archived,archived_at) VALUES('diag-archived','diag-archived',true,now())");
    const original = opError('source_changed', 'The atom source is unavailable.', 'Source diag-archived is missing or archived.');
    const caught = await withSourceRowDiagnostics(engine, 'diag-archived', async () => { throw original; }).then(() => null, (e: Error) => e);
    expect(caught).toBe(original);
    expect(caught!.message).toStartWith('The atom source is unavailable.');
    expect(caught!.message).toContain('[source-row diagnostics]');
    expect(caught!.message).toMatch(/engine row: \[\{"row":\{[^\n]*"id":"diag-archived"[^\n]*"archived":true/);
    expect(caught!.message).toContain('all sources: ');
    if (backend === 'postgres') {
      for (const label of ['engine session: ', 'fresh client row: ', 'fresh client session: ', 'pg_stat_activity: ']) expect(caught!.message).toContain(label);
      expect(caught!.message).toMatch(/fresh client row: \[\{"row":\{[^\n]*"archived":true/);
    }
    expect(caught!.message).not.toContain('query failed');
    const other = new Error('unrelated');
    expect(await withSourceRowDiagnostics(engine, 'diag-archived', async () => { throw other; }).then(() => null, (e: Error) => e)).toBe(other);
    expect(other.message).toBe('unrelated');
    expect(await withSourceRowDiagnostics(engine, 'diag-archived', async () => 7)).toBe(7);
  }, 120_000);
});
