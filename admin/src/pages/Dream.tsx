import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, isPgliteBusyError } from '../api';
import { formatDate, pageTypeLabel, pageTypeTitle, type ConsoleRun } from '../lib/shared';
import { TaskProgressCard, taskLink } from '../product/TaskProgress';
import { useProductTasks } from '../product/TaskActivity';
import { describeRunRecovery } from '../lib/run-recovery';
import { TakeProposalsPage } from './TakeProposals';
import { CalibrationPage } from './Calibration';
import { SearchIndexRepairCard, textLooksLikeGinRepairFailure } from './search-index-repair';

interface PhaseCapability {
  id: string;
  requiresGenerativeModel: boolean;
  kind: 'local' | 'generative';
  labelZh: string;
}

interface DreamData {
  phase_catalog: string[];
  phase_capabilities?: PhaseCapability[];
  generative_enabled?: boolean;
  generative_usage?: {
    generative_enabled: boolean;
    capabilities: {
      semantic_search: boolean;
      hybrid_search: boolean;
      vectorization: boolean;
      quick_maintenance: boolean;
      ai_deep_organize: boolean;
      ai_meeting_organize: boolean;
    };
  };
  overview: {
    version: string;
    engine: string;
    schema_pack: string;
    embedding_coverage: number;
    pending_embeddings: number;
    pages_added_last_update?: number;
    pages_removed_last_update?: number;
    embedding_coverage_delta?: number | null;
    recent_write_at: string | null;
    main_source_id: string;
    stats: {
      page_count: number;
      chunk_count: number;
      embedded_count: number;
      link_count: number;
      timeline_entry_count: number;
      pages_by_type: Record<string, number>;
    };
    sources: Array<{ id: string; name: string; page_count: number; last_sync_at: string | null; archived?: boolean }>;
  } | null;
  health: {
    page_count: number;
    embed_coverage: number;
    stale_pages: number;
    orphan_pages: number;
    missing_embeddings: number;
    brain_score: number;
    dead_links: number;
    link_coverage: number;
    timeline_coverage: number;
    embed_coverage_score: number;
    link_density_score: number;
    timeline_coverage_score: number;
    no_orphans_score: number;
    no_dead_links_score: number;
  } | null;
  locks: Array<{
    id: string;
    holder_pid: number;
    holder_host: string | null;
    acquired_at: string;
    ttl_expires_at: string;
    last_refreshed_at: string | null;
    active: boolean;
  }>;
  runs: ConsoleRun[];
  proposals: Array<{ status: string; count: number }>;
  takes: {
    total: number;
    active: number;
    resolved: number;
    unresolved: number;
    embedded: number;
    avg_weight: number;
    max_weight: number;
  } | null;
  grades: {
    total: number;
    applied: number;
    avg_confidence: number;
    latest_graded_at: string | null;
  } | null;
  calibration: {
    latest: null | {
      source_id: string;
      holder: string;
      generated_at: string;
      total_resolved: number;
      brier: number | null;
      accuracy: number | null;
      partial_rate: number | null;
      grade_completion: number;
      active_bias_tags: string[];
      voice_gate_passed: boolean;
      voice_gate_attempts: number;
      model_id: string;
    };
    history: Array<{
      id: number;
      source_id: string;
      holder: string;
      generated_at: string;
      total_resolved: number;
      brier: number | null;
      accuracy: number | null;
      grade_completion: number;
    }>;
  };
  embeddings: {
    coverage: number | null;
    pending: number | null;
    by_source: Array<{ source_id: string; chunks: number; embedded: number; pending: number }>;
  };
  weights: {
    top_pages: Array<{
      source_id: string;
      slug: string;
      title: string | null;
      type: string;
      emotional_weight: number;
      updated_at: string;
    }>;
  };
  knowledge: {
    types: Array<{ type: string; count: number }>;
    ingest: { total: number; last_24h: number; latest_at: string | null } | null;
  };
  lifecycle: {
    soft_deleted_pages: number;
    purge_ready_pages: number;
    archived_sources: number;
    dead_links: number;
  } | null;
  jobs: {
    recent: Array<{
      id: number;
      name: string;
      queue: string;
      status: string;
      attempts_made: number;
      max_attempts: number;
      created_at: string;
      updated_at: string;
      error_text: string | null;
    }>;
    status: Array<{ status: string; count: number }>;
    subagent_status: Array<{ status: string; count: number }>;
    subagent_queue: { waiting: number; active: number; stalled_active: number } | null;
  };
  supervisor: {
    running: boolean;
    supervisor_pid: number | null;
    worker_running?: boolean;
    worker_pid?: number | null;
    pid_file: string;
    mode?: 'supervisor' | 'none';
    readiness_error?: string;
  };
  quality: {
    takes_quality_runs: Array<{ id: number; verdict: string; overall_score: number; cost_usd: number; created_at: string }>;
    contradiction_runs: Array<{
      run_id: string;
      ran_at: string;
      queries_evaluated: number;
      queries_with_contradiction: number;
      total_contradictions_flagged: number;
      judge_errors_total: number;
    }>;
  };
}

const PHASE_LABELS: Record<string, string> = {
  lint: '页面元数据检查：补全缺失的标题、类型、标签等',
  backlinks: '反向链接发现：从页面内容中识别并建立双向引用',
  sync: '同步外部源：拉取最新数据并更新知识库',
  extract: '实体提取：从文本中识别人物、地点、概念等',
  extract_facts: '事实提取：抽取出可验证的陈述性知识',
  extract_atoms: '原子知识提取：拆解为最小粒度的知识点',
  resolve_symbol_edges: '符号关联解析：建立知识点之间的语义连接',
  embed: '向量化嵌入：将文本转换为语义向量',
  synthesize: '综合生成：基于上下文合成新的知识内容',
  patterns: '模式识别：发现知识库中的重复模式和趋势',
  synthesize_concepts: '概念综合：将相关知识点归纳为更高层级的概念',
  recompute_emotional_weight: '重新计算情感权重：更新内容的情感重要性评分',
  consolidate: '合并去重：合并相似或重复的知识条目',
  propose_takes: '观点提案：基于知识库自动生成候选观点',
  grade_takes: '观点评分：对候选观点进行质量评估',
  calibration_profile: '校准画像：生成用户认知校准分析',
  conversation_facts_backfill: '对话事实回填：将对话中确认的事实写回知识库',
  capture_entities: '识别实体：按知识整理技能查找并创建或补充人物、公司、项目和概念',
  orphans: '孤儿页面检测：发现没有被任何页面引用的孤立页面',
  'schema-suggest': 'Schema 建议：推荐知识库结构优化方案',
  purge: '清理：删除软删除标记的页面和数据',
};

const PHASE_USER_ACTIONS: Record<string, string> = {
  lint: '检查知识页面是否完整',
  backlinks: '补全知识之间的双向引用',
  sync: '读取最近新增和更新的内容',
  synthesize: '把会话和记录整理成长期知识',
  extract: '识别内容中的人物、地点和概念',
  extract_facts: '提炼可以长期保留的事实',
  extract_atoms: '把复杂内容拆成清晰的知识点',
  resolve_symbol_edges: '连接知识点之间的关系',
  patterns: '发现多份内容中反复出现的主题',
  synthesize_concepts: '把相关知识归纳成更高层概念',
  recompute_emotional_weight: '重新判断哪些内容更值得关注',
  consolidate: '合并重复或相近的信息',
  propose_takes: '整理值得进一步确认的观点',
  grade_takes: '评估已有观点的可靠程度',
  calibration_profile: '更新 AI 对你的判断习惯的理解',
  conversation_facts_backfill: '把对话中确认的信息补回知识库',
  capture_entities: '识别值得记录的人物、公司、项目和概念',
  embed: '更新 AI 搜索和理解能力',
  orphans: '发现缺少关联的孤立知识',
  'schema-suggest': '检查知识结构是否需要优化',
  purge: '清理已经过期且可安全移除的数据',
};

const QUICK_PHASE_USER_ACTIONS: Record<string, string> = {
  lint: '检查知识',
  backlinks: '检查反向引用',
  sync: '同步内容',
  extract: '建立确定性关联',
  extract_facts: '校验事实索引',
  resolve_symbol_edges: '解析确定性关联',
  embed: '更新索引',
  orphans: '完成检查',
};

const PHASE_GROUPS = [
  { key: 'prepare', title: '同步与数据准备' },
  { key: 'synthesis', title: '知识沉淀' },
  { key: 'takes', title: '观点与校准' },
  { key: 'lifecycle', title: '索引与维护' },
] as const;

const PHASE_GROUP_BY_PHASE: Record<string, typeof PHASE_GROUPS[number]['key']> = {
  lint: 'prepare', backlinks: 'prepare', sync: 'prepare', extract: 'prepare', extract_facts: 'prepare',
  extract_atoms: 'prepare', resolve_symbol_edges: 'prepare',
  synthesize: 'synthesis', patterns: 'synthesis', synthesize_concepts: 'synthesis',
  recompute_emotional_weight: 'synthesis', consolidate: 'synthesis',
  propose_takes: 'takes', grade_takes: 'takes', calibration_profile: 'takes', conversation_facts_backfill: 'takes',
  capture_entities: 'synthesis',
  embed: 'lifecycle', orphans: 'lifecycle', 'schema-suggest': 'lifecycle', purge: 'lifecycle',
};

function phasesForGroup(catalog: string[], groupKey: string): string[] {
  return catalog.filter(phase => PHASE_GROUP_BY_PHASE[phase] === groupKey);
}

const DREAM_KNOWLEDGE_STEPS = [
  { key: 'read', title: '阅读新内容', description: '找到最近新增或变化的资料', phases: ['lint', 'backlinks', 'sync'] },
  { key: 'understand', title: '理解与提炼', description: '提取事实、人物、概念和知识点', phases: ['synthesize', 'extract', 'extract_facts', 'extract_atoms', 'capture_entities'] },
  { key: 'connect', title: '建立知识连接', description: '补全关系并发现反复出现的主题', phases: ['resolve_symbol_edges', 'patterns', 'synthesize_concepts'] },
  { key: 'remember', title: '形成长期记忆', description: '合并重复信息并沉淀重要判断', phases: ['recompute_emotional_weight', 'consolidate', 'propose_takes', 'grade_takes', 'calibration_profile', 'conversation_facts_backfill'] },
  { key: 'search', title: '更新搜索能力', description: '让最新知识可以被 AI 准确找到', phases: ['embed', 'orphans', 'schema-suggest', 'purge'] },
] as const;

const QUICK_MAINTENANCE_STEPS = [
  { key: 'check', title: '检查知识', description: '检查页面与内容规范', phases: ['lint', 'backlinks'] },
  { key: 'sync', title: '同步内容', description: '同步新增和变化内容', phases: ['sync'] },
  { key: 'connect', title: '建立关联', description: '补全确定性引用关系', phases: ['extract', 'extract_facts', 'resolve_symbol_edges'] },
  { key: 'index', title: '更新索引', description: '向量化待处理内容', phases: ['embed'] },
  { key: 'verify', title: '完成检查', description: '汇总孤立知识与异常', phases: ['orphans'] },
] as const;

type DreamRunMode = 'quick' | 'meeting' | 'cycle' | 'advanced';

function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  const normalized = value <= 1 ? value * 100 : value;
  return `${normalized.toFixed(normalized % 1 === 0 ? 0 : 1)}%`;
}

function numberValue(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '-' : String(Math.round(value * 100) / 100);
}

function countBy(rows: Array<{ status: string; count: number }>, status: string): number {
  return rows.find(row => row.status === status)?.count ?? 0;
}

function Metric({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="pm-card pm-metric dream-metric">
      <div className="pm-muted">{label}</div>
      <div className="pm-metric-value">{value}</div>
      {hint && <div className="pm-hint">{hint}</div>}
    </div>
  );
}

function useDreamData() {
  const [data, setData] = useState<DreamData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [busyRuns, setBusyRuns] = useState<ConsoleRun[]>([]);
  const pending = useRef(false);

  const load = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    try {
      setData(await api.dreamOverview());
      setError('');
      setBusy(false);
      setBusyRuns([]);
    } catch (err) {
      if (isPgliteBusyError(err)) {
        setError('');
        setBusy(true);
        try {
          const snapshot = await api.taskCenter() as { rows?: ConsoleRun[] };
          setBusyRuns(Array.isArray(snapshot.rows) ? snapshot.rows : []);
        } catch (snapshotError) {
          setError(snapshotError instanceof Error ? snapshotError.message : String(snapshotError));
        }
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      pending.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => void load(), 1500);
    return () => window.clearInterval(timer);
  }, [busy]);
  return { data, error, loading, busy, busyRuns, reload: load };
}

function DreamShell({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="pm-page dream-page">
      <div className="pm-section-head">
        <div>
          <h1>{title}</h1>
          <p className="pm-page-intro">PMBrain 会阅读、理解并连接你的资料，让知识库持续保持清晰、完整和好用。</p>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function Loading({ text = '正在读取 Dream 数据...' }: { text?: string }) {
  return <div className="pm-card pm-empty">{text}</div>;
}

function ErrorBlock({ message }: { message: string }) {
  return <div className="pm-card pm-error">{message}</div>;
}

function PhaseRail({ catalog, active }: { catalog: string[]; active?: string }) {
  return (
    <div className="dream-phase-rail">
      {PHASE_GROUPS.map(group => (
        <section key={group.key}>
          <h2>{group.title}</h2>
          <div>
            {phasesForGroup(catalog, group.key).map(phase => <span key={phase} className={phase === active ? 'active' : ''} title={PHASE_LABELS[phase]}>{phase}</span>)}
          </div>
        </section>
      ))}
    </div>
  );
}

const DREAM_LAST_RUN_KEY = 'pmbrain.dream.lastRunId';
const DREAM_RUN_MODE_KEY = 'pmbrain.dream.runMode';

interface DreamPhaseReport {
  phase: string;
  status: string;
  summary?: string;
  details?: Record<string, unknown>;
  pagesAffected?: string[];
  pagesAffectedCount?: number;
  error?: { class?: string; code?: string; message?: string; hint?: string };
}

interface DreamCycleReport {
  status: string;
  reason?: string;
  duration_ms?: number;
  phases?: DreamPhaseReport[];
  totals?: Record<string, number>;
}

function parseDreamReport(run: ConsoleRun): DreamCycleReport | null {
  if (run.result && typeof run.result === 'object' && !Array.isArray(run.result)) {
    return run.result as DreamCycleReport;
  }
  const text = run.stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as DreamCycleReport;
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1)) as DreamCycleReport;
    } catch {
      return null;
    }
  }
}

