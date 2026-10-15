import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { runPhaseCaptureEntities,splitEntityCaptureCandidate,entityCaptureIdempotencyKey,selectEntityCaptureCandidates } from '../src/core/cycle/capture-entities.ts';
import { runByMentionCore } from '../src/commands/extract.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import {UnrecoverableError} from '../src/core/minions/types.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import {finalizeEntityIngest,readIngestContract} from '../src/core/pmbrain-adapters/entity-ingest-workflow.ts';
import {annotateIngestContent,activeIngestContent} from '../src/core/pmbrain-adapters/ingest-provenance.ts';
import {parseMarkdown} from '../src/core/markdown.ts';
import {entityIngestTools} from '../src/core/pmbrain-adapters/entity-ingest-workflow.ts';
import type {ToolDef} from '../src/core/minions/types.ts';

process.env.PMBRAIN_HOME = mkdtempSync(join(tmpdir(), 'pmbrain-capture-home-'));

const databaseUrl = process.env.PMBRAIN_RELATION_TEST_DATABASE_URL;
let engine: BrainEngine;

beforeAll(async () => {
  if (databaseUrl) assertSafeE2eDatabaseUrl(databaseUrl);
  engine = databaseUrl ? new PostgresEngine() : new PGLiteEngine();
  await engine.connect(databaseUrl ? { database_url: databaseUrl } : {});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine?.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine as PGLiteEngine);
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('vault', 'Vault') ON CONFLICT (id) DO NOTHING`);
  await engine.setConfig('version', '130');
  await engine.setConfig('models.dream.synthesize', 'anthropic:claude-sonnet-4-6');
});

async function note(slug: string, body: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'note', title: slug, compiled_truth: body, timeline: '', frontmatter: {},
  }, { sourceId: 'vault' });
}

test('同页前插和局部变更只请求变化分块，不变资料继续时零请求',async()=>{
  const original=Array.from({length:2400},(_,index)=>`${index}号资料记录。`).join('');
  await note('notes/incremental',original);
  const requested:string[]=[];
  const options={sourceId:'vault',handler:async(ctx:MinionJobContext)=>{
    requested.push((ctx.data as any).ingest_context.chunkBody);
    return {ingest_verified:true,stop_reason:'end_turn',tokens:{in:1,out:1}};
  }};
  const first=await runPhaseCaptureEntities(engine,options);
  expect(first.details.chunks_processed).toBeGreaterThan(2);
  requested.length=0;
  await runPhaseCaptureEntities(engine,options);
  expect(requested).toHaveLength(0);
  await note('notes/incremental','新增开头。'+original.slice(0,1500)+'一条新增事实。'+original.slice(1500));
  const changed=await runPhaseCaptureEntities(engine,options);
  expect(requested).toHaveLength(1);
  expect(changed.details.chunks_processed).toBe(1);
  expect(changed.details.pages_remaining).toBe(0);
},60000);

test('复用分块保留有效事实与原文回链，事实被删除后不得继续命中旧回执',async()=>{
  const slug='notes/incremental-facts';
  const original=Array.from({length:2400},(_,index)=>`张三负责第${index}号资料记录。`).join('');
  await note(slug,original);
  const written:string[]=[];
  let calls=0;
  const options={sourceId:'vault',handler:async(ctx:MinionJobContext)=>{
    calls++;
    const context=(ctx.data as any).ingest_context;
    const fact=context.chunkBody.slice(0,70)+` [Source: ${slug}]`;
    const content=await annotateIngestContent(engine,context,'people/张三',`---\ntitle: 张三\ntype: person\n---\n${fact}`);
    const parsed=parseMarkdown(content,'people/张三');
    await engine.putPage('people/张三',parsed,{sourceId:'vault'});
    written.push(fact);
    return {result:JSON.stringify({entities:['people/张三'],relations:[]}),ingest_entities:[{slug:'people/张三',sourceId:'vault'}],ingest_verified:true,stop_reason:'end_turn',tokens:{in:1,out:1}};
  }};
  await runPhaseCaptureEntities(engine,options);
  const retained=written.at(-1)!;
  calls=0;
  await note(slug,'新加入的开头。'+original);
  await runPhaseCaptureEntities(engine,options);
  expect(calls).toBe(1);
  const page=await engine.getPage('people/张三',{sourceId:'vault'});
  expect((await activeIngestContent(engine,page!)).compiled_truth).toContain(retained);
  expect((await engine.executeRaw('SELECT id FROM links WHERE origin_field LIKE $1',[`ingest:vault:%`])).length).toBeGreaterThan(0);
  await note(slug,original.slice(22500));
  calls=0;
  await runPhaseCaptureEntities(engine,options);
  expect(calls).toBe(0);
  const shortened=await engine.getPage('people/张三',{sourceId:'vault'});
  expect((await activeIngestContent(engine,shortened!)).compiled_truth).toContain(retained);
  expect((await engine.executeRaw('SELECT id FROM links WHERE origin_field LIKE $1',[`ingest:vault:%`])).length).toBeGreaterThan(0);
  await engine.putPage('people/张三',{type:'person',title:'张三',compiled_truth:shortened!.compiled_truth.replace(retained,''),timeline:shortened!.timeline,frontmatter:shortened!.frontmatter},{sourceId:'vault'});
  calls=0;
  await runPhaseCaptureEntities(engine,options);
  expect(calls).toBeGreaterThan(0);
},60000);

test('模型回执已验收但关联检查中断时，继续只补关联检查并完成断点',async()=>{
  const slug='notes/graph-checkpoint';await note(slug,'张三负责这份合成项目的交付和验收，需要保留来源。');
  let calls=0;
  const options={sourceId:'vault',handler:async(ctx:MinionJobContext)=>{
    calls++;const context=(ctx.data as any).ingest_context;
    const content=await annotateIngestContent(engine,context,'people/张三',`---\ntitle: 张三\ntype: person\n---\n张三负责交付和验收。[Source: ${slug}]`);
    await engine.putPage('people/张三',parseMarkdown(content,'people/张三'),{sourceId:'vault'});
    return {result:JSON.stringify({entities:['people/张三'],relations:[]}),ingest_entities:[{slug:'people/张三',sourceId:'vault'}],ingest_verified:true,stop_reason:'end_turn',tokens:{in:1,out:1}};
  }};
  await runPhaseCaptureEntities(engine,options);
  for(const state of [false,null]){
    await engine.executeRaw("UPDATE minion_jobs SET result=CASE WHEN $1::boolean IS NULL THEN result-'graph_reconciled' ELSE jsonb_set(result,'{graph_reconciled}',$1::text::jsonb) END WHERE status='completed'",[state]);
    calls=0;const result=await runPhaseCaptureEntities(engine,options);
    expect(calls).toBe(0);expect(result.details.pages_remaining).toBe(0);
    const [receipt]=await engine.executeRaw<{done:string}>("SELECT result->>'graph_reconciled' done FROM minion_jobs WHERE status='completed' ORDER BY id DESC LIMIT 1");
    expect(receipt?.done).toBe('true');
  }
},60000);

test('两个分块同时等待模型，同一实体补写单提交且两份事实均保留',async()=>{
  await note('notes/window-a','张三负责项目甲的验收工作，需要保留完整事实。');
  await note('notes/window-b','张三负责项目乙的交付工作，需要保留完整事实。');
  let active=0,peak=0,writing=0,peakWriting=0;
  let release!:()=>void;const both=new Promise<void>(resolve=>{release=resolve;});
  const base:ToolDef={name:'brain_put_page',description:'write',input_schema:{type:'object'},idempotent:true,async execute(raw,ctx){
    writing++;peakWriting=Math.max(peakWriting,writing);
    try{await Bun.sleep(10);const input=raw as {slug:string;content:string};
      const parsed=parseMarkdown(input.content,'people/张三');await ctx.engine.putPage('people/张三',parsed,{sourceId:'vault'});return {status:'ok',slug:'people/张三'};
    }finally{writing--;}
  }};
  const result=await runPhaseCaptureEntities(engine,{sourceId:'vault',getConcurrency:()=>2,budget:{costCapCny:null},handler:async ctx=>{
    active++;peak=Math.max(peak,active);if(active===2)release();
    await Promise.race([both,Bun.sleep(150)]);active--;
    const context=(ctx.data as any).ingest_context;
    const write=entityIngestTools([base],context)[0]!;
    await write.execute({slug:'people/张三',content:`---\ntitle: 张三\ntype: person\n---\n${context.chunkBody} [Source: ${context.slug}]`},{engine,jobId:ctx.id,remote:true,signal:ctx.signal});
    return {result:JSON.stringify({entities:['people/张三'],relations:[]}),ingest_entities:[{slug:'people/张三',sourceId:'vault'}],ingest_verified:true,stop_reason:'end_turn',tokens:{in:1,out:1}};
  }});
  expect(peak).toBe(2);expect(peakWriting).toBe(1);expect(result.details.peak_active_chunks).toBe(2);
  const page=await engine.getPage('people/张三',{sourceId:'vault'});
  expect(page?.compiled_truth).toContain('项目甲');expect(page?.compiled_truth).toContain('项目乙');
  expect(result.details.pages_remaining).toBe(0);
},60000);

test('旧版成功凭据可沿用，标题或模型改变时重新识别',async()=>{
  await note('notes/legacy','这份足够长的原始资料只用于验证旧凭据的兼容性。');
  let calls=0;
  const options={sourceId:'vault',handler:async()=>{calls++;return {ingest_verified:true,stop_reason:'end_turn',tokens:{in:1,out:1}};}};
  await runPhaseCaptureEntities(engine,options);
  const [page]=(await selectEntityCaptureCandidates(engine,'vault'));
  await engine.executeRaw("UPDATE minion_jobs SET idempotency_key=$1,data=jsonb_set(data,'{system}',$2::jsonb) WHERE name='subagent'",[entityCaptureIdempotencyKey(page!),JSON.stringify(readIngestContract())]);
  calls=0;await runPhaseCaptureEntities(engine,options);expect(calls).toBe(0);
  await engine.putPage('notes/legacy',{type:'note',title:'变更后的标题',compiled_truth:page!.body,frontmatter:{}},{sourceId:'vault'});
  await runPhaseCaptureEntities(engine,options);expect(calls).toBe(1);
  calls=0;
  await runPhaseCaptureEntities(engine,{...options,model:'anthropic:claude-sonnet-4-7'});
  expect(calls).toBe(1);
},60000);

test('双路等待时停止会撤销两条请求，不领取第三份并保留消耗',async()=>{
  for(const name of ['a','b','c'])await note(`notes/cancel-${name}`,`资料 ${name} 参与并发取消验证，正文保持不变。`);
  const controller=new AbortController();let calls=0,waiting=0;
  const result=await runPhaseCaptureEntities(engine,{sourceId:'vault',getConcurrency:()=>2,signal:controller.signal,budget:{costCapCny:null},handler:async ctx=>{
    calls++;await ctx.updateTokens({input:5,output:2});
    await new Promise<void>((_resolve,reject)=>{
      ctx.signal.addEventListener('abort',()=>reject(ctx.signal.reason),{once:true});
      if(++waiting===2)controller.abort(new Error('user_stop'));
    });
    throw new Error('unexpected completion');
  }});
  expect(calls).toBe(2);expect(result.details.stop_reason).toBe('user_stop');
  expect(result.details.input_tokens).toBe(10);expect(result.details.output_tokens).toBe(4);
  expect(result.details.pages_remaining).toBe(3);
},60000);

test('一路网络失败会撤销另一条等待，保留首个原始错误和两路消耗',async()=>{
  for(const name of ['a','b','c'])await note(`notes/network-${name}`,`资料 ${name} 参与失败取消验证，正文保持不变。`);
  let calls=0,waiting=0,aborted=0;
  let release!:()=>void;const both=new Promise<void>(resolve=>{release=resolve;});
  const result=await runPhaseCaptureEntities(engine,{sourceId:'vault',getConcurrency:()=>2,budget:{costCapCny:null},handler:async ctx=>{
    const call=++calls;await ctx.updateTokens({input:5,output:2});
    if(++waiting===2)release();
    await both;
    if(call===1)throw new UnrecoverableError('ingest_provider_network: certificate verify failed');
    await new Promise<void>((_resolve,reject)=>{
      const stop=()=>{aborted++;reject(ctx.signal.reason);};
      if(ctx.signal.aborted)stop();else ctx.signal.addEventListener('abort',stop,{once:true});
    });
    throw new Error('unexpected completion');
  }});
  expect(calls).toBe(2);expect(aborted).toBe(1);
  expect(result.details.stop_reason).toBe('network');expect(result.summary).toContain('certificate verify failed');
  expect(result.details.input_tokens).toBe(10);expect(result.details.output_tokens).toBe(4);
  expect(result.details.pages_remaining).toBe(3);
},60000);

function promptOf(ctx: MinionJobContext): string {
  const data = ctx.data as { prompt?: string };
  return data.prompt ?? '';
}

test('已有实体放进候选，脚本复用原页，不创建第二个人', async () => {
  await engine.putPage('people/张三', {
    type: 'person', title: '张三', compiled_truth: '张三已经有页。', timeline: '',
    frontmatter: { aliases: ['张老师'] },
  }, { sourceId: 'vault' });
  await note('notes/work', '张老师今天来开会，讨论了新的合作。');
  let prompt = '';
  const result = await runPhaseCaptureEntities(engine, {
    sourceId: 'vault',
    handler: async ctx => {
      prompt = promptOf(ctx);
      if (!prompt.includes('people/张三')) throw new Error('候选里应该有已有人物');
      return { ingest_verified:true, tokens: { in: 20, out: 5 } };
    },
  });
  expect(result.status, result.summary).toBe('ok');
  expect(prompt).toContain('people/张三');
  expect(prompt).toContain('person');
  expect(prompt).toContain('张三');
  expect(prompt).toContain('张老师');
  expect(prompt).toContain('未知类型不建页');
  const people = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE source_id = 'vault' AND type = 'person'`,
  );
  expect(people.map(row => row.slug)).toEqual(['people/张三']);
}, 60_000);

