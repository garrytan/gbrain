import type { BrainEngine } from '../engine.ts';
import type {
  ContextMapEntry,
  MemoryCandidateEntry,
  MemoryCandidateEntryInput,
  MemoryCandidateSensitivity,
  MemoryCandidateTargetObjectType,
  MemoryCandidateType,
} from '../types.ts';
import {
  WORKSPACE_CONTEXT_MAP_KIND,
  listCodeLaneContextMapEntries,
  listStructuralContextMapEntries,
} from './context-map-service.ts';
import { assessHistoricalValidity } from './historical-validity-service.ts';
import { buildMemoryCandidateReviewBacklog } from './memory-candidate-dedup-service.ts';
import {
  createMemoryCandidateEntryWithStatusEvent,
  MemoryInboxServiceError,
} from './memory-inbox-service.ts';
import { resolveTargetSnapshotHash } from './target-snapshot-hash-service.ts';

type DreamCycleSuggestionType = 'recap' | 'stale_claim_challenge' | 'duplicate_merge';
type DreamCycleSuggestionStatus = 'created' | 'dry_run';
type DreamCycleMaintenancePhaseId =
  | 'candidate_recap'
  | 'stale_candidate_review'
  | 'duplicate_merge_review'
  | 'derived_artifact_freshness'
  | 'apply_control_plane';
type DreamCycleMaintenancePhaseStatus = 'reported' | 'suggested' | 'created' | 'blocked' | 'skipped';

export interface RunDreamCycleMaintenanceInput {
  scope_id: string;
  now?: Date | string | null;
  limit?: number;
  write_candidates?: boolean;
  include_derived_freshness?: boolean;
  derived_freshness_limit?: number;
}

export interface DreamCycleMaintenanceSuggestion {
  suggestion_type: DreamCycleSuggestionType;
  candidate_id: string | null;
  scope_id: string;
  source_candidate_ids: string[];
  source_refs: string[];
  target_object_type: MemoryCandidateTargetObjectType | null;
  target_object_id: string | null;
  sensitivity: MemoryCandidateSensitivity;
  confidence_score: number;
  importance_score: number;
  expected_target_snapshot_hash: string | null;
  policy_checks: {
    canonical_write_allowed: false;
    source_refs_present: boolean;
    scope_present: boolean;
    target_identified: boolean;
    target_snapshot_required_for_apply: true;
  };
  redaction_checks: {
    fail_closed: true;
    status: 'not_applicable';
  };
  status: DreamCycleSuggestionStatus;
  summary_lines: string[];
}

export interface DreamCycleMaintenancePhase {
  phase_id: DreamCycleMaintenancePhaseId;
  output_kind: 'report' | 'candidate' | 'governed_apply_request';
  status: DreamCycleMaintenancePhaseStatus;
  summary_lines: string[];
}

export interface DreamCycleDerivedArtifactFreshness {
  artifact_kind: 'context_map';
  id: string;
  kind: string;
  status: string;
  stale_reason: string | null;
}

export interface DreamCycleDerivedFreshnessReport {
  enabled: boolean;
  artifact_count: number;
  stale_count: number;
  artifacts: DreamCycleDerivedArtifactFreshness[];
  summary_lines: string[];
}

export interface DreamCycleApplyControlPlane {
  allowed_without_control_plane: false;
  requires_active_realm_session: true;
  requires_mutation_ledger: true;
  requires_target_snapshot: true;
  dry_run_apply_validation_parity: true;
  redaction_fail_closed: true;
  supported_operations: string[];
  summary_lines: string[];
}

export interface DreamCycleMaintenanceResult {
  scope_id: string;
  generated_at: string;
  write_candidates: boolean;
  authority: 'report_or_candidate_only';
  canonical_write_allowed: false;
  suggestions: DreamCycleMaintenanceSuggestion[];
  maintenance_phases: DreamCycleMaintenancePhase[];
  derived_freshness_report: DreamCycleDerivedFreshnessReport;
  apply_control_plane: DreamCycleApplyControlPlane;
  summary_lines: string[];
}

