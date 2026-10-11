import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureGateway, resetGateway, __setChatTransportForTests, toolLoop, chat, type ChatOpts, type ChatResult } from '../src/core/ai/gateway';
import { knowledgeWorkbenchAnswer } from '../src/product/workbench/routes';
import { WorkbenchService } from '../src/product/workbench/service';
import { WorkbenchStore } from '../src/product/workbench/store';
import type { WorkbenchToolCall } from '../shared/workbench';
import { chatMessageTokens, KNOWLEDGE_TOOLS } from '../src/product/workbench/tools';
import { contextBudget, estimateTokens } from '../src/product/workbench/context';
import { PGLiteEngine } from '../src/core/pglite-engine';

const usage = { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 };
const text = (value: string): ChatResult => ({ text: value, blocks: [{ type: 'text', text: value }], model: 'service-test:chat', providerId: 'service-test', stopReason: 'end', usage });
const call = (name: string, input: unknown, id = 'call'): ChatResult => ({ ...text(''), blocks: [{ type: 'tool-call', toolName: name, input, toolCallId: id }], stopReason: 'tool_calls' });
const question = { id: 'q', text: '核对项目预算', role: 'user' as const, status: 'complete' as const, createdAt: '' };
const hit = { source_id: 'a', slug: 'project', title: '项目预算', snippet: '初步预算' };
const search = async () => ({ results: [hit] } as any);
test('several empty multiword searches require one single-keyword check before declaring no evidence',async()=>{
  let requests=0;const queries:string[]=[];
  __setChatTransportForTests(async()=>{requests++;return requests===1?call('knowledge_search',{query:'人物 经历 兴趣'}):requests===2?text('没有找到资料'):requests===3?call('knowledge_search',{query:'人物'}):text('核对到资料 [1]');});
  const answer=knowledgeWorkbenchAnswer({getPage:async()=>null} as any,{search:async(_engine,{query})=>{queries.push(query);return {results:query==='人物'?[hit]:[]} as any;},answer:chat,loop:toolLoop});
  const result=await answer({messages:[question],model:'service-test:chat',knowledge:true,signal:new AbortController().signal,progress:()=>{}});
  expect(result.citations).toHaveLength(1);expect(result.text).toBe('核对到资料 [1]');expect(queries).toContain('人物');
});
test('tool-selection prose is not concatenated into the final answer',async()=>{
  let requests=0;__setChatTransportForTests(async()=>++requests===1?{...call('knowledge_search',{query:'预算'}),text:'内部分析不作为结论',blocks:[{type:'text',text:'内部分析不作为结论'},...call('knowledge_search',{query:'预算'}).blocks]}:text('最终预算十万元 [1]'));
  const answer=knowledgeWorkbenchAnswer({getPage:async()=>null} as any,{search,answer:chat,loop:toolLoop});
  const result=await answer({messages:[question],model:'service-test:chat',knowledge:true,signal:new AbortController().signal,progress:()=>{}});
  expect(result.text).toBe('最终预算十万元 [1]');
});
test('summary references retain source cards when all cited replies were compressed',async()=>{
  let system='';__setChatTransportForTests(async opts=>{system=opts.system??'';return text('甲资料 [1]，乙资料 [2]');});
  const answer=knowledgeWorkbenchAnswer({getPage:async()=>null} as any,{search:async()=>({results:[]} as any),answer:chat,loop:toolLoop});
  const result=await answer({messages:[question],summary:'甲资料 [1]，乙资料 [2]',priorCitations:[{sourceId:'a',slug:'same',title:'甲',snippet:'甲资料'},{sourceId:'b',slug:'same',title:'乙',snippet:'乙资料'}],model:'service-test:chat',knowledge:true,signal:new AbortController().signal,progress:()=>{}} as any);
  expect(result.citations.map(item=>[item.sourceId,item.slug])).toEqual([['a','same'],['b','same']]);
  expect(system).toContain('[1] 甲 {"source_id":"a","slug":"same"}');expect(system).toContain('[2] 乙 {"source_id":"b","slug":"same"}');
});

test('an empty full-question presearch requires one keyword search before claiming no knowledge',async()=>{
  let requests=0,searches=0;
  __setChatTransportForTests(async()=>{requests++;return requests===1?text('没有找到任何资料'):requests===2?call('knowledge_search',{query:'预算'}):text('已核对预算十万元 [1]');});
  const answer=knowledgeWorkbenchAnswer({getPage:async()=>null} as any,{search:async()=>{searches++;return {results:searches===1?[]:[hit]} as any;},answer:chat,loop:toolLoop});
  const result=await answer({messages:[question],model:'service-test:chat',knowledge:true,signal:new AbortController().signal,progress:()=>{}});
  expect(result.citations).toHaveLength(1);expect(result.text).not.toContain('没有找到任何资料');expect(searches).toBe(2);expect(requests).toBe(3);
});

