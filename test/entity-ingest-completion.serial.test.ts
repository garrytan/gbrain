import {afterAll,afterEach,beforeAll,beforeEach,expect,test} from 'bun:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGLiteEngine} from '../src/core/pglite-engine.ts';
import {PostgresEngine} from '../src/core/postgres-engine.ts';
import type {BrainEngine} from '../src/core/engine.ts';
import {configureGateway,resetGateway,__setChatTransportForTests,type ChatResult} from '../src/core/ai/gateway.ts';
import {makeSubagentHandler,type MessagesClient} from '../src/core/minions/handlers/subagent.ts';
import type {MinionJobContext,ToolDef} from '../src/core/minions/types.ts';
import {parseMarkdown} from '../src/core/markdown.ts';
import {assertSafeE2eDatabaseUrl} from './helpers/db-guard.ts';
import {resetPgliteState} from './helpers/reset-pglite.ts';
import {checkIngestCallBudget} from '../src/core/pmbrain-adapters/entity-ingest-workflow.ts';

const previous=process.env.PMBRAIN_HOME;
process.env.PMBRAIN_HOME=mkdtempSync(join(tmpdir(),'pmbrain-ingest-completion-'));
const url=process.env.PMBRAIN_RELATION_TEST_DATABASE_URL;
let engine:BrainEngine;
const context={slug:'notes/meeting',sourceId:'default',body:'团队采用三纪早会体系，每次早会核对昨日工作、今日计划和风险。',chunkBody:'团队采用三纪早会体系，每次早会核对昨日工作、今日计划和风险。'};
const slug='concepts/san-ji-zao-hui-ti-xi';
const receipt=JSON.stringify({entities:[slug],relations:[]});
const content='---\ntitle: 三纪早会体系\ntype: concept\n---\n团队采用三纪早会体系。[Source: notes/meeting]';
const tools:ToolDef[]=[{name:'brain_put_page',description:'write',input_schema:{type:'object'},idempotent:true,async execute(raw,ctx){
 const input=raw as {slug:string;content:string};const parts=input.slug.split(':');const sourceId=parts.length>1?parts.shift()!:'default';const target=parts.join(':');
 const page=await ctx.engine.putPage(target,parseMarkdown(input.content,target),{sourceId});return {slug:page.slug,source_id:page.source_id};
}}];
beforeAll(async()=>{if(url)assertSafeE2eDatabaseUrl(url);engine=url?new PostgresEngine():new PGLiteEngine();await engine.connect(url?{database_url:url}:{});await engine.initSchema();},60_000);
beforeEach(async()=>{await resetPgliteState(engine as PGLiteEngine);await engine.putPage(context.slug,{type:'note',title:'原始记录',compiled_truth:context.body,frontmatter:{}});configureGateway({chat_model:'custom-openai:Qwen3.6-35B-A3B',generative_enabled:true,env:{CUSTOM_OPENAI_API_KEY:'isolated-test-only',ANTHROPIC_API_KEY:'isolated-test-only'}});});
afterEach(()=>{__setChatTransportForTests(null);resetGateway();});
afterAll(async()=>{await engine.disconnect();if(previous===undefined)delete process.env.PMBRAIN_HOME;else process.env.PMBRAIN_HOME=previous;},60_000);

function response(text=receipt,write=false):ChatResult{return {text:write?'':text,providerId:'custom-openai',model:'custom-openai:Qwen3.6-35B-A3B',blocks:write?[{type:'tool-call',toolCallId:'put-entity',toolName:'brain_put_page',input:{slug,content}}]:[{type:'text',text}],stopReason:write?'tool_calls':'end',usage:{input_tokens:10,output_tokens:5,cache_read_tokens:0,cache_creation_tokens:0}};}