interface DraftSuggestion {
  suggestion_type: DreamCycleSuggestionType;
  source_candidate_ids: string[];
  target_object_type: MemoryCandidateTargetObjectType | null;
  target_object_id: string | null;
  candidate_type: MemoryCandidateType;
  proposed_content: string;
  source_refs: string[];
  extraction_kind: 'inferred' | 'ambiguous';
  confidence_score: number;
  importance_score: number;
  recurrence_score: number;
  sensitivity: MemoryCandidateSensitivity;
  summary_lines: string[];
}

const DEFAULT_DREAM_CYCLE_LIMIT = 20;
const MAX_DREAM_CYCLE_LIMIT = 100;
const MAX_DREAM_CYCLE_INPUT_CANDIDATES = 100;
const DEFAULT_DERIVED_FRESHNESS_LIMIT = 50;
const MAX_DERIVED_FRESHNESS_LIMIT = 200;
const ISO_DATETIME_PREFIX = /^\d{4}-\d{2}-\d{2}T/;

export async function runDreamCycleMaintenance(
  engine: BrainEngine,
  input: RunDreamCycleMaintenanceInput,
): Promise<DreamCycleMaintenanceResult> {
  const scopeId = normalizeScopeId(input.scope_id);
  const now = normalizeNow(input.now);
  const limit = normalizeLimit(input.limit);
  const writeCandidates = input.write_candidates === true;
  const derivedFreshnessLimit = normalizeDerivedFreshnessLimit(input.derived_freshness_limit);
  if (limit <= 0) {
    const derivedReport = input.include_derived_freshness === true
      ? await buildDerivedFreshnessReport(engine, scopeId, derivedFreshnessLimit)
      : emptyDerivedFreshnessReport(false);
    const applyControlPlane = buildApplyControlPlane();
    return {
      scope_id: scopeId,
      generated_at: now.toISOString(),
      write_candidates: writeCandidates,
      authority: 'report_or_candidate_only',
      canonical_write_allowed: false,
      suggestions: [],
      maintenance_phases: buildMaintenancePhases([], derivedReport, applyControlPlane),
      derived_freshness_report: derivedReport,
      apply_control_plane: applyControlPlane,
      summary_lines: [
        `Dream-cycle maintenance inspected 0 candidates in ${scopeId}.`,
        'Emitted 0 bounded suggestions.',
        `Write candidates: ${writeCandidates ? 'yes' : 'no'}.`,
        'Canonical writes: no; apply-capable work must use the memory operations control plane.',
      ],
    };
  }
  const candidates = (await listMaintenanceCandidateWindow(engine, scopeId))
    .filter((candidate) => candidate.generated_by !== 'dream_cycle');
  const drafts = await buildDraftSuggestions(engine, {
    candidates,
    limit,
    now,
    scope_id: scopeId,
  });
  const suggestions: DreamCycleMaintenanceSuggestion[] = [];

  if (writeCandidates && drafts.length > 0) {
    await engine.transaction(async (tx) => {
      for (const draft of drafts) {
        const candidateId = (await createMemoryCandidateEntryWithStatusEvent(
          tx,
          toCandidateInput(scopeId, draft, now),
        )).id;

        suggestions.push(await toSuggestion(tx, scopeId, draft, candidateId, 'created'));
      }
    });
  } else {
    for (const draft of drafts) {
      suggestions.push(await toSuggestion(engine, scopeId, draft, null, 'dry_run'));
    }
  }
  const derivedReport = input.include_derived_freshness === true
    ? await buildDerivedFreshnessReport(engine, scopeId, derivedFreshnessLimit)
    : emptyDerivedFreshnessReport(false);
  const applyControlPlane = buildApplyControlPlane();

  return {
    scope_id: scopeId,
    generated_at: now.toISOString(),
    write_candidates: writeCandidates,
    authority: 'report_or_candidate_only',
    canonical_write_allowed: false,
    suggestions,
    maintenance_phases: buildMaintenancePhases(suggestions, derivedReport, applyControlPlane),
    derived_freshness_report: derivedReport,
    apply_control_plane: applyControlPlane,
    summary_lines: [
      `Dream-cycle maintenance inspected ${candidates.length} candidates in ${scopeId}.`,
      `Emitted ${suggestions.length} bounded suggestions.`,
      `Write candidates: ${writeCandidates ? 'yes' : 'no'}.`,
      'Canonical writes: no; apply-capable work must use the memory operations control plane.',
    ],
  };
}

