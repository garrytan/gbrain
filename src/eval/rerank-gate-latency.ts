/**
 * W3 gate 4 (A66/A67): the paired latency runner for `search.reranker.gate`.
 *
 * Every item runs the whole read path (the `recall` op, then the `query` op,
 * in-process as a trusted local caller) once with the gate `off` and once
 * with it `on`, against the same brain. The arms differ only in an in-memory
 * config overlay (`withSearchConfig`), so nothing is written to the brain and
 * both arms can run side by side.
 *
 * Controls: a warm-up pass (both arms, untimed) before any timed call;
 * counterbalanced arm order (`pairedSchedule`: the first arm alternates by
 * item and by repeat); a fixed number of workers, each running one pair's two
 * arms back to back; and timing that starts after a worker holds its slot,
 * so queueing never counts. `retrieve_ms` from the harness is not used.
 *
 * Verdict (`summarizeLatency`, A67): a mean saving of at least 100 ms per
 * skipped query (paired off − on over the pairs whose `on` arm skipped) and
 * no p95 increase over all queries. The reranker-call reduction (gate 4's
 * 25% clause) is derived from the `on` arm's own meta: every eligible search
 * calls the reranker under `off`, and `provider_called` says whether `on` did.
 */
import type { BrainEngine } from '../core/engine.ts';
import type { OperationContext } from '../core/operations.ts';
import { operationsByName } from '../core/operations.ts';

export type GateArm = 'off' | 'on';

/** One question: params passed verbatim to `recall` (optional) and `query`. */
export interface LatencyItem {
  id: string;
  kind?: string;
  recall?: Record<string, unknown>;
  query: Record<string, unknown>;
}

/** What one arm of one item observed. */
export interface ArmObservation {
  recall_ms: number;
  query_ms: number;
  /** Searches the gate graded as eligible (the reranker would run under `off`). */
  eligible: number;
  /** Searches whose reranker provider was called. */
  provider_calls: number;
  /** Searches the gate skipped. */
  skipped: number;
}

export interface ArmSample extends ArmObservation {
  id: string;
  kind?: string;
  arm: GateArm;
  repeat: number;
  /** 0 when this arm ran first in its pair. */
  position: 0 | 1;
  ms: number;
  error?: string;
}

export interface PairedRunOpts {
  warmup: number;
  repeats: number;
  concurrency: number;
  now?: () => number;
}

export type ArmCaller = (arm: GateArm, item: LatencyItem, now: () => number) => Promise<ArmObservation>;

/** Pairs in run order; the first arm alternates by item and by repeat. */
export function pairedSchedule(items: readonly LatencyItem[], repeats: number): Array<{ item: LatencyItem; repeat: number; arms: [GateArm, GateArm] }> {
  const out: Array<{ item: LatencyItem; repeat: number; arms: [GateArm, GateArm] }> = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    items.forEach((item, i) => {
      out.push({ item, repeat, arms: (i + repeat) % 2 === 0 ? ['off', 'on'] : ['on', 'off'] });
    });
  }
  return out;
}

