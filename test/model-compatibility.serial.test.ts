import {afterEach,expect,test} from 'bun:test';
import {chat,configureGateway,resetGateway,toolLoop,withBudgetTracker} from '../src/core/ai/gateway.ts';
import {extractFactsFromTurn} from '../src/core/facts/extract.ts';
import {BudgetTracker} from '../src/core/budget/budget-tracker.ts';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

let server:ReturnType<typeof Bun.serve>|undefined;
afterEach(()=>{server?.stop(true);resetGateway();});
function setup(handler:(body:any)=>Response|Promise<Response>){
  const requests:any[]=[];
  server=Bun.serve({port:0,async fetch(request){const body=await request.json();requests.push(body);return handler(body);}});
  configureGateway({generative_enabled:true,chat_model:'custom-openai:Qwen3.6-35B-A3B',chat_output_limits:{'custom-openai:Qwen3.6-35B-A3B':64000},base_urls:{'custom-openai':server.url.origin+'/v1'},env:{}});
  return requests;
}
function answer(text:string,reason='stop',tokens=5){return Response.json({id:'isolated-compat',object:'chat.completion',created:1,model:'Qwen3.6-35B-A3B',choices:[{index:0,finish_reason:reason,message:{role:'assistant',content:text}}],usage:{prompt_tokens:20,completion_tokens:tokens,total_tokens:20+tokens}});}

test('Qwen 思考默认32k，参数明确被拒后移除重试，并按端点记住',async()=>{
  const requests=setup(body=>body.chat_template_kwargs?Response.json({error:{message:'unknown parameter chat_template_kwargs',type:'invalid_request_error'}},{status:400}):answer('{"ok":true}'));
  await chat({messages:[{role:'user',content:'JSON'}],disableReasoning:true});
  expect(requests).toHaveLength(2);expect(requests[0].max_tokens).toBe(32000);
  expect(requests[0].chat_template_kwargs).toEqual({enable_thinking:false});expect(requests[1].chat_template_kwargs).toBeUndefined();
  await chat({messages:[{role:'user',content:'JSON'}],disableReasoning:true});
  expect(requests).toHaveLength(3);expect(requests[2].chat_template_kwargs).toBeUndefined();
});

test('旧 Qwen3 参数拒绝才使用软开关，Qwen3.6 不使用软开关',async()=>{
  const requests=setup(body=>body.chat_template_kwargs?Response.json({error:{message:'unknown parameter chat_template_kwargs'}},{status:400}):answer('{"ok":true}'));
  await chat({model:'custom-openai:Qwen3-8B',messages:[{role:'user',content:'JSON'}],disableReasoning:true});
  expect(requests[0].messages.at(-1).content).toBe('JSON');expect(requests[1].messages.at(-1).content).toContain('/no_think');
  await chat({messages:[{role:'user',content:'JSON'}],disableReasoning:true});
  expect(JSON.stringify(requests.at(-1).messages)).not.toContain('/no_think');
});

test('超时只由调用方设置，旧全局配置不会影响普通聊天，取消保持独立',async()=>{
  setup(async()=>{await Bun.sleep(100);return answer('{"ok":true}');});
  configureGateway({generative_enabled:true,chat_model:'custom-openai:Qwen3.6-35B-A3B',base_urls:{'custom-openai':server!.url.origin+'/v1'},env:{GBRAIN_AI_CHAT_TIMEOUT_MS:'15'}});
  const {classifyChatError}=await import('../src/core/ai/errors.ts');
  expect((await chat({messages:[{role:'user',content:'JSON'}]})).text).toBe('{"ok":true}');
  const timeout=await chat({messages:[{role:'user',content:'JSON'}],timeoutMs:15}).catch(error=>error);
  expect(classifyChatError(timeout)).toBe('timeout');
  const controller=new AbortController();controller.abort();
  await expect(chat({messages:[{role:'user',content:'JSON'}],abortSignal:controller.signal,timeoutMs:1000})).rejects.toThrow();
});

test('截断恢复留住正常工具轮次，并受模型输出上限约束',async()=>{
  let calls=0;const requests=setup(()=>answer(++calls===1?'partial':'{"ok":true}',calls===1?'length':'stop',2));
  const result=await toolLoop({initialMessages:[{role:'user',content:'JSON'}],tools:[],toolHandlers:new Map(),maxTurns:1,maxTokens:10,modelOutputLimit:15,retryLength:true});
  expect(requests.map(body=>body.max_tokens)).toEqual([10,15]);expect(result.totalTurns).toBe(1);expect(result.stopReason).toBe('end');
});

