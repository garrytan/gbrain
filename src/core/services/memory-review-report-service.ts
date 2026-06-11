import type { CandidateDebtMetrics, NegativeMemoryProjection } from '../types.ts';

// Above this many staged-for-review candidates, the backlog gets a prominent
// warning in both the memory report and `mbrain doctor`.
export const MEMORY_INBOX_REVIEW_PRESSURE_THRESHOLD = 50;

export type ReportHealthStatus = 'ok' | 'warn' | 'fail';
export type ReportActionKind =
  | 'undo'
  | 'restore'
  | 'pin'
  | 'reject'
  | 'pause_source'
  | 'revoke_source'
  | 'purge'
  | 'adjust_policy'
  | 'approve_candidate'
  | 'resolve_conflict'
  | 'rerun_failed_job'
  | 'open_audit_trail';

export interface ReportCanonicalMemory {
  id: string;
  target_kind?: string;
  target_id?: string;
  target_slug?: string;
  claim_type?: string;
  change_type: 'created' | 'updated';
  summary: string;
  source_refs?: string[];
}

export interface ReportProjectionTarget {
  id: string;
  target_type: string;
  target_id: string;
  locator: string;
  status: 'applied' | 'pending_reconcile' | 'reconciled' | 'failed' | 'conflict';
  canonical_changed_since_projection?: boolean;
}

export interface ReportLifecycleState {
  id: string;
  entity_type: string;
  entity_id: string;
  lifecycle_state: 'active' | 'stale' | 'expired' | 'archived' | 'purged';
  restore_until?: string | null;
  purge_after?: string | null;
  reason?: string;
}

export interface ReportPurgeCandidate {
  id: string;
  entity_type: string;
  entity_id: string;
  purge_after?: string | null;
  reason?: string;
}

export interface ReportReviewItem {
  id: string;
  review_type: 'candidate' | 'conflict' | 'policy_denial' | string;
  target_ref?: string;
  summary: string;
  severity: 'low' | 'medium' | 'high';
}

export interface ReportConflict {
  id: string;
  target_ref: string;
  summary: string;
  severity: 'low' | 'medium' | 'high';
}

export interface ReportSource {
  id: string;
  kind: string;
  display_name?: string;
  consent_state?: string;
  enabled?: boolean;
  health_status?: 'healthy' | 'unhealthy' | 'unknown';
}

export interface ReportSourceItem {
  id: string;
  source_id: string;
  external_id: string;
  status: 'ingested' | 'skipped' | 'failed';
}

export interface ReportExtractedClaim {
  id: string;
  status: string;
  claim_type?: string;
}

export interface ReportPolicyDenial {
  id: string;
  reason: string;
  target_ref?: string;
}

export interface ReportQuarantinedSource {
  id: string;
  source_id: string;
  reason: string;
}

export interface ReportSecretDetection {
  id: string;
  source_item_id: string;
  kind: string;
  severity: 'low' | 'medium' | 'high';
}

export interface ReportRunnerJob {
  id: string;
  memory_job_id?: string;
  task_type: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'degraded' | 'cancelled';
  failure_class?: string;
  token_usage_json?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  cost_estimate_usd?: number;
}

export type ReportSafetyStateCategory =
  | 'trust'
  | 'source'
  | 'contradiction'
  | 'negative_memory'
  | 'freshness'
  | 'runner'
  | 'redaction';

export type ReportSafetyStateStatus = 'ok' | 'warn' | 'not_instrumented';

export interface ReportSafetyState {
  category: ReportSafetyStateCategory;
  status: ReportSafetyStateStatus;
  count: number;
  reason_codes: string[];
  sample_ids: string[];
  report_only: true;
  canonical_write_allowed: false;
}

export interface ReportMaintenanceJob {
  id: string;
  name: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | string;
  failure_class?: string;
}

export interface ReportConnectorHealth {
  connector_id: string;
  account_id: string;
  health_status: 'healthy' | 'unhealthy' | 'expired' | 'unknown';
  credential_status: 'current' | 'rotation_due' | 'rotating' | 'revoked';
}

export interface AutoPromoteReportSummary {
  auto_promoted: number;
  canonical_handoffs?: number;
  canonical_writes?: number;
  escalated: number;
  deferred: number;
  excluded: number;
  generated_at: string;
}

