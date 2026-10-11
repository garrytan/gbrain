import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runCycle } from '../src/core/cycle.ts';
import { runQuickMaintenance, combineQuickMaintenanceReports } from '../src/core/quick-maintenance.ts';
import { runByMentionCore } from '../src/commands/extract.ts';
import { resolveDreamRelationOptions } from '../src/commands/dream.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';

const home = mkdtempSync(join(tmpdir(), 'pmbrain-relations-test-'));
mkdirSync(join(home, '.pmbrain'));
writeFileSync(join(home, '.pmbrain', 'config.json'), JSON.stringify({schema_pack:'gbrain-base',model_usage:{generative_enabled:false,embedding_enabled:false}}));
const databaseUrl = process.env.PMBRAIN_RELATION_TEST_DATABASE_URL;
let engine: BrainEngine;
const scoped = <T>(fn:()=>Promise<T>) => withEnv({PMBRAIN_HOME:home,GBRAIN_HOME:home,GBRAIN_SCHEMA_PACK:undefined,PMBRAIN_SCHEMA_PACK:undefined},fn);
const relations = resolveDreamRelationOptions('full');

test('完整整理默认开启共享关系链，独立阶段和会议保持原有范围',()=>{
  expect(resolveDreamRelationOptions()).toEqual(relations);
  expect(resolveDreamRelationOptions(undefined,'all')).toEqual(relations);
  expect(relations.includeNer).toBe(true);
  expect(resolveDreamRelationOptions('meeting')).toEqual({});
  expect(resolveDreamRelationOptions(undefined,'propose_takes')).toEqual({});
});

beforeAll(async()=>{
  if(databaseUrl) assertSafeE2eDatabaseUrl(databaseUrl);
  engine = databaseUrl ? new PostgresEngine() : new PGLiteEngine();
  await engine.connect(databaseUrl?{database_url:databaseUrl}:{});
  await engine.initSchema();
},60000);
afterAll(async()=>{await engine?.disconnect();},60000);
beforeEach(async()=>{await resetPgliteState(engine as PGLiteEngine);});

async function seed() {
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES ('vault','Vault'),('other','Other')");
  await engine.putPage('companies/openai',{type:'company',title:'OpenAI',compiled_truth:''},{sourceId:'vault'});
  await engine.putPage('companies/openai',{type:'company',title:'OpenAI',compiled_truth:''},{sourceId:'other'});
  await engine.putPage('companies/foreign',{type:'company',title:'ForeignCorp',compiled_truth:''},{sourceId:'other'});
  await engine.putPage('people/sam',{type:'person',title:'Sam Altman',compiled_truth:'Sam Altman is CEO of OpenAI.'},{sourceId:'vault'});
  await engine.putPage('people/zhang',{type:'person',title:'张三',compiled_truth:'张三担任 OpenAI 的顾问。'},{sourceId:'vault'});
  await engine.putPage('notes/history',{type:'note',title:'项目复盘',compiled_truth:'OpenAI 与 ForeignCorp 被提及。参见 [[companies/openai]]，以及 [[concepts/graph]]。'},{sourceId:'vault'});
  await engine.putPage('notes/mention',{type:'note',title:'正文引用',compiled_truth:'OpenAI 发布新模型。'},{sourceId:'vault'});
}
async function edges() {
  return engine.executeRaw<{from_slug:string;to_slug:string;to_source:string;link_type:string;link_source:string;link_kind:string|null}>(
    "SELECT f.slug AS from_slug,t.slug AS to_slug,t.source_id AS to_source,l.link_type,l.link_source,l.link_kind FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.source_id='vault' ORDER BY f.slug,t.slug,l.link_type,l.link_source");
}

