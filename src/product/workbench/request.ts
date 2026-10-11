import type {ChatRequestPolicy,ChatRequestEvent} from '../../core/ai/chat-request-runtime';
import {ChatRequestTimeout} from '../../core/ai/chat-request-runtime';

export function assistantRequestPolicy(model:string):ChatRequestPolicy{
  const local=/^(?:ollama|llama-server):/.test(model);
  const value=(key:string,fallback:number)=>{const configured=Number(process.env[key]);return Number.isFinite(configured)&&configured>=1000?configured:fallback;};
  return {firstResponseMs:value('PMBRAIN_ASSISTANT_FIRST_RESPONSE_TIMEOUT_MS',local?600000:180000),idleMs:value('PMBRAIN_ASSISTANT_IDLE_TIMEOUT_MS',local?180000:90000),totalMs:value('PMBRAIN_ASSISTANT_REQUEST_TIMEOUT_MS',local?1200000:600000),maxRetries:1,retryDelayMs:1000};
}
export function requestStage(event:ChatRequestEvent):string{
  if(event.phase==='retrying')return event.errorKind==='timeout'?'模型等待超时，正在重试本次请求':'模型连接中断，正在恢复本次请求';
  if(event.phase==='waiting')return event.attempt>1?'正在重新连接模型，已有检索结果保留':'正在等待模型响应';
  if(event.phase==='receiving')return '模型正在生成回答或请求资料';
  if(event.phase==='reasoning')return '模型正在思考';
  if(event.phase==='answering')return '正在生成回答';
  if(event.phase==='calling_tools')return '模型正在选择资料';
  return '';
}
export function assistantSession(model:string,parent:AbortSignal):{signal:AbortSignal;close:()=>void}{
  const configured=Number(process.env.PMBRAIN_ASSISTANT_TURN_TIMEOUT_MS);
  const milliseconds=Number.isFinite(configured)&&configured>=1000?configured:/^(?:ollama|llama-server):/.test(model)?1800000:900000;
  const controller=new AbortController();
  const timer=setTimeout(()=>{const error=new ChatRequestTimeout('total',milliseconds);error.message=`本轮回答超过总等待期限（${Math.round(milliseconds/1000)} 秒），检索结果和对话已保留。`;controller.abort(error);},milliseconds);
  return {signal:AbortSignal.any([parent,controller.signal]),close:()=>clearTimeout(timer)};
}
