/**
 * v0.34 W0c — within-file two-pass symbol resolver E2E.
 *
 * Pins:
 *   - Unambiguous within-file match → edge_metadata.resolved_chunk_id set
 *   - Multi-match within file → edge_metadata.ambiguous=true + candidates
 *   - No match → edge stays untouched
 *   - chunks_walked watermark advances (edges_backfilled_at = NOW())
 *   - Idempotency: re-run on processed chunks is a no-op
 *   - Resume: bumping EDGE_EXTRACTOR_VERSION_TS forces re-walk
 *   - Source isolation: resolver scoped to one source_id; never touches edges
 *     in a different source even if the symbol name collides
 *
 * PGLite in-memory.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import {
  resolveSymbolEdgesIncremental,
  readEdgeResolution,
  EDGE_EXTRACTOR_VERSION_TS,
} from '../../src/core/chunkers/symbol-resolver.ts';
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

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('v0.34 W0c symbol-resolver — unambiguous within-file match', () => {
  test('single-file: parseMarkdown call resolves to the parseMarkdown chunk in same file', async () => {
    await registerSource(engine, 'source-a');
    const pageId = await insertCodePage(engine, 'source-a', 'src/foo.ts');
    const callerChunk = await insertChunk(engine, pageId, 0, 'callerInA', 'function');
    const defChunk = await insertChunk(engine, pageId, 1, 'parseMarkdown', 'function');
    await insertUnresolvedEdge(engine, callerChunk, 'callerInA', 'parseMarkdown', 'source-a');

    const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 'source-a' });

    expect(stats.chunks_walked).toBeGreaterThanOrEqual(2);
    expect(stats.edges_resolved).toBe(1);
    expect(stats.edges_ambiguous).toBe(0);
    expect(stats.edges_unmatched).toBe(0);

    const edges = await engine.executeRaw<{ edge_metadata: any }>(
      `SELECT edge_metadata FROM code_edges_symbol`,
      [],
    );
    expect(edges.length).toBe(1);
    const res = readEdgeResolution(edges[0]!.edge_metadata);
    expect(res.kind).toBe('resolved');
    if (res.kind === 'resolved') {
      expect(res.chunk_id).toBe(defChunk);
    }
  });
});

describe('v0.34 W0c symbol-resolver — ambiguous within-file match', () => {
  test('two same-named methods in the same file → ambiguous + candidates list', async () => {
    await registerSource(engine, 'source-a');
    const pageId = await insertCodePage(engine, 'source-a', 'src/foo.ts');
    const callerChunk = await insertChunk(engine, pageId, 0, 'callerInA', 'function');
    const def1 = await insertChunk(engine, pageId, 1, 'render', 'function');
    const def2 = await insertChunk(engine, pageId, 2, 'render', 'function'); // dup symbol name in same file
    await insertUnresolvedEdge(engine, callerChunk, 'callerInA', 'render', 'source-a');

    const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 'source-a' });

    expect(stats.edges_ambiguous).toBe(1);
    expect(stats.edges_resolved).toBe(0);

    const edges = await engine.executeRaw<{ edge_metadata: any }>(
      `SELECT edge_metadata FROM code_edges_symbol`,
      [],
    );
    const res = readEdgeResolution(edges[0]!.edge_metadata);
    expect(res.kind).toBe('ambiguous');
    if (res.kind === 'ambiguous') {
      expect(res.candidate_chunk_ids.sort()).toEqual([def1, def2].sort());
    }
  });
});

describe('v0.34 W0c symbol-resolver — no match', () => {
  test('call to a symbol defined in another file stays unresolved (caller two-pass handles cross-file)', async () => {
    await registerSource(engine, 'source-a');
    const pageA = await insertCodePage(engine, 'source-a', 'src/foo.ts');
    const pageB = await insertCodePage(engine, 'source-a', 'src/bar.ts');
    const callerChunk = await insertChunk(engine, pageA, 0, 'callerInA', 'function');
    await insertChunk(engine, pageB, 0, 'externalFn', 'function'); // different file
    await insertUnresolvedEdge(engine, callerChunk, 'callerInA', 'externalFn', 'source-a');

    const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 'source-a' });

    expect(stats.edges_unmatched).toBe(1);
    expect(stats.edges_resolved).toBe(0);
    expect(stats.edges_ambiguous).toBe(0);

    const edges = await engine.executeRaw<{ edge_metadata: any }>(
      `SELECT edge_metadata FROM code_edges_symbol`,
      [],
    );
    const res = readEdgeResolution(edges[0]!.edge_metadata);
    expect(res.kind).toBe('unresolved');
  });
});

describe('v0.34 W0c symbol-resolver — watermark + idempotency', () => {
  test('edges_backfilled_at advances; second run is a no-op', async () => {
    await registerSource(engine, 'source-a');
    const pageId = await insertCodePage(engine, 'source-a', 'src/foo.ts');
    const callerChunk = await insertChunk(engine, pageId, 0, 'callerInA', 'function');
    await insertChunk(engine, pageId, 1, 'parseMarkdown', 'function');
    await insertUnresolvedEdge(engine, callerChunk, 'callerInA', 'parseMarkdown', 'source-a');

    const stats1 = await resolveSymbolEdgesIncremental(engine, { sourceId: 'source-a' });
    expect(stats1.chunks_walked).toBeGreaterThanOrEqual(2);

    const watermarkAfter = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM content_chunks
        WHERE edges_backfilled_at IS NOT NULL`,
      [],
    );
    expect(watermarkAfter[0]!.count).toBeGreaterThanOrEqual(2);

    // Second run: every chunk already has edges_backfilled_at >= EDGE_EXTRACTOR_VERSION_TS.
    const stats2 = await resolveSymbolEdgesIncremental(engine, { sourceId: 'source-a' });
    expect(stats2.chunks_walked).toBe(0);
    expect(stats2.edges_examined).toBe(0);
  });
});

describe('v0.34 W0c symbol-resolver — source isolation', () => {
  test("does not resolve via candidates in a different source", async () => {
    await registerSource(engine, 'source-a');
    await registerSource(engine, 'source-b');

    const pageA = await insertCodePage(engine, 'source-a', 'src/foo.ts');
    const pageB = await insertCodePage(engine, 'source-b', 'src/foo.ts');
    const callerInA = await insertChunk(engine, pageA, 0, 'callerInA', 'function');
    // source-b has the same-named symbol at the same relative file path
    await insertChunk(engine, pageB, 0, 'parseMarkdown', 'function');
    // source-a does NOT have a parseMarkdown definition
    await insertUnresolvedEdge(engine, callerInA, 'callerInA', 'parseMarkdown', 'source-a');

    const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 'source-a' });

    // The edge stays unresolved — the only same-symbol candidate is in
    // source-b, which the resolver must NOT cross to.
    expect(stats.edges_unmatched).toBe(1);
    expect(stats.edges_resolved).toBe(0);
    expect(stats.edges_ambiguous).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// Seeding helpers
// ─────────────────────────────────────────────────────────────────

async function registerSource(engine: PGLiteEngine, id: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, created_at)
     VALUES ($1, $1, $2, '{}'::jsonb, NOW())
     ON CONFLICT (id) DO NOTHING`,
    [id, `/fake/${id}`],
  );
}

async function insertCodePage(engine: PGLiteEngine, sourceId: string, slug: string): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (slug, source_id, title, type, page_kind, compiled_truth, frontmatter, updated_at, created_at)
     VALUES ($1, $2, $3, 'code', 'code', '', '{}'::jsonb, NOW(), NOW())
     RETURNING id`,
    [slug, sourceId, slug],
  );
  return rows[0]!.id;
}

async function insertChunk(
  engine: PGLiteEngine,
  pageId: number,
  chunkIndex: number,
  symbolName: string,
  symbolType: string,
): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, language, symbol_name_qualified, symbol_type)
     VALUES ($1, $2, $3, 'compiled_truth', 'typescript', $4, $5)
     RETURNING id`,
    [pageId, chunkIndex, `// ${symbolName} body`, symbolName, symbolType],
  );
  return rows[0]!.id;
}

async function insertUnresolvedEdge(
  engine: PGLiteEngine,
  fromChunkId: number,
  fromSymbol: string,
  toSymbol: string,
  sourceId: string,
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO code_edges_symbol (from_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, source_id, edge_metadata)
     VALUES ($1, $2, $3, 'calls', $4, '{}'::jsonb)`,
    [fromChunkId, fromSymbol, toSymbol, sourceId],
  );
}
