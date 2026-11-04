import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { countFalseStampedChunks, measureRestampOnlyChunks, invalidateStaleSignatureEmbeddingsGuarded } from '../src/core/embedding-invalidation.ts';
import { installPageProjection, preparePageProjection, readProjectionSnapshot, continueDeferredProjection } from '../src/core/page-state/projections.ts';

const sourceId = 'legacy-label';
const slug = 'notes/cedar';
const model = 'openai:text-embedding-3-large';
const bare = 'text-embedding-3-large';

for (const kind of testBackends()) describe(`#8533 legacy model labels ${kind}`, () => {
  let engine: BrainEngine;
  let close: (() => Promise<void>) | undefined;
  let dims: number;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    const [row] = await engine.executeRaw<{ dim: number }>("SELECT atttypmod AS dim FROM pg_attribute WHERE attrelid='content_chunks'::regclass AND attname='embedding'");
    dims = Number(row.dim);
  }, 120_000);
  afterAll(async () => { if (kind === 'pglite') await engine.disconnect(); await close?.(); });
  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [sourceId]);
    await engine.setConfig('embedding_model', model);
  });
  async function seed(label = bare) {
    await engine.putPage(slug, { type: 'note', title: 'Cedar', compiled_truth: 'Synthetic cedar memory.' }, { sourceId });
    const prepared = (await readProjectionSnapshot(engine, slug, sourceId, { allowUnsealed: true }))!;
    const { chunks } = await preparePageProjection(prepared);
    await installFixtureChunks(engine, slug, chunks.map(c => ({ ...c, embedding: new Float32Array(dims).fill(0.1), model })), { sourceId });
    await engine.executeRaw(`UPDATE content_chunks SET model=$2,embedding_input_hash=NULL,embedded_text_hash=md5(chunk_text) WHERE page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$3)`, [sourceId, label, slug]);
    return chunks;
  }
  async function rows() {
    return engine.executeRaw<{ id: number; has: boolean; pending: boolean; model: string; chunk_index: number }>(`SELECT cc.id,cc.embedding IS NOT NULL AS has,cc.embedding_pending_since IS NOT NULL AS pending,cc.model,cc.chunk_index FROM content_chunks cc JOIN pages p ON p.id=cc.page_id WHERE p.source_id=$1 ORDER BY chunk_index`, [sourceId]);
  }
  for (const guarded of [false, true]) for (const nullSignature of [false, true]) {
    test(`restamps a compatible bare label without vector loss (guarded=${guarded}, null=${nullSignature})`, async () => {
      const chunks = await seed();
      if (!nullSignature) await engine.setPageEmbeddingSignature(slug, { sourceId, signature: 'old:model:1' });
      const opts = { signature: `${model}:${dims}`, sourceId, includeNullSignature: nullSignature };
      const estimate = await measureRestampOnlyChunks(engine, opts);
      const before = await rows();
      expect(await (guarded ? invalidateStaleSignatureEmbeddingsGuarded(engine, opts) : engine.invalidateStaleSignatureEmbeddings(opts))).toBe(0);
      expect(await rows()).toEqual(before);
      expect(estimate).toEqual({ chunks: chunks.length, chars: chunks.reduce((n, c) => n + c.chunk_text.length, 0) });
      const [page] = await engine.executeRaw<{ embedding_signature: string | null }>('SELECT embedding_signature FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
      // The low-level engine primitive only invalidates; the guarded entry also restamps.
      expect(page.embedding_signature).toBe(guarded ? opts.signature : nullSignature ? null : 'old:model:1');
      expect(await countFalseStampedChunks(engine, model, dims)).toEqual({ pages: 0, chunks: 0, chars: 0 });
    }, 30_000);
  }
  for (const deferred of [false, true]) test(`projection preserves legacy vectors (deferred=${deferred})`, async () => {
    await seed();
    const before = await rows();
    if (deferred) {
      await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE source_id=$1', [sourceId]);
      expect(await continueDeferredProjection(engine, sourceId, slug)).toBe('sealed');
    } else {
      const prepared = (await readProjectionSnapshot(engine, slug, sourceId))!;
      await installPageProjection(engine, prepared, (await preparePageProjection(prepared)).chunks, { seal: true, preserveEmbeddings: true });
    }
    expect(await rows()).toEqual(before);
  }, 30_000);
  for (const label of ['other:text-embedding-3-large', 'other-model']) test(`never aliases an explicit foreign model ${label}`, async () => {
    await seed(label);
    expect(await invalidateStaleSignatureEmbeddingsGuarded(engine, { signature: `${model}:${dims}`, sourceId, includeNullSignature: true })).toBe(1);
    expect((await rows()).every(r => !r.has && r.pending)).toBe(true);
  }, 30_000);
  for (const deferred of [false, true]) test(`a moved legacy chunk retains its row and vector (deferred=${deferred})`, async () => {
    await seed();
    // A prior projection placed the unchanged text at another ordinal.
    await engine.executeRaw('UPDATE content_chunks SET chunk_index=1 WHERE page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$2)', [sourceId, slug]);
    const [before] = await rows();
    if (deferred) {
      await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE source_id=$1', [sourceId]);
      expect(await continueDeferredProjection(engine, sourceId, slug)).toBe('sealed');
    } else {
      const prepared = (await readProjectionSnapshot(engine, slug, sourceId, { allowUnsealed: true }))!;
      await installPageProjection(engine, prepared, (await preparePageProjection(prepared)).chunks, { seal: true, preserveEmbeddings: true });
    }
    const retained = (await rows()).find(r => r.id === before.id)!;
    expect(retained).toBeDefined();
    expect(retained.has).toBe(true);
    expect(retained.chunk_index).not.toBe(before.chunk_index);
  }, 30_000);
  for (const deferred of [false, true]) test(`a legacy label cannot retain unproven contextual input (deferred=${deferred})`, async () => {
    await seed();
    await engine.updatePageContextualRetrievalState(slug, sourceId, 'title', null);
    if (deferred) {
      await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE source_id=$1', [sourceId]);
      expect(await continueDeferredProjection(engine, sourceId, slug)).toBe('sealed');
    } else {
      const prepared = (await readProjectionSnapshot(engine, slug, sourceId))!;
      await installPageProjection(engine, prepared, (await preparePageProjection(prepared)).chunks, { seal: true, preserveEmbeddings: true });
    }
    expect((await rows()).every(r => !r.has && r.pending)).toBe(true);
  }, 30_000);
  for (const badHash of [false, true]) test(`legacy spelling does not bypass ${badHash ? 'text-hash' : 'dimension'} proof`, async () => {
    await seed();
    if (badHash) await engine.executeRaw('UPDATE content_chunks SET embedded_text_hash=NULL WHERE page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$2)', [sourceId, slug]);
    const signature = `${model}:${badHash ? dims : dims + 1}`;
    expect(await measureRestampOnlyChunks(engine, { signature, sourceId, includeNullSignature: true })).toEqual({ chunks: 0, chars: 0 });
    expect(await invalidateStaleSignatureEmbeddingsGuarded(engine, { signature, sourceId, includeNullSignature: true })).toBe(1);
  }, 30_000);
});