test('DSML text calls execute through the same Source-validated reader and stay out of visible text',async()=>{
  let requests=0,reads=0,visible='';
  __setChatTransportForTests(async opts=>{requests++;const answer=requests===1?'<think>内部</think><｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="knowledge_read"><｜｜DSML｜｜ parameter name="source_id" string="true">a</｜｜DSML｜｜ parameter><｜｜DSML｜｜ parameter name="slug" string="true">project</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>':'预算十万元 [1]';for(const character of answer)opts.onTextDelta?.(character);return text(answer);});
  const answer=knowledgeWorkbenchAnswer({getPage:async()=>{reads++;return {compiled_truth:'预算十万元',timeline:''};}} as any,{search,answer:chat,loop:toolLoop});
  const result=await answer({messages:[question],model:'service-test:chat',knowledge:true,signal:new AbortController().signal,progress:()=>{},onDelta:delta=>{visible+=delta;}});
  expect(result.text).toBe('预算十万元 [1]');expect(visible).not.toContain('DSML');expect(visible).not.toContain('内部');expect(requests).toBe(2);expect(reads).toBe(2);
});
test('the reserved final answer carries evidence without native tool history',async()=>{
  let requests=0;
  __setChatTransportForTests(async opts=>{requests++;if(opts.tools?.length)return call('knowledge_read',{source_id:'a',slug:'project'},`read-${requests}`);expect(JSON.stringify(opts.messages)).not.toContain('tool-call');expect(JSON.stringify(opts.messages)).not.toContain('tool-result');expect(JSON.stringify(opts.messages)).toContain('十万元');return text('最终预算十万元 [1]');});
  const answer=knowledgeWorkbenchAnswer({getPage:async()=>({compiled_truth:'预算十万元',timeline:''})} as any,{search,answer:chat,loop:toolLoop});
  const result=await answer({messages:[question],model:'service-test:chat',knowledge:true,signal:new AbortController().signal,progress:()=>{}});
  expect(result.text).toContain('最终预算十万元');expect(requests).toBe(8);
});

test('follow-up references keep prior Source cards and remap conflicting turn-local indices',async()=>{
  const seen:string[]=[];__setChatTransportForTests(async opts=>{seen.push(JSON.stringify(opts.messages));return text('延续此前预算 [1]，新资料 [2]');});
  const prior={id:'a',role:'assistant' as const,status:'complete' as const,text:'此前预算 [1]',createdAt:'',citations:[{sourceId:'old',slug:'budget',title:'旧预算',snippet:'十万元'}]};
  const answer=knowledgeWorkbenchAnswer({getPage:async()=>null} as any,{search:async()=>({results:[{source_id:'new',slug:'plan',title:'新资料',snippet:'八月完成'}]} as any),answer:chat,loop:toolLoop});
  const result=await answer({messages:[question,prior,{...question,id:'follow',text:'继续比较'}],model:'service-test:chat',knowledge:true,signal:new AbortController().signal,progress:()=>{}});
  expect(result.citations.map(item=>[item.sourceId,item.slug])).toEqual([['old','budget'],['new','plan']]);
  expect(seen[0]).toContain('此前预算 [1]');expect(result.text).toContain('[2]');
  const next=await knowledgeWorkbenchAnswer({} as any,{search:async()=>({results:[]} as any),answer:chat,loop:toolLoop})({messages:[question,prior,{...question,id:'follow'}],model:'service-test:chat',knowledge:true,signal:new AbortController().signal,progress:()=>{}});
  expect(next.citations[0]?.sourceId).toBe('old');expect(prior.citations[0].sourceId).toBe('old');
});

test('retrieval rounds reserve a final answer instead of failing after repeated reads',async()=>{
  let requests=0;const finalSystems:string[]=[];
  __setChatTransportForTests(async opts=>{
    requests++;
    if(opts.tools?.length)return call('knowledge_read',{source_id:'a',slug:'project',offset:(requests-1)*100});
    finalSystems.push(opts.system??'');return text('根据已读资料，预算十万元 [1]');
  });
  const answer=knowledgeWorkbenchAnswer({getPage:async()=>({source_id:'a',compiled_truth:'预算十万元。'.repeat(2000),timeline:''})} as any,{search,answer:chat,loop:toolLoop,summarize:async()=> '已核对预算十万元。'});
  const result=await answer({messages:[question],model:'service-test:chat',knowledge:true,contextWindow:8192,signal:new AbortController().signal,progress:()=>{}});
  expect(requests).toBe(8);expect(result.text).toContain('预算十万元');expect(result.stopReason).toBe('end');expect(finalSystems[0]).toContain('本轮资料收集已结束');expect(finalSystems[0]).not.toContain('JSON receipt');
});
beforeEach(() => configureGateway({ generative_enabled: true, chat_model: 'service-test:chat', env: {} }));
afterEach(() => { __setChatTransportForTests(null); resetGateway(); });

