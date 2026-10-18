/**
 * Wave B segmented ingest on PGLite (lane 1d): the string write path stages a
 * body above the inline threshold as segments and publishes it with the
 * generation flip; a file above the single-string ceiling imports streamed.
 *
 * 1. Protects: create, replace, no-op rewrite and append-by-rewrite of a
 *    segmented page; promote/demote hysteresis; the streamed import of a file
 *    over PAGE_MAX_BYTES (switch on) and its refusal (switch off); that
 *    `content_hash` equals `contentHash` of the reconstructed page; that staged
 *    rows stay invisible until the flip.
 * 2. Fails when: a flip loses or duplicates a segment, the hash stream
 *    diverges from `contentHash`, an append rewrites more than the tail, a
 *    staged row reaches the live manifest, or hysteresis flips class early.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent, importFromFile } from '../../src/core/import-file.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { readPageBodyPolicy, SEGMENTED_DEMOTE_AT_OR_BELOW_BYTES, SEGMENTED_PROMOTE_ABOVE_BYTES } from '../../src/core/page-body/limits.ts';
import { abortSegmentedStaging, stageSegmentedImport } from '../../src/core/persistence/segmented-apply.ts';
import { conversationBody, conversationPage } from '../helpers/conversation-page.ts';
import { fakeEmbedPage, reconstructedPage, segmentedPageRow, visibleChunks } from '../helpers/segmented-page-checks.ts';
import { embeddingInputHash } from '../../src/core/embedding-input-hash.ts';
import { embeddingInputContext, embeddingWriteTarget } from '../../src/core/page-state/projections.ts';

let engine: PGLiteEngine;
let dir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  dir = mkdtempSync(join(tmpdir(), 'gbrain-segmented-ingest-'));
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM pages');
  await engine.setConfig('pages.segmented_storage', 'on');
});

describe('string path: create, no-op, append', () => {
  const content = conversationPage(3 * 1024 * 1024, { seed: 7 });

  test('create publishes a segmented page whose manifest reproduces the parsed body and whose hash is contentHash', async () => {
    const result = await importFromContent(engine, 'notes/big', content, { sourceId: 'default', noEmbed: true });
    expect(result.status).toBe('imported');
    const parsed = parseMarkdown(content, 'notes/big.md');
    const { page, body, hash } = await reconstructedPage(engine, 'notes/big');
    expect(page.body_storage).toBe('segmented');
    expect(page.body_generation).toBe(1);
    expect(body.compiled_truth).toBe(parsed.compiled_truth);
    expect(body.timeline).toBe(parsed.timeline);
    expect(page.content_hash).toBe(hash);
    expect(page.text_projection_revision).toBe(page.knowledge_revision);
    expect((await visibleChunks(engine, page.id)).length).toBeGreaterThan(0);
  }, 120_000);

  test('a no-op rewrite publishes nothing', async () => {
    await importFromContent(engine, 'notes/big', content, { sourceId: 'default', noEmbed: true });
    const before = await segmentedPageRow(engine, 'notes/big');
    const result = await importFromContent(engine, 'notes/big', content, { sourceId: 'default', noEmbed: true });
    expect(result.status).toBe('skipped');
    const after = await segmentedPageRow(engine, 'notes/big');
    expect(after.body_generation).toBe(before.body_generation);
    expect(after.knowledge_revision).toBe(before.knowledge_revision);
  }, 120_000);

  test('a 10 KB append rewrites only the tail: earlier occurrences, their chunks and vectors are kept', async () => {
    await importFromContent(engine, 'notes/big', content, { sourceId: 'default', noEmbed: true });
    const before = await segmentedPageRow(engine, 'notes/big');
    const rowsBefore = await engine.readManifest(before.id);
    await fakeEmbedPage(engine, before.id);
    const tailOccurrences = new Set(rowsBefore.slice(-2).map(row => Number(row.occurrenceId)));
    const tailChunks = (await visibleChunks(engine, before.id)).filter(chunk => tailOccurrences.has(Number(chunk.occurrence_id))).length;

    const appended = `${content.trimEnd()}\n\n${conversationBody(10 * 1024, { seed: 99 })}\n`;
    const result = await importFromContent(engine, 'notes/big', appended, { sourceId: 'default', noEmbed: true });
    expect(result.status).toBe('imported');
    const { page, body, hash } = await reconstructedPage(engine, 'notes/big');
    expect(page.body_generation).toBe(before.body_generation + 1);
    expect(body.compiled_truth).toBe(parseMarkdown(appended, 'notes/big.md').compiled_truth);
    expect(page.content_hash).toBe(hash);

    const rowsAfter = await engine.readManifest(page.id);
    const kept = rowsBefore.slice(0, -2).map(row => Number(row.occurrenceId));
    expect(rowsAfter.slice(0, kept.length).map(row => Number(row.occurrenceId))).toEqual(kept);
    expect(result.chunks).toBeLessThanOrEqual(tailChunks + 4);
    const chunks = await visibleChunks(engine, page.id);
    const keptSet = new Set(kept);
    expect(chunks.filter(chunk => keptSet.has(Number(chunk.occurrence_id))).every(chunk => chunk.embedded)).toBe(true);
    expect(chunks.filter(chunk => !chunk.embedded).length).toBeLessThanOrEqual(result.chunks);
  }, 180_000);

  /**
   * The flip deletes the rows it retires, so vector reuse must read them before it: during preparation, when they are
   * still live. Every chunk gets its own vector and the recorded input hash reuse admits; after the append, each new tail
   * chunk whose text was in a retired occurrence carries that chunk's vector, and no row of a retired occurrence is left.
   */
  async function embedDistinct(pageId: number): Promise<void> {
    const [page] = await engine.executeRaw<{ title: string; contextual_retrieval_mode: string | null; corpus_generation: string | null }>(
      'SELECT title, contextual_retrieval_mode, corpus_generation FROM pages WHERE id=$1', [pageId]);
    const provenance = embeddingInputContext(await embeddingWriteTarget(engine), page!.title, page!.corpus_generation, []);
    const tier = page!.contextual_retrieval_mode === 'title' ? 'title' : 'none';
    const rows = await engine.executeRaw<{ id: number; chunk_text: string; chunk_source: string }>(
      'SELECT id, chunk_text, chunk_source FROM content_chunks WHERE page_id=$1', [pageId]);
    for (const row of rows) {
      await engine.executeRaw(`UPDATE content_chunks SET embedding = (array_fill(0::float4, ARRAY[$3::int - 1]) || ARRAY[$2::float4])::vector,
          embedding_input_hash = $4, embedded_at = now() WHERE id = $1`,
        [row.id, 1 + row.id / 1e6, (await embeddingWriteTarget(engine)).column.dimensions,
          embeddingInputHash(provenance, tier, { chunk_text: row.chunk_text, chunk_source: row.chunk_source })]);
    }
  }
  const vectorsByText = async (pageId: number, occurrences: number[]) => new Map((await engine.executeRaw<{ key: string; embedding: string | null }>(
    `SELECT chunk_source || '|' || chunk_text AS key, embedding::text AS embedding FROM content_chunks WHERE page_id=$1 AND occurrence_id=ANY($2::bigint[])`,
    [pageId, occurrences])).map(row => [row.key, row.embedding]));

  async function appendAfterDistinctEmbed(dropTailVectors: boolean) {
    await importFromContent(engine, 'notes/big', content, { sourceId: 'default', noEmbed: true });
    const before = await segmentedPageRow(engine, 'notes/big');
    await embedDistinct(before.id);
    const liveBefore = (await engine.readManifest(before.id)).map(row => Number(row.occurrenceId));
    const tail = liveBefore.slice(-2);
    if (dropTailVectors) await engine.executeRaw('UPDATE content_chunks SET embedding = NULL WHERE page_id=$1 AND occurrence_id=ANY($2::bigint[])', [before.id, tail]);
    const oldByOccurrence = new Map(await Promise.all(tail.map(async id => [id, await vectorsByText(before.id, [id])] as const)));
    const appended = `${content.trimEnd()}\n\n${conversationBody(10 * 1024, { seed: 99 })}\n`;
    expect((await importFromContent(engine, 'notes/big', appended, { sourceId: 'default', noEmbed: true })).status).toBe('imported');
    const live = (await engine.readManifest(before.id)).map(row => Number(row.occurrenceId));
    const retired = liveBefore.filter(id => !live.includes(id));
    const old = new Map(retired.flatMap(id => [...(oldByOccurrence.get(id) ?? new Map())]));
    const fresh = await vectorsByText(before.id, live.filter(id => !liveBefore.includes(id)));
    const shared = [...fresh.keys()].filter(key => old.has(key));
    const left = await engine.executeRaw('SELECT 1 FROM content_chunks WHERE page_id=$1 AND occurrence_id=ANY($2::bigint[])', [before.id, retired]);
    expect(retired.length).toBeGreaterThan(0);
    expect(retired.every(id => tail.includes(id))).toBe(true);
    return { old, fresh, shared, left: left.length };
  }

  test('a rewritten tail keeps the vectors of its unchanged chunks, read before the flip deletes the rows it retires', async () => {
    const { old, fresh, shared, left } = await appendAfterDistinctEmbed(false);
    expect(left).toBe(0);
    expect(shared.length).toBeGreaterThan(0);
    for (const key of shared) expect(fresh.get(key)).toBe(old.get(key)!);
  }, 180_000);

  test('forced probe: with the retired rows\' vectors gone before preparation, no tail chunk gets one', async () => {
    const { fresh, shared, left } = await appendAfterDistinctEmbed(true);
    expect(left).toBe(0);
    expect(shared.length).toBeGreaterThan(0);
    for (const key of shared) expect(fresh.get(key)).toBeNull();
  }, 180_000);

  test('staged rows stay out of the live manifest and the page until the flip', async () => {
    await importFromContent(engine, 'notes/big', content, { sourceId: 'default', noEmbed: true });
    const before = await segmentedPageRow(engine, 'notes/big');
    const liveBefore = await engine.readManifest(before.id);
    const visibleBefore = (await visibleChunks(engine, before.id)).length;
    const existing = await engine.getPage('notes/big', { sourceId: 'default' });
    const edited = parseMarkdown(`${content.trimEnd()}\n\n${conversationBody(64 * 1024, { seed: 5 })}\n`, 'notes/big.md');
    const staged = await stageSegmentedImport(engine, { slug: 'notes/big', sourceId: 'default', existing,
      page: { ...edited, timeline: edited.timeline ?? '' }, policy: await readPageBodyPolicy(engine), baseRevision: before.knowledge_revision,
      chunking: { quarantined: false, corpusGeneration: null, tier: 'none' } });
    expect((await engine.readManifest(before.id, { stagingId: staged.prepared.stagingId })).length).toBeGreaterThan(0);
    expect(await engine.readManifest(before.id)).toEqual(liveBefore);
    const after = await segmentedPageRow(engine, 'notes/big');
    expect(after.body_generation).toBe(before.body_generation);
    expect(after.content_hash).toBe(before.content_hash);
    const staleChunks = await engine.executeRaw('SELECT 1 FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE c.page_id=$1 AND c.body_generation>p.body_generation', [before.id]);
    expect((await visibleChunks(engine, before.id)).length).toBe(visibleBefore);
    expect(staleChunks.length).toBe(staged.prepared.rows.chunks);
    await abortSegmentedStaging(engine, staged.prepared);
  }, 120_000);
});

