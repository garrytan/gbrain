#!/usr/bin/env bun

import { spawnSync } from 'bun';

export type Phase8ComparableStatus = 'pass' | 'fail' | 'pending_baseline';
export type Phase8Status = 'pass' | 'fail' | 'pending_baseline';

export interface Phase8LongitudinalPhaseSummary {
  phase: `phase${1 | 2 | 3 | 4 | 5 | 6 | 7}`;
  baseline_family: string;
  comparable_status: Phase8ComparableStatus;
  readiness_status: 'pass' | 'fail';
  phase_status: Phase8Status;
  benchmark_names: string[];
  regression_reasons: string[];
}

interface Phase8AcceptanceReport {
  readiness_status: 'pass' | 'fail';
  phase8_status: Phase8Status;
  summary: string;
}

export interface Phase8Payload {
  generated_at: string;
  engine: string;
  phase: 'phase8';
  phase_summaries: Phase8LongitudinalPhaseSummary[];
  acceptance: Phase8AcceptanceReport;
}

export interface PhaseDefinition {
  phase: Phase8LongitudinalPhaseSummary['phase'];
  baseline_family: string;
  path: string;
  expected_benchmark_names: string[];
  readiness_key: string;
  status_key: string;
  output_collection_key: 'workloads' | 'benchmarks';
}

export const PHASE_DEFINITIONS: readonly PhaseDefinition[] = [
  {
    phase: 'phase1',
    baseline_family: 'repeated_work',
    path: 'scripts/bench/phase1-operational-memory.ts',
    expected_benchmark_names: [
      'attempt_history',
      'decision_history',
      'repeated_work_suppression',
      'resume_projection',
      'task_resume',
      'trace_template_completeness',
    ],
    readiness_key: 'readiness_status',
    status_key: 'phase1_status',
    output_collection_key: 'workloads',
  },
  {
    phase: 'phase2',
    baseline_family: 'markdown_retrieval',
    path: 'scripts/bench/phase2-acceptance-pack.ts',
    expected_benchmark_names: [
      'atlas_orientation_bundle',
      'atlas_orientation_card',
      'context_atlas',
      'context_atlas_overview',
      'context_atlas_report',
      'context_atlas_select',
      'context_map',
      'context_map_report',
      'note_manifest',
      'note_sections',
      'structural_paths',
      'workspace_corpus_card',
      'workspace_orientation_bundle',
      'workspace_project_card',
      'workspace_system_card',
    ],
    readiness_key: 'readiness_status',
    status_key: 'phase2_status',
    output_collection_key: 'benchmarks',
  },
  {
    phase: 'phase3',
    baseline_family: 'context_map',
    path: 'scripts/bench/phase3-acceptance-pack.ts',
    expected_benchmark_names: [
      'broad_synthesis_route',
      'context_map_explain',
      'context_map_path',
      'context_map_query',
      'precision_lookup_route',
      'retrieval_route_selector',
      'retrieval_route_trace',
    ],
    readiness_key: 'readiness_status',
    status_key: 'phase3_status',
    output_collection_key: 'benchmarks',
  },
  {
    phase: 'phase4',
    baseline_family: 'scope_isolation',
    path: 'scripts/bench/phase4-acceptance-pack.ts',
    expected_benchmark_names: [
      'mixed_scope_bridge',
      'mixed_scope_disclosure',
      'personal_episode_lookup',
      'personal_export_visibility',
      'personal_profile_lookup',
      'personal_write_target',
      'scope_gate',
    ],
    readiness_key: 'readiness_status',
    status_key: 'phase4_status',
    output_collection_key: 'benchmarks',
  },
  {
    phase: 'phase5',
    baseline_family: 'governance',
    path: 'scripts/bench/phase5-acceptance-pack.ts',
    expected_benchmark_names: [
      'memory_inbox_contradiction',
      'memory_inbox_foundations',
      'memory_inbox_promotion',
      'memory_inbox_promotion_preflight',
      'memory_inbox_rejection',
      'memory_inbox_supersession',
    ],
    readiness_key: 'readiness_status',
    status_key: 'phase5_status',
    output_collection_key: 'benchmarks',
  },
  {
    phase: 'phase6',
    baseline_family: 'derived_governance',
    path: 'scripts/bench/phase6-acceptance-pack.ts',
    expected_benchmark_names: [
      'map_derived_candidates',
      'memory_candidate_dedup',
      'memory_candidate_scoring',
    ],
    readiness_key: 'readiness_status',
    status_key: 'phase6_status',
    output_collection_key: 'benchmarks',
  },
  {
    phase: 'phase7',
    baseline_family: 'provenance_and_validity',
    path: 'scripts/bench/phase7-acceptance-pack.ts',
    expected_benchmark_names: [
      'canonical_handoff',
      'historical_validity',
    ],
    readiness_key: 'readiness_status',
    status_key: 'phase7_status',
    output_collection_key: 'benchmarks',
  },
] as const;

export async function runLongitudinalEvaluation(
  phase1BaselinePath?: string | null,
): Promise<Phase8Payload> {
  const phaseSummaries = PHASE_DEFINITIONS.map((definition) => runPhase(definition, phase1BaselinePath ?? null));
  const acceptance = evaluateLongitudinalAcceptance(phaseSummaries);

  return {
    generated_at: new Date().toISOString(),
    engine: 'sqlite',
    phase: 'phase8',
    phase_summaries: phaseSummaries,
    acceptance,
  };
}

export function getProcessOutcome(payload: Phase8Payload): { stdout: string; exitCode: number } {
  return {
    stdout: JSON.stringify(payload, null, 2),
    exitCode: payload.acceptance.phase8_status === 'fail' ? 1 : 0,
  };
}

