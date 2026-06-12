import type {
  MemoryCandidateSensitivity,
  MemoryCandidateTargetObjectType,
  MemoryCandidateType,
} from './memory-governance.ts';
import type { PersonalEpisodeSourceKind, ProfileMemoryType } from './profile-episode.ts';
import type {
  MemoryScenarioSourceKind,
  MemoryWritebackEvidenceKind,
  RouteMemoryWritebackResult,
} from './retrieval-routing.ts';

export const AGENT_SESSION_SOURCE_KINDS = [
  'codex_session',
  'claude_session',
  'agent_session',
] as const;

export type AgentSessionSourceKind = typeof AGENT_SESSION_SOURCE_KINDS[number];

export const AGENT_SESSION_EVENT_KINDS = [
  'session_start',
  'user_prompt',
  'assistant_response',
  'tool_call',
  'tool_result',
  'tool_failure',
  'file_read',
  'file_write',
  'file_edit',
  'command_run',
  'search',
  'subagent_result',
  'session_stop',
  'explicit_memory_note',
] as const;

export type AgentSessionEventKind = typeof AGENT_SESSION_EVENT_KINDS[number];

export type AgentSessionActor = 'user' | 'assistant' | 'tool' | 'subagent' | 'system';

export type AgentSessionObservationType =
  | 'conversation'
  | 'tool_use'
  | 'tool_failure'
  | 'file_read'
  | 'file_write'
  | 'file_edit'
  | 'command_run'
  | 'search'
  | 'subagent'
  | 'session_summary'
  | 'other';

export type AgentSessionSignalKind =
  | 'profile_memory'
  | 'personal_episode'
  | 'procedure'
  | 'task_memory'
  | 'project_note'
  | 'open_question'
  | 'no_write';

export type AgentSessionGeneratedBy = 'agent_session_capture';

export type AgentSessionWriteMode =
  | 'candidate_only'
  | 'direct_personal_when_allowed';

export interface AgentSessionEventInput {
  source_kind?: AgentSessionSourceKind;
  session_id?: string;
  event_kind: AgentSessionEventKind;
  text: string;
  event_id?: string;
  actor?: AgentSessionActor;
  client_name?: string;
  repo_path?: string | null;
  workspace_id?: string | null;
  occurred_at?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentSessionCaptureEnvelope {
  source_kind: AgentSessionSourceKind;
  session_id: string;
  client_name?: string;
  repo_path?: string | null;
  workspace_id?: string | null;
  captured_at?: string;
  events: AgentSessionEventInput[];
}

export interface AgentSessionCaptureOperationInput {
  source_kind: AgentSessionSourceKind;
  session_id: string;
  client_name?: string;
  repo_path?: string | null;
  workspace_id?: string | null;
  events: AgentSessionEventInput[];
  now?: string;
}

export interface AgentSessionNormalizedEvent extends Required<Pick<
  AgentSessionEventInput,
  'source_kind' | 'session_id' | 'event_kind' | 'text'
>> {
  event_id: string;
  actor: AgentSessionActor;
  client_name: string;
  repo_path: string | null;
  workspace_id: string | null;
  occurred_at: string;
  metadata: Record<string, unknown>;
}

export interface AgentSessionCompressedObservation {
  id: string;
  source_item_id: string;
  source_chunk_ids: string[];
  session_id: string;
  event_ids: string[];
  event_kind: AgentSessionEventKind;
  actor: AgentSessionActor;
  observed_at: string;
  observation_type: AgentSessionObservationType;
  title: string;
  narrative: string;
  facts: string[];
  /** Number of fact lines dropped by the per-observation cap; absent when nothing was dropped. */
  truncated_fact_count?: number;
  concepts: string[];
  files: string[];
  importance_score: number;
  confidence_score: number;
  sensitivity: MemoryCandidateSensitivity;
  scope_id: string;
  source_refs: string[];
  prompt_injection_flagged?: boolean;
  generated_by: AgentSessionGeneratedBy;
}

export interface AgentSessionSummary {
  id: string;
  session_id: string;
  source_item_ids: string[];
  source_chunk_ids: string[];
  started_at: string | null;
  ended_at: string | null;
  title: string;
  outcome: string;
  user_goals: string[];
  decisions: string[];
  preferences: string[];
  files_touched: string[];
  errors_and_fixes: string[];
  unresolved_questions: string[];
  follow_ups: string[];
  candidate_memory_signals: string[];
  source_refs: string[];
  sensitivity: MemoryCandidateSensitivity;
  prompt_injection_flagged?: boolean;
  generated_by: AgentSessionGeneratedBy;
}

export interface AgentSessionMemorySignal {
  id: string;
  source_observation_id: string;
  content: string;
  evidence_kind: MemoryWritebackEvidenceKind;
  signal_kind: AgentSessionSignalKind;
  candidate_type: MemoryCandidateType | null;
  target_object_type: MemoryCandidateTargetObjectType | null;
  target_object_id: string | null;
  scope_id: string;
  sensitivity: MemoryCandidateSensitivity;
  confidence_score: number;
  importance_score: number;
  recurrence_score: number;
  source_refs: string[];
  prompt_injection_flagged?: boolean;
  profile_type?: ProfileMemoryType;
  profile_subject?: string;
  personal_episode_title?: string;
  personal_episode_source_kind?: PersonalEpisodeSourceKind;
  scenario_source_kind?: MemoryScenarioSourceKind;
}

export interface AgentSessionMemoryRouteResult {
  signal: AgentSessionMemorySignal;
  route: RouteMemoryWritebackResult | null;
  direct_write:
    | { kind: 'profile_memory'; id: string; status: 'written' | 'dry_run' }
    | { kind: 'personal_episode'; id: string; status: 'written' | 'dry_run' }
    | null;
  blocked_reason: string | null;
}
