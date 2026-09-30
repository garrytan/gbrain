/**
 * Engine-sql dialect capabilities, each gated by a boundary-size and a
 * concurrent-write test (refactor wave 1, Engineering contracts "Dialect
 * capabilities"; docs/designs/refactor-wave-1/w1-inventory.md):
 *
 *   maxBindParamsPerStatement  PGLite splits code-edge inserts below 30,000
 *                              binds; Postgres keeps one statement.
 *   transactionAdvisoryLocks   Postgres serializes same-entity fact inserts
 *                              with pg_advisory_xact_lock; PGLite never locks.
 *   probesEmbeddingCast        Postgres casts fact vectors to the live column
 *                              type (vector | halfvec); PGLite always casts
 *                              ::vector (assignment-cast to its halfvec column).
 *
 * Registered by test/engine-sql-capabilities.test.ts (PGLite) and
 * test/e2e/engine-sql-capabilities-parity.test.ts (direct Postgres, PgBouncer).
 */
import { expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SqlExecutor } from '../../src/core/engine-sql/executor.ts';
import { addCodeEdges } from '../../src/core/engine-sql/code-edges.ts';
import { installFixtureChunks } from './page-projection.ts';

type Family = 'pglite' | 'postgres';

const engineSql = (engine: BrainEngine) => (engine as unknown as { engineSql: SqlExecutor }).engineSql;

/** The engine's executor with `unsafe` calls counted (the code-edge insert path). */
function countingExecutor(engine: BrainEngine): { exec: SqlExecutor; statements: () => number } {
  const inner = engineSql(engine);
  let n = 0;
  return {
    exec: { ...inner, unsafe: (sql, params) => { n++; return inner.unsafe(sql, params); } },
    statements: () => n,
  };
}

async function codeChunk(engine: BrainEngine, slug: string): Promise<number> {
  await engine.putPage(slug, { type: 'code', page_kind: 'code', title: slug, compiled_truth: 'export const x = 1;', timeline: '' });
  await installFixtureChunks(engine, slug, [{
    chunk_index: 0, chunk_text: 'export const x = 1;', chunk_source: 'compiled_truth',
    language: 'typescript', symbol_name: 'x', symbol_type: 'const', symbol_name_qualified: 'x',
  }]);
  return (await engine.getChunks(slug))[0]!.id;
}

const unresolved = (from: number, prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    from_chunk_id: from, to_chunk_id: null, from_symbol_qualified: 'x',
    to_symbol_qualified: `${prefix}-${i}`, edge_type: 'calls',
  }));

export function defineCapabilityCases(opts: { family: Family; getEngine: () => BrainEngine }): void {
  const { family } = opts;

  test(`capabilities are the ${family} values`, () => {
    expect(engineSql(opts.getEngine()).capabilities).toEqual(family === 'pglite'
      ? { maxBindParamsPerStatement: 30_000, transactionAdvisoryLocks: false, probesEmbeddingCast: false }
      : { maxBindParamsPerStatement: Number.POSITIVE_INFINITY, transactionAdvisoryLocks: true, probesEmbeddingCast: true });
  });

  test('bind batching: the per-statement boundary (6 binds per unresolved edge)', async () => {
    const engine = opts.getEngine();
    const chunk = await codeChunk(engine, `code/capability-batch-${family}`);
    const perStatement = Math.floor(30_000 / 6);
    const atLimit = countingExecutor(engine);
    expect(await addCodeEdges(atLimit.exec, unresolved(chunk, 'at-limit', perStatement))).toBe(perStatement);
    expect(atLimit.statements()).toBe(1);
    const overLimit = countingExecutor(engine);
    expect(await addCodeEdges(overLimit.exec, unresolved(chunk, 'over-limit', perStatement + 1))).toBe(perStatement + 1);
    expect(overLimit.statements()).toBe(family === 'pglite' ? 2 : 1);
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM code_edges_symbol WHERE from_chunk_id = $1`, [chunk]);
    expect(rows[0].n).toBe(2 * perStatement + 1);
  }, 60_000);

  test('bind batching: concurrent overlapping writers insert each edge exactly once', async () => {
    const engine = opts.getEngine();
    const chunk = await codeChunk(engine, `code/capability-concurrent-${family}`);
    const edges = unresolved(chunk, 'shared', Math.floor(30_000 / 6) + 10);
    const counts = await Promise.all([engine.addCodeEdges(edges), engine.addCodeEdges(edges), engine.addCodeEdges(edges)]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(edges.length);
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM code_edges_symbol WHERE from_chunk_id = $1`, [chunk]);
    expect(rows[0].n).toBe(edges.length);
  }, 60_000);

  test('advisory locks: concurrent same-entity fact inserts all land (and no-entity inserts skip the lock)', async () => {
    const engine = opts.getEngine();
    const entity = `people/capability-lock-${family}`;
    const writes = Array.from({ length: 8 }, (_, i) =>
      engine.insertFact({ fact: `concurrent fact ${i}`, source: 'test:capability', entity_slug: entity }, { source_id: 'default' }));
    const results = await Promise.all(writes);
    expect(results.map((r) => r.status)).toEqual(Array(8).fill('inserted'));
    expect(new Set(results.map((r) => r.id)).size).toBe(8);
    const noEntity = await engine.insertFact({ fact: 'entity-less fact', source: 'test:capability' }, { source_id: 'default' });
    expect(noEntity.status).toBe('inserted');
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM facts WHERE entity_slug = $1 AND expired_at IS NULL`, [entity]);
    expect(rows[0].n).toBe(8);
  }, 60_000);

  test('advisory locks: concurrent supersedes of one fact keep exactly one active successor chain', async () => {
    const engine = opts.getEngine();
    const entity = `people/capability-supersede-${family}`;
    const base = await engine.insertFact({ fact: 'base fact', source: 'test:capability', entity_slug: entity }, { source_id: 'default' });
    const results = await Promise.all([1, 2, 3].map((i) =>
      engine.insertFact({ fact: `successor ${i}`, source: 'test:capability', entity_slug: entity }, { source_id: 'default', supersedeId: base.id })));
    expect(results.map((r) => r.status)).toEqual(['superseded', 'superseded', 'superseded']);
    const expired = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM facts WHERE id = $1 AND expired_at IS NOT NULL`, [base.id]);
    expect(expired[0].n).toBe(1);
  }, 60_000);

  test('embedding cast: vectors at the column dimension round-trip, including concurrent writers', async () => {
    const engine = opts.getEngine();
    const dims = await engine.executeRaw<{ t: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS t FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relname = 'facts' AND a.attname = 'embedding' AND NOT a.attisdropped`);
    const type = dims[0].t;
    const n = Number(/\((\d+)\)/.exec(type)![1]);
    expect(type).toMatch(/^(vector|halfvec)\(/);
    const entity = `people/capability-cast-${family}`;
    const embedding = (seed: number) => Float32Array.from({ length: n }, (_, i) => ((i + seed) % 7) / 8);
    const inserted = await Promise.all([1, 2, 3].map((seed) => engine.insertFact(
      { fact: `embedded fact ${seed}`, source: 'test:capability', entity_slug: entity, embedding: embedding(seed), embedding_model: 'test:model' },
      { source_id: 'default' })));
    const facts = await engine.listFactsByEntity('default', entity, { limit: 10 });
    for (const [k, seed] of [1, 2, 3].entries()) {
      const row = facts.find((f) => f.id === inserted[k].id)!;
      expect(row.embedding?.length).toBe(n);
      expect(Array.from(row.embedding!)).toEqual(Array.from(embedding(seed)));
    }
  }, 60_000);
}
