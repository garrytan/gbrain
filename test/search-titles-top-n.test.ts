/**
 * Title arm: rank and limit pages BEFORE attaching the representative chunk.
 *
 * searchTitles returns at most `limit` page-grain rows, each decorated with a
 * representative chunk (LEFT JOIN LATERAL) and, on PGLite, a stale probe
 * over timeline_entries. Both decorations must run per OUTPUT row, not per
 * title-matched page: on a broad title match the per-page form did hundreds
 * of chunk lookups to serve a handful of rows.
 *
 * Pins (real PGLite):
 *   - the executed statement's content_chunks / timeline_entries probes loop
 *     at most `limit` times (EXPLAIN ANALYZE on the captured statement)
 *   - rows, order, representative chunk, offset paging and the stale flag
 *     are unchanged
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';

let engine: PGLiteEngine;
const PAGES = 30;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (let i = 0; i < PAGES; i++) {
    const slug = `notes/zephyr-${String(i).padStart(2, '0')}`;
    // Title term frequency varies so ranks differ; ties break on page id.
    const title = i % 3 === 0 ? `Zephyr zephyr report ${i}` : `Zephyr report ${i}`;
    await engine.putPage(slug, { type: 'note', title, compiled_truth: `body ${i}`, timeline: '' });
    await installFixtureChunks(engine, slug, [
      { chunk_index: 0, chunk_text: `timeline line ${i}`, chunk_source: 'timeline', token_count: 3 },
      { chunk_index: 1, chunk_text: `compiled body ${i}`, chunk_source: 'compiled_truth', token_count: 3 },
    ]);
  }
  await engine.executeRaw(
    `INSERT INTO timeline_entries (page_id, date, summary, created_at)
     SELECT id, '2026-01-01', 'later event', now() + interval '1 day' FROM pages WHERE slug = 'notes/zephyr-00'`,
  );
}, 120_000);

afterAll(async () => { await engine.disconnect(); }, 30_000);

function maxLoops(plan: Record<string, unknown>, relation: string): number {
  let max = 0;
  const walk = (node: Record<string, unknown>) => {
    if (node['Relation Name'] === relation) max = Math.max(max, Number(node['Actual Loops'] ?? 0));
    for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) walk(child);
  };
  walk(plan);
  return max;
}

describe('searchTitles decorates only the returned page rows', () => {
  test('chunk and timeline probes run at most `limit` times', async () => {
    const db = (engine as unknown as { db: { query: (sql: string, params?: unknown[]) => Promise<unknown> } }).db;
    const original = db.query.bind(db);
    let captured: { sql: string; params: unknown[] } | undefined;
    db.query = async (sql: string, params?: unknown[]) => {
      if (!captured && /websearch_to_tsquery/.test(sql)) captured = { sql, params: params ?? [] };
      return original(sql, params);
    };
    try {
      const rows = await engine.searchTitles('zephyr', { limit: 5 });
      expect(rows).toHaveLength(5);
    } finally {
      db.query = original;
    }
    expect(captured).toBeDefined();
    const explained = await original(`EXPLAIN (ANALYZE, FORMAT JSON) ${captured!.sql}`, captured!.params) as {
      rows: Array<Record<string, unknown>>;
    };
    const plan = (explained.rows[0]!['QUERY PLAN'] as Array<{ Plan: Record<string, unknown> }>)[0]!.Plan;
    expect(maxLoops(plan, 'content_chunks')).toBeLessThanOrEqual(5);
    expect(maxLoops(plan, 'timeline_entries')).toBeLessThanOrEqual(5);
  });

  test('rows, order, representative chunk, paging and stale are preserved', async () => {
    const all = await engine.searchTitles('zephyr', { limit: 50 });
    expect(all).toHaveLength(PAGES);
    for (let i = 1; i < all.length; i++) {
      const a = all[i - 1]!, b = all[i]!;
      expect(a.score > b.score || (a.score === b.score && a.page_id < b.page_id)).toBe(true);
    }
    for (const r of all) {
      expect(r.chunk_source).toBe('compiled_truth');
      expect(r.chunk_text).toBe(`compiled body ${Number(r.slug.slice(-2))}`);
      expect(r.stale).toBe(r.slug === 'notes/zephyr-00');
    }
    const page2 = await engine.searchTitles('zephyr', { limit: 5, offset: 5 });
    expect(page2.map(r => r.slug)).toEqual(all.slice(5, 10).map(r => r.slug));
  });
});
