import {
  canonicalJson,
  normalizeScalar,
  stableId,
  type AssertionAuthorityState,
  type AssertionEventRecord,
  type AssertionEvidenceRecord,
  type AssertionLineageRecord,
  type AssertionLinkRecord,
  type AssertionRecord,
  type AssertionLifecycleState,
  type ConflictSetAssertionRecord,
  type ConflictSetRecord,
  type ExtractedClaim,
} from './assertion-types.ts';
import {
  buildAssertionEvidence,
  recomputeAssertionEvidenceSummary,
} from './assertion-evidence.ts';

export interface ResolveExtractedClaimInput {
  claim: ExtractedClaim;
  existing_assertions?: readonly AssertionRecord[];
  existing_evidence?: readonly AssertionEvidenceRecord[];
  target_type?: string;
  target_id?: string;
  target_slug?: string | null;
  authority_state?: AssertionAuthorityState;
  session_id?: string | null;
  task_event_id?: string | null;
  actor?: string;
  job_id?: string | null;
  now?: string;
}

export interface AssertionResolutionResult {
  resolution: 'created' | 'duplicate' | 'superseded' | 'conflicted' | 'rejected';
  assertion: AssertionRecord;
  updated_assertions: AssertionRecord[];
  evidence: AssertionEvidenceRecord[];
  events: AssertionEventRecord[];
  lineage: AssertionLineageRecord[];
  links: AssertionLinkRecord[];
  conflict_sets: ConflictSetRecord[];
  conflict_set_assertions: ConflictSetAssertionRecord[];
  extracted_claim: ExtractedClaim;
}

export type AssertionRetrievalMode = 'default' | 'audit';
export type AssertionRetrievalActivation = 'answer_ground' | 'verify_first' | 'audit_only';

export interface AssertionRetrievalPlan {
  assertion: AssertionRecord;
  activation: AssertionRetrievalActivation;
  content_visible: boolean;
  reason_codes: string[];
  lifecycle_events?: Array<{
    id: string;
    event_type: string;
    from_lifecycle_state: AssertionLifecycleState | null;
    to_lifecycle_state: AssertionLifecycleState | null;
    reason: string;
    created_at: string;
  }>;
  tombstone?: {
    id: string;
    reason: string;
    content_hash: string | null;
    created_at: string;
  } | null;
}

