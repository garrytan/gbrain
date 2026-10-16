import { createHash, randomUUID } from 'node:crypto';
import type { MinionJobContext } from '../../core/minions/types';
import type { ProductTaskRuntime } from '../tasks/runtime';
import type { BrainEngine } from '../../core/engine';
import { WorkbenchAgentStore, scheduleOccurrence } from './agents';
import { scheduledTaskPrompt } from './playbook';
import type { WorkbenchService } from './service';
import { publishArtifactToSource, saveWorkbenchArtifact } from './files';
import { TaskProgressAdapter } from '../tasks/progress-adapter';

export interface WorkbenchAssistantTask { root: string; assistantId: string; conversationId: string; prompt: string; timeoutMs?: number }
export class WorkbenchAgentCoordinator {
  private timer?: ReturnType<typeof setInterval>;
  private scanning = false;
  constructor(private store: WorkbenchAgentStore, private service: WorkbenchService, private tasks: ProductTaskRuntime, private engine: BrainEngine) {
    tasks.attachWorkbenchAssistant((input, context) => this.execute(input, context), () => this.close());
  }
  start() {
    this.timer = setInterval(() => void this.scan().catch(error => console.error('[assistant schedule]', error)), 30000);
    this.timer.unref();
    void this.scan().catch(error => console.error('[assistant schedule]', error));
  }
  close() { clearInterval(this.timer); this.timer = undefined; }
  async submit(assistantId: string, prompt: string, key?: string, scheduled = false, conversationId?: string) {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000) throw new Error('请填写 1–8000 字的任务要求');
    const agent = this.store.get(assistantId);
    const existing = key ? this.store.workbench.list().find(row => row.taskKey === key && row.assistantId === assistantId) : undefined;
    const conversation = conversationId ? this.service.get(conversationId) : existing ?? this.service.openAssistant(agent.id) ?? this.service.create({ assistantId: agent.id });
    if (!conversation.messages.length && key) { conversation.taskKey = key; conversation.title = `${agent.name}任务`; this.store.workbench.save(conversation); }
    const digest = createHash('sha256').update(JSON.stringify([this.store.workbench.root, assistantId, key ?? randomUUID()])).digest('hex');
    const run = await this.tasks.submitAssistant({ root: this.store.workbench.root, assistantId, conversationId: conversation.id, prompt: prompt.trim() }, `assistant:${digest}`, scheduled);
    return { run, conversationId: conversation.id, assistantId, submitted: true };
  }
  async scan(now = new Date()) {
    if (this.scanning) return;
    this.scanning = true;
    try {
      for (const agent of this.store.list()) {
        if (!agent.schedule?.enabled) continue;
        const occurrence = scheduleOccurrence(agent.schedule, now, 'previous');
        if (!occurrence || occurrence.getTime() < Date.parse(agent.createdAt)) continue;
        const slot = occurrence.toISOString(); const previous = this.store.scheduled(agent.id);
        if (previous?.slot === slot && previous.runId) continue;
        const conversation = previous?.slot === slot ? this.service.get(previous.conversationId) : this.service.openAssistant(agent.id) ?? this.service.create({ assistantId: agent.id });
        this.store.recordSchedule(agent.id, { slot, conversationId: conversation.id });
        const result = await this.submit(agent.id, scheduledTaskPrompt(agent, slot), `${agent.id}:${slot}`, true, conversation.id);
        this.store.recordSchedule(agent.id, { slot, conversationId: conversation.id, runId: result.run.id });
      }
    } finally { this.scanning = false; }
  }
  private async execute(input: WorkbenchAssistantTask, context: MinionJobContext) {
    if (input.root !== this.store.workbench.root) throw new Error('任务不属于当前知识库工作台');
    const signal = AbortSignal.any([context.signal, context.shutdownSignal]); signal.throwIfAborted();
    const agent = this.store.get(input.assistantId);
    const initial = this.service.get(input.conversationId);
    if ((initial.assistantId ?? 'main') !== agent.id) throw new Error('任务助手与对话不匹配');
    const cancel = () => this.service.cancel(initial.id);
    signal.addEventListener('abort', cancel, { once: true });
    let progressTimer: ReturnType<typeof setInterval> | undefined;
    let progressPending = Promise.resolve();
    try {
      const tail = initial.messages.at(-1);
      const lastUser = [...initial.messages].reverse().find(message => message.role === 'user');
      const samePrompt = lastUser?.text === input.prompt && tail?.role === 'assistant' ? tail : undefined;
      if (!samePrompt || (samePrompt.status !== 'complete' && samePrompt.status !== 'running')) {
        this.service.send(initial.id, samePrompt ? { retry: true } : { text: input.prompt });
        await this.service.accepted(initial.id);
        const adapter = new TaskProgressAdapter('assistant_task');
        adapter.view.name = agent.name; adapter.view.stage = '正在执行助手任务';
        await context.updateProgress({ output: '正在执行助手任务', product: adapter.view });
        progressTimer = setInterval(() => {
          const reply = this.service.get(initial.id).messages.at(-1);
          adapter.view.stage = reply?.stage ?? '正在保存成果';
          progressPending = progressPending.then(async () => { if (!signal.aborted) await context.updateProgress({ output: adapter.view.stage, product: structuredClone(adapter.view) }); }).catch(error => console.error('[assistant progress]', error));
        }, 1000);
        await this.service.settled(initial.id);
      }
      signal.throwIfAborted();
      if (!await context.isActive()) throw new Error('任务执行租约已失效');
      const conversation = this.service.get(initial.id); const reply = conversation.messages.at(-1);
      if (!reply || reply.role !== 'assistant' || reply.status !== 'complete') throw new Error(reply?.error ?? '助手未完成任务');
      if (reply.stopReason === 'length') throw new Error('助手输出尚未完整，已保存对话，请继续后再交付');
      if (reply.evidenceGap) return { assistantId: agent.id, assistantName: agent.name, conversationId: conversation.id, artifacts: [], status: 'completed' };
      let artifacts = this.store.artifacts().filter(row => row.conversationId === initial.id && row.messageId === reply.id);
      if (agent.skills.includes('weekly-report') && !reply.citations?.length) throw new Error('缺少可核对的工作材料，请在任务对话补充资料后继续');
      if (!artifacts.length) {
        artifacts = [await saveWorkbenchArtifact(this.store, { agent, conversationId: initial.id, messageId: reply.id, title: `${agent.name}成果`, content: reply.text, citations: reply.citations ?? [], signal })];
      }
      artifacts = await Promise.all(artifacts.map(async artifact => {
        const published = await publishArtifactToSource(this.engine, agent, artifact);
        if (!published.ok) return artifact;
        const next = { ...artifact, publishedPath: published.path };
        this.store.recordArtifact(next);
        return next;
      }));
      reply.artifacts = artifacts.map(({ id, title, format, publishedPath }) => ({ id, title, format, publishedPath }));
      this.store.workbench.save(conversation);
      return { assistantId: agent.id, assistantName: agent.name, conversationId: conversation.id, artifacts: artifacts.map(({ id, title, format, publishedPath }) => ({ id, title, format, publishedPath })), status: 'completed' };
    } finally { clearInterval(progressTimer); await progressPending; signal.removeEventListener('abort', cancel); }
  }
}