test('shared tool loop forwards streaming and temperature, and checks budget before each request', async () => {
  let calls = 0; let visible = ''; const temperatures: unknown[] = [];
  __setChatTransportForTests(async opts => {
    calls++; temperatures.push(opts.temperature); opts.onTextDelta?.('流式回答'); return text('流式回答');
  });
  const result = await toolLoop({ initialMessages: [{ role: 'user', content: '问题' }], tools: [], toolHandlers: new Map(), temperature: .3, onTextDelta: delta => { visible += delta; }, beforeModelCall: () => {} });
  expect(result.finalText).toBe(visible); expect(temperatures).toEqual([.3]);
  await expect(toolLoop({ initialMessages: [], tools: [], toolHandlers: new Map(), beforeModelCall: () => { throw new Error('预算不足'); } })).rejects.toThrow('预算不足');
  expect(calls).toBe(1);
});

test('search, read, streamed answer and tool results persist and survive reopening', async () => {
  const requests: ChatOpts[] = []; const reads: unknown[] = [];
  __setChatTransportForTests(async opts => {
    requests.push(opts);
    if (requests.length === 1) return call('knowledge_search', { query: '项目预算' }, 'search');
    if (requests.length === 2) return call('knowledge_read', { source_id: 'a', slug: 'project' }, 'read');
    opts.onTextDelta?.('正式预算'); return text('正式预算十万元 [1]');
  });
  const answer = knowledgeWorkbenchAnswer({ getPage: async (slug: string, options: unknown) => { reads.push([slug, options]); return { source_id: 'a', compiled_truth: '正式预算十万元', timeline: '' }; } } as any, { search, answer: chat, loop: toolLoop });
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-tools-')); const store = new WorkbenchStore(root);
  const models = () => [{ id: 'service-test:chat', name: '测试模型', contextWindow: 32000 }];
  const service = new WorkbenchService(store, models, answer);
  const thread = service.create({ knowledge: true }); service.send(thread.id, { text: question.text }); await service.settled(thread.id);
  const reply = service.get(thread.id).messages.at(-1)!;
  expect(reply.status).toBe('complete'); expect(reply.text).toContain('正式预算十万元');
  expect(reply.toolCalls?.map(item => [item.name, item.status])).toEqual([['knowledge_search', 'complete'], ['knowledge_read', 'complete']]);
  expect(reads.every((item: any) => item[1].sourceId === 'a')).toBe(true);
  expect(reply.citations?.[0].sourceId).toBe('a');
  const reopened = new WorkbenchService(new WorkbenchStore(root), models, answer);
  expect(reopened.get(thread.id).messages.at(-1)?.toolCalls).toEqual(reply.toolCalls);
  reopened.send(thread.id, { text: '为什么？' }); await reopened.settled(thread.id);
  expect(JSON.stringify(requests.at(-1)?.messages)).toContain('正式预算十万元');
});

test('read rejects invented Source pairs without reading a different page', async () => {
  const reads: string[] = []; const events: WorkbenchToolCall[] = []; let turns = 0;
  __setChatTransportForTests(async () => ++turns === 1 ? call('knowledge_read', { source_id: 'outside', slug: 'project' }) : text('无法读取'));
  const answer = knowledgeWorkbenchAnswer({ getPage: async (_slug: string, opts: any) => { reads.push(opts.sourceId); return { compiled_truth: '正确资料', timeline: '' }; } } as any, { search, answer: chat, loop: toolLoop });
  await answer({ messages: [question], model: 'service-test:chat', knowledge: true, signal: new AbortController().signal, progress: () => {}, onTool: item => events.push(item) });
  expect(reads).toEqual(['a']); expect(events.at(-1)?.status).toBe('error'); expect(events.at(-1)?.error).toContain('搜索结果');
});

