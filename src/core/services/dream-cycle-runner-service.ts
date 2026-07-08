import { hostname } from 'os';
import type { BrainEngine } from '../engine.ts';
import { buildCoreMemoryBlocks, persistCoreMemoryBlocksSnapshot } from './core-memory-blocks-service.ts';
import { runDreamCycleMaintenance } from './dream-cycle-maintenance-service.ts';
import { sweepExpiredWriteSessionFallbacks } from './expired-write-session-fallback-service.ts';
import type { LifecycleForgettingService } from './lifecycle-forgetting-service.ts';
import type {
  AcquireMaintenanceCycleLockResult,
  MaintenanceRuntimeService,
} from './maintenance-runtime-service.ts';
import { detectProceduralPatterns } from './procedural-memory-service.ts';

export type DreamCyclePhaseFamily =
  | 'source_status'
  | 'source_sync'
  | 'raw_ingest'
  | 'safety_scan'
  | 'claim_extraction'
  | 'assertion_resolution'
  | 'canonical_write'
  | 'consolidation'
  | 'contradiction_review'
  | 'forgetting_review'
  | 'projection_reconcile'
  | 'embedding_refresh'
  | 'context_refresh'
  | 'recompile'
  | 'daily_report'
  | 'auto_promote';

export type DreamCyclePhaseStatus = 'ok' | 'warn' | 'failed' | 'skipped';
export type DreamCycleSkipReason = 'phase_not_available' | 'runner_unavailable' | 'flag_disabled';
const DEFAULT_PHASE_TIMEOUT_MS = 10 * 60 * 1000;

export interface DreamCyclePhaseRegistryEntry {
  order: number;
  family: DreamCyclePhaseFamily;
  owner_phase: string;
  runner_backed: boolean;
  implemented: boolean;
}

export interface DreamCyclePhaseResult {
  family: DreamCyclePhaseFamily;
  owner_phase: string;
  status: DreamCyclePhaseStatus;
  duration_ms: number;
  timed_out: boolean;
  counts: Record<string, number>;
  source_ids: string[];
  assertion_ids: string[];
  projection_ids: string[];
  job_ids: string[];
  policy_denials: Array<{ code: string; message: string }>;
  conflicts: string[];
  errors: string[];
  skip_reason: DreamCycleSkipReason | null;
  next_recommended_action: string | null;
  canonical_mutations: number;
  llm_or_runner_used: boolean;
}

export interface DreamCycleRunInput {
  scope_id?: string;
  now?: string;
  dry_run?: boolean;
  write_candidates?: boolean;
  apply_auto_promote?: boolean;
  allow_canonical_page_writes?: boolean;
  limit?: number;
  max_runner_calls?: number;
  time_budget_ms?: number;
  phase_timeout_ms?: number;
  max_candidates_per_cycle?: number;
  report_dir?: string;
  allow_llm?: boolean;
  allow_local_runner?: boolean;
  governed_recompile_enabled?: boolean;
  trigger?: 'cli' | 'autopilot' | 'job' | 'manual';
}

export interface DreamCycleRunResult {
  status: 'ok' | 'warn' | 'failed';
  mode: 'dry_run' | 'apply';
  scope_id: string;
  generated_at: string;
  trigger: 'cli' | 'autopilot' | 'job' | 'manual';
  canonical_write_allowed: false;
  llm_or_runner_used: boolean;
  cycle_lock: DreamCycleLockResult | null;
  guardrails: DreamCycleGuardrailReport;
  self_consumption_guard: {
    generated_by: 'dream_cycle';
    anti_loop_marker: 'mbrain:dream-cycle-output:v1';
    raw_source_ingest_allowed: false;
    same_cycle_candidate_promotion_allowed: false;
    guarded_candidate_ids: string[];
  };
  phases: DreamCyclePhaseResult[];
  summary_lines: string[];
}

export interface DreamCycleGuardrailReport {
  lock_renewal: {
    status: 'not_required' | 'renewed' | 'aborted' | 'missing_runtime';
    renewal_count: number;
    last_renewed_at: string | null;
    reason_codes: string[];
    last_error?: {
      message: string;
      stack: string | null;
    };
  };
  replay_canary: {
    status: 'not_required' | 'passed' | 'failed' | 'not_configured';
    required: boolean;
    checked_at: string | null;
    reason_codes: string[];
    summary_lines: string[];
  };
}

export interface DreamReplayCanaryResult {
  status: 'passed' | 'failed';
  reason_codes?: string[];
  summary_lines?: string[];
}

export type DreamCycleLockResult = AcquireMaintenanceCycleLockResult & {
  holder: NonNullable<DreamCycleRunDeps['holder']>;
  acquired_at: string;
} | {
  status: 'missing_runtime';
  acquired_at: string;
  message: string;
};

export interface DreamCycleRunDeps {
  runtime?: Pick<MaintenanceRuntimeService, 'acquireCycleLock' | 'releaseCycleLock'>;
  lifecycleForgetting?: Pick<LifecycleForgettingService, 'buildDailyReport' | 'planPurgeCandidates' | 'runDueLifecycleTransitions'>;
  holder?: {
    holder_pid: number;
    holder_host: string;
    holder_kind: string;
  };
  phaseHandlers?: Partial<Record<DreamCyclePhaseFamily, DreamCyclePhaseHandler>>;
  autoPromote?: {
    run(input: {
      scope_id: string;
      now?: string;
      dry_run?: boolean;
      limit?: number;
      allow_canonical_page_writes?: boolean;
      max_runner_calls?: number;
      time_budget_ms?: number;
      exclude_candidate_ids?: string[];
      signal?: AbortSignal;
    }): Promise<{ counts: Record<string, number> }>;
  };
  replayCanary?: {
    run(input: {
      scope_id: string;
      now: string;
      trigger: DreamCyclePhaseContext['input']['trigger'];
      write_candidates: boolean;
      apply_auto_promote: boolean;
      allow_canonical_page_writes: boolean;
    }): Promise<DreamReplayCanaryResult>;
  };
  memoryReport?: {
    save(input: {
      scope_id: string;
      now: string;
      limit?: number;
    }): Promise<{
      path: string;
      counts?: Record<string, number>;
      summary_lines?: string[];
    }>;
  };
  watchedQuestions?: {
    run(input: {
      scope_id: string;
      now: string;
      limit?: number;
    }): Promise<{
      probed: number;
      changed: number;
      initialized: number;
      skipped: number;
      failures?: Array<{ question_id: string; question: string; reason: string }>;
    }>;
  };
  governedRecompile?: {
    run(input: {
      scope_id: string;
      now: string;
      dry_run: boolean;
      write_candidates: boolean;
      limit?: number;
      signal?: AbortSignal;
    }): Promise<{
      counts: Record<string, number>;
      source_ids?: string[];
      candidate_ids?: string[];
      summary_lines?: string[];
    }>;
  };
}

