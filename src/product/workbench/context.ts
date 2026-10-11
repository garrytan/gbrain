import { FALLBACK_CONTEXT_TOKENS, toolContextHistory, type ContextPolicy, type WorkbenchMessage,type WorkbenchCitation } from '../../../shared/workbench';
import { ATTACHMENT_PROMPT_CAP } from './attachments';
import { estimateEmbedTokens } from '../../core/chunkers/token-estimate';

export { FALLBACK_CONTEXT_TOKENS };
export const OUTPUT_RESERVE_TOKENS = 4_096;
export const SUMMARY_OUTPUT_TOKENS = 1_200;
const tokenCounts = new Map<string, number>();
let cachedCharacters = 0;

export function summaryInputBudget(contextWindow?: number): number {
  const windowTokens = contextWindow && contextWindow >= 2048 ? contextWindow : FALLBACK_CONTEXT_TOKENS;
  return windowTokens - Math.min(SUMMARY_OUTPUT_TOKENS, Math.floor(windowTokens / 4)) - 256;
}

export function conversationContext(messages: WorkbenchMessage[]): WorkbenchMessage[] {
  const result = messages.filter(message => message.status === 'complete');
  while (result[0]?.role === 'assistant') result.shift();
  return result;
}

export function conversationCitations(messages:readonly WorkbenchMessage[]):WorkbenchCitation[]{
  const citations:WorkbenchCitation[]=[];
  for(const message of messages)if(message.status==='complete')for(const citation of message.citations??[]){
    if(!citations.some(item=>item.sourceId===citation.sourceId&&item.slug===citation.slug))citations.push({...citation});
  }
  return citations;
}

export function referenceProjection(message:WorkbenchMessage,citations:readonly WorkbenchCitation[]):WorkbenchMessage{
  if(message.role!=='assistant'||!message.citations?.length)return message;
  const references=new Map(message.citations.map((source,index)=>[index+1,citations.findIndex(item=>item.sourceId===source.sourceId&&item.slug===source.slug)+1]));
  const remap=(index:number)=>references.get(index)||index;
  const text=message.text.replace(/\[(\d+)\]/g,(_raw,key)=>`[${remap(Number(key))}]`);
  const toolCalls=message.toolCalls?.map(call=>{
    if(!call.output)return call;
    try{const value=JSON.parse(call.output);if(typeof value.citation==='number')value.citation=remap(value.citation);for(const row of value.results??[])if(typeof row.citation==='number')row.citation=remap(row.citation);return {...call,output:JSON.stringify(value)};}catch{return call;}
  });
  return {...message,text,toolCalls,citations:[...citations]};
}

export function estimateTokens(text: string): number {
  const cached = tokenCounts.get(text);
  if (cached !== undefined) return cached;
  const tokens = estimateEmbedTokens(text);
  if (text.length <= 32_768) {
    while (tokenCounts.size >= 32 || cachedCharacters + text.length > 65_536) {
      const oldest = tokenCounts.keys().next().value;
      if (oldest === undefined) break;
      cachedCharacters -= oldest.length;
      tokenCounts.delete(oldest);
    }
    tokenCounts.set(text, tokens);
    cachedCharacters += text.length;
  }
  return tokens;
}

export function messageTokens(message: WorkbenchMessage): number {
  let tokens = estimateTokens(message.text) + 8;
  for (const item of message.attachments ?? []) {
    tokens += estimateTokens(`${item.name}\n${(item.text ?? '').slice(0, ATTACHMENT_PROMPT_CAP)}\n${item.note ?? ''}`) + 64;
    if (item.route === 'vision' || item.route === 'pdf-file') tokens += 4_000;
  }
  tokens += estimateTokens(message.attachmentSupplement ?? '');
  tokens += estimateTokens(toolContextHistory(message));
  return tokens;
}

export function knowledgeReserve(contextWindow: number | undefined, threshold: number, outputReserve?:number): number {
  return Math.min(8_192, Math.floor(contextBudget(contextWindow, threshold,outputReserve) / 3));
}

export function contextBudget(contextWindow: number | undefined, threshold: number, outputReserve?:number): number {
  const windowTokens = contextWindow && contextWindow >= 2048 ? contextWindow : FALLBACK_CONTEXT_TOKENS;
  const reserve = Math.min(outputReserve??OUTPUT_RESERVE_TOKENS, Math.floor(windowTokens / 4));
  const usable = Math.max(1024, windowTokens - reserve);
  const ratio = Math.min(0.95, Math.max(0.5, threshold));
  return Math.floor(usable * ratio);
}

export function planContext(messages: WorkbenchMessage[], policy: ContextPolicy, options: { contextWindow?: number; outputReserve?:number; summary?: string; summaryUntil?: string; systemPrompt?: string; additionalTokens?: number } = {}): { recent: WorkbenchMessage[]; older: WorkbenchMessage[] } {
  let complete = conversationContext(messages);
  if (options.summary && options.summaryUntil) {
    const anchor = complete.findIndex(message => message.id === options.summaryUntil);
    if (anchor >= 0) complete = complete.slice(anchor + 1);
  }
  const summaryTokens = options.summary ? estimateTokens(options.summary) : 0;
  const budget = Math.max(0, contextBudget(options.contextWindow, policy.threshold,options.outputReserve) - summaryTokens - estimateTokens(options.systemPrompt ?? '') - (options.additionalTokens ?? 0) - 128);
  const maxMessages = Math.max(2, policy.maxMessages);
  const recent: WorkbenchMessage[] = [];
  let tokens = 0;
  for (const message of [...complete].reverse()) {
    const cost = messageTokens(message);
    if (recent.length > 0 && (recent.length >= maxMessages || tokens + cost > budget)) break;
    recent.unshift(message);
    tokens += cost;
    if (recent.length >= maxMessages || tokens >= budget) break;
  }
  while (recent[0]?.role === 'assistant') recent.shift();
  if (!recent.length) {
    const latestUser = [...complete].reverse().find(message => message.role === 'user');
    if (latestUser) recent.push(latestUser);
  }
  const recentIds = new Set(recent.map(message => message.id));
  return { recent, older: complete.filter(message => !recentIds.has(message.id)) };
}
