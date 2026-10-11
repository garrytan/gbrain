import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkbenchService,type WorkbenchAnswer} from '../src/product/workbench/service';
import {WorkbenchStore} from '../src/product/workbench/store';
import {chat,configureGateway,resetGateway,__setChatTransportForTests} from '../src/core/ai/gateway';

afterEach(()=>{__setChatTransportForTests(null);resetGateway();});
const models=()=>[{id:'service-test:chat',name:'验收模型',contextWindow:8192}];
function fixture(firstResponseMs=30){
  configureGateway({generative_enabled:true,chat_model:'service-test:chat',env:{}});
  const root=mkdtempSync(join(tmpdir(),'pmbrain-request-'));
  const answer:WorkbenchAnswer=async input=>{
    const result=await chat({model:input.model,messages:[{role:'user',content:input.messages.at(-1)!.text}],abortSignal:input.signal,requestPolicy:{firstResponseMs,totalMs:5000,retryDelayMs:1,maxRetries:1},onRequestEvent:input.onRequestEvent,onTextDelta:input.onDelta,onTextReset:model=>input.onReplace?.('',model),maxTokens:100});
    return {text:result.text,model:result.model,citations:[]};
  };
  const service=new WorkbenchService(new WorkbenchStore(root),models,answer);
  return {root,answer,service,thread:service.create({knowledge:false})};
}
test('a failed request persists both attempts, unknown usage and full question after reload',async()=>{
  let attempts=0;__setChatTransportForTests(async opts=>{attempts++;opts.onTextDelta?.('失败片段');throw new TypeError('The socket connection was closed unexpectedly.');});
  const {root,answer,service,thread}=fixture();service.send(thread.id,{text:'原始问题'});await service.settled(thread.id);
  const reopened=new WorkbenchService(new WorkbenchStore(root),models,answer).get(thread.id);
  const reply=reopened.messages.at(-1)!;
  expect(attempts).toBe(2);expect(reply.status).toBe('error');expect(reply.errorCode).toBe('model_connection_lost');expect(reply.requestHistory).toHaveLength(2);expect(reply.requestHistory?.every(event=>event.usageUnknown&&event.outputLimit===100)).toBe(true);expect(reopened.messages[0]?.text).toBe('原始问题');
});
test('model timeout and user stop have distinct persisted states and stop never retries',async()=>{
  let attempts=0;__setChatTransportForTests(async()=>{attempts++;await new Promise(()=>{});throw new Error('unreachable');});
  const {root,answer,service,thread}=fixture();service.send(thread.id,{text:'等待问题'});await service.settled(thread.id);
  expect(service.get(thread.id).messages.at(-1)?.errorCode).toBe('model_request_timeout');expect(attempts).toBe(2);
  let started!:()=>void;const startedRequest=new Promise<void>(resolve=>{started=resolve;});
  __setChatTransportForTests(async()=>{attempts++;started();await new Promise(()=>{});throw new Error('unreachable');});
  service.send(thread.id,{text:'用户停止问题'});await startedRequest;service.cancel(thread.id);await service.settled(thread.id);
  const reply=new WorkbenchService(new WorkbenchStore(root),models,answer).get(thread.id).messages.at(-1)!;
  expect(reply.status).toBe('cancelled');expect(reply.errorCode).toBeUndefined();expect(attempts).toBe(3);
});
test('an interrupted saved service is classified separately from timeout',()=>{
  const {root,answer,service,thread}=fixture();thread.messages.push({id:'interrupted',role:'assistant',text:'已生成正文',status:'running',createdAt:new Date().toISOString()});new WorkbenchStore(root).save(thread);
  const reply=new WorkbenchService(new WorkbenchStore(root),models,answer).get(thread.id).messages.at(-1)!;
  expect(reply.status).toBe('error');expect(reply.errorCode).toBe('service_interrupted');expect(reply.text).toBe('已生成正文');
});
