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
  private readonly indices = new Map<string, number>();
  private nextIndex = 0;

  constructor(private readonly observe?: (event: 'start' | 'admitted' | 'committed', index: number, at: number) => void) {}

  start(requestId: string, at: number): void {
    assert(!this.starts.has(requestId), 'workload writes require distinct request IDs');
    this.starts.set(requestId, at);
    this.indices.set(requestId, this.nextIndex++);
    this.observe?.('start', this.indices.get(requestId)!, at);
  }
  admitted(requestId: string, at: number): void {
    const started = this.starts.get(requestId);
    if (started === undefined || this.admissions.has(requestId)) return;
    assert(at >= started, 'durable admission cannot precede public invocation');
    this.admissions.set(requestId, at); this.admissionMs.push(at - started);
    this.observe?.('admitted', this.indices.get(requestId)!, at);
  }
  complete(requestId: string, at: number): void {
    const started = this.starts.get(requestId); const admitted = this.admissions.get(requestId);
    assert(started !== undefined && admitted !== undefined && admitted >= started && admitted <= at,
      'a completed public write must have an earlier observed durable admission');
    assert(!this.completions.has(requestId), 'a terminal receipt may be counted only once');
    this.completions.add(requestId); this.intervals.push([started, at]); this.completionMs.push(at - started);
    this.observe?.('committed', this.indices.get(requestId)!, at);
  }
  reset(): void {
    assert(this.starts.size === this.completions.size, 'cannot discard an unfinished warmup write');
    this.starts.clear(); this.admissions.clear(); this.completions.clear();
    this.indices.clear();
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
  const observe = (result: unknown) => {
    if (!result || typeof result !== 'object') return;
    const row = result as Record<string, unknown>;
    if (row.state === 'queued' && typeof row.request_id === 'string') observed(row.request_id, performance.now());
  };
  async function transaction<T>(this: BrainEngine, run: (tx: BrainEngine) => Promise<T>): Promise<T> {
    const result = await original.call(this, run) as T;
    if (this === wrapped) observe(result);
    return result;
  }
  // A single write's admission may run on the persistence consumer's reserved
  // connection (its warm single-write lane) instead of `engine.transaction`;
  // that connection's resolved top-level transactions are observed the same way.
  const reserve = engine.withReservedConnection;
  const reservedConnections = new WeakMap<object, object>();
  async function withReservedConnection<T>(this: BrainEngine, fn: (conn: any) => Promise<T>, opts?: unknown): Promise<T> {
    return reserve.call<BrainEngine, [(conn: any) => Promise<T>, never], Promise<T>>(this, (conn: any) => {
      let observedConn = reservedConnections.get(conn);
      if (!observedConn) {
        observedConn = typeof conn?.transaction !== 'function' ? conn : new Proxy(conn, { get(target, property, receiver) {
          if (property !== 'transaction') return Reflect.get(target, property, receiver);
          return async (run: (tx: BrainEngine) => Promise<unknown>) => { const result = await target.transaction(run); observe(result); return result; };
        } });
        reservedConnections.set(conn, observedConn!);
      }
      return fn(observedConn);
    }, opts as never);
  }
  // Route warmup and pressure calls through one stable observer without
  // replacing engine methods. Transaction clones keep their own receiver
  // and scoped connection; only the original wrapper may emit an observation.
  wrapped = new Proxy(engine, { get(target, property, receiver) {
    if (property === 'transaction') return transaction;
    if (property === 'withReservedConnection' && typeof reserve === 'function') return withReservedConnection;
    return Reflect.get(target, property, receiver);
  } });
  return wrapped;
}
