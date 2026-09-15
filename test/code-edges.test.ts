/**
 * v0.20.0 Cathedral II Layer 5 (A1) — code-edges engine method tests.
 *
 * Tests addCodeEdges / deleteCodeEdgesForChunks / getCallersOf /
 * getCalleesOf / getEdgesByChunk against real PGLite. End-to-end
 * importCodeFile integration is covered in code-edges-integration.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

describe('Layer 5 (A1) — code-edges engine methods', () => {
  let engine: PGLiteEngine;
  let chunkA: number;
  let chunkB: number;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    // Create two code pages with one chunk each.
    await engine.putPage('src-a-ts', {
      type: 'code', page_kind: 'code',
      title: 'src/a.ts (typescript)',
      compiled_truth: 'export function run() { return helper(); }',
      timeline: '',
    });
    await engine.upsertChunks('src-a-ts', [{
      chunk_index: 0,
      chunk_text: 'export function run() { return helper(); }',
      chunk_source: 'compiled_truth',
      language: 'typescript',
      symbol_name: 'run',
      symbol_type: 'function',
      symbol_name_qualified: 'run',
    }]);

    await engine.putPage('src-b-ts', {
      type: 'code', page_kind: 'code',
      title: 'src/b.ts (typescript)',
      compiled_truth: 'export function helper() { return 1; }',
      timeline: '',
    });
    await engine.upsertChunks('src-b-ts', [{
      chunk_index: 0,
      chunk_text: 'export function helper() { return 1; }',
      chunk_source: 'compiled_truth',
      language: 'typescript',
      symbol_name: 'helper',
      symbol_type: 'function',
      symbol_name_qualified: 'helper',
    }]);

    const aChunks = await engine.getChunks('src-a-ts');
    const bChunks = await engine.getChunks('src-b-ts');
    chunkA = aChunks[0]!.id;
    chunkB = bChunks[0]!.id;
  });

  afterAll(async () => {
    await engine.disconnect();
  }, 30_000);

  test('addCodeEdges inserts unresolved rows into code_edges_symbol', async () => {
    const inserted = await engine.addCodeEdges([{
      from_chunk_id: chunkA,
      to_chunk_id: null,
      from_symbol_qualified: 'run',
      to_symbol_qualified: 'helper',
      edge_type: 'calls',
    }]);
    expect(inserted).toBeGreaterThanOrEqual(1);
  });

  test('getCallersOf finds the caller by short name (unresolved path)', async () => {
    const results = await engine.getCallersOf('helper', { allSources: true });
    expect(results.length).toBeGreaterThanOrEqual(1);
    const hit = results.find(r => r.from_symbol_qualified === 'run');
    expect(hit).toBeDefined();
    expect(hit!.resolved).toBe(false); // unresolved (from code_edges_symbol)
    expect(hit!.to_symbol_qualified).toBe('helper');
    expect(hit!.edge_type).toBe('calls');
  });

  test('getCalleesOf finds outbound edges', async () => {
    const results = await engine.getCalleesOf('run', { allSources: true });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.to_symbol_qualified).toBe('helper');
  });

  test('addCodeEdges is idempotent (ON CONFLICT DO NOTHING)', async () => {
    // Re-inserting the same edge returns 0 insertions.
    const inserted = await engine.addCodeEdges([{
      from_chunk_id: chunkA,
      to_chunk_id: null,
      from_symbol_qualified: 'run',
      to_symbol_qualified: 'helper',
      edge_type: 'calls',
    }]);
    expect(inserted).toBe(0);
  });

  test('addCodeEdges resolved path lands in code_edges_chunk', async () => {
    const inserted = await engine.addCodeEdges([{
      from_chunk_id: chunkA,
      to_chunk_id: chunkB,
      from_symbol_qualified: 'run',
      to_symbol_qualified: 'helper',
      edge_type: 'calls',
    }]);
    expect(inserted).toBeGreaterThanOrEqual(1);

    // getCallersOf UNIONs both tables; resolved hit should now appear
    // alongside the unresolved one.
    const results = await engine.getCallersOf('helper', { allSources: true });
    const resolvedCount = results.filter(r => r.resolved).length;
    expect(resolvedCount).toBeGreaterThanOrEqual(1);
  });

  test('getEdgesByChunk returns edges for a known chunk', async () => {
    const outgoing = await engine.getEdgesByChunk(chunkA, { direction: 'out' });
    expect(outgoing.length).toBeGreaterThanOrEqual(1);
    const incoming = await engine.getEdgesByChunk(chunkB, { direction: 'in' });
    expect(incoming.length).toBeGreaterThanOrEqual(1);
  });

  test('deleteCodeEdgesForChunks removes rows in both directions', async () => {
    await engine.deleteCodeEdgesForChunks([chunkA]);
    const after = await engine.getEdgesByChunk(chunkA, { direction: 'both' });
    expect(after).toEqual([]);
    // code_edges_symbol rows from chunkA are also gone.
    const callers = await engine.getCallersOf('helper', { allSources: true });
    const fromA = callers.filter(r => r.from_chunk_id === chunkA);
    expect(fromA).toEqual([]);
  });

  test('empty edge input returns 0 without SQL', async () => {
    const inserted = await engine.addCodeEdges([]);
    expect(inserted).toBe(0);
  });

  test('batches edge writes before PGLite parameter overflow poisons later writes', async () => {
    // Six binds per unresolved edge. 5,462 rows require 32,772 binds, which
    // crosses PGLite's signed-int16 ceiling. Before batching, addCodeEdges
    // misleadingly returned success but every subsequent putPage produced no
    // row until the process restarted.
    const edgeCount = 5_462;
    const inserted = await engine.addCodeEdges(
      Array.from({ length: edgeCount }, (_, i) => ({
        from_chunk_id: chunkA,
        to_chunk_id: null,
        from_symbol_qualified: 'run',
        to_symbol_qualified: `overflow-target-${i}`,
        edge_type: 'calls',
      })),
    );
    expect(inserted).toBe(edgeCount);

    const rows = await engine.executeRaw<{ count: number | string }>(
      `SELECT COUNT(*) AS count
         FROM code_edges_symbol
        WHERE from_chunk_id = $1
          AND to_symbol_qualified LIKE 'overflow-target-%'`,
      [chunkA],
    );
    expect(Number(rows[0]!.count)).toBe(edgeCount);

    const page = await engine.putPage('post-edge-batch-smoke', {
      type: 'code', page_kind: 'code',
      title: 'Post-edge batch smoke',
      compiled_truth: 'export const stillWritable = true;',
      timeline: '',
    });
    expect(page.slug).toBe('post-edge-batch-smoke');
    expect((await engine.getPage('post-edge-batch-smoke'))?.slug).toBe(page.slug);
  });
});

// #4670 — `code_callees <bare>` promises "bare or qualified name", but every
// nested chunk (C#/Java/Ruby/Rust namespaces+classes, TS class methods) stores
// a QUALIFIED from_symbol_qualified, so the exact-match hot path returns 0 for
// the bare method name. The engine grows an opt-in `bareFallback` that, on a
// zero-row exact miss for a delimiter-free input, re-runs the same UNION keyed
// on content_chunks.symbol_name (the bare name). Off by default so the
// code_flow/code_blast BFS (which feeds bare leaf names back in) keeps its
// exact posture — a leaf must never inherit a same-named class method's callees.
describe('#4670 — getCalleesOf bare-name fallback (opt-in)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    await engine.putPage('src-order-service-cs', {
      type: 'code', page_kind: 'code',
      title: 'src/OrderService.cs (c_sharp)',
      compiled_truth: 'public async Task SubmitAsync() { ValidateRequest(); }',
      timeline: '',
    });
    await engine.upsertChunks('src-order-service-cs', [{
      chunk_index: 0,
      chunk_text: 'public async Task SubmitAsync() { ValidateRequest(); }',
      chunk_source: 'compiled_truth',
      language: 'c_sharp',
      symbol_name: 'SubmitAsync',
      symbol_type: 'method',
      symbol_name_qualified: 'MyApp.Services.OrderService.SubmitAsync',
    }]);
    const chunks = await engine.getChunks('src-order-service-cs');
    await engine.addCodeEdges([{
      from_chunk_id: chunks[0]!.id,
      to_chunk_id: null,
      from_symbol_qualified: 'MyApp.Services.OrderService.SubmitAsync',
      to_symbol_qualified: 'ValidateRequest',
      edge_type: 'calls',
    }]);
  });

  afterAll(async () => {
    await engine.disconnect();
  }, 30_000);

  test('qualified input hits the exact path with or without the fallback', async () => {
    const exact = await engine.getCalleesOf('MyApp.Services.OrderService.SubmitAsync', { allSources: true });
    expect(exact.map(e => e.to_symbol_qualified)).toEqual(['ValidateRequest']);
    const withFallback = await engine.getCalleesOf('MyApp.Services.OrderService.SubmitAsync', { allSources: true, bareFallback: true });
    expect(withFallback.map(e => e.to_symbol_qualified)).toEqual(['ValidateRequest']);
  });

  test('bare input WITHOUT the fallback stays an exact miss (BFS posture unchanged)', async () => {
    const rows = await engine.getCalleesOf('SubmitAsync', { allSources: true });
    expect(rows).toHaveLength(0);
  });

  test('bare input WITH the fallback resolves via content_chunks.symbol_name', async () => {
    const rows = await engine.getCalleesOf('SubmitAsync', { allSources: true, bareFallback: true });
    expect(rows.map(e => e.to_symbol_qualified)).toEqual(['ValidateRequest']);
    expect(rows[0]!.from_symbol_qualified).toBe('MyApp.Services.OrderService.SubmitAsync');
  });

  test('the fallback is exact on the bare name — no substring / LIKE leakage', async () => {
    expect(await engine.getCalleesOf('Async', { allSources: true, bareFallback: true })).toHaveLength(0);
    expect(await engine.getCalleesOf('Submit', { allSources: true, bareFallback: true })).toHaveLength(0);
    // Underscore is a LIKE wildcard; the reporter's LIKE sketch would match it.
    expect(await engine.getCalleesOf('Submit_sync', { allSources: true, bareFallback: true })).toHaveLength(0);
  });

  test('a delimited input never falls back even when the exact path misses', async () => {
    expect(await engine.getCalleesOf('Other.SubmitAsync', { allSources: true, bareFallback: true })).toHaveLength(0);
    expect(await engine.getCalleesOf('Foo#SubmitAsync', { allSources: true, bareFallback: true })).toHaveLength(0);
  });

  test('source scoping still applies on the fallback path', async () => {
    // The chunk's page + edge live in source 'default'; a foreign scope sees nothing.
    expect(await engine.getCalleesOf('SubmitAsync', { sourceId: 'some-other-source', bareFallback: true })).toHaveLength(0);
    expect(await engine.getCalleesOf('SubmitAsync', { sourceId: 'default', bareFallback: true })).toHaveLength(1);
  });
});
