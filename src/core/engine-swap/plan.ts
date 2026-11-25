/**
 * The read-only swap plan (`gbrain engine swap --to rust --plan`, PR S5a; docs/designs/RUST_ENGINE.md "Swap and the way
 * back"). Nothing here writes: one read of the refresh journal and the shadow status; the caller passes the
 * environment and service definitions by name and the free disk space.
 *
 * Order: the managed-storage gate and then the refresh gate (row L7-1) run before any readiness criterion is read,
 * and refuse with `engine_swap_refused` / `managed_storage` or `refresh_unsettled`. Every other blocker is a NOT READY verdict in a plan that can be read
 * but not run.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { readManagedMode } from '../persistence/managed-mode.ts';
import { activeWorktreeRefreshes } from '../persistence/worktree-refresh.ts';
import { evaluateReadiness, type ReadinessVerdict, type ShadowStatus } from './readiness.ts';
import { managedStorageError, refreshUnsettledError, type SwapRefusalReason, type UnsettledRefresh } from './refusals.ts';

/** Environment variables that can select the current engine or its database (names only; values are never read out). */
export const ENGINE_SELECTING_ENV = ['GBRAIN_DATABASE_URL', 'DATABASE_URL', 'GBRAIN_HOME', 'GBRAIN_BRAIN_ID'] as const;

/** Plan items that need the swap run's machinery (S5b); the plan names them instead of guessing. */
export const DEFERRED_TO_S5B: Readonly<Record<'capability_report' | 'expected_write_pause', string>> = {
  capability_report: 'The Rust capability set is read through the addon loader wiring, which the CLI connect PR lands; S5b prints the report against it.',
  expected_write_pause: 'The pause is the graduation drain plus the final digest, measured under the write fence S5b builds; S5a has no fence to measure.',
};

export interface ServiceDefinition {
  /** The file name only, never its content. */
  name: string;
  kind: 'launchd' | 'systemd';
  /** Engine-selecting variable names the definition sets (names only). */
  sets: string[];
  /** The file could not be read, so `sets` is unknown, not empty. */
  unread?: 'read_failed';
}

export interface SwapPlan {
  schema_version: 1;
  to: 'rust';
  from: string;
  verdict: ReadinessVerdict['verdict'];
  /** The refusal a run would give; null when READY. */
  reason: SwapRefusalReason | null;
  /** True when a shadow status document was found for this brain. */
  shadow: boolean;
  criteria: ReadinessVerdict['criteria'];
  missing_fields: string[];
  refreshes: { unsettled: 0; checked: true };
  routes: { env: string[]; services: ServiceDefinition[] };
  disk: { path: string; free_bytes: number | null };
  deferred: typeof DEFERRED_TO_S5B;
  plan_hash: string;
}

export interface SwapPlanInputs {
  /** The shadow status document (S3); null when no shadow runs for this brain. */
  readShadowStatus?: (engine: BrainEngine) => Promise<ShadowStatus | null>;
  /** Engine-selecting variable names set on this machine (the caller reads the environment, by name only). */
  envNames?: string[];
  services?: ServiceDefinition[];
  disk?: { path: string; free_bytes: number | null };
  now?: Date;
}

/** Non-terminal refresh rows (draining, fenced, merged, syncing, recovery_required), through the reader
 * `gbrain sources writer status` uses. A schema that predates the refresh journal has none. */
export async function readUnsettledRefreshes(engine: BrainEngine): Promise<UnsettledRefresh[]> {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await activeWorktreeRefreshes(engine);
  } catch (error) {
    if (/persistence_worktree_refreshes.*does not exist|relation .* does not exist/i.test(String((error as Error)?.message ?? error))) return [];
    throw error;
  }
  return rows.map(r => ({
    id: String(r.refresh_id), state: String(r.state), source_ids: [...((r.source_ids as string[] | null) ?? [])],
    updated_at: typeof r.updated_at === 'string' ? r.updated_at : null,
    next: typeof r.next === 'string' ? r.next : null,
  }));
}

/** Throws `engine_swap_refused` / `refresh_unsettled` when any refresh row is unfinished (row L7-1). */
export async function assertRefreshesSettled(engine: BrainEngine): Promise<void> {
  const rows = await readUnsettledRefreshes(engine);
  if (rows.length) throw refreshUnsettledError(rows);
}

/** Throws `engine_swap_refused` / `managed_storage` when the brain uses managed storage, which Rust never holds. A
 * persistence state that is missing or malformed refuses `storage_error` (readManagedMode), never reads as unmanaged. */
export async function assertNotManaged(engine: BrainEngine): Promise<void> {
  const managed = await readManagedMode(engine, { refusal: { subject: 'The engine swap plan', consequence: 'the swap refuses rather than guess whether the brain uses managed storage' } });
  if (managed) throw managedStorageError();
}

/** The plan hash binds what a run would act on, never volatile readings (time, free space). */
function planHash(p: Omit<SwapPlan, 'plan_hash'>): string {
  const bound = {
    to: p.to, from: p.from, verdict: p.verdict, reason: p.reason,
    criteria: p.criteria.map(c => [c.n, c.state]), routes: p.routes,
  };
  return createHash('sha256').update(JSON.stringify(bound)).digest('hex').slice(0, 16);
}

/** Builds the read-only plan. Throws `engine_swap_refused` (`managed_storage`, `refresh_unsettled`) before reading any criterion. */
export async function planEngineSwap(engine: BrainEngine, deps: SwapPlanInputs = {}): Promise<SwapPlan> {
  await assertNotManaged(engine);
  await assertRefreshesSettled(engine);
  const status = deps.readShadowStatus ? await deps.readShadowStatus(engine) : null;
  const readiness = evaluateReadiness(status, deps.now ?? new Date());
  const base: Omit<SwapPlan, 'plan_hash'> = {
    schema_version: 1,
    to: 'rust',
    from: String(engine.kind),
    verdict: readiness.verdict,
    reason: readiness.reason,
    shadow: status !== null,
    criteria: readiness.criteria,
    missing_fields: readiness.missing_fields,
    refreshes: { unsettled: 0, checked: true },
    routes: { env: [...(deps.envNames ?? [])], services: [...(deps.services ?? [])] },
    disk: deps.disk ?? { path: '', free_bytes: null },
    deferred: DEFERRED_TO_S5B,
  };
  return { ...base, plan_hash: planHash(base) };
}