test('失败子任务保留实际用量和原始错误，不让预算和汇总漏掉已发生的调用', async () => {
  await note('notes/failing', '张三在星河公司讨论合作，识别实体时模型可能返回异常响应。');
  let calls = 0;
  const result = await runPhaseCaptureEntities(engine, {
    sourceId: 'vault',
    handler: async ctx => {
      calls += 1;
      await ctx.updateTokens({ input: 12345, output: 321 });
      throw new Error('模型响应处理失败：choices 缺失');
    },
  });
  expect(calls).toBeGreaterThan(0);
  expect(result.details.input_tokens).toBe(12345 * calls);
  expect(result.details.output_tokens).toBe(321 * calls);
  expect(result.details.pages_failed).toBe(1);
  expect(result.error?.message).toContain('choices 缺失');
  expect(result.summary).toContain('choices 缺失');
  expect(result.summary).toContain('失败页：vault:notes/failing');
  expect((result.details.page_failures as any[])[0]).toMatchObject({slug:'notes/failing',sourceId:'vault',stage:'entity_ingest',input_tokens:12345*calls,output_tokens:321*calls});
}, 60_000);

for(const kind of ['user_stop','service_shutdown','timeout'])test(`${kind} 与其他停止原因分开保存，失败页附带消耗及配置上限`,async()=>{
 await note('notes/stopped','张三在星河公司讨论合作，识别过程中需要记录准确失败原因。');
 await engine.setConfig('dream.entity_capture.turn_timeout_ms','750000');
 await engine.setConfig('dream.entity_capture.document_max_turns','3');
 const result=await runPhaseCaptureEntities(engine,{sourceId:'vault',handler:async ctx=>{
  expect(ctx.data.turn_timeout_ms).toBe(750000);expect((await engine.executeRaw<{timeout_ms:number}>('SELECT timeout_ms FROM minion_jobs WHERE id=$1',[ctx.id]))[0]?.timeout_ms).toBe(4590000);
  await ctx.updateTokens({input:23,output:7});throw new UnrecoverableError(`ingest_provider_${kind}: stopped`);
 }});
 expect(result.details.stop_reason).toBe(kind);
 expect((result.details.page_failures as any[])[0]).toMatchObject({kind,input_tokens:23,output_tokens:7,turn_timeout_ms:750000,job_timeout_ms:4590000});
 expect(result.summary).toContain('输入 Token 23/');expect(result.summary).toContain('输出 Token 7/');
},60_000);

