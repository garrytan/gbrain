import React,{useEffect,useState} from 'react';
import { BookOpen, User, FileText, Download } from 'lucide-react';
import type { WorkbenchAgent } from '../../../shared/workbench-agents';
import type { WorkbenchMessage } from '../../../shared/workbench';
import { MarkdownArticle } from '../pages/Documentation';
import { CopyButton } from '../lib/clipboard';
import { ToolActivity } from './ToolActivity';
import { workbenchRequest } from './useWorkbench';
import { downloadArtifact, ArtifactPreview } from './Artifacts';
import { AgentCards } from './AgentCards';

export function Message({ message, assistantName, assistantEmoji, assistantRole, canRetry, onRetry, canEdit, onEdit, agents, onAgent, onConversation }: { message: WorkbenchMessage; assistantName: string; assistantEmoji: string; assistantRole?: string; canRetry: boolean; onRetry: () => void; canEdit?: boolean; onEdit?: () => void; agents?: WorkbenchAgent[]; onAgent?: (id: string) => void; onConversation?: (id: string) => void }) {
  const modelLabel = message.modelName || message.model;
  const [now,setNow]=useState(Date.now());
  const [origins,setOrigins]=useState<Record<number,string>>({});
  const [preview, setPreview] = useState<string>();
  const [artifactError, setArtifactError] = useState('');
  useEffect(()=>{if(message.status!=='running')return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[message.status]);
  const waitingSeconds=message.request?Math.max(0,Math.floor((now-Date.parse(message.request.startedAt))/1000)):0;
  return <article className={`wb-message wb-${message.role}`} data-kind={message.role === 'assistant' ? (assistantRole === '主助手' ? 'main' : 'specialist') : undefined} aria-label={message.role === 'user' ? '你的消息' : '助手回答'}>
    <div className="wb-avatar">{message.role === 'user' ? <User size={17} /> : <span>{assistantEmoji}</span>}</div>
    <div className="wb-message-body"><header><strong>{message.role === 'user' ? '你' : assistantName}</strong><span>{message.role === 'assistant' ? `${assistantRole ? `${assistantRole} · ` : ''}${modelLabel}` : new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></header>
      {message.ruleNotice && <p className="wb-notice" role="status">{message.ruleNotice}</p>}
      {message.knowledge === 'none' && message.status === 'complete' && <p className="wb-notice">这次没有从知识库检索到相关资料。下面的内容是模型基于一般知识的回答，请再核对。</p>}
      {!!message.attachments?.length && <ul className="wb-attachments">{message.attachments.map(item => <li key={item.id} className={item.preview ? 'wb-thumb' : 'wb-file-card'}>{item.preview ? <img src={item.preview} alt={item.name} /> : <span className="wb-attachment-name">{item.name}</span>}{item.note && <small className="wb-attachment-note">{item.note}</small>}</li>)}</ul>}{!!message.toolCalls?.length && <ToolActivity calls={message.toolCalls} />}{message.text && <MarkdownArticle markdown={message.text} citations={message.role === 'assistant' ? message.citations : undefined} />}
      {message.status === 'running' && <p className="wb-progress" role="status"><i />{message.stage || '正在生成回答…'}{message.request&&waitingSeconds>=5?` · 已等待 ${waitingSeconds} 秒`:''}</p>}
      {message.status === 'error' && <p className="wb-error" role="alert">{message.error}</p>}
      {message.status === 'cancelled' && <p className="wb-muted">已停止生成，可以重试或继续提问。</p>}
      {agents && onAgent && onConversation && <AgentCards calls={message.toolCalls ?? []} agents={agents} onAgent={onAgent} onConversation={onConversation} />}
      {!!message.artifacts?.length && <div className="wb-deliverables">{message.artifacts.map(item => <div className="wb-artifact-card" key={item.id}><button className="wb-artifact-open" aria-label={`预览 ${item.title}`} onClick={() => setPreview(item.id)}><FileText size={24} /><span><strong>{item.title}</strong><small>{item.publishedPath ? `已保存到 ${item.publishedPath}` : `${item.format === 'docx' ? 'Word 文档' : 'Markdown'} · 点击预览`}</small></span></button><button aria-label={`下载 ${item.title}`} title="下载文件" onClick={() => { setArtifactError(''); void downloadArtifact(item.id).catch(error => setArtifactError(String(error))); }}><Download size={16} /></button></div>)}</div>}
      {artifactError && <p className="wb-error" role="alert">{artifactError}</p>}
      {preview && <ArtifactPreview key={preview} id={preview} onClose={() => setPreview(undefined)} />}
      {message.stopReason === 'length' && message.status === 'complete' && <p className="wb-notice">回答因模型长度限制未能一次写完。你可以发送「继续」接着写。</p>}
      {!!message.citations?.length && <details className="wb-citations"><summary><BookOpen size={14} />参考了 {message.citations.length} 条知识与记忆</summary>{message.citations.map((citation, index) => <div key={`${citation.sourceId}/${citation.slug}/${citation.factId??''}`}><b>[{index + 1}] {citation.title}</b><small>{citation.kind==='memory'?'已保存的记忆':`${citation.sourceId} / ${citation.slug}`}</small><p>{citation.snippet}</p>{citation.kind==='memory'&&citation.conversationId&&citation.messageId&&<><button type="button" onClick={()=>void workbenchRequest<{text:string;createdAt:string}>(`/conversations/${citation.conversationId}/memory/${citation.messageId}${citation.memoryHash?`?hash=${citation.memoryHash}`:''}`).then(result=>setOrigins(old=>({...old,[index]:`${new Date(result.createdAt).toLocaleString()}\n${result.text}`}))).catch(reason=>setOrigins(old=>({...old,[index]:String(reason)})))}>查看对话出处</button>{origins[index]&&<p>{origins[index]}</p>}</>}</div>)}</details>}
      {message.memory&&['pending','queued','running'].includes(message.memory.status)&&<p className="wb-muted" role="status">正在后台沉淀对话记忆…</p>}
      {message.memory?.status==='complete'&&!!message.memory.factIds?.length&&<p className="wb-muted">已沉淀 {message.memory.factIds.length} 条记忆</p>}
      {message.memory&&['held','failed'].includes(message.memory.status)&&<p className="wb-error" role="status">记忆尚未沉淀：{message.memory.error||'请在任务中心查看并继续'}</p>}
      {message.contextNote && <p className="wb-muted">{message.contextNote}</p>}
      {!!message.requestHistory?.length&&message.status==='error'&&<details className="wb-citations"><summary>请求诊断</summary>{message.requestHistory.map((request,index)=><small key={index}>{request.model} · 尝试 {request.attempt} · {Math.round(request.elapsedMs/1000)} 秒 · {request.errorKind||'完成'} · 输入 {request.inputTokens??'未返回'} / 输出 {request.outputTokens??'未返回'} Token · 输出上限 {request.outputLimit??'未返回'}{request.usageUnknown?' · 失败请求消耗未知':''}</small>)}</details>}
      {message.status !== 'running' && <footer>{message.text && <CopyButton value={message.text} />}{canEdit && <button onClick={onEdit}>修改问题</button>}{canRetry && <button onClick={onRetry}>重新生成</button>}</footer>}
    </div>
  </article>;
}