function effectiveDreamStatus(run: ConsoleRun): string {
  if (run.status !== 'completed') return run.status;
  const reportStatus = parseDreamReport(run)?.status;
  if (reportStatus === 'partial') return 'partial';
  if (reportStatus === 'failed') return 'failed';
  if (reportStatus === 'skipped') return 'skipped';
  return 'completed';
}

function isQuickMaintenanceRun(run: ConsoleRun): boolean {
  return run.kind.includes('quick')
    || run.command.some((part, index) => part === 'quick' && run.command[index - 1] === '--preset');
}

export function dreamRunModeFromRun(run: ConsoleRun): DreamRunMode {
  if (isQuickMaintenanceRun(run)) return 'quick';
  if (run.kind.includes('meeting')
    || run.command.some((part, index) => part === 'meeting' && run.command[index - 1] === '--preset')) {
    return 'meeting';
  }
  if (run.kind.includes('full')
    || run.command.some((part, index) => part === 'full' && run.command[index - 1] === '--preset')) {
    return 'cycle';
  }
  return 'advanced';
}

export function runForDreamMode(run: ConsoleRun | null, mode: DreamRunMode): ConsoleRun | null {
  return run && dreamRunModeFromRun(run) === mode ? run : null;
}

function dreamRunModeLabel(mode: DreamRunMode): string {
  return ({
    quick: '快速维护',
    cycle: 'AI 深度整理',
    meeting: 'AI 会议整理',
    advanced: '高级设置任务',
  } as const)[mode];
}

function phaseDetailNumber(report: DreamCycleReport | null, phaseName: string, key: string): number {
  const value = report?.phases?.find(phase => phase.phase === phaseName)?.details?.[key];
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function quickMaintenancePending(report: DreamCycleReport | null): {
  exceptionalFiles: number;
  pendingEmbeddings: number;
  historicalLinks: number;
  processingErrors: number;
} {
  const phases = report?.phases ?? [];
  const embed = phases.find(phase => phase.phase === 'embed')?.details ?? {};
  const explicitPending = Number(embed.pending);
  const totalChunks = Math.max(0, Number(embed.total_chunks ?? 0));
  const completedChunks = Math.max(0, Number(embed.embedded ?? 0)) + Math.max(0, Number(embed.skipped ?? 0));
  return {
    exceptionalFiles: phases.reduce((sum, phase) => sum + Math.max(0, Number(phase.details?.failedFiles ?? 0)), 0),
    pendingEmbeddings: Number.isFinite(explicitPending)
      ? Math.max(0, explicitPending)
      : Math.max(0, totalChunks - completedChunks),
    historicalLinks: Math.max(phaseDetailNumber(report, 'extract', 'mentionHistoricalRemaining'), phaseDetailNumber(report, 'extract', 'relationHistoricalRemaining')),
    processingErrors: phases.reduce((sum, phase) => sum + Math.max(0, Number(phase.details?.errors_count ?? 0)), 0),
  };
}

function quickMaintenanceIsPartial(report: DreamCycleReport | null): boolean {
  const pending = quickMaintenancePending(report);
  return report?.status === 'partial'
    || pending.exceptionalFiles > 0
    || pending.pendingEmbeddings > 0
    || pending.historicalLinks > 0
    || pending.processingErrors > 0
    || (report?.phases ?? []).some(phase => phase.status === 'warn');
}

function actualSyncPagesAdded(report: DreamCycleReport | null): number {
  const sync = report?.phases?.find(phase => phase.phase === 'sync');
  const detectedAdded = Math.max(0, Number(sync?.details?.added ?? 0));
  const hasWrittenField = Boolean(sync && (sync.pagesAffectedCount != null || Array.isArray(sync.pagesAffected)));
  const written = Math.max(0, Number(sync?.pagesAffectedCount ?? sync?.pagesAffected?.length ?? 0));
  if (hasWrittenField) return written > 0 ? Math.min(detectedAdded || written, written) : 0;
  return detectedAdded;
}

export function dreamRunDeltas(run: ConsoleRun | null): { pages: number; links: number } {
  if (!run || !run.kind.startsWith('dream_') || run.command.includes('--dry-run')) {
    return { pages: 0, links: 0 };
  }
  const report = parseDreamReport(run);
  const totals = report?.totals ?? {};
  const synthWritten = Number(report?.phases?.find(phase => phase.phase === 'synthesize')?.details?.pages_written ?? 0);
  const synthPages = Math.max(0, Number(totals.synth_pages_written ?? synthWritten));
  const syncPages = actualSyncPagesAdded(report);
  const hasHonestPageSource = Boolean(report?.phases?.some(phase => phase.phase === 'sync') || synthPages > 0);
  const pages = hasHonestPageSource
    ? syncPages + synthPages
    : Math.max(0, Number(totals.pages_added ?? 0));
  const links = Math.max(0, Number(totals.links_created ?? (
    Number(totals.backlinks_added ?? 0)
    + Number(totals.pages_extracted ?? 0)
    + Number(totals.edges_resolved ?? 0)
  )));
  return { pages, links };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asStringArray(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === 'string');
}

function firstErrorText(run: ConsoleRun, report: DreamCycleReport | null): string {
  const phaseError = report?.phases?.find(phase => phase.error)?.error;
  if (phaseError?.message) return phaseError.message;
  if (run.error) return run.error;
  const text = `${run.stderr}\n${run.stdout}`;
  const line = text.split('\n').map(item => item.trim()).find(item =>
    /error|failed|Invalid prompt|timeout|dead/i.test(item),
  );
  return line ?? '';
}

export function describeDreamRun(run: ConsoleRun): {
  headline: string;
  diagnosis: string;
  actions: string[];
  outputs: string[];
  details: string[];
  slugs: string[];
} {
  const report = parseDreamReport(run);
  if (run.product) {
    const view = run.product;
    return {
      headline: `${view.name} · ${view.stage}`,
      diagnosis: view.errorReason ?? (run.status === 'running' || run.status === 'queued' ? '任务在后台继续，离开页面不影响执行。' : '查看任务了解步骤和处理结果。'),
      actions: view.steps.filter(step => step.status === 'completed').map(step => step.label),
      outputs: view.metrics.map(metric => `${metric.label} ${metric.value}`),
      details: run.durationMs !== null ? [`耗时 ${Math.round(run.durationMs / 1000)} 秒`] : [],
      slugs: asStringArray(report?.phases?.find(phase => phase.phase === 'synthesize')?.details?.written_slugs),
    };
  }
  const isQuick = isQuickMaintenanceRun(run);
  const text = `${run.stdout}\n${run.stderr}`;
  const synth = report?.phases?.find(phase => phase.phase === 'synthesize');
  const synthDetails = synth?.details ?? {};
  const totals = report?.totals ?? {};
  const writtenSlugs = asStringArray(synthDetails.written_slugs);
  const childOutcomes = asArray(synthDetails.child_outcomes) as Array<{ status?: string; jobId?: number }>;
  const failedChildren = childOutcomes.filter(item => item.status && item.status !== 'completed').length;
  const isDryRun = run.command.includes('--dry-run') || synthDetails.dryRun === true;
  // A completed report can legitimately mention lock maintenance in phase logs.
  // Only use text matching when there is no structured report to classify.
  const locked = report?.reason === 'cycle_already_running'
    || (!report && /(?:cycle[_ ]already[_ ]running|could not acquire cycle lock)/i.test(text));
  const duration = report?.duration_ms ?? run.durationMs ?? 0;
  const phaseCount = report?.phases?.length ?? 0;
  const pagesWritten = Number(totals.synth_pages_written ?? synthDetails.pages_written ?? 0);
  const patternsWritten = Number(totals.patterns_written ?? 0);
  const pagesSynced = Number(totals.pages_synced ?? 0);
  const syncPhase = report?.phases?.find(phase => phase.phase === 'sync');
  const syncedPages = asStringArray(syncPhase?.pagesAffected);
  const pagesEmbedded = Number(totals.pages_embedded ?? 0);
  const takesWritten = Number(totals.consolidate_takes_written ?? 0);
  const transcriptsProcessed = Number(totals.transcripts_processed ?? synthDetails.transcripts_processed ?? 0);
  const transcriptsDiscovered = Number(synthDetails.transcripts_discovered ?? 0);
  const proposalPhase = report?.phases?.find(phase => phase.phase === 'propose_takes');
  const proposalDetails = proposalPhase?.details ?? {};
  const proposalPagesProcessed = Number(proposalDetails.pages_processed ?? 0);
  const proposalsInserted = Number(proposalDetails.proposals_inserted ?? 0);
  const proposalCacheHits = Number(proposalDetails.cache_hits ?? 0);
  const proposalPagesFailed = Number(proposalDetails.pages_failed ?? 0);
  const proposalRemaining = Number(proposalDetails.remaining ?? 0);
  const reportIsPartial = report?.status === 'partial' || (isQuick && quickMaintenanceIsPartial(report));

  if (run.status === 'running' || run.status === 'queued') {
    return {
      headline: isQuick ? '快速维护正在后台执行' : 'Dream 正在后台执行',
      diagnosis: isQuick
        ? '正在依次检查、同步、建立确定性关联、更新索引并检查异常；离开页面不会中断。'
        : '离开本页不会主动停止后台进程；返回后会继续读取同一个 run 的状态。需要停下时点“中止”。',
      actions: ['正在等待命令完成，已保留当前 run id。'],
      outputs: [isQuick
        ? '运行结束后这里会显示同步、关联、向量和异常检查结果。'
        : '运行结束后这里会显示产出的知识点、跳过原因和失败明细。'],
      details: [`run id: ${run.id}`, `命令: ${run.command.join(' ')}`],
      slugs: [],
    };
  }

  if (run.status === 'cancelled') {
    return {
      headline: isQuick ? '本次快速维护已中止' : '本次 Dream 已中止',
      diagnosis: isQuick
        ? '中止会结束本次快速维护；已经完成的检查和索引结果会保留，未开始的阶段不会继续。'
        : '中止会结束 Admin 启动的 Dream 子进程；已经完成的阶段会保留，未开始或未完成的阶段不会继续写入。',
      actions: report?.phases?.map(phase => (isQuick ? QUICK_PHASE_USER_ACTIONS[phase.phase] : undefined) ?? PHASE_USER_ACTIONS[phase.phase] ?? phase.summary ?? phase.phase) ?? ['进程已被用户中止。'],
      outputs: pagesWritten > 0 ? [`中止前已写入 ${pagesWritten} 个知识页。`] : ['中止前没有检测到新的知识页写入。'],
      details: [`耗时约 ${(duration / 1000).toFixed(1)} 秒`, `run id: ${run.id}`],
      slugs: writtenSlugs,
    };
  }

  if (locked) {
    return {
      headline: '本次没有执行：Dream 锁正在保护另一轮运行',
      diagnosis: 'Dream 对会写库的阶段使用单周期锁，避免同步、抽取、向量化、综合写入同时改同一批数据。通常等上一轮结束后再跑即可；如果上一轮异常退出，刷新后仍长期 locked 再处理锁。',
      actions: ['没有开始新的整理步骤。'],
      outputs: ['没有生成新的知识点，也没有写入页面。'],
      details: [`状态: ${run.status}`, `run id: ${run.id}`],
      slugs: [],
    };
  }

  const actions = report?.phases?.map(phase =>
    (isQuick ? QUICK_PHASE_USER_ACTIONS[phase.phase] : undefined)
      ?? PHASE_USER_ACTIONS[phase.phase]
      ?? phase.summary
      ?? phase.phase,
  ) ?? [];
  const details: string[] = [
    `检查阶段: ${phaseCount}`,
    `耗时约 ${(duration / 1000).toFixed(1)} 秒`,
    `run id: ${run.id}`,
  ];
  if (transcriptsDiscovered > 0) details.push(`发现 transcript: ${transcriptsDiscovered}`);
  if (transcriptsProcessed > 0 || synth) details.push(`进入综合处理: ${transcriptsProcessed}`);
  if (childOutcomes.length > 0) {
    details.push(`子任务: ${childOutcomes.length} 个，其中 ${failedChildren} 个失败/超时/取消`);
  }
  if (/MODEL_CONTEXT_TOKENS/i.test(text)) {
    details.push('模型上下文预算提示：这是预算降级提醒，不等于执行失败。');
  }
  if (/deepseek/i.test(text) || run.command.some(part => part.includes('deepseek'))) {
    details.push('DeepSeek 路径：当前配方支持 chat/tools/subagent loop；若失败通常看 API key、模型名或网关返回。');
  }

  let headline = isDryRun
    ? isQuick ? '快速维护预览已完成' : 'Dry run 已完成：只是预演，没有写入知识点'
    : isQuick ? '快速维护已完成' : 'Dream 已完成';
  let diagnosis = isDryRun
    ? isQuick
      ? '预览只检查可能受影响的内容，不会同步、建立关联或写入向量。'
      : 'dry-run 会检查影响范围和部分判定逻辑，但不会提交综合写入，所以“没有新知识点”是预期结果。'
    : isQuick
      ? '本次检查、同步、确定性关联、向量索引和异常检查已经结束。'
      : '命令已结束，需要看下面的产出和子任务结果判断是否真的沉淀成功。';
  const outputs: string[] = [];

  if (!isDryRun && pagesWritten > 0) {
    outputs.push(`生成 ${pagesWritten} 个知识页。`);
    headline = `Dream 已生成 ${pagesWritten} 个知识点/页面`;
  } else if (!isDryRun && synth) {
    if (failedChildren > 0) {
      diagnosis = '这不是操作方式问题，而是综合阶段的子任务失败、超时或被取消，导致没有可收集的 put_page 写入。';
    } else if (transcriptsProcessed === 0) {
      diagnosis = '本次没有进入可写综合：可能是没有输入、显著性过滤认为不需要处理，或处于冷却/跳过状态。';
    }
  } else if (isDryRun && synth) {
    const verdicts = asArray(synthDetails.verdicts) as Array<{ worth?: boolean }>;
    outputs.push(`预演发现 ${transcriptsDiscovered} 份输入，其中 ${verdicts.filter(v => v?.worth === true).length} 份可能需要综合。`);
  }

  if (!isDryRun && patternsWritten > 0) outputs.push(`写入或更新 ${patternsWritten} 个模式知识页。`);
  if (!isDryRun && takesWritten > 0) outputs.push(`形成 ${takesWritten} 条长期知识判断。`);
  if (!isDryRun && pagesSynced > 0) {
    outputs.push(syncedPages.length > 0
      ? `检测到 ${pagesSynced} 个待同步文件，实际写入 ${syncedPages.length} 个页面。`
      : `检测到 ${pagesSynced} 个待同步文件；本次运行记录未提供实际写入页面明细。`);
  }
  if (!isDryRun && pagesEmbedded > 0) outputs.push(`为 ${pagesEmbedded} 个内容块更新搜索索引。`);
  if (!isDryRun && proposalPhase) {
    outputs.push(
      `观点整理：处理 ${proposalPagesProcessed} 页，生成 ${proposalsInserted} 条候选观点，` +
      `跳过 ${proposalCacheHits} 页已处理内容，失败 ${proposalPagesFailed} 页，剩余 ${proposalRemaining} 页。`,
    );
  }

  const totalKnowledgeUpdates = pagesWritten + patternsWritten + takesWritten;
  if (!isDryRun && totalKnowledgeUpdates > 0 && pagesWritten === 0) {
    headline = `Dream 已完成，产生 ${totalKnowledgeUpdates} 项知识更新`;
  }

  if (reportIsPartial) {
    headline = isQuick
      ? '快速维护已部分完成'
      : totalKnowledgeUpdates > 0 || pagesSynced > 0 || pagesEmbedded > 0
        ? 'Dream 已部分完成，成果与待处理项如下'
        : 'Dream 只完成了部分检查';
    diagnosis = isQuick
      ? '已完成的维护结果会保留；异常文件、待向量化和历史待补关联会分开列出，待继续处理不等于失败。'
      : '部分阶段已成功并保留实际成果，仍有未处理内容；下方会据实显示写入数量和失败原因。';
  }

  if (run.status === 'failed') {
    headline = isQuick ? '快速维护执行异常' : 'Dream 执行失败';
    diagnosis = firstErrorText(run, report) || diagnosis;
  }

  if (textLooksLikeGinRepairFailure(text)) {
    headline = '搜索索引异常，需要重建';
    diagnosis = '搜索索引坏了，知识内容还在。请点下面的「重建搜索索引」；修好后再继续快速维护。';
  }

  if (writtenSlugs.length > 0) {
    outputs.push(`页面 slug: ${writtenSlugs.slice(0, 8).join(', ')}${writtenSlugs.length > 8 ? ' ...' : ''}`);
  }
  if (outputs.length === 0) outputs.push(isQuick ? '本次没有检测到新增或变化的内容。' : '没有检测到新的知识页写入。');

  return {
    headline,
    diagnosis,
    actions: actions.length > 0 ? actions : ['没有可展示的整理步骤；需要排查时可查看技术详情。'],
    outputs,
    details,
    slugs: writtenSlugs,
  };
}

interface DreamOutcomeMetric {
  label: string;
  value: number;
  note: string;
}

export interface DreamOutcomeSummary {
  isDryRun: boolean;
  metrics: DreamOutcomeMetric[];
  pendingMetrics: DreamOutcomeMetric[];
  knowledgeItems: string[];
  extractionItems: string[];
  failureItems: string[];
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : {};
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items.map(item => item.trim()).filter(Boolean))];
}