async function toSuggestion(
  engine: BrainEngine,
  scopeId: string,
  draft: DraftSuggestion,
  candidateId: string | null,
  status: DreamCycleSuggestionStatus,
): Promise<DreamCycleMaintenanceSuggestion> {
  const expectedTargetSnapshotHash = await resolveSuggestionTargetSnapshotHash(engine, draft);

  return {
    suggestion_type: draft.suggestion_type,
    candidate_id: candidateId,
    scope_id: scopeId,
    source_candidate_ids: draft.source_candidate_ids,
    source_refs: draft.source_refs,
    target_object_type: draft.target_object_type,
    target_object_id: draft.target_object_id,
    sensitivity: draft.sensitivity,
    confidence_score: draft.confidence_score,
    importance_score: draft.importance_score,
    expected_target_snapshot_hash: expectedTargetSnapshotHash,
    policy_checks: {
      canonical_write_allowed: false,
      source_refs_present: draft.source_refs.length > 0,
      scope_present: scopeId.length > 0,
      target_identified: draft.target_object_type != null && draft.target_object_id != null,
      target_snapshot_required_for_apply: true,
    },
    redaction_checks: {
      fail_closed: true,
      status: 'not_applicable',
    },
    status,
    summary_lines: draft.summary_lines,
  };
}

async function resolveSuggestionTargetSnapshotHash(
  engine: BrainEngine,
  draft: DraftSuggestion,
): Promise<string | null> {
  if (!draft.target_object_type || !draft.target_object_id) {
    return null;
  }

  const targetKind = targetKindForCandidateObject(draft.target_object_type);
  if (!targetKind) {
    return null;
  }

  return (await resolveTargetSnapshotHash(engine, {
    target_kind: targetKind,
    target_id: draft.target_object_id,
  }))?.target_snapshot_hash ?? null;
}

function targetKindForCandidateObject(
  objectType: MemoryCandidateTargetObjectType,
): 'page' | 'profile_memory' | 'personal_episode' | null {
  switch (objectType) {
    case 'curated_note':
    case 'procedure':
      return 'page';
    case 'profile_memory':
      return 'profile_memory';
    case 'personal_episode':
      return 'personal_episode';
    case 'other':
      return null;
  }
}

async function buildDraftSuggestions(
  engine: BrainEngine,
  input: {
    scope_id: string;
    candidates: MemoryCandidateEntry[];
    now: Date;
    limit: number;
  },
): Promise<DraftSuggestion[]> {
  const drafts: DraftSuggestion[] = [];
  if (input.limit <= 0 || input.candidates.length === 0) {
    return drafts;
  }

  drafts.push(buildRecapSuggestion(input.scope_id, input.candidates));
  if (drafts.length >= input.limit) {
    return drafts;
  }

  for (const candidate of sortCandidates(input.candidates.filter((entry) => entry.status === 'promoted'))) {
    const assessment = await assessHistoricalValidity(engine, {
      candidate_id: candidate.id,
      now: input.now,
    });
    if (assessment.decision === 'allow') {
      continue;
    }
    drafts.push(buildStaleClaimChallenge(candidate, assessment.handoff_id));
    if (drafts.length >= input.limit) {
      return drafts;
    }
  }

  const backlog = buildMemoryCandidateReviewBacklog(input.candidates);
  for (const group of backlog) {
    if (group.duplicate_count <= 1) {
      continue;
    }
    drafts.push(buildDuplicateMergeSuggestion(group.representative_candidate, group.grouped_candidate_ids));
    if (drafts.length >= input.limit) {
      return drafts;
    }
  }

  return drafts;
}

