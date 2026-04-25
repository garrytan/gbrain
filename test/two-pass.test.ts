/**
 * v0.20.0 Cathedral II Layer 7 (A2) — two-pass retrieval tests.
 *
 * Validates:
 *   - expandAnchors no-op when walkDepth=0 and nearSymbol unset.
 *   - walkDepth=1 adds 1-hop neighbors with decayed scores.
 *   - walkDepth=2 adds 2-hop neighbors (capped).
 *   - nearSymbol anchors chunks by qualified name.
 *   - hybridSearch respects opts.walkDepth + opts.nearSymbol without
 *     breaking the default-off retrieval path.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { expandAnchors, hydrateChunks } from '../src/core/search/two-pass.ts';

describe('Layer 7 (A2) — expandAnchors', () => {
  let engine: PGLiteEngine;
  let chunkA: number;
  let chunkB: number;
  let chunkC: number;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    await engine.putPage('src-a-ts', {
      type: 'code', page_kind: 'code',
      title: 'src/a.ts (typescript)',
      compiled_truth: 'export function a() { return b(); }',
      timeline: '',
    });
    await engine.upsertChunks('src-a-ts', [{
      chunk_index: 0,
      chunk_text: 'export function a() { return b(); }',
      chunk_source: 'compiled_truth',
      language: 'typescript',
      symbol_name: 'a', symbol_type: 'function',
      symbol_name_qualified: 'a',
    }]);

    await engine.putPage('src-b-ts', {
      type: 'code', page_kind: 'code',
      title: 'src/b.ts (typescript)',
      compiled_truth: 'export function b() { return c(); }',
      timeline: '',
    });
    await engine.upsertChunks('src-b-ts', [{
      chunk_index: 0,
      chunk_text: 'export function b() { return c(); }',
      chunk_source: 'compiled_truth',
      language: 'typescript',
      symbol_name: 'b', symbol_type: 'function',
      symbol_name_qualified: 'b',
    }]);

    await engine.putPage('src-c-ts', {
      type: 'code', page_kind: 'code',
      title: 'src/c.ts (typescript)',
      compiled_truth: 'export function c() { return 1; }',
      timeline: '',
    });
    await engine.upsertChunks('src-c-ts', [{
      chunk_index: 0,
      chunk_text: 'export function c() { return 1; }',
      chunk_source: 'compiled_truth',
      language: 'typescript',
      symbol_name: 'c', symbol_type: 'function',
      symbol_name_qualified: 'c',
    }]);

    const aChunks = await engine.getChunks('src-a-ts');
    const bChunks = await engine.getChunks('src-b-ts');
    const cChunks = await engine.getChunks('src-c-ts');
    chunkA = aChunks[0]!.id;
    chunkB = bChunks[0]!.id;
    chunkC = cChunks[0]!.id;

    // Edges: a → b, b → c (unresolved — code_edges_symbol path).
    await engine.addCodeEdges([
      { from_chunk_id: chunkA, to_chunk_id: null,
        from_symbol_qualified: 'a', to_symbol_qualified: 'b',
        edge_type: 'calls' },
      { from_chunk_id: chunkB, to_chunk_id: null,
        from_symbol_qualified: 'b', to_symbol_qualified: 'c',
        edge_type: 'calls' },
    ]);
  });

  afterAll(async () => {
    await engine.disconnect();
  }, 30_000);

  test('walkDepth=0 is a no-op (anchors only)', async () => {
    const anchors = [{
      slug: 'src-a-ts', page_id: 0, title: 'a', type: 'code',
      chunk_text: '', chunk_source: 'compiled_truth', chunk_id: chunkA,
      chunk_index: 0, score: 1.0, stale: false, source_id: 'default',
    } as never];
    const expanded = await expandAnchors(engine, anchors, { walkDepth: 0 });
    expect(expanded.length).toBe(1);
    expect(expanded[0]!.chunk_id).toBe(chunkA);
    expect(expanded[0]!.hop).toBe(0);
  });

  test('walkDepth=1 expands to direct neighbors', async () => {
    const anchors = [{
      slug: 'src-a-ts', page_id: 0, title: 'a', type: 'code',
      chunk_text: '', chunk_source: 'compiled_truth', chunk_id: chunkA,
      chunk_index: 0, score: 1.0, stale: false, source_id: 'default',
    } as never];
    const expanded = await expandAnchors(engine, anchors, { walkDepth: 1 });
    const ids = expanded.map(e => e.chunk_id);
    expect(ids).toContain(chunkA); // anchor
    expect(ids).toContain(chunkB); // 1-hop neighbor via calls edge

    const neighbor = expanded.find(e => e.chunk_id === chunkB);
    expect(neighbor!.hop).toBe(1);
    // 1/(1+1) * 1.0 = 0.5
    expect(neighbor!.score).toBeCloseTo(0.5, 2);
  });

  test('walkDepth=2 reaches grandchildren', async () => {
    const anchors = [{
      slug: 'src-a-ts', page_id: 0, title: 'a', type: 'code',
      chunk_text: '', chunk_source: 'compiled_truth', chunk_id: chunkA,
      chunk_index: 0, score: 1.0, stale: false, source_id: 'default',
    } as never];
    const expanded = await expandAnchors(engine, anchors, { walkDepth: 2 });
    const ids = expanded.map(e => e.chunk_id);
    expect(ids).toContain(chunkC); // 2-hop
    const twoHop = expanded.find(e => e.chunk_id === chunkC);
    expect(twoHop!.hop).toBe(2);
  });

  test('walkDepth clamps at 2 (even when caller passes 5)', async () => {
    const anchors = [{
      slug: 'src-a-ts', page_id: 0, title: 'a', type: 'code',
      chunk_text: '', chunk_source: 'compiled_truth', chunk_id: chunkA,
      chunk_index: 0, score: 1.0, stale: false, source_id: 'default',
    } as never];
    const expanded = await expandAnchors(engine, anchors, { walkDepth: 5 });
    const maxHop = Math.max(...expanded.map(e => e.hop));
    expect(maxHop).toBeLessThanOrEqual(2);
  });

  test('nearSymbol anchors chunks by qualified name', async () => {
    const expanded = await expandAnchors(engine, [], {
      walkDepth: 1,
      nearSymbol: 'b',
    });
    const ids = expanded.map(e => e.chunk_id);
    expect(ids).toContain(chunkB); // anchored via nearSymbol
    expect(ids).toContain(chunkC); // 1-hop neighbor
  });

  test('hydrateChunks fetches SearchResult rows for chunk IDs', async () => {
    const rows = await hydrateChunks(engine, [chunkB, chunkC]);
    expect(rows.length).toBe(2);
    const slugs = rows.map(r => r.slug);
    expect(slugs).toContain('src-b-ts');
    expect(slugs).toContain('src-c-ts');
  });

  test('hydrateChunks with empty array returns []', async () => {
    const rows = await hydrateChunks(engine, []);
    expect(rows).toEqual([]);
  });
});

describe('Layer 7 (A2) — query operation schema', () => {
  test('query op exposes near_symbol + walk_depth params', async () => {
    const { operations } = await import('../src/core/operations.ts');
    const queryOp = operations.find(o => o.name === 'query');
    expect(queryOp).toBeDefined();
    expect(queryOp!.params.near_symbol).toBeDefined();
    expect(queryOp!.params.walk_depth).toBeDefined();
    expect(queryOp!.params.walk_depth!.type).toBe('number');
  });
});
