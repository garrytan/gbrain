import {
  buildMemoryReviewReport,
  formatMemoryReviewReport,
  type MemoryReviewReportInput,
  type ReportCanonicalTargetProposal,
  type ReportConflict,
  type ReportCanonicalMemory,
  type ReportConnectorHealth,
  type ReportContextEvalRun,
  type ReportCandidateAgeEscalation,
  type ReportDataIntegrityError,
  type ReportExtractedClaim,
  type ReportLifecycleState,
  type ReportMaintenanceJob,
  type ReportPageHealthItem,
  type ReportMemoryStrength,
  type ReportPolicyDenial,
  type ReportProjectionTarget,
  type ReportQuarantinedSource,
  type ReportRecurringRetrievalGap,
  type ReportReviewItem,
  type ReportRetrievalTrajectoryScore,
  type ReportRunnerJob,
  type ReportSecretDetection,
  type ReportSource,
  type ReportSourceItem,
  type ReportWatchedQuestionChange,
} from '../core/services/memory-review-report-service.ts';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { saveBrainReport } from './report.ts';
import {
  scoreRetrievalTrajectory,
  summarizeRetrievalTrajectoryScores,
} from '../core/evaluation/retrieval-trajectory-score.ts';
import type { BrainEngine } from '../core/engine.ts';
import type {
  CanonicalTargetProposalStatus,
  DecisionProjectionMemoryCandidate,
  DecisionProjectionTaskAttempt,
  CanonicalTargetProposalEntry,
  MemoryCandidateEntry,
  MemoryCandidateFilters,
  MemoryMutationEvent,
  Page,
  RetrievalTrace,
  MemoryWriteSession,
} from '../core/types.ts';
import { createLifecycleForgettingStoreForEngine } from '../core/maintenance/lifecycle-forgetting.ts';
import { computeCandidateDebtMetrics } from '../core/services/inbox-lead-service.ts';
import { buildNegativeMemoryProjections } from '../core/services/negative-memory-projection-service.ts';
import { buildSkillSurfaceManifest } from '../core/services/skill-surface-manifest-service.ts';
import {
  computeMemoryStrengthReport,
  slugFromRetrievalTraceSourceRef,
  type MemoryStrengthEntry,
} from '../core/services/memory-strength-service.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from '../core/services/note-manifest-service.ts';

const DEFAULT_SCOPE_ID = 'workspace:default';
const DEFAULT_LIMIT = 100;
const CANDIDATE_DEBT_SCAN_PAGE_SIZE = 500;
const PAGE_HEALTH_SCAN_CAP = 1_000;

export interface MemoryReportNotifyConfig {
  mode: 'off' | 'auto' | 'command';
  command?: string;
}

export interface MemoryReportNotificationResult {
  mode: MemoryReportNotifyConfig['mode'];
  attempted: boolean;
  delivered: boolean;
  message: string | null;
}

export interface MemoryReportNotificationRuntime {
  platform?: string;
  spawnSync?: typeof spawnSync;
}
const CANDIDATE_DEBT_PROPOSAL_PAGE_SIZE = 500;
const CANDIDATE_DEBT_PROPOSAL_STATUSES: CanonicalTargetProposalStatus[] = [
  'proposed',
  'approved',
  'patch_staged',
  'bound',
  'blocked',
];
let activeReportDataIntegrityErrors: ReportDataIntegrityError[] | null = null;

export async function runMemoryReport(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    printMemoryReportHelp();
    return;
  }

  const scopeId = valueAfter(args, '--scope-id') ?? DEFAULT_SCOPE_ID;
  const limit = parsePositiveInt(valueAfter(args, '--limit')) ?? DEFAULT_LIMIT;
  const now = valueAfter(args, '--now') ?? new Date().toISOString();
  const reportType = valueAfter(args, '--type');
  const reportDir = args.includes('--report-dir') ? requiredValueAfter(args, '--report-dir') : '.';
  const report = buildMemoryReviewReport(await collectMemoryReportInput(engine, scopeId, limit, now));
  const formatted = reportType === undefined
    ? formatMemoryReviewReport(report)
    : formatTypedMemoryReport(reportType, report);
  const savedReportPath = args.includes('--save')
    ? saveBrainReport({
      brainDir: reportDir,
      type: reportType === undefined ? 'memory-review-report' : `memory-${reportType}`,
      title: reportType === undefined ? 'Memory Review Report' : `Memory ${reportType}`,
      content: formatted,
      now: new Date(now),
    })
    : undefined;

  if (args.includes('--json')) {
    console.log(JSON.stringify(savedReportPath ? { ...report, saved_report_path: savedReportPath } : report, null, 2));
    return;
  }

  console.log(formatted);
  if (savedReportPath) console.log(`Saved report: ${savedReportPath}`);
}

function formatTypedMemoryReport(reportType: string, report: ReturnType<typeof buildMemoryReviewReport>): string {
  if (reportType !== 'retrieval-trajectory-score') {
    throw new Error(`Unsupported memory report type: ${reportType}`);
  }
  const score = report.sections.retrieval_trajectory_score;
  const lines = [
    'Retrieval Trajectory Score',
    `Scope: ${report.scope_id}`,
    `Generated: ${report.generated_at}`,
  ];
  if (!score || score.trace_count === 0) {
    lines.push('', 'No retrieval traces in the scoring window.');
    return lines.join('\n');
  }
  lines.push(
    '',
    `J: ${score.average_j.toFixed(3)}`,
    `traces: ${score.trace_count}`,
    `cost: ${score.average_cost.toFixed(3)}`,
    `redundancy: ${score.average_redundancy.toFixed(3)}`,
    `groundedness: ${score.average_groundedness === null ? score.groundedness_status : score.average_groundedness.toFixed(3)}`,
    `latency_avg_ms: ${score.average_elapsed_ms === null ? 'n/a' : score.average_elapsed_ms.toFixed(0)}`,
    `retrieved_tokens: ${score.retrieved_token_count_total}`,
    `latest_trace_id: ${score.latest_trace_id ?? 'n/a'}`,
  );
  return lines.join('\n');
}

export async function saveMemoryReviewReport(engine: BrainEngine, input: {
  scope_id: string;
  now: string;
  limit?: number;
  report_dir: string;
  notify?: MemoryReportNotifyConfig;
}): Promise<{ path: string; counts: Record<string, number>; summary_lines: string[]; notification?: MemoryReportNotificationResult }> {
  const report = buildMemoryReviewReport(await collectMemoryReportInput(
    engine,
    input.scope_id,
    input.limit ?? DEFAULT_LIMIT,
    input.now,
  ));
  const formatted = formatMemoryReviewReport(report);
  const path = saveBrainReport({
    brainDir: input.report_dir,
    type: 'memory-review-report',
    title: 'Memory Review Report',
    content: formatted,
    now: new Date(input.now),
  });
  const counts = {
    review_items: report.summary.review_items,
    open_conflicts: report.summary.conflicts,
    incomplete_handoffs: report.summary.candidate_promoted_without_handoff,
    failed_jobs: report.summary.failed_jobs,
  };
  const summaryLines = report.health.reasons;
  const notification = deliverMemoryReportNotification(input.notify, {
    path,
    counts,
    summary_lines: summaryLines,
  });
  return {
    path,
    counts,
    summary_lines: summaryLines,
    ...(notification ? { notification } : {}),
  };
}

export function deliverMemoryReportNotification(
  config: MemoryReportNotifyConfig | undefined,
  payload: { path: string; counts: Record<string, number>; summary_lines: string[] },
  runtime: MemoryReportNotificationRuntime = {},
): MemoryReportNotificationResult | undefined {
  if (!config || config.mode === 'off') {
    return config ? { mode: 'off', attempted: false, delivered: false, message: null } : undefined;
  }
  const run = runtime.spawnSync ?? spawnSync;
  if (config.mode === 'command') {
    if (!config.command?.trim()) {
      return { mode: 'command', attempted: false, delivered: false, message: 'missing command' };
    }
    const result = run(config.command, {
      shell: true,
      input: JSON.stringify(payload),
      encoding: 'utf8',
    });
    return {
      mode: 'command',
      attempted: true,
      delivered: result.status === 0,
      message: result.status === 0 ? null : (result.stderr || result.error?.message || `exit ${result.status}`),
    };
  }
  if ((runtime.platform ?? process.platform) === 'darwin') {
    const message = appleScriptStringLiteral(`Open ${payload.path}`);
    const title = appleScriptStringLiteral('MBrain memory report');
    const result = run('osascript', [
      '-e',
      `display notification ${message} with title ${title}`,
    ], { encoding: 'utf8' });
    return {
      mode: 'auto',
      attempted: true,
      delivered: result.status === 0,
      message: result.status === 0 ? null : (result.stderr || result.error?.message || `exit ${result.status}`),
    };
  }
  return { mode: 'auto', attempted: false, delivered: false, message: 'no supported notifier found' };
}

