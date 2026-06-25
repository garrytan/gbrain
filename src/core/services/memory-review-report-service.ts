import type {
  CandidateDebtMetrics,
  CanonicalTargetProposalStatus,
  NegativeMemoryProjection,
} from '../types.ts';

// Above this many staged-for-review candidates, the backlog gets a prominent
// warning in both the memory report and `mbrain doctor`.
export const MEMORY_INBOX_REVIEW_PRESSURE_THRESHOLD = 50;
export const CONNECTOR_HEALTH_OVERDUE_MS = 24 * 60 * 60 * 1000;

export type ReportHealthStatus = 'ok' | 'warn' | 'fail';
export type ReportConnectorStalenessStatus = 'fresh' | 'overdue' | 'never_succeeded' | 'unknown';
export type ReportConnectorFailureClass = 'auth_expired' | 'rate_limited' | 'network' | 'schema' | 'unknown';
export type ReportConnectorRetryPosture =
  | 'no_action'
  | 'retry_now'
  | 'wait_for_rate_limit'
  | 'reauthenticate'
  | 'inspect_schema'
  | 'investigate';
export type ReportActionKind =
  | 'undo'
  | 'restore'
  | 'pin'
  | 'reject'
  | 'pause_source'
  | 'revoke_source'
  | 'purge'
  | 'adjust_policy'
  | 'stage_candidate'
  | 'approve_candidate'
  | 'propose_canonical_home'
  | 'approve_canonical_target_proposal'
  | 'reject_canonical_target_proposal'
  | 'choose_existing_canonical_page'
  | 'complete_canonical_target_binding'
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

export interface ReportCoverageGap {
  id: string;
  title: string;
  severity: 'low' | 'medium' | 'high';
  count: number;
  summary: string;
  next_action: string;
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

export interface ReportCanonicalTargetProposal {
  id: string;
  source_candidate_id: string;
  linked_candidate_ids: string[];
  status: CanonicalTargetProposalStatus;
  proposed_slug: string;
  proposed_title: string;
  status_reason?: string | null;
  stub_patch_candidate_id?: string | null;
  stub_patch_state?: string | null;
  bound_candidate_ids?: string[];
}

export interface ReportWriteSession {
  id: string;
  route_decision_id: string;
  status: 'open' | 'applied' | 'superseded' | 'expired' | 'abandoned' | string;
  target_slug: string;
  expected_content_hash: string | null;
  source_refs: string[];
  route_decision: string;
  intended_operation: string;
  actor: string;
  scope_id: string;
  created_at: string;
  expires_at: string;
  consumed_at?: string | null;
  consumed_by_event_id?: string | null;
  status_reason?: string | null;
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
  last_success_at?: string | null;
  last_failure_at?: string | null;
  failure_count?: number;
  last_error?: string | null;
  staleness_status?: ReportConnectorStalenessStatus;
  overdue?: boolean;
  failure_class?: ReportConnectorFailureClass;
  retry_posture?: ReportConnectorRetryPosture;
  next_action?: string;
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
  canonical_target_proposals?: ReportCanonicalTargetProposal[];
  write_sessions?: ReportWriteSession[];
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
  description: string;
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
  candidate_hard_blocked_by_proposal: number;
  coverage_gaps: number;
  open_write_sessions: number;
  expired_write_sessions: number;
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
    canonical_target_proposals: ReportCanonicalTargetProposal[];
    write_sessions: ReportWriteSession[];
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
    coverage_gaps: ReportCoverageGap[];
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
  const canonicalTargetProposals = redactReportValues(input.canonical_target_proposals ?? []);
  const writeSessions = redactReportValues(input.write_sessions ?? []);
  const conflicts = redactReportValues(input.conflicts ?? []);
  const sources = redactReportValues(input.sources ?? []);
  const sourceItems = redactReportValues(input.source_items ?? []);
  const extractedClaims = redactReportValues(input.extracted_claims ?? []);
  const policyDenials = redactReportValues(input.policy_denials ?? []);
  const quarantinedSources = redactReportValues(input.quarantined_sources ?? []);
  const secretDetections = redactReportValues(input.secret_detections ?? []);
  const runnerJobs = redactReportValues(input.runner_jobs ?? []);
  const jobs = redactReportValues(input.jobs ?? []);
  const connectorHealth = redactReportValues(
    (input.connector_health ?? []).map((connector) =>
      enrichConnectorHealth(connector, input.generated_at)
    ),
  );

