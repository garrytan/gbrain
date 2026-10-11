import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { entityIngestTools,finalizeEntityIngest, ingestOriginField, pruneEntityIngestLinks, readIngestContract, validateIngestWrite,finalizeBeforeIngestBudget,checkIngestCallBudget } from '../src/core/pmbrain-adapters/entity-ingest-workflow.ts';
import type {ToolDef,ToolCtx} from '../src/core/minions/types.ts';
import {annotateIngestContent,activeIngestContent,ingestMentionOrigin} from '../src/core/pmbrain-adapters/ingest-provenance.ts';
import {parseMarkdown} from '../src/core/markdown.ts';
import {requestImportedEntityCapture} from '../src/core/pmbrain-adapters/entity-capture-request.ts';
import {enqueueImportedEntityCapture} from '../src/core/pmbrain-adapters/imported-entity-capture.ts';

process.env.PMBRAIN_HOME=mkdtempSync(join(tmpdir(),'pmbrain-ingest-contract-'));
let engine:BrainEngine;
const url=process.env.PMBRAIN_RELATION_TEST_DATABASE_URL;
const context={slug:'申报.xlsx',sourceId:'vault',body:'四川省商务厅牵头川商出海项目，并组织企业参加广交会。张三负责川商出海项目。',chunkBody:'四川省商务厅牵头川商出海项目，并组织企业参加广交会。张三负责川商出海项目。'};
const receipt={entities:['companies/四川省商务厅','projects/川商出海','concepts/广交会'],relations:[{from:'companies/四川省商务厅',to:'projects/川商出海',link_type:'mentions',evidence:'四川省商务厅牵头川商出海项目'}]};
async function page(slug:string,type:string,title:string,body:string,sourceId='vault'){
  await engine.putPage(slug,{type:type as any,title,compiled_truth:body,timeline:'',frontmatter:{}},{sourceId});
}
beforeAll(async()=>{
  if(url)assertSafeE2eDatabaseUrl(url);
  engine=url?new PostgresEngine():new PGLiteEngine();
  await engine.connect(url?{database_url:url}:{});await engine.initSchema();
},60_000);
beforeEach(async()=>{
  await resetPgliteState(engine as PGLiteEngine);
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('vault','Vault'),('other','Other') ON CONFLICT DO NOTHING");
  await page(context.slug,'note','申报',context.body);
  for(const [slug,type,title] of [['companies/四川省商务厅','organization','四川省商务厅'],['projects/川商出海','project','川商出海'],['concepts/广交会','concept','广交会']]){
    await page(slug!,type!,title!,`${title}。[Source: 申报.xlsx]`);
  }
});
afterAll(async()=>{await engine.disconnect();},60_000);

test('实际读取完整上游 ingest 契约，包含来源、回链、关系、时间线和状态规则',()=>{
  const contract=readIngestContract();
  for(const text of ['Create cross-reference links','Back-link all entities','Timeline merge','Notability Gate','State sections'])expect(contract).toContain(text);
});

test('项目和概念只按模型明确识别的原文证据入链，完成前读回每条关系，重复不增加',async()=>{
  const first=await finalizeEntityIngest(engine,context,JSON.stringify(receipt));
  expect(first.verified).toBe(true);expect(first.entities).toHaveLength(3);
  const pairs=await engine.executeRaw<{f:string;t:string}>(`SELECT f.slug f,t.slug t FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE l.origin_field=$1`,[ingestOriginField(context)]);
  expect(pairs.some(x=>x.f===context.slug&&x.t==='concepts/广交会')).toBe(true);
  expect(pairs.some(x=>x.f==='projects/川商出海'&&x.t===context.slug)).toBe(true);
  const again=await finalizeEntityIngest(engine,context,JSON.stringify(receipt));
  expect(again.linksCreated).toBe(0);
  expect(await engine.executeRaw('SELECT id FROM links')).toHaveLength(pairs.length);
});

