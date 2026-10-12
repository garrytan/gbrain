import {afterAll,expect,test} from 'bun:test';
import {configureGateway,resetGateway,__setChatTransportForTests,chat,type ChatResult} from '../src/core/ai/gateway';
import {extractFactsFromTurn} from '../src/core/facts/extract';
import {workbenchMemoryTools} from '../src/product/workbench/memory-tools';
import {gateWritebackTurn} from '../src/core/facts/writeback-gate';
configureGateway({env:{}});
afterAll(()=>{__setChatTransportForTests(null);resetGateway();});
test('事实与问句用逗号混在一起仍保留，纯一次性操作不沉淀',()=>{
  const options={minChars:2,excludeOperationalRequests:true};
  expect(gateWritebackTurn('我不喝咖啡，能推荐其他饮品吗？',options).ok).toBe(true);
  expect(gateWritebackTurn('请给Atlas写一份方案，并说明我的写法偏好。',options).ok).toBe(false);
  expect(gateWritebackTurn('请以后每次先写结论，再写依据。',options).ok).toBe(true);
});
test('普通陈述只开放读取记忆，明确记住或遗忘才开放写工具',()=>{
  expect(workbenchMemoryTools('以后方案先写结论').map(row=>row.name)).toEqual(['memory_recall']);
  expect(workbenchMemoryTools('以后方案先写结论',false)).toHaveLength(0);
  expect(workbenchMemoryTools('请记住报告用中文').some(row=>row.name==='memory_remember')).toBe(true);
  expect(workbenchMemoryTools('不要记住这段').some(row=>row.name==='memory_remember')).toBe(false);
  expect(workbenchMemoryTools('你记住了什么').some(row=>row.name==='memory_remember')).toBe(false);
  expect(workbenchMemoryTools('如何修改知识库').some(row=>row.name==='knowledge_append')).toBe(false);
  expect(workbenchMemoryTools('请不要忘记报告偏好').some(row=>row.name==='memory_forget')).toBe(false);
  expect(workbenchMemoryTools('请忘记报告语言偏好').some(row=>row.name==='memory_forget')).toBe(true);
});
test('真实提炼路径区分临时和已发生事件，遗漏分类报错而不永久保存',async()=>{
  const captured=new Date('2026-10-12T00:00:00Z');let content=JSON.stringify({facts:[{fact:'今天在北京',kind:'fact',transient:true},{fact:'去年已完成立项',kind:'event',transient:false}]});
  __setChatTransportForTests(async()=>({text:content,model:'fixture',providerId:'fixture',blocks:[{type:'text',text:content}],usage:{input_tokens:10,output_tokens:10,cache_read_tokens:0,cache_creation_tokens:0},stopReason:'end'}));
  const input={turnText:'我今天在北京，去年已完成立项',source:'test',transientTtl:'3d',validFrom:captured,throwOnError:true};
  const result=await extractFactsFromTurn(input);expect(result[0].valid_until?.toISOString()).toBe('2026-10-15T00:00:00.000Z');expect(result[1].valid_until).toBeUndefined();
  content=JSON.stringify({facts:[{fact:'今天在北京',kind:'fact'}]});let failure:unknown;try{await extractFactsFromTurn(input);}catch(error){failure=error;}expect(String(failure)).toContain('transient classification');
});

test('原生记忆失败不切换备用模型，旧调用的备用链继续生效',async()=>{
  configureGateway({env:{},chat_model:'custom-openai:primary',chat_fallback_chain:['custom-openai:backup']});const calls:string[]=[];
  __setChatTransportForTests(async opts=>{calls.push(opts.model!);if(opts.model==='custom-openai:primary')throw new Error('fetch failed: ECONNRESET');return {text:'backup',model:opts.model!,providerId:'custom-openai',blocks:[{type:'text',text:'backup'}],usage:{input_tokens:1,output_tokens:1,cache_read_tokens:0,cache_creation_tokens:0},stopReason:'end'} as ChatResult;});
  let failure:unknown;try{await chat({model:'custom-openai:primary',messages:[{role:'user',content:'test'}],allowFallback:false});}catch(error){failure=error;}expect(String(failure)).toContain('ECONNRESET');expect(calls).not.toContain('custom-openai:backup');
  const legacy=await chat({model:'custom-openai:primary',messages:[{role:'user',content:'test'}]});expect(legacy.model).toBe('custom-openai:backup');
});
