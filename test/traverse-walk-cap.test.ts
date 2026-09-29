/**
 * Read-path audit #20: the graph walks enumerate every simple path with a
 * per-path visited array, so a dense hub is combinatorial (a 12-page clique
 * at depth 5 took ~22 s for traversePaths 'both' and ~3.5 s for
 * traverseGraph). The walk is now pulled through a row cap and deduped to
 * (page, depth) before the edge join, so it stays bounded and the shallow
 * neighbourhood stays complete.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const N = 12;
let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (let i = 0; i < N; i++) await engine.putPage(`clique/n${String(i).padStart(2, '0')}`, { type: 'note', title: `n${i}`, compiled_truth: `node ${i}` } as any);
  const links = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (i !== j) {
    links.push({ from_slug: `clique/n${String(i).padStart(2, '0')}`, to_slug: `clique/n${String(j).padStart(2, '0')}`, link_type: 'mentions' });
  }
  await engine.addLinksBatch(links);
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

describe('graph walks on a dense clique stay bounded', () => {
  test('traversePathsDetailed both @ depth 5', async () => {
    const t = performance.now();
    const r = await engine.traversePathsDetailed('clique/n00', { depth: 5, direction: 'both' });
    expect(performance.now() - t).toBeLessThan(5000);
    // Every edge of the clique is reachable at depth 1 or 2; none may be lost.
    const shallow = new Set(r.paths.filter(p => p.depth <= 2).map(p => `${p.from_slug}>${p.to_slug}`));
    expect(shallow.size).toBe(N * (N - 1));
  }, 30_000);

  test('traverseGraph @ depth 5', async () => {
    const t = performance.now();
    const nodes = await engine.traverseGraph('clique/n00', 5);
    expect(performance.now() - t).toBeLessThan(1500);
    expect(new Set(nodes.filter(n => n.depth <= 1).map(n => n.slug)).size).toBe(N);
  }, 30_000);

  test('an uncapped walk keeps its exact shape (depth-2 out walk)', async () => {
    const r = await engine.traversePathsDetailed('clique/n00', { depth: 2, direction: 'out' });
    expect(r.truncated).toBe(false);
    expect(r.paths.filter(p => p.depth === 1).length).toBe(N - 1);
    expect(r.paths.filter(p => p.depth === 2).length).toBe((N - 1) * (N - 1));
  }, 30_000);
});