for(const kind of ['user_stop','service_shutdown','timeout'])test(`${kind} 的真实中止信号仍保留失败页和已消耗 Token`,async()=>{
 await note('notes/aborted','张三在星河公司讨论合作，中止时仍应保存已经发生的模型用量。');
 const controller=new AbortController();
 const result=await runPhaseCaptureEntities(engine,{sourceId:'vault',signal:controller.signal,handler:async ctx=>{
  await ctx.updateTokens({input:31,output:11});controller.abort(new Error(kind));ctx.signal.throwIfAborted();
 }});
 expect(result.details.stop_reason).toBe(kind);expect(result.details.input_tokens).toBe(31);expect(result.details.output_tokens).toBe(11);
 expect(result.details.pages_failed).toBe(1);expect((result.details.page_failures as any[])[0]).toMatchObject({slug:'notes/aborted',kind,input_tokens:31,output_tokens:11});
},60_000);

test('不存在的实体回执显示落库验收失败，不误报为模型连接失败', async () => {
  await note('notes/unresolved', '团队采用三纪早会体系，早会检查昨日完成事项、今日计划和待处理风险。');
  const result = await runPhaseCaptureEntities(engine, {
    sourceId: 'vault',
    handler: async () => { throw new Error('ingest unresolved target: concepts/san-ji-zao-hui-ti-xi (source vault)'); },
  });
  expect(result.details.stop_reason).toBe('ingest_validation');
  expect(result.details.pages_processed).toBe(0);
  expect(result.details.pages_remaining).toBe(1);
  expect(result.error?.class).toBe('IngestValidation');
  expect(result.summary).toContain('实体落库验收失败');
  expect(result.summary).not.toContain('模型调用失败');
  expect(result.summary).toContain('concepts/san-ji-zao-hui-ti-xi');
}, 60_000);

