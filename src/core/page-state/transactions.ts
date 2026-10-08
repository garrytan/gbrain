import type { PGlite, Transaction } from '@electric-sql/pglite';
import type postgres from '#postgres'

/** Sibling savepoints must finish in order; children receive a separate queue. */
function serial<T>() {
  let tail: Promise<unknown> = Promise.resolve();
  return (run: () => Promise<T>): Promise<T> => {
    const result = tail.then(run);
    tail = result.catch(() => undefined);
    return result;
  };
}

/** Restore the root handle's transaction API on a scoped postgres.js handle. */
export function composablePostgresTransaction(handle: unknown): ReturnType<typeof postgres> {
  const tx = handle as ReturnType<typeof postgres> & { savepoint: (fn: (child: unknown) => Promise<unknown>) => Promise<unknown> };
  const run = serial<unknown>();
  return new Proxy(tx, {
    get(target, key, receiver) {
      if (key === 'begin') return (fn: (child: ReturnType<typeof postgres>) => Promise<unknown>) =>
        run(() => tx.savepoint(child => fn(composablePostgresTransaction(child))));
      return Reflect.get(target, key, receiver);
    },
  });
}

/** PGLite's Transaction omits transaction(); emulate it with real savepoints. */
export function composablePgliteTransaction(handle: Transaction, state = { next: 0 }): PGlite {
  const run = serial<unknown>();
  return new Proxy(handle, {
    get(target, key) {
      if (key === 'transaction') return (fn: (child: PGlite) => Promise<unknown>) => run(async () => {
        const name = `gbrain_nested_${++state.next}`;
        await target.exec(`SAVEPOINT ${name}`);
        try {
          const result = await fn(composablePgliteTransaction(target, state));
          await target.exec(`RELEASE SAVEPOINT ${name}`);
          return result;
        } catch (error) {
          await target.exec(`ROLLBACK TO SAVEPOINT ${name}`);
          await target.exec(`RELEASE SAVEPOINT ${name}`);
          throw error;
        }
      });
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as PGlite;
}

const memos = new WeakMap<object, Map<string, Promise<unknown>>>();
/**
 * #5984: a read every statement of one page transaction may share (the
 * embedding config rows, the local writer, source membership). The first key
 * stores the read; later keys are entries that also satisfy it (a `FOR SHARE`
 * read satisfies a plain one). Outside a page transaction the read runs every
 * time. A rejected read is not kept.
 */
export function transactionMemo<T>(tx: object, keys: string | readonly string[], read: () => Promise<T>): Promise<T> {
  if ((tx as { _pageTransaction?: boolean })._pageTransaction !== true) return read();
  const [key, ...alternatives] = typeof keys === 'string' ? [keys] : keys;
  let byKey = memos.get(tx);
  if (!byKey) { byKey = new Map(); memos.set(tx, byKey); }
  const hit = [key!, ...alternatives].map(k => byKey!.get(k)).find(Boolean);
  if (hit) return hit as Promise<T>;
  const stored = read();
  byKey.set(key!, stored);
  stored.catch(() => byKey!.delete(key!));
  return stored;
}

/**
 * #5984: issues one transaction's statements back to back without awaiting
 * between them, so postgres.js pipelines those already prepared on the
 * transaction's connection (docs/eval/managed-sync-catchup.md, "Pipelining
 * spike": order kept, later statements of a failed pipeline fail with 25P02).
 * A call that awaits between statements sends its later ones after the other
 * calls' first. The first failure in call order that is not a 25P02 abort is
 * thrown (the 25P02 itself when that is all there is). PGLite runs the calls one at a time.
 */
export async function pipelined(engine: object, calls: ReadonlyArray<() => Promise<unknown>>): Promise<unknown[]> {
  if ((engine as { kind?: unknown }).kind !== 'postgres') {
    const results: unknown[] = [];
    for (const call of calls) results.push(await call());
    return results;
  }
  const settled = await Promise.allSettled(calls.map(call => { try { return call(); } catch (error) { return Promise.reject(error); } }));
  const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
  // A statement sent after the one that failed reports 25P02 (transaction aborted); the cause is the other one.
  const failed = rejected.find(s => (s.reason as { code?: unknown } | null)?.code !== '25P02') ?? rejected[0];
  if (failed) throw failed.reason;
  return settled.map(s => (s as PromiseFulfilledResult<unknown>).value);
}