test('截断恢复扣除持久用量并预留最终回执，最终回执可使用剩余额度',async()=>{
 const data={prompt:'实体验收',model:'custom-openai:Qwen3.6-35B-A3B',model_output_limit:10,usage_limits:{input:100000,output:30,cost_cny:null,input_price:null,output_price:null}};
 const [job]=await engine.executeRaw<{id:number}>("INSERT INTO minion_jobs(name,status,data) VALUES('subagent','active',$1::jsonb) RETURNING id",[JSON.stringify(data)]);
 await engine.executeRaw("INSERT INTO subagent_messages(job_id,message_idx,role,content_blocks,tokens_in,tokens_out) VALUES($1,0,'assistant','[]'::jsonb,10,8)",[job!.id]);
 expect(await checkIngestCallBudget(engine,job!.id,data,'',[],[],false,20,true)).toBe(12);
 expect(await checkIngestCallBudget(engine,job!.id,data,'',[],[],true,20,true)).toBe(20);
 expect(await checkIngestCallBudget(engine,job!.id,{...data,usage_limits:{...data.usage_limits,output:18}},'',[],[],false,20,true)).toBe(0);
});
async function run(replies:(ChatResult|Error)[],direct=false,maxTurns=6,seed?:string,wireModel?:string){
 const data={prompt:'识别三纪早会体系，先落库再返回实体回执。',model:wireModel??(direct?'anthropic:claude-sonnet-4-6':'custom-openai:Qwen3.6-35B-A3B'),source_id:'default',max_turns:maxTurns,model_output_limit:64000,ingest_context:context};
 const [job]=await engine.executeRaw<{id:number}>("INSERT INTO minion_jobs(name,status,data) VALUES('subagent','active',$1::jsonb) RETURNING id",[JSON.stringify(data)]);
 if(seed!==undefined){
  await engine.executeRaw("INSERT INTO subagent_messages(job_id,message_idx,role,content_blocks) VALUES($1,0,'user',$2::jsonb)",[job!.id,JSON.stringify([{type:'text',text:data.prompt}])]);
  await engine.executeRaw("INSERT INTO subagent_messages(job_id,message_idx,role,content_blocks,tokens_in,tokens_out) VALUES($1,1,'assistant',$2::jsonb,10,5)",[job!.id,JSON.stringify([{type:'text',text:seed}])]);
 }
 const calls:any[]=[];
 const next=(request:unknown)=>{calls.push(request);const value=replies.shift();if(!value)throw new Error('unexpected extra model call');if(value instanceof Error)throw value;return value;};
 __setChatTransportForTests(wireModel?null:async request=>next(request));
 const client:MessagesClient={async create(request){const value=next(request);return {id:'message-'+calls.length,type:'message',role:'assistant',model:data.model,stop_reason:value.stopReason==='tool_calls'?'tool_use':'end_turn',stop_sequence:null,content:value.blocks.map(block=>block.type==='tool-call'?{type:'tool_use',id:block.toolCallId,name:block.toolName,input:block.input}:{type:'text',text:(block as any).text}),usage:{input_tokens:10,output_tokens:5}} as any;}};
 const ctx={id:job!.id,name:'subagent',data,attempts_made:0,signal:new AbortController().signal,shutdownSignal:new AbortController().signal,updateProgress:async()=>{},updateTokens:async()=>{},log:async()=>{},isActive:async()=>true,readInbox:async()=>[]} as MinionJobContext;
 const handler=makeSubagentHandler({engine,config:{engine:url?'postgres':'pglite'},toolRegistry:tools,...(direct?{client}:{})});
 return {calls,jobId:job!.id,result:handler(ctx),resume:async()=>{const [stored]=await engine.executeRaw<{data:typeof data|string}>('SELECT data FROM minion_jobs WHERE id=$1',[job!.id]);return handler({...ctx,data:typeof stored!.data==='string'?JSON.parse(stored!.data):stored!.data});}};
}

test('端点拒绝工具后切换受限 JSON，重启沿用协议且不重复落库',async()=>{
 const rejected=Object.assign(new Error('tools not supported'),{statusCode:400});
 const jsonWrite=JSON.stringify({tool_calls:[{name:'brain_put_page',arguments:{slug,content}}]});
 const attempt=await run([rejected,response(jsonWrite),new Error('模拟软件退出'),response()]);
 expect(String(await attempt.result.catch(error=>error))).toContain('模拟软件退出');
 const [stored]=await engine.executeRaw<{enabled:string}> ("SELECT data->>'ingest_json_tools' AS enabled FROM minion_jobs WHERE id=$1",[attempt.jobId]);
 expect(stored?.enabled).toBe('true');
 const result=await attempt.resume();expect(result.ingest_verified).toBe(true);expect(result.tokens).toMatchObject({in:20,out:10});
 expect(attempt.calls[0].tools.length).toBeGreaterThan(0);expect(attempt.calls.slice(1).every(call=>call.tools===undefined)).toBe(true);
 expect(await engine.executeRaw('SELECT id FROM pages WHERE slug=$1',[slug])).toHaveLength(1);
 expect(await engine.executeRaw('SELECT id FROM subagent_tool_executions WHERE job_id=$1 AND status=$2',[attempt.jobId,'complete'])).toHaveLength(1);
});

