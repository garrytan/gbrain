import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runGather } from '../../src/core/think/gather.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  for (const sourceId of ['think-a', 'think-b', 'think-denied']) {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT DO NOTHING`,
      [sourceId],
    );
  }

  const fixtures = [
    ['think-a', 'people/think-anchor', 'authorized thinkscope anchor'],
    ['think-b', 'people/think-allowed', 'authorized thinkscope evidence'],
    ['think-denied', 'people/think-denied', 'denied thinkscope evidence'],
  ] as const;
  const takeVector = new Float32Array(1536).fill(0.01);
  for (const [sourceId, slug, body] of fixtures) {
    const page = await engine.putPage(slug, {
      type: 'person', title: slug, compiled_truth: body, timeline: '', frontmatter: {},
    }, { sourceId });
    await engine.upsertChunks(slug, [{
      chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth', token_count: 4,
    }], { sourceId });
    await engine.addTakesBatch([{
      page_id: page.id, row_num: 1, claim: 'thinkscope evidence',
      kind: 'fact', holder: 'world', weight: 1,
    }]);
    await engine.executeRaw(
      `UPDATE takes SET embedding = $1::vector WHERE page_id = $2`,
      [`[${Array.from(takeVector).join(',')}]`, page.id],
    );
  }

  await engine.addLink(
    'people/think-anchor', 'people/think-allowed', '', 'related', 'manual',
    undefined, undefined, { fromSourceId: 'think-a', toSourceId: 'think-b' },
  );
  await engine.addLink(
    'people/think-anchor', 'people/think-denied', '', 'related', 'manual',
    undefined, undefined, { fromSourceId: 'think-a', toSourceId: 'think-denied' },
  );
});

afterAll(async () => {
  await engine.disconnect();
});

describe('think gather source isolation (#2200)', () => {
  test('federated scope reaches hybrid, takes keyword/vector, and graph traversal', async () => {
    const result = await runGather(engine, {
      question: 'thinkscope evidence',
      anchor: 'people/think-anchor',
      questionEmbedding: new Float32Array(1536).fill(0.01),
      sourceIds: ['think-a', 'think-b'],
      gatherLimit: 50,
      takesLimit: 50,
      graphDepth: 2,
    });

    expect(result.pages.some(row => row.source_id === 'think-b')).toBe(true);
    expect(result.pages.every(row => row.source_id !== 'think-denied')).toBe(true);
    expect(result.takes.some(row => row.page_slug === 'people/think-allowed')).toBe(true);
    expect(result.takes.every(row => row.page_slug !== 'people/think-denied')).toBe(true);
    expect(result.graphSlugs).toContain('people/think-allowed');
    expect(result.graphSlugs).not.toContain('people/think-denied');
  }, 20_000);

  test('scalar sourceId reaches every gather stream', async () => {
    const result = await runGather(engine, {
      question: 'thinkscope evidence',
      anchor: 'people/think-anchor',
      questionEmbedding: new Float32Array(1536).fill(0.01),
      sourceId: 'think-a',
      gatherLimit: 50,
      takesLimit: 50,
      graphDepth: 2,
    });

    expect(result.pages.every(row => row.source_id === 'think-a')).toBe(true);
    expect(result.takes.every(row => row.page_slug === 'people/think-anchor')).toBe(true);
    expect(result.graphSlugs).not.toContain('people/think-allowed');
    expect(result.graphSlugs).not.toContain('people/think-denied');
  }, 20_000);
});
