/**
 * GST-2899: a question that names a company in words its people's pages never
 * use ("Which people are on the Quorvex team?") is answered by the pages whose
 * dated timeline names the company. On a brain with no embedding provider the
 * only step that reads timelines by any one word of the question is the title
 * step's any-word retry, for local callers. When that retry read titles alone
 * (#7135), these questions returned the company page and little else.
 *
 * Hermetic PGLite with an empty gateway env, so hybridSearch never embeds.
 * Pages are imported the way a keyless brain imports them. Synthetic fixture.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { RELATION_PAGES, RELATION_QUESTIONS, type RelationQuestion } from '../fixtures/retrieval-quality/reworded-relations/corpus.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const p of RELATION_PAGES) {
    const body = ['---', `type: ${p.type}`, `title: ${JSON.stringify(p.title)}`, '---', '', `# ${p.title}`, '', p.compiled_truth, '', '## Timeline', '', p.timeline].join('\n');
    await importFromContent(engine, p.slug, body, { noEmbed: true });
  }
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

const K = 5;
/** The distinct pages of the first K rows, the way a caller reads a five-row answer. */
const topPages = async (text: string) => {
  const rows = await hybridSearch(engine, text, { limit: K, relationalRetrieval: false, expansion: false, autocut: false, adaptiveReturn: false });
  return [...new Set(rows.map(r => r.slug))];
};
const recallAt5 = async (questions: RelationQuestion[]) => {
  let sum = 0;
  for (const q of questions) {
    const got = await topPages(q.text);
    sum += q.relevant.filter(s => got.includes(s)).length / q.relevant.length;
  }
  return sum / questions.length;
};
const titleSlugs = async (text: string, remote: boolean) =>
  (await engine.searchTitles(text, { limit: 20, ...(remote ? { excludePrivate: true } : {}) })).map(r => r.slug);

describe('reworded one-hop relationship questions on a keyless brain (GST-2899)', () => {
  test('the fixture has the shape: ten companies, template and reworded wordings', () => {
    expect(RELATION_PAGES.length).toBe(86);
    expect(RELATION_QUESTIONS.filter(q => q.wording === 'template').length).toBe(30);
    expect(RELATION_QUESTIONS.filter(q => q.wording === 'reworded').length).toBe(100);
  });

  test("a local caller's title step finds the people whose timeline names the company", async () => {
    const slugs = await titleSlugs('Who works at Quorvex?', false);
    expect(slugs).toContain('companies/quorvex');
    // The founder's page never says "works": only the timeline ("Left the platform group to start Quorvex") names the company.
    expect(slugs).toContain('people/alice-example-0');
    expect(slugs).toContain('people/bob-example-1');
  });

  test('a remote caller keeps the title-only match', async () => {
    const slugs = await titleSlugs('Who works at Quorvex?', true);
    expect(slugs).toContain('companies/quorvex');
    expect(slugs.filter(s => s.startsWith('people/'))).toEqual([]);
  });

  test('"Who works at <company>?" returns the founder as well as the engineer', async () => {
    const got = await topPages('Who works at Quorvex?');
    expect(got).toContain('people/alice-example-0');
    expect(got).toContain('people/bob-example-1');
  });

  test('a rewording whose words sit together only on the company page still returns the people', async () => {
    const got = await topPages('Which people are on the Quorvex team?');
    expect(got).toContain('companies/quorvex');
    expect(got.filter(s => ['people/alice-example-0', 'people/bob-example-1'].includes(s)).length).toBeGreaterThanOrEqual(1);
  });

  test('recall at 5 over the whole fixture', async () => {
    const template = await recallAt5(RELATION_QUESTIONS.filter(q => q.wording === 'template'));
    const reworded = await recallAt5(RELATION_QUESTIONS.filter(q => q.wording === 'reworded'));
    console.log(`[reworded-relations] recall@5 template=${template.toFixed(3)} reworded=${reworded.toFixed(3)}`);
    expect(template).toBeGreaterThanOrEqual(0.95);
    // Measured 0.650 with the retry reading timelines and 0.400 with titles alone; the run is deterministic.
    expect(reworded).toBeGreaterThanOrEqual(0.6);
  }, 120_000);
});
