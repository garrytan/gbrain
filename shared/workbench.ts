export interface WorkbenchCitation { sourceId: string | null; slug: string; title: string; snippet: string; kind?: 'memory'; factId?: number; conversationId?: string; messageId?: string; memoryHash?: string }
export interface WorkbenchMemory {
  sourceId: string;
  hash: string;
  capturedAt: string;
  mode: 'off' | 'salient' | 'all';
  visibility: 'world' | 'private';
  ttl: string;
  status: 'off' | 'held' | 'pending' | 'queued' | 'running' | 'complete' | 'failed' | 'superseded';
  taskId?: string;
  factIds?: number[];
  completedParts?: number[];
  error?: string;
  epoch?: string;
  archiveSlug?: string;
  archiveRetired?: boolean;
}
import type {ChatRequestEvent} from '../src/core/ai/chat-request-runtime';
import { isValidSourceId } from '../src/core/source-id';
export interface WorkbenchToolCall {
  id: string;
  name: string;
  input: string;
  status: 'running' | 'complete' | 'error' | 'cancelled';
  startedAt: string;
  completedAt?: string;
  output?: string;
  error?: string;
}
export function toolHistoryText(message: { toolCalls?: WorkbenchToolCall[] }): string {
  return (message.toolCalls ?? []).map(item => `【此前知识工具 ${item.name} · ${item.status}】${item.input}\n${item.output ?? item.error ?? ''}`).join('\n');
}
export function toolContextHistory(message:{toolCalls?:WorkbenchToolCall[]}):string{
  return (message.toolCalls??[]).map(item=>{
    let output=item.error??'';
    if(item.output)try{
      const value=JSON.parse(item.output);
      output=JSON.stringify(Array.isArray(value.results)?{results:value.results.map((row:Record<string,unknown>)=>({...row,snippet:String(row.snippet??'').slice(0,120)}))}:{...value,content:typeof value.content==='string'?value.content.slice(0,180)+'\n（已读节选，完整结果保存在对话记录）':value.content});
    }catch{output=item.output.slice(0,240);}
    return `【此前已执行 ${item.name} · ${item.status}】${item.input}\n${output}`;
  }).join('\n');
}
export const ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 8;
export interface WorkbenchAttachment {
  id: string;
  name: string;
  mime: string;
  route: 'vision' | 'ocr' | 'pdf-file' | 'office' | 'utf8' | 'skip';
  included: number;
  readThrough?: number;
  preview?: string;
  text?: string;
  note?: string;
  data?: string;
}
export interface WorkbenchMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  status: 'complete' | 'running' | 'error' | 'cancelled';
  model?: string;
  modelName?: string;
  error?: string;
  stage?: string;
  errorCode?: string;
  request?: ChatRequestEvent;
  requestHistory?: ChatRequestEvent[];
  citations?: WorkbenchCitation[];
  knowledge?: 'used' | 'none' | 'off';
  contextMessages?: number;
  contextNote?: string;
  contextManifest?: ContextManifest;
  ruleNotice?: string;
  learnedRules?: string[];
  replacedRules?: string[];
  playbookNotice?: string;
  savedPlaybook?: string;
  evidenceGap?: boolean;
  attachments?: WorkbenchAttachment[];
  attachmentSupplement?: string;
  stopReason?: 'end' | 'length' | 'other';
  toolCalls?: WorkbenchToolCall[];
  memory?: WorkbenchMemory;
  artifacts?: Array<{ id: string; title: string; format: 'markdown' | 'docx'; publishedPath?: string }>;
  turnId?: string;
}
export interface WorkbenchTask {
  id: string;
  goal: string;
  constraints: string[];
  updatedAt: string;
  decisions?: string[];
  openItems?: string[];
  deliveries?: string[];
  sources?: Array<{ messageId: string; note: string }>;
}
export interface ContextManifest {
  assistantRevision?: number;
  task?: { id: string; goal: string; inherited: boolean; constraints: string[] };
  rules: Array<{ text: string; state: 'active' | 'replaced'; replacedBy?: string }>;
  knowledge: boolean;
  evidenceTask: boolean;
  citations: number;
  budget: { window: number; inputBudget: number; outputReserve: number };
  omitted?: string[];
  turnId?: string;
  items?: Array<{ kind: string; ref: string; state: 'kept' | 'omitted' }>;
}
export interface WorkbenchConversation {
  id: string;
  title: string;
  model: string;
  knowledge: boolean;
  createdAt: string;
  updatedAt: string;
  messages: WorkbenchMessage[];
  summary?: string;
  summaryUntil?: string;
  summaryAssistantRevision?: number;
  contextFloor?: string;
  taskNotes?: string[];
  task?: WorkbenchTask;
  primary?: boolean;
  sourceId?: string;
  assistantId?: string;
  taskKey?: string;
  revisions?: Array<{ id: string; createdAt: string; reason: 'edit' | 'retry' | 'restore'; preview?: string; messageCount?: number; messages: WorkbenchMessage[] }>;
}
export interface WorkbenchModel { id: string; name: string; contextWindow?: number; vision?: boolean }
export const FALLBACK_CONTEXT_TOKENS = 32_000;
export interface ContextPolicy { maxMessages: number; threshold: number; summaryModel: string }
export interface KnowledgeAssistantSettings {
  name: string;
  emoji: string;
  description: string;
  systemPrompt: string;
  model: string;
  knowledge: boolean;
  temperature: number | null;
  context: ContextPolicy;
  memorySourceId?: string;
  memoryWriteback?: { mode: 'off' | 'salient' | 'all'; ttl: string };
}
export function defaultAssistant(): KnowledgeAssistantSettings {
  return {
    name: '知识库助手',
    emoji: '知',
    description: '基于当前知识库回答，并记住这段对话。',
    systemPrompt: '',
    model: '',
    knowledge: true,
    temperature: null,
    memorySourceId: 'default',
    context: { maxMessages: 24, threshold: 0.8, summaryModel: '' },
  };
}
export function normalizeAssistant(input: unknown): KnowledgeAssistantSettings {
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const context = raw.context && typeof raw.context === 'object' ? raw.context as Record<string, unknown> : {};
  const name = String(raw.name ?? '').trim();
  if (!name || name.length > 40) throw new Error('助手名称需为 1–40 个字符');
  const emoji = String(raw.emoji ?? '').trim();
  if (!emoji || [...emoji].length > 8) throw new Error('请填写 1–8 个字符的头像');
  const description = String(raw.description ?? '').trim();
  if (description.length > 200) throw new Error('描述不超过 200 个字符');
  const systemPrompt = String(raw.systemPrompt ?? '');
  if (systemPrompt.length > 8000) throw new Error('系统提示词不超过 8000 个字符');
  const model = String(raw.model ?? '').trim();
  if (model.length > 200) throw new Error('请选择对话模型');
  const maxMessages = Number(context.maxMessages);
  if (!Number.isInteger(maxMessages) || maxMessages < 2 || maxMessages > 500) throw new Error('最大上下文消息数需为 2–500 的整数');
  let threshold = Number(context.threshold);
  if (threshold > 1) threshold /= 100;
  if (!(threshold >= 0.5 && threshold <= 0.95)) throw new Error('压缩阈值需在 50% 到 95% 之间');
  const summaryModel = String(context.summaryModel ?? '').trim();
  if (summaryModel.length > 200) throw new Error('请选择摘要模型');
  let temperature: number | null = null;
  const memorySourceId = String(raw.memorySourceId ?? 'default').trim();
  if (!isValidSourceId(memorySourceId)) throw new Error('请选择有效的记忆知识来源');
  if (raw.temperature !== null && raw.temperature !== undefined && raw.temperature !== '') {
    const value = Number(raw.temperature);
    if (!Number.isFinite(value) || value < 0 || value > 2) throw new Error('温度需在 0 到 2 之间');
    temperature = Math.round(value * 10) / 10;
  }
  return {
    name, emoji, description, systemPrompt, model, knowledge: raw.knowledge !== false, temperature, memorySourceId,
    context: { maxMessages, threshold: Math.round(threshold * 100) / 100, summaryModel },
  };
}
