/**
 * A4 / T32: vector validity follows chunk content and full embedding-input
 * provenance, not the page revision; rebuilds keep shifted chunks' vectors.
 *
 * Authoring gate. (1) Contract: a late embed of a live page commits the vectors
 * of chunks the page still holds unchanged (an append during a long embed
 * converges) and drops vectors whose chunk left or whose captured input (title,
 * synopsis body hash) no longer matches; completion stamps follow only a
 * complete install; a projection rebuild after a top insert keeps the vector
 * of every chunk it only shifted. (2) Regressions: revision-bound discard of a
 * whole run, committing a title- or synopsis-stale vector, stamping a signature
 * over unembedded new chunks, index-keyed vector loss. (3) Existing tests pin
 * refusal on model/source/deletion changes and same-index preservation, not
 * these. (4) No production seam.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ChunkInput } from '../src/core/types.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { installPageEmbeddings, installPageProjection, preparePageProjection, queuePageProjection, readProjectionSnapshot,
  rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const sourceId = 'content-validity-test';
const slug = 'notes/live-thread-alice-example';

for (const kind of testBackends()) {
  describe(`A4 content-keyed vector validity (${kind})`, () => {
    let engine: BrainEngine;
    let closePostgres: (() => Promise<void>) | undefined;
    let dims = 0;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close: closePostgres } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
      const [row] = await engine.executeRaw<{ dim: number }>(
        `SELECT atttypmod AS dim FROM pg_attribute WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding' AND attnum > 0`);
      dims = Number(row!.dim);
    }, 120_000);
    beforeEach(async () => { await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [sourceId]); });
    afterEach(async () => { await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]); });
    afterAll(async () => { if (kind === 'pglite') await engine.disconnect(); await closePostgres?.(); });

    const vec = (seed: number) => { const v = new Float32Array(dims); v[seed % dims] = 0.5; v[(seed + 1) % dims] = -0.25; return v; };
    const vecText = (seed: number) => `[${Array.from(vec(seed)).join(',')}]`;
    const fixture = (texts: string[]): ChunkInput[] => texts.map((chunk_text, chunk_index) => ({ chunk_index, chunk_text, chunk_source: 'compiled_truth' }));
    const A = 'Message from alice-example at 9:00 about the launch.';
    const B = 'Reply from charlie-example at 9:05 with the agenda.';
    const C = 'Appended message from alice-example at 9:30.';

    async function write(texts: string[], opts: { title?: string; mode?: string | null; generation?: string | null } = {}) {
      await engine.putPage(slug, { type: 'note', title: opts.title ?? 'Live thread', compiled_truth: texts.join('\n\n'), frontmatter: {} }, { sourceId });
      await installFixtureChunks(engine, slug, fixture(texts), { sourceId });
      if (opts.mode !== undefined) await engine.updatePageContextualRetrievalState(slug, sourceId, opts.mode as never, opts.generation ?? null);
    }
    async function vectors() {
      return engine.executeRaw<{ chunk_text: string; embedding: string | null; embedding_input_hash: string | null; embedded_text_hash: string | null; text_md5: string }>(
        `SELECT cc.chunk_text, cc.embedding::text AS embedding, cc.embedding_input_hash, cc.embedded_text_hash, md5(cc.chunk_text) AS text_md5
         FROM content_chunks cc JOIN pages p ON p.id=cc.page_id WHERE p.source_id=$1 AND p.slug=$2 ORDER BY cc.chunk_index`, [sourceId, slug]);
    }
    const signatureOf = async () => (await engine.executeRaw<{ s: string | null }>(
      'SELECT embedding_signature AS s FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0]?.s ?? null;
    const offer = (prepared: NonNullable<Awaited<ReturnType<typeof readProjectionSnapshot>>>) =>
      prepared.chunks.map((c, i) => ({ chunk_index: c.chunk_index, chunk_text: c.chunk_text, chunk_source: c.chunk_source, embedding: vec(i) }));

    test('an append during the embed commits the vectors of the unchanged chunks; the new chunk waits and no signature lands', async () => {
      await write([A, B]);
      const prepared = (await readProjectionSnapshot(engine, slug, sourceId))!;
      await write([A, B, C]);
      expect(await installPageEmbeddings(engine, prepared, offer(prepared), 'test:model:8')).toEqual({ installed: 2, complete: false });
      const rows = await vectors();
      expect(rows.map(r => [r.chunk_text, r.embedding])).toEqual([[A, vecText(0)], [B, vecText(1)], [C, null]]);
      for (const row of rows.slice(0, 2)) {
        expect(row.embedded_text_hash).toBe(row.text_md5);
        expect(row.embedding_input_hash).not.toBeNull();
      }
      expect(await signatureOf()).toBeNull();
    });

    test('a chunk that moved to another index still receives its vector', async () => {
      await write([A, B]);
      const prepared = (await readProjectionSnapshot(engine, slug, sourceId))!;
      await write([C, A, B]);
      expect(await installPageEmbeddings(engine, prepared, offer(prepared))).toEqual({ installed: 2, complete: false });
      expect((await vectors()).map(r => r.embedding)).toEqual([null, vecText(0), vecText(1)]);
    });

    test('a title edit on a title-tier page drops every vector built under the old title', async () => {
      await write([A, B], { mode: 'title' });
      const prepared = (await readProjectionSnapshot(engine, slug, sourceId))!;
      await write([A, B], { title: 'Renamed thread', mode: 'title' });
      expect(await installPageEmbeddings(engine, prepared, offer(prepared))).toEqual({ installed: 0, complete: false });
      expect((await vectors()).map(r => r.embedding)).toEqual([null, null]);
    });

    test('a synopsis vector built over the old body is dropped after an append; with the body unchanged it publishes', async () => {
      await write([A, B], { mode: 'per_chunk_synopsis', generation: 'gen-1' });
      const stale = (await readProjectionSnapshot(engine, slug, sourceId))!;
      await write([A, B, C], { mode: 'per_chunk_synopsis', generation: 'gen-1' });
      const built = { tier: 'per_chunk_synopsis' as const, corpusGeneration: 'gen-2' };
      expect(await installPageEmbeddings(engine, stale, offer(stale), undefined, built)).toEqual({ installed: 0, complete: false });
      expect((await vectors()).map(r => r.embedding)).toEqual([null, null, null]);
      const fresh = (await readProjectionSnapshot(engine, slug, sourceId))!;
      // Same chunks, same title: a frontmatter-only edit moves the revision, not the input.
      await engine.putPage(slug, { type: 'note', title: 'Live thread', compiled_truth: [A, B, C].join('\n\n'), frontmatter: { touched: true } }, { sourceId });
      await installFixtureChunks(engine, slug, fixture([A, B, C]), { sourceId });
      await engine.updatePageContextualRetrievalState(slug, sourceId, 'per_chunk_synopsis', 'gen-1');
      expect(await installPageEmbeddings(engine, fresh, offer(fresh), undefined, built)).toEqual({ installed: 3, complete: true });
      expect((await vectors()).map(r => r.embedding)).toEqual([vecText(0), vecText(1), vecText(2)]);
    });

    test('a projection rebuild after a top insert keeps the vector of every chunk it only shifted', async () => {
      const paragraph = (i: number) => `## 2024-03-${String(1 + (i % 28)).padStart(2, '0')}\n\n` + Array.from({ length: 16 },
        (_, line) => `**alice-example** (2024-03-15 1:0${line % 10} PM): message ${i}.${line} about acme-example plans and next steps for the launch review.`).join('\n');
      const body = Array.from({ length: 40 }, (_, i) => paragraph(i)).join('\n\n');
      await engine.putPage(slug, { type: 'note', title: 'Live thread', compiled_truth: body, frontmatter: {} }, { sourceId });
      const unsealed = (await readProjectionSnapshot(engine, slug, sourceId, { allowUnsealed: true }))!;
      await installPageProjection(engine, unsealed, (await preparePageProjection(unsealed)).chunks, { seal: true });
      const prepared = (await readProjectionSnapshot(engine, slug, sourceId))!;
      expect(prepared.chunks.length).toBeGreaterThan(10);
      expect((await installPageEmbeddings(engine, prepared, offer(prepared))).complete).toBe(true);
      const before = new Map((await vectors()).map(r => [r.chunk_text, r.embedding]));

      await engine.putPage(slug, { type: 'note', title: 'Live thread', compiled_truth: `${paragraph(99)}\n\n${body}`, frontmatter: {} }, { sourceId });
      await queuePageProjection(engine, sourceId, slug, 'test_top_insert');
      expect(await rebuildPendingPageProjections(engine, 10)).toEqual({ rebuilt: 1, superseded: 0 });
      const after = await vectors();
      const shifted = after.filter(r => before.has(r.chunk_text));
      expect(shifted.length).toBeGreaterThanOrEqual(prepared.chunks.length - 2);
      for (const row of shifted) expect(row.embedding).toBe(before.get(row.chunk_text)!);
      expect(after.filter(r => r.embedding === null).length).toBe(after.length - shifted.length);
    }, 60_000);
  });
}
