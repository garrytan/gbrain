import { randomUUID } from 'node:crypto';
import type { WorkbenchCitation, WorkbenchConversation, WorkbenchMemory, WorkbenchMessage, WorkbenchModel, WorkbenchToolCall } from '../../../shared/workbench';
import { advanceStoredReads, attachmentRead, enrichAttachments, incomingAttachments, resolveListedAttachments, summarySource, modelReadsPdfNatively } from './attachments';
import { knowledgeReserve, planContext,conversationCitations,referenceProjection } from './context';
import { WorkbenchStore } from './store';
import { compressTranscript, contextFailure,requestOutputTokens } from './context-runtime';
import type {ChatRequestEvent} from '../../core/ai/chat-request-runtime';
import {assistantSession} from './request';

export { conversationContext } from './context';

export interface WorkbenchAnswerInput {
  sourceId?: string;
  conversationId?: string;
  messages: WorkbenchMessage[];
  summary?: string;
  priorCitations?: WorkbenchCitation[];
  model: string;
  knowledge: boolean;
  systemPrompt?: string;
  temperature?: number;
  contextWindow?: number;
  contextThreshold?: number;
  signal: AbortSignal;
  attachmentSupplement?: string;
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

export class WorkbenchService {
  private active = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  private acceptance = new Map<string, Promise<WorkbenchConversation>>();
  constructor(private store: WorkbenchStore, private models: () => WorkbenchModel[], private answer: WorkbenchAnswer, private summarize?: WorkbenchSummarizer, private attachmentIo?: {
    ocr?: (bytes: Buffer, mime: string, signal: AbortSignal) => Promise<string>;
    office?: (bytes: Buffer, name: string, signal: AbortSignal) => Promise<string>;
  }, private memoryHooks?: WorkbenchMemoryHooks) {
    for (const conversation of store.list()) {
      let changed = false;
      for (const message of conversation.messages) if (message.status === 'running') {
        message.status = 'error'; message.error = '上次生成因服务退出而中断，请重试。'; message.errorCode='service_interrupted';
        for (const call of message.toolCalls ?? []) if (call.status === 'running') { call.status = 'error'; call.error = message.error; call.completedAt = new Date().toISOString(); }
        changed = true;
      }
      if (changed) store.save(conversation);
    }
  }
  list() { return this.store.list().map(({ messages, ...row }) => ({ ...row, messageCount: messages.length, running: this.active.has(row.id) })); }
  get(id: string) { return this.store.get(id); }
  assistant() { return this.store.assistant(); }
  saveAssistant(input: unknown) { return this.store.saveAssistant(input); }
  private model(id?: string) {
    const models = this.models(); const model = id || models[0]?.id;
    if (!model || !models.some(item => item.id === model)) throw new Error('请先在模型服务中启用并保存普通模型');
    return model;
  }
  create(input: { model?: string; knowledge?: boolean; sourceId?: string }): WorkbenchConversation {
    const now = new Date().toISOString();
    const conversation = { id: randomUUID(), title: '新对话', model: input.model || this.models()[0]?.id || '', knowledge: input.knowledge !== false, sourceId: input.sourceId ?? this.assistant().memorySourceId ?? 'default', createdAt: now, updatedAt: now, messages: [] };
    this.store.save(conversation); return conversation;
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
  send(id: string, input: { text?: string; model?: string; knowledge?: boolean; retry?: boolean; editMessageId?: string; attachments?: unknown; attachmentsHydrated?: boolean }) {
    if (this.active.has(id)) throw new Error('当前会话正在生成，请等待或停止');
    const conversation = this.get(id); const model = this.model(input.model ?? conversation.model);
    if(this.memoryHooks&&!conversation.sourceId)conversation.sourceId='default';
    const now = new Date().toISOString();
    const attachmentFlags = { vision: this.models().find(item => item.id === model)?.vision === true, pdfNative: modelReadsPdfNatively() };
    const snapshot = JSON.stringify(conversation);
    const previousAttachmentIds = new Set(conversation.messages.flatMap(message => (message.attachments ?? []).map(item => item.id)));
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
      conversation.revisions.push({ id: randomUUID(), createdAt: now, reason: 'edit', messages: structuredClone(conversation.messages.slice(index)) });
      target.text = text;
      delete target.memory;
      if (nextAttachments) this.applyEditedAttachments(conversation.id, target, nextAttachments, input.attachmentsHydrated === true);
      conversation.messages.splice(index + 1);
      if (index === 0 && (conversation.title === '新对话' || conversation.title === previous.slice(0, 40))) conversation.title = (text || nextAttachments?.[0]?.name || previous).slice(0, 40);
      if (conversation.summaryUntil) {
        const anchor = conversation.messages.findIndex(message => message.id === conversation.summaryUntil);
        if (anchor === -1 || anchor >= index) { delete conversation.summary; delete conversation.summaryUntil; }
      }
    } else if (input.retry) {
      if (conversation.messages.at(-1)?.role !== 'assistant') throw new Error('没有可重新生成的回答');
      conversation.revisions ??= [];
      conversation.revisions.push({ id: randomUUID(), createdAt: now, reason: 'retry', messages: [structuredClone(conversation.messages.at(-1)!)] });
      conversation.messages.pop();
    } else {
      const nextAttachments = incomingAttachments(input.attachments, attachmentFlags);
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (text.length > 32000 || (!text && !nextAttachments.length)) throw new Error('请输入 1–32000 个字符');
      conversation.messages.push({ id: randomUUID(), role: 'user', text, createdAt: now, status: 'complete', ...(nextAttachments.length ? { attachments: nextAttachments } : {}) });
      if (conversation.messages.length === 1) conversation.title = (text || nextAttachments[0]?.name || '\u9644\u4ef6').slice(0, 40);
    }
    conversation.model = model; conversation.knowledge = input.knowledge ?? conversation.knowledge; conversation.updatedAt = now;
    const assistant = this.store.assistant();
    const contextWindow = this.models().find(item => item.id === model)?.contextWindow;
    const modelName = this.models().find(item => item.id === model)?.name || model;
    const hasAttachments = conversation.messages.some(message => message.attachments?.length);
    const reply: WorkbenchMessage = {
      id: randomUUID(), role: 'assistant', text: '', createdAt: now, status: 'running', model, modelName,
      stage: hasAttachments ? '正在读取附件' : '正在准备回答',
    };
    conversation.messages.push(reply); this.store.save(conversation);
    const abort = new AbortController();
    const session=assistantSession(model,abort.signal);
    let opened = false;
    let acceptReady!: (value: WorkbenchConversation) => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<WorkbenchConversation>((resolve, reject) => { acceptReady = resolve; rejectReady = reject; });
    ready.catch(() => undefined);
    this.acceptance.set(id, ready);
    let lastSave = 0;
    const saveSoon = (force = false) => {
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
    const promise = (async () => {
      try {
        const userTurn = [...conversation.messages].reverse().find(message => message.role === 'user');
        try {
          await this.prepareTurnAttachments(conversation, attachmentFlags, session.signal);
          session.signal.throwIfAborted();
          if (abort.signal.aborted) throw Object.assign(new Error('已停止生成'), { name: 'AbortError' });
          const moved = input.retry ? [] : advanceStoredReads(conversation.messages, userTurn?.text ?? '');
          if (!input.retry && userTurn && this.memoryHooks) {
            try { userTurn.memory = await this.memoryHooks.capture(conversation, userTurn); }
            catch (error) { userTurn.memory = { sourceId: conversation.sourceId ?? 'default', hash: '', capturedAt: userTurn.createdAt, mode: 'off', visibility: 'private', ttl: '3d', status: 'held', error: error instanceof Error ? error.message : String(error) }; }
          }
          if (moved.length && userTurn) userTurn.attachmentSupplement = moved.map(item => item.excerpt).join('\n\n');
          this.dropRemovedAttachments(snapshot, conversation);
          saveSoon(true);
          opened = true;
          acceptReady(conversation);
        } catch (error) {
          if (!opened) {
            this.rollback(conversation, snapshot, previousAttachmentIds);
            const failure = error instanceof Error && error.name === 'AbortError' ? new Error('已停止生成') : error;
            rejectReady(failure instanceof Error ? failure : new Error(String(failure)));
            return;
          }
          throw error;
        }
        const priorCitations=conversationCitations(conversation.messages);
        const outputReserve=requestOutputTokens(model,contextWindow);
        const contextOptions = { contextWindow,outputReserve, summaryUntil: conversation.summaryUntil, systemPrompt: assistant.systemPrompt, additionalTokens: conversation.knowledge ? knowledgeReserve(contextWindow, assistant.context.threshold,outputReserve) : 0 };
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
          if (pending.length || !prior) {
            reply.stage = '正在压缩更早的对话';
            saveSoon(true);
            const summaryModel = assistant.context.summaryModel;
            const summarizerModel = summaryModel && this.models().some(item => item.id === summaryModel) ? summaryModel : model;
            const compressed = await compressOlder(summarizerModel, prior, pending.map(message=>referenceProjection(message,priorCitations)), session.signal, summarizer, this.models().find(item => item.id === summarizerModel)?.contextWindow);
            if (abort.signal.aborted) return;
            summary = compressed;
            conversation.summary = summary;
            conversation.summaryUntil = older[older.length - 1]!.id;
            contextOptions.summaryUntil = conversation.summaryUntil;
            saveSoon(true);
          } else summary = prior;
          reply.contextNote = `更早的 ${olderTurns} 轮已压缩为摘要，仍会参与这次回答`;
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
          contextOptions.summaryUntil = conversation.summaryUntil;
          saveSoon(true);
        }
        reply.contextMessages = recent.length;
        if (older.length) reply.contextNote = `更早的 ${older.filter(message => message.role === 'user').length} 轮已压缩为摘要，仍会参与这次回答`;
        const compressionModel = assistant.context.summaryModel && this.models().some(item => item.id === assistant.context.summaryModel) ? assistant.context.summaryModel : model;
        const result = await this.answer({
          contextWindow, contextThreshold: assistant.context.threshold,
          ...(this.summarize ? { contextSummarizer: { model: compressionModel, contextWindow: this.models().find(item => item.id === compressionModel)?.contextWindow, summarize: this.summarize } } : {}),
          sourceId: conversation.sourceId, conversationId: conversation.id,
          messages: this.modelMessages(conversation.id, recent), ...(summary ? { summary } : {}), ...(conversation.knowledge?{priorCitations}:{}), model, knowledge: conversation.knowledge,
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
        if (!abort.signal.aborted) {
          if (!result.text.trim()) throw new Error('模型未返回可用回答，已有工具结果和完整会话已保留，请重试。');
          reply.text = result.text;
          reply.model = result.model || model;
          reply.modelName = this.models().find(item => item.id === reply.model)?.name || reply.modelName;
          reply.citations = result.citations;
          reply.knowledge = result.knowledge ?? (conversation.knowledge ? (result.citations?.length ? 'used' : 'none') : 'off');
          if (result.stopReason) reply.stopReason = result.stopReason;
          reply.status = 'complete';
        }
      } catch (error) { if (opened && !abort.signal.aborted) { const failure = contextFailure(error); reply.status = 'error'; reply.error = failure.message; reply.errorCode = failure.code; } }
      finally {
        session.close();
        if (opened) {
          if (abort.signal.aborted) reply.status = 'cancelled';
          for (const call of reply.toolCalls ?? []) if (call.status === 'running') { call.status = abort.signal.aborted ? 'cancelled' : 'error'; call.error = abort.signal.aborted ? '已停止' : reply.error || '工具执行中断'; call.completedAt = new Date().toISOString(); }
          delete reply.stage;
          conversation.updatedAt = new Date().toISOString();
          this.store.save(conversation);
          if (this.memoryHooks) await this.memoryHooks.settled(id).catch(error => console.error('[workbench memory]', error));
        }
        this.active.delete(id);
        this.acceptance.delete(id);
      }
    })();
    this.active.set(id, { abort, promise }); return conversation;
  }
  cancel(id: string) {
    this.active.get(id)?.abort.abort();
    const conversation = this.get(id); const reply = conversation.messages.at(-1);
    if (reply?.status === 'running') { reply.status = 'cancelled'; delete reply.stage; for (const call of reply.toolCalls ?? []) if (call.status === 'running') { call.status = 'cancelled'; call.completedAt = new Date().toISOString(); } this.store.save(conversation); }
    return conversation;
  }
  async settled(id: string) { await this.active.get(id)?.promise; }
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
    this.store.save(conversation);
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
