import type { BrainEngine } from '../engine.ts';
import type {
  CandidateSignal,
  CandidateSignalPolicy,
  CandidateSignalPolicyMode,
  MemoryCandidateEntry,
  MemoryScenario,
  MemoryScenarioKnownSubject,
  RetrieveContextCandidate,
  RetrievalSelector,
  ScopeGateScope,
} from '../types.ts';

export interface CandidateSignalResult {
  candidate_signal_policy: CandidateSignalPolicy;
  candidate_signals: CandidateSignal[];
}

export interface CandidateSignalPolicyInput {
  query?: string;
  scenario: MemoryScenario;
  requested_scope?: Exclude<ScopeGateScope, 'unknown'>;
  scope_id?: string;
}

export interface BuildCandidateSignalsInput extends CandidateSignalPolicyInput {
  required_reads: RetrievalSelector[];
  canonical_candidates: RetrieveContextCandidate[];
  known_subjects?: Array<string | MemoryScenarioKnownSubject>;
  limit: number;
  now?: Date;
}

type CandidateSignalEngine = Pick<
  BrainEngine,
  'listMemoryCandidateEntries' | 'listCanonicalHandoffEntries'
>;

const NORMAL_CAP = 3;
const EXPANDED_CAP = 10;
const AUDIT_CAP = 20;
const DEFAULT_WORKSPACE_CANDIDATE_SCOPE_ID = 'workspace:default';
const DEFAULT_PERSONAL_CANDIDATE_SCOPE_ID = 'personal:default';

export function emptyCandidateSignalResult(
  mode: CandidateSignalPolicyMode = 'normal',
  reason_codes: string[] = ['no_candidate_signal_scan'],
): CandidateSignalResult {
  return {
    candidate_signal_policy: {
      mode,
      reason_codes,
      included_count: 0,
      suppressed_count: 0,
    },
    candidate_signals: [],
  };
}

export function selectCandidateSignalPolicy(input: CandidateSignalPolicyInput): CandidateSignalPolicy {
  const query = (input.query ?? '').toLowerCase();
  const reasonCodes: string[] = [];
  let mode: CandidateSignalPolicyMode = 'normal';

  if (/(^|[^a-z0-9가-힣])(canonical only|verified only|source-grounded only|정본만|검증된 것만)(?=$|[^a-z0-9가-힣])/u.test(query)) {
    mode = 'strict';
    reasonCodes.push('strict_canonical_requested');
  } else if (/(^|[^a-z0-9가-힣])(audit|review|cleanup|clean up|reject|rejected|supersede|superseded|redact|inbox cleanup|폐기|거절|정리|감사)(?=$|[^a-z0-9가-힣])/u.test(query)) {
    mode = 'audit';
    reasonCodes.push('candidate_audit_query');
  } else if (/(^|[^a-z0-9가-힣])(direction|recent|candidate|memory inbox|promotion|promote|non-canonical|방향성|최근|후보|승격|비정본)(?=$|[^a-z0-9가-힣])/u.test(query)) {
    mode = 'expanded';
    reasonCodes.push('candidate_intent_query');
  } else {
    reasonCodes.push('default_agent_retrieval');
  }

  return {
    mode,
    reason_codes: reasonCodes,
    included_count: 0,
    suppressed_count: 0,
  };
}

