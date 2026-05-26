import {
  stableId,
  type AssertionAuthorityState,
  type AssertionContributionType,
  type AssertionEvidenceRecord,
  type AssertionEventRecord,
  type AssertionEvidenceInput as DirectAssertionEvidenceInput,
  type AssertionRecord,
  type ExtractedClaim,
} from './assertion-types.ts';

export interface AssertionEvidenceInput {
  assertion_id: string;
  extracted_claim: ExtractedClaim;
  session_id?: string | null;
  task_event_id?: string | null;
  contribution_type?: AssertionContributionType;
  evidence_authority?: string;
  created_at?: string;
}

export interface EvidenceSummary {
  authority_summary: Record<string, number>;
  confidence: number;
  evidence_count: number;
  authority_state: AssertionAuthorityState;
}

export function buildAssertionEvidence(input: AssertionEvidenceInput): AssertionEvidenceRecord {
  const createdAt = input.created_at ?? input.extracted_claim.created_at;
  return {
    id: stableId(
      'assertion-evidence',
      input.assertion_id,
      input.extracted_claim.id,
      input.contribution_type ?? 'supports',
    ),
    assertion_id: input.assertion_id,
    extracted_claim_id: input.extracted_claim.id,
    source_id: input.extracted_claim.source_id,
    source_item_id: input.extracted_claim.source_item_id,
    source_chunk_id: input.extracted_claim.source_chunk_id,
    session_id: input.session_id ?? null,
    task_event_id: input.task_event_id ?? null,
    contribution_type: input.contribution_type ?? 'supports',
    evidence_authority: input.evidence_authority ?? 'source_claim',
    evidence_confidence: input.extracted_claim.confidence,
    valid_from: input.extracted_claim.valid_from,
    valid_until: input.extracted_claim.valid_until,
    revocation_state: 'active',
    forgetting_state: 'retained',
    created_at: createdAt,
  };
}

export function summarizeAssertionEvidence(
  assertion: Pick<AssertionRecord, 'authority_state'>,
  evidence: readonly AssertionEvidenceRecord[],
): EvidenceSummary {
  const usable = evidence.filter((entry) => (
    entry.contribution_type === 'supports'
    && entry.revocation_state === 'active'
    && entry.forgetting_state === 'retained'
  ));
  const authoritySummary: Record<string, number> = {};
  for (const entry of usable) {
    authoritySummary[entry.evidence_authority] = (authoritySummary[entry.evidence_authority] ?? 0) + 1;
  }
  const confidence = usable.length === 0
    ? 0
    : roundConfidence(usable.reduce((sum, entry) => sum + entry.evidence_confidence, 0) / usable.length);

  return {
    authority_summary: authoritySummary,
    confidence,
    evidence_count: usable.length,
    authority_state: usable.length === 0 ? 'candidate' : assertion.authority_state,
  };
}

export function recomputeAssertionEvidenceSummary(
  assertion: AssertionRecord,
  evidence: readonly AssertionEvidenceRecord[],
): AssertionRecord {
  const summary = summarizeAssertionEvidence(assertion, evidence);
  return {
    ...assertion,
    authority_summary: summary.authority_summary,
    confidence: summary.confidence,
    evidence_count: summary.evidence_count,
    authority_state: summary.authority_state,
  };
}

export function reResolveEvidenceForSourceState(
  evidence: readonly AssertionEvidenceRecord[],
  input: {
    revoked_source_ids?: readonly string[];
    purged_source_ids?: readonly string[];
    expired_source_chunk_ids?: readonly string[];
    purged_source_chunk_ids?: readonly string[];
  },
): AssertionEvidenceRecord[] {
  const revoked = new Set(input.revoked_source_ids ?? []);
  const purged = new Set(input.purged_source_ids ?? []);
  const expiredChunks = new Set(input.expired_source_chunk_ids ?? []);
  const purgedChunks = new Set(input.purged_source_chunk_ids ?? []);
  return evidence.map((entry) => {
    if (purged.has(entry.source_id) || purgedChunks.has(entry.source_chunk_id)) {
      return { ...entry, revocation_state: 'source_purged', forgetting_state: 'purged' };
    }
    if (expiredChunks.has(entry.source_chunk_id)) {
      return { ...entry, forgetting_state: 'expired' };
    }
    if (revoked.has(entry.source_id)) {
      return { ...entry, revocation_state: 'source_revoked' };
    }
    return entry;
  });
}

