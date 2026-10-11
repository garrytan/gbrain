import {afterEach,expect,test} from 'bun:test';
import {chat,configureGateway,resetGateway,__setChatTransportForTests,type ChatResult} from '../../src/core/ai/gateway';
import {ChatRequestTimeout, type ChatRequestEvent} from '../../src/core/ai/chat-request-runtime';

const result:ChatResult={text:'完成',blocks:[{type:'text',text:'完成'}],model:'service-test:chat',providerId:'service-test',stopReason:'end',usage:{input_tokens:20,output_tokens:2,cache_read_tokens:0,cache_creation_tokens:0}};
afterEach(()=>{__setChatTransportForTests(null);resetGateway();});
test('a stop raised during request setup starts no transport',async()=>{
  configureGateway({generative_enabled:true,chat_model:'service-test:chat',env:{}});
  let attempts=0;const abort=new AbortController();__setChatTransportForTests(async()=>{attempts++;return result;});
  await expect(chat({messages:[],abortSignal:abort.signal,requestPolicy:{totalMs:100},onRequestEvent:event=>{if(event.phase==='waiting')abort.abort(new DOMException('用户停止','AbortError'));}})).rejects.toThrow('用户停止');expect(attempts).toBe(0);
});
test('assistant retry replaces a partial attempt and preserves one logical request',async()=>{
  configureGateway({generative_enabled:true,chat_model:'service-test:chat',env:{}});
  let attempts=0,visible='';const events:ChatRequestEvent[]=[];
  __setChatTransportForTests(async opts=>{attempts++;opts.onTextDelta?.(attempts===1?'半段':'完成');if(attempts===1)throw new TypeError('The socket connection was closed unexpectedly.');return result;});
  const answer=await chat({messages:[{role:'user',content:'问题'}],requestPolicy:{maxRetries:1,retryDelayMs:1,firstResponseMs:100,totalMs:500},onRequestEvent:event=>events.push(event),onTextDelta:delta=>{visible+=delta;},onTextReset:()=>{visible='';}});
  expect(answer.text).toBe('完成');expect(visible).toBe('完成');expect(attempts).toBe(2);
  expect(events.filter(event=>event.phase==='retrying')).toHaveLength(1);
  expect(events.find(event=>event.phase==='failed')?.usageUnknown).toBe(true);
});
test('a missing first response is bounded and classified, while user cancellation never retries',async()=>{
  configureGateway({generative_enabled:true,chat_model:'service-test:chat',env:{}});
  let attempts=0;__setChatTransportForTests(async()=>{attempts++;await new Promise(()=>{});return result;});
  await expect(chat({messages:[],requestPolicy:{firstResponseMs:20,totalMs:100,maxRetries:1}})).rejects.toBeInstanceOf(ChatRequestTimeout);
  expect(attempts).toBe(1);
  const abort=new AbortController();const pending=chat({messages:[],abortSignal:abort.signal,requestPolicy:{firstResponseMs:100,totalMs:200,maxRetries:1}});setTimeout(()=>abort.abort(new DOMException('用户停止','AbortError')),5);
  await expect(pending).rejects.toThrow('用户停止');expect(attempts).toBe(2);
});
test('a streamed disconnect after search retries the model without replaying completed tools',async()=>{
  const {toolLoop}=await import('../../src/core/ai/gateway');
  configureGateway({generative_enabled:true,chat_model:'service-test:chat',env:{}});
  let requests=0,executions=0,turns=0;
  __setChatTransportForTests(async opts=>{requests++;if(requests===1)return {...result,text:'',stopReason:'tool_calls',blocks:[{type:'tool-call',toolCallId:'a',toolName:'read',input:{}}]};expect(JSON.stringify(opts.messages)).toContain('正文');if(requests===2)throw new Error('Connection reset by peer');return result;});
  const answer=await toolLoop({initialMessages:[{role:'user',content:'读取并回答'}],tools:[{name:'read',description:'读取',inputSchema:{type:'object'}}],toolHandlers:new Map([['read',{idempotent:true,execute:async()=>{executions++;return {content:'正文'};}}]]),maxTurns:2,requestPolicy:{maxRetries:1,retryDelayMs:1,totalMs:500},onAssistantTurn:async()=>{turns++;}});
  expect(answer.finalText).toBe('完成');expect(executions).toBe(1);expect(turns).toBe(2);expect(requests).toBe(3);
});
test('HTTP authentication and model context errors are not retried',async()=>{
  configureGateway({generative_enabled:true,chat_model:'service-test:chat',env:{}});
  let requests=0;__setChatTransportForTests(async()=>{requests++;throw Object.assign(new Error('HTTP 400 maximum context length exceeded'),{statusCode:400});});
  await expect(chat({messages:[],requestPolicy:{maxRetries:1,retryDelayMs:1,totalMs:100}})).rejects.toThrow('maximum context');expect(requests).toBe(1);
});
test('first-response timeout can recover once within the same total deadline',async()=>{
  configureGateway({generative_enabled:true,chat_model:'service-test:chat',env:{}});
  let attempts=0;__setChatTransportForTests(async()=>{attempts++;if(attempts===1)await new Promise(()=>{});return result;});
  const answer=await chat({messages:[{role:'user',content:'问题'}],requestPolicy:{firstResponseMs:20,totalMs:200,retryDelayMs:1,maxRetries:1}});
  expect(answer.text).toBe('完成');expect(attempts).toBe(2);
});
