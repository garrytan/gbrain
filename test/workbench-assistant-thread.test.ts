import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentInstructions, readyToCreateAssistant } from '../src/product/workbench/agent-tools';
import { WorkbenchAgentStore } from '../src/product/workbench/agents';
import { planContext } from '../src/product/workbench/context';
import { activityLine, EVIDENCE_GAP_TEXT, needsCurrentEvidence, scheduledTaskPrompt, visibleAssistantText, wantsSavedPlaybook } from '../src/product/workbench/playbook';
import { knowledgeWorkbenchAnswer } from '../src/product/workbench/routes';
import { WorkbenchService } from '../src/product/workbench/service';
import { WorkbenchStore } from '../src/product/workbench/store';
import { classifyTurn, learnTurn, taskNeedsSkill } from '../src/product/workbench/turn-policy';
import { rosterStatus } from '../shared/workbench-agents';
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
  expect(promoted.added).toEqual(['先写本周完成事项，再写问题，不要编造', '标题不要日期']);
  expect(promoted.rules).toEqual(['先写本周完成事项，再写问题，不要编造', '标题不要日期']);
  const promotedAfterOnce = learnTurn({ name: '周报助手', standingRules: [], recentUserTexts: ['这次不要写下周计划', '标题不要日期'], text: '以后都这么做' });
  expect(promotedAfterOnce.rules).toEqual(['标题不要日期']);
  const once = learnTurn({ name: '周报助手', standingRules: promoted.rules, recentUserTexts: [], text: '这次不要写下周计划' });
  expect(once.rules).toEqual(promoted.rules);
  expect(once.added).toEqual([]);
  expect(once.taskNote).toContain('这次不要写下周计划');
});

test('设置里删掉一条已记下的规则后，保存结果不再包含它', () => {
  const dir = root();
  const agents = new WorkbenchAgentStore(new WorkbenchStore(dir));
  const created = agents.create({ name: '周报助手', systemPrompt: '你是周报助手', workflow: '先查知识库', skills: ['weekly-report'] });
  const learned = agents.rememberRules(created.id, ['标题不要日期', '不要编造']);
  const saved = agents.update(learned.id, { ...learned, standingRules: ['不要编造'], revision: learned.revision });
  expect(saved.standingRules).toEqual(['不要编造']);
  expect(saved.systemPrompt).toBe('你是周报助手');
  expect(saved.workflow).toContain('先查知识库');
});

test('撤销只去掉这一次记下的规则；重新生成后仍可以撤销', async () => {
  const dir = root();
  const store = new WorkbenchStore(dir);
  const service = new WorkbenchService(store, () => [{ id: 'ollama:local', name: '本地', contextWindow: 8192 }], async () => ({ text: '已按规则处理', model: 'ollama:local', citations: [] }));
  const agent = new WorkbenchAgentStore(store).create({ name: '周报助手', workflow: '先查知识库，再写完成事项、问题和计划', skills: ['weekly-report'], systemPrompt: '你是周报助手' });
  const conversation = service.create({ assistantId: agent.id, knowledge: false });
  service.send(conversation.id, { text: '先写本周完成事项，再写问题，不要编造' });
  await service.settled(conversation.id);
  service.send(conversation.id, { text: '标题不要日期' });
  await service.settled(conversation.id);
  service.send(conversation.id, { text: '以后都这么做' });
  await service.settled(conversation.id);
  const beforeRetry = service.get(conversation.id);
  const correction = beforeRetry.messages.find(item => item.ruleNotice === '已更新周报助手规则：标题不要日期');
  const durable = beforeRetry.messages.find(item => item.ruleNotice === '已更新「周报助手」工作规则');
  expect(correction?.learnedRules).toEqual(['标题不要日期']);
  expect(durable?.learnedRules).toEqual(['先写本周完成事项，再写问题，不要编造']);
  service.send(conversation.id, { retry: true });
  await service.settled(conversation.id);
  const retried = service.get(conversation.id).messages.at(-1);
  expect(retried?.ruleNotice).toBe('已更新「周报助手」工作规则');
  expect(retried?.learnedRules).toEqual(['先写本周完成事项，再写问题，不要编造']);
  expect(new WorkbenchAgentStore(store).get(agent.id).standingRules).toEqual(['标题不要日期', '先写本周完成事项，再写问题，不要编造']);
  const undone = service.undoLearnedRules(conversation.id, retried!.id);
  expect(new WorkbenchAgentStore(store).get(agent.id).standingRules).toEqual(['标题不要日期']);
  expect(undone.messages.find(item => item.id === retried!.id)?.ruleNotice).toBe('已撤销刚记下的工作规则');
  expect(undone.messages.find(item => item.id === retried!.id)?.learnedRules).toBeUndefined();
  expect(undone.messages).toHaveLength(beforeRetry.messages.length);
  expect(new WorkbenchAgentStore(store).get(agent.id).workflow).toContain('先查知识库');
  const cleared = service.undoLearnedRules(conversation.id, correction!.id);
  expect(new WorkbenchAgentStore(store).get(agent.id).standingRules).toEqual([]);
  expect(cleared.messages.find(item => item.id === correction!.id)?.ruleNotice).toBe('已撤销刚记下的工作规则');
  expect(() => service.undoLearnedRules(conversation.id, retried!.id)).toThrow('这条更新已经撤销，或没有可撤销的规则');
});