test('tool failures remain visible and cancellation stops further execution', async () => {
  const events: WorkbenchToolCall[] = []; let turns = 0; let searches = 0;
  __setChatTransportForTests(async () => ++turns === 1 ? call('knowledge_search', { query: '另一份资料' }) : text('未取得资料'));
  const answer = knowledgeWorkbenchAnswer({ getPage: async () => null } as any, { search: async () => { if (++searches > 1) throw new Error('原生查询失败'); return { results: [] } as any; }, answer: chat, loop: toolLoop });
  await answer({ messages: [question], model: 'service-test:chat', knowledge: true, signal: new AbortController().signal, progress: () => {}, onTool: item => events.push(item) });
  expect(events.at(-1)?.error).toBe('原生查询失败');
  const abort = new AbortController(); searches = 0; turns = 0;
  await expect(answer({ messages: [question], model: 'service-test:chat', knowledge: true, signal: abort.signal, progress: () => {}, onTool: item => { if (item.status === 'running') abort.abort(); } })).rejects.toThrow();
  expect(searches).toBe(1); expect(turns).toBe(1);
});

test('ordinary chat exposes no tools', async () => {
  let options: ChatOpts | undefined;
  __setChatTransportForTests(async opts => { options = opts; return text('普通回答'); });
  const answer = knowledgeWorkbenchAnswer({} as any, { search: async () => { throw new Error('不应检索'); }, answer: chat, loop: toolLoop });
  await answer({ messages: [question], model: 'service-test:chat', knowledge: false, signal: new AbortController().signal, progress: () => {} });
  expect(options?.tools).toBeUndefined();
});

test('large tool results are excerpts and every model request includes schemas in the budget', async () => {
  let turns = 0; const events: WorkbenchToolCall[] = [];
  __setChatTransportForTests(async opts => {
    expect(estimateTokens(opts.system ?? '') + estimateTokens(JSON.stringify(opts.tools)) + chatMessageTokens(opts.messages)).toBeLessThanOrEqual(contextBudget(8192, .8));
    if (++turns === 1) return call('knowledge_read', { source_id: 'a', slug: 'project' });
    return text('已核对 [1]');
  });
  const answer = knowledgeWorkbenchAnswer({ getPage: async () => ({ source_id: 'a', compiled_truth: '大段资料'.repeat(10000), timeline: '' }) } as any, { search, answer: chat, loop: toolLoop });
  await answer({ messages: [question], model: 'service-test:chat', contextWindow: 8192, knowledge: true, signal: new AbortController().signal, progress: () => {}, onTool: item => events.push(item) });
  const output = JSON.parse(events.at(-1)!.output!);
  expect(output.truncated).toBe(true); expect(output.nextOffset).toBeGreaterThan(0); expect(output.content.length).toBeLessThan(6000);
});

test('unsupported writes are recorded as failures and never execute', async () => {
  let turns = 0; const events: WorkbenchToolCall[] = [];
  __setChatTransportForTests(async () => ++turns === 1 ? call('put_page', { slug: 'project', content: '覆盖原文' }) : text('无法写入'));
  const answer = knowledgeWorkbenchAnswer({ getPage: async () => null, putPage: () => { throw new Error('禁止调用'); } } as any, { search: async () => ({ results: [] } as any), answer: chat, loop: toolLoop });
  await answer({ messages: [question], model: 'service-test:chat', knowledge: true, signal: new AbortController().signal, progress: () => {}, onTool: item => events.push(item) });
  expect(events.at(-1)?.status).toBe('error'); expect(events.at(-1)?.name).toBe('put_page');
});

