/**
 * 产品经理可读的测试说明：
 *
 * 以前只要有页面、实体或别名变化，关系补扫就会把整个 Source 标成待处理。
 * 资料一多，维护会一直重扫，看起来像卡死。
 *
 * 这组测试确认改完后的行为：
 * 1. 普通资料新增或修改，只重做这一份。
 * 2. 新建实体，或给已有实体加别名，只把正文里可能提到新名字、新别名或实体路径的旧资料放进补关联队列。
 * 3. 没有提到的旧资料保持原水位，不会被重做。
 * 4. 升级前留下的旧目录哈希，不能再把全库抬成待扫。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { extractStaleFromDB } from '../src/commands/extract-stale.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
});

const opts = {
  dryRun: false,
  jsonMode: true,
  includeFrontmatter: true,
  sourceIdFilter: 'default',
  catchUp: true,
  quiet: true,
  catalogAware: true,
} as const;

async function stamps(): Promise<Map<string, string | null>> {
  const rows = await engine.executeRaw<{ slug: string; extracted: string | null }>(
    `SELECT slug, links_extracted_at::text AS extracted
       FROM pages
      WHERE source_id = 'default'
      ORDER BY slug`,
  );
  return new Map(rows.map(row => [row.slug, row.extracted]));
}

async function seedBaseline(): Promise<void> {
  await engine.putPage('notes/keep', {
    type: 'note', title: '保持不动', compiled_truth: '这份资料没有新实体。',
  });
  await engine.putPage('notes/history', {
    type: 'note', title: '旧文', compiled_truth: '参见 [[concepts/graph]]。',
  });
  await engine.putPage('notes/alias', {
    type: 'note', title: '别名旧文', compiled_truth: 'OpenAI Labs 提供模型。',
  });
  await engine.putPage('companies/openai', {
    type: 'company', title: 'OpenAI', compiled_truth: '',
  });
  const first = await extractStaleFromDB(engine, opts);
  expect(first.pagesProcessed).toBe(4);
  expect(first.staleRemaining).toBe(0);
}

describe('实体变化不再让整个 Source 重新抽关系', () => {
  test('普通资料新增或修改时，只重做这份资料', async () => {
    await seedBaseline();
    const before = await stamps();

    await engine.putPage('notes/keep', {
      type: 'note', title: '保持不动', compiled_truth: '这份资料刚刚改过正文。',
    });
    await engine.putPage('notes/new-note', {
      type: 'note', title: '新资料', compiled_truth: '一份普通新资料。',
    });

    const result = await extractStaleFromDB(engine, opts);
    const after = await stamps();

    expect(result.pagesProcessed).toBe(2);
    expect(result.staleRemaining).toBe(0);
    expect(after.get('notes/history')).toBe(before.get('notes/history'));
    expect(after.get('notes/alias')).toBe(before.get('notes/alias'));
    expect(after.get('companies/openai')).toBe(before.get('companies/openai'));
    expect(after.get('notes/keep')).not.toBe(before.get('notes/keep'));
    expect(after.get('notes/new-note')).toBeTruthy();
  });

  test('新实体和新别名只重做可能提到它们的旧资料', async () => {
    await seedBaseline();
    await engine.executeRaw(
      `UPDATE pages
          SET links_extracted_at = '2099-01-01T00:00:00Z',
              updated_at = '2026-10-01T00:00:00Z'
        WHERE source_id = 'default'
          AND slug IN ('notes/keep', 'notes/history', 'notes/alias')`,
    );
    const before = await stamps();

    await engine.putPage('concepts/graph', {
      type: 'concept', title: '知识图谱', compiled_truth: '',
    });
    await engine.putPage('companies/openai', {
      type: 'company',
      title: 'OpenAI',
      compiled_truth: '新增别名 OpenAI Labs。',
      frontmatter: { aliases: ['OpenAI Labs'] },
    });

    const result = await extractStaleFromDB(engine, opts);
    const after = await stamps();
    const links = await engine.executeRaw<{ from_slug: string; to_slug: string; link_source: string }>(
      `SELECT f.slug AS from_slug, t.slug AS to_slug, l.link_source
         FROM links l
         JOIN pages f ON f.id = l.from_page_id
         JOIN pages t ON t.id = l.to_page_id
        WHERE f.source_id = 'default' AND t.slug = 'concepts/graph'`,
    );

    expect(result.pagesProcessed).toBe(4);
    expect(after.get('notes/keep')).toBe(before.get('notes/keep'));
    expect(after.get('notes/history')).not.toBe(before.get('notes/history'));
    expect(after.get('notes/alias')).toBe(before.get('notes/alias'));
    const mentions = await engine.executeRaw<{ to_slug: string }>(
      `SELECT t.slug AS to_slug FROM links l
         JOIN pages f ON f.id = l.from_page_id
         JOIN pages t ON t.id = l.to_page_id
        WHERE f.source_id = 'default' AND f.slug = 'notes/alias' AND l.link_source = 'mentions'`,
    );
    expect(mentions).toEqual([{ to_slug: 'companies/openai' }]);
    expect(links).toContainEqual({
      from_slug: 'notes/history',
      to_slug: 'concepts/graph',
      link_source: 'markdown',
    });

    const again = await extractStaleFromDB(engine, opts);
    expect(again.pagesProcessed).toBe(0);
  });

  test('旧的目录哈希记录不会再把已抽过的资料全部标成待扫', async () => {
    await seedBaseline();
    const before = await stamps();
    const legacy=JSON.stringify({ hash: 'outdated', versionTs: new Date().toISOString() });
    await engine.setConfig(
      'extract.relations.catalog.source:default',
      legacy,
    );

    const result = await extractStaleFromDB(engine, opts);
    const after = await stamps();

    expect(result.pagesProcessed).toBe(0);
    expect(result.staleRemaining).toBe(0);
    expect(after.get('notes/keep')).toBe(before.get('notes/keep'));
    expect(after.get('notes/history')).toBe(before.get('notes/history'));
    expect(after.get('notes/alias')).toBe(before.get('notes/alias'));
    const saved = await engine.getConfig('extract.relations.catalog.source:default');
    expect(saved).toBe(legacy);
    expect((await extractStaleFromDB(engine,opts)).pagesProcessed).toBe(0);
  });
});
