import { expectRejection } from './helpers/await-rejection.ts';
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
import {checkIngestCallBudget,entityIngestTools,type EntityIngestContext} from '../src/core/pmbrain-adapters/entity-ingest-workflow.ts';
import { randomUUID } from 'node:crypto';

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
async function run(replies:(ChatResult|Error)[],direct=false,maxTurns=6,seed?:string,wireModel?:string,ingestContext:EntityIngestContext=context,attempt=0){
 const data={prompt:'识别实体，先落库再返回实体回执。',model:wireModel??(direct?'anthropic:claude-sonnet-4-6':'custom-openai:Qwen3.6-35B-A3B'),source_id:'default',max_turns:maxTurns,model_output_limit:64000,ingest_context:ingestContext};
 const [job]=await engine.executeRaw<{id:number}>("INSERT INTO minion_jobs(name,status,data) VALUES('subagent','active',$1::jsonb) RETURNING id",[JSON.stringify(data)]);
 if(seed!==undefined){
  await engine.executeRaw("INSERT INTO subagent_messages(job_id,message_idx,role,content_blocks) VALUES($1,0,'user',$2::jsonb)",[job!.id,JSON.stringify([{type:'text',text:data.prompt}])]);
  await engine.executeRaw("INSERT INTO subagent_messages(job_id,message_idx,role,content_blocks,tokens_in,tokens_out) VALUES($1,1,'assistant',$2::jsonb,10,5)",[job!.id,JSON.stringify([{type:'text',text:seed}])]);
 }
 const calls:any[]=[];
 const next=(request:unknown)=>{calls.push(request);const value=replies.shift();if(!value)throw new Error('unexpected extra model call');if(value instanceof Error)throw value;return value;};
 __setChatTransportForTests(wireModel?null:async request=>next(request));
 const client:MessagesClient={async create(request){const value=next(request);return {id:'message-'+calls.length,type:'message',role:'assistant',model:data.model,stop_reason:value.stopReason==='tool_calls'?'tool_use':'end_turn',stop_sequence:null,content:value.blocks.map(block=>block.type==='tool-call'?{type:'tool_use',id:block.toolCallId,name:block.toolName,input:block.input}:{type:'text',text:(block as any).text}),usage:{input_tokens:10,output_tokens:5}} as any;}};
 const progress:Record<string,unknown>[]=[];
 const ctx={id:job!.id,name:'subagent',data,attempts_made:attempt,signal:new AbortController().signal,shutdownSignal:new AbortController().signal,updateProgress:async(value:Record<string,unknown>)=>{progress.push(value);},updateTokens:async()=>{},log:async()=>{},isActive:async()=>true,readInbox:async()=>[]} as MinionJobContext;
 const handler=makeSubagentHandler({engine,config:{engine:url?'postgres':'pglite'},toolRegistry:tools,...(direct?{client}:{})});
 return {calls,progress,jobId:job!.id,result:handler(ctx),resume:async()=>{const [stored]=await engine.executeRaw<{data:typeof data|string}>('SELECT data FROM minion_jobs WHERE id=$1',[job!.id]);return handler({...ctx,data:typeof stored!.data==='string'?JSON.parse(stored!.data):stored!.data});}};
}

test('实际工具循环报告模型轮次、等待和重试，证书错误保留原文',async()=>{
 const success=await run([response('',true),response(receipt)],false,6,undefined,undefined,context,1);
 await success.result;
 expect(success.progress.some(value=>String(value.stage).includes('模型第 1 轮')&&String(value.stage).includes('第 2 次尝试'))).toBe(true);
 expect(success.progress.some(value=>String(value.stage).includes('等待'))).toBe(true);
 expect(success.progress.at(-1)?.turn).toBe(2);
 const failed=await run([new Error('unknown certificate verification error')]);
 const failure=await failed.result.then(()=>null,error=>error);
 expect(failure).toBeInstanceOf(Error);
 expect(failure.message).toContain('unknown certificate verification error');
 expect(String(failed.progress.at(-1)?.stage)).toContain('请求失败');
 expect(String(failed.progress.at(-1)?.stage)).toContain('certificate verification');
});