export function resolveExtractedClaim(input: ResolveExtractedClaimInput): AssertionResolutionResult {
  const now = input.now ?? new Date().toISOString();
  const claim = { ...input.claim, status: 'resolved' as const };
  const targetType = input.target_type ?? inferTargetType(claim.target_hint);
  const targetId = input.target_id ?? claim.target_hint;
  const targetSlug = input.target_slug ?? null;
  const matching = (input.existing_assertions ?? [])
    .filter((assertion) => sameTargetProperty(assertion, targetType, targetId, claim.property_hint))
    .filter(isResolutionCurrentAssertion);
  const duplicate = matching.find((assertion) => normalizeScalar(assertion.value_json) === normalizeScalar(claim.value_json));
  if (duplicate) {
    const evidence = buildAssertionEvidence({
      assertion_id: duplicate.id,
      extracted_claim: claim,
      session_id: input.session_id,
      task_event_id: input.task_event_id,
      created_at: now,
    });
    const allEvidence = [...(input.existing_evidence ?? []).filter((entry) => entry.assertion_id === duplicate.id), evidence];
    const assertion = recomputeAssertionEvidenceSummary(duplicate, allEvidence);
    return result({
      resolution: 'duplicate',
      assertion,
      evidence: [evidence],
      events: [assertionEvent(assertion, 'evidence_added', 'duplicate claim linked to existing assertion', now, input)],
      lineage: [lineage(assertion.id, claim, input, now)],
      links: [],
      conflict_sets: [],
      conflict_set_assertions: [],
      extracted_claim: claim,
    });
  }

  const superseded = matching.find((assertion) => shouldSupersede(assertion, claim));
  const conflict = !superseded && matching.length > 0;
  const assertion = newAssertion({
    claim,
    target_type: targetType,
    target_id: targetId,
    target_slug: targetSlug,
    authority_state: conflict ? 'conflicted' : input.authority_state ?? 'canonical',
    conflict_set_id: conflict ? stableId('conflict-set', targetType, targetId, claim.property_hint) : null,
    supersedes_assertion_id: superseded?.id ?? null,
    now,
  });
  const evidence = buildAssertionEvidence({
    assertion_id: assertion.id,
    extracted_claim: claim,
    session_id: input.session_id,
    task_event_id: input.task_event_id,
    created_at: now,
  });
  const hydratedAssertion = recomputeAssertionEvidenceSummary(assertion, [evidence]);
  const updatedAssertions = superseded
    ? [{
      ...superseded,
      lifecycle_state: 'expired' as const,
      superseded_by_assertion_id: hydratedAssertion.id,
      updated_at: now,
    }]
    : conflict
      ? matching.map((assertionRecord) => ({
        ...assertionRecord,
        authority_state: 'conflicted' as const,
        conflict_set_id: assertion.conflict_set_id,
        updated_at: now,
      }))
      : [];
  const conflictSets = conflict
    ? [conflictSet(targetType, targetId, claim.property_hint, now)]
    : [];
  const conflictSetAssertions = conflict
    ? [
      ...matching.map((assertionRecord) => ({
        conflict_set_id: assertion.conflict_set_id as string,
        assertion_id: assertionRecord.id,
        role: 'existing',
        created_at: now,
      })),
      {
        conflict_set_id: assertion.conflict_set_id as string,
        assertion_id: hydratedAssertion.id,
        role: 'new_claim',
        created_at: now,
      },
    ]
    : [];

  return result({
    resolution: conflict ? 'conflicted' : superseded ? 'superseded' : 'created',
    assertion: hydratedAssertion,
    updated_assertions: updatedAssertions,
    evidence: [evidence],
    events: [
      assertionEvent(
        hydratedAssertion,
        conflict ? 'conflict_created' : superseded ? 'superseded_previous' : 'created',
        conflict ? 'incompatible claim for target property' : superseded ? 'newer temporal claim superseded prior assertion' : 'claim resolved into assertion',
        now,
        input,
      ),
      ...(superseded ? [assertionLifecycleTransitionEvent(
        superseded,
        hydratedAssertion.id,
        'expired',
        'superseded assertion expired by newer temporal claim',
        now,
        input,
      )] : []),
    ],
    lineage: [lineage(hydratedAssertion.id, claim, input, now)],
    links: superseded ? [{
      id: stableId('assertion-link', hydratedAssertion.id, superseded.id, 'supersedes'),
      from_assertion_id: hydratedAssertion.id,
      to_assertion_id: superseded.id,
      link_type: 'supersedes',
      created_at: now,
    }] : [],
    conflict_sets: conflictSets,
    conflict_set_assertions: conflictSetAssertions,
    extracted_claim: claim,
  });
}

export function filterRetrievableAssertions(
  assertions: readonly AssertionRecord[],
  options: {
    mode?: AssertionRetrievalMode;
    include_candidates?: boolean;
    include_stale?: boolean;
    include_expired?: boolean;
    include_rejected?: boolean;
  } = {},
): AssertionRecord[] {
  if (!options.mode) {
    return assertions.filter((assertion) => {
      const defaultPlan = planRetrievableAssertion(assertion, {
        mode: 'default',
        include_candidates: options.include_candidates === true,
        include_rejected: options.include_rejected === true,
      });
      if (defaultPlan?.content_visible) {
        return options.include_stale !== false || assertion.lifecycle_state !== 'stale';
      }
      return options.include_expired === true && isLegacyExpiredRetrievableAssertion(assertion, options);
    });
  }

  return planRetrievableAssertions(assertions, {
    mode: options.mode,
    include_candidates: options.include_candidates,
    include_rejected: options.include_rejected,
  })
    .filter((entry) => entry.content_visible)
    .filter((entry) => options.include_stale !== false || entry.assertion.lifecycle_state !== 'stale')
    .map((entry) => entry.assertion);
}

export function planRetrievableAssertions(
  assertions: readonly AssertionRecord[],
  options: {
    mode?: AssertionRetrievalMode;
    include_candidates?: boolean;
    include_rejected?: boolean;
  } = {},
): AssertionRetrievalPlan[] {
  const mode = options.mode ?? 'default';
  const plans: AssertionRetrievalPlan[] = [];
  for (const assertion of assertions) {
    const plan = planRetrievableAssertion(assertion, {
      mode,
      include_candidates: options.include_candidates === true,
      include_rejected: options.include_rejected === true,
    });
    if (plan) plans.push(plan);
  }
  return plans;
}