for(const [errorText,reason] of [
 ['ingest_output_truncated: output truncated after bounded retry','truncated'],
 ['ingest receipt missing or invalid JSON','parse'],
 ['ingest repeated failed write: brain_put_page','ingest_validation'],
 ['ingest_provider_parse: invalid response JSON','parse'],
] as const)test(`${reason} 坏页留待重试，后续正常页完成；再次继续只领取坏页`,async()=>{
 await note('notes/a-bad','这份资料包含三纪早会体系，模拟思考输出持续被截断。');
 await note('notes/z-good','这份正常资料包含团队例会和风险核对，模拟完成实体识别。');
 let calls=0;
 const first=await runPhaseCaptureEntities(engine,{sourceId:'vault',handler:async ctx=>{
  calls++;if(promptOf(ctx).includes('notes/a-bad'))throw new UnrecoverableError(errorText);
  return {ingest_verified:true,stop_reason:'end_turn',tokens:{in:10,out:5}};
 }});
 expect(calls).toBe(2);expect(first.details.pages_processed).toBe(1);expect(first.details.pages_failed).toBe(1);
 expect(first.details.stop_reason).toBe(reason);if(reason==='truncated')expect(first.summary).toContain('输出被截断');
 calls=0;
 const next=await runPhaseCaptureEntities(engine,{sourceId:'vault',handler:async()=>{calls++;return {ingest_verified:true,stop_reason:'end_turn',tokens:{in:10,out:5}};}});
 expect(calls).toBe(1);expect(next.status).toBe('ok');
},60_000);

