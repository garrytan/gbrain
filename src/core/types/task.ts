// Operational memory
export type TaskScope = 'work' | 'personal' | 'mixed';
export type TaskStatus = 'active' | 'paused' | 'blocked' | 'completed' | 'abandoned';
export type AttemptOutcome = 'failed' | 'partial' | 'succeeded' | 'abandoned';

export interface TaskThread {
  id: string;
  scope: TaskScope;
  title: string;
  goal: string;
  status: TaskStatus;
  repo_path: string | null;
  branch_name: string | null;
  current_summary: string;
  created_at: Date;
  updated_at: Date;
}

export interface TaskThreadInput {
  id: string;
  scope: TaskScope;
  title: string;
  goal?: string;
  status: TaskStatus;
  repo_path?: string | null;
  branch_name?: string | null;
  current_summary?: string;
}

export interface TaskThreadPatch {
  scope?: TaskScope;
  title?: string;
  goal?: string;
  status?: TaskStatus;
  repo_path?: string | null;
  branch_name?: string | null;
  current_summary?: string;
}

export interface TaskThreadFilters {
  scope?: TaskScope;
  status?: TaskStatus;
  limit?: number;
  offset?: number;
}

export interface TaskWorkingSet {
  task_id: string;
  active_paths: string[];
  active_symbols: string[];
  blockers: string[];
  open_questions: string[];
  next_steps: string[];
  verification_notes: string[];
  last_verified_at: Date | null;
  updated_at: Date;
}

export interface TaskWorkingSetInput {
  task_id: string;
  active_paths: string[];
  active_symbols: string[];
  blockers: string[];
  open_questions: string[];
  next_steps: string[];
  verification_notes: string[];
  last_verified_at?: Date | string | null;
}

export interface TaskAttempt {
  id: string;
  task_id: string;
  summary: string;
  outcome: AttemptOutcome;
  applicability_context: Record<string, unknown>;
  evidence: string[];
  created_at: Date;
}

export interface TaskAttemptInput {
  id: string;
  task_id: string;
  summary: string;
  outcome: AttemptOutcome;
  applicability_context?: Record<string, unknown>;
  evidence?: string[];
}

export interface TaskDecision {
  id: string;
  task_id: string;
  summary: string;
  rationale: string;
  consequences: string[];
  validity_context: Record<string, unknown>;
  created_at: Date;
}

export interface TaskDecisionInput {
  id: string;
  task_id: string;
  summary: string;
  rationale: string;
  consequences?: string[];
  validity_context?: Record<string, unknown>;
}
