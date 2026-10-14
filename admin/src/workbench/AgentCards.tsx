import React from 'react';
import { ArrowRight, Bot, CalendarDays } from 'lucide-react';
import type { WorkbenchAgent, WorkbenchSchedule } from '../../../shared/workbench-agents';
import type { WorkbenchToolCall } from '../../../shared/workbench';

export function scheduleLabel(schedule?: WorkbenchSchedule): string {
  if (!schedule?.enabled) return '按需执行';
  const days = [...new Set(schedule.weekdays)].sort((a, b) => a - b);
  const frequency = days.length === 7 ? '每天' : days.join(',') === '1,2,3,4,5' ? '每个工作日' : `每周${days.map(day => '日一二三四五六'[day]).join('、')}`;
  const zone = schedule.timezone === 'Asia/Shanghai' ? '北京时间' : schedule.timezone;
  return `${frequency} ${schedule.time}（${zone}）`;
}

export function AgentCards({ calls, agents, onAgent, onConversation }: { calls: WorkbenchToolCall[]; agents: WorkbenchAgent[]; onAgent: (id: string) => void; onConversation: (id: string) => void }) {
  const seen = new Set<string>();
  const cards = calls.flatMap(call => {
    if (call.status !== 'complete' || !call.output) return [];
    try {
      const output = JSON.parse(call.output);
      if (['assistant_create', 'assistant_update'].includes(call.name) && (output.created || output.updated)) {
        const agent = agents.find(item => item.id === output.id);
        if (!agent || seen.has(agent.id)) return [];
        seen.add(agent.id);
        return [<section key={call.id} className="wb-result-card" aria-label="已配置的助手"><Bot size={22} /><div><strong>{agent.name}</strong><p>{agent.description || '已按你的要求配置，可开始工作。'}</p><small><CalendarDays size={13} />{scheduleLabel(agent.schedule)}</small></div><button onClick={() => onAgent(agent.id)}>开始对话<ArrowRight size={14} /></button></section>];
      }
      if (call.name === 'task_submit' && output.submitted && typeof output.conversationId === 'string') {
        return [<section key={call.id} className="wb-result-card" aria-label="已提交的任务"><Bot size={22} /><div><strong>已交给{agents.find(item => item.id === output.assistantId)?.name || '专用助手'}</strong><p>任务已提交，进展和成果会保存在任务对话里。</p></div><button onClick={() => onConversation(output.conversationId)}>查看进展<ArrowRight size={14} /></button></section>];
      }
    } catch {}
    return [];
  });
  return cards.length ? <div className="wb-result-cards">{cards}</div> : null;
}
