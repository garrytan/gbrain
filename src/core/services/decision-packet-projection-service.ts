import type {
  DecisionPacketProjection,
  DecisionPacketProjectionInput,
  DecisionProjectionAssertionRecord,
  DecisionProjectionCanonicalHandoff,
  DecisionProjectionMemoryCandidate,
  DecisionProjectionRevalidationPath,
  DecisionProjectionReversibility,
  DecisionProjectionSourceRecord,
  DecisionProjectionTaskAttempt,
  DecisionProjectionTaskDecision,
  ProjectionAnchors,
} from '../types.ts';

export function buildDecisionPacketProjections(
  input: DecisionPacketProjectionInput,
): DecisionPacketProjection[] {
  return [
    ...buildTaskDecisionPackets(input),
    ...buildCanonicalHandoffPackets(input.canonical_handoffs ?? []),
  ];
}

function buildTaskDecisionPackets(input: DecisionPacketProjectionInput): DecisionPacketProjection[] {
  const attempts = input.task_attempts ?? [];
  const candidates = input.memory_candidates ?? [];
  const traces = input.retrieval_traces ?? [];
  const assertions = input.assertions ?? [];
  const handoffs = input.canonical_handoffs ?? [];

  return (input.task_decisions ?? []).map((decision) => {
    const canonicalTarget = stringField(decision.validity_context, 'canonical_target');
    const matchingAssertions = assertions.filter((assertion) => assertionMatchesDecision(assertion, decision, canonicalTarget));
    const canonicalAssertion = matchingAssertions.find((assertion) => (
      assertion.authority_state === 'canonical'
      && assertion.lifecycle_state === 'active'
    ));
    const matchingTraces = traces.filter((trace) => trace.task_id === decision.task_id);
    const matchingHandoffs = handoffs.filter((handoff) => (
      canonicalTarget != null && handoff.target_object_id === canonicalTarget
    ));
    const sourceRecords = taskDecisionSourceRecords(
      decision,
      matchingTraces,
      matchingAssertions,
      matchingHandoffs,
    );

    return {
      id: `decision-packet:${decision.id}`,
      decision: decision.summary,
      claim: canonicalAssertion?.claim_text ?? decision.summary,
      rationale: decision.rationale,
      rejected_alternatives: rejectedAlternatives(decision, attempts, candidates, canonicalTarget),
      owner_or_source: `task:${decision.task_id}`,
      source_refs: dedupeStrings([
        `task-decision:${decision.id}`,
        ...matchingTraces.flatMap((trace) => trace.source_refs),
        ...matchingAssertions.flatMap((assertion) => assertion.source_refs),
        ...matchingHandoffs.flatMap((handoff) => handoff.source_refs),
      ]),
      canonical_target: canonicalTarget,
      target_snapshot_hash: stringField(decision.validity_context, 'target_snapshot_hash'),
      valid_until: stringField(decision.validity_context, 'valid_until') ?? canonicalAssertion?.valid_until ?? null,
      revalidation_path: revalidationPath(decision.validity_context, canonicalAssertion),
      reversibility: reversibility(decision.validity_context),
      affected_selectors: stringArrayField(decision.validity_context, 'affected_selectors'),
      activation: canonicalAssertion ? 'answer_ground' : 'citation_only',
      authority: canonicalAssertion ? 'canonical_compiled_truth' : 'operational_memory',
      source_records: sourceRecords,
    };
  });
}

function buildCanonicalHandoffPackets(
  handoffs: DecisionProjectionCanonicalHandoff[],
): DecisionPacketProjection[] {
  return handoffs.map((handoff) => ({
    id: `decision-packet:${handoff.id}`,
    decision: `Canonical handoff to ${handoff.target_object_id}`,
    claim: `Canonical handoff to ${handoff.target_object_id}`,
    rationale: handoff.review_reason ?? 'Canonical handoff recorded.',
    rejected_alternatives: [],
    owner_or_source: `candidate:${handoff.candidate_id}`,
    source_refs: dedupeStrings([
      `canonical-handoff:${handoff.id}`,
      ...handoff.source_refs,
    ]),
    canonical_target: handoff.target_object_id,
    target_snapshot_hash: null,
    valid_until: null,
    revalidation_path: 'read_canonical',
    reversibility: 'unknown',
    affected_selectors: [handoff.target_object_id],
    activation: 'citation_only',
    authority: 'source_or_timeline_evidence',
    source_records: [{
      kind: 'canonical_handoff',
      id: handoff.id,
      authority: 'source_or_timeline_evidence',
      source_refs: handoff.source_refs,
    }],
  }));
}

