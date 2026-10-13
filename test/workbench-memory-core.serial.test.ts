import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine';
import { PostgresEngine } from '../src/core/postgres-engine';
import type { BrainEngine } from '../src/core/engine';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard';
import { configureGateway, resetGateway, __setEmbedTransportForTests, DEFAULT_EMBEDDING_DIMENSIONS } from '../src/core/ai/gateway';
import { WorkbenchStore } from '../src/product/workbench/store';
import { WorkbenchMemoryCoordinator, runWorkbenchMemoryTask, recallWorkbenchMemory } from '../src/product/workbench/memory';
import type { WorkbenchConversation, WorkbenchMessage } from '../shared/workbench';
import { importFromContent } from '../src/core/import-file';
import { nativeMemoryHandlers } from '../src/product/workbench/memory-tools';
import type { ExtractInput } from '../src/core/facts/extract';
import { operationsByName } from '../src/core/operations';
import { appendCheckpointManifest } from '../src/core/context/session-state';
import { runPhaseConsolidate } from '../src/core/cycle/phases/consolidate';
import { writeSingleFact } from '../src/core/facts/write-single';

const root = mkdtempSync(join(tmpdir(), 'pmbrain-memory-core-'));
const previous = process.env.PMBRAIN_HOME;
const postgresUrl=process.env.PMBRAIN_MEMORY_TEST_DATABASE_URL;
if(postgresUrl)assertSafeE2eDatabaseUrl(postgresUrl);
const engine:BrainEngine = postgresUrl?new PostgresEngine():new PGLiteEngine();
const store = new WorkbenchStore(join(root, 'sessions'));
const coordinator = new WorkbenchMemoryCoordinator(engine, store, async () => ({ id: 'task-1', status: 'queued' } as any), async () => null);

test('模型解析失败保留可恢复身份，修复配置自动提交同一回合且不补写关闭消息', async () => {
  const file = join(root, '.pmbrain', 'config.json');
  const previousConfig = readFileSync(file, 'utf8');
  const getConfig = engine.getConfig;
  const submissions: any[] = [];
  const recovery = new WorkbenchMemoryCoordinator(engine, store, async (input) => { submissions.push(input); return { id: 'task-recovery', status: 'queued' } as any; }, async () => null);
  try {
    writeFileSync(file, JSON.stringify({ engine: engine.kind, memory: { auto_writeback: 'all' } }));
    engine.getConfig = async function (key) { if (key === 'facts.extraction_model') throw new Error('模型配置不可读'); return getConfig.call(this, key); };
    const f = await turn('以后复盘先列证据');
    expect(f.message.memory?.status).toBe('held');
    expect(f.message.memory?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(f.message.memory?.mode).toBe('all');
    const capturedAt = f.message.memory!.capturedAt;
    await recovery.scan(f.conversation.id);
    expect(submissions).toHaveLength(0);
    engine.getConfig = getConfig;
    await recovery.scan(f.conversation.id);
    expect(submissions).toHaveLength(1);
    expect(submissions[0].hash).toBe(f.message.memory!.hash);
    expect(store.get(f.conversation.id).messages[0].memory?.capturedAt).toBe(capturedAt);
    const legacy = store.get(f.conversation.id);
    legacy.messages[0].memory = { ...legacy.messages[0].memory!, hash: '', mode: 'off', status: 'held' };
    store.save(legacy);
    await recovery.scan(legacy.id);
    expect(submissions).toHaveLength(2);
    await engine.setConfig('facts.default_visibility', 'private');
    engine.getConfig = async function (key) { if (key === 'facts.extraction_model') throw new Error('模型配置不可读'); return getConfig.call(this, key); };
    const privateTurn = await turn('私人审批计划保持原可见性');
    engine.getConfig = async function (key) { if (key === 'memory.auto_writeback') throw new Error('暂时无法读取开关'); return getConfig.call(this, key); };
    await recovery.scan(privateTurn.conversation.id);
    expect(store.get(privateTurn.conversation.id).messages[0].memory?.mode).toBe('all');
    expect(store.get(privateTurn.conversation.id).messages[0].memory?.visibility).toBe('private');
    engine.getConfig = getConfig;
    await engine.setConfig('facts.default_visibility', 'world');
    await recovery.scan(privateTurn.conversation.id);
    expect(store.get(privateTurn.conversation.id).messages[0].memory?.visibility).toBe('private');
    expect(submissions).toHaveLength(3);
    const confirmedOff = store.get(legacy.id);
    confirmedOff.messages[0].memory!.status = 'off'; confirmedOff.messages[0].memory!.mode = 'off';
    store.save(confirmedOff);
    store.saveMemory(confirmedOff.id, confirmedOff.messages[0].id, confirmedOff.messages[0].memory!);
    await recovery.scan(legacy.id);
    expect(submissions).toHaveLength(3);
  } finally { engine.getConfig = getConfig; writeFileSync(file, previousConfig); recovery.close(); }
}, 60000);

test('配置向量后使用 Core 混合检索召回无相同关键词的原生记忆', async () => {
  const path = join(root, '.pmbrain', 'config.json');
  const previousConfig = readFileSync(path, 'utf8');
  let calls = 0;
  try {
    writeFileSync(path, JSON.stringify({ engine: engine.kind, memory: { auto_writeback: 'all' }, embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DEFAULT_EMBEDDING_DIMENSIONS }));
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DEFAULT_EMBEDDING_DIMENSIONS, env: { OPENAI_API_KEY: 'sk-test' } });
    __setEmbedTransportForTests(async ({ values }) => { calls++; return { embeddings: values.map(() => [1, ...Array(DEFAULT_EMBEDDING_DIMENSIONS - 1).fill(0)]), usage: { tokens: 0 } } as any; });
    const f = await turn('跨城出差选续航充足的车型');
    const result = await runWorkbenchMemoryTask(engine, f.input, new AbortController().signal, { extract: (async () => [{ fact: f.message.text, kind: 'preference', entity_slug: null, embedding: null }]) as any });
    expect((await engine.executeRaw('SELECT cc.embedding IS NOT NULL AS filled FROM content_chunks cc JOIN pages p ON p.id=cc.page_id WHERE p.source_id=$1 AND p.slug=$2', ['work', result.archiveSlug]))[0].filled).toBe(true);
    expect((await recallWorkbenchMemory(engine, { sourceId: 'work', query: '电车能跑多远' })).map(row => row.snippet)).toContain('跨城出差选续航充足的车型');
    expect(calls).toBeGreaterThan(1);
  } finally { __setEmbedTransportForTests(null); configureGateway({ env: {} }); writeFileSync(path, previousConfig); }
}, 60000);

