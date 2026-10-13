import { beforeAll, afterAll, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine';
import { PostgresEngine } from '../src/core/postgres-engine';
import type { BrainEngine } from '../src/core/engine';
import { configureGateway, resetGateway, DEFAULT_EMBEDDING_DIMENSIONS, __setEmbedTransportForTests } from '../src/core/ai/gateway';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard';
import { WorkbenchStore } from '../src/product/workbench/store';
import { WorkbenchMemoryCoordinator, runWorkbenchMemoryTask, recallWorkbenchMemory } from '../src/product/workbench/memory';
import { nativeMemoryHandlers } from '../src/product/workbench/memory-tools';
import { operationsByName } from '../src/core/operations';
import { importFromContent } from '../src/core/import-file';
import { runPhaseConsolidate } from '../src/core/cycle/phases/consolidate';
import { forgetFactInFence } from '../src/core/facts/forget';
import { dispatchToolCall } from '../src/mcp/dispatch';
import { SemanticQueryCache } from '../src/core/search/query-cache';
import { getBrainHotMemoryMeta, __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook';
import type { WorkbenchConversation, WorkbenchMessage } from '../shared/workbench';

const root = mkdtempSync(join(tmpdir(), 'pmbrain-memory-lifecycle-'));
const previous = process.env.PMBRAIN_HOME;
const url = process.env.PMBRAIN_MEMORY_TEST_DATABASE_URL;
if (url) assertSafeE2eDatabaseUrl(url);
const engine: BrainEngine = url ? new PostgresEngine() : new PGLiteEngine();
const store = new WorkbenchStore(join(root, 'sessions'));
const coordinator = new WorkbenchMemoryCoordinator(engine, store, async () => ({ id: 'task-test', status: 'queued' } as any), async () => null);
const ctx: any = { engine, sourceId: 'lifecycle', remote: true, config: { engine: engine.kind }, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
beforeAll(async () => {
  process.env.PMBRAIN_HOME = root;
  mkdirSync(join(root, '.pmbrain'));
  writeFileSync(join(root, '.pmbrain', 'config.json'), JSON.stringify({ engine: engine.kind, memory: { auto_writeback: 'all' } }));
  configureGateway({ env: {} });
  await engine.connect(url ? { database_url: url } : {}); await engine.initSchema();
  await engine.setConfig('memory.auto_writeback', 'all'); await engine.setConfig('facts.default_visibility', 'world');
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES ('lifecycle','隔离记忆验收'),('foreign','异源验收') ON CONFLICT DO NOTHING");
}, 60000);
afterAll(async () => { coordinator.close(); await engine.disconnect(); resetGateway(); __resetHotMemoryCacheForTests(); if (previous === undefined) delete process.env.PMBRAIN_HOME; else process.env.PMBRAIN_HOME = previous; });

async function capture(text: string, facts: any[], organize?: (path: string, sourceId: string) => Promise<unknown>) {
  const message: WorkbenchMessage = { id: randomUUID(), role: 'user', text, createdAt: new Date().toISOString(), status: 'complete' };
  const conversation: WorkbenchConversation = { id: randomUUID(), title: '生命周期', model: 'ollama:test', sourceId: 'lifecycle', knowledge: true, createdAt: message.createdAt, updatedAt: message.createdAt, messages: [message] };
  message.memory = await coordinator.capture(conversation, message); store.save(conversation);
  const input = { root: store.root, sourceId: 'lifecycle', conversationId: conversation.id, messageId: message.id, hash: message.memory.hash };
  const result = await runWorkbenchMemoryTask(engine, input, new AbortController().signal, { extract: (async () => facts.map(fact => ({ kind: 'fact', entity_slug: null, embedding: null, ...fact }))) as any, organize });
  return { conversation, message, input, slug: String(result.archiveSlug), ids: store.get(conversation.id).messages[0].memory!.factIds! };
}

test('明确遗忘刷新部分派生页，原句历史和正式 Wiki 原样保留', async () => {
  const f = await capture('冷杉偏好青色，云杉偏好黄色', [{ fact: '冷杉偏好青色' }, { fact: '云杉偏好黄色' }]);
  const original = store.get(f.conversation.id).messages[0].text;
  const page = await engine.getPage(f.slug, { sourceId: 'lifecycle' });
  await engine.putPage('wiki/lifecycle-saved', page!, { sourceId: 'lifecycle' });
  const wiki = await engine.getPage('wiki/lifecycle-saved', { sourceId: 'lifecycle' });
  const forget = await capture('请忘记冷杉颜色偏好', []);
  const handlers = nativeMemoryHandlers(engine, 'lifecycle', forget.conversation.id, { store, tasks: {} as any }, () => 1, new Map());
  const result: any = await handlers.get('memory_forget')!.execute({ fact_id: f.ids[0] }, new AbortController().signal);
  expect(result.ok).toBe(true);
  const updated: any = await operationsByName.get_page.handler(ctx, { slug: f.slug });
  expect(JSON.stringify(updated)).not.toContain('冷杉偏好青色');
  expect(JSON.stringify(updated)).toContain('云杉偏好黄色');
  expect(store.get(f.conversation.id).messages[0].text).toBe(original);
  expect((await engine.getPage('wiki/lifecycle-saved', { sourceId: 'lifecycle' }))?.compiled_truth).toBe(wiki?.compiled_truth);
}, 60000);

test('遗忘后所有会话的 MCP 热记忆附带缓存立即失效', async () => {
  __resetHotMemoryCacheForTests();
  const f = await capture('柳杉材料只采用蓝色', [{ fact: '柳杉材料只采用蓝色', kind: 'preference' }]);
  const session = { ...ctx, source_session: f.conversation.id };
  expect(JSON.stringify(await getBrainHotMemoryMeta('get_page', ctx, { topK: 25 }))).toContain('柳杉材料只采用蓝色');
  expect(JSON.stringify(await getBrainHotMemoryMeta('get_page', session))).toContain('柳杉材料只采用蓝色');
  await forgetFactInFence(engine, f.ids[0], { sourceId: 'lifecycle' });
  expect(JSON.stringify(await getBrainHotMemoryMeta('get_page', ctx, { topK: 25 })) ?? '').not.toContain('柳杉材料只采用蓝色');
  expect(JSON.stringify(await getBrainHotMemoryMeta('get_page', session)) ?? '').not.toContain('柳杉材料只采用蓝色');
  const external = await capture('水杉材料保留日期', [{ fact: '水杉材料保留日期' }]);
  const workerSession = { ...ctx, source_session: external.conversation.id };
  expect(JSON.stringify(await getBrainHotMemoryMeta('get_page', workerSession))).toContain('水杉材料保留日期');
  await engine.expireFact(external.ids[0]);
  expect(JSON.stringify(await getBrainHotMemoryMeta('get_page', workerSession)) ?? '').not.toContain('水杉材料保留日期');
}, 60000);

test('到期立即挡住旧快照，后台刷新有效内容，全部失效软删除并清理派生关系', async () => {
  await importFromContent(engine, 'people/lifecycle-birch', '---\ntitle: 白桦\ntype: person\n---\n\n原始人物资料。', { sourceId: 'lifecycle', noEmbed: true });
  const f = await capture('白桦今天在长沙，白桦报告保留日期', [{ fact: '白桦今天在长沙', entity_slug: 'people/lifecycle-birch', valid_until: new Date(Date.now() + 60000) }, { fact: '白桦报告保留日期', entity_slug: 'people/lifecycle-birch' }]);
  await engine.executeRaw('UPDATE facts SET valid_until=now()-interval \'1 second\' WHERE id=$1', [f.ids[0]]);
  await expect(operationsByName.get_page.handler(ctx, { slug: f.slug })).rejects.toThrow();
  expect((await engine.listPages({ sourceId: 'lifecycle' })).some(page => page.slug===f.slug)).toBe(false);
  expect(JSON.stringify(await operationsByName.search.handler(ctx, { query: '长沙', limit: 20 }))).not.toContain(f.slug);
  await coordinator.scan(f.conversation.id);
  const updated: any = await operationsByName.get_page.handler(ctx, { slug: f.slug });
  expect(JSON.stringify(updated)).not.toContain('长沙'); expect(JSON.stringify(updated)).toContain('白桦报告保留日期');
  const chunks = await engine.getChunks(f.slug, { sourceId: 'lifecycle' });
  expect(JSON.stringify(chunks)).not.toContain('长沙');
  await forgetFactInFence(engine, f.ids[1], { sourceId: 'lifecycle' }); await coordinator.scan(f.conversation.id);
  expect(await engine.getPage(f.slug, { sourceId: 'lifecycle' })).toBeNull();
  expect((await engine.getPage(f.slug, { sourceId: 'lifecycle', includeDeleted: true }))?.deleted_at).toBeTruthy();
  const links = await engine.executeRaw('SELECT l.* FROM links l JOIN pages p ON p.id=l.from_page_id WHERE p.source_id=$1 AND p.slug=$2', ['lifecycle', f.slug]);
  expect(links).toHaveLength(0);
  expect((await engine.getPage('people/lifecycle-birch', { sourceId: 'lifecycle' }))?.compiled_truth).toContain('原始人物资料');
  expect(await recallWorkbenchMemory(engine, { sourceId: 'lifecycle', query: '白桦' })).toHaveLength(0);
}, 60000);

test('遗忘同步刷新 Dream 待整理副本，派生页已删除时也不残留旧待整理内容', async () => {
  const f = await capture('青枫材料保留日期，赤枫材料保留出处', [{ fact: '青枫材料保留日期' }, { fact: '赤枫材料保留出处' }], async () => undefined);
  const path = join(store.root, 'memory', f.conversation.id, `${createHash('sha256').update(`${f.message.id}:${f.input.hash}`).digest('hex')}.md`);
  expect(readFileSync(path, 'utf8')).toContain('青枫材料保留日期');
  await forgetFactInFence(engine, f.ids[0], { sourceId: 'lifecycle' }); await coordinator.scan(f.conversation.id);
  expect(readFileSync(path, 'utf8')).not.toContain('青枫材料保留日期');
  expect(readFileSync(path, 'utf8')).toContain('赤枫材料保留出处');
  await engine.softDeletePage(f.slug, { sourceId: 'lifecycle' });
  await forgetFactInFence(engine, f.ids[1], { sourceId: 'lifecycle' }); await coordinator.scan(f.conversation.id);
  expect(existsSync(path)).toBe(false);
}, 60000);

test('外部 MCP 遗忘与纠正采用同一失效规则，不覆盖用户修改的原生页面', async () => {
  const f = await capture('落叶松周报采用青色', [{ fact: '落叶松周报采用青色', kind: 'preference' }]);
  const edited = await engine.getPage(f.slug, { sourceId: 'lifecycle' });
  await engine.putPage(f.slug, { ...edited!, compiled_truth: `${edited!.compiled_truth}\n\n用户补充的正式内容。` }, { sourceId: 'lifecycle' });
  const forgotten = await dispatchToolCall(engine, 'forget', { id: String(f.ids[0]) }, { sourceId: 'lifecycle', remote: true, auth: { token: 'fixture', clientId: 'external-fixture', scopes: ['read','write'], allowedSources: ['lifecycle'] } });
  expect(forgotten.isError).not.toBe(true);
  expect((await dispatchToolCall(engine, 'get_page', { slug: f.slug }, { sourceId: 'lifecycle', remote: true })).isError).toBe(true);
  await coordinator.scan(f.conversation.id);
  expect((await engine.getPage(f.slug, { sourceId: 'lifecycle', includeDeleted: true }))?.compiled_truth).toContain('用户补充的正式内容');
  await expect(operationsByName.get_page.handler(ctx, { slug: f.slug })).rejects.toThrow();
  const old = await capture('银杏验收先写结论', [{ fact: '银杏验收先写结论', kind: 'preference' }]);
  await capture('更正银杏验收先写依据', [{ fact: '银杏验收先写依据', kind: 'preference', supersedes: old.ids[0] }]);
  await coordinator.scan(old.conversation.id);
  expect(JSON.stringify(await operationsByName.search.handler(ctx, { query: '银杏验收先写结论', limit: 20 }))).not.toContain(old.slug);
  expect(await engine.getPage(old.slug, { sourceId: 'lifecycle' })).toBeNull();
}, 60000);

test('旧版无事实数组的派生页也执行到期过滤，失败后重启扫描恢复刷新', async () => {
  const f = await capture('榆树临时在南京，榆树工作采用中文', [{ fact: '榆树临时在南京' }, { fact: '榆树工作采用中文' }]);
  const page = await engine.getPage(f.slug, { sourceId: 'lifecycle' });
  const legacy = { ...page!.frontmatter }; delete legacy.pmbrain_memory_fact_ids; delete legacy.pmbrain_memory_origin;
  await engine.putPage(f.slug, { ...page!, frontmatter: legacy }, { sourceId: 'lifecycle' });
  await engine.executeRaw('UPDATE facts SET valid_until=now()-interval \'1 second\' WHERE id=$1', [f.ids[0]]);
  await expect(operationsByName.get_page.handler(ctx, { slug: f.slug })).rejects.toThrow();
  const transaction = engine.transaction;
  try {
    engine.transaction = async () => { throw new Error('夹具刷新事务不可用'); };
    await expect(coordinator.scan(f.conversation.id)).rejects.toThrow('夹具刷新事务不可用');
  } finally { engine.transaction = transaction; }
  expect((await engine.getPage(f.slug, { sourceId: 'lifecycle', includeDeleted: true }))?.compiled_truth).toContain('南京');
  const restarted = new WorkbenchMemoryCoordinator(engine, new WorkbenchStore(store.root), async () => { throw new Error('不得重新提炼已完成记忆'); }, async () => null);
  try { await restarted.scan(f.conversation.id); } finally { restarted.close(); }
  const current: any = await operationsByName.get_page.handler(ctx, { slug: f.slug });
  expect(JSON.stringify(current)).not.toContain('南京'); expect(JSON.stringify(current)).toContain('榆树工作采用中文');
}, 60000);

test('向量及语义缓存命中也不能返回已失效快照，刷新后分块只包含有效事实', async () => {
  const file = join(root, '.pmbrain', 'config.json'); const previousConfig = readFileSync(file, 'utf8');
  const vector = new Float32Array([1, ...Array(DEFAULT_EMBEDDING_DIMENSIONS - 1).fill(0)]);
  try {
    writeFileSync(file, JSON.stringify({ engine: engine.kind, memory: { auto_writeback: 'all' }, embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DEFAULT_EMBEDDING_DIMENSIONS }));
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DEFAULT_EMBEDDING_DIMENSIONS, env: { OPENAI_API_KEY: 'sk-test' } });
    __setEmbedTransportForTests(async ({ values }) => ({ embeddings: values.map(() => Array.from(vector)), usage: { tokens: 0 } }) as any);
    const f = await capture('红豆杉临时行程在重庆，红豆杉报告需要日期', [{ fact: '红豆杉临时行程在重庆' }, { fact: '红豆杉报告需要日期' }]);
    const found = (await engine.searchVector(vector, { sourceId: 'lifecycle', limit: 20 })).filter(row => row.slug === f.slug);
    expect(found).toHaveLength(1);
    const cache = new SemanticQueryCache(engine, { enabled: true });
    await cache.store('红豆杉', vector, found, { vector_enabled: true } as any, { sourceId: 'lifecycle' });
    expect((await cache.lookup(vector, { sourceId: 'lifecycle' })).results?.some(row => row.slug === f.slug)).toBe(true);
    await engine.executeRaw('UPDATE facts SET valid_until=now()-interval \'1 second\' WHERE id=$1', [f.ids[0]]);
    expect((await engine.searchVector(vector, { sourceId: 'lifecycle', limit: 20 })).some(row => row.slug === f.slug)).toBe(false);
    expect((await cache.lookup(vector, { sourceId: 'lifecycle' })).results?.some(row => row.slug === f.slug)).not.toBe(true);
    await coordinator.scan(f.conversation.id);
    expect(JSON.stringify(await engine.getChunks(f.slug, { sourceId: 'lifecycle' }))).not.toContain('重庆');
    expect(JSON.stringify(await engine.searchVector(vector, { sourceId: 'lifecycle', limit: 20 }))).toContain('红豆杉报告需要日期');
  } finally { __setEmbedTransportForTests(null); configureGateway({ env: {} }); writeFileSync(file, previousConfig); }
}, 60000);

test('有完整单会话贡献链的旧 Take 到期失效，无法证明来源的人工记录保留', async () => {
  const entity = 'projects/lifecycle-legacy-takes';
  await importFromContent(engine, entity, '---\ntitle: 旧整理验收\ntype: project\n---\n\n正式项目资料。', { sourceId: 'lifecycle', noEmbed: true });
  const f = await capture('旧整理的三条临时状态', ['fact','preference','commitment'].map((kind, i) => ({ fact: `旧派生临时状态${i}`, kind, entity_slug: entity, valid_until: new Date(Date.now() + 60000) })));
  const page = await engine.getPage(entity, { sourceId: 'lifecycle' });
  await engine.addTakesBatch([{ page_id: page!.id, row_num: 1, claim: '旧派生临时状态0', kind: 'fact', holder: 'self', source: f.conversation.id }, { page_id: page!.id, row_num: 2, claim: '旧派生临时状态0', kind: 'fact', holder: 'self', source: '用户正式确认' }]);
  const old = await engine.listTakes({ sourceId: 'lifecycle', page_slug: entity });
  const generated = old.find(row => row.source === f.conversation.id)!;
  for (const id of f.ids) await engine.consolidateFact(id, generated.id);
  await engine.executeRaw('UPDATE facts SET valid_until=now()-interval \'1 second\' WHERE id=ANY($1::bigint[])', [f.ids]);
  expect((await engine.listTakes({ sourceId: 'lifecycle', page_slug: entity })).map(row => row.source)).toEqual(['用户正式确认']);
  expect((await engine.searchTakes('旧派生临时状态0', { sourceId: 'lifecycle' })).some(row => row.take_id === generated.id)).toBe(false);
  await coordinator.scan(f.conversation.id);
  expect((await engine.listTakes({ sourceId: 'lifecycle', page_slug: entity, active: false })).some(row => row.id === generated.id)).toBe(true);
}, 60000);

test('临时原生事实不提升永久 Take，稳定派生 Take 在遗忘后失效而人工 Take 保留', async () => {
  const entity = 'projects/lifecycle-takes';
  await importFromContent(engine, entity, '---\ntitle: 生命周期整理\ntype: project\n---\n\n原始项目资料。', { sourceId: 'lifecycle', noEmbed: true });
  const embedding = new Float32Array([1, ...Array(DEFAULT_EMBEDDING_DIMENSIONS - 1).fill(0)]);
  const kinds = ['fact', 'preference', 'commitment'];
  const transient = await capture('临时项目计划三项', kinds.map((kind, i) => ({ fact: `临时原生计划${i}`, kind, entity_slug: entity, embedding, valid_from: new Date(Date.now() - 3 * 86400000), valid_until: new Date(Date.now() + 3600000) })));
  await runPhaseConsolidate(engine, { minOldestAgeMs: 0, minFactsPerBucket: 3 });
  expect(await engine.listTakes({ sourceId: 'lifecycle', page_slug: entity })).toHaveLength(0);
  for (const id of transient.ids) await forgetFactInFence(engine, id, { sourceId: 'lifecycle' });
  const stable = await capture('长期项目规范三项', kinds.map((kind, i) => ({ fact: `稳定原生规范${i}`, kind, entity_slug: entity, embedding, confidence: i === 2 ? 1 : .8, valid_from: new Date(Date.now() - (3 - i) * 86400000) })));
  await runPhaseConsolidate(engine, { minOldestAgeMs: 0, minFactsPerBucket: 3 });
  const takes = await engine.listTakes({ sourceId: 'lifecycle', page_slug: entity }); expect(takes).toHaveLength(1);
  const page = await engine.getPage(entity, { sourceId: 'lifecycle' });
  await engine.addTakesBatch([{ page_id: page!.id, row_num: 99, claim: '人工确认的项目判断', kind: 'take', holder: 'self', source: '用户保存' }]);
  await forgetFactInFence(engine, stable.ids[2], { sourceId: 'lifecycle' }); await coordinator.scan(stable.conversation.id);
  expect((await engine.listTakes({ sourceId: 'lifecycle', page_slug: entity })).map(row => row.claim)).toEqual(['人工确认的项目判断']);
  expect((await engine.listTakes({ sourceId: 'lifecycle', page_slug: entity, active: false })).some(row => row.claim === '稳定原生规范2')).toBe(true);
}, 60000);
