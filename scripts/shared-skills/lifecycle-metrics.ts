import assert from 'node:assert/strict';
import type { BrainEngine } from '../../src/core/engine.ts';
import { WriteTimingRecorder } from '../persistence/read-admission.ts';
import { overlapPercent, summarizeReadRuns } from '../persistence/read-metrics.ts';

export interface Distribution { count: number; p50_ms: number; p95_ms: number; p99_ms: number; max_ms: number; }
export function distribution(values: number[]): Distribution {
  const sorted = values.toSorted((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  return { count: sorted.length, p50_ms: percentile(0.5), p95_ms: percentile(0.95), p99_ms: percentile(0.99), max_ms: sorted.at(-1) ?? 0 };
}
export interface PhaseCounters {
  engine_api_calls: Record<string, number>;
  tool_calls: Record<string, number>;
  result_bytes_by_operation: Record<string, number>;
  argument_bytes_by_operation: Record<string, number>;
  tool_result_json_bytes: number;
  decoded_asset_bytes: number;
  errors: number;
  pending_receipts: number;
}
export class LifecycleMeter {
  phase = 'fixture';
  readonly phases: Record<string, PhaseCounters> = {};
  readonly timings = new WriteTimingRecorder();
  readonly durableCommits = new Map<string, number>();
  readonly recovery: Array<{ request_id: string; bytes: number; at: number }> = [];
  readonly admissionIntentBytes: number[] = [];
  private readonly tracked = new Set<string>();
  private readonly rowIds = new Map<string, string>();
  counters(): PhaseCounters {
    return this.phases[this.phase] ??= { engine_api_calls: {}, tool_calls: {}, result_bytes_by_operation: {}, argument_bytes_by_operation: {},
      tool_result_json_bytes: 0, decoded_asset_bytes: 0, errors: 0, pending_receipts: 0 };
  }
  startWrite(id: string): void { this.tracked.add(id); this.timings.start(id, performance.now()); }
  finishWrite(id: string): void { this.timings.complete(id, performance.now()); }
  resetWrites(): void {
    this.timings.reset(); this.tracked.clear(); this.rowIds.clear(); this.durableCommits.clear();
    this.recovery.length = 0; this.admissionIntentBytes.length = 0;
  }
  observe(engine: BrainEngine): BrainEngine {
    const meter = this;
    type Events = Array<{ rowId: string; bytes: number }>;
    const wrap = (target: BrainEngine, depth: number, events: Events): BrainEngine => {
      let proxy: BrainEngine;
      proxy = new Proxy(target, { get(object, property, receiver) {
        const original = Reflect.get(object, property, receiver);
        if (['transaction', 'transactionDirect'].includes(String(property))) {
          return async function<T>(this: BrainEngine, run: (tx: BrainEngine) => Promise<T>): Promise<T> {
            const counts = meter.counters().engine_api_calls;
            counts[String(property)] = (counts[String(property)] ?? 0) + 1;
            const transactionEvents: Events = [];
            const result = await original.call(this, (tx: BrainEngine) => run(wrap(tx, depth + 1, transactionEvents))) as T;
            if (depth > 0) events.push(...transactionEvents);
            else {
              const at = performance.now();
              for (const event of transactionEvents) {
                const requestId = meter.rowIds.get(event.rowId);
                if (requestId) meter.recovery.push({ request_id: requestId, bytes: event.bytes, at });
              }
              const row = result as Record<string, unknown> | null;
              if (row && typeof row.request_id === 'string' && typeof row.principal_kind === 'string' && meter.tracked.has(row.request_id)) {
                if (row.state === 'queued' && typeof row.id === 'string') {
                  meter.rowIds.set(row.id, row.request_id);
                  meter.timings.admitted(row.request_id, at);
                  meter.admissionIntentBytes.push(Number(row.intent_bytes));
                }
                if (row.state === 'committed' && !meter.durableCommits.has(row.request_id)) meter.durableCommits.set(row.request_id, at);
              }
            }
            return result;
          };
        }
        if (property === 'executeRaw' || property === 'getConfig') {
          return async function(this: BrainEngine, ...args: unknown[]) {
            const counts = meter.counters().engine_api_calls;
            counts[String(property)] = (counts[String(property)] ?? 0) + 1;
            const result = await original.apply(this, args);
            if (property === 'executeRaw' && depth > 0 && typeof args[0] === 'string' &&
              args[0].startsWith('UPDATE persistence_requests SET recovery=$3::text::jsonb,recovery_bytes=$4')) {
              const values = args[1] as unknown[];
              events.push({ rowId: String(values[0]), bytes: Number(values[3]) });
            }
            return result;
          };
        }
        return original;
      } });
      return proxy;
    };
    return wrap(engine, 0, []);
  }
}

export function sharedReadGateSample(input: { idle: number[]; loaded: number[]; started: number; ended: number;
  writes: WriteTimingRecorder; durableCommits: number[]; failures: number; correctness: boolean }) {
  const intervals = input.writes.intervals;
  return { ok: input.correctness && input.failures === 0, phase_a: { ...distribution(input.idle), queries_run: input.idle.length },
    phase_b: { ...distribution(input.loaded), queries_run: input.loaded.length, writes_completed: intervals.length,
      writes_committed_during_reads: input.durableCommits.filter(at => at >= input.started && at <= input.ended).length, writes_failed: input.failures },
    overlap_pct: overlapPercent(input.started, input.ended, intervals), admission: distribution(input.writes.admissionMs), commit: distribution(input.writes.completionMs) };
}

export function summarizeLifecycleReadGate(runs: ReturnType<typeof sharedReadGateSample>[]) {
  return summarizeReadRuns(runs, 50);
}

export function validateOptions(options: { sizes: number[]; members: number; queries: number; runs: number; maxWrites: number; assetBytes: number }) {
  assert(options.sizes.length > 0 && options.sizes.length <= 3 && options.sizes.every(size => Number.isSafeInteger(size) && size >= 2 && size <= 1000), 'sizes must contain one to three integers from2 to1000');
  assert(new Set(options.sizes).size === options.sizes.length, 'sizes must be distinct');
  for (const [name, value, maximum] of [['members', options.members, 8], ['queries', options.queries, 1000], ['runs', options.runs, 3], ['maxWrites', options.maxWrites, 256], ['assetBytes', options.assetBytes, 65536]] as const) {
    assert(Number.isSafeInteger(value) && value > 0 && value <= maximum, `${name} must be an integer from1 to${maximum}`);
  }
  assert(options.queries >= options.members, 'each concurrent member must receive at least one read sample');
}
