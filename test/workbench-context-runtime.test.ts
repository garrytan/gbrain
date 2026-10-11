import {expect,test} from 'bun:test';
import {RequestContext,ToolResultBudget,trimToolOutput,contextFailure} from '../src/product/workbench/context-runtime';
import {estimateTokens} from '../src/product/workbench/context';
import {planContext} from '../src/product/workbench/context';

test('small model windows reserve actual output once and leave useful input space',()=>{
  const context=new RequestContext({contextWindow:8192,model:'ollama:qwen3.6:latest',system:'',tools:[],signal:new AbortController().signal});
  expect(context.outputTokens).toBeLessThanOrEqual(2048);expect(context.budget).toBeGreaterThan(4000);expect(context.budget+context.outputTokens).toBeLessThan(8192);
});
test('an unavailable local model is a connection failure, while certificate rejection is preserved',()=>{
  expect(contextFailure(new Error('Unable to connect. Is the computer able to access the url?')).code).toBe('model_connection_lost');
  expect(contextFailure(new Error('unknown certificate verification error')).message).toContain('certificate verification');
});
test('fresh evidence keeps useful space ahead of consumed results and duplicate prefetch',async()=>{
  const body='预算十万元，负责人王测试。'.repeat(200);
  const messages:any[]=[{role:'user',content:'比较预算与负责人'}];
  for(let index=0;index<4;index++)messages.push({role:'assistant',content:[{type:'text',text:'已查到一项，继续核对'},{type:'tool-call',toolCallId:String(index),toolName:'knowledge_read',input:{source_id:'a',slug:'page'}}]},{role:'user',content:[{type:'tool-result',toolCallId:String(index),toolName:'knowledge_read',output:{source_id:'a',slug:'page',content:body,offset:index*1000,nextOffset:9999}}]});
  const runtime=new RequestContext({contextWindow:8192,system:'请比较并引用',systemContext:{prefix:'<knowledge>',content:body,suffix:'</knowledge>'},tools:[{name:'knowledge_read',description:'读取',inputSchema:{type:'object'}}],signal:new AbortController().signal,summarize:async()=> '已核对前三项预算资料。'});
  const sent=await runtime.prepare(messages);
  const fresh=sent.messages.at(-1)!.content as any[];
  expect(fresh[0].output.content.length).toBeGreaterThan(900);
  expect(runtime.tokens(sent.messages)).toBeLessThanOrEqual(runtime.budget);
  expect(JSON.stringify(messages)).toContain(body);
});

test('a batch reserves immutable shares before results complete in any order',()=>{
  const pool=new ToolResultBudget(960,['a','b','c','d']);
  const caps=['a','b','c','d'].map(id=>pool.limit(id));
  expect(caps.every(cap=>cap===240)).toBe(true);
  const output=trimToolOutput({results:[{citation:1,source_id:'source-a',slug:'精确路径',title:'标题',snippet:'长摘要'.repeat(10000)}]},caps[3]!);
  expect(estimateTokens(JSON.stringify(output))).toBeLessThanOrEqual(caps[3]!);
  expect((output as any).results[0].source_id).toBe('source-a');
  expect((output as any).results[0].slug).toBe('精确路径');
  expect(pool.limit('a')).toBe(caps[0]!);
});

test('read excerpts keep an exact continuation offset without changing the original',()=>{
  const full={citation:1,source_id:'a',slug:'page',title:'资料',content:'正文'.repeat(10000),offset:75,nextOffset:null,truncated:false};
  const output=trimToolOutput(full,300) as Omit<typeof full,'nextOffset'> & {nextOffset:number|null};
  expect(estimateTokens(JSON.stringify(output))).toBeLessThanOrEqual(300);
  expect(output.content.length).toBeGreaterThan(0);
  expect(output.nextOffset).toBe(75+output.content.length);
  expect(full.content.length).toBe(20000);
});

test('each request compresses older complete exchanges and keeps latest tool pairs',async()=>{
  let summaries=0;
  const transcripts:string[]=[];
  const runtime=new RequestContext({contextWindow:4096,system:'站立指令',tools:[],signal:new AbortController().signal,summarize:async input=>{summaries++;transcripts.push(input.transcript);return '旧决定：预算十万元。';}});
  const messages:any[]=[{role:'user',content:'旧决定'.repeat(1100)},{role:'assistant',content:'旧回答'.repeat(1100)},{role:'user',content:'核对当前预算'},{role:'assistant',content:[{type:'tool-call',toolCallId:'c',toolName:'knowledge_read',input:{source_id:'a',slug:'page'}}]},{role:'user',content:[{type:'tool-result',toolCallId:'c',toolName:'knowledge_read',output:{source_id:'a',slug:'page',content:'正文'.repeat(5000),offset:0}}]}];
  const sent=await runtime.prepare(messages,2048);
  expect(summaries).toBeGreaterThan(0);
  expect(transcripts.join('')).toContain('旧决定');
  expect(runtime.tokens(sent.messages)).toBeLessThanOrEqual(runtime.budget);
  expect(JSON.stringify(sent.messages)).toContain('旧决定：预算十万元');
  expect(JSON.stringify(sent.messages)).toContain('"toolCallId":"c"');
  expect(sent.maxTokens+runtime.tokens(sent.messages)).toBeLessThanOrEqual(4096);
  expect(JSON.stringify(messages)).toContain('旧回答'.repeat(1100));
});