test('原文引号和空白不会拒绝真实项目名称，名称字符不符仍拒绝',async()=>{
  const quoted={...context,body:'省商务厅启动“川商出海”应用场景。',chunkBody:'省商务厅启动“川商出海”应用场景。'};
  await validateIngestWrite(engine,quoted,'put_page',{slug:'projects/川商出海',content:'---\ntitle: 川商出海应用场景\ntype: project\n---\n项目。[Source: 申报.xlsx]'});
  await expect(validateIngestWrite(engine,quoted,'put_page',{slug:'projects/海',content:'---\ntitle: 川企出海应用场景\ntype: project\n---\n项目。[Source: 申报.xlsx]'})).rejects.toThrow('evidence');
});

test('更新没有重复 frontmatter 时继承实体身份，不能把英文 slug 当中文标题重建',async()=>{
  await validateIngestWrite(engine,context,'put_page',{slug:'projects/川商出海',content:'增加项目事实。[Source: 申报.xlsx]'});
  const content=await annotateIngestContent(engine,context,'projects/川商出海','增加项目事实。[Source: 申报.xlsx]');
  expect(parseMarkdown(content,'projects/川商出海').title).toBe('川商出海');
});

test('更新保留既有事实与时间线，只有当前状态被当前状态取代',async()=>{
  const old=await engine.getPage('projects/川商出海',{sourceId:'vault'});
  await engine.putPage('projects/川商出海',{...old!,compiled_truth:'人工事实，不能丢失。\n\n## State\n\n旧状态。',timeline:'2026-01-01 历史事项。'},{sourceId:'vault'});
  const updated=parseMarkdown(await annotateIngestContent(engine,context,'projects/川商出海','---\ntitle: 川商出海\ntype: project\n---\n新事实。[Source: 申报.xlsx]\n\n## State\n\n新状态。[Source: 申报.xlsx]'),'projects/川商出海');
  expect(updated.compiled_truth).toContain('人工事实，不能丢失。');expect(updated.compiled_truth).not.toContain('旧状态。');
  expect(updated.compiled_truth).toContain('新状态。');expect(updated.timeline).toContain('历史事项');
});

test('更新保留老别名、标签和隐私边界，不能覆盖原始资料页',async()=>{
  const old=await engine.getPage('projects/川商出海',{sourceId:'vault'});
  await engine.putPage('projects/川商出海',{...old!,frontmatter:{aliases:['出海项目'],private:true}},{sourceId:'vault'});
  await engine.addTag('projects/川商出海','已核实',{sourceId:'vault'});
  const updated=parseMarkdown(await annotateIngestContent(engine,context,'projects/川商出海','---\ntitle: 川商出海\ntype: project\nprivate: false\naliases: [川商项目]\n---\n补充事实。[Source: 申报.xlsx]'),'projects/川商出海');
  expect(updated.frontmatter.aliases).toEqual(['出海项目','川商项目']);expect(updated.frontmatter.private).toBe(true);expect(updated.tags).toContain('已核实');
  await expect(validateIngestWrite(engine,context,'put_page',{slug:context.slug,content:'---\ntitle: 川商出海\ntype: project\n---\n假更新。[Source: 申报.xlsx]'})).rejects.toThrow('original document');
});

test('导入请求合并确切资料并能在重启后入队，旧无范围请求保留且不会隐式整库扫描',async()=>{
  const key='dream.entity_capture.pending.vault';
  await engine.setConfig('version','134');
  await engine.setConfig(key,'legacy-uuid');
  expect(await enqueueImportedEntityCapture(engine,async()=>true)).toEqual([]);
  expect(await engine.getConfig(key)).toBe('legacy-uuid');
  for(const slug of ['新增.md','修改.md','新增.md'])await engine.transaction(tx=>requestImportedEntityCapture(tx,'vault',{slug,type:'note',compiled_truth:'四川省商务厅工作材料。',frontmatter:{}}));
  expect(JSON.parse((await engine.getConfig(key))!).slugs).toEqual(['新增.md','修改.md']);
  const jobs=await enqueueImportedEntityCapture(engine,async()=>true);
  const [row]=await engine.executeRaw<{slugs:string[]}>('SELECT data->\'task\'->\'input\'->\'slugs\' slugs FROM minion_jobs WHERE id=$1',[jobs[0]]);
  expect(row?.slugs).toEqual(['新增.md','修改.md']);
  expect(await engine.getConfig(key)).toBeNull();
});