test('OpenAI-compatible HTTP streams text and tool calls together without losing tool blocks', async () => {
  const requests: any[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    const body = await req.json() as any; requests.push(body);
    const first = requests.length === 1;
    const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'tool-stream', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    const events = first ? [chunk({ role: 'assistant', content: '先查资料。' }, null), chunk({ tool_calls: [{ index: 0, id: 'read-id', type: 'function', function: { name: 'echo', arguments: '{"query":"预算"}' } }] }, 'tool_calls')] : [chunk({ role: 'assistant', content: '预算' }, null), chunk({ content: '十万元。' }, 'stop')];
    return new Response(events.join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  try {
    configureGateway({ generative_enabled: true, chat_model: 'service-http:chat', env: {}, base_urls: { 'service-http': `${server.url}v1` } });
    const outputs: unknown[] = []; let visible = '';
    const result = await toolLoop({ initialMessages: [{ role: 'user', content: '问题' }], tools: [{ name: 'echo', description: '返回预算', inputSchema: KNOWLEDGE_TOOLS[0].inputSchema }], toolHandlers: new Map([['echo', { execute: async raw => { outputs.push(raw); return '十万元'; } }]]), onTextDelta: delta => { visible += delta; } });
    expect(outputs).toEqual([{ query: '预算' }]); expect(visible).toBe('先查资料。预算十万元。'); expect(result.finalText).toBe('预算十万元。');
    expect(requests.every(body => body.stream === true)).toBe(true);
    expect(requests[1].messages.some((message: any) => message.role === 'tool' && message.tool_call_id === 'read-id')).toBe(true);
  } finally { server.stop(true); }
});

test('length reporting is opt-in so existing shared-loop callers keep their contract', async () => {
  __setChatTransportForTests(async () => ({ ...text('未完'), stopReason: 'length' }));
  const options = { initialMessages: [], tools: [], toolHandlers: new Map() };
  expect((await toolLoop(options)).stopReason).toBe('end');
  expect((await toolLoop({ ...options, reportLengthStop: true })).stopReason).toBe('length');
});

test('stopping a running tool persists cancellation and ignores its late result', async () => {
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let finish!: () => void; const delayed = new Promise<void>(resolve => { finish = resolve; });
  let searches = 0;
  __setChatTransportForTests(async () => call('knowledge_search', { query: '继续查询' }));
  const answer = knowledgeWorkbenchAnswer({} as any, { search: async () => { if (++searches === 1) return { results: [] } as any; entered(); await delayed; return { results: [hit] } as any; }, answer: chat, loop: toolLoop });
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-tool-cancel-')); const store = new WorkbenchStore(root);
  const service = new WorkbenchService(store, () => [{ id: 'service-test:chat', name: '测试' }], answer);
  const thread = service.create({}); service.send(thread.id, { text: '查资料' }); await started;
  expect(service.get(thread.id).messages.at(-1)?.toolCalls?.[0].status).toBe('running');
  service.cancel(thread.id); finish(); await service.settled(thread.id);
  const reply = new WorkbenchStore(root).get(thread.id).messages.at(-1)!;
  expect(reply.status).toBe('cancelled'); expect(reply.toolCalls?.[0].status).toBe('cancelled'); expect(reply.toolCalls?.[0].output).toBeUndefined();
});

test('restarting marks interrupted tool executions without changing completed records', () => {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-tool-restart-')); const store = new WorkbenchStore(root);
  const thread = new WorkbenchService(store, () => [{ id: 'service-test:chat', name: '测试' }], async () => ({ text: '', model: '', citations: [] })).create({});
  thread.messages.push({ ...question, role: 'assistant', status: 'running', toolCalls: [{ id: 'pending', name: 'knowledge_search', input: '{}', status: 'running', startedAt: '' }] }); store.save(thread);
  const reopened = new WorkbenchService(new WorkbenchStore(root), () => [], async () => ({ text: '', model: '', citations: [] }));
  expect(reopened.get(thread.id).messages.at(-1)?.toolCalls?.[0].status).toBe('error');
  expect(reopened.get(thread.id).messages.at(-1)?.toolCalls?.[0].error).toContain('中断');
});

test('isolated PGLite reads the exact Source when pages share a slug and leaves both unchanged', async () => {
  const engine = new PGLiteEngine();
  await engine.connect({}); await engine.initSchema();
  try {
    await engine.executeRaw("INSERT INTO sources (id, name, local_path, config, created_at) VALUES ('a', 'a', '/fake/a', '{}'::jsonb, NOW()), ('b', 'b', '/fake/b', '{}'::jsonb, NOW())");
    await engine.putPage('project', { title: '项目预算', type: 'note', compiled_truth: '来源 A 的预算为十万元', frontmatter: {} }, { sourceId: 'a' });
    await engine.putPage('project', { title: '项目预算', type: 'note', compiled_truth: '来源 B 的预算为二十万元', frontmatter: {} }, { sourceId: 'b' });
    const before = await engine.executeRaw('SELECT * FROM pages ORDER BY id');
    let turns = 0; const events: WorkbenchToolCall[] = [];
    __setChatTransportForTests(async () => ++turns === 1 ? call('knowledge_read', { source_id: 'b', slug: 'project' }) : text('二十万元 [2]'));
    const answer = knowledgeWorkbenchAnswer(engine, { search: async () => ({ results: [hit, { ...hit, source_id: 'b' }] } as any), answer: chat, loop: toolLoop });
    await answer({ messages: [question], model: 'service-test:chat', knowledge: true, signal: new AbortController().signal, progress: () => {}, onTool: item => events.push(item) });
    const output = JSON.parse(events.at(-1)!.output!);
    expect(output.source_id).toBe('b'); expect(output.content).toContain('二十万元'); expect(output.content).not.toContain('来源 A');
    expect(await engine.executeRaw('SELECT * FROM pages ORDER BY id')).toEqual(before);
  } finally { await engine.disconnect(); }
});
