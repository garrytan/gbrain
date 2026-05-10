export type Phase1LatencyWorkloadName =
  | 'task_resume'
  | 'attempt_history'
  | 'decision_history';

export type Phase1CorrectnessWorkloadName =
  | 'resume_projection'
  | 'repeated_work_suppression'
  | 'decision_reuse'
  | 'verification_warnings'
  | 'trace_template_completeness';
export type Phase1WorkloadName = Phase1LatencyWorkloadName | Phase1CorrectnessWorkloadName;

export interface Phase1LatencyWorkloadResult {
  name: Phase1LatencyWorkloadName;
  status: 'measured';
  unit: 'ms';
  p50_ms: number;
  p95_ms: number;
}

export interface Phase1CorrectnessWorkloadResult {
  name: Phase1CorrectnessWorkloadName;
  status: 'measured';
  unit: 'percent';
  success_rate: number;
}

export type Phase1WorkloadResult =
  | Phase1LatencyWorkloadResult
  | Phase1CorrectnessWorkloadResult;

export type Phase1AcceptanceStatus = 'pass' | 'fail' | 'pending_baseline';

export interface Phase1AcceptanceThresholds {
  task_resume_p95_ms_max: number;
  attempt_history_p95_ms_max: number;
  decision_history_p95_ms_max: number;
  resume_projection_success_rate: number;
  repeated_work_suppression_success_rate: number;
  decision_reuse_success_rate: number;
  verification_warnings_success_rate: number;
  trace_template_completeness_success_rate: number;
  primary_improvement_threshold_pct: number;
}

export interface Phase1AcceptanceCheck {
  name:
    | 'task_resume_p95_ms'
    | 'attempt_history_p95_ms'
    | 'decision_history_p95_ms'
    | 'resume_projection_success_rate'
    | 'repeated_work_suppression_success_rate'
    | 'decision_reuse_success_rate'
    | 'verification_warnings_success_rate'
    | 'trace_template_completeness_success_rate'
    | 'primary_improvement_threshold';
  status: Phase1AcceptanceStatus;
  actual?: number;
  threshold: {
    operator: '<=' | '>=' | '===';
    value: number;
    unit: 'ms' | 'percent';
  };
  reason?: string;
}

export interface Phase1AcceptanceReport {
  thresholds: Phase1AcceptanceThresholds;
  readiness_status: Extract<Phase1AcceptanceStatus, 'pass' | 'fail'>;
  phase1_status: Phase1AcceptanceStatus;
  checks: Phase1AcceptanceCheck[];
  summary: string;
}

export interface Phase1WorkloadDefinition {
  name: Phase1WorkloadName;
  unit: Phase1WorkloadResult['unit'];
  samples?: number;
}

export interface Phase1TaskFixture {
  thread: {
    id: string;
    scope: 'work' | 'personal' | 'mixed';
    title: string;
    goal: string;
    status: 'active' | 'paused' | 'blocked' | 'completed' | 'abandoned';
    repo_path: string | null;
    branch_name: string | null;
    current_summary: string;
  };
  workingSet: {
    active_paths: string[];
    active_symbols: string[];
    blockers: string[];
    open_questions: string[];
    next_steps: string[];
    verification_notes: string[];
    last_verified_at: Date | null;
  };
  attempts: Array<{
    id: string;
    summary: string;
    outcome: 'failed' | 'partial' | 'succeeded' | 'abandoned';
    applicability_context: Record<string, unknown>;
    evidence: string[];
  }>;
  decisions: Array<{
    id: string;
    summary: string;
    rationale: string;
    consequences: string[];
    validity_context: Record<string, unknown>;
  }>;
  trace: {
    id: string;
    route: string[];
    source_refs: string[];
    verification: string[];
    outcome: string;
  };
  expectedResume: {
    stale: boolean;
    failed_attempts: string[];
    active_decisions: string[];
    decision_reuse: string[];
    verification_warnings: string[];
    latest_trace_route: string[];
  };
}

export const PHASE1_WORKLOADS: Phase1WorkloadDefinition[] = [
  {
    name: 'task_resume',
    unit: 'ms',
    samples: 10,
  },
  {
    name: 'attempt_history',
    unit: 'ms',
    samples: 10,
  },
  {
    name: 'decision_history',
    unit: 'ms',
    samples: 10,
  },
  {
    name: 'resume_projection',
    unit: 'percent',
  },
  {
    name: 'repeated_work_suppression',
    unit: 'percent',
  },
  {
    name: 'decision_reuse',
    unit: 'percent',
  },
  {
    name: 'verification_warnings',
    unit: 'percent',
  },
  {
    name: 'trace_template_completeness',
    unit: 'percent',
  },
];

export const PHASE1_ACCEPTANCE_THRESHOLDS: Phase1AcceptanceThresholds = {
  task_resume_p95_ms_max: 10,
  attempt_history_p95_ms_max: 5,
  decision_history_p95_ms_max: 5,
  resume_projection_success_rate: 100,
  repeated_work_suppression_success_rate: 100,
  decision_reuse_success_rate: 100,
  verification_warnings_success_rate: 100,
  trace_template_completeness_success_rate: 100,
  primary_improvement_threshold_pct: 10,
};

