/** #7182: correcting builtin embedding dimensions must not discard proven legacy vectors. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { embeddingInputHash, acceptedEmbeddingInputHashes } from '../src/core/embedding-input-hash.ts';
import { canReuseMarkdownVector } from '../src/core/embed-reuse.ts';
import { reconcileContextualEmbeddingInputs } from '../src/core/page-state/contextual-proof.ts';
import { embeddingInputContext, embeddingWriteTarget, readProjectionSnapshot, preparePageProjection,
  installPageProjection, installPageEmbeddings } from '../src/core/page-state/projections.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const model = 'openai:text-embedding-3-large';
const sourceId = 'dimension-provenance';
const slug = 'notes/cedar';
const markdown = '---\ntitle: Cedar notes\ntype: note\n---\n\nA synthetic cedar note about alpine lakes and granite ridges.\n';
const context = { column: 'embedding', model, dimensions: 1024, title: 'Cedar notes', corpusGeneration: null, bodyHash: '' };
const chunk = { chunk_text: 'A synthetic cedar note.', chunk_source: 'compiled_truth', model, embedding: new Float32Array(1024) };
const legacy = embeddingInputHash({ ...context, dimensions: 1536 }, 'title', chunk);

describe('#7182 legacy placeholder proof', () => {
  test('a builtin placeholder hash is reusable only with the actual current vector width', () => {
    expect(canReuseMarkdownVector(legacy, 'title', 'title', context, chunk)).toBe(true);
    expect(canReuseMarkdownVector(legacy, 'title', 'title', context, { ...chunk, embedding: new Float32Array(1536) })).toBe(false);
    expect(acceptedEmbeddingInputHashes(context, 'title', chunk, 1024)).toContain(legacy);
    expect(acceptedEmbeddingInputHashes(context, 'title', chunk)).not.toContain(legacy);
  });
  test('legacy compatibility does not forgive changed input, model, column or a different old dimension', () => {
    for (const change of [{ title: 'Other title' }, { model: 'openai:other' }, { column: 'embedding_other' }]) {
      expect(canReuseMarkdownVector(legacy, 'title', 'title', { ...context, ...change }, chunk)).toBe(false);
    }
    const otherWidth = embeddingInputHash({ ...context, dimensions: 768 }, 'title', chunk);
    expect(canReuseMarkdownVector(otherWidth, 'title', 'title', context, chunk)).toBe(false);
    expect(canReuseMarkdownVector(legacy, 'title', 'none', context, chunk)).toBe(false);
  });
  test('legacy synopsis proof still binds body and corpus generation; plain vectors remain a valid mixed tier', () => {
    const synopsis = { ...context, corpusGeneration: 'generation-1', bodyHash: 'body-1' };
    const hash = embeddingInputHash({ ...synopsis, dimensions: 1536 }, 'per_chunk_synopsis', chunk);
    expect(acceptedEmbeddingInputHashes(synopsis, 'per_chunk_synopsis', chunk, 1024)).toContain(hash);
    expect(acceptedEmbeddingInputHashes(synopsis, 'per_chunk_synopsis', chunk, 1024)).toContain(legacy);
    for (const change of [{ bodyHash: 'body-2' }, { corpusGeneration: 'generation-2' }]) {
      expect(acceptedEmbeddingInputHashes({ ...synopsis, ...change }, 'per_chunk_synopsis', chunk, 1024)).not.toContain(hash);
    }
  });
});

for (const backend of testBackends()) describe(`#7182 dimension transition (${backend})`, () => {
  let engine: BrainEngine;
  let close: (() => Promise<void>) | undefined;
  let providerCalls = 0;
  beforeAll(async () => {
    configureGateway({ embedding_model: model, embedding_dimensions: 1024, env: { OPENAI_API_KEY: 'synthetic-test-key' } });
    if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    // Isolated fixture only: use the real physical width of the affected brain.
    await engine.executeRaw('DROP INDEX IF EXISTS idx_chunks_embedding');
    await engine.executeRaw('ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(1024)');
    await engine.setConfig('embedding_model', model);
    await engine.setConfig('embedding_dimensions', '1024');
    __setEmbedTransportForTests((async (args: { values: string[] }) => {
      providerCalls++;
      return { embeddings: args.values.map(() => { const v = new Array(1024).fill(0); v[0] = 1; return v; }) };
    }) as never);
  }, 120_000);
  beforeEach(async () => {
    providerCalls = 0;
    await engine.setConfig('embedding_dimensions', '1024');
    await engine.executeRaw('INSERT INTO sources(id,name,contextual_retrieval_mode) VALUES ($1,$1,$2)', [sourceId, 'title']);
    await engine.executeRaw("DELETE FROM config WHERE key IN ('embedding_columns','search_embedding_column')");
  });
  afterEach(async () => { await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]); });
  afterAll(async () => {
    __setEmbedTransportForTests(null);
    resetGateway();
    if (backend === 'pglite') await engine.disconnect();
    await close?.();
  });
  const records = () => engine.executeRaw<{ id: number; hash: string; width: number; vector: string }>(
    `SELECT c.id,c.embedding_input_hash AS hash,vector_dims(c.embedding) AS width,c.embedding::text AS vector
     FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1 AND p.slug=$2 ORDER BY c.chunk_index`, [sourceId, slug]);
  const register = () => engine.setConfig('embedding_columns', JSON.stringify({ embedding: { provider: model, dimensions: 1024, type: 'vector' } }));
  async function seedLegacy() {
    await importFromContent(engine, slug, markdown, { sourceId });
    const target = await embeddingWriteTarget(engine);
    const page = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const chunks = await engine.getChunks(slug, { sourceId, includeEmbedding: true });
    const provenance = embeddingInputContext(target, page.page.title, null, chunks);
    for (const c of chunks) await engine.executeRaw('UPDATE content_chunks SET embedding_input_hash=$2 WHERE id=$1',
      [c.id, embeddingInputHash({ ...provenance, dimensions: 1536 }, 'title', c)]);
    return records();
  }
  test('new imports and late embedding installs stamp 1024, not the engine cast placeholder', async () => {
    await importFromContent(engine, slug, markdown, { sourceId });
    const target = await embeddingWriteTarget(engine);
    expect(target.column.dimensions).toBe(1024);
    const prepared = (await readProjectionSnapshot(engine, slug, sourceId))!;
    const provenance = embeddingInputContext(target, prepared.snapshot.page.title, null, prepared.chunks);
    const stored = await records();
    expect(stored.length).toBeGreaterThan(0);
    for (const [i, c] of prepared.chunks.entries()) expect(stored[i].hash).toBe(embeddingInputHash({ ...provenance, dimensions: 1024 }, 'title', c));
    const result = await installPageEmbeddings(engine, prepared, prepared.chunks.map(c => ({
      chunk_index: c.chunk_index, chunk_text: c.chunk_text, chunk_source: c.chunk_source,
      embedding: chunk.embedding, model,
    })));
    expect(result.complete).toBe(true);
    expect((await records()).map(c => c.hash)).toEqual(stored.map(c => c.hash));
  });
  test('registering the builtin column preserves legacy vectors through a projection rebuild and import', async () => {
    const before = await seedLegacy();
    await register();
    const prepared = (await readProjectionSnapshot(engine, slug, sourceId))!;
    const next = await preparePageProjection(prepared);
    await installPageProjection(engine, prepared, next.chunks, { seal: true, preserveEmbeddings: true });
    expect(await records()).toEqual(before);
    const calls = providerCalls;
    const edited = markdown.replace('type: note', 'type: note\ntags: [updated]');
    await importFromContent(engine, slug, edited, { sourceId });
    const after = await records();
    expect(after).toEqual(before);
    expect(providerCalls).toBe(calls);
    // An unchanged exact-body retry must never make another paid request.
    const afterEdit = providerCalls;
    await importFromContent(engine, slug, edited, { sourceId });
    expect(providerCalls).toBe(afterEdit);
    expect(afterEdit).toBeGreaterThanOrEqual(calls);
  });
  test('a changed title still invalidates legacy contextual vectors after registration', async () => {
    await seedLegacy();
    await register();
    const page = (await engine.getPage(slug, { sourceId }))!;
    await engine.putPage(slug, { ...page, title: 'Different title' }, { sourceId });
    const prepared = (await readProjectionSnapshot(engine, slug, sourceId, { allowUnsealed: true }))!;
    const next = await preparePageProjection(prepared);
    await installPageProjection(engine, prepared, next.chunks, { seal: true, preserveEmbeddings: true });
    expect((await records()).every(c => c.vector === null)).toBe(true);
  });
  test('an import independently reuses legacy vectors without a provider call', async () => {
    const before = await seedLegacy();
    await register();
    const calls = providerCalls;
    await importFromContent(engine, slug, markdown.replace('type: note', 'type: note\ntags: [import-control]'), { sourceId });
    expect(await records()).toEqual(before);
    expect(providerCalls).toBe(calls);
  });
  test('contextual reconciliation preserves the same physical-width-proven legacy vectors', async () => {
    const before = await seedLegacy();
    await register();
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
    expect(await engine.transaction(tx => reconcileContextualEmbeddingInputs(tx, snapshot, 'title', null))).toBe(0);
    expect(await records()).toEqual(before);
  });
  for (const dimensions of [768, 1536]) test(`a real width change to ${dimensions} cannot use the placeholder compatibility lane`, async () => {
    await seedLegacy();
    await engine.setConfig('embedding_dimensions', String(dimensions));
    const prepared = (await readProjectionSnapshot(engine, slug, sourceId))!;
    const next = await preparePageProjection(prepared);
    await installPageProjection(engine, prepared, next.chunks, { seal: true, preserveEmbeddings: true });
    expect((await records()).every(c => c.vector === null)).toBe(true);
  });
});
