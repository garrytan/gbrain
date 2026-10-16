import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { inlineCitationIndex } from '../admin/src/pages/Documentation';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultAssistant } from '../shared/workbench';
import { WorkbenchService, conversationContext } from '../src/product/workbench/service';
import { knowledgeWorkbenchAnswer } from '../src/product/workbench/routes';
import { WorkbenchStore } from '../src/product/workbench/store';

const root = () => mkdtempSync(join(tmpdir(), 'pmbrain-workbench-test-'));
test('ordinary assistant chat replaces orphaned reasoning and preserves only the final answer',async()=>{
  let visible='';const answer=knowledgeWorkbenchAnswer({} as any,{search:async()=>({results:[]} as any),answer:async opts=>{for(const character of '内部分析</think>可见答案')opts.onTextDelta?.(character);return {text:'内部分析</think>可见答案',model:'ollama:local',providerId:'ollama',blocks:[],usage:{input_tokens:10,output_tokens:5,cache_read_tokens:0,cache_creation_tokens:0},stopReason:'end'};}});
  const result=await answer({messages:[{id:'q',role:'user',text:'普通问题',status:'complete',createdAt:''}],model:'ollama:local',knowledge:false,signal:new AbortController().signal,progress:()=>{},onDelta:delta=>{visible+=delta;},onReplace:value=>{visible=value;}});
  expect(result.text).toBe('可见答案');expect(visible).toBe('可见答案');
});
test('compressed-only history retains exact Source references and projects old local numbering',async()=>{
  const store=new WorkbenchStore(root());const inputs:any[]=[];const transcripts:string[]=[];
  const service=new WorkbenchService(store,()=>[{id:'ollama:local',name:'本地',contextWindow:8192}],async input=>{inputs.push(input);return {text:'新回答',model:'ollama:local',citations:[]};},async input=>{transcripts.push(input.transcript);return '甲页 [1]，乙页 [2]';});
  const assistant=defaultAssistant();assistant.context.maxMessages=2;service.saveAssistant(assistant);
  const thread=service.create({knowledge:true});
  thread.messages.push(
    {id:'u1',role:'user',text:'第一问',status:'complete',createdAt:''},
    {id:'a1',role:'assistant',text:'甲页 [1]',status:'complete',createdAt:'',citations:[{sourceId:'a',slug:'same',title:'甲',snippet:'甲资料'}]},
    {id:'u2',role:'user',text:'第二问',status:'complete',createdAt:''},
    {id:'a2',role:'assistant',text:'乙页 [1]',status:'complete',createdAt:'',citations:[{sourceId:'b',slug:'same',title:'乙',snippet:'乙资料'}]},
  );store.save(thread);
  service.send(thread.id,{text:'请核对两个来源'});await service.settled(thread.id);
  expect(inputs[0].messages.map((message:any)=>message.text)).toEqual(['请核对两个来源']);
  expect(inputs[0].priorCitations?.map((item:any)=>[item.sourceId,item.slug])).toEqual([['a','same'],['b','same']]);
  expect(transcripts.join('\n')).toContain('乙页 [2]');
  const reopened=store.get(thread.id);expect(reopened.messages[3]?.text).toBe('乙页 [1]');expect(reopened.messages[3]?.citations?.[0]?.sourceId).toBe('b');
});
test('知识助手回答里的角标在悬停时显示对应引用', () => {
  expect(inlineCitationIndex('[1]')).toBe(1);
  expect(inlineCitationIndex('[12]')).toBe(12);
  expect(inlineCitationIndex('[0]')).toBeNull();
  expect(inlineCitationIndex('见 [1]')).toBeNull();
  const message = readFileSync(new URL('../admin/src/workbench/Message.tsx', import.meta.url), 'utf8');
  const article = readFileSync(new URL('../admin/src/pages/Documentation.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../admin/src/workbench/workbench.css', import.meta.url), 'utf8');
  expect(message).toContain("citations={message.role === 'assistant' ? message.citations : undefined}");
  expect(article).toContain('role="tooltip"');
  expect(article).toContain('citation.snippet');
  expect(css).toContain('.wb-cite-card');
});
test('multi-turn conversation sends prior user and assistant messages and persists across restart', async () => {
  const dir = root(); const seen: any[] = [];
  const service = new WorkbenchService(new WorkbenchStore(dir), () => [{ id: 'ollama:local', name: '本地' }], async input => { seen.push(input.messages); return { text: '记住了：蓝色', model: 'ollama:local', citations: [] }; });
  const thread = service.create({ model: 'ollama:local', knowledge: true });
  service.send(thread.id, { text: '我喜欢蓝色' }); await service.settled(thread.id);
  service.send(thread.id, { text: '我喜欢什么颜色？' }); await service.settled(thread.id);
  expect(seen[1].map((m: any) => m.text)).toEqual(['我喜欢蓝色', '记住了：蓝色', '我喜欢什么颜色？']);
  expect(new WorkbenchStore(dir).get(thread.id).messages.length).toBe(4);
});
test('停止后马上可以再发，生成中追加的新要求不会被旧回答盖掉', async () => {
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const firstStartedGate = new Promise<void>(resolve => { firstStarted = resolve; });
  let calls = 0;
  const service = new WorkbenchService(new WorkbenchStore(root()), () => [{ id: 'ollama:local', name: '本地' }], async input => {
    calls += 1;
    if (calls === 1) {
      input.onDelta?.('旧的一半');
      firstStarted();
      await firstGate;
      input.onDelta?.('不应写入');
      return { text: '迟到的旧回答', model: 'ollama:local', citations: [] };
    }
    return { text: '只写川商出海', model: 'ollama:local', citations: [] };
  });
  const thread = service.create({});
  service.send(thread.id, { text: '生成本周周报' });
  await firstStartedGate;
  expect(() => service.send(thread.id, { text: '任务不要打断' })).toThrow('当前会话正在生成');
  const stopped = service.cancel(thread.id);
  expect(stopped.messages.at(-1)?.status).toBe('cancelled');
  expect(service.list().find(row => row.id === thread.id)?.running).toBe(false);
  service.send(thread.id, { text: '停止后继续' });
  expect(service.get(thread.id).messages.map(message => message.text)).toEqual(['生成本周周报', '旧的一半', '停止后继续', '']);
  const replaced = service.send(thread.id, { text: '我只做川商出海的', interrupt: true });
  expect(replaced.messages.at(-2)?.text).toBe('我只做川商出海的');
  expect(replaced.messages.filter(message => message.role === 'assistant').slice(0, 2).every(message => message.status === 'cancelled')).toBe(true);
  releaseFirst();
  await service.settled(thread.id);
  await service.settled(thread.id);
  const saved = service.get(thread.id).messages;
  expect(saved[1]?.status).toBe('cancelled');
  expect(saved[1]?.text).toBe('旧的一半');
  expect(saved.at(-1)?.status).toBe('complete');
  expect(saved.at(-1)?.text).toBe('只写川商出海');
});
test('conversations do not leak history, cancellation ignores a late answer and retry is explicit', async () => {
  let finish!: (v: any) => void;
  const service = new WorkbenchService(new WorkbenchStore(root()), () => [{ id: 'ollama:local', name: '本地' }], () => new Promise(resolve => { finish = resolve; }));
  const one = service.create({}); const two = service.create({});
  service.send(one.id, { text: '保留的消息' }); await Promise.resolve();
  expect(service.get(two.id).messages).toHaveLength(0);
  service.cancel(one.id); finish({ text: '不应出现的迟到答案', model: 'ollama:local', citations: [] }); await service.settled(one.id);
  expect(service.get(one.id).messages.at(-1)?.status).toBe('cancelled');
  expect(service.get(one.id).messages.at(-1)?.text).toBe('');
});
test('failed response remains visible and is not replayed as valid context', async () => {
  const service = new WorkbenchService(new WorkbenchStore(root()), () => [{ id: 'ollama:local', name: '本地' }], async () => { throw new Error('平台鉴权失败'); });
  const thread = service.create({}); service.send(thread.id, { text: '你好' }); await service.settled(thread.id);
  expect(service.get(thread.id).messages.at(-1)?.error).toContain('鉴权失败');
  expect(conversationContext(service.get(thread.id).messages).map(m => m.role)).toEqual(['user']);
  expect(() => service.send(thread.id, { text: '未知', model: 'unconfigured:bad' })).toThrow();
  expect(() => service.get('../config')).toThrow();
});

