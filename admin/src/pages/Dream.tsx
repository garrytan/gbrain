import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { RunOutput, formatDate, pageTypeLabel, pageTypeTitle, type ConsoleRun } from '../lib/shared';
import { TakeProposalsPage } from './TakeProposals';
import { CalibrationPage } from './Calibration';

interface DreamData {
  phase_catalog: string[];
  overview: {
    version: string;
    engine: string;
    schema_pack: string;
    embedding_coverage: number;
    pending_embeddings: number;
    recent_write_at: string | null;
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
    pid_file: string;
    mode?: 'supervisor' | 'direct-worker' | 'none';
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
  orphans: '孤儿页面检测：发现没有被任何页面引用的孤立页面',
  'schema-suggest': 'Schema 建议：推荐知识库结构优化方案',
  purge: '清理：删除软删除标记的页面和数据',
  project_health: '项目健康检查：评估知识库整体健康状况',
  risk_detect: '风险检测：发现知识库中的矛盾和信息风险',
  report_gen: '报告生成：自动生成知识库状态报告',
};

const PHASE_GROUPS = [
  {
    key: 'prepare',
    title: '同步与数据准备',
    phases: ['lint', 'backlinks', 'sync', 'extract', 'extract_facts', 'extract_atoms', 'resolve_symbol_edges', 'embed'],
  },
  {
    key: 'synthesis',
    title: '知识沉淀',
    phases: ['synthesize', 'patterns', 'synthesize_concepts', 'recompute_emotional_weight', 'consolidate'],
  },
  {
    key: 'takes',
    title: '观点与校准',
    phases: ['propose_takes', 'grade_takes', 'calibration_profile', 'conversation_facts_backfill'],
  },
  {
    key: 'lifecycle',
    title: '项目洞察与生命周期',
    phases: ['orphans', 'schema-suggest', 'purge', 'project_health', 'risk_detect', 'report_gen'],
  },
];

type DreamRunMode = 'meeting' | 'cycle' | 'advanced';

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

