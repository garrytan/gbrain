import type { MemoryCandidateEntry } from '../types.ts';
import type { AutoPromoteConfig } from './config.ts';

export interface SelectionResult {
  low_risk: MemoryCandidateEntry[];
  risky: MemoryCandidateEntry[];
  excluded: { candidate: MemoryCandidateEntry; reason: string }[];
}

const PAGE_BACKED = new Set(['curated_note', 'procedure', 'profile_memory', 'personal_episode']);

export function selectAutoPromoteCandidates(
  candidates: MemoryCandidateEntry[],
  policy: AutoPromoteConfig,
): SelectionResult {
  const result: SelectionResult = { low_risk: [], risky: [], excluded: [] };
  for (const c of candidates) {
    // Only act on not-yet-decided candidates.
    if (c.status !== 'captured' && c.status !== 'candidate') continue;

    if (!c.target_object_type || c.target_object_type === 'other' || !c.target_object_id || !PAGE_BACKED.has(c.target_object_type)) {
      result.excluded.push({ candidate: c, reason: 'target_not_clear' });
      continue;
    }
    if (!policy.eligibility.sensitivities.includes(c.sensitivity as AutoPromoteConfig['eligibility']['sensitivities'][number])) {
      result.excluded.push({ candidate: c, reason: `sensitivity_excluded:${c.sensitivity}` });
      continue;
    }
    const evidence = evidenceKindFor(c.extraction_kind);
    if (evidence === 'risky') {
      result.risky.push(c);
      continue;
    }
    if (!policy.eligibility.evidence_kinds.includes(evidence)) {
      result.excluded.push({ candidate: c, reason: `evidence_excluded:${evidence}` });
      continue;
    }
    result.low_risk.push(c);
  }
  return result;
}

function evidenceKindFor(extractionKind: string): 'direct_user_statement' | 'source_extracted' | 'risky' {
  if (extractionKind === 'manual') return 'direct_user_statement';
  if (extractionKind === 'extracted') return 'source_extracted';
  return 'risky'; // inferred | ambiguous
}
