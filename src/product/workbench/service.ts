import { randomUUID } from 'node:crypto';
import type { WorkbenchCitation, WorkbenchConversation, WorkbenchMemory, WorkbenchMessage, WorkbenchModel, WorkbenchTask, WorkbenchToolCall } from '../../../shared/workbench';
import { advanceStoredReads, attachmentRead, enrichAttachments, incomingAttachments, namedAttachmentSupplement, resolveListedAttachments, summarySource, modelReadsPdfNatively, taskRecognizedSupplement, taskVisualAttachments } from './attachments';
import { contextBudget, knowledgeReserve, planContext,conversationCitations,referenceProjection } from './context';
import { WorkbenchStore } from './store';
import { compressTranscript, contextFailure,requestOutputTokens } from './context-runtime';
import type {ChatRequestEvent} from '../../core/ai/chat-request-runtime';
import {assistantSession} from './request';
import { memoryVersion } from './memory-identity';
import { WorkbenchAgentStore } from './agents';
import type { WorkbenchAgent } from '../../../shared/workbench-agents';
import { activityLine, compilePlaybook, EVIDENCE_GAP_TEXT, needsCurrentEvidence, visibleAssistantText, wantsSavedPlaybook } from './playbook';
import { advanceTask, noteTask } from './task-context';
import { compactRule, learnTurn } from './turn-policy';

export { conversationContext } from './context';

export interface WorkbenchAnswerInput {
  agent?: WorkbenchAgent;
  messageId?: string;
  sourceId?: string;
  conversationId?: string;
  messages: WorkbenchMessage[];
  summary?: string;
  taskNotes?: string[];
  task?: WorkbenchTask;
  taskMethod?: boolean;
  priorCitations?: WorkbenchCitation[];
  model: string;
  knowledge: boolean;
  systemPrompt?: string;
  temperature?: number;
  contextWindow?: number;
  contextThreshold?: number;
  signal: AbortSignal;
  attachmentSupplement?: string;
  visualAttachments?: Array<{ name: string; mime: string; image: string }>;
  settledTools?: WorkbenchToolCall[];
  progress: (stage: string) => void;
  onDelta?: (delta: string) => void;
  onReplace?: (text: string, model: string) => void;
  onTool?: (call: WorkbenchToolCall) => void;
  onContext?: (note: string) => void;
  onRequestEvent?: (event:ChatRequestEvent)=>void;
  contextSummarizer?: { model: string; contextWindow?: number; summarize: WorkbenchSummarizer };
}
export type WorkbenchAnswer = (input: WorkbenchAnswerInput) => Promise<{ text: string; model: string; citations: WorkbenchCitation[]; knowledge?: 'used' | 'none' | 'off'; stopReason?: 'end' | 'length' | 'other' }>;
export type WorkbenchSummarizer = (input: { model: string; prior: string; transcript: string; signal: AbortSignal; contextWindow?: number; onRequestEvent?:(event:ChatRequestEvent)=>void }) => Promise<string>;
export interface WorkbenchMemoryHooks {
  capture: (conversation: WorkbenchConversation, message: WorkbenchMessage) => Promise<WorkbenchMemory>;
  settled: (id: string) => Promise<void>;
}

async function compressOlder(model: string, prior: string, pending: WorkbenchMessage[], signal: AbortSignal, summarize?: WorkbenchSummarizer, contextWindow?: number): Promise<string> {
  if (!pending.length) return prior;
  if (!summarize) throw new Error('对话摘要服务不可用，请稍后重试');
  return compressTranscript({model,prior,transcript:pending.map(message=>`${message.role === 'user' ? '用户' : '助手'}：${summarySource(message)}`).join('\n'),signal,summarize,contextWindow});
}

function revisionPreview(messages: WorkbenchMessage[]): string {
  const text = messages.find(message => message.role === 'user' && message.text.trim())?.text ?? messages.find(message => message.text.trim())?.text ?? '';
  return text.trim().slice(0, 40);
}

export function revisionListing(conversation: Pick<WorkbenchConversation, 'revisions'>) {
  return (conversation.revisions ?? []).map(item => ({
    id: item.id,
    createdAt: item.createdAt,
    reason: item.reason,
    ...(item.preview ? { preview: item.preview } : {}),
    messageCount: item.messages.length,
    messages: [] as WorkbenchMessage[],
  }));
}

function restoredMessages(current: WorkbenchMessage[], revision: { reason: 'edit' | 'retry' | 'restore'; baseMessageId?: string; messages: WorkbenchMessage[] }): WorkbenchMessage[] {
  const suffix = structuredClone(revision.messages);
  if (revision.baseMessageId) {
    const index = current.findIndex(message => message.id === revision.baseMessageId);
    if (index < 0) throw new Error('这段历史的前文已经不在，不能安全恢复');
    return [...current.slice(0, index + 1), ...suffix];
  }
  const head = suffix[0];
  if (head) {
    const index = current.findIndex(message => message.id === head.id);
    if (index >= 0) return [...current.slice(0, index), ...suffix];
  }
  if (revision.reason === 'retry' && suffix.length > 0 && suffix.every(message => message.role === 'assistant')) {
    const turnId = suffix[0]?.turnId;
    const userIndex = turnId && suffix.every(message => message.turnId === turnId) ? current.findIndex(message => message.role === 'user' && message.turnId === turnId) : -1;
    if (userIndex >= 0) return [...current.slice(0, userIndex + 1), ...suffix];
    throw new Error('这段重新生成前的记录没有对上原来的问题，不能安全恢复');
  }
  return suffix;
}

