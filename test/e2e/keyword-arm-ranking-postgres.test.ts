/**
 * Keyword arm on PostgreSQL: the dual-backend ranking and access pins in
 * test/search/keyword-arm-ranking.test.ts and keyword-arm-access.test.ts, plus
 * proofs of the statement shapes searchKeyword runs. For excludePrivate callers
 * with no type, frontmatter or date filter and no source scope that leaves a
 * live source out, the candidates stream from the full-text match through an OFFSET 0 subquery,
 * each probing its page in a LATERAL subquery that runs every page filter,
 * so the KEYWORD_RANK_CANDIDATES bound ends the scan (#7082; the scan itself
 * is pinned in keyword-arm-bounded-scan-postgres.test.ts). Otherwise the
 * statement joins pages: for excludePrivate callers the full-text match
 * stays in an OFFSET 0 subquery, which the planner plans on its own, because
 * the private-visibility subplans inflate every join plan's cost until a
 * cheaper bitmap scan falls within the planner's 1% fuzz of a seq scan and
 * loses on startup cost; that seq scan detoasts every chunk's search_vector.
 * Without excludePrivate that join stays unfenced, so it can still run in
 * parallel. (The planner drops the trivial Subquery Scan node from EXPLAIN,
 * so the proofs read the statement, then check it plans and returns rows.)
 *
 * The per-page window carries ids and scores only; display columns are read
 * for the ranked rows (KEYWORD_RANKED_ROWS_CTE). Standard for identical
 * output: rows and order equal the wide statement's whenever the
 * KEYWORD_RANK_CANDIDATES bound does not apply. When it applies, the ranked
 * sample is the first matches in plan order, which on the wide statement
 * already depended on work_mem and row width (its hash join split into
 * batches); there the rows equal the wide statement's at a work_mem that
 * does not spill.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { registerPostgresTests, requirePostgresTestDatabase } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../search/keyword-arm-ranking.test.ts'), () => import('../search/keyword-arm-access.test.ts'));

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

  async function capturedKeywordStatement(query: string, opts: { excludePrivate: boolean; types?: string[]; sourceIds?: string[] }): Promise<{ sql: string; params: unknown[]; rows: number }> {
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
      const rows = await engine.searchKeyword(query, { limit: 10, ...opts });
      return { ...captured!, rows: rows.length };
    } finally {
      target.withScopedReadTransaction = original;
    }
  }

  const TYPED = ['note'];
  for (const query of ['acme', 'globex weekly', 'acme or globex']) {
    test(`\`${query}\` with excludePrivate and no page filter reads candidates from the chunk match and probes each one's page`, async () => {
      const chunkDriven = /FROM \(\s*SELECT cc\.id, cc\.page_id, cc\.search_vector, cc\.body_generation\s+FROM content_chunks cc\s+WHERE cc\.search_vector @@ websearch_to_tsquery\('[a-z_]+', \$1\) AND cc\.modality = 'text'[^)]*OFFSET 0\s*\) cc\s+CROSS JOIN LATERAL \(\s*SELECT p\.id, p\.slug, p\.frontmatter\s+FROM pages p JOIN sources s ON s\.id = p\.source_id\s+WHERE p\.id = cc\.page_id[\s\S]*?LIMIT 1\s*\) p/;
      const unscoped = await capturedKeywordStatement(query, { excludePrivate: true });
      expect(unscoped.rows).toBeGreaterThan(0);
      expect(unscoped.sql).toMatch(chunkDriven);
      expect(unscoped.sql).not.toMatch(/JOIN pages p ON p\.id = cc\.page_id/);
      const scoped = await capturedKeywordStatement(query, { excludePrivate: true, sourceIds: ['default'] });
      expect(scoped.rows).toBe(unscoped.rows);
      expect(scoped.sql).toMatch(chunkDriven);
      expect(scoped.sql).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM sources ls WHERE NOT ls\.archived AND \(ls\.id <> ALL\(\$\d+::text\[\]\)\) IS NOT FALSE\)\s+UNION ALL/);
      type Node = { 'Node Type': string; 'Actual Rows'?: number; Plans?: Node[] };
      const nodes = (node: Node): Node[] => [node, ...(node.Plans ?? []).flatMap(nodes)];
      const [analyzed] = await engine.executeRaw<{ 'QUERY PLAN': Array<{ Plan: Node }> }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${scoped.sql}`, scoped.params);
      const [arms] = nodes(analyzed!['QUERY PLAN'][0]!.Plan).filter(node => node['Node Type'] === 'Append');
      expect(arms!.Plans!.map(arm => arm['Actual Rows']! > 0)).toEqual([true, false]);
      for (const { sql, params } of [unscoped, scoped]) {
        const plan = (await engine.executeRaw<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params)).map((r) => r['QUERY PLAN']).join('\n');
        expect(plan).toContain('content_chunks');
      }
    });

    test(`\`${query}\` with a type filter and excludePrivate runs the full-text match inside the OFFSET 0 subquery`, async () => {
      const { sql, params, rows } = await capturedKeywordStatement(query, { excludePrivate: true, types: TYPED });
      expect(rows).toBeGreaterThan(0);
      expect(sql).toMatch(/FROM \(\s*SELECT id, page_id, chunk_index, chunk_text, chunk_source, search_vector, language, symbol_type, body_generation, occurrence_id\s+FROM content_chunks\s+WHERE search_vector @@ websearch_to_tsquery\('[a-z_]+', \$1\) AND modality = 'text'\s+OFFSET 0\s*\) cc\s+JOIN pages p/);
      expect(sql).not.toMatch(/cc\.search_vector @@/);
      const plan = (await engine.executeRaw<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params)).map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).toContain('content_chunks');
    });

    test(`\`${query}\`: the per-page window and the bounded-row count carry ids and scores only; display columns are read for the ranked rows`, async () => {
      for (const opts of [{ excludePrivate: true }, { excludePrivate: false }, { excludePrivate: true, types: TYPED }, { excludePrivate: false, types: TYPED }]) {
        const { sql, params, rows } = await capturedKeywordStatement(query, opts);
        expect(rows).toBeGreaterThan(0);
        type Node = { 'Node Type': string; Output?: string[]; Plans?: Node[] };
        const nodes = (node: Node): Node[] => [node, ...(node.Plans ?? []).flatMap(nodes)];
        const [row] = await engine.executeRaw<{ 'QUERY PLAN': Array<{ Plan: Node }> }>(`EXPLAIN (VERBOSE, FORMAT JSON) ${sql}`, params);
        const windows = nodes(row!['QUERY PLAN'][0]!.Plan).filter(node => node['Node Type'] === 'WindowAgg');
        expect(windows.length).toBeGreaterThan(0);
        const display = /^\w+\.(slug|title|type|source_id|effective_date|effective_date_source|message_id|thread_id|source_subject|chunk_index|chunk_text|chunk_source|frontmatter)$/;
        for (const window of windows) {
          expect([window, ...(window.Plans ?? [])].flatMap(node => node.Output ?? []).filter(column => display.test(column))).toEqual([]);
        }
      }
    });

    test(`\`${query}\` without excludePrivate keeps the unfenced join`, async () => {
      for (const types of [undefined, TYPED]) {
        const { sql, rows } = await capturedKeywordStatement(query, { excludePrivate: false, types });
        expect(rows).toBeGreaterThan(0);
        expect(sql).toMatch(/FROM content_chunks cc\s+JOIN pages p/);
        expect(sql).toMatch(/WHERE cc\.search_vector @@ websearch_to_tsquery\('[a-z_]+', \$1\)/);
        expect(sql).toMatch(/AND cc\.modality = 'text'/);
        expect(sql).not.toContain('OFFSET 0');
      }
    });
  }
});
