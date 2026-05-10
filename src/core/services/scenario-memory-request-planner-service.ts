import { selectActivationPolicy } from './memory-activation-policy-service.ts';
import { classifyMemoryScenario } from './memory-scenario-classifier-service.ts';
import type {
  MemoryNextTool,
  MemoryPlannedActivationRule,
  MemoryScenario,
  MemoryScenarioClassification,
  MemoryWritebackHint,
  ScenarioMemoryRequestInput,
  ScenarioMemoryRequestPlan,
  ScenarioMemorySubplan,
} from '../types.ts';

type MaterialScenario = Exclude<MemoryScenario, 'mixed'>;

interface ScenarioRoute {
  primary_reads: string[];
  secondary_reads: string[];
  next_tool: MemoryNextTool;
  writeback_hint: MemoryWritebackHint;
  trace_required: boolean;
  planned_activation_rules: MemoryPlannedActivationRule[];
}

const ROUTES: Record<MaterialScenario, ScenarioRoute> = {
  coding_continuation: {
    primary_reads: [
      'task_thread',
      'working_set',
      'recent_episodes',
      'recent_attempts_decisions',
      'linked_procedures',
    ],
    secondary_reads: [
      'context_map_after_task_state',
      'project_system_pages',
      'code_files_after_task_state',
      'tests_after_task_state',
      'source_records',
    ],
    next_tool: 'resume_task',
    writeback_hint: 'record_trace',
    trace_required: true,
    planned_activation_rules: [
      {
        planned_read: 'task_thread',
        artifact_kind: 'task_decision',
        decision: 'answer_ground',
        authority: 'operational_memory',
        reason_codes: ['primary_operational_read'],
      },
      {
        planned_read: 'working_set',
        artifact_kind: 'current_artifact',
        decision: 'answer_ground',
        authority: 'verified_current_artifact',
        reason_codes: ['primary_current_state_read'],
      },
      {
        planned_read: 'recent_attempts_decisions',
        artifact_kind: 'task_attempt_failed',
        decision: 'suppress_if_valid',
        authority: 'operational_memory',
        reason_codes: ['primary_operational_read'],
      },
      {
        planned_read: 'context_map_after_task_state',
        artifact_kind: 'context_map',
        decision: 'orientation_only',
        authority: 'derived_orientation',
        reason_codes: ['secondary_orientation_read'],
      },
      {
        planned_read: 'code_files_after_task_state',
        artifact_kind: 'current_artifact',
        decision: 'verify_first',
        authority: 'verified_current_artifact',
        reason_codes: ['secondary_verification_read'],
      },
    ],
  },
  project_qa: {
    primary_reads: [
      'project_page',
      'system_pages',
      'codemap_concept_pages',
      'source_records',
    ],
    secondary_reads: [
      'context_map_orientation',
      'live_code_verification_for_current_claims',
    ],
    next_tool: 'get_page',
    writeback_hint: 'record_trace',
    trace_required: true,
    planned_activation_rules: [
      {
        planned_read: 'project_page',
        artifact_kind: 'compiled_truth',
        decision: 'answer_ground',
        authority: 'canonical_compiled_truth',
        reason_codes: ['primary_canonical_read'],
      },
      {
        planned_read: 'system_pages',
        artifact_kind: 'compiled_truth',
        decision: 'answer_ground',
        authority: 'canonical_compiled_truth',
        reason_codes: ['primary_canonical_read'],
      },
      {
        planned_read: 'codemap_concept_pages',
        artifact_kind: 'codemap_pointer',
        decision: 'orientation_only',
        authority: 'derived_orientation',
        reason_codes: ['primary_orientation_read'],
      },
      {
        planned_read: 'source_records',
        artifact_kind: 'source_record',
        decision: 'citation_only',
        authority: 'source_or_timeline_evidence',
        reason_codes: ['primary_source_evidence'],
      },
      {
        planned_read: 'context_map_orientation',
        artifact_kind: 'context_map',
        decision: 'orientation_only',
        authority: 'derived_orientation',
        reason_codes: ['secondary_orientation_read'],
      },
      {
        planned_read: 'live_code_verification_for_current_claims',
        artifact_kind: 'current_artifact',
        decision: 'verify_first',
        authority: 'verified_current_artifact',
        reason_codes: ['secondary_verification_read'],
      },
    ],
  },
  knowledge_qa: {
    primary_reads: [
      'exact_curated_page',
      'linked_canonical_pages',
      'timeline_source_evidence',
    ],
    secondary_reads: [
      'context_map_for_broad_synthesis',
      'external_sources_after_brain',
    ],
    next_tool: 'get_page',
    writeback_hint: 'record_trace',
    trace_required: true,
    planned_activation_rules: [
      {
        planned_read: 'exact_curated_page',
        artifact_kind: 'compiled_truth',
        decision: 'answer_ground',
        authority: 'canonical_compiled_truth',
        reason_codes: ['primary_canonical_read'],
      },
      {
        planned_read: 'linked_canonical_pages',
        artifact_kind: 'compiled_truth',
        decision: 'answer_ground',
        authority: 'canonical_compiled_truth',
        reason_codes: ['primary_canonical_read'],
      },
      {
        planned_read: 'timeline_source_evidence',
        artifact_kind: 'timeline',
        decision: 'citation_only',
        authority: 'source_or_timeline_evidence',
        reason_codes: ['primary_source_evidence'],
      },
      {
        planned_read: 'context_map_for_broad_synthesis',
        artifact_kind: 'context_map',
        decision: 'orientation_only',
        authority: 'derived_orientation',
        reason_codes: ['secondary_orientation_read'],
      },
      {
        planned_read: 'external_sources_after_brain',
        artifact_kind: 'source_record',
        decision: 'citation_only',
        authority: 'source_or_timeline_evidence',
        reason_codes: ['secondary_source_evidence'],
      },
    ],
  },
  auto_accumulation: {
    primary_reads: [
      'source_record_or_trace',
      'retrieval_trace',
      'task_attempt_decision_event_context',
      'existing_target_canonical_page',
    ],
    secondary_reads: [
      'memory_candidate_backlog',
      'contradiction_records',
      'duplicate_supersession_records',
    ],
    next_tool: 'route_memory_writeback',
    writeback_hint: 'create_candidate',
    trace_required: true,
    planned_activation_rules: [
      {
        planned_read: 'source_record_or_trace',
        artifact_kind: 'source_record',
        decision: 'citation_only',
        authority: 'source_or_timeline_evidence',
        reason_codes: ['primary_source_evidence'],
      },
      {
        planned_read: 'retrieval_trace',
        artifact_kind: 'source_record',
        decision: 'citation_only',
        authority: 'source_or_timeline_evidence',
        reason_codes: ['primary_trace_read'],
      },
      {
        planned_read: 'task_attempt_decision_event_context',
        artifact_kind: 'task_decision',
        decision: 'answer_ground',
        authority: 'operational_memory',
        reason_codes: ['primary_operational_read'],
      },
      {
        planned_read: 'existing_target_canonical_page',
        artifact_kind: 'compiled_truth',
        decision: 'answer_ground',
        authority: 'canonical_compiled_truth',
        reason_codes: ['primary_canonical_read'],
      },
      {
        planned_read: 'memory_candidate_backlog',
        artifact_kind: 'memory_candidate',
        decision: 'candidate_only',
        authority: 'unreviewed_candidate',
        reason_codes: ['secondary_candidate_read'],
      },
    ],
  },
  personal_recall: {
    primary_reads: [
      'scope_gate',
      'profile_memory_or_personal_episode',
      'scoped_supporting_notes',
    ],
    secondary_reads: [
      'mixed_scope_bridge_after_explicit_policy',
    ],
    next_tool: 'evaluate_scope_gate',
    writeback_hint: 'record_trace',
    trace_required: true,
    planned_activation_rules: [
      {
        planned_read: 'profile_memory_or_personal_episode',
        artifact_kind: 'profile_memory',
        decision: 'answer_ground',
        authority: 'canonical_compiled_truth',
        reason_codes: ['primary_personal_read'],
      },
      {
        planned_read: 'scoped_supporting_notes',
        artifact_kind: 'personal_episode',
        decision: 'answer_ground',
        authority: 'canonical_compiled_truth',
        reason_codes: ['primary_personal_read'],
      },
      {
        planned_read: 'mixed_scope_bridge_after_explicit_policy',
        artifact_kind: 'source_record',
        decision: 'citation_only',
        authority: 'source_or_timeline_evidence',
        reason_codes: ['secondary_scope_bridge_read'],
      },
    ],
  },
};

