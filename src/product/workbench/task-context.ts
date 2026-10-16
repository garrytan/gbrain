import type { WorkbenchMessage, WorkbenchTask } from '../../../shared/workbench';
import { retrievalText } from './attachments';
import { classifyTurn, compactRule, taskNeedsSkill } from './turn-policy';

const followUp = /^(?:继续|继续做|继续写|接着做|接着写|接着|执行吧|开始吧|就按这个|按这个做|做吧|写吧|可以|好|好的|行|嗯|执行)$/;
const agreementOnly = /^(?:可以|好|好的|行|嗯|执行)$/;
const continuationCue = /继续|接着|就按这个|按这个|按刚才|还是按|执行吧|开始吧/;

export function continuesActiveTask(text: string): boolean {
  return followUp.test(text.replace(/\s+/g, '').replace(/[。！!？?，,]/g, ''));
}

export function continuesCurrentWork(text: string): boolean {
  if (continuesActiveTask(text)) return true;
  return continuationCue.test(text.replace(/\s+/g, '').replace(/[。！!？?，,]/g, ''));
}

export function advanceTask(input: { task?: WorkbenchTask; notes?: string[]; text: string; recentUserTexts: string[]; agent: { workflow?: string; skills?: string[] }; now: string; id: () => string }): { task?: WorkbenchTask; inherited: boolean; opened: boolean } {
  const text = input.text.trim();
  const normalized = text.replace(/\s+/g, '').replace(/[。！!？?，,]/g, '');
  if (input.task && continuesCurrentWork(text)) return { task: { ...input.task, updatedAt: input.now }, inherited: true, opened: false };
  if (continuesActiveTask(text)) {
    if (input.task) return { task: { ...input.task, updatedAt: input.now }, inherited: true, opened: false };
    if (agreementOnly.test(normalized)) return { inherited: false, opened: false };
    const goal = [...input.recentUserTexts].reverse().find(item => classifyTurn(item) === 'chat' && taskNeedsSkill(input.agent, item));
    if (!goal) return { inherited: false, opened: false };
    return { task: { id: input.id(), goal: compactRule(goal), constraints: [...(input.notes ?? [])], updatedAt: input.now }, inherited: true, opened: false };
  }
  if (classifyTurn(text) === 'chat' && taskNeedsSkill(input.agent, text)) {
    const goal = compactRule(text);
    if (input.task?.goal === goal) return { task: { ...input.task, updatedAt: input.now }, inherited: true, opened: false };
    return { task: { id: input.id(), goal, constraints: [], updatedAt: input.now }, inherited: false, opened: true };
  }
  return { task: input.task, inherited: false, opened: false };
}

export function noteTask(task: WorkbenchTask, input: { messageId: string; opened: boolean; inherited: boolean; constraint?: string }): WorkbenchTask {
  const note = input.constraint || (input.opened ? '提出任务' : input.inherited ? '继续当前任务' : '补充');
  const sources = (input.opened ? [] : [...(task.sources ?? [])]).filter(item => item.messageId !== input.messageId || item.note !== note);
  sources.push({ messageId: input.messageId, note });
  const next: WorkbenchTask = { ...task, sources: sources.slice(-12), updatedAt: task.updatedAt };
  if (input.opened) {
    delete next.decisions;
    delete next.openItems;
    delete next.deliveries;
  }
  return next;
}

export function compileTaskBrief(task?: WorkbenchTask, evidence = false): string {
  if (!task?.goal?.trim()) return '';
  const lines = [`目标：${task.goal}`];
  if (task.constraints.length) lines.push(`这次的限制：${task.constraints.join('；')}`);
  if (task.decisions?.length) lines.push(`已决定：${task.decisions.join('；')}`);
  if (task.openItems?.length) lines.push(`未决：${task.openItems.join('；')}`);
  if (task.deliveries?.length) lines.push(`交付：${task.deliveries.join('；')}`);
  if (task.sources?.length) lines.push(`来源：${task.sources.map(item => `${item.note}（${item.messageId}）`).join('；')}`);
  const label = evidence
    ? '这是当前任务的结构摘要，权威低于用户原话、当前规则和本期引用。它不是本期工作事实。'
    : '这是当前任务的结构摘要，权威低于用户原话、当前规则和本期引用。';
  return `\n<task_brief>\n${label}\n${lines.join('\n')}\n</task_brief>`;
}

export function retrievalQuery(messages: Array<Pick<WorkbenchMessage, 'role' | 'text' | 'attachments'>>, task?: Pick<WorkbenchTask, 'goal'>): string {
  const users = messages.filter(item => item.role === 'user');
  if (!task?.goal?.trim()) return users.slice(-4).map(item => retrievalText(item)).filter(Boolean).join('\n').trim();
  const latest = users.at(-1);
  const raw = latest?.text.trim() ?? '';
  const goal = task.goal.trim();
  if (!raw || raw === goal || continuesActiveTask(raw)) return goal.slice(0, 2000);
  return `${goal}\n${retrievalText(latest!)}`.trim().slice(0, 2000);
}