test('retry replaces only the last reply and startup exposes interrupted generation', async () => {
  const store = new WorkbenchStore(root()); let calls = 0;
  const service = new WorkbenchService(store, () => [{ id: 'ollama:local', name: '本地' }], async () => {
    if (!calls++) throw new Error('临时错误');
    return { text: '重试成功', model: 'ollama:local', citations: [] };
  });
  const thread = service.create({}); service.send(thread.id, { text: '保留这个问题' }); await service.settled(thread.id);
  service.send(thread.id, { retry: true }); await service.settled(thread.id);
  const saved = store.get(thread.id);
  expect(saved.messages.map(m => m.text)).toEqual(['保留这个问题', '重试成功']);
  saved.messages[1].status = 'running'; store.save(saved);
  const restored = new WorkbenchService(store, () => [], async () => { throw new Error('不应调用'); });
  expect(restored.get(thread.id).messages[1].error).toContain('中断');
});

test('回答会逐段写进会话，生成结束前就能看到前半段，并记下模型的界面名称', async () => {
  const dir = root();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const startedGate = new Promise<void>(resolve => { started = resolve; });
  const service = new WorkbenchService(new WorkbenchStore(dir), () => [{ id: 'deepseek:deepseek-flash', name: 'DeepSeek Flash · DeepSeek' }], async input => {
    input.onDelta?.('前半段');
    started();
    await gate;
    input.onDelta?.('后半段');
    return { text: '前半段后半段', model: 'deepseek:deepseek-flash', citations: [], knowledge: 'off', stopReason: 'end' };
  });
  const thread = service.create({ knowledge: false });
  service.send(thread.id, { text: '你好' });
  await startedGate;
  const partial = new WorkbenchStore(dir).get(thread.id).messages.at(-1);
  expect(partial?.status).toBe('running');
  expect(partial?.text).toBe('前半段');
  expect(partial?.modelName).toBe('DeepSeek Flash · DeepSeek');
  expect(partial?.contextNote).toBeUndefined();
  release();
  await service.settled(thread.id);
  const done = new WorkbenchStore(dir).get(thread.id).messages.at(-1);
  expect(done?.status).toBe('complete');
  expect(done?.text).toBe('前半段后半段');
  expect(done?.modelName).toBe('DeepSeek Flash · DeepSeek');
});

