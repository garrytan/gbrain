/**
 * BrainEngine parity — the vector catalog the embedding commands read, and the stale-fact count.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readChunkVectorColumn, readEmbeddingIdentity, listEmbeddingStores, hasStoredVectors and
 *    countStaleFactEmbeddings return the same observable result on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: `gbrain embeddings enable` on a keyless Rust brain read the Postgres catalog through `executeRaw`, which
 *    the Rust engine refuses, so the command failed and the readiness fix it named re-initialized the store as PGLite.
 *    An engine that answers one of these reads differently changes what `embeddings enable`, `migrate embeddings` and
 *    the vector-plan and fact-embedding doctor checks decide.
 *  - Why existing coverage misses it: the statements ran through `executeRaw`, which the parity cases cannot call (D18).
 *  - Seam: none. The width and model are seeded through setConfig (the Rust store has no column type; it reads the
 *    config when no vector is stored), the vectors through upsertChunks, insertFact and updateTakeEmbeddings.
 *    `embedding_image` and `embedding_multimodal` have no Rust form and are not compared.
 */
import { describe, expect } from 'bun:test';
import { basisEmbedding, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine, NewFact } from '../../src/core/engine.ts';
import type { ChunkInput } from '../../src/core/types.ts';
import { PRIMARY_EMBEDDING_TABLES } from '../../src/core/engine-sql/embedding-catalog.ts';

const { parityTest } = parityArms(testBackends());

const MODEL = 'model-a';

/** The default width and a model, as `gbrain init` (and `embeddings enable`) record them. */
async function configure(engine: BrainEngine): Promise<void> {
  await engine.setConfig('embedding_dimensions', '1536');
  await engine.setConfig('embedding_model', MODEL);
}

const chunk = (index: number, text: string, extra: Partial<ChunkInput> = {}): ChunkInput =>
  ({ chunk_index: index, chunk_text: text, chunk_source: 'compiled_truth', ...extra });

async function vectors(engine: BrainEngine): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const store of PRIMARY_EMBEDDING_TABLES) out[store] = await engine.hasStoredVectors(store);
  return out;
}

async function fact(engine: BrainEngine, text: string, extra: Partial<NewFact> = {}, sourceId = 'default'): Promise<number> {
  return (await engine.insertFact({ fact: text, source: 'chat', ...extra }, { source_id: sourceId })).id;
}

describe('engine parity: embedding catalog', () => {
  parityTest('readChunkVectorColumn reads the width of content_chunks.embedding and no column it lacks', { methods: ['readChunkVectorColumn'] }, async (engine) => {
    await configure(engine);
    const embedding = await engine.readChunkVectorColumn('embedding');
    const missing = await engine.readChunkVectorColumn('no_such_column');
    expect(embedding).toEqual({ exists: true, dims: 1536 });
    expect(missing).toEqual({ exists: false, dims: null });
    return { embedding, missing };
  });

  parityTest('readEmbeddingIdentity reads the configured model and the column width, before and after a vector is stored', { methods: ['readEmbeddingIdentity', 'upsertChunks'] }, async (engine) => {
    await configure(engine);
    const empty = await engine.readEmbeddingIdentity();
    await engine.putPage('notes/a', { type: 'note', title: 'A', compiled_truth: 'alpha body' });
    await engine.upsertChunks('notes/a', [chunk(0, 'alpha body', { embedding: basisEmbedding(3), model: MODEL })]);
    const stored = await engine.readEmbeddingIdentity();
    expect(empty).toEqual({ model: MODEL, dimensions: 1536 });
    expect(stored).toEqual({ model: MODEL, dimensions: 1536 });
    return { empty, stored };
  });

  parityTest('listEmbeddingStores names every table that carries a primary vector column', { methods: ['listEmbeddingStores'] }, async (engine) => {
    const stores = await engine.listEmbeddingStores();
    expect(stores).toEqual(['content_chunks', 'facts', 'query_cache', 'takes']);
    return stores;
  });

  parityTest('hasStoredVectors says which stores hold a vector; a claim edit takes a take vector away', { methods: ['hasStoredVectors', 'upsertChunks', 'insertFact', 'addTakesBatch', 'updateTakeEmbeddings'] }, async (engine) => {
    await configure(engine);
    const empty = await vectors(engine);
    await engine.putPage('notes/a', { type: 'note', title: 'A', compiled_truth: 'alpha body' });
    await engine.upsertChunks('notes/a', [chunk(0, 'alpha body')]);
    await fact(engine, 'no vector');
    const page = await engine.getPage('notes/a');
    await engine.addTakesBatch([{ page_id: page!.id, row_num: 1, claim: 'a claim', kind: 'take', holder: 'garry' }]);
    const textOnly = await vectors(engine);
    await engine.upsertChunks('notes/a', [chunk(0, 'alpha body', { embedding: basisEmbedding(1), model: MODEL })]);
    await fact(engine, 'with vector', { embedding: basisEmbedding(2), embedding_model: MODEL });
    const [take] = await engine.listTakes({ page_id: page!.id });
    await engine.updateTakeEmbeddings([{ take_id: take!.id, embedding: basisEmbedding(4), claim: 'a claim', model: MODEL }]);
    const embedded = await vectors(engine);
    await engine.addTakesBatch([{ page_id: page!.id, row_num: 1, claim: 'a reworded claim', kind: 'take', holder: 'garry' }]);
    const reworded = await vectors(engine);
    expect(empty).toEqual({ content_chunks: false, facts: false, query_cache: false, takes: false });
    expect(textOnly).toEqual(empty);
    expect(embedded).toEqual({ content_chunks: true, facts: true, query_cache: false, takes: true });
    expect(reworded).toEqual({ content_chunks: true, facts: true, query_cache: false, takes: false });
    return { empty, textOnly, embedded, reworded };
  });

  parityTest('countStaleFactEmbeddings counts the embeddable facts whose vector is missing or not current, with their length', { methods: ['countStaleFactEmbeddings'] }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const vec = basisEmbedding(1);
    await fact(engine, 'fresh', { embedding: vec, embedding_model: MODEL });
    await fact(engine, 'no vector');
    await fact(engine, 'other model', { embedding: vec, embedding_model: 'model-b' });
    await fact(engine, '😀'.repeat(3));
    await fact(engine, 'elsewhere', {}, 'other');
    const all = await engine.countStaleFactEmbeddings({ model: MODEL, dims: 1536 });
    const one = await engine.countStaleFactEmbeddings({ model: MODEL, dims: 1536, sourceId: 'other' });
    const narrow = await engine.countStaleFactEmbeddings({ model: MODEL, dims: 1024, sourceId: 'default' });
    return { all, one, narrow };
  });
});
