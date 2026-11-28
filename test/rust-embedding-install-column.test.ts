/**
 * Embedding install on a Rust brain refuses a batch the store cannot write exactly.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `installChunkEmbeddings` refuses with `engine_capability_missing`, before writing anything, a `halfvec`
 *    descriptor, a vector whose length differs from the width the store keeps (a stored vector, else the config
 *    `embedding_dimensions`), and, with no width known, a batch whose rows differ in length from each other. A refused
 *    batch leaves every chunk without a vector, so `readEmbeddingCompletion` never reports one complete. The default
 *    descriptor (a 1536 placeholder on every brain) installs vectors of the store's own width, whatever it is.
 *  - Regression: the member read only the column's name, so a short vector or a `halfvec` column's vector was forwarded
 *    as float32 and the chunk was marked complete, where Postgres rejects the length and rounds `halfvec`.
 *  - Why existing coverage misses it: the landing test for the member runs on PGLite, whose column has a fixed width.
 *  - Seam: none. The engine is the real addon.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ResolvedColumn } from '../src/core/types.ts';
import { openRustBrain, removeBrainDir, rustArmRequested } from './engine-parity/rust-arm.ts';

describe.skipIf(!rustArmRequested())('Rust engine: installChunkEmbeddings width checks', () => {
  let engine: BrainEngine;
  let dir: string;
  let pageId: number;
  let chunks: Array<{ id: number; text: string }>;

  // The default descriptor, as normalizeEngineColumn builds it: its 1536 is a placeholder the SQL engines never read.
  const column = (over: Partial<ResolvedColumn> = {}): ResolvedColumn => ({ name: 'embedding', type: 'vector', dimensions: 1536, embeddingModel: 'test:model', ...over });
  const vector = (length: number, fill = 0.25) => `[${Array.from({ length }, () => fill).join(',')}]`;
  const batch = (...lengths: number[]) => JSON.stringify(chunks.map((c, i) => ({ id: c.id, chunk_text: c.text, embedding: vector(lengths[i] ?? lengths[0]!), image: null, model: 'test:model', input_hash: `hash-${c.id}` })));
  const completion = () => engine.readEmbeddingCompletion(pageId, { signature: 'sig', model: 'test:model', column: { name: 'embedding' }, manifest: false });
  const storedWidth = async () => (await (engine as unknown as { storeFor(m: string): Promise<{ brain: { readChunkVectorColumn(a: { name: string }): Promise<{ exists: boolean; dims: number | null }> } }> })
    .storeFor('readChunkVectorColumn')).brain.readChunkVectorColumn({ name: 'embedding' });

  beforeEach(async () => {
    const opened = await openRustBrain();
    engine = opened.engine as unknown as BrainEngine;
    dir = opened.dir;
    pageId = (await engine.putPage('embed/install', { type: 'note', title: 'install', compiled_truth: 'Two chunks.', timeline: '' })).id;
    await engine.upsertChunks('embed/install', [
      { chunk_index: 0, chunk_text: 'first chunk text', chunk_source: 'compiled_truth' },
      { chunk_index: 1, chunk_text: 'second chunk text', chunk_source: 'compiled_truth' },
    ], { sourceId: 'default' });
    chunks = (await completion()).map(c => ({ id: c.id, text: c.chunk_text }));
    expect(chunks.length).toBe(2);
  }, 120_000);
  afterEach(async () => {
    await engine.disconnect();
    removeBrainDir(dir);
  });

  const refusal = (run: () => Promise<void>) => run().then(() => null, (e: { code?: string; detail?: string }) => e);
  const nothingInstalled = async (width: number | null) => {
    expect((await completion()).every(c => c.embedded === false)).toBe(true);
    expect((await storedWidth()).dims).toBe(width);
  };

  test('a halfvec column is refused, and nothing is written', async () => {
    const refused = await refusal(() => engine.installChunkEmbeddings(pageId, column({ type: 'halfvec' }), batch(3)));
    expect(refused?.code).toBe('engine_capability_missing');
    expect(refused?.detail).toContain('member=installChunkEmbeddings');
    await nothingInstalled(null);
  });

  test.each([3, 768])('the default descriptor installs vectors of the width the store keeps (%d), not the placeholder 1536', async (width) => {
    await engine.installChunkEmbeddings(pageId, column(), batch(width));
    expect((await completion()).map(c => c.embedded)).toEqual([true, true]);
    expect(await storedWidth()).toEqual({ exists: true, dims: width });
  });

  test('a short or a long vector is refused against a width held by a stored vector, and no chunk is marked complete', async () => {
    await engine.installChunkEmbeddings(pageId, column(), JSON.stringify([{ id: chunks[0]!.id, chunk_text: chunks[0]!.text, embedding: vector(3), image: null, model: 'test:model', input_hash: 'h0' }]));
    for (const length of [2, 4]) {
      const refused = await refusal(() => engine.installChunkEmbeddings(pageId, column(), JSON.stringify([{ id: chunks[1]!.id, chunk_text: chunks[1]!.text, embedding: vector(length), image: null, model: 'test:model', input_hash: 'h1' }])));
      expect(refused?.code).toBe('engine_capability_missing');
      expect(refused?.detail).toContain(`a vector of ${length} dimensions for column embedding; the store keeps 3`);
    }
    expect((await completion()).map(c => c.embedded)).toEqual([true, false]);
    expect(await storedWidth()).toEqual({ exists: true, dims: 3 });
  });

  test('a short or a long vector is refused against a width the config declares, and nothing is written', async () => {
    await engine.setConfig('embedding_dimensions', '4');
    expect((await storedWidth()).dims).toBe(4);
    for (const length of [3, 5]) {
      const refused = await refusal(() => engine.installChunkEmbeddings(pageId, column(), batch(length)));
      expect(refused?.code).toBe('engine_capability_missing');
      expect(refused?.detail).toContain(`a vector of ${length} dimensions for column embedding; the store keeps 4`);
    }
    await nothingInstalled(4);
    await engine.installChunkEmbeddings(pageId, column(), batch(4));
    expect((await completion()).map(c => c.embedded)).toEqual([true, true]);
  });

  test('a batch whose rows differ in length is refused when the store keeps no width', async () => {
    expect(await storedWidth()).toEqual({ exists: false, dims: null });
    const refused = await refusal(() => engine.installChunkEmbeddings(pageId, column(), batch(3, 2)));
    expect(refused?.code).toBe('engine_capability_missing');
    expect(refused?.detail).toContain('member=installChunkEmbeddings');
    await nothingInstalled(null);
  });
});