test('同轮批量写入后确定性完成，只调用模型一次，回执与工具提交可恢复', async () => {
  const first = response('', true);
  first.blocks.push({ type: 'tool-call', toolCallId: 'finish-batch', toolName: 'brain_complete_ingest', input: JSON.parse(receipt) });
  const execution = await run([first], false, 6, undefined, undefined, { ...context, compact_contract: true });
  const result = await execution.result;
  expect(execution.calls).toHaveLength(1);
  expect(result.ingest_verified).toBe(true);
  expect(result.ingest_entities).toEqual([expect.objectContaining({ slug, sourceId: 'default' })]);
  const stored = await engine.executeRaw<{ status: string }>("SELECT status FROM subagent_tool_executions WHERE job_id=$1 AND tool_name='brain_put_page'", [execution.jobId]);
  expect(stored[0]?.status).toBe('complete');
  const resumed = await execution.resume();
  expect(resumed.ingest_verified).toBe(true);
  expect(execution.calls).toHaveLength(1);
});

test('批量完成不能遗漏同轮已经提交的实体，失败回执不会当成功结束', async () => {
  const first = response('', true);
  first.blocks.push({ type: 'tool-call', toolCallId: 'wrong-finish', toolName: 'brain_complete_ingest', input: { entities: [], relations: [], no_entities: true } });
  const execution = await run([first, response(receipt)], false, 6, undefined, undefined, { ...context, compact_contract: true });
  expect((await execution.result).ingest_verified).toBe(true);
  expect(execution.calls).toHaveLength(2);
  const [failed] = await engine.executeRaw<{ error: string }>("SELECT error FROM subagent_tool_executions WHERE job_id=$1 AND tool_name='brain_complete_ingest' AND status='failed'", [execution.jobId]);
  expect(failed?.error).toContain('omits written entity');
});

test('批量提取使用同一个持久工具调用提交事实增量，成功后不再追加模型轮次', async () => {
  const first=response();
  first.text='';first.stopReason='tool_calls';
  first.blocks=[{type:'tool-call',toolCallId:'batch-capture',toolName:'brain_capture_entities',input:{entities:[{slug,content}],relations:[]}}];
  const execution=await run([first],false,6,undefined,undefined,{...context,compact_contract:true,batch_capture:true});
  const result=await execution.result;
  expect(result.ingest_verified).toBe(true);
  expect(execution.calls).toHaveLength(1);
  const [stored]=await engine.executeRaw<{status:string;output:{completed:Record<string,unknown>}}>("SELECT status,output FROM subagent_tool_executions WHERE job_id=$1 AND tool_name='brain_capture_entities'",[execution.jobId]);
  expect(stored?.status).toBe('complete');
  expect(Object.keys((typeof stored!.output==='string'?JSON.parse(stored!.output):stored!.output).completed)).toEqual(['0']);
  expect((await execution.resume()).ingest_verified).toBe(true);
  expect(execution.calls).toHaveLength(1);
});

test('批量第二项中断后从同一凭据继续，第一项事实不会重复写入', async () => {
  const body=context.body+'风险清单用于持续记录已识别的交付风险和处理安排。';
  await engine.putPage(context.slug,{type:'note',title:'原始记录',compiled_truth:body,frontmatter:{}});
  const [source]=await engine.executeRaw<{id:number;incarnation:string}>('SELECT p.id,s.incarnation::text incarnation FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.slug=$1 AND p.source_id=$2',[context.slug,'default']);
  const ingest={...context,body,chunkBody:body,pageId:source!.id,sourceIncarnation:source!.incarnation,compact_contract:true,batch_capture:true};
  let firstWrites=0,secondWrites=0;
  const base={...tools[0]!,async execute(raw:unknown,ctx:Parameters<ToolDef['execute']>[1]){
    if(String((raw as any).slug).endsWith(slug))firstWrites++;
    else if(++secondWrites===1)throw new Error('simulated interruption at second entity');
    return tools[0]!.execute(raw,ctx);
  }};
  const tool=entityIngestTools([base],ingest).find(tool=>tool.name==='brain_capture_entities')!;
  const [job]=await engine.executeRaw<{id:number}>("INSERT INTO minion_jobs(name,status,data) VALUES('subagent','active','{}'::jsonb) RETURNING id");
  const toolUseId=randomUUID();
  const input={entities:[{slug,content},{slug:'concepts/risk-list',content:'---\ntitle: 风险清单\ntype: concept\n---\n风险清单记录交付风险与处理安排。[Source: notes/meeting]'}],relations:[]};
  await engine.executeRaw(`INSERT INTO subagent_tool_executions(job_id,message_idx,tool_use_id,tool_name,input,status,schema_version,ordinal,gbrain_tool_use_id)
    VALUES($1,1,'batch','brain_capture_entities',$2::jsonb,'pending',2,0,$3::uuid)`,[job!.id,JSON.stringify(input),toolUseId]);
  const ctx={engine,jobId:job!.id,toolUseId,remote:true as const,signal:new AbortController().signal};
  await expectRejection(tool.execute(input,ctx), 'simulated interruption');
  const [partial]=await engine.executeRaw<{output:{completed:Record<string,unknown>}}>('SELECT output FROM subagent_tool_executions WHERE gbrain_tool_use_id=$1::uuid',[toolUseId]);
  expect(Object.keys((typeof partial!.output==='string'?JSON.parse(partial!.output):partial!.output).completed)).toEqual(['0']);
  const result=await tool.execute(input,ctx) as {status:string;receipt:string};
  expect(result.status).toBe('ready');
  expect(firstWrites).toBe(1);expect(secondWrites).toBe(2);
  expect(JSON.parse(result.receipt).entities).toContain(`default:${slug}`);
  expect(JSON.parse(result.receipt).entities).toContain('default:concepts/risk-list');
});

