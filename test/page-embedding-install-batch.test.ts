/**
 * installPageEmbeddings per-chunk semantics: each chunk's vector, image,
 * model, input hash and embedded stamps, on PGLite and (with DATABASE_URL) an
 * isolated Postgres database.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { installPageEmbeddings, installPageProjection, preparePageProjection, readProjectionSnapshot } from '../src/core/page-state/projections.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const sourceId = 'embedding-batch-test';
const slug = 'batch-page';
const vector = (head: number) => { const v = new Float32Array(1536); v[0] = head; v[1] = -0.5; return v; };
const text = (v: Float32Array) => `[${Array.from(v).join(',')}]`;
const image = new Float32Array(1024); image[0] = 0.75;

interface Row { chunk_index: number; chunk_text: string; embedding: string | null; embedding_image: string | null; model: string;
  embedded_at: string | null; embedded_text_hash: string | null; embedding_input_hash: string | null; text_md5: string }

for (const kind of testBackends()) {
  describe(`embedding install per chunk (${kind})`, () => {
    let engine: BrainEngine;
    let closePostgres: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close: closePostgres } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    }, 120_000);
    beforeEach(async () => {
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [sourceId]);
      await engine.putPage(slug, { type: 'note', title: 'Batch fixture', compiled_truth: 'Synthetic body for batched vectors.',
        timeline: '2026-01-02: Synthetic event.', frontmatter: {} }, { sourceId });
      await seal();
    });
    afterEach(async () => { await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]); });
    afterAll(async () => { if (kind === 'pglite') await engine.disconnect(); await closePostgres?.(); });

    const rows = async () => engine.executeRaw<Row>(`SELECT cc.chunk_index,cc.chunk_text,cc.embedding::text AS embedding,cc.embedding_image::text AS embedding_image,
        cc.model,cc.embedded_at::text AS embedded_at,cc.embedded_text_hash,cc.embedding_input_hash,md5(cc.chunk_text) AS text_md5
      FROM content_chunks cc JOIN pages p ON p.id=cc.page_id WHERE p.source_id=$1 AND p.slug=$2 ORDER BY cc.chunk_index`, [sourceId, slug]);
    const seal = async () => {
      const prepared = (await readProjectionSnapshot(engine, slug, sourceId, { allowUnsealed: true }))!;
      await installPageProjection(engine, prepared, (await preparePageProjection(prepared)).chunks, { seal: true });
    };
    const capture = async () => {
      const prepared = (await readProjectionSnapshot(engine, slug, sourceId))!;
      const { chunks } = await preparePageProjection(prepared);
      return { prepared, chunks };
    };

    test('a partially refused batch writes only the chunks that came back and leaves the others untouched', async () => {
      const { prepared, chunks } = await capture();
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      const before = await rows();
      expect((await installPageEmbeddings(engine, prepared, chunks.map((c, i) => i === 0 ? { ...c, embedding: vector(0.25) } : c))).complete).toBe(true);
      const after = await rows();
      expect(after[0]!.embedding).toBe(text(vector(0.25)));
      expect(after[0]!.embedded_text_hash).toBe(after[0]!.text_md5);
      expect(after[0]!.embedded_at).not.toBeNull();
      expect(after[0]!.embedding_input_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(after[0]!.model).toBe(prepared.embeddingModel!);
      expect(after.slice(1)).toEqual(before.slice(1));
    });

    test('an image-only chunk keeps its text vector, input hash and model and gains the image and stamps', async () => {
      const { prepared, chunks } = await capture();
      expect((await installPageEmbeddings(engine, prepared, chunks.map(c => ({ ...c, embedding: vector(0.5), model: 'test:text-model' })))).complete).toBe(true);
      const withText = await rows();
      const again = await capture();
      expect((await installPageEmbeddings(engine, again.prepared, again.chunks.map((c, i) => i === 1 ? { ...c, embedding_image: image } : c))).complete).toBe(true);
      const after = await rows();
      expect(after[0]).toEqual(withText[0]!);
      expect(after[1]!.embedding).toBe(withText[1]!.embedding);
      expect(after[1]!.embedding_input_hash).toBe(withText[1]!.embedding_input_hash);
      expect(after[1]!.model).toBe('test:text-model');
      expect(after[1]!.embedding_image).toBe(text(image));
      expect(after[1]!.embedded_text_hash).toBe(after[1]!.text_md5);
    });

    test('every chunk in one call gets its own vector, model and input hash', async () => {
      const { prepared, chunks } = await capture();
      expect((await installPageEmbeddings(engine, prepared, chunks.map((c, i) => ({ ...c, embedding: vector(0.125 * (i + 1)), model: `test:model-${i}` })))).complete).toBe(true);
      const after = await rows();
      expect(after.map(r => r.embedding)).toEqual(chunks.map((_, i) => text(vector(0.125 * (i + 1)))));
      expect(after.map(r => r.model)).toEqual(chunks.map((_, i) => `test:model-${i}`));
      expect(new Set(after.map(r => r.embedding_input_hash)).size).toBe(after.length);
      for (const row of after) expect(row.embedded_text_hash).toBe(row.text_md5);
    });

    test('a delayed install against a changed page writes only the chunks the page still holds unchanged (A4)', async () => {
      const { prepared, chunks } = await capture();
      await engine.putPage(slug, { type: 'note', title: 'Batch fixture', compiled_truth: 'A newer body replaced the captured one.',
        timeline: '2026-01-02: Synthetic event.', frontmatter: {} }, { sourceId });
      await seal();
      const before = await rows();
      const captured = new Set(chunks.map(c => c.chunk_text));
      const unchanged = before.filter(r => captured.has(r.chunk_text));
      expect(unchanged.length).toBeGreaterThan(0);
      expect(unchanged.length).toBeLessThan(before.length);
      expect(await installPageEmbeddings(engine, prepared, chunks.map(c => ({ ...c, embedding: vector(0.75) }))))
        .toEqual({ installed: chunks.filter(c => before.some(r => r.chunk_text === c.chunk_text)).length, complete: false });
      const after = await rows();
      after.forEach((row, i) => {
        if (!captured.has(row.chunk_text)) return expect(row).toEqual(before[i]!);
        expect(row.embedding).toBe(text(vector(0.75)));
        expect(row.embedded_text_hash).toBe(row.text_md5);
        expect(row.embedding_input_hash).not.toBeNull();
      });
    });
  });
}