function capRevisions<T extends { id: string }>(revisions: T[], keepId?: string): T[] {
  if (revisions.length <= 30) return revisions;
  const tail = new Set(revisions.slice(keepId ? -29 : -30).map(item => item.id));
  if (keepId) tail.add(keepId);
  return revisions.filter(item => tail.has(item.id));
}

export class WorkbenchService {
  private active = new Map<string, { abort: AbortController; promise: Promise<void>; generation: number; live: WorkbenchConversation; replyId: string; rejectReady?: (error: unknown) => void }>();
  private acceptance = new Map<string, Promise<WorkbenchConversation>>();
  private turnSerial = new Map<string, number>();
  private retiring = new Map<string, Promise<void>>();
  constructor(private store: WorkbenchStore, private models: () => WorkbenchModel[], private answer: WorkbenchAnswer, private summarize?: WorkbenchSummarizer, private attachmentIo?: {
    ocr?: (bytes: Buffer, mime: string, signal: AbortSignal) => Promise<string>;
    office?: (bytes: Buffer, name: string, signal: AbortSignal) => Promise<string>;
  }, private memoryHooks?: WorkbenchMemoryHooks) {
    for (const conversation of store.list()) {
      let changed = false;
      for (const message of conversation.messages) if (message.status === 'running') {
        message.status = 'error'; message.error = '上次生成因服务退出而中断。这只是界面恢复，模型没有接着写；已经完成的工具不会自动再执行。请重试。'; message.errorCode='service_interrupted';
        for (const call of message.toolCalls ?? []) if (call.status === 'running') { call.status = 'error'; call.error = message.error; call.completedAt = new Date().toISOString(); }
        changed = true;
      }
      if (changed) store.save(conversation);
    }
  }
  list() { return this.store.list().map(({ messages, ...row }) => ({ ...row, messageCount: messages.length, running: this.active.has(row.id), activity: activityLine(messages, this.active.has(row.id)) })); }
  get(id: string) { return this.store.get(id); }
  assistant() { return this.store.assistant(); }
  saveAssistant(input: unknown) { return this.store.saveAssistant(input); }
  private model(id?: string) {
    const models = this.models(); const model = id || models[0]?.id;
    if (!model || !models.some(item => item.id === model)) throw new Error('请先在模型服务中启用并保存普通模型');
    return model;
  }
  create(input: { model?: string; knowledge?: boolean; sourceId?: string; assistantId?: string }): WorkbenchConversation {
    const now = new Date().toISOString();
    const agent = new WorkbenchAgentStore(this.store).get(input.assistantId ?? 'main');
    const primary = !this.store.list().some(row => (row.assistantId ?? 'main') === agent.id && row.primary);
    const conversation = { id: randomUUID(), title: '新对话', assistantId: agent.id, model: input.model || agent.model || this.models()[0]?.id || '', knowledge: input.knowledge ?? agent.knowledge, sourceId: input.sourceId ?? agent.memorySourceId ?? 'default', createdAt: now, updatedAt: now, messages: [], ...(primary ? { primary: true } : {}) };
    this.store.save(conversation); return conversation;
  }
  openAssistant(assistantId = 'main'): WorkbenchConversation | null {
    const agent = new WorkbenchAgentStore(this.store).get(assistantId);
    const mine = this.store.list().filter(row => (row.assistantId ?? 'main') === agent.id);
    if (!mine.length) return null;
    const chosen = [...mine].sort((a, b) => Number(b.messages.length > 0) - Number(a.messages.length > 0) || Number(Boolean(b.primary)) - Number(Boolean(a.primary)) || b.updatedAt.localeCompare(a.updatedAt))[0]!;
    return this.adopt(chosen.id);
  }
  private adopt(id: string): WorkbenchConversation {
    const chosen = this.get(id);
    const assistantId = chosen.assistantId ?? 'main';
    for (const row of this.store.list()) {
      if ((row.assistantId ?? 'main') === assistantId && row.id !== id && row.primary) {
        delete row.primary;
        this.store.save(row);
      }
    }
    if (!chosen.primary) { chosen.primary = true; chosen.updatedAt = new Date().toISOString(); this.store.save(chosen); }
    return this.get(id);
  }
  clearTaskContext(id: string): WorkbenchConversation {
    if (this.active.has(id)) throw new Error('请先停止当前生成');
    const conversation = this.get(id);
    const last = conversation.messages.at(-1);
    if (last) conversation.contextFloor = last.id;
    delete conversation.summary;
    delete conversation.summaryUntil;
    delete conversation.summaryAssistantRevision;
    delete conversation.taskNotes;
    delete conversation.task;
    conversation.updatedAt = new Date().toISOString();
    this.store.save(conversation);
    return conversation;
  }
  undoLearnedRules(id: string, messageId: string): WorkbenchConversation {
    if (this.active.has(id)) throw new Error('请先停止当前生成');
    const conversation = this.get(id);
    const message = conversation.messages.find(item => item.id === messageId);
    const learned = message?.learnedRules?.filter(Boolean) ?? [];
    if (!message || !learned.length) throw new Error('这条更新已经撤销，或没有可撤销的规则');
    const assistantId = conversation.assistantId ?? 'main';
    const agent = new WorkbenchAgentStore(this.store).get(assistantId);
    const current = agent.standingRules ?? [];
    const replaced = message.replacedRules?.filter(Boolean) ?? [];
    const standing = [...replaced.filter(rule => !current.includes(rule)), ...current.filter(rule => !learned.includes(rule))];
    const retired = (agent.retiredRules ?? []).filter(item => !replaced.includes(item.text) && !standing.includes(item.text));
    new WorkbenchAgentStore(this.store).rememberRules(assistantId, standing, retired);
    message.ruleNotice = '已撤销刚记下的工作规则';
    delete message.learnedRules;
    delete message.replacedRules;
    conversation.updatedAt = new Date().toISOString();
    this.store.save(conversation);
    return this.get(id);
  }
  rename(id: string, title: string) {
    if (this.active.has(id)) throw new Error('请先停止当前生成');
    if (typeof title !== 'string' || !title.trim() || title.length > 120) throw new Error('会话标题需为 1–120 个字符');
    const conversation = this.get(id); conversation.title = title.trim(); conversation.updatedAt = new Date().toISOString(); this.store.save(conversation); return conversation;
  }
  remove(id: string, emptyOnly = false) {
    if (this.active.has(id)) throw new Error('请先停止当前生成');
    if (emptyOnly && this.get(id).messages.length) throw new Error('会话已有消息，不能自动清理');
    this.store.remove(id);
  }
  private owns(id: string, generation: number) { return this.turnSerial.get(id) === generation; }
  private releaseTurn(id: string) {
    const current = this.active.get(id);
    if (!current) return;
    current.abort.abort();
    const reply = current.live.messages.find(message => message.id === current.replyId);
    if (reply?.status === 'running') {
      reply.status = 'cancelled';
      delete reply.stage;
      for (const call of reply.toolCalls ?? []) if (call.status === 'running') { call.status = 'cancelled'; call.error = '已停止'; call.completedAt = new Date().toISOString(); }
      current.live.updatedAt = new Date().toISOString();
      this.store.save(current.live);
    }
    this.turnSerial.set(id, current.generation + 1);
    if (current.promise) {
      const previous = this.retiring.get(id);
      this.retiring.set(id, previous ? previous.then(() => current.promise) : current.promise);
    }
    this.active.delete(id);
    this.acceptance.delete(id);
    current.rejectReady?.(Object.assign(new Error('已停止生成'), { name: 'AbortError' }));
  }
  send(id: string, input: { text?: string; model?: string; knowledge?: boolean; retry?: boolean; editMessageId?: string; attachments?: unknown; attachmentsHydrated?: boolean; interrupt?: boolean }) {
    if (this.active.has(id)) {
      if (input.interrupt !== true) throw new Error('当前会话正在生成，请等待或停止');
      this.releaseTurn(id);
    }
    const conversation = this.get(id); const model = this.model(input.model ?? conversation.model);
    if(this.memoryHooks&&!conversation.sourceId)conversation.sourceId='default';
    const now = new Date().toISOString();
    const attachmentFlags = { vision: this.models().find(item => item.id === model)?.vision === true, pdfNative: modelReadsPdfNatively() };
    const snapshot = JSON.stringify(conversation);
    const previousAttachmentIds = new Set(conversation.messages.flatMap(message => (message.attachments ?? []).map(item => item.id)));
    let settledTools: WorkbenchToolCall[] | undefined;
    let carriedNotice: string | undefined;
    let carriedRules: string[] | undefined;
    let carriedReplaced: string[] | undefined;
    let carriedPlaybookNotice: string | undefined;
    let carriedPlaybook: string | undefined;
    if (input.editMessageId) {
      const index = conversation.messages.findIndex(message => message.id === input.editMessageId);
      const target = conversation.messages[index];
      if (!target || target.role !== 'user') throw new Error('只能修改你发送的问题');
      const nextAttachments = input.attachments === undefined ? undefined : resolveListedAttachments(input.attachments, target.attachments ?? [], attachmentFlags);
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (text.length > 32000) throw new Error('请输入 1–32000 个字符');
      const kept = nextAttachments
        ? (input.attachmentsHydrated === true ? nextAttachments.length : (target.attachments?.length ?? 0) + nextAttachments.filter(item => !(target.attachments ?? []).some(current => current.id === item.id)).length)
        : (target.attachments?.length ?? 0);
      if (!text && !kept) throw new Error('请输入 1–32000 个字符');
      const previous = target.text;
      conversation.revisions ??= [];
      const removed = conversation.messages.slice(index);
      const baseMessageId = index > 0 ? conversation.messages[index - 1]!.id : undefined;
      conversation.revisions.push({ id: randomUUID(), createdAt: now, reason: 'edit', preview: revisionPreview(removed), ...(baseMessageId ? { baseMessageId } : {}), messages: structuredClone(removed) });
      conversation.revisions = capRevisions(conversation.revisions);
      target.text = text;
      delete target.memory;
      if (nextAttachments) this.applyEditedAttachments(conversation.id, target, nextAttachments, input.attachmentsHydrated === true);
      conversation.messages.splice(index + 1);
      if (index === 0 && (conversation.title === '新对话' || conversation.title === previous.slice(0, 40))) conversation.title = (text || nextAttachments?.[0]?.name || previous).slice(0, 40);
      if (conversation.summaryUntil) {
        const anchor = conversation.messages.findIndex(message => message.id === conversation.summaryUntil);
        if (anchor === -1 || anchor >= index) { delete conversation.summary; delete conversation.summaryUntil; delete conversation.summaryAssistantRevision; }
      }
    } else if (input.retry) {
      const previousReply = conversation.messages.at(-1);
      if (previousReply?.role !== 'assistant') throw new Error('没有可重新生成的回答');
      carriedNotice = previousReply.ruleNotice;
      carriedRules = previousReply.learnedRules;
      carriedReplaced = previousReply.replacedRules;
      carriedPlaybookNotice = previousReply.playbookNotice;
      carriedPlaybook = previousReply.savedPlaybook;
      settledTools = previousReply.toolCalls?.filter(call => call.status === 'complete');
      conversation.revisions ??= [];
      const baseMessageId = conversation.messages.at(-2)?.id;
      conversation.revisions.push({ id: randomUUID(), createdAt: now, reason: 'retry', preview: revisionPreview([previousReply]), ...(baseMessageId ? { baseMessageId } : {}), messages: [structuredClone(previousReply)] });
      conversation.revisions = capRevisions(conversation.revisions);
      conversation.messages.pop();
    } else {
      const nextAttachments = incomingAttachments(input.attachments, attachmentFlags);
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (text.length > 32000 || (!text && !nextAttachments.length)) throw new Error('请输入 1–32000 个字符');
      conversation.messages.push({ id: randomUUID(), role: 'user', text, createdAt: now, status: 'complete', ...(nextAttachments.length ? { attachments: nextAttachments } : {}) });
      if (conversation.messages.length === 1) conversation.title = (text || nextAttachments[0]?.name || '\u9644\u4ef6').slice(0, 40);
    }
    conversation.model = model; conversation.knowledge = input.knowledge ?? conversation.knowledge; conversation.updatedAt = now;
    const turnId = randomUUID();
    const currentUser = [...conversation.messages].reverse().find(message => message.role === 'user');
    if (currentUser) currentUser.turnId = turnId;
    const agentBefore = structuredClone(new WorkbenchAgentStore(this.store).get(conversation.assistantId ?? 'main'));
    let assistant = agentBefore;
    let turnScope: ReturnType<typeof learnTurn>['scope'] | undefined;
    let ruleNotice = carriedNotice;
    let learnedRules = carriedRules?.filter(Boolean);
    let replacedRules = carriedReplaced?.filter(Boolean);
    let taskInherited = false;
    let playbookNotice = carriedPlaybookNotice;
    let savedPlaybook = carriedPlaybook;
    if (!input.retry) {
      const spoken = [...conversation.messages].reverse().find(message => message.role === 'user');
      if (spoken?.text) {
        const floor = conversation.contextFloor ? conversation.messages.findIndex(message => message.id === conversation.contextFloor) : -1;
        const recentUserTexts = conversation.messages.filter((message, index) => message.role === 'user' && message.id !== spoken.id && index > floor).map(message => message.text);
        const advanced = advanceTask({ task: conversation.task, notes: conversation.taskNotes, text: spoken.text, recentUserTexts, agent: assistant, now, id: () => randomUUID() });
        taskInherited = advanced.inherited;
        if (advanced.task) conversation.task = advanced.task;
        if (advanced.opened) delete conversation.taskNotes;
        if (wantsSavedPlaybook(spoken.text)) {
          const playbook = compilePlaybook({ name: assistant.name, workflow: assistant.workflow, standingRules: assistant.standingRules, deliveryFormat: assistant.deliveryFormat, recentUserTexts });
          assistant = new WorkbenchAgentStore(this.store).rememberPlaybook(assistant.id, playbook);
          playbookNotice = `已把这次存成「${playbook.name}」的做法`;
          savedPlaybook = playbook.name;
          turnScope = 'once';
        } else {
          const learning = learnTurn({ name: assistant.name, standingRules: assistant.standingRules, recentUserTexts, text: spoken.text });
          turnScope = learning.scope;
          ruleNotice = learning.notice;
          learnedRules = learning.added;
          if (learning.replaced.length) replacedRules = learning.replaced.map(item => item.text);
          let onceNote: string | undefined;
          if (learning.scope === 'once' && learning.taskNote) {
            onceNote = learning.taskNote;
            const constraints = [...new Set([...(conversation.task?.constraints ?? []), learning.taskNote])].slice(-8);
            conversation.task = conversation.task ? { ...conversation.task, constraints, updatedAt: now } : { id: randomUUID(), goal: compactRule(learning.taskNote), constraints, updatedAt: now };
            conversation.taskNotes = constraints;
          } else if (conversation.task) {
            if (conversation.task.constraints.length) conversation.taskNotes = [...conversation.task.constraints];
            else delete conversation.taskNotes;
          }
          if (learning.scope === 'correction' && conversation.task && learning.added.length) conversation.task = { ...conversation.task, decisions: [...new Set([...(conversation.task.decisions ?? []), ...learning.added])].slice(-8), updatedAt: now };
          if (learning.replaced.length || learning.rules.join('\n') !== (assistant.standingRules ?? []).join('\n')) {
            const retired = [...(assistant.retiredRules ?? []).filter(item => !learning.rules.includes(item.text) && !learning.replaced.some(next => next.text === item.text)), ...learning.replaced];
            assistant = new WorkbenchAgentStore(this.store).rememberRules(assistant.id, learning.rules, retired);
          }
          if (conversation.task?.sources) {
            const liveIds = new Set(conversation.messages.map(message => message.id));
            conversation.task = { ...conversation.task, sources: conversation.task.sources.filter(item => liveIds.has(item.messageId)) };
          }
          if (conversation.task && onceNote) conversation.task = noteTask(conversation.task, { messageId: spoken.id, opened: advanced.opened, inherited: advanced.inherited, constraint: onceNote });
        }
        if (conversation.task && turnScope !== 'once') {
          const liveIds = new Set(conversation.messages.map(message => message.id));
          if (conversation.task.sources?.some(item => !liveIds.has(item.messageId))) conversation.task = { ...conversation.task, sources: conversation.task.sources.filter(item => liveIds.has(item.messageId)) };
          conversation.task = noteTask(conversation.task, { messageId: spoken.id, opened: advanced.opened, inherited: advanced.inherited });
        } else if (conversation.task?.sources?.some(item => !conversation.messages.some(message => message.id === item.messageId))) {
          const liveIds = new Set(conversation.messages.map(message => message.id));
          conversation.task = { ...conversation.task, sources: conversation.task.sources!.filter(item => liveIds.has(item.messageId)) };
        }
      }
    }
    const contextWindow = this.models().find(item => item.id === model)?.contextWindow;
    const modelName = this.models().find(item => item.id === model)?.name || model;
    const hasAttachments = conversation.messages.some(message => message.attachments?.length);
    const reply: WorkbenchMessage = {
      id: randomUUID(), role: 'assistant', text: '', createdAt: now, status: 'running', model, modelName, turnId,
      stage: hasAttachments ? '正在读取附件' : '正在准备回答', ...(ruleNotice ? { ruleNotice } : {}), ...(learnedRules?.length ? { learnedRules } : {}), ...(replacedRules?.length ? { replacedRules } : {}), ...(playbookNotice ? { playbookNotice } : {}), ...(savedPlaybook ? { savedPlaybook } : {}),
    };
    conversation.messages.push(reply); this.store.save(conversation);
    const generation = (this.turnSerial.get(id) ?? 0) + 1;
    this.turnSerial.set(id, generation);
    const abort = new AbortController();
    const session=assistantSession(model,abort.signal);
    let opened = false;
    let acceptReady!: (value: WorkbenchConversation) => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<WorkbenchConversation>((resolve, reject) => { acceptReady = resolve; rejectReady = reject; });
    ready.catch(() => undefined);
    const turn = { abort, promise: Promise.resolve(), generation, live: conversation, replyId: reply.id, rejectReady };
    this.acceptance.set(id, ready);
    this.active.set(id, turn);
    let lastSave = 0;
    const saveSoon = (force = false) => {
      if (!this.owns(id, generation)) return;
      if (abort.signal.aborted && !force) return;
      const nowMs = Date.now();
      if (!force && lastSave !== 0 && nowMs - lastSave < 80) return;
      lastSave = nowMs; this.store.save(conversation);
    };
    const reportRequest=(event:ChatRequestEvent)=>{
      if(abort.signal.aborted||reply.status!=='running'||(session.signal.aborted&&event.phase!=='failed'))return;
      reply.request=event;
      if(event.phase==='complete'||event.phase==='failed'){
        reply.requestHistory??=[];reply.requestHistory.push(event);
        if(reply.requestHistory.length>48)reply.requestHistory.shift();
      }
      saveSoon();
    };
    const summarizer=this.summarize?async(value:Parameters<WorkbenchSummarizer>[0])=>this.summarize!({...value,onRequestEvent:reportRequest}):undefined;
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        const userTurn = [...conversation.messages].reverse().find(message => message.role === 'user');
        try {
          await this.prepareTurnAttachments(conversation, attachmentFlags, session.signal);
          session.signal.throwIfAborted();
          if (abort.signal.aborted) throw Object.assign(new Error('已停止生成'), { name: 'AbortError' });
          const moved = input.retry ? [] : advanceStoredReads(conversation.messages, userTurn?.text ?? '');
          if (!input.retry && userTurn && this.memoryHooks && turnScope !== 'once') {
            try { userTurn.memory = await this.memoryHooks.capture(conversation, userTurn); }
            catch (error) { userTurn.memory = { sourceId: conversation.sourceId ?? 'default', hash: memoryVersion(userTurn), capturedAt: userTurn.createdAt, mode: 'off', visibility: 'private', ttl: '3d', status: 'held', error: error instanceof Error ? error.message : String(error) }; }
          }
          if (moved.length && userTurn) userTurn.attachmentSupplement = moved.map(item => item.excerpt).join('\n\n');
          this.dropRemovedAttachments(snapshot, conversation);
          saveSoon(true);
          opened = true;
          acceptReady(conversation);
        } catch (error) {
          if (!this.owns(id, generation)) {
            if (!opened) rejectReady(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          if (!opened) {
            this.rollback(conversation, snapshot, previousAttachmentIds);
            new WorkbenchAgentStore(this.store).replace(agentBefore);
            const failure = error instanceof Error && error.name === 'AbortError' ? new Error('已停止生成') : error;
            rejectReady(failure instanceof Error ? failure : new Error(String(failure)));
            return;
          }
          throw error;
        }
        if (conversation.summary && typeof conversation.summaryAssistantRevision === 'number' && conversation.summaryAssistantRevision !== assistant.revision) {
          delete conversation.summary;
          delete conversation.summaryUntil;
          delete conversation.summaryAssistantRevision;
        }
        const priorCitations=conversationCitations(conversation.messages);
        const outputReserve=requestOutputTokens(model,contextWindow);
        const contextOptions = { contextWindow,outputReserve, summaryUntil: conversation.summaryUntil, contextFloor: conversation.contextFloor, systemPrompt: assistant.systemPrompt, additionalTokens: conversation.knowledge ? knowledgeReserve(contextWindow, assistant.context.threshold,outputReserve) : 0 };
        let { recent, older } = planContext(conversation.messages, assistant.context, { ...contextOptions, summary: conversation.summary });
        const olderTurns = older.filter(message => message.role === 'user').length;
        reply.contextMessages = recent.length;
        let summary = conversation.summary;
        if (older.length) {
          let prior = conversation.summary ?? '';
          let pending = older;
          if (conversation.summaryUntil) {
            const anchor = older.findIndex(message => message.id === conversation.summaryUntil);
            if (anchor >= 0) pending = older.slice(anchor + 1);
            else if (!conversation.messages.some(message => message.id === conversation.summaryUntil)) prior = '';
          }
          const aligned = pending.length > 0 && pending.every(message => message.role === 'assistant') && Boolean(prior);
          if ((pending.length || !prior) && !aligned) {
            reply.stage = '正在压缩更早的对话';
            saveSoon(true);
            const summaryModel = assistant.context.summaryModel;
            const summarizerModel = summaryModel && this.models().some(item => item.id === summaryModel) ? summaryModel : model;
            const compressed = await compressOlder(summarizerModel, prior, pending.map(message=>referenceProjection(message,priorCitations)), session.signal, summarizer, this.models().find(item => item.id === summarizerModel)?.contextWindow);
            if (abort.signal.aborted) return;
            summary = compressed;
            conversation.summary = summary;
            conversation.summaryUntil = older[older.length - 1]!.id;
            conversation.summaryAssistantRevision = assistant.revision;
            contextOptions.summaryUntil = conversation.summaryUntil;
            saveSoon(true);
          } else summary = prior;
          if (olderTurns) reply.contextNote = `更早的 ${olderTurns} 轮已压缩为摘要，仍会参与这次回答`;
        }
        for (let attempt = 0; attempt < conversation.messages.length; attempt++) {
          const planned = planContext(conversation.messages, assistant.context, { ...contextOptions, summary });
          const extra = planned.older.filter(message => !older.some(item => item.id === message.id));
          recent = planned.recent;
          if (!extra.length) break;
          const summaryModel = assistant.context.summaryModel;
          const summarizerModel = summaryModel && this.models().some(item => item.id === summaryModel) ? summaryModel : model;
          summary = await compressOlder(summarizerModel, summary ?? '', extra.map(message=>referenceProjection(message,priorCitations)), session.signal, summarizer, this.models().find(item => item.id === summarizerModel)?.contextWindow);
          older = planned.older;
          conversation.summary = summary;
          conversation.summaryUntil = older.at(-1)?.id;
          conversation.summaryAssistantRevision = assistant.revision;
          contextOptions.summaryUntil = conversation.summaryUntil;
          saveSoon(true);
        }
        reply.contextMessages = recent.length;
        const coveredTurns = older.filter(message => message.role === 'user').length;
        if (coveredTurns) reply.contextNote = `更早的 ${coveredTurns} 轮已压缩为摘要，仍会参与这次回答`;
        const recentIds = new Set(recent.map(message => message.id));
        const spokenTurn = [...conversation.messages].reverse().find(message => message.role === 'user');
        if (!input.retry && spokenTurn) {
          const named = [namedAttachmentSupplement(conversation.messages, spokenTurn.text, recentIds), taskRecognizedSupplement(conversation.messages, conversation.task, recentIds)].filter(Boolean).join('\n\n');
          if (named && !spokenTurn.attachmentSupplement?.includes(named)) spokenTurn.attachmentSupplement = [spokenTurn.attachmentSupplement, named].filter(Boolean).join('\n\n');
        }
        const modelSeesImages = this.models().find(item => item.id === model)?.vision === true;
        const visuals = taskVisualAttachments(this.modelMessages(conversation.id, conversation.messages), conversation.task, recentIds);
        if (!modelSeesImages) {
          visuals.omitted.unshift(...visuals.kept.map(item => ({ messageId: item.messageId, name: item.name })));
          visuals.kept.length = 0;
        }
        const visualItems = [...visuals.kept.map(item => ({ kind: 'image', ref: item.name, state: 'kept' as const })), ...visuals.omitted.map(item => ({ kind: 'image', ref: item.name, state: 'omitted' as const }))];
        const compressionModel = assistant.context.summaryModel && this.models().some(item => item.id === assistant.context.summaryModel) ? assistant.context.summaryModel : model;
        const result = await this.answer({
          agent: assistant, messageId: reply.id,
          contextWindow, contextThreshold: assistant.context.threshold,
          ...(this.summarize ? { contextSummarizer: { model: compressionModel, contextWindow: this.models().find(item => item.id === compressionModel)?.contextWindow, summarize: this.summarize } } : {}),
          sourceId: conversation.sourceId, conversationId: conversation.id,
          messages: this.modelMessages(conversation.id, recent), ...(summary ? { summary } : {}), ...(conversation.taskNotes?.length ? { taskNotes: conversation.taskNotes } : {}), ...(conversation.task ? { task: conversation.task } : {}), taskMethod: taskInherited, ...(conversation.knowledge?{priorCitations}:{}), ...(visuals.kept.length ? { visualAttachments: visuals.kept.map(({ name, mime, image }) => ({ name, mime, image })) } : {}), ...(settledTools?.length ? { settledTools } : {}), model, knowledge: conversation.knowledge,
          ...(assistant.systemPrompt.trim() ? { systemPrompt: assistant.systemPrompt } : {}),
          ...(assistant.temperature !== null ? { temperature: assistant.temperature } : {}),
          signal: session.signal,
          progress: stage => { if (session.signal.aborted) return; reply.stage = stage; saveSoon(true); },
          onDelta: delta => {
            if (session.signal.aborted || !delta) return;
            const first = reply.text.length === 0;
            reply.text += delta;
            saveSoon(first);
          },
          onReplace: (text, nextModel) => {
            if (session.signal.aborted) return;
            reply.text = text; reply.model = nextModel;
            reply.modelName = this.models().find(item => item.id === nextModel)?.name || nextModel;
            saveSoon(true);
          },
          onTool: call => {
            if (session.signal.aborted) return;
            reply.toolCalls ??= [];
            const index = reply.toolCalls.findIndex(item => item.id === call.id);
            if (index < 0) reply.toolCalls.push({ ...call }); else reply.toolCalls[index] = { ...call };
            saveSoon(true);
          },
          onContext: note => { if (!session.signal.aborted) { reply.contextNote = note; saveSoon(true); } },
          onRequestEvent:reportRequest,
        });
        session.signal.throwIfAborted();
        if (!abort.signal.aborted && this.owns(id, generation)) {
          if (!result.text.trim()) throw new Error('模型未返回可用回答，已有工具结果和完整会话已保留，请重试。');
          const citations = result.citations ?? [];
          const spoken = [...conversation.messages].reverse().find(message => message.role === 'user');
          let knowledge = result.knowledge ?? (conversation.knowledge ? (citations.length ? 'used' : 'none') : 'off');
          let text = visibleAssistantText(result.text, reply.toolCalls);
          const evidenceTask = !wantsSavedPlaybook(spoken?.text ?? '') && (needsCurrentEvidence(spoken?.text ?? '') || needsCurrentEvidence(conversation.task?.goal ?? ''));
          const evidenceGap = evidenceTask && knowledge !== 'off' && citations.length === 0;
          if (evidenceGap) { text = EVIDENCE_GAP_TEXT; knowledge = 'none'; reply.evidenceGap = true; }
          else delete reply.evidenceGap;
          reply.contextManifest = {
            assistantRevision: assistant.revision,
            ...(conversation.task ? { task: { id: conversation.task.id, goal: conversation.task.goal, inherited: taskInherited, constraints: [...conversation.task.constraints] } } : {}),
            rules: [
              ...(assistant.standingRules ?? []).map(rule => ({ text: rule, state: 'active' as const })),
              ...(assistant.retiredRules ?? []).map(rule => ({ text: rule.text, state: 'replaced' as const, replacedBy: rule.replacedBy })),
            ],
            knowledge: conversation.knowledge,
            evidenceTask,
            citations: citations.length,
            budget: { window: contextWindow ?? 32000, inputBudget: contextBudget(contextWindow, assistant.context.threshold, outputReserve), outputReserve },
            ...(reply.turnId ? { turnId: reply.turnId } : {}),
            ...(reply.contextNote ? { omitted: [reply.contextNote] } : {}),
            ...(visualItems.length ? { items: visualItems } : {}),
          };
          reply.text = text;
          reply.model = result.model || model;
          reply.modelName = this.models().find(item => item.id === reply.model)?.name || reply.modelName;
          reply.citations = citations;
          reply.knowledge = knowledge;
          if (result.stopReason) reply.stopReason = result.stopReason;
          reply.status = 'complete';
          reply.artifacts = evidenceGap ? [] : new WorkbenchAgentStore(this.store).artifacts().filter(item => item.conversationId === id && item.messageId === reply.id).map(({ id: artifactId, title, format, publishedPath }) => ({ id: artifactId, title, format, publishedPath }));
          if (conversation.task) {
            if (evidenceGap) conversation.task = { ...conversation.task, openItems: [...new Set([...(conversation.task.openItems ?? []), '本期材料还没齐'])].slice(-8) };
            else if (citations.length && conversation.task.openItems?.includes('本期材料还没齐')) {
              const openItems = conversation.task.openItems.filter(item => item !== '本期材料还没齐');
              const next = { ...conversation.task };
              if (openItems.length) next.openItems = openItems;
              else delete next.openItems;
              conversation.task = next;
            }
            const delivered = (reply.artifacts ?? []).map(item => item.publishedPath || item.title).filter((item): item is string => Boolean(item));
            if (delivered.length) conversation.task = { ...conversation.task, deliveries: [...new Set([...(conversation.task.deliveries ?? []), ...delivered])].slice(-8) };
          }
        }
      } catch (error) { if (opened && this.owns(id, generation) && !abort.signal.aborted) { const failure = contextFailure(error); reply.status = 'error'; reply.error = failure.message; reply.errorCode = failure.code; } }
      finally {
        session.close();
        const mine = this.owns(id, generation);
        if (mine && opened) {
          if (abort.signal.aborted) reply.status = 'cancelled';
          for (const call of reply.toolCalls ?? []) if (call.status === 'running') { call.status = abort.signal.aborted ? 'cancelled' : 'error'; call.error = abort.signal.aborted ? '已停止' : reply.error || '工具执行中断'; call.completedAt = new Date().toISOString(); }
          delete reply.stage;
          conversation.updatedAt = new Date().toISOString();
          this.store.save(conversation);
        }
        if (this.active.get(id)?.generation === generation) this.active.delete(id);
        if (mine) this.acceptance.delete(id);
        if (this.retiring.get(id) === promise) this.retiring.delete(id);
        if (mine && opened && this.memoryHooks) await this.memoryHooks.settled(id).catch(error => console.error('[workbench memory]', error));
      }
    })();
    turn.promise = promise;
    return conversation;
  }
  cancel(id: string) {
    this.releaseTurn(id);
    const conversation = this.get(id); const reply = conversation.messages.at(-1);
    if (reply?.status === 'running') { reply.status = 'cancelled'; delete reply.stage; for (const call of reply.toolCalls ?? []) if (call.status === 'running') { call.status = 'cancelled'; call.error = '已停止'; call.completedAt = new Date().toISOString(); } this.store.save(conversation); }
    return conversation;
  }
  async settled(id: string) {
    const current = this.active.get(id)?.promise;
    if (current) { await current; return; }
    const leftover = this.retiring.get(id);
    if (leftover) await leftover;
  }
  accepted(id: string): Promise<WorkbenchConversation> {
    const pending = this.acceptance.get(id);
    if (!pending) throw new Error('发送还没有开始');
    return pending;
  }

  private applyEditedAttachments(_conversationId: string, target: WorkbenchMessage, listed: WorkbenchMessage['attachments'], hydrated: boolean) {
    const next = listed ?? [];
    if (hydrated) {
      if (next.length) target.attachments = next;
      else delete target.attachments;
      return;
    }
    const have = new Set((target.attachments ?? []).map(item => item.id));
    const added = next.filter(item => !have.has(item.id));
    if (!added.length) return;
    target.attachments = [...(target.attachments ?? []), ...added];
  }
  private async prepareTurnAttachments(conversation: WorkbenchConversation, flags: { vision: boolean; pdfNative: boolean }, signal: AbortSignal) {
    const items = conversation.messages.flatMap(message => message.attachments ?? []);
    if (!items.length) return;
    for (const item of items) {
      const next = attachmentRead({ name: item.name, mime: item.mime, vision: flags.vision, pdfNative: flags.pdfNative });
      if (item.route === next && (next === 'vision' || next === 'pdf-file' || item.text || item.note)) continue;
      item.route = next;
      if (next === 'vision' || !item.text) delete item.note;
    }
    await enrichAttachments(items, {
      signal,
      read: item => this.store.readAttachment(conversation.id, item.id),
      ...(this.attachmentIo?.ocr ? { ocr: this.attachmentIo.ocr } : {}),
      ...(this.attachmentIo?.office ? { office: this.attachmentIo.office } : {}),
    });
  }
  private dropRemovedAttachments(snapshot: string, conversation: WorkbenchConversation) {
    const previous = JSON.parse(snapshot) as WorkbenchConversation;
    const keep = new Set([...conversation.messages, ...(conversation.revisions ?? []).flatMap(item => item.messages)].flatMap(message => (message.attachments ?? []).map(item => item.id)));
    for (const message of previous.messages) for (const item of message.attachments ?? []) {
      if (!keep.has(item.id)) this.store.deleteAttachment(conversation.id, item.id);
    }
  }
  private rollback(conversation: WorkbenchConversation, snapshot: string, previousIds: Set<string>) {
    for (const message of conversation.messages) for (const item of message.attachments ?? []) {
      if (!previousIds.has(item.id)) this.store.deleteAttachment(conversation.id, item.id);
    }
    const restored = JSON.parse(snapshot) as WorkbenchConversation;
    conversation.messages = restored.messages;
    conversation.revisions = restored.revisions;
    conversation.title = restored.title;
    conversation.model = restored.model;
    conversation.knowledge = restored.knowledge;
    conversation.updatedAt = restored.updatedAt;
    if (restored.summary) conversation.summary = restored.summary;
    else delete conversation.summary;
    if (restored.summaryUntil) conversation.summaryUntil = restored.summaryUntil;
    else delete conversation.summaryUntil;
    if (typeof restored.summaryAssistantRevision === 'number') conversation.summaryAssistantRevision = restored.summaryAssistantRevision;
    else delete conversation.summaryAssistantRevision;
    if (restored.task) conversation.task = restored.task;
    else delete conversation.task;
    if (restored.taskNotes) conversation.taskNotes = restored.taskNotes;
    else delete conversation.taskNotes;
    this.store.save(conversation);
  }
  restoreRevision(id: string, revisionId: string): WorkbenchConversation {
    if (this.active.has(id)) throw new Error('请先停止当前生成');
    const conversation = this.get(id);
    const revision = conversation.revisions?.find(item => item.id === revisionId);
    if (!revision) throw new Error('这段历史不存在');
    const snapshot = JSON.stringify(conversation);
    const restoredAt = new Date().toISOString();
    const nextMessages = restoredMessages(conversation.messages, revision);
    conversation.revisions ??= [];
    conversation.revisions.push({ id: randomUUID(), createdAt: restoredAt, reason: 'restore', preview: revisionPreview(conversation.messages), messages: structuredClone(conversation.messages) });
    conversation.messages = nextMessages;
    conversation.revisions = capRevisions(conversation.revisions, revisionId);
    delete conversation.summary;
    delete conversation.summaryUntil;
    delete conversation.summaryAssistantRevision;
    const live = new Set(conversation.messages.map(message => message.id));
    if (conversation.task?.sources?.some(item => !live.has(item.messageId))) {
      delete conversation.task;
      delete conversation.taskNotes;
    }
    conversation.updatedAt = restoredAt;
    this.dropRemovedAttachments(snapshot, conversation);
    this.store.save(conversation);
    return this.get(id);
  }
  private modelMessages(conversationId: string, messages: WorkbenchMessage[]): WorkbenchMessage[] {
    return messages.map(message => {
      if (!message.attachments?.length) return message;
      return {
        ...message,
        attachments: message.attachments.map(item => {
          if (item.data || (item.route !== 'vision' && item.route !== 'pdf-file')) return item;
          const bytes = this.store.readAttachment(conversationId, item.id);
          return bytes ? { ...item, data: bytes.toString('base64') } : item;
        }),
      };
    });
  }
}