test('假实体、无原文证据和错目标不能落库，也不能把缺少结果的子任务当作完成',async()=>{
  await expect(finalizeEntityIngest(engine,context,'整理完成')).rejects.toThrow('receipt');
  await expect(finalizeEntityIngest(engine,context,'{"entities":[],"relations":[],"no_entities":true}',['projects/川商出海'])).rejects.toThrow('omits');
  await expect(finalizeEntityIngest(engine,context,JSON.stringify({...receipt,entities:['projects/不存在']}))).rejects.toThrow();
  await expect(validateIngestWrite(engine,context,'put_page',{slug:'people/虚构人物',content:'---\ntitle: 虚构人物\ntype: person\n---\n[Source: 申报.xlsx]'})).rejects.toThrow('evidence');
  expect(await engine.executeRaw('SELECT id FROM links')).toHaveLength(0);
});

test('新实体缺少 YAML 身份明确报错，显式更新尊重中文标题和类型并保留旧名',async()=>{
  await expect(validateIngestWrite(engine,context,'put_page',{slug:'people/zhang-san',content:'# 张三\n[Source: 申报.xlsx]'})).rejects.toThrow('YAML frontmatter title and type');
  const updated=parseMarkdown(await annotateIngestContent(engine,context,'projects/川商出海','---\ntitle: 川商出海项目\ntype: project\n---\n新增事实。[Source: 申报.xlsx]'),'projects/川商出海');
  expect(updated.title).toBe('川商出海项目');expect(updated.type).toBe('project');expect(updated.frontmatter.aliases).toContain('川商出海');
});

test('同一未变化分块的实体重试不会重读或重写，仍须列入完整验收回执',async()=>{
  let calls=0;
  const base:ToolDef={name:'brain_get_page',description:'read',input_schema:{},idempotent:true,async execute(){calls++;return {status:'ok'};}};
  const acknowledged={...context,acknowledged:['vault:projects/川商出海']};
  const wrapped=entityIngestTools([base,{...base,name:'brain_put_page'}],acknowledged);
  const ctx={engine,jobId:1} as ToolCtx;
  expect(await wrapped[0]!.execute({slug:'projects/川商出海'},ctx)).toMatchObject({status:'unchanged'});
  expect(await wrapped[1]!.execute({slug:'vault:projects/川商出海',content:'不能写入'},ctx)).toMatchObject({status:'unchanged',ingest_links_created:0});
  expect(calls).toBe(0);
  await expect(finalizeEntityIngest(engine,acknowledged,JSON.stringify({entities:['companies/四川省商务厅'],relations:[]}),acknowledged.acknowledged)).rejects.toThrow('omits');
});

test('批量查重逐个名称返回实体身份，近似名称提示核对而不自动合并或创建重复页',async()=>{
  const base:ToolDef={name:'brain_search',description:'search',input_schema:{},idempotent:true,async execute(){throw new Error('不应使用原始全文搜索');}};
  const [search]=entityIngestTools([base],context);
  const found=await search!.execute({query:'商务厅,川商出海,广交会'},{engine,jobId:1} as ToolCtx) as Array<{slug:string}>;
  expect(found.map(row=>row.slug)).toContain('vault:companies/四川省商务厅');expect(found.map(row=>row.slug)).toContain('vault:projects/川商出海');
  await expect(validateIngestWrite(engine,context,'put_page',{slug:'projects/new-name',content:'---\ntitle: 川商出海项目\ntype: project\n---\n新事实。[Source: 申报.xlsx]'})).rejects.toThrow('verify existing entity');
  expect(await engine.getPage('projects/new-name',{sourceId:'vault'})).toBeNull();
});