test('未知模型输出能力时不盲目放大，恢复可按剩余预算缩小',async()=>{
  const requests=setup(()=>answer('partial','length',10));
  configureGateway({generative_enabled:true,chat_model:'custom-openai:Qwen3.6-35B-A3B',base_urls:{'custom-openai':server!.url.origin+'/v1'},env:{}});
  const unknown=await toolLoop({initialMessages:[{role:'user',content:'JSON'}],tools:[],toolHandlers:new Map(),maxTokens:10,retryLength:true});
  expect(unknown.stopReason).toBe('length');expect(requests).toHaveLength(1);
  const bounded=await toolLoop({initialMessages:[{role:'user',content:'JSON'}],tools:[],toolHandlers:new Map(),maxTokens:10,modelOutputLimit:30,retryLength:true,lengthRetryLimit:()=>14});
  expect(bounded.stopReason).toBe('length');expect(requests.map(body=>body.max_tokens)).toEqual([10,10,14]);
});

test('截断恢复依据已发生费用缩小输出，不能超过剩余金额',async()=>{
  let calls=0;const requests=setup(()=>answer(++calls===1?'partial':'{"ok":true}',calls===1?'length':'stop',10));
  const tracker=new BudgetTracker({label:'length-recovery-test',maxCostUsd:0.000025,auditPath:join(mkdtempSync(join(tmpdir(),'pmbrain-budget-test-')),'audit.jsonl'),pricingOverrides:{'custom-openai:qwen3.6-35b-a3b':{input:0,output:1}}});
  const result=await withBudgetTracker(tracker,()=>toolLoop({initialMessages:[{role:'user',content:'JSON'}],tools:[],toolHandlers:new Map(),maxTokens:10,maxTurns:1,retryLength:true}));
  expect(requests.map(body=>body.max_tokens)).toEqual([10,15]);expect(result.stopReason).toBe('end');expect(tracker.snapshot().cumulativeCostUsd).toBeLessThanOrEqual(0.000025);
});

test('截断同一请求加倍一次，逐次记录消耗，截断工具参数不执行',async()=>{
  const requests=setup(body=>answer(body.max_tokens===32000?'unfinished':'{"entities":[],"relations":[],"no_entities":true}',body.max_tokens===32000?'length':'stop',body.max_tokens===32000?32000:7));
  const persisted:number[]=[];const reservations:number[]=[];
  const result=await toolLoop({initialMessages:[{role:'user',content:'原文'}],tools:[],toolHandlers:new Map(),maxTurns:6,retryLength:true,reportLengthStop:true,beforeModelCall:async input=>{reservations.push(input.maxTokens);},onAssistantTurn:async(_turn,_message,_blocks,usage)=>{persisted.push(usage.output_tokens);}});
  expect(requests.map(body=>body.max_tokens)).toEqual([32000,64000]);
  expect(requests[0].messages).toEqual(requests[1].messages);expect(reservations).toEqual([32000,64000]);
  expect(persisted).toEqual([32000,7]);expect(result.totalUsage.output_tokens).toBe(32007);expect(result.totalTurns).toBe(1);expect(result.stopReason).toBe('end');
});

test('再次截断保留 length；预算拒绝重试时不再调用模型',async()=>{
  const requests=setup(()=>answer('','length',32000));
  const result=await toolLoop({initialMessages:[{role:'user',content:'原文'}],tools:[],toolHandlers:new Map(),maxTurns:6,retryLength:true,reportLengthStop:true});
  expect(result.stopReason).toBe('length');expect(requests).toHaveLength(2);
  await expect(toolLoop({initialMessages:[{role:'user',content:'原文'}],tools:[],toolHandlers:new Map(),maxTurns:6,retryLength:true,beforeModelCall:async input=>{if(input.maxTokens>32000)throw new Error('ingest_budget_tokens');}})).rejects.toThrow('ingest_budget_tokens');
  expect(requests).toHaveLength(3);
});

