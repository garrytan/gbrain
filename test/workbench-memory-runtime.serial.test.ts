import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { WorkerPgliteEngine } from '../src/product/database/worker-engine';
import { PostgresEngine } from '../src/core/postgres-engine';
import type { BrainEngine } from '../src/core/engine';
import { configureGateway, resetGateway } from '../src/core/ai/gateway';
import {reloadLiveGateway} from '../src/core/ai/reload-live-gateway';
import { ProductTaskRuntime } from '../src/product/tasks/runtime';
import { registerWorkbenchRoutes } from '../src/product/workbench/routes';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard';

const root=mkdtempSync(join(tmpdir(),'pmbrain-memory-runtime-'));
const keys=['PMBRAIN_HOME','GBRAIN_HOME','DATABASE_URL','PMBRAIN_DATABASE_URL','GBRAIN_DATABASE_URL'];
const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
const postgresUrl=process.env.PMBRAIN_MEMORY_RUNTIME_TEST_DATABASE_URL;
if(postgresUrl)assertSafeE2eDatabaseUrl(postgresUrl);
let engine:BrainEngine,runtime:ProductTaskRuntime,modelServer:ReturnType<typeof Bun.serve>,server:ReturnType<express.Express['listen']>,base:string,config:any;
let failExtraction=false;let extractionCalls=0;let delayExtraction=false;
let first:any;

