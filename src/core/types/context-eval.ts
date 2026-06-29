export type ContextEvalFixtureMode = 'injected_candidates' | 'live_retrieve';
export type ContextEvalRunStatus = 'running' | 'passed' | 'failed' | 'error';

export interface ContextEvalRunInput {
  id?: string;
  fixture_id: string;
  fixture_mode: ContextEvalFixtureMode;
  status: ContextEvalRunStatus;
  model_id?: string | null;
  skill_surface_hash?: string | null;
  agent_rules_version?: string | null;
  git_sha?: string | null;
  retrieval_trace_ids?: string[];
  metrics?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  started_at?: Date;
  completed_at?: Date | null;
}

export interface ContextEvalRun extends Required<Omit<ContextEvalRunInput, 'id' | 'model_id' | 'skill_surface_hash' | 'agent_rules_version' | 'git_sha' | 'completed_at'>> {
  id: string;
  model_id: string | null;
  skill_surface_hash: string | null;
  agent_rules_version: string | null;
  git_sha: string | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ContextEvalAssertionInput {
  id?: string;
  run_id: string;
  case_id: string;
  assertion_kind: string;
  passed: boolean;
  score?: number | null;
  expected?: unknown;
  actual?: unknown;
  message?: string | null;
  retrieval_trace_id?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ContextEvalAssertion extends Required<Omit<ContextEvalAssertionInput, 'id' | 'score' | 'expected' | 'actual' | 'message' | 'retrieval_trace_id' | 'metadata'>> {
  id: string;
  score: number | null;
  expected: unknown;
  actual: unknown;
  message: string | null;
  retrieval_trace_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface ContextEvalCorrectionInput {
  id?: string;
  trace_id: string;
  case_id: string;
  reason: string;
  run_id?: string | null;
  proposed_assertion_id?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ContextEvalCorrection extends Required<Omit<ContextEvalCorrectionInput, 'id' | 'run_id' | 'proposed_assertion_id' | 'metadata'>> {
  id: string;
  run_id: string | null;
  proposed_assertion_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface ContextEvalRunFilters {
  fixture_id?: string;
  status?: ContextEvalRunStatus;
  limit?: number;
}

export interface ContextEvalAssertionFilters {
  run_id?: string;
  case_id?: string;
  passed?: boolean;
  limit?: number;
}