beforeAll(async () => {
  process.env.PMBRAIN_HOME = root;
  mkdirSync(join(root, '.pmbrain'));
  writeFileSync(join(root, '.pmbrain', 'config.json'), JSON.stringify({ engine:engine.kind, memory: { auto_writeback: 'all' } }));
  configureGateway({env:{}});
  await engine.connect(postgresUrl?{database_url:postgresUrl}:{}); await engine.initSchema();
  await engine.setConfig('memory.auto_writeback', 'all');
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES ('work','工作'),('other','其他') ON CONFLICT DO NOTHING");
}, 60000);
afterAll(async () => { coordinator.close(); await engine.disconnect(); resetGateway(); if (previous === undefined) delete process.env.PMBRAIN_HOME; else process.env.PMBRAIN_HOME = previous; });

async function turn(text: string, sourceId = 'work') {
  const message: WorkbenchMessage = { id: randomUUID(), role: 'user', text, createdAt: new Date().toISOString(), status: 'complete' };
  const conversation: WorkbenchConversation = { id: randomUUID(), title: '测试', model: 'ollama:test', knowledge: true, sourceId, createdAt: message.createdAt, updatedAt: message.createdAt, messages: [message] };
  message.memory = await coordinator.capture(conversation, message);
  store.save(conversation);
  return { conversation, message, input: { root: store.root, conversationId: conversation.id, messageId: message.id, hash: message.memory.hash, sourceId } };
}

test('短中文陈述落入既有 Facts，出处可读回，重复任务不重复提炼', async () => {
  const f = await turn('方案要简短'); let calls = 0;
  const extract: any = async () => { calls++; return [{ fact: '方案要简短', kind: 'preference', entity_slug: null, source: '测试', embedding: null }]; };
  await runWorkbenchMemoryTask(engine, f.input, new AbortController().signal, { extract });
  await runWorkbenchMemoryTask(engine, f.input, new AbortController().signal, { extract });
  expect(calls).toBe(1);
  const facts = await engine.listFactsBySession('work', f.conversation.id, { activeOnly: true });
  expect(facts).toHaveLength(1);
  expect(facts[0].context).toContain(f.message.id);
  expect(store.get(f.conversation.id).messages[0].memory?.status).toBe('complete');
}, 60000);