test('批量声明仍有实体时不能提前完成，下一批保留先前实体和证据关系',async()=>{
 const evidence='团队采用三纪早会体系和风险清单检查交付风险，同时使用验收清单核对结果。';
 const body=context.body+evidence;
 await engine.putPage(context.slug,{type:'note',title:'原始记录',compiled_truth:body,frontmatter:{}});
 const first=response();first.text='';first.stopReason='tool_calls';
 first.blocks=[{type:'tool-call',toolCallId:'partial-batch',toolName:'brain_capture_entities',input:{entities:[{slug,content},{slug:'concepts/risk-list',content:'---\ntitle: 风险清单\ntype: concept\n---\n团队采用风险清单检查交付风险。[Source: notes/meeting]'}],relations:[{from:slug,to:'concepts/risk-list',link_type:'mentions',evidence}],has_more:true}}];
 const second=response();second.text='';second.stopReason='tool_calls';
 second.blocks=[{type:'tool-call',toolCallId:'final-batch',toolName:'brain_capture_entities',input:{entities:[{slug:'concepts/acceptance-list',content:'---\ntitle: 验收清单\ntype: concept\n---\n团队使用验收清单核对结果。[Source: notes/meeting]'}],relations:[]}}];
 const execution=await run([first,second],false,6,undefined,undefined,{...context,body,chunkBody:body,compact_contract:true,batch_capture:true});
 const result=await execution.result;expect(execution.calls).toHaveLength(2);expect(result.ingest_verified).toBe(true);
 expect(result.ingest_entities).toHaveLength(3);
 expect(await engine.executeRaw("SELECT l.id FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.slug=$1 AND t.slug='concepts/risk-list' AND l.link_type='mentions'",[slug])).toHaveLength(1);
});