function planRetrievableAssertion(
  assertion: AssertionRecord,
  options: {
    mode: AssertionRetrievalMode;
    include_candidates: boolean;
    include_rejected: boolean;
  },
): AssertionRetrievalPlan | null {
  if (assertion.lifecycle_state === 'purged') {
    return options.mode === 'audit'
      ? retrievalPlan(redactedPurgedAssertion(assertion), 'audit_only', ['purged_tombstone_only'], false)
      : null;
  }

  if (assertion.authority_state === 'canonical') {
    if (assertion.lifecycle_state === 'active') {
      return retrievalPlan(assertion, 'answer_ground', ['canonical_active']);
    }
    if (assertion.lifecycle_state === 'stale') {
      return retrievalPlan(assertion, 'verify_first', [
        'canonical_stale',
        ...(assertion.claim_type === 'code_claim' ? ['code_claim'] : []),
      ]);
    }
    if (options.mode === 'audit' && (assertion.lifecycle_state === 'expired' || assertion.lifecycle_state === 'archived')) {
      return retrievalPlan(assertion, 'audit_only', [`canonical_${assertion.lifecycle_state}`]);
    }
    return null;
  }

  if (assertion.authority_state === 'conflicted') {
    if (assertion.lifecycle_state === 'active' || assertion.lifecycle_state === 'stale') {
      return retrievalPlan(assertion, 'verify_first', ['conflicted_assertion']);
    }
    if (options.mode === 'audit' && (assertion.lifecycle_state === 'expired' || assertion.lifecycle_state === 'archived')) {
      return retrievalPlan(assertion, 'audit_only', ['conflicted_assertion', `lifecycle_${assertion.lifecycle_state}`]);
    }
    return null;
  }

  if (assertion.authority_state === 'candidate' && options.include_candidates) {
    if (assertion.lifecycle_state === 'active' || assertion.lifecycle_state === 'stale') {
      return retrievalPlan(assertion, 'verify_first', ['candidate_requested']);
    }
    if (options.mode === 'audit' && (assertion.lifecycle_state === 'expired' || assertion.lifecycle_state === 'archived')) {
      return retrievalPlan(assertion, 'audit_only', ['candidate_requested', `lifecycle_${assertion.lifecycle_state}`]);
    }
    return null;
  }

  if (assertion.authority_state === 'rejected' && (options.mode === 'audit' || options.include_rejected)) {
    if (options.mode === 'audit' || assertion.lifecycle_state === 'active' || assertion.lifecycle_state === 'stale') {
      return retrievalPlan(assertion, 'audit_only', ['rejected_audit']);
    }
    return null;
  }

  return null;
}

function isLegacyExpiredRetrievableAssertion(
  assertion: AssertionRecord,
  options: {
    include_candidates?: boolean;
    include_rejected?: boolean;
  },
): boolean {
  if (assertion.lifecycle_state !== 'expired') return false;
  if (assertion.authority_state === 'canonical' || assertion.authority_state === 'conflicted') return true;
  if (assertion.authority_state === 'candidate') return options.include_candidates === true;
  if (assertion.authority_state === 'rejected') return options.include_rejected === true;
  return false;
}

function retrievalPlan(
  assertion: AssertionRecord,
  activation: AssertionRetrievalActivation,
  reasonCodes: string[],
  contentVisible = true,
): AssertionRetrievalPlan {
  return {
    assertion,
    activation,
    content_visible: contentVisible,
    reason_codes: reasonCodes,
  };
}

function redactedPurgedAssertion(assertion: AssertionRecord): AssertionRecord {
  return {
    ...assertion,
    value_json: {},
    normalized_claim: '[purged assertion content removed]',
    authority_summary: { purged: 1 },
    confidence: 0,
    evidence_count: 0,
  };
}

function result(input: Omit<AssertionResolutionResult, 'updated_assertions'> & {
  updated_assertions?: AssertionRecord[];
}): AssertionResolutionResult {
  return {
    updated_assertions: [],
    ...input,
  };
}

function sameTargetProperty(
  assertion: AssertionRecord,
  targetType: string,
  targetId: string,
  property: string,
): boolean {
  return assertion.target_type === targetType
    && assertion.target_id === targetId
    && assertion.property === property;
}

function shouldSupersede(assertion: AssertionRecord, claim: ExtractedClaim): boolean {
  if (!claim.valid_from || !assertion.valid_from) return false;
  return new Date(claim.valid_from).getTime() > new Date(assertion.valid_from).getTime();
}

function isResolutionCurrentAssertion(assertion: AssertionRecord): boolean {
  return assertion.lifecycle_state !== 'expired'
    && assertion.lifecycle_state !== 'archived'
    && assertion.lifecycle_state !== 'purged';
}