test('只说创建一个助手时还不能创建，明确确认后才可以', () => {
  expect(readyToCreateAssistant('创建一个报销助手')).toBe(false);
  expect(readyToCreateAssistant('帮我建一个周报助手，按知识库写')).toBe(false);
  expect(readyToCreateAssistant('确认创建')).toBe(true);
  expect(readyToCreateAssistant('就按这个创建周报助手')).toBe(true);
  expect(readyToCreateAssistant('直接创建报销助手')).toBe(true);
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
  expect(learned.playbook).toBeUndefined();
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

test('就按这次的存下来会留下可复核的做法，不会变成每次都带上的短规则', async () => {
  expect(classifyTurn('就按这次的存下来')).toBe('once');
  expect(wantsSavedPlaybook('就按这次的存下来')).toBe(true);
  expect(wantsSavedPlaybook('存成做法')).toBe(true);
  expect(wantsSavedPlaybook('保存为技能')).toBe(true);
  expect(wantsSavedPlaybook('以后按这次的做法')).toBe(true);
  expect(wantsSavedPlaybook('这次不要写下周计划')).toBe(false);
  const dir = root();
  const store = new WorkbenchStore(dir);
  const captured: string[] = [];
  const service = new WorkbenchService(store, () => [{ id: 'ollama:local', name: '本地', contextWindow: 8192 }], async () => ({ text: '好', model: 'ollama:local', citations: [] }), undefined, undefined, { capture: async (_conversation, message) => { captured.push(message.text); return { sourceId: 'default', hash: 'a'.repeat(64), capturedAt: message.createdAt, mode: 'off', visibility: 'private', ttl: '3d', status: 'off' }; }, settled: async () => {} });
  const agent = new WorkbenchAgentStore(store).create({ name: '周报助手', workflow: '先查知识库，再写完成事项、问题和计划', skills: ['weekly-report'], systemPrompt: '你是周报助手', standingRules: ['不要编造'] });
  const conversation = service.create({ assistantId: agent.id, knowledge: false });
  service.send(conversation.id, { text: '先写本周完成事项，再写问题，不要编造' });
  await service.settled(conversation.id);
  service.send(conversation.id, { text: '就按这次的存下来' });
  await service.settled(conversation.id);
  const saved = new WorkbenchAgentStore(store).get(agent.id);
  expect(saved.playbook?.name).toBe('周报助手');
  expect(saved.playbook?.steps).toContain('先写本周完成事项，再写问题，不要编造');
  expect(saved.playbook?.checks).toContain('没有依据就不写');
  expect(saved.playbook?.approval).toContain('资料不足');
  expect(saved.playbook?.output).toBe('Word 文档');
  expect(JSON.stringify(saved.playbook)).not.toContain('就按这次的存下来');
  expect(saved.standingRules).toEqual(['不要编造']);
  expect(service.get(conversation.id).taskNotes).toBeUndefined();
  expect(service.get(conversation.id).messages.at(-1)?.playbookNotice).toBe('已把这次存成「周报助手」的做法');
  expect(captured.some(text => text.includes('就按这次'))).toBe(false);
  const { playbook: _playbook, ...rest } = saved;
  const kept = new WorkbenchAgentStore(store).update(agent.id, { ...rest, revision: saved.revision });
  expect(kept.playbook?.steps).toEqual(saved.playbook?.steps);
  const removed = new WorkbenchAgentStore(store).update(agent.id, { ...kept, playbook: null, revision: kept.revision });
  expect(removed.playbook).toBeUndefined();
  expect(removed.workflow).toContain('先查知识库');
});

test('生成本周周报没有引用时不保留一份看起来完整的稿', async () => {
  const dir = root();
  const store = new WorkbenchStore(dir);
  const service = new WorkbenchService(store, () => [{ id: 'ollama:local', name: '本地', contextWindow: 8192 }], async () => ({ text: '# 已完成\n全部做完了', model: 'ollama:local', citations: [] }));
  const agent = new WorkbenchAgentStore(store).create({ name: '周报助手', workflow: '先查知识库', skills: ['weekly-report'], systemPrompt: '你是周报助手' });
  const report = service.create({ assistantId: agent.id, knowledge: true });
  service.send(report.id, { text: '生成本周周报' });
  await service.settled(report.id);
  const reply = service.get(report.id).messages.at(-1);
  expect(reply?.text).toBe(EVIDENCE_GAP_TEXT);
  expect(reply?.evidenceGap).toBe(true);
  expect(service.list().find(row => row.id === report.id)?.activity).toBe('没有查到本期材料');
  const ordinary = service.create({ assistantId: agent.id, knowledge: true });
  service.send(ordinary.id, { text: '什么是知识库' });
  await service.settled(ordinary.id);
  expect(service.get(ordinary.id).messages.at(-1)?.text).toContain('全部做完了');
  expect(service.get(ordinary.id).messages.at(-1)?.evidenceGap).toBeUndefined();
  const off = service.create({ assistantId: agent.id, knowledge: false });
  service.send(off.id, { text: '生成本周周报' });
  await service.settled(off.id);
  expect(service.get(off.id).messages.at(-1)?.text).toContain('全部做完了');
});

test('写周报时不把旧对话、记忆和上一份成果当成本期事实', async () => {
  let system = '';
  let recalled = false;
  const answer = knowledgeWorkbenchAnswer({} as never, {
    search: async () => ({ results: [] }) as never,
    recall: async () => { recalled = true; return []; },
    answer: async input => { system = input.system ?? ''; return { text: '# 本周已完成\n全部做完', model: 'm', stopReason: 'end' } as never; },
  });
  const result = await answer({
    model: 'm', knowledge: true, sourceId: 'default', summary: '上周已经上线', signal: new AbortController().signal, progress: () => {},
    priorCitations: [{ sourceId: 'default', slug: 'old', title: '上周周报', snippet: '已完成上线' }],
    messages: [{ id: '1', role: 'user', text: '生成本周周报', status: 'complete', createdAt: '' }],
  });
  expect(needsCurrentEvidence('生成本周周报')).toBe(true);
  expect(system).toContain('都不是本期事实');
  expect(system).toContain('不是本期工作事实');
  expect(system).not.toContain('可延续此前已核对的事实');
  expect(system).not.toContain('上周周报');
  expect(recalled).toBe(false);
  expect(result.citations).toEqual([]);
  expect(result.knowledge).toBe('none');
});

test('定时任务带上已存做法，并在没有本期材料时停止', () => {
  const prompt = scheduledTaskPrompt({
    schedule: { enabled: true, weekdays: [5], time: '17:00', timezone: 'Asia/Shanghai', prompt: '生成本周周报' },
    playbook: { name: '周报助手', when: '用户让周报助手写周报时', inputs: '本期资料', steps: ['先查知识库，再写完成事项'], checks: '没有依据就不写', output: 'Word 文档', approval: '资料不足时只说明没有材料', updatedAt: '2026-10-16T00:00:00.000Z' },
  }, '2026-10-16T09:00:00.000Z');
  expect(prompt).toContain('先查知识库，再写完成事项');
  expect(prompt).toContain('没有依据就不写');
  expect(prompt).toContain('没有查到材料时说明没有材料并停止，不要沿用上一份成果');
  expect(prompt).toContain('报告周期截止时间：2026-10-16T09:00:00.000Z');
});

test('助手列表显示最近工作，创建回执不露出编号', () => {
  expect(activityLine([{ role: 'assistant', text: '周报已写好，有两处没有依据', status: 'complete' }], false)).toBe('周报已写好，有两处没有依据');
  expect(activityLine([{ role: 'assistant', text: '正在写', status: 'running' }], true)).toBe('正在处理');
  expect(activityLine([{ role: 'assistant', text: '旧稿', status: 'complete', evidenceGap: true }], false)).toBe('没有查到本期材料');
  expect(activityLine([{ role: 'assistant', text: '', status: 'complete', savedPlaybook: '周报助手' }], false)).toBe('已存成做法');
  expect(rosterStatus('weekly', [{ assistantId: 'weekly', running: false, activity: '已存成做法', updatedAt: '2026-10-16T00:00:00.000Z' }])).toBe('已存成做法');
  const id = '57f56b87-eb96-4137-b2f8-a1dd562a6250';
  expect(visibleAssistantText(`已创建 ${id}，revision: 1`, [{ name: 'assistant_create', status: 'complete', output: JSON.stringify({ id, name: '报销助手', revision: 1, created: true }) }])).toBe('');
});

test('打招呼不带做法，生成本周周报才带上做法和本期核对', async () => {
  const agent = { ...defaultAssistant(), id: 'weekly', revision: 1, name: '周报助手', skills: ['weekly-report'], workflow: '先查知识库，再写完成事项、问题和计划', sourceIds: ['default'], readDirectories: [], deliveryFormat: 'docx' as const, standingRules: ['不要编造'], playbook: { name: '周报助手', when: '用户让周报助手写周报时', inputs: '本期资料', steps: ['先查知识库'], checks: '没有依据就不写', output: 'Word 文档', approval: '资料不足时只说明没有材料', updatedAt: '' }, createdAt: '', updatedAt: '' };
  const context = { engine: {}, config: () => ({}) } as never;
  const hello = await agentInstructions(context, agent, { userText: '你好' });
  expect(hello).not.toContain('<playbook>');
  expect(hello).not.toContain('都不是本期事实');
  const report = await agentInstructions(context, agent, { userText: '生成本周周报' });
  expect(report).toContain('<playbook>');
  expect(report).toContain('没有依据就不写');
  expect(report).toContain('都不是本期事实');
  const saving = await agentInstructions(context, agent, { userText: '就按这次的存下来' });
  expect(saving).toContain('不要重写报告');
  expect(saving).not.toContain('<current_evidence>');
});

test('清理之后，更早的原话不再进入这一次发给模型的窗口', () => {
  const messages = [message('u1', 'user', '旧任务'), message('a1', 'assistant', '旧回答'), message('u2', 'user', '新任务')];
  const planned = planContext(messages, defaultAssistant().context, { contextFloor: 'a1', contextWindow: 8192 });
  expect(planned.recent.map(item => item.id)).toEqual(['u2']);
  expect(planned.older).toEqual([]);
});
