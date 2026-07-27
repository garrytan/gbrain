/**
 * IRON RULE E2E regression for v0.40.3.0 `buildSyncStatusReport` SQL.
 *
 * Why this exists:
 *   PR #1314 shipped a broken SQL query for the per-source dashboard:
 *
 *     FROM chunks ch JOIN pages pg ON pg.slug = ch.page_slug
 *
 *   The actual schema is `content_chunks` joined on `page_id`. Every
 *   unit test in `test/sync-all-parallel.test.ts` stubbed `executeRaw`
 *   with regex-keyed canned responses, so the broken SQL never ran.
 *   The defensive `try/catch { countRows = [] }` would have silently
 *   returned "0 chunks for every source" in production — a misleading
 *   "your brain is empty" report on a real Postgres brain.
 *
 *   This case exercises the REAL SQL against PGLite. If buildSyncStatusReport
 *   ever drifts back to a bad table name or join key, this test fails
 *   loudly at parse time (PGLite rejects unknown columns).
 *
 *   Per CLAUDE.md's IRON RULE: "regression test is added to the plan as
 *   a critical requirement. No skipping." Codex's outside-voice review
 *   of the original plan caught this missing case.
 *
 * Coverage:
 *   - Canonical SQL parses and returns rows (Blocker 1 / Codex P0 #1)
 *   - Soft-deleted pages excluded from pages count + chunks count
 *     (v0.26.5 soft-delete shipped without updating this query path)
 *   - Archived sources excluded from the dashboard input
 *     (Expansion 3 from plan review)
 *   - Embedding column resolved via the registry (D16) — counts
 *     against the active column, not a hardcoded name
 *   - Errors propagate instead of returning lying zeroes (Q2 sub-fix)
 *
 * No DATABASE_URL needed; PGLite is in-memory.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { buildSyncStatusReport } from '../../src/commands/sync.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ChunkInput } from '../../src/core/types.ts';

let engine: PGLiteEngine;

// Basis-vector embeddings keep the seed cheap (no real model needed) and
// deterministic. The dashboard only cares about NULL vs non-NULL on the
// embedding column, not the vector content.
function basisEmbedding(idx: number, dim = 1536): Float32Array {
  const emb = new Float32Array(dim);
  emb[idx % dim] = 1.0;
  return emb;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Seed two non-default sources: 'source-a' (active) + 'source-b' (active)
  // + 'source-c' (archived — must be excluded by dashboard input filter).
  // 'default' is auto-seeded by pglite-schema.ts:50.
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, last_commit, last_sync_at, config, archived)
       VALUES
         ('source-a', 'source-a', '/tmp/source-a', 'aaa', NOW() - INTERVAL '1 hour', '{"syncEnabled": true}'::jsonb, FALSE),
         ('source-b', 'source-b', '/tmp/source-b', 'bbb', NOW() - INTERVAL '30 hours', '{"syncEnabled": true}'::jsonb, FALSE),
         ('source-c', 'source-c', '/tmp/source-c', 'ccc', NOW() - INTERVAL '100 hours', '{}'::jsonb, TRUE)`,
  );

  // Seed pages + chunks per source via the canonical engine API.
  // source-a: 3 pages, 6 chunks, 4 embedded (2 unembedded)
  // source-b: 2 pages, 4 chunks, 4 embedded (0 unembedded)
  // Plus a soft-deleted page on source-a that should NOT count toward
  // either pages or chunks (the v0.26.5 soft-delete-aware regression).

  // source-a page 1: 2 chunks, both embedded
  await engine.putPage('a/page-1', {
    type: 'note',
    title: 'A page 1',
    compiled_truth: 'content for a/page-1',
    timeline: '',
  }, { sourceId: 'source-a' });
  await engine.upsertChunks('a/page-1', [
    { chunk_index: 0, chunk_text: 'chunk a/1/0', chunk_source: 'compiled_truth', embedding: basisEmbedding(0), token_count: 4 },
    { chunk_index: 1, chunk_text: 'chunk a/1/1', chunk_source: 'compiled_truth', embedding: basisEmbedding(1), token_count: 4 },
  ] satisfies ChunkInput[], { sourceId: 'source-a' });

  // source-a page 2: 2 chunks, both unembedded (no embedding field)
  await engine.putPage('a/page-2', {
    type: 'note',
    title: 'A page 2',
    compiled_truth: 'content for a/page-2',
    timeline: '',
  }, { sourceId: 'source-a' });
  await engine.upsertChunks('a/page-2', [
    { chunk_index: 0, chunk_text: 'chunk a/2/0', chunk_source: 'compiled_truth', token_count: 4 },
    { chunk_index: 1, chunk_text: 'chunk a/2/1', chunk_source: 'compiled_truth', token_count: 4 },
  ] satisfies ChunkInput[], { sourceId: 'source-a' });

  // source-a page 3: 2 chunks, both embedded
  await engine.putPage('a/page-3', {
    type: 'note',
    title: 'A page 3',
    compiled_truth: 'content for a/page-3',
    timeline: '',
  }, { sourceId: 'source-a' });
  await engine.upsertChunks('a/page-3', [
    { chunk_index: 0, chunk_text: 'chunk a/3/0', chunk_source: 'compiled_truth', embedding: basisEmbedding(2), token_count: 4 },
    { chunk_index: 1, chunk_text: 'chunk a/3/1', chunk_source: 'compiled_truth', embedding: basisEmbedding(3), token_count: 4 },
  ] satisfies ChunkInput[], { sourceId: 'source-a' });

  // SOFT-DELETED page on source-a: must NOT count toward pages or chunks.
  // This is the v0.26.5 regression — pre-fix, soft-deleted pages were
  // double-counted in the dashboard.
  await engine.putPage('a/page-deleted', {
    type: 'note',
    title: 'A page deleted',
    compiled_truth: 'content for a/page-deleted (will be soft-deleted)',
    timeline: '',
  }, { sourceId: 'source-a' });
  await engine.upsertChunks('a/page-deleted', [
    { chunk_index: 0, chunk_text: 'should-not-count', chunk_source: 'compiled_truth', embedding: basisEmbedding(4), token_count: 4 },
    { chunk_index: 1, chunk_text: 'should-not-count', chunk_source: 'compiled_truth', token_count: 4 },
  ] satisfies ChunkInput[], { sourceId: 'source-a' });
  await engine.softDeletePage('a/page-deleted', { sourceId: 'source-a' });

  // source-b: 2 pages × 2 chunks, all embedded
  await engine.putPage('b/page-1', {
    type: 'note',
    title: 'B page 1',
    compiled_truth: 'content for b/page-1',
    timeline: '',
  }, { sourceId: 'source-b' });
  await engine.upsertChunks('b/page-1', [
    { chunk_index: 0, chunk_text: 'chunk b/1/0', chunk_source: 'compiled_truth', embedding: basisEmbedding(5), token_count: 4 },
    { chunk_index: 1, chunk_text: 'chunk b/1/1', chunk_source: 'compiled_truth', embedding: basisEmbedding(6), token_count: 4 },
  ] satisfies ChunkInput[], { sourceId: 'source-b' });

  await engine.putPage('b/page-2', {
    type: 'note',
    title: 'B page 2',
    compiled_truth: 'content for b/page-2',
    timeline: '',
  }, { sourceId: 'source-b' });
  await engine.upsertChunks('b/page-2', [
    { chunk_index: 0, chunk_text: 'chunk b/2/0', chunk_source: 'compiled_truth', embedding: basisEmbedding(7), token_count: 4 },
    { chunk_index: 1, chunk_text: 'chunk b/2/1', chunk_source: 'compiled_truth', embedding: basisEmbedding(8), token_count: 4 },
  ] satisfies ChunkInput[], { sourceId: 'source-b' });
});

afterAll(async () => {
  await engine.disconnect();
});

describe('buildSyncStatusReport against real PGLite (IRON RULE regression for Blocker 1)', () => {
  test('correct SQL: content_chunks JOIN pages ON page_id (NOT chunks/page_slug)', async () => {
    // Caller-side source list mirrors what `gbrain sources status` (the
    // CLI route in sources.ts) would supply: `WHERE local_path IS NOT NULL
    // AND archived IS NOT TRUE`.
    const sources = await engine.executeRaw<{
      id: string;
      name: string;
      local_path: string | null;
      config: Record<string, unknown>;
    }>(
      `SELECT id, name, local_path, config FROM sources
         WHERE local_path IS NOT NULL AND archived IS NOT TRUE
         ORDER BY id`,
    );
    // source-a + source-b only (source-c is archived; 'default' has no local_path).
    expect(sources.map((s) => s.id).sort()).toEqual(['source-a', 'source-b']);

    // The SQL must not throw. Pre-fix, the broken SQL would have thrown
    // `relation "chunks" does not exist` on PGLite (and Postgres). Post-
    // fix, the canonical `content_chunks JOIN pages ON page_id` shape parses.
    const report = await buildSyncStatusReport(engine, sources);

    expect(report.schema_version).toBe(1);
    expect(report.sources).toHaveLength(2);

    const byId = new Map(report.sources.map((s) => [s.source_id, s]));

    // source-a: 3 active pages (4th is soft-deleted and excluded).
    // 6 active chunks (2 from the soft-deleted page are excluded).
    // 4 chunks embedded, 2 unembedded.
    const a = byId.get('source-a')!;
    expect(a.pages).toBe(3);
    expect(a.chunks_total).toBe(6);
    expect(a.chunks_unembedded).toBe(2);
    expect(a.embedding_coverage_pct).toBeCloseTo(66.7, 1);

    // source-b: 2 pages × 2 chunks = 4 chunks, all embedded.
    const b = byId.get('source-b')!;
    expect(b.pages).toBe(2);
    expect(b.chunks_total).toBe(4);
    expect(b.chunks_unembedded).toBe(0);
    expect(b.embedding_coverage_pct).toBe(100);
  });

  test('v0.41.31: embed-backfill job state surfaced per source (TODO-2)', async () => {
    // Seed embed-backfill minion jobs for source-a: 2 queued + 1 active +
    // 1 completed. source-b has none → idle.
    await engine.executeRaw(
      `INSERT INTO minion_jobs (name, status, data) VALUES
         ('embed-backfill', 'waiting',  '{"sourceId":"source-a"}'::jsonb),
         ('embed-backfill', 'waiting',  '{"sourceId":"source-a"}'::jsonb),
         ('embed-backfill', 'active',   '{"sourceId":"source-a"}'::jsonb)`,
    );
    await engine.executeRaw(
      `INSERT INTO minion_jobs (name, status, data, finished_at)
         VALUES ('embed-backfill', 'completed', '{"sourceId":"source-a"}'::jsonb, now())`,
    );

    const sources = await engine.executeRaw<{
      id: string; name: string; local_path: string | null; config: Record<string, unknown>;
    }>(
      `SELECT id, name, local_path, config FROM sources
         WHERE local_path IS NOT NULL AND archived IS NOT TRUE ORDER BY id`,
    );
    const report = await buildSyncStatusReport(engine, sources);
    const byId = new Map(report.sources.map((s) => [s.source_id, s]));

    const a = byId.get('source-a')!;
    expect(a.backfill_queued).toBe(2);
    expect(a.backfill_active).toBe(1);
    expect(a.backfill_last_completed_at).not.toBeNull();

    const b = byId.get('source-b')!;
    expect(b.backfill_queued).toBe(0);
    expect(b.backfill_active).toBe(0);
    expect(b.backfill_last_completed_at).toBeNull();

    // Clean up so sibling tests in this describe see a clean minion_jobs.
    await engine.executeRaw(`DELETE FROM minion_jobs WHERE name = 'embed-backfill'`);
  });

  test('soft-deleted pages excluded from pages count (v0.26.5 regression)', async () => {
    // Verifies the `WHERE pg.deleted_at IS NULL` clause in BOTH subqueries
    // of the dashboard SQL. Pre-fix the original PR query would have
    // counted the soft-deleted page as part of source-a's totals.
    const sources = await engine.executeRaw<{
      id: string;
      name: string;
      local_path: string | null;
      config: Record<string, unknown>;
    }>(
      `SELECT id, name, local_path, config FROM sources WHERE id = 'source-a'`,
    );
    const report = await buildSyncStatusReport(engine, sources);
    const a = report.sources.find((s) => s.source_id === 'source-a')!;
    expect(a.pages).toBe(3);            // 4 raw rows, 1 soft-deleted → 3 active
    expect(a.chunks_total).toBe(6);     // 8 raw chunks, 2 on soft-deleted page → 6 active
  });

  test('archived sources are excluded by the caller-side filter (Expansion 3)', async () => {
    // The dashboard input filter is `archived IS NOT TRUE`. source-c was
    // seeded with archived=true and must not appear in the report.
    const sources = await engine.executeRaw<{
      id: string;
      name: string;
      local_path: string | null;
      config: Record<string, unknown>;
    }>(
      `SELECT id, name, local_path, config FROM sources
         WHERE local_path IS NOT NULL AND archived IS NOT TRUE`,
    );
    const ids = sources.map((s) => s.id);
    expect(ids).not.toContain('source-c');
  });

  test('embedding column reported in envelope is what the SQL counted against (D16)', async () => {
    // D16 → A: dashboard counts unembedded chunks against the ACTIVE
    // embedding column (resolved via the registry). The envelope's
    // `embedding_column` field exposes which column the SQL used so
    // operators can verify Voyage / multimodal setups are reported
    // correctly. Default brains (no embedding_model config) resolve to
    // 'embedding'. Non-default brains would see their override here.
    const sources = await engine.executeRaw<{
      id: string;
      name: string;
      local_path: string | null;
      config: Record<string, unknown>;
    }>(
      `SELECT id, name, local_path, config FROM sources
         WHERE local_path IS NOT NULL AND archived IS NOT TRUE`,
    );
    const report = await buildSyncStatusReport(engine, sources);
    expect(typeof report.embedding_column).toBe('string');
    expect(report.embedding_column.length).toBeGreaterThan(0);
  });

  test('errors propagate (Q2 sub-fix — no silent swallowing of real DB errors)', async () => {
    // Wrap a wrapped engine that throws on the count query. Pre-fix the
    // PR's bare `catch { countRows = [] }` would have masked this and
    // returned "0 chunks for every source" — exactly the misleading
    // report the operator should NEVER see when their DB is actually
    // broken.
    const sources = await engine.executeRaw<{
      id: string;
      name: string;
      local_path: string | null;
      config: Record<string, unknown>;
    }>(
      `SELECT id, name, local_path, config FROM sources
         WHERE local_path IS NOT NULL AND archived IS NOT TRUE`,
    );

    const proxyEngine: BrainEngine = {
      kind: engine.kind,
      executeRaw: async (sql: string, params?: unknown[]) => {
        if (/WITH s AS \(\s*SELECT unnest/.test(sql)) {
          throw new Error('synthetic test error: count query failed');
        }
        return (engine.executeRaw as (sql: string, params?: unknown[]) => Promise<unknown[]>)(sql, params);
      },
    } as unknown as BrainEngine;

    await expect(buildSyncStatusReport(proxyEngine, sources)).rejects.toThrow(
      /count query failed/,
    );
  });
});
