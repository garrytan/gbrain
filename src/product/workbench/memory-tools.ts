import type { ChatToolDef, ToolHandler } from '../../core/ai/gateway';
import type { BrainEngine } from '../../core/engine';
import { writeSingleFact } from '../../core/facts/write-single';
import { forgetFactInFence } from '../../core/facts/forget';
import { refreshWorkbenchMemoryArchives } from './memory-lifecycle';
import { parseTtlShorthand } from '../../core/facts/ttl-parse';
import { operationsByName, type OperationContext } from '../../core/operations';
import {serializePageToMarkdown} from '../../core/markdown';
import type { ProductTaskRuntime } from '../tasks/runtime';
import type { WorkbenchStore } from './store';
import type { WorkbenchCitation } from '../../../shared/workbench';
import { recallWorkbenchMemory } from './memory';
import { loadConfigFileOnly } from '../../core/config';
import { scanText } from '../../core/secret-scan';

export interface WorkbenchNative { store: WorkbenchStore; tasks: ProductTaskRuntime }
const requestPrefix='(?:^|[，,。；;！？!?\\n])\\s*(?:(?:请(?:你)?|请帮我|帮我|替我|麻烦(?:你)?|我(?:希望|要求|想让)你?|能否|能不能(?:帮我)?|可以(?:帮我)?|please|could you|can you)\\s*)?';
const intent:Record<string,RegExp>=Object.fromEntries(Object.entries({memory_remember:'(?:记住|记一下|保存.{0,12}记忆|记到|把.{1,120}(?:记住|记到|保存为记忆)|remember|save.{0,12}memory)',memory_forget:'(?:忘记|忘掉|不再记住|删除.{0,24}记忆|forget)',knowledge_append:'(?:修改|追加|补充|更新.{0,32}(?:知识|资料|页面)|给.{0,32}(?:修改|追加|补充)|把.{0,120}(?:补充|追加)到|append|update.{0,12}knowledge)',knowledge_organize:'(?:整理|开始.{0,12}整理|执行.{0,12}整理|把.{0,120}整理|run.{0,12}dream|执行.{0,12}Dream)'}).map(([key,value])=>[key,new RegExp(requestPrefix+value,'i')]));
export function memoryActionRequested(text:string,name:string){return name==='memory_recall'||!!intent[name]?.test(text)&&!(name==='memory_remember'&&/(不要|不必|不用|别|禁止|无需).{0,4}(记住|记一下|保存|remember)/i.test(text));}
export function workbenchMemoryTools(text:string,knowledge=true){return MEMORY_TOOLS.filter(tool=>tool.name==='memory_recall'?(knowledge||/记忆|回忆|之前.*偏好|以前.*约定|recall/i.test(text)):memoryActionRequested(text,tool.name));}
export const MEMORY_TOOLS: ChatToolDef[] = [
  { name: 'memory_recall', description: '按话题检索已保存的事实、偏好和决定，返回记忆和出处。', inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['query'], additionalProperties: false } },
  { name: 'memory_remember', description: '用户明确说记住时保存一条用户陈述。普通对话由后台沉淀。临时状态填写 ttl，如 3d；不保存自己的推测。', inputSchema: { type: 'object', properties: { fact: { type: 'string', minLength: 1, maxLength: 500 }, kind: { type: 'string', enum: ['event','preference','commitment','belief','fact','idea'] }, entity: { type: 'string' }, ttl: { type: 'string' } }, required: ['fact','kind'], additionalProperties: false } },
  { name: 'memory_forget', description: '用户明确要求忘记时，遗忘 memory_recall 返回的 fact_id；保留历史。', inputSchema: { type: 'object', properties: { fact_id: { type: 'integer', minimum: 1 } }, required: ['fact_id'], additionalProperties: false } },
  { name: 'knowledge_append', description: '用户明确要求补充知识时，追加到已 knowledge_read 核对的页面。原样填写 source_id、slug、revision，不替换原文。', inputSchema: { type: 'object', properties: { source_id: { type: 'string' }, slug: { type: 'string' }, revision: { type: 'string' }, content: { type: 'string', minLength: 1, maxLength: 32000 } }, required: ['source_id','slug','revision','content'], additionalProperties: false } },
  { name: 'knowledge_organize', description: '用户明确要求整理时，提交当前记忆来源的后台快速维护。返回任务状态，提交不表示完成。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];

export function nativeMemoryHandlers(engine: BrainEngine, sourceId: string, conversationId: string, native: WorkbenchNative, cite: (row: WorkbenchCitation) => number, reads: Map<string,string>): Map<string,ToolHandler> {
  const user = () => [...native.store.get(conversationId).messages].reverse().find(row => row.role === 'user')!;
  const params = (raw: unknown, keys: string[]) => { if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !keys.includes(key))) throw new Error('工具参数无效'); return raw as Record<string,unknown>; };
  return new Map([
    ['memory_recall', { idempotent: true, execute: async (raw, signal) => {
      const p=params(raw,['query']); if(typeof p.query!=='string'||!p.query.trim()||p.query.length>2000)throw new Error('请输入记忆查询'); signal.throwIfAborted();
      const restored=await recallWorkbenchMemory(engine,{sourceId,query:p.query,sessionId:conversationId});
      return {facts:restored.filter(row=>row.kind==='memory').map(row=>({...row,fact_id:row.factId,citation:cite(row)})),context:restored.filter(row=>row.kind!=='memory').map(row=>({...row,citation:cite(row)}))};
    }}],
    ['memory_remember', { execute: async (raw,signal) => {
      if(!memoryActionRequested(user().text,'memory_remember'))throw new Error('请明确要求记住这条信息');
      const p=params(raw,['fact','kind','entity','ttl']); if(typeof p.fact!=='string'||!p.fact.trim()||p.fact.length>500||!['event','preference','commitment','belief','fact','idea'].includes(String(p.kind)))throw new Error('记忆内容或类型无效');
      if(scanText(p.fact).length)throw new Error('不能将密钥或凭据保存为记忆');
      const ttl=parseTtlShorthand(p.ttl); if(!ttl.ok)throw new Error('记忆有效期无效');
      const message=user();const {resolveWritebackConfig}=await import('../../core/facts/writeback-config');const wb=await resolveWritebackConfig(engine,loadConfigFileOnly());signal.throwIfAborted();
      if(wb.read_error)throw new Error('无法读取记忆可见性配置');
      const result=await writeSingleFact(engine,sourceId,{databaseOnly:true,fact:p.fact,kind:p.kind as any,entity:typeof p.entity==='string'?p.entity:undefined,validUntil:ttl.validUntil,visibility:wb.visibility,exactDedup:true,sessionId:conversationId,provenance:`PMBrain 知识助手 / ${conversationId} / ${message.id} / 明确记忆 / ${new Date().toISOString()}`,context:JSON.stringify({conversationId,messageId:message.id,hash:message.memory?.hash}),canWrite:async(scoped=engine)=>{
        signal.throwIfAborted();await scoped.executeRaw("SELECT key FROM config WHERE key='facts.default_visibility' FOR SHARE");const current=await resolveWritebackConfig(scoped,loadConfigFileOnly());
        return !current.read_error&&!(current.visibility==='private'&&wb.visibility==='world')&&(await scoped.executeRaw('SELECT id FROM sources WHERE id=$1 AND archived=false FOR SHARE',[sourceId])).length>0;
      }});
      return {...result,citation:cite({sourceId,slug:`memory/fact-${result.id}`,title:'对话记忆',snippet:p.fact,kind:'memory',factId:result.id,conversationId,messageId:message.id,memoryHash:message.memory?.hash})};
    }}],
    ['memory_forget', { execute: async (raw,signal) => {
      if(!memoryActionRequested(user().text,'memory_forget'))throw new Error('请明确要求遗忘记忆');
      const p=params(raw,['fact_id']);if(!Number.isSafeInteger(p.fact_id)||Number(p.fact_id)<1)throw new Error('无效的事实身份');signal.throwIfAborted();
      const result=await forgetFactInFence(engine,Number(p.fact_id),{sourceId,reason:'知识助手用户明确要求遗忘'});
      if(result.ok||result.path==='already_expired')await refreshWorkbenchMemoryArchives(engine,native.store,native.store.list(),sourceId);
      return result;
    }}],
    ['knowledge_append', { execute: async (raw,signal) => {
      if(!memoryActionRequested(user().text,'knowledge_append'))throw new Error('请明确要求修改知识内容');
      const p=params(raw,['source_id','slug','revision','content']);if(typeof p.source_id!=='string'||typeof p.slug!=='string'||typeof p.revision!=='string'||typeof p.content!=='string'||!p.content.trim()||p.content.length>32000||reads.get(JSON.stringify([p.source_id,p.slug]))!==p.revision)throw new Error('请先读取目标资料，使用真实来源和版本');signal.throwIfAborted();
      if(p.source_id!==sourceId)throw new Error('只能补充本次对话绑定知识来源的资料');
      return engine.transaction(async tx=>{signal.throwIfAborted();if(!(await tx.executeRaw('SELECT id FROM sources WHERE id=$1 AND archived=false FOR SHARE',[sourceId])).length)throw new Error('知识来源不存在或已归档');await tx.executeRaw('SELECT id FROM pages WHERE source_id=$1 AND slug=$2 FOR UPDATE',[sourceId,p.slug]);const page=await tx.getPage(p.slug as string,{sourceId:p.source_id as string});if(!page||page.content_hash!==p.revision)throw new Error('资料已改变，请重新读取');
        const content=serializePageToMarkdown({...page,compiled_truth:`${page.compiled_truth}\n\n${p.content}`},await tx.getTags(p.slug as string,{sourceId}));
        const ctx:OperationContext={engine:tx,sourceId:p.source_id as string,remote:false,config:loadConfigFileOnly()??{engine:engine.kind},dryRun:false,logger:{info:console.info,warn:console.warn,error:console.error}};const result=await operationsByName.put_page.handler(ctx,{slug:p.slug,content,source_kind:'workbench-user-edit',source_uri:`pmbrain://conversations/${conversationId}/${user().id}`,ingested_via:'workbench:knowledge-append'});signal.throwIfAborted();return result;});
    }}],
    ['knowledge_organize', { execute: async (raw,signal) => {
      params(raw,[]);if(!memoryActionRequested(user().text,'knowledge_organize'))throw new Error('请明确要求启动知识整理');signal.throwIfAborted();const run=await native.tasks.submitDream({preset:'quick',sourceId});return {task_id:run.id,status:run.status,message:'已提交后台整理，请在任务中心查看实际结果'};
    }}],
  ]);
}