test('PMBrain policy limits and a provider rejection have different error codes',()=>{
  const local=contextFailure(new Error('PMBrain 上下文预算不足'));
  const provider=contextFailure(new Error('400 maximum context length exceeded: 8192 tokens'));
  expect(local.code).toBe('pmbrain_context_budget');
  expect(provider.code).toBe('provider_context_limit');
  expect(provider.message).toContain('8192');
  expect(local.message).not.toContain('请选择上下文更大的模型');
});

test('provider token rate limits are not mislabeled as model context capacity failures',()=>{
  expect(contextFailure(new Error('HTTP 429 Too many tokens per minute')).code).toBe('request_failed');
});

test('actual provider input usage calibrates subsequent request estimates',async()=>{
  const runtime=new RequestContext({contextWindow:8192,system:'系统',tools:[],signal:new AbortController().signal});
  const messages=[{role:'user' as const,content:'核对预算'}];
  await runtime.prepare(messages);
  const before=runtime.tokens(messages);
  runtime.observeUsage(before*2);
  expect(runtime.tokens(messages)).toBe(before*2);
});

test('a saved compaction boundary stays folded when the selected model window grows',()=>{
  const messages=[['a','user'],['b','assistant'],['c','user']].map(([id,role])=>({id:id!,role:role as 'user'|'assistant',text:'完整记录',status:'complete' as const,createdAt:''}));
  const planned=planContext(messages,{maxMessages:24,threshold:.8,summaryModel:''},{summary:'已总结前一轮',summaryUntil:'b',contextWindow:128000});
  expect(planned.recent.map(message=>message.id)).toEqual(['c']);
  expect(messages).toHaveLength(3);
});

test('a verbose current tool preface is pruned without removing calls or the latest question',async()=>{
  const runtime=new RequestContext({contextWindow:8192,system:'系统',tools:[],signal:new AbortController().signal});
  const messages:any[]=[{role:'user',content:'最新问题'},{role:'assistant',content:[{type:'text',text:'冗长的工具请求说明'.repeat(1000)},{type:'tool-call',toolCallId:'last',toolName:'knowledge_search',input:{query:'预算'}}]},{role:'user',content:[{type:'tool-result',toolCallId:'last',toolName:'knowledge_search',output:{results:[],truncated:false}}]}];
  const sent=await runtime.prepare(messages);
  expect(JSON.stringify(sent.messages)).toContain('最新问题');expect(JSON.stringify(sent.messages)).toContain('"toolCallId":"last"');
  expect(runtime.tokens(sent.messages)).toBeLessThanOrEqual(runtime.budget);
  expect(messages[1].content[0].text).toBe('冗长的工具请求说明'.repeat(1000));
});

test('prefetched evidence yields room to the current tool protocol without trimming standing instructions',async()=>{
  const content='预算十万元。'.repeat(400);
  const runtime=new RequestContext({contextWindow:4096,system:'保留这条系统指令',systemContext:{prefix:'\n<knowledge>\n',content,suffix:'\n</knowledge>'},tools:[{name:'knowledge_search',description:'搜索',inputSchema:{type:'object'}}],signal:new AbortController().signal});
  const calls=[0,1,2,3].map(i=>({type:'tool-call' as const,toolCallId:String(i),toolName:'knowledge_search',input:{query:'项目预算'}}));
  const results=calls.map(call=>({type:'tool-result' as const,toolCallId:call.toolCallId,toolName:call.toolName,output:{results:[{source_id:'a',slug:'project',title:'预算',snippet:content}]}}));
  const sent=await runtime.prepare([{role:'user',content:'最新问题'},{role:'assistant',content:calls},{role:'user',content:results}]);
  expect(sent.system).toContain('保留这条系统指令');expect(sent.system).toContain('<knowledge>');
  expect(sent.system!.length).toBeLessThan(content.length);expect(runtime.tokens(sent.messages)).toBeLessThanOrEqual(runtime.budget);
  expect(JSON.stringify(sent.messages)).toContain('"toolCallId":"3"');expect(content).toBe('预算十万元。'.repeat(400));
});
