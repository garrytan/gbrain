import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { AgentsPage } from './Agents';
import { ChatGptTunnelPanel } from './ChatGptTunnel';
import { RunOutput, InfoIcon, formatDate, pageTypeLabel, pageTypeTitle, type ConsoleRun, type BrainPageChunk } from '../lib/shared';

interface SourceSummary {
  id: string;
  name: string;
  local_path: string | null;
  federated: boolean;
  page_count: number;
  last_sync_at: string | null;
  archived?: boolean;
  archived_at?: string | null;
  archive_expires_at?: string | null;
}

interface BrainOverview {
  version: string;
  engine: string;
  schema_pack: string;
  chat_model: string | null;
  embedding_model: string | null;
  embedding_dimensions: number | null;
  expansion_model: string | null;
  stats: {
    page_count: number;
    chunk_count: number;
    embedded_count: number;
    link_count: number;
    tag_count: number;
    timeline_entry_count: number;
    pages_by_type: Record<string, number>;
  };
  embedding_coverage: number;
  pending_embeddings: number;
  recent_write_at: string | null;
  sources: SourceSummary[];
  main_source_id: string;
  federated_source_count: number;
  provider_status: {
    providers: Record<string, boolean>;
    chat: { enabled: boolean; chat_model: string | null; provider: string | null; missing: string[] };
  };
  llm_enabled: boolean;
  config: Record<string, unknown>;
}

interface BrainPageRow {
  id: number;
  slug: string;
  title: string | null;
  source_id: string;
  type: string;
  updated_at: string;
  chunk_count: number;
  embedded_chunks: number;
  tag_count: number;
  frontmatter: unknown;
  preview: string;
}

interface IntentPreview {
  previewId: string;
  intent: string;
  confidence: number;
  slots: Record<string, unknown>;
  proposedAction: string;
  riskLevel: 'read' | 'write' | 'maintenance';
  requiresConfirmation: boolean;
  clarification?: string;
}

interface DocsArticle {
  id: string;
  title: string;
  category: string;
  markdown: string;
}

interface NaturalTaskHistoryItem {
  id: string;
  text: string;
  createdAt: string;
  preview?: IntentPreview;
  run?: ConsoleRun;
  error?: string;
}

function pct(value: number): string {
  return `${Number.isFinite(value) ? value.toFixed(value % 1 === 0 ? 0 : 1) : '0'}%`;
}

function MetricCard({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="pm-card pm-metric">
      <div className="pm-muted">{label}</div>
      <div className="pm-metric-value">{value}</div>
      {hint && <div className="pm-hint">{hint}</div>}
    </div>
  );
}

function LoadingBlock({ text = '正在读取 PMBrain 状态...' }: { text?: string }) {
  return <div className="pm-card pm-empty">{text}</div>;
}

function useOverview() {
  const [overview, setOverview] = useState<BrainOverview | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setOverview(await api.brainOverview() as BrainOverview);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => { void load(); }, []);
  return { overview, error, reload: load };
}

function OverviewStrip({ overview }: { overview: BrainOverview }) {
  return (
    <div className="pm-status-strip">
      <span>Engine <b>{overview.engine}</b></span>
      <span>Version <b>{overview.version}</b></span>
      <span>Schema <b>{overview.schema_pack}</b></span>
      <span>Chat <b>{overview.chat_model ?? '未配置'}</b></span>
      <span>Embedding <b>{overview.embedding_model ?? '未配置'}</b></span>
      <span className={overview.llm_enabled ? 'pm-ok' : 'pm-warn'}>
        自然语言 {overview.llm_enabled ? '已启用' : '未配置'}
      </span>
    </div>
  );
}

function sourceLabel(source?: SourceSummary): string {
  if (!source) return 'default';
  return source.name && source.name !== source.id ? `${source.name} (${source.id})` : source.id;
}

