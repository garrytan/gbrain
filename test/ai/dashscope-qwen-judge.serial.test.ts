/** Value: protects=real SDK Qwen route/cap and native callers; fails_when=chat or switch removed;
 * why_new=existing provider tests omit Qwen and batch wire; seam=none;
 * no_claim=live provider accepts contract or production was changed (synthetic fetch only). */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chat, embed, configureGateway, resetGateway, validateModelId } from '../../src/core/ai/gateway.ts';
import { thinkingOffControl } from '../../src/core/ai/thinking-off.ts';
import { canonicalLookup } from '../../src/core/model-pricing.ts';
import { withAIInvocationGuard } from '../../src/core/ai/invocation-guard.ts';
import { runEval } from '../../src/core/cross-modal-eval/runner.ts';
import { runEvalCrossModal } from '../../src/commands/eval-cross-modal.ts';
import { runCrossModalBatchForProbe } from '../../src/core/cycle/nightly-probe-adapters.ts';

const model = 'dashscope:qwen3.8-flash';
const url = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const originalFetch = globalThis.fetch;
let bodies: any[] = [];
let dirs: string[] = [];
const score = JSON.stringify({ scores: { CORRECTNESS: { score: 9 }, DIRECTNESS: { score: 9 } }, overall: 9, improvements: Array.from({length:10}, (_,i)=>`Action ${i}`) });
function setup(status = 200) {
  bodies = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const target = String(input instanceof Request ? input.url : input);
    if (!target.startsWith(url + '/')) throw new Error('Unexpected test egress');
    const body = JSON.parse(String(init.body)); bodies.push(body);
    if(target.endsWith('/embeddings'))return Response.json({object:'list',model:body.model,data:body.input.map((_:unknown,index:number)=>({object:'embedding',index,embedding:Array(512).fill(0.01)})),usage:{prompt_tokens:2,total_tokens:2}});
    if (status !== 200) return Response.json({ error: { message: 'synthetic failure', type: 'test' } }, {status});
    return Response.json({id:'mock',object:'chat.completion',created:0,model:body.model,choices:[{index:0,message:{role:'assistant',content:score},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:100,total_tokens:200}});
  }) as typeof fetch;
  configureGateway({ chat_model: model, env: { DASHSCOPE_API_KEY:'fake-only',DEEPSEEK_API_KEY:'fake-only',ZHIPUAI_API_KEY:'fake-only' }, base_urls:{dashscope:url,deepseek:url,zhipu:url}, provider_chat_options:{[model]:{enable_thinking:true,top_p:0.8}} });
}
function dir() { const p=mkdtempSync(join(tmpdir(),'qwen-judge-'));dirs.push(p);return p; }
const guarded = <T>(fn:()=>Promise<T>) => withAIInvocationGuard(async () => ({settle:async()=>{}}),fn);
afterEach(()=>{globalThis.fetch=originalFetch;resetGateway();for(const d of dirs)rmSync(d,{recursive:true,force:true});dirs=[];});

test('target is chat-capable and has an exact positive canonical price',()=>{
  expect(validateModelId(model).ok).toBe(true);
  expect(thinkingOffControl(model)?.disables).toBe(true);
  expect(canonicalLookup(model)?.input).toBeGreaterThan(0);
  expect(thinkingOffControl('dashscope:qwen3.7-flash')).toBeUndefined();
});
for(const cap of [1536,4000]) test(`native SDK sends the target nonthinking and exact cap ${cap}`,async()=>{
  setup();await guarded(()=>chat({model,messages:[{role:'user',content:'grade'}],thinking:'off',maxTokens:cap,allowFallback:false}));
  expect(bodies).toHaveLength(1);expect(bodies[0].model).toBe('qwen3.8-flash');expect(bodies[0].enable_thinking).toBe(false);expect(bodies[0].max_tokens).toBe(cap);expect(bodies[0].top_p).toBe(0.8);
});
test('original single-A evaluator uses its original uppercase score contract',async()=>{
  setup();const r=await guarded(()=>runEval({task:'6x7 expected42',output:'42',dimensions:['CORRECTNESS — right?','DIRECTNESS — direct?'],slots:[{id:'A',model}],cycles:1,maxTokens:1536,receiptDir:dir()}));
  expect(bodies).toHaveLength(1);expect(bodies[0].messages.at(-1).content).toContain('"CORRECTNESS"');expect(r.cycles[0].slots[0].ok).toBe(true);expect(r.finalAggregate.verdict).toBe('inconclusive');
});
for(const path of ['batch','nightly'] as const) test(`${path} traverses the real native SDK; routed/default caps and all slots captured`,async()=>{
  setup();const p=dir(),batch=join(p,'input.jsonl'),summary=join(p,'summary.json');writeFileSync(batch,JSON.stringify({question_id:'synthetic',question:'6x7',answer:'42',hypothesis:'42'})+'\n');
  // Preserve real B/C identities through the mock caller path; no production config writes.
  if(path==='batch') await guarded(()=>runEvalCrossModal(['--batch',batch,'--output',summary,'--yes','--max-usd','1','--max-tokens','1536'],{useConfiguredGateway:true,slotConfig:async()=>({A:model,B:'deepseek:deepseek-v4-pro',C:'zhipu:glm-5.3-flash'})}));
  else await guarded(()=>runCrossModalBatchForProbe({batchPath:batch,summaryPath:summary,maxUsd:1,modelRoutes:{reader:{model,source:'tier_config'},extractor:{model,source:'tier_config'},slots:{A:model,B:'deepseek:deepseek-v4-pro',C:'zhipu:glm-5.3-flash'}}}));
  expect(bodies).toHaveLength(3);expect(bodies.map(b=>b.model).sort()).toEqual(['deepseek-v4-pro','glm-5.3-flash','qwen3.8-flash']);const body=bodies.find(b=>b.model==='qwen3.8-flash');expect(body.enable_thinking).toBe(false);expect(body.max_tokens).toBe(path==='batch'?1536:4000);
});
for(const status of [401,429,500]) test(`finite guard performs one outbound attempt on ${status}, without SDK retry or fallback`,async()=>{
  setup(status);await expect(guarded(()=>chat({model,messages:[{role:'user',content:'grade'}],thinking:'off',maxTokens:1536,allowFallback:false}))).rejects.toThrow();expect(bodies).toHaveLength(1);
});

test('adding chat preserves actual embedding wire model, input and dimension',async()=>{
 setup();const vectors=await embed(['synthetic text'],{embeddingModel:'dashscope:text-embedding-v3',dimensions:512});
 expect(vectors[0].length).toBe(512);expect(bodies).toHaveLength(1);expect(bodies[0].model).toBe('text-embedding-v3');expect(bodies[0].input).toEqual(['synthetic text']);expect(bodies[0].dimensions).toBe(512);expect(bodies[0].enable_thinking).toBeUndefined();
});
