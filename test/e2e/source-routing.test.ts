/**
 * v0.34 W0a — multi-source isolation E2E.
 *
 * Pre-v0.34 (Codex finding #2): `query` op didn't pass ctx.sourceId to
 * hybridSearch; two-pass.ts:81 + :131 advertised TwoPassOpts.sourceId but
 * never applied it to the nearSymbol lookup or unresolved-edge resolution.
 * Multi-source brains silently cross-contaminated structural retrieval.
 *
 * This E2E pins the fix: seed two sources with the same symbol name in
 * different files; assert near_symbol + walk_depth retrieval with
 * sourceId='source-a' only returns chunks from source-a.
 *
 * PGLite in-memory — no DATABASE_URL needed, hermetic.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { expandAnchors } from '../../src/core/search/two-pass.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('v0.34 W0a — multi-source isolation in two-pass retrieval', () => {
  beforeAll(async () => {
    await resetPgliteState(engine);
    await seedTwoSourcesWithSharedSymbol(engine);
  });

  test('expandAnchors with nearSymbol + sourceId returns ONLY source-a chunks', async () => {
    const result = await expandAnchors(engine, [], {
      walkDepth: 0,
      nearSymbol: 'parseMarkdown',
      sourceId: 'source-a',
    });

    expect(result.length).toBeGreaterThan(0);

    // Hydrate chunk_ids to verify they all belong to source-a
    const chunkIds = result.map((r) => r.chunk_id);
    const rows = await engine.executeRaw<{ chunk_id: number; source_id: string }>(
      `SELECT cc.id AS chunk_id, p.source_id
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
         WHERE cc.id = ANY($1::int[])`,
      [chunkIds],
    );

    expect(rows.length).toBe(chunkIds.length);
    for (const r of rows) {
      expect(r.source_id).toBe('source-a');
    }
  });

  test('expandAnchors with nearSymbol + sourceId="source-b" returns ONLY source-b chunks', async () => {
    const result = await expandAnchors(engine, [], {
      walkDepth: 0,
      nearSymbol: 'parseMarkdown',
      sourceId: 'source-b',
    });

    expect(result.length).toBeGreaterThan(0);

    const chunkIds = result.map((r) => r.chunk_id);
    const rows = await engine.executeRaw<{ chunk_id: number; source_id: string }>(
      `SELECT cc.id AS chunk_id, p.source_id
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
         WHERE cc.id = ANY($1::int[])`,
      [chunkIds],
    );

    for (const r of rows) {
      expect(r.source_id).toBe('source-b');
    }
  });

  test('expandAnchors with nearSymbol and NO sourceId returns chunks from both sources (legacy cross-source mode preserved)', async () => {
    const result = await expandAnchors(engine, [], {
      walkDepth: 0,
      nearSymbol: 'parseMarkdown',
      // sourceId omitted — should cross sources (matches the documented contract)
    });

    expect(result.length).toBeGreaterThan(0);
    const chunkIds = result.map((r) => r.chunk_id);
    const rows = await engine.executeRaw<{ chunk_id: number; source_id: string }>(
      `SELECT cc.id AS chunk_id, p.source_id
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
         WHERE cc.id = ANY($1::int[])`,
      [chunkIds],
    );

    const sources = new Set(rows.map((r) => r.source_id));
    expect(sources.has('source-a')).toBe(true);
    expect(sources.has('source-b')).toBe(true);
  });

  test('unresolved-edge resolution within walkDepth respects sourceId', async () => {
    // Seed a caller → callee edge so walk_depth=1 must resolve via
    // symbol_name_qualified. We added one such edge in seedTwoSourcesWithSharedSymbol
    // pointing at parseMarkdown in source-a only.
    //
    // Start anchor = the caller chunk in source-a; expansion of depth 1 should
    // land on the source-a parseMarkdown definition, NOT the source-b one.
    const callerChunk = await engine.executeRaw<{ id: number; score: number }>(
      `SELECT cc.id, 1.0 AS score
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
         WHERE p.source_id = 'source-a' AND cc.symbol_name_qualified = 'callerInA'
         LIMIT 1`,
      [],
    );
    expect(callerChunk.length).toBe(1);
    const anchors = [{
      slug: 'src/foo.ts',
      page_id: 0,
      title: '',
      type: 'code' as const,
      chunk_text: '',
      chunk_source: 'compiled_truth' as const,
      chunk_id: callerChunk[0]!.id,
      chunk_index: 0,
      score: 1.0,
      source_id: 'source-a',
      stale: false,
    }];

    const result = await expandAnchors(engine, anchors, {
      walkDepth: 1,
      sourceId: 'source-a',
    });

    expect(result.length).toBeGreaterThan(1); // anchor + at least one neighbor
    const chunkIds = result.map((r) => r.chunk_id);
    const rows = await engine.executeRaw<{ chunk_id: number; source_id: string }>(
      `SELECT cc.id AS chunk_id, p.source_id
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
         WHERE cc.id = ANY($1::int[])`,
      [chunkIds],
    );

    for (const r of rows) {
      expect(r.source_id).toBe('source-a');
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// Fixture: two sources, each with a `parseMarkdown` symbol.
// Source A also has a `callerInA` function whose unresolved call edge
// points at "parseMarkdown" (testing the walk_depth resolution path).
// ─────────────────────────────────────────────────────────────────

async function seedTwoSourcesWithSharedSymbol(engine: PGLiteEngine): Promise<void> {
  // Register two sources (schema: id PK, name UNIQUE NOT NULL, plus optional fields)
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, created_at)
     VALUES ('source-a', 'source-a', '/fake/a', '{}'::jsonb, NOW())
     ON CONFLICT (id) DO NOTHING`,
    [],
  );
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, created_at)
     VALUES ('source-b', 'source-b', '/fake/b', '{}'::jsonb, NOW())
     ON CONFLICT (id) DO NOTHING`,
    [],
  );

  // Page A1: contains parseMarkdown in source-a
  const pageA = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (slug, source_id, title, type, compiled_truth, frontmatter, updated_at, created_at)
     VALUES ('code/src/markdown-a.ts', 'source-a', 'markdown-a.ts', 'code', 'export function parseMarkdown(s: string) { return s; }', '{}'::jsonb, NOW(), NOW())
     RETURNING id`,
    [],
  );

  // Page A2: contains callerInA, which references parseMarkdown
  const pageA2 = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (slug, source_id, title, type, compiled_truth, frontmatter, updated_at, created_at)
     VALUES ('code/src/caller-a.ts', 'source-a', 'caller-a.ts', 'code', 'export function callerInA() { return parseMarkdown(""); }', '{}'::jsonb, NOW(), NOW())
     RETURNING id`,
    [],
  );

  // Page B: contains parseMarkdown in source-b
  const pageB = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (slug, source_id, title, type, compiled_truth, frontmatter, updated_at, created_at)
     VALUES ('code/src/markdown-b.ts', 'source-b', 'markdown-b.ts', 'code', 'export function parseMarkdown(s: string) { return s; }', '{}'::jsonb, NOW(), NOW())
     RETURNING id`,
    [],
  );

  // Chunks
  await engine.executeRaw(
    `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, language, symbol_name_qualified, symbol_type)
     VALUES ($1, 0, 'export function parseMarkdown(s: string) { return s; }', 'compiled_truth', 'typescript', 'parseMarkdown', 'function')`,
    [pageA[0]!.id],
  );
  await engine.executeRaw(
    `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, language, symbol_name_qualified, symbol_type)
     VALUES ($1, 0, 'export function callerInA() { return parseMarkdown(""); }', 'compiled_truth', 'typescript', 'callerInA', 'function')`,
    [pageA2[0]!.id],
  );
  await engine.executeRaw(
    `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, language, symbol_name_qualified, symbol_type)
     VALUES ($1, 0, 'export function parseMarkdown(s: string) { return s; }', 'compiled_truth', 'typescript', 'parseMarkdown', 'function')`,
    [pageB[0]!.id],
  );

  // Unresolved edge: callerInA → parseMarkdown (no to_chunk_id, must resolve via symbol_name_qualified)
  const callerChunk = await engine.executeRaw<{ id: number }>(
    `SELECT cc.id FROM content_chunks cc
       JOIN pages p ON p.id = cc.page_id
       WHERE p.source_id = 'source-a' AND cc.symbol_name_qualified = 'callerInA' LIMIT 1`,
    [],
  );
  await engine.executeRaw(
    `INSERT INTO code_edges_symbol (from_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, source_id, edge_metadata)
     VALUES ($1, 'callerInA', 'parseMarkdown', 'calls', 'source-a', '{}'::jsonb)`,
    [callerChunk[0]!.id],
  );
}
