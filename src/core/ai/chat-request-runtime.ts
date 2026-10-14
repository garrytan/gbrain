import {AsyncLocalStorage} from 'node:async_hooks';
import {classifyChatError} from './errors.ts';
import type {ChatOpts,ChatResult} from './gateway.ts';

export interface ChatRequestPolicy { firstResponseMs?:number; idleMs?:number; totalMs?:number; maxRetries?:number; retryDelayMs?:number }
export interface ChatRequestEvent {
  phase:'waiting'|'receiving'|'reasoning'|'answering'|'calling_tools'|'retrying'|'complete'|'failed';
  model:string;
  attempt:number;
  startedAt:string;
  elapsedMs:number;
  inputTokens?:number;
  outputTokens?:number;
  outputLimit?:number;
  errorKind?:string;
  usageUnknown?:boolean;
}
export class ChatRequestTimeout extends Error {
  readonly code='model_request_timeout';
  constructor(readonly stage:'first_response'|'idle'|'total',readonly milliseconds:number){
    super(stage==='first_response'?`模型等待首个响应超时（${Math.round(milliseconds/1000)} 秒）`:stage==='idle'?`模型响应中断，连续 ${Math.round(milliseconds/1000)} 秒没有收到数据`:`模型单次请求超过总等待期限（${Math.round(milliseconds/1000)} 秒）`);
    this.name='ChatRequestTimeout';
  }
}
export class IncompleteChatStream extends Error {
  readonly code='ECONNRESET';
  constructor(){super('模型连接已结束，但没有收到完整结束标记');this.name='IncompleteChatStream';}
}
type Activity='receiving'|'reasoning'|'answering'|'calling_tools';
type Scope={signal:AbortSignal;activity:(phase?:Activity)=>void};
const activeRequest=new AsyncLocalStorage<Scope>();
export function chatRequestFetch(base:typeof fetch=fetch):typeof fetch {
  return (async(input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
    const scope=activeRequest.getStore();
    if(!scope)return base(input,init);
    const response=await base(input,{...init,signal:init?.signal?AbortSignal.any([scope.signal,init.signal]):scope.signal,...(typeof Bun==='undefined'?{}:{timeout:false})} as Parameters<typeof fetch>[1]);
    if(!response.body)return response;
    const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
    const sse=/event-stream/i.test(response.headers.get('content-type')??'');
    const ndjson=/\/api\/chat(?:\?|$)/.test(url);
    const verify=/\/chat\/completions(?:\?|$)/.test(url)&&sse;
    const decoder=new TextDecoder();let pending='',finished=false;
    const inspect=(line:string)=>{
      if(sse&&!line.startsWith('data:'))return;
      const data=(sse?line.slice(5):line).trim();
      if(data==='[DONE]'){finished=true;scope.activity();return;}
      let value:any;
      try{value=JSON.parse(data);}catch{return;}
      {
        const delta=value.choices?.[0]?.delta??value.delta??value.message??{};
        if(value.choices?.some((choice:any)=>choice.finish_reason!=null)||value.done===true||value.type==='message_stop')finished=true;
        if(delta.content||delta.text||value.candidates?.some((candidate:any)=>candidate.content?.parts?.some((part:any)=>part.text)))scope.activity('answering');
        else if(delta.reasoning_content||delta.reasoning||delta.thinking)scope.activity('reasoning');
        else if(delta.tool_calls?.length||delta.partial_json||value.content_block?.type==='tool_use')scope.activity('calling_tools');
        else if(finished)scope.activity();
      }
    };
    const stream=response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({
      transform(chunk,controller){
        if(chunk.byteLength&&!scope.signal.aborted&&!sse&&!ndjson)scope.activity();
        if(sse||ndjson){pending+=decoder.decode(chunk,{stream:true});const lines=pending.split(/\r?\n/);pending=lines.pop()??'';for(const line of lines)inspect(line);}
        controller.enqueue(chunk);
      },
      flush(){if(sse||ndjson)inspect(pending+decoder.decode());if(verify&&!finished)throw new IncompleteChatStream();},
    }));
    return new Response(stream,{status:response.status,statusText:response.statusText,headers:response.headers});
  }) as typeof fetch;
}
function wait(milliseconds:number,signal:AbortSignal):Promise<void>{
  return new Promise((resolve,reject)=>{
    signal.throwIfAborted();
    const onAbort=()=>{clearTimeout(timer);signal.removeEventListener('abort',onAbort);reject(signal.reason);};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',onAbort);resolve();},milliseconds);
    signal.addEventListener('abort',onAbort,{once:true});
  });
}
export async function withChatRequest(opts:ChatOpts,invoke:(opts:ChatOpts)=>Promise<ChatResult>):Promise<ChatResult>{
  const policy=opts.requestPolicy;
  if(!policy)return invoke(opts);
  const started=Date.now();const startedAt=new Date(started).toISOString();
  const retries=Math.max(0,Math.min(2,policy.maxRetries??1));
  for(let attempt=1;;attempt++){
    opts.abortSignal?.throwIfAborted();
    const controller=new AbortController();
    const signal=opts.abortSignal?AbortSignal.any([controller.signal,opts.abortSignal]):controller.signal;
    const timers:Array<ReturnType<typeof setTimeout>>=[];
    let idle:ReturnType<typeof setTimeout>|undefined;let received=false,emitted=false,lastEvent=0;
    let currentPhase:Activity='receiving';
    const event=(phase:ChatRequestEvent['phase'],extra:Partial<ChatRequestEvent>={})=>opts.onRequestEvent?.({phase,model:opts.model??'',attempt,startedAt,elapsedMs:Date.now()-started,outputLimit:opts.maxTokens,...extra});
    const expire=(stage:ChatRequestTimeout['stage'],milliseconds:number)=>controller.abort(new ChatRequestTimeout(stage,milliseconds));
    if(policy.firstResponseMs&&policy.firstResponseMs>0)timers.push(setTimeout(()=>{if(!received)expire('first_response',policy.firstResponseMs!);},policy.firstResponseMs));
    if(policy.totalMs&&policy.totalMs>0){
      const remaining=policy.totalMs-(Date.now()-started);
      if(remaining<=0)throw new ChatRequestTimeout('total',policy.totalMs);
      timers.push(setTimeout(()=>expire('total',policy.totalMs!),remaining));
    }
    const activity=(phase?:Activity)=>{
      if(signal.aborted)return;
      const changed=phase!==undefined&&phase!==currentPhase;
      if(phase)currentPhase=phase;
      received=true;
      if(idle)clearTimeout(idle);
      if(policy.idleMs&&policy.idleMs>0)idle=setTimeout(()=>expire('idle',policy.idleMs!),policy.idleMs);
      if(changed||Date.now()-lastEvent>=1000){lastEvent=Date.now();event(currentPhase);}
    };
    let onAbort:()=>void=()=>{};
    try{
      event('waiting');
      signal.throwIfAborted();
      const aborted=new Promise<never>((_resolve,reject)=>{onAbort=()=>reject(signal.reason);signal.addEventListener('abort',onAbort,{once:true});});
      const call={...opts,abortSignal:signal,maxRetries:0,...(opts.onTextDelta?{onTextDelta:(delta:string)=>{if(signal.aborted)return;activity('answering');if(delta)emitted=true;opts.onTextDelta?.(delta);}}:{}),...(opts.onTextReset?{onTextReset:(model:string)=>{if(!signal.aborted)opts.onTextReset?.(model);}}:{})};
      const result=await Promise.race([activeRequest.run({signal,activity},()=>invoke(call)),aborted]);
      signal.throwIfAborted();
      event('complete',{inputTokens:result.usage.input_tokens,outputTokens:result.usage.output_tokens,usageUnknown:false});
      return result;
    }catch(error){
      const failure=signal.aborted?signal.reason:error;
      const kind=classifyChatError(failure);
      event('failed',{errorKind:opts.abortSignal?.aborted&&!(failure instanceof ChatRequestTimeout)?'cancelled':kind,usageUnknown:true});
      controller.abort(failure);
      const retryable=['network','provider_5xx'].includes(kind)||(failure instanceof ChatRequestTimeout&&failure.stage!=='total');
      if(opts.abortSignal?.aborted||attempt>retries||!retryable||(emitted&&!opts.onTextReset))throw failure;
      opts.onTextReset?.(opts.model??'');event('retrying',{errorKind:kind,usageUnknown:true});
      const delay=Math.max(0,Math.min(10000,policy.retryDelayMs??1000))*attempt;
      if(policy.totalMs&&Date.now()-started+delay>=policy.totalMs)throw new ChatRequestTimeout('total',policy.totalMs);
      await wait(delay,opts.abortSignal??new AbortController().signal);
    }finally{
      for(const timer of timers)clearTimeout(timer);
      if(idle)clearTimeout(idle);
      signal.removeEventListener('abort',onAbort);
    }
  }
}
