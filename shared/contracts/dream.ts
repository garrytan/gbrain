import { z } from 'zod';
import { BrainOverviewResponseSchema } from './brain.ts';
import { ConsoleRunSchema, RunAcceptedResponseSchema } from './common.ts';

export const DreamSettingsResponseSchema = z.object({
  outputDir: z.string(),
  dualWrite: z.boolean(),
  includeUncommitted: z.boolean(),
  autoGitCommit: z.boolean().optional(),
  defaultBrainDir: z.string().nullable(),
  resolvedOutputDir: z.string().nullable(),
  directoryExists: z.boolean(),
});

export const DreamScheduleResponseSchema = z.object({
  enabled: z.boolean(),
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  lastStartedDate: z.string().nullable(),
  timeZone: z.string(),
});

export const DreamOverviewResponseSchema = z.object({
  phase_catalog: z.array(z.string()),
  phase_capabilities: z.array(z.object({
    id: z.string(),
    requiresGenerativeModel: z.boolean(),
    kind: z.enum(['local', 'generative']),
    labelZh: z.string(),
  }).passthrough()),
  generative_enabled: z.boolean(),
  generative_usage: z.object({
    generative_enabled: z.boolean(),
    capabilities: z.object({
      semantic_search: z.boolean(),
      hybrid_search: z.boolean(),
      vectorization: z.boolean(),
      quick_maintenance: z.boolean(),
      ai_deep_organize: z.boolean(),
      ai_meeting_organize: z.boolean(),
    }).passthrough(),
  }).passthrough(),
  overview: BrainOverviewResponseSchema.nullable(),
  health: z.object({
    page_count: z.number(), embed_coverage: z.number(), stale_pages: z.number(), orphan_pages: z.number(),
    missing_embeddings: z.number(), brain_score: z.number(), dead_links: z.number(), link_coverage: z.number(),
    timeline_coverage: z.number(), embed_coverage_score: z.number(), link_density_score: z.number(),
    timeline_coverage_score: z.number(), no_orphans_score: z.number(), no_dead_links_score: z.number(),
  }).passthrough().nullable(),
  locks: z.array(z.object({
    id: z.string(), holder_pid: z.number(), holder_host: z.string().nullable(), acquired_at: z.string(),
    ttl_expires_at: z.string(), last_refreshed_at: z.string().nullable(), active: z.boolean(),
  }).passthrough()),
  runs: z.array(ConsoleRunSchema),
  proposals: z.array(z.object({ status: z.string(), count: z.number() }).passthrough()),
  takes: z.object({
    total: z.number(), active: z.number(), resolved: z.number(), unresolved: z.number(), embedded: z.number(),
    avg_weight: z.number(), max_weight: z.number(),
  }).passthrough().nullable(),
  grades: z.object({
    total: z.number(), applied: z.number(), avg_confidence: z.number(), latest_graded_at: z.string().nullable(),
  }).passthrough().nullable(),
  calibration: z.object({
    latest: z.object({
      source_id: z.string(), holder: z.string(), generated_at: z.string(), total_resolved: z.number(),
      brier: z.number().nullable(), accuracy: z.number().nullable(), partial_rate: z.number().nullable(),
      grade_completion: z.number(), active_bias_tags: z.array(z.string()), voice_gate_passed: z.boolean(),
      voice_gate_attempts: z.number(), model_id: z.string(),
    }).passthrough().nullable(),
    history: z.array(z.object({
      id: z.number(), source_id: z.string(), holder: z.string(), generated_at: z.string(), total_resolved: z.number(),
      brier: z.number().nullable(), accuracy: z.number().nullable(), grade_completion: z.number(),
    }).passthrough()),
  }).passthrough(),
  embeddings: z.object({
    coverage: z.number().nullable(), pending: z.number().nullable(),
    by_source: z.array(z.object({ source_id: z.string(), chunks: z.number(), embedded: z.number(), pending: z.number() }).passthrough()),
  }).passthrough(),
  weights: z.object({
    top_pages: z.array(z.object({
      source_id: z.string(), slug: z.string(), title: z.string().nullable(), type: z.string(),
      emotional_weight: z.number(), updated_at: z.string(),
    }).passthrough()),
  }).passthrough(),
  knowledge: z.object({
    types: z.array(z.object({ type: z.string(), count: z.number() }).passthrough()),
    ingest: z.object({ total: z.number(), last_24h: z.number(), latest_at: z.string().nullable() }).passthrough().nullable(),
  }).passthrough(),
  lifecycle: z.object({
    soft_deleted_pages: z.number(), purge_ready_pages: z.number(), archived_sources: z.number(), dead_links: z.number(),
  }).passthrough().nullable(),
  jobs: z.object({
    recent: z.array(z.object({
      id: z.number(), name: z.string(), queue: z.string(), status: z.string(), attempts_made: z.number(),
      max_attempts: z.number(), created_at: z.string(), updated_at: z.string(), error_text: z.string().nullable(),
    }).passthrough()),
    status: z.array(z.object({ status: z.string(), count: z.number() }).passthrough()),
    subagent_status: z.array(z.object({ status: z.string(), count: z.number() }).passthrough()),
    subagent_queue: z.object({ waiting: z.number(), active: z.number(), stalled_active: z.number() }).passthrough().nullable(),
  }).passthrough(),
  supervisor: z.object({
    running: z.boolean(), supervisor_pid: z.number().nullable(), worker_running: z.boolean().optional(),
    worker_pid: z.number().nullable().optional(), pid_file: z.string(), mode: z.enum(['supervisor', 'none']).optional(),
    readiness_error: z.string().optional(),
  }).passthrough(),
  quality: z.object({
    takes_quality_runs: z.array(z.object({
      id: z.number(), verdict: z.string(), overall_score: z.number(), cost_usd: z.number(), created_at: z.string(),
    }).passthrough()),
    contradiction_runs: z.array(z.object({
      run_id: z.string(), ran_at: z.string(), queries_evaluated: z.number(), queries_with_contradiction: z.number(),
      total_contradictions_flagged: z.number(), judge_errors_total: z.number(),
    }).passthrough()),
  }).passthrough(),
}).passthrough();

export const DreamRunResponseSchema = RunAcceptedResponseSchema;

export const EntityCaptureBudgetResponseSchema = z.object({
  costCapCny: z.number().positive().nullable(),
  maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
});

export type DreamSettingsResponse = z.infer<typeof DreamSettingsResponseSchema>;
export type DreamScheduleResponse = z.infer<typeof DreamScheduleResponseSchema>;
export type DreamOverviewResponse = z.infer<typeof DreamOverviewResponseSchema>;
export type DreamRunResponse = z.infer<typeof DreamRunResponseSchema>;
export type EntityCaptureBudgetResponse = z.infer<typeof EntityCaptureBudgetResponseSchema>;
