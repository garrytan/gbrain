import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, toNamespacedPath } from 'node:path';
import type { BrainEngine, FactRow } from '../../core/engine';
import { loadConfigFileOnly } from '../../core/config';
import { resolveWritebackConfig } from '../../core/facts/writeback-config';
import { gateWritebackTurn } from '../../core/facts/writeback-gate';
import { extractFactsFromTurn, isFactsExtractionEnabled } from '../../core/facts/extract';
import { writeSingleFact } from '../../core/facts/write-single';
import { forgetFactInFence } from '../../core/facts/forget';
import { importFromContent } from '../../core/import-file';
import { extractCandidates } from '../../core/context/entity-salience';
import { resolveEntitiesToPointers } from '../../core/context/retrieval-reflex';
import { scanText } from '../../core/secret-scan';
import { estimateTokens } from './context';
import { isAvailable } from '../../core/ai/gateway';
import { prepareLinkReconciliation } from '../../core/link-reconciliation';
import {resolveModel} from '../../core/model-config';
import type { ConsoleRun } from '../../commands/natural-lang/types';
import type { WorkbenchCitation, WorkbenchConversation, WorkbenchMemory, WorkbenchMessage } from '../../../shared/workbench';
import { WorkbenchStore } from './store';

export interface WorkbenchMemoryTask { root: string; conversationId: string; messageId: string; hash: string; sourceId: string; retire?: boolean; timeoutMs?: number }
export function memoryVersion(message: WorkbenchMessage) { return createHash('sha256').update(JSON.stringify([message.text, (message.attachments ?? []).map(item => item.id)])).digest('hex'); }

export class WorkbenchMemoryCoordinator {
  private scanning = false;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private engine: BrainEngine, private store: WorkbenchStore, private submit: (input: WorkbenchMemoryTask, key: string) => Promise<ConsoleRun>, private getRun: (id: string) => Promise<ConsoleRun | null>) {}
  start() { if (!this.timer) { this.timer = setInterval(() => void this.scan().catch(error => console.error('[workbench memory]', error)), 15000); this.timer.unref?.(); void this.scan().catch(error => console.error('[workbench memory]', error)); } }
  close() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  async capture(conversation: WorkbenchConversation, message: WorkbenchMessage): Promise<WorkbenchMemory> {
    const sourceId = conversation.sourceId ?? 'default';
    const wb = await resolveWritebackConfig(this.engine, loadConfigFileOnly());
    const sources = await this.engine.executeRaw('SELECT id FROM sources WHERE id=$1 AND archived=false', [sourceId]);
    if(wb.enabled&&sources.length)await resolveModel(this.engine,{configKey:'facts.extraction_model',tier:'reasoning',fallback:conversation.model});
    return { sourceId, hash: memoryVersion(message), capturedAt: new Date().toISOString(), mode: wb.mode, visibility: wb.visibility, ttl: wb.transient_ttl,
      status: wb.read_error || !sources.length || wb.plane_drift || !wb.mode_valid ? 'held' : wb.enabled ? 'pending' : 'off',
      ...(!sources.length ? { error: '记忆知识来源不存在或已归档' } : wb.read_error ? { error: '无法读取记忆配置' } : wb.plane_drift ? { error: '文件与数据库的记忆开关不一致' } : {}) };
  }
  settled = async (id: string) => { await this.scan(id); };
  async scan(id?: string) {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const conversations = id ? [this.store.get(id)] : this.store.list();
      for (const conversation of conversations) {
        if (conversation.messages.some(message => message.status === 'running')) continue;
        const active = new Set(conversation.messages.filter(message => message.memory).map(message => `${message.id}:${message.memory!.hash}`));
        const retired = (conversation.revisions ?? []).flatMap(revision => revision.messages).filter(message => message.role === 'user' && message.memory?.hash && !active.has(`${message.id}:${message.memory.hash}`));
        for (const message of [...retired, ...conversation.messages]) {
          const memory = message.memory;
          if (!memory?.hash || memory.mode === 'off' || memory.status === 'off' || memory.status === 'superseded') continue;
          const retire = retired.includes(message);
          if (memory.taskId) {
            const task = await this.getRun(memory.taskId);
            if (task && ['queued', 'running'].includes(task.status)) continue;
            if (!retire && task?.status === 'failed') { this.store.saveMemory(conversation.id, message.id, { ...memory, status: 'failed', error: task.error ?? '记忆任务已中断，请在任务中心继续' }); continue; }
          }
          if (!retire && ['complete', 'failed'].includes(memory.status)) continue;
          const input = { root: this.store.root, conversationId: conversation.id, messageId: message.id, hash: memory.hash, sourceId: memory.sourceId, retire };
          const key = `workbench-memory:${createHash('sha256').update(JSON.stringify([input.root, input.sourceId, input.conversationId, input.messageId, input.hash, retire])).digest('hex')}`;
          const task = await this.submit(input, key);
          const latest = this.store.get(conversation.id);
          const current = [...latest.messages, ...(latest.revisions ?? []).flatMap(revision => revision.messages)].find(row => row.id === message.id && row.memory?.hash === memory.hash);
          if (current?.memory && !['complete', 'superseded'].includes(current.memory.status)) this.store.saveMemory(conversation.id, message.id, { ...current.memory, taskId: task.id, status: 'queued' });
        }
      }
    } finally { this.scanning = false; }
  }
}

