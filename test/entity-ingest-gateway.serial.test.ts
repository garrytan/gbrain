import {afterEach,afterAll,expect,test} from 'bun:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configureGateway,resetGateway,toolLoop,chat,chatOutputLimit} from '../src/core/ai/gateway.ts';
let server:ReturnType<typeof Bun.serve>|undefined;
const previous=process.env.PMBRAIN_HOME;process.env.PMBRAIN_HOME=mkdtempSync(join(tmpdir(),'pmbrain-ingest-gateway-'));
afterAll(()=>{if(previous===undefined)delete process.env.PMBRAIN_HOME;else process.env.PMBRAIN_HOME=previous;});
afterEach(()=>{server?.stop(true);resetGateway();});
test('实体整理关闭 MiMo 思考并预留最后一轮验收，普通对话保持模型原设置',async()=>{
  const requests:any[]=[];
  server=Bun.serve({port:0,async fetch(req){
    requests.push(await req.json());
    const first=requests.length===1;
    return Response.json({id:'ingest-gateway-test',object:'chat.completion',created:1,model:'mimo-v2.6-flash',choices:[{index:0,finish_reason:first?'tool_calls':'stop',message:first?{role:'assistant',content:null,tool_calls:[{id:'search-1',type:'function',function:{name:'search',arguments:'{"query":"单位"}'}}]}:{role:'assistant',content:'{"entities":[],"relations":[],"no_entities":true}'}}],usage:{prompt_tokens:20,completion_tokens:5,total_tokens:25}});
  }});
  configureGateway({generative_enabled:true,chat_model:'mimo:mimo-v2.6-flash',base_urls:{mimo:server.url.origin+'/v1'},env:{MIMO_API_KEY:'isolated-test-only'}});
  const result=await toolLoop({model:'mimo:mimo-v2.6-flash',system:'Return the entity receipt.',initialMessages:[{role:'user',content:'原始资料'}],tools:[{name:'search',description:'entity identity',inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query']}}],toolHandlers:new Map([['search',{execute:async()=>[],idempotent:true}]]),maxTurns:2,disableReasoning:true,finalizeOnLastTurn:true,prepareFinalMessages:async()=>[{role:'user',content:'原始资料和持久化写入清单'}]});
  expect(result.stopReason).toBe('end');expect(result.totalTurns).toBe(2);
  expect(requests[0].thinking).toEqual({type:'disabled'});expect(requests[0].tools).toHaveLength(1);
  expect(requests[1].thinking).toEqual({type:'disabled'});expect(requests[1].tools).toBeUndefined();
  expect(requests[1].messages.filter((message:any)=>message.role!=='system')).toEqual([{role:'user',content:'原始资料和持久化写入清单'}]);
  await chat({model:'mimo:mimo-v2.6-flash',messages:[{role:'user',content:'普通对话'}]});
  expect(requests[2].thinking).toBeUndefined();
});

test('接近预算时提前收口验收，保留轮数上限且不再暴露工具',async()=>{
  const requests:any[]=[];
  server=Bun.serve({port:0,async fetch(req){requests.push(await req.json());return Response.json({id:'budget-final',object:'chat.completion',created:1,model:'mimo-v2.6-flash',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'{"entities":[],"relations":[],"no_entities":true}'}}],usage:{prompt_tokens:20,completion_tokens:5,total_tokens:25}});}});
  configureGateway({generative_enabled:true,chat_model:'mimo:mimo-v2.6-flash',base_urls:{mimo:server.url.origin+'/v1'},env:{MIMO_API_KEY:'isolated-test-only'}});
  const result=await toolLoop({system:'ingest',initialMessages:[{role:'user',content:'原文'}],tools:[{name:'write',description:'write',inputSchema:{type:'object'}}],toolHandlers:new Map([['write',{execute:async()=>{throw new Error('验收不允许再写');},idempotent:false}]]),maxTurns:6,finalizeOnLastTurn:true,shouldFinalize:async()=>true,prepareFinalMessages:async()=>[{role:'user',content:'持久化结果验收'}]});
  expect(result.totalTurns).toBe(1);expect(result.stopReason).toBe('end');expect(requests[0].tools).toBeUndefined();
  expect(requests[0].messages.at(-1).content).toBe('持久化结果验收');
});

test('模型能力未知时仍作一次有界截断恢复，MiMo 使用官方输出能力上限', async () => {
  const requests:any[]=[];
  server=Bun.serve({port:0,async fetch(req){
    requests.push(await req.json());
    return Response.json({id:'length-retry',object:'chat.completion',created:1,model:'unknown-limit',choices:[{index:0,finish_reason:requests.length===1?'length':'stop',message:{role:'assistant',content:requests.length===1?'incomplete':'complete'}}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}});
  }});
  configureGateway({generative_enabled:true,chat_model:'custom-openai:unknown-limit',base_urls:{'custom-openai':server.url.origin+'/v1'},env:{CUSTOM_OPENAI_API_KEY:'isolated-test-only'}});
  const result=await toolLoop({system:'test',initialMessages:[{role:'user',content:'合成文本'}],tools:[],toolHandlers:new Map(),retryLength:true,maxTurns:2,maxTokens:4096});
  expect(result.stopReason).toBe('end');
  expect(requests.map(request=>request.max_tokens??request.max_completion_tokens)).toEqual([4096,8192]);
  expect(chatOutputLimit('mimo:mimo-v2.6-flash')).toBe(131072);
  expect(chatOutputLimit('mimo:mimo-v2.5')).toBe(32768);
  expect(chatOutputLimit('custom-openai:unknown-limit')).toBeUndefined();
});