test('新人、公司、项目和概念按类型落库，新别名复用已有公司', async () => {
  await engine.putPage('companies/xinghe', {
    type: 'company', title: '星河公司', compiled_truth: '已有公司页。', timeline: '', frontmatter: {},
  }, { sourceId: 'vault' });
  await note('notes/deal', '李四代表星河公司推进灯塔项目，并形成潮汐方法。星河实验室是同一家公司。');
  const result = await runPhaseCaptureEntities(engine, {
    sourceId: 'vault',
    handler: async ctx => {
      const prompt = promptOf(ctx);
      expect(prompt).toContain('companies/xinghe');
      await engine.putPage('people/li-si', {
        type: 'person', title: '李四', compiled_truth: '李四代表星河公司。', timeline: '', frontmatter: {},
      }, { sourceId: 'vault' });
      await engine.putPage('companies/xinghe', {
        type: 'company', title: '星河公司', compiled_truth: '已有公司页。别名星河实验室。', timeline: '',
        frontmatter: { aliases: ['星河实验室'] },
      }, { sourceId: 'vault' });
      await engine.putPage('projects/lighthouse', {
        type: 'project', title: '灯塔项目', compiled_truth: '灯塔项目由 [[people/li-si]] 推进，来源是 [[notes/deal]]。', timeline: '', frontmatter: {},
      }, { sourceId: 'vault' });
      await engine.putPage('concepts/tide', {
        type: 'concept', title: '潮汐方法', compiled_truth: '潮汐方法来自 [[notes/deal]] 的合作。', timeline: '', frontmatter: {},
      }, { sourceId: 'vault' });
      const verified=await finalizeEntityIngest(engine,(ctx.data as any).ingest_context,JSON.stringify({entities:['people/li-si','companies/xinghe','projects/lighthouse','concepts/tide'],relations:[]}));
      return {ingest_verified:verified.verified,ingest_entities:verified.entities,ingest_links_created:verified.linksCreated,tokens:{in:30,out:12}};
    },
  });
  expect(result.status, result.summary).toBe('ok');
  const rows = await engine.executeRaw<{ slug: string; type: string }>(
    `SELECT slug, type FROM pages WHERE source_id = 'vault' AND slug IN ('people/li-si', 'companies/xinghe', 'projects/lighthouse', 'concepts/tide') ORDER BY slug`,
  );
  expect(rows).toEqual([
    { slug: 'companies/xinghe', type: 'company' },
    { slug: 'concepts/tide', type: 'concept' },
    { slug: 'people/li-si', type: 'person' },
    { slug: 'projects/lighthouse', type: 'project' },
  ]);
  const companies = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM pages WHERE source_id = 'vault' AND type = 'company'`,
  );
  expect(Number(companies[0]?.n)).toBe(1);
}, 60_000);

test('长文尾部按源文档分块，页数不会让这一篇停在半截', async () => {
  const tail = '尾部实体周舟只出现在最后';
  await note('notes/long', `${'甲'.repeat(9000)}${tail}`);
  const prompts: string[] = [];
  const result = await runPhaseCaptureEntities(engine, {
    sourceId: 'vault',
    maxPages: 1,
    handler: async ctx => {
      prompts.push(promptOf(ctx));
      return { ingest_verified:true, tokens: { in: 5, out: 1 } };
    },
  });
  expect(result.status).toBe('ok');
  expect(result.details.pages_submitted).toBe(1);
  expect(result.details.pages_remaining).toBe(0);
  expect(result.details.stop_reason).toBe('completed');
  expect(result.details.budget_stop).toBeNull();
  expect(Number(result.details.chunks_submitted)).toBeGreaterThan(1);
  expect(prompts.at(-1)).toContain(tail);
  expect(prompts.every(prompt => prompt.includes('notes/long'))).toBe(true);
}, 60_000);

test('跨页累计超过旧默认输入输出额度仍全部处理，保留用量、原文和完成断点',async()=>{
  const originals=new Map<string,string>();
  for(let i=0;i<12;i++){
    const slug=`notes/cumulative-${String(i).padStart(2,'0')}`;const body=`第${i}份原始资料，团队评审本月的交付和风险。`;
    originals.set(slug,body);await note(slug,body);
  }
  await engine.setConfig('dream.entity_capture.cost_cap_cny','unlimited');
  let calls=0;
  const result=await runPhaseCaptureEntities(engine,{sourceId:'vault',handler:async ctx=>{
    calls++;expect(ctx.data.usage_limits).toMatchObject({input:120000,output:20000});
    return {ingest_verified:true,tokens:{in:90000,out:18000}};
  }});
  expect(result.status,result.summary).toBe('ok');expect(calls).toBe(12);
  expect(result.details.input_tokens).toBe(1_080_000);expect(result.details.output_tokens).toBe(216_000);
  expect(result.details.pages_processed).toBe(12);expect(result.details.pages_remaining).toBe(0);
  expect(result.details.stop_reason).toBe('completed');expect(result.details.budget_stop).toBeNull();
  expect(result.details.max_input_tokens).toBeNull();expect(result.details.max_output_tokens).toBeNull();
  for(const [slug,body] of originals)expect((await engine.getPage(slug,{sourceId:'vault'}))?.compiled_truth).toBe(body);
  const next=await runPhaseCaptureEntities(engine,{sourceId:'vault',handler:async()=>{calls++;throw new Error('已完成资料不应再次调用模型');}});
  expect(next.status,next.summary).toBe('ok');expect(calls).toBe(12);expect(next.details.chunks_submitted).toBe(0);
},60000);

test('分块 Token 耗尽只跳过当前资料，后续资料仍完成',async()=>{
  await note('notes/document-tokens','这份资料用于验证单页调用保护及失败信息。');
  await note('notes/z-good','这份正常资料需要继续识别。');
  const limited=await runPhaseCaptureEntities(engine,{sourceId:'vault',handler:async ctx=>{
    if(promptOf(ctx).includes('notes/document-tokens'))throw new UnrecoverableError('ingest_budget_tokens: document token limit');
    return {ingest_verified:true,tokens:{in:10,out:5}};
  }});
  expect(limited.details.stop_reason).toBe('document_tokens');
  expect(limited.details.pages_processed).toBe(1);expect(limited.details.pages_failed).toBe(1);
  expect(limited.details.budget_stop).toBeNull();
},60000);

test('长资料每块独立获得调用和 Token 额度，完成后不重复识别',async()=>{
  const body='长文分块中的实体识别应保留完成断点。'.repeat(1000);
  await note('notes/document-turns',body);
  const chunkCount=splitEntityCaptureCandidate({slug:'notes/document-turns',sourceId:'vault',title:'notes/document-turns',body}).length;
  let calls=0;
  const turns=await runPhaseCaptureEntities(engine,{sourceId:'vault',handler:async ctx=>{
    calls++;expect(ctx.data.max_turns).toBe(20);expect(ctx.data.usage_limits).toMatchObject({input:120000,output:20000});
    return {ingest_verified:true,stop_reason:'end_turn',turns_count:8,tokens:{in:90000,out:18000}};
  }});
  expect(calls).toBe(chunkCount);expect(turns.details.stop_reason).toBe('completed');
  expect(turns.details.pages_processed).toBe(1);expect(turns.details.pages_remaining).toBe(0);
  expect((await engine.getPage('notes/document-turns',{sourceId:'vault'}))?.compiled_truth).toBe(body);
  const next=await runPhaseCaptureEntities(engine,{sourceId:'vault',handler:async()=>{throw new Error('已完成分块不应重复执行');}});
  expect(next.details.chunks_submitted).toBe(0);
},60000);

for(const resultFailure of [false,true])test(`${resultFailure?'模型轮数结果':'模型轮数错误'}仅跳过当前资料，继续时只重试未完成分块`,async()=>{
  const body='这份资料有多个分块，需要保留第一段完成结果。'.repeat(700);
  await note('notes/a-partial',body);await note('notes/z-good','正常资料需要完成识别。');
  let chunkCalls=0,goodCalls=0;
  const first=await runPhaseCaptureEntities(engine,{sourceId:'vault',handler:async ctx=>{
    if(promptOf(ctx).includes('notes/z-good')){goodCalls++;return {ingest_verified:true,stop_reason:'end_turn',tokens:{in:10,out:5}};}
    if(++chunkCalls===2){
      if(resultFailure)return {ingest_verified:false,stop_reason:'max_turns',turns_count:20,tokens:{in:30,out:10}};
      await ctx.updateTokens({input:30,output:10});throw new UnrecoverableError('ingest_turn_limit: 20 turns exhausted');
    }
    return {ingest_verified:true,stop_reason:'end_turn',turns_count:8,tokens:{in:10,out:5}};
  }});
  expect(chunkCalls).toBe(2);expect(goodCalls).toBe(1);
  expect(first.details.pages_processed).toBe(1);expect(first.details.pages_failed).toBe(1);
  expect(first.details.stop_reason).toBe('document_turns');expect(first.details.budget_stop).toBeNull();
  expect((first.details.page_failures as any[])[0]).toMatchObject({slug:'notes/a-partial',kind:'document_turns',input_tokens:30});
  const resumed:string[]=[];
  const next=await runPhaseCaptureEntities(engine,{sourceId:'vault',handler:async ctx=>{resumed.push(promptOf(ctx));return {ingest_verified:true,stop_reason:'end_turn',tokens:{in:10,out:5}};}});
  expect(next.details.pages_processed).toBe(1);expect(next.details.pages_remaining).toBe(0);
  expect(resumed.every(prompt=>!prompt.includes('notes/z-good')&&!prompt.includes('第 1/'))).toBe(true);
  expect(resumed).toHaveLength(splitEntityCaptureCandidate({slug:'notes/a-partial',sourceId:'vault',title:'notes/a-partial',body}).length-1);
},60000);

test('费用到上限后停止新的模型请求，已完成结果保留，任务不失败', async () => {
  await note('notes/a', '第一篇资料足够长，用来识别实体。');
  await note('notes/b', '第二篇资料足够长，用来识别实体。');
  await note('notes/c', '第三篇资料足够长，用来识别实体。');
  let calls = 0;
  const result = await runPhaseCaptureEntities(engine, {
    sourceId: 'vault',
    budget: {
      maxPages: 10,
      costCapCny: 0.01,
      inputPriceCnyPerMillion: 10,
      outputPriceCnyPerMillion: 10,
    },
    handler: async () => {
      calls += 1;
      await engine.putPage('people/first-only', {
        type: 'person', title: '只写一次',
        compiled_truth: '第一轮已经写好。参见 [第一篇](notes/a)。',
        timeline: '', frontmatter: {},
      }, { sourceId: 'vault' });
      return { ingest_verified:true, tokens: { in: 1000, out: 1000 } };
    },
  });
  expect(result.status).toBe('warn');
  expect(calls).toBe(1);
  expect(result.details.budget_stop).toBe('cost');
  expect(result.details.pages_remaining).toBe(2);
  expect(result.details.cost_cny).toBe(0.02);
  expect(result.details.cost_cap_cny).toBe(0.01);
  const people = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM pages WHERE slug = 'people/first-only'`,
  );
  expect(Number(people[0]?.n)).toBe(1);
}, 60_000);

