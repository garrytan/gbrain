import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { __setChatTransportForTests, configureGateway, resetGateway, toolLoop, type ChatResult } from '../src/core/ai/gateway';
import { advanceStoredReads, namedAttachmentSupplement, summarySource, taskRecognizedSupplement, taskVisualAttachments } from '../src/product/workbench/attachments';
import { WorkbenchAgentStore } from '../src/product/workbench/agents';
import { compileTaskBrief, retrievalQuery } from '../src/product/workbench/task-context';
import { knowledgeWorkbenchAnswer } from '../src/product/workbench/routes';
import { revisionListing, WorkbenchService, type WorkbenchAnswerInput } from '../src/product/workbench/service';
import { WorkbenchStore } from '../src/product/workbench/store';
import { EVIDENCE_GAP_TEXT } from '../src/product/workbench/playbook';
import type { WorkbenchMessage, WorkbenchToolCall } from '../shared/workbench';
import type { WorkbenchArtifact } from '../shared/workbench-agents';

const root = () => mkdtempSync(join(tmpdir(), 'pmbrain-context-projection-'));
const now = () => new Date().toISOString();
const models = () => [{ id: 'local', name: '本地', contextWindow: 8192 }];
const reply = (text = '好') => ({ text, model: 'local', citations: [] as Array<{ sourceId: string; slug: string; title: string; snippet: string }> });
afterEach(() => { __setChatTransportForTests(null); resetGateway(); });

test('任务摘要留下目标、限制、决定、未决和来源；改规则后旧摘要失效，原话还在', async () => {
  const dir = root();
  const store = new WorkbenchStore(dir);
  let seenSummary: string | undefined;
  const service = new WorkbenchService(store, models, async input => { seenSummary = input.summary; return reply(); });
  const agent = new WorkbenchAgentStore(store).create({ name: '周报助手', workflow: '先查知识库', skills: ['weekly-report'], standingRules: ['风险要写完整'], systemPrompt: '你是周报助手' });
  const conversation = service.create({ assistantId: agent.id, knowledge: false });
  service.send(conversation.id, { text: '生成本周周报' });
  await service.settled(conversation.id);
  service.send(conversation.id, { text: '这次不要写下周计划' });
  await service.settled(conversation.id);
  const seeded = service.get(conversation.id);
  seeded.summary = '旧摘要标记：标题用蓝色';
  seeded.summaryUntil = seeded.messages[0]!.id;
  seeded.summaryAssistantRevision = new WorkbenchAgentStore(store).get(agent.id).revision;
  store.save(seeded);
  service.send(conversation.id, { text: '你好' });
  await service.settled(conversation.id);
  expect(seenSummary).toContain('旧摘要标记');
  expect(service.get(conversation.id).messages.some(message => message.text === '生成本周周报')).toBe(true);
  seenSummary = undefined;
  service.send(conversation.id, { text: '风险不要写那么多' });
  await service.settled(conversation.id);
  const saved = service.get(conversation.id);
  expect(seenSummary ?? '').not.toContain('旧摘要标记');
  expect(saved.summary ?? '').not.toContain('旧摘要标记');
  expect(saved.messages.some(message => message.text === '生成本周周报')).toBe(true);
  expect(saved.messages.some(message => message.text === '这次不要写下周计划')).toBe(true);
  expect(saved.task?.goal).toContain('生成本周周报');
  expect(saved.task?.constraints).toEqual(['这次不要写下周计划']);
  expect(saved.task?.decisions).toContain('风险不要写那么多');
  expect(saved.task?.sources?.some(item => item.note === '提出任务' || item.note === '这次不要写下周计划')).toBe(true);
  expect(JSON.stringify(saved)).not.toContain('<task_brief>');
  const brief = compileTaskBrief(saved.task, true);
  expect(brief).toContain('目标：');
  expect(brief).toContain('这次的限制：这次不要写下周计划');
  expect(brief).toContain('已决定：风险不要写那么多');
  expect(brief).toContain('权威低于用户原话、当前规则和本期引用');
  expect(brief).toContain('不是本期工作事实');
  const pair = saved.messages.filter(message => message.text === '风险不要写那么多' || message.ruleNotice);
  expect(pair.some(message => message.turnId && message.text !== message.turnId)).toBe(true);
  expect(saved.messages.at(-1)?.contextManifest?.turnId).toBe(saved.messages.at(-1)?.turnId);

  const evidenceDir = root();
  const evidenceStore = new WorkbenchStore(evidenceDir);
  let turn = 0;
  const evidence = new WorkbenchService(evidenceStore, models, async input => {
    turn += 1;
    if (turn === 1) return reply('# 完整周报');
    const artifact: WorkbenchArtifact = { id: randomUUID(), agentId: input.agent?.id ?? 'main', conversationId: input.conversationId ?? '', messageId: input.messageId ?? '', title: '本周周报', format: 'markdown', path: join(evidenceDir, 'unused.md'), publishedPath: '资料/本周周报.md', content: '完成', citations: [], createdAt: now(), hash: 'a'.repeat(64) };
    new WorkbenchAgentStore(evidenceStore).recordArtifact(artifact);
    return { text: '本周完成了甲 [1]', model: 'local', citations: [{ sourceId: 'default', slug: 'weekly', title: '本周记录', snippet: '甲' }] };
  });
  const weekly = new WorkbenchAgentStore(evidenceStore).create({ name: '周报助手', workflow: '先查知识库', skills: ['weekly-report'], systemPrompt: '你是周报助手' });
  const report = evidence.create({ assistantId: weekly.id, knowledge: true });
  evidence.send(report.id, { text: '生成本周周报' });
  await evidence.settled(report.id);
  const gap = evidence.get(report.id);
  expect(gap.messages.at(-1)?.text).toBe(EVIDENCE_GAP_TEXT);
  expect(gap.task?.openItems).toContain('本期材料还没齐');
  evidence.send(report.id, { text: '继续' });
  await evidence.settled(report.id);
  const filled = evidence.get(report.id);
  expect(filled.messages.at(-1)?.text).toBe('本周完成了甲 [1]');
  expect(filled.task?.openItems ?? []).not.toContain('本期材料还没齐');
  expect(filled.task?.deliveries).toContain('资料/本周周报.md');
  expect(filled.task?.id).toBe(gap.task?.id);
});