describe('promote / demote hysteresis', () => {
  const sized = (bytes: number) => conversationPage(bytes, { seed: 3 });

  test('inline up to the promote bound, segmented above it, kept segmented above the demote bound, inline at or under it', async () => {
    await importFromContent(engine, 'notes/grow', sized(SEGMENTED_DEMOTE_AT_OR_BELOW_BYTES + 64 * 1024), { sourceId: 'default', noEmbed: true });
    expect((await segmentedPageRow(engine, 'notes/grow')).body_storage).toBe('inline');
    await importFromContent(engine, 'notes/grow', sized(SEGMENTED_PROMOTE_ABOVE_BYTES + 128 * 1024), { sourceId: 'default', noEmbed: true });
    const promoted = await reconstructedPage(engine, 'notes/grow');
    expect(promoted.page.body_storage).toBe('segmented');
    expect(promoted.page.content_hash).toBe(promoted.hash);
    expect((await visibleChunks(engine, promoted.page.id)).every(chunk => chunk.occurrence_id !== null)).toBe(true);
    await importFromContent(engine, 'notes/grow', sized(SEGMENTED_DEMOTE_AT_OR_BELOW_BYTES + 128 * 1024), { sourceId: 'default', noEmbed: true });
    expect((await segmentedPageRow(engine, 'notes/grow')).body_storage).toBe('segmented');
    const small = sized(SEGMENTED_DEMOTE_AT_OR_BELOW_BYTES - 64 * 1024);
    await importFromContent(engine, 'notes/grow', small, { sourceId: 'default', noEmbed: true });
    const demoted = await segmentedPageRow(engine, 'notes/grow');
    expect(demoted.body_storage).toBe('inline');
    expect((await engine.getPage('notes/grow', { sourceId: 'default' }))!.compiled_truth).toBe(parseMarkdown(small, 'notes/grow.md').compiled_truth);
    expect(await engine.readManifest(demoted.id)).toEqual([]);
    expect((await visibleChunks(engine, demoted.id)).every(chunk => chunk.occurrence_id === null)).toBe(true);
  }, 240_000);
});

