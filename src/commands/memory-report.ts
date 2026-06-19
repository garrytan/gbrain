import {
  buildMemoryReviewReport,
  formatMemoryReviewReport,
  type MemoryReviewReportInput,
  type ReportCanonicalTargetProposal,
  type ReportConflict,
  type ReportCanonicalMemory,
  type ReportConnectorHealth,
  type ReportExtractedClaim,
  type ReportLifecycleState,
  type ReportMaintenanceJob,
  type ReportPolicyDenial,
  type ReportProjectionTarget,
  type ReportQuarantinedSource,
  type ReportReviewItem,
  type ReportRunnerJob,
  type ReportSecretDetection,
  type ReportSource,
  type ReportSourceItem,
} from '../core/services/memory-review-report-service.ts';
import { saveBrainReport } from './report.ts';
import type { BrainEngine } from '../core/engine.ts';
import type {
  CanonicalTargetProposalStatus,
  DecisionProjectionMemoryCandidate,
  DecisionProjectionTaskAttempt,
  CanonicalTargetProposalEntry,
  MemoryCandidateEntry,
  MemoryMutationEvent,
} from '../core/types.ts';
import { createLifecycleForgettingStoreForEngine } from '../core/maintenance/lifecycle-forgetting.ts';
import { computeCandidateDebtMetrics } from '../core/services/inbox-lead-service.ts';
import { buildNegativeMemoryProjections } from '../core/services/negative-memory-projection-service.ts';

const DEFAULT_SCOPE_ID = 'workspace:default';
const DEFAULT_LIMIT = 100;
const CANDIDATE_DEBT_PROPOSAL_PAGE_SIZE = 500;
const CANDIDATE_DEBT_PROPOSAL_STATUSES: CanonicalTargetProposalStatus[] = [
  'proposed',
  'approved',
  'patch_staged',
  'bound',
  'blocked',
];

export async function runMemoryReport(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    printMemoryReportHelp();
    return;
  }

  const scopeId = valueAfter(args, '--scope-id') ?? DEFAULT_SCOPE_ID;
  const limit = parsePositiveInt(valueAfter(args, '--limit')) ?? DEFAULT_LIMIT;
  const now = valueAfter(args, '--now') ?? new Date().toISOString();
  const reportDir = args.includes('--report-dir') ? requiredValueAfter(args, '--report-dir') : '.';
  const report = buildMemoryReviewReport(await collectMemoryReportInput(engine, scopeId, limit, now));
  const formatted = formatMemoryReviewReport(report);
  const savedReportPath = args.includes('--save')
    ? saveBrainReport({
      brainDir: reportDir,
      type: 'memory-review-report',
      title: 'Memory Review Report',
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
  const [
    mutationEvents,
    candidates,
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
  ]);
  const [
    canonicalHandoffCandidateIds,
    candidateDebtCanonicalTargetProposals,
  ] = await Promise.all([
    collectCanonicalHandoffCandidateIds(engine, scopeId, candidates),
    collectCandidateDebtCanonicalTargetProposals(engine, scopeId),
  ]);
  const negativeMemoryProjections = [
    ...failedTaskAttempts.flatMap((attempt) => buildNegativeMemoryProjections({
      task_attempts: [attempt],
      current_anchors: attempt.applicability_context,
      now: generatedAt,
    })),
    ...buildNegativeMemoryProjections({
      memory_candidates: candidates.map(memoryCandidateToDecisionProjectionCandidate),
      now: generatedAt,
    }),
  ];

  return {
    scope_id: scopeId,
    generated_at: generatedAt,
    canonical_memories: mutationEvents.flatMap(memoryMutationToCanonicalMemory),
    review_items: candidates.flatMap(memoryCandidateToReviewItem),
    canonical_target_proposals: canonicalTargetProposals,
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
    candidate_debt: computeCandidateDebtMetrics({
      candidates,
      canonical_handoff_candidate_ids: canonicalHandoffCandidateIds,
      canonical_target_proposals: candidateDebtCanonicalTargetProposals,
    }),
    negative_memory_projections: negativeMemoryProjections,
  };
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

async function collectCanonicalHandoffCandidateIds(
  engine: BrainEngine,
  scopeId: string,
  candidates: MemoryCandidateEntry[],
): Promise<string[]> {
  const ids = new Set<string>();
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
    }));
  return [...ids];
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
      summary: `${event.operation} ${event.target_kind}/${event.target_id}`,
      source_refs: event.source_refs,
    },
  ];
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
    `),
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
  } catch {
    return [];
  }
  return [];
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