/** Warm up, then run every pair on `concurrency` workers; returns timed samples only. */
export async function runPaired(items: readonly LatencyItem[], call: ArmCaller, opts: PairedRunOpts): Promise<ArmSample[]> {
  const now = opts.now ?? (() => performance.now());
  for (const item of items.slice(0, Math.max(0, opts.warmup))) {
    for (const arm of ['off', 'on'] as const) await call(arm, item, now).catch(() => undefined);
  }
  const queue = pairedSchedule(items, Math.max(1, opts.repeats));
  const samples: ArmSample[] = [];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      for (const [position, arm] of next.arms.entries()) {
        const base = { id: next.item.id, ...(next.item.kind ? { kind: next.item.kind } : {}), arm, repeat: next.repeat, position: position as 0 | 1 };
        try {
          const o = await call(arm, next.item, now);
          samples.push({ ...base, ...o, ms: o.recall_ms + o.query_ms });
        } catch (err) {
          samples.push({ ...base, recall_ms: 0, query_ms: 0, eligible: 0, provider_calls: 0, skipped: 0, ms: 0, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
  return samples;
}

/** Nearest-rank percentile. */
export function percentile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
}

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (x: number) => Math.round(x * 10) / 10;

export const MIN_MEAN_SAVING_MS = 100;
export const MIN_RERANKER_CALL_REDUCTION = 0.25;

export interface LatencyReport {
  pairs: number;
  errors: number;
  arms: Record<GateArm, { n: number; mean_ms: number; p50_ms: number; p95_ms: number }>;
  skipped_pairs: number;
  skip_rate: number;
  /** Mean paired off − on over the pairs whose `on` arm skipped (null with no skip). */
  mean_saving_per_skip_ms: number | null;
  /** Mean paired off − on over the pairs whose `on` arm reranked (the gate's overhead when negative). */
  mean_saving_no_skip_ms: number | null;
  p95_increase_ms: number;
  reranker_calls: { off: number; on: number; reduction: number };
  by_kind: Record<string, { pairs: number; skipped: number; mean_saving_per_skip_ms: number | null }>;
  verdict: {
    mean_saving_ok: boolean;
    p95_ok: boolean;
    reranker_call_reduction_ok: boolean;
    /** Gate 4's latency clause (A67): both of the above latency checks and no errored arm. */
    latency_pass: boolean;
  };
}

export function summarizeLatency(samples: readonly ArmSample[]): LatencyReport {
  const ok = samples.filter((s) => !s.error);
  const byPair = new Map<string, Partial<Record<GateArm, ArmSample>>>();
  for (const s of ok) {
    const key = `${s.id}\u0000${s.repeat}`;
    byPair.set(key, { ...byPair.get(key), [s.arm]: s });
  }
  const pairs = [...byPair.values()].filter((p): p is Record<GateArm, ArmSample> => !!p.off && !!p.on);
  const skipped = pairs.filter((p) => p.on.skipped > 0);
  const reranked = pairs.filter((p) => p.on.skipped === 0);
  const saving = (ps: typeof pairs) => (ps.length ? round(mean(ps.map((p) => p.off.ms - p.on.ms))) : null);
  const arm = (a: GateArm) => {
    const ms = pairs.map((p) => p[a].ms);
    return { n: ms.length, mean_ms: round(mean(ms)), p50_ms: round(percentile(ms, 0.5)), p95_ms: round(percentile(ms, 0.95)) };
  };
  const arms = { off: arm('off'), on: arm('on') };
  const callsOff = pairs.reduce((n, p) => n + p.on.eligible, 0);
  const callsOn = pairs.reduce((n, p) => n + p.on.provider_calls, 0);
  const reduction = callsOff > 0 ? 1 - callsOn / callsOff : 0;
  const by_kind: LatencyReport['by_kind'] = {};
  for (const kind of new Set(pairs.map((p) => p.on.kind ?? 'unknown'))) {
    const ps = pairs.filter((p) => (p.on.kind ?? 'unknown') === kind);
    const sk = ps.filter((p) => p.on.skipped > 0);
    by_kind[kind] = { pairs: ps.length, skipped: sk.length, mean_saving_per_skip_ms: saving(sk) };
  }
  const meanSaving = saving(skipped);
  const p95Increase = round(arms.on.p95_ms - arms.off.p95_ms);
  const errors = samples.length - ok.length;
  const mean_saving_ok = meanSaving !== null && meanSaving >= MIN_MEAN_SAVING_MS;
  const p95_ok = pairs.length > 0 && p95Increase <= 0;
  return {
    pairs: pairs.length,
    errors,
    arms,
    skipped_pairs: skipped.length,
    skip_rate: pairs.length ? skipped.length / pairs.length : 0,
    mean_saving_per_skip_ms: meanSaving,
    mean_saving_no_skip_ms: saving(reranked),
    p95_increase_ms: p95Increase,
    reranker_calls: { off: callsOff, on: callsOn, reduction },
    by_kind,
    verdict: {
      mean_saving_ok,
      p95_ok,
      reranker_call_reduction_ok: reduction >= MIN_RERANKER_CALL_REDUCTION,
      latency_pass: mean_saving_ok && p95_ok && errors === 0,
    },
  };
}

/** The brain as one arm sees it: `search.*` keys answered from `overlay` first. Writes nothing. */
export function withSearchConfig(engine: BrainEngine, overlay: Record<string, string>): BrainEngine {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      if (prop === 'getConfig') {
        return async (key: string) => (key in overlay ? overlay[key] : target.getConfig(key));
      }
      if (prop === 'getAllConfig') {
        return async () => ({ ...(await target.getAllConfig()), ...overlay });
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * The real caller: `recall` then `query` through the operation handlers with
 * the arm's gate overlaid, reading the gate's meta from the retrieval meta
 * each search emits.
 */
export function operationArmCaller(base: OperationContext): ArmCaller {
  const engines: Record<GateArm, BrainEngine> = {
    off: withSearchConfig(base.engine, { 'search.reranker.gate': 'off' }),
    on: withSearchConfig(base.engine, { 'search.reranker.gate': 'on' }),
  };
  return async (arm, item, now) => {
    const metas: Array<{ rerank_gate?: { eligible?: boolean; provider_called?: boolean; skipped?: boolean } }> = [];
    const ctx: OperationContext = {
      ...base,
      engine: engines[arm],
      emitResponseMeta: (kind: string, meta: unknown) => { if (kind === 'retrieval' && meta && typeof meta === 'object') metas.push(meta as never); },
    } as OperationContext;
    let recall_ms = 0;
    if (item.recall) {
      const t0 = now();
      await operationsByName.recall!.handler(ctx, item.recall);
      recall_ms = now() - t0;
    }
    const t1 = now();
    await operationsByName.query!.handler(ctx, item.query);
    const query_ms = now() - t1;
    const gates = metas.map((m) => m.rerank_gate).filter((g) => g !== undefined);
    return {
      recall_ms,
      query_ms,
      eligible: gates.filter((g) => g.eligible).length,
      provider_calls: gates.filter((g) => g.provider_called).length,
      skipped: gates.filter((g) => g.skipped).length,
    };
  };
}