function termsFor(query: string) {
  const stop = new Set(['可以','帮我','给我','一下','什么','怎么','如何','这个','那个','我的','我们','你们','他们','请问','需要','希望','以后','the','and','please']);
  return [...new Set([...(query.toLowerCase().match(/[a-z0-9_-]{3,}/g) ?? []), ...[...query.matchAll(/[\u3400-\u9fff]{2,}/g)].flatMap(match => [...match[0]].slice(0, -1).map((char, index) => char + match[0][index + 1]))])].filter(term => !stop.has(term)).slice(0, 48);
}

export async function recallWorkbenchMemory(engine: BrainEngine, opts: { sourceId: string; query: string; sessionId?: string; budget?: number }): Promise<WorkbenchCitation[]> {
  const terms = termsFor(opts.query);
  const pointers = await resolveEntitiesToPointers(engine, opts.sourceId, extractCandidates(opts.query), { maxPointers: 3, suppression: 'slug-only' });
  const entities = pointers?.pointers.map(pointer => pointer.slug) ?? [];
  if (!terms.length && !entities.length) return [];
  const rows = await engine.executeRaw<FactRow>(
    `SELECT f.* FROM facts f JOIN sources s ON s.id=f.source_id AND s.archived=false
     WHERE f.source_id=$1 AND f.expired_at IS NULL AND (f.valid_until IS NULL OR f.valid_until>now()) AND f.visibility IN ('world','private')
     AND f.source IS DISTINCT FROM 'cli:extract-conversation-facts:terminal'
     AND (f.entity_slug=ANY($3::text[]) OR EXISTS(SELECT 1 FROM unnest($2::text[]) AS t(term) WHERE lower(f.fact) LIKE '%'||t.term||'%'))
     ORDER BY f.valid_from DESC,f.id DESC LIMIT 50`, [opts.sourceId, terms, entities],
  );
  rows.sort((a, b) => (entities.includes(b.entity_slug ?? '') ? 10 : 0) + terms.filter(term => b.fact.toLowerCase().includes(term)).length - (entities.includes(a.entity_slug ?? '') ? 10 : 0) - terms.filter(term => a.fact.toLowerCase().includes(term)).length);
  let used = 0;
  const result: WorkbenchCitation[] = [];
  for (const row of rows) {
    if (scanText(row.fact).length) continue;
    const cost = estimateTokens(row.fact) + 80;
    if (used + cost > (opts.budget ?? 1500) || result.length >= 10) continue;
    let origin: { conversationId?: string; messageId?: string; hash?: string } = {};
    if (row.context) { try { origin = JSON.parse(row.context); } catch {} }
    const kinds:Record<string,string>={event:'事件',preference:'偏好',commitment:'决定',belief:'观点',fact:'事实',idea:'想法'};
    result.push({ sourceId: opts.sourceId, slug: `memory/fact-${row.id}`, title: `${origin.conversationId?'对话记忆':'已保存事实'} · ${kinds[row.kind]??'事实'}`, snippet: row.fact, kind: 'memory', factId: Number(row.id), conversationId:origin.conversationId, messageId:origin.messageId, memoryHash:origin.hash });
    used += cost;
  }
  return result;
}

