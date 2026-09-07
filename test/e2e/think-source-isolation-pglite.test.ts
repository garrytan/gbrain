import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runGather } from '../../src/core/think/gather.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from '../helpers/legacy-embedding-config.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
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
    const imported = await importFromContent(engine, slug,
      serializeMarkdown({}, body, '', { type: 'person', title: slug, tags: [] }),
      { sourceId, noEmbed: true });
    expect(imported.status).toBe('imported');
    const page = (await engine.getPage(slug, { sourceId }))!;
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
  try { await engine.disconnect(); } finally { resetGateway(); }
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

  test('unindexed anchor keeps its source identity and sanitizes remote body reads', async () => {
    const slug = 'people/unindexed-anchor';
    const question = 'zzunindexedidentityprobezz';
    const publicBody = 'Public unindexed anchor control.';
    const privateBody = 'PRIVATE_UNINDEXED_ANCHOR_CANARY';
    const deniedBody = 'DENIED_UNINDEXED_ANCHOR_CANARY';
    const anchor = await engine.putPage(slug, {
      type: 'person', title: 'Unindexed anchor', timeline: '',
      compiled_truth: `${publicBody}\n<!--- gbrain:takes:begin -->\n${privateBody}\n<!--- gbrain:takes:end -->`,
    }, { sourceId: 'think-a' });
    await engine.putPage(slug, {
      type: 'person', title: 'Denied namesake', compiled_truth: deniedBody, timeline: '',
    }, { sourceId: 'think-denied' });
    expect(await engine.getChunks(slug, { sourceId: 'think-a' })).toEqual([]);

    for (const remote of [undefined, true]) {
      const result = await runGather(engine, {
        question, anchor: slug, sourceId: 'think-a', remote,
      });
      expect(result.diagnostics.pagesFromHybrid).toBe(0);
      expect(result.pages).toHaveLength(1);
      const row = result.pages[0];
      expect(row.page_id).toBe(anchor.id);
      expect(row.source_id).toBe('think-a');
      expect(row.chunk_id).toBe(0);
      expect(row.score).toBe(1);
      expect(row.chunk_text).toContain(publicBody);
      expect(row.chunk_text).not.toContain(privateBody);
      expect(row.chunk_text).not.toContain(deniedBody);
      expect(result.warnings).not.toContain('ANCHOR_PAGE_NOT_FOUND');
    }

    const local = await runGather(engine, {
      question, anchor: slug, sourceId: 'think-a', remote: false,
    });
    expect(local.pages[0].source_id).toBe('think-a');
    expect(local.pages[0].chunk_text).toContain(privateBody);

    const denied = await runGather(engine, {
      question, anchor: slug, sourceId: 'think-b', remote: true,
    });
    expect(denied.pages).toEqual([]);
    expect(denied.warnings).toContain('ANCHOR_PAGE_NOT_FOUND');
  }, 20_000);
});