test('共享默认实体的确切路径由程序解析，读写和时间线复用同一 Source，当前 Source 仍优先',async()=>{
  await page('people/张三','person','张三','张三负责川商出海。','default');
  const calls:Array<Record<string,unknown>>=[];
  const base:ToolDef={name:'brain_get_page',description:'read',input_schema:{},idempotent:true,async execute(input){calls.push(input as Record<string,unknown>);return {slug:'people/张三',source_id:'default'};}};
  const wrapped=entityIngestTools([base,{...base,name:'brain_add_timeline_entry'}],{...context,chunkBody:context.chunkBody+'2026-10-09 张三负责川商出海项目。'});
  const ctx={engine,jobId:1} as ToolCtx;
  expect(await wrapped[0]!.execute({slug:'people/张三'},ctx)).toMatchObject({source_id:'default'});
  expect(calls[0]?.slug).toBe('default:people/张三');
  await wrapped[1]!.execute({slug:'people/张三',date:'2026-10-09',summary:'张三负责川商出海项目。',source:context.slug},ctx);
  expect(calls[1]?.slug).toBe('default:people/张三');
  await page('people/张三','person','张三','张三负责川商出海。');
  await wrapped[0]!.execute({slug:'people/张三'},ctx);expect(calls[2]?.slug).toBe('vault:people/张三');
});

test('预算必须同时留出下一轮和最终回执，不能把最后的验收 Token 花掉',async()=>{
  const [job]=await engine.executeRaw<{id:number}>("INSERT INTO minion_jobs(name,queue,status,data) VALUES('subagent','test','active','{}') RETURNING id");
  await engine.executeRaw("INSERT INTO subagent_messages(job_id,message_idx,role,content_blocks,tokens_in,tokens_out) VALUES($1,0,'assistant','[]',30000,100)",[job!.id]);
  const data:any={prompt:'原文',ingest_context:context,usage_limits:{input:70000,output:20000,cost_cny:null,input_price:null,output_price:null}};
  await checkIngestCallBudget(engine,job!.id,data,'ingest',[],[]);
  expect(await finalizeBeforeIngestBudget(engine,job!.id,data,'ingest',[],[])).toBe(true);
  await checkIngestCallBudget(engine,job!.id,data,'ingest',[{role:'user',content:'原文和结果'}],[],true);
});

test('无证据的候选关系单独记录原因，不能阻止有效来源关联或伪造关系类型',async()=>{
  const result=await finalizeEntityIngest(engine,context,JSON.stringify({...receipt,relations:[{...receipt.relations[0],link_type:'owns'}]}));
  expect(result.unresolved[0]?.reason).toContain('unsupported');
  expect(await engine.executeRaw("SELECT id FROM links WHERE link_type='owns'")).toHaveLength(0);
  expect(await engine.executeRaw("SELECT id FROM links WHERE link_type='mentions'")).toHaveLength(6);
});

test('Source 优先当前再 default，不能借同名实体写到另一个 Source',async()=>{
  await page('people/张三','person','张三','其他来源资料。','other');
  await expect(finalizeEntityIngest(engine,context,JSON.stringify({entities:['other:people/张三'],relations:[]}))).rejects.toThrow('source');
  await page('people/张三','person','张三','共享人物。','default');
  const result=await finalizeEntityIngest(engine,context,JSON.stringify({entities:['people/张三'],relations:[]}));
  expect(result.entities[0]?.sourceId).toBe('default');
  const rows=await engine.executeRaw<{source:string}>(`SELECT t.source_id source FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.slug=$1 AND f.source_id='vault'`,[context.slug]);
  expect(rows.map(x=>x.source)).toEqual(['default']);
});