export type DreamCyclePhaseHandler = (
  context: DreamCyclePhaseContext,
) => Promise<Partial<Omit<DreamCyclePhaseResult, 'family' | 'owner_phase' | 'duration_ms'>>>;

export interface DreamCyclePhaseContext {
  engine: BrainEngine;
  input: Required<Pick<
    DreamCycleRunInput,
    'dry_run' | 'write_candidates' | 'apply_auto_promote' | 'allow_canonical_page_writes' | 'trigger'
  >> & {
    scope_id: string;
    now: string;
    limit?: number;
    max_runner_calls?: number;
    time_budget_ms?: number;
    phase_timeout_ms: number;
    max_candidates_per_cycle?: number;
    allow_llm: boolean;
    allow_local_runner: boolean;
    governed_recompile_enabled: boolean;
    signal?: AbortSignal;
  };
  registry: DreamCyclePhaseRegistryEntry;
  cycle: DreamCyclePhaseCycleState;
}

export interface DreamCyclePhaseCycleState {
  dream_generated_candidate_ids: Set<string>;
}

export const DREAM_CYCLE_PHASE_FAMILIES: readonly DreamCyclePhaseRegistryEntry[] = [
  { order: 1, family: 'source_status', owner_phase: 'Phase 01', runner_backed: false, implemented: true },
  { order: 2, family: 'source_sync', owner_phase: 'Phase 11', runner_backed: false, implemented: true },
  { order: 3, family: 'raw_ingest', owner_phase: 'Phase 02', runner_backed: false, implemented: true },
  { order: 4, family: 'safety_scan', owner_phase: 'Phase 02', runner_backed: false, implemented: true },
  { order: 5, family: 'claim_extraction', owner_phase: 'Phase 03 / Phase 09', runner_backed: true, implemented: true },
  { order: 6, family: 'assertion_resolution', owner_phase: 'Phase 03', runner_backed: false, implemented: true },
  { order: 7, family: 'canonical_write', owner_phase: 'Phase 04', runner_backed: false, implemented: true },
  { order: 8, family: 'consolidation', owner_phase: 'Phase 07', runner_backed: true, implemented: true },
  { order: 9, family: 'contradiction_review', owner_phase: 'Phase 03 / Phase 09', runner_backed: true, implemented: true },
  { order: 10, family: 'forgetting_review', owner_phase: 'Phase 08', runner_backed: true, implemented: true },
  { order: 11, family: 'projection_reconcile', owner_phase: 'Phase 10', runner_backed: false, implemented: true },
  { order: 12, family: 'embedding_refresh', owner_phase: 'Phase 05', runner_backed: false, implemented: true },
  { order: 13, family: 'context_refresh', owner_phase: 'Phase 05', runner_backed: false, implemented: true },
  { order: 14, family: 'recompile', owner_phase: 'Phase 07', runner_backed: true, implemented: true },
  { order: 15, family: 'daily_report', owner_phase: 'Phase 12', runner_backed: false, implemented: true },
  { order: 16, family: 'auto_promote', owner_phase: 'Phase 07', runner_backed: true, implemented: true },
] as const;

export async function runDreamCycle(
  engine: BrainEngine,
  input: DreamCycleRunInput = {},
  deps: DreamCycleRunDeps = {},
): Promise<DreamCycleRunResult> {
  const normalized = normalizeRunInput(input);
  const guardrails = initialGuardrailReport(normalized);
  const mutating = normalized.dry_run === false && normalized.write_candidates === true;
  const lockName = dreamCycleLockName(normalized.scope_id);
  const cycle = initialPhaseCycleState();
  const lock = mutating ? await acquireDreamLock(deps, lockName, normalized.now) : null;
  if (lock?.status === 'missing_runtime') {
    guardrails.lock_renewal = {
      status: 'missing_runtime',
      renewal_count: 0,
      last_renewed_at: null,
      reason_codes: ['cycle_lock_runtime_missing'],
    };
    return buildResult(normalized, [], 'failed', lock, guardrails, cycle);
  }
  if (lock?.status === 'busy') {
    guardrails.lock_renewal = {
      status: 'aborted',
      renewal_count: 0,
      last_renewed_at: null,
      reason_codes: ['cycle_lock_busy'],
    };
    return buildResult(normalized, [], 'failed', lock, guardrails, cycle);
  }

  try {
    guardrails.replay_canary = await runReplayCanaryIfRequired(normalized, deps);
    if (blocksApplyByReplayCanary(guardrails.replay_canary)) {
      return buildResult(normalized, [], 'failed', lock, guardrails, cycle);
    }

    const phases: DreamCyclePhaseResult[] = [];
    for (const registry of DREAM_CYCLE_PHASE_FAMILIES) {
      const renewal = await renewDreamLockBeforePhase(deps, lockName, lock, normalized, registry, guardrails);
      if (renewal.status === 'aborted') {
        phases.push(phaseResult(registry, {
          status: 'failed',
          errors: [`Dream cycle lock renewal failed before ${registry.family}.`],
          policy_denials: [{
            code: 'cycle_lock_renewal_required',
            message: 'Dream apply-capable phase requires an active same-holder cycle lock.',
          }],
          next_recommended_action: 'Retry after the current Dream cycle lock owner releases or expires.',
          canonical_mutations: 0,
          llm_or_runner_used: false,
        }, Date.now()));
        break;
      }
      phases.push(await runPhase(engine, normalized, registry, deps, cycle));
    }
    const status = summarizeStatus(phases);
    return buildResult(normalized, phases, status, lock, guardrails, cycle);
  } finally {
    if (lock?.status === 'acquired') {
      await deps.runtime?.releaseCycleLock?.({
        cycle_name: lockName,
        holder_pid: lock.holder.holder_pid,
        holder_host: lock.holder.holder_host,
        holder_kind: lock.holder.holder_kind,
      });
    }
  }
}

async function runPhase(
  engine: BrainEngine,
  input: DreamCyclePhaseContext['input'],
  registry: DreamCyclePhaseRegistryEntry,
  deps: DreamCycleRunDeps = {},
  cycle: DreamCyclePhaseCycleState,
): Promise<DreamCyclePhaseResult> {
  const started = Date.now();
  const handler = deps.phaseHandlers?.[registry.family] ?? defaultPhaseHandler(registry, deps);
  if (!handler) {
    return phaseResult(registry, {
      status: 'skipped',
      skip_reason: 'phase_not_available',
      next_recommended_action: `Implement ${registry.family} in ${registry.owner_phase} before enabling this family.`,
      llm_or_runner_used: false,
    }, started);
  }

  try {
    const patch = await withPhaseTimeout(
      (signal) => handler({ engine, input: { ...input, signal }, registry, cycle }),
      input.phase_timeout_ms,
      registry.family,
    );
    return phaseResult(registry, patch, started);
  } catch (error) {
    return phaseResult(registry, {
      status: 'failed',
      errors: [error instanceof Error ? error.message : String(error)],
      next_recommended_action: 'Inspect phase error and retry dream cycle after repair.',
      llm_or_runner_used: false,
    }, started);
  }
}