test('新会话按主题召回，有出处，其他 Source 与无关话题不混入', async () => {
  const other = await turn('方案要很多细节', 'other');
  await runWorkbenchMemoryTask(engine, other.input, new AbortController().signal, { extract: (async () => [{ fact: '方案要很多细节', kind: 'preference', entity_slug: null, embedding: null }]) as any });
  const relevant = await recallWorkbenchMemory(engine, { sourceId: 'work', query: '给我写一份方案' });
  expect(relevant.map(row => row.snippet)).toContain('方案要简短');
  expect(relevant.every(row => row.sourceId === 'work')).toBe(true);
  expect(relevant[0].conversationId).toBeDefined();
  expect(await recallWorkbenchMemory(engine, { sourceId: 'work', query: '香蕉多少钱' })).toHaveLength(0);
}, 60000);

test('关闭期间的回合不补写，已开始的提炼在关停后不能落库', async () => {
  const f = await turn('以后咖啡只要无糖');
  let failure:unknown;
  try { await runWorkbenchMemoryTask(engine, f.input, new AbortController().signal, { extract: (async () => {
    await engine.setConfig('memory.auto_writeback', 'off');
    return [{ fact: '咖啡只要无糖', kind: 'preference', entity_slug: null, embedding: null }];
  }) as any }); } catch(error) { failure=error; }
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain('记忆写入已停止');
  expect(await engine.listFactsBySession('work', f.conversation.id, { activeOnly: true })).toHaveLength(0);
  const off = await turn('以后默认使用中文');
  expect(off.message.memory?.mode).toBe('off');
  await engine.setConfig('memory.auto_writeback', 'all');
  let calls = 0;
  await runWorkbenchMemoryTask(engine, off.input, new AbortController().signal, { extract: (async () => { calls++; return []; }) as any });
  expect(calls).toBe(0);
}, 60000);

test('问句、确认语与引用不提炼，临时事实到期不召回', async () => {
  for (const text of ['谢谢', '你能帮我写方案吗？', '> 他说方案要很长','请给Atlas写一份简短项目方案，并说明我对方案写法的偏好。']) {
    const f = await turn(text); let calls = 0;
    await runWorkbenchMemoryTask(engine, f.input, new AbortController().signal, { extract: (async () => { calls++; return []; }) as any });
    expect(calls).toBe(0);
  }
  const f = await turn('我今天在北京');
  await runWorkbenchMemoryTask(engine, f.input, new AbortController().signal, { extract: (async () => [{ fact: '今天在北京', kind: 'fact', entity_slug: null, embedding: null, valid_until: new Date(Date.now() - 1000) }]) as any });
  expect(await recallWorkbenchMemory(engine, { sourceId: 'work', query: '北京' })).toHaveLength(0);
  expect(await engine.listFactsBySession('work', f.conversation.id, { activeOnly: false })).toHaveLength(1);
}, 60000);

test('跨会话明确纠正复用既有替代语义，无向量也保留旧事实历史', async()=>{
  const first=await turn('项目上线定在周五');
  await runWorkbenchMemoryTask(engine,first.input,new AbortController().signal,{extract:(async()=>[{fact:'项目上线定在周五',kind:'commitment',entity_slug:null,embedding:null}]) as any});
  const old=(await engine.listFactsBySession('work',first.conversation.id,{activeOnly:true}))[0];
  const next=await turn('项目上线改成下周一');
  await runWorkbenchMemoryTask(engine,next.input,new AbortController().signal,{extract:(async (input:ExtractInput)=>{expect(input.knownFacts?.some(row=>row.id===old.id)).toBe(true);return [{fact:'项目上线定在下周一',kind:'commitment',entity_slug:null,embedding:null,supersedes:old.id}];}) as any});
  expect(await engine.listFactsBySession('work',first.conversation.id,{activeOnly:true})).toHaveLength(0);
  expect(await engine.listFactsBySession('work',first.conversation.id,{activeOnly:false})).toHaveLength(1);
  expect((await recallWorkbenchMemory(engine,{sourceId:'work',query:'项目上线'})).map(row=>row.snippet)).toContain('项目上线定在下周一');
},60000);