function taskDecisionSourceRecords(
  decision: DecisionProjectionTaskDecision,
  traces: Array<{ id: string; source_refs: string[] }>,
  assertions: DecisionProjectionAssertionRecord[],
  handoffs: DecisionProjectionCanonicalHandoff[],
): DecisionProjectionSourceRecord[] {
  return [
    {
      kind: 'task_decision',
      id: decision.id,
      authority: 'operational_memory',
      source_refs: [`task-decision:${decision.id}`],
    },
    ...traces.map((trace) => ({
      kind: 'retrieval_trace' as const,
      id: trace.id,
      authority: 'operational_memory' as const,
      source_refs: trace.source_refs,
    })),
    ...assertions.map((assertion) => ({
      kind: 'assertion' as const,
      id: assertion.id,
      authority: assertion.authority_state === 'canonical' && assertion.lifecycle_state === 'active'
        ? 'canonical_compiled_truth' as const
        : 'source_or_timeline_evidence' as const,
      source_refs: assertion.source_refs,
      lifecycle_state: assertion.lifecycle_state,
    })),
    ...handoffs.map((handoff) => ({
      kind: 'canonical_handoff' as const,
      id: handoff.id,
      authority: 'source_or_timeline_evidence' as const,
      source_refs: handoff.source_refs,
    })),
  ];
}

function rejectedAlternatives(
  decision: DecisionProjectionTaskDecision,
  attempts: DecisionProjectionTaskAttempt[],
  candidates: DecisionProjectionMemoryCandidate[],
  canonicalTarget: string | null,
) {
  const failedAttempts = attempts
    .filter((attempt) => attempt.outcome === 'failed')
    .filter((attempt) => anchorsOverlap(decision.validity_context, attempt.applicability_context))
    .map((attempt) => ({
      source_ref: `task-attempt:${attempt.id}`,
      summary: attempt.summary,
      reason: attempt.evidence[0] ?? 'failed_attempt',
    }));
  const rejectedCandidates = candidates
    .filter((candidate) => candidate.status === 'rejected' || candidate.status === 'superseded')
    .filter((candidate) => canonicalTarget == null || candidate.target_object_id === canonicalTarget)
    .map((candidate) => ({
      source_ref: `memory-candidate:${candidate.id}`,
      summary: candidate.proposed_content,
      reason: candidate.review_reason ?? `candidate_${candidate.status}`,
    }));

  return [...failedAttempts, ...rejectedCandidates];
}

function assertionMatchesDecision(
  assertion: DecisionProjectionAssertionRecord,
  decision: DecisionProjectionTaskDecision,
  canonicalTarget: string | null,
): boolean {
  const decisionScopeId = stringField(decision.validity_context, 'scope_id');
  if (!decisionScopeId || assertion.scope_id !== decisionScopeId) return false;
  if (canonicalTarget && assertion.target_id === canonicalTarget) return true;
  return normalize(assertion.claim_text) === normalize(decision.summary);
}

function revalidationPath(
  context: ProjectionAnchors,
  assertion: DecisionProjectionAssertionRecord | undefined,
): DecisionProjectionRevalidationPath {
  const fromContext = stringField(context, 'revalidation_path');
  if (isRevalidationPath(fromContext)) return fromContext;
  if (assertion?.lifecycle_state === 'stale') return 'reverify_code';
  if (assertion) return 'read_canonical';
  return 'review_candidate';
}

function reversibility(context: ProjectionAnchors): DecisionProjectionReversibility {
  const value = stringField(context, 'reversibility');
  if (
    value === 'reversible'
    || value === 'hard_to_reverse'
    || value === 'irreversible'
    || value === 'unknown'
  ) {
    return value;
  }
  return 'unknown';
}

function anchorsOverlap(left: ProjectionAnchors, right: ProjectionAnchors): boolean {
  const anchorEntries = Object.entries(right)
    .filter(([key, value]) => !isMetadataAnchor(key) && isScalarAnchorValue(value));
  if (anchorEntries.length === 0) return false;
  for (const [key, value] of anchorEntries) {
    if (left[key] !== value) return false;
  }
  return true;
}

function isScalarAnchorValue(value: unknown): value is string | number | boolean {
  return typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean';
}

function stringField(record: ProjectionAnchors, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringArrayField(record: ProjectionAnchors, key: string): string[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function isRevalidationPath(value: string | null): value is DecisionProjectionRevalidationPath {
  return value === 'none'
    || value === 'read_canonical'
    || value === 'reverify_code'
    || value === 'review_candidate'
    || value === 'evaluate_scope_gate';
}

function isMetadataAnchor(key: string): boolean {
  return key === 'valid_until'
    || key === 'reopen_if'
    || key === 'canonical_target'
    || key === 'target_snapshot_hash'
    || key === 'revalidation_path'
    || key === 'reversibility'
    || key === 'affected_selectors';
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}
