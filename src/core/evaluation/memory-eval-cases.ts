export const REQUIRED_MEMORY_REPLAY_STAGES = [
  'source_registration',
  'raw_ingest',
  'extraction',
  'assertion_resolution',
  'canonical_write',
  'candidate_route',
  'conflict_route',
  'lifecycle_transition',
  'runner_proposal',
  'reconciler_drift',
  'connector_sync',
  'purge_restore',
] as const;

export const REQUIRED_MEMORY_REPLAY_CASE_TYPES = [
  'policy_decision',
  'retrieval_visibility',
  'prompt_injection',
  'secret_redaction',
  'runner_tool_call',
  'projection_round_trip',
  'live_eval_budget',
] as const;

export type MemoryReplayStageName = typeof REQUIRED_MEMORY_REPLAY_STAGES[number];
export type MemoryReplayCaseType =
  typeof REQUIRED_MEMORY_REPLAY_CASE_TYPES[number];

export interface MemoryReplayStage {
  stage: MemoryReplayStageName | string;
  id: string;
  expected: string;
}

export interface MemoryReplaySource {
  id: string;
  registered?: boolean;
}

export interface MemoryReplaySourceItem {
  id: string;
  source_id: string;
}

export interface MemoryReplaySourceChunk {
  id: string;
  source_item_id: string;
  chunk_text: string;
}

export interface MemoryReplayClaim {
  id: string;
  chunk_id: string;
  duplicate_key?: string;
}

export interface MemoryReplayAssertion {
  id: string;
  claim_id: string;
  confidence: number;
  lifecycle_state?: string;
  conflict?: boolean;
}

export interface MemoryReplayExpectedExtraction {
  claim_id: string;
  chunk_id: string;
}

export interface MemoryReplayCanonicalWrite {
  id: string;
  assertion_id: string;
}

export interface MemoryReplayCandidateRoute {
  id: string;
  assertion_id: string;
  status: string;
}

export interface MemoryReplayConflictRoute {
  id: string;
  assertion_id: string;
  status: string;
}

export interface MemoryReplaySupersession {
  id: string;
  duplicate_key?: string;
  superseded_assertion_id: string;
  superseding_assertion_id: string;
}

export interface MemoryReplayProjection {
  id: string;
  write_id: string;
  rendered_markdown: string;
  expected_rendered_markdown?: string;
  structured_projection?: Record<string, unknown>;
  expected_structured_projection?: Record<string, unknown>;
  drift_status?: string;
}

export interface MemoryReplayDreamPhase {
  id: string;
  proposal_only?: boolean;
}

export interface MemoryReplayMutationEvent {
  id: string;
  stage: MemoryReplayStageName | string;
  target_id: string;
  result: string;
}

export interface MemoryReplayRunnerJob {
  id: string;
  status: string;
  proposal_only?: boolean;
  retry_job_id?: string;
}

export interface MemoryReplayRunnerTranscript {
  id: string;
  source_chunk_id?: string;
  input_text: string;
}

export interface MemoryReplayExpectedJobRetry {
  failed_job_id: string;
  retry_job_id: string;
}

export interface MemoryReplayExpectedDisposition {
  assertion_id: string;
  resolved_at: string;
  disposed_at?: string;
  max_seconds: number;
}

export interface MemoryReplayForgettingRecord {
  id: string;
  assertion_id: string;
  transition: string;
}

export interface MemoryReplayConnectorSync {
  id: string;
  source_id: string;
  status: string;
}

export interface MemoryReplayPurgePlan {
  id: string;
  target_id: string;
  status: string;
}

export interface MemoryReplayEvalCase {
  id: string;
  type: MemoryReplayCaseType;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
}

export interface MemoryReplayFixture {
  id: string;
  description?: string;
  stages?: MemoryReplayStage[];
  sources?: MemoryReplaySource[];
  source_items?: MemoryReplaySourceItem[];
  source_chunks?: MemoryReplaySourceChunk[];
  claims?: MemoryReplayClaim[];
  expected_extractions?: MemoryReplayExpectedExtraction[];
  assertions?: MemoryReplayAssertion[];
  canonical_writes?: MemoryReplayCanonicalWrite[];
  candidate_routes?: MemoryReplayCandidateRoute[];
  conflict_routes?: MemoryReplayConflictRoute[];
  supersessions?: MemoryReplaySupersession[];
  projections?: MemoryReplayProjection[];
  dream_phases?: MemoryReplayDreamPhase[];
  mutation_events?: MemoryReplayMutationEvent[];
  runner_jobs?: MemoryReplayRunnerJob[];
  runner_transcripts?: MemoryReplayRunnerTranscript[];
  expected_job_retries?: MemoryReplayExpectedJobRetry[];
  expected_dispositions?: MemoryReplayExpectedDisposition[];
  expected_disposition_assertion_ids?: string[];
  forgetting?: MemoryReplayForgettingRecord[];
  connector_syncs?: MemoryReplayConnectorSync[];
  purge_plans?: MemoryReplayPurgePlan[];
  eval_cases?: MemoryReplayEvalCase[];
}
