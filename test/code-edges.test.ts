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
});
