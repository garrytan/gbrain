/**
 * BrainEngine parity — the embedding effect's install path (engine-sql/embedding-install.ts): the completion read,
 * the effect claim check, the embedding switch lock and one batch of the vector install.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readEmbeddingCompletion, lockEffectClaimRow, lockEmbeddingSwitch and installChunkEmbeddings return the
 *    same answer, and leave the same chunks, on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust
 *    arm through test/engine-parity/harness.ts).
 *  - Regression: an engine that counts a chunk complete under another model or after its text changed skips a paid
 *    embed the page needs; one that installs a vector onto a chunk whose text changed stores a vector for the wrong
 *    text. The Rust engine has no SQL, so the embedding effect stopped at these statements (`engine_capability_missing`).
 *  - Why existing coverage misses it: embedPage (persistence/effects.ts) and installPageEmbeddings
 *    (page-state/projections.ts) sent these statements through `executeRaw`, which the parity cases cannot call (D18).
 *  - Seam: none. Chunk ids differ by arm, so answers carry chunk indexes; the claim row of a running effect is covered
 *    end to end by test/persistence-embedding-effects.test.ts and test/rust-embedding-effect.test.ts.
 */
import { describe, expect } from 'bun:test';
import { basisEmbedding, parityArms } from './harness.ts';
import { chunk, seedPage } from './chunk-fixtures.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ResolvedColumn } from '../../src/core/types.ts';

const { parityTest } = parityArms(testBackends());

const PAGE = { type: 'note' as const, title: 'Install', compiled_truth: 'alpha beta gamma', timeline: '' };
const COLUMN: ResolvedColumn = { name: 'embedding', type: 'vector', dimensions: 1536, embeddingModel: 'model-a' };
const SIGNATURE = 'model-a:1536';

async function seed(engine: BrainEngine, slug: string) {
  await seedPage(engine, { slug, input: PAGE, chunks: [
    chunk(0, 'alpha', { embedding: basisEmbedding(1), model: 'model-a' }),
    chunk(1, 'beta'),
    chunk(2, 'gamma', { embedding: basisEmbedding(3), model: 'model-b' }),
  ] });
  const page = await engine.getPage(slug);
  const chunks = await engine.getChunks(slug, { includeUnsealed: true });
  return { pageId: Number(page!.id), ids: chunks.map(c => c.id) };
}

/** The completion rows by chunk index (ids differ by arm). */
async function completion(engine: BrainEngine, pageId: number, ids: number[], signature = SIGNATURE, model: string | null = 'model-a') {
  const rows = await engine.readEmbeddingCompletion(pageId, { signature, model, column: COLUMN, manifest: true });
  return rows.map(({ id, ...row }) => ({ index: ids.indexOf(id), ...row })).sort((a, b) => a.index - b.index);
}

const vectorText = (v: Float32Array) => `[${Array.from(v).join(',')}]`;

describe('engine parity: embedding install', () => {
  parityTest('readEmbeddingCompletion counts a chunk complete only with a vector from its current text under the model', {
    methods: ['putPage', 'sealChunks', 'getPage', 'getChunks', 'readEmbeddingCompletion', 'setPageEmbeddingSignature'],
  }, async (engine) => {
    const { pageId, ids } = await seed(engine, 'notes/complete');
    const unstamped = await completion(engine, pageId, ids);
    await engine.setPageEmbeddingSignature('notes/complete', { signature: SIGNATURE });
    const stamped = await completion(engine, pageId, ids);
    const otherSignature = await completion(engine, pageId, ids, 'model-b:768', 'model-b');
    const noModel = await completion(engine, pageId, ids, SIGNATURE, null);
    const missing = await engine.readEmbeddingCompletion(987654321, { signature: SIGNATURE, model: 'model-a', column: COLUMN, manifest: true });
    const row = (index: number, chunk_text: string, embedded: boolean, stamped: boolean | null) =>
      ({ index, chunk_text, chunk_source: 'compiled_truth', embedding_input_hash: null, embedded, stamped });
    const answers = { unstamped, stamped, otherSignature, noModel, missing };
    expect(answers).toEqual({
      unstamped: [row(0, 'alpha', true, null), row(1, 'beta', false, null), row(2, 'gamma', false, null)],
      stamped: [row(0, 'alpha', true, true), row(1, 'beta', false, true), row(2, 'gamma', false, true)],
      otherSignature: [row(0, 'alpha', false, false), row(1, 'beta', false, false), row(2, 'gamma', true, false)],
      noModel: [row(0, 'alpha', false, true), row(1, 'beta', false, true), row(2, 'gamma', false, true)],
      missing: [],
    });
    return answers;
  });

  parityTest('installChunkEmbeddings stores a vector only on the chunk that still holds the row\'s text', {
    methods: ['putPage', 'sealChunks', 'getPage', 'getChunks', 'readEmbeddingCompletion', 'installChunkEmbeddings'],
  }, async (engine) => {
    const { pageId, ids } = await seed(engine, 'notes/install');
    await engine.installChunkEmbeddings(pageId, COLUMN, JSON.stringify([
      { id: ids[1], chunk_text: 'beta', embedding: vectorText(basisEmbedding(5)), image: null, model: 'model-a', input_hash: 'hash-beta' },
      { id: ids[2], chunk_text: 'gamma changed', embedding: vectorText(basisEmbedding(6)), image: null, model: 'model-a', input_hash: 'hash-gamma' },
      { id: ids[0], chunk_text: 'alpha', embedding: vectorText(basisEmbedding(7)), image: null, model: null, input_hash: 'hash-alpha' },
    ]));
    const after = await completion(engine, pageId, ids);
    const vectors = (await engine.getChunks('notes/install', { includeEmbedding: true, includeUnsealed: true }))
      .map(c => ({ index: c.chunk_index, axis: c.embedding ? Array.from(c.embedding).indexOf(1) : null }));
    const row = (index: number, chunk_text: string, hash: string | null, embedded: boolean) =>
      ({ index, chunk_text, chunk_source: 'compiled_truth', embedding_input_hash: hash, embedded, stamped: null });
    const answers = { after, vectors };
    expect(answers).toEqual({
      after: [row(0, 'alpha', 'hash-alpha', true), row(1, 'beta', 'hash-beta', true), row(2, 'gamma', null, false)],
      vectors: [{ index: 0, axis: 7 }, { index: 1, axis: 5 }, { index: 2, axis: 3 }],
    });
    return answers;
  });

  parityTest('lockEffectClaimRow reads no claim for an effect that does not exist; lockEmbeddingSwitch takes the switch', {
    methods: ['lockEffectClaimRow', 'lockEmbeddingSwitch', 'transaction'],
  }, async (engine) => {
    const answers = await engine.transaction(async tx => {
      const switched = await tx.lockEmbeddingSwitch();
      return { claim: await tx.lockEffectClaimRow(987654321), switched: switched ?? null };
    });
    expect(answers).toEqual({ claim: null, switched: null });
    return answers;
  });
});