test('旧图片在窗口外仍按原图重新带上，点名附件可以再读，单独的继续不推进文字游标', async () => {
  const older = '预算说明.txt';
  const image = 'shot.png';
  const preview = 'data:image/png;base64,aaaa';
  const file: WorkbenchMessage = { id: 'file', role: 'user', text: '先看附件', createdAt: '', status: 'complete', attachments: [{ id: randomUUID(), name: older, mime: 'text/plain', route: 'utf8', included: 12, text: '金额是 8800。后面还有很多字。' }] };
  const picture: WorkbenchMessage = { id: 'picture', role: 'user', text: '先看截图', createdAt: '', status: 'complete', attachments: [{ id: randomUUID(), name: image, mime: 'image/png', route: 'vision', included: 0, preview }] };
  const filler: WorkbenchMessage[] = [];
  for (let index = 0; index < 30; index += 1) filler.push({ id: `u${index}`, role: 'user', text: `问${index}`, createdAt: '', status: 'complete' }, { id: `a${index}`, role: 'assistant', text: `答${index}`, createdAt: '', status: 'complete' });
  const recent = new Set(filler.slice(-24).map(message => message.id));
  const visuals = taskVisualAttachments([file, picture, ...filler], { goal: '看截图', sources: [{ messageId: 'picture', note: '提出任务' }] }, recent);
  expect(visuals.kept.map(item => item.name)).toEqual([image]);
  expect(visuals.kept[0]?.image).toBe(preview);
  expect(summarySource(picture)).toContain('图片仍保存在这条消息上');
  const excerpt = namedAttachmentSupplement([file, picture, ...filler], `请再看${older}`, recent);
  expect(excerpt).toContain('金额是 8800');
  expect(file.attachments?.[0]?.readThrough).toBeUndefined();
  expect(advanceStoredReads([file, { id: 'next', role: 'user', text: '继续', createdAt: '', status: 'complete' }], '继续')).toEqual([]);
  expect(file.attachments?.[0]?.readThrough).toBeUndefined();
  const many = Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, role: 'user' as const, text: '', createdAt: '', status: 'complete' as const, attachments: [{ id: randomUUID(), name: `p${index}.png`, mime: 'image/png', route: 'vision' as const, included: 0, preview: `data:image/png;base64,${index}` }] }));
  const capped = taskVisualAttachments(many, { goal: '看图', sources: many.map(message => ({ messageId: message.id, note: '提出任务' })) }, new Set());
  expect(capped.kept).toHaveLength(4);
  expect(capped.omitted).toHaveLength(1);

  const dir = root();
  const store = new WorkbenchStore(dir);
  let seen: WorkbenchAnswerInput['visualAttachments'];
  let supplement = '';
  const service = new WorkbenchService(store, () => [{ id: 'local', name: '本地', contextWindow: 32000, vision: true }], async input => {
    seen = input.visualAttachments;
    supplement = [...input.messages].reverse().find(message => message.role === 'user')?.attachmentSupplement ?? '';
    return reply('看到了');
  }, async () => '早期摘要');
  const agent = new WorkbenchAgentStore(store).create({ name: '周报助手', workflow: '先查知识库', skills: ['weekly-report'], systemPrompt: '你是周报助手' });
  const conversation = service.create({ assistantId: agent.id, knowledge: false });
  const saved = service.get(conversation.id);
  const stamp = now();
  saved.messages = [
    { ...file, createdAt: stamp },
    { ...picture, createdAt: stamp },
    ...filler.map(message => ({ ...message, createdAt: stamp })),
  ];
  saved.task = { id: 'task-visual', goal: '看截图', constraints: [], updatedAt: stamp, sources: [{ messageId: 'picture', note: '提出任务' }] };
  store.save(saved);
  service.send(conversation.id, { text: `请再看${older}` });
  await service.settled(conversation.id);
  expect(seen?.map(item => item.name)).toEqual([image]);
  expect(seen?.[0]?.image).toBe(preview);
  expect(supplement).toContain('金额是 8800');
  expect(service.get(conversation.id).messages.find(message => message.id === 'file')?.attachments?.[0]?.readThrough).toBeUndefined();
  const packed: string[] = [];
  const answer = knowledgeWorkbenchAnswer({} as never, { search: async () => { throw new Error('不应检索'); }, answer: async input => { packed.push(JSON.stringify(input.messages)); return { text: '看到了', model: 'm', stopReason: 'end' } as never; } });
  await answer({ model: 'm', knowledge: false, signal: new AbortController().signal, progress: () => {}, contextWindow: 32000, task: saved.task, visualAttachments: seen, messages: [{ id: 'latest', role: 'user', text: '继续', status: 'complete', createdAt: '' }] });
  expect(packed.join('\n')).toContain(preview);
  expect(packed.join('\n')).toContain('这些图片来自当前任务里已经发送的附件，按原图重新读取，不是新文件。');
});