  const load = async () => {
    setLoading(true);
    try {
      setData(await api.dreamOverview() as DreamData);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);
  return { data, error, loading, reload: load };
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
          <p className="pm-page-intro">把 Dream 从分散的后台 phase，整理成可查看、可控制、可追踪、可干预的知识进化工作台。</p>
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

function PhaseRail({ active }: { active?: string }) {
  return (
    <div className="dream-phase-rail">
      {PHASE_GROUPS.map(group => (
        <section key={group.key}>
          <h2>{group.title}</h2>
          <div>
            {group.phases.map(phase => <span key={phase} className={phase === active ? 'active' : ''} title={PHASE_LABELS[phase]}>{phase}</span>)}
          </div>
        </section>
      ))}
    </div>
  );
}

const DREAM_LAST_RUN_KEY = 'pmbrain.dream.lastRunId';

interface DreamPhaseReport {
  phase: string;
  status: string;
  summary?: string;
  details?: Record<string, unknown>;
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

function describeDreamRun(run: ConsoleRun): {
  headline: string;
  diagnosis: string;
  actions: string[];
  outputs: string[];
  details: string[];
  slugs: string[];
} {
  const report = parseDreamReport(run);
  const text = `${run.stdout}\n${run.stderr}`;
  const synth = report?.phases?.find(phase => phase.phase === 'synthesize');
  const synthDetails = synth?.details ?? {};
  const totals = report?.totals ?? {};
  const writtenSlugs = asStringArray(synthDetails.written_slugs);
  const childOutcomes = asArray(synthDetails.child_outcomes) as Array<{ status?: string; jobId?: number }>;
  const failedChildren = childOutcomes.filter(item => item.status && item.status !== 'completed').length;
  const isDryRun = run.command.includes('--dry-run') || synthDetails.dryRun === true;
  const locked = report?.reason === 'cycle_already_running' || /already running|locked/i.test(text);
  const duration = report?.duration_ms ?? run.durationMs ?? 0;
  const phaseCount = report?.phases?.length ?? 0;
  const pagesWritten = Number(totals.synth_pages_written ?? synthDetails.pages_written ?? 0);
  const transcriptsProcessed = Number(totals.transcripts_processed ?? synthDetails.transcripts_processed ?? 0);
  const transcriptsDiscovered = Number(synthDetails.transcripts_discovered ?? 0);

  if (run.status === 'running' || run.status === 'queued') {
    return {
      headline: 'Dream 正在后台执行',
      diagnosis: '离开本页不会主动停止后台进程；返回后会继续读取同一个 run 的状态。需要停下时点“中止”。',
      actions: ['正在等待命令完成，已保留当前 run id。'],
      outputs: ['运行结束后这里会显示产出的知识点、跳过原因和失败明细。'],
      details: [`run id: ${run.id}`, `命令: ${run.command.join(' ')}`],
      slugs: [],
    };
  }

  if (run.status === 'cancelled') {
    return {
      headline: '本次 Dream 已中止',
      diagnosis: '中止会结束 Admin 启动的 Dream 子进程；已经完成的阶段会保留，未开始或未完成的阶段不会继续写入。',
      actions: report?.phases?.map(phase => `${phase.phase}: ${phase.summary ?? phase.status}`) ?? ['进程已被用户中止。'],
      outputs: pagesWritten > 0 ? [`中止前已写入 ${pagesWritten} 个知识页。`] : ['中止前没有检测到新的知识页写入。'],
      details: [`耗时约 ${(duration / 1000).toFixed(1)} 秒`, `run id: ${run.id}`],
      slugs: writtenSlugs,
    };
  }

  if (locked) {
    return {
      headline: '本次没有执行：Dream 锁正在保护另一轮运行',
      diagnosis: 'Dream 对会写库的阶段使用单周期锁，避免同步、抽取、向量化、综合写入同时改同一批数据。通常等上一轮结束后再跑即可；如果上一轮异常退出，刷新后仍长期 locked 再处理锁。',
      actions: ['没有进入 phase 执行。'],
      outputs: ['没有生成新的知识点，也没有写入页面。'],
      details: [`状态: ${run.status}`, `run id: ${run.id}`],
      slugs: [],
    };
  }

  const actions = report?.phases?.map(phase => `${phase.phase}: ${phase.summary ?? phase.status}`) ?? [];
  const details: string[] = [
    `检查阶段: ${phaseCount}`,
    `耗时约 ${(duration / 1000).toFixed(1)} 秒`,
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

  let headline = isDryRun ? 'Dry run 已完成：只是预演，没有写入知识点' : 'Dream 已完成';
  let diagnosis = isDryRun
    ? 'dry-run 会检查影响范围和部分判定逻辑，但不会提交综合写入，所以“没有新知识点”是预期结果。'
    : '命令已结束，需要看下面的产出和子任务结果判断是否真的沉淀成功。';
  const outputs: string[] = [];

  if (!isDryRun && pagesWritten > 0) {
    outputs.push(`生成 ${pagesWritten} 个知识页。`);
    headline = `Dream 已生成 ${pagesWritten} 个知识点/页面`;
  } else if (!isDryRun && synth) {
    outputs.push('没有生成新的知识页。');
    if (failedChildren > 0) {
      diagnosis = '这不是操作方式问题，而是综合阶段的子任务失败、超时或被取消，导致没有可收集的 put_page 写入。';
    } else if (transcriptsProcessed === 0) {
      diagnosis = '本次没有进入可写综合：可能是没有输入、显著性过滤认为不需要处理，或处于冷却/跳过状态。';
    }
  } else if (isDryRun && synth) {
    const verdicts = asArray(synthDetails.verdicts) as Array<{ worth?: boolean }>;
    outputs.push(`预演发现 ${transcriptsDiscovered} 份输入，其中 ${verdicts.filter(v => v?.worth === true).length} 份可能需要综合。`);
  }

  if (run.status === 'failed') {
    headline = 'Dream 执行失败';
    diagnosis = firstErrorText(run, report) || diagnosis;
  }

  if (writtenSlugs.length > 0) {
    outputs.push(`页面 slug: ${writtenSlugs.slice(0, 8).join(', ')}${writtenSlugs.length > 8 ? ' ...' : ''}`);
  }
  if (outputs.length === 0) outputs.push('没有检测到新的知识页写入。');

  return {
    headline,
    diagnosis,
    actions: actions.length > 0 ? actions : ['没有结构化 phase 明细；请查看原始日志。'],
    outputs,
    details,
    slugs: writtenSlugs,
  };
}

function DreamRunNarrative({ run }: { run: ConsoleRun }) {
  const summary = describeDreamRun(run);
  return (
    <div className="dream-run-narrative">
      <div className="dream-run-headline">
        <b>{summary.headline}</b>
        <span className={`run-${run.status}`}>{run.status}</span>
      </div>
      <p>{summary.diagnosis}</p>
      <div className="dream-result-grid">
        <section>
          <h3>做了什么</h3>
          <ul>{summary.actions.slice(0, 12).map((item, index) => <li key={index}>{item}</li>)}</ul>
        </section>
        <section>
          <h3>产出结果</h3>
          <ul>{summary.outputs.map((item, index) => <li key={index}>{item}</li>)}</ul>
        </section>
      </div>
      <div className="dream-detail-chips">
        {summary.details.map((item, index) => <span key={index}>{item}</span>)}
      </div>
    </div>
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
  locks,
  jobs,
  supervisor,
  onChanged,
}: {
  locks?: DreamData['locks'];
  jobs?: DreamData['jobs'];
  supervisor?: DreamData['supervisor'];
  onChanged?: () => void;
}) {
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
  const stuckReason = !supervisor?.running && waiting > 0
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
          {stuckReason ? <p className="pm-warning">{stuckReason}</p> : <p className="pm-hint">Worker、锁和 subagent 队列状态会在这里同步显示。</p>}
        </div>
        <div className="dream-run-actions">
          {supervisor?.running ? (
            <button className="pm-ghost danger" disabled={!!busy} onClick={() => void runAction('stop-supervisor', () => api.stopSupervisor())}>停止 Worker</button>
          ) : (
            <button className="pm-ghost" disabled={!!busy} onClick={() => void runAction('start-supervisor', () => api.startSupervisor())}>启动 Worker</button>
          )}
        </div>
      </div>
      <div className="dream-ops-grid">
        <section>
          <h4>Worker</h4>
          <div className="pm-kv"><span>状态</span><b>{supervisor?.running ? 'running' : 'stopped'}</b></div>
          <div className="pm-kv"><span>PID</span><b>{supervisor?.supervisor_pid ?? '-'}</b></div>
          <div className="pm-kv"><span>模式</span><b>{supervisor?.mode ?? '-'}</b></div>
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

function DreamRunPanel({
  defaultPhase = 'all',
  compact = false,
  sources,
  locks,
  jobs,
  supervisor,
  onDone,
}: {
  defaultPhase?: string;
  compact?: boolean;
  sources?: Array<{ id: string; name: string; page_count: number; archived?: boolean }>;
  locks?: DreamData['locks'];
  jobs?: DreamData['jobs'];
  supervisor?: DreamData['supervisor'];
  onDone?: () => void;
}) {
  const [phase, setPhase] = useState(defaultPhase);
  const [sourceId, setSourceId] = useState('');
  const [maxPages, setMaxPages] = useState('25');
  const [input, setInput] = useState('');
  const [date, setDate] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const [timeoutMinutes, setTimeoutMinutes] = useState('120');
  const [runMode, setRunMode] = useState<DreamRunMode>(defaultPhase === 'all' ? 'cycle' : 'advanced');

  const isAllPhase = phase === 'all';
  const [run, setRun] = useState<ConsoleRun | null>(null);
  const [error, setError] = useState('');
  const running = run?.status === 'running' || run?.status === 'queued';

  const activeSources = useMemo(
    () => (sources ?? []).filter(s => !s.archived),
    [sources],
  );

  const hasInputDateConflict = !!(input.trim() && (date || from || to));
  const hasDateRangeConflict = !!(date && (from || to));
  const hasFromToConflict = !!(from && to && from > to);
  const hasConflict = hasInputDateConflict || hasDateRangeConflict || hasFromToConflict;
  const showAdvancedControls = runMode === 'advanced';
  const showInputControls = runMode === 'meeting' || runMode === 'advanced';
  const inputEnabled = runMode === 'meeting' || phase === 'all' || phase === 'synthesize';

  const applyRunMode = (mode: DreamRunMode) => {
    setRunMode(mode);
    if (mode === 'meeting') {
      setPhase('synthesize');
      setSourceId('');
      setDate('');
      setFrom('');
      setTo('');
      setDryRun(false);
    } else if (mode === 'cycle') {
      setPhase('all');
      setSourceId('');
      setInput('');
      setDate('');
      setFrom('');
      setTo('');
      setDryRun(true);
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
    if (!running) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [running]);

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

  const start = async () => {
    setError('');
    if (hasConflict) {
      setError('存在字段冲突，请先解决后再运行');
      return;
    }
    const timeoutMs = timeoutMinutes.trim() ? Math.floor(Number(timeoutMinutes) * 60_000) : undefined;
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      setError('超时时间必须是正数分钟');
      return;
    }
    try {
      const res = await api.startDreamRun({
        phase,
        sourceId: sourceId.trim() || undefined,
        maxPages: maxPages.trim() ? Number(maxPages) : undefined,
        dryRun,
        input: input.trim() || undefined,
        date: date.trim() || undefined,
        from: from.trim() || undefined,
        to: to.trim() || undefined,
        timeoutMs,
      }) as { runId: string };
      window.localStorage.setItem(DREAM_LAST_RUN_KEY, res.runId);
      setRun(await api.run(res.runId) as ConsoleRun);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const cancel = async () => {
    if (!run || !running) return;
    setError('');
    try {
      const next = await api.cancelRun(run.id) as ConsoleRun;
      setRun(next);
      onDone?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className={`pm-card dream-run-panel ${compact ? 'compact' : ''}`}>
      <div className="pm-section-head">
        <div>
          <h2>运行控制</h2>
          <p className="pm-muted">支持整轮 Dream 或单个 phase。默认 dry-run，先看影响范围再执行。</p>
        </div>
        <div className="dream-run-actions">
          <button className="pm-primary" onClick={() => void start()} disabled={running}>
            {running ? '执行中' : '启动'}
          </button>
          {running && <button className="pm-ghost danger" onClick={() => void cancel()}>中止</button>}
        </div>
      </div>
      <div className="pm-hint dream-run-persist-note">
        离开本页不会主动停止后台执行；返回后会继续显示同一个 run 的状态。关闭或刷新浏览器时会提示确认。
      </div>
      <div className="dream-run-mode">
        <button type="button" className={runMode === 'cycle' ? 'active' : ''} onClick={() => applyRunMode('cycle')}>
          Dream
        </button>
        <button type="button" className={runMode === 'meeting' ? 'active' : ''} onClick={() => applyRunMode('meeting')}>
          会议/会话整理
        </button>
        <button type="button" className={runMode === 'advanced' ? 'active' : ''} onClick={() => applyRunMode('advanced')}>
          高级阶段
        </button>
        <span>
          {runMode === 'meeting'
            ? '整理会议记录、Codex/ChatGPT/Claude 会话或其它对话文件夹，逐份写入会议/会话摘要并沉淀观点。'
            : runMode === 'cycle'
              ? '整轮 Dream 预演，先看影响范围和系统状态，不写入知识库。'
              : '保留 phase、source、日期范围等高级参数。'}
        </span>
      </div>
      <div className="dream-run-grid">
        {showAdvancedControls && (
          <label>
            <span>Phase</span>
            <select value={phase} onChange={event => {
              const newPhase = event.target.value;
              setPhase(newPhase);
              if (newPhase === 'all') setSourceId('');
            }}>
              <option value="all">整轮 cycle</option>
              {PHASE_GROUPS.map(group => (
                <optgroup key={group.key} label={group.title}>
                  {group.phases.map(item => <option key={item} value={item} title={PHASE_LABELS[item]}>{item}</option>)}
                </optgroup>
              ))}
            </select>
            {phase !== 'all' && (
              <div className="pm-hint" style={{ marginTop: 4 }}>
                {PHASE_LABELS[phase]}
              </div>
            )}
          </label>
        )}
        {showAdvancedControls && (
          <label className={isAllPhase ? 'dream-input-disabled' : ''}>
            <span>Source ID</span>
            <select value={sourceId} onChange={event => setSourceId(event.target.value)} disabled={isAllPhase}
              title={isAllPhase ? '整轮 cycle 不支持按 source 过滤，部分 phase（embed/orphans/purge 等）始终全局执行。如需指定 source 请先选择单个 phase。' : ''}>
              <option value="">全部 source</option>
              {activeSources.map(s => (
                <option key={s.id} value={s.id}>{s.name || s.id}（{s.page_count} 页）</option>
              ))}
            </select>
          </label>
        )}
        <label>
          <span>Max pages</span>
          <input value={maxPages} onChange={event => setMaxPages(event.target.value)} placeholder="可选" inputMode="numeric" />
        </label>
        {!compact && showInputControls && (
          <>
            <label className={!inputEnabled ? 'dream-input-disabled' : ''}>
              <span>{runMode === 'meeting' ? '文件/文件夹路径' : 'Input file'}</span>
              <input value={input} onChange={event => setInput(event.target.value)}
                placeholder={!inputEnabled ? '仅 synthesize 支持单文件，已禁用' : 'D:\\LenovoSoftstore\\huiyijilu 或 C:\\Users\\zhengyunhui\\.codex\\sessions'}
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
        <label>
          <span>超时(分钟)</span>
          <input value={timeoutMinutes} onChange={event => setTimeoutMinutes(event.target.value)} placeholder="120" inputMode="numeric" />
        </label>
        <label className="dream-check">
          <input type="checkbox" checked={dryRun} onChange={event => setDryRun(event.target.checked)} />
          <span>Dry run</span>
        </label>
      </div>
      {error && <div className="pm-error-text">{error}</div>}
      <DreamOpsDiagnostics locks={locks} jobs={jobs} supervisor={supervisor} onChanged={onDone} />
      {run && (
        <>
          <DreamRunNarrative run={run} />
          <details className="nl-details">
            <summary>原始日志与命令</summary>
            <RunOutput run={run} />
          </details>
        </>
      )}
    </div>
  );
}

function RecentRuns({ runs }: { runs: ConsoleRun[] }) {
  if (runs.length === 0) return <div className="pm-empty compact-empty">暂无本次服务内 Dream 运行记录。</div>;
  return (
    <div className="dream-run-list">
      {runs.slice(0, 8).map(run => (
        <div key={run.id}>
          <span>{run.kind}</span>
          <b className={`run-${run.status}`}>{run.status}</b>
          <small>{formatDate(run.startedAt, '-')}</small>
        </div>
      ))}
    </div>
  );
}

function DreamRunStatusCard({
  locks,
  jobs,
  supervisor,
}: {
  locks?: DreamData['locks'];
  jobs?: DreamData['jobs'];
  supervisor?: DreamData['supervisor'];
}) {
  const activeLock = locks?.find(lock => lock.active) ?? null;
  const waiting = countBy(jobs?.subagent_status ?? [], 'waiting');
  const active = countBy(jobs?.subagent_status ?? [], 'active');
  const failed = countBy(jobs?.subagent_status ?? [], 'failed');
  return (
    <div className="pm-card dream-run-panel compact">
      <div className="pm-section-head">
        <div>
          <h2>运行状态</h2>
          <p className="pm-muted">这里只展示 Dream 当前状态；执行和调试请进入阶段执行页面。</p>
        </div>
        <button className="pm-primary" onClick={() => { window.location.hash = 'dream-execute'; }}>去执行</button>
      </div>
      <div className="dream-ops-grid">
        <section>
          <h4>Worker</h4>
          <div className="pm-kv"><span>状态</span><b>{supervisor?.running ? 'running' : 'stopped'}</b></div>
          <div className="pm-kv"><span>PID</span><b>{supervisor?.supervisor_pid ?? '-'}</b></div>
        </section>
        <section>
          <h4>Cycle lock</h4>
          <div className="pm-kv"><span>状态</span><b>{activeLock ? 'active' : 'none'}</b></div>
          <div className="pm-kv"><span>最近刷新</span><b>{formatDate(activeLock?.last_refreshed_at ?? null, '-')}</b></div>
        </section>
        <section>
          <h4>Subagent 队列</h4>
          <div className="dream-detail-chips">
            <span>waiting {jobs?.subagent_queue?.waiting ?? waiting}</span>
            <span>active {jobs?.subagent_queue?.active ?? active}</span>
            <span>failed {failed}</span>
          </div>
        </section>
      </div>
    </div>
  );
}

export function DreamOverviewPage() {
  const { data, error, loading, reload } = useDreamData();
  if (error) return <DreamShell title="Dream 总览"><ErrorBlock message={error} /></DreamShell>;
  if (loading || !data) return <DreamShell title="Dream 总览"><Loading /></DreamShell>;

  const activeLock = data.locks.find(lock => lock.active);
  const pendingProposals = countBy(data.proposals, 'pending');

  return (
    <DreamShell title="Dream 总览" action={<button className="pm-ghost" onClick={() => void reload()}>刷新</button>}>
      <div className="pm-grid metrics-grid">
        <Metric label="Brain Score" value={numberValue(data.health?.brain_score)} hint="知识库综合评分" />
        <Metric label="Embedding" value={pct(data.embeddings.coverage)} hint={`${data.embeddings.pending ?? 0} 待向量化`} />
        <Metric label="候选观点" value={pendingProposals} hint="等待人工处理" />
        <Metric label="锁状态" value={activeLock ? '运行中' : '空闲'} hint={activeLock ? `TTL ${formatDate(activeLock.ttl_expires_at, '-')}` : '无活跃 cycle lock'} />
        <Metric label="最近写入" value={formatDate(data.overview?.recent_write_at ?? null, '-')} />
      </div>
      <PhaseRail />
      <div className="pm-grid two-col">
        <DreamRunStatusCard locks={data.locks} jobs={data.jobs} supervisor={data.supervisor} />
        <div className="pm-card">
          <h2>Checkpoint / 锁 / 恢复</h2>
          <div className="pm-kv"><span>活跃锁</span><b>{activeLock ? activeLock.id : '无'}</b></div>
          <div className="pm-kv"><span>持有者</span><b>{activeLock ? `${activeLock.holder_host ?? 'host'}:${activeLock.holder_pid}` : '-'}</b></div>
          <div className="pm-kv"><span>最近刷新</span><b>{formatDate(activeLock?.last_refreshed_at ?? null, '-')}</b></div>
          <div className="pm-kv"><span>队列 active</span><b>{countBy(data.jobs.status, 'active')}</b></div>
          <div className="pm-kv"><span>队列 failed</span><b>{countBy(data.jobs.status, 'failed')}</b></div>
        </div>
      </div>
      <div className="pm-card">
        <div className="pm-section-head"><h2>最近 Dream 运行</h2></div>
        <RecentRuns runs={data.runs} />
      </div>
    </DreamShell>
  );
}

export function DreamExecutePage() {
  const { data, error, loading, reload } = useDreamData();
  return (
    <DreamShell title="阶段执行">
      {error && <ErrorBlock message={error} />}
      {loading && <Loading />}
      {data && (
        <>
          <DreamRunPanel sources={data.overview?.sources} locks={data.locks} jobs={data.jobs} supervisor={data.supervisor} onDone={() => void reload()} />
          <PhaseRail />
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
  const { data, error, loading, reload } = useDreamData();
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
          <PhaseRail active="backlinks" />
        </div>
      </div>
    </DreamShell>
  );
}

export function DreamTakesPage() {
  return <TakeProposalsPage title="观点生产线" intro="propose_takes 的候选观点在这里完成证据查看、通过和拒绝。旧的观点审批入口已由本页取代。" />;
}

export function DreamScoringPage() {
  const { data, error, loading, reload } = useDreamData();
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
  const { data, error, loading, reload } = useDreamData();
  if (error) return <DreamShell title="项目洞察"><ErrorBlock message={error} /></DreamShell>;
  if (loading || !data) return <DreamShell title="项目洞察"><Loading /></DreamShell>;
  return (
    <DreamShell title="项目洞察" action={<button className="pm-ghost" onClick={() => void reload()}>刷新</button>}>
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
          <PhaseRail active="purge" />
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
