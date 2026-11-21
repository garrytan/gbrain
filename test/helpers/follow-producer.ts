/** Test harness for the shadow follow producer: a wrapped engine whose invalidation batches land in an array. */
import type { BrainEngine } from '../../src/core/engine.ts';
import { newMirrorCounters } from '../../src/shadow/mirror.ts';
import type { InvalidationBatch } from '../../src/shadow/invalidations.ts';
import { wrapShadowEngine, type ShadowSink } from '../../src/shadow/wrapper.ts';

export interface FollowHarness<E extends BrainEngine> {
  engine: E;
  batches: InvalidationBatch[];
  /** The pre-read queries the producer ran on the primary (internal engine SQL is not counted). */
  rawCalls: string[];
  setShadowActive(on: boolean): void;
}

const PRE_READ_MARK = '/* shadow-follow pre-read */';
const restorers: Array<() => void> = [];
/** Undoes every probe the harness installed; call from beforeEach. */
export function restoreFollowProbes(): void { for (const undo of restorers.splice(0).reverse()) undo(); }

/** Wraps `primary` with follow on. `failRawWith` makes every pre-read query throw. */
export function followHarness<E extends BrainEngine>(primary: E, opts: { failRawWith?: Error; publish?: (batch: InvalidationBatch) => void } = {}): FollowHarness<E> {
  const batches: InvalidationBatch[] = [];
  const rawCalls: string[] = [];
  let active = true;
  // Count (or fail) executeRaw on the primary itself; a Proxy or Object.create copy of a PGLite engine hangs its page lock.
  const original = primary.executeRaw;
  (primary as { executeRaw: unknown }).executeRaw = function (this: unknown, sql: string, ...rest: unknown[]) {
    if (!sql.startsWith(PRE_READ_MARK)) return (original as (...a: unknown[]) => Promise<unknown>).call(this, sql, ...rest);
    rawCalls.push(sql);
    if (opts.failRawWith) return Promise.reject(opts.failRawWith);
    return (original as (...a: unknown[]) => Promise<unknown>).call(this, sql, ...rest);
  };
  restorers.push(() => { (primary as { executeRaw: unknown }).executeRaw = original; });
  const sink: ShadowSink = { counters: newMirrorCounters(), offer: () => {}, active: () => active };
  const engine = wrapShadowEngine(primary, sink, {
    sampleRate: 0,
    follow: { sink: { publish: opts.publish ?? ((batch) => { batches.push(batch); }) } },
  });
  return { engine, batches, rawCalls, setShadowActive: (on) => { active = on; } };
}

export const PAGE = (title: string) => ({ type: 'person' as const, title, compiled_truth: `${title} body.`, timeline: '' });