describe('streamed import above the single-string ceiling', () => {
  test('switch on: a ~26 MiB file round-trips byte-identical from the manifest; switch off: refused as today', async () => {
    const content = conversationPage(PAGE_MAX_BYTES + 2 * 1024 * 1024, { seed: 11 });
    const file = join(dir, 'huge.md');
    writeFileSync(file, content);
    const parsed = parseMarkdown(content, 'notes/huge.md');

    await engine.setConfig('pages.segmented_storage', 'off');
    const refused = await importFromFile(engine, file, 'notes/huge.md', { noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) });
    expect(refused.status).toBe('skipped');
    expect(refused.refusal?.code).toBe('file_too_large');
    expect(await engine.getPage('notes/huge', { sourceId: 'default' })).toBeNull();

    await engine.setConfig('pages.segmented_storage', 'on');
    const imported = await importFromFile(engine, file, 'notes/huge.md', { noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) });
    expect(imported.status).toBe('imported');
    const { page, body, hash } = await reconstructedPage(engine, 'notes/huge');
    expect(page.body_storage).toBe('segmented');
    expect(body.compiled_truth).toBe(parsed.compiled_truth);
    expect(body.timeline).toBe(parsed.timeline);
    expect(page.content_hash).toBe(hash);
  }, 600_000);
});