test('修改已经发送的问题后，从那条问题重新回答，后面的内容被替换', async () => {
  const seen: string[][] = [];
  const service = new WorkbenchService(new WorkbenchStore(root()), () => [{ id: 'ollama:local', name: '本地' }], async input => {
    seen.push(input.messages.map(message => message.text));
    return { text: `回答：${input.messages.at(-1)?.text}`, model: 'ollama:local', citations: [] };
  });
  const thread = service.create({});
  service.send(thread.id, { text: '原来的问题' }); await service.settled(thread.id);
  service.send(thread.id, { text: '后面的问题' }); await service.settled(thread.id);
  const saved = service.get(thread.id);
  saved.summary = '旧摘要';
  saved.summaryUntil = saved.messages[2]!.id;
  (service as unknown as { store: WorkbenchStore }).store.save(saved);
  expect(() => service.send(thread.id, { text: '改正', editMessageId: saved.messages[1]!.id })).toThrow('只能修改你发送的问题');
  service.send(thread.id, { text: '改正后的问题', editMessageId: saved.messages[0]!.id });
  await service.settled(thread.id);
  const next = service.get(thread.id);
  expect(next.messages.map(message => message.text)).toEqual(['改正后的问题', '回答：改正后的问题']);
  expect(next.summary).toBeUndefined();
  expect(next.summaryUntil).toBeUndefined();
  expect(next.title).toBe('改正后的问题');
  expect(seen.at(-1)).toEqual(['改正后的问题']);
});

test('知识库没有检索到资料时，回答会标明这是一般知识', async () => {
  let system = '';
  const answer = knowledgeWorkbenchAnswer({} as any, {
    search: async () => ({ results: [] } as any),
    answer: async input => { system = input.system ?? ''; return { text: '一般说法', model: input.model ?? 'm', stopReason: 'end' } as any; },
  });
  const result = await answer({ model: 'm', knowledge: true, signal: new AbortController().signal, progress: () => {}, messages: [{ id: '1', role: 'user', text: '库里没有的问题', status: 'complete', createdAt: '' }] });
  expect(system).toContain('本轮没有检索到相关资料');
  expect(result.knowledge).toBe('none');
  const service = new WorkbenchService(new WorkbenchStore(root()), () => [{ id: 'ollama:local', name: '本地' }], async () => result);
  const thread = service.create({ knowledge: true });
  service.send(thread.id, { text: '库里没有的问题' });
  await service.settled(thread.id);
  expect(service.get(thread.id).messages.at(-1)?.knowledge).toBe('none');
});

