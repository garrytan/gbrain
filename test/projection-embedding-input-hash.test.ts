/**
 * #5553: a projection rebuild (the page_projection_jobs drain) and the
 * embed-oversize heal must keep a chunk's vector when its embedding input is
 * unchanged, on contextual-mode pages too. Each vector carries a per-chunk
 * `content_chunks.embedding_input_hash`, written with the vector; a rebuild
 * nulls only chunks whose recomputed hash differs. A chunk written before the
 * column existed (NULL hash) on a contextual page is nulled once, then stamped
 * when it is re-embedded. In per_chunk_synopsis mode any body change nulls every
 * synopsis-tier chunk, while title-tier chunks on the same page keep theirs.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ChunkInput } from '../src/core/types.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { healOversizedPageChunks } from '../src/core/embed-oversize-heal.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { installPageEmbeddings, installPageProjection, preparePageProjection, queuePageProjection,
  readProjectionSnapshot, rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const sourceId = 'input-hash-test';
const slug = 'notes/cedar';
const body = 'Synthetic cedar memory about alpine lakes.\n\nA second paragraph about granite ridges.';
const timeline = '2026-01-02: Synthetic event with exact provenance.';
const SYNOPSIS_GENERATION = 'synopsis-generation-fixture';

function vec(seed: number): Float32Array {
  const v = new Float32Array(1536); v[0] = seed; v[1] = -seed / 2; return v;
}

describe('#5553 embedding input hash is the exact wrapped input', () => {
  test('a title-tier hash matches the plain re-embed wrapper byte for byte, including at the 300-character cap', async () => {
    const { embeddingInputHash } = await import('../src/core/embedding-input-hash.ts');
    const { wrapChunkTextsForStoredMode } = await import('../src/core/embedding-context.ts');
    const chunk = { chunk_text: 'Body text.', chunk_source: 'compiled_truth' };
    const base = { column: 'embedding', model: 'openai:m', dimensions: 1536, corpusGeneration: null, bodyHash: '' };
    const prefix = 'P'.repeat(299);
    const hashes = [`${prefix} more`, prefix].map(title => embeddingInputHash({ ...base, title }, 'title', chunk));
    const inputs = [`${prefix} more`, prefix].map(title => wrapChunkTextsForStoredMode({ title, contextual_retrieval_mode: 'title' }, [chunk])[0]);
    expect(inputs[0]).not.toBe(inputs[1]);
    expect(hashes[0]).not.toBe(hashes[1]);
    // Same input, same hash: the hash covers exactly the bytes sent to the provider.
    expect(embeddingInputHash({ ...base, title: prefix }, 'title', chunk)).toBe(hashes[1]);
  });
});

for (const kind of backends) {
  describe(`#5553 embedding input provenance ${kind}`, () => {
    let engine: BrainEngine;
    let closePostgres: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close: closePostgres } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    }, 120_000);
    beforeEach(async () => { await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [sourceId]); });
    afterEach(async () => { await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]); });
    afterAll(async () => { if (kind === 'pglite') await engine.disconnect(); await closePostgres?.(); });

    const vectors = async () => (await engine.executeRaw<{ chunk_index: number; has: boolean; hash: string | null }>(
      `SELECT cc.chunk_index, cc.embedding IS NOT NULL AS has, to_jsonb(cc)->>'embedding_input_hash' AS hash FROM content_chunks cc
       JOIN pages p ON p.id=cc.page_id WHERE p.source_id=$1 AND p.slug=$2 ORDER BY cc.chunk_index`, [sourceId, slug]))
      .map(r => ({ i: Number(r.chunk_index), has: r.has, hash: r.hash }));
    const present = async () => (await vectors()).map(v => v.has);

    async function seed(opts: { mode: string | null; generation?: string | null; chunks?: ChunkInput[]; title?: string } = { mode: 'title' }) {
      await engine.putPage(slug, { type: 'note', title: opts.title ?? 'Cedar notes', compiled_truth: body, timeline,
        frontmatter: {}, source_path: 'notes/cedar.md' }, { sourceId });
      const prepared = (await readProjectionSnapshot(engine, slug, sourceId, { allowUnsealed: true }))!;
      const chunks = opts.chunks ?? (await preparePageProjection(prepared)).chunks;
      await installPageProjection(engine, prepared, chunks, { seal: true });
      await engine.updatePageContextualRetrievalState(slug, sourceId, opts.mode as never, opts.generation ?? null);
    }
    async function embedAll(override?: { tier: string; corpusGeneration?: string | null }, only?: number[]) {
      const prepared = (await readProjectionSnapshot(engine, slug, sourceId))!;
      const chunks = prepared.chunks.filter(c => !only || only.includes(c.chunk_index))
        .map(c => ({ chunk_index: c.chunk_index, chunk_text: c.chunk_text, chunk_source: c.chunk_source, embedding: vec(c.chunk_index + 1) }));
      expect(await (installPageEmbeddings as (...a: unknown[]) => Promise<boolean>)(engine, prepared, chunks, undefined, override)).toBe(true);
    }
    async function rebuild() {
      await queuePageProjection(engine, sourceId, slug, 'test_rebuild');
      expect(await rebuildPendingPageProjections(engine, 10)).toEqual({ rebuilt: 1, superseded: 0 });
    }
    async function editBody(nextBody: string, title = 'Cedar notes') {
      await engine.putPage(slug, { type: 'note', title, compiled_truth: nextBody, timeline, frontmatter: {}, source_path: 'notes/cedar.md' }, { sourceId });
    }

    test('baseline shape (PR #5630 repro): a title-mode rebuild with nothing changed keeps every vector', async () => {
      await seed({ mode: 'title' });
      await embedAll();
      expect(await present()).toEqual([true, true]);
      const stamped = await vectors();
      await rebuild();
      expect(await present()).toEqual([true, true]);
      expect(await vectors()).toEqual(stamped);
      for (const v of stamped) expect(v.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    test('an unchanged none-mode rebuild also keeps its vectors and stamps', async () => {
      await seed({ mode: 'none' });
      await embedAll();
      const stamped = await vectors();
      await rebuild();
      expect(await vectors()).toEqual(stamped);
    });

    test('changing one chunk nulls only that chunk', async () => {
      await seed({ mode: 'title' });
      await embedAll();
      await editBody(body.replace('granite ridges', 'basalt ridges'));
      await rebuild();
      expect(await present()).toEqual([false, true]);
    });

    test('a title change nulls every title-tier vector', async () => {
      await seed({ mode: 'title' });
      await embedAll();
      await editBody(body, 'Renamed cedar notes');
      await rebuild();
      expect(await present()).toEqual([false, false]);
    });

    test('a hash for another model, dimension or column never keeps the vector', async () => {
      const { embeddingInputHash } = await import('../src/core/embedding-input-hash.ts');
      for (const change of [{ model: 'openai:other-model' }, { dimensions: 3 }, { column: 'embedding_other' }]) {
        await seed({ mode: 'title' });
        await embedAll();
        const prepared = (await readProjectionSnapshot(engine, slug, sourceId))!;
        const chunk = prepared.chunks[0];
        const forged = embeddingInputHash({ column: 'embedding', model: prepared.embeddingModel, dimensions: 1536,
          title: 'Cedar notes', corpusGeneration: null, bodyHash: '', ...change }, 'title', chunk);
        await engine.executeRaw('UPDATE content_chunks SET embedding_input_hash=$2 WHERE page_id=$1 AND chunk_index=0', [prepared.snapshot.page.id, forged]);
        await rebuild();
        expect(await present()).toEqual([false, true]);
        await engine.executeRaw('DELETE FROM pages WHERE source_id=$1', [sourceId]);
      }
    });

    test('a legacy chunk with no provenance on a contextual page is nulled once, then stamped and kept', async () => {
      await seed({ mode: 'title' });
      await embedAll();
      await engine.executeRaw(`UPDATE content_chunks SET embedding_input_hash=NULL WHERE page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$2)`, [sourceId, slug]);
      await rebuild();
      expect(await present()).toEqual([false, false]);
      await embedAll();
      const stamped = await vectors();
      expect(stamped.every(v => v.has && v.hash)).toBe(true);
      await rebuild();
      expect(await vectors()).toEqual(stamped);
    });

    test('a legacy chunk with no provenance on a none-mode page keeps its vector (unchanged behavior)', async () => {
      await seed({ mode: null });
      await embedAll();
      await engine.executeRaw(`UPDATE content_chunks SET embedding_input_hash=NULL WHERE page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$2)`, [sourceId, slug]);
      await rebuild();
      expect(await present()).toEqual([true, true]);
    });

    test('synopsis mode: an unchanged rebuild keeps mixed synopsis and title tiers; a body edit nulls every synopsis chunk', async () => {
      await seed({ mode: 'per_chunk_synopsis', generation: SYNOPSIS_GENERATION });
      await embedAll({ tier: 'per_chunk_synopsis', corpusGeneration: SYNOPSIS_GENERATION }, [0]);
      await embedAll(undefined, [1]);
      const stamped = await vectors();
      expect(stamped.map(v => v.has)).toEqual([true, true]);
      expect(stamped[0].hash).not.toBe(stamped[1].hash);
      await rebuild();
      expect(await vectors()).toEqual(stamped);
      // The body edit touches only the timeline chunk's neighbour text, so chunk 0's
      // own text is unchanged: its synopsis read the whole body and is still nulled.
      await engine.putPage(slug, { type: 'note', title: 'Cedar notes', compiled_truth: body, timeline: `${timeline} Extra detail.`,
        frontmatter: {}, source_path: 'notes/cedar.md' }, { sourceId });
      await rebuild();
      expect(await present()).toEqual([false, false]);
    });

    test('synopsis mode: a title-tier chunk keeps its vector through a body edit that leaves its own text unchanged', async () => {
      await seed({ mode: 'per_chunk_synopsis', generation: SYNOPSIS_GENERATION });
      await embedAll(undefined, [0]);
      await embedAll({ tier: 'per_chunk_synopsis', corpusGeneration: SYNOPSIS_GENERATION }, [1]);
      await engine.putPage(slug, { type: 'note', title: 'Cedar notes', compiled_truth: body, timeline: `${timeline} Extra detail.`,
        frontmatter: {}, source_path: 'notes/cedar.md' }, { sourceId });
      await rebuild();
      expect(await present()).toEqual([true, false]);
    });

    test('synopsis mode: a title change past the 300-character wrapper cap still nulls synopsis-tier vectors', async () => {
      const long = 'T'.repeat(320);
      await seed({ mode: 'per_chunk_synopsis', generation: SYNOPSIS_GENERATION, title: `${long} one` });
      await embedAll({ tier: 'per_chunk_synopsis', corpusGeneration: SYNOPSIS_GENERATION }, [0]);
      await embedAll(undefined, [1]);
      await editBody(body, `${long} two`);
      await engine.updatePageContextualRetrievalState(slug, sourceId, 'per_chunk_synopsis', SYNOPSIS_GENERATION);
      await rebuild();
      // The synopsis prompt read the full title; the title wrapper keeps only its first 300 characters.
      expect(await present()).toEqual([false, true]);
    });

    test('a stale synopsis generation nulls synopsis-tier vectors', async () => {
      await seed({ mode: 'per_chunk_synopsis', generation: SYNOPSIS_GENERATION });
      await embedAll({ tier: 'per_chunk_synopsis', corpusGeneration: SYNOPSIS_GENERATION });
      await engine.updatePageContextualRetrievalState(slug, sourceId, 'per_chunk_synopsis', 'another-generation');
      await rebuild();
      expect(await present()).toEqual([false, false]);
    });

    test('the oversize heal keeps vectors of unchanged chunks on a title-mode page', async () => {
      const big = Array.from({ length: 60 }, (_, i) => `Sentence ${i} about the long synthetic ridge walk.`).join(' ');
      await seed({ mode: 'title', chunks: [
        { chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' },
        { chunk_index: 1, chunk_text: big, chunk_source: 'timeline' },
      ] });
      await embedAll();
      const before = await vectors();
      const healed = await healOversizedPageChunks(engine, slug, { sourceId, maxTokens: 200 });
      expect(healed.changed).toBe(true);
      const after = await vectors();
      expect(after.length).toBeGreaterThan(2);
      expect(after[0]).toEqual(before[0]);
      expect(after.slice(1).every(v => !v.has && v.hash === null)).toBe(true);
    });

    test('an inline title-mode import stamps provenance, so a later rebuild keeps its vectors', async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-fake' } });
      __setEmbedTransportForTests((async (args: { values: string[] }) => ({
        embeddings: args.values.map((_, i) => Array.from(vec(i + 1))),
      })) as never);
      try {
        await engine.setConfig('search.contextual_retrieval', 'title').catch(() => undefined);
        await engine.executeRaw('UPDATE sources SET contextual_retrieval_mode=$2 WHERE id=$1', [sourceId, 'title']);
        const md = `---\ntitle: Cedar notes\ntype: note\n---\n\n${body}\n`;
        const result = await importFromContent(engine, slug, md, { sourceId });
        expect(result.status).toBe('imported');
        const [page] = await engine.executeRaw<{ mode: string }>('SELECT contextual_retrieval_mode AS mode FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
        expect(page.mode).toBe('title');
        const stamped = await vectors();
        expect(stamped.length).toBeGreaterThan(0);
        for (const v of stamped) expect(v.has && typeof v.hash === 'string').toBe(true);
        await rebuild();
        expect(await vectors()).toEqual(stamped);
      } finally {
        __setEmbedTransportForTests(null);
        resetGateway();
      }
    });
  });
}
