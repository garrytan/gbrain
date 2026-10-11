import {afterEach,expect,test} from 'bun:test';
import {chat,configureGateway,resetGateway,toolLoop} from '../../src/core/ai/gateway';
import {streamOllamaNativeChat} from '../../src/core/ai/ollama-native';
import {RequestContext} from '../../src/product/workbench/context-runtime';
import {summarizeConversation} from '../../src/product/workbench/routes';
afterEach(()=>resetGateway());

test('opt-in Ollama context passes num_ctx and native tools, then round-trips all results',async()=>{
  const requests:any[]=[];
  const server=Bun.serve({port:0,async fetch(request){
    expect(new URL(request.url).pathname).toBe('/api/chat');
    const body=await request.json() as any;requests.push(body);
    const message=requests.length===1?{content:'查询中',tool_calls:[{function:{name:'lookup',arguments:{key:'a'}}},{function:{name:'lookup',arguments:{key:'b'}}}]}:{content:'核对完成'};
    return new Response(JSON.stringify({message,done:true,done_reason:'stop',prompt_eval_count:50,eval_count:20})+'\n',{headers:{'content-type':'application/x-ndjson'}});
  }});
  try{
    configureGateway({generative_enabled:true,chat_model:'ollama:qwen3:4b',env:{},base_urls:{ollama:`${server.url}v1`}});
    const result=await toolLoop({initialMessages:[{role:'user',content:'核对两项'}],tools:[{name:'lookup',description:'查询',inputSchema:{type:'object',properties:{key:{type:'string'}},required:['key']}}],toolHandlers:new Map([['lookup',{idempotent:true,execute:async raw=>({found:(raw as any).key})}]]),toolConcurrency:2,maxTokens:512,beforeModelCall:({messages})=>({messages:[...messages],contextWindow:8192})});
    expect(result.finalText).toBe('核对完成');expect(requests).toHaveLength(2);
    expect(requests.every(body=>body.think===false&&body.options.num_ctx===8192)).toBe(true);
    expect(requests[1].messages.filter((message:any)=>message.role==='tool').map((message:any)=>[message.tool_name,JSON.parse(message.content).found])).toEqual([['lookup','a'],['lookup','b']]);
    expect(requests[1].messages.find((message:any)=>message.tool_calls)?.tool_calls).toHaveLength(2);
    expect(requests[0].format).toBeUndefined();
  }finally{server.stop(true);}
});

test('Qwen3.6 native reasoning control uses think:false without an unsupported soft switch',async()=>{
  let body:any;
  const server=Bun.serve({port:0,async fetch(request){body=await request.json();return new Response(JSON.stringify({message:{content:'回答'},done:true,done_reason:'stop'})+'\n');}});
  try{
    await streamOllamaNativeChat({baseURL:`${server.url}v1`,model:'qwen3.6:latest',maxTokens:100,messages:[{role:'user',content:'问题'}]});
    expect(body.think).toBe(false);expect(body.messages[0].content).toBe('问题');
  }finally{server.stop(true);}
});

test('native tools never promote reasoning-only output or inline think blocks into the answer',async()=>{
  let step=0;const deltas:string[]=[];
  const server=Bun.serve({port:0,fetch(){return new Response(JSON.stringify({message:step++===0?{content:'',thinking:'尚在思考'}:{content:'<think>隐藏分析</think>最终回答',thinking:'另一个隐藏分析'},done:true,done_reason:step===1?'length':'stop'})+'\n');}});
  try{
    const input={baseURL:String(server.url),model:'qwen3:4b',maxTokens:128,messages:[{role:'user' as const,content:'问题'}],tools:[{type:'function' as const,function:{name:'lookup',description:'查询',parameters:{type:'object'}}}],onText:(delta:string)=>deltas.push(delta)};
    const incomplete=await streamOllamaNativeChat(input);
    expect(incomplete.text).toBe('');expect(incomplete.finishReason).toBe('length');
    const complete=await streamOllamaNativeChat(input);
    expect(complete.text).toBe('最终回答');expect(deltas.join('')).toBe('最终回答');
  }finally{server.stop(true);}
});

test('short summaries reuse the same bounded Ollama context as ordinary requests',async()=>{
  const bodies:any[]=[];
  const server=Bun.serve({port:0,async fetch(request){bodies.push(await request.json());return new Response(JSON.stringify({message:{content:'{"result":"有效摘要"}'},done:true,done_reason:'stop'})+'\n');}});
  try{
    const model='ollama:qwen3.6:latest';const signal=new AbortController().signal;
    configureGateway({generative_enabled:true,chat_model:model,env:{},base_urls:{ollama:`${server.url}v1`},chat_output_limits:{[model]:1024}});
    const context=new RequestContext({model,contextWindow:8192,system:'',tools:[],signal});
    const prepared=await context.prepare([{role:'user',content:'短问题'}]);
    await chat({model,messages:prepared.messages,contextWindow:prepared.contextWindow,maxTokens:prepared.maxTokens});
    await summarizeConversation({model,contextWindow:8192,prior:'',transcript:'一轮短对话',signal});
    expect(bodies[0].options.num_ctx).toBe(bodies[1].options.num_ctx);
    expect(bodies[1].options.num_ctx).toBeLessThanOrEqual(8192);
  }finally{server.stop(true);}
});