test('对话变长后，更早的轮次压缩成摘要并继续发给模型，而不是直接丢掉', async () => {
  const seen: Array<{ messages: string[]; summary?: string }> = [];
  const summaries: Array<{ prior: string; transcript: string }> = [];
  const service = new WorkbenchService(new WorkbenchStore(root()), () => [{ id: 'ollama:local', name: '本地' }], async input => {
    seen.push({ messages: input.messages.map(message => message.text), summary: input.summary });
    return { text: '好', model: 'ollama:local', citations: [], knowledge: 'off', stopReason: 'end' };
  }, async ({ prior, transcript }) => {
    summaries.push({ prior, transcript });
    return `摘要:${prior}|${transcript}`;
  });
  const thread = service.create({ model: 'ollama:local', knowledge: false });
  const seeded = service.get(thread.id);
  const now = new Date().toISOString();
  for (let i = 0; i < 30; i++) {
    seeded.messages.push({ id: `user-${i}`, role: 'user', text: `问题${i}`, createdAt: now, status: 'complete' });
    seeded.messages.push({ id: `assistant-${i}`, role: 'assistant', text: `回答${i}`, createdAt: now, status: 'complete' });
  }
  (service as unknown as { store: WorkbenchStore }).store.save(seeded);
  expect(conversationContext(service.get(thread.id).messages).length).toBe(60);
  service.send(thread.id, { text: '最新问题' });
  await service.settled(thread.id);
  expect(seen[0]?.messages.length).toBeLessThanOrEqual(24);
  expect(seen[0]?.messages).not.toContain('问题0');
  expect(seen[0]?.summary).toContain('问题0');
  expect(service.get(thread.id).messages.at(-1)?.contextNote).toContain('压缩');
  const firstTranscript = summaries[0]?.transcript ?? '';
  expect(firstTranscript).toContain('问题0');
  service.send(thread.id, { text: '又一个问题' });
  await service.settled(thread.id);
  expect(summaries.length).toBeGreaterThan(1);
  expect(summaries[1]?.prior).toContain('问题0');
  expect(summaries[1]?.transcript).not.toContain('问题0');
  expect((summaries[1]?.transcript.length ?? 0)).toBeLessThan(firstTranscript.length);
  expect(seen[1]?.messages.length).toBeLessThanOrEqual(24);
});

test('摘要失败时停止回答并保留历史与摘要进度', async () => {
  const seen: Array<{ messages: string[]; summary?: string }> = [];
  const service = new WorkbenchService(new WorkbenchStore(root()), () => [{ id: 'ollama:local', name: '本地' }], async input => {
    seen.push({ messages: input.messages.map(message => message.text), summary: input.summary });
    return { text: '好', model: 'ollama:local', citations: [] };
  }, async () => { throw new Error('摘要失败'); });
  const thread = service.create({ knowledge: false });
  const seeded = service.get(thread.id);
  const now = new Date().toISOString();
  for (let i = 0; i < 30; i++) {
    seeded.messages.push({ id: `user-${i}`, role: 'user', text: `问题${i}`, createdAt: now, status: 'complete' });
    seeded.messages.push({ id: `assistant-${i}`, role: 'assistant', text: `回答${i}`, createdAt: now, status: 'complete' });
  }
  (service as unknown as { store: WorkbenchStore }).store.save(seeded);
  service.send(thread.id, { text: '最新问题' });
  await service.settled(thread.id);
  expect(seen).toHaveLength(0);
  expect(service.get(thread.id).messages.at(-1)?.error).toContain('摘要失败');
  expect(service.get(thread.id).summaryUntil).toBeUndefined();
  expect(service.get(thread.id).messages[0].text).toBe('问题0');
});