function MainSourceSettings({ overview, onSaved }: { overview: BrainOverview; onSaved: () => Promise<void> }) {
  const activeSources = overview.sources.filter(source => !source.archived);
  const mainSource = activeSources.find(source => source.id === overview.main_source_id)
    ?? overview.sources.find(source => source.id === overview.main_source_id);
  const [selected, setSelected] = useState(overview.main_source_id);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    setSelected(overview.main_source_id);
    setMessage('');
  }, [overview.main_source_id]);

  const save = async () => {
    if (!selected || selected === overview.main_source_id) return;
    setSaving(true);
    setMessage('');
    try {
      await api.setDefaultSource(selected);
      await onSaved();
      setMessage(`主知识库源已设置为 ${selected}`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pm-card main-source-card">
      <div className="pm-section-head">
        <div>
          <h2>主知识库源</h2>
          <p className="pm-hint">主源会作为默认导入位置，也会作为 MCP 未指定 source 时的默认读取范围。</p>
        </div>
        <button className="pm-primary" onClick={() => void save()} disabled={saving || !selected || selected === overview.main_source_id}>
          {saving ? '保存中' : '设为主源'}
        </button>
      </div>
      <div className="main-source-grid">
        <MetricCard label="当前主源" value={overview.main_source_id} hint={mainSource?.local_path ?? '未绑定本地目录'} />
        <MetricCard label="默认导入" value={overview.main_source_id} hint="导入时未填写 Source ID 会写入这里" />
        <MetricCard label="MCP 默认读取" value={overview.main_source_id} hint="Agent 未指定 source 时会读取这里" />
      </div>
      <label>选择已有 source</label>
      <select value={selected} onChange={event => setSelected(event.target.value)}>
        {activeSources.map(source => (
          <option key={source.id} value={source.id}>{sourceLabel(source)}</option>
        ))}
      </select>
      {message && <div className={message.includes('已设置') ? 'pm-hint pm-ok' : 'pm-error-text'}>{message}</div>}
    </div>
  );
}

export function KnowledgeWorkbenchPage({ onNavigate }: { onNavigate?: (page: string) => void }) {
  const { overview, error, reload } = useOverview();

  if (error) return <div className="pm-card pm-error">{error}</div>;
  if (!overview) return <LoadingBlock />;

  const sourceMax = Math.max(...overview.sources.map(s => s.page_count), 1);
  const typeEntries = Object.entries(overview.stats.pages_by_type).sort((a, b) => b[1] - a[1]);

  return (
    <div className="pm-page">
      <OverviewStrip overview={overview} />
      <section className="pm-hero workbench-hero">
        <div>
          <div className="pm-eyebrow">PMBrain Console</div>
          <h1>项目管理知识大脑</h1>
          <p>把知识库状态、数据导入、MCP 接入、模型配置和自然语言任务执行放到一个清晰的工作台里。</p>
        </div>
      </section>

      <div className="pm-grid metrics-grid">
        <MetricCard label="Pages" value={overview.stats.page_count} hint="知识库页面总量" />
        <MetricCard label="Chunks" value={overview.stats.chunk_count} hint={`${overview.stats.embedded_count} 已向量化`} />
        <MetricCard label="Embedding 覆盖率" value={pct(overview.embedding_coverage)} hint={`${overview.pending_embeddings} 待处理`} />
        <MetricCard label="Sources" value={overview.sources.filter((s: {archived?: boolean}) => !s.archived).length} hint={`${overview.federated_source_count} federated`} />
        <MetricCard label="MCP/API" value={overview.llm_enabled ? '可用' : '待配置'} hint={overview.provider_status.chat.chat_model ?? '未设置 chat_model'} />
      </div>

      <div className="pm-grid two-col">
        <div className="pm-card">
          <div className="pm-section-head">
            <h2>页面类型分布</h2>
            <button className="pm-ghost" onClick={() => onNavigate?.('data')}>浏览数据</button>
          </div>
          <div className="pm-bars">
            {typeEntries.length === 0 && <div className="pm-empty">暂无类型数据</div>}
            {typeEntries.map(([type, count]) => (
              <div className="pm-bar-row" key={type}>
                <span title={pageTypeTitle(type)}>{pageTypeLabel(type)}</span>
                <div><i style={{ width: `${Math.max(4, count / Math.max(overview.stats.page_count, 1) * 100)}%` }} /></div>
                <b>{count}</b>
              </div>
            ))}
          </div>
        </div>

        <div className="pm-card">
          <div className="pm-section-head">
            <h2>数据源分布</h2>
            <button className="pm-ghost" onClick={() => onNavigate?.('import')}>导入数据</button>
          </div>
          <div className="pm-source-list">
            {overview.sources.filter(s => !s.archived).map(source => (
              <div className="pm-source-row" key={source.id}>
                <div>
                  <b>{source.name || source.id}</b>
                  <span>{source.id} · {source.federated ? 'federated' : 'isolated'}</span>
                </div>
                <div className="pm-mini-bar"><i style={{ width: `${source.page_count / sourceMax * 100}%` }} /></div>
                <strong>{source.page_count}</strong>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="pm-grid two-col">
        <div className="pm-card">
          <h2>运行状态</h2>
          <div className="pm-kv"><span>最近写入</span><b>{formatDate(overview.recent_write_at)}</b></div>
          <div className="pm-kv"><span>Links</span><b>{overview.stats.link_count}</b></div>
          <div className="pm-kv"><span>Tags</span><b>{overview.stats.tag_count}</b></div>
          <div className="pm-kv"><span>Timeline</span><b>{overview.stats.timeline_entry_count}</b></div>
        </div>
        <div className="pm-card">
          <h2>模型与 API</h2>
          <div className="pm-kv"><span>Chat model</span><b>{overview.chat_model ?? '未配置'}</b></div>
          <div className="pm-kv"><span>Embedding model</span><b>{overview.embedding_model ?? '未配置'}</b></div>
          <div className="pm-kv"><span>Dimensions</span><b>{overview.embedding_dimensions ?? '-'}</b></div>
          <div className="pm-kv"><span>Expansion</span><b>{overview.expansion_model ?? '-'}</b></div>
        </div>
      </div>

      <button className="pm-secondary-action" onClick={() => void reload()}>刷新状态</button>
    </div>
  );
}

const NATURAL_HISTORY_KEY = 'pmbrain.natural.history';
// Backend authority: src/commands/natural-lang/types.ts.
const MAX_NATURAL_TASK_CHARACTERS = 10_000;

function loadNaturalHistory(): NaturalTaskHistoryItem[] {
  try {
    const raw = localStorage.getItem(NATURAL_HISTORY_KEY);
    if (!raw) return [];
    const rows = JSON.parse(raw);
    return Array.isArray(rows) ? rows.slice(0, 30) as NaturalTaskHistoryItem[] : [];
  } catch {
    return [];
  }
}

function saveNaturalHistory(rows: NaturalTaskHistoryItem[]) {
  localStorage.setItem(NATURAL_HISTORY_KEY, JSON.stringify(rows.slice(0, 30)));
}

function summarizeRunResult(preview: IntentPreview, run: ConsoleRun): string {
  const intent = preview.intent;
  if (run.status === 'running') return '任务正在执行中，请稍候...';
  if (run.status === 'queued') return '任务已排队，等待执行...';
  if (run.status === 'failed') {
    return summarizeRunLog(run, '任务执行失败');
  }

  const out = run.stdout || '';
  const lower = out.toLowerCase();

  switch (intent) {
    case 'show_stats': {
      const pageMatch = out.match(/(\d+)\s*page/i);
      const chunkMatch = out.match(/(\d+)\s*chunk/i);
      const embedMatch = out.match(/(\d+)\s*(?:embedded|embedded_chunk)/i);
      const parts: string[] = [];
      if (pageMatch) parts.push(`${pageMatch[1]} 个页面`);
      if (chunkMatch) parts.push(`${chunkMatch[1]} 个片段`);
      if (embedMatch) parts.push(`${embedMatch[1]} 个已向量化`);
      return parts.length > 0
        ? `知识库当前共有 ${parts.join('、')}。`
        : '已获取知识库统计信息，请查看详情。';
    }
    case 'show_sources': {
      const sourceLines = out.split('\n').filter(l => l.trim() && !l.startsWith('-') && !l.startsWith('source'));
      const count = sourceLines.length;
      return `当前有 ${count} 个数据源，请在详情中查看各数据源详情。`;
    }
    case 'search_brain': {
      const resultLines = out.split('\n').filter(l => l.trim() && !l.startsWith('===') && !l.startsWith('search'));
      const count = resultLines.length;
      return count > 0
        ? `搜索完成，找到 ${count} 条相关结果。${count > 0 ? '请在详情中查看具体内容。' : ''}`
        : '搜索完成，未找到相关结果。';
    }
    case 'capture_memory': {
      const savedLength = String(preview.slots.content ?? '').length;
      return `已将完整文本保存到知识库，共 ${savedLength.toLocaleString('zh-CN')} 字。`;
    }
    case 'import_path': {
      if (run.error || run.stderr || /imported=\d+\s+skipped=\d+\s+errors=\d+/.test(out)) {
        return summarizeRunLog(run, '导入完成');
      }
      const pageMatch = out.match(/(\d+)\s*page/i);
      const fileMatch = out.match(/(\d+)\s*file/i);
      const parts: string[] = [];
      if (pageMatch) parts.push(`${pageMatch[1]} 个页面`);
      if (fileMatch) parts.push(`${fileMatch[1]} 个文件`);
      return parts.length > 0
        ? `导入完成，共处理 ${parts.join('、')}。`
        : summarizeRunLog(run, '导入完成');
    }
    case 'sync_source': {
      const nameMatch = out.match(/syncing source[：:]\s*(\S+)/i) || out.match(/source[：:]\s*(\S+)/i);
      const name = nameMatch ? nameMatch[1] : '';
      return name ? `数据源「${name}」同步完成。` : '数据源同步完成。';
    }
    case 'sync_all':
      return '所有数据源已同步完成。';
    case 'embed_stale':
      return '补齐向量化完成，所有待处理片段已处理。';
    case 'doctor_check': {
      if (lower.includes('ok') || lower.includes('passed') || lower.includes('通过')) return '系统诊断完成，各项检查通过。';
      if (lower.includes('warn') || lower.includes('warning') || lower.includes('failed') || lower.includes('失败')) return '系统诊断完成，发现一些问题，请在详情中查看。';
      return '系统诊断完成。';
    }
    case 'show_config':
      return '当前配置信息已获取，请在详情中查看。';
    default:
      return out ? `任务已完成。${out.slice(0, 80)}${out.length > 80 ? '…' : ''}` : '任务已完成。';
  }
}

function summarizeRunLog(run: ConsoleRun, fallback: string): string {
  const text = [run.error, run.stderr, run.stdout].filter(Boolean).join('\n');
  if (!text.trim()) return fallback;

  const latestProgress = Array.from(text.matchAll(/imported=(\d+)\s+skipped=(\d+)\s+errors=(\d+)/g)).pop();
  const totalMatch = text.match(/files=(\d+)/);
  const completedPhases = Array.from(text.matchAll(/\[pmbrain phase\]\s+([^\n]+?)\s+done/g)).map(match => match[1].trim());
  const skippedDetails = Array.from(text.matchAll(/Skipped\s+([^:]+):\s+([^\n]+)/gi))
    .map(match => ({ path: match[1].trim(), reason: match[2].trim() }));
  const warningDetails = Array.from(text.matchAll(/Warning:\s+skipped\s+([^:]+):\s+([^\n]+)/gi))
    .map(match => ({ path: match[1].trim(), reason: match[2].trim() }));
  const failures = [...skippedDetails, ...warningDetails]
    .filter(item => item.path && item.reason)
    .slice(0, 5)
    .map(item => `${item.path}: ${item.reason.replace(/\s+/g, ' ').slice(0, 100)}`);
  const failureSummary = text.match(/Import completed with\s+(\d+)\s+failure\(s\)/i);

  const parts: string[] = [];
  if (totalMatch) parts.push(`共发现 ${totalMatch[1]} 个文件`);
  if (latestProgress) {
    parts.push(`已导入 ${latestProgress[1]} 个，跳过 ${latestProgress[2]} 个，错误 ${latestProgress[3]} 个`);
  }
  if (completedPhases.length > 0) parts.push(`已完成阶段：${completedPhases.slice(0, 3).join('、')}`);
  if (failureSummary) parts.push(`失败文件 ${failureSummary[1]} 个`);

  if (failures.length > 0) {
    return [
      `${fallback}。`,
      ...parts.map(part => `- ${part}`),
      '- 失败/跳过明细：',
      ...failures.map(item => `  - ${item}`),
    ].join('\n');
  }

  return parts.length > 0 ? [`${fallback}。`, ...parts.map(part => `- ${part}`)].join('\n') : fallback;
}
function NaturalLanguagePanel({ compact = false, onNavigate }: { compact?: boolean; onNavigate?: (page: string) => void }) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<IntentPreview | null>(null);
  const [run, setRun] = useState<ConsoleRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitClicked, setSubmitClicked] = useState(false);
  const [executeClicked, setExecuteClicked] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<NaturalTaskHistoryItem[]>(() => loadNaturalHistory());
  const [activeHistoryId, setActiveHistoryId] = useState<string | null>(null);
  const inputLength = text.length;
  const inputTooLong = inputLength > MAX_NATURAL_TASK_CHARACTERS;

  const upsertHistory = (item: NaturalTaskHistoryItem) => {
    setHistory(current => {
      const next = [item, ...current.filter(row => row.id !== item.id)].slice(0, 30);
      saveNaturalHistory(next);
      return next;
    });
    setActiveHistoryId(item.id);
  };

  const selectHistory = async (item: NaturalTaskHistoryItem) => {
    setText(item.text);
    setPreview(item.preview ?? null);
    setRun(item.run ?? null);
    setError(item.error ?? '');
    setActiveHistoryId(item.id);
    if (!item.run?.id) return;
    setLoading(true);
    try {
      const nextRun = await api.run(item.run.id) as ConsoleRun;
      setRun(nextRun);
      upsertHistory({ ...item, run: nextRun });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const submitPreview = async () => {
    if (!text.trim() || inputTooLong) return;
    setSubmitClicked(true);
    setExecuteClicked(false);
    setLoading(true);
    setError('');
    setPreview(null);
    setRun(null);
    const historyItem: NaturalTaskHistoryItem = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      text: text.trim(),
      createdAt: new Date().toISOString(),
    };
    setActiveHistoryId(historyItem.id);
    try {
      const nextPreview = await api.previewIntent(text) as IntentPreview;
      setPreview(nextPreview);
      upsertHistory({ ...historyItem, preview: nextPreview });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      upsertHistory({ ...historyItem, error: message });
    } finally {
      setLoading(false);
    }
  };

  const execute = async (confirmed: boolean) => {
    if (!preview) return;
    setExecuteClicked(true);
    setLoading(true);
    setError('');
    try {
      const res = await api.executeIntent(preview.previewId, confirmed) as { runId: string };
      const first = await api.run(res.runId) as ConsoleRun;
      setRun(first);
      if (activeHistoryId) {
        const current = history.find(item => item.id === activeHistoryId);
        upsertHistory({
          id: activeHistoryId,
          text: text.trim(),
          createdAt: current?.createdAt ?? new Date().toISOString(),
          preview,
          run: first,
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!run || run.status !== 'running') return;
    const timer = setInterval(async () => {
      try {
        const nextRun = await api.run(run.id) as ConsoleRun;
        setRun(nextRun);
        if (activeHistoryId) {
          const current = history.find(item => item.id === activeHistoryId);
          if (current) upsertHistory({ ...current, run: nextRun });
        }
      } catch {}
    }, 1200);
    return () => clearInterval(timer);
  }, [run, activeHistoryId, history]);

  const summary = preview && run ? summarizeRunResult(preview, run) : null;
  const isRunActive = run?.status === 'queued' || run?.status === 'running';
  const completenessNote = preview?.intent === 'capture_memory'
    ? '页面只显示内容摘要；实际提交和保存的是上方标注字数的完整文本。'
    : preview?.intent === 'import_path'
      ? '页面只显示导入摘要；实际导入范围不会因这里的省略展示而截断，完整日志可展开查看。'
      : null;

  return (
    <div className={`nl-shell ${compact ? 'compact' : ''}`}>
      <div className={`pm-card nl-card ${compact ? 'compact' : ''}`}>
        <div className="pm-section-head">
          <h2>自然语言任务</h2>
          {compact && <button className="pm-ghost" onClick={() => onNavigate?.('natural')}>完整视图</button>}
        </div>
        <textarea
          value={text}
          onChange={e => {
            setText(e.target.value);
            setSubmitClicked(false);
            setExecuteClicked(false);
          }}
          placeholder="例如：把这段话记下来；导入文件夹路径；同步所有知识库；查一下项目相关资料"
          rows={compact ? 4 : 6}
        />
        <div className={`nl-input-meta ${inputTooLong ? 'is-over-limit' : ''}`}>
          <span>最多 10,000 字；长文会完整提交，模型只负责识别任务。</span>
          <strong>{inputLength.toLocaleString('zh-CN')} / {MAX_NATURAL_TASK_CHARACTERS.toLocaleString('zh-CN')} 字</strong>
        </div>
        {inputTooLong && (
          <div className="pm-error-text">已超出 {(inputLength - MAX_NATURAL_TASK_CHARACTERS).toLocaleString('zh-CN')} 字，请缩短后发送；系统不会静默截断内容。</div>
        )}
        <div className="pm-actions">
          <button
            className={`pm-primary ${submitClicked ? 'pm-clicked' : ''}`}
            onClick={() => void submitPreview()}
            disabled={loading || !text.trim() || inputTooLong}
          >
            {loading ? '正在理解...' : '发送'}
          </button>
          <button className="pm-ghost" onClick={() => setText('现在知识库里有哪些数据？')}>示例</button>
        </div>
        {error && <div className="pm-error-text">{error}</div>}
        {preview && (
          <div className="intent-preview">
            <p className="nl-proposed-action">{preview.clarification || preview.proposedAction}</p>
            {!preview.clarification && (
              <button
                className={`pm-primary ${executeClicked && !isRunActive ? 'pm-clicked' : ''}`}
                onClick={() => void execute(preview.requiresConfirmation)}
                disabled={loading || isRunActive}
              >
                {preview.requiresConfirmation ? '确认并执行' : '执行'}
              </button>
            )}
          </div>
        )}
        {run && (
          <div className="nl-result">
            <div className="nl-summary">
              <div className="nl-summary-text">
                <div>{summary}</div>
                {completenessNote && <div className="nl-completeness-note">{completenessNote}</div>}
              </div>
              <span className={`pm-pill run-pill run-${run.status}`}>
                {run.status === 'completed' ? '已完成' : run.status === 'failed' ? '失败' : run.status === 'running' ? '执行中' : '排队中'}
              </span>
            </div>
            <details className="nl-details">
              <summary>查看执行详情</summary>
              {run.error && <div className="pm-error-text">{run.error}</div>}
              {run.stdout && <pre>{run.stdout}</pre>}
              {run.stderr && <pre className="stderr">{run.stderr}</pre>}
            </details>
          </div>
        )}
      </div>
      {!compact && (
        <div className="pm-card nl-history">
          <div className="pm-section-head">
            <h2>历史记录</h2>
            {history.length > 0 && (
              <button
                className="pm-ghost"
                onClick={() => {
                  saveNaturalHistory([]);
                  setHistory([]);
                  setActiveHistoryId(null);
                }}
              >
                清空
              </button>
            )}
          </div>
          {history.length === 0 ? (
            <div className="pm-empty compact-empty">暂无历史记录。每次发送任务后会自动保留在这里。</div>
          ) : (
            <div className="nl-history-list">
              {history.map(item => (
                <button
                  key={item.id}
                  className={item.id === activeHistoryId ? 'active' : ''}
                  onClick={() => void selectHistory(item)}
                >
                  <span>{new Date(item.createdAt).toLocaleString()}</span>
                  <b>{item.preview?.proposedAction?.slice(0, 20) ?? item.run?.status ?? (item.error ? '失败' : '已记录')}</b>
                  <em>{item.text}</em>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ImportDataPage() {
  const { overview, error, reload } = useOverview();
  const [showArchived, setShowArchived] = useState(false);
  const [path, setPath] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [federated, setFederated] = useState(true);
  const [includeOffice, setIncludeOffice] = useState(true);
  const [includeImages, setIncludeImages] = useState(false);
  const [autoEmbed, setAutoEmbed] = useState(true);
  const [workers, setWorkers] = useState(1);
  const [run, setRun] = useState<ConsoleRun | null>(null);
  const [submitError, setSubmitError] = useState('');
  const [sourceActionId, setSourceActionId] = useState<string | null>(null);

  useEffect(() => {
    if (!run || run.status !== 'running') return;
    const timer = setInterval(async () => {
      try {
        const next = await api.run(run.id) as ConsoleRun;
        setRun(next);
        if (next.status !== 'running') void reload();
      } catch {}
    }, 1500);
    return () => clearInterval(timer);
  }, [run, reload]);

  const start = async () => {
    setSubmitError('');
    try {
      const res = await api.startImportRun({ path, sourceId: sourceId || undefined, includeOffice, includeImages, autoEmbed, workers }) as { runId: string };
      setRun(await api.run(res.runId) as ConsoleRun);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    }
  };

  const addSource = async () => {
    setSubmitError('');
    try {
      const res = await api.addSource({ id: sourceId || undefined, path, name: sourceName || undefined, federated }) as { runId: string };
      setRun(await api.run(res.runId) as ConsoleRun);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    }
  };

  const archiveSource = async (source: SourceSummary) => {
    const message = [
      `确认归档数据源 "${source.id}"？`,
      '',
      `当前页面数：${source.page_count}`,
      '归档后该数据源会从搜索、同步和默认展示中隐藏。',
      '数据会保留 72 小时，期间可以恢复；超过 72 小时后可能被物理删除。',
      '本地原始文件夹不会被删除。',
    ].join('\n');
    if (!confirm(message)) return;
    setSubmitError('');
    setSourceActionId(source.id);
    try {
      await api.archiveSource(source.id);
      setShowArchived(true);
      await reload();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSourceActionId(null);
    }
  };

  const restoreSource = async (source: SourceSummary) => {
    setSubmitError('');
    setSourceActionId(source.id);
    try {
      await api.restoreSource(source.id);
      await reload();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSourceActionId(null);
    }
  };

  const mainSource = overview?.sources.find(source => source.id === overview.main_source_id);

  return (
    <div className="pm-page">
      <h1>原始数据导入</h1>
      {error && <div className="pm-card pm-error">{error}</div>}
      {!overview ? <LoadingBlock /> : (
        <div className="pm-grid two-col import-layout">
          <div className="pm-card import-sources-card">
            <div className="pm-section-head">
              <h2>注册数据源</h2>
              <label className="checkbox-label" style={{ fontSize: 12, fontWeight: 400, cursor: 'pointer' }}>
                <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
                显示已归档
              </label>
            </div>
            <div className="import-sources-table">
            <table>
              <thead><tr><th>Source</th><th>路径</th><th>页面</th><th>同步</th></tr></thead>
              <tbody>
                {overview.sources.filter(s => showArchived || !s.archived).map(source => (
                  <tr key={source.id}>
                    <td>
                      <b>{source.id}</b>
                      <div className="pm-muted">{source.archived ? 'archived' : source.federated ? 'federated' : 'isolated'}</div>
                      {source.archived && (
                        <div className="pm-hint">可恢复至 {formatDate(source.archive_expires_at)}</div>
                      )}
                    </td>
                    <td className="mono">{source.local_path ?? '-'}</td>
                    <td>{source.page_count}</td>
                    <td>{formatDate(source.last_sync_at)}</td>
                    <td>
                      {source.archived ? (
                        <button className="pm-ghost" onClick={() => void restoreSource(source)} disabled={sourceActionId === source.id}>
                          {sourceActionId === source.id ? '恢复中' : '恢复'}
                        </button>
                      ) : source.id === 'default' ? (
                        <span className="pm-muted">-</span>
                      ) : (
                        <button className="pm-ghost" onClick={() => void archiveSource(source)} disabled={sourceActionId === source.id}>
                          {sourceActionId === source.id ? '归档中' : '归档'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
          <div className="pm-card">
            <h2>启动导入</h2>
            <label>本地文件或文件夹路径</label>
            <div className="main-source-note">
              <b>默认导入到：{overview.main_source_id}</b>
              <span>{sourceId.trim() ? `本次将覆盖为 ${sourceId.trim()}` : `未填写 Source ID 时会写入主知识库源${mainSource?.local_path ? `（${mainSource.local_path}）` : ''}`}</span>
            </div>
            <input value={path} onChange={e => setPath(e.target.value)} placeholder="C:\\MyData" />
            <label>Source ID（可选）</label>
            <input value={sourceId} onChange={e => setSourceId(e.target.value)} placeholder="例如 project-docs" />
            <label>Source 名称（注册 source 时可选）</label>
            <input value={sourceName} onChange={e => setSourceName(e.target.value)} placeholder="例如 项目资料库" />
            <div className="pm-form-row">
              <label><input type="checkbox" checked={includeOffice} onChange={e => setIncludeOffice(e.target.checked)} /> 包含 Office/PDF/Excel</label>
              <label><input type="checkbox" checked={includeImages} onChange={e => setIncludeImages(e.target.checked)} /> 包含图片/扫描件</label>
              <label><input type="checkbox" checked={autoEmbed} onChange={e => setAutoEmbed(e.target.checked)} /> 导入时向量化</label>
              <label><input type="checkbox" checked={federated} onChange={e => setFederated(e.target.checked)} /> 参与跨源搜索</label>
            </div>
            <label>Workers</label>
            <input type="number" min={1} max={8} value={workers} onChange={e => setWorkers(Number(e.target.value))} />
            <div className="pm-actions">
              <button className="pm-primary" onClick={() => void start()} disabled={!path.trim()}>开始导入</button>
              <button className="pm-ghost" onClick={() => void addSource()} disabled={!path.trim()}>注册 source</button>
            </div>
            {submitError && <div className="pm-error-text">{submitError}</div>}
            {run && <RunOutput run={run} />}
          </div>
        </div>
      )}
    </div>
  );
}

export function BrainDataPage() {
  const { overview } = useOverview();
  const [rows, setRows] = useState<BrainPageRow[]>([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, pages: 1, limit: 10 });
  const [selected, setSelected] = useState<BrainPageRow | null>(null);
  const [chunks, setChunks] = useState<BrainPageChunk[]>([]);
  const [selectedChunkIndex, setSelectedChunkIndex] = useState(0);
  const [chunksLoading, setChunksLoading] = useState(false);
  const [chunksError, setChunksError] = useState('');
  const [filters, setFilters] = useState({ source: 'all', type: 'all', embedded: 'all', q: '', page: 1, pageSize: 10 });
  const [gotoPage, setGotoPage] = useState('1');

  useEffect(() => {
    const qs = new URLSearchParams();
    qs.set('page', String(filters.page));
    qs.set('limit', String(filters.pageSize));
    if (filters.source !== 'all') qs.set('source', filters.source);
    if (filters.type !== 'all') qs.set('type', filters.type);
    if (filters.embedded !== 'all') qs.set('embedded', filters.embedded);
    if (filters.q.trim()) qs.set('q', filters.q.trim());
    api.brainPages(`?${qs.toString()}`).then((data: any) => {
      setRows(data.rows as BrainPageRow[]);
      setMeta({ total: data.total, page: data.page, pages: data.pages, limit: data.limit ?? filters.pageSize });
    }).catch(() => {});
  }, [filters]);

  useEffect(() => {
    if (!selected) {
      setChunks([]);
      setSelectedChunkIndex(0);
      setChunksError('');
      return;
    }
    setChunks([]);
    setSelectedChunkIndex(0);
    setChunksError('');
    setChunksLoading(true);
    api.brainPageChunks(selected.source_id, selected.slug)
      .then((data: any) => setChunks(data.rows as BrainPageChunk[]))
      .catch(e => setChunksError(e instanceof Error ? e.message : String(e)))
      .finally(() => setChunksLoading(false));
  }, [selected]);

  const types = useMemo(() => Object.keys(overview?.stats.pages_by_type ?? {}).sort(), [overview]);
  const chunkBlocks = useMemo(() => {
    if (chunks.length > 0) return chunks.map(chunk => ({ index: chunk.chunk_index, embedded: chunk.embedded }));
    if (!selected) return [];
    return Array.from({ length: selected.chunk_count }, (_, index) => ({
      index,
      embedded: index < selected.embedded_chunks,
    }));
  }, [chunks, selected]);
  const selectedChunk = useMemo(
    () => chunks.find(chunk => chunk.chunk_index === selectedChunkIndex) ?? chunks[0] ?? null,
    [chunks, selectedChunkIndex],
  );
  const pageButtons = useMemo(() => {
    const pages = new Set<number>([1, meta.pages, meta.page - 1, meta.page, meta.page + 1]);
    if (meta.page <= 4) [2, 3, 4, 5].forEach(p => pages.add(p));
    if (meta.page >= meta.pages - 3) [meta.pages - 4, meta.pages - 3, meta.pages - 2, meta.pages - 1].forEach(p => pages.add(p));
    const valid = [...pages].filter(p => p >= 1 && p <= meta.pages).sort((a, b) => a - b);
    const out: Array<number | 'ellipsis'> = [];
    valid.forEach((page, index) => {
      if (index > 0 && page - valid[index - 1] > 1) out.push('ellipsis');
      out.push(page);
    });
    return out;
  }, [meta.page, meta.pages]);
  const goToPage = (page: number) => {
    const next = Math.min(meta.pages, Math.max(1, page));
    setFilters(f => ({ ...f, page: next }));
    setGotoPage(String(next));
  };
  const renderPagination = () => (
    <div className="pagination">
      <span className="pagination-total">共 {meta.total} 条</span>
      <select value={filters.pageSize} onChange={e => setFilters(f => ({ ...f, pageSize: Number(e.target.value), page: 1 }))}>
        <option value={10}>10条/页</option>
        <option value={20}>20条/页</option>
        <option value={40}>40条/页</option>
      </select>
      <div className="pagination-pages">
        <button className="page-arrow" disabled={meta.page <= 1} onClick={() => goToPage(meta.page - 1)}>{'<'}</button>
        {pageButtons.map((page, index) => (
          page === 'ellipsis'
            ? <span className="page-ellipsis" key={`ellipsis-${index}`}>...</span>
            : (
              <button
                key={page}
                className={`page-number ${page === meta.page ? 'active' : ''}`}
                onClick={() => goToPage(page)}
              >
                {page}
              </button>
            )
        ))}
        <button className="page-arrow" disabled={meta.page >= meta.pages} onClick={() => goToPage(meta.page + 1)}>{'>'}</button>
      </div>
      <form className="pagination-jump" onSubmit={e => { e.preventDefault(); goToPage(Number(gotoPage) || 1); }}>
        <span>前往</span>
        <input value={gotoPage} onChange={e => setGotoPage(e.target.value.replace(/\D/g, '').slice(0, 4))} />
        <span>页</span>
      </form>
    </div>
  );

  useEffect(() => {
    setGotoPage(String(meta.page));
  }, [meta.page]);

  return (
    <div className="pm-page">
      <h1>知识库数据浏览</h1>
      <div className="pm-card">
        <div className="filter-bar">
          <input value={filters.q} onChange={e => setFilters(f => ({ ...f, q: e.target.value, page: 1 }))} placeholder="搜索 slug 或标题" />
          <select value={filters.source} onChange={e => setFilters(f => ({ ...f, source: e.target.value, page: 1 }))}>
            <option value="all">全部 source</option>
            {overview?.sources.map(s => <option key={s.id} value={s.id}>{s.id}</option>)}
          </select>
          <select value={filters.type} onChange={e => setFilters(f => ({ ...f, type: e.target.value, page: 1 }))}>
            <option value="all">全部类型</option>
            {types.map(t => <option key={t} value={t} title={pageTypeTitle(t)}>{pageTypeLabel(t)}</option>)}
          </select>
          <select value={filters.embedded} onChange={e => setFilters(f => ({ ...f, embedded: e.target.value, page: 1 }))}>
            <option value="all">向量化不限</option>
            <option value="yes">已向量化</option>
            <option value="no">未完成向量化</option>
          </select>
        </div>
        <table>
          <thead><tr><th>标题</th><th>Source</th><th>类型</th><th>Chunks</th><th>Embedding</th><th>更新</th></tr></thead>
          <tbody>
            {rows.map(row => (
              <tr key={`${row.source_id}:${row.slug}`} onClick={() => setSelected(row)}>
                <td><b>{row.title || row.slug}</b><div className="pm-muted mono">{row.slug}</div></td>
                <td>{row.source_id}</td>
                <td><span className="pm-pill" title={pageTypeTitle(row.type)}>{pageTypeLabel(row.type)}</span></td>
                <td>{row.chunk_count}</td>
                <td>{row.embedded_chunks}/{row.chunk_count}</td>
                <td>{formatDate(row.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {renderPagination()}
      </div>
      {selected && (
        <>
          <div className="drawer-overlay" onClick={() => setSelected(null)} />
          <div className="drawer light-drawer">
            <button className="drawer-close" onClick={() => setSelected(null)}>×</button>
            <h2>{selected.title || selected.slug}</h2>
            <div className="page-detail-summary">
              <div><span>Source</span><b>{selected.source_id}</b></div>
              <div><span>类型</span><b title={pageTypeTitle(selected.type)}>{pageTypeLabel(selected.type)}</b></div>
              <div><span>Chunk</span><b>{selected.embedded_chunks}/{selected.chunk_count}</b></div>
              <div><span>更新</span><b>{formatDate(selected.updated_at)}</b></div>
            </div>
            <h3>Chunk 状态</h3>
            <p className="pm-hint">点击任意 chunk 方块，下方会显示该块对应的正文。深色表示已向量化，浅色表示尚未向量化。</p>
            <div className="chunk-blocks">
              {chunkBlocks.map(block => (
                <button
                  key={block.index}
                  className={`${block.embedded ? 'embedded' : ''} ${block.index === selectedChunkIndex ? 'active' : ''}`}
                  onClick={() => setSelectedChunkIndex(block.index)}
                  title={`Chunk ${block.index + 1}: ${block.embedded ? '已向量化' : '未向量化'}`}
                >
                  {block.index + 1}
                </button>
              ))}
            </div>
            <div className="chunk-content-head">
              <h3>Chunk {selectedChunk ? selectedChunk.chunk_index + 1 : selectedChunkIndex + 1} 内容</h3>
              {selectedChunk && (
                <span>{selectedChunk.chunk_source}{selectedChunk.token_count ? ` · ${selectedChunk.token_count} tokens` : ''}</span>
              )}
            </div>
            {chunksLoading && <div className="pm-empty compact-empty">正在读取 chunk 内容...</div>}
            {chunksError && <div className="pm-error-text">{chunksError}</div>}
            {!chunksLoading && !chunksError && (
              <p className="pm-preview chunk-preview">
                {selectedChunk?.chunk_text || selected.preview || '无正文预览'}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function NaturalLanguagePage() {
  const { overview } = useOverview();
  return (
    <div className="pm-page">
      <h1>自然语言任务</h1>
      {overview && !overview.llm_enabled && (
        <div className="pm-card pm-warning">
          当前未启用自然语言能力。请先在私有配置中设置 chat_model 和对应 API key。
        </div>
      )}
      <NaturalLanguagePanel />
    </div>
  );
}

function slugifyHeading(text: string, index: number): string {
  return `${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'section'}-${index}`;
}

function extractHeadings(markdown: string) {
  return markdown
    .split('\n')
    .map((line, index) => {
      const match = /^(#{1,3})\s+(.+)$/.exec(line);
      if (!match) return null;
      return { level: match[1].length, text: match[2].trim(), id: slugifyHeading(match[2].trim(), index) };
    })
    .filter(Boolean) as Array<{ level: number; text: string; id: string }>;
}

function MarkdownArticle({ markdown }: { markdown: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = markdown.split('\n');
  let list: string[] = [];
  let code: string[] = [];
  let inCode = false;

  const flushList = () => {
    if (list.length === 0) return;
    blocks.push(<ul key={`list-${blocks.length}`}>{list.map((item, index) => <li key={index}>{item}</li>)}</ul>);
    list = [];
  };

  const flushCode = () => {
    if (code.length === 0) return;
    blocks.push(<pre key={`code-${blocks.length}`}>{code.join('\n')}</pre>);
    code = [];
  };

  lines.forEach((line, index) => {
    if (line.startsWith('```')) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        flushList();
        inCode = true;
      }
      return;
    }
    if (inCode) {
      code.push(line);
      return;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushList();
      const id = slugifyHeading(heading[2].trim(), index);
      const level = heading[1].length;
      if (level === 1) blocks.push(<h1 id={id} key={id}>{heading[2].trim()}</h1>);
      if (level === 2) blocks.push(<h2 id={id} key={id}>{heading[2].trim()}</h2>);
      if (level === 3) blocks.push(<h3 id={id} key={id}>{heading[2].trim()}</h3>);
      return;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      list.push(bullet[1]);
      return;
    }
    flushList();
    if (line.trim()) blocks.push(<p key={`p-${index}`}>{line}</p>);
  });
  flushList();
  flushCode();
  return <div className="docs-markdown">{blocks}</div>;
}

export function DocumentationPage() {
  const [articles, setArticles] = useState<DocsArticle[]>([]);
  const [selectedId, setSelectedId] = useState(() => sessionStorage.getItem('pmbrain.docs.article') || 'readme');
  const [error, setError] = useState('');

  useEffect(() => {
    api.docs()
      .then((data: any) => {
        const rows = Array.isArray(data.articles) ? data.articles as DocsArticle[] : [];
        setArticles(rows);
        if (rows.length > 0 && !rows.some(row => row.id === selectedId)) setSelectedId(rows[0].id);
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    sessionStorage.setItem('pmbrain.docs.article', selectedId);
  }, [selectedId]);

  const selected = articles.find(article => article.id === selectedId) ?? articles[0] ?? null;
  const headings = useMemo(() => extractHeadings(selected?.markdown ?? ''), [selected?.markdown]);
  const groups = useMemo(() => {
    const map = new Map<string, DocsArticle[]>();
    articles.forEach(article => {
      map.set(article.category, [...(map.get(article.category) ?? []), article]);
    });
    return [...map.entries()];
  }, [articles]);

  if (error) return <div className="pm-card pm-error">{error}</div>;
  if (!selected) return <LoadingBlock text="正在读取 PMBrain 使用文档..." />;

  return (
    <div className="pm-page docs-page">
      <div className="docs-layout">
        <aside className="docs-index">
          <div className="docs-breadcrumb">文档</div>
          {groups.map(([category, rows]) => (
            <div className="docs-group" key={category}>
              <h2>{category}</h2>
              {rows.map(article => (
                <button
                  key={article.id}
                  className={article.id === selected.id ? 'active' : ''}
                  onClick={() => setSelectedId(article.id)}
                >
                  {article.title}
                </button>
              ))}
            </div>
          ))}
        </aside>
        <article className="docs-content">
          <MarkdownArticle markdown={selected.markdown} />
        </article>
        <aside className="docs-toc">
          <h2>目录</h2>
          {headings.map(heading => (
            <button
              key={heading.id}
              className={`level-${heading.level}`}
              onClick={() => document.getElementById(heading.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            >
              {heading.text}
            </button>
          ))}
        </aside>
      </div>
    </div>
  );
}

export function ConnectionCenterPage() {
  const { overview } = useOverview();
  const origin = window.location.origin;
  const [showCodeBuddyGuide, setShowCodeBuddyGuide] = useState(false);
  const codeBuddyConfig = useMemo(() => JSON.stringify({
    mcpServers: {
      pmbrain: {
        type: 'http',
        url: `${origin}/mcp`,
        headers: {
          Authorization: 'Bearer PASTE_PMBRAIN_API_KEY_HERE',
        },
      },
    },
  }, null, 2), [origin]);
  const copyCodeBuddyConfig = () => navigator.clipboard.writeText(codeBuddyConfig);
  return (
    <div className="pm-page">
      <div className="pm-section-head">
        <div>
          <h1 className="title-with-info">
            MCP 接入
            <InfoIcon title="MCP 接入">
              MCP 接入负责告诉外部 AI 工具服务地址和认证方式。下方 Agent 凭证管理用于创建可连接 PMBrain 的身份凭证。
            </InfoIcon>
          </h1>
          <p className="pm-page-intro">
            把 PMBrain 作为 MCP Server 接入 CodeBuddy、Cursor、Claude 等 AI 工具，让它们可以安全读取、检索和写入你的本地知识库。
          </p>
        </div>
        <button className="pm-primary" onClick={() => setShowCodeBuddyGuide(true)}>MCP 接入教程</button>
      </div>
      <div className="pm-card mcp-guide-strip compact-guide">
        <div className="mcp-guide-steps">
          <span>1 创建 Agent</span>
          <span>2 复制配置</span>
          <span>3 重启/刷新 AI 工具</span>
          <span>4 让 Agent 搜索 PMBrain</span>
        </div>
      </div>
      {overview && (
        <div className="pm-card main-source-note mcp-main-source">
          <b>默认读取源：{overview.main_source_id}</b>
          <span>MCP 请求未指定 source 时，会读取主知识库源。需要修改时请到“设置”页调整主知识库源。</span>
        </div>
      )}
      <div className="pm-grid three-col">
        <MetricCard label="MCP Server" value={`${origin}/mcp`} />
        <MetricCard label="OAuth Discovery" value={`${origin}/.well-known/oauth-authorization-server`} />
        <MetricCard label="Token URL" value={`${origin}/token`} />
      </div>
      <ChatGptTunnelPanel />
      <AgentsPage
        title="Agent 凭证管理"
        titleHelp={(
          <InfoIcon title="Agent 凭证管理">
            这里就是原来的 Agent 管理。外部工具访问 PMBrain 必须携带一个 Agent 凭证，最简单方式是新建 API Key，然后把它填入教程里的 Authorization: Bearer。
          </InfoIcon>
        )}
        description="为 CodeBuddy、Cursor、Claude 等外部工具创建专用 API Key 或 OAuth 客户端。每个工具建议使用独立 Agent 凭证，后续可以单独撤销、审计请求日志和控制权限。"
      />
      {overview && (
        <div className="pm-card">
          <h2>连接状态</h2>
          <div className="pm-kv"><span>今日请求</span><b>见请求日志</b></div>
          <div className="pm-kv"><span>LLM</span><b>{overview.llm_enabled ? '已配置' : '未配置'}</b></div>
        </div>
      )}
      {showCodeBuddyGuide && (
        <div className="modal-overlay" onClick={() => setShowCodeBuddyGuide(false)}>
          <div className="modal mcp-tutorial-modal" onClick={e => e.stopPropagation()}>
            <button className="drawer-close" onClick={() => setShowCodeBuddyGuide(false)}>&#10005;</button>
            <div className="modal-title">MCP 接入教程</div>
            <div className="mcp-tutorial-body">
              <section>
                <h3>准备工作</h3>
                <ol>
                  <li>保持 PMBrain HTTP 服务运行，当前 MCP 地址是 <code>{origin}/mcp</code>。</li>
                  <li>在本页下方点击 <b>+ API Key</b>，创建一个给 CodeBuddy 使用的 Agent。</li>
                  <li>复制创建时显示的 API Key。离开弹窗后不会再次显示完整密钥。</li>
                </ol>
              </section>
              <section>
                <h3>CodeBuddy 配置</h3>
                <p>把下面内容保存到用户级 <code>~/.codebuddy/.mcp.json</code>，或当前项目根目录的 <code>.mcp.json</code>。</p>
                <div className="code-block">
                  <pre>{codeBuddyConfig}</pre>
                  <button className="copy-btn" onClick={copyCodeBuddyConfig}>复制</button>
                </div>
                <p className="pm-hint">把 <code>PASTE_PMBRAIN_API_KEY_HERE</code> 替换成刚创建的 API Key，只替换这段占位符。</p>
              </section>
              <section>
                <h3>验证连接</h3>
                <ol>
                  <li>保存配置后重启 CodeBuddy，或执行它的重新加载插件/刷新 MCP 操作。</li>
                  <li>在 CodeBuddy 中询问：<code>用 PMBrain 搜索一下最近的项目资料</code>。</li>
                  <li>回到本页的请求日志，确认出现来自 CodeBuddy 的 MCP 请求。</li>
                </ol>
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function ModelConfigPage() {
  const { overview, reload } = useOverview();
  if (!overview) return <LoadingBlock />;
  const mainSourceSettings = <MainSourceSettings overview={overview} onSaved={reload} />;
  return (
    <div className="pm-page">
      <h1>API 与模型配置</h1>
      {mainSourceSettings}
      <div className="pm-grid two-col">
        <div className="pm-card">
          <h2>模型路由</h2>
          <div className="pm-kv"><span>Chat</span><b>{overview.chat_model ?? '未配置'}</b></div>
          <div className="pm-kv"><span>Embedding</span><b>{overview.embedding_model ?? '未配置'}</b></div>
          <div className="pm-kv"><span>Dimensions</span><b>{overview.embedding_dimensions ?? '-'}</b></div>
          <div className="pm-kv"><span>Expansion</span><b>{overview.expansion_model ?? '-'}</b></div>
        </div>
        <div className="pm-card">
          <h2>Provider Key 状态</h2>
          {Object.entries(overview.provider_status.providers).map(([name, ok]) => (
            <div className="pm-kv" key={name}>
              <span>{name}</span>
              <b className={ok ? 'pm-ok' : 'pm-warn'}>{ok ? '已配置' : '未配置'}</b>
            </div>
          ))}
        </div>
      </div>
      <div className="pm-card">
        <h2>脱敏配置</h2>
        <pre>{JSON.stringify(overview.config, null, 2)}</pre>
      </div>
    </div>
  );
}

export function SystemDiagnosticPage() {
  const { overview, reload } = useOverview();
  const [run, setRun] = useState<ConsoleRun | null>(null);
  const [doctorRuns, setDoctorRuns] = useState<ConsoleRun[]>([]);
  const [error, setError] = useState('');

  const loadDoctorRuns = async () => {
    const data = await api.runs() as { rows: ConsoleRun[] };
    const rows = data.rows.filter(row => row.kind === 'doctor_check');
    setDoctorRuns(rows);
    if (!run && rows.length > 0) setRun(rows[0]);
  };

  useEffect(() => {
    loadDoctorRuns().catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (!run || (run.status !== 'running' && run.status !== 'queued')) return;
    let alive = true;
    const timer = setInterval(async () => {
      try {
        const next = await api.run(run.id) as ConsoleRun;
        if (!alive) return;
        setRun(next);
        if (next.status !== 'running' && next.status !== 'queued') {
          await loadDoctorRuns();
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    }, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [run?.id, run?.status]);

  const runDoctor = async () => {
    setError('');
    try {
      const res = await api.startActionRun('doctor_check') as { runId: string };
      setRun(await api.run(res.runId) as ConsoleRun);
      await loadDoctorRuns();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="pm-page">
      <h1>系统诊断</h1>
      {overview && (
        <div className="pm-grid metrics-grid">
          <MetricCard label="数据库" value={overview.engine} hint={overview.recent_write_at ? '可读取' : '无最近写入'} />
          <MetricCard label="Embedding" value={pct(overview.embedding_coverage)} hint={`${overview.pending_embeddings} pending`} />
          <MetricCard label="Sources" value={overview.sources.length} hint={`${overview.federated_source_count} federated`} />
          <MetricCard label="LLM" value={overview.llm_enabled ? '已配置' : '未配置'} />
        </div>
      )}
      <div className="pm-card">
        <div className="pm-actions">
          <button className="pm-primary" onClick={() => void runDoctor()}>运行 doctor --fast</button>
          <button className="pm-ghost" onClick={() => void reload()}>刷新状态</button>
        </div>
        {error && <div className="pm-error-text">{error}</div>}
        {doctorRuns.length > 0 && (
          <div className="diagnostic-history">
            <h2>本次服务运行记录</h2>
            {doctorRuns.slice(0, 5).map(item => (
              <button
                key={item.id}
                className={run?.id === item.id ? 'active' : ''}
                onClick={() => setRun(item)}
              >
                <span>{new Date(item.startedAt).toLocaleString()}</span>
                <b className={`run-${item.status}`}>{item.status}</b>
              </button>
            ))}
          </div>
        )}
        {run && <RunOutput run={run} />}
      </div>
    </div>
  );
}
