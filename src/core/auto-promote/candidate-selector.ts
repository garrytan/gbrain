import type { MemoryCandidateEntry } from '../types.ts';
import type { AutoPromoteConfig } from './config.ts';

export interface SelectionResult {
  low_risk: MemoryCandidateEntry[];
  risky: MemoryCandidateEntry[];
  excluded: { candidate: MemoryCandidateEntry; reason: string }[];
}

export type AutoPromoteLane = 'canonical_eligible' | 'handoff_only' | 'excluded';

export interface AutoPromoteLaneDecision {
  lane: AutoPromoteLane;
  reason?: string;
}

export function selectAutoPromoteCandidates(
  candidates: MemoryCandidateEntry[],
  policy: AutoPromoteConfig,
): SelectionResult {
  const result: SelectionResult = { low_risk: [], risky: [], excluded: [] };
  for (const c of candidates) {
    // Only act on not-yet-decided candidates.
    if (c.status !== 'captured' && c.status !== 'candidate') continue;

    const decision = classifyAutoPromoteLane(c, policy);
    if (decision.lane === 'canonical_eligible') {
      result.low_risk.push(c);
    } else if (decision.lane === 'handoff_only') {
      result.risky.push(c);
    } else {
      result.excluded.push({ candidate: c, reason: decision.reason ?? 'excluded' });
    }
  }
  return result;
}

export function classifyAutoPromoteLane(
  c: MemoryCandidateEntry,
  policy: AutoPromoteConfig,
): AutoPromoteLaneDecision {
  if (!c.scope_id) {
    return { lane: 'excluded', reason: 'scope_not_clear' };
  }

  if (!hasSourceRefs(c)) {
    return { lane: 'excluded', reason: 'source_refs_missing' };
  }

  if (!c.target_object_type || c.target_object_type === 'other' || !c.target_object_id) {
    return { lane: 'excluded', reason: 'target_not_clear' };
  }
  if (c.target_object_type !== 'curated_note') {
    return { lane: 'excluded', reason: 'target_not_page_backed' };
  }
  if (!policy.eligibility.sensitivities.includes(c.sensitivity as AutoPromoteConfig['eligibility']['sensitivities'][number])) {
    return { lane: 'excluded', reason: `sensitivity_excluded:${c.sensitivity}` };
  }

  if (c.candidate_type !== 'fact') {
    return { lane: 'handoff_only', reason: `candidate_type_handoff_only:${c.candidate_type}` };
  }

  if (c.generated_by === 'dream_cycle') {
    return { lane: 'handoff_only', reason: 'generated_by_handoff_only:dream_cycle' };
  }
  const evidence = evidenceKindFor(c.extraction_kind);
  if (evidence === 'risky') {
    return { lane: 'handoff_only', reason: `evidence_handoff_only:risky_${c.extraction_kind}` };
  }
  if (!policy.eligibility.evidence_kinds.includes(evidence)) {
    return { lane: 'excluded', reason: `evidence_excluded:${evidence}` };
  }

  return { lane: 'canonical_eligible' };
}

function evidenceKindFor(extractionKind: string): 'direct_user_statement' | 'source_extracted' | 'risky' {
  if (extractionKind === 'manual') return 'direct_user_statement';
  if (extractionKind === 'extracted') return 'source_extracted';
  return 'risky'; // inferred | ambiguous
}

function hasSourceRefs(candidate: MemoryCandidateEntry): boolean {
  return Array.isArray(candidate.source_refs)
    && candidate.source_refs.some((ref) => typeof ref === 'string' && ref.trim().length > 0);
}
