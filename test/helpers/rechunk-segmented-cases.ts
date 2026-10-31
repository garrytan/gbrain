/**
 * The re-chunk of segmented pages sealed at an older segmented chunker (`gbrain reindex --segmented`,
 * core/page-body/rechunk.ts), shared by the PGLite arm (test/large-pages/rechunk-segmented.test.ts) and the Postgres arm
 * (test/e2e/rechunk-segmented-postgres.test.ts). The page is N14's 24 MiB needle layout reduced to a 1.3 MB chat whose
 * first day is the reduction test/large-pages/needle-sentence-chunk.test.ts pins: under the old cuts its needle
 * sentence is split across two chunks. "Sealed at the old chunker" is built the way version 4 stored it: the same
 * per-segment pipeline without `boundaryCuts`, stamped chunker_version 4. Embeddings come from a counting fake.
 */
import { expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { runEmbedCore } from '../../src/commands/embed.ts';
import { runReindex } from '../../src/commands/reindex.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { chunkProjectedText } from '../../src/core/chunkers/recursive.ts';
import { resolveMaxChunkTokens } from '../../src/core/embedding-input-limit.ts';
import { resolveActiveEmbeddingColumnFromEngine } from '../../src/core/search/embedding-column.ts';
import { SEGMENTED_CHUNKER_VERSION } from '../../src/core/page-body/segment-chunks.ts';
import { rechunkWork, runSegmentedRechunk } from '../../src/core/page-body/rechunk.ts';
import type { SegmentChunkInput } from '../../src/core/page-body/types.ts';
import { N14_REDUCED, NEEDLE, needleChat } from './needle-chat.ts';

/** The chunker version segmented pages were sealed at before the forced-cut change. */
export const OLD_SEGMENTED_CHUNKER_VERSION = 4;

const dayOf = (n: number) => new Date(Date.UTC(2018, 11, 29 + n)).toISOString().slice(0, 10);
/** The needle day first, then filler days up to `bytes`. */
export function needlePageBody(bytes = 1_300_000, firstFiller = 1): string {
  let body = N14_REDUCED;
  for (let d = firstFiller; Buffer.byteLength(body) < bytes; d++) body += '\n' + needleChat(100 + d, 400, -1, dayOf(d));
  return body;
}
export const needlePage = (body: string) => `---\ntitle: Group chat\ntype: note\n---\n\n${body}`;

interface ChunkRow { id: number; occurrence_id: number; chunk_source: string; chunk_text: string }

async function pageId(engine: BrainEngine, slug: string): Promise<number> {
  return Number((await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]!.id);
}

/** The page's chunk rows (all stored rows: a sealed page stores only live ones). */
async function chunkRows(engine: BrainEngine, id: number): Promise<ChunkRow[]> {
  return (await engine.executeRaw<ChunkRow>(`-- chunk-visibility-ok: test probe of every stored row of one sealed page
    SELECT id, occurrence_id, chunk_source, chunk_text FROM content_chunks WHERE page_id=$1 ORDER BY occurrence_id, local_ordinal`, [id]))
    .map(row => ({ ...row, id: Number(row.id), occurrence_id: Number(row.occurrence_id) }));
}

async function pageState(engine: BrainEngine, id: number) {
  const [page] = await engine.executeRaw<Record<string, unknown>>(`SELECT chunker_version, body_generation::text AS body_generation,
      knowledge_revision::text AS knowledge_revision, (text_projection_revision = knowledge_revision) IS TRUE AS sealed, content_hash,
      updated_at::text AS updated_at FROM pages WHERE id=$1`, [id]);
  const counts = await engine.executeRaw<Record<string, unknown>>(`SELECT
      (SELECT count(*)::int FROM page_body_manifest WHERE page_id=$1) AS manifest,
      (SELECT count(*)::int FROM page_body_stagings WHERE page_id=$1) AS stagings,
      (SELECT string_agg(occurrence_id::text, ',' ORDER BY seq) FROM page_body_manifest WHERE page_id=$1 AND gen_to IS NULL) AS occurrences`, [id]);
  return { ...page, ...counts[0] };
}

/** Store the page's chunks as the version-4 segmented chunker made them (plain text: the projection is the segment). */
export async function sealAtOldChunker(engine: BrainEngine, slug: string): Promise<number> {
  const id = await pageId(engine, slug);
  const [page] = await engine.executeRaw<{ body_generation: number | string }>('SELECT body_generation FROM pages WHERE id=$1', [id]);
  const rows = await engine.readManifest(id);
  const texts = await engine.readSegmentTexts('default', rows.map(row => row.sha256));
  const chunks: SegmentChunkInput[] = [];
  for (const row of rows) {
    expect(row.protectedRegions).toEqual([]);
    const text = new TextDecoder().decode(texts.get(Buffer.from(row.sha256).toString('hex'))!);
    chunkProjectedText(text, { maxTokens: resolveMaxChunkTokens(), spans: true, headingsLead: true }).forEach((c, i) => chunks.push({
      chunk_text: c.text, chunk_source: row.region === 'truth' ? 'compiled_truth' : 'timeline', occurrence_id: Number(row.occurrenceId), local_ordinal: i,
      projected_byte_start: c.byte_start, projected_byte_end: c.byte_end, raw_byte_start: c.byte_start!, raw_byte_end: c.byte_end! }));
  }
  await engine.executeRaw('DELETE FROM content_chunks WHERE page_id=$1', [id]);
  await engine.stageSegmentChunks(id, Number(page!.body_generation), chunks);
  await engine.executeRaw('UPDATE pages SET chunker_version=$2 WHERE id=$1', [id, OLD_SEGMENTED_CHUNKER_VERSION]);
  return id;
}

const split = (rows: readonly ChunkRow[]) => rows.filter(r => r.chunk_text.includes('Fennmere') && !r.chunk_text.includes(NEEDLE));

/** Chunk texts of `after` that no row of the same occurrence in `before` holds. */
function newTexts(before: readonly ChunkRow[], after: readonly ChunkRow[]): number {
  const old = new Set(before.map(r => `${r.occurrence_id}\0${r.chunk_source}\0${r.chunk_text}`));
  return after.filter(r => !old.has(`${r.occurrence_id}\0${r.chunk_source}\0${r.chunk_text}`)).length;
}

export function defineRechunkSegmentedCases(opts: { getEngine: () => BrainEngine }): void {
  const embedded: string[] = [];
  const setup = async () => {
    const engine = opts.getEngine();
    const dims = (await resolveActiveEmbeddingColumnFromEngine(engine)).dimensions;
    await engine.setConfig('pages.segmented_storage', 'on');
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: dims, env: { OPENAI_API_KEY: 'sk-test' } });
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
      embedded.push(...values);
      return { embeddings: values.map(() => Array.from({ length: dims }, (_, j) => (j === 0 ? 1 : 0))), usage: { tokens: values.length } };
    }) as never);
    embedded.length = 0;
    return engine;
  };
  const teardown = () => { __setEmbedTransportForTests(null); resetGateway(); };

  test('a page sealed at the old chunker: the preview lists it and writes nothing; --apply re-chunks it, keeps the vectors of unchanged texts, embeds only new texts and search finds the needle whole', async () => {
    const engine = await setup();
    try {
      const slug = 'chats/rechunk-needle';
      await importFromContent(engine, slug, needlePage(needlePageBody()), { noEmbed: true });
      const id = await sealAtOldChunker(engine, slug);
      await runEmbedCore(engine, { stale: true, quiet: true });
      expect(embedded.length).toBeGreaterThan(100);
      const before = await chunkRows(engine, id);
      const stateBefore = await pageState(engine, id);
      expect(stateBefore).toMatchObject({ chunker_version: OLD_SEGMENTED_CHUNKER_VERSION, sealed: true });
      expect(split(before).length).toBeGreaterThan(0);

      const preview = await runSegmentedRechunk(engine);
      expect(preview.dry_run).toBe(true);
      expect(preview.pages.map(p => [p.slug, p.chunker_version])).toEqual([[slug, OLD_SEGMENTED_CHUNKER_VERSION]]);
      const listed = preview.pages[0]!;
      expect(listed.chunks).toBe(before.length);
      expect(listed.segments_changed).toBeGreaterThan(0);
      expect(listed.new_chunk_texts).toBeGreaterThan(0);
      expect(preview.commands.apply).toEqual(['gbrain', 'reindex', '--segmented', '--apply']);
      expect(await chunkRows(engine, id)).toEqual(before);
      expect(await pageState(engine, id)).toEqual(stateBefore);

      embedded.length = 0;
      const work = { ...rechunkWork };
      const applied = await runSegmentedRechunk(engine, { apply: true });
      const page = applied.pages[0]!;
      expect(page).toMatchObject({ slug, state: 'rechunked', chunks: listed.chunks, chunks_after: listed.chunks_after,
        segments_changed: listed.segments_changed, new_chunk_texts: listed.new_chunk_texts });
      const after = await chunkRows(engine, id);
      const stateAfter = await pageState(engine, id);
      expect(stateAfter).toMatchObject({ chunker_version: SEGMENTED_CHUNKER_VERSION, sealed: true, knowledge_revision: stateBefore.knowledge_revision,
        content_hash: stateBefore.content_hash, updated_at: stateBefore.updated_at, manifest: stateBefore.manifest, occurrences: stateBefore.occurrences });
      expect(after.length).toBe(listed.chunks_after);
      const fresh = newTexts(before, after);
      expect(page.new_chunk_texts).toBe(fresh);
      const staged = rechunkWork.staged - work.staged;
      expect(rechunkWork.flips - work.flips).toBe(1);
      expect(page.vectors_reused).toBe(staged - fresh);
      expect(applied.commands.embed).toEqual(['gbrain', 'embed', '--stale']);

      expect(split(after)).toEqual([]);
      expect(after.some(r => r.chunk_text.includes(NEEDLE))).toBe(true);
      for (const requireSafeChunks of [false, true]) {
        const hit = (await engine.searchKeyword('Fennmere harbor pilot', { requireSafeChunks })).find(h => h.slug === slug);
        expect(hit?.chunk_text).toContain(NEEDLE);
      }
      await runEmbedCore(engine, { stale: true, quiet: true });
      expect(embedded.length).toBe(fresh);
      expect((await runSegmentedRechunk(engine)).pages).toEqual([]);
    } finally { teardown(); }
  }, 300_000);

  test('an append to a page sealed at the old chunker re-chunks only its tail, so the page stays at the old version and listed', async () => {
    const engine = await setup();
    try {
      const slug = 'chats/rechunk-append';
      const body = needlePageBody(1_300_000, 200);
      await importFromContent(engine, slug, needlePage(body), { noEmbed: true });
      const id = await sealAtOldChunker(engine, slug);
      await importFromContent(engine, slug, needlePage(body + '\n' + needleChat(7, 40, -1, '2019-03-01')), { noEmbed: true });
      expect(await pageState(engine, id)).toMatchObject({ chunker_version: OLD_SEGMENTED_CHUNKER_VERSION, sealed: true });
      expect((await runSegmentedRechunk(engine, { slug })).pages.map(p => p.slug)).toEqual([slug]);
    } finally { teardown(); }
  }, 300_000);

  test('replaying the schema migrations or the markdown reindex never re-chunks a segmented page', async () => {
    const engine = await setup();
    try {
      const slug = 'chats/rechunk-upgrade';
      await importFromContent(engine, slug, needlePage(needlePageBody(1_300_000, 400)), { noEmbed: true });
      const id = await sealAtOldChunker(engine, slug);
      const before = await chunkRows(engine, id);
      const state = await pageState(engine, id);
      await engine.initSchema();
      await runReindex(engine, ['--markdown', '--no-embed', '--json']);
      expect(await chunkRows(engine, id)).toEqual(before);
      expect(await pageState(engine, id)).toEqual(state);
    } finally { teardown(); }
  }, 300_000);
}
