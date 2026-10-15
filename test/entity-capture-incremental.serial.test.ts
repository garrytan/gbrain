import {afterAll,beforeAll,expect,test} from 'bun:test';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PGLiteEngine} from '../src/core/pglite-engine.ts';
import {PostgresEngine} from '../src/core/postgres-engine.ts';
import type {BrainEngine} from '../src/core/engine.ts';
import {runPhaseCaptureEntities,type CaptureEntitiesOpts} from '../src/core/cycle/capture-entities.ts';
import {assertSafeE2eDatabaseUrl} from './helpers/db-guard.ts';
import {resetPgliteState} from './helpers/reset-pglite.ts';

const previous=process.env.PMBRAIN_HOME;
process.env.PMBRAIN_HOME=mkdtempSync(join(tmpdir(),'pmbrain-capture-incremental-'));
const url=process.env.PMBRAIN_RELATION_TEST_DATABASE_URL;
let engine:BrainEngine;
beforeAll(async()=>{
  if(url)assertSafeE2eDatabaseUrl(url);
  engine=url?new PostgresEngine():new PGLiteEngine();
  await engine.connect(url?{database_url:url}:{});await engine.initSchema();
  await resetPgliteState(engine as PGLiteEngine);
  await engine.setConfig('version','135');
  await engine.setConfig('pmbrain.schema.version','135');
},60000);
afterAll(async()=>{await engine?.disconnect();if(previous===undefined)delete process.env.PMBRAIN_HOME;else process.env.PMBRAIN_HOME=previous;});

test('未变化再次整理不读正文、不调用模型；只改长文尾段时复用成功分块，其他资料保持缓存',async()=>{
  const original=Array.from({length:350},(_,index)=>`第${index}条隔离工作记录，核对今日安排和交付检查项，不包含需要单独建档的名称。`).join('\n');
  for(const [slug,body] of [['notes/long',original],['notes/other','这是另一份保持不变的合成工作记录，核对今天的日常安排和检查清单。'.repeat(3)]]){
    await engine.putPage(slug!,{type:'note',title:slug!,compiled_truth:body!,frontmatter:{}});
  }
  const submissions:Array<{slug:string;body:string}>=[];
  const handler:NonNullable<CaptureEntitiesOpts['handler']>=async ctx=>{
    const ingest=(ctx.data as any).ingest_context;submissions.push({slug:ingest.slug,body:ingest.chunkBody});
    return {ingest_verified:true,ingest_entities:[],result:JSON.stringify({entities:[],relations:[],no_entities:true}),tokens:{in:10,out:5},stop_reason:'end_turn'};
  };
  const options={model:'anthropic:claude-sonnet-4-6',handler,budget:{costCapCny:null,ollama:true}};
  const first=await runPhaseCaptureEntities(engine,options);
  expect(first.status,first.summary).toBe('ok');
  const initial=submissions.length;
  const originalRead=engine.getPage;const read=engine.getPage.bind(engine);let bodyReads=0;
  engine.getPage=async function(...args){bodyReads++;return originalRead.apply(this,args);};
  const second=await runPhaseCaptureEntities(engine,options);
  expect(second.details.pages_cached).toBe(2);expect(bodyReads).toBe(0);expect(submissions).toHaveLength(initial);
  const before=await read('notes/long');
  await engine.putPage('notes/long',{...before!,compiled_truth:original+'\n新增一条没有具名实体的核对记录，确认变更后的验收事项。'.repeat(4)});
  const changed=await runPhaseCaptureEntities(engine,options);
  expect(changed.status,changed.summary).toBe('ok');
  expect(changed.details.pages_cached).toBe(1);
  expect(submissions.slice(initial).map(row=>row.slug)).toEqual(['notes/long']);
  expect(submissions.at(-1)!.body.length).toBeLessThan(1000);
  const [checkpoint]=await engine.executeRaw<{valid:boolean}>("SELECT bool_and(jsonb_typeof(result->'capture_proof')='array' AND result->'graph_reconciled'='true'::jsonb) valid FROM minion_jobs WHERE status='completed'");
  expect(checkpoint?.valid).toBe(true);
},120000);

test('一个窗口最多提交一个分块，后续窗口复用凭据直到完成，不重复模型请求',async()=>{
  await resetPgliteState(engine as PGLiteEngine);await engine.setConfig('version','133');
  for(let index=0;index<3;index++)await engine.putPage(`notes/window-${index}`,{type:'note',title:`隔离窗口${index}`,compiled_truth:'这是一条没有具名实体的工作核对记录，只包含日常安排与验收事项。'.repeat(3),frontmatter:{}});
  let calls=0;
  const statuses:string[]=[];
  for(let window=0;window<3;window++){
    const result=await runPhaseCaptureEntities(engine,{model:'anthropic:claude-sonnet-4-6',getConcurrency:()=>2,window:{maxChunks:1,maxDurationMs:300000},budget:{costCapCny:null,ollama:true},handler:async()=>{
      calls++;return {ingest_verified:true,ingest_entities:[],result:JSON.stringify({entities:[],relations:[],no_entities:true}),tokens:{in:10,out:5},stop_reason:'end_turn'};
    }});
    statuses.push(String(result.details.stop_reason));expect(result.details.chunks_submitted).toBe(1);
  }
  expect(statuses).toEqual(['window','window','completed']);expect(calls).toBe(3);
  expect((await engine.executeRaw('SELECT id FROM minion_jobs'))).toHaveLength(3);
},120000);
