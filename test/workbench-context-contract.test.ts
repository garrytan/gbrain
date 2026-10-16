import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __setChatTransportForTests, chat, configureGateway, resetGateway, toolLoop, type ChatResult } from '../src/core/ai/gateway';
import { agentInstructions } from '../src/product/workbench/agent-tools';
import { WorkbenchAgentStore } from '../src/product/workbench/agents';
import { fitProviderRequest } from '../src/product/workbench/context-runtime';
import { knowledgeWorkbenchAnswer } from '../src/product/workbench/routes';
import { WorkbenchService } from '../src/product/workbench/service';
import { WorkbenchStore } from '../src/product/workbench/store';
import { learnTurn } from '../src/product/workbench/turn-policy';
import { defaultAssistant } from '../shared/workbench';
import { EVIDENCE_GAP_TEXT } from '../src/product/workbench/playbook';

const root = () => mkdtempSync(join(tmpdir(), 'pmbrain-context-contract-'));
const result: ChatResult = { text: '完成', blocks: [{ type: 'text', text: '完成' }], model: 'service-test:chat', providerId: 'service-test', stopReason: 'end', usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 } };
afterEach(() => { __setChatTransportForTests(null); resetGateway(); });

test('先交代周报后再说继续或执行吧，仍沿用这件任务；换成另一件工作后，这次的限制不再带上', async () => {
  const dir = root();
  const store = new WorkbenchStore(dir);
  const service = new WorkbenchService(store, () => [{ id: 'ollama:local', name: '本地', contextWindow: 8192 }], async () => ({ text: '好', model: 'ollama:local', citations: [] }));
  const agent = new WorkbenchAgentStore(store).create({ name: '周报助手', workflow: '先查知识库，再写完成事项、问题和计划', skills: ['weekly-report'], systemPrompt: '你是周报助手' });
  const conversation = service.create({ assistantId: agent.id, knowledge: false });
  service.send(conversation.id, { text: '生成本周周报' });
  await service.settled(conversation.id);
  service.send(conversation.id, { text: '这次不要写下周计划' });
  await service.settled(conversation.id);
  const started = service.get(conversation.id).task;
  expect(started?.goal).toContain('生成本周周报');
  expect(started?.constraints).toEqual(['这次不要写下周计划']);
  service.send(conversation.id, { text: '继续' });
  await service.settled(conversation.id);
  service.send(conversation.id, { text: '执行吧' });
  await service.settled(conversation.id);
  const kept = service.get(conversation.id);
  expect(kept.task?.id).toBe(started?.id);
  expect(kept.taskNotes).toEqual(['这次不要写下周计划']);
  expect(kept.messages.at(-1)?.contextManifest?.task?.inherited).toBe(true);
  expect(kept.messages.at(-1)?.contextManifest?.task?.goal).toContain('生成本周周报');
  service.send(conversation.id, { text: '帮我做报销' });
  await service.settled(conversation.id);
  const next = service.get(conversation.id);
  expect(next.task?.id).not.toBe(started?.id);
  expect(next.task?.goal).toContain('报销');
  expect(next.task?.constraints).toEqual([]);
  expect(next.taskNotes).toBeUndefined();
  const weekly = { ...defaultAssistant(), id: 'weekly', revision: 3, name: '周报助手', skills: ['weekly-report'], workflow: '先查知识库，再写完成事项、问题和计划', sourceIds: ['default'], readDirectories: [], deliveryFormat: 'docx' as const, createdAt: '', updatedAt: '' };
  const context = { engine: {}, config: () => ({}) } as never;
  const follow = await agentInstructions(context, weekly, { userText: '继续', taskActive: true, taskNotes: ['这次不要写下周计划'] });
  expect(follow).toContain('<workflow>');
  expect(follow).toContain('计划不能写成已完成');
  expect(follow).toContain('这次不要写下周计划');
  const bare = await agentInstructions(context, weekly, { userText: '继续' });
  expect(bare).not.toContain('<workflow>');
  const hello = await agentInstructions(context, weekly, { userText: '你好', taskActive: true });
  expect(hello).not.toContain('<workflow>');
});