export function planScenarioMemoryRequest(
  input: ScenarioMemoryRequestInput,
): ScenarioMemoryRequestPlan {
  const classification = normalizePlannerClassification(
    classifyMemoryScenario(input),
    input,
  );
  const selectedScenario = selectRouteScenario(classification.scenario, classification.decomposed_routes);
  const route = ROUTES[selectedScenario];
  const activation = selectActivationPolicy({
    scenario: classification.scenario,
    artifacts: input.artifacts ?? [],
  });

  return {
    classification,
    primary_reads: [...route.primary_reads],
    secondary_reads: [...route.secondary_reads],
    activation_decisions: activation.decisions,
    next_tool: selectNextTool(route.next_tool, activation.next_tool, activation.verification_required),
    writeback_hint: activation.writeback_hint === 'none'
      ? route.writeback_hint
      : activation.writeback_hint,
    stale_warnings: activation.stale_warnings,
    verification_required: activation.verification_required,
    source_refs: activation.source_refs,
    trace_required: route.trace_required || activation.trace_required,
    decomposed_plans: buildSubplans(classification),
    planned_activation_rules: cloneRules(route.planned_activation_rules),
  };
}

function normalizePlannerClassification(
  classification: MemoryScenarioClassification,
  input: ScenarioMemoryRequestInput,
): MemoryScenarioClassification {
  return normalizeTaskContinuationClassification(classification, input);
}

