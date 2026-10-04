/**
 * Per-initialize inputs for the generated MCP instructions (agent operator
 * contract v1, F1): the caller's callable tool names (the tools/list
 * predicate) and the readiness tail (config plane + the probed tier within
 * its 250 ms best-effort bound; HTTP gets the redacted view). Every failure
 * degrades to "no tail" — the handshake never waits on or fails over it.
 */
import type { BrainEngine } from '../core/engine.ts';
import type { GBrainConfig } from '../core/config.ts';
import type { AuthInfo, Operation } from '../core/operations.ts';
import { opAllowedForBoundClient } from '../core/operations.ts';
import { isCallable, publishGatesFromDisabled } from '../core/ops/callable.ts';
import { configReadiness, probedReadiness, readinessHttpView, readinessTail, type ReadinessCache, type ReadinessEntry } from '../core/readiness.ts';
import { isEngineDegraded } from '../core/degraded-marker.ts';
import { disabledOpsForPublishGates } from './publish-gates.ts';
import type { InstructionTools } from './instructions.ts';

/** Readiness entries the instructions tail may name, most limiting first. */
const TAIL_PRIORITY = ['embeddings', 'chat_llm', 'migrations', 'worker', 'local_transcripts'] as const;

/** Config plane + probed tier (≤ 250 ms), ordered by TAIL_PRIORITY; [] on any failure. */
export async function instructionReadiness(
  engine: BrainEngine, config: GBrainConfig | null | undefined, transport: 'stdio' | 'http', cache?: ReadinessCache,
): Promise<ReadinessEntry[]> {
  if (!config) return [];
  try {
    const entries = [...configReadiness(config, { transport }).entries];
    if (!isEngineDegraded(engine)) entries.push(...(await readinessTail(engine, cache ? { cache } : {}) ?? []));
    const ranked = TAIL_PRIORITY.flatMap(cap => entries.filter(e => e.capability === cap));
    return transport === 'http' ? readinessHttpView(ranked) : ranked;
  } catch {
    return [];
  }
}

/** HTTP (OAuth and legacy bearer): the same filters tools/list applies, publish gates read on initialize. */
export async function httpInstructionTools(
  engine: BrainEngine, config: GBrainConfig | null | undefined,
  opts: { ops: readonly Operation[]; surface: 'verbs' | 'starter' | 'full'; auth: AuthInfo; allowedOps?: ReadonlySet<string>; cache?: ReadinessCache },
): Promise<InstructionTools> {
  const gateDisabled = await disabledOpsForPublishGates(engine, config ?? undefined).catch(() => new Set(opts.ops.map(o => o.name)));
  const publishGates = publishGatesFromDisabled(opts.ops, gateDisabled);
  const names = new Set(opts.ops.filter(op =>
    isCallable(op, { transport: 'http', surface: opts.surface, scopes: opts.auth.scopes, publishGates, allowedOps: opts.allowedOps })
    && opAllowedForBoundClient(opts.auth, op)).map(op => op.name));
  return { callable: n => names.has(n), readiness: await instructionReadiness(engine, config, 'http', opts.cache) };
}

/**
 * F2: `gbrain://capabilities` on stdio — every readiness entry (config plane +
 * probed tier, 60 s cache) and the real worker status from the worker probe
 * (it replaces the old constant `unknown`).
 */
export async function stdioCapabilityReadiness(engine: BrainEngine, config: GBrainConfig | null | undefined): Promise<{
  readiness: ReadinessEntry[]; worker: { status: string; reason?: string; why?: string };
}> {
  if (!config) return { readiness: [], worker: { status: 'unknown', reason: 'not_configured' } };
  const readiness = [...configReadiness(config, { transport: 'stdio' }).entries];
  try {
    if (!isEngineDegraded(engine)) readiness.push(...await probedReadiness(engine));
  } catch { /* the probed tier is best-effort */ }
  const w = readiness.find(e => e.capability === 'worker');
  return { readiness, worker: w ? { status: w.state, reason: w.reason, why: w.why } : { status: 'unknown', reason: isEngineDegraded(engine) ? 'engine_unreachable' : 'probe_failed' } };
}