export interface MemoryReviewReportInput {
  scope_id: string;
  generated_at: string;
  canonical_memories?: ReportCanonicalMemory[];
  projection_targets?: ReportProjectionTarget[];
  lifecycle_states?: ReportLifecycleState[];
  purge_candidates?: ReportPurgeCandidate[];
  review_items?: ReportReviewItem[];
  conflicts?: ReportConflict[];
  sources?: ReportSource[];
  source_items?: ReportSourceItem[];
  extracted_claims?: ReportExtractedClaim[];
  policy_denials?: ReportPolicyDenial[];
  quarantined_sources?: ReportQuarantinedSource[];
  secret_detections?: ReportSecretDetection[];
  runner_jobs?: ReportRunnerJob[];
  jobs?: ReportMaintenanceJob[];
  connector_health?: ReportConnectorHealth[];
  auto_promote_summary?: AutoPromoteReportSummary;
  candidate_debt?: CandidateDebtMetrics;
  negative_memory_projections?: NegativeMemoryProjection[];
}

export interface SourceIngestSummary {
  source_id: string;
  ingested: number;
  skipped: number;
  failed: number;
}

export interface CountByStatus {
  status: string;
  count: number;
}

export interface RunnerUsageSummary {
  total_input_tokens: number;
  total_output_tokens: number;
  total_estimated_cost_usd: number;
  failed_runner_jobs: number;
}

export interface MemoryReportAction {
  kind: ReportActionKind;
  target_kind: string;
  target_id: string;
  route: 'governed_operation';
  operation: string;
  params: Record<string, unknown>;
  requires_mutation_ledger: true;
}

export interface MemoryReviewReportSummary {
  new_canonical_memories: number;
  updated_canonical_memories: number;
  updated_projections: number;
  stale_projections: number;
  pending_projections: number;
  stale_memories: number;
  expired_memories: number;
  archived_memories: number;
  purge_candidates: number;
  review_items: number;
  conflicts: number;
  policy_denials: number;
  quarantined_sources: number;
  secret_detections: number;
  failed_jobs: number;
  reconciliation_failures: number;
  unhealthy_sources: number;
  unhealthy_connectors: number;
  candidate_missing_provenance: number;
  candidate_promoted_without_handoff: number;
  candidate_unresolved_exposed: number;
}

export interface ProjectionFreshnessSummary {
  total_exception_count: number;
  pending_reconcile_count: number;
  failed_count: number;
  conflict_count: number;
  stale_count: number;
}

export interface MaintenanceHealthSummary {
  candidate_debt: CandidateDebtMetrics;
  projection_freshness: ProjectionFreshnessSummary;
}

export interface MemoryReviewReport {
  scope_id: string;
  generated_at: string;
  health: {
    status: ReportHealthStatus;
    reasons: string[];
  };
  summary: MemoryReviewReportSummary;
  sections: {
    canonical_memories: ReportCanonicalMemory[];
    projection_targets: ReportProjectionTarget[];
    lifecycle_states: ReportLifecycleState[];
    purge_candidates: ReportPurgeCandidate[];
    review_items: ReportReviewItem[];
    conflicts: ReportConflict[];
    source_ingest: { by_source: SourceIngestSummary[] };
    extraction: { by_status: CountByStatus[] };
    policy_denials: ReportPolicyDenial[];
    quarantined_sources: ReportQuarantinedSource[];
    secret_detections: ReportSecretDetection[];
    runner_usage: RunnerUsageSummary;
    failed_jobs: Array<ReportRunnerJob | ReportMaintenanceJob>;
    source_health: ReportSource[];
    connector_health: ReportConnectorHealth[];
    safety_states: ReportSafetyState[];
    maintenance_health: MaintenanceHealthSummary;
  };
  actions: MemoryReportAction[];
  auto_promote_summary?: AutoPromoteReportSummary;
}

