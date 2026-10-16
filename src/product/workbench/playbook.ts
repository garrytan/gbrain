import type { WorkbenchPlaybook, WorkbenchSchedule } from '../../../shared/workbench-agents';
import { compactRule, instructional } from './turn-policy';

export const EVIDENCE_GAP_TEXT = '这次没有查到可用材料。没有写完整稿，也没有沿用以前的成果。';
export const CURRENT_EVIDENCE_RULE = '这一次的事实只来自这次检索和用户这次给出的材料。更早的对话、已保存的记忆和上一份成果都不是本期事实。回答先说明查到了什么。没有查到材料时，只说明没有材料并停止，不要写完整稿，也不要沿用以前的成果。';
export const SCHEDULE_STOP = '只使用这次查到的本期资料。没有查到材料时说明没有材料并停止，不要沿用上一份成果。';
const saveCue = /就按这次的存下来|按这次的存下来|按这次存下来|存成做法|保存为技能|存成技能|以后按这次/;
const evidenceCue = /周报|报销|报告|本周|本期|做法|还是按|生成本/;

export function wantsSavedPlaybook(text: string): boolean {
  return saveCue.test(text.replace(/\s+/g, ''));
}

export function needsCurrentEvidence(text: string): boolean {
  return evidenceCue.test(text.replace(/\s+/g, ''));
}

function pieces(text: string): string[] {
  return text.split(/\n+|。|；|;/).map(compactRule).filter(part => part.length >= 4);
}

export function compilePlaybook(input: { name: string; workflow?: string; standingRules?: string[]; deliveryFormat?: 'markdown' | 'docx'; recentUserTexts: string[]; now?: string }): WorkbenchPlaybook {
  const recent = input.recentUserTexts.map(compactRule).filter(text => text && !wantsSavedPlaybook(text) && instructional(text));
  const steps: string[] = [];
  for (const step of [...pieces(input.workflow ?? ''), ...recent]) {
    if (steps.length >= 8) break;
    if (!steps.includes(step)) steps.push(step);
  }
  if (!steps.length) steps.push('先检索本期资料，再只根据查到的内容写');
  const topic = /周报/.test(`${input.name}${input.workflow ?? ''}${recent.join('')}`) ? '写周报' : /报销/.test(`${input.name}${recent.join('')}`) ? '处理报销' : /报告/.test(`${input.name}${recent.join('')}`) ? '写报告' : '按已存做法工作';
  const checks = ['没有依据就不写', ...(input.standingRules ?? []).map(compactRule).filter(rule => rule && rule !== '没有依据就不写' && /不要|只写|依据|不能编造/.test(rule))].slice(0, 4);
  return normalizePlaybook({
    name: input.name,
    when: `用户让${input.name}${topic}时`,
    inputs: '本期知识库里与这次任务相关的资料。不使用上一份成果里的完成项。',
    steps,
    checks: checks.join('；'),
    output: input.deliveryFormat === 'markdown' ? 'Markdown' : 'Word 文档',
    approval: '资料不足时只说明没有材料，并等用户确认后再写。',
    updatedAt: input.now,
  });
}

export function normalizePlaybook(input: unknown, now = new Date().toISOString()): WorkbenchPlaybook {
  if (!input || typeof input !== 'object') throw new Error('做法无效');
  const raw = input as Record<string, unknown>;
  const text = (value: unknown, label: string, max = 240) => {
    const next = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!next || next.length > max) throw new Error(`${label}无效`);
    return next;
  };
  if (!Array.isArray(raw.steps)) throw new Error('做法步骤需为 1–8 条');
  const steps = [...new Set(raw.steps.map(step => text(step, '步骤')))];
  if (!steps.length || steps.length > 8) throw new Error('做法步骤需为 1–8 条');
  return {
    name: text(raw.name, '做法名称', 40),
    when: text(raw.when, '适用时机'),
    inputs: text(raw.inputs, '所需资料'),
    steps,
    checks: text(raw.checks, '核对方式', 500),
    output: text(raw.output, '交付'),
    approval: text(raw.approval, '确认边界', 500),
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt.trim() ? raw.updatedAt : now,
  };
}

export function playbookPrompt(playbook: WorkbenchPlaybook): string {
  return `<playbook>\n名称：${playbook.name}\n什么时候用：${playbook.when}\n需要的资料：${playbook.inputs}\n步骤：\n${playbook.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}\n怎么核对：${playbook.checks}\n交付：${playbook.output}\n需要人确认：${playbook.approval}\n</playbook>`;
}

export function scheduledTaskPrompt(agent: { schedule?: WorkbenchSchedule; playbook?: WorkbenchPlaybook | null }, slot: string): string {
  const prompt = agent.schedule?.prompt.trim() || '按已存做法完成本期工作';
  const playbook = agent.playbook;
  const method = playbook ? `\n按已存做法「${playbook.name}」执行。\n步骤：${playbook.steps.join('；')}\n核对：${playbook.checks}\n交付：${playbook.output}\n确认边界：${playbook.approval}` : '';
  const tail = `\n${SCHEDULE_STOP}`;
  let body = `${prompt}\n报告周期截止时间：${slot}。按资料中的实际事件日期区分本期完成、推进中和计划。${method}`;
  if (body.length + tail.length > 8000) body = body.slice(0, 8000 - tail.length);
  return body + tail;
}

function clip(text: string): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  if (!chars.length) return '';
  return chars.length <= 28 ? chars.join('') : `${chars.slice(0, 28).join('')}…`;
}

export function activityLine(messages: Array<{ role: string; text?: string; status?: string; evidenceGap?: boolean; artifacts?: Array<{ title?: string }>; savedPlaybook?: string; ruleNotice?: string; toolCalls?: Array<{ name: string; status: string; output?: string }> }>, running: boolean): string {
  if (running) return '正在处理';
  const assistant = [...messages].reverse().find(message => message.role === 'assistant' && message.status !== 'running' && message.status !== 'error' && message.status !== 'cancelled');
  if (!assistant) return '';
  if (assistant.evidenceGap) return '没有查到本期材料';
  const title = assistant.artifacts?.find(item => item.title)?.title;
  if (title) return clip(`已保存${title}`);
  if (assistant.savedPlaybook) return '已存成做法';
  for (const call of [...(assistant.toolCalls ?? [])].reverse()) {
    if (call.status !== 'complete' || (call.name !== 'assistant_create' && call.name !== 'assistant_update') || !call.output) continue;
    try {
      const output = JSON.parse(call.output) as { name?: string; created?: boolean; updated?: boolean };
      if (output.name && (output.created || output.updated)) return clip(`已准备好${output.name}`);
    } catch { continue; }
  }
  if (assistant.ruleNotice && !assistant.ruleNotice.startsWith('已撤销')) return clip(assistant.ruleNotice);
  return clip(assistant.text ?? '');
}

export function visibleAssistantText(text: string, calls?: Array<{ name: string; status: string; output?: string }>): string {
  for (const call of calls ?? []) {
    if (call.status !== 'complete' || !call.output || (call.name !== 'assistant_create' && call.name !== 'assistant_update')) continue;
    try {
      const output = JSON.parse(call.output) as { id?: string; name?: string; revision?: number; created?: boolean; updated?: boolean };
      if (!output.name || !(output.created || output.updated)) continue;
      const leaked = (output.id && text.includes(output.id)) || (output.revision != null && new RegExp(`(?:revision|版本)\\s*[:：]?\\s*${output.revision}`).test(text));
      if (leaked) return '';
    } catch { continue; }
  }
  return text;
}