test('资料修改和删除清理其自动关系，原文、其他 Source 与人工关系保留',async()=>{
  await finalizeEntityIngest(engine,context,JSON.stringify(receipt));
  await engine.addLink('companies/四川省商务厅','projects/川商出海','人工核实','owns','manual',undefined,undefined,{fromSourceId:'vault',toSourceId:'vault'});
  await page(context.slug,'note','申报','只提到四川省商务厅，原来的项目关系已删除。');
  await pruneEntityIngestLinks(engine,'vault');
  const left=await engine.executeRaw<{origin_field:string|null}>('SELECT origin_field FROM links');
  expect(left).toHaveLength(1);expect(left[0]?.origin_field).toBeNull();
  await page(context.slug,'note','申报',context.body);
  await finalizeEntityIngest(engine,context,JSON.stringify(receipt));
  await engine.softDeletePage(context.slug,{sourceId:'vault'});await pruneEntityIngestLinks(engine,'vault');
  expect(await engine.executeRaw('SELECT id FROM links')).toHaveLength(1);
  expect((await engine.getPage(context.slug,{sourceId:'vault',includeDeleted:true}))?.compiled_truth).toBe(context.body);
});

test('来源变化后旧生成事实保留在实体正文，但不再派生有效关系；用户后改的事实保留',async()=>{
  const markdown=await annotateIngestContent(engine,context,'projects/川商出海','---\ntitle: 川商出海\ntype: project\n---\n四川省商务厅牵头 [[companies/四川省商务厅]]。[Source: 申报.xlsx]\n人工确认另有 [[concepts/广交会]]。');
  const parsed=parseMarkdown(markdown,'projects/川商出海');
  await engine.putPage('projects/川商出海',parsed,{sourceId:'vault'});
  const {prepareLinkReconciliation}=await import('../src/core/link-reconciliation.ts');
  await (await prepareLinkReconciliation(engine))('projects/川商出海','vault');
  await page(context.slug,'note','申报','本项目已改为另一个单位牵头。');
  const stored=await engine.getPage('projects/川商出海',{sourceId:'vault'});
  const active=await activeIngestContent(engine,stored!);
  expect(stored?.compiled_truth).toContain('四川省商务厅');expect(active.compiled_truth).not.toContain('四川省商务厅');
  expect(active.compiled_truth).toContain('人工确认');
  await (await prepareLinkReconciliation(engine))('projects/川商出海','vault');
  const links=await engine.getLinks('projects/川商出海',{sourceId:'vault'});
  expect(links.some(link=>link.to_slug==='companies/四川省商务厅')).toBe(false);
  expect(links.some(link=>link.to_slug==='concepts/广交会')).toBe(true);
});