test('有当前任务时按目标和这句话检索，不把更早无关的句子拼进去', async () => {
  const goal = '生成本周周报';
  const messages = [
    { role: 'user' as const, text: '香蕉的采购数量', attachments: [] },
    { role: 'assistant' as const, text: '好', attachments: [] },
    { role: 'user' as const, text: '继续', attachments: [] },
  ];
  expect(retrievalQuery(messages, { goal })).toBe(goal);
  expect(retrievalQuery(messages, { goal })).not.toContain('香蕉');
  const focused = retrievalQuery([...messages, { role: 'user', text: '把风险写进本周问题', attachments: [] }], { goal });
  expect(focused).toContain(goal);
  expect(focused).toContain('把风险写进本周问题');
  expect(focused).not.toContain('香蕉');
  const remembered = retrievalQuery([{ role: 'user', text: '第二' }, { role: 'user', text: '第四' }]);
  expect(remembered).toContain('第二');
  expect(remembered).toContain('第四');
  let query = '';
  let searched = 0;
  let system = '';
  const answer = knowledgeWorkbenchAnswer({} as never, {
    search: async (_engine, input) => { searched += 1; query = input.query; return { results: [] } as never; },
    recall: async () => [{ sourceId: 'default', slug: 'pref', title: '偏好短句', snippet: '喜欢短句', kind: 'memory' as const, factId: 1 }],
    answer: async input => { system = input.system ?? ''; return { text: '好', model: 'm', stopReason: 'end' } as never; },
  });
  await answer({
    model: 'm', knowledge: true, sourceId: 'default', signal: new AbortController().signal, progress: () => {}, contextWindow: 8192,
    task: { id: 'task-search', goal, constraints: ['这次不要写下周计划'], updatedAt: '', sources: [{ messageId: 'u', note: '提出任务' }] },
    messages: [
      { id: 'old', role: 'user', text: '香蕉的采购数量', status: 'complete', createdAt: '' },
      { id: 'a', role: 'assistant', text: '好', status: 'complete', createdAt: '' },
      { id: 'u', role: 'user', text: '继续', status: 'complete', createdAt: '' },
    ],
  });
  expect(query).toBe(goal);
  expect(query).not.toContain('香蕉');
  expect(system).toContain('<task_brief>');
  expect(system).toContain('这次不要写下周计划');
  expect(system).toContain('不是本期工作事实');
  searched = 0;
  await answer({
    model: 'm', knowledge: false, sourceId: 'default', signal: new AbortController().signal, progress: () => {}, contextWindow: 8192,
    task: { id: 'task-pref', goal: '整理附件', constraints: [], updatedAt: '' },
    messages: [{ id: 'u2', role: 'user', text: '继续', status: 'complete', createdAt: '' }],
  });
  expect(searched).toBe(0);
  expect(system).toContain('不是知识库里的本期资料');
  expect(system).toContain('喜欢短句');
  expect(system).toContain('<task_brief>');
});