function newAssertion(input: {
  claim: ExtractedClaim;
  target_type: string;
  target_id: string;
  target_slug: string | null;
  authority_state: AssertionAuthorityState;
  conflict_set_id: string | null;
  supersedes_assertion_id: string | null;
  now: string;
}): AssertionRecord {
  return {
    id: stableId(
      'assertion',
      input.target_type,
      input.target_id,
      input.claim.property_hint,
      canonicalJson(input.claim.value_json),
      input.claim.valid_from ?? '',
    ),
    claim_type: input.claim.claim_type,
    target_type: input.target_type,
    target_id: input.target_id,
    target_slug: input.target_slug,
    property: input.claim.property_hint,
    value_json: input.claim.value_json,
    normalized_claim: normalizeClaim(input.claim),
    authority_summary: {},
    confidence: input.claim.confidence,
    evidence_count: 0,
    authority_state: input.authority_state,
    lifecycle_state: 'active',
    valid_from: input.claim.valid_from,
    valid_until: input.claim.valid_until,
    supersedes_assertion_id: input.supersedes_assertion_id,
    superseded_by_assertion_id: null,
    conflict_set_id: input.conflict_set_id,
    created_at: input.now,
    updated_at: input.now,
  };
}

function normalizeClaim(claim: ExtractedClaim): string {
  return [
    claim.claim_type,
    claim.target_hint,
    claim.property_hint,
    normalizeScalar(claim.value_json),
  ].join(':');
}

function assertionEvent(
  assertion: AssertionRecord,
  eventType: string,
  reason: string,
  now: string,
  input: ResolveExtractedClaimInput,
): AssertionEventRecord {
  return {
    id: stableId('assertion-event', assertion.id, eventType, now),
    assertion_id: assertion.id,
    event_type: eventType,
    from_authority_state: null,
    to_authority_state: assertion.authority_state,
    from_lifecycle_state: null,
    to_lifecycle_state: assertion.lifecycle_state,
    reason,
    source_refs_json: [`extracted-claim:${input.claim.id}`, `source-chunk:${input.claim.source_chunk_id}`],
    actor: input.actor ?? 'mbrain:assertion_pipeline',
    job_id: input.job_id ?? input.claim.runner_job_id,
    created_at: now,
  };
}

function assertionLifecycleTransitionEvent(
  assertion: AssertionRecord,
  supersededByAssertionId: string,
  toLifecycleState: AssertionLifecycleState,
  reason: string,
  now: string,
  input: ResolveExtractedClaimInput,
): AssertionEventRecord {
  return {
    id: stableId('assertion-event', assertion.id, `lifecycle_${assertion.lifecycle_state}_to_${toLifecycleState}`, now),
    assertion_id: assertion.id,
    event_type: 'assertion_lifecycle_transition',
    from_authority_state: assertion.authority_state,
    to_authority_state: assertion.authority_state,
    from_lifecycle_state: assertion.lifecycle_state,
    to_lifecycle_state: toLifecycleState,
    reason,
    source_refs_json: [
      `extracted-claim:${input.claim.id}`,
      `source-chunk:${input.claim.source_chunk_id}`,
      `superseded-by:${supersededByAssertionId}`,
    ],
    actor: input.actor ?? 'mbrain:assertion_pipeline',
    job_id: input.job_id ?? input.claim.runner_job_id,
    created_at: now,
  };
}

function lineage(
  assertionId: string,
  claim: ExtractedClaim,
  input: ResolveExtractedClaimInput,
  now: string,
): AssertionLineageRecord {
  return {
    id: stableId('assertion-lineage', assertionId, claim.id),
    assertion_id: assertionId,
    extracted_claim_id: claim.id,
    source_id: claim.source_id,
    source_item_id: claim.source_item_id,
    source_chunk_id: claim.source_chunk_id,
    session_id: input.session_id ?? null,
    task_event_id: input.task_event_id ?? null,
    created_at: now,
  };
}

function conflictSet(targetType: string, targetId: string, property: string, now: string): ConflictSetRecord {
  return {
    id: stableId('conflict-set', targetType, targetId, property),
    target_type: targetType,
    target_id: targetId,
    property,
    status: 'open',
    created_at: now,
    updated_at: now,
  };
}

function inferTargetType(targetHint: string): string {
  if (targetHint.startsWith('systems/')) return 'system';
  if (targetHint.startsWith('brain/')) return 'page';
  if (targetHint.startsWith('task:')) return 'task';
  if (targetHint.startsWith('profile:')) return 'profile';
  return 'entity';
}
