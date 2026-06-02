import type { BrainEngine } from '../engine.ts';
import { hostname } from 'os';
import type {
  AcquireMaintenanceCycleLockResult,
  MaintenanceRuntimeService,
} from './maintenance-runtime-service.ts';
import { runDreamCycleMaintenance } from './dream-cycle-maintenance-service.ts';
import type { LifecycleForgettingService } from './lifecycle-forgetting-service.ts';

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
  | 'daily_report'
  | 'auto_promote';

export type DreamCyclePhaseStatus = 'ok' | 'warn' | 'failed' | 'skipped';
export type DreamCycleSkipReason = 'phase_not_available' | 'runner_unavailable';

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
  limit?: number;
  allow_llm?: boolean;
  allow_local_runner?: boolean;
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
  self_consumption_guard: {
    generated_by: 'dream_cycle';
    anti_loop_marker: 'mbrain:dream-cycle-output:v1';
    raw_source_ingest_allowed: false;
  };
  phases: DreamCyclePhaseResult[];
  summary_lines: string[];
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
    run(input: { scope_id: string; now?: string; dry_run?: boolean }): Promise<{ counts: Record<string, number> }>;
  };
}

export type DreamCyclePhaseHandler = (
  context: DreamCyclePhaseContext,
) => Promise<Partial<Omit<DreamCyclePhaseResult, 'family' | 'owner_phase' | 'duration_ms'>>>;

export interface DreamCyclePhaseContext {
  engine: BrainEngine;
  input: Required<Pick<DreamCycleRunInput, 'dry_run' | 'write_candidates' | 'trigger'>> & {
    scope_id: string;
    now: string;
    limit?: number;
    allow_llm: boolean;
    allow_local_runner: boolean;
  };
  registry: DreamCyclePhaseRegistryEntry;
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
  { order: 14, family: 'daily_report', owner_phase: 'Phase 12', runner_backed: false, implemented: true },
  { order: 15, family: 'auto_promote', owner_phase: 'Phase 07', runner_backed: true, implemented: true },
] as const;

export async function runDreamCycle(
  engine: BrainEngine,
  input: DreamCycleRunInput = {},
  deps: DreamCycleRunDeps = {},
): Promise<DreamCycleRunResult> {
  const normalized = normalizeRunInput(input);
  const mutating = normalized.dry_run === false && normalized.write_candidates === true;
  const lockName = dreamCycleLockName(normalized.scope_id);
  const lock = mutating ? await acquireDreamLock(deps, lockName, normalized.now) : null;
  if (lock?.status === 'missing_runtime') {
    return buildResult(normalized, [], 'failed', lock);
  }
  if (lock?.status === 'busy') {
    return buildResult(normalized, [], 'failed', lock);
  }

  try {
    const phases: DreamCyclePhaseResult[] = [];
    for (const registry of DREAM_CYCLE_PHASE_FAMILIES) {
      phases.push(await runPhase(engine, normalized, registry, deps));
    }
    const status = summarizeStatus(phases);
    return buildResult(normalized, phases, status, lock);
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
    return phaseResult(registry, await handler({ engine, input, registry }), started);
  } catch (error) {
    return phaseResult(registry, {
      status: 'failed',
      errors: [error instanceof Error ? error.message : String(error)],
      next_recommended_action: 'Inspect phase error and retry dream cycle after repair.',
      llm_or_runner_used: false,
    }, started);
  }
}

