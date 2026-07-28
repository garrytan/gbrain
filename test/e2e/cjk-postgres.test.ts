/**
 * PostgreSQL-only CJK keyword fallback E2E.
 *
 * Run against a disposable database only:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/gbrain_test \
 *     bun test test/e2e/cjk-postgres.test.ts
 *
 * Never point this test at an operator brain: beforeEach truncates sources,
 * pages, and their dependent rows.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const describePostgres = DATABASE_URL ? describe : describe.skip;

describePostgres('Postgres CJK keyword fallback', () => {
  let engine: PostgresEngine;

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! });
    await engine.initSchema();
  }, 30_000);

  afterAll(async () => {
    await engine?.disconnect();
  });

  beforeEach(async () => {
    await engine.executeRaw('TRUNCATE sources CASCADE');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config, archived)
       VALUES
         ('default', 'Default', '{}'::jsonb, false),
         ('alpha', 'Alpha', '{}'::jsonb, false),
         ('beta', 'Beta', '{}'::jsonb, false),
         ('archived', 'Archived', '{}'::jsonb, true)`,
    );
  });

  async function addPage(
    sourceId: string,
    slug: string,
    body: string,
    type = 'note',
  ): Promise<void> {
    const result = await importFromContent(
      engine,
      slug,
      `---\ntype: ${type}\ntitle: ${slug}\n---\n\n${body}`,
      { noEmbed: true, sourceId },
    );
    expect(result.status).toBe('imported');
  }

  test('finds Chinese, Japanese, and Korean substrings', async () => {
    await addPage('default', 'notes/chinese', '这是一个中文测试文档。中文测试内容很重要。');
    await addPage('default', 'notes/japanese', '日本語検索テストです。検索結果を確認します。');
    await addPage('default', 'notes/korean', '한글 검색 테스트 문서입니다. 결과를 확인합니다.');

    expect((await engine.searchKeyword('中文测试'))[0]?.slug).toBe('notes/chinese');
    expect((await engine.searchKeyword('日本語検索'))[0]?.slug).toBe('notes/japanese');
    expect((await engine.searchKeyword('한글 검색'))[0]?.slug).toBe('notes/korean');
  });

  test('mixed CJK/ASCII matching and score use the same case-insensitive semantics', async () => {
    await addPage(
      'default',
      'notes/mixed-case',
      '测试 Framework Framework validates the mixed-language retrieval path.',
    );

    const [hit] = await engine.searchKeyword('测试 framework');
    expect(hit?.slug).toBe('notes/mixed-case');
    expect(Number.isFinite(hit?.score)).toBe(true);
    expect(hit!.score).toBeGreaterThan(0);
  });

  test('sourceId and sourceIds prevent cross-source leakage', async () => {
    await addPage('alpha', 'notes/alpha-only', '隔离测试 alpha content.');
    await addPage('beta', 'notes/beta-only', '隔离测试 beta content.');

    const alpha = await engine.searchKeyword('隔离测试', { sourceId: 'alpha' });
    expect(alpha.map(hit => hit.source_id)).toEqual(['alpha']);

    const federated = await engine.searchKeyword('隔离测试', {
      sourceIds: ['alpha', 'beta'],
      limit: 10,
    });
    expect(new Set(federated.map(hit => hit.source_id))).toEqual(new Set(['alpha', 'beta']));
  });

  test('hides archived sources and soft-deleted pages', async () => {
    await addPage('default', 'notes/visible', '可见性测试 visible.');
    await addPage('default', 'notes/deleted', '可见性测试 deleted.');
    await addPage('archived', 'notes/archived', '可见性测试 archived.');
    await engine.executeRaw(
      `UPDATE pages SET deleted_at = now()
       WHERE source_id = $1 AND slug = $2`,
      ['default', 'notes/deleted'],
    );

    const hits = await engine.searchKeyword('可见性测试', { limit: 10 });
    expect(hits.map(hit => hit.slug)).toEqual(['notes/visible']);
  });

  test('page-grain pagination remains stable after per-page dedup', async () => {
    await addPage('default', 'notes/page-one', '分页测试 分页测试 分页测试');
    await addPage('default', 'notes/page-two', '分页测试 分页测试');
    await addPage('default', 'notes/page-three', '分页测试');

    const first = await engine.searchKeyword('分页测试', { limit: 1, offset: 0 });
    const second = await engine.searchKeyword('分页测试', { limit: 1, offset: 1 });
    const third = await engine.searchKeyword('分页测试', { limit: 1, offset: 2 });

    expect(first[0]?.slug).toBe('notes/page-one');
    expect(second[0]?.slug).toBe('notes/page-two');
    expect(third[0]?.slug).toBe('notes/page-three');
  });

  test('chunk-grain search preserves filters and pagination', async () => {
    await addPage('default', 'notes/chunks', 'placeholder');
    await engine.upsertChunks('notes/chunks', [
      {
        chunk_index: 0,
        chunk_text: '锚点测试 锚点测试 锚点测试',
        chunk_source: 'compiled_truth',
        token_count: 3,
        language: 'zh',
      },
      {
        chunk_index: 1,
        chunk_text: '锚点测试 锚点测试',
        chunk_source: 'compiled_truth',
        token_count: 2,
        language: 'zh',
      },
      {
        chunk_index: 2,
        chunk_text: '锚点测试',
        chunk_source: 'compiled_truth',
        token_count: 1,
        language: 'ja',
      },
    ], { sourceId: 'default' });

    const first = await engine.searchKeywordChunks('锚点测试', {
      sourceId: 'default',
      language: 'zh',
      limit: 1,
      offset: 0,
    });
    const second = await engine.searchKeywordChunks('锚点测试', {
      sourceId: 'default',
      language: 'zh',
      limit: 1,
      offset: 1,
    });

    expect(first[0]?.chunk_index).toBe(0);
    expect(second[0]?.chunk_index).toBe(1);
    expect(first[0]?.source_id).toBe('default');
    expect(second[0]?.source_id).toBe('default');
  });
});