function normalizeTaskContinuationClassification(
  classification: MemoryScenarioClassification,
  input: ScenarioMemoryRequestInput,
): MemoryScenarioClassification {
  if (classification.scenario !== 'mixed') return classification;
  if (!input.task_id && !input.repo_path) return classification;
  if ((input.known_subjects ?? []).length > 0) return classification;

  const codingRoute = classification.decomposed_routes.find((route) => (
    route.scenario === 'coding_continuation'
  ));
  const nonCodingRoutes = classification.decomposed_routes.filter((route) => (
    route.scenario !== 'coding_continuation'
  ));
  const onlyIncidentalProjectRoute = nonCodingRoutes.length === 1
    && nonCodingRoutes[0]?.scenario === 'project_qa'
    && nonCodingRoutes[0].reason_codes.every((reason) => reason === 'project_query_signal');

  if (
    !codingRoute
    || !onlyIncidentalProjectRoute
    || hasExplicitProjectAsk(input.query)
  ) {
    return classification;
  }

  return {
    ...classification,
    scenario: 'coding_continuation',
    confidence: codingRoute.confidence,
    reason_codes: codingRoute.reason_codes,
    decomposed_routes: [],
  };
}

function hasExplicitProjectAsk(query: string | undefined): boolean {
  if (!query) return false;

  return [
    /\b(explain|describe|summari[sz]e|walk\s+me\s+through)\b/i,
    /\b(project\s+architecture|project\s+structure|project\s+design)\b/i,
    /\b(route\s+architecture|routing\s+architecture|routing\s+structure)\b/i,
    /\b(retrieval\s+architecture|retrieval\s+routing\s+structure)\b/i,
    /(설명|구조|아키텍처|설계|검색\s*라우팅|라우팅\s*구조|프로젝트)/i,
  ].some((pattern) => pattern.test(query));
}

function selectRouteScenario(
  scenario: MemoryScenario,
  decomposedRoutes: Array<{ scenario: MaterialScenario }>,
): MaterialScenario {
  if (scenario !== 'mixed') return scenario;
  return decomposedRoutes[0]?.scenario ?? 'knowledge_qa';
}

function buildSubplans(
  classification: ScenarioMemoryRequestPlan['classification'],
): ScenarioMemorySubplan[] {
  if (classification.scenario !== 'mixed') return [];

  return classification.decomposed_routes.map((route) => {
    const scenarioRoute = ROUTES[route.scenario];
    return {
      scenario: route.scenario,
      primary_reads: [...scenarioRoute.primary_reads],
      secondary_reads: [...scenarioRoute.secondary_reads],
      next_tool: scenarioRoute.next_tool,
      writeback_hint: scenarioRoute.writeback_hint,
      planned_activation_rules: cloneRules(scenarioRoute.planned_activation_rules),
    };
  });
}

function selectNextTool(
  routeNextTool: MemoryNextTool,
  activationNextTool: MemoryNextTool,
  verificationRequired: boolean,
): MemoryNextTool {
  if (verificationRequired) return activationNextTool;
  if (activationNextTool === 'evaluate_scope_gate') return activationNextTool;
  if (activationNextTool === 'answer_now') return routeNextTool;
  return activationNextTool;
}

function cloneRules(rules: MemoryPlannedActivationRule[]): MemoryPlannedActivationRule[] {
  return rules.map((rule) => ({
    ...rule,
    reason_codes: [...rule.reason_codes],
  }));
}
