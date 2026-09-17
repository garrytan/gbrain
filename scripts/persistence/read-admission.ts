import assert from 'node:assert/strict';
import type { BrainEngine } from '../../src/core/engine.ts';

/** Record every phase identically; discard only completed warmup observations. */
export class WriteTimingRecorder {
  readonly admissionMs: number[] = [];
  readonly completionMs: number[] = [];
  readonly intervals: [number, number][] = [];
  private readonly starts = new Map<string, number>();
  private readonly admissions = new Map<string, number>();
  private readonly completions = new Set<string>();

  start(requestId: string, at: number): void {
    assert(!this.starts.has(requestId), 'workload writes require distinct request IDs');
    this.starts.set(requestId, at);
  }
  admitted(requestId: string, at: number): void {
    const started = this.starts.get(requestId);
    if (started === undefined || this.admissions.has(requestId)) return;
    assert(at >= started, 'durable admission cannot precede public invocation');
    this.admissions.set(requestId, at); this.admissionMs.push(at - started);
  }
  complete(requestId: string, at: number): void {
    const started = this.starts.get(requestId); const admitted = this.admissions.get(requestId);
    assert(started !== undefined && admitted !== undefined && admitted >= started && admitted <= at,
      'a completed public write must have an earlier observed durable admission');
    assert(!this.completions.has(requestId), 'a terminal receipt may be counted only once');
    this.completions.add(requestId); this.intervals.push([started, at]); this.completionMs.push(at - started);
  }
  reset(): void {
    assert(this.starts.size === this.completions.size, 'cannot discard an unfinished warmup write');
    this.starts.clear(); this.admissions.clear(); this.completions.clear();
    this.admissionMs.length = 0; this.completionMs.length = 0; this.intervals.length = 0;
  }
}

/**
 * Observe the resolved top-level transaction used by journal admission. A
 * transaction callback or nested savepoint can still roll back, so neither
 * constitutes durable admission. Keep this wrapper in the harness: the public
 * mutation handler and its transaction implementation remain unchanged.
 */
export function observeAdmissionTransactions(engine: BrainEngine,
  observed: (requestId: string, completedAt: number) => void): BrainEngine {
  const original = engine.transaction;
  let wrapped: BrainEngine;
  async function transaction<T>(this: BrainEngine, run: (tx: BrainEngine) => Promise<T>): Promise<T> {
    const result = await original.call(this, run) as T;
    if (this === wrapped && result && typeof result === 'object') {
      const row = result as Record<string, unknown>;
      if (row.state === 'queued' && typeof row.request_id === 'string') observed(row.request_id, performance.now());
    }
    return result;
  }
  // Route warmup and pressure calls through one stable observer without
  // replacing engine methods. Transaction clones keep their own receiver
  // and scoped connection; only the original wrapper may emit an observation.
  wrapped = new Proxy(engine, { get(target, property, receiver) {
    return property === 'transaction' ? transaction : Reflect.get(target, property, receiver);
  } });
  return wrapped;
}
