import {afterAll,beforeAll,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorkerPgliteEngine} from '../src/product/database/worker-engine.ts';
import {PostgresEngine} from '../src/core/postgres-engine.ts';
import type {BrainEngine} from '../src/core/engine.ts';
import {ProductTaskRuntime} from '../src/product/tasks/runtime.ts';
import {configureGateway,resetGateway} from '../src/core/ai/gateway.ts';
import {buildGatewayConfig} from '../src/core/ai/gateway-config.ts';
import {configPath} from '../src/core/config.ts';
import {assertSafeE2eDatabaseUrl} from './helpers/db-guard.ts';
import {resetPgliteState} from './helpers/reset-pglite.ts';

const url=process.env.PMBRAIN_TASK_WINDOW_TEST_DATABASE_URL;
const keys=['PMBRAIN_HOME','GBRAIN_HOME','DATABASE_URL','PMBRAIN_DATABASE_URL','GBRAIN_DATABASE_URL','PMBRAIN_EMBEDDING_MODEL','GBRAIN_EMBEDDING_MODEL','PMBRAIN_EMBEDDING_DIMENSIONS','GBRAIN_EMBEDDING_DIMENSIONS'];
const previous=keys.map(key=>process.env[key]);
let home:string,engine:BrainEngine,runtime:ProductTaskRuntime,server:ReturnType<typeof Bun.serve>;
let requests=0,held=false;const releases=new Set<()=>void>();
beforeAll(async()=>{
  home=mkdtempSync(join(tmpdir(),'pmbrain-task-window-'));
  for(const key of keys)delete process.env[key];process.env.PMBRAIN_HOME=home;process.env.GBRAIN_HOME=home;
  mkdirSync(join(home,'.pmbrain'));
  server=Bun.serve({port:0,async fetch(req){const body:any=await req.json();requests++;
    if(held)await new Promise<void>(resolve=>releases.add(resolve));
    return Response.json({id:'window-'+requests,object:'chat.completion',created:1,model:body.model,choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'finish-'+requests,type:'function',function:{name:'brain_capture_entities',arguments:JSON.stringify({entities:[],relations:[],no_entities:true})}}]}}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}});
  }});
  const config={engine:url?'postgres' as const:'pglite' as const,database_path:join(home,'test.pglite'),embedding_model:'custom-openai:window-test',embedding_dimensions:1024,custom_openai_api_key:'isolated-window-test',provider_base_urls:{'custom-openai':server.url.origin+'/v1'},'models.dream.synthesize':'custom-openai:window-test',model_usage:{generative_enabled:true,embedding_enabled:false},desktop:{knowledge_directory:home}};
  writeFileSync(configPath(),JSON.stringify(config));configureGateway(buildGatewayConfig(config));
  if(url)assertSafeE2eDatabaseUrl(url);
  engine=url?new PostgresEngine():new WorkerPgliteEngine() as unknown as BrainEngine;
  await engine.connect(url?{database_url:url}:{database_path:config.database_path});await engine.initSchema();
  if(url){await resetPgliteState(engine as any);await engine.setConfig('version','133');}
  await engine.setConfig('dream.entity_capture.cost_cap_cny','1000');
  await engine.setConfig('dream.entity_capture.price.input_cny_per_million','1');
  await engine.setConfig('dream.entity_capture.price.output_cny_per_million','1');
  runtime=new ProductTaskRuntime(engine);await runtime.start();
},60000);
afterAll(async()=>{
  for(const release of releases)release();releases.clear();
  await runtime?.close();await engine?.disconnect();server?.stop(true);resetGateway();
  for(const [index,key] of keys.entries())if(previous[index]===undefined)delete process.env[key];else process.env[key]=previous[index];
  if(home)rmSync(home,{recursive:true,force:true});
},60000);
async function waitFor(predicate:()=>Promise<boolean>,ms=100000){const until=Date.now()+ms;while(Date.now()<until){if(await predicate())return;await Bun.sleep(100);}throw new Error(`isolated task window did not reach its expected state: ${JSON.stringify({requests,runs:await runtime.listRuns()})}`);}

test('33 分块自动归还窗口并继续同一个父任务，累计用量和完成数不丢失',async()=>{
  for(let index=0;index<33;index++)await engine.putPage(`notes/window-${index}`,{type:'note',title:`合成窗口记录${index}`,compiled_truth:'这是窗口验收用的工作核对记录，只包含日常事项，不含值得单独建档的专有名称。'.repeat(3),frontmatter:{}});
  const run=await runtime.submitDream({phase:'capture_entities',sourceId:'default'});
  await waitFor(async()=>['completed','failed'].includes((await runtime.getRun(run.id))!.status));
  const done=(await runtime.getRun(run.id))!;
  expect(done.status,done.error??JSON.stringify(done.result)).toBe('completed');expect(requests).toBe(33);
  const result=done.result as any,capture=result.phases.find((phase:any)=>phase.phase==='capture_entities');
  expect(capture.details.chunks_processed).toBe(33);expect(capture.details.input_tokens).toBe(330);expect(capture.details.output_tokens).toBe(165);
  expect(capture.details.cost_cny).toBeCloseTo(.000495,6);expect(capture.details.cost_cap_cny).toBe(1000);
  const [last]=await engine.executeRaw<{cap:number}>("SELECT (data->'usage_limits'->>'cost_cny')::double precision cap FROM minion_jobs WHERE data ? 'ingest_context' ORDER BY id DESC LIMIT 1");
  expect(last!.cap).toBeCloseTo(999.99952,6);
  const parents=await engine.executeRaw("SELECT id FROM minion_jobs WHERE queue='pmbrain-product'");expect(parents).toHaveLength(1);
  const second=await runtime.submitDream({phase:'capture_entities',sourceId:'default'});
  await waitFor(async()=>['completed','failed'].includes((await runtime.getRun(second.id))!.status));
  expect((await runtime.getRun(second.id))!.status).toBe('completed');expect(requests).toBe(33);
},120000);

test('窗口中的模型请求停止后不继续领取，刷新保持停止，原任务可手动继续',async()=>{
  await engine.putPage('notes/held-window',{type:'note',title:'隔离停止记录',compiled_truth:'这是一条用于停止与继续验收的合成工作记录，没有需要建档的名称。'.repeat(3),frontmatter:{}});
  held=true;const before=requests;
  const run=await runtime.submitDream({phase:'capture_entities',sourceId:'default'});
  await waitFor(async()=>releases.size>0);
  const start=performance.now();await runtime.requestCancel(run.id);expect(performance.now()-start).toBeLessThan(1000);
  await waitFor(async()=>(await runtime.getRun(run.id))!.status==='cancelled');
  await Bun.sleep(1200);expect(requests).toBe(before+1);expect((await runtime.listRuns()).find(row=>row.id===run.id)!.status).toBe('cancelled');
  held=false;for(const release of releases)release();releases.clear();
  const resumed=(await runtime.retry(run.id))!;expect(resumed.id).toBe(run.id);
  await waitFor(async()=>['completed','failed'].includes((await runtime.getRun(run.id))!.status));
  expect((await runtime.getRun(run.id))!.status).toBe('completed');
},120000);
