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
  embed: '更新 AI 搜索和理解能力',
  orphans: '发现缺少关联的孤立知识',
  'schema-suggest': '检查知识结构是否需要优化',
  purge: '清理已经过期且可安全移除的数据',
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
  embed: 'lifecycle', orphans: 'lifecycle', 'schema-suggest': 'lifecycle', purge: 'lifecycle',
};

function phasesForGroup(catalog: string[], groupKey: string): string[] {
  return catalog.filter(phase => PHASE_GROUP_BY_PHASE[phase] === groupKey);
}

const KNOWLEDGE_STEPS = [
  { key: 'read', title: '阅读新内容', description: '找到最近新增或变化的资料', phases: ['lint', 'backlinks', 'sync'] },
  { key: 'understand', title: '理解与提炼', description: '提取事实、人物、概念和知识点', phases: ['synthesize', 'extract', 'extract_facts', 'extract_atoms'] },
  { key: 'connect', title: '建立知识连接', description: '补全关系并发现反复出现的主题', phases: ['resolve_symbol_edges', 'patterns', 'synthesize_concepts'] },
  { key: 'remember', title: '形成长期记忆', description: '合并重复信息并沉淀重要判断', phases: ['recompute_emotional_weight', 'consolidate', 'propose_takes', 'grade_takes', 'calibration_profile', 'conversation_facts_backfill'] },
  { key: 'search', title: '更新搜索能力', description: '让最新知识可以被 AI 准确找到', phases: ['embed', 'orphans', 'schema-suggest', 'purge'] },
] as const;

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
    // Keep the current Dream page mounted during background refreshes. Replacing
    // it with the initial loading screen resets the user's scroll anchor.
    if (!data) setLoading(true);
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