test('Ollama 不记人民币，未知价格或缺用量继续处理，旧累计配置和调用参数不再限制', async () => {
  for (const slug of ['notes/a', 'notes/b', 'notes/c']) {
    await note(slug, `${slug} 的正文足够参与实体识别。`);
  }
  let ollamaCalls = 0;
  const ollama = await runPhaseCaptureEntities(engine, {
    sourceId: 'vault',
    budget: {
      ollama: true,
      maxPages: 3,
      costCapCny: 0.01,
      inputPriceCnyPerMillion: 10_000,
      outputPriceCnyPerMillion: 10_000,
    },
    handler: async () => {
      ollamaCalls += 1;
      return { ingest_verified:true, tokens: { in: 1000, out: 1000 } };
    },
  });
  expect(ollama.status).toBe('ok');
  expect(ollamaCalls).toBe(3);
  expect(ollama.details.cost_cny).toBe(0);
  expect(ollama.details.budget_stop).toBeNull();

  await resetPgliteState(engine as PGLiteEngine);
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('vault', 'Vault') ON CONFLICT (id) DO NOTHING`);
  await engine.setConfig('version', '130');
  await engine.setConfig('models.dream.synthesize', 'anthropic:claude-sonnet-4-6');
  for (const slug of ['notes/a', 'notes/b', 'notes/c']) {
    await note(slug, `${slug} 的正文足够参与实体识别。`);
  }
  let tokenCalls = 0;
  await engine.setConfig('dream.entity_capture.max_input_tokens','1');
  await engine.setConfig('dream.entity_capture.max_output_tokens','1');
  const tokens = await runPhaseCaptureEntities(engine, {
    sourceId: 'vault',
    budget: {
      maxPages: 10,
      costCapCny: 0.01,
      inputPriceCnyPerMillion: null,
      outputPriceCnyPerMillion: null,
      maxInputTokens: 1500,
      maxOutputTokens: 200_000,
    },
    handler: async () => {
      tokenCalls += 1;
      return { ingest_verified:true, tokens: { in: 1000, out: 10 } };
    },
  });
  expect(tokens.status,tokens.summary).toBe('ok');
  expect(tokenCalls).toBe(3);
  expect(tokens.details.budget_stop).toBeNull();
  expect(tokens.details.stop_reason).toBe('completed');
  expect(tokens.details.input_tokens).toBe(3000);expect(tokens.details.output_tokens).toBe(30);
  expect(tokens.summary).not.toContain('按 Token 限制');
  expect(tokens.details.cost_cny).toBeNull();

  await resetPgliteState(engine as PGLiteEngine);
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('vault', 'Vault') ON CONFLICT (id) DO NOTHING`);
  await engine.setConfig('version', '130');
  await engine.setConfig('models.dream.synthesize', 'anthropic:claude-sonnet-4-6');
  for (const slug of ['notes/a', 'notes/b', 'notes/c']) {
    await note(slug, `${slug} 的正文足够参与实体识别。`);
  }
  let blindCalls = 0;
  const blind = await runPhaseCaptureEntities(engine, {
    sourceId: 'vault',
    budget: { maxPages: 2, maxInputTokens: 1, costCapCny: 0.01, inputPriceCnyPerMillion: 10, outputPriceCnyPerMillion: 10 },
    handler: async () => {
      blindCalls += 1;
      return { ingest_verified:true, tokens: { missing: true } };
    },
  });
  expect(blind.status).toBe('ok');
  expect(blindCalls).toBe(3);
  expect(blind.details.budget_stop).toBeNull();
  expect(blind.details.stop_reason).toBe('completed');
  expect(blind.details.pages_remaining).toBe(0);
  expect(blind.details.input_tokens).toBe(0);
  expect(blind.details.cost_cny).toBeNull();
  expect(blind.details.usage_missing).toBe(true);
}, 60_000);