for(const model of ['deepseek:deepseek-v4-flash','mimo:mimo-v2.6-pro','custom-openai:Qwen3.6-35B-A3B','ollama:Qwen3.6-35B-A3B'])test(`${model} 实际 HTTP 请求经过 JSON 工具兜底，实体和来源关系落库后重载`,async()=>{
 const requests:any[]=[];
 let completions=0;
 const server=Bun.serve({port:0,async fetch(request){
  const body:any=await request.json();requests.push(body);
  if(body.tools)return Response.json({error:{message:'tools not supported'}},{status:400});
  if(body.response_format)return Response.json({error:{message:'response_format json_schema unsupported'}},{status:422});
  const text=++completions===1?JSON.stringify({tool_calls:[{name:'brain_put_page',arguments:{slug,content}}]}):receipt;
  if(new URL(request.url).pathname.endsWith('/api/chat'))return new Response(JSON.stringify({model:body.model,message:{role:'assistant',content:JSON.stringify({result:JSON.parse(text)})},done:true,done_reason:'stop',prompt_eval_count:10,eval_count:5})+'\n',{headers:{'content-type':'application/x-ndjson'}});
  return Response.json({id:'wire-ingest',object:'chat.completion',created:1,model:body.model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:text}}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}});
 }});
 try{
  const provider=model.split(':')[0]!;
  configureGateway({chat_model:model,generative_enabled:true,base_urls:{[provider]:server.url.origin+'/v1'},env:{DEEPSEEK_API_KEY:'test-key',MIMO_API_KEY:'test-key',CUSTOM_OPENAI_API_KEY:'test-key'}});
  const attempt=await run([],false,3,undefined,model);
  const result=await attempt.result;expect(result.ingest_verified).toBe(true);expect(result.tokens).toMatchObject({in:20,out:10});
  expect(requests[0].tools.length).toBeGreaterThan(0);expect(requests.slice(1).every(body=>body.tools===undefined)).toBe(true);
  if(provider==='deepseek'||provider==='mimo')expect(requests[0].thinking).toEqual({type:'disabled'});
  if(provider==='custom-openai')expect(requests[0].chat_template_kwargs).toEqual({enable_thinking:false});
  if(provider==='ollama')expect(requests.at(-1).think).toBe(false);
  expect((await engine.getPage(slug))?.title).toBe('三纪早会体系');
  expect(await engine.executeRaw('SELECT id FROM links WHERE origin_page_id=(SELECT id FROM pages WHERE slug=$1)',[context.slug])).toHaveLength(2);
  const calls=requests.length;expect((await attempt.resume()).ingest_verified).toBe(true);expect(requests).toHaveLength(calls);
 }finally{server.stop(true);}
},30_000);

test('思考草稿带 JSON 时取最终回执，不重复调用模型',async()=>{
 await engine.putPage(slug,{type:'concept',title:'三纪早会体系',compiled_truth:'真实概念。',frontmatter:{}});
 const attempt=await run([response(`<think>{"entities":["concepts/draft"]}</think>${receipt}`)]);
 expect((await attempt.result).ingest_verified).toBe(true);expect(attempt.calls).toHaveLength(1);
});

test('截断后退出再恢复时沿用64k重试，保存消耗并不执行半截工具',async()=>{
 const truncated={...response('',true),text:'',stopReason:'length' as const,usage:{input_tokens:10,output_tokens:32000,cache_read_tokens:0,cache_creation_tokens:0}};
 const attempt=await run([truncated,new Error('模拟软件退出'),response('',true),response()],false,6);
 expect(String(await attempt.result.catch(error=>error))).toContain('模拟软件退出');expect(await engine.getPage(slug)).toBeNull();
 const result=await attempt.resume();expect(result.ingest_verified).toBe(true);expect(result.tokens.out).toBe(32010);
 expect(attempt.calls[1].maxTokens).toBe(64000);expect(attempt.calls[2].maxTokens).toBe(64000);
 expect(await engine.executeRaw('SELECT id FROM pages WHERE slug=$1',[slug])).toHaveLength(1);
});

