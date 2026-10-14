import React from 'react';
import { Search, BookOpen, ChevronRight, Check, CircleAlert, LoaderCircle } from 'lucide-react';
import type { WorkbenchToolCall } from '../../../shared/workbench';

const names: Record<string, string> = { knowledge_search: '搜索知识', knowledge_read: '读取资料', skills_list: '查看可用技能', skill_read: '读取技能', sources_list: '查看知识来源', assistants_list: '查看助手', assistant_read: '读取助手配置', assistant_create: '创建助手', assistant_update: '更新助手', local_files: '查找本地文件', local_read: '读取本地文件', artifact_save: '保存工作成果', task_submit: '交给专用助手', tasks_list: '查看任务', memory_recall: '回忆相关信息', memory_remember: '保存明确记忆', memory_forget: '遗忘记忆', knowledge_append: '追加知识', knowledge_organize: '整理知识' };
const states = { running: '执行中', complete: '已完成', error: '失败', cancelled: '已停止' };
function query(call: WorkbenchToolCall): string {
  try { const input = JSON.parse(call.input); if (call.name !== 'knowledge_read') return String(input.query ?? input.name ?? input.title ?? input.path ?? input.directory ?? input.prompt ?? ''); return `${input.source_id ?? ''} / ${input.slug ?? ''}${input.offset ? ` · 从第 ${input.offset} 字开始` : ''}`; }
  catch { return call.input; }
}
function ToolResult({ call }: { call: WorkbenchToolCall }) {
  const raw = call.output ?? '';
  try {
    const data = JSON.parse(raw);
    if (data.budgetLimited && !Array.isArray(data.results) && typeof data.content !== 'string') return <div className="wb-tool-output"><p>本次结果已按剩余空间缩短，助手可以缩小查询范围后继续检索。</p></div>;
    if (call.name === 'knowledge_search' && Array.isArray(data.results)) return <div className="wb-tool-output">{data.results.length ? data.results.map((row: Record<string, unknown>, index: number) => <div key={index}><b>{String(row.title ?? '')}</b><small>{String(row.source_id ?? '')} / {String(row.slug ?? '')}</small>{typeof row.snippet === 'string' && <p>{row.snippet}</p>}</div>) : <p>{data.truncated ? '结果受上下文容量限制，请缩小查询范围。' : '本次没有找到相关资料。'}</p>}{data.truncated && data.results.length > 0 && <small>显示部分查询结果。</small>}</div>;
    if (call.name === 'knowledge_read' && typeof data.content === 'string') return <div className="wb-tool-output"><p>{data.content}</p>{data.truncated && <small>显示部分正文，助手可以继续读取后续内容。</small>}</div>;
  } catch {}
  return <div className="wb-tool-output">{raw}</div>;
}
export function ToolActivity({ calls }: { calls: WorkbenchToolCall[] }) {
  const running = calls.some(call => call.status === 'running');
  const failed = calls.filter(call => call.status === 'error').length;
  return <details className="wb-tools" open={running || failed > 0} aria-label="工作过程">
    <summary><ChevronRight size={14} /><Search size={14} /><span>{running ? names[calls.find(call => call.status === 'running')!.name] || '正在工作' : '工作过程'} · {calls.length} 步</span><small>{running ? '执行中' : failed ? `${failed} 项失败` : '已结束'}</small></summary>
    <ol>{calls.map(call => <li key={call.id} className={`wb-tool-${call.status}`}>
      <div className="wb-tool-head">{call.name === 'knowledge_read' ? <BookOpen size={14} /> : <Search size={14} />}<b>{names[call.name] || '未支持的工具'}</b><span>{call.status === 'running' ? <LoaderCircle size={12} /> : call.status === 'error' ? <CircleAlert size={12} /> : <Check size={12} />}{states[call.status]}</span></div>
      <p title={query(call)}>{query(call)}</p>
      {call.error && <p className="wb-tool-error">{call.error}</p>}
      {call.output && <details><summary>查看结果</summary><ToolResult call={call} /></details>}
    </li>)}</ol>
  </details>;
}
