/**
 * Migration v265: `pages (source_id, created_at) WHERE deleted_at IS NULL`.
 *
 * `conversationTriedSql` (src/core/facts/conversation-memo.ts) re-arms an
 * unmemoized relink miss with
 * `EXISTS (SELECT 1 FROM pages np WHERE np.source_id = f.source_id
 *  AND np.deleted_at IS NULL AND np.created_at > a.attempted_at)`, run once per
 * attempt row. Without this index each probe is a sequential scan of pages.
 * Real PGLite.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

test('pages has a live-page (source_id, created_at) index', async () => {
  const rows = await engine.executeRaw<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE tablename='pages' AND indexname='pages_source_created_idx'`);
  expect(rows).toHaveLength(1);
  expect(rows[0].indexdef).toContain('(source_id, created_at)');
  expect(rows[0].indexdef).toContain('WHERE (deleted_at IS NULL)');
});

test('the relink re-arm probe is answerable from that index', async () => {
  // Forbid the sequential scan so the plan shows which index serves the probe;
  // pages_dedup_idx also leads with source_id, so give the planner statistics
  // and a probe that matches no rows (everything is older than now()).
  await engine.executeRaw(
    `INSERT INTO pages(source_id, slug, type, title, compiled_truth, created_at)
     SELECT 'default', 'idx-probe/' || g, 'note', 't' || g, 'x', now() - (g || ' minutes')::interval
       FROM generate_series(1, 500) g`);
  await engine.executeRaw('ANALYZE pages');
  await engine.executeRaw('SET enable_seqscan = off');
  try {
    const plan = await engine.executeRaw<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT 1 FROM pages np WHERE np.source_id = 'default' AND np.deleted_at IS NULL AND np.created_at > now()`);
    expect(plan.map(r => r['QUERY PLAN']).join('\n')).toContain('pages_source_created_idx');
  } finally {
    await engine.executeRaw('RESET enable_seqscan');
  }
});
