import type { PGlite, Transaction } from '@electric-sql/pglite';
import type postgres from 'postgres';

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