for(const direct of [false,true])test(`${direct?'共享 SDK':'Qwen 兼容接口'}：模型未落库却报完成时，剩余预算内纠正并真实建立来源关联`,async()=>{
 const attempt=await run([response(),response('',true),response()],direct);
 const result=await attempt.result;
 expect(result.ingest_verified).toBe(true);expect(result.ingest_entities).toHaveLength(1);expect(attempt.calls).toHaveLength(3);
 expect(result.tokens).toMatchObject({in:30,out:15});
 expect(await engine.executeRaw('SELECT id FROM links WHERE origin_page_id=(SELECT id FROM pages WHERE slug=$1)',[context.slug])).toHaveLength(2);
 const messages=await engine.executeRaw<{content_blocks:unknown}>('SELECT content_blocks FROM subagent_messages WHERE job_id=$1 ORDER BY message_idx',[attempt.jobId]);
 expect(JSON.stringify(messages)).toContain('ingest unresolved target');
 expect((await engine.getPage(context.slug))?.compiled_truth).toBe(context.body);
});

test('连续声明不存在的目标只消耗原有轮数上限，不能成功、造实体或造关系',async()=>{
 const attempt=await run([response(),response()],false,2);
 const error=await attempt.result.catch(error=>error);
 expect(String(error)).toContain('ingest unresolved target');expect(attempt.calls).toHaveLength(2);
 expect(await engine.getPage(slug)).toBeNull();expect(await engine.executeRaw('SELECT id FROM links')).toHaveLength(0);
});

test('已落库的有效回执不追加模型调用',async()=>{
 await engine.putPage(slug,{type:'concept',title:'三纪早会体系',compiled_truth:'真实概念。',frontmatter:{}});
 const attempt=await run([response()]);expect((await attempt.result).ingest_verified).toBe(true);expect(attempt.calls).toHaveLength(1);
});

test('模型用普通文字报完成时，要求补完整 JSON，而不是丢掉本次资料',async()=>{
 const attempt=await run([response('已整理完毕。'),response('',true),response()]);
 expect((await attempt.result).ingest_verified).toBe(true);expect(attempt.calls).toHaveLength(3);
 const messages=await engine.executeRaw('SELECT content_blocks FROM subagent_messages WHERE job_id=$1',[attempt.jobId]);
 expect(JSON.stringify(messages)).toContain('ingest receipt missing or invalid JSON');
 expect(await engine.executeRaw('SELECT id FROM links')).toHaveLength(2);
});

for(const direct of [false,true])test(`${direct?'共享 SDK':'兼容接口'}：纠错反馈已保存后退出，恢复沿用反馈和原预算，不重复落库`,async()=>{
 const attempt=await run([response(),new Error('模拟软件退出'),response('',true),response()],direct,4);
 const stopped=await attempt.result.catch(error=>error);expect(String(stopped)).toContain('模拟软件退出');
 expect(await engine.getPage(slug)).toBeNull();
 const result=await attempt.resume();expect(result.ingest_verified).toBe(true);expect(result.tokens).toMatchObject({in:30,out:15});
 expect(attempt.calls).toHaveLength(4);expect(await engine.executeRaw('SELECT id FROM pages WHERE slug=$1',[slug])).toHaveLength(1);
 expect(await engine.executeRaw('SELECT id FROM links')).toHaveLength(2);
});

test('兼容接口在有效回执已持久化后退出，恢复只验收数据库，不再请求模型',async()=>{
 await engine.putPage(slug,{type:'concept',title:'三纪早会体系',compiled_truth:'真实概念。',frontmatter:{}});
 const attempt=await run([],false,6,receipt);
 const result=await attempt.result;expect(result.ingest_verified).toBe(true);expect(result.turns_count).toBe(1);
 expect(result.tokens).toMatchObject({in:10,out:5});expect(attempt.calls).toHaveLength(0);
 expect(await engine.executeRaw('SELECT id FROM links')).toHaveLength(2);
});
