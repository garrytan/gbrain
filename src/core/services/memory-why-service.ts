import type {
  MemoryActivationPolicyDecision,
  MemoryWhyCandidateRef,
  MemoryWhyInput,
  MemoryWhyReport,
  NegativeMemoryProjection,
} from '../types.ts';

export function buildMemoryWhy(input: MemoryWhyInput): MemoryWhyReport {
  const selectedSelectors = input.selected_selectors ?? [];
  const candidateRefs = omittedCandidateRefs(input);
  const revalidations = revalidationDecisions(input.activation_decisions ?? []);
  const suppressions = appliedSuppressions(input.negative_memory ?? []);
  const traceRefs = input.trace_refs ?? [];
  const authorityViolations = collectAuthorityViolations(input);

  const conciseLines = [
    `Used canonical reads: ${selectedSelectors.length}`,
    `Ignored Inbox leads: ${candidateRefs.length}${candidateRefs.length > 0 ? ' candidate_only' : ''}`,
    `Revalidated: ${revalidations.length}${revalidations.length > 0 ? ' verify_first' : ''}`,
    `Suppressed repeated work: ${suppressions.length}`,
    `Trace: ${traceRefs.length > 0 ? traceRefs.join(', ') : 'none'}`,
  ];

  return {
    concise_lines: conciseLines,
    counts: {
      canonical_reads_used: selectedSelectors.length,
      omitted_candidate_refs: candidateRefs.length,
      revalidation_required: revalidations.length,
      suppressions_applied: suppressions.length,
    },
    authority_violations: authorityViolations,
    ...(input.verbose ? { verbose: buildVerbose(input, candidateRefs, suppressions) } : {}),
  };
}

function buildVerbose(
  input: MemoryWhyInput,
  omittedRefs: string[],
  suppressions: NegativeMemoryProjection[],
): MemoryWhyReport['verbose'] {
  return {
    considered_selectors: selectorIds(input.considered_selectors ?? []),
    selected_selectors: selectorIds(input.selected_selectors ?? []),
    omitted_candidate_refs: omittedRefs,
    suppression_reason_codes: dedupeStrings(suppressions.flatMap((entry) => entry.reason_codes)),
    activation_decisions: (input.activation_decisions ?? []).map((decision) => ({
      artifact_id: decision.artifact_id,
      decision: decision.decision,
      activation_label: decision.activation_label,
      reason_codes: decision.reason_codes,
    })),
    freshness_snapshot: input.freshness_snapshot ?? [],
    graph_paths_considered: input.graph_paths_considered ?? [],
    scope_policy_snapshot: input.scope_policy_snapshot ?? null,
    trace_refs: input.trace_refs ?? [],
  };
}

function omittedCandidateRefs(input: MemoryWhyInput): string[] {
  return dedupeStrings([
    ...(input.omitted_candidate_refs ?? []),
    ...(input.candidate_signals ?? []).map((signal) => `memory-candidate:${signal.candidate_id}`),
  ]);
}

function revalidationDecisions(
  decisions: MemoryActivationPolicyDecision[],
): MemoryActivationPolicyDecision[] {
  return decisions.filter((decision) => decision.decision === 'verify_first');
}

function appliedSuppressions(entries: NegativeMemoryProjection[]): NegativeMemoryProjection[] {
  return entries.filter((entry) =>
    entry.activation === 'suppress_if_valid' && entry.suppression_applies === true
  );
}

function collectAuthorityViolations(input: MemoryWhyInput): string[] {
  const violations: string[] = [];
  for (const signal of input.candidate_signals ?? []) {
    if (signal.activation === 'answer_ground') {
      violations.push(`candidate_signal_answer_ground:${signal.candidate_id}`);
    }
  }
  for (const decision of input.activation_decisions ?? []) {
    if (decision.decision !== 'answer_ground') continue;
    if (isDerivedOrientationArtifact(decision)) {
      violations.push(`derived_orientation_answer_ground:${decision.artifact_id}`);
    }
    if (decision.authority === 'unreviewed_candidate') {
      violations.push(`candidate_decision_answer_ground:${decision.artifact_id}`);
    }
  }
  return violations;
}

function isDerivedOrientationArtifact(decision: MemoryActivationPolicyDecision): boolean {
  return decision.authority === 'derived_orientation'
    || decision.artifact_id.startsWith('context-map:')
    || decision.artifact_id.startsWith('graph-path:')
    || decision.reason_codes.includes('context_map')
    || decision.reason_codes.includes('graph_path');
}

function selectorIds(selectors: Array<{ selector_id: string }>): string[] {
  return selectors.map((selector) => selector.selector_id);
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
