/**
 * 产品经理能看懂的测试说明：
 * 这些测试用真实的临时数据库，确认关系补扫不会误伤：
 * 1. 显式双链不受中文停用词影响，普通正文里的“系统”“公司”不会自动连边。
 * 2. 一个汉字、同名多实体，都不猜。
 * 3. 有上下文的 NER 仍可给停用词建立类型关系。
 * 4. 新实体、新别名、类型变化只唤醒真正提到这个名字的旧页。
 * 5. 只改实体正文、普通笔记、旧目录哈希，都不会把全库重新入队。
 * 6. 不同 Source 互不唤醒；默认源实体可以唤醒各源里提到它的旧页。
 * 7. 删掉别名只删除对应的普通正文关系，显式链和 NER 关系留下。
 * 8. 预览不写数据库。大小写和全角名字按同一名字处理。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { extractStaleFromDB } from '../src/commands/extract-stale.ts';
import { runByMentionCore } from '../src/commands/extract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractNerLinks } from '../src/core/extract-ner.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'pmbrain-catalog-rules-'));
mkdirSync(join(home, '.pmbrain'));
writeFileSync(join(home, '.pmbrain', 'config.json'), JSON.stringify({
  schema_pack: 'gbrain-base',
  model_usage: { generative_enabled: false, embedding_enabled: false },
}));

let engine: PGLiteEngine;

const aware = {
  dryRun: false,
  jsonMode: true,
  includeFrontmatter: true,
  catchUp: true,
  quiet: true,
  catalogAware: true,
} as const;

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

async function page(sourceId: string, slug: string, type: string, title: string, body: string, frontmatter: Record<string, unknown> = {}): Promise<void> {
  await engine.putPage(slug, {
    type, title, compiled_truth: body, timeline: '', frontmatter,
  }, { sourceId });
}

async function stampFresh(slugs?: string[]): Promise<void> {
  await engine.executeRaw(
    `UPDATE pages
        SET links_extracted_at = '2099-01-01T00:00:00Z',
            updated_at = '2026-10-01T00:00:00Z'
      WHERE deleted_at IS NULL
        AND ($1::text[] IS NULL OR slug = ANY($1::text[]))`,
    [slugs ?? null],
  );
}

async function stampOf(sourceId: string, slug: string): Promise<string | null> {
  const rows = await engine.executeRaw<{ extracted: string | null }>(
    `SELECT links_extracted_at::text AS extracted
       FROM pages WHERE source_id = $1 AND slug = $2`,
    [sourceId, slug],
  );
  return rows[0]?.extracted ?? null;
}

async function linkRows(fromSlug: string, sourceId = 'default'): Promise<Array<{ to_slug: string; link_source: string; link_kind: string | null; link_type: string }>> {
  return engine.executeRaw(
    `SELECT t.slug AS to_slug, l.link_source, l.link_kind, l.link_type
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
      WHERE f.slug = $1 AND f.source_id = $2
      ORDER BY t.slug, l.link_source, l.link_type`,
    [fromSlug, sourceId],
  );
}

test('显式双链不受中文停用词影响，一字、同名和高频词不自动关联', async () => {
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('vault', 'Vault') ON CONFLICT (id) DO NOTHING`);
  await page('vault', 'people/ma', 'person', '马', '单字人物页。');
  await page('vault', 'people/zhang-a', 'person', '张三', '同名人物甲。');
  await page('vault', 'people/zhang-b', 'person', '张三', '同名人物乙。');
  await page('vault', 'concepts/system', 'concept', '系统', '系统可以是一个实体。');
  await page('vault', 'companies/knowledge-system', 'company', '知识系统', '更长的专名。');
  await page('vault', 'notes/loose', 'note', '未分类', '这篇不是实体。');
  await page('vault', 'notes/wiki', 'note', '显式', '参见 [[concepts/system]]。升级系统之后再看。马很常见。张三来了。知识系统已经上线。');

  const extracted = await extractStaleFromDB(engine, { ...aware, sourceIdFilter: 'vault' });
  expect(extracted.pagesProcessed).toBeGreaterThan(0);
  const afterExtract = await linkRows('notes/wiki', 'vault');
  expect(afterExtract).toContainEqual(expect.objectContaining({
    to_slug: 'concepts/system', link_source: 'markdown',
  }));

  await runByMentionCore(engine, { sourceIdFilter: 'vault', quiet: true });
  const links = await linkRows('notes/wiki', 'vault');
  expect(links.filter(row => row.link_source === 'mentions').map(row => row.to_slug)).toEqual(['companies/knowledge-system']);
  expect(links.some(row => row.to_slug === 'concepts/system' && row.link_source === 'markdown')).toBe(true);
  expect(links.some(row => row.to_slug === 'people/ma' || row.to_slug === 'people/zhang-a' || row.to_slug === 'people/zhang-b')).toBe(false);
}, 60_000);

test('停用词仍可由 NER 按上下文建立类型关系', async () => {
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('vault', 'Vault') ON CONFLICT (id) DO NOTHING`);
  await page('vault', 'companies/generic', 'company', '公司', '这是一个公司实体。');
  await page('vault', 'notes/job', 'note', '任职', 'She works at 公司 today and the team continues the work.');
  await runByMentionCore(engine, { sourceIdFilter: 'vault', quiet: true });
  const ner = await withEnv({
    PMBRAIN_HOME: home,
    GBRAIN_HOME: home,
    GBRAIN_SCHEMA_PACK: undefined,
    PMBRAIN_SCHEMA_PACK: undefined,
  }, () => extractNerLinks(engine, { sourceIdFilter: 'vault' }));
  expect(ner.pack_unavailable).toBe(false);
  const links = await linkRows('notes/job', 'vault');
  expect(links.some(row => row.to_slug === 'companies/generic' && row.link_kind == null)).toBe(false);
  expect(links).toContainEqual(expect.objectContaining({
    to_slug: 'companies/generic',
    link_source: 'mentions',
    link_kind: 'typed_ner',
    link_type: 'works_at',
  }));
}, 60_000);

test('新名字、类型变化和正文修改只按真实变化唤醒旧页', async () => {
  await page('default', 'notes/hit', 'note', '命中', '旧文提到灯塔计划，也写了星河实验室。');
  await page('default', 'notes/miss', 'note', '未命中', '这份旧文没有那些名字。');
  await page('default', 'companies/xinghe', 'company', '星河公司', '已有公司。');
  const baseline = await extractStaleFromDB(engine, aware);
  expect(baseline.pagesProcessed).toBe(3);
  await stampFresh();

  await page('default', 'projects/lighthouse', 'project', '灯塔计划', '新项目。');
  await page('default', 'companies/xinghe', 'company', '星河公司', '已有公司。', { aliases: ['星河实验室'] });
  const woken = await extractStaleFromDB(engine, aware);
  expect(woken.pagesProcessed).toBeGreaterThan(0);
  expect(await stampOf('default', 'notes/hit')).toContain('2099-01-01');
  expect(await linkRows('notes/hit')).toContainEqual(expect.objectContaining({
    to_slug: 'companies/xinghe', link_source: 'mentions',
  }));
  expect((await linkRows('notes/hit')).some(row => row.to_slug === 'projects/lighthouse')).toBe(false);
  expect(await stampOf('default', 'notes/miss')).toContain('2099-01-01');

  await stampFresh(['notes/hit', 'notes/miss']);
  await engine.executeRaw(
    `UPDATE pages
        SET links_extracted_at = '2026-10-01T00:00:00Z',
            updated_at = '2026-10-01T00:00:00Z'
      WHERE slug = 'companies/xinghe'`,
  );
  await page('default', 'companies/xinghe', 'company', '星河公司', '只补充了正文，没有改名。', { aliases: ['星河实验室'] });
  const bodyOnly = await extractStaleFromDB(engine, aware);
  expect(bodyOnly.pagesProcessed).toBe(1);
  expect(await stampOf('default', 'notes/hit')).toContain('2099-01-01');
  expect(await stampOf('default', 'notes/miss')).toContain('2099-01-01');
}, 60_000);

test('大小写和全角别名命中旧页，删除别名只清普通正文关系', async () => {
  await page('default', 'notes/case', 'note', '大小写', '正文写的是 ACME LABS 与 Ａｃｍｅ Ｌａｂｓ。');
  await page('default', 'notes/alias', 'note', '别名', '参见 [[companies/acme]]。OpenAI Labs 提供模型。');
  await page('default', 'notes/quiet', 'note', '安静', '这里没有这些名字。');
  await extractStaleFromDB(engine, aware);
  await stampFresh();
  await page('default', 'companies/acme', 'company', 'Acme Labs', '新公司。');
  await extractStaleFromDB(engine, aware);
  expect(await stampOf('default', 'notes/case')).toContain('2099-01-01');
  expect(await linkRows('notes/case')).toContainEqual(expect.objectContaining({
    to_slug: 'companies/acme', link_source: 'mentions',
  }));
  expect(await stampOf('default', 'notes/quiet')).toContain('2099-01-01');

  await stampFresh();
  await page('default', 'companies/acme', 'company', 'Acme Labs', '先加上别名。', { aliases: ['OpenAI Labs'] });
  await extractStaleFromDB(engine, aware);
  await stampFresh();
  await page('default', 'companies/acme', 'company', 'Acme Labs', '去掉别名。');
  await engine.addLinksBatch([
    {
      from_slug: 'notes/alias', to_slug: 'companies/acme',
      link_type: 'mentions', link_source: 'mentions', context: 'OpenAI Labs',
      from_source_id: 'default', to_source_id: 'default',
    },
    {
      from_slug: 'notes/alias', to_slug: 'companies/acme',
      link_type: 'works_at', link_source: 'mentions', link_kind: 'typed_ner', context: 'OpenAI Labs',
      from_source_id: 'default', to_source_id: 'default',
    },
  ]);
  await extractStaleFromDB(engine, aware);
  expect(await stampOf('default', 'notes/alias')).toContain('2099-01-01');
  expect(await stampOf('default', 'notes/quiet')).toContain('2099-01-01');
  const links = await linkRows('notes/alias');
  expect(links.some(row => row.link_source === 'mentions' && row.link_kind == null)).toBe(false);
  expect(links).toContainEqual(expect.objectContaining({ link_source: 'markdown', to_slug: 'companies/acme' }));
  expect(links).toContainEqual(expect.objectContaining({ link_kind: 'typed_ner', link_type: 'works_at' }));
}, 60_000);

test('Source 隔离，默认源实体可以唤醒其他源里提到它的旧页', async () => {
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('vault', 'Vault'), ('other', 'Other') ON CONFLICT (id) DO NOTHING`);
  await page('vault', 'notes/local', 'note', '本地', 'Acme Labs 在本地出现。');
  await page('other', 'notes/foreign', 'note', '外源', 'Acme Labs 在外源出现。');
  await page('default', 'notes/shared', 'note', '默认', 'Beacon Labs 在默认正文出现。');
  await page('vault', 'notes/beacon', 'note', '信标', 'Beacon Labs 在库内出现。');
  await page('other', 'notes/quiet', 'note', '安静', '外源这份没有信标。');
  await extractStaleFromDB(engine, aware);
  await stampFresh();

  await page('vault', 'companies/acme', 'company', 'Acme Labs', '库内公司。');
  await extractStaleFromDB(engine, aware);
  expect(await stampOf('vault', 'notes/local')).toContain('2099-01-01');
  expect(await linkRows('notes/local', 'vault')).toContainEqual(expect.objectContaining({
    to_slug: 'companies/acme', link_source: 'mentions',
  }));
  expect(await linkRows('notes/foreign', 'other')).toEqual([]);
  expect(await stampOf('other', 'notes/foreign')).toContain('2099-01-01');
  expect(await stampOf('default', 'notes/shared')).toContain('2099-01-01');

  await stampFresh();
  await page('default', 'companies/beacon', 'company', 'Beacon Labs', '共享实体。');
  await extractStaleFromDB(engine, aware);
  expect(await stampOf('default', 'notes/shared')).toContain('2099-01-01');
  expect(await stampOf('vault', 'notes/beacon')).toContain('2099-01-01');
  expect(await linkRows('notes/shared')).toContainEqual(expect.objectContaining({
    to_slug: 'companies/beacon', link_source: 'mentions',
  }));
  expect(await linkRows('notes/beacon', 'vault')).toContainEqual(expect.objectContaining({
    to_slug: 'companies/beacon', link_source: 'mentions',
  }));
  expect(await stampOf('other', 'notes/quiet')).toContain('2099-01-01');
}, 60_000);

test('预览不写水位、不删关系、不保存新目录', async () => {
  await page('default', 'notes/history', 'note', '旧文', '旧文提到潮汐方法。');
  await page('default', 'companies/keep', 'company', '保留公司', '基线实体。');
  await extractStaleFromDB(engine, aware);
  await stampFresh();
  await engine.addLinksBatch([{
    from_slug: 'notes/history', to_slug: 'companies/keep',
    link_type: 'mentions', link_source: 'mentions', context: '保留公司',
    from_source_id: 'default', to_source_id: 'default',
  }]);
  const beforeConfig = await engine.getConfig('extract.relations.catalog.all');
  await page('default', 'concepts/tide', 'concept', '潮汐方法', '新概念。');
  const preview = await extractStaleFromDB(engine, { ...aware, dryRun: true });
  expect(preview.pagesProcessed).toBe(0);
  expect(preview.staleRemaining).toBeGreaterThan(0);
  expect(await stampOf('default', 'notes/history')).toContain('2099-01-01');
  expect(await engine.getConfig('extract.relations.catalog.all')).toBe(beforeConfig);
  const links = await linkRows('notes/history');
  expect(links).toContainEqual(expect.objectContaining({ to_slug: 'companies/keep', link_source: 'mentions' }));
}, 60_000);

test('旧目录哈希不再参与索引，也不把已抽过的页面重新入队', async () => {
  await page('default', 'notes/keep', 'note', '保持', '普通旧文。');
  await page('default', 'companies/keep', 'company', '保留公司', '基线实体。');
  await extractStaleFromDB(engine, aware);
  await stampFresh();
  const legacy=JSON.stringify({ hash: 'outdated', versionTs: new Date().toISOString() });
  await engine.setConfig('extract.relations.catalog.all', legacy);
  const result = await extractStaleFromDB(engine, aware);
  expect(result.pagesProcessed).toBe(0);
  expect(await stampOf('default', 'notes/keep')).toContain('2099-01-01');
  const saved = await engine.getConfig('extract.relations.catalog.all');
  expect(saved).toBe(legacy);
  expect((await runByMentionCore(engine,{quiet:true})).pages).toBe(0);
}, 60_000);
