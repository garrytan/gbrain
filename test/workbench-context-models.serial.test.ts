import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configureGateway,resetGateway,__setChatTransportForTests,chat,toolLoop,type ChatResult} from '../src/core/ai/gateway';
import {knowledgeWorkbenchAnswer} from '../src/product/workbench/routes';
import {WorkbenchStore} from '../src/product/workbench/store';
import {WorkbenchService} from '../src/product/workbench/service';
import {contextBudget,estimateTokens} from '../src/product/workbench/context';
import {chatMessageTokens} from '../src/product/workbench/context-runtime';

afterEach(()=>{__setChatTransportForTests(null);resetGateway();});
for(const model of ['mimo:mimo-v2.6-flash','deepseek:deepseek-flash','ollama:qwen3:4b','custom-openai:Qwen3.6-35B-A3B'])test(`${model}: eight persisted turns with concurrent searches and long results`,async()=>{
  configureGateway({generative_enabled:true,chat_model:model,env:{}});
  let requests=0,summaries=0,active=0,peak=0;
  const usage={input_tokens:100,output_tokens:20,cache_read_tokens:0,cache_creation_tokens:0};
  const result=(text:string,blocks:any[],stopReason:ChatResult['stopReason']):ChatResult=>({text,blocks,stopReason,model,providerId:model.split(':')[0]!,usage});
  __setChatTransportForTests(async opts=>{
    requests++;
    expect(estimateTokens(opts.system??'')+estimateTokens(JSON.stringify(opts.tools))+chatMessageTokens(opts.messages)).toBeLessThanOrEqual(contextBudget(8192,.8));
    const last=opts.messages.at(-1)?.content;
    if(Array.isArray(last)&&last.some(block=>block.type==='tool-result'))return result('已核对预算十万元 [1]。',[{type:'text',text:'已核对预算十万元 [1]。'}],'end');
    return result('',Array.from({length:4},(_,i)=>({type:'tool-call',toolCallId:`${requests}-${i}`,toolName:'knowledge_search',input:{query:`预算${i}`}})),'tool_calls');
  });
  const search=async(_engine:any,input:any)=>{
    active++;peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,input.query.endsWith('0')?15:2));active--;
    return {results:Array.from({length:6},(_,i)=>({source_id:'scope-a',slug:`project-${i}`,title:`项目${i}`,snippet:'预算十万元；材料依据。'.repeat(100)}))} as any;
  };
  const answer=knowledgeWorkbenchAnswer({getPage:async()=>({source_id:'scope-a',compiled_truth:'预算十万元，计划八月完成。'.repeat(1000),timeline:''})} as any,{search,answer:chat,loop:toolLoop,summarize:async()=>{summaries++;return '用户连续核对项目预算，十万元。';}});
  const root=mkdtempSync(join(tmpdir(),'pmbrain-context-model-'));
  const store=new WorkbenchStore(root);
  const models=()=>[{id:model,name:model,contextWindow:8192}];
  const summarize=async()=>{summaries++;return '用户连续核对项目预算，十万元。';};
  let service=new WorkbenchService(store,models,answer,summarize);
  const settings=service.assistant();settings.context.maxMessages=4;service.saveAssistant(settings);
  const thread=service.create({knowledge:true});
  for(let turn=0;turn<8;turn++){
    service.send(thread.id,{text:`第 ${turn+1} 轮：核对预算及材料`});await service.settled(thread.id);
    const reply=service.get(thread.id).messages.at(-1)!;
    expect(reply.status).toBe('complete');expect(reply.error).toBeUndefined();
    expect(reply.toolCalls).toHaveLength(4);
    expect(reply.toolCalls?.every(call=>call.status==='complete')).toBe(true);
    expect(reply.toolCalls?.some(call=>JSON.parse(call.output!).truncated)).toBe(true);
    expect(reply.citations?.every(c=>c.sourceId==='scope-a')).toBe(true);
    if(turn===3)service=new WorkbenchService(new WorkbenchStore(root),models,answer,summarize);
  }
  expect(peak).toBe(4);expect(summaries).toBeGreaterThan(0);expect(requests).toBe(16);
  expect(new WorkbenchStore(root).get(thread.id).messages).toHaveLength(16);
},60000);

test('provider context rejection remains a provider error after reopening',async()=>{
  const root=mkdtempSync(join(tmpdir(),'pmbrain-provider-context-'));
  const store=new WorkbenchStore(root);
  const models=()=>[{id:'mimo:mimo-v2.6-flash',name:'MiMo'}];
  const service=new WorkbenchService(store,models,async()=>{throw new Error('maximum context length exceeded: requested 12000, limit 8192');});
  const thread=service.create({knowledge:false});service.send(thread.id,{text:'问题'});await service.settled(thread.id);
  const reply=new WorkbenchStore(root).get(thread.id).messages.at(-1)!;
  expect(reply.errorCode).toBe('provider_context_limit');expect(reply.error).toContain('8192');
});

test('an empty final response is recorded as failure while the question remains saved',async()=>{
  const store=new WorkbenchStore(mkdtempSync(join(tmpdir(),'pmbrain-empty-answer-')));
  const service=new WorkbenchService(store,()=>[{id:'ollama:local',name:'本地'}],async()=>({text:'',model:'ollama:local',citations:[]}));
  const thread=service.create({knowledge:false});service.send(thread.id,{text:'保留问题'});await service.settled(thread.id);
  const saved=store.get(thread.id);expect(saved.messages[0]?.text).toBe('保留问题');expect(saved.messages.at(-1)?.status).toBe('error');expect(saved.messages.at(-1)?.error).toContain('未返回可用回答');
});

test('the shared loop stays serial by default and keeps writes serial even with opt-in',async()=>{
  configureGateway({generative_enabled:true,chat_model:'mimo:mimo-v2.6-flash',env:{}});
  for(const [idempotent,concurrency] of [[true,undefined],[false,4]] as const){
    let step=0,active=0,peak=0;
    __setChatTransportForTests(async()=>({text:'',blocks:step++===0?[0,1,2].map(i=>({type:'tool-call',toolCallId:String(i),toolName:'operation',input:{i}})):[{type:'text',text:'完成'}],stopReason:step===1?'tool_calls':'end',model:'mimo:mimo-v2.6-flash',providerId:'mimo',usage:{input_tokens:1,output_tokens:1,cache_read_tokens:0,cache_creation_tokens:0}}));
    await toolLoop({initialMessages:[],tools:[],toolConcurrency:concurrency,toolHandlers:new Map([['operation',{idempotent,execute:async()=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,2));active--;return '结果';}}]])});
    expect(peak).toBe(1);
  }
});