test('快速维护运行显式、正文和中英文 NER，保持 Source 与重跑幂等',()=>scoped(async()=>{
  await seed();
  const first = await runQuickMaintenance(engine,{brainDir:null,sourceId:'vault'});
  expect(first.phases.find(p=>p.phase==='extract')?.details.nerLinksCreated).toBeGreaterThanOrEqual(2);
  const rows = await edges();
  expect(rows).toContainEqual(expect.objectContaining({from_slug:'people/sam',to_slug:'companies/openai',link_type:'works_at',link_source:'mentions',link_kind:'typed_ner'}));
  expect(rows).toContainEqual(expect.objectContaining({from_slug:'people/zhang',to_slug:'companies/openai',link_type:'advises',link_kind:'typed_ner'}));
  expect(rows).toContainEqual(expect.objectContaining({from_slug:'notes/mention',to_slug:'companies/openai',link_type:'mentions'}));
  expect(rows.every(row=>row.to_source==='vault')).toBe(true);
  const second = await runQuickMaintenance(engine,{brainDir:null,sourceId:'vault'});
  expect(second.phases.find(p=>p.phase==='extract')?.details.linksCreated).toBe(0);
  expect(await edges()).toEqual(rows);
}),60000);

test('生成概念后的收尾重扫旧 WikiLink 与正文，在孤立页检查前建立关系',()=>scoped(async()=>{
  await seed();
  let generated=false;
  const report = await runCycle(engine,{brainDir:null,sourceId:'vault',phases:['extract','embed','orphans'],...relations,
    phaseCheckpoint:async phases=>{
      if(!generated&&phases.some(p=>p.phase==='extract')){
        generated=true;
        await engine.putPage('concepts/graph',{type:'concept',title:'知识图谱',compiled_truth:''},{sourceId:'vault'});
        await engine.putPage('notes/new-mention',{type:'note',title:'新增正文',compiled_truth:'知识图谱可以连接知识。'},{sourceId:'vault'});
      }
    }});
  const rows=await edges();
  expect(rows).toContainEqual(expect.objectContaining({from_slug:'notes/history',to_slug:'concepts/graph',link_source:'markdown'}));
  expect(rows.some(row=>row.from_slug==='notes/new-mention'&&row.to_slug==='concepts/graph'&&row.link_source==='mentions')).toBe(false);
  expect(report.phases.find(p=>p.phase==='extract')?.details.postGenerationRelations).toBe(true);
  expect((await engine.getBacklinks('concepts/graph',{sourceId:'vault'})).some(link=>link.from_slug==='notes/history')).toBe(true);
  expect((await engine.findOrphanPages({sourceId:'vault'})).some(row=>row.slug==='concepts/graph')).toBe(false);
}),60000);

test('历史目标和别名后来出现时，两种入口补齐已扫描页面',()=>scoped(async()=>{
  await seed();
  await engine.putPage('notes/alias',{type:'note',title:'别名引用',compiled_truth:'OpenAI Labs 提供模型。'},{sourceId:'vault'});
  await runQuickMaintenance(engine,{brainDir:null,sourceId:'vault'});
  await engine.putPage('companies/openai',{type:'company',title:'OpenAI',compiled_truth:'新增别名 OpenAI Labs。',frontmatter:{aliases:['OpenAI Labs']}},{sourceId:'vault'});
  await engine.putPage('concepts/graph',{type:'concept',title:'知识图谱',compiled_truth:''},{sourceId:'vault'});
  const report=await runCycle(engine,{brainDir:null,sourceId:'vault',phases:['extract','orphans'],...relations});
  expect(report.phases.find(p=>p.phase==='extract')?.details.relationPagesProcessed).toBeGreaterThan(0);
  expect(await edges()).toContainEqual(expect.objectContaining({from_slug:'notes/history',to_slug:'concepts/graph',link_source:'markdown'}));
  expect(await edges()).toContainEqual(expect.objectContaining({from_slug:'notes/alias',to_slug:'companies/openai',link_source:'mentions'}));
}),60000);

test('NER 写入失败保留原错误，重新执行能够补齐',()=>scoped(async()=>{
  await seed();
  const original=engine.addLinksBatch;
  const failing=spyOn(engine,'addLinksBatch').mockImplementation(async function(this:BrainEngine,rows){
    if(rows.some(row=>row.link_kind==='typed_ner'))throw new Error('Injected NER database failure');
    return original.call(this,rows);
  });
  try{
    const report=await runQuickMaintenance(engine,{brainDir:null,sourceId:'vault'});
    expect(report.phases.find(p=>p.phase==='extract')?.details.ner_error).toContain('Injected NER database failure');
    expect(report.status).toBe('partial');
    expect(combineQuickMaintenanceReports([{sourceId:'vault',report}]).phases.find(p=>p.phase==='extract')?.details.ner_error).toContain('vault: Injected NER database failure');
  }finally{failing.mockRestore();}
  await runQuickMaintenance(engine,{brainDir:null,sourceId:'vault'});
  expect((await edges()).some(row=>row.link_kind==='typed_ner')).toBe(true);
}),60000);