export function buildMemoryReviewReport(input: MemoryReviewReportInput): MemoryReviewReport {
  const canonicalMemories = redactReportValues(input.canonical_memories ?? []);
  const projectionTargets = redactReportValues(input.projection_targets ?? []);
  const lifecycleStates = redactReportValues(input.lifecycle_states ?? []);
  const purgeCandidates = redactReportValues(input.purge_candidates ?? []);
  const reviewItems = redactReportValues(input.review_items ?? []);
  const conflicts = redactReportValues(input.conflicts ?? []);
  const sources = redactReportValues(input.sources ?? []);
  const sourceItems = redactReportValues(input.source_items ?? []);
  const extractedClaims = redactReportValues(input.extracted_claims ?? []);
  const policyDenials = redactReportValues(input.policy_denials ?? []);
  const quarantinedSources = redactReportValues(input.quarantined_sources ?? []);
  const secretDetections = redactReportValues(input.secret_detections ?? []);
  const runnerJobs = redactReportValues(input.runner_jobs ?? []);
  const jobs = redactReportValues(input.jobs ?? []);
  const connectorHealth = redactReportValues(input.connector_health ?? []);

  const failedRunnerJobs = runnerJobs.filter((job) => job.status === 'failed' || job.status === 'degraded');
  const failedMaintenanceJobs = jobs.filter((job) => job.status === 'failed' || job.status === 'dead');
  const reconciliationFailures = projectionTargets.filter((target) => target.status === 'failed' || target.status === 'conflict');
  const unhealthySources = sources.filter((source) => source.health_status === 'unhealthy');
  const failedSourceItems = sourceItems.filter((item) => item.status === 'failed');
  const unhealthyConnectors = connectorHealth.filter(
    (connector) => connector.health_status !== 'healthy' || connector.credential_status === 'revoked',
  );
  const candidateDebt = input.candidate_debt ?? emptyCandidateDebtMetrics();
  const projectionFreshness = summarizeProjectionFreshness(projectionTargets);
  const safetyStates = buildReportOnlySafetyStates({
    policyDenials,
    unhealthySources,
    failedSourceItems,
    unhealthyConnectors,
    conflicts,
    negativeMemoryProjections: input.negative_memory_projections,
    lifecycleStates,
    projectionTargets,
    failedRunnerJobs,
    quarantinedSources,
    secretDetections,
  });

  const summary: MemoryReviewReportSummary = {
    new_canonical_memories: canonicalMemories.filter((memory) => memory.change_type === 'created').length,
    updated_canonical_memories: canonicalMemories.filter((memory) => memory.change_type === 'updated').length,
    updated_projections: projectionTargets.filter((target) => target.canonical_changed_since_projection).length,
    stale_projections: projectionFreshness.stale_count,
    pending_projections: projectionFreshness.pending_reconcile_count,
    stale_memories: lifecycleStates.filter((state) => state.lifecycle_state === 'stale').length,
    expired_memories: lifecycleStates.filter((state) => state.lifecycle_state === 'expired').length,
    archived_memories: lifecycleStates.filter((state) => state.lifecycle_state === 'archived').length,
    purge_candidates: purgeCandidates.length,
    review_items: reviewItems.length,
    conflicts: conflicts.length,
    policy_denials: policyDenials.length,
    quarantined_sources: quarantinedSources.length,
    secret_detections: secretDetections.length,
    failed_jobs: failedRunnerJobs.length + failedMaintenanceJobs.length,
    reconciliation_failures: reconciliationFailures.length,
    unhealthy_sources: unhealthySources.length,
    unhealthy_connectors: unhealthyConnectors.length,
    candidate_missing_provenance: candidateDebt.missing_provenance_count,
    candidate_promoted_without_handoff: candidateDebt.stale_promoted_without_handoff_count,
    candidate_unresolved_exposed: candidateDebt.unresolved_exposed_count,
  };

  return {
    scope_id: input.scope_id,
    generated_at: input.generated_at,
    health: buildReportHealth(summary),
    summary,
    sections: {
      canonical_memories: canonicalMemories,
      projection_targets: projectionTargets,
      lifecycle_states: lifecycleStates,
      purge_candidates: purgeCandidates,
      review_items: reviewItems,
      conflicts,
      source_ingest: { by_source: summarizeSourceIngest(sourceItems) },
      extraction: { by_status: countByStatus(extractedClaims.map((claim) => claim.status)) },
      policy_denials: policyDenials,
      quarantined_sources: quarantinedSources,
      secret_detections: secretDetections,
      runner_usage: summarizeRunnerUsage(runnerJobs),
      failed_jobs: [...failedRunnerJobs, ...failedMaintenanceJobs],
      source_health: sources,
      connector_health: connectorHealth,
      safety_states: safetyStates,
      maintenance_health: {
        candidate_debt: candidateDebt,
        projection_freshness: projectionFreshness,
      },
    },
    actions: buildReportActions({
      scopeId: input.scope_id,
      canonicalMemories,
      lifecycleStates,
      purgeCandidates,
      reviewItems,
      conflicts,
      failedJobs: [...failedRunnerJobs, ...failedMaintenanceJobs],
      sources: unhealthySources,
      policyDenials,
    }),
    ...(input.auto_promote_summary !== undefined ? { auto_promote_summary: input.auto_promote_summary } : {}),
  };
}