export function buildDreamOutcome(run: ConsoleRun): DreamOutcomeSummary {
  const report = parseDreamReport(run);
  const phases = report?.phases ?? [];
  const totals = report?.totals ?? {};
  const phase = (name: string) => phases.find(item => item.phase === name);
  const details = (name: string) => phase(name)?.details ?? {};
  const sync = details('sync');
  const synth = details('synthesize');
  const atoms = details('extract_atoms');
  const facts = details('extract_facts');
  const concepts = details('synthesize_concepts');
  const proposals = details('propose_takes');
  const isQuick = isQuickMaintenanceRun(run);
  const isDryRun = run.command.includes('--dry-run')
    || synth.dryRun === true
    || concepts.dry_run === true;

  const added = isDryRun ? 0 : dreamRunDeltas(run).pages;
  const updated = isDryRun ? 0 : Math.max(0, Number(sync.modified ?? 0));
  const duplicateSkips = asArray(synth.duplicate_skips).length;
  const merged = isDryRun
    ? 0
    : duplicateSkips
      + Math.max(0, Number(atoms.duplicates_skipped ?? 0))
      + Math.max(0, Number(totals.phantoms_redirected ?? 0));
  const links = isDryRun ? 0 : Math.max(0, Number(totals.links_created ?? 0));
  const embedded = isDryRun ? 0 : Math.max(0, Number(details('embed').embedded ?? totals.pages_embedded ?? 0));
  const quickPending = quickMaintenancePending(report);

  const failureItems: string[] = [];
  let failureCount = 0;
  for (const current of phases) {
    const currentDetails = current.details ?? {};
    const currentLabel = (isQuick ? QUICK_PHASE_USER_ACTIONS[current.phase] : undefined)
      ?? PHASE_USER_ACTIONS[current.phase]
      ?? PHASE_LABELS[current.phase]
      ?? current.phase;
    const failedFiles = Math.max(0, Number(currentDetails.failedFiles ?? 0));
    if (failedFiles > 0) {
      failureCount += failedFiles;
      failureItems.push(`${currentLabel}：${failedFiles} 个文件未处理成功`);
    }
    const errorsCount = Math.max(0, Number(currentDetails.errors_count ?? 0));
    const alreadyCounted = current.phase === 'propose_takes'
      ? Math.max(0, Number(currentDetails.pages_failed ?? 0))
      : 0;
    const additionalErrors = Math.max(0, errorsCount - alreadyCounted);
    if (additionalErrors > 0) {
      failureCount += additionalErrors;
      failureItems.push(`${currentLabel}：${additionalErrors} 项模型或数据处理未成功`);
    }
    const pending = Math.max(0, Number(currentDetails.pending ?? 0));
    if(Array.isArray(currentDetails.unresolved_references)&&currentDetails.unresolved_references.length){
      failureCount+=currentDetails.unresolved_references.length;
      failureItems.push(`${currentLabel}：${currentDetails.unresolved_references.length} 条引用未关联成功，详见知识关系`);
    }
    for (const [key, label] of [['relation_backfill_error', '历史关系补扫'], ['by_mention_error', '正文实体关联'], ['ner_error', '关系类型判断']]) {
      if (currentDetails[key]) {
        failureCount += 1;
        failureItems.push(`${label}：${String(currentDetails[key])}`);
      }
    }
    if (!isQuick && pending > 0) {
      failureCount += pending;
      failureItems.push(`${currentLabel}：${pending} 个内容块仍待处理`);
    }
    if (
      (current.status === 'fail' || current.status === 'error')
      && failedFiles === 0
      && errorsCount === 0
      && pending === 0
    ) {
      failureCount += 1;
      failureItems.push(`${currentLabel}：${current.error?.message ?? current.summary ?? '执行失败'}`);
    }
  }
  const failedProposalPages = Math.max(0, Number(proposals.pages_failed ?? 0));
  if (failedProposalPages > 0) {
    failureCount += failedProposalPages;
    failureItems.push(`观点提炼：${failedProposalPages} 个页面未处理成功`);
  }
  const childOutcomes = asArray(synth.child_outcomes).map(recordOf);
  const failedChildren = childOutcomes.filter(item =>
    typeof item.status === 'string' && item.status !== 'completed',
  );
  if (failedChildren.length > 0) {
    failureCount += failedChildren.length;
    failureItems.push(`知识综合：${failedChildren.length} 个子任务失败、超时或取消`);
  }
  const conceptFailures = asArray(concepts.failures).map(recordOf);
  if (conceptFailures.length > 0) {
    failureCount += conceptFailures.length;
    failureItems.push(...conceptFailures.slice(0, 8).map(item =>
      `概念 ${String(item.concept ?? '未知')}：${String(item.error ?? '模型生成失败，已使用模板')}`,
    ));
  }

  const writtenSlugs = asStringArray(synth.written_slugs);
  const syncedSlugs = asStringArray(phase('sync')?.pagesAffected);
  const conceptSlugs = asStringArray(concepts.concept_slugs);
  const knowledgeItems = uniqueStrings([...writtenSlugs, ...syncedSlugs, ...conceptSlugs])
    .slice(0, 100);

  const factsInserted = Math.max(0, Number(facts.factsInserted ?? 0));
  const factSlugs = asStringArray(facts.affected_slugs);
  const conceptsWritten = Math.max(0, Number(concepts.concepts_written ?? 0));
  const proposalsInserted = Math.max(0, Number(proposals.proposals_inserted ?? 0));
  const proposalSamples = asArray(proposals.proposal_samples).map(recordOf);
  const extractionItems: string[] = [];
  const takesWritten=Math.max(0,Number(totals.consolidate_takes_written??0));
  if(takesWritten>0)extractionItems.push(`长期判断：形成 ${takesWritten} 条，合并 ${Number(totals.facts_consolidated??0)} 条事实。`);
  if (factsInserted > 0) {
    extractionItems.push(
      factSlugs.length > 0
        ? `事实：写入 ${factsInserted} 条，来自 ${factSlugs.slice(0, 12).join('、')}${factSlugs.length > 12 ? ' 等页面' : ''}`
        : `事实：写入 ${factsInserted} 条；这次运行记录未保留来源页面明细`,
    );
  }
  if (conceptsWritten > 0) {
    extractionItems.push(
      conceptSlugs.length > 0
        ? `概念：形成 ${conceptsWritten} 个，包括 ${conceptSlugs.slice(0, 12).join('、')}${conceptSlugs.length > 12 ? ' 等' : ''}`
        : `概念：形成 ${conceptsWritten} 个；这次运行记录未保留名称明细`,
    );
  }
  if (proposalsInserted > 0) {
    if (proposalSamples.length > 0) {
      extractionItems.push(...proposalSamples.slice(0, 20).map(item =>
        `观点：${String(item.claim_text ?? '').trim()}（来自 ${String(item.page_slug ?? '未知页面')}）`,
      ));
    } else {
      extractionItems.push(`观点：形成 ${proposalsInserted} 条候选观点；这次运行记录未保留内容明细`);
    }
  }

  return {
    isDryRun,
    metrics: isQuick
      ? [
          { label: '新增知识', value: added, note: isDryRun ? '预览不写入' : '同步新增页面' },
          { label: '更新知识', value: updated, note: isDryRun ? '预览不写入' : '同步更新页面' },
          { label: '新增关联', value: links, note: isDryRun ? '预览不写入' : '确定性关系' },
          { label: '完成向量', value: embedded, note: isDryRun ? '预览不写入' : '新完成内容块' },
        ]
      : [
          { label: '新增知识', value: added, note: isDryRun ? '预览不写入' : '新页面与综合知识' },
          { label: '更新知识', value: updated, note: isDryRun ? '预览不写入' : '已有页面更新' },
          { label: '合并与去重', value: merged, note: isDryRun ? '预览不写入' : '重复内容与重定向' },
          { label: '新增关联', value: links, note: isDryRun ? '预览不写入' : '链接和关系边' },
          { label: '未处理成功', value: failureCount, note: failureCount > 0 ? '可在下方查看原因' : '本次无失败项' },
        ],
    pendingMetrics: isQuick
      ? [
          { label: '异常文件', value: quickPending.exceptionalFiles, note: quickPending.exceptionalFiles > 0 ? '需要检查解析原因' : '本次无异常文件' },
          { label: '待向量化', value: quickPending.pendingEmbeddings, note: '待继续处理，不是失败' },
          { label: '历史待补关联', value: quickPending.historicalLinks, note: '下次从检查点继续' },
        ]
      : [],
    knowledgeItems,
    extractionItems,
    failureItems: uniqueStrings(failureItems),
  };
}

export function DreamRunContent({run,expanded=false}:{run:ConsoleRun;expanded?:boolean}){
  const outcome=buildDreamOutcome(run);
  const summary=describeDreamRun(run);
  const isQuick=isQuickMaintenanceRun(run);
  const phases=parseDreamReport(run)?.phases??[];
  const proposals=phases.find(phase=>phase.phase==='propose_takes')?.details??{};
  const relations=phases.find(phase=>phase.phase==='extract')?.details??{};
  const unresolved=phases.flatMap(phase=>Array.isArray(phase.details?.unresolved_references)?phase.details.unresolved_references.map(recordOf):[]);
  const reasons:Record<string,string>={not_configured:'未配置该阶段需要的资料目录',not_in_active_pack:'当前知识类型未启用该阶段',insufficient_evidence:'资料数量不足，未满足执行条件'};
  return <details className="dream-outcome-content" open={expanded}>
    <summary>查看本次整理内容</summary>
    {typeof proposals.model_id==='string'&&<p className="pm-hint">观点提炼模型：{proposals.model_id} · 成功处理 {Number(proposals.pages_processed??0)} 页 · 剩余 {Number(proposals.remaining??0)} 页</p>}
    <div className="dream-outcome-content-grid">
      <section><h3>新增与更新的知识</h3>{outcome.knowledgeItems.length>0
        ?<ul>{outcome.knowledgeItems.map(item=><li key={item}><code>{item}</code></li>)}</ul>
        :<p>本次没有记录到新增或更新的知识页面。</p>}</section>
      {!isQuick&&<section><h3>事实、概念和观点</h3>
        {Number(proposals.proposals_inserted)>0&&<p>本次生成 {Number(proposals.proposals_inserted)} 条候选观点，待确认。以下展示运行记录保留的内容。</p>}
        {outcome.extractionItems.length>0?<ul>{outcome.extractionItems.map((item,index)=><li key={`${item}:${index}`}>{item}</li>)}</ul>
          :<p>本次没有提取出新的事实、概念或观点。</p>}
      </section>}
      <section><h3>知识关系</h3>
        <p>{phases.find(phase=>phase.phase==='extract') ? phaseSummaryZh(phases.find(phase=>phase.phase==='extract')!) : '本次运行没有关系处理记录。'}</p>
        {relations.postGenerationRelations===true&&<p>实体和概念生成后，已再次补扫历史关系。</p>}
        {relations.nerPackUnavailable===true&&<p>存在未提供关系规则的知识类型，已跳过对应的关系类型判断。</p>}
        {phases.some(phase=>phase.phase==='orphans')&&<p>孤立页检查统计尚未被其他知识引用的页面；这些页面可能已有向外的链接。</p>}
        {unresolved.length>0&&<details><summary>{unresolved.length} 条引用未关联成功</summary><ul>{unresolved.map((reference,index)=><li key={index}>
          <p>Source：<code>{String(reference.sourceId??'未记录')}</code> · 来源：<code>{String(reference.sourcePage??'未记录')}</code></p>
          <p>目标名称或路径：<code>{String(reference.target??'未记录')}</code> · 字段：{String(reference.field??'未记录')}</p>
          <p>原因：{String(reference.reason??'未记录')}</p>
        </li>)}</ul></details>}
      </section>
      <section className={outcome.failureItems.length>0?'has-warning':''}><h3>{isQuick?'需要检查的异常':'未处理成功的内容'}</h3>
        {outcome.failureItems.length>0?<ul>{outcome.failureItems.map((item,index)=><li key={`${item}:${index}`}>{item}</li>)}</ul>
          :<p>{isQuick?'本次没有记录到执行异常。':'没有未处理成功的内容。'}</p>}
        {Array.isArray(proposals.warnings)&&proposals.warnings.length>0&&<ul>{proposals.warnings.map((item,index)=><li key={index}>{String(item)}</li>)}</ul>}
      </section>
      <section><h3>本次执行了什么</h3><ul>{summary.actions.slice(0,12).map((item,index)=><li key={index}>{item}</li>)}</ul></section>
      {phases.some(phase=>phase.status==='skipped')&&<section><h3>未执行的步骤</h3><ul>{phases.filter(phase=>phase.status==='skipped').map(phase=><li key={phase.phase}>{PHASE_LABELS[phase.phase]??phase.phase}：{reasons[String(phase.details?.reason)]??phase.summary}</li>)}</ul></section>}
    </div>
  </details>;
}

