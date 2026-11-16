/**
 * #7082: a local caller's strict title attempt matches the whole
 * pages.search_vector (title plus timelines, timeline_entries rows included),
 * and a very common word matched most pages, so ranking read every matching
 * vector until the statement timeout. The attempt now ranks at most
 * titleWholeVectorCandidates() matching pages. A rarer term keeps its exact
 * whole-vector result, which is the only lexical path to a timeline_entries row
 * no chunk holds; a cut attempt reports candidate_budget and leads with the
 * title-only rows remote callers get.
 *
 * Hermetic PGLite with an empty gateway env, so hybridSearch never embeds.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { __setTitleWholeVectorCandidatesForTests, titleWholeVectorCandidates } from '../../src/core/search/title-statement.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { TIMELINE_TITLE_PAGES, TIMELINE_TITLE_QUERIES } from '../fixtures/retrieval-quality/timeline-titles/corpus.ts';

let engine: PGLiteEngine;
const defaultCap = titleWholeVectorCandidates();

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
  // A row written straight to timeline_entries (meeting extraction, enrichment): no chunk holds its text,
  // and the page vector folds it in on the next title or timeline write.
  await engine.putPage('people/erin-example', { type: 'person', title: 'Erin Example', compiled_truth: 'Plant engineer.', timeline: '' });
  await installFixtureChunks(engine, 'people/erin-example', [{ chunk_index: 0, chunk_text: 'Plant engineer.', chunk_source: 'compiled_truth' }]);
  await engine.addTimelineEntry('people/erin-example', { date: '2026-10-08', summary: 'Toured the qendril smelter', source: 'meetings/2026-10-08-plant-tour' });
  await engine.executeRaw("UPDATE pages SET title = title WHERE slug = 'people/erin-example'");
});

afterEach(() => __setTitleWholeVectorCandidatesForTests(defaultCap));

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

const titles = async (q: string, remote: boolean) => {
  const cut: string[] = [];
  const rows = await engine.searchTitles(q, { limit: 10, onKeywordIncomplete: r => { cut.push(r); }, ...(remote ? { excludePrivate: true } : {}) });
  return { slugs: rows.map(r => r.slug), cut };
};

const words = (q: string) => q.toLowerCase().split(/\s+/);
const timelineOnly = (q: string) => TIMELINE_TITLE_PAGES
  .filter(p => words(q).every(w => p.timeline.toLowerCase().includes(w)) && !words(q).every(w => p.title.toLowerCase().includes(w)))
  .map(p => p.slug);

describe('title arm: whole-vector candidate cap for local callers (#7082)', () => {
  for (const q of TIMELINE_TITLE_QUERIES) {
    test(`under the cap, the local title arm keeps every timeline-only match: "${q}"`, async () => {
      const { slugs, cut } = await titles(q, false);
      for (const slug of timelineOnly(q)) expect(slugs).toContain(slug);
      expect(cut).toEqual([]);
    });

    test(`hybrid search returns every timeline-only match: "${q}"`, async () => {
      const top = (await hybridSearch(engine, q, { limit: 10 })).map(r => r.slug);
      for (const slug of timelineOnly(q)) expect(top).toContain(slug);
    });
  }

  test('a term under the cap keeps its timeline matches and reports no cut', async () => {
    const { slugs, cut } = await titles('zircon quarry', false);
    expect(slugs[0]).toBe('projects/zircon-quarry-survey');
    for (const slug of ['people/alice-example', 'people/bob-example', 'companies/acme-example']) expect(slugs).toContain(slug);
    expect(cut).toEqual([]);
  });

  test('a timeline_entries row no chunk holds is still found by a local search', async () => {
    expect((await titles('qendril smelter', false)).slugs).toEqual(['people/erin-example']);
    expect((await hybridSearch(engine, 'qendril smelter', { limit: 10 })).map(r => r.slug)).toContain('people/erin-example');
  });

  test('remote callers keep the title-only match', async () => {
    expect((await titles('qendril smelter', true)).slugs).toEqual([]);
    expect((await titles('zircon quarry', true)).slugs).toEqual(['projects/zircon-quarry-survey']);
  });

  test('a cut attempt reports candidate_budget and leads with every title match', async () => {
    const remote = await titles('board meeting', true);
    expect(remote.slugs.length).toBe(2);
    __setTitleWholeVectorCandidatesForTests(2);
    const { slugs, cut } = await titles('board meeting', false);
    expect(cut).toEqual(['candidate_budget']);
    expect(slugs.slice(0, remote.slugs.length)).toEqual(remote.slugs);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs.length).toBeLessThanOrEqual(remote.slugs.length + 3);
  });

  test('a cut keeps the matching pages with the lowest page ids, the same pages on every call', async () => {
    const titled = (await titles('board meeting', true)).slugs;
    const lowest = (await engine.executeRaw<{ slug: string }>(
      "SELECT slug FROM pages WHERE search_vector @@ websearch_to_tsquery('english', 'board meeting') ORDER BY id LIMIT 2")).map(r => r.slug);
    __setTitleWholeVectorCandidatesForTests(2);
    const first = (await titles('board meeting', false)).slugs;
    expect(first.slice(titled.length).sort()).toEqual(lowest.filter(s => !titled.includes(s)).sort());
    for (let i = 0; i < 3; i++) expect((await titles('board meeting', false)).slugs).toEqual(first);
  });

  test('hybrid search reports the cut as keyword_candidates_incomplete', async () => {
    __setTitleWholeVectorCandidatesForTests(2);
    let degraded: unknown[] = [];
    await hybridSearch(engine, 'board meeting', { limit: 10, onMeta: m => { degraded = m.degraded ?? []; } });
    expect(degraded).toContainEqual({ stage: 'keyword_candidates_incomplete', reason: 'candidate_budget' });
    __setTitleWholeVectorCandidatesForTests(defaultCap);
    await hybridSearch(engine, 'board meeting', { limit: 10, onMeta: m => { degraded = m.degraded ?? []; } });
    expect(degraded).not.toContainEqual({ stage: 'keyword_candidates_incomplete', reason: 'candidate_budget' });
  });

  test('the cap never touches the title-only statement', async () => {
    __setTitleWholeVectorCandidatesForTests(1);
    const { slugs, cut } = await titles('board meeting', true);
    expect(slugs.length).toBe(2);
    expect(cut).toEqual([]);
  });
});
