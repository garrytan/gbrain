import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentInstructions } from '../src/product/workbench/agent-tools';
import { WorkbenchAgentStore } from '../src/product/workbench/agents';
import { planContext } from '../src/product/workbench/context';
import { WorkbenchService } from '../src/product/workbench/service';
import { WorkbenchStore } from '../src/product/workbench/store';
import { classifyTurn, learnTurn, taskNeedsSkill } from '../src/product/workbench/turn-policy';
import { defaultAssistant, type WorkbenchMessage } from '../shared/workbench';

const root = () => mkdtempSync(join(tmpdir(), 'pmbrain-assistant-thread-'));
const message = (id: string, role: 'user' | 'assistant', text: string): WorkbenchMessage => ({ id, role, text, status: 'complete', createdAt: '' });

test('明确要求长期生效、连续的做法纠正、以及只说这次，会分成三档', () => {
  expect(classifyTurn('以后周报都按知识库里的实际进展写')).toBe('durable');
  expect(classifyTurn('记住，没有依据就不写')).toBe('durable');
  expect(classifyTurn('每次周报都先写完成事项')).toBe('durable');
  expect(classifyTurn('固定这样')).toBe('durable');
  expect(classifyTurn('标题不要日期')).toBe('correction');
  expect(classifyTurn('风险不要这么写')).toBe('correction');
  expect(classifyTurn('这次不要写下周计划')).toBe('once');
  expect(classifyTurn('生成本周周报')).toBe('chat');
  const promoted = learnTurn({ name: '周报助手', standingRules: [], recentUserTexts: ['先写本周完成事项，再写问题，不要编造', '标题不要日期'], text: '以后都这么做' });
  expect(promoted.notice).toBe('已更新「周报助手」工作规则');
  expect(promoted.rules).toEqual(['先写本周完成事项，再写问题，不要编造', '标题不要日期']);
  const promotedAfterOnce = learnTurn({ name: '周报助手', standingRules: [], recentUserTexts: ['这次不要写下周计划', '标题不要日期'], text: '以后都这么做' });
  expect(promotedAfterOnce.rules).toEqual(['标题不要日期']);
  const once = learnTurn({ name: '周报助手', standingRules: promoted.rules, recentUserTexts: [], text: '这次不要写下周计划' });
  expect(once.rules).toEqual(promoted.rules);
  expect(once.taskNote).toContain('这次不要写下周计划');
});

test('打招呼不带工作步骤，说生成本周周报或还是按上周的来才带上', async () => {
  const agent = { ...defaultAssistant(), id: 'weekly', revision: 1, name: '周报助手', skills: ['weekly-report'], workflow: '先查知识库，再写完成事项、问题和计划', sourceIds: ['default'], readDirectories: [], deliveryFormat: 'docx' as const, standingRules: ['不要编造'], createdAt: '', updatedAt: '' };
  const context = { engine: {}, config: () => ({}) } as any;
  const hello = await agentInstructions(context, agent, { userText: '你好' });
  expect(hello).toContain('不要编造');
  expect(hello).not.toContain('<workflow>');
  expect(hello).not.toContain('<skill');
  const report = await agentInstructions(context, agent, { userText: '生成本周周报' });
  expect(report).toContain('<workflow>');
  expect(report).toContain('计划不能写成已完成');
  const again = await agentInstructions(context, agent, { userText: '还是按上周的来' });
  expect(again).toContain('先查知识库');
  expect(taskNeedsSkill(agent, '谢谢')).toBe(false);
});

test('一个助手反复交代工作仍用同一条对话；清理任务上下文不删除记录，也不清掉长期规则', async () => {
  const dir = root();
  const store = new WorkbenchStore(dir);
  const seen: string[][] = [];
  const captured: string[] = [];
  const service = new WorkbenchService(store, () => [{ id: 'ollama:local', name: '本地', contextWindow: 8192 }], async input => {
    seen.push(input.messages.map(item => item.text));
    return { text: '已按规则处理', model: 'ollama:local', citations: [] };
  }, undefined, undefined, { capture: async (_conversation, message) => { captured.push(message.text); return { sourceId: 'default', hash: 'a'.repeat(64), capturedAt: message.createdAt, mode: 'off', visibility: 'private', ttl: '3d', status: 'off' }; }, settled: async () => {} });
  const agent = new WorkbenchAgentStore(store).create({ name: '周报助手', workflow: '先查知识库，再写完成事项、问题和计划', skills: ['weekly-report'], systemPrompt: '你是周报助手' });
  const first = service.create({ assistantId: agent.id, knowledge: false });
  const second = service.create({ assistantId: agent.id, knowledge: false });
  expect(service.openAssistant(agent.id)?.id).toBe(first.id);
  service.send(first.id, { text: '先写本周完成事项，再写问题，不要编造' });
  await service.settled(first.id);
  service.send(first.id, { text: '标题不要日期' });
  await service.settled(first.id);
  service.send(first.id, { text: '以后都这么做' });
  await service.settled(first.id);
  const learned = new WorkbenchAgentStore(store).get(agent.id);
  expect(learned.standingRules).toContain('先写本周完成事项，再写问题，不要编造');
  expect(learned.standingRules).toContain('标题不要日期');
  expect(learned.standingRules).toHaveLength(2);
  expect(service.get(first.id).messages.at(-1)?.ruleNotice).toBe('已更新「周报助手」工作规则');
  expect(service.get(first.id).messages.some(item => item.ruleNotice === '已更新周报助手规则：标题不要日期')).toBe(true);
  const before = learned.standingRules?.length ?? 0;
  service.send(first.id, { text: '这次不要写下周计划' });
  await service.settled(first.id);
  expect(new WorkbenchAgentStore(store).get(agent.id).standingRules).toHaveLength(before);
  expect(service.get(first.id).taskNotes).toEqual(['这次不要写下周计划']);
  expect(captured.some(text => text.includes('这次不要'))).toBe(false);
  expect(captured.some(text => text.includes('以后都这么做'))).toBe(true);
  const cleared = service.clearTaskContext(first.id);
  expect(cleared.messages.length).toBeGreaterThan(4);
  expect(cleared.taskNotes).toBeUndefined();
  expect(cleared.contextFloor).toBe(cleared.messages.at(-1)?.id);
  expect(new WorkbenchAgentStore(store).get(agent.id).workflow).toContain('先查知识库');
  service.send(first.id, { text: '生成本周周报' });
  await service.settled(first.id);
  expect(seen.at(-1)).toEqual(['生成本周周报']);
  expect(second.id).not.toBe(first.id);
  expect(service.openAssistant(agent.id)?.id).toBe(first.id);
});

test('清理之后，更早的原话不再进入这一次发给模型的窗口', () => {
  const messages = [message('u1', 'user', '旧任务'), message('a1', 'assistant', '旧回答'), message('u2', 'user', '新任务')];
  const planned = planContext(messages, defaultAssistant().context, { contextFloor: 'a1', contextWindow: 8192 });
  expect(planned.recent.map(item => item.id)).toEqual(['u2']);
  expect(planned.older).toEqual([]);
});