test('摘要失败后重试不会跳过待摘要内容，长消息末尾也参与摘要', async () => {
  const store = new WorkbenchStore(root()); let failing = true; const transcripts: string[] = [];
  const service = new WorkbenchService(store, () => [{ id: 'local', name: '本地' }], async () => ({ text: '好', model: 'local', citations: [] }), async input => {
    transcripts.push(input.transcript);
    if (failing) throw new Error('摘要暂时失败');
    return '包含末尾决定的摘要';
  });
  const thread = service.create({ knowledge: false });
  thread.summary = '旧'.repeat(6000); thread.summaryUntil = 'a0';
  for (let i = 0; i < 20; i++) thread.messages.push(
    { id: `u${i}`, role: 'user', text: i === 5 ? '长'.repeat(10000) + '末尾关键决定' : `问题${i}`, status: 'complete', createdAt: '' },
    { id: `a${i}`, role: 'assistant', text: `回答${i}`, status: 'complete', createdAt: '' },
  );
  store.save(thread); service.send(thread.id, { text: '继续' }); await service.settled(thread.id);
  expect(store.get(thread.id).summaryUntil).toBe('a0');
  expect(store.get(thread.id).summary).toBe(thread.summary);
  failing = false; transcripts.length = 0;
  service.send(thread.id, { retry: true }); await service.settled(thread.id);
  expect(transcripts.join('')).toContain('末尾关键决定');
  expect(store.get(thread.id).messages.at(-1)?.status).toBe('complete');
});

test('自动清理只允许删除空会话', async () => {
  const service = new WorkbenchService(new WorkbenchStore(root()), () => [{ id: 'local', name: '本地' }], async () => ({ text: '好', model: 'local', citations: [] }));
  const empty = service.create({}); service.remove(empty.id, true); expect(() => service.get(empty.id)).toThrow();
  const used = service.create({}); service.send(used.id, { text: '保留' }); await service.settled(used.id);
  expect(() => service.remove(used.id, true)).toThrow(); expect(service.get(used.id).messages).toHaveLength(2);
});

test('续写切换模型时替换当前段，保留前一段及停止时的有效文字', async () => {
  let calls = 0; let visible = ''; const replacements: string[] = [];
  const answer = knowledgeWorkbenchAnswer({} as any, {
    search: async () => ({ results: [] } as any),
    answer: async input => {
      if (++calls === 1) { input.onTextDelta?.('完整首段'); return { text: '完整首段', model: 'first', stopReason: 'length' } as any; }
      input.onTextDelta?.('失败段'); input.onTextReset?.('second'); input.onTextDelta?.('有效续写');
      return { text: '有效续写', model: 'second', stopReason: 'end' } as any;
    },
  });
  const result = await answer({ model: 'first', knowledge: false, messages: [], signal: new AbortController().signal, progress: () => {}, onDelta: text => { visible += text; }, onReplace: text => { visible = text; replacements.push(text); } });
  expect(replacements).toEqual(['完整首段']); expect(visible).toBe('完整首段有效续写'); expect(result.text).toBe(visible);
  const service = new WorkbenchService(new WorkbenchStore(root()), () => [{ id: 'first', name: '一' }, { id: 'second', name: '二' }], async input => {
    input.onDelta?.('失败段'); input.onReplace?.('有效段', 'second');
    service.cancel(thread.id);
    return { text: '迟到内容', model: 'second', citations: [] };
  });
  const thread = service.create({}); service.send(thread.id, { text: '问题' }); await service.settled(thread.id);
  const reply = service.get(thread.id).messages.at(-1);
  expect(reply?.text).toBe('有效段'); expect(reply?.modelName).toBe('二'); expect(reply?.status).toBe('cancelled');
});

test('模型因为长度停下时会自动续写，检索只做一次', async () => {
  const sent: any[] = [];
  let searches = 0;
  const answer = knowledgeWorkbenchAnswer({} as any, {
    search: async () => { searches++; return { results: [] } as any; },
    answer: async input => {
      sent.push(input);
      const text = sent.length === 1 ? '甲' : '乙';
      input.onTextDelta?.(text);
      return { text, model: input.model, stopReason: sent.length === 1 ? 'length' : 'end' } as any;
    },
  });
  const deltas: string[] = [];
  const result = await answer({ model: 'm', knowledge: true, signal: new AbortController().signal, progress: () => {}, onDelta: delta => deltas.push(delta), messages: [{ id: '1', role: 'user', text: '写长一点', status: 'complete', createdAt: '' }] });
  expect(searches).toBe(1);
  expect(sent).toHaveLength(2);
  expect(result.text).toBe('甲乙');
  expect(result.knowledge).toBe('none');
  expect(result.stopReason).toBe('end');
  expect(deltas).toEqual(['甲', '乙']);
  expect(sent[1].messages.at(-2).content).toBe('甲');
  expect(sent[1].messages.at(-1).content).toContain('接着写完');
  expect(sent[1].system).toContain('本轮没有检索到相关资料');
});

