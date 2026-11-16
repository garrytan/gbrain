/**
 * #7082: the title arm matches and ranks title lexemes only for every caller.
 * A local caller's strict attempt used to match the whole pages.search_vector
 * (title plus timeline), so a common word read every timeline holding it and
 * pulled timeline-only pages into the title arm. Local callers now get the same
 * title arm as remote callers; a page whose timeline holds the words still
 * reaches hybrid results through the keyword arm's timeline chunks.
 *
 * Hermetic PGLite with an empty gateway env, so hybridSearch never embeds.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { TIMELINE_TITLE_PAGES, TIMELINE_TITLE_QUERIES } from '../fixtures/retrieval-quality/timeline-titles/corpus.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const page of TIMELINE_TITLE_PAGES) {
    await engine.putPage(page.slug, { type: page.type, title: page.title, compiled_truth: page.compiled_truth, timeline: page.timeline });
    await installFixtureChunks(engine, page.slug, [
      { chunk_index: 0, chunk_text: page.compiled_truth, chunk_source: 'compiled_truth' },
      ...(page.timeline ? [{ chunk_index: 1, chunk_text: page.timeline, chunk_source: 'timeline' as const }] : []),
    ]);
  }
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

const titleSlugs = async (q: string, remote: boolean) =>
  (await engine.searchTitles(q, { limit: 10, ...(remote ? { excludePrivate: true } : {}) })).map(r => r.slug);
const words = (q: string) => q.toLowerCase().split(/\s+/);
const timelineOnly = (q: string) => TIMELINE_TITLE_PAGES
  .filter(p => words(q).every(w => p.timeline.toLowerCase().includes(w)) && !words(q).every(w => p.title.toLowerCase().includes(w)))
  .map(p => p.slug);

describe('title arm: title lexemes only for local callers (#7082)', () => {
  for (const q of TIMELINE_TITLE_QUERIES) {
    test(`local and remote title arms return the same pages: "${q}"`, async () => {
      expect(await titleSlugs(q, false)).toEqual(await titleSlugs(q, true));
    });
  }

  test('a page whose timeline alone holds the words is not a strict title hit', async () => {
    const local = await titleSlugs('zircon quarry', false);
    expect(local).toContain('projects/zircon-quarry-survey');
    for (const slug of ['people/alice-example', 'people/bob-example', 'companies/acme-example']) expect(local).not.toContain(slug);
  });

  for (const q of TIMELINE_TITLE_QUERIES) {
    test(`hybrid search still returns every timeline-only match through the keyword arm: "${q}"`, async () => {
      const top = (await hybridSearch(engine, q, { limit: 10 })).map(r => r.slug);
      for (const slug of timelineOnly(q)) expect(top).toContain(slug);
    });
  }
});
