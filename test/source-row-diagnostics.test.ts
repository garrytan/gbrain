/**
 * The source-row diagnostic (test/helpers/source-row-diagnostics.ts) that #6427 and the
 * managed-atoms connector case attach to a `source_changed` failure.
 * Protects: the original error is rethrown with what the engine and a fresh client saw;
 * other errors and successes pass through untouched.
 * Seams: none; PGLite always, Postgres when DATABASE_URL is set.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { opError } from '../src/core/ops/contract.ts';
import { withSourceRowDiagnostics } from './helpers/source-row-diagnostics.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const closers: Array<() => Promise<void>> = [];
afterAll(async () => { for (const close of closers.splice(0)) await close(); });

async function open(backend: 'pglite' | 'postgres'): Promise<BrainEngine> {
  if (backend === 'postgres') {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    closers.push(pg.close);
    return pg.engine;
  }
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  closers.push(() => engine.disconnect());
  return engine;
}

for (const backend of testBackends()) describe(`${backend}: withSourceRowDiagnostics`, () => {
  test('a source_changed failure carries the engine and fresh-client views; other outcomes pass through', async () => {
    const engine = await open(backend);
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