function DreamRunResult({ run }: { run: ConsoleRun }) {
  const summary = describeDreamRun(run);
  const outcome = buildDreamOutcome(run);
  const isQuick = isQuickMaintenanceRun(run);
  const displayStatus = isQuick && quickMaintenanceIsPartial(parseDreamReport(run))
    ? 'partial'
    : effectiveDreamStatus(run);
  const statusLabel = ({
    completed: '已完成',
    partial: '部分完成',
    running: '整理中',
    queued: '等待中',
    failed: '未完成',
    skipped: '未执行',
    cancelled: '已中止',
  } as Record<string, string>)[displayStatus] ?? displayStatus;
  return (
    <section className={`dream-run-narrative dream-outcome ${isQuick ? 'is-quick' : ''}`}>
      <div className="dream-run-headline">
        <div>
          <span className="dream-eyebrow">本次成果</span>
          <b>{summary.headline}</b>
        </div>
        <span className={`run-${displayStatus}`}>{statusLabel}</span>
      </div>
      <p>{summary.diagnosis}</p>
      {textLooksLikeGinRepairFailure(`${run.stdout}\n${run.stderr}\n${run.error ?? ''}`) && (
        <SearchIndexRepairCard forceShow />
      )}
      <div className="dream-outcome-metrics">
        {outcome.metrics.map(metric => (
          <div key={metric.label} className={metric.label === '未处理成功' && metric.value > 0 ? 'has-warning' : ''}>
            <b>{metric.value}</b>
            <span>{metric.label}</span>
            <small>{metric.note}</small>
          </div>
        ))}
      </div>
      {isQuick && (
        <section className="dream-pending-work" aria-label="仍需处理">
          <div className="dream-pending-head">
            <div>
              <span className="dream-eyebrow">仍需处理</span>
              <b>待继续处理不等于失败</b>
            </div>
            <small>快速维护会在后续运行中继续补齐</small>
          </div>
          <div className="dream-pending-metrics">
            {outcome.pendingMetrics.map(metric => (
              <div key={metric.label} className={metric.label === '异常文件' && metric.value > 0 ? 'has-error' : ''}>
                <span>{metric.label}</span>
                <b>{metric.value}</b>
                <small>{metric.note}</small>
              </div>
            ))}
          </div>
        </section>
      )}
      <div className="dream-detail-chips">
        {summary.details.map((item, index) => <span key={index}>{item}</span>)}
      </div>
      <DreamRunContent run={run} />
      <button type="button" className="pm-ghost" onClick={() => taskLink(run)}>查看任务</button>
    </section>
  );
}

type JourneyState = 'idle' | 'active' | 'done' | 'warning';
export type QuickMaintenanceStageState = 'idle' | 'active' | 'done' | 'partial' | 'error';

export interface QuickMaintenanceStage {
  key: string;
  title: string;
  description: string;
  state: QuickMaintenanceStageState;
  results: Array<{ label: string; value: number | string }>;
}

const QUICK_STAGE_STATUS: Record<QuickMaintenanceStageState, string> = {
  idle: '未开始',
  active: '进行中',
  done: '已完成',
  partial: '部分完成',
  error: '异常',
};

function commandFlagValue(command: string[], flag: string): string | null {
  const index = command.indexOf(flag);
  return index >= 0 ? command[index + 1] ?? null : null;
}

function plannedFirstDreamPhase(run: ConsoleRun): string {
  const singlePhase = commandFlagValue(run.command, '--phase');
  if (singlePhase) return singlePhase;
  return commandFlagValue(run.command, '--preset') === 'meeting' ? 'synthesize' : 'lint';
}

function rootCyclePhaseName(value: string): string | null {
  if (!value.startsWith('cycle.')) return null;
  return value.slice('cycle.'.length).split('.')[0] || null;
}

interface PhaseProgressFromRun {
  completed: Set<string>;
  active: string | null;
  report: DreamCycleReport | null;
  currentSource: string | null;
  completedSources: number;
  sourceIndex: number | null;
  sourceTotal: number | null;
}

function phaseProgressFromRun(run: ConsoleRun | null): PhaseProgressFromRun {
  if (!run) {
    return {
      completed: new Set(),
      active: null,
      report: null,
      currentSource: null,
      completedSources: 0,
      sourceIndex: null,
      sourceTotal: null,
    };
  }
  const report = parseDreamReport(run);
  const completed = new Set(
    (report?.phases ?? [])
      .filter(phase => phase.status === 'ok' || phase.status === 'skipped' || phase.status === 'warn')
      .map(phase => phase.phase),
  );
  let active: string | null = null;
  let currentSource: string | null = null;
  let sourceIndex: number | null = null;
  let sourceTotal: number | null = null;
  const completedSourceIds = new Set<string>();
  const running = run.status === 'running' || run.status === 'queued';
  const markStart = (phase: string) => {
    completed.delete(phase);
    active = phase;
  };
  const markFinish = (phase: string) => {
    completed.add(phase);
    if (active === phase) active = null;
  };

  const text = `${run.stdout}\n${run.stderr}`;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('{')) {
      try {
        const event = JSON.parse(line) as { event?: unknown; phase?: unknown };
        if (event && typeof event.phase === 'string') {
          const phase = rootCyclePhaseName(event.phase);
          if (phase && event.phase === `cycle.${phase}`) {
            if (event.event === 'start') markStart(phase);
            else if (event.event === 'finish' || event.event === 'abort') markFinish(phase);
          }
        }
      } catch {
        // Mixed human diagnostics and JSON progress are expected on stderr.
      }
      continue;
    }
    const human = line.match(/^\[cycle\.([a-z0-9_-]+)]\s+(start|done)\b/i);
    if (human) {
      if (human[2]!.toLowerCase() === 'start') markStart(human[1]!);
      else markFinish(human[1]!);
      continue;
    }
    const sourceStart = line.match(/^\[quick-maintenance]\s+Source\s+(\S+)\s+start(?:\s+\((\d+)\/(\d+)\))?\s*$/i);
    if (sourceStart) {
      currentSource = sourceStart[1]!;
      sourceIndex = sourceStart[2] ? Number(sourceStart[2]) : null;
      sourceTotal = sourceStart[3] ? Number(sourceStart[3]) : null;
      // --all-sources runs a complete ordered cycle per Source. Do not carry
      // the previous Source's checkmarks into the next Source's five steps.
      if (running) completed.clear();
      active = null;
      markStart('lint');
      continue;
    }
    const sourceFinish = line.match(/^\[quick-maintenance]\s+Source\s+(\S+)\s+(?:ok|clean|partial|failed|skipped)\b/i);
    if (sourceFinish) {
      completedSourceIds.add(sourceFinish[1]!);
    }
  }

  if (running && !active && completed.size === 0 && !(report?.phases?.length)) {
    active = plannedFirstDreamPhase(run);
  }
  if (!running) active = null;
  return {
    completed,
    active,
    report,
    currentSource,
    completedSources: completedSourceIds.size,
    sourceIndex,
    sourceTotal,
  };
}

export function quickMaintenanceRunSource(run: ConsoleRun | null): {
  id: string;
  completed: number;
  index?: number;
  total?: number;
} | null {
  const progress = phaseProgressFromRun(run);
  if (!progress.currentSource) return null;
  return {
    id: progress.currentSource,
    completed: progress.completedSources,
    ...(progress.sourceIndex !== null ? { index: progress.sourceIndex } : {}),
    ...(progress.sourceTotal !== null ? { total: progress.sourceTotal } : {}),
  };
}

export function isKnowledgeJourneyComplete(run: ConsoleRun | null): boolean {
  if (!run || run.status !== 'completed' || run.command.includes('--dry-run')) return false;
  const report = parseDreamReport(run);
  const embedStatus = report?.phases?.find(phase => phase.phase === 'embed')?.status;
  return !!report
    && (report.status === 'ok' || report.status === 'clean')
    && !report.reason
    && (embedStatus === 'ok' || embedStatus === 'skipped')
    && Number(report.phases?.find(phase => phase.phase === 'embed')?.details?.pending ?? 0) === 0
    && (report.phases?.length ?? 0) > 1;
}

function quickStageState(
  progress: PhaseProgressFromRun | null,
  phases: readonly string[],
  partialWhen: boolean,
): QuickMaintenanceStageState {
  if (!progress) return 'idle';
  const reports = phases
    .map(phase => progress.report?.phases?.find(item => item.phase === phase))
    .filter((phase): phase is DreamPhaseReport => !!phase);
  if (reports.some(phase => phase.status === 'fail' || phase.status === 'error')) return 'error';
  if (progress.active && phases.includes(progress.active)) return 'active';
  if (phases.every(phase => progress.completed.has(phase))) {
    return partialWhen ? 'partial' : 'done';
  }
  return 'idle';
}

export function buildQuickMaintenanceStages(run: ConsoleRun | null): QuickMaintenanceStage[] {
  const report = run ? parseDreamReport(run) : null;
  const progress = run ? phaseProgressFromRun(run) : null;
  const phase = (name: string) => report?.phases?.find(item => item.phase === name);
  const details = (name: string) => phase(name)?.details ?? {};
  const number = (value: unknown) => {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  };
  const lint = details('lint');
  const backlinks = details('backlinks');
  const sync = details('sync');
  const extract = details('extract');
  const embed = details('embed');
  const orphans = details('orphans');
  const pending = quickMaintenancePending(report);
  const totals = report?.totals ?? {};
  const syncReport = phase('sync');
  const syncAffected = syncReport?.pagesAffectedCount
    ?? syncReport?.pagesAffected?.length
    ?? Math.max(0, number(sync.added) + number(sync.modified) - number(sync.failedFiles));
  const historicalScanned = 'mentionHistoricalPagesProcessed' in extract
    ? number(extract.mentionHistoricalPagesProcessed)
    : Math.max(0, number(extract.mentionPagesProcessed) - syncAffected);
  const overallStatus = !run
    ? '未开始'
    : run.status === 'running' || run.status === 'queued'
      ? '进行中'
      : run.status === 'failed' || report?.status === 'failed'
        ? '异常'
        : quickMaintenanceIsPartial(report)
          ? '部分完成'
          : '已完成';

  const stages: QuickMaintenanceStage[] = [
    {
      ...QUICK_MAINTENANCE_STEPS[0],
      state: quickStageState(progress, QUICK_MAINTENANCE_STEPS[0].phases, false),
      results: [
        { label: '扫描页面', value: number(lint.pages_scanned) },
        { label: '发现问题', value: number(lint.issues) + number(backlinks.gaps) },
        { label: '自动修复', value: number(lint.fixed) },
      ],
    },
    {
      ...QUICK_MAINTENANCE_STEPS[1],
      state: quickStageState(progress, QUICK_MAINTENANCE_STEPS[1].phases, number(sync.failedFiles) > 0),
      results: [
        { label: '新增内容', value: actualSyncPagesAdded(report) },
        { label: '更新内容', value: number(sync.modified) },
        { label: '异常文件', value: pending.exceptionalFiles },
      ],
    },
    {
      ...QUICK_MAINTENANCE_STEPS[2],
      state: quickStageState(progress, QUICK_MAINTENANCE_STEPS[2].phases, false),
      results: [
        { label: '新增关联', value: number(totals.links_created) },
        { label: '扫描历史页面', value: historicalScanned },
        { label: '历史待补关联', value: pending.historicalLinks },
      ],
    },
    {
      ...QUICK_MAINTENANCE_STEPS[3],
      state: quickStageState(progress, QUICK_MAINTENANCE_STEPS[3].phases, pending.pendingEmbeddings > 0),
      results: [
        { label: '本次完成向量', value: number(embed.embedded ?? totals.pages_embedded) },
        { label: '待向量化', value: pending.pendingEmbeddings },
      ],
    },
    {
      ...QUICK_MAINTENANCE_STEPS[4],
      state: quickStageState(progress, QUICK_MAINTENANCE_STEPS[4].phases, false),
      results: [
        { label: '孤立知识', value: number(orphans.total_orphans) },
        { label: '整体状态', value: overallStatus },
      ],
    },
  ];
  const activeIndex = stages.findIndex(stage => stage.state === 'active');
  return stages.map((stage, index) => (
    activeIndex > index && stage.state === 'idle'
      ? { ...stage, state: 'done' }
      : stage
  ));
}