  const failedRunnerJobs = runnerJobs.filter((job) => job.status === 'failed' || job.status === 'degraded');
  const failedMaintenanceJobs = jobs.filter((job) => job.status === 'failed' || job.status === 'dead');
  const reconciliationFailures = projectionTargets.filter((target) => target.status === 'failed' || target.status === 'conflict');
  const unhealthySources = sources.filter((source) => source.health_status === 'unhealthy');
  const failedSourceItems = sourceItems.filter((item) => item.status === 'failed');
  const unhealthyConnectors = connectorHealth.filter(connectorRequiresAttention);
  const candidateDebt = input.candidate_debt ?? emptyCandidateDebtMetrics();
  const projectionFreshness = summarizeProjectionFreshness(projectionTargets);
  const coverageGaps = buildCoverageGaps(candidateDebt, projectionFreshness);
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
    candidate_hard_blocked_by_proposal: candidateDebt.hard_blocked_by_proposal_count,
    coverage_gaps: coverageGaps.length,
    open_write_sessions: writeSessions.filter((session) => session.status === 'open').length,
    expired_write_sessions: writeSessions.filter((session) => session.status === 'expired').length,
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
      canonical_target_proposals: canonicalTargetProposals,
      write_sessions: writeSessions,
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
      coverage_gaps: coverageGaps,
    },
    actions: buildReportActions({
      scopeId: input.scope_id,
      canonicalMemories,
      lifecycleStates,
      purgeCandidates,
      reviewItems,
      canonicalTargetProposals,
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
      `WARNING: review backlog pressure — ${report.summary.review_items} candidates need review or staging (threshold ${MEMORY_INBOX_REVIEW_PRESSURE_THRESHOLD}).`,
      'Stage candidate items first, then promote, reject, or supersede staged candidates.',
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
      lines.push('', 'Canonical Memories (learned this period)');
      lines.push(`- ${report.summary.new_canonical_memories} new, ${report.summary.updated_canonical_memories} updated`);
      for (const memory of report.sections.canonical_memories) {
        lines.push(`- ${redactSecrets(memory.summary)}`);
      }
    }

    if (report.sections.coverage_gaps.length > 0) {
      lines.push('', 'Coverage Gaps');
      for (const gap of report.sections.coverage_gaps) {
        lines.push(`- ${gap.severity}: ${gap.title} (${gap.count}) - ${redactSecrets(gap.summary)} Next: ${redactSecrets(gap.next_action)}`);
      }
    }

    if (report.sections.policy_denials.length > 0) {
      lines.push('', 'Policy Denials');
      for (const denial of report.sections.policy_denials) {
        lines.push(`- ${denial.id}: ${redactSecrets(denial.reason)}`);
      }
    }

    if (report.sections.canonical_target_proposals.length > 0) {
      lines.push('', 'Canonical Target Proposals');
      for (const proposal of report.sections.canonical_target_proposals) {
        lines.push(`- ${proposal.id}: ${proposal.status} ${proposal.proposed_slug} (${proposal.proposed_title})`);
      }
    }

	    if (report.sections.write_sessions.length > 0) {
	      lines.push('', 'Write Sessions');
	      for (const session of report.sections.write_sessions) {
	        const reason = session.status_reason ? ` | reason:${redactSecrets(session.status_reason)}` : '';
	        lines.push(`- ${session.status} ${session.id} -> ${session.target_slug} | route:${session.route_decision_id} | expires:${session.expires_at}${reason}`);
	      }
	    }

    if (report.actions.length > 0) {
      lines.push('', 'Actions');
      for (const action of report.actions) {
        lines.push(`- ${action.kind}: ${action.target_kind}/${action.target_id} via ${action.route} | ${action.description}`);
      }
    }
  }