async function withPhaseTimeout(
  runWork: (signal: AbortSignal) => Promise<Partial<Omit<DreamCyclePhaseResult, 'family' | 'owner_phase' | 'duration_ms'>>>,
  timeoutMs: number,
  family: DreamCyclePhaseFamily,
): Promise<Partial<Omit<DreamCyclePhaseResult, 'family' | 'owner_phase' | 'duration_ms'>>> {
  const abortController = new AbortController();
  const work = runWork(abortController.signal);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return work;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<Partial<Omit<DreamCyclePhaseResult, 'family' | 'owner_phase' | 'duration_ms'>>>((resolve) => {
        timer = setTimeout(() => {
          abortController.abort();
          work.catch(() => {
            // The timeout result is the phase outcome; late abort rejections are observed here.
          });
          resolve({
            status: 'failed',
            timed_out: true,
            errors: [`Dream cycle phase ${family} timed out after ${timeoutMs}ms.`],
            next_recommended_action: 'Inspect the timed-out phase and retry after clearing stuck work.',
            llm_or_runner_used: false,
          });
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function defaultPhaseHandler(
  registry: DreamCyclePhaseRegistryEntry,
  deps: DreamCycleRunDeps,
): DreamCyclePhaseHandler | undefined {
  if (registry.family === 'daily_report' && deps.memoryReport) {
    return (context) => runDailyReportPhase(context, deps);
  }
  if (registry.family === 'consolidation') return runConsolidationPhase;
  if (registry.family === 'forgetting_review') {
    return (context) => runForgettingReviewPhase(context, deps);
  }
  if (registry.family === 'recompile') {
    return (context) => runRecompilePhase(context, deps);
  }
  if (registry.family === 'auto_promote') {
    return (context) => runAutoPromotePhase(context, deps);
  }
  if (registry.implemented) return runImplementedReadOnlyPhase;
  return undefined;
}

async function runImplementedReadOnlyPhase(
  context: DreamCyclePhaseContext,
): Promise<Partial<DreamCyclePhaseResult>> {
  if (context.registry.runner_backed && !context.input.allow_local_runner) {
    return {
      status: 'skipped',
      skip_reason: 'runner_unavailable',
      next_recommended_action: `Enable restricted runner policy before ${context.registry.family}.`,
      canonical_mutations: 0,
      llm_or_runner_used: false,
    };
  }

  const snapshot = await readImplementedPhaseSnapshot(context);
  const counts = snapshot.errors.length === 0
    ? snapshot.counts
    : { ...snapshot.counts, count_errors: snapshot.errors.length };
  const hasActionableWork = hasActionablePhaseWork(context.registry.family, counts);
  return {
    status: hasActionableWork || snapshot.errors.length > 0 ? 'warn' : 'ok',
    counts,
    errors: snapshot.errors,
    next_recommended_action: snapshot.errors.length > 0
      ? 'Inspect dream-cycle read model errors before claiming phase coverage.'
      : hasActionableWork
        ? nextActionForImplementedPhase(context.registry.family)
        : null,
    canonical_mutations: 0,
    llm_or_runner_used: false,
  };
}

async function readImplementedPhaseSnapshot(context: DreamCyclePhaseContext): Promise<{
  counts: Record<string, number>;
  errors: string[];
}> {
  const errors: string[] = [];
  const recordError = (message: string) => {
    errors.push(message);
  };
  const count = async (tableName: string, whereClause = '', params: unknown[] = []): Promise<number> => {
    const result = await countRows(context.engine, tableName, whereClause, params);
    if (result.error) {
      errors.push(result.error);
    }
    return result.count;
  };

  const counts = await readImplementedPhaseCounts(context, count, recordError);
  return { counts, errors };
}

async function readImplementedPhaseCounts(
  context: DreamCyclePhaseContext,
  count: (tableName: string, whereClause?: string, params?: unknown[]) => Promise<number>,
  recordError: (message: string) => void,
): Promise<Record<string, number>> {
  switch (context.registry.family) {
    case 'source_status':
      return {
        sources: await count('sources'),
        paused_sources: await count('sources', 'WHERE paused_at IS NOT NULL'),
      };
    case 'source_sync':
      return {
        connector_accounts: await count('connector_accounts'),
        unhealthy_connectors: await count('connector_sync_states', "WHERE health_status IN ('unhealthy', 'paused', 'revoked')"),
      };
    case 'raw_ingest':
      return {
        pending_items: await count('source_items', "WHERE ingest_status = 'pending'"),
        failed_items: await count('source_items', "WHERE ingest_status = 'failed'"),
      };
    case 'safety_scan':
      return {
        pending_secret_redactions: await count('secret_detections', "WHERE redaction_status = 'pending'"),
        flagged_or_quarantined_prompt_injection_flags: await count('prompt_injection_flags', "WHERE risk IN ('flagged', 'quarantined')"),
      };
    case 'claim_extraction':
      return {
        pending_claims: await count('extracted_claims', "WHERE status IN ('pending', 'pending_resolution')"),
      };
    case 'assertion_resolution':
      return {
        unresolved_assertions: await count('assertions', "WHERE authority_state = 'unresolved'"),
        conflicted_assertions: await count('assertions', "WHERE authority_state = 'conflicted'"),
      };
    case 'canonical_write':
      return {
        pending_reconcile_writes: await count('canonical_write_attempts', "WHERE status = 'pending_reconcile'"),
        failed_or_conflicted_writes: await count('canonical_write_attempts', "WHERE status IN ('failed_db', 'failed_markdown', 'conflict')"),
      };
    case 'contradiction_review':
      return {
        open_conflicts: await count('conflict_sets', "WHERE status = 'open'"),
      };
    case 'projection_reconcile':
      return {
        pending_reconcile: await count('canonical_projection_targets', "WHERE status = 'pending_reconcile'"),
        failed_or_conflicted_projections: await count('canonical_projection_targets', "WHERE status IN ('failed', 'conflict')"),
      };
    case 'embedding_refresh': {
      let health = null;
      if (typeof context.engine.getHealth === 'function') {
        try {
          health = await context.engine.getHealth();
        } catch (error) {
          recordError(`engine.getHealth: ${errorMessage(error)}`);
        }
      }
      return { missing_embeddings: health?.missing_embeddings ?? 0 };
    }
    case 'context_refresh':
      return {
        stale_or_failed_derived_artifacts: await count('derived_index_state', "WHERE status IN ('pending', 'failed')"),
      };
    case 'recompile':
      return {};
    case 'daily_report': {
      const nowIso = context.input.now;
      return {
        failed_jobs: await count('memory_jobs', "WHERE status IN ('failed', 'dead')"),
        failed_runner_jobs: await count('runner_jobs', "WHERE status IN ('failed', 'degraded')"),
        stuck_active_jobs: await count(
          'memory_jobs',
          'WHERE status = \'active\' AND lock_expires_at IS NOT NULL AND lock_expires_at <= $1',
          [nowIso],
        ),
      };
    }
    case 'consolidation':
    case 'forgetting_review':
    case 'auto_promote':
      return {};
  }
}

function hasActionablePhaseWork(
  family: DreamCyclePhaseFamily,
  counts: Record<string, number>,
): boolean {
  switch (family) {
    case 'source_status':
      return (counts.paused_sources ?? 0) > 0;
    case 'source_sync':
      return (counts.unhealthy_connectors ?? 0) > 0;
    case 'raw_ingest':
      return (counts.pending_items ?? 0) > 0 || (counts.failed_items ?? 0) > 0;
    case 'safety_scan':
      return (counts.pending_secret_redactions ?? 0) > 0
        || (counts.flagged_or_quarantined_prompt_injection_flags ?? counts.quarantined_prompt_injection_flags ?? 0) > 0;
    case 'claim_extraction':
      return (counts.pending_claims ?? 0) > 0;
    case 'assertion_resolution':
      return (counts.unresolved_assertions ?? 0) > 0
        || (counts.conflicted_assertions ?? 0) > 0;
    case 'canonical_write':
      return (counts.pending_reconcile_writes ?? 0) > 0
        || (counts.failed_or_conflicted_writes ?? 0) > 0;
    case 'contradiction_review':
      return (counts.open_conflicts ?? 0) > 0;
    case 'projection_reconcile':
      return (counts.pending_reconcile ?? 0) > 0
        || (counts.failed_or_conflicted_projections ?? 0) > 0;
    case 'embedding_refresh':
      return (counts.missing_embeddings ?? 0) > 0;
    case 'context_refresh':
      return (counts.stale_or_failed_derived_artifacts ?? 0) > 0;
    case 'recompile':
      return Object.values(counts).some((count) => count > 0);
    case 'daily_report':
      return (counts.failed_jobs ?? 0) > 0
        || (counts.failed_runner_jobs ?? 0) > 0
        || (counts.stuck_active_jobs ?? 0) > 0
        || (counts.watched_questions_failed ?? 0) > 0
        || (counts.review_items ?? 0) > 0
        || (counts.open_conflicts ?? 0) > 0
        || (counts.incomplete_handoffs ?? 0) > 0;
    case 'consolidation':
    case 'forgetting_review':
    case 'auto_promote':
      return Object.values(counts).some((count) => count > 0);
  }
}

function nextActionForImplementedPhase(family: DreamCyclePhaseFamily): string {
  switch (family) {
    case 'source_status':
      return 'Review source status before processing.';
    case 'source_sync':
      return 'Review connector sync health.';
    case 'raw_ingest':
      return 'Inspect pending or failed raw ingest items.';
    case 'safety_scan':
      return 'Resolve safety flags before runner or LLM access.';
    case 'claim_extraction':
      return 'Run scoped claim extraction through restricted runner policy.';
    case 'assertion_resolution':
      return 'Resolve pending assertions before canonical write.';
    case 'canonical_write':
      return 'Repair pending or failed governed canonical writes.';
    case 'contradiction_review':
      return 'Review open assertion conflicts.';
    case 'projection_reconcile':
      return 'Run system-of-record reconciliation.';
    case 'embedding_refresh':
      return 'Run `mbrain embed --stale` to refresh missing embeddings.';
    case 'context_refresh':
      return 'Refresh pending or failed derived context artifacts.';
    case 'recompile':
      return 'Review governed recompile patch candidates before applying.';
    case 'daily_report':
      return 'Open daily memory report; repair failed jobs and dead-letter stuck active jobs.';
    case 'consolidation':
    case 'forgetting_review':
      return 'Review dream cycle phase output.';
    case 'auto_promote':
      return 'Review auto-promotion results.';
  }
}

async function runConsolidationPhase(
  context: DreamCyclePhaseContext,
): Promise<Partial<DreamCyclePhaseResult>> {
  const report = await runDreamCycleMaintenance(context.engine, {
    scope_id: context.input.scope_id,
    now: context.input.now,
    limit: context.input.limit,
    write_candidates: context.input.dry_run ? false : context.input.write_candidates,
    include_derived_freshness: false,
  });
  for (const candidateId of report.suggestions.flatMap((suggestion) => suggestion.candidate_id ?? [])) {
    context.cycle.dream_generated_candidate_ids.add(candidateId);
  }
  const writeSessionFallbacks = context.input.dry_run || !context.input.write_candidates
    ? { swept: [], skipped: [] }
    : await sweepExpiredWriteSessionFallbacks(context.engine, {
      scope_id: context.input.scope_id,
      now: context.input.now,
      limit: context.input.limit,
    });
  for (const fallback of writeSessionFallbacks.swept) {
    context.cycle.dream_generated_candidate_ids.add(fallback.candidate_id);
  }
  const duplicatePageSuggestions = await findDuplicatePageSuggestions(context.engine, context.input.limit);
  // Deterministic recurrence detection only: the dream cycle reports proposal counts
  // and never creates procedure candidates itself (propose_procedural_candidates
  // with apply=true is the explicit, human-invoked path).
  const proceduralPatterns = await detectProceduralPatterns(context.engine, {
    now: context.input.now,
  });
  const coreMemoryBlocks = await refreshCoreMemoryBlocksSnapshot(context);
  const hasActionableWork = report.suggestions.length > 0
    || writeSessionFallbacks.swept.length > 0
    || duplicatePageSuggestions.length > 0
    || proceduralPatterns.proposals.length > 0;
  return {
    status: hasActionableWork || coreMemoryBlocks.errors.length > 0 ? 'warn' : 'ok',
    counts: {
      suggestions: report.suggestions.length,
      stale_derived_artifacts: report.derived_freshness_report.stale_count,
      expired_write_session_fallbacks: writeSessionFallbacks.swept.length,
      expired_write_session_fallback_skips: writeSessionFallbacks.skipped.length,
      duplicate_page_suggestions: duplicatePageSuggestions.length,
      procedural_pattern_proposals: proceduralPatterns.proposals.length,
      ...coreMemoryBlocks.counts,
    },
    errors: coreMemoryBlocks.errors,
    source_ids: duplicatePageSuggestions.map((suggestion) => `duplicate_page:${suggestion.primary_slug}:${suggestion.duplicate_slug}`),
    projection_ids: report.derived_freshness_report.artifacts.map((artifact) => artifact.id),
    policy_denials: report.apply_control_plane.allowed_without_control_plane ? [] : [{
      code: 'canonical_write_control_plane_required',
      message: 'Dream consolidation cannot mutate canonical memory outside policy.',
    }],
    next_recommended_action: report.suggestions.length > 0 || duplicatePageSuggestions.length > 0 || proceduralPatterns.proposals.length > 0
      ? 'Review dream-cycle candidates, duplicate page suggestions, and procedural rule proposals before applying governed changes.'
      : null,
    canonical_mutations: 0,
    llm_or_runner_used: false,
  };
}

/**
 * N-3: deterministically recompile the budgeted core memory blocks and, outside dry-run,
 * persist the snapshot through the engine config store so SessionStart activation can
 * serve a dream-cycle-refreshed working set. Never fails the consolidation phase.
 */
async function refreshCoreMemoryBlocksSnapshot(
  context: DreamCyclePhaseContext,
): Promise<{ counts: Record<string, number>; errors: string[] }> {
  try {
    const blocks = await buildCoreMemoryBlocks(context.engine, {
      now: context.input.now ? new Date(context.input.now) : undefined,
    });
    const persisted = context.input.dry_run
      ? false
      : await persistCoreMemoryBlocksSnapshot(context.engine, blocks);
    return {
      counts: {
        core_memory_block_lines: blocks.blocks.reduce((total, block) => total + block.lines.length, 0),
        core_memory_block_tokens: blocks.total_token_estimate,
        core_memory_blocks_persisted: persisted ? 1 : 0,
      },
      errors: [],
    };
  } catch (error) {
    return {
      counts: { core_memory_blocks_persisted: 0 },
      errors: [`core memory block refresh failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

async function findDuplicatePageSuggestions(
  engine: BrainEngine,
  limit = 20,
): Promise<Array<{ primary_slug: string; duplicate_slug: string; title: string; reason: string }>> {
  if (typeof engine.listPages !== 'function') return [];
  const pages = await engine.listPages({ limit: 1000, offset: 0 });
  const byTitle = new Map<string, typeof pages>();
  for (const page of pages) {
    const title = normalizeDuplicateTitle(page.title);
    if (!title) continue;
    const group = byTitle.get(title) ?? [];
    group.push(page);
    byTitle.set(title, group);
  }

  const suggestions: Array<{ primary_slug: string; duplicate_slug: string; title: string; reason: string }> = [];
  for (const group of byTitle.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((left, right) => left.slug.localeCompare(right.slug));
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const left = sorted[i]!;
        const right = sorted[j]!;
        if (!isCrossPrefixDuplicatePair(left.slug, right.slug)) continue;
        suggestions.push({
          primary_slug: left.slug,
          duplicate_slug: right.slug,
          title: left.title,
          reason: 'matching_title_across_prefixes',
        });
        if (suggestions.length >= limit) return suggestions;
      }
    }
  }
  return suggestions;
}

function normalizeDuplicateTitle(title: string): string {
  return title.trim().toLocaleLowerCase();
}

function isCrossPrefixDuplicatePair(leftSlug: string, rightSlug: string): boolean {
  const left = normalizeDuplicateSlug(leftSlug);
  const right = normalizeDuplicateSlug(rightSlug);
  if (left === right) return false;
  const leftPrefix = left.split('/')[0] ?? '';
  const rightPrefix = right.split('/')[0] ?? '';
  return leftPrefix !== rightPrefix
    || left.endsWith(`/${right}`)
    || right.endsWith(`/${left}`);
}

function normalizeDuplicateSlug(slug: string): string {
  return slug.replace(/\.md$/i, '').replace(/^\/+|\/+$/g, '').toLocaleLowerCase();
}

async function runRecompilePhase(
  context: DreamCyclePhaseContext,
  deps: DreamCycleRunDeps,
): Promise<Partial<DreamCyclePhaseResult>> {
  if (!context.input.governed_recompile_enabled) {
    return {
      status: 'skipped',
      skip_reason: 'flag_disabled',
      next_recommended_action: 'Enable maintenance.governed_recompile_enabled before running governed recompile.',
      canonical_mutations: 0,
      llm_or_runner_used: false,
    };
  }
  if (!deps.governedRecompile) {
    return {
      status: 'skipped',
      skip_reason: 'runner_unavailable',
      next_recommended_action: 'Configure a governed recompile runner before enabling this phase.',
      canonical_mutations: 0,
      llm_or_runner_used: false,
    };
  }

  const result = await deps.governedRecompile.run({
    scope_id: context.input.scope_id,
    now: context.input.now,
    dry_run: context.input.dry_run,
    write_candidates: context.input.write_candidates,
    limit: context.input.limit,
    signal: context.input.signal,
  });
  const hasWork = Object.values(result.counts).some((count) => count > 0);
  return {
    status: hasWork ? 'warn' : 'ok',
    counts: result.counts,
    source_ids: result.source_ids ?? [],
    assertion_ids: result.candidate_ids ?? [],
    next_recommended_action: hasWork
      ? 'Review governed recompile patch candidates before applying.'
      : 'No governed recompile patch candidates proposed.',
    canonical_mutations: 0,
    llm_or_runner_used: true,
  };
}

async function runDailyReportPhase(
  context: DreamCyclePhaseContext,
  deps: DreamCycleRunDeps,
): Promise<Partial<DreamCyclePhaseResult>> {
  if (context.input.dry_run) {
    return {
      status: 'ok',
      counts: { saved_reports: 0 },
      next_recommended_action: 'Run dream cycle in apply mode to write the daily memory report.',
      canonical_mutations: 0,
      llm_or_runner_used: false,
    };
  }
  const shouldProbeWatchedQuestions = context.input.dry_run === false && context.input.write_candidates === true;
  const watched = shouldProbeWatchedQuestions
    ? await deps.watchedQuestions?.run({
      scope_id: context.input.scope_id,
      now: context.input.now,
      limit: context.input.limit,
    })
    : undefined;
  const saved = await deps.memoryReport?.save({
    scope_id: context.input.scope_id,
    now: context.input.now,
    limit: context.input.limit,
  });
  if (!saved) {
    return runImplementedReadOnlyPhase(context);
  }
  const counts = {
    saved_reports: 1,
    ...(watched ? {
      watched_questions_probed: watched.probed,
      watched_questions_changed: watched.changed,
      watched_questions_initialized: watched.initialized,
      watched_questions_skipped: watched.skipped,
      watched_questions_failed: watched.failures?.length ?? 0,
    } : {}),
    ...(saved.counts ?? {}),
  };
  const hasActionableWork = hasActionablePhaseWork(context.registry.family, counts);
  return {
    status: hasActionableWork ? 'warn' : 'ok',
    counts,
    source_ids: [saved.path],
    next_recommended_action: `Open daily memory report: ${saved.path}`,
    canonical_mutations: 0,
    llm_or_runner_used: false,
    errors: watched?.failures?.map((failure) =>
      `Watched question ${failure.question_id} failed: ${failure.reason}`
    ) ?? [],
  };
}

async function runForgettingReviewPhase(
  context: DreamCyclePhaseContext,
  deps: DreamCycleRunDeps,
): Promise<Partial<DreamCyclePhaseResult>> {
  if (!deps.lifecycleForgetting) {
    return {
      status: 'skipped',
      skip_reason: 'runner_unavailable',
      next_recommended_action: 'Configure lifecycle forgetting service before enabling forgetting review.',
      llm_or_runner_used: false,
    };
  }
  const transitionSweep = context.input.dry_run || !context.input.write_candidates
    ? null
    : await deps.lifecycleForgetting.runDueLifecycleTransitions({
      scope_id: context.input.scope_id,
      now: context.input.now,
      limit: context.input.limit,
      actor: 'mbrain:dream_cycle',
    });
  const report = await deps.lifecycleForgetting.buildDailyReport({
    scope_id: context.input.scope_id,
    now: context.input.now,
    limit: context.input.limit,
  });
  const plan = context.input.dry_run || !context.input.write_candidates
    ? null
    : await deps.lifecycleForgetting.planPurgeCandidates({
      scope_id: context.input.scope_id,
      reason: 'dream forgetting review',
      requested_by: 'mbrain:dream_cycle',
      limit: context.input.limit,
      now: context.input.now,
    });
  const purgeCandidateCount = plan?.items.length ?? report.purge_candidate_count;
  const restoreWindowCount = report.restore_window_count;
  return {
    status: purgeCandidateCount > 0 || restoreWindowCount > 0 ? 'warn' : 'ok',
    counts: {
      purge_candidates: purgeCandidateCount,
      restore_windows: restoreWindowCount,
      purge_plan_items: plan?.items.length ?? 0,
      lifecycle_transitions: transitionSweep?.transitioned.length ?? 0,
    },
    job_ids: plan?.plan ? [plan.plan.id] : [],
    next_recommended_action: purgeCandidateCount > 0
      ? 'Review lifecycle purge candidates before applying destructive forgetting.'
      : restoreWindowCount > 0
        ? 'Review open restore windows before they expire.'
        : null,
    canonical_mutations: 0,
    llm_or_runner_used: false,
  };
}

async function runAutoPromotePhase(
  context: DreamCyclePhaseContext,
  deps: DreamCycleRunDeps,
): Promise<Partial<DreamCyclePhaseResult>> {
  if (!deps.autoPromote || !context.input.allow_local_runner) {
    return {
      status: 'skipped',
      skip_reason: 'runner_unavailable',
      next_recommended_action: 'Enable restricted runner policy before auto-promotion.',
      counts: {},
      canonical_mutations: 0,
      llm_or_runner_used: false,
    };
  }
  const autoPromoteApply = context.input.dry_run
    ? false
    : context.input.write_candidates && context.input.apply_auto_promote;
  const result = await deps.autoPromote.run({
    scope_id: context.input.scope_id,
    now: context.input.now,
    dry_run: !autoPromoteApply,
    limit: context.input.max_candidates_per_cycle ?? context.input.limit,
    allow_canonical_page_writes: autoPromoteApply && context.input.allow_canonical_page_writes,
    max_runner_calls: context.input.max_runner_calls,
    time_budget_ms: context.input.time_budget_ms,
    exclude_candidate_ids: [...context.cycle.dream_generated_candidate_ids].sort(),
    signal: context.input.signal,
  });
  const counts = result.counts ?? {};
  const hasActionableWork = Object.values(counts).some((count) => count > 0);
  return {
    status: hasActionableWork ? 'warn' : 'ok',
    counts,
    next_recommended_action: hasActionableWork ? 'Review auto-promotion results.' : null,
    canonical_mutations: counts.canonical_writes ?? 0,
    llm_or_runner_used: true,
  };
}

async function countRows(
  engine: BrainEngine,
  tableName: string,
  whereClause = '',
  params: unknown[] = [],
): Promise<{ count: number; error: string | null }> {
  const query = `SELECT COUNT(*) AS count FROM ${tableName}${whereClause ? ` ${whereClause}` : ''}`;
  const sql = getUnsafeSql(engine);
  if (sql?.error) {
    return { count: 0, error: countErrorMessage(tableName, sql.error) };
  }
  if (typeof sql?.unsafe === 'function') {
    try {
      const rows = await sql.unsafe(query, params);
      return { count: numberFromCountRow(rows[0]), error: null };
    } catch (error) {
      return { count: 0, error: countErrorMessage(tableName, error) };
    }
  }

  const database = (engine as unknown as { database?: { query?: (statement: string) => { get: (...params: unknown[]) => Record<string, unknown> | null } } }).database;
  if (typeof database?.query === 'function') {
    try {
      return { count: numberFromCountRow(database.query(query).get(...params)), error: null };
    } catch (error) {
      return { count: 0, error: countErrorMessage(tableName, error) };
    }
  }

  return { count: 0, error: countErrorMessage(tableName, 'read model query interface is unavailable') };
}

function countErrorMessage(tableName: string, error: unknown): string {
  return `${tableName}: ${errorMessage(error)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const LOCK_RENEWAL_ERROR_MESSAGE_MAX_LENGTH = 512;
const LOCK_RENEWAL_ERROR_STACK_MAX_LENGTH = 1024;
const LOCK_RENEWAL_ERROR_TRUNCATION_MARKER = '...[truncated]';
const STRICT_ISO_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const LOCK_RENEWAL_SECRET_REDACTIONS: Array<{
  pattern: RegExp;
  replacement: string | ((secret: string) => string);
}> = [
  {
    pattern: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/[^/\s:@]+:[^@\s]+@/gi,
    replacement: (secret) => `${secret.slice(0, secret.indexOf('://') + 3)}[REDACTED:database_connection_string]@`,
  },
  {
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED:pem_private_key]',
  },
  {
    pattern: /\bsk-ant-[A-Za-z0-9_-]{12,}\b/g,
    replacement: '[REDACTED:anthropic_api_key]',
  },
  {
    pattern: /\bsk-[A-Za-z0-9_-]{12,}\b/g,
    replacement: '[REDACTED:openai_api_key]',
  },
  {
    pattern: /\b(?:gh[opsru]_[A-Za-z0-9_]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g,
    replacement: '[REDACTED:github_token]',
  },
  {
    pattern: /\bxox[baprs]-(?:\d{10,}-)?[A-Za-z0-9-]{24,}\b/g,
    replacement: '[REDACTED:slack_token]',
  },
  {
    pattern: /\bA[KS]IA[0-9A-Z]{16}\b/g,
    replacement: '[REDACTED:aws_access_key_id]',
  },
  {
    pattern: /\baws[ _-]?secret[ _-]?access[ _-]?key\s*[:=]\s*(['"]?)[A-Za-z0-9/+=]{40}\1(?=$|[^A-Za-z0-9/+=])/gi,
    replacement: (secret) => `${secret.slice(0, secret.search(/[:=]/) + 1)}[REDACTED:aws_secret_access_key]`,
  },
];

function lockRenewalErrorDiagnostic(error: unknown): NonNullable<DreamCycleGuardrailReport['lock_renewal']['last_error']> {
  const message = sanitizeLockRenewalDiagnosticText(
    errorMessage(error),
    LOCK_RENEWAL_ERROR_MESSAGE_MAX_LENGTH,
    true,
  ) || 'Unknown cycle lock renewal error';
  const stack = error instanceof Error && error.stack
    ? sanitizeLockRenewalDiagnosticText(error.stack, LOCK_RENEWAL_ERROR_STACK_MAX_LENGTH, false)
    : null;
  return { message, stack };
}

function sanitizeLockRenewalDiagnosticText(value: string, maxLength: number, collapseWhitespace: boolean): string {
  const redacted = redactLockRenewalDiagnosticSecrets(value);
  const normalizedNewlines = redacted.replace(/\r\n?/g, '\n');
  const withoutControls = collapseWhitespace
    ? normalizedNewlines.replace(/[\u0000-\u001F\u007F]+/g, ' ')
    : normalizedNewlines.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]+/g, ' ');
  const sanitized = collapseWhitespace ? withoutControls.replace(/\s+/g, ' ').trim() : withoutControls.trim();
  if (sanitized.length <= maxLength) return sanitized;
  return `${sanitized.slice(0, Math.max(0, maxLength - LOCK_RENEWAL_ERROR_TRUNCATION_MARKER.length))}${LOCK_RENEWAL_ERROR_TRUNCATION_MARKER}`;
}

function redactLockRenewalDiagnosticSecrets(value: string): string {
  return LOCK_RENEWAL_SECRET_REDACTIONS.reduce((redacted, { pattern, replacement }) => {
    if (typeof replacement === 'string') {
      return redacted.replace(pattern, replacement);
    }
    return redacted.replace(pattern, replacement);
  }, value);
}

function getUnsafeSql(
  engine: BrainEngine,
): { unsafe?: (statement: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>; error?: unknown } | null {
  try {
    const sql = (engine as unknown as {
      sql?: { unsafe?: (statement: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>> };
    }).sql;
    if (sql) return sql;
  } catch (error) {
    return { error };
  }
  return (engine as unknown as {
    _sql?: { unsafe?: (statement: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>> };
  })._sql ?? null;
}

function numberFromCountRow(row: Record<string, unknown> | null | undefined): number {
  const value = row?.count;
  const count = typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
  return Number.isFinite(count) ? count : 0;
}

function normalizeRunInput(input: DreamCycleRunInput): DreamCyclePhaseContext['input'] {
  const now = input.now ?? new Date().toISOString();
  if (!isStrictIsoDateTime(now)) {
    throw new Error('now must be a valid ISO datetime string');
  }
  const dryRun = input.dry_run !== false;
  return {
    scope_id: input.scope_id?.trim() || 'workspace:default',
    now,
    dry_run: dryRun,
    write_candidates: input.write_candidates === true,
    apply_auto_promote: !dryRun && input.apply_auto_promote === true,
    allow_canonical_page_writes: !dryRun && input.allow_canonical_page_writes === true,
    limit: input.limit,
    max_runner_calls: input.max_runner_calls,
    time_budget_ms: input.time_budget_ms,
    phase_timeout_ms: normalizePositiveInteger(input.phase_timeout_ms, DEFAULT_PHASE_TIMEOUT_MS),
    max_candidates_per_cycle: input.max_candidates_per_cycle,
    allow_llm: input.allow_llm === true,
    allow_local_runner: input.allow_local_runner === true,
    governed_recompile_enabled: input.governed_recompile_enabled === true,
    trigger: input.trigger ?? 'manual',
  };
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function isStrictIsoDateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = STRICT_ISO_DATETIME_PATTERN.exec(value);
  if (!match) return false;
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, , offsetHourRaw, offsetMinuteRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  if (month < 1 || month > 12) return false;
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > maxDay) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (offsetHourRaw !== undefined || offsetMinuteRaw !== undefined) {
    const offsetHour = Number(offsetHourRaw);
    const offsetMinute = Number(offsetMinuteRaw);
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return !Number.isNaN(Date.parse(value));
}

function initialGuardrailReport(input: DreamCyclePhaseContext['input']): DreamCycleGuardrailReport {
  return {
    lock_renewal: {
      status: input.dry_run || !input.write_candidates ? 'not_required' : 'renewed',
      renewal_count: 0,
      last_renewed_at: null,
      reason_codes: [],
    },
    replay_canary: {
      status: 'not_required',
      required: false,
      checked_at: null,
      reason_codes: [],
      summary_lines: [],
    },
  };
}

function initialPhaseCycleState(): DreamCyclePhaseCycleState {
  return {
    dream_generated_candidate_ids: new Set<string>(),
  };
}

async function runReplayCanaryIfRequired(
  input: DreamCyclePhaseContext['input'],
  deps: DreamCycleRunDeps,
): Promise<DreamCycleGuardrailReport['replay_canary']> {
  if (!requiresReplayCanary(input)) {
    return {
      status: 'not_required',
      required: false,
      checked_at: null,
      reason_codes: [],
      summary_lines: [],
    };
  }
  if (!deps.replayCanary) {
    return {
      status: 'not_configured',
      required: true,
      checked_at: input.now,
      reason_codes: ['replay_canary_not_configured'],
      summary_lines: ['Replay canary is required before Dream apply-capable phases.'],
    };
  }
  try {
    const result = await deps.replayCanary.run({
      scope_id: input.scope_id,
      now: input.now,
      trigger: input.trigger,
      write_candidates: input.write_candidates,
      apply_auto_promote: input.apply_auto_promote,
      allow_canonical_page_writes: input.allow_canonical_page_writes,
    });
    return {
      status: result.status,
      required: true,
      checked_at: input.now,
      reason_codes: result.reason_codes ?? [],
      summary_lines: result.summary_lines ?? [],
    };
  } catch (error) {
    return {
      status: 'failed',
      required: true,
      checked_at: input.now,
      reason_codes: ['replay_canary_error'],
      summary_lines: [errorMessage(error)],
    };
  }
}

function requiresReplayCanary(input: DreamCyclePhaseContext['input']): boolean {
  return !input.dry_run && input.write_candidates === true;
}

function blocksApplyByReplayCanary(
  canary: DreamCycleGuardrailReport['replay_canary'],
): boolean {
  return canary.required && canary.status !== 'passed';
}

async function renewDreamLockBeforePhase(
  deps: DreamCycleRunDeps,
  cycleName: string,
  lock: DreamCycleLockResult | null,
  input: DreamCyclePhaseContext['input'],
  registry: DreamCyclePhaseRegistryEntry,
  guardrails: DreamCycleGuardrailReport,
): Promise<{ status: 'not_required' | 'renewed' | 'aborted' }> {
  if (!phaseRequiresLockRenewal(input, registry)) return { status: 'not_required' };
  if (!deps.runtime || lock?.status !== 'acquired') {
    guardrails.lock_renewal = {
      status: 'missing_runtime',
      renewal_count: guardrails.lock_renewal.renewal_count,
      last_renewed_at: guardrails.lock_renewal.last_renewed_at,
      reason_codes: [...guardrails.lock_renewal.reason_codes, 'cycle_lock_runtime_missing'],
    };
    return { status: 'aborted' };
  }

  try {
    const renewed = await deps.runtime.acquireCycleLock({
      cycle_name: cycleName,
      holder_pid: lock.holder.holder_pid,
      holder_host: lock.holder.holder_host,
      holder_kind: lock.holder.holder_kind,
      ttl_ms: 15 * 60 * 1000,
    });
    if (renewed.status !== 'acquired') {
      guardrails.lock_renewal = {
        status: 'aborted',
        renewal_count: guardrails.lock_renewal.renewal_count,
        last_renewed_at: guardrails.lock_renewal.last_renewed_at,
        reason_codes: [...guardrails.lock_renewal.reason_codes, 'cycle_lock_renewal_busy'],
      };
      return { status: 'aborted' };
    }
    guardrails.lock_renewal = {
      status: 'renewed',
      renewal_count: guardrails.lock_renewal.renewal_count + 1,
      last_renewed_at: input.now,
      reason_codes: guardrails.lock_renewal.reason_codes,
    };
    return { status: 'renewed' };
  } catch (error) {
    guardrails.lock_renewal = {
      status: 'aborted',
      renewal_count: guardrails.lock_renewal.renewal_count,
      last_renewed_at: guardrails.lock_renewal.last_renewed_at,
      reason_codes: [...guardrails.lock_renewal.reason_codes, 'cycle_lock_renewal_error'],
      last_error: lockRenewalErrorDiagnostic(error),
    };
    return { status: 'aborted' };
  }
}

function phaseRequiresLockRenewal(
  input: DreamCyclePhaseContext['input'],
  registry: DreamCyclePhaseRegistryEntry,
): boolean {
  if (input.dry_run || !input.write_candidates) return false;
  if (registry.family === 'auto_promote') {
    return input.apply_auto_promote;
  }
  return registry.family === 'consolidation' || registry.family === 'forgetting_review';
}

async function acquireDreamLock(
  deps: DreamCycleRunDeps,
  cycleName: string,
  now: string,
): Promise<DreamCycleLockResult | null> {
  if (!deps.runtime) {
    return {
      status: 'missing_runtime',
      acquired_at: now,
      message: 'Mutating dream runs require a maintenance runtime cycle lock.',
    };
  }
  const holder = deps.holder ?? {
    holder_pid: typeof process.pid === 'number' ? process.pid : 0,
    holder_host: hostname() || 'localhost',
    holder_kind: 'manual',
  };
  const result = await deps.runtime.acquireCycleLock({
    cycle_name: cycleName,
    holder_pid: holder.holder_pid,
    holder_host: holder.holder_host,
    holder_kind: holder.holder_kind,
    ttl_ms: 15 * 60 * 1000,
  });
  return {
    ...result,
    holder,
    acquired_at: now,
  };
}

function dreamCycleLockName(scopeId: string): string {
  return `dream_cycle:${scopeId}`;
}

function phaseResult(
  registry: DreamCyclePhaseRegistryEntry,
  patch: Partial<Omit<DreamCyclePhaseResult, 'family' | 'owner_phase' | 'duration_ms'>>,
  started: number,
): DreamCyclePhaseResult {
  return {
    family: registry.family,
    owner_phase: registry.owner_phase,
    status: patch.status ?? 'ok',
    duration_ms: Math.max(0, Date.now() - started),
    timed_out: patch.timed_out ?? false,
    counts: patch.counts ?? {},
    source_ids: patch.source_ids ?? [],
    assertion_ids: patch.assertion_ids ?? [],
    projection_ids: patch.projection_ids ?? [],
    job_ids: patch.job_ids ?? [],
    policy_denials: patch.policy_denials ?? [],
    conflicts: patch.conflicts ?? [],
    errors: patch.errors ?? [],
    skip_reason: patch.skip_reason ?? null,
    next_recommended_action: patch.next_recommended_action ?? null,
    canonical_mutations: patch.canonical_mutations ?? 0,
    llm_or_runner_used: patch.llm_or_runner_used ?? false,
  };
}

function summarizeStatus(phases: DreamCyclePhaseResult[]): DreamCycleRunResult['status'] {
  if (phases.some((phase) => phase.status === 'failed')) return 'failed';
  if (phases.some((phase) => phase.status === 'warn')) return 'warn';
  return 'ok';
}

function buildResult(
  input: DreamCyclePhaseContext['input'],
  phases: DreamCyclePhaseResult[],
  status: DreamCycleRunResult['status'],
  lock: DreamCycleLockResult | null,
  guardrails: DreamCycleGuardrailReport,
  cycle: DreamCyclePhaseCycleState,
): DreamCycleRunResult {
  return {
    status,
    mode: input.dry_run ? 'dry_run' : 'apply',
    scope_id: input.scope_id,
    generated_at: input.now,
    trigger: input.trigger,
    canonical_write_allowed: false,
    llm_or_runner_used: phases.some((phase) => phase.llm_or_runner_used),
    cycle_lock: lock,
    guardrails,
    self_consumption_guard: {
      generated_by: 'dream_cycle',
      anti_loop_marker: 'mbrain:dream-cycle-output:v1',
      raw_source_ingest_allowed: false,
      same_cycle_candidate_promotion_allowed: false,
      guarded_candidate_ids: [...cycle.dream_generated_candidate_ids].sort(),
    },
    phases,
    summary_lines: [
      `Dream cycle ${status} for ${input.scope_id}.`,
      `Mode: ${input.dry_run ? 'dry-run' : 'apply'}.`,
      'Canonical writes: disabled; policy-controlled apply remains mandatory.',
    ],
  };
}