test('续写遇到空内容或非长度停止时不再循环，连续八次长度上限会停下来', async () => {
  const empty = knowledgeWorkbenchAnswer({} as any, {
    search: async () => { throw new Error('不应检索'); },
    answer: async input => ({ text: input.messages.some((message: any) => message.content === '请从中断处接着写完，不要重复已经写过的内容。') ? '' : '甲', model: 'm', stopReason: 'length' }) as any,
  });
  const stopped = await empty({ model: 'm', knowledge: false, signal: new AbortController().signal, progress: () => {}, messages: [{ id: '1', role: 'user', text: '写', status: 'complete', createdAt: '' }] });
  expect(stopped.text).toBe('甲');
  expect(stopped.stopReason).toBe('end');
  let calls = 0;
  const capped = knowledgeWorkbenchAnswer({} as any, {
    search: async () => ({ results: [] } as any),
    answer: async input => { calls++; input.onTextDelta?.(String(calls)); return { text: String(calls), model: input.model, stopReason: 'length' } as any; },
  });
  const limited = await capped({ model: 'm', knowledge: true, signal: new AbortController().signal, progress: () => {}, messages: [{ id: '1', role: 'user', text: '一直写', status: 'complete', createdAt: '' }] });
  expect(calls).toBe(8);
  expect(limited.text).toBe('12345678');
  expect(limited.stopReason).toBe('length');
  let otherCalls = 0;
  const other = knowledgeWorkbenchAnswer({} as any, {
    search: async () => ({ results: [] } as any),
    answer: async () => { otherCalls++; return { text: '完', model: 'm', stopReason: 'other' } as any; },
  });
  const finished = await other({ model: 'm', knowledge: false, signal: new AbortController().signal, progress: () => {}, messages: [{ id: '1', role: 'user', text: '短答', status: 'complete', createdAt: '' }] });
  expect(otherCalls).toBe(1);
  expect(finished.text).toBe('完');
  expect(finished.knowledge).toBe('off');
});

test('知识检索带上最近几轮问题，并把更早摘要交给模型', async () => {
  let query = '';
  let system = '';
  const long = '预算'.repeat(300);
  const answer = knowledgeWorkbenchAnswer({} as any, {
    search: async (_engine, input) => { query = input.query; return { results: [] } as any; },
    answer: async input => { system = input.system ?? ''; return { text: '好', model: input.model ?? 'm', stopReason: 'end' } as any; },
  });
  await answer({
    model: 'm', knowledge: true, summary: '之前决定用蓝色', signal: new AbortController().signal, progress: () => {},
    messages: [
      { id: '1', role: 'user', text: '最早的独特问题', status: 'complete', createdAt: '' },
      { id: '2', role: 'assistant', text: '好', status: 'complete', createdAt: '' },
      { id: '3', role: 'user', text: '第二', status: 'complete', createdAt: '' },
      { id: '4', role: 'assistant', text: '好', status: 'complete', createdAt: '' },
      { id: '5', role: 'user', text: '第三', status: 'complete', createdAt: '' },
      { id: '6', role: 'assistant', text: '好', status: 'complete', createdAt: '' },
      { id: '7', role: 'user', text: '第四', status: 'complete', createdAt: '' },
      { id: '8', role: 'assistant', text: '好', status: 'complete', createdAt: '' },
      { id: '9', role: 'user', text: long, status: 'complete', createdAt: '' },
    ],
  });
  expect(query).toContain('第二');
  expect(query).toContain('第四');
  expect(query).not.toContain('最早的独特问题');
  expect(query).toContain(long.slice(0, 500));
  expect(query).not.toContain(long);
  expect(system).toContain('之前决定用蓝色');
  expect(system).toContain('不要向用户复述');
});

test('会话超过 200 轮仍然可以继续', async () => {
  const store = new WorkbenchStore(root());
  const service = new WorkbenchService(store, () => [{ id: 'local', name: '本地' }], async () => ({ text: '还在', model: 'local', citations: [] }), async () => '早期摘要');
  const thread = service.create({ knowledge: false });
  const now = new Date().toISOString();
  for (let i = 0; i < 210; i++) {
    thread.messages.push({ id: `u${i}`, role: 'user', text: `问${i}`, status: 'complete', createdAt: now });
    thread.messages.push({ id: `a${i}`, role: 'assistant', text: `答${i}`, status: 'complete', createdAt: now });
  }
  store.save(thread);
  service.send(thread.id, { text: '还在继续' });
  await service.settled(thread.id);
  const reply = service.get(thread.id).messages.at(-1);
  expect(reply?.status).toBe('complete');
  expect(reply?.error).toBeUndefined();
  expect(reply?.text).toBe('还在');
});