  const reportableConnectors = report.sections.connector_health.filter(connectorRequiresAttention);
  if (reportableConnectors.length > 0) {
    lines.push('', 'Connector Health');
    for (const connector of reportableConnectors) {
      lines.push(formatConnectorHealthLine(connector));
      if (connector.last_error) lines.push(`  last_error: ${redactSecrets(connector.last_error)}`);
    }
  }

  if (hasMaintenanceHealthSignals(report.sections.maintenance_health)) {
    const candidateDebt = report.sections.maintenance_health.candidate_debt;
    const projectionFreshness = report.sections.maintenance_health.projection_freshness;
    lines.push('', 'Maintenance Health');
    lines.push(`- Candidate debt: visible ${candidateDebt.visible_candidate_count} | missing provenance ${candidateDebt.missing_provenance_count} | promoted without handoff ${candidateDebt.stale_promoted_without_handoff_count} | unresolved exposed ${candidateDebt.unresolved_exposed_count} | hard-blocked by proposal ${candidateDebt.hard_blocked_by_proposal_count}`);
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
  if (summary.coverage_gaps > 0) reasons.push(`${summary.coverage_gaps} coverage gaps`);
  if (summary.open_write_sessions > 0) reasons.push(`${summary.open_write_sessions} open write sessions`);
  if (summary.expired_write_sessions > 0) reasons.push(`${summary.expired_write_sessions} expired write sessions`);

  return {
    status: reasons.length === 0 ? 'ok' : summary.failed_jobs > 0 || summary.reconciliation_failures > 0 ? 'fail' : 'warn',
    reasons,
  };
}

function buildCoverageGaps(
  candidateDebt: CandidateDebtMetrics,
  projectionFreshness: ProjectionFreshnessSummary,
): ReportCoverageGap[] {
  const gaps: ReportCoverageGap[] = [];
  const addGap = (gap: ReportCoverageGap) => {
    if (gap.count > 0) gaps.push(gap);
  };

  addGap({
    id: 'candidate_missing_provenance',
    title: 'Candidate provenance gap',
    severity: 'medium',
    count: candidateDebt.missing_provenance_count,
    summary: 'Captured candidates are visible but cannot safely promote until provenance is attached.',
    next_action: 'Add source refs or reject candidates that cannot be attributed.',
  });
  addGap({
    id: 'promoted_without_handoff',
    title: 'Promoted without canonical page',
    severity: 'high',
    count: candidateDebt.stale_promoted_without_handoff_count,
    summary: 'Promoted candidates still lack a canonical handoff or materialized page.',
    next_action: 'Create, review, and apply patch candidates for promoted items.',
  });
  addGap({
    id: 'unresolved_exposed_candidates',
    title: 'Exposed unresolved candidates',
    severity: 'medium',
    count: candidateDebt.unresolved_exposed_count,
    summary: 'Unresolved candidates remain visible to review surfaces without a final disposition.',
    next_action: 'Promote, supersede, reject, or bind these candidates to a canonical target.',
  });
  addGap({
    id: 'projection_reconciliation',
    title: 'Projection freshness gap',
    severity: projectionFreshness.failed_count + projectionFreshness.conflict_count > 0 ? 'high' : 'medium',
    count: projectionFreshness.total_exception_count,
    summary: 'Derived projections do not fully reflect the current canonical state.',
    next_action: 'Rerun projection reconciliation and resolve conflicts before relying on the projection.',
  });
  return gaps;
}

function enrichConnectorHealth(connector: ReportConnectorHealth, generatedAt: string): ReportConnectorHealth {
  const normalized: ReportConnectorHealth = {
    ...connector,
    last_success_at: connector.last_success_at ?? null,
    last_failure_at: connector.last_failure_at ?? null,
    failure_count: connector.failure_count ?? 0,
    last_error: connector.last_error ?? null,
  };
  const stalenessStatus = connectorStalenessStatus(normalized, generatedAt);
  const failureClass = connector.failure_class ?? connectorFailureClass(normalized);
  const retryPosture = connector.retry_posture ?? connectorRetryPosture(normalized, stalenessStatus, failureClass);

  return {
    ...normalized,
    staleness_status: stalenessStatus,
    overdue: stalenessStatus === 'overdue' || stalenessStatus === 'never_succeeded',
    ...(failureClass ? { failure_class: failureClass } : {}),
    retry_posture: retryPosture,
    next_action: connectorNextAction(normalized, stalenessStatus, failureClass, retryPosture),
  };
}

function connectorRequiresAttention(connector: ReportConnectorHealth): boolean {
  return connector.health_status !== 'healthy'
    || connector.credential_status === 'revoked'
    || connector.credential_status === 'rotation_due'
    || connector.staleness_status === 'overdue'
    || connector.staleness_status === 'never_succeeded'
    || (connector.failure_count ?? 0) > 0
    || connector.failure_class !== undefined;
}

function connectorStalenessStatus(
  connector: ReportConnectorHealth,
  generatedAt: string,
): ReportConnectorStalenessStatus {
  const generatedTime = Date.parse(generatedAt);
  if (!Number.isFinite(generatedTime)) return 'unknown';
  const lastSuccessTime = connector.last_success_at ? Date.parse(connector.last_success_at) : NaN;
  if (Number.isFinite(lastSuccessTime)) {
    return generatedTime - lastSuccessTime > CONNECTOR_HEALTH_OVERDUE_MS ? 'overdue' : 'fresh';
  }
  if ((connector.failure_count ?? 0) > 0 || connector.health_status !== 'healthy') return 'never_succeeded';
  return 'unknown';
}

function connectorFailureClass(connector: ReportConnectorHealth): ReportConnectorFailureClass | undefined {
  if (connector.health_status === 'expired' || connector.credential_status === 'revoked') return 'auth_expired';
  const error = (connector.last_error ?? '').toLowerCase();
  if (!error) {
    return connector.health_status !== 'healthy' || (connector.failure_count ?? 0) > 0 ? 'unknown' : undefined;
  }
  if (/(^|[^0-9])429([^0-9]|$)|rate limit|too many requests/.test(error)) return 'rate_limited';
  if (/401|403|unauthori[sz]ed|forbidden|oauth|token|credential|expired|revoked/.test(error)) return 'auth_expired';
  if (/econnreset|econnrefused|etimedout|enotfound|eai_again|network|timeout|temporar/.test(error)) return 'network';
  if (/schema|json|parse|validation|constraint|column|syntax|typeerror/.test(error)) return 'schema';
  return 'unknown';
}

function connectorRetryPosture(
  connector: ReportConnectorHealth,
  stalenessStatus: ReportConnectorStalenessStatus,
  failureClass: ReportConnectorFailureClass | undefined,
): ReportConnectorRetryPosture {
  if (
    failureClass === 'auth_expired'
    || connector.credential_status === 'revoked'
    || connector.credential_status === 'rotation_due'
  ) return 'reauthenticate';
  if (failureClass === 'rate_limited') return 'wait_for_rate_limit';
  if (failureClass === 'schema') return 'inspect_schema';
  if (failureClass === 'network' || stalenessStatus === 'overdue' || stalenessStatus === 'never_succeeded') return 'retry_now';
  if (failureClass === 'unknown' || (connector.failure_count ?? 0) > 0 || connector.health_status !== 'healthy') return 'investigate';
  return 'no_action';
}

function connectorNextAction(
  connector: ReportConnectorHealth,
  stalenessStatus: ReportConnectorStalenessStatus,
  failureClass: ReportConnectorFailureClass | undefined,
  retryPosture: ReportConnectorRetryPosture,
): string {
  if (retryPosture === 'reauthenticate') {
    return connector.credential_status === 'rotation_due'
      ? 'Rotate the connector credential, then rerun sync.'
      : 'Refresh connector authorization, then rerun sync.';
  }
  if (retryPosture === 'wait_for_rate_limit') {
    return 'Wait for the rate limit window or reduce batch size, then retry sync.';
  }
  if (retryPosture === 'inspect_schema') {
    return 'Inspect connector payload schema or mapper before retrying sync.';
  }
  if (retryPosture === 'retry_now') {
    return stalenessStatus === 'overdue'
      ? 'Rerun connector sync and confirm last_success_at advances.'
      : 'Retry connector sync and confirm the account records a success.';
  }
  if (retryPosture === 'investigate') {
    return failureClass
      ? 'Inspect connector logs and last_error before retrying sync.'
      : 'Inspect connector health before retrying sync.';
  }
  return 'No connector action required.';
}

function formatConnectorHealthLine(connector: ReportConnectorHealth): string {
  const parts: string[] = [connector.health_status];
  if (connector.credential_status !== 'current') parts.push(`credential:${connector.credential_status}`);
  if (connector.staleness_status === 'overdue' || connector.staleness_status === 'never_succeeded') {
    parts.push(connector.staleness_status);
  }
  if (connector.failure_class) parts.push(`failure:${connector.failure_class}`);
  if (connector.retry_posture && connector.retry_posture !== 'no_action') {
    parts.push(`retry:${connector.retry_posture}`);
  }
  if ((connector.failure_count ?? 0) > 0) parts.push(`failures:${connector.failure_count}`);
  if (connector.last_success_at) parts.push(`last_success:${connector.last_success_at}`);
  if (connector.last_failure_at) parts.push(`last_failure:${connector.last_failure_at}`);

  return `- ${connector.connector_id}/${connector.account_id}: ${parts.join(' | ')} | ${connector.next_action ?? 'No connector action required.'}`;
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
  canonicalTargetProposals: ReportCanonicalTargetProposal[];
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
    ...input.reviewItems.flatMap((item) => reviewItemActions(item, actionableProposalCandidateIds(input.canonicalTargetProposals))),
    ...input.canonicalTargetProposals.flatMap((proposal) => canonicalTargetProposalActions(proposal)),
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

function reviewItemActions(item: ReportReviewItem, proposalCandidateIds: Set<string>): MemoryReportAction[] {
  if (item.review_type === 'candidate_staging') {
    const actions = [
      governedAction('stage_candidate', item.review_type, item.id, 'advance_memory_candidate_status', {
        id: item.id,
        next_status: 'staged_for_review',
        review_reason: 'memory review report stage action',
      }),
    ];
    if (!item.target_ref && !proposalCandidateIds.has(item.id)) {
      actions.unshift(governedAction('propose_canonical_home', 'memory_candidate', item.id, 'create_canonical_target_proposal', {
        candidate_id: item.id,
        apply: true,
        review_reason: 'memory review report propose canonical home action',
      }));
    }
    return actions;
  }
  if (item.review_type === 'deferred_candidate') {
    return [];
  }
  return [
    governedAction('reject', item.review_type, item.id, 'reject_memory_candidate_entry', {
      id: item.id,
      review_reason: 'memory review report reject action',
    }),
    governedAction('approve_candidate', item.review_type, item.id, 'promote_memory_candidate_entry', {
      id: item.id,
      review_reason: 'memory review report approve action',
    }),
  ];
}

function actionableProposalCandidateIds(proposals: ReportCanonicalTargetProposal[]): Set<string> {
  const actionableStatuses = new Set<CanonicalTargetProposalStatus>(['proposed', 'approved', 'patch_staged', 'bound']);
  return new Set(proposals
    .filter((proposal) => actionableStatuses.has(proposal.status))
    .flatMap((proposal) => [
      proposal.source_candidate_id,
      ...proposal.linked_candidate_ids,
      ...(proposal.bound_candidate_ids ?? []),
    ]));
}

function canonicalTargetProposalActions(proposal: ReportCanonicalTargetProposal): MemoryReportAction[] {
  if (proposal.status === 'proposed') {
    return [
      governedAction('approve_canonical_target_proposal', 'canonical_target_proposal', proposal.id, 'approve_canonical_target_proposal', {
        proposal_id: proposal.id,
        review_reason: 'memory review report approve canonical target proposal action',
      }, canonicalTargetReviewContextDescription('approve this canonical target proposal')),
      governedAction('reject_canonical_target_proposal', 'canonical_target_proposal', proposal.id, 'reject_canonical_target_proposal', {
        proposal_id: proposal.id,
        review_reason: 'memory review report reject canonical target proposal action',
      }, canonicalTargetReviewContextDescription('reject this canonical target proposal')),
    ];
  }
  if (proposal.status === 'approved') {
    return [
      governedAction('choose_existing_canonical_page', 'canonical_target_proposal', proposal.id, 'complete_canonical_target_proposal_binding', {
        proposal_id: proposal.id,
        require_stub_patch_applied: false,
        review_reason: 'memory review report choose existing canonical page action',
      }, canonicalTargetReviewContextDescription('bind this approved proposal to an existing canonical page')),
    ];
  }
  if (proposal.status === 'patch_staged') {
    return [
      governedAction('complete_canonical_target_binding', 'canonical_target_proposal', proposal.id, 'complete_canonical_target_proposal_binding', {
        proposal_id: proposal.id,
        require_stub_patch_applied: true,
        review_reason: 'memory review report complete canonical target binding action',
      }, canonicalTargetReviewContextDescription('complete this patch-staged canonical target binding')),
    ];
  }
  return [];
}

function canonicalTargetReviewContextDescription(action: string): string {
  return `Operation template to ${action}; requires caller-provided review context: session_id, realm_id, actor, and source_refs.`;
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
  description = `Run ${operation} for ${targetKind}/${targetId}.`,
): MemoryReportAction {
  return {
    kind,
    target_kind: targetKind,
    target_id: targetId,
    route: 'governed_operation',
    operation,
    params,
    description,
    requires_mutation_ledger: true,
  };
}

function isEmptyReport(report: MemoryReviewReport): boolean {
  return Object.values(report.summary).every((count) => count === 0)
    && report.sections.canonical_target_proposals.length === 0
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
    hard_blocked_by_proposal_count: 0,
    median_review_latency_ms: null,
  };
}

function hasMaintenanceHealthSignals(health: MaintenanceHealthSummary): boolean {
  return health.candidate_debt.missing_provenance_count > 0
    || health.candidate_debt.stale_promoted_without_handoff_count > 0
    || health.candidate_debt.unresolved_exposed_count > 0
    || health.candidate_debt.hard_blocked_by_proposal_count > 0
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
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [REDACTED_SECRET]')
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{12,}/gi, 'Basic [REDACTED_SECRET]')
    .replace(/(^|[?&\s])((?:access_token|refresh_token|id_token|oauth_token|client_secret|api_key|apikey|secret|token)=)[^&\s]+/gi, '$1$2[REDACTED_SECRET]')
    .replace(/((?:authorization)\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi, '$1[REDACTED_SECRET]')
    .replace(/((?:x-api-key|api-key)\s*:\s*)[^\s,;]+/gi, '$1[REDACTED_SECRET]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED_SECRET]')
    .replace(/xox[baprs]-[A-Za-z0-9-]{12,}/g, '[REDACTED_SECRET]')
    .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED_SECRET]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_SECRET]')
    .replace(/postgres(?:ql)?:\/\/[^/:\s]+:[^@\s]+@/gi, 'postgresql://[REDACTED_SECRET]@');
}