test('清理一份资料仅删除有该来源凭据的 NER，其他资料的正文提及和历史 typed NER 保留',async()=>{
  await page('companies/shared','organization','共享单位','张三和李四负责历史项目。','default');
  await page('people/张三','person','张三','张三的历史档案。','default');
  await page('people/李四','person','李四','李四的历史档案。','default');
  const content='---\ntitle: 共享单位\ntype: organization\n---\n张三和李四负责历史项目。\n四川省商务厅牵头川商出海。[Source: 申报.xlsx]';
  const parsed=parseMarkdown(await annotateIngestContent(engine,context,'default:companies/shared',content),'companies/shared');
  await engine.putPage('companies/shared',parsed,{sourceId:'default'});
  await engine.addLinksBatch([
    {from_slug:'companies/shared',from_source_id:'default',to_slug:'people/李四',to_source_id:'default',link_type:'mentions',link_source:'mentions',link_kind:'plain'},
    {from_slug:'companies/shared',from_source_id:'default',to_slug:'people/张三',to_source_id:'default',link_type:'works_at',link_source:'mentions',link_kind:'typed_ner'},
    {from_slug:'companies/shared',from_source_id:'default',to_slug:'companies/四川省商务厅',to_source_id:'vault',link_type:'works_at',link_source:'mentions',link_kind:'typed_ner',...ingestMentionOrigin(parsed.frontmatter,parsed.compiled_truth,parsed.compiled_truth.indexOf('四川省商务厅'))},
  ]);
  await page(context.slug,'note','申报','这份资料不再提供原来的项目与单位关系。');
  await pruneEntityIngestLinks(engine,'vault');
  const rows=await engine.executeRaw<{to_slug:string;link_kind:string}>("SELECT t.slug to_slug,l.link_kind FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.source_id='default' AND f.slug='companies/shared'");
  expect(rows.some(row=>row.to_slug==='people/张三'&&row.link_kind==='typed_ner')).toBe(true);
  expect(rows.some(row=>row.to_slug==='people/李四'&&(row.link_kind==='plain'||row.link_kind==null))).toBe(true);
  expect(rows.some(row=>row.to_slug==='companies/四川省商务厅')).toBe(false);
  expect((await engine.getPage('companies/shared',{sourceId:'default'}))?.compiled_truth).toContain('四川省商务厅');
});

test('修改资料重新确认的同一条事实更新来源版本，不会因旧凭据继续被隐藏',async()=>{
  const content='---\ntitle: 川商出海\ntype: project\n---\n四川省商务厅牵头 [[companies/四川省商务厅]]。[Source: 申报.xlsx]';
  await engine.putPage('projects/川商出海',parseMarkdown(await annotateIngestContent(engine,context,'projects/川商出海',content),'projects/川商出海'),{sourceId:'vault'});
  const changed={...context,body:context.body+'补充当前工作说明。',chunkBody:context.chunkBody+'补充当前工作说明。'};
  await page(context.slug,'note','申报',changed.body);
  await engine.putPage('projects/川商出海',parseMarkdown(await annotateIngestContent(engine,changed,'projects/川商出海',content),'projects/川商出海'),{sourceId:'vault'});
  const active=await activeIngestContent(engine,(await engine.getPage('projects/川商出海',{sourceId:'vault'}))!);
  expect(active.compiled_truth).toContain('四川省商务厅');expect(active.origins).toHaveLength(1);
});

test('真实 NER 抽取给新生成事实记录原文归属，原文变化后只清理这条关系',async()=>{
  const source={slug:'ner.txt',sourceId:'vault',body:'Dana works at Acme Example.',chunkBody:'Dana works at Acme Example.'};
  await page(source.slug,'note','原始任职资料',source.body);
  await page('companies/acme','company','Acme Example','Acme Example 的历史档案。');
  const content='---\ntitle: Dana\ntype: person\n---\nDana works at Acme Example. [Source: ner.txt]';
  await engine.putPage('people/dana',parseMarkdown(await annotateIngestContent(engine,source,'people/dana',content),'people/dana'),{sourceId:'vault'});
  await engine.setConfig('schema_pack','gbrain-base');
  const {extractNerLinks}=await import('../src/core/extract-ner.ts');
  expect((await extractNerLinks(engine,{sourceIdFilter:'vault',slugs:['people/dana']})).created).toBe(1);
  const rows=await engine.executeRaw<{origin_field:string}>("SELECT l.origin_field FROM links l JOIN pages f ON f.id=l.from_page_id WHERE f.slug='people/dana' AND l.link_kind='typed_ner'");
  expect(rows[0]?.origin_field).toStartWith('ingest_ner:vault:');
  await page(source.slug,'note','原始任职资料','Dana 的任职信息已移除。');
  await pruneEntityIngestLinks(engine,'vault');
  expect(await engine.executeRaw("SELECT l.id FROM links l JOIN pages f ON f.id=l.from_page_id WHERE f.slug='people/dana' AND l.link_kind='typed_ner'")).toHaveLength(0);
});
