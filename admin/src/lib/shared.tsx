import React, { useState } from 'react';
import { copyText as writeClipboardText } from './clipboard';

/** Console run status shared across Console, TakeProposals, and SystemDiagnostic pages. */
export interface ConsoleRun {
  id: string;
  kind: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  command: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  /** Bounded structured command result, kept separately from truncated logs. */
  result?: unknown;
}

/** Brain page chunk shared across Console and TakeProposals pages. */
export interface BrainPageChunk {
  id: number;
  chunk_index: number;
  chunk_text: string;
  chunk_source: string;
  token_count: number | null;
  embedded: boolean;
}

const PAGE_TYPE_LABELS: Record<string, { label: string; description: string }> = {
  atom: { label: '原子知识', description: '最小粒度的事实或主张，通常由抽取流程生成。' },
  concept: { label: '概念', description: '可复用的概念、框架、模型或主题。' },
  conversation: { label: '会话', description: 'AI、聊天、访谈等对话记录或整理页。' },
  cover: { label: '封面', description: '文档、材料或集合的封面/入口页。' },
  daily: { label: '每日记录', description: '按日期组织的日历、日志或当天记录。' },
  extract_receipt: { label: '抽取回执', description: '抽取任务的过程记录和结果凭证。' },
  fact: { label: '事实', description: '可追溯、可验证的结构化事实。' },
  idea: { label: '想法', description: '待发展的问题、灵感、产品或写作种子。' },
  material: { label: '材料', description: '原始资料、附件或素材类页面。' },
  meeting: { label: '会议', description: '会议纪要、决策、行动项和跟进问题。' },
  note: { label: '笔记', description: '普通笔记或尚未细分类型的知识页。' },
  original: { label: '原创观点', description: '用户自己的观点、判断、模型或原创表达。' },
  originals: { label: '原创观点', description: '原创观点类页面的历史/兼容类型。' },
  project: { label: '项目', description: '围绕一个项目、事项或长期任务组织的页面。' },
  receipt: { label: '回执', description: '导入、同步、抽取或后台任务留下的记录。' },
  reference: { label: '参考资料', description: '外部文档、链接、教程、资料库等参考内容。' },
  reflection: { label: '反思', description: '自我认知、复盘、模式识别和情绪/判断沉淀。' },
  source: { label: '来源', description: '数据来源、导入源或源材料索引。' },
  take: { label: '观点候选', description: '可评估、可沉淀的观点或主张候选。' },
  writing: { label: '写作', description: '文章、草稿、表达性文本或写作素材。' },
};

export function pageTypeLabel(type: string): string {
  return PAGE_TYPE_LABELS[type]?.label ?? type;
}

export function pageTypeTitle(type: string): string {
  const info = PAGE_TYPE_LABELS[type];
  return info ? `${type}: ${info.description}` : `${type}: 未配置中文说明`;
}

/** Format a date string or null into locale string. */
export function formatDate(value: string | null, fallback = '无记录'): string {
  if (!value) return fallback;
  return new Date(value).toLocaleString();
}

/** Run output panel shared across Console, TakeProposals, and SystemDiagnostic pages. */
export function RunOutput({ run }: { run: ConsoleRun }) {
  const [copied, setCopied] = useState(false);
  const copyText = [
    run.command.join(' '),
    run.stdout,
    run.stderr,
  ].filter(Boolean).join('\n\n');

  const copyOutput = async () => {
    if (!copyText) return;
    try {
      await writeClipboardText(copyText);
      setCopied(true);
    } catch {
      setCopied(false);
    }
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="run-output">
      <button className="run-output-copy" type="button" onClick={() => void copyOutput()} disabled={!copyText}>
        {copied ? '已复制' : '复制'}
      </button>
      <div className="pm-kv"><span>状态</span><b className={`run-${run.status}`}>{run.status}</b></div>
      <div className="pm-kv"><span>命令</span><b>{run.command.join(' ')}</b></div>
      {run.error && <div className="pm-error-text">{run.error}</div>}
      {run.stdout && <pre>{run.stdout}</pre>}
      {run.stderr && <pre className="stderr">{run.stderr}</pre>}
    </div>
  );
}

/** Info icon with popover, shared across Console and RequestLog pages. */
export function InfoIcon({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="info-popover-wrap">
      <button className="info-icon" onClick={() => setOpen(value => !value)} aria-label={`${title}说明`}>?</button>
      {open && (
        <span className="info-popover">
          <b>{title}</b>
          <span>{children}</span>
        </span>
      )}
    </span>
  );
}