test('结构化 Schema 拒绝后只移除 Schema，继续解析普通 JSON',async()=>{
  const requests=setup(body=>body.response_format?Response.json({error:{message:'response_format json_schema unsupported'}},{status:422}):answer('{"ok":true}'));
  const responseSchema={name:'probe',schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok']}};
  const result=await chat({messages:[{role:'user',content:'Return JSON'}],responseSchema});
  expect(result.text).toBe('{"ok":true}');expect(requests).toHaveLength(2);expect(requests[0].response_format.type).toBe('json_schema');expect(requests[1].response_format).toBeUndefined();
});

test('普通 JSON 抽取截断只重试一次，并合计两次用量',async()=>{
  const requests=setup(body=>answer('{"facts":[]}',body.max_tokens===32000?'length':'stop',body.max_tokens===32000?32000:7));
  const result=await chat({messages:[{role:'user',content:'Return JSON'}],retryLength:true});
  expect(requests.map(body=>body.max_tokens)).toEqual([32000,64000]);
  expect(result.usage.output_tokens).toBe(32007);expect(result.stopReason).toBe('end');
});

test('Ollama 截断不被结果信封解析覆盖，仍按32k/64k重试',async()=>{
  let calls=0;
  const requests=setup(()=>new Response(JSON.stringify({message:{role:'assistant',content:++calls===1?'{}':'{"result":[]}'},done:true,done_reason:calls===1?'length':'stop',prompt_eval_count:10,eval_count:5})+'\n'));
  configureGateway({generative_enabled:true,chat_model:'ollama:Qwen3.6-35B-A3B',chat_output_limits:{'ollama:Qwen3.6-35B-A3B':64000},base_urls:{ollama:server!.url.origin+'/v1'},env:{}});
  const result=await chat({messages:[{role:'user',content:'Return JSON'}],retryLength:true});
  expect(result.stopReason).toBe('end');expect(result.text).toBe('[]');expect(requests.map(body=>body.options.num_predict)).toEqual([32000,64000]);
});

test('关思考和 Schema 分别被拒时各移除一次，缓存不跨端点',async()=>{
  const requests=setup(body=>body.chat_template_kwargs?Response.json({error:{message:'unknown parameter enable_thinking'}},{status:400}):body.response_format?Response.json({error:{message:'json_schema unsupported'}},{status:400}):answer('{"ok":true}'));
  const opts={messages:[{role:'user' as const,content:'JSON'}],disableReasoning:true,responseSchema:{name:'probe',schema:{type:'object'}}};
  await chat(opts);expect(requests).toHaveLength(3);await chat(opts);expect(requests).toHaveLength(4);
  expect(requests[3].chat_template_kwargs).toBeUndefined();expect(requests[3].response_format).toBeUndefined();
  const previous=server!;
  const next=setup(()=>answer('{"ok":true}'));
  try{await chat(opts);expect(next[0].chat_template_kwargs).toEqual({enable_thinking:false});expect(next[0].response_format.type).toBe('json_schema');}finally{previous.stop(true);}
});

test('流式调用同样移除被拒的关思考参数',async()=>{
  const requests=setup(body=>{
    if(body.chat_template_kwargs)return Response.json({error:{message:'enable_thinking unsupported'}},{status:400});
    const chunks=[{choices:[{index:0,delta:{role:'assistant',content:'ok'},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}];
    return new Response(chunks.map(chunk=>'data: '+JSON.stringify({id:'stream-compat',object:'chat.completion.chunk',created:1,model:'Qwen3.6-35B-A3B',...chunk})+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
  });
  const deltas:string[]=[];
  const result=await chat({messages:[{role:'user',content:'JSON'}],disableReasoning:true,onTextDelta:delta=>{deltas.push(delta);}});
  expect(requests).toHaveLength(2);expect(result.text).toBe('ok');expect(deltas.join('')).toBe('ok');
});

test('事实抽取再次截断明确报错，不接受看似完整的空 JSON',async()=>{
  const requests=setup(()=>answer('{"facts":[]}','length',32000));
  configureGateway({generative_enabled:true,chat_model:'custom-openai:Qwen3.6-35B-A3B',chat_output_limits:{'custom-openai:Qwen3.6-35B-A3B':64000},base_urls:{'custom-openai':server!.url.origin+'/v1'},env:{CUSTOM_OPENAI_API_KEY:'isolated-test-only'}});
  await expect(extractFactsFromTurn({model:'custom-openai:Qwen3.6-35B-A3B',turnText:'我决定采用这个工作流程。',source:'test:compatibility',throwOnError:true})).rejects.toThrow('facts_output_truncated');
  expect(requests.map(body=>body.max_tokens)).toEqual([32000,64000]);
});

test('JSON 工具计划非法时先持久保存用量，再走原有回执纠正',async()=>{
  let calls=0;setup(()=>answer(++calls===1?'{"tool_calls":[{"name":"unknown","arguments":{}}]}':'{"entities":[],"relations":[],"no_entities":true}'));
  const persisted:number[]=[];
  const result=await toolLoop({initialMessages:[{role:'user',content:'原文'}],tools:[],toolHandlers:new Map(),jsonToolCalls:true,maxTurns:3,
    onAssistantTurn:async(_turn,_idx,_blocks,usage)=>{persisted.push(usage.output_tokens);},validateCompletion:async text=>text.includes('unknown')?'Return the required receipt.':null});
  expect(persisted).toEqual([5,5]);expect(result.totalTurns).toBe(2);
});

test('无工具协议以受限 JSON 调用复用原工具执行，最终回执仍验收',async()=>{
  let calls=0;const requests=setup(()=>answer(++calls===1?'{"tool_calls":[{"name":"write","arguments":{"value":"saved"}}]}':'{"entities":[],"relations":[],"no_entities":true}'));
  const writes:string[]=[];
  const result=await toolLoop({initialMessages:[{role:'user',content:'原文'}],tools:[{name:'write',description:'write',inputSchema:{type:'object'}}],toolHandlers:new Map([['write',{idempotent:true,execute:async input=>{writes.push((input as any).value);return {saved:true};}}]]),jsonToolCalls:true,maxTurns:3});
  expect(result.stopReason).toBe('end');expect(writes).toEqual(['saved']);expect(requests.every(body=>body.tools===undefined)).toBe(true);
});