export async function buildCandidateSignals(
  engine: CandidateSignalEngine,
  input: BuildCandidateSignalsInput,
): Promise<CandidateSignalResult> {
  const policy = selectCandidateSignalPolicy(input);
  const allCandidates: MemoryCandidateEntry[] = [];
  const scopeId = input.scope_id ?? scopeIdForRequestedScope(input.requested_scope);

  for (const status of statusesForPolicy(policy.mode)) {
    const candidates = await engine.listMemoryCandidateEntries({
      status,
      scope_id: scopeId,
      limit: 100,
      offset: 0,
    });
    allCandidates.push(...candidates);
  }

  const candidatesWithHandoff = await findPromotedCandidatesWithHandoff(engine, allCandidates, scopeId);
  const policyCandidates = allCandidates.filter(candidate => candidateAllowedInPolicy(candidate, policy.mode));
  const matched = policyCandidates.filter(candidate => candidateMatchesInput(candidate, input, policy.mode, candidatesWithHandoff));
  const scopeSuppressed = matched.filter(candidate => !candidateAllowedByScope(candidate, input.requested_scope, scopeId, policy.mode));
  const visibleMatched = matched.filter(candidate => candidateAllowedByScope(candidate, input.requested_scope, scopeId, policy.mode));
  if (policy.mode === 'strict') {
    return {
      candidate_signal_policy: {
        ...policy,
        included_count: 0,
        suppressed_count: visibleMatched.length + scopeSuppressed.length,
      },
      candidate_signals: [],
    };
  }

  const cap = Math.min(input.limit, capForPolicy(policy.mode));
  const ranked = visibleMatched
    .map(candidate => buildSignal(candidate, input, candidatesWithHandoff.has(candidate.id)))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.candidate_id.localeCompare(right.candidate_id);
    });
  const included = ranked.slice(0, cap);

  return {
    candidate_signal_policy: {
      ...policy,
      included_count: included.length,
      suppressed_count: scopeSuppressed.length + Math.max(0, ranked.length - included.length),
    },
    candidate_signals: included,
  };
}

function candidateAllowedInPolicy(
  candidate: MemoryCandidateEntry,
  mode: CandidateSignalPolicyMode,
): boolean {
  if (mode === 'audit') return true;
  return candidate.status !== 'rejected' && candidate.status !== 'superseded';
}

function candidateAllowedByScope(
  candidate: MemoryCandidateEntry,
  requestedScope?: Exclude<ScopeGateScope, 'unknown'>,
  scopeId?: string,
  mode: CandidateSignalPolicyMode = 'normal',
): boolean {
  if (candidate.sensitivity === 'secret') {
    return false;
  }
  const effectiveScope = requestedScope ?? scopeClassForScopeId(scopeId);
  if (candidate.sensitivity === 'unknown') {
    return mode === 'audit' && effectiveScope !== 'work';
  }
  if (candidate.sensitivity === 'personal') {
    return effectiveScope === 'personal' || effectiveScope === 'mixed';
  }
  return true;
}

function statusesForPolicy(mode: CandidateSignalPolicyMode): MemoryCandidateEntry['status'][] {
  if (mode === 'audit') {
    return ['captured', 'candidate', 'staged_for_review', 'promoted', 'rejected', 'superseded'];
  }
  return ['captured', 'candidate', 'staged_for_review', 'promoted'];
}

function capForPolicy(mode: CandidateSignalPolicyMode): number {
  if (mode === 'expanded') return EXPANDED_CAP;
  if (mode === 'audit') return AUDIT_CAP;
  return NORMAL_CAP;
}

function candidateMatchesInput(
  candidate: MemoryCandidateEntry,
  input: BuildCandidateSignalsInput,
  mode: CandidateSignalPolicyMode,
  candidatesWithHandoff: Set<string>,
): boolean {
  const targets = new Set([
    ...input.required_reads.map(read => read.slug).filter((value): value is string => Boolean(value)),
    ...input.required_reads.map(read => read.object_id).filter((value): value is string => Boolean(value)),
    ...normalizeKnownSubjects(input.known_subjects),
  ]);
  if (candidate.target_object_id && targets.has(candidate.target_object_id)) return true;
  if (tokenOverlap(input.query ?? '', candidate.proposed_content) > 0) return true;
  if (knownSubjectOverlap(candidate, input.known_subjects)) return true;
  if (mode === 'audit' && (candidate.status === 'rejected' || candidate.status === 'superseded')) return true;
  return false;
}