test('接着把剩下的做完仍沿用这件任务的做法；不要继续并改做别的，就不再带上旧目标和这次的限制', async () => {
  const dir = root();
  const methods: Array<boolean | undefined> = [];
  const store = new WorkbenchStore(dir);
  const service = new WorkbenchService(store, () => [{ id: 'ollama:local', name: '本地', contextWindow: 8192 }], async input => {
    methods.push(input.taskMethod);
    return { text: '好', model: 'ollama:local', citations: [] };
  });
  const agent = new WorkbenchAgentStore(store).create({ name: '周报助手', workflow: '先查知识库，再写完成事项、问题和计划', skills: ['weekly-report'], systemPrompt: '你是周报助手' });
  const conversation = service.create({ assistantId: agent.id, knowledge: false });
  service.send(conversation.id, { text: '生成本周周报' });
  await service.settled(conversation.id);
  service.send(conversation.id, { text: '这次不要写下周计划' });
  await service.settled(conversation.id);
  const started = service.get(conversation.id).task;
  expect(started?.constraints).toEqual(['这次不要写下周计划']);
  service.send(conversation.id, { text: '不要继续了' });
  await service.settled(conversation.id);
  const paused = service.get(conversation.id);
  expect(paused.task?.id).toBe(started?.id);
  expect(paused.task?.goal).toContain('生成本周周报');
  expect(paused.task?.constraints).toEqual(['这次不要写下周计划']);
  expect(paused.messages.at(-1)?.contextManifest?.task?.inherited).toBe(false);
  expect(methods.at(-1)).toBe(false);
  service.send(conversation.id, { text: '接着把剩下的做完' });
  await service.settled(conversation.id);
  const kept = service.get(conversation.id);
  expect(kept.task?.id).toBe(started?.id);
  expect(kept.task?.constraints).toEqual(['这次不要写下周计划']);
  expect(kept.messages.at(-1)?.contextManifest?.task?.inherited).toBe(true);
  expect(methods.at(-1)).toBe(true);
  const weekly = { ...defaultAssistant(), id: 'weekly', revision: 3, name: '周报助手', skills: ['weekly-report'], workflow: '先查知识库，再写完成事项、问题和计划', sourceIds: ['default'], readDirectories: [], deliveryFormat: 'docx' as const, createdAt: '', updatedAt: '' };
  const context = { engine: {}, config: () => ({}) } as never;
  const follow = await agentInstructions(context, weekly, { userText: '接着把剩下的做完', taskActive: true });
  expect(follow).toContain('<workflow>');
  expect(follow).toContain('<skill name="weekly-report">');
  expect(follow).toContain('计划不能写成已完成');
  const explicitStop = await agentInstructions(context, weekly, { userText: '接着把剩下的做完', taskActive: true, taskMethod: false });
  expect(explicitStop).not.toContain('<workflow>');
  expect(explicitStop).not.toContain('<skill name=');
  const inheritedHello = await agentInstructions(context, weekly, { userText: '你好', taskActive: true, taskMethod: true });
  expect(inheritedHello).toContain('<workflow>');
  expect(inheritedHello).toContain('<skill name="weekly-report">');
  service.send(conversation.id, { text: '不要继续生成周报，改做报销' });
  await service.settled(conversation.id);
  const next = service.get(conversation.id);
  expect(next.task?.id).not.toBe(started?.id);
  expect(next.task?.goal).toContain('报销');
  expect(next.task?.goal).not.toBe(started?.goal);
  expect(next.task?.constraints).toEqual([]);
  expect(next.taskNotes).toBeUndefined();
  expect(next.messages.at(-1)?.contextManifest?.task?.inherited).toBe(false);
  expect(methods.at(-1)).toBe(false);
});