export function formatMemoryReviewReport(report: MemoryReviewReport): string {
  const lines = [
    'Memory Review Report',
    `Scope: ${report.scope_id}`,
    `Generated: ${report.generated_at}`,
    `Health: ${report.health.status}`,
  ];

  if (report.summary.review_items >= MEMORY_INBOX_REVIEW_PRESSURE_THRESHOLD) {
    lines.push(
      '',
      `WARNING: review backlog pressure — ${report.summary.review_items} candidates are staged for review (threshold ${MEMORY_INBOX_REVIEW_PRESSURE_THRESHOLD}).`,
      'Promote, reject, or supersede staged candidates before the backlog drifts further.',
    );
  }

  if (isEmptyReport(report)) {
    lines.push('', 'No reportable memory exceptions.');
  } else {
    lines.push('', 'Summary');
    for (const [key, value] of Object.entries(report.summary)) {
      if (value > 0) lines.push(`- ${key}: ${value}`);
    }

    if (report.sections.canonical_memories.length > 0) {
      lines.push('', 'Canonical Memories');
      for (const memory of report.sections.canonical_memories) {
        lines.push(`- ${memory.id}: ${redactSecrets(memory.summary)}`);
      }
    }

    if (report.actions.length > 0) {
      lines.push('', 'Actions');
      for (const action of report.actions) {
        lines.push(`- ${action.kind}: ${action.target_kind}/${action.target_id} via ${action.route}`);
      }
    }
  }

  if (hasMaintenanceHealthSignals(report.sections.maintenance_health)) {
    const candidateDebt = report.sections.maintenance_health.candidate_debt;
    const projectionFreshness = report.sections.maintenance_health.projection_freshness;
    lines.push('', 'Maintenance Health');
    lines.push(`- Candidate debt: visible ${candidateDebt.visible_candidate_count} | missing provenance ${candidateDebt.missing_provenance_count} | promoted without handoff ${candidateDebt.stale_promoted_without_handoff_count} | unresolved exposed ${candidateDebt.unresolved_exposed_count}`);
    lines.push(`- Projection freshness: pending ${projectionFreshness.pending_reconcile_count} | failed ${projectionFreshness.failed_count} | conflict ${projectionFreshness.conflict_count} | stale ${projectionFreshness.stale_count}`);
  }

  if (hasSafetyStateSignals(report.sections.safety_states)) {
    lines.push('', 'Safety States (report-only)');
    for (const state of report.sections.safety_states.filter((entry) => entry.status === 'warn' && entry.count > 0)) {
      lines.push(`- ${formatSafetyStateCategory(state.category)}: ${state.count} | ${state.reason_codes.join(', ')} | canonical writes blocked`);
    }
  }

  if (report.auto_promote_summary) {
    const s = report.auto_promote_summary;
    lines.push('', 'Auto-promotion (non-blocking)');
    lines.push(`- Inbox-promoted: ${s.auto_promoted} | canonical handoffs: ${s.canonical_handoffs ?? 0} | canonical writes: ${s.canonical_writes ?? 0} | escalated: ${s.escalated} | deferred: ${s.deferred} | excluded: ${s.excluded}`);
    lines.push('- Review any promoted-without-write or skipped canonicalization items before they become stale.');
  }

  return lines.join('\n');
}

