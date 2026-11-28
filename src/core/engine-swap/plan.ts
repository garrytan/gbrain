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
import { collationReport, type CollationReport } from './collation-report.ts';
import { FAILBACK_ACCEPTED_LOSSES, FAILBACK_KNOWN_LIMITS, FINGERPRINT_RULE_TEXT, RUST_REMOTE_LIMITS, WAY_BACK_TEXT } from './failback.ts';
import { failbackLosses, type FailbackLosses } from './failback-read.ts';
import type { BrainEngine } from '../engine.ts';
import type { EngineCapabilities } from '../engine-capabilities.ts';
import { readManagedMode } from '../persistence/managed-mode.ts';
import { activeWorktreeRefreshes } from '../persistence/worktree-refresh.ts';
import { usableDestination, type DestinationOptions } from './destination.ts';
import { servedCapabilities, storeCapabilities } from '../rust-engine/store-capabilities.ts';
import { rustMultiuserFromEnv } from '../rust-engine/multiuser-switch.ts';
import { evaluateReadiness, type ReadinessVerdict, type ShadowStatus } from './readiness.ts';
import { capabilityReport, estimateWritePause, type CapabilityReport, type WritePauseEstimate } from './capability.ts';
import { swapBlockers, type SwapBlocker } from './gates.ts';
import { policyInForce, READINESS_POLICY, type PolicyInForce, type ReadinessPolicy } from './policy.ts';
import { managedStorageError, refreshUnsettledError, type SwapRefusalReason, type UnsettledRefresh } from './refusals.ts';

/** Environment variables that can select the current engine or its database (names only; values are never read out). */
export const ENGINE_SELECTING_ENV = ['GBRAIN_DATABASE_URL', 'DATABASE_URL', 'GBRAIN_HOME', 'GBRAIN_BRAIN_ID'] as const;

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
  /** The readiness policy in force for this brain (criterion 1's minimum shadow duration), its hash, the dated
   * override considered (applies or why not) and the brain reference an override binds. */
  policy: { text: string; hash: string; override: PolicyInForce['override']; brain_ref: string | null };
  /** What the Rust engine does not serve that the current engine does. */
  capability_report: CapabilityReport;
  /** The estimated time writes are refused during a run. */
  write_pause: WritePauseEstimate;
  /** What the Rust engine cannot serve for this brain yet; a run refuses while any is listed. */
  blockers: SwapBlocker[];
  /** The way back (not bound by the plan hash): failback's closed loss list, accepted losses, known limits and rules. */
  way_back: WayBack;
  /** Report only, not bound by the plan hash: the lists whose order changes on a non-byte-order Postgres source (D25 A1). */
  collation: CollationReport;
  /** Present only for a managed brain: what managed mode does not yet do on a Rust brain (MANAGED_RUST_LOSSES). */
  managed_known_losses?: string[];
  plan_hash: string;
}

export interface WayBack {
  statement: string;
  accepted_losses: readonly string[];
  /** Null when the primary's schema could not be read; the plan text says so. */
  losses: FailbackLosses | null;
  known_limits: readonly string[];
  /** What remote callers lose on the Rust engine (named losses). */
  remote_limits: readonly string[];
  fingerprint_rule: string;
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
  /** The readiness policy (default: the approved `READINESS_POLICY`); tests pass another. */
  policy?: ReadinessPolicy;
  /** The configured brain has remote MCP (config `remote_mcp`). */
  remoteMcpConfigured?: boolean;
  /** The capabilities the Rust engine serves (default: this build's member table); tests pass another. */
  rustServes?: EngineCapabilities;
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
 * What a managed brain loses on a Rust destination today (single-host and multi-user), named in the plan instead of
 * refused. Empty: the one loss it named (RUST_ENGINE.md conflict row 55a, a failing Git effect's raw recovery read) is
 * closed, as recordFailure reads it through the typed persistenceUpkeepStore. A managed plan keeps the empty field;
 * an unmanaged plan does not carry it.
 */
export const MANAGED_RUST_LOSSES: readonly string[] = [];

/** The plan hash binds what a run would act on, never volatile readings (time, free space). */
function planHash(p: Omit<SwapPlan, 'plan_hash'>, dest: DestinationOptions | undefined): string {
  const usable = usableDestination(dest);
  // Config evidence that does not count is left out: it is what every switched-on host without a brain server reads,
  // it cannot lift a refusal, and binding it would move the hash of every such plan.
  const d = usable && (usable.source !== 'config' || usable.served) ? usable : null;
  const bound = {
    to: p.to, from: p.from, verdict: p.verdict, reason: p.reason,
    criteria: p.criteria.map(c => [c.n, c.state]), routes: p.routes,
    policy: p.policy.hash, blockers: p.blockers.map(b => b.reason), lost: p.capability_report.lost.map(l => l.capability),
    // Bound only when destination evidence exists and the switch is on, so every other plan hashes as before.
    ...(d ? { destination: { engine: d.engine, brain_id: d.brain_id, served: d.served, multiuser: d.multiuser,
      // Config evidence also binds that it is config-only, the address the run will check and the store brain id the
      // server there must serve, so a plan read before the store changed no longer matches its --expect hash.
      ...(d.source === 'config' ? { source: d.source, listen: d.listen ?? null, store_brain_id: d.store_brain_id ?? null } : {}) } } : {}),
  };
  return createHash('sha256').update(JSON.stringify(bound)).digest('hex').slice(0, 16);
}

/** Builds the read-only plan. Throws `engine_swap_refused` (`managed_storage` when the destination cannot hold a managed brain,
 * `refresh_unsettled`) before reading any criterion. */
export async function planEngineSwap(engine: BrainEngine, deps: SwapPlanInputs = {}): Promise<SwapPlan> {
  const managed = await assertNotManaged(engine, deps.destination);
  await assertRefreshesSettled(engine);
  const now = deps.now ?? new Date();
  const inForce = policyInForce(deps.policy ?? READINESS_POLICY, await engine.readPersistenceBrainId(), now);
  const status = deps.readShadowStatus ? await deps.readShadowStatus(engine) : null;
  const readiness = evaluateReadiness(status, now, inForce.policy, deps.destination);
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
    policy: { text: inForce.text, hash: inForce.hash, override: inForce.override, brain_ref: inForce.brain_ref },
    capability_report: capabilityReport(String(engine.kind)),
    write_pause: await estimateWritePause(engine),
    blockers: await swapBlockers(engine, { remoteMcpConfigured: !!deps.remoteMcpConfigured, rustServes: deps.rustServes }),
    way_back: await wayBack(engine),
    collation: collationReport(String(engine.kind), status?.fingerprints?.probe ?? null),
    ...(managed ? { managed_known_losses: [...MANAGED_RUST_LOSSES] } : {}),
  };
  return { ...base, plan_hash: planHash(base, deps.destination) };
}

async function wayBack(engine: BrainEngine): Promise<WayBack> {
  let losses: FailbackLosses | null = null;
  try { losses = await failbackLosses(engine); } catch { losses = null; }
  return { statement: WAY_BACK_TEXT, accepted_losses: FAILBACK_ACCEPTED_LOSSES, losses, known_limits: FAILBACK_KNOWN_LIMITS, remote_limits: RUST_REMOTE_LIMITS, fingerprint_rule: FINGERPRINT_RULE_TEXT };
}