test('Dream 只接公开稳定事实，私有和临时内容不会进入正式知识语料',async()=>{
  const previousVisibility=await engine.getConfig('facts.default_visibility');await engine.setConfig('facts.default_visibility','private');
  const privateTurn=await turn('周报保留原始数字');let calls=0;
  const extract:any=async()=>[{fact:'周报保留原始数字',kind:'preference',entity_slug:null,embedding:null}];
  await runWorkbenchMemoryTask(engine,privateTurn.input,new AbortController().signal,{extract,organize:async()=>{calls++;}});expect(calls).toBe(0);
  await engine.setConfig('facts.default_visibility','world');
  try{
    const world=await turn('规范结论先行，我今天在北京，助手回答不属于我的陈述。');
    await runWorkbenchMemoryTask(engine,world.input,new AbortController().signal,{extract:(async()=>[{fact:'规范结论先行',kind:'preference',entity_slug:null,embedding:null},{fact:'今天在北京',kind:'fact',entity_slug:null,embedding:null,valid_until:new Date(Date.now()+86400000)}]) as any,organize:async(path)=>{calls++;const content=readFileSync(path,'utf8');expect(content).toContain('规范结论先行');expect(content).not.toContain('北京');expect(content).not.toContain('助手回答');}});
    expect(calls).toBe(1);
  }finally{if(previousVisibility===null)await engine.unsetConfig('facts.default_visibility');else await engine.setConfig('facts.default_visibility',previousVisibility);}
},60000);

test('同一事实在并发会话中只写一条，已完成分块中断后不重复提炼',async()=>{
  const a=await turn('周报采用中文'),b=await turn('周报采用中文');
  const extract:any=async()=>[{fact:'周报采用中文',kind:'preference',entity_slug:null,embedding:null}];
  await Promise.all([runWorkbenchMemoryTask(engine,a.input,new AbortController().signal,{extract}),runWorkbenchMemoryTask(engine,b.input,new AbortController().signal,{extract})]);
  const rows=await engine.executeRaw("SELECT id FROM facts WHERE source_id='work' AND fact='周报采用中文'");expect(rows).toHaveLength(1);
  const long=await turn('我要求文档保留原始时间。'.repeat(650));let calls=0;
  const resume:any=async()=>{calls++;if(calls===2)throw new Error('提炼请求中断');return [{fact:'文档保留原始时间',kind:'preference',entity_slug:null,embedding:null}];};
  let failure:unknown;try{await runWorkbenchMemoryTask(engine,long.input,new AbortController().signal,{extract:resume});}catch(error){failure=error;}
  expect(String(failure)).toContain('提炼请求中断');
  expect(long.message.text.length).toBeGreaterThan(7000);
  await runWorkbenchMemoryTask(engine,long.input,new AbortController().signal,{extract:resume});expect(calls).toBe(3);
},60000);

test('有关人物的记忆不改原始 Markdown，关系复用既有导入规则',async()=>{
  const sourceDir=join(root,'originals');mkdirSync(join(sourceDir,'people'),{recursive:true});
  const original='---\ntitle: 测试对象\ntype: person\n---\n\n这是用户原始资料。\n';const path=join(sourceDir,'people','test-person.md');writeFileSync(path,original);
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='work'",[sourceDir]);
  await importFromContent(engine,'people/test-person',original,{sourceId:'work',noEmbed:true});
  const f=await turn('测试对象周报必须采用中文');
  const result=await runWorkbenchMemoryTask(engine,f.input,new AbortController().signal,{extract:(async()=>[{fact:'测试对象周报采用中文',kind:'preference',entity_slug:'people/test-person',embedding:null}]) as any});
  expect(readFileSync(path,'utf8')).toBe(original);
  expect((await engine.getPage('people/test-person',{sourceId:'work'}))?.compiled_truth).toContain('这是用户原始资料。');
  const links=await engine.executeRaw('SELECT l.* FROM links l JOIN pages p ON p.id=l.from_page_id WHERE p.source_id=$1 AND p.slug=$2',['work',result.archiveSlug]);expect(links.length).toBeGreaterThan(0);
},60000);