export async function runWorkbenchMemoryTask(engine: BrainEngine, input: WorkbenchMemoryTask, signal: AbortSignal, deps: { extract?: typeof extractFactsFromTurn; organize?: (path: string, sourceId: string) => Promise<unknown>; ownerJobId?:number|null; ownerToken?:string } = {}): Promise<Record<string, unknown>> {
  const store = new WorkbenchStore(input.root);
  let conversation: WorkbenchConversation;
  try { conversation = store.get(input.conversationId); } catch (error) { if (error instanceof Error && error.message === '会话不存在') return { status: 'cancelled' }; throw error; }
  const message = (input.retire ? (conversation.revisions ?? []).flatMap(row => row.messages) : conversation.messages).find(row => row.id === input.messageId && row.memory?.hash === input.hash);
  if (!message?.memory || message.role !== 'user' || message.memory.sourceId !== input.sourceId) return { status: 'cancelled' };
  let state = { ...message.memory };
  const leaseValid=async(scoped:BrainEngine)=>!deps.ownerJobId||!deps.ownerToken||(await scoped.executeRaw('SELECT id FROM minion_jobs WHERE id=$1 AND status=$2 AND lock_token=$3 AND lock_until>now()',[deps.ownerJobId,'active',deps.ownerToken])).length>0;
  if(!await leaseValid(engine))throw new Error('记忆任务执行租约已失效');
  if(deps.ownerJobId&&deps.ownerToken){state.taskId=`task-${deps.ownerJobId}`;state.epoch=createHash('sha256').update(deps.ownerToken).digest('hex');store.saveMemory(input.conversationId,message.id,state,true);}
  if (input.retire) {
    const current = conversation.messages.some(row => row.id === input.messageId && row.memory?.hash === input.hash);
    if (current) return { status: 'cancelled' };
    const remaining=new Set(store.list().flatMap(row=>row.messages.flatMap(item=>item.memory?.sourceId===input.sourceId&&(row.id!==input.conversationId||item.id!==input.messageId||item.memory.hash!==input.hash)?item.memory.factIds??[]:[])));
    for (const id of state.factIds ?? []) {
      signal.throwIfAborted();
      if(remaining.has(id))continue;
      const rows = await engine.executeRaw<{context:string|null}>('SELECT context FROM facts WHERE id=$1 AND source_id=$2', [id, input.sourceId]);
      let owned=false;
      try{const origin=JSON.parse(rows[0]?.context??'null');const original=store.get(origin.conversationId);owned=[...original.messages,...(original.revisions??[]).flatMap(row=>row.messages)].some(row=>row.id===origin.messageId&&row.memory?.sourceId===input.sourceId&&row.memory.hash===origin.hash);}catch{}
      if (owned) await forgetFactInFence(engine, id, { sourceId: input.sourceId, reason: '用户编辑会话，原分支已被替换' });
    }
    store.saveMemory(input.conversationId, message.id, { ...state, status: 'superseded' });
    return { status: 'completed', retired: state.factIds?.length ?? 0 };
  }
  if (state.status === 'complete' || state.mode === 'off' || state.status === 'off') return { status: 'completed', factIds: state.factIds ?? [] };
  const canWrite = async (scoped: BrainEngine = engine) => {
    signal.throwIfAborted();
    const live = store.get(input.conversationId).messages.find(row => row.id === message.id);
    if(scoped!==engine)await scoped.executeRaw("SELECT key FROM config WHERE key IN ('memory.auto_writeback','facts.default_visibility','facts.extraction_enabled') FOR SHARE");
    const config = await resolveWritebackConfig(scoped, loadConfigFileOnly());
    const sources = await scoped.executeRaw('SELECT id FROM sources WHERE id=$1 AND archived=false FOR SHARE', [input.sourceId]);
    return live?.memory?.hash === input.hash && memoryVersion(live) === input.hash && config.enabled && !(config.visibility==='private'&&state.visibility==='world') && sources.length > 0 && await leaseValid(scoped) && await isFactsExtractionEnabled(scoped);
  };
  if (!await canWrite()) throw new Error('记忆写入已停止：配置关闭、来源不可用或会话已改变');
  const gated = gateWritebackTurn(message.text, { minChars: 2, maxChars: 32000, maxBytes: 128000,excludeOperationalRequests:true });
  if (!gated.ok) { store.saveMemory(input.conversationId, message.id, { ...state, status: 'complete', factIds: [],error:undefined }); return { status: 'completed', skipped: gated.reason }; }
  state = { ...state, status: 'running', error:undefined,factIds: state.factIds ?? [], completedParts: state.completedParts ?? [] };
  store.saveMemory(input.conversationId, message.id, state);
  let archiveSlug = `conversations/pmbrain/${conversation.id}/${message.id}-${input.hash.slice(0, 12)}`;
  try {
    const corrects = /改成|改为|改到|更正|纠正|不再|错了|correction|instead|no longer/i.test(message.text);
    const recalled=corrects?await recallWorkbenchMemory(engine,{sourceId:input.sourceId,query:message.text}):[];
    const sessionFacts=corrects?await engine.listFactsBySession(input.sourceId,input.conversationId,{activeOnly:true,limit:10}):[];
    const known=[...new Map([...sessionFacts.map(row=>({id:row.id,fact:row.fact})),...recalled.map(row=>({id:row.factId!,fact:row.snippet}))].map(row=>[row.id,row])).values()].slice(0,10);
    const pointers=await resolveEntitiesToPointers(engine,input.sourceId,extractCandidates(gated.normalized),{maxPointers:3,suppression:'slug-only'});
    const entityHints=pointers?.pointers.map(row=>row.slug);
    const selectedModel=await resolveModel(engine,{configKey:'facts.extraction_model',tier:'reasoning',fallback:conversation.model});
    const extractionModel=selectedModel.includes(':')?selectedModel:`anthropic:${selectedModel}`;
    if(!deps.extract&&!isAvailable('chat',extractionModel))throw new Error('未配置可用模型，无法提炼对话记忆');
    const parts = gated.normalized.match(/[\s\S]{1,7000}/g) ?? [];
    for (let index = 0; index < parts.length; index++) {
      if (state.completedParts!.includes(index)) continue;
      if (!await canWrite()) throw new Error('记忆写入已停止：配置关闭或会话已改变');
      const facts = await (deps.extract ?? extractFactsFromTurn)({ turnText: parts[index], source: `PMBrain 知识助手 / ${conversation.id} / ${message.id} / ${input.hash} / ${state.capturedAt}`, sessionId: conversation.id, engine, entityHints, maxFactsPerTurn:25, model: extractionModel, transientTtl: state.ttl, validFrom: new Date(state.capturedAt), knownFacts: corrects ? known.map(row => ({ id: row.id, fact: row.fact })) : undefined, abortSignal: signal, throwOnError: true });
      for (const fact of facts) {
        const wb = await resolveWritebackConfig(engine, loadConfigFileOnly());
        if(wb.visibility==='private')state.visibility='private';
        if ((state.mode === 'salient' || wb.mode === 'salient') && fact.notability === 'low') continue;
        if (scanText(fact.fact).length) continue;
        const supersedeId = corrects && known.some(row => row.id === fact.supersedes) ? fact.supersedes : undefined;
        const written = await writeSingleFact(engine, input.sourceId, { databaseOnly:true, fact: fact.fact, kind: fact.kind, entity: fact.entity_slug, provenance: `PMBrain 知识助手 / ${conversation.id} / ${message.id} / ${input.hash} / ${state.capturedAt}`, sessionId: conversation.id, context: JSON.stringify({ conversationId: conversation.id, messageId: message.id, hash: input.hash, sourceSlug: archiveSlug }), visibility: state.visibility, confidence: fact.confidence, notability: fact.notability, validFrom: fact.valid_from ?? new Date(state.capturedAt), validUntil: fact.valid_until, embedding: fact.embedding, exactDedup: true, supersedeId, canWrite });
        if (!state.factIds!.includes(written.id)) state.factIds!.push(written.id);
        store.saveMemory(input.conversationId, message.id, state);
      }
      state.completedParts!.push(index);
      store.saveMemory(input.conversationId, message.id, state);
    }
    if (!await canWrite()) throw new Error('记忆写入已停止：配置关闭或会话已改变');
    const facts = state.factIds!.length ? await engine.executeRaw<{ fact: string; entity_slug: string | null; valid_until:Date|null;visibility:string }>('SELECT fact, entity_slug,valid_until,visibility FROM facts WHERE source_id=$1 AND id=ANY($2::bigint[]) AND expired_at IS NULL AND (valid_until IS NULL OR valid_until>now())', [input.sourceId, state.factIds]) : [];
    if (facts.length) {
      const content = `---\nid: ${message.id}-${input.hash}\nsource_ref: pmbrain://conversations/${conversation.id}/${message.id}\ntitle: 对话记忆 ${state.capturedAt.slice(0, 10)}\ntype: conversation\ndream_generated: true\npmbrain_memory: true\nprivate: ${state.visibility === 'private'}\n---\n\n[对话出处](pmbrain://conversations/${conversation.id}/${message.id}?hash=${input.hash})\n\n${facts.map(row => `- ${row.fact}${row.entity_slug ? ` [[${row.entity_slug}]]` : ''}`).join('\n')}\n`;
      const imported=await importFromContent(engine, archiveSlug, content, { sourceId: input.sourceId, noEmbed: true, source_kind: 'workbench-memory', source_uri: `pmbrain://conversations/${conversation.id}/${message.id}`, ingested_via: 'workbench:memory' });
      if(imported.error)throw new Error(imported.error);
      archiveSlug=imported.slug;
      const reconcile=await prepareLinkReconciliation(engine);
      await reconcile(archiveSlug,input.sourceId,{includeFrontmatter:true});
      const stable=facts.filter(row=>row.valid_until===null&&row.visibility==='world');
      if (deps.organize&&state.visibility==='world'&&stable.length) {
        const dir = join(input.root, 'memory', conversation.id); mkdirSync(dir, { recursive: true, mode: 0o700 });
        const path = toNamespacedPath(join(dir, `${createHash('sha256').update(`${message.id}:${input.hash}`).digest('hex')}.md`));
        writeFileSync(`${path}.tmp`, `# 对话记忆 ${state.capturedAt}\n\n${stable.map(row=>`- ${row.fact}${row.entity_slug?` [[${row.entity_slug}]]`:''}`).join('\n')}\n`, { mode: 0o600 }); renameSync(`${path}.tmp`, path);
        await deps.organize(path, input.sourceId);
      }
    }
    store.saveMemory(input.conversationId, message.id, { ...state, status: 'complete', error: undefined });
    return { status: 'completed', factIds: state.factIds, archiveSlug: facts.length ? archiveSlug : undefined };
  } catch (error) {
    store.saveMemory(input.conversationId, message.id, { ...state, status: 'failed', error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
