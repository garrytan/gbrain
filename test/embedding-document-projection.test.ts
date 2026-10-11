import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { digest, sha256 } from '../src/core/persistence/digest.ts';
import { reconcileContextualEmbeddingInputs } from '../src/core/page-state/contextual-proof.ts';
import { installPageEmbeddings, installPageProjection, preparePageProjection, queuePageProjection,
  readProjectionSnapshot, rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';

const sourceId = 'embedding-document-projection-test';
const slug = 'notes/cedar';
const model = 'ollama:embeddinggemma:latest';
const body = 'Synthetic cedar notes about alpine lakes.\n\nA second paragraph describes granite ridges.';
const timeline = '2026-01-02: A synthetic cedar event.';

function vector(seed: number): Float32Array {
  const values = new Float32Array(1536);
  values[0] = seed;
  return values;
}

function legacyHash(chunkText: string, dimensions: number): string {
  return digest(['embedding-input-v1', 'embedding', model, dimensions, 'none', null, sha256(chunkText)]);
}

describe('formatted embedding projection proof', () => {
  let engine: BrainEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 120_000);
  beforeEach(async () => {
    configureGateway({ embedding_model: model, embedding_dimensions: 1536, env: { OLLAMA_API_KEY: 'test' } });
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [sourceId]);
  });
  afterEach(async () => {
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
    resetGateway();
  });
  afterAll(async () => { await engine.disconnect(); });

  async function seed() {
    await engine.putPage(slug, { type: 'note', title: 'Cedar notes', compiled_truth: body, timeline,
      frontmatter: {}, source_path: 'notes/cedar.md' }, { sourceId });
    const prepared = (await readProjectionSnapshot(engine, slug, sourceId, { allowUnsealed: true }))!;
    const chunks = (await preparePageProjection(prepared)).chunks;
    await installPageProjection(engine, prepared, chunks, { seal: true });
    return (await readProjectionSnapshot(engine, slug, sourceId))!;
  }

  async function embedAll() {
    const prepared = (await readProjectionSnapshot(engine, slug, sourceId))!;
    const chunks = prepared.chunks.map(chunk => ({ chunk_index: chunk.chunk_index, chunk_text: chunk.chunk_text,
      chunk_source: chunk.chunk_source, embedding: vector(chunk.chunk_index + 1) }));
    expect(await installPageEmbeddings(engine, prepared, chunks)).toBe(true);
  }

  async function vectors() {
    return engine.executeRaw<{ chunk_index: number; has: boolean; hash: string | null }>(
      `SELECT chunk_index,embedding IS NOT NULL AS has,embedding_input_hash AS hash FROM content_chunks
       WHERE page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$2) ORDER BY chunk_index`, [sourceId, slug]);
  }

  async function rebuild() {
    await queuePageProjection(engine, sourceId, slug, 'test_rebuild');
    expect(await rebuildPendingPageProjections(engine, 10)).toEqual({ rebuilt: 1, superseded: 0 });
  }

  test('projection rebuild rejects missing and v1 proof, keeps valid v2, and invalidates it after a title edit', async () => {
    const prepared = await seed();
    await embedAll();
    const current = await vectors();
    expect(current).toHaveLength(2);
    await engine.executeRaw('UPDATE content_chunks SET embedding_input_hash=NULL WHERE page_id=$1 AND chunk_index=0', [prepared.snapshot.page.id]);
    await engine.executeRaw('UPDATE content_chunks SET embedding_input_hash=$2 WHERE page_id=$1 AND chunk_index=1',
      [prepared.snapshot.page.id, legacyHash(prepared.chunks[1]!.chunk_text, prepared.embeddingColumn.dimensions)]);
    await rebuild();
    expect((await vectors()).map(row => [row.has, row.hash])).toEqual([[false, null], [false, null]]);

    await embedAll();
    const stamped = await vectors();
    expect(stamped.every(row => row.has && row.hash)).toBe(true);
    await rebuild();
    expect(await vectors()).toEqual(stamped);

    await engine.putPage(slug, { type: 'note', title: 'Renamed cedar notes', compiled_truth: body, timeline,
      frontmatter: {}, source_path: 'notes/cedar.md' }, { sourceId });
    await rebuild();
    expect((await vectors()).every(row => !row.has && row.hash === null)).toBe(true);
  });

  test('contextual reconciliation clears missing and v1 proof without backfilling either as v2', async () => {
    const prepared = await seed();
    await embedAll();
    await engine.executeRaw('UPDATE content_chunks SET embedding_input_hash=NULL WHERE page_id=$1 AND chunk_index=0', [prepared.snapshot.page.id]);
    await engine.executeRaw('UPDATE content_chunks SET embedding_input_hash=$2 WHERE page_id=$1 AND chunk_index=1',
      [prepared.snapshot.page.id, legacyHash(prepared.chunks[1]!.chunk_text, prepared.embeddingColumn.dimensions)]);
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const stale = await engine.transaction(tx => reconcileContextualEmbeddingInputs(tx, snapshot, 'none', null));
    expect(stale).toBe(2);
    expect((await vectors()).map(row => [row.has, row.hash])).toEqual([[false, null], [false, null]]);

    await embedAll();
    expect(await engine.transaction(tx => reconcileContextualEmbeddingInputs(tx, snapshot, 'none', null))).toBe(0);
    expect((await vectors()).every(row => row.has && row.hash)).toBe(true);
  });

  test('unaffected models keep null-mode vectors and retain legacy backfill behavior', async () => {
    resetGateway();
    configureGateway({ embedding_model: 'ollama:nomic-embed-text', embedding_dimensions: 1536, env: { OLLAMA_API_KEY: 'test' } });
    const prepared = await seed();
    await embedAll();
    await engine.executeRaw('UPDATE content_chunks SET embedding_input_hash=NULL WHERE page_id=$1', [prepared.snapshot.page.id]);
    await rebuild();
    expect((await vectors()).map(row => row.has)).toEqual([true, true]);
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
    expect(await engine.transaction(tx => reconcileContextualEmbeddingInputs(tx, snapshot, 'none', null))).toBe(0);
    expect((await vectors()).every(row => row.has && row.hash)).toBe(true);
  });
});