test('原生记住与遗忘直接执行核心能力，猜测 Source 和越权事实不能操作',async()=>{
  const f=await turn('记住我的报告统一采用中文');const handlers=nativeMemoryHandlers(engine,'work',f.conversation.id,{store,tasks:{} as any},()=>1,new Map());
  const saved:any=await handlers.get('memory_remember')!.execute({fact:'报告统一采用中文',kind:'preference'},new AbortController().signal);
  expect(saved.id).toBeGreaterThan(0);
  await expect(handlers.get('memory_remember')!.execute({fact:'错误',kind:'preference',source_id:'other'},new AbortController().signal)).rejects.toThrow('工具参数无效');
  const current=store.get(f.conversation.id);current.messages[0].text='请忘记报告语言偏好';store.save(current);
  const other=await turn('记住报告用英文','other');const otherHandlers=nativeMemoryHandlers(engine,'other',other.conversation.id,{store,tasks:{} as any},()=>1,new Map());
  const foreign:any=await otherHandlers.get('memory_remember')!.execute({fact:'报告用英文',kind:'preference'},new AbortController().signal);
  const refused:any=await handlers.get('memory_forget')!.execute({fact_id:foreign.id},new AbortController().signal);expect(refused.ok).toBe(false);
  const forgotten:any=await handlers.get('memory_forget')!.execute({fact_id:saved.id},new AbortController().signal);expect(forgotten.ok).toBe(true);
},60000);

test('编辑撤回旧分支，有其他会话引用的去重事实继续有效',async()=>{
  const a=await turn('评审材料使用中文'),b=await turn('评审材料使用中文');
  const extract:any=async()=>[{fact:'评审材料使用中文',kind:'preference',entity_slug:null,embedding:null}];
  await runWorkbenchMemoryTask(engine,a.input,new AbortController().signal,{extract});await runWorkbenchMemoryTask(engine,b.input,new AbortController().signal,{extract});
  const old=store.get(a.conversation.id);old.revisions=[{id:randomUUID(),createdAt:new Date().toISOString(),reason:'edit',messages:old.messages}];old.messages=[];store.save(old);
  await runWorkbenchMemoryTask(engine,{...a.input,retire:true},new AbortController().signal);
  expect((await recallWorkbenchMemory(engine,{sourceId:'work',query:'评审材料'})).map(row=>row.snippet)).toContain('评审材料使用中文');
  const last=store.get(b.conversation.id);last.revisions=[{id:randomUUID(),createdAt:new Date().toISOString(),reason:'edit',messages:last.messages}];last.messages=[];store.save(last);
  await runWorkbenchMemoryTask(engine,{...b.input,retire:true},new AbortController().signal);
  const source=store.get(a.conversation.id);const captured=source.revisions![0].messages[0].memory!;
  expect(await recallWorkbenchMemory(engine,{sourceId:'work',query:'评审材料'})).toHaveLength(0);expect(captured.status).toBe('superseded');
},60000);

test('失效租约与旧执行者回执不能覆盖新执行者，修改知识必须核对页面版本',async()=>{
  const f=await turn('报告先写目的');let calls=0;let rejected:unknown;
  try{await runWorkbenchMemoryTask(engine,f.input,new AbortController().signal,{ownerJobId:999999,ownerToken:'expired-token',extract:(async()=>{calls++;return [];}) as any});}catch(error){rejected=error;}
  expect(String(rejected)).toContain('租约');expect(calls).toBe(0);
  const memory=f.message.memory!;store.saveMemory(f.conversation.id,f.message.id,{...memory,epoch:'new-owner',status:'running'},true);store.saveMemory(f.conversation.id,f.message.id,{...memory,epoch:'old-owner',status:'failed'});
  expect(store.get(f.conversation.id).messages[0].memory?.status).toBe('running');
  const read=await turn('请补充测试对象的知识资料');const initial=await engine.getPage('people/test-person',{sourceId:'work'});const timeline='## 2026-10-01\n既有时间线记录。';await engine.putPage('people/test-person',{...initial!,timeline},{sourceId:'work'});const page=await engine.getPage('people/test-person',{sourceId:'work'});const reads=new Map([[JSON.stringify(['work','people/test-person']),page!.content_hash!]]);
  const handlers=nativeMemoryHandlers(engine,'work',read.conversation.id,{store,tasks:{} as any},()=>1,reads);
  await handlers.get('knowledge_append')!.execute({source_id:'work',slug:'people/test-person',revision:page!.content_hash,content:'新增核对后的中文偏好。'},new AbortController().signal);
  const saved=await engine.getPage('people/test-person',{sourceId:'work'});expect(saved!.compiled_truth).toContain('这是用户原始资料。');expect(saved!.compiled_truth).toContain('新增核对后的中文偏好。');expect(saved!.timeline).toBe(timeline);
  let stale:unknown;try{await handlers.get('knowledge_append')!.execute({source_id:'work',slug:'people/test-person',revision:page!.content_hash,content:'过时更新'},new AbortController().signal);}catch(error){stale=error;}expect(String(stale)).toContain('资料已改变');
},60000);

