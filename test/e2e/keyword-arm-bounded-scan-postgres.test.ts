/**
 * The bounded keyword arm stops reading at its bound (#7082). searchKeyword
 * ranks at most KEYWORD_RANK_CANDIDATES matching chunks, so a term that
 * matches more must not read every match first. For a remote caller the
 * private-visibility subplans priced the page join so high that the planner
 * hashed the whole full-text match before the bound applied, and a term in
 * most chunks of a large brain timed out; the hybrid search then answered
 * from vectors alone and skipped the keyword arm for 10 minutes. With no
 * page filter the candidates now stream from the chunk match, each probing
 * its page, and the scan ends at the bound.
 *
 * The fixture holds 1.6x the bound in matching chunks. The proof reads the
 * executed plan: rows read from content_chunks by the match, summed over
 * every scan node and loop, minus the ranked rows read for display.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { KEYWORD_RANK_CANDIDATES } from '../../src/core/search/keyword-chunk-match.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase } from '../helpers/test-backends.ts';

const PAGES = 10_000;
const CHUNKS_PER_PAGE = 8;
const LIMIT = 10;

describe('bounded keyword arm (postgres)', () => {
  let engine: PostgresEngine;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ engine, close } = await isolatedPersistencePostgres(requirePostgresTestDatabase()));
    await engine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, knowledge_revision, text_projection_revision, chunker_version)
      SELECT 'bulk/p-' || i, 'default', 'note', 'p' || i, 'x', '00000000-0000-4000-8000-000000000001'::uuid,
        '00000000-0000-4000-8000-000000000001'::uuid, 4 FROM generate_series(1, ${PAGES}) i`);
    await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source)
      SELECT p.id, c, 'tenvarol planning review ' || p.id || '-' || c, 'compiled_truth' FROM pages p CROSS JOIN generate_series(0, ${CHUNKS_PER_PAGE - 1}) c
      WHERE p.slug LIKE 'bulk/p-%'`);
    await engine.executeRaw('ANALYZE pages');
    await engine.executeRaw('ANALYZE content_chunks');
  }, 600_000);

  afterAll(async () => { await close?.(); });

  async function capturedKeywordStatement(): Promise<{ sql: string; params: unknown[]; rows: number; incomplete: boolean }> {
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
    let incomplete = false;
    try {
      const rows = await engine.searchKeyword('tenvarol', { limit: LIMIT, excludePrivate: true, onKeywordIncomplete: () => { incomplete = true; } });
      return { ...captured!, rows: rows.length, incomplete };
    } finally {
      target.withScopedReadTransaction = original;
    }
  }

  type Node = { 'Node Type': string; 'Relation Name'?: string; 'Actual Rows'?: number; 'Actual Loops'?: number; Plans?: Node[] };
  const nodes = (node: Node): Node[] => [node, ...(node.Plans ?? []).flatMap(nodes)];

  test("a remote caller's keyword arm reads at most the bound of matching chunks", async () => {
    const { sql, params, rows, incomplete } = await capturedKeywordStatement();
    expect(rows).toBe(LIMIT);
    expect(incomplete).toBe(true);
    const [row] = await engine.transaction(async (tx) => {
      await tx.executeRaw(`SET LOCAL work_mem = '32MB'`);
      await tx.executeRaw(`SET LOCAL enable_seqscan = off`);
      return tx.executeRaw<{ 'QUERY PLAN': Array<{ Plan: Node }> }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params);
    });
    const read = nodes(row!['QUERY PLAN'][0]!.Plan)
      .filter(node => node['Relation Name'] === 'content_chunks')
      .reduce((sum, node) => sum + (node['Actual Rows'] ?? 0) * (node['Actual Loops'] ?? 1), 0);
    expect(PAGES * CHUNKS_PER_PAGE).toBeGreaterThan(KEYWORD_RANK_CANDIDATES * 1.5);
    expect(read - LIMIT * 3).toBeLessThanOrEqual(KEYWORD_RANK_CANDIDATES * 1.05);
  }, 120_000);
});