test('识别模型未启用时不创建子任务，并直接说明模型不可用', async () => {
  await note('notes/work', '张三在这里被提到，正文足够长。');
  let calls = 0;
  const result = await runPhaseCaptureEntities(engine, {
    sourceId: 'vault',
    model: 'anthropic:claude-sonnet-4-6',
    modelServices: [{
      provider: 'anthropic',
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.anthropic.com/v1',
    }],
    handler: async () => {
      calls += 1;
      return { ingest_verified:true, tokens: { in: 1, out: 1 } };
    },
  });
  expect(calls).toBe(0);
  expect(result.status).toBe('fail');
  expect(result.error?.message).toBe('实体识别模型不可用');
  expect(result.details.pages_submitted).toBe(0);
  expect(result.details.stop_reason).toBe('model_unavailable');
  expect(result.details.report_line).toContain('停止原因：实体识别模型不可用');
  const jobs = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM minion_jobs`);
  expect(Number(jobs[0]?.n ?? 0)).toBe(0);
}, 60_000);

test('新实体落库后只连接提到它的旧页面', async () => {
  await note('notes/old-liu', '刘慈欣在这部小说里写了地球和三体文明。');
  await note('notes/weather', '这份资料只讨论明天的天气预报和降雨。');
  await engine.executeRaw(
    `UPDATE pages SET links_extracted_at = '2020-01-01T00:00:00.000Z' WHERE source_id = 'vault' AND slug = 'notes/old-liu'`,
  );
  await note('notes/new-liu', '这份新资料需要识别实体，正文足够参与这一轮。');
  await runByMentionCore(engine,{sourceIdFilter:'vault',quiet:true});
  const result = await runPhaseCaptureEntities(engine, {
    sourceId: 'vault',
    batchSize: 1,
    handler: async ctx => {
      if (promptOf(ctx).includes('notes/new-liu')) {
        await engine.putPage('people/liu', {
          type: 'person', title: '刘慈欣', compiled_truth: '刘慈欣写了三体。', timeline: '', frontmatter: {},
        }, { sourceId: 'vault' });
      }
      return { ingest_verified: true };
    },
  });
  expect(result.status).toBe('ok');
  expect(result.details.stop_reason).toBe('completed');
  expect(result.details.pages_remaining).toBe(0);
  expect(Number(result.details.entities_written)).toBeGreaterThan(0);
  expect(result.details.relation_slugs).toContain('notes/old-liu');
  expect(result.details.relation_slugs).not.toContain('notes/weather');
  const links = await engine.executeRaw<{ from_slug: string; to_slug: string; link_source: string }>(
    `SELECT f.slug AS from_slug, t.slug AS to_slug, l.link_source
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
      WHERE t.slug = 'people/liu' AND l.link_source = 'mentions'`,
  );
  expect(links).toContainEqual({ from_slug: 'notes/old-liu', to_slug: 'people/liu', link_source: 'mentions' });
  expect(links.map(row => row.from_slug)).not.toContain('notes/weather');
}, 60_000);

test('失败重跑不重复建人，停止后不再写下一份', async () => {
  await note('notes/work', '张三在这里被提到，正文足够长。');
  let calls = 0;
  const first = await runPhaseCaptureEntities(engine, {
    sourceId: 'vault',
    handler: async () => {
      calls += 1;
      await engine.putPage('people/张三', {
        type: 'person', title: '张三', compiled_truth: '张三只应有一页。', timeline: '', frontmatter: {},
      }, { sourceId: 'vault' });
      if (calls < 4) throw new Error('模型这次失败');
      return { ingest_verified:true, tokens: { in: 3, out: 2 } };
    },
  });
  expect(first.status).toBe('fail');
  expect(calls).toBe(3);
  const second = await runPhaseCaptureEntities(engine, {
    sourceId: 'vault',
    handler: async () => {
      calls += 1;
      await engine.putPage('people/张三', {
        type: 'person', title: '张三', compiled_truth: '张三只应有一页。', timeline: '', frontmatter: {},
      }, { sourceId: 'vault' });
      return { ingest_verified:true, tokens: { in: 3, out: 2 } };
    },
  });
  expect(second.status).toBe('ok');
  expect(calls).toBe(4);
  const people = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM pages WHERE source_id = 'vault' AND slug = 'people/张三'`,
  );
  expect(Number(people[0]?.n)).toBe(1);
  await runByMentionCore(engine, { sourceIdFilter: 'vault', quiet: true });
  await runByMentionCore(engine, { sourceIdFilter: 'vault', quiet: true });
  const links = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
      WHERE f.slug = 'notes/work' AND t.slug = 'people/张三' AND l.link_source = 'mentions'`,
  );
  expect(Number(links[0]?.n)).toBe(1);

  await note('notes/keep', '这份会在停止前写完，正文足够长。');
  await note('notes/later', '这份在停止后不能再送给模型，正文足够长。');
  const controller = new AbortController();
  let stoppedCalls = 0;
  const stopped=await runPhaseCaptureEntities(engine, {
    sourceId: 'vault',
    signal: controller.signal,
    handler: async () => {
      stoppedCalls += 1;
      if (stoppedCalls > 1) {
        await engine.putPage('people/next', {
          type: 'person', title: '不该出现', compiled_truth: '停止后不应再写。', timeline: '', frontmatter: {},
        }, { sourceId: 'vault' });
      } else {
        await engine.putPage('people/kept', {
          type: 'person', title: '已完成', compiled_truth: '停止前这一页保留。', timeline: '', frontmatter: {},
        }, { sourceId: 'vault' });
        controller.abort();
      }
      return { ingest_verified:true, tokens: { in: 1, out: 1 } };
    },
  });
  expect(stopped.details.stop_reason).toBe('aborted');
  expect(stopped.details.pages_failed).toBe(1);
  expect(stoppedCalls).toBe(1);
  const kept = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM pages WHERE slug = 'people/kept'`,
  );
  const leaked = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM pages WHERE slug = 'people/next'`,
  );
  expect(Number(kept[0]?.n)).toBe(1);
  expect(Number(leaked[0]?.n)).toBe(0);
}, 60_000);

test('同一批先写人再写公司，正文里的任职会变成两人之间的关系', async () => {
  await note('notes/deal', '张三在星河科技任职，并负责智慧水务项目。');
  await note('notes/weather', '这份资料只讨论明天的天气预报和降雨。');
  await runByMentionCore(engine,{sourceIdFilter:'vault',quiet:true});
  const result = await runPhaseCaptureEntities(engine, {
    sourceId: 'vault',
    handler: async () => {
      await engine.putPage('people/张三', {
        type: 'person',
        title: '张三',
        compiled_truth: '张三在[星河科技](companies/xinghe)任职。参见 [合作记录](notes/deal)。',
        timeline: '',
        frontmatter: { company: '星河科技' },
      }, { sourceId: 'vault' });
      await engine.putPage('companies/xinghe', {
        type: 'company',
        title: '星河科技',
        compiled_truth: '星河科技的负责人见 [张三](people/张三)。参见 [合作记录](notes/deal)。',
        timeline: '',
        frontmatter: { key_people: ['张三'] },
      }, { sourceId: 'vault' });
      return { ingest_verified:true, tokens: { in: 20, out: 8 } };
    },
  });
  expect(result.status).toBe('ok');
  expect(result.details.stop_reason).toBe('completed');
  expect(String(result.details.report_line)).toContain('关系检查：识别实体 2，已关联 2，孤立实体 0，未关联提及 0。');
  expect(result.details.relation_slugs).not.toContain('notes/weather');
  const links = await engine.executeRaw<{ from_slug: string; to_slug: string; link_type: string; link_source: string }>(
    `SELECT f.slug AS from_slug, t.slug AS to_slug, l.link_type, l.link_source
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
      WHERE l.link_type = 'works_at'
        AND f.slug = 'people/张三'
        AND t.slug = 'companies/xinghe'`,
  );
  expect(links).toContainEqual({
    from_slug: 'people/张三',
    to_slug: 'companies/xinghe',
    link_type: 'works_at',
    link_source: 'markdown',
  });
  const weather = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
      WHERE f.slug = 'notes/weather'`,
  );
  expect(Number(weather[0]?.n ?? 0)).toBe(0);
}, 60_000);