test('编辑旧回合退役原生派生页及其关系，原句和同名其他 Source 页面保留', async () => {
  const f = await turn('测试对象的审批由陈工负责');
  const result = await runWorkbenchMemoryTask(engine, f.input, new AbortController().signal, { extract: (async () => [{ fact: '测试对象的审批由陈工负责', kind: 'fact', entity_slug: 'people/test-person', embedding: null }]) as any });
  const slug = String(result.archiveSlug);
  const nativeArchive = await engine.getPage(slug, { sourceId: 'work' });
  await engine.putPage('wiki/promoted-memory', { ...nativeArchive!, compiled_truth: '用户正式保存的知识必须保留。' }, { sourceId: 'work' });
  await importFromContent(engine, slug, '---\ntitle: 同名用户资料\n---\n\n这份资料必须保留。', { sourceId: 'other', noEmbed: true });
  expect((await engine.executeRaw('SELECT l.id FROM links l JOIN pages p ON p.id=l.from_page_id WHERE p.source_id=$1 AND p.slug=$2', ['work', slug])).length).toBeGreaterThan(0);
  const old = store.get(f.conversation.id);
  old.revisions = [{ id: randomUUID(), createdAt: new Date().toISOString(), reason: 'edit', messages: old.messages }]; old.messages = []; store.save(old);
  await runWorkbenchMemoryTask(engine, { ...f.input, retire: true }, new AbortController().signal);
  expect((await engine.executeRaw('SELECT deleted_at FROM pages WHERE source_id=$1 AND slug=$2', ['work', slug]))[0].deleted_at).not.toBeNull();
  expect(await engine.executeRaw('SELECT l.id FROM links l JOIN pages p ON p.id=l.from_page_id WHERE p.source_id=$1 AND p.slug=$2', ['work', slug])).toHaveLength(0);
  expect((await engine.getPage(slug, { sourceId: 'other' }))?.compiled_truth).toContain('这份资料必须保留');
  expect((await engine.getPage('wiki/promoted-memory', { sourceId: 'work' }))?.compiled_truth).toBe('用户正式保存的知识必须保留。');
  expect(store.get(f.conversation.id).revisions![0].messages[0].text).toBe(f.message.text);
  expect(await recallWorkbenchMemory(engine, { sourceId: 'work', query: '陈工负责' })).toHaveLength(0);
}, 60000);