function defaultPhaseHandler(
  registry: DreamCyclePhaseRegistryEntry,
  deps: DreamCycleRunDeps,
): DreamCyclePhaseHandler | undefined {
  if (registry.family === 'consolidation') return runConsolidationPhase;
  if (registry.family === 'forgetting_review') {
    return (context) => runForgettingReviewPhase(context, deps);
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
  const count = async (tableName: string, whereClause = ''): Promise<number> => {
    const result = await countRows(context.engine, tableName, whereClause);
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
  count: (tableName: string, whereClause?: string) => Promise<number>,
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
        quarantined_prompt_injection_flags: await count('prompt_injection_flags', "WHERE risk = 'quarantined'"),
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
    case 'daily_report':
      return {
        failed_jobs: await count('memory_jobs', "WHERE status IN ('failed', 'dead')"),
        failed_runner_jobs: await count('runner_jobs', "WHERE status IN ('failed', 'degraded')"),
      };
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
        || (counts.quarantined_prompt_injection_flags ?? 0) > 0;
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
    case 'daily_report':
      return (counts.failed_jobs ?? 0) > 0 || (counts.failed_runner_jobs ?? 0) > 0;
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
      return 'Refresh missing embeddings.';
    case 'context_refresh':
      return 'Refresh pending or failed derived context artifacts.';
    case 'daily_report':
      return 'Open daily memory report and repair failed jobs.';
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
  return {
    status: report.suggestions.length > 0 ? 'warn' : 'ok',
    counts: {
      suggestions: report.suggestions.length,
      stale_derived_artifacts: report.derived_freshness_report.stale_count,
    },
    projection_ids: report.derived_freshness_report.artifacts.map((artifact) => artifact.id),
    policy_denials: report.apply_control_plane.allowed_without_control_plane ? [] : [{
      code: 'canonical_write_control_plane_required',
      message: 'Dream consolidation cannot mutate canonical memory outside policy.',
    }],
    next_recommended_action: report.suggestions.length > 0
      ? 'Review dream-cycle candidates before applying governed changes.'
      : null,
    canonical_mutations: 0,
    llm_or_runner_used: false,
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
  const result = await deps.autoPromote.run({
    scope_id: context.input.scope_id,
    now: context.input.now,
    dry_run: context.input.dry_run || !context.input.write_candidates,
  });
  const counts = result.counts ?? {};
  const hasActionableWork = Object.values(counts).some((count) => count > 0);
  return {
    status: hasActionableWork ? 'warn' : 'ok',
    counts,
    next_recommended_action: hasActionableWork ? 'Review auto-promotion results.' : null,
    canonical_mutations: 0,
    llm_or_runner_used: true,
  };
}

async function countRows(
  engine: BrainEngine,
  tableName: string,
  whereClause = '',
): Promise<{ count: number; error: string | null }> {
  const query = `SELECT COUNT(*) AS count FROM ${tableName}${whereClause ? ` ${whereClause}` : ''}`;
  const sql = getUnsafeSql(engine);
  if (sql?.error) {
    return { count: 0, error: countErrorMessage(tableName, sql.error) };
  }
  if (typeof sql?.unsafe === 'function') {
    try {
      const rows = await sql.unsafe(query);
      return { count: numberFromCountRow(rows[0]), error: null };
    } catch (error) {
      return { count: 0, error: countErrorMessage(tableName, error) };
    }
  }

  const database = (engine as unknown as { database?: { query?: (statement: string) => { get: () => Record<string, unknown> | null } } }).database;
  if (typeof database?.query === 'function') {
    try {
      return { count: numberFromCountRow(database.query(query).get()), error: null };
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

function getUnsafeSql(
  engine: BrainEngine,
): { unsafe?: (statement: string) => Promise<Array<Record<string, unknown>>>; error?: unknown } | null {
  try {
    const sql = (engine as unknown as {
      sql?: { unsafe?: (statement: string) => Promise<Array<Record<string, unknown>>> };
    }).sql;
    if (sql) return sql;
  } catch (error) {
    return { error };
  }
  return (engine as unknown as {
    _sql?: { unsafe?: (statement: string) => Promise<Array<Record<string, unknown>>> };
  })._sql ?? null;
}

function numberFromCountRow(row: Record<string, unknown> | null | undefined): number {
  const value = row?.count;
  const count = typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
  return Number.isFinite(count) ? count : 0;
}

function normalizeRunInput(input: DreamCycleRunInput): DreamCyclePhaseContext['input'] {
  const now = input.now ?? new Date().toISOString();
  if (typeof now !== 'string' || Number.isNaN(Date.parse(now))) {
    throw new Error('now must be a valid ISO datetime string');
  }
  return {
    scope_id: input.scope_id?.trim() || 'workspace:default',
    now,
    dry_run: input.dry_run !== false,
    write_candidates: input.write_candidates === true,
    limit: input.limit,
    allow_llm: input.allow_llm === true,
    allow_local_runner: input.allow_local_runner === true,
    trigger: input.trigger ?? 'manual',
  };
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
    self_consumption_guard: {
      generated_by: 'dream_cycle',
      anti_loop_marker: 'mbrain:dream-cycle-output:v1',
      raw_source_ingest_allowed: false,
    },
    phases,
    summary_lines: [
      `Dream cycle ${status} for ${input.scope_id}.`,
      `Mode: ${input.dry_run ? 'dry-run' : 'apply'}.`,
      'Canonical writes: disabled; policy-controlled apply remains mandatory.',
    ],
  };
}