test('相反的规则用新的替代旧的，撤销后恢复，重新打开仍然一致', async () => {
  const replaced = learnTurn({ name: '周报助手', standingRules: ['风险要写完整', '标题不要日期'], recentUserTexts: [], text: '风险不要写那么多' });
  expect(replaced.rules).toEqual(['标题不要日期', '风险不要写那么多']);
  expect(replaced.replaced).toEqual([{ text: '风险要写完整', replacedBy: '风险不要写那么多' }]);
  expect(replaced.notice).toBe('已用「风险不要写那么多」替代「风险要写完整」');
  const dir = root();
  const store = new WorkbenchStore(dir);
  const service = new WorkbenchService(store, () => [{ id: 'ollama:local', name: '本地', contextWindow: 8192 }], async () => ({ text: '好', model: 'ollama:local', citations: [] }));
  const agent = new WorkbenchAgentStore(store).create({ name: '周报助手', systemPrompt: '你是周报助手', standingRules: ['风险要写完整', '标题不要日期'], workflow: '先查知识库', skills: ['weekly-report'] });
  const conversation = service.create({ assistantId: agent.id, knowledge: false });
  service.send(conversation.id, { text: '风险不要写那么多' });
  await service.settled(conversation.id);
  const saved = new WorkbenchAgentStore(new WorkbenchStore(dir)).get(agent.id);
  expect(saved.standingRules).toEqual(['标题不要日期', '风险不要写那么多']);
  expect(saved.retiredRules).toEqual([{ text: '风险要写完整', replacedBy: '风险不要写那么多' }]);
  const reply = service.get(conversation.id).messages.at(-1);
  expect(reply?.contextManifest?.rules.some(rule => rule.text === '风险要写完整' && rule.state === 'replaced')).toBe(true);
  expect(reply?.contextManifest?.rules.some(rule => rule.text === '风险不要写那么多' && rule.state === 'active')).toBe(true);
  const undone = service.undoLearnedRules(conversation.id, reply!.id);
  const restored = new WorkbenchAgentStore(new WorkbenchStore(dir)).get(agent.id);
  expect(restored.standingRules).toEqual(['风险要写完整', '标题不要日期']);
  expect(restored.retiredRules ?? []).toEqual([]);
  expect(undone.messages.find(item => item.id === reply!.id)?.ruleNotice).toBe('已撤销刚记下的工作规则');
});

test('收尾说明和换模型都先按同一份预算验算，超预算不会发给模型', async () => {
  configureGateway({ generative_enabled: true, chat_model: 'service-test:chat', chat_fallback_chain: ['service-test:backup'], env: {} });
  let calls = 0;
  __setChatTransportForTests(async () => { calls += 1; return result; });
  await expect(chat({
    model: 'service-test:chat', allowFallback: false, contextWindow: 2048, maxTokens: 256,
    system: `${'规则'.repeat(4000)}\n本轮资料收集已结束。现在直接给出回答。`,
    messages: [{ role: 'user', content: '继续' }],
    fitRequest: fitProviderRequest,
  })).rejects.toThrow('PMBrain 上下文预算不足');
  expect(calls).toBe(0);
  const seen: string[] = [];
  __setChatTransportForTests(async opts => {
    seen.push(`${opts.model}:${opts.system}`);
    if (seen.length === 1) throw new Error('401 unauthorized');
    return result;
  });
  const fitted: string[] = [];
  const answer = await chat({
    model: 'service-test:chat', contextWindow: 8192, maxTokens: 256,
    system: '你是助手。\n本轮资料收集已结束。',
    messages: [{ role: 'user', content: '继续' }],
    fitRequest: async opts => { fitted.push(opts.model ?? ''); return fitProviderRequest(opts); },
  });
  expect(answer.text).toBe('完成');
  expect(fitted).toEqual(['service-test:chat', 'service-test:backup']);
  expect(seen[1]).toContain('service-test:backup');
  expect(seen[1]).toContain('本轮资料收集已结束');
  calls = 0;
  __setChatTransportForTests(async opts => { calls += 1; expect(opts.system).toContain('本轮资料收集已结束'); return result; });
  await toolLoop({
    model: 'service-test:chat', system: '你是助手', initialMessages: [{ role: 'user', content: '继续' }], tools: [], toolHandlers: new Map(), maxTurns: 1,
    finalizeOnLastTurn: true, finalPrompt: '本轮资料收集已结束。', contextWindow: 8192, maxTokens: 256, fitRequest: fitProviderRequest,
  });
  expect(calls).toBe(1);
});