function buildSignal(
  candidate: MemoryCandidateEntry,
  input: BuildCandidateSignalsInput,
  hasCanonicalHandoff: boolean,
): CandidateSignal {
  const sameTarget = Boolean(candidate.target_object_id && input.required_reads.some(read =>
    read.slug === candidate.target_object_id || read.object_id === candidate.target_object_id,
  ));
  const overlap = tokenOverlap(input.query ?? '', candidate.proposed_content);
  const hasProvenance = candidate.source_refs.some(ref => ref.trim().length > 0);
  const hasTarget = Boolean(candidate.target_object_type && candidate.target_object_id?.trim());
  const pressure = buildPressure(candidate, hasProvenance, hasTarget, hasCanonicalHandoff);
  const score = roundScore(
    (sameTarget ? 1 : 0)
    + Math.min(0.35, overlap)
    + statusScore(candidate.status)
    + priorityScore(candidate)
    + (hasProvenance ? 0.1 : 0),
  );

  return {
    candidate_id: candidate.id,
    status: candidate.status,
    authority: candidate.status === 'promoted'
      ? 'approved_pending_canonicalization'
      : 'unreviewed_candidate',
    activation: 'candidate_only',
    target_object_type: candidate.target_object_type,
    target_object_id: candidate.target_object_id,
    relation_to_canonical: sameTarget ? 'same_target' : (overlap > 0 ? 'adjacent' : 'unknown'),
    score,
    score_reasons: [
      ...(sameTarget ? ['same_target'] : []),
      ...(overlap > 0 ? ['query_overlap'] : []),
      `status:${candidate.status}`,
      ...(candidate.importance_score > 0 ? ['importance'] : []),
      ...(candidate.recurrence_score > 0 ? ['recurrence'] : []),
      ...(hasProvenance ? ['usable_provenance'] : []),
    ],
    promotion_hint: promotionHint(candidate, hasProvenance, hasTarget, hasCanonicalHandoff),
    disposition_hint: dispositionHint(candidate, hasProvenance),
    pressure_score: pressure.pressure_score,
    pressure_reasons: pressure.pressure_reasons,
    review_priority_hint: pressure.review_priority_hint,
    summary: signalSummary(candidate),
  };
}

function signalSummary(candidate: MemoryCandidateEntry): string {
  if (candidate.status === 'rejected' || candidate.status === 'superseded') {
    const outcome = candidate.status === 'rejected' ? 'Rejected' : 'Superseded';
    const reason = candidate.review_reason?.trim()
      ? ` Review reason: ${candidate.review_reason.trim()}.`
      : '';
    return `${outcome} candidate ${candidate.id} is hidden from default retrieval.${reason}`;
  }
  return `${candidate.status === 'promoted' ? 'Promoted candidate' : 'Unreviewed candidate'} ${candidate.id} may be relevant to this retrieval.`;
}

function promotionHint(
  candidate: MemoryCandidateEntry,
  hasProvenance: boolean,
  hasTarget: boolean,
  hasCanonicalHandoff: boolean,
): CandidateSignal['promotion_hint'] {
  if (!hasProvenance) return 'needs_provenance';
  if (!hasTarget) return 'needs_target';
  if (candidate.sensitivity === 'unknown') return 'needs_scope_decision';
  if (candidate.status === 'staged_for_review') return 'consider_preflight';
  if (candidate.status === 'candidate') return 'advance_to_review';
  if (candidate.status === 'captured') return 'inspect_candidate';
  if (candidate.status === 'promoted') {
    return hasCanonicalHandoff ? 'handoff_ready_for_curated_update' : 'already_promoted_needs_handoff';
  }
  return 'no_action';
}

function dispositionHint(
  candidate: MemoryCandidateEntry,
  hasProvenance: boolean,
): CandidateSignal['disposition_hint'] {
  if (candidate.sensitivity === 'personal' || candidate.sensitivity === 'secret') {
    return 'requires_redaction_review';
  }
  if (!hasProvenance) return 'reject_missing_provenance';
  if (candidate.status === 'rejected' || candidate.status === 'superseded') {
    return 'hide_from_default_retrieval';
  }
  if (candidate.importance_score < 0.2 && candidate.confidence_score < 0.2) {
    return 'reject_low_value';
  }
  return 'keep_candidate';
}

function buildPressure(
  candidate: MemoryCandidateEntry,
  hasProvenance: boolean,
  hasTarget: boolean,
  hasCanonicalHandoff: boolean,
): Pick<CandidateSignal, 'pressure_score' | 'pressure_reasons' | 'review_priority_hint'> {
  const pressureReasons: CandidateSignal['pressure_reasons'] = [];
  if (!hasProvenance) pressureReasons.push('missing_provenance');
  if (!hasTarget) pressureReasons.push('missing_target');
  if (candidate.status === 'promoted' && !hasCanonicalHandoff) {
    pressureReasons.push('stale_promoted_without_handoff');
  }
  if (candidate.status === 'captured' || candidate.status === 'candidate' || candidate.status === 'staged_for_review') {
    pressureReasons.push('unresolved_exposed_candidate');
  }
  if (candidate.recurrence_score >= 0.8) pressureReasons.push('high_recurrence');

  return {
    pressure_score: roundScore(Math.min(1, pressureReasons.length * 0.25)),
    pressure_reasons: pressureReasons,
    review_priority_hint: reviewPriorityHint(candidate, hasProvenance, hasTarget, hasCanonicalHandoff),
  };
}

