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
import { usableDestination, type DestinationOptions } from './destination.ts';
import { servedCapabilities, storeCapabilities } from '../rust-engine/store-capabilities.ts';
import { rustMultiuserFromEnv } from '../rust-engine/multiuser-switch.ts';
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
  /** Present only for a managed brain with the multi-user switch on: what managed mode does not yet do there (MANAGED_MULTIUSER_LOSSES). */
  managed_known_losses?: string[];
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
  /** The destination evidence and the resolved multi-user switch (destination.ts); none keeps the plan as it always was. */
  destination?: DestinationOptions;
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

/**
 * Whether the Rust destination can hold a managed brain: this build's Rust engine serves `managed_persistence` on a store
 * in the destination's mode. A multi-user store serves it on I-5 leases (slice 3); a capability the store withholds in that
 * mode (rust-engine/store-capabilities.ts MULTIUSER_WITHHELD, empty today) refuses the swap again.
 */
export function rustHoldsManagedStorage(destination: DestinationOptions | undefined): boolean {
  if (!servedCapabilities().has('managed_persistence')) return false;
  return storeCapabilities({ multiuser: destination?.multiuser ?? rustMultiuserFromEnv() }).has('managed_persistence');
}

/** Throws `engine_swap_refused` / `managed_storage` when the brain uses managed storage and the Rust destination cannot
 * hold it (rustHoldsManagedStorage). A persistence state that is missing or malformed refuses `storage_error`
 * (readManagedMode), never reads as unmanaged. */
export async function assertNotManaged(engine: BrainEngine, destination?: DestinationOptions): Promise<boolean> {
  const managed = await readManagedMode(engine, { refusal: { subject: 'The engine swap plan', consequence: 'the swap refuses rather than guess whether the brain uses managed storage' } });
  if (managed && !rustHoldsManagedStorage(destination)) throw managedStorageError(servedCapabilities().has('managed_persistence') ? 'multiuser' : 'unsupported');
  return managed;
}

/**
 * What a managed brain loses on a multi-user Rust destination today, named in the plan instead of refused (RUST_ENGINE.md
 * conflict row 55). Empty for an unmanaged brain or a single-host destination, and then absent from the plan.
 */
export const MANAGED_MULTIUSER_LOSSES: readonly string[] = [
  'A Git effect that fails (git_unavailable, a push refusal) records its failure through raw SQL (persistence/effects.ts recordFailure) until lane 7\'s typed persistenceUpkeepStore (rust-engine/managed-parity-rows 20da396ebd) reaches rust-engine/multiuser, so on a multi-user Rust brain it refuses raw_sql instead of retrying and parking. Owner: lane 7.',
];

/** The plan hash binds what a run would act on, never volatile readings (time, free space). */
function planHash(p: Omit<SwapPlan, 'plan_hash'>, dest: DestinationOptions | undefined): string {
  const usable = usableDestination(dest);
  // Config evidence that does not count is left out: it is what every switched-on host without a brain server reads,
  // it cannot lift a refusal, and binding it would move the hash of every such plan.
  const d = usable && (usable.source !== 'config' || usable.served) ? usable : null;
  const bound = {
    to: p.to, from: p.from, verdict: p.verdict, reason: p.reason,
    criteria: p.criteria.map(c => [c.n, c.state]), routes: p.routes,
    // Bound only when destination evidence exists and the switch is on, so every other plan hashes as before.
    ...(d ? { destination: { engine: d.engine, brain_id: d.brain_id, served: d.served, multiuser: d.multiuser,
      // Config evidence also binds that it is config-only and the address the run will check.
      ...(d.source === 'config' ? { source: d.source, listen: d.listen ?? null } : {}) } } : {}),
  };
  return createHash('sha256').update(JSON.stringify(bound)).digest('hex').slice(0, 16);
}

/** Builds the read-only plan. Throws `engine_swap_refused` (`managed_storage` when the destination cannot hold a managed brain,
 * `refresh_unsettled`) before reading any criterion. */
export async function planEngineSwap(engine: BrainEngine, deps: SwapPlanInputs = {}): Promise<SwapPlan> {
  const managed = await assertNotManaged(engine, deps.destination);
  await assertRefreshesSettled(engine);
  const status = deps.readShadowStatus ? await deps.readShadowStatus(engine) : null;
  const readiness = evaluateReadiness(status, deps.now ?? new Date(), deps.destination);
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
    ...(managed && (deps.destination?.multiuser ?? rustMultiuserFromEnv()) ? { managed_known_losses: [...MANAGED_MULTIUSER_LOSSES] } : {}),
  };
  return { ...base, plan_hash: planHash(base, deps.destination) };
}
