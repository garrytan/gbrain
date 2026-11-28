/**
 * Makes chosen transactions run their callback twice, the first run thrown away (design interface I-1: the multi-user Rust
 * engine runs a transaction callback again from a fresh snapshot after a commit lost on write_conflict).
 *
 * The case marks a run with `hit(tx)` (from a spy on a function the callback calls with its tx), or names tx `members` whose
 * call marks it; a run that was marked is
 * forced once. On a multi-user Rust brain the forced run ends with a write_conflict error, so the engine's own optimistic
 * retry runs the callback again. Every other arm has no optimistic retry, so the wrapper runs the callback once in a
 * transaction it rolls back and then once for real: the same two runs from a fresh state. Each forced transaction call is
 * forced once; `limit` caps how many calls are forced in all.
 *
 * Each run gets its own Proxy of the tx, so a spy can tell runs apart (`hit` reads the run off the tx the callback passed on, through any proxy an engine wraps it in);
 * a savepoint the callback opens on that tx hands its own tx out watched for the same run.
 * The engine's transaction member is replaced for the case and restored after (an own member is put back, an inherited one
 * is uncovered); the replacement is called with the engine as `this` and calls the member it covered.
 */
import type { BrainEngine } from '../../src/core/engine.ts';

export const FORCED_RERUN = 'forced second run of a transaction callback';
/** The run a watched tx belongs to. A symbol read, not object identity: an engine may hand the callback its own proxy of the tx. */
const RUN = Symbol('forced-rerun run');

export interface ForcedRerun {
  /** Marks the run whose callback got `tx` as one to force. A tx no run of this wrapper handed out is ignored. */
  hit(tx: unknown): void;
  /** Transaction calls forced so far, and whether the engine took the multi-user retry path. */
  readonly seen: { forced: number; multiuser: boolean };
  restore(): void;
}

/**
 * `members`: tx members whose call marks the run by itself (no spy needed). `conflictAt`: tx members whose call, in a
 * transaction call not forced yet, throws the forced error in place of running: a read that met a key another transaction
 * holds, which on the multi-user Rust engine stops the run at once with write_conflict (occ_kv.rs, the retry-key row locks).
 */
export function forceRerunOnHit(engine: BrainEngine, opts: { limit?: number; members?: readonly string[]; conflictAt?: readonly string[] } = {}): ForcedRerun {
  const members = new Set(opts.members ?? []);
  const conflictAt = new Set(opts.conflictAt ?? []);
  const fail = () => seen.multiuser ? Object.assign(new Error(FORCED_RERUN), { code: 'write_conflict' }) : new Error(FORCED_RERUN);
  type Run = { hit: boolean; call: { forced: boolean } };
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  const seen = { forced: 0, multiuser: (engine as { multiuser?: boolean }).multiuser === true };
  let holder: object | null = engine;
  let found: PropertyDescriptor | undefined;
  while (holder && !(found = Object.getOwnPropertyDescriptor(holder, 'transaction'))) holder = Object.getPrototypeOf(holder);
  const original = found!.value as (...args: unknown[]) => Promise<unknown>;
  // A nested transaction (a savepoint) the callback opens on its tx belongs to the same run: its tx is watched with the run's state.
  const watch = (tx: BrainEngine, state: Run): BrainEngine => {
    const watched = new Proxy(tx, {
      get(target, prop, receiver) {
        if (prop === RUN) return state;
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        if (prop === 'transaction') return (fn: (inner: BrainEngine) => Promise<unknown>, ...rest: unknown[]) => value.call(target, (inner: BrainEngine) => fn(watch(inner, state)), ...rest);
        if (typeof prop === 'string' && conflictAt.has(prop) && !state.call.forced && seen.forced < limit) return () => {
          seen.forced++;
          state.call.forced = true;
          return Promise.reject(fail());
        };
        if (typeof prop === 'string' && members.has(prop)) return (...args: unknown[]) => { state.hit = true; return value.apply(target, args); };
        return value.bind(target);
      },
    });
    return watched;
  };
  const run = async <T>(fn: (tx: BrainEngine) => Promise<T>, tx: BrainEngine, call: Run['call']): Promise<{ value: T; hit: boolean }> => {
    const state: Run = { hit: false, call };
    return { value: await fn(watch(tx, state)), hit: state.hit };
  };
  const transaction = async function (this: unknown, fn: (tx: BrainEngine) => Promise<unknown>, ...rest: unknown[]) {
    const call = (cb: (tx: BrainEngine) => Promise<unknown>) => original.call(this, cb, ...rest);
    const here = { forced: false };
    const once = async (tx: BrainEngine) => {
      const { value, hit } = await run(fn, tx, here);
      if (hit && !here.forced && seen.forced < limit) {
        seen.forced++;
        here.forced = true;
        throw fail();
      }
      return value;
    };
    if (seen.multiuser) return call(once);
    try { return await call(once); }
    catch (error) { if (!here.forced || (error as Error)?.message !== FORCED_RERUN) throw error; return call(async tx => (await run(fn, tx, here)).value); }
  };
  const own = Object.getOwnPropertyDescriptor(engine, 'transaction');
  Object.defineProperty(engine, 'transaction', { value: transaction, configurable: true, writable: true });
  return {
    hit(tx: unknown) { const state = tx && typeof tx === 'object' ? (tx as { [RUN]?: Run })[RUN] : undefined; if (state) state.hit = true; },
    seen,
    restore() { if (own) Object.defineProperty(engine, 'transaction', own); else delete (engine as { transaction?: unknown }).transaction; },
  };
}