test('接近模型上下文窗口的 80% 时就压缩，不必等到 24 条', async () => {
  const seen: string[][] = [];
  const store = new WorkbenchStore(root());
  const service = new WorkbenchService(store, () => [{ id: 'local', name: '本地', contextWindow: 8192 }], async input => {
    seen.push(input.messages.map(message => message.text));
    return { text: '好', model: 'local', citations: [] };
  }, async () => '已压缩早期内容');
  store.saveAssistant({ ...defaultAssistant(), context: { maxMessages: 100, threshold: 0.8, summaryModel: '' } });
  const thread = service.create({ knowledge: false });
  const chunk = '资'.repeat(3000);
  for (let i = 0; i < 4; i++) {
    thread.messages.push({ id: `u${i}`, role: 'user', text: `${i}:${chunk}`, status: 'complete', createdAt: '' });
    thread.messages.push({ id: `a${i}`, role: 'assistant', text: `答${i}`, status: 'complete', createdAt: '' });
  }
  store.save(thread);
  service.send(thread.id, { text: '最新' });
  await service.settled(thread.id);
  expect(seen[0]?.length ?? 99).toBeLessThan(8);
  expect(seen[0]?.join('') ?? '').not.toContain('0:');
  expect(seen[0]?.at(-1)).toBe('最新');
  expect(service.get(thread.id).summary).toContain('已压缩');
});

test('助手可以单独指定摘要模型，系统提示词和温度会传给回答', async () => {
  let summaryModel = '';
  let answerInput: { systemPrompt?: string; temperature?: number; messages: Array<{ text: string }> } | undefined;
  const store = new WorkbenchStore(root());
  const service = new WorkbenchService(store, () => [{ id: 'chat', name: '对话' }, { id: 'summary', name: '摘要' }], async input => {
    answerInput = input;
    return { text: '好', model: 'chat', citations: [] };
  }, async input => { summaryModel = input.model; return '摘要完成'; });
  store.saveAssistant({ ...defaultAssistant(), systemPrompt: '只回答项目事实', temperature: 0.2, context: { maxMessages: 2, threshold: 0.8, summaryModel: 'summary' } });
  const thread = service.create({ knowledge: false, model: 'chat' });
  const now = new Date().toISOString();
  thread.messages.push({ id: 'u0', role: 'user', text: '早期问题', status: 'complete', createdAt: now }, { id: 'a0', role: 'assistant', text: '早期回答', status: 'complete', createdAt: now });
  store.save(thread);
  service.send(thread.id, { text: '现在', model: 'chat' });
  await service.settled(thread.id);
  expect(summaryModel).toBe('summary');
  expect(answerInput?.systemPrompt).toBe('只回答项目事实');
  expect(answerInput?.temperature).toBe(0.2);
  expect(answerInput?.messages.map(message => message.text)).toEqual(['现在']);
});

test('自定义系统提示词和温度会交给模型，留空时仍用知识库助手提示', async () => {
  const seen: Array<{ system?: string; temperature?: number }> = [];
  const answer = knowledgeWorkbenchAnswer({} as any, {
    search: async () => ({ results: [] } as any),
    answer: async input => { seen.push({ system: input.system, temperature: input.temperature }); return { text: '好', model: 'm', stopReason: 'end' } as any; },
  });
  const signal = new AbortController().signal;
  await answer({ model: 'm', knowledge: false, systemPrompt: '只回答项目事实', temperature: 0.2, signal, progress: () => {}, messages: [{ id: '1', role: 'user', text: '问', status: 'complete', createdAt: '' }] });
  await answer({ model: 'm', knowledge: false, signal, progress: () => {}, messages: [{ id: '1', role: 'user', text: '问', status: 'complete', createdAt: '' }] });
  expect(seen[0]?.system?.startsWith('只回答项目事实')).toBe(true);
  expect(seen[0]?.temperature).toBe(0.2);
  expect(seen[1]?.system).toContain('知识工作台助手');
  expect(seen[1]?.temperature).toBeUndefined();
});