beforeAll(async()=>{
  for(const key of keys)delete process.env[key];process.env.PMBRAIN_HOME=root;process.env.GBRAIN_HOME=root;mkdirSync(join(root,'.pmbrain'));
  modelServer=Bun.serve({port:0,async fetch(request){
    const body=await request.json() as any;const system=body.messages.find((message:any)=>message.role==='system')?.content??'';
    const text=body.messages.filter((message:any)=>message.role==='user').at(-1)?.content??'';
    const extract=String(system).includes('extract personal-knowledge claims');
    if(extract){extractionCalls++;if(delayExtraction)await Bun.sleep(1500);if(failExtraction&&String(text).includes('失败夹具'))return Response.json({error:{message:'fixture extraction unavailable'}},{status:503});}
    const content=extract?JSON.stringify({facts:String(text).includes('项目方案')?[{fact:'项目方案先写结论，再写依据',kind:'preference',entity:null,confidence:1,notability:'high',transient:false}]:String(text).includes('失败夹具')?[{fact:'失败夹具报告采用中文',kind:'preference',entity:null,confidence:1,notability:'high',transient:false}]:[]}):String(system).includes('项目方案先写结论')?'按你的偏好，项目方案先写结论，再写依据。[1]':'已收到你的表达；记忆将按设置在后台沉淀。';
    const choice={index:0,...(body.stream?{delta:{role:'assistant',content}}:{message:{role:'assistant',content}}),finish_reason:'stop'};
    const result={id:'fixture',object:body.stream?'chat.completion.chunk':'chat.completion',created:1,model:body.model,choices:[choice],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}};
    return body.stream?new Response(`data: ${JSON.stringify(result)}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}}):Response.json(result);
  }});
  config={engine:postgresUrl?'postgres':'pglite',database_path:join(root,'database'),...(postgresUrl?{database_url:postgresUrl}:{}),chat_model:'custom-openai:native-memory-fixture',custom_openai_api_key:'native-fixture-only',provider_base_urls:{'custom-openai':modelServer.url.origin+'/v1'},memory:{auto_writeback:'all'}};
  writeFileSync(join(root,'.pmbrain','config.json'),JSON.stringify(config));
  configureGateway({chat_model:config.chat_model,env:{CUSTOM_OPENAI_API_KEY:'native-fixture-only'},base_urls:config.provider_base_urls});
  engine=postgresUrl?new PostgresEngine():new WorkerPgliteEngine() as unknown as BrainEngine;
  await engine.connect(postgresUrl?{database_url:postgresUrl}:{database_path:config.database_path});await engine.initSchema();
  await engine.setConfig('memory.auto_writeback','all');await engine.setConfig('facts.default_visibility','world');await engine.setConfig('facts.extraction_model',config.chat_model);
  await engine.setConfig('models.chat','anthropic:claude-sonnet-4-6');
  await reloadLiveGateway(engine);
  await open();
},60000);
async function open(){runtime=new ProductTaskRuntime(engine);await runtime.start();const app=express();registerWorkbenchRoutes(app,(req,res,next)=>{if(req.get('x-test-owner')!=='fixture-owner'){res.status(401).json({error:'unauthorized'});return;}next();},engine,config,{storageRoot:join(root,'sessions'),productTasks:runtime});server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${(server.address() as any).port}/admin/api/workbench`;}
async function request(path:string,body?:unknown,method?:string){const response=await fetch(base+path,{method:method??(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json','x-test-owner':'fixture-owner'},...(body===undefined?{}:{body:JSON.stringify(body)})});const result:any=await response.json();if(!response.ok)throw new Error(JSON.stringify(result));return result;}
async function completed(id:string,status='complete'){const until=Date.now()+35000;while(Date.now()<until){const value=await request(`/conversations/${id}`);const memory=value.messages[0]?.memory;if(value.messages.at(-1)?.status!=='running'&&memory?.status===status){const run=memory.taskId?await runtime.getRun(memory.taskId):null;if(status==='failed'?run?.status==='failed':run?.status==='completed')return value;}await Bun.sleep(50);}throw new Error(JSON.stringify({conversation:await request(`/conversations/${id}`),tasks:await runtime.listRuns()}));}
afterAll(async()=>{if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await runtime?.close();await engine?.disconnect();modelServer?.stop(true);resetGateway();for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}},60000);

test('实际 HTTP 对话由持久任务自动提炼，工具和模型调用不写入用户事实',async()=>{
  first=await request('/conversations',{knowledge:false});await request(`/conversations/${first.id}/messages`,{text:'以后项目方案先写结论，再写依据',knowledge:false});
  first=await completed(first.id);expect(first.messages[1].status).toBe('complete');expect(first.messages[0].memory.factIds).toHaveLength(1);expect(first.messages[0].memory.taskId).toMatch(/^task-/);
  const run=await runtime.getRun(first.messages[0].memory.taskId);expect(run?.kind).toBe('conversation_memory');expect(extractionCalls).toBeGreaterThan(0);
  expect(await engine.listFactsBySession('default',first.id,{activeOnly:true})).toHaveLength(1);
},60000);

test('新建会话自动使用已保存偏好，出处接口和服务重启保留同一事实',async()=>{
  const next=await request('/conversations',{knowledge:true});await request(`/conversations/${next.id}/messages`,{text:'请按偏好写一份项目方案',knowledge:true});const value=await completed(next.id);
  expect(value.messages[1].text).toContain('先写结论');expect(value.messages[1].citations.some((row:any)=>row.kind==='memory'&&row.conversationId===first.id)).toBe(true);
  const original=await request(`/conversations/${first.id}/memory/${first.messages[0].id}?hash=${first.messages[0].memory.hash}`);expect(original.text).toBe('以后项目方案先写结论，再写依据');
  const before=extractionCalls;await new Promise<void>(resolve=>server.close(()=>resolve()));await runtime.close();await open();
  const reloaded=await request(`/conversations/${first.id}`);expect(reloaded.messages[0].memory.factIds).toEqual(first.messages[0].memory.factIds);await Bun.sleep(300);expect(extractionCalls).toBe(before);
  const unauthorized=await fetch(base+'/conversations');expect(unauthorized.status).toBe(401);
},60000);

test('模型提炼失败不影响回答，任务中心沿用原任务继续',async()=>{
  failExtraction=true;const thread=await request('/conversations',{knowledge:false});await request(`/conversations/${thread.id}/messages`,{text:'失败夹具报告采用中文',knowledge:false});
  const failed=await completed(thread.id,'failed');expect(failed.messages[1].status).toBe('complete');expect(failed.messages[0].memory.error).toContain('fixture');
  failExtraction=false;const id=failed.messages[0].memory.taskId;const retried=await runtime.retry(id);expect(retried?.id).toBe(id);
  const resumed=await completed(thread.id);expect(resumed.messages[0].memory.factIds).toHaveLength(1);expect(resumed.messages[0].memory.taskId).toBe(id);
},60000);

test('正在沉淀时服务退出，重启继续同一回合且不重复事实',async()=>{
  delayExtraction=true;const before=extractionCalls;const thread=await request('/conversations',{knowledge:false});await request(`/conversations/${thread.id}/messages`,{text:'以后项目方案先写结论，再写依据',knowledge:false});
  const until=Date.now()+20000;while(extractionCalls===before&&Date.now()<until)await Bun.sleep(50);expect(extractionCalls).toBeGreaterThan(before);
  await new Promise<void>(resolve=>server.close(()=>resolve()));await runtime.close();delayExtraction=false;await open();
  const value=await completed(thread.id);expect(value.messages[0].memory.factIds).toHaveLength(1);expect(await engine.executeRaw("SELECT id FROM facts WHERE fact='项目方案先写结论，再写依据' AND source_id='default' AND expired_at IS NULL")).toHaveLength(1);
},60000);