for(const wire of [false,true])test(`${wire?'Qwen 实际 HTTP':'持久工具'}实体密集小资料按实体数量增加轮数，保存后不重复执行`,async()=>{
 const names=Array.from({length:8},(_,i)=>`评审方法${i}`);
 const body=names.map(name=>`团队采用${name}核对工作风险。`).join('\n');
 await engine.putPage(context.slug,{type:'note',title:'实体密集资料',compiled_truth:body,frontmatter:{}});
 const replies=names.map((name,i):ChatResult=>({...response('',true),blocks:[{type:'tool-call',toolCallId:`put-${i}`,toolName:'brain_put_page',input:{slug:`concepts/method-${i}`,content:`---\ntitle: ${name}\ntype: concept\n---\n团队采用${name}核对风险。[Source: notes/meeting]`}}]}));
 const final=JSON.stringify({entities:names.map((_,i)=>`concepts/method-${i}`),relations:[]});
 const duplicate={...replies[0]!,blocks:[{...(replies[0]!.blocks[0] as any),toolCallId:'repeat-entity'}]};
 const sequence=[...replies,duplicate,response(final)],requests:any[]=[];
 const server=wire?Bun.serve({port:0,async fetch(request){
  const params:any=await request.json();requests.push(params);const reply=sequence.shift()!;
  return Response.json({id:`dense-${requests.length}`,object:'chat.completion',created:1,model:params.model,choices:[{index:0,finish_reason:reply.stopReason==='tool_calls'?'tool_calls':'stop',message:{role:'assistant',content:reply.text,tool_calls:reply.blocks.filter(block=>block.type==='tool-call').map(block=>({id:(block as any).toolCallId,type:'function',function:{name:(block as any).toolName,arguments:JSON.stringify((block as any).input)}}))}}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}});
 }}):null;
 try{
  if(server)configureGateway({chat_model:'custom-openai:Qwen3.6-35B-A3B',generative_enabled:true,base_urls:{'custom-openai':server.url.origin+'/v1'},env:{CUSTOM_OPENAI_API_KEY:'isolated-test-only'}});
  const attempt=await run(wire?[]:sequence,false,20,undefined,wire?'custom-openai:Qwen3.6-35B-A3B':undefined,{...context,body,chunkBody:body,turn_entity_refs:[]});
  const result=await attempt.result,calls=wire?requests:attempt.calls;
  expect(result.ingest_verified).toBe(true);expect(calls).toHaveLength(10);expect(calls[7].tools.length).toBeGreaterThan(0);
  expect((await attempt.resume()).ingest_verified).toBe(true);expect(calls).toHaveLength(10);
 }finally{server?.stop(true);}
},60000);

test('实体密集分块最多二十轮，最后一轮工具不会执行，失效回执也不能冒报完成',async()=>{
 const names=Array.from({length:8},(_,i)=>`风险方法${i}`),body=names.map(name=>`团队采用${name}核对风险。`).join('\n');
 await engine.putPage(context.slug,{type:'note',title:'密集实体',compiled_truth:body,frontmatter:{}});
 const replies=Array.from({length:20},(_,i):ChatResult=>({...response('',true),blocks:[{type:'tool-call',toolCallId:`bounded-${i}`,toolName:'brain_put_page',input:{slug:`concepts/risk-${i%8}`,content:`---\ntitle: ${names[i%8]}\ntype: concept\n---\n团队采用${names[i%8]}核对风险。[Source: notes/meeting]`}}]}));
 const attempt=await run(replies,false,20,undefined,undefined,{...context,body,chunkBody:body,turn_entity_refs:[]});
 expect(String(await attempt.result.catch(error=>error))).toContain('ingest_turn_limit:');expect(attempt.calls).toHaveLength(20);
 expect(attempt.calls.at(-1).tools).toBeUndefined();
 expect(await engine.executeRaw('SELECT id FROM subagent_tool_executions WHERE job_id=$1',[attempt.jobId])).toHaveLength(19);
},60000);

test('八轮仍无有效回执按轮数耗尽分类，保存消耗和纠错记录',async()=>{
 const attempt=await run(Array.from({length:20},()=>response('正在处理')),false,20,undefined,undefined,{...context,turn_entity_refs:[]});
 expect(String(await attempt.result.catch(error=>error))).toContain('ingest_turn_limit: 8 turns exhausted');expect(attempt.calls).toHaveLength(8);
 expect(await engine.executeRaw("SELECT id FROM subagent_messages WHERE job_id=$1 AND role='assistant'",[attempt.jobId])).toHaveLength(8);
},60000);

for(const direct of [false,true])test(`${direct?'兼容直连':'Qwen Gateway'}重复同一实体八轮收口，耗尽只报分块轮数限制`,async()=>{
 const replies=Array.from({length:20},(_,i):ChatResult=>({...response('',true),blocks:[{...(response('',true).blocks[0] as any),toolCallId:`repeat-${i}`}]}));
 const attempt=await run(replies,direct,20,undefined,undefined,{...context,turn_entity_refs:[]});
 expect(String(await attempt.result.catch(error=>error))).toContain('ingest_turn_limit:');
 expect(attempt.calls).toHaveLength(8);expect(attempt.calls.at(-1).tools).toBeUndefined();
 expect(await engine.executeRaw('SELECT id FROM pages WHERE slug=$1',[slug])).toHaveLength(1);
},60000);

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
