import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useCallback, useRef } from 'react';
import { AgentsPage } from './Agents';
import { ChatGptTunnelPanel } from './ChatGptTunnel';
import { RunOutput, InfoIcon, formatDate, pageTypeLabel, pageTypeTitle, type ConsoleRun, type BrainPageChunk } from '../lib/shared';
import type { ThemeMode } from '../lib/theme';
import { getThinkRetrievalWarning, parseThinkOutput } from '../lib/think-output';
import { CopyButton } from '../lib/clipboard';
import { parseMarkdownTable } from '../lib/markdown-table';

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
  deleted_at: string | null;
  chunk_count: number;
  embedded_chunks: number;
  tag_count: number;
  frontmatter: unknown;
  preview: string;
}

interface BrainPageDetail {
  id: number;
  slug: string;
  title: string;
  source_id: string;
  source_name: string | null;
  source_path: string | null;
  type: string;
  page_kind: string;
  compiled_truth: string;
  timeline: string;
  frontmatter: unknown;
  source_kind: string | null;
  source_uri: string | null;
  created_at: string;
  updated_at: string;
  takes: Array<{ row_num: number; claim: string; kind: string; holder: string; weight: number; source: string | null }>;
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

interface NaturalWorkspaceState {
  text: string;
  preview: IntentPreview | null;
  run: ConsoleRun | null;
  error: string;
  activeHistoryId: string | null;
  pendingContext: string;
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