test('正文批次失败不冒充扫描完成，重试能补回关系',()=>scoped(async()=>{
  await seed();
  const failing=spyOn(engine,'addLinksBatch').mockImplementation(async()=>{throw new Error('Injected mention failure');});
  try{
    let error:unknown;
    try {await runByMentionCore(engine,{sourceIdFilter:'vault',quiet:true,prioritySlugs:['people/sam'],maxHistoricalPages:1});}catch(caught){error=caught;}
    expect(String(error)).toContain('Injected mention failure');
  }
  finally{failing.mockRestore();}
  const retried=await runByMentionCore(engine,{sourceIdFilter:'vault',quiet:true});
  expect(retried.created).toBeGreaterThan(0);
}),60000);

test('预览不写关系或扫描凭据',()=>scoped(async()=>{
  await seed();
  const report=await runCycle(engine,{brainDir:null,sourceId:'vault',phases:['extract','orphans'],...relations,dryRun:true});
  expect(await edges()).toHaveLength(0);
  expect(report.totals.links_created).toBe(0);
}),60000);

test('Source 配置不存在的 Pack 时保留关系索引与 NER 原生错误',()=>scoped(async()=>{
  await seed();
  await engine.setConfig('schema_pack.source.vault','missing-relations-test-pack');
  const report=await runQuickMaintenance(engine,{brainDir:null,sourceId:'vault'});
  expect(report.phases.find(p=>p.phase==='extract')?.details.ner_error).toContain('missing-relations-test-pack');
  expect(report.status).toBe('partial');
  expect(report.phases.find(p=>p.phase==='extract')?.details.by_mention_error).toContain('missing-relations-test-pack');
  expect((await edges()).some(row=>row.link_kind==='typed_ner')).toBe(false);
}),60000);

test('人工关系与正文不被关系维护覆盖，歧义实体不自动选择',()=>scoped(async()=>{
  await seed();
  await engine.putPage('companies/twin-a',{type:'company',title:'海蓝科技',compiled_truth:''},{sourceId:'vault'});
  await engine.putPage('companies/twin-b',{type:'company',title:'海蓝科技',compiled_truth:''},{sourceId:'vault'});
  await engine.putPage('notes/twin',{type:'note',title:'歧义记录',compiled_truth:'海蓝科技参与项目。'},{sourceId:'vault'});
  await engine.addLinksBatch([{from_slug:'notes/mention',to_slug:'companies/openai',link_type:'cited',link_source:'manual',from_source_id:'vault',to_source_id:'vault'}]);
  const original=await engine.getPage('notes/history',{sourceId:'vault'});
  await runCycle(engine,{brainDir:null,sourceId:'vault',phases:['extract','orphans'],...relations});
  const rows=await edges();
  expect(rows).toContainEqual(expect.objectContaining({from_slug:'notes/mention',link_source:'manual'}));
  expect(rows.some(row=>row.from_slug==='notes/twin')).toBe(false);
  expect((await engine.getPage('notes/history',{sourceId:'vault'}))?.compiled_truth).toBe(original?.compiled_truth);
}),60000);

test('停止历史扫描后不继续写关系，下一次可以补齐',()=>scoped(async()=>{
  await seed();
  const controller=new AbortController();
  let error:unknown;
  try {await runByMentionCore(engine,{sourceIdFilter:'vault',quiet:true,signal:controller.signal,yieldDuringPhase:async()=>controller.abort(new Error('Stop relation scan'))});}catch(caught){error=caught;}
  expect(String(error)).toContain('Stop relation scan');
  expect(await edges()).toHaveLength(0);
  expect((await runByMentionCore(engine,{sourceIdFilter:'vault',quiet:true})).created).toBeGreaterThan(0);
}),60000);
