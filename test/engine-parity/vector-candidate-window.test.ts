/**
 * BrainEngine parity: vector search takes its candidate chunks before it keeps each page's best one.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite, Postgres (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1) `searchVector` answers the
 *    same pages: it takes the nearest `offset + max(limit * 5, 100)` admitted chunks by distance, then chunk id
 *    (src/core/search/vector-statement.ts), keeps each page's best chunk among them, and widens that window (x4) while it
 *    is full and holds fewer pages than the limit (src/core/search/vector-pool.ts).
 *  - Regression: the Rust store scored every chunk and kept each page's best one, with no window, so with more chunks at
 *    one distance than the window holds it answered the page with the lowest page id where the SQL engines answer the
 *    page whose tied chunk has the lowest chunk id.
 *  - Why existing coverage misses it: no vector parity case has more tied chunks than the window, or a page whose chunks
 *    fill the window on their own.
 *  - Seam: none. Pages and chunks are written through putPage and sealChunks.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { basisEmbedding, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, installChunks } from './chunk-fixtures.ts';

const { parityTest } = parityArms(testBackends());

/** A unit vector at `angle` radians from axis 7 toward axis 8: a larger angle is farther from the basisEmbedding(7) query. */
function at(angle: number): Float32Array {
  const v = new Float32Array(1536);
  v[7] = Math.cos(angle);
  v[8] = Math.sin(angle);
  return v;
}

const page = (engine: BrainEngine, slug: string) => engine.putPage(slug, { type: 'note' as never, title: slug, compiled_truth: slug, timeline: '' });

describe('engine parity: the vector candidate window', () => {
  parityTest('more tied chunks than the window: the page whose tied chunk has the lowest chunk id wins, not the lowest page id', {
    methods: ['putPage', 'sealChunks', 'searchVector'], timeout: 120_000,
  }, async (engine) => {
    await page(engine, 'notes/tie-a');
    await page(engine, 'notes/tie-b');
    // tie-b's 100 chunks get the lower chunk ids and fill the window of a limit-1 search; tie-a has the lower page id.
    await installChunks(engine, 'notes/tie-b', Array.from({ length: 100 }, (_, i) => chunk(i, `tie b ${i}`, { embedding: basisEmbedding(7) })));
    await installChunks(engine, 'notes/tie-a', [chunk(0, 'tie a', { embedding: basisEmbedding(7) })]);
    const hits = (await engine.searchVector(basisEmbedding(7), { limit: 1 })).map(h => ({ slug: h.slug, chunk: h.chunk_index }));
    expect(hits).toEqual([{ slug: 'notes/tie-b', chunk: 0 }]);
    return hits;
  });

  parityTest('a page whose chunks fill the window on their own: the window widens until it holds the limit in pages', {
    methods: ['putPage', 'sealChunks', 'searchVector'], timeout: 120_000,
  }, async (engine) => {
    await page(engine, 'notes/crowd');
    await page(engine, 'notes/far');
    // 150 close chunks on one page, then one farther chunk on another: a limit-2 window of 100 holds only the first page.
    await installChunks(engine, 'notes/crowd', Array.from({ length: 150 }, (_, i) => chunk(i, `crowd ${i}`, { embedding: at(0.01 + i * 0.001) })));
    await installChunks(engine, 'notes/far', [chunk(0, 'far', { embedding: at(1.0) })]);
    const hits = (await engine.searchVector(basisEmbedding(7), { limit: 2 })).map(h => ({ slug: h.slug, chunk: h.chunk_index }));
    expect(hits).toEqual([{ slug: 'notes/crowd', chunk: 0 }, { slug: 'notes/far', chunk: 0 }]);
    return hits;
  });
});