test('实体写出来但没有任何关系时，关系检查不报完全成功', async () => {
  await note('notes/plain', '这份资料正文足够长，但没有点名任何实体。');
  const result = await runPhaseCaptureEntities(engine, {
    sourceId: 'vault',
    handler: async () => {
      await engine.putPage('people/孤岛', {
        type: 'person',
        title: '孤岛人',
        compiled_truth: '这一页没有链回资料，也没有其他实体。',
        timeline: '',
        frontmatter: {},
      }, { sourceId: 'vault' });
      return { ingest_verified:true, tokens: { in: 8, out: 2 } };
    },
  });
  expect(result.status).toBe('warn');
  expect(result.details.stop_reason).toBe('completed');
  expect(result.details.entities_isolated).toBe(1);
  expect(String(result.details.report_line)).toContain('关系检查：识别实体 1，已关联 0，孤立实体 1，未关联提及 0。');
}, 60_000);

test('同一件事写到每个实体的时间线，叠起来的当前状态只留最后一节', async () => {
  await note('notes/move', '2026-03-01，张三在星河科技任职，负责智慧水务项目。');
  const result = await runPhaseCaptureEntities(engine, {
    sourceId: 'vault',
    handler: async ctx => {
      await engine.putPage('people/张三', {
        type: 'person',
        title: '张三',
        compiled_truth: [
          '张三在[星河科技](companies/xinghe)任职。参见 [到任记录](notes/move)。',
          '## 当前状态',
          '旧职星河科技',
          '## Timeline',
          '保留',
          '## 当前状态',
          '现任北海数据',
        ].join('\n'),
        timeline: '',
        frontmatter: { company: '星河科技' },
      }, { sourceId: 'vault' });
      await engine.putPage('companies/xinghe', {
        type: 'company',
        title: '星河科技',
        compiled_truth: '星河科技。参见 [到任记录](notes/move)。',
        timeline: '',
        frontmatter: {},
      }, { sourceId: 'vault' });
      await engine.putPage('projects/shuiwu', {
        type: 'project',
        title: '智慧水务',
        compiled_truth: '智慧水务项目。参见 [到任记录](notes/move)。',
        timeline: '',
        frontmatter: {},
      }, { sourceId: 'vault' });
      const verified=await finalizeEntityIngest(engine,(ctx.data as any).ingest_context,JSON.stringify({entities:['people/张三','companies/xinghe','projects/shuiwu'],relations:[]}));
      return {ingest_verified:verified.verified,ingest_entities:verified.entities,ingest_links_created:verified.linksCreated,tokens:{in:20,out:8}};
    },
  });
  expect(result.status).toBe('ok');
  const person = await engine.getPage('people/张三', { sourceId: 'vault' });
  expect(person?.compiled_truth.match(/当前状态/g)).toHaveLength(1);
  expect(person?.compiled_truth).toContain('现任北海数据');
  expect(person?.compiled_truth).not.toContain('旧职星河科技');
  expect(person?.compiled_truth).toContain('## Timeline');
  const rows = [];
  for (const slug of ['people/张三', 'companies/xinghe', 'projects/shuiwu']) {
    const entries = await engine.getTimeline(slug, { sourceId: 'vault' });
    expect(entries.length).toBeGreaterThan(0);
    rows.push(...entries.map(entry => {
      const rawDate: unknown = entry.date;
      const date = rawDate instanceof Date
        ? `${rawDate.getFullYear()}-${String(rawDate.getMonth() + 1).padStart(2, '0')}-${String(rawDate.getDate()).padStart(2, '0')}`
        : String(rawDate).slice(0, 10);
      return {
        slug,
        date,
        summary: entry.summary,
        source: entry.source,
      };
    }));
  }
  expect(new Set(rows.map(row => row.date))).toEqual(new Set(['2026-03-01']));
  expect(new Set(rows.map(row => row.summary)).size).toBe(1);
  expect(rows.every(row => row.source === 'vault:notes/move')).toBe(true);
}, 60_000);
