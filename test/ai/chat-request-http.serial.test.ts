import {afterEach,expect,test} from 'bun:test';
import {chat,configureGateway,resetGateway,toolLoop} from '../../src/core/ai/gateway';
import {ChatRequestTimeout,chatRequestFetch} from '../../src/core/ai/chat-request-runtime';

afterEach(()=>resetGateway());
const policy={maxRetries:1,retryDelayMs:1,firstResponseMs:500,idleMs:100,totalMs:2000};
const sse=(content:string,finish:string|null)=>`data: ${JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:'test',choices:[{index:0,delta:{content},finish_reason:finish}]})}\n\n`;
for(const model of ['mimo:mimo-v2.6-flash','deepseek:deepseek-flash','custom-openai:Qwen3.6-35B-A3B','ollama:qwen3.6:latest'])test(`${model}: HTTP stream missing terminal marker retries from completed read`,async()=>{
  const requests:any[]=[];let executions=0,visible='';
  const native=model.startsWith('ollama:');
  const server=Bun.serve({port:0,async fetch(req){
    const body=await req.json() as any;requests.push(body);
    if(requests.length===1){
      if(native)return new Response(JSON.stringify({message:{content:'',tool_calls:[{function:{name:'read',arguments:{}}}]},done:true,done_reason:'stop'})+'\n');
      return new Response(`data: ${JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:'test',choices:[{index:0,delta:{tool_calls:[{index:0,id:'read1',type:'function',function:{name:'read',arguments:'{}'}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
    }
    expect(body.messages.some((message:any)=>message.role==='tool'&&message.content.includes('预算十万元'))).toBe(true);
    if(native)return new Response(JSON.stringify({message:{content:requests.length===2?'半段':'预算十万元'},done:requests.length!==2,...(requests.length===2?{}:{done_reason:'stop',prompt_eval_count:40,eval_count:5})})+'\n');
    return new Response(sse(requests.length===2?'半段':'预算十万元',requests.length===2?null:'stop')+(requests.length===2?'':'data: [DONE]\n\n'),{headers:{'content-type':'text/event-stream'}});
  }});
  try{
    const provider=model.split(':')[0]!;
    configureGateway({generative_enabled:true,chat_model:model,env:{MIMO_API_KEY:'fixture',DEEPSEEK_API_KEY:'fixture',CUSTOM_OPENAI_API_KEY:'fixture'},base_urls:{[provider]:`${server.url}v1`}});
    const result=await toolLoop({model,initialMessages:[{role:'user',content:'读取预算'}],tools:[{name:'read',description:'读取',inputSchema:{type:'object'}}],toolHandlers:new Map([['read',{idempotent:true,execute:async()=>{executions++;return '预算十万元';}}]]),requestPolicy:policy,maxTurns:2,onTextDelta:delta=>{visible+=delta;},onTextReset:()=>{visible='';},beforeModelCall:({messages})=>({messages:[...messages],contextWindow:8192})});
    expect(requests).toHaveLength(3);expect(executions).toBe(1);expect(result.finalText).toBe('预算十万元');expect(visible).toBe('预算十万元');
  }finally{server.stop(true);}
});
test('stream idle recovery is bounded and user stop closes the actual HTTP body',async()=>{
  let cancelled=0,requests=0;
  const server=Bun.serve({port:0,fetch(){requests++;return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(sse('开始',null)));},cancel(){cancelled++;}}),{headers:{'content-type':'text/event-stream'}});}});
  try{
    configureGateway({generative_enabled:true,chat_model:'service-http:chat',env:{},base_urls:{'service-http':`${server.url}v1`}});
    await expect(chat({messages:[{role:'user',content:'问题'}],requestPolicy:policy,onTextDelta:()=>{},onTextReset:()=>{}})).rejects.toBeInstanceOf(ChatRequestTimeout);
    const abort=new AbortController();
    await expect(chat({messages:[{role:'user',content:'问题'}],abortSignal:abort.signal,requestPolicy:policy,onTextDelta:()=>abort.abort(new DOMException('用户停止','AbortError'))})).rejects.toThrow('用户停止');
    for(let i=0;i<20&&cancelled<3;i++)await Bun.sleep(5);
    expect(requests).toBe(3);expect(cancelled).toBe(3);
  }finally{server.stop(true);}
});
test('Bun fetch transport timeout is disabled only for an opted-in request',async()=>{
  let options:any;
  const fetcher=chatRequestFetch((async(_url:any,init:any)=>{options=init;return new Response('ok');}) as typeof fetch);
  await fetcher('http://fixture');expect(options).toBeUndefined();
  const {withChatRequest}=await import('../../src/core/ai/chat-request-runtime');
  await withChatRequest({messages:[],requestPolicy:{totalMs:100}},async()=>{await (await fetcher('http://fixture')).text();return {text:'ok',blocks:[],model:'fixture',providerId:'fixture',stopReason:'end',usage:{input_tokens:1,output_tokens:1,cache_read_tokens:0,cache_creation_tokens:0}};});
  expect(options.timeout).toBe(false);expect(options.signal).toBeInstanceOf(AbortSignal);
});
test('empty heartbeat frames cannot keep a model request alive forever',async()=>{
  let timer:ReturnType<typeof setInterval>|undefined;
  const server=Bun.serve({port:0,fetch(){return new Response(new ReadableStream({start(controller){timer=setInterval(()=>controller.enqueue(new TextEncoder().encode(': keepalive\n\n')),5);},cancel(){clearInterval(timer);}}),{headers:{'content-type':'text/event-stream'}});}});
  try{
    configureGateway({generative_enabled:true,chat_model:'service-http:chat',env:{},base_urls:{'service-http':`${server.url}v1`}});
    let error:unknown;
    try{await chat({messages:[{role:'user',content:'问题'}],requestPolicy:{firstResponseMs:40,idleMs:25,totalMs:1000,maxRetries:0},onTextDelta:()=>{}});}catch(value){error=value;}
    expect(error).toBeInstanceOf(ChatRequestTimeout);expect((error as ChatRequestTimeout).stage).toBe('first_response');
  }finally{clearInterval(timer);server.stop(true);}
});
