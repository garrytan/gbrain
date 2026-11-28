/**
 * Embedding install on a Rust brain refuses a batch the store cannot write exactly.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `installChunkEmbeddings` refuses, before writing anything, a `halfvec` descriptor
 *    (`engine_capability_missing`), and a batch with a vector whose length differs from the width upsertChunks takes (the
 *    config `embedding_dimensions`, else 1536) (`invalid_argument`, as upsertChunks
 *    refuses it). A refused batch leaves every chunk without a
 *    vector, so `readEmbeddingCompletion` never reports one complete. The default descriptor (a 1536 placeholder on
 *    every brain) is not read: the configured width is the check.
 *  - Regression: the member read only the column's name, so a short vector or a `halfvec` column's vector was forwarded
 *    as float32 and the chunk was marked complete, where Postgres rejects the length and rounds `halfvec`. Later, with no
 *    width configured, a first batch of width 3 installed and fixed the store at 3 while upsertChunks kept writing 1536,
 *    so both writes succeeded and every vector search then failed on mixed widths.
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

  test.each([3, 768])('the default descriptor installs vectors of the configured width (%d), not the placeholder 1536', async (width) => {
    await engine.setConfig('embedding_dimensions', String(width));
    await engine.installChunkEmbeddings(pageId, column(), batch(width));
    expect((await completion()).map(c => c.embedded)).toEqual([true, true]);
    expect(await storedWidth()).toEqual({ exists: true, dims: width });
  });

  test('with no width configured the install takes upsertChunks\' 1536: a width-3 batch is refused, so a later 1536 write and vector search agree', async () => {
    const refused = await refusal(() => engine.installChunkEmbeddings(pageId, column(), batch(3)));
    expect({ code: refused?.code, message: (refused as { message?: string } | null)?.message })
      .toEqual({ code: 'invalid_argument', message: expect.stringContaining('expected 1536 dimensions, not 3') });
    await nothingInstalled(null);
    await engine.installChunkEmbeddings(pageId, column(), batch(1536));
    expect((await completion()).map(c => c.embedded)).toEqual([true, true]);
    await engine.putPage('embed/other', { type: 'note', title: 'other', compiled_truth: 'Another page.', timeline: '' });
    const wide = new Float32Array(1536).fill(0.25);
    await engine.upsertChunks('embed/other', [{ chunk_index: 0, chunk_text: 'another chunk text', chunk_source: 'compiled_truth', embedding: wide, model: 'test:model' }], { sourceId: 'default' });
    const widths = async (slug: string) => (await engine.getChunks(slug, { includeEmbedding: true, includeUnsealed: true }))
      .map(c => (c.embedding as Float32Array | null)?.length ?? null);
    expect({ install: await widths('embed/install'), other: await widths('embed/other') }).toEqual({ install: [1536, 1536], other: [1536] });
    // With two widths stored, this read failed with "different vector dimensions"; one width answers it.
    expect(Array.isArray(await engine.searchVector(wide, { limit: 10 }))).toBe(true);
  });

  test('a short or a long vector is refused against the configured width once a vector is stored, and no chunk is marked complete', async () => {
    await engine.setConfig('embedding_dimensions', '3');
    await engine.installChunkEmbeddings(pageId, column(), JSON.stringify([{ id: chunks[0]!.id, chunk_text: chunks[0]!.text, embedding: vector(3), image: null, model: 'test:model', input_hash: 'h0' }]));
    for (const length of [2, 4]) {
      const refused = await refusal(() => engine.installChunkEmbeddings(pageId, column(), JSON.stringify([{ id: chunks[1]!.id, chunk_text: chunks[1]!.text, embedding: vector(length), image: null, model: 'test:model', input_hash: 'h1' }])));
      expect(refused?.code).toBe('invalid_argument');
      expect((refused as { message?: string }).message).toContain(`expected 3 dimensions, not ${length}`);
    }
    expect((await completion()).map(c => c.embedded)).toEqual([true, false]);
    expect(await storedWidth()).toEqual({ exists: true, dims: 3 });
  });

  test('a short or a long vector is refused against a width the config declares, and nothing is written', async () => {
    await engine.setConfig('embedding_dimensions', '4');
    expect((await storedWidth()).dims).toBe(4);
    for (const length of [3, 5]) {
      const refused = await refusal(() => engine.installChunkEmbeddings(pageId, column(), batch(length)));
      expect(refused?.code).toBe('invalid_argument');
      expect((refused as { message?: string }).message).toContain(`expected 4 dimensions, not ${length}`);
    }
    await nothingInstalled(4);
    await engine.installChunkEmbeddings(pageId, column(), batch(4));
    expect((await completion()).map(c => c.embedded)).toEqual([true, true]);
  });

  test('a batch whose rows differ in length is refused whole, and nothing is written', async () => {
    expect(await storedWidth()).toEqual({ exists: false, dims: null });
    const refused = await refusal(() => engine.installChunkEmbeddings(pageId, column(), batch(1536, 3)));
    expect(refused?.code).toBe('invalid_argument');
    await nothingInstalled(null);
  });
});