test('原生召回恢复 Core 检查点，外部 Recall 与搜索遵守原可见性和 Source', async () => {
  const f = await turn('边界验收的首选工具是白鹭');
  const result = await runWorkbenchMemoryTask(engine, f.input, new AbortController().signal, { extract: (async () => [{ fact: '边界验收的首选工具是白鹭', kind: 'preference', entity_slug: null, embedding: null }]) as any });
  const sessionId = randomUUID();
  await importFromContent(engine, 'projects/context-checkpoint', '---\ntitle: 检查点项目\ntype: project\n---\n\n验收依赖前一轮确认的步骤。', { sourceId: 'work', noEmbed: true });
  await appendCheckpointManifest(engine, 'work', 'pmbrain:workbench', sessionId, [{ slug: String(result.archiveSlug), title: '已确认工具偏好' }, { slug: 'projects/context-checkpoint', title: '检查点项目' }], 'confirmed');
  const restored = await recallWorkbenchMemory(engine, { sourceId: 'work', query: '继续之前的约定', sessionId });
  expect(restored.map(row => row.snippet)).toContain('边界验收的首选工具是白鹭');
  expect(restored.some(row => row.slug === 'projects/context-checkpoint' && row.kind !== 'memory')).toBe(true);
  expect(await recallWorkbenchMemory(engine, { sourceId: 'work', query: '继续之前的约定', sessionId, budget: 1 })).toHaveLength(0);
  await engine.softDeletePage('projects/context-checkpoint', { sourceId: 'work' });
  expect((await recallWorkbenchMemory(engine, { sourceId: 'work', query: '继续之前的约定', sessionId })).some(row => row.slug === 'projects/context-checkpoint')).toBe(false);
  const ctx: any = { engine, sourceId: 'work', remote: true, config: { engine: engine.kind }, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
  expect(((await operationsByName.recall.handler(ctx, { session_id: f.conversation.id })) as any).facts.map((row: any) => row.fact)).toContain('边界验收的首选工具是白鹭');
  await engine.setConfig('facts.default_visibility', 'private');
  try {
    const p = await turn('私人边界测试的工具是海鸥');
    const privateResult = await runWorkbenchMemoryTask(engine, p.input, new AbortController().signal, { extract: (async () => [{ fact: '私人边界测试的工具是海鸥', kind: 'fact', entity_slug: null, embedding: null }]) as any });
    expect(p.message.memory?.visibility).toBe('private');
    expect((await engine.getPage(String(privateResult.archiveSlug), { sourceId: 'work' }))?.frontmatter.private).toBe(true);
    const archive = await engine.getPage(String(privateResult.archiveSlug), { sourceId: 'work' });
    const legacyFrontmatter = { ...archive!.frontmatter }; delete legacyFrontmatter.visibility;
    await engine.putPage(String(privateResult.archiveSlug), { ...archive!, frontmatter: legacyFrontmatter }, { sourceId: 'work' });
    await coordinator.scan(p.conversation.id);
    expect((await engine.getPage(String(privateResult.archiveSlug), { sourceId: 'work' }))?.frontmatter.visibility).toBe('private');
    expect(((await operationsByName.recall.handler(ctx, { session_id: p.conversation.id })) as any).facts).toHaveLength(0);
    const found = await operationsByName.search.handler(ctx, { query: '私人边界测试', limit: 10 });
    expect(JSON.stringify(found)).not.toContain('海鸥');
    await expect(operationsByName.get_page.handler(ctx, { slug: String(privateResult.archiveSlug) })).rejects.toThrow();
    expect((await recallWorkbenchMemory(engine, { sourceId: 'work', query: '私人边界测试' })).map(row => row.snippet)).toContain('私人边界测试的工具是海鸥');
  } finally { await engine.setConfig('facts.default_visibility', 'world'); }
}, 60000);

test('Dream 公共整理不能把私有记忆提升到公开实体的 Take', async () => {
  await importFromContent(engine, 'projects/private-dream', '---\ntitle: 隐私整理验收\ntype: project\n---\n\n公开项目说明。', { sourceId: 'work', noEmbed: true });
  const kinds = ['fact', 'preference', 'commitment'] as const;
  for (let index = 0; index < 3; index++) await writeSingleFact(engine, 'work', { databaseOnly: true, exactDedup: true, fact: `私人整理验收信息${index}`, kind: kinds[index], entity: 'projects/private-dream', provenance: 'PMBrain 知识助手 / private Dream fixture', visibility: 'private', confidence: 1, embedding: new Float32Array([1, ...Array(DEFAULT_EMBEDDING_DIMENSIONS - 1).fill(0)]), validFrom: new Date(Date.now() - 3 * 86400000) });
  await runPhaseConsolidate(engine, { minOldestAgeMs: 0, minFactsPerBucket: 3 });
  const takes = await engine.executeRaw('SELECT t.claim FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1 AND p.slug=$2', ['work', 'projects/private-dream']);
  expect(takes).toHaveLength(0);
  expect(await engine.listFactsByEntity('work', 'projects/private-dream', { activeOnly: true, visibility: ['private'] })).toHaveLength(3);
  for (let index = 0; index < 3; index++) await writeSingleFact(engine, 'work', { databaseOnly: true, exactDedup: true, fact: `公开整理验收信息${index}`, kind: kinds[index], entity: 'projects/private-dream', provenance: 'PMBrain 知识助手 / world Dream fixture', visibility: 'world', confidence: 1, embedding: new Float32Array([1, ...Array(DEFAULT_EMBEDDING_DIMENSIONS - 1).fill(0)]), validFrom: new Date(Date.now() - 3 * 86400000) });
  await runPhaseConsolidate(engine, { minOldestAgeMs: 0, minFactsPerBucket: 3 });
  const publicTakes = await engine.executeRaw('SELECT t.claim FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1 AND p.slug=$2', ['work', 'projects/private-dream']);
  expect(publicTakes).toHaveLength(1);
  expect(publicTakes[0].claim).toStartWith('公开整理验收');
  expect((await engine.listFactsByEntity('work', 'projects/private-dream', { activeOnly: true, visibility: ['private'] })).every(row => row.consolidated_at === null)).toBe(true);
}, 60000);
