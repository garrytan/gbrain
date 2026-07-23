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
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  Activity, AlertTriangle, Bot, Boxes, CheckCircle2, ChevronDown, Clock3, Cpu, Database,
  Download, FileText, FolderKanban, FolderTree, History, Layers3, Link2,
  MonitorCog, Plus, RefreshCw, Search, Sparkles, Tags, Upload, type LucideIcon,
} from 'lucide-react';
import {
  Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer,
  Tooltip as ChartTooltip, XAxis, YAxis,
} from 'recharts';

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

interface RecentRequest {
  id: number;
  token_name: string;
  agent_name?: string | null;
  operation: string;
  latency_ms: number;
  status: string;
  created_at: string;
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

function formatCount(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(Number.isFinite(value) ? value : 0);
}

const OVERVIEW_CHART_COLORS = ['#7568f0', '#5f93f5', '#4fc29c', '#f1a454', '#db6d7a', '#8b84d8'];

function shortTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    : '--:--:--';
}

function shortDate(value: string | null): string {
  if (!value) return '暂无';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`
    : '暂无';
}

type OverviewIconName = 'page' | 'chunk' | 'embedding' | 'source' | 'pulse' | 'clock' | 'agent' | 'check' | 'warning' | 'database' | 'refresh' | 'link' | 'tag' | 'timeline' | 'model';

const OVERVIEW_ICONS: Record<OverviewIconName, LucideIcon> = {
  page: FileText,
  chunk: Layers3,
  embedding: Boxes,
  source: FolderKanban,
  pulse: Activity,
  clock: Clock3,
  agent: Bot,
  check: CheckCircle2,
  warning: AlertTriangle,
  database: Database,
  refresh: RefreshCw,
  link: Link2,
  tag: Tags,
  timeline: History,
  model: Cpu,
};

function OverviewIcon({ name }: { name: OverviewIconName }) {
  const Icon = OVERVIEW_ICONS[name];
  return <Icon className="overview-icon" aria-hidden="true" />;
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
    <div className="pm-card main-source-card settings-panel">
      <div className="pm-section-head settings-panel-head">
        <div className="settings-panel-title">
          <span className="settings-panel-icon"><Database /></span>
          <div>
            <h2>主知识库源</h2>
            <p className="pm-hint">主源会作为默认导入位置，也会作为 MCP 未指定 source 时的默认读取范围。</p>
          </div>
        </div>
      </div>
      <div className="main-source-current">
        <div className="main-source-current-copy">
          <span>当前主源</span>
          <strong>{sourceLabel(mainSource)}</strong>
          <code>{mainSource?.local_path ?? '未绑定本地目录'}</code>
        </div>
        <div className="main-source-purpose" aria-label="主知识库源用途">
          <span><Download />默认导入</span>
          <span><Link2 />MCP 默认读取</span>
        </div>
      </div>
      <div className="main-source-select-row">
        <label htmlFor="main-source-select">切换主源</label>
        <select id="main-source-select" value={selected} onChange={event => setSelected(event.target.value)}>
          {activeSources.map(source => (
            <option key={source.id} value={source.id}>{sourceLabel(source)}</option>
          ))}
        </select>
        <button className="pm-primary" onClick={() => void save()} disabled={saving || !selected || selected === overview.main_source_id}>
          {saving ? '保存中' : '设为主源'}
        </button>
      </div>
      {message && <div className={message.includes('已设置') ? 'pm-hint pm-ok' : 'pm-error-text'}>{message}</div>}
    </div>
  );
}

export function KnowledgeWorkbenchPage({ onNavigate }: { onNavigate?: (page: string) => void }) {
  const { overview, error, reload } = useOverview();
  const [serviceStats, setServiceStats] = useState({ connected_agents: 0, requests_today: 0, active_tokens: 0 });
  const [health, setHealth] = useState({ expiring_soon: 0, error_rate: '0%' });
  const [showAllTypes, setShowAllTypes] = useState(false);
  const [showAllSources, setShowAllSources] = useState(false);
  const [recentRequests, setRecentRequests] = useState<RecentRequest[]>([]);

  useEffect(() => {
    let active = true;
    const loadServiceSnapshot = async () => {
      try {
        const [nextStats, nextHealth] = await Promise.all([api.stats(), api.health()]);
        if (active) {
          setServiceStats(nextStats as typeof serviceStats);
          setHealth(nextHealth as typeof health);
        }
      } catch {
        // The overview data remains useful when the optional service snapshot is unavailable.
      }
      try {
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const rows: RecentRequest[] = [];
        let requestPage = 1;
        let totalPages = 1;
        while (requestPage <= totalPages && requestPage <= 20) {
          const response = await api.requests(requestPage) as { rows?: RecentRequest[]; pages?: number };
          const pageRows = Array.isArray(response.rows) ? response.rows : [];
          rows.push(...pageRows);
          totalPages = Math.max(1, Number(response.pages) || 1);
          const oldest = pageRows[pageRows.length - 1];
          if (pageRows.length === 0 || (oldest && new Date(oldest.created_at).getTime() < cutoff)) break;
          requestPage += 1;
        }
        if (active) setRecentRequests(rows.filter(row => new Date(row.created_at).getTime() >= cutoff));
      } catch {
        if (active) setRecentRequests([]);
      }
    };
    void loadServiceSnapshot();
    const timer = window.setInterval(() => void loadServiceSnapshot(), 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  if (error) return <div className="pm-card pm-error">{error}</div>;
  if (!overview) return <LoadingBlock />;

  const activeSources = overview.sources.filter(source => !source.archived);
  const sourceMax = Math.max(...activeSources.map(s => s.page_count), 1);
  const typeEntries = Object.entries(overview.stats.pages_by_type).sort((a, b) => b[1] - a[1]);
  const sourceEntries = [...activeSources].sort((a, b) => b.page_count - a.page_count);
  const coverage = Math.min(100, Math.max(0, overview.embedding_coverage || 0));
  const engineLabel = overview.engine === 'pglite' ? '本地 PGLite' : overview.engine === 'postgres' ? 'Docker / Postgres' : overview.engine;
  const typeChartEntries: Array<[string, number]> = typeEntries.length > 6
    ? [...typeEntries.slice(0, 5), ['其他', typeEntries.slice(5).reduce((sum, [, count]) => sum + count, 0)]]
    : typeEntries;
  const visibleTypeEntries = showAllTypes ? typeEntries : typeEntries.slice(0, 6);
  const visibleSourceEntries = showAllSources ? sourceEntries : sourceEntries.slice(0, 5);
  const now = new Date();
  const trendDays = Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (6 - offset));
    const next = new Date(date);
    next.setDate(next.getDate() + 1);
    return {
      label: `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`,
      count: recentRequests.filter(row => {
        const timestamp = new Date(row.created_at).getTime();
        return timestamp >= date.getTime() && timestamp < next.getTime();
      }).length,
    };
  });
  const todayRequests = trendDays[trendDays.length - 1]?.count ?? 0;
  const yesterdayRequests = trendDays[trendDays.length - 2]?.count ?? 0;
  const requestDelta = todayRequests - yesterdayRequests;
  const recentSuccesses = recentRequests.filter(row => row.status === 'success').length;
  const recentSuccessRate = recentRequests.length > 0 ? recentSuccesses / recentRequests.length * 100 : 100;
  const averageLatency = recentRequests.length > 0
    ? Math.round(recentRequests.reduce((sum, row) => sum + (Number(row.latency_ms) || 0), 0) / recentRequests.length)
    : 0;

  return (
    <div className="pm-page overview-page">
      <header className="overview-header">
        <div>
          <h1>总体概览</h1>
          <p>欢迎回来，以下是 PMBrain 知识库与系统的整体运行情况。</p>
        </div>
        <div className="overview-header-actions">
          <Tooltip.Provider delayDuration={160}>
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <button type="button" className="overview-status-pill overview-system-status"><i />系统运行正常</button>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content className="overview-status-popover" sideOffset={10} align="start">
              <div className="overview-popover-head"><span><i />系统运行正常</span><small>悬浮信息</small></div>
              <dl>
                <div><dt>数据库</dt><dd>{engineLabel}</dd></div>
                <div><dt>知识结构</dt><dd>{overview.schema_pack}</dd></div>
                <div><dt>普通模型</dt><dd>{overview.chat_model ?? '未配置'}</dd></div>
                <div><dt>向量模型</dt><dd>{overview.embedding_model ?? '未配置'}</dd></div>
                <div><dt>向量维度</dt><dd>{overview.embedding_dimensions ?? '-'}</dd></div>
                <div><dt>扩展模型</dt><dd>{overview.expansion_model ?? '未配置'}</dd></div>
                <div><dt>自然语言</dt><dd className={overview.llm_enabled ? 'pm-ok' : 'pm-warn'}>{overview.llm_enabled ? '已启用' : '未配置'}</dd></div>
              </dl>
                  <Tooltip.Arrow className="overview-tooltip-arrow" />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          </Tooltip.Provider>
          <span className="overview-meta-pill"><OverviewIcon name="database" />数据库 {engineLabel}</span>
          <span className="overview-meta-pill"><OverviewIcon name="model" />模型 {overview.chat_model ?? '未配置'}</span>
          <span className="overview-meta-pill"><OverviewIcon name="agent" />版本 v{overview.version}</span>
          <button type="button" className="overview-refresh" onClick={() => void reload()} aria-label="刷新概览" title="刷新概览"><OverviewIcon name="refresh" /></button>
        </div>
      </header>

      <section className="overview-top-grid">
        <div className="overview-stage-main">
          <div className="overview-hero">
          <div className="overview-hero-copy">
            <div className="overview-kicker">PMBRAIN OVERVIEW</div>
            <h2>你的知识库，现在是什么状态</h2>
            <p>概览只负责看：数据规模、向量覆盖、知识结构、来源、模型和 MCP 调用状态都汇总在这里。</p>
            <div className="overview-hero-facts">
              <span><OverviewIcon name="chunk" />{formatCount(overview.stats.chunk_count)} 搜索切片</span>
              <span><OverviewIcon name="link" />{formatCount(overview.stats.link_count)} 个知识关联</span>
              <span><OverviewIcon name="source" />{formatCount(overview.federated_source_count)} 个联邦数据源</span>
            </div>
          </div>
          <div className="overview-orbit" aria-hidden="true">
            <div className="overview-orbit-ring overview-orbit-ring-one" />
            <div className="overview-orbit-ring overview-orbit-ring-two" />
            <div className="overview-orbit-core" />
            <i className="overview-orbit-dot overview-orbit-dot-one" />
            <i className="overview-orbit-dot overview-orbit-dot-two" />
          </div>
        </div>

          <section className="overview-metrics-grid" aria-label="核心指标">
            <article className="overview-stat-card overview-accent-violet">
              <div className="overview-stat-icon overview-stat-icon-violet"><OverviewIcon name="page" /></div>
              <div className="overview-stat-copy"><span>知识总数</span><strong>{formatCount(overview.stats.page_count)}</strong><small>文档与知识条目</small><em>最近更新 {shortDate(overview.recent_write_at)}</em></div>
            </article>
            <article className="overview-stat-card overview-accent-blue">
              <div className="overview-stat-icon overview-stat-icon-blue"><OverviewIcon name="embedding" /></div>
              <div className="overview-stat-copy"><span>可被检索</span><strong>{pct(coverage)}</strong><small>可用于 AI 搜索</small><em className={overview.pending_embeddings > 0 ? 'is-warning' : 'is-positive'}>{overview.pending_embeddings > 0 ? `${formatCount(overview.pending_embeddings)} 待处理` : '全部完成'} <span>↑</span></em></div>
            </article>
            <article className="overview-stat-card overview-accent-green">
              <div className="overview-stat-icon overview-stat-icon-green"><OverviewIcon name="source" /></div>
              <div className="overview-stat-copy"><span>外部数据源</span><strong>{formatCount(activeSources.length)}</strong><small>{formatCount(overview.federated_source_count)} 个联邦源已连接</small><em className="is-positive">连接正常</em></div>
            </article>
            <article className="overview-stat-card overview-accent-orange">
              <div className="overview-stat-icon overview-stat-icon-orange"><OverviewIcon name="agent" /></div>
              <div className="overview-stat-copy"><span>今日 MCP 调用</span><strong>{formatCount(serviceStats.requests_today)}</strong><small>{formatCount(serviceStats.connected_agents)} 个活跃 Agent</small><em className={requestDelta >= 0 ? 'is-positive' : 'is-negative'}>较昨日 {requestDelta >= 0 ? '+' : ''}{requestDelta} <span>{requestDelta >= 0 ? '↑' : '↓'}</span></em></div>
            </article>
          </section>
        </div>

        <aside className="overview-panel overview-runtime-card">
          <div className="overview-panel-head"><div><div className="overview-section-eyebrow">SYSTEM HEALTH</div><h2>运行状态</h2></div><span className="overview-panel-note"><i />正常</span></div>
          <div className="overview-runtime-list">
            <div><span><OverviewIcon name="embedding" />向量待处理</span><b>{formatCount(overview.pending_embeddings)}</b><small>{pct(coverage)} 已完成</small></div>
            <div><span><OverviewIcon name="warning" />调用错误率</span><b className={Number.parseFloat(health.error_rate) > 0 ? 'pm-warn' : ''}>{health.error_rate}</b><small>{formatCount(serviceStats.requests_today)} 次请求</small></div>
            <div><span><OverviewIcon name="agent" />已连接 Agent</span><b>{formatCount(serviceStats.connected_agents)}</b><small>{formatCount(health.expiring_soon)} 个凭证将到期</small></div>
            <div><span><OverviewIcon name="check" />自然语言</span><b className={overview.llm_enabled ? 'pm-ok' : 'pm-warn'}>{overview.llm_enabled ? '已启用' : '未配置'}</b><small>{overview.schema_pack}</small></div>
          </div>
        </aside>
      </section>

      <section className="overview-content-grid overview-insight-grid">
        <article className={`overview-panel overview-type-panel ${showAllTypes ? 'is-expanded' : ''}`}>
          <div className="overview-panel-head"><div><div className="overview-section-eyebrow">CONTENT MAP</div><h2>内容类型分布</h2></div><button type="button" onClick={() => setShowAllTypes(value => !value)}>{showAllTypes ? '收起' : '查看全部'} <span>›</span></button></div>
          <div className="overview-donut-layout">
            <div className="overview-donut">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={typeChartEntries.map(([name, value]) => ({ name: name === '其他' ? name : pageTypeLabel(name), value }))} dataKey="value" nameKey="name" innerRadius="67%" outerRadius="91%" paddingAngle={1.4} stroke="none">
                    {typeChartEntries.map(([type], index) => <Cell key={type} fill={OVERVIEW_CHART_COLORS[index % OVERVIEW_CHART_COLORS.length]} />)}
                  </Pie>
                  <ChartTooltip formatter={(value) => formatCount(Number(value))} contentStyle={{ borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg-secondary)', fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="overview-donut-center"><strong>{formatCount(overview.stats.page_count)}</strong><span>总数</span></div>
            </div>
            <div className="overview-donut-legend">
              {typeChartEntries.map(([type, count], index) => (
                <div key={type} title={pageTypeTitle(type)}><i style={{ background: OVERVIEW_CHART_COLORS[index % OVERVIEW_CHART_COLORS.length] }} /><span>{type === '其他' ? type : pageTypeLabel(type)}</span><b>{formatCount(count)}</b><small>{pct(count / Math.max(overview.stats.page_count, 1) * 100)}</small></div>
              ))}
            </div>
          </div>
          {showAllTypes && <div className="overview-expanded-list">{visibleTypeEntries.map(([type, count]) => <div key={type} title={pageTypeTitle(type)}><span>{pageTypeLabel(type)}</span><b>{formatCount(count)}</b></div>)}</div>}
          <button type="button" className="overview-panel-link" onClick={() => onNavigate?.('data')}>浏览知识库 <span>→</span></button>
        </article>

        <article className={`overview-panel overview-source-panel ${showAllSources ? 'is-expanded' : ''}`}>
          <div className="overview-panel-head"><div><div className="overview-section-eyebrow">SOURCE MAP</div><h2>数据源分布</h2></div><button type="button" onClick={() => setShowAllSources(value => !value)}>{showAllSources ? '收起' : '查看全部'} <span>›</span></button></div>
          <div className="overview-bars">
            {sourceEntries.length === 0 && <div className="overview-empty">暂无数据源</div>}
            {visibleSourceEntries.map((source, index) => (
              <div className="overview-source-row" key={source.id} title={source.id}>
                <span className="overview-source-glyph" style={{ '--source-color': OVERVIEW_CHART_COLORS[index % OVERVIEW_CHART_COLORS.length] } as React.CSSProperties}><OverviewIcon name="database" /></span>
                <div className="overview-source-name"><span>{source.name || source.id}</span><small>{source.id} · {source.federated ? '联邦' : '独立'}</small></div>
                <div className="overview-source-track"><i style={{ width: `${Math.max(3, source.page_count / sourceMax * 100)}%`, background: OVERVIEW_CHART_COLORS[index % OVERVIEW_CHART_COLORS.length] }} /></div>
                <b>{formatCount(source.page_count)}</b>
              </div>
            ))}
          </div>
          <button type="button" className="overview-panel-link" onClick={() => onNavigate?.('import')}>管理数据源 <span>→</span></button>
        </article>

        <article className="overview-panel overview-activity-panel">
          <div className="overview-panel-head"><div><div className="overview-section-eyebrow">MCP ACTIVITY</div><h2>最近活动</h2></div><button type="button" onClick={() => onNavigate?.('log')}>查看全部 <span>›</span></button></div>
          <div className="overview-activity-list">
            {recentRequests.length === 0 ? <div className="overview-empty">暂无 MCP 调用记录</div> : recentRequests.slice(0, 6).map(request => (
              <div className="overview-activity-item" key={request.id}>
                <time>{shortTime(request.created_at)}</time>
                <span className={`overview-activity-badge ${request.status === 'success' ? 'is-success' : 'is-error'}`}>{request.status === 'success' ? '成功' : '错误'}</span>
                <b>{request.agent_name || request.token_name || '本地 Agent'}</b>
                <code>{request.operation}</code>
                <small>{formatCount(request.latency_ms)}ms</small>
              </div>
            ))}
          </div>
          <button type="button" className="overview-panel-link" onClick={() => onNavigate?.('log')}>查看完整日志 <span>→</span></button>
        </article>
      </section>

      <section className="overview-panel overview-trend-panel">
        <div className="overview-panel-head"><div><div className="overview-section-eyebrow">7 DAY ACTIVITY</div><h2>MCP 调用趋势（近 7 天）</h2></div><span className="overview-panel-note">基于真实请求日志</span></div>
        <div className="overview-trend-layout">
          <div className="overview-chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trendDays} margin={{ top: 8, right: 8, bottom: 0, left: -22 }}>
                <defs><linearGradient id="overviewTrendFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#7c6ff1" stopOpacity={0.3} /><stop offset="100%" stopColor="#7c6ff1" stopOpacity={0.02} /></linearGradient></defs>
                <CartesianGrid vertical={false} stroke="var(--overview-line)" strokeDasharray="3 3" />
                <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: 'var(--text-muted)', fontSize: 10 }} />
                <YAxis allowDecimals={false} axisLine={false} tickLine={false} tick={{ fill: 'var(--text-muted)', fontSize: 10 }} />
                <ChartTooltip formatter={(value) => [`${formatCount(Number(value))} 次`, 'MCP 调用']} contentStyle={{ borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg-secondary)', fontSize: 11 }} />
                <Area type="monotone" dataKey="count" stroke="#7c6ff1" strokeWidth={2.4} fill="url(#overviewTrendFill)" activeDot={{ r: 4 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="overview-trend-summary">
            <div><span>今日调用</span><strong>{formatCount(todayRequests)}</strong><small className={requestDelta >= 0 ? 'is-positive' : 'is-negative'}>较昨日 {requestDelta >= 0 ? '+' : ''}{requestDelta}</small></div>
            <div><span>7 天成功率</span><strong>{pct(recentSuccessRate)}</strong><small className="is-positive">成功 {formatCount(recentSuccesses)}</small></div>
            <div><span>平均响应</span><strong>{formatCount(averageLatency)}<i>ms</i></strong><small>最近 {formatCount(recentRequests.length)} 次调用</small></div>
            <div><span>知识关联</span><strong>{formatCount(overview.stats.link_count)}</strong><small>{formatCount(overview.stats.tag_count)} 标签 · {formatCount(overview.stats.timeline_entry_count)} 时间线</small></div>
          </div>
        </div>
      </section>
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

interface ImportEmbeddingSkip {
  bytes: number | null;
}

function getImportEmbeddingSkip(run: ConsoleRun): ImportEmbeddingSkip | null {
  const text = [run.error, run.stderr, run.stdout].filter(Boolean).join('\n');
  if (!/content-sanity soft-block:/i.test(text) || !/embedding skipped/i.test(text)) return null;
  const bytesMatch = text.match(/content-sanity soft-block:[^\n]*\((\d+) bytes\)/i);
  return { bytes: bytesMatch ? Number(bytesMatch[1]) : null };
}

function summarizeImportEmbeddingSkip(skip: ImportEmbeddingSkip): string {
  const sizeReason = skip.bytes && Number.isFinite(skip.bytes)
    ? `转换后的正文约 ${skip.bytes.toLocaleString('zh-CN')} 字节，超过当前内容安全阈值`
    : '转换后的正文超过当前内容安全阈值';
  return [
    '导入仅部分完成。',
    '- 正文已保存到知识库',
    '- 未生成切片，也未进行向量化',
    `- 原因：${sizeReason}`,
    '- 处理方法：按工作表、地区或主题拆分成多个较小文件，删除不需要的空行或列后重新导入。',
  ].join('\n');
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

  const embeddingSkip = getImportEmbeddingSkip(run);
  if (embeddingSkip) return summarizeImportEmbeddingSkip(embeddingSkip);

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

  const importEmbeddingSkip = preview?.intent === 'import_path' && run ? getImportEmbeddingSkip(run) : null;
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
              <Plus aria-hidden="true" />
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
            <span className="assistant-action-icon" aria-hidden="true"><Upload /></span>
            <span className="assistant-action-copy"><strong>导入</strong></span>
          </button>
          <button
            type="button"
            className="pm-assistant-action search-action"
            onClick={() => void startDirect('search')}
            disabled={loading || !text.trim() || inputTooLong}
          >
            <span className="assistant-action-icon" aria-hidden="true"><Search /></span>
            <span className="assistant-action-copy"><strong>搜索</strong></span>
          </button>
          <button
            type="button"
            className={`pm-assistant-action ai-action ${submitClicked ? 'pm-clicked' : ''}`}
            onClick={() => void submitAuto()}
            disabled={loading || (!text.trim() && attachments.length === 0) || inputTooLong}
          >
            <span className="assistant-action-icon" aria-hidden="true"><Sparkles /></span>
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
            <div className={`nl-summary ${importEmbeddingSkip ? 'is-partial' : ''}`}>
              <div className="nl-summary-text">
                {summary && <MarkdownArticle markdown={summary} />}
                {completenessNote && <div className="nl-completeness-note">{completenessNote}</div>}
              </div>
              <span className={`pm-pill run-pill ${importEmbeddingSkip ? 'run-partial' : `run-${run.status}`}`}>
                {searchWarning ? '检索超时' : importEmbeddingSkip ? '部分完成' : run.status === 'completed' ? '已完成' : run.status === 'failed' ? '失败' : run.status === 'running' ? '执行中' : '排队中'}
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
  const [importOptionsOpen, setImportOptionsOpen] = useState(false);
  const [sourceId, setSourceId] = useState('');
  const [includeOffice, setIncludeOffice] = useState(true);
  const [includeImages, setIncludeImages] = useState(false);
  const [autoEmbed, setAutoEmbed] = useState(true);

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
      <details
        className="pm-card import-options"
        open={importOptionsOpen}
        onToggle={event => setImportOptionsOpen(event.currentTarget.open)}
      >
        <summary>
          <span className="import-options-copy">
            <b>导入选项</b>
            <small>可选择不同数据源及文件处理方式</small>
          </span>
          <span className="import-options-current">默认写入 {overview?.main_source_id ?? '主知识库源'}</span>
          <span className="import-options-action">
            {importOptionsOpen ? '收起' : '展开'}
            <ChevronDown aria-hidden="true" />
          </span>
        </summary>
        <div className="import-option-grid">
          <label>
            <span>写入位置</span>
            <select value={sourceId} onChange={event => setSourceId(event.target.value)}>
              <option value="">主知识库源（{overview?.main_source_id ?? '自动'}）</option>
              {overview?.sources.filter(source => !source.archived && source.id !== overview.main_source_id).map(source => (
                <option key={source.id} value={source.id}>{sourceLabel(source)}</option>
              ))}
            </select>
          </label>
          <label><input type="checkbox" checked={includeOffice} onChange={event => setIncludeOffice(event.target.checked)} /> Office / PDF / Excel</label>
          <label><input type="checkbox" checked={includeImages} onChange={event => setIncludeImages(event.target.checked)} /> 图片 / 扫描件</label>
          <label><input type="checkbox" checked={autoEmbed} onChange={event => setAutoEmbed(event.target.checked)} /> 导入后向量化</label>
        </div>
      </details>
      <NaturalLanguagePanel importOptions={{ sourceId: sourceId || undefined, includeOffice, includeImages, autoEmbed, workers: 1 }} />
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
    <section className="settings-source-section settings-panel-group">
      <div className="pm-section-head settings-group-head">
        <div className="settings-panel-title">
          <span className="settings-panel-icon"><FolderTree /></span>
          <div><h2>数据源与归档</h2><p className="pm-hint">注册要持续同步的资料目录；不再使用的 Source 可归档，72 小时内恢复。</p></div>
        </div>
      </div>
      {error && <div className="pm-card pm-error">{error}</div>}
      {!overview ? <LoadingBlock /> : (
        <div className="pm-grid two-col import-layout">
          <div className="pm-card import-sources-card settings-subcard">
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
          <div className="pm-card settings-subcard">
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
    <div className="pm-page connection-center-page">
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
    <div className="pm-card markdown-export-card settings-panel">
      <div className="pm-section-head settings-panel-head">
        <div className="settings-panel-title">
          <span className="settings-panel-icon"><Download /></span>
          <div>
            <h2>导出本地 Markdown</h2>
            <p className="pm-hint">可选择 Obsidian Vault 的上级目录。每次都会创建新的 PMBrain-Export 快照目录，不覆盖现有笔记。</p>
          </div>
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

interface DreamSettingsValue {
  outputDir: string;
  dualWrite: boolean;
  defaultBrainDir: string | null;
  resolvedOutputDir: string | null;
  directoryExists?: boolean;
}

function DreamSettings() {
  const [settings, setSettings] = useState<DreamSettingsValue>({
    outputDir: 'output',
    dualWrite: true,
    defaultBrainDir: null,
    resolvedOutputDir: null,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void api.dreamSettings()
      .then(value => setSettings(value as DreamSettingsValue))
      .catch(nextError => setError(nextError instanceof Error ? nextError.message : String(nextError)))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    const outputDir = settings.outputDir.trim();
    if (!outputDir) {
      setError('请填写 Dream 输出目录');
      return;
    }
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const saved = await api.saveDreamSettings({ ...settings, outputDir }) as DreamSettingsValue;
      setSettings(current => ({ ...current, ...saved }));
      setMessage('知识整理设置已保存');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSaving(false);
    }
  };

  const saveDualWrite = async (dualWrite: boolean) => {
    const outputDir = settings.outputDir.trim();
    if (!outputDir) {
      setError('请先填写 Dream 输出目录');
      return;
    }
    const previousValue = settings.dualWrite;
    setSettings(current => ({ ...current, dualWrite }));
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const saved = await api.saveDreamSettings({ outputDir, dualWrite }) as DreamSettingsValue;
      setSettings(current => ({ ...current, ...saved }));
      setMessage(dualWrite ? '已开启本地 Markdown 写入' : '已关闭本地 Markdown 写入');
    } catch (nextError) {
      setSettings(current => ({ ...current, dualWrite: previousValue }));
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSaving(false);
    }
  };

  const outputIsAbsolute = /^[A-Za-z]:[\\/]/.test(settings.outputDir)
    || /^\\\\/.test(settings.outputDir)
    || settings.outputDir.startsWith('/');
  const separator = settings.defaultBrainDir?.includes('\\') ? '\\' : '/';
  const liveResolvedOutputDir = outputIsAbsolute
    ? settings.outputDir
    : settings.defaultBrainDir
      ? `${settings.defaultBrainDir.replace(/[\\/]+$/, '')}${separator}${settings.outputDir.replace(/^[\\/]+/, '')}`
      : null;

  return (
    <section className="pm-card dream-settings-card settings-panel">
      <div className="pm-section-head settings-panel-head">
        <div className="settings-panel-title">
          <span className="settings-panel-icon"><Sparkles /></span>
          <div>
            <h2>知识整理设置</h2>
            <p className="pm-hint">设置 Dream 生成内容的本地保存位置，以及是否同时保留 Markdown 文件。</p>
          </div>
        </div>
      </div>
      <div className="dream-settings-grid">
        <div className="dream-output-setting">
          <label htmlFor="dream-output-dir">Dream 输出目录（相对目录或完整路径）</label>
          <div className="dream-output-action-row">
            <input
              id="dream-output-dir"
              value={settings.outputDir}
              onChange={event => setSettings(current => ({ ...current, outputDir: event.target.value }))}
              placeholder="output"
              disabled={loading || saving}
            />
            <button className="pm-primary" onClick={() => void save()} disabled={loading || saving}>
              {saving ? '正在保存…' : '保存设置'}
            </button>
          </div>
          <div className="dream-output-preview">
            <span>默认 Dream 目录</span>
            <code>{settings.defaultBrainDir ?? '尚未配置本地知识库目录'}</code>
            <span>当前实际输出目录</span>
            <code>{liveResolvedOutputDir ?? '请先配置本地知识库目录，或填写带盘符的完整路径'}</code>
          </div>
          <p className="pm-hint">
            填写 <code>output</code> 不需要盘符，它会保存到上面的默认 Dream 目录中。高级设置选择其他 Source 时，会改为该 Source 的本地目录下的同名文件夹。
            保存设置时，目录不存在会自动创建；已经存在则直接复用，不会清空目录。
          </p>
        </div>
        <label className="dream-dual-write-setting" htmlFor="dream-dual-write">
          <span>
            <b>写入本地 Markdown</b>
            <small>开启后，Dream 会同时写入数据库和本地文件，相当于持续维护一套 LLM Wiki。默认开启，不建议关闭。</small>
          </span>
          <input
            id="dream-dual-write"
            type="checkbox"
            checked={settings.dualWrite}
            onChange={event => void saveDualWrite(event.target.checked)}
            disabled={loading || saving}
          />
        </label>
      </div>
      {(message || error) && <div className="settings-feedback" aria-live="polite">
        {message && <span className="pm-ok">{message}</span>}
        {error && <span className="pm-error-text">{error}</span>}
      </div>}
    </section>
  );
}

interface ImportSettingsValue {
  thresholdKb: number;
  minKb: number;
  maxKb: number;
}

function ImportVectorizationSettings() {
  const [value, setValue] = useState<ImportSettingsValue>({ thresholdKb: 500, minKb: 100, maxKb: 5000 });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void api.importSettings()
      .then(next => setValue(next as ImportSettingsValue))
      .catch(nextError => setError(nextError instanceof Error ? nextError.message : String(nextError)));
  }, []);

  const save = async () => {
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const saved = await api.saveImportSettings(value.thresholdKb) as ImportSettingsValue;
      setValue(saved);
      setMessage('切片与向量化上限已保存');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="pm-card import-vector-settings settings-panel">
      <div className="settings-panel-title">
        <span className="settings-panel-icon"><Database /></span>
        <div>
          <h2>导入切片与向量化</h2>
          <p>适用于所有文件。正文超过此上限时仍会保留，但不会切片和向量化，并会明确提示原因。</p>
        </div>
      </div>
      <div className="import-vector-setting-row">
        <label htmlFor="vectorization-threshold">最大正文大小</label>
        <input
          id="vectorization-threshold"
          type="number"
          min={value.minKb}
          max={value.maxKb}
          step={100}
          value={value.thresholdKb}
          onChange={event => setValue(current => ({ ...current, thresholdKb: Number(event.target.value) || current.minKb }))}
          disabled={saving}
        />
        <span>KB</span>
        <button className="pm-primary" onClick={() => void save()} disabled={saving || value.thresholdKb < value.minKb || value.thresholdKb > value.maxKb}>
          {saving ? '正在保存…' : '保存设置'}
        </button>
      </div>
      <p className="pm-hint">默认 500 KB，可设置 100–5000 KB。上限越大，切片和向量化耗时越长，也会增加内存、模型调用量和 API 消耗。该项不限制原文件上传大小。</p>
      {(message || error) && <div className="settings-feedback" aria-live="polite">
        {message && <span className="pm-ok">{message}</span>}
        {error && <span className="pm-error-text">{error}</span>}
      </div>}
    </section>
  );
}

export function SettingsPage({
  themeMode,
  onThemeModeChange,
}: {
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
}) {
  const { overview, error, reload } = useOverview();
  if (error) return <div className="pm-card pm-error">{error}</div>;
  if (!overview) return <LoadingBlock />;
  const advancedModelEntries = Object.entries(overview.config)
    .filter(([key]) => key.startsWith('models.') || ['chat_model', 'embedding_model', 'embedding_dimensions', 'expansion_model'].includes(key));

  return (
    <div className="pm-page settings-page">
      <header className="settings-heading">
        <div className="pm-eyebrow">SYSTEM · PREFERENCES</div>
        <h1>设置</h1>
        <p className="pm-page-intro">管理知识库默认位置、知识整理输出、本地数据源和当前模型状态。</p>
      </header>

      <div className="settings-primary-grid">
        <section className="pm-card appearance-settings settings-panel">
          <div className="settings-panel-title">
            <span className="settings-panel-icon"><MonitorCog /></span>
            <div><h2>界面外观</h2><p>仅调整当前浏览器的显示方式，不会改动 PMBrain 桌面端主题。</p></div>
          </div>
          <div className="theme-choice" role="radiogroup" aria-label="界面主题">
            {([['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={themeMode === value}
                className={themeMode === value ? 'active' : ''}
                onClick={() => onThemeModeChange(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        <MainSourceSettings overview={overview} onSaved={reload} />
      </div>
      <DreamSettings />
      <ImportVectorizationSettings />
      <SourceManagementSettings />
      <MarkdownExportSettings />

      <section className="pm-card model-snapshot-card settings-panel">
        <div className="pm-section-head settings-panel-head">
          <div className="settings-panel-title">
            <span className="settings-panel-icon"><Cpu /></span>
            <div><h2>桌面端模型配置</h2><p className="pm-hint">这里用于核对当前配置。修改模型和 API Key 请回到 PMBrain 桌面端“模型配置”。</p></div>
          </div>
        </div>
        <div className="pm-grid two-col model-snapshot-grid">
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
    <div className="pm-page system-diagnostic-page">
      <div className="pm-section-head page-command-head"><h1>系统诊断</h1></div>
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