export function reResolveAssertionForSourceState(
  assertion: AssertionRecord,
  evidence: readonly AssertionEvidenceRecord[],
  input: {
    revoked_source_ids?: readonly string[];
    purged_source_ids?: readonly string[];
    expired_source_chunk_ids?: readonly string[];
    purged_source_chunk_ids?: readonly string[];
  },
): { assertion: AssertionRecord; evidence: AssertionEvidenceRecord[] } {
  const nextEvidence = reResolveEvidenceForSourceState(evidence, input);
  return {
    assertion: recomputeAssertionEvidenceSummary(assertion, nextEvidence),
    evidence: nextEvidence,
  };
}

export interface AssertionEvidenceService {
  createAssertion(input: AssertionRecord): Promise<AssertionRecord>;
  getAssertion(id: string): Promise<AssertionRecord | null>;
  linkEvidence(input: DirectAssertionEvidenceInput): Promise<AssertionEvidenceRecord>;
  listAssertionEvidence(
    assertionId: string,
    options?: { include_revoked?: boolean },
  ): Promise<AssertionEvidenceRecord[]>;
  recomputeAssertionEvidenceSummary(assertionId: string): Promise<AssertionEvidenceSummary>;
  revokeSourceEvidence(input: {
    source_id: string;
    reason: string;
    actor: string;
    revoked_at: string;
  }): Promise<{ affected_assertion_ids: string[]; events: AssertionEventRecord[] }>;
}

export interface AssertionEvidenceSummary {
  assertion_id: string;
  evidence_count: number;
  active_support_count: number;
  active_contradiction_count: number;
  revoked_evidence_count: number;
  authority_summary: string;
  confidence: number;
  authority_state: AssertionAuthorityState;
  events: AssertionEventRecord[];
}

export function createAssertionEvidenceService(input: {
  now: () => string;
}): AssertionEvidenceService {
  const assertions = new Map<string, AssertionRecord>();
  const evidence = new Map<string, AssertionEvidenceRecord>();
  const events: AssertionEventRecord[] = [];

  return {
    async createAssertion(assertion) {
      assertions.set(assertion.id, { ...assertion });
      return { ...assertion };
    },
    async getAssertion(id) {
      const assertion = assertions.get(id);
      return assertion ? { ...assertion } : null;
    },
    async linkEvidence(entryInput) {
      const entry = directEvidence(entryInput, input.now());
      evidence.set(entry.id, entry);
      return { ...entry };
    },
    async listAssertionEvidence(assertionId, options = {}) {
      return [...evidence.values()]
        .filter((entry) => entry.assertion_id === assertionId)
        .filter((entry) => options.include_revoked || entry.revocation_state === 'active')
        .map((entry) => ({ ...entry }));
    },
    async recomputeAssertionEvidenceSummary(assertionId) {
      const assertion = assertions.get(assertionId);
      if (!assertion) throw new Error(`assertion not found: ${assertionId}`);
      const allEvidence = [...evidence.values()].filter((entry) => entry.assertion_id === assertionId);
      const summary = evidenceServiceSummary(assertion, allEvidence, events);
      assertions.set(assertionId, {
        ...assertion,
        evidence_count: summary.evidence_count,
        authority_summary: summary.authority_summary,
        confidence: summary.confidence,
        authority_state: summary.authority_state,
        updated_at: input.now(),
      });
      const event = serviceEvent(assertionId, 'evidence_summary_recomputed', 'assertion evidence summary recomputed', input.now(), 'mbrain:assertion_evidence');
      events.push(event);
      return { ...summary, events: [...summary.events, event] };
    },
    async revokeSourceEvidence(revocation) {
      const affected = new Set<string>();
      for (const [id, entry] of evidence.entries()) {
        if (entry.source_id !== revocation.source_id || entry.revocation_state !== 'active') continue;
        affected.add(entry.assertion_id);
        evidence.set(id, {
          ...entry,
          revocation_state: 'revoked',
          valid_until: revocation.revoked_at,
        });
      }
      const revokeEvents = [...affected].map((assertionId) => serviceEvent(
        assertionId,
        'evidence_revoked',
        revocation.reason,
        revocation.revoked_at,
        revocation.actor,
      ));
      events.push(...revokeEvents);
      return { affected_assertion_ids: [...affected], events: revokeEvents };
    },
  };
}