function appleScriptStringLiteral(value: string): string {
  return JSON.stringify(value);
}

function valueAfter(args: string[], flag: string): string | undefined {
  const inlinePrefix = `${flag}=`;
  const inline = args.find((arg) => arg.startsWith(inlinePrefix));
  if (inline !== undefined) return inline.slice(inlinePrefix.length);
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

function requiredValueAfter(args: string[], flag: string): string {
  const value = valueAfter(args, flag);
  if (!value || value.startsWith('-')) {
    throw new Error(`${flag} expects a path value`);
  }
  return value;
}

export async function collectMemoryReportInput(
  engine: BrainEngine,
  scopeId: string,
  limit: number,
  generatedAt: string = new Date().toISOString(),
): Promise<MemoryReviewReportInput> {
  const previousDataIntegrityErrors = activeReportDataIntegrityErrors;
  const dataIntegrityErrors: ReportDataIntegrityError[] = [];
  activeReportDataIntegrityErrors = dataIntegrityErrors;
  try {
  const [
    mutationEvents,
    displayCandidates,
    lifecycleStates,
    purgeCandidates,
    projectionTargets,
    sources,
    sourceItems,
    extractedClaims,
    policyDenials,
    quarantinedSources,
    secretDetections,
    conflicts,
    runnerJobs,
    jobs,
    connectorHealth,
    failedTaskAttempts,
    canonicalTargetProposals,
    writeSessions,
    contextEvalRuns,
    retrievalTrajectoryScore,
    memoryStrength,
    recurringRetrievalGaps,
    pageHealthQueue,
    watchedQuestionChanges,
  ] = await Promise.all([
    engine.listMemoryMutationEvents({ scope_id: scopeId, limit, offset: 0 }),
    engine.listMemoryCandidateEntries({ scope_id: scopeId, limit, offset: 0 }),
    collectLifecycleStates(engine, scopeId, limit),
    collectPurgeCandidates(engine, scopeId, generatedAt, limit),
    collectProjectionTargets(engine, limit),
    collectSources(engine, limit),
    collectSourceItems(engine, limit),
    collectExtractedClaims(engine, limit),
    collectPolicyDenials(engine, limit),
    collectQuarantinedSources(engine, limit),
    collectSecretDetections(engine, limit),
    collectConflicts(engine, limit),
    collectRunnerJobs(engine, limit),
    collectMaintenanceJobs(engine, limit),
    collectConnectorHealth(engine, limit),
    collectFailedTaskAttempts(engine, scopeId, limit),
    collectCanonicalTargetProposals(engine, scopeId, limit),
    collectMemoryWriteSessions(engine, scopeId, limit),
    collectContextEvalRuns(engine, limit),
    collectRetrievalTrajectoryScore(engine, generatedAt, limit),
    collectMemoryStrength(engine, generatedAt, limit),
    collectRecurringRetrievalGaps(engine, generatedAt, limit),
    collectPageHealthQueue(engine, generatedAt, limit),
    collectWatchedQuestionChanges(engine, scopeId, generatedAt, limit),
  ]);
  const candidateScan = await collectCandidateDebtScan(engine, scopeId, displayCandidates, limit);
  const [
    canonicalHandoffCandidateState,
    candidateDebtCanonicalTargetProposals,
  ] = await Promise.all([
    collectCanonicalHandoffCandidateState(engine, scopeId, candidateScan.candidates),
    collectCandidateDebtCanonicalTargetProposals(engine, scopeId),
  ]);
  const negativeMemoryProjections = [
    ...failedTaskAttempts.flatMap((attempt) => buildNegativeMemoryProjections({
      task_attempts: [attempt],
      current_anchors: attempt.applicability_context,
      now: generatedAt,
    })),
    ...buildNegativeMemoryProjections({
      memory_candidates: displayCandidates.map(memoryCandidateToDecisionProjectionCandidate),
      now: generatedAt,
    }),
  ];
  const candidateDebt = computeCandidateDebtMetrics({
    candidates: candidateScan.candidates,
    canonical_handoff_candidate_ids: canonicalHandoffCandidateState.handoff_candidate_ids,
    completed_canonical_handoff_candidate_ids: canonicalHandoffCandidateState.completed_handoff_candidate_ids,
    canonical_target_proposals: candidateDebtCanonicalTargetProposals,
  });

  return {
    scope_id: scopeId,
    generated_at: generatedAt,
    canonical_memories: mutationEvents.flatMap(memoryMutationToCanonicalMemory),
    review_items: displayCandidates.flatMap(memoryCandidateToReviewItem),
    canonical_target_proposals: canonicalTargetProposals,
    write_sessions: writeSessions,
    lifecycle_states: lifecycleStates,
    purge_candidates: purgeCandidates,
    projection_targets: projectionTargets,
    sources,
    source_items: sourceItems,
    extracted_claims: extractedClaims,
    policy_denials: [
      ...policyDenials,
      ...mutationEvents.flatMap(memoryMutationToPolicyDenial),
    ],
    quarantined_sources: quarantinedSources,
    secret_detections: secretDetections,
    conflicts: [
      ...conflicts,
      ...mutationEvents.flatMap(memoryMutationToConflict),
    ],
    runner_jobs: runnerJobs,
    jobs,
    connector_health: connectorHealth,
    candidate_debt: {
      ...candidateDebt,
      total_candidate_count: candidateScan.total_count,
      debt_scan_candidate_count: candidateScan.candidates.length,
      displayed_candidate_count: displayCandidates.length,
      display_limit: limit,
    },
    negative_memory_projections: negativeMemoryProjections,
    context_eval_runs: contextEvalRuns,
    retrieval_trajectory_score: retrievalTrajectoryScore,
    memory_strength: memoryStrength,
    skill_surface: collectSkillSurfaceSummary(),
    candidate_age_escalations: collectCandidateAgeEscalations(candidateScan.candidates, generatedAt),
    promoted_candidate_refutations: collectPromotedCandidateRefutations(candidateScan.candidates),
    recurring_retrieval_gaps: recurringRetrievalGaps,
    page_health_queue: pageHealthQueue,
    watched_question_changes: watchedQuestionChanges,
    data_integrity_errors: dataIntegrityErrors,
  };
  } finally {
    activeReportDataIntegrityErrors = previousDataIntegrityErrors;
  }
}

async function collectCandidateDebtScan(
  engine: BrainEngine,
  scopeId: string,
  firstPage: MemoryCandidateEntry[],
  displayLimit: number,
): Promise<{ candidates: MemoryCandidateEntry[]; total_count: number }> {
  const filters: MemoryCandidateFilters = { scope_id: scopeId };
  if (typeof engine.countMemoryCandidateEntries !== 'function') {
    return { candidates: firstPage, total_count: firstPage.length };
  }

  const totalCount = await engine.countMemoryCandidateEntries(filters);
  if (totalCount <= firstPage.length) {
    return { candidates: firstPage, total_count: totalCount };
  }

  const byId = new Map(firstPage.map((candidate) => [candidate.id, candidate]));
  const pageSize = Math.max(CANDIDATE_DEBT_SCAN_PAGE_SIZE, displayLimit);
  for (let offset = firstPage.length; offset < totalCount; offset += pageSize) {
    const batch = await engine.listMemoryCandidateEntries({
      ...filters,
      limit: pageSize,
      offset,
    });
    if (batch.length === 0) break;
    for (const candidate of batch) byId.set(candidate.id, candidate);
  }

  return { candidates: [...byId.values()], total_count: totalCount };
}

function collectCandidateAgeEscalations(
  candidates: MemoryCandidateEntry[],
  generatedAt: string,
): ReportCandidateAgeEscalation[] {
  const nowMs = new Date(generatedAt).getTime();
  if (!Number.isFinite(nowMs)) return [];
  return candidates
    .filter((candidate) => (
      candidate.verification_status === 'unverified'
      && (candidate.status === 'captured' || candidate.status === 'candidate' || candidate.status === 'staged_for_review')
    ))
    .map((candidate) => {
      const ageDays = Math.floor((nowMs - candidate.created_at.getTime()) / 86_400_000);
      return {
        id: candidate.id,
        status: candidate.status,
        age_days: ageDays,
        bucket: ageDays >= 30 ? '30d' as const : '7d' as const,
        next_action: `verify_memory_candidate_entry ${candidate.id}`,
      };
    })
    .filter((candidate) => candidate.age_days >= 7)
    .sort((a, b) => {
      if (b.age_days !== a.age_days) return b.age_days - a.age_days;
      return a.id.localeCompare(b.id);
    });
}

function collectPromotedCandidateRefutations(
  candidates: MemoryCandidateEntry[],
): NonNullable<MemoryReviewReportInput['promoted_candidate_refutations']> {
  return candidates
    .filter((candidate) => candidate.status === 'promoted' && candidate.verification_status === 'refuted')
    .map((candidate) => ({
      id: candidate.id,
      target_object_type: candidate.target_object_type,
      target_object_id: candidate.target_object_id,
      verification_evidence: candidate.verification_evidence ?? 'Promoted candidate was refuted after promotion.',
      verification_source_refs: candidate.verification_source_refs,
      next_action: buildPromotedRefutationNextAction(candidate),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function buildPromotedRefutationNextAction(candidate: MemoryCandidateEntry): string {
  const target = candidate.target_object_id;
  if (candidate.target_object_type === 'curated_note' && target) {
    return `why ${target}; review canonical_handoff_entries for ${candidate.id}; update or supersede the canonical page line`;
  }
  return `review canonical_handoff_entries for ${candidate.id}; update or supersede the canonical target`;
}

async function collectRecurringRetrievalGaps(
  engine: BrainEngine,
  generatedAt: string,
  limit: number,
): Promise<ReportRecurringRetrievalGap[]> {
  if (typeof engine.listRetrievalTracesByWindow !== 'function') return [];
  const until = new Date(generatedAt);
  const since = new Date(until.getTime() - 7 * 24 * 60 * 60 * 1000);
  try {
    const traces = await engine.listRetrievalTracesByWindow({
      since,
      until,
      limit: Math.max(limit, 100),
    });
    return summarizeRecurringRetrievalGaps(traces, limit);
  } catch (error) {
    activeReportDataIntegrityErrors?.push({
      query: 'retrieval_traces',
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function summarizeRecurringRetrievalGaps(
  traces: RetrievalTrace[],
  limit: number,
): ReportRecurringRetrievalGap[] {
  const groups = new Map<string, RetrievalTrace[]>();
  for (const trace of traces) {
    if (!trace.verification.includes('answer_ready:not_ready')) continue;
    const reasons = trace.verification
      .filter((item) => item.startsWith('unsupported:'))
      .map((item) => item.slice('unsupported:'.length))
      .filter((reason) => reason.length > 0);
    for (const reason of reasons.length > 0 ? reasons : ['answer_ready_not_ready']) {
      const existing = groups.get(reason) ?? [];
      existing.push(trace);
      groups.set(reason, existing);
    }
  }

  return [...groups.entries()]
    .filter(([, group]) => group.length >= 2)
    .map(([reason, group]) => {
      const sorted = [...group].sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
      return {
        id: `retrieval-gap:${stableIdFragment(reason)}`,
        reason,
        count: group.length,
        sample_trace_ids: sorted.slice(0, 3).map((trace) => trace.id),
        latest_at: sorted[0]?.created_at.toISOString() ?? new Date(0).toISOString(),
        next_action: `Review recurring read_context gap "${reason}" and add or repair canonical coverage before relying on probe-only answers.`,
      };
    })
    .sort((a, b) => b.count - a.count || b.latest_at.localeCompare(a.latest_at) || a.reason.localeCompare(b.reason))
    .slice(0, Math.min(10, Math.max(1, limit)));
}

function stableIdFragment(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 10);
}

async function collectPageHealthQueue(
  engine: BrainEngine,
  generatedAt: string,
  limit: number,
): Promise<ReportPageHealthItem[]> {
  if (typeof engine.listPages !== 'function' || typeof engine.getChunks !== 'function') return [];
  try {
    const scanLimit = Math.min(PAGE_HEALTH_SCAN_CAP, Math.max(limit, 100));
    const pages = await engine.listPages({ limit: scanLimit, offset: 0 });
    if (pages.length === scanLimit) {
      activeReportDataIntegrityErrors?.push({
        query: 'page_health_queue_scan_cap',
        message: `Page-health scan inspected ${scanLimit} pages; results are capped before expensive chunk checks.`,
      });
    }
    const titleCounts = new Map<string, number>();
    for (const page of pages) {
      const key = normalizeReportKey(page.title);
      if (!key) continue;
      titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
    }
    const recentlyUsedSlugs = await collectRecentlyUsedPageSlugs(engine, generatedAt);
    const usageAvailable = recentlyUsedSlugs.size > 0;
    const items = await Promise.all(pages.map((page) =>
      buildPageHealthItem(engine, page, titleCounts, recentlyUsedSlugs, usageAvailable)
    ));
    return items
      .filter((item): item is ReportPageHealthItem => item !== null)
      .sort((a, b) => a.score - b.score || a.slug.localeCompare(b.slug))
      .slice(0, Math.min(10, Math.max(1, limit)));
  } catch (error) {
    activeReportDataIntegrityErrors?.push({
      query: 'page_health_queue',
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

async function buildPageHealthItem(
  engine: BrainEngine,
  page: Page,
  titleCounts: Map<string, number>,
  recentlyUsedSlugs: Set<string>,
  usageAvailable: boolean,
): Promise<ReportPageHealthItem | null> {
  let score = 100;
  const issues: string[] = [];
  const addIssue = (issue: string, penalty: number) => {
    issues.push(issue);
    score -= penalty;
  };

  if (page.timeline_changed_at.getTime() > page.compiled_truth_changed_at.getTime()) {
    addIssue('compile_debt', 25);
  }

  const chunks = await engine.getChunks(page.slug);
  const missingEmbeddings = chunks.filter((chunk) => !chunk.embedded_at).length;
  if (chunks.length > 0 && missingEmbeddings > 0) {
    addIssue(`missing_embeddings:${missingEmbeddings}/${chunks.length}`, 20);
  }

  if (!/\[Source:/i.test(`${page.compiled_truth}\n${page.timeline}`)) {
    addIssue('source_coverage_missing', 15);
  }

  const titleKey = normalizeReportKey(page.title);
  if (titleKey && (titleCounts.get(titleKey) ?? 0) > 1) {
    addIssue('duplicate_title', 15);
  }

  const deadLinks = await countDeadManifestLinks(engine, page.slug);
  if (deadLinks > 0) {
    addIssue(`dead_wikilinks:${deadLinks}`, 15);
  }

  const lineCount = `${page.compiled_truth}\n${page.timeline}`.split('\n').length;
  if (lineCount > 800) {
    addIssue(`oversized:${lineCount}_lines`, 10);
  }

  const supersededBy = typeof page.frontmatter.superseded_by === 'string'
    ? page.frontmatter.superseded_by.trim()
    : '';
  if (supersededBy) {
    addIssue(`superseded_by:${supersededBy}`, 10);
  }

  if (usageAvailable && !recentlyUsedSlugs.has(page.slug)) {
    addIssue('cold_usage', 5);
  }

  if (issues.length === 0) return null;
  return {
    slug: page.slug,
    title: page.title,
    score: Math.max(0, score),
    issues,
    next_action: nextPageHealthAction(page.slug, issues),
  };
}

async function collectRecentlyUsedPageSlugs(
  engine: BrainEngine,
  generatedAt: string,
): Promise<Set<string>> {
  const until = new Date(generatedAt);
  const since = new Date(until.getTime() - 90 * 24 * 60 * 60 * 1000);
  try {
    const traces = await engine.listRetrievalTracesByWindow({ since, until, limit: 1_000 });
    return new Set(traces.flatMap((trace) =>
      trace.source_refs
        .map(slugFromRetrievalTraceSourceRef)
        .filter((slug): slug is string => Boolean(slug))
    ));
  } catch {
    return new Set();
  }
}

async function countDeadManifestLinks(engine: BrainEngine, slug: string): Promise<number> {
  try {
    const manifest = await engine.getNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, slug);
    if (!manifest || manifest.outgoing_wikilinks.length === 0) return 0;
    const targets = [...new Set(manifest.outgoing_wikilinks)].filter((target) => target !== slug).slice(0, 50);
    const checks = await Promise.all(targets.map(async (target) => {
      try {
        return (await engine.getPage(target)) ? 0 : 1;
      } catch {
        return 0;
      }
    }));
    return checks.reduce<number>((total, count) => total + count, 0);
  } catch {
    return 0;
  }
}

function nextPageHealthAction(slug: string, issues: string[]): string {
  const first = issues[0] ?? '';
  if (first === 'compile_debt') return `Create a governed patch candidate to recompile timeline updates into ${slug}.`;
  if (first.startsWith('missing_embeddings:')) return `Run mbrain embed --stale for ${slug}.`;
  if (first === 'source_coverage_missing') return `Add source citations or mark unsupported claims in ${slug}.`;
  if (first === 'duplicate_title') return `Review duplicate-title pages and merge or supersede ${slug}.`;
  if (first.startsWith('dead_wikilinks:')) return `Repair or remove dead wikilinks in ${slug}.`;
  if (first.startsWith('oversized:')) return `Split or summarize ${slug} below the 800-line guideline.`;
  if (first.startsWith('superseded_by:')) return `Confirm retrieval demotion and backlink validation for ${slug}.`;
  if (first === 'cold_usage') return `Review whether ${slug} should stay active, be archived, or be linked from current work.`;
  return `Review page health signals for ${slug}.`;
}

function normalizeReportKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function collectWatchedQuestionChanges(
  engine: BrainEngine,
  scopeId: string,
  generatedAt: string,
  limit: number,
): Promise<ReportWatchedQuestionChange[]> {
  if (typeof (engine as Partial<BrainEngine>).listWatchedQuestionRuns !== 'function') {
    return [];
  }
  const until = new Date(generatedAt);
  if (!Number.isFinite(until.getTime())) return [];
  const since = new Date(until.getTime() - 7 * 24 * 60 * 60 * 1000);
  try {
    const runs = await engine.listWatchedQuestionRuns({
      scope_id: scopeId,
      changed: true,
      since,
      until,
      limit,
      offset: 0,
    });
    return runs.map((run) => ({
      id: run.id,
      question_id: run.question_id,
      question: run.question,
      changed_at: run.created_at.toISOString(),
      previous_required_reads: run.previous_required_reads.map(reportWatchedRead),
      current_required_reads: run.current_required_reads.map(reportWatchedRead),
      next_action: `Review watched question ${run.question_id} and read current evidence before acting.`,
    }));
  } catch (error) {
    activeReportDataIntegrityErrors?.push({
      query: 'watched_question_runs',
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function reportWatchedRead(read: { slug: string; content_hash: string }): { slug: string; content_hash: string } {
  return {
    slug: read.slug,
    content_hash: read.content_hash,
  };
}

function collectSkillSurfaceSummary() {
  const manifest = buildSkillSurfaceManifest();
  return {
    resource_count: manifest.filter((entry) => entry.mcp_resource_loadable).length,
    manifest_hash: createHash('sha256')
      .update(JSON.stringify(manifest.map((entry) => [entry.id, entry.sha256])))
      .digest('hex'),
    agent_rules_version: manifest.find((entry) => entry.id === 'agent-rules')?.version ?? null,
  };
}

async function collectContextEvalRuns(
  engine: BrainEngine,
  limit: number,
): Promise<ReportContextEvalRun[]> {
  if (typeof (engine as Partial<BrainEngine>).listContextEvalRuns !== 'function') {
    return [];
  }
  const runs = await engine.listContextEvalRuns({ limit });
  return runs.map((run) => ({
    id: run.id,
    fixture_id: run.fixture_id,
    status: run.status,
    total: typeof run.metrics.total === 'number' ? run.metrics.total : 0,
    failed: typeof run.metrics.failed === 'number' ? run.metrics.failed : 0,
    pass_rate: typeof run.metrics.pass_rate === 'number' ? run.metrics.pass_rate : 0,
    created_at: run.created_at.toISOString(),
  }));
}

async function collectRetrievalTrajectoryScore(
  engine: BrainEngine,
  generatedAt: string,
  limit: number,
): Promise<ReportRetrievalTrajectoryScore | null> {
  if (typeof (engine as Partial<BrainEngine>).listRetrievalTracesByWindow !== 'function') {
    return null;
  }
  const until = new Date(generatedAt);
  if (!Number.isFinite(until.getTime())) return null;
  const since = new Date(until.getTime() - (7 * 24 * 60 * 60 * 1000));
  try {
    const traces = await engine.listRetrievalTracesByWindow({
      since,
      until,
      limit,
      offset: 0,
    });
    if (traces.length === 0) return null;
    const groundednessByTraceId = await retrievalGroundednessByTraceId(engine, since, until, limit);
    const scores = await Promise.all(traces.map(async (trace) =>
      scoreRetrievalTrajectory(trace, {
        evidence_texts: await retrievalTraceEvidenceTexts(engine, trace),
        groundedness: groundednessByTraceId.get(trace.id) ?? null,
      })));
    return summarizeRetrievalTrajectoryScores(scores);
  } catch {
    return null;
  }
}

async function collectMemoryStrength(
  engine: BrainEngine,
  generatedAt: string,
  limit: number,
): Promise<ReportMemoryStrength | null> {
  if (
    typeof (engine as Partial<BrainEngine>).listRetrievalTracesByWindow !== 'function'
    || typeof (engine as Partial<BrainEngine>).listPages !== 'function'
  ) {
    return null;
  }
  const until = new Date(generatedAt);
  if (!Number.isFinite(until.getTime())) return null;
  try {
    const report = await computeMemoryStrengthReport(engine, {
      now: until,
      limit: Math.min(10, Math.max(1, limit)),
    });
    // Without any retrieval traces every page is trivially "never used" — no signal.
    if (report.scanned_trace_count === 0) return null;
    return {
      window_days: report.window.window_days,
      formula: report.formula,
      totals: {
        pages_with_activity: report.totals.pages_with_activity,
        fading: report.totals.fading,
        never_used: report.totals.never_used,
      },
      top_strength: report.top_strength.map(toReportMemoryStrengthEntry),
      fading: report.fading.map(toReportMemoryStrengthEntry),
      never_used: report.never_used.map((page) => ({ slug: page.slug, title: page.title })),
    };
  } catch (error) {
    activeReportDataIntegrityErrors?.push({
      query: 'memory_strength',
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function toReportMemoryStrengthEntry(entry: MemoryStrengthEntry): ReportMemoryStrength['top_strength'][number] {
  return {
    slug: entry.slug,
    strength_score: entry.strength_score,
    confirmed_read_count: entry.confirmed_read_count,
    probe_selected_count: entry.probe_selected_count,
    answer_ready_count: entry.answer_ready_count,
    conflict_count: entry.conflict_count,
    last_read_at: entry.last_read_at,
  };
}

async function retrievalGroundednessByTraceId(
  engine: BrainEngine,
  since: Date,
  until: Date,
  limit: number,
): Promise<Map<string, number>> {
  if (typeof (engine as Partial<BrainEngine>).listContextEvalAssertions !== 'function') {
    return new Map();
  }
  const assertions = await engine.listContextEvalAssertions({
    limit: Math.max(100, limit * 20),
  });
  const out = new Map<string, number>();
  for (const assertion of assertions) {
    if (assertion.assertion_kind !== 'live_retrieval_quality') continue;
    if (!assertion.retrieval_trace_id) continue;
    if (out.has(assertion.retrieval_trace_id)) continue;
    if (assertion.created_at < since || assertion.created_at > until) continue;
    if (typeof assertion.score !== 'number' || !Number.isFinite(assertion.score)) continue;
    out.set(assertion.retrieval_trace_id, assertion.score);
  }
  return out;
}

async function retrievalTraceEvidenceTexts(
  engine: BrainEngine,
  trace: RetrievalTrace,
): Promise<string[]> {
  const slugs = [...new Set(trace.source_refs
    .map(slugFromRetrievalTraceSourceRef)
    .filter((slug): slug is string => Boolean(slug)))];
  const pages = await Promise.all(slugs.map(async (slug) => {
    try {
      return await engine.getPage(slug);
    } catch {
      return null;
    }
  }));
  return pages
    .map(pageEvidenceText)
    .filter((text): text is string => Boolean(text));
}

function pageEvidenceText(page: Page | null): string | null {
  if (!page) return null;
  const text = [page.compiled_truth, page.timeline]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n');
  return text.length > 0 ? text : null;
}

async function collectCanonicalTargetProposals(
  engine: BrainEngine,
  scopeId: string,
  limit: number,
): Promise<ReportCanonicalTargetProposal[]> {
  if (typeof (engine as Partial<BrainEngine>).listCanonicalTargetProposalEntries !== 'function') {
    return [];
  }
  try {
    const proposals = await engine.listCanonicalTargetProposalEntries({
      scope_id: scopeId,
      limit,
      offset: 0,
    });
    return proposals.map(canonicalTargetProposalToReportProposal);
  } catch {
    return [];
  }
}

async function collectMemoryWriteSessions(
  engine: BrainEngine,
  scopeId: string,
  limit: number,
): Promise<MemoryReviewReportInput['write_sessions']> {
  if (typeof (engine as Partial<BrainEngine>).listMemoryWriteSessions !== 'function') {
    return [];
  }
  const byId = new Map<string, NonNullable<MemoryReviewReportInput['write_sessions']>[number]>();
  for (const status of ['open', 'expired'] as const) {
    const sessions = await engine.listMemoryWriteSessions({
      scope_id: scopeId,
      status,
      limit,
      offset: 0,
    });
    for (const session of sessions) {
      byId.set(session.id, memoryWriteSessionToReportSession(session));
    }
  }
  return [...byId.values()];
}

async function collectCandidateDebtCanonicalTargetProposals(
  engine: BrainEngine,
  scopeId: string,
): Promise<ReportCanonicalTargetProposal[]> {
  if (typeof (engine as Partial<BrainEngine>).listCanonicalTargetProposalEntries !== 'function') {
    return [];
  }
  const proposalsById = new Map<string, ReportCanonicalTargetProposal>();
  try {
    for (const status of CANDIDATE_DEBT_PROPOSAL_STATUSES) {
      let offset = 0;
      while (true) {
        const previousSize = proposalsById.size;
        const page = await engine.listCanonicalTargetProposalEntries({
          scope_id: scopeId,
          status,
          limit: CANDIDATE_DEBT_PROPOSAL_PAGE_SIZE,
          offset,
        });
        for (const proposal of page) {
          proposalsById.set(proposal.id, canonicalTargetProposalToReportProposal(proposal));
        }
        if (
          page.length < CANDIDATE_DEBT_PROPOSAL_PAGE_SIZE
          || proposalsById.size === previousSize
        ) {
          break;
        }
        offset += page.length;
      }
    }
  } catch {
    return [];
  }
  return [...proposalsById.values()];
}

function canonicalTargetProposalToReportProposal(
  proposal: CanonicalTargetProposalEntry,
): ReportCanonicalTargetProposal {
  return {
    id: proposal.id,
    source_candidate_id: proposal.source_candidate_id,
    linked_candidate_ids: proposal.linked_candidate_ids,
    status: proposal.status,
    proposed_slug: proposal.proposed_slug,
    proposed_title: proposal.proposed_title,
    status_reason: proposal.status_reason,
    stub_patch_candidate_id: proposal.stub_patch_candidate_id,
    stub_patch_state: proposal.stub_patch_state,
    bound_candidate_ids: proposal.bound_candidate_ids,
  };
}

function memoryWriteSessionToReportSession(
  session: MemoryWriteSession,
): NonNullable<MemoryReviewReportInput['write_sessions']>[number] {
  return {
    id: session.id,
    route_decision_id: session.route_decision_id,
    status: session.status,
    target_slug: session.target_slug,
    expected_content_hash: session.expected_content_hash,
    source_refs: session.source_refs,
    route_decision: session.route_decision,
    intended_operation: session.intended_operation,
    actor: session.actor,
    scope_id: session.scope_id,
    created_at: session.created_at.toISOString(),
    expires_at: session.expires_at.toISOString(),
    consumed_at: session.consumed_at?.toISOString() ?? null,
    consumed_by_event_id: session.consumed_by_event_id,
    status_reason: session.status_reason,
  };
}

interface CanonicalHandoffCandidateState {
  handoff_candidate_ids: string[];
  completed_handoff_candidate_ids: string[];
}

async function collectCanonicalHandoffCandidateState(
  engine: BrainEngine,
  scopeId: string,
  candidates: MemoryCandidateEntry[],
): Promise<CanonicalHandoffCandidateState> {
  const ids = new Set<string>();
  const completedIds = new Set<string>();
  await Promise.all(candidates
    .filter((candidate) => candidate.status === 'promoted')
    .map(async (candidate) => {
      const handoffs = await engine.listCanonicalHandoffEntries({
        scope_id: scopeId,
        candidate_id: candidate.id,
        limit: 1,
        offset: 0,
      });
      if (handoffs.length > 0) ids.add(candidate.id);
      if (handoffs.some((handoff) => handoff.completed_at !== null)) completedIds.add(candidate.id);
    }));
  return {
    handoff_candidate_ids: [...ids],
    completed_handoff_candidate_ids: [...completedIds],
  };
}

function memoryMutationToCanonicalMemory(event: MemoryMutationEvent): ReportCanonicalMemory[] {
  if (event.dry_run || event.result !== 'applied') return [];
  if (!isCanonicalMemoryOperation(event.operation)) return [];
  return [
    {
      id: event.id,
      target_kind: event.target_kind,
      target_id: event.target_id,
      target_slug: event.target_kind === 'page' ? event.target_id : undefined,
      claim_type: event.target_kind,
      change_type: isCreateOperation(event.operation) ? 'created' : 'updated',
      // Human-readable "learned this period" delta, not the raw operation/target string.
      summary: `${isCreateOperation(event.operation) ? 'Learned' : 'Updated'} ${humanCanonicalKind(event.target_kind)}: ${event.target_id}`,
      source_refs: event.source_refs,
    },
  ];
}

function humanCanonicalKind(targetKind: string): string {
  switch (targetKind) {
    case 'page': return 'page';
    case 'profile_memory': return 'profile memory';
    case 'personal_episode': return 'personal episode';
    case 'memory_candidate': return 'candidate';
    case 'memory_patch_candidate': return 'patch candidate';
    default: return targetKind.replace(/_/g, ' ');
  }
}

function memoryCandidateToReviewItem(candidate: MemoryCandidateEntry): ReportReviewItem[] {
  if (isDeferredWritebackCandidate(candidate)) {
    return [
      {
        id: candidate.id,
        review_type: 'deferred_candidate',
        target_ref: candidate.target_object_id ?? candidate.target_object_type ?? undefined,
        summary: `Memory writeback is deferred (${candidate.candidate_type}; ${deferredWritebackSummary(candidate)}; content gated; resolve missing requirements before staging).`,
        severity: candidate.sensitivity === 'secret' ? 'high' : 'medium',
      },
    ];
  }
  if (!isReportableCandidateStatus(candidate.status)) return [];
  const sourceRefsCount = candidate.source_refs.filter((sourceRef) => sourceRef.trim().length > 0).length;
  if (candidate.status === 'candidate') {
    return [
      {
        id: candidate.id,
        review_type: 'candidate_staging',
        target_ref: candidate.target_object_id ?? candidate.target_object_type ?? undefined,
        summary: `Memory candidate is ready to stage for review (${candidate.candidate_type}; source_refs ${sourceRefsCount}; content gated; use read_candidate_context for explicit audited access).`,
        severity: candidate.sensitivity === 'secret' ? 'high' : 'medium',
      },
    ];
  }
  return [
    {
      id: candidate.id,
      review_type: candidate.candidate_type,
      target_ref: candidate.target_object_id ?? candidate.target_object_type ?? undefined,
      summary: `Memory candidate is staged for review (${candidate.candidate_type}; source_refs ${sourceRefsCount}; content gated; use read_candidate_context for explicit audited access).`,
      severity: candidate.sensitivity === 'secret' ? 'high' : 'medium',
    },
  ];
}

function memoryCandidateToDecisionProjectionCandidate(
  candidate: MemoryCandidateEntry,
): DecisionProjectionMemoryCandidate {
  return {
    id: candidate.id,
    proposed_content: '',
    status: candidate.status,
    target_object_type: candidate.target_object_type,
    target_object_id: candidate.target_object_id,
    source_refs: candidate.source_refs,
    review_reason: candidate.review_reason,
  };
}

function memoryMutationToPolicyDenial(event: MemoryMutationEvent): ReportPolicyDenial[] {
  if (event.result !== 'denied') return [];
  return [{
    id: event.id,
    reason: stringFromUnknown(event.conflict_info?.reason ?? event.metadata?.reason ?? event.operation),
    target_ref: `${event.target_kind}:${event.target_id}`,
  }];
}

function memoryMutationToConflict(event: MemoryMutationEvent): ReportConflict[] {
  if (event.result !== 'conflict') return [];
  return [{
    id: event.id,
    target_ref: `${event.target_kind}:${event.target_id}`,
    summary: stringFromUnknown(event.conflict_info?.reason ?? event.metadata?.reason ?? event.operation),
    severity: 'high',
  }];
}

function isCanonicalMemoryOperation(operation: MemoryMutationEvent['operation']): boolean {
  return operation === 'governed_canonical_write'
    || operation === 'put_page'
    || operation === 'upsert_profile_memory_entry'
    || operation === 'write_profile_memory_entry'
    || operation === 'record_personal_episode'
    || operation === 'write_personal_episode_entry'
    || operation === 'promote_memory_candidate_entry'
    || operation === 'apply_memory_patch_candidate';
}

function isCreateOperation(operation: MemoryMutationEvent['operation']): boolean {
  return operation === 'governed_canonical_write'
    || operation === 'write_profile_memory_entry'
    || operation === 'record_personal_episode'
    || operation === 'write_personal_episode_entry';
}

function isReportableCandidateStatus(status: MemoryCandidateEntry['status']): boolean {
  return status === 'candidate' || status === 'staged_for_review';
}

function isDeferredWritebackCandidate(candidate: MemoryCandidateEntry): boolean {
  return candidate.status === 'captured'
    && candidate.review_reason?.startsWith('route_memory_writeback_deferred:') === true;
}

function deferredWritebackSummary(candidate: MemoryCandidateEntry): string {
  const reason = candidate.review_reason?.replace(/^route_memory_writeback_deferred:/, '').trim();
  return reason && reason.length > 0 ? reason : 'missing requirements pending';
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function collectLifecycleStates(
  engine: BrainEngine,
  scopeId: string,
  limit: number,
): Promise<ReportLifecycleState[]> {
  try {
    const store = createLifecycleForgettingStoreForEngine(engine);
    const states = await store.listLifecycleStates({
      scope_id: scopeId,
      lifecycle_states: ['stale', 'expired', 'archived'],
      limit,
    });
    return states.map((state) => ({
      id: state.id,
      entity_type: state.entity_type,
      entity_id: state.entity_id,
      lifecycle_state: state.lifecycle_state,
      restore_until: state.restore_until,
      purge_after: state.purge_after,
      reason: state.reason,
    }));
  } catch {
    return [];
  }
}

async function collectPurgeCandidates(
  engine: BrainEngine,
  scopeId: string,
  now: string,
  limit: number,
): Promise<ReportLifecycleState[]> {
  try {
    const store = createLifecycleForgettingStoreForEngine(engine);
    const states = await store.listLifecycleStates({
      scope_id: scopeId,
      lifecycle_states: ['expired', 'archived'],
      purge_due_at: now,
      limit,
    });
    return states.map((state) => ({
      id: state.id,
      entity_type: state.entity_type,
      entity_id: state.entity_id,
      lifecycle_state: state.lifecycle_state,
      restore_until: state.restore_until,
      purge_after: state.purge_after,
      reason: state.reason,
    }));
  } catch {
    return [];
  }
}

async function collectProjectionTargets(engine: BrainEngine, limit: number): Promise<ReportProjectionTarget[]> {
  const rows = await queryRows(engine, `
    SELECT id, target_type, target_id, locator, status, canonical_changed_since_projection
    FROM canonical_projection_targets
    WHERE status IN ('pending_reconcile', 'failed', 'conflict')
       OR canonical_changed_since_projection = 1
    ORDER BY updated_at DESC, id ASC
    LIMIT ?
  `, [limit], `
    SELECT id, target_type, target_id, locator, status, canonical_changed_since_projection
    FROM canonical_projection_targets
    WHERE status IN ('pending_reconcile', 'failed', 'conflict')
       OR canonical_changed_since_projection = true
    ORDER BY updated_at DESC, id ASC
    LIMIT $1
  `);
  return rows.map((row) => ({
    id: stringFromUnknown(row.id),
    target_type: stringFromUnknown(row.target_type),
    target_id: stringFromUnknown(row.target_id),
    locator: stringFromUnknown(row.locator),
    status: projectionStatus(row.status),
    canonical_changed_since_projection: booleanFromUnknown(row.canonical_changed_since_projection),
  }));
}

async function collectSources(engine: BrainEngine, limit: number): Promise<ReportSource[]> {
  const rows = await queryRows(engine, `
    SELECT s.id, s.kind, s.display_name, s.consent_state, s.enabled,
           COALESCE(css.health_status,
             CASE WHEN s.consent_state IN ('revoked', 'denied') OR s.enabled = 0 THEN 'unhealthy' ELSE 'healthy' END
           ) AS health_status
    FROM sources s
    LEFT JOIN connector_accounts ca ON ca.source_id = s.id
    LEFT JOIN connector_sync_states css ON css.account_id = ca.id
    ORDER BY s.updated_at DESC, s.id ASC
    LIMIT ?
  `, [limit], `
    SELECT s.id, s.kind, s.display_name, s.consent_state, s.enabled,
           COALESCE(css.health_status,
             CASE WHEN s.consent_state IN ('revoked', 'denied') OR s.enabled = false THEN 'unhealthy' ELSE 'healthy' END
           ) AS health_status
    FROM sources s
    LEFT JOIN connector_accounts ca ON ca.source_id = s.id
    LEFT JOIN connector_sync_states css ON css.account_id = ca.id
    ORDER BY s.updated_at DESC, s.id ASC
    LIMIT $1
  `);
  return rows.map((row) => ({
    id: stringFromUnknown(row.id),
    kind: stringFromUnknown(row.kind),
    display_name: stringFromUnknown(row.display_name),
    consent_state: stringFromUnknown(row.consent_state),
    enabled: booleanFromUnknown(row.enabled),
    health_status: sourceHealthStatus(row.health_status),
  }));
}

async function collectSourceItems(engine: BrainEngine, limit: number): Promise<ReportSourceItem[]> {
  const rows = await queryRows(engine, `
    SELECT id, source_id, external_id, ingest_status
    FROM source_items
    ORDER BY ingested_at DESC, id ASC
    LIMIT ?
  `, [limit], `
    SELECT id, source_id, external_id, ingest_status
    FROM source_items
    ORDER BY ingested_at DESC, id ASC
    LIMIT $1
  `);
  return rows.map((row) => ({
    id: stringFromUnknown(row.id),
    source_id: stringFromUnknown(row.source_id),
    external_id: stringFromUnknown(row.external_id),
    status: sourceItemStatus(row.ingest_status),
  }));
}

async function collectExtractedClaims(engine: BrainEngine, limit: number): Promise<ReportExtractedClaim[]> {
  const rows = await queryRows(engine, `
    SELECT id, status, claim_type
    FROM extracted_claims
    ORDER BY created_at DESC, id ASC
    LIMIT ?
  `, [limit], `
    SELECT id, status, claim_type
    FROM extracted_claims
    ORDER BY created_at DESC, id ASC
    LIMIT $1
  `);
  return rows.map((row) => ({
    id: stringFromUnknown(row.id),
    status: stringFromUnknown(row.status),
    claim_type: stringFromUnknown(row.claim_type),
  }));
}

async function collectPolicyDenials(engine: BrainEngine, limit: number): Promise<ReportPolicyDenial[]> {
  const rows = await queryRows(engine, `
    SELECT id, policy_decision, policy_explanation, status
    FROM canonical_write_attempts
    WHERE policy_decision IN ('reject', 'quarantine', 'no_write')
       OR status IN ('failed_db', 'failed_markdown', 'conflict')
    ORDER BY created_at DESC, id ASC
    LIMIT ?
  `, [limit], `
    SELECT id, policy_decision, policy_explanation, status
    FROM canonical_write_attempts
    WHERE policy_decision IN ('reject', 'quarantine', 'no_write')
       OR status IN ('failed_db', 'failed_markdown', 'conflict')
    ORDER BY created_at DESC, id ASC
    LIMIT $1
  `);
  return rows.map((row) => ({
    id: stringFromUnknown(row.id),
    reason: stringFromUnknown(row.policy_explanation) || stringFromUnknown(row.policy_decision) || stringFromUnknown(row.status),
  }));
}

async function collectQuarantinedSources(engine: BrainEngine, limit: number): Promise<ReportQuarantinedSource[]> {
  const rows = await queryRows(engine, `
    SELECT sc.id, si.source_id, sc.prompt_injection_risk
    FROM source_chunks sc
    JOIN source_items si ON si.id = sc.source_item_id
    WHERE sc.prompt_injection_risk IN ('flagged', 'quarantined')
    ORDER BY sc.created_at DESC, sc.id ASC
    LIMIT ?
  `, [limit], `
    SELECT sc.id, si.source_id, sc.prompt_injection_risk
    FROM source_chunks sc
    JOIN source_items si ON si.id = sc.source_item_id
    WHERE sc.prompt_injection_risk IN ('flagged', 'quarantined')
    ORDER BY sc.created_at DESC, sc.id ASC
    LIMIT $1
  `);
  return rows.map((row) => ({
    id: stringFromUnknown(row.id),
    source_id: stringFromUnknown(row.source_id),
    reason: stringFromUnknown(row.prompt_injection_risk),
  }));
}

async function collectSecretDetections(engine: BrainEngine, limit: number): Promise<ReportSecretDetection[]> {
  const rows = await queryRows(engine, `
    SELECT sc.id, sc.source_item_id, sc.secret_risk
    FROM source_chunks sc
    WHERE sc.secret_risk IN ('flagged', 'detected', 'redacted')
    ORDER BY sc.created_at DESC, sc.id ASC
    LIMIT ?
  `, [limit], `
    SELECT sc.id, sc.source_item_id, sc.secret_risk
    FROM source_chunks sc
    WHERE sc.secret_risk IN ('flagged', 'detected', 'redacted')
    ORDER BY sc.created_at DESC, sc.id ASC
    LIMIT $1
  `);
  return rows.map((row) => ({
    id: stringFromUnknown(row.id),
    source_item_id: stringFromUnknown(row.source_item_id),
    kind: stringFromUnknown(row.secret_risk),
    severity: 'high',
  }));
}

async function collectConflicts(engine: BrainEngine, limit: number): Promise<ReportConflict[]> {
  const rows = await queryRows(engine, `
    SELECT id, target_type, target_id, property
    FROM conflict_sets
    WHERE status = 'open'
    ORDER BY updated_at DESC, id ASC
    LIMIT ?
  `, [limit], `
    SELECT id, target_type, target_id, property
    FROM conflict_sets
    WHERE status = 'open'
    ORDER BY updated_at DESC, id ASC
    LIMIT $1
  `);
  return rows.map((row) => ({
    id: stringFromUnknown(row.id),
    target_ref: `${stringFromUnknown(row.target_type)}:${stringFromUnknown(row.target_id)}#${stringFromUnknown(row.property)}`,
    summary: 'Open assertion conflict requires review.',
    severity: 'high',
  }));
}

async function collectRunnerJobs(engine: BrainEngine, limit: number): Promise<ReportRunnerJob[]> {
  const [durableRows, legacyRows] = await Promise.all([
    queryRows(engine, `
      SELECT id, memory_job_id, task_type, status, failure_class, token_usage_json, cost_estimate_usd
      FROM runner_jobs
      ORDER BY updated_at DESC, id ASC
      LIMIT ?
    `, [limit], `
      SELECT id, memory_job_id, task_type, status, failure_class, token_usage_json, cost_estimate_usd
      FROM runner_jobs
      ORDER BY updated_at DESC, id ASC
      LIMIT $1
    `, { optional_missing_table: true }),
    queryRows(engine, `
    SELECT id, name, status, failure_class, payload_json, result_json
    FROM memory_jobs
    WHERE name LIKE 'runner:%'
       OR json_extract(payload_json, '$.task_type') IS NOT NULL
    ORDER BY updated_at DESC, id ASC
    LIMIT ?
  `, [limit], `
    SELECT id, name, status, failure_class, payload_json, result_json
    FROM memory_jobs
    WHERE name LIKE 'runner:%'
       OR payload_json ? 'task_type'
    ORDER BY updated_at DESC, id ASC
    LIMIT $1
  `),
  ]);

  const durableMemoryJobIds = new Set(
    durableRows.map((row) => nullableString(row.memory_job_id)).filter((id): id is string => Boolean(id)),
  );
  const durableJobs = durableRows.map((row) => {
    const tokenUsage = jsonObject(row.token_usage_json);
    return {
      id: stringFromUnknown(row.id),
      memory_job_id: nullableString(row.memory_job_id) ?? undefined,
      task_type: stringFromUnknown(row.task_type),
      status: runnerStatus(row.status),
      failure_class: nullableString(row.failure_class) ?? undefined,
      token_usage_json: {
        input_tokens: numberFromUnknown(tokenUsage.input_tokens),
        output_tokens: numberFromUnknown(tokenUsage.output_tokens),
        total_tokens: numberFromUnknown(tokenUsage.total_tokens),
      },
      cost_estimate_usd: numberFromUnknown(row.cost_estimate_usd),
    };
  });
  const legacyJobs = legacyRows
    .filter((row) => !durableMemoryJobIds.has(stringFromUnknown(row.id)))
    .map((row) => {
      const payload = jsonObject(row.payload_json);
      const result = jsonObject(row.result_json);
      const tokenUsage = jsonObject(payload.token_usage_json ?? result.token_usage_json);
      return {
        id: stringFromUnknown(row.id),
        memory_job_id: stringFromUnknown(row.id),
        task_type: stringFromUnknown(payload.task_type) || stringFromUnknown(row.name),
        status: runnerStatus(row.status),
        failure_class: nullableString(row.failure_class) ?? undefined,
        token_usage_json: {
          input_tokens: numberFromUnknown(tokenUsage.input_tokens),
          output_tokens: numberFromUnknown(tokenUsage.output_tokens),
          total_tokens: numberFromUnknown(tokenUsage.total_tokens),
        },
        cost_estimate_usd: numberFromUnknown(payload.cost_estimate_usd ?? result.cost_estimate_usd),
      };
    });

  return [...durableJobs, ...legacyJobs].slice(0, limit);
}

async function collectMaintenanceJobs(engine: BrainEngine, limit: number): Promise<ReportMaintenanceJob[]> {
  const rows = await queryRows(engine, `
    SELECT id, name, status, failure_class
    FROM memory_jobs
    WHERE status IN ('failed', 'dead')
      AND name NOT LIKE 'runner:%'
      AND json_extract(payload_json, '$.task_type') IS NULL
    ORDER BY updated_at DESC, id ASC
    LIMIT ?
  `, [limit], `
    SELECT id, name, status, failure_class
    FROM memory_jobs
    WHERE status IN ('failed', 'dead')
      AND name NOT LIKE 'runner:%'
      AND NOT (payload_json ? 'task_type')
    ORDER BY updated_at DESC, id ASC
    LIMIT $1
  `);
  return rows.map((row) => ({
    id: stringFromUnknown(row.id),
    name: stringFromUnknown(row.name),
    status: stringFromUnknown(row.status),
    failure_class: nullableString(row.failure_class) ?? undefined,
  }));
}

async function collectConnectorHealth(engine: BrainEngine, limit: number): Promise<ReportConnectorHealth[]> {
  const rows = await queryRows(engine, `
    SELECT ca.connector_id, ca.id AS account_id,
           COALESCE(css.health_status, cr.health_status, 'unknown') AS health_status,
           COALESCE(cr.rotation_status, 'current') AS credential_status,
           css.last_success_at,
           css.last_failure_at,
           COALESCE(css.failure_count, 0) AS failure_count,
           css.last_error
    FROM connector_accounts ca
    LEFT JOIN credential_refs cr ON cr.id = ca.credential_ref_id
    LEFT JOIN connector_sync_states css ON css.account_id = ca.id
    ORDER BY ca.updated_at DESC, ca.id ASC
    LIMIT ?
  `, [limit], `
    SELECT ca.connector_id, ca.id AS account_id,
           COALESCE(css.health_status, cr.health_status, 'unknown') AS health_status,
           COALESCE(cr.rotation_status, 'current') AS credential_status,
           css.last_success_at,
           css.last_failure_at,
           COALESCE(css.failure_count, 0) AS failure_count,
           css.last_error
    FROM connector_accounts ca
    LEFT JOIN credential_refs cr ON cr.id = ca.credential_ref_id
    LEFT JOIN connector_sync_states css ON css.account_id = ca.id
    ORDER BY ca.updated_at DESC, ca.id ASC
    LIMIT $1
  `);
  return rows.map((row) => ({
    connector_id: stringFromUnknown(row.connector_id),
    account_id: stringFromUnknown(row.account_id),
    health_status: connectorHealthStatus(row.health_status),
    credential_status: credentialStatus(row.credential_status),
    last_success_at: nullableString(row.last_success_at),
    last_failure_at: nullableString(row.last_failure_at),
    failure_count: numberFromUnknown(row.failure_count) ?? 0,
    last_error: nullableString(row.last_error),
  }));
}

async function collectFailedTaskAttempts(
  engine: BrainEngine,
  scopeId: string,
  limit: number,
): Promise<DecisionProjectionTaskAttempt[]> {
  const taskScope = taskScopeForReportScope(scopeId);
  if (!taskScope) return [];
  const rows = await queryRows(engine, `
    SELECT ta.id, ta.task_id, ta.summary, ta.outcome, ta.applicability_context, ta.evidence, ta.created_at
    FROM task_attempts ta
    JOIN task_threads tt ON tt.id = ta.task_id
    WHERE ta.outcome = 'failed'
      AND tt.scope = ?
    ORDER BY ta.created_at DESC, ta.id ASC
    LIMIT ?
  `, [taskScope, limit], `
    SELECT ta.id, ta.task_id, ta.summary, ta.outcome, ta.applicability_context, ta.evidence, ta.created_at
    FROM task_attempts ta
    JOIN task_threads tt ON tt.id = ta.task_id
    WHERE ta.outcome = 'failed'
      AND tt.scope = $1
    ORDER BY ta.created_at DESC, ta.id ASC
    LIMIT $2
  `);
  return rows.map((row) => ({
    id: stringFromUnknown(row.id),
    task_id: stringFromUnknown(row.task_id),
    summary: stringFromUnknown(row.summary),
    outcome: 'failed',
    applicability_context: jsonObject(row.applicability_context),
    evidence: jsonStringArray(row.evidence),
    created_at: stringFromUnknown(row.created_at),
  }));
}

function taskScopeForReportScope(scopeId: string): 'work' | 'personal' | null {
  if (scopeId.startsWith('personal:')) return 'personal';
  if (scopeId.startsWith('workspace:')) return 'work';
  return null;
}

async function queryRows(
  engine: BrainEngine,
  sqliteSql: string,
  params: unknown[],
  postgresSql = sqliteSql,
  options: { optional_missing_table?: boolean } = {},
): Promise<Record<string, unknown>[]> {
  try {
    const candidate = engine as BrainEngine & {
      database?: { query<T = Record<string, unknown>>(sql: string): { all(...params: unknown[]): T[] } };
      db?: { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
      sql?: { unsafe(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> };
    };
    if (candidate.database) {
      return candidate.database.query<Record<string, unknown>>(sqliteSql).all(...params);
    }
    if (candidate.db) {
      return (await candidate.db.query(postgresSql, params)).rows;
    }
    if (candidate.sql?.unsafe) {
      return await candidate.sql.unsafe(postgresSql, params);
    }
  } catch (error) {
    if (options.optional_missing_table === true && isMissingTableError(error)) {
      return [];
    }
    activeReportDataIntegrityErrors?.push({
      query: reportQueryLabel(postgresSql),
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
  return [];
}

function reportQueryLabel(sql: string): string {
  const normalized = sql.trim().replace(/\s+/g, ' ');
  const match = normalized.match(/\bFROM\s+([a-zA-Z0-9_]+)/i);
  return match?.[1] ?? normalized.slice(0, 80);
}

function isMissingTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table|does not exist|undefined_table/i.test(message);
}

function projectionStatus(value: unknown): ReportProjectionTarget['status'] {
  const status = stringFromUnknown(value);
  if (status === 'applied' || status === 'pending_reconcile' || status === 'reconciled' || status === 'failed' || status === 'conflict') {
    return status;
  }
  return 'failed';
}

function sourceHealthStatus(value: unknown): NonNullable<ReportSource['health_status']> {
  const status = stringFromUnknown(value);
  if (status === 'healthy' || status === 'unhealthy' || status === 'unknown') return status;
  return 'unknown';
}

function connectorHealthStatus(value: unknown): ReportConnectorHealth['health_status'] {
  const status = stringFromUnknown(value);
  if (status === 'healthy' || status === 'unhealthy' || status === 'expired' || status === 'unknown') return status;
  if (status === 'revoked' || status === 'paused') return 'unhealthy';
  return 'unknown';
}

function credentialStatus(value: unknown): ReportConnectorHealth['credential_status'] {
  const status = stringFromUnknown(value);
  if (status === 'current' || status === 'rotation_due' || status === 'rotating' || status === 'revoked') return status;
  return 'current';
}

function sourceItemStatus(value: unknown): ReportSourceItem['status'] {
  const status = stringFromUnknown(value);
  if (status === 'ready') return 'ingested';
  if (status === 'failed') return 'failed';
  return 'skipped';
}

function runnerStatus(value: unknown): ReportRunnerJob['status'] {
  const status = stringFromUnknown(value);
  if (status === 'queued' || status === 'running' || status === 'succeeded' || status === 'degraded' || status === 'cancelled') return status;
  if (status === 'waiting' || status === 'delayed') return 'queued';
  if (status === 'active') return 'running';
  if (status === 'completed') return 'succeeded';
  if (status === 'failed' || status === 'dead') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return 'degraded';
}

function stringFromUnknown(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return value == null ? '' : String(value);
}

function nullableString(value: unknown): string | null {
  const stringValue = stringFromUnknown(value);
  return stringValue ? stringValue : null;
}

function booleanFromUnknown(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function numberFromUnknown(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const numberValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function jsonStringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => stringFromUnknown(item)).filter((item) => item.length > 0);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.map((item) => stringFromUnknown(item)).filter((item) => item.length > 0)
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

function printMemoryReportHelp(): void {
  console.log(`mbrain memory-report -- show the memory review report surface

USAGE
  mbrain memory-report [--json] [--save] [--report-dir <brain>] [--scope-id <scope>] [--limit <n>] [--now <iso>]
`);
}