function buildRecapSuggestion(scopeId: string, candidates: MemoryCandidateEntry[]): DraftSuggestion {
  const statusCounts = new Map<string, number>();
  for (const candidate of candidates) {
    statusCounts.set(candidate.status, (statusCounts.get(candidate.status) ?? 0) + 1);
  }
  const statusSummary = [...statusCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}:${count}`)
    .join(', ');

  return {
    suggestion_type: 'recap',
    source_candidate_ids: sortCandidateIds(candidates.map((candidate) => candidate.id)),
    target_object_type: null,
    target_object_id: null,
    candidate_type: 'rationale',
    proposed_content: `Dream-cycle recap for ${scopeId}: ${statusSummary}.`,
    source_refs: sortCandidateIds(candidates.map((candidate) => `memory_candidate:${candidate.id}`)),
    extraction_kind: 'inferred',
    confidence_score: 0.7,
    importance_score: 0.5,
    recurrence_score: 0,
    sensitivity: 'work',
    summary_lines: [
      `Recap candidate count: ${candidates.length}.`,
      `Status counts: ${statusSummary}.`,
    ],
  };
}

function buildStaleClaimChallenge(candidate: MemoryCandidateEntry, handoffId: string | null): DraftSuggestion {
  const sourceRefs = [`memory_candidate:${candidate.id}`];
  if (handoffId) {
    sourceRefs.push(`canonical_handoff:${handoffId}`);
  }

  return {
    suggestion_type: 'stale_claim_challenge',
    source_candidate_ids: [candidate.id],
    target_object_type: candidate.target_object_type,
    target_object_id: candidate.target_object_id,
    candidate_type: 'open_question',
    proposed_content: `Dream-cycle stale-claim challenge for candidate ${candidate.id}: verify whether the handed-off claim is still current.`,
    source_refs: sourceRefs,
    extraction_kind: 'ambiguous',
    confidence_score: 0.65,
    importance_score: Math.max(0.5, candidate.importance_score),
    recurrence_score: candidate.recurrence_score,
    sensitivity: candidate.sensitivity,
    summary_lines: [
      `Candidate ${candidate.id} did not pass historical-validity maintenance.`,
      `Target: ${candidate.target_object_type ?? 'none'}/${candidate.target_object_id ?? 'none'}.`,
    ],
  };
}

function buildDuplicateMergeSuggestion(
  representative: MemoryCandidateEntry,
  groupedCandidateIds: string[],
): DraftSuggestion {
  const sortedIds = sortCandidateIds(groupedCandidateIds);

  return {
    suggestion_type: 'duplicate_merge',
    source_candidate_ids: sortedIds,
    target_object_type: representative.target_object_type,
    target_object_id: representative.target_object_id,
    candidate_type: 'rationale',
    proposed_content: `Dream-cycle duplicate-merge suggestion for ${sortedIds.length} memory candidates targeting ${representative.target_object_id ?? 'none'}.`,
    source_refs: sortedIds.map((id) => `memory_candidate:${id}`),
    extraction_kind: 'inferred',
    confidence_score: 0.75,
    importance_score: representative.importance_score,
    recurrence_score: representative.recurrence_score,
    sensitivity: representative.sensitivity,
    summary_lines: [
      `Duplicate candidate group size: ${sortedIds.length}.`,
      `Representative candidate: ${representative.id}.`,
    ],
  };
}

function toCandidateInput(
  scopeId: string,
  draft: DraftSuggestion,
  now: Date,
): MemoryCandidateEntryInput {
  return {
    id: crypto.randomUUID(),
    scope_id: scopeId,
    candidate_type: draft.candidate_type,
    proposed_content: draft.proposed_content,
    source_refs: draft.source_refs,
    generated_by: 'dream_cycle',
    extraction_kind: draft.extraction_kind,
    confidence_score: draft.confidence_score,
    importance_score: draft.importance_score,
    recurrence_score: draft.recurrence_score,
    sensitivity: draft.sensitivity,
    status: 'candidate',
    target_object_type: draft.target_object_type,
    target_object_id: draft.target_object_id,
    reviewed_at: now,
    review_reason: 'Generated by dream-cycle maintenance.',
  };
}

async function listMaintenanceCandidateWindow(engine: BrainEngine, scopeId: string): Promise<MemoryCandidateEntry[]> {
  return engine.listMemoryCandidateEntries({
    scope_id: scopeId,
    limit: MAX_DREAM_CYCLE_INPUT_CANDIDATES,
    offset: 0,
  });
}

async function buildDerivedFreshnessReport(
  engine: BrainEngine,
  scopeId: string,
  limit: number,
): Promise<DreamCycleDerivedFreshnessReport> {
  if (limit <= 0) {
    return emptyDerivedFreshnessReport(true);
  }

  const [structuralMaps, codeLaneMaps] = await Promise.all([
    listStructuralContextMapEntries(engine, {
      scope_id: scopeId,
      kind: WORKSPACE_CONTEXT_MAP_KIND,
      limit,
    }),
    listCodeLaneContextMapEntries(engine, { scope_id: scopeId, limit }),
  ]);
  const artifacts = [...structuralMaps, ...codeLaneMaps]
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id))
    .map(toDerivedArtifactFreshness);
  const staleCount = artifacts.filter((artifact) => artifact.status === 'stale').length;

  return {
    enabled: true,
    artifact_count: artifacts.length,
    stale_count: staleCount,
    artifacts,
    summary_lines: [
      `Derived freshness inspected ${artifacts.length} context map artifact${artifacts.length === 1 ? '' : 's'} in ${scopeId}.`,
      `Stale derived artifacts: ${staleCount}.`,
      'Derived artifacts remain orientation and do not become answer authority.',
    ],
  };
}

function emptyDerivedFreshnessReport(enabled: boolean): DreamCycleDerivedFreshnessReport {
  return {
    enabled,
    artifact_count: 0,
    stale_count: 0,
    artifacts: [],
    summary_lines: enabled
      ? [
          'Derived freshness inspected 0 context map artifacts.',
          'Stale derived artifacts: 0.',
          'Derived artifacts remain orientation and do not become answer authority.',
        ]
      : ['Derived freshness report was not requested.'],
  };
}

function toDerivedArtifactFreshness(entry: ContextMapEntry): DreamCycleDerivedArtifactFreshness {
  return {
    artifact_kind: 'context_map',
    id: entry.id,
    kind: entry.kind,
    status: entry.status,
    stale_reason: entry.stale_reason,
  };
}

function buildApplyControlPlane(): DreamCycleApplyControlPlane {
  return {
    allowed_without_control_plane: false,
    requires_active_realm_session: true,
    requires_mutation_ledger: true,
    requires_target_snapshot: true,
    dry_run_apply_validation_parity: true,
    redaction_fail_closed: true,
    supported_operations: [
      'dry_run_memory_mutation',
      'apply_memory_patch_candidate',
    ],
    summary_lines: [
      'Maintenance apply is disabled unless routed through the existing control plane.',
      'Apply-capable maintenance requires active realm/session, mutation ledger, target snapshot, dry-run/apply parity, and redaction fail-closed behavior.',
    ],
  };
}

function buildMaintenancePhases(
  suggestions: DreamCycleMaintenanceSuggestion[],
  derivedReport: DreamCycleDerivedFreshnessReport,
  applyControlPlane: DreamCycleApplyControlPlane,
): DreamCycleMaintenancePhase[] {
  const hasSuggestion = (type: DreamCycleSuggestionType) =>
    suggestions.some((suggestion) => suggestion.suggestion_type === type);
  const candidateStatus = (type: DreamCycleSuggestionType): DreamCycleMaintenancePhaseStatus => {
    const matching = suggestions.filter((suggestion) => suggestion.suggestion_type === type);
    if (matching.length === 0) return 'skipped';
    return matching.some((suggestion) => suggestion.status === 'created') ? 'created' : 'suggested';
  };

  return [
    {
      phase_id: 'candidate_recap',
      output_kind: 'report',
      status: hasSuggestion('recap') ? 'reported' : 'skipped',
      summary_lines: ['Summarize candidate backlog without canonical mutation.'],
    },
    {
      phase_id: 'stale_candidate_review',
      output_kind: 'candidate',
      status: candidateStatus('stale_claim_challenge'),
      summary_lines: ['Create or preview stale-claim challenges as candidate-only governance state.'],
    },
    {
      phase_id: 'duplicate_merge_review',
      output_kind: 'candidate',
      status: candidateStatus('duplicate_merge'),
      summary_lines: ['Create or preview duplicate-merge suggestions without merging canonical truth.'],
    },
    {
      phase_id: 'derived_artifact_freshness',
      output_kind: 'report',
      status: derivedReport.enabled ? 'reported' : 'skipped',
      summary_lines: derivedReport.summary_lines,
    },
    {
      phase_id: 'apply_control_plane',
      output_kind: 'governed_apply_request',
      status: applyControlPlane.allowed_without_control_plane ? 'reported' : 'blocked',
      summary_lines: applyControlPlane.summary_lines,
    },
  ];
}

function normalizeScopeId(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MemoryInboxServiceError('invalid_status_transition', 'scope_id must be a non-empty string.');
  }
  return value;
}

function normalizeLimit(value: number | undefined): number {
  if (value == null) {
    return DEFAULT_DREAM_CYCLE_LIMIT;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new MemoryInboxServiceError('invalid_status_transition', 'limit must be a non-negative number.');
  }
  return Math.min(Math.floor(value), MAX_DREAM_CYCLE_LIMIT);
}

function normalizeDerivedFreshnessLimit(value: number | undefined): number {
  if (value == null) {
    return DEFAULT_DERIVED_FRESHNESS_LIMIT;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new MemoryInboxServiceError('invalid_status_transition', 'derived_freshness_limit must be a non-negative number.');
  }
  return Math.min(Math.floor(value), MAX_DERIVED_FRESHNESS_LIMIT);
}

function normalizeNow(value: Date | string | null | undefined): Date {
  if (value == null) {
    return new Date();
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new MemoryInboxServiceError('invalid_status_transition', 'now must be a valid Date when provided.');
    }
    return value;
  }
  if (typeof value !== 'string' || !ISO_DATETIME_PREFIX.test(value)) {
    throw new MemoryInboxServiceError('invalid_status_transition', 'now must be a valid ISO datetime string.');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new MemoryInboxServiceError('invalid_status_transition', 'now must be a valid ISO datetime string.');
  }
  return parsed;
}

function sortCandidates(candidates: MemoryCandidateEntry[]): MemoryCandidateEntry[] {
  return [...candidates].sort((left, right) => {
    const updatedDelta = right.updated_at.getTime() - left.updated_at.getTime();
    if (updatedDelta !== 0) {
      return updatedDelta;
    }
    return left.id.localeCompare(right.id);
  });
}

function sortCandidateIds(ids: string[]): string[] {
  return [...ids].sort((left, right) => left.localeCompare(right));
}
