/**
 * Keyword arm on PostgreSQL: the dual-backend ranking pin in
 * test/search/keyword-arm-ranking.test.ts, plus a proof that the statement
 * searchKeyword runs for excludePrivate callers keeps its full-text match in
 * an OFFSET 0 subquery, which the planner plans on its own. Joined with pages,
 * the private-visibility subplans inflate every candidate plan's cost until a
 * cheaper bitmap scan falls within the planner's 1% fuzz of a seq scan and
 * loses on startup cost; that seq scan detoasts every chunk's search_vector.
 * Without excludePrivate the statement stays unfenced, so its join can still
 * run in parallel. (The planner drops the trivial Subquery Scan node from
 * EXPLAIN, so the proof reads the statement, then checks it plans and returns
 * rows.)
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { registerPostgresTests, requirePostgresTestDatabase } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../search/keyword-arm-ranking.test.ts'));

describe('keyword arm plan (postgres)', () => {
  let engine: PostgresEngine;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ engine, close } = await isolatedPersistencePostgres(requirePostgresTestDatabase()));
    for (let i = 1; i <= 30; i++) {
      const slug = `notes/page-${i}`;
      const body = i % 3 === 0 ? `Acme planning review ${i}.` : `Globex weekly sync ${i}.`;
      await engine.putPage(slug, { type: 'note', title: `Page ${i}`, compiled_truth: body });
      await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' }]);
    }
    await engine.executeRaw('ANALYZE pages');
    await engine.executeRaw('ANALYZE content_chunks');
  }, 120_000);

  afterAll(async () => { await close?.(); });

  async function capturedKeywordStatement(query: string, excludePrivate: boolean): Promise<{ sql: string; params: unknown[]; rows: number }> {
    const target = engine as unknown as Record<string, any>;
    const original = target.withScopedReadTransaction;
    let captured: { sql: string; params: unknown[] } | undefined;
    target.withScopedReadTransaction = function (ids: unknown, id: unknown, callback: (tx: any) => unknown, opts: unknown) {
      return original.call(this, ids, id, (tx: any) => callback(new Proxy(tx, {
        get(t, prop, receiver) {
          if (prop !== 'unsafe') return Reflect.get(t, prop, receiver);
          return (sql: string, params: unknown[]) => {
            if (sql.includes('WITH ranked_chunks AS')) captured = { sql, params };
            return t.unsafe(sql, params);
          };
        },
      })), opts);
    };
    try {
      const rows = await engine.searchKeyword(query, { limit: 10, excludePrivate });
      return { ...captured!, rows: rows.length };
    } finally {
      target.withScopedReadTransaction = original;
    }
  }

  for (const query of ['acme', 'globex weekly', 'acme or globex']) {
    test(`\`${query}\` with excludePrivate runs the full-text match inside the OFFSET 0 subquery`, async () => {
      const { sql, params, rows } = await capturedKeywordStatement(query, true);
      expect(rows).toBeGreaterThan(0);
      expect(sql).toMatch(/FROM \(\s*SELECT id, page_id, chunk_index, chunk_text, chunk_source, search_vector, language, symbol_type\s+FROM content_chunks\s+WHERE search_vector @@ websearch_to_tsquery\('[a-z_]+', \$1\) AND modality = 'text'\s+OFFSET 0\s*\) cc\s+JOIN pages p/);
      expect(sql).not.toMatch(/cc\.search_vector @@/);
      const plan = (await engine.executeRaw<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params)).map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).toContain('content_chunks');
    });

    test(`\`${query}\` without excludePrivate keeps the unfenced join`, async () => {
      const { sql, rows } = await capturedKeywordStatement(query, false);
      expect(rows).toBeGreaterThan(0);
      expect(sql).toMatch(/FROM content_chunks cc\s+JOIN pages p/);
      expect(sql).toMatch(/WHERE cc\.search_vector @@ websearch_to_tsquery\('[a-z_]+', \$1\)/);
      expect(sql).toMatch(/AND cc\.modality = 'text'/);
      expect(sql).not.toContain('OFFSET 0');
    });
  }
});