function directEvidence(input: DirectAssertionEvidenceInput, now: string): AssertionEvidenceRecord {
  return {
    id: input.id ?? stableId('assertion-evidence', input.assertion_id, input.extracted_claim_id, input.contribution_type),
    assertion_id: input.assertion_id,
    extracted_claim_id: input.extracted_claim_id,
    source_id: input.source_id,
    source_item_id: input.source_item_id,
    source_chunk_id: input.source_chunk_id,
    session_id: input.session_id ?? null,
    task_event_id: input.task_event_id ?? null,
    contribution_type: input.contribution_type,
    evidence_authority: input.evidence_authority,
    evidence_confidence: input.evidence_confidence,
    valid_from: input.valid_from ?? null,
    valid_until: input.valid_until ?? null,
    revocation_state: 'active',
    forgetting_state: 'retained',
    created_at: now,
  };
}

function evidenceServiceSummary(
  assertion: AssertionRecord,
  entries: readonly AssertionEvidenceRecord[],
  events: readonly AssertionEventRecord[],
): AssertionEvidenceSummary {
  const active = entries.filter((entry) => entry.revocation_state === 'active' && entry.forgetting_state === 'retained');
  const supports = active.filter((entry) => entry.contribution_type === 'supports');
  const contradictions = active.filter((entry) => entry.contribution_type === 'contradicts');
  const confidence = supports.length === 0
    ? 0
    : roundConfidence(supports.reduce((sum, entry) => sum + entry.evidence_confidence, 0) / supports.length);
  return {
    assertion_id: assertion.id,
    evidence_count: active.length,
    active_support_count: supports.length,
    active_contradiction_count: contradictions.length,
    revoked_evidence_count: entries.filter((entry) => entry.revocation_state !== 'active').length,
    authority_summary: authoritySummaryFor(supports),
    confidence,
    authority_state: contradictions.length > 0 ? 'conflicted' : assertion.authority_state,
    events: events.filter((event) => event.assertion_id === assertion.id),
  };
}

function authoritySummaryFor(supports: readonly AssertionEvidenceRecord[]): string {
  const authorities = new Set(supports.map((entry) => entry.evidence_authority));
  if (authorities.has('user_direct') && authorities.has('session_derived')) {
    return 'supported_by_user_direct_and_session';
  }
  if (authorities.has('session_derived')) return 'supported_by_session_only';
  if (authorities.has('user_direct')) return 'supported_by_user_direct';
  if (supports.length === 0) return 'unsupported';
  return 'supported_by_evidence';
}

function serviceEvent(
  assertionId: string,
  eventType: string,
  reason: string,
  createdAt: string,
  actor: string,
): AssertionEventRecord {
  return {
    id: stableId('assertion-event', assertionId, eventType, createdAt),
    assertion_id: assertionId,
    event_type: eventType,
    from_authority_state: null,
    to_authority_state: null,
    from_lifecycle_state: null,
    to_lifecycle_state: null,
    reason,
    source_refs_json: [],
    actor,
    job_id: null,
    created_at: createdAt,
  };
}

function roundConfidence(value: number): number {
  return Math.round(value * 1000) / 1000;
}
