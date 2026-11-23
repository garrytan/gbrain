/**
 * BrainEngine parity — batch 6c: a page's chunk reseal (page-state/projections.ts resealSafeChunks and
 * installPageProjection with `seal` and `preserveEmbeddings`, the step `gbrain repair secret-spans` runs right after a
 * rewrite commits). Its keep plan read, vector clear and pending count are the typed members readChunkKeepState,
 * clearUnkeptChunkVectors and countPendingTextChunks (engine-sql/projection-rebuild.ts, served on the Rust store by
 * persistence/projection_rebuild.rs); the row delete, chunker stamp, seal and queue-row delete reuse deleteChunksExcept,
 * setProjectionChunkerVersion, writeTextProjectionSeal and deleteProjectionJob.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite, Postgres (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1) resealing an unsealed page
 *    rebuilds its chunk rows from its body, keeps the vector of each chunk whose text and recorded embedding input are
 *    unchanged and drops the vector of a chunk labelled with another model, seals the page, removes its queue row and
 *    reports the chunks left without a vector; a second call finds the page sealed and does nothing. The three members
 *    answer the same when called directly.
 *  - Regression: the keep read, the vector clear and the pending count ran through `executeRaw`, which a Rust brain
 *    refuses; the reseal stopped there and `repair secret-spans` left the page's projection queued.
 *  - Why existing coverage misses it: test/page-projection-reseal*.test.ts run on PGLite (and Postgres) only.
 *  - Seam: none. Seeding uses typed members only (putPage, upsertChunks); vectors are unit axes, compared by axis.
 *    Row ids differ by engine and are mapped to chunk indexes.
 */
import { describe, expect } from 'bun:test';
import { basisEmbedding, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ResolvedColumn } from '../../src/core/types.ts';
import { embeddingWriteTarget, preparePageProjection, readProjectionSnapshot, resealSafeChunks } from '../../src/core/page-state/projections.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const SLUG = 'notes/reseal-example';
/** Nine headed parts of 120 words each: the chunker cuts this body into several chunks. */
const BODY = Array.from({ length: 9 }, (_, part) => `## Part ${part}\n\n${Array.from({ length: 120 }, (_, i) => `word${part}x${i}`).join(' ')}`).join('\n\n');

/** The page, unsealed, with the chunks the reseal will build from it, each holding a vector (chunk 1 labelled another model). */
async function seedUnsealed(engine: BrainEngine, slug = SLUG) {
  await engine.putPage(slug, { type: 'note' as never, title: 'Reseal Example', compiled_truth: BODY, timeline: '' }, { sourceId: SRC });
  const prepared = await readProjectionSnapshot(engine, slug, SRC, { allowUnsealed: true });
  const { chunks } = await preparePageProjection(prepared!);
  const target = await embeddingWriteTarget(engine);
  await engine.upsertChunks(slug, chunks.map((c, i) => ({ ...c, embedding: basisEmbedding(i), model: i === 1 ? 'other:model' : target.provenanceModel ?? undefined })) as never, { sourceId: SRC });
  return { prepared: prepared!, target, count: chunks.length };
}

/** The page's chunk rows by index with the axis of each vector, and whether the page is sealed. */
async function readRows(engine: BrainEngine, slug = SLUG) {
  const rows = await engine.getChunks(slug, { sourceId: SRC, includeUnsealed: true, includeEmbedding: true } as never);
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: SRC });
  return {
    chunks: rows.map(c => ({ index: c.chunk_index, source: c.chunk_source, text: c.chunk_text.slice(0, 40), axis: c.embedding ? Array.from(c.embedding).indexOf(1) : null })),
    sealed: snapshot!.page.text_projection_revision === snapshot!.revision,
  };
}

describe('engine parity: page chunk reseal', () => {
  parityTest('resealing an unsealed page keeps a current vector, drops a stale one, seals it and counts the embedding work left', {
    methods: ['putPage', 'upsertChunks', 'getChunks', 'readPageSnapshot', 'readChunkKeepState', 'clearUnkeptChunkVectors', 'countPendingTextChunks', 'deleteChunksExcept',
      'setProjectionChunkerVersion', 'writeTextProjectionSeal', 'deleteProjectionJob', 'getPageSealState'],
    timeout: 120_000,
  }, async engine => {
    const { count } = await seedUnsealed(engine);
    expect(count).toBeGreaterThan(2);
    const before = await readRows(engine);
    expect(before.sealed).toBe(false);
    const first = await resealSafeChunks(engine, SLUG, SRC);
    const after = await readRows(engine);
    expect(after.sealed).toBe(true);
    // The vector of chunk 1 (another model) is dropped; every other chunk keeps its own.
    expect(after.chunks.map(c => c.axis)).toEqual(after.chunks.map((_, i) => i === 1 ? null : i));
    expect(first).toMatchObject({ pendingChunks: 1 });
    const second = await resealSafeChunks(engine, SLUG, SRC);
    expect(second).toBeNull();
    return { count, before, first, after, second, again: await readRows(engine) };
  });

  parityTest('readChunkKeepState, clearUnkeptChunkVectors and countPendingTextChunks answer the same when called directly', {
    methods: ['putPage', 'upsertChunks', 'getChunks', 'readPageSnapshot', 'readChunkKeepState', 'clearUnkeptChunkVectors', 'countPendingTextChunks'],
    timeout: 120_000,
  }, async engine => {
    const { prepared, target } = await seedUnsealed(engine);
    const pageId = Number(prepared.snapshot.page.id);
    const column: ResolvedColumn = prepared.embeddingColumn;
    const indexOf = new Map((await engine.getChunks(SLUG, { sourceId: SRC, includeUnsealed: true })).map(c => [Number(c.id), c.chunk_index]));
    const keep = async (model: string | null) => (await engine.readChunkKeepState(pageId, model, column))
      .map(row => ({ index: indexOf.get(Number(row.id)), hash: row.embedding_input_hash, movable: row.movable })).sort((a, b) => a.index! - b.index!);
    const underModel = await keep(target.provenanceModel);
    const underOther = await keep('other:model');
    const underNone = await keep(null);
    const pendingBefore = await engine.countPendingTextChunks(pageId, column);
    // Chunks 0 and 2 stay current; chunk 1 (another model) and any chunk outside the list lose the vector.
    const ids = [...indexOf].filter(([, index]) => index === 0 || index === 2).map(([id]) => id);
    await engine.clearUnkeptChunkVectors(pageId, target.provenanceModel, column, ids);
    const rows = await readRows(engine);
    const pendingAfter = await engine.countPendingTextChunks(pageId, column);
    await engine.clearUnkeptChunkVectors(pageId, target.provenanceModel, column, []);
    const cleared = await readRows(engine);
    const pendingAll = await engine.countPendingTextChunks(pageId, column);
    expect(underModel.map(r => r.movable)).toEqual(underModel.map((_, i) => i !== 1));
    expect(pendingBefore.chunks).toBe(0);
    expect(pendingAfter.chunks).toBe(1);
    return { underModel, underOther, underNone, pendingBefore, rows, pendingAfter, cleared, pendingAll };
  });
});