test('服务中断只是恢复已保存的半截回答，已完成的工具重试时不再执行；附件读失败会退回刚记下的规则', async () => {
  const dir = root();
  const store = new WorkbenchStore(dir);
  const stamp = now();
  const id = randomUUID();
  store.save({
    id, title: '新对话', model: 'local', knowledge: false, createdAt: stamp, updatedAt: stamp,
    messages: [
      { id: 'user', role: 'user', text: '写到一半', createdAt: stamp, status: 'complete' },
      { id: 'assistant', role: 'assistant', text: '已生成正文', createdAt: stamp, status: 'running', toolCalls: [
        { id: 'done', name: 'knowledge_search', input: JSON.stringify({ query: '预算' }), status: 'complete', output: JSON.stringify({ results: [], truncated: false }), startedAt: stamp, completedAt: stamp },
        { id: 'running', name: 'knowledge_read', input: '{}', status: 'running', startedAt: stamp },
      ] },
    ],
  });
  const recovered = new WorkbenchService(store, models, async () => reply()).get(id).messages[1]!;
  expect(recovered.error).toContain('中断');
  expect(recovered.error).toContain('模型没有接着写');
  expect(recovered.errorCode).toBe('service_interrupted');
  expect(recovered.text).toBe('已生成正文');
  expect(recovered.toolCalls?.[0]?.status).toBe('complete');
  expect(recovered.toolCalls?.[1]?.status).toBe('error');

  let settled: WorkbenchToolCall[] | undefined;
  const service = new WorkbenchService(new WorkbenchStore(dir), models, async input => { settled = input.settledTools; return reply('重写'); });
  const agent = new WorkbenchAgentStore(new WorkbenchStore(dir)).create({ name: '周报助手', workflow: '先查知识库', skills: ['weekly-report'], systemPrompt: '你是周报助手' });
  const conversation = service.create({ assistantId: agent.id, knowledge: false });
  service.send(conversation.id, { text: '生成本周周报' });
  await service.settled(conversation.id);
  const finished = service.get(conversation.id);
  finished.messages.at(-1)!.toolCalls = [{ id: 'done', name: 'knowledge_search', input: JSON.stringify({ query: '预算' }), status: 'complete', output: JSON.stringify({ results: [], truncated: false }), startedAt: stamp, completedAt: stamp }];
  new WorkbenchStore(dir).save(finished);
  service.send(conversation.id, { text: '', retry: true });
  await service.settled(conversation.id);
  expect(settled?.map(call => call.name)).toEqual(['knowledge_search']);
  expect(service.get(conversation.id).revisions?.some(item => item.reason === 'retry' && item.preview)).toBe(true);
  expect(service.get(conversation.id).messages.at(-1)?.turnId).not.toBe(finished.messages.at(-1)?.turnId);

  configureGateway({ generative_enabled: true, chat_model: 'service-test:chat', env: {} });
  const usage = { input_tokens: 10, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 };
  const text = (value: string): ChatResult => ({ text: value, blocks: [{ type: 'text', text: value }], model: 'service-test:chat', providerId: 'service-test', stopReason: 'end', usage });
  const call = (name: string, input: unknown, callId = 'call'): ChatResult => ({ ...text(''), blocks: [{ type: 'tool-call', toolName: name, input, toolCallId: callId }], stopReason: 'tool_calls' });
  const settledTools: WorkbenchToolCall[] = [{ id: 'old', name: 'knowledge_search', input: JSON.stringify({ query: '预算' }), status: 'complete', output: JSON.stringify({ results: [], truncated: false }), startedAt: stamp, completedAt: stamp }];
  let misses = 0;
  let requests = 0;
  __setChatTransportForTests(async () => { requests += 1; return requests === 1 ? call('knowledge_search', { query: '预算' }, 't1') : text('核对完成'); });
  const replayed = knowledgeWorkbenchAnswer({} as never, {
    search: async (_engine, input) => { if (input.query === '预算') { misses += 1; throw new Error('不应再次搜索'); } return { results: [] } as never; },
    answer: async () => { throw new Error('不应直接回答'); },
    loop: toolLoop,
  });
  const first = await replayed({ model: 'service-test:chat', knowledge: true, signal: new AbortController().signal, progress: () => {}, contextWindow: 8192, settledTools, messages: [{ id: 'q', role: 'user', text: '请核对项目预算表', status: 'complete', createdAt: '' }] });
  expect(misses).toBe(0);
  expect(first.text).toBe('核对完成');
  requests = 0;
  let others = 0;
  __setChatTransportForTests(async () => { requests += 1; return requests === 1 ? call('knowledge_search', { query: '其他' }, 't2') : text('另查完成'); });
  const changed = knowledgeWorkbenchAnswer({} as never, {
    search: async (_engine, input) => { if (input.query === '其他') { others += 1; return { results: [] } as never; } if (input.query === '预算') throw new Error('不应再次搜索'); return { results: [] } as never; },
    answer: async () => { throw new Error('不应直接回答'); },
    loop: toolLoop,
  });
  const second = await changed({ model: 'service-test:chat', knowledge: true, signal: new AbortController().signal, progress: () => {}, contextWindow: 8192, settledTools, messages: [{ id: 'q2', role: 'user', text: '请核对另一份清单', status: 'complete', createdAt: '' }] });
  expect(others).toBe(1);
  expect(second.text).toBe('另查完成');

  const failedDir = root();
  const failedStore = new WorkbenchStore(failedDir);
  const failed = new WorkbenchService(failedStore, models, async () => reply('不应留下'), undefined, { office: async () => { throw new Error('读取失败'); } });
  const profile = new WorkbenchAgentStore(failedStore).create({ name: '周报助手', workflow: '先查知识库', skills: ['weekly-report'], standingRules: ['风险要写完整'], systemPrompt: '你是周报助手' });
  const thread = failed.create({ assistantId: profile.id, knowledge: false });
  failed.send(thread.id, { text: '生成本周周报' });
  await failed.settled(thread.id);
  const before = new WorkbenchAgentStore(new WorkbenchStore(failedDir)).get(profile.id);
  failed.send(thread.id, { text: '风险不要写那么多', attachments: [{ name: 'a.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: Buffer.from('not a real docx').toString('base64') }] });
  await failed.settled(thread.id);
  const after = new WorkbenchAgentStore(new WorkbenchStore(failedDir)).get(profile.id);
  const kept = failed.get(thread.id);
  expect(kept.messages.some(message => message.text === '风险不要写那么多')).toBe(false);
  expect(kept.messages.some(message => message.text === '生成本周周报')).toBe(true);
  expect(kept.task?.decisions ?? []).not.toContain('风险不要写那么多');
  expect(after.standingRules).toEqual(['风险要写完整']);
  expect(after.revision).toBe(before.revision);
});

test('50、200、500 轮小窗口仍留全文，当前任务的限制还在', async () => {
  for (const rounds of [50, 200, 500]) {
    const dir = root();
    const store = new WorkbenchStore(dir);
    let windowSize = 0;
    let packed = '';
    let visuals: string[] = [];
    const priors: string[] = [];
    const service = new WorkbenchService(store, () => [{ id: 'local', name: '本地', contextWindow: 2048, vision: true }], async input => {
      windowSize = input.messages.length;
      packed = input.messages.map(message => `${message.text}\n${message.toolCalls?.map(call => call.output).join('\n') ?? ''}`).join('\n');
      visuals = (input.visualAttachments ?? []).map(item => item.image);
      return reply('继续好');
    }, async input => { priors.push(input.prior); return '新摘要'; });
    const agent = new WorkbenchAgentStore(store).create({ name: '周报助手', workflow: '先查知识库', skills: ['weekly-report'], standingRules: ['风险要写完整'], systemPrompt: '你是周报助手' });
    const conversation = service.create({ assistantId: agent.id, knowledge: false });
    const saved = service.get(conversation.id);
    const stamp = now();
    const marker = `长工具结果标记-${rounds}`;
    saved.messages = [
      { id: 'img', role: 'user', text: '先看截图', createdAt: stamp, status: 'complete', attachments: [{ id: randomUUID(), name: 'shot.png', mime: 'image/png', route: 'vision', included: 0, preview: `data:image/png;base64,${rounds}` }] },
      { id: 'tool', role: 'assistant', text: '看过了', createdAt: stamp, status: 'complete', toolCalls: [{ id: 'tool-1', name: 'knowledge_search', input: '{"query":"早期"}', status: 'complete', output: JSON.stringify({ marker }), startedAt: stamp, completedAt: stamp }] },
    ];
    for (let index = 0; index < rounds; index += 1) {
      saved.messages.push({ id: `u${index}`, role: 'user', text: index === 0 ? '问0早期独特句子' : `问${index}`, createdAt: stamp, status: 'complete' });
      saved.messages.push({ id: `a${index}`, role: 'assistant', text: `答${index}`, createdAt: stamp, status: 'complete' });
    }
    saved.task = { id: `task-${rounds}`, goal: '生成本周周报', constraints: ['这次不要写下周计划'], updatedAt: stamp, sources: [{ messageId: 'img', note: '提出任务' }] };
    saved.summary = '过期摘要标记';
    saved.summaryUntil = 'a0';
    saved.summaryAssistantRevision = new WorkbenchAgentStore(store).get(agent.id).revision;
    store.save(saved);
    service.send(conversation.id, { text: '继续' });
    await service.settled(conversation.id);
    const continued = service.get(conversation.id);
    expect(continued.messages.length).toBe(saved.messages.length + 2);
    expect(continued.messages.some(message => message.text === '问0早期独特句子')).toBe(true);
    expect(JSON.stringify(continued.messages)).toContain(marker);
    expect(packed).not.toContain(marker);
    expect(windowSize).toBeLessThanOrEqual(24);
    expect(visuals.some(item => item.includes(String(rounds)))).toBe(true);
    expect(continued.task?.id).toBe(`task-${rounds}`);
    expect(continued.task?.constraints).toEqual(['这次不要写下周计划']);
    expect(priors.some(item => item.includes('过期摘要标记'))).toBe(true);
    if (rounds === 50) {
      priors.length = 0;
      service.send(conversation.id, { text: '风险不要写那么多' });
      await service.settled(conversation.id);
      const corrected = service.get(conversation.id);
      expect(corrected.messages.some(message => message.text === '问0早期独特句子')).toBe(true);
      expect(corrected.task?.id).toBe(`task-${rounds}`);
      expect(corrected.task?.constraints).toEqual(['这次不要写下周计划']);
      expect(corrected.task?.decisions).toContain('风险不要写那么多');
      expect(new WorkbenchAgentStore(new WorkbenchStore(dir)).get(agent.id).standingRules).toEqual(['风险不要写那么多']);
      expect(priors.every(item => !item.includes('过期摘要标记'))).toBe(true);
    }
    const files = readdirSync(dir).filter(name => name.endsWith('.json') && name !== 'agents.json' && name !== 'assistant.json');
    expect(files).toEqual([`${conversation.id}.json`]);
    expect(existsSync(join(dir, `${conversation.id}.sqlite`))).toBe(false);
  }
}, 30000);

test('可以查看并恢复修改前的内容，当前稿也留在历史里；长对话仍是一份 JSON', async () => {
  const dir = root();
  const store = new WorkbenchStore(dir);
  const service = new WorkbenchService(store, models, async () => reply('答完'));
  const agent = new WorkbenchAgentStore(store).create({ name: '周报助手', workflow: '先查知识库', skills: ['weekly-report'], systemPrompt: '你是周报助手' });
  const conversation = service.create({ assistantId: agent.id, knowledge: false });
  service.send(conversation.id, { text: '第一版问题' });
  await service.settled(conversation.id);
  const first = service.get(conversation.id).messages.find(message => message.role === 'user')!;
  service.send(conversation.id, { text: '第二版问题', editMessageId: first.id });
  await service.settled(conversation.id);
  const edited = service.get(conversation.id);
  const previous = edited.revisions?.find(item => item.reason === 'edit');
  expect(previous?.preview).toContain('第一版');
  expect(previous?.messages.some(message => message.text === '第一版问题')).toBe(true);
  expect(edited.messages.some(message => message.text === '第二版问题')).toBe(true);
  const listing = revisionListing(edited);
  expect(listing[0]?.messages).toEqual([]);
  expect(listing[0]?.messageCount).toBeGreaterThan(0);
  expect(JSON.stringify(listing)).not.toContain('答完');
  service.restoreRevision(conversation.id, previous!.id);
  const restored = service.get(conversation.id);
  expect(restored.messages.some(message => message.text === '第一版问题')).toBe(true);
  expect(restored.messages.some(message => message.text === '第二版问题')).toBe(false);
  const back = restored.revisions?.find(item => item.reason === 'restore' && item.messages.some(message => message.text === '第二版问题'));
  expect(back?.preview).toContain('第二版');
  service.restoreRevision(conversation.id, back!.id);
  expect(service.get(conversation.id).messages.some(message => message.text === '第二版问题')).toBe(true);
  expect(service.get(conversation.id).revisions?.some(item => item.id === previous!.id)).toBe(true);

  const branched = service.get(conversation.id);
  const stamp = now();
  branched.task = { id: 'task-branch', goal: '第二版问题', constraints: [], updatedAt: stamp, sources: [{ messageId: branched.messages.find(message => message.text === '第二版问题')!.id, note: '提出任务' }] };
  branched.revisions = [
    ...Array.from({ length: 31 }, (_, index) => ({ id: `rev-${index}`, createdAt: stamp, reason: 'edit' as const, preview: `旧${index}`, messages: [{ id: `old-${index}`, role: 'user' as const, text: `历史${index}`, createdAt: stamp, status: 'complete' as const }] })),
    ...(branched.revisions ?? []),
  ];
  store.save(branched);
  service.restoreRevision(conversation.id, 'rev-0');
  const capped = service.get(conversation.id);
  expect(capped.messages.some(message => message.text === '历史0')).toBe(true);
  expect(capped.revisions?.length).toBeLessThanOrEqual(30);
  expect(capped.revisions?.some(item => item.id === 'rev-0')).toBe(true);
  expect(capped.revisions?.some(item => item.reason === 'restore')).toBe(true);
  expect(capped.task).toBeUndefined();
  expect(capped.summary).toBeUndefined();
  expect(() => service.restoreRevision(conversation.id, 'missing')).toThrow('这段历史不存在');

  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const busy = new WorkbenchService(new WorkbenchStore(dir), models, async () => { await gate; return reply('晚到'); });
  busy.send(conversation.id, { text: '正在写' });
  await busy.accepted(conversation.id);
  expect(() => busy.restoreRevision(conversation.id, 'rev-0')).toThrow('请先停止当前生成');
  release();
  await busy.settled(conversation.id);
  const files = readdirSync(dir).filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
  expect(files).toEqual([`${conversation.id}.json`]);
});

test('编辑第二轮后再恢复，前面的项目背景还在；恢复重新生成前也不会只剩一条回答', async () => {
  const dir = root();
  const store = new WorkbenchStore(dir);
  const service = new WorkbenchService(store, models, async () => reply('答完'));
  const agent = new WorkbenchAgentStore(store).create({ name: '周报助手', workflow: '先查知识库', skills: ['weekly-report'], systemPrompt: '你是周报助手' });
  const conversation = service.create({ assistantId: agent.id, knowledge: false });
  service.send(conversation.id, { text: '项目背景不能漏掉' });
  await service.settled(conversation.id);
  service.send(conversation.id, { text: '第二条旧问题' });
  await service.settled(conversation.id);
  const second = service.get(conversation.id).messages.filter(message => message.role === 'user')[1]!;
  service.send(conversation.id, { text: '第二条新问题', editMessageId: second.id });
  await service.settled(conversation.id);
  const edited = service.get(conversation.id);
  const previous = edited.revisions?.find(item => item.reason === 'edit');
  expect(previous?.messages.some(message => message.text === '第二条旧问题')).toBe(true);
  expect(previous?.messages.some(message => message.text === '项目背景不能漏掉')).toBe(false);
  const restored = service.restoreRevision(conversation.id, previous!.id);
  expect(restored.messages.some(message => message.text === '项目背景不能漏掉')).toBe(true);
  expect(restored.messages.some(message => message.text === '第二条旧问题')).toBe(true);
  expect(restored.messages.some(message => message.text === '第二条新问题')).toBe(false);
  const back = restored.revisions?.find(item => item.reason === 'restore' && item.messages.some(message => message.text === '第二条新问题'));
  service.restoreRevision(conversation.id, back!.id);
  expect(service.get(conversation.id).messages.some(message => message.text === '项目背景不能漏掉')).toBe(true);
  expect(service.get(conversation.id).messages.some(message => message.text === '第二条新问题')).toBe(true);
  service.restoreRevision(conversation.id, previous!.id);
  const again = service.get(conversation.id);
  expect(again.messages.some(message => message.text === '项目背景不能漏掉')).toBe(true);
  expect(again.messages.some(message => message.text === '第二条旧问题')).toBe(true);
  again.revisions = [...(again.revisions ?? []), { id: 'rev-missing-base', createdAt: now(), reason: 'edit', baseMessageId: 'gone', messages: [{ id: 'only-new', role: 'user', text: '不该替换全文', createdAt: now(), status: 'complete' }] }];
  store.save(again);
  const before = service.get(conversation.id).messages.map(message => message.text);
  expect(() => service.restoreRevision(conversation.id, 'rev-missing-base')).toThrow('这段历史的前文已经不在，不能安全恢复');
  expect(service.get(conversation.id).messages.map(message => message.text)).toEqual(before);

  const retryDir = root();
  const retryStore = new WorkbenchStore(retryDir);
  let turn = 0;
  const retryService = new WorkbenchService(retryStore, models, async () => reply(turn++ === 0 ? '第一遍回答' : '第二遍回答'));
  const retryAgent = new WorkbenchAgentStore(retryStore).create({ name: '周报助手', workflow: '先查知识库', skills: ['weekly-report'], systemPrompt: '你是周报助手' });
  const retry = retryService.create({ assistantId: retryAgent.id, knowledge: false });
  retryService.send(retry.id, { text: '请保留这个用户问题' });
  await retryService.settled(retry.id);
  retryService.send(retry.id, { retry: true });
  await retryService.settled(retry.id);
  const retryRevision = retryService.get(retry.id).revisions?.find(item => item.reason === 'retry');
  expect(retryRevision?.messages.every(message => message.role === 'assistant')).toBe(true);
  const restoredRetry = retryService.restoreRevision(retry.id, retryRevision!.id);
  expect(restoredRetry.messages[0]?.role).toBe('user');
  expect(restoredRetry.messages[0]?.text).toBe('请保留这个用户问题');
  expect(restoredRetry.messages.some(message => message.text === '第一遍回答')).toBe(true);
  expect(restoredRetry.messages.some(message => message.role === 'assistant')).toBe(true);
});

test('继续按刚才的要求做，仍是同一件任务，这次不要写下周计划还在', async () => {
  const dir = root();
  const store = new WorkbenchStore(dir);
  const service = new WorkbenchService(store, models, async () => reply('好'));
  const agent = new WorkbenchAgentStore(store).create({ name: '周报助手', workflow: '先查知识库', skills: ['weekly-report'], systemPrompt: '你是周报助手' });
  const conversation = service.create({ assistantId: agent.id, knowledge: false });
  service.send(conversation.id, { text: '生成本周周报' });
  await service.settled(conversation.id);
  service.send(conversation.id, { text: '这次不要写下周计划' });
  await service.settled(conversation.id);
  const started = service.get(conversation.id).task;
  service.send(conversation.id, { text: '继续按刚才的要求生成周报' });
  await service.settled(conversation.id);
  const kept = service.get(conversation.id);
  expect(kept.task?.id).toBe(started?.id);
  expect(kept.task?.constraints).toEqual(['这次不要写下周计划']);
  expect(kept.taskNotes).toEqual(['这次不要写下周计划']);
  expect(kept.messages.at(-1)?.contextManifest?.task?.inherited).toBe(true);
  service.send(conversation.id, { text: '帮我做报销' });
  await service.settled(conversation.id);
  const next = service.get(conversation.id);
  expect(next.task?.id).not.toBe(started?.id);
  expect(next.task?.goal).toContain('报销');
  expect(next.task?.constraints).toEqual([]);
  expect(next.taskNotes).toBeUndefined();
});

test('重试时沿用已搜到的资料，接着读取同一页；识别过的图片不再当成原图发给不能看图的模型', async () => {
  configureGateway({ generative_enabled: true, chat_model: 'service-test:chat', env: {} });
  const stamp = now();
  const settledSearch: WorkbenchToolCall[] = [{ id: 'prior-search', name: 'knowledge_search', input: JSON.stringify({ query: '预算' }), status: 'complete', output: JSON.stringify({ results: [{ citation: 1, source_id: 'default', slug: 'budget', title: '预算表', snippet: '8800' }], truncated: false }), startedAt: stamp, completedAt: stamp }];
  let pageReads = 0;
  let searches = 0;
  const runner = knowledgeWorkbenchAnswer({ getPage: async () => { pageReads += 1; return { source_id: 'default', compiled_truth: '预算8800', timeline: '', content_hash: 'hash-1' }; } } as never, {
    search: async () => { searches += 1; return { results: [] } as never; },
    answer: async () => { throw new Error('不应直接回答'); },
    loop: async (options: { toolHandlers: Map<string, { execute: (raw: unknown, abort: AbortSignal) => Promise<unknown> }>; abortSignal: AbortSignal; onTextDelta?: (text: string) => void }) => {
      const replayed = await options.toolHandlers.get('knowledge_search')!.execute({ query: '预算' }, options.abortSignal) as { results: unknown[] };
      expect(replayed.results).toHaveLength(1);
      await options.toolHandlers.get('knowledge_read')!.execute({ source_id: 'default', slug: 'budget' }, options.abortSignal);
      options.onTextDelta?.('预算8800 [1]');
      return { text: '预算8800 [1]', model: 'service-test:chat', stopReason: 'end' as const, messages: [] };
    },
  } as never);
  const first = await runner({ model: 'service-test:chat', knowledge: true, signal: new AbortController().signal, progress: () => {}, contextWindow: 8192, settledTools: settledSearch, messages: [{ id: 'u', role: 'user', text: '请核对预算', status: 'complete', createdAt: stamp }] });
  expect(searches).toBe(1);
  expect(pageReads).toBe(1);
  expect(first.citations).toHaveLength(1);
  expect(first.citations[0]?.slug).toBe('budget');

  const dir = root();
  const store = new WorkbenchStore(dir);
  const id = randomUUID();
  store.save({ id, title: '新对话', model: 'local', knowledge: true, sourceId: 'default', createdAt: stamp, updatedAt: stamp, messages: [{ id: 'u', role: 'user', text: '请补充知识：把核对结果写进页面', createdAt: stamp, status: 'complete' }] });
  let writes = 0;
  const credited = knowledgeWorkbenchAnswer({
    getPage: async () => { pageReads += 1; return { source_id: 'default', compiled_truth: '预算8800', timeline: '', content_hash: 'hash-1' }; },
    transaction: async () => { writes += 1; throw new Error('版本核对已到达'); },
  } as never, {
    search: async () => ({ results: [] }) as never,
    answer: async () => { throw new Error('不应直接回答'); },
    loop: async (options: { toolHandlers: Map<string, { execute: (raw: unknown, abort: AbortSignal) => Promise<{ content?: string }> }>; abortSignal: AbortSignal; onTextDelta?: (text: string) => void }) => {
      await options.toolHandlers.get('knowledge_search')!.execute({ query: '预算' }, options.abortSignal);
      const read = await options.toolHandlers.get('knowledge_read')!.execute({ source_id: 'default', slug: 'budget', offset: 0 }, options.abortSignal);
      expect(read.content).toContain('不应直接交回');
      expect(pageReads).toBe(1);
      await options.toolHandlers.get('knowledge_append')!.execute({ source_id: 'default', slug: 'budget', revision: 'hash-1', content: '补充核对结果' }, options.abortSignal);
      options.onTextDelta?.('已核对');
      return { text: '已核对', model: 'service-test:chat', stopReason: 'end' as const, messages: [] };
    },
  } as never, { store, tasks: {} as never });
  const settledRead: WorkbenchToolCall[] = [
    settledSearch[0]!,
    { id: 'prior-read', name: 'knowledge_read', input: JSON.stringify({ source_id: 'default', slug: 'budget', offset: 0 }), status: 'complete', output: JSON.stringify({ citation: 1, source_id: 'default', slug: 'budget', title: '预算表', revision: 'hash-1', content: '不应直接交回的旧正文', offset: 0, nextOffset: null, truncated: false }), startedAt: stamp, completedAt: stamp },
  ];
  await expect(credited({ model: 'service-test:chat', knowledge: true, sourceId: 'default', conversationId: id, signal: new AbortController().signal, progress: () => {}, contextWindow: 8192, settledTools: settledRead, messages: [{ id: 'u', role: 'user', text: '请补充知识：把核对结果写进页面', status: 'complete', createdAt: stamp }] })).rejects.toThrow('版本核对已到达');
  expect(writes).toBe(1);
  expect(pageReads).toBe(1);

  const blocked = knowledgeWorkbenchAnswer({ getPage: async () => { pageReads += 1; return null; } } as never, {
    search: async () => ({ results: [] }) as never,
    answer: async () => { throw new Error('不应直接回答'); },
    loop: async (options: { toolHandlers: Map<string, { execute: (raw: unknown, abort: AbortSignal) => Promise<unknown> }>; abortSignal: AbortSignal }) => {
      await options.toolHandlers.get('knowledge_read')!.execute({ source_id: 'default', slug: 'budget' }, options.abortSignal);
      return { text: '不应成功', model: 'service-test:chat', stopReason: 'end' as const, messages: [] };
    },
  } as never);
  await expect(blocked({ model: 'service-test:chat', knowledge: true, signal: new AbortController().signal, progress: () => {}, contextWindow: 8192, settledTools: [settledRead[1]!], messages: [{ id: 'u2', role: 'user', text: '请核对预算', status: 'complete', createdAt: stamp }] })).rejects.toThrow('请先搜索，再使用搜索结果中的精确 Source 和页面路径。');
  expect(pageReads).toBe(1);

  const imageId = randomUUID();
  const oldImage: WorkbenchMessage = { id: 'old-image', role: 'user', text: '看图', status: 'complete', createdAt: stamp, attachments: [{ id: imageId, name: 'scan.png', mime: 'image/png', route: 'ocr', included: 4, text: '金额 8800', preview: 'data:image/png;base64,AAAA' }] };
  const task = { goal: '核对截图', sources: [{ messageId: 'old-image', note: '提出任务' }] };
  expect(taskVisualAttachments([oldImage], task, new Set()).kept).toHaveLength(0);
  const recognized = taskRecognizedSupplement([oldImage], task, new Set());
  expect(recognized).toContain('识别文字');
  expect(recognized).toContain('金额 8800');
  expect(recognized).not.toContain('base64');

  const visualDir = root();
  const visualStore = new WorkbenchStore(visualDir);
  let visuals: Array<{ image: string }> = [];
  let supplement = '';
  const visualService = new WorkbenchService(visualStore, models, async input => {
    visuals = input.visualAttachments ?? [];
    supplement = [...input.messages].reverse().find(message => message.role === 'user')?.attachmentSupplement ?? '';
    return reply('好');
  }, async () => '新摘要');
  const visualAgent = new WorkbenchAgentStore(visualStore).create({ name: '周报助手', workflow: '先查知识库', skills: ['weekly-report'], systemPrompt: '你是周报助手' });
  const profile = new WorkbenchAgentStore(visualStore).get(visualAgent.id);
  profile.context.maxMessages = 2;
  new WorkbenchAgentStore(visualStore).replace(profile);
  const visual = visualService.create({ assistantId: visualAgent.id, knowledge: false });
  const saved = visualService.get(visual.id);
  saved.messages = [
    oldImage,
    { id: 'ack', role: 'assistant', text: '看过了', createdAt: stamp, status: 'complete' },
    { id: 'pad-user', role: 'user', text: '先说到这里', createdAt: stamp, status: 'complete' },
    { id: 'pad-assistant', role: 'assistant', text: '好', createdAt: stamp, status: 'complete' },
  ];
  saved.task = { id: 'image-task', goal: '核对截图', constraints: [], updatedAt: stamp, sources: [{ messageId: 'old-image', note: '提出任务' }] };
  visualStore.save(saved);
  visualService.send(visual.id, { text: '继续' });
  await visualService.settled(visual.id);
  expect(visuals).toHaveLength(0);
  expect(supplement).toContain('识别文字');
  expect(supplement).toContain('金额 8800');
  expect(supplement).not.toContain('base64');
});