  const load = useCallback(async () => {
    try {
      setOverview(await api.brainOverview() as BrainOverview);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  return { overview, error, reload: load };
}

function OverviewStrip({ overview }: { overview: BrainOverview }) {
  const engineLabel = overview.engine === 'pglite' ? '本地 PGLite' : overview.engine === 'postgres' ? 'Docker / Postgres' : overview.engine;
  return (
    <div className="pm-status-strip">
      <span>数据库 <b>{engineLabel}</b></span>
      <span>版本 <b>{overview.version}</b></span>
      <span>知识结构 <b>{overview.schema_pack}</b></span>
      <span>普通模型 <b>{overview.chat_model ?? '未配置'}</b></span>
      <span>向量模型 <b>{overview.embedding_model ?? '未配置'}</b></span>
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
  const [serviceStats, setServiceStats] = useState({ connected_agents: 0, requests_today: 0, active_tokens: 0 });
  const [health, setHealth] = useState({ expiring_soon: 0, error_rate: '0%' });

  useEffect(() => {
    void Promise.all([api.stats(), api.health()]).then(([nextStats, nextHealth]: any[]) => {
      setServiceStats(nextStats);
      setHealth(nextHealth);
    }).catch(() => undefined);
  }, []);

  if (error) return <div className="pm-card pm-error">{error}</div>;
  if (!overview) return <LoadingBlock />;

  const sourceMax = Math.max(...overview.sources.map(s => s.page_count), 1);
  const typeEntries = Object.entries(overview.stats.pages_by_type).sort((a, b) => b[1] - a[1]);

  return (
    <div className="pm-page">
      <OverviewStrip overview={overview} />
      <section className="pm-hero workbench-hero">
        <div>
          <div className="pm-eyebrow">PMBRAIN OVERVIEW</div>
          <h1>你的知识库，现在是什么状态</h1>
          <p>概览只负责看：数据规模、向量覆盖、知识结构、来源、模型和 MCP 调用状态都汇总在这里。</p>
        </div>
      </section>

      <div className="pm-grid metrics-grid">
        <MetricCard label="知识页面" value={overview.stats.page_count} hint="数据库中的 Markdown 页面" />
        <MetricCard label="搜索切片" value={overview.stats.chunk_count} hint={`${overview.stats.embedded_count} 已向量化`} />
        <MetricCard label="向量覆盖" value={pct(overview.embedding_coverage)} hint={`${overview.pending_embeddings} 待处理`} />
        <MetricCard label="数据源" value={overview.sources.filter((s: {archived?: boolean}) => !s.archived).length} hint={`${overview.federated_source_count} 个参与跨源搜索`} />
        <MetricCard label="今日 MCP 请求" value={serviceStats.requests_today} hint={`${serviceStats.connected_agents} 个已连接 Agent`} />
        <MetricCard label="调用错误率" value={health.error_rate} hint={`${health.expiring_soon} 个凭证即将到期`} />
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
const NATURAL_WORKSPACE_KEY = 'pmbrain.natural.workspace';
export const NATURAL_HISTORY_LIMIT = 5;
// Backend authority: src/commands/natural-lang/types.ts.
const MAX_NATURAL_TASK_CHARACTERS = 10_000;

const MAX_KNOWLEDGE_ATTACHMENTS = 10;
const MAX_KNOWLEDGE_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const KNOWLEDGE_ATTACHMENT_EXTENSIONS = new Set([
  '.md', '.mdx', '.docx', '.doc', '.wps', '.pdf', '.xlsx', '.xlsm', '.xls', '.csv',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif', '.avif',
]);
const KNOWLEDGE_ATTACHMENT_ACCEPT = Array.from(KNOWLEDGE_ATTACHMENT_EXTENSIONS).join(',');

interface KnowledgeAttachment {
  id: string;
  file: File;
}

function attachmentExtension(name: string): string {
  const index = name.lastIndexOf('.');
  return index > -1 ? name.slice(index).toLowerCase() : '';
}

function attachmentSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function looksLikeLocalImportPath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return false;
  if (/^(?:[a-zA-Z]:[\\/]|\\\\|\/|\.{1,2}[\\/])/.test(trimmed)) return true;
  return /^[^<>:"|?*\r\n]+\.(?:md|mdx|docx|doc|wps|pdf|xlsx|xlsm|xls|csv|png|jpe?g|gif|webp|heic|heif|avif)$/i.test(trimmed);
}

async function waitForConsoleRun(runId: string, onUpdate: (run: ConsoleRun) => void): Promise<ConsoleRun> {
  let current = await api.run(runId) as ConsoleRun;
  onUpdate(current);
  while (current.status === 'queued' || current.status === 'running') {
    await new Promise(resolve => window.setTimeout(resolve, 800));
    current = await api.run(runId) as ConsoleRun;
    onUpdate(current);
  }
  return current;
}

function loadNaturalHistory(): NaturalTaskHistoryItem[] {
  try {
    const raw = localStorage.getItem(NATURAL_HISTORY_KEY);
    if (!raw) return [];
    const rows = JSON.parse(raw);
    return Array.isArray(rows) ? rows.slice(0, NATURAL_HISTORY_LIMIT) as NaturalTaskHistoryItem[] : [];
  } catch {
    return [];
  }
}

function saveNaturalHistory(rows: NaturalTaskHistoryItem[]) {
  localStorage.setItem(NATURAL_HISTORY_KEY, JSON.stringify(rows.slice(0, NATURAL_HISTORY_LIMIT)));
}

function loadNaturalWorkspace(): NaturalWorkspaceState {
  const empty: NaturalWorkspaceState = {
    text: '', preview: null, run: null, error: '', activeHistoryId: null, pendingContext: '',
  };
  if (typeof sessionStorage === 'undefined') return empty;
  try {
    const raw = sessionStorage.getItem(NATURAL_WORKSPACE_KEY);
    if (!raw) return empty;
    const saved = JSON.parse(raw) as Partial<NaturalWorkspaceState>;
    return {
      text: typeof saved.text === 'string' ? saved.text : '',
      preview: saved.preview && typeof saved.preview === 'object' ? saved.preview as IntentPreview : null,
      run: saved.run && typeof saved.run === 'object' ? saved.run as ConsoleRun : null,
      error: typeof saved.error === 'string' ? saved.error : '',
      activeHistoryId: typeof saved.activeHistoryId === 'string' ? saved.activeHistoryId : null,
      pendingContext: typeof saved.pendingContext === 'string' ? saved.pendingContext : '',
    };
  } catch {
    return empty;
  }
}

function saveNaturalWorkspace(state: NaturalWorkspaceState) {
  if (typeof sessionStorage === 'undefined') return;
  sessionStorage.setItem(NATURAL_WORKSPACE_KEY, JSON.stringify(state));
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
      const result = parseThinkOutput(out);
      if (!result) return summarizeRunLog(run, '知识库回答已生成');
      const sections = [result.answer];
      if (result.gaps.length > 0 && !/\bGaps\b|知识缺口/u.test(result.answer)) {
        sections.push(`## 知识缺口\n${result.gaps.map(item => `- ${item}`).join('\n')}`);
      }
      if (result.citations.length > 0) {
        sections.push(`## 引用来源\n${result.citations.map(item => `- \`${item}\``).join('\n')}`);
      }
      return sections.join('\n\n');
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
interface KnowledgeImportOptions {
  sourceId?: string;
  includeOffice: boolean;
  includeImages: boolean;
  autoEmbed: boolean;
  workers: number;
}

function NaturalLanguagePanel({
  compact = false,
  onNavigate,
  importOptions,
}: {
  compact?: boolean;
  onNavigate?: (page: string) => void;
  importOptions?: KnowledgeImportOptions;
}) {
  const [initialWorkspace] = useState(loadNaturalWorkspace);
  const [text, setText] = useState(initialWorkspace.text);
  const [preview, setPreview] = useState<IntentPreview | null>(initialWorkspace.preview);
  const [run, setRun] = useState<ConsoleRun | null>(initialWorkspace.run);
  const [loading, setLoading] = useState(false);
  const [submitClicked, setSubmitClicked] = useState(false);
  const [executeClicked, setExecuteClicked] = useState(false);
  const [error, setError] = useState(initialWorkspace.error);
  const [history, setHistory] = useState<NaturalTaskHistoryItem[]>(() => loadNaturalHistory());
  const [activeHistoryId, setActiveHistoryId] = useState<string | null>(initialWorkspace.activeHistoryId);
  const [pendingContext, setPendingContext] = useState(initialWorkspace.pendingContext);
  const [attachments, setAttachments] = useState<KnowledgeAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [attachmentProgress, setAttachmentProgress] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputLength = text.length;
  const inputTooLong = inputLength > MAX_NATURAL_TASK_CHARACTERS;

  const addAttachments = (files: File[]) => {
    if (files.length === 0) return;
    const existing = new Set(attachments.map(item => item.id));
    const accepted: KnowledgeAttachment[] = [];
    const warnings: string[] = [];

    for (const file of files) {
      const extension = attachmentExtension(file.name);
      const id = `${file.name}:${file.size}:${file.lastModified}`;
      const unsupportedMarkdownCase = (extension === '.md' || extension === '.mdx') && !file.name.endsWith(extension);
      if (!KNOWLEDGE_ATTACHMENT_EXTENSIONS.has(extension) || unsupportedMarkdownCase) {
        warnings.push(`不支持 ${file.name} 的文件格式`);
        continue;
      }
      if (file.size === 0) {
        warnings.push(`${file.name} 是空文件`);
        continue;
      }
      if (file.size > MAX_KNOWLEDGE_ATTACHMENT_BYTES) {
        warnings.push(`${file.name} 超过 ${attachmentSizeLabel(MAX_KNOWLEDGE_ATTACHMENT_BYTES)} 限制`);
        continue;
      }
      if (existing.has(id)) continue;
      existing.add(id);
      accepted.push({ id, file });
    }

    const available = Math.max(0, MAX_KNOWLEDGE_ATTACHMENTS - attachments.length);
    if (accepted.length > available) warnings.push(`一次最多添加 ${MAX_KNOWLEDGE_ATTACHMENTS} 个文件`);
    setAttachments(current => [...current, ...accepted.slice(0, available)]);
    setAttachmentError(warnings.join('；'));
    setSubmitClicked(false);
    setExecuteClicked(false);
  };

  const removeAttachment = (id: string) => {
    setAttachments(current => current.filter(item => item.id !== id));
    setAttachmentError('');
  };

  const handleAttachmentPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [
      ...Array.from(event.clipboardData.files),
      ...Array.from(event.clipboardData.items)
        .filter(item => item.kind === 'file')
        .map(item => item.getAsFile())
        .filter((file): file is File => Boolean(file)),
    ];
    if (files.length === 0) return;
    event.preventDefault();
    addAttachments(files);
  };

  const uploadAttachmentRuns = async (files: KnowledgeAttachment[]): Promise<ConsoleRun> => {
    let lastRun: ConsoleRun | null = null;
    for (let index = 0; index < files.length; index++) {
      const attachment = files[index];
      setAttachmentProgress(`正在导入 ${index + 1}/${files.length}：${attachment.file.name}`);
      const response = await api.startImportUploadRun(attachment.file, {
        sourceId: importOptions?.sourceId,
        autoEmbed: importOptions?.autoEmbed ?? true,
        workers: importOptions?.workers ?? 1,
      }) as { runId: string };
      lastRun = await waitForConsoleRun(response.runId, setRun);
      if (lastRun.status !== 'completed') {
        const fallback = lastRun.status === 'cancelled'
          ? `${attachment.file.name} 导入已取消`
          : `${attachment.file.name} 导入失败`;
        throw new Error(lastRun.error || lastRun.stderr || fallback);
      }
      setAttachments(current => current.filter(item => item.id !== attachment.id));
    }
    if (!lastRun) throw new Error('没有可导入的附件');
    return lastRun;
  };

  const upsertHistory = (item: NaturalTaskHistoryItem) => {
    setHistory(current => {
      const next = [item, ...current.filter(row => row.id !== item.id)].slice(0, NATURAL_HISTORY_LIMIT);
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

  const launchPreview = async (nextPreview: IntentPreview, historyItem: NaturalTaskHistoryItem, confirmed: boolean): Promise<ConsoleRun> => {
    const res = await api.executeIntent(nextPreview.previewId, confirmed) as { runId: string };
    const first = await api.run(res.runId) as ConsoleRun;
    setRun(first);
    upsertHistory({ ...historyItem, preview: nextPreview, run: first });
    return first;
  };

  const submitAuto = async () => {
    if ((!text.trim() && attachments.length === 0) || inputTooLong) return;
    setSubmitClicked(true);
    setExecuteClicked(false);
    setLoading(true);
    setError('');
    setAttachmentError('');
    setPreview(null);
    setRun(null);
    const attachedFiles = [...attachments];
    const attachedNames = attachedFiles.map(item => item.file.name);
    const requestText = text.trim() || '请阅读并整理这些文件。';
    const basePrompt = pendingContext
      ? `原始请求：${pendingContext}\n用户补充：${requestText}`
      : requestText;
    const prompt = attachedNames.length > 0
      ? `以下附件已经由系统完成导入：${attachedNames.join('、')}。不要再次请求文件路径或重复执行导入。\n用户对已导入内容的要求：${basePrompt}`
      : basePrompt;
    const historyItem: NaturalTaskHistoryItem = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      text: basePrompt,
      createdAt: new Date().toISOString(),
    };
    setActiveHistoryId(historyItem.id);
    try {
      let attachmentRun: ConsoleRun | null = null;
      if (attachedFiles.length > 0) {
        attachmentRun = await uploadAttachmentRuns(attachedFiles);
        setAttachments([]);
      }
      const nextPreview = await api.previewIntent(prompt) as IntentPreview;
      const repeatedAttachmentImport = attachmentRun && (
        nextPreview.intent === 'import_path'
        || /(?:本地)?(?:文件|文件夹)?路径|文件夹位置/u.test(nextPreview.clarification ?? '')
      );
      if (repeatedAttachmentImport && attachmentRun) {
        const importedPreview: IntentPreview = {
          previewId: `attachment-import-${Date.now()}`,
          intent: 'import_path',
          confidence: 1,
          slots: { files: attachedNames },
          proposedAction: `附件已导入知识库：${attachedNames.join('、')}`,
          riskLevel: 'write',
          requiresConfirmation: false,
        };
        setPreview(importedPreview);
        setRun(attachmentRun);
        setPendingContext('');
        setText('');
        upsertHistory({ ...historyItem, preview: importedPreview, run: attachmentRun });
        return;
      }
      setPreview(nextPreview);
      upsertHistory({ ...historyItem, preview: nextPreview });
      if (nextPreview.clarification) {
        setPendingContext(prompt);
        setText('');
      } else {
        setPendingContext('');
        if (!nextPreview.requiresConfirmation) {
          const first = await launchPreview(nextPreview, historyItem, false);
          const completed = await waitForConsoleRun(first.id, setRun);
          upsertHistory({ ...historyItem, preview: nextPreview, run: completed });
          if (completed.status === 'completed') setText('');
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      upsertHistory({ ...historyItem, error: message });
    } finally {
      setAttachmentProgress('');
      setLoading(false);
    }
  };

  const startDirect = async (kind: 'import' | 'search') => {
    const value = text.trim();
    const attachedFiles = kind === 'import' ? [...attachments] : [];
    if ((kind === 'search' ? !value : !value && attachedFiles.length === 0) || inputTooLong) return;
    setSubmitClicked(true);
    setExecuteClicked(false);
    setLoading(true);
    setError('');
    setAttachmentError('');
    setRun(null);
    setPendingContext('');
    const attachedNames = attachedFiles.map(item => item.file.name);
    const displayValue = attachedNames.length > 0 ? attachedNames.join('、') : value;
    const captureText = kind === 'import' && attachedFiles.length === 0 && !looksLikeLocalImportPath(value);
    const directPreview: IntentPreview = {
      previewId: `direct-${Date.now()}`,
      intent: kind === 'search' ? 'search_brain' : captureText ? 'capture_memory' : 'import_path',
      confidence: 1,
      slots: kind === 'search' ? { query: value } : captureText ? { content: value } : attachedNames.length > 0 ? { files: attachedNames } : { path: value },
      proposedAction: kind === 'search'
        ? `综合回答：${value}`
        : captureText
          ? `保存完整文本到知识库（共 ${value.length.toLocaleString('zh-CN')} 字）`
          : attachedNames.length > 0
            ? `导入文件：${displayValue}`
            : `导入路径：${value}`,
      riskLevel: kind === 'search' ? 'read' : 'write',
      requiresConfirmation: false,
    };
    const historyItem: NaturalTaskHistoryItem = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      text: displayValue,
      createdAt: new Date().toISOString(),
      preview: directPreview,
    };
    setActiveHistoryId(historyItem.id);
    setPreview(directPreview);
    upsertHistory(historyItem);
    try {
      let first: ConsoleRun;
      if (kind === 'import' && attachedFiles.length > 0) {
        first = await uploadAttachmentRuns(attachedFiles);
        setAttachments([]);
      } else if (captureText) {
        const response = await api.startCaptureRun(value, importOptions?.sourceId) as { runId: string };
        first = await waitForConsoleRun(response.runId, setRun);
        if (first.status === 'completed') setText('');
      } else {
        const response = kind === 'search'
          ? await api.startThinkRun(value) as { runId: string }
          : await api.startImportRun({
            path: value,
            sourceId: importOptions?.sourceId,
            includeOffice: importOptions?.includeOffice ?? true,
            includeImages: importOptions?.includeImages ?? false,
            autoEmbed: importOptions?.autoEmbed ?? true,
            workers: importOptions?.workers ?? 1,
          }) as { runId: string };
        first = await api.run(response.runId) as ConsoleRun;
      }
      setRun(first);
      upsertHistory({ ...historyItem, run: first });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      upsertHistory({ ...historyItem, error: message });
    } finally {
      setAttachmentProgress('');
      setLoading(false);
    }
  };

  const execute = async (confirmed: boolean) => {
    if (!preview || !activeHistoryId) return;
    const current = history.find(item => item.id === activeHistoryId);
    const historyItem: NaturalTaskHistoryItem = current ?? {
      id: activeHistoryId,
      text: text.trim(),
      createdAt: new Date().toISOString(),
      preview,
    };
    setExecuteClicked(true);
    setLoading(true);
    setError('');
    try {
      const first = await launchPreview(preview, historyItem, confirmed);
      const completed = await waitForConsoleRun(first.id, setRun);
      upsertHistory({ ...historyItem, preview, run: completed });
      if (completed.status === 'completed') {
        setText('');
        setPendingContext('');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    saveNaturalWorkspace({ text, preview, run, error, activeHistoryId, pendingContext });
  }, [text, preview, run, error, activeHistoryId, pendingContext]);

  useEffect(() => {
    if (!run || (run.status !== 'running' && run.status !== 'queued')) return;
    const timer = setInterval(async () => {
      try {
        const nextRun = await api.run(run.id) as ConsoleRun;
        setRun(nextRun);
        if (activeHistoryId) {
          setHistory(current => {
            const next = current.map(item => item.id === activeHistoryId ? { ...item, run: nextRun } : item);
            saveNaturalHistory(next);
            return next;
          });
        }
      } catch {}
    }, 1200);
    return () => clearInterval(timer);
  }, [run?.id, run?.status, activeHistoryId]);

  const summary = preview && run ? summarizeRunResult(preview, run) : null;
  const searchWarning = preview?.intent === 'search_brain' && run
    ? getThinkRetrievalWarning(run.stderr)
    : null;
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
          <div>
            <div className="pm-eyebrow">一处完成常用知识工作</div>
            <h2>知识助手</h2>
          </div>
          {compact && <button className="pm-ghost" onClick={() => onNavigate?.('import')}>完整视图</button>}
        </div>
        {pendingContext && <div className="assistant-followup">请补充上一个问题需要的信息，发送后会继续判断。</div>}
        <div className="assistant-composer">
          {attachments.length > 0 && (
            <div className="assistant-attachments" role="list" aria-label={`已添加 ${attachments.length} 个文件`}>
              {attachments.map(attachment => {
                const extension = attachmentExtension(attachment.file.name).slice(1).toUpperCase();
                return (
                  <div className="assistant-attachment-chip" role="listitem" key={attachment.id}>
                    <span className="assistant-file-type" aria-hidden="true">{extension.slice(0, 4) || 'FILE'}</span>
                    <span className="assistant-file-copy">
                      <strong title={attachment.file.name}>{attachment.file.name}</strong>
                      <small>{attachmentSizeLabel(attachment.file.size)}</small>
                    </span>
                    <button
                      type="button"
                      className="assistant-remove-file"
                      aria-label={`移除文件 ${attachment.file.name}`}
                      title="移除文件"
                      onClick={() => removeAttachment(attachment.id)}
                      disabled={loading}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <textarea
            value={text}
            onChange={e => {
              setText(e.target.value);
              setSubmitClicked(false);
              setExecuteClicked(false);
            }}
            onPaste={handleAttachmentPaste}
            placeholder={pendingContext ? '在这里补充路径、Source 或其他缺少的信息…' : '输入要保存的正文、本地文件路径或知识库问题；也可点击 + 或直接粘贴文件…'}
            rows={compact ? 4 : 6}
          />
          <div className="assistant-composer-footer">
            <input
              ref={fileInputRef}
              className="assistant-file-input"
              type="file"
              multiple
              accept={KNOWLEDGE_ATTACHMENT_ACCEPT}
              aria-label="选择本地文件"
              tabIndex={-1}
              onChange={event => {
                addAttachments(Array.from(event.target.files ?? []));
                event.target.value = '';
              }}
            />
            <button
              type="button"
              className="assistant-attach-button"
              aria-label="添加本地文件"
              title="添加本地文件"
              onClick={() => fileInputRef.current?.click()}
              disabled={loading || attachments.length >= MAX_KNOWLEDGE_ATTACHMENTS}
            >
              +
            </button>
            <span
              className="assistant-attachment-help"
              aria-live="polite"
              title="支持 Markdown、Office/PDF/表格和图片，单个文件不超过 50 MB"
            >
              {attachmentProgress || (attachments.length > 0 ? `已添加 ${attachments.length} 个文件` : '选择文件，也可以从资源管理器复制后粘贴')}
            </span>
          </div>
        </div>
        <div className={`nl-input-meta ${inputTooLong ? 'is-over-limit' : ''}`}>
          <span>{attachments.length > 0 ? '导入会处理附件；发送会先导入再按文字要求处理；搜索只使用文字。' : '导入可保存正文或导入路径；搜索会一步执行；发送由 AI 判断后处理。'}</span>
          <strong>{inputLength.toLocaleString('zh-CN')} / {MAX_NATURAL_TASK_CHARACTERS.toLocaleString('zh-CN')} 字</strong>
        </div>
        {attachmentError && <div className="pm-error-text" role="alert">{attachmentError}</div>}
        {inputTooLong && (
          <div className="pm-error-text">已超出 {(inputLength - MAX_NATURAL_TASK_CHARACTERS).toLocaleString('zh-CN')} 字，请缩短后发送；系统不会静默截断内容。</div>
        )}
        <div className="pm-actions assistant-actions" aria-label="知识助手操作">
          <button
            type="button"
            className="pm-assistant-action import-action"
            onClick={() => void startDirect('import')}
            disabled={loading || (!text.trim() && attachments.length === 0) || inputTooLong}
          >
            <span className="assistant-action-icon" aria-hidden="true">↥</span>
            <span className="assistant-action-copy"><strong>导入</strong></span>
          </button>
          <button
            type="button"
            className="pm-assistant-action search-action"
            onClick={() => void startDirect('search')}
            disabled={loading || !text.trim() || inputTooLong}
          >
            <span className="assistant-action-icon" aria-hidden="true">⌕</span>
            <span className="assistant-action-copy"><strong>搜索</strong></span>
          </button>
          <button
            type="button"
            className={`pm-assistant-action ai-action ${submitClicked ? 'pm-clicked' : ''}`}
            onClick={() => void submitAuto()}
            disabled={loading || (!text.trim() && attachments.length === 0) || inputTooLong}
          >
            <span className="assistant-action-icon" aria-hidden="true">✦</span>
            <span className="assistant-action-copy"><strong>{loading ? '处理中…' : '发送'}</strong></span>
          </button>
        </div>
        {error && <div className="pm-error-text">{error}</div>}
        {searchWarning && <div className="assistant-search-warning" role="status">{searchWarning}</div>}
        {preview && (
          <div className="intent-preview">
            <p className="nl-proposed-action">{preview.clarification || preview.proposedAction}</p>
            {!preview.clarification && preview.requiresConfirmation && (
              <button
                className={`pm-primary ${executeClicked && !isRunActive ? 'pm-clicked' : ''}`}
                onClick={() => void execute(preview.requiresConfirmation)}
                disabled={loading || isRunActive}
              >
                确认并执行
              </button>
            )}
          </div>
        )}
        {run && (
          <div className="nl-result">
            <div className="nl-summary">
              <div className="nl-summary-text">
                {summary && <MarkdownArticle markdown={summary} />}
                {completenessNote && <div className="nl-completeness-note">{completenessNote}</div>}
              </div>
              <span className={`pm-pill run-pill run-${run.status}`}>
                {searchWarning ? '检索超时' : run.status === 'completed' ? '已完成' : run.status === 'failed' ? '失败' : run.status === 'running' ? '执行中' : '排队中'}
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
            <h2>最近 5 条</h2>
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
  const { overview, error } = useOverview();
  const [sourceId, setSourceId] = useState('');
  const [includeOffice, setIncludeOffice] = useState(true);
  const [includeImages, setIncludeImages] = useState(false);
  const [autoEmbed, setAutoEmbed] = useState(true);
  const [workers, setWorkers] = useState(1);

  return (
    <div className="pm-page knowledge-assistant-page">
      <section className="assistant-hero">
        <div>
          <div className="pm-eyebrow">IMPORT · SEARCH · ASK</div>
          <h1>知识工作台</h1>
          <p>输入正文、路径或添加文件；导入会直接保存，其他需求可搜索或发送给 AI。</p>
        </div>
        <div className="assistant-pulse" aria-hidden="true"><i /><i /><i /></div>
      </section>
      {error && <div className="pm-card pm-error">{error}</div>}
      {overview && !overview.llm_enabled && (
        <div className="pm-card pm-warning">搜索综合和 AI 意图识别需要普通模型；正文、路径和附件导入仍可直接使用。</div>
      )}
      <details className="pm-card import-options">
        <summary>导入选项 <span>默认写入 {overview?.main_source_id ?? '主知识库源'}</span></summary>
        <div className="import-option-grid">
          <label>
            <span>写入位置</span>
            <select value={sourceId} onChange={event => setSourceId(event.target.value)}>
              <option value="">主知识库源（{overview?.main_source_id ?? '自动'}）</option>
              {overview?.sources.filter(source => !source.archived).map(source => (
                <option key={source.id} value={source.id}>{sourceLabel(source)}</option>
              ))}
            </select>
          </label>
          <label><input type="checkbox" checked={includeOffice} onChange={event => setIncludeOffice(event.target.checked)} /> Office / PDF / Excel</label>
          <label><input type="checkbox" checked={includeImages} onChange={event => setIncludeImages(event.target.checked)} /> 图片 / 扫描件</label>
          <label><input type="checkbox" checked={autoEmbed} onChange={event => setAutoEmbed(event.target.checked)} /> 导入后向量化</label>
          <label className="worker-option"><span>并行任务</span><input type="number" min={1} max={8} value={workers} onChange={event => setWorkers(Math.max(1, Math.min(8, Number(event.target.value) || 1)))} /></label>
        </div>
      </details>
      <NaturalLanguagePanel importOptions={{ sourceId: sourceId || undefined, includeOffice, includeImages, autoEmbed, workers }} />
    </div>
  );
}

function SourceManagementSettings() {
  const { overview, error, reload } = useOverview();
  const [showArchived, setShowArchived] = useState(false);
  const [path, setPath] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [federated, setFederated] = useState(true);
  const [run, setRun] = useState<ConsoleRun | null>(null);
  const [submitError, setSubmitError] = useState('');
  const [sourceActionId, setSourceActionId] = useState<string | null>(null);

  useEffect(() => {
    if (!run || (run.status !== 'running' && run.status !== 'queued')) return;
    const timer = setInterval(async () => {
      try {
        const next = await api.run(run.id) as ConsoleRun;
        setRun(next);
        if (next.status !== 'running') void reload();
      } catch {}
    }, 1500);
    return () => clearInterval(timer);
  }, [run, reload]);

  const addSource = async () => {
    setSubmitError('');
    try {
      const res = await api.addSource({ id: sourceId || undefined, path, name: sourceName || undefined, federated }) as { runId: string };
      const first = await api.run(res.runId) as ConsoleRun;
      setRun(first);
      if (first.status !== 'running' && first.status !== 'queued') await reload();
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

  return (
    <section className="settings-source-section">
      <div className="pm-section-head">
        <div><h2>数据源与归档</h2><p className="pm-hint">注册要持续同步的资料目录；不再使用的 Source 可归档，72 小时内恢复。</p></div>
      </div>
      {error && <div className="pm-card pm-error">{error}</div>}
      {!overview ? <LoadingBlock /> : (
        <div className="pm-grid two-col import-layout">
          <div className="pm-card import-sources-card">
            <div className="pm-section-head">
              <h3>已有数据源</h3>
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
                        <div className="pm-hint">可恢复至 {formatDate(source.archive_expires_at ?? null)}</div>
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
                      ) : source.id === 'default' || source.id === overview.main_source_id ? (
                        <span className="pm-muted">{source.id === overview.main_source_id ? '主源' : '-'}</span>
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
            <h3>注册资料目录</h3>
            <p className="pm-hint">注册后，PMBrain 可按 Source 同步这个目录。单次导入请到“知识工作台”。</p>
            <label>本地资料目录</label>
            <div className="main-source-note">
              <b>当前主知识库源：{overview.main_source_id}</b>
              <span>新 Source 注册后不会自动替换主源，可在上方“主知识库源”单独切换。</span>
            </div>
            <input value={path} onChange={e => setPath(e.target.value)} placeholder="C:\\MyData" />
            <label>Source ID（留空自动生成）</label>
            <input value={sourceId} onChange={e => setSourceId(e.target.value)} placeholder="例如 project-docs" />
            <label>显示名称（可选）</label>
            <input value={sourceName} onChange={e => setSourceName(e.target.value)} placeholder="例如 项目资料库" />
            <div className="pm-form-row">
              <label><input type="checkbox" checked={federated} onChange={e => setFederated(e.target.checked)} /> 参与跨源搜索</label>
            </div>
            <div className="pm-actions">
              <button className="pm-primary" onClick={() => void addSource()} disabled={!path.trim()}>注册数据源</button>
            </div>
            {submitError && <div className="pm-error-text">{submitError}</div>}
            {run && <RunOutput run={run} />}
          </div>
        </div>
      )}
    </section>
  );
}

export function BrainDataPage() {
  const { overview } = useOverview();
  const [rows, setRows] = useState<BrainPageRow[]>([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, pages: 1, limit: 10 });
  const [selected, setSelected] = useState<BrainPageRow | null>(null);
  const [detail, setDetail] = useState<BrainPageDetail | null>(null);
  const [detailTab, setDetailTab] = useState<'content' | 'knowledge' | 'chunks'>('content');
  const [chunks, setChunks] = useState<BrainPageChunk[]>([]);
  const [selectedChunkIndex, setSelectedChunkIndex] = useState(0);
  const [chunksLoading, setChunksLoading] = useState(false);
  const [chunksError, setChunksError] = useState('');
  const [pageError, setPageError] = useState('');
  const [filters, setFilters] = useState({ view: 'all', source: 'all', type: 'all', embedded: 'all', q: '', page: 1, pageSize: 10 });
  const [gotoPage, setGotoPage] = useState('1');

  const loadRows = useCallback(async () => {
    const qs = new URLSearchParams();
    qs.set('page', String(filters.page));
    qs.set('limit', String(filters.pageSize));
    if (filters.source !== 'all') qs.set('source', filters.source);
    if (filters.type !== 'all') qs.set('type', filters.type);
    if (filters.view !== 'all') qs.set('view', filters.view);
    if (filters.embedded !== 'all') qs.set('embedded', filters.embedded);
    if (filters.q.trim()) qs.set('q', filters.q.trim());
    const data = await api.brainPages(`?${qs.toString()}`) as any;
    setRows(data.rows as BrainPageRow[]);
    setMeta({ total: data.total, page: data.page, pages: data.pages, limit: data.limit ?? filters.pageSize });
  }, [filters]);

  useEffect(() => {
    void loadRows().catch(() => undefined);
  }, [loadRows]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      setChunks([]);
      setSelectedChunkIndex(0);
      setChunksError('');
      return;
    }
    setChunks([]);
    setDetail(null);
    setDetailTab('content');
    setSelectedChunkIndex(0);
    setChunksError('');
    setChunksLoading(true);
    Promise.all([
      api.brainPage(selected.source_id, selected.slug, filters.view === 'trash'),
      api.brainPageChunks(selected.source_id, selected.slug, filters.view === 'trash'),
    ])
      .then(([page, chunkData]: any[]) => {
        setDetail(page as BrainPageDetail);
        setChunks(chunkData.rows as BrainPageChunk[]);
      })
      .catch(e => setChunksError(e instanceof Error ? e.message : String(e)))
      .finally(() => setChunksLoading(false));
  }, [selected, filters.view]);

  const types = useMemo(() => {
    const viewTypes: Record<string, Set<string>> = {
      materials: new Set(['material', 'reference', 'source', 'conversation', 'meeting', 'note', 'cover']),
      structured: new Set(['atom', 'fact', 'concept']),
      insights: new Set(['take', 'original', 'originals', 'reflection', 'pattern']),
    };
    const allowed = viewTypes[filters.view];
    return Object.keys(overview?.stats.pages_by_type ?? {}).filter(type => !allowed || allowed.has(type)).sort();
  }, [overview, filters.view]);
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

  const deleteSelectedPage = async () => {
    if (!selected) return;
    const confirmed = confirm([
      `把“${selected.title || selected.slug}”移出知识库？`,
      '',
      '它会立即从搜索和知识数据中隐藏，72 小时内可恢复。',
      '本地原始文件不会被删除。',
    ].join('\n'));
    if (!confirmed) return;
    setPageError('');
    try {
      await api.deleteBrainPage(selected.source_id, selected.slug);
      setSelected(null);
      await loadRows();
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    }
  };

  const restoreSelectedPage = async () => {
    if (!selected) return;
    setPageError('');
    try {
      await api.restoreBrainPage(selected.source_id, selected.slug);
      await loadRows();
      setSelected(null);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="pm-page brain-data-page">
      <div className="pm-section-head">
        <div>
          <div className="pm-eyebrow">DATABASE · MARKDOWN · KNOWLEDGE</div>
          <h1>知识数据</h1>
          <p className="pm-page-intro">这里展示数据库中的可检索 Markdown 页面。原始资料、结构化知识和观点总结可以分开查看。</p>
        </div>
      </div>
      {pageError && <div className="pm-error-text">{pageError}</div>}
      <div className="pm-card">
        <div className="knowledge-view-tabs" role="tablist" aria-label="知识数据范围">
          {[
            ['all', '全部'],
            ['materials', '原始与资料'],
            ['structured', '结构化知识'],
            ['insights', '观点与总结'],
            ['trash', '回收站'],
          ].map(([value, label]) => (
            <button
              key={value}
              className={filters.view === value ? 'active' : ''}
              onClick={() => {
                setSelected(null);
                setPageError('');
                setFilters(current => ({ ...current, view: value, type: 'all', page: 1 }));
              }}
            >{label}</button>
          ))}
        </div>
        {filters.view === 'trash' && <p className="trash-retention-note">移出的内容保留 3 天，之后自动清空。打开详情可以撤销删除。</p>}
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
        <table className="brain-page-table">
          <thead><tr><th>标题</th><th>Source</th><th>类型</th><th>Chunks</th><th>Embedding</th><th>{filters.view === 'trash' ? '移除时间' : '更新'}</th></tr></thead>
          <tbody>
            {rows.map(row => (
              <tr
                key={`${row.source_id}:${row.slug}`}
                tabIndex={0}
                aria-label={`查看 ${row.title || row.slug}`}
                onClick={() => setSelected(row)}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setSelected(row);
                  }
                }}
              >
                <td><b>{row.title || row.slug}</b><div className="pm-muted mono">{row.slug}</div></td>
                <td>{row.source_id}</td>
                <td><span className="pm-pill" title={pageTypeTitle(row.type)}>{pageTypeLabel(row.type)}</span></td>
                <td>{row.chunk_count}</td>
                <td>{row.embedded_chunks}/{row.chunk_count}</td>
                <td>{formatDate(filters.view === 'trash' ? row.deleted_at : row.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {renderPagination()}
      </div>
      {selected && (
        <>
          <div className="drawer-overlay" onClick={() => setSelected(null)} />
          <div className="drawer light-drawer knowledge-drawer">
            <button className="drawer-close" onClick={() => setSelected(null)}>×</button>
            <div className="knowledge-drawer-head">
              <div>
                <div className="pm-eyebrow">{selected.source_id} / {selected.slug}</div>
                <h2>{selected.title || selected.slug}</h2>
              </div>
              {filters.view === 'trash'
                ? <button className="restore-text-button" onClick={() => void restoreSelectedPage()}>撤销删除</button>
                : <button className="danger-text-button" onClick={() => void deleteSelectedPage()}>移出知识库</button>}
            </div>
            <div className="page-detail-summary">
              <div><span>Source</span><b>{selected.source_id}</b></div>
              <div><span>类型</span><b title={pageTypeTitle(selected.type)}>{pageTypeLabel(selected.type)}</b></div>
              <div><span>Chunk</span><b>{selected.embedded_chunks}/{selected.chunk_count}</b></div>
              <div><span>更新</span><b>{formatDate(selected.updated_at)}</b></div>
            </div>
            <div className="drawer-tabs" role="tablist">
              <button className={detailTab === 'content' ? 'active' : ''} onClick={() => setDetailTab('content')}>Markdown 内容</button>
              <button className={detailTab === 'knowledge' ? 'active' : ''} onClick={() => setDetailTab('knowledge')}>观点与信息</button>
              <button className={detailTab === 'chunks' ? 'active' : ''} onClick={() => setDetailTab('chunks')}>切片状态</button>
            </div>
            {chunksLoading && <div className="pm-empty compact-empty">正在读取 chunk 内容...</div>}
            {chunksError && <div className="pm-error-text">{chunksError}</div>}
            {!chunksLoading && !chunksError && detailTab === 'content' && (
              <article className="knowledge-markdown">
                <MarkdownArticle markdown={detail?.compiled_truth || selected.preview || '暂无 Markdown 内容。'} />
                {detail?.timeline && <><h3>时间线</h3><MarkdownArticle markdown={detail.timeline} /></>}
              </article>
            )}
            {!chunksLoading && !chunksError && detailTab === 'knowledge' && (
              <div className="knowledge-meta-view">
                <section>
                  <h3>关联观点</h3>
                  {detail?.takes.length ? detail.takes.map(take => (
                    <article className="take-summary-row" key={take.row_num}>
                      <span>#{take.row_num} · {take.kind}</span>
                      <p>{take.claim}</p>
                      <small>{take.holder} · 权重 {take.weight}</small>
                    </article>
                  )) : <div className="pm-empty compact-empty">这个页面暂时没有独立观点记录。</div>}
                </section>
                <section>
                  <h3>页面信息</h3>
                  <div className="pm-kv"><span>来源目录</span><b>{detail?.source_path ?? '未绑定本地目录'}</b></div>
                  <div className="pm-kv"><span>来源类型</span><b>{detail?.source_kind ?? detail?.page_kind ?? '-'}</b></div>
                  <div className="pm-kv"><span>来源地址</span><b>{detail?.source_uri ?? '-'}</b></div>
                  <details className="metadata-details"><summary>查看 Frontmatter</summary><pre>{JSON.stringify(detail?.frontmatter ?? selected.frontmatter, null, 2)}</pre></details>
                </section>
              </div>
            )}
            {!chunksLoading && !chunksError && detailTab === 'chunks' && (
              <div className="chunk-detail-view">
                <p className="pm-hint">切片用于搜索召回。这里保留技术检查入口，但正文请优先在“Markdown 内容”中阅读。</p>
                <div className="chunk-blocks">
                  {chunkBlocks.map(block => (
                    <button
                      key={block.index}
                      className={`${block.embedded ? 'embedded' : ''} ${block.index === selectedChunkIndex ? 'active' : ''}`}
                      onClick={() => setSelectedChunkIndex(block.index)}
                      title={`Chunk ${block.index + 1}: ${block.embedded ? '已向量化' : '未向量化'}`}
                    >{block.index + 1}</button>
                  ))}
                </div>
                <div className="chunk-content-head">
                  <h3>Chunk {selectedChunk ? selectedChunk.chunk_index + 1 : selectedChunkIndex + 1}</h3>
                  {selectedChunk && <span>{selectedChunk.chunk_source}{selectedChunk.token_count ? ` · ${selectedChunk.token_count} tokens` : ''}</span>}
                </div>
                <div className="pm-preview chunk-preview">{selectedChunk?.chunk_text || selected.preview || '无正文预览'}</div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function NaturalLanguagePage() {
  return <ImportDataPage />;
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

function InlineMarkdown({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)]+\))/g).filter(Boolean);
  return <>{parts.map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) return <code key={`${part}-${index}`}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={`${part}-${index}`}>{part.slice(2, -2)}</strong>;
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/.exec(part);
    if (link) return <a key={`${link[2]}-${index}`} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
    return <React.Fragment key={`${part}-${index}`}>{part}</React.Fragment>;
  })}</>;
}

function MarkdownArticle({ markdown }: { markdown: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = markdown.split('\n');
  let list: string[] = [];
  let code: string[] = [];
  let inCode = false;

  const flushList = () => {
    if (list.length === 0) return;
    blocks.push(<ul key={`list-${blocks.length}`}>{list.map((item, index) => <li key={`${item}-${index}`}><InlineMarkdown text={item} /></li>)}</ul>);
    list = [];
  };

  const flushCode = () => {
    if (code.length === 0) return;
    blocks.push(<pre key={`code-${blocks.length}`}>{code.join('\n')}</pre>);
    code = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith('```')) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        flushList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    const table = parseMarkdownTable(lines, index);
    if (table) {
      flushList();
      blocks.push(
        <div className="markdown-table-wrap" key={`table-${index}`}>
          <table>
            <thead><tr>{table.headers.map((cell, cellIndex) => <th key={`${cell}-${cellIndex}`}><InlineMarkdown text={cell} /></th>)}</tr></thead>
            <tbody>{table.rows.map((row, rowIndex) => (
              <tr key={`row-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`${cellIndex}-${cell}`}><InlineMarkdown text={cell} /></td>)}</tr>
            ))}</tbody>
          </table>
        </div>,
      );
      index = table.endIndex - 1;
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushList();
      const id = slugifyHeading(heading[2].trim(), index);
      const level = heading[1].length;
      if (level === 1) blocks.push(<h1 id={id} key={id}><InlineMarkdown text={heading[2].trim()} /></h1>);
      if (level === 2) blocks.push(<h2 id={id} key={id}><InlineMarkdown text={heading[2].trim()} /></h2>);
      if (level === 3) blocks.push(<h3 id={id} key={id}><InlineMarkdown text={heading[2].trim()} /></h3>);
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      list.push(bullet[1]);
      continue;
    }
    flushList();
    if (/^>{1}\s?/.test(line)) {
      blocks.push(<blockquote key={`quote-${index}`}><InlineMarkdown text={line.replace(/^>\s?/, '')} /></blockquote>);
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) {
      blocks.push(<hr key={`rule-${index}`} />);
      continue;
    }
    if (line.trim()) blocks.push(<p key={`p-${index}`}><InlineMarkdown text={line} /></p>);
  }
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
      <section className="mcp-client-section" aria-labelledby="mcp-client-title">
        <div className="pm-section-head compact-head">
          <div>
            <h2 id="mcp-client-title">可接入的 AI 工具</h2>
            <p className="pm-hint">本地客户端共用标准 HTTP MCP 地址；ChatGPT 远程接入使用下方安全隧道。</p>
          </div>
        </div>
        <div className="mcp-client-grid">
          {[
            ['CodeBuddy', '标准 HTTP', '配置模板已就绪'],
            ['Cursor', '标准 HTTP', '使用同一 MCP 地址'],
            ['Claude', '标准 HTTP', '使用客户端 MCP 配置'],
            ['Codex', '标准 HTTP', '使用同一 MCP 地址'],
            ['ChatGPT', '远程隧道', '见下方连接向导'],
            ['其他客户端', '标准 HTTP', '兼容 MCP 即可接入'],
          ].map(([name, mode, note]) => (
            <article className="mcp-client-card" key={name}>
              <div><b>{name}</b><span>{mode}</span></div>
              <p>{note}</p>
              {name === 'CodeBuddy' && <button className="pm-ghost" onClick={() => setShowCodeBuddyGuide(true)}>查看配置</button>}
            </article>
          ))}
        </div>
      </section>
      {overview && (
        <div className="pm-card main-source-note mcp-main-source">
          <b>默认读取源：{overview.main_source_id}</b>
          <span>MCP 请求未指定 source 时，会读取主知识库源。需要修改时请到“设置”页调整主知识库源。</span>
        </div>
      )}
      <div className="mcp-endpoint-grid">
        {[
          ['MCP Server', `${origin}/mcp`],
          ['OAuth Discovery', `${origin}/.well-known/oauth-authorization-server`],
          ['Token URL', `${origin}/token`],
        ].map(([label, value]) => (
          <article className="mcp-endpoint-card" key={label}>
            <span>{label}</span>
            <code>{value}</code>
            <CopyButton className="pm-ghost" value={value} />
          </article>
        ))}
      </div>
      <AgentsPage
        title="Agent 凭证管理"
        titleHelp={(
          <InfoIcon title="Agent 凭证管理">
            这里就是原来的 Agent 管理。外部工具访问 PMBrain 必须携带一个 Agent 凭证，最简单方式是新建 API Key，然后把它填入教程里的 Authorization: Bearer。
          </InfoIcon>
        )}
        description="为 CodeBuddy、Cursor、Claude 等外部工具创建专用 API Key 或 OAuth 客户端。每个工具建议使用独立 Agent 凭证，后续可以单独撤销、审计请求日志和控制权限。"
      />
      <details className="mcp-tunnel-details">
        <summary>
          <span>ChatGPT Secure MCP Tunnel</span>
          <small>仅在需要让 ChatGPT 远程读取 PMBrain 时展开</small>
        </summary>
        <div className="mcp-tunnel-details-body">
          <ChatGptTunnelPanel />
        </div>
      </details>
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
                  <CopyButton value={codeBuddyConfig} />
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
  return (
    <div className="pm-page">
      <h1>模型配置快照</h1>
      <p className="pm-page-intro">模型和 API Key 由桌面端统一管理。本页只显示当前实际读取到的脱敏配置。</p>
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

function MarkdownExportSettings() {
  const [rootPath, setRootPath] = useState('');
  const [run, setRun] = useState<ConsoleRun | null>(null);
  const [outputDir, setOutputDir] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!run || (run.status !== 'running' && run.status !== 'queued')) return;
    const timer = window.setInterval(async () => {
      try {
        setRun(await api.run(run.id) as ConsoleRun);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    }, 1200);
    return () => window.clearInterval(timer);
  }, [run?.id, run?.status]);

  const startExport = async () => {
    if (!rootPath.trim()) return;
    setError('');
    setOutputDir('');
    try {
      const response = await api.startMarkdownExportRun(rootPath.trim()) as { runId: string; outputDir: string };
      setOutputDir(response.outputDir);
      setRun(await api.run(response.runId) as ConsoleRun);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  };

  return (
    <div className="pm-card markdown-export-card">
      <div className="pm-section-head">
        <div>
          <h2>导出本地 Markdown</h2>
          <p className="pm-hint">可选择 Obsidian Vault 的上级目录。每次都会创建新的 PMBrain-Export 快照目录，不覆盖现有笔记。</p>
        </div>
      </div>
      <label>保存到哪个目录</label>
      <div className="export-path-row">
        <input value={rootPath} onChange={event => setRootPath(event.target.value)} placeholder="D:\\Obsidian\\Vault" />
        <button className="pm-primary" onClick={() => void startExport()} disabled={!rootPath.trim() || run?.status === 'running'}>导出快照</button>
      </div>
      <p className="pm-hint">当前能力是安全的全库快照，不是双向同步；多 Source 同名冲突、增量覆盖和删除同步不会在这里偷偷处理。</p>
      {outputDir && <div className="export-output"><span>输出目录</span><code>{outputDir}</code></div>}
      {error && <div className="pm-error-text">{error}</div>}
      {run && <RunOutput run={run} />}
    </div>
  );
}

export function SettingsPage({
  themeMode,
  onNavigate,
}: {
  themeMode: ThemeMode;
  onNavigate?: (page: string) => void;
}) {
  const { overview, error, reload } = useOverview();
  if (error) return <div className="pm-card pm-error">{error}</div>;
  if (!overview) return <LoadingBlock />;
  const advancedModelEntries = Object.entries(overview.config)
    .filter(([key]) => key.startsWith('models.') || ['chat_model', 'embedding_model', 'embedding_dimensions', 'expansion_model'].includes(key));

  return (
    <div className="pm-page settings-page">
      <div className="settings-heading">
        <div><div className="pm-eyebrow">APPEARANCE · SOURCES · MODELS · EXPORT</div><h1>设置</h1><p>常用选择放在前面，技术细节按需展开。</p></div>
      </div>

      <section className="pm-card appearance-settings">
        <div><h2>界面外观</h2><p>由 PMBrain 桌面端统一设置；选择“跟随系统”时，以浏览器和电脑当前主题为准。</p></div>
        <div className="theme-choice" role="radiogroup" aria-label="界面主题">
          {([['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']] as const).map(([value, label]) => (
            <button key={value} className={themeMode === value ? 'active' : ''} disabled title="请在 PMBrain 桌面端修改界面主题">{label}</button>
          ))}
        </div>
      </section>

      <MainSourceSettings overview={overview} onSaved={reload} />
      <SourceManagementSettings />
      <MarkdownExportSettings />

      <section className="pm-card model-snapshot-card">
        <div className="pm-section-head"><div><h2>桌面端模型配置</h2><p className="pm-hint">这里用于核对当前配置。修改模型和 API Key 请回到 PMBrain 桌面端“模型配置”。</p></div></div>
        <div className="pm-grid two-col">
          <div>
            <div className="pm-kv"><span>普通模型</span><b>{overview.chat_model ?? '未配置'}</b></div>
            <div className="pm-kv"><span>向量模型</span><b>{overview.embedding_model ?? '未配置'}</b></div>
            <div className="pm-kv"><span>向量维度</span><b>{overview.embedding_dimensions ?? '-'}</b></div>
            <div className="pm-kv"><span>搜索扩展</span><b>{overview.expansion_model ?? '-'}</b></div>
          </div>
          <div>
            {Object.entries(overview.provider_status.providers).map(([name, configured]) => (
              <div className="pm-kv" key={name}><span>{name}</span><b className={configured ? 'pm-ok' : 'pm-muted'}>{configured ? '已配置' : '未配置'}</b></div>
            ))}
          </div>
        </div>
        <details className="advanced-config-details">
          <summary>查看高级模型路由（脱敏）</summary>
          {advancedModelEntries.length > 0
            ? <pre>{JSON.stringify(Object.fromEntries(advancedModelEntries), null, 2)}</pre>
            : <div className="pm-empty compact-empty">当前没有额外的高级模型覆盖。</div>}
        </details>
      </section>

      <section className="settings-operations">
        <button onClick={() => onNavigate?.('mcp')}><b>MCP 接入</b><span>管理外部 AI 工具连接</span></button>
        <button onClick={() => onNavigate?.('jobs')}><b>任务监控</b><span>查看导入和整理任务</span></button>
        <button onClick={() => onNavigate?.('diagnostics')}><b>系统诊断</b><span>检查数据库和模型状态</span></button>
      </section>
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