function QuickMaintenanceJourney({ run }: { run: ConsoleRun | null }) {
  const stages = useMemo(() => buildQuickMaintenanceStages(run), [run]);
  const source = useMemo(() => quickMaintenanceRunSource(run), [run]);
  const suggestedKey = stages.find(stage => stage.state === 'active')?.key
    ?? (run && run.status !== 'running' && run.status !== 'queued' ? 'verify' : 'check');
  const [selectedKey, setSelectedKey] = useState(suggestedKey);
  useEffect(() => setSelectedKey(suggestedKey), [run?.id, run?.status, suggestedKey]);
  const selected = stages.find(stage => stage.key === selectedKey) ?? stages[0]!;
  const running = run?.status === 'running' || run?.status === 'queued';

  return (
    <section className={`dream-journey quick-maintenance-journey ${running ? 'is-running' : ''}`} aria-label="快速维护进度">
      <div className="dream-journey-head">
        <div>
          <span className="dream-eyebrow">快速维护进度</span>
          <h2>{running ? '正在执行快速维护' : '快速维护会完成这五项检查'}</h2>
          {running && source && (
            <p className="pm-hint">
              当前 Source：{source.id}
              {source.index && source.total ? `（${source.index} / ${source.total}）` : `（已完成 ${source.completed} 个 Source）`}
            </p>
          )}
        </div>
        {running && <span className="dream-live"><i />后台运行中</span>}
      </div>
      <div className="dream-journey-track">
        {stages.map((stage, index) => (
          <button
            type="button"
            className={`dream-journey-step ${stage.state} ${selected.key === stage.key ? 'is-selected' : ''}`}
            key={stage.key}
            onClick={() => setSelectedKey(stage.key)}
            aria-pressed={selected.key === stage.key}
          >
            <span className="dream-step-marker" aria-hidden="true">{stage.state === 'done' ? '✓' : index + 1}</span>
            <span className="dream-step-copy">
              <b>{stage.title}</b>
              <span>{stage.description}</span>
              <small className={`dream-step-status ${stage.state}`}>{QUICK_STAGE_STATUS[stage.state]}</small>
            </span>
          </button>
        ))}
      </div>
      <div className={`quick-stage-result state-${selected.state}`} aria-live="polite">
        <div>
          <span className="dream-eyebrow">阶段结果</span>
          <b>{selected.title}</b>
          <small>{QUICK_STAGE_STATUS[selected.state]}</small>
        </div>
        <dl>
          {selected.results.map(item => (
            <div key={item.label}>
              <dt>{item.label}</dt>
              <dd>{typeof item.value === 'number' ? item.value.toLocaleString() : item.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function DreamKnowledgeJourney({ run, staged = false }: { run: ConsoleRun | null; staged?: boolean }) {
  const progress = phaseProgressFromRun(run);
  const running = run?.status === 'running' || run?.status === 'queued';
  const successfulRun = isKnowledgeJourneyComplete(run);
  return (
    <section className={`dream-journey ${running ? 'is-running' : ''}`} aria-label="知识整理进度">
      <div className="dream-journey-head">
        <div>
          <span className="dream-eyebrow">知识生长轨迹</span>
          <h2>{running
            ? staged ? 'AI 正在提炼本阶段观点' : 'AI 正在整理你的知识'
            : staged ? '深度整理按阶段推进' : '一次整理，会完成这五件事'}</h2>
          {staged && <p className="pm-hint">本次阶段结束后会停住，后续打分、向量化和孤立页检查需要分别启动。</p>}
        </div>
        {running && <span className="dream-live"><i />后台运行中</span>}
      </div>
      <div className="dream-journey-track">
        {DREAM_KNOWLEDGE_STEPS.map((step, index) => {
          const phaseStates = step.phases.map(phase => progress.report?.phases?.find(item => item.phase === phase)?.status);
          const hasWarning = phaseStates.some(status => status === 'warn' || status === 'error');
          const isActive = !!progress.active && step.phases.includes(progress.active as never);
          const isDone = step.phases.some(phase => progress.completed.has(phase));
          const state: JourneyState = successfulRun ? 'done' : hasWarning ? 'warning' : isActive ? 'active' : isDone ? 'done' : 'idle';
          return (
            <div className={`dream-journey-step ${state}`} key={step.key}>
              <div className="dream-step-marker" aria-hidden="true">{state === 'done' ? '✓' : index + 1}</div>
              <div>
                <b>{step.title}</b>
                <span>{isActive ? (PHASE_USER_ACTIONS[progress.active ?? ''] ?? step.description) : step.description}</span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function KnowledgeJourney({ run, mode }: { run: ConsoleRun | null; mode: DreamRunMode }) {
  if (mode === 'quick') {
    return <QuickMaintenanceJourney run={run && isQuickMaintenanceRun(run) ? run : null} />;
  }
  return <DreamKnowledgeJourney run={run} staged={mode === 'advanced'} />;
}

function phaseStatusZh(status: string): string {
  return ({ ok: '完成', warn: '已完成，有提醒', skipped: '已跳过', fail: '失败', error: '失败' } as Record<string, string>)[status] ?? status;
}

export function phaseSummaryZh(phase: DreamPhaseReport): string {
  const details = phase.details ?? {};
  const number = (key: string) => Number(details[key] ?? 0);
  const baseAction = PHASE_USER_ACTIONS[phase.phase] ?? PHASE_LABELS[phase.phase] ?? '完成本阶段处理';

  if (phase.status === 'skipped') {
    if (/active pack does not declare/i.test(phase.summary ?? '')) {
      return `当前启用的 Skill 包未开放“${PHASE_LABELS[phase.phase] ?? phase.phase}”，本轮已安全跳过。`;
    }
    if (phase.phase === 'synthesize' && /cooldown/i.test(phase.summary ?? '')) {
      return '近期已经整理过相同内容，本轮处于冷却期，已避免重复生成。';
    }
    return `本轮已跳过：${baseAction}`;
  }

  switch (phase.phase) {
    case 'lint':
      return `已检查内容规范，修复 ${number('fixed')} 项，仍有 ${Math.max(0, number('issues') - number('fixed'))} 项需要后续处理。`;
    case 'backlinks':
      return number('gaps') > 0
        ? `发现 ${number('gaps')} 条缺失的反向链接；本轮只检查，没有改写原文。`
        : '未发现缺失的反向链接。';
    case 'sync': {
      const candidates = number('added') + number('modified') + number('deleted');
      const failed = number('failedFiles');
      const affectedCount = phase.pagesAffectedCount ?? phase.pagesAffected?.length;
      const result = typeof affectedCount === 'number'
        ? `实际写入 ${affectedCount} 个页面`
        : '本次运行记录未提供实际写入明细';
      return `检测到 ${candidates} 个待同步文件，${result}${failed > 0 ? `，${failed} 个文件解析失败` : ''}。`;
    }
    case 'extract': {
      const remaining = Math.max(number('relationHistoricalRemaining'), number('mentionHistoricalRemaining'));
      const breakdown = details.by_mention || details.typed_ner || details.historical_relation_backfill
        ? `其中历史显式关联 ${number('relationLinksCreated')} 条、正文实体关联 ${number('mentionLinksCreated')} 条、关系类型关联 ${number('nerLinksCreated')} 条。`
        : '';
      return `已建立 ${number('linksCreated')} 条知识链接和 ${number('timelineCreated')} 条时间线记录。${breakdown}${remaining > 0 ? `历史仍有 ${remaining} 页待补扫。` : ''}`;
    }
    case 'extract_facts':
      return `已检查 ${number('pagesScanned')} 个页面，核对并写入 ${number('factsInserted')} 条事实。`;
    case 'propose_takes':
      return `已分 ${number('batches')} 批处理 ${number('pages_processed')} 页，生成 ${number('proposals_inserted')} 条候选观点，跳过 ${number('cache_hits')} 页已处理内容，失败 ${number('pages_failed')} 页，剩余 ${number('remaining')} 页。${details.stopped === 'window' ? ' 已达到本次时间上限并安全停止，没有继续进入后续阶段。' : details.stopped === 'batch_limit' ? ' 已达到本批页数上限并安全停止。' : ''}`;
    case 'resolve_symbol_edges':
      return number('chunks_walked') > 0
        ? `已检查 ${number('chunks_walked')} 个内容块，确认 ${number('edges_resolved')} 条关系，${number('edges_ambiguous')} 条仍需消歧。`
        : '当前没有需要解析的知识关系。';
    case 'embed':
      return `已为 ${number('embedded')} 个内容块更新搜索索引，${number('skipped')} 个内容块已有有效索引。`;
    case 'orphans':
      return `发现 ${number('total_orphans')} 个尚未被其他知识引用的页面，共检查 ${number('total_pages')} 个页面。`;
  }

  if (phase.status === 'warn') return `已完成但有待处理项：${baseAction}`;
  if (phase.status === 'fail' || phase.status === 'error') return `本阶段执行失败：${baseAction}。请展开原始日志查看技术原因。`;
  return `已完成：${baseAction}`;
}

function DreamTechnicalDetails({ run }: { run: ConsoleRun }) {
  const report = parseDreamReport(run);
  if (!report?.phases?.length) return null;
  return (
    <details className="dream-technical-details">
      <summary>查看阶段、模型与 Token</summary>
      <div className="dream-technical-table-wrap">
        <table className="dream-technical-table">
          <thead><tr><th>阶段</th><th>状态</th><th>模型</th><th>Token</th><th>说明</th></tr></thead>
          <tbody>
            {report.phases.map(phase => {
              const details = phase.details ?? {};
              const inputTokens = Number(details.input_tokens ?? 0);
              const outputTokens = Number(details.output_tokens ?? 0);
              const tokens = inputTokens + outputTokens;
              return (
                <tr key={phase.phase}>
                  <td><code>{phase.phase}</code></td>
                  <td><span className={`pm-pill run-${phase.status}`}>{phaseStatusZh(phase.status)}</span></td>
                  <td>{String(details.model_id ?? details.verdict_model_id ?? '—')}</td>
                  <td>{tokens > 0 ? tokens.toLocaleString() : '—'}</td>
                  <td>
                    {phaseSummaryZh(phase)}
                    {phase.phase === 'sync' && (phase.pagesAffected?.length ?? 0) > 0 && (
                      <details className="dream-sync-pages">
                        <summary>
                          查看实际写入的 {phase.pagesAffectedCount ?? phase.pagesAffected?.length ?? 0} 个页面
                          {(phase.pagesAffectedCount ?? 0) > (phase.pagesAffected?.length ?? 0) ? '（展示前 100 个）' : ''}
                        </summary>
                        <ul>{phase.pagesAffected?.map((slug, index) => <li key={`${slug}:${index}`}><code>{slug}</code></li>)}</ul>
                      </details>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function isNonTerminalJobStatus(status: string): boolean {
  return ['waiting', 'active', 'delayed', 'waiting-children', 'paused'].includes(status);
}

function isActionableJobErrorStatus(status: string): boolean {
  return isNonTerminalJobStatus(status) || status === 'failed';
}

function formatDreamJobError(errorText: string): string {
  if (/Invalid prompt|ModelMessage\[\]\s*schema|messages do not match/i.test(errorText)) {
    return '模型消息格式不兼容：历史子任务消息不能被当前模型接口识别。如果队列没有等待或运行中的子任务，这只是历史失败记录，不影响本次运行。';
  }
  if (/api key|unauthorized|forbidden|auth/i.test(errorText)) {
    return '模型鉴权失败：请检查 API Key、模型供应商和模型名称配置。';
  }
  if (/timeout|timed out/i.test(errorText)) {
    return '子任务超时：可以取消仍在等待的子任务，或调大超时时间后重试。';
  }
  return `子任务失败：${errorText}`;
}

function DreamOpsDiagnostics({
  engine,
  locks,
  jobs,
  supervisor,
  onChanged,
}: {
  engine?: string;
  locks?: DreamData['locks'];
  jobs?: DreamData['jobs'];
  supervisor?: DreamData['supervisor'];
  onChanged?: () => void;
}) {
  const isPglite = engine === 'pglite';
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const latestLock = locks?.[0] ?? null;
  const activeLock = locks?.find(lock => lock.active) ?? null;
  const lock = activeLock ?? latestLock;
  const subagent = jobs?.subagent_status ?? [];
  const queue = jobs?.subagent_queue ?? null;
  const cancellableJobs = (jobs?.recent ?? []).filter(job => isNonTerminalJobStatus(job.status)).slice(0, 5);
  const latestErrorJob = (jobs?.recent ?? []).find(job => job.error_text && isActionableJobErrorStatus(job.status));
  const waiting = countBy(subagent, 'waiting');
  const active = countBy(subagent, 'active');
  const dead = countBy(subagent, 'dead');
  const failed = countBy(subagent, 'failed');
  const hasLiveQueueProblem = waiting > 0 || active > 0 || failed > 0 || (queue?.stalled_active ?? 0) > 0;
  const latestError = latestErrorJob && hasLiveQueueProblem ? formatDreamJobError(latestErrorJob.error_text ?? '') : '';
  const stuckReason = !isPglite && !supervisor?.worker_running && waiting > 0
    ? 'Worker 未运行，subagent 只会排队等待。'
    : queue && queue.stalled_active > 0
      ? '存在锁已过期的 active 子任务，需要取消或等待 Worker 回收。'
      : lock && !lock.active
        ? 'cycle lock 已过期但仍留在表中，可以解除后重试。'
        : '';

  const runAction = async (name: string, action: () => Promise<unknown>) => {
    setBusy(name);
    setError('');
    try {
      await action();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="dream-ops-diagnostics">
      <div className="dream-ops-head">
        <div>
          <h3>运行诊断</h3>
          {stuckReason
            ? <p className="pm-warning">{stuckReason}</p>
            : isPglite
              ? <p className="pm-hint">PGLite 不启动独立 Worker；PGLite 会在当前进程内串行完成完整 Dream，包括知识综合与模式识别。</p>
              : <p className="pm-hint">一键整理和会议整理会在需要时自动启动 Worker，通常不需要手动操作。这里用于故障诊断和恢复。</p>}
        </div>
        {!isPglite && <div className="dream-run-actions">
          {supervisor?.running ? (
            <button className="pm-ghost danger" disabled={!!busy} onClick={() => void runAction('stop-supervisor', () => api.stopSupervisor())}>停止 Worker</button>
          ) : (
            <button className="pm-ghost" disabled={!!busy} onClick={() => void runAction('start-supervisor', () => api.startSupervisor())}>启动 Worker</button>
          )}
        </div>}
      </div>
      <div className="dream-ops-grid">
        <section>
          <h4>Worker</h4>
          <div className="pm-kv"><span>状态</span><b>{isPglite ? '不适用' : supervisor?.worker_running ? 'ready' : supervisor?.running ? 'starting' : 'stopped'}</b></div>
          <div className="pm-kv"><span>Supervisor PID</span><b>{supervisor?.supervisor_pid ?? '-'}</b></div>
          <div className="pm-kv"><span>Worker</span><b>{isPglite ? '不适用' : supervisor?.worker_running ? `PID ${supervisor.worker_pid}` : supervisor?.readiness_error ?? 'not ready'}</b></div>
          <div className="pm-kv"><span>模式</span><b>{isPglite ? 'pglite' : supervisor?.mode ?? '-'}</b></div>
        </section>
        <section>
          <h4>Cycle lock</h4>
          <div className="pm-kv"><span>状态</span><b>{lock ? (lock.active ? 'active' : 'expired') : 'none'}</b></div>
          <div className="pm-kv"><span>持有者</span><b>{lock ? `${lock.holder_host ?? 'host'}:${lock.holder_pid}` : '-'}</b></div>
          <div className="pm-kv"><span>最近刷新</span><b>{formatDate(lock?.last_refreshed_at ?? null, '-')}</b></div>
          {lock && (
            <button className="pm-ghost danger dream-inline-action" disabled={!!busy}
              onClick={() => void runAction('break-lock', () => api.breakDreamLock(lock.id, lock.holder_pid))}>
              解除锁
            </button>
          )}
        </section>
        <section>
          <h4>Subagent 队列</h4>
          <div className="dream-detail-chips">
            <span>waiting {queue?.waiting ?? waiting}</span>
            <span>active {queue?.active ?? active}</span>
            <span>stalled {queue?.stalled_active ?? 0}</span>
            <span>failed {failed}</span>
            <span>dead {dead}</span>
          </div>
          {latestError && <p className="dream-job-error">{latestError}</p>}
          {!latestError && dead > 0 && <p className="pm-hint">有 {dead} 个历史失败/死亡子任务记录，当前队列正常时不会影响本次运行。</p>}
        </section>
      </div>
      {cancellableJobs.length > 0 && (
        <div className="dream-cancel-list">
          {cancellableJobs.map(job => (
            <button key={job.id} className="pm-ghost danger" disabled={!!busy}
              onClick={() => void runAction(`cancel-${job.id}`, () => api.cancelJob(job.id))}>
              取消 #{job.id} {job.name} / {job.status}
            </button>
          ))}
        </div>
      )}
      {error && <div className="pm-error-text">{error}</div>}
    </div>
  );
}

function busyRunTitle(kind: string): string {
  if (kind.startsWith('dream_')) {
    if (kind.includes('quick')) return '快速维护';
    if (kind.includes('meeting')) return '会议与会话整理';
    return '知识整理';
  }
  if (kind === 'import_path') return '文件导入';
  if (kind === 'embed_stale') return '重新向量化';
  if (kind === 'sync_all') return '知识源同步';
  return kind;
}

function DreamBusyRecovery({ runs, onRefresh }: { runs: ConsoleRun[]; onRefresh: () => void }) {
  const [cancelling, setCancelling] = useState('');
  const liveRuns = runs.filter(run => run.status === 'running' || run.status === 'queued');
  const recovery = liveRuns.length === 0
    ? runs.map(describeRunRecovery).find((item): item is NonNullable<typeof item> => item !== null) ?? null
    : null;
  const heading = liveRuns.length > 0
    ? 'PGLite 正在执行后台任务'
    : recovery?.title ?? 'PGLite 连接正在恢复';
  const description = liveRuns.length > 0
    ? '本地数据库正在由后台任务独占。页面切换不会中断任务，任务完成后会自动恢复知识整理页面。'
    : recovery?.summary ?? '当前没有仍在运行的知识整理任务；桌面服务正在恢复本地数据库连接。';
  const stateLabel = liveRuns.length > 0 ? '运行中' : recovery?.badge ?? '恢复中';

  const cancel = async (run: ConsoleRun) => {
    if (!window.confirm(run.status === 'queued'
      ? '取消等待后，本次任务不会再启动。确定取消吗？'
      : '取消任务不会删除已经完成的成果，确定继续吗？')) return;
    setCancelling(run.id);
    try {
      await api.cancelRun(run.id);
      onRefresh();
    } catch {
      onRefresh();
    } finally {
      setCancelling('');
    }
  };

  return (
    <div className="dream-busy-recovery">
      <div className="dream-busy-recovery-head">
        <div>
          <span className="dream-eyebrow">{liveRuns.length > 0 ? 'DATABASE TASK IN PROGRESS' : 'DATABASE CONNECTION RECOVERY'}</span>
          <h2>{heading}</h2>
          <p>{description}</p>
        </div>
        <div className="dream-busy-pulse"><i />{stateLabel}</div>
      </div>
      <div className="dream-busy-recovery-note">
        <b>{liveRuns.length > 0 ? '你仍然可以管理当前任务' : '整理状态和数据库状态已分开显示'}</b>
        <span>{liveRuns.length > 0
          ? '如果需要中止 Dream，请在下面取消；已经完成的内容不会因为取消而自动删除。'
          : recovery?.summary ?? '刷新后可检查连接是否恢复；若持续失败，再到任务中心查看安全恢复选项。'}</span>
      </div>
      {liveRuns.length > 0 ? (
        <div className="dream-busy-run-list">
          {liveRuns.map(run => (
            <div key={run.id}>
              <div><b>{busyRunTitle(run.kind)}</b><span>{run.status === 'queued' ? '等待中' : '运行中'}</span></div>
              <small>{run.status === 'queued' ? '等待 PGLite 空闲后启动' : `任务编号 ${run.id}`}</small>
              <button type="button" className="pm-ghost danger" disabled={cancelling === run.id} onClick={() => void cancel(run)}>
                {cancelling === run.id ? '正在取消…' : run.status === 'queued' ? '取消等待' : '中止任务'}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="pm-hint">当前没有可取消的知识整理任务。这里显示的是数据库连接恢复状态，不是模型仍在运行。</div>
      )}
      <div className="dream-busy-actions">
        <button type="button" className="pm-ghost" onClick={onRefresh}>刷新任务状态</button>
        <button type="button" className="pm-primary" onClick={() => { window.location.hash = 'tasks'; }}>打开任务中心</button>
      </div>
    </div>
  );
}

const GENERATIVE_DISABLED_HINT = '普通模型当前不可用，请先检查模型配置。';

function DreamRunPanel({
  defaultPhase = 'all',
  defaultSourceId,
  compact = false,
  engine,
  phaseCatalog = [],
  phaseCapabilities = [],
  generativeEnabled = false,
  sources,
  locks,
  jobs,
  supervisor,
  onDone,
}: {
  defaultPhase?: string;
  defaultSourceId?: string;
  compact?: boolean;
  engine?: string;
  phaseCatalog?: string[];
  phaseCapabilities?: PhaseCapability[];
  generativeEnabled?: boolean;
  sources?: Array<{ id: string; name: string; page_count: number; archived?: boolean }>;
  locks?: DreamData['locks'];
  jobs?: DreamData['jobs'];
  supervisor?: DreamData['supervisor'];
  onDone?: () => void;
}) {
  const isPglite = engine === 'pglite';
  const phaseCapMap = useMemo(() => {
    const map = new Map<string, PhaseCapability>();
    for (const item of phaseCapabilities) map.set(item.id, item);
    return map;
  }, [phaseCapabilities]);
  const phaseNeedsGenerative = (id: string) => phaseCapMap.get(id)?.requiresGenerativeModel === true;
  const [phase, setPhase] = useState(defaultPhase);
  const [sourceId, setSourceId] = useState('');
  const [maxPages, setMaxPages] = useState('25');
  const [input, setInput] = useState('');
  const [date, setDate] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [dryRun, setDryRun] = useState(false);
  const [timeoutMinutes, setTimeoutMinutes] = useState('');
  const [runMode, setRunMode] = useState<DreamRunMode>(() => {
    const saved = window.localStorage.getItem(DREAM_RUN_MODE_KEY);
    if (!generativeEnabled && (saved === 'cycle' || saved === 'meeting')) return 'quick';
    return saved === 'quick' || saved === 'meeting' || saved === 'cycle' || saved === 'advanced'
      ? saved
      : defaultPhase === 'all' ? (generativeEnabled ? 'cycle' : 'quick') : 'advanced';
  });

  useEffect(() => {
    if (!generativeEnabled && (runMode === 'cycle' || runMode === 'meeting')) {
      setRunMode('quick');
      window.localStorage.setItem(DREAM_RUN_MODE_KEY, 'quick');
    }
  }, [generativeEnabled, runMode]);

  const [run, setRun] = useState<ConsoleRun | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const selectedRun = runForDreamMode(run, runMode);
  const running = selectedRun?.status === 'running' || selectedRun?.status === 'queued';
  const otherRunRunning = !!run
    && !selectedRun
    && (run.status === 'running' || run.status === 'queued');
  const busy = running || otherRunRunning || starting;

  const activeSources = useMemo(
    () => (sources ?? []).filter(s => !s.archived),
    [sources],
  );

  const showAdvancedControls = runMode === 'advanced';
  const showInputControls = runMode === 'meeting' || runMode === 'advanced';
  const inputEnabled = runMode === 'meeting' || (runMode === 'advanced' && phase === 'synthesize');
  const dateEnabled = runMode === 'advanced' && (phase === 'all' || phase === 'synthesize');
  const hasInputDateConflict = !!(inputEnabled && dateEnabled && input.trim() && (date || from || to));
  const hasDateRangeConflict = !!(dateEnabled && date && (from || to));
  const hasFromToConflict = !!(dateEnabled && from && to && from > to);
  const hasConflict = hasInputDateConflict || hasDateRangeConflict || hasFromToConflict;

  const applyRunMode = (mode: DreamRunMode) => {
    setError('');
    setRunMode(mode);
    window.localStorage.setItem(DREAM_RUN_MODE_KEY, mode);
    if (mode === 'meeting') {
      setPhase('all');
      setSourceId('');
      setDate('');
      setFrom('');
      setTo('');
      setDryRun(false);
    } else if (mode === 'cycle' || mode === 'quick') {
      setPhase('all');
      setSourceId('');
      setInput('');
      setDate('');
      setFrom('');
      setTo('');
      setDryRun(false);
    }
  };

  useEffect(() => {
    const lastRunId = window.localStorage.getItem(DREAM_LAST_RUN_KEY);
    if (!lastRunId) return;
    void api.run(lastRunId)
      .then(value => setRun(value as ConsoleRun))
      .catch(() => window.localStorage.removeItem(DREAM_LAST_RUN_KEY));
  }, []);

  useEffect(() => {
    if (!run) return;
    window.localStorage.setItem(DREAM_LAST_RUN_KEY, run.id);
  }, [run?.id]);

  useEffect(() => {
    if (!run || (run.status !== 'running' && run.status !== 'queued')) return;
    const timer = setInterval(async () => {
      try {
        const next = await api.run(run.id) as ConsoleRun;
        setRun(next);
        if (next.status !== 'running' && next.status !== 'queued') onDone?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }, 1400);
    return () => clearInterval(timer);
  }, [run?.id, run?.status, onDone]);

  const start = async (dryRunOverride?: boolean) => {
    if (busy) return;
    setError('');
    if (generativeBlocked) {
      setError(GENERATIVE_DISABLED_HINT);
      return;
    }
    if (runMode === 'meeting' && !input.trim()) {
      setError('请选择需要整理的会议记录文件或文件夹');
      return;
    }
    if (hasConflict) {
      setError('存在字段冲突，请先解决后再运行');
      return;
    }
    const timeoutMs = timeoutMinutes.trim() ? Math.floor(Number(timeoutMinutes) * 60_000) : undefined;
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      setError('超时时间必须是正数分钟');
      return;
    }
    setStarting(true);
    try {
      const effectiveDryRun = dryRunOverride ?? dryRun;
      const needsSubagentWorker = !isPglite && !effectiveDryRun && (
        runMode === 'cycle'
        || runMode === 'meeting'
        || (runMode === 'advanced' && (phase === 'synthesize' || phase === 'patterns'))
      );
      if (needsSubagentWorker && !supervisor?.worker_running) {
        await api.startSupervisor();
        onDone?.();
      }
      const res = await api.startDreamRun({
        preset: runMode === 'meeting'
          ? 'meeting'
          : runMode === 'cycle'
            ? 'full'
          : runMode === 'quick'
                ? 'quick'
                : undefined,
        phase: runMode === 'advanced' ? phase : undefined,
        sourceId: runMode === 'advanced' ? sourceId.trim() || undefined : runMode === 'quick' ? undefined : defaultSourceId,
        allSources: runMode === 'quick',
        maxPages: runMode === 'advanced' && phase === 'propose_takes' && maxPages.trim() ? Number(maxPages) : undefined,
        drainProposals: false,
        windowSeconds: undefined,
        dryRun: effectiveDryRun,
        input: inputEnabled ? input.trim() || undefined : undefined,
        date: dateEnabled ? date.trim() || undefined : undefined,
        from: dateEnabled ? from.trim() || undefined : undefined,
        to: dateEnabled ? to.trim() || undefined : undefined,
        timeoutMs,
      }) as { runId: string };
      window.localStorage.setItem(DREAM_LAST_RUN_KEY, res.runId);
      setRun(await api.run(res.runId) as ConsoleRun);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      onDone?.();
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    if (!selectedRun || !running) return;
    setError('');
    try {
      const next = await api.cancelRun(selectedRun.id) as ConsoleRun;
      setRun(next);
      onDone?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const modeCopy: Record<DreamRunMode, {
    title: string;
    description: string;
    action: string;
  }> = {
    quick: {
      title: '先做一次轻量维护',
      description: '依次检查全部已注册 Source、同步内容、建立确定性关联、更新向量索引并检查异常。不使用普通模型。',
      action: '开始快速维护',
    },
    cycle: {
      title: 'AI 深度整理知识库',
      description: '依次完成完整 Dream：读取变化、提炼与连接知识、沉淀长期记忆，并更新搜索能力。小模型会在昂贵阶段自动缩小单批页数；观点提炼仍可在“高级设置”中独立运行。',
      action: '开始 AI 深度整理',
    },
    meeting: {
      title: 'AI 会议与会话整理',
      description: '选择会议记录或会话文件夹，AI 会完成整理、提炼、连接和索引。需要普通模型。',
      action: '开始 AI 会议整理',
    },
    advanced: {
      title: '自定义本次整理',
      description: '按来源、日期或内部阶段运行，适合调试和精细维护。需要普通模型的阶段会按当前模型配置自动调用。',
      action: '运行所选流程',
    },
  };
  const generativeBlocked = !generativeEnabled && (runMode === 'cycle' || runMode === 'meeting'
    || (runMode === 'advanced' && phase !== 'all' && phaseNeedsGenerative(phase))
    || (runMode === 'advanced' && phase === 'all'));

  return (
    <div id="dream-launcher" className={`dream-launcher ${compact ? 'compact' : ''}`}>
      <div className="dream-launcher-head">
        <div>
          <span className="dream-eyebrow">开始整理</span>
          <h2>{modeCopy[runMode].title}</h2>
          <p>{modeCopy[runMode].description}</p>
        </div>
        <div className="dream-run-actions">
          <button
            className="pm-primary dream-primary-action"
            onClick={() => void start(runMode === 'advanced' ? undefined : false)}
            disabled={busy || generativeBlocked}
            title={generativeBlocked ? GENERATIVE_DISABLED_HINT : undefined}
          >
            {running
              ? '正在整理…'
              : otherRunRunning
                ? '其他整理正在后台运行'
                : starting
                  ? (isPglite ? '正在准备…' : '正在准备 Worker…')
                  : modeCopy[runMode].action}
          </button>
          {!running && runMode !== 'advanced' && (
            <button className="pm-ghost" disabled={starting || generativeBlocked} title={generativeBlocked ? GENERATIVE_DISABLED_HINT : undefined} onClick={() => void start(true)}>先预览会发生什么</button>
          )}
          {running && <button className="pm-ghost danger" onClick={() => void cancel()}>中止</button>}
        </div>
      </div>
      {otherRunRunning && run && (
        <div className="pm-hint dream-run-persist-note">
          当前后台任务属于“{dreamRunModeLabel(dreamRunModeFromRun(run))}”；本页仅显示“{dreamRunModeLabel(runMode)}”的独立进度。请切回对应模式或前往任务中心查看。
        </div>
      )}
      {generativeBlocked && <div className="pm-hint dream-generative-hint">{GENERATIVE_DISABLED_HINT}</div>}
      <div className="dream-run-mode">
        <button type="button" className={runMode === 'quick' ? 'active' : ''} onClick={() => applyRunMode('quick')}>
          <strong>快速维护</strong>
          <span>检查 · 同步 · 关联 · 向量化</span>
        </button>
        <button
          type="button"
          className={`${runMode === 'cycle' ? 'active' : ''} ${!generativeEnabled ? 'is-disabled' : ''}`}
          onClick={() => {
            if (!generativeEnabled) { setError(GENERATIVE_DISABLED_HINT); return; }
            applyRunMode('cycle');
          }}
          disabled={!generativeEnabled}
          title={!generativeEnabled ? GENERATIVE_DISABLED_HINT : undefined}
        >
          <strong>AI 深度整理</strong>
          <span>{generativeEnabled ? '完整 Dream · 最全面' : '需要普通模型'}</span>
        </button>
        <button
          type="button"
          className={`${runMode === 'meeting' ? 'active' : ''} ${!generativeEnabled ? 'is-disabled' : ''}`}
          onClick={() => {
            if (!generativeEnabled) { setError(GENERATIVE_DISABLED_HINT); return; }
            applyRunMode('meeting');
          }}
          disabled={!generativeEnabled}
          title={!generativeEnabled ? GENERATIVE_DISABLED_HINT : undefined}
        >
          <strong>AI 会议整理</strong>
          <span>{!generativeEnabled ? '需要普通模型' : '指定文件 · 专项提炼'}</span>
        </button>
        <button type="button" className={runMode === 'advanced' ? 'active' : ''} onClick={() => applyRunMode('advanced')}>
          <strong>高级设置</strong>
          <span>按 Phase 精细控制</span>
        </button>
      </div>
      <div className="dream-run-grid">
        {showAdvancedControls && (
          <label>
            <span>Phase</span>
            <select value={phase} onChange={event => {
              const newPhase = event.target.value;
              if (newPhase !== 'all' && phaseNeedsGenerative(newPhase) && !generativeEnabled) {
                setError(GENERATIVE_DISABLED_HINT);
                return;
              }
              setPhase(newPhase);
              if (newPhase === 'all') setSourceId('');
            }}>
              <option value="all" disabled={!generativeEnabled}>整轮 cycle（需要普通模型）</option>
              {phaseCatalog.map(item => {
                const needsGen = phaseNeedsGenerative(item);
                const blocked = needsGen && !generativeEnabled;
                const tag = needsGen ? '需要普通模型' : '不使用普通模型';
                return (
                  <option key={item} value={item} disabled={blocked} title={`${PHASE_LABELS[item] ?? item} · ${tag}`}>
                    {item} · {tag}
                  </option>
                );
              })}
            </select>
            {phase !== 'all' && (
              <div className="pm-hint" style={{ marginTop: 4 }}>
                {PHASE_LABELS[phase]}
                {' · '}
                {phaseNeedsGenerative(phase) ? '需要普通模型' : '本地处理 / 不使用普通模型'}
              </div>
            )}
          </label>
        )}
        {showAdvancedControls && (
          <label>
            <span>Source ID</span>
            <select value={sourceId} onChange={event => setSourceId(event.target.value)}>
              <option value="">全部 source</option>
              {activeSources.map(s => (
                <option key={s.id} value={s.id}>{s.name || s.id}（{s.page_count} 页）</option>
              ))}
            </select>
          </label>
        )}
        {showAdvancedControls && phase === 'propose_takes' && (
          <label>
            <span>提议最多处理页面</span>
            <input value={maxPages} onChange={event => setMaxPages(event.target.value)} placeholder="可选" inputMode="numeric" />
          </label>
        )}
        {showAdvancedControls && phase === 'embed' && (
          <div className="pm-hint">
            embed 会处理全部待向量分块；本地模型的实际速度取决于模型并发与页面大小。
          </div>
        )}
        {!compact && showInputControls && (
          <>
            <label className={!inputEnabled ? 'dream-input-disabled' : ''}>
              <span>{runMode === 'meeting' ? '会议记录文件或文件夹' : '输入文件'}</span>
              <input value={input} onChange={event => setInput(event.target.value)}
                placeholder={!inputEnabled ? '当前阶段不支持指定输入' : '例如 D:\\会议记录 或 C:\\Users\\你\\.codex\\sessions'}
                disabled={!inputEnabled} />
            </label>
          </>
        )}
        {!compact && showAdvancedControls && (
          <>
            <label className={phase !== 'all' && phase !== 'synthesize' ? 'dream-input-disabled' : ''}>
              <span>Date</span>
              <input type="date" value={date} onChange={event => setDate(event.target.value)}
                disabled={phase !== 'all' && phase !== 'synthesize'} />
            </label>
            <label className={phase !== 'all' && phase !== 'synthesize' ? 'dream-input-disabled' : ''}>
              <span>From</span>
              <input type="date" value={from} onChange={event => setFrom(event.target.value)}
                disabled={phase !== 'all' && phase !== 'synthesize'} />
            </label>
            <label className={phase !== 'all' && phase !== 'synthesize' ? 'dream-input-disabled' : ''}>
              <span>To</span>
              <input type="date" value={to} onChange={event => setTo(event.target.value)}
                disabled={phase !== 'all' && phase !== 'synthesize'} />
            </label>
            {hasInputDateConflict && <div className="pm-warning" style={{ gridColumn: '1 / -1', marginTop: 4 }}>⚠ Input file 与日期筛选 (Date/From/To) 互斥，不能同时使用</div>}
            {hasDateRangeConflict && <div className="pm-warning" style={{ gridColumn: '1 / -1', marginTop: 4 }}>⚠ Date 与 From/To 互斥，请只使用其中一种筛选方式</div>}
            {hasFromToConflict && <div className="pm-warning" style={{ gridColumn: '1 / -1', marginTop: 4 }}>⚠ From 不能晚于 To</div>}
          </>
        )}
        {showAdvancedControls && (
          <label>
            <span>超时时间（分钟）</span>
            <input value={timeoutMinutes} onChange={event => setTimeoutMinutes(event.target.value)} placeholder="不限制" inputMode="numeric" />
            <span className="pm-hint">留空表示不限制；运行中仍可随时中止。</span>
          </label>
        )}
        {showAdvancedControls && (
          <label className="dream-check">
            <input type="checkbox" checked={dryRun} onChange={event => setDryRun(event.target.checked)} />
            <span>只预览，不写入知识库</span>
          </label>
        )}
      </div>
      {error && <div className="pm-error-text">{error}</div>}
      <div className="pm-hint dream-run-persist-note">
        手动整理默认不设外层时限，会在后台继续运行；离开页面不会中断，也可随时中止。
      </div>
      {selectedRun?.product ? <TaskProgressCard run={selectedRun} /> : <KnowledgeJourney run={selectedRun} mode={runMode} />}
      {selectedRun && !selectedRun.product && (
        <DreamRunResult run={selectedRun} />
      )}
      <details className="dream-diagnostics-details">
        <summary>遇到问题？查看运行诊断</summary>
        <DreamOpsDiagnostics engine={engine} locks={locks} jobs={jobs} supervisor={supervisor} onChanged={onDone} />
      </details>
    </div>
  );
}

function RecentRuns({ runs }: { runs: ConsoleRun[] }) {
  if (runs.length === 0) return <div className="dream-friendly-empty"><b>还没有整理记录</b><span>开始第一次整理后，记录会显示在这里。</span></div>;
  const runLabel = (run: ConsoleRun) => run.kind.includes('meeting')
    ? '会议与会话整理'
    : run.kind.includes('quick')
      ? '快速维护'
      : run.kind.includes('cycle') || run.kind.includes('full')
        ? '完整知识整理'
        : '自定义整理';
  const statusLabel = (status: string) => ({
    completed: '已完成',
    partial: '部分完成',
    running: '整理中',
    queued: '等待中',
    failed: '未完成',
    skipped: '未执行',
    cancelled: '已中止',
  }[status] ?? status);
  return (
    <div className="dream-run-list">
      {runs.slice(0, 8).map(run => {
        const displayStatus = effectiveDreamStatus(run);
        return (
          <div key={run.id}>
            <span>{runLabel(run)}</span>
            <b className={`run-${displayStatus}`}>{statusLabel(displayStatus)}</b>
            <small>{formatDate(run.startedAt, '-')}</small>
            <button type="button" className="pm-ghost" onClick={() => {
              window.localStorage.setItem(DREAM_LAST_RUN_KEY, run.id);
              window.location.hash = 'dream-execute';
            }}>查看本次整理内容</button>
          </div>
        );
      })}
    </div>
  );
}

export function DreamOverviewPage({ product = false }: { product?: boolean } = {}) {
  const { data, error, loading, busy, busyRuns, reload } = useDreamData();
  const tasks = useProductTasks();
  const currentTask = tasks.rows.find(run => run.kind.startsWith('dream_') && ['running', 'queued'].includes(run.status));
  const displayedTask = currentTask ?? tasks.rows.find(run => run.kind.startsWith('dream_') && run.product);
  const currentProgress = displayedTask ? <TaskProgressCard run={displayedTask} /> : null;
  const previousTasks = useRef(new Map<string, string>());
  useEffect(() => {
    const rows = tasks.rows.filter(run => run.kind.startsWith('dream_'));
    const finished = rows.some(run => ['running', 'queued'].includes(previousTasks.current.get(run.id) ?? '') && !['running', 'queued'].includes(run.status));
    previousTasks.current = new Map(rows.map(run => [run.id, run.status]));
    if (finished) void reload();
  }, [tasks.rows, reload]);
  const [schedule, setSchedule] = useState<{ enabled: boolean; time: string; timeZone: string } | null>(null);
  const [scheduleError, setScheduleError] = useState('');
  useEffect(() => {
    if (!product) return;
    let active = true;
    void api.dreamSchedule().then(value => { if (active) setSchedule(value); }).catch(reason => { if (active) setScheduleError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [product]);
  if (busy) return <DreamShell title="知识整理">{currentProgress}<DreamBusyRecovery runs={busyRuns} onRefresh={() => void reload()} /></DreamShell>;
  if (error) return <DreamShell title="知识整理">{currentProgress}<ErrorBlock message={error} /></DreamShell>;
  if (loading || !data) return <DreamShell title="知识整理">{currentProgress}<Loading text="正在读取整理状态…" /></DreamShell>;

  const activeLock = currentTask ?? data.locks.find(lock => lock.active);
  const pending = data.embeddings.pending ?? 0;
  const orphanPages = data.health?.orphan_pages ?? 0;
  const deadLinks = data.health?.dead_links ?? 0;
  const latestRun = data.runs.find(run => run.kind.startsWith('dream_')) ?? null;
  const latestSummary = latestRun ? describeDreamRun(latestRun) : null;
  const latestOutcome = latestRun ? buildDreamOutcome(latestRun) : null;
  const latestAddedItems = latestOutcome
    ? uniqueStrings([
        ...latestOutcome.knowledgeItems.map(item => `知识：${item}`),
        ...latestOutcome.extractionItems,
      ]).slice(0, 5)
    : [];
  const latestDeltas = dreamRunDeltas(latestRun);
  const needsAttention = pending > 0 || orphanPages > 0 || deadLinks > 0;
  const statusTitle = activeLock
    ? 'AI 正在整理你的知识'
    : needsAttention
      ? '有一些新知识等待整理'
      : '知识库目前状态很好';
  const statusText = activeLock
    ? '整理会在后台继续，完成后这里会显示结果。'
    : pending > 0
      ? product ? `有 ${pending} 段内容等待更新搜索索引。` : `有 ${pending} 段内容等待更新搜索索引，建议运行一次整理。`
      : orphanPages > 0
        ? `发现 ${orphanPages} 个暂时缺少关联的页面，整理后可能建立新的知识连接。`
        : deadLinks > 0
          ? product ? `发现 ${deadLinks} 条需要检查的知识引用。` : `发现 ${deadLinks} 条需要检查的知识引用，建议运行一次整理。`
          : product ? '暂时没有需要处理的问题。' : '暂时没有发现需要立即处理的问题。导入新资料或积累一段时间后再运行即可。';

  return (
    <div className="pm-page dream-page dream-home">
      <section className="dream-hero">
        <div className="dream-hero-copy">
          {!product && <span className="dream-eyebrow">PMBrain Dream</span>}
          <h1>{product ? '知识整理' : '让知识自己长起来'}</h1>
          <p>{product ? '查看后台维护状态和最近的整理结果。' : 'AI 会阅读最近新增的资料，理解内容、建立联系、形成长期记忆，并更新搜索能力。'}</p>
          <div className="dream-hero-actions">
            <button className="pm-ghost" onClick={() => void reload()}>刷新状态</button>
          </div>
        </div>
        {!product && <div className={`dream-status-orbit ${activeLock ? 'running' : needsAttention ? 'attention' : 'healthy'}`}><div className="dream-orbit-core"><span>{activeLock ? '整理中' : needsAttention ? '待整理' : '清晰'}</span></div><i className="orbit-one" /><i className="orbit-two" /></div>}
      </section>

      {currentProgress}
      {product && <section className="maintenance-schedule">
        <span className={`maintenance-dot ${schedule?.enabled ? 'enabled' : ''}`} aria-hidden="true" />
        <div><b>{schedule ? schedule.enabled ? '自动整理已开启' : '自动整理未开启' : scheduleError ? '无法读取自动整理状态' : '正在读取自动整理设置…'}</b><small>{schedule?.enabled ? `每天 ${schedule.time} · ${schedule.timeZone}` : '在设置中配置自动整理时间。'}{scheduleError && ` ${scheduleError}`}</small></div>
        <button type="button" className="pm-ghost" onClick={() => { window.location.hash = 'settings-dream'; }}>整理设置</button>
      </section>}

      <section className="dream-recommendation">
        <div className="dream-recommendation-icon">{activeLock ? '↻' : needsAttention ? '↗' : '✓'}</div>
        <div><b>{statusTitle}</b><span>{statusText}</span></div>
        <small>最近更新 {formatDate(data.overview?.recent_write_at ?? null, '暂无')}</small>
      </section>
      {latestRun && textLooksLikeGinRepairFailure(`${latestRun.stdout}\n${latestRun.stderr}\n${latestRun.error ?? ''}`) && (
        <SearchIndexRepairCard forceShow />
      )}

      {product ? <details className="maintenance-manual" open={Boolean(activeLock)}>
        <summary>{activeLock ? '查看当前任务' : '手动维护与高级操作'}</summary>
        <DreamRunPanel engine={data.overview?.engine} defaultSourceId={data.overview?.main_source_id} phaseCatalog={data.phase_catalog} phaseCapabilities={data.phase_capabilities} generativeEnabled={data.generative_enabled === true} sources={data.overview?.sources} locks={data.locks} jobs={data.jobs} supervisor={data.supervisor} onDone={() => void reload()} />
      </details> : <DreamRunPanel engine={data.overview?.engine} defaultSourceId={data.overview?.main_source_id} phaseCatalog={data.phase_catalog} phaseCapabilities={data.phase_capabilities} generativeEnabled={data.generative_enabled === true} sources={data.overview?.sources} locks={data.locks} jobs={data.jobs} supervisor={data.supervisor} onDone={() => void reload()} />}

      <div className="dream-home-grid">
        <section className="dream-summary-card">
          <span className="dream-eyebrow">最近一次整理</span>
          {latestRun && latestSummary ? (
            <>
              <h2>{latestSummary.headline}</h2>
              <p>{latestSummary.diagnosis}</p>
              <div className="dream-summary-facts">
                {latestSummary.outputs.slice(0, 3).map((item, index) => <span key={index}>{item}</span>)}
              </div>
              <small>{formatDate(latestRun.startedAt, '-')}</small>
              <button type="button" className="pm-ghost dream-view-run" onClick={() => {
                window.localStorage.setItem(DREAM_LAST_RUN_KEY, latestRun.id);
                window.location.hash = 'dream-execute';
              }}>查看本次整理内容</button>
            </>
          ) : (
            <div className="dream-friendly-empty"><b>还没有整理记录</b><span>第一次整理完成后，这里会告诉你 AI 做了什么。</span></div>
          )}
        </section>
        <section className="dream-library-card">
          <span className="dream-eyebrow">知识库状态</span>
          <div className="dream-library-metrics">
            <div><b>{data.overview?.stats.page_count ?? 0}</b><span>知识页面</span><small>本次 +{latestDeltas.pages}</small></div>
            <div>
              <b>{pct(data.embeddings.coverage)}</b>
              <span>已向量化</span>
              {data.overview?.embedding_coverage_delta != null && data.overview.embedding_coverage_delta !== 0 && (
                <small className={data.overview.embedding_coverage_delta > 0 ? 'is-positive' : 'is-negative'}>
                  {data.overview.embedding_coverage_delta > 0 ? '+' : ''}{data.overview.embedding_coverage_delta.toFixed(1)}
                </small>
              )}
            </div>
            <div><b>{data.overview?.stats.link_count ?? 0}</b><span>知识关联</span><small>本次 +{latestDeltas.links}</small></div>
          </div>
          <div className="dream-library-latest">
            <b>最近一次新增内容</b>
            {latestAddedItems.length > 0 ? (
              <ul>
                {latestAddedItems.map((item, index) => <li key={`${item}:${index}`}>{item}</li>)}
              </ul>
            ) : (
              <span>{latestRun ? '最近一次整理没有记录到新增内容明细。' : '完成第一次整理后，这里会展示新增的知识、事实、概念和观点。'}</span>
            )}
          </div>
        </section>
      </div>

      <section className="dream-history-card">
        <div className="dream-section-title">
          <div><span className="dream-eyebrow">整理记录</span><h2>最近发生了什么</h2></div>
          {!product && <button className="pm-ghost" onClick={() => { window.location.hash = 'dream-execute'; }}>打开高级执行页</button>}
        </div>
        <RecentRuns runs={data.runs} />
      </section>
    </div>
  );
}

export function DreamExecutePage() {
  const { data, error, loading, busy, busyRuns, reload } = useDreamData();
  if (busy) return <DreamShell title="阶段执行"><DreamBusyRecovery runs={busyRuns} onRefresh={() => void reload()} /></DreamShell>;
  return (
    <DreamShell title="阶段执行">
      {error && <ErrorBlock message={error} />}
      {loading && <Loading />}
      {data && (
        <>
          <DreamRunPanel engine={data.overview?.engine} defaultSourceId={data.overview?.main_source_id} phaseCatalog={data.phase_catalog} phaseCapabilities={data.phase_capabilities} generativeEnabled={data.generative_enabled === true} sources={data.overview?.sources} locks={data.locks} jobs={data.jobs} supervisor={data.supervisor} onDone={() => void reload()} />
          <PhaseRail catalog={data.phase_catalog} />
          <div className="pm-card">
            <h2>队列与重试</h2>
            <table>
              <thead><tr><th>ID</th><th>任务</th><th>状态</th><th>重试</th><th>更新时间</th></tr></thead>
              <tbody>
                {data.jobs.recent.map(job => (
                  <tr key={job.id}>
                    <td>{job.id}</td>
                    <td>{job.name}</td>
                    <td><span className={`pm-pill run-${job.status}`}>{job.status}</span></td>
                    <td>{job.attempts_made}/{job.max_attempts}</td>
                    <td>{formatDate(job.updated_at, '-')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </DreamShell>
  );
}

export function DreamKnowledgePage() {
  const { data, error, loading, busy, busyRuns, reload } = useDreamData();
  if (busy) return <DreamShell title="知识沉淀"><DreamBusyRecovery runs={busyRuns} onRefresh={() => void reload()} /></DreamShell>;
  if (error) return <DreamShell title="知识沉淀"><ErrorBlock message={error} /></DreamShell>;
  if (loading || !data) return <DreamShell title="知识沉淀"><Loading /></DreamShell>;
  const types = data.knowledge.types;
  const total = Math.max(...types.map(item => item.count), 1);
  return (
    <DreamShell title="知识沉淀" action={<button className="pm-ghost" onClick={() => void reload()}>刷新</button>}>
      <div className="pm-grid metrics-grid">
        <Metric label="Pages" value={data.overview?.stats.page_count ?? '-'} />
        <Metric label="Links" value={data.overview?.stats.link_count ?? '-'} hint="backlinks / extract 输出" />
        <Metric label="Timeline" value={data.overview?.stats.timeline_entry_count ?? '-'} />
        <Metric label="Ingest 24h" value={data.knowledge.ingest?.last_24h ?? 0} hint={`最近 ${formatDate(data.knowledge.ingest?.latest_at ?? null, '-')}`} />
        <Metric label="Orphans" value={data.health?.orphan_pages ?? '-'} />
      </div>
      <div className="pm-grid two-col">
        <div className="pm-card">
          <h2>页面类型分布</h2>
          <div className="pm-bars">
            {types.map(item => (
              <div className="pm-bar-row" key={item.type}>
                <span title={pageTypeTitle(item.type)}>{pageTypeLabel(item.type)}</span>
                <div><i style={{ width: `${Math.max(4, item.count / total * 100)}%` }} /></div>
                <b>{item.count}</b>
              </div>
            ))}
          </div>
        </div>
        <div className="pm-card">
          <h2>基础治理阶段</h2>
          <PhaseRail catalog={data.phase_catalog} active="backlinks" />
        </div>
      </div>
    </DreamShell>
  );
}

export function DreamTakesPage() {
  return <TakeProposalsPage title="观点生产线" intro="propose_takes 的候选观点在这里完成证据查看、通过和拒绝。旧的观点审批入口已由本页取代。" />;
}

export function DreamScoringPage() {
  const { data, error, loading, busy, busyRuns, reload } = useDreamData();
  if (busy) return <DreamShell title="权重与评分"><DreamBusyRecovery runs={busyRuns} onRefresh={() => void reload()} /></DreamShell>;
  if (error) return <DreamShell title="权重与评分"><ErrorBlock message={error} /></DreamShell>;
  if (loading || !data) return <DreamShell title="权重与评分"><Loading /></DreamShell>;
  return (
    <DreamShell title="权重与评分" action={<button className="pm-ghost" onClick={() => void reload()}>刷新</button>}>
      <div className="pm-grid metrics-grid">
        <Metric label="Brain Score" value={numberValue(data.health?.brain_score)} />
        <Metric label="Embed score" value={numberValue(data.health?.embed_coverage_score)} hint="满分 35" />
        <Metric label="Link score" value={numberValue(data.health?.link_density_score)} hint="满分 25" />
        <Metric label="Timeline score" value={numberValue(data.health?.timeline_coverage_score)} hint="满分 15" />
        <Metric label="Take avg weight" value={numberValue(data.takes?.avg_weight)} hint={`最高 ${numberValue(data.takes?.max_weight)}`} />
      </div>
      <div className="pm-grid two-col">
        <div className="pm-card">
          <h2>Embedding 执行详情</h2>
          <table>
            <thead><tr><th>Source</th><th>Chunks</th><th>已向量化</th><th>待处理</th></tr></thead>
            <tbody>
              {data.embeddings.by_source.map(row => (
                <tr key={row.source_id}>
                  <td>{row.source_id}</td>
                  <td>{row.chunks}</td>
                  <td>{row.embedded}</td>
                  <td>{row.pending}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="pm-card">
          <h2>高权重页面</h2>
          <div className="dream-weight-list">
            {data.weights.top_pages.map(page => (
              <div key={`${page.source_id}:${page.slug}`}>
                <b>{page.title || page.slug}</b>
                <span>{page.source_id} / {page.type}</span>
                <strong>{numberValue(page.emotional_weight)}</strong>
              </div>
            ))}
          </div>
        </div>
      </div>
    </DreamShell>
  );
}

export function DreamCalibrationPage() {
  return (
    <DreamShell title="校准画像">
      <CalibrationPage />
    </DreamShell>
  );
}

export function DreamInsightsPage() {
  const { data, error, loading, busy, busyRuns, reload } = useDreamData();
  if (busy) return <DreamShell title="知识维护与质量"><DreamBusyRecovery runs={busyRuns} onRefresh={() => void reload()} /></DreamShell>;
  if (error) return <DreamShell title="知识维护与质量"><ErrorBlock message={error} /></DreamShell>;
  if (loading || !data) return <DreamShell title="知识维护与质量"><Loading /></DreamShell>;
  return (
    <DreamShell title="知识维护与质量" action={<button className="pm-ghost" onClick={() => void reload()}>刷新</button>}>
      <div className="pm-grid metrics-grid">
        <Metric label="软删除页面" value={data.lifecycle?.soft_deleted_pages ?? 0} />
        <Metric label="可清理页面" value={data.lifecycle?.purge_ready_pages ?? 0} />
        <Metric label="归档 source" value={data.lifecycle?.archived_sources ?? 0} />
        <Metric label="死链" value={data.lifecycle?.dead_links ?? data.health?.dead_links ?? 0} />
        <Metric label="风险扫描" value={data.quality.contradiction_runs[0]?.total_contradictions_flagged ?? 0} hint="最近矛盾探针" />
      </div>
      <div className="pm-grid two-col">
        <div className="pm-card">
          <h2>生命周期阶段</h2>
          <PhaseRail catalog={data.phase_catalog} active="purge" />
        </div>
        <div className="pm-card">
          <h2>质量评估记录</h2>
          <table>
            <thead><tr><th>类型</th><th>结果</th><th>得分/数量</th><th>时间</th></tr></thead>
            <tbody>
              {data.quality.takes_quality_runs.map(row => (
                <tr key={`takes-${row.id}`}>
                  <td>takes-quality</td>
                  <td>{row.verdict}</td>
                  <td>{numberValue(row.overall_score)}</td>
                  <td>{formatDate(row.created_at, '-')}</td>
                </tr>
              ))}
              {data.quality.contradiction_runs.map(row => (
                <tr key={row.run_id}>
                  <td>contradictions</td>
                  <td>{row.judge_errors_total > 0 ? 'warn' : 'ok'}</td>
                  <td>{row.total_contradictions_flagged}/{row.queries_evaluated}</td>
                  <td>{formatDate(row.ran_at, '-')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </DreamShell>
  );
}