export function compareBenchmarkManifest(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) {
    return false;
  }

  const counts = new Map<string, number>();

  for (const name of actual) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  for (const name of expected) {
    const count = counts.get(name);
    if (!count) {
      return false;
    }

    if (count === 1) {
      counts.delete(name);
    } else {
      counts.set(name, count - 1);
    }
  }

  return counts.size === 0;
}

export function evaluateLongitudinalAcceptance(
  phaseSummaries: Phase8LongitudinalPhaseSummary[],
): Phase8AcceptanceReport {
  const hasFailure = phaseSummaries.some((summary) => summary.comparable_status === 'fail');
  if (hasFailure) {
    return {
      readiness_status: 'fail',
      phase8_status: 'fail',
      summary: 'Phase 8 longitudinal evaluation failed because one or more phases regressed from the recorded baseline contract.',
    };
  }

  const hasPendingBaseline = phaseSummaries.some((summary) => summary.comparable_status === 'pending_baseline');
  if (hasPendingBaseline) {
    return {
      readiness_status: 'pass',
      phase8_status: 'pending_baseline',
      summary: 'Phase 8 longitudinal evaluation is ready, but Phase 1 still needs a comparable baseline artifact.',
    };
  }

  return {
    readiness_status: 'pass',
    phase8_status: 'pass',
    summary: 'Phase 8 longitudinal evaluation passed across the published Phase 1 through Phase 7 benchmark contracts.',
  };
}

function runPhase(
  definition: PhaseDefinition,
  phase1BaselinePath: string | null,
): Phase8LongitudinalPhaseSummary {
  const command = ['bun', 'run', definition.path, '--json'];
  if (definition.phase === 'phase1' && phase1BaselinePath) {
    command.push('--baseline', phase1BaselinePath);
  }

  const proc = spawnSync(command, {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (proc.exitCode !== 0) {
    return {
      phase: definition.phase,
      baseline_family: definition.baseline_family,
      comparable_status: 'fail',
      readiness_status: 'fail',
      phase_status: 'fail',
      benchmark_names: [],
      regression_reasons: ['benchmark_runner_failed'],
    };
  }

  const stdout = new TextDecoder().decode(proc.stdout);
  return summarizePhasePayload(definition, parsePayload(stdout, definition.phase));
}

function determineComparableStatus(
  phase: Phase8LongitudinalPhaseSummary['phase'],
  phaseStatus: Phase8Status,
  regressionReasons: string[],
): Phase8ComparableStatus {
  if (phase === 'phase1' && phaseStatus === 'pending_baseline' && regressionReasons.every((reason) => reason === 'missing_phase1_baseline')) {
    return 'pending_baseline';
  }

  return regressionReasons.length === 0 ? 'pass' : 'fail';
}

function normalizePhaseStatus(value: unknown): Phase8Status {
  if (value === 'pass' || value === 'fail' || value === 'pending_baseline') {
    return value;
  }

  return 'fail';
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const args = new Set(rawArgs);
  const phase1BaselinePath = getFlagValue(rawArgs, '--phase1-baseline');

  if (args.has('--help')) {
    console.log('Usage: bun run scripts/bench/phase8-longitudinal-evaluation.ts [--json] [--phase1-baseline <path>]');
    process.exit(0);
  }

  const payload = await runLongitudinalEvaluation(phase1BaselinePath);
  const outcome = getProcessOutcome(payload);
  console.log(outcome.stdout);

  if (outcome.exitCode !== 0) {
    process.exit(outcome.exitCode);
  }
}

function getFlagValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1) {
    return null;
  }

  return args[index + 1] ?? null;
}

function parsePayload(stdout: string, phase: PhaseDefinition['phase']): any {
  try {
    return JSON.parse(stdout);
  } catch {
    return {
      phase,
      acceptance: {
        readiness_status: 'fail',
        [`${phase}_status`]: 'fail',
      },
      benchmarks: [],
      workloads: [],
      __invalid_payload: true,
    };
  }
}

function summarizePhasePayload(definition: PhaseDefinition, parsed: any): Phase8LongitudinalPhaseSummary {
  const invalidPayload = parsed?.__invalid_payload === true;
  const benchmarkNames = Array.isArray(parsed?.[definition.output_collection_key])
    ? parsed[definition.output_collection_key]
        .map((item: any) => item?.name)
        .filter((name: any): name is string => typeof name === 'string')
    : [];
  const acceptance = parsed?.acceptance ?? {};
  const readinessStatus = acceptance?.[definition.readiness_key] === 'pass' ? 'pass' : 'fail';
  const rawPhaseStatus = acceptance?.[definition.status_key];
  const phaseStatus = normalizePhaseStatus(rawPhaseStatus);
  const regressionReasons: string[] = [];

  if (invalidPayload) {
    regressionReasons.push('invalid_benchmark_payload');
  }

  if (!compareBenchmarkManifest(benchmarkNames, definition.expected_benchmark_names)) {
    regressionReasons.push('benchmark_manifest_mismatch');
  }

  if (readinessStatus !== 'pass') {
    regressionReasons.push('readiness_not_pass');
  }

  if (definition.phase === 'phase1' && phaseStatus === 'pending_baseline') {
    regressionReasons.push('missing_phase1_baseline');
  } else if (phaseStatus !== 'pass') {
    regressionReasons.push('phase_status_not_pass');
  }

  const comparableStatus = determineComparableStatus(definition.phase, phaseStatus, regressionReasons);

  return {
    phase: definition.phase,
    baseline_family: definition.baseline_family,
    comparable_status: comparableStatus,
    readiness_status: readinessStatus,
    phase_status: phaseStatus,
    benchmark_names: benchmarkNames,
    regression_reasons: regressionReasons,
  };
}

if (import.meta.main) {
  await main();
}