function reviewPriorityHint(
  candidate: MemoryCandidateEntry,
  hasProvenance: boolean,
  hasTarget: boolean,
  hasCanonicalHandoff: boolean,
): CandidateSignal['review_priority_hint'] {
  if (!hasProvenance) return 'reject_missing_provenance';
  if (!hasTarget) return 'bind_target_before_review';
  if (candidate.status === 'promoted' && !hasCanonicalHandoff) return 'record_canonical_handoff';
  if (candidate.status === 'captured') return 'inspect_candidate';
  if (candidate.status === 'candidate' || candidate.status === 'staged_for_review') return 'advance_to_review';
  return 'no_priority';
}

function normalizeKnownSubjects(subjects: BuildCandidateSignalsInput['known_subjects']): string[] {
  return (subjects ?? []).map(subject => typeof subject === 'string' ? subject : subject.ref);
}

function knownSubjectOverlap(
  candidate: MemoryCandidateEntry,
  subjects: BuildCandidateSignalsInput['known_subjects'],
): boolean {
  const normalizedSubjects = normalizeKnownSubjects(subjects).flatMap(tokens);
  if (normalizedSubjects.length === 0) return false;
  const candidateTokens = new Set(tokens([
    candidate.proposed_content,
    candidate.target_object_id ?? '',
    ...candidate.source_refs,
  ].join(' ')));
  return normalizedSubjects.some(subject => candidateTokens.has(subject));
}

async function findPromotedCandidatesWithHandoff(
  engine: CandidateSignalEngine,
  candidates: MemoryCandidateEntry[],
  scopeId: string,
): Promise<Set<string>> {
  const promotedIds = candidates
    .filter(candidate => candidate.status === 'promoted')
    .map(candidate => candidate.id);
  const output = new Set<string>();
  for (const candidateId of promotedIds) {
    const handoffs = await engine.listCanonicalHandoffEntries({
      scope_id: scopeId,
      candidate_id: candidateId,
      limit: 1,
      offset: 0,
    });
    if (handoffs.length > 0) output.add(candidateId);
  }
  return output;
}

function scopeIdForRequestedScope(scope?: Exclude<ScopeGateScope, 'unknown'>): string {
  return scope === 'personal' ? DEFAULT_PERSONAL_CANDIDATE_SCOPE_ID : DEFAULT_WORKSPACE_CANDIDATE_SCOPE_ID;
}

function scopeClassForScopeId(scopeId?: string): Exclude<ScopeGateScope, 'unknown'> {
  if (scopeId?.startsWith('personal:') || scopeId === 'personal') return 'personal';
  return 'work';
}

function tokenOverlap(left: string, right: string): number {
  const leftTokens = new Set(tokens(left));
  if (leftTokens.size === 0) return 0;
  const rightTokens = new Set(tokens(right));
  let count = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) count += 1;
  }
  return count / leftTokens.size;
}

function candidateBacklogScore(candidate: MemoryCandidateEntry): number {
  return (
    candidate.importance_score * 0.5
    + candidate.confidence_score * 0.3
    + candidate.recurrence_score * 0.2
  );
}

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9가-힣/_:-]+/u)
    .filter(token => token.length >= 2);
}

function statusScore(status: MemoryCandidateEntry['status']): number {
  switch (status) {
    case 'promoted':
    case 'staged_for_review':
      return 0.2;
    case 'candidate':
      return 0.15;
    case 'captured':
      return 0.05;
    case 'rejected':
    case 'superseded':
      return 0;
  }
}

function priorityScore(candidate: MemoryCandidateEntry): number {
  return Math.min(0.1, candidate.importance_score * 0.07)
    + Math.min(0.05, candidate.recurrence_score * 0.05);
}

function roundScore(value: number): number {
  return Number(value.toFixed(6));
}