export function dreamRunDeltas(run: ConsoleRun | null): { pages: number; links: number } {
  if (!run || !run.kind.startsWith('dream_') || run.command.includes('--dry-run')) {
    return { pages: 0, links: 0 };
  }
  const totals = parseDreamReport(run)?.totals ?? {};
  const pages = Math.max(0, Number(totals.pages_added ?? totals.synth_pages_written ?? 0));
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
      actions: report?.phases?.map(phase => PHASE_USER_ACTIONS[phase.phase] ?? phase.summary ?? phase.phase) ?? ['进程已被用户中止。'],
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

  const actions = report?.phases?.map(phase => PHASE_USER_ACTIONS[phase.phase] ?? phase.summary ?? phase.phase) ?? [];
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

  let headline = isDryRun ? 'Dry run 已完成：只是预演，没有写入知识点' : 'Dream 已完成';
  let diagnosis = isDryRun
    ? 'dry-run 会检查影响范围和部分判定逻辑，但不会提交综合写入，所以“没有新知识点”是预期结果。'
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
    actions: actions.length > 0 ? actions : ['没有可展示的整理步骤；需要排查时可查看技术详情。'],
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

type JourneyState = 'idle' | 'active' | 'done' | 'warning';

function phaseProgressFromRun(run: ConsoleRun | null): { completed: Set<string>; active: string | null; report: DreamCycleReport | null } {
  if (!run) return { completed: new Set(), active: null, report: null };
  const report = parseDreamReport(run);
  const completed = new Set(
    (report?.phases ?? [])
      .filter(phase => phase.status === 'ok' || phase.status === 'skipped' || phase.status === 'warn')
      .map(phase => phase.phase),
  );
  const text = `${run.stdout}\n${run.stderr}`;
  for (const match of text.matchAll(/\[cycle\.([a-z_-]+)\]\s+done/g)) completed.add(match[1]);
  const starts = [...text.matchAll(/\[cycle\.([a-z_-]+)\]\s+start/g)];
  const lastStarted = starts.length > 0 ? starts[starts.length - 1]?.[1] ?? null : null;
  const active = run.status === 'running' || run.status === 'queued'
    ? (lastStarted && !completed.has(lastStarted) ? lastStarted : null)
    : null;
  return { completed, active, report };
}

export function isKnowledgeJourneyComplete(run: ConsoleRun | null): boolean {
  if (!run || run.status !== 'completed' || run.command.includes('--dry-run')) return false;
  const report = parseDreamReport(run);
  const embedStatus = report?.phases?.find(phase => phase.phase === 'embed')?.status;
  return !!report
    && report.status !== 'failed'
    && !report.reason
    && (embedStatus === 'ok' || embedStatus === 'skipped')
    && (report.phases?.length ?? 0) > 1;
}

function KnowledgeJourney({ run }: { run: ConsoleRun | null }) {
  const progress = phaseProgressFromRun(run);
  const running = run?.status === 'running' || run?.status === 'queued';
  const successfulRun = isKnowledgeJourneyComplete(run);
  return (
    <section className={`dream-journey ${running ? 'is-running' : ''}`} aria-label="知识整理进度">
      <div className="dream-journey-head">
        <div>
          <span className="dream-eyebrow">知识生长轨迹</span>
          <h2>{running ? 'AI 正在整理你的知识' : '一次整理，会完成这五件事'}</h2>
        </div>
        {running && <span className="dream-live"><i />后台运行中</span>}
      </div>
      <div className="dream-journey-track">
        {KNOWLEDGE_STEPS.map((step, index) => {
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
      const result = Array.isArray(phase.pagesAffected)
        ? `实际写入 ${phase.pagesAffected.length} 个页面`
        : '本次运行记录未提供实际写入明细';
      return `检测到 ${candidates} 个待同步文件，${result}${failed > 0 ? `，${failed} 个文件解析失败` : ''}。`;
    }
    case 'extract':
      return `已建立 ${number('linksCreated')} 条知识链接和 ${number('timelineCreated')} 条时间线记录。`;
    case 'extract_facts':
      return `已检查 ${number('pagesScanned')} 个页面，核对并写入 ${number('factsInserted')} 条事实。`;
    case 'propose_takes':
      return `已分 ${number('batches')} 批处理 ${number('pages_processed')} 页，生成 ${number('proposals_inserted')} 条候选观点，跳过 ${number('cache_hits')} 页已处理内容，失败 ${number('pages_failed')} 页，剩余 ${number('remaining')} 页。`;
    case 'resolve_symbol_edges':
      return number('chunks_walked') > 0
        ? `已检查 ${number('chunks_walked')} 个内容块，确认 ${number('edges_resolved')} 条关系，${number('edges_ambiguous')} 条仍需消歧。`
        : '当前没有需要解析的知识关系。';
    case 'embed':
      return `已为 ${number('embedded')} 个内容块更新搜索索引，${number('skipped')} 个内容块已有有效索引。`;
    case 'orphans':
      return `发现 ${number('total_orphans')} 个暂时缺少关联的页面，共检查 ${number('total_pages')} 个页面。`;
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
                        <summary>查看实际写入的 {phase.pagesAffected?.length ?? 0} 个页面</summary>
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
          {stuckReason
            ? <p className="pm-warning">{stuckReason}</p>
            : <p className="pm-hint">一键整理和会议整理会在需要时自动启动 Worker，通常不需要手动操作。这里用于故障诊断和恢复。</p>}
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
  defaultSourceId,
  compact = false,
  phaseCatalog = [],
  sources,
  locks,
  jobs,
  supervisor,
  onDone,
}: {
  defaultPhase?: string;
  defaultSourceId?: string;
  compact?: boolean;
  phaseCatalog?: string[];
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
  const [dryRun, setDryRun] = useState(false);
  const [timeoutMinutes, setTimeoutMinutes] = useState('120');
  const [runMode, setRunMode] = useState<DreamRunMode>(() => {
    const saved = window.localStorage.getItem(DREAM_RUN_MODE_KEY);
    return saved === 'meeting' || saved === 'cycle' || saved === 'advanced'
      ? saved
      : defaultPhase === 'all' ? 'cycle' : 'advanced';
  });

  const [run, setRun] = useState<ConsoleRun | null>(null);
  const [error, setError] = useState('');
  const running = run?.status === 'running' || run?.status === 'queued';

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
    } else if (mode === 'cycle') {
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

  const start = async (dryRunOverride?: boolean) => {
    setError('');
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
    try {
      const effectiveDryRun = dryRunOverride ?? dryRun;
      const needsSubagentWorker = !effectiveDryRun && (
        runMode === 'cycle'
        || runMode === 'meeting'
        || (runMode === 'advanced' && (phase === 'synthesize' || phase === 'patterns'))
      );
      if (needsSubagentWorker && !supervisor?.running) {
        await api.startSupervisor();
        onDone?.();
      }
      const res = await api.startDreamRun({
        preset: runMode === 'meeting' ? 'meeting' : runMode === 'cycle' ? 'full' : undefined,
        phase: runMode === 'advanced' ? phase : undefined,
        sourceId: runMode === 'advanced' ? sourceId.trim() || undefined : defaultSourceId,
        maxPages: runMode === 'advanced' && phase === 'propose_takes' && maxPages.trim() ? Number(maxPages) : undefined,
        drainProposals: runMode === 'cycle',
        windowSeconds: runMode === 'cycle' && timeoutMs
          ? Math.max(60, Math.floor((timeoutMs * 0.75) / 1000))
          : undefined,
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
    <div id="dream-launcher" className={`dream-launcher ${compact ? 'compact' : ''}`}>
      <div className="dream-launcher-head">
        <div>
          <span className="dream-eyebrow">开始整理</span>
          <h2>{runMode === 'meeting' ? '把会议和会话变成长期知识' : runMode === 'advanced' ? '自定义本次整理' : '让知识库自己整理一遍'}</h2>
          <p>{runMode === 'meeting'
            ? '选择会议记录或会话文件夹，AI 会完成整理、提炼、连接和索引。'
            : runMode === 'advanced'
              ? '按来源、日期或内部阶段运行，适合调试和精细维护。'
              : 'AI 会检查最近的变化，补全关系、合并重复信息，并更新搜索能力。'}</p>
        </div>
        <div className="dream-run-actions">
          <button className="pm-primary dream-primary-action" onClick={() => void start(runMode === 'advanced' ? undefined : false)} disabled={running}>
            {running ? '正在整理…' : runMode === 'meeting' ? '开始整理会议' : runMode === 'advanced' ? '运行所选流程' : '开始整理知识'}
          </button>
          {!running && runMode !== 'advanced' && (
            <button className="pm-ghost" onClick={() => void start(true)}>先预览会发生什么</button>
          )}
          {running && <button className="pm-ghost danger" onClick={() => void cancel()}>中止</button>}
        </div>
      </div>
      <div className="dream-run-mode">
        <button type="button" className={runMode === 'cycle' ? 'active' : ''} onClick={() => applyRunMode('cycle')}>
          一键整理
        </button>
        <button type="button" className={runMode === 'meeting' ? 'active' : ''} onClick={() => applyRunMode('meeting')}>
          会议与会话
        </button>
        <button type="button" className={runMode === 'advanced' ? 'active' : ''} onClick={() => applyRunMode('advanced')}>
          高级设置
        </button>
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
              {phaseCatalog.map(item => <option key={item} value={item} title={PHASE_LABELS[item]}>{item}</option>)}
            </select>
            {phase !== 'all' && (
              <div className="pm-hint" style={{ marginTop: 4 }}>
                {PHASE_LABELS[phase]}
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
            <input value={timeoutMinutes} onChange={event => setTimeoutMinutes(event.target.value)} placeholder="120" inputMode="numeric" />
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
        整理会在后台继续运行，离开页面不会中断。
      </div>
      <KnowledgeJourney run={run} />
      {run && (
        <>
          <DreamRunNarrative run={run} />
          <DreamTechnicalDetails run={run} />
          <details className="nl-details">
            <summary>原始日志与命令</summary>
            <RunOutput run={run} />
          </details>
        </>
      )}
      <details className="dream-diagnostics-details">
        <summary>遇到问题？查看运行诊断</summary>
        <DreamOpsDiagnostics locks={locks} jobs={jobs} supervisor={supervisor} onChanged={onDone} />
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
  const statusLabel = (status: string) => ({ completed: '已完成', running: '整理中', queued: '等待中', failed: '未完成', cancelled: '已中止' }[status] ?? status);
  return (
    <div className="dream-run-list">
      {runs.slice(0, 8).map(run => (
        <div key={run.id}>
          <span>{runLabel(run)}</span>
          <b className={`run-${run.status}`}>{statusLabel(run.status)}</b>
          <small>{formatDate(run.startedAt, '-')}</small>
        </div>
      ))}
    </div>
  );
}

export function DreamOverviewPage() {
  const { data, error, loading, reload } = useDreamData();
  if (error) return <DreamShell title="AI 知识整理"><ErrorBlock message={error} /></DreamShell>;
  if (loading || !data) return <DreamShell title="AI 知识整理"><Loading text="正在了解你的知识库…" /></DreamShell>;

  const activeLock = data.locks.find(lock => lock.active);
  const pending = data.embeddings.pending ?? 0;
  const orphanPages = data.health?.orphan_pages ?? 0;
  const deadLinks = data.health?.dead_links ?? 0;
  const latestRun = data.runs.find(run => run.kind.startsWith('dream_')) ?? null;
  const latestSummary = latestRun ? describeDreamRun(latestRun) : null;
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
      ? `有 ${pending} 段内容等待更新搜索索引，建议运行一次整理。`
      : orphanPages > 0
        ? `发现 ${orphanPages} 个暂时缺少关联的页面，整理后可能建立新的知识连接。`
        : deadLinks > 0
          ? `发现 ${deadLinks} 条需要检查的知识引用，建议运行一次整理。`
          : '暂时没有发现需要立即处理的问题。导入新资料或积累一段时间后再运行即可。';

  return (
    <div className="pm-page dream-page dream-home">
      <section className="dream-hero">
        <div className="dream-hero-copy">
          <span className="dream-eyebrow">PMBrain Dream</span>
          <h1>让知识自己长起来</h1>
          <p>AI 会阅读最近新增的资料，理解内容、建立联系、形成长期记忆，并更新搜索能力。</p>
          <div className="dream-hero-actions">
            <button className="pm-ghost" onClick={() => void reload()}>刷新状态</button>
          </div>
        </div>
        <div className={`dream-status-orbit ${activeLock ? 'running' : needsAttention ? 'attention' : 'healthy'}`}>
          <div className="dream-orbit-core"><span>{activeLock ? '整理中' : needsAttention ? '待整理' : '清晰'}</span></div>
          <i className="orbit-one" /><i className="orbit-two" />
        </div>
      </section>

      <section className="dream-recommendation">
        <div className="dream-recommendation-icon">{activeLock ? '↻' : needsAttention ? '↗' : '✓'}</div>
        <div><b>{statusTitle}</b><span>{statusText}</span></div>
        <small>最近更新 {formatDate(data.overview?.recent_write_at ?? null, '暂无')}</small>
      </section>

      <DreamRunPanel defaultSourceId={data.overview?.main_source_id} phaseCatalog={data.phase_catalog} sources={data.overview?.sources} locks={data.locks} jobs={data.jobs} supervisor={data.supervisor} onDone={() => void reload()} />

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
            </>
          ) : (
            <div className="dream-friendly-empty"><b>还没有整理记录</b><span>第一次整理完成后，这里会告诉你 AI 做了什么。</span></div>
          )}
        </section>
        <section className="dream-library-card">
          <span className="dream-eyebrow">知识库状态</span>
          <div className="dream-library-metrics">
            <div><b>{data.overview?.stats.page_count ?? 0}</b><span>知识页面</span><small>本次 +{latestDeltas.pages}</small></div>
            <div><b>{pct(data.embeddings.coverage)}</b><span>可被 AI 搜索</span></div>
            <div><b>{data.overview?.stats.link_count ?? 0}</b><span>知识关联</span><small>本次 +{latestDeltas.links}</small></div>
          </div>
        </section>
      </div>

      <section className="dream-history-card">
        <div className="dream-section-title">
          <div><span className="dream-eyebrow">整理记录</span><h2>最近发生了什么</h2></div>
          <button className="pm-ghost" onClick={() => { window.location.hash = 'dream-execute'; }}>打开高级执行页</button>
        </div>
        <RecentRuns runs={data.runs} />
      </section>
    </div>
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
          <DreamRunPanel defaultSourceId={data.overview?.main_source_id} phaseCatalog={data.phase_catalog} sources={data.overview?.sources} locks={data.locks} jobs={data.jobs} supervisor={data.supervisor} onDone={() => void reload()} />
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
