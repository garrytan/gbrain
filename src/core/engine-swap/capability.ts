/**
 * The plan's capability report and expected write pause (docs/designs/RUST_ENGINE.md "Swap and the way back").
 *
 * The capability report compares what the current engine reports with what the Rust engine serves (the member table
 * the addon loader wires, `servedCapabilities`), and lists, per capability the Rust engine does not serve, the engine
 * members that refuse there. It is static for a build, so it needs no addon load.
 *
 * The expected write pause is an estimate, with its inputs: the graduation drain of pending requests plus two full
 * digest passes over the copied relations, at fixed rates. It is printed, never bound into the plan hash.
 */
import { rethrowCapabilityRefusal } from '../engine-capability-refusal.ts';
import { capabilitiesForEngineKind, ENGINE_CAPABILITIES, type Capability } from '../engine-capabilities.ts';
import type { BrainEngine } from '../engine.ts';
import { RUST_ENGINE_MEMBERS } from '../rust-engine/members.ts';
import { servedCapabilities } from '../rust-engine/store-capabilities.ts';
import { STORE_MEMBERS } from '../rust-engine/store-members/index.ts';

export interface CapabilityReport {
  /** Capabilities the Rust engine serves, in registry order. */
  served: Capability[];
  /** Capabilities the current engine reports that the Rust engine does not, each with the members that refuse there. */
  lost: Array<{ capability: Capability; members: string[] }>;
}

export function capabilityReport(fromKind: string): CapabilityReport {
  const served = servedCapabilities();
  const current = fromKind === 'pglite' || fromKind === 'postgres' ? capabilitiesForEngineKind(fromKind) : new Set<Capability>();
  const refusing = new Map<string, string[]>();
  for (const [member, cls] of Object.entries(RUST_ENGINE_MEMBERS) as Array<[string, string]>) {
    if (cls === 'implemented' || member in STORE_MEMBERS) continue;
    refusing.set(cls, [...(refusing.get(cls) ?? []), member]);
  }
  return {
    served: ENGINE_CAPABILITIES.filter(c => served.has(c)),
    lost: ENGINE_CAPABILITIES.filter(c => current.has(c) && !served.has(c))
      .map(capability => ({ capability, members: [...(refusing.get(capability) ?? [])].sort() })),
  };
}

/** Rows per second one digest pass reads on both engines, and the drain time per pending request (estimates). */
export const DIGEST_ROWS_PER_SECOND = 20_000;
export const DRAIN_MS_PER_REQUEST = 50;

export interface WritePauseEstimate {
  /** Seconds writes are refused, from the fence to the authority switch. */
  seconds: number;
  rows: number;
  pending_requests: number;
  basis: string;
}

async function scalar(engine: BrainEngine, sql: string): Promise<number> {
  try {
    const [row] = await engine.executeRaw<{ n: number | string }>(sql);
    return Math.max(0, Math.round(Number(row?.n ?? 0)));
  } catch (error) {
    rethrowCapabilityRefusal(error);
    if (/does not exist/i.test(String((error as Error)?.message ?? error))) return 0;
    throw error;
  }
}

/** The planner's row estimates (no table scan) and the pending request count. */
export async function estimateWritePause(engine: BrainEngine): Promise<WritePauseEstimate> {
  const rows = await scalar(engine, `SELECT COALESCE(sum(GREATEST(c.reltuples, 0)), 0)::bigint AS n FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relkind = 'r'`);
  const pending = await scalar(engine, `SELECT count(*)::int AS n FROM persistence_requests WHERE state IN ('queued', 'deferred', 'running', 'recovering')`);
  const ms = pending * DRAIN_MS_PER_REQUEST + (2 * rows * 1000) / DIGEST_ROWS_PER_SECOND;
  return {
    seconds: Math.max(1, Math.ceil(ms / 1000)),
    rows,
    pending_requests: pending,
    basis: `${pending} pending request(s) at ${DRAIN_MS_PER_REQUEST} ms each, then 2 digest passes over about ${rows} rows at ${DIGEST_ROWS_PER_SECOND} rows/s`,
  };
}