export const PHASE1_PENDING_BASELINE_REASON =
  'Full Phase 1 acceptance still requires a comparable repeated-work baseline. Phase 0 publishes task_resume as unsupported, so the primary improvement threshold cannot be evaluated yet.';

export const PHASE1_TASK_FIXTURES: Phase1TaskFixture[] = [
  {
    thread: {
      id: 'phase1-task-stale',
      scope: 'work',
      title: 'Phase 1 stale resume task',
      goal: 'Resume additive operational memory work',
      status: 'blocked',
      repo_path: '/repo',
      branch_name: 'docs/mbrain-redesign-doc-set',
      current_summary: 'Need to preserve prior dead ends before resuming',
    },
    workingSet: {
      active_paths: ['src/core/operations.ts', 'src/core/services/task-memory-service.ts'],
      active_symbols: ['operations', 'buildTaskResumeCard'],
      blockers: ['phase1 acceptance harness missing'],
      open_questions: ['which resume metrics belong in the acceptance contract'],
      next_steps: ['add a reproducible benchmark runner'],
      verification_notes: ['resume semantics verified in shared operations'],
      last_verified_at: null,
    },
    attempts: [
      {
        id: 'phase1-attempt-stale-1',
        summary: 'Reconstructed resume state from raw notes only',
        outcome: 'failed',
        applicability_context: { phase: 'phase1', surface: 'resume' },
        evidence: ['lost failed attempt history'],
      },
      {
        id: 'phase1-attempt-stale-2',
        summary: 'Recorded only task title without working set',
        outcome: 'partial',
        applicability_context: { phase: 'phase1', surface: 'resume' },
        evidence: ['resume lacked next steps'],
      },
    ],
    decisions: [
      {
        id: 'phase1-decision-stale-1',
        summary: 'Keep resume state in additive task tables',
        rationale: 'resume reads must stay cheaper than raw reconstruction',
        consequences: ['task resume remains local-first'],
        validity_context: { phase: 'phase1' },
      },
    ],
    trace: {
      id: 'phase1-trace-stale-1',
      route: ['task_thread', 'working_set', 'attempt_history', 'decision_history'],
      source_refs: ['task-thread:phase1-task-stale'],
      verification: ['shared task surface verified'],
      outcome: 'resume card assembled',
    },
    expectedResume: {
      stale: true,
      failed_attempts: ['Reconstructed resume state from raw notes only'],
      active_decisions: ['Keep resume state in additive task tables'],
      decision_reuse: ['Reuse decision: Keep resume state in additive task tables'],
      verification_warnings: [
        'Working set has not been verified in the current workspace.',
        '6 code claim(s) could not be verified in the current workspace.',
      ],
      latest_trace_route: ['task_thread', 'working_set', 'attempt_history', 'decision_history'],
    },
  },
  {
    thread: {
      id: 'phase1-task-fresh',
      scope: 'work',
      title: 'Phase 1 fresh resume task',
      goal: 'Keep active task continuity current',
      status: 'active',
      repo_path: '/repo',
      branch_name: 'docs/mbrain-redesign-doc-set',
      current_summary: 'Working set already verified against current branch',
    },
    workingSet: {
      active_paths: ['docs/architecture/redesign/08-evaluation-and-acceptance.md'],
      active_symbols: ['Default Acceptance Thresholds'],
      blockers: [],
      open_questions: ['should benchmarks publish p95 by default'],
      next_steps: ['wire the benchmark into verification docs'],
      verification_notes: ['working set refreshed after latest task-memory change'],
      last_verified_at: new Date('2026-04-19T12:00:00.000Z'),
    },
    attempts: [
      {
        id: 'phase1-attempt-fresh-1',
        summary: 'Skipped task traces and relied on memory alone',
        outcome: 'failed',
        applicability_context: { phase: 'phase1', surface: 'trace' },
        evidence: ['lost retrieval route provenance'],
      },
    ],
    decisions: [
      {
        id: 'phase1-decision-fresh-1',
        summary: 'Publish a focused Phase 1 benchmark before Phase 2 work',
        rationale: 'Phase 1 needs a measurable acceptance hook before more surface area lands',
        consequences: ['resume quality stays comparable over time'],
        validity_context: { phase: 'phase1' },
      },
    ],
    trace: {
      id: 'phase1-trace-fresh-1',
      route: ['task_thread', 'working_set', 'retrieval_trace'],
      source_refs: ['task-thread:phase1-task-fresh'],
      verification: ['working set refreshed'],
      outcome: 'resume card assembled',
    },
    expectedResume: {
      stale: false,
      failed_attempts: ['Skipped task traces and relied on memory alone'],
      active_decisions: ['Publish a focused Phase 1 benchmark before Phase 2 work'],
      decision_reuse: ['Reuse decision: Publish a focused Phase 1 benchmark before Phase 2 work'],
      verification_warnings: ['2 code claim(s) could not be verified in the current workspace.'],
      latest_trace_route: ['task_thread', 'working_set', 'retrieval_trace'],
    },
  },
];
