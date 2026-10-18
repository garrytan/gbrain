/**
 * Wave B E2E: a 10 MB page through the segmented write path, on PGLite and
 * (with DATABASE_URL) Postgres, `pages.segmented_storage` forced on.
 *
 * 1. Protects: keyword recall of a needle at every decile of the body; the
 *    body reconstructed from the manifest hashes to the input body; a 10 KB
 *    append by rewrite writes at most the tail's chunk rows and leaves every
 *    kept chunk's vector in place (an embedder would see only new chunk
 *    texts); rows staged for a write that has not flipped stay out of search.
 * 2. Fails when: a segment or chunk is lost or duplicated at scale, the
 *    projection misses a region, an append rechunks the whole page, or
 *    staged chunks reach keyword search.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { abortSegmentedStaging, stageSegmentedImport } from '../../src/core/persistence/segmented-apply.ts';
import { conversationBody, conversationPage } from '../helpers/conversation-page.ts';
import { fakeEmbedPage, reconstructedPage, segmentedPageRow, visibleChunks } from '../helpers/segmented-page-checks.ts';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';

const SLUG = 'notes/ten-mb';
const NEEDLES = Array.from({ length: 10 }, (_, d) => ({ at: d / 10 + 0.05, word: `zqxdecile${d}needle` }));
const content = conversationPage(10 * 1024 * 1024, { seed: 101, needles: NEEDLES });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

async function hits(engine: BrainEngine, word: string): Promise<number> {
  return (await engine.searchKeyword(word, { limit: 20 })).filter(hit => hit.slug === SLUG).length;
}

function suite(name: string, connect: () => Promise<BrainEngine>, disconnect: (engine: BrainEngine) => Promise<void>, skip = false) {
  (skip ? describe.skip : describe)(`10 MB segmented page — ${name}`, () => {
    let engine: BrainEngine;
    beforeAll(async () => {
      engine = await connect();
      await engine.setConfig('pages.segmented_storage', 'on');
      const result = await importFromContent(engine, SLUG, content, { sourceId: 'default', noEmbed: true });
      expect(result.status).toBe('imported');
    }, 600_000);
    afterAll(async () => { await disconnect(engine); });

    test('a needle at every decile is found by keyword search', async () => {
      for (const needle of NEEDLES) expect(await hits(engine, needle.word)).toBe(1);
    }, 120_000);

    test('the body reconstructed from the manifest hashes to the input body, and content_hash to contentHash', async () => {
      const parsed = parseMarkdown(content, `${SLUG}.md`);
      const { page, body, hash } = await reconstructedPage(engine, SLUG);
      expect(page.body_storage).toBe('segmented');
      expect(sha(body.compiled_truth)).toBe(sha(parsed.compiled_truth));
      expect(sha(body.timeline)).toBe(sha(parsed.timeline));
      expect(page.content_hash).toBe(hash);
    }, 120_000);

    test('staged rows of an unflipped write stay out of search', async () => {
      const before = await segmentedPageRow(engine, SLUG);
      const edited = parseMarkdown(`${content.trimEnd()}\n\n${conversationBody(32 * 1024, { seed: 7, needles: [{ at: 0.5, word: 'zqxstagedneedle' }] })}\n`, `${SLUG}.md`);
      const staged = await stageSegmentedImport(engine, { slug: SLUG, sourceId: 'default', existing: await engine.getPage(SLUG, { sourceId: 'default' }),
        page: { ...edited, timeline: edited.timeline ?? '' }, policy: await readPageBodyPolicy(engine), baseRevision: before.knowledge_revision,
        chunking: { quarantined: false, corpusGeneration: null, tier: 'none' } });
      expect(staged.prepared.rows.chunks).toBeGreaterThan(0);
      expect(await hits(engine, 'zqxstagedneedle')).toBe(0);
      expect((await segmentedPageRow(engine, SLUG)).body_generation).toBe(before.body_generation);
      await abortSegmentedStaging(engine, staged.prepared);
    }, 300_000);

    test('a 10 KB append by rewrite writes at most the tail chunks and keeps every other vector', async () => {
      const before = await segmentedPageRow(engine, SLUG);
      await fakeEmbedPage(engine, before.id);
      const rowsBefore = await engine.readManifest(before.id);
      const tail = new Set(rowsBefore.slice(-2).map(row => Number(row.occurrenceId)));
      const tailChunks = (await visibleChunks(engine, before.id)).filter(chunk => tail.has(Number(chunk.occurrence_id))).length;

      const appended = `${content.trimEnd()}\n\n${conversationBody(10 * 1024, { seed: 202 })}\n`;
      const result = await importFromContent(engine, SLUG, appended, { sourceId: 'default', noEmbed: true });
      expect(result.status).toBe('imported');
      expect(result.chunks).toBeLessThanOrEqual(tailChunks + 4);
      const { page, hash } = await reconstructedPage(engine, SLUG);
      expect(page.content_hash).toBe(hash);
      const kept = new Set(rowsBefore.slice(0, -2).map(row => Number(row.occurrenceId)));
      const chunks = await visibleChunks(engine, page.id);
      expect(chunks.filter(chunk => kept.has(Number(chunk.occurrence_id))).every(chunk => chunk.embedded)).toBe(true);
      expect(chunks.filter(chunk => !chunk.embedded).length).toBeLessThanOrEqual(result.chunks);
      for (const needle of NEEDLES) expect(await hits(engine, needle.word)).toBe(1);
    }, 300_000);
  });
}

suite('PGLite', async () => {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  return engine;
}, engine => engine.disconnect());

suite('Postgres', async () => { await setupDB(); return getEngine(); }, () => teardownDB(), !hasDatabase());