test('关掉知识检索仍保留当前任务和上一轮工具回执；周报没有本期资料时不拿旧记忆补稿', async () => {
  let searched = 0;
  let recalled = 0;
  let system = '';
  let packed = '';
  const agent = { ...defaultAssistant(), id: 'weekly', revision: 2, name: '周报助手', skills: ['weekly-report'], workflow: '先查知识库，再写完成事项', sourceIds: ['default'], readDirectories: [], deliveryFormat: 'docx' as const, standingRules: ['不要编造'], createdAt: '', updatedAt: '' };
  const answer = knowledgeWorkbenchAnswer({} as never, {
    search: async () => { searched += 1; return { results: [] } as never; },
    recall: async () => { recalled += 1; return [{ sourceId: 'default', slug: 'pref', title: '偏好短句', snippet: '喜欢短句', kind: 'memory' as const, factId: 1 }]; },
    answer: async input => { system = input.system ?? ''; packed = JSON.stringify(input.messages); return { text: '继续处理', model: 'm', stopReason: 'end' } as never; },
  }, undefined, { engine: {}, config: () => ({}) } as never);
  await answer({
    model: 'm', knowledge: false, sourceId: 'default', signal: new AbortController().signal, progress: () => {}, agent,
    task: { id: 'task-1', goal: '整理附件', constraints: [], updatedAt: '' },
    messages: [
      { id: 'a', role: 'assistant', text: '先看目录', status: 'complete', createdAt: '', toolCalls: [{ id: 'call-1', name: 'local_files', input: '{}', status: 'complete', output: '{"files":["a.docx"]}', startedAt: '', completedAt: '' }] },
      { id: 'u', role: 'user', text: '继续', status: 'complete', createdAt: '' },
    ],
  });
  expect(searched).toBe(0);
  expect(recalled).toBe(1);
  expect(system).toContain('不是知识库里的本期资料');
  expect(system).toContain('喜欢短句');
  expect(system).toContain('<workflow>');
  expect(packed).toContain('previous_tool_observations');
  expect(packed).toContain('local_files');
  searched = 0; recalled = 0; system = '';
  await answer({
    model: 'm', knowledge: true, sourceId: 'default', signal: new AbortController().signal, progress: () => {},
    summary: '上周已经写过完整周报',
    task: { id: 'task-2', goal: '生成本周周报', constraints: ['这次不要写下周计划'], updatedAt: '' },
    messages: [{ id: 'u2', role: 'user', text: '继续', status: 'complete', createdAt: '' }],
  });
  expect(recalled).toBe(0);
  expect(system).toContain('都不是本期事实');
  expect(system).toContain('不是本期工作事实');
  expect(system).not.toContain('可延续此前已核对的事实');
  expect(system).not.toContain('喜欢短句');
  const dir = root();
  const store = new WorkbenchStore(dir);
  const service = new WorkbenchService(store, () => [{ id: 'ollama:local', name: '本地', contextWindow: 8192 }], async () => ({ text: '# 已完成\n全部做完了', model: 'ollama:local', citations: [] }));
  const weekly = new WorkbenchAgentStore(store).create({ name: '周报助手', workflow: '先查知识库', skills: ['weekly-report'], systemPrompt: '你是周报助手' });
  const report = service.create({ assistantId: weekly.id, knowledge: true });
  service.send(report.id, { text: '生成本周周报' });
  await service.settled(report.id);
  service.send(report.id, { text: '继续' });
  await service.settled(report.id);
  expect(service.get(report.id).messages.at(-1)?.text).toBe(EVIDENCE_GAP_TEXT);
  expect(service.get(report.id).messages.at(-1)?.contextManifest?.evidenceTask).toBe(true);
});