function buildReportOnlySafetyStates(input: {
  policyDenials: ReportPolicyDenial[];
  unhealthySources: ReportSource[];
  failedSourceItems: ReportSourceItem[];
  unhealthyConnectors: ReportConnectorHealth[];
  conflicts: ReportConflict[];
  negativeMemoryProjections?: NegativeMemoryProjection[];
  lifecycleStates: ReportLifecycleState[];
  projectionTargets: ReportProjectionTarget[];
  failedRunnerJobs: ReportRunnerJob[];
  quarantinedSources: ReportQuarantinedSource[];
  secretDetections: ReportSecretDetection[];
}): ReportSafetyState[] {
  const sourceIds = [
    ...input.unhealthySources.map((source) => source.id),
    ...input.failedSourceItems.map((item) => item.id),
    ...input.unhealthyConnectors.map((connector) => connector.account_id),
  ];
  const freshnessIds = [
    ...input.lifecycleStates
      .filter((state) => state.lifecycle_state === 'stale' || state.lifecycle_state === 'expired')
      .map((state) => state.id),
    ...input.projectionTargets
      .filter((target) =>
        target.status === 'pending_reconcile'
        || target.status === 'failed'
        || target.status === 'conflict'
        || target.canonical_changed_since_projection === true
      )
      .map((target) => target.id),
  ];
  const negativeMemoryBlocks = input.negativeMemoryProjections?.filter((entry) =>
    entry.activation === 'suppress_if_valid' && entry.suppression_applies === true
  );

  return [
    safetyState('trust', input.policyDenials.length, ['policy_denials_present'], input.policyDenials.map((denial) => denial.id)),
    safetyState('source', sourceIds.length, ['source_review_required'], sourceIds),
    safetyState('contradiction', input.conflicts.length, ['unresolved_conflicts_present'], input.conflicts.map((conflict) => conflict.id)),
    negativeMemoryBlocks === undefined
      ? notInstrumentedSafetyState('negative_memory', ['negative_memory_report_input_missing'])
      : safetyState('negative_memory', negativeMemoryBlocks.length, ['negative_memory_blocks_present'], negativeMemoryBlocks.map((entry) => entry.id)),
    safetyState('freshness', freshnessIds.length, ['freshness_review_required'], freshnessIds),
    safetyState('runner', input.failedRunnerJobs.length, ['runner_failures_present'], input.failedRunnerJobs.map((job) => job.id)),
    safetyState('redaction', input.quarantinedSources.length + input.secretDetections.length, ['redaction_review_required'], [
      ...input.quarantinedSources.map((source) => source.id),
      ...input.secretDetections.map((detection) => detection.id),
    ]),
  ];
}

function safetyState(
  category: ReportSafetyStateCategory,
  count: number,
  warnReasonCodes: string[],
  ids: string[],
): ReportSafetyState {
  return {
    category,
    status: count > 0 ? 'warn' : 'ok',
    count,
    reason_codes: count > 0 ? warnReasonCodes : ['no_reportable_signal'],
    sample_ids: sampleIds(ids),
    report_only: true,
    canonical_write_allowed: false,
  };
}

function notInstrumentedSafetyState(
  category: ReportSafetyStateCategory,
  reasonCodes: string[],
): ReportSafetyState {
  return {
    category,
    status: 'not_instrumented',
    count: 0,
    reason_codes: reasonCodes,
    sample_ids: [],
    report_only: true,
    canonical_write_allowed: false,
  };
}

function hasSafetyStateSignals(states: ReportSafetyState[]): boolean {
  return states.some((state) => state.status === 'warn' && state.count > 0);
}

function sampleIds(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => id.length > 0))].slice(0, 3);
}

function formatSafetyStateCategory(category: ReportSafetyStateCategory): string {
  return category
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function buildReportHealth(summary: MemoryReviewReportSummary): MemoryReviewReport['health'] {
  const reasons: string[] = [];
  if (summary.failed_jobs > 0) reasons.push(`${summary.failed_jobs} failed jobs`);
  if (summary.reconciliation_failures > 0) reasons.push(`${summary.reconciliation_failures} reconciliation failures`);
  if (summary.pending_projections > 0) reasons.push(`${summary.pending_projections} pending projections`);
  if (summary.stale_projections > 0) reasons.push(`${summary.stale_projections} stale projections`);
  if (summary.unhealthy_sources > 0) reasons.push(`${summary.unhealthy_sources} unhealthy sources`);
  if (summary.unhealthy_connectors > 0) reasons.push(`${summary.unhealthy_connectors} unhealthy connectors`);
  if (summary.secret_detections > 0) reasons.push(`${summary.secret_detections} secret detections`);
  if (summary.conflicts > 0) reasons.push(`${summary.conflicts} conflicts`);
  if (summary.candidate_missing_provenance > 0) reasons.push(`${summary.candidate_missing_provenance} candidates missing provenance`);
  if (summary.candidate_promoted_without_handoff > 0) reasons.push(`${summary.candidate_promoted_without_handoff} promoted candidates without handoff`);
  if (summary.candidate_unresolved_exposed > 0) reasons.push(`${summary.candidate_unresolved_exposed} unresolved exposed candidates`);

  return {
    status: reasons.length === 0 ? 'ok' : summary.failed_jobs > 0 || summary.reconciliation_failures > 0 ? 'fail' : 'warn',
    reasons,
  };
}

function summarizeSourceIngest(items: ReportSourceItem[]): SourceIngestSummary[] {
  const bySource = new Map<string, SourceIngestSummary>();
  for (const item of items) {
    let summary = bySource.get(item.source_id);
    if (!summary) {
      summary = { source_id: item.source_id, ingested: 0, skipped: 0, failed: 0 };
      bySource.set(item.source_id, summary);
    }
    summary[item.status] += 1;
  }
  return [...bySource.values()];
}

function countByStatus(statuses: string[]): CountByStatus[] {
  const counts = new Map<string, number>();
  for (const status of statuses) {
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => ({ status, count }));
}

function summarizeRunnerUsage(jobs: ReportRunnerJob[]): RunnerUsageSummary {
  const totals = jobs.reduce(
    (summary, job) => ({
      total_input_tokens: summary.total_input_tokens + (job.token_usage_json?.input_tokens ?? 0),
      total_output_tokens: summary.total_output_tokens + (job.token_usage_json?.output_tokens ?? 0),
      total_estimated_cost_usd: summary.total_estimated_cost_usd + (job.cost_estimate_usd ?? 0),
      failed_runner_jobs: summary.failed_runner_jobs + (job.status === 'failed' || job.status === 'degraded' ? 1 : 0),
    }),
    {
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_estimated_cost_usd: 0,
      failed_runner_jobs: 0,
    },
  );
  return {
    ...totals,
    total_estimated_cost_usd: Math.round(totals.total_estimated_cost_usd * 1_000_000) / 1_000_000,
  };
}

function buildReportActions(input: {
  scopeId: string;
  canonicalMemories: ReportCanonicalMemory[];
  lifecycleStates: ReportLifecycleState[];
  purgeCandidates: ReportPurgeCandidate[];
  reviewItems: ReportReviewItem[];
  conflicts: ReportConflict[];
  failedJobs: Array<ReportRunnerJob | ReportMaintenanceJob>;
  sources: ReportSource[];
  policyDenials: ReportPolicyDenial[];
}): MemoryReportAction[] {
  return [
    ...input.canonicalMemories.flatMap((memory) => [
      governedWritebackAction({
        kind: 'undo',
        targetKind: 'canonical_memory',
        targetId: memory.id,
        scopeId: input.scopeId,
        content: `Review undo request for canonical memory ${memory.id}${memory.target_slug ? ` (${memory.target_slug})` : ''}: ${memory.summary}`,
        sourceRefs: memory.source_refs,
        evidenceKind: 'agent_inferred',
        candidateType: 'note_update',
        targetObjectType: memory.target_slug ? 'curated_note' : 'other',
        targetObjectId: memory.target_slug ?? memory.id,
      }),
      governedWritebackAction({
        kind: 'pin',
        targetKind: 'canonical_memory',
        targetId: memory.id,
        scopeId: input.scopeId,
        content: `Review pin request for canonical memory ${memory.id}${memory.target_slug ? ` (${memory.target_slug})` : ''}: ${memory.summary}`,
        sourceRefs: memory.source_refs,
        evidenceKind: 'agent_inferred',
        candidateType: 'note_update',
        targetObjectType: memory.target_slug ? 'curated_note' : 'other',
        targetObjectId: memory.target_slug ?? memory.id,
      }),
    ]),
    ...input.lifecycleStates
      .filter((state) => state.lifecycle_state === 'stale' || state.lifecycle_state === 'expired' || state.lifecycle_state === 'archived')
      .map((state) => governedAction('restore', state.entity_type, state.entity_id, 'restore_lifecycle_memory', {
        entity_type: state.entity_type,
        entity_id: state.entity_id,
        scope_id: input.scopeId,
        reason: 'memory review report restore action',
      })),
    ...input.reviewItems.flatMap((item) => [
      governedAction('reject', item.review_type, item.id, 'reject_memory_candidate_entry', {
        id: item.id,
        review_reason: 'memory review report reject action',
      }),
      governedAction('approve_candidate', item.review_type, item.id, 'promote_memory_candidate_entry', {
        id: item.id,
        review_reason: 'memory review report approve action',
      }),
    ]),
    ...input.conflicts.map((conflict) => governedWritebackAction({
      kind: 'resolve_conflict',
      targetKind: 'conflict',
      targetId: conflict.id,
      scopeId: input.scopeId,
      content: `Resolve memory conflict ${conflict.id} for ${conflict.target_ref}: ${conflict.summary}`,
      sourceRefs: [`memory-conflict:${conflict.id}`],
      evidenceKind: 'contradicts_existing',
      candidateType: 'open_question',
      targetObjectType: 'other',
      targetObjectId: conflict.target_ref,
    })),
    ...input.sources.flatMap((source) => sourceControlActions(source)),
    ...(input.purgeCandidates.length === 0 ? [] : [
      governedAction('purge', 'lifecycle_scope', input.scopeId, 'plan_lifecycle_purge', {
        scope_id: input.scopeId,
        reason: `memory review report purge plan for ${input.purgeCandidates.length} due lifecycle row(s)`,
        requested_by: 'mbrain:memory-report',
        limit: input.purgeCandidates.length,
      }),
    ]),
    ...input.policyDenials.map((denial) => governedWritebackAction({
      kind: 'adjust_policy',
      targetKind: 'policy_denial',
      targetId: denial.id,
      scopeId: input.scopeId,
      content: `Review memory policy adjustment for denial ${denial.id}${denial.target_ref ? ` on ${denial.target_ref}` : ''}: ${denial.reason}`,
      sourceRefs: [`memory-policy-denial:${denial.id}`],
      evidenceKind: 'ambiguous',
      candidateType: 'procedure',
      targetObjectType: 'other',
      targetObjectId: denial.target_ref ?? denial.id,
    })),
    ...input.failedJobs.flatMap((job) => {
      const rerunJobId = rerunnableMemoryJobId(job);
      if (!rerunJobId) return [];
      const jobName = 'name' in job ? job.name : job.task_type;
      return governedAction('rerun_failed_job', 'memory_job', rerunJobId, 'rerun_memory_job', {
        job_id: rerunJobId,
        reason: `memory review report rerun action for ${jobName}${job.failure_class ? ` after ${job.failure_class}` : ''}`,
        requested_by: 'mbrain:memory-report',
      });
    }),
    ...input.canonicalMemories.map((memory) => {
      const target = canonicalMemoryAuditTarget(memory);
      return governedAction('open_audit_trail', target.targetKind, target.targetId, 'list_memory_mutation_events', {
        target_kind: target.targetKind,
        target_id: target.targetId,
        limit: 20,
        offset: 0,
      });
    }),
  ];
}

function sourceControlActions(source: ReportSource): MemoryReportAction[] {
  const actions: MemoryReportAction[] = [];
  if (source.enabled === true) {
    actions.push(governedAction('pause_source', 'source', source.id, 'pause_source_processing', {
      source_id: source.id,
      reason: `memory review report pause action for unhealthy source${source.display_name ? ` ${source.display_name}` : ''}`,
      actor_ref: 'mbrain:memory-report',
    }));
  }
  if (source.consent_state !== 'revoked') {
    actions.push(governedAction('revoke_source', 'source', source.id, 'revoke_source_consent', {
      source_id: source.id,
      reason: `memory review report revoke action for unhealthy source${source.display_name ? ` ${source.display_name}` : ''}`,
      actor_ref: 'mbrain:memory-report',
    }));
  }
  return actions;
}

function rerunnableMemoryJobId(job: ReportRunnerJob | ReportMaintenanceJob): string | null {
  if ('memory_job_id' in job) return job.memory_job_id ?? null;
  return job.id;
}

function canonicalMemoryAuditTarget(memory: ReportCanonicalMemory): { targetKind: string; targetId: string } {
  return {
    targetKind: memory.target_kind ?? (memory.target_slug ? 'page' : 'ledger_event'),
    targetId: memory.target_id ?? memory.target_slug ?? memory.id,
  };
}

function governedWritebackAction(input: {
  kind: ReportActionKind;
  targetKind: string;
  targetId: string;
  scopeId: string;
  content: string;
  sourceRefs?: string[];
  evidenceKind: 'agent_inferred' | 'ambiguous' | 'contradicts_existing';
  candidateType: 'note_update' | 'procedure' | 'open_question';
  targetObjectType: 'curated_note' | 'other';
  targetObjectId: string;
}): MemoryReportAction {
  return governedAction(input.kind, input.targetKind, input.targetId, 'route_memory_writeback', {
    content: input.content,
    source_refs: reportActionSourceRefs(input.kind, input.targetId, input.sourceRefs),
    source_kind: 'cron',
    evidence_kind: input.evidenceKind,
    candidate_type: input.candidateType,
    target_object_type: input.targetObjectType,
    target_object_id: input.targetObjectId,
    scope_id: input.scopeId,
    allow_canonical_write: false,
    apply: true,
  });
}

function reportActionSourceRefs(kind: ReportActionKind, targetId: string, sourceRefs?: string[]): string[] {
  return [
    `memory-report:${kind}:${targetId}`,
    ...(sourceRefs ?? []),
  ];
}

function governedAction(
  kind: ReportActionKind,
  targetKind: string,
  targetId: string,
  operation: string,
  params: Record<string, unknown>,
): MemoryReportAction {
  return {
    kind,
    target_kind: targetKind,
    target_id: targetId,
    route: 'governed_operation',
    operation,
    params,
    requires_mutation_ledger: true,
  };
}

function isEmptyReport(report: MemoryReviewReport): boolean {
  return Object.values(report.summary).every((count) => count === 0)
    && !hasMaintenanceHealthSignals(report.sections.maintenance_health);
}

function summarizeProjectionFreshness(targets: ReportProjectionTarget[]): ProjectionFreshnessSummary {
  return {
    total_exception_count: targets.length,
    pending_reconcile_count: targets.filter((target) => target.status === 'pending_reconcile').length,
    failed_count: targets.filter((target) => target.status === 'failed').length,
    conflict_count: targets.filter((target) => target.status === 'conflict').length,
    stale_count: targets.filter((target) => target.canonical_changed_since_projection).length,
  };
}

function emptyCandidateDebtMetrics(): CandidateDebtMetrics {
  return {
    visible_candidate_count: 0,
    missing_provenance_count: 0,
    stale_promoted_without_handoff_count: 0,
    unresolved_exposed_count: 0,
    median_review_latency_ms: null,
  };
}

function hasMaintenanceHealthSignals(health: MaintenanceHealthSummary): boolean {
  return health.candidate_debt.missing_provenance_count > 0
    || health.candidate_debt.stale_promoted_without_handoff_count > 0
    || health.candidate_debt.unresolved_exposed_count > 0
    || health.projection_freshness.pending_reconcile_count > 0
    || health.projection_freshness.failed_count > 0
    || health.projection_freshness.conflict_count > 0
    || health.projection_freshness.stale_count > 0;
}

function redactReportValues<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as T;
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactReportValues(item)) as T;

  const entries = Object.entries(value).map(([key, entryValue]) => [key, redactReportValues(entryValue)]);
  return Object.fromEntries(entries) as T;
}

function redactSecrets(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED_SECRET]')
    .replace(/xox[baprs]-[A-Za-z0-9-]{12,}/g, '[REDACTED_SECRET]')
    .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED_SECRET]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_SECRET]')
    .replace(/postgres(?:ql)?:\/\/[^/:\s]+:[^@\s]+@/gi, 'postgresql://[REDACTED_SECRET]@');
}
